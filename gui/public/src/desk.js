import {
  applySnapshot,
  createDeskState,
  markEntered,
  queueFollowUp,
  reduceDeskEvent,
} from "./event-store.js";
import {
  createArtifactViewState,
  moveArtifactSelection,
  renderArtifactView,
  requestArtifactConfirm,
} from "./artifact-view.js";
import { mountTabs } from "./tabs.js";
import { createTerminalView } from "./terminal-view.js";
import {
  commandInputError,
  commandNeedsInput,
  filterCommands,
  renderChat,
  renderCommandForm,
  renderCommandInvocation,
  renderPaletteList,
  renderSidebar,
  valuesFromForm,
} from "./chat-view.js";

const logEl = document.getElementById("panel-chat");
const statusEl = document.getElementById("status");
const sessionEl = document.getElementById("session-label");
const workspaceEl = document.getElementById("workspace-label");
const modeEl = document.getElementById("mode-label");
const promptEl = document.getElementById("prompt");
const sendBtn = document.getElementById("send");
const stopBtn = document.getElementById("stop");
const resetBtn = document.getElementById("reset");
const openCliBtn = document.getElementById("open-cli");
const form = document.getElementById("compose");
const sheet = document.getElementById("sheet");
const sheetForm = document.getElementById("sheet-form");
const sheetTitle = document.getElementById("sheet-title");
const sheetKicker = document.getElementById("sheet-kicker");
const sheetCopy = document.getElementById("sheet-copy");
const sheetFields = document.getElementById("sheet-fields");
const sheetError = document.getElementById("sheet-error");
const clockEl = document.getElementById("clock");
const menuBtn = document.getElementById("menu");
const scrim = document.getElementById("scrim");
const jumpBtn = document.getElementById("jump");
const stepsEl = document.querySelector(".steps");
const filesEl = document.getElementById("panel-files");
const palette = document.getElementById("palette");
const paletteQuery = document.getElementById("palette-query");
const paletteList = document.getElementById("palette-list");

let busy = false;
let sseSequence = 0;
let sseTurn = 0;
let sseTurnClosed = true;
let sendPending = false;
let replayingTranscript = false;
let commands = [];
let activeCommand = null;
let runtimeSocket = null;
let state = createDeskState({ permissionMode: "autonomous" });
let artifactState = createArtifactViewState();
let stickToBottom = true;
let terminalView = null;
let terminalId = null;

function emptyMarkup(kind) {
  if (kind === "reset") {
    return `<div class="empty" id="empty">
      <p class="kicker">Clean slate</p>
      <h2>New conversation.</h2>
      <p>The page is clear. Your job-search files remain in the same workspace.</p>
      <div class="suggestions" aria-label="Suggested starts">
        <button type="button" data-action="scrape">Find openings</button>
        <button type="button" data-action="rank">Rank what we have</button>
        <button type="button" data-prompt="Which of these roles should I prioritize this week?">Prioritize this week</button>
      </div>
    </div>`;
  }
  return `<div class="empty" id="empty">
    <p class="kicker">Ready when you are</p>
    <h2>Start wherever you are.</h2>
    <p>First day in this repo? Run <strong>Setup</strong>. Profile already filled? <strong>Scrape</strong> for roles, then talk the same way you would in the terminal.</p>
    <div class="empty-actions">
      <button type="button" data-action="setup">Start with setup</button>
      <button type="button" data-action="scrape" class="ghost">I am already set up</button>
    </div>
    <div class="suggestions" aria-label="Suggested starts">
      <button type="button" data-prompt="Which of these roles should I prioritize this week?">Prioritize this week</button>
      <button type="button" data-action="rank">Rank what we have</button>
      <button type="button" data-action="interview">Prep for an interview</button>
    </div>
  </div>`;
}

