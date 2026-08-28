import { beforeAll, expect, test } from "bun:test"

import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { remoteSessionCommandCompleteRequestSchema } from "@openwork/types/automations"
import type {
  RemoteSessionExecuteDeps,
  RemoteSessionRuntime,
  RemoteSessionToolResult,
} from "../src/mcp/remote-session-capabilities.js"
import type {
  RemoteSessionCommand,
  RemoteSessionCommandStore,
} from "../src/remote-sessions/commands.js"

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.DEN_API_PUBLIC_URL = process.env.DEN_API_PUBLIC_URL ?? "http://127.0.0.1:8790"
  process.env.DAYTONA_SNAPSHOT = "openwork-0.18.8"
}

type RemoteSessionModule = typeof import("../src/mcp/remote-session-capabilities.js")
type CommandsModule = typeof import("../src/remote-sessions/commands.js")

let executeRemoteSessionCapability: RemoteSessionModule["executeRemoteSessionCapability"]
let defaultTtlMs: CommandsModule["DEFAULT_TTL_MS"]

beforeAll(async () => {
  seedRequiredEnv()
  const [remoteSessionModule, commandsModule] = await Promise.all([
    import("../src/mcp/remote-session-capabilities.js"),
    import("../src/remote-sessions/commands.js"),
  ])
  executeRemoteSessionCapability = remoteSessionModule.executeRemoteSessionCapability
  defaultTtlMs = commandsModule.DEFAULT_TTL_MS
})

