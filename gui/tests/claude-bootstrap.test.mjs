import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createClaudeBootstrap } from "../claude-bootstrap.mjs";

function fakeInstall() {
  const proc = new EventEmitter();
  return proc;
}

test("ensure starts the official installer when Claude is missing", async () => {
  const spawned = [];
  const bootstrap = createClaudeBootstrap({
    getHealth: async () => ({ installed: false, loggedIn: false }),
    spawnInstall: () => {
      const proc = fakeInstall();
      spawned.push(proc);
      return proc;
    },
  });
  const first = await bootstrap.ensure();
  assert.equal(first.status, "installing");
  assert.equal(spawned.length, 1);
  const again = await bootstrap.ensure();
  assert.equal(again.status, "installing");
  assert.equal(spawned.length, 1);
});

test("ensure reports ready when Claude is already installed", async () => {
  const bootstrap = createClaudeBootstrap({
    getHealth: async () => ({ installed: true, loggedIn: false }),
    spawnInstall: () => {
      throw new Error("should not install");
    },
  });
  const info = await bootstrap.ensure();
  assert.equal(info.status, "ready");
  assert.equal(info.health.installed, true);
});

test("install close with Claude present marks ready", async () => {
  let installed = false;
  let proc;
  const bootstrap = createClaudeBootstrap({
    getHealth: async () => ({ installed, loggedIn: false }),
    spawnInstall: () => {
      proc = fakeInstall();
      return proc;
    },
  });
  await bootstrap.ensure();
  installed = true;
  proc.emit("close", 0);
  for (let i = 0; i < 20 && bootstrap.snapshot().status === "installing"; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(bootstrap.snapshot().status, "ready");
});
