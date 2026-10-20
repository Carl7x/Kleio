import { Globe2, RotateCw } from "lucide-react-native";
import { createContext, useContext, useEffect, useState } from "react";
import { AppState, Image, Text, View } from "react-native";
import { z } from "zod";
import type { BrowserSession } from "../../../packages/openmuse-domain/src";
import { ReceiptAction, SkeletonLine, StreamCard } from "./chat-stream";
import { browserReceiptAction } from "./chat-stream-rules";
import { Button, colors, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

export const BrowserRunContext = createContext({ running: false, active: false });

const observationSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  url: z.url(),
});

function resultValue(result: unknown) {
  if (typeof result !== "string") return result;
  try {
    return JSON.parse(result);
  } catch {
    return undefined;
  }
}

function siteLabel(url: unknown) {
  if (typeof url !== "string") return "正在打开页面";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "正在打开页面";
  }
}

/** A server tool result stays with the request that produced it, including on replay. */
export function BrowserToolCard({
  url,
  result,
  loading,
}: {
  url: unknown;
  result: unknown;
  loading: boolean;
}) {
  const { api, workspace, open } = useWorkspace();
  const { running, active } = useContext(BrowserRunContext);
  const working = loading && active;
  const value = resultValue(result);
  const observation = observationSchema.safeParse(value);
  const toolError = z.object({ error: z.string() }).safeParse(value);
  const sessionId = observation.success ? observation.data.sessionId : undefined;
  const current = workspace.browsers.find((browser) => browser.id === sessionId);
  const [browser, setBrowser] = useState<BrowserSession>();
  const [error, setError] = useState("");
  const [previewFailed, setPreviewFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!sessionId) return;
    let active = true;
    async function connect() {
      setError("");
      setPreviewFailed(false);
      try {
        const session = await api.request<BrowserSession>(
          `/api/browsers/${encodeURIComponent(sessionId || "")}`,
        );
        if (active) setBrowser(session);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : String(e));
      }
    }
    void connect();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void connect();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, [api, sessionId, current?.updatedAt, retry]);

  const visited = observation.success ? observation.data : undefined;
  // A later turn can reuse the same browser. Never label that new page as an old source.
  const preview =
    browser?.status === "active" && browser.url === visited?.url && !previewFailed
      ? browser.previewUrl
      : undefined;
  const failure = toolError.success
    ? toolError.data.error
    : !loading && !visited
      ? "浏览器未返回页面。请再试一次。"
      : "";
  const browserState =
    failure || error ? "error" : working ? "running" : loading ? "paused" : visited ? "done" : "paused";
  const receipt = browserReceiptAction({ loading, hasVisit: Boolean(visited) });
  return (
    <StreamCard
      collapsible
      state={browserState}
      title="浏览器"
      detail={
        working
          ? "正在阅读页面…"
          : loading
            ? "浏览已暂停"
            : failure
              ? "无法阅读该页面"
              : siteLabel(visited?.url)
      }
      icon={<Globe2 size={16} color={failure ? colors.danger : colors.blueDark} />}
      action={
        receipt ? (
          <ReceiptAction
            label={receipt.label}
            disabled={!browser || running}
            onPress={() => browser && open({ type: "browser", browser })}
          />
        ) : null
      }
    >
      {preview ? (
        <Image
          accessibilityLabel={`浏览器预览：${visited?.title}`}
          source={{ uri: api.url(preview) }}
          style={{ width: "100%", aspectRatio: 1.7, borderRadius: 12, backgroundColor: "#FFF" }}
          resizeMode="contain"
          onError={() => setPreviewFailed(true)}
        />
      ) : (
        <View style={{ backgroundColor: "#FAFAFB", borderRadius: 12, padding: 21, gap: 12 }}>
          <Text numberOfLines={2} style={[s.text, { fontSize: 14 }]}>
            {visited?.title || siteLabel(url)}
          </Text>
          {working ? (
            <View style={{ gap: 8 }}>
              {(["90%", "74%", "84%"] as const).map((width) => (
                <SkeletonLine key={width} width={width} />
              ))}
            </View>
          ) : visited ? (
            <Text style={s.small}>
              {browser && browser.url !== visited.url
                ? "已访问该页。浏览器已继续。"
                : browser?.status === "closed"
                  ? "会话已保存。接管即可重新打开。"
                  : browser?.status === "error"
                    ? "会话需要关注。接管即可重新连接。"
                    : previewFailed
                      ? "预览不可用。你仍可接管控制。"
                      : "正在连接已保存的会话…"}
            </Text>
          ) : null}
        </View>
      )}
      <ErrorNotice error={failure || error} />
      {!!error && (
        <Button small icon={RotateCw} onPress={() => setRetry((attempt) => attempt + 1)}>
          重新连接预览
        </Button>
      )}
    </StreamCard>
  );
}
