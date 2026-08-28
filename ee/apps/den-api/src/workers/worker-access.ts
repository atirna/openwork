import { and, asc, eq, inArray, isNull } from "@openwork-ee/den-db/drizzle"
import { WorkerTable, WorkerTokenTable } from "@openwork-ee/den-db/schema"
import type { DenTypeId } from "@openwork-ee/utils/typeid"
import { db } from "../db.js"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
import { CLOUD_INSTANCE_BACKEND } from "./cloud-constants.js"
import {
  getDaytonaSandboxRecord,
  inspectDaytonaSandbox,
  refreshDaytonaSignedPreview,
} from "./daytona.js"
import { recoverClaimedCloudWorker, wakeCloudWorker } from "./cloud-lifecycle.js"
import { fetchWithConnectRetry, previewFetch } from "./preview-fetch.js"

export type CloudRuntimeWorker = Pick<typeof WorkerTable.$inferSelect, "id" | "name" | "status"> & {
  image_version?: typeof WorkerTable.$inferSelect.image_version
}
export type CloudRuntimeToken = Pick<typeof WorkerTokenTable.$inferSelect, "scope" | "token">
export type CloudRuntimeSandboxRecord = Pick<
  NonNullable<Awaited<ReturnType<typeof getDaytonaSandboxRecord>>>,
  "signed_preview_url" | "signed_preview_url_expires_at"
> & { sandbox_id?: string | null }
export type CloudRuntimeSandboxInspection = { state: string | null } | null
export type CloudRuntimeStore = {
  claimFailedWorker: (workerId: CloudRuntimeWorker["id"]) => Promise<boolean>
  claimRecycleWorker: (workerId: CloudRuntimeWorker["id"]) => Promise<boolean>
  getActiveTokens: (workerId: CloudRuntimeWorker["id"]) => Promise<CloudRuntimeToken[]>
  markProvisioningWorkerFailed: (workerId: CloudRuntimeWorker["id"]) => Promise<void>
  markHealthyWorkerFailed: (workerId: CloudRuntimeWorker["id"]) => Promise<void>
}

type OrganizationId = typeof WorkerTable.$inferSelect.org_id
type UserId = NonNullable<typeof WorkerTable.$inferSelect.created_by_user_id>
type WorkerId = typeof WorkerTable.$inferSelect.id
type ContinueProvisioning = (input: {
  workerId: WorkerId
  orgId?: OrganizationId
  name: string
  hostToken: string
  clientToken: string
  activityToken: string
}) => Promise<void>
type GetSandboxRecord = (workerId: WorkerId) => Promise<CloudRuntimeSandboxRecord | null>
type InspectSandbox = (workerId: WorkerId) => Promise<CloudRuntimeSandboxInspection>
type RefreshSignedPreview = (workerId: WorkerId) => Promise<CloudRuntimeSandboxRecord | null>
type ProbeSignedPreview = (signedPreviewUrl: string) => Promise<boolean>
type StartWake = (workerId: WorkerId) => void

export type CloudRuntimeOwnership =
  | { organizationId: OrganizationId; userId: UserId }
  | { organizationId: OrganizationId; workerId: WorkerId }

export type CloudRuntimeState =
  | { status: "ready"; url: string; expiresAt: Date }
  | { status: "waking"; url: null; reason?: "stopped" | "recovering" | "reprovisioning" | "unreachable" }
  | { status: "provisioning"; url: null; reason?: "unreachable" }
  | { status: "failed"; url: null; reason?: "missing_tokens" | "unreachable" | "preview_expired" }

export type CloudWorkerAccess = {
  url: string
  expiresAt: Date
  clientToken: string
  hostToken: string
  workerId: DenTypeId<"worker">
}

export type CloudRuntimeAccessResult =
  | ({ status: "ready" } & CloudWorkerAccess)
  | { status: "waking"; workerId: WorkerId; reason?: "stopped" | "recovering" | "reprovisioning" | "unreachable" }
  | { status: "provisioning"; workerId: WorkerId; reason?: "unreachable" }
  | { status: "failed"; workerId: WorkerId; reason?: "missing_tokens" | "unreachable" | "preview_expired" }
  | { status: "missing" }

export type ResolveCloudRuntimeStateOptions = {
  continueProvisioning: ContinueProvisioning
  refreshSignedPreview: RefreshSignedPreview
  getSandboxRecord: GetSandboxRecord
  inspectSandbox: InspectSandbox
  probeSignedPreview: ProbeSignedPreview
  startWake: StartWake
  startRecovery: StartWake
  store: CloudRuntimeStore
  now: () => number
}

