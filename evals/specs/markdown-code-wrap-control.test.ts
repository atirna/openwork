import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const markdownPrimitiveSource = readFileSync(
  fileURLToPath(new URL("../../apps/app/src/components/markdown/markdown-primitive.ts", import.meta.url)),
  "utf8",
);

test("rendered code blocks expose an accessible word-wrap control that defaults to unwrapped", async ({ evidence }) => {
  expect(markdownPrimitiveSource).toContain('data-openwork-code-wrap=""');
  expect(markdownPrimitiveSource).toContain('aria-pressed="false"');
  expect(markdownPrimitiveSource).toContain('aria-label="Enable word wrap"');
  expect(markdownPrimitiveSource).toContain('data-openwork-code-scroll=""');
  expect(markdownPrimitiveSource).toContain("export function codeWrapClassStates");
  expect(markdownPrimitiveSource).toContain("export function setCodeWrapButtonState");
  // The sanitizer must keep the wrap control interactive after re-rendering.
  expect(markdownPrimitiveSource).toContain('"data-openwork-code-wrap",');
  expect(markdownPrimitiveSource).toContain('"aria-pressed",');
  // The unwrapped default keeps horizontal scrolling; wrapping is opt-in.
  expect(markdownPrimitiveSource).toMatch(/"overflow-x-auto": !wrapped/);
  expect(markdownPrimitiveSource).toMatch(/"whitespace-pre-wrap": wrapped/);

  evidence.recordAssertionEvidence(
    "Code blocks render an explicit wrap toggle without changing the default presentation",
    "The chat code block container renders an aria-pressed word-wrap button beside the copy control, the sanitizer allowlists its attributes, and the wrap state maps to pure class toggles that keep overflow scrolling as the default.",
    true,
  );

  const unit = spawnSync("pnpm", [
    "--dir",
    "apps/app",
    "exec",
    "bun",
    "test",
    "tests/markdown-code-block.test.ts",
  ], { cwd: repoRoot, encoding: "utf8" });
  const output = `${unit.stdout}${unit.stderr}`;
  expect(unit.error, output).toBeUndefined();
  expect(unit.status, output).toBe(0);
  expect(output).toContain(" 10 pass");
  expect(output).toContain(" 0 fail");

  evidence.recordAssertionEvidence(
    "The markdown code block unit suite passes with the wrap affordance",
    "All 10 unit tests passed, covering the fallback and Shiki containers, the wrap class-state mapping, unchanged copy behavior, and unchanged rendered code text.",
    true,
  );
});
