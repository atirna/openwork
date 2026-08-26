import { createHeadlessThreadClient, toTranscript, type HeadlessThreadClient, type HeadlessThreadModel } from "@openwork/headless-threads"
import { and, asc, eq } from "@openwork-ee/den-db/drizzle"
import { OrganizationTable, WorkerTable } from "@openwork-ee/den-db/schema"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { z } from "zod"
import { db } from "../db.js"
import { env } from "../env.js"
import { organizationCloudEnabled } from "../capability-sources/cloud-rollout.js"
import { CLOUD_INSTANCE_BACKEND } from "../workers/cloud-constants.js"
import { wakeCloudWorker } from "../workers/cloud-lifecycle.js"
import { loadCloudWorkerAccess, type CloudWorkerAccess } from "../workers/worker-access.js"
import { scoreText, tokenize, type CapabilityMatch } from "./search.js"

/**
 * Remote sessions over the capability gateway: create and drive a native
 * OpenWork session on the member's own OpenWork Cloud worker — the same
 * session store OpenWork Web renders — from any MCP client.
 *
 * v1 supports `target: "cloud"` only. The desktop target rides the runner
 * dispatch seam and is intentionally not wired here yet
 * (docs/remote-chat-over-mcp-architecture.md).
 */

export const REMOTE_SESSION_CAPABILITY_PREFIX = "remote-session:"
export const REMOTE_SESSION_ACTIONS = ["create", "send", "read"] as const
export type RemoteSessionAction = (typeof REMOTE_SESSION_ACTIONS)[number]

export function remoteSessionCapabilityName(action: RemoteSessionAction): string {
  return `${REMOTE_SESSION_CAPABILITY_PREFIX}${action}`
}

export function parseRemoteSessionCapabilityName(name: string): RemoteSessionAction | null {
  if (!name.startsWith(REMOTE_SESSION_CAPABILITY_PREFIX)) return null
  const action = name.slice(REMOTE_SESSION_CAPABILITY_PREFIX.length)
  return REMOTE_SESSION_ACTIONS.find((candidate) => candidate === action) ?? null
}

const modelSchema = z.object({
  providerId: z.string().trim().min(1),
  modelId: z.string().trim().min(1),
  variant: z.string().trim().min(1).optional(),
})

const createBodySchema = z.object({
  target: z.enum(["cloud", "desktop"]).optional(),
  title: z.string().trim().min(1).max(200).optional(),
  prompt: z.string().min(1).max(100_000).optional(),
  model: modelSchema.optional(),
})

const sendBodySchema = z.object({
  sessionId: z.string().trim().min(1),
  prompt: z.string().min(1).max(100_000),
  model: modelSchema.optional(),
})

const readBodySchema = z.object({
  sessionId: z.string().trim().min(1),
  limit: z.number().int().min(1).max(100).optional(),
})

const BODY_SCHEMAS: Record<RemoteSessionAction, z.ZodTypeAny> = {
  create: createBodySchema,
  send: sendBodySchema,
  read: readBodySchema,
}

type RemoteSessionDefinition = {
  action: RemoteSessionAction
  summary: string
  searchExtraTokens: string
  argumentsSchema: Record<string, unknown>
}

const MODEL_ARGUMENT_SCHEMA = {
  type: "object",
  properties: {
    providerId: { type: "string" },
    modelId: { type: "string" },
    variant: { type: "string" },
  },
  required: ["providerId", "modelId"],
} as const

const REMOTE_SESSION_DEFINITIONS: RemoteSessionDefinition[] = [
  {
    action: "create",
    summary:
      "Create a chat session on your OpenWork Cloud workspace. The session appears live in OpenWork Web. Optionally start it with a first prompt.",
    searchExtraTokens:
      "remote session sessions chat thread cloud web create start new handoff continue browser workspace",
    argumentsSchema: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["cloud"], description: "Execution target. Only \"cloud\" is supported today." },
        title: { type: "string", description: "Session title shown in OpenWork Web." },
        prompt: { type: "string", description: "Optional first prompt. When present the session starts working immediately." },
        model: MODEL_ARGUMENT_SCHEMA,
      },
    },
  },
  {
    action: "send",
    summary:
      "Send a prompt to an existing remote session on your OpenWork Cloud workspace. Returns an acceptance receipt; poll remote-session:read for the reply.",
    searchExtraTokens:
      "remote session sessions chat thread cloud web send prompt message turn continue",
    argumentsSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session id returned by remote-session:create." },
        prompt: { type: "string" },
        model: MODEL_ARGUMENT_SCHEMA,
      },
      required: ["sessionId", "prompt"],
    },
  },
  {
    action: "read",
    summary:
      "Read the status and recent transcript of a remote session on your OpenWork Cloud workspace.",
    searchExtraTokens:
      "remote session sessions chat thread cloud web read transcript status reply answer poll result",
    argumentsSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session id returned by remote-session:create." },
        limit: { type: "number", description: "Maximum number of recent messages to return. Defaults to 20, max 100." },
      },
      required: ["sessionId"],
    },
  },
]

