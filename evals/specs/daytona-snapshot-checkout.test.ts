import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { expect } from "vitest"
import { test } from "@openwork/testkit"

const repoRoot = resolve(import.meta.dirname, "../..")

test("Daytona snapshot checkout discards tracked changes but preserves untracked caches", ({ evidence }) => {
  const script = readFileSync(resolve(repoRoot, ".devcontainer/test-server-on-daytona.sh"), "utf8")
  const reset = "git reset --hard HEAD"
  const checkout = "git checkout --detach FETCH_HEAD"

  expect(script).toContain(reset)
  expect(script.indexOf(reset)).toBeLessThan(script.indexOf(checkout))

  const workspace = mkdtempSync(join(tmpdir(), "openwork-daytona-snapshot-"))
  const generatedFile = join(workspace, "next-env.d.ts")
  const cacheFile = join(workspace, "node_modules", ".cache", "marker")

  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: workspace, encoding: "utf8" }).trim()
    git("init", "--quiet")
    git("config", "user.name", "OpenWork Test")
    git("config", "user.email", "test@openwork.local")
    writeFileSync(generatedFile, "snapshot\n")
    git("add", "next-env.d.ts")
    git("commit", "--quiet", "-m", "snapshot")
    writeFileSync(generatedFile, "requested ref\n")
    git("commit", "--quiet", "-am", "requested ref")
    const requestedRef = git("rev-parse", "HEAD")
    git("checkout", "--quiet", "--detach", "HEAD~1")

    writeFileSync(generatedFile, "generated dirty change\n")
    mkdirSync(resolve(cacheFile, ".."), { recursive: true })
    writeFileSync(cacheFile, "keep\n")

    git("reset", "--hard", "HEAD")
    git("checkout", "--quiet", "--detach", requestedRef)

    expect(readFileSync(generatedFile, "utf8")).toBe("requested ref\n")
    expect(readFileSync(cacheFile, "utf8")).toBe("keep\n")
    expect(git("status", "--short")).toBe("?? node_modules/")
    evidence.recordAssertionEvidence(
      "Dirty Daytona snapshots can check out the requested ref without deleting dependency caches",
      "The checkout resets tracked generated changes first, reaches the requested commit, and leaves an untracked node_modules cache intact.",
      true,
    )
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})
