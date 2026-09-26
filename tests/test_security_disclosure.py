"""Guard: SECURITY.md may only claim "no submit endpoint" while the code has none.

The review gate's ReviewDecision type is the single source of truth for whether
Autofill can press an employer's Submit button. On master it is
"continue" | "cancel". The autofill-submit branch widens it to include "submit".
SECURITY.md carries the sentence "There is no submit endpoint in any released
build", which is true exactly as long as that widening has not landed on the
branch that ships. This test fails the moment the two disagree, so the
disclosure cannot go stale the day the branch merges.
"""
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
GATE = REPO_ROOT / ".agents" / "skills" / "ats-autofill" / "cli" / "src" / "review-gate.ts"
SECURITY = REPO_ROOT / "SECURITY.md"
NO_SUBMIT_CLAIM = "There is no submit endpoint in any released build."


def review_decisions(source: str) -> set:
    """The string literals in `export type ReviewDecision = "a" | "b" ...`."""
    for line in source.splitlines():
        if line.startswith("export type ReviewDecision"):
            _, _, union = line.partition("=")
            return {part.strip().strip('"') for part in union.split("|") if part.strip()}
    return set()


class SecurityDisclosureMatchesGate(unittest.TestCase):
    def test_gate_type_is_still_parseable(self):
        decisions = review_decisions(GATE.read_text(encoding="utf-8"))
        self.assertTrue(
            {"continue", "cancel"} <= decisions,
            "could not read ReviewDecision from review-gate.ts; if the type moved, "
            "update this guard rather than letting it pass vacuously",
        )

    def test_no_submit_claim_is_true_for_this_tree(self):
        decisions = review_decisions(GATE.read_text(encoding="utf-8"))
        security = SECURITY.read_text(encoding="utf-8")
        if "submit" in decisions:
            self.assertNotIn(
                NO_SUBMIT_CLAIM,
                security,
                "review-gate.ts can return submit, so SECURITY.md may no longer say "
                f"{NO_SUBMIT_CLAIM!r}; rewrite the disclosure before this lands",
            )
        else:
            self.assertIn(
                NO_SUBMIT_CLAIM,
                security,
                "the gate has no submit decision, so SECURITY.md should still make the claim",
            )


if __name__ == "__main__":
    unittest.main()
