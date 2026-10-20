import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// The API is exercised with an injected transport so these regressions never need
// React Native, credentials, a running server, or a model request.
async function isolatedApi(fetcher) {
  const source = await readFile(new URL('./api.ts', import.meta.url), 'utf8');
  const key = `kleioApiTest${crypto.randomUUID()}`;
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
    .replace(/import \{ clientFetch \} from ['"]\.\/transport['"];?/, `const clientFetch = globalThis[${JSON.stringify(key)}];`);
  assert.ok(!code.includes("from './transport'"));
  globalThis[key] = fetcher;
  try { return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).api; }
  finally { delete globalThis[key]; }
}
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const event = (sequence, type, data = {}) => ({ sequence, executionId: 'reply', type, data, createdAt: '2026-10-14T00:00:00Z' });
const frame = value => `id: ${value.sequence}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
const terminal = { id: 'reply', status: 'completed', text: '中文回复' };

test('conversation history reads are scoped and memory correction keeps its expected version', async () => {
  const seen = [];
  const api = await isolatedApi(async (path, init) => { seen.push([path, init]); return json({ ok: true }); });
  await api.executions(undefined, '会话/a');
  await api.notifications(undefined, false, '会话/a');
  await api.notifications(undefined, true, '会话/a');
  await api.editMemory({ id: '记忆/a', version: 3 }, '纠正后的背景');
  assert.equal(seen[0][0], '/api/executions?conversationId=%E4%BC%9A%E8%AF%9D%2Fa');
  assert.equal(new URL(seen[1][0], 'http://test').searchParams.get('conversationId'), '会话/a');
  assert.equal(new URL(seen[1][0], 'http://test').searchParams.has('unread'), false);
  assert.equal(new URL(seen[2][0], 'http://test').searchParams.get('unread'), 'true');
  assert.equal(seen[3][0], '/api/memory/%E8%AE%B0%E5%BF%86%2Fa');
  assert.deepEqual(JSON.parse(seen[3][1].body), { text: '纠正后的背景', expectedVersion: 3 });
});

test('stream reconnect preserves UTF-8, skips replay, and drains a terminal tail across 500-event pages', async () => {
  const received = [];
  let streams = 0;
  let tails = 0;
  const first = event(1, 'text.delta', { text: '中文' });
  const second = event(2, 'text.delta', { text: '回复' });
  const api = await isolatedApi(async path => {
    if (path.startsWith('/api/executions/reply/stream?')) {
      streams++;
      assert.equal(new URL(path, 'http://test').searchParams.get('after'), streams === 1 ? '0' : '1');
      const bytes = new TextEncoder().encode(streams === 1 ? frame(first) + 'data: {"sequence":2' : frame(first) + frame(second));
      let position = 0;
      const streamNumber = streams;
      return new Response(new ReadableStream({ pull(controller) {
        if (position < bytes.length) { controller.enqueue(bytes.slice(position, position + 7)); position += 7; }
        else if (streamNumber === 1) controller.error(new Error('connection dropped'));
        else controller.close();
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (path === '/api/executions/reply') return json(terminal);
    if (path.startsWith('/api/events?')) {
      tails++;
      const after = Number(new URL(path, 'http://test').searchParams.get('after'));
      assert.equal(after, tails === 1 ? 2 : 502);
      return json(tails === 1 ? Array.from({ length: 500 }, (_, index) => event(index + 3, 'tool.completed')) : [event(503, 'execution.completed', { text: '中文回复' })]);
    }
    assert.fail(`unexpected fixture request: ${path}`);
  });
  const result = await api.subscribeExecution('reply', value => received.push(value), { signal: AbortSignal.timeout(3000) });
  assert.equal(result.text, '中文回复');
  assert.equal(streams, 2);
  assert.equal(tails, 2);
  assert.equal(received.length, 503);
  assert.deepEqual(received.slice(0, 2).map(value => value.data.text), ['中文', '回复']);
  assert.equal(new Set(received.map(value => value.sequence)).size, received.length);
});

test('a malformed event stops synchronization with an explicit error', async () => {
  const api = await isolatedApi(async () => new Response('data: {invalid}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }));
  await assert.rejects(api.subscribeExecution('reply', () => {}, { signal: AbortSignal.timeout(1000) }), { code: 'invalid_event' });
});

const change = (sequence, extra = {}) => ({ version: 1, conversationId: '会话/a', sequence, ...extra });
const changeFrame = value => `event: conversation.changed\r\nid: ${value.sequence}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
const sse = text => new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });

