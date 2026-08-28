import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePlace } from "./place.ts";
import { parseWorldTopology, usesLiveSharedProductionState } from "./topology.ts";
import { fromSnapshot, parseUntrustedSnapshot, resumeWorld, startWorld } from "./world.ts";
import type {
  ResumedWorldRuntime,
  StartedWorldRuntime,
  WorldRuntimeAdapter,
  WorldSnapshotSummary,
  WorldStartRequest,
} from "@openwork/world";
import type { WorldTopology } from "./topology.ts";
import type { WorldLlmProviderRuntime } from "./world.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const SNAPSHOT_DIRECTORY = join(REPO_ROOT, "evals", "results", ".worlds");

function displayLines(
  topology: WorldTopology,
  den: { ref: { apiUrl: string; webUrl: string } },
  apps: Record<string, { handle: { cdpUrl: string } }>,
  llmProviders: Record<string, WorldLlmProviderRuntime> = {},
): string[] {
  const lines: string[] = [];
  if (!usesLiveSharedProductionState(topology)) {
    lines.push(`den web  ${den.ref.webUrl}`, `den api  ${den.ref.apiUrl}`);
  }
  for (const [name, provider] of Object.entries(llmProviders)) {
    lines.push(
      `litellm ${name}  ${provider.baseUrl}  model ${provider.modelId}  limits ${provider.maxInputTokens}/${provider.maxOutputTokens}  Den ${provider.providerRecordId}`,
    );
  }
  for (const [name, app] of Object.entries(apps)) {
    const signedInTo = topology.apps?.[name]?.signedInTo;
    const signIn = signedInTo ? ` (signed in to ${signedInTo.org} as ${signedInTo.as})` : "";
    lines.push(`app ${name}  CDP ${app.handle.cdpUrl}${signIn}`);
  }
  return lines;
}

function snapshotSummary(text: string): WorldSnapshotSummary {
  const snapshot = parseUntrustedSnapshot(text);
  const orgs = Object.keys(snapshot.topology.den.orgs).join(",") || "(none)";
  const apps = Object.keys(snapshot.topology.apps ?? {}).join(",") || "(none)";
  const shared = usesLiveSharedProductionState(snapshot.topology);
  return {
    name: snapshot.name,
    createdAt: snapshot.createdAt,
    line: `${snapshot.name}  ${snapshot.createdAt}  ${snapshot.place}  orgs ${orgs}  apps ${apps}${shared ? "  LIVE SHARED PRODUCTION STATE" : ""}`,
    ...(shared ? { sharedState: true } : {}),
  };
}

async function start(request: WorldStartRequest): Promise<StartedWorldRuntime> {
  const topology = parseWorldTopology(request.definition.topology);
  const world = await startWorld(topology, {
    place: resolvePlace(process.env),
    name: request.name,
    allowSharedState: request.allowSharedState,
  });
  return {
    name: world.name,
    lines: displayLines(topology, world.den, world.apps, world.llmProviders),
    ...(usesLiveSharedProductionState(topology) ? { sharedState: true } : {}),
    snapshotPath: world.snapshotPath,
    async detach() {
      for (const app of Object.values(world.apps)) app.client.close();
    },
    async dispose() {
      await world[Symbol.asyncDispose]();
    },
  };
}

export function createEvalWorldAdapter(): WorldRuntimeAdapter {
  return {
    id: "eval",
    snapshotDirectory: SNAPSHOT_DIRECTORY,
    start,
    async rebuild(text, options) {
      const snapshot = fromSnapshot(text);
      return start({
        definition: {
          adapter: "eval",
          detached: false,
          requiresSharedState: usesLiveSharedProductionState(snapshot.topology),
          topology: snapshot.topology,
        },
        name: snapshot.name,
        ...options,
      });
    },
    async resume(text, options): Promise<ResumedWorldRuntime> {
      const restored = fromSnapshot(text);
      const snapshot = parseUntrustedSnapshot(text);
      const resumed = await resumeWorld(text, { teardown: options.teardown });
      return {
        name: resumed.name,
        lines: displayLines(restored.topology, resumed.den, resumed.apps),
        ...(usesLiveSharedProductionState(restored.topology) ? { sharedState: true } : {}),
        detach: resumed.detach,
        async teardown() {
          const result = await resumed.teardown();
          const apps = result.apps.join(", ") || "none";
          const denPorts = result.denPorts.join(", ") || "none";
          return [`Stopped world ${JSON.stringify(snapshot.name)}: apps ${apps}; Den ports ${denPorts}; database ${result.database ?? "none"}.`];
        },
      };
    },
    summarize: snapshotSummary,
  };
}

export const evalWorldSnapshotDirectory = SNAPSHOT_DIRECTORY;
