import assert from "node:assert/strict";
import test from "node:test";
import { defineWorld, onKind } from "../src/topology.ts";

function kindSeedWorld() {
  return defineWorld({
    den: {
      orgs: {
        "Acme Robotics": {
          admin: {
            email: "alex@acme.test",
            name: "Alex Chen",
            password: "OpenWorkDemo123!",
          },
        },
      },
    },
  });
}

test("onKind selects the kind Den substrate", () => {
  const local = kindSeedWorld();
  const kind = onKind(local);

  assert.equal(local.topology.den.substrate, "local");
  assert.equal(kind.topology.den.substrate, "kind");
});

test("kind substrate accepts seeded-admin apps and rejects unsupported shared-stack options", () => {
  const withApp = kindSeedWorld().with({
    den: { substrate: "kind" },
    apps: { main: { signedInTo: { org: "Acme Robotics", as: "admin" } } },
  });
  assert.equal(withApp.topology.apps?.main?.signedInTo?.as, "admin");
  assert.throws(
    () => kindSeedWorld().with({ den: { substrate: "kind" }, apps: { main: {} } }),
    /must sign in as "admin": only the seeded admin session has been proved/,
  );
  assert.throws(
    () => kindSeedWorld().with({
      den: { substrate: "kind" },
      witnesses: { provider: { kind: "mcp" } },
    }),
    /den\.substrate "kind" cannot define witnesses: v1 limitation/,
  );
  assert.throws(
    () => kindSeedWorld().with({
      den: {
        substrate: "kind",
        orgs: { Globex: {} },
      },
    }),
    /den\.substrate "kind" must define exactly one organization: v1 limitation/,
  );
  assert.throws(
    () => kindSeedWorld().with({ den: { substrate: "kind", seed: "demo-org" } }),
    /den\.substrate "kind" cannot define seed: seed is a local-lane option/,
  );
  assert.throws(
    () => kindSeedWorld().with({ den: { substrate: "kind", ports: { api: 8790, web: 3005 } } }),
    /den\.substrate "kind" cannot define ports: ports are a local-lane option/,
  );
});

test("defineWorld rejects unknown keys at every strict topology boundary", () => {
  assert.throws(
    () => Reflect.apply(defineWorld, undefined, [{
      den: { orgs: { acme: { admin: {}, unknownPersonContainer: true } } },
    }]),
    /Unrecognized key.*unknownPersonContainer/,
  );
});

test("defineWorld rejects invalid app sign-in references", () => {
  assert.throws(
    () => defineWorld({
      den: { orgs: { acme: {} } },
      apps: { main: { signedInTo: { org: "missing", as: "admin" } } },
    }),
    /signedInTo\.org "missing" does not exist/,
  );
  assert.throws(
    () => defineWorld({
      den: { orgs: { acme: { members: { jordan: {} } } } },
      apps: { main: { signedInTo: { org: "acme", as: "casey" } } },
    }),
    /must be "admin" or a member key/,
  );
  assert.throws(
    () => defineWorld({
      den: { orgs: { acme: {}, globex: {} } },
      apps: { main: { signedInTo: { org: "globex", as: "admin" } } },
    }),
    /v1 limitation: apps may only sign in to primary org "acme"/,
  );
});

test("defineWorld accepts a fresh app without a sign-in target", () => {
  const world = defineWorld({
    den: { orgs: { acme: {} } },
    apps: { main: {} },
  });

  assert.deepEqual(world.topology.apps, { main: {} });
});

test("live shared production desktop state is symbolic and desktop-only", () => {
  const world = defineWorld({
    den: { orgs: {} },
    apps: {
      main: { desktopState: { source: "installed-production", mode: "live-shared" } },
    },
  });
  assert.deepEqual(world.topology.apps?.main?.desktopState, {
    source: "installed-production",
    mode: "live-shared",
  });
  assert.throws(
    () => defineWorld({
      den: { orgs: {} },
      apps: {
        main: {
          desktopState: { source: "installed-production", mode: "live-shared" },
          sessions: ["must not seed"],
        },
      },
    }),
    /live shared boot does not seed, sign in, or override production state/,
  );
  assert.throws(
    () => defineWorld({
      den: { orgs: { acme: {} } },
      apps: {
        main: { desktopState: { source: "installed-production", mode: "live-shared" } },
      },
    }),
    /must be desktop-only/,
  );
});

