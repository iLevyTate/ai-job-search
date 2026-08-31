import { createArtifactService } from "./artifacts.mjs";
import { createAutofillBridge } from "./autofill-bridge.mjs";
import { createConversationStore } from "./conversation-store.mjs";
import { createPermissionPolicy } from "./permission-policy.mjs";
import { createSessionRuntime } from "./session-runtime.mjs";

export async function createDeskSession({
  workspace,
  adapterFactory,
  autofillBridge = createAutofillBridge(),
  artifactService,
  ...runtimeExtras
} = {}) {
  if (!workspace) throw new Error("workspace is required");
  const store = createConversationStore({ workspace });
  await store.load();
  let conversationId = store.activeConversationId();
  if (!conversationId) conversationId = (await store.createConversation()).id;
  // A persisted "terminal" controller with no live pty would leave Chat
  // rejecting every message after a restart. No pty survives a reload, so the
  // only safe controller on load is chat.
  const active = store.get(conversationId);
  if (active && active.controller !== "chat") {
    await store.transact(conversationId, (next) => {
      next.controller = "chat";
      next.controllerGeneration += 1;
    });
  }
  const permissionPolicy = createPermissionPolicy({ workspace });
  await permissionPolicy.load();
  const artifacts = artifactService || createArtifactService({ workspace });
  const runtime = createSessionRuntime({
    workspace,
    conversationId,
    store,
    permissionPolicy,
    artifactService: artifacts,
    autofillBridge,
    adapterFactory,
    ...runtimeExtras,
  });
  return { store, runtime, artifacts, autofill: autofillBridge, conversationId };
}

export function createDeskRuntimeFactory(overrides = {}) {
  return async ({ workspace }) => {
    const session = await createDeskSession({ workspace, ...overrides });
    await session.runtime.start();
    // Expose the session's artifact/autofill services so the server shares the
    // same instances the runtime writes to; otherwise the Files tab reads an
    // empty, separate artifact store.
    const runtime = session.runtime;
    runtime.artifactService = session.artifacts;
    runtime.autofillBridge = session.autofill;
    return runtime;
  };
}
