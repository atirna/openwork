import { rm } from "node:fs/promises";
import { expect } from "vitest";
import { control, evalIn, go } from "@openwork/behaviors";
import {
  checkedExec,
  daytonaSandbox,
  defaultDaytonaExec,
  deleteSandboxes,
  desktop,
  localHost,
  provisionDesktopSandbox,
} from "@openwork/hosts";
import type { DesktopHandle } from "@openwork/hosts";
import { eventually, needs, sleep, test } from "@openwork/testkit";

const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const daytonaEnabled = process.env.OPENWORK_EVAL_DAYTONA === "1";
const title = e2eTestsEnabled
  ? "workspace sidebar order stays stable, remains draggable, and appends new workspaces"
  : "workspace sidebar order skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function seedWorkspaces(desktopApp: DesktopHandle, profileDir: string): Promise<string[]> {
  const value = await evalIn(desktopApp, `(async () => {
    const plans = ${JSON.stringify(["Alpha", "Beta", "Gamma"])};
    let state = null;
    for (const label of plans) {
      state = await window.__OPENWORK_ELECTRON__.invokeDesktop("workspaceCreate", {
        folderPath: ${JSON.stringify(profileDir)} + "/" + label.toLowerCase(),
        name: label,
      });
    }
    return (state?.workspaces ?? []).map((workspace) => workspace.id);
  })()`, { awaitPromise: true, timeoutMs: 60_000 });

  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
    throw new Error(`Workspace seeding returned an invalid list: ${JSON.stringify(value)}`);
  }
  return value;
}

async function sidebarOrder(desktopApp: DesktopHandle): Promise<string[]> {
  const value = await evalIn(
    desktopApp,
    `Array.from(document.querySelectorAll("[data-sidebar-workspace-id]"))
      .map((element) => element.getAttribute("data-sidebar-workspace-id"))
      .filter(Boolean)`,
  );
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
    throw new Error(`Sidebar returned an invalid workspace order: ${JSON.stringify(value)}`);
  }
  return value;
}

async function storedOrder(desktopApp: DesktopHandle): Promise<string[]> {
  const value = await evalIn(desktopApp, `(() => {
    try {
      const parsed = JSON.parse(localStorage.getItem("openwork.react.workspaceOrder") ?? "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  })()`);
  if (!Array.isArray(value) || value.some((id) => typeof id !== "string")) {
    throw new Error(`Stored workspace order is invalid: ${JSON.stringify(value)}`);
  }
  return value;
}

async function listServerWorkspaces(desktopApp: DesktopHandle): Promise<{ activeId: string | null; ids: string[] }> {
  const value = await evalIn(desktopApp, `(async () => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { error: "local_server_unavailable" };
    const response = await fetch(String(info.baseUrl).replace(/\\/+$/, "") + "/workspaces", {
      headers: { Authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? "") },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json();
    const items = Array.isArray(body?.items) ? body.items : [];
    return {
      ok: response.ok,
      activeId: typeof body?.activeId === "string" ? body.activeId : null,
      ids: items.map((item) => String(item?.id ?? "")).filter(Boolean),
    };
  })()`, { awaitPromise: true, timeoutMs: 20_000 });

  if (!isRecord(value) || value.ok !== true || !Array.isArray(value.ids)) {
    throw new Error(`Listing server workspaces failed: ${JSON.stringify(value)}`);
  }
  return {
    activeId: typeof value.activeId === "string" ? value.activeId : null,
    ids: value.ids.filter((id): id is string => typeof id === "string"),
  };
}

async function reloadAndReadSidebar(desktopApp: DesktopHandle, expectedCount: number): Promise<string[]> {
  await evalIn(desktopApp, "window.location.reload(); true");
  return eventually(() => sidebarOrder(desktopApp), {
    within: 90_000,
    intervalMs: 250,
    label: `sidebar with ${expectedCount} workspaces after reload`,
    until: (order) => order.length === expectedCount,
  });
}

