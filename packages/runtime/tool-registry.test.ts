import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry, type ToolBinding, type ToolInvocation } from './tool-registry.ts';
import { PRODUCT_TOOL_CATALOG, catalogAvailability } from '../product-context/tool-catalog.ts';
import type { EffectiveToolSet, ToolDescriptor, ToolPolicy, ToolProfile } from '../context-contracts/tools.ts';

const policy: ToolPolicy = { memoryEnabled: true, searchConfigured: true };
const scope = { scopeId: 'local', executionId: 'execution-synthetic', conversationId: 'conversation-synthetic' };
const signal = new AbortController().signal;
const bindings = (catalog = PRODUCT_TOOL_CATALOG): ToolBinding[] => catalog.map(tool => ({ name: tool.name, handler: async () => tool.name }));
const registry = () => new ToolRegistry(PRODUCT_TOOL_CATALOG, bindings());
const denied = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'tool_denied' && 'status' in error && error.status === 403;

test('one-to-one bindings reject duplicate declarations, duplicate handlers, missing and extra handlers', () => {
  assert.throws(() => new ToolRegistry([...PRODUCT_TOOL_CATALOG, PRODUCT_TOOL_CATALOG[0]!], bindings()));
  assert.throws(() => new ToolRegistry(PRODUCT_TOOL_CATALOG, [...bindings(), bindings()[0]!]));
  assert.throws(() => new ToolRegistry(PRODUCT_TOOL_CATALOG, bindings().slice(1)));
  assert.throws(() => new ToolRegistry(PRODUCT_TOOL_CATALOG, [...bindings(), { name: 'unregistered', handler: async () => null }]));
  assert.throws(() => new ToolRegistry(PRODUCT_TOOL_CATALOG, [{ name: 'memory_search', handler: null } as unknown as ToolBinding]));
});

test('all profiles preserve product order and legacy research limits', () => {
  const r = registry();
  const expected: Record<ToolProfile, string[]> = {
    conversation: ['memory_search', 'web_read', 'web_search', 'memory_explain', 'memory_remember', 'work_status', 'work_control', 'create_work', 'memory_forget', 'memory_correct', 'skills_list', 'skill_read', 'context_read'],
    research: ['memory_search', 'web_read', 'web_search', 'skills_list', 'skill_read', 'context_read'], 'legacy-research': ['memory_search', 'web_read', 'skills_list', 'skill_read', 'context_read'], review: [], memory: [],
  };
  for (const profile of Object.keys(expected) as ToolProfile[]) {
    const snapshot = r.capture(scope, profile, policy);
    assert.deepEqual(snapshot.tools.map(tool => tool.name), expected[profile]);
    assert.equal(snapshot.availability.length, 13);
    assert.deepEqual(snapshot.availability, catalogAvailability(PRODUCT_TOOL_CATALOG, profile, policy));
  }
});

test('allow undefined, explicit empty allow, deny priority, recall off and keyless have separate facts', () => {
  const r = registry();
  assert.equal(r.capture(scope, 'conversation', policy).tools.length, 13);
  assert.equal(r.capture(scope, 'conversation', { ...policy, allowedTools: [] }).tools.length, 0);
  const allowDeny = r.capture(scope, 'conversation', { ...policy, allowedTools: ['web_read', 'web_search', 'fictional'], disabledTools: ['web_search'] });
  assert.deepEqual(allowDeny.tools.map(tool => tool.name), ['web_read']);
  assert.equal(allowDeny.availability.find(tool => tool.name === 'web_search')!.reason, 'policy-disabled');
  const off = r.capture(scope, 'conversation', { memoryEnabled: false, searchConfigured: false });
  assert.equal(off.availability.find(tool => tool.name === 'memory_search')!.reason, 'memory-disabled');
  assert.equal(off.tools.length, 12);
  for (const name of ['memory_explain', 'memory_correct', 'memory_forget', 'memory_remember']) assert.ok(off.tools.some(tool => tool.name === name));
  const search = off.availability.find(tool => tool.name === 'web_search')!;
  assert.equal(search.available, true);
  assert.equal(search.capability.configured, false);
  assert.equal(search.capability.configurationMode, 'keyless');
  assert.equal(r.capture(scope, 'research', { ...policy, memoryEnabled: false }).tools.length, 5);
  assert.equal(r.capture(scope, 'legacy-research', { ...policy, memoryEnabled: false }).tools.length, 4);
});

