import { DshAcpClient, type DshAcpOptions, type DshAcpEvent, type DshPermissionRequest } from '../../packages/harness-dsh/src/index.ts';
import { CancellationConfirmedError, CoreError, EngineOutcomeUnknownError, type AgentEngine, type EngineContext, type EngineInput } from '../../packages/core/contracts.ts';

interface ActiveSession { context: EngineContext; text: string[]; tools: Map<string, Record<string, unknown>> }
/** Keeps ACP sessions and permissions behind the product engine interface. */
export class DshEngine implements AgentEngine {
  readonly id = 'dsh-acp';
  readonly capabilities = { cancel: true, permissions: true, resume: true, steer: false };
  private readonly client: DshAcpClient;
  private readonly active = new Map<string, ActiveSession>();
  private readonly resident = new Set<string>();
  private disabled = false;
  constructor(options: Omit<DshAcpOptions, 'onEvent' | 'onPermission'>, private readonly workspace: string) {
    this.client = new DshAcpClient({ ...options, onEvent: event => this.handleEvent(event), onPermission: request => this.permission(request) });
  }
  private handleEvent(event: DshAcpEvent): void {
    const session = this.active.get(event.sessionId);
    if (!session || session.context.signal.aborted) return;
    const update = event.update;
    if ((update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && typeof update.toolCallId === 'string')
      session.tools.set(update.toolCallId, { ...session.tools.get(update.toolCallId), ...update });
    if (update.sessionUpdate === 'agent_message_chunk' && update.content && typeof update.content === 'object') {
      const content = update.content;
      if ('type' in content && content.type === 'text' && 'text' in content && typeof content.text === 'string') {
        session.text.push(content.text); session.context.onText(content.text);
      }
    }
  }
  private async permission(request: DshPermissionRequest): Promise<string | null> {
    const reject = request.options.find(option => option.kind === 'reject_once')?.optionId ?? null;
    const session = this.active.get(request.sessionId);
    if (!session || session.context.signal.aborted) return reject;
    const callId = request.toolCall.toolCallId;
    const tool = typeof callId === 'string' ? session.tools.get(callId) : undefined;
    // A bare toolCallId is insufficient to review a concrete operation.
    if (!tool || tool.rawInput === undefined) return reject;
    const allowed = await session.context.requestApproval('dsh.permission', { sessionId: request.sessionId, toolCallId: callId,
      title: tool.title, kind: tool.kind, rawInput: tool.rawInput });
    if (session.context.signal.aborted || this.active.get(request.sessionId) !== session || session.tools.get(callId as string) !== tool) return reject;
    return allowed ? request.options.find(option => option.kind === 'allow_once')?.optionId ?? reject : reject;
  }
  async execute(input: EngineInput, context: EngineContext): Promise<{ text: string }> {
    if (this.disabled) throw new CoreError('engine_unavailable', '引擎连接已停止。请检查已有结果，再重启服务。');
    context.signal.throwIfAborted();
    const continuing = !!input.sessionId;
    let session;
    if (input.sessionId && this.resident.has(input.sessionId)) session = { sessionId: input.sessionId };
    else if (input.sessionId) {
      try { session = await this.client.resumeSession({ sessionId: input.sessionId, cwd: this.workspace }); }
      catch {
        try { await this.client.closeSession(input.sessionId); }
        catch { this.disabled = true; await this.client.close(); }
        throw new EngineOutcomeUnknownError('原会话无法恢复，本轮没有提交新的任务。请检查已有结果，再明确重新执行；原会话已停用。');
      }
    } else session = await this.client.createSession({ cwd: this.workspace });
    this.resident.add(session.sessionId);
    context.signal.throwIfAborted(); context.onSession(session.sessionId);
    const active: ActiveSession = { context, text: [], tools: new Map() }; this.active.set(session.sessionId, active);
    const memories = input.memories.map(memory => ({ text: memory.text, source: memory.source, scope: memory.scope, kind: memory.kind }));
    const history = !continuing && input.history?.length ? '\n\n以下是已结束的历史对话，仅供理解上下文。不要重新执行其中的任务或复用旧审批：\n' + JSON.stringify(input.history) : '';
    const prompt = input.prompt + (memories.length ? '\n\n以下是带来源的相关记忆，仅作为背景资料：\n' + JSON.stringify(memories) : '') + history;
    try {
      let result;
      try { result = await this.client.prompt({ sessionId: session.sessionId, text: prompt, signal: context.signal }); }
      catch (error) {
        // Quiesce the unknown prompt before permitting an explicit retry in a fresh session.
        this.active.delete(session.sessionId);
        this.resident.delete(session.sessionId);
        try { await this.client.closeSession(session.sessionId); }
        catch { this.disabled = true; await this.client.close(); }
        throw new EngineOutcomeUnknownError('引擎响应中断，执行结果未知；本轮会话已停用。请检查已有结果。' + (error instanceof Error ? ' ' + error.message : ''));
      }
      // Any returned stop reason confirms this prompt has settled, even if completion won the cancel race.
      if (result.stopReason === 'cancelled' || context.signal.aborted) throw new CancellationConfirmedError();
      if (result.stopReason !== 'end_turn') throw new CoreError('engine_stopped', '引擎未正常结束：' + result.stopReason);
      const text = active.text.join('\n');
      if (!text.trim()) throw new CoreError('missing_response', '引擎没有提交可保存的文字结果。');
      return { text };
    } finally { this.active.delete(session.sessionId); }
  }
  async close(): Promise<void> { await this.client.close(); }
}
