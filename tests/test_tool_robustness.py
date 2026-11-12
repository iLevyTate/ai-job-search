"""Guards for Python-tool robustness fixes.

Each bug produced a clean-looking run (mostly on Windows) while doing the
wrong thing, so a unit test is the only place they surface:

- Every git/pdftotext subprocess helper decoded with the locale codec
  (cp1252) under text=True. Output containing a byte like 0x8f killed the
  reader thread; upstream_triage's cherry-pick dedup then dropped that
  commit's patch-id and exited 0. The helpers must pass encoding="utf-8".
- convert_salary_excel dropped unambiguous thousands-grouped numbers
  (1,234,567 -> ValueError -> silently skipped).
- salary_lookup crashed on null metadata/categories its own validator blesses.
"""
import ast
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TOOLS = REPO / "tools"
SUBPROCESS_TOOLS = [
    TOOLS / "upstream_triage.py",
    TOOLS / "check_upstream_updates.py",
    TOOLS / "check_framework_version.py",
    TOOLS / "verify_pdf.py",
]


def subprocess_run_calls(path):
    """Yield ast.Call nodes for subprocess.run in a source file."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "run"
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "subprocess"
        ):
            yield node


class SubprocessDecodingIsUtf8(unittest.TestCase):
    """A subprocess.run that captures decoded text must pin encoding, not
    rely on text=True (which uses cp1252 on Windows and crashes on some
    UTF-8 output)."""

    def test_text_capturing_runs_pin_utf8(self):
        offenders = []
        for path in SUBPROCESS_TOOLS:
            for call in subprocess_run_calls(path):
                kwargs = {kw.arg: kw.value for kw in call.keywords}
                # A call that captures output for decoding sets capture_output
                # or stdout=PIPE. Those must decode as utf-8, not via text=True.
                captures = "capture_output" in kwargs or "stdout" in kwargs
                has_text = "text" in kwargs
                has_encoding = "encoding" in kwargs
                if captures and (has_text or has_encoding):
                    if not has_encoding:
                        offenders.append(f"{path.name}:{call.lineno} uses text= without encoding=")
        self.assertEqual(
            offenders, [],
            "subprocess.run decoding with the locale codec crashes on non-ASCII "
            "git/pdftotext output on Windows:\n" + "\n".join(offenders),
        )


class UpstreamTriagePinsCwd(unittest.TestCase):
    def test_git_helper_passes_cwd(self):
        src = (TOOLS / "upstream_triage.py").read_text(encoding="utf-8")
        self.assertIn(
            "cwd=str(ROOT)", src,
            "upstream_triage.git() must pin cwd, or run from a subdir it loads "
            "an empty won't-port list and resurrects suppressed commits",
        )


class ExcelParsesGroupedThousands(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(TOOLS))
        from convert_salary_excel import parse_numeric_cell  # noqa: E402
        cls.parse = staticmethod(parse_numeric_cell)

    def test_multi_group_thousands_parse(self):
        self.assertEqual(self.parse("1,234,567"), 1234567.0)
        self.assertEqual(self.parse("1.234.567"), 1234567.0)

    def test_plain_decimal_still_parses(self):
        self.assertEqual(self.parse("12.5"), 12.5)
        self.assertEqual(self.parse("1234.56"), 1234.56)

    def test_single_group_stays_ambiguous(self):
        # A lone `1,234` could be 1234 or 1.234; the tool must still refuse it
        # rather than guess, exactly as before the multi-group fix.
        with self.assertRaises(ValueError):
            self.parse("1,234")
        with self.assertRaises(ValueError):
            self.parse("1.234")


class SalaryLookupToleratesNulls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sys.path.insert(0, str(REPO))
        import salary_lookup  # noqa: E402
        cls.mod = salary_lookup

    def test_format_entry_survives_null_categories(self):
        entry = {"company": "Acme", "categories": None, "eng": {"count": 5, "index": 110}}
        # Must not raise: categories=None coerced to {} before item assignment.
        self.assertIn("Acme", self.mod.format_entry(entry, {}))


if __name__ == "__main__":
    unittest.main()
