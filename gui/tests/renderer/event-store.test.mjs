import assert from "node:assert/strict";
import test from "node:test";
import {
  applySnapshot,
  cardIdFor,
  createDeskState,
  markEntered,
  queueFollowUp,
  reduceDeskEvent,
} from "../../public/src/event-store.js";

function event(sequence, type, payload = {}, extras = {}) {
  return {
    eventId: extras.eventId || `e${sequence}`,
    sequence,
    turnId: extras.turnId || "turn-1",
    type,
    payload,
  };
}

test("replay is idempotent and rejects non-monotonic sequences", () => {
  let state = createDeskState();
  const first = event(1, "assistant.delta", { text: "Hi" });
  const second = event(2, "assistant.delta", { text: " there" });
  state = reduceDeskEvent(state, first);
  state = reduceDeskEvent(state, second);
  const replayed = reduceDeskEvent(reduceDeskEvent(state, first), second);
  assert.equal(replayed, state);
  assert.equal(state.lastSequence, 2);
  assert.equal(state.cards.get("assistant:turn-1").payload.text, "Hi there");
});

test("tool cards keep a stable ID across start and late completion", () => {
  let state = createDeskState();
  state = reduceDeskEvent(state, event(1, "tool.started", { toolUseId: "tool-1", name: "Read" }));
  state = reduceDeskEvent(state, event(2, "assistant.delta", { text: "working" }));
  state = reduceDeskEvent(state, event(3, "tool.completed", { toolUseId: "tool-1", text: "ok" }));
  assert.equal(state.cards.size, 2);
  assert.equal(cardIdFor(event(3, "tool.completed", { toolUseId: "tool-1" })), "tool-1");
  assert.equal(state.cards.get("tool-1").type, "tool.completed");
  assert.equal(state.cards.get("tool-1").payload.text, "ok");
});

test("question and permission cards start unentered and can be marked entered", () => {
  let state = createDeskState();
  state = reduceDeskEvent(state, event(1, "question.requested", {
    toolUseId: "q-1",
    questions: [{ question: "Lane?", header: "Lane", options: [{ label: "Healthcare" }] }],
  }));
  state = reduceDeskEvent(state, event(2, "permission.requested", {
    requestId: "p-1",
    toolName: "Read",
    suggestions: [{ type: "addRules", destination: "localSettings", behavior: "allow" }],
  }));
  assert.equal(state.cards.get("q-1").entered, false);
  assert.equal(state.cards.get("p-1").entered, false);
  assert.equal(state.pendingQuestionId, "q-1");
  state = markEntered(state, "q-1");
  assert.equal(state.cards.get("q-1").entered, true);
  assert.equal(state.pendingQuestionId, null);
});

test("queued follow-ups are visible and permission mode comes from the snapshot", () => {
  let state = createDeskState();
  state = reduceDeskEvent(state, event(1, "user.message", { messageId: "m1", text: "go" }));
  assert.equal(state.busy, true);
  state = queueFollowUp(state, { messageId: "m2", text: "and then rank" });
  assert.equal(state.queued[0].text, "and then rank");
  state = applySnapshot(state, { permissionMode: "autonomous", controller: "chat", conversationId: "c1" });
  assert.equal(state.permissionMode, "autonomous");
  assert.equal(state.conversationId, "c1");
});

test("thinking and diagnostics never become cards, and the result does not duplicate streamed text", () => {
  let state = createDeskState();
  state = reduceDeskEvent(state, event(1, "user.message", { messageId: "m1", text: "go" }));
  state = reduceDeskEvent(state, event(2, "assistant.thinking", {}));
  assert.equal(state.thinking, true);
  assert.equal(state.busy, true);
  state = reduceDeskEvent(state, event(3, "diagnostic.unknown_sdk_event", { sdkType: "weird" }));
  state = reduceDeskEvent(state, event(4, "session.status", { phase: "ready" }));
  state = reduceDeskEvent(state, event(5, "hook.activity", { hookName: "x" }));
  assert.equal(state.cards.size, 1);
  state = reduceDeskEvent(state, event(6, "assistant.delta", { text: "Hello" }));
  assert.equal(state.thinking, false);
  state = reduceDeskEvent(state, event(7, "assistant.delta", { text: " world" }));
  state = reduceDeskEvent(state, event(8, "assistant.message", { text: "Hello world" }));
  state = reduceDeskEvent(state, event(9, "turn.completed", { text: "Hello world" }));
  state = reduceDeskEvent(state, event(10, "usage", { totalCostUsd: 0.01 }));
  assert.equal(state.busy, false);
  assert.equal(state.cards.size, 2);
  assert.equal(state.cards.get("assistant:turn-1").payload.text, "Hello world");
  assert.equal([...state.cards.values()].filter((card) => card.type === "assistant.message").length, 1);
});

