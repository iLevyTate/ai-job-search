# Personal/public split guardrails

Date: 2026-09-10. Status: approved design, pending spec review.

## Problem

The maintainer runs two worlds from the same codebase: a private job-search
checkout (branch `personal`, remote `personal`) and the public Job Search
Desk (`origin/master`). AGENTS.md states the rule; nothing enforces it. Both
checkouts can push to both remotes, the private tree carries the full app
source so Desk work lands there, public template wording has drifted into the
private tree, and private identifiers have leaked into public branches twice.

## Goal

Make the world a tree belongs to unambiguous to a person and to an agent, and
make the wrong action fail before it lands: a push to the wrong remote, a Desk
edit in the private tree, private content in the public tree.

## Decisions

1. The private checkout keeps the framework (commands, skills, Python tools)
   and receives updates only by merging `origin/master`. Its `gui/` is
   read-only: the Desk that runs against the private folder is the installed
   public build.
2. The existing uncommitted Desk work in the private `gui/` is archived on a
   branch on the private remote, then `gui/` is restored to `origin/master`.
3. Enforcement is git-level and agent-level, both fed by one role detector.
4. There is one public checkout. Stale public folders are removed last.

## Components

### `tools/split_check.py`

One module, no third-party imports, runs on the system Python in either tree.

- `detect_role(repo)` returns `personal`, `public`, or `unknown`:
  - `personal`: current branch is `personal` and a remote named `personal`
    exists.
  - `public`: no remote named `personal`, and `remote.origin.url` points at
    `iLevyTate/ai-job-search`.
  - `unknown`: anything else. Every guard fails closed on `unknown` with a
    message that names both expected shapes.
- `identifier_patterns()` reads the pattern file from the shared state
  folder the Desk already uses (`%APPDATA%\ai-job-search\split-identifiers.txt`
  on Windows, `~/Library/Application Support/ai-job-search/` on macOS,
  `$XDG_CONFIG_HOME/ai-job-search/` or `~/.config/ai-job-search/` on Linux),
  one case-insensitive regular expression per line, `#` comments allowed.
  The file is never committed to either repo. If it is missing in a public
  tree the scan warns and passes, so other contributors are unaffected; the
  report mode flags it as drift.
- Hook mode, `--hook pre-commit` and `--hook pre-push`, reads the same
  inputs git gives a hook (staged diff, or the remote name and the pushed
  refs on stdin) and exits non-zero with a plain sentence on refusal:
  - personal, pre-commit: refuse any staged path under `gui/` unless
    `.git/MERGE_HEAD` exists, so `git merge origin/master` still lands Desk
    updates. Message names the public checkout.
  - personal, pre-push: refuse any remote whose name is not `personal`.
  - public, pre-commit: scan added lines of the staged diff, excluding
    `gui/node_modules`, `gui/release`, `gui/public/dist`, and `gui/public/vendor`,
    for identifier patterns; refuse on a hit and print path and line.
  - public, pre-push: for each pushed ref, `git grep` the tree for the
    patterns with the same exclusions and the allowed
    `iLevyTate/ai-job-search` URL filtered out; refuse on a hit. Refuse
    outright if the remote name is `personal`.
- Agent mode, `--claude-guard`, reads the Claude Code PreToolUse JSON on
  stdin (`tool_name`, `tool_input.file_path`, `tool_input.content` or
  `new_string`). In a personal tree it blocks a write under `gui/` (same
  merge-in-progress exception as the git hook); in a public tree it blocks
  content matching the patterns. Exit 2 with the
  sentence on stderr, exit 0 otherwise. A tool input it cannot parse passes
  with a warning; the git hooks remain the last line.
- Banner mode, `--banner`, prints one line for SessionStart:
  `Workspace role: personal (push: personal only; gui/ is read-only here)`
  or the public equivalent.
- Report mode, no arguments: role, remotes and push URLs, whether
  `core.hooksPath` is `.githooks`, whether the pattern file exists and how
  many patterns it holds, identifier hits in the working tree, and in a
  personal tree whether `gui/` differs from `origin/master`. Exit 1 on any
  drift so it can run in a shell prompt or a scheduled check.

### `.githooks/pre-commit` and `.githooks/pre-push`

Two POSIX `sh` scripts of a few lines each, tracked in both repos, that
locate a Python interpreter (`python3`, then `python`, then `py -3`) and run
`tools/split_check.py --hook <name>` with the hook's arguments and stdin.
If no interpreter is found they print a sentence and exit 1: a missing guard
is a failure, not a pass.

