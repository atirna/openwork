import { z } from "zod";
import { createWorldDefinition } from "@openwork/world";
import type { EnterpriseMcpProfileId } from "@openwork/labs";
import type {
  WorldDefinition as SharedWorldDefinition,
  WorldPatch,
} from "@openwork/world";

export type { WorldPatch } from "@openwork/world";

export interface WorldPerson {
  email?: string;
  name?: string;
  password?: string;
  /** Must match `^OPENWORK_EVAL_SECRET_[A-Z][A-Z0-9_]*$`; resolves `${secretRef}_EMAIL` and `${secretRef}_PASSWORD` at world start. */
  secretRef?: string;
}

export interface WorldOrg {
  admin?: WorldPerson;
  members?: Record<string, WorldPerson>;
  capabilities?: Record<string, boolean>;
  plugins?: {
    name: string;
    description?: string;
    skill: {
      name: string;
      description?: string;
      body: string;
    };
  }[];
  connections?: { name: string; witness: string }[];
  llmProviders?: WorldLlmProvider[];
  desktopPolicies?: {
    name: string;
    priority?: number;
    promptCards?: { title: string; prompt: string }[];
    members?: string[];
    teams?: { name: string; members: string[] }[];
  }[];
}

export interface WorldLlmProvider {
  kind: "litellm-per-member";
  name: string;
  providerId: string;
  env: string;
  witness: string;
  modelName?: string;
}

export interface WorldApp {
  signedInTo?: { org: string; as: string };
  desktopState?: { source: "installed-production"; mode: "live-shared" };
  workspacePath?: string;
  model?: string;
  localServerDelayMs?: number;
  sessions?: readonly string[];
}

export interface WorldMcpWitness {
  kind: "mcp";
  allowUnauthenticatedMcp?: boolean;
  profileId?: EnterpriseMcpProfileId;
  fault?: string;
}

export interface WorldLiteLlmWitness {
  kind: "litellm";
  modelId: string;
  reply: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export type WorldWitness = WorldMcpWitness | WorldLiteLlmWitness;

export interface WorldTopology {
  den: {
    orgs: Record<string, WorldOrg>;
    attach?: { apiUrl: string; webUrl?: string; tier: "prod" | "staging" | "demo" };
    env?: Record<string, string>;
    web?: boolean;
    substrate?: "local" | "kind";
    ports?: { api: number; web: number };
    seed?: "demo-org";
  };
  apps?: Record<string, WorldApp>;
  witnesses?: Record<string, WorldWitness>;
}

export type WorldDefinition = SharedWorldDefinition<WorldTopology>;

const worldPersonSchema = z.strictObject({
  email: z.string().optional(),
  name: z.string().optional(),
  password: z.string().optional(),
  secretRef: z.string()
    .regex(
      /^OPENWORK_EVAL_SECRET_[A-Z][A-Z0-9_]*$/,
      "secretRef must match ^OPENWORK_EVAL_SECRET_[A-Z][A-Z0-9_]*$",
    )
    .optional(),
}).superRefine((person, context) => {
  if (person.secretRef !== undefined && person.password !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["secretRef"],
      message: "secretRef and password are mutually exclusive",
    });
  }
});

const worldPluginSchema = z.strictObject({
  name: z.string(),
  description: z.string().optional(),
  skill: z.strictObject({
    name: z.string(),
    description: z.string().optional(),
    body: z.string(),
  }),
});

const worldConnectionSchema = z.strictObject({
  name: z.string(),
  witness: z.string(),
});

const worldLlmProviderSchema = z.strictObject({
  kind: z.literal("litellm-per-member"),
  name: z.string().trim().min(1).max(255),
  providerId: z.string().trim().min(1).max(255),
  env: z.string().trim().min(1).max(255),
  witness: z.string().trim().min(1),
  modelName: z.string().trim().min(1).max(255).optional(),
});

