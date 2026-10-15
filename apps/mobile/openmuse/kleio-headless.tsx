// OpenMuse's headless view contract backed by Kleio's local, persisted runtime.
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api, type Execution, type Message as SavedMessage, type ProductEvent } from "../src/api";
import { clientFetch } from "../src/transport";
import { replayedRunError, threadLocked } from "./conversation-run";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ToolMessage = { id: string; role: "tool"; toolCallId: string; content: string };
export type Message =
  | { id: string; role: "user"; content: string }
  | { id: string; role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | ToolMessage;
type AssistantMessage = Extract<Message, { role: "assistant" }>;
type RunError = { error: unknown; code?: string; context?: { agentId?: string } };
type Thread = { id: string; name: string; archived: boolean };
type ThreadRecord = { id: string; name?: string; title?: string; archived?: boolean };
type ToolRenderer = {
  name: string;
  description?: string;
  parameters?: unknown;
  render: (input: { toolCallId: string; args: Record<string, unknown>; result: unknown; status: "complete" | "executing" }) => ReactNode;
};
const working = (execution: Execution) => execution.status === "queued" || execution.status === "running";
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const displayToolName = (name: string) => ({ web_search: "search_web", create_work: "delegate_task", work_status: "agent_status", memory_correct: "remember_fact" } as Record<string, string>)[name] ?? name;

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
        if (!response.ok) throw Object.assign(new Error(typeof payload?.error === "string" ? payload.error : "Could not load the saved workspace."), { code: payload?.code });
        return payload as T;
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error("The local workspace did not respond. Retry loading the conversation.")); controller.abort(); }, 15_000);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Preserve the original assistant text → tool calls → next assistant text order. */
export function executionMessages(execution: Execution, events: readonly ProductEvent[], fallback = ""): Message[] {
  const messages: Message[] = [];
  let current: AssistantMessage | undefined;
  let afterTool = false;
  const tools = new Map<string, ToolCall>();
  const makeMessage = (sequence: number) => {
    const next: AssistantMessage = { id: `${execution.id}:assistant:${sequence}`, role: "assistant", content: "" };
    messages.push(next);
    current = next;
    return next;
  };
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const data = event.data;
    if (event.type === "text.delta" && typeof data.text === "string" && data.text) {
      if (!current || afterTool) makeMessage(event.sequence);
      current!.content += data.text;
      afterTool = false;
    } else if (event.type === "tool.started" && typeof data.callId === "string" && typeof data.name === "string") {
      if (tools.has(data.callId)) continue;
      const call: ToolCall = { id: data.callId, type: "function", function: { name: displayToolName(data.name), arguments: JSON.stringify(data.args ?? {}) } };
      if (!current) makeMessage(event.sequence);
      current!.toolCalls = [...(current!.toolCalls ?? []), call];
      tools.set(call.id, call);
      afterTool = true;
    } else if ((event.type === "tool.completed" || event.type === "tool.failed") && typeof data.callId === "string") {
      if (!tools.has(data.callId) && typeof data.name === "string") {
        const call: ToolCall = { id: data.callId, type: "function", function: { name: displayToolName(data.name), arguments: "{}" } };
        if (!current) makeMessage(event.sequence);
        current!.toolCalls = [...(current!.toolCalls ?? []), call];
        tools.set(call.id, call);
      }
      const result = event.type === "tool.failed" ? { error: typeof data.error === "string" ? data.error : "The tool did not complete." } : data.result ?? {};
      messages.push({ id: `${execution.id}:tool:${data.callId}`, role: "tool", toolCallId: data.callId, content: typeof result === "string" ? result : JSON.stringify(result) });
      afterTool = true;
    }
  }
  // Older saved turns without text events still retain their completed answer.
  if (!messages.some(item => item.role === "assistant" && item.content)) {
    const text = execution.text || fallback;
    if (text) makeMessage(Number.MAX_SAFE_INTEGER).content = text;
  }
  return messages;
}

