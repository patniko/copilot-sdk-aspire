import type { DemoHostSettings } from "@copilot-agent/contracts";
import { Field } from "./ui";

export function DemoHostFields({ value, onChange }: {
  value?: DemoHostSettings;
  onChange: (value: DemoHostSettings) => void;
}) {
  const settings = value ?? { transport: "disabled", owner: "", harness: "interactive-demo" };
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Field label="Demo agent host (experimental)" hint="Separate from batch jobs. Retains conversations and files on a dedicated volume.">
        <select className="input" value={settings.transport}
          onChange={(event) => onChange({ ...settings, transport: event.target.value as DemoHostSettings["transport"] })}>
          <option value="disabled">Disabled</option>
          <option value="direct">Managed direct WSS (runtime work pending)</option>
          <option value="github">GitHub-native Mission Control</option>
          <option value="both">Managed WSS + GitHub (runtime work pending)</option>
        </select>
      </Field>
      <Field label="GitHub owner" hint="Only this GitHub account may connect.">
        <input className="input" value={settings.owner} disabled={settings.transport === "disabled"}
          onChange={(event) => onChange({ ...settings, owner: event.target.value })} />
      </Field>
      <Field label="Conversation harness" hint="Use an explicitly opted-in conversation harness.">
        <input className="input" value={settings.harness} disabled={settings.transport === "disabled" || settings.transport === "github"}
          onChange={(event) => onChange({ ...settings, harness: event.target.value })} />
      </Field>
      <Field label="Qualified runtime directory" className="md:col-span-3"
        hint="Optional build-context directory containing a matching Linux x64 copilot-runtime and runtime.node. Unsupported bundled runtimes fail startup.">
        <input className="input font-mono" value={settings.runtimeDirectory ?? ""} disabled={settings.transport === "disabled" || settings.transport === "github"}
          onChange={(event) => onChange({ ...settings, runtimeDirectory: event.target.value })} />
      </Field>
      {settings.transport !== "disabled" && <p className="hint md:col-span-3">
        {settings.transport === "github"
          ? "GitHub-native mode uses Copilot models, permissions, and billing, not the app's harness or Foundry budgets. It retains its own workspace and uses no public host ingress. A normally relay-enabled CLI is required; host readiness does not enable client features."
          : "Managed mode uses the selected harness and Foundry gateway; a qualified runtime/CLI build is still required."}
        {" "}GitHub hosting needs the owner's credential in the demo-host-github-token Aspire secret.
        Never put it in a deployment target. See docs/DEPLOYMENT.md before enabling an Azure host.
      </p>}
    </div>
  );
}
