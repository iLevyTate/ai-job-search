import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { resolveDocumentPath } from "../src/documents.ts"

describe("profile document paths", () => {
  const original = process.cwd()
  afterEach(() => process.chdir(original))

  test("a relative resume in the profile resolves from the repo root when the shell is somewhere else", () => {
    const root = mkdtempSync(join(tmpdir(), "autofill-repo-"))
    const elsewhere = mkdtempSync(join(tmpdir(), "autofill-cwd-"))
    writeFileSync(join(root, "cv.pdf"), "pdf")
    process.chdir(elsewhere)

    expect(resolveDocumentPath("cv.pdf", undefined, root)).toBe(resolve(root, "cv.pdf"))
  })

  test("a --resume flag stays relative to the current directory", () => {
    const root = mkdtempSync(join(tmpdir(), "autofill-repo-"))
    const elsewhere = mkdtempSync(join(tmpdir(), "autofill-cwd-"))
    writeFileSync(join(elsewhere, "flag.pdf"), "pdf")
    process.chdir(elsewhere)

    expect(resolveDocumentPath("cv.pdf", "flag.pdf", root)).toBe(resolve(elsewhere, "flag.pdf"))
  })
})
