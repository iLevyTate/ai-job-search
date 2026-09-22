/**
 * Isolated hunt folder for screen shares and recordings. Fictional person,
 * jobs, and files. The real workspace pointer is left alone.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SAMPLE_POSTING } from "./sample-job.mjs";
import { sharedStateDir } from "./workspace.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = join(HERE, "..");

export const DEMO_LABEL = "Demo workspace";

// A fixed reply for demo chat. Demo mode never starts Claude Code.
export const DEMO_TURN_REPLY = "Harbor Health is an 88. Strong fit on production RAG and healthcare delivery. One gap: imaging-specific tooling.\n\nI drafted the CV. It is in Applications, ready for you to read. You send it.";

export const DEMO_CV_PATH = "cv/Alex_Rivera_Harbor_Health_Resume.txt";

const DEMO_TURNS = [
  {
    test: (text) => text.startsWith("/setup"),
    reply: "Profile set. Alex Rivera, remote in the United States, aiming at staff AI engineer roles.",
    tools: [{ name: "Read", file: "CLAUDE.md" }],
  },
  {
    test: (text) => text.startsWith("/scrape"),
    reply: "Found 5 openings. Harbor Health leads. Staff machine learning engineer, remote.",
    tools: [],
  },
  {
    test: (text) => text.startsWith("/rank"),
    reply: "Harbor Health is an 88. Strong fit on production RAG and healthcare delivery. One gap: imaging-specific tooling.",
    tools: [{ name: "Read", file: "job_scraper/seen_jobs.json" }],
  },
  {
    test: (text) => text.startsWith("/autofill"),
    reply: "The Harbor Health form is filled from the profile. Read it. You click Submit. Desk does not.",
    tools: [],
  },
  {
    test: (text) => text.startsWith("/interview"),
    reply: "Harbor Health prep is ready. They will ask how retrieval stays reviewed before it reaches a record.",
    tools: [{ name: "Read", file: "cv/Alex_Rivera_Harbor_Health_Resume.txt" }],
  },
  {
    test: (text) => text.startsWith("/outcome"),
    reply: "Noted. Harbor Health stays drafted until you send it.",
    tools: [],
  },
];

export function demoTurnFor(prompt) {
  const text = String(prompt || "").trim().toLowerCase();
  const match = DEMO_TURNS.find((turn) => turn.test(text));
  if (match) return { reply: match.reply, tools: match.tools };
  return {
    reply: DEMO_TURN_REPLY,
    tools: [
      { name: "Read", file: "CLAUDE.md" },
      { name: "Write", file: DEMO_CV_PATH },
    ],
  };
}

export const DEMO_PERSON = {
  name: "Alex Rivera",
  email: "alex.rivera@example.com",
  phone: "555-0100",
  location: "Remote, United States",
  headline: "Staff AI engineer",
};

const TRACKER_HEADER =
  "date,company,sector,role,role_type,channel,status,contact_person,fit_rating,notes,cv_file,cover_letter_file,source,deadline";

const JOBS = [
  {
    key: "https://jobs.example.com/harbor-health-ml",
    title: "Staff Machine Learning Engineer",
    company: "Harbor Health",
    location: "Remote, United States",
    url: "https://jobs.example.com/harbor-health-ml",
    first_seen: "2026-09-12",
    posted_date: "2026-09-10",
    status: "ranked",
    rank_score: 88,
    rank_verdict: "strong fit",
    strengths: ["Production RAG", "Healthcare delivery"],
    gaps: ["Imaging-specific tooling"],
    portal: "",
  },
  {
    key: "https://jobs.example.com/northstar-staff",
    title: "Staff Software Engineer",
    company: "Northstar Practice Labs",
    location: "Remote, United States",
    url: "https://jobs.example.com/northstar-staff",
    first_seen: "2026-09-14",
    posted_date: "2026-09-13",
    status: "ranked",
    rank_score: 81,
    rank_verdict: "strong fit",
    strengths: ["Agent workflows", "Evaluation"],
    gaps: [],
    portal: "",
  },
  {
    key: "https://jobs.example.com/linden-ai",
    title: "Senior AI Engineer",
    company: "Linden Analytics",
    location: "Hybrid, United States",
    url: "https://jobs.example.com/linden-ai",
    first_seen: "2026-09-15",
    status: "new",
    portal: "",
  },
  {
    key: "https://jobs.example.com/fieldstone-scientist",
    title: "Applied Scientist",
    company: "Fieldstone Labs",
    location: "Remote, United States",
    url: "https://jobs.example.com/fieldstone-scientist",
    first_seen: "2026-09-11",
    status: "new",
    portal: "",
  },
  {
    key: "https://jobs.example.com/cove-staff-ai",
    title: "Staff AI Engineer",
    company: "Cove Systems",
    location: "Remote, United States",
    url: "https://jobs.example.com/cove-staff-ai",
    first_seen: "2026-09-09",
    status: "ranked",
    rank_score: 74,
    rank_verdict: "good fit",
    strengths: ["On-device inference"],
    gaps: ["Large-scale training"],
    portal: "",
  },
];

export function isDemoFlag(env = process.env, argv = process.argv) {
  return env.JOB_SEARCH_DEMO === "1" || argv.includes("--demo");
}

export function defaultDemoRoot(env = process.env) {
  return env.JOB_SEARCH_DEMO_ROOT || join(sharedStateDir(undefined, undefined, env), "demo-workspace");
}

function uniqueTerms(values) {
  const seen = new Set();
  const terms = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (text.length < 3) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(text);
  }
  return terms;
}

function readIdentifierLines(home = homedir(), env = process.env) {
  const file = join(sharedStateDir(home, undefined, env), "split-identifiers.txt");
  try {
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch {
    return [];
  }
}

export function redactionTerms({ home = homedir(), env = process.env } = {}) {
  const homeLeaf = basename(home);
  return uniqueTerms([
    env.USERNAME,
    env.USER,
    env.LOGNAME,
    homeLeaf,
    home,
    ...readIdentifierLines(home, env),
  ]);
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactText(text, terms = redactionTerms()) {
  let out = String(text ?? "");
  out = out.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, DEMO_PERSON.email);
  out = out.replace(/\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/g, DEMO_PERSON.phone);
  const sorted = [...terms].sort((left, right) => right.length - left.length);
  for (const term of sorted) {
    if (term.length < 3) continue;
    out = out.replace(new RegExp(escapeRegExp(term), "gi"), "demo");
  }
  return out;
}

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
}

function claudeProfile() {
  return `# Job Application Assistant for ${DEMO_PERSON.name}

Demo profile. This folder is fictional hunt data for screen shares.

## Identity
- **Name:** ${DEMO_PERSON.name}
- **Location:** ${DEMO_PERSON.location}
- **Contact:** ${DEMO_PERSON.phone} · ${DEMO_PERSON.email}

## Target
- Staff / senior AI engineering roles
- Remote or hybrid in the United States
- Healthcare, research AI, and regulated product work

## Experience
- Ships RAG and agent workflows in Python
- Keeps a human in the loop for customer-facing answers
`;
}

function trackerCsv() {
  const rows = [
    [
      "2026-09-18",
      "Harbor Health",
      "Healthcare",
      "Staff Machine Learning Engineer",
      "IC",
      "ATS",
      "drafted",
      "",
      "4",
      "CV drafted. Ready to send.",
      "cv/Alex_Rivera_Harbor_Health_Resume.txt",
      "cover_letters/Alex_Rivera_Harbor_Health_Cover_Letter.txt",
      "desk",
      "",
    ],
    [
      "2026-09-16",
      "Northstar Practice Labs",
      "Tech",
      "Staff Software Engineer",
      "IC",
      "ATS",
      "drafted",
      "",
      "4",
      "Packet drafted.",
      "cv/Alex_Rivera_Northstar_Resume.txt",
      "cover_letters/Alex_Rivera_Northstar_Cover_Letter.txt",
      "desk",
      "",
    ],
  ];
  const csv = [TRACKER_HEADER, ...rows.map((row) => row.map((cell) => {
    const value = String(cell);
    return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  }).join(","))].join("\n");
  return `${csv}\n`;
}

function resumeText(company, role) {
  const lead = company === "Harbor Health"
    ? "Retrieval over clinical operations documents, with a person reviewing every answer before it reaches a record."
    : "Agent workflows and evaluation for a staff engineering seat.";
  return `${DEMO_PERSON.name}
${DEMO_PERSON.headline}
${DEMO_PERSON.location}
${DEMO_PERSON.email} · ${DEMO_PERSON.phone}

${role}
${company}

${lead}

Agent workflows in Python. Evaluation sits next to the feature.
`;
}

function letterText(company) {
  return `Dear Hiring Manager,

I am applying for the staff seat at ${company}. I ship retrieval and agent workflows in Python, and a person reviews anything that would reach a customer.

${DEMO_PERSON.location}

Sincerely,
${DEMO_PERSON.name}
`;
}

function transcript() {
  return "[]\n";
}

function copyFrameworkFiles(dest, terms) {
  const commandsFrom = join(FRAMEWORK_ROOT, ".claude", "commands");
  const commandsTo = join(dest, ".claude", "commands");
  if (existsSync(commandsFrom)) {
    mkdirSync(commandsTo, { recursive: true });
    for (const name of readdirSync(commandsFrom)) {
      if (!name.endsWith(".md")) continue;
      const text = redactText(readFileSync(join(commandsFrom, name), "utf8"), terms);
      write(join(commandsTo, name), text);
    }
  }

  const skillsFrom = join(FRAMEWORK_ROOT, ".claude", "skills");
  if (!existsSync(skillsFrom)) return;
  for (const name of readdirSync(skillsFrom, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const skillFile = join(skillsFrom, name.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const text = redactText(readFileSync(skillFile, "utf8"), terms);
    write(join(dest, ".claude", "skills", name.name, "SKILL.md"), text);
  }
}

export function materializeDemoWorkspace(dest = defaultDemoRoot(), { home = homedir(), env = process.env } = {}) {
  if (!dest) throw new Error("demo workspace path is required");
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });

  const terms = redactionTerms({ home, env });
  write(join(dest, "AGENTS.md"), "# Demo workspace\n\nFictional hunt data for Job Search Desk demos.\n");
  write(join(dest, "gui", "server.mjs"), "// Marker so Desk treats this folder as a job-search workspace.\n");
  write(join(dest, "CLAUDE.md"), claudeProfile());
  write(join(dest, "job_search_tracker.csv"), trackerCsv());
  write(
    join(dest, "job_scraper", "seen_jobs.json"),
    `${JSON.stringify({ seen: Object.fromEntries(JOBS.map((job) => [job.key, job])) }, null, 2)}\n`,
  );
  write(join(dest, "job_scraper", "postings", "harbor-health_staff-ml-engineer.md"), `# Staff Machine Learning Engineer - Harbor Health

- Location: Remote, United States
- RAG over clinical operations documents
- Human-in-the-loop review before anything reaches a patient record
`);
  write(join(dest, "job_scraper", "postings", "northstar_staff-software-engineer.md"), SAMPLE_POSTING);
  write(join(dest, "cv", "Alex_Rivera_Harbor_Health_Resume.txt"), resumeText("Harbor Health", "Staff Machine Learning Engineer"));
  write(join(dest, "cv", "Alex_Rivera_Northstar_Resume.txt"), resumeText("Northstar Practice Labs", "Staff Software Engineer"));
  write(join(dest, "cover_letters", "Alex_Rivera_Harbor_Health_Cover_Letter.txt"), letterText("Harbor Health"));
  write(join(dest, "cover_letters", "Alex_Rivera_Northstar_Cover_Letter.txt"), letterText("Northstar Practice Labs"));
  write(join(dest, "documents", "cv", "Alex_Rivera_Resume.txt"), `${DEMO_PERSON.name}\n${DEMO_PERSON.headline}\n${DEMO_PERSON.location}\n`);
  write(join(dest, ".claude", "desk", "transcript.json"), transcript());
  write(join(dest, ".claude", "desk", "jobs.json"), `${JSON.stringify({
    marks: {
      "https://jobs.example.com/linden-ai": { mark: "interested", at: "2026-09-15T14:00:00.000Z" },
    },
  }, null, 2)}\n`);

  copyFrameworkFiles(dest, terms);
  return dest;
}

export function prepareDemoWorkspace(options = {}) {
  const dest = options.root || defaultDemoRoot(options.env);
  return materializeDemoWorkspace(dest, options);
}
