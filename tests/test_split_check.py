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
        sha = git(self.repo, "rev-parse", "HEAD").stdout.strip()
        patterns = [re.compile("smith", re.I)]
        self.assertEqual(split_check.tree_hits(self.repo, sha, patterns), [("cv/main.tex:1", "% Jane Smith")])
        self.assertEqual(split_check.tree_hits(self.repo, sha, [re.compile("nobody", re.I)]), [])

    def test_merge_in_progress_reads_merge_head(self):
        self.assertFalse(split_check.merge_in_progress(self.repo))
        git_dir = Path(git(self.repo, "rev-parse", "--git-dir").stdout.strip())
        if not git_dir.is_absolute():
            git_dir = self.repo / git_dir
        (git_dir / "MERGE_HEAD").write_text("deadbeef\n", encoding="utf-8")
        self.assertTrue(split_check.merge_in_progress(self.repo))


if __name__ == "__main__":
    unittest.main()
