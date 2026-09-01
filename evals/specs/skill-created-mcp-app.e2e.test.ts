import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { expect, onTestFinished } from "vitest"
import { clickButton, createAndSelectWorkspace, denFetch, evalIn, waitFor } from "@openwork/behaviors"
import { connect, debuggerUrlFor, evaluate, listTargets } from "@openwork/cdp"
import { desktop } from "@openwork/hosts"
import { screenshot } from "@openwork/test-evidence"
import { localMysqlIsRunning, needs, server, test } from "@openwork/testkit"

const providerId = "skill-created-mcp-app-provider"
const modelId = "skill-created-mcp-app-model"
const resourceUri = "ui://openwork/skill-created/v1/view.html"
const closingReply = "The beautiful tomatoes skill is ready to use."
const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1"
const localPlacement = process.env.OPENWORK_EVAL_DAYTONA !== "1"
  && !process.env.OPENWORK_EVAL_DEN_API_URL?.trim()
const mysqlOpen = await localMysqlIsRunning()
const title = !e2eTestsEnabled
  ? "skill-created MCP App skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1"
  : !localPlacement
    ? "skill-created MCP App skipped — needs local placement without OPENWORK_EVAL_DEN_API_URL"
    : !mysqlOpen
      ? "skill-created MCP App skipped — needs MySQL on 127.0.0.1:3306"
      : "creating a Cloud skill renders the first-party skill-created MCP App"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readBody(request: IncomingMessage): Promise<string> {
  request.setEncoding("utf8")
  return new Promise((resolve, reject) => {
    let body = ""
    request.on("data", (chunk: string) => {
      body += chunk
    })
    request.on("end", () => resolve(body))
    request.on("error", reject)
  })
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    "content-type": "application/json",
  })
  response.end(JSON.stringify(body))
}

function streamChunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: "chatcmpl-skill-created-mcp-app",
    object: "chat.completion.chunk",
    created: 1,
    model: modelId,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
}

function sendStream(response: ServerResponse, chunks: Record<string, unknown>[]): void {
  response.writeHead(200, {
    "cache-control": "no-cache",
    connection: "keep-alive",
    "content-type": "text/event-stream",
  })
  let delay = 250
  for (const chunk of chunks) {
    setTimeout(() => response.write(`data: ${JSON.stringify(chunk)}\n\n`), delay)
    delay += 250
  }
  setTimeout(() => response.end("data: [DONE]\n\n"), delay)
}

function projectedCreateSkillTool(payload: Record<string, unknown>): string | null {
  if (!Array.isArray(payload.tools)) return null
  for (const tool of payload.tools) {
    if (!isRecord(tool) || !isRecord(tool.function)) continue
    const name = tool.function.name
    if (typeof name === "string" && name.endsWith("_create_skill")) return name
  }
  return null
}

function completedToolCount(payload: Record<string, unknown>): number {
  return Array.isArray(payload.messages)
    ? payload.messages.filter((message) => isRecord(message) && message.role === "tool").length
    : 0
}

