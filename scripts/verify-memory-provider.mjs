/** Paid-provider evaluation in a disposable native Harness home; never uses the owner's memory. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { delimiter } from 'node:path';
import { loadEnvFile } from 'node:process';
import { MemoryStore } from '../packages/personal-memory/store.mjs';
import { openApplicationDatabase, ProfileStore } from '../packages/personal-memory/profile.mjs';
import { deepSeekMessagesBase } from './native-launch-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
loadEnvFile(join(root, '.env'));
assert.ok(process.env.KLEIO_MODEL_API_KEY, 'Configure a model key in private .env.');
process.env.DEEPSEEK_API_KEY = process.env.KLEIO_MODEL_API_KEY;
process.env.DEEPSEEK_BASE_URL = deepSeekMessagesBase(process.env.KLEIO_MODEL_BASE_URL || 'https://api.deepseek.com');
const model = process.env.KLEIO_MODEL_ID || 'deepseek-flash';
const temporary = await mkdtemp(join(tmpdir(), 'kleio-real-memory-'));
const home = join(temporary, 'home'), workspace = join(temporary, 'workspace'); await mkdir(workspace);
process.env.DSH_HOME = home; process.env.KLEIO_PROJECT_ROOT = root; process.env.DSH_TELEMETRY_MODE = 'DISABLED';
process.env.GIT_CEILING_DIRECTORIES = [process.env.GIT_CEILING_DIRECTORIES, homedir()].filter(Boolean).join(delimiter);
const app = openApplicationDatabase(join(home, 'kleio/application.sqlite'));
const profile = new ProfileStore(app); profile.set({ expectedVersion: profile.get().version, captureEnabled: false }); app.close();
const seed = new MemoryStore(join(home, 'kleio/memory.sqlite'));
seed.remember({ subject: '隔离虚构产品', key: '研发计划', text: '计划研究 Personal Agent 与 Founder OS' }, { sessionId: 'isolated-fixture', turnId: '0' }); seed.close();
const patchPath = join(temporary, 'evaluation.patch.json');
await writeFile(patchPath, JSON.stringify([
  { id: 'session-log-deepseek', disabled: true }, { id: 'session-title-llm', disabled: true },
  { id: 'web-runtime', config: { printUrl: false, openBrowser: false } },
  { id: 'agent-default-model', config: { provider: 'deepseek-official', model } },
  { insert: [{ id: 'kleio-personal-agent', name: join(root, 'packages/personal-agent/plugin.mjs'), config: {
    databasePath: join(home, 'kleio/memory.sqlite'), applicationPath: join(home, 'kleio/application.sqlite'), workspace, instructionsPath: join(root, 'config/assistant.md'),
  } }] },
]));
const runtime = join(root, 'packages/harness-dsh/.runtime/node_modules/@deepseek-ai');
const load = (name, file = 'lib/index.js') => import(pathToFileURL(join(runtime, name, file)).href);
const { runProfile } = await load('dsh', 'lib/profile-boot.js');
const { createLaunchEnvironmentSnapshot } = await load('dsh-launch-environment');
const checks = [], handles = [];
let launch, factsReader;
const bounded = async promise => {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MODEL_TIMEOUT')), 60000); })]); } finally { clearTimeout(timer); }
};
try {
  process.chdir(workspace);
  launch = await runProfile({ profile: 'web', patchFiles: [patchPath], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'], environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { DSH_HOME: home, DSH_TELEMETRY_MODE: 'DISABLED', DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL: process.env.DEEPSEEK_BASE_URL } }]) });
  const ctx = launch.ctx;
  factsReader = new MemoryStore(join(home, 'kleio/memory.sqlite'));
  ctx.on('agent/error', event => {
    const message = String(event.error?.message || 'MODEL_ERROR').replaceAll(process.env.DEEPSEEK_API_KEY, '[redacted]').replace(/\?[^\s]+/gu, '?[redacted]').slice(0, 400);
    console.log(`Provider evaluation error: ${message}`);
  });
  const fresh = async () => { const created = await ctx.sessionController.create({ cwd: workspace, agentPreset: 'standard' }); const handle = await ctx.sessionController.resolveAgent(created.sessionId); handles.push(handle); return handle.agent; };
  const send = async (agent, text, label, requiredTool) => {
    const priorSeq = agent.session.snapshotEvents().at(-1)?.seq ?? -1;
    await ctx.sessionController.prompt({ requestId: label, sessionId: agent.session.id, mode: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal);
    await bounded(agent.whenIdle());
    const events = agent.session.snapshotEvents().filter(event => event.seq > priorSeq);
    const end = events.findLast(event => event.type === 'turn/end'); assert.equal(end?.data.reason?.kind, 'completed', label);
    const calls = events.filter(event => event.type === 'tool/call'); assert.equal(calls[0]?.data.name, 'memory_search', `${label}: retrieval must precede other work`);
    const queries = JSON.parse(calls[0].data.arguments).queries; assert.ok(queries.length >= 2 && queries.length <= 3, label);
    if (requiredTool) assert.ok(calls.some(call => call.data.name === requiredTool), `${label}: actual ${requiredTool} execution is required, not a verbal claim`);
    for (const call of calls) { const result = events.find(event => event.type === 'tool/result' && event.data.message?.toolCallId === call.data.callId); assert.ok(result && !result.data.message.isError, `${label}: failed tool ${call.data.name}`); }
    const answer = events.filter(event => event.type === 'assistant/message').flatMap(event => event.data.message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n');
    checks.push({ label, completed: true, firstTool: calls[0].data.name, queryCount: queries.length, tools: calls.map(call => call.data.name) });
    console.log(`Passed native model turn: ${label}`); return answer;
  };
  for (const [label, question] of [
    ['screenshot-topic', '一个截图工具，最小操作流程该怎么设计？只列三步。'],
    ['travel-holdout', '三天旅行怎样让行李更轻？只给三条实用建议。'],
    ['cooking-holdout', '新手煎鸡蛋怎样避免粘锅？简单回答。'],
  ]) {
    const answer = await send(await fresh(), question, label);
    assert.doesNotMatch(answer, /Personal Agent|Founder\s*OS|个人助理项目/iu, `${label}: unrelated project leaked into response`);
  }
  await send(await fresh(), '隔离功能验证：下面是虚构资料，不要保存成正式事实。上次讨论的相机镜头焦段是28mm。请仅确认这个验证资料。', 'history-source');
  const recalled = await send(await fresh(), '在刚才的隔离验证资料中，我们讨论的相机镜头焦段是多少？', 'history-recall');
  assert.match(recalled, /28\s*mm/iu);
  // Only the CRUD fixture gets permission to persist fictional test-role records. Normal-topic
  // holdouts above use the unmodified production behavior and a fresh owner profile.
  const fixtureDb = openApplicationDatabase(join(home, 'kleio/application.sqlite'));
  const fixtureProfile = new ProfileStore(fixtureDb);
  fixtureProfile.set({ expectedVersion: fixtureProfile.get().version, assistant: { instructions: '这是工具集成验证的独立临时主机；正式记忆库也是可丢弃的测试库。用户明确要求保存测试角色时，可以调用事实工具验证保存与纠错，标注测试角色来源；不能当成现实用户资料。依然每轮先用 memory_search 构造2–3个当前话题查询，然后执行用户明确要求的事实工具。' } });
  fixtureDb.close();
  const writer = await fresh();
  await send(writer, '请记住：测试角色阿泽的居住城市是广州。这是在本次临时数据目录验证正式保存工具，来源注明测试角色，不是现实用户事实。请调用 personal_memory_remember 保存这条测试记录。', 'explicit-save', 'personal_memory_remember');
  const saved = factsReader.search({ query: '阿泽' })[0]; assert.ok(saved && saved.version === 1 && saved.text.includes('广州'), 'Actual persisted fact is required');
  await send(writer, '把测试角色阿泽的居住城市改为杭州。请用 personal_memory_correct 更正刚才的测试记录并保留历史版本。', 'explicit-correction', 'personal_memory_correct');
  const updated = factsReader.get(saved.id); assert.equal(updated.version, 2); assert.match(updated.text, /杭州/u); assert.equal(factsReader.history(saved.id).length, 2);
  const corrected = await send(await fresh(), '刚才的测试角色阿泽，在已保存的正式 facts 记录中现在居住在哪个城市？只根据 memory_search 的结果，不用文件系统找资料。', 'latest-fact');
  assert.match(corrected, /杭州/u);
  const report = { verifiedAt: new Date().toISOString(), model, provider: new URL(process.env.KLEIO_MODEL_BASE_URL || 'https://api.deepseek.com').origin, dsh: '0.2.1-alpha.2', isolatedData: true, checks, persistedFactVersions: 2, correctedFactReadFromDatabase: true, limitations: ['Finite holdouts, not a general guarantee of model adherence.', 'Literal retrieval only; no embeddings.', 'Synthetic evaluation content, never written to the owner database.', 'The disposable verification profile explicitly permits test-role CRUD; production does not treat synthetic data as real user facts.'] };
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs/validation-memory-provider.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', model, turns: checks.length, historyRecall: true, latestCorrection: true, unrelatedTopics: 3 }));
} finally {
  for (const handle of handles) await handle.dispose?.();
  factsReader?.close();
  if (launch) await launch.shutdown.shutdown(0);
  process.chdir(root); await rm(temporary, { recursive: true, force: true });
}
