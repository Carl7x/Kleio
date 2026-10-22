import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { RuntimeError } from '../../packages/runtime/contracts.ts';
import type { RuntimeHost } from '../../packages/runtime/host.ts';
import { BrowserSessions, mountWeb } from './web.ts';
import { DeviceSessions, localAddresses } from './devices.ts';
import { mountKleio } from './kleio.ts';
import { projectNotification } from './notification-projection.ts';
import { streamConversationChanges } from './conversation-stream.ts';

export function createRuntimeApp(host: RuntimeHost, shutdown: () => void): Hono {
  const app = new Hono(); const token = Buffer.from('Bearer ' + host.config.token);
  const sessions = new BrowserSessions(host.config.token, host.config.port);
  const devices = new DeviceSessions(host.store);
  const deviceAccess = host.config.listenHost === '0.0.0.0';
  app.use('*', bodyLimit({ maxSize: 128 * 1024 }));
  app.use('*', async (c, next) => {
    const url = new URL(c.req.url); const origin = c.req.header('origin');
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const allowedHosts = ['127.0.0.1', 'localhost', ...(deviceAccess ? localAddresses() : [])];
    let publicOrigin: string | undefined;
    try {
      if (process.env.KLEIO_PUBLIC_URL) {
        const pub = new URL(process.env.KLEIO_PUBLIC_URL);
        if (pub.hostname) allowedHosts.push(pub.hostname);
        publicOrigin = pub.origin;
      }
    } catch { /* ignore invalid KLEIO_PUBLIC_URL */ }
    // Hono app.request often omits the port; require a match only when the request carries one.
    const portOk = !url.port || Number(url.port) === host.config.port;
    const originOk = !origin || origin === url.origin || (!!publicOrigin && origin === publicOrigin);
    if (!allowedHosts.includes(url.hostname) || !portOk || !originOk || c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: 'Local origin required' }, 403);
    if (c.req.path === '/health' && c.req.method === 'GET') return c.json({ ok: true, product: 'Kleio' });
    if (c.req.method === 'GET' && (c.req.path === '/' || c.req.path.startsWith('/assets/') || c.req.path.startsWith('/_expo/static/') || ['/favicon.svg', '/favicon.ico', '/manifest.webmanifest'].includes(c.req.path))) { await next(); return; }
    if (c.req.method === 'POST' && c.req.path === '/api/devices/pair') {
      if (!deviceAccess) return c.json({ error: 'Run pnpm mobile to enable device connections.', code: 'device_access_disabled' }, 403);
      if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) return c.json({ error: 'JSON required' }, 415);
      const body = z.object({ code: z.string().min(1).max(32), name: z.string().trim().min(1).max(80).default('Phone'), client: z.enum(['native', 'browser']) }).parse(await c.req.json());
      if (!devices.consume(body.code)) return c.json({ error: 'Pairing code expired or incorrect. Generate another code on your computer.', code: 'invalid_pairing_code' }, 401);
      if (body.client === 'browser') {
        sessions.exchange(sessions.issue().ticket, c);
        return c.json({ ok: true });
      }
      return c.json(devices.create(body.name), 201);
    }
    if (c.req.method === 'POST' && c.req.path === '/api/session') {
      if (!c.req.header('content-type')?.toLowerCase().startsWith('application/json')) return c.json({ error: 'JSON required' }, 415);
      const body = z.object({ ticket: z.string().min(20).max(200) }).parse(await c.req.json());
      if (!sessions.exchange(body.ticket, c)) return c.json({ error: 'Launch link expired. Reopen with pnpm web.', code: 'authentication_required' }, 401);
      return c.json({ ok: true });
    }
    const received = Buffer.from(c.req.header('authorization') ?? '');
    const bearer = received.length === token.length && timingSafeEqual(received, token);
    const device = devices.authenticate(c.req.header('authorization'));
    const browser = sessions.authenticated(c);
    if ((!bearer && !browser && !device) || (['/api/session-tickets', '/api/shutdown'].includes(c.req.path) && !bearer)) return c.json({ error: 'Authentication required', code: 'authentication_required' }, 401);
    if (device && !bearer && !browser && (c.req.path === '/api/device-pairing' || c.req.path === '/api/devices' || /^\/api\/devices\//.test(c.req.path))) return c.json({ error: 'Manage devices from your computer.', code: 'forbidden' }, 403);
    if (!bearer && !['GET', 'HEAD'].includes(c.req.method) && !c.req.header('content-type')?.toLowerCase().startsWith('application/json')) return c.json({ error: 'JSON required' }, 415);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof RuntimeError) return c.json({ code: error.code, error: error.message }, error.status as 400 | 403 | 404 | 409 | 503);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ code: 'invalid_input', error: 'Invalid request' }, 400);
    if ('code' in error && typeof error.code === 'string' && !error.code.startsWith('SQLITE')) return c.json({ code: error.code, error: error.message }, 409);
    return c.json({ code: 'internal_error', error: 'Request failed; inspect persisted status before retrying.' }, 500);
  });
  app.post('/api/session-tickets', c => c.json(sessions.issue(), 201));
  app.delete('/api/session', c => { sessions.clear(c); return c.json({ ok: true }); });
  app.post('/api/device-pairing', c => {
    if (!deviceAccess) return c.json({ error: 'Run pnpm mobile to enable device connections.', code: 'device_access_disabled' }, 409);
    return c.json({ ...devices.issue(), addresses: localAddresses().map(address => `http://${address}:${host.config.port}`) }, 201);
  });
  app.get('/api/devices', c => c.json(devices.list()));
  app.delete('/api/devices/:id', c => { devices.revoke(c.req.param('id')); return c.json({ ok: true }); });
  app.delete('/api/device-session', c => { const device = devices.authenticate(c.req.header('authorization')); if (device) devices.revoke(device.id); return c.json({ ok: true }); });
  app.get('/api/status', c => c.json({ product: 'Kleio', mode: 'web', engine: host.engine.id, model: host.config.model.id, modelConfigured: !!host.config.model.apiKey,
    memory: { enabled: host.store.getSetting('memoryEnabled', true), ...host.memory.health(), watermarks: host.memory.watermarks() }, search: { provider: 'tavily', mode: host.config.search?.apiKey ? 'api-key' : 'keyless' }, deviceAccess, capabilities: ['conversation', 'memory', 'public-web-read', 'web-search', 'research', 'one-shot-research-delivery', 'periodic-follow-up', 'one-shot-reminder', 'interval-work', 'inbox'] }));
  app.get('/api/conversations', c => c.json(host.store.conversations()));
  app.post('/api/conversations', async c => {
    const body = z.object({ id: z.string().uuid().optional(), title: z.string().trim().min(1).max(120).optional() }).parse(await c.req.json());
    return c.json(host.store.createConversation(body.title, body.id), 201);
  });
  app.patch('/api/conversations/:id', async c => {
    const body = z.object({ title: z.string().trim().min(1).max(120).optional(), archived: z.boolean().optional() }).parse(await c.req.json());
    if (body.archived && host.store.conversation(c.req.param('id')).isMain) throw new RuntimeError('invalid_input', '主对话不能归档', 400);
    return c.json(host.store.updateConversation(c.req.param('id'), { ...(body.title !== undefined ? { title: body.title } : {}), ...(body.archived !== undefined ? { archived: body.archived } : {}) }));
  });
  app.get('/api/conversations/:id/messages', c => c.json(host.store.messages(c.req.param('id'))));
  app.get('/api/conversations/:id/stream', c => {
    const id = c.req.param('id'); host.store.conversation(id);
    const cursor = z.string().regex(/^\d+$/u).parse(c.req.header('last-event-id') ?? c.req.query('after') ?? '0');
    const after = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).parse(Number(cursor));
    return streamSSE(c, stream => streamConversationChanges(stream, host.store, id, after, c.req.raw.signal));
  });
  app.post('/api/conversations/:id/messages', async c => {
    const body = z.object({ text: z.string().trim().min(1).max(24000), requestId: z.string().min(1).max(200) }).parse(await c.req.json());
    return c.json(host.submit(c.req.param('id'), body.text, body.requestId), 202);
  });
  app.get('/api/executions', c => c.json(host.store.executions(undefined, c.req.query('conversationId'))));
  app.get('/api/executions/:id', c => c.json(host.store.execution(c.req.param('id'))));
  app.post('/api/executions/:id/cancel', c => { host.cancel(c.req.param('id')); return c.json({ ok: true }); });
  app.post('/api/executions/:id/retry', c => c.json(host.retryConversation(c.req.param('id'))));
  app.get('/api/events', c => c.json(host.store.events(z.coerce.number().int().min(0).parse(c.req.query('after') ?? 0), c.req.query('executionId'))));
  app.get('/api/executions/:id/stream', c => {
    const id = c.req.param('id'); host.store.execution(id);
    let after = z.coerce.number().int().min(0).parse(c.req.header('last-event-id') ?? c.req.query('after') ?? 0);
    return streamSSE(c, async stream => {
      while (!stream.aborted) {
        const events = host.store.events(after, id);
        for (const event of events) { await stream.writeSSE({ id: String(event.sequence), event: event.type, data: JSON.stringify(event) }); after = event.sequence; }
        if (events.length < 500 && !['queued', 'running'].includes(host.store.execution(id).status)) return;
        await delay(150);
      }
    });
  });
  app.get('/api/memory', c => c.json(c.req.query('q') ? host.memory.search(c.req.query('q')!) : host.memory.list()));
  app.get('/api/memory/:id/explain', c => c.json(host.memory.explain(c.req.param('id'))));
  app.get('/api/memory/:id/history', c => c.json(host.memory.history(c.req.param('id'))));
  app.patch('/api/memory/:id', async c => {
    const body = z.object({ text: z.string().min(1).max(4000), expectedVersion: z.number().int().positive() }).parse(await c.req.json());
    return c.json(host.correct(c.req.param('id'), { ...body, source: { label: '你的更正' } }));
  });
  app.delete('/api/memory/:id', async c => {
    const body = z.object({ expectedVersion: z.number().int().positive() }).parse(await c.req.json());
    return c.json(host.forget(c.req.param('id'), body));
  });
  app.get('/api/people', c => c.json(host.memory.people()));
  app.get('/api/work', c => c.json(host.work.list()));
  app.post('/api/work', async c => {
    const body = z.object({ requestId: z.string().min(1).max(200), title: z.string().min(1).max(120), prompt: z.string().min(1).max(12000), kind: z.enum(['research', 'reminder']), at: z.string().optional(), intervalMs: z.number().int().min(60000).optional(), schedule: z.object({ expression: z.string().trim().min(1).max(256), timeZone: z.string().trim().min(1).max(128).optional() }).optional(), conversationId: z.string().optional() }).parse(await c.req.json());
    const schedule = body.schedule ? { expression: body.schedule.expression, timeZone: body.schedule.timeZone || host.store.getSetting('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone) } : undefined;
    return c.json(host.createWork({ requestId: body.requestId, title: body.title, prompt: body.prompt, kind: body.kind,
      ...(body.at ? { at: body.at } : {}), ...(body.intervalMs !== undefined ? { intervalMs: body.intervalMs } : {}), ...(schedule ? { schedule } : {}), ...(body.conversationId ? { conversationId: body.conversationId } : {}) }), 201);
  });
  app.get('/api/work/:id', c => {
    const task = host.work.get(c.req.param('id')); const runs = host.work.runs(task.id);
    const research = task.kind === 'research' && task.intervalMs === null ? host.work.snapshot(task.id) : null;
    return c.json({ task, ...(research ? { research } : {}), runs: runs.map(run => ({ ...run, result: host.work.result(run.id), review: host.work.reviewResult(run.id) })) });
  });
  app.post('/api/work/:id/cancel', async c => {
    const body = z.object({ expectedVersion: z.number().int().positive().optional() }).parse(await c.req.json());
    return c.json(host.work.cancel(c.req.param('id'), body.expectedVersion));
  });
  app.get('/api/notifications', c => {
    const conversationId = c.req.query('conversationId');
    return c.json(host.work.notifications({ unreadOnly: c.req.query('unread') === 'true', ...(conversationId !== undefined ? { conversationId } : {}) }).map(item => projectNotification(item, text => host.memory.redactBlocked(text))));
  });
  app.post('/api/notifications/:id/read', c => c.json(projectNotification(host.work.readNotification(c.req.param('id')), text => host.memory.redactBlocked(text))));
  app.patch('/api/settings', async c => {
    const body = z.object({ memoryEnabled: z.boolean().optional(), timezone: z.string().max(80).optional() }).parse(await c.req.json());
    if (body.timezone) new Intl.DateTimeFormat('en', { timeZone: body.timezone });
    if (body.memoryEnabled !== undefined) host.setMemoryEnabled(body.memoryEnabled);
    if (body.timezone) host.store.setSetting('timezone', body.timezone);
    return c.json({ ok: true });
  });
  app.post('/api/shutdown', c => { setTimeout(shutdown, 20); return c.json({ ok: true }); });
  mountKleio(app, host);
  mountWeb(app);
  return app;
}
