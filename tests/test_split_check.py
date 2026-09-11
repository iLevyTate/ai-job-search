"""Tests for tools/split_check.py against throwaway git repos.

Every repo is built in a temp dir; nothing here touches the real checkouts or
the real identifier file (SPLIT_IDENTIFIERS_FILE points at a temp file).
"""

import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "tools"))
import split_check  # noqa: E402
import split_setup  # noqa: E402

PUBLIC_URL = "https://github.com/iLevyTate/ai-job-search.git"
PERSONAL_URL = "https://example.invalid/ai-job-search-private.git"

_isolation = None
_saved_env = {}


def setUpModule():
    """Point every git call (in-process and CLI subprocess) at an empty global config and no system config."""
    global _isolation
    _isolation = tempfile.TemporaryDirectory()
    empty_config = Path(_isolation.name) / "gitconfig"
    empty_config.write_text("", encoding="utf-8")
    for key, value in (("GIT_CONFIG_GLOBAL", str(empty_config)), ("GIT_CONFIG_NOSYSTEM", "1")):
        _saved_env[key] = os.environ.get(key)
        os.environ[key] = value


def tearDownModule():
    for key, value in _saved_env.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
    _isolation.cleanup()


def git(repo: Path, *args: str, input: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True, text=True, encoding="utf-8", input=input, check=True, env=os.environ,
    )


