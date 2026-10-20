/** Pure chat-stream presentation rules. Visual components live in chat-stream.tsx. */

export type StreamState = "running" | "paused" | "done" | "error" | "pending";

/** Chat-stream tools that must not expand into a task sheet. Activity and notifications keep the full card. */
export function backgroundToolKind(name: string): "delegate" | "status" | null {
  if (name === "任务") return "delegate";
  if (name === "智能体进展") return "status";
  return null;
}

export function listedBackgroundTasks(value: unknown): number {
  if (!value || typeof value !== "object" || !("tasks" in value)) return 0;
  const tasks = (value as { tasks?: unknown }).tasks;
  return Array.isArray(tasks) ? tasks.length : 0;
}

export function backgroundStreamState(status: string): StreamState {
  if (status === "failed") return "error";
  if (status === "succeeded" || status === "cancelled" || status === "completed") return "done";
  if (status === "running" || status === "queued" || status === "scheduled") return "running";
  if (status === "waiting_approval" || status === "waiting_input") return "pending";
  return "paused";
}

export const USER_BUBBLE_COLLAPSE_CHARS = 280;
export const USER_BUBBLE_COLLAPSE_LINES = 6;

/**
 * Enter commits a draft only when the key is a real Enter outside IME composition.
 * Shift+Enter stays a newline. keyCode 229 and "Process" are composition markers.
 */
export function shouldCommitComposerEnter(event: {
  key?: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  composing?: boolean;
}): boolean {
  if (event.composing || event.isComposing) return false;
  if (event.keyCode === 229) return false;
  if (event.key === "Process" || event.key === "Unidentified") return false;
  return event.key === "Enter" && !event.shiftKey;
}

/** Collapsed user text dissolves over 3rem. Transcript edges use a 28px fade. */
export const USER_BUBBLE_FADE_PX = 48;
export const SCROLL_FADE_PX = 28;

/**
 * Four-stop reading fade. A bottom edge dissolves content into the surface;
 * a top edge does the reverse. Stops follow the event-stream mask: solid,
 * 85%, 50%, 15%, clear.
 */
export function surfaceFadeAlphas(edge: "top" | "bottom"): readonly number[] {
  const clearToSolid = [0, 0.15, 0.5, 0.85, 1] as const;
  return edge === "bottom" ? clearToSolid : [1, 0.85, 0.5, 0.15, 0];
}

export function withAlpha(hex: string, alpha: number): string {
  if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) return hex;
  const channel = Math.max(0, Math.min(255, Math.round(alpha * 255)));
  return `${hex}${channel.toString(16).padStart(2, "0")}`;
}

export type ComposerChrome = "rest" | "hover" | "focus";

/** Focus wins over hover. The ring stays Kleio blue. */
export function composerChrome(input: { focused: boolean; hovered: boolean }): ComposerChrome {
  if (input.focused) return "focus";
  if (input.hovered) return "hover";
  return "rest";
}

/** Dual-ring composer shadow. Web uses the inset hairline; native keeps one border. */
export function composerBoxShadow(chrome: ComposerChrome): string {
  if (chrome === "focus") {
    return "0 4px 24px rgba(24,56,75,0.08), inset 0 0 0 1px #1473C8, 0 0 0 1px #1473C8";
  }
  if (chrome === "hover") {
    return "0 4px 24px rgba(24,56,75,0.06), inset 0 0 0 1px #D5D8DC";
  }
  return "0 4px 20px rgba(24,56,75,0.035), inset 0 0 0 1px #EEEEF0";
}

export function composerBorderColor(chrome: ComposerChrome): string {
  if (chrome === "focus") return "#1473C8";
  if (chrome === "hover") return "#D5D8DC";
  return "#EEEEF0";
}

/** Running, pending, and failed work stays open. A finished or paused card starts as a one-line receipt. */
export function toolCardStartsOpen(state: StreamState): boolean {
  return state === "running" || state === "pending" || state === "error";
}

/**
 * Primary control for a folded tool card. It renders beside the heading, so a
 * second tap is not required to reach it. Details stay behind the heading toggle.
 */
export type ToolReceiptKind =
  | "open-mail"
  | "open-source"
  | "takeover"
  | "open-desktop"
  | "start-computer"
  | "view-saved";

export type ToolReceipt = {
  kind: ToolReceiptKind;
  label: string;
  staysOnReceipt: true;
};

function receipt(kind: ToolReceiptKind, label: string): ToolReceipt {
  return { kind, label, staysOnReceipt: true };
}

export function mailReceiptAction(input: {
  search: boolean;
  failed: boolean;
  hasMessage: boolean;
}): ToolReceipt | null {
  if (input.search || input.failed || !input.hasMessage) return null;
  return receipt("open-mail", "打开邮件");
}

export function searchReceiptAction(input: {
  loading: boolean;
  failed: boolean;
  sourceCount: number;
}): ToolReceipt | null {
  if (input.loading || input.failed || input.sourceCount < 1) return null;
  return receipt("open-source", input.sourceCount === 1 ? "打开来源" : "打开首个来源");
}

export function browserReceiptAction(input: {
  loading: boolean;
  hasVisit: boolean;
}): ToolReceipt | null {
  if (input.loading || !input.hasVisit) return null;
  return receipt("takeover", "接管控制");
}

/**
 * The desktop page stays on the receipt. An offline computer also keeps Start
 * there, so neither control waits behind the heading.
 */
export function desktopReceiptActions(input: {
  offline: boolean;
  starting: boolean;
}): ToolReceipt[] {
  const open = receipt("open-desktop", "在「桌面」页打开");
  if (!input.offline) return [open];
  return [receipt("start-computer", input.starting ? "启动中…" : "启动电脑"), open];
}

