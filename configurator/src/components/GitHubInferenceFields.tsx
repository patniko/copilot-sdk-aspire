import { useState } from "react";
import type { GitHubInferenceModel } from "../../server/types";
import { api, errorMessage } from "../api";
import { useApp } from "../state";
import { RefreshCw, Trash2 } from "./icons";
import { Badge, ChipsInput, Field, SecretInput, Spinner } from "./ui";

/** The gateway's name prefix for GitHub Copilot models (contracts' GITHUB_MODEL_PREFIX). */
export const GITHUB_MODEL_PREFIX = "github/";
const COPILOT_MODEL = /^[A-Za-z0-9._-]{1,100}$/;

/** Accepts a write-only token: empty clears it; otherwise 20 to 400 characters without whitespace. */
export function validGitHubInferenceToken(token: string): boolean {
  return token === "" || (token.length >= 20 && token.length <= 400 && !/\s/.test(token));
}

/** Text shown on a discovered model's chip and suggestion: its routed name, display name, and premium multiplier. */
export function modelDetails(models: GitHubInferenceModel[] | undefined): Record<string, string> {
  return Object.fromEntries(
    (models ?? []).map((m) => [
      m.id,
      [m.routedAs, m.name !== m.id ? m.name : undefined, m.multiplier !== undefined ? `${m.multiplier}x premium requests` : undefined]
        .filter(Boolean)
        .join(" · "),
    ]),
  );
}

/** GitHub Copilot inference for the local gateway: a write-only token plus the Copilot models to expose. */
export function GitHubInferenceFields({ models, onChange, error }: {
  models: string[];
  onChange: (models: string[]) => void;
  error?: string;
}) {
  const { settings, refreshSettings, toast } = useApp();
  const stored = Boolean(settings?.githubInferenceCredentialStored);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<GitHubInferenceModel[]>();

  async function saveToken(value: string) {
    setSaving(true);
    try {
      await api("/api/settings/github-inference-token", { method: "PUT", body: { token: value } });
      setToken("");
      if (!value) setDiscovered(undefined);
      await refreshSettings();
      toast(value ? "Saved the GitHub inference token to Aspire secrets" : "Removed the GitHub inference token", "success");
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      setSaving(false);
    }
  }

  async function discover() {
    setDiscovering(true);
    try {
      const result = await api<{ models: GitHubInferenceModel[] }>("/api/github-inference/models");
      setDiscovered(result.models);
      toast(`Found ${result.models.length} GitHub Copilot model${result.models.length === 1 ? "" : "s"}`, "success");
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      setDiscovering(false);
    }
  }

  const tokenInvalid = token !== "" && !validGitHubInferenceToken(token);
  const routed = models.map((m) => `${GITHUB_MODEL_PREFIX}${m}`);

  return (
    <div className="space-y-4">
      <div>
        <span className="label">GitHub Copilot inference</span>
        <span className="hint block">
          Serves the Copilot models your GitHub account can use through the local gateway, alongside or instead of Foundry. Requests are billed to that
          account's Copilot plan. Rerun the AppHost after changes.
        </span>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="GitHub inference token"
          help="local.githubInferenceToken"
          className="min-w-[16rem] flex-1"
          hint="A token with Copilot access, such as a fine-grained PAT with the Copilot Requests permission. Saved only to Aspire secrets and never shown again."
          error={tokenInvalid ? "Use 20 to 400 characters without spaces." : undefined}
        >
          <SecretInput label="GitHub inference token" value={token} onChange={setToken} />
        </Field>
        <button type="button" className="btn-secondary" disabled={!token || tokenInvalid || saving} onClick={() => void saveToken(token)}>
          {saving ? <Spinner /> : null} Save token
        </button>
        <button type="button" className="btn-ghost" disabled={!stored || saving} onClick={() => void saveToken("")} aria-label="Clear GitHub inference token">
          <Trash2 className="h-4 w-4" /> Clear
        </button>
        <Badge tone={stored ? "green" : "neutral"}>{stored ? "Token stored" : "No token stored"}</Badge>
      </div>
      <Field
        label="GitHub Copilot models"
        help="local.githubInferenceModels"
        error={error}
        hint={
          <>
            {routed.length ? (
              <>Routed as <code className="text-xs">{routed.join(", ")}</code>. </>
            ) : (
              <>Empty exposes every usable model as <code className="text-xs">{GITHUB_MODEL_PREFIX}&lt;id&gt;</code>. </>
            )}
            Harnesses and the policy's approved models must use the <code className="text-xs">{GITHUB_MODEL_PREFIX}</code> names.
          </>
        }
      >
        <div className="space-y-2">
          <ChipsInput
            values={models}
            onChange={onChange}
            pattern={COPILOT_MODEL}
            placeholder="Add a Copilot model ID, e.g. claude-sonnet-5.5"
            suggestions={discovered?.map((m) => m.id)}
            details={modelDetails(discovered)}
          />
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn-secondary btn-sm" disabled={!stored || discovering} onClick={() => void discover()}>
              {discovering ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />} Discover models
            </button>
            {discovered && (
              <span className="hint">
                {discovered.length} usable model{discovered.length === 1 ? "" : "s"}; pick from the suggestions or leave empty for all.
              </span>
            )}
          </div>
          {discovered && discovered.length > 0 && (
            <ul className="max-h-48 overflow-auto text-xs" aria-label="Discovered GitHub Copilot models">
              {discovered.map((m) => (
                <li key={m.id} className="flex items-center gap-2 py-0.5">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={models.includes(m.id)}
                      onChange={(event) => onChange(event.target.checked ? [...models, m.id] : models.filter((id) => id !== m.id))}
                    />
                    <code>{m.routedAs}</code>
                  </label>
                  <span className="fg-muted">
                    {m.name !== m.id ? m.name : ""}
                    {m.multiplier !== undefined ? ` · ${m.multiplier}x` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Field>
    </div>
  );
}
