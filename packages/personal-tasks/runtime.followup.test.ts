import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { WorkRuntime, WorkRuntimeError, type WorkCallbacks, type WorkDeliveryRequest, type WorkSource } from './runtime.ts';

const source: WorkSource = { kind: 'user', conversationId: 'conv-1', messageId: 'msg-1' };
const priceUrl = { kind: 'url' as const, reference: 'https://example.com/price', title: '价格页' };
const nextUrl = { kind: 'url' as const, reference: 'https://example.com/price-new', title: '新价格' };
const everyMinute = { expression: '* * * * *', timeZone: 'UTC' };
const weekdays = { expression: '0 9 * * MON-FRI', timeZone: 'Asia/Shanghai' };

function harness(start = '2026-10-15T00:00:00.000Z') {
  const db = new DatabaseSync(':memory:');
  let now = Date.parse(start);
  const work = new WorkRuntime(db, { now: () => now, recover: false, maxConcurrent: 2 });
  const messages: string[] = [];
  const deliver = (input: WorkDeliveryRequest) => {
    messages.push(input.text);
    return { messageId: `message-${messages.length}` };
  };
  return { db, work, messages, deliver, setNow(value: string) { now = Date.parse(value); }, advance(ms: number) { now += ms; } };
}
function callbacks(deliver: NonNullable<WorkCallbacks['deliver']>, runResearch: WorkCallbacks['runResearch']): WorkCallbacks {
  return { deliver, runResearch, review: async () => { throw new Error('a periodic check does not use the one-shot review'); } };
}
function gate() {
  let open!: () => void;
  let ready!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  const started = new Promise<void>(resolve => { ready = resolve; });
  return { promise, open, started, ready };
}
const price = (value: string) => ({ key: '价格', value, label: '价格' });

test('an unchanged price stays quiet, including a reworded amount', async () => {
  const { work, messages, deliver, setNow } = harness();
  const task = work.create({ requestId: 'quiet', title: '价格', prompt: '只在价格变化时说', kind: 'research', at: '2026-10-15T00:00:00.000Z', schedule: everyMinute }, source);
  assert.equal(task.nextAt, '2026-10-15T00:00:00.000Z');
  assert.equal(work.snapshot(task.id).progress, 'queued');
  assert.equal(work.snapshot(task.id).onlyOnChange, true);
  assert.equal(work.snapshot(task.id).watch, 'periodic-search');
  assert.match(work.snapshot(task.id).watchNote ?? '', /不是实时/);
  const run = callbacks(deliver, async () => ({ text: '我重新写了一遍，价格还是九十九', evidence: [priceUrl], follow: { judgment: 'changed', fields: [price('99元')] } }));
  await work.tick(run);
  assert.equal(messages.length, 0);
  assert.equal(work.notifications().length, 0);
  const checked = work.snapshot(task.id);
  assert.equal(checked.progress, 'checked');
  assert.equal(checked.progressLabel, '已检查');
  assert.equal(checked.lastCheck, 'silent');
  assert.equal(checked.delivered, false);
  assert.equal(checked.lastCheckedAt, '2026-10-15T00:00:00.000Z');
  assert.equal(checked.nextAt, '2026-10-15T00:01:00.000Z');
  assert.throws(() => work.markRead(task.id), (error: unknown) => error instanceof WorkRuntimeError && error.code === 'NOT_DELIVERED');
  setNow('2026-10-15T00:01:00.000Z');
  await work.tick(callbacks(deliver, async () => ({ text: '完全不同的措辞，见 https://evil.example/fake', evidence: [priceUrl], follow: { judgment: 'changed', note: '看起来变了 https://evil.example/fake', fields: [price('¥99'), { key: '备注', value: '措辞不同但没有新字段值', label: '备注' }] } })));
  assert.equal(messages.length, 0);
  assert.equal(work.snapshot(task.id).progress, 'checked');
  assert.equal(work.snapshot(task.id).lastCheckedAt, '2026-10-15T00:01:00.000Z');
  assert.equal(work.deliveries(task.id).length, 0);
  await work.stop();
});

