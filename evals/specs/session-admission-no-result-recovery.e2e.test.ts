import { createServer } from "node:http";
import { expect, onTestFinished } from "vitest";
import { control, createAndSelectWorkspace, evalIn, selectModel, waitFor, waitForText } from "@openwork/behaviors";
import { screenshot, validate } from "@openwork/test-evidence";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const providerId = "admission-no-result-mock";
const modelId = "admission-no-result-model";
const prompt = "Run the admission no result reproduction task";
const resumedReply = "admission recovery proof reply";
// First sentence of the interrupted-task recovery prompt sent by Resume.
const recoveryPromptMarker = "Continue the interrupted task from the current state.";
const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = e2eTestsEnabled
  ? "accepted admission that goes idle with no assistant result shows a reload-safe recovery card whose Resume admits exactly one prompt"
  : "session admission no-result recovery skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

const cardExpression = (present: boolean) => `(() => {
  const card = document.querySelector('[data-testid="admission-outcome-unknown"]');
  return ${present ? "Boolean(card)" : "!card"};
})()`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test.skipIf(!e2eTestsEnabled)(title, { timeout: 600_000 }, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  // The completion for the reproduction prompt returns an SSE stream with no
  // visible assistant content (whitespace only), reproducing "accepted, then
  // idle, but no assistant result". Every other completion — title
  // generation and the post-Resume turn (whose conversation contains the
  // recovery prompt) — answers normally so Resume can finish the task.
  const mock = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model" }] }));
      return;
    }

    if (request.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        const empty = body.includes(prompt) && !body.includes(recoveryPromptMarker);
        const chunks = [
          { id: "chatcmpl-admission-no-result", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
          { id: "chatcmpl-admission-no-result", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: empty ? " " : resumedReply }, finish_reason: null }] },
          { id: "chatcmpl-admission-no-result", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ];
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
      });
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
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

  // Blank ambient provider keys so the run cannot fall back to a real model:
  // this reproduction depends on the mock provider producing no visible
  // assistant result.
  await using app = await desktop({
    name: "admission-no-result",
    env: {
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      OPENROUTER_API_KEY: "",
      GOOGLE_GENERATIVE_AI_API_KEY: "",
      OPENWORK_API_KEY: "",
      OPENWORK_INFERENCE_BASE_URL: "",
    },
  });
  const workspace = await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-admission-no-result-${Date.now()}`,
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
              name: "Admission no result mock",
              options: { baseURL: ${JSON.stringify(baseUrl)}, apiKey: "sk-admission-no-result" },
              models: {
                [${JSON.stringify(modelId)}]: { name: "Admission no result model" },
              },
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
    localStorage.removeItem("openwork.sessionModels." + workspaceId);
    return "ok";
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  expect(configured).toBe("ok");

  await control(app, "session.create_task");
  await waitFor(app, `window.__openworkControl.listActions().some((action) => action.id === "composer.set_text" && !action.disabled)`, {
    timeoutMs: 30_000,
    label: "composer text action enabled",
  });
  // Pin the session to the mock model through the picker: ambient free models
  // can otherwise win the default-model resolution and answer for real.
  const pinned = await selectModel(app, "Admission no result model");
  expect(pinned.selected, `mock model not selected: ${JSON.stringify(pinned)}`).toBe(true);
  await control(app, "composer.set_text", { text: prompt });
  await waitFor(app, `window.__openworkControl.listActions().some((action) => action.id === "composer.send" && !action.disabled)`, {
    timeoutMs: 30_000,
    label: "composer send action enabled",
  });
  const admittedAt = Date.now();
  await control(app, "composer.send");

  // Admission accepted: the user message was created and is rendered.
  await waitForText(app, prompt, { timeoutMs: 60_000 });
  evidence.recordAssertionEvidence(
    "The session, admission, and user message were created",
    "After composer.send the prompt text was rendered as a user message in the new session's transcript.",
    true,
  );

  // The run goes idle with no assistant result (whitespace-only completion).
  // The terminal invariant must produce an actionable recovery card instead
  // of silently clearing the wait state.
  await waitFor(app, cardExpression(true), {
    timeoutMs: 60_000,
    label: "admission outcome recovery card appeared after idle with no assistant result",
  });
  const cardShownAfterMs = Date.now() - admittedAt;
  const assistantReplyVisible = await evalIn(app, `document.body.innerText.includes(${JSON.stringify(resumedReply)})`);
  expect(assistantReplyVisible, "no assistant reply must be visible before resume").toBe(false);
  evidence.recordAssertionEvidence(
    "Idle without an assistant result surfaces an actionable recovery card",
    `The session reached idle with no visible assistant output and the accepted-but-outcome-unknown recovery card appeared ${Math.round(cardShownAfterMs / 100) / 10}s after admission, instead of silently clearing the wait state.`,
    true,
  );
  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      `The user's message '${prompt}' is visible in the conversation with no assistant reply below it`,
      "A status line saying the task was accepted but no result arrived is visible with a Resume action",
      "No crash or blank screen is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  // Reload before resuming: the recovery information must survive because it
  // derives from the server-persisted transcript, not component memory.
  const previousTimeOrigin = await evalIn(app, "performance.timeOrigin");
  expect(typeof previousTimeOrigin).toBe("number");
  await evalIn(app, "location.reload(); true").catch(() => undefined);
  await waitFor(app, `performance.timeOrigin !== ${JSON.stringify(previousTimeOrigin)}`, {
    timeoutMs: 30_000,
    label: "renderer reloaded",
  });
  await waitForText(app, prompt, { timeoutMs: 60_000 });
  await waitFor(app, cardExpression(true), {
    timeoutMs: 60_000,
    label: "recovery card re-derived after reload",
  });
  evidence.recordAssertionEvidence(
    "The recovery state survives a reload before resuming",
    "After location.reload() the rehydrated transcript re-derived the same accepted-but-outcome-unknown recovery card for the unanswered user message.",
    true,
  );

  // Rapid double click on Resume: the single-flight guard must admit exactly
  // one recovery prompt.
  const clicked = await evalIn(app, `(() => {
    const button = document.querySelector('[data-testid="admission-outcome-resume"]');
    if (!button) return "missing resume button";
    button.click();
    button.click();
    return "ok";
  })()`);
  expect(clicked).toBe("ok");

  await waitForText(app, resumedReply, { timeoutMs: 120_000 });
  await waitFor(app, cardExpression(false), {
    timeoutMs: 30_000,
    label: "recovery card cleared after assistant output arrived",
  });
  await sleep(2_000);
  const recoveryPromptCount = await evalIn(app, `(() => {
    const text = document.body.innerText;
    let count = 0;
    let index = text.indexOf(${JSON.stringify(recoveryPromptMarker)});
    while (index !== -1) {
      count += 1;
      index = text.indexOf(${JSON.stringify(recoveryPromptMarker)}, index + 1);
    }
    return count;
  })()`);
  expect(recoveryPromptCount, "exactly one recovery prompt admitted for two rapid clicks").toBe(1);
  evidence.recordAssertionEvidence(
    "Two rapid Resume clicks admit exactly one recovery prompt",
    `After a rapid double click the transcript contains exactly one recovery prompt (count=${String(recoveryPromptCount)}), the assistant produced '${resumedReply}', and the recovery card cleared once assistant output arrived.`,
    true,
  );

  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      `The assistant reply '${resumedReply}' is visible in the conversation`,
      "Exactly one resume/recovery user message is visible between the original prompt and the assistant reply",
      "No status line about a missing result is visible anymore",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
});
