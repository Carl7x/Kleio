import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryController } from './controller.mjs';

const source = { sessionId: 'native-session', turnId: '1', messageId: 'native-user-message' };
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kleio-personal-'));
  const options = { applicationPath: join(dir, 'application.sqlite'), memoryPath: join(dir, 'memory.sqlite') };
  const controller = createMemoryController(options);
  t.after(async () => { await controller.close(); rmSync(dir, { recursive: true, force: true }); });
  return { controller, options };
}
function propose(controller, text = '喜欢无糖冷泡茶', key = '饮品偏好') {
  return controller.candidates.add({ subject: '用户', key, text, sourceQuote: '我长期喜欢喝无糖冷泡茶' }, source);
}

test('editable identity persists with optimistic version checks and separate profile instructions', async t => {
  const { controller, options } = fixture(t);
  const first = controller.profileGet();
  const changed = controller.profileSet({ expectedVersion: first.version, assistant: { name: '小木', instructions: '回答时先解释结论。' }, user: { name: '小林' } });
  assert.equal(changed.version, 2);
  assert.match(controller.profileContext(), /小木/);
  assert.match(controller.profileContext(), /工作指引/);
  assert.equal(controller.memoryList().length, 0);
  assert.throws(() => controller.profileSet({ expectedVersion: 1, captureEnabled: false }), { code: 'STALE_VERSION' });
  assert.throws(() => controller.profileSet({ expectedVersion: 2, user: { timeZone: 'not-a-zone' } }), { code: 'INVALID_INPUT' });
  await controller.close();
  const reopened = createMemoryController(options);
  assert.equal(reopened.profileGet().assistant.name, '小木');
  assert.equal(reopened.profileGet().version, 2);
  await reopened.close();
});

test('candidates stay out of recall until review, preserve original provenance, and accept retries create no extra revision', t => {
  const { controller } = fixture(t);
  const candidate = propose(controller);
  assert.equal(controller.memory.search({ query: '冷泡茶' }).length, 0);
  assert.equal(controller.candidatesList().length, 1);
  const accepted = controller.candidatesAccept({ id: candidate.id, expectedVersion: 1 });
  assert.equal(accepted.candidate.status, 'accepted');
  assert.deepEqual(accepted.memory.source, source);
  assert.equal(accepted.memory.reviewActionId, accepted.candidate.reviewActionId);
  const audit = controller.db.prepare('SELECT kind FROM app_actions WHERE id=?').get(accepted.memory.reviewActionId);
  assert.equal(audit.kind, 'candidate.accept');
  assert.equal(controller.candidatesList().length, 0);
  const retry = controller.candidatesAccept({ id: candidate.id, expectedVersion: 1 });
  assert.equal(retry.memory.id, accepted.memory.id);
  assert.equal(controller.memoryHistory({ id: accepted.memory.id }).length, 1);
  assert.equal(controller.memoryList().length, 1);
});

test('changing facts requires an explicit review of the current memory version', t => {
  const { controller } = fixture(t);
  const original = controller.memory.remember({ subject: '用户', key: '饮品偏好', text: '喜欢红茶' }, source);
  const candidate = propose(controller);
  assert.deepEqual(controller.candidatesList()[0].conflict, { id: original.id, version: 1, text: '喜欢红茶' });
  assert.throws(() => controller.candidatesAccept({ id: candidate.id, expectedVersion: 1 }), { code: 'MEMORY_CONFLICT' });
  controller.memory.correct({ id: original.id, expectedVersion: 1, text: '喜欢绿茶' }, source);
  assert.throws(() => controller.candidatesAccept({ id: candidate.id, expectedVersion: 1, mode: 'correct', memoryId: original.id, memoryVersion: 1 }), { code: 'STALE_VERSION' });
  const accepted = controller.candidatesAccept({ id: candidate.id, expectedVersion: 1, mode: 'correct', memoryId: original.id, memoryVersion: 2 });
  assert.equal(accepted.memory.version, 3);
  assert.equal(controller.memoryList().length, 1);
  assert.equal(accepted.memory.text, candidate.text);
});

test('rejection blocks automatic re-proposals for the slot, while explicit memory stays available', async t => {
  const { controller, options } = fixture(t);
  const first = propose(controller), second = propose(controller, '喜欢薄荷冷泡茶');
  controller.candidatesReject({ id: first.id, expectedVersion: 1 });
  assert.equal(controller.candidatesList().length, 0);
  assert.equal(controller.candidatesList({ status: 'rejected' }).length, 2);
  assert.equal(propose(controller, '喜欢其它茶'), null);
  assert.throws(() => controller.candidatesAccept({ id: second.id, expectedVersion: 2 }), { code: 'CANDIDATE_REJECTED' });
  await controller.close();
  const reopened = createMemoryController(options);
  assert.equal(propose(reopened, '又喜欢红茶'), null);
  assert.equal(reopened.memory.remember({ subject: '用户', key: '饮品偏好', text: '用户明确要求保存的红茶' }, source).version, 1);
  await reopened.close();
});

