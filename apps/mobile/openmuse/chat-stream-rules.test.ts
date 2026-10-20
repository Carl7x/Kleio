import assert from "node:assert/strict";
import test from "node:test";
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
  composerBorderColor,
  composerBoxShadow,
  composerChrome,
  composerSendFace,
  desktopReceiptActions,
  listedBackgroundTasks,
  knownOperationStatus,
  liveTurnCue,
  mailReceiptAction,
  operationStatusLabel,
  reviewGateLabel,
  savedResultReceiptAction,
  searchReceiptAction,
  shouldCommitComposerEnter,
  surfaceFadeAlphas,
  toolCardStartsOpen,
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

test("long user messages collapse; short ones stay open", () => {
  assert.equal(userMessageOverflows("短消息"), false);
  assert.equal(userMessageOverflows("a".repeat(280)), false);
  assert.equal(userMessageOverflows("a".repeat(281)), true);
  assert.equal(userMessageOverflows("1\n2\n3\n4\n5\n6"), false);
  assert.equal(userMessageOverflows("1\n2\n3\n4\n5\n6\n7"), true);
});
