import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

const sessionPageSource = readFileSync(
  fileURLToPath(new URL("../../apps/app/src/react-app/domains/session/chat/session-page.tsx", import.meta.url)),
  "utf8",
);
const buttonSource = readFileSync(
  fileURLToPath(new URL("../../apps/app/src/components/ui/button.tsx", import.meta.url)),
  "utf8",
);

function spacingValue(source: string, pattern: RegExp) {
  const value = source.match(pattern)?.[1];
  if (value === undefined) {
    throw new Error(`Missing geometry class matching ${pattern}`);
  }
  return Number(value) * 4;
}

test("the artifact count badge stays inside the desktop rail", async ({ evidence }) => {
  const rail = sessionPageSource.match(/<aside className="([^"]+)">/)?.[1] ?? "";
  const badge = sessionPageSource.match(/<span className="([^"]*translate-x-1[^"]*)">/)?.[1] ?? "";
  const buttonSize = spacingValue(buttonSource, /"icon-sm": "size-([\d.]+)"/);
  const railWidth = spacingValue(rail, /(?:^|\s)w-([\d.]+)(?:\s|$)/);
  const railPadding = spacingValue(rail, /(?:^|\s)px-([\d.]+)(?:\s|$)/);
  const railTopPadding = spacingValue(rail, /(?:^|\s)py-([\d.]+)(?:\s|$)/);
  const badgeOffset = spacingValue(badge, /(?:^|\s)translate-x-([\d.]+)(?:\s|$)/);
  const badgeTopOffset = spacingValue(badge, /(?:^|\s)-translate-y-([\d.]+)(?:\s|$)/);
  const badgeHeight = spacingValue(badge, /(?:^|\s)leading-([\d.]+)(?:\s|$)/);

  for (const { chatWidth, badgeWidth } of [
    { chatWidth: 720, badgeWidth: 14 },
    { chatWidth: 720, badgeWidth: 22 },
    { chatWidth: 360, badgeWidth: 14 },
    { chatWidth: 360, badgeWidth: 22 },
  ]) {
    const railLeft = chatWidth;
    const railRight = railLeft + railWidth;
    const badgeRight = railLeft + railPadding + buttonSize + badgeOffset;
    const badgeLeft = badgeRight - badgeWidth;
    const badgeTop = railTopPadding - badgeTopOffset;
    const badgeBottom = badgeTop + badgeHeight;

    expect(badgeRight).toBeGreaterThan(badgeLeft);
    expect(badgeBottom).toBeGreaterThan(badgeTop);
    expect(badgeLeft).toBeGreaterThanOrEqual(railLeft);
    expect(badgeRight).toBeLessThanOrEqual(railRight);
    expect(badgeTop).toBeGreaterThanOrEqual(0);
  }

  expect(sessionPageSource).toContain('artifactTargetCount > 9 ? "9+" : artifactTargetCount');

  evidence.recordAssertionEvidence(
    "Artifact counts remain fully visible in the desktop rail",
    "The one-digit and compact 9+ badges fit inside the rail at narrow and wide chat widths without changing the 9+ presentation.",
    true,
  );
});