test('definitions, binding array, policies, scope and all published projections are isolated', async () => {
  const catalog = structuredClone(PRODUCT_TOOL_CATALOG) as unknown as Array<{ name: string; description: string; inputSchema: Record<string, unknown>; profiles: ToolProfile[]; requiresMemoryRecall: boolean; capability: { note: string; configuration: 'always' } }>;
  const handlers = bindings(catalog).map(binding => ({ ...binding }));
  const r = new ToolRegistry(catalog, handlers);
  const originalVersion = r.catalogVersion;
  catalog[0]!.name = 'mutated';
  (catalog[1]!.inputSchema.properties as Record<string, unknown>).url = { type: 'integer' };
  catalog[1]!.profiles.length = 0;
  handlers[1]!.handler = async () => 'hijacked';
  handlers.length = 0;
  const allowedTools = ['web_read', 'skills_list', 'skill_read', 'context_read'];
  const disabledTools: string[] = [];
  const mutableScope = { ...scope };
  const inputPolicy = { ...policy, allowedTools, disabledTools, secret: 'must-not-copy' };
  const snapshot = r.capture(mutableScope, 'conversation', inputPolicy);
  mutableScope.executionId = 'forged'; allowedTools.push('create_work'); disabledTools.push('web_read');
  inputPolicy.memoryEnabled = false;
  assert.equal(snapshot.scope.executionId, scope.executionId);
  assert.deepEqual(snapshot.policy.allowedTools, ['web_read', 'skills_list', 'skill_read', 'context_read']);
  assert.deepEqual(snapshot.policy.disabledTools, []);
  assert.equal('secret' in snapshot.policy, false);
  assert.equal(snapshot.policy.memoryEnabled, true);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.scope));
  assert.ok(Object.isFrozen(snapshot.policy.allowedTools));
  assert.ok(Object.isFrozen(snapshot.tools[0]!.inputSchema.properties));
  assert.ok(Object.isFrozen(snapshot.availability[0]!.capability));
  assert.throws(() => (snapshot.tools as unknown[]).push({}));
  assert.throws(() => { (snapshot.tools[0]!.inputSchema.properties as Record<string, unknown>).url = {}; });
  const projected = r.project(snapshot);
  projected[0]!.name = 'create_work';
  (projected[0]!.inputSchema.properties as Record<string, unknown>).url = { type: 'integer' };
  projected.push({ name: 'create_work', description: '', inputSchema: {} });
  const next = r.project(snapshot);
  assert.equal(next[0]!.name, 'web_read');
  assert.deepEqual((next[0]!.inputSchema.properties as Record<string, unknown>).url, { type: 'string' });
  assert.equal(r.catalogVersion, originalVersion);
  assert.equal(await r.dispatch(snapshot, 'web_read', {}, signal, policy), 'web_read');
  await assert.rejects(r.dispatch(snapshot, 'create_work', {}, signal, policy), denied);
});

test('forged, cloned and cross-registry snapshots fail without handler side effects', async () => {
  let calls = 0;
  const r = new ToolRegistry(PRODUCT_TOOL_CATALOG, PRODUCT_TOOL_CATALOG.map(tool => ({ name: tool.name, handler: async () => { calls++; } })));
  const original = r.capture(scope, 'conversation', policy);
  const other = registry().capture(scope, 'conversation', policy);
  for (const snapshot of [{ ...original }, structuredClone(original), other]) {
    await assert.rejects(r.dispatch(snapshot, 'web_read', {}, signal, policy), denied);
    assert.throws(() => r.project(snapshot), denied);
  }
  await assert.rejects(r.dispatch(original, 'unknown', {}, signal, policy), denied);
  await assert.rejects(r.dispatch(r.capture(scope, 'review', policy), 'web_read', {}, signal, policy), denied);
  assert.equal(calls, 0);
});

