import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import {
  activityFor,
  commandInputError,
  commandNeedsInput,
  describeTool,
  filterCommands,
  primaryCommands,
  renderChat,
  renderCommandForm,
  renderCommandInvocation,
  renderPaletteList,
  renderSidebar,
} from "../../public/src/chat-view.js";
import { createDeskState, markEntered, queueFollowUp, reduceDeskEvent } from "../../public/src/event-store.js";

const commands = [
  { id: "setup", title: "Setup", invocation: "/setup", description: "Profile", primaryOrder: 1, arguments: [] },
  { id: "scrape", title: "Find Jobs", invocation: "/scrape", description: "Search", primaryOrder: 2, arguments: [{ kind: "choice", name: "mode", values: ["focused", "broad"] }] },
  { id: "apply", title: "Apply", invocation: "/apply", primaryOrder: 4, arguments: [{ kind: "url", name: "url" }, { kind: "multiline", name: "posting" }] },
  { id: "html-report", title: "HTML report", invocation: "/html-report", arguments: [{ kind: "path", name: "path" }, { kind: "boolean", name: "open", flag: "--open" }] },
  { id: "autofill", title: "Autofill", invocation: "/autofill", primaryOrder: 5, arguments: [{ kind: "url", name: "url", required: true }] },
];

function document() {
  return new Window({ url: "http://127.0.0.1/" }).document;
}

test("command palette filters and renders invocations", () => {
  assert.deepEqual(filterCommands(commands, "html").map((item) => item.id), ["html-report"]);
  assert.deepEqual(primaryCommands(commands).map((item) => item.id), ["setup", "scrape", "apply", "autofill"]);
  assert.equal(renderCommandInvocation(commands[2], { posting: "Paste\nme" }), "/apply\nPaste\nme");
  assert.equal(renderCommandInvocation(commands[3], { path: "reports/out.html", open: true }), "/html-report reports/out.html --open");
  // Optional arguments never produce a form: the step runs at once.
  assert.equal(renderCommandForm(commands[1]), "");
  assert.equal(commandNeedsInput(commands[1]), false);
  assert.equal(commandNeedsInput(commands[3]), false);
  // Link-or-posting commands get one paste box; a required link gets one field with a plain label.
  assert.equal(commandNeedsInput(commands[2]), true);
  assert.match(renderCommandForm(commands[2]), /<textarea name="paste"/);
  assert.doesNotMatch(renderCommandForm(commands[2]), /name="url"|name="posting"/);
  assert.match(renderCommandForm(commands[4]), /<span>Link<\/span><input name="url" type="url"/);
});

test("the paste box turns a link into the url argument and anything else into the posting", () => {
  assert.equal(renderCommandInvocation(commands[2], { paste: "  https://jobs.example/1 " }), "/apply https://jobs.example/1");
  assert.equal(renderCommandInvocation(commands[2], { paste: "Senior Engineer\nAcme" }), "/apply\nSenior Engineer\nAcme");
  assert.equal(commandInputError(commands[2], { paste: "  " }), "Paste a job link or the posting text first.");
  assert.equal(commandInputError(commands[2], { paste: "https://jobs.example/1" }), "");
  assert.equal(commandInputError(commands[4], { url: "" }), "Link is required.");
  assert.equal(commandInputError(commands[4], { url: "boards.example/1" }), "That link should start with http:// or https://.");
  assert.equal(commandInputError(commands[4], { url: "https://boards.example/1" }), "");
});

test("streaming updates a card in place instead of rebuilding the log", () => {
  const doc = document();
  const root = doc.createElement("section");
  let state = createDeskState();
  state = reduceDeskEvent(state, { eventId: "u1", sequence: 1, turnId: "t1", type: "user.message", payload: { messageId: "m1", text: "hi" } });
  state = reduceDeskEvent(state, { eventId: "d1", sequence: 2, turnId: "t1", type: "assistant.delta", payload: { text: "Hel" } });
  renderChat(root, state);
  const user = root.querySelector('[data-card-id="m1"]');
  const reply = root.querySelector('[data-card-id="assistant:t1"]');
  assert.ok(user.classList.contains("enter"));
  assert.ok(reply.classList.contains("enter"));
  // Simulate the browser finishing the entrance animation.
  user.classList.remove("enter");
  reply.classList.remove("enter");

  state = reduceDeskEvent(state, { eventId: "d2", sequence: 3, turnId: "t1", type: "assistant.delta", payload: { text: "lo" } });
  renderChat(root, state);
  assert.equal(root.querySelector('[data-card-id="m1"]'), user, "user card is the same DOM node");
  assert.equal(root.querySelector('[data-card-id="assistant:t1"]'), reply, "reply card is the same DOM node");
  assert.equal(reply.classList.contains("enter"), false, "an updated card does not re-run its entrance animation");
  assert.equal(reply.querySelector(".body").textContent, "Hello");
  assert.equal(root.querySelectorAll("article").length, 2);
});

