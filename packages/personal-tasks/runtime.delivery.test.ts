import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStore } from '../runtime/store.ts';
import { WorkRuntime, WorkRuntimeError, formatResearchDelivery, type WorkCallbacks, type WorkDeliveryRequest, type WorkSource } from './runtime.ts';

const source: WorkSource = { kind: 'user', conversationId: 'conv-1', messageId: 'msg-1' };
const oldUrl = { kind: 'url' as const, reference: 'https://example.com/old', title: '旧来源' };
const newUrl = { kind: 'url' as const, reference: 'https://example.com/new', title: '新来源' };

function harness() {
  const db = new DatabaseSync(':memory:');
  let now = Date.parse('2026-10-15T00:00:00.000Z');
  const work = new WorkRuntime(db, { now: () => now, recover: false, maxConcurrent: 2 });
  const messages: string[] = [];
  const deliver = (input: WorkDeliveryRequest) => {
    messages.push(input.text);
    return { messageId: `message-${messages.length}` };
  };
  return { db, work, messages, deliver, setNow(value: number) { now = value; } };
}
function callbacks(deliver: NonNullable<WorkCallbacks['deliver']>, runResearch: WorkCallbacks['runResearch'], review: WorkCallbacks['review']): WorkCallbacks {
  return { runResearch, review, deliver };
}
function gate() {
  let open!: () => void;
  let ready!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  const started = new Promise<void>(resolve => { ready = resolve; });
  return { promise, open, started, ready };
}

test('one constraint version is kept and a sourced result is written once', async () => {
  const { work, messages, deliver, setNow } = harness();
  const task = work.create({ requestId: 'same', title: '公开资料', prompt: '研究公开资料', kind: 'research' }, source);
  assert.equal(work.create({ requestId: 'same', title: '公开资料', prompt: '研究公开资料', kind: 'research' }, source).id, task.id);
  assert.equal(work.snapshot(task.id).progress, 'queued');
  assert.equal(work.snapshot(task.id).progressLabel, '排队');
  assert.throws(() => work.markRead(task.id), (error: unknown) => error instanceof WorkRuntimeError && error.code === 'NOT_DELIVERED');
  const run = callbacks(deliver,
    async () => ({ text: '结论', evidence: [newUrl] }),
    async () => ({ decision: 'notify', text: '结论见 https://evil.example/fake' }));
  await work.tick(run);
  await work.tick(run);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /https:\/\/example\.com\/new/);
  assert.doesNotMatch(messages[0]!, /evil\.example/);
  assert.equal(work.snapshot(task.id).progress, 'written');
  assert.equal(work.snapshot(task.id).progressLabel, '已写入');
  assert.equal(work.snapshot(task.id).delivered, true);
  assert.equal(work.snapshot(task.id).read, false);
  assert.equal(work.notifications().length, 0);
  setNow(Date.parse('2026-10-15T00:00:01.000Z'));
  const read = work.markRead(task.id);
  assert.equal(read.readAt !== null, true);
  assert.equal(read.writtenAt !== null, true);
  assert.notEqual(read.readAt, read.writtenAt);
  assert.equal(work.snapshot(task.id).progress, 'written');
  assert.equal(work.snapshot(task.id).read, true);
  assert.equal(messages.length, 1);
  await work.stop();
});

test('text without a search URL is not written', async () => {
  const { work, messages, deliver } = harness();
  const task = work.create({ requestId: 'bare', title: '无来源', prompt: '只写一段话', kind: 'research' }, source);
  await work.tick(callbacks(deliver, async () => ({ text: '没有链接的结论' }), async () => ({ decision: 'notify', text: '不应出现' })));
  assert.equal(messages.length, 0);
  const view = work.snapshot(task.id);
  assert.equal(view.progress, 'failed');
  assert.equal(view.progressLabel, '失败');
  assert.equal(view.delivered, false);
  assert.equal(view.errorCode, 'UNSOURCED_RESULT');
  await work.stop();
});

test('changing conditions during review keeps one task and writes only the new agreement', async () => {
  const { work, messages, deliver } = harness();
  const task = work.create({ requestId: 'revise', title: '课题', prompt: '研究旧条件', kind: 'research' }, source);
  const first = work.tick(callbacks(deliver,
    async () => ({ text: '旧结论', evidence: [oldUrl] }),
    async () => {
      work.revise(task.id, { prompt: '研究新条件' }, source);
      return { decision: 'notify', text: '旧结论' };
    }));
  await first;
  assert.equal(work.list().length, 1);
  assert.equal(work.get(task.id).constraintVersion, 2);
  assert.equal(work.get(task.id).constraints.length, 2);
  assert.equal(work.get(task.id).prompt, '研究新条件');
  assert.equal(messages.length, 0);
  assert.equal(work.snapshot(task.id).delivered, false);
  assert.equal(work.snapshot(task.id).progress, 'queued');
  const next = callbacks(deliver,
    async ({ task: current }) => ({ text: current.prompt, evidence: [newUrl] }),
    async ({ result }) => ({ decision: 'notify', text: result.text }));
  await work.tick(next);
  await work.tick(next);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /研究新条件/);
  assert.match(messages[0]!, /https:\/\/example\.com\/new/);
  assert.doesNotMatch(messages[0]!, /example\.com\/old/);
  assert.equal(work.deliveries(task.id).length, 1);
  assert.equal(work.snapshot(task.id).progress, 'written');
  await work.stop();
});

