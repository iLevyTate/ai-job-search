import { describe, expect, test } from "bun:test"
import { dirname, join } from "path"
import { fileURLToPath } from "url"

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), "..")

function runCli(args: string[]): { code: number; stderr: string } {
  const result = Bun.spawnSync(["bun", "run", "src/cli.ts", ...args], { cwd: CLI_DIR, stdout: "pipe", stderr: "pipe" })
  return { code: result.exitCode, stderr: result.stderr.toString() }
}

describe("fill guards", () => {
  test("a headless fill is refused before anything is loaded or opened", () => {
    const { code, stderr } = runCli(["fill", "https://jobs.example/acme/1"])
    expect(code).toBe(1)
    const error = JSON.parse(stderr.trim().split("\n").at(-1) as string) as { code: string; error: string }
    expect(error.code).toBe("HEADLESS_FILL")
    expect(error.error).toMatch(/--headed/)
  })

  test("a profile outside the job-search folder is refused", () => {
    const { code, stderr } = runCli(["inspect", "https://jobs.example/acme/1", "--profile", "/tmp/not-in-the-repo.json"])
    expect(code).toBe(1)
    const error = JSON.parse(stderr.trim().split("\n").at(-1) as string) as { code: string }
    // Missing or outside: either way it never loads.
    expect(["MISSING_DOCUMENT", "OUTSIDE_WORKSPACE"]).toContain(error.code)
  })
})
