import { Check, ExternalLink } from "lucide-react-native";
import { createContext, useContext, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, Text, View } from "react-native";
import type { JevOption, JevPanel } from "../../../packages/openmuse-domain/src/jev";
import {
  choiceAvailability,
  parseJevResult,
  retryChoiceAvailable,
  selectionText,
} from "./jev-actions";
import { StreamCard } from "./chat-stream";
import { Button, colors, ErrorNotice, s } from "./ui";

type JevInteraction = {
  threadId: string | null;
  busy: boolean;
  latestPanelId: string | null;
  latestUserText: string | null;
  send: (text: string) => Promise<void>;
  retry: (text: string) => Promise<void>;
  canRetry: boolean;
  confirmedSelection: (panelId: string) => string | null;
};

export const JevInteractionContext = createContext<JevInteraction>({
  threadId: null,
  busy: true,
  latestPanelId: null,
  latestUserText: null,
  canRetry: false,
  confirmedSelection: () => null,
  send: async () => {
    throw new Error("打开进行中的对话以选择选项。");
  },
  retry: async () => {
    throw new Error("打开进行中的对话以重试选择。");
  },
});

function SourceLink({ title, url }: { title: string; url: string }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`来源：${title}`}
      onPress={() => void Linking.openURL(url)}
      style={({ pressed }) => [s.row, { gap: 4, opacity: pressed ? 0.65 : 1 }]}
    >
      <Text style={[s.small, { color: colors.blueDark, textDecorationLine: "underline" }]}>
        {title}
      </Text>
      <ExternalLink size={12} color={colors.blueDark} />
    </Pressable>
  );
}