test('native forget invalidates pending candidates; old receipts do not restore deleted facts', t => {
  const { controller } = fixture(t);
  const original = controller.memory.remember({ subject: '用户', key: '饮品偏好', text: '喜欢红茶' }, source);
  const pending = propose(controller);
  controller.memory.forget({ id: original.id, expectedVersion: 1 }, source);
  assert.throws(() => controller.candidatesAccept({ id: pending.id, expectedVersion: 1 }), { code: 'FORGOTTEN_FACT' });
  assert.equal(controller.candidatesList().length, 0);
  assert.equal(propose(controller, '喜欢新的茶'), null);
  const other = propose(controller, '每晚读书', '阅读习惯');
  const accepted = controller.candidatesAccept({ id: other.id, expectedVersion: 1 });
  controller.memoryForget({ id: accepted.memory.id, expectedVersion: 1 });
  controller.candidatesAccept({ id: other.id, expectedVersion: 1 });
  assert.equal(controller.memoryGet({ id: accepted.memory.id }).deleted, true);
  assert.equal(controller.memory.search({ query: '读书' }).length, 0);
});

test('facts-side receipt recovers a lost application commit without replaying or losing the review audit', t => {
  const { controller } = fixture(t);
  const candidate = propose(controller);
  const receipt = controller.memory.acceptReviewedCandidate({ ...candidate, mode: 'create' }, candidate.source, 'interrupted-review-action');
  // Simulates the only committed part of a cross-database accept: durable formal fact + receipt.
  assert.equal(controller.candidates.get(candidate.id).status, 'pending');
  assert.equal(controller.candidatesList().length, 0);
  const accepted = controller.candidatesList({ status: 'accepted' })[0];
  assert.equal(accepted.memoryId, receipt.record.id);
  assert.equal(controller.db.prepare('SELECT COUNT(*) AS n FROM app_actions WHERE id=?').get(receipt.reviewActionId).n, 1);
  const replay = controller.candidatesAccept({ id: candidate.id, expectedVersion: 1 });
  assert.equal(replay.memory.id, receipt.record.id);
  assert.equal(controller.memoryHistory({ id: receipt.record.id }).length, 1);
  assert.throws(() => controller.candidatesAccept({ id: candidate.id, expectedVersion: 1, mode: 'correct', memoryId: receipt.record.id, memoryVersion: 1 }), { code: 'REVIEW_CONFLICT' });
});

test('UI corrections, forgetting and restoring use auditable app actions, never fake native messages', t => {
  const { controller } = fixture(t);
  const fact = controller.memory.remember({ subject: '用户', key: '阅读习惯', text: '每晚读书' }, source);
  const corrected = controller.memoryCorrect({ id: fact.id, expectedVersion: 1, text: '每天早上读书' });
  assert.equal(corrected.source.kind, 'app-ui');
  assert.equal(corrected.source.sessionId, 'app:ui');
  assert.equal(corrected.source.messageId, undefined);
  assert.equal(controller.db.prepare('SELECT kind FROM app_actions WHERE id=?').get(corrected.source.turnId).kind, 'memory.correct');
  const deleted = controller.memoryForget({ id: fact.id, expectedVersion: 2 });
  assert.equal(controller.memoryList().length, 0);
  assert.equal(controller.memoryList({ includeDeleted: true })[0].version, 3);
  const restored = controller.memoryRestore({ id: fact.id, expectedVersion: deleted.version, targetVersion: 1 });
  assert.equal(restored.version, 4); assert.equal(restored.deleted, false);
  assert.equal(restored.text, '每晚读书');
  assert.equal(controller.memoryHistory({ id: fact.id })[0].source.messageId, source.messageId);
  assert.throws(() => controller.memoryCorrect({ id: fact.id, expectedVersion: 4, text: '密码是 secret' }), { code: 'SECRET_NOT_ALLOWED' });
});

test('management query filters before applying the result limit and explicit IDs cannot escape personal scope', t => {
  const { controller } = fixture(t);
  const old = controller.memory.remember({ subject: '用户', key: '很早的喜好', text: '独特冷泡茶' }, source);
  for (let i = 0; i < 101; i++) controller.memory.remember({ subject: '用户', key: `事实${i}`, text: `新条目${i}` }, source);
  assert.equal(controller.memoryList({ query: '独特', limit: 1 })[0].id, old.id);
  const work = controller.memory.remember({ subject: '公司', key: '测试', text: '内部项目', scope: 'work' }, source);
  assert.throws(() => controller.memoryGet({ id: work.id }), { code: 'NOT_FOUND' });
  assert.throws(() => controller.memoryForget({ id: work.id, expectedVersion: 1 }), { code: 'NOT_FOUND' });
});