test('a verifiable price change is written once with the difference and the searched source', async () => {
  const { work, messages, deliver, setNow, advance } = harness();
  const task = work.create({ requestId: 'change', title: '价格', prompt: '看价格', kind: 'research', at: '2026-10-15T00:00:00.000Z', schedule: everyMinute }, source);
  await work.tick(callbacks(deliver, async () => ({ text: '基线', evidence: [priceUrl], follow: { fields: [price('99元'), { key: '版本', value: 'v1.2.0', label: '版本' }] } })));
  assert.equal(messages.length, 0);
  setNow('2026-10-15T00:01:00.000Z');
  const changed = callbacks(deliver, async () => ({ text: '涨了，假链接 https://evil.example/fake', evidence: [nextUrl], follow: { judgment: 'unchanged', fields: [price('128元'), { key: '版本', value: '1.2', label: '版本' }] } }));
  await work.tick(changed);
  await work.tick(changed);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /有变化/);
  assert.match(messages[0]!, /价格：99元 → 128元/);
  assert.match(messages[0]!, /https:\/\/example\.com\/price-new/);
  assert.doesNotMatch(messages[0]!, /evil\.example/);
  assert.doesNotMatch(messages[0]!, /版本/);
  assert.match(messages[0]!, /不是实时盯着/);
  const view = work.snapshot(task.id);
  assert.equal(view.progress, 'written');
  assert.equal(view.delivered, true);
  assert.equal(view.read, false);
  assert.equal(view.lastCheck, 'written');
  assert.equal(view.delivery?.evidence[0]?.reference, 'https://example.com/price-new');
  advance(1);
  const read = work.markRead(task.id);
  assert.notEqual(read.readAt, read.writtenAt);
  assert.equal(work.snapshot(task.id).read, true);
  assert.equal(work.snapshot(task.id).progress, 'written');
  assert.equal(messages.length, 1);
  setNow('2026-10-15T00:02:00.000Z');
  await work.tick(callbacks(deliver, async () => ({ text: '还是 128', evidence: [nextUrl], follow: { fields: [price('¥128'), { key: '版本', value: '1.2.0', label: '版本' }] } })));
  assert.equal(messages.length, 1);
  assert.equal(work.snapshot(task.id).progress, 'checked');
  setNow('2026-10-15T00:03:00.000Z');
  await work.tick(callbacks(deliver, async () => ({ text: '又涨了', evidence: [nextUrl], follow: { fields: [price('140元'), { key: '版本', value: '1.2', label: '版本' }] } })));
  assert.equal(messages.length, 2);
  assert.match(messages[1]!, /128元 → 140元/);
  assert.equal(work.deliveries(task.id).length, 2);
  assert.equal(work.notifications().length, 0);
  await work.stop();
});

test('pause does not fire and resume waits for the next slot', async () => {
  const { work, messages, deliver, setNow } = harness();
  const task = work.create({ requestId: 'pause', title: '价格', prompt: '看价格', kind: 'research', at: '2026-10-15T00:00:00.000Z', schedule: everyMinute }, source);
  const paused = work.pause(task.id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.nextAt, null);
  setNow('2026-10-20T00:00:00.000Z');
  await work.tick(callbacks(deliver, async () => { throw new Error('paused follow-up must not run'); }));
  assert.equal(work.runs(task.id).length, 0);
  assert.equal(messages.length, 0);
  const view = work.snapshot(task.id);
  assert.equal(view.progress, 'stopped');
  assert.equal(view.hold, 'paused');
  assert.equal(view.delivered, false);
  const resumed = work.resume(task.id);
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.nextAt, '2026-10-20T00:01:00.000Z');
  await work.tick(callbacks(deliver, async () => { throw new Error('resume must not replay the paused slot'); }));
  assert.equal(work.runs(task.id).length, 0);
  setNow('2026-10-20T00:01:00.000Z');
  await work.tick(callbacks(deliver, async () => ({ text: '恢复后的基线', evidence: [priceUrl], follow: { fields: [price('99元')] } })));
  assert.equal(messages.length, 0);
  assert.equal(work.snapshot(task.id).progress, 'checked');
  await work.stop();
});

