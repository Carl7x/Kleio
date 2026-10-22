import { TEST_CONTEXT_CAPABILITIES, TEST_MODEL_CAPACITY } from './context-test-fixture.ts';
import test, { describe, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeApp } from '../../apps/runtime/app.ts';
import { LOCAL_SCOPE_ID, type ContextScope, type StandingContextPart } from '../context-contracts/context.ts';
import { StandingStore, StandingStoreError } from '../product-context/index.ts';
import type { Engine, ExecutionContext, ExecutionInput, ToolDefinition } from './contracts.ts';
import type { RuntimeConfig } from './config.ts';
import { RuntimeHost } from './host.ts';
import { identitySettingKey, legacyIdentitySettingKey } from './identity.ts';
import { RuntimeStore, type Execution } from './store.ts';

const FILES = ['IDENTITY.md', 'SOUL.md', 'USER.md', 'TOOLS.md', 'AGENTS.md'] as const;
const MEMORY_CONTEXT = 'Extract durable memory from the supplied evidence under the exact schema. Return only JSON. No tools or independent actions.';
const PUBLIC_SOURCE = 'https://8.8.8.8/g3-synthetic-source';
const API_KEY = 'sk-g34hostkey0123456789abcd';
const SEARCH_KEY = 'tvly-g34searchkey0123456789';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function microtasksUntil(check: () => boolean, description: string): Promise<void> {
  for (let turn = 0; turn < 40; turn += 1) {
    if (check()) return;
    await Promise.resolve();
  }
  throw new Error(description);
}

function writeStanding(directory: string, input: { name: string; tone: 'warm' | 'concise' | 'thoughtful'; marker: string; extra?: string }): void {
  mkdirSync(join(directory, 'standing'), { recursive: true });
  const extra = input.extra ? `\n${input.extra}\n` : '\n';
  writeFileSync(join(directory, 'standing/IDENTITY.md'), `# Identity\n\n- Name: ${input.name}\n- Tone: ${input.tone}\n\n## Notes\n\n${input.marker} IDENTITY.md${extra}`);
  for (const file of FILES) {
    if (file === 'IDENTITY.md') continue;
    writeFileSync(join(directory, 'standing', file), `# ${file.slice(0, -3)}\n\n## Notes\n\n${input.marker} ${file}${extra}`);
  }
}

function assertFiles(text: string, marker: string): void {
  for (const file of FILES) assert.equal(text.includes(`${marker} ${file}`), true, file);
}

function copyScope(scope: ContextScope): ContextScope {
  const copy: { scopeId: string; executionId: string; conversationId?: string; workId?: string } = {
    scopeId: scope.scopeId,
    executionId: scope.executionId,
  };
  if (typeof scope.conversationId === 'string') copy.conversationId = scope.conversationId;
  if (typeof scope.workId === 'string') copy.workId = scope.workId;
  return copy;
}

function spyStanding(t: TestContext): { records: Array<{ scope: ContextScope; part: StandingContextPart }>; reads: { count: number } } {
  const records: Array<{ scope: ContextScope; part: StandingContextPart }> = [];
  const reads = { count: 0 };
  const originalCapture = StandingStore.prototype.capture;
  const originalRead = StandingStore.prototype.read;
  t.mock.method(StandingStore.prototype, 'capture', function (this: StandingStore, scope: ContextScope) {
    const part = originalCapture.call(this, scope);
    records.push({ scope: copyScope(scope), part });
    return part;
  });
  t.mock.method(StandingStore.prototype, 'read', function (this: StandingStore) {
    reads.count += 1;
    return originalRead.call(this);
  });
  return { records, reads };
}

function assertFrozen(part: StandingContextPart): void {
  assert.equal(Object.isFrozen(part), true);
  assert.equal(Object.isFrozen(part.scope), true);
  assert.equal(Object.isFrozen(part.content), true);
  assert.equal(Object.isFrozen(part.content.files), true);
  assert.equal(Object.isFrozen(part.content.files[0]), true);
  assert.equal(Object.isFrozen(part.content.problems), true);
  assert.throws(() => { (part.content as { name: string }).name = 'mutated'; });
}

function assertScope(scope: ContextScope, executionId: string, conversationId?: string, workId?: string): void {
  assert.equal(scope.scopeId, LOCAL_SCOPE_ID);
  assert.equal(scope.executionId, executionId);
  assert.notEqual(scope.executionId, 'forged-execution');
  if (workId) assert.equal(scope.workId, workId);
  else assert.equal(Object.hasOwn(scope, 'workId'), false);
  if (conversationId) assert.equal(scope.conversationId, conversationId);
  else assert.equal(Object.hasOwn(scope, 'conversationId'), false);
}

