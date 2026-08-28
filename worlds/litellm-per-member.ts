import { createWorldDefinition } from "../packages/world/src/index.ts";
import { parseWorldTopology } from "../evals/packages/env/src/topology.ts";

export const LITELLM_WORLD_ORG = "LiteLLM Per-Member World";
export const LITELLM_WORLD_PROVIDER = "openwork-litellm-per-member";
export const LITELLM_WORLD_MODEL = "openwork-litellm-per-member-model";

/**
 * Local Desktop + Den + database-backed LiteLLM world for manually exercising
 * the complete per-member example. The LiteLLM gateway talks to a deterministic
 * local OpenAI-compatible witness; it never reads or requires OPENAI_API_KEY.
 *
 * Launch: `pnpm world up ./worlds/litellm-per-member.ts`
 */
export const liteLlmPerMember = createWorldDefinition({
  den: {
    orgs: {
      [LITELLM_WORLD_ORG]: {
        admin: { name: "LiteLLM Admin", email: "litellm-admin@openwork.test" },
        members: {
          alice: { name: "Alice LiteLLM", email: "alice-litellm@openwork.test" },
        },
        llmProviders: [{
          kind: "litellm-per-member",
          name: "Per-Member LiteLLM Gateway",
          providerId: LITELLM_WORLD_PROVIDER,
          env: "LITELLM_PER_MEMBER_API_KEY",
          witness: "litellm",
          modelName: "Per-Member LiteLLM Witness",
        }],
      },
    },
  },
  apps: {
    desktop: {
      signedInTo: { org: LITELLM_WORLD_ORG, as: "admin" },
      workspacePath: "/tmp/openwork-litellm-per-member-world",
      model: `${LITELLM_WORLD_PROVIDER}/${LITELLM_WORLD_MODEL}`,
    },
  },
  witnesses: {
    litellm: {
      kind: "litellm",
      modelId: LITELLM_WORLD_MODEL,
      reply: "The database-backed per-member LiteLLM world is working.",
      maxInputTokens: 128_000,
      maxOutputTokens: 16_384,
    },
  },
}, {
  adapter: "eval",
  detached: false,
}, parseWorldTopology);

export default liteLlmPerMember;
