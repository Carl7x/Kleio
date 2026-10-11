/** ACP subprocess adapter. Product tasks, approvals and assets remain caller-owned. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

type JsonObject = Record<string, unknown>;

/** An ACP permission option advertised by the running engine. */
export interface DshPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

/** Approval data comes from the engine; callers must bind it to their own Run. */
export interface DshPermissionRequest {
  sessionId: string;
  toolCall: JsonObject;
  options: DshPermissionOption[];
}

/** Semantic ACP updates; unsupported extensions are preserved as data. */
export interface DshAcpEvent {
  sessionId: string;
  update: JsonObject;
}

/** Executable and argv are separate; a shell is never used. */
export interface DshAcpOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  promptTimeoutMs?: number;
  closeTimeoutMs?: number;
  maxFrameBytes?: number;
  /** Return an advertised one-shot option ID, or null to cancel. Default denies. */
  onPermission?: (request: DshPermissionRequest) => string | null | Promise<string | null>;
  onEvent?: (event: DshAcpEvent) => void;
}

/** Session metadata includes opaque engine-owned configuration choices. */
export interface DshAcpSession {
  sessionId: string;
  raw: JsonObject;
}

/** A stop reason is an execution result, not proof that a business Task succeeded. */
export interface DshAcpPromptResult {
  stopReason: string;
  raw: JsonObject;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** ACP errors preserve a machine-readable code but do not print runtime stderr. */
export class DshAcpError extends Error {
  readonly code: number | string;
  constructor(message: string, code: number | string) {
    super(message);
    this.code = code;
    this.name = 'DshAcpError';
  }
}

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DshAcpError('Expected an ACP JSON object', 'INVALID_FRAME');
  }
  return value as JsonObject;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new DshAcpError(`Invalid ACP ${field}`, 'INVALID_FRAME');
  return value;
}

/** Owns one real stdio process, multiplexed requests, and fail-closed permissions. */
export class DshAcpClient {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<JsonObject>;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(event: DshAcpEvent) => void>();
  private readonly sessions = new Set<string>();
  private readonly prompting = new Set<string>();
  private readonly uncertain = new Set<string>();
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private closed = false;
  private closing = false;
  private exit?: Promise<void>;
  private readonly timeout: number;
  private readonly options: DshAcpOptions;

  constructor(options: DshAcpOptions) {
    this.options = options;
    this.timeout = options.requestTimeoutMs ?? 30_000;
    if (!options.command.trim() || this.timeout <= 0) throw new DshAcpError('Invalid launch configuration', 'CONFIGURATION');
    if (options.onEvent) this.listeners.add(options.onEvent);
  }

  /** Launch and initialize once; a failed process is not silently retried. */
  start(): Promise<JsonObject> {
    if (this.closed || this.closing) return Promise.reject(new DshAcpError('ACP client is closed', 'CLOSED'));
    this.starting ??= this.launch();
    return this.starting;
  }

