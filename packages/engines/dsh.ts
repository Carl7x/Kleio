import type { ContextHistoryMessage } from '../context-contracts/bundle.ts';
import { serializeContextBundle } from '../product-context/serialize-context.ts';
/** DSH owns the model/tool loop; Kleio owns every durable product object. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DshAcpClient, DshAcpError } from '../harness-dsh/src/index.ts';
import { prepareHeadlessLaunch, loadProductSchemaValidator, productToolName, PRODUCT_TOOL_PREFIX, type DshAdmissionLaunch, type DshHeadlessOptions, type DshModelOptions } from '../harness-dsh/src/headless.ts';
import { createProductMcpBridge } from '../harness-dsh/src/product-mcp.ts';
import { RuntimeError, type Engine, type ExecutionContext, type ExecutionInput } from '../runtime/contracts.ts';
import { CONTEXT_BUDGET_EXCEEDED_MESSAGE, CONTEXT_INVALIDATED_MESSAGE, CONTEXT_STATE_MISMATCH_MESSAGE, type DenialReceipt, type RequestAdmission } from '../runtime/request-admission.ts';
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

const ADMISSION_TIMEOUT_MS = 2_000;
const INCOMPLETE_ADMISSION = 'Request admission configuration is incomplete.';
const ADMISSION_CAPACITY = 'Request admission requires explicit model capacity that matches its profile.';
const ADMISSION_EXECUTION = 'Request admission is not bound to this execution.';

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** A present controller must be complete, bound to this execution, and match the explicit model window. Absence keeps the legacy profile. */
function resolveAdmission(value: ExecutionContext['requestAdmission'], model: DshModelOptions, executionId: string): RequestAdmission | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || typeof value.check !== 'function' || typeof value.denialReceipt !== 'function') {
    throw new RuntimeError('ENGINE_ADMISSION_CONFIG', INCOMPLETE_ADMISSION, 409);
  }
  const binding = value.binding;
  const profile = value.profile;
  if (!binding || !profile || typeof binding.executionId !== 'string' || typeof binding.scopeId !== 'string' || typeof profile.version !== 'string') {
    throw new RuntimeError('ENGINE_ADMISSION_CONFIG', INCOMPLETE_ADMISSION, 409);
  }
  if (binding.executionId !== executionId) throw new RuntimeError('ENGINE_ADMISSION_CONFIG', ADMISSION_EXECUTION, 409);
  if (!positive(profile.contextLimit) || !positive(profile.outputLimit) || profile.outputLimit >= profile.contextLimit) {
    throw new RuntimeError('ENGINE_ADMISSION_CONFIG', INCOMPLETE_ADMISSION, 409);
  }
  if (!Number.isSafeInteger(profile.safetyMarginTokens) || profile.safetyMarginTokens < 0) throw new RuntimeError('ENGINE_ADMISSION_CONFIG', INCOMPLETE_ADMISSION, 409);
  if (!Number.isSafeInteger(binding.hostGeneration) || binding.hostGeneration < 0 || !Number.isSafeInteger(binding.policyEpoch) || binding.policyEpoch < 0) {
    throw new RuntimeError('ENGINE_ADMISSION_CONFIG', INCOMPLETE_ADMISSION, 409);
  }
  if (model.contextWindow === undefined || model.maxTokens === undefined || model.contextWindow !== profile.contextLimit || model.maxTokens !== profile.outputLimit) {
    throw new RuntimeError('ENGINE_ADMISSION_CONFIG', ADMISSION_CAPACITY, 409);
  }
  return value;
}

export interface EngineSettlementInput {
  promptStarted: boolean;
  stopReason: string | undefined;
  signalAborted: boolean;
  toolsSettled: boolean;
  closeConfirmed: boolean;
  outcome: unknown;
  phase: string;
  denial: DenialReceipt | undefined;
  outputText: string;
}

export type EngineSettlement =
  | { readonly kind: 'success'; readonly text: string }
  | { readonly kind: 'error'; readonly error: RuntimeError; readonly event?: { type: string; data: Record<string, unknown> } };

function confirmedRpcFailure(outcome: unknown): boolean {
  return outcome instanceof DshAcpError && outcome.code === -32603;
}

/**
 * Budget and invalidation are mapped only from a host receipt plus confirmed ACP settlement.
 * Provider text is never consulted, including text that copies a product error code.
 */
