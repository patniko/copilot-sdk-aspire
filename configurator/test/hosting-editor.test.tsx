import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessDetail, HarnessDocument, HarnessManifest } from "../server/types";
import { ServiceViewRow, withHostingMode, withInteraction } from "../src/views/harness/hosting";
import { HarnessTab, permissionsPreset, tabFor } from "../src/views/harness/tabs";

const state = vi.hoisted(() => ({
  workspace: { policy: { builtinTools: ["files", "web"], allowedModels: ["approved-model"], permissionModes: ["ask", "allow"] }, bindings: [] },
  local: { running: false, resources: [] },
  setView: () => undefined,
}));

vi.mock("../src/state", () => ({ useApp: () => state }));
vi.mock("../src/api", () => ({ api: vi.fn(() => new Promise(() => undefined)), errorMessage: String }));

type HostingDetail = NonNullable<HarnessDetail["hosting"]>;

function manifest(mutate: (m: HarnessManifest) => void = () => undefined): HarnessManifest {
  const value: HarnessManifest = {
    schemaVersion: "1",
    name: "triage-chat",
    version: "1.0.0",
    description: "Synthetic triage chat.",
    interaction: "conversation",
    instructionsFile: "instructions.md",
    model: { preferred: "approved-model", allowed: ["approved-model", "other-model"] },
    tools: [],
    builtinTools: ["files", "web"],
    permissions: { default: "ask" },
    input: { schema: { type: "object" } },
    output: { schema: { type: "object" } },
    limits: { maxDurationSeconds: 600, maxInferenceTokens: 100_000 },
    retry: { safeToRetry: false, maxAttempts: 1 },
    runners: { allowedProfiles: ["node-ts-agent"], defaultProfile: "node-ts-agent" },
  };
  mutate(value);
  return value;
}

function hosting(mutate: (h: HostingDetail) => void = () => undefined): HostingDetail {
  const value: HostingDetail = {
    ceilings: {
      modes: ["isolated", "shared", "orchestrator"],
      transports: ["direct", "github"],
      approvalModes: ["manual", "assisted"],
      permissionHandlers: [],
      sizes: { small: { cpus: 0.5, memoryMiB: 1024 }, large: { cpus: 2, memoryMiB: 4096 } },
      defaultSize: "small",
      workers: { maxConcurrentPerSession: 4, maxPerSession: 16, maxPerPrincipal: 8, idleSeconds: 900, maxLifetimeSeconds: 3600, allowInheritedAuthority: false },
      promotion: { approval: ["ask"] },
      craftingTemplates: [],
      mcpServers: [{ server: "docs-search", tools: ["search", "fetch_page"] }],
    },
    mcpCatalog: [{ server: "docs-search", description: "Synthetic documentation search", tools: ["search", "fetch_page"] }],
    allowedModels: ["approved-model"],
    profileHandlers: ["workspace-drafts"],
    targets: [
      { name: "repo-analyst", version: "1.0.0", description: "Isolated analyst.", interaction: "conversation", mode: "isolated", modeAllowed: true, isolatedAllowed: true },
      { name: "researcher", version: "1.0.0", description: "Shared researcher.", interaction: "conversation", mode: "shared", modeAllowed: false, isolatedAllowed: true },
      { name: "job", version: "1.0.0", description: "Batch job.", interaction: "batch", mode: "isolated", modeAllowed: true, isolatedAllowed: true },
    ],
  };
  mutate(value);
  return value;
}

function render(m: HarnessManifest, detail: HostingDetail = hosting()): string {
  const draft: HarnessDocument = { folder: m.name, manifest: m, instructions: "Help.", skills: [] };
  return renderToStaticMarkup(
    <HarnessTab tab="hosting" draft={draft} update={() => undefined} issues={[]} detail={{ decisions: [], requiredCapabilities: [], hosting: detail }} />,
  );
}

/** The markup of the radio card whose label is `label`, from its opening button tag. */
function card(html: string, label: string): string {
  const at = html.indexOf(`>${label}<`);
  expect(at).toBeGreaterThan(-1);
  const start = html.lastIndexOf("<button", at);
  return html.slice(start, html.indexOf("</button>", at));
}

beforeEach(() => {
  state.local.running = false;
});

