import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { hostingHostsOf, type ExecutionProfile, type HarnessSnapshot, type HostingDeployment, type PolicySet } from "@copilot-agent/contracts";
import { harnessHostingView, hostingOverview, loadHarnesses, loadPolicySet, loadProfiles, type ConfiguredOwnerHost } from "@copilot-agent/service-defaults";
import { hostingDeployment } from "../../src/agent-api/src/hosting-deployment.js";
import { harnessConnectRoute, reprovisionSession, routeTargetProblem, SessionRouteChanged } from "../../configurator/server/connect-route.js";
import { harnessConnections } from "../../configurator/server/hosting.js";

const root = join(import.meta.dirname, "..", "..");
const api = { apiUrl: "http://127.0.0.1:3000", key: "synthetic-api-key" };
const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let harnesses: Map<string, HarnessSnapshot[]>;
let profiles: Map<string, ExecutionProfile>;
let policies: PolicySet;

const host = (harness: string, execution: "managed" | "github-native", transport: "direct" | "github" | "both", legacy = false): ConfiguredOwnerHost => ({
  harness, owner: "alice", principal: "dev", transport, execution, resource: legacy ? "agent-host" : `host-${harness}`, legacy,
});
const deploymentOf = (ownerHosts: ConfiguredOwnerHost[], options: { sessionContainers?: boolean; sharedWorker?: boolean } = {}) =>
  hostingDeployment({ executor: "on-demand", ownerHosts, sharedWorker: options.sharedWorker ?? false, sessionContainers: options.sessionContainers ?? false });
const viewOf = (deployment: HostingDeployment, harness: string, principal = "dev") =>
  harnessHostingView({ harnesses, profiles, policies, deployment }, harnesses.get(harness)![0]!, principal);

/** Serves the API lookups the router makes: owner-host views, the caller's application sessions, and the overview. */
function serve(deployment: HostingDeployment, ownerHosts: ConfiguredOwnerHost[], principal = "dev", sessions: string[] = []) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/v1/hosting") return Response.json({ hosts: hostingHostsOf(deployment), harnesses: [] });
    const harness = /^\/v1\/hosts\/([^/]+)$/.exec(path)?.[1];
    if (harness) {
      const entry = ownerHosts.find((candidate) => candidate.harness === harness);
      if (!entry) return Response.json({ error: { code: "hosting_unavailable" } }, { status: 409 });
      return Response.json({ harness, transport: entry.transport, execution: entry.execution, owned: entry.principal === principal, online: true, resource: entry.resource });
    }
    const session = /^\/v1\/sessions\/([^/]+)$/.exec(path)?.[1];
    if (session) return sessions.includes(session) ? Response.json({ id: session }) : Response.json({ error: { code: "not_found" } }, { status: 404 });
    throw new Error(`Unexpected request: ${path}`);
  });
}

