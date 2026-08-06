import { describe, expect, test } from "bun:test"
import type { GithubDiscoveredPlugin } from "../src/routes/org/plugin-system/github-discovery.js"

process.env.DEN_DB_ENCRYPTION_KEY = "test-den-db-encryption-key-please-change-1234567890"
process.env.BETTER_AUTH_SECRET = "test-better-auth-secret-please-change-1234567890"
process.env.BETTER_AUTH_URL = "http://localhost:3005"
process.env.CORS_ORIGINS = "http://localhost:3005"
process.env.DATABASE_URL = "mysql://root:password@127.0.0.1:3306/openwork_test"

const { mcpServerEntriesFromPayload } = await import("../src/routes/org/plugin-system/store.js")

const plugin: GithubDiscoveredPlugin = {
  componentKinds: ["mcp_server"],
  componentPaths: {
    agents: [],
    commands: [],
    hooks: [],
    lspServers: [],
    mcpServers: ["mcp.json"],
    monitors: [],
    settings: [],
    skills: [],
  },
  description: null,
  displayName: "team-tools",
  key: "agent-plugin:root",
  manifestPath: "plugin.json",
  metadata: {},
  rootPath: "",
  selectedByDefault: true,
  sourceKind: "agent_plugin_manifest" as const,
  supported: true,
  warnings: [],
}

describe("Agent Plugin Den import policy", () => {
  test("imports safe remote servers and reports unsupported entries independently", () => {
    const servers = mcpServerEntriesFromPayload({
      plugin,
      rawSourceText: JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          headerServer: {
            type: "streamable-http",
            url: "https://headers.example.test/mcp",
            headers: { "x-tenant": "public-value" },
          },
          insecure: { type: "streamable-http", url: "http://example.test/mcp" },
          fragment: { type: "streamable-http", url: "https://mcp.example.test/mcp#fragment" },
          local: { type: "stdio", command: "node", args: ["server.mjs"] },
          loopback: { type: "streamable-http", url: "http://127.0.0.1:8787/mcp" },
          remote: { type: "streamable-http", url: "https://mcp.example.test/mcp" },
        },
      }),
      sourcePath: "mcp.json",
    })

    expect(servers.map((server) => ({ name: server.name, reason: server.skippedReason, supported: server.supported }))).toEqual([
      { name: "headerServer", reason: "headers_unsupported", supported: false },
      { name: "insecure", reason: "invalid_url", supported: false },
      { name: "fragment", reason: "invalid_url", supported: false },
      { name: "local", reason: "local_unsupported", supported: false },
      { name: "loopback", reason: null, supported: true },
      { name: "remote", reason: null, supported: true },
    ])
  })

  test("keeps valid siblings when one server violates the v1 schema", () => {
    const servers = mcpServerEntriesFromPayload({
      plugin,
      rawSourceText: JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          invalid: { type: "streamable-http", url: 42 },
          valid: { type: "streamable-http", url: "https://mcp.example.test/mcp" },
        },
      }),
      sourcePath: "mcp.json",
    })

    expect(servers.map((server) => [server.name, server.skippedReason])).toEqual([
      ["invalid", "invalid_config"],
      ["valid", null],
    ])
  })
})
