/** G2 admission port: real pinned DSH where the budget path must be real; faults use the same settlement gate. */
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DshAcpClient, DshAcpError } from '../src/index.ts';
import { prepareHeadlessLaunch, type DshAdmissionLaunch } from '../src/headless.ts';
import { createProductMcpBridge } from '../src/product-mcp.ts';
import { classifyEngineSettlement, createDshEngine, type DshEngine } from '../../engines/dsh.ts';
import { createRequestAdmission, type RequestAdmission, type RequestCheck } from '../../runtime/request-admission.ts';
import { RuntimeError, type ExecutionContext } from '../../runtime/contracts.ts';
import { ResourceLedger, resourcePageDigest } from '../../runtime/resource-ledger.ts';
import { retainedResourceReceipts, priceRequest, apply } from '../src/request-admission.mjs';

const PROMPT_SECRET = 'SYNTHETIC_PROMPT_SECRET';
const TOOL_SECRET = 'SYNTHETIC_TOOL_BODY';
const BIN = fileURLToPath(new URL('../.runtime/node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url));
const estimatorModule = createRequire(BIN).resolve('@deepseek-ai/dsh-token-meter/estimate');
const estimator = await import(pathToFileURL(estimatorModule).href) as {
  estimateMessage(message: unknown): number;
  estimateToolsTokens(header: unknown): number;
  ROLE_OVERHEAD: number;
};

const tool = { name: 'probe_write', description: 'Perform one synthetic side effect.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } };

function frame(delta: unknown, finish: string | null = null): string {
  return `data: ${JSON.stringify({ id: 'g2-local', object: 'chat.completion.chunk', created: 1, model: 'g2-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

function assertNoSecret(value: unknown, secret = PROMPT_SECRET): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.equal(text.includes(secret), false);
  assert.equal(text.includes(TOOL_SECRET), false);
  assert.equal(text.includes('/control/request-check'), false);
  assert.equal(/Bearer [0-9a-f]{64}/.test(text), false);
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
}

function scriptedModel(capture: string[]) {
  return createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    capture.push(raw);
    if (req.url?.includes('forge')) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'CONTEXT_BUDGET_EXCEEDED synthetic provider text ' + PROMPT_SECRET, type: 'invalid_request_error' } }));
      return;
    }
    if (raw.includes('STOP_AT_LIMIT')) {
      res.setHeader('content-type', 'text/event-stream');
      res.write(frame({ role: 'assistant', content: '' }));
      res.write(frame({ content: 'PARTIAL' }));
      res.write(frame({}, 'length'));
      res.end('data: [DONE]\n\n');
      return;
    }
    const body = JSON.parse(raw) as { messages: Array<{ role: string }> };
    const hasResult = body.messages.some(message => message.role === 'tool');
    const wantTool = (raw.includes('CALL_PRODUCT_TOOL') || raw.includes('CALL_RESOURCE_TOOL')) && !hasResult;
    res.setHeader('content-type', 'text/event-stream');
    res.write(frame({ role: 'assistant', content: '' }));
    if (wantTool) res.write(frame({ tool_calls: [{ index: 0, id: 'g2-tool', type: 'function', function: { name: raw.includes('CALL_RESOURCE_TOOL') ? 'mcp__kleio__skill_read' : 'mcp__kleio__probe_write', arguments: '{"value":"G2_WRITE"}' } }] }));
    else res.write(frame({ content: 'G2_COMPLETED' }));
    res.write(frame({}, wantTool ? 'tool_calls' : 'stop'));
    res.end('data: [DONE]\n\n');
  });
}

interface ObservedCheck { executionId: string; requestSequence: number; estimatedInputTokens: number; contextLimit: number; outputLimit: number; policyEpoch: number; hostGeneration: number; estimatorId: string; retainedResourceReceipts: unknown[] }

function observe(admission: RequestAdmission): { port: RequestAdmission; checks: ObservedCheck[]; decisions: string[] } {
  const checks: ObservedCheck[] = [];
  const decisions: string[] = [];
  return { checks, decisions, port: {
    binding: admission.binding, profile: admission.profile, denialReceipt: () => admission.denialReceipt(),
    check(input: unknown) { checks.push(input as ObservedCheck); const decision = admission.check(input); decisions.push(decision.kind); return decision; },
  } };
}

async function withServer(run: (env: { directory: string; port: number; requests: string[]; closeEngine: (engine: DshEngine) => void }) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'kleio-g2-'));
  const requests: string[] = [];
  const server = scriptedModel(requests);
  const engines = new Set<DshEngine>();
  const port = await listen(server);
  try { await run({ directory, port, requests, closeEngine: engine => { engines.add(engine); } }); }
  finally {
    await Promise.allSettled([...engines].map(engine => engine.close()));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}

function readPatch(directory: string): string {
  const root = join(directory, 'executions');
  if (!existsSync(root)) return '';
  const texts: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name, 'execution.patch.json');
    if (existsSync(path)) texts.push(readFileSync(path, 'utf8'));
  }
  return texts.at(-1) ?? '';
}

function productCheck(over: Partial<RequestCheck> = {}): RequestCheck {
  return {
    executionId: 'exec-http', hostGeneration: 2, requestSequence: 1, policyEpoch: 1, profileVersion: 'http',
    contextLimit: 100, outputLimit: 20, estimatedInputTokens: 10, estimatorId: 'dsh-token-meter/estimate@0.2.1-alpha.2',
    retainedResourceReceipts: [], ...over,
  };
}

describe('request admission profile and plugin', () => {
  test('explicit admission closes native compaction and pruner together; the legacy profile stays unchanged', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kleio-g2-profile-'));
    try {
      const legacy = await prepareHeadlessLaunch({ dataDirectory: directory, model: { baseURL: 'http://127.0.0.1:9/v1', id: 'g2-model', apiKey: 'synthetic-local-key' } }, join(directory, 'legacy'), ['probe_write']);
      const legacyPatch = JSON.parse(await readFile(legacy.args!.at(-1)!, 'utf8')) as Array<Record<string, unknown>>;
      assert.equal(legacyPatch.some(row => row.id === 'compaction-basic' || row.id === 'tool-result-pruner' || row.id === 'kleio-request-admission'), false);
      assert.equal(JSON.stringify(legacyPatch).includes('"contextWindow":128000'), true);
      assert.equal(JSON.stringify(legacyPatch).includes('"maxTokens":8192'), true);
      const explicit = await prepareHeadlessLaunch({ dataDirectory: directory, model: { baseURL: 'http://127.0.0.1:9/v1', id: 'g2-model', apiKey: 'synthetic-local-key', contextWindow: 32768, maxTokens: 2048 } }, join(directory, 'explicit'), ['probe_write']);
      const explicitText = await readFile(explicit.args!.at(-1)!, 'utf8');
      assert.equal(explicitText.includes('kleio-request-admission'), false);
      assert.equal(explicitText.includes('"id":"compaction-basic"'), false);
      const admission: DshAdmissionLaunch = {
        controlUrl: 'http://127.0.0.1:9/control/request-check', authorization: `Bearer ${'ab'.repeat(32)}`, executionId: 'exec-profile',
        hostGeneration: 1, policyEpoch: 2, profileVersion: 'bounded', contextLimit: 4000, outputLimit: 256, timeoutMs: 2000,
      };
      const bounded = await prepareHeadlessLaunch({ dataDirectory: directory, model: { baseURL: 'http://127.0.0.1:9/v1', id: 'g2-model', apiKey: 'synthetic-local-key', contextWindow: 4000, maxTokens: 256 } }, join(directory, 'bounded'), ['probe_write'], admission);
      const patchPath = bounded.args!.at(-1)!;
      assert.equal((await stat(patchPath)).mode & 0o777, 0o600);
      const patch = JSON.parse(await readFile(patchPath, 'utf8')) as Array<{ id?: string; disabled?: boolean; insert?: Array<{ id?: string; config?: Record<string, unknown> }>; config?: { providers?: Record<string, { models?: Array<{ contextWindow?: number; maxTokens?: number }> }> } }>;
      assert.equal(patch.filter(row => row.id === 'compaction-basic' && row.disabled === true).length, 1);
      assert.equal(patch.filter(row => row.id === 'tool-result-pruner' && row.disabled === true).length, 1);
      assert.equal(patch.some(row => row.id === 'token-meter' && row.disabled === true), false);
      const plugin = patch.flatMap(row => row.insert ?? []).find(row => row.id === 'kleio-request-admission');
      assert.equal(plugin?.config?.estimatorModule, estimatorModule);
      assert.equal(plugin?.config?.estimatorId, 'dsh-token-meter/estimate@0.2.1-alpha.2');
      assert.equal(plugin?.config?.timeoutMs, 2000);
      assert.equal(plugin?.config?.contextLimit, 4000);
      const model = patch.find(row => row.id === 'llm-pi-ai')?.config?.providers?.['kleio-model']?.models?.[0];
      assert.deepEqual(model && { contextWindow: model.contextWindow, maxTokens: model.maxTokens }, { contextWindow: 4000, maxTokens: 256 });
      assert.equal(Object.values(bounded.env ?? {}).some(value => value?.includes(admission.authorization)), false);
      const packageJson = await readFile(join(directory, 'bounded/home/profiles/kleio-execution/package.json'), 'utf8');
      assert.equal(packageJson.includes('Bearer'), false);
      await assert.rejects(() => prepareHeadlessLaunch({ dataDirectory: directory, model: { baseURL: 'http://127.0.0.1:9/v1', id: 'g2-model', apiKey: 'synthetic-local-key' } }, join(directory, 'missing'), [], admission), /Invalid model capacity/);
      await assert.rejects(() => prepareHeadlessLaunch({ dataDirectory: directory, model: { baseURL: 'http://127.0.0.1:9/v1', id: 'g2-model', apiKey: 'synthetic-local-key', contextWindow: 8000, maxTokens: 256 } }, join(directory, 'mismatch'), [], admission), /Invalid model capacity/);
      assert.equal(existsSync(join(directory, 'missing')), false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  test('pricing keeps pinned framing, counts tool calls and results, and refuses unpriced blocks without structural fallback', () => {
    const messages = Object.freeze([Object.freeze({ role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text: 'hello' })]) })]);
    const before = JSON.stringify(messages);
    const priced = priceRequest(messages, [{ name: 'probe_write', description: 'd', parameters: { type: 'object' } }], undefined, estimator);
    assert.equal(JSON.stringify(messages), before);
    assert.equal(priced, estimator.estimateMessage(messages[0]) + estimator.estimateToolsTokens({ tools: [{ name: 'probe_write', description: 'd', parameters: { type: 'object' } }] }));
    assert.ok(priced > Math.ceil('hello'.length / 4));
    const withTool = [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'probe_write', arguments: '{"value":"G2"}' }] },
      { role: 'tool', content: [{ type: 'text', text: 'Q'.repeat(4000) }], toolCallId: 'c1' },
    ];
    const rich = priceRequest(withTool, undefined, 'system text', estimator);
    const plain = priceRequest([{ role: 'user', content: [{ type: 'text', text: 'Q' }] }], undefined, undefined, estimator);
    assert.ok(rich - plain > 900);
    let calls = 0;
    const stub = { estimateMessage() { calls += 1; return 1; }, estimateToolsTokens() { calls += 1; return 1; } };
    for (const block of [{ type: 'image', attachment: { id: 'img' } }, { type: 'file', attachment: { id: 'file' } }, { type: 'audio', data: 'x' }]) {
      calls = 0;
      assert.throws(() => priceRequest([{ role: 'user', content: [block] }], undefined, undefined, stub), /Request admission stopped/);
      assert.equal(calls, 0);
    }
  });

  test('the pre-send plugin asks once, ignores a bad allow, and stops before an image or a cancelled signal', async () => {
    let hits = 0;
    let lastBody = '';
    let spoil = false;
    const control = createServer(async (req, res) => {
      hits += 1;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      lastBody = Buffer.concat(chunks).toString('utf8');
      const request = JSON.parse(lastBody) as { requestSequence: number; policyEpoch: number; hostGeneration: number };
      const allow = { decision: 'allow', requestSequence: request.requestSequence, policyEpoch: request.policyEpoch, hostGeneration: request.hostGeneration };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(spoil ? { ...allow, leaked: req.headers.authorization } : allow));
    });
    const port = await listen(control);
    const authorization = `Bearer ${'cd'.repeat(32)}`;
    const config = {
      controlUrl: `http://127.0.0.1:${port}/control/request-check`, authorization, executionId: 'exec-plugin', hostGeneration: 1, policyEpoch: 1,
      profileVersion: 'plugin', contextLimit: 4000, outputLimit: 256, timeoutMs: 300, estimatorModule, estimatorId: 'dsh-token-meter/estimate@0.2.1-alpha.2',
    };
    let handler!: (options: Record<string, unknown>, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>;
    apply({ on(_name: string, fn: typeof handler) { handler = fn; } }, config);
    const run = async (messages: unknown[], signal?: AbortSignal) => {
      let nextCalls = 0;
      await assert.rejects(async () => {
        for await (const _chunk of handler({ messages, tools: [], signal }, async function* () { nextCalls += 1; })) { /* consume */ }
      }, (error: unknown) => error instanceof Error && error.message === 'Request admission stopped before the model call.' && !error.message.includes(authorization) && !error.message.includes(PROMPT_SECRET));
      assert.equal(nextCalls, 0);
    };
    const hanging = createServer(req => { hits += 1; req.resume(); });
    const hangPort = await listen(hanging);
    try {
      let nextCalls = 0;
      for await (const _chunk of handler({ messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT_SECRET }] }], tools: [], signal: AbortSignal.timeout(2000) }, async function* () { nextCalls += 1; })) { /* allow */ }
      assert.equal(nextCalls, 1);
      assert.equal(lastBody.includes(PROMPT_SECRET), false);
      assert.equal(lastBody.includes(authorization), false);
      assert.equal(hits, 1);
      await run([{ role: 'user', content: [{ type: 'image', attachment: { id: 'synthetic-image' } }] }]);
      const aborted = new AbortController(); aborted.abort();
      await run([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], aborted.signal);
      assert.equal(hits, 1);
      apply({ on(_name: string, fn: typeof handler) { handler = fn; } }, { ...config, controlUrl: `http://127.0.0.1:${hangPort}/control/request-check`, timeoutMs: 200 });
      const started = Date.now();
      await run([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]);
      assert.ok(Date.now() - started < 1500);
      assert.equal(hits, 2);
      apply({ on(_name: string, fn: typeof handler) { handler = fn; } }, config);
      spoil = true;
      await run([{ role: 'user', content: [{ type: 'text', text: PROMPT_SECRET }] }]);
      assert.equal(hits, 3);
      assert.equal(lastBody.includes(PROMPT_SECRET), false);
      assert.equal(lastBody.includes(authorization), false);
    } finally {
      hanging.closeAllConnections(); await new Promise<void>(resolve => hanging.close(() => resolve()));
      control.closeAllConnections(); await new Promise<void>(resolve => control.close(() => resolve()));
    }
  });
});

