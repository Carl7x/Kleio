import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRuntimeApp } from '../../apps/runtime/app.ts';
import type { Engine, ExecutionInput } from './contracts.ts';
import type { RuntimeConfig } from './config.ts';
import { RuntimeHost, scrubWorkInjection } from './host.ts';
import { RuntimeStore } from './store.ts';

function hostFor(engine: Engine) {
  const directory = mkdtempSync(join(tmpdir(), 'kleio-host-'));
  const store = new RuntimeStore(':memory:');
  const config: RuntimeConfig = { port: 4317, token: 'test-token-0123456789abcd', dataDirectory: directory, model: { baseURL: 'https://api.deepseek.com', id: 'test', apiKey: '' }, memoryIdleMs: 120_000 };
  const host = new RuntimeHost(store, engine, config);
  return { host, store, directory, config };
}

async function settle(host: RuntimeHost, id: string) {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    const execution = host.store.execution(id);
    if (!['queued', 'running'].includes(execution.status)) return execution;
    await delay(15);
  }
  throw new Error(`execution ${id} did not settle`);
}

test('explicit remember writes before a success claim, and forget leaves unrelated history', async t => {
  let memoryId = '';
  let searchHistory: ExecutionInput['history'] = [];
  let explained: { saved?: boolean; usage?: string; stopped?: boolean } | undefined;
  let sawRememberRule = false;
  const engine: Engine = {
    id: 'fake',
    async execute(input, ctx) {
      if (input.kind !== 'conversation') return { text: '{}' };
      if (input.prompt.startsWith('我平时')) return { text: '好的' };
      if (input.prompt.startsWith('请记住')) {
        sawRememberRule = input.tools.some(tool => tool.name === 'memory_remember' && tool.description.includes('saved:true')) && input.context.includes('saved:true');
        const saved = await ctx.callTool('memory_remember', { key: '饮品偏好', text: '我喜欢桂花乌龙', kind: 'preference', authorizationQuote: '请记住我喜欢桂花乌龙' }) as { saved?: boolean; memory?: { id: string } };
        if (saved.saved !== true || !saved.memory) return { text: '未写入' };
        memoryId = saved.memory.id;
        return { text: '已记住' };
      }
      if (input.prompt.startsWith('明天')) return { text: '会议在三楼东侧' };
      searchHistory = input.history;
      const found = await ctx.callTool('memory_search', { queries: ['桂花乌龙', '三楼东侧'] });
      explained = await ctx.callTool('memory_explain', { id: memoryId }) as { usage?: string; stopped?: boolean };
      return { text: JSON.stringify(found) };
    },
    async close() {},
  };
  const { host, store, directory, config } = hostFor(engine);
  t.after(async () => { await host.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const conversation = store.createConversation('跨日');
  const ordinary = host.submit(conversation.id, '我平时喝红茶', 'ordinary');
  assert.equal((await settle(host, ordinary.id)).status, 'completed');
  assert.equal(host.memory.list().length, 0);
  const remembered = host.submit(conversation.id, '请记住我喜欢桂花乌龙', 'remember');
  assert.equal((await settle(host, remembered.id)).status, 'completed');
  assert.equal(sawRememberRule, true);
  assert.equal(store.messages(conversation.id).find(message => message.executionId === remembered.id && message.role === 'assistant')?.content, '已记住');
  assert.equal(host.memory.list()[0]?.text, '我喜欢桂花乌龙');
  const meeting = host.submit(conversation.id, '明天的会议在三楼东侧', 'meeting');
  assert.equal((await settle(host, meeting.id)).status, 'completed');
  host.forget(memoryId);
  assert.equal(store.getSetting('historyRecallAfter', ''), '');
  assert.equal(host.memory.list().length, 0);
  store.setSetting('historyRecallAfter', '9999-01-01T00:00:00.000Z');
  const searched = host.submit(conversation.id, '搜索桂花乌龙和三楼东侧会议', 'search');
  const settled = await settle(host, searched.id);
  assert.equal(settled.status, 'completed');
  const hits = JSON.parse(store.messages(conversation.id).find(message => message.executionId === searched.id && message.role === 'assistant')!.content) as Array<{ query: string; memories: unknown[]; history: Array<{ content: string }> }>;
  assert.equal(hits[0]?.memories.length, 0);
  assert.equal(hits[0]?.history.length, 0);
  assert.equal(hits[1]?.history.some(item => item.content.includes('三楼东侧')), true);
  assert.equal(searchHistory.some(item => item.content.includes('三楼东侧')), true);
  assert.equal(searchHistory.some(item => item.content.includes('桂花')), false);
  assert.equal(explained?.usage, '已停止使用');
  assert.equal(explained?.stopped, true);
  const app = createRuntimeApp(host, () => {});
  const headers = { authorization: `Bearer ${config.token}` };
  const explanation = await app.request(`http://127.0.0.1/api/memory/${memoryId}/explain`, { headers });
  assert.equal(explanation.status, 200);
  const body = await explanation.json() as { usage: string; stopped: boolean; chain: Array<{ text: string }> };
  assert.equal(body.usage, '已停止使用');
  assert.equal(body.stopped, true);
  assert.equal(body.chain.some(item => item.text.includes('桂花乌龙')), true);
  const messages = await app.request(`http://127.0.0.1/api/conversations/${conversation.id}/messages`, { headers });
  assert.match(JSON.stringify(await messages.json()), /请记住我喜欢桂花乌龙/);
});

test('clear durable preference without remember verbs writes; negation still blocks', async t => {
  const results: unknown[] = [];
  let sawModelJudgedRemember = false;
  const engine: Engine = {
    id: 'fake',
    async execute(input, ctx) {
      if (input.prompt.includes('不要记住')) {
        await assert.rejects(
          () => ctx.callTool('memory_remember', { key: '饮品偏好', text: '我喜欢桂花乌龙', kind: 'preference', authorizationQuote: '不要记住我喜欢桂花乌龙' }),
          (error: unknown) => error instanceof Error && (error as { code?: string }).code === 'authorization_required',
        );
        return { text: '不会保存' };
      }
      if (input.prompt.includes('以后都用中文')) {
        sawModelJudgedRemember = input.tools.some(tool => tool.name === 'memory_remember' && !/记住|记下|记一下|帮我记|别忘了/.test(tool.description));
        const saved = await ctx.callTool('memory_remember', { key: '沟通语言', text: '以后都用中文跟我说', kind: 'preference', authorizationQuote: '以后都用中文跟我说' }) as { saved?: boolean; memory?: { text: string } };
        results.push(saved);
        return { text: saved.saved === true ? '好的，以后用中文' : '未写入' };
      }
      return { text: '好的' };
    },
    async close() {},
  };
  const { host, store, directory } = hostFor(engine);
  t.after(async () => { await host.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const conversation = store.createConversation('偏好授权');
  const language = await settle(host, host.submit(conversation.id, '以后都用中文跟我说', 'lang').id);
  assert.equal(language.status, 'completed');
  assert.equal(sawModelJudgedRemember, true);
  assert.equal((results[0] as { saved?: boolean }).saved, true);
  assert.equal(host.memory.list()[0]?.text, '以后都用中文跟我说');
  assert.match(store.messages(conversation.id).find(message => message.role === 'assistant')?.content ?? '', /以后用中文/);
  const refused = await settle(host, host.submit(conversation.id, '不要记住我喜欢桂花乌龙', 'negated').id);
  assert.equal(refused.status, 'completed');
  assert.equal(host.memory.list().length, 1);
});

test('forgotten wording is removed from the next research and review injection', async t => {
  const seen: ExecutionInput[] = [];
  const engine: Engine = {
    id: 'fake',
    async execute(input) {
      seen.push(input);
      if (input.kind === 'research') return { text: '研究结论：我喜欢桂花乌龙，产地福州。' };
      if (input.kind === 'review') return { text: JSON.stringify({ decision: 'silent', text: '无变化' }) };
      return { text: '{}' };
    },
    async close() {},
  };
  const { host, store, directory } = hostFor(engine);
  t.after(async () => { await host.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const saved = host.memory.remember({ key: '饮品偏好', text: '我喜欢桂花乌龙', kind: 'preference', source: { messageId: 'm1', conversationId: 'c1', createdAt: '2026-10-15T01:00:00.000Z', quote: '请记住我喜欢桂花乌龙', label: 'User remember' } });
  host.forget(saved.id);
  const scrubbed = scrubWorkInjection(host.memory, { request: '调查我喜欢桂花乌龙的产地', resultText: '研究结论：我喜欢桂花乌龙，产地福州。', previousTexts: ['上次结论是我喜欢桂花乌龙'], evidence: ['笔记我喜欢桂花乌龙'] });
  assert.equal(JSON.stringify(scrubbed).includes('桂花乌龙'), false);
  assert.match(scrubbed.resultText, /产地福州/);
  assert.match(scrubbed.previousTexts[0] ?? '', /已停止使用/);
  const conversation = store.createConversation('研究');
  host.setMemoryEnabled(false);
  const due = new Date(Date.now() - 60_000).toISOString();
  host.createWork({ requestId: 'work-tea', title: '茶产地', prompt: '调查我喜欢桂花乌龙的产地', kind: 'research', at: due, intervalMs: 60_000, conversationId: conversation.id });
  host.createWork({ requestId: 'work-remind', title: '茶提醒', prompt: '提醒我：我喜欢桂花乌龙', kind: 'reminder', at: due, conversationId: conversation.id });
  host.start();
  const start = Date.now();
  while (Date.now() - start < 8000 && !seen.some(item => item.kind === 'review')) await delay(20);
  const research = seen.find(item => item.kind === 'research');
  const review = seen.find(item => item.kind === 'review');
  assert.ok(research, `missing research; saw ${seen.map(item => item.kind).join(',')}`);
  assert.ok(review, `missing review; saw ${seen.map(item => item.kind).join(',')}`);
  assert.equal(`${research.prompt}\n${research.context}`.includes('桂花乌龙'), false);
  assert.equal(`${review.prompt}\n${review.context}`.includes('桂花乌龙'), false);
  assert.match(review.prompt, /产地福州/);
  const researchTask = host.work.list().find(item => item.kind === 'research');
  const run = host.work.runs(researchTask!.id)[0];
  assert.match(host.work.result(run!.id)?.text ?? '', /桂花乌龙/);
  const storedReminder = host.work.notifications().find(item => item.kind === 'reminder');
  assert.match(storedReminder?.text ?? '', /桂花乌龙/);
  const app = createRuntimeApp(host, () => {});
  const delivered = await app.request('http://127.0.0.1/api/notifications', { headers: { authorization: 'Bearer test-token-0123456789abcd' } });
  assert.equal(JSON.stringify(await delivered.json()).includes('桂花乌龙'), false);
});
