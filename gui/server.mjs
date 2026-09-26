#!/usr/bin/env node
/**
 * Local desk for this repo. Native Chat uses the session runtime when one is
 * attached; otherwise Claude print mode remains the fallback. This process
 * only binds 127.0.0.1.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildClaudeArgs,
  chromeEnabled,
  clearDeskSession,
  closePrintInput,
  commandLooksInstalled,
  exitErrorText,
  getClaudeHealth,
  loadDeskSession,
  MISSING_CLAUDE_TEXT,
  resolveCommand,
  saveDeskSession,
  shouldRetryWithoutResume,
  spawnClaude,
  spawnOfficialInstall,
  turnStatusText,
} from "./claude.mjs";
import { CHROME_EXTENSION_URL, CLAUDE_AI_URL, CLAUDE_PRICING_URL, DESK_SESSION_NAME } from "./defaults.mjs";
import { chromeExtensionStatus, installClaudeChrome, openInChrome } from "./claude-chrome.mjs";
import { DEMO_LABEL, demoTurnFor, isDemoFlag, prepareDemoWorkspace } from "./demo-workspace.mjs";
import { existingWorkspaceHint, openClaudeLogin, rememberWorkspace, resolveWorkspace, startCli } from "./workspace.mjs";
import { ARTIFACT_HTML_CSP, createArtifactService } from "./artifacts.mjs";
import { createAutofillBridge } from "./autofill-bridge.mjs";
import { attachWebSocketTransport } from "./websocket-transport.mjs";
import { createCommandRegistry } from "./command-registry.mjs";
import {
  checkTools,
  MAX_DOCUMENT_BYTES,
  readApplications,
  readJobs,
  readProgress,
  resolveWorkspaceDir,
  resolveWorkspaceFile,
  saveDocument,
  setJobMark,
  systemOpener,
} from "./desk-data.mjs";
import { attachSample } from "./sample-job.mjs";
import { applyFakeUpdateState, getUpdateState, requestUpdateDownload, requestUpdateInstall } from "./update.mjs";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, "public");
const HOST = "127.0.0.1";
const PORT = Number(process.env.JOB_SEARCH_GUI_PORT || 8765);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

const clients = new Set();
let workspace = join(HERE, "..");
let demoMode = false;
let deskArtifacts = null;
let deskRuntime = null;
let deskAutofill = null;
let busy = false;
let sessionId = null;
let child = null;
let helper = null;
// Sign-in happens in Claude Code's own window. The desk only polls
// `claude auth status` until it reports signed in; this is that poll.
let loginWatch = null;
const LOGIN_POLL_MS = 2500;
const LOGIN_WATCH_LIMIT_MS = 10 * 60 * 1000;
// Why the installed app's session runtime is not running, if it failed to start.
let runtimeError = "";
let streamedText = false;
let sawInit = false;
let stopRequested = false;
// Turn generations: a child spawned before the latest /reset must not write
// state or stream into the fresh conversation. Without this, "New chat"
// during a busy turn lets the dying child's buffered stdout re-save the old
// session id, and the next /send resumes the conversation the user reset.
let turnGen = 0;
let resetGen = 0;
// Rendered conversation, replayed to a client that reconnects (page refresh).
const transcript = [];
let turnText = "";
// The tail of Claude's stderr for the running turn, shown with the error card
// when the child exits badly; without it the page only ever said "exit code 1".
let errTail = "";
// Set when a result event already produced an error card, so the exit-code
// card does not restate it.
let reportedError = false;
// True once this turn produced any reply text, even text already moved into
// a transcript row by a tool call.
let repliedThisTurn = false;
// tool_use id -> tool name, so "done" chips can show the name, not the id.
const toolNames = new Map();

// Rows are capped by conversation turns, not raw rows: one tool-heavy turn
// can add dozens of chips, which must never evict the message that asked.
const TRANSCRIPT_CAP = 600;
const TRANSCRIPT_KEEP_TURNS = 40;

// Only what the page shows is stored: describeTool reads these fields, and a
// full Write input or Bash command would put file contents on disk twice.
const TOOL_INPUT_KEYS = ["file_path", "path", "notebook_path", "description", "query", "url", "pattern", "skill"];
function summarizeToolInput(input = {}) {
  const out = {};
  for (const key of TOOL_INPUT_KEYS) {
    if (typeof input?.[key] === "string" && input[key]) out[key] = input[key].slice(0, 200);
  }
  return out;
}

// The print-mode conversation lives on disk too, so a desk that crashes or is
// restarted mid-turn comes back with the conversation instead of a blank page.
function transcriptPath() {
  return join(workspace, ".claude", "desk", "transcript.json");
}

let transcriptSaveTimer = null;
function writeTranscriptNow() {
  clearTimeout(transcriptSaveTimer);
  transcriptSaveTimer = null;
  try {
    const dir = join(workspace, ".claude", "desk");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Write whole, then rename: a crash mid-write never leaves half a file.
    const tmp = `${transcriptPath()}.tmp`;
    writeFileSync(tmp, JSON.stringify(transcript.slice(-TRANSCRIPT_CAP)), { mode: 0o600 });
    renameSync(tmp, transcriptPath());
  } catch {
    // A read-only folder just loses replay after a restart.
  }
}
function saveTranscript() {
  clearTimeout(transcriptSaveTimer);
  transcriptSaveTimer = setTimeout(writeTranscriptNow, 150);
  transcriptSaveTimer.unref?.();
}
// Shutdown paths call this so the last 150 ms of conversation are not lost.
function flushTranscript() {
  if (transcriptSaveTimer) writeTranscriptNow();
}

function loadTranscript() {
  transcript.length = 0;
  try {
    if (!existsSync(transcriptPath())) return;
    const rows = JSON.parse(readFileSync(transcriptPath(), "utf8"));
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (row && typeof row.role === "string") transcript.push(row);
    }
    // A conversation that did not end on a reply, an error, or a note was
    // cut off by a restart (mid-turn it usually ends on a tool row); say so
    // instead of leaving a message that looks ignored.
    const last = transcript.at(-1);
    if (last && !["assistant", "error", "notice"].includes(last.role)) {
      transcript.push({ role: "error", text: "The desk restarted while Claude was working on this. Send the message again." });
    }
  } catch {
    transcript.length = 0;
  }
}

// Keep the replayed conversation self-explanatory: trim on a "You" boundary
// so a reload never opens with a reply to a question that is no longer shown.
function pushTranscript(row) {
  transcript.push(row);
  if (transcript.length > TRANSCRIPT_CAP) {
    // Keep the last TRANSCRIPT_KEEP_TURNS exchanges whole.
    let turns = 0;
    let cut = 0;
    for (let index = transcript.length - 1; index >= 0; index -= 1) {
      if (transcript[index].role === "user") {
        turns += 1;
        if (turns === TRANSCRIPT_KEEP_TURNS) {
          cut = index;
          break;
        }
      }
    }
    if (cut > 0) {
      transcript.splice(0, cut);
      transcript.unshift({ role: "notice", text: "Earlier messages are not shown." });
    }
  }
  saveTranscript();
}

// A plain-language note the page shows as a card and replays after a reload.
function sendNotice(text) {
  send("notice", { text });
  pushTranscript({ role: "notice", text });
}

// Text streamed before a tool call becomes its own row, and the tool its own
// chip, so a reload shows the same shape the person watched live.
function flushTurnText() {
  if (!turnText.trim()) return;
  repliedThisTurn = true;
  pushTranscript({ role: "assistant", text: turnText });
  turnText = "";
}

function send(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      // A client that went away mid-write must not take the desk down.
      clients.delete(res);
    }
  }
}

function sendTurnError(text, detail = "") {
  send("turn-error", { text, detail });
  pushTranscript({ role: "error", text, detail });
}

function publicWorkspace() {
  return demoMode ? DEMO_LABEL : workspace;
}

function snapshot(withTranscript = false) {
  const base = {
    sessionId,
    busy,
    chromeGroup: chromeEnabled() ? DESK_SESSION_NAME : null,
    workspace: publicWorkspace(),
    demo: demoMode,
    runtime: Boolean(deskRuntime),
    runtimeError,
  };
  if (withTranscript && !deskRuntime) {
    const rows = transcript.slice(-TRANSCRIPT_CAP);
    if (busy && turnText) rows.push({ role: "assistant", text: turnText, partial: true });
    base.transcript = rows;
  } else if (withTranscript) {
    base.transcript = [];
  }
  return base;
}

function extractText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

function emitTools(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type === "tool_use" && block.name === "AskUserQuestion") {
      // Print mode cannot answer the tool (no permission callback, so the CLI
      // denies it and Claude re-asks in text). Show the question anyway, so
      // the person knows what Claude wanted and can answer in the composer.
      if (block.id) toolNames.set(block.id, block.name);
      send("question", { id: block.id, questions: block.input?.questions ?? [] });
      continue;
    }
    if (block?.type === "tool_use" && block.name) {
      const known = toolNames.has(block.id);
      if (block.id) toolNames.set(block.id, block.name);
      send("tool", { id: block.id, name: block.name, phase: "start", input: block.input ?? {} });
      if (!known) {
        flushTurnText();
        pushTranscript({ role: "tool", id: block.id, name: block.name, input: summarizeToolInput(block.input) });
      } else {
        // The stream start had no input; the full message carries it.
        const row = [...transcript].reverse().find((item) => item.role === "tool" && item.id === block.id);
        if (row) {
          row.input = summarizeToolInput(block.input);
          saveTranscript();
        }
      }
    }
    if (block?.type === "tool_result") {
      send("tool", { id: block.tool_use_id, name: toolNames.get(block.tool_use_id) || "tool", phase: "done" });
    }
  }
}

function handleStreamLine(line) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return;
  }

  if (typeof event.session_id === "string" && event.session_id !== sessionId) {
    sessionId = event.session_id;
    saveDeskSession(workspace, sessionId);
    send("session", { sessionId, chromeGroup: snapshot().chromeGroup });
  }

  if (event.type === "system" && event.subtype === "init") {
    sawInit = true;
    send("status", { text: "Claude is working in your job-search folder" });
    return;
  }

  if (event.type === "assistant") {
    emitTools(event.message);
    const text = extractText(event.message);
    if (text && !streamedText) {
      turnText += text;
      send("delta", { text });
    }
    return;
  }

  if (event.type === "user") {
    emitTools(event.message);
    return;
  }

  if (event.type === "stream_event") {
    const inner = event.event || {};
    if (inner.type === "content_block_start" && inner.content_block?.type === "tool_use" && inner.content_block.name !== "AskUserQuestion") {
      const block = inner.content_block;
      if (block.id && block.name) toolNames.set(block.id, block.name);
      send("tool", { id: block.id, name: block.name || "tool", phase: "start", input: block.input ?? {} });
      flushTurnText();
      pushTranscript({ role: "tool", id: block.id, name: block.name || "tool", input: summarizeToolInput(block.input) });
    }
    if (inner.type === "content_block_start" && /^(redacted_)?thinking$/.test(inner.content_block?.type || "")) {
      // No thinking text leaves the process; the page only needs to know
      // Claude is thinking so it can say so instead of sitting silent.
      send("thinking", {});
    }
    const delta = inner.delta;
    if (delta?.type === "text_delta" && delta.text) {
      streamedText = true;
      turnText += delta.text;
      send("delta", { text: delta.text });
    }
    return;
  }

  if (event.type === "result") {
    if (event.is_error) {
      // One card, once: the error text is not also a reply, and the exit-code
      // card below stays quiet when this one exists. The streamed reply is
      // stored first so a reload keeps reply-then-problem order.
      reportedError = true;
      flushTurnText();
      sendTurnError(event.result || "Claude reported an error.");
      return;
    }
    if (typeof event.result === "string" && event.result && !streamedText) {
      if (!turnText.trim()) turnText = event.result;
      send("result", { text: event.result });
    }
  }
}

// Exported for tests: the last stderr line when it reads as one sentence
// meant for a person, or "" when it is a warning, a stack frame, or JSON.
export function clearErrorLine(tail) {
  const lines = String(tail || "").split("\n").map((line) => line.trim()).filter(Boolean);
  const last = lines.at(-1) || "";
  if (/^\(use `node|^npm warn|^warning|^deprecat|^\(node:\d+\)/i.test(last)) return "";
  const match = /^(?:\[?(?:error|api error|fatal)\]?:?\s*)?(.{8,200})$/i.exec(last);
  if (!match) return "";
  const text = match[1];
  if (/\bat\s+\S+\s*\(|node:internal|^\s*[{[]|^\s*at /.test(text)) return "";
  return text;
}

function stopProcess(proc, group) {
  if (!proc) return;
  const pid = proc.pid;
  if (IS_WIN && pid) {
    const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
    killer.on("error", () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    });
    return;
  }
  if (pid && group) {
    try {
      process.kill(-pid, "SIGTERM");
      return;
    } catch {
      // Fall through to a direct kill.
    }
  }
  proc.kill("SIGTERM");
}

const KILL_GRACE_MS = 5000;

function stopClaude(reason = "Stopped") {
  if (!child) return;
  const target = child;
  stopRequested = true;
  stopProcess(target, !IS_WIN);
  send("status", { text: reason });
  // A child that ignores SIGTERM (a hung tool, a trapped signal) would keep
  // the desk busy forever; escalate so Stop always stops.
  const escalate = setTimeout(() => forceKill(target), KILL_GRACE_MS);
  escalate.unref?.();
}

function forceKill(target) {
  if (!target?.pid || target.exitCode !== null || target.signalCode !== null) return;
  try {
    if (!IS_WIN) process.kill(-target.pid, "SIGKILL");
    else target.kill("SIGKILL");
  } catch {
    try { target.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

function stopHelper() {
  stopLoginWatch();
  if (!helper) return;
  stopProcess(helper, !IS_WIN);
  helper = null;
}

function attachHelperOutput(proc, kind) {
  const onChunk = (chunk) => {
    const text = chunk.toString("utf8");
    if (!text.trim()) return;
    send("auth-log", { kind, text: text.trim() });
  };
  proc.stdout?.on("data", onChunk);
  proc.stderr?.on("data", onChunk);
}

function runHelper(kind, factory) {
  if (helper) {
    send("auth-log", { kind, text: "Already running a setup step. Wait or cancel." });
    return false;
  }
  const proc = factory();
  helper = proc;
  // A write to a stdin the helper already closed must not crash the desk.
  proc.stdin?.on("error", () => {});
  send("auth-log", { kind, text: "Installing Claude Code…" });
  attachHelperOutput(proc, kind);
  proc.on("error", (err) => {
    // A cancelled-then-restarted helper's late events must not clobber the
    // live one: only the process that still owns `helper` may clear it.
    if (helper !== proc) return;
    helper = null;
    send("auth-log", { kind, text: err.message });
    send("auth-done", { kind, ok: false, error: err.message });
  });
  proc.on("close", async (code) => {
    if (helper !== proc) return;
    helper = null;
    const health = await getClaudeHealth(workspace);
    send("auth-done", { kind, ok: health.installed, code: code ?? 0, health });
  });
  return true;
}

function stopLoginWatch() {
  if (!loginWatch) return;
  clearInterval(loginWatch.timer);
  loginWatch = null;
}

/**
 * The desk never sees the sign-in itself: no link, no code, no token. It
 * asks Claude Code whether the person is signed in and stops once it says yes.
 */
