/** Full local application wiring over the published native Web Host. No credentials or paid models. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { isPersonalAgentReady } from '../packages/personal-agent/plugin.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, 'packages/harness-dsh/.runtime/node_modules/@deepseek-ai');
const load = (name, path = 'lib/index.js') => import(pathToFileURL(join(runtime, name, path)).href);
const { runProfile } = await load('dsh', 'lib/profile-boot.js');
const { createLaunchEnvironmentSnapshot } = await load('dsh-launch-environment');
const { LlmAdapter, ToolCallId } = await load('dsh-llm');
const version = JSON.parse(await readFile(join(runtime, 'dsh/package.json'), 'utf8')).version;
const temporary = await mkdtemp(join(tmpdir(), 'kleio-application-verification-'));
const home = join(temporary, 'home'); const workspace = join(temporary, 'workspace');
await mkdir(workspace, { recursive: true });
const resultPath = join(workspace, 'isolated-result.md');
await writeFile(resultPath, '# 隔离验收成果\n此内容仅用于本地接线验证。\n');
process.env.DSH_HOME = home; process.env.DSH_TELEMETRY_MODE = 'DISABLED';
process.env.KLEIO_PROJECT_ROOT = root;
process.env.GIT_CEILING_DIRECTORIES = [process.env.GIT_CEILING_DIRECTORIES, homedir()].filter(Boolean).join(delimiter);
process.chdir(workspace);
const patchPath = join(temporary, 'application.patch.json');
await writeFile(patchPath, JSON.stringify([
  { id: 'session-log-deepseek', disabled: true }, { id: 'session-title-llm', disabled: true },
  { id: 'web-runtime', config: { openBrowser: false, printUrl: false, surfaceContext: true } },
  { id: 'agent-default-model', config: { provider: 'kleio-application-test', model: 'scripted' } },
  { insert: [
    { id: 'kleio-personal-agent', name: join(root, 'packages/personal-agent/plugin.mjs'), config: {
      databasePath: join(home, 'kleio/memory.sqlite'), applicationPath: join(home, 'kleio/application.sqlite'),
      instructionsPath: join(root, 'config/assistant.md'), workspace, recallLimit: 8, contextCharacterBudget: 6000,
    } },
    { id: 'kleio-personal-agent-ui', name: join(root, 'packages/personal-agent-ui/host.mjs') },
  ] },
]));
const responses = []; const requests = []; const checks = {};
let releaseTask; let taskEntered; let restartEntered;
let taskStarted = new Promise(resolve => { taskEntered = resolve; });
let restartStarted = new Promise(resolve => { restartEntered = resolve; });
const taskGate = new Promise(resolve => { releaseTask = resolve; });
const bounded = async (promise, label, timeoutMs = 20000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Fixture timeout: ${label}`)), timeoutMs); })]); }
  finally { clearTimeout(timer); }
};
class ScriptedModel extends LlmAdapter {
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }); }
  async *stream(options) {
    const capture = typeof options.system === 'string' && options.system.includes('个人记忆候选提炼器');
    const prompt = JSON.stringify({ system: options.system, messages: options.messages });
    requests.push({ sessionId: options.sessionId, capture, updatedIdentityPresent: prompt.includes('隔离验收助理') });
    const response = capture ? { text: '{"candidates":[]}' } : responses.shift();
    if (!response) throw new Error('Unplanned fixture model request.');
    if (response.gate) {
      taskEntered();
      await Promise.race([taskGate, new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('Fixture aborted')), { once: true }))]);
    }
    if (response.hang) {
      restartEntered();
      await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('Fixture aborted')), { once: true }));
    }
    if (response.tool) {
      const id = ToolCallId(randomUUID()); const args = JSON.stringify(response.args);
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id, name: response.tool, argumentsDelta: args };
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: response.tool, arguments: args } };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    } else {
      const text = response.text || '隔离验收完成';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
}
let launch; let base; let cookie; let firstTask; let interrupted; let memoryId;
const temporaryRoutines = new Map();
const start = async () => {
  launch = await runProfile({ profile: 'web', patchFiles: [patchPath], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'],
    environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: { DSH_HOME: home, DSH_TELEMETRY_MODE: 'DISABLED' } }]) });
  launch.ctx.llm.registerAdapter(['kleio-application-test'], new ScriptedModel());
  assert.equal(isPersonalAgentReady(), true);
  base = `http://127.0.0.1:${launch.ctx.webServer.port}`;
  const auth = await fetch(launch.ctx.connection.authenticatedUrl(base), { redirect: 'manual' });
  assert.ok([302, 303, 307].includes(auth.status), 'Native token exchange must redirect.');
  const setCookies = auth.headers.getSetCookie();
  assert.ok(setCookies.length > 0, 'Native exchange must issue a signed cookie.');
  cookie = setCookies.map(value => value.split(';')[0]).join('; ');
  checks.nativeSignedCookieExchange = true;
  const html = await fetch(base, { headers: { cookie } }).then(response => response.text());
  assert.ok(html.includes('__DSH_BOOT__')); assert.ok(html.includes('@kleio/personal-agent-ui'));
  const graph = launch.ctx.clientModules.graph();
  assert.ok(graph.entries.some(entry => entry.id === '@kleio/personal-agent-ui'));
  const batch = graph.batches.find(batch => batch.entries.includes('@kleio/personal-agent-ui'));
  assert.ok(batch, 'Application UI must be included in an advertised native client batch.');
  const client = await fetch(new URL(batch.url, base), { headers: { cookie } });
  assert.equal(client.status, 200); assert.ok((await client.text()).includes('@kleio/personal-agent-ui'));
  checks.nativeUiBootManifestAndBundle = true;
};
const api = async (path, { method = 'GET', data, raw, headers = {}, authenticated = true } = {}) => {
  const response = await fetch(`${base}/api/kleio${path}`, { method,
    headers: { ...(authenticated ? { cookie } : {}), ...(data !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: raw !== undefined ? raw : data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(15000) });
  const payload = await response.json(); return { status: response.status, ...payload };
};
const pollTask = async (id, predicate) => bounded((async () => {
  for (;;) { const response = await api(`/tasks/${id}`); assert.equal(response.status, 200); if (predicate(response.data.task)) return response.data; await new Promise(resolve => setTimeout(resolve, 20)); }
})(), 'task settlement');
const isolatedPost = data => new Promise((resolve, reject) => {
  const encoded = JSON.stringify(data); let result; let ended = false;
  const req = httpRequest(`${base}/api/kleio/tasks`, { method: 'POST', agent: false,
    headers: { cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded), connection: 'close' } }, res => {
    const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.once('error', reject);
    res.once('end', () => { ended = true; try { result = { status: res.statusCode, ...JSON.parse(Buffer.concat(chunks).toString()) }; } catch (error) { reject(error); } });
  });
  req.once('error', reject); req.once('close', () => { if (ended && result) resolve(result); else reject(new Error('Isolated task HTTP request did not settle.')); });
  req.end(encoded);
});
try {
  await bounded(start(), 'first native boot', 45000);
  const expectedTools = ['remember', 'correct', 'forget', 'history', 'restore'].map(name => `personal_memory_${name}`)
    .concat(['create', 'status', 'cancel', 'retry', 'finish'].map(name => `personal_task_${name}`), ['memory_search', 'memory_get', 'memory_edit']);
  const names = launch.ctx.tools.schemas().map(tool => tool.name);
  for (const name of expectedTools) assert.ok(names.includes(name), `Missing application tool: ${name}`);
  checks.readyAndAllApplicationTools = true;
  assert.equal((await api('/profile', { authenticated: false })).status, 401);
  assert.equal((await api('/profile', { headers: { origin: 'https://untrusted.invalid' } })).status, 403);
  checks.unauthenticated401 = true; checks.crossOrigin403 = true;
  const profile = await api('/profile'); assert.equal(profile.status, 200);
  const updated = await api('/profile', { method: 'PATCH', data: { expectedVersion: profile.data.version, assistant: { name: '隔离验收助理' }, user: { name: '隔离验收用户' } } });
  assert.equal(updated.status, 200); assert.equal(updated.data.version, profile.data.version + 1);
  assert.equal((await api('/profile', { method: 'PATCH', data: { expectedVersion: profile.data.version, user: { name: '不得覆盖' } } })).status, 409);
  checks.profileVersionConflict = true;
  const tooLarge = await api('/profile', { method: 'PATCH', raw: JSON.stringify({ padding: 'x'.repeat(70000) }) });
  assert.equal(tooLarge.status, 413); checks.bodyLimit64KiB = true;
  const marker = 'PRIVATE_PATH_FIXTURE_DO_NOT_ECHO';
  const invalidPath = await api('/tasks', { method: 'POST', data: { goal: '隔离验收异常保密', workspace: join(workspace, marker) } });
  assert.equal(invalidPath.status, 500); assert.ok(!JSON.stringify(invalidPath).includes(marker)); assert.ok(!JSON.stringify(invalidPath).includes(temporary));
  checks.sensitiveInternalErrorRedacted = true;

  const sourceSession = (await launch.ctx.sessionController.create({ cwd: workspace, agentPreset: 'standard' })).sessionId;
  responses.push({ tool: 'personal_memory_remember', args: { subject: '隔离验收用户', key: '饮品偏好', text: '隔离验收用户喜欢桂花乌龙' } }, {});
  await launch.ctx.sessionController.prompt({ requestId: 'application-memory-fixture', sessionId: sourceSession, mode: 'queue', content: [{ type: 'text', text: '隔离验收：记住虚构验收用户喜欢桂花乌龙，仅为测试。' }] }, new AbortController().signal);
  const sourceAgent = (await launch.ctx.sessionController.resolveAgent(sourceSession)).agent;
  await bounded(sourceAgent.whenIdle(), 'native memory turn');
  const records = await api('/memories'); assert.equal(records.status, 200); assert.equal(records.data.length, 1);
  const original = records.data[0]; memoryId = original.id; assert.equal(original.source.sessionId, sourceSession);
  const nativeUser = sourceAgent.session.snapshotEvents().find(event => event.type === 'user/message');
  assert.equal(original.source.messageId, nativeUser.data.id);
  assert.ok(requests.some(request => request.sessionId === sourceSession && request.updatedIdentityPresent));
  checks.updatedIdentityReachedNativePrompt = true;
  const note = await api('/memory-files?path=MEMORY.md'); assert.equal(note.status, 200);
  assert.ok(!(note.data.text).includes(original.text), 'Project/topic facts are not promoted into standing notes');
  const noteEdit = await api('/memory-files', { method: 'PATCH', data: { path: 'MEMORY.md', expectedHash: note.data.sha256, oldText: '## Preferences', newText: '## Preferences\n- 隔离验收偏好：简洁中文（2026-10-11，界面亲述）。' } });
  assert.equal(noteEdit.status, 200);
  const staleNote = await api('/memory-files', { method: 'PATCH', data: { path: 'MEMORY.md', expectedHash: note.data.sha256, oldText: '## Preferences', newText: '## Changed' } });
  assert.equal(staleNote.status, 409);
  assert.equal((await api('/memory-files?path=..%2Foutside.md')).status, 400);
  checks.authenticatedFileNotesAndStaleProtection = true;
  const corrected = await api(`/memories/${memoryId}`, { method: 'PATCH', data: { expectedVersion: 1, text: '隔离验收用户喜欢茉莉花茶' } });
  assert.equal(corrected.status, 200); assert.equal(corrected.data.version, 2); assert.equal(corrected.data.source.kind, 'app-ui');
  const forgotten = await api(`/memories/${memoryId}/forget`, { method: 'POST', data: { expectedVersion: 2 } });
  assert.equal(forgotten.status, 200); assert.equal(forgotten.data.deleted, true); assert.equal((await api('/memories')).data.length, 0);
  assert.equal((await api('/memories?includeDeleted=true')).data.length, 1);
  const restored = await api(`/memories/${memoryId}/restore`, { method: 'POST', data: { expectedVersion: 3, targetVersion: 1 } });
  assert.equal(restored.status, 200); assert.equal(restored.data.version, 4); assert.equal(restored.data.text, original.text);
  assert.equal((await api(`/memories/${memoryId}`, { method: 'PATCH', data: { expectedVersion: 1, text: '过期的隔离更正' } })).status, 409);
  const history = await api(`/memories/${memoryId}/history`); assert.equal(history.data.length, 4);
  const audit = new DatabaseSync(join(home, 'kleio/application.sqlite'), { readOnly: true });
  try {
    for (const revision of history.data.slice(1)) {
      assert.equal(revision.source.kind, 'app-ui'); assert.equal(revision.source.sessionId, 'app:ui');
      assert.ok(audit.prepare('SELECT id FROM app_actions WHERE id=? AND kind=?').get(revision.source.turnId, revision.source.label));
    }
  } finally { audit.close(); }
  checks.nativeMemorySourceAndHttpVersionLifecycle = true; checks.httpMemoryAuditBinding = true;

  // A prior turn's explicit save request must not authorize a later casual preference or a different mutation.
  const beforeUnrequested = sourceAgent.session.snapshotEvents().length;
  responses.push({ tool: 'personal_memory_remember', args: { subject: '隔离验收随口偏好', key: '饮品偏好', text: '隔离验收：平时喜欢雨前龙井' } },
    { tool: 'personal_memory_correct', args: { id: memoryId, expectedVersion: 4, text: '隔离验收用户喜欢雨前龙井' } }, {});
  await launch.ctx.sessionController.prompt({ requestId: 'application-no-memory-consent', sessionId: sourceSession, mode: 'queue',
    content: [{ type: 'text', text: '隔离验收：我平时喜欢雨前龙井。' }] }, new AbortController().signal);
  await bounded(sourceAgent.whenIdle(), 'unrequested memory mutation rejection');
  const unrequestedEvents = sourceAgent.session.snapshotEvents().slice(beforeUnrequested);
  for (const tool of ['personal_memory_remember', 'personal_memory_correct']) {
    const call = unrequestedEvents.find(event => event.type === 'tool/call' && event.data.name === tool);
    assert.ok(call, `The fixture must actually attempt ${tool}.`);
    const result = unrequestedEvents.find(event => event.type === 'tool/result' && event.data.message.toolCallId === call.data.callId);
    assert.equal(result?.data.message.isError, true);
    assert.match(result.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), /MEMORY_REVIEW_REQUIRED/u);
  }
  assert.equal((await api('/memories')).data.length, 1);
  assert.equal((await api(`/memories/${memoryId}`)).data.version, 4);
  assert.equal((await api(`/memories/${memoryId}/history`)).data.length, 4);
  checks.explicitIntentRequiredToRemember = true; checks.explicitIntentRequiredToCorrect = true;
  checks.unrequestedWritesDoNotChangeMemoryVersions = true;

  responses.push({ gate: true, tool: 'personal_memory_remember', args: { subject: '后台工具不应写入', key: '不得保存', text: '隔离验收：后台任务不是人类本人' } },
    { tool: 'present', args: { files: [{ path: resultPath, description: '隔离验收文件' }] } },
    { tool: 'personal_task_finish', args: { summary: '隔离验收文件已核验' } }, {});
  const created = await bounded(isolatedPost({ goal: '隔离验收：展示已有验收文件并提交成果，不进行对外操作。', requestId: 'application-task-fixture' }), 'closed HTTP task request');
  assert.equal(created.status, 201); firstTask = created.data;
  await bounded(taskStarted, 'background task model entry');
  const running = (await api(`/tasks/${firstTask.id}`)).data.task;
  assert.equal(running.status, 'running'); assert.ok(running.sessionId); assert.notEqual(running.sessionId, sourceSession); assert.ok(running.jobId);
  checks.closedHttpConnectionDoesNotStopNativeAgent = true;
  releaseTask();
  const detail = await pollTask(firstTask.id, task => task.status === 'completed');
  assert.equal(detail.artifacts.length, 1); assert.equal(detail.artifacts[0].sha256.length, 64);
  const artifacts = await bounded((async () => { for (;;) { const response = await api(`/artifacts?taskId=${firstTask.id}`); if (response.data.length) return response.data; await new Promise(resolve => setTimeout(resolve, 20)); } })(), 'cross-session artifact index');
  assert.equal(artifacts[0].sessionId, detail.task.sessionId); assert.equal(artifacts[0].source.kind, 'native-present');
  assert.equal(artifacts[0].sha256, detail.artifacts[0].sha256); assert.ok(detail.runs[0].finishReceipt);
  const taskAgent = (await launch.ctx.sessionController.resolveAgent(detail.task.sessionId)).agent;
  const taskEvents = taskAgent.session.snapshotEvents();
  assert.ok(taskEvents.some(event => event.type === 'tool/call' && event.data.name === 'present'));
  assert.ok(taskEvents.some(event => event.type === 'tool/call' && event.data.name === 'personal_task_finish'));
  const rejectedMemory = taskEvents.find(event => event.type === 'tool/call' && event.data.name === 'personal_memory_remember');
  assert.ok(rejectedMemory);
  assert.equal(taskEvents.find(event => event.type === 'tool/result' && event.data.message.toolCallId === rejectedMemory.data.callId)?.data.message.isError, true);
  assert.equal((await api('/memories')).data.length, 1); checks.delegatedTaskCannotMutateUserMemory = true;
  assert.equal(taskEvents.findLast(event => event.type === 'turn/end').data.reason.kind, 'completed');
  checks.httpTaskNativeSessionAndVerifiedArtifact = true; checks.completionHasNativeEvidence = true;
  const capture = await api('/memory-capture'); assert.equal(capture.status, 200); assert.equal(capture.data.started, true);
  assert.equal(requests.filter(request => request.capture).length, 0); checks.syntheticTurnsDoNotTriggerExtraction = true;
  const captureReader = new DatabaseSync(join(home, 'kleio/application.sqlite'), { readOnly: true });
  try {
    const captureJobs = captureReader.prepare('SELECT record FROM personal_memory_capture_jobs').all().map(row => JSON.parse(row.record));
    assert.ok(captureJobs.some(job => job.sessionId === sourceSession && job.status === 'skipped'));
    assert.ok(!captureJobs.some(job => job.sessionId === detail.task.sessionId));
  } finally { captureReader.close(); }
  checks.delegatedTaskExcludedFromAutomaticCapture = true;

  const routineCreated = await api('/routines', { method: 'POST', data: { title: '隔离周期管理验收', prompt: '隔离验收：不进行对外操作。', every_seconds: 3600 } });
  assert.equal(routineCreated.status, 200);
  const routine = routineCreated.data;
  assert.ok(routine.sessionId); assert.ok(routine.record.id);
  temporaryRoutines.set(routine.record.id, routine.sessionId);
  assert.ok((await api('/routines')).data.some(item => item.id === routine.record.id && item.sessionId === routine.sessionId));
  const routineUpdated = await api('/routines', { method: 'PATCH', data: { sessionId: routine.sessionId, id: routine.record.id,
    expected: routine.record, title: '更新后的隔离周期验收', prompt: '隔离验收：更新后的指令不进行对外操作。' } });
  assert.equal(routineUpdated.status, 200); assert.equal(routineUpdated.data.updated, true); assert.equal(routineUpdated.data.record.title, '更新后的隔离周期验收');
  const staleRoutine = await api('/routines', { method: 'PATCH', data: { sessionId: routine.sessionId, id: routine.record.id, expected: routine.record, title: '过期修改不得覆盖' } });
  // The wrapper preserves the native schedule result union, including non-mutating conflicts.
  assert.equal(staleRoutine.status, 200); assert.equal(staleRoutine.data.updated, false); assert.equal(staleRoutine.data.code, 'schedule_conflict');
  assert.equal((await api('/routines')).data.find(item => item.id === routine.record.id).title, '更新后的隔离周期验收');
  checks.httpRoutinesOptimisticConflict = true;
  const removedRoutine = await api('/routines', { method: 'DELETE', data: { sessionId: routine.sessionId, id: routine.record.id } });
  assert.equal(removedRoutine.status, 200); assert.equal(removedRoutine.data.deleted, true); temporaryRoutines.delete(routine.record.id);
  assert.ok(!(await api('/routines')).data.some(item => item.id === routine.record.id));
  checks.httpRoutinesCreateListUpdateDelete = true;

  responses.push({});
  const shortCreated = await api('/routines', { method: 'POST', data: { title: '隔离短定时触发验收', prompt: '隔离验收：只确认这条定时提醒已收到。', after_seconds: 1 } });
  assert.equal(shortCreated.status, 200); const short = shortCreated.data; temporaryRoutines.set(short.record.id, short.sessionId);
  const scheduledAgent = (await launch.ctx.sessionController.resolveAgent(short.sessionId)).agent;
  await bounded((async () => {
    while (!scheduledAgent.session.snapshotEvents().some(event => event.type === 'turn/end' && event.data.reason.kind === 'completed')) await new Promise(resolve => setTimeout(resolve, 20));
  })(), 'native one-second scheduled delivery');
  await bounded(scheduledAgent.whenIdle(), 'scheduled turn idle');
  const scheduledEvents = scheduledAgent.session.snapshotEvents();
  const scheduledMessage = scheduledEvents.find(event => event.type === 'user/message');
  assert.equal(scheduledMessage.data.source.kind, 'schedule');
  assert.ok(requests.some(request => request.sessionId === short.sessionId && !request.capture));
  checks.nativeScheduleTimerDeliveredAndCompleted = true;
  const scheduleCaptureReader = new DatabaseSync(join(home, 'kleio/application.sqlite'), { readOnly: true });
  try {
    const jobs = scheduleCaptureReader.prepare('SELECT record FROM personal_memory_capture_jobs').all().map(row => JSON.parse(row.record)).filter(job => job.sessionId === short.sessionId);
    assert.equal(jobs.length, 1); assert.equal(jobs[0].status, 'skipped'); assert.equal(jobs[0].skipReason, 'no_direct_user');
    assert.equal(scheduleCaptureReader.prepare('SELECT COUNT(*) AS count FROM personal_memory_candidates').get().count, 0);
  } finally { scheduleCaptureReader.close(); }
  assert.equal(requests.filter(request => request.capture).length, 0); checks.scheduledMessageExcludedFromExtraction = true;
  const removedShort = await api('/routines', { method: 'DELETE', data: { sessionId: short.sessionId, id: short.record.id } });
  assert.equal(removedShort.status, 200); assert.equal(removedShort.data.deleted, true); temporaryRoutines.delete(short.record.id);
  assert.equal((await api('/routines')).data.length, 0); checks.temporaryRoutinesDeleted = true;
  responses.push({ hang: true });
  const hanging = await api('/tasks', { method: 'POST', data: { goal: '隔离验收：保持执行以验证关闭Host后的持久状态。', requestId: 'application-interrupted-fixture' } });
  interrupted = hanging.data; await bounded(restartStarted, 'interrupted task entry');
  await bounded(launch.shutdown.shutdown(0), 'first Host shutdown', 25000); launch = undefined;
  assert.equal(isPersonalAgentReady(), false); checks.pluginDisposedOnShutdown = true;
  const callsAtRestart = requests.length;
  await bounded(start(), 'second native boot', 45000);
  assert.equal((await api('/profile')).data.assistant.name, '隔离验收助理');
  assert.equal((await api(`/memories/${memoryId}`)).data.version, 4);
  assert.equal((await api(`/tasks/${firstTask.id}`)).data.task.status, 'completed');
  assert.equal((await api(`/artifacts?taskId=${firstTask.id}`)).data.length, 1);
  assert.equal((await api('/routines')).data.length, 0);
  const stopped = (await api(`/tasks/${interrupted.id}`)).data.task;
  assert.equal(stopped.status, 'waiting'); assert.equal(stopped.waitingReason, 'host-interrupted'); assert.equal(stopped.uncertainEffects, true); assert.equal(stopped.attempt, 1);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(requests.length, callsAtRestart); checks.restartPreservesApplicationRecords = true; checks.interruptedExecutionNotAutomaticallyReplayed = true;
  await bounded(launch.shutdown.shutdown(0), 'second Host shutdown', 25000); launch = undefined;
  assert.equal(isPersonalAgentReady(), false);
  const report = {
    verifiedAt: new Date().toISOString(), status: 'passed', dshVersion: version,
    scope: 'Isolated published native Web Host, application plugin, UI manifest, authenticated HTTP and native Agent dispatch',
    model: { kind: 'scripted in-process adapter', requests: requests.length, paidRequests: 0, extractionRequests: requests.filter(request => request.capture).length },
    checks, applicationTools: expectedTools,
    evidenceCounts: { nativeMemoryTurns: 2, memoryVersions: 4, completedTasks: 1, interruptedTasks: 1, artifactRecords: 1, hostBoots: 2, blockedDelegatedMemoryWrites: 1, blockedUnrequestedMemoryWrites: 2, schedulesCreatedAndDeleted: 2, scheduledTurns: 1, scheduleCaptureSkippedNoDirectUser: 1 },
    limitations: ['UI bundle delivery and manifest are verified; browser rendering and interaction require separate UI acceptance.', 'This fixture does not assess live model quality or semantic correctness of the result file.', 'Host shutdown persistence is verified; machine-off background execution and model-position crash resume are not provided.'],
    privacy: { credentialsRead: false, promptsOrAnswersExported: false, tokensOrCookiesExported: false, syntheticDataOnly: true },
  };
  const destination = join(root, 'docs/personal-agent-v0.4-evidence/application-runtime.json');
  await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks, modelRequests: requests.length, paidModelRequests: 0 }, null, 2));
} finally {
  releaseTask();
  if (launch) for (const [id, sessionId] of temporaryRoutines) await launch.ctx.schedule.delete({ id, sessionId }, new AbortController().signal);
  if (launch) await bounded(launch.shutdown.shutdown(1), 'fixture cleanup', 25000);
}
