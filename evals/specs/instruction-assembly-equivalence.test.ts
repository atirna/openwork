import { expect } from "vitest";
import { test } from "@openwork/testkit";
import {
  combineInstructionSections,
  composeAgentInstructions,
  createInstructionSection,
} from "../../apps/server/src/opencode-plugins/agent-instruction-compose";

test("per-turn instruction assembly dedupes once and stays behaviorally equivalent", ({ evidence }) => {
  // Claim: the single-pass composer produces exactly the output of the
  // previous combine-then-compose pipeline for every caller shape — ordering
  // preserved, one id wins with first-non-empty semantics, empties dropped.
  const groups = [
    createInstructionSection("routing", "route the turn"),
    [
      createInstructionSection("routing", "ignored duplicate"),
      createInstructionSection("skills", "   "),
      createInstructionSection("skills", "use the skill index"),
      createInstructionSection("browser", "browser guidance"),
    ],
    null,
    undefined,
    createInstructionSection("session", "session guidance"),
  ];
  const legacy = combineInstructionSections(...groups).map((section) => section.body);
  const composed = composeAgentInstructions(...groups);
  expect(composed).toEqual(legacy);
  expect(composed).toEqual([
    "route the turn",
    "use the skill index",
    "browser guidance",
    "session guidance",
  ]);

  // The previous call shape — one already-combined array — composes
  // identically, so existing callers cannot observe a behavior change.
  expect(composeAgentInstructions(combineInstructionSections(...groups))).toEqual(legacy);

  // Negative half 1: an empty body never claims its id, so a later
  // non-empty section with the same id still wins (first-non-empty).
  expect(composeAgentInstructions(
    createInstructionSection("only", ""),
    createInstructionSection("only", "real body"),
  )).toEqual(["real body"]);

  // Negative half 2: per-turn assembly reads each retained section body
  // exactly once — the redundant second combination pass is gone.
  let bodyReads = 0;
  const observedSection = {
    id: "observed",
    get body() {
      bodyReads += 1;
      return "observed body";
    },
  };
  expect(composeAgentInstructions(
    createInstructionSection("routing", "route the turn"),
    observedSection,
  )).toEqual(["route the turn", "observed body"]);
  expect(bodyReads).toBe(1);

  // Negative half 3: a duplicate id never reaches its body at all.
  let duplicateReads = 0;
  const duplicateSection = {
    id: "routing",
    get body() {
      duplicateReads += 1;
      return "should not be read";
    },
  };
  composeAgentInstructions(
    createInstructionSection("routing", "route the turn"),
    duplicateSection,
  );
  expect(duplicateReads).toBe(0);

  evidence.recordAssertionEvidence(
    "Instruction assembly is single-pass and equivalent",
    "The composed system prompt matches the legacy combine-then-compose output for grouped, flat, sparse, duplicate, and empty inputs; each retained body is read once and duplicate ids are never read.",
    true,
  );
});
