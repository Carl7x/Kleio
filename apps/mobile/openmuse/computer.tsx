import {
  FileText,
  FolderOpen,
  Globe2,
  Monitor,
  Plus,
  RefreshCw,
  Terminal,
} from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { AppState, Image, Pressable, Text, View } from "react-native";
import type { BrowserSession } from "../../../packages/openmuse-domain/src";
import type { ComputerSnapshot } from "../../../packages/openmuse-domain/src/computer";
import { browserAddress } from "./browser-address";
import { fileDetailLine } from "./chat-stream-rules";
import { useComputerDraft } from "./computer-drafts";
import { computerStatus } from "./computer-status";
import { LinuxWorkspace } from "./computer-workspace";
import { Button, Card, colors, ErrorNotice, Field, LinkRow, Sheet, s } from "./ui";
import { useWorkspace } from "./workspace";

export function ComputerEntry() {
  const { workspace, open } = useWorkspace();
  const available = workspace.connections.some(
    (c) => workspace.runtime.capabilities?.browser === true && c.id === "browser" && c.status === "connected",
  );
  const active = workspace.browsers.filter((b) => b.status === "active").length;
  const status = computerStatus(available, active);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`智能体电脑 — ${status}`}
      onPress={() => open({ type: "computer" })}
      style={[
        s.row,
        {
          alignSelf: "center",
          gap: 6,
          paddingHorizontal: 12,
          paddingVertical: 7,
          borderRadius: 20,
          backgroundColor: "#F1F3F4",
        },
      ]}
    >
      <Monitor size={13} color={colors.muted} />
      <Text style={{ fontSize: 12, color: colors.muted }}>电脑 · {status}</Text>
      <View
        style={{
          width: 5,
          height: 5,
          borderRadius: 3,
          backgroundColor: available ? "#57AD85" : "#ACB0B5",
        }}
      />
    </Pressable>
  );
}
export function BrowserThreadCard({ browser }: { browser: BrowserSession }) {
  const { open } = useWorkspace();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
  }, [browser.previewUrl, browser.updatedAt]);
  return (
    <Card
      style={{ padding: 13, backgroundColor: "#EEEEF0", gap: 12, maxWidth: 440, width: "100%" }}
    >
      <View style={[s.row, { gap: 10 }]}>
        <View style={[s.iconBox, { width: 36, height: 36, borderRadius: 9 }]}>
          <Globe2 size={21} color={colors.blueDark} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.text, { fontWeight: "600" }]}>浏览器</Text>
          <Text numberOfLines={1} style={s.small}>
            {browser.status === "closed"
              ? "会话已保存"
              : browser.status === "error"
                ? "需要关注"
                : browser.title}
          </Text>
        </View>
      </View>
      {browser.previewUrl && browser.status === "active" && !failed ? (
        <Image
          accessibilityLabel={`浏览器预览：${browser.title}`}
          source={{ uri: browser.previewUrl }}
          style={{ width: "100%", aspectRatio: 1.6, borderRadius: 11, backgroundColor: "#FFF" }}
          resizeMode="contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <View
          style={{
            padding: 24,
            borderRadius: 12,
            backgroundColor: "#FFF",
            alignItems: "center",
            gap: 10,
          }}
        >
          <Globe2 size={30} color={colors.muted} />
          <Text numberOfLines={2} style={[s.muted, { textAlign: "center" }]}>
            {failed ? "预览不可用。打开浏览器重新连接。" : browser.url}
          </Text>
        </View>
      )}
      <Button onPress={() => open({ type: "browser", browser })}>
        {browser.status === "closed"
          ? "重新打开浏览器"
          : browser.status === "error"
            ? "重新连接浏览器"
            : "接管控制"}
      </Button>
    </Card>
  );
}
const tabIcons = { Browser: Globe2, Desktop: Monitor, Terminal, Files: FolderOpen } as const;
export function ComputerSheet() {
  const { workspace, api, refresh, close, open, navigate } = useWorkspace();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useComputerDraft("tab");
  // Unknown until the first snapshot, so a remembered Desktop tab survives reopening.
  const [desktop, setDesktop] = useState<boolean>();
  const onSnapshot = useCallback((snapshot: ComputerSnapshot) => {
    // A transient provider error keeps the last known state instead of closing the tab.
    if (snapshot.status !== "error")
      setDesktop(snapshot.provider === "e2b-desktop" && snapshot.status === "running");
  }, []);
  // A remembered Desktop tab falls back to Terminal while the desktop is off; the draft
  // keeps "桌面", so the tab returns by itself once the computer runs again.
  const shown = desktop === false && tab === "桌面" ? "终端" : tab;
  const tabs = desktop
    ? (["浏览器", "桌面", "终端", "文件"] as const)
    : (["浏览器", "终端", "文件"] as const);
  const available = workspace.connections.some(
    (c) => workspace.runtime.capabilities?.browser === true && c.id === "browser" && c.status === "connected",
  );
  useEffect(() => {
    let active = true;
    const timer = setInterval(() => {
      if (AppState.currentState !== "active") return;
      void refresh().catch((e) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    }, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh]);
  async function create() {
    if (busy || !url.trim() || !workspace.runtime.capabilities?.browser) return;
    setBusy(true);
    setError("");
    try {
      const browser = await api.request<BrowserSession>("/api/browsers", {
        url: browserAddress(url),
      });
      await refresh();
      open({ type: "browser", browser });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet
      title="智能体电脑"
      subtitle="智能体在这里工作。需要时随时介入。"
      onClose={close}
    >
      <View style={{ gap: 20 }}>
        {shown === "浏览器" && (
          <View
            style={[s.row, { gap: 12, padding: 18, borderRadius: 20, backgroundColor: colors.sky }]}
          >
            <Monitor size={28} color={colors.blueDark} />
            <View style={{ flex: 1 }}>
              <Text style={s.heading}>{available ? "浏览器已连接" : "浏览器离线"}</Text>
              <Text style={s.muted}>
                {available
                  ? "智能体的浏览器与文档，集中在一处。"
                  : "启动浏览器工作进程以连接此电脑。"}
              </Text>
            </View>
          </View>
        )}
        <View style={[s.row, { gap: 8, flexWrap: "wrap" }]}>
          {tabs.map((item) => (
            <Button
              key={item}
              primary={shown === item}
              icon={tabIcons[item]}
              onPress={() => setTab(item)}
            >
              {item}
            </Button>
          ))}
        </View>
        <View style={{ display: shown === "浏览器" ? "none" : "flex" }}>
          <LinuxWorkspace tab={shown === "浏览器" ? "终端" : shown} onSnapshot={onSnapshot} />
        </View>
        {!workspace.runtime.capabilities?.computer && <Text style={s.small}>此工作台未启用。</Text>}
        <ErrorNotice error={error} />
        {shown === "浏览器" ? (
          <>
            <View>
              <Field
                label="网站地址"
                value={url}
                onChangeText={setUrl}
                placeholder="https://example.com"
                autoCapitalize="none"
                keyboardType="url"
                onSubmitEditing={() => void create()}
              />
              <Button
                primary
                icon={Plus}
                busy={busy}
                disabled={!available || !url.trim()}
                onPress={() => void create()}
              >
                打开浏览器会话
              </Button>
            </View>
            {[...workspace.browsers]
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
              .map((browser) => (
                <BrowserThreadCard key={browser.id} browser={browser} />
              ))}
            {!workspace.browsers.length && (
              <Text style={s.muted}>在此打开网页，或让智能体去做调研。浏览会话会出现在这里。</Text>
            )}
            <Text style={s.small}>浏览会话保留各自的登录与下载。打开即可接管，然后再回到对话。</Text>
          </>
        ) : tab === "文件" ? (
          <>
            <Text style={s.heading}>文档</Text>
            <Text style={s.small}>来自邮件、浏览器下载与上传的 PDF。</Text>
            {workspace.files.map((file) => (
              <LinkRow
                key={file.id}
                icon={FileText}
                title={file.name}
                detail={fileDetailLine({ pageCount: file.pageCount })}
                onPress={() => open({ type: "file", file })}
              />
            ))}
            <Button
              icon={Plus}
              onPress={() => {
                close();
                navigate("files");
              }}
            >
              导入文档
            </Button>
          </>
        ) : null}
        <Button
          small
          icon={RefreshCw}
          onPress={() =>
            void refresh()
              .then(() => setError(""))
              .catch((e) => setError(String(e)))
          }
        >
          刷新电脑
        </Button>
      </View>
    </Sheet>
  );
}