function startLoginWatch() {
  if (loginWatch) return false;
  const startedAt = Date.now();
  const watch = { timer: null, checking: false };
  watch.timer = setInterval(async () => {
    if (watch.checking || loginWatch !== watch) return;
    watch.checking = true;
    try {
      const health = await getClaudeHealth(workspace);
      if (loginWatch !== watch) return;
      if (health.loggedIn) {
        stopLoginWatch();
        send("auth-done", { kind: "login", ok: true, health });
        return;
      }
      if (Date.now() - startedAt > LOGIN_WATCH_LIMIT_MS) {
        stopLoginWatch();
        send("auth-done", {
          kind: "login",
          ok: false,
          health,
          error: "Claude Code still reports signed out. Finish the sign-in in its window, then click Sign in to Claude Code again.",
        });
      }
    } finally {
      watch.checking = false;
    }
  }, LOGIN_POLL_MS);
  loginWatch = watch;
  return true;
}

let demoTimers = [];

function clearDemoReplay() {
  for (const timer of demoTimers) clearTimeout(timer);
  demoTimers = [];
}

function demoPaceMs() {
  return process.env.JOB_SEARCH_DEMO_PACE === "film" ? 46 : 8;
}

function later(ms, fn) {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  demoTimers.push(timer);
}

// Demo chat is a recording of one turn. It never spawns Claude Code.
function replayDemoTurn(prompt) {
  if (busy) {
    send("turn-error", { text: "Claude is still working on the last message. Wait for it to finish, or press Stop." });
    return false;
  }
  clearDemoReplay();
  busy = true;
  streamedText = true;
  stopRequested = false;
  turnText = "";
  reportedError = false;
  repliedThisTurn = false;
  const gen = ++turnGen;
  const live = () => gen === turnGen;
  send("status", { text: "Claude is working in your job-search folder" });
  send("user", { text: prompt });
  pushTranscript({ role: "user", text: prompt });

  const turn = demoTurnFor(prompt);
  const steps = [];
  let at = 280;
  steps.push([at, () => {
    if (!live()) return;
    send("thinking", {});
  }]);
  turn.tools.forEach((tool, index) => {
    const id = `demo-tool-${index}`;
    at += 420;
    steps.push([at, () => {
      if (!live()) return;
      send("tool", { id, name: tool.name, phase: "start", input: { file_path: tool.file } });
      pushTranscript({ role: "tool", id, name: tool.name, input: { file_path: tool.file } });
    }]);
    at += 480;
    steps.push([at, () => {
      if (!live()) return;
      send("tool", { id, name: tool.name, phase: "done" });
    }]);
  });
  const pace = demoPaceMs();
  for (const chunk of turn.reply.match(/\S+\s*/g) || [turn.reply]) {
    at += pace;
    steps.push([at, () => {
      if (!live()) return;
      turnText += chunk;
      send("delta", { text: chunk });
    }]);
  }
  at += 240;
  steps.push([at, () => finishDemoTurn(gen)]);
  for (const [wait, fn] of steps) later(wait, fn);
  return true;
}

