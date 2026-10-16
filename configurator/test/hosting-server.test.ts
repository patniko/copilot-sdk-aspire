import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ExecutionPolicy,
  HarnessDefinition,
  type HarnessPolicyOverride,
  type HarnessSnapshot,
  type HostingDeployment,
  HostingOverview,
  type PolicySet,
} from "@copilot-agent/contracts";
import { hostingOverview } from "@copilot-agent/service-defaults";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../server/app.js";
import { harnessHostingDetail, hostingTargets, latestDocuments, readServiceView, staleVersions } from "../server/hosting.js";
import { templateHarness } from "../server/repo.js";
import type { HarnessDocument, ProfileSummary } from "../server/types.js";
import { definitionOf, executionProfiles, harnessDigest } from "../server/validate.js";

const repoRoot = join(import.meta.dirname, "..", "..");

const profiles: ProfileSummary[] = [
  {
    id: "node-ts-agent", displayName: "TS", language: "typescript", sdk: "sdk", sdkVersion: "1", firstParty: true,
    toolBindings: ["python:stats"], capabilities: ["cancel", "structured-result", "builtin-tools", "interactive"],
    permissionHandlers: ["acme-approvals"],
  },
];

const policy: ExecutionPolicy = {
  schemaVersion: "1",
  allowedProfiles: ["node-ts-agent"],
  allowedModels: ["approved-model"],
  maxDurationSeconds: 600,
  maxInferenceTokensPerJob: 500_000,
  maxConcurrentAttemptsPerPrincipal: 2,
  maxQueuedJobsPerPrincipal: 10,
  retry: { maxAttempts: 2, backoffSeconds: 5 },
  leaseSeconds: 30,
  requirements: { processIsolation: "uid", egress: "gateway-only" },
  acknowledgedGaps: ["egress-not-enforced"],
  approvalModes: ["manual", "assisted"],
  permissionHandlers: ["acme-approvals"],
  mcpServers: {
    "docs-search": {
      url: "https://mcp.example.com/docs",
      description: "Synthetic documentation search",
      auth: { secret: "docs-search-token" },
      tools: ["search", "fetch_page"],
    },
  },
  hosting: { modes: ["isolated", "shared"] },
};

function conversation(name: string, version = "1.0.0", mutate: (d: HarnessDocument) => void = () => undefined): HarnessDocument {
  const doc = templateHarness(name, "approved-model", ["node-ts-agent"]);
  doc.manifest.version = version;
  doc.manifest.interaction = "conversation";
  if (version !== "1.0.0") doc.folder = `${name}@${version}`;
  mutate(doc);
  return doc;
}

function overrideFor(harness: string, overrides: HarnessPolicyOverride["overrides"]): [string, HarnessPolicyOverride] {
  return [harness, { schemaVersion: "1", harness, overrides }];
}

function snapshotOf(document: HarnessDocument): HarnessSnapshot {
  return { definition: HarnessDefinition.parse(definitionOf(document)), digest: harnessDigest(document)! };
}

/** A real `GET /v1/hosting` view built with the service's own function. */
function serviceView(documents: HarnessDocument[], deployment: HostingDeployment, policies: PolicySet): HostingOverview {
  const harnesses = new Map<string, HarnessSnapshot[]>();
  for (const document of latestDocuments(documents)) harnesses.set(document.manifest.name, [snapshotOf(document)]);
  return hostingOverview({ harnesses, profiles: executionProfiles(profiles), policies, deployment });
}

describe("hosting detail for the harness editor", () => {
  const chat = conversation("chat");
  const chatNext = conversation("chat", "1.2.0");
  const shared = conversation("triage", "1.0.0", (d) => void (d.manifest.hosting = { mode: "shared" }));
  const job = templateHarness("job", "approved-model", ["node-ts-agent"]);
  const documents = [chat, chatNext, shared, job];
  const policies: PolicySet = { base: policy, overrides: new Map([overrideFor("triage", { hosting: { modes: ["isolated"] } })]) };

  it("uses the latest version of each harness", () => {
    expect(latestDocuments(documents).map((d) => `${d.manifest.name}@${d.manifest.version}`)).toEqual(["chat@1.2.0", "job@1.0.0", "triage@1.0.0"]);
  });

  it("describes worker and handoff targets with their mode and what their own policy allows", () => {
    expect(hostingTargets(documents, policies, "chat")).toEqual([
      expect.objectContaining({ name: "job", interaction: "batch", mode: "isolated", modeAllowed: true, isolatedAllowed: true }),
      expect.objectContaining({ name: "triage", interaction: "conversation", mode: "shared", modeAllowed: false, isolatedAllowed: true }),
    ]);
  });

  it("offers the effective ceilings and catalog without server URLs or secret references", () => {
    const detail = harnessHostingDetail({ name: "chat", policy, profiles, documents, policies });
    expect(detail.ceilings.modes).toEqual(["isolated", "shared"]);
    expect(detail.ceilings.approvalModes).toEqual(["manual", "assisted"]);
    expect(detail.ceilings.permissionHandlers).toEqual(["acme-approvals"]);
    expect(detail.mcpCatalog).toEqual([{ server: "docs-search", description: "Synthetic documentation search", tools: ["search", "fetch_page"] }]);
    expect(detail.profileHandlers).toEqual(["acme-approvals"]);
    expect(detail.allowedModels).toEqual(["approved-model"]);
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain("docs-search-token");
    expect(serialized).not.toContain("mcp.example.com");
  });
});

