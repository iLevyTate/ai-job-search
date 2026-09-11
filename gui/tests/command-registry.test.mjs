import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createCommandRegistry } from "../command-registry.mjs";

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

test("discovers all 16 workflows without duplicates", async () => {
  const registry = await createCommandRegistry({ workspace: REPO });
  const ids = registry.list().map((item) => item.id);
  assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), []);
  for (const id of [
    "setup", "scrape", "rank", "apply", "autofill", "interview", "outcome",
    "import", "expand", "reset", "html-report", "gmail-sync", "notion-sync",
    "add-portal", "add-template", "upskill",
  ]) {
    assert.ok(registry.get(id), `missing ${id}`);
  }
});

test("orders the seven principal actions from metadata", async () => {
  const registry = await createCommandRegistry({ workspace: REPO });
  const primary = registry.list().filter((item) => item.primaryOrder).map((item) => item.id);
  assert.deepEqual(primary, ["setup", "scrape", "rank", "apply", "autofill", "interview", "outcome"]);
});

test("renders url, multiline, path, flags, and positional text exactly", async () => {
  const registry = await createCommandRegistry({ workspace: REPO });
  assert.equal(registry.render("autofill", { url: "https://jobs.example/1" }), "/autofill https://jobs.example/1");
  assert.equal(registry.render("apply", { posting: "Paste\nme" }), "/apply\nPaste\nme");
  assert.equal(registry.render("rank", { all: true, top: 5, focus: "healthcare" }), "/rank healthcare --all --top 5");
  assert.equal(registry.render("html-report", { path: "reports/out.html", open: true }), "/html-report reports/out.html --open");
  assert.equal(registry.render("scrape", { mode: "broad" }), "/scrape broad");
});

test("every argument a user can fill carries a label and a hint", async () => {
  const registry = await createCommandRegistry({ workspace: REPO });
  for (const command of registry.list()) {
    for (const argument of command.arguments) {
      assert.ok(argument.label, `${command.invocation} ${argument.name} has no label`);
      // A boolean checkbox explains itself through its label; everything else
      // needs a sentence saying what happens when it is left blank.
      if (argument.kind !== "boolean") {
        assert.ok(argument.hint, `${command.invocation} ${argument.name} has no hint`);
      }
    }
  }
});

test("choice values stay inside what the prompt body accepts", async () => {
  const registry = await createCommandRegistry({ workspace: REPO });
  assert.deepEqual(registry.get("scrape").arguments[0].values, ["broad", "health"]);
  assert.deepEqual(
    registry.get("setup").arguments[0].values,
    ["identity", "education", "experience", "skills", "publications", "behavioral", "goals", "references", "search"],
  );
  assert.equal(registry.render("setup", { section: "search" }), "/setup --section search");
  assert.equal(registry.render("setup", { section: "" }), "/setup");
});

test("form mode defaults to auto and is validated", async () => {
  const registry = await createCommandRegistry({ workspace: REPO });
  assert.equal(registry.get("setup").form, "always");
  assert.equal(registry.get("reset").form, "always");
  assert.equal(registry.get("apply").form, "auto");

  const root = mkdtempSync(join(tmpdir(), "desk-form-"));
  mkdirSync(join(root, ".claude", "commands"), { recursive: true });
  writeFileSync(join(root, ".claude", "commands", "bad.md"), "---\ndesk:\n  id: bad\n  invocation: /bad\n  form: sometimes\n---\n");
  const fixture = await createCommandRegistry({ workspace: root });
  assert.equal(fixture.get("bad"), undefined);
});

test("excludes skills without desk metadata", async () => {
  const registry = await createCommandRegistry({ workspace: REPO });
  assert.equal(registry.get("job-application-assistant"), undefined);
});

test("skips malformed metadata and still picks up a new fixture command", async () => {
  const root = mkdtempSync(join(tmpdir(), "desk-commands-"));
  mkdirSync(join(root, ".claude", "commands"), { recursive: true });
  mkdirSync(join(root, ".claude", "skills"), { recursive: true });
  // A malformed file must not abort the whole registry.
  writeFileSync(join(root, ".claude", "commands", "broken.md"), "---\ndesk:\n  id: broken\n  invocation: /broken\n  arguments:\n    - kind: nope\n      name: x\n---\n");
  writeFileSync(join(root, ".claude", "commands", "extra.md"), "---\ndesk:\n  id: extra\n  invocation: /extra\n  title: Extra\n---\n# extra\n");
  const registry = await createCommandRegistry({ workspace: root });
  assert.equal(registry.get("broken"), undefined);
  assert.ok(registry.get("extra"));
  assert.equal(registry.render("extra", {}), "/extra");
});
