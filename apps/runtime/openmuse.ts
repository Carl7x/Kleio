import { randomUUID } from 'node:crypto';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { Workspace } from '../../packages/openmuse-domain/src/index.ts';
import { createTaskSchema, type AgentArtifact, type AgentIdentity, type AgentMemory, type AgentNotification, type AgentTask, type AgentWorkspace, type RunEvent } from '../../packages/openmuse-domain/src/agent.ts';
import type { ComputerSnapshot } from '../../packages/openmuse-domain/src/computer.ts';
import type { MemoryClaim } from '../../packages/personal-memory/runtime.ts';
import { WorkRuntimeError, type WorkNotification, type WorkTask } from '../../packages/personal-tasks/runtime.ts';
import { RuntimeError } from '../../packages/runtime/contracts.ts';
import type { RuntimeHost } from '../../packages/runtime/host.ts';
import { currentAgentIdentity, saveAgentIdentity } from '../../packages/runtime/identity.ts';
import { projectNotification } from './notification-projection.ts';

const capabilities = { research: true, reminders: true, goals: false, tracking: false, ideas: false, google: false, browser: false, computer: false, pdf: false, finance: false, taskPause: false, taskResume: false, taskRetry: false, taskCancel: true, taskInput: false };
const identity = (host: RuntimeHost): AgentIdentity => currentAgentIdentity(host.store, host.config.dataDirectory);
const memory = (claim: MemoryClaim): AgentMemory & { version: number } => ({ id: claim.id, text: claim.text, source: claim.provenance?.label ?? 'Conversation', createdAt: claim.createdAt, version: claim.version });
const notification = (value: WorkNotification): AgentNotification => ({ id: value.id, taskId: value.taskId, title: value.title, body: value.text, createdAt: value.createdAt, read: value.readAt !== null });
const unsupported = (): never => { throw new RuntimeError('unsupported', 'This capability is not available in the Kleio runtime.', 409); };

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

