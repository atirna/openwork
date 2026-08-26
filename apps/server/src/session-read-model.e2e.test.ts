import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { proxyOpencodeRequest, startServer } from "./server.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

type Served = {
  port: number;
  stop: (closeActiveConnections?: boolean) => void | Promise<void>;
};

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  while (stops.length) {
    await stops.pop()?.();
  }
  while (roots.length) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

async function createWorkspaceRoot(folderName?: string) {
  const root = await mkdtemp(join(tmpdir(), "openwork-session-read-"));
  const workspaceRoot = folderName ? join(root, folderName) : root;
  await mkdir(join(workspaceRoot, ".opencode"), { recursive: true });
  roots.push(root);
  return workspaceRoot;
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

function startMockOpencode(input?: { invalidList?: boolean; holdCommand?: Promise<void>; sessionDirectory?: string }) {
  const requests: Array<{ pathname: string; search: string; directory: string | null; method: string; body?: unknown }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const record: { pathname: string; search: string; directory: string | null; method: string; body?: unknown } = {
        pathname: url.pathname,
        search: url.search,
        directory: request.headers.get("x-opencode-directory"),
        method: request.method,
      };
      if (request.method === "POST") record.body = await request.json();
      requests.push(record);

      if (url.pathname === "/session") {
        if (request.method === "POST") {
          const title = typeof record.body === "object" && record.body !== null
            ? Reflect.get(record.body, "title")
            : undefined;
          return Response.json({
            id: "ses_created",
            title: typeof title === "string" ? title : "New session",
            slug: "created-session",
            directory: input?.sessionDirectory ?? request.headers.get("x-opencode-directory"),
            time: { created: 300, updated: 300 },
          });
        }
        if (input?.invalidList) {
          return Response.json({ nope: true });
        }
        return Response.json([
          {
            id: "ses_1",
            title: "Hostname Check",
            slug: "hostname-check",
            directory: request.headers.get("x-opencode-directory"),
            time: { created: 100, updated: 200 },
          },
        ]);
      }

      if (url.pathname === "/session/status") {
        return Response.json({ ses_1: { type: "busy" } });
      }

      if (url.pathname === "/session/ses_1") {
        return Response.json({
          id: "ses_1",
          title: "Hostname Check",
          slug: "hostname-check",
          directory: input?.sessionDirectory ?? request.headers.get("x-opencode-directory"),
          time: { created: 100, updated: 200 },
        });
      }

      if (url.pathname === "/session/ses_1/message") {
        return Response.json([
          {
            info: {
              id: "msg_1",
              sessionID: "ses_1",
              role: "assistant",
              time: { created: 200 },
            },
            parts: [
              {
                id: "prt_1",
                messageID: "msg_1",
                sessionID: "ses_1",
                type: "text",
                text: "hostname: mock-host",
              },
            ],
          },
        ]);
      }

      if (url.pathname === "/session/ses_created/prompt_async" && request.method === "POST") {
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/session/ses_1/todo") {
        return Response.json([
          {
            content: "Validate session reads",
            status: "completed",
            priority: "high",
          },
        ]);
      }

      if (url.pathname === "/session/ses_1/command" && request.method === "POST") {
        await input?.holdCommand;
        return Response.json({ ok: true });
      }

      return Response.json({ code: "not_found", message: "Not found" }, { status: 404 });
    },
  }) as Served;
  stops.push(() => server.stop(true));
  return { server, requests };
}

