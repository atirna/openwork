import { defineHeadlessWebWorld } from "../packages/world/src/index.ts";

/**
 * Worker runtime for the cloud model-infrastructure world: the same
 * source-first openwork-server plus managed OpenCode engine an OpenWork
 * Cloud worker runs, in an isolated workspace.
 *
 * `cloud-model-infra.ts` seeds a Den `worker` whose Daytona signed preview
 * points at this server's `openworkUrl`, so Den's readiness probe, provider
 * materialization, and remote-session capabilities exercise a real worker
 * runtime end to end without a Daytona sandbox.
 *
 * Launch: `pnpm world up ./worlds/cloud-model-infra-worker.ts`
 * Proof:  `evals/specs/cloud-model-infra.e2e.test.ts`
 */
export const cloudModelInfraWorker = defineHeadlessWebWorld({
  state: "isolated",
  workspace: "/tmp/openwork-cloud-model-infra-worker",
  detached: true,
});

export default cloudModelInfraWorker;