function markdown(text) {
  if (window.marked && window.DOMPurify) {
    return window.DOMPurify.sanitize(window.marked.parse(text || "", { gfm: true, breaks: true }));
  }
  return String(text || "").replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`).replace(/\n/g, "<br>");
}

function bindDelegatedActions(root) {
  root.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]");
    if (action) runAction(action.dataset.action);
    const prompt = event.target.closest("[data-prompt]");
    if (prompt) sendPrompt(prompt.dataset.prompt);
  });
}

function setMenu(open) {
  document.body.classList.toggle("menu-open", open);
  menuBtn.setAttribute("aria-expanded", String(open));
  scrim.hidden = !open;
}

function nearBottom() {
  return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 96;
}

function scrollLog() {
  if (stickToBottom) logEl.scrollTop = logEl.scrollHeight;
  jumpBtn.hidden = stickToBottom || !logEl.querySelector("article");
}

function jumpToLatest() {
  stickToBottom = true;
  logEl.scrollTo({ top: logEl.scrollHeight, behavior: "smooth" });
  jumpBtn.hidden = true;
}

function paintMode() {
  if (!modeEl) return;
  const label = state.permissionMode === "autonomous" ? "Autonomous" : "Safe";
  modeEl.textContent = label;
  modeEl.dataset.mode = state.permissionMode;
}

function paintChat() {
  renderChat(logEl, state, { markdown, emptyHtml: emptyMarkup(state.cards.size ? "reset" : undefined) });
  paintMode();
  scrollLog();
}

function setBusy(next) {
  busy = next;
  sendBtn.disabled = next && !runtimeSocket;
  stopBtn.hidden = !next;
  document.body.classList.toggle("working", next);
  statusEl.textContent = next ? "Claude is working. Stop cancels this turn." : "Ready";
}

function setWorkspaceLabel(root) {
  if (!workspaceEl || !root) return;
  workspaceEl.textContent = root;
  workspaceEl.title = "Desk and Claude Code both write scrapes, CVs, and applications here";
}

function setSessionLabel(data = {}) {
  setWorkspaceLabel(data.workspace);
  if (data.chromeGroup) {
    sessionEl.textContent = data.sessionId
      ? `${data.chromeGroup} · Chrome group`
      : `${data.chromeGroup} · waiting for Chrome`;
    return;
  }
  sessionEl.textContent = data.sessionId ? `Session ${data.sessionId.slice(0, 8)}` : "New session";
}

function sizePrompt() {
  promptEl.style.height = "auto";
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 192)}px`;
}

function markAction(name) {
  document.querySelectorAll(".steps [data-action]").forEach((button) => {
    button.classList.toggle("active", button.dataset.action === name);
  });
}

function paintFiles() {
  renderArtifactView(filesEl, artifactState);
}

function ingest(event) {
  const wasBusy = state.busy;
  state = reduceDeskEvent(state, event);
  paintChat();
  if (!replayingTranscript && state.busy !== wasBusy) setBusy(state.busy);
  if (event.type === "artifact.discovered") {
    const incoming = {
      id: event.payload.artifactId || event.payload.entityId,
      turnId: event.payload.turnId || event.turnId,
      relativePath: event.payload.relativePath,
      kind: event.payload.kind,
      mime: event.payload.mime,
    };
    artifactState = createArtifactViewState({
      ...artifactState,
      status: "ready",
      artifacts: [...artifactState.artifacts.filter((item) => item.id !== incoming.id), incoming],
      selectedId: artifactState.selectedId || incoming.id,
    });
    paintFiles();
  }
}

async function loadArtifacts() {
  artifactState = createArtifactViewState({ ...artifactState, status: "loading" });
  paintFiles();
  try {
    const res = await fetch("/artifacts");
    if (!res.ok) throw new Error("Could not load artifacts.");
    const body = await res.json();
    artifactState = createArtifactViewState({
      artifacts: body.artifacts || [],
      selectedId: artifactState.selectedId,
    });
  } catch (error) {
    artifactState = createArtifactViewState({ status: "error", error: error.message });
  }
  paintFiles();
}

async function showArtifactPreview(id) {
  const res = await fetch(`/artifacts/${id}/preview`);
  if (!res.ok) throw new Error("Could not preview that file.");
  const type = res.headers.get("content-type") || "";
  let preview;
  if (type.includes("text/html")) preview = { kind: "html", src: `/artifacts/${id}/preview` };
  else if (type.includes("application/pdf")) preview = { kind: "pdf", src: `/artifacts/${id}/preview` };
  else if (type.startsWith("image/")) preview = { kind: "image", src: `/artifacts/${id}/preview` };
  else if (type.includes("json")) preview = await res.json();
  else preview = { kind: "text", text: await res.text() };
  artifactState = { ...artifactState, selectedId: id, preview, confirm: null };
  paintFiles();
}

