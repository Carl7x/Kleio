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

/**
 * Floating composer shadow. Focus keeps the Kleio blue ring; rest sits a little
 * higher than a flat card so the pill reads as the place to write.
 * Web uses the inset hairline; native keeps one border.
 */
export function composerBoxShadow(chrome: ComposerChrome): string {
  if (chrome === "focus") {
    return "0 8px 28px rgba(24,56,75,0.10), inset 0 0 0 1px #1473C8, 0 0 0 1px #1473C8";
  }
  if (chrome === "hover") {
    return "0 6px 24px rgba(24,56,75,0.07), inset 0 0 0 1px #D5D8DC";
  }
  return "0 6px 22px rgba(24,56,75,0.05), inset 0 0 0 1px #EEEEF0";
}

export function composerBorderColor(chrome: ComposerChrome): string {
  if (chrome === "focus") return "#1473C8";
  if (chrome === "hover") return "#D5D8DC";
  return "#EEEEF0";
}

/** Native elevation that matches composerBoxShadow. Keyboard inset is separate. */
export function composerNativeShadow(chrome: ComposerChrome): {
  shadowOpacity: number;
  shadowRadius: number;
  shadowOffsetY: number;
  elevation: number;
} {
  if (chrome === "focus") return { shadowOpacity: 0.1, shadowRadius: 28, shadowOffsetY: 8, elevation: 4 };
  if (chrome === "hover") return { shadowOpacity: 0.07, shadowRadius: 24, shadowOffsetY: 6, elevation: 3 };
  return { shadowOpacity: 0.05, shadowRadius: 22, shadowOffsetY: 6, elevation: 2 };
}

/**
 * Pill rhythm for the chat composer. Controls stay 44px for touch.
 * Chips are short pills so a few attachments do not stack into a second card.
 */
export const composerChromeMetrics = {
  radius: 24,
  pad: 6,
  control: 44,
  rowGap: 6,
  chipRadius: 999,
  chipPadX: 8,
  chipPadY: 2,
  chipGap: 6,
  chipMaxWidth: 200,
  chipFont: 12,
  chipLine: 16,
} as const;

/** Status lines keep an ellipsis. The ready line is an invitation, without one. */
export function composerPlaceholder(input: {
  ready: boolean;
  loaded: boolean;
  historyFailed: boolean;
  /** Background worker is down. Drafting still works; the line says so. */
  offline?: boolean;
  /** The last workspace read failed. Connection copy wins over a loading line. */
  reconnecting?: boolean;
}): string {
  if (input.reconnecting) return "正在重新连接…";
  if (!input.ready) return "正在连接…";
  if (input.offline) return "Kleio 暂时离线";
  if (!input.loaded) return input.historyFailed ? "对话暂时不可用" : "正在加载对话…";
  return "跟 Kleio 说";
}

/**
 * Web composer hint. Enter still sends and Shift+Enter still inserts a newline.
 * The words name those keys in Chinese.
 */
export function composerShortcutHint(): string {
  return "回车发送，Shift+回车换行";
}

/**
 * One line under the portrait. A person who must act comes first.
 * Offline and reconnect stay quieter than an approval, and louder than idle.
 */
export function chatShellStatus(input: {
  approval?: string | null;
  needsInput?: string | null;
  running?: string | null;
  queued?: boolean;
  connecting?: boolean;
  reconnecting?: boolean;
  connectFailed?: boolean;
  offline?: boolean;
}): string {
  if (input.approval?.trim()) return `待你审阅 · ${input.approval.trim()}`;
  if (input.needsInput?.trim()) return `需要你补充 · ${input.needsInput.trim()}`;
  if (input.offline) return "暂时离线";
  if (input.connectFailed) return "没能连上";
  if (input.reconnecting) return "正在重新连接";
  if (input.connecting) return "正在连接";
  if (input.running?.trim()) return input.running.trim();
  if (input.queued) return "正在接下一项任务…";
  return "有需要时我就在";
}

/** Side threads name themselves. The main thread keeps the portrait as its title. */
export function sideThreadTitle(name?: string): { title: string; detail: string } {
  const title = name?.trim() || "旁路对话";
  return { title, detail: "和主对话分开" };
}

