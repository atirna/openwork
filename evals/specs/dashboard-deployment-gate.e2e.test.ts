import { expect } from "vitest";
import { denFetch, evalIn, go } from "@openwork/behaviors";
import { app, needs, server, test } from "@openwork/testkit";

const requirements = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("Desktop hides Dashboard when the deployment flag is disabled", { timeout: 300_000 }, async ({ evidence, place }) => {
  needs(requirements);
  await using den = await server({
    place,
    env: { DEN_DASHBOARDS_ENABLED: "false" },
  });

  const config = await denFetch(den.admin, "/v1/me/desktop-config", {
    headers: { authorization: `Bearer ${den.admin.token}` },
  });
  expect(config.response.status, config.text).toBe(200);
  expect(isRecord(config.body) ? config.body.dashboardEnabled : undefined).toBe(false);

  await using desktop = await app({ den, as: "admin", place });
  const sidebarHasDashboard = await evalIn(desktop, `
    [...document.querySelectorAll("button")]
      .some((button) => button.textContent?.trim() === "Dashboard")
  `);
  expect(sidebarHasDashboard).toBe(false);

  await go(desktop, "/dashboard");
  await expect.poll(
    () => evalIn(desktop, "!/^#\\/dashboard(?:\\?|$)/.test(location.hash)"),
    { timeout: 60_000 },
  ).toBe(true);

  evidence.recordAssertionEvidence(
    "Disabled deployments hide Dashboard",
    "Desktop config returned dashboardEnabled=false, the sidebar omitted Dashboard, and a direct Dashboard route request redirected away.",
    true,
  );
});
