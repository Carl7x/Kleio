import {
  ArrowRight,
  Bell,
  CalendarDays,
  ChevronRight,
  CircleDollarSign,
  FileText,
  Globe2,
  Heart,
  Lightbulb,
  ListChecks,
  Mail,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Square,
  Target,
  Users,
  X,
} from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, Linking, Pressable, Text, View } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import type { Artifact, BrowserSession } from "../../../packages/openmuse-domain/src";
import type {
  AgentArtifact,
  AgentMemory,
  AgentTask,
  Evidence,
  Goal,
  Idea,
  Monitor,
  RunEvent,
} from "../../../packages/openmuse-domain/src/agent";
import { useAgentWorkspace } from "./agent-workspace";
import { QuietDots, StreamCard } from "./chat-stream";
import { ActivityScreen, ConnectionsScreen } from "./screens";
import {
  Button,
  Card,
  CheckRow,
  Chip,
  colors,
  Empty,
  ErrorNotice,
  Field,
  LinkRow,
  Mascot,
  resultSummary,
  SectionHeading,
  Sheet,
  s,
} from "./ui";
import { useWorkspace } from "./workspace";

const STATUS_ZH: Record<string, string> = {
  warm: "温暖",
  concise: "简洁",
  thoughtful: "周到",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  canceled: "已取消",
  running: "进行中",
  pending: "待处理",
  waiting: "等待中",
  queued: "排队中",
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
  scheduled: "已安排",
  review: "待审阅",
  needs_input: "需补充",
  in_progress: "进行中",
};
export function statusLabel(value: string) {
  if (STATUS_ZH[value]) return STATUS_ZH[value];
  const key = value.replace(/\s+/g, "_").toLowerCase();
  if (STATUS_ZH[key]) return STATUS_ZH[key];
  return value.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}
