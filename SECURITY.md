# Security Policy

## Reporting a vulnerability

Please report security findings privately via GitHub private vulnerability reporting rather than a public issue. You will get a response within a few days, credit in the fix unless you prefer otherwise, and public disclosure coordinated with the patch.

- **Desk app (`gui/`) and any fork-only code:** report to this fork - **[iLevyTate/ai-job-search advisories](https://github.com/iLevyTate/ai-job-search/security/advisories/new)**. The Electron Desk app (which spawns `claude` and binds a local HTTP server) is this fork's code; upstream does not own it.
- **Shared framework (commands, skills, portal CLIs inherited from upstream):** report upstream at **[MadsLorentzen/ai-job-search advisories](https://github.com/MadsLorentzen/ai-job-search/security/advisories/new)**.

If the private form is unavailable, open a public issue that describes the *class* of problem without a working recipe, and note that you have details to share privately.

## Threat model, honestly stated

This is an agentic workflow: an LLM with file access reads untrusted web content (job postings) alongside your personal data (CV, profile, application history). That combination is the main risk surface, and it cannot be fully eliminated - only narrowed. What the framework does about it:

- **Untrusted-input rules**: `/apply` and `/rank` treat posting text as data, never instructions - agents are told not to follow directions embedded in postings and not to fetch URLs found inside posting text (the user-supplied posting URL is the one exception). Reviewer research starts from the company identity the user confirmed, never from links in the posting body.
- **Permission allowlist**: `.claude/settings.json` pre-approves only the specific commands the workflow needs; the `security-guards` CI job fails any PR that widens it, adds package-manifest lifecycle scripts, or weakens the personal-data gitignore rules. Note the allowlist governs Bash commands - the model's native WebFetch/WebSearch tools are outside its reach, which is exactly why the instruction-level rules above exist.
- **Personal data boundaries**: your populated profile, tracker, salary data, and application archive are gitignored; documents never leave the machine by design (`/notion-sync` syncs filenames only; nothing uploads document content anywhere).

Instruction-level defenses raise the bar; they are not a sandbox. If you run this workflow against job boards you do not trust at all, review what the agent fetched and wrote before sending anything out.

## Job Search Desk

The Desk binds only `127.0.0.1`, rejects cross-origin browser POSTs, and matches `Host` exactly. Artifact paths must stay inside the selected workspace: absolute paths, `..`, other drives, UNC, NUL, and symlink/junction escapes are rejected. HTML previews render in a sandboxed iframe with a restrictive CSP and are never injected into the Desk document.

Native Chat permissions use the Claude Agent SDK `canUseTool` callback. **Safe** is manual/default approval and fails closed. It is unrelated to Claude CLI `--safe-mode`. **Autonomous** may enable bypass permissions only for the selected trusted workspace. Allow-for-workspace persists only through documented SDK destinations (`session`, `localSettings`, `projectSettings`).

The embedded Terminal launches only the resolved `claude` executable in the selected workspace. The renderer can send opaque IDs, bounded strings, and bounded resize values. It cannot supply an executable, arguments, environment, or cwd. Opaque Windows `.cmd` shims are not spawned through the PTY.

Autofill review tokens are ephemeral and inherited by the local CLI. The bridge accepts one Continue or Cancel decision. There is no submit endpoint in any released build. A Desk restart cancels an orphaned review.

The `autofill-submit` branch adds a third decision, Submit, and with it a path that presses the employer's own button. It is unreleased and not on `master`. The Desk gate there fails closed the way this one does: Cancel on a refused start, a missing token, a failed readiness call, a bad response, a closed review, an abort, an exception, and after thirty minutes. The terminal gate is weaker and should be read as such: it has no timer and no test for an attached terminal, and anything typed that is not `submit` is treated as Enter and closes the browser without sending, so only end of input, a closed stdin or an error produce Cancel. LinkedIn, Indeed, and Dice are refused by hostname. The environment selects which gate runs rather than what it returns, except that `JOB_SEARCH_DESK_REVIEW_URL` selects the server the Desk gate asks, which on your own machine amounts to answering it. Treat this paragraph as the disclosure for that branch until it ships, at which point the sentence above it has to change.

## Environment variables the Desk and Autofill read

None of these submits an application, and none skips a review gate. Three of them decide what the Desk trusts, so they are listed first; the rest are switches for demos, tests, and where files live. Everything else the code reads is the operating system's own (`HOME`, `PATH`, `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `USER`, `USERNAME`, `LOGNAME`, `SYSTEMROOT`, `XDG_CONFIG_HOME`, `XDG_DESKTOP_DIR`, `XDG_DOCUMENTS_DIR`), used only to find the home folder and the config directory.

Trust-relevant:

- `CLAUDE_BIN` - path to the `claude` binary the Desk runs instead of the one on `PATH`. Whoever can set this on your machine chooses what runs as Claude Code.
- `JOB_SEARCH_TEMPLATE_URL` - the git URL a new workspace is cloned from, in place of this repository. Same caveat: it chooses what gets cloned.
- `JOB_SEARCH_DESK_REVIEW_URL` and `JOB_SEARCH_DESK_REVIEW_TOKEN` - which local server the Autofill review gate asks, and the one-time token it presents. Set by the Desk when it launches Autofill. On your own machine, pointing the URL at a server you control amounts to answering the gate yourself; it still cannot produce a Submit on `master`, where the gate has no such decision.

Switches:

- `JOB_SEARCH_ROOT` - the workspace folder, when not chosen in the Desk.
- `JOB_SEARCH_GUI_PORT` - the local port (default 8765); the server binds `127.0.0.1` regardless.
- `JOB_SEARCH_GUI_NO_BROWSER=1` - do not open a browser tab; the packaged app sets this for itself.
- `JOB_SEARCH_FORCE_FIRST_RUN=1` - replay the first-launch flow.
- `JOB_SEARCH_CLAUDE_CHROME=0|1` - force the Claude-in-Chrome integration off or on instead of detecting the extension.
- `JOB_SEARCH_DEMO=1`, `JOB_SEARCH_DEMO_ROOT`, `JOB_SEARCH_DEMO_PACE=film` - run against the fictional demo workspace, where to put it, and how fast the demo types.
- `JOB_SEARCH_UPDATE_FAKE=1`, `JOB_SEARCH_UPDATE_FAKE_CHANNEL`, `JOB_SEARCH_UPDATE_CURRENT`, `JOB_SEARCH_UPDATE_NEXT` - stage a pretend update for screenshots and tests. With the fake on, `/update/download` and `/update/install` are dry runs that fetch and install nothing.
- `PORTABLE_EXECUTABLE_DIR` - set by the Windows portable build; the update check is skipped when it is present.
- `ATS_AUTOFILL_CHROMIUM` - an existing Chromium binary for Autofill to launch instead of the Playwright download.
- `PLAYWRIGHT_BROWSERS_PATH` - Playwright's own variable for where browsers are installed; the Desk reads it only to report whether Chromium is present.

## Scope notes

- Portal CLI skills make live requests only when you run them; CI never does.
- Community fork skills listed in the [forks index](https://github.com/MadsLorentzen/ai-job-search/discussions/78) are **not** covered by this policy - review the code you copy, as the index itself says.
