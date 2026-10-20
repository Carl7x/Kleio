import assert from "node:assert/strict";
import test from "node:test";
import {
  backgroundStreamState,
  backgroundToolKind,
  listedBackgroundTasks,
  shouldCommitComposerEnter,
  userMessageOverflows,
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

test("long user messages collapse; short ones stay open", () => {
  assert.equal(userMessageOverflows("短消息"), false);
  assert.equal(userMessageOverflows("a".repeat(280)), false);
  assert.equal(userMessageOverflows("a".repeat(281)), true);
  assert.equal(userMessageOverflows("1\n2\n3\n4\n5\n6"), false);
  assert.equal(userMessageOverflows("1\n2\n3\n4\n5\n6\n7"), true);
});