test('revising an in-flight check keeps one later result and drops the old one', async () => {
  const { work, messages, deliver, setNow } = harness();
  const task = work.create({ requestId: 'revise', title: '价格', prompt: '看旧条件', kind: 'research', at: '2026-10-15T00:00:00.000Z', schedule: everyMinute }, source);
  await work.tick(callbacks(deliver, async () => ({ text: '基线', evidence: [priceUrl], follow: { fields: [price('99元')] } })));
  setNow('2026-10-15T00:01:00.000Z');
  const held = gate();
  const tick = work.tick(callbacks(deliver, async () => {
    held.ready();
    await held.promise;
    return { text: '旧结论 128', evidence: [priceUrl], follow: { fields: [price('128元')] } };
  }));
  await held.started;
  const revised = work.revise(task.id, { prompt: '只看新条件' }, source);
  assert.equal(revised.constraintVersion, 2);
  assert.equal(revised.prompt, '只看新条件');
  assert.equal(revised.baseline?.[0]?.value, '99元');
  assert.equal(revised.nextAt, '2026-10-15T00:02:00.000Z');
  held.open();
  await tick;
  assert.equal(messages.length, 0);
  assert.equal(work.deliveries(task.id).length, 0);
  setNow('2026-10-15T00:02:00.000Z');
  await work.tick(callbacks(deliver, async ({ task: current }) => {
    assert.equal(current.prompt, '只看新条件');
    return { text: '新条件看到 128', evidence: [nextUrl], follow: { fields: [price('128元')] } };
  }));
  await work.tick(callbacks(deliver, async () => ({ text: '不应再写', evidence: [nextUrl], follow: { fields: [price('128元')] } })));
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /99元 → 128元/);
  assert.match(messages[0]!, /https:\/\/example\.com\/price-new/);
  assert.doesNotMatch(messages[0]!, /example\.com\/price[^-]/);
  assert.equal(work.deliveries(task.id).length, 1);
  assert.equal(work.list().length, 1);
  await work.stop();
});

test('Shanghai weekdays skip the weekend and a missed Friday runs once on Monday', async () => {
  const friday = harness('2026-10-16T02:00:00.000Z');
  const later = friday.work.create({ requestId: 'later', title: '工作日', prompt: '每个工作日看条款', kind: 'research', schedule: weekdays }, source);
  assert.equal(later.nextAt, '2026-10-19T01:00:00.000Z');
  assert.equal(later.schedule?.timeZone, 'Asia/Shanghai');
  await friday.work.stop();

  const { work, messages, deliver } = harness('2026-10-19T01:00:00.000Z');
  const task = work.create({ requestId: 'catchup', title: '工作日', prompt: '每个工作日看条款', kind: 'research', at: '2026-10-16T01:00:00.000Z', schedule: weekdays }, source);
  assert.equal(task.nextAt, '2026-10-16T01:00:00.000Z');
  let calls = 0;
  await work.tick(callbacks(deliver, async () => {
    calls += 1;
    return { text: '周一', evidence: [priceUrl], follow: { fields: [{ key: '条款', value: '七天无理由', label: '条款' }] } };
  }));
  await work.tick(callbacks(deliver, async () => { calls += 1; return { text: '不应再跑', evidence: [priceUrl], follow: { fields: [{ key: '条款', value: '七天无理由', label: '条款' }] } }; }));
  assert.equal(calls, 1);
  assert.equal(messages.length, 0);
  assert.equal(work.runs(task.id).length, 1);
  assert.equal(work.runs(task.id)[0]!.occurrenceAt, '2026-10-19T01:00:00.000Z');
  assert.equal(work.get(task.id).nextAt, '2026-10-20T01:00:00.000Z');
  assert.equal(work.snapshot(task.id).progress, 'checked');
  await work.stop();
});