export function classifyEngineSettlement(input: EngineSettlementInput): EngineSettlement {
  if (!input.toolsSettled) return { kind: 'error', error: new RuntimeError('ENGINE_OUTCOME_UNKNOWN', 'A product tool is still settling; inspect its effects before retrying.', 409) };
  // Once the prompt is dispatched, an unconfirmed close is unknown even if an earlier stop or cancel was recorded and no denial receipt exists.
  // A denial plus an unconfirmed close stays unknown too. Pre-dispatch config and schema errors are left for the outcome below.
  if (!input.closeConfirmed && (input.promptStarted || input.denial)) return { kind: 'error', error: new RuntimeError('ENGINE_OUTCOME_UNKNOWN', 'Engine shutdown was not confirmed.', 502) };
  const settled = input.closeConfirmed && input.promptStarted;
  const rpcFailure = confirmedRpcFailure(input.outcome);
  if (input.denial && settled && input.denial.code === 'CONTEXT_BUDGET_EXCEEDED' && rpcFailure && !input.signalAborted) {
    return {
      kind: 'error',
      error: new RuntimeError('CONTEXT_BUDGET_EXCEEDED', CONTEXT_BUDGET_EXCEEDED_MESSAGE, 409, { retryable: false, requestSequence: input.denial.requestSequence, estimatedInputTokens: input.denial.estimatedInputTokens }),
      event: { type: 'engine.admission', data: { requestSequence: input.denial.requestSequence, code: input.denial.code } },
    };
  }
  if (input.denial && settled && input.denial.code === 'CONTEXT_STATE_MISMATCH' && rpcFailure && !input.signalAborted) {
    return { kind: 'error', error: new RuntimeError('CONTEXT_STATE_MISMATCH', CONTEXT_STATE_MISMATCH_MESSAGE, 409, { retryable: false, requestSequence: input.denial.requestSequence }), event: { type: 'engine.admission', data: { requestSequence: input.denial.requestSequence, code: 'CONTEXT_STATE_MISMATCH' } } };
  }
  if (input.denial && settled && input.denial.code === 'CONTEXT_INVALIDATED' && (rpcFailure || input.stopReason === 'cancelled')) {
    return {
      kind: 'error',
      error: new RuntimeError('ENGINE_CANCELLED', CONTEXT_INVALIDATED_MESSAGE, 409),
      event: { type: 'engine.admission', data: { requestSequence: input.denial.requestSequence, code: 'CONTEXT_INVALIDATED' } },
    };
  }
  if (input.signalAborted || input.stopReason === 'cancelled') {
    if (!input.promptStarted || input.stopReason !== undefined) return { kind: 'error', error: new RuntimeError('ENGINE_CANCELLED', 'Execution settled after cancellation; completed effects are retained.', 409) };
    return { kind: 'error', error: new RuntimeError('ENGINE_OUTCOME_UNKNOWN', 'Execution stopped without a confirmed prompt result; inspect effects before retrying.', 409) };
  }
  if (input.outcome instanceof RuntimeError) return { kind: 'error', error: input.outcome };
  if (input.outcome) {
    const detail = failureDetail(input.outcome);
    const event = { type: 'engine.error', data: { phase: input.phase, ...detail } };
    const status = detail.httpStatus === undefined ? '' : ` Provider HTTP status: ${detail.httpStatus}.`;
    if (input.promptStarted && input.outcome instanceof DshAcpError) return { kind: 'error', error: new RuntimeError('ENGINE_OUTCOME_UNKNOWN', 'The prompt transport did not confirm its outcome; inspect effects before retrying.' + status, 409), event };
    return { kind: 'error', error: new RuntimeError('ENGINE_FAILED', `The execution engine failed during ${input.phase}; inspect product state before retrying.` + status, 502), event };
  }
  if (input.denial) return { kind: 'error', error: new RuntimeError('ENGINE_OUTCOME_UNKNOWN', 'The prompt transport did not confirm its outcome; inspect effects before retrying.', 409) };
  if (!input.outputText.trim()) return { kind: 'error', error: new RuntimeError('ENGINE_EMPTY_RESULT', 'The engine settled without a text result.', 502) };
  return { kind: 'success', text: input.outputText };
}

