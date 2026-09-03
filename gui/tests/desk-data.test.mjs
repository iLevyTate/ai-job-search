import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkTools,
  csvRecords,
  parseCsv,
  readApplications,
  readJobs,
  readProgress,
  resolveWorkspaceFile,
  safeDocumentName,
  saveDocument,
  setJobMark,
} from "../desk-data.mjs";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "desk-data-"));
  mkdirSync(join(root, "job_scraper"), { recursive: true });
  mkdirSync(join(root, "documents", "cv"), { recursive: true });
  mkdirSync(join(root, "cv"), { recursive: true });
  writeFileSync(join(root, "CLAUDE.md"), "# Job Application Assistant for [YOUR_NAME]\n");
  return root;
}

test("parseCsv handles quoted commas, doubled quotes, and CRLF", () => {
  const rows = parseCsv('a,b\r\n"x, y","say ""hi"""\n');
  assert.deepEqual(rows, [["a", "b"], ["x, y", 'say "hi"']]);
  assert.deepEqual(csvRecords("k1,k2\n1,2\n"), [{ k1: "1", k2: "2" }]);
});

test("jobs merge the scraper store, the tracker, and the person's own marks", () => {
  const root = workspace();
  writeFileSync(join(root, "job_scraper", "seen_jobs.json"), JSON.stringify({
    seen: {
      "https://jobs.example/1": { title: "Staff Engineer", company: "Acme", url: "https://jobs.example/1", first_seen: "2026-09-01", status: "ranked", rank_score: 82, rank_verdict: "strong fit", strengths: ["Python"], location: "Remote" },
      "https://jobs.example/2": { title: "Platform Lead", company: "Globex", url: "https://jobs.example/2", first_seen: "2026-08-30", status: "new", location: "PASS" },
      "https://jobs.example/3": { title: "Old Role", company: "Initech", url: "javascript:alert(1)", first_seen: "2026-07-01", status: "expired" },
    },
  }));
  writeFileSync(join(root, "job_search_tracker.csv"), "date,company,sector,role,role_type,channel,status,contact_person,fit_rating,notes,cv_file,cover_letter_file,source,deadline\n2026-09-02,acme,Tech,staff engineer,IC,ATS,applied,,4,,cv/main_acme.pdf,,,\n");
  writeFileSync(join(root, "cv", "main_acme.pdf"), "pdf");
  setJobMark(root, "https://jobs.example/2", "interested");
  const jobs = readJobs(root);
  assert.equal(jobs[0].key, "https://jobs.example/1", "ranked jobs come first");
  assert.equal(jobs[0].bucket, "applied", "tracker match wins, case-insensitively");
  assert.equal(jobs[0].applicationStatus, "applied");
  assert.equal(jobs[0].location, "Remote");
  assert.equal(jobs[1].bucket, "interested");
  assert.equal(jobs[1].location, "", "a legacy PASS/FAIL verdict is not a place");
  assert.equal(jobs[2].bucket, "ignored", "expired entries are out of the way");
  assert.equal(jobs[2].url, "", "only http(s) links are offered");
  setJobMark(root, "https://jobs.example/2", null);
  assert.equal(readJobs(root)[1].bucket, "new");
  assert.throws(() => setJobMark(root, "https://jobs.example/2", "maybe"));

  const apps = readApplications(root);
  assert.equal(apps.length, 1);
  assert.equal(apps[0].cvFile, "cv/main_acme.pdf");
  assert.equal(apps[0].coverLetterFile, "");
  assert.equal(apps[0].open, true);
});

test("progress reads the placeholder profile, documents, jobs, and applications", () => {
  const root = workspace();
  let progress = readProgress(root);
  assert.equal(progress.next, "setup");
  assert.deepEqual(progress.steps.map((step) => step.done), [false, false, false, false]);
  writeFileSync(join(root, "CLAUDE.md"), "# Job Application Assistant for Sam Lee\n");
  writeFileSync(join(root, "documents", "cv", "sam.pdf"), "pdf");
  progress = readProgress(root);
  assert.equal(progress.next, "scrape");
  assert.equal(progress.counts.documents, 1);
});

test("documents are saved with a safe name inside the documents folder", () => {
  const root = workspace();
  assert.equal(safeDocumentName("../../etc/passwd"), "");
  assert.equal(safeDocumentName("My CV (2026).pdf"), "My-CV-(2026).pdf");
  assert.equal(safeDocumentName("script.exe"), "");
  const first = saveDocument(root, { name: "cv.pdf", kind: "cv", bytes: Buffer.from("one") });
  const second = saveDocument(root, { name: "cv.pdf", kind: "cv", bytes: Buffer.from("two") });
  assert.equal(first.relativePath, "documents/cv/cv.pdf");
  assert.equal(second.relativePath, "documents/cv/cv (2).pdf");
  assert.equal(readFileSync(join(root, first.relativePath), "utf8"), "one");
  assert.throws(() => saveDocument(root, { name: "x.pdf", bytes: Buffer.alloc(0) }), /empty/);
  assert.equal(saveDocument(root, { name: "notes.txt", kind: "nope", bytes: Buffer.from("n") }).kind, "cv");
});

test("only files inside the known folders can be previewed or opened", () => {
  const root = workspace();
  writeFileSync(join(root, "cv", "main.pdf"), "pdf");
  writeFileSync(join(root, "CLAUDE.md"), "secret");
  assert.equal(resolveWorkspaceFile(root, "cv/main.pdf").relativePath, "cv/main.pdf");
  assert.equal(resolveWorkspaceFile(root, "CLAUDE.md"), null);
  assert.equal(resolveWorkspaceFile(root, "../cv/main.pdf"), null);
  assert.equal(resolveWorkspaceFile(root, "cv/../CLAUDE.md"), null);
  assert.equal(resolveWorkspaceFile(root, "cv"), null);
});

test("the tools check names what is missing and how to get it", () => {
  const root = workspace();
  const present = new Set(["claude", "python3"]);
  const resolver = (name) => (present.has(name) ? process.execPath : name);
  const info = checkTools({ workspace: root, resolver, env: { HOME: root } });
  const byId = Object.fromEntries(info.tools.map((tool) => [tool.id, tool]));
  assert.equal(byId.claude.installed, true);
  assert.equal(byId.python.installed, true);
  assert.equal(byId.bun.installed, false);
  assert.ok(byId.lualatex.install.length > 10);
  assert.ok(info.missingRequired.includes("lualatex"));
  assert.ok(!info.missingRequired.includes("git"), "optional tools never block");
  assert.equal(byId.chromium.installed, false);
});
