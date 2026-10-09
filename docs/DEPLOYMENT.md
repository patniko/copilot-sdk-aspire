# Deploying to Azure

[Documentation hub](README.md) | [User prerequisites](USER-GUIDE.md#before-you-start) | [Deployment topology](ARCHITECTURE.md#local-and-azure-topology)

The same AppHost that runs locally deploys the service to Azure Container Apps with `aspire deploy`. Review the
generated infrastructure with `aspire publish` first; neither command needs a project-operated service.

The AppHost ensures `.copilot-agent-workspace/` exists, seeding missing `harnesses/` and `policy/` directories from
`examples/customer-config/` without overwriting existing customer files. Docker builds package harnesses and policy
from that workspace, while execution profiles and runner/tool code remain platform-owned inputs from this checkout.
Review workspace contents before publishing because those files become the deployed configuration.

## What gets created

In the target resource group:

| Resource | Purpose |
| --- | --- |
| Container Apps environment + Log Analytics | Hosts all services; collects console logs |
| Azure Container Registry + pull identity | Stores the four service images |
| `agent-api` container app | The only external ingress (HTTPS) |
| `job-dispatcher`, `inference-gateway` container apps | Internal ingress only |
| `agent-executor` container app | No ingress; polls the dispatcher |
| Optional `agent-host` container app and persistent volume | Experimental retained conversations; direct WSS, GitHub relay, or both; disabled by default |
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
  Local runs (`aspire run`/**Local run**) instead build the executor and demo host for the workstation's native
  architecture, because an emulated host build can exceed Aspire's container build timeout. The managed-runtime host
  stage always builds amd64 for its Linux x64 artifacts.

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

`processIsolation: "uid"` must appear. The executor claims only jobs whose effective policy (base policy plus any
harness override) its controls satisfy or whose gaps that policy acknowledges. A job no executor may run stays
`queued` and records `job.waiting_for_eligible_executor`; that is the intended fail-closed behaviour.

## Costs

Fixed costs accrue even when idle: the PostgreSQL server, the container registry, Log Analytics ingestion, and one
always-on replica of each container app (minimum replicas are 1 so the executor can poll and leases stay
renewed). Model usage is billed by the Foundry deployment. More executor replicas do not increase model quota.
An enabled demo host adds always-on compute and persistent storage even when no CLI is connected.

## Optional demo agent host

Configure the host independently in **Local run** and each **Deploy** target. Enabling it locally does not
silently enable Azure ingress. There are two deliberately different execution profiles:

| Setting | Execution and model access | Hosting prerequisite |
| --- | --- | --- |
| `github` | GitHub-native Copilot sessions, permissions, models, and billing; no public host ingress | Released CLI server packaged in the image; a normally enabled relay client |
| `direct` | App-managed conversation harness and Foundry gateway over direct WSS | Qualified runtime/client changes described below |
| `both` | App-managed harness/Foundry sessions exposed through both transports | Same managed runtime/client changes; not the GitHub-native profile |

GitHub-native mode does not use the configured harness, Foundry budgets, or managed factory callbacks.
It uses the published `@github/copilot` CLI server pinned in `src/agent-host/package.json`, through the SDK's
supported stdio connection. This avoids relying on the SDK's unqualified bundled wrapper for native inference.

| Parameter | Meaning |
| --- | --- |
| `Parameters:demo-host-transport` | `disabled` (default), `direct`, `github`, or `both` |
| `Parameters:demo-host-owner` | Expected GitHub login; resolved to a numeric account ID and pinned in durable host ownership |
| `Parameters:demo-host-harness` | Managed profiles only: a conversation harness; defaults to `interactive-demo` |
| `Parameters:demo-host-github-token` | Owner credential for Mission Control; store only in Aspire secrets, never in the customer workspace or target JSON |
| `Parameters:demo-host-runtime-dir` | Managed profiles only: optional relative build-context directory containing matching Linux x64 `copilot-runtime` and `runtime.node` artifacts |

For production-mode deployment, the corresponding names are `Parameters__demo-host-*`. The configurator forwards
the GitHub credential from the protected local Aspire secret only when the selected target explicitly enables
`github` or `both`; task output redacts it. **Local run** provides a password input that stores this credential
without returning it from the settings API or placing it in a command line.

For managed profiles, the `interactive-demo` example is seeded into new customer workspaces. Existing workspaces are not overwritten:
copy/adapt the example explicitly if it is absent. Its model names still need to match the configured policy and
Foundry deployments. A conversation harness cannot be submitted as a batch job.

### Demo host compatibility gate

**The managed profiles remain deferred to runtime engineers.** GitHub-native mode uses host-owned sessions and
the existing Mission Control owner binding, so it does not need the custom managed-factory or direct-key changes.
Managed hosting requires:

- Direct non-loopback hosts require sealed authentication. The CLI must support independently provisioned
  `COPILOT_AHP_SERVER_KEY` pins, not silently send an unsealed credential.
- The hosting runtime must enforce `COPILOT_AHP_EXPECTED_OWNER` before serving authenticated session operations.
  Older runtimes can ignore unknown environment variables, so configuration alone is not proof of enforcement.
- Application factories must be able to preserve managed defaults such as disabled configuration discovery.
  The currently observed bundled runtime rejects the application's `enableConfigDiscovery: false` override.

The corresponding prerequisite changes are in the adjacent `copilot-agent-runtime` checkout. A source patch is
not a runnable artifact: qualify the matching launcher/provider and CLI before activation. Do not disable owner
checks, sealed authentication, or managed session restrictions to make an older build work.
The engineering handoff is `..\copilot-agent-runtime\docs\aspire-agent-host-handoff.md`; it records source commits,
reproductions, remaining release work, and actual validation. Keep build artifacts out of Git; `.runtime-artifacts/`
is ignored for that purpose.

Managed startup performs a credential-free, empty-workspace negative probe before exposing the real host:
the runtime must reject malformed expected-owner configuration with the documented error. An older runtime that
ignores the setting is disposed and activation fails closed.

### GitHub-native client eligibility

Use a CLI in which `RELAY_CLIENT` is normally available. The launcher uses
`copilot --experimental --relay --environment-id <id>` in an interactive terminal. Registration and model
access do not imply that a particular CLI profile has relay enabled.

A clean CLI 1.0.92 profile used during qualification returned `Error: --relay is not enabled.` That is a
client feature eligibility/configuration prerequisite, not something the app enables by weakening authentication
or forcing feature flags. Use the supported enabled client/build before presenting an interactive demo.

### Native qualification evidence

Local evidence collected on October 5, 2026:

| Surface | Result and limit |
| --- | --- |
| Rebuilt Linux/amd64 host image, without source mounts | Registered with Mission Control, preserved the environment ID and workspace across container replacement, and denied the execution uid access to the supervisor environment |
| Released CLI 1.0.92 used as the SDK server | Completed an authenticated Copilot inference request; this was separate from the relay client |
| Interactive CLI 1.0.92 with a clean profile | Rejected `--relay` as not enabled; interactive end-to-end attachment still requires a normally enabled client |
| Azure deployment and Azure Files | Not deployed or qualified by these local runs |

The opt-in native test is `tests/integration/github-native-host.test.ts`. It creates and removes its own
Mission Control environment; it does not authorize deleting an existing deployment's environment.

### Storage and revision requirements

The AppHost mounts a named volume at `/data`; Azure publishing maps persistent volume storage through the
Container Apps integration. Preserve both the volume and PostgreSQL. The database is not a backup of runtime
history or the working tree.
Native state lives under `/data/github-native`; managed state lives under `/data/execution`. Switching profiles
does not convert or merge their conversations. Native conversations are managed through the connected CLI,
not the managed-session budget/close endpoints.

Review the generated storage resources and qualify the actual Azure mount's permissions, file/SQLite locking,
atomic writes, and restart integrity. A working local Docker volume is not proof of Azure Files compatibility.
If that storage cannot satisfy the runtime's requirements, do not claim durable Azure support.

The current TypeScript Aspire scale API exposes `minReplicas`, not `maxReplicas`. The host lease and catalog
reject concurrent owners; they are not an autoscaling strategy. Set the Azure host's maximum replicas to one
in the reviewed deployment configuration. Do not use normal rolling traffic splitting against one catalog:
deactivate/drain the previous host revision before starting its replacement. Reconnect clients afterward.
Do not delete the host volume during an upgrade.

Changing the expected account is not a supported in-place ownership reassignment. A different numeric account
ID cannot acquire the existing host, including when a login name is reused. A legacy prototype host without a
pinned numeric identity requires an explicit operator-reviewed migration rather than automatic adoption.

For operator and client steps, see [Demo agent host](USER-GUIDE.md#demo-agent-host).

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
