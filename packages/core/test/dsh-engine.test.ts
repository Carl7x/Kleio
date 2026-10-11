import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DshEngine } from '../../../apps/server/dsh-engine.ts';
import { AgentStore } from '../store.ts';
import { AgentService } from '../service.ts';
import { mkdtempSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const peer = fileURLToPath(new URL('./engine-fixture.mjs', import.meta.url));
test('product dsh mapping binds raw tool parameters to the review and saves committed text', async () => {
  const store = new AgentStore(':memory:'); const engine = new DshEngine({ command: process.execPath, args: [peer] }, process.cwd()); const service = new AgentService(store, engine);
  try {
    const { runId } = service.submit('approve');
    for (let i = 0; i < 200 && !store.approvals().length; i++) await delay(5);
    const approval = store.approvals()[0]; assert.ok(approval); assert.equal(approval.runId, runId);
    assert.deepEqual(approval.payload.rawInput, { file_path: 'isolated.txt', content: 'A' });
    assert.equal(store.run(runId).status, 'waiting_approval'); service.decide(approval.id, approval.hash, true);
    await service.wait(runId); assert.equal(store.run(runId).status, 'completed'); assert.match(store.artifacts()[0]!.content, /APPROVED-FIXTURE/);
    assert.ok(store.run(runId).sessionId);
  } finally { await service.close(); store.close(); }
});
test('bare toolCallId without reviewable parameters is denied by the product mapping', async () => {
  const store = new AgentStore(':memory:'); const engine = new DshEngine({ command: process.execPath, args: [peer] }, process.cwd()); const service = new AgentService(store, engine);
  try {
    const { runId } = service.submit('bare'); await service.wait(runId);
    assert.equal(store.approvals().length, 0); assert.match(store.artifacts()[0]!.content, /REJECTED-FIXTURE/);
  } finally { await service.close(); store.close(); }
});

test('approval accepted immediately before cancellation is still denied on the ACP wire', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-agent-permission-')); const record = join(directory, 'response.json');
  const store = new AgentStore(':memory:');
  const engine = new DshEngine({ command: process.execPath, args: [peer], env: { ...process.env, FIXTURE_PERMISSION_RECORD: record } }, process.cwd());
  const service = new AgentService(store, engine);
  try {
    const { runId } = service.submit('approve');
    for (let i = 0; i < 200 && !store.approvals().length; i++) await delay(5);
    const approval = store.approvals()[0]!; assert.ok(approval);
    service.decide(approval.id, approval.hash, true); service.cancel(runId);
    await service.wait(runId);
    assert.equal(JSON.parse(readFileSync(record, 'utf8')).outcome.optionId, 'no');
    assert.equal(store.run(runId).status, 'cancelled'); assert.equal(store.artifacts().length, 0);
  } finally { await service.close(); store.close(); rmSync(record, { force: true }); rmdirSync(directory); }
});

test('ACP acknowledgement confirms cancellation after a prompt has been dispatched', async () => {
  const store = new AgentStore(':memory:'); const engine = new DshEngine({ command: process.execPath, args: [peer] }, process.cwd());
  const service = new AgentService(store, engine);
  try {
    const { runId } = service.submit('hold');
    for (let i = 0; i < 200 && !store.events(runId).some(event => event.type === 'assistant.text'); i++) await delay(5);
    assert.ok(store.events(runId).some(event => event.type === 'assistant.text'));
    service.cancel(runId); await service.wait(runId);
    assert.equal(store.run(runId).status, 'cancelled'); assert.equal(store.run(runId).error, null);
  } finally { await service.close(); store.close(); }
});

