/**
 * Kent-style instruction primitives for OpenWork system-prompt composition.
 *
 * create  — build one named section
 * combine — merge sections in order, one id wins (first non-empty)
 * delete  — drop a section by id
 * expand  — replace a section body with derived text when present
 * compose — combine sections and return their prompt bodies
 *
 * Sections are the unit of overlap control: routing/tools/skills/session each
 * own one id so transforms stop stacking contradictory brochure text.
 */

export type AgentInstructionSection = {
  id: string;
  body: string;
};

type AgentInstructionSectionGroup = AgentInstructionSection | AgentInstructionSection[] | null | undefined;

export function createInstructionSection(id: string, body: string): AgentInstructionSection {
  return { id, body: body.trim() };
}

export function combineInstructionSections(
  ...groups: AgentInstructionSectionGroup[]
): AgentInstructionSection[] {
  const seen = new Set<string>();
  const combined: AgentInstructionSection[] = [];
  for (const group of groups) {
    if (!group) continue;
    const sections = Array.isArray(group) ? group : [group];
    for (const section of sections) {
      if (!section.body || seen.has(section.id)) continue;
      seen.add(section.id);
      combined.push(section);
    }
  }
  return combined;
}

export function deleteInstructionSection(
  sections: AgentInstructionSection[],
  id: string,
): AgentInstructionSection[] {
  return sections.filter((section) => section.id !== id);
}

export function expandInstructionSection(
  sections: AgentInstructionSection[],
  id: string,
  expand: (body: string) => string,
): AgentInstructionSection[] {
  return sections.map((section) => (
    section.id === id
      ? { ...section, body: expand(section.body).trim() }
      : section
  )).filter((section) => section.body.length > 0);
}

export function composeAgentInstructions(...groups: AgentInstructionSectionGroup[]): string[] {
  const seen = new Set<string>();
  const instructions: string[] = [];
  for (const group of groups) {
    if (!group) continue;
    const sections = Array.isArray(group) ? group : [group];
    for (const section of sections) {
      if (seen.has(section.id)) continue;
      const body = section.body;
      if (!body) continue;
      seen.add(section.id);
      instructions.push(body);
    }
  }
  return instructions;
}