function finishDemoTurn(gen) {
  if (gen !== turnGen) return;
  if (turnText.trim()) {
    pushTranscript({ role: "assistant", text: turnText });
    turnText = "";
  }
  busy = false;
  send("idle", snapshot());
}

function runClaude(prompt, { retried = false } = {}) {
  if (demoMode) return replayDemoTurn(prompt);
  if (busy) {
    // Transient: a message typed while the old turn is still closing must
    // not persist an error into the conversation.
    send("turn-error", { text: "Claude is still working on the last message. Wait for it to finish, or press Stop." });
    return false;
  }

  if (!commandLooksInstalled(resolveCommand("claude"))) {
    send("turn-error", { text: MISSING_CLAUDE_TEXT });
    send("idle", snapshot());
    return "missing";
  }

  const usedResume = Boolean(sessionId);
  const args = buildClaudeArgs(prompt, { sessionId });

  busy = true;
  streamedText = false;
  sawInit = false;
  stopRequested = false;
  turnText = "";
  errTail = "";
  reportedError = false;
  repliedThisTurn = false;
  toolNames.clear();
  const gen = ++turnGen;
  let settled = false;
  const superseded = () => gen <= resetGen;
  send("status", { text: turnStatusText({ resuming: Boolean(sessionId) }) });
  if (!retried) {
    send("user", { text: prompt });
    pushTranscript({ role: "user", text: prompt });
  }

  try {
    child = spawnClaude(args, { cwd: workspace, detached: !IS_WIN });
  } catch (err) {
    // A synchronous spawn failure used to leave the desk busy forever with
    // nothing on screen.
    busy = false;
    child = null;
    sendTurnError(err.message || MISSING_CLAUDE_TEXT);
    send("idle", snapshot());
    return "failed";
  }
  // Print mode receives its prompt as an argument and waits for a piped stdin
  // to close. Leaving this stream open makes the Desk appear busy forever.
  child.stdin?.on("error", () => {});
  closePrintInput(child.stdin);

  let buffer = "";
  child.stdout.on("data", (chunk) => {
    if (superseded()) return;
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) handleStreamLine(line);
    }
  });
  child.stderr.on("data", (chunk) => {
    if (superseded()) return;
    const text = chunk.toString("utf8").trim();
    if (!text) return;
    errTail = `${errTail}${errTail ? "\n" : ""}${text}`.slice(-1500);
    send("log", { text });
  });
  child.on("error", (err) => {
    if (gen !== turnGen) return;
    if (settled) return;
    settled = true;
    busy = false;
    child = null;
    sendTurnError(err.code === "ENOENT" ? MISSING_CLAUDE_TEXT : err.message);
    send("idle", snapshot());
  });
  child.on("close", (code, signal) => {
    if (gen !== turnGen) return;
    if (settled) return;
    settled = true;
    // A child that outlived a /reset must still release busy, but its
    // buffered output, retry, and error reporting belong to the old
    // conversation and are dropped.
    if (!superseded() && buffer.trim()) handleStreamLine(buffer);
    busy = false;
    child = null;
    if (superseded()) {
      send("idle", snapshot());
      return;
    }
    if (!stopRequested && shouldRetryWithoutResume({ code, sawInit, usedResume, retried })) {
      sessionId = null;
      clearDeskSession(workspace);
      sendNotice("Claude could not continue the earlier conversation, so this is a fresh start. It will not remember previous chats.");
      send("session", { sessionId: null, chromeGroup: snapshot().chromeGroup });
      runClaude(prompt, { retried: true });
      return;
    }
    const hadReply = Boolean(turnText.trim()) || repliedThisTurn;
    if (turnText.trim()) {
      pushTranscript({ role: "assistant", text: turnText });
      turnText = "";
    }
    let failure = reportedError ? null : exitErrorText(code, stopRequested);
    if (!failure && !reportedError && !stopRequested) {
      // A child killed by a signal exits with code null; without this the
      // turn ended silently as though the message had been ignored.
      if (signal) failure = `Claude stopped unexpectedly (${signal}).`;
      else if (!code && !hadReply) failure = "Claude finished without sending a reply. Try sending the message again.";
    }
    if (failure) {
      // When stderr ends with one clear sentence, lead with it; the generic
      // exit text becomes the detail instead of contradicting it.
      const said = clearErrorLine(errTail);
      if (said) sendTurnError(`Claude reported: ${said}`, `${failure}\n\n${errTail}`);
      else sendTurnError(failure, errTail);
    }
    if (stopRequested && hadReply) sendNotice("Stopped. Claude's reply was cut off here.");
    else if (stopRequested) sendNotice("Stopped before Claude replied.");
    send("idle", snapshot());
  });
}

