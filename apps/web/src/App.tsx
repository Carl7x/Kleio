import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import {
  ArrowDownToLine,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronRight,
  CircleAlert,
  Clipboard,
  FileText,
  History,
  LoaderCircle,
  Menu,
  MessageCircle,
  Pencil,
  Plus,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  api,
  type Approval,
  type Artifact,
  type Conversation,
  type Health,
  type Memory,
  type MemoryRevision,
  type Message,
  type Run,
  type Settings,
  type Task,
} from "./api.ts";

type View = "chat" | "tasks" | "results" | "memory" | "settings";
type Data = {
  conversations: Conversation[];
  tasks: Task[];
  runs: Run[];
  approvals: Approval[];
  artifacts: Artifact[];
  memories: Memory[];
  health: Health | null;
  settings: Settings | null;
};
const initialData: Data = {
  conversations: [],
  tasks: [],
  runs: [],
  approvals: [],
  artifacts: [],
  memories: [],
  health: null,
  settings: null,
};
const terminal = (status: string) =>
  ["completed", "cancelled", "failed", "interrupted"].includes(status);
const labels: Record<string, string> = {
  queued: "等待开始",
  running: "正在执行",
  waiting_approval: "等待你的许可",
  cancelling: "正在确认停止",
  completed: "已完成",
  cancelled: "已停止",
  failed: "执行失败",
  interrupted: "需要检查",
  pending: "等待许可",
  approved: "已允许",
  rejected: "已拒绝",
  expired: "已过期",
};
const time = (date: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
function Brand({ large = false }: { large?: boolean }) {
  return (
    <span className={`brandmark ${large ? "large" : ""}`} aria-hidden="true">
      <svg viewBox="0 0 36 36" fill="none">
        <path
          d="M10 9v18M18 9v18M26 9v18M7 14h22M7 22h22"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}
function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown>{children}</ReactMarkdown>
    </div>
  );
}
function Status({ status }: { status: string }) {
  return (
    <span className={`status status-${status}`}>
      <span className="status-dot" />
      {labels[status] ?? status}
    </span>
  );
}
function Empty({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<View>("chat");
  const [data, setData] = useState<Data>(initialData);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [online, setOnline] = useState<boolean | null>(null);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [selectedArtifact, setSelectedArtifact] = useState<string | null>(null);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const refreshing = useRef(false);
  const messageRequest = useRef(0);
  const submittingRef = useRef(false);
  const submission = useRef<{
    conversationId: string;
    text: string;
    clientMessageId: string;
  } | null>(null);
  const selectedConversationRef = useRef<string | null>(conversationId);
  selectedConversationRef.current = conversationId;
  const mounted = useRef(true);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const currentConversation = data.conversations.find(
    (item) => item.id === conversationId,
  );
  const draftKey = conversationId ?? "new";
  const draft = drafts[draftKey] ?? "";
  const currentRun = data.runs.find(
    (item) => item.id === currentConversation?.activeRunId,
  );
  const activeRun =
    currentRun && !terminal(currentRun.status) ? currentRun : null;
  const isDemo =
    data.settings?.engine.mode === "demo" || data.health?.engine === "demo";

  const notify = useCallback(
    (text: string, error = false) => setNotice({ text, error }),
    [],
  );
  const refreshMessages = useCallback(async (id: string, signal?: AbortSignal) => {
    const request = ++messageRequest.current;
    const values = await api.messages(id, signal);
    if (mounted.current && !signal?.aborted && selectedConversationRef.current === id && request === messageRequest.current) {
      setMessages(values);
      setLoadingMessages(false);
    }
  }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const selectedId = selectedConversationRef.current;
      const [
        conversations,
        tasks,
        runs,
        approvals,
        artifacts,
        memories,
        health,
        settings,
      ] = await Promise.all([
        api.conversations(signal),
        api.tasks(signal),
        api.runs(signal),
        api.approvals(signal),
        api.artifacts(signal),
        api.memories(signal),
        api.health(signal),
        api.settings(signal).catch(() => null),
        selectedId ? refreshMessages(selectedId, signal) : Promise.resolve(),
      ]);
      if (mounted.current && !signal?.aborted) {
        setData({
          conversations,
          tasks,
          runs,
          approvals,
          artifacts,
          memories,
          health,
          settings,
        });
        setOnline(true);
      }
    } catch (error) {
      if (mounted.current && !signal?.aborted) {
        setOnline(false);
        if (error instanceof Error && error.name !== "AbortError")
          console.warn(error.message);
      }
    } finally {
      refreshing.current = false;
    }
  }, [refreshMessages]);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    const interval = window.setInterval(
      () => void refresh(controller.signal),
      2000,
    );
    const onFocus = () => void refresh(controller.signal);
    window.addEventListener("focus", onFocus);
    return () => {
      mounted.current = false;
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);
  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = window.setTimeout(() => setNotice(null), 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    setMessages([]);
    if (!conversationId) {
      setLoadingMessages(false);
      return;
    }
    const controller = new AbortController();
    setLoadingMessages(true);
    const fetchMessages = async () => {
      try {
        await refreshMessages(conversationId, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) {
          setLoadingMessages(false);
          if (error instanceof Error) notify(error.message, true);
        }
      }
    };
    void fetchMessages();
    return () => {
      controller.abort();
    };
  }, [conversationId, notify, refreshMessages]);
  useEffect(() => {
    if (!activeRun) return;
    const source = new EventSource(
      `/api/runs/${encodeURIComponent(activeRun.id)}/stream`,
    );
    const update = () => void refresh();
    for (const type of [
      "run.started",
      "assistant.text",
      "approval.requested",
      "approval.approved",
      "approval.rejected",
      "approval.expired",
      "run.cancelling",
      "run.cancelled",
      "run.completed",
      "run.failed",
      "run.interrupted",
      "artifact.created",
    ])
      source.addEventListener(type, update);
    source.onerror = () => {
      source.close();
      void refresh();
    };
    return () => source.close();
  }, [activeRun?.id, refresh]);
  useEffect(() => {
    const element = transcriptRef.current;
    if (
      element &&
      element.scrollHeight - element.scrollTop - element.clientHeight < 300
    )
      element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  }, [messages]);
  useEffect(() => {
    const el = composerRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
    }
  }, [draft, view]);

  const navigate = (next: View) => {
    setView(next);
    setSidebarOpen(false);
  };
  const selectConversation = (id: string | null) => {
    selectedConversationRef.current = id;
    messageRequest.current++;
    setConversationId(id);
    navigate("chat");
    setNotice(null);
  };
  const setDraft = (value: string) =>
    setDrafts((previous) => ({ ...previous, [draftKey]: value }));
  async function sendMessage(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || submittingRef.current || activeRun) return;
    submittingRef.current = true;
    setSubmitting(true);
    const submittedKey = draftKey;
    try {
      let targetId = conversationId;
      if (!targetId) {
        const created = await api.createConversation();
        targetId = created.id;
        if (selectedConversationRef.current === conversationId) {
          selectedConversationRef.current = targetId;
          setConversationId(targetId);
        }
        setDrafts((previous) => ({ ...previous, [targetId!]: text }));
      }
      if (
        !submission.current ||
        submission.current.conversationId !== targetId ||
        submission.current.text !== text
      )
        submission.current = {
          conversationId: targetId,
          text,
          clientMessageId: crypto.randomUUID(),
        };
      await api.submitMessage(
        targetId,
        text,
        submission.current.clientMessageId,
      );
      submission.current = null;
      setDrafts((previous) => ({
        ...previous,
        [submittedKey]:
          previous[submittedKey]?.trim() === text
            ? ""
            : (previous[submittedKey] ?? ""),
        [targetId!]:
          previous[targetId!]?.trim() === text
            ? ""
            : (previous[targetId!] ?? ""),
      }));
      await refreshMessages(targetId);
      await refresh();
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "发送失败，草稿已保留。",
        true,
      );
      await refresh();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }
  async function perform(
    key: string,
    action: () => Promise<unknown>,
    success?: string,
  ) {
    if (pending) return;
    setPending(key);
    try {
      await action();
      await refresh();
      if (success) notify(success);
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "操作没有完成，请重试。",
        true,
      );
      await refresh();
    } finally {
      setPending(null);
    }
  }
  const decide = (approval: Approval, allow: boolean) =>
    perform(
      approval.id,
      () => api.decide(approval.id, approval.hash, allow),
      allow ? "已允许这一次操作。" : "已拒绝这一次操作。",
    );
  const cancel = (run: Run) =>
    perform(
      "cancel:" + run.id,
      () => api.cancel(run.id),
      "已请求停止，正在等待执行确认。",
    );
  const restart = (task: Task) => {
    if (
      task.status === "interrupted" &&
      !window.confirm(
        "这次执行的外部结果可能未知。请先检查已生成的文件或外部操作，确认可以重新执行。是否继续？",
      )
    )
      return;
    void perform(
      "restart:" + task.id,
      () => api.restart(task.id),
      "已开始重新执行。",
    );
  };
  const goResult = (id: string) => {
    setSelectedArtifact(id);
    navigate("results");
  };
  const nav = [
    { id: "chat" as const, label: "对话", icon: MessageCircle },
    { id: "tasks" as const, label: "任务", icon: Square },
    { id: "results" as const, label: "成果", icon: FileText },
    { id: "memory" as const, label: "记忆", icon: BookOpen },
  ];
  const task = data.tasks.find((item) => item.id === selectedTask);
  const artifact =
    data.artifacts.find((item) => item.id === selectedArtifact) ??
    data.artifacts[0];

  return (
    <div className="app-shell">
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          aria-label="关闭导航"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className={`sidebar ${sidebarOpen ? "is-open" : ""}`}>
        <button
          className="brand"
          onClick={() => selectConversation(null)}
          aria-label="Kleio 新对话"
        >
          <Brand />
          <span>Kleio</span>
        </button>
        <button className="new-chat" onClick={() => selectConversation(null)}>
          <Plus size={17} />
          <span>新对话</span>
          <span className="shortcut" aria-hidden="true">
            +
          </span>
        </button>
        <nav aria-label="主要导航">
          {nav.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? "active" : ""}`}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
              {item.id === "tasks" &&
                data.runs.filter((run) => !terminal(run.status)).length > 0 && (
                  <span className="count">
                    {data.runs.filter((run) => !terminal(run.status)).length}
                  </span>
                )}
            </button>
          ))}
        </nav>
        <div className="conversation-nav">
          <div className="sidebar-label">最近对话</div>
          {data.conversations.length === 0 ? (
            <p className="sidebar-empty">从第一件想做的事开始。</p>
          ) : (
            data.conversations.slice(0, 20).map((item) => (
              <button
                className={`history-item ${view === "chat" && conversationId === item.id ? "selected" : ""}`}
                key={item.id}
                onClick={() => selectConversation(item.id)}
                title={item.title}
              >
                <span>{item.title}</span>
                {item.activeRunId && (
                  <span className="history-active" aria-label="执行中" />
                )}
              </button>
            ))
          )}
        </div>
        <div className="sidebar-bottom">
          <button
            className={`nav-item ${view === "settings" ? "active" : ""}`}
            onClick={() => navigate("settings")}
          >
            <Settings2 size={18} />
            <span>设置</span>
          </button>
          <div className="local-owner">
            <span className="owner-dot">K</span>
            <div>
              <strong>我的空间</strong>
              <small>数据保存在本机</small>
            </div>
          </div>
        </div>
      </aside>
      <main className={`workspace workspace-${view}`}>
        <header className="topbar">
          <div className="topbar-title">
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu size={20} />
            </button>
            <span>
              {view === "chat"
                ? (currentConversation?.title ?? "新对话")
                : (
                    {
                      tasks: "任务",
                      results: "成果",
                      memory: "记忆",
                      settings: "设置",
                    } as const
                  )[view]}
            </span>
          </div>
          <button
            className={`engine-indicator ${online === false ? "offline" : ""}`}
            onClick={() => navigate("settings")}
          >
            <span className="engine-dot" />
            {online === false
              ? "服务未连接"
              : online === null
                ? "连接中"
                : isDemo
                  ? "演示模式"
                  : data.settings?.runtime.status === "missing"
                    ? "模型待配置"
                    : data.settings?.runtime.status === "ready"
                      ? "模型已配置"
                      : "状态待检查"}
            <ChevronRight size={13} />
          </button>
        </header>
        {online === false && (
          <div className="connection-banner" role="alert">
            <CircleAlert size={16} />
            <span>本地服务暂时不可用。数据和草稿会保留。</span>
            <button onClick={() => void refresh()}>重新连接</button>
          </div>
        )}
        {notice && (
          <div
            className={`notice ${notice.error ? "error" : ""}`}
            role={notice.error ? "alert" : "status"}
          >
            <span>{notice.text}</span>
            <button
              className="icon-button"
              aria-label="关闭提示"
              onClick={() => setNotice(null)}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {view === "chat" && (
          <section className="chat-surface">
            <div className="transcript" ref={transcriptRef}>
              <div className="transcript-inner">
                {!conversationId && (
                  <div className="welcome">
                    <Brand large />
                    <h1>把想做的事，交给我。</h1>
                    <p>
                      我们一起理清思路、推进任务，
                      <br className="mobile-break" />
                      也记住对你重要的偏好。
                    </p>
                    <div className="starter-prompts">
                      {[
                        "帮我把今天要做的事整理成计划",
                        "一起梳理我最近的一个想法",
                        "帮我整理一份任务清单",
                      ].map((prompt) => (
                        <button
                          key={prompt}
                          onClick={() => {
                            setDraft(prompt);
                            composerRef.current?.focus();
                          }}
                        >
                          <span>{prompt}</span>
                          <ArrowUpRight size={16} />
                        </button>
                      ))}
                    </div>
                    {isDemo && (
                      <p className="welcome-mode">
                        当前是演示模式：可体验完整流程，真实模型尚未启用。
                      </p>
                    )}
                  </div>
                )}
                {conversationId && loadingMessages && (
                  <div className="loading-state">
                    <LoaderCircle size={18} className="spin" />
                    正在打开对话…
                  </div>
                )}
                {conversationId &&
                  !loadingMessages &&
                  messages.length === 0 && (
                    <Empty
                      icon={<MessageCircle size={24} />}
                      title="对话已经准备好"
                    >
                      告诉我你想做什么，我们从这里开始。
                    </Empty>
                  )}
                {messages.map((message) => {
                  const run = data.runs.find(
                    (item) => item.id === message.runId,
                  );
                  const result = data.artifacts.find(
                    (item) => item.runId === message.runId,
                  );
              const request = data.approvals.filter(
                    (item) =>
                      item.runId === message.runId && item.status === "pending",
              );
              const syncingResult = message.role === "assistant" && run && terminal(run.status) && message.status !== run.status;
                  return (
                    <article
                      className={`message message-${message.role}`}
                      key={message.id}
                    >
                      {message.role === "assistant" && (
                        <div className="assistant-label">
                          <Brand />
                          <strong>Kleio</strong>
                          <span>
                            {run?.engine === "demo"
                              ? "演示助理"
                              : run
                                ? "个人助理"
                                : "执行记录"}
                          </span>
                        </div>
                      )}
                      <div className="message-content">
                        {syncingResult ? (
                          <span className="thinking"><LoaderCircle size={15} className="spin" />正在同步最终结果…</span>
                        ) : message.content ? (
                          <Markdown>{message.content}</Markdown>
                        ) : (
                          <span className="thinking">
                            <LoaderCircle size={15} className="spin" />
                            {run?.status === "waiting_approval"
                              ? "执行前，需要你确认。"
                              : run?.status === "cancelling"
                                ? "正在等待停止确认…"
                                : run && terminal(run.status)
                                  ? "本次执行没有留下回复。"
                                  : "正在准备回复…"}
                          </span>
                        )}
                      </div>
                      {message.role === "assistant" && run && (
                        <>
                          <div className="message-meta">
                            <Status status={run.status} />
                            <time dateTime={message.createdAt}>
                              {time(message.createdAt)}
                            </time>
                            {!terminal(run.status) &&
                              run.status !== "cancelling" && (
                                <button
                                  className="text-button"
                                  disabled={pending !== null}
                                  onClick={() => void cancel(run)}
                                >
                                  <Square size={12} />
                                  停止
                                </button>
                              )}
                            {result && (
                              <button
                                className="text-button"
                                onClick={() => goResult(result.id)}
                              >
                                <FileText size={13} />
                                查看成果
                                <ChevronRight size={12} />
                              </button>
                            )}
                          </div>
                          {run.error && (
                            <div className="run-error">
                              <CircleAlert size={15} />
                              <div>
                                {run.error}
                                {run.status === "interrupted" && (
                                  <p>
                                    先检查已有成果和外部操作，再决定是否重新执行。
                                  </p>
                                )}
                              </div>
                            </div>
                          )}
                          {request.map((approval) => (
                            <ApprovalPanel
                              key={approval.id}
                              approval={approval}
                              pending={pending !== null}
                              onDecision={(allow) =>
                                void decide(approval, allow)
                              }
                            />
                          ))}
                          {["failed", "cancelled", "interrupted"].includes(
                            run.status,
                          ) && (
                            <button
                              className="text-button retry-message"
                              disabled={pending !== null}
                              onClick={() => {
                                const linkedTask = data.tasks.find(
                                  (item) => item.id === run.taskId,
                                );
                                if (linkedTask) restart(linkedTask);
                              }}
                            >
                              <RotateCcw size={14} />
                              {run.status === "interrupted"
                                ? "检查后重新执行"
                                : "重新执行这项任务"}
                            </button>
                          )}
                        </>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>
            <div className="composer-area">
              <form
                className="composer"
                onSubmit={(event) => void sendMessage(event)}
              >
                <textarea
                  ref={composerRef}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  rows={2}
                  maxLength={12000}
                  aria-label="告诉 Kleio 你想做什么"
                  placeholder="告诉我，你想做什么…"
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.shiftKey &&
                      !event.nativeEvent.isComposing &&
                      event.keyCode !== 229
                    ) {
                      event.preventDefault();
                      void sendMessage();
                    }
                  }}
                />
                <div className="composer-bottom">
                  <span>
                    {activeRun
                      ? activeRun.status === "cancelling"
                        ? "确认停止后，可以继续对话"
                        : "任务进行中，你可以先准备下一条消息"
                      : "Enter 发送 · Shift + Enter 换行"}
                  </span>
                  <button
                    className="send-button"
                    type="submit"
                    aria-label="发送消息"
                    disabled={
                      !draft.trim() ||
                      submitting ||
                      !!activeRun ||
                      online !== true
                    }
                  >
                    {submitting ? (
                      <LoaderCircle size={19} className="spin" />
                    ) : (
                      <ArrowUp size={20} />
                    )}
                  </button>
                </div>
              </form>
              <div className="composer-note">
                {isDemo
                  ? "演示模式不调用真实模型。可在设置中接入 dsh。"
                  : "重要操作会先征求你的许可。请核对关键结果。"}
              </div>
            </div>
          </section>
        )}
        {view === "tasks" && (
          <section className="section-page">
            <div className="page-heading">
              <h1>事情，有迹可循。</h1>
              <p>查看进行中的任务，也可以回到之前的工作。</p>
            </div>
            {data.tasks.length === 0 ? (
              <Empty icon={<Square size={24} />} title="还没有任务">
                在对话里提出一件事，进展就会出现在这里。
              </Empty>
            ) : (
              <div className="split-surface">
                <div className="item-list">
                  {data.tasks.map((item) => (
                    <button
                      key={item.id}
                      className={`list-item ${selectedTask === item.id ? "selected" : ""}`}
                      onClick={() => setSelectedTask(item.id)}
                    >
                      <div>
                        <strong>{item.title}</strong>
                        <time>{time(item.updatedAt)}</time>
                      </div>
                      <Status status={item.status} />
                      <ChevronRight size={15} />
                    </button>
                  ))}
                </div>
                <div className="detail-pane">
                  {task ? (
                    <>
                      <h2>{task.title}</h2>
                      <p className="task-prompt">{task.prompt}</p>
                      <div className="detail-meta">
                        <Status status={task.status} />
                        <span>{time(task.createdAt)} 创建</span>
                      </div>
                      {data.runs
                        .filter((run) => run.taskId === task.id)
                        .map((run) => (
                          <div className="run-detail" key={run.id}>
                            <div>
                              <Status status={run.status} />
                              <time>{time(run.createdAt)}</time>
                            </div>
                            {run.error && (
                              <p className="inline-error">{run.error}</p>
                            )}
                            {run.status === "interrupted" && (
                              <p>
                                外部操作的结果可能未知。请检查已有输出后，再重新执行。
                              </p>
                            )}
                            {data.approvals
                              .filter(
                                (item) =>
                                  item.runId === run.id &&
                                  item.status === "pending",
                              )
                              .map((approval) => (
                                <ApprovalPanel
                                  key={approval.id}
                                  approval={approval}
                                  pending={pending !== null}
                                  onDecision={(allow) =>
                                    void decide(approval, allow)
                                  }
                                />
                              ))}
                            {!terminal(run.status) &&
                              run.status !== "cancelling" && (
                                <button
                                  className="button secondary"
                                  disabled={pending !== null}
                                  onClick={() => void cancel(run)}
                                >
                                  <Square size={14} />
                                  停止执行
                                </button>
                              )}
                            {data.artifacts
                              .filter((item) => item.runId === run.id)
                              .map((item) => (
                                <button
                                  className="result-link"
                                  key={item.id}
                                  onClick={() => goResult(item.id)}
                                >
                                  <FileText size={18} />
                                  <span>{item.title}</span>
                                  <ArrowUpRight size={16} />
                                </button>
                              ))}
                          </div>
                        ))}
                      <div className="detail-actions">
                        {["failed", "cancelled", "interrupted"].includes(
                          task.status,
                        ) && (
                          <button
                            className="button primary"
                            disabled={pending !== null}
                            onClick={() => restart(task)}
                          >
                            <RotateCcw size={15} />
                            {task.status === "interrupted"
                              ? "检查后重新执行"
                              : "重新执行"}
                          </button>
                        )}
                        {task.conversationId && (
                          <button
                            className="button secondary"
                            onClick={() =>
                              selectConversation(task.conversationId)
                            }
                          >
                            <MessageCircle size={15} />
                            回到对话
                          </button>
                        )}
                      </div>
                    </>
                  ) : (
                    <Empty icon={<History size={24} />} title="选择一项任务">
                      这里会显示执行记录、许可和成果。
                    </Empty>
                  )}
                </div>
              </div>
            )}
          </section>
        )}
        {view === "results" && (
          <section className="section-page">
            <div className="page-heading">
              <h1>留下有用的成果。</h1>
              <p>每一份成果，都能回到它的任务和对话。</p>
            </div>
            {data.artifacts.length === 0 ? (
              <Empty icon={<FileText size={26} />} title="第一份成果，等你开始">
                任务完成后，保存的内容会出现在这里。
              </Empty>
            ) : (
              <div className="split-surface results-split">
                <div className="item-list">
                  {data.artifacts.map((item) => (
                    <button
                      key={item.id}
                      className={`list-item ${artifact?.id === item.id ? "selected" : ""}`}
                      onClick={() => setSelectedArtifact(item.id)}
                    >
                      <FileText size={18} />
                      <div>
                        <strong>{item.title}</strong>
                        <time>{time(item.createdAt)}</time>
                      </div>
                      <ChevronRight size={15} />
                    </button>
                  ))}
                </div>
                {artifact && (
                  <ArtifactView
                    artifact={artifact}
                    task={data.tasks.find(
                      (item) =>
                        item.currentRunId === artifact.runId ||
                        data.runs.some(
                          (run) =>
                            run.id === artifact.runId && run.taskId === item.id,
                        ),
                    )}
                    isDemo={
                      data.runs.find((run) => run.id === artifact.runId)
                        ?.engine === "demo"
                    }
                    onCopy={notify}
                    onConversation={selectConversation}
                  />
                )}
              </div>
            )}
          </section>
        )}
        {view === "memory" && (
          <MemoryView
            memories={data.memories}
            refresh={refresh}
            notify={notify}
          />
        )}
        {view === "settings" && (
          <SettingsView
            settings={data.settings}
            health={data.health}
            online={online}
            refresh={refresh}
          />
        )}
      </main>
    </div>
  );
}

function ApprovalPanel({
  approval,
  pending,
  onDecision,
}: {
  approval: Approval;
  pending: boolean;
  onDecision: (allow: boolean) => void;
}) {
  const payload = approval.payload;
  const title = typeof payload.title === "string" && payload.title.trim()
    ? payload.title : approval.kind === "demo.review" ? "确认这项演示任务" : "允许助理执行这项操作";
  const description = typeof payload.description === "string" ? payload.description
    : "助理准备执行下面的操作，请核对内容后决定是否允许。";
  const fieldLabels: Record<string, string> = { command: "执行命令", script: "执行内容", path: "文件路径", filePath: "文件路径", filename: "文件名", content: "写入内容", text: "内容", url: "访问地址", query: "查询内容", cwd: "工作目录", timeout: "等待时长", timeoutMs: "等待时长（毫秒）" };
  const rawInput = payload.rawInput;
  const fields = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
    ? Object.entries(rawInput as Record<string, unknown>) : [];
  const valueText = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <section className="approval-panel" aria-label="操作许可">
      <div className="approval-heading">
        <ShieldCheck size={20} />
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
      </div>
      {typeof payload.requestedResult === "string" && <div className="approval-request"><strong>待执行的任务</strong><p>{payload.requestedResult}</p></div>}
      {typeof rawInput === "string" && <div className="approval-request"><strong>待执行内容</strong><pre>{rawInput}</pre></div>}
      {fields.length > 0 && <dl className="approval-fields">{fields.map(([key, value]) => <div key={key}><dt>{fieldLabels[key] ?? key}</dt><dd><pre>{valueText(value)}</pre></dd></div>)}</dl>}
      <p className="approval-once">允许后只执行这一次操作。</p>
      <details className="approval-raw"><summary>查看准确的原始参数</summary><pre className="approval-parameters">{JSON.stringify(approval.payload, null, 2)}</pre></details>
      <div className="approval-actions">
        <button
          className="button primary"
          disabled={pending}
          onClick={() => onDecision(true)}
        >
          <Check size={15} />
          允许这一次
        </button>
        <button
          className="button secondary"
          disabled={pending}
          onClick={() => onDecision(false)}
        >
          拒绝
        </button>
        <span>{time(approval.expiresAt)} 到期</span>
      </div>
    </section>
  );
}

function ArtifactView({
  artifact,
  task,
  isDemo,
  onCopy,
  onConversation,
}: {
  artifact: Artifact;
  task: Task | undefined;
  isDemo: boolean;
  onCopy: (text: string, error?: boolean) => void;
  onConversation: (id: string | null) => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(artifact.content);
      setCopied(true);
      onCopy("成果已复制。");
    } catch {
      onCopy("无法访问剪贴板，可以选择正文复制，或下载文件。", true);
    }
  };
  return (
    <article className="detail-pane artifact-view">
      <div className="artifact-heading">
        <div>
          <h2>{artifact.title}</h2>
          <p>
            {time(artifact.createdAt)}
            {isDemo ? " · 演示成果" : ""}
          </p>
        </div>
        <div className="artifact-tools">
          <button
            className="icon-button"
            title="复制成果"
            aria-label="复制成果"
            onClick={() => void copy()}
          >
            {copied ? <Check size={18} /> : <Clipboard size={18} />}
          </button>
          <a
            className="icon-button"
            title="下载 Markdown"
            aria-label="下载 Markdown"
            href={`/api/artifacts/${encodeURIComponent(artifact.id)}/download`}
            download
          >
            <ArrowDownToLine size={18} />
          </a>
        </div>
      </div>
      {task && (
        <button
          className="artifact-source"
          disabled={!task.conversationId}
          onClick={() => onConversation(task.conversationId)}
        >
          <MessageCircle size={14} />
          <span>{task.title}</span>
          {task.conversationId && <ArrowUpRight size={14} />}
        </button>
      )}
      <Markdown>{artifact.content}</Markdown>
    </article>
  );
}

function MemoryView({
  memories,
  refresh,
  notify,
}: {
  memories: Memory[];
  refresh: () => Promise<void>;
  notify: (text: string, error?: boolean) => void;
}) {
  const [editing, setEditing] = useState<Memory | "new" | null>(null);
  const [text, setText] = useState("");
  const [source, setSource] = useState("我主动告诉 Kleio");
  const [saving, setSaving] = useState(false);
  const [lastChange, setLastChange] = useState<Memory | null>(null);
  const [history, setHistory] = useState<{
    id: string;
    revisions: MemoryRevision[];
  } | null>(null);
  const [historyLoading, setHistoryLoading] = useState<string | null>(null);
  const activeHistory = useRef(0);
  useEffect(
    () => () => {
      activeHistory.current++;
    },
    [],
  );
  const startEdit = (memory: Memory | "new") => {
    setEditing(memory);
    setText(memory === "new" ? "" : memory.text);
    setSource(memory === "new" ? "我主动告诉 Kleio" : memory.source);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing || saving || !text.trim() || !source.trim()) return;
    setSaving(true);
    try {
      const result =
        editing === "new"
          ? await api.addMemory(text.trim(), source.trim())
          : await api.editMemory(editing, text.trim(), source.trim());
      setLastChange(editing === "new" ? null : result);
      setEditing(null);
      await refresh();
      notify("记忆已保存。之后的任务会按需读取。");
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "保存失败，内容已保留。",
        true,
      );
      await refresh();
    } finally {
      setSaving(false);
    }
  };
  const remove = async (memory: Memory) => {
    if (saving) return;
    setSaving(true);
    try {
      setLastChange(await api.deleteMemory(memory));
      await refresh();
      notify("记忆已删除，可以撤销。");
    } catch (error) {
      notify(error instanceof Error ? error.message : "删除失败。", true);
      await refresh();
    } finally {
      setSaving(false);
    }
  };
  const undo = async () => {
    if (!lastChange || saving) return;
    setSaving(true);
    try {
      await api.undoMemory(lastChange);
      setLastChange(null);
      await refresh();
      notify("已撤销这次记忆变更。");
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "无法撤销。请检查当前版本。",
        true,
      );
      await refresh();
    } finally {
      setSaving(false);
    }
  };
  const showHistory = async (memory: Memory) => {
    const token = ++activeHistory.current;
    if (history?.id === memory.id) {
      setHistory(null);
      return;
    }
    setHistoryLoading(memory.id);
    try {
      const revisions = await api.memoryHistory(memory.id);
      if (token === activeHistory.current)
        setHistory({ id: memory.id, revisions });
    } catch (error) {
      notify(
        error instanceof Error ? error.message : "历史暂时无法读取。",
        true,
      );
    } finally {
      if (token === activeHistory.current) setHistoryLoading(null);
    }
  };
  return (
    <section className="section-page memory-page">
      <div className="page-heading with-action">
        <div>
          <h1>记住你，听你纠正。</h1>
          <p>明确保存的偏好与事实。每条都有来源，随时可以修改。</p>
        </div>
        <button
          className="button primary"
          onClick={() => startEdit("new")}
          disabled={saving}
        >
          <Plus size={16} />
          添加记忆
        </button>
      </div>
      <p className="memory-explanation">
        <BookOpen size={16} />
        当前根据中文词汇匹配召回，不会自动把每段对话写入记忆。
      </p>
      {lastChange && (
        <div className="undo-banner">
          <span>刚刚{lastChange.deleted ? "删除" : "修改"}了一条记忆。</span>
          <button
            className="text-button"
            disabled={saving}
            onClick={() => void undo()}
          >
            <RotateCcw size={14} />
            撤销
          </button>
          <button
            className="icon-button"
            aria-label="关闭撤销提示"
            onClick={() => setLastChange(null)}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {editing && (
        <form className="memory-form" onSubmit={(event) => void save(event)}>
          <div className="form-heading">
            <h2>
              {editing === "new" ? "告诉我一件值得记住的事" : "修改这条记忆"}
            </h2>
            <button
              className="icon-button"
              type="button"
              aria-label="关闭记忆编辑"
              disabled={saving}
              onClick={() => setEditing(null)}
            >
              <X size={18} />
            </button>
          </div>
          <label>
            记忆内容
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="例如：我更喜欢用中文交流，回复尽量简洁。"
              rows={3}
              maxLength={4000}
              required
            />
          </label>
          <label>
            来源
            <input
              value={source}
              onChange={(event) => setSource(event.target.value)}
              maxLength={1000}
              required
            />
          </label>
          <div className="form-actions">
            <button
              className="button primary"
              type="submit"
              disabled={saving || !text.trim() || !source.trim()}
            >
              {saving ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <Check size={15} />
              )}
              保存记忆
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={saving}
              onClick={() => setEditing(null)}
            >
              取消
            </button>
          </div>
        </form>
      )}
      {memories.length === 0 && !editing ? (
        <Empty icon={<BookOpen size={26} />} title="从一件重要的小事开始">
          你的习惯、偏好，或希望助理始终考虑的事实。
        </Empty>
      ) : (
        <div className="memory-list">
          {memories
            .filter((memory) => !memory.deleted)
            .map((memory) => (
              <article className="memory-entry" key={memory.id}>
                <p>{memory.text}</p>
                <div className="memory-meta">
                  <span>来源：{memory.source}</span>
                  <time>{time(memory.updatedAt)}</time>
                </div>
                <div className="memory-actions">
                  <button
                    className="text-button"
                    disabled={saving}
                    onClick={() => startEdit(memory)}
                  >
                    <Pencil size={14} />
                    修改
                  </button>
                  <button
                    className="text-button"
                    onClick={() => void showHistory(memory)}
                    disabled={historyLoading === memory.id}
                  >
                    {historyLoading === memory.id ? (
                      <LoaderCircle size={14} className="spin" />
                    ) : (
                      <History size={14} />
                    )}
                    历史
                  </button>
                  <button
                    className="text-button danger"
                    disabled={saving}
                    onClick={() => void remove(memory)}
                  >
                    <Trash2 size={14} />
                    删除
                  </button>
                </div>
                {history?.id === memory.id && (
                  <ol className="memory-history">
                    {[...history.revisions].reverse().map((item) => (
                      <li key={item.memory.version}>
                        <div>
                          <strong>版本 {item.memory.version}</strong>
                          <span>
                            {item.memory.deleted
                              ? "已删除"
                              : item.reason === "undo"
                                ? "撤销变更"
                                : "已保存"}{" "}
                            · {time(item.memory.updatedAt)}
                          </span>
                        </div>
                        <p>{item.memory.text}</p>
                        <small>来源：{item.memory.source}</small>
                      </li>
                    ))}
                  </ol>
                )}
              </article>
            ))}
        </div>
      )}
    </section>
  );
}

function SettingsView({
  settings,
  health,
  online,
  refresh,
}: {
  settings: Settings | null;
  health: Health | null;
  online: boolean | null;
  refresh: () => Promise<void>;
}) {
  const isDemo = settings?.engine.mode === "demo" || health?.engine === "demo";
  return (
    <section className="section-page settings-page">
      <div className="page-heading">
        <h1>让助理按你的方式工作。</h1>
        <p>当前版本在本机运行，连接状态和数据归属在这里看清。</p>
      </div>
      <div className="settings-section">
        <h2>执行引擎</h2>
        <div className="setting-row">
          <div>
            <strong>
              {settings?.engine.label ??
                (isDemo ? "演示引擎" : (health?.engine ?? "正在连接"))}
            </strong>
            <p>
              {settings?.runtime.note ??
                (isDemo
                  ? "使用确定性回复展示任务、许可与成果流程，不调用真实模型。"
                  : "接入 dsh 后，仍需配置真实模型提供方。")}
            </p>
          </div>
          <span
            className={`status ${online === false ? "status-failed" : "status-completed"}`}
          >
            <span className="status-dot" />
            {online === false
              ? "未连接"
              : isDemo
                ? "演示模式"
                : settings?.runtime.status === "missing"
                  ? "待配置"
                  : settings?.runtime.status === "ready"
                    ? "配置完整"
                    : "待检查"}
          </span>
        </div>
        {settings?.runtime.missing && settings.runtime.missing.length > 0 && (
          <p className="inline-error">
            待配置：{settings.runtime.missing.join("、")}
          </p>
        )}
        <button className="button secondary" onClick={() => void refresh()}>
          <RotateCcw size={15} />
          刷新连接状态
        </button>
      </div>
      <div className="settings-section">
        <h2>接入真实模型</h2>
        <p>
          停止本地服务，在项目的 <code>.env</code>{" "}
          中填入模型配置，再重新启动。已安装的 dsh 会自动接入。
        </p>
        <pre className="setup-code">
          {[
            "AGENT_ENGINE=dsh",
            "KLEIO_MODEL_BASE_URL=模型接口地址",
            "KLEIO_MODEL_ID=模型名称",
            "KLEIO_MODEL_API_KEY=你的密钥",
          ].join(String.fromCharCode(10))}
        </pre>
        <p>
          dsh
          的模型地址、模型名称和密钥由其配置管理。这里不会展示凭据内容。连接成功只表示运行环境可用，首次任务仍需确认实际模型效果。
        </p>
        {settings?.setup && (
          <details className="setup-details">
            <summary>查看当前接入说明</summary>
            <ol>
              {settings.setup.instructions.map((instruction) => (
                <li key={instruction}>{instruction}</li>
              ))}
            </ol>
          </details>
        )}
      </div>
      <div className="settings-section">
        <h2>你的数据</h2>
        <dl className="settings-facts">
          <div>
            <dt>对话、任务与成果</dt>
            <dd>保存在本机服务的数据库中</dd>
          </div>
          <div>
            <dt>个人记忆</dt>
            <dd>由你明确添加，可修改、删除、撤销</dd>
          </div>
          <div>
            <dt>执行权限</dt>
            <dd>需要许可的操作会逐次征求你的确认</dd>
          </div>
          <div>
            <dt>客户端</dt>
            <dd>当前为网页；桌面应用将复用同一内核</dd>
          </div>
        </dl>
      </div>
      <footer className="settings-footer">
        <Brand />
        <span>Kleio 0.1 · 你的个人助理</span>
      </footer>
    </section>
  );
}
