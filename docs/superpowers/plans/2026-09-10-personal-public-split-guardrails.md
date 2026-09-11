# Personal/Public Split Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the personal job-search checkout and the public Job Search Desk checkout mechanically distinguishable, so a push to the wrong remote, a Desk edit in the personal tree, or personal content in the public tree fails before it lands.

**Architecture:** One stdlib Python module, `tools/split_check.py`, derives a tree's role from git and serves four callers: two tracked git hooks under `.githooks/`, two Claude Code hooks in `.claude/settings.json`, and a drift report. `tools/split_setup.py` wires remotes, activates the hooks, and creates the identifier file per tree. Spec: `docs/superpowers/specs/2026-09-10-personal-public-split-guardrails-design.md`.

**Tech Stack:** Python 3 stdlib only (this repo's tools run on the system interpreter, no requirements file), POSIX `sh` for hook shims, `unittest` (run with `python -m unittest discover -s tests -t .`), git.

**Where work happens:** Tasks 1-8 in the public checkout `C:\Users\benja\Documents\GitHub\ai-job-search-desk-1.3.0` on branch `split-guardrails` (already created from `origin/master`). Tasks 9-12 in the personal checkout `C:\Users\benja\Documents\GitHub\ai-job-search` on branch `personal`. Task 13 touches the other public folders. Never copy a file from the personal tree into the public tree.

**Conventions:** Commit messages are plain sentences, no attribution lines. Every Python file is UTF-8 with LF endings. Run the full suite before each commit: `python -m unittest discover -s tests -t .` (public baseline: 326 OK).

---

## File structure

| File | Responsibility |
|---|---|
| `tools/split_check.py` (new) | Role detection, identifier patterns, staged-diff and tree scanning, hook/guard/banner/report modes. No side effects on git config. |
| `tools/split_setup.py` (new) | One-time per-tree wiring: remote push URLs, `core.hooksPath`, pattern file, then prints the report. Idempotent. |
| `.githooks/split-guard` (new) | `sh` shim: finds a Python interpreter, forwards all arguments and stdin to `split_check.py`. Fails closed when no interpreter. |
| `.githooks/pre-commit`, `.githooks/pre-push` (new) | Two-line shims that call `split-guard --hook <name> "$@"`. |
| `.claude/settings.json` (modify) | Adds `hooks`: SessionStart banner and PreToolUse guard, both through `split-guard`. |
| `tools/security_guards.py:140` (modify) | `ALLOWED_HOOKS` gains the two hook commands. |
| `tests/test_split_check.py` (new) | Unit tests against throwaway git repos. |
| `tests/test_security_guards.py` (modify) | Pins the two allowed hooks. |
| `AGENTS.md` (modify) | New section "Private fork guardrails". |

---

### Task 1: Role detection and the shared-state folder

**Files:**
- Create: `tools/split_check.py`
- Create: `tests/test_split_check.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_split_check.py`:

```python
"""Tests for tools/split_check.py against throwaway git repos.

Every repo is built in a temp dir; nothing here touches the real checkouts or
the real identifier file (SPLIT_IDENTIFIERS_FILE points at a temp file).
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "tools"))
import split_check  # noqa: E402

PUBLIC_URL = "https://github.com/iLevyTate/ai-job-search.git"
PERSONAL_URL = "https://example.invalid/ai-job-search-private.git"


def git(repo: Path, *args: str, input: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, text=True, encoding="utf-8", input=input, check=True,
    )


def make_repo(root: Path, kind: str) -> Path:
    """kind: personal | public | unknown."""
    repo = root / kind
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.email", "t@example.invalid")
    git(repo, "config", "user.name", "Test")
    git(repo, "config", "commit.gpgsign", "false")
    (repo / "README.md").write_text("hello\n", encoding="utf-8")
    (repo / "gui").mkdir()
    (repo / "gui" / "server.mjs").write_text("// desk\n", encoding="utf-8")
    (repo / "cv").mkdir()
    (repo / "cv" / "main.tex").write_text("% cv\n", encoding="utf-8")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "init")
    if kind == "personal":
        git(repo, "checkout", "-q", "-b", "personal")
        git(repo, "remote", "add", "origin", PUBLIC_URL)
        git(repo, "remote", "add", "personal", PERSONAL_URL)
    elif kind == "public":
        git(repo, "remote", "add", "origin", PUBLIC_URL)
    return repo


class RoleDetection(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_personal_is_branch_personal_with_personal_remote(self):
        self.assertEqual(split_check.detect_role(make_repo(self.root, "personal")), "personal")

    def test_public_is_origin_public_and_no_personal_remote(self):
        self.assertEqual(split_check.detect_role(make_repo(self.root, "public")), "public")

    def test_anything_else_is_unknown(self):
        self.assertEqual(split_check.detect_role(make_repo(self.root, "unknown")), "unknown")

    def test_public_origin_with_a_personal_remote_is_unknown(self):
        repo = make_repo(self.root, "public")
        git(repo, "remote", "add", "personal", PERSONAL_URL)
        self.assertEqual(split_check.detect_role(repo), "unknown")


class StateDir(unittest.TestCase):
    def test_windows_uses_appdata(self):
        got = split_check.state_dir(platform="win32", env={"APPDATA": r"C:\Users\x\AppData\Roaming"}, home=Path(r"C:\Users\x"))
        self.assertEqual(got, Path(r"C:\Users\x\AppData\Roaming") / "ai-job-search")

    def test_mac_uses_application_support(self):
        got = split_check.state_dir(platform="darwin", env={}, home=Path("/Users/x"))
        self.assertEqual(got, Path("/Users/x/Library/Application Support/ai-job-search"))

    def test_linux_honours_xdg(self):
        got = split_check.state_dir(platform="linux", env={"XDG_CONFIG_HOME": "/tmp/cfg"}, home=Path("/home/x"))
        self.assertEqual(got, Path("/tmp/cfg/ai-job-search"))

    def test_env_override_wins_for_the_pattern_file(self):
        self.assertEqual(
            split_check.pattern_path(env={"SPLIT_IDENTIFIERS_FILE": "/tmp/p.txt"}),
            Path("/tmp/p.txt"),
        )


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m unittest tests.test_split_check -v`
Expected: `ModuleNotFoundError: No module named 'split_check'`

- [ ] **Step 3: Write the minimal implementation**

Create `tools/split_check.py`:

```python
#!/usr/bin/env python3
"""Personal/public split guardrails.

Run from anywhere inside a checkout:
  python tools/split_check.py                 drift report (exit 1 on drift)
  python tools/split_check.py --banner        one-line role banner
  python tools/split_check.py --hook pre-commit
  python tools/split_check.py --hook pre-push <remote-name> <url>   (refs on stdin)
  python tools/split_check.py --claude-guard  (Claude Code PreToolUse JSON on stdin)

A tree's role comes from git alone:
  personal  branch is "personal" and a remote named "personal" exists
  public    no remote named "personal", remote.origin.url is iLevyTate/ai-job-search
  unknown   anything else; every guard refuses

Personal identifiers live outside both repos in the Desk's shared state folder
(split-identifiers.txt), one case-insensitive regular expression per line.

Stdlib only.
"""

import os
import re
import subprocess
import sys
from pathlib import Path

PUBLIC_ORIGIN = "iLevyTate/ai-job-search"
PERSONAL_REMOTE = "personal"
GUI_PREFIX = "gui/"
PATTERN_FILE_NAME = "split-identifiers.txt"
SCAN_EXCLUDES = ("gui/node_modules/", "gui/release/", "gui/public/dist/", "gui/public/vendor/")
ALLOWED_TEXT = "iLevyTate/ai-job-search"

PUBLIC_CHECKOUT_HINT = "the public checkout (ai-job-search-public)"


def git(repo: Path, *args: str, check: bool = True, input: str | None = None) -> str:
    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace", input=input,
    )
    if check and proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.stdout


def repo_root(start: Path | None = None) -> Path:
    where = start or Path.cwd()
    return Path(git(where, "rev-parse", "--show-toplevel").strip())


def detect_role(repo: Path) -> str:
    branch = git(repo, "rev-parse", "--abbrev-ref", "HEAD", check=False).strip()
    remotes = set(git(repo, "remote", check=False).split())
    origin_url = git(repo, "config", "--get", "remote.origin.url", check=False).strip()
    if branch == "personal" and PERSONAL_REMOTE in remotes:
        return "personal"
    if PERSONAL_REMOTE not in remotes and PUBLIC_ORIGIN.lower() in origin_url.lower():
        return "public"
    return "unknown"


def state_dir(platform: str = sys.platform, env=os.environ, home: Path | None = None) -> Path:
    home = home or Path.home()
    if platform.startswith("win"):
        return Path(env.get("APPDATA") or home / "AppData" / "Roaming") / "ai-job-search"
    if platform == "darwin":
        return home / "Library" / "Application Support" / "ai-job-search"
    return Path(env.get("XDG_CONFIG_HOME") or home / ".config") / "ai-job-search"


def pattern_path(env=os.environ) -> Path:
    override = env.get("SPLIT_IDENTIFIERS_FILE")
    return Path(override) if override else state_dir(env=env) / PATTERN_FILE_NAME


if __name__ == "__main__":
    sys.exit(0)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m unittest tests.test_split_check -v`
Expected: 8 tests, `OK`

- [ ] **Step 5: Commit**

```bash
git add tools/split_check.py tests/test_split_check.py
git commit -m "Add the split guard's role detection and state folder"
```

---

### Task 2: Identifier patterns and line scanning

**Files:**
- Modify: `tools/split_check.py`
- Modify: `tests/test_split_check.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_split_check.py` before the `if __name__` block:

```python
class Patterns(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def write(self, text: str) -> Path:
        path = self.root / "ids.txt"
        path.write_text(text, encoding="utf-8")
        return path

    def test_missing_file_is_none(self):
        self.assertIsNone(split_check.load_patterns(self.root / "nope.txt"))

    def test_comments_and_blanks_are_skipped_and_matching_is_case_insensitive(self):
        patterns = split_check.load_patterns(self.write("# names\n\nsmith\n555-01\n"))
        self.assertEqual(len(patterns), 2)
        hits = split_check.scan_lines([("a.md:1", "Jane SMITH wrote"), ("a.md:2", "nothing")], patterns)
        self.assertEqual(hits, [("a.md:1", "Jane SMITH wrote")])

    def test_bad_regex_names_the_line(self):
        with self.assertRaises(ValueError) as caught:
            split_check.load_patterns(self.write("ok\n(unclosed\n"))
        self.assertIn("line 2", str(caught.exception))

    def test_allowed_public_url_does_not_count_as_a_hit(self):
        patterns = split_check.load_patterns(self.write("ai-job-search\n"))
        hits = split_check.scan_lines([("a.md:1", "see https://github.com/iLevyTate/ai-job-search")], patterns)
        self.assertEqual(hits, [])

    def test_excluded_paths_are_skipped(self):
        self.assertTrue(split_check.excluded("gui/node_modules/x/y.js"))
        self.assertTrue(split_check.excluded("gui/public/dist/desk.js"))
        self.assertFalse(split_check.excluded("gui/server.mjs"))
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m unittest tests.test_split_check.Patterns -v`
Expected: 5 failures, `AttributeError: module 'split_check' has no attribute 'load_patterns'`

- [ ] **Step 3: Write the minimal implementation**

Add to `tools/split_check.py` after `pattern_path`:

```python
def load_patterns(path: Path):
    """None when the file is absent; ValueError naming the line on a bad regex."""
    if not path.exists():
        return None
    patterns = []
    for number, raw in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        try:
            patterns.append(re.compile(line, re.IGNORECASE))
        except re.error as err:
            raise ValueError(f"{path}: line {number}: {err}") from None
    return patterns


def excluded(rel_path: str) -> bool:
    rel = rel_path.replace("\\", "/")
    return any(rel.startswith(prefix) for prefix in SCAN_EXCLUDES)


def scan_lines(located_lines, patterns):
    """located_lines: iterable of (location, text). Returns the matching pairs."""
    hits = []
    for location, text in located_lines:
        probe = text.replace(ALLOWED_TEXT, "")
        if any(p.search(probe) for p in patterns):
            hits.append((location, text))
    return hits
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m unittest tests.test_split_check -v`
Expected: 13 tests, `OK`

- [ ] **Step 5: Commit**

```bash
git add tools/split_check.py tests/test_split_check.py
git commit -m "Add identifier patterns and line scanning to the split guard"
```

---

### Task 3: Git-facing helpers: staged paths, staged added lines, tree scan, merge state

**Files:**
- Modify: `tools/split_check.py`
- Modify: `tests/test_split_check.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_split_check.py`:

```python
class GitHelpers(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.repo = make_repo(self.root, "public")

    def test_staged_paths_and_added_lines(self):
        (self.repo / "cv" / "new.tex").write_text("one\nJane Smith\n", encoding="utf-8")
        (self.repo / "gui" / "server.mjs").write_text("// desk\n// changed\n", encoding="utf-8")
        git(self.repo, "add", "-A")
        self.assertEqual(sorted(split_check.staged_paths(self.repo)), ["cv/new.tex", "gui/server.mjs"])
        added = list(split_check.staged_added_lines(self.repo))
        self.assertIn(("cv/new.tex:2", "Jane Smith"), added)
        self.assertIn(("gui/server.mjs:2", "// changed"), added)

    def test_staged_added_lines_skip_excluded_folders(self):
        (self.repo / "gui" / "node_modules").mkdir()
        (self.repo / "gui" / "node_modules" / "x.js").write_text("Jane Smith\n", encoding="utf-8")
        git(self.repo, "add", "-f", "gui/node_modules/x.js")
        self.assertEqual(list(split_check.staged_added_lines(self.repo)), [])

    def test_tree_hits_scan_a_ref(self):
        (self.repo / "cv" / "main.tex").write_text("% Jane Smith\n", encoding="utf-8")
        git(self.repo, "commit", "-q", "-am", "add a name")
        sha = git(self.repo, "rev-parse", "HEAD").strip()
        patterns = [re.compile("smith", re.I)]
        self.assertEqual(split_check.tree_hits(self.repo, sha, patterns), [(f"cv/main.tex:1", "% Jane Smith")])
        self.assertEqual(split_check.tree_hits(self.repo, sha, [re.compile("nobody", re.I)]), [])

    def test_merge_in_progress_reads_merge_head(self):
        self.assertFalse(split_check.merge_in_progress(self.repo))
        git_dir = Path(git(self.repo, "rev-parse", "--git-dir").strip())
        if not git_dir.is_absolute():
            git_dir = self.repo / git_dir
        (git_dir / "MERGE_HEAD").write_text("deadbeef\n", encoding="utf-8")
        self.assertTrue(split_check.merge_in_progress(self.repo))
```

Add `import re` to the test file's imports.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m unittest tests.test_split_check.GitHelpers -v`
Expected: 4 failures, `AttributeError ... 'staged_paths'`

- [ ] **Step 3: Write the minimal implementation**

Add to `tools/split_check.py` after `scan_lines`:

```python
HUNK_RE = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")


def staged_paths(repo: Path):
    return [p for p in git(repo, "diff", "--cached", "--name-only", "--diff-filter=AMR").splitlines() if p]


def staged_added_lines(repo: Path):
    """Yield (path:line, text) for every added line in the staged diff."""
    out = git(repo, "diff", "--cached", "--diff-filter=AM", "-U0", "--no-color", "--no-ext-diff")
    path = None
    line_no = 0
    skip = False
    for raw in out.splitlines():
        if raw.startswith("+++ "):
            path = raw[4:]
            path = path[2:] if path.startswith("b/") else path
            skip = excluded(path)
            continue
        if raw.startswith("--- ") or raw.startswith("diff --git") or raw.startswith("index "):
            continue
        match = HUNK_RE.match(raw)
        if match:
            line_no = int(match.group(1))
            continue
        if raw.startswith("+") and path and not skip:
            yield (f"{path}:{line_no}", raw[1:])
            line_no += 1
        elif raw.startswith("+") and path:
            line_no += 1


def tree_hits(repo: Path, ref: str, patterns):
    """Scan every text file in a committed tree. Returns [(path:line, text)]."""
    if not patterns:
        return []
    args = ["grep", "-I", "-i", "-n", "-E"]
    for p in patterns:
        args += ["-e", p.pattern]
    args += [ref, "--", "."] + [f":!{prefix.rstrip('/')}" for prefix in SCAN_EXCLUDES]
    proc = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if proc.returncode not in (0, 1):
        raise RuntimeError(f"git grep failed: {proc.stderr.strip()}")
    located = []
    for raw in proc.stdout.splitlines():
        # ref:path:line:text
        _, rest = raw.split(":", 1)
        path, line, text = rest.split(":", 2)
        located.append((f"{path}:{line}", text))
    return scan_lines(located, patterns)


def merge_in_progress(repo: Path) -> bool:
    git_dir = Path(git(repo, "rev-parse", "--git-dir").strip())
    if not git_dir.is_absolute():
        git_dir = repo / git_dir
    return (git_dir / "MERGE_HEAD").exists()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m unittest tests.test_split_check -v`
Expected: 17 tests, `OK`

- [ ] **Step 5: Commit**

```bash
git add tools/split_check.py tests/test_split_check.py
git commit -m "Add staged-diff, tree scan, and merge-state helpers to the split guard"
```

---

### Task 4: Hook modes: pre-commit and pre-push

**Files:**
- Modify: `tools/split_check.py`
- Modify: `tests/test_split_check.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_split_check.py`:

```python
ZEROS = "0" * 40


class PreCommitHook(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.patterns = [re.compile("smith", re.I)]

    def stage(self, repo: Path, rel: str, text: str):
        path = repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        git(repo, "add", rel)

    def test_personal_refuses_gui_and_names_the_public_checkout(self):
        repo = make_repo(self.root, "personal")
        self.stage(repo, "gui/server.mjs", "// edited\n")
        result = split_check.hook_pre_commit(repo, "personal", self.patterns)
        self.assertEqual(result.code, 1)
        self.assertIn("read-only", result.message)
        self.assertIn("ai-job-search-public", result.message)
        self.assertIn("gui/server.mjs", result.message)

    def test_personal_allows_cv_and_allows_gui_during_a_merge(self):
        repo = make_repo(self.root, "personal")
        self.stage(repo, "cv/x.tex", "x\n")
        self.assertEqual(split_check.hook_pre_commit(repo, "personal", self.patterns).code, 0)
        self.stage(repo, "gui/server.mjs", "// edited\n")
        git_dir = repo / ".git"
        (git_dir / "MERGE_HEAD").write_text("deadbeef\n", encoding="utf-8")
        self.assertEqual(split_check.hook_pre_commit(repo, "personal", self.patterns).code, 0)

    def test_public_refuses_an_added_identifier_line(self):
        repo = make_repo(self.root, "public")
        self.stage(repo, "README.md", "hello\ncontact Jane Smith\n")
        result = split_check.hook_pre_commit(repo, "public", self.patterns)
        self.assertEqual(result.code, 1)
        self.assertIn("README.md:2", result.message)

    def test_public_passes_with_a_warning_when_no_pattern_file(self):
        repo = make_repo(self.root, "public")
        self.stage(repo, "README.md", "hello\ncontact Jane Smith\n")
        result = split_check.hook_pre_commit(repo, "public", None)
        self.assertEqual(result.code, 0)
        self.assertIn("no identifier file", result.message)

    def test_unknown_refuses(self):
        repo = make_repo(self.root, "unknown")
        self.stage(repo, "README.md", "x\n")
        result = split_check.hook_pre_commit(repo, "unknown", self.patterns)
        self.assertEqual(result.code, 1)
        self.assertIn("unknown", result.message)


class PrePushHook(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.patterns = [re.compile("smith", re.I)]

    def test_personal_refuses_any_remote_but_personal(self):
        repo = make_repo(self.root, "personal")
        self.assertEqual(split_check.hook_pre_push(repo, "personal", self.patterns, "origin", []).code, 1)
        self.assertEqual(split_check.hook_pre_push(repo, "personal", self.patterns, "personal", []).code, 0)

    def test_public_refuses_the_personal_remote_and_a_tree_hit(self):
        repo = make_repo(self.root, "public")
        self.assertEqual(split_check.hook_pre_push(repo, "public", self.patterns, "personal", []).code, 1)
        (repo / "cv" / "main.tex").write_text("% Jane Smith\n", encoding="utf-8")
        git(repo, "commit", "-q", "-am", "name")
        sha = git(repo, "rev-parse", "HEAD").strip()
        refs = [f"refs/heads/main {sha} refs/heads/main {ZEROS}"]
        result = split_check.hook_pre_push(repo, "public", self.patterns, "origin", refs)
        self.assertEqual(result.code, 1)
        self.assertIn("cv/main.tex:1", result.message)

    def test_public_passes_a_clean_tree_and_a_branch_deletion(self):
        repo = make_repo(self.root, "public")
        sha = git(repo, "rev-parse", "HEAD").strip()
        self.assertEqual(split_check.hook_pre_push(repo, "public", self.patterns, "origin", [f"refs/heads/main {sha} refs/heads/main {ZEROS}"]).code, 0)
        self.assertEqual(split_check.hook_pre_push(repo, "public", self.patterns, "origin", [f"(delete) {ZEROS} refs/heads/old {sha}"]).code, 0)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m unittest tests.test_split_check.PreCommitHook tests.test_split_check.PrePushHook -v`
Expected: 8 failures, `AttributeError ... 'hook_pre_commit'`

- [ ] **Step 3: Write the minimal implementation**

Add to `tools/split_check.py` after `merge_in_progress`:

```python
class Outcome:
    """code 0 allows; anything else refuses. message goes to stderr either way when non-empty."""

    def __init__(self, code: int, message: str = ""):
        self.code = code
        self.message = message


UNKNOWN_MESSAGE = (
    "split guard: this checkout's role is unknown, so the action is refused.\n"
    "  personal = branch 'personal' with a remote named 'personal'\n"
    "  public   = remote.origin.url is iLevyTate/ai-job-search and no 'personal' remote\n"
    "Run: python tools/split_check.py   for the full report."
)
NO_PATTERNS_MESSAGE = "split guard: no identifier file at {path}; skipping the personal-content scan."


def _format_hits(hits, limit: int = 8) -> str:
    shown = [f"  {loc}: {text.strip()[:100]}" for loc, text in hits[:limit]]
    if len(hits) > limit:
        shown.append(f"  ... and {len(hits) - limit} more")
    return "\n".join(shown)


def hook_pre_commit(repo: Path, role: str, patterns) -> Outcome:
    if role == "unknown":
        return Outcome(1, UNKNOWN_MESSAGE)
    if role == "personal":
        gui = [p for p in staged_paths(repo) if p.replace("\\", "/").startswith(GUI_PREFIX)]
        if gui and not merge_in_progress(repo):
            return Outcome(1, (
                "split guard: Desk source is read-only in the personal checkout. Edit gui/ in "
                f"{PUBLIC_CHECKOUT_HINT}, then bring it here with: git fetch origin && git merge origin/master\n"
                "Staged under gui/:\n" + "\n".join(f"  {p}" for p in gui)
            ))
        return Outcome(0)
    if patterns is None:
        return Outcome(0, NO_PATTERNS_MESSAGE.format(path=pattern_path()))
    hits = scan_lines(staged_added_lines(repo), patterns)
    if hits:
        return Outcome(1, "split guard: personal identifiers in the staged change; this is the public repo.\n" + _format_hits(hits))
    return Outcome(0)


def hook_pre_push(repo: Path, role: str, patterns, remote_name: str, ref_lines) -> Outcome:
    if role == "unknown":
        return Outcome(1, UNKNOWN_MESSAGE)
    if role == "personal":
        if remote_name != PERSONAL_REMOTE:
            return Outcome(1, f"split guard: the personal checkout pushes to the '{PERSONAL_REMOTE}' remote only, not '{remote_name}'.")
        return Outcome(0)
    if remote_name == PERSONAL_REMOTE:
        return Outcome(1, "split guard: the public checkout must not push to the personal remote.")
    if patterns is None:
        return Outcome(0, NO_PATTERNS_MESSAGE.format(path=pattern_path()))
    for line in ref_lines:
        parts = line.split()
        if len(parts) != 4:
            continue
        local_sha = parts[1]
        if set(local_sha) == {"0"}:
            continue
        hits = tree_hits(repo, local_sha, patterns)
        if hits:
            return Outcome(1, f"split guard: personal identifiers in the tree of {parts[0]} ({local_sha[:10]}); refusing to push to '{remote_name}'.\n" + _format_hits(hits))
    return Outcome(0)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m unittest tests.test_split_check -v`
Expected: 25 tests, `OK`

- [ ] **Step 5: Commit**

```bash
git add tools/split_check.py tests/test_split_check.py
git commit -m "Add the pre-commit and pre-push modes to the split guard"
```

---

### Task 5: Claude guard, banner, report, and the command line

**Files:**
- Modify: `tools/split_check.py`
- Modify: `tests/test_split_check.py`

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_split_check.py`:

```python
class ClaudeGuard(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.patterns = [re.compile("smith", re.I)]

    def payload(self, repo: Path, rel: str, content: str, key: str = "content"):
        return {"tool_name": "Write", "tool_input": {"file_path": str(repo / rel), key: content}}

    def test_personal_blocks_gui_writes_but_not_cv(self):
        repo = make_repo(self.root, "personal")
        self.assertEqual(split_check.claude_guard(repo, "personal", self.patterns, self.payload(repo, "gui/x.mjs", "x")).code, 2)
        self.assertEqual(split_check.claude_guard(repo, "personal", self.patterns, self.payload(repo, "cv/x.tex", "x")).code, 0)

    def test_public_blocks_identifier_content_and_paths(self):
        repo = make_repo(self.root, "public")
        self.assertEqual(split_check.claude_guard(repo, "public", self.patterns, self.payload(repo, "README.md", "Jane Smith", key="new_string")).code, 2)
        self.assertEqual(split_check.claude_guard(repo, "public", self.patterns, self.payload(repo, "cv/Jane_Smith_Resume.tex", "x")).code, 2)
        self.assertEqual(split_check.claude_guard(repo, "public", self.patterns, self.payload(repo, "README.md", "plain")).code, 0)

    def test_paths_outside_the_repo_and_unparseable_input_pass(self):
        repo = make_repo(self.root, "public")
        outside = {"tool_name": "Write", "tool_input": {"file_path": str(self.root / "elsewhere.txt"), "content": "Jane Smith"}}
        self.assertEqual(split_check.claude_guard(repo, "public", self.patterns, outside).code, 0)
        self.assertEqual(split_check.claude_guard(repo, "public", self.patterns, {"tool_name": "Write"}).code, 0)

    def test_unknown_blocks(self):
        repo = make_repo(self.root, "unknown")
        self.assertEqual(split_check.claude_guard(repo, "unknown", self.patterns, self.payload(repo, "README.md", "x")).code, 2)


class ReportAndCli(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.ids = self.root / "ids.txt"
        self.ids.write_text("smith\n", encoding="utf-8")
        self.env = {**os.environ, "SPLIT_IDENTIFIERS_FILE": str(self.ids)}

    def run_cli(self, repo: Path, *args: str, input: str | None = None):
        return subprocess.run(
            [sys.executable, str(REPO_ROOT / "tools" / "split_check.py"), *args],
            cwd=repo, capture_output=True, text=True, encoding="utf-8", input=input, env=self.env,
        )

    def wire(self, repo: Path, role: str):
        git(repo, "config", "core.hooksPath", ".githooks")
        if role == "personal":
            git(repo, "config", "remote.origin.pushurl", "DISABLED")
            git(repo, "fetch", "-q", "origin") if False else None

    def test_banner_names_the_role(self):
        proc = self.run_cli(make_repo(self.root, "public"), "--banner")
        self.assertEqual(proc.returncode, 0)
        self.assertIn("Workspace role: public", proc.stdout)

    def test_report_lists_drift_and_exits_1_then_0_when_clean(self):
        repo = make_repo(self.root, "public")
        proc = self.run_cli(repo)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("core.hooksPath", proc.stdout)
        self.wire(repo, "public")
        proc = self.run_cli(repo)
        self.assertEqual(proc.returncode, 0, proc.stdout)
        self.assertIn("no drift", proc.stdout)

    def test_personal_report_flags_origin_push_and_gui_drift(self):
        repo = make_repo(self.root, "personal")
        self.wire(repo, "personal")
        git(repo, "config", "remote.origin.pushurl", PUBLIC_URL)
        proc = self.run_cli(repo)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("remote.origin.pushurl", proc.stdout)
        self.assertIn("origin/master", proc.stdout)

    def test_hook_cli_exit_codes(self):
        repo = make_repo(self.root, "personal")
        (repo / "gui" / "server.mjs").write_text("// edited\n", encoding="utf-8")
        git(repo, "add", "gui/server.mjs")
        proc = self.run_cli(repo, "--hook", "pre-commit")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("read-only", proc.stderr)
        proc = self.run_cli(repo, "--hook", "pre-push", "origin", PUBLIC_URL, input="")
        self.assertEqual(proc.returncode, 1)

    def test_claude_guard_cli_reads_json_on_stdin(self):
        repo = make_repo(self.root, "personal")
        payload = json.dumps({"tool_name": "Write", "tool_input": {"file_path": str(repo / "gui" / "x.mjs"), "content": "x"}})
        proc = self.run_cli(repo, "--claude-guard", input=payload)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("read-only", proc.stderr)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python -m unittest tests.test_split_check.ClaudeGuard tests.test_split_check.ReportAndCli -v`
Expected: 9 failures (`AttributeError ... 'claude_guard'`, and CLI exit 0 where 1 or 2 expected)

- [ ] **Step 3: Write the minimal implementation**

Add to `tools/split_check.py` after `hook_pre_push`, and replace the `if __name__` block:

```python
def _relative_to_repo(repo: Path, file_path: str):
    try:
        return Path(file_path).resolve().relative_to(repo.resolve()).as_posix()
    except (ValueError, OSError):
        return None


def claude_guard(repo: Path, role: str, patterns, payload) -> Outcome:
    """Claude Code PreToolUse: exit 2 blocks the tool call."""
    if role == "unknown":
        return Outcome(2, UNKNOWN_MESSAGE)
    tool_input = payload.get("tool_input") if isinstance(payload, dict) else None
    if not isinstance(tool_input, dict) or not tool_input.get("file_path"):
        return Outcome(0, "split guard: tool input has no file_path; letting it through (git hooks still apply).")
    rel = _relative_to_repo(repo, str(tool_input["file_path"]))
    if rel is None:
        return Outcome(0)
    if role == "personal":
        if rel.startswith(GUI_PREFIX) and not merge_in_progress(repo):
            return Outcome(2, (
                f"split guard: {rel} is Desk source, which is read-only in the personal checkout. "
                f"Edit it in {PUBLIC_CHECKOUT_HINT} and merge origin/master here."
            ))
        return Outcome(0)
    if not patterns:
        return Outcome(0)
    content = tool_input.get("content") or tool_input.get("new_string") or ""
    located = [(f"{rel}", rel)] + [(f"{rel}:{n}", line) for n, line in enumerate(str(content).splitlines(), start=1)]
    hits = scan_lines(located, patterns)
    if hits:
        return Outcome(2, "split guard: this is the public checkout and the write contains personal identifiers.\n" + _format_hits(hits))
    return Outcome(0)


def banner(role: str) -> str:
    if role == "personal":
        return "Workspace role: personal (push: personal remote only; gui/ is read-only here, edit it in the public checkout)"
    if role == "public":
        return "Workspace role: public (iLevyTate/ai-job-search; personal identifiers are refused here)"
    return "Workspace role: UNKNOWN (every split guard refuses; run python tools/split_check.py)"


def report(repo: Path, role: str) -> Outcome:
    drift = []
    lines = [banner(role), f"Checkout: {repo}"]
    if role == "unknown":
        drift.append("role is unknown (see the banner for the two expected shapes)")
    hooks_path = git(repo, "config", "--get", "core.hooksPath", check=False).strip()
    lines.append(f"core.hooksPath: {hooks_path or '(unset)'}")
    if hooks_path != ".githooks":
        drift.append("core.hooksPath is not .githooks (run python tools/split_setup.py)")
    remotes = set(git(repo, "remote", check=False).split())
    for name in sorted(remotes):
        fetch = git(repo, "config", "--get", f"remote.{name}.url", check=False).strip()
        push = git(repo, "config", "--get", f"remote.{name}.pushurl", check=False).strip() or fetch
        lines.append(f"remote {name}: fetch {fetch} | push {push}")
    if role == "personal":
        origin_push = git(repo, "config", "--get", "remote.origin.pushurl", check=False).strip()
        if origin_push != "DISABLED":
            drift.append("remote.origin.pushurl is not DISABLED")
        head = git(repo, "rev-parse", "--verify", "-q", "origin/master", check=False).strip()
        if not head:
            drift.append("origin/master is not fetched, so gui/ cannot be compared (git fetch origin)")
        else:
            diff = subprocess.run(["git", "-C", str(repo), "diff", "--quiet", "origin/master", "--", "gui"], capture_output=True)
            if diff.returncode != 0:
                drift.append("gui/ differs from origin/master (Desk source is read-only here)")
    if role == "public" and PERSONAL_REMOTE in remotes:
        drift.append("a 'personal' remote exists in a public checkout")
    ids = pattern_path()
    try:
        patterns = load_patterns(ids)
    except ValueError as err:
        patterns = None
        drift.append(str(err))
    if patterns is None:
        lines.append(f"identifier file: missing ({ids})")
        drift.append(f"identifier file missing at {ids} (run python tools/split_setup.py)")
    else:
        lines.append(f"identifier file: {ids} ({len(patterns)} patterns)")
        if role == "public" and patterns:
            hits = tree_hits(repo, "HEAD", patterns)
            if hits:
                drift.append("personal identifiers in HEAD:\n" + _format_hits(hits))
    if drift:
        lines.append("Drift:")
        lines += [f"  - {item}" for item in drift]
        return Outcome(1, "\n".join(lines))
    lines.append("Split guard: no drift.")
    return Outcome(0, "\n".join(lines))


def main(argv=None) -> int:
    import argparse
    import json

    parser = argparse.ArgumentParser(description="Personal/public split guardrails.")
    parser.add_argument("--hook", choices=["pre-commit", "pre-push"])
    parser.add_argument("--claude-guard", action="store_true")
    parser.add_argument("--banner", action="store_true")
    parser.add_argument("hook_args", nargs="*")
    args = parser.parse_args(argv)

    try:
        repo = repo_root()
    except RuntimeError as err:
        print(f"split guard: not inside a git checkout ({err})", file=sys.stderr)
        return 0 if args.claude_guard else 1
    role = detect_role(repo)

    if args.banner:
        print(banner(role))
        return 0

    try:
        patterns = load_patterns(pattern_path())
    except ValueError as err:
        print(f"split guard: {err}", file=sys.stderr)
        return 2 if args.claude_guard else 1

    if args.hook == "pre-commit":
        outcome = hook_pre_commit(repo, role, patterns)
    elif args.hook == "pre-push":
        remote_name = args.hook_args[0] if args.hook_args else ""
        ref_lines = [line for line in sys.stdin.read().splitlines() if line.strip()]
        outcome = hook_pre_push(repo, role, patterns, remote_name, ref_lines)
    elif args.claude_guard:
        try:
            payload = json.loads(sys.stdin.read() or "{}")
        except json.JSONDecodeError:
            payload = {}
        outcome = claude_guard(repo, role, patterns, payload)
    else:
        outcome = report(repo, role)
        print(outcome.message)
        return outcome.code

    if outcome.message:
        print(outcome.message, file=sys.stderr)
    return outcome.code


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m unittest tests.test_split_check -v`
Expected: 34 tests, `OK`

- [ ] **Step 5: Run the whole suite**

Run: `python -m unittest discover -s tests -t .`
Expected: `OK` (326 + 34 = 360 tests)

- [ ] **Step 6: Commit**

```bash
git add tools/split_check.py tests/test_split_check.py
git commit -m "Add the Claude guard, banner, report, and CLI to the split guard"
```

---

### Task 6: Hook shims and the setup script

**Files:**
- Create: `.githooks/split-guard`
- Create: `.githooks/pre-commit`
- Create: `.githooks/pre-push`
- Create: `tools/split_setup.py`
- Modify: `tests/test_split_check.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_split_check.py`:

```python
class Setup(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.ids = self.root / "ids.txt"
        self.env = {**os.environ, "SPLIT_IDENTIFIERS_FILE": str(self.ids)}

    def run_setup(self, repo: Path):
        return subprocess.run(
            [sys.executable, str(REPO_ROOT / "tools" / "split_setup.py")],
            cwd=repo, capture_output=True, text=True, encoding="utf-8", env=self.env,
        )

    def test_personal_setup_disables_origin_push_and_is_idempotent(self):
        repo = make_repo(self.root, "personal")
        git(repo, "remote", "add", "upstream", "https://example.invalid/upstream.git")
        first = self.run_setup(repo)
        self.assertEqual(git(repo, "config", "--get", "remote.origin.pushurl").strip(), "DISABLED")
        self.assertEqual(git(repo, "config", "--get", "remote.upstream.pushurl").strip(), "DISABLED")
        self.assertEqual(git(repo, "config", "--get", "core.hooksPath").strip(), ".githooks")
        self.assertTrue(self.ids.exists())
        second = self.run_setup(repo)
        self.assertEqual(first.stdout.replace("\r", ""), second.stdout.replace("\r", ""))

    def test_public_setup_removes_the_personal_remote(self):
        repo = make_repo(self.root, "public")
        git(repo, "remote", "add", "personal", PERSONAL_URL)
        self.run_setup(repo)
        self.assertNotIn("personal", git(repo, "remote").split())
        self.assertEqual(git(repo, "config", "--get", "core.hooksPath").strip(), ".githooks")

    def test_unknown_setup_refuses(self):
        proc = self.run_setup(make_repo(self.root, "unknown"))
        self.assertEqual(proc.returncode, 1)
        self.assertIn("unknown", proc.stdout + proc.stderr)
```

Note: `detect_role` returns `unknown` for a public checkout that still has a `personal` remote, so `split_setup.py` must decide the role from the origin URL before it removes that remote. The implementation below does that with `intended_role`. That rule is tightened so a personal checkout on a side branch is never mistaken for a public one: `intended_role` returns `public` only when origin is the public URL, the branch read by `symbolic-ref` is not `personal`, no local `personal` branch exists, and `remote.origin.pushurl` is not already disabled; otherwise it refuses and, when a `personal` remote exists, tells the person to `git checkout personal` and rerun.

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m unittest tests.test_split_check.Setup -v`
Expected: 3 failures, `No such file or directory: ...tools/split_setup.py`

- [ ] **Step 3: Write the hook shims**

Create `.githooks/split-guard`:

```sh
#!/bin/sh
# Personal/public split guard shim. Finds a Python interpreter and forwards
# every argument and stdin to tools/split_check.py. Activated per checkout by
# tools/split_setup.py (git config core.hooksPath .githooks) and used by the
# Claude Code hooks in .claude/settings.json. A missing interpreter refuses:
# a guard that cannot run is a failure, not a pass.
root=$(git rev-parse --show-toplevel 2>/dev/null) || root=.
for py in python3 python "py -3"; do
  if $py -c "import sys" >/dev/null 2>&1; then
    exec $py "$root/tools/split_check.py" "$@"
  fi
done
echo "split guard: no Python interpreter found (python3, python, py -3); refusing." >&2
exit 2
```

Create `.githooks/pre-commit`:

```sh
#!/bin/sh
exec "$(git rev-parse --show-toplevel)/.githooks/split-guard" --hook pre-commit "$@"
```

Create `.githooks/pre-push`:

```sh
#!/bin/sh
exec "$(git rev-parse --show-toplevel)/.githooks/split-guard" --hook pre-push "$@"
```

Mark them executable in the index (Windows filesystems drop the bit):

```bash
git add .githooks/split-guard .githooks/pre-commit .githooks/pre-push
git update-index --chmod=+x .githooks/split-guard .githooks/pre-commit .githooks/pre-push
```

- [ ] **Step 4: Write the setup script**

Create `tools/split_setup.py`:

```python
#!/usr/bin/env python3
"""Wire one checkout for the personal/public split. Safe to rerun.

Run inside the checkout: python tools/split_setup.py

personal: origin (and upstream) push URLs set to DISABLED; fetch keeps working.
public:   any remote named 'personal' removed; upstream push DISABLED.
both:     core.hooksPath = .githooks, hook files executable, identifier file
          created in the Desk's shared state folder if missing, then the report.
"""

import os
import stat
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import split_check  # noqa: E402

TEMPLATE = (
    "# Personal identifiers the public repo must never contain.\n"
    "# One case-insensitive regular expression per line; '#' starts a comment.\n"
    "# Add surname, private repo name, home town, employer, phone fragment.\n"
)


def intended_role(repo: Path) -> str:
    """Like detect_role, but a public origin with a leftover 'personal' remote is public."""
    role = split_check.detect_role(repo)
    if role != "unknown":
        return role
    branch = split_check.git(repo, "rev-parse", "--abbrev-ref", "HEAD", check=False).strip()
    origin = split_check.git(repo, "config", "--get", "remote.origin.url", check=False).strip()
    if branch != "personal" and split_check.PUBLIC_ORIGIN.lower() in origin.lower():
        return "public"
    return "unknown"


def main() -> int:
    repo = split_check.repo_root()
    role = intended_role(repo)
    if role == "unknown":
        print(split_check.UNKNOWN_MESSAGE)
        return 1
    remotes = set(split_check.git(repo, "remote").split())
    if role == "personal":
        split_check.git(repo, "config", "remote.origin.pushurl", "DISABLED")
        if "upstream" in remotes:
            split_check.git(repo, "config", "remote.upstream.pushurl", "DISABLED")
    else:
        if split_check.PERSONAL_REMOTE in remotes:
            split_check.git(repo, "remote", "remove", split_check.PERSONAL_REMOTE)
        if "upstream" in remotes:
            split_check.git(repo, "config", "remote.upstream.pushurl", "DISABLED")
    split_check.git(repo, "config", "core.hooksPath", ".githooks")
    for name in ("split-guard", "pre-commit", "pre-push"):
        hook = repo / ".githooks" / name
        if hook.exists() and os.name != "nt":
            hook.chmod(hook.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    ids = split_check.pattern_path()
    if not ids.exists():
        ids.parent.mkdir(parents=True, exist_ok=True)
        ids.write_text(TEMPLATE, encoding="utf-8")
        print(f"Created {ids}. Add your identifiers there, one regular expression per line.")
    outcome = split_check.report(repo, split_check.detect_role(repo))
    print(outcome.message)
    return outcome.code


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `python -m unittest tests.test_split_check -v`
Expected: 37 tests, `OK`. (The personal idempotence test compares two reports; both report the identifier file as present but empty of patterns, which is not drift, so the outputs match.)

- [ ] **Step 6: Live-check the shims in a throwaway repo**

```bash
tmp=$(mktemp -d) && cd "$tmp" && git init -q -b main && git config user.email t@example.invalid && git config user.name t
mkdir -p .githooks tools && cp <public-checkout>/.githooks/* .githooks/ && cp <public-checkout>/tools/split_check.py tools/
git remote add origin https://github.com/iLevyTate/ai-job-search.git && git config core.hooksPath .githooks
echo x > a.txt && git add -A && git commit -q -m init && echo committed
```
Expected: `committed` (public role, no identifier file, hook warns and passes).

- [ ] **Step 7: Commit**

```bash
git add .githooks tools/split_setup.py tests/test_split_check.py
git commit -m "Add the split guard hook shims and the per-checkout setup script"
```

---

### Task 7: Claude Code hooks and the security guard allowlist

**Files:**
- Modify: `.claude/settings.json`
- Modify: `tools/security_guards.py:140`
- Modify: `tests/test_security_guards.py`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_security_guards.py`:

```python
class SplitGuardHooksAreAllowed(unittest.TestCase):
    def test_the_two_split_guard_hooks_and_nothing_else(self):
        self.assertEqual(
            security_guards.ALLOWED_HOOKS,
            {
                "SessionStart:sh .githooks/split-guard --banner",
                "PreToolUse:sh .githooks/split-guard --claude-guard",
            },
        )

    def test_shipped_settings_pass_the_guard(self):
        result = run_guards(REPO_ROOT)
        self.assertEqual(result.returncode, 0, result.stdout)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python -m unittest tests.test_security_guards.SplitGuardHooksAreAllowed -v`
Expected: first test fails (`set()` != expected)

- [ ] **Step 3: Add the hooks to settings and the allowlist**

In `.claude/settings.json`, add a `hooks` key after `permissions` (keep the existing `allow` list untouched):

```json
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "sh .githooks/split-guard --banner" } ] }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [ { "type": "command", "command": "sh .githooks/split-guard --claude-guard" } ]
      }
    ]
  }
```

In `tools/security_guards.py`, replace line 140:

```python
# The two split-guard hooks (tools/split_check.py via the .githooks shim):
# a role banner at session start, and a PreToolUse guard that refuses Desk
# edits in a personal checkout or personal identifiers in the public one.
ALLOWED_HOOKS: set[str] = {
    "SessionStart:sh .githooks/split-guard --banner",
    "PreToolUse:sh .githooks/split-guard --claude-guard",
}
```

Also update the docstring's item 1 at the top of `security_guards.py` by appending: `The only hooks allowed are the two split-guard commands.`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python -m unittest tests.test_security_guards -v && python tools/security_guards.py`
Expected: `OK` and `security_guards: OK (...)`

- [ ] **Step 5: Live-check the Claude guard path through the shim**

```bash
echo '{"tool_name":"Write","tool_input":{"file_path":"'"$(pwd)"'/gui/x.mjs","content":"x"}}' | sh .githooks/split-guard --claude-guard; echo "exit=$?"
```
Expected in the public checkout: `exit=0` (public role; content has no identifiers). Then `sh .githooks/split-guard --banner` prints `Workspace role: public ...`.

- [ ] **Step 6: Commit**

```bash
git add .claude/settings.json tools/security_guards.py tests/test_security_guards.py
git commit -m "Run the split guard from Claude Code hooks and allowlist it"
```

---

### Task 8: Documentation, full suite, push, PR

**Files:**
- Modify: `AGENTS.md` (append a section after "Thin-Pointer Design")
- Modify: `CHANGELOG.md` (Unreleased, Added)

- [ ] **Step 1: Add the AGENTS.md section**

Insert before `## Learned User Preferences`:

```markdown
## Private fork guardrails

If you keep a private job-search checkout next to this public one, the two
must never share a push target. `tools/split_check.py` derives a checkout's
role from git: **personal** is branch `personal` with a remote named
`personal`; **public** is `remote.origin.url` on `iLevyTate/ai-job-search`
with no `personal` remote; anything else is unknown and every guard refuses.

Run once per checkout: `python tools/split_setup.py`. It disables pushing to
`origin` from a personal checkout, removes a `personal` remote from a public
one, activates the tracked hooks in `.githooks/`, and creates the identifier
file (`split-identifiers.txt` in the Desk's shared state folder, one regular
expression per line; never committed).

What the guards enforce:
- Personal: `git push` only to `personal`; `gui/` is read-only (edit the
  Desk in the public checkout, then `git fetch origin && git merge
  origin/master`); a merge in progress may touch `gui/`.
- Public: no push to `personal`; staged lines and pushed trees that match
  the identifier file are refused.
- Claude Code: the same guard runs before Edit and Write, and a role banner
  prints at session start.

`python tools/split_check.py` with no arguments prints a drift report and
exits 1 on drift. Never copy files from the personal tree into the public
one; port by hand.
```

- [ ] **Step 2: Add the changelog entry**

Under `## [Unreleased]` / `### Added`, add as the first bullet:

```markdown
- Personal/public split guardrails: `tools/split_check.py` and
  `tools/split_setup.py`, tracked git hooks under `.githooks/`, and two Claude
  Code hooks that refuse a push to the wrong remote, a Desk edit in a private
  checkout, or personal identifiers in the public one. See AGENTS.md.
```

- [ ] **Step 3: Run everything**

```bash
python -m unittest discover -s tests -t .
python tools/lint_skills.py
python tools/security_guards.py
git grep -iIE "kennedy|ai-job-search-personal|jamestown|labcorp|336-252" -- . ':!gui/node_modules' | grep -v 'iLevyTate/ai-job-search'
```
Expected: `OK` (360 tests), `lint_skills: OK`, `security_guards: OK`, and an empty grep.

- [ ] **Step 4: Commit, push, PR**

```bash
git add AGENTS.md CHANGELOG.md
git commit -m "Document the private fork guardrails"
git push -u origin split-guardrails
gh pr create --repo iLevyTate/ai-job-search --base master --head split-guardrails --title "Add personal/public split guardrails" --body "Role detection from git, tracked git hooks, Claude Code hooks, a setup script, and a drift report. Spec: docs/superpowers/specs/2026-09-10-personal-public-split-guardrails-design.md. Tests: tests/test_split_check.py (37) plus the security-guard allowlist pin."
```

---

### Task 9: Personal tree: archive the Desk work and make gui/ read-only

Run in `C:\Users\benja\Documents\GitHub\ai-job-search`. Nothing here is pushed to `origin`.

- [ ] **Step 1: Confirm the starting state**

```bash
git branch --show-current          # personal
git status --short gui | wc -l     # about 25 (15 modified, 10 untracked)
```

- [ ] **Step 2: Archive on a branch pushed to the personal remote only**

```bash
git checkout -b personal-desk-archive
git add -A gui
git commit -m "Archive the personal Desk work (board, tools installer, updater, DOCX import) before gui/ becomes read-only on personal"
git push -u personal personal-desk-archive
git checkout personal
git status --short gui | wc -l     # 0: the gui/ changes now live only on the archive branch
```

- [ ] **Step 3: Replace gui/ with the public 1.3.0 tree**

```bash
git fetch origin
git rm -r -q gui
git checkout origin/master -- gui
```

Edit `.gitignore` in the personal tree: delete the line `gui/public/dist/` (public tracks the bundle; keeping the ignore would make every merge of `gui/public/dist/desk.js` a surprise). Keep `gui/release/` ignored.

```bash
git add -A gui .gitignore
git commit -m "Desk source is read-only on personal; gui/ now mirrors origin/master"
git diff --quiet origin/master -- gui && echo "gui matches public"
```
Expected: `gui matches public`.

- [ ] **Step 4: Run the personal Python suite**

```bash
python -m unittest discover -s tests -t . 2>&1 | tail -3
```
Expected: `380` run, the same 11 pre-existing failures, none new.

---

### Task 10: Personal tree: bring in the tooling and wire the guards

- [ ] **Step 1: Merge the tooling branch (after Task 8 pushed it)**

```bash
git fetch origin split-guardrails
git merge origin/split-guardrails
```
If `.claude/settings.json`, `tools/security_guards.py`, or `AGENTS.md` conflict, keep both sides: the personal permissions list plus the new `hooks` block; the personal `ALLOWED_PERMISSIONS` plus the new `ALLOWED_HOOKS`; the existing "Personal vs public (always)" section plus the new "Private fork guardrails" section.

- [ ] **Step 2: Update the personal AGENTS.md table**

In "Personal vs public (always)", replace the second table row's Checkout cell `../ai-job-search-desk-release` with `../ai-job-search-public`, and add a row-level note under the table: `gui/ here is read-only and mirrors origin/master; the Desk that runs against this folder is the installed public build. Guards: python tools/split_check.py.`

- [ ] **Step 3: Wire the tree and fill the identifier file**

```bash
python tools/split_setup.py
```
Expected: the report ends with `Split guard: no drift.` except for the identifier line if the file was just created. Then open the file it names (`%APPDATA%\ai-job-search\split-identifiers.txt`) and add one regular expression per line for: surname, the private repo name, home town, current employer, and the phone-number prefix. Re-run `python tools/split_setup.py`; expected `Split guard: no drift.`

- [ ] **Step 4: Live checks, each expected to refuse**

```bash
echo "// probe" >> gui/server.mjs && git add gui/server.mjs && git commit -m probe; echo "exit=$?"   # expect exit=1, message names ai-job-search-public
git restore --staged gui/server.mjs && git checkout -- gui/server.mjs
git push origin personal; echo "exit=$?"                                                            # expect a git error: DISABLED is not a URL
echo '{"tool_name":"Write","tool_input":{"file_path":"'"$(pwd)"'/gui/x.mjs","content":"x"}}' | sh .githooks/split-guard --claude-guard; echo "exit=$?"   # expect exit=2
sh .githooks/split-guard --banner                                                                    # expect "Workspace role: personal ..."
```

- [ ] **Step 5: Commit and push to the personal remote**

```bash
git add AGENTS.md
git commit -m "Point the split rule at the single public checkout and the guard tooling"
git push personal personal
```

---

### Task 11: Public tree: consolidate to one checkout

- [ ] **Step 1: Save the dirty work in the old release checkout**

```bash
cd C:/Users/benja/Documents/GitHub/ai-job-search-desk-release
git status --short | wc -l        # 29
git add -A
git commit -m "WIP: desk command guidance (parked during checkout consolidation)"
git push -u origin desk-command-guidance
```

- [ ] **Step 2: Rename the 1.3.0 checkout and wire it**

```bash
cd C:/Users/benja/Documents/GitHub
mv ai-job-search-desk-1.3.0 ai-job-search-public
cd ai-job-search-public
git remote -v                     # still has a 'personal' remote until setup removes it
python tools/split_setup.py       # removes 'personal', sets hooksPath, prints the report
```
Expected: report ends `Split guard: no drift.`

- [ ] **Step 3: Live checks, each expected to refuse or pass as noted**

```bash
git checkout -q master && git pull -q origin master
echo "contact <your surname here>" > probe.md && git add probe.md && git commit -m probe; echo "exit=$?"   # expect exit=1 with probe.md:1
git restore --staged probe.md && rm probe.md
sh .githooks/split-guard --banner                                                                            # expect "Workspace role: public ..."
```

- [ ] **Step 4: Update the memory note and the audit branches**

The branches `desk-usability-audit` and `split-guardrails` moved with the folder rename; confirm with `git branch`. Update the memory file `desk-orphaned-dist-rewrite.md` so the clean public checkout is named `ai-job-search-public`.

---

### Task 12: Personal tree: confirm a public-to-personal merge still lands Desk updates

- [ ] **Step 1: After PR #21 (the audit fixes) merges to master**

```bash
cd C:/Users/benja/Documents/GitHub/ai-job-search
git fetch origin
git merge origin/master            # touches gui/; allowed because MERGE_HEAD exists during a conflicted merge, and a clean merge makes no commit through pre-commit
git diff --quiet origin/master -- gui && echo "gui matches public"
python tools/split_check.py        # expect no drift
git push personal personal
```

---

### Task 13: Delete the five stale public folders (explicit go required)

Do not start this task until the person says so in the session.

- [ ] **Step 1: Prove each folder has nothing unique**

For each of `ai-job-search-desk-12`, `ai-job-search-desk125`, `ai-job-search-desk-pr`, `ai-job-search-desk-release`, `ai-job-search-public-pr`:

```bash
cd C:/Users/benja/Documents/GitHub/<folder>
git status --short | wc -l                  # expect 0
git log --branches --not --remotes --oneline | wc -l    # expect 0 (no unpushed commits)
git stash list | wc -l                      # expect 0
```
Any non-zero count stops the deletion of that folder; report it instead.

- [ ] **Step 2: Delete**

```bash
cd C:/Users/benja/Documents/GitHub
rm -rf ai-job-search-desk-12 ai-job-search-desk125 ai-job-search-desk-pr ai-job-search-desk-release ai-job-search-public-pr
ls -d ai-job-search*                        # expect: ai-job-search  ai-job-search-public
```

- [ ] **Step 3: Update the memory note**

Record in `desk-orphaned-dist-rewrite.md` that only two checkouts remain and the split guards are live in both.

---

## Self-review

**Spec coverage.** Role detection (Task 1), identifier file in the shared state folder with env override (Tasks 1-2), pre-commit and pre-push rules with the merge exception, exclusions, and the allowed URL (Tasks 3-4), Claude guard with exit 2 and unparseable-input pass, banner, report with exit 1 (Task 5), shims failing closed and idempotent setup (Task 6), settings hooks and allowlist (Task 7), AGENTS.md and changelog (Task 8), archive-then-restore migration (Task 9), wiring and live checks in personal (Task 10), consolidation with the WIP push first and rename (Task 11), merge still lands Desk updates (Task 12), deletion last and gated (Task 13). Error handling from the spec: unknown role refuses everywhere (Tasks 4-6), missing Python refuses (Task 6 shim), missing pattern file warns and passes in hooks and is drift in the report (Tasks 4-5), bad regex names the line (Task 2), binary files skipped by `-I` and `-U0` (Task 3).

**Placeholders.** None; every step has its code or command. The one deliberate blank is the identifier file's contents, which must be typed by the person and never appears in a repo.

**Type consistency.** `Outcome(code, message)` is used by `hook_pre_commit`, `hook_pre_push`, `claude_guard`, and `report`; `main` prints `.message` to stderr for hooks and guards, stdout for the report; tests read `.code` and `.message`. `pattern_path(env=...)`, `state_dir(platform, env, home)`, `load_patterns(path)`, `scan_lines(located, patterns)`, `excluded(rel)`, `staged_paths(repo)`, `staged_added_lines(repo)`, `tree_hits(repo, ref, patterns)`, `merge_in_progress(repo)` match between implementation and tests. The hook command strings in `settings.json`, `ALLOWED_HOOKS`, and the test are identical.
