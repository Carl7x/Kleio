// Headless view contract backed by Kleio's local, persisted runtime.
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../src/api";
import { LocalAgent } from "./local-agent";
import { clientFetch } from "../src/transport";

import { type Message, type ToolCall, type ToolMessage } from "./conversation-history";
export { executionMessages } from "./conversation-history";
export type { ToolCall, ToolMessage, Message } from "./conversation-history";
type RunError = { error: unknown; code?: string; context?: { agentId?: string } };
type Thread = { id: string; name: string; archived: boolean };
type ThreadRecord = { id: string; name?: string; title?: string; archived?: boolean };
type ToolRenderer = {
  name: string;
  description?: string;
  parameters?: unknown;
  render: (input: { toolCallId: string; args: Record<string, unknown>; result: unknown; status: "complete" | "executing" }) => ReactNode;
};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function request<T>(path: string, value?: unknown, method?: string): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await clientFetch(path, {
          method: method ?? (value === undefined ? "GET" : "POST"),
          headers: { "Content-Type": "application/json" }, signal: controller.signal,
          ...(value === undefined ? {} : { body: JSON.stringify(value) }),
        });
        const payload = await response.json();
        if (!response.ok) throw Object.assign(new Error(typeof payload?.error === "string" ? payload.error : "无法加载已保存的工作台。"), { code: payload?.code });
        return payload as T;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error("本地工作台无响应。请重试加载对话。")); controller.abort(); }, 15_000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}



class HeadlessRuntime {
  readonly agents = new Map<string, LocalAgent>();
  readonly tools = new Map<string, ToolRenderer>();
  private readonly errors = new Set<(error: RunError) => void>();
  private readonly toolListeners = new Set<() => void>();
  private readonly threadListeners = new Set<() => void>();
  private toolVersion = 0;
  readonly copilotkit = {
    connectAgent: ({ agent }: { agent: LocalAgent }) => agent.connect(),
    runAgent: ({ agent }: { agent: LocalAgent }) => agent.run(),
    stopAgent: ({ agent }: { agent: LocalAgent }) => agent.stop(),
    subscribe: ({ onError }: { onError: (error: RunError) => void }) => { this.errors.add(onError); return { unsubscribe: () => { this.errors.delete(onError); } }; },
  };
  emitError(error: RunError) { this.errors.forEach(listener => listener(error)); }
  subscribeTools = (listener: () => void) => { this.toolListeners.add(listener); return () => { this.toolListeners.delete(listener); }; };
  getToolSnapshot = () => this.toolVersion;
  registerTool(renderer: ToolRenderer) {
    this.tools.set(renderer.name, renderer); this.toolVersion++; this.toolListeners.forEach(listener => listener());
    return () => { if (this.tools.get(renderer.name) === renderer) { this.tools.delete(renderer.name); this.toolVersion++; this.toolListeners.forEach(listener => listener()); } };
  }
  subscribeThreads(listener: () => void) { this.threadListeners.add(listener); return () => { this.threadListeners.delete(listener); }; }
  threadsChanged() { this.threadListeners.forEach(listener => listener()); }
  dispose() { this.agents.forEach(agent => void agent.detachActiveRun()); }
}
const RuntimeContext = createContext<HeadlessRuntime | null>(null);
export function KleioHeadlessProvider({ children }: { children: ReactNode }) {
  const [runtime] = useState(() => new HeadlessRuntime());
  useEffect(() => () => runtime.dispose(), [runtime]);
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}
function useRuntime() {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("本地对话运行时不可用。");
  return runtime;
}
export function useAgent({ agentId, threadId }: { agentId: string; runtimeAgentId: string; threadId: string }) {
  const runtime = useRuntime();
  let agent = runtime.agents.get(agentId);
  if (!agent) { agent = new LocalAgent(agentId, threadId, runtime, api, () => request("/api/threads", { id: threadId })); runtime.agents.set(agentId, agent); }
  useSyncExternalStore(agent.subscribeUpdate, agent.getSnapshot, agent.getSnapshot);
  return { agent, isReady: true };
}
export function useCopilotKit() { return { copilotkit: useRuntime().copilotkit }; }
export function useAgentContext(_context: { description: string; value: unknown }) {
  // Kleio's server supplies the authoritative identity, capability and personal context.
}
export function useRenderTool(renderer: ToolRenderer) {
  const runtime = useRuntime();
  const latest = useRef(renderer); latest.current = renderer;
  useEffect(() => runtime.registerTool({ name: renderer.name, render: input => latest.current.render(input) }), [runtime, renderer.name]);
}
export function useRenderToolCall() {
  const runtime = useRuntime();
  useSyncExternalStore(runtime.subscribeTools, runtime.getToolSnapshot, runtime.getToolSnapshot);
  return useCallback(({ toolCall, toolMessage }: { toolCall: ToolCall; toolMessage?: ToolMessage }) => {
    const renderer = runtime.tools.get(toolCall.function.name);
    if (!renderer) return null;
    let args: Record<string, unknown> = {};
    try { args = JSON.parse(toolCall.function.arguments) as Record<string, unknown>; } catch { /* Incomplete tool arguments are displayed without executable behavior. */ }
    return renderer.render({ toolCallId: toolCall.id, args, result: toolMessage?.content, status: toolMessage ? "complete" : "executing" });
  }, [runtime]);
}

export function useThreads({ enabled, includeArchived, limit }: { agentId: string; enabled: boolean; includeArchived: boolean; limit: number }) {
  const runtime = useRuntime();
  const [all, setAll] = useState<Thread[]>([]);
  const [visible, setVisible] = useState(limit);
  const [isLoading, setLoading] = useState(enabled);
  const [isMutating, setMutating] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const alive = useRef(true);
  const generation = useRef(0);
  const refetchThreads = useCallback(async () => {
    if (!enabled) return;
    const current = ++generation.current;
    try {
      const value = await request<ThreadRecord[] | { threads: ThreadRecord[] }>("/api/threads?includeArchived=true");
      if (!alive.current || current !== generation.current) return;
      const records = Array.isArray(value) ? value : value.threads;
      setAll(records.filter(item => includeArchived || !item.archived).map(item => ({ id: item.id, name: item.name ?? (item.title === "新对话" ? "" : item.title) ?? "", archived: item.archived === true })));
      setError(undefined);
    } catch (failure) { if (alive.current && current === generation.current) setError(new Error(message(failure))); }
    finally { if (alive.current && current === generation.current) setLoading(false); }
  }, [enabled, includeArchived]);
  useEffect(() => {
    alive.current = true; setLoading(enabled); void refetchThreads();
    const unsubscribe = runtime.subscribeThreads(() => void refetchThreads());
    return () => { alive.current = false; generation.current++; unsubscribe(); };
  }, [runtime, enabled, refetchThreads]);
  const mutate = async (id: string, body?: unknown, action?: "archive" | "restore") => {
    setMutating(true);
    try { await request(`/api/threads/${encodeURIComponent(id)}${action ? `/${action}` : ""}`, body ?? {}, action ? "POST" : "PATCH"); await refetchThreads(); }
    finally { if (alive.current) setMutating(false); }
  };
  return {
    threads: all.slice(0, visible), isLoading, isMutating, error, refetchThreads,
    renameThread: (id: string, name: string) => mutate(id, { title: name }),
    archiveThread: (id: string) => mutate(id, undefined, "archive"),
    unarchiveThread: (id: string) => mutate(id, undefined, "restore"),
    hasMoreThreads: visible < all.length, isFetchingMoreThreads: false, fetchMoreError: undefined as Error | undefined,
    fetchMoreThreads: () => setVisible(count => count + limit),
  };
}
