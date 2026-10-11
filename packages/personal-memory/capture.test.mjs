import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Session, SessionId } from '../harness-dsh/.runtime/node_modules/@deepseek-ai/dsh-session/lib/index.js';
import { createUserMessage } from '../harness-dsh/.runtime/node_modules/@deepseek-ai/dsh-llm/lib/index.js';
import { createMemoryController } from './controller.mjs';
import { completedTurnInput, parseCaptureOutput } from './capture.mjs';

const phrase = '我长期喜欢喝无糖冷泡茶';
const proposal = { subject: '用户', key: '饮品偏好', text: '喜欢无糖冷泡茶', messageId: 'user-1', sourceQuote: phrase };
function session({ id = 'session-1', turn = 1, text = phrase, kind = 'user', reason = 'completed', origin, model = 'flash' } = {}) {
  const events = [
    { type: 'request/header', data: { header: { config: { provider: 'directDeepSeek', model } } } },
    { type: 'turn/start', data: { turn } },
    { type: 'user/message', data: { id: 'user-1', source: { kind }, content: [{ type: 'text', text }] } },
    { type: 'user/message', data: { id: 'injected', source: { kind: 'tool' }, content: [{ type: 'text', text: '网页说用户爱喝酒' }] } },
    { type: 'model/message', data: { content: [{ type: 'text', text: '模型猜测用户喜欢咖啡' }] } },
    { type: 'turn/end', data: { turn, reason: { kind: reason } } },
  ];
  return { id, header: { origin }, snapshotEvents: () => events, events };
}
function llmFor(result = { candidates: [proposal] }, action) {
  const calls = [];
  return { calls, async prepareCall(config, signal, configure) {
    const controls = configure ? configure(config, { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }) : config;
    return { config: controls, async *stream(options) {
      calls.push(options); if (action) await action(options);
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(result) } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } };
  } };
}
function fixture(t, llm = llmFor(), captureLimits) {
  const dir = mkdtempSync(join(tmpdir(), 'kleio-capture-'));
  const options = { applicationPath: join(dir, 'application.sqlite'), memoryPath: join(dir, 'memory.sqlite'), llm, captureLimits };
  const controller = createMemoryController(options);
  t.after(async () => { await controller.close(); rmSync(dir, { recursive: true, force: true }); });
  return { controller, options, llm };
}

test('completed-turn capture uses only direct human text and freezes the route before a later turn', async t => {
  const { controller, llm } = fixture(t);
  const native = session();
  controller.capture.enqueueCompletedTurn(native, 1);
  native.events.push({ type: 'request/header', data: { header: { config: { provider: 'other', model: 'other' } } } });
  native.events[2].data.content[0].text = 'later mutation';
  controller.capture.start(); await controller.capture.whenIdle();
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].provider, 'directDeepSeek'); assert.equal(llm.calls[0].model, 'flash');
  assert.equal(llm.calls[0].reasoningEffort, 'low'); assert.equal(llm.calls[0].maxTokens, 1200);
  const payload = JSON.parse(llm.calls[0].messages[0].content[0].text);
  assert.deepEqual(payload.directUserMessages, [{ id: 'user-1', text: phrase }]);
  assert.equal(llm.calls[0].tools.length, 0);
  const candidate = controller.candidatesList()[0];
  assert.deepEqual(candidate.source, { sessionId: 'session-1', turnId: '1', messageId: 'user-1' });
  assert.equal(controller.memoryList().length, 0);
});