export type ResolveCloudRuntimeAccessOptions = Partial<ResolveCloudRuntimeStateOptions> & {
  loadWorker?: (ownership: CloudRuntimeOwnership) => Promise<CloudRuntimeWorker | null>
}

type UpdateResultRecord = {
  rowsAffected?: unknown
  affectedRows?: unknown
}

const logger = appLogger.child({ component: "cloud_runtime_access" })
const failedHealCooldownMs = 60_000
const signedPreviewProbeTimeoutMs = 2_500
const signedPreviewHealthCacheMs = 15_000
const failedHealAttempts = new Map<WorkerId, number>()
const signedPreviewHealthCache = new Map<WorkerId, { url: string; healthyUntilMs: number }>()
const wakingWorkers = new Set<WorkerId>()
const unreachableWorkers = new Set<WorkerId>()

function isUpdateResultRecord(value: unknown): value is UpdateResultRecord {
  return typeof value === "object" && value !== null
}

function changedRows(result: unknown): number | null {
  if (Array.isArray(result)) {
    for (const value of result) {
      const nestedRows = changedRows(value)
      if (nestedRows !== null) return nestedRows
    }
    return null
  }
  if (!isUpdateResultRecord(result)) return null
  if (typeof result.rowsAffected === "number") return result.rowsAffected
  if (typeof result.affectedRows === "number") return result.affectedRows
  return null
}

const databaseCloudRuntimeStore: CloudRuntimeStore = {
  async claimFailedWorker(workerId) {
    const result: unknown = await db.update(WorkerTable).set({ status: "provisioning" }).where(and(
      eq(WorkerTable.id, workerId),
      eq(WorkerTable.status, "failed"),
    ))
    const rows = changedRows(result)
    return rows !== null && rows > 0
  },
  async claimRecycleWorker(workerId) {
    const result: unknown = await db.update(WorkerTable).set({ status: "provisioning" }).where(and(
      eq(WorkerTable.id, workerId),
      inArray(WorkerTable.status, ["healthy", "stopped"]),
    ))
    const rows = changedRows(result)
    return rows !== null && rows > 0
  },
  async getActiveTokens(workerId) {
    return db.select({ scope: WorkerTokenTable.scope, token: WorkerTokenTable.token })
      .from(WorkerTokenTable)
      .where(and(eq(WorkerTokenTable.worker_id, workerId), isNull(WorkerTokenTable.revoked_at)))
      .orderBy(asc(WorkerTokenTable.created_at))
  },
  async markProvisioningWorkerFailed(workerId) {
    await db.update(WorkerTable).set({ status: "failed" }).where(and(
      eq(WorkerTable.id, workerId),
      eq(WorkerTable.status, "provisioning"),
    ))
  },
  async markHealthyWorkerFailed(workerId) {
    await db.update(WorkerTable).set({ status: "failed" }).where(and(
      eq(WorkerTable.id, workerId),
      eq(WorkerTable.status, "healthy"),
    ))
  },
}

async function loadOwnedCloudWorker(ownership: CloudRuntimeOwnership) {
  const ownershipPredicate = "userId" in ownership
    ? eq(WorkerTable.created_by_user_id, ownership.userId)
    : eq(WorkerTable.id, ownership.workerId)
  const rows = await db.select({
    id: WorkerTable.id,
    name: WorkerTable.name,
    status: WorkerTable.status,
    image_version: WorkerTable.image_version,
  }).from(WorkerTable).where(and(
    eq(WorkerTable.org_id, ownership.organizationId),
    ownershipPredicate,
    eq(WorkerTable.destination, "cloud"),
    eq(WorkerTable.sandbox_backend, CLOUD_INSTANCE_BACKEND),
  )).orderBy(asc(WorkerTable.created_at), asc(WorkerTable.id)).limit(1)
  return rows[0] ?? null
}

function tokenByScope(tokens: CloudRuntimeToken[], scope: CloudRuntimeToken["scope"]) {
  return tokens.find((entry) => entry.scope === scope)?.token ?? null
}

function healthUrlForPreview(signedPreviewUrl: string) {
  return `${signedPreviewUrl.replace(/\/+$/, "")}/health`
}

