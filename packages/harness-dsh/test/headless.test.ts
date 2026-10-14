/** Keyless checks against the real pinned ACP process and a local scripted model. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDshEngine } from '../../engines/dsh.ts';
import { createProductMcpBridge } from '../src/product-mcp.ts';
import { RuntimeError, type ExecutionInput } from '../../runtime/contracts.ts';

test('real ACP uses fresh contexts, only product tools, and confirmed cancellation', { timeout: 120_000 }, async t => {
  if (!existsSync(fileURLToPath(new URL('../.runtime/node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url)))) return t.skip('The optional pinned runtime is not installed.');
  const directory = await mkdtemp(join(tmpdir(), 'kleio-headless-'));
  const requests: Array<{ messages: Array<{ role: string; content: unknown }>; tools?: Array<{ function: { name: string } }> }> = [];
  let cancelReady!: () => void;
  const held = new Promise<void>(resolve => { cancelReady = resolve; });
  const model = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    const material = JSON.stringify(body.messages);
    res.setHeader('content-type', 'text/event-stream');
    if (material.includes('HOLD_EXECUTION')) { res.flushHeaders(); cancelReady(); return; }
    if (material.includes('TIMEOUT_EXECUTION')) { res.flushHeaders(); return; }
    const previousTool = body.messages.some((message: { role: string }) => message.role === 'tool');
    const useTool = material.includes('USE_PRODUCT_TOOL') && !previousTool;
    const unauthorized = material.includes('ATTEMPT_FOREIGN_TOOL') && !previousTool;
    const tool = unauthorized ? { name: 'bash', arguments: '{"command":"should-not-execute"}' }
      : { name: 'mcp__kleio__memory_search', arguments: '{"query":"stored background"}' };
    const frame = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: 'local-request', object: 'chat.completion.chunk', model: 'local-model', created: 1, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.write(frame({ role: 'assistant', content: '' }));
    if (useTool || unauthorized) res.write(frame({ tool_calls: [{ index: 0, id: 'local-tool-call', type: 'function', function: tool }] }));
    else res.write(frame({ content: 'LOCAL_COMPLETED' }));
    res.write(frame({}, useTool || unauthorized ? 'tool_calls' : 'stop'));
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const address = model.address();
  assert(address && typeof address !== 'string');
  const engine = createDshEngine({ dataDirectory: directory, model: { baseURL: `http://127.0.0.1:${address.port}/v1`, id: 'local-model', apiKey: 'local-placeholder' }, promptTimeoutMs: 20_000 });
  const calls: string[] = [];
  const events: Array<{ type: string }> = [];
  const input = (prompt: string, context: string): ExecutionInput => ({ id: prompt, kind: 'conversation', prompt, context, history: [{ role: 'user', content: 'EARLIER_USER' }, { role: 'assistant', content: 'EARLIER_ASSISTANT' }],
    tools: [{ name: 'memory_search', description: 'Search product-owned memory.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }] });
  const context = (signal = new AbortController().signal) => ({ signal, onText() {}, onEvent(event: { type: string }) { events.push(event); }, async callTool(name: string, args: Record<string, unknown>) { calls.push(name); assert.equal(args.query, 'stored background'); return { found: true }; } });
  try {
    const first = await engine.execute(input('USE_PRODUCT_TOOL', 'FIRST_CONTEXT'), context());
    assert.equal(first.text, 'LOCAL_COMPLETED');
    assert.deepEqual(calls, ['memory_search']);
    assert(events.some(event => event.type === 'engine.tool'));
    const boundary = requests.length;
    const second = await engine.execute(input('SECOND_EXECUTION', 'SECOND_CONTEXT'), context());
    assert.equal(second.text, 'LOCAL_COMPLETED');
    assert.notEqual(first.engineSessionId, second.engineSessionId);
    assert(JSON.stringify(requests[boundary]!.messages).includes('SECOND_CONTEXT'));
    assert(!JSON.stringify(requests[boundary]!.messages).includes('FIRST_CONTEXT'));
    assert(JSON.stringify(requests[0]!.messages).includes('EARLIER_USER'));
    assert(JSON.stringify(requests[0]!.messages).includes('EARLIER_ASSISTANT'));
    await engine.execute(input('ATTEMPT_FOREIGN_TOOL', ''), context());
    assert.deepEqual(calls, ['memory_search']);
    const foreignResult = requests.findLast(request => JSON.stringify(request.messages).includes('ATTEMPT_FOREIGN_TOOL'))?.messages.filter(message => message.role === 'tool');
    assert.match(JSON.stringify(foreignResult), /unknown tool|not.*found|not.*available|outside.*capability/i);
    for (const request of requests) assert.deepEqual(request.tools?.map(tool => tool.function.name) ?? [], ['mcp__kleio__memory_search']);
    const withoutTools = requests.length;
    await engine.execute({ ...input('NO_TOOLS_EXECUTION', ''), tools: [] }, context());
    assert.deepEqual(requests[withoutTools]!.tools ?? [], []);
    const abort = new AbortController();
    const cancelling = engine.execute(input('HOLD_EXECUTION', ''), context(abort.signal));
    const rejection = assert.rejects(cancelling, error => error instanceof RuntimeError && error.code === 'ENGINE_CANCELLED');
    await held; abort.abort(); await rejection;
    const timed = createDshEngine({ dataDirectory: directory, model: { baseURL: `http://127.0.0.1:${address.port}/v1`, id: 'local-model', apiKey: 'local-placeholder' }, promptTimeoutMs: 250 });
    try { await assert.rejects(timed.execute(input('TIMEOUT_EXECUTION', ''), context()), error => error instanceof RuntimeError && error.code === 'ENGINE_OUTCOME_UNKNOWN'); }
    finally { await timed.close(); }
    assert.deepEqual(await readdir(join(directory, 'executions')), []);
  } finally {
    await engine.close(); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('MCP bridge authenticates, validates capabilities, deduplicates receipts, and revokes', async () => {
  const abort = new AbortController();
  let calls = 0;
  const bridge = await createProductMcpBridge([{ name: 'lookup', description: 'Read product data.', inputSchema: { type: 'object' } }], {
    signal: abort.signal, onText() {}, onEvent() {}, async callTool() { calls += 1; return { ok: true }; },
  }, (_schema, args) => typeof (args as Record<string, unknown>).query === 'string');
  const request = async (id: number, name: string, args: unknown, authorized = true, origin?: string) => {
    const response = await fetch(bridge.declaration.url, { method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { Authorization: bridge.declaration.headers[0]!.value } : {}), ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) });
    return { status: response.status, body: response.status === 200 ? await response.json() : undefined };
  };
  try {
    assert.equal((await request(1, 'lookup', { query: 'same' }, false)).status, 403);
    assert.equal((await request(1, 'lookup', { query: 'same' }, true, 'https://untrusted.invalid')).status, 403);
    assert((await request(1, 'foreign', { query: 'same' })).body.error);
    assert((await request(1, 'lookup', { query: 1 })).body.error);
    const first = await request(2, 'lookup', { query: 'same' });
    assert.deepEqual((await request(2, 'lookup', { query: 'same' })).body, first.body);
    assert((await request(2, 'lookup', { query: 'different' })).body.error);
    assert.equal(calls, 1);
    abort.abort();
    assert.equal((await request(3, 'lookup', { query: 'same' })).status, 403);
    assert.equal(calls, 1);
  } finally { assert.equal(await bridge.close(), true); }
});
