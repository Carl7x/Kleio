import { setTimeout as delay } from 'node:timers/promises';
import { CancellationConfirmedError, CoreError, EngineOutcomeUnknownError, type AgentEngine, type Approval, type MessageSubmission } from './contracts.ts';
import { AgentStore } from './store.ts';

/** Owns one service's live executions; durable state remains in AgentStore. */
export class AgentService {
  private readonly running = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  private readonly decisions = new Map<string, (allowed: boolean) => void>();
  private closed = false;
  private readonly approvalLifetimeMs: number;
  constructor(readonly store: AgentStore, readonly engine: AgentEngine, options: { approvalLifetimeMs?: number } = {}) {
    this.approvalLifetimeMs = options.approvalLifetimeMs ?? 300_000;
    if (!Number.isFinite(this.approvalLifetimeMs) || this.approvalLifetimeMs <= 0) throw new CoreError('approval_lifetime', '审批期限必须为正数。', 400);
    store.recoverInterrupted();
  }
  submit(prompt: string): { taskId: string; runId: string } {
    if (this.closed) throw new CoreError('service_closed', '服务已经关闭。');
    const task = this.store.createTask(prompt); return this.launch(task.id);
  }
  submitMessage(conversationId: string, prompt: string, clientMessageId: string): MessageSubmission {
    if (this.closed) throw new CoreError('service_closed', '服务已经关闭。');
    const submitted = this.store.submitMessage(conversationId, prompt, clientMessageId, this.engine.id);
    if (!submitted.replayed) this.execute(submitted.taskId, submitted.runId);
    return submitted;
  }
  restart(taskId: string): { taskId: string; runId: string } { return this.launch(taskId); }
  private launch(taskId: string): { taskId: string; runId: string } {
    if (this.closed) throw new CoreError('service_closed', '服务已经关闭。');
    const run = this.store.startRun(taskId, this.engine.id); this.execute(taskId, run.id); return { taskId, runId: run.id };
  }
  private execute(taskId: string, runId: string): void {
    const task = this.store.task(taskId); const run = this.store.run(runId); const abort = new AbortController();
    // Defer execution until the live handle exists, including engines that synchronously request approval.
    const promise = Promise.resolve().then(async () => {
      let enteredEngine = false;
      try {
        abort.signal.throwIfAborted();
        enteredEngine = true;
        const result = await this.engine.execute({ runId: run.id, prompt: task.prompt, memories: this.store.recall(task.prompt), sessionId: run.sessionId,
          history: this.store.historyForRun(run.id) }, {
          signal: abort.signal,
          onText: text => { if (!abort.signal.aborted) this.store.appendText(run.id, text); },
          onSession: sessionId => { if (!abort.signal.aborted) this.store.setSession(run.id, sessionId); },
          requestApproval: (kind, payload) => this.requestApproval(run.id, kind, payload, abort.signal),
        });
        if (!abort.signal.aborted) this.store.complete(run.id, result.text);
        else if (this.store.run(run.id).status === 'cancelling') this.store.settle(run.id, 'cancelled', null);
      } catch (error) {
        if (abort.signal.aborted && this.store.run(run.id).status === 'cancelling') {
          if (!enteredEngine || error instanceof CancellationConfirmedError) this.store.settle(run.id, 'cancelled', null);
          else this.store.settle(run.id, 'interrupted', '取消未得到确认，执行结果未知。请检查已有结果，再决定是否重新执行。' + (error instanceof Error ? ' ' + error.message : ''), { discardSession: true });
        }
        else if (error instanceof EngineOutcomeUnknownError && ['running', 'waiting_approval'].includes(this.store.run(run.id).status))
          this.store.settle(run.id, 'interrupted', error.message, { discardSession: true });
        else if (!abort.signal.aborted && ['running', 'waiting_approval'].includes(this.store.run(run.id).status))
          this.store.settle(run.id, 'failed', error instanceof Error ? error.message : '执行失败。');
      } finally { abort.abort(); this.running.delete(run.id); }
    });
    this.running.set(run.id, { abort, promise });
  }
  private requestApproval(runId: string, kind: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    const approval = this.store.propose(runId, kind, payload, this.approvalLifetimeMs);
    return new Promise(resolve => {
      let finished = false;
      const finish = (allowed: boolean): void => {
        if (finished) return; finished = true;
        clearTimeout(timer); signal.removeEventListener('abort', cancel); this.decisions.delete(approval.id); resolve(allowed);
      };
      const cancel = (): void => finish(false);
      const timer = setTimeout(() => {
        if (this.decisions.has(approval.id)) {
          try { this.store.decide(approval.id, approval.hash, false); }
          catch { /* A settled or unavailable run cannot authorize an action. */ }
          finally { finish(false); }
        }
      }, Math.max(0, Date.parse(approval.expiresAt) - Date.now()));
      this.decisions.set(approval.id, finish); signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) finish(false);
    });
  }
  decide(id: string, hash: string, allowed: boolean): Approval {
    const resolver = this.decisions.get(id);
    if (!resolver) throw new CoreError('approval_offline', '审批对应的执行已结束；请检查任务状态。');
    const approval = this.store.decide(id, hash, allowed); resolver(approval.status === 'approved'); return approval;
  }
  cancel(runId: string): void {
    const handle = this.running.get(runId);
    if (!handle) throw new CoreError('run_offline', '这轮执行已不在运行。');
    this.store.requestCancel(runId); handle.abort.abort();
  }
  async wait(runId: string): Promise<void> { await this.running.get(runId)?.promise; }
  async close(): Promise<void> {
    this.closed = true;
    let failure: unknown;
    for (const [id, handle] of this.running) {
      try {
        if (!['completed', 'cancelled', 'failed', 'interrupted'].includes(this.store.run(id).status))
          this.store.settle(id, 'interrupted', '服务已关闭。请检查后继续。', { discardSession: this.store.run(id).conversationId !== null });
      } catch (error) { if (!(error instanceof CoreError && error.code === 'run_settled')) failure ??= error; }
      finally { handle.abort.abort(); }
    }
    try { await this.engine.close(); } catch (error) { failure ??= error; }
    await Promise.all([...this.running.values()].map(handle => handle.promise));
    if (failure) throw failure;
  }
}

