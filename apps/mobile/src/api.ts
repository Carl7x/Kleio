import type {
  Conversation,
  ConversationChange,
  Execution,
  Message,
  ProductEvent,
} from "../../../packages/runtime/store.ts";
import type {
  MemoryClaim,
  MemoryPerson,
  MemoryRelationship,
  MemoryRuntime,
} from "../../../packages/personal-memory/runtime.ts";
import type {
  CreateWork,
  StoredResearchResult,
  StoredWorkReview,
  WorkNotification,
  WorkRun,
  WorkTask,
} from "../../../packages/personal-tasks/runtime.ts";
import { clientFetch } from './transport';

export type {
  Conversation,
  ConversationChange,
  CreateWork,
  Execution,
  MemoryClaim,
  MemoryPerson,
  MemoryRelationship,
  Message,
  ProductEvent,
  StoredResearchResult,
  StoredWorkReview,
  WorkNotification,
  WorkRun,
  WorkTask,
};
export type Memory = MemoryClaim;
export type Person = ReturnType<MemoryRuntime["people"]>[number];
export type MemoryRevision = ReturnType<MemoryRuntime["history"]>[number];
export interface RuntimeStatus {
  product: string;
  mode: "web" | "headless";
  engine: string;
  model: string;
  modelConfigured: boolean;
  memory: { enabled: boolean; watermarks: ReturnType<MemoryRuntime["watermarks"]> } & ReturnType<MemoryRuntime["health"]>;
  capabilities: string[];
  search?: { provider: string; mode: string };
  deviceAccess?: boolean;
}
export interface WorkDetail {
  task: WorkTask;
  runs: Array<WorkRun & { result?: StoredResearchResult; review?: StoredWorkReview }>;
}
export interface ExecutionSubscriptionOptions {
  after?: number;
  signal?: AbortSignal;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
const offline = () => new ApiError(
  "暂时连接不上本地服务。检查服务是否运行，再重试；草稿已保留。",
  "offline",
  0,
);
async function fetchResponse(path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await clientFetch("/api" + path, {
      ...init,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...init.headers },
    });
  } catch (error) {
    if (init.signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
    throw offline();
  }
  if (!response.ok) {
    const value = await response.json().catch(() => null) as Record<string, unknown> | null;
    throw new ApiError(
      response.status === 401
        ? "连接凭据已失效，请重新连接 Kleio。"
        : typeof value?.error === "string"
          ? value.error
          : "操作没有完成，请刷新状态后重试。",
      String(value?.code ?? (response.status === 401 ? "authentication_required" : "request_failed")),
      response.status,
    );
  }
  return response;
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (init.signal?.aborted) cancel();
  else init.signal?.addEventListener('abort', cancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchResponse(path, { ...init, signal: controller.signal });
        try { return await response.json() as T; }
        catch (error) {
          if (controller.signal.aborted) throw error;
          if (error instanceof TypeError) throw offline();
          throw new ApiError("本地服务返回了无法读取的数据，请刷新状态后重试。", "invalid_response", response.status);
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ApiError("连接超时。请确认手机与电脑在同一网络、服务地址正确，并允许 Expo Go 访问本地网络。", "timeout", 0));
          controller.abort();
        }, 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', cancel);
  }
}
const body = (value: unknown): RequestInit => ({ body: JSON.stringify(value) });
const withSignal = (signal?: AbortSignal): RequestInit => signal ? { signal } : {};
const encode = encodeURIComponent;
const cancelExecution = (id: string) => request<{ ok: boolean }>(`/executions/${encode(id)}/cancel`, { method: "POST" });
function eventPath(after: number, executionId?: string): string {
  const query = new URLSearchParams({ after: String(after) });
  if (executionId) query.set("executionId", executionId);
  return "/events?" + query.toString();
}
function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Request cancelled'); error.name = 'AbortError'; return error;
}
function throwIfAborted(signal?: AbortSignal): void {
  // React Native's AbortController does not implement throwIfAborted on every SDK.
  if (signal?.aborted) throw abortError(signal);
}
function reconnectDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(abortError(signal)); };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

