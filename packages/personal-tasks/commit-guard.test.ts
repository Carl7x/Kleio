import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { WorkRuntime, type WorkCallbacks, type WorkExecution } from './runtime.ts';
const source = { kind: 'user' as const, conversationId: 'synthetic-conversation', messageId: 'synthetic-message' };
const result = { text: 'OLD_OUTPUT_SENTINEL', evidence: [{ kind: 'url' as const, reference: 'https://example.com/source' }], follow: { judgment: 'changed' as const, fields: [{ key: 'price', value: '20' }] } };
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function harness(periodic = false) {
  const db = new DatabaseSync(':memory:'); let now = Date.parse('2026-10-19T00:00:00Z');
  const work = new WorkRuntime(db, { now: () => now, recover: false });
  const task = work.create({ requestId: 'request', title: 'task', prompt: 'research', kind: 'research', at: new Date(now).toISOString(), ...(periodic ? { schedule: { expression: '* * * * *', timeZone: 'UTC' } } : {}) }, source);
  const delivered: string[] = [];
  const deliver: NonNullable<WorkCallbacks['deliver']> = input => { delivered.push(input.text); return { messageId: 'message' }; };
  return { db, work, task, delivered, deliver, advance() { now += 60000; } };
}
for (const stage of ['research', 'review', 'followup'] as const) {
  for (const throws of [false, true]) test(`${stage} commit rejects changed epoch after await ${throws ? 'rejection' : 'return'}`, async () => {
    const h = harness(stage === 'followup'); const pending = deferred<any>(); const ready = deferred<void>();
    let epoch = 1;
    const bind = (execution: WorkExecution) => { const born = epoch; execution.bindCommitGuard!(() => epoch === born); ready.resolve(); return pending.promise; };
    const callbacks: WorkCallbacks = { deliver: h.deliver, runResearch: stage === 'review' ? async () => result : bind,
      review: stage === 'review' ? bind : async () => ({ decision: 'notify', text: 'review' }) };
    const tick = h.work.tick(callbacks); await ready.promise;
    if (throws) pending.reject(new Error('old engine error')); else pending.resolve(stage === 'review' ? { decision: 'notify', text: 'OLD_REVIEW_SENTINEL' } : result);
    epoch++; // Promise is settled, but WorkRuntime's post-await commit has not run.
    await tick;
    const run = h.work.runs(h.task.id)[0]!;
    assert.equal(run.status, 'cancelled'); assert.equal(run.errorCode, 'CONTEXT_INVALIDATED'); assert.equal(run.claimToken, null);
    assert.deepEqual(h.delivered, []); assert.equal(h.work.notifications().length, 0); assert.equal(h.work.reviewResult(run.id), undefined);
    if (stage !== 'review') assert.equal(h.work.result(run.id), undefined);
    assert.equal(h.work.get(h.task.id).baseline, null);
    await h.work.tick(callbacks); assert.equal(h.work.runs(h.task.id).length, 1);
    if (stage === 'followup') {
      assert.equal(h.work.get(h.task.id).status, 'active'); h.advance();
      await h.work.tick({ ...callbacks, runResearch: async () => result });
      assert.equal(h.work.runs(h.task.id).length, 2);
      assert.ok(h.work.get(h.task.id).baseline?.length);
    }
    h.db.close();
  });
}
test('guard throwing fails closed', async () => {
  const h = harness(); const pending = deferred<any>(); const ready = deferred<WorkExecution>();
  const tick = h.work.tick({ deliver: h.deliver, runResearch: execution => { execution.bindCommitGuard!(() => { throw Error('unavailable policy'); }); ready.resolve(execution); return pending.promise; }, review: async () => ({ decision: 'notify', text: 'x' }) });
  await ready.promise; pending.resolve(result); await tick;
  assert.equal(h.work.runs(h.task.id)[0]!.errorCode, 'CONTEXT_INVALIDATED'); assert.deepEqual(h.delivered, []); h.db.close();
});
test('binding twice is rejected and cannot replace the original guard', async () => {
  const h = harness();
  await h.work.tick({ deliver: h.deliver, runResearch: async execution => { execution.bindCommitGuard!(() => false); assert.throws(() => execution.bindCommitGuard!(() => true), /only one/); return result; }, review: async () => ({ decision: 'notify', text: 'x' }) });
  assert.equal(h.work.runs(h.task.id)[0]!.errorCode, 'CONTEXT_INVALIDATED'); h.db.close();
});
for (const code of ['CONTEXT_BUDGET_EXCEEDED', 'CONTEXT_STATE_MISMATCH']) test(`${code} review failure never retries same execution`, async () => {
  const h = harness(); let reviews = 0;
  const callbacks: WorkCallbacks = { deliver: h.deliver, runResearch: async () => result, review: async execution => { execution.bindCommitGuard!(() => true); reviews++; throw Object.assign(Error('fixed failure'), { code }); } };
  await h.work.tick(callbacks); h.advance(); await h.work.tick(callbacks);
  assert.equal(reviews, 1); assert.equal(h.work.runs(h.task.id)[0]!.status, 'failed'); assert.equal(h.work.runs(h.task.id)[0]!.errorCode, code); assert.deepEqual(h.delivered, []); h.db.close();
});
test('unbound legacy callbacks retain normal result/review/delivery behavior', async () => {
  const h = harness();
  await h.work.tick({ deliver: h.deliver, runResearch: async () => result, review: async () => ({ decision: 'notify', text: 'review' }) });
  assert.equal(h.work.runs(h.task.id)[0]!.status, 'completed'); assert.equal(h.delivered.length, 1); h.db.close();
});
test('Host abort does not hide invalidated-claim settlement on failure', async () => {
  const h = harness(); const pending = deferred<any>(); const ready = deferred<void>(); let valid = true;
  const tick = h.work.tick({ deliver: h.deliver, runResearch: execution => { execution.bindCommitGuard!(() => valid); ready.resolve(); return pending.promise; }, review: async () => ({ decision: 'notify', text: 'x' }) });
  await ready.promise; valid = false; const stopping = h.work.stop(); pending.reject(Error('cancelled callback')); await Promise.all([tick, stopping]);
  assert.equal(h.work.runs(h.task.id)[0]!.status, 'cancelled'); assert.equal(h.work.runs(h.task.id)[0]!.errorCode, 'CONTEXT_INVALIDATED'); assert.deepEqual(h.delivered, []); h.db.close();
});