export async function probeCloudRuntimeSignedPreview(signedPreviewUrl: string) {
  try {
    const response = await fetchWithConnectRetry({
      fetchImpl: previewFetch(),
      url: healthUrlForPreview(signedPreviewUrl),
      init: {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(signedPreviewProbeTimeoutMs),
      },
    })
    return response.ok
  } catch {
    return false
  }
}

async function defaultContinueProvisioning(input: Parameters<ContinueProvisioning>[0]) {
  const { continueCloudProvisioning } = await import("../routes/workers/shared.js")
  return continueCloudProvisioning(input)
}

function startDefaultWake(workerId: WorkerId) {
  if (wakingWorkers.has(workerId)) return
  wakingWorkers.add(workerId)
  void wakeCloudWorker(workerId).catch(() => undefined).finally(() => wakingWorkers.delete(workerId))
}

function startDefaultRecovery(workerId: WorkerId) {
  if (wakingWorkers.has(workerId)) return
  wakingWorkers.add(workerId)
  void recoverClaimedCloudWorker(workerId).catch(() => undefined).finally(() => wakingWorkers.delete(workerId))
}

function cachedPreviewIsHealthy(workerId: WorkerId, url: string, now: number) {
  const cached = signedPreviewHealthCache.get(workerId)
  return cached?.url === url && cached.healthyUntilMs > now
}

function rememberHealthyPreview(workerId: WorkerId, url: string, now: number, expiresAtMs: number) {
  signedPreviewHealthCache.set(workerId, {
    url,
    healthyUntilMs: Math.min(now + signedPreviewHealthCacheMs, expiresAtMs),
  })
}

async function startFailedCloudHeal(input: {
  worker: CloudRuntimeWorker
  orgId: OrganizationId
  continueProvisioning: ContinueProvisioning
  store: CloudRuntimeStore
}) {
  const claimed = await input.store.claimFailedWorker(input.worker.id)
  if (!claimed) return false

  void (async () => {
    const tokens = await input.store.getActiveTokens(input.worker.id)
    const hostToken = tokenByScope(tokens, "host")
    const clientToken = tokenByScope(tokens, "client")
    const activityToken = tokenByScope(tokens, "activity")
    if (!hostToken || !clientToken || !activityToken) {
      await input.store.markProvisioningWorkerFailed(input.worker.id)
      logger.error("cloud failed-worker heal failed", { worker_id: input.worker.id, reason: "missing_worker_tokens" })
      return
    }
    await input.continueProvisioning({
      workerId: input.worker.id,
      orgId: input.orgId,
      name: input.worker.name,
      hostToken,
      clientToken,
      activityToken,
    })
  })().catch(async (error) => {
    await input.store.markProvisioningWorkerFailed(input.worker.id).catch(() => undefined)
    logger.error("cloud failed-worker heal failed", { worker_id: input.worker.id, error })
  })
  return true
}

async function resolveFailedCloudRuntime(input: {
  worker: CloudRuntimeWorker
  orgId: OrganizationId
  continueProvisioning: ContinueProvisioning
  getSandboxRecord: GetSandboxRecord
  startRecovery: StartWake
  store: CloudRuntimeStore
  now: () => number
}): Promise<CloudRuntimeState> {
  const now = input.now()
  const lastAttempt = failedHealAttempts.get(input.worker.id)
  if (lastAttempt !== undefined && now - lastAttempt < failedHealCooldownMs) {
    return { status: "failed", url: null }
  }
  failedHealAttempts.set(input.worker.id, now)
  const sandbox = await input.getSandboxRecord(input.worker.id)
  if (sandbox) {
    const claimed = await input.store.claimFailedWorker(input.worker.id)
    if (!claimed) return { status: "failed", url: null }
    input.startRecovery(input.worker.id)
    return { status: "waking", url: null, reason: "recovering" }
  }
  const started = await startFailedCloudHeal(input)
  return started ? { status: "provisioning", url: null } : { status: "failed", url: null }
}

async function readyFromSignedPreview(input: {
  workerId: WorkerId
  signedPreviewUrl: string
  expiresAt: Date
  probeSignedPreview: ProbeSignedPreview
  now: () => number
}): Promise<CloudRuntimeState | null> {
  const now = input.now()
  const expiresAtMs = input.expiresAt.getTime()
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return null
  if (cachedPreviewIsHealthy(input.workerId, input.signedPreviewUrl, now)) {
    return { status: "ready", url: input.signedPreviewUrl, expiresAt: input.expiresAt }
  }
  if (await input.probeSignedPreview(input.signedPreviewUrl)) {
    rememberHealthyPreview(input.workerId, input.signedPreviewUrl, now, expiresAtMs)
    return { status: "ready", url: input.signedPreviewUrl, expiresAt: input.expiresAt }
  }
  return null
}