/** Deterministic, explicitly labelled test engine; never presented as model intelligence. */
export class DemoEngine implements AgentEngine {
  readonly id = 'demo';
  readonly capabilities = { cancel: true, permissions: true, resume: false, steer: false };
  constructor(private readonly stepMs = 40) {}
  async execute(input: Parameters<AgentEngine['execute']>[0], context: Parameters<AgentEngine['execute']>[1]): Promise<{ text: string }> {
    try {
    await delay(this.stepMs, undefined, { signal: context.signal });
    context.onText('演示引擎已接收任务。');
    if (input.prompt.includes('审批')) {
      const allowed = await context.requestApproval('demo.review', { description: '仅验证审批流程，不访问外部账户。', requestedResult: input.prompt });
      if (!allowed) throw new CoreError('permission_denied', '用户未允许本次演示动作。');
    }
    await delay(this.stepMs, undefined, { signal: context.signal });
    const text = '# 演示成果\n\n任务：' + input.prompt + '\n\n相关记忆：\n' +
      (input.memories.length ? input.memories.map(memory => '- ' + memory.text + '（来源：' + memory.source + '）').join('\n') : '没有词汇相关的已保存记忆。') +
      '\n\n此轮关联 ' + (input.history?.length ?? 0) + ' 条已有对话消息（仅展示持久历史关联，没有执行模型推理）。' +
      '\n\n这是用于验证持久化、审批和事件的固定输出，不是真实模型研究结果。';
    context.onText(text); return { text };
    } catch (error) {
      if (context.signal.aborted) throw new CancellationConfirmedError();
      throw error;
    }
  }
  async close(): Promise<void> {}
}
