import { TEST_CONTEXT_CAPABILITIES, TEST_MODEL_CAPACITY } from '../../runtime/context-test-fixture.ts';
/** Keyless regression checks use the installed pinned runtime and local model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createDshEngine } from '../../engines/dsh.ts';
import { RuntimeHost } from '../../runtime/host.ts';
import { RuntimeStore } from '../../runtime/store.ts';
import { RuntimeError, type ExecutionInput } from '../../runtime/contracts.ts';
import { loadProductSchemaValidator } from '../src/headless.ts';

const installed = existsSync(fileURLToPath(new URL('../.runtime/node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url)));
const modelOptions = { ...TEST_MODEL_CAPACITY, baseURL: 'http://127.0.0.1:1/v1', id: 'local-model', apiKey: 'local-placeholder' };
function completionSignal() {
  let resolve!: (input: ExecutionInput) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<ExecutionInput>((resolveInput, rejectInput) => { resolve = resolveInput; reject = rejectInput; });
  return { promise, resolve, reject };
}

test('actual conversation tools prepare and reach the pinned ACP model with memory on and off', { timeout: 60_000, skip: !installed }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kleio-product-schemas-'));
  const advertised: string[][] = [];
  const model = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    advertised.push(body.tools.map((tool: { function: { name: string } }) => tool.function.name));
    response.setHeader('content-type', 'text/event-stream');
    response.end(`data: ${JSON.stringify({ id: 'local-request', object: 'chat.completion.chunk', model: 'local-model', created: 1, choices: [{ index: 0, delta: { role: 'assistant', content: 'LOCAL_COMPLETED' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const address = model.address(); assert(address && typeof address !== 'string');
  const options = { dataDirectory: directory, model: { ...modelOptions, baseURL: `http://127.0.0.1:${address.port}/v1` }, promptTimeoutMs: 20_000 };
  const schema = await loadProductSchemaValidator(options);
  const engine = createDshEngine(options);
  const store = new RuntimeStore(':memory:');
  let completion = completionSignal();
  const host = new RuntimeHost(store, {
    id: engine.id, contextCapabilities: TEST_CONTEXT_CAPABILITIES,
    async execute(input, context) {
      try {
        for (const tool of input.tools) schema.assertSchema(tool.inputSchema);
        const result = await engine.execute(input, context);
        completion.resolve(input); return result;
      } catch (error) { completion.reject(error); throw error; }
    },
    close: () => engine.close(),
  }, { port: 4317, token: 'local-placeholder-token-24', dataDirectory: directory, model: options.model, memoryIdleMs: 120_000 });
  try {
    for (const enabled of [true, false]) {
      completion = completionSignal();
      host.setMemoryEnabled(enabled);
      const conversation = store.createConversation();
      const execution = host.submit(conversation.id, 'Complete this local check.', `schema-check-${enabled}`);
      const input = await completion.promise;
      await delay(0);
      assert.equal(store.execution(execution.id).status, 'completed');
      assert.equal(store.execution(execution.id).text, 'LOCAL_COMPLETED');
      assert.equal(input.tools.some(tool => tool.name === 'memory_search'), enabled);
      assert.deepEqual(advertised.at(-1), input.tools.map(tool => `mcp__kleio__${tool.name}`).sort());
      const search = input.tools.find(tool => tool.name === 'web_search'); assert(search);
      assert(schema.valid(search.inputSchema, { query: 'public evidence', maxResults: 3 }));
      assert(!schema.valid(search.inputSchema, { query: 'public evidence', maxResults: 4 }));
      assert(!schema.valid(search.inputSchema, { query: 1 }));
    }
    assert.equal(advertised.length, 2);
    assert.deepEqual(await readdir(join(directory, 'executions')), []);
  } finally {
    await host.close(); store.close(); model.closeAllConnections();
    await new Promise<void>(resolve => model.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('unsupported tool schemas fail before dispatch with safe actionable diagnostics and cleanup', { skip: !installed }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kleio-schema-failure-'));
  const engine = createDshEngine({ dataDirectory: directory, model: modelOptions });
  const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
  let calls = 0; let text = '';
  const input: ExecutionInput = { id: 'unsupported-schema', kind: 'conversation', prompt: 'Local check.', context: '', history: [], tools: [{
    name: 'web_search', description: 'Local check.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 1000 } }, examples: [{ query: 'PRIVATE_SCHEMA_MARKER' }] },
  }] };
  try {
    await assert.rejects(engine.execute(input, {
      signal: new AbortController().signal, onText(delta) { text += delta; },
      onEvent(event) { events.push(event); }, async callTool() { calls += 1; return {}; },
    }), error => {
      assert(error instanceof RuntimeError);
      assert.equal(error.code, 'ENGINE_TOOL_SCHEMA');
      assert.match(error.message, /web_search.*before model dispatch/);
      assert.match(error.message, /pinned DSH runtime/);
      assert.doesNotMatch(error.message, /PRIVATE_SCHEMA_MARKER|maxLength|127\.0\.0\.1|local-placeholder/);
      return true;
    });
    assert.deepEqual(events, [{ type: 'engine.error', data: { phase: 'prepare', category: 'tool-schema', productTool: 'web_search' } }]);
    assert.equal(calls, 0); assert.equal(text, '');
    assert.deepEqual(await readdir(join(directory, 'executions')), []);
  } finally { await engine.close(); await rm(directory, { recursive: true, force: true }); }
});
