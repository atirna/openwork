import assert from "node:assert/strict";
import {
  createCleanupPlan,
  createNetworkEdge,
  createPlacement,
  exposePort,
  placementHasCapability,
  runOnPlacement,
  selectFaultPhase,
  test,
} from "@openwork/testkit";

test("network world primitives describe placements, ports, commands, faults, and cleanup without side effects", ({ evidence }) => {
  const localLinux = createPlacement({ id: "local-linux", provider: "local", os: "linux" });
  const daytonaK3s = createPlacement({
    id: "den-cluster",
    provider: "daytona-k3s",
    privileged: true,
    resources: { cpu: 4, memoryGb: 8, diskGb: 20 },
  });
  const windowsClient = createPlacement({ id: "windows-client", provider: "daytona-windows", privileged: true });

  assert.equal(localLinux.os, "linux");
  assert.equal(daytonaK3s.os, "linux");
  assert.equal(windowsClient.os, "windows");
  assert.equal(placementHasCapability(daytonaK3s, "kubernetes:k3s"), true);
  assert.equal(placementHasCapability(daytonaK3s, "surface:chrome"), false);
  assert.equal(placementHasCapability(daytonaK3s, "network:tls-intercept"), true);
  assert.equal(placementHasCapability(windowsClient, "trust:windows-machine-ca"), true);
  assert.equal(placementHasCapability(windowsClient, "command:powershell"), true);

  const localPort = exposePort(localLinux, 3005);
  const daytonaPort = exposePort(daytonaK3s, 3005);
  assert.deepEqual(localPort, {
    placementId: "local-linux",
    port: 3005,
    mode: "localhost",
    url: "http://127.0.0.1:3005",
    requiresRuntimeResolution: false,
  });
  assert.deepEqual(daytonaPort, {
    placementId: "den-cluster",
    port: 3005,
    mode: "daytona-preview",
    requiresRuntimeResolution: true,
  });

  const linuxCommand = runOnPlacement(daytonaK3s, "kubectl get pods");
  const windowsCommand = runOnPlacement(windowsClient, "Get-NetRoute");
  assert.deepEqual(linuxCommand.argv, ["bash", "-lc", "kubectl get pods"]);
  assert.deepEqual(windowsCommand.argv, ["powershell", "-NoProfile", "-NonInteractive", "-Command", "Get-NetRoute"]);

  const dns = createNetworkEdge({ id: "corp-dns", placement: daytonaK3s, kind: "dns-zone" });
  const mitm = createNetworkEdge({ id: "mitm-edge", placement: daytonaK3s, kind: "tls-intercept-proxy", upstreamResourceId: "den" });
  assert.deepEqual(dns.requiredCapabilities, ["network:dns"]);
  assert.deepEqual(mitm.requiredCapabilities, ["network:tls-intercept"]);
  assert.throws(
    () => createNetworkEdge({ id: "client-dns", placement: windowsClient, kind: "dns-zone" }),
    /missing capabilities: network:dns/,
  );

  assert.throws(
    () => createPlacement({ id: "bad-client", provider: "daytona-windows", os: "linux" }),
    /requires os "windows"/,
  );

  const phase = selectFaultPhase([
    { id: "baseline", actions: [{ kind: "recover", target: "mitm-edge" }] },
    {
      id: "vpn-flap",
      actions: [
        { kind: "drop", target: "mitm-edge", every: 3 },
        { kind: "dns-response", target: "corp-dns", response: "servfail" },
      ],
    },
  ], "vpn-flap");
  assert.equal(phase.id, "vpn-flap");
  assert.equal(phase.actionCount, 2);
  assert.throws(
    () => selectFaultPhase([
      { id: "duplicate", actions: [] },
      { id: "duplicate", actions: [] },
    ], "duplicate"),
    /duplicate ids/,
  );

  const receipt = createCleanupPlan("corp-world", [
    { resourceId: " corp-dns ", action: " remove dns zone ", command: linuxCommand },
    { resourceId: "mitm-edge", action: "remove test root", command: runOnPlacement(daytonaK3s, "rm -f /tmp/test-root.pem") },
  ]);
  assert.equal(receipt.steps.length, 2);
  assert.equal(receipt.steps[0]?.resourceId, "corp-dns");
  assert.equal(receipt.steps[0]?.action, "remove dns zone");
  evidence.recordAssertionEvidence(
    "World network primitives are side-effect-free contracts for later providers",
    `Planned ${daytonaK3s.provider} placement with ${daytonaK3s.capabilities.length} capabilities, ${daytonaPort.mode} exposure, ${phase.actionCount} validated fault actions, and ${receipt.steps.length} normalized cleanup steps.`,
    true,
  );
});
