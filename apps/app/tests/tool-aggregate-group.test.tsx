/** @jsxImportSource react */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { DynamicToolUIPart } from "ai";

import { ToolAggregateGroup, buildAggregateRows } from "../src/components/chat/tool-aggregate-group";
import { CurrentToolLifecycleProvider } from "../src/components/chat/current-tool-lifecycle-context";
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
    expect(markup).not.toContain("Now:");
    expect(markup).toContain("ow-text-shimmer");
    expect(markup).not.toContain("animate-spin");
  });

  test("shimmers the whole active action without a Now prefix", () => {
    const settledRead: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "read",
      toolCallId: "settled-read",
      state: "output-available",
      input: { filePath: "/repo/other.tsx" },
      output: "contents",
    };
    const runningEdit: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "edit",
      toolCallId: "running-edit",
      state: "input-available",
      input: { filePath: "/repo/message-list.tsx" },
    };

    const markup = renderToStaticMarkup(
      <CurrentToolLifecycleProvider
        activityStatus="responding"
        currentToolCallIds={new Set([runningEdit.toolCallId])}
      >
        <ToolAggregateGroup parts={[settledRead, runningEdit]} />
      </CurrentToolLifecycleProvider>,
    );

    expect(markup).not.toContain("Now:");
    expect(markup).toContain("ow-text-shimmer");
    expect(markup).toContain("Editing message-list.tsx");
  });

  test("a single file action renders as its row, not under a count header", () => {
    const settledEdit: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "edit",
      toolCallId: "settled-edit",
      state: "output-available",
      input: { filePath: "/repo/file-chip.tsx" },
      output: "ok",
    };

    const markup = renderToStaticMarkup(<ToolAggregateGroup parts={[settledEdit]} />);

    expect(markup).not.toContain("Edited 1 file");
    expect(markup).not.toContain("aria-expanded");
    expect(markup).toContain("Edited");
    expect(markup).toContain("file-chip.tsx");
  });

  test("a single running file action shimmers its verb in the solo row", () => {
    const runningEdit: DynamicToolUIPart = {
      type: "dynamic-tool",
      toolName: "edit",
      toolCallId: "running-edit",
      state: "input-available",
      input: { filePath: "/repo/message-list.tsx" },
    };

    const markup = renderToStaticMarkup(<ToolAggregateGroup parts={[runningEdit]} />);

    expect(markup).not.toContain("Editing 1 file");
    expect(markup).toContain("ow-text-shimmer");
    expect(markup).toContain("Editing");
    expect(markup).toContain("message-list.tsx");
  });
});

describe("tool aggregate row merging", () => {
  const readOf = (toolCallId: string, filePath: string): DynamicToolUIPart => ({
    type: "dynamic-tool",
    toolName: "read",
    toolCallId,
    state: "output-available",
    input: { filePath },
    output: "contents",
  });

  test("collapses repeated settled reads of the same file into one ×N row", () => {
    const rows = buildAggregateRows(
      [readOf("read-1", "/repo/message-list.tsx"), readOf("read-2", "/repo/message-list.tsx")],
      [],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.repeat).toBe(2);
    expect(rows[0]?.index).toBe(0);
    expect(rows[0]?.lastIndex).toBe(1);
  });

  test("keeps reads of different files as separate rows", () => {
    const rows = buildAggregateRows(
      [readOf("read-1", "/repo/a.tsx"), readOf("read-2", "/repo/b.tsx")],
      [],
    );

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.repeat === 1)).toBe(true);
  });

  test("a thought anchored between two identical reads keeps them apart", () => {
    const rows = buildAggregateRows(
      [readOf("read-1", "/repo/a.tsx"), readOf("read-2", "/repo/a.tsx")],
      [{ afterIndex: 1, text: "Checking the export shape.", isStreaming: false }],
    );

    expect(rows).toHaveLength(2);
  });
});
