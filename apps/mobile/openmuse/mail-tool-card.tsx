import { Mail, Search } from "lucide-react-native";
import { useContext } from "react";
import { Text } from "react-native";
import { z } from "zod";
import { BrowserRunContext } from "./browser-tool-card";
import { StreamCard } from "./chat-stream";
import { Button, colors, ErrorNotice, s } from "./ui";
import { useWorkspace } from "./workspace";

const messageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  sender: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  subject: z.string(),
  body: z.string(),
  date: z.string(),
  unread: z.boolean(),
  label: z.string(),
  attachments: z.array(z.string()),
});

export function MailToolCard({
  result,
  loading,
  search = false,
}: {
  result: unknown;
  loading: boolean;
  search?: boolean;
}) {
  const { open } = useWorkspace();
  const { active } = useContext(BrowserRunContext);
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = undefined;
    }
  }
  const error = z.object({ error: z.string() }).safeParse(value);
  if (error.success)
    return (
      <StreamCard state="error" title="无法读取邮件" icon={<Mail size={16} color={colors.danger} />}>
        <ErrorNotice error={error.data.error} />
      </StreamCard>
    );
  if (loading)
    return (
      <StreamCard
        state={active ? "running" : "paused"}
        title={!active ? "邮件阅读已暂停" : search ? "正在查看收件箱…" : "正在阅读邮件…"}
        icon={<Mail size={16} color={colors.blueDark} />}
      />
    );
  if (search) {
    const parsed = z
      .object({ matches: z.array(z.object({ id: z.string() })), truncated: z.boolean() })
      .safeParse(value);
    if (!parsed.success)
      return (
        <StreamCard state="error" title="无法读取邮件" icon={<Search size={16} color={colors.danger} />}>
          <ErrorNotice error="邮箱未返回可读结果。" />
        </StreamCard>
      );
    const count = parsed.data.matches.length;
    return (
      <StreamCard
        state={count ? "done" : "paused"}
        title={
          count
            ? `找到${parsed.data.truncated ? "至少 " : " "}${count} 封邮件`
            : "没有匹配的邮件"
        }
        icon={<Search size={16} color={colors.blueDark} />}
      />
    );
  }
  const parsed = z
    .object({ messages: z.array(messageSchema), truncated: z.boolean() })
    .safeParse(value);
  if (!parsed.success)
    return (
      <StreamCard state="error" title="无法显示该邮件" icon={<Mail size={16} color={colors.danger} />}>
        <ErrorNotice error="无法显示该邮件。" />
      </StreamCard>
    );
  const message = parsed.data.messages.at(-1);
  if (!message)
    return (
      <StreamCard state="paused" title="此会话中没有消息" icon={<Mail size={16} color={colors.muted} />} />
    );
  return (
    <StreamCard
      state="done"
      title={message.sender}
      detail={`邮件 · ${parsed.data.messages.length} 封`}
      icon={<Mail size={16} color={colors.blueDark} />}
    >
      <Text style={s.heading}>{message.subject}</Text>
      <Text style={s.muted} numberOfLines={3}>
        {message.body}
      </Text>
      {parsed.data.truncated && <Text style={s.small}>显示此会话的摘录。</Text>}
      <Button small icon={Mail} onPress={() => open({ type: "mail", mail: message })}>
        打开邮件
      </Button>
    </StreamCard>
  );
}
