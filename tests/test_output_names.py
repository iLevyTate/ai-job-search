"""Custom output file names for tailored documents.

`/add-template` can declare a file name for the CV or cover letter it
activates (`Jane_Doe_<Company>_Resume` instead of `main_<company>_<role>`).
The name lives only in the ACTIVE-TEMPLATE block, and every command that
writes or finds those files has to honour it, or `/apply` writes one name
while `/autofill`, `/interview` and `/outcome` look for another and find
nothing.

These tests pin the contract the specs state, plus two behaviours that are
easy to get wrong: the case-kept tokens derive by the same rule as the
lowercase ones, and the documented ignore rule for a custom name also
covers the role-qualified name `/apply` falls back to on a collision.
"""
import fnmatch
import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
COMMANDS = REPO / ".claude" / "commands"
APPLY = COMMANDS / "apply.md"
ADD_TEMPLATE = COMMANDS / "add-template.md"
AUTOFILL = COMMANDS / "autofill.md"
IMPORT = COMMANDS / "import.md"
INTERVIEW = COMMANDS / "interview.md"
OUTCOME = COMMANDS / "outcome.md"
SKILL = REPO / ".claude" / "skills" / "job-application-assistant" / "SKILL.md"
DOCS_README = REPO / "documents" / "README.md"


def read(path):
    return path.read_text(encoding="utf-8")


def derive(text, keep_case=False):
    """The Subfolder naming rule from documents/README.md, for one value."""
    name = (text if keep_case else text.lower()).replace(" ", "_")
    name = re.sub(r"[^\w]", "", name)
    return re.sub(r"_+", "_", name).strip("_")


class ApplyResolvesOutputNames(unittest.TestCase):
    def test_apply_reads_the_names_from_the_active_template(self):
        text = read(APPLY)
        self.assertIn("**Resolve the output names the same way:**", text)
        for token in ("<CV_NAME>", "<COVER_NAME>"):
            self.assertIn(token, text)
        self.assertIn("the tracker's `cv_file`/`cover_letter_file`", text,
                      "the tracker must record the name actually written, or every "
                      "later reader follows a dead path")

    def test_apply_never_overwrites_another_application(self):
        text = read(APPLY)
        self.assertIn("insert `_<role>` (or `_<Role>`, matching the name's case) right after "
                      "the company token", text)
        self.assertIn("Never overwrite another application's documents.", text)


class AddTemplateCapturesTheName(unittest.TestCase):
    def test_step_2_defines_the_tokens_and_the_default(self):
        text = read(ADD_TEMPLATE)
        self.assertIn("**Output file name** (optional)", text)
        for token in ("<company>", "<role>", "<Company>", "<Role>"):
            self.assertIn(f"`{token}`", text)
        self.assertIn("Default: `main_<company>_<role>` for a CV, `cover_<company>_<role>` "
                      "for a cover letter", text)
        self.assertIn("require a company token", text)

    def test_the_name_stays_out_of_the_shareable_manifest(self):
        self.assertIn("never in `TEMPLATE.md`", read(ADD_TEMPLATE),
                      "templates are stored profile-agnostic; a name like "
                      "Jane_Doe_<Company>_Resume would leak the user's name into them")

    def test_activation_adds_an_ignore_rule_for_a_custom_name(self):
        text = read(ADD_TEMPLATE)
        self.assertIn("add a matching rule to `.gitignore`", text)
        self.assertIn("`cv/Jane_Doe_*_Resume.*`", text)

    def test_the_block_writes_the_declared_name(self):
        self.assertIn("> - **Output file:** `cv/<name><source-extension>` for a CV template",
                      read(ADD_TEMPLATE))


class EveryReaderHonoursACustomName(unittest.TestCase):
    READERS = [AUTOFILL, IMPORT, INTERVIEW, OUTCOME, SKILL]

    def test_each_reader_names_the_override(self):
        for path in self.READERS:
            with self.subTest(file=path.name):
                text = read(path)
                self.assertIn("ACTIVE-TEMPLATE", text)
                self.assertIn("**Output file** name", text)

    def test_fallback_readers_refuse_to_guess_for_a_roleless_name(self):
        for path in (INTERVIEW, OUTCOME):
            with self.subTest(file=path.name):
                self.assertIn("A custom name without a role token matches the company "
                              "alone by construction", read(path))

    def test_autofill_looks_for_the_name_apply_writes(self):
        text = read(AUTOFILL)
        self.assertNotIn("`cv/main_<company>.pdf`", text,
                         "/apply never writes a role-less CV name, so this path "
                         "never exists and autofill falls back to the generic resume")
        self.assertIn("`cv/main_<company>_<role>.pdf`", text)
        self.assertIn("Prefer the tracker row's `cv_file`/`cover_letter_file` columns", text)


class TokenDerivation(unittest.TestCase):
    def test_readme_defines_the_case_kept_tokens(self):
        text = read(DOCS_README)
        self.assertIn("`<Company>` and `<Role>` follow the same rule but keep each letter's case",
                      text)
        self.assertIn("`Acme AI` becomes\n`Acme_AI`", text)

    def test_case_kept_and_lowercase_forms_differ_only_in_case(self):
        for company in ("Acme AI", "eXample Health", "Novo Nordisk A/S", "Initech & Co"):
            with self.subTest(company=company):
                kept = derive(company, keep_case=True)
                self.assertEqual(kept.lower(), derive(company))
                self.assertNotIn("/", kept)
        self.assertEqual(derive("Acme AI", keep_case=True), "Acme_AI")


class IgnoreRuleCoversCollisionNames(unittest.TestCase):
    """The documented rule replaces each token with `*`."""

    def ignore_rule(self, folder, name):
        return f"{folder}/" + re.sub(r"<[A-Za-z]+>", "*", name) + ".*"

    def test_rule_matches_plain_and_role_qualified_names(self):
        name = "Jane_Doe_<Company>_Resume"
        rule = self.ignore_rule("cv", name)
        self.assertEqual(rule, "cv/Jane_Doe_*_Resume.*")
        company = derive("Acme Corp", keep_case=True)
        role = derive("ML Engineer", keep_case=True)
        written = [
            f"cv/Jane_Doe_{company}_Resume.tex",
            f"cv/Jane_Doe_{company}_Resume.pdf",
            # /apply's collision fallback inserts the role after the company.
            f"cv/Jane_Doe_{company}_{role}_Resume.tex",
        ]
        for path in written:
            with self.subTest(path=path):
                self.assertTrue(fnmatch.fnmatch(path, rule))
        self.assertFalse(fnmatch.fnmatch("cv/main_example.tex", rule))


if __name__ == "__main__":
    unittest.main()