async function showArtifactCompare(id) {
  const res = await fetch(`/artifacts/${id}/compare`);
  if (!res.ok) throw new Error("Could not compare that file.");
  artifactState = { ...artifactState, selectedId: id, compare: await res.json(), confirm: null };
  paintFiles();
}

async function confirmArtifactAction() {
  const confirm = artifactState.confirm;
  if (!confirm) return;
  try {
    const res = await post(`/artifacts/${confirm.id}/${confirm.action}`, {
      expectedControllerGeneration: state.controllerGeneration,
    });
    if (!res.ok) {
      artifactState = { ...artifactState, status: "error", error: "Could not complete that action." };
      paintFiles();
      return;
    }
  } catch {
    artifactState = { ...artifactState, status: "error", error: "Could not complete that action." };
    paintFiles();
    return;
  }
  artifactState = { ...artifactState, confirm: null };
  paintFiles();
}

function sseEvent(type, payload) {
  sseSequence += 1;
  if (type === "user.message" || type === "assistant.message") {
    sseTurn += 1;
    sseTurnClosed = false;
  } else if (type === "assistant.delta") {
    if (sseTurnClosed) {
      sseTurn += 1;
      sseTurnClosed = false;
    }
  } else if (type === "turn.completed" || type === "turn.failed" || type === "turn.interrupted") {
    sseTurnClosed = true;
  }
  ingest({
    eventId: `sse-${sseSequence}`,
    sequence: sseSequence,
    local: true,
    turnId: `turn-${sseTurn}`,
    type,
    payload,
  });
}

async function post(path, body) {
  return fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : "{}",
  });
}

function runtimeSend(message) {
  if (!runtimeSocket || runtimeSocket.readyState !== WebSocket.OPEN) return false;
  runtimeSocket.send(JSON.stringify({
    ...message,
    expectedControllerGeneration: state.controllerGeneration,
    conversationId: state.conversationId,
  }));
  return true;
}

async function sendPrompt(prompt) {
  const text = prompt.trim();
  if (!text) return false;
  if (busy && runtimeSocket) {
    const messageId = `q-${Date.now()}`;
    state = queueFollowUp(state, { messageId, text });
    paintChat();
    runtimeSend({ type: "user.message", messageId, text });
    return true;
  }
  if (busy) return false;
  if (sendPending) return false;
  sendPending = true;
  try {
    if (!lastHealth?.loggedIn) {
      try {
        lastHealth = await readHealth();
      } catch {
        // Keep the last known status if the health endpoint blips.
      }
    }
    if (needsInstall(lastHealth) || needsLogin(lastHealth) || !lastHealth?.installed) {
      applyHealth(lastHealth || { installed: false });
      if (!lastHealth?.installed && !needsInstall(lastHealth) && !needsLogin(lastHealth)) {
        sseEvent("turn.failed", { text: "Claude Code is not installed yet. Use the Connect Claude button." });
      }
      return false;
    }
    setMenu(false);
    setBusy(true);
    // The server echoes the message back (runtime: a persisted user.message
    // event; print mode: the "user" SSE event), so the page does not add its
    // own copy. A local copy showed every message twice.
    const messageId = `m-${Date.now()}`;
    if (runtimeSend({ type: "user.message", messageId, text })) {
      return true;
    }
    try {
      const res = await post("/send", { prompt: text });
      if (!res.ok) throw new Error();
      return true;
    } catch {
      setBusy(false);
      sseEvent("turn.failed", { text: "The desk could not reach the local server. Is the terminal still running?" });
      return false;
    }
  } finally {
    sendPending = false;
  }
}

function runAction(name) {
  const command = commands.find((item) => item.id === name);
  markAction(name);
  setMenu(false);
  if (!command) {
    if (name === "setup") sendPrompt("/setup");
    else if (name === "rank") sendPrompt("/rank");
    else if (name === "interview") sendPrompt("/interview");
    else if (name === "outcome") sendPrompt("/outcome");
    return;
  }
  if (!commandNeedsInput(command)) {
    sendPrompt(command.invocation);
    return;
  }
  openCommandSheet(command);
}

