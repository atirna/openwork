import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function runDenWebBunTest(file: string, expectedPasses: number) {
  const unit = spawnSync("pnpm", [
    "--dir",
    "ee/apps/den-web",
    "exec",
    "bun",
    "--conditions=development",
    "test",
    file,
  ], { cwd: repoRoot, encoding: "utf8" });
  const output = `${unit.stdout}${unit.stderr}`;
  expect(unit.error, output).toBeUndefined();
  expect(unit.status, output).toBe(0);
  expect(output).toContain(` ${expectedPasses} pass`);
  expect(output).toContain(" 0 fail");
  return output;
}

test("client cancellation and deadlines stop upstream Den proxy work with stable sanitized errors", async ({ evidence }) => {
  runDenWebBunTest("app/api/_lib/upstream-proxy-lifecycle.test.mjs", 5);

  evidence.recordAssertionEvidence(
    "Abandoned and timed-out proxy requests stop upstream work with sanitized responses",
    "Client aborts propagated to the upstream fetch signal, deadline expiry returned a stable 504 upstream_timeout and connection failures a 502 upstream_unreachable without leaking internal origins or socket details, successful bodies streamed without buffering, and abort listeners plus timers were released after completion.",
    true,
  );

  runDenWebBunTest("app/api/_lib/upstream-proxy.test.mjs", 19);

  evidence.recordAssertionEvidence(
    "Existing proxy behavior is unchanged",
    "The full pre-existing upstream proxy suite passed against a real loopback upstream, including CORS reflection, cookie scoping, header sanitization, compressed bodies, and forwarded-header handling.",
    true,
  );
});
