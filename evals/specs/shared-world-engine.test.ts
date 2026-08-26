import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { desktopProductionLive, test } from "@openwork/testkit";
import { discoverWorlds, loadWorldFile, main } from "@openwork/world";
import type { WorldRuntimeAdapter } from "@openwork/world";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORLDS_DIRECTORY = join(REPO_ROOT, "worlds");

test("shared world files are discovered, path-loadable, consent-gated, and detached by default", async ({ evidence }) => {
  const discovered = await discoverWorlds(WORLDS_DIRECTORY);
  assert.deepEqual(discovered.map((world) => world.name), [
    "azure-byok",
    "cross-workspace-split-view",
    "desktop-prod-live",
    "dev-headless",
    "headless-prod-live",
    "remote-session",
  ]);

  const azureByok = await loadWorldFile(join(WORLDS_DIRECTORY, "azure-byok.ts"));
  const crossWorkspaceSplitView = await loadWorldFile(join(WORLDS_DIRECTORY, "cross-workspace-split-view.ts"));
  const devHeadless = await loadWorldFile(join(WORLDS_DIRECTORY, "dev-headless.ts"));
  const headlessProduction = await loadWorldFile(join(WORLDS_DIRECTORY, "headless-prod-live.ts"));
  const desktopProduction = await loadWorldFile(join(WORLDS_DIRECTORY, "desktop-prod-live.ts"));
  assert.equal(azureByok.defaultName, "azure-byok");
  assert.equal(azureByok.definition.adapter, "eval");
  assert.equal(azureByok.definition.detached, true);
  assert.equal(azureByok.definition.requiresSharedState, false);
  assert.equal(crossWorkspaceSplitView.defaultName, "cross-workspace-split-view");
  assert.equal(crossWorkspaceSplitView.definition.adapter, "eval");
  assert.equal(crossWorkspaceSplitView.definition.detached, true);
  assert.equal(crossWorkspaceSplitView.definition.requiresSharedState, false);
  assert.equal(devHeadless.defaultName, "dev-headless");
  assert.equal(devHeadless.definition.detached, true);
  assert.deepEqual(devHeadless.definition.topology, {
    surface: { kind: "headless-web", state: "isolated" },
  });
  assert.equal(headlessProduction.definition.requiresSharedState, true);
  assert.equal(desktopProduction.definition.adapter, "eval");
  assert.deepEqual(desktopProduction.definition.topology, desktopProductionLive.topology);
  const remoteSession = await loadWorldFile(join(WORLDS_DIRECTORY, "remote-session.ts"));
  assert.equal(remoteSession.defaultName, "remote-session");
  assert.equal(remoteSession.definition.adapter, "headless-web");
  assert.equal(remoteSession.definition.detached, true);
  assert.equal(remoteSession.definition.requiresSharedState, false);
  assert.deepEqual(remoteSession.definition.topology, {
    surface: { kind: "headless-web", state: "isolated", workspace: "/tmp/openwork-remote-session-world" },
  });

  let receivedName: string | undefined;
  let receivedAllowSharedState = false;
  let starts = 0;
  let detached = false;
  const adapter: WorldRuntimeAdapter = {
    id: "headless-web",
    snapshotDirectory: join(REPO_ROOT, "tmp", "spec-worlds"),
    async start(received) {
      starts += 1;
      receivedName = received.name;
      receivedAllowSharedState = received.allowSharedState;
      return {
        name: received.name ?? "missing",
        lines: ["fake headless surface"],
        sharedState: true,
        async detach() { detached = true; },
        async dispose() { throw new Error("detached path worlds must not be disposed"); },
      };
    },
    async rebuild() { throw new Error("unused"); },
    async resume() { throw new Error("unused"); },
    summarize() { throw new Error("unused"); },
  };
  const refusedLines: string[] = [];
  const refused = await main(["up", "./worlds/headless-prod-live.ts"], {
    cwd: REPO_ROOT,
    worldsDirectory: WORLDS_DIRECTORY,
    adapters: [adapter],
    print: (line) => refusedLines.push(line),
  });
  assert.equal(refused, 1);
  assert.equal(starts, 0);
  assert.match(refusedLines[0] ?? "", /without explicit --allow-shared-state/);

  const launched = await main([
    "up",
    "./worlds/headless-prod-live.ts",
    "--allow-shared-state",
  ], {
    cwd: REPO_ROOT,
    worldsDirectory: WORLDS_DIRECTORY,
    adapters: [adapter],
    print: () => {},
  });
  assert.equal(launched, 0);
  assert.equal(receivedName, "headless-prod-live");
  assert.equal(receivedAllowSharedState, true);
  assert.equal(detached, true);

  evidence.recordAssertionEvidence(
    "Root world files are auto-discovered and path-loadable",
    "Discovery returned all five approved files, and loading retained each adapter/topology contract.",
    true,
  );
  evidence.recordAssertionEvidence(
    "Path worlds default their name and detached lifecycle",
    "The filename became headless-prod-live and the shell detached without requiring --name or --detach.",
    true,
  );
  evidence.recordAssertionEvidence(
    "Shared production state still requires explicit consent",
    "The adapter was not invoked before --allow-shared-state and received the consent bit after opt-in.",
    true,
  );
});