### `tools/split_setup.py`

Idempotent per-tree setup, run once in each checkout:

- Detects the role and refuses to continue on `unknown`.
- Personal: sets `remote.origin.pushurl` to `DISABLED`, keeps the fetch
  URL, sets `remote.upstream.pushurl` to `DISABLED` if that remote exists.
- Public: removes any remote named `personal`; sets `remote.upstream.pushurl`
  to `DISABLED` if present.
- Both: sets `core.hooksPath` to `.githooks`, marks the hook files
  executable where the filesystem supports it, creates the pattern file
  with a commented template if it is missing, and finishes by printing the
  report.

### Claude Code hooks (`.claude/settings.json` in both repos)

- `SessionStart`: `python tools/split_check.py --banner`.
- `PreToolUse` with matcher `Edit|Write|MultiEdit`:
  `python tools/split_check.py --claude-guard`.

`tools/security_guards.py` in both repos gains the two commands on its hook
allowlist, and its test pins them.

### Documentation

AGENTS.md "Personal vs public (always)" gains: the role detector as the
authority, `gui/` read-only in personal, the sync direction (public to
personal by `git fetch origin` then `git merge origin/master`; personal to
public never by copying, only by hand-porting in the public tree), the setup
command, and the report command. `gui/README.md` does not change: the Desk
already opens any job-search folder as its workspace.

## Data flow

```
git commit / git push ──► .githooks/* ──► split_check.py --hook ──► allow | refuse
Claude Edit/Write ──────► PreToolUse ───► split_check.py --claude-guard ──► allow | block
Claude session start ───► SessionStart ─► split_check.py --banner
person, any time ───────► split_check.py (report) ──► drift list, exit 1 on drift
one-time per tree ──────► split_setup.py ──► remotes, hooksPath, pattern file, report
```

## Migration (private tree, in this order)

1. Archive: `git checkout -b personal-desk-archive`, commit the whole `gui/`
   diff including the untracked files, push to the `personal` remote only,
   return to `personal`.
2. Restore: `git checkout origin/master -- gui` and remove the untracked
   `gui/` files; commit on `personal` as "Desk source is read-only here".
3. Land the tooling: after the public PR merges, `git fetch origin` and
   `git merge origin/master`.
4. Wire: `python tools/split_setup.py`, then confirm with a forbidden
   commit under `gui/`, a forbidden push to `origin`, and a Claude edit under
   `gui/`, each expected to refuse with the right sentence.

## Migration (public trees)

1. In `ai-job-search-desk-release`, commit the dirty `desk-command-guidance`
   work as a WIP and push that branch to `origin`.
2. Rename `ai-job-search-desk-1.3.0` to `ai-job-search-public`; it becomes
   the only public checkout. Run `split_setup.py` there.
3. Last, after both trees pass their live checks: delete the five stale
   folders `ai-job-search-desk-12`, `ai-job-search-desk125`,
   `ai-job-search-desk-pr`, `ai-job-search-desk-release`, and
   `ai-job-search-public-pr`, after confirming each has no unpushed commits
   (`git log --branches --not --remotes`) and no uncommitted changes. The
   renamed `ai-job-search-public` stays. This step waits for an explicit go.

## Error handling

- `unknown` role: every mode refuses and prints both expected shapes.
- Missing Python in a hook: refuse with a sentence.
- Missing pattern file: personal tree, no effect (it scans nothing there);
  public tree, warn and pass in hooks, flag in report.
- A pattern that fails to compile: report the line number, refuse.
- Binary files in the staged diff are skipped by `git diff --cached
  --diff-filter=AM -U0` semantics; the pre-push tree scan uses `git grep -I`.

## Testing

`tests/test_split_check.py` (unittest, no network), building throwaway git
repos in a temporary directory:

- role detection for the three shapes;
- personal pre-commit refuses `gui/x.mjs`, allows `cv/x.tex`, allows `gui/`
  during a merge;
- personal pre-push refuses `origin`, allows `personal`;
- public pre-commit refuses an added line matching a pattern, ignores the
  excluded folders, passes when the pattern file is absent;
- public pre-push refuses a tree hit and the `personal` remote;
- `--claude-guard` blocks and allows the same cases from JSON on stdin;
- report exits 1 on each drift condition and 0 on a clean tree;
- `split_setup.py` is idempotent: running it twice yields the same config.

Live verification after migration, in each tree, as listed above.

## Out of scope

Porting the archived Desk features into public (tracked separately in the
audit ledger). Any change to how the Desk chooses its workspace folder.
Automated syncing between the two worlds.
