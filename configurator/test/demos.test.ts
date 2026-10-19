import { describe, expect, it } from "vitest";
import type { ExecutionPolicy } from "@copilot-agent/contracts";
import { DemoError, DemoService } from "../server/demos.js";
import type { Repo } from "../server/repo.js";

const BASE: ExecutionPolicy = {
  schemaVersion: "1",
  allowedProfiles: ["node-ts-agent"],
  allowedModels: ["grok-4.6", "github/claude-sonnet-5.5"],
  maxDurationSeconds: 3600,
  maxInferenceTokensPerJob: 2_000_000,
  maxConcurrentAttemptsPerPrincipal: 4,
  maxQueuedJobsPerPrincipal: 100,
  retry: { maxAttempts: 3, backoffSeconds: 5 },
  leaseSeconds: 30,
  requirements: { processIsolation: "uid", egress: "gateway-only" },
  acknowledgedGaps: ["egress-not-enforced"],
  builtinTools: ["files", "shell", "web"],
  permissionModes: ["ask", "allow"],
};

function harness(options: { policy?: ExecutionPolicy; published?: string[]; apiUrl?: string; responses?: Array<{ status: number; body: unknown }> } = {}) {
  let policy = options.policy ?? BASE;
  const published = new Set(options.published ?? ["hybrid-builder", "hybrid-reviewer"]);
  const forwarded: Array<{ method: string; path: string; body?: unknown }> = [];
  const terminals: Array<{ title: string; command: string; cwd: string }> = [];
  const responses = [...(options.responses ?? [])];
  const repo = {
    readPolicy: async () => policy,
    writePolicy: async (next: ExecutionPolicy) => { policy = next; },
    harnessExists: async (name: string) => published.has(name),
  } as unknown as Repo;
  const service = new DemoService({
    root: "C:\\repo",
    repo,
    cli: "C:\\cli\\index.js",
    status: { local: async () => ({ apiUrl: options.apiUrl ?? "http://localhost:5000" }) as Awaited<ReturnType<import("../server/status.js").StatusService["local"]>> },
    tryService: {
      forward: async (_target, method, path, body) => {
        forwarded.push({ method, path, ...(body === undefined ? {} : { body }) });
        return responses.shift() ?? { status: 200, body: {} };
      },
    },
    openTerminal: async (title, command, cwd) => { terminals.push({ title, command, cwd }); },
  });
  return { service, forwarded, terminals, policy: () => policy };
}

const ready: ExecutionPolicy = {
  ...BASE,
  allowInlineHarnesses: true,
  hosting: {
    modes: ["isolated", "shared", "promotable", "orchestrator"],
    workers: { maxConcurrentPerSession: 2, maxPerSession: 8, maxPerPrincipal: 4, idleSeconds: 900, maxLifetimeSeconds: 3600, allowInheritedAuthority: true },
  },
};