function openCommandSheet(command) {
  activeCommand = command;
  sheetKicker.textContent = command.invocation;
  sheetTitle.textContent = command.title;
  sheetCopy.textContent = command.description || "Add what the step needs, then run.";
  sheetFields.innerHTML = renderCommandForm(command);
  sheetError.hidden = true;
  sheetError.textContent = "";
  sheet.showModal();
  sheetFields.querySelector("input, textarea, select")?.focus();
}

function formatTime(date = new Date()) {
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function tickClock() {
  const now = new Date();
  clockEl.dateTime = now.toISOString();
  clockEl.textContent = formatTime(now);
}

function rememberSession(data) {
  if (data.chromeGroup) sessionEl.dataset.chromeGroup = data.chromeGroup;
  if (data.sessionId) sessionEl.dataset.sessionId = data.sessionId;
  else delete sessionEl.dataset.sessionId;
  setSessionLabel(data);
}

function openPalette() {
  palette.showModal();
  paletteQuery.value = "";
  renderPaletteList(paletteList, commands);
  paletteQuery.focus();
}

function connectRuntime() {
  const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  socket.addEventListener("open", () => {
    runtimeSocket = socket;
    socket.send(JSON.stringify({
      type: "hello",
      conversationId: state.conversationId || "active",
      protocolVersion: 1,
      afterSequence: state.lastSequence,
    }));
  });
  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === "snapshot") {
      state = applySnapshot(state, message.snapshot || {});
      paintChat();
    } else if (message.type === "event" && message.event) {
      ingest(message.event);
    } else if (message.type === "command.rejected") {
      // A rejected send (wrong controller, stale generation, queue full) must
      // not leave the composer spinning as if Claude were working.
      setBusy(false);
      sseEvent("turn.failed", { text: `The desk could not run that: ${message.reason || "rejected"}.` });
    } else if (message.type === "protocol.error") {
      setBusy(false);
      sseEvent("turn.failed", { text: `Desk connection error: ${message.error || "protocol"}.` });
    }
  });
  socket.addEventListener("close", () => {
    if (runtimeSocket === socket) runtimeSocket = null;
  });
  socket.addEventListener("error", () => {
    socket.close();
  });
}

const source = new EventSource("/events");
source.addEventListener("hello", (event) => {
  const data = JSON.parse(event.data);
  setBusy(Boolean(data.busy));
  rememberSession(data);
  if (Array.isArray(data.transcript) && data.transcript.length && !state.cards.size) {
    replayingTranscript = true;
    try {
      for (const entry of data.transcript) {
        const type = entry.role === "assistant" ? "assistant.message" : entry.role === "user" ? "user.message" : "turn.failed";
        sseEvent(type, { text: entry.text || "" });
      }
    } finally {
      replayingTranscript = false;
    }
  }
});
source.addEventListener("session", (event) => rememberSession(JSON.parse(event.data)));
source.addEventListener("user", (event) => {
  if (!runtimeSocket) sseEvent("user.message", { text: JSON.parse(event.data).text });
});
source.addEventListener("delta", (event) => {
  if (!runtimeSocket) sseEvent("assistant.delta", { text: JSON.parse(event.data).text });
});
source.addEventListener("result", (event) => {
  if (!runtimeSocket) sseEvent("turn.completed", { text: JSON.parse(event.data).text || "" });
});
source.addEventListener("tool", (event) => {
  if (runtimeSocket) return;
  const { id, name, phase, input } = JSON.parse(event.data);
  sseEvent(phase === "start" ? "tool.started" : "tool.completed", { toolUseId: id || `tool-${name}`, name, input: input || {} });
});
source.addEventListener("thinking", () => {
  if (!runtimeSocket) sseEvent("assistant.thinking", {});
});
source.addEventListener("status", (event) => {
  statusEl.textContent = JSON.parse(event.data).text;
});
source.addEventListener("log", (event) => {
  statusEl.textContent = JSON.parse(event.data).text.slice(0, 180);
});
source.addEventListener("turn-error", (event) => {
  if (event.data && !runtimeSocket) sseEvent("turn.failed", { text: JSON.parse(event.data).text });
});
source.addEventListener("autofill-review", (event) => {
  const payload = JSON.parse(event.data);
  sseEvent("autofill.review", payload);
});
source.addEventListener("reset", () => {
  state = createDeskState({ permissionMode: state.permissionMode });
  sseSequence = 0;
  sseTurn = 0;
  sseTurnClosed = true;
  paintChat();
  jumpBtn.hidden = true;
});
source.addEventListener("idle", () => {
  sseTurnClosed = true;
  setBusy(false);
  state = applySnapshot(state, { busy: false });
  paintChat();
});
source.onerror = (event) => {
  if (event?.data) return;
  statusEl.textContent = "Lost the local server. Run node gui/server.mjs again.";
};

