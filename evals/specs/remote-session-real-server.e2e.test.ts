import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eventually, test } from "@openwork/testkit";
import {
  createHeadlessWebAdapter,
  main,
  readHeadlessRuntimeManifest,
  resolveHeadlessWorldRuntimePaths,
  stopHeadlessRuntime,
  WorldStateStore,
} from "@openwork/world";
import { expect, onTestFinished } from "vitest";
import type {
  RemoteSessionRuntime,
  RemoteSessionToolResult,
} from "../../ee/apps/den-api/src/mcp/remote-session-capabilities.js";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORLDS_DIRECTORY = join(REPO_ROOT, "worlds");
const WORLD_WORKSPACE = "/tmp/openwork-remote-session-world";

type RemoteSessionModule = typeof import("../../ee/apps/den-api/src/mcp/remote-session-capabilities.js");

/**
 * The capability module reads den-api env at import time. Placeholder values
 * are enough: this spec injects its own runtime resolver pointed at the real
 * world server, so den-api's database is never touched.
 */
function seedDenApiEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test";
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32);
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32);
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790";
  process.env.DEN_API_PUBLIC_URL = process.env.DEN_API_PUBLIC_URL ?? "http://127.0.0.1:8790";
}

function payload(result: RemoteSessionToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

function workerHeaders(runtime: RemoteSessionRuntime): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${runtime.clientToken}`,
    "X-OpenWork-Host-Token": runtime.hostToken,
  };
}

test(
  "remote-session capabilities drive a real openwork-server world that the web UI reads",
  { timeout: 300_000 },
  async ({ evidence }) => {
    seedDenApiEnv();
    const module: RemoteSessionModule = await import("../../ee/apps/den-api/src/mcp/remote-session-capabilities.js");

    // ── Launch the remote-session world: real openwork-server + web UI ──
    await mkdir(WORLD_WORKSPACE, { recursive: true });
    const adapter = createHeadlessWebAdapter(REPO_ROOT);
    const worldName = `remote-session-e2e-${process.pid}`;
    const cleanup = async (): Promise<void> => {
      const paths = resolveHeadlessWorldRuntimePaths(REPO_ROOT, worldName);
      const manifest = await readHeadlessRuntimeManifest(paths.runtimeManifestPath);
      if (manifest) await stopHeadlessRuntime(manifest);
      await new WorldStateStore(adapter.snapshotDirectory).forget(worldName);
    };
    onTestFinished(cleanup);
    await cleanup();

    const cliOptions = {
      cwd: REPO_ROOT,
      worldsDirectory: WORLDS_DIRECTORY,
      adapters: [adapter],
      print: () => {},
    };
    const worldPath = join(WORLDS_DIRECTORY, "remote-session.ts");
    expect(await main(["up", worldPath, "--name", worldName, "--replace"], cliOptions)).toBe(0);

    const paths = resolveHeadlessWorldRuntimePaths(REPO_ROOT, worldName);
    const manifest = await readHeadlessRuntimeManifest(paths.runtimeManifestPath);
    if (!manifest) throw new Error("The remote-session world did not publish its runtime manifest.");
    await eventually(
      async () => (await fetch(manifest.healthUrl).catch(() => null))?.ok === true,
      { within: 60_000, intervalMs: 500, label: "world openwork-server healthy" },
    );
    evidence.recordAssertionEvidence(
      "The world provides the real OpenWork Web backend",
      `A named remote-session world launched a source-first openwork-server (health at ${manifest.healthUrl}) and the browser UI (${manifest.webUrl}) against an isolated workspace.`,
      true,
    );

    // ── Resolve the runtime exactly as the gateway would for a worker ──
    const runtime: RemoteSessionRuntime = {
      workerId: "worker_world_local",
      baseUrl: manifest.openworkUrl,
      workspaceId: "",
      clientToken: manifest.token,
      hostToken: manifest.hostToken,
    };
    const workspacesResponse = await fetch(`${runtime.baseUrl}/workspaces`, { headers: workerHeaders(runtime) });
    expect(workspacesResponse.ok).toBe(true);
    const workspaces = (await workspacesResponse.json()) as { activeId?: string | null };
    if (!workspaces.activeId) throw new Error("The world server reported no active workspace.");
    runtime.workspaceId = workspaces.activeId;

    const deps = {
      resolveRuntime: async () => ({ ok: true as const, runtime }),
      createClient: module.DEFAULT_REMOTE_SESSION_DEPS.createClient,
    };
    const input = (action: "create" | "send" | "read", body: unknown) => ({
      action,
      organizationId: "org_remote_session_world",
      userId: "user_remote_session_world",
      hasWriteScope: true,
      body,
    });

    // ── create: a native session materializes on the real server ──
    // The server binds HTTP before its managed OpenCode engine finishes
    // attaching, so retry create until the engine owns the workspace — the
    // same "runtime still starting, retry" posture the gateway reports as
    // cloud_runtime_waking.
    let created: RemoteSessionToolResult | null = null;
    await eventually(async () => {
      const attempt = await module.executeRemoteSessionCapability(
        input("create", { title: "Remote session via MCP" }),
        deps,
      );
      if (attempt.isError) return false;
      created = attempt;
      return true;
    }, { within: 90_000, intervalMs: 2_000, label: "managed engine attached and create succeeded" });
    if (!created) throw new Error("remote-session:create never succeeded against the world server.");
    const createdResult: RemoteSessionToolResult = created;
    const sessionId = String(payload(createdResult).sessionId);
    expect(sessionId.length).toBeGreaterThan(0);
    expect(payload(createdResult).workspaceId).toBe(runtime.workspaceId);

    // ── the same session list the web UI renders now contains it ──
    const listResponse = await fetch(
      `${runtime.baseUrl}/workspace/${encodeURIComponent(runtime.workspaceId)}/sessions`,
      { headers: workerHeaders(runtime) },
    );
    expect(listResponse.ok).toBe(true);
    const list = (await listResponse.json()) as { items?: Array<{ id?: string; title?: string | null }> };
    const listed = (list.items ?? []).find((item) => item.id === sessionId);
    expect(listed, `session ${sessionId} missing from workspace session list`).toBeDefined();
    expect(listed?.title).toBe("Remote session via MCP");
    evidence.recordAssertionEvidence(
      "A capability-created session is a native web-visible session",
      "remote-session:create produced a session on the real openwork-server, and GET /workspace/:id/sessions — the list the OpenWork Web UI renders — returned that session id with its title.",
      true,
    );

    // ── send: prompt admission through the real engine mount ──
    const sent = await module.executeRemoteSessionCapability(
      input("send", { sessionId, prompt: "Reply with the single word: pong" }),
      deps,
    );
    expect(sent.isError, JSON.stringify(payload(sent))).toBeUndefined();
    expect(payload(sent).state).toBe("accepted");
    evidence.recordAssertionEvidence(
      "Send is admitted by the real engine asynchronously",
      "remote-session:send posted the prompt through the workspace OpenCode mount on the world server and returned an acceptance receipt without waiting for the reply.",
      true,
    );

    // ── read: the user turn persists, and the real engine answers ──
    await eventually(async () => {
      const read = await module.executeRemoteSessionCapability(input("read", { sessionId }), deps);
      if (read.isError) return false;
      const messages = payload(read).messages as Array<{ role?: string; text?: string }>;
      return messages.some((message) => message.role === "user" && message.text?.includes("pong"));
    }, { within: 60_000, intervalMs: 1_000, label: "user turn visible through remote-session:read" });
    // The world's engine runs with the environment's real provider
    // credentials, so this is a full round trip: an actual model reply
    // becomes readable through remote-session:read.
    await eventually(async () => {
      const read = await module.executeRemoteSessionCapability(input("read", { sessionId }), deps);
      if (read.isError) return false;
      const body = payload(read);
      const messages = body.messages as Array<{ role?: string; text?: string }>;
      return body.status === "idle" && messages.some((message) => message.role === "assistant" && (message.text ?? "").length > 0);
    }, { within: 120_000, intervalMs: 2_000, label: "assistant reply readable through remote-session:read" });
    const read = await module.executeRemoteSessionCapability(input("read", { sessionId }), deps);
    expect(read.isError).toBeUndefined();
    const readBody = payload(read);
    expect(String(readBody.status)).toBe("idle");
    expect(String(readBody.finalAssistantText).length).toBeGreaterThan(0);
    evidence.recordAssertionEvidence(
      "Read returns the durable transcript with a real model reply",
      "remote-session:read returned the world session settled idle with the submitted user turn and a non-empty assistant reply produced by the real engine — the same persisted messages the web UI shows.",
      true,
    );

    // ── scoping: a foreign session id on the real server stays invisible ──
    const foreign = await module.executeRemoteSessionCapability(
      input("read", { sessionId: "ses_someone_elses_session" }),
      deps,
    );
    expect(foreign.isError).toBe(true);
    expect(payload(foreign).error).toBe("unknown_session");
    evidence.recordAssertionEvidence(
      "Foreign session ids stay invisible on a real server",
      "Reading a session id that does not exist in the caller's workspace returned unknown_session from the real openwork-server, not an existence leak.",
      true,
    );
  },
);