test("a result with no streamed text still shows as the reply", () => {
  let state = createDeskState();
  state = reduceDeskEvent(state, event(1, "user.message", { messageId: "m1", text: "go" }));
  state = reduceDeskEvent(state, event(2, "turn.completed", { text: "Done." }));
  const reply = state.cards.get("assistant:turn-1");
  assert.equal(reply.type, "assistant.message");
  assert.equal(reply.payload.text, "Done.");
  assert.equal(state.busy, false);
});

test("a late tool completion with no start creates nothing, and a permission resolution needs its card", () => {
  let state = createDeskState();
  state = reduceDeskEvent(state, event(1, "tool.completed", { toolUseId: "ghost", text: "ok" }));
  state = reduceDeskEvent(state, event(2, "permission.resolved", { toolUseId: "ghost-2", decision: "deny" }));
  assert.equal(state.cards.size, 0);
});

test("subagent text folds into one card per parent tool", () => {
  let state = createDeskState();
  state = reduceDeskEvent(state, event(1, "subagent.activity", { parentToolUseId: "agent-1", subagentType: "reviewer", text: "First." }));
  state = reduceDeskEvent(state, event(2, "subagent.activity", { parentToolUseId: "agent-1", subagentType: "reviewer", text: "Second." }));
  assert.equal(state.cards.size, 1);
  assert.equal(state.cards.get("subagent:agent-1").payload.text, "First.\n\nSecond.");
});

test("reply text after a tool call gets its own card below the tool chip", () => {
  let state = createDeskState();
  state = reduceDeskEvent(state, event(1, "user.message", { messageId: "m1", text: "go" }));
  state = reduceDeskEvent(state, event(2, "assistant.delta", { text: "Let me check." }));
  state = reduceDeskEvent(state, event(3, "tool.started", { toolUseId: "tool-1", name: "Read" }));
  // The same tool announced twice (stream start, then the full message) is one card and one split.
  state = reduceDeskEvent(state, event(4, "tool.started", { toolUseId: "tool-1", name: "Read", input: { file_path: "a.tex" } }));
  state = reduceDeskEvent(state, event(5, "tool.completed", { toolUseId: "tool-1", text: "ok" }));
  state = reduceDeskEvent(state, event(6, "assistant.delta", { text: "Here is the answer." }));
  state = reduceDeskEvent(state, event(7, "assistant.message", { text: "Here is the answer." }));
  state = reduceDeskEvent(state, event(8, "turn.completed", { text: "Here is the answer." }));
  assert.deepEqual([...state.cards.keys()], ["m1", "assistant:turn-1", "tool-1", "assistant:turn-1:1"]);
  assert.equal(state.cards.get("assistant:turn-1").payload.text, "Let me check.");
  assert.equal(state.cards.get("assistant:turn-1:1").payload.text, "Here is the answer.");
  assert.equal(state.cards.get("tool-1").payload.input.file_path, "a.tex");

  state = reduceDeskEvent(state, event(9, "user.message", { messageId: "m2", text: "again" }, { turnId: "turn-2" }));
  state = reduceDeskEvent(state, event(10, "assistant.delta", { text: "Sure." }, { turnId: "turn-2" }));
  assert.equal(state.cards.get("assistant:turn-2").payload.text, "Sure.");
});

test("a question announced after its tool chip becomes the form, and the tool result closes it", () => {
  let state = createDeskState();
  state = reduceDeskEvent(state, event(1, "tool.started", { toolUseId: "tool-q", name: "AskUserQuestion" }));
  state = reduceDeskEvent(state, event(2, "question.requested", { toolUseId: "tool-q", questions: [{ question: "Lane?", options: [{ label: "A" }] }] }));
  assert.equal(state.cards.get("tool-q").type, "question.requested");
  assert.equal(state.pendingQuestionId, "tool-q");
  state = reduceDeskEvent(state, event(3, "tool.completed", { toolUseId: "tool-q", text: "denied" }));
  assert.equal(state.cards.get("tool-q").type, "question.requested");
  assert.equal(state.cards.get("tool-q").entered, true);
});

