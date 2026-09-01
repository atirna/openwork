import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The xlsx dependency is fetched from cdn.sheetjs.com rather than the npm
 * registry, and some pnpm versions drop its `integrity` field when rewriting
 * the lockfile. Without that hash the tarball is trusted on faith. This canary
 * pins the integrity line so any lockfile rewrite that loses it fails fast.
 */
describe("root pnpm lockfile supply chain", () => {
  test("the xlsx CDN tarball keeps its integrity hash", async () => {
    const lockfile = await readFile(join(import.meta.dir, "..", "..", "..", "pnpm-lock.yaml"), "utf8");

    const resolutionLines = lockfile
      .split("\n")
      .filter((line) => {
        if (!line.includes("resolution:")) return false;
        const tarballMatch = line.match(/tarball:\s*([^,\s}]+)/);
        if (!tarballMatch) return false;
        try {
          return new URL(tarballMatch[1]).hostname === "cdn.sheetjs.com";
        } catch {
          return false;
        }
      });

    expect(resolutionLines.length).toBeGreaterThan(0);
    for (const line of resolutionLines) {
      expect(line).toContain("integrity: sha512-");
    }
  });
});