async function refreshAndProbeSignedPreview(input: {
  workerId: WorkerId
  refreshSignedPreview: RefreshSignedPreview
  probeSignedPreview: ProbeSignedPreview
  now: () => number
}): Promise<CloudRuntimeState | null> {
  try {
    const refreshed = await input.refreshSignedPreview(input.workerId)
    if (!refreshed) return null
    const expiresAtMs = refreshed.signed_preview_url_expires_at.getTime()
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= input.now()) {
      return { status: "failed", url: null, reason: "preview_expired" }
    }
    return readyFromSignedPreview({
      workerId: input.workerId,
      signedPreviewUrl: refreshed.signed_preview_url,
      expiresAt: refreshed.signed_preview_url_expires_at,
      probeSignedPreview: input.probeSignedPreview,
      now: input.now,
    })
  } catch {
    return null
  }
}

function isStoppedSandboxState(state: string | null) {
  return state?.toLowerCase() === "stopped"
}

function workerNeedsSnapshotRecycle(worker: CloudRuntimeWorker) {
  const snapshot = env.daytona.snapshot
  return Boolean(snapshot && "image_version" in worker && worker.image_version !== snapshot)
}

async function startStaleStoppedRecycle(input: {
  worker: CloudRuntimeWorker
  sandboxExists: boolean
  inspectSandbox: InspectSandbox
  startRecovery: StartWake
  store: CloudRuntimeStore
}) {
  if (!input.sandboxExists || !workerNeedsSnapshotRecycle(input.worker)) return false
  let inspection: CloudRuntimeSandboxInspection = null
  try {
    inspection = await input.inspectSandbox(input.worker.id)
  } catch {
    return false
  }
  if (!isStoppedSandboxState(inspection?.state ?? null)) return false
  const claimed = await input.store.claimRecycleWorker(input.worker.id)
  if (claimed) input.startRecovery(input.worker.id)
  return true
}

async function recoverUnhealthyCloudSandbox(input: {
  worker: CloudRuntimeWorker
  orgId: OrganizationId
  continueProvisioning: ContinueProvisioning
  inspectSandbox: InspectSandbox
  startRecovery: StartWake
  store: CloudRuntimeStore
}): Promise<CloudRuntimeState> {
  let inspection: CloudRuntimeSandboxInspection = null
  try {
    inspection = await input.inspectSandbox(input.worker.id)
  } catch {
    inspection = null
  }
  if (isStoppedSandboxState(inspection?.state ?? null)) {
    unreachableWorkers.delete(input.worker.id)
    const claimed = await input.store.claimRecycleWorker(input.worker.id)
    if (claimed) input.startRecovery(input.worker.id)
    return { status: "waking", url: null, reason: "stopped" }
  }
  unreachableWorkers.add(input.worker.id)
  await input.store.markHealthyWorkerFailed(input.worker.id)
  await startFailedCloudHeal(input)
  return { status: "waking", url: null, reason: "unreachable" }
}