function stamp(value?: string) {
  return value
    ? new Date(value).toLocaleString("zh-CN", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "尚未检查";
}
function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
function activeTask(task: AgentTask) {
  return !["succeeded", "failed", "cancelled"].includes(task.status);
}
export function AgentStatus() {
  const { data, error, refresh } = useAgentWorkspace();
  if (data?.worker.running && !error) return null;
  return (
    <View style={{ gap: 8 }}>
      <ErrorNotice error={error ? `智能体更新不可用。${error}` : ""} />
      {!!error && (
        <Button small onPress={() => void refresh().catch(() => {})}>
          重新连接智能体
        </Button>
      )}
      {!data && !error && <QuietDots label="正在连接 Kleio" />}
      {data && !data.worker.running && (
        <StreamCard
          state="paused"
          title="工作进程离线"
          detail="已保存的工作会在重连后继续。"
        />
      )}
    </View>
  );
}
export function TaskCard({
  task,
  compact = false,
  onOpen,
}: {
  task: AgentTask;
  compact?: boolean;
  onOpen?: () => void;
}) {
  const { open } = useWorkspace();
  const done = task.plan.filter((step) => step.status === "succeeded").length;
  const next = task.plan.find((step) => ["running", "waiting"].includes(step.status));
  const waiting = ["waiting_input", "waiting_approval"].includes(task.status);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`打开任务：${task.title}`}
      onPress={() => {
        onOpen?.();
        open({ type: "task", taskId: task.id });
      }}
    >
      <Card
        style={{
          padding: compact ? 15 : 20,
          gap: 11,
          borderRadius: 22,
          backgroundColor: "#F0F1F2",
        }}
      >
        <View style={[s.row, { gap: 10 }]}>
          <View
            style={[
              s.iconBox,
              { width: 34, height: 34, backgroundColor: waiting ? colors.orange : colors.sky },
            ]}
          >
            <ListChecks size={18} color={colors.blueDark} />
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={s.heading}>{task.title}</Text>
            <Text style={s.small}>
              {statusLabel(task.status)}
              {task.plan.length ? ` · ${done}/${task.plan.length} 步` : ""}
            </Text>
          </View>
          <ChevronRight size={17} color={colors.muted} />
        </View>
        {!!task.plan.length && (
          <View style={{ height: 4, backgroundColor: colors.line, borderRadius: 4 }}>
            <View
              style={{
                height: 4,
                width: `${Math.round((done / task.plan.length) * 100)}%`,
                backgroundColor: "#6AAEE0",
                borderRadius: 4,
              }}
            />
          </View>
        )}
        {(task.question || task.result || task.error || next?.title) && (
          <Text numberOfLines={compact ? 2 : 4} style={s.muted}>
            {task.question || task.error || resultSummary(task.result || next?.title || "")}
          </Text>
        )}
        {waiting && (
          <View style={[s.chip, { backgroundColor: colors.orange }]}>
            <Text style={[s.chipText, { color: "#6B4A1B" }]}>
              {task.status === "waiting_approval" ? "待你审阅" : "需要你补充"}
            </Text>
          </View>
        )}
      </Card>
    </Pressable>
  );
}
export function ChatWork() {
  const { data } = useAgentWorkspace();
  const tasks = [...(data?.tasks || [])]
    .filter(activeTask)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 2);
  if (!tasks.length) return null;
  return (
    <View style={{ gap: 10 }}>
      {tasks.map((task) => (
        <TaskCard task={task} key={task.id} compact />
      ))}
    </View>
  );
}
export function AgentActivityScreen() {
  const { data } = useAgentWorkspace();
  const [filter, setFilter] = useState("全部");
  const tasks = [...(data?.tasks || [])]
    .filter(
      (task) =>
        filter === "全部" || (filter === "进行中" ? activeTask(task) : !activeTask(task)),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return (
    <View style={{ gap: 20 }}>
      <AgentStatus />
      <View style={[s.row, { gap: 8 }]}>
        {["全部", "进行中", "已完成"].map((item) => (
          <Button key={item} small primary={filter === item} onPress={() => setFilter(item)}>
            {item}
          </Button>
        ))}
      </View>
      {tasks.map((task) => (
        <TaskCard key={task.id} task={task} />
      ))}
      {!tasks.length && (
        <Empty
          icon={ListChecks}
          title="工作落脚处"
          detail="在对话中委托任务。计划、进展与结果会留在这里。"
        />
      )}
      <SectionHeading title="审阅与回执" />
      <ActivityScreen />
    </View>
  );
}
export function EvidenceList({ items }: { items: Evidence[] }) {
  const { workspace, open } = useWorkspace();
  const [error, setError] = useState("");
  return (
    <View style={{ gap: 10 }}>
      {items.map((item) => (
        <View
          key={item.id}
          style={{ borderLeftWidth: 2, borderLeftColor: colors.blue, paddingLeft: 12, gap: 4 }}
        >
          <Text style={[s.small, { color: colors.text, fontWeight: "600" }]}>{item.title}</Text>
          <Text selectable style={s.small}>
            {item.excerpt}
          </Text>
          {item.url && /^https?:\/\//i.test(item.url) && (
            <Button
              small
              onPress={() =>
                void Linking.openURL(item.url || "").catch((e) => setError(errorText(e)))
              }
            >
              打开来源
            </Button>
          )}
          {item.kind === "mail" && workspace.mail.some((mail) => mail.id === item.id) && (
            <Button
              small
              onPress={() => {
                const mail = workspace.mail.find((m) => m.id === item.id);
                if (mail) open({ type: "mail", mail });
              }}
            >
              查看邮件
            </Button>
          )}
          {item.kind === "file" && workspace.files.some((file) => file.id === item.id) && (
            <Button
              small
              onPress={() => {
                const file = workspace.files.find((f) => f.id === item.id);
                if (file) open({ type: "file", file });
              }}
            >
              查看文件
            </Button>
          )}
        </View>
      ))}
      <ErrorNotice error={error} />
    </View>
  );
}
export function TaskDetail({ taskId }: { taskId: string }) {
  const { api, workspace, close, open, refresh: refreshWorkspace } = useWorkspace();
  const { data, mutate } = useAgentWorkspace();
  const capabilities = workspace.runtime.capabilities;
  const [detail, setDetail] = useState<{
    task: AgentTask;
    events: RunEvent[];
    artifacts: AgentArtifact[];
    files: Artifact[];
    browsers: BrowserSession[];
  }>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState("");
  const [fieldJson, setFieldJson] = useState("");
  const [showFieldJson, setShowFieldJson] = useState(false);
  const [fields, setFields] = useState<Record<string, string | boolean>>({});
  const task = data?.tasks.find((item) => item.id === taskId) || detail?.task;
  const milestone = data?.goals
    .find((goal) => goal.id === task?.goalId)
    ?.milestones.find((item) => item.id === task?.milestoneId);
  useEffect(() => {
    let active = true;
    void api
      .request<{
        task: AgentTask;
        events: RunEvent[];
        artifacts: AgentArtifact[];
        files: Artifact[];
        browsers: BrowserSession[];
      }>(`/api/agent/tasks/${taskId}`)
      .then((result) => {
        if (active) {
          setDetail(result);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [api, taskId, task?.updatedAt]);
  async function act(path: string, body: unknown) {
    const action = (body as { action?: string }).action;
    const supportedControl =
      action === "cancel"
        ? capabilities?.taskCancel
        : action === "pause"
          ? capabilities?.taskPause
          : action === "resume"
            ? capabilities?.taskResume
            : capabilities?.taskRetry;
    if (path === "control" && !supportedControl) return;
    if (path === "input" && !capabilities?.taskInput) return;
    setBusy(true);
    setError("");
    try {
      await mutate(`/tasks/${taskId}/${path}`, body);
      if (path === "input") {
        setAnswer("");
        setFields({});
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function submitInput() {
    try {
      let parsed: Record<string, string | boolean> = fields;
      if (fieldJson.trim()) {
        const raw: unknown = JSON.parse(fieldJson);
        if (
          !raw ||
          typeof raw !== "object" ||
          Array.isArray(raw) ||
          Object.values(raw).some(
            (value) => typeof value !== "string" && typeof value !== "boolean",
          )
        )
          throw new Error("表单字段须为 JSON 对象，值为文本或 true/false。");
        parsed = raw as Record<string, string | boolean>;
      }
      await act("input", {
        answer: answer.trim() || "已提供所需字段。",
        fields: parsed,
      });
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function review() {
    setBusy(true);
    setError("");
    try {
      await refreshWorkspace();
      const snapshot = await api.request<typeof workspace>("/api/workspace");
      const action = snapshot.actions.find((item) => item.id === task?.actionId);
      if (!action) throw new Error("审阅尚未就绪。请刷新后再试。");
      open({ type: "review", action });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const missing = Array.isArray(task?.state.missingFields) ? task.state.missingFields : [];
  const fieldNames = missing
    .map((field) =>
      typeof field === "string"
        ? field
        : typeof field === "object" && field && "name" in field
          ? String(field.name)
          : "",
    )
    .filter(Boolean);
  return (
    <Sheet
      title={task?.title || "任务"}
      subtitle={
        task ? `${statusLabel(task.status)} · ${stamp(task.updatedAt)}` : "正在加载已保存进展…"
      }
      onClose={close}
    >
      <ErrorNotice error={error} />
      {!task ? (
        <ActivityIndicator color={colors.blueDark} />
      ) : (
        <View style={{ gap: 20 }}>
          <Text selectable style={s.text}>
            {task.prompt}
          </Text>
          {task.milestoneId && data && (
            <Text style={s.muted}>
              {milestone?.title
                ? `里程碑：${milestone.title}。完成情况请在「目标」中手动跟踪。`
                : "关联里程碑已不可用。此任务及其结果仍可查看。"}
            </Text>
          )}
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            {["queued", "running", "scheduled", "waiting_input", "waiting_approval"].includes(
              task.status,
            ) && (
              <Button
                small
                icon={Pause}
                disabled={!capabilities?.taskPause}
                busy={busy}
                onPress={() => void act("control", { action: "pause" })}
              >
                暂停
              </Button>
            )}
            {task.status === "paused" && (
              <Button
                small
                icon={Play}
                disabled={!capabilities?.taskResume}
                busy={busy}
                onPress={() => void act("control", { action: "resume" })}
              >
                继续
              </Button>
            )}
            {task.status === "failed" && (
              <Button
                small
                icon={RefreshCw}
                disabled={!capabilities?.taskRetry}
                busy={busy}
                onPress={() => void act("control", { action: "retry" })}
              >
                重试任务
              </Button>
            )}
            {activeTask(task) && (
              <Button
                small
                danger
                icon={X}
                disabled={!capabilities?.taskCancel}
                busy={busy}
                onPress={() => void act("control", { action: "cancel" })}
              >
                取消任务
              </Button>
            )}
          </View>
          {(activeTask(task) || task.status === "failed") &&
            (!capabilities?.taskPause || !capabilities?.taskResume || !capabilities?.taskRetry) && (
              <Text style={s.small}>此工作台未启用暂停、继续与重试。</Text>
            )}
          {task.status === "waiting_approval" && (
            <StreamCard
              state="pending"
              tint={colors.lavender}
              title="待你审阅"
              detail="继续前请核对具体操作与账户。这一步还没有执行。"
            >
              {!capabilities?.google && <Text style={s.small}>此工作台未启用。</Text>}
              <Button primary busy={busy} disabled={!capabilities?.google} onPress={() => void review()}>
                审阅操作
              </Button>
            </StreamCard>
          )}
          {task.status === "waiting_input" && (
            <StreamCard
              state="pending"
              tint={colors.sky}
              title={task.question || "需要你补充一点细节"}
            >
              {!capabilities?.taskInput && <Text style={s.small}>此工作台未启用。</Text>}
              {fieldNames.map((name) =>
                missing.some(
                  (f) => typeof f === "object" && f && f.name === name && f.type === "checkbox",
                ) ? (
                  <CheckRow
                    key={name}
                    label={name.replace(/_/g, " ")}
                    checked={Boolean(fields[name])}
                    onPress={() => setFields((current) => ({ ...current, [name]: !current[name] }))}
                  />
                ) : (
                  <Field
                    key={name}
                    label={name.replace(/_/g, " ")}
                    value={String(fields[name] ?? "")}
                    onChangeText={(value) =>
                      setFields((current) => ({ ...current, [name]: value }))
                    }
                  />
                ),
              )}
              {!fieldNames.length && (
                <Field
                  label="你的回答"
                  value={answer}
                  onChangeText={setAnswer}
                  multiline
                  placeholder="补充缺少的细节…"
                />
              )}
              {task.kind === "document" && !fieldNames.length && (
                <>
                  <Button small onPress={() => setShowFieldJson(!showFieldJson)}>
                    表单字段值
                  </Button>
                  {showFieldJson && (
                    <Field
                      label="字段（JSON：字段名到值）"
                      value={fieldJson}
                      onChangeText={setFieldJson}
                      multiline
                      autoCapitalize="none"
                      placeholder={'{"full_name":"你的姓名","consent":true}'}
                    />
                  )}
                </>
              )}
              <Button
                primary
                busy={busy}
                disabled={!capabilities?.taskInput || (!answer.trim() && !Object.keys(fields).length && !fieldJson.trim())}
                onPress={() => void submitInput()}
              >
                继续任务
              </Button>
            </StreamCard>
          )}
          {!!task.plan.length && (
            <Card style={{ gap: 15 }}>
              <Text style={s.heading}>计划</Text>
              {task.plan.map((step, index) => (
                <View key={step.id} style={[s.row, { gap: 10, alignItems: "flex-start" }]}>
                  <Text
                    style={[
                      s.text,
                      { color: step.status === "succeeded" ? colors.blueDark : colors.muted },
                    ]}
                  >
                    {step.status === "succeeded" ? "✓" : `${index + 1}.`}
                  </Text>
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text style={s.text}>{step.title}</Text>
                    <Text style={s.small}>
                      {statusLabel(step.status)}
                      {step.detail ? ` · ${step.detail}` : ""}
                    </Text>
                  </View>
                </View>
              ))}
            </Card>
          )}
          {!!task.result && (
            <Card style={{ backgroundColor: colors.green }}>
              <Text selectable style={s.text}>
                {resultSummary(task.result)}
              </Text>
            </Card>
          )}
          <ErrorNotice error={task.error ?? undefined} />
          {detail?.browsers?.map((browser) => (
            <Card key={browser.id} style={{ gap: 10 }}>
              <Text style={s.heading}>{browser.title || "智能体浏览器"}</Text>
              <Text style={s.small}>{browser.url}</Text>
              {browser.status === "active" && browser.previewUrl && (
                <Image
                  accessibilityLabel="智能体浏览器预览"
                  source={{ uri: api.url(browser.previewUrl) }}
                  style={{ width: "100%", aspectRatio: 1.6, borderRadius: 12 }}
                />
              )}
              <Button
                small
                busy={busy}
                disabled={!capabilities?.browser || (["running", "scheduled", "queued"].includes(task.status) && !capabilities?.taskPause)}
                onPress={() => {
                  setBusy(true);
                  void (async () => {
                    try {
                      if (["running", "scheduled", "queued"].includes(task.status))
                        await mutate(`/tasks/${taskId}/control`, { action: "pause" });
                      open({ type: "browser", browser });
                    } catch (error) {
                      setError(errorText(error));
                    } finally {
                      setBusy(false);
                    }
                  })();
                }}
              >
                {["running", "scheduled", "queued"].includes(task.status)
                  ? "暂停并打开浏览器"
                  : "打开浏览器"}
              </Button>
            </Card>
          ))}
          {detail?.files?.map((file) => (
            <LinkRow
              key={file.id}
              title={file.name}
              detail={`${file.pageCount} pages · PDF`}
              icon={FileText}
              onPress={() => open({ type: "file", file })}
            />
          ))}
          {(
            data?.artifacts.filter((artifact) => artifact.taskId === taskId) ||
            detail?.artifacts ||
            []
          ).map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} />
          ))}
          {!!task.evidence.length && (
            <View style={{ gap: 14 }}>
              <Text style={s.heading}>来源</Text>
              <EvidenceList items={task.evidence} />
            </View>
          )}
          <Text style={s.heading}>时间线</Text>
          {detail?.events.map((event) => (
            <View
              key={event.id}
              style={{ gap: 4, paddingLeft: 14, borderLeftWidth: 2, borderLeftColor: colors.line }}
            >
              <Text style={s.small}>
                {stamp(event.date)} · {statusLabel(event.kind)}
              </Text>
              <Text style={s.text}>{event.title}</Text>
              <Text selectable style={s.muted}>
                {event.detail}
              </Text>
            </View>
          ))}
          {!detail?.events.length && (
            <Text style={s.muted}>工作进程会在此记录每一步。</Text>
          )}
        </View>
      )}
    </Sheet>
  );
}
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function display(value: unknown): string {
  return typeof value === "string"
    ? value
    : typeof value === "number" || typeof value === "boolean"
      ? String(value)
      : value === null
        ? "—"
        : JSON.stringify(value, null, 2) || "";
}
export function ArtifactCard({ artifact }: { artifact: AgentArtifact }) {
  const [expanded, setExpanded] = useState(false);
  if (artifact.kind === "finance") return <FinanceArtifact artifact={artifact} />;
  const rows = Object.entries(artifact.data);
  return (
    <Card style={{ gap: 13, backgroundColor: colors.card }}>
      <View style={s.between}>
        <Text style={s.heading}>{artifact.title}</Text>
        <Chip>{statusLabel(artifact.kind)}</Chip>
      </View>
      <Text selectable style={s.muted}>
        {artifact.summary}
      </Text>
      {(expanded ? rows : rows.slice(0, 4)).map(([key, value]) => (
        <View key={key} style={{ gap: 6 }}>
          <Text style={s.label}>{key.replace(/_/g, " ")}</Text>
          {Array.isArray(value) ? (
            value.slice(0, expanded ? 100 : 5).map((item) => {
              const row = record(item);
              return (
                <View
                  key={`${key}-${display(row?.id ?? item)}`}
                  style={{
                    paddingVertical: 8,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.line,
                  }}
                >
                  <Text selectable style={s.text}>
                    {row
                      ? Object.entries(row)
                          .map(([name, val]) => `${name}: ${display(val)}`)
                          .join(" · ")
                      : display(item)}
                  </Text>
                </View>
              );
            })
          ) : record(value) ? (
            Object.entries(record(value) || {}).map(([name, val]) => (
              <View key={name} style={s.between}>
                <Text style={s.muted}>{name}</Text>
                <Text selectable style={s.text}>
                  {display(val)}
                </Text>
              </View>
            ))
          ) : (
            <Text selectable style={[s.text, { fontSize: typeof value === "number" ? 24 : 14 }]}>
              {display(value)}
            </Text>
          )}
        </View>
      ))}
      <Button small onPress={() => setExpanded(!expanded)}>
        {expanded ? "显示摘要" : "查看完整结果"}
      </Button>
    </Card>
  );
}
function FinanceArtifact({ artifact }: { artifact: AgentArtifact }) {
  const [details, setDetails] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { mutate } = useAgentWorkspace();
  const { workspace } = useWorkspace();
  const [goalTitle, setGoalTitle] = useState("");
  const [goalSaved, setGoalSaved] = useState(false);
  const [goalBusy, setGoalBusy] = useState(false);
  const [goalError, setGoalError] = useState("");
  const saveGoal = async () => {
    if (!workspace.runtime.capabilities?.goals) return;
    setGoalBusy(true);
    setGoalError("");
    try {
      await mutate("/goals", {
        title: goalTitle.trim(),
        category: "财务",
        description: `受启发于 ${artifact.title}：${artifact.summary}`,
        milestones: ["选定储蓄目标", "每周回顾开支"],
      });
      setGoalSaved(true);
    } catch (error) {
      setGoalError(errorText(error));
    } finally {
      setGoalBusy(false);
    }
  };
  const amount = (value: unknown) =>
    Number(value ?? 0).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  const categories = Array.isArray(artifact.data.categories) ? artifact.data.categories : [];
  const transactions = Array.isArray(artifact.data.transactions) ? artifact.data.transactions : [];
  const spending = Number(artifact.data.spending) || 1;
  const period = record(artifact.data.period);
  return (
    <Card
      style={{ gap: 12, padding: 10, backgroundColor: "#EEEEF0", maxWidth: 440, width: "100%" }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`打开财务跟踪：${artifact.title}`}
        accessibilityState={{ expanded: details }}
        onPress={() => setDetails(!details)}
      >
        <View
          style={{
            minHeight: 200,
            borderRadius: 16,
            overflow: "hidden",
            backgroundColor: "#080B10",
            padding: 20,
          }}
        >
          <View style={{ position: "absolute", top: 0, left: 0, right: 0, height: 142 }}>
            <Svg width="100%" height="100%">
              <Defs>
                <LinearGradient id="finance" x1="0" y1="0" x2="0.5" y2="1">
                  <Stop offset="0" stopColor="#281066" />
                  <Stop offset="0.5" stopColor="#163BBF" />
                  <Stop offset="1" stopColor="#148CE8" />
                </LinearGradient>
              </Defs>
              <Rect width="100%" height="100%" fill="url(#finance)" />
            </Svg>
          </View>
          <Text style={{ color: "#D4DCFC", fontSize: 11, lineHeight: 18, marginBottom: 20 }}>
            Read from your imported transactions.{"\n"}
            {String(period?.from ?? "")} — {String(period?.to ?? "")}
            {"\n"}
            {transactions.length} transactions, categorized and summarized.
          </Text>
          <View style={[s.row, { gap: 7 }]}>
            {(
              [
                ["收入", "income"],
                ["支出", "spending"],
                ["剩余", "saved"],
              ] as const
            ).map(([label, key]) => (
              <View
                key={key}
                style={{ flex: 1, padding: 11, borderRadius: 12, backgroundColor: "#1D2025" }}
              >
                <Text style={{ color: "#A4A7AD", fontSize: 9 }}>{label}</Text>
                <Text
                  selectable
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.65}
                  style={{
                    fontSize: 17,
                    fontWeight: "600",
                    color: key === "saved" ? "#58D3AE" : "#FFF",
                    marginTop: 5,
                  }}
                >
                  {amount(artifact.data[key])}
                </Text>
                <Text style={{ color: "#7E8289", fontSize: 8, marginTop: 4 }}>source currency</Text>
              </View>
            ))}
          </View>
        </View>
        <View style={[s.row, { gap: 11, paddingHorizontal: 8, paddingTop: 13, paddingBottom: 4 }]}>
          <Text style={{ fontSize: 25 }}>💸</Text>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={[s.text, { fontWeight: "600" }]}>财务跟踪</Text>
            <Text style={s.small}>开支、储蓄，以及下一步计划。</Text>
          </View>
          <ChevronRight size={17} color={colors.muted} />
        </View>
      </Pressable>
      {details && (
        <View style={{ gap: 16, padding: 10 }}>
          <Text style={s.label}>钱花到哪里了</Text>
          {categories.map((category) => {
            const row = record(category);
            if (!row) return null;
            return (
              <View key={String(row.name)} style={{ gap: 8 }}>
                <View style={s.between}>
                  <Text style={s.text}>{String(row.name)}</Text>
                  <Text style={s.text}>{amount(row.amount)}</Text>
                </View>
                <View style={{ height: 7, backgroundColor: "#DFE8EB", borderRadius: 8 }}>
                  <View
                    style={{
                      width: `${Math.min(100, (Number(row.amount) / spending) * 100)}%`,
                      height: 7,
                      backgroundColor: colors.blueDark,
                      borderRadius: 8,
                    }}
                  />
                </View>
              </View>
            );
          })}
          <Text style={s.small}>
            金额使用来源币种。本摘要覆盖导入的日期范围。
          </Text>
          {goalSaved ? (
            <Text style={s.text}>你的储蓄目标已保存在「目标」。</Text>
          ) : (
            <View style={{ gap: 10 }}>
              <Field
                label="把它变成储蓄目标"
                value={goalTitle}
                onChangeText={setGoalTitle}
                placeholder="你想为了什么存钱？"
              />
              <ErrorNotice error={goalError} />
              <Button
                small
                busy={goalBusy}
                disabled={!workspace.runtime.capabilities?.goals || !goalTitle.trim()}
                onPress={() => void saveGoal()}
              >
                创建储蓄目标
              </Button>
            </View>
          )}
          <Button small onPress={() => setExpanded(!expanded)}>
            {expanded ? "隐藏流水" : "查看流水"}
          </Button>
          {expanded &&
            transactions.slice(0, 100).map((transaction) => {
              const row = record(transaction);
              return row ? (
                <View key={String(row.id ?? display(row))} style={s.between}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.text}>{String(row.description)}</Text>
                    <Text style={s.small}>
                      {String(row.date)} · {String(row.category)}
                    </Text>
                  </View>
                  <Text style={s.text}>{amount(row.amount)}</Text>
                </View>
              ) : null;
            })}
          {expanded && transactions.length > 100 && (
            <Text style={s.small}>
              仅显示前 100 笔交易。合计包含全部行。
            </Text>
          )}
        </View>
      )}
    </Card>
  );
}
export function DelegateSheet({ goalId, milestoneId }: { goalId?: string; milestoneId?: string }) {
  const { workspace, close, open } = useWorkspace();
  const { data, delegate } = useAgentWorkspace();
  const capabilities = workspace.runtime.capabilities;
  const enabled = (kind: AgentTask["kind"]) =>
    kind === "document"
      ? capabilities?.pdf && capabilities?.google
      : kind === "finance"
        ? capabilities?.finance
        : capabilities?.research;
  const goal = data?.goals.find((item) => item.id === goalId);
  const milestone = goal?.milestones.find((item) => item.id === milestoneId);
  const submission = useRef<{ input: string; id: string } | null>(null);
  const submitting = useRef(false);
  const [kind, setKind] = useState<AgentTask["kind"]>("plan");
  const [title] = useState(milestone?.title);
  const [prompt, setPrompt] = useState(
    milestone && goal
      ? `协助此里程碑：${milestone.title}\n目标：${goal.title}\n${goal.description}`
      : "",
  );
  const [messageId, setMessageId] = useState("");
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit() {
    if (submitting.current || !enabled(kind)) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const input = {
        title,
        prompt: prompt.trim(),
        kind,
        goalId,
        milestoneId,
        input: kind === "finance" ? { csv } : kind === "document" ? { messageId } : {},
      };
      const serialized = JSON.stringify(input);
      if (submission.current?.input !== serialized)
        submission.current = {
          input: serialized,
          id: `delegate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        };
      const task = await delegate(input, submission.current.id);
      open({ type: "task", taskId: task.id });
    } catch (e) {
      setError(errorText(e));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <Sheet
      title="交出一个结果"
      subtitle="Kleio 会保存计划，并在服务器上继续工作。"
      onClose={close}
    >
      {milestoneId && (
        <Text style={[s.muted, { marginBottom: 16 }]}>
          {milestone
            ? `${goal?.title} · ${milestone.title}。满意结果后即可将此里程碑标为完成。`
            : "此里程碑已不可用。"}
        </Text>
      )}
      <View style={[s.row, { flexWrap: "wrap", gap: 8, marginBottom: 20 }]}>
        {(["plan", "document", "finance", "agent"] as const).map((item) => (
          <Button small primary={kind === item} key={item} onPress={() => setKind(item)}>
            {item === "agent" ? "一般任务" : statusLabel(item)}
          </Button>
        ))}
      </View>
      <Field
        label="你希望完成什么？"
        value={prompt}
        onChangeText={setPrompt}
        multiline
        placeholder={
          kind === "document"
            ? "填写附件表单，并准备一份供我审阅的回复"
            : kind === "finance"
              ? "总结我的开支并建议储蓄计划"
              : "为我的一周做个务实计划"
        }
      />
      {kind === "document" && (
        <View style={{ gap: 8, marginBottom: 18 }}>
          <Text style={s.heading}>选择带 PDF 的邮件</Text>
          {workspace.mail
            .filter((mail) => mail.attachments.length)
            .map((mail) => (
              <CheckRow
                key={mail.id}
                checked={mail.id === messageId}
                label={`${mail.subject} · ${mail.sender}`}
                onPress={() => setMessageId(mail.id)}
              />
            ))}
          {!workspace.mail.some((mail) => mail.attachments.length) && (
            <Text style={s.muted}>
              在「应用」中连接邮件，并选择带 PDF 附件的消息。
            </Text>
          )}
        </View>
      )}
      {kind === "finance" && (
        <>
          <Field
            label="交易 CSV"
            value={csv}
            onChangeText={setCsv}
            multiline
            autoCapitalize="none"
            placeholder={"date,description,amount,category\n2026-09-01,Groceries,54.20,Food"}
          />
          {workspace.mode === "sample" && (
            <Button
              onPress={() =>
                setCsv(
                  "date,description,amount,category\n2026-09-01,Salary,-4200,Income\n2026-09-02,Groceries,84.50,Food\n2026-09-03,Subscription,19.99,Subscriptions\n2026-09-04,Coffee,6.50,Food",
                )
              }
            >
              试用示例交易
            </Button>
          )}
          <Text style={[s.small, { marginVertical: 12 }]}>
            正数为支出，负数为收入。仅导入数据，不代表银行连接。
          </Text>
        </>
      )}
      {kind === "agent" && !workspace.runtime.configured && (
        <Text style={[s.muted, { marginBottom: 16 }]}>
          一般任务与计划需要已配置的模型。文档任务、网页盯梢与开支摘要仍有引导流程。
        </Text>
      )}
      <Text style={[s.small, { marginBottom: 12 }]}>{enabled(kind) ? "此工作台中的委托任务仅做只读调研。" : "此工作台未启用。"}</Text>
      <ErrorNotice error={error} />
      <Button
        primary
        busy={busy}
        disabled={
          !enabled(kind) ||
          Boolean(milestoneId && !milestone) ||
          !prompt.trim() ||
          (kind === "document" && !messageId) ||
          (kind === "finance" && !csv.trim())
        }
        onPress={() => void submit()}
      >
        委托任务
      </Button>
    </Sheet>
  );
}
export function IdeasScreen() {
  const { data, mutate } = useAgentWorkspace();
  const { workspace } = useWorkspace();
  const enabled = workspace.runtime.capabilities?.ideas === true;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function refreshIdeas() {
    if (!enabled) return;
    setBusy(true);
    setError("");
    try {
      await mutate("/ideas/refresh", {});
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const ideas = data?.ideas.filter((idea) => idea.status === "new") || [];
  return (
    <View style={{ gap: 20 }}>
      <AgentStatus />
      {!enabled && <Text style={s.small}>此工作台未启用。</Text>}
      <View style={s.between}>
        <Text style={s.small}>来自你已连接的应用</Text>
        <Button small icon={RefreshCw} busy={busy} disabled={!enabled} onPress={() => void refreshIdeas()}>
          找灵感
        </Button>
      </View>
      <ErrorNotice error={error} />
      {ideas.map((idea) => (
        <IdeaCard key={idea.id} idea={idea} />
      ))}
      {!ideas.length && (
        <Empty
          icon={Lightbulb}
          title="留给好点子的空间"
          detail="从你已授权的来源中找灵感。每条建议都带证据。"
        />
      )}
      {(data?.ideas || [])
        .filter((idea) => idea.status === "accepted")
        .map((idea) => (
          <Card key={idea.id} style={{ gap: 7 }}>
            <Text style={s.heading}>{idea.title}</Text>
            <Chip tint={colors.green}>已开始</Chip>
            {!!idea.taskId && <TaskLink taskId={idea.taskId} />}
          </Card>
        ))}
    </View>
  );
}
function TaskLink({ taskId, onOpen }: { taskId: string; onOpen?: () => void }) {
  const { open } = useWorkspace();
  return (
    <Button
      small
      icon={ArrowRight}
      onPress={() => {
        onOpen?.();
        open({ type: "task", taskId });
      }}
    >
      查看任务
    </Button>
  );
}
function IdeaCard({ idea }: { idea: Idea }) {
  const { mutate } = useAgentWorkspace();
  const { open, workspace } = useWorkspace();
  const enabled = workspace.runtime.capabilities?.ideas === true;
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [prompt, setPrompt] = useState(idea.prompt);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function act(action: "accept" | "dismiss") {
    if (!enabled) return;
    setBusy(true);
    setError("");
    try {
      const result = await mutate<Idea>(`/ideas/${idea.id}`, { action, prompt });
      if (result.taskId && action === "accept") open({ type: "task", taskId: result.taskId });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ paddingVertical: 18, borderBottomWidth: 1, borderBottomColor: colors.line }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`查看灵感：${idea.title}`}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        style={{ flexDirection: "row", gap: 14 }}
      >
        <Text style={{ fontSize: 27, width: 34, paddingTop: 3 }}>
          {/document|permission|form/i.test(idea.title)
            ? "📋"
            : /money|spend|saving/i.test(idea.title)
              ? "💸"
              : /goal|plan|training/i.test(idea.title)
                ? "👟"
                : /dinner|table/i.test(idea.title)
                  ? "🍽️"
                  : "💡"}
        </Text>
        <View style={{ flex: 1, gap: 5 }}>
          <Text style={[s.heading, { fontSize: 16, lineHeight: 23 }]}>{idea.title}</Text>
          <Text style={s.muted}>{idea.reason}</Text>
        </View>
      </Pressable>
      {expanded && (
        <View style={{ gap: 15, marginTop: 18, paddingLeft: 48 }}>
          <EvidenceList items={idea.evidence} />
          {editing && (
            <Field
              label="希望 Kleio 做什么？"
              value={prompt}
              onChangeText={setPrompt}
              multiline
            />
          )}
          <ErrorNotice error={error} />
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            <Button
              primary
              busy={busy}
              disabled={!enabled || !prompt.trim()}
              onPress={() => void act("accept")}
            >
              开始这个
            </Button>
            <Button disabled={busy || !enabled} onPress={() => setEditing(!editing)}>
              {editing ? "保留修改" : "编辑"}
            </Button>
            <Button disabled={busy || !enabled} onPress={() => void act("dismiss")}>
              忽略
            </Button>
          </View>
        </View>
      )}
    </View>
  );
}
export function GoalsScreen() {
  const { data } = useAgentWorkspace();
  const [adding, setAdding] = useState<string>();
  const [selectedGoal, setSelectedGoal] = useState<string>();
  const [selectedMonitor, setSelectedMonitor] = useState<string>();
  const [showAll, setShowAll] = useState(false);
  const goal = data?.goals.find((item) => item.id === selectedGoal);
  const monitor = data?.monitors.find((item) => item.id === selectedMonitor);
  const monitors = data?.monitors || [];
  return (
    <View style={{ gap: 22 }}>
      <AgentStatus />
      <View style={{ gap: 8 }}>
        <View style={[s.between, { marginBottom: 5 }]}>
          <View style={[s.row, { gap: 10 }]}>
            <View
              style={{
                width: 16,
                height: 16,
                borderRadius: 8,
                borderWidth: 5,
                borderColor: "#D9F1E2",
                backgroundColor: "#24A46B",
              }}
            />
            <Text style={[s.heading, { color: "#189A58" }]}>盯梢</Text>
          </View>
          <Button small icon={Plus} onPress={() => setAdding("盯梢")}>
            盯梢
          </Button>
        </View>
        {(showAll ? monitors : monitors.slice(0, 3)).map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            accessibilityLabel={`打开盯梢：${item.title}`}
            onPress={() => setSelectedMonitor(item.id)}
            style={[s.row, { gap: 12, paddingVertical: 13 }]}
          >
            <Square size={21} color="#A7AAAC" />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={s.text}>{item.title}</Text>
              <Text numberOfLines={1} style={s.muted}>
                {item.status === "active"
                  ? `每 ${item.intervalMinutes} 分钟检查一次`
                  : statusLabel(item.status)}
              </Text>
            </View>
            <ChevronRight size={18} color="#A3A6A8" />
          </Pressable>
        ))}
        {!monitors.length && (
          <Text style={[s.muted, { paddingVertical: 10 }]}>
            票价、预约，或你在盯的网页。
          </Text>
        )}
        {monitors.length > 3 && (
          <Button small onPress={() => setShowAll(!showAll)}>
            {showAll ? "收起" : `显示其余 ${monitors.length - 3} 条`}
          </Button>
        )}
      </View>
      <View style={{ height: 1, backgroundColor: colors.line }} />
      <View style={{ gap: 8 }}>
        <View style={[s.row, { gap: 10, marginBottom: 5 }]}>
          <View
            style={{
              width: 16,
              height: 16,
              borderRadius: 8,
              borderWidth: 5,
              borderColor: "#D7E9FA",
              backgroundColor: "#3D9BDE",
            }}
          />
          <Text style={[s.heading, { color: colors.blueDark }]}>目标</Text>
        </View>
        {data?.goals.map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="button"
            accessibilityLabel={`打开目标：${item.title}`}
            onPress={() => setSelectedGoal(item.id)}
            style={[s.row, { gap: 12, paddingVertical: 13 }]}
          >
            <Square
              size={21}
              color="#A7AAAC"
              fill={item.status === "completed" ? colors.green : "transparent"}
            />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={s.text}>{item.title}</Text>
              <Text numberOfLines={2} style={s.muted}>
                {item.description || statusLabel(item.status)}
              </Text>
            </View>
            <ChevronRight size={18} color="#A3A6A8" />
          </Pressable>
        ))}
        {!data?.goals.length && (
          <Text style={[s.muted, { paddingVertical: 10 }]}>
            大计划从一小步开始。
          </Text>
        )}
      </View>
      <View style={{ height: 1, backgroundColor: colors.line }} />
      <Text style={s.heading}>创建目标</Text>
      {[
        { name: "健康", icon: Heart },
        { name: "人际关系", icon: Users },
        { name: "财务", icon: CircleDollarSign },
        { name: "其他", icon: Target },
      ].map((item) => (
        <Pressable
          key={item.name}
          accessibilityRole="button"
          accessibilityLabel={`创建${item.name}目标`}
          onPress={() => setAdding(item.name)}
          style={[s.row, { gap: 12, minHeight: 38 }]}
        >
          <item.icon size={23} color="#989C9F" />
          <Text style={[s.text, { flex: 1, color: "#666A6D" }]}>{item.name}</Text>
          <Plus size={18} color="#989C9F" />
        </Pressable>
      ))}
      {adding && (
        <Sheet
          title={adding === "盯梢" ? "盯着某件事" : "创建目标"}
          onClose={() => setAdding(undefined)}
        >
          {adding === "盯梢" ? (
            <MonitorForm onDone={() => setAdding(undefined)} />
          ) : (
            <GoalForm category={adding} onDone={() => setAdding(undefined)} />
          )}
        </Sheet>
      )}
      {goal && (
        <Sheet title={goal.title} onClose={() => setSelectedGoal(undefined)}>
          <GoalCard goal={goal} onOpenTask={() => setSelectedGoal(undefined)} />
        </Sheet>
      )}
      {monitor && (
        <Sheet title={monitor.title} onClose={() => setSelectedMonitor(undefined)}>
          <MonitorCard monitor={monitor} onOpenTask={() => setSelectedMonitor(undefined)} />
        </Sheet>
      )}
    </View>
  );
}
function GoalForm({ onDone, category }: { onDone: () => void; category?: string }) {
  const { mutate } = useAgentWorkspace();
  const { workspace } = useWorkspace();
  const enabled = workspace.runtime.capabilities?.goals === true;
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [milestones, setMilestones] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    if (!enabled) return;
    setBusy(true);
    setError("");
    try {
      await mutate("/goals", {
        title: title.trim(),
        category,
        description,
        milestones: milestones
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      });
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <Field
        label="你的目标"
        value={title}
        onChangeText={setTitle}
        placeholder="建立三个月应急金"
      />
      <Field
        label="怎样算成功？"
        value={description}
        onChangeText={setDescription}
        multiline
      />
      <Field
        label="里程碑（每行一条）"
        value={milestones}
        onChangeText={setMilestones}
        multiline
      />
      {!enabled && <Text style={s.small}>此工作台未启用。</Text>}
      <ErrorNotice error={error} />
      <Button primary disabled={!enabled || !title.trim()} busy={busy} onPress={() => void save()}>
        创建目标
      </Button>
    </Card>
  );
}
function GoalCard({ goal, onOpenTask }: { goal: Goal; onOpenTask?: () => void }) {
  const { data, mutate, delegate } = useAgentWorkspace();
  const { open, workspace } = useWorkspace();
  const enabled = workspace.runtime.capabilities?.goals === true;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const done = goal.milestones.filter((item) => item.done).length;
  async function update(body: unknown, milestoneId?: string) {
    if (!enabled) return;
    setBusy(true);
    setError("");
    try {
      await mutate(`/goals/${goal.id}${milestoneId ? `/milestones/${milestoneId}` : ""}`, body);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function plan() {
    if (!enabled || !workspace.runtime.capabilities?.research) return;
    setBusy(true);
    setError("");
    try {
      const task = await delegate({
        title: `计划：${goal.title}`,
        prompt: `为这个目标制定务实计划：${goal.title}。${goal.description}`,
        kind: "plan",
        goalId: goal.id,
        input: {},
      });
      onOpenTask?.();
      open({ type: "task", taskId: task.id });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card style={{ gap: 12 }}>
      <View style={s.between}>
        <Text style={[s.heading, { flex: 1 }]}>{goal.title}</Text>
        <Chip tint={goal.status === "completed" ? colors.green : colors.sky}>
          {statusLabel(goal.status)}
        </Chip>
      </View>
      <Text style={s.muted}>{goal.description}</Text>
      <Text style={s.small}>
        {done} / {goal.milestones.length} 个里程碑
      </Text>
      {goal.milestones.map((milestone) => (
        <View key={milestone.id} style={{ gap: 8 }}>
          <CheckRow
            checked={milestone.done}
            label={milestone.title}
            onPress={() => {
              if (!busy && enabled) void update({ done: !milestone.done }, milestone.id);
            }}
          />
          {!milestone.done && (
            <Button
              small
              disabled={!enabled || goal.status !== "active"}
              onPress={() => {
                onOpenTask?.();
                open({ type: "delegate", goalId: goal.id, milestoneId: milestone.id });
              }}
            >
              委托
            </Button>
          )}
          {data?.tasks
            .filter((task) => task.goalId === goal.id && task.milestoneId === milestone.id)
            .map((task) => (
              <TaskCard key={task.id} task={task} compact onOpen={onOpenTask} />
            ))}
        </View>
      ))}
      <ErrorNotice error={error} />
      <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
        <Button
          small
          busy={busy}
          disabled={!enabled}
          onPress={() => void update({ status: goal.status === "active" ? "paused" : "active" })}
        >
          {goal.status === "active" ? "暂停" : "继续"}
        </Button>
        {goal.status !== "completed" && (
          <Button small busy={busy} disabled={!enabled} onPress={() => void update({ status: "completed" })}>
            完成目标
          </Button>
        )}
        <Button small primary busy={busy} disabled={!enabled || !workspace.runtime.capabilities?.research} onPress={() => void plan()}>
          规划下一步
        </Button>
      </View>
      {data?.tasks
        .filter(
          (task) =>
            task.goalId === goal.id &&
            (!task.milestoneId || !goal.milestones.some((m) => m.id === task.milestoneId)),
        )
        .map((task) => (
          <TaskCard key={task.id} task={task} compact onOpen={onOpenTask} />
        ))}
    </Card>
  );
}
function MonitorForm({ onDone }: { onDone: () => void }) {
  const { workspace } = useWorkspace();
  const enabled = workspace.runtime.capabilities?.tracking === true;
  const { mutate } = useAgentWorkspace();
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [condition, setCondition] = useState<Monitor["condition"]>("change");
  const [value, setValue] = useState("");
  const [interval, setInterval] = useState("15");
  const [sample, setSample] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!enabled) return;
    setBusy(true);
    setError("");
    try {
      const minutes = Number(interval);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080)
        throw new Error("检查间隔请设为 1 到 10080 分钟。");
      if (!sample && !/^https?:\/\//i.test(url.trim()))
        throw new Error("请输入公开网页的 http 或 https 地址。");
      await mutate("/monitors", {
        title: title.trim(),
        url: sample ? "sample://availability" : url.trim(),
        condition,
        value,
        intervalMinutes: minutes,
      });
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <Field
        label="你在盯着什么？"
        value={title}
        onChangeText={setTitle}
        placeholder="我常去餐厅的空位"
      />
      {workspace.mode === "sample" && (
        <CheckRow
          checked={sample}
          label="试试内置的空位页面"
          onPress={() => setSample(!sample)}
        />
      )}
      {!sample && (
        <Field
          label="公开网页地址"
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          placeholder="https://example.com/product"
        />
      )}
      <Text style={[s.small, { marginBottom: 10 }]}>在以下情况通知我</Text>
      <View style={[s.row, { gap: 7, flexWrap: "wrap", marginBottom: 16 }]}>
        {(["change", "contains", "price_below"] as const).map((item) => (
          <Button small primary={condition === item} key={item} onPress={() => setCondition(item)}>
            {item === "change"
              ? "页面有变化"
              : item === "contains"
                ? "出现某段文字"
                : "价格降到以下"}
          </Button>
        ))}
      </View>
      {condition !== "change" && (
        <Field
          label={condition === "contains" ? "要查找的文字" : "目标价格"}
          value={value}
          onChangeText={setValue}
        />
      )}
      <Field
        label="检查间隔（分钟）"
        value={interval}
        onChangeText={setInterval}
        keyboardType="number-pad"
      />
      <Text style={[s.small, { marginBottom: 14 }]}>
        {sample
          ? "此内置页面的变化会留在你的工作台。"
          : "Kleio 会在服务器上检查此公开页面，并把有意义的变化保存到通知。"}
      </Text>
      {!enabled && <Text style={s.small}>此工作台未启用。</Text>}
      <ErrorNotice error={error} />
      <Button
        primary
        busy={busy}
        disabled={
          !enabled || !title.trim() || (!sample && !url.trim()) || (condition !== "change" && !value.trim())
        }
        onPress={() => void save()}
      >
        开始盯梢
      </Button>
    </Card>
  );
}
function MonitorCard({ monitor, onOpenTask }: { monitor: Monitor; onOpenTask?: () => void }) {
  const { mutate } = useAgentWorkspace();
  const { workspace } = useWorkspace();
  const enabled = workspace.runtime.capabilities?.tracking === true;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function act(action: string) {
    if (!enabled) return;
    setBusy(true);
    setError("");
    try {
      await mutate(`/monitors/${monitor.id}/control`, { action });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function changeSample() {
    if (!enabled) return;
    setBusy(true);
    setError("");
    try {
      await mutate("/sample-page", {
        text: `空位：有桌位可用。更新于 ${new Date().toISOString()}`,
      });
      await mutate(`/monitors/${monitor.id}/control`, { action: "check" });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card style={{ gap: 13 }}>
      <View style={s.between}>
        <Text style={[s.heading, { flex: 1 }]}>{monitor.title}</Text>
        <Chip tint={colors.sky}>{statusLabel(monitor.status)}</Chip>
      </View>
      <Text selectable style={s.small}>
        {monitor.url.startsWith("sample:") ? "内置空位页面" : monitor.url}
      </Text>
      <Text style={s.text}>
        {monitor.condition === "change"
          ? "盯着页面变化"
          : monitor.condition === "contains"
            ? `盯着出现「${monitor.value}」`
            : `价格低于 ${monitor.value}`}
      </Text>
      <Text style={s.small}>
        Every {monitor.intervalMinutes} min · {monitor.checks} checks
      </Text>
      <Text style={s.small}>
        Last check: {stamp(monitor.lastCheckedAt)}
        {monitor.status === "active" ? `\nNext check: ${stamp(monitor.nextCheckAt)}` : ""}
      </Text>
      {!!monitor.lastValue && (
        <Text selectable numberOfLines={5} style={s.muted}>
          {monitor.lastValue}
        </Text>
      )}
      <ErrorNotice error={error || monitor.error} />
      {monitor.status !== "stopped" && (
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          <Button
            small
            busy={busy}
            disabled={!enabled}
            onPress={() => void act(monitor.status === "active" ? "pause" : "resume")}
          >
            {monitor.status === "active" ? "暂停" : "继续"}
          </Button>
          <Button small busy={busy} disabled={!enabled} onPress={() => void act("check")}>
            立即检查
          </Button>
          <Button small danger busy={busy} disabled={!enabled} onPress={() => void act("stop")}>
            停止盯梢
          </Button>
        </View>
      )}
      {monitor.url.startsWith("sample:") && monitor.status !== "stopped" && (
        <Button small busy={busy} disabled={!enabled} onPress={() => void changeSample()}>
          更改空位状态
        </Button>
      )}
      <TaskLink taskId={monitor.taskId} onOpen={onOpenTask} />
    </Card>
  );
}
export function NotificationsSheet() {
  const { data, mutate } = useAgentWorkspace();
  const { close, open } = useWorkspace();
  const [error, setError] = useState("");
  async function read(id: string, taskId?: string) {
    try {
      await mutate(`/notifications/${id}/read`, {});
      if (taskId) open({ type: "task", taskId });
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <Sheet
      title="通知"
      subtitle="需要你关注的结果与决策。"
      onClose={close}
    >
      <View style={{ gap: 14 }}>
        <ErrorNotice error={error} />
        {data?.notifications.map((item) => (
          <Card
            key={item.id}
            style={{ gap: 8, backgroundColor: item.read ? colors.card : colors.sky }}
          >
            <View style={s.between}>
              <Text style={s.heading}>{item.title}</Text>
              {!item.read && <Chip>新</Chip>}
            </View>
            <Text style={s.muted}>{item.body}</Text>
            <Text style={s.small}>{stamp(item.createdAt)}</Text>
            <Button small onPress={() => void read(item.id, item.taskId)}>
              {item.taskId ? "查看任务" : item.read ? "已读" : "标为已读"}
            </Button>
          </Card>
        ))}
        {!data?.notifications.length && (
          <Empty
            icon={Bell}
            title="都处理完了"
            detail="结果、有意义的变化，以及需要你补充的请求会出现在这里。"
          />
        )}
      </View>
    </Sheet>
  );
}
export function AppsScreen() {
  const { navigate, open } = useWorkspace();
  const { data, mutate } = useAgentWorkspace();
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState(true);
  const [name, setName] = useState(data?.identity.name || "OpenMuse");
  const [tone, setTone] = useState(data?.identity.tone || "warm");
  const [avatar, setAvatar] = useState(data?.identity.avatar || "sky");
  const [showChatUpdates, setShowChatUpdates] = useState(data?.identity.showChatUpdates !== false);
  const [memory, setMemory] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data?.identity) {
      setName(data.identity.name);
      setTone(data.identity.tone);
      setAvatar(data.identity.avatar || "sky");
      setShowChatUpdates(data.identity.showChatUpdates !== false);
    }
  }, [
    data?.identity.name,
    data?.identity.tone,
    data?.identity.avatar,
    data?.identity.showChatUpdates,
  ]);
  async function save(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      await mutate(path, body);
      if (path === "/memories") setMemory("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const shortcuts = [
    {
      section: "mail" as const,
      title: "邮件",
      detail: "阅读邮件并起草回复",
      icon: Mail,
    },
    {
      section: "calendar" as const,
      title: "日历",
      detail: "日程与已审阅的邀请",
      icon: CalendarDays,
    },
    {
      section: "browser" as const,
      title: "智能体电脑",
      detail: "持久化浏览器会话",
      icon: Globe2,
    },
    {
      section: "files" as const,
      title: "文件",
      detail: "PDF、表单与已填写副本",
      icon: FileText,
    },
  ];
  return (
    <View style={{ gap: 22 }}>
      <AgentStatus />
      <Field
        label="搜索应用"
        value={query}
        onChangeText={setQuery}
        placeholder="搜索连接器"
      />
      <ConnectionsScreen query={query} />
      <Text style={s.heading}>在你的电脑上</Text>
      <Card style={{ paddingVertical: 3, backgroundColor: "#F4F5F6" }}>
        {shortcuts
          .filter((item) =>
            `${item.title} ${item.detail}`.toLowerCase().includes(query.toLowerCase()),
          )
          .map((item) => (
            <LinkRow
              key={item.section}
              icon={item.icon}
              title={item.title}
              detail={item.detail}
              onPress={() =>
                item.section === "browser" ? open({ type: "computer" }) : navigate(item.section)
              }
            />
          ))}
      </Card>
      <Button onPress={() => setSettings(!settings)}>
        {settings ? "关闭智能体设置" : "个性与记忆"}
      </Button>
      {settings && (
        <>
          <Card style={{ gap: 10 }}>
            <SectionHeading title="你的智能体" />
            <View style={[s.row, { gap: 16, justifyContent: "center", marginBottom: 12 }]}>
              {(["sky", "sand", "lilac"] as const).map((item) => (
                <Pressable
                  key={item}
                  accessibilityRole="radio"
                  accessibilityLabel={`${statusLabel(item)} 头像`}
                  accessibilityState={{ checked: avatar === item }}
                  onPress={() => setAvatar(item)}
                  style={{
                    padding: 7,
                    borderRadius: 24,
                    backgroundColor: avatar === item ? colors.sky : colors.canvas,
                  }}
                >
                  <Mascot size={62} variant={item} />
                </Pressable>
              ))}
            </View>
            <Field label="名称" value={name} onChangeText={setName} />
            <View style={[s.row, { gap: 8 }]}>
              {(
              [
                { id: "warm" as const, label: "温暖" },
                { id: "concise" as const, label: "简洁" },
                { id: "thoughtful" as const, label: "周到" },
              ] as const
            ).map((item) => (
                <Button key={item.id} small primary={tone === item.id} onPress={() => setTone(item.id)}>
                  {item.label}
                </Button>
              ))}
            </View>
            <CheckRow
              label="在对话中显示后台更新"
              checked={showChatUpdates}
              onPress={() => setShowChatUpdates(!showChatUpdates)}
            />
            <Text style={s.small}>
              动态与通知始终保留完整记录，包括审批请求。
            </Text>
            <Button
              busy={busy}
              disabled={!name.trim()}
              onPress={() =>
                void save("/identity", { name: name.trim(), tone, avatar, showChatUpdates })
              }
            >
              保存偏好
            </Button>
          </Card>
          <Card style={{ gap: 12 }}>
            <SectionHeading title="记忆" />
            <Text style={s.muted}>你可以查看、更正或遗忘的上下文。</Text>
            {data?.memories.map((item) => (
              <MemoryRow key={item.id} memory={item} />
            ))}
            <Field
              label="记住关于我的事"
              value={memory}
              onChangeText={setMemory}
              placeholder="我更喜欢上午开会"
            />
            <Button
              busy={busy}
              disabled={!memory.trim()}
              onPress={() =>
                void save("/memories", { text: memory.trim(), source: "在应用中由用户添加" })
              }
            >
              记住
            </Button>
          </Card>
        </>
      )}
      <ErrorNotice error={error} />
    </View>
  );
}
function MemoryRow({ memory }: { memory: AgentMemory }) {
  const { mutate } = useAgentWorkspace();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(memory.text);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function act(forget: boolean) {
    setBusy(true);
    setError("");
    try {
      await mutate(`/memories/${memory.id}${forget ? "/forget" : ""}`, {
        ...(forget ? {} : { text }),
        expectedVersion: memory.version,
      });
      setEditing(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View
      style={{ gap: 8, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: colors.line }}
    >
      {editing ? (
        <Field label="记忆" value={text} onChangeText={setText} />
      ) : (
        <Text style={s.text}>{memory.text}</Text>
      )}
      <Text style={s.small}>
        {memory.source} · {stamp(memory.createdAt)}
      </Text>
      <View style={[s.row, { gap: 8 }]}>
        {editing ? (
          <Button small busy={busy} disabled={!text.trim()} onPress={() => void act(false)}>
            保存更正
          </Button>
        ) : (
          <Button small onPress={() => setEditing(true)}>
            编辑
          </Button>
        )}
        <Button small danger busy={busy} onPress={() => void act(true)}>
          遗忘
        </Button>
      </View>
      <ErrorNotice error={error} />
    </View>
  );
}
