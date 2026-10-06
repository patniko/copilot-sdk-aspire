import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DemoHostSettings } from "@copilot-agent/contracts";
import { capture, stripAnsi } from "./process.js";
import type { DeployTarget, LocalSettings, SettingsInfo } from "./types.js";

export class SettingsError extends Error {}

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NAME = /^[A-Za-z0-9._-]{1,90}$/;

const httpsUrl = z
  .string()
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  }, "Use an https:// URL without credentials, query strings, or fragments.");

const optionalHttpsUrl = z.union([z.literal(""), httpsUrl]);
const deployment = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "Deployment names use letters, digits, '.', '_' and '-'.");

export const LocalSettingsSchema = z
  .object({
    demoHost: DemoHostSettings.optional(),
    foundryEndpoint: optionalHttpsUrl,
    foundryDeployments: z.array(deployment).max(20),
    npmRegistry: optionalHttpsUrl,
    pipIndexUrl: optionalHttpsUrl,
    nugetServiceIndex: optionalHttpsUrl,
  })
  .strict();

export const DeployTargetSchema = z
  .object({
    demoHost: DemoHostSettings.optional(),
    name: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/, "Use lowercase letters, digits, and hyphens."),
    tenantId: z.string().regex(GUID, "Tenant ID must be a GUID."),
    subscriptionId: z.string().regex(GUID, "Subscription ID must be a GUID."),
    location: z.string().regex(/^[a-z0-9]{2,40}$/, "Use an Azure region name such as westus2."),
    resourceGroup: z.string().regex(NAME, "Resource group names use letters, digits, '.', '_' and '-'."),
    foundryAccount: z.string().regex(/^[A-Za-z0-9-]{2,64}$/, "Foundry account names use letters, digits, and hyphens."),
    foundryResourceGroup: z.string().regex(NAME, "Resource group names use letters, digits, '.', '_' and '-'."),
    foundryEndpoint: httpsUrl,
    foundryDeployments: z.array(deployment).min(1, "Add at least one model deployment.").max(20),
  })
  .strict();

const envNuget = process.env.ASPIRE_CLI_NUGET_SERVICE_INDEX ?? "";
const defaultNuget = optionalHttpsUrl.safeParse(envNuget).success ? envNuget : "";

const StoredSettings = z
  .object({
    targets: z.array(DeployTargetSchema).default([]),
    selectedTarget: z.string().optional(),
    // Defaults to the CLI's own override when the configurator was started with one.
    nugetServiceIndex: optionalHttpsUrl.default(defaultNuget),
  })
  .strip();
type StoredSettings = z.infer<typeof StoredSettings>;

/** Aspire user-secret keys the configurator manages. Generated keys (API and service keys) are never exposed. */
const SECRET_KEYS = {
  foundryEndpoint: "Parameters:foundry-endpoint",
  foundryDeployments: "Parameters:foundry-deployments",
  npmRegistry: "Parameters:npm-registry",
  pipIndexUrl: "Parameters:pip-index-url",
} as const;

/**
 * Local configuration: run parameters live in the AppHost's Aspire user secrets (outside the repository);
 * deployment targets and CLI settings live in .configurator/settings.json (git-ignored, no secrets).
 */
export class Settings {
  #secretsPath: string | undefined;

  constructor(
    private readonly root: string,
    private readonly aspireEnv: () => NodeJS.ProcessEnv,
  ) {}

  get file(): string {
    return join(this.root, ".configurator", "settings.json");
  }

