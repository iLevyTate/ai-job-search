import locale
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "tools" / "upstream_triage.py"
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "upstream-watch.yml"
UPSTREAM_SLUG = "MadsLorentzen/ai-job-search"


def git(root: Path, *args: str) -> str:
    # Pinned for the same reason the tool under test is: this helper commits a
    # subject containing U+201D, and decoding git's echo with the locale
    # codepage kills the reader thread. subprocess.run then returns stdout=None
    # with returncode 0, so check=True passes and the suite still reports OK
    # while printing a UnicodeDecodeError traceback. The harness that proves
    # the fix had the defect.
    return subprocess.run(
        ["git", *args], cwd=root, check=True, capture_output=True, text=True,
        encoding="utf-8", errors="replace",
    ).stdout


class TriageRepoFixture(unittest.TestCase):
    """Builds a real git history: a shared base, then an `upstream/master`
    ref that runs ahead, so the triage script can be exercised fully offline.
    """

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

        (self.root / "tools").mkdir()
        shutil.copy(SCRIPT, self.root / "tools" / "upstream_triage.py")
        (self.root / ".github").mkdir()

        git(self.root, "init", "-b", "master")
        git(self.root, "config", "user.name", "Test")
        git(self.root, "config", "user.email", "test@example.com")
        git(self.root, "remote", "add", "upstream",
            f"https://github.com/{UPSTREAM_SLUG}.git")

        self.write("shared.txt", "base\n")
        self.write("kept.py", "print('hi')\n")
        self.commit("init")

    def write(self, rel: str, text: str) -> None:
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def commit(self, msg: str) -> str:
        git(self.root, "add", "-A")
        git(self.root, "commit", "-m", msg)
        return git(self.root, "rev-parse", "HEAD").strip()

    def set_upstream_to_head(self) -> None:
        git(self.root, "update-ref", "refs/remotes/upstream/master", "HEAD")

    def run_triage(self, *args) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(self.root / "tools" / "upstream_triage.py"), *args],
            cwd=self.root, capture_output=True, text=True,
        )


class UpToDateTests(TriageRepoFixture):
    def test_reports_up_to_date_when_not_behind(self):
        self.set_upstream_to_head()
        result = self.run_triage()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Up to date", result.stdout)


class RelevanceFilterTests(TriageRepoFixture):
    def test_commit_touching_only_removed_files_is_skipped(self):
        # Upstream edits a file this fork never had -> not relevant.
        self.write("portals/removed_portal.py", "x = 1\n")
        self.commit("upstream: add removed_portal")
        self.set_upstream_to_head()
        # Fork drops back to before that commit and deletes nothing extra;
        # the file simply is not in fork HEAD.
        git(self.root, "reset", "--hard", "HEAD~1")

        result = self.run_triage()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("touches only files not in this fork", result.stdout)
        self.assertIn("Probably skip", result.stdout)

    def test_commit_touching_kept_files_is_worth_reviewing(self):
        self.write("kept.py", "print('changed')\n")
        self.commit("upstream: change kept.py")
        self.set_upstream_to_head()
        git(self.root, "reset", "--hard", "HEAD~1")

        result = self.run_triage()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Worth reviewing", result.stdout)
        self.assertIn("kept.py", result.stdout)
        # Ready-to-run cherry-pick lines are offered, not executed.
        self.assertIn("git cherry-pick", result.stdout)

    def test_changelog_only_footprint_is_skipped(self):
        self.write("portals/gone.py", "y = 2\n")
        self.write("CHANGELOG.md", "- did a thing\n")
        self.commit("upstream: feature living in removed area + changelog")
        self.set_upstream_to_head()
        # Fork ships CHANGELOG.md but not the removed portal file.
        git(self.root, "reset", "--hard", "HEAD~1")
        self.write("CHANGELOG.md", "- fork changelog\n")
        self.commit("fork changelog")

        result = self.run_triage()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("changelog-only footprint in this fork", result.stdout)


class AlreadyAppliedTests(TriageRepoFixture):
    def test_cherry_picked_commit_drops_off_via_patch_id(self):
        # Upstream adds a feature commit, then a second unrelated commit.
        self.write("kept.py", "print('feature')\n")
        upstream_sha = self.commit("upstream: add feature")
        self.write("shared.txt", "upstream edit\n")
        self.commit("upstream: unrelated change")
        self.set_upstream_to_head()

        # Fork diverges (its own commit first), then cherry-picks the feature.
        # The cherry-pick lands with a DIFFERENT sha but the same patch, so
        # only patch-id matching - not raw sha - can tell it is already ported.
        git(self.root, "reset", "--hard", "HEAD~2")
        self.write("fork_only.txt", "mine\n")
        self.commit("fork: divergent commit")
        git(self.root, "cherry-pick", upstream_sha)

        result = self.run_triage()
        self.assertEqual(result.returncode, 0, result.stderr)
        # The feature dropped off via patch-id; only the unrelated commit
        # remains worth reviewing.
        self.assertIn("already applied (cherry-picked)", result.stdout)
        self.assertIn("**1** worth reviewing", result.stdout)


class WontPortTests(TriageRepoFixture):
    def test_listed_sha_is_excluded(self):
        self.write("kept.py", "print('rejected feature')\n")
        rejected = self.commit("upstream: feature the fork rejects")
        self.set_upstream_to_head()
        git(self.root, "reset", "--hard", "HEAD~1")
        self.write(".github/upstream-wontport.txt",
                   f"{rejected[:9]}  # rejected on purpose\n")
        self.commit("fork: won't-port list")

        result = self.run_triage()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("on the fork's won't-port list", result.stdout)


