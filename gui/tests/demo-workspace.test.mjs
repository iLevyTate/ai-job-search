import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isJobSearchWorkspace } from "../claude.mjs";
import { readApplications, readJobs, readProgress } from "../desk-data.mjs";
import {
  DEMO_LABEL,
  DEMO_PERSON,
  defaultDemoRoot,
  isDemoFlag,
  demoTurnFor,
  materializeDemoWorkspace,
  redactText,
  redactionTerms,
} from "../demo-workspace.mjs";
import { sharedStateDir } from "../workspace.mjs";

test("isDemoFlag reads the env and the argv switch", () => {
  assert.equal(isDemoFlag({ JOB_SEARCH_DEMO: "1" }, []), true);
  assert.equal(isDemoFlag({}, ["node", "server.mjs", "--demo"]), true);
  assert.equal(isDemoFlag({}, ["node", "server.mjs"]), false);
});

test("defaultDemoRoot stays out of the hunt folder", () => {
  const home = mkdtempSync(join(tmpdir(), "desk-demo-home-"));
  const env = { APPDATA: join(home, "AppData", "Roaming") };
  assert.equal(defaultDemoRoot(env), join(sharedStateDir(home, "win32", env), "demo-workspace"));
  assert.ok(!defaultDemoRoot(env).includes("GitHub"));
});

test("materializeDemoWorkspace is a valid workspace with only fictional hunt data", () => {
  const dest = join(mkdtempSync(join(tmpdir(), "desk-demo-")), "workspace");
  const root = materializeDemoWorkspace(dest, {
    home: join(tmpdir(), "not-the-user"),
    env: { USERNAME: "realuser", USER: "realuser" },
  });
  assert.equal(root, dest);
  assert.equal(isJobSearchWorkspace(root), true);

  const profile = readFileSync(join(root, "CLAUDE.md"), "utf8");
  assert.match(profile, new RegExp(DEMO_PERSON.name));
  assert.doesNotMatch(profile, /\[YOUR_NAME\]|realuser/i);

  const jobs = readJobs(root);
  assert.ok(jobs.some((job) => job.company === "Harbor Health"));
  assert.ok(jobs.some((job) => job.company === "Northstar Practice Labs"));
  assert.ok(jobs.every((job) => /example\.com/.test(job.url) || !job.url));

  const apps = readApplications(root);
  assert.equal(apps.length, 2);
  assert.ok(apps.every((app) => app.cvFile.startsWith("cv/Alex_Rivera_")));
  assert.ok(apps.every((app) => !/realuser/i.test(JSON.stringify(app))));

  const progress = readProgress(root);
  assert.equal(progress.steps.find((step) => step.id === "setup")?.done, true);
  assert.ok(progress.counts.jobs >= 4);
  assert.equal(progress.counts.applications, 2);
});

test("redactText strips home paths, emails, and phones", () => {
  const home = join(tmpdir(), "desk-redact-home", "samlee");
  const env = { USERNAME: "samlee", USER: "samlee" };
  const terms = redactionTerms({ home, env });
  const out = redactText(
    `CVs live in ${home}\\cv\\Sam_Lee.pdf. Email samlee@work.test or 555-0148.`,
    terms,
  );
  assert.doesNotMatch(out, /samlee/i);
  assert.doesNotMatch(out, /555-0148/);
  assert.match(out, new RegExp(DEMO_PERSON.email.replace(".", "\\.")));
  assert.match(out, new RegExp(DEMO_PERSON.phone));
});

test("redactText applies split-identifier lines", () => {
  const home = mkdtempSync(join(tmpdir(), "desk-id-home-"));
  const appdata = join(home, "AppData", "Roaming");
  mkdirSync(join(appdata, "ai-job-search"), { recursive: true });
  writeFileSync(join(appdata, "ai-job-search", "split-identifiers.txt"), "SecretCorp\n");
  const env = { APPDATA: appdata, USERNAME: "x" };
  const out = redactText("Applied to SecretCorp last week.", redactionTerms({ home, env }));
  assert.doesNotMatch(out, /SecretCorp/);
});

test("DEMO_LABEL is what the page is allowed to show", () => {
  assert.equal(DEMO_LABEL, "Demo workspace");
  assert.doesNotMatch(DEMO_LABEL, /Users|home|AppData/i);
});

test("demo turns follow the step and never start Claude", () => {
  assert.match(demoTurnFor("/scrape").reply, /Found 5 openings/);
  assert.doesNotMatch(demoTurnFor("/scrape").reply, /drafted the CV/i);
  assert.match(demoTurnFor("/rank").reply, /88/);
  assert.match(demoTurnFor("/autofill https://jobs.example.com/harbor-health-ml/apply").reply, /You click Submit/);
  assert.match(demoTurnFor("/apply https://jobs.example.com/harbor-health-ml").reply, /ready for you to read/);
  assert.match(demoTurnFor("Draft the Harbor Health CV.").reply, /ready for you to read/);
});
