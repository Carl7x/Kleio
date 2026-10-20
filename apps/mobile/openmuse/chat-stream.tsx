import { ChevronDown, ChevronRight } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import {
  SCROLL_FADE_PX,
  type StreamState,
  surfaceFadeAlphas,
  toolCardStartsOpen,
  USER_BUBBLE_FADE_PX,
  userMessageOverflows,
  withAlpha,
} from "./chat-stream-rules";
import { colors, Mascot, s } from "./ui";

export { shouldCommitComposerEnter, userMessageOverflows } from "./chat-stream-rules";
export type { StreamState } from "./chat-stream-rules";

function useReduceMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (alive) setReduce(value);
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  return reduce;
}

function streamInk(state: StreamState) {
  if (state === "done") return "#47896C";
  if (state === "error") return colors.danger;
  if (state === "paused") return colors.muted;
  if (state === "pending") return "#8A5A24";
  return colors.blueDark;
}

/** Status pip for one event in the chat stream. Running pips breathe unless motion is reduced. */
export function StatusPip({ state }: { state: StreamState }) {
  const reduce = useReduceMotion();
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (state !== "running" || reduce) {
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.35, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, reduce, state]);
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        width: 8,
        height: 8,
        borderRadius: 4,
        marginTop: 7,
        backgroundColor: streamInk(state),
        opacity,
      }}
    />
  );
}

