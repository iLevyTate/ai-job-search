import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createArtifactService } from "../artifacts.mjs";
import { startDesk } from "../server.mjs";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

function write(root, rel, body) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

async function withDesk(testFn) {
  const opened = [];
  const revealed = [];
  // These fixtures land in the real repo checkout (the desk needs its .claude/
  // tree), so every file written here is removed again in the finally below.
  // documents/ is tracked apart from its personal subfolders, and a leftover
  // notes.md there shows up as an untracked file after every test run.
  const written = [];
  const writeFixture = (rel, body) => written.push(write(REPO, rel, body));
  writeFixture(join(".claude", "desk", "preview.html"), "<p>preview</p>");
  writeFixture(join(".claude", "desk", "notes.md"), "before");
  const artifacts = createArtifactService({
    workspace: REPO,
    createId: (() => { let n = 0; return () => `http-art-${++n}`; })(),
    openImpl: {
      open(path) { opened.push(path); },
      reveal(path) { revealed.push(path); },
    },
  });
  await artifacts.beginTurn("turn-http");
  writeFixture(join("documents", "notes.md"), "after");
  writeFixture(join("documents", "preview.html"), "<p>preview</p>");
  await artifacts.settleTurn("turn-http");
  const runtime = {
    snapshot() { return { controllerGeneration: 2 }; },
  };
  process.env.JOB_SEARCH_GUI_NO_BROWSER = "1";
  const desk = await startDesk({
    root: REPO,
    openBrowser: false,
    port: 0,
    artifacts,
    runtime,
  });
  try {
    await testFn({
      base: desk.href.replace(/\/$/, ""),
      artifacts,
      opened,
      revealed,
    });
  } finally {
    await desk.stop();
    for (const path of written) rmSync(path, { force: true });
  }
}

test("artifact routes look up opaque IDs and protect previews", async () => {
  await withDesk(async ({ base, artifacts, opened, revealed }) => {
    const listed = await (await fetch(`${base}/artifacts`)).json();
    assert.ok(listed.artifacts.length >= 1);
    const notes = listed.artifacts.find((item) => item.relativePath.endsWith("notes.md"));
    const html = listed.artifacts.find((item) => item.relativePath.endsWith("preview.html"));
    assert.ok(notes.id);
    assert.equal(notes.relativePath.includes(".."), false);

    const missing = await fetch(`${base}/artifacts/unknown/preview`);
    assert.equal(missing.status, 404);

    const preview = await fetch(`${base}/artifacts/${html.id}/preview`);
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get("content-type"), /text\/html/);
    assert.match(preview.headers.get("content-security-policy") || "", /sandbox/);
    assert.match(preview.headers.get("content-security-policy") || "", /default-src 'none'/);

    const forbidden = await fetch(`${base}/artifacts/${notes.id}/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: JSON.stringify({ expectedControllerGeneration: 2 }),
    });
    assert.equal(forbidden.status, 403);

    const stale = await fetch(`${base}/artifacts/${notes.id}/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ expectedControllerGeneration: 1 }),
    });
    assert.equal(stale.status, 409);

    const openedRes = await fetch(`${base}/artifacts/${notes.id}/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ expectedControllerGeneration: 2 }),
    });
    assert.equal(openedRes.status, 200);
    assert.equal(opened.length, 1);
    assert.ok(opened[0].endsWith("notes.md"));
    assert.ok(!opened[0].includes(".."));
    assert.equal(resolveInside(REPO, opened[0]), true);

    const revealRes = await fetch(`${base}/artifacts/${notes.id}/reveal`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: JSON.stringify({ expectedControllerGeneration: 2 }),
    });
    assert.equal(revealRes.status, 200);
    assert.equal(revealed.length, 1);
    assert.equal(artifacts.list()[0].id.startsWith("http-art-"), true);
  });
});

function resolveInside(root, absolute) {
  const normalizedRoot = root.replace(/\//g, "\\").toLowerCase();
  const normalizedPath = absolute.replace(/\//g, "\\").toLowerCase();
  return normalizedPath.startsWith(normalizedRoot);
}
