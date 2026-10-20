import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalAgent, type LocalAgentApi } from './local-agent.ts';
import { conversationSyncError, runConversationTurn, showsRunError } from './conversation-run.ts';
import type { Execution, Message, ProductEvent, ConversationChange } from '../src/api.ts';
const deferred = <T = void>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function until(check: () => boolean) { for (let index = 0; index < 100; index++) { if (check()) return; await tick(); } assert.fail('condition not reached'); }
const execution = (status = 'completed'): Execution => ({ id: 'e', kind: 'conversation', conversationId: 'a', messageId: 'u', status, text: '', error: null, createdAt: '2026-10-19', updatedAt: '2026-10-19' });
const saved = (id: string, sequence: number, content = id, conversationId = 'a'): Message => ({ id, sequence, conversationId, role: 'assistant', content, createdAt: '2026-10-19', executionId: 'delivery:' + id, status: 'completed' });
const user: Message = { ...saved('u', 1), role: 'user', executionId: 'e' };
const event = (sequence: number, text: string): ProductEvent => ({ sequence, executionId: 'e', type: 'text.delta', data: { text }, createdAt: '2026-10-19' });
function fixture(overrides: Partial<LocalAgentApi> = {}, ensure: () => Promise<unknown> = async () => {}) {
  const state = { messages: [] as Message[], executions: [] as Execution[], events: [] as ProductEvent[] };
  const observers: Array<{ callback: (change: ConversationChange) => void | Promise<void>; signal: AbortSignal; after: number }> = [];
  const follows: Array<{ callback: (value: ProductEvent) => void | Promise<void>; signal: AbortSignal; done: ReturnType<typeof deferred<Execution>> }> = [];
  const errors: Array<{ error: unknown; code?: string }> = []; const reads: Array<[string, number]> = []; let cancellations = 0;
  const api: LocalAgentApi = {
    messages: async () => state.messages.map(item => ({ ...item })),
    executions: async () => state.executions.map(item => ({ ...item })),
    events: async (after = 0, id) => { reads.push([id!, after]); return state.events.filter(item => item.sequence > after); },
    subscribeConversation: async (_id, callback, options = {}) => {
      observers.push({ callback, signal: options.signal!, after: options.after ?? 0 });
      await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true }));
    },
    subscribeExecution: (_id, callback, options = {}) => { const done = deferred<Execution>(); follows.push({ callback, signal: options.signal!, done }); return done.promise; },
    submitMessage: async () => execution(), retryExecution: async () => execution(), cancelExecution: async () => { cancellations++; return { ok: true }; },
    ...overrides,
  };
  const agent = new LocalAgent('agent-a', 'a', { emitError: error => errors.push(error), threadsChanged() {} }, api, ensure);
  return { agent, state, observers, follows, errors, reads, cancellations: () => cancellations };
}

test('active existing thread observes from snapshot, reconciles duplicates/identical text by identity, and never blocks connect', async () => {
  const f = fixture(); f.state.messages = [saved('first', 1)];
  f.agent.setConversationActive(true, true);
  await until(() => f.observers.length === 1);
  assert.equal(f.observers[0].after, 1);
  await f.agent.connect(); await f.agent.connect();
  assert.equal(f.observers.length, 1);
  f.state.messages.push(saved('second', 8, 'same'), saved('third', 9, 'same'), saved('foreign', 10, 'foreign', 'other'));
  await f.observers[0].callback({ version: 1, conversationId: 'a', sequence: 9 });
  await f.observers[0].callback({ version: 1, conversationId: 'a', sequence: 9 });
  assert.deepEqual(f.agent.messages.map(item => item.id), ['first', 'second', 'third']);
  assert.equal(f.agent.isRunning, false);
  await f.agent.detachActiveRun();
});

test('inflight invalidation queues a fresh read; older snapshot cannot finish after newer snapshot', async () => {
  const first = deferred<Message[]>(); let reads = 0; const f = fixture({ messages: async () => ++reads === 1 ? first.promise : [saved('new', 3)] });
  f.agent.setConversationActive(true, true);
  const connecting = f.agent.connect();
  await tick(); assert.equal(reads, 1);
  first.resolve([saved('old', 1)]);
  await connecting; await until(() => f.observers.length === 1);
  assert.equal(reads, 2);
  assert.deepEqual(f.agent.messages.map(item => item.id), ['new']);
  await f.agent.detachActiveRun();
});