function ChoiceButton({
  panel,
  option,
  disabled,
  pending,
  selected,
  position,
  onChoose,
}: {
  panel: JevPanel;
  option: JevOption;
  disabled: boolean;
  pending: boolean;
  selected: boolean;
  position: number;
  onChoose: (optionId: string) => void;
}) {
  if (panel.type === "comparison") {
    const caption = /exhibit/i.test(panel.title) ? "选择此展品" : "选择此选项";
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${caption}：${option.label}（第 ${position} 项）`}
        accessibilityState={{ disabled: disabled || pending, busy: pending, selected }}
        disabled={disabled || pending}
        onPress={() => onChoose(option.id)}
        style={({ pressed }) => [
          s.button,
          { alignSelf: "flex-start", backgroundColor: selected ? colors.green : colors.blue },
          (disabled || pending) && { opacity: 0.5 },
          pressed && { transform: [{ scale: 0.98 }] },
        ]}
      >
        {pending ? (
          <ActivityIndicator size="small" color={colors.text} />
        ) : selected ? (
          <Check size={15} color={colors.text} />
        ) : null}
        <Text style={s.buttonText}>{caption}</Text>
      </Pressable>
    );
  }
  return (
    <Button
      small
      disabled={disabled}
      busy={pending}
      icon={selected ? Check : undefined}
      onPress={() => onChoose(option.id)}
      style={selected ? { backgroundColor: colors.green } : undefined}
    >
      {option.label}
    </Button>
  );
}

export function JevToolCard({ result, loading }: { result: unknown; loading: boolean }) {
  const interaction = useContext(JevInteractionContext);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [confirmedId, setConfirmedId] = useState<string | null>(null);
  const [failedOptionId, setFailedOptionId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState("");
  const pendingRef = useRef(false);
  if (loading) return <StreamCard state="running" title="正在准备选项…" />;

  const parsed = parseJevResult(result);
  if (!parsed) return <ErrorNotice error="无法显示选项。请重试。" />;
  if (parsed.error) return <ErrorNotice error={parsed.error} />;
  const panel = parsed.panel;
  if (!panel) return null;

  const availability = choiceAvailability(
    panel,
    interaction.threadId || "",
    interaction.latestPanelId,
    interaction.busy,
    submittingId !== null ||
      confirmedId !== null ||
      interaction.confirmedSelection(panel.id) !== null,
  );
  const stale = availability === "wrong-thread" || availability === "stale";
  const selectedId = panel.selectedId || confirmedId || interaction.confirmedSelection(panel.id);
  const preferredOption = panel.preferredId
    ? panel.options.find((option) => option.id === panel.preferredId)
    : undefined;
  const disabled = availability !== "ready";

  async function choose(optionId: string, retrying = false) {
    const priorConfirmedId =
      panel?.selectedId || confirmedId || (panel && interaction.confirmedSelection(panel.id));
    if (
      !panel ||
      pendingRef.current ||
      priorConfirmedId ||
      (retrying
        ? !retryChoiceAvailable(
            panel,
            interaction.threadId || "",
            interaction.latestPanelId,
            failedOptionId,
            interaction.latestUserText,
            !!priorConfirmedId,
            !interaction.canRetry,
          ) || optionId !== failedOptionId
        : choiceAvailability(
            panel,
            interaction.threadId || "",
            interaction.latestPanelId,
            interaction.busy,
            false,
          ) !== "ready")
    )
      return;
    pendingRef.current = true;
    setSubmittingId(optionId);
    setSubmitError("");
    try {
      await (retrying ? interaction.retry : interaction.send)(selectionText(panel, optionId));
      setConfirmedId(optionId);
      setFailedOptionId(null);
    } catch (error) {
      setFailedOptionId(optionId);
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      pendingRef.current = false;
      setSubmittingId(null);
    }
  }

  const decisionState = selectedId ? "done" : submitError ? "error" : stale ? "paused" : "pending";
  return (
    <StreamCard
      state={decisionState}
      tint={selectedId ? colors.green : stale ? undefined : colors.orange}
      title={selectedId ? "已提交选择" : submitError ? "选择没有发出" : stale ? "更早的选择" : "待你选择"}
      detail={
        panel.mode === "sample"
          ? "示例 · 脚本化决策"
          : panel.mode === "live"
            ? "按当前对话里的选项决定"
            : undefined
      }
    >
      <View style={{ gap: 5 }}>
        <Text style={s.heading}>{panel.title}</Text>
        {preferredOption && !selectedId && (
          <Text style={s.small}>沿用上次的偏好：{preferredOption.label}</Text>
        )}
      </View>
      {panel.type === "clarification" ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {panel.options.map((option, index) => (
            <ChoiceButton
              key={option.id}
              panel={panel}
              option={option}
              disabled={disabled}
              pending={submittingId === option.id}
              selected={selectedId === option.id}
              position={index + 1}
              onChoose={(id) => void choose(id)}
            />
          ))}
        </View>
      ) : (
        <View>
          {panel.options.map((option, index) => {
            const chosen = selectedId === option.id;
            return (
            <View
              key={option.id}
              style={{
                gap: 9,
                paddingVertical: 12,
                paddingHorizontal: chosen ? 12 : 0,
                borderTopWidth: index === 0 ? 0 : 1,
                borderTopColor: colors.line,
                borderRadius: 12,
                backgroundColor: chosen ? colors.green : "transparent",
                opacity: selectedId && !chosen ? 0.55 : 1,
              }}
            >
              <Text style={[s.text, { fontWeight: "600" }]}>{option.label}</Text>
              {!!option.details.length && (
                <Text style={s.muted}>
                  {option.details.map((detail) => `• ${detail}`).join("\n")}
                </Text>
              )}
              <View style={{ gap: 5 }}>
                {option.sources.map((source) => (
                  <SourceLink key={`${option.id}-${source.url}`} {...source} />
                ))}
              </View>
              <ChoiceButton
                panel={panel}
                option={option}
                disabled={disabled}
                pending={submittingId === option.id}
                selected={selectedId === option.id}
                position={index + 1}
                onChoose={(id) => void choose(id)}
              />
            </View>
            );
          })}
        </View>
      )}
      <ErrorNotice error={submitError} />
      {failedOptionId && !selectedId && (
        <Button
          small
          disabled={
            !retryChoiceAvailable(
              panel,
              interaction.threadId || "",
              interaction.latestPanelId,
              failedOptionId,
              interaction.latestUserText,
              false,
              !interaction.canRetry || submittingId !== null,
            )
          }
          onPress={() => void choose(failedOptionId, true)}
        >
          重试选择
        </Button>
      )}
    </StreamCard>
  );
}
