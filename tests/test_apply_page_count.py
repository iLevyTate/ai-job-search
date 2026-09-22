"""Guard for /apply Step 5b's page-count check.

The 2-page CV and 1-page cover letter limits are the hard rules of
05-cv-templates.md and 06-cover-letter-templates.md. Step 5d's only
verify_pdf.py invocation is --dump-text, so the page budget has to be a
runnable command in Step 5b.
"""
import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
APPLY = REPO / ".claude" / "commands" / "apply.md"


def section(path, heading):
    """The body of one markdown section, up to the next heading of any depth."""
    text = path.read_text(encoding="utf-8")
    start = text.index(heading) + len(heading)
    rest = text[start:]
    end = re.search(r"^#{1,4} ", rest, re.MULTILINE)
    return rest[: end.start()] if end else rest


def page_count_invocations(text):
    """(document path, page count) for every runnable verify_pdf --pages line."""
    return re.findall(
        r"^python tools/verify_pdf\.py (\S+) --pages (\d+)\s*$", text, re.MULTILINE
    )


class ApplyRunsThePageCountCheck(unittest.TestCase):
    def setUp(self):
        self.step_5b = section(APPLY, "### 5b. Inspect layout")

    def test_step_5b_checks_both_documents_with_the_guides_page_limits(self):
        invocations = dict(page_count_invocations(self.step_5b))
        self.assertEqual(
            invocations.get("cv/main_<company>_<role>.pdf"),
            "2",
            "Step 5b must run verify_pdf.py --pages 2 on the CV",
        )
        self.assertEqual(
            invocations.get("cover_letters/cover_<company>_<role>.pdf"),
            "1",
            "Step 5b must run verify_pdf.py --pages 1 on the cover letter",
        )

    def test_step_5d_extracts_text_and_does_not_check_page_count(self):
        step_5d = section(APPLY, "### 5d. ATS & keyword verification (CV)")
        self.assertIn("--dump-text", step_5d)
        self.assertEqual(page_count_invocations(step_5d), [])


if __name__ == "__main__":
    unittest.main()