test("defineWorld validates fixed Den ports", () => {
  const world = defineWorld({
    den: {
      orgs: { acme: {} },
      ports: { api: 8790, web: 3005 },
    },
  });

  assert.deepEqual(world.topology.den.ports, { api: 8790, web: 3005 });
  assert.throws(
    () => defineWorld({ den: { orgs: { acme: {} }, ports: { api: 1023, web: 3005 } } }),
    /Too small.*1024/,
  );
  assert.throws(
    () => defineWorld({ den: { orgs: { acme: {} }, ports: { api: 8790, web: 65_536 } } }),
    /Too big.*65535/,
  );
});

test("demo seed requires one content-free organization", () => {
  const world = defineWorld({
    den: {
      orgs: { "A user-chosen topology name": {} },
      seed: "demo-org",
    },
  });
  assert.equal(world.topology.den.seed, "demo-org");

  assert.throws(
    () => defineWorld({
      den: { orgs: { acme: {}, globex: {} }, seed: "demo-org" },
    }),
    /requires exactly one organization: v1 limitation/,
  );
  assert.throws(
    () => defineWorld({
      den: { orgs: { acme: { members: { jordan: {} } } }, seed: "demo-org" },
    }),
    /cannot define organization members: v1 limitation/,
  );
  assert.throws(
    () => defineWorld({
      den: { orgs: { acme: { plugins: [] } }, seed: "demo-org" },
    }),
    // Anchor on the stable reason, not the growing noun enumeration.
    /v1 limitation: the demo seed owns these content nouns/,
  );
});

test("defineWorld validates declarative app session titles", () => {
  const world = defineWorld({
    den: { orgs: { acme: {} } },
    apps: {
      signedIn: { signedInTo: { org: "acme", as: "admin" }, sessions: ["Q3 report"] },
      fresh: { sessions: ["Invoice cleanup"] },
    },
  });

  assert.deepEqual(world.topology.apps?.signedIn?.sessions, ["Q3 report"]);
  assert.deepEqual(world.topology.apps?.fresh?.sessions, ["Invoice cleanup"]);
  assert.throws(
    () => defineWorld({
      den: { orgs: { acme: {} } },
      apps: { main: { sessions: [""] } },
    }),
    /Too small.*1 character/,
  );
  assert.throws(
    () => defineWorld({
      den: { orgs: { acme: {} } },
      apps: { main: { sessions: Array.from({ length: 31 }, (_, index) => `Session ${index}`) } },
    }),
    /Too big.*30/,
  );
});

test("defineWorld constrains enterprise witness profiles and their faults", () => {
  const world = defineWorld({
    den: { orgs: { acme: {} } },
    witnesses: {
      provider: {
        kind: "mcp",
        profileId: "microsoft-enterprise",
        fault: "upstream-unavailable",
      },
    },
  });

  assert.deepEqual(world.topology.witnesses?.provider, {
    kind: "mcp",
    profileId: "microsoft-enterprise",
    fault: "upstream-unavailable",
  });
  assert.throws(
    () => defineWorld({
      den: { orgs: { acme: {} } },
      witnesses: { provider: { kind: "mcp", fault: "upstream-unavailable" } },
    }),
    /faults ride the enterprise mock profiles/,
  );
  assert.throws(
    () => Reflect.apply(defineWorld, undefined, [{
      den: { orgs: { acme: {} } },
      witnesses: { provider: { kind: "mcp", profileId: "unknown-profile" } },
    }]),
    /Invalid option/,
  );
});

