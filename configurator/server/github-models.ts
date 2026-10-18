import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GITHUB_MODEL_PREFIX } from "@copilot-agent/contracts";
import type { GitHubInferenceModel } from "./types.js";

/** A model as the Copilot SDK lists it for a GitHub account. */
export interface CopilotModelListing {
  id: string;
  name?: string;
  policy?: { state?: string };
  billing?: { multiplier?: number };
}

/** Lists the models a GitHub token can use; replaced in tests so discovery never needs the network. */
export type GitHubModelLister = (token: string) => Promise<CopilotModelListing[]>;

export class GitHubModelsError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

/** Environment the Copilot runtime needs; the configurator's own credentials and the user's gh login are not passed. */
const RUNTIME_ENV = [
  "PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "LANG", "SystemRoot", "windir", "PATHEXT", "LOCALAPPDATA", "APPDATA",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
];

/** Lists the account's models through the published Copilot SDK, authenticated only with the supplied token. */
export const sdkModelLister: GitHubModelLister = async (token) => {
  const { CopilotClient } = await import("@github/copilot-sdk");
  const env: Record<string, string> = {};
  for (const key of RUNTIME_ENV) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  const directory = await mkdtemp(join(tmpdir(), "configurator-github-models-"));
  const client = new CopilotClient({
    mode: "empty",
    baseDirectory: directory,
    workingDirectory: directory,
    gitHubToken: token,
    useLoggedInUser: false,
    logLevel: "error",
    env,
  });
  try {
    await client.start();
    return await client.listModels();
  } finally {
    await client.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
};

/**
 * Models the inference gateway would route for this token: the synthetic `auto` model and models the account's policy
 * has not enabled are excluded, mirroring the gateway's GitHub upstream.
 */
export async function discoverGitHubModels(token: string, list: GitHubModelLister = sdkModelLister): Promise<GitHubInferenceModel[]> {
  let listed: CopilotModelListing[];
  try {
    listed = await list(token);
  } catch {
    // SDK failures may echo request details; never return or log their raw payloads.
    throw new GitHubModelsError(
      502,
      "Could not list GitHub Copilot models. Check that the stored token is valid and has Copilot access (for a fine-grained PAT, the 'Copilot Requests' permission), then retry.",
    );
  }
  const seen = new Set<string>();
  const models: GitHubInferenceModel[] = [];
  for (const model of listed) {
    if (!model?.id || model.id === "auto" || seen.has(model.id)) continue;
    const policyState = model.policy?.state;
    if (policyState !== undefined && policyState !== "enabled") continue;
    seen.add(model.id);
    models.push({
      id: model.id,
      name: model.name || model.id,
      routedAs: `${GITHUB_MODEL_PREFIX}${model.id}`,
      ...(policyState ? { policyState } : {}),
      ...(typeof model.billing?.multiplier === "number" ? { multiplier: model.billing.multiplier } : {}),
    });
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}