export type RemoteSessionCapabilityMatch = CapabilityMatch & { kind: "remote_session" }

export function searchRemoteSessionCapabilities(query: string, limit = 5): RemoteSessionCapabilityMatch[] {
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return []

  const matches: RemoteSessionCapabilityMatch[] = []
  for (const definition of REMOTE_SESSION_DEFINITIONS) {
    const name = remoteSessionCapabilityName(definition.action)
    const score = scoreText(
      tokenize(`remote session ${definition.action}`),
      tokenize(definition.summary),
      queryTokens,
      tokenize(definition.searchExtraTokens),
    )
    if (score <= 0) continue
    matches.push({
      name,
      method: "SESSION",
      path: name,
      score,
      summary: definition.summary,
      pathParams: [],
      queryParams: [],
      hasBody: true,
      argumentsSchema: definition.argumentsSchema,
      invocation: { argumentsField: "body" },
      kind: "remote_session",
    })
  }

  return matches
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, Math.min(20, Math.trunc(limit) || 5)))
}

export type RemoteSessionRuntime = {
  workerId: string
  baseUrl: string
  workspaceId: string
  clientToken: string
  hostToken: string
}

export type RemoteSessionRuntimeResult =
  | { ok: true; runtime: RemoteSessionRuntime }
  | {
      ok: false
      error: "cloud_not_available" | "needs_cloud_setup" | "cloud_runtime_failed" | "cloud_runtime_waking"
      message: string
      retryable: boolean
    }

export type RemoteSessionThreadClient = Pick<HeadlessThreadClient, "createThread" | "sendTurn" | "getThreadSnapshot">

export type RemoteSessionExecuteDeps = {
  resolveRuntime: (scope: { organizationId: DenTypeId<"organization">; userId: string }) => Promise<RemoteSessionRuntimeResult>
  createClient: (runtime: RemoteSessionRuntime) => RemoteSessionThreadClient
}

export type RemoteSessionToolResult = {
  isError?: boolean
  content: { type: "text"; text: string }[]
  structuredContent?: Record<string, unknown>
}

const READY_BUDGET_MS = 25_000
const READY_POLL_MS = 1_000
const WORKER_REQUEST_TIMEOUT_MS = 10_000
const READ_DEFAULT_MESSAGE_LIMIT = 20
const READ_MESSAGE_TEXT_LIMIT = 4_000
const FINAL_TEXT_LIMIT = 20_000

const NEEDS_SETUP_MESSAGE =
  "No OpenWork Cloud workspace is available for your account yet. Open OpenWork Cloud in the browser once (the Web tab in OpenWork, or your organization's OpenWork Web URL) so it can be provisioned, then retry this capability."

const CLOUD_NOT_AVAILABLE_MESSAGE =
  "OpenWork Cloud is not enabled for this organization, so remote sessions are unavailable. An organization administrator can enable OpenWork Cloud; members cannot self-enable it."

/**
 * Whether the remote-session capabilities exist for an organization at all.
 * Mirrors the external-MCP rollout pattern: when the org's Cloud capability
 * flag is off (or this deployment cannot host Cloud), the capabilities are
 * hidden from search and execute reports them as unknown — members of a
 * flag-off org never see an action they cannot take.
 */