test("the chat shows what Claude is doing while a turn runs", () => {
  const doc = document();
  const root = doc.createElement("section");
  let state = createDeskState();
  state = reduceDeskEvent(state, { eventId: "u1", sequence: 1, turnId: "t1", type: "user.message", payload: { messageId: "m1", text: "hi" } });
  renderChat(root, state);
  assert.equal(root.querySelector(".activity")?.dataset.activity, "Working");

  state = reduceDeskEvent(state, { eventId: "th", sequence: 2, turnId: "t1", type: "assistant.thinking", payload: {} });
  renderChat(root, state);
  assert.equal(root.querySelector(".activity").dataset.activity, "Thinking");
  assert.equal(root.querySelectorAll("article").length, 1, "thinking adds no card");

  state = reduceDeskEvent(state, { eventId: "t", sequence: 3, turnId: "t1", type: "tool.started", payload: { toolUseId: "tool-1", name: "Read", input: { file_path: "cv/main.tex" } } });
  renderChat(root, state);
  assert.equal(activityFor(state), "Reading cv/main.tex");
  assert.equal(root.querySelector('[data-card-id="tool-1"] .tool').textContent, "Reading cv/main.tex");

  state = reduceDeskEvent(state, { eventId: "c", sequence: 4, turnId: "t1", type: "tool.completed", payload: { toolUseId: "tool-1", text: "ok" } });
  state = reduceDeskEvent(state, { eventId: "d", sequence: 5, turnId: "t1", type: "assistant.delta", payload: { text: "Here" } });
  renderChat(root, state);
  assert.equal(root.querySelector(".activity").dataset.activity, "Writing");

  state = reduceDeskEvent(state, { eventId: "r", sequence: 6, turnId: "t1", type: "turn.completed", payload: { text: "Here" } });
  renderChat(root, state);
  assert.equal(root.querySelector(".activity"), null);
  assert.equal(describeTool("Bash", { description: "Compile the CV" }), "Running Compile the CV");
  assert.equal(describeTool("Mystery", {}), "Using Mystery");
});

test("a failed turn is labelled as a problem, not as stopped", () => {
  const doc = document();
  const root = doc.createElement("section");
  let state = createDeskState();
  state = reduceDeskEvent(state, { eventId: "f", sequence: 1, turnId: "t1", type: "turn.failed", payload: { text: "Claude exited with code 1" } });
  renderChat(root, state);
  assert.equal(root.querySelector(".msg.error .who").textContent, "Problem");
});

test("chat view renders stable tool cards, questions, permissions, and queued messages", () => {
  const doc = document();
  const root = doc.createElement("section");
  let state = createDeskState();
  state = reduceDeskEvent(state, {
    eventId: "e1",
    sequence: 1,
    turnId: "t1",
    type: "tool.started",
    payload: { toolUseId: "tool-1", name: "Read" },
  });
  state = reduceDeskEvent(state, {
    eventId: "e2",
    sequence: 2,
    turnId: "t1",
    type: "question.requested",
    payload: { toolUseId: "q-1", questions: [{ question: "Lane?", header: "Lane", options: [{ label: "Healthcare" }] }] },
  });
  state = reduceDeskEvent(state, {
    eventId: "e3",
    sequence: 3,
    type: "permission.requested",
    payload: { requestId: "p-1", toolName: "Write", suggestions: [{ type: "addRules", destination: "session", behavior: "allow" }] },
  });
  state = queueFollowUp(state, { messageId: "m2", text: "rank next" });
  renderChat(root, state);
  assert.equal(root.querySelector('[data-card-id="tool-1"] .tool').textContent.includes("Read"), true);
  assert.equal(root.querySelector('[data-card-id="q-1"] select').disabled, false);
  assert.ok(root.querySelector('[data-card-id="p-1"] [data-decision="allow-scoped"]'));
  assert.equal(root.querySelector('[data-queue-id="m2"]').textContent, "rank next");

  state = markEntered(state, "q-1");
  renderChat(root, state);
  assert.equal(root.querySelector('[data-card-id="q-1"] select').disabled, true);
  assert.equal(root.querySelector('[data-card-id="q-1"]').dataset.entered, "true");
});

test("autofill review cards expose Continue and Cancel only", () => {
  const doc = document();
  const root = doc.createElement("section");
  let state = createDeskState();
  state = reduceDeskEvent(state, {
    eventId: "e-af",
    sequence: 1,
    type: "autofill.review",
    payload: { reviewId: "rev-1", entityId: "rev-1", token: "tok", url: "https://jobs.example/1" },
  });
  renderChat(root, state);
  const card = root.querySelector('[data-card-id="rev-1"]');
  assert.ok(card.querySelector('[data-decision="continue"]'));
  assert.ok(card.querySelector('[data-decision="cancel"]'));
  assert.equal(card.querySelector('[data-decision="submit"]'), null);
  state = markEntered(state, "rev-1");
  renderChat(root, state);
  assert.equal(root.querySelector('[data-decision="continue"]').disabled, true);
});

test("sidebar and palette render primary actions from metadata", () => {
  const doc = document();
  const steps = doc.createElement("nav");
  const palette = doc.createElement("div");
  renderSidebar(steps, commands);
  renderPaletteList(palette, filterCommands(commands, "apply"));
  assert.deepEqual([...steps.querySelectorAll("[data-action]")].map((node) => node.dataset.action), ["setup", "scrape", "apply", "autofill"]);
  assert.equal(palette.querySelector("[data-command='apply'] strong").textContent, "Apply");
});
