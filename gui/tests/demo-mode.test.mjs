import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { DEMO_LABEL, DEMO_PERSON } from "../demo-workspace.mjs";
import { startDesk } from "../server.mjs";
import { readSharedWorkspace, sharedWorkspacePath } from "../workspace.mjs";

const home = mkdtempSync(join(tmpdir(), "desk-demo-mode-"));
const appdata = join(home, "AppData", "Roaming");
mkdirSync(appdata, { recursive: true });

let desk;
let base;
const priorAppdata = process.env.APPDATA;
const priorDemo = process.env.JOB_SEARCH_DEMO;

before(async () => {
  process.env.APPDATA = appdata;
  process.env.JOB_SEARCH_GUI_NO_BROWSER = "1";
  process.env.JOB_SEARCH_DEMO_ROOT = join(home, "demo-workspace");
  desk = await startDesk({
    demo: true,
    demoRoot: join(home, "demo-workspace"),
    openBrowser: false,
    port: 0,
  });
  base = desk.href.replace(/\/$/, "");
});

after(() => {
  desk?.stop();
  if (priorAppdata === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = priorAppdata;
  if (priorDemo === undefined) delete process.env.JOB_SEARCH_DEMO;
  else process.env.JOB_SEARCH_DEMO = priorDemo;
  delete process.env.JOB_SEARCH_DEMO_ROOT;
});

test("demo mode reports the generic folder name, not a disk path", async () => {
  const res = await fetch(`${base}/workspace`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.demo, true);
  assert.equal(body.root, DEMO_LABEL);
  assert.doesNotMatch(body.root, /Users|AppData|GitHub/i);
  assert.equal(desk.displayWorkspace, DEMO_LABEL);
  assert.doesNotMatch(JSON.stringify(body), /@/);
});

test("demo mode serves fictional jobs and applications", async () => {
  const jobs = await (await fetch(`${base}/jobs`)).json();
  assert.ok(jobs.jobs.some((job) => job.company === "Harbor Health"));
  assert.doesNotMatch(JSON.stringify(jobs), /@/);

  const apps = await (await fetch(`${base}/applications`)).json();
  assert.ok(apps.applications.some((app) => app.company === "Harbor Health"));
  assert.ok(apps.applications.every((app) => String(app.cvFile).includes(DEMO_PERSON.name.replace(" ", "_"))));
});

test("demo mode does not rewrite the saved workspace pointer", () => {
  assert.equal(readSharedWorkspace(home, "win32", { APPDATA: appdata }), "");
  try {
    readFileSync(sharedWorkspacePath(home, "win32", { APPDATA: appdata }), "utf8");
    assert.fail("workspace.json should not exist");
  } catch (error) {
    assert.equal(error.code, "ENOENT");
  }
});

test("demo mode hides the signed-in email", async () => {
  const res = await fetch(`${base}/auth/status`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.email, "");
  assert.equal(body.orgName, "");
  assert.doesNotMatch(JSON.stringify(body), /@|Users[\\/]/i);
});

test("demo mode replays chat and does not start Claude", async () => {
  const ac = new AbortController();
  const stream = await fetch(`${base}/events`, { signal: ac.signal });
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let sent = false;
  const seen = [];
  let reply = "";
  let doneTurn = false;
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    while (!doneTurn) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const chunks = buf.split("\n\n");
      buf = chunks.pop() || "";
      for (const chunk of chunks) {
        const type = /event: (\S+)/.exec(chunk)?.[1] || "";
        const raw = /data: (.*)/.exec(chunk)?.[1] || "";
        seen.push(type);
        if (type === "delta") reply += JSON.parse(raw).text || "";
        if (type === "hello" && !sent) {
          sent = true;
          const res = await fetch(`${base}/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: "Draft the Harbor Health CV." }),
          });
          assert.equal(res.status, 202);
        }
        if (type === "idle" && reply.includes("ready for you to read")) doneTurn = true;
      }
    }
  } catch (error) {
    if (error.name !== "AbortError") throw error;
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    ac.abort();
  }
  assert.equal(sent, true);
  assert.match(reply, /ready for you to read/);
  assert.equal(seen.includes("turn-error"), false);
  const cv = await (await fetch(`${base}/workspace-file?path=${encodeURIComponent("cv/Alex_Rivera_Harbor_Health_Resume.txt")}`)).text();
  assert.match(cv, /clinical operations/);
  assert.doesNotMatch(cv, /documentclass|Fictional demo|Practice row/i);
});

test("demo mode refuses Open in Terminal so the real folder stays closed", async () => {
  const res = await fetch(`${base}/workspace/cli`, { method: "POST" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.error, /demo/i);
});
