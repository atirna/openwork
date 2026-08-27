import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  createDaytonaK3sCluster,
  createPlacement,
  needs,
  provisionDaytonaK3sSandbox,
  test,
} from "@openwork/testkit";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("an exclusively owned Daytona sandbox boots the pinned k3s provider", { timeout: 600_000 }, async ({ evidence }) => {
  needs({
    daytona: true,
    optIn: ["OPENWORK_EVAL_DAYTONA_K3S_LIVE"],
    commands: ["daytona"],
  });
  const sandboxName = `openwork-k3s-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const placement = createPlacement({
    id: "live-k3s",
    provider: "daytona-k3s",
    privileged: true,
    resources: { cpu: 4, memoryGb: 8, diskGb: 10 },
  });

  const ownership = await provisionDaytonaK3sSandbox({ name: sandboxName, snapshot: "daytona-large" });
  await using cluster = await createDaytonaK3sCluster({ placement, ownership });
  const listed = await cluster.kubectl(["get", "nodes", "-o", "json"]);
  const payload: unknown = JSON.parse(listed.stdout);
  const items = isRecord(payload) && Array.isArray(payload.items) ? payload.items : [];
  const ready = items.some((item) => {
    if (!isRecord(item) || !isRecord(item.status) || !Array.isArray(item.status.conditions)) return false;
    return item.status.conditions.some((condition) =>
      isRecord(condition) && condition.type === "Ready" && condition.status === "True"
    );
  });
  assert.equal(listed.code, 0);
  assert.equal(items.length, 1);
  assert.equal(ready, true);
  evidence.recordAssertionEvidence(
    "A dedicated Daytona sandbox runs the pinned k3s binary and reports one Ready node",
    `k3s ${cluster.version} returned ${items.length} node with Ready=${ready}; disposal deletes the privately provisioned, auto-delete-on-stop sandbox ${sandboxName}.`,
    listed.code === 0 && items.length === 1 && ready,
  );
});
