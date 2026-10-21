import { useThreads } from "./kleio-headless";
import { randomUUID } from "expo-crypto";
import {
  Archive,
  CalendarDays,
  FileText,
  MessageCircle,
  Monitor,
  Plus,
  RefreshCw,
  Settings2,
} from "lucide-react-native";
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ChatStatusScreen, ThreadNotice } from "./chat-stream";
import {
  sheetListStatus,
  shellProfileSubtitle,
  statusServerNote,
  threadStatusCopy,
} from "./chat-stream-rules";
import { Button, colors, Field, LinkRow, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

function newThreadId() {
  return randomUUID();
}
export type Selection = { id: string; existing: boolean };
const ThreadContext = createContext<{
  enabled: boolean;
  selection: Selection;
  visited: Selection[];
  mainId: string;
  loading: boolean;
  error: string;
  retry: () => void;
  select: (selection: Selection) => void;
  start: () => void;
  claimPrompt: (id: number) => boolean;
} | null>(null);
export function ThreadsProvider({ children }: { children: ReactNode }) {
  const { workspace, navigate, api } = useWorkspace();
  const handledPrompt = useRef(0);
  const enabled = workspace.runtime.richThreads === true;
  const [selection, setSelection] = useState<Selection>({ id: "local", existing: false });
  const [visited, setVisited] = useState<Selection[]>([]);
  const [mainId, setMainId] = useState("local");
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true);
    setError("");
    void api
      .request<{ threadId: string; existing: boolean }>("/api/main-thread")
      .then((main) => {
        if (!active) return;
        const next = { id: main.threadId, existing: main.existing };
        setMainId(next.id);
        setSelection(next);
        setVisited([next]);
        setLoading(false);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      active = false;
    };
  }, [api, enabled, attempt]);
  function select(next: Selection) {
    setSelection(next);
    setVisited((items) => (items.some((item) => item.id === next.id) ? items : [...items, next]));
    navigate("chat");
  }
  return (
    <ThreadContext.Provider
      value={{
        claimPrompt: (id) => {
          if (handledPrompt.current === id) return false;
          handledPrompt.current = id;
          return true;
        },
        enabled,
        mainId,
        visited,
        loading,
        error,
        retry: () => setAttempt((n) => n + 1),
        selection,
        select,
        start: () => select({ id: newThreadId(), existing: false }),
      }}
    >
      {children}
    </ThreadContext.Provider>
  );
}
export function useMuseThread() {
  const context = useContext(ThreadContext);
  if (!context) throw new Error("对话列表暂不可用");
  return context;
}
export function ThreadsSheet({ onClose }: { onClose: () => void }) {
  const {
    enabled,
    selection,
    visited,
    mainId,
    loading,
    error: mainError,
    retry,
    select,
    start,
  } = useMuseThread();
  const { workspace, open, navigate, refresh } = useWorkspace();
  const threads = useThreads({ agentId: "default", enabled, includeArchived: true, limit: 20 });
  const [editing, setEditing] = useState<string>();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [archived, setArchived] = useState(false);
  async function mutate(action: () => Promise<void>) {
    setError("");
    try {
      await action();
      setEditing(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  function go(section: "calendar" | "files" | "apps") {
    onClose();
    navigate(section);
  }
  const opening = threadStatusCopy(mainError ? "opening-failed" : "opening");
  const listLoading = sheetListStatus("loading");
  const listFailed = sheetListStatus("failed");
  const listEmpty = sheetListStatus(archived ? "empty-archived" : "empty");
  const moreFailed = sheetListStatus("more-failed");
  const actionFailed = sheetListStatus("action-failed");
  const savedThreads = threads.threads.filter(
    (thread) => thread.id !== mainId && thread.archived === archived,
  );
  const draftThreads = archived
    ? []
    : visited.filter(
        (item) => item.id !== mainId && !threads.threads.some((saved) => saved.id === item.id),
      );
  return (
    <Sheet
      title="Kleio"
      subtitle={shellProfileSubtitle(workspace.profile.name, workspace.mode === "sample")}
      onClose={onClose}
      closeLabel="关闭"
    >
      <View style={{ gap: 14 }}>
        {enabled && loading ? (
          <ChatStatusScreen
            compact
            busy={opening.busy}
            tone={opening.tone}
            title={opening.title}
            detail={opening.detail}
            note={mainError ? statusServerNote(mainError) : undefined}
            actionLabel={mainError ? opening.actionLabel : undefined}
            onAction={mainError ? retry : undefined}
          />
        ) : enabled ? (
          <>
            <LinkRow
              icon={MessageCircle}
              title="主对话"
              detail="正在进行的对话"
              onPress={() => {
                select({ id: mainId, existing: true });
                onClose();
              }}
            />
            <Button
              primary
              icon={Plus}
              onPress={() => {
                start();
                onClose();
              }}
            >
              新建旁路对话
            </Button>
            <View style={[s.between, { marginTop: 12 }]}>
              <Text style={s.heading}>旁路对话</Text>
              <Button small onPress={() => setArchived(!archived)}>
                {archived ? "进行中" : "已归档"}
              </Button>
            </View>
            {threads.isLoading ? (
              <ChatStatusScreen
                compact
                busy={listLoading.busy}
                tone={listLoading.tone}
                title={listLoading.title}
                detail={listLoading.detail}
              />
            ) : threads.error ? (
              <ChatStatusScreen
                compact
                busy={listFailed.busy}
                tone={listFailed.tone}
                title={listFailed.title}
                detail={listFailed.detail}
                note={statusServerNote(threads.error.message)}
                actionLabel={listFailed.actionLabel}
                onAction={() => void threads.refetchThreads()}
              />
            ) : null}
            {error ? (
              <ThreadNotice
                title={actionFailed.title}
                detail={actionFailed.detail}
                note={statusServerNote(error)}
                tone={actionFailed.tone}
              />
            ) : null}
            {draftThreads.map((item, index) => (
              <LinkRow
                key={item.id}
                icon={MessageCircle}
                title={`旁路对话 ${index + 1}`}
                detail="在本应用中打开"
                onPress={() => {
                  select(item);
                  onClose();
                }}
              />
            ))}
            {savedThreads.map((thread) => (
                <View
                  key={thread.id}
                  style={{
                    paddingVertical: 12,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.line,
                    gap: 10,
                  }}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`打开对话：${thread.name || "未命名对话"}`}
                    accessibilityState={{ selected: selection.id === thread.id }}
                    onPress={() => {
                      select({ id: thread.id, existing: true });
                      onClose();
                    }}
                    style={[s.row, { gap: 10 }]}
                  >
                    <MessageCircle size={19} color={colors.text} />
                    <Text style={[s.text, { flex: 1 }]}>
                      {thread.name || "未命名对话"}
                    </Text>
                  </Pressable>
                  {editing === thread.id && (
                    <Field label="对话名称" value={name} onChangeText={setName} />
                  )}
                  <View style={[s.row, { gap: 8 }]}>
                    <Button
                      small
                      disabled={threads.isMutating || (editing === thread.id && !name.trim())}
                      onPress={() => {
                        if (editing === thread.id)
                          void mutate(() => threads.renameThread(thread.id, name.trim()));
                        else {
                          setEditing(thread.id);
                          setName(thread.name || "");
                        }
                      }}
                    >
                      {editing === thread.id ? "保存名称" : "重命名"}
                    </Button>
                    <Button
                      small
                      icon={Archive}
                      disabled={threads.isMutating}
                      onPress={() =>
                        void mutate(() =>
                          thread.archived
                            ? threads.unarchiveThread(thread.id)
                            : threads.archiveThread(thread.id),
                        )
                      }
                    >
                      {thread.archived ? "恢复" : "归档"}
                    </Button>
                  </View>
                </View>
              ))}
            {!threads.isLoading && !threads.error && savedThreads.length === 0 && draftThreads.length === 0 ? (
              <ChatStatusScreen
                compact
                busy={listEmpty.busy}
                tone={listEmpty.tone}
                title={listEmpty.title}
                detail={listEmpty.detail}
              />
            ) : null}
            {threads.fetchMoreError ? (
              <ChatStatusScreen
                compact
                busy={moreFailed.busy}
                tone={moreFailed.tone}
                title={moreFailed.title}
                detail={moreFailed.detail}
                note={statusServerNote(threads.fetchMoreError.message)}
                actionLabel={moreFailed.actionLabel}
                onAction={threads.fetchMoreThreads}
              />
            ) : threads.hasMoreThreads ? (
              <Button small busy={threads.isFetchingMoreThreads} onPress={threads.fetchMoreThreads}>
                加载更多对话
              </Button>
            ) : null}
            <Text style={s.small}>
              旁路对话有各自上下文。智能体已保存的记忆是共享的。
            </Text>
          </>
        ) : (
          <>
            <LinkRow
              icon={MessageCircle}
              title="主对话"
              detail="保存在此工作台"
              onPress={() => {
                navigate("chat");
                onClose();
              }}
            />
            <Text style={s.muted}>
              对话保存在此工作台。可在「应用」中管理连接。
            </Text>
          </>
        )}
        <View style={s.divider} />
        <LinkRow
          icon={Plus}
          title="委托任务"
          detail="计划、文档或开支摘要"
          onPress={() => {
            onClose();
            open({ type: "delegate" });
          }}
        />
        <LinkRow
          icon={Monitor}
          title="智能体电脑"
          detail="浏览器、会话与文档"
          onPress={() => {
            onClose();
            open({ type: "computer" });
          }}
        />
        <LinkRow icon={CalendarDays} title="日历" onPress={() => go("calendar")} />
        <LinkRow icon={FileText} title="文件" onPress={() => go("files")} />
        <LinkRow icon={Settings2} title="应用与设置" onPress={() => go("apps")} />
        <Button small icon={RefreshCw} onPress={() => void mutate(refresh)}>
          刷新工作台
        </Button>
      </View>
    </Sheet>
  );
}
