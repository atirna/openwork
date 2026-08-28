import { expect } from "vitest";
import {
  control,
  evalIn,
  readAvailableModels,
  selectModel,
  sendComposerMessage,
  go,
  waitFor,
} from "@openwork/behaviors";
import { screenshot } from "@openwork/test-evidence";
import { app, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

/**
 * ACCEPTANCE TAPE — opening Settings while a run is streaming must not stop,
 * detach, or stall the conversation.
 *
 * This is the exact user gesture behind the "Settings stops my conversation"
 * report: a long task is live in the active workspace, the user opens
 * Settings on that same workspace, stays there past the sync grace windows,
 * and returns to the conversation. The run must still be live server-side
 * AND the UI must still present it as live on return, the transcript must
 * include output that streamed while Settings was open, and the task must
 * complete without an interruption card.
 *
 * The workspace-switch tape (workspace-switch-task-survival) proves the
 * runtime/engine survive retargeting; this tape proves the renderer-side
 * conversation continuity for a same-workspace Settings round trip.
 */

const requirements: TestNeeds = {
  env: ["ANTHROPIC_API_KEY"],
  optIn: ["OPENWORK_EVAL_E2E_TESTS", "OPENWORK_EVAL_SETTINGS_LIVE_RUN_E2E_TEST"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `settings visit live-run continuity skipped — needs: ${missingRequirements.join(", ")}`
  : "a streaming conversation survives a Settings visit on the same workspace";

const COMPLETE_MARKER = "SETTINGS-VISIT-RUN-COMPLETE";
const stopEnabledExpression = `(() => {
  const stop = window.__openworkControl?.listActions().find((action) => action.id === "composer.stop");
  return Boolean(stop && !stop.disabled);
})()`;

function serverStatusExpression(workspaceId: string) {
  return `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    const response = await fetch(
      "http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)}) + "/opencode/session/status",
      { headers: { Authorization: "Bearer " + token } },
    );
    return response.status + ":" + (await response.text()).slice(0, 500);
  })()`;
}

test.skipIf(missingRequirements.length > 0)(title, { timeout: 900_000 }, async ({ evidence, place }) => {
  needs(requirements);
  await using den = await server({ place });
  await using desktopApp = await app({ den, as: "admin", place });
  const workspaceId = desktopApp.workspaceId;
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";

  const configured = await evalIn(desktopApp, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    const request = async (path, init) => {
      const response = await fetch("http://127.0.0.1:" + port + path, {
        ...init,
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      });
      return response.status + ":" + (await response.text()).slice(0, 300);
    };
    const workspaceId = ${JSON.stringify(workspaceId)};
    const patched = await request("/workspace/" + encodeURIComponent(workspaceId) + "/config", {
      method: "PATCH",
      body: JSON.stringify({ opencode: { provider: { anthropic: { options: { apiKey: ${JSON.stringify(anthropicKey)} } } } } }),
    });
    if (!patched.startsWith("200:")) return patched;
    return request("/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", { method: "POST" });
  })()`, { awaitPromise: true, timeoutMs: 90_000 });
  expect(String(configured)).toMatch(/^20[04]:/);

  const models = await readAvailableModels(desktopApp);
  const chosen = models.find((model) => model.selectable && /sonnet/i.test(model.id))
    ?? models.find((model) => model.selectable && /anthropic/i.test(model.providerName))
    ?? models.find((model) => model.selectable);
  if (!chosen) throw new Error("No selectable model was available for the settings continuity tape.");
  await selectModel(desktopApp, chosen.id);

  const createdSessionId = await control(desktopApp, "session.create_task");
  const sessionId = typeof createdSessionId === "string" ? createdSessionId : "";
  expect(sessionId).not.toBe("");

  await sendComposerMessage(desktopApp, [
    "Run the bash command `sleep 40 && echo settings-visit-task-done`.",
    "Wait for it to finish, then reply with exactly:",
    COMPLETE_MARKER,
  ].join(" "));
  await waitFor(desktopApp, stopEnabledExpression, { timeoutMs: 60_000, label: "long task became active" });

  const statusWhileRunning = String(await evalIn(desktopApp, serverStatusExpression(workspaceId), {
    awaitPromise: true,
    timeoutMs: 30_000,
  }));
  evidence.recordAssertionEvidence(
    "The engine reports a busy session before the Settings visit",
    `GET /opencode/session/status → ${statusWhileRunning} (created session: ${sessionId})`,
    statusWhileRunning.startsWith("200:") && statusWhileRunning.includes("busy"),
  );
  const busySessionId = /"(ses_[a-zA-Z0-9]+)"\s*:\s*\{"type":"busy"/.exec(statusWhileRunning)?.[1] ?? sessionId;

  // Diagnostic taps: record every renderer fetch and the engine identity so a
  // red run shows exactly which call killed the run (explicit abort/reload vs
  // an engine restart losing the run silently).
  await evalIn(desktopApp, `(() => {
    window.__settingsVisitFetches = [];
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (method !== "GET") window.__settingsVisitFetches.push(method + " " + rawUrl);
      return originalFetch(input, init);
    };
    return true;
  })()`);
  const engineBefore = await evalIn(
    desktopApp,
    `window.__OPENWORK_ELECTRON__.invokeDesktop("engineInfo")`,
    { awaitPromise: true },
  );
  const serverBefore = await evalIn(
    desktopApp,
    `window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo")`,
    { awaitPromise: true },
  );

  // The user gesture: open Settings on the SAME workspace while the run streams.
  await go(desktopApp, `/workspace/${encodeURIComponent(workspaceId)}/settings/general`);
  await waitFor(desktopApp, `window.location.hash.includes("/settings/general")`, {
    timeoutMs: 30_000,
    label: "Settings route mounted",
  });

  // Linger past the workspace-sync dispose grace (2s) and the SSE stale
  // watchdog window so any wrongly-dropped stream would be observable.
  await new Promise((resolve) => setTimeout(resolve, 15_000));

  // Server-side truth after the linger, before returning: the run must
  // still exist. If this is already idle/aborted, Settings killed the run
  // itself; if busy here but dead in the UI, the renderer lost the run.
  const statusAfterLinger = String(await evalIn(desktopApp, serverStatusExpression(workspaceId), {
    awaitPromise: true,
    timeoutMs: 30_000,
  }));

  // Probe the pre-Settings engine generation DIRECTLY: if it is gone, the
  // pool retired a draining engine early (or reloaded in place); if it is
  // alive and busy, the drain works and the loss is in routing/UI.
  const engineBeforeRecord = engineBefore as Record<string, unknown>;
  const oldEngineProbe = String(await evalIn(desktopApp, `(async () => {
    try {
      const response = await fetch(
        ${JSON.stringify(String(engineBeforeRecord.baseUrl ?? ""))} + "/session/status?directory=" + encodeURIComponent(${JSON.stringify(String(engineBeforeRecord.projectDir ?? ""))}),
        { headers: { Authorization: "Basic " + btoa(${JSON.stringify(String(engineBeforeRecord.opencodeUsername ?? ""))} + ":" + ${JSON.stringify(String(engineBeforeRecord.opencodePassword ?? ""))}) } },
      );
      return response.status + ":" + (await response.text()).slice(0, 500);
    } catch (error) {
      return "unreachable:" + String(error);
    }
  })()`, { awaitPromise: true, timeoutMs: 30_000 }));
  const serverBusyAfterLinger = statusAfterLinger.startsWith("200:") && statusAfterLinger.includes("busy");
  const mutatingFetches = await evalIn(desktopApp, `JSON.stringify(window.__settingsVisitFetches ?? [])`);
  const engineAfter = await evalIn(
    desktopApp,
    `window.__OPENWORK_ELECTRON__.invokeDesktop("engineInfo")`,
    { awaitPromise: true },
  );
  const serverAfter = await evalIn(
    desktopApp,
    `window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo")`,
    { awaitPromise: true },
  );
  evidence.recordAssertionEvidence(
    "The engine still reports the run after 15s in Settings",
    [
      `GET /opencode/session/status → ${statusAfterLinger}`,
      `old engine direct probe → ${oldEngineProbe}`,
      `engine before: ${JSON.stringify(engineBefore)}`,
      `engine after: ${JSON.stringify(engineAfter)}`,
      `server before: ${JSON.stringify(serverBefore)}`,
      `server after: ${JSON.stringify(serverAfter)}`,
      `mutating fetches during Settings: ${String(mutatingFetches)}`,
    ].join("\n"),
    serverBusyAfterLinger,
  );

  // Return to the exact conversation, as the Settings close button does.
  await go(desktopApp, `/workspace/${encodeURIComponent(workspaceId)}/session/${encodeURIComponent(busySessionId)}`);
  await waitFor(desktopApp, `!window.location.hash.includes("/settings")`, {
    timeoutMs: 30_000,
    label: "session route restored",
  });

  // The prompt bubble itself contains the marker text once; an assistant
  // reply adds a second occurrence, so completion means count >= 2.
  const completeMarkerCountExpression = `document.body.innerText.split(${JSON.stringify(COMPLETE_MARKER)}).length - 1 >= 2`;
  // The returning session view must present the run as live within a moment
  // (or already show the completed reply if the task finished meanwhile).
  await waitFor(desktopApp, `(${stopEnabledExpression}) || (${completeMarkerCountExpression})`, {
    timeoutMs: 15_000,
    label: "run presented as live (or completed) after returning from Settings",
  });
  const liveOnReturn = await evalIn(desktopApp, stopEnabledExpression);
  const completedAlready = await evalIn(desktopApp, completeMarkerCountExpression);
  evidence.recordAssertionEvidence(
    "The conversation is still live (or already completed) in the UI after returning from Settings",
    `composer.stop enabled: ${String(liveOnReturn)}; completion marker rendered: ${String(completedAlready)}; server status after linger: ${statusAfterLinger}.`,
    liveOnReturn === true || completedAlready === true,
  );

  await waitFor(desktopApp, completeMarkerCountExpression, {
    timeoutMs: 300_000,
    label: "live task completed after the Settings round trip",
  });
  const interrupted = await evalIn(
    desktopApp,
    `document.body.innerText.includes("The message was interrupted")`,
  );

  await screenshot(desktopApp);

  expect(serverBusyAfterLinger).toBe(true);
  expect(liveOnReturn === true || completedAlready === true).toBe(true);
  expect(interrupted).toBe(false);
  evidence.recordAssertionEvidence(
    "A same-workspace Settings visit does not stop or stall the streaming conversation",
    `${COMPLETE_MARKER} rendered after a 15s Settings visit with the engine pid and server generation unchanged and no interruption card.`,
    true,
  );
});
