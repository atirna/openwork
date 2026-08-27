import { expect } from "vitest";
import { test } from "@openwork/testkit";

import { mapRouteWorkspaceLoads } from "../../apps/app/src/react-app/shell/route-refresh-control";

test("workspace session hydration stays within its request budget", async ({ evidence }) => {
  let active = 0;
  let peak = 0;
  const release: Array<() => void> = [];
  const workspaces = Array.from({ length: 20 }, (_, index) => index);

  const resultPromise = mapRouteWorkspaceLoads(workspaces, async (workspace) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => release.push(resolve));
    active -= 1;
    return workspace;
  });

  for (let offset = 0; offset < workspaces.length; offset += 4) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(active).toBe(Math.min(4, workspaces.length - offset));
    release.splice(0).forEach((resolve) => resolve());
  }

  expect(await resultPromise).toEqual(workspaces);
  expect(peak).toBe(4);
  evidence.recordAssertionEvidence(
    "Session hydration cannot fan out across every workspace at once",
    `Twenty workspace reads completed in order with peak concurrency ${peak}.`,
    peak === 4,
  );
});
