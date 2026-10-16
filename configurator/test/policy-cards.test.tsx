import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { EffectiveHostingPolicy, ExecutionPolicy, ProfileSummary } from "../server/types";
import { ApprovalsCard, HostingCeilingsCard, looksLikeCredential, McpCatalogCard } from "../src/views/policy/cards";

vi.mock("../src/api", () => ({ api: vi.fn(), errorMessage: String }));

const policy: ExecutionPolicy = {
  schemaVersion: "1",
  allowedProfiles: ["node-ts-agent"],
  allowedModels: ["approved-model"],
  maxDurationSeconds: 600,
  maxInferenceTokensPerJob: 200_000,
  maxConcurrentAttemptsPerPrincipal: 4,
  maxQueuedJobsPerPrincipal: 100,
  retry: { maxAttempts: 3, backoffSeconds: 30 },
  leaseSeconds: 60,
  requirements: { processIsolation: "uid", egress: "gateway-only" },
  acknowledgedGaps: ["egress-not-enforced"],
};

const defaults: EffectiveHostingPolicy = {
  modes: ["isolated"],
  transports: ["direct", "github"],
  sizes: { small: { cpus: 0.5, memoryMiB: 1024 }, medium: { cpus: 1, memoryMiB: 2048 }, large: { cpus: 2, memoryMiB: 4096 } },
  defaultSize: "small",
  workers: { maxConcurrentPerSession: 4, maxPerSession: 16, maxPerPrincipal: 8, idleSeconds: 900, maxLifetimeSeconds: 3600, allowInheritedAuthority: false, allowCoordinatorAnswers: false },
  promotion: { approval: ["ask"] },
  handoffs: { approval: ["ask"], history: ["full", "summary", "none"] },
  crafting: { templates: {} },
};

const profile = (permissionHandlers?: string[]): ProfileSummary => ({
  id: "node-ts-agent", displayName: "TS", language: "typescript", sdk: "sdk", sdkVersion: "1", firstParty: true,
  toolBindings: [], capabilities: [], ...(permissionHandlers ? { permissionHandlers } : {}),
});

const shell = { title: "Card", footer: null, locked: false, update: () => undefined };

/** The markup of the checkbox row labelled `label`. */
function toggle(html: string, label: string): string {
  const at = html.indexOf(`>${label}<`);
  expect(at).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<input", at), at);
}

describe("approval modes card", () => {
  it("keeps one mode allowed and suggests the handlers profiles provide", () => {
    const html = renderToStaticMarkup(<ApprovalsCard {...shell} policy={policy} profiles={[profile(["workspace-drafts"])]} />);
    expect(toggle(html, "Manual")).toContain('checked=""');
    expect(toggle(html, "Manual")).toContain('disabled=""');
    expect(toggle(html, "Assisted")).not.toContain('checked=""');
    expect(html).toContain("+ workspace-drafts");
    expect(html).toContain("not a security boundary");
  });

  it("warns when allow all is allowed and explains handlers when no profile provides one", () => {
    const html = renderToStaticMarkup(<ApprovalsCard {...shell} policy={{ ...policy, approvalModes: ["manual", "allow-all"] }} profiles={[profile()]} />);
    expect(html).toContain("approve every request that would ask a person");
    expect(html).toContain("No execution profile provides a permission handler yet.");
  });
});