  async secretsPath(): Promise<string> {
    if (this.#secretsPath) {
      return this.#secretsPath;
    }
    const result = await capture("aspire", ["secret", "path", "--apphost", "apphost.mts", "--nologo", "--non-interactive"], {
      cwd: this.root,
      env: this.aspireEnv(),
      timeoutMs: 60_000,
    });
    if (result.code !== 0 || result.timedOut) {
      throw new SettingsError(
        "Could not locate the AppHost user secrets file. Check that the Aspire CLI is available and 'aspire secret path --apphost apphost.mts' succeeds.",
      );
    }
    const path = stripAnsi(result.stdout)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.endsWith("secrets.json"));
    if (!path) {
      throw new SettingsError("The Aspire CLI did not return a user secrets path. Run 'aspire secret path --apphost apphost.mts' to check it.");
    }
    this.#secretsPath = path;
    return path;
  }

  async #readSecrets(): Promise<Record<string, unknown>> {
    const path = await this.secretsPath();
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return {};
      }
      throw new SettingsError("Could not read the AppHost user secrets file. Check its file permissions and try again.");
    }
    let secrets: unknown;
    try {
      // Aspire/.NET may write UTF-8 with a BOM, which JSON.parse does not accept.
      secrets = JSON.parse(content.replace(/^\uFEFF/, ""));
    } catch {
      throw new SettingsError("The AppHost user secrets file is not valid JSON. Repair it before saving settings; its contents have not been changed.");
    }
    const parsed = z.record(z.string(), z.unknown()).safeParse(secrets);
    if (!parsed.success) {
      throw new SettingsError("The AppHost user secrets file must contain a JSON object. Repair it before saving settings; its contents have not been changed.");
    }
    return parsed.data;
  }

  async #writeSecrets(updates: Record<string, string | undefined>): Promise<void> {
    const path = await this.secretsPath();
    const secrets = await this.#readSecrets();
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined || value === "") {
        delete secrets[key];
      } else {
        secrets[key] = value;
      }
    }
    await atomicWrite(path, `${JSON.stringify(secrets, null, 2)}\n`);
  }

  /** Server-side only: the generated development API key for the local stack. */
  async devApiKey(): Promise<string | undefined> {
    const value = (await this.#readSecrets())["Parameters:dev-api-key"];
    return typeof value === "string" ? value : undefined;
  }

  /** Used only as a secret deployment parameter, never returned by settings.read(). */
  async demoHostGitHubToken(): Promise<string | undefined> {
    const value = (await this.#readSecrets())["Parameters:demo-host-github-token"];
    return typeof value === "string" && value.trim() ? value : undefined;
  }

  async writeDemoHostGitHubToken(token: string): Promise<void> {
    await this.#writeSecrets({ "Parameters:demo-host-github-token": token || undefined });
  }

  async #readStored(): Promise<StoredSettings> {
    try {
      return StoredSettings.parse(JSON.parse(await readFile(this.file, "utf8")));
    } catch {
      return StoredSettings.parse({});
    }
  }

  async #writeStored(settings: StoredSettings): Promise<void> {
    await atomicWrite(this.file, `${JSON.stringify(settings, null, 2)}\n`);
  }

  async nugetServiceIndex(): Promise<string> {
    return (await this.#readStored()).nugetServiceIndex;
  }

  async read(): Promise<SettingsInfo> {
    const [secrets, stored] = await Promise.all([this.#readSecrets(), this.#readStored()]);
    const text = (key: string) => (typeof secrets[key] === "string" ? (secrets[key] as string) : "");
    const local: LocalSettings = {
      demoHost: DemoHostSettings.parse({
        transport: text("Parameters:demo-host-transport") || "disabled",
        owner: text("Parameters:demo-host-owner"),
        harness: text("Parameters:demo-host-harness") || "interactive-demo",
      }),
      foundryEndpoint: text(SECRET_KEYS.foundryEndpoint),
      foundryDeployments: text(SECRET_KEYS.foundryDeployments)
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean),
      npmRegistry: text(SECRET_KEYS.npmRegistry),
      pipIndexUrl: text(SECRET_KEYS.pipIndexUrl),
      nugetServiceIndex: stored.nugetServiceIndex,
    };
    let targets = stored.targets;
    if (targets.length === 0) {
      const seeded = seedTarget(secrets, local);
      if (seeded) {
        targets = [seeded];
      }
    }
    return {
      local,
      targets,
      selectedTarget: stored.selectedTarget ?? targets[0]?.name,
      secretsPath: await this.secretsPath(),
    };
  }

  async writeLocal(input: unknown): Promise<void> {
    const local = LocalSettingsSchema.parse(input);
    await this.#writeSecrets({
      [SECRET_KEYS.foundryEndpoint]: local.foundryEndpoint,
      [SECRET_KEYS.foundryDeployments]: local.foundryDeployments.join(","),
      [SECRET_KEYS.npmRegistry]: local.npmRegistry,
      [SECRET_KEYS.pipIndexUrl]: local.pipIndexUrl,
      "Parameters:demo-host-transport": local.demoHost?.transport === "disabled" ? undefined : local.demoHost?.transport,
      "Parameters:demo-host-owner": local.demoHost?.owner,
      "Parameters:demo-host-harness": local.demoHost?.transport && local.demoHost.transport !== "disabled" ? local.demoHost.harness : undefined,
    });
    const stored = await this.#readStored();
    await this.#writeStored({ ...stored, nugetServiceIndex: local.nugetServiceIndex });
  }

  async writeTargets(input: unknown): Promise<void> {
    const body = z
      .object({ targets: z.array(DeployTargetSchema).max(20), selectedTarget: z.string().optional() })
      .strict()
      .parse(input);
    const names = new Set<string>();
    for (const target of body.targets) {
      if (names.has(target.name)) {
        throw new SettingsError(`Duplicate target name '${target.name}'.`);
      }
      names.add(target.name);
    }
    const stored = await this.#readStored();
    await this.#writeStored({ ...stored, targets: body.targets, selectedTarget: body.selectedTarget });
  }

  async target(name: string | undefined): Promise<DeployTarget> {
    const info = await this.read();
    const target = info.targets.find((t) => t.name === (name ?? info.selectedTarget));
    if (!target) {
      throw new SettingsError("Configure and save a deployment target first.");
    }
    return DeployTargetSchema.parse(target);
  }
}

