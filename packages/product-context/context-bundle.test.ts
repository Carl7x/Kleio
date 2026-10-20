import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContextBundleInput, ContextBundleV1 } from '../context-contracts/bundle.ts';
import { compileContextBundle, estimateBundleProjection } from './context-bundle.ts';
import { serializeContextBundle } from './serialize-context.ts';
const s = (sourceRef: string, text = sourceRef) => ({ sourceRef, sourceVersion: `hash:${sourceRef}`, text });
function fixture(): ContextBundleInput {
  return { executionId: 'exec', scopeRef: 'local', snapshotId: 'snap', policyVersion: 'p1', capacity: { contextWindow: 16000, maxTokens: 1000 },
    policy: s('policy'), standing: [s('standing', '完整配置')], capabilities: s('capabilities'),
    catalog: { entries: [{ sourceRef: 'skill:x', sourceVersion: 'h1', id: 'x', name: 'X', description: 'Metadata only' }], lookupInstruction: s('catalog', 'Use skills_list for the full catalog.') },
    memory: [s('memory', '完整记忆')], history: [{ sourceRef: 'history:1', sourceVersion: 'h1', messages: [{ role: 'user', content: 'old request' }, { role: 'assistant', content: 'old answer' }] }],
    historyLookupInstruction: { ...s('history-index', 'Use context_read with sourceRef history-index to discover omitted history groups.'), sourceRef: 'history-index' },
    task: [s('task', 'task constraints')], request: s('request', 'Current\n完整请求'), tools: { sourceRef: 'tools', sourceVersion: 'v1', definitions: [{ name: 'lookup', description: 'Lookup', inputSchema: { type: 'object' } }] } };
}
function success(input = fixture()): ContextBundleV1 { const result = compileContextBundle(input); if (!result.ok) throw Error(result.reason); assert.equal(result.ok, true); return result.bundle; }
test('typed complete bundle immutable detached deterministic with body-free provenance', () => {
  const input = fixture(), bundle = success(input);
  assert.deepEqual(bundle, success(input));
  assert.equal(Object.isFrozen(bundle), true);
  assert.equal(Object.isFrozen(bundle.tools.definitions[0]?.inputSchema), true);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(bundle.manifest.some(e => 'text' in e || 'content' in e), false);
  assert.deepEqual(bundle.manifest.map(e => e.kind), ['history', 'policy', 'standing', 'capabilities', 'task', 'request', 'tools', 'catalog', 'catalog', 'memory', 'history']);
  assert.equal(bundle.budget.safetyTokens, 2048);
  assert.equal(bundle.budget.dynamicReserve, Math.floor(.25 * bundle.budget.inputBudget));
  assert.equal(bundle.budget.estimatedInputTokens, estimateBundleProjection(bundle));
  assert.ok(bundle.budget.estimatedInputTokens <= bundle.budget.initialLimit);
});
test('adapter preserves request verbatim and history messages in separate roles; another adapter consumes same bundle', () => {
  const bundle = success();
  const projection = serializeContextBundle(bundle);
  assert.deepEqual(projection.messages.map(m => m.role), ['user', 'assistant', 'user']);
  assert.equal(projection.messages.at(-1)?.content, fixture().request.text);
  const recorded: ContextBundleV1[] = [];
  const recordingAdapter = (b: ContextBundleV1) => { recorded.push(b); return b.request.text; };
  assert.equal(recordingAdapter(bundle), fixture().request.text);
  assert.equal(recorded[0], bundle);
  assert.ok(projection.system.includes('external-data'));
});
test('large catalog falls back explicitly without any metadata substring truncation', () => {
  const input = fixture();
  const bundle = success({ ...input, catalog: { ...input.catalog, entries: [{ ...input.catalog.entries[0]!, description: 'CATALOG_SENTINEL'.repeat(1000) }] } });
  assert.equal(bundle.parts.catalog.mode, 'lookup');
  assert.deepEqual(bundle.parts.catalog.entries, []);
  assert.ok(serializeContextBundle(bundle).system.includes('skills_list'));
  assert.ok(!serializeContextBundle(bundle).system.includes('CATALOG_SENTINEL'));
  assert.equal(bundle.manifest.find(e => e.sourceRef === 'skill:x')?.reason, 'catalog-lookup-fallback');
});
test('memory and history omit whole groups with reusable source references; schemas counted', () => {
  const input = fixture();
  const huge = 'TOO_LARGE_完整'.repeat(5000);
  const bundle = success({ ...input, memory: [s('large-memory', huge), s('small-memory', 'small')], history: [{ sourceRef: 'history:omitted', sourceVersion: 'hv', messages: [{ role: 'assistant', content: huge, toolCalls: [{ id: 'c1', name: 'lookup', arguments: '{}' }] }, { role: 'tool', content: huge, toolCallId: 'c1' }] }] });
  assert.deepEqual(bundle.parts.memory.map(m => m.sourceRef), ['small-memory']);
  assert.deepEqual(bundle.history, []);
  assert.equal(bundle.manifest.find(e => e.sourceRef === 'history:omitted')?.reason, 'budget-omitted');
  assert.ok(!JSON.stringify(serializeContextBundle(bundle)).includes('TOO_LARGE'));
  const result = compileContextBundle({ ...input, tools: { ...input.tools, definitions: [{ name: 'huge', description: huge, inputSchema: {} }] } });
  assert.equal(result.ok, false);
});
test('required overflow returns failure before an engine can be called and never clips request/standing/task', () => {
  for (const kind of ['request', 'standing', 'task', 'policy'] as const) {
    const input = fixture();
    const enormous = s('enormous', 'a'.repeat(30000));
    const modified = kind === 'standing' || kind === 'task' ? { ...input, [kind]: [enormous] } : { ...input, [kind]: enormous };
    let engineCalls = 0;
    const result = compileContextBundle(modified);
    if (result.ok) engineCalls++;
    assert.equal(result.ok, false);
    assert.equal(engineCalls, 0);
    if (!result.ok) assert.equal(result.code, 'CONTEXT_BUDGET_EXCEEDED');
  }
});
test('invalid or missing capacities never assume a model window', () => {
  for (const capacity of [{ contextWindow: 0, maxTokens: 1 }, { contextWindow: 1000, maxTokens: 100 }, { contextWindow: NaN, maxTokens: 1 }, { contextWindow: 16000, maxTokens: 1.1 }]) {
    const result = compileContextBundle({ ...fixture(), capacity });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'CONTEXT_CONFIGURATION_ERROR');
  }
});