describe("harness hosting section", () => {
  it("offers the modes policy allows and names the prerequisite of the others", () => {
    const html = render(manifest());
    expect(card(html, "Shared runtime")).not.toContain('disabled=""');
    expect(card(html, "Shared, then promotable")).toContain('disabled=""');
    expect(card(html, "Shared, then promotable")).toContain("not allowed by policy");
    expect(html).toContain("The operator policy does not allow this mode for this harness. Allow it on the Policy page.");
    expect(html).toContain("Gains:");
    expect(html).toContain("Costs:");
  });

  it("keeps batch harnesses on the executor and says what conversations unlock", () => {
    const html = render(manifest((m) => void delete m.interaction));
    for (const label of ["Shared runtime", "Shared, then promotable", "Orchestrator"]) {
      expect(card(html, label)).toContain('disabled=""');
      expect(card(html, label)).toContain("needs conversation");
    }
    expect(card(html, "Isolated container")).toContain("batch jobs");
    expect(html).toContain("Remote MCP servers need a conversation harness.");
    expect(card(html, "Assisted")).toContain("Batch harnesses use manual approval.");
    expect(card(html, "Allow all")).toContain("needs conversation");
    expect(card(html, "Allow all")).not.toContain("not allowed");
  });

  it("disables approval modes the policy or profile cannot back", () => {
    const html = render(manifest());
    expect(card(html, "Allow all")).toContain('disabled=""');
    expect(card(html, "Allow all")).toContain("Not allowed by the operator policy.");
    expect(card(html, "Assisted")).not.toContain('disabled=""');
    const custom = render(manifest(), hosting((h) => void (h.ceilings.approvalModes = ["manual", "custom"])));
    expect(card(custom, "Custom handler")).toContain("The operator policy lists no permission handlers.");
    const unprovided = render(manifest(), hosting((h) => {
      h.ceilings.approvalModes = ["manual", "custom"];
      h.ceilings.permissionHandlers = ["acme-approvals"];
    }));
    expect(card(unprovided, "Custom handler")).toContain("No allowed handler is provided by the TypeScript conversation profile.");
  });

  it("chooses a judge model among the harness's approved models", () => {
    const html = render(manifest((m) => void (m.permissions = { default: "ask", approvalMode: "assisted" })));
    expect(html).toContain('aria-label="Judge model"');
    expect(html).toContain("The session&#x27;s model (default)");
    expect(html).toMatch(/<option value="other-model" disabled="">other-model \(not approved by policy\)<\/option>/);
  });

  it("selects remote MCP servers and tools from the catalog only", () => {
    const html = render(manifest((m) => {
      m.mcpServers = [{ server: "docs-search", tools: [] }, { server: "retired", tools: ["x"] }];
    }));
    expect(html).toContain("Synthetic documentation search");
    expect(html).toContain("fetch_page");
    expect(html).toContain("Choose at least one tool.");
    expect(html).toContain("not in the catalog");
    expect(render(manifest(), hosting((h) => void (h.mcpCatalog = [])))).toContain("The operator&#x27;s MCP catalog is empty.");
  });

  it("lists eligible workers and names why the others cannot be workers", () => {
    const html = render(manifest((m) => void (m.hosting = { mode: "orchestrator", workers: { harnesses: ["repo-analyst"] } })));
    expect(html).toContain("Worker harnesses");
    expect(html).toContain("Uses shared hosting; workers must use isolated hosting.");
    expect(html).toContain("A batch harness; workers must be conversation harnesses.");
    expect(html).toContain("Off: the operator policy defines no crafting templates");
    expect(html).toContain("The operator policy does not allow inherited authority");
    expect(html).toMatch(/disabled="" title="Not allowed by the operator policy"[^>]*>Inherit the person/);
  });

  it("offers catalog sizes for promotion and only the approvals policy allows", () => {
    const html = render(
      manifest((m) => void (m.hosting = { mode: "promotable" })),
      hosting((h) => void (h.ceilings.modes = ["isolated", "promotable"])),
    );
    expect(html).toContain("Catalog default (small)");
    expect(html).toContain("large · 2 CPU · 4096 MiB");
    expect(html).toMatch(/disabled="" title="Not allowed by the operator policy"[^>]*>Automatic/);
  });

  it("offers handoff targets whose own policy allows their mode", () => {
    const html = render(manifest((m) => void (m.hosting = { mode: "shared", handoffs: [{ harness: "repo-analyst", description: "Coding work" }] })));
    expect(html).toContain('<option value="repo-analyst" selected="">repo-analyst (isolated)</option>');
    expect(html).toContain('<option value="researcher" disabled="">researcher (its policy does not allow shared hosting)</option>');
    expect(html).toContain('<option value="job" disabled="">job (batch harness)</option>');
  });

  it("points to the local stack before it can show the running service's view", () => {
    expect(render(manifest())).toContain("Start the local stack from Local run");
  });
});