export function EventHeading({
  state,
  title,
  detail,
  icon,
}: {
  state: StreamState;
  title: string;
  detail?: string;
  icon?: ReactNode;
}) {
  return (
    <View style={[s.row, { gap: 10, alignItems: "flex-start" }]}>
      <StatusPip state={state} />
      {icon ? <View style={{ marginTop: 2 }}>{icon}</View> : null}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[s.text, { fontWeight: "600" }]}>{title}</Text>
        {detail ? (
          <Text numberOfLines={2} style={s.small}>
            {detail}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** Hairline event card. A colored rail marks running, done, paused, pending, or error. */
export function StreamCard({
  state,
  title,
  detail,
  icon,
  tint,
  wide,
  collapsible = false,
  action,
  children,
}: {
  state: StreamState;
  title: string;
  detail?: string;
  icon?: ReactNode;
  tint?: string;
  wide?: boolean;
  /** Fold finished work behind the heading. Running, pending, and error stay open until the person toggles. */
  collapsible?: boolean;
  /** Primary control. Stays beside the heading when the card is folded. */
  action?: ReactNode;
  children?: ReactNode;
}) {
  const canFold = collapsible && children != null && children !== false;
  const [open, setOpen] = useState(() => !canFold || toolCardStartsOpen(state));
  const touched = useRef(false);
  const previousState = useRef(state);
  useEffect(() => {
    const prior = previousState.current;
    previousState.current = state;
    if (!canFold) return;
    // A new failure opens once, even if the person had folded the running card.
    if (state === "error" && prior !== "error") {
      setOpen(true);
      return;
    }
    if (touched.current) return;
    setOpen(toolCardStartsOpen(state));
  }, [canFold, state]);
  const summary = (
    <View style={[s.row, { gap: 8, alignItems: "center", flex: 1 }]}>
      <View style={{ flex: 1 }}>
        <EventHeading state={state} title={title} detail={detail} icon={icon} />
      </View>
      {canFold ? (
        <View style={{ transform: [{ rotate: open ? "0deg" : "-90deg" }] }}>
          <ChevronDown size={16} color={colors.muted} />
        </View>
      ) : null}
    </View>
  );
  return (
    <View
      style={{
        width: "100%",
        maxWidth: wide ? 640 : 440,
        paddingHorizontal: 14,
        paddingVertical: canFold && !open ? 8 : 12,
        gap: canFold && !open ? 0 : 10,
        backgroundColor: tint ?? colors.card,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: colors.line,
        borderLeftWidth: 3,
        borderLeftColor: streamInk(state),
      }}
    >
      <View style={[s.row, { gap: 6, alignItems: "center" }]}>
        {canFold ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            accessibilityLabel={`${open ? "收起" : "展开"}：${title}`}
            onPress={() => {
              touched.current = true;
              setOpen((value) => !value);
            }}
            hitSlop={4}
            style={{ flex: 1 }}
          >
            {summary}
          </Pressable>
        ) : (
          summary
        )}
        {action ? <View style={{ flexShrink: 0 }}>{action}</View> : null}
      </View>
      {!canFold || open ? children : null}
    </View>
  );
}

/** Compact control that sits on a tool-card receipt. The heading toggle does not include it. */
export function ReceiptAction({
  label,
  onPress,
  disabled,
  busy,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const locked = Boolean(disabled || busy);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: locked, busy: !!busy }}
      disabled={locked}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => ({
        minHeight: 32,
        justifyContent: "center",
        paddingHorizontal: 8,
        borderRadius: 10,
        backgroundColor: pressed && !locked ? colors.sky : "#F4F7F9",
        opacity: locked ? 0.5 : 1,
      })}
    >
      {busy ? (
        <ActivityIndicator color={colors.blueDark} size="small" />
      ) : (
        <Text numberOfLines={1} style={{ color: colors.blueDark, fontSize: 13, fontWeight: "600" }}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/** Three quiet dots, 1.9s wave. Static when the person prefers reduced motion. */
export function QuietDots({ label, bare = false }: { label?: string; bare?: boolean }) {
  const reduce = useReduceMotion();
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) return;
    const loop = Animated.loop(
      Animated.timing(anim, { toValue: 1, duration: 1900, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [anim, reduce]);
  const waves = useMemo(() => {
    if (reduce) return [0.45, 0.8, 0.55];
    return [0.12, 0.32, 0.52].map((peak) => {
      const start = Math.max(0.001, peak - 0.12);
      const end = Math.min(0.999, peak + 0.2);
      return anim.interpolate({
        inputRange: [0, start, peak, end, 1],
        outputRange: [0.35, 0.35, 1, 0.35, 0.35],
      });
    });
  }, [anim, reduce]);
  const dot = bare ? 6 : 7;
  return (
    <View
      accessibilityRole={!bare && label ? "text" : undefined}
      accessibilityLabel={bare ? undefined : label}
      accessibilityElementsHidden={bare}
      importantForAccessibility={bare ? "no" : "auto"}
      style={[s.row, { gap: bare ? 0 : 8, alignSelf: "flex-start", paddingVertical: bare ? 0 : 4 }]}
    >
      <View style={[s.row, { gap: 5 }]}>
        {waves.map((opacity, index) => (
          <Animated.View
            key={index}
            style={{
              width: dot,
              height: dot,
              borderRadius: dot / 2,
              backgroundColor: colors.blueDark,
              opacity,
            }}
          />
        ))}
      </View>
      {!bare && label ? <Text style={s.muted}>{label}</Text> : null}
    </View>
  );
}

const USER_PREVIEW_LINES = 6;

/** Placeholder line. A light sheen crosses it for 2s unless motion is reduced. */
export function SkeletonLine({ width = "84%" }: { width?: number | `${number}%` }) {
  const reduce = useReduceMotion();
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) {
      anim.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(anim, { toValue: 1, duration: 2000, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [anim, reduce]);
  const translateX = anim.interpolate({ inputRange: [0, 1], outputRange: [-64, 220] });
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        height: 7,
        width,
        borderRadius: 4,
        backgroundColor: "#E3E9ED",
        overflow: "hidden",
      }}
    >
      {reduce ? null : (
        <Animated.View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: -4,
            bottom: -4,
            width: 36,
            backgroundColor: "rgba(255,255,255,0.72)",
            transform: [{ translateX }, { rotate: "15deg" }],
          }}
        />
      )}
    </View>
  );
}