test('ignored cancel followed by prompt timeout is unknown and an explicit retry uses a fresh session', async () => {
  const store = new AgentStore(':memory:');
  const engine = new DshEngine({ command: process.execPath, args: [peer], promptTimeoutMs: 150,
    env: { ...process.env, FIXTURE_IGNORE_CANCEL: '1' } }, process.cwd());
  const service = new AgentService(store, engine);
  try {
    const { taskId, runId } = service.submit('hold');
    for (let i = 0; i < 200 && !store.events(runId).some(event => event.type === 'assistant.text'); i++) await delay(5);
    const firstSession = store.run(runId).sessionId; assert.ok(firstSession);
    service.cancel(runId); await service.wait(runId);
    assert.equal(store.run(runId).status, 'interrupted'); assert.match(store.run(runId).error!, /结果未知/);
    assert.equal(store.run(runId).sessionId, null); assert.equal(store.runs().length, 1);
    const retry = service.restart(taskId); await service.wait(retry.runId);
    const nextSession = store.events(retry.runId).find(event => event.type === 'session.bound')?.data.sessionId;
    assert.ok(nextSession); assert.notEqual(nextSession, firstSession); assert.equal(store.artifacts().length, 0);
  } finally { await service.close(); store.close(); }
});

test('an unclosable unknown ACP session shuts down the runtime and blocks further work', async () => {
  const store = new AgentStore(':memory:');
  const engine = new DshEngine({ command: process.execPath, args: [peer], requestTimeoutMs: 300, promptTimeoutMs: 150, closeTimeoutMs: 30,
    env: { ...process.env, FIXTURE_IGNORE_CANCEL: '1', FIXTURE_IGNORE_CLOSE: '1' } }, process.cwd());
  const service = new AgentService(store, engine);
  try {
    const { taskId, runId } = service.submit('hold'); await service.wait(runId);
    assert.equal(store.run(runId).status, 'interrupted'); assert.equal(store.run(runId).sessionId, null);
    const retry = service.restart(taskId); await service.wait(retry.runId);
    assert.equal(store.run(retry.runId).status, 'failed'); assert.match(store.run(retry.runId).error!, /重启服务/);
    assert.ok(!store.events(retry.runId).some(event => event.type === 'session.bound'));
  } finally { await service.close(); store.close(); }
});

test('native history failure clears the cursor without silently submitting the task', async () => {
  const store = new AgentStore(':memory:'); const task = store.createTask('fresh task'); const previous = store.startRun(task.id, 'dsh-acp');
  store.setSession(previous.id, 'missing-native-history'); store.settle(previous.id, 'interrupted', 'inspect first');
  const engine = new DshEngine({ command: process.execPath, args: [peer] }, process.cwd()); const service = new AgentService(store, engine);
  try {
    const attempt = service.restart(task.id); await service.wait(attempt.runId);
    assert.equal(store.run(attempt.runId).status, 'interrupted'); assert.equal(store.run(attempt.runId).sessionId, null);
    assert.match(store.run(attempt.runId).error!, /本轮没有提交新的任务/); assert.equal(store.artifacts().length, 0);
    const retry = service.restart(task.id); await service.wait(retry.runId); assert.equal(store.run(retry.runId).status, 'completed');
    assert.notEqual(store.run(retry.runId).sessionId, 'missing-native-history');
  } finally { await service.close(); store.close(); }
});

test('only a fresh native session receives bounded application history as inert background', async () => {
  const engine = new DshEngine({ command: process.execPath, args: [peer] }, process.cwd());
  const abort = new AbortController(); let native: string | null = null;
  const context = { signal: abort.signal, onText() {}, onSession(id: string) { native = id; }, async requestApproval() { return false; } };
  try {
    const first = await engine.execute({ runId: 'one', prompt: 'current first request', memories: [], sessionId: null,
      history: [{ role: 'user', content: 'OLD-CONTEXT-MARKER' }] }, context);
    assert.match(first.text, /OLD-CONTEXT-MARKER/); assert.match(first.text, /不要重新执行/); assert.ok(native);
    const next = await engine.execute({ runId: 'two', prompt: 'current follow-up', memories: [], sessionId: native,
      history: [{ role: 'user', content: 'DO-NOT-DUPLICATE' }] }, context);
    assert.doesNotMatch(next.text, /DO-NOT-DUPLICATE/); assert.match(next.text, /current follow-up/);
  } finally { await engine.close(); }
});
