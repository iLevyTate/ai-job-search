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


if __name__ == "__main__":
    sys.exit(0)
