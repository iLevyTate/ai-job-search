import { randomUUID } from "node:crypto";
import { createAgentSdkAdapter } from "./agent-sdk-adapter.mjs";
import { createAutofillBridge } from "./autofill-bridge.mjs";
import { normalizeSdkMessage } from "./event-protocol.mjs";
import { createInteractionBroker } from "./interaction-broker.mjs";
import { normalizeDeskPermissionMode } from "./permission-policy.mjs";
import { classifyRuntimeFailure, interruptWithFallback, shouldResumeRuntime } from "./runtime-recovery.mjs";

function commandResult(ok, extra = {}) {
  return ok ? { ok: true, ...extra } : { ok: false, ...extra };
}

export function createSessionRuntime({
  workspace,
  conversationId,
  store,
  adapterFactory = createAgentSdkAdapter,
  normalize = normalizeSdkMessage,
  recoveryPolicy = { classify: classifyRuntimeFailure, shouldResume: shouldResumeRuntime, interrupt: interruptWithFallback },
  brokerFactory = createInteractionBroker,
  permissionPolicy = null,
  artifactService = null,
  autofillBridge = createAutofillBridge(),
  maxQueuedMessages = 8,
  interruptGraceMs = 3000,
  interactionTimeoutMs = 5 * 60 * 1000,
  handoffTimeoutMs = 0,
} = {}) {
  const subscribers = new Set();
  const broker = brokerFactory({
    timeoutMs: interactionTimeoutMs,
    getControllerGeneration: () => conversation()?.controllerGeneration ?? 1,
  });
  let adapter = null;
  let epoch = 0;
  let started = false;
  let pumping = null;
  let pendingHandoff = null;
  let stopRequested = false;
  // True when the SDK stream ended and no replacement could be started; sends
  // are refused with "closed" so the page can say so instead of hanging.
  let adapterDead = false;
  // Messages accepted while a turn was still running. Each becomes its own
  // turn when Claude reaches it, so its reply gets its own card and its
  // artifacts settle against the snapshot taken when it was submitted.
  const pendingTurns = [];

  function conversation() {
    return store.get(conversationId);
  }

  function requireGeneration(expected) {
    const current = conversation();
    if (expected != null && expected !== current.controllerGeneration) {
      return commandResult(false, { reason: "stale-controller" });
    }
    if (pendingHandoff) return commandResult(false, { reason: "handoff-in-progress" });
    return null;
  }

  function currentPermissionMode() {
    return permissionPolicy?.get() ?? conversation()?.permissionMode ?? "safe";
  }

  function snapshot() {
    const current = conversation();
    return {
      conversationId,
      workspace,
      sessionId: current?.claudeSessionId ?? null,
      controller: current?.controller ?? "chat",
      controllerGeneration: current?.controllerGeneration ?? 1,
      permissionMode: currentPermissionMode(),
      busy: Boolean(current?.partialTurn),
      pendingHandoff: pendingHandoff ? { handoffId: pendingHandoff.handoffId, target: pendingHandoff.target } : null,
    };
  }

  function eventContext() {
    const current = conversation();
    return {
      conversationId,
      turnId: current?.partialTurn?.id ?? null,
      nextSequence: () => current.nextSequence,
      now: () => new Date().toISOString(),
      createId: () => randomUUID(),
    };
  }

  const TURN_BEARING = new Set(["assistant", "stream_event", "user"]);

  async function ensureTurnFor(sdkMessage) {
    if (conversation()?.partialTurn || !TURN_BEARING.has(sdkMessage?.type)) return;
    const id = pendingTurns.shift() ?? randomUUID();
    await store.transact(conversationId, (next) => {
      next.partialTurn = { id, eventId: id };
    });
  }

  async function publishSdkMessage(sdkMessage, currentEpoch) {
    if (currentEpoch !== epoch) return;
    await ensureTurnFor(sdkMessage);
    if (currentEpoch !== epoch) return;
    const drafts = normalize(sdkMessage, eventContext());
    for (const draft of drafts) {
      if (currentEpoch !== epoch) return;
      const persisted = await store.appendEvent(conversationId, draft);
      if ((persisted.type === "turn.completed" || persisted.type === "turn.failed") && artifactService) {
        const found = await artifactService.settleTurn(persisted.turnId || conversation()?.partialTurn?.id);
        if (found.length) {
          await store.transact(conversationId, (next) => {
            next.artifacts.push(...found.map((item) => ({
              id: item.id,
              turnId: item.turnId,
              relativePath: item.relativePath,
              kind: item.kind,
              mime: item.mime,
              size: item.size,
            })));
          });
          for (const item of found) {
            const artifactEvent = await store.appendEvent(conversationId, {
              type: "artifact.discovered",
              payload: {
                artifactId: item.id,
                entityId: item.id,
                relativePath: item.relativePath,
                kind: item.kind,
                mime: item.mime,
                turnId: item.turnId,
              },
            });
            for (const listener of subscribers) listener(artifactEvent);
          }
        }
      }
      if (persisted.type === "question.requested") {
        broker.beginQuestion?.({
          requestId: persisted.payload.toolUseId,
          questions: persisted.payload.questions ?? [],
        });
      }
      for (const listener of subscribers) listener(persisted);
    }
  }

  async function pump(currentAdapter, currentEpoch) {
    let failure = null;
    try {
      for await (const sdkMessage of currentAdapter.messages()) {
        await publishSdkMessage(sdkMessage, currentEpoch);
      }
    } catch (error) {
      failure = error;
    }
    // A pump superseded by reset, stop, or a forced interrupt has nothing to
    // clean up; its replacement owns the conversation now.
    if (currentEpoch !== epoch || adapter !== currentAdapter) return;
    const current = conversation();
    const wasStop = stopRequested;
    stopRequested = false;
    const classification = recoveryPolicy.classify(failure ?? new Error("stream ended"), { stopRequested: wasStop });
    // The stream is gone. Whatever turn was open can never finish on its own,
    // so end it visibly instead of leaving the page on "Working" forever.
    if (current?.partialTurn) {
      const reason = failure ? String(failure.message || failure) : "";
      const text = wasStop
        ? "Stopped."
        : reason
          ? `Claude stopped unexpectedly (${reason}). Send your message again.`
          : "Claude stopped unexpectedly. Send your message again.";
      await publishEvent({ type: wasStop ? "turn.interrupted" : "turn.failed", payload: { text, reason: classification } }).catch(() => {});
    }
    const attempts = current?.recoveryAttempts ?? 0;
    const resumable = recoveryPolicy.shouldResume({
      classification,
      sessionId: current?.claudeSessionId,
      recoveryAttempts: attempts,
      controller: current?.controller,
    });
    // One restart for a crash or a clean end; a sign-in or install failure
    // would only loop, so it stays down until the person starts a new chat.
    const authFailure = classification === "fatal" && /authentication|not installed|login|unauthorized/i.test(String(failure?.message || ""));
    if ((resumable || (!authFailure && attempts === 0)) && (current?.controller ?? "chat") === "chat") {
      await store.transact(conversationId, (next) => {
        next.recoveryAttempts += 1;
      });
      try {
        await startAdapter();
        return;
      } catch {
        // Fall through: the adapter is dead and sends are refused below.
      }
    }
    adapterDead = true;
    await publishEvent({
      type: "session.status",
      payload: { phase: "stopped", detail: failure ? String(failure.message || failure) : "" },
    }).catch(() => {});
  }

  async function startAdapter() {
    const current = conversation();
    adapterDead = false;
    adapter = adapterFactory({
      cwd: workspace,
      sessionId: current?.claudeSessionId,
      permissionMode: permissionPolicy?.get() ?? current?.permissionMode ?? "safe",
      onPermissionRequest: (request) => handlePermissionRequest(request),
    });
    await adapter.start();
    const currentEpoch = epoch;
    // pump recovers by re-entering startAdapter; if that restart rejects, the
    // orphaned promise would be an unhandled rejection and kill the process.
    pumping = pump(adapter, currentEpoch).catch(() => {});
  }

  function clearHandoffTimer() {
    if (pendingHandoff?.timer) clearTimeout(pendingHandoff.timer);
  }

  async function beginHandoff(target, expectedControllerGeneration, extra = {}) {
    const stale = requireGeneration(expectedControllerGeneration);
    if (stale && stale.reason === "stale-controller") return stale;
    if (pendingHandoff) return commandResult(false, { reason: "handoff-in-progress" });
    const current = conversation();
    const nextGeneration = current.controllerGeneration + 1;
    const timeoutMs = extra.timeoutMs ?? handoffTimeoutMs;
    const { timeoutMs: _ignored, ...rest } = extra;
    pendingHandoff = {
      handoffId: randomUUID(),
      target,
      from: current.controller,
      nextGeneration,
      ...rest,
    };
    if (timeoutMs > 0) {
      const handoffId = pendingHandoff.handoffId;
      pendingHandoff.timer = setTimeout(() => {
        if (pendingHandoff?.handoffId === handoffId) pendingHandoff = null;
      }, timeoutMs);
    }
    return commandResult(true, {
      handoffId: pendingHandoff.handoffId,
      conversationId,
      nextGeneration,
      workspace,
      sessionId: current.claudeSessionId,
      permissionMode: currentPermissionMode(),
    });
  }

  async function commitHandoff(handoffId, controller, extra = {}) {
    if (!pendingHandoff || pendingHandoff.handoffId !== handoffId) {
      return commandResult(false, { reason: "unknown-handoff" });
    }
    const { nextGeneration, target } = pendingHandoff;
    if (controller !== target) return commandResult(false, { reason: "handoff-mismatch" });
    clearHandoffTimer();
    await store.transact(conversationId, (next) => {
      next.controller = controller;
      next.controllerGeneration = nextGeneration;
      Object.assign(next, extra);
    });
    pendingHandoff = null;
    return commandResult(true, snapshot());
  }

  async function publishEvent(draft) {
    const persisted = await store.appendEvent(conversationId, draft);
    for (const listener of subscribers) listener(persisted);
    return persisted;
  }
  const publishAutofillEvent = publishEvent;

  // Everything Claude needs from the person arrives through the SDK's
  // canUseTool callback: tool approvals in Safe mode, and AskUserQuestion in
  // every mode (the SDK routes it to the callback even under bypass). The page
  // only sees what is published here, so each request becomes an event, and
  // the answer travels back as the callback's return value.
  function handlePermissionRequest(request = {}) {
    const requestId = request.requestId || request.toolUseId;
    if (!requestId) return Promise.resolve({ behavior: "deny", message: "Permission request had no id" });
    if (request.toolName === "AskUserQuestion") {
      const questions = Array.isArray(request.input?.questions) ? request.input.questions : [];
      const pending = broker.beginQuestion({ requestId, toolUseId: request.toolUseId, questions, signal: request.signal });
      publishEvent({
        type: "question.requested",
        payload: { entityId: requestId, requestId, toolUseId: request.toolUseId, questions },
      }).catch(() => {});
      return Promise.resolve(pending).then((result) => {
        const answered = result && !result.cancelled && result.answers && Object.keys(result.answers).length > 0;
        publishEvent({
          type: "question.resolved",
          payload: { entityId: requestId, requestId, toolUseId: request.toolUseId, answered: Boolean(answered), reason: result?.reason },
        }).catch(() => {});
        if (!answered) {
          return { behavior: "deny", message: result?.reason === "timeout" ? "The user did not answer in time." : "The user did not answer." };
        }
        const answers = Object.fromEntries(Object.entries(result.answers).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value]));
        return { behavior: "allow", updatedInput: { ...(request.input || {}), questions, answers } };
      });
    }
    const pending = broker.beginPermission({ ...request, requestId });
    publishEvent({
      type: "permission.requested",
      payload: {
        entityId: requestId,
        requestId,
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        input: request.input ?? {},
        suggestions: Array.isArray(request.suggestions) ? request.suggestions : [],
        title: request.title,
        description: request.description,
        displayName: request.displayName,
        decisionReason: request.decisionReason,
      },
    }).catch(() => {});
    return Promise.resolve(pending).then((result) => {
      publishEvent({
        type: "permission.resolved",
        payload: {
          entityId: requestId,
          requestId,
          toolUseId: request.toolUseId,
          name: request.toolName,
          decision: result?.behavior === "allow" ? "allow" : "deny",
          reason: /timed out/i.test(String(result?.message || "")) ? "timeout" : undefined,
        },
      }).catch(() => {});
      return result;
    });
  }

  async function closeOpenTurn(reason) {
    const current = conversation();
    if (!current?.partialTurn) return;
    await publishEvent({ type: "turn.interrupted", payload: { reason } });
  }

  const api = {
    async start() {
      if (started) return snapshot();
      started = true;
      if (!conversation()) await store.load();
      if (!conversation()) throw new Error(`Unknown conversation ${conversationId}`);
      autofillBridge.cancelOrphaned();
      // A turn left open when the app last closed would glue the next reply
      // onto the old half-reply; nothing can finish it, so close it now.
      await closeOpenTurn("app-restarted");
      await startAdapter();
      return snapshot();
    },
    snapshot,
    eventsAfter(sequence) {
      return store.eventsAfter(conversationId, sequence);
    },
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    async submitMessage({ messageId, text, expectedControllerGeneration }) {
      const blocked = requireGeneration(expectedControllerGeneration);
      if (blocked) return blocked;
      if (conversation().controller !== "chat") {
        return commandResult(false, { reason: "wrong-controller" });
      }
      if (adapterDead || !adapter) return commandResult(false, { reason: "closed" });
      // A Stop from an earlier turn must not colour how this turn's failures
      // are classified.
      stopRequested = false;
      const accepted = adapter.send({ id: messageId, text });
      if (!accepted.accepted) return commandResult(false, { reason: accepted.reason });
      if (artifactService) await artifactService.beginTurn(messageId);
      if (conversation().partialTurn) {
        pendingTurns.push(messageId);
      } else {
        await store.transact(conversationId, (next) => {
          next.partialTurn = { id: messageId, eventId: messageId };
        });
      }
      // The page paints "You" from this event alone (it keeps no local copy),
      // and a reload replays it with the rest of the conversation.
      const persisted = await store.appendEvent(conversationId, {
        type: "user.message",
        turnId: messageId,
        payload: { messageId, text },
      });
      for (const listener of subscribers) listener(persisted);
      return commandResult(true, { messageId });
    },
    async resolvePermission({ requestId, decision, update, reason, expectedControllerGeneration } = {}) {
      const blocked = requireGeneration(expectedControllerGeneration);
      if (blocked) return blocked;
      const result = broker.resolvePermission?.({
        requestId,
        decision,
        update,
        reason,
        expectedControllerGeneration,
      }) ?? commandResult(true, { requestId });
      if (!result.ok) return result;
      adapter.settlePermission?.(requestId, result.result ?? { behavior: "deny", message: "Permission denied" });
      return commandResult(true, { requestId });
    },
    async respondToQuestion({ requestId, value, answers, expectedControllerGeneration } = {}) {
      const blocked = requireGeneration(expectedControllerGeneration);
      if (blocked) return blocked;
      const result = broker.respondToQuestion?.({
        requestId,
        answers: answers ?? (value && typeof value === "object" ? value.answers ?? value : value),
        expectedControllerGeneration,
      });
      if (result && !result.ok) return result;
      return commandResult(true, { requestId });
    },
    async setPermissionMode({ mode, expectedControllerGeneration } = {}) {
      const blocked = requireGeneration(expectedControllerGeneration);
      if (blocked) return blocked;
      const next = normalizeDeskPermissionMode(mode);
      if (permissionPolicy) await permissionPolicy.set(next);
      await store.transact(conversationId, (current) => {
        current.permissionMode = next;
      });
      await adapter.setPermissionMode?.(next);
      return commandResult(true, snapshot());
    },
    async interrupt({ expectedControllerGeneration } = {}) {
      const blocked = requireGeneration(expectedControllerGeneration);
      if (blocked) return blocked;
      stopRequested = true;
      const result = await recoveryPolicy.interrupt({
        session: adapter,
        graceMs: interruptGraceMs,
      });
      if (result?.outcome === "force-closed") {
        // The SDK session is gone: end the turn the page is watching and bring
        // up a fresh adapter on the same Claude session so the next message works.
        epoch += 1;
        pendingTurns.length = 0;
        await closeOpenTurn("stopped");
        stopRequested = false;
        try {
          await startAdapter();
        } catch {
          // The next submitMessage surfaces the failure.
        }
      }
      return commandResult(true, result);
    },
    beginTerminalHandoff({ expectedControllerGeneration, timeoutMs } = {}) {
      return beginHandoff("terminal", expectedControllerGeneration, { timeoutMs });
    },
    commitTerminalHandoff({ handoffId, terminalId } = {}) {
      return commitHandoff(handoffId, "terminal", { terminalId });
    },
    async rollbackTerminalHandoff({ handoffId } = {}) {
      if (!pendingHandoff || pendingHandoff.handoffId !== handoffId) {
        return commandResult(false, { reason: "unknown-handoff" });
      }
      clearHandoffTimer();
      pendingHandoff = null;
      return commandResult(true, snapshot());
    },
    beginChatHandoff({ expectedControllerGeneration, terminalId, timeoutMs } = {}) {
      return beginHandoff("chat", expectedControllerGeneration, { terminalId, timeoutMs });
    },
    commitChatHandoff({ handoffId } = {}) {
      return commitHandoff(handoffId, "chat");
    },
    submitTerminalInput({ text, expectedControllerGeneration } = {}) {
      const blocked = requireGeneration(expectedControllerGeneration);
      if (blocked) return blocked;
      if (conversation().controller !== "terminal") {
        return commandResult(false, { reason: "wrong-controller" });
      }
      if (typeof text !== "string") return commandResult(false, { reason: "malformed" });
      return commandResult(true, { accepted: true });
    },
    startAutofillReview() {
      return autofillBridge.start();
    },
    async markAutofillReady({ token, url, screenshot } = {}) {
      const ready = autofillBridge.markReady({ token, url, screenshot });
      if (!ready.ok) return ready;
      const persisted = await publishAutofillEvent({
        type: "autofill.review",
        payload: ready.event.payload,
      });
      return commandResult(true, { ...ready, event: persisted });
    },
    async decideAutofill({ reviewId, token, decision, expectedControllerGeneration } = {}) {
      const blocked = requireGeneration(expectedControllerGeneration);
      if (blocked) return blocked;
      const result = autofillBridge.decide({
        reviewId,
        token,
        decision,
        expectedControllerGeneration,
        currentGeneration: conversation()?.controllerGeneration,
      });
      if (!result.ok) return result;
      if (!result.idempotent) {
        await publishAutofillEvent({
          type: "autofill.resolved",
          payload: { reviewId, entityId: reviewId, decision: result.decision },
        });
      }
      return result;
    },
    pollAutofillDecision({ token } = {}) {
      return autofillBridge.pollDecision({ token });
    },
    async reset({ expectedControllerGeneration } = {}) {
      const blocked = requireGeneration(expectedControllerGeneration);
      if (blocked) return blocked;
      epoch += 1;
      pendingTurns.length = 0;
      broker.abortAll?.("conversation-reset");
      await store.transact(conversationId, (next) => {
        next.partialTurn = null;
        next.queue = [];
        // Drop the event log too: the client resets its cursor to 0, so keeping
        // events would replay the whole "cleared" conversation on next hello.
        next.events = [];
        next.nextSequence = 1;
        next.controllerGeneration += 1;
        // A new conversation gets a new Claude session.
        next.claudeSessionId = null;
        next.recoveryAttempts = 0;
      });
      // The running pump was started under the old epoch and would drop every
      // reply from now on; replace the adapter so a new pump runs.
      const previous = adapter;
      stopRequested = false;
      try {
        await startAdapter();
      } catch {
        // The next submitMessage surfaces the failure.
      }
      previous?.close?.();
      return commandResult(true, { snapshot: snapshot() });
    },
    disconnectInteractions() {
      return broker.disconnect?.() ?? 0;
    },
    async stop() {
      stopRequested = true;
      epoch += 1;
      broker.abortAll?.("runtime-stopped");
      autofillBridge.cancelOrphaned();
      adapter?.close?.();
      clearHandoffTimer();
      pendingHandoff = null;
      started = false;
      await pumping?.catch(() => {});
    },
  };
  api.controllers = {
    beginTerminalHandoff: (request) => api.beginTerminalHandoff(request),
    commitTerminalHandoff: (request) => api.commitTerminalHandoff(request),
    rollbackTerminalHandoff: (request) => api.rollbackTerminalHandoff(request),
    beginChatHandoff: (request) => api.beginChatHandoff(request),
    commitChatHandoff: (request) => api.commitChatHandoff(request),
  };
  return api;
}