def git_dir(repo: Path) -> Path:
    found = Path(git(repo, "rev-parse", "--git-dir").stdout.strip())
    return found if found.is_absolute() else repo / found


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

    def test_personal_survives_a_remote_tracking_ref_that_shares_the_branch_name(self):
        # After fetching the personal remote, refs/remotes/personal/personal exists and
        # refs/remotes/personal/HEAD points at it (git remote set-head, or a clone), so
        # rev-parse --abbrev-ref HEAD prints "heads/personal"; the role must still be personal.
        repo = make_repo(self.root, "personal")
        git(repo, "update-ref", "refs/remotes/personal/personal", "HEAD")
        git(repo, "symbolic-ref", "refs/remotes/personal/HEAD", "refs/remotes/personal/personal")
        self.assertEqual(git(repo, "rev-parse", "--abbrev-ref", "HEAD").stdout.strip(), "heads/personal")
        self.assertEqual(split_check.current_branch(repo), "personal")
        self.assertEqual(split_check.detect_role(repo), "personal")

    def test_detached_head_is_unknown(self):
        repo = make_repo(self.root, "personal")
        git(repo, "checkout", "-q", "--detach")
        self.assertEqual(split_check.current_branch(repo), "")
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

    def test_allowed_url_filter_is_case_insensitive(self):
        patterns = split_check.load_patterns(self.write("ai-job-search\n"))
        hits = split_check.scan_lines([("a.md:1", "see ilevytate/ai-job-search")], patterns)
        self.assertEqual(hits, [])

    def test_allowed_url_filter_does_not_hide_a_private_remote_url(self):
        patterns = split_check.load_patterns(self.write("ai-job-search-private\n"))
        line = "git remote add personal https://github.com/iLevyTate/ai-job-search-private.git"
        self.assertEqual(split_check.scan_lines([("a.md:1", line)], patterns), [("a.md:1", line)])

    def test_allowed_url_filter_still_covers_git_suffix_and_sub_paths(self):
        patterns = split_check.load_patterns(self.write("ai-job-search\n"))
        located = [
            ("a.md:1", "clone https://github.com/iLevyTate/ai-job-search.git"),
            ("a.md:2", "see https://github.com/iLevyTate/ai-job-search/issues/1"),
        ]
        self.assertEqual(split_check.scan_lines(located, patterns), [])


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
        (git_dir(self.repo) / "MERGE_HEAD").write_text("deadbeef\n", encoding="utf-8")
        self.assertTrue(split_check.merge_in_progress(self.repo))

    def test_tree_hits_scan_file_names_too(self):
        (self.repo / "cv" / "Jane_Smith_Resume.tex").write_text("", encoding="utf-8")
        git(self.repo, "add", "cv/Jane_Smith_Resume.tex")
        git(self.repo, "commit", "-q", "-m", "add an empty resume")
        sha = git(self.repo, "rev-parse", "HEAD").stdout.strip()
        patterns = [re.compile("smith", re.I)]
        expected = [("cv/Jane_Smith_Resume.tex", "cv/Jane_Smith_Resume.tex")]
        self.assertEqual(split_check.tree_hits(self.repo, sha, patterns), expected)
        self.assertEqual(split_check.tree_hits(self.repo, None, patterns), expected)

    def test_non_ascii_staged_paths_are_not_quoted(self):
        (self.repo / "cv" / "résumé.tex").write_text("Jane Smith\n", encoding="utf-8")
        git(self.repo, "add", "cv/résumé.tex")
        added = list(split_check.staged_added_lines(self.repo))
        self.assertEqual(added, [("cv/résumé.tex:1", "Jane Smith")])
        self.assertIn("cv/résumé.tex", split_check.staged_paths(self.repo))

    def test_added_line_starting_with_plus_plus_is_content_not_a_header(self):
        (self.repo / "README.md").write_text("hello\n++ Jane Smith\n", encoding="utf-8")
        git(self.repo, "add", "README.md")
        self.assertIn(("README.md:2", "++ Jane Smith"), list(split_check.staged_added_lines(self.repo)))
        self.assertEqual(split_check.hook_pre_commit(self.repo, "public", [re.compile("smith", re.I)]).code, 1)

    def test_tree_hits_use_python_regex_syntax(self):
        (self.repo / "cv" / "main.tex").write_text("call 555-0100\n", encoding="utf-8")
        git(self.repo, "commit", "-q", "-am", "add a number")
        sha = git(self.repo, "rev-parse", "HEAD").stdout.strip()
        patterns = [re.compile(r"\d{3}-\d{4}", re.I)]
        self.assertEqual(split_check.tree_hits(self.repo, sha, patterns), [("cv/main.tex:1", "call 555-0100")])
        refs = [f"refs/heads/main {sha} refs/heads/main {'0' * 40}"]
        self.assertEqual(split_check.hook_pre_push(self.repo, "public", patterns, "origin", refs).code, 1)

    def test_tree_hits_skip_binary_blobs(self):
        (self.repo / "cv" / "blob.bin").write_bytes(b"Jane Smith\x00\x01\x02")
        git(self.repo, "add", "cv/blob.bin")
        git(self.repo, "commit", "-q", "-m", "add a binary")
        sha = git(self.repo, "rev-parse", "HEAD").stdout.strip()
        self.assertEqual(split_check.tree_hits(self.repo, sha, [re.compile("smith", re.I)]), [])

    def test_tree_hits_with_no_ref_scan_the_working_tree(self):
        (self.repo / "README.md").write_text("Jane Smith\n", encoding="utf-8")
        (self.repo / "cv" / "notes.txt").write_text("nothing\nalso Jane Smith\n", encoding="utf-8")
        (self.repo / "cv" / "blob.bin").write_bytes(b"Jane Smith\x00")
        hits = split_check.tree_hits(self.repo, None, [re.compile("smith", re.I)])
        self.assertEqual(sorted(hits), [("README.md:1", "Jane Smith"), ("cv/notes.txt:2", "also Jane Smith")])

    def test_staged_paths_include_deletions_and_both_sides_of_a_rename(self):
        git(self.repo, "rm", "-q", "gui/server.mjs")
        self.assertEqual(split_check.staged_paths(self.repo), ["gui/server.mjs"])
        git(self.repo, "reset", "-q", "--hard")
        git(self.repo, "mv", "gui/server.mjs", "cv/server.mjs")
        self.assertEqual(sorted(split_check.staged_paths(self.repo)), ["cv/server.mjs", "gui/server.mjs"])

    def test_renamed_and_edited_file_is_scanned_by_the_public_pre_commit(self):
        (self.repo / "README.md").write_text("".join(f"line {n}\n" for n in range(20)), encoding="utf-8")
        git(self.repo, "commit", "-q", "-am", "longer readme")
        git(self.repo, "mv", "README.md", "docs.md")
        with open(self.repo / "docs.md", "a", encoding="utf-8") as handle:
            handle.write("contact Jane Smith\n")
        git(self.repo, "add", "docs.md")
        status = git(self.repo, "diff", "--cached", "--name-status", "-M").stdout
        self.assertTrue(status.startswith("R"), status)
        result = split_check.hook_pre_commit(self.repo, "public", [re.compile("smith", re.I)])
        self.assertEqual(result.code, 1)
        self.assertIn("docs.md", result.message)

    def test_header_path_with_spaces_has_no_trailing_tab(self):
        (self.repo / "cv" / "my file.tex").write_text("Jane Smith\n", encoding="utf-8")
        git(self.repo, "add", "cv/my file.tex")
        added = list(split_check.staged_added_lines(self.repo))
        self.assertEqual(added, [("cv/my file.tex:1", "Jane Smith")])
        self.assertFalse(any("\t" in location for location, _ in added))


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
        (git_dir(repo) / "MERGE_HEAD").write_text("deadbeef\n", encoding="utf-8")
        self.assertEqual(split_check.hook_pre_commit(repo, "personal", self.patterns).code, 0)

    def test_public_refuses_an_identifier_in_a_staged_file_name(self):
        repo = make_repo(self.root, "public")
        self.stage(repo, "cv/Jane_Smith_Resume.tex", "")
        result = split_check.hook_pre_commit(repo, "public", self.patterns)
        self.assertEqual(result.code, 1)
        self.assertIn("cv/Jane_Smith_Resume.tex", result.message)

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

    def test_personal_refuses_a_gui_deletion(self):
        repo = make_repo(self.root, "personal")
        git(repo, "rm", "-q", "gui/server.mjs")
        result = split_check.hook_pre_commit(repo, "personal", self.patterns)
        self.assertEqual(result.code, 1)
        self.assertIn("gui/server.mjs", result.message)

    def test_personal_refuses_a_rename_out_of_gui(self):
        repo = make_repo(self.root, "personal")
        git(repo, "mv", "gui/server.mjs", "cv/server.mjs")
        result = split_check.hook_pre_commit(repo, "personal", self.patterns)
        self.assertEqual(result.code, 1)
        self.assertIn("gui/server.mjs", result.message)


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

    def test_public_passes_with_a_warning_when_no_pattern_file(self):
        repo = make_repo(self.root, "public")
        sha = git(repo, "rev-parse", "HEAD").stdout.strip()
        result = split_check.hook_pre_push(repo, "public", None, "origin", [f"refs/heads/main {sha} refs/heads/main {ZEROS}"])
        self.assertEqual(result.code, 0)
        self.assertIn("no identifier file", result.message)

    def test_public_scans_each_pushed_sha_once(self):
        repo = make_repo(self.root, "public")
        sha = git(repo, "rev-parse", "HEAD").stdout.strip()
        scanned = []
        real = split_check.tree_hits

        def counting(repo_, ref, patterns):
            scanned.append(ref)
            return real(repo_, ref, patterns)

        refs = [f"refs/heads/a {sha} refs/heads/a {ZEROS}", f"refs/heads/b {sha} refs/heads/b {ZEROS}"]
        with mock.patch.object(split_check, "tree_hits", counting):
            self.assertEqual(split_check.hook_pre_push(repo, "public", self.patterns, "origin", refs).code, 0)
        self.assertEqual(scanned, [sha])


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

    def test_personal_allows_gui_writes_during_a_merge(self):
        repo = make_repo(self.root, "personal")
        (git_dir(repo) / "MERGE_HEAD").write_text("deadbeef\n", encoding="utf-8")
        self.assertEqual(split_check.claude_guard(repo, "personal", self.patterns, self.payload(repo, "gui/x.mjs", "x")).code, 0)

    def test_public_scans_multiedit_new_strings(self):
        repo = make_repo(self.root, "public")
        payload = {"tool_name": "MultiEdit", "tool_input": {
            "file_path": str(repo / "README.md"),
            "edits": [{"old_string": "hello", "new_string": "contact Jane Smith"}, {"old_string": "a", "new_string": "b"}],
        }}
        result = split_check.claude_guard(repo, "public", self.patterns, payload)
        self.assertEqual(result.code, 2)
        self.assertIn("README.md:1", result.message)

    def test_public_warns_when_no_pattern_file(self):
        repo = make_repo(self.root, "public")
        result = split_check.claude_guard(repo, "public", None, self.payload(repo, "README.md", "Jane Smith"))
        self.assertEqual(result.code, 0)
        self.assertIn("no identifier file", result.message)


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
            cwd=repo, capture_output=True, text=True, encoding="utf-8", errors="replace", input=input, env=self.env,
        )

    def test_claude_guard_judges_the_target_files_repo_not_the_cwd(self):
        personal = make_repo(self.root, "personal")
        public = make_repo(self.root, "public")
        into_public = json.dumps({"tool_name": "Write", "tool_input": {"file_path": str(public / "README.md"), "content": "Jane Smith"}})
        proc = self.run_cli(personal, "--claude-guard", input=into_public)
        self.assertEqual(proc.returncode, 2, proc.stderr)
        into_personal_gui = json.dumps({"tool_name": "Write", "tool_input": {"file_path": str(personal / "gui" / "s.mjs"), "content": "x"}})
        proc = self.run_cli(public, "--claude-guard", input=into_personal_gui)
        self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_claude_guard_reads_stdin_as_utf8(self):
        repo = make_repo(self.root, "public")
        self.ids.write_text("müller\n", encoding="utf-8")
        payload = json.dumps({"tool_name": "Write", "tool_input": {"file_path": str(repo / "README.md"), "content": "Hans Müller"}}, ensure_ascii=False)
        proc = self.run_cli(repo, "--claude-guard", input=payload)
        self.assertEqual(proc.returncode, 2, proc.stderr)

    def test_report_prints_non_ascii_hits_without_a_traceback(self):
        repo = make_repo(self.root, "public")
        self.wire(repo, "public")
        (repo / "README.md").write_text("hello\ncontact Jane Smith (Смит)\n", encoding="utf-8")
        proc = self.run_cli(repo)
        self.assertEqual(proc.returncode, 1)
        self.assertNotIn("Traceback", proc.stderr)
        self.assertIn("README.md:2", proc.stdout)

    def test_claude_guard_treats_malformed_json_as_an_empty_payload(self):
        repo = make_repo(self.root, "personal")
        proc = self.run_cli(repo, "--claude-guard", input="{not json")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("no file_path", proc.stderr)

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
        git(repo, "update-ref", "refs/remotes/origin/master", "HEAD")
        (repo / "gui" / "server.mjs").write_text("// desk\n// edited here\n", encoding="utf-8")
        git(repo, "commit", "-q", "-am", "edit gui locally")
        self.wire(repo, "personal")
        git(repo, "config", "remote.origin.pushurl", PUBLIC_URL)
        proc = self.run_cli(repo)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("remote.origin.pushurl", proc.stdout)
        self.assertIn("gui/ differs from origin/master", proc.stdout)

    def test_unknown_banner_and_report_name_both_expected_shapes(self):
        repo = make_repo(self.root, "unknown")
        proc = self.run_cli(repo, "--banner")
        self.assertEqual(proc.returncode, 0)
        self.assertIn("branch 'personal'", proc.stdout)
        self.assertIn("iLevyTate/ai-job-search", proc.stdout)
        proc = self.run_cli(repo)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("branch 'personal'", proc.stdout)
        self.assertIn("iLevyTate/ai-job-search", proc.stdout)

    def test_report_scans_the_working_tree(self):
        repo = make_repo(self.root, "public")
        self.wire(repo, "public")
        (repo / "README.md").write_text("hello\ncontact Jane Smith\n", encoding="utf-8")
        proc = self.run_cli(repo)
        self.assertEqual(proc.returncode, 1, proc.stdout)
        self.assertIn("README.md:2", proc.stdout)

    def test_report_flags_a_missing_identifier_file(self):
        repo = make_repo(self.root, "public")
        self.wire(repo, "public")
        self.env["SPLIT_IDENTIFIERS_FILE"] = str(self.root / "does-not-exist.txt")
        proc = self.run_cli(repo)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("identifier file missing", proc.stdout)

    def test_report_flags_a_personal_remote_in_a_public_tree(self):
        repo = make_repo(self.root, "public")
        self.wire(repo, "public")
        git(repo, "remote", "add", "personal", PERSONAL_URL)
        proc = self.run_cli(repo)
        self.assertEqual(proc.returncode, 1)
        self.assertIn("a 'personal' remote exists", proc.stdout)

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


