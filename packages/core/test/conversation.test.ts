import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentStore } from '../store.ts';
import { AgentService, DemoEngine } from '../service.ts';
import { CoreError, EngineOutcomeUnknownError, type AgentEngine, type EngineInput } from '../contracts.ts';

function fixture(t: TestContext): AgentStore { const store = new AgentStore(':memory:'); t.after(() => store.close()); return store; }
const hasCode = (code: string) => (error: unknown): boolean => error instanceof CoreError && error.code === code;

test('two conversation turns persist ordered user and final assistant messages with independent artifacts', async t => {
  const store = fixture(t); const conversation = store.createConversation(); const service = new AgentService(store, new DemoEngine(1));
  try {
    const first = service.submitMessage(conversation.id, '你好，记住我喜欢简短回复', 'message-one');
    await service.wait(first.runId);
    const second = service.submitMessage(conversation.id, '我们继续聊', 'message-two'); await service.wait(second.runId);
    const messages = store.messages(conversation.id);
    assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
    assert.equal(messages[0]!.runId, first.runId); assert.equal(messages[2]!.runId, second.runId);
    assert.equal(messages[1]!.status, 'completed'); assert.equal(messages[3]!.status, 'completed');
    assert.match(messages[3]!.content, /关联 2 条已有对话消息/);
    assert.match(messages[3]!.content, /没有执行模型推理/);
    assert.equal(store.conversation(conversation.id).title, '你好，记住我喜欢简短回复');
    assert.equal(store.conversation(conversation.id).activeRunId, null);
    assert.equal(store.conversation(conversation.id).lastRunId, second.runId);
    assert.equal(store.task(first.taskId).conversationId, conversation.id);
    assert.equal(store.run(second.runId).conversationId, conversation.id);
    assert.equal(store.artifacts().length, 2); assert.notEqual(first.taskId, second.taskId);
  } finally { await service.close(); }
});

test('stable message ids are idempotent while active and after completion, but cannot change text', async t => {
  const store = fixture(t); const conversation = store.createConversation('自定义标题'); let executions = 0;
  const engine: AgentEngine = { id: 'test', capabilities: { cancel: true, permissions: false, resume: false, steer: false },
    async execute() { executions++; await delay(5); return { text: 'done' }; }, async close() {} };
  const service = new AgentService(store, engine);
  try {
    const first = service.submitMessage(conversation.id, '  第一条  ', 'stable-message');
    const repeated = service.submitMessage(conversation.id, '第一条', 'stable-message');
    assert.equal(repeated.replayed, true); assert.equal(repeated.runId, first.runId); assert.equal(repeated.messageId, first.messageId);
    assert.throws(() => service.submitMessage(conversation.id, '另一条', 'stable-message'), hasCode('message_conflict'));
    assert.throws(() => service.submitMessage(conversation.id, '第二条', 'different-message'), hasCode('conversation_busy'));
    await service.wait(first.runId);
    assert.equal(service.submitMessage(conversation.id, '第一条', 'stable-message').runId, first.runId);
    assert.equal(executions, 1); assert.equal(store.tasks().length, 1); assert.equal(store.messages(conversation.id).length, 2);
    assert.equal(store.conversation(conversation.id).title, '自定义标题');
  } finally { await service.close(); }
});

test('same conversation stays locked through approval and cancellation, while another conversation runs', async t => {
  const store = fixture(t); const firstConversation = store.createConversation(); const secondConversation = store.createConversation();
  const service = new AgentService(store, new DemoEngine(2));
  try {
    const first = service.submitMessage(firstConversation.id, '验证审批', 'one');
    for (let i = 0; i < 100 && !store.approvals().length; i++) await delay(2);
    const approval = store.approvals()[0]!; assert.ok(approval);
    assert.equal(store.messages(firstConversation.id)[1]!.status, 'waiting_approval');
    assert.throws(() => service.submitMessage(firstConversation.id, '抢跑', 'two'), hasCode('conversation_busy'));
    const second = service.submitMessage(secondConversation.id, '不同对话', 'one');
    service.cancel(first.runId);
    assert.equal(store.messages(firstConversation.id)[1]!.status, 'cancelling');
    assert.throws(() => service.submitMessage(firstConversation.id, '抢跑', 'three'), hasCode('conversation_busy'));
    await Promise.all([service.wait(first.runId), service.wait(second.runId)]);
    assert.equal(store.messages(firstConversation.id)[1]!.status, 'cancelled');
    assert.equal(store.conversation(firstConversation.id).activeRunId, null);
    assert.equal(store.approvals()[0]!.status, 'interrupted');
    assert.equal(store.run(second.runId).status, 'completed');
    assert.equal(store.messages(firstConversation.id).length, 2);
  } finally { await service.close(); }
});

