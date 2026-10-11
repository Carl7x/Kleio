/** Thin Host adapter: native Sessions, Agents, jobs, permissions and present remain the executors. */
import { randomUUID, createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import { defineTool } from '../harness-dsh/.runtime/node_modules/@deepseek-ai/dsh-tools/lib/index.js';
import { setApprovalPolicy } from '../harness-dsh/.runtime/node_modules/@deepseek-ai/dsh-user-approval/lib/index.js';
import { setSandboxMode } from '../harness-dsh/.runtime/node_modules/@deepseek-ai/dsh-sandbox-policy/lib/index.js';
import { sourceForMutation } from '../personal-agent/source.mjs';
import { TaskStore, TaskError, cleanText } from './store.mjs';

export const inject = ['sessionController', 'agents', 'sessions', 'jobs', 'tools', 'systemPrompt', 'approval', 'sandboxPolicy', 'schedule'];
const finished = new Set(['completed', 'failed', 'cancelled']);
const abortSignal = () => new AbortController().signal;
const safeError = error => error instanceof TaskError ? error.message : 'Native execution failed; inspect the linked session before retrying.';

async function inspectFile(path) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new TaskError('ARTIFACT_INVALID', 'Only an existing regular file can be recorded as a result.');
  if (entry.size > 32 * 1024 * 1024) throw new TaskError('ARTIFACT_TOO_LARGE', 'A first-version result must be at most 32 MiB.');
  const canonical = await realpath(path); const bytes = await readFile(canonical); const after = await stat(canonical);
  if (entry.size !== after.size || entry.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw new TaskError('ARTIFACT_CHANGED', 'The result changed during verification; present it again.');
  return { path: canonical, title: basename(canonical), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function mount(ctx, config) {
  if (!config || !isAbsolute(config.databasePath ?? '') || !isAbsolute(config.workspace ?? '')) throw new TaskError('INVALID_CONFIG', 'Tasks need absolute databasePath and workspace.');
  const maxConcurrent = config.maxConcurrent ?? 1;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 4) throw new TaskError('INVALID_CONFIG', 'Task concurrency must be 1–4.');
  const store = new TaskStore(config.databasePath);
  store.recoverInterrupted();
  const active = new Map(); const artifactQueues = new Map(); const pendingFinish = new WeakMap();
  const disposers = []; let stopping = false; let pumpScheduled = false;
  const hostStopping = () => stopping || ctx.fiber.uid === null;
  const settledNativeEvents = new Map();
  const owned = sessionId => {
    const value = store.bySession(sessionId);
    return value && value.task.runId === value.run.id ? value : undefined;
  };
  const track = (type, listener) => { const disposer = ctx.on(type, listener); disposers.push(disposer); };
  const progress = (binding, type, data) => {
    store.event(binding.task.id, binding.run.id, type, data);
    active.get(binding.task.id)?.job?.updateProgress(type === 'tool-started' ? `正在使用 ${data.tool}` : '正在处理');
  };
  const schedulePump = () => {
    if (hostStopping() || pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => { pumpScheduled = false; pump(); });
  };
  const waitArtifacts = async runId => { await artifactQueues.get(runId); };
  const verifyArtifacts = async runId => {
    await waitArtifacts(runId);
    // A new native present of an edited file supersedes that path's previous snapshot for completion.
    const artifacts = [...new Map(store.artifacts({ runId, limit: 200 }).reverse().map(artifact => [artifact.path, artifact])).values()];
    if (!artifacts.length) throw new TaskError('RESULT_REQUIRED', 'Create the requested result file and call native present before finishing.');
    for (const artifact of artifacts) {
      const current = await inspectFile(artifact.path);
      if (current.sha256 !== artifact.sha256) throw new TaskError('ARTIFACT_CHANGED', 'A presented result changed; present the current file again.');
    }
    return artifacts;
  };
  const settleTurn = async (session, event) => {
    const binding = owned(session.id); if (!binding || finished.has(binding.task.status)) return;
    if (settledNativeEvents.get(session.id) === event.seq) return;
    await waitArtifacts(binding.run.id);
    const run = store.run(binding.run.id); const task = store.get(binding.task.id);
    const disposed = event.data.reason?.kind === 'aborted' && event.data.reason.reason?.kind === 'disposed';
    if (disposed || (hostStopping() && !task.cancelRequested)) {
      store.settle(run.id, 'waiting', { turn: event.data.turn, waitingReason: 'host-interrupted', uncertainEffects: run.dispatched, error: 'Host stopped. Inspect this execution before explicitly retrying.' });
    } else if (event.data.reason?.kind === 'completed' && run.finishReceipt && run.finishReceipt.turnId === String(event.data.turn) && !task.cancelRequested) {
      try {
        await verifyArtifacts(run.id);
        store.settle(run.id, 'completed', { turn: event.data.turn });
      } catch (error) { store.settle(run.id, 'waiting', { turn: event.data.turn, waitingReason: 'result-needs-review', error: safeError(error) }); }
    } else if (task.cancelRequested || event.data.reason?.kind === 'aborted') {
      store.settle(run.id, 'cancelled', { turn: event.data.turn, uncertainEffects: run.dispatched, error: 'Execution stopped. Earlier external effects are not automatically undone.' });
    } else if (['error', 'max-tokens'].includes(event.data.reason?.kind)) {
      store.settle(run.id, 'failed', { turn: event.data.turn, uncertainEffects: run.dispatched, error: 'Native execution did not complete; inspect its session.' });
    } else {
      store.settle(run.id, 'waiting', { turn: event.data.turn, waitingReason: 'needs-result-or-input', error: 'The native turn ended without a verified task-completion receipt.' });
    }
    settledNativeEvents.set(session.id, event.seq);
  };
  const reconcileNativeEnd = async agent => {
    // Cordis can remove session listeners before its owning plugin's async disposer runs.
    // The native durable log, rather than the continued presence of that listener, is authoritative.
    const events = agent.session.snapshotEvents();
    const latestStart = events.findLast(event => event.type === 'turn/start');
    const latestEnd = events.findLast(event => event.type === 'turn/end');
    if (latestEnd && latestEnd.data.turn === latestStart?.data.turn) await settleTurn(agent.session, latestEnd);
  };
  const settlementQueues = new Map();
  track('session/event', (session, event) => {
    const binding = owned(session.id); if (!binding || finished.has(binding.task.status)) return;
    const data = event.data ?? {};
    if (event.type === 'turn/start' && !finished.has(binding.task.status)) {
      store.saveRun({ ...binding.run, status: 'running', finishedAt: null, finishReceipt: null, nativeTurn: data.turn });
      store.update(binding.task.id, binding.run.id, { status: 'running', waitingReason: null }, 'native-turn-started', { turn: data.turn });
    }
    if (event.type === 'tool/call') {
      const run = store.run(binding.run.id);
      if (run.finishReceipt) {
        store.saveRun({ ...run, finishReceipt: null });
        store.event(binding.task.id, binding.run.id, 'completion-invalidated', { reason: 'native-tool-after-finish', callId: data.callId });
      }
      progress(binding, 'tool-started', { tool: data.name, callId: data.callId, eventSeq: event.seq });
    }
    if (event.type === 'tool/result') progress(binding, data.message?.isError ? 'tool-failed' : 'tool-succeeded', { callId: data.message?.toolCallId, eventSeq: event.seq });
    if (event.type === 'approval/asked') store.update(binding.task.id, binding.run.id, { status: 'waiting', waitingReason: 'approval' }, 'approval-requested', { approvalId: data.id, tool: data.toolName });
    if (event.type === 'approval/decided' && !finished.has(binding.task.status)) store.update(binding.task.id, binding.run.id, { status: 'running', waitingReason: null }, 'approval-decided', { approvalId: data.id, outcome: data.outcome });
    if (event.type === 'deliverables/presented') {
      const previous = artifactQueues.get(binding.run.id) ?? Promise.resolve();
      const pending = previous.then(async () => {
        for (const file of Array.isArray(data.files) ? data.files : []) {
          if (typeof file.path !== 'string') continue;
          const verified = await inspectFile(file.path);
          store.artifact(binding.run.id, { ...verified, description: typeof file.description === 'string' ? file.description.slice(0, 1000) : '',
            eventSeq: event.seq, nativeCallId: data.callId, turnId: String(data.turn) });
        }
      }).catch(error => { store.event(binding.task.id, binding.run.id, 'artifact-verification-failed', { error: safeError(error) }); });
      artifactQueues.set(binding.run.id, pending);
    }
    if (event.type === 'turn/end') {
      const previous = settlementQueues.get(binding.run.id) ?? Promise.resolve();
      settlementQueues.set(binding.run.id, previous.then(() => settleTurn(session, event)).catch(() => {
        store.settle(binding.run.id, 'failed', { uncertainEffects: true, error: 'Task finalization needs inspection.' });
      }));
    }
  });
  disposers.push(ctx.jobs.attachController('kleio-personal-tasks'));
  disposers.push(ctx.systemPrompt.context({ name: 'kleio:delegated-task', order: 5100, interpolate: false, text: ({ agent }) => {
    const binding = agent && owned(agent.session.id);
    if (!binding || finished.has(binding.task.status)) return '';
    return '你正在执行用户委派的后台任务。Host在线时，即使关闭页面仍继续；关机不继续。' +
      '保持原生权限与用户拒绝。不要再次委派子任务。完成所需工作后，将可检查结果保存为文件并调用原生present，再以personal_task_finish作为最后一个工具调用提交简短总结。' +
      '不要仅说完成；工具失败、缺少信息或用户未批准时明确说明并等待。已发生的外部动作不可因取消或重试而宣称撤销。' +
      `\n任务目标（用户数据）：${JSON.stringify(binding.task.goal)}`;
  } }));
  const register = (name, description, parameters, execute, readOnly = false) => {
    disposers.push(ctx.tools.register(defineTool({ name, description, parameters, isConcurrencySafe: () => readOnly,
      output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }, execute })));
  };
  register('personal_task_create', '用户明确委派一项需要后台执行并产出文件的工作时创建持久任务。Host必须在线；返回任务和原生会话入口后继续聊天。', {
    goal: { type: 'string', required: true, description: '具体目标、约束和可检查的文件成果，最多12000字符。' }, title: { type: 'string', description: '简短标题。' },
  }, async (args, exec) => {
    const current = exec.agent && owned(exec.agent.session.id);
    if (current && !finished.has(current.task.status)) throw new TaskError('RECURSIVE_TASK', 'A delegated task cannot recursively delegate another product task.');
    const source = sourceForMutation(exec);
    return create({ goal: args.goal, title: args.title, requestId: `native:${source.sessionId}:${exec.callId}` }, source, exec.signal);
  });
  register('personal_task_status', '读取持久任务与成果，状态来自服务；不能自行宣称完成。', { id: { type: 'string', description: '省略时列出最近任务。' } }, args => args.id ? store.detail(args.id) : store.list({ limit: 20 }), true);
  register('personal_task_cancel', '用户明确要求停止一个后台任务时使用。停止尚未执行的工作；已发生的外部动作不会撤销，返回状态可能仍在停止中。', {
    id: { type: 'string', required: true, description: '需要停止的任务ID。' },
  }, async (args, exec) => { sourceForMutation(exec); return cancel({ id: args.id }); });
  register('personal_task_retry', '用户明确要求重试时使用。只可直接重试从未派发原生执行的任务；此前已执行的任务必须由用户在任务页检查并确认可能重复的效果，不能由模型代为确认。', {
    id: { type: 'string', required: true, description: '要重试的任务ID。' },
  }, async (args, exec) => {
    const source = sourceForMutation(exec);
    return retry({ id: args.id, requestId: `native-retry:${source.sessionId}:${exec.callId}` });
  });
  register('personal_task_finish', '仅用于当前后台任务：先用原生present提交实际文件。服务验证文件和来源并记录完成申请，原生轮次正常结束后才算完成。', {
    summary: { type: 'string', required: true, description: '基于实际成果的简短总结，最多2000字符。' },
  }, async (args, exec) => {
    exec.signal.throwIfAborted(); sourceForMutation(exec); const binding = exec.agent && owned(exec.agent.session.id);
    if (!binding) throw new TaskError('TASK_CONTEXT_REQUIRED', 'This tool is only available inside a delegated task session.');
    if (finished.has(binding.task.status)) throw new TaskError('STATE_CONFLICT', 'This task has already finished.');
    const artifacts = await verifyArtifacts(binding.run.id); exec.signal.throwIfAborted();
    const events = exec.agent.session.snapshotEvents(); const turn = events.findLast(event => event.type === 'turn/start')?.data.turn;
    if (!Number.isInteger(turn) || store.get(binding.task.id).cancelRequested) throw new TaskError('STATE_CONFLICT', 'The task cannot finish while stopping.');
    const receipt = { summary: cleanText(args.summary, 'summary', 2000), artifactIds: artifacts.map(artifact => artifact.id), sessionId: exec.agent.session.id, turnId: String(turn), callId: exec.callId };
    pendingFinish.set(exec, { runId: binding.run.id, receipt });
    return { accepted: true, pendingNativeTurnCompletion: true, artifactCount: artifacts.length };
  });
  track('tools/result', (exec, result) => {
    const pending = pendingFinish.get(exec); pendingFinish.delete(exec);
    if (pending && !result.isError && !exec.signal.aborted) store.finishReceipt(pending.runId, pending.receipt);
  });

  async function create(input, nativeSource, signal) {
    if (stopping) throw new TaskError('HOST_STOPPING', 'The Host is stopping.');
    const workspace = resolve(input.workspace ?? config.workspace);
    if (!(await stat(workspace)).isDirectory()) throw new TaskError('INVALID_INPUT', 'Choose an existing workspace directory.');
    if (stopping) throw new TaskError('HOST_STOPPING', 'The Host is stopping.');
    const source = nativeSource ?? { kind: 'local-user-command' };
    const sourceSession = nativeSource?.sessionId ? ctx.sessions.get(nativeSource.sessionId) : undefined;
    const policy = sourceSession ? { approval: ctx.approval.effectivePolicy(sourceSession), sandbox: ctx.sandboxPolicy.resolve({ session: sourceSession }).mode } : undefined;
    signal?.throwIfAborted();
    const task = store.create({ goal: input.goal, title: input.title, requestId: input.requestId, workspace }, { ...source, ...(policy ? { nativePolicy: policy } : {}) });
    schedulePump(); return task;
  }
  async function execute(task, run, execution) {
    try {
      await ctx.sessionController.create({ sessionId: run.sessionId, cwd: task.workspace, agentPreset: config.agentPreset ?? 'standard' });
      const resolved = await ctx.sessionController.resolveAgent(run.sessionId);
      if ('error' in resolved) throw resolved.error;
      execution.agent = resolved.agent;
      if (task.source.nativePolicy) {
        setApprovalPolicy(resolved.agent.session, task.source.nativePolicy.approval);
        setSandboxMode(resolved.agent.session, task.source.nativePolicy.sandbox);
      }
      if (execution.cancelled || stopping) { store.settle(run.id, 'cancelled'); return { status: 'killed' }; }
      store.dispatched(run.id);
      await ctx.sessionController.prompt({ requestId: `task-${run.id}`, sessionId: run.sessionId, mode: 'queue', content: [{ type: 'text', text: task.goal }] }, abortSignal());
      // Cancellation may have arrived while the native prompt was still being admitted.
      if (execution.cancelled || stopping) resolved.agent.cancel({ kind: stopping ? 'disposed' : 'user' });
      await resolved.agent.whenIdle();
      await settlementQueues.get(run.id);
      await reconcileNativeEnd(resolved.agent);
      const latest = store.get(task.id);
      if (latest.status === 'running' || (latest.status === 'waiting' && latest.waitingReason === 'approval')) {
        store.settle(run.id, 'waiting', hostStopping()
          ? { waitingReason: 'host-interrupted', uncertainEffects: store.run(run.id)?.dispatched === true, error: 'Host stopped before native execution settled. Inspect the session before retrying.' }
          : { waitingReason: 'needs-result-or-input', error: 'Native execution ended without a verified completion receipt.' });
      }
      const settled = store.get(task.id);
      return { status: settled.status === 'completed' ? 'completed' : settled.status === 'cancelled' ? 'killed' : 'failed', detail: settled.status, result: JSON.stringify({ taskId: task.id, status: settled.status }) };
    } catch (error) {
      const latest = store.get(task.id);
      if (!finished.has(latest.status)) store.settle(run.id, stopping && !latest.cancelRequested ? 'waiting' : execution.cancelled ? 'cancelled' : 'failed', { waitingReason: stopping ? 'host-interrupted' : null, uncertainEffects: store.run(run.id)?.dispatched === true, error: safeError(error) });
      return { status: execution.cancelled ? 'killed' : 'failed', detail: 'Inspect the linked task session.' };
    } finally { active.delete(task.id); schedulePump(); }
  }
  function pump() {
    if (hostStopping()) return;
    for (const task of store.list({ status: 'queued', limit: 200 }).reverse()) {
      if (active.size >= maxConcurrent) break;
      const run = store.start(task.id, `session-${randomUUID()}`);
      const execution = { cancelled: false, agent: undefined, job: undefined, done: undefined };
      active.set(task.id, execution);
      try {
        const jobId = ctx.jobs.start({ kind: 'personal-task', label: task.title, run(job) {
          execution.job = job;
          // The Host owns this unowned native job. Closing its source chat cannot kill the delegation.
          execution.done = Promise.resolve().then(() => execute(store.get(task.id), run, execution));
          return { cancel() { execution.cancelled = true; execution.agent?.cancel({ kind: 'user' }); }, done: execution.done };
        } });
        store.setJob(task.id, run.id, jobId);
      } catch (error) { active.delete(task.id); store.settle(run.id, 'failed', { error: safeError(error) }); }
    }
  }
  async function cancel({ id }) {
    const task = store.requestCancel(id);
    if (finished.has(task.status)) return task;
    const execution = active.get(id);
    if (execution) { execution.cancelled = true; if (task.jobId) ctx.jobs.kill(task.jobId); execution.agent?.cancel({ kind: 'user' }); }
    else if (task.sessionId) {
      const agent = ctx.agents.get(task.sessionId);
      // Do not await idle here: this may itself be a tool call in the task's resumed native turn.
      if (agent?.status === 'running') agent.cancel({ kind: 'user' });
      else store.settle(task.runId, 'cancelled', { uncertainEffects: store.run(task.runId)?.dispatched === true });
    }
    return store.get(id);
  }
  async function retry({ id, ...input }) {
    if (stopping) throw new TaskError('HOST_STOPPING', 'The Host is stopping.');
    const current = store.get(id);
    if (active.has(id) || (current.sessionId && ctx.agents.get(current.sessionId)?.status === 'running')) throw new TaskError('TASK_ACTIVE', 'Stop the native execution before retrying.');
    const task = store.retry(id, input); schedulePump(); return task;
  }
  const handlers = {
    list: input => store.list(input), create: input => create(input), detail: ({ id }) => store.detail(id), cancel,
    retry, artifacts: input => store.artifacts(input),
    openArtifact: async ({ id }) => {
      const artifact = store.getArtifact(id);
      return ctx.sessionController.openWorkspacePath({ path: artifact.path }, abortSignal());
    },
  };
  // Thin management bridge only: scheduling, recurrence, inbox delivery and persistence remain native.
  const routines = {
    list: () => ctx.schedule.catalog(),
    create: async ({ sessionId, title, prompt, after_seconds, at, every_seconds, daily, weekly, cron }) => {
      const target = sessionId || (await ctx.sessionController.create({ cwd: config.workspace, agentPreset: config.agentPreset ?? 'standard' })).sessionId;
      const request = { title, prompt };
      for (const [name, value] of Object.entries({ after_seconds, at, every_seconds, daily, weekly, cron })) if (value !== undefined) request[name] = value;
      return { sessionId: target, record: await ctx.schedule.create(target, request, abortSignal()) };
    },
    update: input => ctx.schedule.update(input, abortSignal()),
    delete: input => ctx.schedule.delete(input, abortSignal()),
  };
  async function dispose() {
    if (stopping) return;
    stopping = true;
    for (const [id, execution] of active) {
      execution.cancelled = true;
      const task = store.get(id);
      store.update(id, task.runId, { uncertainEffects: true, waitingReason: 'host-stopping' }, 'host-stopping');
      execution.agent?.cancel({ kind: 'disposed' });
    }
    // A user may continue a waiting task in its native chat after the original Host job settled.
    // That agent still needs to become idle before its product state is detached or the DB closes.
    const resumedAgents = store.unsettled().flatMap(task => {
      const agent = task.sessionId && ctx.agents.get(task.sessionId);
      if (!agent || agent.status !== 'running' || active.has(task.id)) return [];
      agent.cancel({ kind: 'disposed' }); return [agent];
    });
    await Promise.allSettled([...active.values()].map(value => value.done).concat(resumedAgents.map(agent => agent.whenIdle())));
    await Promise.allSettled([...artifactQueues.values(), ...settlementQueues.values()]);
    for (const agent of resumedAgents) await reconcileNativeEnd(agent);
    for (const dispose of disposers.reverse()) await dispose();
    store.close();
  }
  schedulePump();
  return { store, handlers, routines, dispose, async whenIdle() { while (pumpScheduled || active.size) { await new Promise(resolve => setTimeout(resolve, 10)); await Promise.allSettled([...active.values()].map(value => value.done)); } } };
}
