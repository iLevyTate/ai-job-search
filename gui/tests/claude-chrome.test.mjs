import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CHROME_EXTENSION_ID,
  chromeEnabled,
  chromeExtensionInstalled,
  chromeExtensionStatus,
  chromeUserDataRoots,
} from "../claude-chrome.mjs";

function emptyEnv() {
  return { HOME: mkdtempSync(join(tmpdir(), "desk-chrome-empty-")), USERPROFILE: "", LOCALAPPDATA: "" };
}

function envWithExtension(platform = "win32") {
  const home = mkdtempSync(join(tmpdir(), "desk-chrome-home-"));
  const local = join(home, "AppData", "Local");
  const userData = platform === "win32"
    ? join(local, "Google", "Chrome", "User Data")
    : platform === "darwin"
      ? join(home, "Library", "Application Support", "Google", "Chrome")
      : join(home, ".config", "google-chrome");
  const ext = join(userData, "Default", "Extensions", CHROME_EXTENSION_ID, "1.0.94_0");
  mkdirSync(ext, { recursive: true });
  writeFileSync(join(ext, "manifest.json"), "{\"name\":\"Claude\"}\n");
  return {
    HOME: home,
    USERPROFILE: home,
    LOCALAPPDATA: local,
    platform,
    userData,
  };
}

test("chrome user data roots stay inside the env we pass", () => {
  const env = { HOME: join("/tmp", "desk-home"), USERPROFILE: join("/tmp", "desk-home"), LOCALAPPDATA: join("/tmp", "desk-local") };
  const win = chromeUserDataRoots(env, "win32");
  assert.ok(win.every((root) => root.startsWith(env.LOCALAPPDATA)));
  const mac = chromeUserDataRoots(env, "darwin");
  assert.ok(mac.every((root) => root.startsWith(env.HOME)));
});

test("missing extension stays off so a turn cannot wait on Chrome", () => {
  const env = emptyEnv();
  assert.equal(chromeExtensionInstalled(env, "win32"), false);
  assert.equal(chromeEnabled(env, "win32"), false);
  assert.equal(chromeExtensionStatus(env, "win32").installed, false);
});

test("installed official extension turns Chrome mode on", () => {
  const env = envWithExtension("win32");
  assert.equal(chromeExtensionInstalled(env, "win32"), true);
  assert.equal(chromeEnabled(env, "win32"), true);
  assert.equal(chromeExtensionStatus(env, "win32").enabled, true);
});

test("JOB_SEARCH_CLAUDE_CHROME=0 wins even when the extension is present", () => {
  const env = { ...envWithExtension("win32"), JOB_SEARCH_CLAUDE_CHROME: "0" };
  assert.equal(chromeEnabled(env, "win32"), false);
  assert.equal(chromeExtensionStatus(env, "win32").forcedOff, true);
});

test("JOB_SEARCH_CLAUDE_CHROME=1 wins even when the extension is missing", () => {
  const env = { ...emptyEnv(), JOB_SEARCH_CLAUDE_CHROME: "1" };
  assert.equal(chromeEnabled(env, "win32"), true);
});