export function remoteSessionCapabilitiesEnabled(
  organizationMetadata: Record<string, unknown> | string | null | undefined,
): boolean {
  if (env.provisionerMode !== "daytona" || !env.daytona.apiKey) return false
  return organizationCloudEnabled(organizationMetadata, { orgMode: env.orgMode })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function workerHeaders(access: CloudWorkerAccess) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${access.clientToken}`,
    "X-OpenWork-Host-Token": access.hostToken,
  }
}

async function readWorkspace(access: CloudWorkerAccess) {
  for (const baseUrl of access.candidates) {
    try {
      const response = await fetch(`${baseUrl}/workspaces`, {
        headers: workerHeaders(access),
        signal: AbortSignal.timeout(WORKER_REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) continue
      const payload: unknown = await response.json()
      if (isRecord(payload) && typeof payload.activeId === "string" && payload.activeId) {
        return { baseUrl, workspaceId: payload.activeId }
      }
    } catch {
      // Try the next candidate URL; readiness is re-polled by the caller.
    }
  }
  return null
}

async function ownerCloudWorker(scope: { organizationId: DenTypeId<"organization">; userId: string }) {
  const workers = await db
    .select({ id: WorkerTable.id, status: WorkerTable.status })
    .from(WorkerTable)
    .where(and(
      eq(WorkerTable.org_id, scope.organizationId),
      eq(WorkerTable.created_by_user_id, normalizeDenTypeId("user", scope.userId)),
      eq(WorkerTable.destination, "cloud"),
      eq(WorkerTable.sandbox_backend, CLOUD_INSTANCE_BACKEND),
    ))
    .orderBy(asc(WorkerTable.created_at), asc(WorkerTable.id))
    .limit(1)
  return workers[0] ?? null
}

async function defaultResolveRuntime(
  scope: { organizationId: DenTypeId<"organization">; userId: string },
): Promise<RemoteSessionRuntimeResult> {
  // Defense in depth: the registry already hides these capabilities when the
  // org's Cloud flag is off, but the runtime re-checks with a live read so a
  // mid-session flag flip cannot keep executing against stale visibility.
  const organizations = await db
    .select({ metadata: OrganizationTable.metadata })
    .from(OrganizationTable)
    .where(eq(OrganizationTable.id, scope.organizationId))
    .limit(1)
  if (!remoteSessionCapabilitiesEnabled(organizations[0]?.metadata)) {
    return { ok: false, error: "cloud_not_available", message: CLOUD_NOT_AVAILABLE_MESSAGE, retryable: false }
  }

  const worker = await ownerCloudWorker(scope)
  if (!worker) {
    return { ok: false, error: "needs_cloud_setup", message: NEEDS_SETUP_MESSAGE, retryable: false }
  }
  if (worker.status === "failed") {
    return {
      ok: false,
      error: "cloud_runtime_failed",
      message: "Your OpenWork Cloud workspace needs repair before remote sessions can run. Open OpenWork Cloud in the browser to let it recover, then retry.",
      retryable: false,
    }
  }

  const deadline = Date.now() + READY_BUDGET_MS
  let wakeKicked = false
  for (;;) {
    const access = await loadCloudWorkerAccess({ organizationId: scope.organizationId, workerId: worker.id })
    if (access) {
      const workspace = await readWorkspace(access)
      if (workspace) {
        return {
          ok: true,
          runtime: {
            workerId: worker.id,
            baseUrl: workspace.baseUrl,
            workspaceId: workspace.workspaceId,
            clientToken: access.clientToken,
            hostToken: access.hostToken,
          },
        }
      }
    } else if (!wakeKicked) {
      // Stopped or provisioning worker: kick the shared wake path once.
      // `wakeCloudWorker` dedupes in-flight wakes per worker.
      wakeKicked = true
      void wakeCloudWorker(worker.id).catch(() => undefined)
    }
    if (Date.now() >= deadline) break
    await sleep(READY_POLL_MS)
  }

  return {
    ok: false,
    error: "cloud_runtime_waking",
    message: "Your OpenWork Cloud workspace is still starting. Retry the same call in about 30 seconds.",
    retryable: true,
  }
}

function defaultCreateClient(runtime: RemoteSessionRuntime): RemoteSessionThreadClient {
  return createHeadlessThreadClient({
    baseUrl: runtime.baseUrl,
    workspaceId: runtime.workspaceId,
    token: runtime.clientToken,
    hostToken: runtime.hostToken,
    requestTimeoutMs: WORKER_REQUEST_TIMEOUT_MS,
  })
}

export const DEFAULT_REMOTE_SESSION_DEPS: RemoteSessionExecuteDeps = {
  resolveRuntime: defaultResolveRuntime,
  createClient: defaultCreateClient,
}

function jsonResult(payload: Record<string, unknown>, isError = false): RemoteSessionToolResult {
  return {
    ...(isError ? { isError: true } : {}),
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  }
}

function errorResult(payload: Record<string, unknown>): RemoteSessionToolResult {
  return jsonResult(payload, true)
}

function threadErrorStatus(error: unknown): number | null {
  if (!isRecord(error)) return null
  return typeof error.status === "number" ? error.status : null
}

function threadErrorResult(action: RemoteSessionAction, sessionId: string | null, error: unknown): RemoteSessionToolResult {
  const status = threadErrorStatus(error)
  if (status === 404 && sessionId) {
    return errorResult({
      error: "unknown_session",
      message: `No remote session "${sessionId}" exists on your OpenWork Cloud workspace. It may have been deleted; create a new one with remote-session:create.`,
      retryable: false,
    })
  }
  const message = error instanceof Error ? error.message : "The OpenWork Cloud workspace request failed."
  return errorResult({
    error: "remote_session_request_failed",
    message: `remote-session:${action} failed: ${message}`,
    retryable: status === null || status >= 500,
  })
}

function modelInput(model: z.infer<typeof modelSchema> | undefined): HeadlessThreadModel | undefined {
  if (!model) return undefined
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(model.variant ? { variant: model.variant } : {}),
  }
}

export type RemoteSessionExecuteInput = {
  action: RemoteSessionAction
  organizationId: DenTypeId<"organization">
  userId: string
  hasWriteScope: boolean
  body: unknown
}

export async function executeRemoteSessionCapability(
  input: RemoteSessionExecuteInput,
  deps: RemoteSessionExecuteDeps = DEFAULT_REMOTE_SESSION_DEPS,
): Promise<RemoteSessionToolResult> {
  if ((input.action === "create" || input.action === "send") && !input.hasWriteScope) {
    return errorResult({
      error: "insufficient_mcp_scope",
      message: `remote-session:${input.action} requires the mcp:write scope.`,
      retryable: false,
    })
  }

  const parsedBody = BODY_SCHEMAS[input.action].safeParse(input.body ?? {})
  if (!parsedBody.success) {
    return errorResult({
      error: "invalid_capability_arguments",
      message: `Invalid arguments for remote-session:${input.action}.`,
      issues: parsedBody.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
      retryable: false,
    })
  }

  if (input.action === "create") {
    const body = createBodySchema.parse(parsedBody.data)
    if (body.target === "desktop") {
      return errorResult({
        error: "unsupported_target",
        message: "target \"desktop\" is not available yet. Only target \"cloud\" is supported; omit target or pass \"cloud\".",
        retryable: false,
      })
    }
  }

  const runtime = await deps.resolveRuntime({ organizationId: input.organizationId, userId: input.userId })
  if (!runtime.ok) {
    return errorResult({
      error: runtime.error,
      message: runtime.message,
      retryable: runtime.retryable,
    })
  }

  const client = deps.createClient(runtime.runtime)

  if (input.action === "create") {
    const body = createBodySchema.parse(parsedBody.data)
    try {
      const thread = await client.createThread({
        title: body.title ?? "Remote session",
        ...(body.prompt === undefined ? {} : { prompt: body.prompt }),
        ...(modelInput(body.model) === undefined ? {} : { model: modelInput(body.model) }),
      })
      return jsonResult({
        target: "cloud",
        sessionId: thread.id,
        workspaceId: thread.workspaceId,
        workerId: runtime.runtime.workerId,
        title: thread.title,
        started: thread.started,
        note: "This is a native OpenWork session on your Cloud workspace; it appears in OpenWork Web. Use remote-session:send to prompt it and remote-session:read to read replies.",
      })
    } catch (error) {
      return threadErrorResult("create", null, error)
    }
  }

  if (input.action === "send") {
    const body = sendBodySchema.parse(parsedBody.data)
    try {
      const accepted = await client.sendTurn(body.sessionId, {
        prompt: body.prompt,
        ...(modelInput(body.model) === undefined ? {} : { model: modelInput(body.model) }),
      })
      return jsonResult({
        target: "cloud",
        sessionId: body.sessionId,
        state: "accepted",
        messageId: accepted.messageId,
        alreadyPresent: accepted.alreadyPresent,
        note: "The prompt was accepted asynchronously. Poll remote-session:read for the reply.",
      })
    } catch (error) {
      return threadErrorResult("send", body.sessionId, error)
    }
  }

  const body = readBodySchema.parse(parsedBody.data)
  try {
    const snapshot = await client.getThreadSnapshot(body.sessionId)
    const transcript = toTranscript(snapshot)
    const limit = body.limit ?? READ_DEFAULT_MESSAGE_LIMIT
    return jsonResult({
      target: "cloud",
      sessionId: body.sessionId,
      title: transcript.title,
      status: snapshot.status.type,
      messageCount: transcript.messages.length,
      messages: transcript.messages.slice(-limit).map((message) => ({
        id: message.id,
        role: message.role,
        text: message.text.slice(0, READ_MESSAGE_TEXT_LIMIT),
        toolCalls: message.toolCalls.map((tool) => ({ name: tool.name, status: tool.status })),
      })),
      finalAssistantText: transcript.finalAssistantText.slice(0, FINAL_TEXT_LIMIT),
      ...(transcript.terminalError ? { terminalError: transcript.terminalError } : {}),
    })
  } catch (error) {
    return threadErrorResult("read", body.sessionId, error)
  }
}