/** Title row and centered status type, in the same sizes as bubbles and tool cards. */
export const threadChrome = {
  titleSize: 15,
  titleLine: 20,
  detailSize: 12,
  detailLine: 16,
  barPadBottom: 2,
  statusTitle: 20,
  statusTitleLine: 26,
  statusHero: 24,
  statusHeroLine: 31,
  statusGap: 8,
} as const;

export type ThreadStatusKind =
  | "opening"
  | "opening-failed"
  | "connecting"
  | "reconnecting"
  | "connect-failed"
  | "offline"
  | "loading"
  | "syncing"
  | "history-failed"
  | "history-partial"
  | "empty-side"
  | "run-failed";

export type ThreadStatusTone = "neutral" | "paused" | "error";

export type ThreadStatusCopy = {
  title: string;
  detail: string;
  actionLabel?: string;
  busy: boolean;
  tone: ThreadStatusTone;
};

const THREAD_STATUS: Record<ThreadStatusKind, ThreadStatusCopy> = {
  opening: {
    title: "正在打开对话",
    detail: "主对话会先出现在这里。",
    busy: true,
    tone: "neutral",
  },
  "opening-failed": {
    title: "主对话没有打开",
    detail: "已保存的消息未被改动。",
    actionLabel: "重试",
    busy: false,
    tone: "error",
  },
  connecting: {
    title: "正在连接",
    detail: "连上之后，对话会从这里继续。",
    busy: true,
    tone: "neutral",
  },
  reconnecting: {
    title: "正在重新连接",
    detail: "这段对话还在。",
    actionLabel: "再试一次",
    busy: false,
    tone: "neutral",
  },
  "connect-failed": {
    title: "没能连上 Kleio",
    detail: "已保存的对话还在。",
    actionLabel: "再试一次",
    busy: false,
    tone: "error",
  },
  offline: {
    title: "Kleio 暂时离线",
    detail: "已保存的对话还在。恢复后从这里继续。",
    actionLabel: "重新连接",
    busy: false,
    tone: "paused",
  },
  loading: {
    title: "正在接上这段对话",
    detail: "已保存的消息会原样出现在这里。",
    busy: true,
    tone: "neutral",
  },
  syncing: {
    title: "正在同步尚未结束的回复",
    detail: "同步完成前，新消息会排在输入框上方。",
    busy: true,
    tone: "neutral",
  },
  "history-failed": {
    title: "这段对话没有载入",
    detail: "已保存的消息未被改动。",
    actionLabel: "重试加载",
    busy: false,
    tone: "error",
  },
  "history-partial": {
    title: "这段对话没有完整载入",
    detail: "已保存的消息未被改动。",
    actionLabel: "重试加载",
    busy: false,
    tone: "error",
  },
  "empty-side": {
    title: "这条对话还是空的",
    detail: "写一句就开始。",
    busy: false,
    tone: "neutral",
  },
  "run-failed": {
    title: "这次回复没有完成",
    detail: "可以再试一次。",
    actionLabel: "重试回复",
    busy: false,
    tone: "error",
  },
};

/** Short Chinese for one thread status. Callers add the server note separately. */
export function threadStatusCopy(kind: ThreadStatusKind): ThreadStatusCopy {
  return { ...THREAD_STATUS[kind] };
}

export type SheetListKind =
  | "loading"
  | "failed"
  | "empty"
  | "empty-archived"
  | "more-failed"
  | "action-failed";

/** Conversation list inside the Kleio sheet. Same shape as an in-thread status. */
const SHEET_LIST_STATUS: Record<SheetListKind, ThreadStatusCopy> = {
  loading: {
    title: "正在载入对话",
    detail: "旁路对话会列在这里。",
    busy: true,
    tone: "neutral",
  },
  failed: {
    title: "对话列表没有载入",
    detail: "主对话仍然可用。",
    actionLabel: "重试",
    busy: false,
    tone: "error",
  },
  empty: {
    title: "还没有旁路对话",
    detail: "另开一个话题。主对话始终可用。",
    busy: false,
    tone: "neutral",
  },
  "empty-archived": {
    title: "没有已归档的对话",
    detail: "归档后会出现在这里。",
    busy: false,
    tone: "neutral",
  },
  "more-failed": {
    title: "后面的对话没有载入",
    detail: "已列出的对话还在。",
    actionLabel: "重试",
    busy: false,
    tone: "error",
  },
  "action-failed": {
    title: "这次没有完成",
    detail: "可以再试一次。",
    busy: false,
    tone: "error",
  },
};

