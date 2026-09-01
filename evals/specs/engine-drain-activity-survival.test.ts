import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { briefTest, claim, testBrief } from "@openwork/testkit";
import { EnginePool } from "../../apps/server/src/engine-pool";
import type { ManagedOpencodeServer } from "../../apps/server/src/managed-opencode";
import type { ServerConfig, WorkspaceInfo } from "../../apps/server/src/types";

/**
 * The engine rollover pool keeps a superseded engine generation alive only
 * while it drains, and historically force-aborted every remaining session at
 * a fixed deadline — killing runs that were still actively streaming. The
 * drain grace period must bound inactivity, not total drain time: an engine
 * event naming an owned session pushes the deadline out, while a non-idle
 * session that reports nothing for the whole window is still reaped.
 * apps/server/src/engine-pool.test.ts drives the same loop through spawned
 * fake engine processes; this spec proves the policy app-lessly.
 */

const ENV = {
  OPENWORK_ENGINE_DRAIN_TIMEOUT_MS: "300",
  OPENWORK_ENGINE_DRAIN_POLL_MS: "100",
  OPENWORK_ENGINE_ABORT_SETTLE_MS: "50",
  OPENWORK_ENGINE_MIN_SPAWN_INTERVAL_MS: "0",
};

type FakeEngine = {
  handle: ManagedOpencodeServer;
  aborted: string[];
  setBusy: (sessionIds: string[]) => void;
  emit: (sessionId: string) => void;
  globalEventSubscriptions: () => number;
  instanceEventSubscriptions: () => number;
  isClosed: () => boolean;
  stop: () => Promise<void>;
};

async function startFakeEngine(): Promise<FakeEngine> {
  const busy = new Set<string>();
  const aborted: string[] = [];
  const eventClients = new Set<ServerResponse>();
  let globalEventSubscriptions = 0;
  let instanceEventSubscriptions = 0;
  let closed = false;

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/session/status") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(Object.fromEntries([...busy].map((id) => [id, { type: "busy" }]))));
      return;
    }
    if (url.pathname === "/global/event") {
      globalEventSubscriptions += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      eventClients.add(response);
      request.on("close", () => eventClients.delete(response));
      return;
    }
    if (url.pathname === "/event") {
      instanceEventSubscriptions += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      return;
    }
    const abortMatch = url.pathname.match(/^\/session\/([^/]+)\/abort$/);
    if (abortMatch && request.method === "POST") {
      aborted.push(decodeURIComponent(abortMatch[1] ?? ""));
      response.setHeader("content-type", "application/json");
      response.end("{}");
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake engine failed to bind a port");
  const url = `http://127.0.0.1:${address.port}`;

  const stop = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const client of eventClients) client.end();
    eventClients.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return {
    handle: {
      url,
      username: "engine",
      password: "engine-password",
      pid: null,
      execution: { command: "fake-engine", args: [], cwd: "/", env: [] },
      isAlive: () => !closed,
      close: stop,
    },
    aborted,
    globalEventSubscriptions: () => globalEventSubscriptions,
    instanceEventSubscriptions: () => instanceEventSubscriptions,
    setBusy: (sessionIds) => {
      busy.clear();
      for (const id of sessionIds) busy.add(id);
    },
    emit: (sessionId) => {
      const frame = `data: ${JSON.stringify({
        directory: "/workspace",
        payload: { type: "session.updated", properties: { sessionID: sessionId } },
      })}\n\n`;
      for (const client of eventClients) client.write(frame);
    },
    isClosed: () => closed,
    stop,
  };
}

type Scenario = {
  pool: EnginePool;
  old: FakeEngine;
  next: FakeEngine;
  workspace: WorkspaceInfo;
  rollover: () => Promise<{ action: string }>;
  dispose: () => Promise<void>;
};

