import {
  ArrowLeft,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  Monitor,
  Play,
  Power,
  RefreshCw,
  Save,
  Terminal,
  Upload,
} from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Platform, Text, View } from "react-native";
import type { Artifact } from "../../../packages/kleio-domain/src";
import type {
  ComputerCommand,
  ComputerDirectory,
  ComputerSnapshot,
} from "../../../packages/kleio-domain/src/computer";
import {
  computerCommandKeyboardHint,
  computerCommandStatus,
  computerDesktopHint,
  computerTerminalHint,
  computerWorkspaceNotice,
  surfaceError,
} from "./chat-stream-rules";
import { useComputerDraft } from "./computer-drafts";
import { DesktopStream } from "./desktop-stream";
import { Button, Card, colors, Empty, ErrorNotice, Field, LinkRow, s, timeLabel } from "./ui";
import { useWorkspace } from "./workspace";

const mono = Platform.OS === "ios" ? "Menlo" : "monospace";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const noted = (title: string, error: unknown) => surfaceError(title, message(error));

export function LinuxWorkspace({
  tab,
  onSnapshot,
}: {
  tab: "终端" | "文件" | "桌面";
  onSnapshot?: (snapshot: ComputerSnapshot) => void;
}) {
  const { api, workspace } = useWorkspace();
  const enabled = workspace.runtime.capabilities?.computer === true;
  const [snapshot, setSnapshot] = useState<ComputerSnapshot>();
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [busy, setBusy] = useState(false);
  const [command, setCommand] = useComputerDraft("command");
  const [cwd, setCwd] = useComputerDraft("cwd");
  const [executing, setExecuting] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [editingCommand, setEditingCommand] = useState(false);
  const version = useRef(0);
  const polling = useRef(false);
  const mutations = useRef(0);
  const refresh = useCallback(async () => {
    if (polling.current || mutations.current) return;
    polling.current = true;
    const request = ++version.current;
    try {
      const next = await api.request<ComputerSnapshot>("/api/computer");
      if (request === version.current) {
        setSnapshot(next);
        setConnectionError("");
      }
    } catch (e) {
      if (request === version.current) setConnectionError(noted("电脑没有连上。", e));
    } finally {
      polling.current = false;
    }
  }, [api]);
  useEffect(() => {
    const poll = () => {
      if (AppState.currentState !== "active") return;
      void refresh();
    };
    void refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") poll();
    });
    const watching = tab === "桌面" && Platform.OS === "web" && snapshot?.status === "running";
    const active =
      executing || busy || snapshot?.commands.some((item) => item.status === "running");
    const interval = watching || active ? setInterval(poll, 5000) : undefined;
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, [
    refresh,
    tab,
    executing,
    busy,
    snapshot?.status,
    snapshot?.commands.some((item) => item.status === "running"),
  ]);

  useEffect(
    () => () => {
      version.current++;
    },
    [refresh],
  );

  async function control(action: "start" | "stop") {
    if (busy || !enabled) return;
    setBusy(true);
    setError("");
    mutations.current++;
    const operation = ++version.current;
    try {
      const next = await api.request<ComputerSnapshot>(`/api/computer/${action}`, {});
      if (operation === version.current) setSnapshot(next);
    } catch (e) {
      setError(noted(action === "stop" ? "电脑没有停下来。" : "电脑没有启动。", e));
    } finally {
      setBusy(false);
      mutations.current--;
      void refresh();
    }
  }
  async function run() {
    if (!enabled || !command.trim() || executing || busy) return;
    const sent = command;
    setExecuting(true);
    setError("");
    mutations.current++;
    const operation = ++version.current;
    try {
      const result = await api.request<ComputerCommand>("/api/computer/commands", {
        command: sent,
        cwd,
      });
      if (operation === version.current)
        setSnapshot((current) =>
          current
            ? {
                ...current,
                commands: [result, ...current.commands.filter((item) => item.id !== result.id)],
              }
            : current,
        );
      setCommand((current) => (current === sent ? "" : current));
      setEditingCommand(false);
    } catch (e) {
      setError(noted("命令没有运行。", e));
    } finally {
      setExecuting(false);
      mutations.current--;
      void refresh();
    }
  }
  useEffect(() => {
    if (snapshot) onSnapshot?.(snapshot);
  }, [snapshot, onSnapshot]);
  const running = snapshot?.status === "running";
  const commandRunning = executing || snapshot?.commands.some((item) => item.status === "running");
  const workspaceNotice = computerWorkspaceNotice(snapshot?.message);
  return (
    <View style={{ gap: 16 }}>
      <Card style={{ backgroundColor: colors.sky, gap: 12 }}>
        <View style={[s.row, { gap: 12 }]}>
          <Terminal size={24} color={colors.blueDark} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={s.heading}>你的电脑工作区</Text>
            <Text style={s.muted}>
              {running
                ? "运行中 · 停止后文件仍保留"
                : snapshot?.status === "stopped"
                  ? "已停止 · 文件已保存"
                  : snapshot?.status === "unconfigured"
                    ? "先设置电脑再开始"
                    : snapshot?.status === "error"
                      ? "连接需要关注"
                      : "连接中…"}
            </Text>
          </View>
          {!snapshot && !error && <ActivityIndicator color={colors.blueDark} />}
        </View>
        {!!workspaceNotice && <Text style={s.small}>{workspaceNotice}</Text>}
        {snapshot?.enabled && enabled && (
          <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
            {running ? (
              <Button icon={Power} busy={busy} onPress={() => void control("stop")}>
                停止电脑
              </Button>
            ) : (
              <Button primary icon={Play} busy={busy} onPress={() => void control("start")}>
                启动电脑
              </Button>
            )}
            <Button
              icon={RefreshCw}
              disabled={busy}
              onPress={() =>
                void refresh()
                  .then(() => setError(""))
                  .catch((e) => setError(noted("电脑暂时没有刷新。", e)))
              }
            >
              刷新
            </Button>
          </View>
        )}
      </Card>
      {!enabled && <Text style={s.small}>此工作台未启用。</Text>}
      <ErrorNotice error={error || connectionError} />
      {!snapshot && (error || connectionError) && (
        <Button
          onPress={() =>
            void refresh()
              .then(() => setError(""))
              .catch((e) => setError(noted("电脑暂时没有刷新。", e)))
          }
        >
          重试连接
        </Button>
      )}
      {snapshot?.enabled && enabled && (
        <>
          <View style={{ display: tab === "终端" ? "flex" : "none", gap: 16 }}>
            {editingCommand || command.length > 0 || snapshot.commands.length === 0 ? (
              <View style={{ borderRadius: 22, backgroundColor: "#F1F3F4", padding: 18, gap: 8 }}>
                <Text style={{ color: colors.muted, fontSize: 12, fontFamily: mono }}>
                  终端
                </Text>
                <Field
                  label="工作目录"
                  value={cwd}
                  onChangeText={setCwd}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={{ fontFamily: mono }}
                />
                <Field
                  label="命令"
                  value={command}
                  onChangeText={setCommand}
                  placeholder="输入命令"
                  multiline
                  maxLength={16000}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  smartInsertDelete={false}
                  keyboardType="ascii-capable"
                  style={{ fontFamily: mono, minHeight: 80 }}
                />
                {/[‘’“”]/.test(command) && (
                  <Button
                    small
                    onPress={() =>
                      setCommand((text) => text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"'))
                    }
                  >
                    请用直引号
                  </Button>
                )}
                <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 18 }}>
                  {computerCommandKeyboardHint()}
                </Text>
                <Button
                  primary
                  icon={Play}
                  busy={!!commandRunning}
                  disabled={!running || !command.trim() || busy}
                  onPress={() => void run()}
                >
                  运行命令
                </Button>
                <Text style={{ color: colors.muted, fontSize: 12, lineHeight: 18 }}>
                  {computerTerminalHint(snapshot.network === "enabled")}
                </Text>
              </View>
            ) : (
              <Button
                primary
                icon={Terminal}
                disabled={!running || busy || !!commandRunning}
                onPress={() => setEditingCommand(true)}
              >
                新命令
              </Button>
            )}
            {!!commandRunning && (
              <Text style={s.muted}>
                工作中…结果会显示在这里。停止电脑可结束正在运行的命令。
              </Text>
            )}
            {snapshot.commands.length === 0 ? (
              <Empty
                icon={Terminal}
                title="可以输入第一条命令了"
                detail="在此运行脚本、处理文件，或让智能体创建内容。"
              />
            ) : (
              [...snapshot.commands]
                .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
                .slice(0, showHistory ? undefined : 5)
                .map((run) => <CommandReceipt key={run.id} run={run} />)
            )}
            {snapshot.commands.length > 5 && (
              <Button small onPress={() => setShowHistory(!showHistory)}>
                {showHistory ? "显示最近命令" : "更早的命令"}
              </Button>
            )}
          </View>
          <View style={{ display: tab === "文件" ? "flex" : "none" }}>
            <ComputerFiles running={!!running} active={tab === "文件"} />
          </View>
          {snapshot.provider === "e2b-desktop" && tab === "桌面" && (
            <ComputerDesktop running={!!running} />
          )}
        </>
      )}
    </View>
  );
}

