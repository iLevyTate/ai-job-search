"""Tests for tools/split_check.py against throwaway git repos.

Every repo is built in a temp dir; nothing here touches the real checkouts or
the real identifier file (SPLIT_IDENTIFIERS_FILE points at a temp file).
"""

import json
import os
import re
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
