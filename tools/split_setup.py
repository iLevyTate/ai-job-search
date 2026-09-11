#!/usr/bin/env python3
"""Wire one checkout for the personal/public split. Safe to rerun.

Run inside the checkout: python tools/split_setup.py

personal: origin (and upstream) push URLs set to DISABLED; fetch keeps working.
public:   any remote named 'personal' removed (announced with the undo command);
          upstream push DISABLED. A tree that also has a local 'personal' branch or
          an already-disabled origin push is refused instead of wired as public.
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


def local_branch_exists(repo: Path, name: str) -> bool:
    return bool(split_check.git(repo, "rev-parse", "--verify", "--quiet", f"refs/heads/{name}", check=False).strip())


def intended_role(repo: Path) -> str:
    """Like detect_role, but a public origin with a leftover 'personal' remote is public.

    Only when nothing else says the tree is personal: the branch is not 'personal',
    no local branch named 'personal' exists, and origin push is not already
    disabled. A personal checkout on a side branch matches the leftover shape
    otherwise, and wiring it as public would remove its 'personal' remote.
    """
    role = split_check.detect_role(repo)
    if role != "unknown":
        return role
    origin = split_check.git(repo, "config", "--get", "remote.origin.url", check=False).strip()
    if split_check.PUBLIC_ORIGIN.lower() not in origin.lower():
        return "unknown"
    if split_check.current_branch(repo) == "personal" or local_branch_exists(repo, "personal"):
        return "unknown"
    origin_push = split_check.git(repo, "config", "--get", "remote.origin.pushurl", check=False).strip()
    if origin_push in ("DISABLED", "DISABLE"):
        return "unknown"
    return "public"


def remove_remote(repo: Path, name: str) -> None:
    url = split_check.git(repo, "config", "--get", f"remote.{name}.url", check=False).strip()
    print(f"Removing remote {name} ({url}); restore with: git remote add {name} {url}")
    split_check.git(repo, "remote", "remove", name)


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(errors="backslashreplace")

    try:
        repo = split_check.repo_root()
        role = intended_role(repo)
        remotes = set(split_check.git(repo, "remote").split())
        if role == "unknown":
            if split_check.PERSONAL_REMOTE in remotes:
                branch = split_check.current_branch(repo)
                print(
                    f"split setup: this looks like a personal checkout on branch '{branch}' "
                    f"(a '{split_check.PERSONAL_REMOTE}' remote exists); run 'git checkout personal' and rerun.",
                    file=sys.stderr,
                )
            else:
                print(split_check.UNKNOWN_MESSAGE, file=sys.stderr)
            return 1
        if role == "personal":
            split_check.git(repo, "config", "remote.origin.pushurl", "DISABLED")
            if "upstream" in remotes:
                split_check.git(repo, "config", "remote.upstream.pushurl", "DISABLED")
        else:
            if split_check.PERSONAL_REMOTE in remotes:
                remove_remote(repo, split_check.PERSONAL_REMOTE)
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
    except RuntimeError as err:
        print(f"split setup: {err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
