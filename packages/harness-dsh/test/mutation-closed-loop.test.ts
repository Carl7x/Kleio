/** Real pinned DSH cancellation after a durable product mutation, using a local scripted model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDshEngine } from '../../engines/dsh.ts';
import { DshAcpClient } from '../src/index.ts';
import { RuntimeHost } from '../../runtime/host.ts';
import { RuntimeStore } from '../../runtime/store.ts';
import { TEST_MODEL_CAPACITY } from '../../runtime/context-test-fixture.ts';

for (const closeFailure of [false, true]) {
  test(`real DSH mutation stops before the next model request and ${closeFailure ? 'unconfirmed close stays unknown' : 'confirmed cancellation yields only Host confirmation'}`, { timeout: 30000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'kleio-mutation-real-'));
    let requests = 0; let savedId = '';
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* drain the real model request */ }
      requests++;
      const frame = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ id: 'mutation-local', object: 'chat.completion.chunk', model: 'mutation-local', created: 1, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.setHeader('content-type', 'text/event-stream');
      response.write(frame({ role: 'assistant', content: '' }));
      response.write(frame({ tool_calls: [{ index: 0, id: 'forget-one', type: 'function', function: { name: 'mcp__kleio__memory_forget', arguments: JSON.stringify({ id: savedId, authorizationQuote: '请忘掉指定记忆' }) } }] }));
      response.write(frame({}, 'tool_calls')); response.end('data: [DONE]\n\n');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const model = { ...TEST_MODEL_CAPACITY, baseURL: `http://127.0.0.1:${address.port}/v1`, id: 'mutation-local', apiKey: 'synthetic-local-key' };
    const engine = createDshEngine({ dataDirectory: join(directory, 'engine'), model, promptTimeoutMs: 20000 });
    const store = new RuntimeStore(join(directory, 'app.sqlite'));
    const host = new RuntimeHost(store, engine, { port: 4317, token: 'synthetic-mutation-token-123', dataDirectory: directory, model, memoryIdleMs: 120000 });
    if (closeFailure) {
      const close = DshAcpClient.prototype.close;
      t.mock.method(DshAcpClient.prototype, 'close', async function (this: DshAcpClient) { await close.call(this); throw new Error('Synthetic close confirmation failure'); });
    }
    try {
      savedId = host.memory.remember({ key: '饮品', text: '我喜欢桂花乌龙', source: { messageId: 'synthetic', conversationId: 'synthetic', createdAt: new Date().toISOString(), quote: '我喜欢桂花乌龙' } }).id;
      const conversation = store.createConversation();
      const execution = host.submit(conversation.id, '请忘掉指定记忆', 'real-forget');
      for (let n = 0; n < 500 && ['queued', 'running'].includes(store.execution(execution.id).status); n++) await delay(20);
      const final = store.execution(execution.id);
      assert.equal(final.status, closeFailure ? 'unknown' : 'completed');
      assert.equal(requests, 1);
      assert.equal(host.memory.explain(savedId).stopped, true);
      assert.equal(final.contextActions?.length, 1);
      assert.equal(final.contextFailure?.retryable, false);
      assert.match(final.text, /已遗忘指定记忆/);
      assert.match(final.text, /本轮其余处理已停止/);
      if (closeFailure) assert.match(final.text, /尚无法确认/);
      const receipt = store.events(0, final.id).find(event => event.type === 'context.mutation_receipt');
      assert.ok(receipt);
      assert.equal(JSON.stringify(receipt.data).includes('桂花乌龙'), false);
      const before = store.executions().length;
      assert.throws(() => host.retryConversation(final.id));
      assert.equal(store.executions().length, before);
    } finally { await host.close(); store.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
  });
}