describe("demo service", () => {
  it("reports what blocks the demos and which modes each blocks", async () => {
    const { service } = harness({ published: ["hybrid-builder"] });
    const info = await service.info();
    expect(info.model).toBe("github/claude-sonnet-5.5");
    expect(Object.fromEntries(info.checks.map((check) => [check.id, check.ok]))).toMatchObject({
      stack: true, inline: false, modes: false, workers: false, model: true,
    });
    expect(info.checks.find((check) => check.id === "workers")?.detail).toMatch(/hybrid-reviewer/);
    const modes = Object.fromEntries(info.modes.map((mode) => [mode.mode, mode.problems]));
    expect(modes.isolated).toEqual([expect.stringMatching(/submitted definitions/)]);
    expect(modes.shared).toContainEqual(expect.stringMatching(/shared hosting/));
    expect(modes.orchestrator).toContainEqual(expect.stringMatching(/hybrid-reviewer/));
    expect(info.modes.map((mode) => mode.definition.name)).toEqual(["team-researcher", "release-notes-writer", "promotable-coder", "build-orchestrator"]);
  });

  it("is ready once the policy allows every demo, and follows the selected model", async () => {
    const { service } = harness({ policy: ready });
    const info = await service.info("grok-4.6");
    expect(info.checks.filter((check) => check.id !== "cli").every((check) => check.ok)).toBe(true);
    expect(info.modes.every((mode) => mode.problems.length === 0)).toBe(true);
    expect(info.modes[0]!.definition.model.preferred).toBe("grok-4.6");
    expect((await service.info("unapproved")).model).toBe("github/claude-sonnet-5.5");
  });

  it("prepares the base policy without dropping existing settings, once", async () => {
    const { service, policy } = harness({ policy: { ...BASE, hosting: { modes: ["isolated", "shared"], defaultSize: "small" } } });
    expect((await service.prepare()).changed).toEqual(["allowInlineHarnesses", "hosting.modes", "hosting.workers"]);
    expect(policy()).toMatchObject({
      allowInlineHarnesses: true, allowedModels: BASE.allowedModels,
      hosting: { defaultSize: "small", modes: ["isolated", "shared", "promotable", "orchestrator"], workers: { allowInheritedAuthority: true } },
    });
    expect((await service.prepare()).changed).toEqual([]);
  });

  it("launches a code-defined session and opens the CLI on it in a new terminal", async () => {
    const id = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    const { service, forwarded, terminals } = harness({ policy: ready, responses: [{ status: 201, body: { id, placement: "shared" } }] });
    const launch = await service.launch("promotable", "github/claude-sonnet-5.5");
    expect(forwarded[0]).toMatchObject({ method: "POST", path: "/v1/sessions", body: { label: "Promotable demo", definition: { name: "promotable-coder", hosting: { mode: "promotable" } } } });
    expect(launch.terminal).toEqual({ opened: true, command: `pnpm host:connect --resume ${id} --cli C:\\cli\\index.js` });
    expect(terminals).toEqual([{ title: "Promotable demo", command: launch.terminal.command, cwd: "C:\\repo" }]);
  });

  it("refuses unapproved models and passes API refusals through", async () => {
    const { service, terminals } = harness({
      policy: ready,
      responses: [{ status: 403, body: { error: { code: "inline_harnesses_disabled", message: "Not allowed.", details: { prerequisite: { kind: "policy" } } } } }],
    });
    await expect(service.launch("shared", "unapproved")).rejects.toMatchObject({ statusCode: 422, code: "model_not_approved" });
    const refusal = await service.launch("shared", "grok-4.6").catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(DemoError);
    expect(refusal).toMatchObject({ statusCode: 403, code: "inline_harnesses_disabled", message: "Not allowed." });
    expect(terminals).toEqual([]);
  });

  it("reads orchestrator workers with the session and relays promotion, approvals, and closing", async () => {
    const id = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    const request = "7a1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    const { service, forwarded } = harness({ policy: ready, responses: [
      { status: 200, body: { id, mode: "orchestrator" } },
      { status: 200, body: { workers: [{ name: "builder" }] } },
      { status: 200, body: { id, mode: "shared" } },
    ] });
    expect(await service.session(id)).toEqual({ session: { id, mode: "orchestrator" }, workers: [{ name: "builder" }] });
    expect(await service.session(id)).toEqual({ session: { id, mode: "shared" } });
    await service.promote(id);
    await service.respond(id, request, { kind: "permission", approved: true });
    await service.close(id);
    expect(forwarded.slice(3).map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST /v1/sessions/${id}/promote`, `POST /v1/sessions/${id}/input-requests/${request}/respond`, `POST /v1/sessions/${id}/close`,
    ]);
  });

  it("reports a terminal that could not open with the command to run instead, and rejects unsafe CLI paths", async () => {
    const failing = new DemoService({
      root: "/repo", repo: {} as Repo, cli: "/opt/cli.js", status: { local: async () => ({}) as never },
      tryService: { forward: async () => ({ status: 200, body: {} }) },
      openTerminal: async () => { throw new Error("no terminal"); },
    });
    expect(await failing.openCli("6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b")).toEqual({
      opened: false, command: "pnpm host:connect --resume 6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b --cli /opt/cli.js", error: "no terminal",
    });
    expect(() => new DemoService({ root: "/", repo: {} as Repo, cli: "copilot; rm -rf /", status: { local: async () => ({}) as never }, tryService: { forward: async () => ({ status: 200, body: {} }) } }))
      .toThrow(/shell would interpret/);
  });
});
