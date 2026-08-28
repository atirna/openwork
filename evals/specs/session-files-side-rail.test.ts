import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

const messageListSource = readFileSync(
  fileURLToPath(new URL("../../apps/app/src/components/chat/message-list.tsx", import.meta.url)),
  "utf8",
);
const sessionPageSource = readFileSync(
  fileURLToPath(new URL("../../apps/app/src/react-app/domains/session/chat/session-page.tsx", import.meta.url)),
  "utf8",
);

test("session files stay in the side rail instead of the chat transcript", async ({ evidence }) => {
  expect(messageListSource).not.toContain("ArtifactList");
  expect(messageListSource).not.toContain("data-files-strip");
  expect(sessionPageSource).toContain('title={`Files (${artifactTargetCount})`}');
  expect(sessionPageSource).toContain('aria-label={`Files (${artifactTargetCount})`}');
  expect(sessionPageSource).toContain("onClick={openArtifactRailPane}");

  evidence.recordAssertionEvidence(
    "Session files are accessed from the side rail, not repeated in the transcript",
    "The message list has no per-turn files strip, while the session side rail keeps a labeled Files control that opens the artifact pane.",
    true,
  );
});