const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    const onData = (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        req.off("data", onData);
        req.resume();
        const err = new Error("request too large");
        err.tooLarge = true;
        reject(err);
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    // A drain that aborts mid-flight must not raise an unhandled 'error'.
    req.on("error", () => {
      if (!tooLarge) reject(new Error("request stream error"));
    });
  });
}

// Uploads (a CV) are larger than any JSON body the desk takes.
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooLarge = false;
    const onData = (chunk) => {
      total += chunk.length;
      if (total > limit) {
        // Drain instead of destroying the socket, so the 413 and its
        // "larger than 25 MB" sentence still reach the page.
        tooLarge = true;
        req.off("data", onData);
        req.resume();
        const err = new Error("request too large");
        err.tooLarge = true;
        reject(err);
        return;
      }
      chunks.push(chunk);
    };
    req.on("data", onData);
    req.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks));
    });
    req.on("error", () => {
      if (!tooLarge) reject(new Error("request stream error"));
    });
  });
}

// `which` per tool costs a process each; the answer rarely changes.
let toolsCache = null;
function toolsStatus() {
  if (toolsCache && Date.now() - toolsCache.at < 30000) return toolsCache.value;
  const value = checkTools({ workspace });
  toolsCache = { at: Date.now(), value };
  return value;
}

const TEXT_PREVIEW_TYPES = { ".tex": "text/plain", ".md": "text/plain", ".txt": "text/plain", ".csv": "text/plain", ".json": "text/plain" };