export class DshEngine implements Engine {
  readonly id = 'dsh';
  readonly contextCapabilities = { bundle: 1, admission: 1, receipts: 1 } as const;
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
    let bundleHistory: readonly ContextHistoryMessage[] | undefined;
    if (input.bundle) {
      const bundle = input.bundle;
      if (bundle.version !== 1 || context.requestAdmission === undefined) throw new RuntimeError('ENGINE_ADMISSION_CONFIG', INCOMPLETE_ADMISSION, 409);
      const projection = serializeContextBundle(bundle);
      bundleHistory = projection.messages.slice(0, -1);
      input = { ...input, id: bundle.executionId, prompt: bundle.request.text, context: projection.system,
        tools: structuredClone(projection.tools) as ExecutionInput['tools'] };
    }
    const admission = resolveAdmission(context.requestAdmission, this.options.model, input.id);
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
    let closeConfirmed = false;
    let promptStarted = false;
    let phase = 'prepare';
    const rejectSchemas = async () => {
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
      return schema;
    };
    try {
      let launch;
      if (admission) {
        const schema = await rejectSchemas();
        context.signal.throwIfAborted();
        phase = 'bridge';
        bridge = await createProductMcpBridge(input.tools, context, schema.valid, admission);
        if (!bridge.control) throw new RuntimeError('ENGINE_ADMISSION_CONFIG', INCOMPLETE_ADMISSION, 409);
        phase = 'prepare';
        const control: DshAdmissionLaunch = {
          controlUrl: bridge.control.url, authorization: bridge.control.authorization, executionId: admission.binding.executionId,
          hostGeneration: admission.binding.hostGeneration, policyEpoch: admission.binding.policyEpoch, profileVersion: admission.profile.version,
          contextLimit: admission.profile.contextLimit, outputLimit: admission.profile.outputLimit, timeoutMs: ADMISSION_TIMEOUT_MS,
        };
        launch = await prepareHeadlessLaunch(this.options, directory, input.tools.map(tool => tool.name), control);
      } else {
        launch = await prepareHeadlessLaunch(this.options, directory, input.tools.map(tool => tool.name));
        const schema = await rejectSchemas();
        context.signal.throwIfAborted();
        phase = 'bridge';
        bridge = await createProductMcpBridge(input.tools, context, schema.valid);
      }
      const toolNames = new Map<string, string>();
      client = new DshAcpClient({ ...launch, onEvent: event => {
        if (context.signal.aborted || event.sessionId !== sessionId) return;
        const update = event.update;
        const delta = output.accept(update);
        if (delta) context.onText(delta);
        if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
          const callId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined;
          const name = typeof update.title === 'string' && update.title.startsWith(PRODUCT_TOOL_PREFIX) ? update.title.slice(PRODUCT_TOOL_PREFIX.length) : undefined;
          if (callId && name) toolNames.set(callId, name);
          const productTool = name ?? (callId ? toolNames.get(callId) : undefined);
          // ACP updates can contain raw tool results. Only safe progress metadata crosses into product logs.
          context.onEvent({ type: 'engine.tool', data: {
            sessionUpdate: update.sessionUpdate,
            ...(callId ? { toolCallId: callId } : {}),
            ...(typeof update.status === 'string' ? { status: update.status } : {}),
            ...(typeof update.kind === 'string' ? { kind: update.kind } : {}),
            ...(productTool ? { productTool, title: productTool } : {}),
          } });
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
        JSON.stringify({ kind: input.kind, context: input.context, history: bundleHistory ?? input.history }),
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
      try { await client?.close(); closeConfirmed = true; } catch { outcome ??= new RuntimeError('ENGINE_OUTCOME_UNKNOWN', 'Engine shutdown was not confirmed.', 502); }
      toolsSettled = await bridge?.close() ?? true;
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
    let denial: DenialReceipt | undefined;
    try { denial = admission?.denialReceipt(); } catch { denial = undefined; outcome ??= new RuntimeError('ENGINE_OUTCOME_UNKNOWN', 'The prompt transport did not confirm its outcome; inspect effects before retrying.', 409); }
    const settlement = classifyEngineSettlement({ promptStarted, stopReason, signalAborted: context.signal.aborted, toolsSettled, closeConfirmed, outcome, phase, denial, outputText: output.text });
    if (settlement.kind === 'error') {
      if (settlement.event) { try { context.onEvent(settlement.event); } catch { /* Diagnostics cannot change settlement. */ } }
      throw settlement.error;
    }
    return { text: settlement.text, ...(sessionId ? { engineSessionId: sessionId } : {}) };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const handle of this.active) handle.abort.abort();
    await Promise.allSettled([...this.active].map(handle => handle.promise));
  }
}

export function createDshEngine(options: DshEngineOptions): Engine { return new DshEngine(options); }
