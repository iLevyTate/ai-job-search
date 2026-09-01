import { getClaudeHealth, spawnOfficialInstall } from "./claude.mjs";

const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

export function createClaudeBootstrap({
  getHealth = getClaudeHealth,
  spawnInstall = spawnOfficialInstall,
  installTimeoutMs = INSTALL_TIMEOUT_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  let state = { status: "idle", health: null, process: null };
  let inflight = null;

  function snapshot() {
    return { status: state.status, health: state.health };
  }

  function watchInstall(proc) {
    state = { status: "installing", health: state.health, process: proc };
    // The official installer streams download progress; if nothing drains the
    // pipes it blocks on a full buffer and never exits. We do not need the text.
    proc.stdout?.resume?.();
    proc.stderr?.resume?.();
    const watchdog = setTimeoutImpl(() => {
      if (state.process !== proc) return;
      try { proc.kill?.(); } catch { /* already gone */ }
      state = { status: "failed", health: state.health, process: null, error: "install timed out" };
    }, installTimeoutMs);
    watchdog.unref?.();
    const finish = async (code) => {
      if (state.process !== proc) return;
      clearTimeoutImpl(watchdog);
      const health = await getHealth();
      state = {
        status: health.installed ? "ready" : "failed",
        health,
        process: null,
        code: code ?? 0,
      };
    };
    proc.once("close", (code) => {
      finish(code).catch(() => {
        clearTimeoutImpl(watchdog);
        state = { status: "failed", health: state.health, process: null };
      });
    });
    proc.once("error", (err) => {
      if (state.process !== proc) return;
      clearTimeoutImpl(watchdog);
      state = { status: "failed", health: state.health, process: null, error: err.message };
    });
  }

  async function ensure(cwd) {
    if (state.status === "installing") return snapshot();
    if (inflight) return inflight;
    inflight = (async () => {
      const health = await getHealth(cwd);
      state.health = health;
      if (health.installed) {
        state.status = "ready";
        return snapshot();
      }
      watchInstall(spawnInstall());
      return snapshot();
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return { ensure, snapshot };
}