async function handleDeskDataRequest(req, res, url) {
  if (req.method === "GET" && url.pathname === "/jobs") {
    const jobs = readJobs(workspace);
    json(res, 200, { jobs, ...attachSample({ jobs }) });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/update/status") {
    applyFakeUpdateState();
    json(res, 200, getUpdateState());
    return true;
  }
  if (req.method === "POST" && url.pathname === "/update/download") {
    if (process.env.JOB_SEARCH_UPDATE_FAKE === "1") {
      json(res, 200, { ok: true, dryRun: true });
      return true;
    }
    json(res, 200, requestUpdateDownload());
    return true;
  }
  if (req.method === "POST" && url.pathname === "/update/install") {
    if (process.env.JOB_SEARCH_UPDATE_FAKE === "1") {
      json(res, 200, { ok: true, dryRun: true });
      return true;
    }
    json(res, 200, requestUpdateInstall());
    return true;
  }
  if (req.method === "POST" && url.pathname === "/jobs/mark") {
    const body = await readJson(req);
    if (!body) {
      json(res, 400, { ok: false, error: "invalid JSON body" });
      return true;
    }
    try {
      setJobMark(workspace, body.key, body.mark ?? null);
      json(res, 200, { ok: true, jobs: readJobs(workspace) });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message });
    }
    return true;
  }
  if (req.method === "GET" && url.pathname === "/applications") {
    json(res, 200, { applications: readApplications(workspace) });
    return true;
  }
  if (req.method === "GET" && url.pathname === "/progress") {
    json(res, 200, readProgress(workspace));
    return true;
  }
  if (req.method === "GET" && url.pathname === "/tools") {
    if (url.searchParams.get("refresh") === "1") toolsCache = null;
    json(res, 200, toolsStatus());
    return true;
  }
  if (req.method === "POST" && url.pathname === "/documents") {
    let bytes;
    try {
      bytes = await readRawBody(req, MAX_DOCUMENT_BYTES);
    } catch (err) {
      json(res, err?.tooLarge ? 413 : 400, { ok: false, error: err?.tooLarge ? "That file is larger than 25 MB." : "The upload did not finish." });
      return true;
    }
    try {
      const saved = saveDocument(workspace, { name: url.searchParams.get("name") || "", kind: url.searchParams.get("kind") || "cv", bytes });
      json(res, 200, { ok: true, ...saved, progress: readProgress(workspace) });
    } catch (err) {
      json(res, 400, { ok: false, error: err.message });
    }
    return true;
  }
  if (req.method === "GET" && url.pathname === "/workspace-file") {
    const found = resolveWorkspaceFile(workspace, url.searchParams.get("path") || "");
    if (!found) {
      res.writeHead(404).end("not found");
      return true;
    }
    const ext = extname(found.absolutePath).toLowerCase();
    const type = ext === ".pdf" ? "application/pdf" : TEXT_PREVIEW_TYPES[ext];
    if (!type) {
      res.writeHead(415).end("no preview for this file type");
      return true;
    }
    const data = await readFile(found.absolutePath);
    res.writeHead(200, {
      "Content-Type": type === "text/plain" ? "text/plain; charset=utf-8" : type,
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
    });
    res.end(data);
    return true;
  }
  if (req.method === "POST" && url.pathname === "/workspace-file/open") {
    const body = await readJson(req);
    if (body?.reveal) {
      // The Applications tab reveals the archive folder; it used to point at
      // a job_posting.md that /apply does not always write.
      const dir = resolveWorkspaceDir(workspace, body.path || "");
      if (dir) {
        systemOpener.open(dir.absolutePath);
        json(res, 200, { ok: true, path: dir.relativePath });
        return true;
      }
    }
    const found = body && resolveWorkspaceFile(workspace, body.path || "");
    if (!found) {
      json(res, 404, { ok: false, error: "That file is not in your job-search folder any more." });
      return true;
    }
    if (body.reveal) systemOpener.reveal(found.absolutePath);
    else systemOpener.open(found.absolutePath);
    json(res, 200, { ok: true, path: found.relativePath });
    return true;
  }
  return false;
}

async function readJson(req) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (err?.tooLarge) throw err;
    return null;
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

function autofillApi() {
  return deskRuntime || {
    startAutofillReview: () => deskAutofill?.start(),
    markAutofillReady: (payload) => deskAutofill?.markReady(payload),
    decideAutofill: (payload) => deskAutofill?.decide({
      ...payload,
      // The no-runtime fallback reports controllerGeneration 1 (see snapshot
      // below); passing undefined here would 409 every Continue/Cancel.
      currentGeneration: 1,
    }),
    pollAutofillDecision: (payload) => deskAutofill?.pollDecision(payload),
    snapshot: () => ({ controllerGeneration: 1 }),
  };
}

// The actual bound port (the preferred port may be taken; startDesk scans up).
let boundPort = PORT;

function hostAllowed(host) {
  // Exact match only: a prefix check passes DNS-rebinding names like
  // 127.0.0.1.evil.com, which resolve here while the browser attaches
  // the attacker's cookies-free but Host-legitimate request.
  return host === `127.0.0.1:${boundPort}` || host === `localhost:${boundPort}`;
}

