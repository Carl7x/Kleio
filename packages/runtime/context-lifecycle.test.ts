import { createRuntimeApp } from '../../apps/runtime/app.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeHost } from './host.ts';
import { RuntimeStore } from './store.ts';
import type { Engine, ExecutionContext, ExecutionInput } from './contracts.ts';
import { TEST_CONTEXT_CAPABILITIES, TEST_MODEL_CAPACITY } from './context-test-fixture.ts';
async function until(check: () => boolean) { for (let n = 0; n < 200; n++) { if (check()) return; await delay(10); } throw new Error('Synthetic state not reached'); }
function fixture(t: TestContext, execute: Engine['execute']) {
  const directory = mkdtempSync(join(tmpdir(), 'kleio-context-lifecycle-'));
  const store = new RuntimeStore(join(directory, 'app.sqlite'));
  const host = new RuntimeHost(store, { id: 'controlled-lifecycle', contextCapabilities: TEST_CONTEXT_CAPABILITIES, execute, async close() {} }, { port: 4317, token: 'synthetic-lifecycle-token-123', dataDirectory: directory,
    model: { ...TEST_MODEL_CAPACITY, baseURL: 'https://example.invalid', id: 'synthetic', apiKey: '' }, memoryIdleMs: 120000 });
  t.after(async () => { await host.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { host, store, directory };
}
function held() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

for (const mutation of ['memory-off', 'correct', 'forget'] as const) {
  test(`external ${mutation} revokes streaming and old tool callback, while queued work starts fresh`, async t => {
    const gate = held(); let callback!: ExecutionContext; const seen: ExecutionInput[] = [];
    const f = fixture(t, async (input, context) => { seen.push(input); if (input.prompt === 'held') { callback = context; context.onText('OLD_PRIVATE_OUTPUT'); await gate.promise; context.onText('OLD_LATE_OUTPUT'); } return { text: input.prompt === 'held' ? 'OLD_FINAL_OUTPUT' : 'FRESH_OUTPUT' }; });
    t.after(() => gate.release());
    const saved = f.host.memory.remember({ key: '合成偏好', text: '我喜欢桂花乌龙', source: { messageId: 'synthetic', conversationId: 'synthetic', createdAt: new Date().toISOString(), quote: '我喜欢桂花乌龙' } });
    const conversation = f.store.createConversation();
    const old = f.host.submit(conversation.id, 'held', 'held');
    await until(() => !!callback);
    const fresh = f.host.submit(conversation.id, 'fresh', 'fresh');
    if (mutation === 'memory-off') f.host.setMemoryEnabled(false);
    if (mutation === 'correct') f.host.correct(saved.id, { text: '我喜欢白茶', expectedVersion: saved.version, source: { label: 'Synthetic correction' } });
    if (mutation === 'forget') f.host.forget(saved.id);
    assert.equal(callback.signal.aborted, true);
    callback.onText('STALE_AFTER_REVOKE');
    await assert.rejects(callback.callTool('work_status', {}));
    gate.release();
    await until(() => f.store.execution(fresh.id).status === 'completed');
    assert.equal(f.store.execution(old.id).status, 'cancelled');
    assert.equal(f.store.execution(old.id).text, '');
    assert.equal(f.store.execution(old.id).contextFailure?.code, 'CONTEXT_INVALIDATED');
    assert.equal(f.store.execution(fresh.id).text, 'FRESH_OUTPUT');
    assert.equal(JSON.stringify(seen.at(-1)!.bundle).includes('OLD_FINAL_OUTPUT'), false);
    assert.equal(JSON.stringify(seen.at(-1)!.bundle).includes('OLD_PRIVATE_OUTPUT'), false);
  });
}

test('same value, widening and ordinary body/index formatting do not revoke; disabled additions and malformed policy do', async t => {
  const gates: Array<ReturnType<typeof held>> = []; const contexts: ExecutionContext[] = [];
  const f = fixture(t, async (_input, context) => { const gate = held(); gates.push(gate); contexts.push(context); await gate.promise; return { text: 'Synthetic done' }; });
  t.after(() => gates.forEach(gate => gate.release()));
  const running = f.host.run('research', 'held', 'Synthetic contract'); void running.catch(() => {});
  await until(() => contexts.length === 1);
  const context = contexts[0]!;
  f.host.setMemoryEnabled(true); f.host.setToolPolicy({}); f.host.setSkillEnabled('ordinary', true);
  mkdirSync(join(f.directory, 'skills/ordinary'), { recursive: true });
  writeFileSync(join(f.directory, 'skills/ordinary/SKILL.md'), '---\nname: ordinary\ndescription: synthetic\n---\nChanged ordinary body');
  writeFileSync(join(f.directory, 'skills-index.json'), '{"skills":[{"enabled":true,"id":"ordinary"}],"version":1}');
  await delay(300); assert.equal(context.signal.aborted, false);
  f.host.setSkillEnabled('ordinary', false);
  assert.equal(context.signal.aborted, true);
  gates[0]!.release(); await assert.rejects(running);
  const next = f.host.run('research', 'held2', 'Synthetic contract'); void next.catch(() => {});
  await until(() => contexts.length === 2);
  f.host.setToolPolicy({ disabledTools: ['web_read'] }); assert.equal(contexts[1]!.signal.aborted, true);
  gates[1]!.release(); await assert.rejects(next);
  const third = f.host.run('research', 'held3', 'Synthetic contract'); void third.catch(() => {});
  await until(() => contexts.length === 3);
  f.host.setToolPolicy({}); assert.equal(contexts[2]!.signal.aborted, false);
  writeFileSync(join(f.directory, 'skills-index.json'), '{invalid');
  await until(() => contexts[2]!.signal.aborted);
  gates[2]!.release(); await assert.rejects(third);
  assert.ok(f.store.executions().some(execution => execution.contextFailure?.code === 'CONTEXT_POLICY_UNAVAILABLE'));
  await assert.rejects(f.host.run('research', 'bad policy', 'Synthetic contract'), (error: unknown) => (error as { code: string }).code === 'CONTEXT_POLICY_UNAVAILABLE');
});

test('Work guard survives Host resolve and prevents result commit after a queued microtask revocation', async t => {
  const f = fixture(t, async () => ({ text: 'STALE_WORK_RESULT' }));
  const original = f.store.finish.bind(f.store);
  let revoked = false;
  t.mock.method(f.store, 'finish', (...args: Parameters<RuntimeStore['finish']>) => {
    const result = original(...args);
    if (result.kind === 'research' && result.status === 'completed') queueMicrotask(() => { revoked = true; f.host.setMemoryEnabled(false); });
    return result;
  });
  const conversation = f.store.createConversation();
  const task = f.host.createWork({ requestId: 'guarded-research', title: 'Synthetic guarded research', prompt: 'Synthetic interval research', kind: 'research', conversationId: conversation.id, intervalMs: 60000, at: new Date(Date.now() - 60000).toISOString() });
  f.host.start();
  await until(() => revoked && f.host.work.runs(task.id).some(run => run.status === 'cancelled'));
  const run = f.host.work.runs(task.id)[0]!;
  assert.equal(run.errorCode, 'CONTEXT_INVALIDATED');
  assert.equal(f.host.work.result(run.id), undefined);
  assert.equal(f.store.messages(conversation.id).some(message => message.content.includes('STALE_WORK_RESULT')), false);
});

for (const revoke of ['cancel', 'close'] as const) {
  test(`${revoke} in the Host resolve to Work commit gap revokes the retained guard`, async t => {
    const f = fixture(t, async () => ({ text: 'GAP_PRIVATE_RESULT' }));
    const original = f.store.finish.bind(f.store); let revoked = false; let closing: Promise<void> | undefined;
    t.mock.method(f.store, 'finish', (...args: Parameters<RuntimeStore['finish']>) => {
      const result = original(...args);
      if (result.kind === 'research' && result.status === 'completed') queueMicrotask(() => {
        revoked = true;
        if (revoke === 'cancel') f.host.cancel(result.id); else closing = f.host.close();
      });
      return result;
    });
    const conversation = f.store.createConversation();
    const task = f.host.createWork({ requestId: 'gap-' + revoke, title: 'Synthetic gap', prompt: 'Synthetic interval', kind: 'research', conversationId: conversation.id, intervalMs: 60000, at: new Date(Date.now() - 60000).toISOString() });
    f.host.start();
    await until(() => revoked && f.host.work.runs(task.id).some(run => run.status === 'cancelled'));
    const run = f.host.work.runs(task.id)[0]!;
    assert.equal(f.host.work.result(run.id), undefined);
    assert.equal(f.store.messages(conversation.id).some(message => message.content.includes('GAP_PRIVATE_RESULT')), false);
    await closing;
  });
}

for (const operation of ['forget', 'correct'] as const) {
  test(`model ${operation} commits minimal receipt and confirms only that action without waiting on itself`, async t => {
    let saved!: { id: string; version: number }; let receipt: unknown;
    const f = fixture(t, async (_input, context) => {
      receipt = await context.callTool('memory_' + operation, { id: saved.id, authorizationQuote: operation === 'forget' ? '请忘掉指定记忆' : '请更正指定记忆，我喜欢白茶', ...(operation === 'correct' ? { text: '我喜欢白茶', expectedVersion: saved.version } : {}) });
      context.onText('UNTRUSTED_OLD_CONTINUATION');
      return { text: 'UNTRUSTED_OLD_FINAL' };
    });
    saved = f.host.memory.remember({ key: '饮品', text: '我喜欢桂花乌龙', source: { messageId: 'synthetic', conversationId: 'synthetic', createdAt: new Date().toISOString(), quote: '我喜欢桂花乌龙' } });
    const conversation = f.store.createConversation();
    const execution = f.host.submit(conversation.id, operation === 'forget' ? '请忘掉指定记忆' : '请更正指定记忆，我喜欢白茶', 'mutation-' + operation);
    await until(() => !['queued', 'running'].includes(f.store.execution(execution.id).status));
    const final = f.store.execution(execution.id);
    assert.equal(final.status, 'completed');
    assert.match(final.text, /本轮其余处理已停止/);
    assert.equal(final.text.includes('UNTRUSTED_OLD'), false);
    assert.deepEqual(Object.keys(receipt as object).sort(), ['id', 'operation', 'saved', 'version']);
    assert.equal((receipt as { saved: boolean }).saved, true);
    assert.equal(final.contextActions?.length, 1);
    assert.equal(final.contextFailure?.retryable, false);
    assert.deepEqual(final.contextFailure?.confirmedActionIds, final.contextActions!.map(action => action.actionId));
    assert.equal(JSON.stringify(final.contextActions).includes('桂花乌龙'), false);
    assert.ok(f.store.events(0, final.id).some(event => event.type === 'context.mutation_confirmation'));
    const count = f.store.executions().length;
    assert.throws(() => f.host.retryConversation(final.id), (error: unknown) => (error as { code: string }).code === 'retry_requires_new_request');
    assert.equal(f.store.executions().length, count);
  });
}

test('failed mutation neither revokes nor invents confirmation; a started write is never blindly replayed', async t => {
  let signalAborted = true; let activeId = ''; let activeVersion = 0;
  const f = fixture(t, async (_input, context) => {
    await assert.rejects(context.callTool('memory_correct', { id: 'missing-synthetic-id', text: '我喜欢白茶', expectedVersion: 1, authorizationQuote: '请更正指定记忆，我喜欢白茶' }));
    await assert.rejects(context.callTool('memory_correct', { id: activeId, text: '我喜欢白茶', expectedVersion: activeVersion + 1, authorizationQuote: '请更正指定记忆，我喜欢白茶' }), (error: unknown) => (error as { code: string }).code === 'STALE_VERSION');
    signalAborted = context.signal.aborted;
    throw new Error('Synthetic downstream unknown');
  });
  const saved = f.host.memory.remember({ key: '饮品', text: '我喜欢桂花乌龙', source: { messageId: 'synthetic-stale', conversationId: 'synthetic', createdAt: new Date().toISOString(), quote: '我喜欢桂花乌龙' } });
  activeId = saved.id; activeVersion = saved.version;
  const conversation = f.store.createConversation();
  const execution = f.host.submit(conversation.id, '请更正指定记忆，我喜欢白茶', 'failed-mutation');
  await until(() => !['queued', 'running'].includes(f.store.execution(execution.id).status));
  const final = f.store.execution(execution.id);
  assert.equal(signalAborted, false);
  assert.equal(f.host.memory.list().find(claim => claim.id === activeId)?.text, '我喜欢桂花乌龙');
  assert.equal(final.contextActions, undefined);
  assert.equal(f.store.events(0, final.id).some(event => event.type === 'context.mutation_confirmation'), false);
  assert.throws(() => f.host.retryConversation(final.id));
});

test('a committed memory receipt cannot turn unknown engine settlement into completed', async t => {
  let id = '';
  const f = fixture(t, async (_input, context) => {
    await context.callTool('memory_forget', { id, authorizationQuote: '请忘掉指定记忆' });
    const error = new Error('Synthetic shutdown not confirmed') as Error & { code: string }; error.code = 'ENGINE_OUTCOME_UNKNOWN'; throw error;
  });
  id = f.host.memory.remember({ key: '饮品', text: '我喜欢桂花乌龙', source: { messageId: 'synthetic', conversationId: 'synthetic', createdAt: new Date().toISOString(), quote: '我喜欢桂花乌龙' } }).id;
  const conversation = f.store.createConversation();
  const execution = f.host.submit(conversation.id, '请忘掉指定记忆', 'unknown-mutation');
  await until(() => !['queued', 'running'].includes(f.store.execution(execution.id).status));
  const final = f.store.execution(execution.id);
  assert.equal(final.status, 'unknown');
  assert.match(final.text, /已遗忘指定记忆/);
  assert.match(final.text, /尚无法确认/);
  assert.equal(f.host.memory.explain(id).stopped, true);
  assert.equal(final.contextActions?.length, 1);
});

test('queued memory is rejected at closure without invoking the engine and policy tightening invalidates pending ingestion', async t => {
  const gate = held(); let memoryCalls = 0; let started = false;
  const f = fixture(t, async input => { if (input.kind === 'memory') memoryCalls++; if (input.prompt === 'blocker') { started = true; await gate.promise; } return { text: '{}' }; });
  t.after(() => gate.release());
  const blocker = f.host.run('review', 'blocker', 'Synthetic contract'); void blocker.catch(() => {});
  await until(() => started);
  const memory = f.host.run('memory', 'queued capture', 'Only JSON'); const memoryRejected = assert.rejects(memory);
  f.host.setMemoryEnabled(false); gate.release(); await assert.rejects(blocker); await memoryRejected;
  assert.equal(memoryCalls, 0);
  f.host.setMemoryEnabled(true);
  const extractionGate = held(); let extractionStarted = false;
  const capture = f.host.memory.ingestWindow({ conversationId: 'synthetic-pending', throughSequence: 1, messages: [{ id: 'synthetic-source', role: 'user', content: '我喜欢桂花乌龙', createdAt: new Date().toISOString() }] }, async () => {
    extractionStarted = true; await extractionGate.promise;
    return JSON.stringify({ claims: [{ subject: '用户', key: '饮品', text: '我喜欢桂花乌龙', kind: 'preference', evidence: [{ messageId: 'synthetic-source', quote: '我喜欢桂花乌龙' }], scope: 'personal' }], relationships: [] });
  });
  await until(() => extractionStarted); f.host.setToolPolicy({ disabledTools: ['web_read'] }); extractionGate.release();
  const result = await capture;
  assert.notEqual(result.status, 'applied');
  assert.equal(f.host.memory.list().length, 0);
});

test('widening a tool policy leaves old initial grants fixed and the next execution receives new grants', async t => {
  let widen!: () => void; const gate = held(); let context!: ExecutionContext; const names: string[][] = [];
  const f = fixture(t, async (input, ctx) => { context = ctx; names.push(input.tools.map(tool => tool.name)); if (input.prompt === 'held') { widen(); await gate.promise; await assert.rejects(ctx.callTool('web_read', { url: 'https://example.invalid' })); } return { text: 'Synthetic done' }; });
  f.host.setToolPolicy({ disabledTools: ['web_read'] });
  let widened!: () => void; const widening = new Promise<void>(resolve => { widened = resolve; }); widen = () => { f.host.setToolPolicy({}); widened(); };
  const running = f.host.run('research', 'held', 'Synthetic contract'); await widening; assert.equal(context.signal.aborted, false); gate.release(); await running;
  await f.host.run('research', 'next', 'Synthetic contract');
  assert.equal(names[0]!.includes('web_read'), false); assert.equal(names[1]!.includes('web_read'), true);
});

test('an unknown earlier write preserves its real effect and prevents a later mutation receipt from masking uncertainty', async t => {
  let savedId = '';
  const f = fixture(t, async (_input, context) => {
    await assert.rejects(context.callTool('create_work', { title: 'Synthetic prior effect', prompt: 'Synthetic reminder', kind: 'reminder', at: '2099-01-01T00:00:00Z', authorizationQuote: '请提醒我检查价格' }));
    await context.callTool('memory_forget', { id: savedId, authorizationQuote: '请忘掉指定记忆' });
    return { text: 'Must not hide uncertainty' };
  });
  savedId = f.host.memory.remember({ key: '饮品', text: '我喜欢桂花乌龙', source: { messageId: 'synthetic', conversationId: 'synthetic', createdAt: new Date().toISOString(), quote: '我喜欢桂花乌龙' } }).id;
  const create = f.host.work.create.bind(f.host.work);
  t.mock.method(f.host.work, 'create', (...args: Parameters<typeof create>) => { create(...args); throw new Error('Synthetic transport stopped after a real commit'); });
  const conversation = f.store.createConversation();
  const execution = f.host.submit(conversation.id, '请提醒我检查价格，并请忘掉指定记忆', 'prior-write-unknown');
  await until(() => !['queued', 'running'].includes(f.store.execution(execution.id).status));
  const final = f.store.execution(execution.id);
  assert.equal(final.status, 'unknown');
  assert.equal(final.contextActions?.length, 1);
  assert.match(final.text, /尚无法确认/);
  assert.equal(f.host.work.list().some(task => task.title === 'Synthetic prior effect'), true);
  assert.equal(f.host.memory.explain(savedId).stopped, true);
  assert.throws(() => f.host.retryConversation(final.id));
});

test('budget stops expose stable safe metadata and do not create a retry execution', async t => {
  const f = fixture(t, async () => { const error = new Error('Synthetic budget stop') as Error & { code: string; requestSequence: number; estimatedInputTokens: number }; error.code = 'CONTEXT_BUDGET_EXCEEDED'; error.requestSequence = 2; error.estimatedInputTokens = 99999; throw error; });
  const conversation = f.store.createConversation();
  const execution = f.host.submit(conversation.id, 'Synthetic request', 'budget-stop');
  await until(() => !['queued', 'running'].includes(f.store.execution(execution.id).status));
  const final = f.store.execution(execution.id);
  assert.deepEqual(final.contextFailure, { code: 'CONTEXT_BUDGET_EXCEEDED', retryable: false, confirmedActionIds: [], requestSequence: 2, estimatedInputTokens: 99999 });
  const count = f.store.executions().length; assert.throws(() => f.host.retryConversation(final.id)); assert.equal(f.store.executions().length, count);
});

test('completed execution rejects saved text, event and tool callbacks without changing its persisted answer', async t => {
  let context!: ExecutionContext;
  const f = fixture(t, async (_input, ctx) => { context = ctx; return { text: 'Trusted settled answer' }; });
  const conversation = f.store.createConversation();
  const execution = f.host.submit(conversation.id, 'Synthetic request', 'completed-callback');
  await until(() => f.store.execution(execution.id).status === 'completed');
  const before = f.store.events(0, execution.id).length;
  context.onText('LATE_PRIVATE_TEXT'); context.onEvent({ type: 'late.engine.event', data: { marker: 'LATE_PRIVATE_EVENT' } });
  await assert.rejects(context.callTool('work_status', {}));
  assert.equal(f.store.execution(execution.id).text, 'Trusted settled answer');
  assert.equal(f.store.events(0, execution.id).length, before);
});


test('authenticated memory APIs preserve entity shapes; addition stays live, correction revokes and execution metadata blocks retry', async t => {
  const gate = held(); let context!: ExecutionContext;
  const f = fixture(t, async (_input, ctx) => { context = ctx; await gate.promise; return { text: 'Must not publish old output' }; });
  t.after(() => gate.release());
  const app = createRuntimeApp(f.host, () => {});
  const request = (path: string, method: string, body?: unknown) => app.request(path, { method, headers: { Authorization: 'Bearer ' + f.host.config.token, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const running = f.host.run('research', 'held API check', 'Synthetic contract'); void running.catch(() => {});
  await until(() => !!context);
  const addedResponse = await request('/api/agent/memories', 'POST', { text: '我喜欢桂花乌龙' });
  assert.equal(addedResponse.status, 201);
  const added = await addedResponse.json() as { id: string; text: string; version: number; source: string };
  assert.equal(added.text, '我喜欢桂花乌龙'); assert.equal(typeof added.version, 'number'); assert.equal(typeof added.source, 'string');
  assert.equal(context.signal.aborted, false, 'adding a fact is not a correction of existing context');
  const correctedResponse = await request('/api/memory/' + added.id, 'PATCH', { text: '我喜欢白茶', expectedVersion: added.version });
  assert.equal(correctedResponse.status, 200);
  const corrected = await correctedResponse.json() as { id: string; text: string; version: number };
  assert.equal(corrected.text, '我喜欢白茶'); assert.equal(typeof corrected.id, 'string');
  assert.equal(context.signal.aborted, true);
  gate.release(); await assert.rejects(running);
  const stopped = f.store.executions().find(execution => execution.kind === 'research')!;
  const response = await request('/api/executions/' + stopped.id, 'GET');
  const execution = await response.json() as { contextFailure: { code: string; retryable: boolean; confirmedActionIds: string[] } };
  assert.deepEqual(execution.contextFailure, { code: 'CONTEXT_INVALIDATED', retryable: false, confirmedActionIds: [] });
  assert.equal((await request('/api/executions/' + stopped.id + '/retry', 'POST')).status, 409);
});
