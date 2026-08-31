import { getClaudeHealth, spawnOfficialInstall } from "./claude.mjs";

export function createClaudeBootstrap({
  getHealth = getClaudeHealth,
  spawnInstall = spawnOfficialInstall,
} = {}) {
  let state = { status: "idle", health: null, process: null };

  function snapshot() {
    return { status: state.status, health: state.health };
  }

  function watchInstall(proc) {
    state = { status: "installing", health: state.health, process: proc };
    const finish = async (code) => {
      if (state.process !== proc) return;
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
        state = { status: "failed", health: state.health, process: null };
      });
    });
    proc.once("error", (err) => {
      if (state.process !== proc) return;
      state = { status: "failed", health: state.health, process: null, error: err.message };
    });
  }

  async function ensure(cwd) {
    if (state.status === "installing") return snapshot();
    const health = await getHealth(cwd);
    state.health = health;
    if (health.installed) {
      state.status = "ready";
      return snapshot();
    }
    watchInstall(spawnInstall());
    return snapshot();
  }

  return { ensure, snapshot };
}