/** Short Chinese for the threads-sheet list. Callers add the server note separately. */
export function sheetListStatus(kind: SheetListKind): ThreadStatusCopy {
  return { ...SHEET_LIST_STATUS[kind] };
}

export type AccessGateCopy = {
  welcomeTitle: string;
  welcomeDetail: string;
  connecting: ThreadStatusCopy;
  tokenLabel: string;
  tokenPlaceholder: string;
  helper: string;
  submitLabel: string;
  failedTitle: string;
  failedDetail: string;
  workspaceOpening: ThreadStatusCopy;
  workspaceFailed: ThreadStatusCopy;
};

/** Access gate before the shell. Kleio stays the brand; the token line stays Chinese. */
export function accessGateCopy(): AccessGateCopy {
  return {
    welcomeTitle: "欢迎使用 Kleio",
    welcomeDetail: "你的个人智能体工作台。",
    connecting: {
      title: "正在打开 Kleio",
      detail: "连上之后，工作台会从这里继续。",
      busy: true,
      tone: "neutral",
    },
    tokenLabel: "访问令牌",
    tokenPlaceholder: "粘贴一次即可",
    helper: "粘贴一次，即可在此工作台建立安全会话。",
    submitLabel: "打开工作台",
    failedTitle: "没能打开 Kleio",
    failedDetail: "确认访问令牌后再试一次。",
    workspaceOpening: {
      title: "正在打开工作台",
      detail: "对话会从这里继续。",
      busy: true,
      tone: "neutral",
    },
    workspaceFailed: {
      title: "工作台没有打开",
      detail: "已保存的内容未被改动。",
      actionLabel: "再试一次",
      busy: false,
      tone: "error",
    },
  };
}

export type ShellFailureKind = "save" | "stop" | "choice" | "choice-unreadable";

/**
 * Save, stop, and choice failures. The title and detail stay Chinese.
 * Callers pass the server text through statusServerNote, never as the title.
 */
const SHELL_FAILURE: Record<ShellFailureKind, { title: string; detail: string }> = {
  save: { title: "对话没有保存", detail: "已发出的内容还在。" },
  stop: { title: "没能停下来", detail: "回复可能还在继续。" },
  choice: { title: "选择没有发出", detail: "可以再选一次。" },
  "choice-unreadable": { title: "无法显示选项", detail: "请重试。" },
};

export function shellFailureCopy(kind: ShellFailureKind): { title: string; detail: string } {
  return { ...SHELL_FAILURE[kind] };
}

/** Today hero. The line break matches the wide type on that card. */
export function todayHeroTitle(): string {
  return "今天，多留一点\n喘息的空间。";
}

/** Calendar and inbox counts under the today hero. Zero stays a quiet sentence. */
export function todayBriefLine(events: number, unread: number): string {
  const calendar = events > 0 ? `日历上有 ${events} 件事` : "日历还有空档";
  const mail = unread > 0 ? `，${unread} 封未读邮件` : "";
  return `${calendar}${mail}。\n把时间留给要紧的事。`;
}

/** Calendar sheet subtitle. The zone id stays as stored; the sentence is Chinese. */
export function calendarZoneLine(name: string | undefined, zone: string): string {
  return `${name?.trim() || "你的日历"} · ${zone}。日程按各自时区显示。`;
}

/** Agenda row when a location is missing. Zero attendees stays the quiet line. */
export function attendeeCountLine(count: number): string {
  return count > 0 ? `${count} 位参与者` : "属于你的时间";
}