/** Replays persisted events across reconnects, then drains the final event tail before resolving. */
async function subscribeExecution(
  id: string,
  onEvent: (event: ProductEvent) => void | Promise<void>,
  options: ExecutionSubscriptionOptions = {},
): Promise<Execution> {
  const { signal } = options;
  let after = options.after ?? 0;
  let retryDelay = 300;
  if (!Number.isSafeInteger(after) || after < 0) throw new ApiError("无效的事件位置。", "invalid_input", 400);
  const deliver = async (event: ProductEvent) => {
    if (!event || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || event.executionId !== id) {
      throw new ApiError("本地服务返回了无效事件。", "invalid_event", 502);
    }
    if (event.sequence <= after) return;
    await onEvent(event);
    after = event.sequence;
    retryDelay = 300;
  };
  while (true) {
    throwIfAborted(signal);
    try {
      const response = await fetchResponse(`/executions/${encode(id)}/stream?after=${after}`, {
        ...withSignal(signal),
        headers: { Accept: "text/event-stream" },
      });
      if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
        throw new ApiError("本地服务没有返回事件流。", "invalid_stream", 502);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const consume = async (frame: string) => {
        const data = frame.split(/\r?\n/u).filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).replace(/^ /u, "")).join("\n");
        if (!data) return;
        let event: ProductEvent;
        try { event = JSON.parse(data) as ProductEvent; }
        catch { throw new ApiError("本地服务返回了无法读取的事件。", "invalid_event", 502); }
        await deliver(event);
      };
      try {
        while (true) {
          let part: ReadableStreamReadResult<Uint8Array>;
          try { part = await reader.read(); }
          catch (error) { if (signal?.aborted) throw error; throw offline(); }
          buffer += decoder.decode(part.value, { stream: !part.done });
          let separator: RegExpExecArray | null;
          while ((separator = /\r?\n\r?\n/u.exec(buffer))) {
            const frame = buffer.slice(0, separator.index);
            buffer = buffer.slice(separator.index + separator[0].length);
            await consume(frame);
          }
          if (part.done) {
            // Incomplete frames are replayed from the last delivered sequence.
            break;
          }
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      const execution = await request<Execution>(`/executions/${encode(id)}`, withSignal(signal));
      if (!["queued", "running"].includes(execution.status)) {
        // Settlement and its event are persisted together. Fetch all pages after settlement
        // so even a dropped terminal frame or a tail larger than 500 events is delivered.
        while (true) {
          const tail = await request<ProductEvent[]>(eventPath(after, id), withSignal(signal));
          for (const event of tail) await deliver(event);
          if (tail.length < 500) return execution;
        }
      }
      await reconnectDelay(300, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!(error instanceof ApiError) || !(error.code === "offline" || (error.status >= 500 && !error.code.startsWith("invalid_")))) throw error;
      await reconnectDelay(retryDelay, signal);
      retryDelay = Math.min(retryDelay * 2, 10000);
    }
  }
}