class LocalAgent {
  messages: Message[] = [];
  isRunning = false;
  canRetry = true;
  private version = 0;
  private readonly listeners = new Set<() => void>();
  private readonly messageListeners = new Set<(input: { messages: Message[] }) => void>();
  private saved: SavedMessage[] = [];
  private executions: Execution[] = [];
  private readonly events = new Map<string, ProductEvent[]>();
  private readonly subscriptions = new Map<string, { controller: AbortController; promise: Promise<Execution> }>();
  private pendingUser: Extract<Message, { role: "user" }> | undefined;
  private acceptedRequest: { requestId: string; executionId: string; text: string } | undefined;
  private ensured = false;
  private generation = 0;
  private stopRequested = false;
  constructor(readonly id: string, readonly threadId: string, private runtime: HeadlessRuntime) {}
  getSnapshot = () => this.version;
  subscribeUpdate = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private notify() { this.version++; this.listeners.forEach(listener => listener()); this.messageListeners.forEach(listener => listener({ messages: this.messages })); }
  subscribe({ onMessagesChanged }: { onMessagesChanged: (input: { messages: Message[] }) => void }) {
    this.messageListeners.add(onMessagesChanged);
    return { unsubscribe: () => { this.messageListeners.delete(onMessagesChanged); } };
  }
  addMessage(value: Message) {
    if (value.role === "user") { this.pendingUser = value; this.canRetry = true; }
    this.messages = [...this.messages, value]; this.notify();
  }
  setMessages(messages: Message[]) {
    if (this.pendingUser && !messages.some(item => item.id === this.pendingUser!.id)) this.pendingUser = undefined;
    this.messages = messages; this.notify();
  }
  private rebuild() {
    const output: Message[] = [];
    for (const user of this.saved.filter(item => item.role === "user")) {
      output.push({ id: user.id, role: "user", content: user.content });
      const turns = this.executions.filter(item => item.messageId === user.id || item.id === user.executionId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const turn of turns) {
        const fallback = this.saved.find(item => item.role === "assistant" && item.executionId === turn.id)?.content;
        output.push(...executionMessages(turn, this.events.get(turn.id) ?? [], fallback));
      }
    }
    if (this.pendingUser) {
      output.push(this.pendingUser);
      if (this.acceptedRequest?.requestId === this.pendingUser.id) {
        const turn = this.executions.find(item => item.id === this.acceptedRequest!.executionId);
        if (turn) output.push(...executionMessages(turn, this.events.get(turn.id) ?? []));
      }
    }
    this.messages = output;
    this.isRunning = this.executions.some(working);
    this.canRetry = (!!this.pendingUser && this.acceptedRequest?.requestId !== this.pendingUser.id) || !!this.failedTurn() || this.isRunning;
    this.notify();
  }
  /** The latest saved turn when it stopped and can be run again on the same user message. */
  private failedTurn(): Execution | undefined {
    if (this.pendingUser || this.executions.some(working)) return;
    const user = [...this.saved].reverse().find(item => item.role === "user");
    if (!user) return;
    const latest = this.executions.filter(item => item.messageId === user.id || item.id === user.executionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (latest && ["failed", "cancelled", "interrupted"].includes(latest.status)) return latest;
  }
  private acceptEvent(event: ProductEvent) {
    const previous = this.events.get(event.executionId) ?? [];
    if (previous.some(item => item.sequence === event.sequence)) return;
    this.events.set(event.executionId, [...previous, event].sort((a, b) => a.sequence - b.sequence));
    this.rebuild();
  }
  private mergeExecution(next: Execution) {
    const previous = this.executions.find(item => item.id === next.id);
    if (previous && !working(previous) && working(next)) return;
    this.executions = [...this.executions.filter(item => item.id !== next.id), next];
  }
  private async ensureThread() {
    if (this.ensured) return;
    await request("/api/threads", { id: this.threadId });
    this.ensured = true; this.runtime.threadsChanged();
  }
  private async hydrate() {
    const generation = this.generation;
    const [saved, executions] = await Promise.all([api.messages(this.threadId), api.executions(undefined, this.threadId)]);
    const turns = executions.filter(item => item.kind === "conversation");
    await Promise.all(turns.map(async execution => {
      let after = 0;
      while (generation === this.generation) {
        const page = await api.events(after, execution.id);
        const previous = this.events.get(execution.id) ?? [];
        const bySequence = new Map(previous.map(item => [item.sequence, item]));
        page.forEach(item => bySequence.set(item.sequence, item));
        this.events.set(execution.id, [...bySequence.values()].sort((a, b) => a.sequence - b.sequence));
        if (page.length < 500) break;
        after = page[page.length - 1].sequence;
      }
    }));
    if (generation !== this.generation) return;
    this.saved = saved;
    turns.forEach(turn => this.mergeExecution(turn));
    if (this.acceptedRequest && saved.some(item => item.role === "user" && item.executionId === this.acceptedRequest!.executionId)) this.pendingUser = undefined;
    this.rebuild();
  }
  private watch(execution: Execution, replay = false): Promise<Execution> {
    const existing = this.subscriptions.get(execution.id);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const generation = this.generation;
    const after = this.events.get(execution.id)?.at(-1)?.sequence ?? 0;
    const promise = api.subscribeExecution(execution.id, event => {
      if (generation === this.generation) this.acceptEvent(event);
    }, { after, signal: controller.signal }).then(async terminal => {
      if (generation !== this.generation) return terminal;
      this.mergeExecution(terminal); this.rebuild();
      try { await this.hydrate(); }
      catch (error) { this.runtime.emitError({ error, context: { agentId: this.id } }); }
      this.runtime.threadsChanged();
      if (["failed", "unknown", "interrupted"].includes(terminal.status)) this.runtime.emitError({ error: new Error(terminal.error || "The response did not complete."), code: replay ? replayedRunError : "agent_run_failed", context: { agentId: this.id } });
      return terminal;
    }).finally(() => { if (this.subscriptions.get(execution.id)?.controller === controller) this.subscriptions.delete(execution.id); });
    this.subscriptions.set(execution.id, { controller, promise });
    return promise;
  }
  async connect() {
    await this.hydrate(); this.ensured = true;
    await Promise.all(this.executions.filter(working).map(execution => this.watch(execution, true)));
  }
  async run() {
    if (this.isRunning) {
      this.runtime.emitError({ error: new Error("The conversation is already replying."), code: threadLocked, context: { agentId: this.id } });
      return;
    }
    const user = this.pendingUser ?? [...this.messages].reverse().find((item): item is Extract<Message, { role: "user" }> => item.role === "user");
    if (!user) throw new Error("There is no message to send.");
    const retryOf = this.pendingUser ? undefined : this.failedTurn();
    if (!this.pendingUser && !retryOf) throw new Error("This saved response cannot be run again. Send a new message to continue.");
    if (this.pendingUser && !this.canRetry) throw new Error("This saved response cannot be run again. Send a new message to continue.");
    this.stopRequested = false;
    this.isRunning = true; this.notify();
    try {
      await this.ensureThread();
      const requestId = this.pendingUser?.id ?? this.acceptedRequest?.requestId ?? user.id;
      const execution = retryOf ? await api.retryExecution(retryOf.id) : await api.submitMessage(this.threadId, user.content, requestId);
      this.acceptedRequest = { requestId, executionId: execution.id, text: user.content };
      this.mergeExecution(execution); this.rebuild();
      if (this.stopRequested && working(execution)) await api.cancelExecution(execution.id);
      if (working(execution)) {
        const following = this.watch(execution);
        void following.catch(() => {});
        try { await this.hydrate(); }
        catch (error) { this.runtime.emitError({ error, context: { agentId: this.id } }); }
        await following;
      } else {
        await this.hydrate();
        if (["failed", "unknown", "interrupted"].includes(execution.status)) this.runtime.emitError({ error: new Error(execution.error || "The response did not complete."), code: "agent_run_failed", context: { agentId: this.id } });
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      this.runtime.emitError({ error, code, context: { agentId: this.id } });
      throw error;
    } finally { this.isRunning = this.executions.some(working); this.notify(); }
  }
  async stop() {
    this.stopRequested = true;
    await Promise.all(this.executions.filter(working).map(item => api.cancelExecution(item.id)));
  }
  async detachActiveRun() {
    this.generation++;
    this.subscriptions.forEach(subscription => subscription.controller.abort());
    this.subscriptions.clear();
  }
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
  if (!runtime) throw new Error("The local chat runtime is unavailable.");
  return runtime;
}
export function useAgent({ agentId, threadId }: { agentId: string; runtimeAgentId: string; threadId: string }) {
  const runtime = useRuntime();
  let agent = runtime.agents.get(agentId);
  if (!agent) { agent = new LocalAgent(agentId, threadId, runtime); runtime.agents.set(agentId, agent); }
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
      setAll(records.filter(item => includeArchived || !item.archived).map(item => ({ id: item.id, name: item.name ?? (item.title === "New conversation" ? "" : item.title) ?? "", archived: item.archived === true })));
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
