import { capture, parseJsonOutput } from "./process.js";
import type {
  AzureApp,
  AzureLocation,
  AzureResourceGroup,
  AzureSubscription,
  AzureStatus,
  DeployTarget,
  EnvironmentStatus,
  FoundryAccount,
  FoundryDeployment,
  LocalResource,
  LocalStackStatus,
  ToolStatus,
} from "./types.js";

const HIDDEN_LOCAL = /-installer$|^(dev-api-key|executor-key|gateway-key|capability-signing-key|foundry-endpoint|foundry-deployments|npm-registry|pip-index-url|postgres-password)$/;

export interface StatusDeps {
  root: string;
  aspireEnv: () => NodeJS.ProcessEnv;
}

/** Reads the state of local tools, the local Aspire stack, and Azure, without exposing secret values. */
export class StatusService {
  #environment: { at: number; value: EnvironmentStatus } | undefined;

  constructor(private readonly deps: StatusDeps) {}

  async environment(force = false): Promise<EnvironmentStatus> {
    if (!force && this.#environment && Date.now() - this.#environment.at < 15_000) {
      return this.#environment.value;
    }
    const { root } = this.deps;
    const version = (text: string) => text.trim().split(/\r?\n/)[0]?.replace(/^v/, "").split("+")[0];
    const tool = async (name: string, args: string[], env?: NodeJS.ProcessEnv): Promise<ToolStatus> => {
      const result = await capture(name, args, { cwd: root, env, timeoutMs: 20_000 });
      return result.code === 0
        ? { ok: true, version: version(result.stdout) }
        : { ok: false, detail: (result.stderr || result.stdout).trim().split(/\r?\n/)[0]?.slice(0, 200) || "Not available" };
    };
    const [pnpm, aspire, docker, azure] = await Promise.all([
      tool("pnpm", ["--version"]),
      tool("aspire", ["--version"], this.deps.aspireEnv()),
      capture("docker", ["info", "--format", "{{.ServerVersion}}"], { cwd: root, timeoutMs: 20_000 }).then(
        (r): ToolStatus =>
          r.code === 0 && r.stdout.trim()
            ? { ok: true, version: r.stdout.trim() }
            : { ok: false, detail: "Docker is not running. Start Docker Desktop." },
      ),
      this.#azure(),
    ]);
    const value: EnvironmentStatus = { node: { ok: true, version: process.versions.node }, pnpm, aspire, docker, azure };
    this.#environment = { at: Date.now(), value };
    return value;
  }

