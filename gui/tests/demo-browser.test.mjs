import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startBrowserDesk } from "../server.mjs";

test("the demo page does not start Claude", async () => {
  const root = join(mkdtempSync(join(tmpdir(), "desk-demo-browser-")), "workspace");
  const desk = await startBrowserDesk({ demo: true, port: 0, demoRoot: root });
  try {
    assert.equal(desk.runtime, null);
    assert.equal(desk.demo, true);
    const res = await fetch(`${desk.href}send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Draft the Harbor Health CV." }),
    });
    assert.equal(res.status, 202);
  } finally {
    desk.stop();
  }
});
