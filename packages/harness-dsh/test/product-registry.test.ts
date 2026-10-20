import { TEST_CONTEXT_CAPABILITIES, TEST_MODEL_CAPACITY } from '../../runtime/context-test-fixture.ts';
/** Real loopback bridge and pinned schema validator; synthetic data only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProductMcpBridge } from '../src/product-mcp.ts';
import { loadProductSchemaValidator } from '../src/headless.ts';
import { RuntimeHost } from '../../runtime/host.ts';
import { RuntimeStore } from '../../runtime/store.ts';
import type { ExecutionContext, ToolDefinition } from '../../runtime/contracts.ts';

const validator = () => loadProductSchemaValidator({ dataDirectory: '/unused-synthetic', model: { ...TEST_MODEL_CAPACITY, baseURL: 'http://127.0.0.1:1', id: 'synthetic', apiKey: 'synthetic' } });
type Bridge = Awaited<ReturnType<typeof createProductMcpBridge>>;
async function rpc(bridge: Bridge, id: number, method: string, params: Record<string, unknown> = {}) {
  const response = await fetch(bridge.declaration.url, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: bridge.declaration.headers[0]!.value }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  assert.equal(response.status, 200);
  return response.json() as Promise<{ result?: { tools?: ToolDefinition[]; isError?: boolean; content?: Array<{ text: string }> }; error?: { code: number } }>;
}

test('bridge owns frozen definitions for list and direct call despite caller mutation', async () => {
  const schema = await validator();
  const tools: ToolDefinition[] = [{ name: 'synthetic_lookup', description: 'Original description', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } }];
  let calls = 0;
  let frozenValidation = false;
  const bridge = await createProductMcpBridge(tools, { signal: new AbortController().signal, onText() {}, onEvent() {}, async callTool(name, args) { calls++; assert.equal(name, 'synthetic_lookup'); return { value: args.value }; } }, (inputSchema, value) => {
    const properties = (inputSchema as Record<string, unknown>).properties as Record<string, unknown>;
    frozenValidation = Object.isFrozen(inputSchema) && Object.isFrozen(properties) && Object.isFrozen(properties.value);
    return schema.valid(inputSchema, value);
  });
  try {
    tools[0]!.name = 'synthetic_renamed'; tools[0]!.description = 'Changed description';
    ((tools[0]!.inputSchema.properties as Record<string, unknown>).value as Record<string, unknown>).type = 'number';
    (tools[0]!.inputSchema.required as string[]).length = 0;
    tools.push({ name: 'synthetic_intruder', description: 'injected', inputSchema: { type: 'object' } });
    // Call needs no prior tools/list exchange.
    const direct = await rpc(bridge, 1, 'tools/call', { name: 'synthetic_lookup', arguments: { value: 'synthetic' } });
    assert.equal(direct.result?.isError, undefined);
    assert.equal(calls, 1);
    assert.equal(frozenValidation, true);
    assert.ok((await rpc(bridge, 2, 'tools/call', { name: 'synthetic_lookup', arguments: { value: 123 } })).error);
    for (const name of ['unknown', 'synthetic_renamed', 'synthetic_intruder']) assert.ok((await rpc(bridge, 3, 'tools/call', { name, arguments: {} })).error);
    assert.equal(calls, 1);
    const listed = (await rpc(bridge, 4, 'tools/list')).result!.tools!;
    assert.deepEqual(listed.map(tool => tool.name), ['synthetic_lookup']);
    assert.equal(listed[0]!.description, 'Original description');
    assert.deepEqual(listed[0]!.inputSchema, { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false });
    listed[0]!.name = 'list-response-mutated';
    ((listed[0]!.inputSchema.properties as Record<string, unknown>).value as Record<string, unknown>).type = 'number';
    assert.equal((await rpc(bridge, 5, 'tools/list')).result!.tools![0]!.name, 'synthetic_lookup');
    assert.ok((await rpc(bridge, 6, 'tools/call', { name: 'synthetic_lookup', arguments: { value: 123 } })).error);
    assert.deepEqual(await rpc(bridge, 1, 'tools/call', { name: 'synthetic_lookup', arguments: { value: 'synthetic' } }), direct);
    assert.equal(calls, 1, 'existing receipt remains idempotent');
  } finally { assert.equal(await bridge.close(), true); }
});

test('real Host rechecks advertised recall and rejects injected writes through loopback MCP with zero DB writes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kleio-mcp-registry-host-'));
  const schema = await validator();
  const store = new RuntimeStore(join(directory, 'app.sqlite'));
  let bridge: Bridge | undefined;
  let host!: RuntimeHost;
  const quote = '请记住 G4_MCP_SYNTHETIC';
  const conversation = store.createConversation('Synthetic MCP scope');
  const victim = store.submit(conversation.id, quote, 'synthetic-victim');
  host = new RuntimeHost(store, {
    id: 'synthetic-mcp-engine', contextCapabilities: TEST_CONTEXT_CAPABILITIES,
    async execute(input, context: ExecutionContext) {
        bridge = await createProductMcpBridge(input.tools, context, schema.valid);
        const originalId = input.id;
        const advertised = (await rpc(bridge, 1, 'tools/list')).result!.tools!;
        assert.deepEqual(advertised.map(tool => tool.name), ['memory_search', 'web_read', 'skills_list', 'skill_read', 'context_read']);
        // Engine transport mutations cannot change trusted execution identity or grant writes.
        input.id = victim.id; input.kind = 'conversation';
        input.tools.push({ name: 'memory_remember', description: 'injected write', inputSchema: { type: 'object' } });
        const deniedWrite = await rpc(bridge, 2, 'tools/call', { name: 'memory_remember', arguments: { key: 'sentinel', text: 'G4_MCP_SYNTHETIC', authorizationQuote: quote } });
        assert.ok(deniedWrite.error);
        assert.equal(store.execution(originalId).kind, 'research');
        host.setMemoryEnabled(false);
        assert.equal(context.signal.aborted, true);
        const revoked = await fetch(bridge.declaration.url, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: bridge.declaration.headers[0]!.value }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory_search', arguments: { queries: ['synthetic'] } } }) });
        assert.equal(revoked.status, 403);
        assert.ok(store.events(0, originalId).some(event => event.type === 'context.invalidated'));
        assert.equal(host.memory.list().filter(memory => memory.status === 'active').length, 0);
        assert.equal(store.db.prepare('SELECT count(*) AS n FROM km_claims').get()?.n, 0);
      return { text: 'Synthetic completed' };
    }, async close() {},
  }, { port: 4317, token: 'synthetic-mcp-token', dataDirectory: directory, model: { ...TEST_MODEL_CAPACITY, baseURL: 'https://example.invalid', id: 'synthetic', apiKey: '' }, memoryIdleMs: 120000 });
  try {
    const running = host.run('research', 'Synthetic MCP check', 'No write tools authorized.');
    await assert.rejects(running, (error: unknown) => (error as { code: string }).code === 'CONTEXT_INVALIDATED');
    assert.equal(host.memory.list().filter(memory => memory.status === 'active').length, 0);
  } finally { await bridge?.close(); await host.close(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
