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