class MissingUpstreamRefTests(TriageRepoFixture):
    def test_missing_ref_degrades_gracefully(self):
        # upstream/master ref never materialized.
        result = self.run_triage()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("was not available", result.stdout)


class WorkflowGuardTests(unittest.TestCase):
    """The workflow must no-op on the upstream template, so a template clone
    never opens an issue by surprise. GitHub Actions can't run offline, so we
    pin the guard by asserting the job's `if` condition excludes upstream."""

    def test_workflow_is_guarded_against_upstream(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn(f"github.repository != '{UPSTREAM_SLUG}'", text)

    def test_workflow_uses_builtin_token_only(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("GH_TOKEN: ${{ github.token }}", text)
        # A cross-repo PAT is what let an early run write outside its own repo;
        # the built-in token can't. Make sure no PAT secret sneaks back in.
        self.assertNotIn("secrets.", text)

    def test_actions_are_sha_pinned(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("- uses:") or stripped.startswith("uses:"):
                ref = stripped.split("uses:", 1)[1].strip()
                self.assertIn("@", ref)
                sha = ref.split("@", 1)[1].split()[0]
                self.assertRegex(sha, r"^[0-9a-f]{40}$",
                                 f"action not SHA-pinned: {ref}")


if __name__ == "__main__":
    unittest.main()


def locale_encoding() -> str:
    """locale.getencoding() is 3.11+; this repo's CI still runs 3.10."""
    getter = getattr(locale, "getencoding", None)
    if getter is not None:
        return getter()
    return locale.getpreferredencoding(False)


class EncodingGuardTests(unittest.TestCase):
    """Source-level guard, so a non-Windows CI still catches a regression.

    cp1252 leaves only five bytes undefined (0x81 0x8d 0x8f 0x90 0x9d), so the
    bug hides behind most accented text and surfaces on characters whose UTF-8
    encoding happens to contain one - a right double quotation mark, U+201D,
    encodes as e2 80 9d. Reading git without an explicit encoding therefore
    fails rarely and unpredictably, which is worse than failing always.
    """

    def test_every_git_subprocess_call_pins_an_encoding(self):
        for name in ("upstream_triage.py", "check_upstream_updates.py"):
            src = (REPO_ROOT / "tools" / name).read_text(encoding="utf-8")
            for call in re.finditer(r"subprocess\.run\((.*?)\)\s*(?:\.stdout)?",
                                    src, re.S):
                body = call.group(1)
                decodes = "text=True" in body or "universal_newlines=True" in body
                if not decodes:
                    continue  # binary mode; nothing is decoded, nothing can fail
                self.assertIn(
                    'encoding="utf-8"', body,
                    f"{name}: a text-mode subprocess.run does not pin an "
                    f"encoding, so it decodes with the locale codepage:\n{body}",
                )

    def test_triage_forces_utf8_on_its_own_output(self):
        src = (REPO_ROOT / "tools" / "upstream_triage.py").read_text(encoding="utf-8")
        self.assertIn('reconfigure(encoding="utf-8")', src,
                      "the report prints upstream commit subjects verbatim; a "
                      "piped stdout on Windows cannot encode them by default")


@unittest.skipIf(locale_encoding().lower().replace("-", "") == "utf8",
                 "locale already decodes UTF-8; the cp1252 failure cannot occur here")
class NonAsciiCommitTests(TriageRepoFixture):
    """Behavioural proof on a machine whose locale codepage is not UTF-8.

    Without the fix the decode raises inside subprocess's reader thread and the
    captured stdout comes back as None. Against a small repository that surfaces
    at once as an AttributeError; against a real upstream it was observed to
    hang instead, communicate() waiting on output that never arrives. Either way
    the report is empty, which a caller cannot tell apart from "no upstream
    commits need review".
    """

    # e2 80 9d: the 9d is one of the five bytes cp1252 cannot decode.
    SMART_QUOTE = "”"

    def run_triage_utf8(self, *args) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(self.root / "tools" / "upstream_triage.py"), *args],
            cwd=self.root, capture_output=True, text=True,
            encoding="utf-8", errors="replace", timeout=120,
        )

    def test_reports_a_commit_whose_subject_defeats_cp1252(self):
        self.write("kept.py", "print('changed')\n")
        self.commit(f"fix(jobnet): quote the {self.SMART_QUOTE}apply{self.SMART_QUOTE} link")
        self.set_upstream_to_head()
        git(self.root, "reset", "--hard", "HEAD~1")

        result = self.run_triage_utf8()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.strip(),
                        "triage printed nothing; a caller cannot tell that "
                        "apart from having nothing to review")
        self.assertNotIn("UnicodeDecodeError", result.stderr)

    def test_reports_a_commit_whose_diff_defeats_cp1252(self):
        # patch_id() runs `git show`, so the diff body gets decoded too.
        self.write("kept.py", f"TITLE = {self.SMART_QUOTE}Kobenhavn{self.SMART_QUOTE}\n")
        self.commit("upstream: touch kept.py")
        self.set_upstream_to_head()
        git(self.root, "reset", "--hard", "HEAD~1")

        result = self.run_triage_utf8()

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(result.stdout.strip(), "triage printed nothing")
        self.assertNotIn("UnicodeDecodeError", result.stderr)
