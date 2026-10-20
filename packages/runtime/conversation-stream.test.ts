import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { createRuntimeApp } from '../../apps/runtime/app.ts';
import { streamConversationChanges } from '../../apps/runtime/conversation-stream.ts';
import { DeviceSessions } from '../../apps/runtime/devices.ts';
import type { RuntimeHost } from './host.ts';
import { RuntimeStore } from './store.ts';

function shortStream(store: RuntimeStore, id: string, after = 0, signal = new AbortController().signal, lifetimeMs = 80) {
  const app = new Hono();
  app.get('/', c => streamSSE(c, stream => streamConversationChanges(stream, store, id, after, signal,
    { pollMs: 5, heartbeatMs: 20, lifetimeMs })));
  return app.request('http://localhost/');
}
function changes(text: string) {
  return text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
}
function fixture(store: RuntimeStore) {
  const host = { store, config: { token: 'stream-test-token', port: 31997, listenHost: '127.0.0.1' } } as RuntimeHost;
  const app = createRuntimeApp(host, () => {});
  return (path: string, headers: Record<string, string> = { authorization: 'Bearer stream-test-token' }, signal?: AbortSignal) =>
    app.request(`http://127.0.0.1:31997${path}`, { headers, ...(signal ? { signal } : {}) });
}

test('watermark is scoped, coalesces >100 committed messages, survives restart and ignores idempotent deliveries', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kleio-stream-'));
  const path = join(directory, 'app.sqlite');
  let store = new RuntimeStore(path);
  try {
    const a = store.createConversation(), b = store.createConversation();
    assert.equal(store.conversationChange(a.id).sequence, 0);
    for (let i = 0; i < 125; i++) {
      store.insertAssistantMessage(a.id, 'public delivery', `a-${i}`);
      store.insertAssistantMessage(b.id, 'OTHER CONVERSATION PRIVATE', `b-${i}`);
    }
    const watermark = store.conversationChange(a.id);
    store.insertAssistantMessage(a.id, 'duplicate ignored', 'a-124');
    assert.deepEqual(store.conversationChange(a.id), watermark);
    const internal = store.createExecution('research', a.id);
    store.event(internal.id, 'text.delta', { text: 'INTERNAL RESEARCH PRIVATE' });
    store.update(internal.id, { text: 'INTERNAL REVIEW PRIVATE', status: 'completed' });
    assert.deepEqual(store.conversationChange(a.id), watermark);
    store.close(); store = new RuntimeStore(path);
    assert.deepEqual(store.conversationChange(a.id), watermark);
    const text = await (await shortStream(store, a.id)).text();
    assert.deepEqual(changes(text), [watermark]);
    assert.match(text, new RegExp(`id: ${watermark.sequence}`));
    assert.doesNotMatch(text, /PRIVATE|public delivery|executionId|content/);
    assert.equal(store.messages(a.id).length, 125);
    assert.deepEqual(changes(await (await shortStream(store, a.id, watermark.sequence)).text()), []);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('idle stream observes commits, never outer rollback, and reconnect cursor catches hydrate/subscribe race', async () => {
  const store = new RuntimeStore(':memory:');
  try {
    const id = store.createConversation().id;
    const response = await shortStream(store, id, 0, undefined, 140);
    const body = response.text();
    await delay(10);
    assert.throws(() => store.transaction(() => {
      store.insertAssistantMessage(id, 'ROLLBACK PRIVATE', 'rollback');
      throw Error('rollback');
    }), /rollback/);
    await delay(15);
    assert.equal(store.conversationChange(id).sequence, 0);
    const committed = store.insertAssistantMessage(id, 'persisted', 'committed');
    const text = await body;
    assert.deepEqual(changes(text), [{ version: 1, conversationId: id, sequence: committed.sequence }]);
    assert.match(text, /: heartbeat/);
    assert.doesNotMatch(text, /ROLLBACK/);
    const initialSnapshot = store.messages(id);
    const between = store.insertAssistantMessage(id, 'between snapshot and stream', 'between');
    const replay = changes(await (await shortStream(store, id, initialSnapshot.at(-1)!.sequence)).text());
    assert.deepEqual(replay, [{ version: 1, conversationId: id, sequence: between.sequence }]);
  } finally { store.close(); }
});

test('stream cancellation and request abort stop polling; bounded connection closes without new messages', async () => {
  const store = new RuntimeStore(':memory:');
  try {
    const id = store.createConversation().id;
    let queries = 0;
    const original = store.conversationChange.bind(store);
    store.conversationChange = value => { queries++; return original(value); };
    const controller = new AbortController();
    const response = await shortStream(store, id, 0, controller.signal, 1000);
    const body = response.text();
    await delay(15); controller.abort(); await body;
    const stopped = queries; await delay(25); assert.equal(queries, stopped);
    const reader = (await shortStream(store, id, 0, undefined, 1000)).body!.getReader();
    await reader.read(); await reader.cancel(); await delay(10);
    const cancelled = queries; await delay(25); assert.equal(queries, cancelled);
    const start = Date.now();
    assert.deepEqual(changes(await (await shortStream(store, id, 0, undefined, 35)).text()), []);
    assert.ok(Date.now() - start < 500);
  } finally { store.close(); }
});

test('HTTP route authenticates, validates safe cursors and scope, prioritizes Last-Event-ID and renews device auth', async () => {
  const store = new RuntimeStore(':memory:');
  try {
    const id = store.createConversation().id, request = fixture(store);
    const path = `/api/conversations/${id}/stream`;
    assert.equal((await request(path, {})).status, 401);
    assert.equal((await request(path, { authorization: 'Bearer stream-test-token', origin: 'https://evil.invalid' })).status, 403);
    assert.equal((await request('/api/conversations/missing/stream')).status, 404);
    for (const cursor of ['-1', '1.5', '9007199254740992', 'NaN', '', 'Infinity']) {
      assert.equal((await request(`${path}?after=${cursor}`)).status, 400, cursor);
    }
    assert.equal((await request(`${path}?after=0`, { authorization: 'Bearer stream-test-token', 'last-event-id': '-1' })).status, 400);
    const message = store.insertAssistantMessage(id, 'hello', 'delivery');
    const controller = new AbortController();
    const response = await request(`${path}?after=invalid`, { authorization: 'Bearer stream-test-token', 'last-event-id': String(message.sequence) }, controller.signal);
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /text\/event-stream/);
    const body = response.text(); await delay(15); controller.abort();
    assert.deepEqual(changes(await body), []);
    const devices = new DeviceSessions(store), device = devices.create('test');
    const deviceResponse = await request(path, { authorization: `Bearer ${device.token}` });
    assert.equal(deviceResponse.status, 200); await deviceResponse.body!.cancel();
    devices.revoke(device.deviceId);
    assert.equal((await request(path, { authorization: `Bearer ${device.token}` })).status, 401);
  } finally { store.close(); }
});