function originAllowed(origin) {
  // No Origin header = a non-browser local client (curl, the CLI). Browsers
  // always send Origin on cross-origin POSTs, which is the attack we gate:
  // any web page can fire a no-preflight POST at 127.0.0.1 and drive Claude
  // with permissions skipped. Same-origin desk requests carry our origin.
  if (!origin) return true;
  return origin === `http://127.0.0.1:${boundPort}` || origin === `http://localhost:${boundPort}`;
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function createDeskServer() {
  return createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      // A handler throw must never take the desk down (in the app the
      // embedded server dying closes the whole desk).
      if (err?.tooLarge) {
        if (!res.headersSent) json(res, 413, { ok: false, error: "payload too large" });
        else res.end();
        return;
      }
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
}

async function handleRequest(req, res) {
    if (!hostAllowed(req.headers.host || "")) {
      res.writeHead(403).end("localhost only");
      return;
    }
    if (req.method === "POST" && !originAllowed(req.headers.origin)) {
      res.writeHead(403).end("cross-origin requests are not allowed");
      return;
    }

    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`event: hello\ndata: ${JSON.stringify(snapshot(true))}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      // An 'error' on the response with no listener is an uncaught exception.
      res.on("error", () => clients.delete(res));
      return;
    }

    if (req.method === "GET" && url.pathname === "/workspace") {
      json(res, 200, { root: publicWorkspace(), demo: demoMode });
      return;
    }

    if (req.method === "GET" && url.pathname === "/commands") {
      const registry = await createCommandRegistry({ workspace });
      json(res, 200, { commands: registry.list() });
      return;
    }

    if (await handleDeskDataRequest(req, res, url)) return;

    if (url.pathname === "/artifacts" || url.pathname.startsWith("/artifacts/")) {
      if (req.headers.origin && !originAllowed(req.headers.origin)) {
        res.writeHead(403).end("cross-origin requests are not allowed");
        return;
      }
      if (!deskArtifacts) {
        res.writeHead(404).end("not found");
        return;
      }
      if (url.pathname === "/artifacts" && req.method === "GET") {
        json(res, 200, { artifacts: deskArtifacts.list() });
        return;
      }
      const match = url.pathname.match(/^\/artifacts\/([A-Za-z0-9._-]+)(?:\/(preview|compare|open|reveal))?$/);
      if (!match) {
        res.writeHead(404).end("not found");
        return;
      }
      const [, artifactId, action = "preview"] = match;
      try {
        if (action === "preview" && req.method === "GET") {
          const preview = await deskArtifacts.preview(artifactId);
          if (preview.kind === "html") {
            res.writeHead(200, {
              "Content-Type": "text/html; charset=utf-8",
              "Content-Security-Policy": ARTIFACT_HTML_CSP,
              "X-Content-Type-Options": "nosniff",
            });
            res.end(preview.text);
            return;
          }
          if (preview.bytes) {
            res.writeHead(200, {
              "Content-Type": preview.mime,
              "X-Content-Type-Options": "nosniff",
            });
            res.end(preview.bytes);
            return;
          }
          json(res, 200, preview);
          return;
        }
        if (action === "compare" && req.method === "GET") {
          json(res, 200, await deskArtifacts.compare(artifactId));
          return;
        }
        if ((action === "open" || action === "reveal") && req.method === "POST") {
          const body = await readJson(req);
          if (!body) {
            json(res, 400, { ok: false, error: "invalid JSON body" });
            return;
          }
          const expected = body.expectedControllerGeneration;
          const current = deskRuntime?.snapshot?.()?.controllerGeneration;
          if (current != null && expected !== current) {
            json(res, 409, { ok: false, error: "stale-controller" });
            return;
          }
          const result = action === "open"
            ? await deskArtifacts.open(artifactId)
            : await deskArtifacts.reveal(artifactId);
          json(res, 200, { ok: true, relativePath: result.relativePath });
          return;
        }
        res.writeHead(404).end("not found");
      } catch (error) {
        const unknown = /unknown/i.test(error.message);
        json(res, unknown ? 404 : 400, { ok: false, error: error.message });
      }
      return;
    }

    if (url.pathname === "/autofill/start" || url.pathname === "/autofill/ready" || url.pathname === "/autofill/decision" || url.pathname === "/autofill/decide") {
      if (!deskAutofill && !deskRuntime) {
        json(res, 404, { ok: false, error: "autofill unavailable" });
        return;
      }
      if (url.pathname === "/autofill/start" && req.method === "POST") {
        const started = autofillApi().startAutofillReview();
        json(res, 200, {
          ok: true,
          reviewId: started.reviewId,
          token: started.token,
          endpoint: `http://${HOST}:${boundPort}/autofill`,
        });
        return;
      }
      if (url.pathname === "/autofill/ready" && req.method === "POST") {
        const body = await readJson(req);
        if (!body) {
          json(res, 400, { ok: false, error: "invalid JSON body" });
          return;
        }
        const token = bearerToken(req) || body.token;
        const ready = await autofillApi().markAutofillReady({
          token,
          url: body.url,
          screenshot: body.screenshot,
        });
        if (!ready?.ok) {
          json(res, ready?.reason === "unauthorized" ? 401 : 400, { ok: false, error: ready?.reason || "ready-failed" });
          return;
        }
        if (ready.event && !deskRuntime) send("autofill-review", ready.event.payload);
        json(res, 200, { ok: true, reviewId: ready.event?.payload?.reviewId, state: ready.state });
        return;
      }
      if (url.pathname === "/autofill/decision" && req.method === "GET") {
        const token = bearerToken(req);
        const polled = autofillApi().pollAutofillDecision({ token });
        if (!polled?.ok) {
          json(res, 401, { ok: false, error: polled?.reason || "unauthorized" });
          return;
        }
        json(res, 200, polled);
        return;
      }
      if (url.pathname === "/autofill/decide" && req.method === "POST") {
        const body = await readJson(req);
        if (!body) {
          json(res, 400, { ok: false, error: "invalid JSON body" });
          return;
        }
        const decided = await autofillApi().decideAutofill({
          reviewId: body.reviewId,
          token: body.token || bearerToken(req),
          decision: body.decision,
          expectedControllerGeneration: body.expectedControllerGeneration,
        });
        if (!decided?.ok) {
          const status = decided?.reason === "stale-controller" ? 409 : decided?.reason === "unauthorized" ? 401 : 400;
          json(res, status, { ok: false, error: decided?.reason || "decide-failed" });
          return;
        }
        json(res, 200, decided);
        return;
      }
      res.writeHead(404).end("not found");
      return;
    }

    if (req.method === "POST" && url.pathname === "/workspace/cli") {
      if (demoMode) {
        json(res, 200, { ok: false, error: "Demo mode does not open a terminal against your real folder." });
        return;
      }
      json(res, 200, startCli(workspace));
      return;
    }

    if (req.method === "GET" && url.pathname === "/auth/status") {
      const health = await getClaudeHealth(workspace);
      if (demoMode) {
        // The org name carries the account email and the binary path carries
        // the Windows user name; neither belongs on a demo screen. Chat in
        // demo never starts Claude, so the composer must not wait on a login.
        json(res, 200, {
          ...health,
          installed: true,
          loggedIn: true,
          email: "",
          orgName: "",
          claude: "claude",
          error: "",
        });
        return;
      }
      json(res, 200, health);
      return;
    }

    if (req.method === "GET" && url.pathname === "/auth/meta") {
      json(res, 200, {
        chromeExtensionUrl: CHROME_EXTENSION_URL,
        claudeAiUrl: CLAUDE_AI_URL,
        pricingUrl: CLAUDE_PRICING_URL,
        chromeExtension: chromeExtensionStatus(),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/chrome-extension/status") {
      json(res, 200, chromeExtensionStatus());
      return;
    }

    if (req.method === "POST" && url.pathname === "/chrome-extension/install") {
      json(res, 200, { ok: true, ...installClaudeChrome() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/auth/install") {
      const started = runHelper("install", () => spawnOfficialInstall());
      json(res, started ? 202 : 409, started ? { ok: true } : { ok: false, running: true, kind: "install" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/auth/login") {
      if (helper) {
        json(res, 409, { ok: false, running: true, kind: "install" });
        return;
      }
      if (loginWatch) {
        // A reloaded page joins the sign-in already in progress.
        json(res, 202, { ok: true, running: true, opened: false });
        return;
      }
      const opened = openClaudeLogin(workspace);
      // Even when no terminal could be opened, keep watching: the person can
      // run `claude auth login` in any terminal and the desk still notices.
      startLoginWatch();
      send("auth-log", { kind: "login", text: opened.error ? `${opened.error} Open a terminal yourself and run: claude auth login` : "Opened Claude Code's sign-in in a new window." });
      json(res, 202, { ok: true, opened: !opened.error, error: opened.error || "" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/auth/cancel") {
      stopHelper();
      send("auth-done", { kind: "cancel", ok: false });
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/send") {
      const body = await readJson(req);
      if (!body) {
        json(res, 400, { ok: false, error: "invalid JSON body" });
        return;
      }
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      if (!prompt) {
        json(res, 400, { ok: false, error: "prompt required" });
        return;
      }
      const started = runClaude(prompt);
      if (started === false) {
        json(res, 409, { ok: false, error: "busy" });
        return;
      }
      if (started === "missing") {
        json(res, 503, { ok: false, error: MISSING_CLAUDE_TEXT });
        return;
      }
      if (started === "failed") {
        json(res, 500, { ok: false, error: "Claude Code could not start. See the card in the conversation." });
        return;
      }
      json(res, 202, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/stop") {
      if (deskRuntime && !child) {
        // The page falls back to HTTP while its WebSocket reconnects; the
        // running turn lives in the runtime, not in print mode.
        try {
          await deskRuntime.interrupt();
        } catch (err) {
          json(res, 500, { ok: false, error: err?.message || "Could not stop the turn." });
          return;
        }
        json(res, 200, { ok: true });
        return;
      }
      if (!child) {
        // Nothing to stop: make sure the page is not stuck showing busy.
        // A demo replay has no child; drop its timers before idle.
        clearDemoReplay();
        turnGen += 1;
        turnText = "";
        busy = false;
        send("idle", snapshot());
      } else {
        stopClaude("Stopped this turn");
      }
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/reset") {
      clearDemoReplay();
      if (demoMode) turnGen += 1;
      if (deskRuntime && !child) {
        // Same fallback as /stop: clear the runtime conversation, otherwise
        // the reconnecting page replays the "cleared" conversation.
        try {
          await deskRuntime.reset();
        } catch (err) {
          json(res, 500, { ok: false, error: err?.message || "Could not start a new conversation." });
          return;
        }
        json(res, 200, { ok: true });
        return;
      }
      // Everything spawned so far belongs to the old conversation: its late
      // stdout must not re-save the session id it is still printing.
      resetGen = turnGen;
      stopClaude(
        chromeEnabled()
          ? "New conversation. The Chrome group stays with this desk."
          : "New conversation. Your job-search files stay in this workspace.",
      );
      sessionId = null;
      transcript.length = 0;
      saveTranscript();
      turnText = "";
      clearDeskSession(workspace);
      send("session", { sessionId: null, chromeGroup: snapshot().chromeGroup });
      send("reset", {});
      // A stopped turn sends its own idle from the close handler; an eager
      // idle here would re-enable Send while the old child still holds busy.
      if (!busy) send("idle", snapshot());
      json(res, 200, { ok: true });
      return;
    }

    let file = url.pathname === "/" ? "/index.html" : url.pathname;
    if (file.includes("..")) {
      res.writeHead(400).end();
      return;
    }

    try {
      const path = join(PUBLIC, file.slice(1));
      const data = await readFile(path);
      res.writeHead(200, { "Content-Type": MIME[extname(path)] || "application/octet-stream" });
      res.end(data);
    } catch {
      res.writeHead(404).end("not found");
    }
}

function openBrowser(href) {
  openInChrome(href);
}

// One set of process handlers for the life of the process; a folder switch
// only re-points them at the current desk.
let currentStop = null;
let handlersInstalled = false;
function installProcessHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;
  const onSignal = () => currentStop?.(true);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  // Closing the terminal window sends SIGHUP; the startup text promises that
  // stops Claude, and a detached child would otherwise keep editing files.
  process.on("SIGHUP", onSignal);
  process.on("exit", () => {
    const target = child;
    stopClaude("Desk closed");
    forceKill(target);
    stopHelper();
    flushTranscript();
  });
}

// 8765 first, then the next nine ports; JOB_SEARCH_GUI_PORT overrides, 0 asks
// the OS for a free one.
async function bindDeskPort(server, port) {
  const preferred = port ?? Number(process.env.JOB_SEARCH_GUI_PORT || PORT);
  if (preferred === 0) {
    await listen(server, HOST, 0);
    return server.address().port;
  }
  for (let offset = 0; offset < 10; offset += 1) {
    const candidate = preferred + offset;
    try {
      await listen(server, HOST, candidate);
      return candidate;
    } catch (err) {
      if (err.code !== "EADDRINUSE" || offset === 9) throw err;
    }
  }
  return preferred;
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.listen(port, host, onListening);
  });
}

export async function startDesk(options = {}) {
  demoMode = Boolean(options.demo || isDemoFlag(process.env, process.argv));
  if (demoMode) {
    process.env.JOB_SEARCH_DEMO = "1";
    workspace = prepareDemoWorkspace({ root: options.demoRoot || process.env.JOB_SEARCH_DEMO_ROOT || "" });
  } else {
    workspace = resolveWorkspace({
      explicit: options.root || "",
      here: join(HERE, ".."),
    });
    if (!workspace) {
      throw new Error(existingWorkspaceHint());
    }
    if (options.remember !== false) rememberWorkspace(workspace);
  }
  // A previous desk in this process (a folder switch) may still own a Claude
  // turn or a sign-in helper. Stop them and mark the turn superseded: its
  // close handler then releases busy without writing into the new folder,
  // and the SIGKILL escalation still finds its child.
  stopClaude("Switching folders");
  stopHelper();
  resetGen = turnGen;
  sessionId = loadDeskSession(workspace);
  streamedText = false;
  sawInit = false;
  turnText = "";
  loadTranscript();
  const open = options.openBrowser ?? process.env.JOB_SEARCH_GUI_NO_BROWSER !== "1";
  const server = createDeskServer();
  // Bind first: the runtime spawns Claude when it starts, and that child only
  // sees JOB_SEARCH_DESK_REVIEW_URL if the port is known before the spawn.
  const bound = await bindDeskPort(server, options.port);
  boundPort = bound;
  process.env.JOB_SEARCH_DESK_REVIEW_URL = `http://${HOST}:${bound}/autofill`;
  let runtime = options.runtime || null;
  if (!runtime && options.runtimeFactory) {
    try {
      runtime = await options.runtimeFactory({ workspace });
      runtimeError = "";
    } catch (error) {
      if (!options.allowRuntimeFailure) {
        server.close();
        throw error;
      }
      runtime = null;
      runtimeError = error?.message || String(error);
      console.error(`Desk runtime failed to start; using print mode instead: ${runtimeError}`);
    }
  }
  deskRuntime = runtime;
  deskAutofill = options.autofill || runtime?.autofillBridge || createAutofillBridge();
  deskArtifacts = options.artifacts || runtime?.artifactService || createArtifactService({ workspace, openImpl: systemOpener });
  toolsCache = null;
  let transport = null;

  const stop = (exitProcess = false) => {
    const target = child;
    clearDemoReplay();
    stopClaude("Desk closed");
    stopHelper();
    // Keep whatever Claude had said so far; the restart note follows it.
    flushTurnText();
    flushTranscript();
    runtime?.stop?.();
    transport?.close?.();
    // Drop open event streams so a closed desk does not wait on a browser tab.
    server.closeAllConnections?.();
    server.close(() => {
      if (exitProcess && !target) process.exit(0);
    });
    if (exitProcess) {
      // Leave only once Claude is really gone: SIGTERM first, SIGKILL if it
      // is still there after the grace period, then exit.
      const bound = setTimeout(() => {
        forceKill(target);
        process.exit(0);
      }, target ? KILL_GRACE_MS : 500);
      bound.unref();
      target?.once?.("close", () => {
        clearTimeout(bound);
        process.exit(0);
      });
    }
  };

  currentStop = stop;
  installProcessHandlers();

  if (runtime) {
    transport = attachWebSocketTransport({
      server,
      runtime,
      hostAllowed,
      originAllowed,
    });
  }
  const href = `http://${HOST}:${bound}/`;
  console.log(`Job search desk: ${href}`);
  if (demoMode) {
    console.log(`Workspace: ${DEMO_LABEL}`);
    console.log("Demo mode. Jobs, CVs, and the profile on this page are fictional.");
    console.log("Your saved job-search folder is not in use and was not changed.");
  } else {
    console.log(`Workspace: ${workspace}`);
    console.log("Same folder as node gui/server.mjs --cli. Scrapes, CVs, and applications stay here.");
  }
  console.log(
    demoMode
      ? "Demo mode does not start Claude Code. Chat replays a fixed turn."
      : runtime
        ? "Claude Code runs locally. The page header shows whether it asks before acting."
        : "Claude Code runs locally with --dangerously-skip-permissions.",
  );
  console.log("Localhost only. Close this window to stop.");
  if (open) openBrowser(href);
  return {
    href,
    server,
    workspace,
    displayWorkspace: publicWorkspace(),
    demo: demoMode,
    stop,
    port: bound,
    runtime,
    transport,
    artifacts: deskArtifacts,
    autofill: deskAutofill,
    controllers: runtime?.controllers ?? null,
  };
}

const launchedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (launchedDirectly) {
  if (isDemoFlag()) {
    if (process.argv.includes("--cli")) {
      console.error("Demo mode is the page. Use npm run dev:demo, not --cli.");
      process.exit(1);
    }
    startBrowserDesk({ demo: true }).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  } else {
    const root = resolveWorkspace({ here: join(HERE, "..") });
    if (!root) {
      console.error(existingWorkspaceHint());
      process.exit(1);
    }
    rememberWorkspace(root);
    if (process.argv.includes("--cli")) {
      const started = startCli(root, { inherit: true });
      if (started.error) {
        console.error(started.error);
        process.exit(1);
      }
      started.child.on("exit", (code) => process.exit(code ?? 0));
    } else {
      startBrowserDesk({ root }).catch((err) => {
        console.error(err);
        process.exit(1);
      });
    }
  }
}

// `node gui/server.mjs` gets the same Agent SDK runtime as the installed app
// (Files tab, Needs-you cards, permission modes, persisted conversation).
// Print mode stays the fallback when the SDK is not installed under gui/.
export async function startBrowserDesk(options = {}) {
  const root = typeof options === "string" ? options : options.root;
  const demo = typeof options === "string" ? false : Boolean(options.demo);
  let runtimeFactory;
  // Demo chat is a fixed replay. Starting the Agent SDK here would spend a
  // real Claude turn and ask for permission on camera.
  if (!demo) {
    try {
      const session = await import("./desk-session.mjs");
      runtimeFactory = session.createDeskRuntimeFactory();
    } catch (error) {
      console.error(`Desk runtime unavailable (run npm ci in gui/); using print mode: ${error?.message || error}`);
    }
  }
  return startDesk({
    root,
    demo,
    demoRoot: options.demoRoot,
    ...(options.port != null ? { port: options.port } : {}),
    allowRuntimeFailure: true,
    runtimeFactory,
  });
}