describe("agent-api hosting views", () => {
  it("uses a view that matches the contract and explains any other answer", async () => {
    const view: HostingOverview = { hosts: { executor: "pool", isolatedHosts: [] }, harnesses: [] };
    await expect(readServiceView(async () => ({ status: 200, body: view }), HostingOverview, "missing")).resolves.toEqual({ value: view });
    await expect(readServiceView(async () => ({ status: 404, body: {} }), HostingOverview, "Not loaded.")).resolves.toEqual({ problem: "Not loaded." });
    await expect(
      readServiceView(async () => ({ status: 409, body: { error: { code: "conflict", message: "The local stack is not running." } } }), HostingOverview, "x"),
    ).resolves.toEqual({ problem: "The local stack is not running." });
    await expect(readServiceView(async () => ({ status: 500, body: "oops" }), HostingOverview, "x")).resolves.toEqual({
      problem: "The agent-api answered with HTTP 500.",
    });
    await expect(readServiceView(async () => ({ status: 200, body: { hosts: {} } }), HostingOverview, "x")).resolves.toEqual({
      problem: "The agent-api returned a hosting view this configurator does not recognize.",
    });
    await expect(
      readServiceView(async () => {
        throw new Error("Could not reach agent-api at http://127.0.0.1:1.");
      }, HostingOverview, "x"),
    ).resolves.toEqual({ problem: "Could not reach agent-api at http://127.0.0.1:1." });
  });

  it("lists workspace versions the service has not loaded as saved", () => {
    const loaded = conversation("chat");
    const edited = conversation("chat", "1.0.0", (d) => void (d.manifest.description = "Edited after the service loaded it."));
    const added = conversation("added");
    const policies: PolicySet = { base: policy, overrides: new Map() };
    const view = serviceView([loaded], { executor: "pool", isolatedHosts: [] }, policies);
    expect(staleVersions([loaded], view)).toEqual([]);
    expect(staleVersions([edited, added], view)).toEqual([
      { harness: "added", version: "1.0.0", reason: "missing" },
      { harness: "chat", version: "1.0.0", reason: "changed" },
    ]);
    const newer = conversation("chat", "1.1.0");
    expect(staleVersions([loaded, newer], view)).toEqual([{ harness: "chat", version: "1.1.0", reason: "missing" }]);
  });
});

