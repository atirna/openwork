import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

const transferUnitTest = fileURLToPath(
  new URL("../../apps/desktop/electron/binary-transfer.test.mjs", import.meta.url),
);

test("Electron remote binary transfers preserve bytes, workspace boundaries, and cancellation cleanup", async ({ evidence }) => {
  const unit = spawnSync(process.execPath, [
    "--test",
    "--test-reporter=tap",
    transferUnitTest,
  ], { encoding: "utf8" });
  expect(unit.status, unit.stderr || unit.stdout).toBe(0);
  expect(unit.stdout).toContain("uploads exact original multipart bytes with spaces and Unicode in the filename");
  expect(unit.stdout).toContain("downloads high bytes exactly through a verified destination handle with no stray files");
  expect(unit.stdout).toContain("rejects zero-byte, oversized, and size-mismatched uploads with clear error codes");
  expect(unit.stdout).toContain("rejects zero-byte and oversized downloads without leaving partial files");
  expect(unit.stdout).toContain("cancellation removes the incomplete download");
  expect(unit.stdout).toContain("rejects traversal, nested, and symlink download destinations");
  expect(unit.stdout).toContain("rejects transfer URLs outside connected remote workspace endpoints");
  expect(unit.stdout).toContain("rejects a download whose workspace root is swapped for a symlink during the fetch");
  expect(unit.stdout).not.toContain("not ok");
  expect(unit.stdout).toMatch(/# tests 8\b/);
  expect(unit.stdout).toMatch(/# pass 8\b/);
  expect(unit.stdout).toMatch(/# fail 0\b/);
  expect(unit.stdout).toMatch(/# skipped 0\b/);

  evidence.recordAssertionEvidence(
    "Main-process binary transfers are byte-exact, bounded, workspace-confined, and endpoint-bound",
    "Multipart uploads reproduced renderer-supplied original bytes exactly with Unicode filenames and enforced size integrity, downloads staged outside the workspace and flowed through inode-verified destination handles with no partial files after oversize or cancellation, traversal, nested, and symlink destinations were rejected, transfer URLs were confined to registered remote workspace endpoints with redirects refused, and a workspace root swapped for a symlink during the fetch was rejected without writing outside the workspace.",
    true,
  );
});
