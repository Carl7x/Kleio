import type { api, Execution, Message as SavedMessage, ProductEvent } from "../src/api";
import { conversationSyncError, replayedRunError, threadLocked } from "./conversation-run";
import { executionMessages, projectConversationMessages, type Message } from "./conversation-history";
export type LocalAgentApi = Pick<typeof api, "messages" | "executions" | "events" | "subscribeExecution" | "subscribeConversation" | "submitMessage" | "retryExecution" | "cancelExecution">;
export type LocalAgentRuntime = { emitError(error: { error: unknown; code?: string; context?: { agentId?: string } }): void; threadsChanged(): void };
const working = (execution: Execution) => execution.status === "queued" || execution.status === "running";
export class LocalAgent {
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
  private submitting = false;
  private readonly completedEventReads = new Set<string>();
  private hydrationQueue: Array<{ generation: number; signal?: AbortSignal; resolve: () => void; reject: (error: unknown) => void }> = [];
  private hydrating = false;
  private hydrationController?: AbortController;
  private observation?: AbortController;
  private observationActive = false;
  private watermark = 0;
  constructor(readonly id: string, readonly threadId: string, private runtime: LocalAgentRuntime, private api: LocalAgentApi, private ensure: () => Promise<unknown>) {}
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
    const output = projectConversationMessages({ conversationId: this.threadId, saved: this.saved, executions: this.executions, eventsByExecution: this.events });
    if (this.pendingUser && !output.some(item => item.id === this.pendingUser!.id)) {
      output.push(this.pendingUser);
      if (this.acceptedRequest?.requestId === this.pendingUser.id) {
        const turn = this.executions.find(item => item.id === this.acceptedRequest!.executionId);
        if (turn) output.push(...executionMessages(turn, this.events.get(turn.id) ?? []));
      }
    }
    this.messages = output;
    this.isRunning = this.submitting || this.executions.some(working);
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
    const generation = this.generation;
    await this.ensure();
    if (generation !== this.generation) return;
    this.ensured = true; this.runtime.threadsChanged();
    this.startObservation();
  }
  /** Requests during a read form a fresh batch; they never acknowledge its older snapshot. */
  private hydrate(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    const result = new Promise<void>((resolve, reject) => this.hydrationQueue.push({ generation: this.generation, signal, resolve, reject }));
    void this.drainHydration();
    return result;
  }
  private async drainHydration() {
    if (this.hydrating) return;
    this.hydrating = true;
    try {
      while (this.hydrationQueue.length) {
        const queued = this.hydrationQueue.splice(0);
        const batch = queued.filter(item => item.generation === this.generation && !item.signal?.aborted);
        queued.filter(item => !batch.includes(item)).forEach(item => item.resolve());
        if (!batch.length) continue;
        const controller = new AbortController();
        this.hydrationController = controller;
        const generation = this.generation;
        const cancelled = () => {
          if (batch.every(item => item.signal?.aborted)) controller.abort();
        };
        batch.forEach(item => item.signal?.addEventListener('abort', cancelled));
        cancelled();
        const current = () => generation === this.generation && !controller.signal.aborted;
        try {
          const [saved, executions] = await Promise.all([
            this.api.messages(this.threadId, controller.signal),
            this.api.executions(controller.signal, this.threadId),
          ]);
          if (!current()) continue;
          const turns = executions.filter(item => item.kind === "conversation" && item.conversationId === this.threadId);
          for (const execution of turns) {
            if (this.completedEventReads.has(execution.id)) continue;
            let after = this.events.get(execution.id)?.at(-1)?.sequence ?? 0;
            while (current()) {
              const page = await this.api.events(after, execution.id, controller.signal);
              if (!current()) break;
              const previous = this.events.get(execution.id) ?? [];
              const bySequence = new Map(previous.map(item => [item.sequence, item]));
              page.filter(item => item.executionId === execution.id).forEach(item => bySequence.set(item.sequence, item));
              this.events.set(execution.id, [...bySequence.values()].sort((a, b) => a.sequence - b.sequence));
              if (page.length < 500) {
                if (!working(execution)) this.completedEventReads.add(execution.id);
                break;
              }
              after = page[page.length - 1].sequence;
            }
            if (!current()) break;
          }
          if (!current()) continue;
          this.saved = saved.filter(item => item.conversationId === this.threadId);
          this.watermark = this.saved.reduce((maximum, item) => Math.max(maximum, item.sequence), 0);
          turns.forEach(turn => this.mergeExecution(turn));
          if (this.acceptedRequest?.requestId === this.pendingUser?.id && this.acceptedRequest && this.saved.some(item => item.role === "user" && item.executionId === this.acceptedRequest!.executionId)) this.pendingUser = undefined;
          this.rebuild();
        } catch (error) {
          if (current()) batch.forEach(item => { if (!item.signal?.aborted) item.reject(error); });
        } finally {
          batch.forEach(item => { item.signal?.removeEventListener('abort', cancelled); item.resolve(); });
          controller.abort(); // Also retire a sibling read if Promise.all failed early.
          if (this.hydrationController === controller) this.hydrationController = undefined;
        }
      }
    } finally { this.hydrating = false; }
  }
  /** Observation belongs to visibility, independently of foreground execution subscriptions. */
  setConversationActive(active: boolean, existing = false) {
    this.observationActive = active;
    if (existing) this.ensured = true;
    if (!active) {
      this.observation?.abort(); this.observation = undefined;
      return;
    }
    if (this.ensured) this.startObservation();
  }
  private startObservation() {
    if (!this.observationActive || this.observation) return;
    const controller = new AbortController();
    this.observation = controller;
    const generation = this.generation;
    const current = () => this.observation === controller && !controller.signal.aborted && generation === this.generation;
    const observe = async () => {
      let delay = 300;
      while (current()) {
        try {
          await this.hydrate(controller.signal);
          if (!current()) return;
          await this.api.subscribeConversation(this.threadId, async () => {
            if (!current()) return;
            await this.hydrate(controller.signal);
          }, { after: this.watermark, signal: controller.signal });
          return;
        } catch (error) {
          if (!current()) return;
          const failure = error as { code?: string; status?: number };
          if (!(failure.code === 'offline' || failure.code === 'timeout' || ((failure.status ?? 0) >= 500 && !failure.code?.startsWith('invalid_')))) throw error;
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
            const timer = setTimeout(done, delay);
            controller.signal.addEventListener('abort', done, { once: true });
          });
          if (!current()) return;
          delay = Math.min(delay * 2, 5000);
        }
      }
    };
    void observe().catch(error => {
      if (current()) this.runtime.emitError({ error, code: conversationSyncError, context: { agentId: this.id } });
    });
  }
  private watch(execution: Execution, replay = false): Promise<Execution> {
    const existing = this.subscriptions.get(execution.id);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const generation = this.generation;
    const after = this.events.get(execution.id)?.at(-1)?.sequence ?? 0;
    const promise = this.api.subscribeExecution(execution.id, event => {
      if (generation === this.generation) this.acceptEvent(event);
    }, { after, signal: controller.signal }).then(async terminal => {
      if (generation !== this.generation) return terminal;
      this.mergeExecution(terminal); this.rebuild();
      try { await this.hydrate(); }
      catch (error) { if (generation === this.generation) this.runtime.emitError({ error, context: { agentId: this.id } }); }
      if (generation !== this.generation) return terminal;
      this.runtime.threadsChanged();
      if (["failed", "unknown", "interrupted"].includes(terminal.status)) this.runtime.emitError({ error: new Error(terminal.error || "回复未完成。"), code: replay ? replayedRunError : "agent_run_failed", context: { agentId: this.id } });
      return terminal;
    }).finally(() => { if (this.subscriptions.get(execution.id)?.controller === controller) this.subscriptions.delete(execution.id); });
    this.subscriptions.set(execution.id, { controller, promise });
    return promise;
  }
  async connect() {
    const generation = this.generation;
    await this.hydrate();
    if (generation !== this.generation) return;
    this.ensured = true; this.startObservation();
    await Promise.all(this.executions.filter(working).map(execution => this.watch(execution, true)));
  }
  async run() {
    if (this.isRunning) {
      this.runtime.emitError({ error: new Error("对话正在回复中。"), code: threadLocked, context: { agentId: this.id } });
      return;
    }
    const user = this.pendingUser ?? [...this.messages].reverse().find((item): item is Extract<Message, { role: "user" }> => item.role === "user");
    if (!user) throw new Error("没有可发送的消息。");
    const retryOf = this.pendingUser ? undefined : this.failedTurn();
    if (!this.pendingUser && !retryOf) throw new Error("这条已保存的回复无法再运行。发送新消息继续。");
    if (this.pendingUser && !this.canRetry) throw new Error("这条已保存的回复无法再运行。发送新消息继续。");
    const generation = this.generation;
    this.submitting = true;
    this.stopRequested = false;
    this.isRunning = true; this.notify();
    try {
      await this.ensureThread();
      if (generation !== this.generation) return;
      const requestId = this.pendingUser?.id ?? this.acceptedRequest?.requestId ?? user.id;
      const execution = retryOf ? await this.api.retryExecution(retryOf.id) : await this.api.submitMessage(this.threadId, user.content, requestId);
      if (generation !== this.generation) return;
      this.submitting = false;
      this.acceptedRequest = { requestId, executionId: execution.id, text: user.content };
      this.mergeExecution(execution); this.rebuild();
      if (this.stopRequested && working(execution)) await this.api.cancelExecution(execution.id);
      if (generation !== this.generation) return;
      if (working(execution)) {
        const following = this.watch(execution);
        void following.catch(() => {});
        try { await this.hydrate(); }
        catch (error) { if (generation === this.generation) this.runtime.emitError({ error, context: { agentId: this.id } }); }
        await following;
      } else {
        await this.hydrate();
        if (generation !== this.generation) return;
        if (["failed", "unknown", "interrupted"].includes(execution.status)) this.runtime.emitError({ error: new Error(execution.error || "回复未完成。"), code: "agent_run_failed", context: { agentId: this.id } });
      }
    } catch (error) {
      if (generation !== this.generation) return;
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      this.runtime.emitError({ error, code, context: { agentId: this.id } });
      throw error;
    } finally { if (generation === this.generation) { this.submitting = false; this.isRunning = this.executions.some(working); this.notify(); } }
  }
  async stop() {
    this.stopRequested = true;
    await Promise.all(this.executions.filter(working).map(item => this.api.cancelExecution(item.id)));
  }
  async detachActiveRun() {
    this.generation++;
    this.submitting = false;
    this.setConversationActive(false);
    this.hydrationController?.abort();
    this.subscriptions.forEach(subscription => subscription.controller.abort());
    this.subscriptions.clear();
  }
}