  private async launch(): Promise<JsonObject> {
    const child = spawn(this.options.command, [...(this.options.args ?? [])], {
      cwd: this.options.cwd,
      env: this.options.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.exit = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    // Drain diagnostics without persisting or printing potential credential-bearing text.
    child.stderr.resume();
    child.once('error', () => this.fail(new DshAcpError('Could not launch ACP runtime', 'SPAWN_FAILED')));
    child.once('close', (code, signal) => this.fail(new DshAcpError(`ACP runtime exited (${code ?? signal ?? 'unknown'})`, 'TRANSPORT_CLOSED')));
    child.stdin.on('error', () => this.fail(new DshAcpError('ACP stdin is unavailable', 'TRANSPORT_CLOSED')));
    const result = object(await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'personal-agent-dsh-adapter', version: '0.0.1' },
    }));
    if (result.protocolVersion !== 1) throw new DshAcpError('Unsupported ACP protocol version', 'UNSUPPORTED_PROTOCOL');
    return result;
  }

  /** Subscribe to all sessions; release when the owning Run or UI detaches. */
  onEvent(listener: (event: DshAcpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async createSession(input: { cwd: string; mcpServers?: readonly JsonObject[] }): Promise<DshAcpSession> {
    await this.start();
    const raw = object(await this.request('session/new', { cwd: input.cwd, mcpServers: input.mcpServers ?? [] }));
    const sessionId = requiredString(raw.sessionId, 'sessionId');
    this.sessions.add(sessionId);
    return { sessionId, raw };
  }

  async listSessions(input: { cwd?: string; cursor?: string } = {}): Promise<JsonObject> {
    await this.start();
    return object(await this.request('session/list', input));
  }

  async resumeSession(input: { sessionId: string; cwd: string; mcpServers?: readonly JsonObject[] }): Promise<DshAcpSession> {
    await this.start();
    const raw = object(await this.request('session/resume', { ...input, mcpServers: input.mcpServers ?? [] }));
    this.sessions.add(input.sessionId);
    return { sessionId: input.sessionId, raw };
  }

  /** ACP itself owns the prompt activity interval; one prompt per session is allowed. */
  async prompt(input: { sessionId: string; text: string; onEvent?: (event: DshAcpEvent) => void; signal?: AbortSignal }): Promise<DshAcpPromptResult> {
    await this.start();
    input.signal?.throwIfAborted();
    if (this.uncertain.has(input.sessionId)) throw new DshAcpError('The last prompt outcome is unknown; close and rebuild this session before more work', 'OUTCOME_UNKNOWN');
    if (this.prompting.has(input.sessionId)) throw new DshAcpError('A prompt is already running on this session', 'SESSION_BUSY');
    this.prompting.add(input.sessionId);
    const release = input.onEvent ? this.onEvent(event => { if (event.sessionId === input.sessionId) input.onEvent?.(event); }) : undefined;
    const cancel = (): void => { this.cancel(input.sessionId); };
    input.signal?.addEventListener('abort', cancel, { once: true });
    try {
      const raw = object(await this.request('session/prompt', {
        sessionId: input.sessionId,
        prompt: [{ type: 'text', text: input.text }],
      }, this.options.promptTimeoutMs ?? 600_000));
      return { stopReason: requiredString(raw.stopReason, 'stopReason'), raw };
    } catch (error) {
      // A timed-out prompt may still own work. Request cancellation, never resend it.
      if (error instanceof DshAcpError && error.code === 'REQUEST_TIMEOUT') {
        this.uncertain.add(input.sessionId);
        this.cancel(input.sessionId);
      }
      throw error;
    } finally {
      this.prompting.delete(input.sessionId);
      input.signal?.removeEventListener('abort', cancel);
      release?.();
    }
  }

  /** Requests cancellation; only the prompt result confirms settlement. */
  cancel(sessionId: string): void {
    if (this.child && !this.closed && !this.closing) this.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.start();
    await this.request('session/close', { sessionId });
    this.sessions.delete(sessionId);
    this.uncertain.delete(sessionId);
  }

  /** Closes only owned sessions, then reaps the process with a bounded escalation. */
  async close(): Promise<void> {
    if (this.closed || this.closing) { await this.exit; return; }
    this.closing = true;
    if (!this.child) { this.closed = true; return; }
    await Promise.allSettled([...this.sessions].map(sessionId => this.request('session/close', { sessionId }, this.options.closeTimeoutMs ?? 2_000)));
    this.child.stdin.end();
    const bound = this.options.closeTimeoutMs ?? 2_000;
    const wait = async (): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stopped = await Promise.race([this.exit?.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), bound); })]);
      if (timer) clearTimeout(timer);
      return stopped === true;
    };
    if (!await wait()) { this.child.kill('SIGTERM'); if (!await wait()) { this.child.kill('SIGKILL'); await this.exit; } }
    this.closed = true;
    this.fail(new DshAcpError('ACP client is closed', 'CLOSED'));
  }

  private request(method: string, params: JsonObject, timeoutMs = this.timeout): Promise<unknown> {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new DshAcpError(`ACP request timed out: ${method}`, 'REQUEST_TIMEOUT')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new DshAcpError('ACP write failed', 'TRANSPORT_CLOSED'));
      }
    });
  }

  private send(frame: JsonObject): void {
    if (!this.child || this.closed || this.child.stdin.destroyed) throw new DshAcpError('ACP transport is unavailable', 'TRANSPORT_CLOSED');
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const maximum = this.options.maxFrameBytes ?? 8 * 1024 * 1024;
    let end: number;
    while ((end = this.buffer.indexOf(10)) >= 0) {
      if (end > maximum) { this.fail(new DshAcpError('ACP frame exceeds configured size', 'INVALID_FRAME')); this.child?.kill(); return; }
      const line = this.buffer.subarray(0, end).toString('utf8').trim();
      this.buffer = this.buffer.subarray(end + 1);
      if (!line) continue;
      try { this.dispatch(object(JSON.parse(line))); } catch (error) {
        this.fail(error instanceof Error ? error : new DshAcpError('Invalid ACP frame', 'INVALID_FRAME'));
        this.child?.kill();
        return;
      }
    }
    if (this.buffer.length > maximum) { this.fail(new DshAcpError('ACP frame exceeds configured size', 'INVALID_FRAME')); this.child?.kill(); }
  }

  private dispatch(frame: JsonObject): void {
    if (frame.jsonrpc !== '2.0') throw new DshAcpError('Invalid ACP JSON-RPC version', 'INVALID_FRAME');
    if (typeof frame.method === 'string') {
      if (frame.id !== undefined) {
        void this.respond(frame).catch(() => this.fail(new DshAcpError('ACP response write failed', 'TRANSPORT_CLOSED')));
      } else if (frame.method === 'session/update') {
        const params = object(frame.params);
        const event: DshAcpEvent = { sessionId: requiredString(params.sessionId, 'sessionId'), update: object(params.update) };
        for (const listener of this.listeners) {
          try { listener(event); } catch { /* A UI consumer cannot prevent protocol settlement. */ }
        }
      }
      return;
    }
    if (typeof frame.id !== 'number') return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.error !== undefined) {
      const error = object(frame.error);
      pending.reject(new DshAcpError(typeof error.message === 'string' ? error.message : 'ACP request failed', typeof error.code === 'number' ? error.code : 'RPC_ERROR'));
    } else if ('result' in frame) pending.resolve(frame.result);
    else pending.reject(new DshAcpError('ACP response has no result', 'INVALID_FRAME'));
  }

  private async respond(frame: JsonObject): Promise<void> {
    if (frame.method !== 'session/request_permission') {
      this.send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'Unsupported client method' } });
      return;
    }
    let optionId: string | null = null;
    try {
      const params = object(frame.params);
      if (!Array.isArray(params.options)) throw new DshAcpError('Invalid permission options', 'INVALID_FRAME');
      const options = params.options.map(value => {
        const option = object(value);
        return { optionId: requiredString(option.optionId, 'optionId'), name: requiredString(option.name, 'option name'), kind: requiredString(option.kind, 'option kind') };
      });
      const request: DshPermissionRequest = { sessionId: requiredString(params.sessionId, 'sessionId'), toolCall: object(params.toolCall), options };
      optionId = this.options.onPermission ? await this.options.onPermission(request) : options.find(option => option.kind === 'reject_once')?.optionId ?? null;
      if (optionId !== null && !options.some(option => option.optionId === optionId && (option.kind === 'allow_once' || option.kind === 'reject_once'))) optionId = null;
    } catch { /* Invalid input or a failed approval UI never grants permission. */ }
    if (!this.closed && this.child && !this.child.stdin.destroyed) this.send({
      jsonrpc: '2.0', id: frame.id,
      result: { outcome: optionId === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId } },
    });
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}
