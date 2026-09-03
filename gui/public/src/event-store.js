export function createDeskState(seed = {}) {
  return {
    lastSequence: seed.lastSequence ?? 0,
    cards: new Map(),
    queued: [],
    permissionMode: seed.permissionMode ?? "safe",
    controller: seed.controller ?? "chat",
    controllerGeneration: seed.controllerGeneration ?? 1,
    conversationId: seed.conversationId ?? null,
    sessionId: seed.sessionId ?? null,
    busy: Boolean(seed.busy),
    // True between Claude opening a thinking block and the first visible
    // output (text or a tool call). The chat shows "Thinking" while it holds.
    thinking: false,
    // Reply text is split into a new card after every tool call, question, or
    // permission prompt, so an answer that follows a file read lands below
    // the tool chip instead of being appended to the text above it.
    segment: 0,
    // The turn the reply cards currently belong to; a new turn id starts
    // segment numbering again.
    activeTurnId: null,
    pendingQuestionId: null,
    pendingPermissionId: null,
  };
}

// Events that never become a chat card. Before this list existed each of them
// (thinking blocks, usage, hook activity, session status) painted an empty
// card labelled "Stopped" in the conversation.
const QUIET_TYPES = new Set([
  "assistant.thinking",
  "diagnostic.unknown_sdk_event",
  "usage",
  "hook.activity",
  "mcp.status",
  "session.status",
  "turn.interrupted",
]);

// Events that only ever update a card that already exists.
const MERGE_ONLY_TYPES = new Set(["permission.resolved", "question.resolved", "autofill.resolved", "tool.completed"]);

const TURN_END_TYPES = new Set(["turn.completed", "turn.failed", "turn.interrupted"]);

export function cardIdFor(event, segment = 0) {
  const payload = event?.payload ?? {};
  if (payload.entityId) return payload.entityId;
  if (payload.toolUseId) return payload.toolUseId;
  if (payload.requestId) return payload.requestId;
  if (payload.messageId) return payload.messageId;
  if (event?.type === "assistant.delta" || event?.type === "assistant.message" || event?.type === "turn.completed") {
    return `assistant:${event.turnId || "current"}${segment ? `:${segment}` : ""}`;
  }
  if (event?.type === "subagent.activity") {
    return `subagent:${payload.parentToolUseId || event.turnId || "current"}`;
  }
  return event?.eventId;
}

function toRenderableCard(event, id) {
  const type = event.type === "assistant.delta" || event.type === "turn.completed" ? "assistant.message" : event.type;
  return {
    id,
    type,
    payload: { ...event.payload },
    entered: false,
  };
}

function mergeCard(existing, event) {
  const next = { ...existing, payload: { ...existing.payload, ...event.payload } };
  // A completion carries no input; keep the file name the start announced.
  if (event.payload?.input && !Object.keys(event.payload.input).length && existing.payload.input && Object.keys(existing.payload.input).length) {
    next.payload.input = existing.payload.input;
  }
  if (event.type === "question.requested" || event.type === "permission.requested") {
    // A request announced after a plain tool chip for the same id (older
    // producers) becomes the form, not a chip labelled "Using AskUserQuestion".
    next.type = event.type;
    next.entered = false;
    return next;
  }
  if (event.type === "tool.completed" && (existing.type.startsWith("question") || existing.type.startsWith("permission"))) {
    // The tool result for an answered question closes the form; it stays a form.
    next.entered = true;
    return next;
  }
  if (event.type === "assistant.delta") {
    next.type = "assistant.message";
    next.payload.text = `${existing.payload.text || ""}${event.payload?.text || ""}`;
  }
  if (event.type === "assistant.message") {
    // A whole message after streamed deltas restates text the card already
    // holds; genuinely new text extends the card.
    const incoming = event.payload?.text || "";
    const current = existing.payload.text || "";
    next.type = "assistant.message";
    if (current.includes(incoming)) next.payload.text = current;
    else if (incoming.includes(current)) next.payload.text = incoming;
    else next.payload.text = `${current}\n\n${incoming}`;
  }
  if (event.type === "turn.completed") {
    // The result restates what was streamed; keep the streamed text unless
    // nothing was streamed at all (print mode without partial output).
    next.type = "assistant.message";
    next.payload.text = existing.payload.text || event.payload?.text || "";
  }
  if (event.type === "subagent.activity") {
    const incoming = event.payload?.text || "";
    next.payload.text = incoming ? `${existing.payload.text || ""}${existing.payload.text ? "\n\n" : ""}${incoming}` : existing.payload.text || "";
  }
  if (event.type === "tool.completed") {
    next.type = "tool.completed";
    next.payload.phase = "completed";
  }
  if (event.type === "permission.resolved" || event.type === "autofill.resolved") {
    next.entered = true;
    next.payload.decision = event.payload?.decision;
  }
  if (event.type === "question.resolved") {
    next.entered = true;
    next.payload.answered = event.payload?.answered !== false;
    next.payload.reason = event.payload?.reason;
  }
  return next;
}

