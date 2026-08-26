/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DynamicToolUIPart } from "ai";

import { CurrentToolLifecycleProvider } from "../src/components/chat/current-tool-lifecycle-context";
import { ToolAggregateGroup } from "../src/components/chat/tool-aggregate-group";
import { getToolAggregateLifecycle } from "../src/lib/tool-aggregate";

const runningCommand: DynamicToolUIPart = {
  type: "dynamic-tool",
  toolName: "bash",
  toolCallId: "running-command",
  state: "input-available",
  input: { command: "git status", description: "Check repository state" },
};

const completedCommand: DynamicToolUIPart = {
  ...runningCommand,
  toolCallId: "completed-command",
  state: "output-available",
  output: "clean",
};

const failedCommand: DynamicToolUIPart = {
  ...runningCommand,
  toolCallId: "failed-command",
  state: "output-error",
  errorText: "Process exited with code 2",
};

describe("tool aggregate running feedback", () => {
  test("classifies only lifecycle facts the aggregate can prove", () => {
    expect(getToolAggregateLifecycle([runningCommand], "running")).toBe("running");
    expect(getToolAggregateLifecycle([runningCommand], "waiting")).toBe("waiting");
    expect(getToolAggregateLifecycle([runningCommand], "interrupted")).toBe("unknown");
    expect(getToolAggregateLifecycle([completedCommand], null)).toBe("completed");
    expect(getToolAggregateLifecycle([failedCommand], null)).toBe("failed");
  });

  test("uses a quiet shimmer instead of a spinner for the current action", () => {
    const markup = renderToStaticMarkup(
      <CurrentToolLifecycleProvider
        activityStatus="responding"
        currentToolCallIds={new Set([runningCommand.toolCallId])}
      >
        <ToolAggregateGroup parts={[runningCommand]} />
      </CurrentToolLifecycleProvider>,
    );

    expect(markup).toContain("Running command");
    expect(markup).not.toContain("Running 1 command");
    expect(markup).toContain("Now:");
    expect(markup).toContain("ow-text-shimmer");
    expect(markup).not.toContain("animate-spin");
  });
});