function taskDetail(host: RuntimeHost, work: WorkTask) {
  const runs = host.work.runs(work.id);
  const latest = runs.find(run => run.id === work.lastRunId) ?? runs[0];
  const phase = latest?.status;
  const status: AgentTask['status'] = work.status === 'completed' ? 'succeeded'
    : work.status === 'cancelled' ? 'cancelled'
    : work.status === 'failed' || work.status === 'unknown' ? 'failed'
    : phase === 'running' || phase === 'review_pending' || phase === 'reviewing' ? 'running'
    : work.nextAt && Date.parse(work.nextAt) > Date.now() ? 'scheduled' : 'queued';
  const artifacts: AgentArtifact[] = runs.flatMap(run => {
    const result = host.work.result(run.id);
    if (!result) return [];
    const review = host.work.reviewResult(run.id);
    // The original report card prints every data field. Keep the user-facing
    // review in summary; run ids and raw evidence stay on the task detail.
    return [{ id: result.id, taskId: work.id, kind: 'report' as const, title: work.title,
      summary: review?.text ?? result.text, data: {}, createdAt: result.createdAt }];
  });
  const latestReview = latest && host.work.reviewResult(latest.id);
  const latestResult = latest && host.work.result(latest.id);
  const events: RunEvent[] = [{ id: work.id + ':created', taskId: work.id, date: work.createdAt, kind: 'status', title: 'Task created', detail: work.title }];
  for (const run of runs) {
    events.push({ id: run.id + ':started', taskId: work.id, date: run.createdAt, kind: 'status', title: work.kind === 'reminder' ? 'Reminder due' : 'Research started', detail: run.occurrenceAt });
    const result = host.work.result(run.id), review = host.work.reviewResult(run.id);
    if (result) events.push({ id: result.id, taskId: work.id, date: result.createdAt, kind: 'result', title: 'Research result saved', detail: result.text });
    if (review) events.push({ id: review.id, taskId: work.id, date: review.createdAt, kind: 'observation', title: 'Assistant review completed', detail: review.text });
    if (run.status !== 'running' && run.status !== 'review_pending' && run.status !== 'reviewing') {
      events.push({ id: run.id + ':settled', taskId: work.id, date: run.updatedAt, kind: run.status === 'failed' || run.status === 'unknown' ? 'error' : 'status', title: run.status === 'unknown' ? 'Outcome unknown' : run.status, detail: run.errorCode ?? '' });
    }
  }
  if (work.status === 'cancelled') events.push({ id: work.id + ':cancelled', taskId: work.id, date: work.updatedAt, kind: 'status', title: 'Task cancelled', detail: '' });
  events.sort((a, b) => a.date.localeCompare(b.date));
  const task: AgentTask = { id: work.id, title: work.title, prompt: work.prompt, kind: 'agent', status, plan: [],
    evidence: latestResult?.evidence?.map((item, index) => ({ id: latestResult.id + ':evidence:' + index, kind: item.kind === 'url' ? 'web' as const : item.kind === 'file' ? 'file' as const : 'user' as const,
      title: item.reference, excerpt: item.reference, ...(item.kind === 'url' ? { url: item.reference } : {}) })) ?? [],
    input: { workKind: work.kind, at: work.at, intervalMs: work.intervalMs, conversationId: work.conversationId, ...(work.schedule ? { schedule: work.schedule } : {}) },
    state: { workKind: work.kind, workStatus: work.status, runStatus: phase ?? null, version: work.version, lastRunId: work.lastRunId,
      ...(phase === 'review_pending' || phase === 'reviewing' ? { phase: 'assistant_review' } : {}), ...(work.status === 'unknown' ? { outcomeUnknown: true } : {}) },
    createdAt: work.createdAt, updatedAt: latest && latest.updatedAt > work.updatedAt ? latest.updatedAt : work.updatedAt, ...(work.nextAt ? { nextRunAt: work.nextAt } : {}),
    attempts: runs.length, actionId: null, leaseId: null, leaseUntil: null,
    ...(latestReview || latestResult ? { result: latestReview?.text ?? latestResult!.text } : {}),
    error: work.status === 'unknown' ? 'The runtime stopped before the research outcome was confirmed.' : latest?.errorCode ?? null,
    artifactIds: artifacts.map(item => item.id) };
  return { task, events, artifacts, files: [], browsers: [] };
}

function mainThread(host: RuntimeHost): string {
  const stored = host.store.getSetting<string | null>('openmuse.mainThread', null);
  if (stored) { host.store.conversation(stored); return stored; }
  return host.store.transaction(() => {
    const conversations = host.store.conversations();
    const main = conversations.find(item => item.isMain) ?? conversations.at(-1) ?? host.store.createConversation();
    host.store.updateConversation(main.id, { isMain: true, archived: false });
    host.store.setSetting('openmuse.mainThread', main.id);
    return main.id;
  });
}

