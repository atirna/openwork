import assert from "node:assert/strict"
import { test } from "node:test"
import { areaOf, buildMatrix, laneOf, renderMarkdown } from "./spec-coverage-matrix.mjs"

test("laneOf classifies spec lanes", () => {
  assert.equal(laneOf("a.test.ts"), "pr")
  assert.equal(laneOf("a.e2e.test.ts"), "e2e")
  assert.equal(laneOf("a.live.test.ts"), "live")
  assert.equal(laneOf("contracts.snapshot.json"), null)
})

test("areaOf groups by slug prefix", () => {
  assert.equal(areaOf("automation-revision-revert.e2e.test.ts"), "automation")
  assert.equal(areaOf("workflows.e2e.test.ts"), "workflows")
})

test("buildMatrix counts lanes per contract and finds unmapped specs", () => {
  const specNames = [
    "automation-a.e2e.test.ts",
    "automation-b.test.ts",
    "workflow-x.e2e.test.ts",
    "orphan-thing.test.ts",
    "orphan-thing-two.e2e.test.ts",
  ]
  const contracts = [
    {
      id: "desktop.automations",
      description: "automations",
      specs: ["evals/specs/automation-a.e2e.test.ts", "evals/specs/automation-b.test.ts"],
    },
    { id: "den.workflows", description: "workflows", specs: ["evals/specs/workflow-x.e2e.test.ts"] },
  ]
  const matrix = buildMatrix(specNames, contracts)
  assert.equal(matrix.totalSpecs, 5)
  assert.equal(matrix.mappedSpecs, 3)
  assert.equal(matrix.unmappedSpecs, 2)

  const automations = matrix.contracts.find((row) => row.id === "desktop.automations")
  assert.deepEqual(automations.counts, { pr: 1, e2e: 1, live: 0 })
  assert.deepEqual(automations.missingLanes, [])

  const workflows = matrix.contracts.find((row) => row.id === "den.workflows")
  assert.deepEqual(workflows.missingLanes, ["pr"])

  assert.deepEqual(matrix.unmappedAreas, [{ area: "orphan", pr: 1, e2e: 1, live: 0 }])
})

test("renderMarkdown includes contract rows and unmapped areas", () => {
  const matrix = buildMatrix(
    ["automation-a.e2e.test.ts", "orphan-thing.test.ts"],
    [{ id: "desktop.automations", description: "automations", specs: ["evals/specs/automation-a.e2e.test.ts"] }],
  )
  const markdown = renderMarkdown(matrix)
  assert.match(markdown, /\| desktop\.automations \| 0 \| 1 \| 0 \| pr \|/)
  assert.match(markdown, /\| orphan \| 1 \| 0 \| 0 \|/)
})
