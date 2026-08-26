import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { createDenTypeId } from "../../ee/packages/utils/src/typeid.js";
import type {
  DaytonaProvisioningRuntime,
  DaytonaSandboxRuntime,
} from "../../ee/apps/den-api/src/workers/daytona.js";

type ReconcilerModule = typeof import("../../ee/apps/den-api/src/workers/reconciler.js");
type DaytonaModule = typeof import("../../ee/apps/den-api/src/workers/daytona.js");
type ReconcileOptions = NonNullable<Parameters<ReconcilerModule["reconcileStaleProvisioningWorkers"]>[0]>;
type ReconcileStore = NonNullable<ReconcileOptions["store"]>;
type ReconcileWorker = Awaited<ReturnType<ReconcileStore["listStaleWorkers"]>>[number];
type ReconcileToken = Awaited<ReturnType<ReconcileStore["getActiveTokens"]>>[number];
type ContinueProvisioning = NonNullable<ReconcileOptions["continueProvisioning"]>;
type ProvisionInput = Parameters<DaytonaModule["provisionWorkerOnDaytonaWithRuntime"]>[0];

function seedRequiredEnv() {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test";
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32);
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32);
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790";
  process.env.CORS_ORIGINS ??= "http://127.0.0.1:8790";
  process.env.PROVISIONER_MODE = "stub";
  process.env.DAYTONA_API_KEY = "daytona-test-key";
  process.env.DAYTONA_WORKER_PROXY_BASE_URL = "https://workers.example.test";
  process.env.DAYTONA_SNAPSHOT = "openwork-test-snapshot";
}

