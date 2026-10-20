import { Monitor } from "lucide-react-native";
import { useEffect, useState } from "react";
import { AppState, Image, Platform, Text, View } from "react-native";
import { z } from "zod";
import type { ComputerSnapshot } from "../../../packages/openmuse-domain/src/computer";
import { useComputerDraft } from "./computer-drafts";
import { DesktopStream } from "./desktop-stream";
import { ReceiptAction, StreamCard } from "./chat-stream";
import { desktopReceiptActions } from "./chat-stream-rules";
import { colors, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

const resultSchema = z.object({
  action: z.string().optional(),
  receiptId: z.string().optional(),
  error: z.string().optional(),
});
function parse(result: unknown) {
  if (typeof result !== "string") return undefined;
  try {
    const parsed = resultSchema.safeParse(JSON.parse(result));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Chat card for the agent's use_desktop tool: the live desktop on web, the latest
 * screenshot on native, or an offline notice with Start when the computer is stopped. */
export function DesktopToolCard({
  result,
  live = false,
  loading,
}: {
  toolCallId: string;
  live?: boolean;
  result: unknown;
  loading: boolean;
}) {
  const { api, open } = useWorkspace();
  const [, setTab] = useComputerDraft("tab");
  const latest = live;
  const value = parse(result);
  const [snapshot, setSnapshot] = useState<ComputerSnapshot>();
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  // Older cards never ask for the stream, so a long thread mounts one VNC session.
  // Poll only the newest card, including changes from the Desktop tab and idle pauses.
  // `loading` re-checks after a step; `starting` prevents an older poll undoing Start.
  useEffect(() => {
    if (!latest || starting) return;
    let alive = true,
      pending = false;
    const refresh = async () => {
      if (pending || AppState.currentState !== "active") return;
      pending = true;
      try {
        const next = await api.request<ComputerSnapshot>("/api/computer");
        if (alive) {
          setSnapshot(next);
          setError("");
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        pending = false;
      }
    };
    void refresh();
    const watching = Platform.OS === "web" && snapshot?.status === "running";
    const interval = loading || watching ? setInterval(() => void refresh(), 5000) : undefined;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void refresh();
    });
    return () => {
      alive = false;
      clearInterval(interval);
      subscription.remove();
    };
  }, [api, latest, loading, starting, snapshot?.status]);
  const running = snapshot?.status === "running";
  async function start() {
    setStarting(true);
    setError("");
    try {
      setSnapshot(await api.request<ComputerSnapshot>("/api/computer/start", {}));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  }
  const offline = latest && !!snapshot && !running;
  const hasDetails = Boolean(value?.error || error || (latest && snapshot));
  const receipts = desktopReceiptActions({ offline, starting });
  function openDesktop() {
    setTab("桌面");
    open({ type: "computer" });
  }
  return (
    <StreamCard
      collapsible={hasDetails}
      wide
      state={value?.error || error ? "error" : loading ? "running" : offline ? "paused" : "done"}
      title="桌面"
      detail={
        loading
          ? "正在使用桌面…"
          : value?.error
            ? "桌面步骤失败"
            : offline
              ? "电脑离线"
              : (value?.action ?? "桌面步骤")
      }
      icon={<Monitor size={16} color={value?.error ? colors.danger : colors.blueDark} />}
      action={
        <View style={{ gap: 6, alignItems: "flex-end" }}>
          {receipts.map((item) => (
            <ReceiptAction
              key={item.kind}
              label={item.label}
              disabled={item.kind === "start-computer" && starting}
              onPress={() => {
                if (item.kind === "start-computer") {
                  void start();
                  return;
                }
                openDesktop();
              }}
            />
          ))}
        </View>
      }
    >
      {hasDetails ? (
        <>
          <ErrorNotice error={value?.error || error} />
          {latest && snapshot && !running ? (
            <Text style={s.small}>电脑离线。启动后可查看桌面；之前打开的应用已关闭。</Text>
          ) : latest && running ? (
            Platform.OS === "web" ? (
              <DesktopStream running />
            ) : (
              <>
                {!!value?.receiptId && (
                  <Image
                    accessibilityLabel="最新桌面截图"
                    source={{
                      uri: api.url(`/api/computer/desktop/screenshot?receipt=${value.receiptId}`),
                      headers: { Authorization: `Bearer ${api.token}` },
                    }}
                    style={{ width: "100%", aspectRatio: 1.6, borderRadius: 12 }}
                    resizeMode="contain"
                  />
                )}
                <DesktopStream running embed={false} />
              </>
            )
          ) : null}
        </>
      ) : null}
    </StreamCard>
  );
}