test('detach fences late message and event reads, including queued old generation', async () => {
  const messages = deferred<Message[]>(); const f = fixture({ messages: () => messages.promise });
  const first = f.agent.connect(); const queued = f.agent.connect();
  await f.agent.detachActiveRun(); messages.resolve([saved('stale', 1)]);
  await Promise.all([first, queued]); assert.deepEqual(f.agent.messages, []); assert.equal(f.observers.length, 0);
  const page = deferred<ProductEvent[]>(); const g = fixture({ events: () => page.promise });
  g.state.messages = [user]; g.state.executions = [execution()];
  const loading = g.agent.connect(); await tick(); await g.agent.detachActiveRun();
  const version = g.agent.getSnapshot(); page.resolve([event(1, 'stale')]); await loading;
  assert.equal(g.agent.getSnapshot(), version); assert.deepEqual(g.agent.messages, []);
});

test('hidden observation aborts only observation; return refreshes and catches up without cancellation', async () => {
  const f = fixture(); f.agent.setConversationActive(true, true); await until(() => f.observers.length === 1);
  f.agent.setConversationActive(false); assert.equal(f.observers[0].signal.aborted, true);
  f.state.messages = [saved('missed', 7)];
  f.agent.setConversationActive(true, true); await until(() => f.observers.length === 2);
  assert.equal(f.observers[1].after, 7); assert.equal(f.agent.messages[0].id, 'missed'); assert.equal(f.cancellations(), 0);
  await f.agent.detachActiveRun();
});

test('late ensure cannot start hidden or detached observations, while first active new-thread run does', async () => {
  for (const detach of [false, true]) {
    const gate = deferred(); const f = fixture({}, () => gate.promise);
    f.agent.setConversationActive(true); f.agent.addMessage({ id: 'pending', role: 'user', content: 'hello' });
    const run = f.agent.run();
    if (detach) await f.agent.detachActiveRun(); else f.agent.setConversationActive(false);
    const version = f.agent.getSnapshot(); gate.resolve(); await run;
    assert.equal(f.observers.length, 0);
    if (detach) assert.equal(f.agent.getSnapshot(), version);
  }
  const f = fixture(); f.agent.setConversationActive(true); f.agent.addMessage({ id: 'pending', role: 'user', content: 'hello' });
  await f.agent.run(); await until(() => f.observers.length === 1); await f.agent.detachActiveRun();
});

test('observer snapshot during submission preserves pending user and running state; detached submission cannot publish', async () => {
  const submit = deferred<Execution>(); const f = fixture({ submitMessage: () => submit.promise });
  f.agent.setConversationActive(true); f.agent.addMessage({ id: 'pending', role: 'user', content: 'hello' });
  const run = f.agent.run(); await until(() => f.observers.length === 1);
  assert.equal(f.agent.isRunning, true); assert.equal(f.agent.messages.at(-1)?.id, 'pending');
  await f.agent.detachActiveRun(); const version = f.agent.getSnapshot(); submit.resolve(execution()); await run;
  assert.equal(f.agent.getSnapshot(), version);
});

test('foreground deltas survive background delivery, event reads advance incrementally and terminal state cannot roll back', async () => {
  const f = fixture(); f.state.messages = [user]; f.state.executions = [execution('running')]; f.state.events = [event(1, 'live')];
  f.agent.setConversationActive(true, true); const connect = f.agent.connect();
  await until(() => f.observers.length === 1 && f.follows.length === 1);
  await f.follows[0].callback(event(2, ' reply'));
  f.state.messages.push(saved('background', 6));
  await f.observers[0].callback({ version: 1, conversationId: 'a', sequence: 6 });
  assert.ok(f.agent.messages.some(item => item.role === 'assistant' && item.content === 'live reply'));
  assert.ok(f.agent.messages.some(item => item.id === 'background'));
  assert.equal(f.agent.isRunning, true); assert.equal(f.follows.length, 1);
  assert.ok(f.reads.some(([, after]) => after === 2));
  f.follows[0].done.resolve(execution()); await connect;
  assert.equal(f.agent.isRunning, false); // fixture still returns the stale running snapshot
  f.state.executions = [execution()]; await f.observers[0].callback({ version: 1, conversationId: 'a', sequence: 6 });
  const count = f.reads.length;
  await f.observers[0].callback({ version: 1, conversationId: 'a', sequence: 6 });
  assert.equal(f.reads.length, count);
  f.agent.setConversationActive(false); assert.equal(f.cancellations(), 0); await f.agent.detachActiveRun();
});

