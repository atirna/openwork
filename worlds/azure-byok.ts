import { createWorldDefinition } from "../packages/world/src/index.ts";
import { parseWorldTopology } from "../evals/packages/env/src/topology.ts";

/** Fresh isolated self-hosted Den for verifying Azure BYOK delivery. */
export const azureByok = createWorldDefinition({
  den: {
    orgs: {
      "Azure BYOK Repro": {
        admin: { name: "Provider Admin", email: "provider-admin@azure-repro.test" },
      },
    },
  },
}, {
  adapter: "eval",
  detached: true,
}, parseWorldTopology);

export default azureByok;