async function dragWorkspaceAfter(desktopApp: DesktopHandle, sourceId: string, targetId: string): Promise<void> {
  const value = await evalIn(desktopApp, `(() => {
    const items = Array.from(document.querySelectorAll("[data-sidebar-workspace-id]"));
    const source = items.find((item) => item.getAttribute("data-sidebar-workspace-id") === ${JSON.stringify(sourceId)});
    const target = items.find((item) => item.getAttribute("data-sidebar-workspace-id") === ${JSON.stringify(targetId)});
    const handle = source?.querySelector("[data-sidebar-workspace-drag-handle]");
    if (!handle || !target) return null;
    const from = handle.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    return {
      fromX: from.left + from.width / 2,
      fromY: from.top + from.height / 2,
      toX: to.left + to.width / 2,
      toY: to.bottom - 2,
    };
  })()`);

  if (!isRecord(value)) throw new Error("Workspace drag handles were not available.");
  const fromX = value.fromX;
  const fromY = value.fromY;
  const toX = value.toX;
  const toY = value.toY;
  if (
    typeof fromX !== "number"
    || typeof fromY !== "number"
    || typeof toX !== "number"
    || typeof toY !== "number"
  ) {
    throw new Error(`Workspace drag coordinates were invalid: ${JSON.stringify(value)}`);
  }

  await desktopApp.client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: fromX,
    y: fromY,
  });
  await desktopApp.client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: fromX,
    y: fromY,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  for (let step = 1; step <= 16; step += 1) {
    const progress = step / 16;
    await desktopApp.client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: fromX + (toX - fromX) * progress,
      y: fromY + (toY - fromY) * progress,
      button: "left",
      buttons: 1,
    });
    await sleep(16);
  }
  await desktopApp.client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: toX,
    y: toY,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

async function createWorkspace(desktopApp: DesktopHandle, path: string): Promise<string> {
  const before = await listServerWorkspaces(desktopApp);
  await control(desktopApp, "workspace.create", { path }, { timeoutMs: 90_000 });
  const after = await eventually(() => listServerWorkspaces(desktopApp), {
    within: 90_000,
    intervalMs: 500,
    label: "new workspace registered",
    until: (listing) => listing.ids.length === before.ids.length + 1,
  });
  const createdId = after.ids.find((id) => !before.ids.includes(id));
  if (!createdId) throw new Error("Workspace creation produced no new workspace id.");
  return createdId;
}