async function startScenario(root: string, name: string, workspaceCount = 1): Promise<Scenario> {
  const old = await startFakeEngine();
  const next = await startFakeEngine();
  const runtimeConfigPath = join(root, `${name}-runtime-config.json`);
  await writeFile(runtimeConfigPath, JSON.stringify({ scenario: name }));

  const workspaces = Array.from({ length: workspaceCount }, (_, index): WorkspaceInfo => ({
    id: `ws_${name}_${index}`,
    name: `Drain ${name} ${index}`,
    path: join(root, `${name}-${index}`),
    preset: "starter",
    workspaceType: "local",
    baseUrl: old.handle.url,
  }));
  const workspace = workspaces[0];
  if (!workspace) throw new Error("a drain scenario needs at least one workspace");
  const config = {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    configPath: join(root, `${name}-server.json`),
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces,
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
    opencodeBaseUrl: old.handle.url,
  } as ServerConfig;

  const pool = new EnginePool({
    config,
    template: {
      cwd: root,
      runtimeConfigPath,
      env: {},
      reservedPorts: () => [],
    },
    hooks: {
      reloadInPlace: async () => undefined,
      engineBusy: async () => true,
      postRefreshSync: async () => undefined,
      writeRuntimeConfigFile: async () => ({ path: runtimeConfigPath }),
      registerTrusted: () => undefined,
      clearTrusted: () => undefined,
      spawn: async () => next.handle,
      waitForHealthy: async () => undefined,
    },
  });
  pool.adoptPrimary({
    handle: old.handle,
    fingerprint: "superseded-config",
    registryId: null,
    trustedIdentity: null,
  });

  return {
    pool,
    old,
    next,
    workspace,
    rollover: () => pool.requestRollover({ reason: `${name}_config_changed`, workspace }),
    dispose: async () => {
      await pool.disposeAll().catch(() => undefined);
      await old.stop();
      await next.stop();
    },
  };
}

function sleep(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

briefTest(testBrief({
  behavior: "A draining engine generation never aborts a session that is actively making progress; the drain grace period bounds inactivity instead of total drain time.",
  claims: {
    activeRunSurvival: claim("a session that keeps emitting engine events survives a drain lasting several full grace periods", {
      never: "abort an actively streaming session because a rollover started a drain clock",
    }),
    cleanRetire: claim("once the surviving session finishes, the drained engine closes without any abort", {
      never: "leak the drained engine process or abort a run that already completed",
    }),
    inactivityBound: claim("a non-idle session that emits nothing for the whole grace period is aborted and its generation force-retired", {
      never: "keep a wedged generation alive indefinitely once activity stops",
    }),
    boundedActivityWatch: claim("one global engine event subscription covers activity across 32 local workspaces", {
      never: "open one event subscription per workspace and multiply engine event queues",
    }),
  },
}), async ({ prove }) => {
  const savedEnv = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(ENV)) {
    savedEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  const root = await mkdtemp(join(tmpdir(), "openwork-drain-activity-"));
  const scenarios: Scenario[] = [];
  try {
    // activeRunSurvival + cleanRetire — one continuously streaming session.
    const streaming = await startScenario(root, "streaming", 32);
    scenarios.push(streaming);
    streaming.old.setBusy(["ses_streaming"]);
    const streamingRollover = await streaming.rollover();
    const heartbeat = setInterval(() => streaming.old.emit("ses_streaming"), 50);
    await sleep(1_200);
    const survivedFourGracePeriods = !streaming.old.isClosed() && streaming.old.aborted.length === 0;
    prove.activeRunSurvival(
      streamingRollover.action === "rolled_over" && survivedFourGracePeriods,
      `Rollover ${streamingRollover.action}; after 1200ms of streaming against a 300ms grace period the draining engine was ${streaming.old.isClosed() ? "closed" : "alive"} with ${streaming.old.aborted.length} aborts.`,
    );
    prove.boundedActivityWatch(
      streaming.old.globalEventSubscriptions() === 1 && streaming.old.instanceEventSubscriptions() === 0,
      `Across 32 local workspaces the draining generation opened ${streaming.old.globalEventSubscriptions()} global and ${streaming.old.instanceEventSubscriptions()} instance event subscriptions.`,
    );

    clearInterval(heartbeat);
    streaming.old.setBusy([]);
    const retiredCleanly = await waitUntil(() => streaming.old.isClosed(), 5_000);
    prove.cleanRetire(
      retiredCleanly && streaming.old.aborted.length === 0,
      `After the session idled, the drained engine closed=${retiredCleanly} with ${streaming.old.aborted.length} aborts.`,
    );

    // inactivityBound — busy status forever, but zero events.
    const wedged = await startScenario(root, "wedged");
    scenarios.push(wedged);
    wedged.old.setBusy(["ses_wedged"]);
    const wedgedRollover = await wedged.rollover();
    const reaped = await waitUntil(() => wedged.old.isClosed() && wedged.old.aborted.includes("ses_wedged"), 5_000);
    prove.inactivityBound(
      wedgedRollover.action === "rolled_over" && reaped,
      `Rollover ${wedgedRollover.action}; the silent busy session was aborted (${wedged.old.aborted.join(",") || "none"}) and its engine closed=${wedged.old.isClosed()}.`,
    );
  } finally {
    for (const scenario of scenarios) await scenario.dispose();
    await rm(root, { recursive: true, force: true });
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
