/** Actual published Web profile/Session Controller/jobs fixture; its model is scripted, no paid requests. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mount } from '../packages/personal-tasks/adapter.mjs';
import { TaskStore } from '../packages/personal-tasks/store.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, 'packages/harness-dsh/.runtime/node_modules/@deepseek-ai');
const load = (name, path = 'lib/index.js') => import(pathToFileURL(join(runtime, name, path)).href);
const { runProfile } = await load('dsh', 'lib/profile-boot.js');
const { createLaunchEnvironmentSnapshot } = await load('dsh-launch-environment');
const { LlmAdapter, ToolCallId } = await load('dsh-llm');
const temp = await mkdtemp(join(tmpdir(), 'kleio-task-native-')); const home = join(temp, 'home'); const workspace = join(temp, 'workspace');
await mkdir(workspace, { recursive: true }); await writeFile(join(workspace, 'result.md'), '# 隔离验收\n这是一份实际文件。\n');
process.env.DSH_HOME = home; process.env.DSH_TELEMETRY_MODE = 'DISABLED'; process.env.GIT_CEILING_DIRECTORIES = [process.env.GIT_CEILING_DIRECTORIES, homedir()].filter(Boolean).join(delimiter);
process.chdir(workspace);
const patch = join(temp, 'test.patch.json');
await writeFile(patch, JSON.stringify([{ id: 'session-log-deepseek', disabled: true }, { id: 'session-title-llm', disabled: true },
  { id: 'agent-default-model', config: { provider: 'kleio-task-test', model: 'scripted' } }]));
const responses = []; let requests = 0;
class Model extends LlmAdapter {
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }); }
  async *stream(options) {
    requests++; const entry = responses.shift(); if (!entry) throw new Error('Fixture model script exhausted.');
    if (entry.hang) { await new Promise((_, reject) => { options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }); return; }
    if (entry.tool) {
      const id = ToolCallId(randomUUID()); const args = JSON.stringify(entry.args);
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'tool-call-delta', index: 0, id, name: entry.tool, argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: entry.tool, arguments: args } }; yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: '工作完成' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '工作完成' } }; yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
}
let launch; let tasks;
const bounded = async promise => { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native task fixture exceeded 20 seconds.')), 20000); })]); } finally { clearTimeout(timer); } };
try {
  launch = await runProfile({ profile: 'web', patchFiles: [patch], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'], environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { DSH_HOME: home, DSH_TELEMETRY_MODE: 'DISABLED' } }]) });
  const { ctx } = launch; ctx.llm.registerAdapter(['kleio-task-test'], new Model());
  tasks = mount(ctx, { databasePath: join(home, 'kleio/application.sqlite'), workspace });
  responses.push({ tool: 'present', args: { files: [{ path: join(workspace, 'result.md'), description: '隔离验收成果' }] } }, { tool: 'personal_task_finish', args: { summary: '文件已核验并提交' } }, {});
  const task = await tasks.handlers.create({ goal: '提交已有隔离验收文件并完成任务', requestId: 'native-result' });
  await bounded(tasks.whenIdle());
  const detail = tasks.handlers.detail({ id: task.id });
  assert.equal(detail.task.status, 'completed', JSON.stringify(detail.task)); assert.equal(detail.artifacts.length, 1); assert.equal(detail.artifacts[0].sha256.length, 64);
  assert.ok(detail.task.sessionId); assert.ok(detail.task.jobId); assert.equal(ctx.jobs.get(detail.task.jobId).status, 'completed');
  responses.push({}); const noReceipt = await tasks.handlers.create({ goal: '只说完成不能成为成果', requestId: 'no-receipt' }); await bounded(tasks.whenIdle());
  assert.equal(tasks.handlers.detail({ id: noReceipt.id }).task.status, 'waiting');
  responses.push({ hang: true }); const cancelled = await tasks.handlers.create({ goal: '启动后取消隔离验收', requestId: 'native-cancel' });
  const untilRunning = async () => { while (requests < 5) await new Promise(resolve => setTimeout(resolve, 10)); };
  await bounded(untilRunning()); await tasks.handlers.cancel({ id: cancelled.id }); await bounded(tasks.whenIdle());
  assert.equal(tasks.store.get(cancelled.id).status, 'cancelled');
  await assert.rejects(tasks.handlers.retry({ id: cancelled.id }), { code: 'INSPECTION_REQUIRED' });
  responses.push({ tool: 'present', args: { files: [{ path: join(workspace, 'result.md') }] } }, { tool: 'personal_task_finish', args: { summary: '尚有后续操作的完成申请' } }, { tool: 'clock', args: {} }, {});
  const premature = await tasks.handlers.create({ goal: '验收完成提交后继续调用工具必须撤销完成申请', requestId: 'premature-finish' }); await bounded(tasks.whenIdle());
  assert.equal(tasks.store.get(premature.id).status, 'waiting');
  assert.ok(tasks.store.detail(premature.id).events.some(event => event.type === 'completion-invalidated'));
  const routine = await tasks.routines.create({ title: '隔离定时验收', prompt: '这是隔离验收，请勿对外操作。', after_seconds: 3600 });
  assert.ok((await tasks.routines.list()).some(item => item.record?.id === routine.record.id || item.id === routine.record.id));
  assert.equal((await tasks.routines.delete({ sessionId: routine.sessionId, id: routine.record.id })).deleted, true);
  responses.push({ hang: true });
  const resumed = tasks.store.get(noReceipt.id);
  await ctx.sessionController.prompt({ requestId: 'native-manual-resume', sessionId: resumed.sessionId, mode: 'queue', content: [{ type: 'text', text: '继续刚才的隔离任务' }] }, new AbortController().signal);
  await bounded((async () => { while (requests < 10) await new Promise(resolve => setTimeout(resolve, 10)); })());
  await bounded(tasks.dispose()); tasks = undefined;
  const reopened = new TaskStore(join(home, 'kleio/application.sqlite'));
  assert.equal(reopened.get(noReceipt.id).status, 'waiting'); assert.equal(reopened.get(noReceipt.id).waitingReason, 'host-interrupted');
  assert.equal(reopened.get(noReceipt.id).uncertainEffects, true); reopened.close();
  console.log(JSON.stringify({ status: 'passed', nativeSessionController: true, nativeJobs: true, verifiedArtifact: true, falseCompletionRejected: true, completionInvalidatedByLaterTool: true, nativeCancellation: true, uncertainRetryRequiresAcknowledgment: true, nativeScheduleCreateListDelete: true, resumedNativeTurnStoppedOnDispose: true, modelRequests: requests, paidModelRequests: 0 }, null, 2));
} finally { await tasks?.dispose(); await launch?.shutdown.shutdown(0); }
