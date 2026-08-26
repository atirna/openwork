import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { getAssistantRenderGroups } from "../../apps/app/src/components/chat/utils";

type Parts = Parameters<typeof getAssistantRenderGroups>[0];
type Part = Parts[number];

function bashPart(id: string): Part {
  return {
    type: "dynamic-tool",
    toolName: "bash",
    toolCallId: id,
    state: "output-available",
    input: { command: `echo ${id}`, description: "run" },
    output: "ok",
  };
}

function reasoningPart(text: string): Part {
  return { type: "reasoning", text, state: "done" };
}

test("mid-run thoughts stay chronological inside one compact tool aggregate", ({ evidence }) => {
  // An alternating run: the model thinks, runs two commands, thinks again,
  // runs two more. This must NOT render as a thought/command ladder of
  // repeated single lines, and it must NOT reorder thoughts below the run.
  const parts: Parts = [
    reasoningPart("plan the first probe"),
    bashPart("c1"),
    bashPart("c2"),
    reasoningPart("interpret and go deeper"),
    bashPart("c3"),
    bashPart("c4"),
  ];

  const visible = getAssistantRenderGroups(parts, true);

  // Compactness: the turn-opening thought is its own line, then ONE
  // aggregate carries the whole run.
  expect(visible.map((group) => group.kind)).toEqual(["reasoning", "tool-aggregate"]);
  const opening = visible[0];
  expect(opening.kind === "reasoning" ? opening.text : "").toBe("plan the first probe");

  // Chronology: the mid-run thought is anchored between c2 and c3 —
  // after exactly two of the run's calls — not merged below the run.
  const aggregate = visible[1];
  if (aggregate.kind === "tool-aggregate") {
    expect(aggregate.parts.map((part) => part.toolCallId)).toEqual(["c1", "c2", "c3", "c4"]);
    expect(aggregate.thoughts).toEqual([
      { afterIndex: 2, text: "interpret and go deeper", isStreaming: false },
    ]);
  }

  // Negative half 1: with thinking hidden, the same turn is one aggregate
  // with no embedded thoughts — nothing leaks and nothing fragments.
  const hidden = getAssistantRenderGroups(parts, false);
  expect(hidden.map((group) => group.kind)).toEqual(["tool-aggregate"]);
  if (hidden[0].kind === "tool-aggregate") {
    expect(hidden[0].parts.map((part) => part.toolCallId)).toEqual(["c1", "c2", "c3", "c4"]);
    expect(hidden[0].thoughts).toEqual([]);
  }

  // Negative half 2: whitespace-only reasoning embeds no thought and does
  // not fragment the run even when thinking is shown.
  const blank = getAssistantRenderGroups(
    [bashPart("c1"), reasoningPart("  \n"), bashPart("c2")],
    true
  );
  expect(blank.map((group) => group.kind)).toEqual(["tool-aggregate"]);
  if (blank[0].kind === "tool-aggregate") {
    expect(blank[0].thoughts).toEqual([]);
  }

  evidence.recordAssertionEvidence(
    "Mid-run thoughts stay chronological inside one compact aggregate",
    "An alternating thought/command turn rendered as one opening thought plus one four-call aggregate carrying its mid-run thought anchored after the second call; hiding thinking produced the same single aggregate with no thoughts; whitespace-only reasoning embedded nothing.",
    true,
  );
});