if (openCliBtn) {
  openCliBtn.addEventListener("click", async () => {
    openCliBtn.disabled = true;
    try {
      const res = await fetch("/workspace/cli", { method: "POST" });
      const data = await res.json();
      statusEl.textContent = data.error || `Claude Code opened in ${data.root}`;
    } catch {
      statusEl.textContent = "Could not open Claude Code in this folder.";
    } finally {
      openCliBtn.disabled = false;
    }
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = promptEl.value;
  promptEl.value = "";
  sizePrompt();
  const sent = await sendPrompt(value);
  if (!sent && !promptEl.value) {
    promptEl.value = value;
    sizePrompt();
  }
  promptEl.focus();
});

promptEl.addEventListener("input", sizePrompt);
promptEl.addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    form.requestSubmit();
  }
});

sheetForm.addEventListener("submit", (event) => {
  if (event.submitter?.value !== "run") return;
  if (!activeCommand) return;
  const values = valuesFromForm(sheetFields);
  const problem = commandInputError(activeCommand, values);
  if (problem) {
    event.preventDefault();
    sheetError.textContent = problem;
    sheetError.hidden = false;
    sheetFields.querySelector("input, textarea, select")?.focus();
    return;
  }
  sendPrompt(renderCommandInvocation(activeCommand, values));
});

stopBtn.addEventListener("click", async () => {
  if (runtimeSend({ type: "turn.interrupt" })) return;
  try {
    const res = await post("/stop");
    if (!res.ok) statusEl.textContent = "Could not stop the current turn.";
  } catch {
    statusEl.textContent = "Could not stop the current turn.";
  }
});
resetBtn.addEventListener("click", async () => {
  if (!window.confirm("Start a new conversation? The current chat is cleared.")) return;
  if (!runtimeSend({ type: "conversation.reset" })) {
    try {
      const res = await post("/reset");
      if (!res.ok) {
        statusEl.textContent = "Could not start a new conversation.";
        return;
      }
    } catch {
      statusEl.textContent = "Could not start a new conversation.";
      return;
    }
  }
  state = createDeskState({ permissionMode: state.permissionMode });
  sseSequence = 0;
  sseTurn = 0;
  sseTurnClosed = true;
  paintChat();
  jumpBtn.hidden = true;
  setSessionLabel({ chromeGroup: sessionEl.dataset.chromeGroup, sessionId: sessionEl.dataset.sessionId });
});

menuBtn.addEventListener("click", () => setMenu(!document.body.classList.contains("menu-open")));
scrim.addEventListener("click", () => setMenu(false));
jumpBtn.addEventListener("click", jumpToLatest);
logEl.addEventListener("scroll", () => {
  stickToBottom = nearBottom();
  jumpBtn.hidden = stickToBottom || !logEl.querySelector("article");
}, { passive: true });

logEl.addEventListener("submit", (event) => {
  const formNode = event.target.closest("form.interaction");
  if (!formNode) return;
  event.preventDefault();
  const id = formNode.dataset.id;
  if (!runtimeSend({ type: "question.response", requestId: id, answers: valuesFromForm(formNode) })) {
    statusEl.textContent = "Could not send your answer. Is the terminal still running?";
    return;
  }
  state = markEntered(state, id);
  paintChat();
});

logEl.addEventListener("click", async (event) => {
  const decision = event.target.closest("[data-decision]");
  if (!decision) return;
  const root = decision.closest("[data-id]");
  const id = root?.dataset.id;
  if (root?.dataset.kind === "autofill") {
    try {
      const res = await post("/autofill/decide", {
        reviewId: id,
        token: root.dataset.token,
        decision: decision.dataset.decision,
        expectedControllerGeneration: state.controllerGeneration,
        conversationId: state.conversationId,
      });
      if (!res.ok) {
        statusEl.textContent = "Could not record that autofill decision.";
        return;
      }
    } catch {
      statusEl.textContent = "Could not record that autofill decision.";
      return;
    }
    state = markEntered(state, id);
    paintChat();
    return;
  }
  if (!runtimeSend({ type: "permission.decision", requestId: id, decision: decision.dataset.decision })) {
    statusEl.textContent = "Could not send that decision. Is the terminal still running?";
    return;
  }
  state = markEntered(state, id);
  paintChat();
});

