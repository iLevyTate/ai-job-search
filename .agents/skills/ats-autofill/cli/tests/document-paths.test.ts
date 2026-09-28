import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { basename, join, resolve } from "path"
import { confineDocumentPath, PROFILE_EXTENSIONS, resolveDocumentPath, type DocumentPathError } from "../src/documents.ts"

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

describe("document confinement", () => {
  function repo(): string {
    return mkdtempSync(join(tmpdir(), "autofill-confine-"))
  }

  test("a document inside the repo comes back as its real path", () => {
    const root = repo()
    mkdirSync(join(root, "cv"))
    writeFileSync(join(root, "cv", "main_acme.pdf"), "pdf")
    expect(confineDocumentPath(join(root, "cv", "main_acme.pdf"), root, { label: "resume" })).toBe(
      realpathSync(join(root, "cv", "main_acme.pdf")),
    )
  })

  test("a document outside the repo is refused, even through .. or a symlink", () => {
    const root = repo()
    const outside = mkdtempSync(join(tmpdir(), "autofill-outside-"))
    writeFileSync(join(outside, "id_rsa.txt"), "secret")
    const dotdot = join(root, "cv", "..", "..", basename(outside), "id_rsa.txt")
    expect(() => confineDocumentPath(join(outside, "id_rsa.txt"), root, { label: "resume" })).toThrow(/outside it/)
    expect(() => confineDocumentPath(dotdot, root, { label: "resume" })).toThrow(/outside it/)
    symlinkSync(join(outside, "id_rsa.txt"), join(root, "cv.txt"))
    let code = ""
    try {
      confineDocumentPath(join(root, "cv.txt"), root, { label: "resume" })
    } catch (e) {
      code = (e as DocumentPathError).code
    }
    expect(code).toBe("OUTSIDE_WORKSPACE")
  })

  test("only document types are attachable; the profile takes only .json", () => {
    const root = repo()
    for (const name of [".env", "tracker.csv", "run.sh", "keys.json", "profile"]) {
      writeFileSync(join(root, name), "x")
      let code = ""
      try {
        confineDocumentPath(join(root, name), root, { label: "resume" })
      } catch (e) {
        code = (e as DocumentPathError).code
      }
      expect(code).toBe("BAD_DOCUMENT")
    }
    writeFileSync(join(root, "application_profile.json"), "{}")
    expect(confineDocumentPath(join(root, "application_profile.json"), root, { label: "profile", extensions: PROFILE_EXTENSIONS })).toBe(
      realpathSync(join(root, "application_profile.json")),
    )
    expect(() => confineDocumentPath(join(root, "application_profile.json"), root, { label: "resume" })).toThrow(/must be one of/)
  })

  test("a missing document keeps the MISSING_DOCUMENT code", () => {
    const root = repo()
    let code = ""
    try {
      confineDocumentPath(join(root, "cv", "gone.pdf"), root, { label: "resume" })
    } catch (e) {
      code = (e as DocumentPathError).code
    }
    expect(code).toBe("MISSING_DOCUMENT")
  })
})
