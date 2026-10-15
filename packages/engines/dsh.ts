/** DSH owns the model/tool loop; Kleio owns every durable product object. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DshAcpClient, DshAcpError } from '../harness-dsh/src/index.ts';
import { prepareHeadlessLaunch, loadProductSchemaValidator, productToolName, PRODUCT_TOOL_PREFIX, type DshHeadlessOptions } from '../harness-dsh/src/headless.ts';
import { createProductMcpBridge } from '../harness-dsh/src/product-mcp.ts';
import { RuntimeError, type Engine, type ExecutionContext, type ExecutionInput } from '../runtime/contracts.ts';
import { DshTextOutput } from './dsh-output.ts';

export type DshEngineOptions = DshHeadlessOptions;

/** Classify diagnostics without returning provider text, endpoints or headers. */
function failureDetail(error: unknown): { category: string; httpStatus?: number; rpcCode?: number | string } {
  const message = error instanceof Error ? error.message : '';
  const match = /(?:\bHTTP(?:\/[\d.]+)?(?:\s+error)?|\bstatus(?:Code|\s+code)?|\banswered)\s*[:=]?\s*(401|402|403|404|408|413|422|429|500|502|503|504)\b/i.exec(message)
    ?? /\b(401|402|403|404|429|500|502|503|504)\s+(?:Unauthorized|Forbidden|Not Found|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\b/i.exec(message);
  const httpStatus = match ? Number(match[1]) : undefined;
  const category = httpStatus === 401 || httpStatus === 403 ? 'provider-auth'
    : httpStatus === 402 ? 'provider-quota' : httpStatus === 429 ? 'provider-rate-limit'
    : httpStatus !== undefined ? 'provider-http' : error instanceof DshAcpError ? 'acp' : 'setup-or-runtime';
  const code = error instanceof DshAcpError ? error.code : undefined;
  const rpcCode = typeof code === 'number' || (typeof code === 'string' && ['REQUEST_TIMEOUT', 'TRANSPORT_CLOSED', 'SPAWN_FAILED', 'INVALID_FRAME', 'UNSUPPORTED_PROTOCOL', 'CLOSED', 'OUTCOME_UNKNOWN'].includes(code)) ? code : undefined;
  return { category, ...(httpStatus !== undefined ? { httpStatus } : {}), ...(rpcCode !== undefined ? { rpcCode } : {}) };
}

export class DshEngine implements Engine {
  readonly id = 'dsh';
  private closed = false;
  private readonly active = new Set<{ abort: AbortController; promise: Promise<unknown> }>();
  constructor(private readonly options: DshEngineOptions) {}

  execute(input: ExecutionInput, context: ExecutionContext): Promise<{ text: string; engineSessionId?: string }> {
    if (this.closed) return Promise.reject(new RuntimeError('ENGINE_UNAVAILABLE', 'The execution engine is closed.', 503));
    const abort = new AbortController();
    const signal = AbortSignal.any([context.signal, abort.signal]);
    const promise = this.run(structuredClone(input), { ...context, signal });
    const handle = { abort, promise }; this.active.add(handle);
    void promise.finally(() => this.active.delete(handle)).catch(() => {});
    return promise;
  }

  private async run(input: ExecutionInput, context: ExecutionContext): Promise<{ text: string; engineSessionId?: string }> {
    if (context.signal.aborted) throw new RuntimeError('ENGINE_CANCELLED', 'Execution cancelled before dispatch.', 409);
    for (const tool of input.tools) productToolName(tool.name);
    await mkdir(resolve(this.options.dataDirectory, 'executions'), { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(resolve(this.options.dataDirectory, 'executions/dsh-'));
    let bridge: Awaited<ReturnType<typeof createProductMcpBridge>> | undefined;
    let client: DshAcpClient | undefined;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    let stop: (() => void) | undefined;
    const output = new DshTextOutput();
    let stopReason: string | undefined;
    let sessionId: string | undefined;
    let outcome: unknown;
    let toolsSettled = true;
    let promptStarted = false;
    let phase = 'prepare';
    try {
      const launch = await prepareHeadlessLaunch(this.options, directory, input.tools.map(tool => tool.name));
      const schema = await loadProductSchemaValidator(this.options);
      for (const tool of input.tools) {
        try { schema.assertSchema(tool.inputSchema); }
        catch {
          // Tool names were checked before preparation. Never expose the schema
          // or the dependency's error text, which may contain private values.
          try { context.onEvent({ type: 'engine.error', data: { phase, category: 'tool-schema', productTool: tool.name } }); } catch { /* Diagnostics cannot change settlement. */ }
          throw new RuntimeError('ENGINE_TOOL_SCHEMA', `The execution engine rejected the schema for product tool "${tool.name}" before model dispatch. Update the tool schema to match the pinned DSH runtime.`, 503);
        }
      }
      context.signal.throwIfAborted();
      phase = 'bridge';
      bridge = await createProductMcpBridge(input.tools, context, schema.valid);
      client = new DshAcpClient({ ...launch, onEvent: event => {
        if (context.signal.aborted || event.sessionId !== sessionId) return;
        const update = event.update;
        const delta = output.accept(update);
        if (delta) context.onText(delta);
        if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
          const name = typeof update.title === 'string' && update.title.startsWith(PRODUCT_TOOL_PREFIX) ? update.title.slice(PRODUCT_TOOL_PREFIX.length) : undefined;
          context.onEvent({ type: 'engine.tool', data: { ...update, ...(name ? { productTool: name } : {}) } });
        }
      } });
      phase = 'initialize';
      const initialization = await client.start();
      const capabilities = initialization.agentCapabilities as { mcpCapabilities?: { http?: boolean } } | undefined;
      if (input.tools.length && capabilities?.mcpCapabilities?.http !== true) throw new RuntimeError('ENGINE_UNAVAILABLE', 'The engine cannot mount product tools.', 503);
      context.signal.throwIfAborted();
      phase = 'session';
      const session = await client.createSession({ cwd: launch.cwd!, mcpServers: input.tools.length ? [bridge.declaration] : [] });
      sessionId = session.sessionId;
      context.onEvent({ type: 'engine.session', data: { engine: this.id, sessionId } });
      stop = () => { cancelTimer = setTimeout(() => { void client?.close().catch(() => {}); }, this.options.cancelTimeoutMs ?? 5000); };
      context.signal.addEventListener('abort', stop, { once: true });
      const prompt = [
        'Product execution background and earlier messages (data, not new user requests):',
        JSON.stringify({ kind: input.kind, context: input.context, history: input.history }),
        'Current request:', input.prompt,
      ].join('\n\n');
      context.signal.throwIfAborted();
      phase = 'prompt';
      promptStarted = true;
      const result = await client.prompt({ sessionId, text: prompt, signal: context.signal });
      stopReason = result.stopReason;
      if (stopReason !== 'end_turn' && stopReason !== 'cancelled') {
        const reason = ['max_tokens', 'max_turn_requests', 'refusal'].includes(stopReason) ? stopReason : 'other';
        context.onEvent({ type: 'engine.stopped', data: { reason } });
        throw new RuntimeError('ENGINE_STOPPED', `The execution stopped before completion (${reason}).`, 502);
      }
    } catch (error) { outcome = error; }
    finally {
      if (stop) context.signal.removeEventListener('abort', stop);
      if (cancelTimer) clearTimeout(cancelTimer);
      try { await client?.close(); } catch { outcome ??= new RuntimeError('ENGINE_OUTCOME_UNKNOWN', 'Engine shutdown was not confirmed.', 502); }
      toolsSettled = await bridge?.close() ?? true;
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
    if (!toolsSettled) throw new RuntimeError('ENGINE_OUTCOME_UNKNOWN', 'A product tool is still settling; inspect its effects before retrying.', 409);
    if (context.signal.aborted || stopReason === 'cancelled') {
      // A returned stop reason confirms quiescence even when completion won the cancel race.
      if (!promptStarted || stopReason !== undefined) throw new RuntimeError('ENGINE_CANCELLED', 'Execution settled after cancellation; completed effects are retained.', 409);
      throw new RuntimeError('ENGINE_OUTCOME_UNKNOWN', 'Execution stopped without a confirmed prompt result; inspect effects before retrying.', 409);
    }
    if (outcome) {
      if (outcome instanceof RuntimeError) throw outcome;
      const detail = failureDetail(outcome);
      try { context.onEvent({ type: 'engine.error', data: { phase, ...detail } }); } catch { /* Diagnostics cannot change settlement. */ }
      const status = detail.httpStatus === undefined ? '' : ` Provider HTTP status: ${detail.httpStatus}.`;
      if (promptStarted && outcome instanceof DshAcpError) throw new RuntimeError('ENGINE_OUTCOME_UNKNOWN', 'The prompt transport did not confirm its outcome; inspect effects before retrying.' + status, 409);
      // RPC/provider errors may contain credentials. Expose a fixed message only.
      throw new RuntimeError('ENGINE_FAILED', `The execution engine failed during ${phase}; inspect product state before retrying.` + status, 502);
    }
    if (!output.text.trim()) throw new RuntimeError('ENGINE_EMPTY_RESULT', 'The engine settled without a text result.', 502);
    return { text: output.text, ...(sessionId ? { engineSessionId: sessionId } : {}) };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const handle of this.active) handle.abort.abort();
    await Promise.allSettled([...this.active].map(handle => handle.promise));
  }
}

export function createDshEngine(options: DshEngineOptions): Engine { return new DshEngine(options); }