describe('private control HTTP', () => {
  test('authenticates the control post and keeps it out of the tool catalog', async () => {
    const epoch = { value: 1 };
    const admission = createRequestAdmission({
      executionId: 'exec-http', scopeId: 'scope-http', hostGeneration: 2, policyEpoch: 1,
      profile: { version: 'http', contextLimit: 100, outputLimit: 20, safetyMarginTokens: 5 }, readPolicyEpoch: () => epoch.value,
    });
    const abort = new AbortController();
    const bridge = await createProductMcpBridge([tool], {
      signal: abort.signal, onText() {}, onEvent() {}, async callTool() { return { ok: true }; },
    }, () => true, admission);
    const absent = await createProductMcpBridge([tool], {
      signal: new AbortController().signal, onText() {}, onEvent() {}, async callTool() { return { ok: true }; },
    }, () => true);
    const authorization = bridge.control?.authorization ?? '';
    const post = (url: string, body: unknown, headers: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { authorization, 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    try {
      assert.equal((await post(bridge.control!.url, productCheck(), { authorization: '' })).status, 403);
      assert.equal((await post(bridge.control!.url, productCheck(), { authorization: 'bearer ' + authorization.slice(7) })).status, 403);
      assert.equal((await post(bridge.control!.url, productCheck(), { Origin: 'https://untrusted.invalid' })).status, 403);
      assert.equal((await post(bridge.control!.url, productCheck(), { Origin: 'null' })).status, 403);
      assert.equal((await fetch(bridge.control!.url, { method: 'GET', headers: { authorization } })).status, 405);
      assert.equal((await post(bridge.control!.url.replace('/control/request-check', '/control/other'), productCheck())).status, 403);
      assert.equal((await post(absent.declaration.url.replace('/mcp', '/control/request-check'), productCheck(), { authorization: absent.declaration.headers[0]!.value })).status, 403);
      const listed = await post(bridge.declaration.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const catalog = await listed.json() as { result: { tools: Array<{ name: string }> } };
      assert.deepEqual(catalog.result.tools.map(item => item.name), ['probe_write']);
      assertNoSecret(catalog);
      assert.equal(JSON.stringify(catalog).includes('request-check'), false);
      const missing = await post(bridge.declaration.url, { jsonrpc: '2.0', id: 2, method: 'control/request-check' });
      assert.equal((await missing.json() as { error: { code: number } }).error.code, -32601);
      const badJson = await post(bridge.control!.url, `{"prompt":"${PROMPT_SECRET}"`);
      assert.equal(badJson.status, 400);
      assert.equal(await badJson.text(), '{"error":"request-check-rejected"}');
      const badSchema = await post(bridge.control!.url, { ...productCheck(), prompt: PROMPT_SECRET, safetyMarginTokens: 0 });
      assert.equal(badSchema.status, 400);
      assertNoSecret(await badSchema.text());
      assert.equal(admission.denialReceipt(), undefined);
      const huge = await post(bridge.control!.url, 'x'.repeat(256 * 1024 + 1));
      assert.equal(huge.status, 413);
      assert.equal(await huge.text(), '');
      const allowed = await post(bridge.control!.url, productCheck());
      assert.equal(allowed.status, 200);
      assert.deepEqual(await allowed.json(), { decision: 'allow', requestSequence: 1, policyEpoch: 1, hostGeneration: 2 });
      const forged = await post(bridge.control!.url, productCheck({ requestSequence: 2, policyEpoch: 9 }));
      assert.equal(forged.status, 400);
      assert.equal(admission.denialReceipt(), undefined);
      epoch.value = 4;
      const revoked = await post(bridge.control!.url, productCheck({ requestSequence: 2, estimatedInputTokens: 0 }));
      assert.equal(revoked.status, 409);
      const revokedBody = await revoked.text();
      assert.deepEqual(JSON.parse(revokedBody), { decision: 'deny', code: 'CONTEXT_INVALIDATED', requestSequence: 2, policyEpoch: 4, hostGeneration: 2 });
      assertNoSecret(revokedBody);
      const budget = createRequestAdmission({
        executionId: 'exec-http', scopeId: 'scope-http', hostGeneration: 2, policyEpoch: 1,
        profile: { version: 'http', contextLimit: 100, outputLimit: 20, safetyMarginTokens: 5 }, readPolicyEpoch: () => 1,
      });
      const budgetBridge = await createProductMcpBridge([], {
        signal: new AbortController().signal, onText() {}, onEvent() {}, async callTool() { return {}; },
      }, () => true, budget);
      const denied = await fetch(budgetBridge.control!.url, { method: 'POST', headers: { authorization: budgetBridge.control!.authorization, 'content-type': 'application/json' }, body: JSON.stringify(productCheck({ estimatedInputTokens: 90, estimatorId: 'SyntheticSecret1' })) });
      assert.equal(denied.status, 409);
      const deniedText = await denied.text();
      assert.equal(deniedText.includes('SyntheticSecret1'), false);
      assert.equal(deniedText.includes(budgetBridge.control!.authorization), false);
      assert.deepEqual(JSON.parse(deniedText), { decision: 'deny', code: 'CONTEXT_BUDGET_EXCEEDED', requestSequence: 1, policyEpoch: 1, hostGeneration: 2 });
      const stuck = await fetch(budgetBridge.control!.url, { method: 'POST', headers: { authorization: budgetBridge.control!.authorization, 'content-type': 'application/json' }, body: JSON.stringify(productCheck({ requestSequence: 2, estimatedInputTokens: 0 })) });
      assert.equal(stuck.status, 409);
      abort.abort();
      assert.equal((await post(bridge.control!.url, productCheck({ requestSequence: 3 }))).status, 403);
      assert.equal(await budgetBridge.close(), true);
      assert.equal(await absent.close(), true);
    } finally { assert.equal(await bridge.close(), true); }
  });
});

describe('trusted settlement gate', () => {
  test('budget classification requires the host receipt plus confirmed close, RPC failure, and settled tools', () => {
    const admission = createRequestAdmission({
      executionId: 'exec-settle', scopeId: 'scope-settle', hostGeneration: 1, policyEpoch: 1,
      profile: { version: 'settle', contextLimit: 50, outputLimit: 10, safetyMarginTokens: 0 }, readPolicyEpoch: () => 1,
    });
    const decision = admission.check(productCheck({ executionId: 'exec-settle', hostGeneration: 1, policyEpoch: 1, profileVersion: 'settle', contextLimit: 50, outputLimit: 10, estimatedInputTokens: 45 }));
    assert.equal(decision.kind, 'deny');
    const denial = admission.denialReceipt();
    assert.equal(denial?.code, 'CONTEXT_BUDGET_EXCEEDED');
    const base = { promptStarted: true, stopReason: undefined, signalAborted: false, toolsSettled: true, closeConfirmed: true, phase: 'prompt', denial, outputText: PROMPT_SECRET };
    const budget = classifyEngineSettlement({ ...base, outcome: new DshAcpError('provider said CONTEXT_BUDGET_EXCEEDED ' + PROMPT_SECRET, -32603) });
    assert.equal(budget.kind, 'error');
    if (budget.kind !== 'error') throw new Error('expected error');
    assert.equal(budget.error.code, 'CONTEXT_BUDGET_EXCEEDED');
    assert.equal(budget.error.message, '这次任务需要的资料超出了本轮容量，已停止继续处理。');
    assert.equal(budget.error.retryable, false);
    assert.equal(budget.error.status, 409);
    assert.equal(budget.error.requestSequence, 1);
    assert.equal(budget.error.estimatedInputTokens, 45);
    assert.deepEqual(budget.event, { type: 'engine.admission', data: { requestSequence: 1, code: 'CONTEXT_BUDGET_EXCEEDED' } });
    assertNoSecret(budget.error.message);
    for (const input of [
      { ...base, denial: undefined, outcome: new DshAcpError('CONTEXT_BUDGET_EXCEEDED', -32603) },
      { ...base, outcome: new DshAcpError('CONTEXT_BUDGET_EXCEEDED', 'REQUEST_TIMEOUT') },
      { ...base, outcome: new DshAcpError('CONTEXT_BUDGET_EXCEEDED', 'TRANSPORT_CLOSED') },
      { ...base, toolsSettled: false, outcome: new DshAcpError('CONTEXT_BUDGET_EXCEEDED', -32603) },
      { ...base, closeConfirmed: false, outcome: new DshAcpError('CONTEXT_BUDGET_EXCEEDED', -32603) },
      { ...base, signalAborted: true, outcome: new DshAcpError('CONTEXT_BUDGET_EXCEEDED', -32603) },
      { ...base, outcome: undefined, outputText: 'completed ' + PROMPT_SECRET, stopReason: 'end_turn' },
    ]) {
      const settled = classifyEngineSettlement(input);
      assert.equal(settled.kind, 'error');
      if (settled.kind === 'error') {
        assert.notEqual(settled.error.code, 'CONTEXT_BUDGET_EXCEEDED');
        assertNoSecret(settled.error.message);
      }
    }
    const invalidated = createRequestAdmission({
      executionId: 'exec-settle', scopeId: 'scope-settle', hostGeneration: 1, policyEpoch: 1,
      profile: { version: 'settle', contextLimit: 50, outputLimit: 10, safetyMarginTokens: 0 }, readPolicyEpoch: () => 2,
    });
    invalidated.check(productCheck({ executionId: 'exec-settle', hostGeneration: 1, policyEpoch: 1, profileVersion: 'settle', contextLimit: 50, outputLimit: 10 }));
    const invalid = invalidated.denialReceipt();
    const cancelled = classifyEngineSettlement({ ...base, denial: invalid, outcome: new DshAcpError('cancelled', -32603) });
    assert.equal(cancelled.kind, 'error');
    if (cancelled.kind === 'error') {
      assert.equal(cancelled.error.code, 'ENGINE_CANCELLED');
      assert.equal(cancelled.error.message, '执行使用的上下文策略已失效，本次处理已停止。已完成的效果仍保留。');
      assert.deepEqual(cancelled.event, { type: 'engine.admission', data: { requestSequence: 1, code: 'CONTEXT_INVALIDATED' } });
    }
    const unconfirmed = classifyEngineSettlement({ ...base, denial: invalid, outcome: new DshAcpError('timeout', 'REQUEST_TIMEOUT') });
    assert.equal(unconfirmed.kind, 'error');
    if (unconfirmed.kind === 'error') assert.equal(unconfirmed.error.code, 'ENGINE_OUTCOME_UNKNOWN');
  });

  test('close failure after dispatch stays unknown, including an earlier stop or cancel, without hiding pre-dispatch failures', () => {
    const stopped = new RuntimeError('ENGINE_STOPPED', 'The execution stopped before completion (max_tokens).', 502);
    const cancelled = new RuntimeError('ENGINE_CANCELLED', 'Execution settled after cancellation; completed effects are retained.', 409);
    const config = new RuntimeError('ENGINE_ADMISSION_CONFIG', 'Request admission configuration is incomplete.', 409);
    const schema = new RuntimeError('ENGINE_TOOL_SCHEMA', 'The execution engine rejected the schema for product tool "probe_write" before model dispatch.', 503);
    const budgetDenial = {
      executionId: 'exec-settle', scopeId: 'scope-settle', hostGeneration: 1, policyEpoch: 1, requestSequence: 1,
      code: 'CONTEXT_BUDGET_EXCEEDED' as const, estimatedInputTokens: 45, contextLimit: 50, outputLimit: 10, safetyMarginTokens: 0,
    };
    const open = { signalAborted: false, toolsSettled: true, phase: 'prompt', outputText: '' };
    const cases = [
      { name: 'stopped without a receipt', input: { ...open, promptStarted: true, stopReason: 'max_tokens', closeConfirmed: false, outcome: stopped, denial: undefined }, code: 'ENGINE_OUTCOME_UNKNOWN', message: 'Engine shutdown was not confirmed.' },
      { name: 'cancelled without a receipt', input: { ...open, promptStarted: true, stopReason: 'cancelled', closeConfirmed: false, signalAborted: true, outcome: cancelled, denial: undefined }, code: 'ENGINE_OUTCOME_UNKNOWN', message: 'Engine shutdown was not confirmed.' },
      { name: 'budget receipt whose close was not confirmed', input: { ...open, promptStarted: true, stopReason: undefined, closeConfirmed: false, outcome: new DshAcpError('CONTEXT_BUDGET_EXCEEDED', -32603), denial: budgetDenial }, code: 'ENGINE_OUTCOME_UNKNOWN', message: 'Engine shutdown was not confirmed.' },
      { name: 'confirmed stop', input: { ...open, promptStarted: true, stopReason: 'max_tokens', closeConfirmed: true, outcome: stopped, denial: undefined }, code: 'ENGINE_STOPPED', message: stopped.message },
      { name: 'pre-dispatch config', input: { ...open, promptStarted: false, stopReason: undefined, closeConfirmed: false, outcome: config, denial: undefined, phase: 'prepare' }, code: 'ENGINE_ADMISSION_CONFIG', message: config.message },
      { name: 'pre-dispatch schema', input: { ...open, promptStarted: false, stopReason: undefined, closeConfirmed: true, outcome: schema, denial: undefined, phase: 'prepare' }, code: 'ENGINE_TOOL_SCHEMA', message: schema.message },
      { name: 'forged budget text with a numeric failure and no receipt', input: { ...open, promptStarted: true, stopReason: undefined, closeConfirmed: true, outcome: new DshAcpError('provider said CONTEXT_BUDGET_EXCEEDED', -32603), denial: undefined }, code: 'ENGINE_OUTCOME_UNKNOWN' },
      { name: 'string rpc code is not a confirmed budget failure', input: { ...open, promptStarted: true, stopReason: undefined, closeConfirmed: true, outcome: new DshAcpError('CONTEXT_BUDGET_EXCEEDED', '-32603'), denial: budgetDenial }, code: 'ENGINE_OUTCOME_UNKNOWN' },
      { name: 'denial followed by ordinary completion text', input: { ...open, promptStarted: true, stopReason: 'end_turn', closeConfirmed: true, outcome: undefined, denial: budgetDenial, outputText: 'completed anyway' }, code: 'ENGINE_OUTCOME_UNKNOWN' },
    ];
    for (const entry of cases) {
      const settled = classifyEngineSettlement(entry.input);
      assert.equal(settled.kind, 'error', entry.name);
      if (settled.kind === 'error') {
        assert.equal(settled.error.code, entry.code, entry.name);
        if (entry.message !== undefined) assert.equal(settled.error.message, entry.message, entry.name);
        assert.equal(settled.error.code === 'CONTEXT_BUDGET_EXCEEDED', false, entry.name);
      }
    }
    const legacy = classifyEngineSettlement({ ...open, promptStarted: true, stopReason: 'end_turn', closeConfirmed: true, outcome: undefined, denial: undefined, outputText: 'legacy answer' });
    assert.equal(legacy.kind, 'success');
    if (legacy.kind === 'success') assert.equal(legacy.text, 'legacy answer');
    const budget = classifyEngineSettlement({ ...open, promptStarted: true, stopReason: undefined, closeConfirmed: true, outcome: new DshAcpError('internal', -32603), denial: budgetDenial });
    assert.equal(budget.kind, 'error');
    if (budget.kind === 'error') {
      assert.equal(budget.error.code, 'CONTEXT_BUDGET_EXCEEDED');
      assert.equal(budget.error.retryable, false);
      assert.equal(budget.error.requestSequence, 1);
      assert.equal(budget.error.estimatedInputTokens, 45);
    }
  });
});

describe('real pinned DSH admission', { concurrency: 1, timeout: 60_000 }, () => {
  test('a normal two-round execution passes the real estimator and keeps the tool result intact', async () => {
    await withServer(async ({ directory, port, requests, closeEngine }) => {
      const profile = { version: 'roomy', contextLimit: 200_000, outputLimit: 1024, safetyMarginTokens: 128 };
      const epoch = { value: 3 };
      const admission = createRequestAdmission({ executionId: 'exec-ok', scopeId: 'scope-ok', hostGeneration: 7, policyEpoch: 3, profile, readPolicyEpoch: () => epoch.value });
      const observed = observe(admission);
      const engine = createDshEngine({ dataDirectory: directory, model: { baseURL: `http://127.0.0.1:${port}/v1`, id: 'g2-model', apiKey: 'synthetic-local-key', contextWindow: profile.contextLimit, maxTokens: profile.outputLimit }, promptTimeoutMs: 20_000 });
      closeEngine(engine);
      const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
      let calls = 0;
      let patch = '';
      const marker = 'MIDDLE_SENTINEL';
      const body = `${'A'.repeat(9000)}${marker}${'B'.repeat(9000)}`;
      const result = await engine.execute({ id: 'exec-ok', kind: 'conversation', prompt: `${PROMPT_SECRET} CALL_PRODUCT_TOOL`, context: 'synthetic context', history: [], tools: [tool] }, {
        signal: new AbortController().signal, requestAdmission: observed.port, onText() {}, onEvent(event) { events.push(event); if (event.type === 'engine.session') patch = readPatch(directory); },
        async callTool(_name, args) { calls += 1; assert.deepEqual(args, { value: 'G2_WRITE' }); return { receipt: TOOL_SECRET, body }; },
      });
      assert.equal(result.text, 'G2_COMPLETED');
      assert.equal(calls, 1);
      assert.equal(requests.length, 2);
      assert.deepEqual(observed.decisions, ['allow', 'allow']);
      assert.deepEqual(observed.checks.map(item => item.requestSequence), [1, 2]);
      assert.equal(observed.checks[0]!.contextLimit, 200_000);
      const delta = observed.checks[1]!.estimatedInputTokens - observed.checks[0]!.estimatedInputTokens;
      assert.equal(delta > 4000 && delta < 7000, true);
      assert.equal(requests[1]!.includes(marker), true);
      assert.equal(requests[1]!.includes('A'.repeat(9000)), true);
      assert.equal(requests[1]!.includes(TOOL_SECRET), true);
      assert.equal(requests[0]!.includes(marker), false);
      for (const request of requests) {
        assert.equal(request.includes(PROMPT_SECRET), true);
        assert.equal(request.includes('/control/request-check'), false);
        assert.equal(/Bearer [0-9a-f]{64}/.test(request), false);
      }
      assertNoSecret(observed.checks);
      assertNoSecret(events.filter(event => event.type === 'engine.admission' || event.type === 'engine.error'));
      assert.match(patch, /"id":"compaction-basic","disabled":true/);
      assert.match(patch, /"id":"tool-result-pruner","disabled":true/);
      assert.equal(patch.includes('"id":"token-meter","disabled":true'), false);
      const bearer = /Bearer [0-9a-f]{64}/.exec(patch)?.[0] ?? '';
      assert.equal(bearer.length > 0, true);
      assert.equal(requests.some(request => request.includes(bearer)), false);
      assert.equal(events.some(event => JSON.stringify(event).includes(bearer)), false);
    });
  });

  test('the first real estimate is refused before any model or tool call when output reserve does not fit', async () => {
    await withServer(async ({ directory, port, requests, closeEngine }) => {
      const profile = { version: 'tight', contextLimit: 500, outputLimit: 200, safetyMarginTokens: 0 };
      const admission = createRequestAdmission({ executionId: 'exec-first', scopeId: 'scope-first', hostGeneration: 2, policyEpoch: 4, profile, readPolicyEpoch: () => 4 });
      const observed = observe(admission);
      const engine = createDshEngine({ dataDirectory: directory, model: { baseURL: `http://127.0.0.1:${port}/v1`, id: 'g2-model', apiKey: 'synthetic-local-key', contextWindow: 500, maxTokens: 200 }, promptTimeoutMs: 20_000 });
      closeEngine(engine);
      const events: Array<{ type: string }> = [];
      let calls = 0; let text = '';
      await assert.rejects(engine.execute({ id: 'exec-first', kind: 'conversation', prompt: `${PROMPT_SECRET} CALL_PRODUCT_TOOL`, context: '', history: [], tools: [tool] }, {
        signal: new AbortController().signal, requestAdmission: observed.port, onText(delta) { text += delta; }, onEvent(event) { events.push(event); }, async callTool() { calls += 1; return { receipt: TOOL_SECRET }; },
      }), (error: unknown) => {
        assert(error instanceof RuntimeError);
        assert.equal(error.code, 'CONTEXT_BUDGET_EXCEEDED');
        assert.equal(error.retryable, false);
        assert.equal(error.status, 409);
        assert.equal(error.requestSequence, 1);
        assert.equal(error.message, '这次任务需要的资料超出了本轮容量，已停止继续处理。');
        assert.equal((error.estimatedInputTokens ?? 0) < 500, true);
        assert.equal((error.estimatedInputTokens ?? 0) + 200 > 500, true);
        assertNoSecret(error.message);
        return true;
      });
      assert.equal(requests.length, 0);
      assert.equal(calls, 0);
      assert.equal(text, '');
      assert.deepEqual(observed.decisions, ['deny']);
      assert.equal(observed.checks.length, 1);
      assertNoSecret(observed.checks);
      assert.equal(events.some(event => event.type === 'engine.admission'), true);
      assertNoSecret(events);
      assert.equal(admission.check(productCheck({ executionId: 'exec-first', hostGeneration: 2, policyEpoch: 4, profileVersion: 'tight', contextLimit: 500, outputLimit: 200, requestSequence: 2, estimatedInputTokens: 0 })).kind, 'deny');
    });
  });

  test('a large tool result makes the second real estimate exceed capacity after exactly one call', async () => {
    await withServer(async ({ directory, port, requests, closeEngine }) => {
      const profile = { version: 'second', contextLimit: 4000, outputLimit: 256, safetyMarginTokens: 64 };
      const admission = createRequestAdmission({ executionId: 'exec-second', scopeId: 'scope-second', hostGeneration: 2, policyEpoch: 4, profile, readPolicyEpoch: () => 4 });
      const observed = observe(admission);
      const engine = createDshEngine({ dataDirectory: directory, model: { baseURL: `http://127.0.0.1:${port}/v1`, id: 'g2-model', apiKey: 'synthetic-local-key', contextWindow: 4000, maxTokens: 256 }, promptTimeoutMs: 20_000 });
      closeEngine(engine);
      let calls = 0;
      await assert.rejects(engine.execute({ id: 'exec-second', kind: 'conversation', prompt: `${PROMPT_SECRET} CALL_PRODUCT_TOOL`, context: '', history: [], tools: [tool] }, {
        signal: new AbortController().signal, requestAdmission: observed.port, onText() {}, onEvent() {},
        async callTool() { calls += 1; return { receipt: TOOL_SECRET, pad: 'Q'.repeat(24_000) }; },
      }), (error: unknown) => {
        assert(error instanceof RuntimeError);
        assert.equal(error.code, 'CONTEXT_BUDGET_EXCEEDED');
        assert.equal(error.requestSequence, 2);
        assert.equal(error.retryable, false);
        const delta = observed.checks[1]!.estimatedInputTokens - observed.checks[0]!.estimatedInputTokens;
        assert.equal(delta > 5000 && delta < 8000, true);
        assert.equal(observed.checks[0]!.estimatedInputTokens + profile.outputLimit + profile.safetyMarginTokens <= profile.contextLimit, true);
        assertNoSecret(error.message);
        return true;
      });
      assert.equal(requests.length, 1);
      assert.equal(calls, 1);
      assert.deepEqual(observed.decisions, ['allow', 'deny']);
      assert.equal(requests[0]!.includes('/control/request-check'), false);
      assertNoSecret(observed.checks);
    });
  });

  test('a changed host epoch cancels the next real request and a thrown policy read stays unknown', async () => {
    await withServer(async ({ directory, port, requests, closeEngine }) => {
      const profile = { version: 'epoch', contextLimit: 200_000, outputLimit: 1024, safetyMarginTokens: 32 };
      const epoch = { value: 4 };
      const admission = createRequestAdmission({ executionId: 'exec-epoch', scopeId: 'scope-epoch', hostGeneration: 2, policyEpoch: 4, profile, readPolicyEpoch: () => epoch.value });
      const engine = createDshEngine({ dataDirectory: directory, model: { baseURL: `http://127.0.0.1:${port}/v1`, id: 'g2-model', apiKey: 'synthetic-local-key', contextWindow: 200_000, maxTokens: 1024 }, promptTimeoutMs: 20_000 });
      closeEngine(engine);
      const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
      let calls = 0;
      await assert.rejects(engine.execute({ id: 'exec-epoch', kind: 'conversation', prompt: 'CALL_PRODUCT_TOOL', context: '', history: [], tools: [tool] }, {
        signal: new AbortController().signal, requestAdmission: admission, onText() {}, onEvent(event) { events.push(event); },
        async callTool() { calls += 1; epoch.value = 9; return { receipt: 'done' }; },
      }), (error: unknown) => error instanceof RuntimeError && error.code === 'ENGINE_CANCELLED' && error.message === '执行使用的上下文策略已失效，本次处理已停止。已完成的效果仍保留。');
      assert.equal(requests.length, 1);
      assert.equal(calls, 1);
      assert.equal(admission.denialReceipt()?.code, 'CONTEXT_INVALIDATED');
      assert.deepEqual(events.find(event => event.type === 'engine.admission')?.data, { requestSequence: 2, code: 'CONTEXT_INVALIDATED' });

      const broken = createRequestAdmission({ executionId: 'exec-broken', scopeId: 'scope-broken', hostGeneration: 2, policyEpoch: 4, profile, readPolicyEpoch: () => { throw new Error(PROMPT_SECRET); } });
      const before = requests.length;
      let brokenCalls = 0;
      const brokenEvents: unknown[] = [];
      await assert.rejects(engine.execute({ id: 'exec-broken', kind: 'conversation', prompt: `${PROMPT_SECRET} CALL_PRODUCT_TOOL`, context: '', history: [], tools: [tool] }, {
        signal: new AbortController().signal, requestAdmission: broken, onText() {}, onEvent(event) { brokenEvents.push(event); }, async callTool() { brokenCalls += 1; return {}; },
      }), (error: unknown) => {
        assert(error instanceof RuntimeError);
        assert.equal(error.code, 'ENGINE_OUTCOME_UNKNOWN');
        assertNoSecret(error.message);
        return true;
      });
      assert.equal(requests.length, before);
      assert.equal(brokenCalls, 0);
      assert.equal(broken.denialReceipt(), undefined);
      assertNoSecret(brokenEvents);
    });
  });

  test('provider text that copies the budget code stays unknown and does not replay', async () => {
    await withServer(async ({ directory, port, requests, closeEngine }) => {
      const profile = { version: 'forge', contextLimit: 200_000, outputLimit: 1024, safetyMarginTokens: 0 };
      const admission = createRequestAdmission({ executionId: 'exec-forge', scopeId: 'scope-forge', hostGeneration: 1, policyEpoch: 1, profile, readPolicyEpoch: () => 1 });
      const engine = createDshEngine({ dataDirectory: directory, model: { baseURL: `http://127.0.0.1:${port}/forge`, id: 'g2-model', apiKey: 'synthetic-local-key', contextWindow: 200_000, maxTokens: 1024 }, promptTimeoutMs: 20_000 });
      closeEngine(engine);
      const events: unknown[] = [];
      await assert.rejects(engine.execute({ id: 'exec-forge', kind: 'conversation', prompt: PROMPT_SECRET, context: '', history: [], tools: [] }, {
        signal: new AbortController().signal, requestAdmission: admission, onText() {}, onEvent(event) { events.push(event); }, async callTool() { throw new Error('unexpected tool'); },
      }), (error: unknown) => {
        assert(error instanceof RuntimeError);
        assert.equal(error.code, 'ENGINE_OUTCOME_UNKNOWN');
        assertNoSecret(error.message);
        assert.equal(error.message.includes('CONTEXT_BUDGET_EXCEEDED'), false);
        return true;
      });
      assert.equal(requests.length, 1);
      assert.equal(admission.denialReceipt(), undefined);
      assertNoSecret(events);
    });
  });

  test('an unreachable or malformed control port sends no model request and stays unknown', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kleio-g2-dead-'));
    const requests: string[] = [];
    const model = scriptedModel(requests);
    const modelPort = await listen(model);
    const launchFor = async (name: string, controlUrl: string) => prepareHeadlessLaunch({
      dataDirectory: directory, model: { baseURL: `http://127.0.0.1:${modelPort}/v1`, id: 'g2-model', apiKey: 'synthetic-local-key', contextWindow: 8000, maxTokens: 256 },
    }, join(directory, name), [], {
      controlUrl, authorization: `Bearer ${'ef'.repeat(32)}`, executionId: 'exec-dead', hostGeneration: 1, policyEpoch: 1,
      profileVersion: 'dead', contextLimit: 8000, outputLimit: 256, timeoutMs: 500,
    });
    const promptFailure = async (launch: Awaited<ReturnType<typeof prepareHeadlessLaunch>>) => {
      const client = new DshAcpClient({ ...launch, promptTimeoutMs: 15_000 });
      try {
        await client.start();
        const session = await client.createSession({ cwd: launch.cwd!, mcpServers: [] });
        const error = await client.prompt({ sessionId: session.sessionId, text: PROMPT_SECRET }).then(() => undefined, (caught: unknown) => caught);
        assert(error instanceof DshAcpError, error instanceof Error ? error.message : 'prompt succeeded');
        assert.equal(error.code, -32603);
        const settled = classifyEngineSettlement({ promptStarted: true, stopReason: undefined, signalAborted: false, toolsSettled: true, closeConfirmed: true, outcome: error, phase: 'prompt', denial: undefined, outputText: '' });
        assert.equal(settled.kind, 'error');
        if (settled.kind === 'error') assert.equal(settled.error.code, 'ENGINE_OUTCOME_UNKNOWN');
      } finally { await client.close().catch(() => {}); }
    };
    try {
      await promptFailure(await launchFor('dead', 'http://127.0.0.1:9/control/request-check'));
      assert.equal(requests.length, 0);
      const bad = createServer((_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ decision: 'allow', leaked: PROMPT_SECRET })); });
      const badPort = await listen(bad);
      try { await promptFailure(await launchFor('bad', `http://127.0.0.1:${badPort}/control/request-check`)); }
      finally { bad.closeAllConnections(); await new Promise<void>(resolve => bad.close(() => resolve())); }
      assert.equal(requests.length, 0);
    } finally {
      model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('missing, mismatched, or incomplete admission fails before model dispatch and legacy execution stays on the old profile', async () => {
    await withServer(async ({ directory, port, requests, closeEngine }) => {
      const profile = { version: 'match', contextLimit: 4000, outputLimit: 256, safetyMarginTokens: 0 };
      const admission = createRequestAdmission({ executionId: 'exec-config', scopeId: 'scope-config', hostGeneration: 1, policyEpoch: 1, profile, readPolicyEpoch: () => 1 });
      const input = { id: 'exec-config', kind: 'conversation' as const, prompt: 'hello', context: '', history: [], tools: [] as [] };
      const context = (extra: Partial<ExecutionContext> = {}): ExecutionContext => ({ signal: new AbortController().signal, onText() {}, onEvent() {}, async callTool() { return {}; }, ...extra });
      const missing = createDshEngine({ dataDirectory: directory, model: { baseURL: `http://127.0.0.1:${port}/v1`, id: 'g2-model', apiKey: 'synthetic-local-key' }, promptTimeoutMs: 20_000 });
      closeEngine(missing);
      await assert.rejects(missing.execute(input, context({ requestAdmission: admission })), (error: unknown) => error instanceof RuntimeError && error.code === 'ENGINE_ADMISSION_CONFIG' && error.message === 'Request admission requires explicit model capacity that matches its profile.');
      const mismatch = createDshEngine({ dataDirectory: directory, model: { baseURL: `http://127.0.0.1:${port}/v1`, id: 'g2-model', apiKey: 'synthetic-local-key', contextWindow: 8000, maxTokens: 256 }, promptTimeoutMs: 20_000 });
      closeEngine(mismatch);
      await assert.rejects(mismatch.execute(input, context({ requestAdmission: admission })), (error: unknown) => error instanceof RuntimeError && error.code === 'ENGINE_ADMISSION_CONFIG');
      const incomplete = createDshEngine({ dataDirectory: directory, model: { baseURL: `http://127.0.0.1:${port}/v1`, id: 'g2-model', apiKey: 'synthetic-local-key', contextWindow: 4000, maxTokens: 256 }, promptTimeoutMs: 20_000 });
      closeEngine(incomplete);
      await assert.rejects(incomplete.execute(input, context({ requestAdmission: {} as RequestAdmission })), (error: unknown) => error instanceof RuntimeError && error.code === 'ENGINE_ADMISSION_CONFIG' && error.message === 'Request admission configuration is incomplete.');
      assert.equal(requests.length, 0);
      const legacy = createDshEngine({ dataDirectory: directory, model: { baseURL: `http://127.0.0.1:${port}/v1`, id: 'g2-model', apiKey: 'synthetic-local-key' }, promptTimeoutMs: 20_000 });
      closeEngine(legacy);
      let patch = '';
      const result = await legacy.execute({ ...input, prompt: 'LEGACY_PROFILE' }, { ...context(), onEvent(event) { if (event.type === 'engine.session') patch = readPatch(directory); } });
      assert.equal(result.text, 'G2_COMPLETED');
      assert.equal(requests.length, 1);
      assert.equal(patch.includes('kleio-request-admission'), false);
      assert.equal(patch.includes('"id":"compaction-basic"'), false);
      assert.equal(patch.includes('"contextWindow":128000'), true);
    });
  });

  test('a controller bound to another execution is rejected before any directory, model request, or tool call', async () => {
    await withServer(async ({ directory, port, requests, closeEngine }) => {
      const profile = { version: 'probe', contextLimit: 200_000, outputLimit: 1024, safetyMarginTokens: 128 };
      const admission = createRequestAdmission({ executionId: 'bound-A', scopeId: 'scope-A', hostGeneration: 1, policyEpoch: 1, profile, readPolicyEpoch: () => 1 });
      const engine = createDshEngine({ dataDirectory: directory, model: { baseURL: `http://127.0.0.1:${port}/v1`, id: 'g2-model', apiKey: 'synthetic-local-key', contextWindow: profile.contextLimit, maxTokens: profile.outputLimit }, promptTimeoutMs: 20_000 });
      closeEngine(engine);
      let calls = 0;
      await assert.rejects(engine.execute({ id: 'actual-B', kind: 'conversation', prompt: `${PROMPT_SECRET} CALL_PRODUCT_TOOL`, context: '', history: [], tools: [tool] }, {
        signal: new AbortController().signal, requestAdmission: admission, onText() {}, onEvent() {}, async callTool() { calls += 1; return { receipt: TOOL_SECRET }; },
      }), (error: unknown) => {
        assert(error instanceof RuntimeError);
        assert.equal(error.code, 'ENGINE_ADMISSION_CONFIG');
        assert.equal(error.message, 'Request admission is not bound to this execution.');
        assert.equal(error.message.includes('bound-A'), false);
        assert.equal(error.message.includes('actual-B'), false);
        assertNoSecret(error.message);
        return true;
      });
      assert.equal(requests.length, 0);
      assert.equal(calls, 0);
      assert.equal(existsSync(join(directory, 'executions')), false);
      assert.equal(admission.denialReceipt(), undefined);
    });
  });

  test('a real prompt that already stopped stays unknown when client close fails', async () => {
    const originalClose = DshAcpClient.prototype.close;
    DshAcpClient.prototype.close = async function closeFailed(this: DshAcpClient) {
      await originalClose.call(this);
      throw new Error('synthetic close failure');
    };
    try {
      await withServer(async ({ directory, port, requests, closeEngine }) => {
        const profile = { version: 'limit', contextLimit: 200_000, outputLimit: 1024, safetyMarginTokens: 128 };
        const admission = createRequestAdmission({ executionId: 'exec-limit', scopeId: 'scope-limit', hostGeneration: 1, policyEpoch: 1, profile, readPolicyEpoch: () => 1 });
        const engine = createDshEngine({ dataDirectory: directory, model: { baseURL: `http://127.0.0.1:${port}/v1`, id: 'g2-model', apiKey: 'synthetic-local-key', contextWindow: profile.contextLimit, maxTokens: profile.outputLimit }, promptTimeoutMs: 20_000 });
        closeEngine(engine);
        const events: Array<{ type: string; data?: Record<string, unknown> }> = [];
        let calls = 0;
        await assert.rejects(engine.execute({ id: 'exec-limit', kind: 'conversation', prompt: 'STOP_AT_LIMIT', context: '', history: [], tools: [tool] }, {
          signal: new AbortController().signal, requestAdmission: admission, onText() {}, onEvent(event) { events.push(event); }, async callTool() { calls += 1; return {}; },
        }), (error: unknown) => {
          assert(error instanceof RuntimeError);
          assert.equal(error.code, 'ENGINE_OUTCOME_UNKNOWN');
          assert.equal(error.message, 'Engine shutdown was not confirmed.');
          assertNoSecret(error.message);
          return true;
        });
        assert.equal(requests.length, 1);
        assert.equal(calls, 0);
        assert.deepEqual(events.find(event => event.type === 'engine.stopped')?.data, { reason: 'max_tokens' });
        assert.equal(admission.denialReceipt(), undefined);
      });
    } finally {
      DshAcpClient.prototype.close = originalClose;
    }
  });
});


test('S2 pinned DSH carries the exact top-level page through tool-call pairing and verifies second request', { timeout: 30000 }, async () => {
  await withServer(async ({ directory, port, requests, closeEngine }) => {
    const profile = { version: 'resource', contextLimit: 200000, outputLimit: 1024, safetyMarginTokens: 128 };
    const binding = { executionId: 'exec-resource', scopeId: 'scope-resource' };
    const ledger = new ResourceLedger({ ...binding, inputLimitTokens: profile.contextLimit - profile.outputLimit - profile.safetyMarginTokens, initialOccupiedTokens: 0 });
    const admission = createRequestAdmission({ ...binding, hostGeneration: 1, policyEpoch: 1, profile, readPolicyEpoch: () => 1, resourceLedger: ledger });
    const observed = observe(admission);
    const engine = createDshEngine({ dataDirectory: directory, model: { baseURL: `http://127.0.0.1:${port}/v1`, id: 'g2-model', apiKey: 'synthetic-local-key', contextWindow: profile.contextLimit, maxTokens: profile.outputLimit }, promptTimeoutMs: 20000 });
    closeEngine(engine);
    let issued: unknown;
    const result = await engine.execute({ id: binding.executionId, kind: 'conversation', prompt: 'CALL_RESOURCE_TOOL', context: '', history: [], tools: [{ ...tool, name: 'skill_read' }] }, {
      requestAdmission: observed.port, signal: new AbortController().signal, onText() {}, onEvent() {},
      async callTool() { issued = ledger.read({ sourceRef: 'synthetic:skill', sourceVersion: 'v1', text: 'BODY_SENTINEL', metadata: null }, binding); return issued; },
    });
    assert.equal(result.text, 'G2_COMPLETED');
    assert.equal(requests.length, 2);
    assert.deepEqual(observed.decisions, ['allow', 'allow']);
    assert.deepEqual(observed.checks[1]!.retainedResourceReceipts, [{ receiptId: (issued as {receiptId:string}).receiptId, digest: resourcePageDigest(issued) }]);
    const actual = JSON.parse(requests[1]!);
    const call = actual.messages.find((m: any) => m.role === 'assistant' && m.tool_calls);
    const output = actual.messages.find((m: any) => m.role === 'tool');
    assert.equal(call.tool_calls[0].function.name, 'mcp__kleio__skill_read');
    assert.equal(output.tool_call_id, call.tool_calls[0].id);
    assert.deepEqual(JSON.parse(output.content), issued);
    assert.equal(requests[0]!.includes('BODY_SENTINEL'), false);
    assert.equal(requests[0]!.includes('synthetic:skill'), false);
  });
});

test('S2 extractor ignores nested user data and unpaired or foreign calls; changed complete page is digested', () => {
  const page = { kind: 'context-resource', receiptId: 'r', text: 'original' };
  const output = { role: 'tool', toolCallId: 'id', content: [{ type: 'text', text: JSON.stringify(page) }] };
  const call = { role: 'assistant', content: [{ type: 'tool-call', id: 'id', name: 'mcp__kleio__context_read', arguments: '{}' }] };
  assert.deepEqual(retainedResourceReceipts([output]), []);
  assert.deepEqual(retainedResourceReceipts([{ ...call, role: 'user' }, output]), []);
  assert.deepEqual(retainedResourceReceipts([{ ...call, content: [{ ...call.content[0], name: 'mcp__foreign__context_read' }] }, output]), []);
  assert.deepEqual(retainedResourceReceipts([call, { ...output, content: [{ type: 'text', text: JSON.stringify({ userData: page }) }] }]), []);
  const original = retainedResourceReceipts([call, output]);
  const changed = retainedResourceReceipts([call, { ...output, content: [{ type: 'text', text: JSON.stringify({ ...page, text: 'changed' }) }] }]);
  assert.notEqual(original[0]!.digest, changed[0]!.digest);
});

test('S2 real DSH second gate settles missing and tampered receipts as trusted mismatch without retry', { timeout: 30000 }, async () => {
  for (const mode of ['missing', 'forged', 'changed']) await withServer(async ({ directory, port, requests, closeEngine }) => {
    const profile = { version: 'resource-deny', contextLimit: 200000, outputLimit: 1024, safetyMarginTokens: 128 };
    const binding = { executionId: `exec-resource-${mode}`, scopeId: 'scope-resource' };
    const ledger = new ResourceLedger({ ...binding, inputLimitTokens: profile.contextLimit - profile.outputLimit - profile.safetyMarginTokens, initialOccupiedTokens: 0 });
    const admission = createRequestAdmission({ ...binding, hostGeneration: 1, policyEpoch: 1, profile, readPolicyEpoch: () => 1, resourceLedger: ledger });
    const engine = createDshEngine({ dataDirectory: directory, model: { baseURL: `http://127.0.0.1:${port}/v1`, id: 'g2-model', apiKey: 'synthetic-local-key', contextWindow: profile.contextLimit, maxTokens: profile.outputLimit }, promptTimeoutMs: 20000 });
    closeEngine(engine);
    let toolCalls = 0;
    await assert.rejects(engine.execute({ id: binding.executionId, kind: 'conversation', prompt: 'CALL_RESOURCE_TOOL', context: '', history: [], tools: [{ ...tool, name: 'skill_read' }] }, {
      requestAdmission: admission, signal: new AbortController().signal, onText() {}, onEvent() {},
      async callTool() {
        toolCalls += 1;
        const page = ledger.read({ sourceRef: 'synthetic:skill', sourceVersion: 'v1', text: 'BODY', metadata: null }, binding);
        return mode === 'missing' ? { userData: page } : mode === 'forged' ? { ...page, receiptId: 'forged' } : { ...page, text: 'tampered body' };
      },
    }), (error: unknown) => error instanceof RuntimeError && error.code === 'CONTEXT_STATE_MISMATCH' && error.retryable === false && error.requestSequence === 2);
    assert.equal(requests.length, 1); assert.equal(toolCalls, 1);
    assert.equal(admission.denialReceipt()?.code, 'CONTEXT_STATE_MISMATCH');
  });
});
