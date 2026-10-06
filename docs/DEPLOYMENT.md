# Deploying to Azure

[Documentation hub](README.md) | [User prerequisites](USER-GUIDE.md#before-you-start) | [Deployment topology](ARCHITECTURE.md#local-and-azure-topology)

The same AppHost that runs locally deploys the service to Azure Container Apps with `aspire deploy`. Review the
generated infrastructure with `aspire publish` first; neither command needs a project-operated service.

## What gets created

In the target resource group:

| Resource | Purpose |
| --- | --- |
| Container Apps environment + Log Analytics | Hosts all services; collects console logs |
| Azure Container Registry + pull identity | Stores the four service images |
| `agent-api` container app | The only external ingress (HTTPS) |
| `job-dispatcher`, `inference-gateway` container apps | Internal ingress only |
| `agent-executor` container app | No ingress; polls the dispatcher |
| Azure Database for PostgreSQL flexible server (Burstable B1ms, 32 GB) | Job ledger; Microsoft Entra authentication only |
| User-assigned identities for API, dispatcher, gateway | Database admin (API, dispatcher); model access (gateway) |

Outside the resource group, one role assignment: the gateway identity receives **Cognitive Services OpenAI User**
on the existing Foundry account you name. The deployment never creates, modifies, or deletes that account.

## Prerequisites and permissions

- Azure CLI signed in to the right tenant (`az login --tenant <tenant-id>`), Docker running, Node.js and pnpm.
- Permission to create resources and **role assignments** in the target subscription (Owner, or Contributor plus
  User Access Administrator), and to create role assignments on the Foundry account.
- A Foundry/Azure OpenAI deployment serving the OpenAI v1 chat completions API with available quota.
- Images are built locally for `linux/amd64`. On ARM64 workstations Docker emulates amd64, so the first build is slow.

## Inputs

`aspire deploy` runs in the Production environment, which does not read user secrets. Provide inputs as
environment variables (or CI secrets):

| Variable | Example |
| --- | --- |
| `Azure__SubscriptionId` | subscription GUID |
| `Azure__Location` | `westus2` (same region as the model deployment keeps latency low) |
| `Azure__ResourceGroup` | `copilot-agent-staging` (created if missing) |
| `Parameters__foundry-endpoint` | `https://<resource>.openai.azure.com/openai/v1` |
| `Parameters__foundry-deployments` | comma-separated deployment names, e.g. `grok-4.6` |
| `Parameters__foundry-account` | existing Foundry account name |
| `Parameters__foundry-resource-group` | resource group of that account |
| `Parameters__job-event-detail` | optional `sanitized` (default) or `full`; full persists sensitive diagnostic SDK detail |
| `Parameters__npm-registry`, `Parameters__pip-index-url` | optional package proxies for image builds |

The dev API key, executor key, gateway key, and capability signing key are generated on first deploy and kept in the
local Aspire deployment state; they are stored in Azure as Container Apps secrets.

PowerShell needs braces for variable names with hyphens:

```powershell
${env:Parameters__foundry-endpoint} = "https://<resource>.openai.azure.com/openai/v1"
```

## Deploy

```powershell
aspire publish --apphost ./apphost.mts --output-path ./artifacts/deployment   # inspect Bicep before applying
aspire deploy --apphost ./apphost.mts --list-steps                            # pipeline steps (not a what-if)
aspire deploy --apphost ./apphost.mts
```

`--list-steps` shows the pipeline, not the resource changes. Review the published Bicep, or run
`az deployment sub what-if` against it, before applying changes to a shared subscription.

## Verify

```powershell
$rg = $env:Azure__ResourceGroup
$api = "https://" + (az containerapp show -g $rg -n agent-api --query properties.configuration.ingress.fqdn -o tsv)
$key = az containerapp secret show -g $rg -n agent-api --secret-name api-keys --query value -o tsv   # "dev:<key>"
$key = $key.Split(":", 2)[1]

Invoke-RestMethod "$api/health"
Invoke-RestMethod "$api/v1/harnesses" -Headers @{ Authorization = "Bearer $key" }
```

Or open `$api` in a browser for the job console and paste the key, or use `http/agent-api.http`.

Then submit a job using the [API example](API.md#powershell-example) or
[job console](USER-GUIDE.md#run-a-job-in-the-console). Executor logs report the enforced controls at startup:

```powershell
az containerapp logs show -g $rg -n agent-executor --tail 20
```

`processIsolation: "uid"` must appear. If the executor reports a gap that the policy does not acknowledge, it logs
`executor is not eligible` and claims nothing; that is the intended fail-closed behaviour.

## Costs

Fixed costs accrue even when idle: the PostgreSQL server, the container registry, Log Analytics ingestion, and one
always-on replica of each container app (minimum replicas are 1 so the executor can poll and leases stay
renewed). Model usage is billed by the Foundry deployment. More executor replicas do not increase model quota.

## Tear down

```powershell
az group delete -n $env:Azure__ResourceGroup
az role assignment list --scope (az cognitiveservices account show -g "<foundry-rg>" -n "<foundry-account>" --query id -o tsv) `
  --query "[?roleDefinitionName=='Cognitive Services OpenAI User']"   # remove the gateway's assignment
```

Deleting the resource group never touches the Foundry account; remove the gateway's role assignment on it
separately.

## Troubleshooting

- **Deployments interrupt running attempts.** When a new revision replaces the executor, Container Apps signals
  every process in the old container. Attempts in flight end as `executor_lost`: read-only harnesses are retried
  on the new replica; harnesses with external effects go to `needs_review`. Deploy during quiet periods, or drain
  by stopping submissions first.
- **Aspire dashboard.** The Container Apps environment also hosts an Aspire dashboard behind Microsoft Entra
  sign-in. It is a development aid, not the job ledger or a customer UI.
- **`WinError 32` while compiling Bicep on Windows.** Parallel `az bicep build` calls race on the Bicep binary.
  Run `az bicep install` once and `az config set bicep.check_version=false`, then deploy again.
- **Package feeds behind a proxy.** Set `Parameters__npm-registry` and `Parameters__pip-index-url` for image
  builds. If nuget.org is blocked, point the Aspire CLI at your NuGet proxy with
  `ASPIRE_CLI_NUGET_SERVICE_INDEX=<proxy>/v3/index.json` and add a local, untracked `NuGet.config` whose
  `packageSourceMapping` maps `*` to that proxy (the CLI otherwise also queries nuget.org).
- **Lockfile changes after `aspire run`.** The CLI installs the AppHost with `pnpm install --ignore-workspace`.
  Keep lockfile-affecting settings out of `pnpm-workspace.yaml` (see the note there) so frozen image installs keep
  working.