beforeAll(async () => {
  const config = join(root, "examples", "customer-config");
  [harnesses, profiles, policies] = await Promise.all([loadHarnesses(config), loadProfiles(root), loadPolicySet(config)]);
  const demo = harnesses.get("interactive-demo")![0]!;
  harnesses.set("review-agent", [{ ...demo, definition: { ...demo.definition, name: "review-agent" } }]);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("pnpm host:connect routing for a named harness", () => {
  it("refuses, with the hosting view's reason, a harness that only a demo host for another harness or a GitHub-native host would reach", async () => {
    for (const hosts of [[host("review-agent", "managed", "both", true)], [host("interactive-demo", "github-native", "github", true)]]) {
      const deployment = deploymentOf(hosts);
      const request = serve(deployment, hosts);
      for (const transport of ["github", "direct"] as const) {
        await expect(harnessConnectRoute(api, "interactive-demo", viewOf(deployment, "interactive-demo"), transport))
          .rejects.toThrow(new RegExp(`^hosting_unavailable: No host for 'interactive-demo' offers the ${transport === "github" ? "GitHub relay" : "direct WSS"}`));
      }
      expect(request).not.toHaveBeenCalled();
      request.mockRestore();
    }
  });

  it("routes an isolated harness to its owner's own host on either transport, even when session containers serve it too", async () => {
    const hosts = [host("interactive-demo", "managed", "both")];
    const deployment = deploymentOf(hosts, { sessionContainers: true });
    serve(deployment, hosts);
    expect(await harnessConnectRoute(api, "interactive-demo", viewOf(deployment, "interactive-demo"), "github")).toEqual({ kind: "owner-host" });
    expect(await harnessConnectRoute(api, "interactive-demo", viewOf(deployment, "interactive-demo"), "direct")).toEqual({ kind: "owner-host" });
  });

  it("sends other principals to session containers, and refuses them the owner's relay with relay_owner_only", async () => {
    const hosts = [host("interactive-demo", "managed", "both")];
    const withContainers = deploymentOf(hosts, { sessionContainers: true });
    serve(withContainers, hosts, "other");
    expect(await harnessConnectRoute(api, "interactive-demo", viewOf(withContainers, "interactive-demo", "other"), "direct"))
      .toEqual({ kind: "sessions", placement: "container" });
    await expect(harnessConnectRoute(api, "interactive-demo", viewOf(withContainers, "interactive-demo", "other"), "github")).rejects.toThrow(/^relay_owner_only: /);
    const ownerOnly = deploymentOf(hosts);
    await expect(harnessConnectRoute(api, "interactive-demo", viewOf(ownerOnly, "interactive-demo", "other"), "direct"))
      .rejects.toThrow(/^hosting_unavailable: The isolated host for 'interactive-demo' serves only its owner/);
  });

  it("follows --resume to the caller's application session instead of the owner host", async () => {
    const hosts = [host("interactive-demo", "managed", "both")];
    const deployment = deploymentOf(hosts, { sessionContainers: true });
    serve(deployment, hosts, "dev", [sessionId]);
    expect(await harnessConnectRoute(api, "interactive-demo", viewOf(deployment, "interactive-demo"), "direct", sessionId))
      .toEqual({ kind: "sessions", placement: "container" });
    expect(await harnessConnectRoute(api, "interactive-demo", viewOf(deployment, "interactive-demo"), "direct", "f".repeat(32)))
      .toEqual({ kind: "owner-host" });
  });

  it("opens shared harnesses as shared conversations and refuses batch harnesses and unavailable shared hosting", async () => {
    const shared = deploymentOf([], { sharedWorker: true });
    expect(await harnessConnectRoute(api, "hybrid-coordinator", viewOf(shared, "hybrid-coordinator"), "direct")).toEqual({ kind: "sessions", placement: "shared" });
    await expect(harnessConnectRoute(api, "hybrid-coordinator", viewOf(shared, "hybrid-coordinator"), "github")).rejects.toThrow(/^transport_unsupported: /);
    await expect(harnessConnectRoute(api, "hybrid-coordinator", viewOf(deploymentOf([]), "hybrid-coordinator"), "direct")).rejects.toThrow(/^hosting_unavailable: /);
    await expect(harnessConnectRoute(api, "text-summarizer", viewOf(shared, "text-summarizer"), "direct")).rejects.toThrow(/runs as batch jobs/);
  });
});

describe("the configurator Hosting page decides as the launcher does", () => {
  /** What `GET /v1/hosts` returns to `principal`, built as `serve` builds the per-harness lookups. */
  const ownersFor = (hosts: ConfiguredOwnerHost[], principal: string) => ({
    hosts: hosts.map((entry) => ({
      harness: entry.harness, transport: entry.transport, execution: entry.execution, owned: entry.principal === principal, online: true, resource: entry.resource,
    })),
  });
  const both = host("interactive-demo", "managed", "both");
  const scenarios: Array<{ name: string; hosts: ConfiguredOwnerHost[]; options?: { sessionContainers?: boolean; sharedWorker?: boolean }; principal: string }> = [
    { name: "an owner whose host and session containers both serve direct WSS", hosts: [both], options: { sessionContainers: true }, principal: "dev" },
    { name: "another principal beside that owner host", hosts: [both], options: { sessionContainers: true }, principal: "other" },
    { name: "an owner whose host offers direct WSS only", hosts: [host("interactive-demo", "managed", "direct")], options: { sessionContainers: true }, principal: "dev" },
    { name: "an owner host without session containers", hosts: [both], principal: "dev" },
    { name: "another principal without session containers", hosts: [both], principal: "other" },
    { name: "session containers only", hosts: [], options: { sessionContainers: true }, principal: "dev" },
    { name: "a GitHub-native demo host beside session containers", hosts: [host("interactive-demo", "github-native", "github", true)], options: { sessionContainers: true }, principal: "dev" },
    { name: "a demo host for another harness", hosts: [host("review-agent", "managed", "both", true)], principal: "dev" },
    { name: "the shared worker", hosts: [], options: { sharedWorker: true }, principal: "dev" },
  ];

  for (const scenario of scenarios) {
    it(`connects or refuses every conversation harness and transport the same way for ${scenario.name}`, async () => {
      const deployment = deploymentOf(scenario.hosts, scenario.options);
      serve(deployment, scenario.hosts, scenario.principal);
      const overview = hostingOverview({ harnesses, profiles, policies, deployment }, scenario.principal);
      const page = await harnessConnections(overview, ownersFor(scenario.hosts, scenario.principal), "local");
      let compared = 0;
      for (const view of overview.harnesses.filter((entry) => entry.interaction === "conversation")) {
        for (const { transport } of view.transports) {
          const launcher = await harnessConnectRoute(api, view.harness, viewOf(deployment, view.harness, scenario.principal), transport)
            .then((route) => ({ route }), (error: unknown) => ({ refused: (error as Error).message }));
          const decision = page[view.harness]?.transports[transport];
          const shown = decision?.problem ? { refused: `${decision.problem.code}: ${decision.problem.message}` } : decision?.refusal ? { refused: decision.refusal } : { route: decision?.route };
          expect(shown, `${view.harness} over ${transport}`).toEqual(launcher);
          compared += 1;
        }
      }
      expect(compared).toBeGreaterThanOrEqual(8);
    });
  }

  it("refuses every --harness route on Azure with the launcher's own message", async () => {
    const deployment = deploymentOf([both], { sessionContainers: true, sharedWorker: true });
    const overview = hostingOverview({ harnesses, profiles, policies, deployment }, "dev");
    const page = await harnessConnections(overview, ownersFor([both], "dev"), "azure");
    const owner = { kind: "owner-host" } as const;
    const container = { kind: "sessions", placement: "container" } as const;
    const shared = { kind: "sessions", placement: "shared" } as const;
    expect(page["interactive-demo"]!.transports.direct).toEqual({ route: owner, refusal: routeTargetProblem(owner, "azure") });
    expect(page["review-agent"]!.transports.direct).toEqual({ route: container, refusal: routeTargetProblem(container, "azure") });
    expect(page["hybrid-coordinator"]!.transports.direct).toEqual({ route: shared, refusal: routeTargetProblem(shared, "azure") });
    expect(routeTargetProblem(owner, "azure")).toBe("Per-harness owner hosts are local-only until the Azure stage; use --destination container for the deployed demo host.");
    expect(routeTargetProblem(container, "azure")).toBe("The session container path currently supports local connections only. Azure qualification remains open.");
    expect(routeTargetProblem(container, "local")).toBeUndefined();
  });

  it("refuses as the launcher's failed lookup does when the owner hosts cannot be read, only where an owner host is deployed", async () => {
    const deployment = deploymentOf([both], { sessionContainers: true });
    const overview = hostingOverview({ harnesses, profiles, policies, deployment }, "dev");
    const page = await harnessConnections(overview, { error: "The owner host lookup failed (500)." }, "local");
    expect(page["interactive-demo"]!.transports.direct).toEqual({ refusal: "The owner host lookup failed (500)." });
    expect(page["interactive-demo"]!.ownsHost).toBe(false);
    expect(page["review-agent"]!.transports.direct).toEqual({ route: { kind: "sessions", placement: "container" } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ error: { code: "internal" } }, { status: 500 }));
    await expect(harnessConnectRoute(api, "interactive-demo", viewOf(deployment, "interactive-demo"), "direct")).rejects.toThrow("The owner host lookup failed (500).");
  });
});

describe("re-provisioning a moved session through the same routing", () => {
  /** Serves the hosting view and the session's connection, recording each request. */
  function serveMoved(deployment: HostingDeployment, harness: string, connection: (body: unknown) => Response, ownerHosts: ConfiguredOwnerHost[] = []) {
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push(`${init?.method ?? "GET"} ${path}`);
      if (path === `/v1/hosting/${harness}`) return Response.json(viewOf(deployment, harness));
      if (path === "/v1/hosting") return Response.json({ hosts: hostingHostsOf(deployment), harnesses: [] });
      if (path === `/v1/sessions/${sessionId}`) return Response.json({ id: sessionId });
      if (path === `/v1/sessions/${sessionId}/connection`) return connection(JSON.parse(String(init?.body ?? "{}")));
      const owner = /^\/v1\/hosts\/([^/]+)$/.exec(path)?.[1];
      const entry = ownerHosts.find((candidate) => candidate.harness === owner);
      if (entry) return Response.json({ harness: owner, transport: entry.transport, execution: entry.execution, owned: true, online: true, resource: entry.resource });
      throw new Error(`Unexpected request: ${path}`);
    });
    return requests;
  }
  const containerConnection = () => Response.json({
    sessionId, destination: "container", transport: "direct", ahpSessionId: sessionId, url: `ws://127.0.0.1:47000/sessions/${sessionId}`,
    token: "t".repeat(43), expiresAt: new Date(Date.now() + 60_000).toISOString(),
    serverKey: { keyId: "container", algorithm: "x25519-sealedbox", publicKey: "container-public" },
  });

  it("routes a promoted shared conversation again and connects to the same session at its new placement", async () => {
    const deployment = deploymentOf([], { sharedWorker: true, sessionContainers: true });
    const bodies: unknown[] = [];
    const requests = serveMoved(deployment, "hybrid-coordinator", (body) => { bodies.push(body); return containerConnection(); });
    expect(await reprovisionSession(api, "hybrid-coordinator", "direct", sessionId)).toMatchObject({ sessionId, destination: "container" });
    expect(requests).toEqual(["GET /v1/hosting/hybrid-coordinator", `POST /v1/sessions/${sessionId}/connection`]);
    expect(bodies).toEqual([{ transport: "direct" }]);
  });

  it("reports a move in progress as retryable and a route that no longer reaches the session as permanent", async () => {
    const shared = deploymentOf([], { sharedWorker: true, sessionContainers: true });
    serveMoved(shared, "hybrid-coordinator", () => Response.json({ error: { code: "promotion_in_progress", message: "Moving." } }, { status: 409 }));
    const moving = await reprovisionSession(api, "hybrid-coordinator", "direct", sessionId).catch((error: unknown) => error);
    expect(moving).toMatchObject({ status: 409, code: "promotion_in_progress" });
    expect(moving).not.toHaveProperty("permanent");
    vi.restoreAllMocks();
    // An isolated session whose deployment no longer runs session containers would route to an owner host instead.
    const hosts = [host("interactive-demo", "managed", "both")];
    serveMoved(deploymentOf(hosts), "interactive-demo", containerConnection, hosts);
    const changed = await reprovisionSession(api, "interactive-demo", "direct", sessionId).catch((error: unknown) => error);
    expect(changed).toBeInstanceOf(SessionRouteChanged);
    expect(changed).toMatchObject({ permanent: true });
  });
});