  async #azure(): Promise<EnvironmentStatus["azure"]> {
    const result = await capture("az", ["account", "show", "-o", "json"], { cwd: this.deps.root, timeoutMs: 30_000 });
    const account = parseJsonOutput<{ tenantId: string; id: string; name: string; user?: { name?: string } }>(result.stdout);
    if (result.code !== 0 || !account) {
      return { ok: false, detail: "Not signed in. Run az login." };
    }
    return {
      ok: true,
      tenantId: account.tenantId,
      subscriptionId: account.id,
      subscriptionName: account.name,
      user: account.user?.name,
    };
  }

  async local(): Promise<LocalStackStatus> {
    const result = await capture(
      "aspire",
      ["describe", "--apphost", "apphost.mts", "--format", "Json", "--nologo", "--non-interactive"],
      { cwd: this.deps.root, env: this.deps.aspireEnv(), timeoutMs: 30_000 },
    );
    const parsed = parseJsonOutput<{ resources?: Array<Record<string, unknown>> }>(result.stdout);
    if (result.code !== 0 || !parsed?.resources) {
      return { running: false, resources: [] };
    }
    // Only allowlisted fields leave the server: describe output also carries resource environments.
    const resources: LocalResource[] = parsed.resources
      .filter((r) => typeof r.displayName === "string" && !HIDDEN_LOCAL.test(r.displayName) && r.resourceType !== "Parameter")
      .map((r) => ({
        name: String(r.displayName),
        type: String(r.resourceType ?? ""),
        state: String(r.state ?? "Unknown"),
        health: typeof r.healthStatus === "string" ? r.healthStatus : undefined,
        urls: Array.isArray(r.urls)
          ? (r.urls as Array<{ name?: unknown; url?: unknown }>)
              .filter((u) => typeof u.url === "string" && /^https?:\/\//.test(u.url))
              .map((u) => ({ name: String(u.name ?? ""), url: String(u.url) }))
          : [],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const api = resources.find((r) => r.name === "agent-api");
    const dashboard = parsed.resources.find((r) => typeof r.dashboardUrl === "string")?.dashboardUrl as string | undefined;
    return {
      running: resources.length > 0,
      dashboardUrl: dashboard ? new URL(dashboard).origin : undefined,
      apiUrl: api?.urls.find((u) => u.name === "http")?.url ?? api?.urls[0]?.url,
      resources,
    };
  }

  async azure(target: DeployTarget): Promise<AzureStatus> {
    const { root } = this.deps;
    const group = await capture(
      "az",
      ["group", "show", "--name", target.resourceGroup, "--subscription", target.subscriptionId, "-o", "json"],
      { cwd: root, timeoutMs: 45_000 },
    );
    if (group.code !== 0) {
      const notFound = /could not be found|ResourceGroupNotFound/i.test(group.stderr);
      return {
        target: target.name,
        resourceGroupExists: false,
        apps: [],
        error: notFound ? undefined : firstLine(group.stderr) ?? "Azure CLI request failed.",
      };
    }
    const list = await capture(
      "az",
      ["containerapp", "list", "--resource-group", target.resourceGroup, "--subscription", target.subscriptionId, "-o", "json"],
      { cwd: root, timeoutMs: 60_000 },
    );
    const apps = parseJsonOutput<Array<Record<string, any>>>(list.stdout) ?? [];
    const mapped: AzureApp[] = apps
      .map((app) => ({
        name: String(app.name),
        provisioningState: String(app.properties?.provisioningState ?? "Unknown"),
        runningStatus: String(app.properties?.runningStatus ?? "Unknown"),
        fqdn: app.properties?.configuration?.ingress?.fqdn as string | undefined,
        external: Boolean(app.properties?.configuration?.ingress?.external),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const api = mapped.find((a) => a.name === "agent-api" && a.fqdn);
    return {
      target: target.name,
      resourceGroupExists: true,
      apps: mapped,
      apiUrl: api ? `https://${api.fqdn}` : undefined,
      error: list.code === 0 ? undefined : firstLine(list.stderr),
    };
  }

  async subscriptions(): Promise<AzureSubscription[]> {
    const result = await capture("az", ["account", "list", "--only-show-errors", "-o", "json"], { cwd: this.deps.root, timeoutMs: 30_000 });
    if (result.code !== 0) {
      throw new Error(firstLine(result.stderr) ?? "Could not list subscriptions. Run az login.");
    }
    return (parseJsonOutput<Array<Record<string, any>>>(result.stdout) ?? [])
      .filter((s) => (s.state ?? "Enabled") === "Enabled")
      .map((s) => ({ id: String(s.id), name: String(s.name), tenantId: String(s.tenantId), isDefault: Boolean(s.isDefault) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async locations(): Promise<AzureLocation[]> {
    const result = await capture("az", ["account", "list-locations", "-o", "json"], { cwd: this.deps.root, timeoutMs: 45_000 });
    if (result.code !== 0) {
      throw new Error(firstLine(result.stderr) ?? "Could not list regions.");
    }
    return (parseJsonOutput<Array<Record<string, any>>>(result.stdout) ?? [])
      .filter((l) => (l.metadata?.regionType ?? "Physical") === "Physical")
      .map((l) => ({
        name: String(l.name),
        displayName: String(l.displayName ?? l.name),
        geography: typeof l.metadata?.geographyGroup === "string" ? l.metadata.geographyGroup : undefined,
      }))
      .sort((a, b) => (a.geography ?? "").localeCompare(b.geography ?? "") || a.displayName.localeCompare(b.displayName));
  }

  async resourceGroups(subscriptionId: string): Promise<AzureResourceGroup[]> {
    const result = await capture(
      "az",
      ["group", "list", "--subscription", subscriptionId, "-o", "json"],
      { cwd: this.deps.root, timeoutMs: 45_000 },
    );
    if (result.code !== 0) {
      throw new Error(firstLine(result.stderr) ?? "Could not list resource groups.");
    }
    return (parseJsonOutput<Array<Record<string, any>>>(result.stdout) ?? [])
      .map((g) => ({ name: String(g.name), location: String(g.location ?? "") }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async foundryAccounts(subscriptionId: string): Promise<FoundryAccount[]> {
    const result = await capture(
      "az",
      ["cognitiveservices", "account", "list", "--subscription", subscriptionId, "-o", "json"],
      { cwd: this.deps.root, timeoutMs: 60_000 },
    );
    if (result.code !== 0) {
      throw new Error(firstLine(result.stderr) ?? "Could not list Foundry accounts.");
    }
    return (parseJsonOutput<Array<Record<string, any>>>(result.stdout) ?? [])
      .filter((a) => ["AIServices", "OpenAI"].includes(String(a.kind)))
      .map((a) => ({
        name: String(a.name),
        resourceGroup: String(a.resourceGroup),
        location: String(a.location),
        kind: String(a.kind),
        endpoint: openAiV1Endpoint(String(a.properties?.customSubDomainName ?? a.name)),
      }));
  }

  async foundryDeployments(subscriptionId: string, resourceGroup: string, account: string): Promise<FoundryDeployment[]> {
    const result = await capture(
      "az",
      [
        "cognitiveservices",
        "account",
        "deployment",
        "list",
        "--subscription",
        subscriptionId,
        "--resource-group",
        resourceGroup,
        "--name",
        account,
        "-o",
        "json",
      ],
      { cwd: this.deps.root, timeoutMs: 60_000 },
    );
    if (result.code !== 0) {
      throw new Error(firstLine(result.stderr) ?? "Could not list model deployments.");
    }
    return (parseJsonOutput<Array<Record<string, any>>>(result.stdout) ?? []).map((d) => ({
      name: String(d.name),
      model: String(d.properties?.model?.name ?? ""),
      version: String(d.properties?.model?.version ?? ""),
      sku: String(d.sku?.name ?? ""),
      capacity: typeof d.sku?.capacity === "number" ? d.sku.capacity : undefined,
    }));
  }
}

export function openAiV1Endpoint(subdomain: string): string {
  return `https://${subdomain}.openai.azure.com/openai/v1`;
}

function firstLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^ERROR:\s*/, "").trim())
    .find((l) => l && !l.startsWith("WARNING"))
    ?.slice(0, 300);
}