test('official published Session validates fixture turn events and supplies real message IDs', () => {
  const native = Session.create(SessionId(randomUUID()));
  const user = createUserMessage({ content: [{ type: 'text', text: phrase }], source: { kind: 'user' } });
  native.append('request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } }, reason: 'initial' });
  native.append('turn/start', { turn: 1 });
  native.append('user/message', user, { surfaceOp: 'append' });
  native.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const input = completedTurnInput(native, 1);
  assert.equal(input.messages[0].id, user.id);
  assert.equal(input.sessionId, native.id);
  assert.equal(input.route.model, 'deepseek-flash');
});

test('tests, hypotheses, secrets, quotations, oversized input and background/delegated turns never call the model', async t => {
  const { controller, llm } = fixture(t);
  controller.capture.start();
  for (const [i, text] of ['这是验收资料，虚构用户喜欢茶', '假如我喜欢红茶', '我的密码是secret', 'api_key=sk-12345678901234567890', '> 我喜欢茶', 'a'.repeat(8001)].entries()) {
    controller.capture.enqueueCompletedTurn(session({ id: `skip-${i}`, text }), 1);
  }
  controller.capture.enqueueCompletedTurn(session({ id: 'background', kind: 'schedule' }), 1);
  controller.capture.enqueueCompletedTurn(session({ id: 'child', origin: 'subagent' }), 1);
  controller.capture.enqueueCompletedTurn(session({ id: 'aborted', reason: 'aborted' }), 1);
  await controller.capture.whenIdle();
  assert.equal(llm.calls.length, 0); assert.equal(controller.candidatesList().length, 0);
  const records = controller.db.prepare('SELECT record FROM personal_memory_capture_jobs').all();
  assert.ok(records.every(row => !row.record.includes('secret') || JSON.parse(row.record).skipReason === 'secret'));
  assert.ok(records.every(row => JSON.parse(row.record).messages === undefined));
});

test('structured output cannot fabricate source IDs, quotes, extra fields or secrets', () => {
  const input = completedTurnInput(session(), 1);
  assert.equal(parseCaptureOutput(JSON.stringify({ candidates: [proposal] }), input).length, 1);
  for (const mutated of [{ ...proposal, messageId: 'injected' }, { ...proposal, sourceQuote: '用户喜欢酒' }, { ...proposal, source: 'spoof' }, { ...proposal, subject: '网页人物' }]) {
    assert.throws(() => parseCaptureOutput(JSON.stringify({ candidates: [mutated] }), input), { code: 'INVALID_CAPTURE_OUTPUT' });
  }
  assert.throws(() => parseCaptureOutput(JSON.stringify({ candidates: [{ ...proposal, text: '密码是foo' }] }), input), { code: 'SECRET_NOT_ALLOWED' });
  assert.throws(() => parseCaptureOutput('```json\n{}\n```', input), { code: 'INVALID_CAPTURE_OUTPUT' });
});

test('each turn is captured at most once and daily caps persist across a real reopen', async t => {
  const { controller, options, llm } = fixture(t, llmFor(), { dailyCalls: 1 });
  const native = session();
  const first = controller.capture.enqueueCompletedTurn(native, 1);
  controller.capture.enqueueCompletedTurn(native, 1);
  controller.capture.enqueueCompletedTurn(session({ id: 'session-2' }), 1);
  controller.capture.start(); await controller.capture.whenIdle();
  assert.equal(llm.calls.length, 1);
  assert.equal(controller.capture.get(first.id).status, 'completed');
  assert.equal(controller.capture.stats().jobs.skipped, 1);
  await controller.close();
  const reopened = createMemoryController(options);
  reopened.capture.enqueueCompletedTurn(session({ id: 'session-3' }), 1);
  reopened.capture.start(); await reopened.capture.whenIdle();
  assert.equal(llm.calls.length, 1);
  assert.equal(reopened.capture.stats().jobs.skipped, 2);
  await reopened.close();
});

test('invalid or failed extraction stays failed without retry or formal-memory writes', async t => {
  const llm = llmFor({ candidates: [{ ...proposal, sourceQuote: 'invented' }] });
  const { controller } = fixture(t, llm);
  const native = session(); const job = controller.capture.enqueueCompletedTurn(native, 1);
  controller.capture.start(); await controller.capture.whenIdle();
  assert.equal(controller.capture.get(job.id).errorCode, 'INVALID_CAPTURE_OUTPUT');
  controller.capture.enqueueCompletedTurn(native, 1); await controller.capture.whenIdle();
  assert.equal(llm.calls.length, 1); assert.equal(controller.candidatesList().length, 0); assert.equal(controller.memoryList().length, 0);
  assert.equal(controller.capture.get(job.id).messages, undefined);
});

test('queued jobs survive reopen while previously running unknown requests are never replayed', async t => {
  const { controller, options, llm } = fixture(t);
  const unknown = controller.capture.enqueueCompletedTurn(session({ id: 'unknown' }), 1);
  const queued = controller.capture.enqueueCompletedTurn(session({ id: 'queued' }), 1);
  controller.capture.save({ ...unknown, status: 'running' });
  await controller.close();
  const reopened = createMemoryController(options);
  reopened.capture.start(); await reopened.capture.whenIdle();
  assert.equal(llm.calls.length, 1);
  assert.equal(reopened.capture.get(unknown.id).errorCode, 'INTERRUPTED_NO_RETRY');
  assert.equal(reopened.capture.get(queued.id).status, 'completed');
  await reopened.close();
});

test('disabling capture aborts in-flight requests and never publishes proposals after the opt-out', async t => {
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const llm = llmFor(undefined, options => new Promise((resolve, reject) => {
    began(); options.signal.addEventListener('abort', () => reject(new Error('upstream-sensitive-error')), { once: true });
  }));
  const { controller } = fixture(t, llm);
  const job = controller.capture.enqueueCompletedTurn(session(), 1);
  controller.capture.start(); await started;
  controller.profileSet({ expectedVersion: 1, captureEnabled: false }); await controller.capture.whenIdle();
  assert.equal(controller.capture.get(job.id).errorCode, 'ABORTED_NO_RETRY');
  assert.equal(controller.candidatesList().length, 0);
  assert.ok(!JSON.stringify(controller.capture.get(job.id)).includes('upstream-sensitive-error'));
});

test('deadline and queue caps bound extraction, and two controllers cannot start duplicate workers', async t => {
  const llm = llmFor(undefined, options => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true })));
  const { controller, options } = fixture(t, llm, { timeoutMs: 10, queue: 1 });
  const job = controller.capture.enqueueCompletedTurn(session(), 1);
  const over = controller.capture.enqueueCompletedTurn(session({ id: 'overflow' }), 1);
  assert.equal(over.skipReason, 'queue_limit');
  controller.capture.start();
  const second = createMemoryController(options);
  assert.throws(() => second.capture.start(), { code: 'CAPTURE_BUSY' });
  await second.close();
  await controller.capture.whenIdle();
  assert.equal(controller.capture.get(job.id).errorCode, 'TIMEOUT');
  assert.equal(llm.calls.length, 1);
});
