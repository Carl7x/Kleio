import { KleioHeadlessProvider, useThreads } from "./kleio-headless";
import { StatusBar } from "expo-status-bar";
import {
  Bell,
  Check,
  Lightbulb,
  type LucideIcon,
  Menu,
  MessageCircle,
  PanelsTopLeft,
  Shapes,
  SquareCheck,
  X,
} from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AppState,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
  Keyboard,
  Platform,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type { Section, Workspace } from "../../../packages/openmuse-domain/src";
import {
  AgentActivityScreen,
  AppsScreen,
  GoalsScreen,
  IdeasScreen,
} from "./agent-ui";
import { AgentWorkspaceProvider, useAgentWorkspace } from "./agent-workspace";
import { createSession, MuseApi } from "./api";
import { ChatScreen, WorkspaceTools } from "./chat";
import { ChatStatusScreen, ThreadNotice, ThreadTitleBar } from "./chat-stream";
import {
  accessGateCopy,
  chatShellStatus,
  sideThreadTitle,
  statusServerNote,
  threadChrome,
  threadStatusCopy,
} from "./chat-stream-rules";
import { ComputerEntry } from "./computer";
import { ComputerDraftProvider } from "./computer-drafts";
import { Details } from "./details";
import { BrowserScreen, CalendarScreen, FilesScreen, MailScreen } from "./screens";
import { ThreadsProvider, ThreadsSheet, useMuseThread } from "./threads";
import { Button, Card, colors, ErrorNotice, Field, IconButton, Mascot, s } from "./ui";
import { type Detail, useWorkspace, WorkspaceContext } from "./workspace";

