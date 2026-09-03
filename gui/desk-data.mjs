/**
 * What the desk shows outside the conversation: the jobs the scraper found,
 * the applications in the tracker, first-run progress, the tools the steps
 * need, and the documents folder. Everything here reads the files the
 * workflows already write; nothing is a second source of truth.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, normalize, relative, resolve, sep } from "node:path";
import { resolveCommand } from "./claude.mjs";

const IS_WIN = process.platform === "win32";

// ---------------------------------------------------------------------------
// CSV

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const src = String(text || "");
  for (let index = 0; index < src.length; index += 1) {
    const char = src[index];
    if (quoted) {
      if (char === '"') {
        if (src[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && src[index + 1] === "\n") index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ""));
}

export function csvRecords(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((cell) => cell.trim());
  return rows.slice(1).map((cells) => Object.fromEntries(header.map((key, index) => [key, (cells[index] ?? "").trim()])));
}

// ---------------------------------------------------------------------------
// Tracker and jobs

const TRACKER_FILE = "job_search_tracker.csv";
const SEEN_FILE = join("job_scraper", "seen_jobs.json");
const MARKS_FILE = join(".claude", "desk", "jobs.json");

function readTextIfExists(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function normalizeKey(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

const OPEN_STATUSES = new Set(["applied", "in_progress", "interview", "interviewing", "offer", "screening", "phone_screen"]);

export function readApplications(workspace) {
  const records = csvRecords(readTextIfExists(join(workspace, TRACKER_FILE)));
  return records.map((row, index) => {
    const folder = `${row.company}_${row.role}`.replace(/[^A-Za-z0-9._ -]+/g, "").replace(/\s+/g, "_");
    const cv = row.cv_file ? relativeIfInside(workspace, row.cv_file) : "";
    const letter = row.cover_letter_file ? relativeIfInside(workspace, row.cover_letter_file) : "";
    return {
      id: `app-${index + 1}`,
      date: row.date || "",
      company: row.company || "",
      role: row.role || "",
      sector: row.sector || "",
      roleType: row.role_type || "",
      channel: row.channel || "",
      status: row.status || "",
      open: OPEN_STATUSES.has(normalizeKey(row.status).replace(/ /g, "_")),
      contact: row.contact_person || "",
      fit: row.fit_rating || "",
      notes: row.notes || "",
      cvFile: cv && existsSync(join(workspace, cv)) ? cv : "",
      coverLetterFile: letter && existsSync(join(workspace, letter)) ? letter : "",
      source: row.source || "",
      deadline: row.deadline || "",
      archive: existsSync(join(workspace, "documents", "applications", folder)) ? join("documents", "applications", folder).split(sep).join("/") : "",
    };
  });
}

function relativeIfInside(workspace, candidate) {
  const absolute = resolve(workspace, String(candidate));
  const rel = relative(workspace, absolute);
  if (!rel || rel.startsWith("..") || rel.includes(`..${sep}`)) return "";
  return rel.split(sep).join("/");
}

function readMarks(workspace) {
  try {
    const data = JSON.parse(readTextIfExists(join(workspace, MARKS_FILE)) || "{}");
    return data && typeof data.marks === "object" && data.marks ? data.marks : {};
  } catch {
    return {};
  }
}

export function setJobMark(workspace, key, mark) {
  if (typeof key !== "string" || !key || key.length > 500) throw new Error("bad key");
  if (mark !== "interested" && mark !== "ignored" && mark !== null) throw new Error("bad mark");
  const marks = readMarks(workspace);
  if (mark === null) delete marks[key];
  else marks[key] = { mark, at: new Date().toISOString() };
  const dir = join(workspace, ".claude", "desk");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(workspace, MARKS_FILE), JSON.stringify({ marks }, null, 2), { mode: 0o600 });
  return marks;
}

export function readJobs(workspace) {
  let seen = {};
  try {
    const data = JSON.parse(readTextIfExists(join(workspace, SEEN_FILE)) || "{}");
    seen = data && typeof data.seen === "object" && data.seen ? data.seen : {};
  } catch {
    seen = {};
  }
  const marks = readMarks(workspace);
  const applications = readApplications(workspace);
  const applied = new Map(applications.map((app) => [`${normalizeKey(app.company)}|${normalizeKey(app.role)}`, app]));
  const jobs = [];
  for (const [key, entry] of Object.entries(seen)) {
    if (!entry || typeof entry !== "object") continue;
    const title = String(entry.title || "").trim();
    const company = String(entry.company || "").trim();
    const application = applied.get(`${normalizeKey(company)}|${normalizeKey(title)}`) || null;
    const mark = marks[key]?.mark || null;
    const scraperStatus = String(entry.status || "new");
    let bucket = "new";
    if (application) bucket = "applied";
    else if (mark === "ignored" || scraperStatus === "expired" || scraperStatus === "skipped") bucket = "ignored";
    else if (mark === "interested") bucket = "interested";
    jobs.push({
      key,
      title,
      company,
      location: typeof entry.location === "string" && !/^(PASS|FAIL|FLAG)$/.test(entry.location) ? entry.location : "",
      url: typeof entry.url === "string" && /^https?:\/\//i.test(entry.url) ? entry.url : "",
      firstSeen: entry.first_seen || "",
      postedDate: entry.posted_date || null,
      deadline: entry.deadline || null,
      fit: entry.fit || "",
      scraperStatus,
      rankScore: Number.isFinite(entry.rank_score) ? entry.rank_score : null,
      rankVerdict: entry.rank_verdict || "",
      strengths: Array.isArray(entry.strengths) ? entry.strengths.slice(0, 3) : [],
      gaps: Array.isArray(entry.gaps) ? entry.gaps.slice(0, 3) : [],
      portal: entry.portal || entry.source || "",
      mark,
      bucket,
      applicationStatus: application?.status || "",
    });
  }
  jobs.sort((left, right) => {
    const score = (right.rankScore ?? -1) - (left.rankScore ?? -1);
    if (score) return score;
    return String(right.firstSeen).localeCompare(String(left.firstSeen));
  });
  return jobs;
}

// ---------------------------------------------------------------------------
// Progress

export function readProgress(workspace) {
  const profile = readTextIfExists(join(workspace, "CLAUDE.md"));
  const profileDone = Boolean(profile) && !/\[YOUR_NAME\]/.test(profile);
  const documents = countDocuments(workspace);
  const jobs = readJobs(workspace);
  const applications = readApplications(workspace);
  const steps = [
    { id: "setup", title: "Set up your profile", done: profileDone, action: "setup", hint: profileDone ? "Claude knows who you are." : "Takes a few minutes. Claude asks about your experience and what you want." },
    { id: "documents", title: "Add your CV", done: documents.count > 0, action: "documents", hint: documents.count ? `${documents.count} file${documents.count === 1 ? "" : "s"} in your documents folder.` : "Optional but worth it: Claude reads your real CV instead of asking." },
    { id: "scrape", title: "Find jobs", done: jobs.length > 0, action: "scrape", hint: jobs.length ? `${jobs.length} job${jobs.length === 1 ? "" : "s"} found so far.` : "Searches the job boards for openings that match you." },
    { id: "apply", title: "Apply to one", done: applications.length > 0, action: "apply", hint: applications.length ? `${applications.length} application${applications.length === 1 ? "" : "s"} tracked.` : "Claude writes a CV and cover letter for a job you pick." },
  ];
  const next = steps.find((step) => !step.done) || null;
  return { steps, next: next?.id || null, counts: { documents: documents.count, jobs: jobs.length, applications: applications.length } };
}

const DOCUMENT_KINDS = ["cv", "linkedin", "diplomas", "references", "postings"];

function countDocuments(workspace) {
  let count = 0;
  const perKind = {};
  for (const kind of DOCUMENT_KINDS) {
    let files = [];
    try {
      files = readdirSync(join(workspace, "documents", kind)).filter((name) => !name.startsWith(".") && !/^readme/i.test(name));
    } catch {
      files = [];
    }
    perKind[kind] = files.length;
    count += files.length;
  }
  return { count, perKind };
}

// ---------------------------------------------------------------------------
// Documents

const DOCUMENT_EXTENSIONS = new Set([".pdf", ".tex", ".txt", ".md", ".docx", ".doc", ".rtf", ".odt", ".png", ".jpg", ".jpeg"]);
export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;

export function safeDocumentName(name) {
  const base = basename(String(name || "")).replace(/[\\/:*?"<>|\u0000-\u001f -]+/g, "-").trim();
  if (!base || base.startsWith(".")) return "";
  if (!DOCUMENT_EXTENSIONS.has(extname(base).toLowerCase())) return "";
  return base.slice(0, 120);
}

export function saveDocument(workspace, { name, kind = "cv", bytes }) {
  const folder = DOCUMENT_KINDS.includes(kind) ? kind : "cv";
  const safe = safeDocumentName(name);
  if (!safe) throw new Error("That file type cannot be added. PDF, Word, text, LaTeX, or an image of a certificate work.");
  if (!bytes?.length) throw new Error("The file was empty.");
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error("That file is larger than 25 MB.");
  const dir = join(workspace, "documents", folder);
  mkdirSync(dir, { recursive: true });
  let target = join(dir, safe);
  let counter = 2;
  while (existsSync(target)) {
    const ext = extname(safe);
    target = join(dir, `${safe.slice(0, safe.length - ext.length)} (${counter})${ext}`);
    counter += 1;
  }
  writeFileSync(target, bytes, { mode: 0o600 });
  return { relativePath: relative(workspace, target).split(sep).join("/"), kind: folder };
}

// ---------------------------------------------------------------------------
// Workspace files the tabs may show or open

const OPENABLE_ROOTS = ["cv", "cover_letters", "documents", "job_scraper", "job_search_tracker.csv"];

export function resolveWorkspaceFile(workspace, candidate) {
  const text = String(candidate || "");
  if (!text || text.includes("\u0000")) return null;
  const absolute = resolve(workspace, normalize(text));
  const rel = relative(workspace, absolute);
  if (!rel || rel.startsWith("..") || rel.includes(`..${sep}`)) return null;
  const first = rel.split(sep)[0];
  if (!OPENABLE_ROOTS.includes(first)) return null;
  if (!existsSync(absolute) || !statSync(absolute).isFile()) return null;
  return { absolutePath: absolute, relativePath: rel.split(sep).join("/") };
}

export function revealWithSystem(absolutePath) {
  const detach = { detached: true, stdio: "ignore" };
  let child;
  if (IS_WIN) child = spawn("explorer", [`/select,${absolutePath}`], detach);
  else if (process.platform === "darwin") child = spawn("open", ["-R", absolutePath], detach);
  else child = spawn("xdg-open", [resolve(absolutePath, "..")], detach);
  child.on("error", () => {});
  child.unref();
}

export const systemOpener = { open: openWithSystem, reveal: revealWithSystem };

export function openWithSystem(absolutePath) {
  const detach = { detached: true, stdio: "ignore" };
  let child;
  if (IS_WIN) child = spawn("cmd", ["/c", "start", "", absolutePath], detach);
  else if (process.platform === "darwin") child = spawn("open", [absolutePath], detach);
  else child = spawn("xdg-open", [absolutePath], detach);
  child.on("error", () => {});
  child.unref();
}

// ---------------------------------------------------------------------------
// Tools the steps need

const TOOLS = [
  { id: "claude", name: "Claude Code", purpose: "Runs every step.", requiredFor: "everything", commands: ["claude"] },
  { id: "python", name: "Python 3", purpose: "Checks that a finished CV reads correctly to employer systems.", requiredFor: "Apply", commands: ["python3", "python"], url: "https://www.python.org/downloads/" },
  { id: "bun", name: "Bun", purpose: "Runs the job-board searches and Autofill.", requiredFor: "Find jobs, Autofill", commands: ["bun"], url: "https://bun.sh" },
  { id: "lualatex", name: "TeX (lualatex)", purpose: "Turns the CV into a PDF.", requiredFor: "Apply (PDF)", commands: ["lualatex"], url: "https://tug.org/texlive/" },
  { id: "xelatex", name: "TeX (xelatex)", purpose: "Turns the cover letter into a PDF.", requiredFor: "Apply (PDF)", commands: ["xelatex"], url: "https://tug.org/texlive/" },
  { id: "git", name: "Git", purpose: "Optional. Lets Desk download updates and keep a history of your folder.", requiredFor: "optional", commands: ["git"], url: "https://git-scm.com/downloads" },
  { id: "pdftotext", name: "pdftotext", purpose: "Optional. A second way to read PDFs for the employer-system check.", requiredFor: "optional", commands: ["pdftotext"], url: "https://poppler.freedesktop.org/" },
];

function playwrightChromiumPresent(workspace, env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  const candidates = [
    join(workspace, ".agents", "skills", "ats-autofill", "cli", "node_modules", "playwright-core"),
    join(home, ".cache", "ms-playwright"),
    join(home, "Library", "Caches", "ms-playwright"),
    join(home, "AppData", "Local", "ms-playwright"),
  ];
  if (env.PLAYWRIGHT_BROWSERS_PATH) candidates.unshift(env.PLAYWRIGHT_BROWSERS_PATH);
  return candidates.some((path) => {
    try {
      return readdirSync(path).some((name) => /chromium/i.test(name));
    } catch {
      return false;
    }
  });
}

export function checkTools({ workspace, env = process.env, resolver = resolveCommand } = {}) {
  const platform = process.platform;
  const results = TOOLS.map((tool) => {
    let found = "";
    for (const command of tool.commands) {
      const path = resolver(command, env);
      if (path && path !== command && existsSync(path)) {
        found = path;
        break;
      }
    }
    return { ...tool, commands: undefined, installed: Boolean(found), path: found, install: installHint(tool.id, platform) };
  });
  results.push({
    id: "chromium",
    name: "Browser for Autofill",
    purpose: "The browser Autofill drives to fill in employer forms.",
    requiredFor: "Autofill",
    installed: playwrightChromiumPresent(workspace, env),
    path: "",
    url: "https://playwright.dev/docs/browsers",
    install: "In a terminal, from your job-search folder: cd .agents/skills/ats-autofill/cli && bun install && bunx playwright install chromium",
  });
  const missingRequired = results.filter((tool) => !tool.installed && tool.requiredFor !== "optional");
  return { tools: results, missingRequired: missingRequired.map((tool) => tool.id), platform };
}

function installHint(id, platform) {
  const mac = platform === "darwin";
  const win = platform === "win32";
  switch (id) {
    case "claude":
      return "Desk installs this for you. If it is missing, reload this page.";
    case "python":
      return mac ? "Install from python.org, or in a terminal: brew install python" : win ? "Install from python.org and tick \"Add python.exe to PATH\"." : "In a terminal: sudo apt install python3 (or your distribution's equivalent)";
    case "bun":
      return win ? "In PowerShell: powershell -c \"irm bun.sh/install.ps1 | iex\"" : "In a terminal: curl -fsSL https://bun.sh/install | bash";
    case "lualatex":
    case "xelatex":
      return mac ? "Install MacTeX from tug.org/mactex (large download), or BasicTeX plus the packages listed in SETUP.md." : win ? "Install MiKTeX from miktex.org, or TeX Live." : "In a terminal: sudo apt install texlive-luatex texlive-xetex texlive-fonts-extra (or install TeX Live)";
    case "git":
      return mac ? "In a terminal: xcode-select --install" : win ? "Install Git for Windows from git-scm.com." : "In a terminal: sudo apt install git";
    case "pdftotext":
      return mac ? "In a terminal: brew install poppler" : win ? "Optional: install poppler for Windows, or skip it." : "In a terminal: sudo apt install poppler-utils";
    default:
      return "";
  }
}
