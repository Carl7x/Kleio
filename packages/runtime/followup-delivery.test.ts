import { TEST_CONTEXT_CAPABILITIES, TEST_MODEL_CAPACITY } from './context-test-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeHost } from './host.ts';
import { RuntimeStore } from './store.ts';
import type { RuntimeConfig } from './config.ts';
import type { Engine } from './contracts.ts';
import { createRuntimeApp } from '../../apps/runtime/app.ts';
import { mainThreadSettingKey, researchFallbackSourceId } from '../../apps/runtime/kleio.ts';

test('kleio research routes can pause, revise, and resume a periodic follow-up', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'kleio-followup-'));
  const store = new RuntimeStore(join(directory, 'app.sqlite'));
  const config: RuntimeConfig = {
    port: 4317,
    token: 'local-test-token-0123456789',
    dataDirectory: directory,
    model: { ...TEST_MODEL_CAPACITY, baseURL: 'https://example.com', id: 'fixture', apiKey: '' },
    memoryIdleMs: 120_000,
  };
  const engine: Engine = { id: 'fixture', contextCapabilities: TEST_CONTEXT_CAPABILITIES, async execute() { return { text: 'ok' }; }, async close() {} };
  const host = new RuntimeHost(store, engine, config);
  const app = createRuntimeApp(host, () => {});
  t.after(async () => {
    await host.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const conversation = host.store.createConversation('跟进');
  const headers = { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' };
  await app.request('http://127.0.0.1/api/settings', { method: 'PATCH', headers, body: JSON.stringify({ timezone: 'Asia/Shanghai' }) });
  const created = await app.request('http://127.0.0.1/api/work', { method: 'POST', headers, body: JSON.stringify({
    requestId: 'api-follow', title: '价格', prompt: '每个工作日看价格，有变化才说', kind: 'research', schedule: { expression: '0 9 * * MON-FRI' }, conversationId: conversation.id,
  }) });
  assert.equal(created.status, 201);
  const task = await created.json() as { id: string; schedule: { expression: string; timeZone: string }; nextAt: string; intervalMs: null };
  assert.equal(task.schedule.expression, '0 9 * * MON-FRI');
  assert.equal(task.schedule.timeZone, 'Asia/Shanghai');
  assert.equal(task.intervalMs, null);
  assert.ok(Date.parse(task.nextAt) > Date.now() - 1000);

  const listed = await app.request('http://127.0.0.1/api/kleio/research', { headers });
  assert.equal(listed.status, 200);
  const list = await listed.json() as { research: Array<{ task: { id: string }; onlyOnChange: boolean; watch: string; watchNote: string; nextAt: string }> };
  assert.equal(list.research.some(item => item.task.id === task.id), true);
  const matter = list.research.find(item => item.task.id === task.id)!;
  assert.equal(matter.onlyOnChange, true);
  assert.equal(matter.watch, 'periodic-search');
  assert.match(matter.watchNote, /不是实时/);
  assert.equal(matter.nextAt, task.nextAt);

  const paused = await app.request(`http://127.0.0.1/api/kleio/research/${task.id}/control`, { method: 'POST', headers, body: JSON.stringify({ action: 'pause' }) });
  assert.equal(paused.status, 200);
  const pausedBody = await paused.json() as { progress: string; hold: string; nextAt: string | null; onlyOnChange: boolean };
  assert.equal(pausedBody.progress, 'stopped');
  assert.equal(pausedBody.hold, 'paused');
  assert.equal(pausedBody.nextAt, null);
  assert.equal(pausedBody.onlyOnChange, true);

  const revised = await app.request(`http://127.0.0.1/api/kleio/research/${task.id}/control`, { method: 'POST', headers, body: JSON.stringify({ action: 'revise', prompt: '只看新的价格条件', schedule: { expression: '0 10 * * MON-FRI', timeZone: 'Asia/Shanghai' } }) });
  assert.equal(revised.status, 200);
  const revisedBody = await revised.json() as { hold: string; progress: string; task: { prompt: string; constraintVersion: number; schedule: { expression: string }; constraints: Array<{ source: { messageId: string } }> } };
  assert.equal(revisedBody.hold, 'paused');
  assert.equal(revisedBody.progress, 'stopped');
  assert.equal(revisedBody.task.prompt, '只看新的价格条件');
  assert.equal(revisedBody.task.constraintVersion, 2);
  assert.equal(revisedBody.task.schedule.expression, '0 10 * * MON-FRI');
  assert.equal(revisedBody.task.constraints.at(-1)?.source.messageId, researchFallbackSourceId(task.id));
  const bySourceId = await app.request(`http://127.0.0.1/api/kleio/research/kleio:${task.id}`, { headers });
  assert.equal(bySourceId.status, 200);

  const resumed = await app.request(`http://127.0.0.1/api/kleio/research/${task.id}/control`, { method: 'POST', headers, body: JSON.stringify({ action: 'resume' }) });
  assert.equal(resumed.status, 200);
  const resumedBody = await resumed.json() as { hold: null; progress: string; nextAt: string; delivered: boolean };
  assert.equal(resumedBody.hold, null);
  assert.notEqual(resumedBody.progress, 'stopped');
  assert.ok(Date.parse(resumedBody.nextAt) > Date.now());
  assert.equal(resumedBody.delivered, false);
  assert.equal(host.store.messages(conversation.id).length, 0);
});

test('main thread reads and writes only the Kleio settings key', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'kleio-main-thread-'));
  const store = new RuntimeStore(join(directory, 'app.sqlite'));
  const config: RuntimeConfig = {
    port: 4317,
    token: 'local-test-token-0123456789',
    dataDirectory: directory,
    model: { ...TEST_MODEL_CAPACITY, baseURL: 'https://example.com', id: 'fixture', apiKey: '' },
    memoryIdleMs: 120_000,
  };
  const engine: Engine = { id: 'fixture', contextCapabilities: TEST_CONTEXT_CAPABILITIES, async execute() { return { text: 'ok' }; }, async close() {} };
  const host = new RuntimeHost(store, engine, config);
  const app = createRuntimeApp(host, () => {});
  t.after(async () => {
    await host.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const conversation = host.store.createConversation('原来的主对话');
  host.store.updateConversation(conversation.id, { isMain: true });
  host.store.setSetting(mainThreadSettingKey, conversation.id);
  const headers = { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' };
  const listed = await app.request('http://127.0.0.1/api/main-thread', { headers });
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), { threadId: conversation.id, existing: true });
  assert.equal(host.store.getSetting(mainThreadSettingKey, null), conversation.id);
  const archived = await app.request(`http://127.0.0.1/api/threads/${conversation.id}/archive`, { method: 'POST', headers, body: '{}' });
  assert.equal(archived.status, 400);

  const freshDirectory = mkdtempSync(join(tmpdir(), 'kleio-main-thread-new-'));
  const fresh = new RuntimeStore(join(freshDirectory, 'app.sqlite'));
  const freshConfig: RuntimeConfig = { ...config, dataDirectory: freshDirectory };
  const freshHost = new RuntimeHost(fresh, engine, freshConfig);
  const freshApp = createRuntimeApp(freshHost, () => {});
  t.after(async () => {
    await freshHost.close();
    fresh.close();
    rmSync(freshDirectory, { recursive: true, force: true });
  });
  const created = await freshApp.request('http://127.0.0.1/api/main-thread', { headers });
  assert.equal(created.status, 200);
  const body = await created.json() as { threadId: string };
  assert.equal(fresh.getSetting(mainThreadSettingKey, null), body.threadId);
});