/** A pinned surface fade. It does not take taps. */
export function SurfaceFade({
  color,
  edge,
  size = SCROLL_FADE_PX,
}: {
  color: string;
  edge: "top" | "bottom";
  size?: number;
}) {
  return (
    <View pointerEvents="none" style={{ height: size, width: "100%" }}>
      {surfaceFadeAlphas(edge).map((alpha, index) => (
        <View
          key={index}
          style={{ flex: 1, backgroundColor: withAlpha(color, alpha) }}
        />
      ))}
    </View>
  );
}

/** User turn: tinted bubble, uniform 18px radius, clock tucked under the trailing edge. */
export function UserBubble({ text, time }: { text: string; time?: string | null }) {
  const [open, setOpen] = useState(false);
  const overflows = userMessageOverflows(text);
  const collapsed = overflows && !open;
  return (
    <View style={{ alignItems: "flex-end", maxWidth: "100%", gap: 4 }}>
      <View
        style={{
          maxWidth: "100%",
          paddingHorizontal: 14,
          paddingVertical: 10,
          borderRadius: 18,
          backgroundColor: colors.blue,
          ...(Platform.OS === "web"
            ? { boxShadow: "0 1px 2px rgba(17,25,28,0.05)" }
            : {
                shadowColor: "#11191C",
                shadowOpacity: 0.05,
                shadowRadius: 2,
                shadowOffset: { width: 0, height: 1 },
                elevation: 1,
              }),
        }}
      >
        <View>
          <Text
            selectable
            numberOfLines={collapsed ? USER_PREVIEW_LINES : undefined}
            style={[s.text, { fontSize: 15, lineHeight: 22 }]}
          >
            {text}
          </Text>
          {collapsed ? (
            <View
              pointerEvents="none"
              style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
            >
              <SurfaceFade color={colors.blue} edge="bottom" size={USER_BUBBLE_FADE_PX} />
            </View>
          ) : null}
        </View>
        {overflows ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={open ? "收起消息" : "展开全文"}
            onPress={() => setOpen((value) => !value)}
            hitSlop={8}
            style={{ marginTop: 4, minHeight: 32, justifyContent: "center" }}
          >
            <Text style={{ color: colors.blueDark, fontSize: 13, fontWeight: "600" }}>
              {open ? "收起" : "展开全文"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {time ? (
        <Text
          accessibilityLabel={`发送于${time}`}
          style={{ color: colors.muted, fontSize: 11, lineHeight: 16, paddingRight: 2 }}
        >
          {time}
        </Text>
      ) : null}
    </View>
  );
}

/** Kleio line for the first fragment of a reply. Later fragments in the same turn stay quiet. */
export function AssistantIdentity({ time }: { time?: string | null }) {
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={time ? `Kleio，${time}` : "Kleio"}
      style={[s.row, { gap: 8, alignItems: "center", paddingLeft: 2, minHeight: 24 }]}
    >
      <Mascot size={22} decorative />
      <Text accessible={false} style={{ color: colors.text, fontSize: 13, lineHeight: 18, fontWeight: "600" }}>
        Kleio
      </Text>
      {time ? (
        <Text accessible={false} style={{ color: colors.muted, fontSize: 12, lineHeight: 16 }}>
          · {time}
        </Text>
      ) : null}
    </View>
  );
}

/** Assistant text inset: no bubble, so the reply reads as the stream itself. */
export function AssistantTurn({ children }: { children: ReactNode }) {
  return <View style={{ paddingHorizontal: 4, width: "100%" }}>{children}</View>;
}

/** In-progress row. A thought keeps the portrait; writing continues under the reply without a second one. */
export function StreamCue({ label, identity = false }: { label: string; identity?: boolean }) {
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLiveRegion="polite"
      accessibilityLabel={label}
      style={[
        s.row,
        {
          gap: 8,
          alignSelf: "flex-start",
          alignItems: "center",
          minHeight: 32,
          paddingLeft: identity ? 2 : 4,
        },
      ]}
    >
      {identity ? <Mascot size={22} decorative /> : null}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingLeft: 10,
          paddingRight: 12,
          paddingVertical: 6,
          borderRadius: 999,
          backgroundColor: colors.sky,
        }}
      >
        <QuietDots bare />
        <Text accessible={false} style={{ color: colors.blueDark, fontSize: 13, lineHeight: 18, fontWeight: "600" }}>
          {label}
        </Text>
      </View>
    </View>
  );
}

