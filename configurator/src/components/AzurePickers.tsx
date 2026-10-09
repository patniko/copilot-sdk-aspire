import { useEffect, useState } from "react";
import type { AzureLocation, AzureResourceGroup, AzureSubscription, FoundryDeployment } from "../../server/types";
import { api, errorMessage } from "../api";
import { RefreshCw } from "./icons";
import { Badge, Field, Spinner } from "./ui";

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGuid = (value: string | undefined): value is string => !!value && GUID.test(value);

// Azure CLI calls take seconds; keep results for the page session and share them between pickers.
const cache = new Map<string, Promise<unknown>>();

export function useDiscovery<T>(path: string | undefined) {
  const [state, setState] = useState<{ path: string; data?: T; error?: string }>();
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    let promise = cache.get(path) as Promise<T> | undefined;
    if (!promise) {
      promise = api<T>(path);
      cache.set(path, promise);
      promise.catch(() => cache.delete(path));
    }
    setState({ path });
    promise
      .then((data) => !cancelled && setState({ path, data }))
      .catch((error) => !cancelled && setState({ path, error: errorMessage(error) }));
    return () => {
      cancelled = true;
    };
  }, [path, nonce]);
  const current = state?.path === path ? state : undefined;
  return {
    data: current?.data,
    error: current?.error,
    loading: !!path && !current?.data && !current?.error,
    reload: () => {
      if (path) cache.delete(path);
      setNonce((n) => n + 1);
    },
  };
}

function ReloadButton({ onClick, loading, label }: { onClick: () => void; loading: boolean; label: string }) {
  return (
    <button type="button" className="btn-ghost btn-sm btn-icon" aria-label={label} title={label} disabled={loading} onClick={onClick}>
      {loading ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw className="h-3.5 w-3.5" />}
    </button>
  );
}

/** Subscription dropdown from `az account list`; choosing one also sets the tenant. Falls back to typed IDs. */
export function SubscriptionPicker({ tenantId, subscriptionId, signedIn, onChange, errors = {} }: {
  tenantId: string;
  subscriptionId: string;
  signedIn: boolean;
  onChange: (value: { tenantId: string; subscriptionId: string }) => void;
  errors?: { tenantId?: string; subscriptionId?: string };
}) {
  const subs = useDiscovery<{ subscriptions: AzureSubscription[] }>(signedIn ? "/api/azure/subscriptions" : undefined);
  const [manual, setManual] = useState(false);
  const list = subs.data?.subscriptions;
  const known = list?.find((s) => s.id.toLowerCase() === subscriptionId.toLowerCase());
  const showManual = manual || !signedIn || !!subs.error;

  if (showManual) {
    return (
      <>
        <Field label="Subscription ID" help="target.subscription" error={errors.subscriptionId ?? (subscriptionId && !isGuid(subscriptionId) ? "Expected a GUID." : undefined)}>
          <input className="input font-mono" value={subscriptionId} spellCheck={false} onChange={(e) => onChange({ tenantId, subscriptionId: e.target.value.trim() })} />
        </Field>
        <Field
          label="Tenant ID"
          error={errors.tenantId ?? (tenantId && !isGuid(tenantId) ? "Expected a GUID." : undefined)}
          hint={
            signedIn && !subs.error ? (
              <button type="button" className="link" onClick={() => setManual(false)}>
                Choose from my subscriptions instead
              </button>
            ) : subs.error ? (
              `Could not list subscriptions: ${subs.error}`
            ) : (
              "Sign in to Azure to pick from a list."
            )
          }
        >
          <input className="input font-mono" value={tenantId} spellCheck={false} onChange={(e) => onChange({ tenantId: e.target.value.trim(), subscriptionId })} />
        </Field>
      </>
    );
  }

  return (
    <Field
      label="Subscription"
      help="target.subscription"
      className="md:col-span-2"
      error={errors.subscriptionId ?? errors.tenantId}
      hint={
        <>
          {subscriptionId ? (
            <>
              <code className="text-[11px]">{subscriptionId}</code> · tenant <code className="text-[11px]">{tenantId || "unset"}</code>
              {list && !known && <> · not in your signed-in account list</>}
            </>
          ) : (
            "Lists the subscriptions your Azure CLI sign-in can see."
          )}{" "}
          ·{" "}
          <button type="button" className="link" onClick={() => setManual(true)}>
            Enter IDs manually
          </button>
        </>
      }
    >
      <div className="flex gap-1">
        <select
          className="input"
          value={known?.id ?? subscriptionId}
          disabled={!list}
          onChange={(e) => {
            const picked = list?.find((s) => s.id === e.target.value);
            if (picked) onChange({ tenantId: picked.tenantId, subscriptionId: picked.id });
          }}
        >
          {!list && <option value={subscriptionId}>{subs.loading ? "Loading subscriptions…" : subscriptionId}</option>}
          {list && !subscriptionId && <option value="">Choose a subscription</option>}
          {list && subscriptionId && !known && <option value={subscriptionId}>{subscriptionId} (not listed)</option>}
          {list?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.isDefault ? " (current az default)" : ""}
            </option>
          ))}
        </select>
        <ReloadButton onClick={subs.reload} loading={subs.loading} label="Reload subscriptions" />
      </div>
    </Field>
  );
}

