/**
 * Claude in Chrome cannot be packed into the Desk installer (Chrome only
 * installs store extensions). Desk detects the official extension, opens the
 * store page in Chrome, and turns Chrome mode on once it is present.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { CHROME_EXTENSION_URL } from "./defaults.mjs";

export const CHROME_EXTENSION_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn";

function homeOf(env = process.env) {
  return env.HOME || env.USERPROFILE || "";
}

function localAppData(env = process.env) {
  if (env.LOCALAPPDATA) return env.LOCALAPPDATA;
  const home = homeOf(env);
  return home ? join(home, "AppData", "Local") : "";
}

export function chromeUserDataRoots(env = process.env, platform = process.platform) {
  const home = homeOf(env);
  const local = localAppData(env);
  if (platform === "win32") {
    return [
      local && join(local, "Google", "Chrome", "User Data"),
      local && join(local, "Google", "Chrome Beta", "User Data"),
      local && join(local, "Microsoft", "Edge", "User Data"),
      local && join(local, "Chromium", "User Data"),
    ].filter(Boolean);
  }
  if (platform === "darwin") {
    const support = home ? join(home, "Library", "Application Support") : "";
    return [
      support && join(support, "Google", "Chrome"),
      support && join(support, "Google", "Chrome Beta"),
      support && join(support, "Microsoft Edge"),
      support && join(support, "Chromium"),
    ].filter(Boolean);
  }
  return [
    home && join(home, ".config", "google-chrome"),
    home && join(home, ".config", "google-chrome-beta"),
    home && join(home, ".config", "microsoft-edge"),
    home && join(home, ".config", "chromium"),
  ].filter(Boolean);
}

function profileDirs(userData) {
  try {
    return readdirSync(userData, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^(Default|Profile \d+|Guest Profile)$/i.test(entry.name))
      .map((entry) => join(userData, entry.name));
  } catch {
    return [];
  }
}

export function chromeExtensionInstalled(env = process.env, platform = process.platform) {
  for (const root of chromeUserDataRoots(env, platform)) {
    for (const profile of profileDirs(root)) {
      const ext = join(profile, "Extensions", CHROME_EXTENSION_ID);
      if (!existsSync(ext)) continue;
      try {
        const versions = readdirSync(ext, { withFileTypes: true }).filter((entry) => entry.isDirectory());
        if (versions.some((entry) => existsSync(join(ext, entry.name, "manifest.json")))) return true;
      } catch {
        // Unreadable profile; try the next one.
      }
    }
  }
  return false;
}

/**
 * Env 0/1 wins. Otherwise Desk uses Chrome when the official extension is
 * already on this computer, so a first-run install does not need a second
 * setting. Missing extension stays off so a turn cannot stall on it.
 */
export function chromeEnabled(env = process.env, platform = process.platform) {
  if (env.JOB_SEARCH_CLAUDE_CHROME === "0") return false;
  if (env.JOB_SEARCH_CLAUDE_CHROME === "1") return true;
  return chromeExtensionInstalled(env, platform);
}

export function chromeExtensionStatus(env = process.env, platform = process.platform) {
  const installed = chromeExtensionInstalled(env, platform);
  const enabled = chromeEnabled(env, platform);
  return {
    installed,
    enabled,
    id: CHROME_EXTENSION_ID,
    url: CHROME_EXTENSION_URL,
    forcedOff: env.JOB_SEARCH_CLAUDE_CHROME === "0",
  };
}

export function openInChrome(href, env = process.env, platform = process.platform) {
  const detach = { detached: true, stdio: "ignore", env };
  if (platform === "win32") {
    const chrome = spawn("cmd", ["/c", "start", "", "chrome", href], detach);
    chrome.on("exit", (code) => {
      if (code) spawn("cmd", ["/c", "start", "", href], detach).unref();
    });
    chrome.unref();
    return;
  }
  if (platform === "darwin") {
    const chrome = spawn("open", ["-a", "Google Chrome", href], detach);
    chrome.on("exit", (code) => {
      if (code) spawn("open", [href], detach).unref();
    });
    chrome.unref();
    return;
  }
  const linuxChrome = spawn("google-chrome", [href], detach);
  linuxChrome.on("error", () => {
    const chromium = spawn("chromium-browser", [href], detach);
    chromium.on("error", () => {
      const fallback = spawn("xdg-open", [href], detach);
      fallback.on("error", () => {});
      fallback.unref();
    });
    chromium.unref();
  });
  linuxChrome.unref();
}

export function installClaudeChrome(env = process.env, platform = process.platform) {
  openInChrome(CHROME_EXTENSION_URL, env, platform);
  return chromeExtensionStatus(env, platform);
}
