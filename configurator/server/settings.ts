import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { capture } from "./process.js";
import type { DeployTarget, LocalSettings, SettingsInfo } from "./types.js";

export class SettingsError extends Error {}

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NAME = /^[A-Za-z0-9._-]{1,90}$/;

const httpsUrl = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
  }, "Use an https:// URL without credentials, query strings, or fragments.");

const optionalHttpsUrl = z.union([z.literal(""), httpsUrl]);
const deployment = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, "Deployment names use letters, digits, '.', '_' and '-'.");

export const LocalSettingsSchema = z
  .object({
    foundryEndpoint: optionalHttpsUrl,
    foundryDeployments: z.array(deployment).max(20),
    npmRegistry: optionalHttpsUrl,
    pipIndexUrl: optionalHttpsUrl,
    nugetServiceIndex: optionalHttpsUrl,
  })
  .strict();

export const DeployTargetSchema = z
  .object({
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

  async secretsPath(): Promise<string | undefined> {
    if (this.#secretsPath) {
      return this.#secretsPath;
    }
    const result = await capture("aspire", ["secret", "path", "--apphost", "apphost.mts", "--nologo", "--non-interactive"], {
      cwd: this.root,
      env: this.aspireEnv(),
      timeoutMs: 60_000,
    });
    const path = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.endsWith("secrets.json"));
    this.#secretsPath = path;
    return path;
  }

  async #readSecrets(): Promise<Record<string, unknown>> {
    const path = await this.secretsPath();
    if (!path) {
      return {};
    }
    try {
      return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  async #writeSecrets(updates: Record<string, string | undefined>): Promise<void> {
    const path = await this.secretsPath();
    if (!path) {
      throw new SettingsError("Could not locate the AppHost user secrets file (is the Aspire CLI installed?).");
    }
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
  if (local.npmRegistry) {
    env["Parameters__npm-registry"] = local.npmRegistry;
  }
  if (local.pipIndexUrl) {
    env["Parameters__pip-index-url"] = local.pipIndexUrl;
  }
  return env;
}