paletteQuery?.addEventListener("input", () => {
  renderPaletteList(paletteList, filterCommands(commands, paletteQuery.value));
});
paletteList?.addEventListener("click", (event) => {
  const item = event.target.closest("[data-command]");
  if (!item) return;
  palette.close();
  runAction(item.dataset.command);
});

document.addEventListener("keydown", (event) => {
  if (document.body.classList.contains("gated")) return;
  if (event.key === "Escape") {
    setMenu(false);
    return;
  }
  if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey) {
    const tag = event.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    event.preventDefault();
    promptEl.focus();
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openPalette();
  }
});

async function ensureTerminal() {
  const host = document.getElementById("panel-terminal");
  const bridge = window.deskApp?.terminal;
  if (!host || !bridge || terminalView) {
    terminalView?.focus();
    return;
  }
  let Terminal;
  let FitAddon;
  try {
    ({ Terminal } = await import("@xterm/xterm"));
    ({ FitAddon } = await import("@xterm/addon-fit"));
  } catch {
    host.innerHTML = `<div class="empty"><p class="kicker">Terminal</p><h2>Claude Code, same conversation.</h2><p>The embedded terminal is available in the installable Desk.</p></div>`;
    return;
  }
  host.innerHTML = "";
  const xtermHost = document.createElement("div");
  xtermHost.className = "xterm-host";
  host.append(xtermHost);
  terminalView = createTerminalView({
    terminalFactory: () => new Terminal({ convertEol: true, cursorBlink: true, fontFamily: "IBM Plex Mono, ui-monospace, monospace" }),
    fitAddonFactory: () => new FitAddon(),
    bridge: {
      write(data) { if (terminalId) bridge.write({ terminalId, data }); },
      resize({ cols, rows }) { if (terminalId) bridge.resize({ terminalId, cols, rows }); },
    },
  });
  terminalView.mount(xtermHost);
  bridge.onData((payload) => {
    if (payload?.data) terminalView.write(payload.data);
  });
  bridge.onExit(() => {
    terminalView.setInputEnabled(false);
    releaseTerminal();
  });
  const started = await bridge.start({
    expectedControllerGeneration: state.controllerGeneration,
    cols: 80,
    rows: 24,
  });
  if (!started?.ok) {
    terminalView.dispose();
    terminalView = null;
    host.innerHTML = `<div class="empty"><p class="kicker">Terminal</p><h2>Could not attach Claude.</h2><p>Stay in Chat. Open CLI still works for the same workspace.</p></div>`;
    return;
  }
  terminalId = started.terminalId;
  state = applySnapshot(state, started.snapshot || { controller: "terminal" });
  terminalView.focus();
}

async function releaseTerminal() {
  if (!terminalId) return;
  const bridge = window.deskApp?.terminal;
  const id = terminalId;
  terminalId = null;
  try {
    const result = await bridge?.dispose({ terminalId: id });
    if (result?.snapshot) state = applySnapshot(state, result.snapshot);
  } catch {
    // The handoff back to chat is best-effort; the runtime also resets the
    // persisted controller on load.
  }
}