test('an unchanged revise does not drop the in-flight agreement', async () => {
  const { work, messages, deliver } = harness();
  const task = work.create({ requestId: 'noop', title: '课题', prompt: '研究原条件', kind: 'research' }, source);
  const held = gate();
  const tick = work.tick(callbacks(deliver, async () => {
    held.ready();
    await held.promise;
    return { text: '原结论', evidence: [newUrl] };
  }, async () => ({ decision: 'notify', text: '原结论' })));
  await held.started;
  const revised = work.revise(task.id, { prompt: task.prompt }, source);
  assert.equal(revised.version, task.version);
  assert.equal(revised.constraintVersion, 1);
  held.open();
  await tick;
  assert.equal(messages.length, 1);
  assert.equal(work.snapshot(task.id).progress, 'written');
  await work.stop();
});

test('pause and resume write the current agreement once', async () => {
  const { work, messages, deliver } = harness();
  const task = work.create({ requestId: 'pause', title: '课题', prompt: '研究暂停', kind: 'research' }, source);
  const tick = work.tick(callbacks(deliver,
    async () => ({ text: '暂停前', evidence: [oldUrl] }),
    async () => {
      const paused = work.pause(task.id);
      assert.equal(paused.status, 'paused');
      return { decision: 'notify', text: '暂停前的结论' };
    }));
  await tick;
  assert.equal(messages.length, 0);
  const paused = work.snapshot(task.id);
  assert.equal(paused.progress, 'stopped');
  assert.equal(paused.progressLabel, '已停止');
  assert.equal(paused.hold, 'paused');
  assert.equal(paused.delivered, false);
  work.resume(task.id);
  assert.equal(work.snapshot(task.id).progress, 'queued');
  assert.equal(work.snapshot(task.id).hold, null);
  const next = callbacks(deliver,
    async () => ({ text: '恢复后', evidence: [newUrl] }),
    async () => ({ decision: 'notify', text: '恢复后的结论' }));
  await work.tick(next);
  await work.tick(next);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /https:\/\/example\.com\/new/);
  assert.doesNotMatch(messages[0]!, /example\.com\/old/);
  await work.stop();
});

test('stopping an in-flight research writes nothing', async () => {
  const { work, messages, deliver } = harness();
  const task = work.create({ requestId: 'stop', title: '课题', prompt: '研究停止', kind: 'research' }, source);
  await work.tick(callbacks(deliver,
    async () => ({ text: '停止前', evidence: [oldUrl] }),
    async () => {
      work.cancel(task.id);
      return { decision: 'notify', text: '不应写入' };
    }));
  const stopped = work.snapshot(task.id);
  assert.equal(stopped.progress, 'stopped');
  assert.equal(stopped.hold, 'cancelled');
  assert.equal(stopped.delivered, false);
  assert.equal(messages.length, 0);
  assert.throws(() => work.resume(task.id), (error: unknown) => error instanceof WorkRuntimeError && error.code === 'INVALID_STATE');
  assert.throws(() => work.revise(task.id, { prompt: '新的条件' }, source), (error: unknown) => error instanceof WorkRuntimeError && error.code === 'INVALID_STATE');
  await work.tick(callbacks(deliver, async () => ({ text: '又一次', evidence: [newUrl] }), async () => ({ decision: 'notify', text: '又一次' })));
  assert.equal(messages.length, 0);
  assert.equal(work.list().length, 1);
  await work.stop();
});

test('a later condition change writes a second agreement without repeating the first', async () => {
  const { work, messages, deliver } = harness();
  const task = work.create({ requestId: 'later', title: '课题', prompt: '第一条件', kind: 'research' }, source);
  const run = callbacks(deliver,
    async ({ task: current }) => ({ text: current.prompt, evidence: [current.prompt === '第一条件' ? oldUrl : newUrl] }),
    async ({ result }) => ({ decision: 'notify', text: result.text }));
  await work.tick(run);
  work.revise(task.id, { prompt: '第二条件' }, source);
  await work.tick(run);
  await work.tick(run);
  assert.equal(work.list().length, 1);
  assert.equal(messages.length, 2);
  assert.match(messages[0]!, /example\.com\/old/);
  assert.match(messages[1]!, /example\.com\/new/);
  assert.equal(work.deliveries(task.id).length, 2);
  assert.equal(work.snapshot(task.id).progress, 'written');
  await work.stop();
});

