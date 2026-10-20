import { Search } from "lucide-react-native";
import { useContext, useState } from "react";
import { Linking, Text, View } from "react-native";
import { z } from "zod";
import { BrowserRunContext } from "./browser-tool-card";
import { StreamCard } from "./chat-stream";
import { colors, ErrorNotice, s } from "./ui";

const resultSchema = z.object({
  results: z.array(z.object({ url: z.url({ protocol: /^https?$/ }), title: z.string().nullish() })),
  warnings: z.array(z.string()),
  truncated: z.boolean(),
});

export function SearchToolCard({ result, loading }: { result: unknown; loading: boolean }) {
  const { active } = useContext(BrowserRunContext);
  const [linkError, setLinkError] = useState("");
  let value = result;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = undefined;
    }
  }
  const error = z.object({ error: z.string() }).safeParse(value);
  const parsed = resultSchema.safeParse(value);
  const working = loading && active;
  const failure = error.success
    ? error.data.error
    : !loading && !parsed.success
      ? "搜索未返回可读结果。"
      : "";
  const sources = parsed.success
    ? [...new Map(parsed.data.results.map((source) => [source.url, source])).values()]
    : [];
  const count = sources.length;
  const hasBody =
    Boolean(failure || linkError) ||
    (!loading &&
      parsed.success &&
      (count > 0 || parsed.data.truncated || parsed.data.warnings.length > 0));
  const title = failure
    ? "搜索失败"
    : working
      ? "正在搜索网页…"
      : loading
        ? "搜索已停止"
        : count
          ? `找到 ${count} 个来源`
          : "未找到来源";
  return (
    <StreamCard
      collapsible={hasBody}
      state={failure ? "error" : working ? "running" : loading ? "paused" : "done"}
      title={title}
      icon={<Search size={16} color={failure ? colors.danger : colors.blueDark} />}
    >
      {!loading && parsed.success && (
        <View style={{ gap: 6 }}>
          {sources.map((source) => (
            <Text
              key={source.url}
              accessibilityRole="link"
              style={[s.text, { color: colors.blueDark }]}
              onPress={() => {
                setLinkError("");
                void Linking.openURL(source.url).catch(() =>
                  setLinkError("无法打开该来源。"),
                );
              }}
            >
              {source.title || source.url}
            </Text>
          ))}
          {parsed.data.truncated && (
            <Text style={s.small}>部分搜索结果或摘录已省略。</Text>
          )}
          {[...new Set(parsed.data.warnings)].map((warning) => (
            <Text key={warning} style={s.small}>
              {warning}
            </Text>
          ))}
        </View>
      )}
      <ErrorNotice error={failure || linkError} />
    </StreamCard>
  );
}