test('subsequent turns reuse only the latest same-engine native session', t => {
  const store = fixture(t); const conversation = store.createConversation();
  const first = store.submitMessage(conversation.id, 'one', 'one', 'dsh-acp');
  store.setSession(first.runId, 'native-one'); store.complete(first.runId, 'first response');
  const second = store.submitMessage(conversation.id, 'two', 'two', 'dsh-acp');
  assert.equal(store.run(second.runId).sessionId, 'native-one');
  store.setSession(second.runId, 'native-two'); store.complete(second.runId, 'second response');
  const third = store.submitMessage(conversation.id, 'three', 'three', 'another-engine');
  assert.equal(store.run(third.runId).sessionId, null); store.complete(third.runId, 'third response');
  const fourth = store.submitMessage(conversation.id, 'four', 'four', 'dsh-acp');
  assert.equal(store.run(fourth.runId).sessionId, null);
});

test('engine receives application history and the native cursor without duplicating the current request', async t => {
  const store = fixture(t); const conversation = store.createConversation(); const inputs: EngineInput[] = [];
  const engine: AgentEngine = { id: 'dsh-acp', capabilities: { cancel: true, permissions: false, resume: true, steer: false },
    async execute(input, context) { inputs.push(input); context.onSession('same-native'); return { text: 'answer ' + input.prompt }; }, async close() {} };
  const service = new AgentService(store, engine);
  try {
    const first = service.submitMessage(conversation.id, 'one', 'one'); await service.wait(first.runId);
    const second = service.submitMessage(conversation.id, 'two', 'two'); await service.wait(second.runId);
    assert.equal(inputs[0]!.sessionId, null); assert.equal(inputs[1]!.sessionId, 'same-native');
    assert.deepEqual(inputs[1]!.history, [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'answer one' }]);
  } finally { await service.close(); }
});

test('unknown outcomes clear the latest cursor and cannot resurrect an older session', async t => {
  const store = fixture(t); const conversation = store.createConversation(); let turn = 0;
  const engine: AgentEngine = { id: 'dsh-acp', capabilities: { cancel: true, permissions: false, resume: true, steer: false },
    async execute(input, context) {
      turn++; if (turn === 1) { context.onSession('previous-native'); return { text: 'known result' }; }
      if (turn === 2) { context.onSession('unknown-native'); throw new EngineOutcomeUnknownError('外部结果未知。'); }
      assert.equal(input.sessionId, null); context.onSession('fresh-native'); return { text: 'explicit new request' };
    }, async close() {} };
  const service = new AgentService(store, engine);
  try {
    const first = service.submitMessage(conversation.id, 'one', 'one'); await service.wait(first.runId);
    const second = service.submitMessage(conversation.id, 'two', 'two'); await service.wait(second.runId);
    assert.equal(store.run(second.runId).status, 'interrupted'); assert.equal(store.run(second.runId).sessionId, null);
    assert.equal(store.messages(conversation.id)[3]!.error, '外部结果未知。');
    assert.equal(store.conversation(conversation.id).activeRunId, null);
    const third = service.submitMessage(conversation.id, '明确新请求', 'three'); await service.wait(third.runId);
    assert.equal(turn, 3); assert.equal(store.artifacts().length, 2);
  } finally { await service.close(); }
});

test('failed execution keeps partial assistant text and durable failure without a fake artifact', async t => {
  const store = fixture(t); const conversation = store.createConversation();
  const engine: AgentEngine = { id: 'failure', capabilities: { cancel: true, permissions: false, resume: false, steer: false },
    async execute(_input, context) { context.onText('已有部分输出'); throw new Error('已知失败'); }, async close() {} };
  const service = new AgentService(store, engine);
  try {
    const submitted = service.submitMessage(conversation.id, '执行', 'one'); await service.wait(submitted.runId);
    const message = store.messages(conversation.id)[1]!;
    assert.equal(message.content, '已有部分输出'); assert.equal(message.status, 'failed'); assert.equal(message.error, '已知失败');
    assert.equal(store.artifacts().length, 0); assert.equal(store.conversation(conversation.id).activeRunId, null);
  } finally { await service.close(); }
});

test('explicit retry creates a new assistant record and rejects retrying an older turn after conversation advances', t => {
  const store = fixture(t); const conversation = store.createConversation();
  const first = store.submitMessage(conversation.id, 'first request', 'one', 'demo'); store.settle(first.runId, 'failed', 'failed');
  const retry = store.startRun(first.taskId, 'demo');
  assert.deepEqual(store.messages(conversation.id).map(message => message.role), ['user', 'assistant', 'assistant']);
  assert.equal(store.messages(conversation.id)[2]!.runId, retry.id); store.settle(retry.id, 'failed', 'failed again');
  const next = store.submitMessage(conversation.id, 'follow-up', 'two', 'demo'); store.complete(next.runId, 'new result');
  assert.throws(() => store.startRun(first.taskId, 'demo'), hasCode('conversation_advanced'));
  assert.equal(store.conversation(conversation.id).lastRunId, next.runId); assert.equal(store.runs().length, 3);
});