const ORGANIZATION_ID = createDenTypeId("organization")
const MEMBER_ID = createDenTypeId("member")
const USER_ID = createDenTypeId("user")
const COMMAND_ID = createDenTypeId("remoteSessionCommand")
const RUNTIME: RemoteSessionRuntime = {
  workerId: "worker_fixture",
  baseUrl: "http://worker.fixture",
  workspaceId: "ws_fixture",
  clientToken: "client-token",
  hostToken: "host-token",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function payload(result: RemoteSessionToolResult): Record<string, unknown> {
  const parsed: unknown = JSON.parse(result.content[0]?.text ?? "{}")
  if (!isRecord(parsed)) throw new Error("Remote-session result was not an object")
  return parsed
}

function command(overrides: Partial<RemoteSessionCommand> = {}): RemoteSessionCommand {
  return {
    id: COMMAND_ID,
    organizationId: ORGANIZATION_ID,
    ownerMemberId: MEMBER_ID,
    createdByUserId: USER_ID,
    status: "pending",
    title: "Remote session",
    prompt: null,
    model: null,
    idempotencyKey: createDenTypeId("remoteSessionCommand"),
    expiresAt: Date.now() + 600_000,
    claimedByRunnerId: null,
    claimedAt: null,
    sessionId: null,
    workspaceId: null,
    resultSummary: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function fakeStore(overrides: Partial<RemoteSessionCommandStore> = {}): RemoteSessionCommandStore {
  const unavailable = async (): Promise<never> => {
    throw new Error("command store method not stubbed for this test")
  }
  return {
    enqueue: overrides.enqueue ?? unavailable,
    claim: overrides.claim ?? unavailable,
    complete: overrides.complete ?? unavailable,
    get: overrides.get ?? unavailable,
    listPendingForRunner: overrides.listPendingForRunner ?? unavailable,
  }
}

function deps(input: {
  commandStore?: RemoteSessionCommandStore
  connected?: boolean
  ownerMemberId?: string | null
  createClient?: RemoteSessionExecuteDeps["createClient"]
  resolveRuntime?: RemoteSessionExecuteDeps["resolveRuntime"]
} = {}): RemoteSessionExecuteDeps {
  return {
    commandStore: input.commandStore ?? fakeStore(),
    desktopPresence: async () => ({
      connected: input.connected ?? false,
      ownerMemberId: input.ownerMemberId ?? null,
    }),
    resolveRuntime: input.resolveRuntime ?? (async () => ({ ok: true, runtime: RUNTIME })),
    createClient: input.createClient ?? (() => { throw new Error("client not stubbed for this test") }),
  }
}

function executeInput(action: "create" | "send" | "read", body: unknown) {
  return {
    action,
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
    hasWriteScope: true,
    body,
  }
}

test("desktop create reports desktop_offline when no runner is present", async () => {
  const result = await executeRemoteSessionCapability(
    executeInput("create", { target: "desktop", title: "Offline" }),
    deps(),
  )

  expect(result.isError).toBe(true)
  expect(payload(result)).toEqual({
    error: "desktop_offline",
    message: "No desktop is connected for your account. Open the OpenWork desktop app and try again.",
  })
})

test("desktop command completions require a status-consistent receipt", () => {
  expect(remoteSessionCommandCompleteRequestSchema.safeParse({
    status: "delivered",
    sessionId: "session-1",
    workspaceId: "workspace-1",
  }).success).toBe(true)
  expect(remoteSessionCommandCompleteRequestSchema.safeParse({
    status: "delivered",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    error: { code: "execution_failed", message: "contradiction" },
  }).success).toBe(false)
  expect(remoteSessionCommandCompleteRequestSchema.safeParse({ status: "delivered" }).success).toBe(false)
  expect(remoteSessionCommandCompleteRequestSchema.safeParse({
    status: "failed",
    error: { code: "execution_failed", message: "failed" },
  }).success).toBe(true)
  expect(remoteSessionCommandCompleteRequestSchema.safeParse({
    status: "failed",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    error: { code: "execution_failed", message: "failed" },
  }).success).toBe(false)
  expect(remoteSessionCommandCompleteRequestSchema.safeParse({ status: "failed" }).success).toBe(false)
})

test("desktop create queues a ten-minute command for the connected member", async () => {
  const enqueued: Parameters<RemoteSessionCommandStore["enqueue"]>[0][] = []
  const expiresAt = Date.now() + 600_000
  const store = fakeStore({
    enqueue: async (input) => {
      enqueued.push(input)
      return command({
        title: input.title,
        prompt: input.prompt ?? null,
        model: input.model
          ? { providerId: input.model.providerId, modelId: input.model.modelId, variant: input.model.variant ?? null }
          : null,
        expiresAt,
      })
    },
  })

  const result = await executeRemoteSessionCapability(
    executeInput("create", {
      target: "desktop",
      title: "Desktop handoff",
      prompt: "Inspect the repo",
      model: { providerId: "provider", modelId: "model", variant: "high" },
    }),
    deps({ commandStore: store, connected: true, ownerMemberId: MEMBER_ID }),
  )

  expect(result.isError).toBeUndefined()
  expect(payload(result)).toEqual({
    target: "desktop",
    state: "queued",
    commandId: COMMAND_ID,
    expiresAt,
  })
  expect(enqueued).toHaveLength(1)
  expect(enqueued[0]).toMatchObject({
    organizationId: ORGANIZATION_ID,
    ownerMemberId: MEMBER_ID,
    createdByUserId: USER_ID,
    title: "Desktop handoff",
    prompt: "Inspect the repo",
    model: { providerId: "provider", modelId: "model", variant: "high" },
    ttlMs: defaultTtlMs,
  })
  expect(enqueued[0]?.idempotencyKey).toMatch(/^rsc_/)
})

test("read by command id returns claimed and delivered desktop states", async () => {
  const states = [
    command({ status: "claimed", claimedByRunnerId: "runner_fixture", claimedAt: Date.now() }),
    command({
      status: "delivered",
      sessionId: "ses_fixture",
      workspaceId: "ws_fixture",
      resultSummary: "created",
    }),
  ]
  const store = fakeStore({ get: async () => states.shift() ?? null })

  const claimed = await executeRemoteSessionCapability(
    executeInput("read", { commandId: COMMAND_ID }),
    deps({ commandStore: store }),
  )
  expect(payload(claimed)).toMatchObject({
    commandId: COMMAND_ID,
    target: "desktop",
    state: "claimed",
    sessionId: null,
    error: null,
  })

  const delivered = await executeRemoteSessionCapability(
    executeInput("read", { commandId: COMMAND_ID }),
    deps({ commandStore: store }),
  )
  expect(payload(delivered)).toMatchObject({
    commandId: COMMAND_ID,
    target: "desktop",
    state: "delivered",
    sessionId: "ses_fixture",
    workspaceId: "ws_fixture",
    resultSummary: "created",
    error: null,
  })
})

test("read by an unknown command id returns unknown_command", async () => {
  const result = await executeRemoteSessionCapability(
    executeInput("read", { commandId: COMMAND_ID }),
    deps({ commandStore: fakeStore({ get: async () => null }) }),
  )

  expect(result.isError).toBe(true)
  expect(payload(result)).toEqual({ error: "unknown_command" })
})

test("read requires exactly one session or command id", async () => {
  const [both, neither] = await Promise.all([
    executeRemoteSessionCapability(
      executeInput("read", { sessionId: "ses_fixture", commandId: COMMAND_ID }),
      deps(),
    ),
    executeRemoteSessionCapability(executeInput("read", {}), deps()),
  ])

  expect(both.isError).toBe(true)
  expect(payload(both).error).toBe("invalid_capability_arguments")
  expect(neither.isError).toBe(true)
  expect(payload(neither).error).toBe("invalid_capability_arguments")
})

test("omitting target preserves the cloud create path", async () => {
  let runtimeResolved = false
  const result = await executeRemoteSessionCapability(
    executeInput("create", { title: "Cloud session" }),
    deps({
      resolveRuntime: async () => {
        runtimeResolved = true
        return { ok: true, runtime: RUNTIME }
      },
      createClient: () => ({
        createThread: async () => ({
          id: "ses_cloud",
          workspaceId: "ws_fixture",
          title: "Cloud session",
          directory: null,
          createdAt: 1,
          started: false,
        }),
        sendTurn: async () => { throw new Error("unused") },
        getThreadSnapshot: async () => { throw new Error("unused") },
      }),
    }),
  )

  expect(runtimeResolved).toBe(true)
  expect(result.isError).toBeUndefined()
  expect(payload(result)).toMatchObject({ target: "cloud", sessionId: "ses_cloud" })
})
