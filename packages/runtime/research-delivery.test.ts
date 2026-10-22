import { TEST_CONTEXT_CAPABILITIES, TEST_MODEL_CAPACITY } from './context-test-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeHost, evidenceFromSearch } from './host.ts';
import { RuntimeStore } from './store.ts';
import type { RuntimeConfig } from './config.ts';
import type { Engine } from './contracts.ts';
import { createRuntimeApp } from '../../apps/runtime/app.ts';

test('evidence comes from search result URLs only', () => {
  const evidence = evidenceFromSearch({
    query: 'public',
    results: [
      { url: 'https://example.com/a', title: 'A', content: 'one' },
      { url: 'https://example.com/a', title: 'duplicate', content: 'two' },
      { url: 'https://example.com/b', title: '  ', content: 'three' },
    ],
    warnings: [],
    truncated: false,
  });
  assert.deepEqual(evidence, [
    { kind: 'url', reference: 'https://example.com/a', title: 'A' },
    { kind: 'url', reference: 'https://example.com/b' },
  ]);
});

test('one-shot research writes searched URLs into the original conversation once', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'kleio-research-host-'));
  const store = new RuntimeStore(join(directory, 'app.sqlite'));
  const config: RuntimeConfig = {
    port: 4317,
    token: 'local-test-token-0123456789',
    dataDirectory: directory,
    model: { ...TEST_MODEL_CAPACITY, baseURL: 'https://example.com', id: 'fixture', apiKey: '' },
    memoryIdleMs: 120_000,
  };
  const engine: Engine = {
    id: 'fixture',
    contextCapabilities: TEST_CONTEXT_CAPABILITIES, async execute(input, context) {
      if (input.kind === 'research') {
        await context.callTool('web_search', { query: 'kleio public source' });
        return { text: '结论见 https://evil.example/not-searched' };
      }
      if (input.kind === 'review') return { text: JSON.stringify({ decision: 'notify', text: '详见 https://evil.example/not-searched' }) };
      return { text: 'ok' };
    },
    async close() {},
  };
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    results: [{ url: 'https://example.com/kleio-source', title: 'Kleio source', content: 'public snippet' }],
  }));
  const host = new RuntimeHost(store, engine, config);
  const app = createRuntimeApp(host, () => {});
  t.after(async () => {
    await host.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const conversation = host.store.createConversation('研究');
  const due = host.createWork({ requestId: 'due-research', title: '公开来源', prompt: '研究公开来源', kind: 'research', conversationId: conversation.id });
  const later = host.createWork({ requestId: 'later-research', title: '稍后', prompt: '稍后再研究', kind: 'research', at: '2099-01-01T00:00:00.000Z', conversationId: conversation.id });
  host.start();
  let written = false;
  for (let attempt = 0; attempt < 80 && !written; attempt += 1) {
    written = host.work.snapshot(due.id).progress === 'written';
    if (!written) await delay(100);
  }
  const view = host.work.snapshot(due.id);
  assert.equal(view.progress, 'written', JSON.stringify(view));
  assert.equal(view.delivered, true);
  assert.equal(view.read, false);
  assert.equal(view.delivery?.evidence[0]?.reference, 'https://example.com/kleio-source');
  const messages = host.store.messages(conversation.id);
  assert.equal(messages.length, 1);
  assert.match(messages[0]!.content, /https:\/\/example\.com\/kleio-source/);
  assert.doesNotMatch(messages[0]!.content, /evil\.example/);
  await delay(1200);
  assert.equal(host.store.messages(conversation.id).length, 1);

  const headers = { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' };
  const read = await app.request(`http://127.0.0.1/api/kleio/research/${due.id}/read`, { method: 'POST', headers });
  assert.equal(read.status, 200);
  const readBody = await read.json() as { progress: string; delivered: boolean; read: boolean };
  assert.equal(readBody.progress, 'written');
  assert.equal(readBody.delivered, true);
  assert.equal(readBody.read, true);
  assert.equal(host.store.messages(conversation.id).length, 1);

  const paused = await app.request(`http://127.0.0.1/api/kleio/research/${later.id}/control`, { method: 'POST', headers, body: JSON.stringify({ action: 'pause' }) });
  assert.equal(paused.status, 200);
  const pausedBody = await paused.json() as { progress: string; progressLabel: string; hold: string; delivered: boolean };
  assert.equal(pausedBody.progress, 'stopped');
  assert.equal(pausedBody.progressLabel, '已停止');
  assert.equal(pausedBody.hold, 'paused');
  assert.equal(pausedBody.delivered, false);
  const revised = await app.request(`http://127.0.0.1/api/kleio/research/${later.id}/control`, { method: 'POST', headers, body: JSON.stringify({ action: 'revise', prompt: '只看新的公开条件' }) });
  assert.equal(revised.status, 200);
  const revisedBody = await revised.json() as { progress: string; hold: string; task: { prompt: string; constraintVersion: number; constraints: Array<{ source: { messageId: string } }> } };
  assert.equal(revisedBody.task.prompt, '只看新的公开条件');
  assert.equal(revisedBody.task.constraintVersion, 2);
  assert.equal(revisedBody.task.constraints.at(-1)?.source.messageId, `kleio:${later.id}`);
  assert.equal(revisedBody.hold, 'paused');
  assert.equal(revisedBody.progress, 'stopped');
  const resumed = await app.request(`http://127.0.0.1/api/kleio/research/${later.id}/control`, { method: 'POST', headers, body: JSON.stringify({ action: 'resume' }) });
  assert.equal(resumed.status, 200);
  const resumedBody = await resumed.json() as { progress: string; hold: null; delivered: boolean };
  assert.equal(resumedBody.progress, 'queued');
  assert.equal(resumedBody.hold, null);
  assert.equal(resumedBody.delivered, false);
  const stopped = await app.request(`http://127.0.0.1/api/kleio/research/${later.id}/control`, { method: 'POST', headers, body: JSON.stringify({ action: 'stop' }) });
  assert.equal(stopped.status, 200);
  const stoppedBody = await stopped.json() as { progress: string; hold: string; delivered: boolean };
  assert.equal(stoppedBody.progress, 'stopped');
  assert.equal(stoppedBody.hold, 'cancelled');
  assert.equal(stoppedBody.delivered, false);
  const refused = await app.request(`http://127.0.0.1/api/kleio/research/${later.id}/control`, { method: 'POST', headers, body: JSON.stringify({ action: 'resume' }) });
  assert.equal(refused.status, 409);
  const unread = await app.request(`http://127.0.0.1/api/kleio/research/kleio:${later.id}/read`, { method: 'POST', headers });
  assert.equal(unread.status, 409);
});