const worldDesktopPolicySchema = z.strictObject({
  name: z.string(),
  priority: z.number().optional(),
  promptCards: z.array(z.strictObject({
    title: z.string(),
    prompt: z.string(),
  })).optional(),
  members: z.array(z.string()).optional(),
  teams: z.array(z.strictObject({
    name: z.string(),
    members: z.array(z.string()),
  })).optional(),
});

const worldOrgSchema = z.strictObject({
  admin: worldPersonSchema.optional(),
  members: z.record(z.string(), worldPersonSchema).optional(),
  capabilities: z.record(z.string(), z.boolean()).optional(),
  plugins: z.array(worldPluginSchema).optional(),
  connections: z.array(worldConnectionSchema).optional(),
  llmProviders: z.array(worldLlmProviderSchema).optional(),
  desktopPolicies: z.array(worldDesktopPolicySchema).optional(),
});

const worldAppSchema = z.strictObject({
  signedInTo: z.strictObject({
    org: z.string(),
    as: z.string(),
  }).optional(),
  desktopState: z.strictObject({
    source: z.literal("installed-production"),
    mode: z.literal("live-shared"),
  }).optional(),
  workspacePath: z.string().optional(),
  model: z.string().optional(),
  localServerDelayMs: z.number().optional(),
  sessions: z.array(z.string().trim().min(1)).max(30).readonly().optional(),
}).superRefine((app, context) => {
  if (!app.desktopState) return;
  const conflictingOptions: readonly ("signedInTo" | "workspacePath" | "model" | "localServerDelayMs" | "sessions")[] = [
    "signedInTo",
    "workspacePath",
    "model",
    "localServerDelayMs",
    "sessions",
  ];
  for (const key of conflictingOptions) {
    if (app[key] !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["desktopState"],
        message: `desktopState live-shared conflicts with ${key}: live shared boot does not seed, sign in, or override production state`,
      });
    }
  }
});

// Keep these values aligned with EnterpriseMcpProfileId in @openwork/labs.
const enterpriseMcpProfileIdSchema = z.enum([
  "synthetic-enterprise-oauth-mcp",
  "servicenow-inbound-quickstart",
  "microsoft-work-iq",
  "microsoft-enterprise",
  "agent-365-mail-v1-2026-07",
  "slack-user-mcp",
]);

const worldMcpWitnessSchema = z.strictObject({
  kind: z.literal("mcp"),
  allowUnauthenticatedMcp: z.boolean().optional(),
  profileId: enterpriseMcpProfileIdSchema.optional(),
  fault: z.string().optional(),
}).superRefine((witness, context) => {
  if (witness.fault !== undefined && witness.profileId === undefined) {
    context.addIssue({
      code: "custom",
      path: ["fault"],
      message: "faults ride the enterprise mock profiles",
    });
  }
});

const positiveTokenLimitSchema = z.number().finite().positive();
const worldLiteLlmWitnessSchema = z.strictObject({
  kind: z.literal("litellm"),
  modelId: z.string().trim().min(1).max(255),
  reply: z.string().min(1),
  maxInputTokens: positiveTokenLimitSchema.optional(),
  maxOutputTokens: positiveTokenLimitSchema.optional(),
});
const worldWitnessSchema = z.discriminatedUnion("kind", [worldMcpWitnessSchema, worldLiteLlmWitnessSchema]);

const worldPortsSchema = z.strictObject({
  api: z.number().int().min(1024).max(65_535),
  web: z.number().int().min(1024).max(65_535),
});