test('live policy revocation and reinstatement never expand the initial grant', async () => {
  const r = registry();
  const admitted = r.capture(scope, 'conversation', policy);
  await assert.rejects(r.dispatch(admitted, 'memory_search', {}, signal, { ...policy, memoryEnabled: false }), (error: unknown) => (error as { code: string }).code === 'memory_disabled' && (error as { status: number }).status === 403);
  assert.equal(await r.dispatch(admitted, 'memory_search', {}, signal, policy), 'memory_search');
  await assert.rejects(r.dispatch(admitted, 'web_read', {}, signal, { ...policy, disabledTools: ['web_read', 'skills_list', 'skill_read', 'context_read'] }), denied);
  await assert.rejects(r.dispatch(admitted, 'web_read', {}, signal, { ...policy, allowedTools: [] }), denied);
  assert.equal(await r.dispatch(admitted, 'web_read', {}, signal, policy), 'web_read');
  const absentMemory = r.capture(scope, 'conversation', { ...policy, memoryEnabled: false });
  await assert.rejects(r.dispatch(absentMemory, 'memory_search', {}, signal, policy), denied);
  const absentRead = r.capture(scope, 'conversation', { ...policy, disabledTools: ['web_read', 'skills_list', 'skill_read', 'context_read'] });
  await assert.rejects(r.dispatch(absentRead, 'web_read', {}, signal, policy), denied);
});

test('synthetic tool has no special-name branch and invocation identity comes only from captured scope/profile', async () => {
  const descriptor: ToolDescriptor = { name: 'synthetic_capability', description: 'Synthetic fixture', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, profiles: ['legacy-research'], requiresMemoryRecall: false, capability: { note: 'Synthetic capability', configuration: 'always' } };
  let received: ToolInvocation | undefined;
  const r = new ToolRegistry([descriptor], [{ name: descriptor.name, handler: async (args, invocation) => { received = invocation; return args; } }]);
  const mutableScope = { ...scope, workId: 'work-synthetic' };
  const snapshot = r.capture(mutableScope, 'legacy-research', policy);
  mutableScope.executionId = 'attacker';
  const transport = r.project(snapshot); transport.length = 0;
  assert.deepEqual(await r.dispatch(snapshot, descriptor.name, { executionId: 'attacker', kind: 'conversation' }, signal, policy), { executionId: 'attacker', kind: 'conversation' });
  assert.equal(received!.executionId, scope.executionId);
  assert.equal(received!.scope.workId, 'work-synthetic');
  assert.equal(received!.kind, 'research');
  assert.equal(received!.profile, 'legacy-research');
  assert.equal(received!.signal, signal);
  assert.ok(Object.isFrozen(received));
  assert.ok(Object.isFrozen(received!.scope));
  assert.equal(snapshot.availability[0]!.capability.note, 'Synthetic capability');
  const sameContent = new ToolRegistry([structuredClone(descriptor)], [{ name: descriptor.name, handler: async () => 'different handler' }]);
  assert.equal(sameContent.catalogVersion, r.catalogVersion);
  const changedContent = new ToolRegistry([{ ...descriptor, description: 'changed' }], [{ name: descriptor.name, handler: async () => null }]);
  assert.notEqual(changedContent.catalogVersion, r.catalogVersion);
});

test('invalid policy fails closed', () => {
  assert.throws(() => registry().capture(scope, 'conversation', { ...policy, memoryEnabled: undefined } as unknown as ToolPolicy), denied);
});

// Compile-time readonly boundaries; mutable compatibility transport stays usable.
function typeChecks(snapshot: EffectiveToolSet) {
  // @ts-expect-error published arrays are readonly
  snapshot.tools.push({});
  // @ts-expect-error nested schema is readonly
  snapshot.tools[0]!.inputSchema.type = 'string';
  // @ts-expect-error policy lists are readonly
  snapshot.policy.allowedTools?.push('new_tool');
}
void typeChecks;


test('already-aborted invocation is rejected before any handler side effect', async () => {
  let calls = 0;
  const r = new ToolRegistry(PRODUCT_TOOL_CATALOG, PRODUCT_TOOL_CATALOG.map(tool => ({ name: tool.name, handler: async () => { calls++; } })));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(r.dispatch(r.capture(scope, 'conversation', policy), 'web_read', {}, abort.signal, policy), { name: 'AbortError' });
  assert.equal(calls, 0);
});
