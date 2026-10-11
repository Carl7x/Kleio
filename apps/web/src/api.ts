import type {
  Approval,
  Artifact,
  Conversation,
  Memory,
  Message,
  MessageSubmission,
  Run,
  Task,
} from "../../../packages/core/contracts.ts";
export type { Approval, Artifact, Conversation, Memory, Message, Run, Task };

export interface Settings {
  product: string;
  engine: {
    id: string;
    mode: "demo" | "dsh";
    label: string;
    capabilities: {
      cancel: boolean;
      permissions: boolean;
      resume: boolean;
      steer: boolean;
    };
  };
  runtime: {
    status: "demo" | "ready" | "missing";
    missing: string[];
    note: string;
  };
  setup: {
    configuration: string;
    restartRequired: boolean;
    instructions: string[];
  };
}
export interface Health {
  ok: boolean;
  engine: string;
  capabilities: Settings["engine"]["capabilities"];
}
export interface MemoryRevision {
  memory: Memory;
  reason: string;
}
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api" + path, {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new ApiError(
      "暂时连接不上本地服务。检查服务是否运行，再重试；草稿已保留。",
      "offline",
      0,
    );
  }
  const value = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok)
    throw new ApiError(
      typeof value?.error === "string"
        ? value.error
        : "操作没有完成，请刷新状态后重试。",
      String(value?.code ?? "request_failed"),
      response.status,
    );
  return value as T;
}
const body = (value: unknown): RequestInit => ({ body: JSON.stringify(value) });
export const api = {
  health: (signal?: AbortSignal) =>
    request<Health>("/health", signal ? { signal } : {}),
  settings: (signal?: AbortSignal) =>
    request<Settings>("/settings", signal ? { signal } : {}),
  conversations: (signal?: AbortSignal) =>
    request<Conversation[]>("/conversations", signal ? { signal } : {}),
  createConversation: () =>
    request<Conversation>("/conversations", { method: "POST", ...body({}) }),
  messages: (id: string, signal?: AbortSignal) =>
    request<Message[]>(
      `/conversations/${encodeURIComponent(id)}/messages`,
      signal ? { signal } : {},
    ),
  submitMessage: (id: string, text: string, clientMessageId: string) =>
    request<MessageSubmission>(
      `/conversations/${encodeURIComponent(id)}/messages`,
      { method: "POST", ...body({ text, clientMessageId }) },
    ),
  tasks: (signal?: AbortSignal) =>
    request<Task[]>("/tasks", signal ? { signal } : {}),
  runs: (signal?: AbortSignal) =>
    request<Run[]>("/runs", signal ? { signal } : {}),
  restart: (id: string) =>
    request<{ taskId: string; runId: string }>(
      `/tasks/${encodeURIComponent(id)}/restart`,
      { method: "POST" },
    ),
  cancel: (id: string) =>
    request<{ ok: boolean }>(`/runs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    }),
  approvals: (signal?: AbortSignal) =>
    request<Approval[]>("/approvals", signal ? { signal } : {}),
  decide: (id: string, hash: string, allow: boolean) =>
    request<Approval>(`/approvals/${encodeURIComponent(id)}/decision`, {
      method: "POST",
      ...body({ hash, allow }),
    }),
  artifacts: (signal?: AbortSignal) =>
    request<Artifact[]>("/artifacts", signal ? { signal } : {}),
  memories: (signal?: AbortSignal) =>
    request<Memory[]>("/memories", signal ? { signal } : {}),
  addMemory: (text: string, source: string) =>
    request<Memory>("/memories", {
      method: "POST",
      ...body({ text, source, scope: "personal" }),
    }),
  editMemory: (memory: Memory, text: string, source: string) =>
    request<Memory>(`/memories/${encodeURIComponent(memory.id)}`, {
      method: "PATCH",
      ...body({ version: memory.version, text, source }),
    }),
  deleteMemory: (memory: Memory) =>
    request<Memory>(`/memories/${encodeURIComponent(memory.id)}`, {
      method: "DELETE",
      ...body({ version: memory.version }),
    }),
  undoMemory: (memory: Memory) =>
    request<Memory>(`/memories/${encodeURIComponent(memory.id)}/undo`, {
      method: "POST",
      ...body({ version: memory.version }),
    }),
  memoryHistory: (id: string) =>
    request<MemoryRevision[]>(`/memories/${encodeURIComponent(id)}/history`),
};
