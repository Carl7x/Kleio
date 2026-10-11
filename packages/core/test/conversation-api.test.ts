import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentStore } from '../store.ts';
import { AgentService, DemoEngine } from '../service.ts';
import { createApp } from '../../../apps/server/app.ts';
import { UnconfiguredEngine } from '../../../apps/server/unconfigured-engine.ts';

test('conversation API persists sequential turns and deduplicates the exact client submission', async () => {
  const store = new AgentStore(':memory:'); const service = new AgentService(store, new DemoEngine(1));
  const app = createApp(service); const request = (path: string, init?: RequestInit) => app.request('http://localhost' + path, init);
  try {
    const created = await request('/api/conversations', { method: 'POST', body: '{}' }); assert.equal(created.status, 201);
    const conversation = await created.json() as { id: string };
    const body = JSON.stringify({ text: '我喜欢短回复', clientMessageId: 'unique-first-turn' });
    const first = await request('/api/conversations/' + conversation.id + '/messages', { method: 'POST', body });
    assert.equal(first.status, 202); const submission = await first.json() as { runId: string };
    await service.wait(submission.runId);
    const duplicate = await request('/api/conversations/' + conversation.id + '/messages', { method: 'POST', body });
    const replay = await duplicate.json() as { runId: string; replayed: boolean };
    assert.equal(replay.runId, submission.runId); assert.equal(replay.replayed, true);
    assert.equal((await request('/api/conversations/' + conversation.id + '/messages', { method: 'POST',
      body: JSON.stringify({ text: '另一个输入', clientMessageId: 'unique-first-turn' }) })).status, 409);
    const second = await request('/api/conversations/' + conversation.id + '/messages', { method: 'POST',
      body: JSON.stringify({ text: '继续刚才的话题', clientMessageId: 'unique-second-turn' }) });
    const next = await second.json() as { runId: string }; await service.wait(next.runId);
    const messages = await (await request('/api/conversations/' + conversation.id + '/messages')).json() as Array<{ role: string; content: string }>;
    assert.deepEqual(messages.map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
    assert.match(messages[0]!.content, /短回复/); assert.equal(store.artifacts().length, 2);
    assert.equal((await request('/api/conversations/missing/messages')).status, 404);
    assert.equal((await request('/api/conversations/' + conversation.id + '/messages', { method: 'POST', body: '{"text":"missing id"}' })).status, 400);
  } finally { await service.close(); store.close(); }
});

test('settings expose missing configuration without claiming model readiness; attempts fail visibly', async () => {
  const store = new AgentStore(':memory:'); const service = new AgentService(store, new UnconfiguredEngine(['需要模型名称']));
  const app = createApp(service, { runtime: { status: 'missing', missing: ['需要模型名称'], note: '模型尚未接入。' } });
  try {
    const settings = await (await app.request('http://localhost/api/settings')).json() as { runtime: { status: string; missing: string[] } };
    assert.equal(settings.runtime.status, 'missing'); assert.deepEqual(settings.runtime.missing, ['需要模型名称']);
    const conversation = store.createConversation(); const submission = service.submitMessage(conversation.id, '请开始', 'missing-model-test');
    await service.wait(submission.runId); assert.equal(store.run(submission.runId).status, 'failed');
    assert.match(store.run(submission.runId).error!, /模型尚未配置/); assert.equal(store.artifacts().length, 0);
    assert.equal((await app.request('http://localhost/api/unknown')).status, 404);
  } finally { await service.close(); store.close(); }
});

test('the explicitly trusted local development origin works while other origins remain blocked', async () => {
  const store = new AgentStore(':memory:'); const service = new AgentService(store, new DemoEngine(1));
  const app = createApp(service, { trustedWebOrigin: 'http://127.0.0.1:5173' });
  try {
    assert.equal((await app.request('http://127.0.0.1:4317/api/settings', { headers: { origin: 'http://127.0.0.1:5173' } })).status, 200);
    assert.equal((await app.request('http://127.0.0.1:4317/api/settings', { headers: { origin: 'https://untrusted.example' } })).status, 403);
    assert.equal((await app.request('http://127.0.0.1:4317/api/settings', { headers: { origin: 'http://127.0.0.1:5180' } })).status, 403);
  } finally { await service.close(); store.close(); }
});

test('saved Chinese results download as Markdown attachments with safe filenames and exact content', async () => {
  const store = new AgentStore(':memory:'); const service = new AgentService(store, new DemoEngine(1));
  const app = createApp(service);
  try {
    const submission = service.submit('中文成果\r\n文件名不能注入响应头'); await service.wait(submission.runId);
    const artifact = store.artifacts()[0]!;
    const response = await app.request('http://localhost/api/artifacts/' + artifact.id + '/download');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /text\/markdown; charset=utf-8/);
    const disposition = response.headers.get('content-disposition')!;
    assert.match(disposition, /^attachment;/); assert.match(disposition, /filename\*=UTF-8''/);
    assert.doesNotMatch(disposition, /[\r\n]/);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await response.text(), artifact.content);
    assert.equal((await app.request('http://localhost/api/artifacts/missing/download')).status, 404);
  } finally { await service.close(); store.close(); }
});