/** Region dropdown from `az account list-locations`, grouped by geography. Falls back to a text box. */
export function RegionPicker({ subscriptionId, value, onChange, error }: {
  subscriptionId: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  const locations = useDiscovery<{ locations: AzureLocation[] }>(isGuid(subscriptionId) ? "/api/azure/locations" : undefined);
  const list = locations.data?.locations;
  if (!list) {
    return (
      <Field label="Region" error={error} hint={locations.loading ? "Loading regions…" : locations.error ? `Could not list regions: ${locations.error}` : "Azure region name, e.g. westus2."}>
        <input className="input font-mono" value={value} spellCheck={false} onChange={(e) => onChange(e.target.value.trim().toLowerCase())} />
      </Field>
    );
  }
  const groups = new Map<string, AzureLocation[]>();
  for (const location of list) {
    const key = location.geography ?? "Other";
    groups.set(key, [...(groups.get(key) ?? []), location]);
  }
  return (
    <Field label="Region" error={error} hint={<code className="text-[11px]">{value}</code>}>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {!list.some((l) => l.name === value) && <option value={value}>{value || "Choose a region"}</option>}
        {[...groups].map(([geography, items]) => (
          <optgroup key={geography} label={geography}>
            {items.map((l) => (
              <option key={l.name} value={l.name}>
                {l.displayName}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </Field>
  );
}

/** Resource group name with existing groups suggested; shows whether the name is new or existing. */
export function ResourceGroupInput({ subscriptionId, value, onChange, region, error }: {
  subscriptionId: string;
  value: string;
  onChange: (value: string) => void;
  region: string;
  error?: string;
}) {
  const groups = useDiscovery<{ resourceGroups: AzureResourceGroup[] }>(isGuid(subscriptionId) ? `/api/azure/resource-groups?subscription=${subscriptionId}` : undefined);
  const list = groups.data?.resourceGroups;
  const existing = list?.find((g) => g.name.toLowerCase() === value.toLowerCase());
  const listId = "resource-groups";
  return (
    <Field
      label="Resource group"
      help="target.resourceGroup"
      error={error}
      hint={
        !value ? undefined : !list ? (
          "Created if it does not exist."
        ) : existing ? (
          <Badge tone="amber">Existing group in {existing.location}; resources are added to it</Badge>
        ) : (
          <Badge tone="green">New: created in {region || "the selected region"}</Badge>
        )
      }
    >
      <input className="input font-mono" list={listId} value={value} spellCheck={false} onChange={(e) => onChange(e.target.value.trim())} />
      <datalist id={listId}>
        {list?.map((g) => (
          <option key={g.name} value={g.name}>
            {g.location}
          </option>
        ))}
      </datalist>
    </Field>
  );
}

/** Deployments in a known Foundry account, for chip suggestions. */
export function useFoundryDeployments(subscriptionId: string | undefined, resourceGroup: string, account: string) {
  const path =
    isGuid(subscriptionId) && resourceGroup && account
      ? `/api/foundry/deployments?${new URLSearchParams({ subscription: subscriptionId, resourceGroup, account })}`
      : undefined;
  return useDiscovery<{ deployments: FoundryDeployment[] }>(path);
}

export function deploymentDetails(deployments: FoundryDeployment[] | undefined): Record<string, string> {
  return Object.fromEntries((deployments ?? []).map((d) => [d.name, [d.model, d.version].filter(Boolean).join(" ")]));
}
