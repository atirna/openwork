import { createHash } from "node:crypto"
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server"
import type { McpUiResourceMeta } from "@modelcontextprotocol/ext-apps"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { listActiveRemoteMcpApps } from "../remote-mcp-apps.js"
import {
  EXECUTE_CAPABILITY_TOOL_NAME,
  SEARCH_CAPABILITIES_TOOL_NAME,
  scoreText,
  tokenize,
  type CapabilityMatch,
  type SearchCapabilityType,
} from "./search.js"

type ActiveRemoteMcpApp = Awaited<ReturnType<typeof listActiveRemoteMcpApps>>[number]
export const IMPORT_REMOTE_MCP_APP_TOOL_NAME = "import_remote_mcp_app"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function digest(value: string) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`
}

function stableSuffix(value: string, length = 12) {
  return createHash("sha256").update(value).digest("hex").slice(0, length)
}

export function remoteMcpAppLaunchToolName(configObjectId: string) {
  return `launch_remote_app_${stableSuffix(configObjectId)}`
}

export function remoteMcpAppCapabilityName(configObjectId: string) {
  return `remote_app:${configObjectId}`
}

export function searchRemoteMcpApps(
  apps: ActiveRemoteMcpApp[],
  query: string,
  limit: number,
  type: SearchCapabilityType = "all",
): CapabilityMatch[] {
  if (type !== "all" && type !== "mcp") return []
  const queryTokens = tokenize(query)
  return apps.map((app) => {
    const metadata = app.payload.metadata
    return {
      name: remoteMcpAppCapabilityName(app.app.configObjectId),
      method: "MCP",
      path: app.resourceUri,
      score: scoreText(tokenize(metadata.name), tokenize(metadata.description ?? ""), queryTokens, ["app", "open", "ui"]),
      summary: metadata.launchTool?.description ?? metadata.description ?? `Open ${metadata.name}.`,
      pathParams: [],
      queryParams: [],
      hasBody: true,
      argumentsSchema: {
        type: "object",
        properties: { input: {} },
        additionalProperties: false,
      },
      invocation: { argumentsField: "body" as const },
      kind: "mcp_app",
      mcpApp: { resourceUri: app.resourceUri },
    }
  }).filter((match) => match.score > 0)
    .sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name))
    .slice(0, Math.max(1, Math.min(20, limit)))
}

export function remoteMcpAppLaunchResult(app: ActiveRemoteMcpApp, launchInput?: unknown) {
  const metadata = app.payload.metadata
  const structuredContent = {
    app: {
      id: app.app.configObjectId,
      name: metadata.name,
      version: metadata.version,
      revisionId: app.versionId,
      resourceDigest: app.payload.resource.digest,
    },
    serverTools: {
      searchCapabilities: SEARCH_CAPABILITIES_TOOL_NAME,
      executeCapability: EXECUTE_CAPABILITY_TOOL_NAME,
    },
    ...(launchInput === undefined ? {} : { input: launchInput }),
  }
  return {
    content: [{ type: "text" as const, text: `Opened ${metadata.name} ${metadata.version}.` }],
    structuredContent,
  }
}

function resourceMeta(revision: Pick<ActiveRemoteMcpApp, "payload">): { ui: McpUiResourceMeta; resourceDigest: string } {
  return {
    ui: { csp: revision.payload.resource.csp, prefersBorder: true },
    resourceDigest: revision.payload.resource.digest,
  }
}

export function registerAgentRemoteMcpApps(input: {
  server: McpServer
  apps: ActiveRemoteMcpApp[]
  loadResource: (request: { configObjectId: string; versionId: string }) => Promise<{
    html: string
    payload: ActiveRemoteMcpApp["payload"]
  }>
  importApp?: (request: {
    activate: boolean
    pluginId: string
    sourceUrl: string
  }) => Promise<Record<string, unknown>>
}) {
  const importApp = input.importApp
  if (importApp) {
    input.server.registerTool(
      IMPORT_REMOTE_MCP_APP_TOOL_NAME,
      {
        title: "Import remote MCP App",
        description: [
          "Install an externally built, self-contained MCP App index.html from an HTTPS URL into an existing OpenWork Connect Plugin.",
          "OpenWork downloads and validates the document server-side, stores the exact bytes and digest as an immutable revision, and serves only the cached ui:// resource.",
          "This tool accepts no inline HTML, React, JavaScript, source tree, or build project. Installing third-party executable content requires normal user approval.",
        ].join(" "),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        inputSchema: z.object({
          pluginId: z.string().trim().min(1).max(160).describe("Existing Plugin to contain and govern the imported MCP App."),
          sourceUrl: z.string().trim().url().max(2_048).describe("Public HTTPS URL for one self-contained index.html document."),
          activate: z.boolean().optional().default(true).describe("Expose the immutable imported revision immediately. Defaults to true."),
        }).strict(),
        outputSchema: z.object({ app: z.record(z.string(), z.unknown()) }),
        _meta: { ui: { visibility: ["model"] } },
      },
      async ({ pluginId, sourceUrl, activate }, extra) => {
        try {
          const app = await importApp({ pluginId, sourceUrl, activate })
          await extra.sendNotification({ method: "notifications/tools/list_changed" })
          await extra.sendNotification({ method: "notifications/resources/list_changed" })
          const result = { app }
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          }
        } catch (error) {
          const code = isRecord(error) && typeof error.code === "string"
            ? error.code
            : isRecord(error) && typeof error.error === "string"
              ? error.error
            : "remote_mcp_app_import_failed"
          const message = error instanceof Error ? error.message : "The remote MCP App could not be imported."
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify({ error: code, message }) }],
          }
        }
      },
    )
  }

  for (const app of input.apps) {
    const metadata = app.payload.metadata
    for (const revision of app.revisions) {
      const metadata = resourceMeta(revision)
      registerAppResource(
        input.server,
        `Remote MCP App ${app.app.configObjectId} ${revision.versionId}`,
        revision.resourceUri,
        {
          title: `${revision.payload.metadata.name} ${revision.payload.metadata.version}`,
          description: "An immutable, self-contained Remote MCP App cached by OpenWork.",
          _meta: metadata,
        },
        async () => {
          const loaded = await input.loadResource({
            configObjectId: app.app.configObjectId,
            versionId: revision.versionId,
          })
          if (loaded.payload.resource.digest !== revision.payload.resource.digest
            || digest(loaded.html) !== revision.payload.resource.digest) {
            throw new Error("remote_mcp_app_resource_digest_mismatch")
          }
          return {
            contents: [{
              uri: revision.resourceUri,
              mimeType: RESOURCE_MIME_TYPE,
              text: loaded.html,
              _meta: metadata,
            }],
          }
        },
      )
    }

    registerAppTool(
      input.server,
      remoteMcpAppLaunchToolName(app.app.configObjectId),
      {
        title: metadata.launchTool?.title ?? metadata.name,
        description: metadata.launchTool?.description ?? metadata.description ?? `Open ${metadata.name}.`,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        inputSchema: z.object({ input: z.unknown().optional() }),
        _meta: { ui: { resourceUri: app.resourceUri, visibility: ["app"] } },
      },
      async ({ input: launchInput }) => remoteMcpAppLaunchResult(app, launchInput),
    )
  }
}