class MainInProcess(unittest.TestCase):
    """main() called directly, with stdin, stderr, cwd, and the identifier file all patched."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.repo = make_repo(self.root, "personal")
        previous = os.getcwd()
        os.chdir(self.repo)
        self.addCleanup(os.chdir, previous)

    def test_claude_guard_blocks_when_the_guard_itself_fails(self):
        payload = json.dumps({"tool_name": "Write", "tool_input": {"file_path": str(self.repo / "gui" / "x.mjs"), "content": "x"}}).encode("utf-8")

        def explode(repo):
            raise RuntimeError("git exploded")

        stderr = io.StringIO()
        with mock.patch.object(split_check, "merge_in_progress", explode), \
                mock.patch("sys.stdin", io.TextIOWrapper(io.BytesIO(payload), encoding="utf-8")), \
                mock.patch("sys.stderr", stderr), \
                mock.patch.dict(os.environ, {"SPLIT_IDENTIFIERS_FILE": str(self.root / "absent.txt")}):
            code = split_check.main(["--claude-guard"])
        self.assertEqual(code, 2)
        self.assertIn("internal error", stderr.getvalue())


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
            cwd=repo, capture_output=True, text=True, encoding="utf-8", errors="replace", env=self.env,
        )

    def test_personal_setup_disables_origin_push_and_is_idempotent(self):
        repo = make_repo(self.root, "personal")
        git(repo, "remote", "add", "upstream", "https://example.invalid/upstream.git")
        first = self.run_setup(repo)
        self.assertEqual(git(repo, "config", "--get", "remote.origin.pushurl").stdout.strip(), "DISABLED")
        self.assertEqual(git(repo, "config", "--get", "remote.upstream.pushurl").stdout.strip(), "DISABLED")
        self.assertEqual(git(repo, "config", "--get", "core.hooksPath").stdout.strip(), ".githooks")
        self.assertTrue(self.ids.exists())
        second = self.run_setup(repo)
        first_lines = [line for line in first.stdout.splitlines() if not line.startswith("Created ")]
        self.assertEqual(first_lines, second.stdout.splitlines())

    def test_public_setup_removes_the_personal_remote(self):
        repo = make_repo(self.root, "public")
        git(repo, "remote", "add", "personal", PERSONAL_URL)
        proc = self.run_setup(repo)
        self.assertNotIn("personal", git(repo, "remote").stdout.split())
        self.assertEqual(git(repo, "config", "--get", "core.hooksPath").stdout.strip(), ".githooks")
        self.assertIn("Workspace role: public", proc.stdout)

    def test_unknown_setup_refuses(self):
        proc = self.run_setup(make_repo(self.root, "unknown"))
        self.assertEqual(proc.returncode, 1)
        self.assertIn("unknown", (proc.stdout + proc.stderr).lower())

    def test_public_setup_disables_upstream_push(self):
        repo = make_repo(self.root, "public")
        git(repo, "remote", "add", "upstream", "https://example.invalid/upstream.git")
        self.run_setup(repo)
        self.assertEqual(git(repo, "config", "--get", "remote.upstream.pushurl").stdout.strip(), "DISABLED")

    def test_personal_setup_keeps_the_fetch_url(self):
        repo = make_repo(self.root, "personal")
        self.run_setup(repo)
        self.assertEqual(git(repo, "config", "--get", "remote.origin.url").stdout.strip(), PUBLIC_URL)

    def test_setup_is_idempotent_on_config(self):
        repo = make_repo(self.root, "personal")
        self.run_setup(repo)
        first = git(repo, "config", "--list", "--local").stdout
        self.run_setup(repo)
        second = git(repo, "config", "--list", "--local").stdout
        self.assertEqual(first, second)
        self.assertEqual(self.ids.read_text(encoding="utf-8"), split_setup.TEMPLATE)

    def test_template_is_written_when_missing(self):
        self.run_setup(make_repo(self.root, "public"))
        self.assertTrue(self.ids.read_text(encoding="utf-8").startswith("# Personal identifiers"))

    @staticmethod
    def config_get(repo: Path, key: str) -> str:
        """Empty when the key is unset (the module's git() would raise on git's exit 1)."""
        proc = subprocess.run(
            ["git", "-C", str(repo), "config", "--get", key],
            capture_output=True, text=True, encoding="utf-8", env=os.environ,
        )
        return proc.stdout.strip()

    def test_personal_checkout_on_a_feature_branch_is_not_wired_as_public(self):
        repo = make_repo(self.root, "personal")
        git(repo, "checkout", "-q", "-b", "feature")
        proc = self.run_setup(repo)
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("personal", git(repo, "remote").stdout.split())
        self.assertEqual(self.config_get(repo, "core.hooksPath"), "")
        self.assertIn("git checkout personal", proc.stderr)

    def test_public_setup_says_what_it_removes(self):
        repo = make_repo(self.root, "public")
        git(repo, "remote", "add", "personal", PERSONAL_URL)
        proc = self.run_setup(repo)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("Removing remote personal (", proc.stdout)
        self.assertIn("git remote add personal", proc.stdout)

    def test_public_setup_refuses_when_origin_push_is_already_disabled_and_personal_remote_exists(self):
        repo = make_repo(self.root, "public")
        git(repo, "remote", "add", "personal", PERSONAL_URL)
        git(repo, "config", "remote.origin.pushurl", "DISABLED")
        proc = self.run_setup(repo)
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        self.assertIn("personal", git(repo, "remote").stdout.split())

    # The sh shim under .githooks forwards to split_check.py and refuses without an interpreter.
    SHIM = REPO_ROOT / ".githooks" / "split-guard"

    def require_sh(self) -> str:
        sh = shutil.which("sh")
        if not sh:
            self.skipTest("sh is not available")
        return sh

    def test_shim_refuses_without_an_interpreter(self):
        sh = self.require_sh()
        empty = self.root / "empty-path"
        empty.mkdir()
        proc = subprocess.run(
            [sh, str(self.SHIM), "--banner"],
            cwd=REPO_ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace",
            env={**self.env, "PATH": str(empty)},
        )
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertIn("no Python interpreter", proc.stderr)

    def test_shim_forwards_arguments_and_stdin(self):
        sh = self.require_sh()
        repo = make_repo(self.root, "personal")
        (repo / "tools").mkdir()
        shutil.copy(REPO_ROOT / "tools" / "split_check.py", repo / "tools" / "split_check.py")
        payload = json.dumps({"tool_name": "Write", "tool_input": {"file_path": str(repo / "gui" / "x.mjs"), "content": "x"}})
        proc = subprocess.run(
            [sh, str(self.SHIM), "--claude-guard"],
            cwd=repo, input=payload, capture_output=True, text=True, encoding="utf-8", errors="replace", env=self.env,
        )
        self.assertEqual(proc.returncode, 2, proc.stderr)
        self.assertIn("read-only", proc.stderr)


if __name__ == "__main__":
    unittest.main()