async function startOpenworkServer(input: {
  workspaceRoot: string;
  secondWorkspaceRoot?: string;
  opencodeBaseUrl?: string;
  readOnly?: boolean;
}) {
  const workspaces: WorkspaceInfo[] = [{
    id: "ws_1",
    name: "Workspace",
    path: input.workspaceRoot,
    preset: "starter",
    workspaceType: "local",
    ...(input.opencodeBaseUrl ? { baseUrl: input.opencodeBaseUrl } : {}),
  }];
  if (input.secondWorkspaceRoot) {
    workspaces.push({
      id: "ws_2",
      name: "Other workspace",
      path: input.secondWorkspaceRoot,
      preset: "starter",
      workspaceType: "local",
      ...(input.opencodeBaseUrl ? { baseUrl: input.opencodeBaseUrl } : {}),
    });
  }
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces,
    authorizedRoots: [input.workspaceRoot, ...(input.secondWorkspaceRoot ? [input.secondWorkspaceRoot] : [])],
    readOnly: input.readOnly ?? true,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config) as Served;
  stops.push(() => server.stop(true));
  return { server, token: config.token };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean) {
  for (let index = 0; index < 20; index++) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

describe("workspace session read APIs", () => {
  test("creates a session and starts its prompt without UI navigation", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
      readOnly: false,
    });

    const response = await fetch(`http://127.0.0.1:${openwork.server.port}/workspace/ws_1/sessions`, {
      method: "POST",
      headers: { ...auth(openwork.token), "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Look into dolphins", prompt: "Research dolphins." }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      item: { id: "ses_created", title: "Look into dolphins", directory: workspaceRoot },
      started: true,
    });
    const createRequest = mock.requests.find((request) => request.pathname === "/session" && request.method === "POST");
    expect(createRequest?.body).toEqual({ title: "Look into dolphins" });
    const promptRequest = mock.requests.find((request) => request.pathname === "/session/ses_created/prompt_async");
    expect(promptRequest?.body).toEqual({ parts: [{ type: "text", text: "Research dolphins." }] });
    expect(promptRequest?.directory).toBe(workspaceRoot);
  });

  test("lists sessions and returns session details, messages, and snapshot", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const base = `http://127.0.0.1:${openwork.server.port}`;

    const listResponse = await fetch(`${base}/workspace/ws_1/sessions?roots=true&limit=1&search=host&start=10`, {
      headers: auth(openwork.token),
    });
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    expect(listBody).toEqual({
      items: [
        {
          id: "ses_1",
          title: "Hostname Check",
          slug: "hostname-check",
          directory: workspaceRoot,
          time: { created: 100, updated: 200 },
        },
      ],
    });

    const detailResponse = await fetch(`${base}/workspace/ws_1/sessions/ses_1`, {
      headers: auth(openwork.token),
    });
    expect(detailResponse.status).toBe(200);
    const detailBody = await detailResponse.json();
    expect(detailBody.item.id).toBe("ses_1");
    expect(detailBody.item.directory).toBe(workspaceRoot);

    const messagesResponse = await fetch(`${base}/workspace/ws_1/sessions/ses_1/messages?limit=5`, {
      headers: auth(openwork.token),
    });
    expect(messagesResponse.status).toBe(200);
    const messagesBody = await messagesResponse.json();
    expect(messagesBody.items).toHaveLength(1);
    expect(messagesBody.items[0]?.info.id).toBe("msg_1");
    expect(messagesBody.items[0]?.parts[0]?.text).toBe("hostname: mock-host");

    const snapshotResponse = await fetch(`${base}/workspace/ws_1/sessions/ses_1/snapshot?limit=5`, {
      headers: auth(openwork.token),
    });
    expect(snapshotResponse.status).toBe(200);
    const snapshotBody = await snapshotResponse.json();
    expect(snapshotBody.item.session.id).toBe("ses_1");
    expect(snapshotBody.item.messages).toHaveLength(1);
    expect(snapshotBody.item.todos).toEqual([
      {
        content: "Validate session reads",
        status: "completed",
        priority: "high",
      },
    ]);
    expect(snapshotBody.item.status).toEqual({ type: "busy" });

    const listRequest = mock.requests.find((request) => request.pathname === "/session");
    expect(listRequest?.directory).toBe(workspaceRoot);
    expect(listRequest?.search).toContain("roots=true");
    expect(listRequest?.search).toContain("limit=1");
    expect(listRequest?.search).toContain("search=host");
    expect(listRequest?.search).toContain("start=10");

  });

  test("accepts guest-side rem_ workspace aliases for session reads", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${openwork.server.port}/workspace/rem_ws_1/sessions`, {
      headers: auth(openwork.token),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items[0]?.id).toBe("ses_1");
    expect(body.items[0]?.directory).toBe(workspaceRoot);
    expect(mock.requests.find((request) => request.pathname === "/session")?.directory).toBe(workspaceRoot);
  });

  test("encodes non-ASCII workspace directory headers for session reads", async () => {
    const workspaceRoot = await createWorkspaceRoot("项目");
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${openwork.server.port}/workspace/ws_1/sessions`, {
      headers: auth(openwork.token),
    });

    expect(response.status).toBe(200);
    const listRequest = mock.requests.find((request) => request.pathname === "/session");
    const encodedDirectory = encodeURIComponent(workspaceRoot);
    expect(listRequest?.directory).toBe(encodedDirectory);
    expect(listRequest?.search).toContain(`directory=${encodedDirectory}`);
  });

  test("encodes non-ASCII workspace directory headers for opencode proxy requests", async () => {
    const workspaceRoot = await createWorkspaceRoot("项目");
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${openwork.server.port}/workspace/ws_1/opencode/session`, {
      headers: auth(openwork.token),
    });

    expect(response.status).toBe(200);
    const proxyRequest = mock.requests.find((request) => request.pathname === "/session");
    expect(proxyRequest?.directory).toBe(encodeURIComponent(workspaceRoot));
  });

  test("keeps opencode proxy requests off the workspace bootstrap path", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
      readOnly: false,
    });
    const commandsDir = join(workspaceRoot, ".opencode", "commands");
    const commandPath = join(commandsDir, "legacy.md");
    const legacyCommand = "---\nname: legacy\ndescription: Legacy\nmodel: null\n---\nRun legacy command\n";
    await mkdir(commandsDir, { recursive: true });
    await writeFile(commandPath, legacyCommand, "utf8");

    const response = await fetch(`http://127.0.0.1:${openwork.server.port}/workspace/ws_1/opencode/session`, {
      headers: auth(openwork.token),
    });

    expect(response.status).toBe(200);
    expect(mock.requests.some((request) => request.pathname === "/session")).toBe(true);
    expect(await readFile(commandPath, "utf8")).toBe(legacyCommand);
  });

  test("returns 404 when the upstream session is missing", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${openwork.server.port}/workspace/ws_1/sessions/ses_missing/snapshot`, {
      headers: auth(openwork.token),
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      code: "session_not_found",
      message: "Session not found",
    });

  });

  test("returns 404 when a session belongs to another workspace", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const secondWorkspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode({ sessionDirectory: workspaceRoot });
    const openwork = await startOpenworkServer({
      workspaceRoot,
      secondWorkspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(
      `http://127.0.0.1:${openwork.server.port}/workspace/ws_2/sessions/ses_1/snapshot`,
      { headers: auth(openwork.token) },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ code: "session_not_found" });
  });

  test.serial("acknowledges proxied session commands before upstream completion and admits each message once", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const engineUrl = "http://127.0.0.1:4111";
    const replacementEngineUrl = "http://127.0.0.1:4222";
    const workspace: WorkspaceInfo = {
      id: "ws_1",
      name: "Workspace",
      path: workspaceRoot,
      preset: "starter",
      workspaceType: "local",
      baseUrl: engineUrl,
    };
    const config: ServerConfig = {
      host: "127.0.0.1",
      port: 0,
      token: "owt_test_token",
      hostToken: "owt_host_token",
      approval: { mode: "auto", timeoutMs: 1_000 },
      corsOrigins: ["*"],
      workspaces: [workspace],
      authorizedRoots: [workspaceRoot],
      readOnly: false,
      startedAt: Date.now(),
      tokenSource: "cli",
      hostTokenSource: "cli",
      logFormat: "pretty",
      logRequests: false,
    };
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    const upstream = deferred();
    globalThis.fetch = Object.assign(
      (input: Parameters<typeof fetch>[0]) => {
        requests.push(input instanceof Request ? input.url : String(input));
        return upstream.promise.then(() => Response.json({ ok: true }));
      },
      { preconnect: originalFetch.preconnect },
    );
    const sendCommand = (
      targetWorkspace: WorkspaceInfo,
      sessionId: string,
      body: string,
    ) => {
      const proxyPath = `/session/${sessionId}/command`;
      const url = new URL(`http://openwork.invalid/opencode${proxyPath}`);
      return proxyOpencodeRequest({
        config,
        workspace: targetWorkspace,
        proxyPath,
        url,
        request: new Request(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
      });
    };
    const commandBody = JSON.stringify({ messageID: "msg_command_once", command: "review", arguments: "" });

    try {
      const response = await Promise.race([
        sendCommand(workspace, "ses_1", commandBody),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 100)),
      ]);
      expect(response).not.toBe("timeout");
      expect(response instanceof Response ? response.status : 0).toBe(200);
      await expect(response instanceof Response ? response.json() : null).resolves.toMatchObject({ accepted: true });

      const duplicate = await sendCommand(workspace, "ses_1", commandBody);
      expect(duplicate.status).toBe(200);
      await expect(duplicate.json()).resolves.toMatchObject({ accepted: true });

      const conflict = await sendCommand(
        workspace,
        "ses_1",
        JSON.stringify({ messageID: "msg_command_once", command: "summarize", arguments: "" }),
      );
      expect(conflict.status).toBe(409);
      await expect(conflict.json()).resolves.toMatchObject({ code: "command_admission_conflict" });

      const rolloverDuplicate = await sendCommand(
        { ...workspace, baseUrl: replacementEngineUrl },
        "ses_1",
        commandBody,
      );
      const otherSession = await sendCommand(workspace, "ses_2", commandBody);
      expect(rolloverDuplicate.status).toBe(200);
      expect(otherSession.status).toBe(200);
      expect(requests.map((request) => new URL(request).pathname)).toEqual([
        "/session/ses_1/command",
        "/session/ses_2/command",
      ]);
      expect(requests.every((request) => request.startsWith(engineUrl))).toBe(true);
    } finally {
      upstream.resolve();
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps legacy /w workspace opencode proxy alias", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode();
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${openwork.server.port}/w/ws_1/opencode/session`, {
      headers: auth(openwork.token),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(mock.requests.some((request) => request.pathname === "/session")).toBe(true);
  });

  test("returns 502 when OpenCode returns an invalid session list payload", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const mock = startMockOpencode({ invalidList: true });
    const openwork = await startOpenworkServer({
      workspaceRoot,
      opencodeBaseUrl: `http://127.0.0.1:${mock.server.port}`,
    });

    const response = await fetch(`http://127.0.0.1:${openwork.server.port}/workspace/ws_1/sessions`, {
      headers: auth(openwork.token),
    });
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "opencode_invalid_response",
      message: "OpenCode returned invalid session list",
    });
  });

  test("returns a configured error instead of constructing an SDK request with a relative URL", async () => {
    const workspaceRoot = await createWorkspaceRoot();
    const openwork = await startOpenworkServer({ workspaceRoot });

    const response = await fetch(`http://127.0.0.1:${openwork.server.port}/workspace/ws_1/sessions?limit=200`, {
      headers: auth(openwork.token),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "opencode_unconfigured",
      message: "OpenCode base URL is missing for this workspace",
      details: {
        workspaceId: "ws_1",
        workspaceType: "local",
      },
    });
  });
});
