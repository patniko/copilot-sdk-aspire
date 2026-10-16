import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalSessionId, OwnerHostDescriptor, OwnerHostList, ownerHostEnvSuffix, ownerHostResource, ownerHostTransports } from "@copilot-agent/contracts";
import { isolatedHostsOf, loadHarnesses, loadPolicy, ownerHostKey, ownerHostUrl, readOwnerHosts } from "@copilot-agent/service-defaults";
import { readHostIdentity, writeHostIdentity } from "../../src/agent-host/src/identity.js";
import { OwnerConfiguration } from "../../src/agent-host/src/protocol.js";
import { managedHostOptions } from "../../src/agent-host/src/transports.js";
import { websocketUrl } from "../../src/agent-api/src/host-routes.js";
import { hostingDeployment } from "../../src/agent-api/src/hosting-deployment.js";
import { ownerHostPolicyProblem } from "../../src/job-dispatcher/src/host-routes.js";

const root = join(import.meta.dirname, "..", "..");
const customerConfigRoot = join(root, "examples", "customer-config");
const [harnesses, policy] = await Promise.all([loadHarnesses(customerConfigRoot), loadPolicy(customerConfigRoot)]);
const harness = harnesses.get("interactive-demo")![0]!;

describe("owner host configuration", () => {
  it("parses per-harness hosts with an owner principal and an optional policy size", () => {
    const hosts = OwnerHostList.parse([{ harness: "interactive-demo", transport: "both" }, { harness: "repo-helper", transport: "direct", size: "medium", principal: "alice" }]);
    expect(hosts[0]).toEqual({ harness: "interactive-demo", transport: "both", principal: "dev" });
    expect(hosts[1]).toMatchObject({ size: "medium", principal: "alice" });
    expect(ownerHostTransports("both")).toEqual(["direct", "github"]);
    expect(ownerHostTransports("github")).toEqual(["github"]);
    expect(ownerHostResource("interactive-demo")).toBe("host-interactive-demo");
    expect(ownerHostEnvSuffix("interactive-demo")).toBe("INTERACTIVE_DEMO");
  });

  it("rejects duplicate harnesses, over-long resource names, and native execution on a direct transport", () => {
    expect(OwnerHostList.safeParse([{ harness: "a-host", transport: "direct" }, { harness: "a-host", transport: "github" }]).success).toBe(false);
    expect(OwnerHostList.safeParse([{ harness: "a".repeat(28), transport: "direct" }]).success).toBe(false);
    expect(OwnerHostList.safeParse([{ harness: "a-host", transport: "disabled" }]).success).toBe(false);
    expect(OwnerHostDescriptor.safeParse({
      harness: "a-host", owner: "alice", principal: "dev", transport: "both", execution: "github-native", resource: "agent-host",
    }).success).toBe(false);
  });

  it("merges per-harness descriptors with the legacy demo host and keeps their keys separate", () => {
    const env = {
      OWNER_HOSTS: JSON.stringify([{ harness: "repo-helper", owner: "Alice", principal: "alice", transport: "both", execution: "managed", resource: "host-repo-helper", size: { name: "small", cpus: 0.5, memoryMiB: 1024 } }]),
      OWNER_HOST_KEY_REPO_HELPER: "k".repeat(48), OWNER_HOST_URL_REPO_HELPER: "http://localhost:4100/",
      DEMO_HOST_OWNER: "Alice", DEMO_HOST_TRANSPORT: "github", DEMO_HOST_HARNESS: "interactive-demo", DEMO_HOST_KEY: "d".repeat(48),
    };
    const hosts = readOwnerHosts(env);
    expect(hosts.map((host) => [host.harness, host.owner, host.execution, host.legacy, host.resource])).toEqual([
      ["repo-helper", "alice", "managed", false, "host-repo-helper"],
      ["interactive-demo", "alice", "github-native", true, "agent-host"],
    ]);
    expect(ownerHostKey(hosts[0]!, env)).toBe("k".repeat(48));
    expect(ownerHostKey(hosts[1]!, env)).toBe("d".repeat(48));
    expect(ownerHostUrl(hosts[0]!, env)).toBe("http://localhost:4100");
    expect(() => ownerHostKey(hosts[0]!, { ...env, OWNER_HOST_KEY_REPO_HELPER: "short" })).toThrow(/OWNER_HOST_KEY_REPO_HELPER/);
    // A GitHub-native host ignores its harness, so it never counts as that harness's isolated host.
    expect(isolatedHostsOf(hosts)).toEqual([{ harness: "repo-helper", owner: "alice", transports: ["direct", "github"], features: [] }]);
    expect(() => readOwnerHosts({ ...env, DEMO_HOST_HARNESS: "repo-helper" })).toThrow(/both as the demo host and as an owner host/);
    expect(readOwnerHosts({ DEMO_HOST_OWNER: "alice", DEMO_HOST_TRANSPORT: "disabled" })).toEqual([]);
  });

  it("converts host endpoints into the WebSocket URLs clients pin", () => {
    expect(websocketUrl("http://localhost:4100")).toBe("ws://localhost:4100/");
    expect(websocketUrl("https://host.example")).toBe("wss://host.example/");
    expect(() => websocketUrl("http://localhost:4100/?tkn=secret")).toThrow();
  });

  it("canonicalizes the runtime's session identities and refuses non-UUID ones", () => {
    expect(canonicalSessionId("199B2CBD37014CD5B757E1075EF6FD5C")).toBe("199b2cbd-3701-4cd5-b757-e1075ef6fd5c");
    expect(canonicalSessionId("199b2cbd-3701-4cd5-b757-e1075ef6fd5c")).toBe("199b2cbd-3701-4cd5-b757-e1075ef6fd5c");
    expect(canonicalSessionId("durable-attached")).toBeUndefined();
    expect(canonicalSessionId("199b2cbd37014cd5b757e1075ef6fd5")).toBeUndefined();
  });
});