/** In-thread failure. The rail matches a stream card; the action stays on the notice. */
export function ThreadNotice({
  title,
  detail,
  actionLabel,
  onAction,
  actionDisabled,
}: {
  title: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
}) {
  return (
    <View
      accessibilityRole="alert"
      style={{
        alignSelf: "stretch",
        width: "100%",
        maxWidth: 440,
        paddingHorizontal: 14,
        paddingVertical: 12,
        gap: 8,
        borderRadius: 16,
        backgroundColor: "#FBEFED",
        borderWidth: 1,
        borderColor: "#F3D7D4",
        borderLeftWidth: 3,
        borderLeftColor: colors.danger,
      }}
    >
      <Text style={{ color: colors.text, fontSize: 15, lineHeight: 22, fontWeight: "600" }}>{title}</Text>
      {detail ? (
        <Text style={{ color: colors.danger, fontSize: 13, lineHeight: 19 }}>{detail}</Text>
      ) : null}
      {actionLabel && onAction ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          accessibilityState={{ disabled: !!actionDisabled }}
          disabled={actionDisabled}
          onPress={onAction}
          hitSlop={4}
          style={({ pressed }) => ({
            alignSelf: "flex-start",
            minHeight: 36,
            justifyContent: "center",
            paddingHorizontal: 12,
            borderRadius: 12,
            backgroundColor: pressed && !actionDisabled ? "#F6E4E1" : "#FFFFFF",
            opacity: actionDisabled ? 0.5 : 1,
          })}
        >
          <Text style={{ color: colors.danger, fontSize: 13, fontWeight: "600" }}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Empty-thread prompt. Quieter than a primary button, still a full tap target. */
export function SuggestionRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        borderRadius: 14,
        paddingHorizontal: 14,
        paddingVertical: 10,
        backgroundColor: pressed ? colors.sky : colors.card,
        borderWidth: 1,
        borderColor: colors.line,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
      })}
    >
      <Text style={{ flex: 1, color: colors.text, fontSize: 15, lineHeight: 22 }}>{label}</Text>
      <ChevronRight size={16} color={colors.muted} />
    </Pressable>
  );
}

export function ChatStatusScreen({
  title,
  detail,
  busy,
  hero,
  children,
}: {
  title: string;
  detail?: string;
  busy?: boolean;
  hero?: boolean;
  children?: ReactNode;
}) {
  return (
    <View
      style={{
        flexGrow: 1,
        justifyContent: "center",
        alignItems: "center",
        paddingVertical: hero ? 28 : 24,
        paddingHorizontal: 8,
        gap: 12,
      }}
    >
      {hero ? <Mascot size={48} /> : null}
      {busy ? <QuietDots /> : null}
      <Text
        style={{
          fontSize: hero ? 26 : 22,
          lineHeight: hero ? 32 : 28,
          letterSpacing: hero ? -0.6 : -0.4,
          color: colors.text,
          textAlign: "center",
          maxWidth: 340,
        }}
      >
        {title}
      </Text>
      {detail ? (
        <Text style={[s.muted, { maxWidth: 320, textAlign: "center", lineHeight: 22 }]}>{detail}</Text>
      ) : null}
      {busy ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{ width: "100%", maxWidth: 260, gap: 10, marginTop: 4 }}
        >
          <SkeletonLine width="68%" />
          <SkeletonLine width="100%" />
          <SkeletonLine width="42%" />
        </View>
      ) : null}
      {children}
    </View>
  );
}