/** OpenMuse presentation contracts plus L0 research / periodic follow-up control. */
export function mountOpenMuse(app: Hono, host: RuntimeHost): void {
  const displayedNotification = (value: WorkNotification) => projectNotification(value, text => host.memory.redactBlocked(text));
  app.get('/api/workspace', c => {
    const workspace: Workspace = { mode: 'live', profile: { name: 'You', email: '' }, mail: [], events: [], files: [], browsers: [], actions: [],
      activity: host.work.notifications().map(displayedNotification).map(item => ({ id: item.id, title: item.title, detail: item.text, date: item.createdAt, status: item.readAt ? 'read' : 'unread' })),
      connections: [{ id: 'google', name: 'Google', status: 'unconfigured', capabilities: [] },
        { id: 'browser', name: 'Browser', status: 'unconfigured', capabilities: [] }, { id: 'computer', name: 'Computer', status: 'unconfigured', capabilities: [] }],
      runtime: { provider: 'model', configured: Boolean(host.config.model.apiKey), openbotConfigured: false, richThreads: true, capabilities } };
    return c.json(workspace);
  });
  app.get('/api/main-thread', c => c.json({ threadId: mainThread(host), existing: true }));
  const threadView = (value: ReturnType<RuntimeHost['store']['conversation']>) => ({ ...value, name: value.title, archived: value.archived ?? false });
  app.get('/api/threads', c => c.json({ threads: host.store.conversations().map(threadView), hasMore: false }));
  app.post('/api/threads', async c => {
    const body = z.object({ id: z.string().uuid().optional(), name: z.string().trim().min(1).max(120).optional(), title: z.string().trim().min(1).max(120).optional() }).parse(await c.req.json());
    return c.json(threadView(host.store.createConversation(body.title ?? body.name, body.id)), 201);
  });
  app.patch('/api/threads/:id', async c => {
    const body = z.object({ title: z.string().trim().min(1).max(120).optional(), name: z.string().trim().min(1).max(120).optional() }).parse(await c.req.json());
    const title = body.title ?? body.name;
    if (!title) throw new RuntimeError('invalid_input', 'A thread title is required', 400);
    return c.json(threadView(host.store.updateConversation(c.req.param('id'), { title })));
  });
  for (const action of ['archive', 'restore'] as const) app.post('/api/threads/:id/' + action, c => {
    const id = z.string().uuid().parse(c.req.param('id'));
    if (id === host.store.getSetting('openmuse.mainThread', '') && action === 'archive') throw new RuntimeError('invalid_input', 'The main conversation cannot be archived', 400);
    return c.json(threadView(host.store.updateConversation(id, { archived: action === 'archive' })));
  });
  app.get('/api/agent', c => {
    const details = host.work.list().map(work => taskDetail(host, work));
    const snapshot: AgentWorkspace = { tasks: details.map(value => value.task), goals: [], monitors: [], ideas: [], memories: host.memory.list().map(memory),
      artifacts: details.flatMap(value => value.artifacts), notifications: host.work.notifications().map(displayedNotification).map(notification), identity: identity(host), worker: { running: true } };
    return c.json(snapshot);
  });
  app.post('/api/agent/tasks', async c => {
    const body = createTaskSchema.extend({ requestId: z.string().min(1).max(200).optional() }).parse(await c.req.json());
    if (!['agent', 'plan'].includes(body.kind) || body.goalId || body.milestoneId) unsupported();
    const input = z.object({ workKind: z.enum(['research', 'reminder']).default('research'), at: z.string().optional(), intervalMs: z.number().int().min(60000).optional(), conversationId: z.string().optional(), schedule: z.object({ expression: z.string().trim().min(1).max(256), timeZone: z.string().trim().min(1).max(128).optional() }).optional() }).parse(body.input);
    const schedule = input.schedule ? { expression: input.schedule.expression, timeZone: input.schedule.timeZone || host.store.getSetting('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone) } : undefined;
    const work = host.createWork({ requestId: body.requestId ?? randomUUID(), title: (body.title ?? body.prompt.split(/\r?\n/u)[0]!).slice(0, 120), prompt: body.prompt,
      kind: input.workKind, ...(input.at !== undefined ? { at: input.at } : {}), ...(input.intervalMs !== undefined ? { intervalMs: input.intervalMs } : {}), ...(schedule ? { schedule } : {}), conversationId: input.conversationId ?? mainThread(host) });
    return c.json(taskDetail(host, work).task, 201);
  });
  app.get('/api/agent/tasks/:id', c => c.json(taskDetail(host, host.work.get(c.req.param('id')))));
  app.post('/api/agent/tasks/:id/control', async c => {
    const body = z.object({ action: z.enum(['pause', 'resume', 'cancel', 'retry']), expectedVersion: z.number().int().positive().optional() }).parse(await c.req.json());
    if (body.action !== 'cancel') unsupported();
    return c.json(taskDetail(host, host.work.cancel(c.req.param('id'), body.expectedVersion)).task);
  });
  app.get('/api/agent/memories', c => c.json(host.memory.list().map(memory)));
  app.post('/api/agent/memories', async c => {
    const body = z.object({ text: z.string().trim().min(1).max(1600), source: z.string().trim().min(1).max(160).optional() }).parse(await c.req.json());
    const id = randomUUID(), createdAt = new Date().toISOString();
    const key = 'user-added:' + id;
    const captured = await host.memory.ingestWindow({ conversationId: 'memory-command:' + id, throughSequence: 1,
      messages: [{ id, role: 'user', content: body.text, createdAt }] }, async () => JSON.stringify({ claims: [{ subject: '用户', key, text: body.text,
        kind: 'fact', evidence: [{ messageId: id, quote: body.text }], scope: 'personal' }], relationships: [] }));
    const added = host.memory.list().find(claim => claim.key === key);
    if (!added || captured.status !== 'applied') throw new RuntimeError('invalid_memory', 'The native memory service could not save this statement.', 409);
    // Ingestion already committed the new fact. A same-text correction was a no-op,
    // and must not turn ordinary addition into context revocation.
    return c.json(memory(added), 201);
  });
  app.post('/api/agent/memories/:id', async c => {
    const body = z.object({ text: z.string().trim().min(1).max(1600), source: z.string().trim().min(1).max(160).optional(), expectedVersion: z.number().int().positive().optional() }).parse(await c.req.json());
    const current = host.memory.list().find(claim => claim.id === c.req.param('id'));
    if (!current) throw new RuntimeError('not_found', 'Active memory not found', 404);
    return c.json(memory(host.correct(current.id, { text: body.text, expectedVersion: body.expectedVersion ?? current.version, source: { label: body.source ?? 'Authenticated user edit' } })));
  });
  app.get('/api/agent/memories/:id/history', c => c.json(host.memory.history(c.req.param('id'))));
  app.post('/api/agent/memories/:id/forget', async c => {
    const body = z.object({ expectedVersion: z.number().int().positive().optional() }).parse(await c.req.json());
    host.forget(c.req.param('id'), body.expectedVersion === undefined ? {} : { expectedVersion: body.expectedVersion });
    return c.json({ ok: true });
  });
  app.post('/api/agent/identity', async c => {
    const body = z.object({ name: z.string().trim().min(1).max(80), tone: z.enum(['warm', 'concise', 'thoughtful']), avatar: z.enum(['sky', 'sand', 'lilac']).optional(), showChatUpdates: z.boolean().optional() }).parse(await c.req.json());
    return c.json(saveAgentIdentity(host.store, host.config.dataDirectory, {
      name: body.name, tone: body.tone,
      ...(body.avatar !== undefined ? { avatar: body.avatar } : {}),
      ...(body.showChatUpdates !== undefined ? { showChatUpdates: body.showChatUpdates } : {}),
    }));
  });
  app.get('/api/agent/notifications', c => c.json(host.work.notifications().map(displayedNotification).map(notification)));
  app.post('/api/agent/notifications/:id/read', c => c.json(notification(displayedNotification(host.work.readNotification(c.req.param('id'))))));
  const computer: ComputerSnapshot = { enabled: false, provider: 'docker', status: 'unconfigured', workspacePath: '/workspace', network: 'disabled', message: 'Computer control is not configured.', commands: [] };
  app.get('/api/computer', c => c.json(computer));
  app.get('/api/computer/files', c => c.json({ path: c.req.query('path') ?? '/workspace', entries: [] }));
  app.get('/api/google/status', c => c.json({ status: 'unconfigured', connected: false, capabilities: [] }));
  app.get('/api/jev', c => c.json({ panel: null }));
  for (const path of ['/api/calendars', '/api/calendar/events', '/api/drafts', '/api/mail/threads/:id', '/api/files', '/api/browsers', '/api/agent/goals', '/api/agent/monitors', '/api/agent/ideas']) app.get(path, c => c.json([]));
  for (const path of ['/api/actions', '/api/actions/*', '/api/drafts', '/api/google/*', '/api/calendar/*', '/api/mail/*', '/api/files', '/api/files/*', '/api/browsers', '/api/browsers/*', '/api/computer/*', '/api/agent/goals', '/api/agent/goals/*', '/api/agent/monitors', '/api/agent/monitors/*', '/api/agent/ideas/*', '/api/agent/tasks/:id/input', '/api/agent/sample-page', '/api/jev', '/api/jev/*']) {
    app.all(path, () => unsupported());
  }

  // L0 research / periodic follow-up control surface (kept alongside OpenMuse presentation routes).
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
