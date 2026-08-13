import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const read = (relative: string) =>
  readFileSync(join(import.meta.dir, "..", relative), "utf8")

/**
 * A Desktop Automation only runs while a desktop is connected, and for a long
 * time the surface said nothing about that until an occurrence had already
 * been missed — with one generic wording that could not distinguish a closed
 * laptop from a runner that could never connect. These checks pin the signals
 * that make the state visible before and after a due occurrence.
 */
describe("Automation runner visibility", () => {
  test("the page warns while no desktop is connected", () => {
    const page = read("src/react-app/domains/automations/automations-page.tsx")
    expect(page).toContain("getAutomationDesktopRunnerPresence")
    expect(page).toContain("runnerPresenceQuery.data?.connected === false")
    expect(page).toContain("data-automation-runner-offline")
    expect(page).toContain("No desktop connected")
  })

  test("a missed run shows the cause Den recorded", () => {
    const page = read("src/react-app/domains/automations/automations-page.tsx")
    expect(page).toContain("run.error.message.trim() || \"Missed — desktop runner unavailable\"")
  })

  test("the bridge re-registers when the network comes back", () => {
    const bridge = read("src/react-app/domains/automations/automation-runner-bridge.tsx")
    expect(bridge).toContain("window.addEventListener(\"online\", handleSettingsChanged)")
    expect(bridge).toContain("window.removeEventListener(\"online\", handleSettingsChanged)")
  })
})