test("the full message after a tool call does not repeat text streamed before it", () => {
  let state = createDeskState();
  state = reduceDeskEvent(state, event(1, "user.message", { messageId: "m1", text: "go" }));
  state = reduceDeskEvent(state, event(2, "assistant.delta", { text: "Let me look." }));
  state = reduceDeskEvent(state, event(3, "tool.started", { toolUseId: "t1", name: "Read" }));
  state = reduceDeskEvent(state, event(4, "assistant.message", { text: "Let me look." }));
  assert.deepEqual([...state.cards.keys()], ["m1", "assistant:turn-1", "t1"]);
  state = reduceDeskEvent(state, event(5, "tool.completed", { toolUseId: "t1" }));
  state = reduceDeskEvent(state, event(6, "assistant.message", { text: "Found it." }));
  assert.equal(state.cards.get("assistant:turn-1:1").payload.text, "Found it.");
});

test("a permission resolution clears the pending flag and marks the card decided", () => {
  let state = createDeskState();
  state = reduceDeskEvent(state, event(1, "permission.requested", { entityId: "req-1", toolName: "Write", suggestions: [] }));
  assert.equal(state.pendingPermissionId, "req-1");
  state = reduceDeskEvent(state, event(2, "permission.resolved", { entityId: "req-1", decision: "allow" }));
  assert.equal(state.pendingPermissionId, null);
  assert.equal(state.cards.get("req-1").entered, true);
  assert.equal(state.cards.get("req-1").payload.decision, "allow");
});

test("a tool completion without input keeps the file name, and a read-only question does not block the activity row", () => {
  let state = createDeskState();
  state = reduceDeskEvent(state, event(1, "tool.started", { toolUseId: "t1", name: "Read", input: { file_path: "cv/main.tex" } }));
  state = reduceDeskEvent(state, event(2, "tool.completed", { toolUseId: "t1", name: "Read", input: {} }));
  assert.equal(state.cards.get("t1").payload.input.file_path, "cv/main.tex");
  state = reduceDeskEvent(state, event(3, "question.requested", { entityId: "q-ro", readOnly: true, questions: [{ question: "Lane?" }] }));
  assert.equal(state.pendingQuestionId, null);
  state = reduceDeskEvent(state, event(4, "question.requested", { entityId: "q-live", questions: [{ question: "Lane?" }] }));
  assert.equal(state.pendingQuestionId, "q-live");
});

test("a runtime-shaped question (request id card, tool use id result) closes on the tool result", () => {
  let state = createDeskState();
  state = reduceDeskEvent(state, event(1, "question.requested", { entityId: "req-1", toolUseId: "tool-q", questions: [{ question: "Lane?", options: [{ label: "A" }] }] }));
  state = reduceDeskEvent(state, event(2, "question.resolved", { entityId: "req-1", answered: true }));
  state = reduceDeskEvent(state, event(3, "tool.completed", { toolUseId: "tool-q", text: "ok" }));
  assert.equal(state.cards.size, 1);
  assert.equal(state.cards.get("req-1").entered, true);
  assert.equal(state.pendingQuestionId, null);
});

test("a follow-up sent mid-turn does not reset the reply segment; the next turn does", () => {
  let state = createDeskState();
  state = reduceDeskEvent(state, event(1, "user.message", { messageId: "m1", text: "one" }, { turnId: "m1" }));
  state = reduceDeskEvent(state, event(2, "assistant.delta", { text: "Let me check." }, { turnId: "m1" }));
  state = reduceDeskEvent(state, event(3, "tool.started", { toolUseId: "t1", name: "Read" }, { turnId: "m1" }));
  state = reduceDeskEvent(state, event(4, "user.message", { messageId: "m2", text: "two" }, { turnId: "m2" }));
  state = reduceDeskEvent(state, event(5, "assistant.delta", { text: "Found it." }, { turnId: "m1" }));
  assert.equal(state.cards.get("assistant:m1:1").payload.text, "Found it.");
  state = reduceDeskEvent(state, event(6, "turn.completed", { text: "" }, { turnId: "m1" }));
  state = reduceDeskEvent(state, event(7, "assistant.delta", { text: "Second answer." }, { turnId: "m2" }));
  assert.equal(state.cards.get("assistant:m2").payload.text, "Second answer.");
});
