import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeHost } from './host.ts';
import { RuntimeStore } from './store.ts';
import type { Engine, ExecutionInput, ExecutionContext } from './contracts.ts';
import { TEST_CONTEXT_CAPABILITIES, TEST_MODEL_CAPACITY } from './context-test-fixture.ts';
import { resourcePageDigest } from './resource-ledger.ts';
import type { ResourcePage, RetainedResourceReceipt } from '../context-contracts/resources.ts';

async function until(check: () => boolean) { for (let n = 0; n < 200; n++) { if (check()) return; await delay(10); } throw new Error('Synthetic execution did not settle'); }
function fixture(engine: Engine, capacity: typeof TEST_MODEL_CAPACITY | {} = TEST_MODEL_CAPACITY) {
  const directory = mkdtempSync(join(tmpdir(), 'kleio-controlled-host-'));
  const store = new RuntimeStore(join(directory, 'app.sqlite'));
  const config = { port: 4317, token: 'synthetic-context-token-12345', dataDirectory: directory, model: { baseURL: 'https://example.invalid', id: 'synthetic', apiKey: '', ...capacity }, memoryIdleMs: 120000 };
  const host = new RuntimeHost(store, engine, config);
  return { directory, store, host, async close() { await host.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('missing capacity and undeclared engine capabilities reject before execute without hiding persisted data', async () => {
  for (const missing of ['capacity', 'capability'] as const) {
    let calls = 0;
    const engine: Engine = { id: 'fake', ...(missing === 'capacity' ? { contextCapabilities: TEST_CONTEXT_CAPABILITIES } : {}), async execute() { calls++; return { text: 'unreachable' }; }, async close() {} };
    const f = fixture(engine, missing === 'capacity' ? {} : TEST_MODEL_CAPACITY);
    try {
      const conversation = f.store.createConversation('Existing data stays readable');
      await assert.rejects(f.host.run('research', 'Synthetic request', 'Synthetic output contract'), (error: unknown) => (error as { code: string }).code === (missing === 'capacity' ? 'CONTEXT_CONFIGURATION_ERROR' : 'ENGINE_CONTEXT_UNSUPPORTED'));
      assert.equal(calls, 0);
      assert.equal(f.store.conversation(conversation.id).title, 'Existing data stays readable');
    } finally { await f.close(); }
  }
});

test('independent recording adapter consumes canonical bundle and explicitly verifies resource receipts every round', async () => {
  const receipts: RetainedResourceReceipt[] = [];
  const seen: ExecutionInput[] = [];
  let rounds = 0;
  const engine: Engine = { id: 'independent-recording-adapter', contextCapabilities: TEST_CONTEXT_CAPABILITIES,
    async execute(input, context) {
      seen.push(input); assert.equal(input.bundle?.version, 1); assert.ok(context.requestAdmission);
      const gate = () => {
        const admission = context.requestAdmission!;
        const decision = admission.check({ executionId: input.bundle!.executionId, hostGeneration: admission.binding.hostGeneration, policyEpoch: admission.binding.policyEpoch,
          requestSequence: ++rounds, profileVersion: admission.profile.version, contextLimit: admission.profile.contextLimit, outputLimit: admission.profile.outputLimit,
          estimatedInputTokens: input.bundle!.budget.estimatedInputTokens + receipts.length * 1000, estimatorId: 'recording-adapter-v1', retainedResourceReceipts: receipts });
        assert.equal(decision.kind, 'allow');
      };
      gate();
      assert.equal(input.context.includes('PRIVATE_BODY_SENTINEL'), false);
      const listed = await context.callTool('skills_list', { query: 'fourth' }) as { entries: Array<{ id: string; sourceVersion: string }> };
      assert.equal(listed.entries[0]?.id, 'fourth');
      let cursor: string | undefined;
      let fullText = '';
      do {
        const page = await context.callTool('skill_read', { skillId: 'fourth', expectedVersion: listed.entries[0]!.sourceVersion, ...(cursor ? { cursor } : {}) }) as ResourcePage;
        assert.equal(page.kind, 'context-resource');
        receipts.push({ receiptId: page.receiptId, digest: resourcePageDigest(page) });
        if (page.section === 'text') fullText += page.text;
        cursor = page.nextCursor ?? undefined;
        gate();
      } while (cursor);
      assert.match(fullText, /PRIVATE_BODY_SENTINEL/);
      const invalid = await context.callTool('context_read', { sourceRef: '/etc/passwd' }) as { ok: boolean; code: string; message: string };
      assert.deepEqual({ ok: invalid.ok, code: invalid.code }, { ok: false, code: 'INVALID_CONTEXT_SOURCE' });
      assert.ok(invalid.message.includes('sourceRef'));
      return { text: 'Synthetic verified result' };
    }, async close() {} };
  const f = fixture(engine);
  try {
    mkdirSync(join(f.directory, 'skills/fourth'), { recursive: true });
    writeFileSync(join(f.directory, 'skills/fourth/SKILL.md'), '---\nname: fourth\ndescription: Fourth synthetic skill\n---\nPRIVATE_BODY_SENTINEL');
    const conversation = f.store.createConversation();
    const execution = f.host.submit(conversation.id, 'Use the fourth skill', 'synthetic-fourth');
    await until(() => !['queued', 'running'].includes(f.store.execution(execution.id).status));
    assert.equal(f.store.execution(execution.id).status, 'completed');
    assert.ok(rounds >= 3);
    const events = f.store.events(0, execution.id);
    assert.ok(events.some(event => event.type === 'context.prepared'));
    assert.ok(events.some(event => event.type === 'context.resource_loaded'));
    assert.ok(events.some(event => event.type === 'context.resource_rejected'));
    assert.equal(JSON.stringify(events).includes('PRIVATE_BODY_SENTINEL'), false);
    assert.equal(seen.length, 1);
  } finally { await f.close(); }
});

test('Host preserves complete memory, complete history groups and standalone research delivery as budget candidates', async () => {
  const seen: ExecutionInput[] = [];
  const engine: Engine = { id: 'full-source-recording', contextCapabilities: TEST_CONTEXT_CAPABILITIES, async execute(input) { seen.push(input); return { text: 'A'.repeat(19000) + 'ASSISTANT_FULL_TAIL' }; }, async close() {} };
  const f = fixture(engine);
  try {
    const conversation = f.store.createConversation();
    const first = f.host.submit(conversation.id, 'Synthetic earlier turn', 'first');
    await until(() => f.store.execution(first.id).status === 'completed');
    f.store.insertAssistantMessage(conversation.id, 'STANDALONE_RESEARCH_DELIVERY', 'synthetic-delivery');
    const memoryText = '合成项目偏好喜欢桂花乌龙，'.repeat(65) + '记忆完整尾部';
    f.host.memory.remember({ key: '合成项目偏好', text: memoryText, kind: 'preference', source: { messageId: 'synthetic-memory', conversationId: conversation.id, createdAt: new Date().toISOString(), quote: memoryText } });
    f.host.createWork({ requestId: 'synthetic-background', title: 'Synthetic background', prompt: 'P'.repeat(5000) + 'BACKGROUND_FULL_TAIL', kind: 'research', conversationId: conversation.id, at: '2099-01-01T00:00:00Z' });
    const next = f.host.submit(conversation.id, '合成项目偏好喜欢桂花乌龙', 'next');
    await until(() => f.store.execution(next.id).status === 'completed');
    const bundle = seen.at(-1)!.bundle!;
    assert.ok(bundle.parts.memory.some(source => source.text.includes('记忆完整尾部')));
    assert.ok(bundle.parts.backgroundWork.some(source => source.text.includes('BACKGROUND_FULL_TAIL')));
    assert.ok(bundle.history.some(group => group.messages.some(message => message.content.endsWith('ASSISTANT_FULL_TAIL'))));
    assert.ok(bundle.history.some(group => group.messages.some(message => message.content === 'STANDALONE_RESEARCH_DELIVERY')));
    assert.equal(bundle.history[0]!.messages[1]!.content.length, 19000 + 'ASSISTANT_FULL_TAIL'.length);
  } finally { await f.close(); }
});

test('legacy research and review use their trusted task scope and exclude other conversations background work', async () => {
  const seen: ExecutionInput[] = [];
  const engine: Engine = { id: 'work-scope-recording', contextCapabilities: TEST_CONTEXT_CAPABILITIES, async execute(input) { seen.push(input); return { text: 'Synthetic done' }; }, async close() {} };
  const f = fixture(engine);
  try {
    const own = f.store.createConversation('Own'); const other = f.store.createConversation('Other');
    const task = f.host.createWork({ requestId: 'own-main', title: 'Own main', prompt: 'OWN_MAIN', kind: 'research', conversationId: own.id, at: '2099-01-01T00:00:00Z' });
    f.host.createWork({ requestId: 'own-extra', title: 'Own extra', prompt: 'OWN_EXTRA_BACKGROUND', kind: 'research', conversationId: own.id, at: '2099-01-01T00:00:00Z' });
    f.host.createWork({ requestId: 'other-extra', title: 'Other extra', prompt: 'OTHER_PRIVATE_BACKGROUND', kind: 'research', conversationId: other.id, at: '2099-01-01T00:00:00Z' });
    for (const kind of ['research', 'review'] as const) {
      await f.host.run(kind, 'Synthetic task check', scope => {
        assert.equal(scope.conversationId, own.id); assert.equal(scope.workId, task.id); return 'Synthetic output contract';
      }, undefined, task);
      const input = seen.at(-1)!;
      assert.equal(f.store.execution(input.id).conversationId, own.id);
      assert.ok(input.bundle!.parts.backgroundWork.some(source => source.text.includes('OWN_EXTRA_BACKGROUND')));
      assert.equal(JSON.stringify(input.bundle).includes('OTHER_PRIVATE_BACKGROUND'), false);
      assert.ok(input.bundle!.parts.task.some(source => source.sourceRef === `task:${task.id}` && source.text.includes('OWN_MAIN')));
    }
  } finally { await f.close(); }
});

test('omitted history remains available as complete group through the published context_read index', async () => {
  let recovered = '';
  const tail = 'COMPLETE_OMITTED_HISTORY_TAIL';
  const engine: Engine = { id: 'history-resource-recording', contextCapabilities: TEST_CONTEXT_CAPABILITIES, async execute(input, context) {
    if (input.prompt === 'Earlier synthetic request') return { text: 'H'.repeat(35000) + tail };
    const omitted = input.bundle!.manifest.find(entry => entry.kind === 'history' && !entry.included);
    assert.ok(omitted, 'fixture must force whole-group budget omission');
    const read = async (sourceRef: string) => {
      let cursor: string | undefined; let text = ''; let metadata = '';
      do {
        const page = await context.callTool('context_read', { sourceRef, ...(cursor ? { cursor } : {}) }) as ResourcePage;
        assert.equal(page.kind, 'context-resource');
        if (page.section === 'text') text += page.text; else metadata += page.text;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return { text, metadata };
    };
    const index = await read('history-index');
    assert.ok(index.metadata.includes(omitted.sourceRef));
    recovered = (await read(omitted.sourceRef)).text;
    return { text: 'Recovered complete history' };
  }, async close() {} };
  const f = fixture(engine, { contextWindow: 80000, maxTokens: 4096 });
  try {
    const conversation = f.store.createConversation();
    const earlier = f.host.submit(conversation.id, 'Earlier synthetic request', 'earlier');
    await until(() => f.store.execution(earlier.id).status === 'completed');
    const current = f.host.submit(conversation.id, 'Read earlier synthetic history', 'current');
    await until(() => !['queued', 'running'].includes(f.store.execution(current.id).status));
    assert.equal(f.store.execution(current.id).status, 'completed');
    const group = JSON.parse(recovered) as Array<{ role: string; content: string }>;
    assert.equal(group.length, 2);
    assert.equal(group[0]!.content, 'Earlier synthetic request');
    assert.equal(group[1]!.content, 'H'.repeat(35000) + tail);
  } finally { await f.close(); }
});

test('required standing that exceeds budget stops before any engine call without truncation', async () => {
  let calls = 0;
  const engine: Engine = { id: 'required-budget-recording', contextCapabilities: TEST_CONTEXT_CAPABILITIES, async execute() { calls++; return { text: 'must not run' }; }, async close() {} };
  const f = fixture(engine);
  try {
    mkdirSync(join(f.directory, 'standing'), { recursive: true });
    for (const name of ['IDENTITY.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'AGENTS.md']) writeFileSync(join(f.directory, 'standing', name), '# Synthetic standing\n' + 'required standing data '.repeat(700));
    await assert.rejects(f.host.run('review', 'Synthetic request', 'Required output contract'), (error: unknown) => (error as { code: string }).code === 'CONTEXT_BUDGET_EXCEEDED');
    assert.equal(calls, 0);
    assert.equal(JSON.stringify(f.store.events()).includes('required standing data'), false);
  } finally { await f.close(); }
});
