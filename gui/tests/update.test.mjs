import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyFakeUpdateState,
  getUpdateState,
  registerUpdateDownloader,
  requestUpdateDownload,
  requestUpdateInstall,
  setUpdateState,
} from "../update.mjs";

test("applyFakeUpdateState is off by default and on with the test flag", () => {
  setUpdateState({ channel: "idle", version: "", current: "" });
  assert.equal(applyFakeUpdateState({}), false);
  assert.equal(getUpdateState().channel, "idle");
  assert.equal(applyFakeUpdateState({ JOB_SEARCH_UPDATE_FAKE: "1" }), true);
  const fake = getUpdateState();
  assert.equal(fake.channel, "downloaded");
  assert.equal(fake.version, "1.9.9");
});

test("the fake state can stand in for an update that is only available, not downloaded", () => {
  setUpdateState({ channel: "idle", version: "", current: "" });
  applyFakeUpdateState({ JOB_SEARCH_UPDATE_FAKE: "1", JOB_SEARCH_UPDATE_FAKE_CHANNEL: "available" });
  assert.equal(getUpdateState().channel, "available");
});

test("requestUpdateDownload fails until a downloader is registered, then calls it once", () => {
  registerUpdateDownloader(null);
  assert.equal(requestUpdateDownload().ok, false);
  let calls = 0;
  registerUpdateDownloader(() => {
    calls += 1;
  });
  assert.deepEqual(requestUpdateDownload(), { ok: true });
  assert.equal(calls, 1);
  registerUpdateDownloader(null);
});

test("requestUpdateInstall fails until an installer is registered", () => {
  const result = requestUpdateInstall();
  assert.equal(result.ok, false);
});