// Live desktop, shared with the conversation's desktop card.
function ComputerDesktop({ running }: { running: boolean }) {
  if (!running)
    return (
      <Empty
        icon={Monitor}
        title="桌面未开启"
        detail="启动电脑以查看并控制桌面。"
      />
    );
  return (
    <View style={{ gap: 12 }}>
      <DesktopStream running />
      <Text style={s.small}>{computerDesktopHint()}</Text>
    </View>
  );
}

function CommandReceipt({ run }: { run: ComputerCommand }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <Card style={{ gap: 10 }}>
      <View style={[s.between, { gap: 10 }]}>
        <Text
          style={[
            s.small,
            {
              color:
                run.status === "succeeded"
                  ? "#248258"
                  : run.status === "running"
                    ? colors.blueDark
                    : colors.danger,
            },
          ]}
        >
          {computerCommandStatus(run.status, run.exitCode)}
        </Text>
        <Text style={s.small}>{timeLabel(run.startedAt)}</Text>
      </View>
      <Text
        selectable
        style={[s.text, { fontFamily: mono, fontSize: 13 }]}
      >{`$ ${run.command}`}</Text>
      <Text style={[s.small, { fontFamily: mono }]}>{run.cwd}</Text>
      {expanded && (
        <>
          {!!run.stdout && (
            <Text selectable style={[s.text, { fontFamily: mono, fontSize: 12, lineHeight: 19 }]}>
              {run.stdout}
            </Text>
          )}
          {!!run.stderr && (
            <Text
              selectable
              style={[
                s.text,
                { fontFamily: mono, fontSize: 12, lineHeight: 19, color: colors.danger },
              ]}
            >
              {run.stderr}
            </Text>
          )}
          {!run.stdout && !run.stderr && run.status !== "running" && (
            <Text style={s.small}>无输出</Text>
          )}
          {run.truncated && (
            <Text style={s.small}>
              输出已达显示上限。请将大结果写入文件。
            </Text>
          )}
        </>
      )}
      {!!(run.stdout || run.stderr) && (
        <Button small onPress={() => setExpanded(!expanded)}>
          {expanded ? "隐藏输出" : "显示输出"}
        </Button>
      )}
    </Card>
  );
}

