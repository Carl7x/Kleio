import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentStore } from '../store.ts';
import { AgentService, DemoEngine } from '../service.ts';
import { CoreError, type AgentEngine } from '../contracts.ts';

function fixture(t: TestContext): AgentStore { const store = new AgentStore(':memory:'); t.after(() => store.close()); return store; }
const hasCode = (code: string) => (error: unknown): boolean => error instanceof CoreError && error.code === code;

test('Chinese paraphrase recalls lexical evidence without modifying facts', t => {
  const store = fixture(t); const first = store.addMemory('我喜欢短回复', '用户明确说明');
  assert.equal(store.recall('你还记得我喜欢怎样的回复吗')[0]?.id, first.id);
  const second = store.addMemory('我对花生过敏', '用户明确说明');
  assert.ok(store.recall('我对花生过敏，请以后记住').some(memory => memory.id === second.id));
});
test('numbers, negation and opposing relations remain independent records', t => {
  const store = fixture(t);
  store.addMemory('Alice 欠 Bob 100 元', 'source A'); store.addMemory('Bob 不欠 Alice 9000 元', 'source B');
  assert.equal(store.memories().length, 2); assert.equal(store.memories()[0]?.text, 'Bob 不欠 Alice 9000 元');
});
test('memory scope prevents personal recall from returning project records', t => {
  const store = fixture(t); store.addMemory('预算 100 元', 'project source', 'project:a');
  assert.equal(store.recall('预算是多少').length, 0); assert.equal(store.recall('预算是多少', 'project:a').length, 1);
});
test('optimistic edit rejects stale version; undo retains a new revision', t => {
  const store = fixture(t); const old = store.addMemory('预算 100 元', 'message:1');
  const changed = store.editMemory(old.id, 1, '预算 200 元', 'message:2');
  assert.throws(() => store.editMemory(old.id, 1, '预算 9000 元', 'stale'), hasCode('memory_conflict'));
  const restored = store.undoMemory(old.id, changed.version);
  assert.equal(restored.text, old.text); assert.equal(restored.source, old.source); assert.equal(restored.version, 3);
  assert.equal(store.memoryHistory(old.id).length, 3);
});
test('soft deletion removes recall and can be explicitly undone', t => {
  const store = fixture(t); const memory = store.addMemory('我喜欢短回复', 'message:1');
  store.deleteMemory(memory.id, 1); assert.equal(store.recall('短回复').length, 0);
  store.undoMemory(memory.id, 2); assert.equal(store.recall('短回复').length, 1);
});
test('completed artifact and task status are committed together; replay uses durable sequence', t => {
  const store = fixture(t); const task = store.createTask('资料调研'); const run = store.startRun(task.id, 'demo');
  store.appendText(run.id, '进行中'); const artifact = store.complete(run.id, '# 报告');
  assert.equal(store.task(task.id).status, 'completed'); assert.equal(store.artifacts()[0]?.id, artifact.id);
  const events = store.events(run.id); assert.equal(events.at(-1)?.type, 'run.completed');
  assert.deepEqual(store.events(run.id, events[0]!.sequence), events.slice(1));
  assert.throws(() => store.complete(run.id, '迟到成果'), hasCode('run_settled'));
  assert.equal(store.artifacts().length, 1);
});
test('concurrent launch of the same task is rejected', t => {
  const store = fixture(t); const task = store.createTask('task'); store.startRun(task.id, 'one');
  assert.throws(() => store.startRun(task.id, 'two'), hasCode('already_running')); assert.equal(store.runs().length, 1);
});
test('stale approval hash and duplicate decision cannot authorize work', t => {
  const store = fixture(t); const run = store.startRun(store.createTask('审批').id, 'demo');
  const approval = store.propose(run.id, 'demo', { amount: 100, account: 'fixture' });
  assert.throws(() => store.decide(approval.id, 'old-hash', true), hasCode('stale_approval'));
  assert.equal(store.decide(approval.id, approval.hash, true).status, 'approved');
  assert.throws(() => store.decide(approval.id, approval.hash, true), hasCode('approval_settled'));
});
test('expired proposal is recorded as expired rather than approved', t => {
  const store = fixture(t); const run = store.startRun(store.createTask('审批').id, 'demo');
  const approval = store.propose(run.id, 'demo', {}, -1);
  assert.equal(store.decide(approval.id, approval.hash, true).status, 'expired');
});
test('pending approval prevents completion; cancellation invalidates the review', t => {
  const store = fixture(t); const run = store.startRun(store.createTask('审批').id, 'demo'); const approval = store.propose(run.id, 'demo', {});
  assert.throws(() => store.complete(run.id, '提前完成'), hasCode('approval_pending'));
  store.settle(run.id, 'cancelled', null); assert.equal(store.approvals()[0]?.status, 'interrupted');
  assert.throws(() => store.decide(approval.id, approval.hash, true), hasCode('approval_settled'));
});
test('database reopen preserves memory and results; unfinished work requires confirmation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-agent-core-')); const file = join(directory, 'state.sqlite');
  let store = new AgentStore(file);
  t.after(() => { store.close(); for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true }); rmdirSync(directory); });
  const task = store.createTask('审批'); const run = store.startRun(task.id, 'dsh');
  store.setSession(run.id, 'native-session'); store.propose(run.id, 'permission', { command: 'fixture' });
  store.addMemory('我喜欢短回复', 'user'); store.close(); store = new AgentStore(file);
  assert.equal(store.recoverInterrupted(), 1); assert.equal(store.task(task.id).status, 'interrupted');
  assert.equal(store.approvals()[0]?.status, 'interrupted'); assert.equal(store.memories().length, 1);
  assert.equal(store.recoverInterrupted(), 0); const next = store.startRun(task.id, 'dsh');
  assert.equal(next.sessionId, 'native-session'); assert.notEqual(next.id, run.id);
});
test('service delivers deterministic result with recalled source', async t => {
  const store = fixture(t); store.addMemory('我喜欢短回复', 'message:1'); const service = new AgentService(store, new DemoEngine(1));
  const { runId } = service.submit('回复保持简短'); await service.wait(runId);
  assert.equal(store.run(runId).status, 'completed'); assert.match(store.artifacts()[0]!.content, /message:1/); await service.close();
});
test('service approval can be rejected without generating an artifact', async t => {
  const store = fixture(t); const service = new AgentService(store, new DemoEngine(1)); const { runId } = service.submit('验证审批');
  for (let i = 0; i < 100 && !store.approvals().length; i++) await delay(2);
  const approval = store.approvals()[0]!; assert.ok(approval); service.decide(approval.id, approval.hash, false); await service.wait(runId);
  assert.equal(store.run(runId).status, 'failed'); assert.equal(store.artifacts().length, 0); await service.close();
});
test('cancel one run preserves a different run and fences late output', async t => {
  const store = fixture(t); const service = new AgentService(store, new DemoEngine(10));
  const first = service.submit('first'); const second = service.submit('second'); service.cancel(first.runId);
  await Promise.all([service.wait(first.runId), service.wait(second.runId)]);
  assert.equal(store.run(first.runId).status, 'cancelled'); assert.equal(store.run(second.runId).status, 'completed');
  assert.equal(store.artifacts().length, 1); assert.throws(() => store.appendText(first.runId, 'late'), hasCode('run_settled')); await service.close();
});
test('cancellation stays pending until the engine settles and cannot be immediately restarted', async t => {
  const store = fixture(t); const service = new AgentService(store, new DemoEngine(10)); const { taskId, runId } = service.submit('task');
  service.cancel(runId); assert.equal(store.run(runId).status, 'cancelling');
  assert.throws(() => service.restart(taskId), hasCode('already_running'));
  await service.wait(runId); assert.equal(store.run(runId).status, 'cancelled');
  const retry = service.restart(taskId); await service.wait(retry.runId); assert.equal(store.run(retry.runId).status, 'completed'); await service.close();
});
test('engine error is durable and does not fabricate success', async t => {
  const store = fixture(t); const engine: AgentEngine = { id: 'failure', capabilities: { cancel: true, permissions: true, resume: false, steer: false },
    async execute() { throw new Error('transport lost; external outcome unverified'); }, async close() {} };
  const service = new AgentService(store, engine); const { runId } = service.submit('task'); await service.wait(runId);
  assert.equal(store.run(runId).status, 'failed'); assert.match(store.run(runId).error!, /unverified/); assert.equal(store.artifacts().length, 0); await service.close();
});