test.skipIf(!e2eTestsEnabled)(title, { timeout: 20 * 60_000 }, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
  const profileDir = `/tmp/openwork-workspace-sidebar-order-${process.pid}-${Date.now()}`;
  const provisioned = daytonaEnabled
    ? await provisionDesktopSandbox({
        ref: process.env.OPENWORK_EVAL_REF?.trim() || process.env.GITHUB_SHA?.trim() || "dev",
        name: "workspace-sidebar-order",
        reuse: process.env.OPENWORK_EVAL_DAYTONA_SANDBOX?.trim(),
        log: (line) => console.error(`[openwork/testkit] ${line}`),
      })
    : null;
  const host = provisioned ? daytonaSandbox(provisioned.sandbox) : localHost();

  try {
    let seededWorkspaceIds: string[] = [];
    {
      await using seededApp = await desktop({ name: "workspace-order-seed", host, profileDir });
      seededWorkspaceIds = await seedWorkspaces(seededApp, profileDir);
    }

    await using desktopApp = await desktop({ name: "workspace-sidebar-order", host, profileDir });
    const initialOrder = await eventually(() => sidebarOrder(desktopApp), {
      within: 90_000,
      intervalMs: 250,
      label: "seeded workspace sidebar",
      until: (order) => order.length === seededWorkspaceIds.length,
    });
    expect(new Set(initialOrder)).toEqual(new Set(seededWorkspaceIds));
    expect(await storedOrder(desktopApp)).toEqual(initialOrder);

    const nestedWorkspaceButtons = await evalIn(
      desktopApp,
      `document.querySelectorAll("[data-sidebar-workspace-id] button button").length`,
    );
    expect(nestedWorkspaceButtons).toBe(0);
    evidence.recordAssertionEvidence(
      "Workspace controls use valid, non-nested buttons",
      `All ${initialOrder.length} workspace rows rendered without one button containing another button.`,
      true,
    );

    const initialServerOrder = await listServerWorkspaces(desktopApp);
    const activatedWorkspaceId = initialOrder.find((id) => id !== initialServerOrder.activeId)
      ?? initialOrder[0];
    await go(desktopApp, `/workspace/${encodeURIComponent(activatedWorkspaceId)}/session`);
    const activeServerOrder = await eventually(() => listServerWorkspaces(desktopApp), {
      within: 90_000,
      intervalMs: 250,
      label: "server active workspace order",
      until: (listing) => listing.activeId === activatedWorkspaceId && listing.ids[0] === activatedWorkspaceId,
    });
    expect(activeServerOrder.ids[0]).toBe(activatedWorkspaceId);

    const afterActivationReload = await reloadAndReadSidebar(desktopApp, initialOrder.length);
    expect(afterActivationReload).toEqual(initialOrder);
    evidence.recordAssertionEvidence(
      "Selecting a workspace does not reshuffle the sidebar",
      `The server returned the active workspace first, while the sidebar retained ${JSON.stringify(initialOrder)} across reload.`,
      true,
    );

    const draggedWorkspaceId = afterActivationReload[0];
    const dragTargetId = afterActivationReload[afterActivationReload.length - 1];
    await dragWorkspaceAfter(desktopApp, draggedWorkspaceId, dragTargetId);
    const draggedOrder = await eventually(() => sidebarOrder(desktopApp), {
      within: 30_000,
      intervalMs: 100,
      label: "workspace drag reorder",
      until: (order) => order.length === afterActivationReload.length
        && order[order.length - 1] === draggedWorkspaceId,
    });
    expect(draggedOrder).not.toEqual(afterActivationReload);
    expect(await storedOrder(desktopApp)).toEqual(draggedOrder);
    expect(await reloadAndReadSidebar(desktopApp, draggedOrder.length)).toEqual(draggedOrder);
    evidence.recordAssertionEvidence(
      "Dragging a workspace changes and persists its position",
      `The drag changed the sidebar to ${JSON.stringify(draggedOrder)}, local storage matched it, and reload preserved it.`,
      true,
    );

    const newWorkspaceId = await createWorkspace(desktopApp, `${profileDir}/delta`);
    const withNewWorkspace = await eventually(() => sidebarOrder(desktopApp), {
      within: 90_000,
      intervalMs: 250,
      label: "new workspace appended to saved order",
      until: (order) => order.length === draggedOrder.length + 1 && order.includes(newWorkspaceId),
    });
    expect(withNewWorkspace.slice(0, -1)).toEqual(draggedOrder);
    expect(withNewWorkspace[withNewWorkspace.length - 1]).toBe(newWorkspaceId);
    evidence.recordAssertionEvidence(
      "A newly discovered workspace is appended without disturbing the saved order",
      `The existing order stayed ${JSON.stringify(draggedOrder)} and the new workspace was appended.`,
      true,
    );
  } finally {
    try {
      await host[Symbol.asyncDispose]();
    } finally {
      if (provisioned) {
        try {
          await checkedExec(
            defaultDaytonaExec,
            ["exec", provisioned.sandbox, "--", "rm", "-rf", profileDir],
            `remove caller-owned workspace-order profile ${profileDir}`,
            { timeoutMs: 30_000 },
          );
        } finally {
          if (provisioned.created) await deleteSandboxes([provisioned.sandbox]);
        }
      } else {
        await rm(profileDir, { recursive: true, force: true });
      }
    }
  }
});
