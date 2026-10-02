# Copilot SDK + Aspire

A repository-first agent service for the GitHub Copilot SDK. You configure a harness, keep the code in your
own repository, run it locally with Aspire, and deploy the same application model into your own Azure
subscription.

The platform is TypeScript end to end: the Aspire AppHost, the control-plane services, the contracts, and the
reference agent runner. Agents themselves are pluggable through approved execution profiles. The repository ships
a TypeScript Copilot SDK agent that uses Python tools, and a customer-authored Python Copilot SDK agent, both
running through the same job contract and security boundaries.

See the [architecture and delivery plan](docs/PLAN.md) for the full design and the
[implementation status](docs/PLAN.md#24-implementation-status) for what is built and which gates remain open.

## What is here

```text
apphost.mts                  Aspire TypeScript AppHost (local run + Azure Container Apps deployment)
contracts/                   Versioned schemas: harness, execution profile/policy, jobs, events, runner protocol
src/agent-api                Public job API (submit, list, status, SSE events, cancel, retry) and browser console
src/job-dispatcher           Authoritative job ledger owner: leases, fencing, retries, capability minting
src/inference-gateway        OpenAI-compatible gateway; owns the Foundry identity, enforces job capabilities
src/agent-executor           Claims attempts and runs runners as an unprivileged user with a minimal environment
src/harness-hosting          TypeScript Copilot SDK reference runner (no Aspire dependency)
src/job-store                PostgreSQL ledger and migrations
src/service-defaults         Shared config, logging, HTTP, auth, Postgres, registry, capability helpers
execution-profiles/          Operator-approved runner profiles (node-ts-agent, python-agent sample runner)
harnesses/dataset-analyst    Sample read-only harness with JSON Schema input and output
policy/                      Operator execution policy (ceilings and acknowledged security gaps)
tools/python/                Pinned Python tool packaged into execution images
deploy/Dockerfile            Multi-stage images for every service
http/agent-api.http          VS Code REST Client requests for every endpoint
tests/                       Unit and integration tests (Vitest)
```

## How a job runs

```text
caller --API key--> agent-api --(Postgres ledger)--> job-dispatcher <--claim/heartbeat-- agent-executor
                                                          |                                   |
                                         signs job-scoped capability            spawns runner as uid 10001
                                                          |                                   |
                         inference-gateway <--capability-- runner (Copilot SDK, BYOK provider = gateway)
                                 |
                         own managed identity --> Azure AI Foundry model deployment
```

- The runner never holds a provider credential, a database credential, or a service key. It gets a short-lived,
  job-scoped capability that the gateway verifies, checks for revocation and budget, and swaps for its own Entra
  token. There is no direct-provider fallback.
- The dispatcher owns job state. Attempts are leased and fenced; stale executors cannot report results; read-only
  work is retried after executor loss, and uncertain external effects go to `needs_review`.
- Executors report what they actually enforce. If the operator policy requires a control the executor cannot
  enforce and the gap is not explicitly acknowledged, the executor cannot claim work. Acknowledged gaps are
  recorded on every attempt and shown on the job.

See [docs/RUNNER-PROTOCOL.md](docs/RUNNER-PROTOCOL.md) to plug in another agent implementation and
[docs/SECURITY.md](docs/SECURITY.md) for the enforced boundaries and known gaps.

## Prerequisites

- Node.js 24 (or 22.12+) and pnpm 10
- Aspire CLI 13.6
- Docker (the executor always runs in a Linux container, also locally)
- Azure CLI signed in to the tenant that owns your Foundry resource
- An Azure AI Foundry / Azure OpenAI deployment that serves the OpenAI v1 chat completions API, and the
  `Cognitive Services OpenAI User` (or broader) data-plane role for your developer identity

## Run locally

```powershell
pnpm install
pnpm build

aspire secret set "Parameters:foundry-endpoint" "https://<resource>.openai.azure.com/openai/v1"
aspire secret set "Parameters:foundry-deployments" "<deployment-name>"
# Optional: package proxies used inside image builds
aspire secret set "Parameters:npm-registry" "https://<npm-proxy>/"
aspire secret set "Parameters:pip-index-url" "https://<pypi-proxy>/simple/"

aspire run --apphost ./apphost.mts
```

The AppHost starts PostgreSQL in a container, runs the API, dispatcher, and gateway as Node processes, and builds
and runs the executor container. A dev API key is generated on first run (`aspire secret get "Parameters:dev-api-key"`).

### Job console

Open the `agent-api` URL (from the Aspire dashboard, or the deployed `https://agent-api…azurecontainerapps.io`) in a
browser and paste the API key. The console lists published harnesses, prefills input from the schema's `examples`,
submits jobs with either agent profile, streams live events, renders results in the output schema's order, and can
cancel or retry. It is static, same-origin, and served with a strict Content Security Policy; the key stays in the
page (or in `sessionStorage` if you choose "Keep for this tab"). Set `CONSOLE_ENABLED=false` on `agent-api` to turn
it off.

### REST client

[`http/agent-api.http`](http/agent-api.http) covers every endpoint, including negative checks, for the VS Code
REST Client extension. Put `AGENT_API_URL` and `AGENT_API_KEY` in `http/.env` (git-ignored).

### PowerShell

```powershell
$key = aspire secret get "Parameters:dev-api-key"
$api = "<agent-api URL from the dashboard>"

$body = @{
  harness = @{ name = "dataset-analyst" }
  input = @{
    question = "Which region had the highest average revenue?"
    dataset = @{ name = "sales"; columns = @("region", "revenue"); rows = @(@("north", 120), @("south", 90), @("north", 130)) }
  }
} | ConvertTo-Json -Depth 8

$job = Invoke-RestMethod -Method Post "$api/v1/jobs" -Headers @{ Authorization = "Bearer $key"; "Idempotency-Key" = "demo-1" } `
  -ContentType "application/json" -Body $body
Invoke-RestMethod "$api/v1/jobs/$($job.id)" -Headers @{ Authorization = "Bearer $key" }
```

Add `"profile": "python-agent"` to run the same harness with the customer Python agent.

### Job API

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/jobs` | Submit; optional `Idempotency-Key` header (scoped to the caller) |
| `GET` | `/v1/jobs` | The caller's jobs, newest first (`?limit=`, `?before=<createdAt>`); results omitted |
| `GET` | `/v1/jobs/{id}` | Status, result, error, usage, acknowledged gaps |
| `GET` | `/v1/jobs/{id}/events` | JSON page (`?after=<seq>`) or SSE with `Accept: text/event-stream` and `Last-Event-ID` |
| `POST` | `/v1/jobs/{id}:cancel` | Cancels queued jobs immediately; running attempts are aborted and their capability revoked |
| `POST` | `/v1/jobs/{id}:retry` | Grants one more attempt to a `failed` or `needs_review` job |
| `GET` | `/v1/jobs/{id}/artifacts` | Lists `result.json` for succeeded jobs |
| `GET` | `/v1/harnesses` | Published harnesses with their input and output schemas |
| `GET` | `/` | Browser job console |
| `GET` | `/health`, `/alive` | Readiness (database) and liveness |

## Test

```powershell
pnpm test:unit          # no external dependencies
pnpm test:integration   # starts a disposable postgres:17-alpine container (or set TEST_DATABASE_URL)
pnpm test               # both
```

Integration tests run the real API, dispatcher, gateway, and executor against a fake model upstream and a fake
runner, covering credential replacement, schema validation, fencing, retries, cancellation, and budgets.

## Deploy to Azure

Deployment uses the same AppHost. Inputs come from environment variables (user secrets are only read in
development):

```powershell
az login --tenant "<tenant-id>"

$env:Azure__SubscriptionId = "<subscription-id>"
$env:Azure__Location = "westus2"
$env:Azure__ResourceGroup = "copilot-agent-staging"
${env:Parameters__foundry-endpoint} = "https://<resource>.openai.azure.com/openai/v1"
${env:Parameters__foundry-deployments} = "<deployment-name>"
${env:Parameters__foundry-account} = "<existing Foundry account name>"
${env:Parameters__foundry-resource-group} = "<its resource group>"

aspire publish --apphost ./apphost.mts --output-path ./artifacts/deployment   # review the Bicep
aspire deploy --apphost ./apphost.mts
```

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for what gets created, required permissions, costs, verification,
and teardown.
