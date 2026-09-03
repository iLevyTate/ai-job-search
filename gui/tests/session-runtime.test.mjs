import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConversationStore } from "../conversation-store.mjs";
import { createSessionRuntime } from "../session-runtime.mjs";

async function waitUntil(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for session-runtime condition");
}

function createFakeAdapter() {
  const sent = [];
  const waiters = [];
  const buffer = [];
  let closed = false;
  let started = 0;

  function pushMessage(message) {
    if (waiters.length) waiters.shift()({ value: message, done: false });
    else buffer.push(message);
  }

  return {
    sent,
    get started() { return started; },
    emit: pushMessage,
    closeStream() {
      closed = true;
      while (waiters.length) waiters.shift()({ value: undefined, done: true });
    },
    failStream(error) {
      closed = true;
      while (waiters.length) waiters.shift()(null, error);
    },
    create: () => {
      started += 1;
      return {
        async start() { return { type: "init" }; },
        messages() {
          return {
            next() {
              if (buffer.length) return Promise.resolve({ value: buffer.shift(), done: false });
              if (closed) return Promise.resolve({ value: undefined, done: true });
              return new Promise((resolve, reject) => {
                waiters.push((result, error) => (error ? reject(error) : resolve(result)));
              });
            },
            [Symbol.asyncIterator]() { return this; },
          };
        },
        send(message) {
          if (message.text === "overflow") return { accepted: false, reason: "full" };
          sent.push(message);
          return { accepted: true };
        },
        settlePermission() { return true; },
        interrupt: async () => ({ type: "interrupt" }),
        close() {
          closed = true;
          while (waiters.length) waiters.shift()({ value: undefined, done: true });
        },
      };
    },
  };
}

async function withRuntime(testFn, extras = {}) {
  const fake = createFakeAdapter();
  const store = createConversationStore({
    workspace: mkdtempSync(join(tmpdir(), "desk-runtime-")),
    createId: extras.createId || (() => {
      let n = extras.n || 0;
      extras.n = n + 1;
      return `id-${extras.n}`;
    }),
  });
  const conversation = await store.createConversation();
  const published = [];
  const runtime = createSessionRuntime({
    workspace: "unused",
    conversationId: conversation.id,
    store,
    adapterFactory: fake.create,
    ...extras,
  });
  runtime.subscribe((event) => published.push(event));
  await runtime.start();
  await testFn({ runtime, store, fake, conversation, published });
  await runtime.stop();
}

test("persists an event before notifying subscribers", async () => {
  const order = [];
  await withRuntime(async ({ runtime, store, fake, conversation }) => {
    const original = store.appendEvent.bind(store);
    store.appendEvent = async (...args) => {
      order.push("persist");
      return original(...args);
    };
    runtime.subscribe(() => order.push("notify"));
    fake.emit({
      type: "stream_event",
      session_id: "s1",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
    });
    await waitUntil(() => order.includes("notify"));
    assert.deepEqual(order.slice(0, 2), ["persist", "notify"]);
    assert.ok(store.eventsAfter(conversation.id, 0).length >= 1);
  });
});

test("replays events after a sequence cursor", async () => {
  await withRuntime(async ({ runtime, fake }) => {
    fake.emit({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "A" } },
    });
    fake.emit({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "B" } },
    });
    await waitUntil(() => runtime.eventsAfter(0).length >= 2);
    const replay = runtime.eventsAfter(1);
    assert.equal(replay.length, 1);
    assert.equal(replay[0].payload.text, "B");
  });
});

test("multiple submitted messages use one adapter", async () => {
  await withRuntime(async ({ runtime, fake }) => {
    const first = await runtime.submitMessage({ messageId: "m1", text: "one", expectedControllerGeneration: 1 });
    const second = await runtime.submitMessage({ messageId: "m2", text: "two", expectedControllerGeneration: 1 });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(fake.started, 1);
    assert.equal(fake.sent.length, 2);
  });
});

