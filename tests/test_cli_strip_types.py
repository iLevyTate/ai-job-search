"""Portal CLIs must stay startable under Node's strip-only type stripping.

Bun and tsc both accept TypeScript that Node rejects (parameter properties,
enums, namespaces, decorators). erasableSyntaxOnly is what makes typecheck
fail on that syntax, and it requires TypeScript 5.8. CI also has to execute
the documented entry point; a green typecheck alone missed a CLI that could
not start.
"""

import json
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
CLI_ROOT = REPO_ROOT / ".agents" / "skills"


class CliStripTypesTests(unittest.TestCase):
    def test_every_cli_opts_into_erasable_syntax_and_typescript_5_8(self):
        configs = sorted(CLI_ROOT.glob("*/cli/tsconfig.json"))
        self.assertGreaterEqual(len(configs), 7)
        for tsconfig in configs:
            text = tsconfig.read_text(encoding="utf-8")
            self.assertIn(
                '"erasableSyntaxOnly": true',
                text,
                f"{tsconfig} must reject syntax Node cannot strip",
            )
            package = json.loads((tsconfig.parent / "package.json").read_text(encoding="utf-8"))
            spec = package["devDependencies"]["typescript"]
            self.assertTrue(
                spec.startswith("^5.8") or spec.startswith("~5.8") or spec.startswith(">=5.8"),
                f"{tsconfig.parent / 'package.json'} typescript is {spec}, need 5.8 or newer",
            )

    def test_ci_starts_clis_under_node_22_and_24(self):
        ci = (REPO_ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
        self.assertIn('node-version: ["22", "24"]', ci)
        self.assertIn("node --experimental-strip-types src/cli.ts --help", ci)
        self.assertIn('"@bunli/core"', ci)

    def test_add_portal_tells_new_skills_to_inherit_the_flag(self):
        command = (REPO_ROOT / ".claude" / "commands" / "add-portal.md").read_text(encoding="utf-8")
        self.assertIn("erasableSyntaxOnly", command)
        self.assertIn("^5.8.0", command)


if __name__ == "__main__":
    unittest.main()
