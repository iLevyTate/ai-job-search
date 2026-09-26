/**
 * Update status for the installable desk. electron-main drives
 * electron-updater and writes this state; the HTTP server only reads it
 * so the browser desk and the packaged app share one GET /update/status.
 */
const RELEASES_URL = "https://github.com/iLevyTate/ai-job-search/releases";

let state = {
  ok: true,
  channel: "idle",
  current: "",
  version: "",
  error: "",
  releasesUrl: RELEASES_URL,
};

let installer = null;
let downloader = null;

export function getUpdateState() {
  return { ...state };
}

export function setUpdateState(patch) {
  state = { ...state, ...patch };
  return getUpdateState();
}

export function registerUpdateInstaller(fn) {
  installer = typeof fn === "function" ? fn : null;
}

export function registerUpdateDownloader(fn) {
  downloader = typeof fn === "function" ? fn : null;
}

export function requestUpdateDownload() {
  if (!downloader) {
    return { ok: false, error: "Open the latest installer from GitHub Releases." };
  }
  downloader();
  return { ok: true };
}

export function requestUpdateInstall() {
  if (!installer) {
    return { ok: false, error: "Open the latest installer from GitHub Releases." };
  }
  installer();
  return { ok: true };
}

export function applyFakeUpdateState(env = process.env) {
  if (env.JOB_SEARCH_UPDATE_FAKE !== "1") return false;
  setUpdateState({
    channel: env.JOB_SEARCH_UPDATE_FAKE_CHANNEL || "downloaded",
    current: env.JOB_SEARCH_UPDATE_CURRENT || "1.3.5",
    version: env.JOB_SEARCH_UPDATE_NEXT || "1.9.9",
    error: "",
  });
  return true;
}
