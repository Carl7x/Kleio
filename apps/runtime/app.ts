import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { RuntimeError } from '../../packages/runtime/contracts.ts';
import type { RuntimeHost } from '../../packages/runtime/host.ts';
import { mountOpenMuse } from './openmuse.ts';

export function createRuntimeApp(host: RuntimeHost, shutdown: () => void): Hono {
  const app = new Hono(); const token = Buffer.from('Bearer ' + host.config.token);
  app.use('*', bodyLimit({ maxSize: 128 * 1024 }));
  app.use('*', async (c, next) => {
    const url = new URL(c.req.url); const origin = c.req.header('origin');
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || (origin && origin !== url.origin)) return c.json({ error: 'Local origin required' }, 403);
    if (c.req.path === '/health' && c.req.method === 'GET') return c.json({ ok: true, product: 'Kleio' });
    const received = Buffer.from(c.req.header('authorization') ?? '');
    if (received.length !== token.length || !timingSafeEqual(received, token)) return c.json({ error: 'Authentication required' }, 401);
    c.header('Cache-Control', 'no-store'); await next();
  });
  app.onError((error, c) => {
    if (error instanceof RuntimeError) return c.json({ code: error.code, error: error.message }, error.status as 400 | 403 | 404 | 409 | 503);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ code: 'invalid_input', error: 'Invalid request' }, 400);
    if ('code' in error && typeof error.code === 'string' && !error.code.startsWith('SQLITE')) return c.json({ code: error.code, error: error.message }, 409);
    return c.json({ code: 'internal_error', error: 'Request failed; inspect persisted status before retrying.' }, 500);
  });
  app.get('/api/status', c => c.json({ product: 'Kleio', mode: 'headless', engine: host.engine.id, model: host.config.model.id, modelConfigured: !!host.config.model.apiKey,
    memory: { enabled: host.store.getSetting('memoryEnabled', true), ...host.memory.health(), watermarks: host.memory.watermarks() }, capabilities: ['conversation', 'memory', 'public-web-read', 'web-search', 'research', 'one-shot-research-delivery', 'one-shot-reminder', 'interval-work', 'inbox'] }));
  app.get('/api/conversations', c => c.json(host.store.conversations()));
  app.post('/api/conversations', async c => {
    const body = z.object({ title: z.string().trim().min(1).max(120).optional() }).parse(await c.req.json());
    return c.json(host.store.createConversation(body.title), 201);
  });
  app.get('/api/conversations/:id/messages', c => c.json(host.store.messages(c.req.param('id'))));
  app.post('/api/conversations/:id/messages', async c => {
    const body = z.object({ text: z.string().trim().min(1).max(24000), requestId: z.string().min(1).max(200) }).parse(await c.req.json());
    return c.json(host.submit(c.req.param('id'), body.text, body.requestId), 202);
  });
  app.get('/api/executions', c => c.json(host.store.executions()));
  app.get('/api/executions/:id', c => c.json(host.store.execution(c.req.param('id'))));
  app.post('/api/executions/:id/cancel', c => { host.cancel(c.req.param('id')); return c.json({ ok: true }); });
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
  app.get('/api/memory/:id/history', c => c.json(host.memory.history(c.req.param('id'))));
  app.patch('/api/memory/:id', async c => {
    const body = z.object({ text: z.string().min(1).max(4000), expectedVersion: z.number().int().positive() }).parse(await c.req.json());
    return c.json(host.memory.correct(c.req.param('id'), { ...body, source: { label: 'Authenticated user edit' } }));
  });
  app.delete('/api/memory/:id', async c => {
    const body = z.object({ expectedVersion: z.number().int().positive() }).parse(await c.req.json());
    return c.json(host.forget(c.req.param('id'), body));
  });
  app.get('/api/people', c => c.json(host.memory.people()));
  app.get('/api/work', c => c.json(host.work.list()));
  app.post('/api/work', async c => {
    const body = z.object({ requestId: z.string().min(1).max(200), title: z.string().min(1).max(120), prompt: z.string().min(1).max(12000), kind: z.enum(['research', 'reminder']), at: z.string().optional(), intervalMs: z.number().int().min(60000).optional(), conversationId: z.string().optional() }).parse(await c.req.json());
    return c.json(host.createWork({ requestId: body.requestId, title: body.title, prompt: body.prompt, kind: body.kind,
      ...(body.at ? { at: body.at } : {}), ...(body.intervalMs !== undefined ? { intervalMs: body.intervalMs } : {}), ...(body.conversationId ? { conversationId: body.conversationId } : {}) }), 201);
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
  app.get('/api/notifications', c => c.json(host.work.notifications({ unreadOnly: c.req.query('unread') === 'true' })));
  app.post('/api/notifications/:id/read', c => c.json(host.work.readNotification(c.req.param('id'))));
  app.patch('/api/settings', async c => {
    const body = z.object({ memoryEnabled: z.boolean().optional(), timezone: z.string().max(80).optional() }).parse(await c.req.json());
    if (body.timezone) new Intl.DateTimeFormat('en', { timeZone: body.timezone });
    if (body.memoryEnabled !== undefined) host.setMemoryEnabled(body.memoryEnabled);
    if (body.timezone) host.store.setSetting('timezone', body.timezone);
    return c.json({ ok: true });
  });
  app.post('/api/shutdown', c => { setTimeout(shutdown, 20); return c.json({ ok: true }); });
  mountOpenMuse(app, host);
  return app;
}