test('catalog structural extras never leak package bodies into bundle or projection', () => {
  const input = fixture();
  const entry = { ...input.catalog.entries[0]!, body: 'PRIVATE_BODY_SENTINEL', absolutePath: '/private/path' };
  const bundle = success({ ...input, catalog: { ...input.catalog, entries: [entry] } });
  assert.ok(!JSON.stringify(bundle).includes('PRIVATE_BODY_SENTINEL'));
  assert.ok(!JSON.stringify(serializeContextBundle(bundle)).includes('/private/path'));
});

test('background work candidates are optional whole items, distinct from mandatory task', () => {
  const input = fixture();
  const bundle = success({ ...input, backgroundWork: [s('big-work', 'work'.repeat(10000)), s('small-work', 'small complete work')] });
  assert.deepEqual(bundle.parts.task, input.task);
  assert.deepEqual(bundle.parts.backgroundWork.map(s => s.sourceRef), ['small-work']);
  assert.equal(bundle.manifest.find(e => e.sourceRef === 'big-work')?.reason, 'budget-omitted');
  assert.equal(bundle.manifest.find(e => e.sourceRef === 'small-work')?.required, false);
});
test('history selection prefers newest whole groups and serializes chosen groups chronologically', () => {
  const input = fixture();
  const group = (id: string, size: number) => ({ sourceRef: id, sourceVersion: id, messages: [{ role: 'user' as const, content: id.repeat(size) }] });
  const groups = [group('old', 1500), group('middle', 500), group('new', 500)];
  const bundle = success({ ...input, history: groups });
  assert.deepEqual(bundle.history.map(g => g.sourceRef), ['middle', 'new']);
  assert.deepEqual(serializeContextBundle(bundle).messages.slice(0, -1).map(m => m.content), groups.slice(1).map(g => g.messages[0]!.content));
  assert.equal(bundle.manifest.find(e => e.sourceRef === 'old')?.reason, 'budget-omitted');
});
test('omitted history is discoverable through a mandatory bounded index instruction', () => {
  const input = fixture();
  const many = Array.from({ length: 40 }, (_, index) => ({ sourceRef: `history:${index}`, sourceVersion: 'h', messages: [{ role: 'user' as const, content: 'oversized'.repeat(5000) }] }));
  const bundle = success({ ...input, history: many });
  assert.deepEqual(bundle.history, []);
  assert.ok(serializeContextBundle(bundle).system.includes('context_read with sourceRef history-index'));
  assert.equal(bundle.manifest.filter(e => e.kind === 'history' && !e.included).length, many.length);
  assert.equal(bundle.budget.estimatedInputTokens, success({ ...input, history: [] }).budget.estimatedInputTokens);
  assert.equal(bundle.manifest.find(e => e.sourceRef === 'history-index')?.required, true);
});