/** A watermark acknowledges a persisted snapshot only after its consumer reconciles it. */
async function subscribeConversation(
  id: string,
  onChange: (change: ConversationChange) => void | Promise<void>,
  options: ExecutionSubscriptionOptions = {},
): Promise<void> {
  const { signal } = options;
  let after = options.after ?? 0;
  let retryDelay = 300;
  if (!Number.isSafeInteger(after) || after < 0) throw new ApiError("无效的会话位置。", "invalid_input", 400);
  const invalid = () => new ApiError("本地服务返回了无效的会话变更。", "invalid_event", 502);
  const encoder = new TextEncoder();
  while (!signal?.aborted) {
    try {
      const response = await fetchResponse(`/conversations/${encode(id)}/stream?after=${after}`, {
        ...withSignal(signal), headers: { Accept: "text/event-stream" },
      });
      if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
        throw new ApiError("本地服务没有返回会话事件流。", "invalid_stream", 502);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const cancelReader = () => { void reader.cancel().catch(() => undefined); };
      signal?.addEventListener('abort', cancelReader, { once: true });
      if (signal?.aborted) cancelReader();
      let buffer = "";
      const consume = async (frame: string) => {
        if (encoder.encode(frame).byteLength > 64 * 1024) throw invalid();
        const fields = frame.split(/\r?\n/u).filter(line => line && !line.startsWith(':'));
        if (!fields.length) return;
        if (fields.some(line => !/^(event|id|data):/u.test(line))) throw invalid();
        const values = (name: string) => fields.filter(line => line.startsWith(name + ':'))
          .map(line => line.slice(name.length + 1).replace(/^ /u, ''));
        const names = values('event'); const ids = values('id'); const data = values('data');
        if (names.length !== 1 || names[0] !== 'conversation.changed' || ids.length !== 1 || !data.length) throw invalid();
        let change: ConversationChange;
        try { change = JSON.parse(data.join('\n')) as ConversationChange; } catch { throw invalid(); }
        if (!change || Array.isArray(change) || Object.keys(change).sort().join(',') !== 'conversationId,sequence,version'
          || change.version !== 1 || change.conversationId !== id
          || !Number.isSafeInteger(change.sequence) || change.sequence < 1 || ids[0] !== String(change.sequence)) throw invalid();
        if (change.sequence <= after) return;
        throwIfAborted(signal);
        await onChange(change);
        throwIfAborted(signal);
        after = change.sequence;
        retryDelay = 300;
      };
      try {
        while (!signal?.aborted) {
          let part: ReadableStreamReadResult<Uint8Array>;
          try { part = await reader.read(); }
          catch (error) { if (signal?.aborted) throw error; throw offline(); }
          // EOF may split a valid UTF-8 code point in an incomplete frame. Discard
          // that unacknowledged tail rather than flushing the decoder as a protocol error.
          // Invalid bytes received in actual chunks still fail fatal decoding.
          if (part.done) break;
          try { buffer += decoder.decode(part.value, { stream: true }); } catch { throw invalid(); }
          let separator: RegExpExecArray | null;
          while ((separator = /\r?\n\r?\n/u.exec(buffer))) {
            const frame = buffer.slice(0, separator.index);
            buffer = buffer.slice(separator.index + separator[0].length);
            await consume(frame);
          }
          if (encoder.encode(buffer).byteLength > 64 * 1024) throw invalid();
        }
      } finally {
        signal?.removeEventListener('abort', cancelReader);
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    } catch (error) {
      if (signal?.aborted) return;
      if (!(error instanceof ApiError) || !(error.code === 'offline' || error.code === 'timeout' || (error.status >= 500 && !error.code.startsWith('invalid_')))) throw error;
    }
    try { await reconnectDelay(retryDelay, signal); } catch (error) { if (signal?.aborted) return; throw error; }
    retryDelay = Math.min(retryDelay * 2, 5000);
  }
}

export const api = {
  session: (ticket: string) => request<{ ok: boolean }>("/session", { method: "POST", ...body({ ticket }) }),
  signOut: () => request<{ ok: boolean }>("/session", { method: 'DELETE' }),
  pair: (code: string, client: 'browser' | 'native', name = 'iPhone') => request<{ token?: string; deviceId?: string; expiresAt?: string }>("/devices/pair", { method: 'POST', ...body({ code, client, name }) }),
  disconnectDevice: () => request<{ ok: boolean }>("/device-session", { method: 'DELETE' }),
  createDevicePairing: () => request<{ code: string; expiresAt: string; addresses: string[] }>("/device-pairing", { method: 'POST' }),
  devices: () => request<Array<{ id: string; name: string; createdAt: string; expiresAt: string }>>("/devices"),
  revokeDevice: (id: string) => request<{ ok: boolean }>(`/devices/${encode(id)}`, { method: 'DELETE' }),
  settings: (input: { memoryEnabled?: boolean; timezone?: string }) => request<{ ok: boolean }>("/settings", { method: 'PATCH', ...body(input) }),
  status: (signal?: AbortSignal) => request<RuntimeStatus>("/status", withSignal(signal)),
  conversations: (signal?: AbortSignal) => request<Conversation[]>("/conversations", withSignal(signal)),
  createConversation: (title?: string) => request<Conversation>("/conversations", { method: "POST", ...body(title ? { title } : {}) }),
  messages: (id: string, signal?: AbortSignal) => request<Message[]>(`/conversations/${encode(id)}/messages`, withSignal(signal)),
  submitMessage: (id: string, text: string, requestId: string) => request<Execution>(`/conversations/${encode(id)}/messages`, { method: "POST", ...body({ text, requestId }) }),
  executions: (signal?: AbortSignal, conversationId?: string) => request<Execution[]>("/executions" + (conversationId ? `?conversationId=${encode(conversationId)}` : ""), withSignal(signal)),
  execution: (id: string, signal?: AbortSignal) => request<Execution>(`/executions/${encode(id)}`, withSignal(signal)),
  cancel: cancelExecution,
  cancelExecution,
  retryExecution: (id: string) => request<Execution>(`/executions/${encode(id)}/retry`, { method: "POST" }),
  events: (after = 0, executionId?: string, signal?: AbortSignal) => request<ProductEvent[]>(eventPath(after, executionId), withSignal(signal)),
  subscribeExecution,
  subscribeConversation,
  memories: (signal?: AbortSignal, query?: string) => request<MemoryClaim[]>("/memory" + (query ? `?q=${encode(query)}` : ""), withSignal(signal)),
  people: (signal?: AbortSignal) => request<Person[]>("/people", withSignal(signal)),
  editMemory: (memory: MemoryClaim, text: string) => request<MemoryClaim>(`/memory/${encode(memory.id)}`, { method: "PATCH", ...body({ text, expectedVersion: memory.version }) }),
  deleteMemory: (memory: MemoryClaim | MemoryRelationship) => request<MemoryClaim | MemoryRelationship>(`/memory/${encode(memory.id)}`, { method: "DELETE", ...body({ expectedVersion: memory.version }) }),
  memoryHistory: (id: string, signal?: AbortSignal) => request<MemoryRevision[]>(`/memory/${encode(id)}/history`, withSignal(signal)),
  work: (signal?: AbortSignal) => request<WorkTask[]>("/work", withSignal(signal)),
  workDetail: (id: string, signal?: AbortSignal) => request<WorkDetail>(`/work/${encode(id)}`, withSignal(signal)),
  createWork: (input: CreateWork) => request<WorkTask>("/work", { method: "POST", ...body(input) }),
  cancelWork: (id: string, expectedVersion?: number) => request<WorkTask>(`/work/${encode(id)}/cancel`, { method: "POST", ...body(expectedVersion === undefined ? {} : { expectedVersion }) }),
  notifications: (signal?: AbortSignal, unreadOnly = false, conversationId?: string) => {
    const query = new URLSearchParams();
    if (unreadOnly) query.set("unread", "true");
    if (conversationId) query.set("conversationId", conversationId);
    return request<WorkNotification[]>("/notifications" + (query.size ? `?${query}` : ""), withSignal(signal));
  },
  readNotification: (id: string) => request<WorkNotification>(`/notifications/${encode(id)}/read`, { method: "POST" }),
};