export const worldTopologySchema = z.strictObject({
  den: z.strictObject({
    orgs: z.record(z.string(), worldOrgSchema),
    attach: z.strictObject({
      apiUrl: z.string(),
      webUrl: z.string().optional(),
      tier: z.enum(["prod", "staging", "demo"]),
    }).optional(),
    env: z.record(z.string(), z.string()).optional(),
    web: z.boolean().optional(),
    substrate: z.enum(["local", "kind"]).optional(),
    ports: worldPortsSchema.optional(),
    seed: z.literal("demo-org").optional(),
  }).superRefine((den, context) => {
    if (!den.attach) return;
    const conflictingOptions: readonly ("seed" | "substrate" | "env" | "ports" | "web")[] = [
      "seed",
      "substrate",
      "env",
      "ports",
      "web",
    ];
    for (const key of conflictingOptions) {
      if (den[key] !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["attach"],
          message: `den.attach conflicts with den.${key}`,
        });
      }
    }
    if (den.attach.tier === "prod" && Object.keys(den.orgs).length > 0) {
      context.addIssue({
        code: "custom",
        path: ["orgs"],
        message: 'den.attach tier "prod" refuses organization provisioning: you own what you launch; you never own what you attach.',
      });
    }
  }).transform((den) => den.attach ? den : { ...den, substrate: den.substrate ?? "local" }),
  apps: z.record(z.string(), worldAppSchema).optional(),
  witnesses: z.record(z.string(), worldWitnessSchema).optional(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateReferences(topology: WorldTopology): void {
  const orgKeys = Object.keys(topology.den.orgs);
  const primaryOrg = orgKeys[0];
  const apps = Object.values(topology.apps ?? {});
  const sharedStateApps = apps.filter((app) => app.desktopState?.mode === "live-shared");
  if (sharedStateApps.length > 0) {
    if (sharedStateApps.length !== 1) {
      throw new Error("Live-shared installed-production desktop worlds require exactly one dev desktop.");
    }
    if (sharedStateApps.length !== apps.length) {
      throw new Error("World topology cannot mix live-shared installed-production desktops with provisioned desktop apps.");
    }
    if (
      orgKeys.length > 0
      || topology.den.attach !== undefined
      || topology.den.env !== undefined
      || topology.den.web !== undefined
      || topology.den.ports !== undefined
      || topology.den.seed !== undefined
      || topology.den.substrate !== "local"
      || Object.keys(topology.witnesses ?? {}).length > 0
    ) {
      throw new Error("Live-shared installed-production desktop worlds must be desktop-only: use empty den.orgs and no Den or witness options.");
    }
    return;
  }
  if (!primaryOrg) {
    if (topology.den.attach?.tier === "prod") {
      for (const [appName, app] of Object.entries(topology.apps ?? {})) {
        if (app.signedInTo) {
          throw new Error(
            `World app ${JSON.stringify(appName)} signedInTo.org ${JSON.stringify(app.signedInTo.org)} does not exist in den.orgs.`,
          );
        }
      }
      return;
    }
    throw new Error("World topology must define at least one organization in den.orgs.");
  }

  if (topology.den.seed === "demo-org") {
    if (orgKeys.length !== 1) {
      throw new Error('den.seed "demo-org" requires exactly one organization: v1 limitation: the demo seed owns all organization content.');
    }
    const seededOrg = topology.den.orgs[primaryOrg];
    if (!seededOrg) throw new Error('den.seed "demo-org" could not resolve its single organization.');
    if (Object.keys(seededOrg.members ?? {}).length > 0) {
      throw new Error('den.seed "demo-org" cannot define organization members: v1 limitation: the demo seed owns its member roster.');
    }
    if (
      seededOrg.capabilities !== undefined
      || seededOrg.plugins !== undefined
      || seededOrg.connections !== undefined
      || seededOrg.llmProviders !== undefined
      || seededOrg.desktopPolicies !== undefined
    ) {
      throw new Error('den.seed "demo-org" cannot define capabilities, plugins, connections, llmProviders, or desktopPolicies: v1 limitation: the demo seed owns these content nouns.');
    }
  }

  for (const [orgName, org] of Object.entries(topology.den.orgs).slice(1)) {
    if (
      org.capabilities !== undefined
      || org.plugins !== undefined
      || org.connections !== undefined
      || org.llmProviders !== undefined
      || org.desktopPolicies !== undefined
    ) {
      throw new Error(
        `World org ${JSON.stringify(orgName)} cannot define capabilities, plugins, connections, llmProviders, or desktopPolicies: v1 limitation: these content nouns may only be defined on primary org ${JSON.stringify(primaryOrg)}.`,
      );
    }
  }

  for (const [orgName, org] of Object.entries(topology.den.orgs)) {
    for (const connection of org.connections ?? []) {
      const witness = topology.witnesses?.[connection.witness];
      if (!witness) {
        throw new Error(
          `World org ${JSON.stringify(orgName)} connection ${JSON.stringify(connection.name)} references witness ${JSON.stringify(connection.witness)}, which does not exist in topology.witnesses.`,
        );
      }
      if (witness.kind !== "mcp") {
        throw new Error(
          `World org ${JSON.stringify(orgName)} connection ${JSON.stringify(connection.name)} must reference an MCP witness; ${JSON.stringify(connection.witness)} has kind ${JSON.stringify(witness.kind)}.`,
        );
      }
    }

    for (const provider of org.llmProviders ?? []) {
      const witness = topology.witnesses?.[provider.witness];
      if (!witness) {
        throw new Error(
          `World org ${JSON.stringify(orgName)} LLM provider ${JSON.stringify(provider.name)} references witness ${JSON.stringify(provider.witness)}, which does not exist in topology.witnesses.`,
        );
      }
      if (witness.kind !== "litellm") {
        throw new Error(
          `World org ${JSON.stringify(orgName)} LLM provider ${JSON.stringify(provider.name)} must reference a LiteLLM witness; ${JSON.stringify(provider.witness)} has kind ${JSON.stringify(witness.kind)}.`,
        );
      }
    }

    for (const policy of org.desktopPolicies ?? []) {
      for (const member of policy.members ?? []) {
        if (!Object.hasOwn(org.members ?? {}, member)) {
          throw new Error(
            `World org ${JSON.stringify(orgName)} desktop policy ${JSON.stringify(policy.name)} member ${JSON.stringify(member)} must be a member key of that org.`,
          );
        }
      }
      for (const team of policy.teams ?? []) {
        for (const member of team.members) {
          if (!Object.hasOwn(org.members ?? {}, member)) {
            throw new Error(
              `World org ${JSON.stringify(orgName)} desktop policy ${JSON.stringify(policy.name)} team ${JSON.stringify(team.name)} member ${JSON.stringify(member)} must be a member key of that org.`,
            );
          }
        }
      }
    }
  }

  if (topology.den.substrate === "kind") {
    const witnessKeys = Object.keys(topology.witnesses ?? {});
    if (witnessKeys.length > 0) {
      throw new Error('den.substrate "kind" cannot define witnesses: v1 limitation: the shared kind Den cannot inject world witnesses.');
    }
    if (topology.den.seed !== undefined) {
      throw new Error('den.substrate "kind" cannot define seed: seed is a local-lane option; kind worlds reuse the existing stack seed.');
    }
    if (topology.den.ports !== undefined) {
      throw new Error('den.substrate "kind" cannot define ports: ports are a local-lane option; kind worlds use the stack port-forwards.');
    }
    if (orgKeys.length !== 1) {
      throw new Error('den.substrate "kind" must define exactly one organization: v1 limitation: the kind stack contains only the seeded demo organization "Acme Robotics".');
    }
    if (primaryOrg !== "Acme Robotics") {
      throw new Error('den.substrate "kind" organization must be named "Acme Robotics" to match the kind seed.');
    }
    const seededOrg = topology.den.orgs[primaryOrg];
    if (!seededOrg) throw new Error('den.substrate "kind" could not resolve its seeded demo organization.');
    if (Object.keys(seededOrg.members ?? {}).length > 0) {
      throw new Error('den.substrate "kind" cannot define organization members: v1 limitation: only the seeded admin session is exposed.');
    }
    if (seededOrg.admin?.email !== undefined && seededOrg.admin.email.toLowerCase() !== "alex@acme.test") {
      throw new Error('den.substrate "kind" admin.email must be "alex@acme.test" to match the kind seed.');
    }
    if (seededOrg.admin?.name !== undefined && seededOrg.admin.name !== "Alex Chen") {
      throw new Error('den.substrate "kind" admin.name must be "Alex Chen" to match the kind seed.');
    }
    if (seededOrg.admin?.password !== undefined && seededOrg.admin.password !== "OpenWorkDemo123!") {
      throw new Error('den.substrate "kind" admin.password must match the seeded demo admin password.');
    }
    for (const [appName, app] of Object.entries(topology.apps ?? {})) {
      if (app.signedInTo?.as !== "admin") {
        throw new Error(
          `World app ${JSON.stringify(appName)} on den.substrate "kind" must sign in as "admin": only the seeded admin session has been proved on the shared kind Den.`,
        );
      }
    }
  }

  for (const [appName, app] of Object.entries(topology.apps ?? {})) {
    const signedInTo = app.signedInTo;
    if (!signedInTo) continue;
    const org = topology.den.orgs[signedInTo.org];
    if (!org) {
      throw new Error(
        `World app ${JSON.stringify(appName)} signedInTo.org ${JSON.stringify(signedInTo.org)} does not exist in den.orgs.`,
      );
    }
    if (signedInTo.as !== "admin" && !Object.hasOwn(org.members ?? {}, signedInTo.as)) {
      throw new Error(
        `World app ${JSON.stringify(appName)} signedInTo.as ${JSON.stringify(signedInTo.as)} must be "admin" or a member key of org ${JSON.stringify(signedInTo.org)}.`,
      );
    }
    if (signedInTo.org !== primaryOrg) {
      throw new Error(
        `World app ${JSON.stringify(appName)} cannot sign in to org ${JSON.stringify(signedInTo.org)}: v1 limitation: apps may only sign in to primary org ${JSON.stringify(primaryOrg)}.`,
      );
    }
  }
}

export function usesLiveSharedProductionState(topology: WorldTopology): boolean {
  return Object.values(topology.apps ?? {}).some(
    (app) => app.desktopState?.source === "installed-production" && app.desktopState.mode === "live-shared",
  );
}

export function parseWorldTopology(input: unknown): WorldTopology {
  const topology: WorldTopology = worldTopologySchema.parse(input);
  validateReferences(topology);
  return topology;
}

export function resolveWorldPerson(
  person: WorldPerson,
  env: NodeJS.ProcessEnv = process.env,
): WorldPerson {
  if (person.secretRef === undefined) return person;
  const emailVariable = `${person.secretRef}_EMAIL`;
  const passwordVariable = `${person.secretRef}_PASSWORD`;
  const email = env[emailVariable];
  const password = env[passwordVariable];
  if (email === undefined || password === undefined) {
    const missing = [
      ...(email === undefined ? [emailVariable] : []),
      ...(password === undefined ? [passwordVariable] : []),
    ];
    throw new Error(
      `World person namespaced secretRef ${JSON.stringify(person.secretRef)} is missing environment variable(s): ${missing.join(", ")}; secretRef names must match ^OPENWORK_EVAL_SECRET_[A-Z][A-Z0-9_]*$.`,
    );
  }
  return {
    email,
    password,
    ...(person.name === undefined ? {} : { name: person.name }),
  };
}

export function defineWorld(t: WorldTopology): WorldDefinition {
  const topology = parseWorldTopology(t);
  return createWorldDefinition(topology, (resolvedTopology) => ({
    adapter: "eval",
    requiresSharedState: usesLiveSharedProductionState(resolvedTopology),
  }), parseWorldTopology);
}

export function onKind(definition: WorldDefinition): WorldDefinition {
  return definition.with({ den: { substrate: "kind" } });
}
