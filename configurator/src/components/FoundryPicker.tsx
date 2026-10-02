import { Search } from "lucide-react";
import { useState } from "react";
import type { FoundryAccount, FoundryDeployment } from "../../server/types";
import { api, errorMessage } from "../api";
import { Badge, Spinner } from "./ui";

/** Lists Foundry/Azure OpenAI accounts and model deployments in a subscription so values are not typed by hand. */
export function FoundryPicker({ subscriptionId, onPick }: {
  subscriptionId?: string;
  onPick: (account: FoundryAccount, deployments: FoundryDeployment[]) => void;
}) {
  const [accounts, setAccounts] = useState<FoundryAccount[]>();
  const [deployments, setDeployments] = useState<Record<string, FoundryDeployment[]>>({});
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  async function discover() {
    if (!subscriptionId) return;
    setBusy("accounts");
    setError(undefined);
    try {
      const result = await api<{ accounts: FoundryAccount[] }>(`/api/foundry/accounts?subscription=${subscriptionId}`);
      setAccounts(result.accounts);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  }

  async function choose(account: FoundryAccount) {
    setBusy(account.name);
    setError(undefined);
    try {
      const query = new URLSearchParams({ subscription: subscriptionId!, resourceGroup: account.resourceGroup, account: account.name });
      const result = await api<{ deployments: FoundryDeployment[] }>(`/api/foundry/deployments?${query}`);
      setDeployments((current) => ({ ...current, [account.name]: result.deployments }));
      onPick(account, result.deployments);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="rounded-xl border border-dashed border-slate-300 p-3 dark:border-slate-700">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-secondary btn-sm" disabled={!subscriptionId || !!busy} onClick={() => void discover()}>
          {busy === "accounts" ? <Spinner className="h-3.5 w-3.5" /> : <Search className="h-3.5 w-3.5" />} Discover Foundry accounts
        </button>
        <span className="text-xs text-slate-500">{subscriptionId ? `in subscription ${subscriptionId.slice(0, 8)}…` : "Sign in to Azure or set a subscription first."}</span>
      </div>
      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
      {accounts && (
        <ul className="mt-3 space-y-1.5">
          {accounts.length === 0 && <li className="text-xs text-slate-500">No Foundry or Azure OpenAI accounts found.</li>}
          {accounts.map((account) => (
            <li key={`${account.resourceGroup}/${account.name}`} className="flex flex-wrap items-center gap-2 text-xs">
              <button type="button" className="btn-ghost btn-sm" disabled={!!busy} onClick={() => void choose(account)}>
                {busy === account.name && <Spinner className="h-3 w-3" />} Use <strong>{account.name}</strong>
              </button>
              <span className="text-slate-500">
                {account.resourceGroup} · {account.location} · {account.kind}
              </span>
              {deployments[account.name]?.map((d) => (
                <Badge key={d.name} tone="green" title={`${d.model} ${d.version} · ${d.sku}${d.capacity ? ` · ${d.capacity}` : ""}`}>
                  {d.name}
                </Badge>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