function ComputerFiles({ running, active }: { running: boolean; active: boolean }) {
  const { api, workspace, open, refresh } = useWorkspace();
  running = running && workspace.runtime.capabilities?.computer === true;
  const [path, setPath] = useComputerDraft("path");
  const [directory, setDirectory] = useState<ComputerDirectory>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [retry, setRetry] = useState(0);
  const [editor, setEditor] = useComputerDraft("editor");
  const [folder, setFolder] = useState<string>();
  const [importing, setImporting] = useState(false);
  const dirty = !!editor && (editor.text !== editor.saved || editor.path !== editor.savedPath);
  useEffect(() => {
    if (!active || !running) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError("");
    void api
      .request<ComputerDirectory>(`/api/computer/files?path=${encodeURIComponent(path)}`)
      .then((value) => {
        if (alive) setDirectory(value);
      })
      .catch((e) => {
        if (alive) setError(noted("这个文件夹没有打开。", e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [api, active, running, path, retry]);

  async function read(file: string) {
    if (busy || loading || !running) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const content = await api.request<{ path: string; text: string }>(
        "/api/computer/files/read",
        { path: file },
      );
      if (mounted.current) setEditor({ ...content, saved: content.text, savedPath: content.path });
    } catch (e) {
      setError(noted("文件没有打开。", e));
    } finally {
      setBusy(false);
    }
  }
  async function importDocument(file: Artifact) {
    if (busy || !running) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.request("/api/computer/files/import", {
        fileId: file.id,
        path: `${path}/${file.name.replace(/[\\/]/g, "_")}`,
      });
      setImporting(false);
      setNotice("文档已复制到你的电脑。");
      setRetry((value) => value + 1);
    } catch (e) {
      setError(noted("文档没有复制过去。", e));
    } finally {
      setBusy(false);
    }
  }
  async function openPdf(path: string) {
    if (busy || !running) return;
    setBusy(true);
    setError("");
    try {
      const file = await api.request<Artifact>("/api/computer/files/export", { path });
      await refresh();
      if (mounted.current) open({ type: "file", file });
    } catch (e) {
      setError(noted("这份 PDF 没有打开。", e));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!editor || busy) return;
    const sent = editor;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api.request("/api/computer/files/write", { path: sent.path, text: sent.text });
      if (mounted.current)
        setEditor((current) =>
          current?.path === sent.path
            ? { ...current, saved: sent.text, savedPath: sent.path }
            : current,
        );
      setNotice("文件已保存到你的电脑。");
      setRetry((value) => value + 1);
    } catch (e) {
      setError(noted("文件没有保存。", e));
    } finally {
      setBusy(false);
    }
  }
  async function mkdir() {
    if (!folder?.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.request("/api/computer/files/mkdir", { path: `${path}/${folder.trim()}` });
      setFolder(undefined);
      setRetry((value) => value + 1);
    } catch (e) {
      setError(noted("文件夹没有创建。", e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: 12 }}>
      <View style={s.between}>
        <Text style={s.heading}>工作区文件</Text>
        {(busy || loading) && <ActivityIndicator color={colors.blueDark} />}
      </View>
      <Text selectable style={[s.small, { fontFamily: mono }]}>
        {editor?.path || path}
      </Text>
      <ErrorNotice error={error} />
      {!!notice && <Text style={[s.small, { color: "#248258" }]}>{notice}</Text>}
      {!running && (
        <Text style={s.muted}>启动电脑以浏览或编辑已保存的文件。</Text>
      )}
      {editor ? (
        <>
          <Field
            label="文件路径"
            value={editor.path}
            onChangeText={(value) => setEditor({ ...editor, path: value })}
            autoCorrect={false}
            autoCapitalize="none"
            style={{ fontFamily: mono }}
          />
          <Field
            label="文件内容"
            value={editor.text}
            onChangeText={(value) => setEditor({ ...editor, text: value })}
            multiline
            autoCorrect={false}
            spellCheck={false}
            smartInsertDelete={false}
            keyboardType="ascii-capable"
            autoCapitalize="none"
            style={{ fontFamily: mono, minHeight: 240, fontSize: 13 }}
          />
          <View style={[s.row, { flexWrap: "wrap", gap: 8 }]}>
            <Button
              primary
              icon={Save}
              busy={busy}
              disabled={!running || !editor.path.trim()}
              onPress={() => void save()}
            >
              保存文件
            </Button>
            <Button
              disabled={busy}
              icon={ArrowLeft}
              onPress={() => {
                setEditor(undefined);
                setNotice("");
              }}
            >
              {dirty ? "放弃修改" : "返回文件"}
            </Button>
          </View>
        </>
      ) : (
        <>
          <View style={[s.row, { flexWrap: "wrap", gap: 8 }]}>
            {path !== "/workspace" && (
              <Button
                small
                disabled={busy}
                icon={ArrowLeft}
                onPress={() => setPath(path.slice(0, path.lastIndexOf("/")) || "/workspace")}
              >
                上级
              </Button>
            )}
            <Button
              small
              disabled={!running || busy}
              icon={FilePlus2}
              onPress={() => {
                setNotice("");
                setEditor({
                  path: `${path}/note-${Date.now()}.txt`,
                  text: "",
                  saved: "",
                  savedPath: "",
                });
              }}
            >
              新建文件
            </Button>
            <Button
              small
              disabled={!running || busy}
              icon={FolderPlus}
              onPress={() => setFolder("")}
            >
              新建文件夹
            </Button>
            <Button
              small
              disabled={!running || busy}
              icon={RefreshCw}
              onPress={() => setRetry(retry + 1)}
            >
              刷新文件
            </Button>
            <Button
              small
              disabled={!running || busy}
              icon={Upload}
              onPress={() => setImporting(!importing)}
            >
              {importing ? "隐藏文档" : "把文档复制到这里"}
            </Button>
          </View>
          {importing && (
            <Card>
              <Text style={s.heading}>选择已保存的 PDF</Text>
              <Text style={[s.small, { marginTop: 6 }]}>
                复制到此文件夹。同名文件将被替换。
              </Text>
              {workspace.files.map((file) => (
                <LinkRow
                  key={file.id}
                  icon={FileText}
                  title={file.name}
                  onPress={() => void importDocument(file)}
                />
              ))}
              {!workspace.files.length && (
                <Text style={s.muted}>请先从邮件或「文件」添加文档。</Text>
              )}
            </Card>
          )}
          {folder !== undefined && (
            <Card style={{ gap: 8 }}>
              <Field
                label="文件夹名称"
                value={folder}
                onChangeText={setFolder}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <View style={[s.row, { gap: 8 }]}>
                <Button
                  primary
                  disabled={!running || !folder.trim()}
                  busy={busy}
                  onPress={() => void mkdir()}
                >
                  创建文件夹
                </Button>
                <Button disabled={busy} onPress={() => setFolder(undefined)}>
                  取消
                </Button>
              </View>
            </Card>
          )}
          {running &&
            directory?.path === path &&
            directory.entries.map((entry) => (
              <LinkRow
                key={entry.path}
                icon={entry.type === "directory" ? Folder : FileText}
                title={entry.name}
                detail={
                  entry.type === "directory"
                    ? "文件夹"
                    : entry.type === "symlink"
                      ? "符号链接"
                      : `${Math.max(1, Math.ceil(entry.size / 1024))} KB`
                }
                onPress={() => {
                  if (busy || loading || !running) return;
                  if (entry.type === "directory") {
                    setNotice("");
                    setPath(entry.path);
                  } else if (/\.pdf$/i.test(entry.name)) void openPdf(entry.path);
                  else void read(entry.path);
                }}
              />
            ))}
          {running &&
            !busy &&
            !loading &&
            !error &&
            directory?.path === path &&
            directory.entries.length === 0 && (
              <Empty
                icon={Folder}
                title="一点创作空间"
                detail="在此添加文件，或让智能体在工作区创建。"
              />
            )}
        </>
      )}
    </View>
  );
}