const nav: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: "chat", label: "对话", icon: MessageCircle },
  { id: "activity", label: "动态", icon: PanelsTopLeft },
  { id: "ideas", label: "灵感", icon: Lightbulb },
  { id: "goals", label: "目标", icon: SquareCheck },
  { id: "apps", label: "应用", icon: Shapes },
];
const titles: Partial<Record<Section, { title: string; subtitle: string }>> = {
  activity: { title: "动态", subtitle: "计划、进展、决策与结果。" },
  ideas: { title: "灵感", subtitle: "贴合你现状的下一步。" },
  goals: {
    title: "目标",
    subtitle: "长期目标，以及需要盯着的事。",
  },
  apps: {
    title: "应用",
    subtitle: "连接、能力，以及智能体记住的事。",
  },
  connections: { title: "应用", subtitle: "连接与能力。" },
  mail: { title: "邮件", subtitle: "工作背后的往来邮件。" },
  calendar: { title: "日历", subtitle: "留给真正重要的时间。" },
  browser: { title: "浏览器", subtitle: "已连接的浏览会话。" },
  files: { title: "文件", subtitle: "文档、表单与已填写副本。" },
};
export default function App() {
  const [token, setToken] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const connect = useCallback(async (key?: string) => {
    setBusy(true);
    setError("");
    try {
      const session = await createSession(key);
      setToken(session.token);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    void connect();
  }, [connect]);
  const gate = accessGateCopy();
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {token ? (
        <KleioHeadlessProvider>
          <WorkspaceApp token={token} />
        </KleioHeadlessProvider>
      ) : (
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }}>
          {busy ? (
            <ChatStatusScreen
              hero
              busy={gate.connecting.busy}
              tone={gate.connecting.tone}
              title={gate.connecting.title}
              detail={gate.connecting.detail}
            />
          ) : (
            <View
              style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24 }}
            >
              <View style={{ width: "100%", maxWidth: 420, gap: 4 }}>
                <ChatStatusScreen
                  compact
                  hero
                  title={gate.welcomeTitle}
                  detail={gate.welcomeDetail}
                />
                <Card style={{ width: "100%" }}>
                  {error ? (
                    <View style={{ marginBottom: 14 }}>
                      <ThreadNotice
                        title={gate.failedTitle}
                        detail={gate.failedDetail}
                        note={statusServerNote(error)}
                        tone="error"
                      />
                    </View>
                  ) : null}
                  <Field
                    label={gate.tokenLabel}
                    value={accessKey}
                    onChangeText={setAccessKey}
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder={gate.tokenPlaceholder}
                  />
                  <Text
                    style={{
                      color: colors.muted,
                      fontSize: threadChrome.detailSize,
                      lineHeight: threadChrome.detailLine,
                      marginTop: -8,
                      marginBottom: 14,
                    }}
                  >
                    {gate.helper}
                  </Text>
                  <Button primary onPress={() => void connect(accessKey || undefined)}>
                    {gate.submitLabel}
                  </Button>
                </Card>
              </View>
            </View>
          )}
        </SafeAreaView>
      )}
    </SafeAreaProvider>
  );
}
function WorkspaceApp({ token }: { token: string }) {
  const api = useMemo(() => new MuseApi(token), [token]);
  const [workspace, setWorkspace] = useState<Workspace>();
  const [section, setSection] = useState<Section>("chat");
  const [detail, setDetail] = useState<Detail>();
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [prompt, setPrompt] = useState<{ id: number; text: string }>();
  const refresh = useCallback(async () => {
    const snapshot = await api.request<Workspace>("/api/workspace");
    setWorkspace(snapshot);
    setError("");
  }, [api]);
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, [refresh]);
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh().catch((e) => setError(String(e)));
    });
    return () => listener.remove();
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5500);
    return () => clearTimeout(timer);
  }, [toast]);
  const navigate = useCallback(
    (next: Section) =>
      setSection(next === "today" ? "chat" : next === "connections" ? "apps" : next),
    [],
  );
  const open = useCallback((next: Detail) => setDetail(next), []);
  const close = useCallback(() => setDetail(undefined), []);
  const ask = useCallback((text: string) => {
    setPrompt({ id: Date.now(), text });
    setSection("chat");
  }, []);
  if (!workspace) {
    const gate = accessGateCopy();
    const opening = error ? gate.workspaceFailed : gate.workspaceOpening;
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }}>
        <ChatStatusScreen
          hero
          busy={opening.busy}
          tone={opening.tone}
          title={opening.title}
          detail={opening.detail}
          note={error ? statusServerNote(error) : undefined}
          actionLabel={error ? opening.actionLabel : undefined}
          onAction={
            error ? () => void refresh().catch((e) => setError(String(e))) : undefined
          }
        />
      </SafeAreaView>
    );
  }
  return (
    <WorkspaceContext.Provider
      value={{ workspace, api, section, navigate, refresh, open, close, notify: setToast, ask }}
    >
      <AgentWorkspaceProvider>
        <ComputerDraftProvider key={token}>
          <ThreadsProvider>
            <WorkspaceShell
              detail={detail}
              toast={toast}
              clearToast={() => setToast("")}
              error={error}
              prompt={prompt}
            />
          </ThreadsProvider>
        </ComputerDraftProvider>
      </AgentWorkspaceProvider>
    </WorkspaceContext.Provider>
  );
}
function WorkspaceShell({
  detail,
  toast,
  clearToast,
  error,
  prompt,
}: {
  detail?: Detail;
  toast: string;
  clearToast: () => void;
  error: string;
  prompt?: { id: number; text: string };
}) {
  const { workspace, section, navigate, open } = useWorkspace();
  const { data, error: agentLinkError } = useAgentWorkspace();
  const {
    selection,
    visited,
    mainId,
    loading: threadsLoading,
    error: threadsError,
    retry: retryThreads,
    enabled: richThreads,
  } = useMuseThread();
  const catalog = useThreads({
    agentId: "default",
    enabled: richThreads,
    includeArchived: true,
    limit: 20,
  });
  const [threadsOpen, setThreadsOpen] = useState(false);
  const { width } = useWindowDimensions();
  const desktop = width >= 900;
  const pending =
    (data?.notifications.filter((n) => !n.read).length || 0) +
    workspace.actions.filter((a) => a.status === "awaiting_review").length;
  const activeTask =
    data?.tasks.find(
      (task) => task.status === "waiting_approval" || task.status === "waiting_input",
    ) || data?.tasks.find((task) => task.status === "running");
  const agentName = data?.identity.name || "Kleio";
  const runningTitle =
    activeTask &&
    activeTask.status !== "waiting_approval" &&
    activeTask.status !== "waiting_input"
      ? activeTask.plan.find((step) => step.status === "running")?.title || activeTask.title
      : null;
  const status = chatShellStatus({
    approval: activeTask?.status === "waiting_approval" ? activeTask.title : null,
    needsInput: activeTask?.status === "waiting_input" ? activeTask.title : null,
    running: runningTitle,
    queued: !activeTask && !!data?.tasks.some((task) => task.status === "queued"),
    connecting: !data && !agentLinkError,
    connectFailed: !!agentLinkError && !data,
    reconnecting: !!agentLinkError && !!data?.worker.running,
    offline: !!data && !data.worker.running,
  });
  const openingCopy = threadStatusCopy(threadsError ? "opening-failed" : "opening");
  const title = titles[section] || titles.apps;
  const Screen =
    section === "mail"
      ? MailScreen
      : section === "calendar"
        ? CalendarScreen
        : section === "browser"
          ? BrowserScreen
          : section === "files"
            ? FilesScreen
            : section === "activity"
              ? AgentActivityScreen
              : section === "ideas"
                ? IdeasScreen
                : section === "goals"
                  ? GoalsScreen
                  : AppsScreen;
  const utility = ["mail", "calendar", "browser", "files"].includes(section);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    if (Platform.OS === "web") return;
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const showSub = Keyboard.addListener(showEvent, () => setKeyboardOpen(true));
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardOpen(false));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return (
    <>
      <WorkspaceTools />
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.canvas }} edges={["top", "bottom"]}>
        <View style={{ flex: 1, width: "100%", maxWidth: 760, alignSelf: "center" }}>
          <View
            style={{
              height: desktop ? 146 : 122,
              paddingTop: desktop ? 14 : 2,
              marginHorizontal: 20,
            }}
          >
            <View style={{ position: "absolute", left: 0, top: 16 }}>
              <IconButton
                icon={Menu}
                label="打开对话与菜单"
                onPress={() => setThreadsOpen(true)}
              />
            </View>
            <View pointerEvents="box-none" style={{ alignItems: "center", gap: 1 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`打开 ${agentName} 动态与审批`}
                onPress={() => navigate("activity")}
                style={({ pressed }) => ({
                  alignItems: "center",
                  maxWidth: "70%",
                  opacity: pressed ? 0.65 : 1,
                })}
              >
                <Mascot size={desktop ? 58 : 49} variant={data?.identity.avatar} />
                <Text
                  style={{
                    fontSize: 16,
                    fontWeight: "600",
                    color: colors.text,
                    letterSpacing: -0.4,
                  }}
                >
                  {agentName}
                </Text>
                <Text
                  numberOfLines={1}
                  style={{ fontSize: 12, lineHeight: 16, color: colors.muted, marginBottom: 4 }}
                >
                  {status}
                </Text>
              </Pressable>
              {section === "chat" && <ComputerEntry />}
            </View>
            <View style={{ position: "absolute", right: 0, top: 16 }}>
              <IconButton
                icon={Bell}
                label={`通知，${pending} 条未读或待处理`}
                onPress={() => open({ type: "notifications" })}
              />
              {pending > 0 && (
                <View
                  pointerEvents="none"
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: 4,
                    position: "absolute",
                    top: 7,
                    right: 9,
                    backgroundColor: colors.blueDark,
                  }}
                />
              )}
            </View>
          </View>
          {section === "chat" ? (
            <View style={{ height: 1, backgroundColor: colors.line }} />
          ) : null}
          <View style={{ flex: 1, minHeight: 0 }}>
            {section !== "chat" && (
              <ScrollView
                key={section}
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: desktop ? 42 : 22, paddingBottom: 28 }}
                keyboardShouldPersistTaps="handled"
              >
                {utility && (
                  <Button
                    small
                    style={{ alignSelf: "flex-start", marginBottom: 18 }}
                    onPress={() => navigate("apps")}
                  >
                    返回应用
                  </Button>
                )}
                <Text style={[s.title, { fontSize: 25, marginBottom: 22 }]}>{title?.title}</Text>
                <ErrorNotice error={error} />
                <Screen />
              </ScrollView>
            )}
            <View
              style={{
                display: section === "chat" ? "flex" : "none",
                flex: 1,
                paddingHorizontal: desktop ? 42 : 17,
              }}
            >
              {richThreads && (threadsError || threadsLoading) ? (
                <ChatStatusScreen
                  busy={openingCopy.busy}
                  tone={openingCopy.tone}
                  title={openingCopy.title}
                  detail={openingCopy.detail}
                  note={statusServerNote(threadsError)}
                  actionLabel={threadsError ? openingCopy.actionLabel : undefined}
                  onAction={threadsError ? retryThreads : undefined}
                />
              ) : richThreads ? (
                <>
                  {selection.id !== mainId ? (
                    <ThreadTitleBar
                      {...sideThreadTitle(
                        catalog.threads.find((item) => item.id === selection.id)?.name,
                      )}
                    />
                  ) : null}
                  {visited.map((thread) => (
                    <View
                      key={thread.id}
                      style={{ display: selection.id === thread.id ? "flex" : "none", flex: 1 }}
                    >
                      <ChatScreen
                        thread={thread}
                        active={section === "chat" && selection.id === thread.id}
                        prompt={selection.id === thread.id ? prompt : undefined}
                      />
                    </View>
                  ))}
                </>
              ) : (
                <ChatScreen prompt={prompt} active={section === "chat"} />
              )}
            </View>
          </View>
          <View
            style={{
              paddingHorizontal: 22,
              paddingTop: 10,
              paddingBottom: desktop ? 22 : 7,
              alignItems: "center",
              display: keyboardOpen && !desktop ? "none" : "flex",
            }}
          >
            <View
              style={{
                flexDirection: "row",
                width: "100%",
                maxWidth: 370,
                padding: 5,
                backgroundColor: "#FFF",
                borderRadius: 40,
                shadowColor: "#132631",
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.07,
                shadowRadius: 18,
                elevation: 3,
                borderWidth: 1,
                borderColor: "#F8F8F8",
              }}
            >
              {nav.map((item) => {
                const active = section === item.id || (item.id === "apps" && utility);
                return (
                  <Pressable
                    key={item.id}
                    accessibilityRole="tab"
                    accessibilityLabel={item.label}
                    accessibilityState={{ selected: active }}
                    onPress={() => navigate(item.id)}
                    style={{
                      flex: 1,
                      height: 47,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: active ? "#F0F1F2" : "transparent",
                      borderRadius: 28,
                    }}
                  >
                    <item.icon size={23} strokeWidth={1.8} color={colors.text} />
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>
        {!!toast && (
          <View
            pointerEvents="box-none"
            style={{ position: "absolute", bottom: 94, left: 20, right: 20, alignItems: "center" }}
          >
            <View
              style={[
                s.row,
                {
                  gap: 10,
                  padding: 14,
                  backgroundColor: colors.text,
                  borderRadius: 20,
                  maxWidth: 560,
                },
              ]}
            >
              <Check size={16} color={colors.blue} />
              <Text style={{ color: "#FFF", fontSize: 13, flexShrink: 1 }}>{toast}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="关闭通知"
                onPress={clearToast}
              >
                <X size={16} color="#FFF" />
              </Pressable>
            </View>
          </View>
        )}
        {threadsOpen && <ThreadsSheet onClose={() => setThreadsOpen(false)} />}
        {detail && (
          <Details
            key={
              detail.type === "task"
                ? detail.taskId
                : detail.type === "file"
                  ? detail.file.id
                  : detail.type === "browser"
                    ? detail.browser.id
                    : detail.type === "mail"
                      ? detail.mail.id
                      : detail.type === "review"
                        ? detail.action.id
                        : detail.type === "email"
                          ? JSON.stringify(detail.draft)
                          : detail.type === "event"
                            ? detail.event?.id || "event-new"
                            : detail.type
            }
            detail={detail}
          />
        )}
      </SafeAreaView>
    </>
  );
}