// Text streamed before a tool call lives in the previous segment's card; the
// full assistant message that follows the tool block restates it and must not
// open a second card in the new segment.
function restatesEarlierSegment(cards, event, segment) {
  if (event.type !== "assistant.message" || segment === 0) return false;
  const incoming = (event.payload?.text || "").trim();
  if (!incoming) return true;
  for (let index = segment - 1; index >= 0; index -= 1) {
    const earlier = cards.get(cardIdFor(event, index));
    if (earlier?.payload?.text && earlier.payload.text.includes(incoming)) return true;
  }
  return false;
}

export function reduceDeskEvent(state, event) {
  if (!event) return state;
  // Local events (a queued follow-up, a connection error) are not part of the
  // server's numbered stream: they never advance the replay cursor, so they
  // cannot shadow the server's next event and get it dropped as a replay.
  const local = event.local === true;
  if (!local && (typeof event.sequence !== "number" || event.sequence <= state.lastSequence)) {
    return state;
  }
  const next = structuredClone(state);
  if (!local) next.lastSequence = event.sequence;

  if (event.type === "user.queued") {
    next.queued.push({
      id: event.payload?.messageId || event.eventId,
      text: event.payload?.text || "",
    });
    return next;
  }

  if (typeof event.payload?.permissionMode === "string") {
    next.permissionMode = event.payload.permissionMode;
  }
  if (typeof event.payload?.sessionId === "string" && event.payload.sessionId) {
    next.sessionId = event.payload.sessionId;
  }
  if (event.type === "session.status" && event.payload?.controller) {
    next.controller = event.payload.controller;
  }
  if (TURN_END_TYPES.has(event.type)) {
    next.busy = false;
    next.thinking = false;
    next.pendingQuestionId = null;
    next.pendingPermissionId = null;
    if (event.type === "turn.failed" || event.type === "turn.interrupted") {
      for (const card of next.cards.values()) {
        if (card.type === "tool.started") {
          card.type = "tool.completed";
          card.payload.phase = "completed";
        }
      }
    }
  }
  if (event.type === "assistant.thinking") {
    next.busy = true;
    next.thinking = true;
  }
  if (event.type === "user.message" || event.type === "assistant.delta" || event.type === "assistant.message" || event.type === "tool.started") {
    next.busy = true;
    next.thinking = false;
    if (event.payload?.messageId) {
      next.queued = next.queued.filter((item) => item.id !== event.payload.messageId);
    }
  }
  // A queued follow-up's user.message arrives while the current reply still
  // streams, so the segment counter follows the turn id, not user messages.
  if ((event.type === "assistant.delta" || event.type === "assistant.message" || event.type === "tool.started" || event.type === "question.requested" || event.type === "permission.requested" || event.type === "turn.completed") && event.turnId && event.turnId !== next.activeTurnId) {
    next.activeTurnId = event.turnId;
    next.segment = 0;
  }

  if (event.type === "question.resolved" && next.pendingQuestionId === cardIdFor(event)) next.pendingQuestionId = null;
  if (event.type === "permission.resolved" && next.pendingPermissionId === cardIdFor(event)) next.pendingPermissionId = null;

  if (QUIET_TYPES.has(event.type)) return next;
  if (event.type === "turn.completed" && !(event.payload?.text || "").trim() && !next.cards.has(cardIdFor(event, next.segment))) {
    return next;
  }

  const id = cardIdFor(event, next.segment);
  if (!id) return next;
  const existing = next.cards.get(id);
  if (!existing && MERGE_ONLY_TYPES.has(event.type)) return next;
  if (!existing && restatesEarlierSegment(next.cards, event, next.segment)) return next;
  if (!existing && (event.type === "tool.started" || event.type === "question.requested" || event.type === "permission.requested")) {
    next.segment += 1;
  }
  const card = existing ? mergeCard(existing, event) : toRenderableCard(event, id);
  if (event.type === "question.requested") {
    card.entered = false;
    // A read-only question (print mode) cannot be answered in place, so it
    // must not switch the page into "waiting for you".
    if (!card.payload.readOnly) next.pendingQuestionId = id;
  }
  if (event.type === "permission.requested") {
    card.entered = false;
    next.pendingPermissionId = id;
  }
  next.cards.set(id, card);
  return next;
}

export function markEntered(state, entityId) {
  if (!state.cards.has(entityId)) return state;
  const next = structuredClone(state);
  const card = next.cards.get(entityId);
  card.entered = true;
  if (next.pendingQuestionId === entityId) next.pendingQuestionId = null;
  if (next.pendingPermissionId === entityId) next.pendingPermissionId = null;
  return next;
}

export function applySnapshot(state, snapshot = {}) {
  const next = structuredClone(state);
  if (snapshot.permissionMode) next.permissionMode = snapshot.permissionMode;
  if (snapshot.controller) next.controller = snapshot.controller;
  if (snapshot.controllerGeneration != null) next.controllerGeneration = snapshot.controllerGeneration;
  if (snapshot.conversationId) next.conversationId = snapshot.conversationId;
  if ("sessionId" in snapshot) next.sessionId = snapshot.sessionId ?? null;
  if (snapshot.busy != null) {
    next.busy = Boolean(snapshot.busy);
    if (!next.busy) next.thinking = false;
  }
  return next;
}

export function queueFollowUp(state, { messageId, text }) {
  return reduceDeskEvent(state, {
    eventId: messageId,
    sequence: state.lastSequence + 1,
    local: true,
    type: "user.queued",
    payload: { messageId, text },
  });
}