describe("running service view row", () => {
  const transports = [
    { transport: "direct" as const, allowed: true, available: true },
    { transport: "github" as const, allowed: false, available: false },
  ];

  it("marks available transports green only while nothing blocks the harness", () => {
    const ready = renderToStaticMarkup(<ServiceViewRow view={{ status: "ready", placement: "shared", problems: [], transports }} />);
    expect(ready).toContain('<span class="badge badge-success">Direct WSS: available</span>');
    expect(ready).toContain("GitHub relay: not allowed");

    const problem = { code: "hosting_unavailable" as const, message: "Shared hosting needs the shared worker.", prerequisite: { kind: "host" as const, name: "shared-worker" as const } };
    const blocked = renderToStaticMarkup(
      <ServiceViewRow view={{ status: "unavailable", placement: "shared", problems: [problem, { ...problem, message: "Another problem." }], transports }} />,
    );
    expect(blocked).not.toContain("badge-success");
    expect(blocked).toContain("Direct WSS: available");
    expect(blocked).toContain("Shared hosting needs the shared worker. Needs the harness-driven shared worker.");
    expect(blocked).toContain("(1 more)");
  });
});

describe("hosting edits", () => {
  it("removes conversation-only fields when switching to batch jobs", () => {
    const m = manifest((value) => {
      value.hosting = { mode: "shared" };
      value.mcpServers = [{ server: "docs-search", tools: ["search"] }];
      value.permissions = { default: "ask", approvalMode: "assisted", judgeModel: "approved-model" };
    });
    withInteraction(m, "batch");
    expect(m.interaction).toBeUndefined();
    expect(m.hosting).toBeUndefined();
    expect(m.mcpServers).toBeUndefined();
    expect(m.permissions).toEqual({ default: "ask" });
    withInteraction(m, "conversation");
    expect(m.interaction).toBe("conversation");
  });

  it("keeps only the settings a mode accepts and drops an isolated block without handoffs", () => {
    const m = manifest((value) => void (value.hosting = { mode: "promotable", promotion: { size: "large" } }));
    withHostingMode(m, "orchestrator");
    expect(m.hosting).toEqual({ mode: "orchestrator", workers: { harnesses: [] } });
    withHostingMode(m, "isolated");
    expect(m.hosting).toBeUndefined();
    const withHandoff = manifest((value) => void (value.hosting = { mode: "shared", handoffs: [{ harness: "coder", description: "Code" }] }));
    withHostingMode(withHandoff, "isolated");
    expect(withHandoff.hosting).toEqual({ mode: "isolated", handoffs: [{ harness: "coder", description: "Code" }] });
  });

  it("routes hosting and approval-mode issues to the Hosting section", () => {
    expect(tabFor("hosting.workers.harnesses.0")).toBe("hosting");
    expect(tabFor("mcpServers.0.tools.1")).toBe("hosting");
    expect(tabFor("interaction")).toBe("hosting");
    expect(tabFor("permissions.approvalMode")).toBe("hosting");
    expect(tabFor("permissions.handler")).toBe("hosting");
    expect(tabFor("permissions.kinds.read")).toBe("permissions");
  });

  it("keeps the approval mode when a permissions preset changes the rules", () => {
    const current = { default: "deny" as const, questions: true, timeoutSeconds: 120, approvalMode: "custom" as const, handler: "workspace-drafts" };
    expect(permissionsPreset(current, "cli")).toEqual({ default: "ask", questions: true, timeoutSeconds: 120, approvalMode: "custom", handler: "workspace-drafts" });
    expect(permissionsPreset(current, "yolo")).toEqual(expect.objectContaining({ default: "allow", approvalMode: "custom", handler: "workspace-drafts" }));
    expect(permissionsPreset(current, "deny")).toEqual({ default: "deny", approvalMode: "custom", handler: "workspace-drafts" });
    expect(permissionsPreset({ default: "ask", questions: true }, "deny")).toBeUndefined();
    expect(permissionsPreset({ default: "ask", approvalMode: "assisted", judgeModel: "approved-model" }, "cli")).toEqual({
      default: "ask",
      approvalMode: "assisted",
      judgeModel: "approved-model",
    });
  });
});