export async function resolveCloudRuntimeState(input: {
  worker: CloudRuntimeWorker
  organizationId: OrganizationId
}, options: ResolveCloudRuntimeStateOptions): Promise<CloudRuntimeState> {
  if (input.worker.status === "failed") {
    return resolveFailedCloudRuntime({
      worker: input.worker,
      orgId: input.organizationId,
      continueProvisioning: options.continueProvisioning,
      getSandboxRecord: options.getSandboxRecord,
      startRecovery: options.startRecovery,
      store: options.store,
      now: options.now,
    })
  }
  if (input.worker.status === "stopped") {
    unreachableWorkers.delete(input.worker.id)
    const sandbox = await options.getSandboxRecord(input.worker.id)
    if (await startStaleStoppedRecycle({
      worker: input.worker,
      sandboxExists: Boolean(sandbox),
      inspectSandbox: options.inspectSandbox,
      startRecovery: options.startRecovery,
      store: options.store,
    })) return { status: "waking", url: null, reason: "stopped" }
    options.startWake(input.worker.id)
    return { status: "waking", url: null, reason: "stopped" }
  }

  const sandbox = await options.getSandboxRecord(input.worker.id)
  if (input.worker.status === "provisioning" && sandbox) {
    return { status: "waking", url: null }
  }
  if (!sandbox) {
    if (input.worker.status === "healthy") {
      await options.store.markHealthyWorkerFailed(input.worker.id)
      await startFailedCloudHeal({
        worker: input.worker,
        orgId: input.organizationId,
        continueProvisioning: options.continueProvisioning,
        store: options.store,
      })
      return { status: "waking", url: null, reason: "reprovisioning" }
    }
    return { status: "provisioning", url: null }
  }
  if (await startStaleStoppedRecycle({
    worker: input.worker,
    sandboxExists: true,
    inspectSandbox: options.inspectSandbox,
    startRecovery: options.startRecovery,
    store: options.store,
  })) return { status: "waking", url: null, reason: "stopped" }

  if (sandbox.signed_preview_url_expires_at.getTime() > options.now()) {
    const ready = await readyFromSignedPreview({
      workerId: input.worker.id,
      signedPreviewUrl: sandbox.signed_preview_url,
      expiresAt: sandbox.signed_preview_url_expires_at,
      probeSignedPreview: options.probeSignedPreview,
      now: options.now,
    })
    if (ready) return ready
  }
  const refreshedReady = await refreshAndProbeSignedPreview({
    workerId: input.worker.id,
    refreshSignedPreview: options.refreshSignedPreview,
    probeSignedPreview: options.probeSignedPreview,
    now: options.now,
  })
  if (refreshedReady) return refreshedReady
  return recoverUnhealthyCloudSandbox({
    worker: input.worker,
    orgId: input.organizationId,
    continueProvisioning: options.continueProvisioning,
    inspectSandbox: options.inspectSandbox,
    startRecovery: options.startRecovery,
    store: options.store,
  })
}

export async function resolveCloudRuntimeAccess(
  ownership: CloudRuntimeOwnership,
  options: ResolveCloudRuntimeAccessOptions = {},
): Promise<CloudRuntimeAccessResult> {
  const worker = await (options.loadWorker ?? loadOwnedCloudWorker)(ownership)
  if (!worker) return { status: "missing" }

  const store = options.store ?? databaseCloudRuntimeStore
  const state = await resolveCloudRuntimeState({ worker, organizationId: ownership.organizationId }, {
    continueProvisioning: options.continueProvisioning ?? defaultContinueProvisioning,
    refreshSignedPreview: options.refreshSignedPreview ?? refreshDaytonaSignedPreview,
    getSandboxRecord: options.getSandboxRecord ?? getDaytonaSandboxRecord,
    inspectSandbox: options.inspectSandbox ?? inspectDaytonaSandbox,
    probeSignedPreview: options.probeSignedPreview ?? probeCloudRuntimeSignedPreview,
    startWake: options.startWake ?? startDefaultWake,
    startRecovery: options.startRecovery ?? startDefaultRecovery,
    store,
    now: options.now ?? Date.now,
  })
  if (state.status === "provisioning") {
    const reason: "unreachable" | undefined = unreachableWorkers.has(worker.id) ? "unreachable" : undefined
    return {
      status: "provisioning",
      workerId: worker.id,
      ...(reason ? { reason } : {}),
    }
  }
  if (state.status === "waking") {
    const reason = state.reason ?? (unreachableWorkers.has(worker.id) ? "unreachable" : undefined)
    return { status: "waking", workerId: worker.id, ...(reason ? { reason } : {}) }
  }
  if (state.status === "failed") {
    const reason = state.reason ?? (unreachableWorkers.has(worker.id) ? "unreachable" : undefined)
    return { status: "failed", workerId: worker.id, ...(reason ? { reason } : {}) }
  }

  unreachableWorkers.delete(worker.id)
  const tokens = await store.getActiveTokens(worker.id)
  const clientToken = tokenByScope(tokens, "client")
  const hostToken = tokenByScope(tokens, "host")
  if (!clientToken || !hostToken) {
    logger.error("cloud runtime ready instance missing access token", { worker_id: worker.id })
    return { status: "failed", workerId: worker.id, reason: "missing_tokens" }
  }
  return { status: "ready", workerId: worker.id, url: state.url, expiresAt: state.expiresAt, clientToken, hostToken }
}