test('engine failure clears approval waiters before their deadline', async t => {
  const store = fixture(t); let decision: boolean | undefined;
  const engine: AgentEngine = { id: 'failure-during-review', capabilities: { cancel: true, permissions: true, resume: false, steer: false },
    async execute(_input, context) {
      void context.requestApproval('write', { path: 'isolated' }).then(allowed => { decision = allowed; });
      throw new Error('transport disconnected during approval');
    }, async close() {} };
  const service = new AgentService(store, engine, { approvalLifetimeMs: 15 });
  const { runId } = service.submit('task'); await service.wait(runId); await delay(30);
  const approval = store.approvals()[0]!;
  assert.equal(store.run(runId).status, 'failed'); assert.equal(approval.status, 'interrupted'); assert.equal(decision, false);
  assert.throws(() => service.decide(approval.id, approval.hash, true), hasCode('approval_offline'));
  await service.close();
});

test('abort followed by transport loss remains unknown and discards the native cursor', async t => {
  const store = fixture(t); let rejectExecution: (error: Error) => void = () => {};
  const engine: AgentEngine = { id: 'remote', capabilities: { cancel: true, permissions: false, resume: true, steer: false },
    async execute(_input, context) {
      context.onSession('unknown-native');
      return new Promise((_resolve, reject) => { rejectExecution = reject; });
    }, async close() {} };
  const service = new AgentService(store, engine); const { taskId, runId } = service.submit('task');
  await delay(0); service.cancel(runId); rejectExecution(new Error('transport lost'));
  await service.wait(runId);
  assert.equal(store.run(runId).status, 'interrupted'); assert.equal(store.run(runId).sessionId, null);
  assert.match(store.run(runId).error!, /结果未知/); assert.equal(store.artifacts().length, 0);
  assert.equal(store.events(runId).at(-1)?.data.invalidatedSessionId, 'unknown-native');
  assert.equal(store.startRun(taskId, 'remote').sessionId, null);
  // The deliberately created next Run has no live execution handle.
  store.recoverInterrupted(); await service.close();
});