test('engine context has bounded history while durable messages retain full text', t => {
  const store = fixture(t); const conversation = store.createConversation();
  for (let i = 0; i < 10; i++) {
    const submitted = store.submitMessage(conversation.id, 'round ' + i + ' ' + '中'.repeat(2_000), String(i), 'demo');
    store.complete(submitted.runId, '答'.repeat(2_000));
  }
  const current = store.submitMessage(conversation.id, 'current request', 'current', 'demo');
  const history = store.historyForRun(current.runId);
  assert.ok(history.length <= 12); assert.ok(history.reduce((total, message) => total + message.content.length, 0) <= 16_000);
  assert.ok(store.messages(conversation.id).reduce((total, message) => total + message.content.length, 0) > 40_000);
  assert.ok(history.every(message => message.content !== 'current request'));
});

test('conversation startup recovery releases its lock and invalidates an uncertain native cursor without replay', t => {
  const store = fixture(t); const conversation = store.createConversation();
  const submitted = store.submitMessage(conversation.id, 'task', 'one', 'dsh-acp');
  store.setSession(submitted.runId, 'native-before-exit'); const approval = store.propose(submitted.runId, 'write', { path: 'fixture' });
  let executions = 0;
  const engine: AgentEngine = { id: 'dsh-acp', capabilities: { cancel: true, permissions: true, resume: true, steer: false },
    async execute() { executions++; return { text: 'never automatically called' }; }, async close() {} };
  const service = new AgentService(store, engine);
  assert.equal(executions, 0); assert.equal(store.run(submitted.runId).status, 'interrupted');
  assert.equal(store.run(submitted.runId).sessionId, null); assert.equal(store.conversation(conversation.id).activeRunId, null);
  assert.equal(store.messages(conversation.id)[1]!.status, 'interrupted');
  assert.equal(store.approvals().find(record => record.id === approval.id)!.status, 'interrupted');
  const explicit = store.submitMessage(conversation.id, '检查后重新请求', 'two', 'dsh-acp');
  assert.equal(store.run(explicit.runId).sessionId, null); store.settle(explicit.runId, 'cancelled', null);
  return service.close();
});

test('version 1 database upgrades additively and conversation messages survive reopen', t => {
  const directory = mkdtempSync(join(tmpdir(), 'kleio-conversations-')); const file = join(directory, 'state.sqlite');
  const old = new DatabaseSync(file); const time = new Date().toISOString();
  old.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE tasks(id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),json TEXT NOT NULL);');
  old.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('schema_version', '1');
  old.prepare('INSERT INTO tasks(id,json) VALUES(?,?)').run('old-task', JSON.stringify({ id: 'old-task', title: 'legacy', prompt: 'legacy', status: 'completed', currentRunId: 'old-run', createdAt: time, updatedAt: time }));
  old.prepare('INSERT INTO runs(id,task_id,json) VALUES(?,?,?)').run('old-run', 'old-task', JSON.stringify({ id: 'old-run', taskId: 'old-task', engine: 'demo', status: 'completed', sessionId: null, error: null, createdAt: time, updatedAt: time }));
  old.close(); let store = new AgentStore(file);
  t.after(() => { store.close(); for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true }); rmdirSync(directory); });
  assert.equal(store.task('old-task').conversationId, null); assert.equal(store.run('old-run').conversationId, null);
  const conversation = store.createConversation(); const submitted = store.submitMessage(conversation.id, '持久消息', 'one', 'demo');
  store.complete(submitted.runId, '持久回复'); store.close(); store = new AgentStore(file);
  assert.equal(store.conversation(conversation.id).lastRunId, submitted.runId);
  assert.deepEqual(store.messages(conversation.id).map(message => message.content), ['持久消息', '持久回复']);
  assert.equal(store.tasks().length, 2); assert.equal(store.artifacts().length, 1);
});

test('closed service cannot persist a new conversation submission', async t => {
  const store = fixture(t); const conversation = store.createConversation(); const service = new AgentService(store, new DemoEngine(1));
  await service.close();
  assert.throws(() => service.submitMessage(conversation.id, 'task', 'one'), hasCode('service_closed'));
  assert.equal(store.messages(conversation.id).length, 0); assert.equal(store.tasks().length, 0);
});

test('service shutdown records interrupted conversation and clears its uncertain session', async t => {
  const store = fixture(t); const conversation = store.createConversation();
  const engine: AgentEngine = { id: 'remote', capabilities: { cancel: true, permissions: false, resume: true, steer: false },
    async execute(_input, context) {
      context.onSession('shutdown-native');
      await delay(10_000, undefined, { signal: context.signal }); return { text: 'not delivered' };
    }, async close() {} };
  const service = new AgentService(store, engine); const submitted = service.submitMessage(conversation.id, 'task', 'one');
  await delay(0); await service.close();
  assert.equal(store.run(submitted.runId).status, 'interrupted'); assert.equal(store.run(submitted.runId).sessionId, null);
  assert.equal(store.messages(conversation.id)[1]!.status, 'interrupted'); assert.equal(store.conversation(conversation.id).activeRunId, null);
  assert.equal(store.events(submitted.runId).at(-1)!.data.invalidatedSessionId, 'shutdown-native');
});
