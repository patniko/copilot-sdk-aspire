# User guide

[Documentation hub](README.md) | [Configurator](CONFIGURATOR.md) | [Job API](API.md)

Use this service to submit a task to a published harness, watch its progress, answer any approvals or questions,
and retrieve a structured result. If someone has already deployed the service for you, start at
[Run a job in the console](#run-a-job-in-the-console) with the API URL and your caller key.

## Before you start

For a local stack you need:

| Prerequisite | Why |
| --- | --- |
| Node.js 24 recommended; 22.12+ on the 22.x line also supported | Builds and runs the TypeScript services; see [package engines](../package.json) |
| pnpm 10 | Installs this workspace; use the `packageManager` version in [package.json](../package.json) |
| Aspire CLI 13.6 | Orchestrates local services and Azure deployment |
| Docker running with Linux containers | Hosts PostgreSQL and the executor, including on Windows |
| Azure CLI, signed in to the correct tenant | Supplies the gateway's local model identity |
| An existing Azure AI Foundry / Azure OpenAI deployment | Must serve OpenAI v1 chat completions and have available quota |
| Model data-plane access for your developer identity | `Cognitive Services OpenAI User` or a broader applicable role |

Run `az login --tenant "<tenant-id>"` before starting model-backed jobs. Azure deployment needs additional
permissions described in [Deployment](DEPLOYMENT.md#prerequisites-and-permissions).

The deployment names must agree across the Foundry route, the harness's model choices, and the operator's
allowed models. A deployment is not selected merely by changing the endpoint. Use the configurator's **Model**
and **Policy** settings if your deployment differs from the shipped examples.

## First run with the configurator

From the repository root:

```powershell
pnpm install
pnpm configure
```

1. Open the URL printed in the terminal. It includes a per-launch access token; do not share it.
2. In **Local run**, set the Foundry endpoint, including `/openai/v1`, and deployment names. Use discovery if
   available for your subscription. Set package proxies only if your environment needs them.
3. Choose **Build & start**. In the Aspire dashboard, wait for PostgreSQL and the services to become healthy.
4. In **Try it**, select the local stack and `dataset-analyst`. Start with its example input and the default
   `node-ts-agent` profile.
5. Watch activity until the job succeeds. The result contains an `answer`, `statistics`, and `observations`,
   rather than an unstructured chat transcript.

The configurator terminal must stay open while you use that UI. It is a local authoring tool, not the deployed
job console. Closing it does not delete Azure resources; use [Deployment](DEPLOYMENT.md#tear-down) for teardown.
Detailed editing and run controls are in [Configurator](CONFIGURATOR.md).

## Run locally without the configurator

```powershell
pnpm install
pnpm build
az login --tenant "<tenant-id>"

aspire secret set "Parameters:foundry-endpoint" "https://<resource>.openai.azure.com/openai/v1"
aspire secret set "Parameters:foundry-deployments" "<deployment-name>"
# Optional diagnostics: persists bounded prompts, responses, reasoning, and tool details in job events.
aspire secret set "Parameters:job-event-detail" "full"
# Optional package proxies for executor image builds:
aspire secret set "Parameters:npm-registry" "https://<npm-proxy>/"
aspire secret set "Parameters:pip-index-url" "https://<pypi-proxy>/simple/"

aspire run --apphost .\apphost.mts
```

Skip the optional proxy commands unless you have real proxy URLs. The AppHost runs the API, dispatcher, and
gateway as Node processes; PostgreSQL and the executor run in containers. Get the `agent-api` URL from the
Aspire dashboard and the generated caller key with:

```powershell
aspire secret get "Parameters:dev-api-key"
```

Treat the output as a secret. Do not put it in documentation, screenshots, or committed configuration.

## Run a job in the console

Open the `agent-api` URL in a browser and enter the caller API key, not a service key or a Foundry credential.

1. Choose **New session**, select a published harness/version and an allowed agent profile, and review the input.
2. Submit. The console's "session" represents a durable job; it is not a resumable SDK chat session.
3. Follow the live activity and check **Needs you** for approvals or questions.
4. Expand **Event details** or **SDK details** on an activity row to inspect its persisted JSON.
5. On success, inspect the structured result. API clients can also fetch `artifacts/result.json`.

![Job console showing sessions and requests needing the caller's attention](images/job-console-sessions.png)

The **Sessions** view lists jobs belonging to your API-key principal. The inbox collects that principal's
pending requests across jobs. The key stays in the page, or in `sessionStorage` if you select **Keep for this tab**.
An operator can disable the console with `CONSOLE_ENABLED=false` on `agent-api`; the API remains available.

Every activity row exposes the allowlisted event JSON. Full SDK detail is disabled by default. To enable it for
new local attempts, set `Parameters:job-event-detail` to `full`, then rebuild/restart the executor. Full capture
persists bounded job inputs, prompts, assistant and reasoning messages, tool arguments/results, usage, failures,
and sub-agent events in PostgreSQL. The runners redact credential-shaped fields, but cannot identify every secret
embedded in arbitrary text; use this mode only in an access-controlled diagnostic environment. Set the parameter
back to `sanitized` and restart the executor to disable it.

### Choose a harness

| Sample | Use it for |
| --- | --- |
| [`dataset-analyst`](../harnesses/dataset-analyst/harness.json) | Read-only tabular analysis using a packaged Python statistics tool |
| [`text-summarizer`](../harnesses/text-summarizer/harness.json) | A minimal structured-answer example without custom tools |
| [`insights-team`](../harnesses/insights-team/harness.json) | Customized prompt sections, sub-agents, a delegated-only tool, and a skill |
| [`copilot-coding-agent`](../harnesses/copilot-coding-agent/harness.json) | Coding in an attempt workspace with built-in tools and human approvals |

Use the published input schema and its examples rather than assuming every harness accepts a `prompt` field.
The `python-agent` profile runs the same job contract with a Python SDK implementation; a Python **tool** does not
require a Python **agent**.

**Coding jobs do not edit your local checkout automatically.** Each attempt gets a temporary workspace inside
the executor. That workspace is removed afterwards. Only the structured result is exposed as an artifact today;
there is no general file upload/download, platform-managed checkout, or commit/push workflow.

The coding sample accepts an optional public `repository` URL and instructs the agent to clone it using its tools,
subject to permissions. That is not a managed checkout or private-repository credential service. Ask for the patch
or file contents in the structured result if you need them after cleanup; see
[coding tasks and artifacts](PRODUCT-OVERVIEW.md#coding-tasks-and-artifacts-an-important-boundary).

### Approvals and questions

Review the displayed command, path, diff, or URL before approving. Agent-supplied descriptions are not a guarantee
that an action is safe. Prefer a one-time approval; **kind** approval covers later requests of the same type for
the remainder of that attempt. You can deny a request with feedback for the agent.

Requests normally expire after 600 seconds, bounded by the harness setting and the attempt deadline. Waiting
does not pause the deadline or release the executor slot. Expired permissions are denied; the job may continue or
fail depending on the task.
The job remains `running` while waiting: there is no separate `waiting_for_input` job state.

Only the job's caller principal can answer. Sharing an API key also shares the ability to see jobs and approve
actions. See [API input requests](API.md#approvals-and-questions) for remote clients.

You can reopen the console and reconnect to a server-side job with the same caller identity. You cannot send
unsolicited mid-run chat, attach a terminal, or resume an SDK session after the attempt ends. The
[interaction matrix](PRODUCT-OVERVIEW.md#supported-interaction) distinguishes these capabilities.

### Understand the outcome

| State | Meaning and next action |
| --- | --- |
| `queued` | Waiting for an eligible executor slot |
| `running` | An attempt is active, possibly waiting for your input |
| `retry_wait` | An automatic retry is scheduled after backoff |
| `cancel_requested` | Cancellation recorded; the active attempt is being stopped |
| `succeeded` | A schema-valid result is available |
| `failed` | No more automatic attempts will run; inspect the error before retrying |
| `cancelled` | The job has stopped; cancellation is not an undo of external effects |
| `needs_review` | An uncertain external effect may have occurred; investigate before explicitly retrying |

**Retry** is available only for `failed` and `needs_review`. It grants one additional attempt on the same job,
with the admitted harness snapshot and input, but a fresh workspace. It does not resume a conversation or undo a
previous action. Submitting a new job is how you use edited input or a newly published harness.

Cancellation and completion can race; a recorded successful result may still win. Read back the job's final state
rather than treating the cancel response as proof of rollback. [Architecture](ARCHITECTURE.md#job-state-transitions)
explains the transitions.

## Create or change a harness

Use **Harnesses** in the configurator to choose a template, define schemas and instructions, select approved
models/profiles, and set tools, permissions, and limits. Start without built-in tools; enable only what the task
needs. A harness requests capabilities but cannot override operator policy.

Save and increment the version when changing published behavior. For local harness-only edits, **Reload harnesses**
restarts the API so new submissions see the change. Existing jobs keep their admitted snapshot. Policy, runner,
or tool changes need the broader restart/rebuild described in
[Configuration publication](DEVELOPER-GUIDE.md#configuration-publication).

Commit the harness and policy files after review. Do not commit local keys or deployment settings.

## Repeated runs and comparisons

Submit separate jobs to run several invocations of the same harness concurrently. Each receives its own input,
attempt, runner, and result; sub-agents remain part of their parent attempt rather than becoming independent
jobs. Capacity is bounded by executor slots, policy, and model quota. See
[current configured limits](PRODUCT-OVERVIEW.md#current-configured-limits) before submitting a batch.

There is no built-in experiment runner, scorer, or comparison dashboard. An external script can submit a case set
to preserved harness candidates, retain the input and trial-to-job mapping, collect results, and score them
independently. Use a new idempotency key for each intended trial, pin a version, and record/check its returned
digest: version labels alone do not enforce immutable content.

Schema-valid output is not proof that an answer is correct. Usage is not billing-grade accounting, and a job's
timestamp difference is not pure execution time. Follow the
[comparison methodology](PRODUCT-OVERVIEW.md#5-can-it-version-configurations-run-comparisons-and-store-results)
for reproducibility and evidence limitations.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Configurator says its token is invalid | Reopen the current URL from its terminal; a prior launch URL is stale |
| `401 unauthenticated` | Use the caller key for that stack, with the authentication format in [API](API.md#authentication) |
| `400 invalid_input` | Match the selected harness version's input schema |
| `422 policy_rejected` | Inspect allowed models, profiles, bindings, capabilities, and permission modes; do not weaken controls to force acceptance |
| Job stays queued | Check dispatcher/executor health, capacity, profile eligibility, and executor logs in Aspire |
| Executor says it is not eligible | A required control is unavailable; review [Security](SECURITY.md), not just the harness |
| Model access fails | Check the signed-in tenant, model data-plane role, endpoint, deployment name, and quota |
| Job waits or hits its deadline | Check the approvals inbox and the harness duration limit |
| Saved files do not affect new jobs | Reload the local API for harness edits; rebuild/redeploy baked configuration in Azure |
| Package feeds are blocked | Use your approved proxies; see [Deployment troubleshooting](DEPLOYMENT.md#troubleshooting) |

For API automation, use the [API reference](API.md) and [REST Client requests](../http/agent-api.http).
For Azure, follow [Deployment](DEPLOYMENT.md); local user secrets are not deployment inputs.
