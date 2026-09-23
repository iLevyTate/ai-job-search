import { resolve } from "path"

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
