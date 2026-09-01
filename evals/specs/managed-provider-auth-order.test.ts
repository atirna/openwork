import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

import { CloudProviderSync } from "../../apps/server/src/cloud-provider-sync.js";
import { EnvService } from "../../apps/server/src/env-file.js";
import { resetManagedProviderAuthCache } from "../../apps/server/src/managed-provider-auth.js";
import type { ServerConfig } from "../../apps/server/src/types.js";

const PROVIDER_ID = "lpr_auth_order";
const MODEL_ID = "auth-order-model";

test("managed provider credentials land before SDK clients are refreshed", async ({ evidence }) => {
  const root = await mkdtemp(join(tmpdir(), "openwork-provider-auth-order-"));
  const previousRuntimeDb = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  resetManagedProviderAuthCache();

  const events: string[] = [];
  const provider: Record<string, unknown> = {
    id: PROVIDER_ID,
    providerId: "anthropic",
    name: "Managed Anthropic",
    source: "custom",
    updatedAt: "2026-08-12T00:00:00.000Z",
    providerConfig: {
      env: ["MANAGED_ANTHROPIC_API_KEY"],
      npm: "@ai-sdk/anthropic",
    },
    apiKey: "sk-managed-first",
    apiKeys: null,
    models: [{ id: MODEL_ID, name: "Managed Anthropic Model", config: {} }],
  };
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    configPath: join(root, "server.json"),
    token: "client-token",
    hostToken: "host-token",
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [{
      id: "ws_auth_order",
      name: "Auth order",
      path: root,
      preset: "starter",
      workspaceType: "local",
      baseUrl: "http://engine.example.test",
    }],
    authorizedRoots: [root],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "den.example.test" && url.pathname === "/v1/llm-providers") {
      return Response.json({ llmProviders: [provider] });
    }
    if (url.hostname === "den.example.test" && url.pathname === `/v1/llm-providers/${PROVIDER_ID}/connect`) {
      return Response.json({ llmProvider: provider });
    }
    if (url.hostname === "engine.example.test" && url.pathname === `/auth/${PROVIDER_ID}`) {
      events.push(`${init?.method ?? "GET"} auth`);
      return Response.json(true);
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };
  const sync = new CloudProviderSync({
    config,
    env: new EnvService({ path: join(root, "env.json") }),
    fetchImpl,
    reloadEngine: async () => {
      events.push("reload");
    },
    intervalMs: 3_600_000,
  });

  try {
    sync.setSession({
      baseUrl: "https://den.example.test",
      token: "den-token",
      orgId: "org-auth-order",
    });
    await sync.run("initial_materialization");

    expect(events).toEqual(["PUT auth", "reload"]);
    evidence.recordAssertionEvidence(
      "A managed credential is delivered before the provider SDK client is refreshed",
      `Observed engine event order: ${events.join(" -> ")}`,
      events[0] === "PUT auth" && events[1] === "reload",
    );

    await sync.run("unchanged_snapshot");
    expect(events).toEqual(["PUT auth", "reload"]);
    evidence.recordAssertionEvidence(
      "An unchanged provider snapshot does not churn the engine",
      `The stable pass left the event log unchanged at ${events.length} events.`,
      events.length === 2,
    );

    provider.apiKey = "sk-managed-rotated";
    await sync.run("credential_rotation");
    expect(events).toEqual(["PUT auth", "reload", "PUT auth", "reload"]);
    evidence.recordAssertionEvidence(
      "A rotated credential lands before exactly one replacement SDK client is created",
      `Observed rotation event order: ${events.slice(2).join(" -> ")}`,
      events[2] === "PUT auth" && events[3] === "reload" && events.length === 4,
    );
  } finally {
    sync.stop();
    resetManagedProviderAuthCache();
    if (previousRuntimeDb === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previousRuntimeDb;
    await rm(root, { recursive: true, force: true });
  }
});
