import assert from "node:assert/strict";
import test from "node:test";
import {
  encodeJevAction,
  parseJevAction,
} from "../../../packages/kleio-domain/src/jev.ts";
import { displayJevUserMessage, retryChoiceAvailable } from "./jev-actions.ts";
import {
  approvalAttachmentLine,
  approvalCalendarName,
  approvalEndNote,
  approvalExpirySentence,
  approvalKindLabel,
  approvalProposeLabel,
  approvalStatusLabel,
  backgroundStreamState,
  backgroundToolKind,
  browserReceiptAction,
  choiceRowQuiet,
  calendarAccessSuffix,
  composerBorderColor,
  composerBoxShadow,
  composerChrome,
  composerChromeMetrics,
  composerControlChrome,
  composerNativeShadow,
  composerPlaceholder,
  composerReturnHint,
  composerShortcutHint,
  composerSendFace,
  desktopReceiptActions,
  listedBackgroundTasks,
  knownOperationStatus,
  assistantIdentityIndex,
  liveCueLabel,
  liveTurnCue,
  mailReceiptAction,
  monitorCadenceLine,
  monitorCheckLine,
  operationStatusLabel,
  reviewGateLabel,
  localChatAgentId,
  pairedDeviceName,
  richThreadLabel,
  richThreadValue,
  savedResultReceiptAction,
  searchReceiptAction,
  searchWarningLine,
  shouldCommitComposerEnter,
  surfaceFadeAlphas,
  toolCardStartsOpen,
  attachmentCountLabel,
  browserAddressHint,
  browserOpenLabel,
  browserSessionSubtitle,
  browserStatusLabel,
  chatShellStatus,
  desktopStepLabel,
  activityDetailLine,
  activityEventTitle,
  avatarLabel,
  choiceSelectionLine,
  choiceUnavailableLine,
  computerDesktopHint,
  computerTerminalHint,
  computerWorkspaceNotice,
  datePartLabel,
  documentFieldJsonError,
  documentFieldPlaceholder,
  financeCsvPlaceholder,
  financeCsvSample,
  kleioComputerLinkCopy,
  memorySourceLabel,
  returnKeyCaption,
  shellDateLabel,
  shellProfileSubtitle,
  shellTimeLabel,
  taskFailureLine,
  emptyThreadSuggestions,
  accessGateCopy,
  sheetListStatus,
  sideThreadTitle,
  attendeeCountLine,
  calendarZoneLine,
  shellFailureCopy,
  statusServerNote,
  surfaceChipLabel,
  todayBriefLine,
  todayHeroTitle,
  threadChrome,
  threadStatusCopy,
  threadSurface,
  calendarDraftError,
  computerCommandKeyboardHint,
  computerCommandStatus,
  fileAddedLine,
  fileDetailLine,
  fileShareLabel,
  fieldReturnKeyLabel,
  fileSourceLabel,
  formFieldLabel,
  googleCapabilityLabel,
  mailDraftDetail,
  mailDraftError,
  mailListTabLabel,
  mailRecipientLine,
  mailReplySubject,
  mailThreadSubtitle,
  surfaceError,
  pdfDownloadsAddedNotice,
  suggestionRowChrome,
  toolCardChrome,
  turnSpacing,
  turnTimeLabel,
  unsupportedFieldNote,
  userMessageOverflows,
  withAlpha,
} from "./chat-stream-rules.ts";

test("enter commits the composer only outside IME composition", () => {
  assert.equal(shouldCommitComposerEnter({ key: "Enter" }), true);
  assert.equal(shouldCommitComposerEnter({ key: "Enter", shiftKey: true }), false);
  assert.equal(shouldCommitComposerEnter({ key: "Enter", shiftKey: false }), true);
  assert.equal(shouldCommitComposerEnter({ key: "Enter", isComposing: true }), false);
  assert.equal(shouldCommitComposerEnter({ key: "Enter", composing: true }), false);
  assert.equal(shouldCommitComposerEnter({ key: "Enter", keyCode: 229 }), false);
  assert.equal(shouldCommitComposerEnter({ key: "Process" }), false);
  assert.equal(shouldCommitComposerEnter({ key: "Unidentified" }), false);
  assert.equal(shouldCommitComposerEnter({ key: "a" }), false);
});

test("background status and delegation stay out of the task sheet", () => {
  assert.equal(backgroundToolKind("任务"), "delegate");
  assert.equal(backgroundToolKind("智能体进展"), "status");
  assert.equal(backgroundToolKind("记忆"), null);
  assert.equal(backgroundStreamState("running"), "running");
  assert.equal(backgroundStreamState("waiting_approval"), "pending");
  assert.equal(backgroundStreamState("succeeded"), "done");
  assert.equal(backgroundStreamState("failed"), "error");
  assert.equal(listedBackgroundTasks({ tasks: [{ id: "a" }, { id: "b" }] }), 2);
  assert.equal(listedBackgroundTasks({ id: "one" }), 0);
  assert.equal(listedBackgroundTasks(null), 0);
});

