import { WebSocketServer } from "ws";
import { DESK_PROTOCOL_VERSION, validateClientMessage } from "./event-protocol.mjs";

function send(socket, payload) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

export function attachWebSocketTransport({
  server,
  runtime,
  hostAllowed,
  originAllowed,
  path = "/ws",
  WebSocketServerImpl = WebSocketServer,
} = {}) {
  const sockets = new Set();
  const wss = new WebSocketServerImpl({ noServer: true });

  function onUpgrade(req, socket, head) {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname !== path) {
      socket.destroy();
      return;
    }
    if (!hostAllowed(req.headers.host || "") || !originAllowed(req.headers.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  }

  server.on("upgrade", onUpgrade);

  wss.on("connection", (ws) => {
    sockets.add(ws);
    const seenMessageIds = new Set();
    let unsubscribe = null;
    let helloDone = false;
    // Sequence of the last event this socket received. Events at or below it
    // are replay duplicates; the runtime numbers a reset conversation from 1
    // again, so a reset moves this back to 0.
    let lastReplayed = 0;

    ws.on("close", () => {
      sockets.delete(ws);
      unsubscribe?.();
    });

    ws.on("message", async (raw) => {
      let value;
      try {
        value = JSON.parse(String(raw));
      } catch {
        send(ws, { type: "protocol.error", error: "malformed JSON" });
        return;
      }

      if (value?.protocolVersion != null && value.protocolVersion !== DESK_PROTOCOL_VERSION) {
        send(ws, { type: "protocol.error", error: "unsupported protocol version" });
        return;
      }

      const checked = validateClientMessage(value);
      if (!checked.ok) {
        send(ws, { type: "protocol.error", error: checked.error });
        return;
      }
      const message = checked.message;

      if (message.type === "hello") {
        if (helloDone) {
          send(ws, { type: "protocol.error", error: "hello already completed" });
          return;
        }
        const replay = runtime.eventsAfter(message.afterSequence ?? 0);
        lastReplayed = replay.at(-1)?.sequence ?? message.afterSequence ?? 0;
        unsubscribe = runtime.subscribe((event) => {
          // A reset issued on another socket restarts numbering at 1; a
          // sequence below the cursor can only mean that, never a replay.
          if (event.sequence < lastReplayed) lastReplayed = 0;
          if (event.sequence <= lastReplayed) return;
          lastReplayed = event.sequence;
          send(ws, { type: "event", event });
        });
        send(ws, { type: "snapshot", snapshot: runtime.snapshot() });
        for (const event of replay) send(ws, { type: "event", event });
        send(ws, { type: "replay.complete" });
        helloDone = true;
        return;
      }

      if (!helloDone) {
        send(ws, { type: "protocol.error", error: "hello required" });
        return;
      }

      if (message.messageId) {
        if (seenMessageIds.has(message.messageId)) {
          send(ws, { type: "command.rejected", reason: "duplicate" });
          return;
        }
        seenMessageIds.add(message.messageId);
      }

      let result = { ok: false, reason: "unsupported" };
      try {
        result = await dispatch(message);
      } catch (error) {
        // A runtime that throws (an SDK transport not ready, a store write
        // failing) must answer the page and must not take the process down.
        console.error(`desk command ${message.type} failed: ${error?.message || error}`);
        result = { ok: false, reason: "error" };
      }
      // Echo the ids so the page can tell which send or answer this settles.
      const correlation = { messageId: message.messageId, requestId: message.requestId };
      send(ws, result.ok
        ? { type: "command.accepted", command: message.type, ...correlation }
        : { type: "command.rejected", command: message.type, reason: result.reason || "rejected", ...correlation });
      // Generation-changing commands (reset, handoffs) must push the new
      // snapshot, or the client's stale controllerGeneration rejects the next
      // message. The accepted result above carries no generation.
      if (result.ok && (result.snapshot || message.type === "conversation.reset")) {
        send(ws, { type: "snapshot", snapshot: result.snapshot || runtime.snapshot() });
      }
    });

    async function dispatch(message) {
      let result = { ok: false, reason: "unsupported" };
      if (message.type === "user.message") {
        result = await runtime.submitMessage({
          messageId: message.messageId,
          text: message.text,
          expectedControllerGeneration: message.expectedControllerGeneration,
        });
      } else if (message.type === "event.ack") {
        runtime.acknowledge?.({ sequence: message.sequence });
        result = { ok: true };
      } else if (message.type === "permission.decision") {
        result = await runtime.resolvePermission(message);
      } else if (message.type === "question.response") {
        result = await runtime.respondToQuestion(message);
      } else if (message.type === "turn.interrupt") {
        result = await runtime.interrupt(message);
      } else if (message.type === "conversation.reset") {
        result = await runtime.reset(message);
        if (result.ok) lastReplayed = 0;
      }
      return result;
    }
  });

  return {
    async close() {
      server.off("upgrade", onUpgrade);
      for (const socket of sockets) socket.close();
      await new Promise((resolve) => wss.close(resolve));
    },
    clientCount() {
      return sockets.size;
    },
  };
}