bindDelegatedActions(document);
const surfaceTabs = [{ id: "chat", label: "Chat" }];
if (window.deskApp?.terminal) surfaceTabs.push({ id: "terminal", label: "Terminal" });
surfaceTabs.push({ id: "files", label: "Files" });
mountTabs(document.getElementById("surface-tabs"), {
  tabs: surfaceTabs,
  selectedId: "chat",
  onSelect(id) {
    if (id === "files") loadArtifacts();
    if (id === "terminal") ensureTerminal();
    if (id !== "terminal") releaseTerminal();
  },
});
filesEl.addEventListener("click", (event) => {
  const item = event.target.closest("[data-artifact-id]");
  if (item) {
    artifactState = { ...artifactState, selectedId: item.dataset.artifactId, confirm: null };
    showArtifactPreview(item.dataset.artifactId).catch((error) => {
      artifactState = { ...artifactState, error: error.message, status: "error" };
      paintFiles();
    });
    return;
  }
  const action = event.target.closest("[data-artifact-action]");
  if (action && artifactState.selectedId) {
    if (action.dataset.artifactAction === "preview") showArtifactPreview(artifactState.selectedId);
    else if (action.dataset.artifactAction === "compare") showArtifactCompare(artifactState.selectedId);
    else artifactState = requestArtifactConfirm(artifactState, action.dataset.artifactAction);
    paintFiles();
    return;
  }
  const decision = event.target.closest("[data-confirm]");
  if (decision?.dataset.confirm === "yes") confirmArtifactAction();
  else if (decision?.dataset.confirm === "no") {
    artifactState = { ...artifactState, confirm: null };
    paintFiles();
  }
});
filesEl.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    artifactState = moveArtifactSelection(artifactState, event.key === "ArrowDown" ? 1 : -1);
    paintFiles();
  }
});
paintChat();
paintFiles();

fetch("/commands")
  .then((res) => res.json())
  .then((data) => {
    commands = data.commands || [];
    if (commands.length) renderSidebar(stepsEl, commands);
  })
  .catch(() => {});

connectRuntime();

const gate = document.getElementById("gate");
const gateDock = document.getElementById("dock");
const gateStage = document.querySelector("main.stage");
const gateTitle = document.getElementById("gate-title");
const gateCopy = document.getElementById("gate-copy");
const gateLog = document.getElementById("gate-log");
const gateAction = document.getElementById("gate-action");
const gateCancel = document.getElementById("gate-cancel");
const gateCodeWrap = document.getElementById("gate-code-wrap");
const gateCode = document.getElementById("gate-code");
const gateChrome = document.getElementById("gate-chrome");
const gateLink = document.getElementById("gate-link");
const gateLinkWrap = document.getElementById("gate-link-wrap");
const accountLabel = document.getElementById("account-label");

let authWaiter = null;
let lastHealth = null;
let claudeAutoStarted = false;

function setGate(open, title, copy) {
  document.body.classList.toggle("gated", open);
  gate.hidden = !open;
  gate.inert = !open;
  gate.setAttribute("aria-hidden", String(!open));
  for (const node of [gateDock, gateStage]) {
    if (!node) continue;
    node.inert = open;
    node.setAttribute("aria-hidden", String(open));
  }
  if (title) gateTitle.textContent = title;
  if (copy) gateCopy.textContent = copy;
  if (open) {
    setMenu(false);
    gateAction.focus();
  } else {
    promptEl.focus();
  }
}

function appendGateLog(text) {
  gateLog.hidden = false;
  gateLog.textContent = `${gateLog.textContent}${gateLog.textContent ? "\n" : ""}${text}`.slice(-2000);
  gateLog.scrollTop = gateLog.scrollHeight;
}

function needsInstall(health) {
  return Boolean(health) && health.installed === false && !health.error;
}

function needsLogin(health) {
  return Boolean(health?.installed && health.loggedIn === false && !health.error);
}

function describeAccount(health) {
  if (health?.loggedIn) {
    const plan = health.subscriptionType ? ` · ${health.subscriptionType}` : "";
    return health.email ? `${health.email}${plan}` : `Signed in${plan}`;
  }
  if (health?.error) return "Claude status unknown";
  if (needsLogin(health)) return "Signed out";
  return "localhost only";
}

function waitForAuth(kind) {
  return new Promise((resolve) => {
    authWaiter = { kind, resolve };
  });
}

async function readHealth() {
  const res = await fetch("/auth/status");
  if (!res.ok) throw new Error("Could not read Claude status.");
  return res.json();
}

function applyHealth(health) {
  lastHealth = health;
  accountLabel.textContent = describeAccount(health);
  accountLabel.classList.toggle("signed-in", Boolean(health?.loggedIn));
  gateCancel.hidden = true;
  gateCodeWrap.hidden = true;
  gateLinkWrap.hidden = true;
  if (health.loggedIn) {
    setGate(false);
    return true;
  }
  if (needsInstall(health)) {
    setGate(true, "Starting Claude Code", "The desk installs Claude Code if it is missing, then signs you in with the same Claude account you use in Chrome.");
    gateAction.textContent = claudeAutoStarted ? "Working…" : "Install and sign in";
    return false;
  }
  if (needsLogin(health)) {
    setGate(true, "Starting Claude Code", "One claude.ai tab will open in your browser. Use the same email as your Chrome Claude subscription (Pro, Max, Team, or Enterprise). API keys are not required.");
    gateAction.textContent = claudeAutoStarted ? "Working…" : "Sign in with Claude";
    return false;
  }
  setGate(false);
  return true;
}