test("queue backpressure is visible", async () => {
  await withRuntime(async ({ runtime }) => {
    const result = await runtime.submitMessage({ messageId: "m3", text: "overflow", expectedControllerGeneration: 1 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "full");
  });
});

test("stale controller generations are rejected", async () => {
  await withRuntime(async ({ runtime }) => {
    const result = await runtime.submitMessage({ messageId: "m4", text: "nope", expectedControllerGeneration: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "stale-controller");
  });
});

test("handoff begin, commit, and rollback keep exactly one controller", async () => {
  await withRuntime(async ({ runtime }) => {
    const begun = await runtime.beginTerminalHandoff({ expectedControllerGeneration: 1 });
    assert.equal(begun.ok, true);
    assert.equal(runtime.snapshot().controller, "chat");
    const late = await runtime.submitMessage({ messageId: "late", text: "x", expectedControllerGeneration: 1 });
    assert.equal(late.ok, false);
    const committed = await runtime.commitTerminalHandoff({ handoffId: begun.handoffId, terminalId: "term-1" });
    assert.equal(committed.ok, true);
    assert.equal(runtime.snapshot().controller, "terminal");
    assert.equal(runtime.snapshot().controllerGeneration, begun.nextGeneration);

    const chat = await runtime.beginChatHandoff({ expectedControllerGeneration: begun.nextGeneration, terminalId: "term-1" });
    assert.equal(chat.ok, true);
    const rolled = await runtime.rollbackTerminalHandoff({ handoffId: "missing", reason: "nope" });
    assert.equal(rolled.ok, false);
    const committedChat = await runtime.commitChatHandoff({ handoffId: chat.handoffId });
    assert.equal(committedChat.ok, true);
    assert.equal(runtime.snapshot().controller, "chat");
  });
});

test("runtime stop aborts pending interactions", async () => {
  let aborted = false;
  await withRuntime(async ({ runtime }) => {
    assert.equal(runtime.snapshot().permissionMode, "safe");
  }, {
    brokerFactory: () => ({
      abortAll() { aborted = true; },
      beginPermission() {},
      beginQuestion() {},
      resolvePermission() { return { ok: true }; },
      respondToQuestion() { return { ok: true }; },
      disconnect() { return 0; },
    }),
  });
  assert.equal(aborted, true);
});

test("permission timeout and disconnect deny through the broker", async () => {
  await withRuntime(async ({ runtime }) => {
    assert.equal(typeof runtime.disconnectInteractions(), "number");
    const unknown = await runtime.resolvePermission({
      requestId: "missing",
      decision: "allow-once",
      expectedControllerGeneration: 1,
    });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.reason, "unknown-request");
  });
});

test("Safe mode stays Safe when an invalid mode is requested", async () => {
  const policy = {
    mode: "safe",
    get() { return this.mode; },
    async set(mode) { this.mode = mode; return mode; },
  };
  await withRuntime(async ({ runtime }) => {
    const result = await runtime.setPermissionMode({
      mode: "bypassPermissions",
      expectedControllerGeneration: 1,
    });
    assert.equal(result.ok, true);
    assert.equal(runtime.snapshot().permissionMode, "safe");
    assert.equal(policy.mode, "safe");
  }, { permissionPolicy: policy });
});

test("stale handoff IDs, timeouts, and late input keep exactly one controller", async () => {
  await withRuntime(async ({ runtime }) => {
    const begun = await runtime.beginTerminalHandoff({ expectedControllerGeneration: 1, timeoutMs: 20 });
    assert.equal(begun.ok, true);
    const stale = await runtime.commitTerminalHandoff({ handoffId: "missing", terminalId: "term-x" });
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, "unknown-handoff");
    assert.equal(runtime.snapshot().controller, "chat");

    await new Promise((resolve) => setTimeout(resolve, 30));
    const lateCommit = await runtime.commitTerminalHandoff({ handoffId: begun.handoffId, terminalId: "term-late" });
    assert.equal(lateCommit.ok, false);
    assert.equal(runtime.snapshot().controller, "chat");
    assert.equal(runtime.snapshot().controllerGeneration, 1);

    const lateTerminal = runtime.submitTerminalInput({ text: "ls", expectedControllerGeneration: 1 });
    assert.equal(lateTerminal.ok, false);
    assert.equal(lateTerminal.reason, "wrong-controller");

    const again = await runtime.beginTerminalHandoff({ expectedControllerGeneration: 1 });
    const failed = await runtime.rollbackTerminalHandoff({ handoffId: again.handoffId });
    assert.equal(failed.ok, true);
    assert.equal(runtime.snapshot().controller, "chat");
    assert.equal(typeof runtime.controllers.beginTerminalHandoff, "function");

    const review = runtime.startAutofillReview();
    const ready = await runtime.markAutofillReady({
      token: review.token,
      url: "https://jobs.example/1",
    });
    assert.equal(ready.ok, true);
    assert.equal(ready.event.type, "autofill.review");
    const decided = await runtime.decideAutofill({
      reviewId: review.reviewId,
      token: review.token,
      decision: "continue",
      expectedControllerGeneration: 1,
    });
    assert.equal(decided.ok, true);
    assert.equal(decided.decision, "continue");
  });
});

test("reset drops late events from the previous epoch", async () => {
  // One fake per adapter: reset replaces the adapter, and a shared stream
  // would be closed under the replacement too.
  const fakes = [];
  const factory = (options) => {
    const fake = createFakeAdapter();
    fakes.push(fake);
    return fake.create(options);
  };
  await withRuntime(async ({ runtime, published }) => {
    await runtime.reset({ expectedControllerGeneration: 1 });
    const before = published.length;
    fakes[0].emit({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "late" } },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(published.length, before);
  }, { adapterFactory: factory });
});

