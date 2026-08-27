import { createWorldDefinition } from "../packages/world/src/index.ts";
import { parseWorldTopology } from "../evals/packages/env/src/topology.ts";

/**
 * The Kind Helm fixture has separate browser-facing web/API origins while
 * DEN_API_BASE remains the in-cluster service.
 */
export const denSplitOriginKind = createWorldDefinition({
  den: {
    substrate: "kind",
    orgs: {
      "Acme Robotics": {
        admin: {
          name: "Alex Chen",
          email: "alex@acme.test",
          password: "OpenWorkDemo123!",
        },
      },
    },
  },
}, {
  adapter: "eval",
  detached: true,
}, parseWorldTopology);

export default denSplitOriginKind;