describe("configurator hosting routes", () => {
  const token = "test-token-hosting-0123456789";
  const port = 4998;
  const headers = { host: `127.0.0.1:${port}`, "x-configurator-token": token };
  const fetcher = vi.fn<(target: "local" | "azure", path: string) => Promise<{ status: number; body: unknown }>>();
  let root: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "configurator-hosting-"));
    const platformRoot = join(root, "platform");
    await cp(join(repoRoot, "examples", "customer-config"), join(platformRoot, "examples", "customer-config"), { recursive: true });
    await cp(join(repoRoot, "execution-profiles"), join(platformRoot, "execution-profiles"), { recursive: true });
    await cp(join(repoRoot, "examples", "customer-config", "harnesses"), join(root, "harnesses"), { recursive: true });
    await cp(join(repoRoot, "examples", "customer-config", "policy"), join(root, "policy"), { recursive: true });
    const base = JSON.parse(await readFile(join(root, "policy", "execution-policy.json"), "utf8")) as ExecutionPolicy;
    await writeFile(
      join(root, "policy", "execution-policy.json"),
      JSON.stringify({ ...base, mcpServers: { "docs-search": { url: "https://mcp.example.com/docs", auth: { secret: "docs-search-token" }, tools: ["search"] } } }),
    );
    app = await buildApp({ root: platformRoot, workspaceRoot: root, token, port, hostingViewFetcher: fetcher });
  });

  afterAll(async () => {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  });

  beforeEach(() => fetcher.mockReset());

  it("returns the editor's hosting detail without the catalog's URL or secret reference", async () => {
    const response = await app.inject({ method: "GET", url: "/api/harnesses/interactive-demo", headers });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.hosting.ceilings.modes).toEqual(["isolated"]);
    expect(body.hosting.mcpCatalog).toEqual([{ server: "docs-search", tools: ["search"] }]);
    expect(body.hosting.profileHandlers).toEqual(["workspace-drafts"]);
    expect(body.hosting.targets.map((target: { name: string }) => target.name)).toContain("shared-researcher");
    expect(JSON.stringify(body.hosting)).not.toMatch(/docs-search-token|mcp\.example\.com/);
  });

  it("reports the documented defaults for omitted policy fields", async () => {
    const body = (await app.inject({ method: "GET", url: "/api/workspace", headers })).json();
    expect(body.policyDefaults.hosting.modes).toEqual(["isolated"]);
    expect(body.policyDefaults.hosting.transports).toEqual(["direct", "github"]);
    expect(body.policyDefaults.approvalModes).toEqual(["manual"]);
  });

  it("reads the per-harness view from the target's agent-api and lists what it has not loaded", async () => {
    const overview: HostingOverview = { hosts: { executor: "pool", isolatedHosts: [] }, harnesses: [] };
    fetcher.mockResolvedValueOnce({ status: 200, body: overview });
    const response = await app.inject({ method: "GET", url: "/api/hosting?target=local", headers });
    expect(fetcher).toHaveBeenCalledWith("local", "/v1/hosting");
    const body = response.json();
    expect(body.overview).toEqual(overview);
    expect(body.stale).toEqual(expect.arrayContaining([{ harness: "interactive-demo", version: "1.0.0", reason: "missing" }]));
  });

  it("keeps the session-container offer that the Hosting page's launcher actions follow", async () => {
    const deployment: HostingDeployment = { executor: "pool", isolatedHosts: [], sessionContainers: { transports: ["direct"], features: [] } };
    const overview = serviceView([conversation("chat")], deployment, { base: policy, overrides: new Map() });
    fetcher.mockResolvedValueOnce({ status: 200, body: overview });
    const body = (await app.inject({ method: "GET", url: "/api/hosting?target=local", headers })).json();
    expect(body.overview.hosts.sessionContainers).toEqual({ transports: ["direct"], features: [] });
    // The fixtures in hosting.test.tsx mirror this view: direct WSS is ready, and the relay names its missing transport.
    expect(body.overview.harnesses[0]).toMatchObject({ harness: "chat", placement: "container", status: "ready", problems: [] });
    expect(body.overview.harnesses[0].transports).toEqual([
      { transport: "direct", allowed: true, available: true },
      {
        transport: "github",
        allowed: true,
        available: false,
        problem: { code: "hosting_unavailable", message: "No host for 'chat' offers the GitHub relay.", prerequisite: { kind: "transport", name: "github" } },
      },
    ]);
  });

  it("says why the view is unavailable instead of evaluating hosting itself", async () => {
    fetcher.mockResolvedValueOnce({ status: 404, body: {} });
    const body = (await app.inject({ method: "GET", url: "/api/hosting?target=azure", headers })).json();
    expect(fetcher).toHaveBeenCalledWith("azure", "/v1/hosting");
    expect(body).toEqual({ target: "azure", problem: "The running agent-api does not report hosting. Rebuild and restart it from Local run.", stale: [] });
  });

  it("forwards one harness version and validates the request first", async () => {
    fetcher.mockResolvedValueOnce({ status: 404, body: { error: { code: "harness_not_found" } } });
    const missing = (await app.inject({ method: "GET", url: "/api/hosting/interactive-demo?version=1.0.0", headers })).json();
    expect(fetcher).toHaveBeenCalledWith("local", "/v1/hosting/interactive-demo?version=1.0.0");
    expect(missing.problem).toBe("The running service has not loaded interactive-demo 1.0.0. Save it, then reload harnesses from Local run.");
    expect((await app.inject({ method: "GET", url: "/api/hosting/Not_A_Slug", headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/hosting/interactive-demo?version=latest", headers })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/hosting?target=elsewhere", headers })).statusCode).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns the service's view of one harness", async () => {
    const documents = [conversation("interactive-demo")];
    const view = serviceView(documents, { executor: "pool", isolatedHosts: [] }, { base: policy, overrides: new Map() }).harnesses[0]!;
    fetcher.mockResolvedValueOnce({ status: 200, body: view });
    const body = (await app.inject({ method: "GET", url: "/api/hosting/interactive-demo", headers })).json();
    expect(fetcher).toHaveBeenCalledWith("local", "/v1/hosting/interactive-demo");
    expect(body).toEqual({ target: "local", view });
    expect(view.status).toBe("unavailable");
    expect(view.problems[0]?.prerequisite).toEqual({ kind: "host", name: "isolated-host" });
  });
});
