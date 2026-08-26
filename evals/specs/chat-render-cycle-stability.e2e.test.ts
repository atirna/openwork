import { createServer } from "node:http";
import { expect, onTestFinished } from "vitest";
import type { Surface } from "@openwork/cdp";
import { control, createAndSelectWorkspace, evalIn, waitFor, waitForText } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { needs, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

const requirements: TestNeeds = { optIn: ["OPENWORK_EVAL_E2E_TESTS"] };
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `chat render-cycle stability skipped — needs: ${missingRequirements.join(", ")}`
  : "streaming chat keeps unrelated render work bounded";

const providerId = "chat-render-cycle-mock";
const modelId = "chat-render-cycle-model";
const firstReply = "Historical response is complete.";
const firstPrompt = `Reply with exactly: ${firstReply}`;
const streamMarker = "STREAM_RENDER_CYCLE";
const streamChunks = Array.from({ length: 48 }, (_, index) => `chunk-${index + 1} `);
const streamedReply = streamChunks.join("").trim();

type ProfilerFact = {
  commitCount: number;
  renderCount: number;
};

type ProfilerFacts = Record<string, ProfilerFact>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readProfilerFacts(app: Surface): Promise<ProfilerFacts> {
  const value = await evalIn(app, `(() => {
    const zones = window.__openwork.snapshot().profiler.zones;
    return Object.fromEntries(zones.map((zone) => [zone.id, {
      commitCount: zone.commitCount,
      renderCount: zone.renderCount,
    }]));
  })()`);
  if (!isRecord(value)) throw new Error("Profiler facts were not an object.");
  const facts: ProfilerFacts = {};
  for (const [key, fact] of Object.entries(value)) {
    if (
      isRecord(fact)
      && typeof fact.commitCount === "number"
      && typeof fact.renderCount === "number"
    ) {
      facts[key] = {
        commitCount: fact.commitCount,
        renderCount: fact.renderCount,
      };
    }
  }
  return facts;
}

function commitsBetween(before: ProfilerFacts, after: ProfilerFacts, zone: string): number {
  return (after[zone]?.commitCount ?? 0) - (before[zone]?.commitCount ?? 0);
}

function rendersBetween(before: ProfilerFacts, after: ProfilerFacts, zone: string): number {
  return (after[zone]?.renderCount ?? 0) - (before[zone]?.renderCount ?? 0);
}

async function createSession(app: Surface): Promise<string> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const sessionId = await control(app, "session.create_task", undefined, { timeoutMs: 8_000 });
      if (typeof sessionId === "string" && sessionId.trim()) return sessionId;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Session creation did not settle within 60 seconds: ${String(lastError)}`);
}

function completionChunk(responseId: string, content: string, finishReason: string | null) {
  return {
    id: responseId,
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
  };
}

test(title, { timeout: 300_000 }, async ({ evidence }) => {
  needs(requirements);

  const mockRequests: string[] = [];
  let completionIndex = 0;
  const mock = createServer((request, response) => {
    const url = request.url ?? "";
    mockRequests.push(`${request.method ?? "UNKNOWN"} ${url}`);
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || (url !== "/v1/chat/completions" && url !== "/chat/completions")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const streaming = body.includes(streamMarker);
      mockRequests.push(`body streaming=${streaming} length=${body.length}`);
      const chunks = streaming ? streamChunks : [firstReply];
      completionIndex += 1;
      const responseId = `chatcmpl-render-cycle-${completionIndex}`;
      const startDelayMs = streaming ? 0 : body.includes("Reply with exactly") ? 1_000 : 0;
      setTimeout(() => {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        response.write(`data: ${JSON.stringify({
          id: responseId,
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        })}\n\n`);
        let index = 0;
        const writeNext = () => {
          const chunk = chunks[index];
          if (chunk !== undefined) {
            response.write(`data: ${JSON.stringify(completionChunk(responseId, chunk, null))}\n\n`);
            index += 1;
            setTimeout(writeNext, streaming ? 35 : 0);
            return;
          }
          response.write(`data: ${JSON.stringify(completionChunk(responseId, "", "stop"))}\n\n`);
          response.write("data: [DONE]\n\n");
          response.end();
        };
        writeNext();
      }, startDelayMs);
    });
  });
  await new Promise<void>((resolve, reject) => {
    mock.once("error", reject);
    mock.listen(0, "127.0.0.1", resolve);
  });
  onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => mock.close((error) => error ? reject(error) : resolve()));
  });
  const address = mock.address();
  if (!address || typeof address === "string") throw new Error("Mock provider did not bind a TCP port.");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  await using app = await desktop({
    name: "chat-render-cycle-stability",
    env: { VITE_OPENWORK_PROFILER: "1" },
  });
  const workspace = await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-chat-render-cycle-${Date.now()}`,
  });

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
              name: "Chat render-cycle mock",
              options: { baseURL: ${JSON.stringify(baseUrl)}, apiKey: "sk-chat-render-cycle" },
              models: { [${JSON.stringify(modelId)}]: { name: "Chat render-cycle model" } },
            },
          },
        },
      }),
    });
    if (patched !== "ok") return patched;
    const reloaded = await request("/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", { method: "POST" });
    if (reloaded !== "ok") return reloaded;
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
    return "ok";
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  expect(configured).toBe("ok");

  await evalIn(app, `(() => {
    localStorage.setItem("openwork.debug.profiler", "1");
    localStorage.setItem("openwork.debug.profilerOverlay", "1");
    location.reload();
    return true;
  })()`);
  await waitFor(app, `window.__openworkControl.listActions().some((action) => action.id === "session.create_task" && !action.disabled)`, {
    timeoutMs: 60_000,
    label: "session controls restored with profiler enabled",
  });

  await createSession(app);
  await waitFor(app, `window.__openworkControl.listActions().some((action) => action.id === "composer.set_text" && !action.disabled)`, {
    timeoutMs: 30_000,
    label: "composer text control ready for historical turn",
  });
  await control(app, "composer.set_text", { text: firstPrompt });
  await waitFor(app, `window.__openworkControl.listActions().some((action) => action.id === "composer.send" && !action.disabled)`, {
    timeoutMs: 30_000,
    label: "composer send control ready for historical turn",
  });
  await control(app, "composer.send");
  try {
    await waitForText(app, firstReply, { timeoutMs: 30_000 });
  } catch (error) {
    throw new Error(`${String(error)} Mock requests: ${mockRequests.join("; ")}`);
  }
  await waitFor(app, `window.__openworkControl.listActions().some((action) => action.id === "composer.stop" && action.disabled)`, {
    timeoutMs: 30_000,
    label: "historical turn completed",
  });

  await control(app, "composer.set_text", { text: `${streamMarker}: stream the response.` });
  const before = await readProfilerFacts(app);
  await control(app, "composer.send");
  await waitForText(app, streamedReply, { timeoutMs: 60_000 });
  await waitFor(app, `window.__openworkControl.listActions().some((action) => action.id === "composer.stop" && action.disabled)`, {
    timeoutMs: 30_000,
    label: "streaming turn completed",
  });
  const after = await readProfilerFacts(app);

  const messageListCommits = commitsBetween(before, after, "MessageList");
  const composerCommits = commitsBetween(before, after, "SessionComposer");
  const historicalGroupZones = Object.keys(before).filter((zone) => zone.startsWith("MessageGroup:"));
  const historicalGroupRenders = historicalGroupZones.reduce(
    (total, zone) => total + rendersBetween(before, after, zone),
    0,
  );
  expect(messageListCommits).toBeGreaterThan(8);
  expect(composerCommits, `messageListCommits=${messageListCommits}`).toBeLessThanOrEqual(10);
  expect(historicalGroupZones.length).toBeGreaterThan(0);
  expect(historicalGroupRenders).toBeLessThanOrEqual(2);
  evidence.recordAssertionEvidence(
    "Streaming advances the active transcript without repeatedly rendering the composer or completed turns",
    `messageListCommits=${messageListCommits}; composerCommits=${composerCommits}; historicalGroupRenders=${historicalGroupRenders}; streamedChunks=${streamChunks.length}`,
    messageListCommits > 8 && composerCommits <= 10 && historicalGroupRenders <= 2,
  );
});
