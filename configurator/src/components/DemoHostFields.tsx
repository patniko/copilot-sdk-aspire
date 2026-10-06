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
          <option value="direct">Direct CLI / Azure WSS</option>
          <option value="github">GitHub Mission Control</option>
          <option value="both">Both connection paths</option>
        </select>
      </Field>
      <Field label="GitHub owner" hint="Only this GitHub account may connect.">
        <input className="input" value={settings.owner} disabled={settings.transport === "disabled"}
          onChange={(event) => onChange({ ...settings, owner: event.target.value })} />
      </Field>
      <Field label="Conversation harness" hint="Use an explicitly opted-in conversation harness.">
        <input className="input" value={settings.harness} disabled={settings.transport === "disabled"}
          onChange={(event) => onChange({ ...settings, harness: event.target.value })} />
      </Field>
      {settings.transport !== "disabled" && <p className="hint md:col-span-3">
        Requires a compatible AHP-enabled CLI. Direct remote connections require sealed-auth support.
        Mission Control also needs the owner's credential in the demo-host-github-token Aspire secret;
        never put it in a deployment target. See docs/DEPLOYMENT.md before enabling an Azure host.
      </p>}
    </div>
  );
}
