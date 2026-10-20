import { TEST_CONTEXT_CAPABILITIES, TEST_MODEL_CAPACITY } from './context-test-fixture.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeHost } from './host.ts';
import { RuntimeStore } from './store.ts';
import type { Engine, ExecutionInput } from './contracts.ts';
import type { RuntimeConfig } from './config.ts';

const privateFact = 'catalog preference G1_PRIVATE_MEMORY_SENTINEL';
const request = 'Research catalog preference';
const publicSource = 'https://8.8.8.8/g1-synthetic-source';

async function until(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, description);
    await delay(20);
  }
}

for (const branch of ['scheduled', 'one-shot', 'legacy-interval'] as const) {
  for (const mode of ['enabled', 'disabled', 'disabled-while-queued'] as const) {
    test(`${branch} research respects memory ${mode} at execution start`, async t => {
      const directory = mkdtempSync(join(tmpdir(), 'kleio-background-memory-'));
      const store = new RuntimeStore(join(directory, 'app.sqlite'));
      const seen: ExecutionInput[] = [];
      let releaseBlocker!: () => void;
      const gate = new Promise<void>(resolve => { releaseBlocker = resolve; });
      let blockerStarted = false;
      let blocker: Promise<string> | undefined;
      let searches = 0;
      const engine: Engine = {
        id: 'synthetic-memory-toggle',
        contextCapabilities: TEST_CONTEXT_CAPABILITIES, async execute(input, context) {
          if (input.prompt === 'G1_QUEUE_BLOCKER') {
            blockerStarted = true;
            await gate;
            return { text: '{}' };
          }
          seen.push(input);
          if (input.kind === 'research') {
            if (mode !== 'enabled') {
              // Observed research still has a static schema list; G4 will unify it.
              // Regardless of that presentation gap, the real handler must deny recall.
              const code = input.tools.some(tool => tool.name === 'memory_search') ? 'memory_disabled' : 'tool_denied';
              await assert.rejects(() => context.callTool('memory_search', { queries: [request] }),
                (error: unknown) => error instanceof Error && 'code' in error && error.code === code);
            }
            if (input.tools.some(tool => tool.name === 'web_search')) {
              await context.callTool('web_search', { query: request });
            }
            return { text: branch === 'scheduled'
              ? JSON.stringify({ judgment: 'unchanged', note: 'Synthetic public observation', fields: [{ key: '价格', value: '99', label: '价格' }] })
              : `Synthetic public finding: ${publicSource}` };
          }
          if (input.kind === 'review') return { text: JSON.stringify({ decision: 'notify', text: 'Synthetic public finding' }) };
          return { text: '{}' };
        },
        async close() { releaseBlocker(); },
      };
      const config: RuntimeConfig = {
        port: 4317, token: 'synthetic-token-0123456789', dataDirectory: directory,
        model: { ...TEST_MODEL_CAPACITY, baseURL: 'https://example.com', id: 'synthetic', apiKey: '' },
        memoryIdleMs: 120_000,
      };
      // The connector runs normally; only the remote search response is synthetic.
      // A literal public IP also avoids an external DNS dependency in this fixture.
      t.mock.method(globalThis, 'fetch', async () => {
        searches += 1;
        return Response.json({ results: [{ url: publicSource, title: 'Synthetic source', content: 'Public catalog price 99' }] });
      });
      const host = new RuntimeHost(store, engine, config);
      t.after(async () => {
        releaseBlocker();
        try { await host.close(); await blocker?.catch((error: unknown) => { assert.equal((error as { code: string }).code, 'CONTEXT_INVALIDATED'); }); }
        finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
      });
      const conversation = store.createConversation('G1 synthetic research');
      const claim = host.memory.remember({
        key: 'catalog preference', text: privateFact, kind: 'preference',
        source: { messageId: 'g1-source', conversationId: conversation.id, createdAt: new Date().toISOString(), quote: privateFact, label: 'Synthetic fixture' },
      });
      assert.ok(host.memory.context(request).includes(privateFact), 'the fixture must be recallable when enabled');
      assert.ok(!request.includes('G1_PRIVATE_MEMORY_SENTINEL'));
      assert.equal(store.messages(conversation.id).length, 0, 'the private fact exists only in saved memory');

      if (mode === 'disabled') host.setMemoryEnabled(false);
      if (mode === 'disabled-while-queued') {
        // A public background execution occupies the queue without editing task state.
        blocker = host.run('review', 'G1_QUEUE_BLOCKER', 'Synthetic queue fixture');
        await until(() => blockerStarted, 'background queue blocker did not start');
      }
      const task = host.createWork({
        requestId: `g1-${branch}-${mode}`, title: 'Catalog research', prompt: request,
        kind: 'research', conversationId: conversation.id,
        at: new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000).toISOString(),
        ...(branch === 'scheduled' ? { schedule: { expression: '* * * * *', timeZone: 'Etc/UTC' } } : {}),
        ...(branch === 'legacy-interval' ? { intervalMs: 3_600_000 } : {}),
      });
      host.start();
      if (mode === 'disabled-while-queued') {
        await until(() => store.executions('queued').some(item => item.kind === 'research'), 'research did not enter the real host queue');
        assert.equal(seen.some(item => item.kind === 'research'), false);
        host.setMemoryEnabled(false);
        releaseBlocker();
        await assert.rejects(blocker!, (error: unknown) => (error as { code: string }).code === 'CONTEXT_INVALIDATED');
      }
      await until(() => host.work.runs(task.id).some(run => run.status === 'completed'), 'background task did not complete');
      const research = seen.filter(item => item.kind === 'research');
      assert.equal(research.length, 1);
      const input = research[0]!;
      if (mode === 'enabled') assert.ok(input.context.includes(privateFact), 'enabled recall must remain available');
      else {
        assert.ok(!JSON.stringify(input).includes(privateFact), 'disabled saved memory must not enter the engine input');
      }
      assert.equal(host.memory.list().find(item => item.id === claim.id)?.status, 'active', 'disabling recall must not delete the saved claim');
      assert.equal(host.memory.list().find(item => item.id === claim.id)?.text, privateFact);
      assert.equal(store.getSetting('memoryEnabled', true), mode === 'enabled');
      assert.equal(searches, branch === 'legacy-interval' ? 0 : 1);
      if (branch === 'one-shot') {
        assert.equal(host.work.snapshot(task.id).progress, 'written');
        assert.equal(store.messages(conversation.id).length, 1, 'research still writes to its original conversation');
      }
    });
  }
}