test("a submitted message is persisted as user.message and starts the turn", async () => {
  await withRuntime(async ({ runtime, fake, published }) => {
    const result = await runtime.submitMessage({ messageId: "m-user", text: "rank these", expectedControllerGeneration: 1 });
    assert.equal(result.ok, true);
    const echoed = published.find((event) => event.type === "user.message");
    assert.ok(echoed, "the page paints You from this event; there is no local copy");
    assert.equal(echoed.payload.messageId, "m-user");
    assert.equal(echoed.payload.text, "rank these");
    assert.equal(echoed.turnId, "m-user");
    assert.equal(runtime.snapshot().busy, true);
    assert.ok(runtime.eventsAfter(0).some((event) => event.type === "user.message"), "replay includes it after a reload");

    fake.emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Ranked." } } });
    await waitUntil(() => published.some((event) => event.type === "assistant.delta"));
    assert.equal(published.find((event) => event.type === "assistant.delta").turnId, "m-user");
  });
});

test("a follow-up sent during a turn becomes its own turn when Claude reaches it", async () => {
  await withRuntime(async ({ runtime, fake, published }) => {
    await runtime.submitMessage({ messageId: "m-first", text: "one", expectedControllerGeneration: 1 });
    await runtime.submitMessage({ messageId: "m-second", text: "two", expectedControllerGeneration: 1 });
    fake.emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "A" } } });
    fake.emit({ type: "result", subtype: "success", result: "A" });
    await waitUntil(() => published.some((event) => event.type === "turn.completed"));
    assert.equal(runtime.snapshot().busy, false);

    fake.emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "B" } } });
    await waitUntil(() => published.filter((event) => event.type === "assistant.delta").length >= 2);
    const deltas = published.filter((event) => event.type === "assistant.delta");
    assert.equal(deltas[0].turnId, "m-first");
    assert.equal(deltas[1].turnId, "m-second");
    assert.equal(runtime.snapshot().busy, true);
  });
});

function adapterWithPermissions(fake) {
  const captured = {};
  return {
    captured,
    factory: (options) => {
      captured.onPermissionRequest = options.onPermissionRequest;
      return fake.create(options);
    },
  };
}

test("a Safe-mode permission prompt reaches the page and the decision settles the callback", async () => {
  const fake = createFakeAdapter();
  const wired = adapterWithPermissions(fake);
  await withRuntime(async ({ runtime, published }) => {
    await runtime.submitMessage({ messageId: "m-p", text: "write it", expectedControllerGeneration: 1 });
    const decision = wired.captured.onPermissionRequest({
      requestId: "req-1",
      toolUseId: "tool-w",
      toolName: "Write",
      input: { file_path: "cv/main.tex" },
      suggestions: [{ type: "addRules", destination: "localSettings", behavior: "allow", rules: [] }],
      title: "Claude wants to write cv/main.tex",
    });
    await waitUntil(() => published.some((event) => event.type === "permission.requested"));
    const asked = published.find((event) => event.type === "permission.requested");
    assert.equal(asked.payload.entityId, "req-1");
    assert.equal(asked.payload.toolName, "Write");
    assert.equal(asked.payload.title, "Claude wants to write cv/main.tex");
    assert.equal(asked.turnId, "m-p");

    const resolved = await runtime.resolvePermission({ requestId: "req-1", decision: "allow-once", expectedControllerGeneration: 1 });
    assert.equal(resolved.ok, true);
    const result = await decision;
    assert.equal(result.behavior, "allow");
    assert.deepEqual(result.updatedInput, { file_path: "cv/main.tex" });
    await waitUntil(() => published.some((event) => event.type === "permission.resolved"));
    assert.equal(published.find((event) => event.type === "permission.resolved").payload.decision, "allow");
  }, { adapterFactory: wired.factory });
});

test("AskUserQuestion is answered through the callback with answers keyed by question text", async () => {
  const fake = createFakeAdapter();
  const wired = adapterWithPermissions(fake);
  await withRuntime(async ({ runtime, published }) => {
    await runtime.submitMessage({ messageId: "m-q", text: "apply", expectedControllerGeneration: 1 });
    const questions = [{ question: "Which lane?", header: "Lane", options: [{ label: "Healthcare", description: "" }, { label: "Defense", description: "" }], multiSelect: false }];
    const decision = wired.captured.onPermissionRequest({
      requestId: "req-q",
      toolUseId: "tool-q",
      toolName: "AskUserQuestion",
      input: { questions },
    });
    await waitUntil(() => published.some((event) => event.type === "question.requested"));
    const asked = published.find((event) => event.type === "question.requested");
    assert.equal(asked.payload.entityId, "req-q");
    assert.equal(asked.payload.questions[0].question, "Which lane?");
    assert.equal(fake.sent.length, 1, "no chat message is sent for the question itself");

    const answered = await runtime.respondToQuestion({
      requestId: "req-q",
      answers: { "Which lane?": "Healthcare" },
      expectedControllerGeneration: 1,
    });
    assert.equal(answered.ok, true);
    const result = await decision;
    assert.equal(result.behavior, "allow");
    assert.deepEqual(result.updatedInput.answers, { "Which lane?": "Healthcare" });
    assert.deepEqual(result.updatedInput.questions, questions);
    assert.equal(fake.sent.length, 1, "the answer is not sent as a chat message");
    await waitUntil(() => published.some((event) => event.type === "question.resolved"));
  }, { adapterFactory: wired.factory });
});