describe("remote MCP catalog card", () => {
  it("shows secret names, never credential values, and flags private-network access", () => {
    const html = renderToStaticMarkup(
      <McpCatalogCard
        {...shell}
        policy={{
          ...policy,
          mcpServers: {
            "docs-search": { url: "https://mcp.example.com/docs", description: "Docs", auth: { secret: "docs-search-token", header: "X-Api-Key" }, tools: ["search"] },
            local: { url: "http://mcp:8080/mcp", tools: ["lookup"], allowPrivateNetwork: true },
          },
        }}
      />,
    );
    expect(html).toContain("secret: docs-search-token");
    expect(html).toContain('value="X-Api-Key"');
    expect(html).toContain("private network allowed");
    expect(html).toContain("no credential");
    expect(html).toContain("never the credential itself");
    expect(renderToStaticMarkup(<McpCatalogCard {...shell} policy={policy} />)).toContain("No remote MCP servers.");
  });

  it("refuses credential-shaped input in the secret name field", () => {
    expect(looksLikeCredential("docs-search-token")).toBe(false);
    expect(looksLikeCredential("")).toBe(false);
    expect(looksLikeCredential("ghp_0123456789abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(looksLikeCredential("Bearer abc")).toBe(true);
    expect(looksLikeCredential("0123456789abcdef0123456789abcdef")).toBe(true);
  });
});

describe("hosting ceilings card", () => {
  it("shows the documented defaults when the policy sets no hosting block", () => {
    const html = renderToStaticMarkup(<HostingCeilingsCard {...shell} policy={policy} defaults={defaults} bindings={[]} />);
    expect(toggle(html, "Isolated container")).toContain('checked=""');
    expect(toggle(html, "Isolated container")).toContain('disabled=""');
    expect(toggle(html, "Shared runtime")).not.toContain('checked=""');
    expect(toggle(html, "Direct WSS")).toContain('checked=""');
    expect(html).toContain('value="medium"');
    expect(html).toContain("Smallest (small)");
    expect(html).toContain('value="16"');
    expect(toggle(html, "Allow inherited human authority")).not.toContain('checked=""');
    expect(toggle(html, "Let coordinators answer worker questions")).not.toContain('checked=""');
    expect(html).toContain("No crafting templates, so orchestrators cannot craft workers.");
    expect(html).not.toContain("Default sizes");
  });

  it("edits a customized catalog and crafting templates, and locks inherited settings", () => {
    const custom: ExecutionPolicy = {
      ...policy,
      hosting: {
        modes: ["isolated", "shared"],
        sizes: { tiny: { cpus: 0.25, memoryMiB: 512 } },
        defaultSize: "tiny",
        workers: { allowInheritedAuthority: true, allowCoordinatorAnswers: true },
        crafting: {
          templates: {
            "general-worker": { toolBindings: [], builtinTools: ["files"], models: ["approved-model"], approvalModes: ["manual"], maxDurationSeconds: 1800, sizes: ["tiny"] },
          },
        },
      },
    };
    const html = renderToStaticMarkup(<HostingCeilingsCard {...shell} policy={custom} defaults={defaults} bindings={[]} />);
    expect(toggle(html, "Shared runtime")).toContain('checked=""');
    expect(html).toContain('value="tiny"');
    expect(html).toContain("Default sizes");
    expect(html).toContain('aria-label="Remove size tiny" disabled=""');
    expect(html).toContain('value="general-worker"');
    expect(toggle(html, "Allow inherited human authority")).toContain('checked=""');
    expect(toggle(html, "Let coordinators answer worker questions")).toContain('checked=""');
    const locked = renderToStaticMarkup(<HostingCeilingsCard {...shell} locked policy={custom} defaults={defaults} bindings={[]} />);
    expect(locked).toContain('<fieldset disabled=""');
  });

  it("shows handoff approval and history ceilings, with their defaults, and keeps one of each allowed", () => {
    /** The markup from `heading` to the next control group. */
    const group = (html: string, heading: string) => {
      const start = html.indexOf(`>${heading}<`);
      expect(start).toBeGreaterThan(-1);
      const end = html.indexOf('class="label !mb-0"', start + heading.length);
      return html.slice(start, end < 0 ? undefined : end);
    };
    const defaultsHtml = renderToStaticMarkup(<HostingCeilingsCard {...shell} policy={policy} defaults={defaults} bindings={[]} />);
    const approvals = group(defaultsHtml, "Handoff approval");
    expect(toggle(approvals, "Ask a person")).toContain('checked=""');
    expect(toggle(approvals, "Ask a person")).toContain('disabled=""');
    expect(toggle(approvals, "Automatic")).not.toContain('checked=""');
    expect(approvals).toContain("the safety judge and handlers cannot");
    const histories = group(defaultsHtml, "Handoff history");
    for (const label of ["Full", "Summary", "None"]) {
      expect(toggle(histories, label), label).toContain('checked=""');
      expect(toggle(histories, label), label).not.toContain('disabled=""');
    }
    const narrowed = renderToStaticMarkup(<HostingCeilingsCard {...shell} policy={{ ...policy, hosting: { handoffs: { approval: ["ask", "allow"], history: ["summary"] } } }} defaults={defaults} bindings={[]} />);
    expect(toggle(group(narrowed, "Handoff approval"), "Automatic")).toContain('checked=""');
    expect(toggle(group(narrowed, "Handoff history"), "Summary")).toContain('disabled=""');
    expect(toggle(group(narrowed, "Handoff history"), "Full")).not.toContain('checked=""');
  });
});
