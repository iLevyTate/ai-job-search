import assert from "node:assert/strict";
import test from "node:test";
import { ignoreNavigationAbort, isNavigationAbort } from "../load-error.mjs";

test("Electron splash abort is not a failed launch", () => {
  assert.equal(isNavigationAbort({ errno: -3, message: "(-3) loading 'file:///app.asar/public/starting.html'" }), true);
  assert.equal(isNavigationAbort({ code: "ERR_ABORTED" }), true);
  assert.equal(isNavigationAbort({ message: "ERR_ABORTED" }), true);
  assert.equal(isNavigationAbort({ message: "EADDRINUSE: port 8765" }), false);
  assert.equal(isNavigationAbort(null), false);
});

test("ignoreNavigationAbort swallows only abort errors", async () => {
  await ignoreNavigationAbort(async () => {
    const err = new Error("(-3) loading 'file:///starting.html'");
    err.errno = -3;
    throw err;
  });
  await assert.rejects(
    () => ignoreNavigationAbort(async () => {
      throw new Error("The desk could not start.");
    }),
    /could not start/,
  );
});
