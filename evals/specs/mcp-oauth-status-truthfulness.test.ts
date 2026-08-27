import { expect } from "vitest";
import { test } from "@openwork/testkit";
import type { McpServerEntry } from "../../apps/app/src/app/types";
import {
  createMcpStatusSynchronizer,
  resolveObservedMcpStatus,
} from "../../apps/app/src/react-app/domains/connections/mcp-status-synchronization";

function server(input?: Partial<McpServerEntry>): McpServerEntry {
  return {
    id: "cloud-mcp",
    name: "cloud-mcp",
    config: { type: "remote", url: "https://cloud.example/mcp", enabled: true },
    ...input,
  };
}

test("extension connectivity reflects verified engine state, not OAuth optimism", ({ evidence }) => {
  const workspace = "web:workspace-a";
  const entry = server();

  // Claim: a verified OAuth completion survives the engine's eventually
  // consistent snapshot — delayed, missing, and differently keyed statuses —
  // until the engine converges to connected.
  const sync = createMcpStatusSynchronizer();
  sync.recordAuthenticated(workspace, "cloud-mcp");
  const delayed = sync.project(sync.beginRefresh(workspace), {
    "cloud-mcp": { status: "disconnected" },
  }, [entry]);
  const missing = sync.project(sync.beginRefresh(workspace), {}, [entry]);
  const keyedDifferently = sync.project(sync.beginRefresh(workspace), {
    "Cloud MCP": { status: "connected" },
  }, [entry]);
  expect(delayed?.[entry.name]).toEqual({ status: "connected" });
  expect(missing?.[entry.name]).toEqual({ status: "connected" });
  expect(keyedDifferently?.[entry.name]).toEqual({ status: "connected" });
  expect(sync.isPending(workspace, entry.name)).toBe(false);

  // Negative half 1: without a verified OAuth completion, a disconnected or
  // missing engine status never renders as connected.
  const unverified = createMcpStatusSynchronizer();
  expect(unverified.project(unverified.beginRefresh(workspace), {
    [entry.name]: { status: "disconnected" },
  }, [entry])).toEqual({});
  expect(unverified.project(unverified.beginRefresh(workspace), {}, [entry])).toEqual({});

  // Negative half 2: an out-of-order concurrent refresh from an older
  // snapshot is rejected outright and cannot overwrite the newer result.
  const raced = createMcpStatusSynchronizer();
  const stale = raced.beginRefresh(workspace);
  const latest = raced.beginRefresh(workspace);
  expect(raced.project(latest, { [entry.name]: { status: "connected" } }, [entry])).toEqual({
    [entry.name]: { status: "connected" },
  });
  expect(raced.project(stale, { [entry.name]: { status: "disconnected" } }, [entry])).toBeNull();

  // Negative half 3: a real terminal engine verdict (reauthentication
  // required, failure, registration required) immediately overrides the
  // verified-success grace — the UI never lies about a broken connection.
  const terminal = createMcpStatusSynchronizer();
  terminal.recordAuthenticated(workspace, entry.name);
  const failed = terminal.project(terminal.beginRefresh(workspace), {
    [entry.name]: { status: "needs_auth" },
  }, [entry]);
  expect(failed?.[entry.name]).toEqual({ status: "needs_auth" });
  expect(terminal.isPending(workspace, entry.name)).toBe(false);

  // Negative half 4: logout/workspace identity switches drop the grace; a
  // foreign workspace never inherits another workspace's green status.
  const scoped = createMcpStatusSynchronizer();
  scoped.recordAuthenticated(workspace, entry.name);
  expect(scoped.project(scoped.beginRefresh("web:workspace-b"), {}, [entry])).toEqual({});

  // Negative half 5: the grace is bounded — if the engine never confirms,
  // the optimistic state expires instead of lying forever.
  const bounded = createMcpStatusSynchronizer({ maxPendingRefreshes: 2 });
  bounded.recordAuthenticated(workspace, entry.name);
  expect(bounded.project(bounded.beginRefresh(workspace), {}, [entry])?.[entry.name]).toEqual({
    status: "connected",
  });
  expect(bounded.project(bounded.beginRefresh(workspace), {}, [entry])?.[entry.name]).toBeUndefined();
  expect(bounded.isPending(workspace, entry.name)).toBe(false);

  // Identity resolution stays conservative: ambiguous normalized collisions
  // resolve to nothing rather than borrowing a foreign server's status.
  expect(resolveObservedMcpStatus({
    "cloud mcp": { status: "connected" },
    "cloud_mcp": { status: "failed", error: "foreign collision" },
  }, server({ id: "cloud-mcp", name: "Cloud MCP" }))).toBeUndefined();

  evidence.recordAssertionEvidence(
    "Extension connectivity is truthful",
    "Verified OAuth success survives delayed and differently keyed engine snapshots until convergence; unverified, stale, terminal, foreign-workspace, and expired states can never render as connected.",
    true,
  );
});
