/** Real published Harness profile and Agent-loop integration using an in-process scripted model. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MemoryStore } from '../packages/personal-memory/store.mjs';
import { sourceForMutation } from '../packages/personal-agent/source.mjs';
import { isPersonalAgentReady } from '../packages/personal-agent/plugin.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = resolve(root, 'packages/harness-dsh/.runtime/node_modules/@deepseek-ai');
const load = (pkg, path = 'lib/index.js') => import(pathToFileURL(join(runtime, pkg, path)).href);
const { runProfile } = await load('dsh', 'lib/profile-boot.js');
const { createLaunchEnvironmentSnapshot } = await load('dsh-launch-environment');
const { LlmAdapter, createUserMessage, ToolCallId } = await load('dsh-llm');
const { SessionId } = await load('dsh-session');
const temporary = await mkdtemp(join(tmpdir(), 'kleio-plugin-verification-'));
const home = join(temporary, 'home');
const workspace = join(temporary, 'workspace');
await mkdir(workspace, { recursive: true });
process.env.DSH_HOME = home;
process.env.DSH_TELEMETRY_MODE = 'DISABLED';
process.env.KLEIO_PROJECT_ROOT = root;
// Keep git discovery from adopting an unrelated repository at the user-home ancestor.
process.env.GIT_CEILING_DIRECTORIES = [process.env.GIT_CEILING_DIRECTORIES, homedir()].filter(Boolean).join(delimiter);
process.chdir(workspace);
const database = join(home, 'kleio/memory.sqlite');
const patch = JSON.parse(JSON.stringify([
  { id: 'session-log-deepseek', disabled: true },
  { id: 'session-title-llm', disabled: true },
  { id: 'web-runtime', config: { openBrowser: false, printUrl: false } },
  { insert: [{ id: 'kleio-personal-agent', name: resolve(root, 'packages/personal-agent/plugin.mjs'), config: { databasePath: database, instructionsPath: resolve(root, 'config/assistant.md'), recallLimit: 8, contextCharacterBudget: 6000 } }] },
]));
const patchPath = join(temporary, 'plugin.patch.json');
await writeFile(patchPath, JSON.stringify(patch));
const checks = [];
const responses = [];
const requests = [];
class ScriptedModel extends LlmAdapter {
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }); }
  async *stream(options) {
    requests.push(options);
    const response = responses.shift();
    if (!response) throw new Error('Unexpected extra model request in the plugin verification.');
    if (response.tool) {
      const id = ToolCallId(randomUUID());
      const args = JSON.stringify(response.args);
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: response.tool, argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: response.tool, arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: '验证完成' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '验证完成' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
}
let launch;
let handle;
let reader;
try {
  launch = await runProfile({ profile: 'web', patchFiles: [patchPath], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'], environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { DSH_HOME: home, DSH_TELEMETRY_MODE: 'DISABLED' } }]) });
  const { ctx } = launch;
  assert.equal(isPersonalAgentReady(), true);
  ctx.on('agent/error', event => console.log('Agent error:', String(event.error)));
  ctx.llm.registerAdapter(['kleio-test'], new ScriptedModel());
  handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd: workspace, agentPreset: 'standard' }, agentOptions: { provider: 'kleio-test', model: 'scripted-no-network' } });
  const agent = handle.agent;
  const names = ctx.tools.schemas().map(tool => tool.name).filter(name => name.startsWith('personal_memory_')).sort();
  assert.equal(names.length, 5);
  for (const name of ['memory_search', 'memory_get', 'memory_edit']) assert.ok(ctx.tools.schemas().some(tool => tool.name === name));
  checks.push('Official Web Loader registered five fact mutation/audit tools and three file/history memory tools');
  reader = new MemoryStore(database);
  const send = async (text, tool, args) => {
    responses.push({ tool, args }, {});
    console.log(`Checking ${tool}`);
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
    let timer;
    try {
      await Promise.race([agent.whenIdle(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Agent did not settle: ${JSON.stringify(agent.session.snapshotEvents().slice(-4))}`)), 15000); })]);
    } catch (error) { console.error(String(error)); agent.cancel({ kind: 'disposed' }); throw error; }
    finally { clearTimeout(timer); }
    const result = agent.session.snapshotEvents().findLast(event => event.type === 'tool/result');
    assert.ok(result && !result.data.isError, JSON.stringify(result?.data));
    return result;
  };
  await send('隔离验收：请记住虚构角色小林喜欢桂花乌龙，仅作测试。', 'personal_memory_remember', { subject: '隔离验收小林', key: '饮品偏好', text: '虚构角色小林喜欢桂花乌龙', source: { sessionId: 'spoofed' } });
  let record = reader.list()[0];
  assert.equal(record.source.sessionId, agent.session.id);
  assert.equal(record.source.turnId, '1');
  const events = agent.session.snapshotEvents();
  const start = events.findIndex(event => event.type === 'turn/start');
  const user = events.findIndex(event => event.type === 'user/message' && event.data.source.kind === 'user');
  const call = events.findIndex(event => event.type === 'tool/call');
  assert.ok(start < user && user < call);
  assert.equal(record.source.messageId, events[user].data.id);
  checks.push('Real Agent loop committed turn/start then user/message before memory tool; source spoofing ignored');
  await send('验收小林的饮品偏好是什么？', 'memory_search', { queries: ['小林 饮品偏好', '桂花乌龙'] });
  assert.ok(JSON.stringify(requests.at(-2).messages).includes('会话开局精选资料'));
  assert.ok(!(await readFile(join(home, 'kleio/memory/MEMORY.md'), 'utf8')).includes('虚构角色小林喜欢桂花乌龙'), 'Unselected topic facts must not enter standing notes');
  assert.ok(JSON.stringify(requests.at(-1).messages).includes('桂花乌龙'));
  assert.ok(agent.session.snapshotEvents().some(event => event.type === 'system/message' && JSON.stringify(event.data).includes('长期陪伴用户')));
  checks.push('Independent assistant instructions and bounded recall reached logged native prompt/message channels');
  await send('把验收小林的饮品偏好改成茉莉花茶。', 'personal_memory_correct', { id: record.id, expectedVersion: record.version, text: '虚构角色小林喜欢茉莉花茶' });
  record = reader.get(record.id);
  assert.equal(record.version, 2);
  await send('请忘记验收小林的饮品偏好。', 'personal_memory_forget', { id: record.id, expectedVersion: record.version });
  assert.equal(reader.search({ query: '验收小林' }).length, 0);
  await send('查看这条验收记忆的修改历史。', 'personal_memory_history', { id: record.id });
  record = reader.get(record.id);
  await send('把刚才的验收记忆恢复到最初的桂花乌龙版本。', 'personal_memory_restore', { id: record.id, expectedVersion: record.version, targetVersion: 1 });
  assert.equal(reader.get(record.id).text, '虚构角色小林喜欢桂花乌龙');
  checks.push('Correction, recoverable deletion, history and restore ran through real native tool dispatch');
  assert.throws(() => sourceForMutation({ signal: AbortSignal.abort(), agent }), /abort/i);
  assert.throws(() => sourceForMutation({ signal: new AbortController().signal, agent }), /already ended/);
  checks.push('Aborted calls and completed-turn mutation contexts rejected');
  const fresh = await ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd: workspace, agentPreset: 'standard' }, agentOptions: { provider: 'kleio-test', model: 'scripted-no-network' } });
  responses.push({ tool: 'memory_search', args: { queries: ['截图工具', '屏幕截图'] } }, {});
  fresh.agent.followup(createUserMessage({ content: [{ type: 'text', text: '我需要屏幕截图工具。' }], source: { kind: 'user' } }));
  await fresh.agent.whenIdle();
  assert.ok(!JSON.stringify(requests.at(-2).messages).includes('虚构角色小林喜欢桂花乌龙'), 'A new unrelated conversation must not receive topic facts automatically');
  const searchResult = fresh.agent.session.snapshotEvents().findLast(event => event.type === 'tool/result');
  assert.ok(searchResult && !searchResult.data.isError);
  assert.ok(!JSON.stringify(searchResult.data).includes('虚构角色小林喜欢桂花乌龙'));
  await fresh.dispose();
  checks.push('memory_search dispatched focused queries; new unrelated session received no unrelated saved fact or conversation');
  await handle.dispose(); handle = undefined;
  reader.close(); reader = undefined;
  await launch.shutdown.shutdown(0); launch = undefined;
  assert.equal(isPersonalAgentReady(), false);
  checks.push('Official profile shutdown disposed plugin resources and closed its SQLite connection');
  const report = { verifiedAt: new Date().toISOString(), status: 'passed', dshVersion: '0.2.1-alpha.2', model: 'scripted in-process adapter; no network or paid API', tools: names, checks, fixtureOnlyDisabled: ['session-log-deepseek', 'session-title-llm'], gitDiscoveryBoundary: 'GIT_CEILING_DIRECTORIES includes user home; original workspace-changes and ui-deliverables remain loaded', limitations: ['This proves runtime bindings and dispatch, not a live provider or browser workflow.'], temporaryData: temporary };
  await mkdir(resolve(root, 'docs/personal-agent-v0.3-evidence'), { recursive: true });
  await writeFile(resolve(root, 'docs/personal-agent-v0.3-evidence/plugin-runtime.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks, modelRequests: requests.length, paidModelRequests: 0 }, null, 2));
} finally {
  if (handle) await handle.dispose();
  reader?.close();
  if (launch) await launch.shutdown.shutdown(1);
}
