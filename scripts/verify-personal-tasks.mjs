import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TaskStore } from '../packages/personal-tasks/store.mjs';

const workspace = mkdtempSync(join(tmpdir(), 'kleio-tasks-store-'));
const create = (store, requestId = 'request') => store.create({ goal: '整理隔离验收文件', workspace, requestId }, { kind: 'test' });
test('durable tasks preserve neighboring application tables and idempotent creates', () => {
  const file = join(workspace, 'application.sqlite');
  const neighbor = new DatabaseSync(file); neighbor.exec('CREATE TABLE identity_test(value TEXT); INSERT INTO identity_test VALUES (\'preserve\')'); neighbor.close();
  const store = new TaskStore(file); const task = create(store); assert.equal(create(store).id, task.id);
  assert.throws(() => store.create({ goal: '另一项任务', workspace, requestId: 'request' }), { code: 'REQUEST_CONFLICT' });
  store.close(); const reopened = new TaskStore(file); assert.equal(reopened.get(task.id).status, 'queued');
  assert.equal(reopened.db.prepare('SELECT value FROM identity_test').get().value, 'preserve'); reopened.close();
});
test('new task titles summarize the first line/sentence without swallowing implementation paragraphs', () => {
  const store = new TaskStore(':memory:');
  const cases = [
    ['整理本周安排。然后读取多个文件并分析时间安排。', '整理本周安排'],
    ['生成活动报告\n请使用以下三十项详细技术约束。', '生成活动报告'],
    ['Review report.md for release 1.2. Then summarize findings.', 'Review report.md for release 1.2'],
    ['Find the next step? Include detailed calculations.', 'Find the next step'],
    ['长任务内容'.repeat(30), '长任务内容'.repeat(30).slice(0, 80)],
  ];
  for (const [goal, title] of cases) assert.equal(store.create({ goal, workspace }).title, title);
  const explicit = store.create({ goal: '这是很长的工作说明。后文不应修改命名。', title: '我自己的名称', workspace });
  assert.equal(explicit.title, '我自己的名称');
  store.save({ ...explicit, title: '旧记录保持原名，即使它有句尾。也不重新计算' });
  assert.equal(store.get(explicit.id).title, '旧记录保持原名，即使它有句尾。也不重新计算');
  store.close();
});
test('completion requires a receipt, keeps artifacts, and retains each attempt', () => {
  const store = new TaskStore(':memory:'); const task = create(store); const run = store.start(task.id, 'native-session-1');
  assert.throws(() => store.settle(run.id, 'completed'), { code: 'MISSING_RECEIPT' });
  const artifact = store.artifact(run.id, { path: join(workspace, 'report.md'), eventSeq: 15, sha256: 'verified-by-adapter' });
  assert.equal(store.artifact(run.id, { path: artifact.path, eventSeq: 15 }).id, artifact.id);
  store.finishReceipt(run.id, { summary: '真实成果', artifactIds: [artifact.id] }); store.settle(run.id, 'completed');
  assert.equal(store.detail(task.id).artifacts.length, 1); assert.equal(store.get(task.id).status, 'completed'); store.close();
});
test('uncertain execution is never automatically retried and retries are explicit/idempotent', () => {
  const store = new TaskStore(':memory:'); const task = create(store); const run = store.start(task.id, 'native-session-2'); store.dispatched(run.id);
  store.settle(run.id, 'failed', { uncertainEffects: true });
  assert.throws(() => store.retry(task.id), { code: 'INSPECTION_REQUIRED' });
  const retry = store.retry(task.id, { requestId: 'explicit-retry', acknowledgeUncertainEffects: true }); assert.equal(retry.status, 'queued');
  const second = store.start(task.id, 'native-session-3');
  assert.equal(store.retry(task.id, { requestId: 'explicit-retry', acknowledgeUncertainEffects: true }).runId, second.id);
  assert.equal(store.runs(task.id).length, 2); store.close();
});
test('interrupted native runs become inspection-required waiting instead of replaying', () => {
  const store = new TaskStore(':memory:'); const task = create(store); const run = store.start(task.id, 'native-session-4'); store.dispatched(run.id);
  store.recoverInterrupted(); const recovered = store.get(task.id);
  assert.equal(recovered.status, 'waiting'); assert.equal(recovered.waitingReason, 'host-interrupted'); assert.equal(recovered.uncertainEffects, true);
  assert.equal(store.list({ status: 'queued' }).length, 0); store.close();
});
test('a pending cancellation at crash remains uncertain until the earlier execution is inspected', () => {
  const store = new TaskStore(':memory:'); const task = create(store); const run = store.start(task.id, 'native-session-pending-cancel'); store.dispatched(run.id);
  store.requestCancel(task.id); store.recoverInterrupted();
  const recovered = store.get(task.id); assert.equal(recovered.status, 'waiting'); assert.equal(recovered.cancelRequested, true);
  assert.equal(recovered.waitingReason, 'host-interrupted'); assert.equal(recovered.uncertainEffects, true);
  assert.throws(() => store.retry(task.id), { code: 'INSPECTION_REQUIRED' }); store.close();
});
test('queued cancellation has no execution, and late old-run outcomes cannot overwrite retry', () => {
  const store = new TaskStore(':memory:'); const queued = create(store); store.requestCancel(queued.id); assert.equal(store.get(queued.id).status, 'cancelled'); assert.equal(store.runs(queued.id).length, 0);
  store.retry(queued.id, { requestId: 'retry-queued' }); const run = store.start(queued.id, 'native-session-5'); store.settle(run.id, 'failed');
  store.retry(queued.id, { requestId: 'retry-failed' }); const next = store.start(queued.id, 'native-session-6');
  store.settle(run.id, 'completed'); assert.equal(store.get(queued.id).runId, next.id); assert.equal(store.get(queued.id).status, 'running'); store.close();
});
