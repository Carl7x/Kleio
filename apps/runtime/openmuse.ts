import type { Hono } from 'hono';
import { z } from 'zod';
import { WorkRuntimeError } from '../../packages/personal-tasks/runtime.ts';
import { RuntimeError } from '../../packages/runtime/contracts.ts';
import type { RuntimeHost } from '../../packages/runtime/host.ts';

/**
 * Research and periodic follow-up control.
 * OpenMuse EngineService.control and publishOutcome stay coupled to Intelligence,
 * goals, monitors, and unread notifications, so they are not imported.
 * Writing into the original conversation is delivery. Read is separate.
 * A follow-up with no verifiable change writes nothing. It is a periodic search, not a live watch.
 */
function asHttp(error: unknown): never {
  if (error instanceof WorkRuntimeError) {
    const status = error.code === 'NOT_FOUND' ? 404 : error.code === 'INVALID_INPUT' ? 400 : 409;
    throw new RuntimeError(error.code.toLowerCase(), error.message, status);
  }
  throw error;
}

/** Research and periodic follow-up. Goals, mail, and files stay out of this surface. */
export function mountOpenMuse(app: Hono, host: RuntimeHost): void {
  app.get('/api/openmuse/research', c => {
    try { return c.json({ research: host.work.list().filter(task => task.kind === 'research' && task.intervalMs === null).map(task => host.work.snapshot(task.id)) }); }
    catch (error) { asHttp(error); }
  });
  app.get('/api/openmuse/research/:id', c => {
    try { return c.json(host.work.snapshot(c.req.param('id'))); }
    catch (error) { asHttp(error); }
  });
  app.post('/api/openmuse/research/:id/control', async c => {
    const id = c.req.param('id');
    const body = z.object({
      action: z.enum(['pause', 'resume', 'stop', 'revise']),
      prompt: z.string().trim().min(1).max(12000).optional(),
      title: z.string().trim().min(1).max(120).optional(),
      at: z.string().optional(),
      schedule: z.object({ expression: z.string().trim().min(1).max(256), timeZone: z.string().trim().min(1).max(128).optional() }).optional(),
      expectedVersion: z.number().int().positive().optional(),
      requestId: z.string().min(1).max(200).optional(),
    }).parse(await c.req.json());
    try {
      const current = host.work.get(id);
      const version = body.expectedVersion;
      if (body.action === 'pause') version === undefined ? host.work.pause(id) : host.work.pause(id, version);
      else if (body.action === 'resume') version === undefined ? host.work.resume(id) : host.work.resume(id, version);
      else if (body.action === 'stop') version === undefined ? host.work.cancel(id) : host.work.cancel(id, version);
      else {
        if (body.prompt === undefined && body.title === undefined && body.at === undefined && body.schedule === undefined) throw new RuntimeError('invalid_input', 'Revised research needs a new prompt, title, time, or schedule', 400);
        const schedule = body.schedule ? { expression: body.schedule.expression, timeZone: body.schedule.timeZone || host.store.getSetting('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone) } : undefined;
        host.work.revise(id, {
          ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.at !== undefined ? { at: body.at } : {}),
          ...(schedule ? { schedule } : {}),
        }, { kind: 'user', conversationId: current.conversationId, messageId: body.requestId ?? `openmuse:${id}` }, version);
      }
      return c.json(host.work.snapshot(id));
    } catch (error) { asHttp(error); }
  });
  app.post('/api/openmuse/research/:id/read', c => {
    try {
      host.work.markRead(c.req.param('id'));
      return c.json(host.work.snapshot(c.req.param('id')));
    } catch (error) { asHttp(error); }
  });
}