test("defineWorld rejects connections whose witness is not declared", () => {
  assert.throws(
    () => defineWorld({
      den: {
        orgs: {
          acme: { connections: [{ name: "Notion", witness: "notion" }] },
        },
      },
    }),
    /connection "Notion" references witness "notion", which does not exist in topology\.witnesses/,
  );
  assert.throws(
    () => defineWorld({
      den: {
        orgs: {
          acme: { connections: [{ name: "Notion", witness: "notion" }] },
        },
      },
      witnesses: {
        notion: { kind: "litellm", modelId: "witness-model", reply: "ok" },
      },
    }),
    /connection "Notion" must reference an MCP witness; "notion" has kind "litellm"/,
  );
});

test("defineWorld constrains LLM providers to declared LiteLLM witnesses", () => {
  const provider = {
    kind: "litellm-per-member" as const,
    name: "Per-Member Gateway",
    providerId: "openwork-litellm",
    env: "LITELLM_PER_MEMBER_API_KEY",
    witness: "litellm",
  };
  const world = defineWorld({
    den: { orgs: { acme: { llmProviders: [provider] } } },
    witnesses: {
      litellm: { kind: "litellm", modelId: "witness-model", reply: "ok" },
    },
  });
  assert.deepEqual(world.topology.den.orgs.acme?.llmProviders, [provider]);

  assert.throws(
    () => defineWorld({
      den: { orgs: { acme: { llmProviders: [provider] } } },
    }),
    /LLM provider "Per-Member Gateway" references witness "litellm", which does not exist in topology\.witnesses/,
  );
  assert.throws(
    () => defineWorld({
      den: { orgs: { acme: { llmProviders: [provider] } } },
      witnesses: { litellm: { kind: "mcp" } },
    }),
    /LLM provider "Per-Member Gateway" must reference a LiteLLM witness; "litellm" has kind "mcp"/,
  );
});

test("defineWorld rejects content nouns on a non-primary organization", () => {
  assert.throws(
    () => defineWorld({
      den: {
        orgs: {
          acme: {},
          globex: { capabilities: { mcpConnections: true } },
        },
      },
    }),
    /v1 limitation: these content nouns may only be defined on primary org "acme"/,
  );
});

test("defineWorld requires desktop policy members to be org member keys", () => {
  assert.throws(
    () => defineWorld({
      den: {
        orgs: {
          acme: {
            members: { jordan: {} },
            desktopPolicies: [{ name: "Research", members: ["casey"] }],
          },
        },
      },
    }),
    /desktop policy "Research" member "casey" must be a member key of that org/,
  );
  assert.throws(
    () => defineWorld({
      den: {
        orgs: {
          acme: {
            members: { jordan: {} },
            desktopPolicies: [{
              name: "Research",
              teams: [{ name: "Product", members: ["casey"] }],
            }],
          },
        },
      },
    }),
    /desktop policy "Research" team "Product" member "casey" must be a member key of that org/,
  );
});

test("WorldDefinition.with deep-merges records, replaces scalars, and revalidates", () => {
  const base = defineWorld({
    den: {
      orgs: {
        acme: {
          admin: { email: "admin@acme.test", name: "Alex" },
          members: { jordan: { name: "Jordan" } },
        },
      },
      env: { FIRST: "one" },
      web: true,
    },
    apps: {
      main: {
        signedInTo: { org: "acme", as: "admin" },
        model: "old-model",
      },
    },
  });

  const changed = base.with({
    den: {
      orgs: { acme: { admin: { name: "Alice" } } },
      env: { SECOND: "two" },
      web: false,
    },
    apps: { main: { model: "new-model" } },
  });

  assert.deepEqual(changed.topology, {
    den: {
      orgs: {
        acme: {
          admin: { email: "admin@acme.test", name: "Alice" },
          members: { jordan: { name: "Jordan" } },
        },
      },
      env: { FIRST: "one", SECOND: "two" },
      web: false,
      substrate: "local",
    },
    apps: {
      main: {
        signedInTo: { org: "acme", as: "admin" },
        model: "new-model",
      },
    },
  });
  assert.equal(base.topology.den.web, true);

  assert.deepEqual(base.with({ apps: { fresh: {} } }).topology.apps?.fresh, {});
});