test("reading fades and the composer ring stay on the Kleio surface", () => {
  assert.deepEqual(surfaceFadeAlphas("bottom"), [0, 0.15, 0.5, 0.85, 1]);
  assert.deepEqual(surfaceFadeAlphas("top"), [1, 0.85, 0.5, 0.15, 0]);
  assert.equal(withAlpha("#C8E7FF", 0.5), "#C8E7FF80");
  assert.equal(withAlpha("canvas", 1), "canvas");
  assert.equal(composerChrome({ focused: true, hovered: true }), "focus");
  assert.equal(composerChrome({ focused: false, hovered: true }), "hover");
  assert.equal(composerChrome({ focused: false, hovered: false }), "rest");
  assert.match(composerBoxShadow("focus"), /#1473C8/);
  assert.doesNotMatch(composerBoxShadow("focus"), /d97757/i);
  assert.equal(composerBorderColor("rest"), "#EEEEF0");
  assert.equal(composerBorderColor("focus"), "#1473C8");
});

test("finished tool cards start closed; work in progress stays open", () => {
  assert.equal(toolCardStartsOpen("running"), true);
  assert.equal(toolCardStartsOpen("pending"), true);
  assert.equal(toolCardStartsOpen("done"), false);
  assert.equal(toolCardStartsOpen("paused"), false);
  assert.equal(toolCardStartsOpen("error"), true);
});

test("the send face waits for a real draft and yields to stop", () => {
  assert.equal(composerSendFace({ draft: "", loaded: true, ready: true, replying: false }), "idle");
  assert.equal(composerSendFace({ draft: "  ", loaded: true, ready: true, replying: false }), "idle");
  assert.equal(composerSendFace({ draft: "你好", loaded: false, ready: true, replying: false }), "idle");
  assert.equal(composerSendFace({ draft: "你好", loaded: true, ready: false, replying: false }), "idle");
  assert.equal(composerSendFace({ draft: "你好", loaded: true, ready: true, replying: false }), "send");
  assert.equal(composerSendFace({ draft: "", loaded: true, ready: true, replying: true }), "stop");
  assert.equal(composerSendFace({ draft: "你好", loaded: true, ready: true, replying: true }), "stop");
});

test("composer copy and control chrome stay short and Kleio-colored", () => {
  assert.equal(composerPlaceholder({ ready: false, loaded: false, historyFailed: false }), "正在连接…");
  assert.equal(composerPlaceholder({ ready: true, loaded: false, historyFailed: false }), "正在加载对话…");
  assert.equal(composerPlaceholder({ ready: true, loaded: false, historyFailed: true }), "对话暂时不可用");
  assert.equal(composerPlaceholder({ ready: true, loaded: true, historyFailed: false }), "跟 Kleio 说");
  assert.doesNotMatch(
    [
      composerPlaceholder({ ready: false, loaded: false, historyFailed: false }),
      composerPlaceholder({ ready: true, loaded: true, historyFailed: false }),
    ].join("\n"),
    /message|send|connect/i,
  );
  const idle = composerControlChrome("idle");
  const send = composerControlChrome("send");
  const stop = composerControlChrome("stop");
  assert.equal(send.fill, "#C8E7FF");
  assert.equal(stop.fill, "#1473C8");
  assert.notEqual(idle.fill, send.fill);
  assert.notEqual(stop.icon, send.icon);
  assert.equal(composerChromeMetrics.control, 44);
  assert.equal(composerChromeMetrics.radius, 24);
  assert.equal(composerChromeMetrics.chipPadY < 4, true);
  assert.equal(composerNativeShadow("focus").elevation > composerNativeShadow("rest").elevation, true);
  assert.match(composerBoxShadow("rest"), /0\.05/);
});

test("calendar, monitor, and connection lines drop the leftover English", () => {
  assert.equal(calendarAccessSuffix("owner"), "");
  assert.equal(calendarAccessSuffix("writer"), "");
  assert.equal(calendarAccessSuffix("reader"), " · 只读");
  assert.equal(calendarAccessSuffix("freeBusyReader"), " · 只读");
  assert.equal(richThreadLabel(), "多段对话");
  assert.equal(richThreadValue(true), "已接通");
  assert.equal(richThreadValue(false), "未连接");
  assert.equal(pairedDeviceName(), "这部手机");
  assert.equal(localChatAgentId("thread-1"), "kleio-thread-1");
  assert.doesNotMatch(
    [richThreadLabel(), pairedDeviceName(), localChatAgentId("thread-1")].join("\n"),
    /openbot|iphone|rich thread/i,
  );
  assert.equal(monitorCadenceLine(15, 3), "每 15 分钟 · 已查 3 次");
  assert.equal(monitorCheckLine("尚未检查"), "上次 尚未检查");
  assert.equal(monitorCheckLine("10月20日 14:30", "10月20日 14:45"), "上次 10月20日 14:30\n下次 10月20日 14:45");
  const copy = [
    calendarAccessSuffix("reader"),
    richThreadValue(true),
    monitorCadenceLine(15, 3),
    monitorCheckLine("尚未检查", "稍后"),
  ].join("\n");
  assert.doesNotMatch(copy, /read only|every |last check|next check|copilotkit/i);
});

test("the live cue is a thought, then writing, and stays out of a running tool", () => {
  const turns = [
    { role: "user", content: "看看天气" },
    { role: "assistant", content: "", toolCallIds: ["call-1"] },
  ];
  assert.equal(liveTurnCue({ replying: false, turns, settledToolIds: new Set() }), null);
  assert.equal(liveTurnCue({ replying: true, turns: [{ role: "user", content: "你好" }], settledToolIds: new Set() }), "thinking");
  assert.equal(liveTurnCue({ replying: true, turns, settledToolIds: new Set() }), null);
  assert.equal(
    liveTurnCue({
      replying: true,
      turns: [...turns, { role: "assistant", content: "今天" }],
      settledToolIds: new Set(["call-1"]),
    }),
    "writing",
  );
  assert.equal(
    liveTurnCue({
      replying: true,
      turns: [{ role: "user", content: "早" }, { role: "assistant", content: "   " }],
      settledToolIds: new Set(),
    }),
    "thinking",
  );
});

test("bubble rhythm, the live cue, and the clock stay in the chat shell", () => {
  assert.equal(turnSpacing(null, "user"), 0);
  assert.equal(turnSpacing("user", "user"), 6);
  assert.equal(turnSpacing("user", "assistant"), 16);
  assert.equal(turnSpacing("assistant", "assistant"), 6);
  assert.equal(liveCueLabel("thinking"), "正在思考");
  assert.equal(liveCueLabel("writing"), "正在写回复");
  assert.doesNotMatch(liveCueLabel("thinking"), /[A-Za-z]/);
  assert.doesNotMatch(liveCueLabel("writing"), /[A-Za-z]/);
  const turns = [
    { role: "user", present: true },
    { role: "assistant", present: false },
    { role: "assistant", present: true },
    { role: "assistant", present: true },
  ];
  assert.equal(assistantIdentityIndex(turns, 0), false);
  assert.equal(assistantIdentityIndex(turns, 1), false);
  assert.equal(assistantIdentityIndex(turns, 2), true);
  assert.equal(assistantIdentityIndex(turns, 3), false);
  const now = Date.parse("2026-10-20T12:00:00.000Z");
  const sameDay = turnTimeLabel("2026-10-20T12:30:00.000Z", now);
  const older = turnTimeLabel("2026-10-18T08:05:00.000Z", now);
  assert.match(sameDay ?? "", /^\d{2}:\d{2}$/);
  assert.match(older ?? "", /^\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/);
  assert.doesNotMatch(`${sameDay} ${older}`, /[A-Za-z]/);
  assert.equal(turnTimeLabel(undefined, now), null);
  assert.equal(turnTimeLabel("not-a-time", now), null);
});

test("a settled choice keeps only the chosen row in full", () => {
  assert.equal(choiceRowQuiet(null, "a"), false);
  assert.equal(choiceRowQuiet("a", "a"), false);
  assert.equal(choiceRowQuiet("a", "b"), true);
});

test("folded tool cards keep the primary action on the receipt", () => {
  assert.equal(mailReceiptAction({ search: false, failed: false, hasMessage: true })?.label, "打开邮件");
  assert.equal(mailReceiptAction({ search: false, failed: false, hasMessage: true })?.staysOnReceipt, true);
  assert.equal(mailReceiptAction({ search: true, failed: false, hasMessage: true }), null);
  assert.equal(mailReceiptAction({ search: false, failed: true, hasMessage: true }), null);
  assert.equal(searchReceiptAction({ loading: false, failed: false, sourceCount: 1 })?.label, "打开来源");
  assert.equal(searchReceiptAction({ loading: false, failed: false, sourceCount: 3 })?.label, "打开首个来源");
  assert.equal(searchReceiptAction({ loading: true, failed: false, sourceCount: 3 }), null);
  assert.equal(searchReceiptAction({ loading: false, failed: true, sourceCount: 3 }), null);
  assert.equal(searchReceiptAction({ loading: false, failed: false, sourceCount: 0 }), null);
  assert.equal(browserReceiptAction({ loading: false, hasVisit: true })?.label, "接管控制");
  assert.equal(browserReceiptAction({ loading: true, hasVisit: true }), null);
  assert.equal(browserReceiptAction({ loading: false, hasVisit: false }), null);
  assert.deepEqual(
    desktopReceiptActions({ offline: false, starting: false }).map((item) => item.label),
    ["在「桌面」页打开"],
  );
  assert.deepEqual(
    desktopReceiptActions({ offline: true, starting: false }).map((item) => item.label),
    ["启动电脑", "在「桌面」页打开"],
  );
  assert.deepEqual(
    desktopReceiptActions({ offline: true, starting: true }).map((item) => item.label),
    ["启动中…", "在「桌面」页打开"],
  );
  assert.equal(desktopReceiptActions({ offline: true, starting: false }).every((item) => item.staysOnReceipt), true);
  assert.equal(savedResultReceiptAction({ name: "记忆", loading: false, failed: false })?.label, "查看记忆");
  assert.equal(savedResultReceiptAction({ name: "目标", loading: false, failed: false })?.label, "查看目标");
  assert.equal(savedResultReceiptAction({ name: "盯梢", loading: false, failed: false })?.label, "查看盯梢");
  assert.equal(savedResultReceiptAction({ name: "记忆", loading: true, failed: false }), null);
  assert.equal(savedResultReceiptAction({ name: "记忆", loading: false, failed: true }), null);
});

test("operation chips and the review gate stay in Chinese", () => {
  assert.equal(reviewGateLabel(2), "待你审阅 · 2");
  assert.equal(reviewGateLabel(0), "待你审阅 · 0");
  assert.doesNotMatch(reviewGateLabel(1), /needs|review/i);
  assert.equal(operationStatusLabel("running"), "进行中");
  assert.equal(operationStatusLabel("completed"), "已完成");
  assert.equal(operationStatusLabel("failed"), "失败");
  assert.equal(operationStatusLabel("cancelled"), "已取消");
  assert.equal(operationStatusLabel("canceled"), "已取消");
  assert.equal(operationStatusLabel("Needs review"), "待你审阅");
  assert.equal(operationStatusLabel("needs_review"), "待你审阅");
  assert.equal(operationStatusLabel("awaiting_review"), "待你审阅");
  assert.equal(operationStatusLabel("WAITING APPROVAL"), "待你审阅");
  assert.equal(operationStatusLabel("waiting_input"), "需要你补充");
  assert.equal(operationStatusLabel("read"), "已读");
  assert.equal(operationStatusLabel("unread"), "未读");
  assert.equal(operationStatusLabel("queued"), "排队中");
  assert.equal(knownOperationStatus("finance"), undefined);
  assert.equal(operationStatusLabel("finance"), "状态待更新");
  assert.equal(approvalStatusLabel("failed"), "未完成");
  assert.doesNotMatch(operationStatusLabel("running"), /[A-Za-z]/);
});

test("approval copy stays in Chinese and matches the chat shell", () => {
  assert.equal(approvalStatusLabel("awaiting_review"), "待你审阅");
  assert.equal(approvalStatusLabel("executing"), "正在执行");
  assert.equal(approvalStatusLabel("succeeded"), "已完成");
  assert.equal(approvalStatusLabel("failed"), "未完成");
  assert.equal(approvalStatusLabel("denied"), "未继续");
  assert.equal(approvalStatusLabel("expired"), "已过期");
  assert.equal(approvalStatusLabel("awaiting review"), "状态待更新");
  assert.equal(approvalKindLabel("email.send"), "发送邮件");
  assert.equal(approvalKindLabel("calendar.create"), "新建日程");
  assert.equal(approvalKindLabel("calendar.update"), "更改日程");
  assert.equal(approvalKindLabel("calendar.delete"), "删除日程");
  assert.equal(approvalKindLabel("email · send"), "这项操作");
  assert.equal(approvalProposeLabel(false), "提交审阅");
  assert.equal(approvalProposeLabel(true), "审阅变更");
  assert.equal(
    approvalExpirySentence("2026年10月20日 17:03"),
    "请在 2026年10月20日 17:03 前确认。这次确认只对上面这些内容有效。",
  );
  assert.doesNotMatch(approvalExpirySentence("明天"), /review|approval|expires/i);
  assert.equal(approvalCalendarName("primary"), "主日历");
  assert.equal(approvalCalendarName(""), "主日历");
  assert.equal(approvalCalendarName("family"), "family");
  assert.equal(approvalEndNote(true), "（不含这一天）");
  assert.equal(approvalEndNote(false), "");
  assert.equal(approvalAttachmentLine("合同.pdf", "abc123456789"), "合同.pdf · 版本 23456789");
  assert.doesNotMatch(approvalAttachmentLine("合同.pdf", "abc123456789"), /version/i);
});

test("mail, file, and browser detail rows stay in short Chinese", () => {
  assert.equal(mailThreadSubtitle(1), "会话里 1 封");
  assert.equal(mailThreadSubtitle(3), "会话里 3 封");
  assert.equal(mailRecipientLine(["a@example.com", " b@example.com "]), "发给 a@example.com、b@example.com");
  assert.equal(mailRecipientLine(["  "]), "还没有收件人");
  assert.equal(mailDraftDetail(["a@example.com"], "10月20日"), "发给 a@example.com · 10月20日 保存");
  assert.equal(mailListTabLabel("unread", 2), "未读 · 2");
  assert.equal(mailListTabLabel("drafts", 0), "草稿 · 0");
  assert.equal(attachmentCountLabel(1), "1 个附件");
  assert.equal(fileSourceLabel("Gmail"), "邮件");
  assert.equal(fileSourceLabel("filled copy"), "已填写副本");
  assert.equal(fileSourceLabel("合同扫描"), "合同扫描");
  assert.equal(formFieldLabel("full_name"), "full name");
  assert.equal(fileDetailLine({ pageCount: 2, kind: "attachment" }), "2 页 · PDF 附件");
  assert.equal(
    fileDetailLine({ pageCount: 4, bytes: 2048, source: "browser" }),
    "4 页 · 2 KB · 浏览器",
  );
  assert.equal(fileDetailLine({ pageCount: 1, bytes: 100, kind: "meta" }), "1 页 · 1 KB");
  assert.equal(fileDetailLine({ pageCount: 3 }), "3 页 · PDF");
  assert.equal(fileAddedLine("10月20日", false), "添加于 10月20日");
  assert.equal(fileAddedLine("10月20日", true), "添加于 10月20日 · 已填写副本");
  assert.equal(unsupportedFieldNote("signature_field"), "signature field · 这种字段还填不了");
  assert.equal(browserStatusLabel("active"), "使用中");
  assert.equal(browserStatusLabel("closed"), "已关闭");
  assert.equal(browserStatusLabel("error"), "需要关注");
  assert.equal(browserStatusLabel("idle"), "空闲");
  assert.equal(browserStatusLabel("mystery"), "状态待更新");
  assert.equal(browserSessionSubtitle("active", "14:03"), "使用中 · 14:03 更新");
  assert.equal(browserOpenLabel("active"), "打开");
  assert.equal(browserOpenLabel("closed"), "重新打开");
  assert.equal(browserOpenLabel("error"), "重新连接");
  assert.equal(pdfDownloadsAddedNotice(0), "本次会话没有新的 PDF 下载。");
  assert.equal(pdfDownloadsAddedNotice(1), "1 份 PDF 已放进文件。");
  assert.equal(pdfDownloadsAddedNotice(2), "2 份 PDF 已放进文件。");
  assert.equal(desktopStepLabel(undefined), "桌面步骤");
  assert.equal(desktopStepLabel("click"), "点了一下");
  assert.equal(desktopStepLabel("scroll the page"), "滚动页面");
  assert.equal(desktopStepLabel("MouseEvent at 12,20"), "桌面步骤");
  assert.equal(desktopStepLabel("已打开表格"), "已打开表格");
  const detailCopy = [
    mailThreadSubtitle(2),
    mailDraftDetail(["a@example.com"], "今天"),
    fileDetailLine({ pageCount: 1, bytes: 1024, source: "upload" }),
    browserSessionSubtitle("closed", "昨天"),
    browserAddressHint(),
  ].join("\n");
  assert.doesNotMatch(detailCopy, /message|pages|updated|attachment|download|hacker|copilotkit|ycombinator/i);
});

test("empty thread keeps three Kleio suggestions and drops demo stubs", () => {
  const suggestions = emptyThreadSuggestions();
  assert.equal(suggestions.length, 3);
  assert.equal(suggestions[2]?.section, "goals");
  assert.equal(suggestions.filter((item) => item.prompt).length, 2);
  const copy = suggestions.map((item) => `${item.label} ${item.prompt ?? ""}`).join("\n");
  assert.match(copy, /新鲜事/);
  assert.match(copy, /网页/);
  assert.match(copy, /盯着某个网站/);
  assert.doesNotMatch(copy, /hacker|copilotkit|ycombinator|news\./i);
  assert.equal(toolCardChrome.padYFolded < toolCardChrome.padYOpen, true);
  assert.equal(toolCardChrome.titleSize > toolCardChrome.detailSize, true);
  assert.equal(toolCardChrome.chevron, 14);
  assert.equal(suggestionRowChrome.radius, toolCardChrome.radius);
  assert.equal(browserAddressHint(), "输入网址，例如 example.com。");
});

test("mail, file, and computer leftovers stay in short Chinese", () => {
  assert.equal(mailReplySubject("周会"), "回复：周会");
  assert.equal(mailReplySubject("Re: 周会"), "Re: 周会");
  assert.equal(mailReplySubject("  re:周会"), "  re:周会");
  assert.equal(mailReplySubject("回复：周会"), "回复：周会");
  assert.equal(mailReplySubject("Reply: 周会"), "Reply: 周会");
  const mail = mailDraftError([
    { path: ["to"], code: "too_small" },
    { path: ["to", "0"], code: "invalid_format", format: "email" },
    { path: ["cc", "0"], code: "invalid_format", format: "email" },
    { path: ["subject"], code: "too_small" },
    { path: ["subject"], code: "custom" },
    { path: ["body"], code: "too_small" },
    { path: ["attachmentIds"], code: "too_big" },
    { path: ["subject"], code: "too_big" },
  ]);
  assert.match(mail, /请填写至少一位收件人/);
  assert.match(mail, /抄送里有无法识别的邮箱/);
  assert.match(mail, /请写一个主题/);
  assert.match(mail, /请写一点正文/);
  assert.match(mail, /附件最多 10 个/);
  assert.doesNotMatch(mail, /主题请写在一行里/);
  assert.equal(
    mailDraftError([{ path: ["subject"], code: "custom" }]),
    "主题请写在一行里。",
  );
  assert.equal(
    mailDraftError([{ path: ["body"], code: "too_big" }]),
    "正文太长了。",
  );
  assert.equal(mailDraftError([]), "这封邮件还没法保存。");
  const timed = calendarDraftError(
    [
      { path: ["title"], code: "too_small" },
      { path: ["end"], code: "custom" },
      { path: ["start"], code: "custom" },
      { path: ["timeZone"], code: "custom" },
      { path: ["attendees", "0"], code: "invalid_format", format: "email" },
    ],
    false,
  );
  assert.match(timed, /请写一个标题/);
  assert.match(timed, /结束时间要晚于开始/);
  assert.match(timed, /请填写带时区的开始和结束时间/);
  assert.match(timed, /这个时区无法识别/);
  assert.match(timed, /参与者里有无法识别的邮箱/);
  assert.equal(
    calendarDraftError([{ path: ["start"], code: "custom" }], true),
    "全天日程请填写日期。",
  );
  assert.equal(
    calendarDraftError([{ path: ["start"], code: "too_small" }, { path: ["start"], code: "custom" }], false),
    "请填写开始时间。",
  );
  assert.equal(surfaceError("无法导入此 PDF。"), "无法导入此 PDF。");
  assert.equal(surfaceError("无法导入此 PDF。", "无法导入此 PDF。"), "无法导入此 PDF。");
  assert.equal(
    surfaceError("无法导入此 PDF。", "无法读取所选文件。请重新选择。"),
    "无法读取所选文件。请重新选择。",
  );
  assert.equal(surfaceError("无法显示此 PDF。", "Failed to load document"), "无法显示此 PDF。");
  assert.equal(surfaceError("这封邮件没有保存。", "Authentication required"), "需要先登录。");
  assert.equal(
    googleCapabilityLabel("https://www.googleapis.com/auth/gmail.readonly"),
    "读取 Gmail",
  );
  assert.equal(googleCapabilityLabel("gmail.modify"), "管理 Gmail");
  assert.equal(googleCapabilityLabel("gmail.metadata"), "其他权限");
  assert.equal(computerCommandStatus("running"), "运行中");
  assert.equal(computerCommandStatus("succeeded", 0), "已完成 · 退出码 0");
  assert.equal(computerCommandStatus("failed", 1), "失败 · 退出码 1");
  assert.equal(computerCommandStatus("timed_out"), "已超时");
  assert.equal(computerCommandStatus("interrupted"), "已中断");
  assert.equal(computerCommandStatus("mystery"), "状态待更新");
  const copy = [mail, timed, computerCommandStatus("timed_out", 124), googleCapabilityLabel("gmail.metadata")].join(
    "\n",
  );
  assert.doesNotMatch(copy, /Invalid|Subject must|Too small|Too big|exit\b|timed out|succeeded|gmail\./i);
});

test("thread status copy stays short, Chinese, and has one action when a person can do something", () => {
  const kinds = [
    "opening",
    "opening-failed",
    "connecting",
    "reconnecting",
    "connect-failed",
    "offline",
    "loading",
    "syncing",
    "history-failed",
    "history-partial",
    "empty-side",
    "run-failed",
  ] as const;
  const lines = kinds.map((kind) => {
    const copy = threadStatusCopy(kind);
    assert.ok(copy.title.length > 0 && copy.title.length <= 16);
    assert.ok(copy.detail.length > 0 && copy.detail.length <= 28);
    return `${copy.title} ${copy.detail} ${copy.actionLabel ?? ""}`;
  });
  assert.equal(threadStatusCopy("opening").busy, true);
  assert.equal(threadStatusCopy("opening-failed").actionLabel, "重试");
  assert.equal(threadStatusCopy("offline").tone, "paused");
  assert.equal(threadStatusCopy("offline").actionLabel, "重新连接");
  assert.equal(threadStatusCopy("history-failed").actionLabel, "重试加载");
  assert.equal(threadStatusCopy("empty-side").actionLabel, undefined);
  assert.equal(threadStatusCopy("run-failed").actionLabel, "重试回复");
  assert.doesNotMatch(lines.join("\n"), /\b(retry|offline|loading|error|connect|failed|thread|message)\b/i);
  assert.equal(threadChrome.statusTitle < threadChrome.statusHero, true);
  assert.equal(threadChrome.titleSize, 15);
});

test("threads sheet and access gate use the same short Chinese status", () => {
  const sheetKinds = ["loading", "failed", "empty", "empty-archived", "more-failed", "action-failed"] as const;
  const sheetLines = sheetKinds.map((kind) => {
    const copy = sheetListStatus(kind);
    assert.ok(copy.title.length > 0 && copy.title.length <= 16, copy.title);
    assert.ok(copy.detail.length > 0 && copy.detail.length <= 28, copy.detail);
    return `${copy.title} ${copy.detail} ${copy.actionLabel ?? ""}`;
  });
  assert.equal(sheetListStatus("loading").busy, true);
  assert.equal(sheetListStatus("failed").actionLabel, "重试");
  assert.equal(sheetListStatus("failed").tone, "error");
  assert.equal(sheetListStatus("empty").actionLabel, undefined);
  assert.equal(sheetListStatus("empty-archived").actionLabel, undefined);
  assert.equal(sheetListStatus("more-failed").actionLabel, "重试");
  assert.equal(sheetListStatus("action-failed").actionLabel, undefined);
  const gate = accessGateCopy();
  for (const copy of [gate.connecting, gate.workspaceOpening, gate.workspaceFailed]) {
    assert.ok(copy.title.length > 0 && copy.title.length <= 16, copy.title);
    assert.ok(copy.detail.length > 0 && copy.detail.length <= 28, copy.detail);
  }
  assert.ok(gate.welcomeTitle.length <= 16);
  assert.ok(gate.welcomeDetail.length <= 28);
  assert.ok(gate.failedTitle.length <= 16);
  assert.ok(gate.failedDetail.length <= 28);
  assert.equal(gate.connecting.busy, true);
  assert.equal(gate.workspaceOpening.busy, true);
  assert.equal(gate.workspaceFailed.actionLabel, "再试一次");
  assert.equal(gate.tokenLabel, "访问令牌");
  assert.equal(gate.submitLabel, "打开工作台");
  assert.match(gate.welcomeTitle, /Kleio/);
  assert.match(gate.connecting.title, /Kleio/);
  const chrome = [
    ...sheetLines,
    gate.welcomeTitle,
    gate.welcomeDetail,
    gate.connecting.title,
    gate.connecting.detail,
    gate.tokenLabel,
    gate.tokenPlaceholder,
    gate.helper,
    gate.submitLabel,
    gate.failedTitle,
    gate.failedDetail,
    gate.workspaceOpening.title,
    gate.workspaceOpening.detail,
    gate.workspaceFailed.title,
    gate.workspaceFailed.detail,
    gate.workspaceFailed.actionLabel ?? "",
  ].join("\n");
  assert.doesNotMatch(chrome, /\b(retry|loading|error|failed|thread|token|spinner|pnpm|offline)\b/i);
  assert.doesNotMatch(chrome, /KLEIO_TOKEN/);
  assert.equal(statusServerNote("  连接超时  "), "连接超时");
  assert.equal(statusServerNote("   "), undefined);
  assert.equal(statusServerNote(undefined), undefined);
  const longNote = statusServerNote("连接超时".repeat(30));
  assert.equal(longNote?.length, 72);
  assert.equal(longNote?.endsWith("…"), true);
  assert.match(longNote ?? "", /^连接超时/);
  assert.equal(composerShortcutHint(), "回车发送，上档+回车换行");
  assert.doesNotMatch(composerShortcutHint(), /[A-Za-z]/);
  assert.equal(composerReturnHint(), "回车换行");
  assert.doesNotMatch(composerReturnHint(), /[A-Za-z]/);
  const failureKinds = ["save", "stop", "choice", "choice-unreadable"] as const;
  const failureLines = failureKinds.map((kind) => {
    const copy = shellFailureCopy(kind);
    assert.ok(copy.title.length > 0 && copy.title.length <= 16, copy.title);
    assert.ok(copy.detail.length > 0 && copy.detail.length <= 28, copy.detail);
    return `${copy.title} ${copy.detail}`;
  });
  assert.equal(shellFailureCopy("save").title, "对话没有保存");
  assert.equal(shellFailureCopy("stop").title, "没能停下来");
  assert.equal(shellFailureCopy("choice").title, "选择没有发出");
  assert.doesNotMatch(failureLines.join("\n"), /\b(error|failed|exception|save|stop|retry)\b/i);
  assert.equal(todayHeroTitle(), "今天，多留一点\n喘息的空间。");
  assert.equal(todayBriefLine(2, 1), "日历上有 2 件事，1 封未读邮件。\n把时间留给要紧的事。");
  assert.equal(todayBriefLine(0, 0), "日历还有空档。\n把时间留给要紧的事。");
  assert.equal(calendarZoneLine("  ", "Asia/Shanghai"), "你的日历 · Asia/Shanghai。日程按各自时区显示。");
  assert.equal(attendeeCountLine(3), "3 位参与者");
  assert.equal(attendeeCountLine(0), "属于你的时间");
  const calendarCopy = [todayHeroTitle(), todayBriefLine(2, 1), calendarZoneLine("工作", "Asia/Shanghai"), attendeeCountLine(2)].join("\n");
  assert.doesNotMatch(calendarCopy, /things on your calendar|unread emails|attendees|Events show/i);
  assert.equal(surfaceChipLabel("plan"), "计划");
  assert.equal(surfaceChipLabel("Needs review"), "待你审阅");
  assert.equal(surfaceChipLabel("mystery-kind"), "状态待更新");
  assert.doesNotMatch(surfaceChipLabel("comparison"), /[A-Za-z]/);
});

test("an empty thread picks one status, and messages keep a single banner", () => {
  const quiet = {
    historyFailed: false,
    loaded: true,
    syncing: false,
    hasMessages: false,
    replying: false,
    side: false,
    connectFailed: false,
    reconnecting: false,
    offline: false,
  };
  assert.deepEqual(threadSurface(quiet), { place: "hero" });
  assert.deepEqual(threadSurface({ ...quiet, side: true }), { place: "screen", kind: "empty-side" });
  assert.deepEqual(threadSurface({ ...quiet, loaded: false }), { place: "screen", kind: "loading" });
  assert.deepEqual(threadSurface({ ...quiet, loaded: false, historyFailed: true }), {
    place: "screen",
    kind: "history-failed",
  });
  assert.deepEqual(threadSurface({ ...quiet, syncing: true }), { place: "screen", kind: "syncing" });
  assert.deepEqual(threadSurface({ ...quiet, offline: true, reconnecting: true }), {
    place: "screen",
    kind: "offline",
  });
  assert.deepEqual(threadSurface({ ...quiet, connectFailed: true }), {
    place: "screen",
    kind: "connect-failed",
  });
  assert.deepEqual(threadSurface({ ...quiet, hasMessages: true, historyFailed: true, offline: true }), {
    place: "banner",
    kind: "history-partial",
  });
  assert.deepEqual(threadSurface({ ...quiet, hasMessages: true, offline: true, syncing: true }), {
    place: "banner",
    kind: "offline",
  });
  assert.deepEqual(
    threadSurface({ ...quiet, hasMessages: true, syncing: true, replying: false }),
    { place: "cue", kind: "syncing" },
  );
  assert.deepEqual(
    threadSurface({ ...quiet, hasMessages: true, syncing: true, replying: true }),
    { place: "messages" },
  );
  assert.deepEqual(threadSurface({ ...quiet, hasMessages: true }), { place: "messages" });
});

test("shell status and side-thread titles stay one short line", () => {
  assert.equal(chatShellStatus({ approval: "寄合同" }), "待你审阅 · 寄合同");
  assert.equal(chatShellStatus({ approval: "寄合同", offline: true }), "待你审阅 · 寄合同");
  assert.equal(chatShellStatus({ needsInput: "地址" }), "需要你补充 · 地址");
  assert.equal(chatShellStatus({ offline: true, reconnecting: true }), "暂时离线");
  assert.equal(chatShellStatus({ connectFailed: true }), "没能连上");
  assert.equal(chatShellStatus({ reconnecting: true }), "正在重新连接");
  assert.equal(chatShellStatus({ connecting: true }), "正在连接");
  assert.equal(chatShellStatus({ running: "整理行程" }), "整理行程");
  assert.equal(chatShellStatus({ queued: true }), "正在接下一项任务…");
  assert.equal(chatShellStatus({}), "有需要时我就在");
  assert.deepEqual(sideThreadTitle("  "), { title: "旁路对话", detail: "和主对话分开" });
  assert.deepEqual(sideThreadTitle("旅行"), { title: "旅行", detail: "和主对话分开" });
  assert.equal(composerPlaceholder({ ready: true, loaded: true, historyFailed: false, offline: true }), "Kleio 暂时离线");
  assert.equal(
    composerPlaceholder({ ready: true, loaded: false, historyFailed: false, reconnecting: true }),
    "正在重新连接…",
  );
  assert.doesNotMatch(
    [chatShellStatus({ offline: true }), sideThreadTitle().title, sideThreadTitle().detail].join("\n"),
    /\b(offline|thread|side|reconnect)\b/i,
  );
});

test("long user messages collapse; short ones stay open", () => {
  assert.equal(userMessageOverflows("短消息"), false);
  assert.equal(userMessageOverflows("a".repeat(280)), false);
  assert.equal(userMessageOverflows("a".repeat(281)), true);
  assert.equal(userMessageOverflows("1\n2\n3\n4\n5\n6"), false);
  assert.equal(userMessageOverflows("1\n2\n3\n4\n5\n6\n7"), true);
});

test("mail, calendar, files, and computer clocks stay Chinese", () => {
  const stamp = "2026-10-21T07:09:00.000Z";
  const dateOptions = { month: "short" as const, day: "numeric" as const, timeZone: "UTC" };
  const heading = {
    weekday: "long" as const,
    month: "long" as const,
    day: "numeric" as const,
    timeZone: "UTC",
  };
  assert.equal(shellDateLabel(stamp, dateOptions), "10月21日");
  assert.equal(shellDateLabel(stamp, heading), "10月21日星期三");
  assert.equal(shellTimeLabel(stamp, "UTC"), "07:09");
  assert.equal(shellTimeLabel(stamp, "Asia/Shanghai"), "15:09");
  assert.equal(shellDateLabel("not-a-date"), "not-a-date");
  assert.equal(shellTimeLabel("not-a-date"), "not-a-date");
  assert.equal(shellTimeLabel(stamp, "Not/AZone"), stamp);
  const shown = [
    shellDateLabel(stamp, dateOptions),
    shellDateLabel(stamp, heading),
    shellTimeLabel(stamp, "UTC"),
    shellTimeLabel(stamp, "Asia/Shanghai"),
  ].join("\n");
  assert.doesNotMatch(shown, /\b(AM|PM|Oct|October|Wednesday)\b/);
  assert.equal(returnKeyCaption("go"), "前往");
  assert.equal(returnKeyCaption("search"), "搜索");
  assert.equal(returnKeyCaption("done"), "完成");
  assert.equal(returnKeyCaption("next"), "下一项");
  assert.equal(returnKeyCaption("newline"), "换行");
  assert.equal(returnKeyCaption("send"), "发送");
  assert.equal(fieldReturnKeyLabel({ returnKeyType: "go" }), "前往");
  assert.equal(fieldReturnKeyLabel({ returnKeyType: "search" }), "搜索");
  assert.equal(fieldReturnKeyLabel({ multiline: true }), "换行");
  assert.equal(fieldReturnKeyLabel({}), "完成");
  assert.equal(fieldReturnKeyLabel({ returnKeyLabel: "完成" }), "完成");
  assert.doesNotMatch(
    [
      returnKeyCaption("go"),
      returnKeyCaption("search"),
      returnKeyCaption("done"),
      returnKeyCaption("next"),
      returnKeyCaption("newline"),
      returnKeyCaption("send"),
      fieldReturnKeyLabel({ returnKeyType: "go" }),
      fieldReturnKeyLabel({ multiline: true }),
      fieldReturnKeyLabel({}),
    ].join("\n"),
    /\b(go|search|done|next|enter|return|send)\b/i,
  );
});

test("calendar fields, the thread sheet, and computer notices stay in Chinese", () => {
  assert.equal(datePartLabel("开始", "date"), "开始日期");
  assert.equal(datePartLabel("结束", "time"), "结束时间");
  assert.doesNotMatch(datePartLabel("开始", "date"), /\bdate\b/i);
  assert.doesNotMatch(datePartLabel("开始", "time"), /\btime\b/i);
  assert.equal(shellProfileSubtitle("You", false), "你的工作台");
  assert.equal(shellProfileSubtitle("OpenBot", false), "你的工作台");
  assert.equal(shellProfileSubtitle("  ", true), "你的工作台");
  assert.equal(shellProfileSubtitle("小洋", false), "小洋");
  const kleioLink = kleioComputerLinkCopy();
  assert.equal(kleioLink.name, "Kleio");
  assert.equal(kleioLink.title, "Kleio");
  assert.equal(kleioLink.body, "外部执行还没接上。这台电脑现在用 Kleio 自己的浏览器工作进程。");
  assert.doesNotMatch(`${kleioLink.name}\n${kleioLink.title}\n${kleioLink.body}`, /OpenBot|openbot/);
  assert.equal(computerWorkspaceNotice("Computer control is not configured."), "电脑还没有配置。");
  assert.equal(computerWorkspaceNotice("电脑已停止。"), "电脑已停止。");
  assert.equal(computerWorkspaceNotice("docker socket missing"), "电脑说明\n具体原因没有显示。");
  assert.doesNotMatch(
    [
      datePartLabel("开始", "date"),
      shellProfileSubtitle("You", false),
      computerWorkspaceNotice("Computer control is not configured."),
    ].join("\n"),
    /\b(date|time|you|computer control)\b/i,
  );
});

test("known chat, gate, and tool failures replace the English sentence", () => {
  const samples = [
    ["Authentication required", "需要先登录。"],
    ["Pairing code expired or incorrect. Generate another code on your computer.", "配对码已失效。请在电脑上再生成一个。"],
    ["Execution cancelled", "这次回复已取消。"],
    ["Only a stopped turn can be retried", "只有已停下的这一轮可以重试。"],
    ["Memory recall is disabled", "记忆召回已关闭。"],
    ["The runtime stopped before the research outcome was confirmed.", "研究在确认结果前中断了。"],
    ["Work task not found.", "没有找到这项事务。"],
    ["Enter a positive price", "请填写大于零的价格。"],
    ["Invalid time zone", "这个时区无法识别。"],
    ["Failed to fetch", "没有连上 Kleio。"],
    ["Request cancelled", "请求已取消。"],
    ["Web search cancelled", "搜索已取消。"],
    ["Tavily search timed out. Try again later.", "网页搜索超时了。请稍后再试。"],
    ["Memory not found.", "没有找到这条记忆。"],
    ["Remembered text must be an exact quote from the user.", "要记住的话须与你刚才说的完全一致。"],
    ["Duplicate option ID", "选项编号重复了。"],
  ] as const;
  for (const [english, chinese] of samples) {
    assert.equal(statusServerNote(english), chinese);
    assert.equal(taskFailureLine(english), chinese);
  }
  assert.equal(statusServerNote("  Execution cancelled.  "), "这次回复已取消。");
  assert.equal(statusServerNote("TypeError: Failed to fetch"), "没有连上 Kleio。");
  assert.equal(statusServerNote("Error: Authentication required"), "需要先登录。");
  assert.equal(
    statusServerNote("Error: 工作台无响应。请确认服务器可达后再试。"),
    "工作台无响应。请确认服务器可达后再试。",
  );
  assert.equal(statusServerNote("连接超时"), "连接超时");
  assert.equal(taskFailureLine("TypeError: Execution cancelled"), "这次回复已取消。");
  assert.equal(activityDetailLine("Error: Saved to local sent mail"), "回复已保存到本地已发送。");
  assert.equal(activityDetailLine("Error: Plan the afternoon"), "Error: Plan the afternoon");
  assert.equal(
    computerWorkspaceNotice("Error: Computer control is not configured."),
    "电脑还没有配置。",
  );
  assert.equal(taskFailureLine("socket hang up"), "这次没有完成。\n具体原因没有显示。");
  assert.equal(statusServerNote("socket hang up"), "具体原因没有显示。");
  assert.equal(
    statusServerNote("Authentication required for some other reason"),
    "具体原因没有显示。",
  );
  assert.equal(surfaceError("浏览器没有打开。", "net::ERR_CONNECTION_RESET"), "网络中断了。");
  assert.equal(financeCsvPlaceholder(), "日期,说明,金额,分类\n2026-09-01,买菜,54.20,餐饮");
  assert.match(financeCsvSample(), /^日期,说明,金额,分类\n/);
  assert.equal(
    computerTerminalHint(true),
    "在你的电脑上运行，可访问网络。图形程序请放到后台启动，再到「桌面」页打开。",
  );
  assert.match(computerTerminalHint(false), /网络已关闭/);
  assert.match(computerDesktopHint(), /工作区里的文件会保留/);
  assert.equal(documentFieldPlaceholder(), '{"姓名":"你的姓名","同意":true}');
  assert.match(documentFieldJsonError(), /一段文字/);
  const shellCopy = [
    statusServerNote("socket hang up"),
    surfaceError("浏览器没有打开。", "net::ERR_CONNECTION_RESET"),
    taskFailureLine("socket hang up"),
    computerWorkspaceNotice("docker socket missing"),
    financeCsvPlaceholder(),
    financeCsvSample(),
    computerTerminalHint(true),
    computerDesktopHint(),
    documentFieldPlaceholder(),
  ].join("\n");
  assert.doesNotMatch(
    shellCopy,
    /socket hang up|ERR_CONNECTION|docker socket|Groceries|Salary|Subscription|full_name|consent|dev\/null|\/workspace|>/i,
  );
  const shown = samples.map(([, chinese]) => chinese).join("\n");
  assert.doesNotMatch(shown, /\b(authentication|execution|cancelled|fetch|required|timezone)\b/i);
});

test("activity titles, memory sources, avatars, and task failures drop leftover English", () => {
  assert.equal(activityEventTitle("Task created"), "任务已建立");
  assert.equal(activityEventTitle("Research started"), "研究开始了");
  assert.equal(activityEventTitle("failed"), "失败");
  assert.equal(activityEventTitle("整理行程"), "整理行程");
  assert.equal(memorySourceLabel("Conversation"), "对话");
  assert.equal(memorySourceLabel("Authenticated user edit"), "你的更正");
  assert.equal(memorySourceLabel("User remember"), "你记下的");
  assert.equal(memorySourceLabel("User correction"), "你的更正");
  assert.equal(memorySourceLabel("authenticated product command"), "你的更正");
  assert.equal(memorySourceLabel("在应用中由用户添加"), "在应用中由用户添加");
  assert.equal(
    searchWarningLine(
      "Some results were omitted because their source URLs were invalid, unavailable, or not public.",
    ),
    "有些来源不是公开网页，已略过。",
  );
  assert.equal(
    searchWarningLine("Search results or snippets were shortened to fit the search limits."),
    "部分搜索结果或摘录已缩短。",
  );
  assert.equal(searchWarningLine("已略过不公开的来源。"), "已略过不公开的来源。");
  assert.equal(searchWarningLine("socket hang up"), "具体原因没有显示。");
  assert.equal(searchWarningLine("  "), "");
  assert.equal(avatarLabel("sky"), "晴空");
  assert.equal(avatarLabel("sand"), "暖沙");
  assert.equal(avatarLabel("lilac"), "丁香");
  assert.equal(avatarLabel("unknown"), "头像");
  assert.notEqual(avatarLabel("sky"), "状态待更新");
  assert.equal(
    taskFailureLine("The runtime stopped before the research outcome was confirmed."),
    "研究在确认结果前中断了。",
  );
  assert.equal(taskFailureLine("Active memory not found"), "没有找到这条记忆。");
  assert.equal(taskFailureLine("审阅尚未就绪。请刷新后再试。"), "审阅尚未就绪。请刷新后再试。");
  assert.equal(taskFailureLine("socket hang up"), "这次没有完成。\n具体原因没有显示。");
  assert.equal(activityDetailLine("CONTEXT_INVALIDATED"), "这一轮的上下文已失效。");
  assert.equal(activityDetailLine("HOST_INTERRUPTED"), "Kleio 中断了这次检查。");
  assert.equal(activityDetailLine("SOME_OTHER_CODE"), "具体原因没有显示。");
  assert.equal(activityDetailLine("Saved to local sent mail"), "回复已保存到本地已发送。");
  assert.equal(activityDetailLine("整理好了"), "整理好了");
  assert.equal(activityDetailLine("Plan the afternoon"), "Plan the afternoon");
  assert.equal(choiceSelectionLine("左边"), "已选：左边");
  assert.equal(choiceUnavailableLine(), "选项不可用");
  assert.equal(taskFailureLine("CONTEXT_BUDGET_EXCEEDED"), "所需上下文超出了这一轮的容量。");
  const copy = [
    activityEventTitle("Task created"),
    activityDetailLine("CONTEXT_INVALIDATED"),
    activityDetailLine("SOME_OTHER_CODE"),
    memorySourceLabel("Conversation"),
    memorySourceLabel("User remember"),
    memorySourceLabel("authenticated product command"),
    searchWarningLine(
      "Some results were omitted because their source URLs were invalid, unavailable, or not public.",
    ),
    avatarLabel("lilac"),
    choiceSelectionLine("左边"),
    choiceUnavailableLine(),
    taskFailureLine("The native memory service could not save this statement."),
  ].join("\n");
  assert.doesNotMatch(copy, /task created|conversation|authenticated|lilac|native memory|CONTEXT_|SOME_OTHER/i);
});

test("engine, document, network, and keyboard leftovers stay in Chinese", () => {
  const samples = [
    ["Execution cancelled before dispatch.", "这次回复在开始前已取消。"],
    ["The execution stopped before completion (max_tokens).", "输出到了上限，这次回复停了。"],
    ["The execution stopped before completion (max_turn_requests).", "这一轮的步骤到了上限。"],
    ["The execution stopped before completion (refusal).", "模型没有继续这次回复。"],
    ["The execution stopped before completion (other).", "这次回复在完成前停了。"],
    [
      "The execution engine failed during prompt; inspect product state before retrying. Provider HTTP status: 502.",
      "引擎没有完成这次回复。请先看已保存的状态再重试。",
    ],
    [
      "The prompt transport did not confirm its outcome; inspect effects before retrying.",
      "这次回复没有确认结果。请先查看实际效果再重试。",
    ],
    [
      'The execution engine rejected the schema for product tool "web_search" before model dispatch. Update the tool schema to match the pinned DSH runtime.',
      "有个工具的格式对不上，这次回复没有开始。",
    ],
    ["The engine settled without a text result.", "这次回复没有写出内容。"],
    ["Request admission configuration is incomplete.", "这一轮的准入配置还不完整。"],
    ["Only public HTTP(S) documents on standard ports are supported.", "只读取标准端口上的公开文档。"],
    ["Document returned HTTP 404.", "文档没有打开。"],
    ["Tavily search returned HTTP 500. Try again later.", "网页搜索没有完成。请稍后再试。"],
    ["The search query contains a configured credential. Rephrase the query.", "搜索内容里有已配置的凭证。请换个说法。"],
    ["The Internet connection appears to be offline.", "网络不可用。"],
    ["net::ERR_INTERNET_DISCONNECTED", "网络中断了。"],
    ["Failed to load pdf", "无法显示此 PDF。"],
    ["Password required or incorrect password.", "这份 PDF 需要密码。"],
    ["IDENTITY.md is unreadable.", "身份文件无法读取。"],
    ["IDENTITY.md is blank. The product default is used.", "身份文件是空的，已用默认设置。"],
    ["Error: Execution stopped.", "这次回复在完成前停了。"],
  ] as const;
  for (const [english, chinese] of samples) {
    assert.equal(statusServerNote(english), chinese);
    assert.equal(taskFailureLine(english), chinese);
  }
  assert.doesNotMatch(samples.map(([, chinese]) => chinese).join("\n").replaceAll("PDF", ""), /[A-Za-z]{3,}/);
  assert.equal(statusServerNote("Authentication required for some other reason"), "具体原因没有显示。");
  assert.equal(statusServerNote("socket hang up"), "具体原因没有显示。");
  assert.equal(statusServerNote("The execution stopped before completion (secret)."), "具体原因没有显示。");
  assert.equal(
    statusServerNote('The execution engine rejected the schema for product tool "Not A Tool" before model dispatch. Update the tool schema to match the pinned DSH runtime.'),
    "具体原因没有显示。",
  );
  assert.equal(fileSourceLabel("computer"), "电脑");
  assert.equal(fileSourceLabel("desktop"), "桌面");
  assert.equal(fileSourceLabel("workspace"), "工作区");
  assert.equal(fileSourceLabel("import"), "导入");
  assert.equal(fileSourceLabel("agent"), "智能体");
  assert.equal(fileSourceLabel("form"), "表单");
  assert.equal(fileSourceLabel("合同扫描"), "合同扫描");
  assert.equal(fileShareLabel(true), "打开或下载");
  assert.equal(fileShareLabel(false), "保存或分享");
  assert.equal(computerCommandKeyboardHint(), "回车换行。点「运行命令」执行。");
  assert.equal(composerReturnHint(), "回车换行");
  const shown = [
    ...samples.map(([, chinese]) => chinese),
    fileShareLabel(true),
    fileShareLabel(false),
    computerCommandKeyboardHint(),
    fileSourceLabel("computer"),
  ].join("\n");
  assert.doesNotMatch(
    shown,
    /\b(execution|engine|http|document|tavily|identity|password|download|share|return|enter|computer)\b/i,
  );
});

test("stored choices use the Kleio marker", () => {
  const action = {
    panelId: "panel-1",
    threadId: "thread-1",
    candidateSetVersion: 1,
    optionId: "left",
  };
  const panel = {
    id: "panel-1",
    threadId: "thread-1",
    turnId: "turn-1",
    candidateSetVersion: 1,
    type: "clarification" as const,
    title: "选一个",
    options: [{ id: "left", label: "左边", details: [], sources: [] }],
    mode: "live" as const,
  };
  const messages = [
    { role: "assistant", toolCalls: [{ id: "call-1", name: "present_choices" }] },
    { role: "tool", toolCallId: "call-1", content: JSON.stringify({ panel }) },
  ];
  const stored = encodeJevAction(action);
  assert.equal(stored.startsWith("[Kleio 选择] "), true);
  assert.deepEqual(parseJevAction(stored), action);
  assert.equal(parseJevAction("plain text"), null);
  assert.equal(displayJevUserMessage(stored, messages), "已选：左边");
  assert.equal(displayJevUserMessage("[Kleio 选择] {", messages), "选项不可用");
  assert.equal(displayJevUserMessage("我想选左边", messages), "我想选左边");
  assert.equal(
    retryChoiceAvailable(panel, "thread-1", "panel-1", "left", stored, false, false),
    true,
  );
  const shown = [stored, displayJevUserMessage(stored, messages)].join("\n");
  assert.doesNotMatch(shown, /OpenBot|openbot/);
});
