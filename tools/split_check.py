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
    located = [(rel, rel)] + [(f"{rel}:{n}", line) for n, line in enumerate(str(content).splitlines(), start=1)]
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
