import { expect } from "vitest";
import { denFetch, evalIn, waitFor } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { app, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = {
  optIn: ["OPENWORK_EVAL_E2E_TESTS"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `organization-managed Desktop dashboard skipped — needs: ${missingRequirements.join(", ")}`
  : "Desktop enables managed dashboard caching and automatic refresh after member opt-in";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function organizationId(session: DenSession): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${session.token}` },
  });
  const organizations = isRecord(result.body) && Array.isArray(result.body.orgs)
    ? result.body.orgs.filter(isRecord)
    : [];
  const id = organizations[0] && typeof organizations[0].id === "string" ? organizations[0].id : "";
  if (!result.response.ok || !id) {
    throw new Error(`Finding the active organization failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

type DashboardElementInput = {
  serverName: string;
  connectionId: string;
  toolName: string;
  projectedToolName: string;
  resourceUri: string;
  title: string;
  requiresApproval?: boolean;
  organizationAutoLaunch?: boolean;
};

const weeklyReportElement: DashboardElementInput = {
  serverName: "openwork-app-host-connect-0123456789ab",
  connectionId: "emc_01dashboardfixture0000000000",
  toolName: "render_report",
  projectedToolName: "openwork-app-host-connect-0123456789ab_render_report",
  resourceUri: "ui://fixture/report/view.html",
  title: "Weekly report",
};

async function createDashboard(
  session: DenSession,
  name: string,
  elements: DashboardElementInput[] = [weeklyReportElement],
): Promise<string> {
  const result = await denFetch(session, "/v1/dashboards", {
    method: "POST",
    headers: { authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      name,
      elements,
    }),
  });
  const item = isRecord(result.body) && isRecord(result.body.item) ? result.body.item : null;
  const id = item && typeof item.id === "string" ? item.id : "";
  const returnedElements = item && Array.isArray(item.elements) ? item.elements : [];
  if (result.response.status !== 201 || !id || returnedElements.length !== elements.length) {
    throw new Error(`Creating ${name} failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return id;
}

test(title, async ({ evidence, place }) => {
  needs(requirements);
  await using den = await server({
    place,
    env: { DEN_DASHBOARDS_ENABLED: "true" },
    org: {
      name: `Managed Desktop dashboard ${Date.now()}`,
      admin: { name: "Managed Dashboard Admin" },
    },
  });

  const orgId = await organizationId(den.admin);
  const grantedName = `Operations board ${Date.now()}`;
  const privateName = `Private board ${Date.now()}`;
  const grantedDashboardId = await createDashboard(den.admin, grantedName, [
    weeklyReportElement,
    {
      ...weeklyReportElement,
      toolName: "create_ticket",
      projectedToolName: "openwork-app-host-connect-0123456789ab_create_ticket",
      resourceUri: "ui://fixture/ticket/view.html",
      title: "Automatic ticket summary",
      requiresApproval: true,
      organizationAutoLaunch: true,
    },
  ]);
  await createDashboard(den.admin, privateName);
  const grant = await denFetch(den.admin, `/v1/dashboards/${grantedDashboardId}/access`, {
    method: "POST",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({ orgWide: true, role: "viewer" }),
  });
  if (grant.response.status !== 201) {
    throw new Error(`Granting the dashboard failed: HTTP ${grant.response.status} ${grant.text.slice(0, 500)}`);
  }

  await using desktop = await app({
    den,
    as: "admin",
    place,
  });
  const dashboardHash = "#/dashboard";
  const dashboardOpened = await evalIn(desktop, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((entry) => entry.textContent?.trim() === "Dashboard");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  })()`);
  expect(dashboardOpened).toBe(true);
  await waitFor(desktop, `(() => {
    const section = document.querySelector(${JSON.stringify(`[data-granted-dashboard="${grantedDashboardId}"]`)});
    return location.hash === ${JSON.stringify(dashboardHash)}
      && section instanceof HTMLElement
      && section.innerText.includes(${JSON.stringify(grantedName)})
      && section.innerText.includes("Managed by your organization")
      && section.innerText.includes("Weekly report");
  })()`, {
    timeoutMs: 90_000,
    label: "granted organization dashboard rendered in Desktop",
  });

  const initialState = await evalIn(desktop, `(() => {
    const section = document.querySelector(${JSON.stringify(`[data-granted-dashboard="${grantedDashboardId}"]`)});
    if (!(section instanceof HTMLElement)) return null;
    const allText = document.body.innerText;
    const weeklyTile = [...section.querySelectorAll("[data-dashboard-entry]")]
      .find((tile) => tile.textContent?.includes("Weekly report"));
    const searchButton = [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Search sessions"));
    const dashboardButton = [...document.querySelectorAll("button")]
      .find((button) => button.textContent?.trim() === "Dashboard");
    return {
      boardVisible: section.innerText.includes(${JSON.stringify(grantedName)}),
      privateBoardVisible: allText.includes(${JSON.stringify(privateName)}),
      readOnlyRunVisible: Boolean(section.querySelector('button[aria-label="Run Weekly report"]')),
      automaticAttemptVisible: weeklyTile instanceof HTMLElement && weeklyTile.innerText.includes("Refresh failed"),
      removeVisible: Boolean(section.querySelector('button[aria-label="Remove Weekly report"]')),
      addAppVisible: [...document.querySelectorAll("button")]
        .some((button) => button.textContent?.trim() === "Add app"),
      managedLabelVisible: section.innerText.includes("Managed by your organization"),
      dashboardImmediatelyAfterSearch: searchButton instanceof HTMLElement
        && dashboardButton instanceof HTMLElement
        && searchButton.parentElement?.nextElementSibling?.contains(dashboardButton) === true,
    };
  })()`);
  expect(initialState).toEqual({
    boardVisible: true,
    privateBoardVisible: false,
    readOnlyRunVisible: true,
    automaticAttemptVisible: false,
    removeVisible: false,
    addAppVisible: false,
    managedLabelVisible: true,
    dashboardImmediatelyAfterSearch: true,
  });
  await waitFor(desktop, `(() => {
    const section = document.querySelector(${JSON.stringify(`[data-granted-dashboard="${grantedDashboardId}"]`)});
    if (!(section instanceof HTMLElement)) return false;
    const automaticTile = [...section.querySelectorAll("[data-dashboard-entry]")]
      .find((tile) => tile.textContent?.includes("Automatic ticket summary"));
    const cacheState = automaticTile instanceof HTMLElement
      ? automaticTile.querySelector("[data-dashboard-cache-state]")?.getAttribute("data-dashboard-cache-state")
      : null;
    return automaticTile instanceof HTMLElement
      && (cacheState === "refreshing" || automaticTile.innerText.includes("Refresh failed"))
      && !automaticTile.querySelector('button[aria-label="Run Automatic ticket summary"]');
  })()`, {
    timeoutMs: 90_000,
    label: "organization-authorized modifying app attempted automatic load",
  });
  const organizationPolicyState = await evalIn(desktop, `(() => {
    const section = document.querySelector(${JSON.stringify(`[data-granted-dashboard="${grantedDashboardId}"]`)});
    const tile = section instanceof HTMLElement
      ? [...section.querySelectorAll("[data-dashboard-entry]")]
        .find((entry) => entry.textContent?.includes("Automatic ticket summary"))
      : null;
    const cacheState = tile instanceof HTMLElement
      ? tile.querySelector("[data-dashboard-cache-state]")?.getAttribute("data-dashboard-cache-state")
      : null;
    return {
      automaticAttemptVisible: tile instanceof HTMLElement
        && (cacheState === "refreshing" || tile.innerText.includes("Refresh failed")),
      cacheState,
      runVisible: Boolean(tile?.querySelector('button[aria-label="Run Automatic ticket summary"]')),
    };
  })()`);
  expect(organizationPolicyState).toMatchObject({ automaticAttemptVisible: true, runVisible: false });
  evidence.recordAssertionEvidence(
    "Desktop places Dashboard directly below Search in the left sidebar",
    `state=${JSON.stringify(initialState)}`,
    isRecord(initialState) && initialState.dashboardImmediatelyAfterSearch === true,
  );
  evidence.recordAssertionEvidence(
    "Organization admins can authorize automatic launch even for an app that modifies data",
    `tile=Automatic ticket summary; state=${JSON.stringify(organizationPolicyState)}`,
    isRecord(organizationPolicyState)
      && organizationPolicyState.automaticAttemptVisible === true
      && organizationPolicyState.runVisible === false,
  );
  evidence.recordAssertionEvidence(
    "Desktop renders only dashboards granted to the signed-in member",
    `org=${orgId}; granted=${grantedName}; ungranted=${privateName}; state=${JSON.stringify(initialState)}`,
    isRecord(initialState) && initialState.boardVisible === true && initialState.privateBoardVisible === false,
  );
  evidence.recordAssertionEvidence(
    "Managed app metadata cannot trigger a first-visit launch without member opt-in",
    `tile=Weekly report; state=${JSON.stringify(initialState)}`,
    isRecord(initialState)
      && initialState.readOnlyRunVisible === true
      && initialState.automaticAttemptVisible === false,
  );

  const cacheSeeded = await evalIn(desktop, `(() => {
    const page = document.querySelector("[data-dashboard-cache-scope]");
    const section = document.querySelector(${JSON.stringify(`[data-granted-dashboard="${grantedDashboardId}"]`)});
    if (!(page instanceof HTMLElement) || !(section instanceof HTMLElement)) return false;
    const weeklyTile = [...section.querySelectorAll("[data-dashboard-entry]")]
      .find((tile) => tile.textContent?.includes("Weekly report"));
    const scope = page.dataset.dashboardCacheScope;
    const consentScope = page.dataset.dashboardConsentScope;
    const entryId = weeklyTile instanceof HTMLElement ? weeklyTile.dataset.dashboardEntry : undefined;
    if (!scope || !consentScope || !entryId) return false;
    localStorage.setItem(consentScope, JSON.stringify({ [entryId]: { autoLaunch: true } }));
    localStorage.setItem(scope, JSON.stringify({
      [entryId]: {
        cachedAt: Date.now(),
        workspaceId: ${JSON.stringify(desktop.workspaceId)},
        app: {
          serverName: "openwork-app-host-connect-0123456789ab",
          toolName: "render_report",
          resourceUri: "ui://fixture/report/view.html",
          html: "<!doctype html><html><body><main>Saved weekly report</main></body></html>",
          csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
          prefersBorder: true,
        },
        result: {
          content: [{ type: "text", text: "Saved weekly report" }],
          structuredContent: { report: "saved" },
        },
      },
    }));
    location.reload();
    return true;
  })()`);
  expect(cacheSeeded).toBe(true);

  await waitFor(desktop, `(() => {
    const section = document.querySelector(${JSON.stringify(`[data-granted-dashboard="${grantedDashboardId}"]`)});
    if (!(section instanceof HTMLElement)) return false;
    const weeklyTile = [...section.querySelectorAll("[data-dashboard-entry]")]
      .find((tile) => tile.textContent?.includes("Weekly report"));
    return weeklyTile instanceof HTMLElement
      && Boolean(weeklyTile.querySelector("iframe"))
      && (weeklyTile.innerText.includes("Saved locally · refreshing")
        || weeklyTile.innerText.includes("Saved locally · refresh failed"));
  })()`, {
    timeoutMs: 90_000,
    label: "saved dashboard view remained visible during background refresh",
  });

  const cachedState = await evalIn(desktop, `(() => {
    const section = document.querySelector(${JSON.stringify(`[data-granted-dashboard="${grantedDashboardId}"]`)});
    const weeklyTile = section instanceof HTMLElement
      ? [...section.querySelectorAll("[data-dashboard-entry]")]
        .find((tile) => tile.textContent?.includes("Weekly report"))
      : null;
    return {
      cachedViewVisible: weeklyTile instanceof HTMLElement && Boolean(weeklyTile.querySelector("iframe")),
      refreshActive: weeklyTile instanceof HTMLElement
        && (weeklyTile.innerText.includes("Saved locally · refreshing")
          || weeklyTile.innerText.includes("Saved locally · refresh failed")),
      readOnlyRunVisible: Boolean(section?.querySelector('button[aria-label="Run Weekly report"]')),
    };
  })()`);
  expect(cachedState).toEqual({
    cachedViewVisible: true,
    refreshActive: true,
    readOnlyRunVisible: false,
  });
  evidence.recordAssertionEvidence(
    "Desktop renders saved dashboard data immediately and keeps it visible during background refresh",
    `tile=Weekly report; state=${JSON.stringify(cachedState)}`,
    isRecord(cachedState)
      && cachedState.cachedViewVisible === true
      && cachedState.refreshActive === true
      && cachedState.readOnlyRunVisible === false,
  );
  evidence.recordAssertionEvidence(
    "Managed dashboards stay non-removable and have no local authoring controls",
    `state=${JSON.stringify(initialState)}`,
    isRecord(initialState)
      && initialState.removeVisible === false
      && initialState.addAppVisible === false
      && initialState.managedLabelVisible === true,
  );
});
