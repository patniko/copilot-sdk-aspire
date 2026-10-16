# Deploying to Azure

[Documentation hub](README.md) | [User prerequisites](USER-GUIDE.md#before-you-start) | [Deployment topology](ARCHITECTURE.md#local-and-azure-topology)

The same AppHost that runs locally deploys the service to Azure Container Apps with `aspire deploy`. Review the
generated infrastructure with `aspire publish` first; neither command needs a project-operated service.

The AppHost ensures `.copilot-agent-workspace/` exists, seeding missing `harnesses/` and `policy/` directories from
`examples/customer-config/` without overwriting existing customer files. Docker builds package harnesses and policy
from that workspace, while execution profiles and runner/tool code remain platform-owned inputs from this checkout.
Review workspace contents before publishing because those files become the deployed configuration.

## What gets created

The default Azure path below is unchanged. The optional
[local hybrid deployment](#experimental-local-hybrid-deployment) uses a host-side Docker controller;
Azure publication refuses that mode until an Azure execution adapter is qualified.

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

- Azure CLI signed in to the right tenant (`az login --tenant <tenant-id>`), Docker running, Node.js, pnpm,
  and the .NET 10 SDK for the local Aspire hosting integration.
- Permission to create resources and **role assignments** in the target subscription (Owner, or Contributor plus
  User Access Administrator), and to create role assignments on the Foundry account.
- A Foundry/Azure OpenAI deployment serving the OpenAI v1 chat completions API with available quota.
- Images are built locally for `linux/amd64`. On ARM64 workstations Docker emulates amd64, so the first build is slow.
  Local runs (`aspire run`/**Local run**) instead build the executor and demo host for the workstation's native
  architecture, because an emulated host build can exceed Aspire's container build timeout. The managed-runtime host
  stage follows its runtime bundle's architecture: an arm64 bundle builds natively for local runs, and publishing
  requires a linux/amd64 bundle.

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

## Experimental local hybrid deployment

This opt-in path keeps conversational work on one shared in-process runtime and starts Linux execution
containers only for admitted jobs. The shared worker serves every published conversation harness whose
`hosting.mode` is `shared` and whose effective policy allows that mode, and `promotable` harnesses when
[session containers](#session-containers) are enabled; each session runs the harness's own
instructions, model options, tools, skills, sub-agents, limits, and permissions. The existing direct-container agent
is independent. It requires the locally patched runtime/SDK/hosting sources and a matching CLI; see the
[build and qualification instructions](DEVELOPER-GUIDE.md#hybrid-runtime-qualification).

Build the executor once before starting the controller. This uses the workstation's native Docker
architecture; add `NPM_REGISTRY`/`PIP_INDEX_URL` build arguments if approved proxies are required.

```powershell
pnpm install
pnpm build
docker build -f deploy\Dockerfile --target agent-executor `
  --build-arg CUSTOMER_CONFIG_DIR=examples/customer-config `
  -t copilot-hybrid-executor:local .

aspire secret set "Parameters:hybrid-hosting" "true"
aspire secret set "Parameters:hybrid-principals" '{"dev":12345}'
aspire secret set "Parameters:hybrid-runtime-path" "C:\path\to\qualified\copilot-runtime.exe"
aspire secret set "Parameters:hybrid-harnesses" "text-summarizer,copilot-coding-agent"
aspire run --apphost .\apphost.mts
```

Replace `12345` with the numeric GitHub ID for the caller using the `dev` API key. This is an
operator-controlled binding, not user-supplied identity. Each session uses the first of its harness's models that
the effective policy approves, through the configured gateway; existing Foundry configuration is still required.
The runtime launcher must come from the [required runtime revision](DEVELOPER-GUIDE.md#hybrid-runtime-qualification),
match the **host** OS/architecture, and have its matching library beside it;
do not point a Windows Node worker at the Linux container bundle. The worker enables the runtime's experimental
assisted-approval flag (`AUTO_APPROVAL`) in its own process, so neither the AppHost nor the image sets it.

The worker reads harnesses and policy from the customer workspace (`CONFIG_ROOT`), like the other services. The
examples include two shared harnesses with their policy overrides: `hybrid-coordinator` (the coordinator that
delegates jobs to the `hybrid-harnesses`) and `shared-researcher` (workspace files and filtered web access, with
`manual` and `assisted` approvals allowed). The workspace is seeded only when its `harnesses` or `policy` folder is
missing, so copy them from `examples/customer-config` into an existing workspace. Harness and policy changes reach
new activations within a few seconds without restarting the worker; a session keeps the harness version it was
created with and is re-checked against the current policy each time it activates. Sessions created before
harness-driven hosting cannot be resumed; create new ones.

A harness's approved remote MCP servers come from the policy's `mcpServers` catalog. For each secret reference in
that catalog (`auth.secret`), the AppHost declares a secret parameter `mcp-secret-<reference>` and gives the worker
its value as `MCP_SECRET_<REFERENCE>` (upper case, hyphens as underscores). For example, a catalog server with
`"auth": { "secret": "docs-search-token" }` needs:

```powershell
aspire secret set "Parameters:mcp-secret-docs-search-token" "<token for that server>"
```

The AppHost adds `connection-broker`, `session-host`, and `execution-controller` Node services, private
worker, broker, and allocation-signing keys, and removes the always-on `agent-executor` resource. The CLI
attaches only to the broker, whose URL the API returns; the broker consumes tickets through the dispatcher
and holds no database, caller, or provider credential. The controller starts
one-shot instances of the prebuilt executor image, including for ordinary `/v1/jobs` submissions.
They have no database, Docker socket, or provider credential. API/dispatcher/gateway and PostgreSQL
remain shared; optional `agent-host` compute is additional and is not counted as idle execution capacity.
The controller requires a local Docker socket/named pipe and never silently targets a remote daemon.

Connect through the provisioned API path, naming a shared harness:

```powershell
pnpm host:connect --harness shared-researcher --target local --transport direct --cli C:\path\to\matching\dist-cli\index.js
# Resume using the application session UUID printed by the first launcher:
pnpm host:connect --harness shared-researcher --target local --transport direct --resume <session-uuid> --cli C:\path\to\matching\dist-cli\index.js
```

`--destination shared` still works and selects `hybrid-coordinator`. The launcher checks the harness's
[hosting view](API.md#hosting-views) first and reports why it cannot be hosted; the GitHub relay is not offered for
shared harnesses.

The shared launcher explicitly consents to GitHub identity authentication to the provisioned host.
It connects through the broker URL that the API returns and does not expose the private listener token
or request paid inference itself. Ordinary conversation
and delegated work use your configured model and incur its normal cost.
After idle eviction, obtain a new ticket with the resume command. Restarting `agent-api`, for example with
the configurator's **Reload harnesses**, leaves an attached CLI connected; restarting `connection-broker` or
`session-host` disconnects it. Stop the AppHost to stop the shared
service and retire its managed execution containers; closing only the CLI preserves the conversation.
Set `hybrid-hosting=false` and restart to return to the existing executor-pool topology.
For a parallel worktree, use `--isolated` with explicit environment inputs. The AppHost profile no
longer pins the internal OTLP/resource-service ports, so isolated instances can use generated ports
without colliding with another checkout. TypeScript AppHosts do not accept `--launch-profile`.

### Hybrid controls

All settings are validated server-side. Changing them through Aspire configuration requires a service
restart; retained sessions keep their admitted limits rather than silently receiving new ones.

| Parameter | Effect |
| --- | --- |
| `hybrid-worker-limits` | JSON matching `SharedWorkerLimits`: resident sessions, global/per-principal active turns, queue size/wait, retained-session count, global/per-principal containers, and per-harness resident sessions, active turns, and queued turns (`residentSessionsPerHarness`, `activeTurnsPerHarness`, `queuedTurnsPerHarness`, with overrides by harness name in `harnesses`) |
| `hybrid-session-limits` | JSON matching `SharedSessionLimits`: ceilings for aggregate and per-turn tokens, turn deadline, idle time, total/parallel jobs, and automatic continuations; a session also stays within its harness's limits and policy |
| `hybrid-executor-image` | Prebuilt operator-selected image, resolved to an immutable local image ID before allocation |
| `hybrid-harnesses` | Published batch harnesses that a shared harness's `shared:delegate-job` binding may run; version/digest snapshot retained on session creation |
| `mcp-secret-<reference>` | One secret per `auth.secret` reference in the policy's remote MCP catalog, declared only when the catalog uses it |
| `hybrid-principals` | API-principal to numeric GitHub account map; retained principals cannot be rebound |
| `session-containers` | `true` adds per-session containers for `isolated` conversation harnesses ([below](#session-containers)); requires `hybrid-hosting` |
| `session-container-image` | Prebuilt session-container image, resolved to an immutable local image ID; default `copilot-session-container:local` |
| `session-container-settings` | JSON matching `SessionContainerSettings`: idle seconds, allocation lifetime, startup and shutdown limits, heartbeat interval |
| `orchestrator-workers` | `true` lets `orchestrator` conversation harnesses start workers in session containers ([below](#orchestrator-workers)); requires `session-containers` |

For example, `{"executionContainers":1,"activeTurns":2,"residentSessions":16}` limits child execution to
one physical allocation while permitting two model turns. By default one harness can hold at most 12 resident
sessions, one running turn, and 24 queued turns, so a busy harness cannot starve the others; for example,
`{"activeTurns":4,"harnesses":{"shared-researcher":{"activeTurns":2}}}` lets that harness run two turns at once.
A per-harness value never exceeds the matching worker-wide limit.

By default a conversation may use 500,000 tokens, and each turn up to 100,000 tokens and 300 seconds. Every model request
in a turn resends the conversation, about 4,200 tokens of base prompt plus the turn's tool results so far, so real turns
of a few tool calls with a real model used 21,000 to 38,000 tokens. Lower these for tighter cost control, or raise the
turn budget for turns with many large tool results; a harness's own limits and its policy still apply. Starting and retiring allocations count too;
failed deletion does not free capacity. Zero containers disables new allocation without discarding queued
jobs. Warm pooling is deliberately not offered: the implemented mode retires one-shot containers.
Session containers count against the same `executionContainers` and `containersPerPrincipal` limits as jobs.
The exact defaults and ranges live in [`shared.ts`](../contracts/src/shared.ts) and
[`session-container.ts`](../contracts/src/session-container.ts).
Controller CPU/memory/startup settings live in [`artifacts.ts`](../contracts/src/artifacts.ts) and can be
supplied through `EXECUTION_CONTAINER_SETTINGS` when hosting that service directly.

### Session containers

A session created with an `isolated` conversation harness runs in its own resumable container
([architecture](ARCHITECTURE.md#session-containers)). Build the image from the same verified native Linux
bundle as the shared worker, built at the runtime and hosting revisions in
[hybrid runtime qualification](DEVELOPER-GUIDE.md#hybrid-runtime-qualification): workers' approval modes and
inherited human authority need them, and an older bundle lacks them. The image needs no customer configuration
because each container receives its session's admitted harness snapshot:

```powershell
# The bundle directory that deploy\build-hybrid-runtime.ps1 produced at the required revisions.
docker build -f deploy\SessionContainer.Dockerfile `
  --build-context runtime=C:\path\to\verified\linux-bundle `
  -t copilot-session-container:local .

aspire secret set "Parameters:session-containers" "true"
aspire secret set "Parameters:session-container-settings" '{"idleSeconds":900}'
```

Add `--build-arg NPM_REGISTRY=<approved proxy>` if required. The AppHost passes the settings to the API,
dispatcher, controller and shared worker, and the principal binding, container limits and `hybrid-session-limits` to the API,
which applies that parameter's token-budget and turn-deadline ceilings to container sessions as the shared worker
does; the container's idle stop comes from `session-container-settings`. The container size
comes from the effective policy's hosting size catalog (`hosting.sizes`, `hosting.defaultSize`, default the
smallest size) and maps to Docker `--cpus` and `--memory`. Allow the harness's built-in tools and permission
modes in policy as usual.

With session containers enabled the shared worker can also [promote](ARCHITECTURE.md#promotion) conversations of
`promotable` harnesses into these containers, one way. Allow `promotable` in the policy's `hosting.modes` and the
harness's promotion approval in `hosting.promotion.approval`; the promoted container uses the harness's
`hosting.promotion.size`. Promotable harnesses connect like shared ones (`pnpm host:connect --harness <name>`), and the
launcher stays attached so the terminal follows the move. Promoted sessions keep their volumes like other container
sessions. A [handoff](API.md#handoffs) from a shared conversation to an `isolated` target moves it the same way into
the target's own container, which uses the policy's default size and counts against the same container limits;
without session containers such a target is refused.

Connect with the launcher. When the harness's hosting mode is `isolated`, it uses your own
[owner host](#per-harness-owner-hosts) for that harness if one offers the transport; otherwise, when session
containers offer it, it creates the session through `/v1/sessions` and attaches to its container. A named harness
never falls back to the demo host. Resume with the application session UUID it prints:

```powershell
pnpm host:connect --harness <isolated-conversation-harness> --target local --transport direct --cli C:\path\to\matching\dist-cli\index.js
pnpm host:connect --harness <isolated-conversation-harness> --target local --transport direct --resume <session-uuid> --cli C:\path\to\matching\dist-cli\index.js
```

The first connection waits for the container to report its listener ready. A container stops after the idle
period or its maximum lifetime and the next connection resumes the session from its volume. Closing the
session retires the container and releases its volume, but nothing deletes volume data. List and remove
retained volumes explicitly once their retention period ends:

```powershell
docker volume ls --filter label=copilot.hybrid.managed=volume
docker volume rm <volume-name>
```

The container's ingress is published on host loopback for the connection broker, which consumes each client's
one-use ticket and forwards with the allocation's ingress credential; clients never connect to the container
directly. It holds only its allocation and ingress credentials: no database, Docker, signing, provider, broker, or
relay credential. A local gate has exercised a real CLI attaching through the broker over direct WSS, synthetic
inference, idle stop, resume with history and files intact, and capacity returning to zero. This is not Azure or
paid-model evidence.

### Orchestrator workers

An `orchestrator` conversation harness runs its coordinator on the shared worker, which starts each worker in its
own session container ([architecture](ARCHITECTURE.md#orchestrator-workers)). Workers use the same
[session-container image](#session-containers), so rebuild it from the same verified bundle after upgrading; the
controller selects the worker supervisor for worker allocations. Enable them alongside session containers:

```powershell
aspire secret set "Parameters:session-containers" "true"
aspire secret set "Parameters:orchestrator-workers" "true"
```

The AppHost then advertises worker containers in the [hosting views](API.md#hosting-views), enables the
[worker routes](API.md#orchestrator-workers) on the API and dispatcher, and generates a persisted
`shared-files-key` that only the shared worker and the execution controller's file service hold. Size each
worker through the policy's `hosting.sizes` and `hosting.workers` ceilings and the coordinator harness's
`hosting.workers` block; crafted workers also need a `hosting.crafting.templates` entry. Workers count against the
same `executionContainers` and `containersPerPrincipal` limits as jobs and session containers.

The examples include the coordinator `hybrid-orchestrator`, whose policy override allows orchestrator hosting,
inherited human authority, and a `notes` crafting template, and its two worker harnesses: `hybrid-builder`
(`manual` approvals) and `hybrid-reviewer` (`assisted`, judged by `grok-4.6`). Copy them into an existing workspace
as described [above](#experimental-local-hybrid-deployment), then connect like a shared harness:

```powershell
pnpm host:connect --harness hybrid-orchestrator --target local --transport direct --cli C:\path\to\matching\dist-cli\index.js
```

Worker approvals and questions do not appear in the CLI. Answer them through the session's
[input requests](API.md#orchestrator-workers) while the coordinator tells you what each worker is waiting for.

A worker's private volume and a conversation's shared volume are retained like session volumes: released when
the worker stops or the coordinator closes, never deleted. File-service helper containers carry the
`copilot.hybrid.managed=files` label and are removed after each operation. Workers are reachable only through
their coordinator; there is no client attachment or relay for a worker. The local gate used synthetic
inference; this is not Azure or paid-model evidence.

### Shared worker container

The same worker is packaged independently; it is not the old singleton `agent-host` image. Build it from a
verified native Linux bundle at the runtime and hosting revisions in
[hybrid runtime qualification](DEVELOPER-GUIDE.md#hybrid-runtime-qualification), which approval modes need; the
bundle's `provenance.json` records its revisions:

```powershell
# The bundle directory that deploy\build-hybrid-runtime.ps1 produced at the required revisions.
docker build -f deploy\SessionHost.Dockerfile `
  --build-context runtime=C:\path\to\verified\linux-bundle `
  --build-context customer-config=.copilot-agent-workspace `
  -t copilot-hybrid-session-host:local .
```

The separate `customer-config` context supplies reviewed harnesses/policy without editing shipped
examples. Use `--build-context customer-config=examples/customer-config` only for a synthetic sample
image. Do not put credentials in that context. Alternatively mount an operator-managed `/config`
read-only and set `CONFIG_ROOT` at runtime. `PLATFORM_ROOT` remains `/platform`.
Configure the same database, dispatcher/gateway URLs, worker key, broker key (`CONNECTION_BROKER_KEY`),
principal, delegation-harness, limit, and `MCP_SECRET_*` settings as the Node service, plus
`SESSION_CONTAINER_SETTINGS` when it should promote into session containers, and retain `/data`. Set `SHARED_WORKER_URL` to the
container's own URL and `CONNECTION_BROKER_URL` to the broker's, as the AppHost does, so shared web and MCP egress
refuses both listeners. Clients reach the container
only through a connection broker configured with the same broker key and the container's URL as its
`session-host` endpoint; the worker refuses public tickets. The image runs unprivileged and contains
the matching SDK plus native launcher/library and source provenance. It does not include the controller
or receive Docker authority. Shared runtime catalog/anchors still need the retained `/data` root even
though session content is PostgreSQL-backed.

The local gate has exercised a real CLI through the connection broker, an API restart during an attached
conversation, synthetic inference, TypeScript and Python jobs in real Linux
containers, retained file outputs, completion return, and zero remaining containers. This is not a
paid-model performance comparison, two-real-account qualification, or Azure rollout evidence.

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
| `Parameters:demo-host-runtime-dir` | Managed profiles only: relative build-context directory holding a verified Linux runtime bundle from `deploy/build-hybrid-runtime.ps1`, built at the [required revisions](DEVELOPER-GUIDE.md#hybrid-runtime-qualification) (`provenance.json`, `SHA256SUMS`, `copilot-runtime`, `runtime.node`, `sdk.tgz`). The image installs that runtime and its matching SDK in place of the published one. Local runs build for the bundle's architecture, so an arm64 bundle builds natively on ARM64; publishing requires a linux/amd64 bundle. Required for owner hosts |

For production-mode deployment, the corresponding names are `Parameters__demo-host-*`. The configurator forwards
the GitHub credential from the protected local Aspire secret only when the selected target explicitly enables
`github` or `both`; task output redacts it. **Local run** provides a password input that stores this credential
without returning it from the settings API or placing it in a command line.

For managed profiles, the `interactive-demo` example is seeded into new customer workspaces. Existing workspaces are not overwritten:
copy/adapt the example explicitly if it is absent. Its model names still need to match the configured policy and
Foundry deployments. A conversation harness cannot be submitted as a batch job.

### Per-harness owner hosts

Local runs can host several `isolated` conversation harnesses, each on its own always-on, single-owner managed host.
`Parameters:owner-hosts` is a JSON list of at most eight hosts, for example
`[{"harness":"interactive-demo","transport":"both"}]`:

| Field | Meaning |
| --- | --- |
| `harness` | A published `isolated` conversation harness, at most 27 characters so that `host-<harness>` fits 32 |
| `transport` | `direct`, `github` (the relay only), or `both`; execution is always managed, on the local runtime |
| `principal` | The API principal that owns the host and alone receives its connection material; defaults to `dev` |
| `size` | A size from the harness's effective `hosting.sizes`; defaults to the policy's `defaultSize` |

Owner hosts share `demo-host-owner` (their GitHub owner), `demo-host-runtime-dir` (required), and, when any host
enables the relay, `demo-host-github-token`. A harness cannot be served by both the demo host and an owner host.
Each host gets its own container resource `host-<harness>` limited to its size's CPUs and memory, generated
`host-<harness>-key` and, for direct WSS, `host-<harness>-connection-token` secrets, a named volume
`host-<harness>-<checkout>` at `/data`, and, for the relay, its own Mission Control environment named
`Aspire <harness> (<owner>)`. Startup fails closed when the harness's effective policy disallows a configured
transport (`transport_not_allowed`), the harness is not `isolated`, or it needs a feature the host does not
implement. Publishing with owner hosts fails: Azure keeps the single demo host until the Azure stage.

Each owner host is always-on compute and storage, even with no client attached. `GET /v1/hosts` reports each host's
resource and size, so the configurator can show the cost per harness. With `hybrid-hosting` on, clients reach direct
hosts through the connection broker's `/hosts/<harness>` path, which exchanges their one-use ticket for one the host
accepts; otherwise they dial the host's own endpoint. Connect with
`pnpm host:connect --harness <name> --transport direct|github --target local [--resume <id>]`
([user guide](USER-GUIDE.md#demo-agent-host)).

Stopping the AppHost keeps each host's volume and, for relay hosts, its registered environment, which goes offline;
restarting reuses both. Delete an environment you no longer need in Mission Control, and remove a volume only to
discard that host's conversations and identity.

### Demo host compatibility gate

**Deployed managed profiles remain deferred to runtime engineers.** GitHub-native mode uses host-owned sessions and
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

Locally, managed profiles and [owner hosts](#per-harness-owner-hosts) run on a locally built runtime bundle carrying
these changes (`demo-host-runtime-dir`), qualified in the
[stage-3 record](HOSTING-MODES-PLAN.md#stage-3-per-harness-owner-hosts-and-relay); deployed managed hosting still
awaits a released runtime.

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

On October 8, 2026, the signed-in Windows CLI 1.0.92 passed this gate in an interactive terminal and
queried the requested environment. This does not establish eligibility for clean profiles or other accounts.
Non-interactive `-p` is not a relay check: this CLI requires an interactive terminal for `--relay`.

### Native qualification evidence

Local evidence collected on October 5, 2026:

| Surface | Result and limit |
| --- | --- |
| Rebuilt Linux/amd64 host image, without source mounts | Registered with Mission Control, preserved the environment ID and workspace across container replacement, and denied the execution uid access to the supervisor environment |
| Released CLI 1.0.92 used as the SDK server | Completed an authenticated Copilot inference request; this was separate from the relay client |
| Interactive CLI 1.0.92 with a clean profile | Rejected `--relay` as not enabled; interactive end-to-end attachment still requires a normally enabled client |
| Azure deployment and Azure Files | Not deployed or qualified by these local runs |

Azure staging evidence collected on October 9, 2026:

| Surface | Result and limit |
| --- | --- |
| Published/deployed native host | Online in West US 2 with private ingress, `minReplicas: 1`, `maxReplicas: 1`, and an explicit Azure Files SMB mount |
| Interactive relay and Copilot inference | Signed-in Windows CLI 1.0.92 attached and completed a synthetic prompt without feature overrides |
| Real conversation after image/revision replacement | Same Mission Control environment; resumed the same conversation and correctly recalled a synthetic marker from the previous turn |
| Azure Files permissions, atomic write, advisory lock | Execution uid/modes and supervisor environment denial passed; atomic file replacement and competing advisory lock exclusion passed, including successful acquisition after release |
| Azure Files SQLite qualification | **Failed:** a fresh Python SQLite database returned `database is locked` on `PRAGMA journal_mode=WAL`, including with a five-second busy timeout. The storage durability gate remains open despite the successful conversation resume. No `nobrl` workaround was applied. |
| SQLite failure isolation | SMB accepted the shared byte-range lock but rejected its upgrade to an exclusive lock with `EACCES`; the same sequence passed on the container's local disk. Both default rollback-journal writes and WAL setup failed on SMB. The runtime's own `session-store.db` remained zero bytes, so successful JSONL conversation resume did not establish healthy session indexing. |
| Lock-preserving candidate | A separate synthetic database using SQLite's `unix-excl` VFS created and committed WAL data on the same SMB mount. This does not change the released CLI's VFS or qualify crash recovery, process contention, or a custom runtime build. |
| Revision replacement | Single mode reactivated the previous revision during deployment; the new owner failed closed with lease conflict until the old revision was explicitly deactivated again. Final state was one active revision/replica. Automatic rolling replacement is not qualified. |

The corrected storage probe was also run directly in the existing Azure container through its authenticated
exec terminal. Its final diagnostic-only image update was blocked when local Docker Desktop became unavailable;
the prior working host revision was reactivated. Rebuild before using the packaged probe to reproduce the latest
checks. Do not present this environment as fully qualified durable Azure hosting until the SQLite failure is
resolved and the complete storage/restart procedure passes.

SQLite documents the exclusive VFS and its locking behavior in [VFS](https://sqlite.org/vfs.html#standard_unix_vfses);
its [WAL guidance](https://sqlite.org/wal.html) requires all database users to be on the same host.
Do not replace the runtime's default VFS, move its database to ephemeral storage, or treat the candidate as
a durable-storage fix without an explicit runtime design and end-to-end recovery qualification.

An October 10 follow-up still showed `maxReplicas: 1`, but Azure listed two replicas in the active revision:
one ready/running owner and a second waiting replica repeatedly rejected by the host lease with HTTP 409.
Treat the configured maximum
as a scale setting, not proof of a single process during platform replacement; inspect replica state and retain
the host lease/catalog fences. This follow-up did not change the deployed runtime or revision mode.

On the healthy replica, a synthetic `unix-excl` database also passed WAL writes/checkpoint/truncate,
competing-process exclusion (both `unix` and `unix-excl` contenders), lock acquisition after owner close,
abrupt-process-exit recovery with committed rows retained and an uncommitted row discarded, and repeated
reopen/integrity checks. The uniquely named test directory was removed. This is **single-replica synthetic
evidence**, not a qualified runtime build, container replacement, or multi-host locking test. The released
CLI still uses its default VFS and its session-store initialization failure remains unresolved.

The opt-in native test is `tests/integration/github-native-host.test.ts`. It creates and removes its own
Mission Control environment; it does not authorize deleting an existing deployment's environment.

### Storage and revision requirements

Locally the AppHost mounts the named `demo-host-data` volume at `/data`. In Azure, the host's local hosting
integration explicitly provisions a Standard LRS storage account, a 10-GiB-quota SMB share named `host-state`,
and the environment storage binding `demo-host-data`, then mounts it at `/data`. The host depends on that
binding, which depends on the share. These resources live in the host Bicep module rather than relying on
Aspire 13.6's implicit volume output: first enabling that volume on an existing deployment failed with
`No output for volumes_agent_host_0 on resource aca`. Preserve both the volume and PostgreSQL.
The database is not a backup of runtime history or the working tree.
Native state lives under `/data/github-native`; managed state lives under `/data/execution`. Switching profiles
does not convert or merge their conversations. Native conversations are managed through the connected CLI,
not the managed-session budget/close endpoints.

Review the generated storage resources and qualify the actual Azure mount's permissions, file/SQLite locking,
atomic writes, and restart integrity. A working local Docker volume is not proof of Azure Files compatibility.
If that storage cannot satisfy the runtime's requirements, do not claim durable Azure support.

The AppHost's local [hosting integration](../deploy/CopilotAgent.Hosting/HostDeploymentExtensions.cs)
emits `minReplicas: 1`, `maxReplicas: 1`, and `activeRevisionsMode: Single` for every enabled host profile.
This uses Aspire's supported local C# integration mechanism because its built-in TypeScript scale API exposes
only `minReplicas`. The integration is referenced by `aspire.config.json`; do not edit generated `.aspire` files
or rely on a one-time portal override.

Azure Files uses mount-level ownership rather than per-file POSIX `chown`/`chmod`. The host's SMB mount uses
`uid=10001,gid=10001,dir_mode=0700,file_mode=0600,cache=strict`. Byte-range locking remains enabled;
do not add `nobrl` to suppress locking failures. These settings are not proof of runtime durability.

The host lease and catalog reject concurrent owners; they are not an autoscaling strategy. A replica limit
is per revision, and even Single revision mode can overlap old/new replicas during rollout.
Do not use normal rolling traffic splitting against one catalog:
deactivate/drain the previous host revision before starting its replacement. Reconnect clients afterward.
Single mode can reactivate that previous revision during deployment: inspect **all** revisions afterward,
deactivate any reactivated old revision, and require exactly one active replica plus healthy native registration.
The lease must remain fail-closed while an old owner is active; do not bypass it to complete deployment.
Do not delete the host volume during an upgrade.

Changing the expected account is not a supported in-place ownership reassignment. A different numeric account
ID cannot acquire the existing host, including when a login name is reused. A legacy prototype host without a
pinned numeric identity requires an explicit operator-reviewed migration rather than automatic adoption.

For operator and client steps, see [Demo agent host](USER-GUIDE.md#demo-agent-host).

### Qualify the deployed native host

Use a quiet staging target with `github` transport, its normal owner credential, and an eligible interactive
CLI. Do not run the Docker integration suite against the deployed database; its fixture truncates tables.

1. Publish and review the host template. Check private ingress, one replica, the `/data` Azure Files mount,
   and the mount options above. Deploy, then check `GET /v1/host` through the authenticated API for
   `execution: "github-native"`, `online: true`, and a nonempty `environmentId`.
2. Run the storage probe from an interactive PowerShell terminal using a fresh ID:

   ```powershell
   $probe = [guid]::NewGuid()
   .\deploy\Test-HostStorage.ps1 -ResourceGroup $rg -Subscription $subscription -Phase write -ProbeId $probe
   ```

   Require the JSON result `"result": "passed"`; an Azure exec connection alone is not a pass.
   The probe runs as uid 10001, checks private mount permissions and supervisor environment denial,
   atomic file replacement, competing advisory/SQLite write locks, WAL integrity, and recovery of an
   uncommitted write after process exit. It uses only its uniquely named synthetic probe directory.
3. Attach with `pnpm host:connect --target azure --transport github`. Send a synthetic prompt, approve a
   harmless workspace file write, retain the session ID, disconnect, and reconnect to that session.
4. With no active turn, stop the host revision and wait for all its replicas to stop before reactivation:

   ```powershell
   $revision = az containerapp show -g $rg -n agent-host --subscription $subscription --query properties.latestReadyRevisionName -o tsv
   az containerapp revision deactivate -g $rg -n agent-host --subscription $subscription --revision $revision
   az containerapp replica list -g $rg -n agent-host --subscription $subscription --revision $revision -o table
   # Wait for the replica list to be empty before activating.
   az containerapp revision activate -g $rg -n agent-host --subscription $subscription --revision $revision
   .\deploy\Test-HostStorage.ps1 -ResourceGroup $rg -Subscription $subscription -Phase read -ProbeId $probe
   ```

5. Require the same environment identity, a healthy host, successful `read` probe, and a resumed CLI
   conversation that retains the prior synthetic context/file and completes another inference turn.
   Finally run the probe's `cleanup` phase with the same ID. Never delete runtime catalogs or an existing
   Mission Control environment as test cleanup.

Record storage and relay/session outcomes separately. A generic SQLite probe does not establish that the
runtime's own catalog/history survives restart; the resumed conversation is required evidence too.

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
- **Native owner credential rejected after deployment.** Validate the saved credential and its expected owner
  without printing the token, then confirm the deployed secret matches. Aspire's persisted Production parameters
  can retain an older value instead of the current environment input. Refresh only the protected owner-credential
  parameter through an operator-reviewed repair of that CLI version's protected deployment state. This
  qualification required updating its migration sidecar as well as the legacy state; changing only the legacy
  JSON was overwritten. Back up state before repair, never print credential values, and do not clear all state
  or rotate unrelated service keys. Use a separate `--environment` for synthetic publish qualification so placeholder credentials cannot enter
  the live deployment state.