/** Builds a first deployment target from values a previous manual deployment left in user secrets. */
function seedTarget(secrets: Record<string, unknown>, local: LocalSettings): DeployTarget | undefined {
  const value = (key: string) => (typeof secrets[key] === "string" ? (secrets[key] as string) : "");
  const candidate = {
    name: "staging",
    tenantId: value("Azure:TenantId"),
    subscriptionId: value("Azure:SubscriptionId"),
    location: value("Azure:Location"),
    resourceGroup: value("Azure:ResourceGroup"),
    foundryAccount: value("Parameters:foundry-account"),
    foundryResourceGroup: value("Parameters:foundry-resource-group"),
    foundryEndpoint: local.foundryEndpoint,
    foundryDeployments: local.foundryDeployments,
  };
  return DeployTargetSchema.safeParse(candidate).success ? candidate : undefined;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, content, "utf8");
  await rename(temp, path);
}

/** Environment for `aspire deploy`/`publish`: Production reads Azure__* and Parameters__* variables. */
export function deployEnvironment(target: DeployTarget, local: LocalSettings): Record<string, string> {
  const env: Record<string, string> = {
    Azure__SubscriptionId: target.subscriptionId,
    Azure__TenantId: target.tenantId,
    Azure__Location: target.location,
    Azure__ResourceGroup: target.resourceGroup,
    Azure__CredentialSource: "AzureCli",
    Azure__CredentialProcessTimeoutSeconds: "120",
    "Parameters__foundry-endpoint": target.foundryEndpoint,
    "Parameters__foundry-deployments": target.foundryDeployments.join(","),
    "Parameters__foundry-account": target.foundryAccount,
    "Parameters__foundry-resource-group": target.foundryResourceGroup,
  };
  const host = target.demoHost;
  env["Parameters__demo-host-transport"] = host?.transport ?? "disabled";
  if (host && host.transport !== "disabled") {
    env["Parameters__demo-host-owner"] = host.owner;
    env["Parameters__demo-host-harness"] = host.harness;
  }
  if (local.npmRegistry) {
    env["Parameters__npm-registry"] = local.npmRegistry;
  }
  if (local.pipIndexUrl) {
    env["Parameters__pip-index-url"] = local.pipIndexUrl;
  }
  return env;
}
