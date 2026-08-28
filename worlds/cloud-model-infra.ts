import { createWorldDefinition } from "../packages/world/src/index.ts";
import { parseWorldTopology } from "../evals/packages/env/src/topology.ts";

export const CLOUD_MODEL_INFRA_ORG = "Cloud Model Infra";
export const CLOUD_MODEL_INFRA_ADMIN_EMAIL = "infra-admin@cloud-model-infra.test";
export const CLOUD_MODEL_INFRA_GATEWAY_KEY = "cloud-model-infra-gateway-key";
export const CLOUD_MODEL_INFRA_DAYTONA_KEY = "cloud-model-infra-daytona-guard-key";

/**
 * Cloud model-infrastructure world: a fresh self-hosted Den whose only
 * organization is Cloud-enabled (`capabilities.cloud`) and whose Daytona
 * provisioner gate is satisfied without any real Daytona account.
 *
 * `DAYTONA_API_URL` deliberately points at an unroutable local address: the
 * healthy-worker runtime path (signed-preview probe, gateway resolve,
 * provider materialization, remote-session capabilities) must never call the
 * Daytona SDK. Any unexpected SDK call fails fast instead of reaching the
 * real Daytona API. The proof spec replaces this URL with a live request
 * ledger and asserts it stays empty.
 *
 * The member-owned cloud worker itself is seeded at the database seam
 * (`worker`, `worker_token`, `daytona_sandbox`) pointing at a real
 * source-first openwork-server launched from `cloud-model-infra-worker.ts`,
 * so Den talks to a genuine worker runtime over plain HTTP.
 *
 * Launch: `pnpm world up ./worlds/cloud-model-infra.ts`
 * Proof:  `evals/specs/cloud-model-infra.e2e.test.ts`
 */
export const cloudModelInfra = createWorldDefinition({
  den: {
    orgs: {
      [CLOUD_MODEL_INFRA_ORG]: {
        admin: { name: "Infra Admin", email: CLOUD_MODEL_INFRA_ADMIN_EMAIL },
        capabilities: { cloud: true },
      },
    },
    env: {
      PROVISIONER_MODE: "daytona",
      DAYTONA_API_KEY: CLOUD_MODEL_INFRA_DAYTONA_KEY,
      DAYTONA_API_URL: "http://127.0.0.1:9/daytona-guard",
      DEN_GATEWAY_KEY: CLOUD_MODEL_INFRA_GATEWAY_KEY,
    },
  },
}, {
  adapter: "eval",
  detached: true,
}, parseWorldTopology);

export default cloudModelInfra;
