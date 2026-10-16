import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { hostingHostsOf, type ExecutionProfile, type HarnessSnapshot, type HostingDeployment, type PolicySet } from "@copilot-agent/contracts";
import { harnessHostingView, loadHarnesses, loadPolicySet, loadProfiles, type ConfiguredOwnerHost } from "@copilot-agent/service-defaults";
import { hostingDeployment } from "../../src/agent-api/src/hosting-deployment.js";
import { harnessConnectRoute } from "../../configurator/server/connect-route.js";

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
