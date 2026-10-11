import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { serveStatic } from '@hono/node-server/serve-static';
import { join } from 'node:path';
import { CoreError } from '../../packages/core/contracts.ts';
import { AgentService } from '../../packages/core/service.ts';

/** Loopback-only validation API. Not a multi-user or public Internet deployment. */
export interface AppOptions {
  webRoot?: string;
  trustedWebOrigin?: string;
  runtime?: { status: 'demo' | 'ready' | 'missing'; missing: string[]; note: string };
}

export function createApp(service: AgentService, options: AppOptions = {}): Hono {
  const app = new Hono(); const store = service.store;
  app.use('*', bodyLimit({ maxSize: 64 * 1024 }));
  app.use('*', async (context, next) => {
    const url = new URL(context.req.url); const origin = context.req.header('origin');
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) return context.json({ error: '只允许本机访问。' }, 403);
    if (origin && origin !== url.origin && origin !== options.trustedWebOrigin) return context.json({ error: '请求来源不匹配。' }, 403);
    await next();
  });
  app.onError((error, context) => {
    if (error instanceof CoreError) return context.json({ code: error.code, error: error.message }, error.status as 400 | 404 | 409 | 500);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return context.json({ code: 'invalid_request', error: '请求内容不完整或格式不正确。' }, 400);
    return context.json({ code: 'internal_error', error: '服务处理失败。请检查任务状态。' }, 500);
  });
  if (!options.webRoot) app.get('/', context => context.json({ product: 'Kleio', stage: '界面尚未构建', engine: service.engine.id,
    interface: 'Web 与桌面将复用此核心服务；当前交付为本机 API。', health: '/api/health', tasks: '/api/tasks', docs: 'docs/project-teardowns-2026-10-11/index.html' }));
  app.get('/api/health', context => context.json({ ok: true, engine: service.engine.id, capabilities: service.engine.capabilities }));
  app.get('/api/settings', context => context.json({ product: 'Kleio',
    engine: { id: service.engine.id, mode: service.engine.id === 'demo' ? 'demo' : 'dsh', label: service.engine.id === 'demo' ? '演示模式' : 'dsh 执行引擎', capabilities: service.engine.capabilities },
    runtime: options.runtime ?? { status: service.engine.id === 'demo' ? 'demo' : 'ready', missing: [],
      note: service.engine.id === 'demo' ? '当前使用固定输出验证任务流程；接入模型后才能使用真实助理能力。' : '执行引擎已配置，首次任务会尝试连接；模型认证与任务质量尚待实际验证。' },
    setup: { configuration: '.env', restartRequired: true, instructions: [
      '在本机配置中选择 dsh，并填入模型地址、名称和密钥。',
      '使用独立的本地工作目录保存会话和工具产物。',
      '重新启动服务后，在对话中验证模型是否可用。',
    ] },
  }));
  app.get('/api/conversations', context => context.json(store.conversations()));
  app.post('/api/conversations', async context => {
    const input = z.object({ title: z.string().trim().min(1).max(100).optional() }).parse(await context.req.json());
    return context.json(store.createConversation(input.title), 201);
  });
  app.get('/api/conversations/:id/messages', context => context.json(store.messages(context.req.param('id'))));
  app.post('/api/conversations/:id/messages', async context => {
    const input = z.object({ text: z.string().trim().min(1).max(12_000), clientMessageId: z.string().min(1).max(128) }).parse(await context.req.json());
    return context.json(service.submitMessage(context.req.param('id'), input.text, input.clientMessageId), 202);
  });
  app.get('/api/tasks', context => context.json(store.tasks()));
  app.get('/api/runs', context => context.json(store.runs()));
  app.post('/api/tasks', async context => {
    const input = z.object({ prompt: z.string().trim().min(1).max(12_000) }).parse(await context.req.json());
    return context.json(service.submit(input.prompt), 202);
  });
  app.post('/api/tasks/:id/restart', context => context.json(service.restart(context.req.param('id')), 202));
  app.post('/api/runs/:id/cancel', context => { service.cancel(context.req.param('id')); return context.json({ ok: true }); });
  app.get('/api/runs/:id/events', context => {
    store.run(context.req.param('id')); const after = z.coerce.number().int().nonnegative().parse(context.req.query('after') ?? 0);
    return context.json(store.events(context.req.param('id'), after));
  });
  app.get('/api/runs/:id/stream', context => {
    const runId = context.req.param('id'); store.run(runId);
    let after = z.coerce.number().int().nonnegative().parse(context.req.header('last-event-id') ?? context.req.query('after') ?? 0);
    return streamSSE(context, async stream => {
      while (!stream.aborted) {
        for (const event of store.events(runId, after)) { await stream.writeSSE({ id: String(event.sequence), event: event.type, data: JSON.stringify(event) }); after = event.sequence; }
        if (['completed', 'cancelled', 'failed', 'interrupted'].includes(store.run(runId).status)) return;
        await delay(100);
      }
    });
  });
  app.get('/api/approvals', context => context.json(store.approvals()));
  app.post('/api/approvals/:id/decision', async context => {
    const input = z.object({ hash: z.string().min(1), allow: z.boolean() }).parse(await context.req.json());
    return context.json(service.decide(context.req.param('id'), input.hash, input.allow));
  });
  app.get('/api/artifacts', context => context.json(store.artifacts()));
  app.get('/api/artifacts/:id/download', context => {
    const artifact = store.artifacts().find(item => item.id === context.req.param('id'));
    if (!artifact) throw new CoreError('not_found', '成果不存在。', 404);
    const filename = (artifact.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100) || 'Kleio-result') + '.md';
    context.header('Content-Type', 'text/markdown; charset=utf-8');
    context.header('Content-Disposition', `attachment; filename="Kleio-result.md"; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g, '%27')}`);
    context.header('X-Content-Type-Options', 'nosniff');
    return context.body(artifact.content);
  });
  app.get('/api/memories', context => context.json(store.memories()));
  app.get('/api/memories/:id/history', context => context.json(store.memoryHistory(context.req.param('id'))));
  app.post('/api/memories', async context => {
    const input = z.object({ text: z.string().trim().min(1).max(4_000), source: z.string().trim().min(1).max(1_000), scope: z.string().min(1).max(100).default('personal') }).parse(await context.req.json());
    return context.json(store.addMemory(input.text, input.source, input.scope), 201);
  });
  app.patch('/api/memories/:id', async context => {
    const input = z.object({ version: z.number().int().positive(), text: z.string().trim().min(1).max(4_000), source: z.string().trim().min(1).max(1_000) }).parse(await context.req.json());
    return context.json(store.editMemory(context.req.param('id'), input.version, input.text, input.source));
  });
  app.delete('/api/memories/:id', async context => {
    const input = z.object({ version: z.number().int().positive() }).parse(await context.req.json()); return context.json(store.deleteMemory(context.req.param('id'), input.version));
  });
  app.post('/api/memories/:id/undo', async context => {
    const input = z.object({ version: z.number().int().positive() }).parse(await context.req.json()); return context.json(store.undoMemory(context.req.param('id'), input.version));
  });
  app.get('/api/recall', context => context.json(store.recall(z.string().min(1).max(4_000).parse(context.req.query('query')), context.req.query('scope') ?? 'personal')));
  // Unknown API routes remain JSON errors rather than silently serving the client shell.
  app.all('/api/*', context => context.json({ code: 'not_found', error: '接口不存在。' }, 404));
  if (options.webRoot) {
    app.get('*', serveStatic({ root: options.webRoot }));
    app.get('*', serveStatic({ path: join(options.webRoot, 'index.html') }));
  }
  return app;
}