function autoStartClaude(health) {
  if (claudeAutoStarted) return;
  if (!needsInstall(health) && !needsLogin(health)) return;
  claudeAutoStarted = true;
  bootstrapClaude();
}

async function bootstrapClaude() {
  gateAction.disabled = true;
  gateCancel.hidden = false;
  try {
    let health = await readHealth();
    if (needsInstall(health)) {
      appendGateLog("Installing Claude Code with the official installer.");
      if (window.deskApp?.ensureClaude) {
        let info = await window.deskApp.ensureClaude();
        while (info?.status === "installing") {
          await new Promise((resolve) => window.setTimeout(resolve, 1500));
          info = await window.deskApp.ensureClaude();
        }
        if (info?.status === "failed") throw new Error(info.error || "Claude Code did not install.");
        health = info?.health || (await readHealth());
      } else {
        const res = await post("/auth/install");
        if (!res.ok) throw new Error("Install is already running.");
        const done = await waitForAuth("install");
        if (!done.ok) throw new Error(done.error || "Claude Code did not install.");
        health = done.health || (await readHealth());
      }
    }
    if (needsLogin(health)) {
      appendGateLog("Opening the claude.ai login. Finish it in the browser, then return here.");
      const res = await post("/auth/login");
      if (!res.ok) throw new Error("Login is already running.");
      const done = await waitForAuth("login");
      if (!done.ok) throw new Error(done.error || "Claude login did not finish.");
      health = done.health || (await readHealth());
    }
    if (health.loggedIn || (!needsLogin(health) && !needsInstall(health))) {
      applyHealth(health);
      return;
    }
    throw new Error("Claude is installed but still signed out. Try Sign in again.");
  } catch (err) {
    appendGateLog(err.message);
    gateTitle.textContent = "Could not connect";
    gateCopy.textContent = err.message;
  } finally {
    gateAction.disabled = false;
    gateCancel.hidden = Boolean(gate.hidden);
  }
}

source.addEventListener("auth-log", (event) => appendGateLog(JSON.parse(event.data).text));
source.addEventListener("auth-url", (event) => {
  // Claude Code opens the browser itself and prints the same URL as a
  // fallback. Opening it again here is what produced two sign-in tabs.
  const url = JSON.parse(event.data).url;
  if (!/^https:\/\//.test(url)) return;
  gateLink.href = url;
  gateLinkWrap.hidden = false;
  gateCopy.textContent = "A claude.ai sign-in tab opened in your browser. Finish signing in there, then come back to this window.";
});
source.addEventListener("auth-code", () => {
  gateCodeWrap.hidden = false;
  gateCode.focus();
});
source.addEventListener("auth-done", (event) => {
  const data = JSON.parse(event.data);
  if (authWaiter && (authWaiter.kind === data.kind || data.kind === "cancel")) {
    const { resolve } = authWaiter;
    authWaiter = null;
    resolve(data);
  }
  if (data.health) applyHealth(data.health);
});

gateAction.addEventListener("click", () => bootstrapClaude());
gateCancel.addEventListener("click", () => post("/auth/cancel"));
gateCode.addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key !== "Enter") return;
  const code = gateCode.value.trim();
  if (!code) return;
  post("/auth/code", { code });
  gateCode.value = "";
});

fetch("/auth/meta")
  .then((res) => res.json())
  .then((meta) => {
    if (meta.chromeExtensionUrl) gateChrome.href = meta.chromeExtensionUrl;
  })
  .catch(() => {});

readHealth()
  .then((health) => {
    applyHealth(health);
    autoStartClaude(health);
  })
  .catch(() => {
    setGate(false);
    accountLabel.textContent = "Claude status unknown";
  });

tickClock();
window.setInterval(tickClock, 30000);
sizePrompt();
promptEl.focus();
