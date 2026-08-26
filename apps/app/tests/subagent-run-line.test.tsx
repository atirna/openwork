import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageListProvider } from "../src/components/chat/message-list-provider";
import { SubagentRunLine } from "../src/components/chat/subagent-run-line";
import type { TaskToolPart } from "../src/lib/build-in-tools";

const noop = () => {};

function taskPart(state: "input-streaming" | "output-available"): TaskToolPart {
  const input = {
    description: "Build isolated Azure repro",
    prompt: "Reproduce the Azure failure in isolation.",
    subagent_type: "executor-deep",
  };

  return state === "output-available"
    ? {
        type: "dynamic-tool",
        toolName: "task",
        toolCallId: "call-subagent",
        state,
        input,
        output: "Completed the reproduction.",
      }
    : {
        type: "dynamic-tool",
        toolName: "task",
        toolCallId: "call-subagent",
        state,
        input,
      };
}

function render(part: TaskToolPart): string {
  return renderToStaticMarkup(
    <MessageListProvider
      workspaceId="workspace-a"
      sessionId="session-origin"
      showThinking={false}
      developerMode={false}
      displaySuggestions={false}
      providerConnectedCount={1}
      dispatchAction={noop}
      setPrompt={noop}
      onRevertToUserMessage={noop}
      onForkAtMessage={noop}
      onEditUserMessage={noop}
      onMcpReconnect={async () => "connected"}
      onMcpReopenAuthorization={async () => {}}
      onMcpRetry={noop}
    >
      <SubagentRunLine part={part} />
    </MessageListProvider>,
  );
}

describe("SubagentRunLine", () => {
  test("uses a text shimmer instead of a spinner while the subagent is running", () => {
    const html = render(taskPart("input-streaming"));

    expect(html).toContain('data-subagent-activity="shimmer"');
    expect(html).toContain("ow-text-shimmer");
    expect(html).toContain("Build isolated Azure repro");
    expect(html).toContain("Working 0s");
    expect(html).not.toContain("animate-spin");
  });

  test("settles to a static completed treatment", () => {
    const html = render(taskPart("output-available"));

    expect(html).toContain('data-subagent-activity="completed"');
    expect(html).toContain("Completed");
    expect(html).not.toContain("ow-text-shimmer");
    expect(html).not.toContain("animate-spin");
  });
});