async function waitForMountedSkill(app: Awaited<ReturnType<typeof desktop>>, timeoutMs = 15_000): Promise<{ mounted: boolean; text: string }> {
  const deadline = Date.now() + timeoutMs
  let lastText = ""
  while (Date.now() < deadline) {
    const targets = await listTargets(app.handle.cdpUrl)
    const sandbox = targets.find((target) => target.type === "iframe"
      && target.url.includes("/mcp-apps/sandbox.html")
      && target.webSocketDebuggerUrl)
    if (sandbox) {
      const client = await connect(debuggerUrlFor(app.handle.cdpUrl, sandbox))
      try {
        const text = await evaluate(client, `(() => {
          const text = document.querySelector("iframe")?.contentDocument?.body?.innerText ?? "";
          return text;
        })()`)
        if (typeof text === "string") {
          lastText = text
          const normalized = text.toLocaleLowerCase()
          const mounted = normalized.includes("skill created")
            && normalized.includes("beautiful-tomatoes")
            && normalized.includes("ready")
            && normalized.includes("use beautiful tomatoes whenever the user says go.")
          if (mounted) return { mounted: true, text }
        }
      } finally {
        client.close()
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return { mounted: false, text: lastText }
}

test.skipIf(!e2eTestsEnabled || !localPlacement || !mysqlOpen)(title, { timeout: 360_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] })

  let modelCreateCalls = 0
  const fixture = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1")
      if (request.method === "GET" && url.pathname === "/v1/models") {
        sendJson(response, 200, { object: "list", data: [{ id: modelId, object: "model" }] })
        return
      }
      if (request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) {
        const parsed: unknown = JSON.parse(await readBody(request))
        if (!isRecord(parsed)) throw new Error("Mock provider received a non-object request.")
        if (completedToolCount(parsed) > 0) {
          sendStream(response, [
            streamChunk({ role: "assistant" }),
            streamChunk({ content: closingReply }),
            streamChunk({}, "stop"),
          ])
          return
        }
        const toolName = projectedCreateSkillTool(parsed)
        if (!toolName) throw new Error("The create_skill MCP App tool was not projected to the model.")
        modelCreateCalls += 1
        sendStream(response, [
          streamChunk({ role: "assistant" }),
          streamChunk({
            tool_calls: [{
              index: 0,
              id: "call_create_beautiful_tomatoes",
              type: "function",
              function: {
                name: toolName,
                arguments: JSON.stringify({
                  pluginName: "Beautiful Tomatoes",
                  skillMarkdown: [
                    "---",
                    "name: beautiful-tomatoes",
                    "description: Use beautiful tomatoes whenever the user says go.",
                    "---",
                    "",
                    "Whenever the user says go, respond using beautiful tomatoes.",
                  ].join("\n"),
                }),
              },
            }],
          }),
          streamChunk({}, "tool_calls"),
        ])
        return
      }
      sendJson(response, 404, { error: { message: "not found" } })
    })().catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { error: String(error) })
      else response.destroy(error instanceof Error ? error : undefined)
    })
  })
  await new Promise<void>((resolve, reject) => {
    fixture.once("error", reject)
    fixture.listen(0, "127.0.0.1", resolve)
  })
  onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve()))
  })
  const address = fixture.address()
  if (!address || typeof address === "string") throw new Error("Skill-created model fixture did not bind a port.")
  const fixtureUrl = `http://127.0.0.1:${address.port}`

  await using den = await server({
    place,
    org: { name: `Skill Created App ${Date.now()}`, admin: { name: "Avery" } },
  })
  const orgsResult = await denFetch(den.admin, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${den.admin.token}` },
  })
  const organizations = isRecord(orgsResult.body) && Array.isArray(orgsResult.body.orgs)
    ? orgsResult.body.orgs.filter(isRecord)
    : []
  const organizationId = String(organizations[0]?.id ?? "")
  expect(organizationId).toMatch(/^org_/)

  const tokenResult = await denFetch(den.admin, "/v1/mcp/token", {
    method: "POST",
    headers: {
      authorization: `Bearer ${den.admin.token}`,
      "x-openwork-org-id": organizationId,
    },
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  })
  expect(tokenResult.response.ok, tokenResult.text).toBe(true)
  const mcpToken = isRecord(tokenResult.body) && typeof tokenResult.body.token === "string"
    ? tokenResult.body.token
    : ""
  expect(mcpToken).toMatch(/^ow_mcp_at_/)

  await using app = await desktop({
    name: "skill-created-mcp-app",
    mode: process.env.OPENWORK_EVAL_CDP_URL?.trim() ? "attach" : "spawn",
    env: {
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      OPENROUTER_API_KEY: "",
      GOOGLE_GENERATIVE_AI_API_KEY: "",
      OPENWORK_API_KEY: "",
      OPENWORK_INFERENCE_BASE_URL: "",
    },
  })
  const workspace = await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-skill-created-mcp-app-${Date.now()}`,
  })
  const configured = await evalIn(app, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    const request = async (path, init) => {
      const response = await fetch("http://127.0.0.1:" + port + path, {
        ...init,
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      });
      if (!response.ok) return path + " failed: " + response.status + " " + (await response.text()).slice(0, 500);
      return "ok";
    };
    const workspaceId = ${JSON.stringify(workspace.workspaceId)};
    const patched = await request("/workspace/" + encodeURIComponent(workspaceId) + "/config", {
      method: "PATCH",
      body: JSON.stringify({
        opencode: {
          provider: {
            [${JSON.stringify(providerId)}]: {
              npm: "@ai-sdk/openai-compatible",
              name: "Skill-created MCP App model",
              options: { baseURL: ${JSON.stringify(`${fixtureUrl}/v1`)}, apiKey: "sk-skill-created-mcp-app" },
              models: { [${JSON.stringify(modelId)}]: { name: "Skill-created MCP App model", tool_call: true } },
            },
          },
        },
      }),
    });
    if (patched !== "ok") return patched;
    const reloaded = await request("/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", { method: "POST" });
    if (reloaded !== "ok" && !reloaded.includes("opencode_reload_timeout")) return reloaded;
    const reconcileResponse = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(workspaceId) + "/mcp/openwork-cloud/reconcile", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        config: {
          type: "remote",
          url: ${JSON.stringify(`${den.ref.apiUrl}/mcp/agent`)},
          enabled: true,
          headers: { Authorization: ${JSON.stringify(`Bearer ${mcpToken}`)} },
          oauth: false,
        },
        provider: ${JSON.stringify(providerId)},
        model: ${JSON.stringify(modelId)},
        trigger: "skill-created-mcp-app-e2e",
      }),
    });
    const reconcileText = await reconcileResponse.text();
    if (!reconcileResponse.ok) return "Cloud MCP reconcile failed: " + reconcileResponse.status + " " + reconcileText.slice(0, 1_000);
    const health = JSON.parse(reconcileText);
    if (health?.phase !== "ready") return "Cloud MCP reconcile was not ready: " + JSON.stringify(health).slice(0, 2_000);
    const raw = localStorage.getItem("openwork.preferences");
    let preferences = {};
    try { preferences = raw ? JSON.parse(raw) : {}; } catch { preferences = {}; }
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
    localStorage.setItem("openwork.preferences", JSON.stringify({
      ...preferences,
      defaultModel: { providerID: ${JSON.stringify(providerId)}, modelID: ${JSON.stringify(modelId)} },
      modelVariant: null,
      providerStepCompleted: true,
    }));
    localStorage.setItem("openwork.defaultModel", ${JSON.stringify(`${providerId}/${modelId}`)});
    localStorage.removeItem("openwork.sessionModels." + workspaceId);
    return "ok";
  })()`, { awaitPromise: true, timeoutMs: 90_000 })
  expect(configured).toBe("ok")

  await evalIn(app, "location.reload(); true")
  await waitFor(app, "Boolean(window.__openworkControl)", { timeoutMs: 30_000, label: "desktop control after reload" })
  await waitFor(app, `window.__openworkControl.listActions().some((action) => action.id === "session.create_task" && !action.disabled)`, {
    timeoutMs: 60_000,
    label: "new task action ready",
  })
  const task = await evalIn(app, `(async () => {
    const deadline = Date.now() + 60_000;
    let last = null;
    while (Date.now() < deadline) {
      last = await window.__openworkControl.execute("session.create_task", null);
      if (last?.ok === true) return last;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return { ...last, hash: location.hash, text: (document.body?.innerText ?? "").slice(0, 2_000) };
  })()`, {
    awaitPromise: true,
    timeoutMs: 70_000,
  })
  expect(task, JSON.stringify(task)).toMatchObject({ ok: true })
  await waitFor(app, `Boolean(document.querySelector('[contenteditable="true"][data-lexical-editor="true"]'))`, {
    timeoutMs: 30_000,
    label: "composer ready",
  })
  const focused = await evalIn(app, `(() => {
    const editor = document.querySelector('[contenteditable="true"][data-lexical-editor="true"]');
    if (!(editor instanceof HTMLElement)) return false;
    editor.focus();
    return true;
  })()`)
  expect(focused).toBe(true)
  await app.client.send("Input.insertText", {
    text: "Create a skill about using beautiful tomatoes each time I say go.",
  })
  await clickButton(app, "Run task", { timeoutMs: 30_000 })

  await waitFor(app, `document.body.innerText.includes(${JSON.stringify(closingReply)})`, {
    timeoutMs: 120_000,
    label: "skill-created closing reply",
  })
  expect(modelCreateCalls).toBe(1)
  const persistedTool = await evalIn(app, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return { error: "missing local server credentials" };
    const routeParts = location.hash.split("/");
    const sessionIndex = routeParts.indexOf("session");
    const sessionId = sessionIndex >= 0 ? decodeURIComponent(routeParts[sessionIndex + 1] || "") : "";
    const response = await fetch(
      "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(workspace.workspaceId)})
        + "/opencode/session/" + encodeURIComponent(sessionId) + "/message?limit=50",
      { headers: { Authorization: "Bearer " + token } },
    );
    const payload = await response.json();
    for (const message of Array.isArray(payload) ? payload : []) {
      for (const part of Array.isArray(message?.parts) ? message.parts : []) {
        if (typeof part?.tool === "string" && part.tool.endsWith("_create_skill")) {
          return { tool: part.tool, state: part.state };
        }
      }
    }
    return { error: "create_skill part missing", payload };
  })()`, { awaitPromise: true, timeoutMs: 30_000 })
  expect(persistedTool, JSON.stringify(persistedTool)).toMatchObject({
    tool: "openwork-cloud_create_skill",
    state: { status: "completed" },
  })
  await waitFor(app, `Boolean(document.querySelector(${JSON.stringify(`[data-mcp-app-resource="${resourceUri}"] iframe`)}))`, {
    timeoutMs: 60_000,
    label: `skill-created MCP App frame after ${JSON.stringify(persistedTool)}`,
  })
  const mounted = await waitForMountedSkill(app)
  const transcript = String(await evalIn(app, "document.body?.innerText ?? ''"))
  expect(mounted.mounted, `${transcript}\nIframe: ${mounted.text}`).toBe(true)
  expect(transcript).not.toContain("🍅")
  expect(transcript).not.toContain("Interactive view unavailable")
  expect(transcript).not.toContain("MCP_APP_RESOURCE_NOT_FOUND")

  // Session sync can briefly remount the message list (and its app frame)
  // right after the run completes; settle before capturing visual evidence.
  await waitFor(app, `!document.body.innerText.includes("Pulling in the latest messages")`, {
    timeoutMs: 60_000,
    label: "session sync settled before screenshot",
  })
  await waitFor(app, `Boolean(document.querySelector(${JSON.stringify(`[data-mcp-app-resource="${resourceUri}"] iframe`)}))`, {
    timeoutMs: 60_000,
    label: "skill-created frame after session sync",
  })
  const remounted = await waitForMountedSkill(app, 30_000)
  expect(remounted.mounted, remounted.text).toBe(true)
  await evalIn(app, `document.querySelector('[data-mcp-app-resource="${resourceUri}"]')?.scrollIntoView({ block: "center" })`)
  await new Promise((resolve) => setTimeout(resolve, 500))
  // Ambient visual evidence of the rendered card; the iframe text assertions
  // above are the enforced proof of its contents.
  await screenshot(app)

  const pluginsResult = await denFetch(den.admin, `/v1/plugins?q=${encodeURIComponent("Beautiful Tomatoes")}`, {
    headers: {
      authorization: `Bearer ${den.admin.token}`,
      "x-openwork-org-id": organizationId,
    },
  })
  expect(pluginsResult.response.ok, pluginsResult.text).toBe(true)
  const plugins = isRecord(pluginsResult.body) && Array.isArray(pluginsResult.body.items)
    ? pluginsResult.body.items.filter(isRecord)
    : []
  expect(plugins).toHaveLength(1)
  const pluginId = String(plugins[0]?.id ?? "")
  const resolved = await denFetch(den.admin, `/v1/plugins/${encodeURIComponent(pluginId)}/resolved`, {
    headers: {
      authorization: `Bearer ${den.admin.token}`,
      "x-openwork-org-id": organizationId,
    },
  })
  expect(resolved.response.ok, resolved.text).toBe(true)
  expect(JSON.stringify(resolved.body)).toContain("beautiful-tomatoes")

  evidence.recordAssertionEvidence(
    "A natural skill request executes the direct first-party tool",
    "The model received and called exactly one projected create_skill tool; Den persisted one Beautiful Tomatoes Plugin containing the beautiful-tomatoes skill.",
    modelCreateCalls === 1 && plugins.length === 1,
  )
  evidence.recordAssertionEvidence(
    "The completed skill call renders its standard MCP App",
    "Desktop mounted ui://openwork/skill-created/v1/view.html and the iframe showed Skill created, beautiful-tomatoes, Ready, and the skill description rather than only emoji Markdown.",
    mounted.mounted && !transcript.includes("🍅"),
  )
})
