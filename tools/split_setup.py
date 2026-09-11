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
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="backslashreplace")

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