test('a silent one-shot review is still written once, while interval silence stays out of the session', async () => {
  const { work, messages, deliver } = harness();
  const once = work.create({ requestId: 'silent-once', title: '一次', prompt: '一次性研究', kind: 'research' }, source);
  await work.tick(callbacks(deliver,
    async () => ({ text: '一次结论', evidence: [newUrl] }),
    async () => ({ decision: 'silent', text: '一次结论' })));
  assert.equal(messages.length, 1);
  assert.equal(work.snapshot(once.id).delivered, true);
  assert.equal(work.notifications().length, 0);
  const interval = work.create({ requestId: 'silent-interval', title: '周期', prompt: '周期研究', kind: 'research', at: '2026-10-15T00:00:00.000Z', intervalMs: 60_000 }, source);
  const reminder = work.create({ requestId: 'reminder', title: '提醒', prompt: '喝水', kind: 'reminder' }, source);
  await work.tick(callbacks(deliver, async () => ({ text: '没有变化' }), async () => ({ decision: 'silent', text: '没有变化' })));
  assert.equal(work.deliveries(interval.id).length, 0);
  assert.equal(work.deliveries(reminder.id).length, 0);
  assert.equal(work.notifications().length, 1);
  assert.equal(work.notifications()[0]!.readAt, null);
  assert.equal(work.get(interval.id).status, 'active');
  assert.throws(() => work.pause(interval.id), (error: unknown) => error instanceof WorkRuntimeError && error.code === 'ONE_SHOT_ONLY');
  await work.stop();
});

test('an interrupted one-shot is unknown until inspected and is not delivered', async () => {
  const db = new DatabaseSync(':memory:');
  const now = Date.parse('2026-10-15T00:00:00.000Z');
  const held = gate();
  const work = new WorkRuntime(db, { now: () => now, recover: false });
  const task = work.create({ requestId: 'interrupted', title: '中断', prompt: '研究中断', kind: 'research' }, source);
  const tick = work.tick({
    runResearch: async () => { held.ready(); await held.promise; return { text: '半成品', evidence: [newUrl] }; },
    review: async () => ({ decision: 'notify', text: '不应送达' }),
    deliver: () => { throw new Error('interrupted research must not be delivered'); },
  });
  await held.started;
  const stopping = work.stop();
  held.open();
  await Promise.all([tick, stopping]);
  const restarted = new WorkRuntime(db, { now: () => now });
  const view = restarted.snapshot(task.id);
  assert.equal(view.progress, 'unknown');
  assert.equal(view.progressLabel, '结果未知');
  assert.equal(view.delivered, false);
  assert.equal(restarted.deliveries(task.id).length, 0);
  await restarted.stop();
});

test('the session message is the delivery record and a second tick does not add another', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'kleio-research-delivery-'));
  const store = new RuntimeStore(join(directory, 'app.sqlite'));
  const now = Date.parse('2026-10-15T00:00:00.000Z');
  const work = new WorkRuntime(store.db, { now: () => now, recover: false });
  try {
    const conversation = store.createConversation('研究');
    const origin: WorkSource = { kind: 'user', conversationId: conversation.id, messageId: 'user-1' };
    const task = work.create({ requestId: 'session', title: '来源', prompt: '研究来源', kind: 'research', conversationId: conversation.id }, origin);
    const deliver = (input: WorkDeliveryRequest) => ({ messageId: store.insertAssistantMessage(input.conversationId, input.text, `research-delivery:${input.runId}`).id });
    const run = callbacks(deliver,
      async () => ({ text: '会话结论', evidence: [{ kind: 'url', reference: 'https://example.com/source', title: '来源页' }] }),
      async () => ({ decision: 'notify', text: '会话结论，假链接 https://evil.example/fake' }));
    await work.tick(run);
    await work.tick(run);
    const messages = store.messages(conversation.id);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.role, 'assistant');
    assert.match(messages[0]!.content, /https:\/\/example\.com\/source/);
    assert.doesNotMatch(messages[0]!.content, /evil\.example/);
    assert.equal(work.snapshot(task.id).delivery?.messageId, messages[0]!.id);
    assert.equal(work.notifications().length, 0);
  } finally {
    await work.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('formatResearchDelivery keeps searched links and drops other URLs', () => {
  const text = formatResearchDelivery('见 https://example.com/new 和 https://evil.example/fake', [newUrl]);
  assert.match(text, /https:\/\/example\.com\/new/);
  assert.doesNotMatch(text, /evil\.example/);
  assert.match(text, /来源/);
});