function assertNoHostSecrets(text: string, directory: string, part?: StandingContextPart): void {
  assert.equal(text.includes(API_KEY), false);
  assert.equal(text.includes(SEARCH_KEY), false);
  assert.equal(text.includes(directory), false);
  if (!part) return;
  assert.equal(text.includes(part.id), false);
  assert.equal(text.includes(part.content.snapshotId), false);
  assert.equal(text.includes(part.content.sourceVersion), false);
}

async function denyUnlistedTools(context: ExecutionContext): Promise<void> {
  for (const name of ['shell', 'email']) {
    await assert.rejects(() => context.callTool(name, {}), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'tool_denied');
  }
}

function persisted(store: RuntimeStore): string {
  const events = store.db.prepare('SELECT type, data FROM kr_events').all();
  const executions = store.db.prepare('SELECT record FROM kr_executions').all();
  const messages = store.db.prepare('SELECT record FROM kr_messages').all();
  const settings = store.db.prepare('SELECT key, value FROM kr_settings').all();
  const tasks = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kw_tasks'").get()
    ? store.db.prepare('SELECT record FROM kw_tasks').all()
    : [];
  const results = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kw_results'").get()
    ? store.db.prepare('SELECT record FROM kw_results').all()
    : [];
  return JSON.stringify({ events, executions, messages, settings, tasks, results });
}

function openHost(engine: Engine, options: { memoryIdleMs?: number; beforeHost?: (store: RuntimeStore) => void } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'kleio-g34-'));
  const store = new RuntimeStore(join(directory, 'test.sqlite'));
  options.beforeHost?.(store);
  const config: RuntimeConfig = {
    port: 4317,
    token: 'test-token-0123456789abcd',
    dataDirectory: directory,
    model: { ...TEST_MODEL_CAPACITY, baseURL: 'https://example.com', id: 'synthetic', apiKey: API_KEY },
    search: { apiKey: SEARCH_KEY },
    memoryIdleMs: options.memoryIdleMs ?? 120_000,
  };
  const host = new RuntimeHost(store, engine, config);
  return { directory, store, config, host };
}

