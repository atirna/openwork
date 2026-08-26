/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DynamicToolUIPart } from "ai";

import { ToolAggregateGroup } from "../src/components/chat/tool-aggregate-group";

describe("tool aggregate running feedback", () => {
  test("uses a quiet shimmer instead of a spinner for the current action", () => {
    const runningCommand: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "bash",
      toolCallId: "running-command",
      state: "input-available",
      input: { command: "git status", description: "Check repository state" },
    };

    const markup = renderToStaticMarkup(<ToolAggregateGroup parts={[runningCommand]} />);

    expect(markup).toContain("Running command");
    expect(markup).not.toContain("Running 1 command");
    expect(markup).toContain("Now:");
    expect(markup).toContain("ow-text-shimmer");
    expect(markup).not.toContain("animate-spin");
  });
});
