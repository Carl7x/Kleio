import { Bell, X } from "lucide-react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { useAgentWorkspace } from "./agent-workspace";
import { surfaceError } from "./chat-stream-rules";
import { colors, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

/**
 * One unread background notice, outside the transcript.
 * The full task stays in 动态 and the notification list. Chat does not open that sheet on send.
 */
export function BackgroundUpdates() {
  const { data, mutate } = useAgentWorkspace();
  const { open } = useWorkspace();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const updates = data?.notifications.filter((item) => !item.read && item.taskId) || [];
  const update = updates[0];
  if (!update || data?.identity.showChatUpdates === false) return null;
  async function dismiss() {
    if (!update) return;
    setBusy(true);
    try {
      await mutate(`/notifications/${update.id}/read`, {});
      setError("");
    } catch (e) {
      setError(surfaceError("这条更新没有放下。", e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(false);
    }
  }
  const extra = updates.length > 1 ? `，另有 ${updates.length - 1} 条` : "";
  return (
    <View style={{ marginBottom: 8, gap: 4 }}>
      <View
        style={[
          s.row,
          {
            gap: 8,
            paddingHorizontal: 12,
            paddingVertical: 8,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: colors.line,
            backgroundColor: colors.card,
          },
        ]}
      >
        <Bell size={14} color={colors.blueDark} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`后台更新：${update.title}。打开通知`}
          onPress={() => open({ type: "notifications" })}
          style={{ flex: 1 }}
        >
          <Text numberOfLines={1} style={s.muted}>
            {`后台更新 · ${update.title}${extra}`}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="关闭后台更新"
          disabled={busy}
          onPress={() => void dismiss()}
          hitSlop={10}
          style={{ padding: 6, opacity: busy ? 0.5 : 1 }}
        >
          <X size={16} color={colors.muted} />
        </Pressable>
      </View>
      <ErrorNotice error={error} />
    </View>
  );
}
