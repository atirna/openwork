import { defineHeadlessWebWorld } from "../packages/world/src/index.ts";

/**
 * Remote-session world: the real scenario behind the `remote-session:*`
 * gateway capabilities (docs/remote-chat-over-mcp-architecture.md).
 *
 * It launches the same stack OpenWork Web users run — a source-first
 * openwork-server plus the browser UI — in an isolated workspace. The
 * runtime manifest (tmp/…/dev-headless-web.json for this world name)
 * publishes `openworkUrl`, `token`, and `hostToken`: exactly the runtime a
 * resolved Cloud worker hands the gateway. An agent-side caller can then
 * execute `remote-session:create/send/read` against a real session store and
 * a human can open `webUrl` to watch the same sessions live.
 *
 * Launch: `pnpm world up ./worlds/remote-session.ts`
 * Proof:  `evals/specs/remote-session-real-server.e2e.test.ts` (launches its
 *         own named instance of this world).
 */
export const remoteSession = defineHeadlessWebWorld({
  state: "isolated",
  workspace: "/tmp/openwork-remote-session-world",
  detached: true,
});

export default remoteSession;
