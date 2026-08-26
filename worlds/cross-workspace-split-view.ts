import { createWorldDefinition } from "../packages/world/src/index.ts";
import { parseWorldTopology } from "../evals/packages/env/src/topology.ts";

/**
 * Repro world for validating split view across two sessions that belong to
 * different local workspaces. The world seeds the signed-in desktop and the
 * first workspace; the scenario creates a second workspace at runtime so each
 * run gets isolated temporary workspace paths.
 */
export const crossWorkspaceSplitView = createWorldDefinition({
  den: {
    orgs: {
      "Cross Workspace Split View": {
        admin: { name: "Split View Admin", email: "split-view-admin@openwork.test" },
      },
    },
  },
  apps: {
    main: {
      signedInTo: { org: "Cross Workspace Split View", as: "admin" },
      workspacePath: "/tmp/openwork-cross-workspace-split-primary",
      sessions: ["Primary split anchor", "Primary same-workspace peer"],
    },
  },
}, {
  adapter: "eval",
  detached: true,
}, parseWorldTopology);

export default crossWorkspaceSplitView;
