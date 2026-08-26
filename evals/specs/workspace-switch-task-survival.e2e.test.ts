import { expect } from "vitest";
import {
  control,
  evalIn,
  readAvailableModels,
  selectModel,
  sendComposerMessage,
  waitFor,
} from "@openwork/behaviors";
import { screenshot } from "@openwork/test-evidence";
import { app, needs, server, test, unmetNeeds } from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

/**
 * ACCEPTANCE TAPE — retargeting the desktop runtime to another workspace
 * keeps the embedded server and its engine alive, so a task still running in
 * the workspace being left completes instead of aborting.
 *
 * This is the Settings-navigation regression: any surface that re-anchors the
 * runtime on a different workspace (opening Settings while another workspace
 * is routed, workspace switches during boot) used to tear the whole runtime
 * down through engineStart's identity guard, killing every in-flight run.
 * engineStart with a different projectDir must reuse the healthy server and
 * only retarget it.
 */

const requirements: TestNeeds = {
  env: ["ANTHROPIC_API_KEY"],
  optIn: ["OPENWORK_EVAL_E2E_TESTS", "OPENWORK_EVAL_WORKSPACE_SWITCH_E2E_TEST"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `workspace switch task survival skipped — needs: ${missingRequirements.join(", ")}`
  : "a live task survives retargeting the desktop runtime to another workspace";

const COMPLETE_MARKER = "WORKSPACE-SWITCH-TASK-COMPLETE";
const stopEnabledExpression = `(() => {
  const stop = window.__openworkControl?.listActions().find((action) => action.id === "composer.stop");
  return Boolean(stop && !stop.disabled);
})()`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNumber(value: unknown, key: string): number | null {
  if (!isRecord(value)) return null;
  const candidate = value[key];
  return typeof candidate === "number" ? candidate : null;
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
  if (!chosen) throw new Error("No selectable model was available for the workspace switch tape.");
  await selectModel(desktopApp, chosen.id);

  const serverInfoExpression = `window.__OPENWORK_ELECTRON__.invokeDesktop("openworkServerInfo")`;
  const initialServerInfo = await evalIn(desktopApp, serverInfoExpression, { awaitPromise: true });
  const initialGeneration = readNumber(initialServerInfo, "generation");
  expect(isRecord(initialServerInfo) && initialServerInfo.running === true).toBe(true);
  expect(initialGeneration).not.toBeNull();

  const initialEngine = await evalIn(
    desktopApp,
    `window.__OPENWORK_ELECTRON__.invokeDesktop("engineInfo")`,
    { awaitPromise: true },
  );
  const initialEnginePid = readNumber(initialEngine, "pid");
  const initialProjectDir = isRecord(initialEngine) ? initialEngine.projectDir : null;
  expect(initialEnginePid).not.toBeNull();
  expect(typeof initialProjectDir).toBe("string");

  await control(desktopApp, "session.create_task");
  await sendComposerMessage(desktopApp, [
    "Run the bash command `sleep 45 && echo workspace-switch-task-done`.",
    "Wait for it to finish, then reply with exactly:",
    COMPLETE_MARKER,
  ].join(" "));
  await waitFor(desktopApp, stopEnabledExpression, { timeoutMs: 60_000, label: "long task became active" });

  // The regression trigger: ask the desktop runtime to start the engine for a
  // different workspace while the task is still running. This is the same
  // call the renderer issues when Settings or boot re-anchors the runtime.
  const otherWorkspaceName = `openwork-switch-target-${Date.now()}`;
  const otherWorkspaceRoot = `/tmp/${otherWorkspaceName}`;
  const retargeted = await evalIn(
    desktopApp,
    `window.__OPENWORK_ELECTRON__.invokeDesktop("engineStart", ${JSON.stringify(otherWorkspaceRoot)})`,
    { awaitPromise: true, timeoutMs: 60_000 },
  );
  expect(isRecord(retargeted) && retargeted.running === true).toBe(true);
  const retargetedProjectDir = isRecord(retargeted) && typeof retargeted.projectDir === "string"
    ? retargeted.projectDir
    : "";
  expect(retargetedProjectDir).toContain(otherWorkspaceName);

  const serverInfoAfterSwitch = await evalIn(desktopApp, serverInfoExpression, { awaitPromise: true });
  const generationAfterSwitch = readNumber(serverInfoAfterSwitch, "generation");
  evidence.recordAssertionEvidence(
    "The workspace switch reuses the running embedded server instead of restarting it",
    `Server generation before: ${initialGeneration}; after engineStart(${otherWorkspaceRoot}): ${generationAfterSwitch}.`,
    generationAfterSwitch === initialGeneration,
  );
  expect(generationAfterSwitch).toBe(initialGeneration);

  const engineAfterSwitch = await evalIn(
    desktopApp,
    `window.__OPENWORK_ELECTRON__.invokeDesktop("engineInfo")`,
    { awaitPromise: true },
  );
  const enginePidAfterSwitch = readNumber(engineAfterSwitch, "pid");
  evidence.recordAssertionEvidence(
    "The engine process serving the live task is reused across the workspace switch",
    `Engine pid before: ${initialEnginePid}; after: ${enginePidAfterSwitch}.`,
    enginePidAfterSwitch === initialEnginePid,
  );
  expect(enginePidAfterSwitch).toBe(initialEnginePid);

  await waitFor(desktopApp, `document.body.innerText.includes(${JSON.stringify(COMPLETE_MARKER)})`, {
    timeoutMs: 300_000,
    label: "live task completed after the workspace switch",
  });
  expect(await evalIn(desktopApp, `!document.body.innerText.includes("The message was interrupted")`)).toBe(true);

  await screenshot(desktopApp);
  evidence.recordAssertionEvidence(
    "The task in the workspace being left completes after the runtime retargets",
    `${COMPLETE_MARKER} rendered with server generation ${generationAfterSwitch} and engine pid ${enginePidAfterSwitch} unchanged.`,
    true,
  );
});
