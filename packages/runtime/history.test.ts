import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeApp } from '../../apps/runtime/app.ts';
import { WorkRuntime, type WorkCallbacks, type WorkNotification } from '../personal-tasks/runtime.ts';
import { MemoryRuntime } from '../personal-memory/runtime.ts';
import type { RuntimeHost } from './host.ts';
import { RuntimeStore, type Execution } from './store.ts';

const now = () => Date.parse('2026-01-01T00:00:00.000Z');
const noResearch: WorkCallbacks = {
  runResearch: async () => { throw new Error('Reminder history must not invoke research'); },
  review: async () => { throw new Error('Reminder history must not invoke review'); },
};

async function reminders(work: WorkRuntime, conversationId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    work.create({ requestId: `${conversationId}-reminder-${i}`, title: `Reminder ${i}`, prompt: `Report ${i}`, kind: 'reminder' },
      { kind: 'user', conversationId, messageId: `${conversationId}-message-${i}` });
  }
  let emitted = 0;
  while (emitted < count) {
    const result = await work.tick(noResearch, { limit: 200 });
    assert.ok(result.reminders > 0);
    assert.equal(result.failed, 0);
    emitted += result.reminders;
  }
  assert.equal(emitted, count);
}

function historyApp(store: RuntimeStore, work: WorkRuntime, memory: MemoryRuntime, dataDirectory: string) {
  const port = 31999, token = 'isolated-history-test-token';
  const app = createRuntimeApp({ store, work, memory, config: { port, token, dataDirectory, listenHost: '127.0.0.1' } } as unknown as RuntimeHost, () => {});
  return (path: string, authenticated = true) => app.request(`http://127.0.0.1:${port}${path}`, {
    headers: authenticated ? { authorization: `Bearer ${token}` } : {},
  });
}