test('conversation watermarks reconnect at acknowledged cursor, decode chunks, and skip duplicates', async () => {
  const controller = new AbortController();
  const received = []; const cursors = [];
  const api = await isolatedApi(async path => {
    const parsed = new URL(path, 'http://test');
    assert.equal(parsed.pathname, '/api/conversations/%E4%BC%9A%E8%AF%9D%2Fa/stream');
    cursors.push(Number(parsed.searchParams.get('after')));
    if (cursors.length === 1) return sse(': connected\r\n\r\n' + changeFrame(change(3)) + 'event: conversation.changed\n');
    const bytes = new TextEncoder().encode(changeFrame(change(3)) + changeFrame(change(9)));
    let position = 0;
    return new Response(new ReadableStream({ pull(stream) {
      if (position < bytes.length) stream.enqueue(bytes.slice(position, position += 2));
      else stream.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  });
  await api.subscribeConversation('会话/a', async value => {
    received.push(value.sequence);
    if (value.sequence === 9) controller.abort();
  }, { signal: controller.signal });
  assert.deepEqual(cursors, [0, 3]);
  assert.deepEqual(received, [3, 9]);
});

test('conversation callback failure replays unacknowledged watermark after an offline read', async () => {
  const controller = new AbortController();
  const cursors = []; let calls = 0;
  const api = await isolatedApi(async path => {
    if (path === '/api/conversations/read/messages') throw new TypeError('offline');
    cursors.push(Number(new URL(path, 'http://test').searchParams.get('after')));
    return sse(changeFrame(change(7)));
  });
  await api.subscribeConversation('会话/a', async () => {
    calls++;
    if (calls === 1) await api.messages('read');
    else controller.abort();
  }, { after: 2, signal: controller.signal });
  assert.deepEqual(cursors, [2, 2]);
  assert.equal(calls, 2);
});

test('conversation protocol rejects invalid metadata and frames without reconnecting', async () => {
  const frames = [
    changeFrame(change(1, { version: 2 })), changeFrame(change(1, { conversationId: 'other' })),
    changeFrame(change(-1)), changeFrame(change(1.5)), changeFrame(change(Number.MAX_SAFE_INTEGER + 1)),
    'event: unknown\nid: 1\ndata: {}\n\n', 'event: conversation.changed\nid: 1\ndata: {bad}\n\n',
    'event: conversation.changed\nid: 2\ndata: ' + JSON.stringify(change(1)) + '\n\n',
    'event: conversation.changed\nid: 1\nid: 1\ndata: ' + JSON.stringify(change(1)) + '\n\n',
    'x'.repeat(65537), 'data: ' + 'x'.repeat(65537) + '\n\n',
  ];
  for (const frame of frames) {
    let requests = 0;
    const api = await isolatedApi(async () => { requests++; return sse(frame); });
    await assert.rejects(api.subscribeConversation('会话/a', () => assert.fail('invalid callback')), { code: 'invalid_event' });
    assert.equal(requests, 1);
  }
});

test('conversation transport retries 5xx but stops auth, missing resource, and invalid stream', async () => {
  for (const status of [401, 403, 404]) {
    let requests = 0;
    const api = await isolatedApi(async () => { requests++; return new Response('{}', { status }); });
    await assert.rejects(api.subscribeConversation('会话/a', () => {}), { status });
    assert.equal(requests, 1);
  }
  const invalid = await isolatedApi(async () => json({}));
  await assert.rejects(invalid.subscribeConversation('会话/a', () => {}), { code: 'invalid_stream' });
  const controller = new AbortController(); let requests = 0;
  const retry = await isolatedApi(async () => ++requests === 1 ? new Response('{}', { status: 503 }) : sse(changeFrame(change(1))));
  await retry.subscribeConversation('会话/a', () => controller.abort(), { signal: controller.signal });
  assert.equal(requests, 2);
});

test('conversation abort cancels an idle reader and a reconnect wait', async () => {
  const controller = new AbortController(); let cancelled = false;
  let opened;
  const ready = new Promise(resolve => { opened = resolve; });
  const api = await isolatedApi(async () => new Response(new ReadableStream({
    start() { opened(); }, cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'text/event-stream' } }));
  const subscription = api.subscribeConversation('会话/a', () => {}, { signal: controller.signal });
  await ready;
  controller.abort();
  await subscription;
  assert.equal(cancelled, true);
  const waiting = new AbortController(); let requests = 0;
  const eof = await isolatedApi(async () => { requests++; return sse(''); });
  const pending = eof.subscribeConversation('会话/a', () => {}, { signal: waiting.signal });
  setTimeout(() => waiting.abort(), 20);
  await pending;
  assert.equal(requests, 1);
});

test('conversation awaits reconciliation before reading or acknowledging following watermarks', async () => {
  const controller = new AbortController();
  let release; const blocked = new Promise(resolve => { release = resolve; });
  let entered; const started = new Promise(resolve => { entered = resolve; });
  const received = [];
  const api = await isolatedApi(async () => sse(changeFrame(change(1)) + changeFrame(change(2))));
  const pending = api.subscribeConversation('会话/a', async value => {
    received.push(value.sequence);
    if (value.sequence === 1) { entered(); await blocked; }
    else controller.abort();
  }, { signal: controller.signal });
  await started;
  assert.deepEqual(received, [1]);
  release(); await pending;
  assert.deepEqual(received, [1, 2]);
});

test('conversation read methods preserve supplied abort signals and invalid cursor fails before fetch', async () => {
  const controller = new AbortController(); const signals = [];
  const api = await isolatedApi(async (_path, init) => { signals.push(init.signal); return json([]); });
  const reads = [api.messages('a', controller.signal), api.executions(controller.signal, 'a'), api.events(0, 'e', controller.signal)];
  controller.abort();
  await Promise.all(reads);
  assert.equal(signals.length, 3);
  assert.ok(signals.every(signal => signal.aborted));
  await assert.rejects(api.subscribeConversation('a', () => {}, { after: -1 }), { code: 'invalid_input' });
  assert.equal(signals.length, 3);
});

test('conversation rejects invalid UTF8, unexpected metadata, and consumer errors without silent retries', async () => {
  for (const body of [new Uint8Array([0xff, 10, 10]), changeFrame(change(1, { text: 'must not carry content' }))]) {
    const api = await isolatedApi(async () => sse(body));
    await assert.rejects(api.subscribeConversation('会话/a', () => {}), { code: 'invalid_event' });
  }
  const api = await isolatedApi(async () => sse(changeFrame(change(1))));
  await assert.rejects(api.subscribeConversation('会话/a', () => { throw new Error('consumer failed'); }), /consumer failed/);
});

test('conversation EOF inside a UTF8 code point replays the incomplete frame from last acknowledged watermark', async () => {
  const controller = new AbortController(); const cursors = []; const received = [];
  const api = await isolatedApi(async path => {
    cursors.push(Number(new URL(path, 'http://test').searchParams.get('after')));
    if (cursors.length === 1) {
      const prefix = new TextEncoder().encode('event: conversation.changed\nid: 8\ndata: {"version":1,"conversationId":"会');
      const acknowledged = new TextEncoder().encode(changeFrame(change(4)));
      const bytes = new Uint8Array(acknowledged.length + prefix.length - 1);
      bytes.set(acknowledged); bytes.set(prefix.slice(0, -1), acknowledged.length);
      return sse(bytes);
    }
    return sse(changeFrame(change(8)));
  });
  await api.subscribeConversation('会话/a', value => {
    received.push(value.sequence);
    if (value.sequence === 8) controller.abort();
  }, { signal: controller.signal });
  assert.deepEqual(cursors, [0, 4]);
  assert.deepEqual(received, [4, 8]);
});