/** Server text sits under the stable Chinese line. A long payload does not become the screen. */
export function statusServerNote(message?: string, max = 72): string | undefined {
  const text = message?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export type ThreadPlace =
  | { place: "screen"; kind: ThreadStatusKind }
  | { place: "banner"; kind: ThreadStatusKind }
  | { place: "cue"; kind: "syncing" }
  | { place: "hero" }
  | { place: "messages" };

/**
 * One status in the thread. A full screen only when there is nothing to read.
 * With messages, a single banner or cue — history, then offline, then reconnect.
 */
export function threadSurface(input: {
  historyFailed: boolean;
  loaded: boolean;
  syncing: boolean;
  hasMessages: boolean;
  replying: boolean;
  side: boolean;
  connectFailed: boolean;
  reconnecting: boolean;
  offline: boolean;
}): ThreadPlace {
  if (!input.hasMessages) {
    if (input.historyFailed) return { place: "screen", kind: "history-failed" };
    if (!input.loaded) return { place: "screen", kind: "loading" };
    if (input.syncing) return { place: "screen", kind: "syncing" };
    if (input.connectFailed) return { place: "screen", kind: "connect-failed" };
    if (input.offline) return { place: "screen", kind: "offline" };
    if (input.reconnecting) return { place: "screen", kind: "reconnecting" };
    if (input.side) return { place: "screen", kind: "empty-side" };
    return { place: "hero" };
  }
  if (input.historyFailed) return { place: "banner", kind: "history-partial" };
  if (input.offline) return { place: "banner", kind: "offline" };
  if (input.connectFailed) return { place: "banner", kind: "connect-failed" };
  if (input.reconnecting) return { place: "banner", kind: "reconnecting" };
  if (input.syncing && !input.replying) return { place: "cue", kind: "syncing" };
  return { place: "messages" };
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

/**
 * Chips and short labels on the chat shell, artifact cards, and activity.
 * Operation statuses win. Unknown values stay non-English.
 */
const SURFACE_LABEL_ZH: Record<string, string> = {
  warm: "温暖",
  concise: "简洁",
  thoughtful: "周到",
  plan: "计划",
  comparison: "对比",
  finance: "财务",
  report: "报告",
  document: "文档",
  monitor: "盯梢",
  agent: "任务",
  step: "步骤",
  observation: "观察",
  approval: "审阅",
  result: "结果",
  error: "出错",
  status: "状态",
  new: "新的",
  dismissed: "已放下",
  accepted: "已采纳",
};

export function surfaceChipLabel(value: string): string {
  const operation = knownOperationStatus(value);
  if (operation) return operation;
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return SURFACE_LABEL_ZH[key] ?? "状态待更新";
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

/** Owners and writers stay unmarked. Every other calendar role is read-only. */
export function calendarAccessSuffix(accessRole: string): string {
  const role = accessRole.trim().toLowerCase();
  if (role === "owner" || role === "writer") return "";
  return " · 只读";
}

/** Rich-thread connection value. The vendor name stays off the settings line. */
export function richThreadValue(connected: boolean): string {
  return connected ? "已接通" : "未连接";
}

/** Goal-monitor cadence. Minutes and check counts stay as given. */
export function monitorCadenceLine(intervalMinutes: number, checks: number): string {
  return `每 ${intervalMinutes} 分钟 · 已查 ${checks} 次`;
}

/** Last check, and the next check only while the monitor is still active. */
export function monitorCheckLine(last: string, next?: string): string {
  const checked = `上次 ${last}`;
  return next ? `${checked}\n下次 ${next}` : checked;
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

export type ComposerControlChrome = {
  fill: string;
  icon: string;
  border: string;
};

/**
 * Idle is a quiet well. Send uses the soft Kleio blue.
 * Stop uses the darker blue so an in-progress reply is not another send button.
 */
export function composerControlChrome(face: ComposerSendFace): ComposerControlChrome {
  if (face === "stop") return { fill: "#1473C8", icon: "#FFFFFF", border: "#1473C8" };
  if (face === "send") return { fill: "#C8E7FF", icon: "#11191C", border: "#C8E7FF" };
  return { fill: "#F4F6F7", icon: "#A8B4BC", border: "#E4E7EA" };
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

/** Quiet labels for the in-progress row. The pill carries the motion; the words stay short. */
export function liveCueLabel(cue: LiveCue): string {
  return cue === "thinking" ? "正在思考" : "正在写回复";
}

/** Same-role fragments sit close. A new speaker opens a turn. */
export const TURN_FOLLOW_PX = 6;
export const TURN_BREAK_PX = 16;

export function turnSpacing(previousRole: string | null, role: string): number {
  if (!previousRole) return 0;
  return previousRole === role ? TURN_FOLLOW_PX : TURN_BREAK_PX;
}

/**
 * The Kleio line leads the first visible fragment of a reply.
 * An empty placeholder does not count, so a thought cue can carry the portrait instead.
 */
export function assistantIdentityIndex(
  turns: ReadonlyArray<{ role: string; present: boolean }>,
  index: number,
): boolean {
  const turn = turns[index];
  if (!turn || turn.role !== "assistant" || !turn.present) return false;
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    if (turns[cursor].role === "user") return true;
    if (turns[cursor].role === "assistant" && turns[cursor].present) return false;
  }
  return true;
}

/** Clock under a bubble. Same calendar day is HH:mm. Older turns add 月日. Invalid stamps stay hidden. */
export function turnTimeLabel(value: string | undefined, now = Date.now()): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  const current = new Date(now);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = (parts.find((part) => part.type === "hour")?.value ?? "").padStart(2, "0");
  const minute = (parts.find((part) => part.type === "minute")?.value ?? "").padStart(2, "0");
  if (!/^\d{2}$/.test(hour) || !/^\d{2}$/.test(minute)) return null;
  const clock = `${hour}:${minute}`;
  const sameDay =
    date.getFullYear() === current.getFullYear() &&
    date.getMonth() === current.getMonth() &&
    date.getDate() === current.getDate();
  if (sameDay) return clock;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`;
}

/** After a choice lands, the other rows keep their labels and drop the rest of the card. */
export function choiceRowQuiet(selectedId: string | null, optionId: string): boolean {
  return selectedId !== null && selectedId !== optionId;
}

/**
 * Folded tool cards sit close to the stream. Open cards keep a short title and a
 * quieter subtitle; the chevron is chrome, not a second heading.
 */
export const toolCardChrome = {
  padX: 12,
  padYFolded: 7,
  padYOpen: 10,
  bodyGap: 8,
  radius: 14,
  rail: 2,
  titleSize: 14,
  titleLine: 20,
  detailSize: 12,
  detailLine: 17,
  chevron: 14,
} as const;

/** Empty-thread rows match the tool-card radius, with a shorter tap target. */
export const suggestionRowChrome = {
  minHeight: 42,
  padX: 12,
  padY: 8,
  radius: 14,
  fontSize: 14,
  lineHeight: 20,
  chevron: 14,
} as const;

export type EmptyThreadSuggestion = {
  label: string;
  prompt?: string;
  section?: "goals";
};

/** Three existing empty-thread affordances. Copy stays Kleio-neutral; the third still opens 目标. */
export function emptyThreadSuggestions(): readonly EmptyThreadSuggestion[] {
  return [
    {
      label: "看看今天有什么新鲜事",
      prompt: "帮我看看今天有什么值得知道的新鲜事",
    },
    {
      label: "读一下一篇网页",
      prompt: "帮我读一篇网页，并说说重点",
    },
    { label: "盯着某个网站", section: "goals" },
  ];
}

export function browserAddressHint(): string {
  return "输入网址，例如 example.com。";
}

export function mailThreadSubtitle(count: number): string {
  return `会话里 ${count} 封`;
}

/** Reply subjects stay as written when they already name a reply. New ones lead in Chinese. */
export function mailReplySubject(subject: string): string {
  const trimmed = subject.trim();
  if (/^(?:re|reply|回复)\s*[:：]/i.test(trimmed)) return subject;
  return `回复：${trimmed}`;
}

export type FormIssue = {
  path: readonly string[];
  code: string;
  format?: string;
};

const MAIL_FIELD_ZH: Record<string, string> = {
  to: "收件人",
  cc: "抄送",
  bcc: "密送",
  subject: "主题",
  body: "正文",
  attachmentIds: "附件",
};

function issueField(issue: FormIssue): string {
  return issue.path[0] ?? "";
}

function isEmailIssue(issue: FormIssue, field: string): boolean {
  if (field !== "to" && field !== "cc" && field !== "bcc" && field !== "attendees") return false;
  return issue.format === "email" || issue.code === "invalid_format";
}

/**
 * Local draft checks. A too-small field already says what is missing, so the
 * extra format note on that same field stays off the screen.
 */
function formIssueLines(
  issues: readonly FormIssue[],
  lineFor: (issue: FormIssue) => string,
  empty: string,
): string {
  const quiet = new Set(
    issues.filter((issue) => issue.code === "too_small" && issue.path[0]).map((issue) => issue.path[0]),
  );
  const lines: string[] = [];
  for (const issue of issues) {
    if (issue.code === "custom" && issue.path[0] && quiet.has(issue.path[0])) continue;
    const line = lineFor(issue);
    if (!lines.includes(line)) lines.push(line);
  }
  return lines.join("\n") || empty;
}

/** Mail composer checks. Field names and validator prose stay off the sheet. */
export function mailDraftError(issues: readonly FormIssue[]): string {
  return formIssueLines(
    issues,
    (issue) => {
      const field = issueField(issue);
      const label = MAIL_FIELD_ZH[field] ?? "这封邮件";
      if (isEmailIssue(issue, field)) return `${label}里有无法识别的邮箱。`;
      if (field === "subject" && issue.code === "custom") return "主题请写在一行里。";
      if (issue.code === "too_small") {
        if (field === "to") return "请填写至少一位收件人。";
        if (field === "subject") return "请写一个主题。";
        if (field === "body") return "请写一点正文。";
        return `请补上${label}。`;
      }
      if (issue.code === "too_big") {
        if (field === "attachmentIds") return "附件最多 10 个。";
        if (field === "to" || field === "cc" || field === "bcc") return `${label}太多了。`;
        if (field === "subject") return "主题太长了。";
        if (field === "body") return "正文太长了。";
        return `${label}超出长度了。`;
      }
      return `${label}还需要改一下。`;
    },
    "这封邮件还没法保存。",
  );
}

/** Calendar composer checks. The zone id itself can stay; the sentence does not. */
export function calendarDraftError(issues: readonly FormIssue[], allDay: boolean): string {
  return formIssueLines(
    issues,
    (issue) => {
      const field = issueField(issue);
      if (isEmailIssue(issue, field)) return "参与者里有无法识别的邮箱。";
      if (issue.code === "custom") {
        if (field === "end") return "结束时间要晚于开始。";
        if (field === "timeZone") return "这个时区无法识别。";
        if (field === "start") return allDay ? "全天日程请填写日期。" : "请填写带时区的开始和结束时间。";
      }
      if (issue.code === "too_small") {
        if (field === "title") return "请写一个标题。";
        if (field === "start") return "请填写开始时间。";
        if (field === "end") return "请填写结束时间。";
        return "请补全日程。";
      }
      if (issue.code === "too_big") {
        if (field === "title") return "标题太长了。";
        if (field === "location") return "地点太长了。";
        if (field === "description") return "备注太长了。";
        if (field === "attendees") return "参与者太多了。";
        return "日程超出长度了。";
      }
      return "日程还需要改一下。";
    },
    "这个日程还没法提交。",
  );
}

/**
 * Chinese title first. A Chinese message stands alone.
 * Latin server text stays on the next line, shortened.
 */
export function surfaceError(title: string, server?: string): string {
  const note = statusServerNote(server);
  if (!note || note === title) return title;
  if (!/[A-Za-z]{3,}/.test(note)) return note;
  return `${title}\n${note}`;
}

const GOOGLE_CAPABILITY_ZH: Record<string, string> = {
  "gmail.readonly": "读取 Gmail",
  "gmail.send": "发送 Gmail",
  "gmail.compose": "撰写 Gmail",
  "gmail.modify": "管理 Gmail",
  "calendar.events.readonly": "读取日历事件",
  "calendar.calendarlist.readonly": "读取日历列表",
  "calendar.events": "管理日历事件",
  "calendar.readonly": "读取日历",
};

/** Connection chips. Unknown scopes stay off the row instead of showing the raw id. */
export function googleCapabilityLabel(value: string): string {
  const scope = value.split("/").at(-1)?.trim() || value.trim();
  return GOOGLE_CAPABILITY_ZH[scope] ?? "其他权限";
}

const COMPUTER_COMMAND_ZH: Record<string, string> = {
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  timed_out: "已超时",
  interrupted: "已中断",
};

/** Command receipt on the computer. The status word and exit label stay Chinese. */
export function computerCommandStatus(status: string, exitCode?: number): string {
  const label = COMPUTER_COMMAND_ZH[operationStatusKey(status)] ?? "状态待更新";
  if (exitCode === undefined) return label;
  return `${label} · 退出码 ${exitCode}`;
}

export function mailRecipientLine(recipients: readonly string[]): string {
  const list = recipients.map((item) => item.trim()).filter(Boolean);
  if (!list.length) return "还没有收件人";
  return `发给 ${list.join("、")}`;
}

export function mailDraftDetail(recipients: readonly string[], savedWhen: string): string {
  return `${mailRecipientLine(recipients)} · ${savedWhen} 保存`;
}

export function mailListTabLabel(tab: "unread" | "drafts", count: number): string {
  return tab === "unread" ? `未读 · ${count}` : `草稿 · ${count}`;
}

export function attachmentCountLabel(count: number): string {
  return `${count} 个附件`;
}

const FILE_SOURCE_ZH: Record<string, string> = {
  upload: "上传",
  uploaded: "上传",
  user: "上传",
  mail: "邮件",
  email: "邮件",
  gmail: "邮件",
  inbox: "邮件",
  attachment: "附件",
  browser: "浏览器",
  download: "下载",
  web: "浏览器",
  filled: "已填写",
  filled_copy: "已填写副本",
};

/** Known file origins become short Chinese. Other values, including names, stay as stored. */
export function fileSourceLabel(source: string): string {
  const key = source.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return FILE_SOURCE_ZH[key] ?? source;
}

/** PDF field names stay as stored. Underscores become spaces; we do not shout them in capitals. */
export function formFieldLabel(name: string): string {
  return name.replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

export function fileDetailLine(input: {
  pageCount: number;
  bytes?: number;
  source?: string;
  /** attachment adds “PDF 附件”. meta is pages and size only. The default row ends in PDF. */
  kind?: "pdf" | "attachment" | "meta";
}): string {
  const parts = [`${input.pageCount} 页`];
  if (typeof input.bytes === "number" && Number.isFinite(input.bytes)) {
    parts.push(`${Math.max(1, Math.round(input.bytes / 1024))} KB`);
  }
  if (input.kind === "attachment") parts.push("PDF 附件");
  else if (input.kind === "meta") {
    if (input.source) parts.push(fileSourceLabel(input.source));
  } else if (input.source) parts.push(fileSourceLabel(input.source));
  else parts.push("PDF");
  return parts.join(" · ");
}

export function fileAddedLine(when: string, filledCopy: boolean): string {
  return filledCopy ? `添加于 ${when} · 已填写副本` : `添加于 ${when}`;
}

export function unsupportedFieldNote(name: string): string {
  return `${formFieldLabel(name)} · 这种字段还填不了`;
}

const BROWSER_STATUS_ZH: Record<string, string> = {
  idle: "空闲",
  active: "使用中",
  closed: "已关闭",
  error: "需要关注",
};

/** Browser session chip. Unknown values reuse the operation chip, which stays non-English. */
export function browserStatusLabel(status: string): string {
  const key = status.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return BROWSER_STATUS_ZH[key] ?? operationStatusLabel(status);
}

export function browserSessionSubtitle(status: string, updatedWhen: string): string {
  return `${browserStatusLabel(status)} · ${updatedWhen} 更新`;
}

export function browserOpenLabel(status: string): string {
  if (status === "closed") return "重新打开";
  if (status === "error") return "重新连接";
  return "打开";
}

export function pdfDownloadsAddedNotice(count: number): string {
  if (count <= 0) return "本次会话没有新的 PDF 下载。";
  return count === 1 ? "1 份 PDF 已放进文件。" : `${count} 份 PDF 已放进文件。`;
}

const DESKTOP_STEP_ZH: Record<string, string> = {
  click: "点了一下",
  type: "输入文字",
  scroll: "滚动页面",
  screenshot: "看了一眼屏幕",
  key: "按了按键",
  move: "移动指针",
  drag: "拖了一下",
  open: "打开了窗口",
  wait: "等了一下",
};

/** Short desktop verbs become spoken Chinese. Longer notes stay as the tool returned them. */
export function desktopStepLabel(action: string | undefined): string {
  if (!action?.trim()) return "桌面步骤";
  const key = action.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return DESKTOP_STEP_ZH[key] ?? action;
}

/** Calendar fields. "开始" becomes "开始日期" / "开始时间", never "开始 date". */
export function datePartLabel(label: string, part: "date" | "time"): string {
  const name = label.trim();
  return part === "date" ? `${name}日期` : `${name}时间`;
}

/**
 * Threads-sheet subtitle. Sample mode and the OpenMuse placeholder "You"
 * are not a person's name.
 */
export function shellProfileSubtitle(name: string | undefined, sample: boolean): string {
  const trimmed = name?.trim() ?? "";
  if (sample || !trimmed || /^you$/i.test(trimmed)) return "你的工作台";
  return trimmed;
}

const COMPUTER_NOTICE_ZH: Record<string, string> = {
  "computer control is not configured.": "电脑还没有配置。",
  "computer control is not configured": "电脑还没有配置。",
};

/** Status line under the computer heading. Known English becomes one Chinese sentence. */
export function computerWorkspaceNotice(message?: string): string | undefined {
  const text = message?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  const known = COMPUTER_NOTICE_ZH[text.toLowerCase()];
  if (known) return known;
  if (/[\u3400-\u9fff]/.test(text)) return text;
  const note = statusServerNote(text);
  return note ? `电脑说明\n${note}` : undefined;
}

const ACTIVITY_EVENT_ZH: Record<string, string> = {
  "task created": "任务已建立",
  "reminder due": "提醒到了",
  "research started": "研究开始了",
  "research result saved": "研究结果已保存",
  "assistant review completed": "助手已看完",
  "outcome unknown": "结果未知",
  "task cancelled": "任务已取消",
  "task canceled": "任务已取消",
};

/** Timeline titles. A raw status key uses the operation chip; other titles stay as written. */
export function activityEventTitle(title: string): string {
  const text = title.trim();
  if (!text) return "状态已更新";
  const known = ACTIVITY_EVENT_ZH[text.toLowerCase().replace(/[.。]+$/g, "")];
  if (known) return known;
  return knownOperationStatus(text) ?? text;
}

const MEMORY_SOURCE_ZH: Record<string, string> = {
  conversation: "对话",
  "authenticated user edit": "你的更正",
};

/** Provenance under a memory. Stored Chinese notes stay. */
export function memorySourceLabel(source: string): string {
  const text = source.trim();
  return MEMORY_SOURCE_ZH[text.toLowerCase()] ?? text;
}

const AVATAR_ZH: Record<string, string> = {
  sky: "晴空",
  sand: "暖沙",
  lilac: "丁香",
};

/** Portrait choice. Not an operation status, so it does not fall through to "状态待更新". */
export function avatarLabel(id: string): string {
  return AVATAR_ZH[id.trim().toLowerCase()] ?? "头像";
}

const TASK_FAILURE_ZH: Record<string, string> = {
  "the runtime stopped before the research outcome was confirmed.": "研究在确认结果前中断了。",
  "the runtime stopped before the research outcome was confirmed": "研究在确认结果前中断了。",
  "this capability is not available in the kleio runtime.": "Kleio 还没有这项能力。",
  "this capability is not available in the kleio runtime": "Kleio 还没有这项能力。",
  "the native memory service could not save this statement.": "记忆服务没有保存这句话。",
  "the native memory service could not save this statement": "记忆服务没有保存这句话。",
  "active memory not found": "没有找到这条记忆。",
  "active memory not found.": "没有找到这条记忆。",
};

/**
 * A task or memory failure shown as its own line.
 * Chinese stays. A known English sentence is replaced. Other Latin keeps a Chinese lead.
 */
export function taskFailureLine(error: string): string {
  const text = error.replace(/\s+/g, " ").trim();
  if (!text) return "";
  const known = TASK_FAILURE_ZH[text.toLowerCase()];
  if (known) return known;
  const operation = knownOperationStatus(text);
  if (operation) return operation;
  if (/[\u3400-\u9fff]/.test(text)) return text;
  const note = statusServerNote(text);
  return note ? `这次没有完成。\n${note}` : "这次没有完成。";
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
