import { describe, expect, test } from "bun:test";

import {
  combineInstructionSections,
  composeAgentInstructions,
  createInstructionSection,
  deleteInstructionSection,
  expandInstructionSection,
} from "./agent-instruction-compose.js";

describe("agent instruction compose primitives", () => {
  test("create + combine keep first non-empty section per id", () => {
    const sections = combineInstructionSections(
      createInstructionSection("routing", "use cloud tools"),
      createInstructionSection("routing", "ignored duplicate"),
      createInstructionSection("skills", "<available_skills />"),
      createInstructionSection("empty", "   "),
    );
    expect(sections.map((section) => section.id)).toEqual(["routing", "skills"]);
  });

  test("delete and expand are predictable", () => {
    const base = combineInstructionSections(
      createInstructionSection("browser", "use openwork_execute browser.open_url"),
      createInstructionSection("ui", "use openwork_ui_*"),
    );
    const withoutUi = deleteInstructionSection(base, "ui");
    const expanded = expandInstructionSection(withoutUi, "browser", (body) => `${body}\nnever use browser_* on OpenWork`);
    expect(composeAgentInstructions(expanded)).toEqual([
      "use openwork_execute browser.open_url\nnever use browser_* on OpenWork",
    ]);
  });

  test("composeAgentInstructions combines section groups once and returns ordered bodies", () => {
    let observedBodyReads = 0;
    const observedSection = {
      id: "observed",
      get body() {
        observedBodyReads += 1;
        return "three";
      },
    };

    expect(composeAgentInstructions(
      createInstructionSection("a", "one"),
      [
        createInstructionSection("a", "ignored duplicate"),
        createInstructionSection("empty", "  "),
        createInstructionSection("b", "two"),
      ],
      observedSection,
    )).toEqual(["one", "two", "three"]);
    expect(observedBodyReads).toBe(1);
  });
});