export function savedResultReceiptAction(input: {
  name: string;
  loading: boolean;
  failed: boolean;
}): ToolReceipt | null {
  if (input.loading || input.failed || !input.name) return null;
  return receipt("view-saved", `查看${input.name}`);
}

const APPROVAL_STATUS_ZH: Record<string, string> = {
  awaiting_review: "待你审阅",
  executing: "正在执行",
  succeeded: "已完成",
  failed: "未完成",
  outcome_unknown: "结果未知",
  denied: "未继续",
  cancelled: "已取消",
  expired: "已过期",
};

/** Status chip on the approval sheet. Unknown values stay non-English. Exact keys only. */
export function approvalStatusLabel(status: string): string {
  return APPROVAL_STATUS_ZH[status] ?? "状态待更新";
}

/**
 * Short chips for raw operation statuses in the chat stream, tool cards, and the
 * activity list. Spaces and hyphens fold into the same key. Approval-sheet "failed"
 * stays "未完成" via approvalStatusLabel; a running task that fails stays "失败".
 */
const OPERATION_STATUS_ZH: Record<string, string> = {
  running: "进行中",
  in_progress: "进行中",
  active: "进行中",
  completed: "已完成",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  canceled: "已取消",
  pending: "待处理",
  waiting: "等待中",
  queued: "排队中",
  scheduled: "已安排",
  paused: "已暂停",
  stopped: "已停止",
  interrupted: "已中断",
  timed_out: "已超时",
  review: "待你审阅",
  needs_review: "待你审阅",
  awaiting_review: "待你审阅",
  waiting_approval: "待你审阅",
  needs_input: "需要你补充",
  waiting_input: "需要你补充",
  executing: "正在执行",
  outcome_unknown: "结果未知",
  denied: "未继续",
  expired: "已过期",
  read: "已读",
  unread: "未读",
};

export function operationStatusKey(status: string): string {
  return status.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/** Mapped chip, or undefined when this string is not an operation status. */
export function knownOperationStatus(status: string): string | undefined {
  return OPERATION_STATUS_ZH[operationStatusKey(status)];
}

/** Short Chinese chip. Unknown values stay non-English. */
export function operationStatusLabel(status: string): string {
  return knownOperationStatus(status) ?? "状态待更新";
}

/** Activity-list gate. Same phrase as the approval sheet. */
export function reviewGateLabel(count: number): string {
  return `待你审阅 · ${count}`;
}

const APPROVAL_KIND_ZH: Record<string, string> = {
  "email.send": "发送邮件",
  "calendar.create": "新建日程",
  "calendar.update": "更改日程",
  "calendar.delete": "删除日程",
};

export function approvalKindLabel(kind: string): string {
  return APPROVAL_KIND_ZH[kind] ?? "这项操作";
}

export function approvalExpirySentence(whenLabel: string): string {
  return `请在 ${whenLabel} 前确认。这次确认只对上面这些内容有效。`;
}

export function approvalCalendarName(calendarId: string): string {
  if (!calendarId || calendarId === "primary") return "主日历";
  return calendarId;
}

/** All-day ends are exclusive of the displayed day. Timed events need no extra note. */
export function approvalEndNote(allDay: boolean): string {
  return allDay ? "（不含这一天）" : "";
}

export function approvalAttachmentLine(name: string, id: string): string {
  const version = id.slice(-8);
  if (!version) return name;
  return `${name} · 版本 ${version}`;
}

/** Label on the calendar sheet that hands the draft to review. */
export function approvalProposeLabel(editing: boolean): string {
  return editing ? "审阅变更" : "提交审阅";
}

export type ComposerSendFace = "stop" | "send" | "idle";

/**
 * Stop stays available during a reply. Send lights up only for a non-empty draft
 * once history is loaded and the runtime is ready. Anything else is idle.
 */
export function composerSendFace(input: {
  draft: string;
  loaded: boolean;
  ready: boolean;
  replying: boolean;
}): ComposerSendFace {
  if (input.replying) return "stop";
  if (input.draft.trim().length > 0 && input.loaded && input.ready) return "send";
  return "idle";
}

export type LiveCue = "thinking" | "writing";

/**
 * One status under the transcript. A tool card already shows its own running rail,
 * so this cue stays quiet while a tool is still unsettled. Before any prose, the
 * person is waiting on a thought. Once text exists, the cue says the reply is still being written.
 */
export function liveTurnCue(input: {
  replying: boolean;
  turns: ReadonlyArray<{
    role: string;
    content?: string;
    toolCallIds?: readonly string[];
  }>;
  settledToolIds: ReadonlySet<string>;
}): LiveCue | null {
  if (!input.replying) return null;
  let lastUser = -1;
  for (let index = 0; index < input.turns.length; index++) {
    if (input.turns[index].role === "user") lastUser = index;
  }
  let text = "";
  let pendingTool = false;
  for (let index = lastUser + 1; index < input.turns.length; index++) {
    const turn = input.turns[index];
    if (turn.role !== "assistant") continue;
    text += turn.content ?? "";
    for (const id of turn.toolCallIds ?? []) {
      if (!input.settledToolIds.has(id)) pendingTool = true;
    }
  }
  if (pendingTool) return null;
  return text.trim() ? "writing" : "thinking";
}

/** After a choice lands, the other rows keep their labels and drop the rest of the card. */
export function choiceRowQuiet(selectedId: string | null, optionId: string): boolean {
  return selectedId !== null && selectedId !== optionId;
}

/** Long user turns collapse in the bubble so the stream stays scannable. */
export function userMessageOverflows(text: string): boolean {
  if (text.length > USER_BUBBLE_COLLAPSE_CHARS) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines += 1;
      if (lines > USER_BUBBLE_COLLAPSE_LINES) return true;
    }
  }
  return false;
}