test('a failed or unverifiable check is explained once and is not silent', async () => {
  const { work, messages, deliver, setNow } = harness();
  const task = work.create({ requestId: 'fail', title: '价格', prompt: '看价格', kind: 'research', at: '2026-10-15T00:00:00.000Z', schedule: everyMinute }, source);
  await work.tick(callbacks(deliver, async () => { throw Object.assign(new Error('search down'), { code: 'SEARCH_FAILED' }); }));
  await work.tick(callbacks(deliver, async () => { throw new Error('must not repeat this occurrence'); }));
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /失败/);
  assert.match(messages[0]!, /无法判断/);
  assert.match(messages[0]!, /不是实时盯着/);
  assert.equal(work.snapshot(task.id).progress, 'failed');
  assert.equal(work.snapshot(task.id).delivered, true);
  assert.equal(work.snapshot(task.id).read, false);
  setNow('2026-10-15T00:01:00.000Z');
  await work.tick(callbacks(deliver, async () => ({ text: '不知道', evidence: [], follow: { judgment: 'unknown', note: '页面打不开 https://evil.example/fake' } })));
  assert.equal(messages.length, 2);
  assert.match(messages[1]!, /无法判断/);
  assert.match(messages[1]!, /页面打不开/);
  assert.doesNotMatch(messages[1]!, /evil\.example/);
  assert.equal(work.snapshot(task.id).progress, 'unknown');
  assert.equal(work.snapshot(task.id).lastCheck, 'unknown');
  await work.tick(callbacks(deliver, async () => { throw new Error('same minute must not explain twice'); }));
  assert.equal(messages.length, 2);
  await work.stop();
});

test('a restart does not replay the interrupted check and explains it once', async () => {
  const db = new DatabaseSync(':memory:');
  let now = Date.parse('2026-10-15T00:00:00.000Z');
  const held = gate();
  const work = new WorkRuntime(db, { now: () => now, recover: false });
  const task = work.create({ requestId: 'restart', title: '价格', prompt: '看价格', kind: 'research', at: '2026-10-15T00:00:00.000Z', schedule: everyMinute }, source);
  const tick = work.tick({
    runResearch: async () => { held.ready(); await held.promise; return { text: '半成品', evidence: [priceUrl], follow: { fields: [price('99元')] } }; },
    review: async () => ({ decision: 'notify', text: '不应送达' }),
    deliver: () => { throw new Error('an interrupted check must not deliver the partial result'); },
  });
  await held.started;
  const stopping = work.stop();
  held.open();
  await Promise.all([tick, stopping]);
  const restarted = new WorkRuntime(db, { now: () => now });
  assert.equal(restarted.get(task.id).status, 'active');
  assert.equal(restarted.get(task.id).nextAt, '2026-10-15T00:01:00.000Z');
  assert.equal(restarted.snapshot(task.id).progress, 'unknown');
  assert.equal(restarted.deliveries(task.id).length, 0);
  const messages: string[] = [];
  let calls = 0;
  await restarted.tick({
    runResearch: async () => { calls += 1; return { text: '重跑了', evidence: [priceUrl], follow: { fields: [price('128元')] } }; },
    review: async () => ({ decision: 'notify', text: '不应复核' }),
    deliver: input => { messages.push(input.text); return { messageId: 'explained' }; },
  });
  await restarted.tick({
    runResearch: async () => { calls += 1; return { text: '又重跑', evidence: [priceUrl], follow: { fields: [price('140元')] } }; },
    review: async () => ({ decision: 'notify', text: '不应复核' }),
    deliver: input => { messages.push(input.text); return { messageId: 'again' }; },
  });
  assert.equal(calls, 0);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /重启/);
  assert.match(messages[0]!, /无法判断/);
  assert.match(messages[0]!, /没有重跑/);
  assert.equal(restarted.runs(task.id).length, 1);
  assert.equal(restarted.snapshot(task.id).delivered, true);
  assert.equal(restarted.snapshot(task.id).progress, 'unknown');
  await restarted.stop();
});
