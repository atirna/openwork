// Scenario coverage matrix for evals/specs.
//
//   node scripts/spec-coverage-matrix.mjs [--out <file.md>]
//
// Quantifies scenario coverage two ways:
//   1. Per contract in specs/contracts.snapshot.json: how many pr-lane,
//      e2e-lane, and live specs prove it, and which lanes are missing.
//   2. Specs not referenced by any contract (unmapped coverage), grouped by
//      slug prefix so gaps in the contract map are visible.
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const evalsRoot = fileURLToPath(new URL("..", import.meta.url))
const specsDirectory = resolve(evalsRoot, "specs")

export function laneOf(specName) {
  if (specName.endsWith(".e2e.test.ts")) return "e2e"
  if (specName.endsWith(".live.test.ts")) return "live"
  if (specName.endsWith(".test.ts")) return "pr"
  return null
}

export function areaOf(specName) {
  return specName.split("-")[0].replace(/\..*$/, "")
}

export function buildMatrix(specNames, contracts) {
  const lanes = new Map(specNames.map((name) => [name, laneOf(name)]))
  const mapped = new Set()
  const contractRows = contracts.map((contract) => {
    const specs = contract.specs
      .map((path) => path.replace(/^evals\/specs\//, ""))
      .filter((name) => lanes.has(name))
    for (const name of specs) mapped.add(name)
    const counts = { pr: 0, e2e: 0, live: 0 }
    for (const name of specs) counts[lanes.get(name)] += 1
    const missingLanes = ["pr", "e2e"].filter((lane) => counts[lane] === 0)
    return { id: contract.id, description: contract.description, counts, specCount: specs.length, missingLanes }
  })
  const unmapped = specNames.filter((name) => !mapped.has(name))
  const unmappedByArea = new Map()
  for (const name of unmapped) {
    const area = areaOf(name)
    const entry = unmappedByArea.get(area) ?? { area, pr: 0, e2e: 0, live: 0 }
    entry[lanes.get(name)] += 1
    unmappedByArea.set(area, entry)
  }
  return {
    totalSpecs: specNames.length,
    mappedSpecs: mapped.size,
    unmappedSpecs: unmapped.length,
    contracts: contractRows.sort((left, right) => left.specCount - right.specCount || left.id.localeCompare(right.id)),
    unmappedAreas: [...unmappedByArea.values()].sort((left, right) => left.area.localeCompare(right.area)),
  }
}

export function renderMarkdown(matrix) {
  const lines = [
    "# Scenario coverage matrix",
    "",
    `Specs: ${matrix.totalSpecs} · Mapped to a contract: ${matrix.mappedSpecs} · Unmapped: ${matrix.unmappedSpecs}`,
    "",
    "## Contracts",
    "",
    "| Contract | pr | e2e | live | Missing lanes |",
    "| --- | ---: | ---: | ---: | --- |",
  ]
  for (const row of matrix.contracts) {
    lines.push(
      `| ${row.id} | ${row.counts.pr} | ${row.counts.e2e} | ${row.counts.live} | ${row.missingLanes.join(", ") || "—"} |`,
    )
  }
  lines.push(
    "",
    "## Specs without a contract (by area)",
    "",
    "These specs run but are invisible to spec-impact analysis. Add them to",
    "`specs/contracts.snapshot.json` or confirm they are intentionally standalone.",
    "",
    "| Area | pr | e2e | live |",
    "| --- | ---: | ---: | ---: |",
  )
  for (const row of matrix.unmappedAreas) {
    lines.push(`| ${row.area} | ${row.pr} | ${row.e2e} | ${row.live} |`)
  }
  return `${lines.join("\n")}\n`
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const outFlag = process.argv.indexOf("--out")
  const specNames = readdirSync(specsDirectory).filter((name) => laneOf(name) !== null)
  const snapshot = JSON.parse(readFileSync(resolve(specsDirectory, "contracts.snapshot.json"), "utf8"))
  const matrix = buildMatrix(specNames, snapshot.contracts)
  const markdown = renderMarkdown(matrix)
  if (outFlag !== -1) {
    const outPath = resolve(process.cwd(), process.argv[outFlag + 1])
    writeFileSync(outPath, markdown)
    console.log(`spec-coverage-matrix: wrote ${relative(process.cwd(), outPath)}`)
  } else {
    console.log(markdown)
  }
}