describe('G3.4 host standing snapshot', { concurrency: false, timeout: 20_000 }, () => {
  test('foreground queue inserts B before the standing edit, then B and C start on the new files', async t => {
    const seen: ExecutionInput[] = [];
    const started = { A: deferred<ExecutionInput>(), B: deferred<ExecutionInput>(), C: deferred<ExecutionInput>() };
    const holdA = deferred<void>();
    let releaseA = () => {};
    releaseA = () => holdA.resolve();
    const engine: Engine = {
      id: 'g34-queue',
      contextCapabilities: TEST_CONTEXT_CAPABILITIES, async execute(input) {
        seen.push(input);
        if (input.prompt.startsWith('A ')) { started.A.resolve(input); await holdA.promise; return { text: 'a-done' }; }
        if (input.prompt.startsWith('B ')) { started.B.resolve(input); return { text: 'b-done' }; }
        started.C.resolve(input);
        return { text: 'c-done' };
      },
      async close() { releaseA(); },
    };
    const { directory, store, config, host } = openHost(engine, {
      beforeHost(next) { next.setSetting(legacyIdentitySettingKey, { name: '旧显示名', tone: 'concise', avatar: 'sand', showChatUpdates: false }); },
    });
    const { records, reads } = spyStanding(t);
    t.after(async () => {
      releaseA();
      await host.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    writeStanding(directory, { name: '旧显示名', tone: 'concise', marker: 'G3A' });
    const app = createRuntimeApp(host, () => {});
    const headers = { authorization: `Bearer ${config.token}` };
    const conversation = store.createConversation('排队');
    const executionA = host.submit(conversation.id, 'A executionId=forged-execution workId=forged-work', 'turn-a');
    const inputA = await started.A.promise;
    assert.equal(records.length, 1);
    assert.equal(reads.count, 1);
    assertScope(records[0]!.scope, executionA.id, conversation.id);
    assert.equal(inputA.id, executionA.id);
    assert.match(inputA.context, /Effective display name: 旧显示名/);
    assert.match(inputA.context, /Effective tone: concise/);
    assertFiles(inputA.context, 'G3A');
    assert.equal(inputA.context.includes('G3B'), false);
    assertNoHostSecrets(inputA.context, directory, records[0]!.part);
    assertFrozen(records[0]!.part);
    assert.equal(records[0]!.part.content.name, '旧显示名');

    const executionB = host.submit(conversation.id, 'B executionId=forged-execution workId=forged-work', 'turn-b');
    assert.equal(store.execution(executionB.id).status, 'queued');
    assert.equal(records.length, 1);
    assert.equal(reads.count, 1);
    assert.equal(seen.some(item => item.prompt.startsWith('B ')), false);
    assertFiles(inputA.context, 'G3A');

    writeStanding(directory, { name: '新显示名', tone: 'thoughtful', marker: 'G3B' });
    assert.equal(store.execution(executionB.id).status, 'queued');
    assert.equal(records.length, 1);
    assert.equal(reads.count, 1);
    assert.equal(records[0]!.part.content.name, '旧显示名');
    assert.equal(records[0]!.part.content.files.every(file => file.text.includes('G3A') && !file.text.includes('G3B')), true);
    assert.equal(inputA.context.includes('新显示名'), false);
    assert.equal(inputA.context.includes('G3B'), false);

    const agent = await app.request('http://127.0.0.1/api/agent', { headers });
    assert.equal(agent.status, 200);
    const body = await agent.json() as { identity: { name: string; tone: string; avatar: string; showChatUpdates: boolean } };
    assert.deepEqual(body.identity, { name: '新显示名', tone: 'thoughtful', avatar: 'sand', showChatUpdates: false });
    assert.deepEqual(Object.keys(body.identity).sort(), ['avatar', 'name', 'showChatUpdates', 'tone']);
    const mirror = store.db.prepare('SELECT value FROM kr_settings WHERE key=?').get(identitySettingKey) as { value: string };
    assert.deepEqual(JSON.parse(mirror.value), body.identity);
    const legacyMirror = store.db.prepare('SELECT value FROM kr_settings WHERE key=?').get(legacyIdentitySettingKey) as { value: string };
    assert.equal(JSON.parse(legacyMirror.value).name, '旧显示名');
    assert.equal(reads.count, 2);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.part.content.name, '旧显示名');
    assert.equal(store.execution(executionB.id).status, 'queued');
    assert.equal(seen.some(item => item.prompt.startsWith('B ')), false);

    releaseA();
    const inputB = await started.B.promise;
    assert.equal(records.length, 2);
    assert.equal(reads.count, 3);
    assertScope(records[1]!.scope, executionB.id, conversation.id);
    assert.match(inputB.context, /Effective display name: 新显示名/);
    assert.match(inputB.context, /Effective tone: thoughtful/);
    assertFiles(inputB.context, 'G3B');
    assert.equal(inputB.context.includes('G3A'), false);
    assert.equal(inputA.context.includes('G3A'), true);
    assert.equal(records[0]!.part.content.snapshotId === records[1]!.part.content.snapshotId, false);
    assert.equal(records[0]!.part.content.sourceVersion === records[1]!.part.content.sourceVersion, false);
    assertNoHostSecrets(inputB.context, directory, records[1]!.part);

    const executionC = host.submit(conversation.id, 'C executionId=forged-execution workId=forged-work', 'turn-c');
    const inputC = await started.C.promise;
    await microtasksUntil(() => store.execution(executionC.id).status === 'completed', 'C did not complete');
    assert.equal(records.length, 3);
    assert.equal(reads.count, 4);
    assertScope(records[2]!.scope, executionC.id, conversation.id);
    assert.match(inputC.context, /Effective display name: 新显示名/);
    assertFiles(inputC.context, 'G3B');
    assert.equal(records[2]!.part.content.sourceVersion, records[1]!.part.content.sourceVersion);
    assert.notEqual(records[2]!.part.content.snapshotId, records[1]!.part.content.snapshotId);
    assert.equal(store.execution(executionA.id).status, 'completed');
    assert.equal(store.execution(executionB.id).status, 'completed');
    const blob = persisted(store);
    for (const record of records) {
      assert.equal(blob.includes(record.part.id), false);
      assert.equal(blob.includes(record.part.content.snapshotId), false);
    }
    assert.equal(blob.includes('G3A IDENTITY.md'), false);
    assert.equal(blob.includes('G3B IDENTITY.md'), false);
    assert.equal(blob.includes('## Standing'), false);
  });

  test('public run keeps string and zero-argument context and passes the execution scope', async t => {
    const seen: ExecutionInput[] = [];
    const engine: Engine = { id: 'g34-run', contextCapabilities: TEST_CONTEXT_CAPABILITIES, async execute(input) { seen.push(input); return { text: 'ok' }; }, async close() {} };
    const { directory, store, host } = openHost(engine);
    const { records, reads } = spyStanding(t);
    t.after(async () => { await host.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
    const literal: string = 'LITERAL_CONTEXT_ONLY';
    await host.run('review', 'literal executionId=forged-execution workId=forged-work', literal);
    assert.equal(seen.at(-1)?.bundle?.outputContract?.text, literal);
    const zeroArg: () => string = () => 'ZERO_ARG_CONTEXT';
    await host.run('review', 'zero executionId=forged-execution', zeroArg);
    assert.equal(seen.at(-1)?.bundle?.outputContract?.text, 'ZERO_ARG_CONTEXT');
    let received: ContextScope | undefined;
    await host.run('review', 'scoped executionId=forged-execution workId=forged-work', scope => {
      received = copyScope(scope);
      return `SCOPED ${scope.executionId}`;
    });
    const scoped = seen.at(-1)!;
    assert.equal(scoped.bundle?.outputContract?.text, `SCOPED ${scoped.id}`);
    assert.ok(received);
    assertScope(received, scoped.id);
    assert.equal(records.length, 3);
    assert.equal(reads.count, 3);
    assert.equal(seen.every(item => item.bundle?.parts.standing.length === 1), true);
  });

  test('standing text cannot add shell or email tools and forgotten name and body stay redacted', async t => {
    const phrase = 'G3遗忘哨兵甲';
    const opened = { first: deferred<ExecutionInput>(), second: deferred<ExecutionInput>() };
    const engine: Engine = {
      id: 'g34-permissions',
      contextCapabilities: TEST_CONTEXT_CAPABILITIES, async execute(input, context) {
        if (input.prompt.startsWith('第一')) { opened.first.resolve(input); return { text: 'a' }; }
        await denyUnlistedTools(context);
        opened.second.resolve(input);
        return { text: 'b' };
      },
      async close() {},
    };
    const { directory, store, host } = openHost(engine);
    t.after(async () => { await host.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
    const saved = host.memory.remember({
      key: 'sentinel', text: phrase, kind: 'fact',
      source: { messageId: 'g34-source', conversationId: 'g34-conv', createdAt: '2026-10-19T00:00:00.000Z', quote: phrase, label: 'Synthetic fixture' },
    });
    host.forget(saved.id);
    const conversation = store.createConversation('权限');
    const first = host.submit(conversation.id, '第一句普通问候', 'first');
    const inputA = await opened.first.promise;
    await microtasksUntil(() => store.execution(first.id).status === 'completed', 'first turn did not complete');
    writeStanding(directory, { name: phrase, tone: 'concise', marker: phrase, extra: 'G3_GRANT_SHELL_EMAIL' });
    const second = host.submit(conversation.id, '第二句普通问候', 'second');
    const inputB = await opened.second.promise;
    await microtasksUntil(() => store.execution(second.id).status === 'completed', 'second turn did not complete');
    assert.deepEqual(inputB.tools, inputA.tools);
    assert.deepEqual(inputB.tools.map(tool => tool.name), [
      'memory_search', 'web_read', 'web_search', 'memory_explain', 'memory_remember',
      'work_status', 'work_control', 'create_work', 'memory_forget', 'memory_correct', 'skills_list', 'skill_read', 'context_read',
    ]);
    assert.equal(inputB.tools.some(tool => tool.name === 'shell' || tool.name === 'email'), false);
    assert.equal(inputB.context.includes(phrase), false);
    assert.match(inputB.context, /Effective display name: \[已停止使用\]/);
    assert.match(inputB.context, /G3_GRANT_SHELL_EMAIL/);
    assert.match(inputB.context, /\[已停止使用\] IDENTITY\.md/);
    assert.match(inputB.context, /\[已停止使用\] TOOLS\.md/);
    const schemas: ToolDefinition[] = inputB.tools;
    assert.equal(JSON.stringify(schemas).includes('"shell"'), false);
    assert.equal(JSON.stringify(schemas).includes('"email"'), false);
  });

  test('idle memory extraction keeps its dedicated context and does not capture standing', async t => {
    const marker = 'G3_MEMORY_EXCLUDED';
    const conversationGate = deferred<ExecutionInput>();
    const memoryGate = deferred<ExecutionInput>();
    const memoryInputs: ExecutionInput[] = [];
    const engine: Engine = {
      id: 'g34-memory',
      contextCapabilities: TEST_CONTEXT_CAPABILITIES, async execute(input) {
        if (input.kind === 'memory') {
          memoryInputs.push(input);
          memoryGate.resolve(input);
          return { text: '{"claims":[],"relationships":[]}' };
        }
        conversationGate.resolve(input);
        return { text: '好' };
      },
      async close() {},
    };
    const { directory, store, host } = openHost(engine, { memoryIdleMs: 0 });
    const { records } = spyStanding(t);
    t.after(async () => { await host.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
    writeStanding(directory, { name: '记忆旁路', tone: 'warm', marker });
    const conversation = store.createConversation('记忆');
    const execution = host.submit(conversation.id, '我住在杭州西湖边已经三年', 'live');
    const conversationInput = await conversationGate.promise;
    await microtasksUntil(() => store.execution(execution.id).status === 'completed', 'conversation did not complete');
    assert.match(conversationInput.context, new RegExp(marker));
    assert.equal(records.length, 1);
    host.start();
    const memoryInput = await memoryGate.promise;
    await microtasksUntil(() => memoryInputs.length >= 1 && store.execution(memoryInput.id).status !== 'queued', 'memory execution did not start');
    assert.equal(memoryInputs.every(input => input.bundle?.outputContract?.text === MEMORY_CONTEXT), true);
    assert.equal(memoryInputs.every(input => input.tools.length === 0), true);
    assert.equal(memoryInputs.every(input => input.prompt.includes('我住在杭州西湖边已经三年')), true);
    assert.equal(memoryInputs.some(input => input.context.includes(marker) || input.context.includes('## Standing') || input.prompt.includes(marker)), false);
    assert.equal(records.some(record => memoryInputs.some(input => input.id === record.scope.executionId)), false);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.scope.executionId, execution.id);
  });

  test('CONFIG_CHANGED fails the execution before the engine starts', async t => {
    let engineCalls = 0;
    const engine: Engine = { id: 'g34-fail', contextCapabilities: TEST_CONTEXT_CAPABILITIES, async execute() { engineCalls += 1; return { text: 'should-not-run' }; }, async close() {} };
    const { directory, store, host } = openHost(engine);
    writeStanding(directory, { name: '失败名', tone: 'warm', marker: 'G3_SECRET_BODY' });
    const originalCapture = StandingStore.prototype.capture;
    const seen: string[] = [];
    t.mock.method(StandingStore.prototype, 'capture', function (this: StandingStore, scope: ContextScope) {
      seen.push(scope.executionId);
      return originalCapture.call(this, scope);
    });
    t.mock.method(StandingStore.prototype, 'read', () => { throw new StandingStoreError('CONFIG_CHANGED'); });
    t.after(async () => { await host.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
    const conversation = store.createConversation('失败');
    const execution = host.submit(conversation.id, '你好', 'fail');
    await microtasksUntil(() => store.execution(execution.id).status === 'failed', 'failed execution did not settle');
    const settled = store.execution(execution.id);
    assert.equal(settled.status, 'failed');
    assert.match(settled.error ?? '', /CONFIG_CHANGED: Standing files changed while they were being read\. Stop editing and retry\./);
    assert.equal(engineCalls, 0);
    assert.deepEqual(seen, [execution.id]);
    const types = store.events(0, execution.id).map(event => event.type);
    assert.equal(types.includes('execution.started'), false);
    assert.equal(types.includes('execution.failed'), true);
    const blob = persisted(store);
    assert.equal(blob.includes('G3_SECRET_BODY'), false);
    assert.equal(blob.includes('snapshotId'), false);
    assert.equal((settled.error ?? '').includes(directory), false);
  });

  for (const branch of ['scheduled', 'one-shot', 'legacy-interval'] as const) {
    test(`${branch} research captures standing when it starts`, { timeout: 20_000 }, async t => {
      const seen: ExecutionInput[] = [];
      const blockerGate = deferred<void>();
      const researchGate = deferred<ExecutionInput>();
      const reviewGate = deferred<ExecutionInput>();
      const holdResearch = deferred<void>();
      const slotGate = deferred<void>();
      let releaseBlocker = () => {};
      let releaseResearch = () => {};
      let releaseSlot = () => {};
      releaseBlocker = () => blockerGate.resolve();
      releaseResearch = () => holdResearch.resolve();
      releaseSlot = () => slotGate.resolve();
      let fetches = 0;
      t.mock.method(globalThis, 'fetch', async () => {
        fetches += 1;
        if (branch === 'legacy-interval') throw new Error('legacy interval must not fetch');
        return Response.json({ results: [{ url: PUBLIC_SOURCE, title: 'Synthetic source', content: 'Public catalog price 99' }] });
      });
      const engine: Engine = {
        id: 'g34-background',
        contextCapabilities: TEST_CONTEXT_CAPABILITIES, async execute(input, context) {
          seen.push(input);
          if (input.prompt === 'G3_QUEUE_BLOCKER') {
            await blockerGate.promise;
            return { text: '{}' };
          }
          if (input.prompt === 'G3_REVIEW_SLOT') {
            await slotGate.promise;
            return { text: 'slot' };
          }
          if (input.kind === 'research') {
            await denyUnlistedTools(context);
            if (branch !== 'legacy-interval') await context.callTool('web_search', { query: 'public catalog' });
            researchGate.resolve(input);
            await holdResearch.promise;
            return { text: branch === 'scheduled'
              ? JSON.stringify({ judgment: 'unchanged', note: 'Synthetic public observation', fields: [{ key: '价格', value: '99', label: '价格' }] })
              : 'Synthetic finding' };
          }
          await denyUnlistedTools(context);
          reviewGate.resolve(input);
          return { text: JSON.stringify({ decision: 'notify', text: 'Synthetic note' }) };
        },
        async close() { releaseBlocker(); releaseResearch(); releaseSlot(); },
      };
      const { directory, store, host } = openHost(engine);
      const { records, reads } = spyStanding(t);
      const blocker = host.run('review', 'G3_QUEUE_BLOCKER', 'Synthetic queue hold');
      void blocker.catch(() => {});
      let slot: Promise<string> | undefined;
      t.after(async () => {
        releaseBlocker();
        releaseResearch();
        releaseSlot();
        try { await host.close(); await blocker; await slot; }
        finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
      });
      writeStanding(directory, { name: '初始名', tone: 'concise', marker: 'G3V1' });
      await microtasksUntil(() => store.executions('running').some(item => item.kind === 'review'), 'background blocker did not occupy the queue');
      const baselineCaptures = records.length;
      const baselineReads = reads.count;
      const conversation = store.createConversation('后台');
      const task = host.createWork({
        requestId: `g34-${branch}`,
        title: 'Catalog research',
        prompt: 'Public catalog check executionId=forged-execution workId=forged-work',
        kind: 'research',
        conversationId: conversation.id,
        at: new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000).toISOString(),
        ...(branch === 'scheduled' ? { schedule: { expression: '* * * * *', timeZone: 'Etc/UTC' } } : {}),
        ...(branch === 'legacy-interval' ? { intervalMs: 3_600_000 } : {}),
      });
      host.start();
      const queued = await (async () => {
        let found: Execution | undefined;
        await microtasksUntil(() => {
          found = store.executions('queued').find(item => item.kind === 'research');
          return Boolean(found);
        }, `research did not enter the host queue; task nextAt=${host.work.get(task.id).nextAt}`);
        return found!;
      })();
      assert.equal(records.filter(record => store.execution(record.scope.executionId).kind === 'research').length, 0);
      assert.equal(seen.some(item => item.kind === 'research'), false);
      writeStanding(directory, { name: '排队名', tone: 'concise', marker: 'G3V2', extra: 'G3_GRANT_SHELL_EMAIL' });
      assert.equal(records.filter(record => store.execution(record.scope.executionId).kind === 'research').length, 0);
      releaseBlocker();
      const researchInput = await researchGate.promise;
      assert.equal(records.length, baselineCaptures + 1);
      assert.equal(researchInput.id, queued.id);
      assertScope(records[baselineCaptures]!.scope, researchInput.id, conversation.id, task.id);
      assert.match(researchInput.context, /Effective display name: 排队名/);
      assertFiles(researchInput.context, 'G3V2');
      assert.equal(researchInput.context.includes('G3V1'), false);
      assert.equal(researchInput.context.includes('初始名'), false);
      assert.match(researchInput.context, /G3_GRANT_SHELL_EMAIL/);
      assert.equal(researchInput.tools.some(tool => tool.name === 'shell' || tool.name === 'email'), false);
      assert.deepEqual(researchInput.tools.map(tool => tool.name), branch === 'legacy-interval'
        ? ['memory_search', 'web_read', 'skills_list', 'skill_read', 'context_read']
        : ['memory_search', 'web_read', 'web_search', 'skills_list', 'skill_read', 'context_read']);
      assert.match(researchInput.context, branch === 'scheduled' ? /periodic follow-up/ : branch === 'one-shot' ? /one-time research handoff/ : /background research handoff/);
      assertNoHostSecrets(researchInput.context, directory, records[baselineCaptures]!.part);
      assertFrozen(records[baselineCaptures]!.part);
      assert.equal(fetches, branch === 'legacy-interval' ? 0 : 1);
      if (branch === 'one-shot') {
        const known = new Set(store.executions().map(item => item.id));
        slot = host.run('memory', 'G3_REVIEW_SLOT', 'raw-context hold');
        void slot.catch(() => {});
        const slotExecution = store.executions().find(item => item.kind === 'memory' && !known.has(item.id));
        assert.ok(slotExecution);
        assert.equal(slotExecution.status, 'queued');
        assert.equal(records.length, baselineCaptures + 1);
        assert.equal(reads.count, baselineReads + 1);
        assert.equal(seen.some(item => item.prompt === 'G3_REVIEW_SLOT'), false);
        releaseResearch();
        let reviewExecution: Execution | undefined;
        await microtasksUntil(() => {
          reviewExecution = store.executions('queued').find(item => item.kind === 'review');
          return store.execution(slotExecution.id).status === 'running' && Boolean(reviewExecution);
        }, 'product review did not stay queued behind the raw-context blocker');
        assert.ok(reviewExecution);
        assert.equal(store.execution(reviewExecution.id).status, 'queued');
        assert.equal(records.length, baselineCaptures + 1);
        assert.equal(reads.count, baselineReads + 1);
        assert.equal(seen.some(item => item.kind === 'review' && item.prompt !== 'G3_QUEUE_BLOCKER'), false);
        const slotInput = seen.find(item => item.prompt === 'G3_REVIEW_SLOT');
        assert.equal(slotInput?.bundle?.outputContract?.text, 'raw-context hold');
        assert.equal(slotInput?.context.includes('## Standing'), false);
        assert.equal(records[baselineCaptures]!.part.content.name, '排队名');
        writeStanding(directory, { name: '复核名', tone: 'thoughtful', marker: 'G3V3', extra: 'G3_GRANT_SHELL_EMAIL' });
        assert.equal(store.execution(reviewExecution.id).status, 'queued');
        assert.equal(records.length, baselineCaptures + 1);
        assert.equal(reads.count, baselineReads + 1);
        assert.equal(records[baselineCaptures]!.part.content.name, '排队名');
        assert.equal(records[baselineCaptures]!.part.content.files.every(file => file.text.includes('G3V2') && !file.text.includes('G3V3')), true);
        assert.equal(researchInput.context.includes('复核名'), false);
        assert.equal(researchInput.context.includes('G3V3'), false);
        releaseSlot();
        const reviewInput = await reviewGate.promise;
        assert.equal(reviewInput.id, reviewExecution.id);
        assert.equal(records.length, baselineCaptures + 2);
        assert.equal(reads.count, baselineReads + 2);
        assert.equal(records.filter(record => record.scope.executionId === reviewInput.id).length, 1);
        assertScope(records[baselineCaptures + 1]!.scope, reviewInput.id, conversation.id, task.id);
        assert.match(reviewInput.context, /Effective display name: 复核名/);
        assert.match(reviewInput.context, /Effective tone: thoughtful/);
        assertFiles(reviewInput.context, 'G3V3');
        assert.equal(reviewInput.context.includes('G3V2'), false);
        assert.match(reviewInput.context, /Review this background result/);
        assert.deepEqual(reviewInput.tools, []);
        assert.match(researchInput.context, /排队名/);
        assertFiles(researchInput.context, 'G3V2');
        assert.equal(records[baselineCaptures]!.part.content.name, '排队名');
        assert.equal(records[baselineCaptures]!.scope.executionId, researchInput.id);
        assert.notEqual(records[baselineCaptures + 1]!.part.content.snapshotId, records[baselineCaptures]!.part.content.snapshotId);
        assertNoHostSecrets(reviewInput.context, directory, records[baselineCaptures + 1]!.part);
        const blob = persisted(store);
        assert.equal(blob.includes(records[baselineCaptures]!.part.id), false);
        assert.equal(blob.includes(records[baselineCaptures + 1]!.part.id), false);
        assert.equal(blob.includes('## Standing'), false);
        assert.equal(blob.includes('G3V2 IDENTITY.md'), false);
        assert.equal(blob.includes('G3V3 IDENTITY.md'), false);
        return;
      }
      writeStanding(directory, { name: '复核名', tone: 'thoughtful', marker: 'G3V3', extra: 'G3_GRANT_SHELL_EMAIL' });
      assert.equal(records.length, baselineCaptures + 1);
      assert.equal(records[baselineCaptures]!.part.content.name, '排队名');
      assert.equal(records[baselineCaptures]!.part.content.files.every(file => file.text.includes('G3V2') && !file.text.includes('G3V3')), true);
      assert.match(researchInput.context, /排队名/);
      assert.equal(researchInput.context.includes('复核名'), false);
      releaseResearch();
      if (branch === 'scheduled') {
        await microtasksUntil(() => host.work.runs(task.id).some(run => run.status !== 'running'), 'scheduled research did not leave running');
        await Promise.resolve();
        assert.equal(records.length, baselineCaptures + 1);
        assert.equal(seen.some(item => item.kind === 'review' && item.prompt !== 'G3_QUEUE_BLOCKER'), false);
        assert.equal(records[baselineCaptures]!.part.content.name, '排队名');
        return;
      }
      const reviewInput = await reviewGate.promise;
      assert.equal(records.length, baselineCaptures + 2);
      assertScope(records[baselineCaptures + 1]!.scope, reviewInput.id, conversation.id, task.id);
      assert.notEqual(reviewInput.id, researchInput.id);
      assert.match(reviewInput.context, /Effective display name: 复核名/);
      assert.match(reviewInput.context, /Effective tone: thoughtful/);
      assertFiles(reviewInput.context, 'G3V3');
      assert.equal(reviewInput.context.includes('G3V2'), false);
      assert.match(reviewInput.context, /Review this background result/);
      assert.deepEqual(reviewInput.tools, []);
      assert.match(researchInput.context, /排队名/);
      assert.equal(records[baselineCaptures]!.part.content.name, '排队名');
      assert.notEqual(records[baselineCaptures + 1]!.part.content.snapshotId, records[baselineCaptures]!.part.content.snapshotId);
      assertNoHostSecrets(reviewInput.context, directory, records[baselineCaptures + 1]!.part);
      const blob = persisted(store);
      assert.equal(blob.includes(records[baselineCaptures]!.part.id), false);
      assert.equal(blob.includes(records[baselineCaptures + 1]!.part.id), false);
      assert.equal(blob.includes('## Standing'), false);
      assert.equal(blob.includes('G3V2 IDENTITY.md'), false);
      assert.equal(blob.includes('G3V3 IDENTITY.md'), false);
    });
  }

  test('identity POST and GET keep avatar and showChatUpdates in SQLite', async t => {
    const engine: Engine = { id: 'g34-identity', contextCapabilities: TEST_CONTEXT_CAPABILITIES, async execute() { return { text: 'ok' }; }, async close() {} };
    const directory = mkdtempSync(join(tmpdir(), 'kleio-g34-identity-'));
    const store = new RuntimeStore(join(directory, 'test.sqlite'));
    store.setSetting(legacyIdentitySettingKey, { name: '旧名', tone: 'thoughtful', avatar: 'lilac', showChatUpdates: false });
    const config: RuntimeConfig = {
      port: 4317, token: 'test-token-0123456789abcd', dataDirectory: directory,
      model: { ...TEST_MODEL_CAPACITY, baseURL: 'https://example.com', id: 'synthetic', apiKey: '' }, memoryIdleMs: 120_000,
    };
    const host = new RuntimeHost(store, engine, config);
    const app = createRuntimeApp(host, () => {});
    t.after(async () => { await host.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
    const headers = { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' };
    const posted = await app.request('http://127.0.0.1/api/agent/identity', {
      method: 'POST', headers, body: JSON.stringify({ name: '河洛', tone: 'concise' }),
    });
    assert.equal(posted.status, 200);
    const saved = await posted.json() as { name: string; tone: string; avatar: string; showChatUpdates: boolean };
    assert.deepEqual(saved, { name: '河洛', tone: 'concise', avatar: 'lilac', showChatUpdates: false });
    assert.deepEqual(Object.keys(saved).sort(), ['avatar', 'name', 'showChatUpdates', 'tone']);
    const row = store.db.prepare('SELECT value FROM kr_settings WHERE key=?').get(identitySettingKey) as { value: string };
    assert.deepEqual(JSON.parse(row.value), saved);
    const legacyRow = store.db.prepare('SELECT value FROM kr_settings WHERE key=?').get(legacyIdentitySettingKey) as { value: string };
    assert.deepEqual(JSON.parse(legacyRow.value), { name: '旧名', tone: 'thoughtful', avatar: 'lilac', showChatUpdates: false });
    const identityFile = readFileSync(join(directory, 'standing/IDENTITY.md'), 'utf8');
    assert.match(identityFile, /- Name: 河洛\n- Tone: concise/);
    assert.equal(identityFile.includes('showChatUpdates'), false);
    const agent = await app.request('http://127.0.0.1/api/agent', { headers });
    assert.equal(agent.status, 200);
    const body = await agent.json() as { identity: typeof saved };
    assert.deepEqual(body.identity, saved);
    const updated = await app.request('http://127.0.0.1/api/agent/identity', {
      method: 'POST', headers, body: JSON.stringify({ name: '河洛', tone: 'concise', avatar: 'sand', showChatUpdates: true }),
    });
    assert.equal(updated.status, 200);
    const next = await updated.json() as typeof saved;
    assert.deepEqual(next, { name: '河洛', tone: 'concise', avatar: 'sand', showChatUpdates: true });
    assert.deepEqual(Object.keys(next).sort(), ['avatar', 'name', 'showChatUpdates', 'tone']);
    const rowAfter = store.db.prepare('SELECT value FROM kr_settings WHERE key=?').get(identitySettingKey) as { value: string };
    assert.deepEqual(JSON.parse(rowAfter.value), next);
    const legacyAfter = store.db.prepare('SELECT value FROM kr_settings WHERE key=?').get(legacyIdentitySettingKey) as { value: string };
    assert.deepEqual(JSON.parse(legacyAfter.value), { name: '旧名', tone: 'thoughtful', avatar: 'lilac', showChatUpdates: false });
    const shown = await app.request('http://127.0.0.1/api/agent', { headers });
    const shownBody = await shown.json() as { identity: typeof saved };
    assert.deepEqual(shownBody.identity, next);
  });
});
