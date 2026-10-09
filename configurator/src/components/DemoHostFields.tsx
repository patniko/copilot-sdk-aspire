import type { DemoHostSettings } from "@copilot-agent/contracts";
import { useApp } from "../state";
import { Badge, Field, RadioCards } from "./ui";

const GITHUB_LOGIN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;

const TRANSPORTS: Array<{ value: DemoHostSettings["transport"]; label: string; description: string; pending?: boolean }> = [
  { value: "disabled", label: "Disabled", description: "No demo agent host is started." },
  { value: "github", label: "GitHub Mission Control", description: "GitHub-native; uses Copilot models, permissions, and billing." },
  { value: "direct", label: "Managed direct WSS", description: "Uses the selected harness and the Foundry gateway.", pending: true },
  { value: "both", label: "Managed WSS + GitHub", description: "Both transports on one host.", pending: true },
];

export function DemoHostFields({ value, onChange, knownOwner }: {
  value?: DemoHostSettings;
  onChange: (value: DemoHostSettings) => void;
  /** GitHub login from the stored demo host credential, offered as a one-click owner. */
  knownOwner?: string;
}) {
  const { workspace } = useApp();
  const settings = value ?? { transport: "disabled", owner: "", harness: "interactive-demo" };
  const enabled = settings.transport !== "disabled";
  const managed = settings.transport === "direct" || settings.transport === "both";
  const conversationHarnesses = [...new Set((workspace?.harnesses ?? []).filter((h) => h.interaction === "conversation").map((h) => h.name))];
  const ownerError = settings.owner && !GITHUB_LOGIN.test(settings.owner) ? "Not a valid GitHub login." : enabled && !settings.owner ? "Required." : undefined;

  return (
    <div className="space-y-4">
      <div>
        <span className="label">Demo agent host (experimental)</span>
        <RadioCards
          label="Demo agent host transport"
          columns={4}
          value={settings.transport}
          onChange={(transport) => onChange({ ...settings, transport, owner: settings.owner || (transport !== "disabled" ? knownOwner ?? "" : "") })}
          options={TRANSPORTS.map((t) => ({
            value: t.value,
            label: t.label,
            description: t.description,
            badge: t.pending ? <Badge tone="amber">runtime pending</Badge> : undefined,
          }))}
        />
        <span className="hint block">Separate from batch jobs. Retains conversations and files on a dedicated volume.</span>
      </div>
      {enabled && (
        <div className="grid gap-4 md:grid-cols-3">
          <Field
            label="GitHub owner"
            error={ownerError}
            hint={
              knownOwner && knownOwner !== settings.owner ? (
                <button type="button" className="link" onClick={() => onChange({ ...settings, owner: knownOwner })}>
                  Use @{knownOwner} (signed in)
                </button>
              ) : (
                "Only this GitHub account may connect."
              )
            }
          >
            <div className="relative">
              <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center fg-muted">@</span>
              <input
                className="input !pl-6"
                value={settings.owner}
                spellCheck={false}
                autoComplete="off"
                aria-label="GitHub owner"
                onChange={(event) => onChange({ ...settings, owner: event.target.value.trim().replace(/^@/, "") })}
              />
            </div>
          </Field>
          {managed && (
            <Field
              label="Conversation harness"
              hint={conversationHarnesses.length ? "Harnesses that set interaction: conversation." : "No harness opts into conversations yet."}
            >
              <select className="input" value={settings.harness} onChange={(event) => onChange({ ...settings, harness: event.target.value })}>
                {!conversationHarnesses.includes(settings.harness) && (
                  <option value={settings.harness}>{settings.harness} (not a conversation harness)</option>
                )}
                {conversationHarnesses.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {managed && (
            <Field
              label="Qualified runtime directory"
              hint="Optional build-context directory containing a matching Linux x64 copilot-runtime and runtime.node. Unsupported bundled runtimes fail startup."
            >
              <input
                className="input font-mono"
                value={settings.runtimeDirectory ?? ""}
                spellCheck={false}
                onChange={(event) => onChange({ ...settings, runtimeDirectory: event.target.value })}
              />
            </Field>
          )}
          <p className="hint md:col-span-3">
            {settings.transport === "github"
              ? "GitHub-native mode uses Copilot models, permissions, and billing, not the app's harness or Foundry budgets. It retains its own workspace and uses no public host ingress. A normally relay-enabled CLI is required; host readiness does not enable client features."
              : "Managed mode uses the selected harness and Foundry gateway; a qualified runtime/CLI build is still required."}{" "}
            GitHub hosting needs the owner's credential in the demo-host-github-token Aspire secret. Never put it in a deployment target. See
            docs/DEPLOYMENT.md before enabling an Azure host.
          </p>
        </div>
      )}
    </div>
  );
}