describe("owner hosts in the hosting deployment", () => {
  it("adds each managed owner host as its harness's isolated host and leaves GitHub-native hosts out", () => {
    const hosts = readOwnerHosts({
      OWNER_HOSTS: JSON.stringify([{ harness: "review-agent", owner: "alice", principal: "alice", transport: "github", execution: "managed", resource: "host-review-agent" }]),
      DEMO_HOST_OWNER: "alice", DEMO_HOST_TRANSPORT: "both", DEMO_HOST_HARNESS: "interactive-demo",
    });
    expect(hostingDeployment({ executor: "pool", ownerHosts: hosts, sharedWorker: false }).isolatedHosts).toEqual([
      { harness: "review-agent", owner: "alice", transports: ["github"], features: [] },
      { harness: "interactive-demo", owner: "dev", transports: ["direct", "github"], features: [] },
    ]);
    // The legacy input describes the same demo host; it is not added twice.
    expect(hostingDeployment({
      executor: "pool", ownerHosts: hosts, demoHost: { transport: "both", harness: "interactive-demo", principal: "dev" }, sharedWorker: false,
    }).isolatedHosts).toHaveLength(2);
    const native = readOwnerHosts({ DEMO_HOST_OWNER: "alice", DEMO_HOST_TRANSPORT: "github", DEMO_HOST_HARNESS: "interactive-demo" });
    expect(hostingDeployment({ executor: "pool", ownerHosts: native, sharedWorker: false }).isolatedHosts).toEqual([]);
  });
});