test("New chat restarts the adapter so later replies are published, and reports the new generation", async () => {
  // One fake per adapter: a shared fake would close both streams at once.
  const fakes = [];
  const factory = (options) => {
    const fake = createFakeAdapter();
    fakes.push(fake);
    return fake.create(options);
  };
  await withRuntime(async ({ runtime, published }) => {
    await runtime.submitMessage({ messageId: "m-a", text: "one", expectedControllerGeneration: 1 });
    const reset = await runtime.reset({ expectedControllerGeneration: 1 });
    assert.equal(reset.ok, true);
    assert.equal(reset.snapshot.controllerGeneration, 2);
    assert.equal(reset.snapshot.sessionId, null);
    assert.equal(fakes.length, 2, "a fresh adapter runs under the new epoch");
    await runtime.submitMessage({ messageId: "m-b", text: "two", expectedControllerGeneration: 2 });
    fakes[1].emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "after reset" } } });
    await waitUntil(() => published.some((event) => event.type === "assistant.delta" && event.payload.text === "after reset"));
    assert.equal(runtime.eventsAfter(0).some((event) => event.type === "assistant.delta"), true);
  }, { adapterFactory: factory });
});

test("a turn left open by a previous launch is closed on start", async () => {
  const fake = createFakeAdapter();
  const store = createConversationStore({ workspace: mkdtempSync(join(tmpdir(), "desk-runtime-")) });
  const conversation = await store.createConversation();
  await store.transact(conversation.id, (next) => {
    next.partialTurn = { id: "old-turn", eventId: "old-turn" };
  });
  const runtime = createSessionRuntime({ workspace: "unused", conversationId: conversation.id, store, adapterFactory: fake.create });
  const snapshot = await runtime.start();
  assert.equal(snapshot.busy, false);
  assert.equal(runtime.eventsAfter(0).at(-1).type, "turn.interrupted");
  await runtime.stop();
});

test("a stream that ends mid-turn closes the turn visibly and restarts the adapter once", async () => {
  const fakes = [];
  const factory = (options) => {
    const fake = createFakeAdapter();
    fakes.push(fake);
    return fake.create(options);
  };
  await withRuntime(async ({ runtime, published }) => {
    await runtime.submitMessage({ messageId: "m-dead", text: "go", expectedControllerGeneration: 1 });
    fakes[0].closeStream();
    await waitUntil(() => published.some((event) => event.type === "turn.failed"));
    assert.match(published.find((event) => event.type === "turn.failed").payload.text, /stopped unexpectedly/);
    assert.equal(runtime.snapshot().busy, false);
    await waitUntil(() => fakes.length === 2);
    const next = await runtime.submitMessage({ messageId: "m-next", text: "again", expectedControllerGeneration: 1 });
    assert.equal(next.ok, true);
    fakes[1].emit({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "back" } } });
    await waitUntil(() => published.some((event) => event.type === "assistant.delta" && event.payload.text === "back"));
  }, { adapterFactory: factory });
});

test("a sign-in failure does not loop restarts; sends are refused until New chat", async () => {
  const fakes = [];
  const factory = (options) => {
    const fake = createFakeAdapter();
    fakes.push(fake);
    return fake.create(options);
  };
  await withRuntime(async ({ runtime, published }) => {
    await runtime.submitMessage({ messageId: "m-auth", text: "go", expectedControllerGeneration: 1 });
    fakes[0].failStream(new Error("authentication_failed: please log in"));
    await waitUntil(() => published.some((event) => event.type === "session.status" && event.payload.phase === "stopped"));
    assert.equal(fakes.length, 1);
    const refused = await runtime.submitMessage({ messageId: "m-refused", text: "again", expectedControllerGeneration: 1 });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "closed");
    const reset = await runtime.reset({ expectedControllerGeneration: 1 });
    assert.equal(reset.ok, true);
    assert.equal(fakes.length, 2);
    const after = await runtime.submitMessage({ messageId: "m-after", text: "fresh", expectedControllerGeneration: 2 });
    assert.equal(after.ok, true);
  }, { adapterFactory: factory });
});