test('conversation notifications retain all persisted reports beyond both inbox limits and preserve read state', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kleio-history-'));
  const path = join(directory, 'history.sqlite');
  let store = new RuntimeStore(path);
  try {
    let work = new WorkRuntime(store.db, { now });
    const conversation = store.createConversation('Archived reports');
    const other = store.createConversation('Recent reports');
    await reminders(work, conversation.id, 205);
    const original = work.notifications({ conversationId: conversation.id });
    assert.equal(original.length, 205);
    const readIds = [original[0]!.id, original.at(-1)!.id];
    for (const id of readIds) work.readNotification(id);
    await reminders(work, other.id, 120);
    assert.equal(work.notifications().length, 100);
    assert.ok(work.notifications().every(value => value.conversationId === other.id));
    assert.equal(work.notifications({ unreadOnly: true }).length, 100);

    store.close();
    store = new RuntimeStore(path);
    work = new WorkRuntime(store.db, { now });
    const restored = work.notifications({ conversationId: conversation.id });
    assert.deepEqual(restored.map(value => value.id), original.map(value => value.id));
    assert.deepEqual(restored.filter(value => value.readAt !== null).map(value => value.id), readIds);
    const unread = work.notifications({ conversationId: conversation.id, unreadOnly: true });
    assert.equal(unread.length, 203);
    assert.ok(unread.every(value => value.readAt === null && !readIds.includes(value.id)));
    assert.deepEqual(work.notifications({ conversationId: conversation.id, limit: 3 }), restored.slice(0, 3));
    assert.deepEqual(work.notifications({ conversationId: conversation.id, unreadOnly: true, limit: 3 }), unread.slice(0, 3));
    assert.equal(work.notifications({ limit: 200 }).length, 200);
    assert.deepEqual(work.notifications({ conversationId: 'missing-conversation' }), []);
    assert.deepEqual(work.notifications({ conversationId: "' OR 1=1 --" }), []);
    for (const limit of [0, 201, 1.5]) assert.throws(() => work.notifications({ conversationId: conversation.id, limit }), { code: 'INVALID_INPUT' });
    assert.throws(() => work.notifications({ conversationId: '' }), { code: 'INVALID_INPUT' });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('conversation executions filter before truncation and combine conversation and status filters', () => {
  const store = new RuntimeStore(':memory:');
  try {
    const conversation = store.createConversation('Archived execution history');
    const other = store.createConversation('Recent execution history');
    const expected = Array.from({ length: 205 }, (_, index) => {
      const execution = store.createExecution('conversation', conversation.id);
      return index % 2 === 0 ? store.update(execution.id, { status: 'completed' }) : execution;
    }).reverse();
    for (let i = 0; i < 120; i++) store.createExecution('conversation', other.id);
    store.createExecution('research');
    assert.equal(store.executions().length, 100);
    assert.ok(store.executions().every(value => value.conversationId !== conversation.id));
    assert.deepEqual(store.executions(undefined, conversation.id), expected);
    assert.deepEqual(store.executions('completed', conversation.id), expected.filter(value => value.status === 'completed'));
    assert.deepEqual(store.executions('queued', conversation.id), expected.filter(value => value.status === 'queued'));
    assert.ok(store.executions('queued').length > 100);
    assert.throws(() => store.executions(undefined, 'missing-conversation'), { code: 'not_found' });
  } finally { store.close(); }
});

test('authenticated history endpoints return complete scoped executions and read or unread notifications', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kleio-history-api-'));
  const store = new RuntimeStore(':memory:');
  try {
    const work = new WorkRuntime(store.db, { now });
    const conversation = store.createConversation('Older conversation');
    const other = store.createConversation('Newer conversation');
    const expected = Array.from({ length: 105 }, () => store.createExecution('conversation', conversation.id)).reverse();
    await reminders(work, conversation.id, 105);
    const notification = work.notifications({ conversationId: conversation.id })[0]!;
    work.readNotification(notification.id);
    for (let i = 0; i < 110; i++) store.createExecution('conversation', other.id);
    await reminders(work, other.id, 110);
    const memory = new MemoryRuntime(store.db, { directory: join(directory, 'memory') });
    const request = historyApp(store, work, memory, directory);
    const executionPath = `/api/executions?conversationId=${encodeURIComponent(conversation.id)}`;
    const notificationPath = `/api/notifications?conversationId=${encodeURIComponent(conversation.id)}`;
    assert.equal((await request(executionPath, false)).status, 401);
    assert.equal((await request(notificationPath, false)).status, 401);
    const executionResponse = await request(executionPath);
    assert.equal(executionResponse.status, 200);
    assert.deepEqual(await executionResponse.json() as Execution[], expected);
    const notificationResponse = await request(notificationPath);
    assert.equal(notificationResponse.status, 200);
    const all = await notificationResponse.json() as WorkNotification[];
    assert.equal(all.length, 105);
    assert.ok(all.every(value => value.conversationId === conversation.id));
    assert.equal(all.find(value => value.id === notification.id)?.readAt, new Date(now()).toISOString());
    const unreadResponse = await request(`${notificationPath}&unread=true`);
    assert.equal(unreadResponse.status, 200);
    const unread = await unreadResponse.json() as WorkNotification[];
    assert.equal(unread.length, 104);
    assert.ok(unread.every(value => value.readAt === null && value.id !== notification.id));
    assert.equal((await (await request('/api/notifications')).json() as WorkNotification[]).length, 100);
    assert.equal((await (await request('/api/executions')).json() as Execution[]).length, 100);
    assert.equal((await request('/api/executions?conversationId=missing')).status, 404);

    // Forget changes the API projection, not the persisted delivery or its read state.
    const persistedBefore = work.notifications({ conversationId: conversation.id });
    const storedBefore = store.db.prepare('SELECT record,read_at FROM kw_notifications WHERE id=?').get(notification.id);
    const claim = memory.remember({ key: 'Synthetic report to forget', text: notification.text, kind: 'fact',
      source: { messageId: 'synthetic-history-forget', conversationId: conversation.id, createdAt: new Date(now()).toISOString(), quote: notification.text } });
    assert.equal(memory.forget(claim.id, { expectedVersion: claim.version }).status, 'forgotten');
    const redactedResponse = await request(notificationPath);
    assert.equal(redactedResponse.status, 200);
    const projected = await redactedResponse.json() as WorkNotification[];
    assert.equal(projected.length, 105);
    assert.ok(projected.every(value => !value.text.includes(notification.text)));
    assert.equal(projected.find(value => value.id === notification.id)?.text, '[已停止使用]');
    assert.equal(projected.find(value => value.id === notification.id)?.readAt, new Date(now()).toISOString());
    const redactedUnreadResponse = await request(`${notificationPath}&unread=true`);
    assert.equal(redactedUnreadResponse.status, 200);
    const redactedUnread = await redactedUnreadResponse.json() as WorkNotification[];
    assert.equal(redactedUnread.length, 104);
    assert.ok(redactedUnread.every(value => value.readAt === null && value.id !== notification.id));
    assert.deepEqual(work.notifications({ conversationId: conversation.id }), persistedBefore);
    assert.deepEqual(store.db.prepare('SELECT record,read_at FROM kw_notifications WHERE id=?').get(notification.id), storedBefore);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