describe("managed owner host transports", () => {
  const base = {
    owner: "alice", ownerUserId: 1, computeId: randomUUID(), dataDirectory: "/data/execution", harness: "interactive-demo",
    execution: "managed" as const, gatewayUrl: "http://gateway/openai/v1/", model: "grok-4.6", maxTurnSeconds: 600,
  };
  const token = "t".repeat(48);
  const github = "g".repeat(40);
  const managed = (value: unknown) => {
    const parsed = OwnerConfiguration.parse(value);
    if (parsed.execution !== "managed") throw new Error("Expected a managed configuration.");
    return parsed;
  };

  it("validates which transports need a listener token or the owner's credential", () => {
    expect(OwnerConfiguration.safeParse({ ...base, transport: "direct", connectionToken: token, port: 8765 }).success).toBe(true);
    expect(OwnerConfiguration.safeParse({ ...base, transport: "github", githubToken: github }).success).toBe(true);
    expect(OwnerConfiguration.safeParse({ ...base, transport: "github", githubToken: github, connectionToken: token, port: 8765 }).success).toBe(false);
    expect(OwnerConfiguration.safeParse({ ...base, transport: "both", connectionToken: token, port: 8765 }).success).toBe(false);
    expect(OwnerConfiguration.safeParse({ ...base, transport: "direct" }).success).toBe(false);
  });

  it("registers one environment per relay-enabled harness and keeps the catalog on the durable compute identity", () => {
    const callbacks = { createSession: undefined, resumeSession: undefined, onExit: undefined };
    const direct = managedHostOptions(managed({ ...base, transport: "direct", connectionToken: token, port: 8765 }), callbacks);
    expect(direct).toMatchObject({ computeId: base.computeId, localServer: { hostname: "0.0.0.0", port: 8765, token } });
    expect(direct.githubEnvironment).toBeUndefined();
    const relay = managedHostOptions(managed({ ...base, transport: "github", githubToken: github }), callbacks);
    expect(relay.localServer).toBeUndefined();
    expect(relay.githubEnvironment).toEqual({ name: "Aspire interactive-demo (alice)", computeId: base.computeId });
    const both = managedHostOptions(managed({ ...base, transport: "both", connectionToken: token, port: 8765, githubToken: github }), callbacks);
    expect(both.localServer).toBeDefined();
    expect(both.githubEnvironment?.computeId).toBe(base.computeId);
  });
});

describe("owner host volume identity", () => {
  it("pins a volume to its harness, numeric owner, and compute identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "owner-host-identity-"));
    try {
      expect(await readHostIdentity(directory, { harness: "interactive-demo", ownerUserId: 1 })).toBeUndefined();
      const computeId = randomUUID();
      await writeHostIdentity(directory, { harness: "interactive-demo", ownerUserId: 1, computeId });
      expect(await readHostIdentity(directory, { harness: "interactive-demo", ownerUserId: 1 })).toEqual({ schemaVersion: 1, harness: "interactive-demo", ownerUserId: 1, computeId });
      if (process.platform !== "win32") expect((await stat(join(directory, "host.json"))).mode & 0o777).toBe(0o600);
      await expect(readHostIdentity(directory, { harness: "interactive-demo", ownerUserId: 2 })).rejects.toThrow(/different harness or GitHub owner/);
      await expect(readHostIdentity(directory, { harness: "other-harness", ownerUserId: 1 })).rejects.toThrow(/different harness or GitHub owner/);
      await writeFile(join(directory, "host.json"), "{not json");
      await expect(readHostIdentity(directory, { harness: "interactive-demo", ownerUserId: 1 })).rejects.toThrow(/invalid/);
      expect(await readFile(join(directory, "host.json"), "utf8")).toBe("{not json");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("owner host hosting policy", () => {
  it("allows an isolated harness on the default transports", () => {
    expect(ownerHostPolicyProblem({ harness: harness.definition.name, transport: "both", snapshot: harness, policy })).toBeUndefined();
  });

  it("refuses transports the effective policy does not allow", () => {
    const directOnly = { ...policy, hosting: { transports: ["direct" as const] } };
    expect(ownerHostPolicyProblem({ harness: harness.definition.name, transport: "both", snapshot: harness, policy: directOnly }))
      .toMatchObject({ code: "transport_not_allowed" });
    expect(ownerHostPolicyProblem({ harness: harness.definition.name, transport: "github", snapshot: harness, policy: directOnly }))
      .toMatchObject({ code: "transport_not_allowed" });
    expect(ownerHostPolicyProblem({ harness: harness.definition.name, transport: "direct", snapshot: harness, policy: directOnly })).toBeUndefined();
  });
});