test('required old history reserves its complete call-output group before newer optional history', () => {
  const input = fixture();
  const required = { sourceRef: 'required-old', sourceVersion: 'r1', required: true as const, messages: [
    { role: 'assistant' as const, content: 'required'.repeat(500), toolCalls: [{ id: 'call', name: 'lookup', arguments: '{}' }] },
    { role: 'tool' as const, content: 'complete result', toolCallId: 'call' },
  ] };
  const optional = { sourceRef: 'optional-new', sourceVersion: 'o1', messages: [{ role: 'user' as const, content: 'optional'.repeat(700) }] };
  const bundle = success({ ...input, history: [required, optional] });
  assert.deepEqual(bundle.history, [required]);
  assert.deepEqual(bundle.manifest.filter(e => e.sourceRef === required.sourceRef).map(e => [e.required, e.included, e.reason, e.authority]), [[true, true, 'required', 'external-data']]);
  assert.equal(bundle.manifest.find(e => e.sourceRef === optional.sourceRef)?.reason, 'budget-omitted');
  assert.deepEqual(serializeContextBundle(bundle).messages.slice(0, -1), required.messages);
});

test('mixed required and optional history stays chronological with each input group selected once', () => {
  const input = fixture();
  const history = Array.from({ length: 5 }, (_, index) => ({ sourceRef: `mixed:${index}`, sourceVersion: `v${index}`,
    ...(index % 2 ? { required: true as const } : {}), messages: [{ role: 'user' as const, content: `complete message ${index}` }] }));
  const bundle = success({ ...input, history });
  assert.deepEqual(bundle.history, history);
  assert.deepEqual(serializeContextBundle(bundle).messages.slice(0, -1).map(m => m.content), history.map(g => g.messages[0]!.content));
  for (const group of history) assert.equal(bundle.manifest.filter(e => e.sourceRef === group.sourceRef).length, 1);
});

test('required history overflow explicitly fails without truncation or mutation of caller inputs', () => {
  const input = fixture();
  const group = { sourceRef: 'required-overflow', sourceVersion: 'overflow-v1', required: true as const,
    messages: [{ role: 'user' as const, content: 'required complete text'.repeat(2000) }] };
  const modified = { ...input, history: [group] };
  const before = structuredClone(modified);
  const result = compileContextBundle(modified);
  assert.equal(result.ok, false);
  if (result.ok) throw Error('required history must not be silently omitted');
  assert.equal(result.code, 'CONTEXT_BUDGET_EXCEEDED');
  assert.equal(result.reason, 'required-content-too-large');
  assert.ok(result.budget!.estimatedInputTokens > result.budget!.initialLimit);
  assert.equal(result.manifest.find(e => e.sourceRef === group.sourceRef)?.required, true);
  assert.deepEqual(modified, before);
  assert.equal(Object.isFrozen(group.messages), false);
  group.messages[0]!.content = 'caller still owns input';
});

test('required history publication is deeply frozen and detached from caller mutations', () => {
  const input = fixture();
  const group = { sourceRef: 'required', sourceVersion: 'v1', required: true as const,
    messages: [{ role: 'user' as const, content: 'original complete text' }] };
  const bundle = success({ ...input, history: [group] });
  assert.equal(Object.isFrozen(bundle.history[0]!.messages[0]), true);
  assert.equal(Object.isFrozen(group.messages[0]), false);
  group.messages[0]!.content = 'caller changed text';
  assert.equal(bundle.history[0]!.messages[0]!.content, 'original complete text');
  assert.throws(() => { (bundle.history[0]!.messages[0] as { content: string }).content = 'published mutation'; }, TypeError);
});
