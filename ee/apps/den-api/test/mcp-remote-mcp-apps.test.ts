import { createHash } from "node:crypto"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ResourceListChangedNotificationSchema, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import { expect, test } from "bun:test"
import { dynamicArtifactAppServerCapabilities } from "../src/mcp/dynamic-artifact-app.js"

process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:3005"
process.env.OPENWORK_DEV_MODE ??= "1"
process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_den"

const {
  IMPORT_REMOTE_MCP_APP_TOOL_NAME,
  registerAgentRemoteMcpApps,
  remoteMcpAppCapabilityName,
  remoteMcpAppLaunchToolName,
  searchRemoteMcpApps,
} = await import("../src/mcp/remote-mcp-apps.js")
const { remoteMcpAppResourceUri } = await import("../src/remote-mcp-apps.js")

const configObjectId = "cob_01k28e8q8pf8r9sff9mhyqxved"
const versionId = "cov_01k28e8q8pf8r9sff9mhyqxved"
const pluginId = "plg_01k28e8q8pf8r9sff9mhyqxved"
const organizationId = "org_01k28e8q8pf8r9sff9mhyqxved"
const html = '<!doctype html><html><body><div id="app"></div><script>window.ready=true</script></body></html>'
const resourceDigest = `sha256:${createHash("sha256").update(html).digest("hex")}`
const resourceUri = remoteMcpAppResourceUri(configObjectId, versionId)
const activePayload = {
  kind: "remote_mcp_app",
  metadata: {
    name: "Project Explorer",
    version: "1.0.0",
    description: "Browse connected projects.",
  },
  source: {
    url: "https://apps.example/project-explorer.html",
    resolvedUrl: "https://cdn.example/project-explorer.1.0.0.html",
    fetchedAt: "2026-08-13T10:00:00.000Z",
    contentType: "text/html",
  },
  resource: {
    byteSize: Buffer.byteLength(html),
    digest: resourceDigest,
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
  },
  diagnostics: [],
}

const activeApp = {
  app: {
    configObjectId,
    organizationId,
    pluginId,
    activeVersionId: versionId,
    sourceUrl: "https://apps.example/project-explorer.html",
    resolvedSourceUrl: "https://cdn.example/project-explorer.1.0.0.html",
    status: "active",
    createdAt: new Date("2026-08-13T10:00:00.000Z"),
    updatedAt: new Date("2026-08-13T10:00:00.000Z"),
    retiredAt: null,
  },
  payload: activePayload,
  resourceUri,
  versionId,
  revisions: [{
    payload: activePayload,
    resourceUri,
    versionId,
  }],
}

async function withClient<T>(
  run: (client: Client) => Promise<T>,
  options: {
    importApp?: (request: { activate: boolean; pluginId: string; sourceUrl: string }) => Promise<Record<string, unknown>>
  } = {},
) {
  const server = new McpServer(
    { name: "remote-mcp-app-test", version: "1.0.0" },
    { capabilities: dynamicArtifactAppServerCapabilities },
  )
  registerAgentRemoteMcpApps({
    server,
    apps: [activeApp as never],
    loadResource: async () => ({ html, payload: activePayload as never }),
    ...(options.importApp ? { importApp: options.importApp } : {}),
  })
  const client = new Client({ name: "desktop-host", version: "1.0.0" }, { capabilities: {} })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    return await run(client)
  } finally {
    await client.close()
    await server.close()
  }
}

test("advertises one standard tool with the exact immutable ui resource", async () => {
  await withClient(async (client) => {
    const tools = await client.listTools()
    const launch = tools.tools.find((tool) => tool.name === remoteMcpAppLaunchToolName(configObjectId))
    expect(launch?._meta).toMatchObject({ ui: { resourceUri, visibility: ["app"] } })
    expect(tools.tools).toHaveLength(1)

    const resources = await client.listResources()
    expect(resources.resources).toContainEqual(expect.objectContaining({
      uri: resourceUri,
      mimeType: "text/html;profile=mcp-app",
      _meta: expect.objectContaining({
        ui: expect.objectContaining({ csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } }),
        resourceDigest,
      }),
    }))
  })
})

test("discovers installed URL apps through the MCP capability catalog", () => {
  const matches = searchRemoteMcpApps([activeApp as never], "open Project Atlas", 5, "mcp")
  expect(matches).toContainEqual(expect.objectContaining({
    name: remoteMcpAppCapabilityName(configObjectId),
    kind: "mcp_app",
    mcpApp: { resourceUri },
  }))
  expect(searchRemoteMcpApps([activeApp as never], "Project Atlas", 5, "api")).toEqual([])
})

test("serves exact cached bytes and delivers launch data through structuredContent", async () => {
  await withClient(async (client) => {
    const resource = await client.readResource({ uri: resourceUri })
    const content = resource.contents[0]
    expect(content && "text" in content ? content.text : null).toBe(html)
    const launch = await client.callTool({
      name: remoteMcpAppLaunchToolName(configObjectId),
      arguments: { input: { project: "alpha" } },
    })
    expect(launch.structuredContent).toMatchObject({
      app: { id: configObjectId, revisionId: versionId, resourceDigest },
      serverTools: {
        searchCapabilities: "search_capabilities",
        executeCapability: "execute_capability",
      },
      input: { project: "alpha" },
    })
  })
})

test("registers a strict model-only installer and emits standard list-change notifications", async () => {
  const requests: Array<{ activate: boolean; pluginId: string; sourceUrl: string }> = []
  await withClient(async (client) => {
    const tools = await client.listTools()
    const installer = tools.tools.find((tool) => tool.name === IMPORT_REMOTE_MCP_APP_TOOL_NAME)
    expect(installer).toMatchObject({
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      _meta: { ui: { visibility: ["model"] } },
    })
    expect(Object.keys((installer?.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}))
      .toEqual(["pluginId", "sourceUrl", "activate"])

    const rejected = await client.callTool({
      name: IMPORT_REMOTE_MCP_APP_TOOL_NAME,
      arguments: {
        pluginId,
        sourceUrl: "https://apps.example/project-explorer.html",
        inlineHtml: "<!doctype html><html></html>",
      },
    })
    expect(rejected.isError).toBe(true)
    expect(requests).toHaveLength(0)

    let toolsChanged = 0
    let resourcesChanged = 0
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => { toolsChanged += 1 })
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => { resourcesChanged += 1 })
    const imported = await client.callTool({
      name: IMPORT_REMOTE_MCP_APP_TOOL_NAME,
      arguments: { pluginId, sourceUrl: "https://apps.example/project-explorer.html" },
    })
    expect(requests).toEqual([{
      activate: true,
      pluginId,
      sourceUrl: "https://apps.example/project-explorer.html",
    }])
    expect(imported.structuredContent).toEqual({
      app: { id: configObjectId, pluginId, activeVersionId: versionId },
    })
    expect(toolsChanged).toBeGreaterThan(0)
    expect(resourcesChanged).toBeGreaterThan(0)
  }, {
    importApp: async (request) => {
      requests.push(request)
      return { id: configObjectId, pluginId, activeVersionId: versionId }
    },
  })
})
