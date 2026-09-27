import { existsSync, realpathSync } from "fs"
import { extname, isAbsolute, relative, resolve, sep } from "path"

/**
 * Profile document paths are relative to the repo root. A path passed with
 * --resume or --cover was typed in the shell, so it stays relative to the
 * current directory. An absolute path is returned unchanged.
 */
export function resolveDocumentPath(
  profilePath: string | null | undefined,
  flagPath: string | undefined,
  root: string,
): string | undefined {
  if (flagPath !== undefined) return resolve(flagPath)
  if (!profilePath) return undefined
  return resolve(root, profilePath)
}

/** File types the tool may attach to a form. Anything else is refused. */
export const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".pdf",
  ".docx",
  ".doc",
  ".txt",
  ".md",
  ".rtf",
  ".odt",
])

/** The profile is JSON and nothing else. */
export const PROFILE_EXTENSIONS: ReadonlySet<string> = new Set([".json"])

export type DocumentPathCode = "BAD_DOCUMENT" | "MISSING_DOCUMENT" | "OUTSIDE_WORKSPACE"

export class DocumentPathError extends Error {
  // An explicit field, not a parameter property: Node's strip-only type
  // stripping rejects the latter (see review-gate.ts).
  readonly code: DocumentPathCode

  constructor(message: string, code: DocumentPathCode) {
    super(message)
    this.name = "DocumentPathError"
    this.code = code
  }
}

export interface ConfineOptions {
  /** What the path is, for the message: "resume", "cover letter", "profile". */
  label: string
  /** Allowed extensions; DOCUMENT_EXTENSIONS unless the caller says otherwise. */
  extensions?: ReadonlySet<string>
}

/**
 * A document may come from the job-search folder (the repo root) and nowhere
 * else. The path is resolved through realpath, so a symlink dropped inside
 * the folder cannot reach out of it either, and it must carry a document
 * extension. This is what keeps a prompt-injected turn from attaching
 * ~/.ssh/id_rsa, the tracker, or a .env file to an employer's form, since
 * the browser's file input takes whatever path it is given.
 *
 * Returns the real path to attach.
 */
export function confineDocumentPath(
  path: string,
  root: string,
  { label, extensions = DOCUMENT_EXTENSIONS }: ConfineOptions,
): string {
  const ext = extname(path).toLowerCase()
  if (!extensions.has(ext)) {
    throw new DocumentPathError(
      `The ${label} must be one of ${[...extensions].join(", ")}; "${path}" is not.`,
      "BAD_DOCUMENT",
    )
  }
  if (!existsSync(path)) {
    throw new DocumentPathError(`${label} not found at ${path}`, "MISSING_DOCUMENT")
  }
  const real = realpathSync(path)
  const realRoot = realpathSync(root)
  const rel = relative(realRoot, real)
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new DocumentPathError(
      `The ${label} must be inside the job-search folder (${root}); "${path}" resolves to ${real}, outside it. ` +
        "Copy the file into documents/ or cv/ first.",
      "OUTSIDE_WORKSPACE",
    )
  }
  return real
}
