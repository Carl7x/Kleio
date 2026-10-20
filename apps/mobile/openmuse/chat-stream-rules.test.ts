import assert from "node:assert/strict";
import test from "node:test";
import {
  backgroundStreamState,
  backgroundToolKind,
  choiceRowQuiet,
  composerBorderColor,
  composerBoxShadow,
  composerChrome,
  composerSendFace,
  listedBackgroundTasks,
  liveTurnCue,
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

test("long user messages collapse; short ones stay open", () => {
  assert.equal(userMessageOverflows("短消息"), false);
  assert.equal(userMessageOverflows("a".repeat(280)), false);
  assert.equal(userMessageOverflows("a".repeat(281)), true);
  assert.equal(userMessageOverflows("1\n2\n3\n4\n5\n6"), false);
  assert.equal(userMessageOverflows("1\n2\n3\n4\n5\n6\n7"), true);
});