function makeWorker(updatedAt: Date): ReconcileWorker {
  return {
    id: createDenTypeId("worker"),
    org_id: createDenTypeId("org"),
    created_by_user_id: createDenTypeId("user"),
    name: "Cloud",
    description: null,
    destination: "cloud",
    status: "provisioning",
    image_version: null,
    workspace_path: null,
    sandbox_backend: "daytona",
    last_heartbeat_at: null,
    last_active_at: null,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

function makeTokens(workerId: ReconcileWorker["id"]): ReconcileToken[] {
  const scopes: ReconcileToken["scope"][] = ["host", "client", "activity"];
  return scopes.map((scope) => ({
    id: createDenTypeId("workerToken"),
    worker_id: workerId,
    scope,
    token: `${scope}-token`,
    created_at: new Date("2026-08-26T10:00:00.000Z"),
    revoked_at: null,
  }));
}

function namedError(name: string, message: string) {
  const error = new Error(message);
  error.name = name;
  return error;
}

function makeDaytonaRuntime(lookupName: string, visibleAtLookup: number | null) {
  let lookupCount = 0;
  let createCount = 0;
  let persistedCount = 0;
  const sandbox = {
    id: "sbx_late_visible",
    state: "started",
    target: "us-test",
    async refreshData() {},
    async start() {},
    async delete() {},
    async getSignedPreviewUrl() {
      return { url: "https://late-visible.preview.example.test" };
    },
    process: {
      async createSession() {},
      async executeSessionCommand() {
        return { cmdId: "cmd_1" };
      },
      async getSessionCommand() {
        return { exitCode: null };
      },
      async getSessionCommandLogs() {
        return { stdout: "", stderr: "" };
      },
    },
  } satisfies DaytonaSandboxRuntime;
  const runtime = {
    async getVolume() {
      return { id: "vol_shared", state: "ready" };
    },
    async getSandbox(name: string) {
      if (name === lookupName) {
        lookupCount += 1;
        if (visibleAtLookup !== null && lookupCount >= visibleAtLookup) return sandbox;
      }
      throw namedError("DaytonaNotFoundError", `sandbox ${name} not found`);
    },
    async createSandbox() {
      createCount += 1;
      throw namedError("DaytonaConflictError", "Sandbox with name already exists");
    },
    async upsertSandbox() {
      persistedCount += 1;
    },
    async checkpointExists() {
      return false;
    },
    async verifyRestoreMarker() {
      return false;
    },
    async waitForHealth() {},
  } satisfies DaytonaProvisioningRuntime;

  return {
    runtime,
    get lookupCount() {
      return lookupCount;
    },
    get createCount() {
      return createCount;
    },
    get persistedCount() {
      return persistedCount;
    },
  };
}

test("cloud provisioning remains single-owner and survives Daytona read-after-write lag", async ({ evidence }) => {
  seedRequiredEnv();
  const [reconciler, daytona] = await Promise.all([
    import("../../ee/apps/den-api/src/workers/reconciler.js"),
    import("../../ee/apps/den-api/src/workers/daytona.js"),
  ]);

  const staleWorker = makeWorker(new Date("2026-08-26T10:00:00.000Z"));
  const tokens = makeTokens(staleWorker.id);
  const claimedAt = new Date("2026-08-26T10:30:00.000Z");
  let durableUpdatedAt = staleWorker.updated_at;
  let claimCount = 0;
  let provisionAttempts = 0;
  const store: ReconcileStore = {
    async listStaleWorkers() {
      return [{ ...staleWorker }];
    },
    async claimWorker(input) {
      if (durableUpdatedAt.getTime() !== input.worker.updated_at.getTime()) return false;
      durableUpdatedAt = input.claimedAt;
      claimCount += 1;
      return true;
    },
    async getActiveTokens() {
      return tokens;
    },
    async markFailed() {
      throw new Error("claimed worker unexpectedly failed");
    },
  };
  const continueProvisioning: ContinueProvisioning = async () => {
    provisionAttempts += 1;
  };

  await Promise.all([
    reconciler.reconcileStaleProvisioningWorkers({ store, continueProvisioning, now: claimedAt }),
    reconciler.reconcileStaleProvisioningWorkers({ store, continueProvisioning, now: claimedAt }),
  ]);

  expect(claimCount).toBe(1);
  expect(provisionAttempts).toBe(1);
  expect(durableUpdatedAt).toEqual(claimedAt);
  evidence.recordAssertionEvidence(
    "Concurrent stale-worker reconciliation has one durable owner",
    "Both reconcilers selected the same stale worker, but the atomic claim admitted exactly one provisioning attempt.",
    true,
  );

  const provisionInput: ProvisionInput = {
    workerId: createDenTypeId("worker"),
    name: "Cloud",
    hostToken: "host-token",
    clientToken: "client-token",
    activityToken: "activity-token",
  };
  const sandboxName = daytona.currentDaytonaSandboxName(provisionInput);
  const lateVisible = makeDaytonaRuntime(sandboxName, 7);
  let lateVisibleWaitMs = 0;
  const provisioned = await daytona.provisionWorkerOnDaytonaWithRuntime(provisionInput, lateVisible.runtime, {
    sleep: async (ms) => {
      lateVisibleWaitMs += ms;
    },
  });

  expect(provisioned.status).toBe("healthy");
  expect(lateVisible.createCount).toBe(1);
  expect(lateVisible.lookupCount).toBe(7);
  expect(lateVisibleWaitMs).toBe(10_000);
  expect(lateVisible.persistedCount).toBe(1);

  const permanentlyMissing = makeDaytonaRuntime(sandboxName, null);
  let missingWaitMs = 0;
  await expect(daytona.provisionWorkerOnDaytonaWithRuntime(provisionInput, permanentlyMissing.runtime, {
    sleep: async (ms) => {
      missingWaitMs += ms;
    },
  })).rejects.toThrow("Sandbox with name already exists");

  expect(permanentlyMissing.createCount).toBe(1);
  expect(permanentlyMissing.lookupCount).toBe(7);
  expect(missingWaitMs).toBe(10_000);
  expect(permanentlyMissing.persistedCount).toBe(0);
  evidence.recordAssertionEvidence(
    "Daytona read-after-write lag is retried but bounded",
    "A sandbox hidden through the observed 10-second window became healthy and persisted; a sandbox still missing after the same bounded grace rejected without persistence.",
    true,
  );
});