test('irrecoverable observation errors show separately and do not fail successful foreground turns', async () => {
  const f = fixture({ subscribeConversation: async () => { throw Object.assign(new Error('auth expired'), { status: 401 }); } });
  const listeners = new Set<(event: { error: unknown; code?: string }) => void>();
  await runConversationTurn('agent-a', async () => {
    f.agent.setConversationActive(true, true); await until(() => f.errors.length === 1);
    for (const listener of listeners) listener(f.errors[0]);
  }, listener => { listeners.add(listener); return { unsubscribe: () => listeners.delete(listener) }; });
  assert.equal(f.errors[0].code, conversationSyncError);
  assert.equal(showsRunError(f.errors[0], { replaying: true, queuedTurn: true }), true);
  await f.agent.detachActiveRun();
});

test('a saved prior accepted request cannot consume a newer pending user during observer refresh', async () => {
  const f = fixture(); f.agent.setConversationActive(true);
  f.agent.addMessage({ id: 'first-request', role: 'user', content: 'first' });
  await f.agent.run(); await until(() => f.observers.length === 1);
  f.state.messages = [{ ...user, id: 'first-request' }];
  f.agent.addMessage({ id: 'new-pending', role: 'user', content: 'keep me' });
  await f.observers[0].callback({ version: 1, conversationId: 'a', sequence: 1 });
  assert.equal(f.agent.messages.at(-1)?.id, 'new-pending');
  assert.equal(f.agent.canRetry, true);
  await f.agent.detachActiveRun();
});

test('hiding while an event page is pending prevents that observer from publishing late data', async () => {
  const page = deferred<ProductEvent[]>(); const f = fixture({ events: () => page.promise });
  f.state.messages = [user]; f.state.executions = [execution()];
  f.agent.setConversationActive(true, true); await tick();
  f.agent.setConversationActive(false); const version = f.agent.getSnapshot();
  page.resolve([event(1, 'late')]); await tick(); await tick();
  assert.equal(f.agent.getSnapshot(), version); assert.deepEqual(f.agent.messages, []); assert.equal(f.observers.length, 0);
  await f.agent.detachActiveRun();
});

test('temporary bootstrap read failure preserves pending state and retries; observation callback failures reach transport', async () => {
  let attempts = 0; const f = fixture({ messages: async () => {
    if (++attempts === 1) throw Object.assign(new Error('offline'), { code: 'offline', status: 0 });
    return [saved('recovered', 7)];
  } });
  f.agent.addMessage({ id: 'pending', role: 'user', content: 'draft queued' });
  f.agent.setConversationActive(true, true);
  await new Promise(resolve => setTimeout(resolve, 340));
  assert.equal(f.errors.length, 0); assert.equal(f.observers.length, 1);
  assert.deepEqual(f.agent.messages.map(item => item.id), ['recovered', 'pending']);
  await f.agent.detachActiveRun();
  let fail = false;
  const g = fixture({ messages: async () => { if (fail) throw Object.assign(new Error('read timeout'), { code: 'timeout', status: 0 }); return []; } });
  g.agent.setConversationActive(true, true); await until(() => g.observers.length === 1); fail = true;
  await assert.rejects(async () => g.observers[0].callback({ version: 1, conversationId: 'a', sequence: 1 }), /read timeout/);
  assert.equal(g.errors.length, 0); await g.agent.detachActiveRun();
});

test('detached retry cannot publish its late accepted execution', async () => {
  const retry = deferred<Execution>(); const f = fixture({ retryExecution: () => retry.promise });
  f.state.messages = [user]; f.state.executions = [execution('failed')];
  await f.agent.connect(); const run = f.agent.run(); await tick();
  await f.agent.detachActiveRun(); const version = f.agent.getSnapshot();
  retry.resolve({ ...execution('running'), id: 'retry' }); await run;
  assert.equal(f.agent.getSnapshot(), version); assert.equal(f.follows.length, 0);
});

test('after detach, a fresh lifecycle receives its own snapshot after the obsolete read retires', async () => {
  const old = deferred<Message[]>(); let count = 0;
  const f = fixture({ messages: async () => ++count === 1 ? old.promise : [saved('current', 9)] });
  const first = f.agent.connect(); await f.agent.detachActiveRun();
  f.agent.setConversationActive(true, true); old.resolve([saved('old', 1)]); await first;
  await until(() => f.observers.length === 1);
  assert.equal(f.observers[0].after, 9); assert.deepEqual(f.agent.messages.map(item => item.id), ['current']);
  await f.agent.detachActiveRun();
});
