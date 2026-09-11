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
        (repo / ".git" / "MERGE_HEAD").write_text("deadbeef\n", encoding="utf-8")
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
        sha = git(repo, "rev-parse", "HEAD").stdout.strip()
        refs = [f"refs/heads/main {sha} refs/heads/main {ZEROS}"]
        result = split_check.hook_pre_push(repo, "public", self.patterns, "origin", refs)
        self.assertEqual(result.code, 1)
        self.assertIn("cv/main.tex:1", result.message)

    def test_public_passes_a_clean_tree_and_a_branch_deletion(self):
        repo = make_repo(self.root, "public")
        sha = git(repo, "rev-parse", "HEAD").stdout.strip()
        self.assertEqual(split_check.hook_pre_push(repo, "public", self.patterns, "origin", [f"refs/heads/main {sha} refs/heads/main {ZEROS}"]).code, 0)
        self.assertEqual(split_check.hook_pre_push(repo, "public", self.patterns, "origin", [f"(delete) {ZEROS} refs/heads/old {sha}"]).code, 0)


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


if __name__ == "__main__":
    unittest.main()
