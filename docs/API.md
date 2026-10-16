# Job API reference

[Documentation hub](README.md) | [User guide](USER-GUIDE.md) | [Architecture](ARCHITECTURE.md)

This is the caller-facing API served by `agent-api`. Internal dispatcher and inference endpoints are not public
integration APIs. The implementation is in [server.ts](../src/agent-api/src/server.ts), with data contracts in
[jobs.ts](../contracts/src/jobs.ts).

## Authentication

All `/v1/*` routes require a caller API key, supplied as `Authorization: Bearer <caller-key>` or
`X-API-Key: <caller-key>`. An operator configures `API_KEYS` as semicolon-separated `principal:key` pairs.
The AppHost supplies a generated key for principal `dev`.

Jobs, input requests, and idempotency keys are scoped to the principal, not to the browser tab. A job outside the
caller's principal is returned as not found. The console page and health endpoints do not require a key;
loading the page alone grants no access to job data. Caller authentication is currently API-key based, not Entra ID.

## Endpoints

| Method | Path | Response / behavior |
| --- | --- | --- |
| `GET` | `/v1/harnesses` | `{ harnesses }` with published versions, digests, allowed/default profiles, and input/output schemas |
| `GET` | `/v1/hosting` | Read-only [hosting views](#hosting-views): the deployment's hosts and every published harness's effective hosting |
| `GET` | `/v1/hosting/{harness}` | One harness's hosting view; `?version=` selects a published version, otherwise the latest |
| `GET` | `/v1/hosts`, `/v1/hosts/{harness}` | Experimental [agent hosts](#experimental-demo-host-control) with their cost inputs; connection material and sessions are owner-only |
| `POST` | `/v1/jobs` | `202` and a job view on creation; `200` on idempotent replay; `Location` header in both cases |
| `GET` | `/v1/jobs` | `{ jobs, next? }`; newest first, without results |
| `GET` | `/v1/jobs/{id}` | One job view, including result when successful |
| `GET` | `/v1/jobs/{id}/events` | JSON page or SSE stream |
| `POST` | `/v1/jobs/{id}:cancel` | Current job view after cancellation is requested; no body needed |
| `POST` | `/v1/jobs/{id}:retry` | Job requeued with exactly one more attempt; no body needed |
| `GET` | `/v1/jobs/{id}/artifacts` | `{ artifacts }`; structured `result.json` plus retained output files for successful on-demand jobs |
| `GET` | `/v1/jobs/{id}/artifacts/result.json` | The structured result as JSON; `404` unless succeeded |
| `GET` | `/v1/jobs/{id}/artifacts/{artifactId}` | Authorized immutable output bytes from the successful attempt; `404` for another principal or unsuccessful job |
| `GET` | `/v1/input-requests` | `{ requests }` across the caller's jobs |
| `GET` | `/v1/jobs/{id}/input-requests` | `{ requests }` for one job, all states, oldest first, up to 100 |
| `POST` | `/v1/jobs/{id}/input-requests/{requestId}/respond` | Updated input request after a permission decision or answer |
| `GET` | `/` | Optional same-origin browser console |
| `GET` | `/health`, `/alive` | Readiness (database check) and liveness |

## Submit a job

With local hybrid hosting enabled, the operator selects on-demand execution for ordinary submitted jobs
as well as coordinator-delegated jobs. Their job views include `execution: "dedicated"` and their profiles
must advertise `workspace-artifacts`. Callers cannot choose container images, infrastructure parameters,
or allocation credentials. The default deployment retains its existing shared executor pool.

```json
{
  "harness": { "name": "dataset-analyst", "version": "1.1.0" },
  "profile": "node-ts-agent",
  "input": {
    "question": "Which region has the highest average revenue?",
    "dataset": {
      "name": "sales",
      "columns": ["region", "revenue"],
      "rows": [["north", 120], ["south", 90], ["north", 130]]
    }
  },
  "deadlineSeconds": 300
}
```

`harness.name` and `input` are required. Omit the version to select the first version in the server's descending
version list; specify an explicit version for repeatable clients. Omit `profile` to use the harness default.
`deadlineSeconds`, if supplied, is an integer from 10 to 3600 and can only narrow the harness/policy limit.
It limits **each attempt**, not total queue time or wall time across retries. Unknown submission properties are rejected.

Admission validates the input schema, model and profile approval, runner feature support, tool bindings, and
policy ceilings before queuing. The API request body limit is 2 MiB. A job stores the resolved harness snapshot
and digest at admission; later file edits do not change it.

### PowerShell example

```powershell
$api = "<agent-api URL>"
$key = aspire secret get "Parameters:dev-api-key"
$headers = @{ "X-API-Key" = $key }
$body = @{
  harness = @{ name = "dataset-analyst" }
  input = @{
    question = "Which region has the highest average revenue?"
    dataset = @{
      name = "sales"
      columns = @("region", "revenue")
      rows = @(@("north", 120), @("south", 90), @("north", 130))
    }
  }
} | ConvertTo-Json -Depth 8

$submitHeaders = @{ "X-API-Key" = $key; "Idempotency-Key" = [guid]::NewGuid().ToString() }
$job = Invoke-RestMethod -Method Post "$api/v1/jobs" -Headers $submitHeaders `
  -ContentType "application/json" -Body $body
Invoke-RestMethod "$api/v1/jobs/$($job.id)" -Headers $headers
```

For a deployed service, obtain its caller key from the operator instead of the local Aspire secret.

### Idempotency

The optional `Idempotency-Key` header accepts 1-200 visible ASCII characters. Retain the same key and request
when retrying a submission after a network failure. A replay with the same admitted request hash returns the
existing job; a different request under that key returns `409 idempotency_conflict`.

Use a new key for a deliberately new job. Pin the harness version when replaying across publication changes:
omitting it can resolve to a different version. Admission still runs on a replay.

Version labels are not immutable publication records: an operator can change content under the same name/version.
Record/check the returned harness digest for comparisons. The API has no expected-digest submission field;
see [publication semantics](DEVELOPER-GUIDE.md#configuration-publication).

## Job views and pagination

A job view contains `id`, `state`, `harness` (`name`, `version`, `digest`), `profile`, timestamps,
`maxDurationSeconds`, `attempts`, `maxAttempts`, `acknowledgedGaps`, `usage`, and `pendingInputs`, plus
`policyDigest` (the digest of the effective policy — base policy plus any override for the harness — that admitted
the job; absent for jobs admitted before per-harness policy). `acknowledgedGaps` lists the controls the latest
attempt ran without. `usage` contains `inputTokens`, `outputTokens`, and `requests`. `result` is present for a
succeeded detail view; `error` (`code`, `message`) is included for failed, review-needed, or retry-waiting jobs.

The original input, resolved harness snapshot, and selected top-level model are stored but not included in
`JobView`. There are no dedicated public snapshot or attempt-provenance endpoints. Retain submitted inputs and
environment metadata in your client when building comparisons; the
[evidence inventory](PRODUCT-OVERVIEW.md#what-data-is-stored-versus-exposed) distinguishes storage from exposure.

`GET /v1/jobs?limit=25&before=<createdAt>` accepts a limit from 1 to 100 (default 25). Pass the returned `next`
timestamp as `before` for older jobs. This is a timestamp cursor, not a snapshot of a changing collection.

See the [state table](USER-GUIDE.md#understand-the-outcome) for user actions and the
[state diagram](ARCHITECTURE.md#job-state-transitions) for cancellation and retry semantics.

### Measurement limits

`usage.requests` counts recorded nonzero provider usage reports, not every HTTP inference request. Usage reporting
is asynchronous and can fail, so token totals are not a billing-grade ledger or exact in-flight spending cap.
Likewise, `updatedAt - createdAt` can include queueing, retries, human waits, and usage updates; it is not a
dedicated execution-latency metric. There is no built-in pricing catalog, experiment score, or per-model/sub-agent
usage breakdown.

On-demand jobs and shared conversations additionally reserve inference requests durably. A missing usage
report conservatively consumes the request's remaining allowance after recovery; late usage above that
charge is still counted. Stable request IDs deduplicate reports. Reservations prevent fresh parent/child
allowances from being minted without aggregate admission; they are not an exact provider token or dollar cap.
An already-forwarded request can overshoot, and unknown consumption remains explicitly conservative.

## Experimental shared conversations

These routes exist only when `agent-api` is connected to the opt-in shared worker or to session containers.
They are distinct from the singleton `/v1/host` APIs and from job IDs. The operator maps API principals to fixed
numeric GitHub account IDs; clients cannot supply or replace that binding. Retained principals cannot be rebound.

Each session runs one published conversation harness. Creation admits a snapshot of that harness version: its
instructions, prompt mode, model options, skills, sub-agents, tools, limits, and permissions, with the first of its
models that the effective policy approves. A `shared` harness runs on the shared worker, which serves many harnesses
in one runtime; an `isolated` harness runs in its own [session container](#session-containers) when they are
deployed. The [hosting views](#hosting-views) show whether a harness can be created here before you try.

| Method | Path | Behavior |
| --- | --- | --- |
| `POST` | `/v1/sessions` | Body `{ "harness": "<published conversation harness>", "version": "<optional>", "label": "<optional>" }`; the harness's hosting mode decides placement (`shared` on the shared worker, `isolated` in a [session container](#session-containers)). `201` with a retained session, including its harness, mode, placement, and current segment, and `Location`. Does not allocate an execution container or activate a runtime session. |
| `GET` | `/v1/sessions` | `{ sessions }`, up to 100 recent principal-owned sessions, including closed ones |
| `GET` | `/v1/sessions/{id}` | The session view: `harness` (`name`, `version`, `digest`), `mode`, `placement` (`shared` or `container`), the current `segment` (`generation`, `placement`, `harness`, `ahpSessionId`, `startedAt`), a session container's `container` status, admitted model, limits, activity timestamp, closed/online state, used/reserved/remaining budget, and jobs and continuation counts |
| `POST` | `/v1/sessions/{id}/connection` | Body `{ "transport": "direct" }` (the default; `github` returns the harness's hosting error, such as `422 transport_unsupported` for shared hosting). Activate/resume, then return `{ sessionId, destination, transport: "direct", ahpSessionId, url, token, expiresAt, serverKey }` with `Cache-Control: no-store`. `destination` is `shared` or `container`; `url` is the connection broker's `/sessions/{id}` path; resume `ahpSessionId` after attaching |
| `GET` | `/v1/sessions/{id}/jobs` | Child job IDs/states and completion-notification state/error, including `needs_review` |
| `GET` | `/v1/sessions/{id}/handoffs` | `{ handoffs }`: the session's [handoffs](#handoffs), newest first, up to 50 |
| `POST` | `/v1/sessions/{id}/close` | Body `{ "cancelChildren": false }` by default; prevents new work and disconnects runtime residency without deleting retained data |

Connect a WebSocket client to `url` with the ticket in a `tkn` query parameter. The URL belongs to the separate
connection broker, not to `agent-api` or the shared worker, and stays the same for the session. The broker
consumes the ticket and forwards bytes to the session's current placement; restarting `agent-api` does not
close attached connections. Connection tokens are 60-second, one-use tickets bound to the principal, session,
activation epoch, and placement generation. They are not internal AHP listener credentials. A reconnect
requires a new ticket and a trusted server-key pin.
The CLI separately authenticates its matching GitHub identity. Unknown, other-principal, closed, or
account-mismatched sessions return `404`; capacity/budget limits return `429`. The broker answers a missing,
used, expired, or mismatched ticket with `401` and responds `503` when it cannot verify tickets. Successful creation is not
idempotent: retain its returned UUID rather than automatically repeating a lost creation response.

Creation and connection report the [hosting problem codes](#hosting-views) as errors before anything is activated:
an unknown harness or version is `404 harness_not_found`; a batch harness, a mode or transport the policy does not
allow, or (on the shared worker) a reserved tool name or an unimplemented binding or permission handler is `422`; a
harness whose mode needs a host the deployment lacks, or a feature its host lacks, is `409 hosting_unavailable` with
its `prerequisite`; and the GitHub relay for a shared harness is `422 transport_unsupported`. The shared worker
re-checks a session's harness against the current effective policy on every activation, so a narrowed policy
refuses an existing session with the same codes, or with `409 policy_revoked` when its admitted model was removed.
Shared sessions created before harness-driven hosting cannot be activated (`409 invalid_state`); create a new one.

Approvals and questions in a shared session go to the attached client, not to the job input-request API. The
harness's approval mode decides how ([security](SECURITY.md#shared-conversation-approvals)): `manual` prompts the
attached person, `assisted` asks the runtime's LLM judge first, `allow-all` runs requests without asking except
those the harness's permissions deny, and `custom` asks an operator-registered handler. The client can switch only
among the modes the effective policy allows. With nobody attached, a request that needs a person does not run.

If a session's placement changes while a client is attached, the broker closes the WebSocket with code `4301`
and reason `moved` after any frame already in flight. Request a new connection for the same session and
reconnect to the same URL, resuming the `ahpSessionId` the new connection returns. A [handoff](#handoffs) closes
attached clients this way when the target's segment starts. Other closes, such as idle eviction, pass through unchanged.

Idle eviction disconnects the CLI but preserves history/files. Closure does not cancel already-admitted
children unless `cancelChildren` is true. Child outputs remain available through job/artifact endpoints.
If a continuation cannot safely be retried or exhausts its budget, its notification is `needs_review`;
retrieve the job explicitly instead of assuming a successful automatic callback.

Manual `:retry` remains available for ordinary jobs. A delegated child cannot be reopened through that
endpoint after terminal completion: ask the coordinator to make a new explicit submission, which
re-admits aggregate budget, fan-out and completion identity. Policy-approved automatic retries before
terminal completion retain the original reservation and existing uncertain-effects rules.

Files are bounded to one MiB each, 16 outputs and eight MiB total per attempt. Only the final successful
attempt's `outputs/` files are exposed; failed-attempt files are not downloadable. Paths are portable relative
names, artifacts have SHA-256 digests, and downloads use attachment disposition and `nosniff`.
The coordinator can explicitly import an output into its session filesystem; overwriting an existing file
requires its exact current etag. Arbitrary attempt files and runtime history are not exported.

### Handoffs

A conversation harness can hand its conversation to one of its predefined `hosting.handoffs` targets
([hosting modes plan](HOSTING-MODES-PLAN.md#75-handoffs-and-crafted-harnesses)). The agent sees each target as a
`transfer_to_<target>` tool (hyphens become underscores, and names over 64 characters are shortened with a hash)
described by the target's `description`. Its arguments are a `reason` of up to 500 characters and, for `summary`
history, a `summary` of up to 8,000 that the source writes for the target; nothing else is accepted.

Before anything changes, the shared worker checks that the target is still one of the admitted harness's targets, is
a published conversation harness whose own policy allows its mode, is within the source's handoff ceilings
(`hosting.handoffs.approval` and `hosting.handoffs.history` in its effective policy), and can be hosted here. With
`approval: "ask"`, the default, the attached person approves the transfer in the CLI; the LLM judge, custom handlers
and `allow-all` never approve it, and with nobody attached it does not run
([security](SECURITY.md#shared-conversation-handoffs)). A refused or declined transfer fails the tool call and leaves
the source in control. Repeated calls of one tool call return its recorded outcome.

An accepted handoff admits no new turns. When the source's turn ends, the cutover starts the target's segment under
the same application session ID: the session's `harness` and `segment` change, its placement generation increases,
attached clients are closed with `4301` "moved", and the target's first turn is a notice that quotes the source's
reason, and for `summary` its summary, as untrusted data. Reconnect and resume the new `ahpSessionId`.

| History | The target sees | Runtime session (`ahpSessionId`) |
| --- | --- | --- |
| `full` | The whole conversation, under its own instructions and tools | Continues |
| `summary` | The source's summary and reason | New |
| `none` | Only the reason | New |

Without an explicit `history`, a target in the same placement gets `full` and one in another placement `summary`.
History policies filter the conversation only; the session's workspace files stay with it. A handoff never raises the
conversation's aggregate token budget or its job and continuation limits; per-turn limits are the target's. A
conversation in a container never hands off to a harness that runs on the shared worker (`handoff_one_way`).

A target that runs in its own [session container](#session-containers), an `isolated` harness, needs session containers
in the deployment; without them it is refused with `handoff_unavailable`. The conversation then moves one way into a
new container for the target, through the same snapshot, allocation and cutover steps as a promotion:

- The workspace files move, and the runtime history only with `full`; the source's consent files never move.
- The container runs the target's snapshot under session-container rules: the first model its policy approves, the
  policy's default size, its turn deadline, no delegated jobs, and the containers' idle stop. The aggregate token budget
  is never raised.
- While the move runs, `POST /v1/sessions/{id}/connection` returns `409 handoff_in_progress`; retry it, as the launcher's
  supervisor does. When the container is ready the cutover commits, attached clients are closed with `4301`, and the
  next connection returns `destination: "container"` with the target's `ahpSessionId`: the current one with `full`,
  otherwise a new one. The container sends the handoff notice as the target's first turn.
- A move that fails before the cutover leaves the source in control: no container capacity is `handoff_unavailable`,
  and a container that cannot start or restore the snapshot is `handoff_failed`.

Handoffs start only on the shared worker. A conversation that already runs in a container, as an `isolated` harness or
after a promotion, cannot hand off yet: session containers do not implement the `handoffs` feature, so `isolated` and
`promotable` harnesses that list handoffs are `hosting_unavailable` (prerequisite feature `handoffs`). Handoffs from
containers are follow-up work.

`GET /v1/sessions/{id}/handoffs` lists the transfers the tool ran. Each has `id`, `state` (`refused`, `accepted`,
`committed` or `failed`), the `source` and `target` harnesses, `history`, `approval`, `approvedBy` (`person` or
`policy`), `reason` and `summary`, `from` and, once committed, `to` (`generation`, `placement`, `ahpSessionId`),
timestamps, and an `error` with `code`, `message` and an optional `prerequisite`. A target that is refused before a
person would be asked, and a transfer the person denies, fail the tool call without a record.

| Code | Meaning; the source stays in control |
| --- | --- |
| `handoff_not_allowed` | Not one of the source's targets, not a published conversation harness, or its mode, the approval or the history is outside current policy |
| `handoff_unavailable` | This deployment cannot host the target; `prerequisite` names what it lacks |
| `handoff_one_way` | The target runs on the shared worker and the conversation runs in a container |
| `handoff_declined` | The handoff needs a person's approval and no person approved it |
| `handoff_busy` | Another handoff or a promotion of the conversation is in progress, or an orchestrator coordinator's workers have not stopped; archive them first |
| `session_changed` | The conversation closed or moved while the handoff was in progress |
| `handoff_failed` | The cutover, or the move into the target's container, could not complete |

A handoff that fails after it was accepted also tells the source agent, in a system turn, why it did not happen. While a
handoff is open, `POST /v1/sessions/{id}/promote` returns `409 handoff_in_progress`.

### Session containers

When session containers are deployed, creating a session for a published `interaction: "conversation"` harness whose
hosting mode is `isolated` (and allowed by its effective policy) places it in its own container. Views keep the
same shape for every placement; a container session has `placement: "container"`, `mode: "isolated"`, and a
`container` status (`state`: `dormant`, `starting`, `running`, `stopping` or `closed`; size, CPUs, memory, idle
seconds and activation count). Its admitted harness snapshot, model, limits and size are retained with the session.
Limits follow the shared worker's rules, including the operator's session ceilings; `idleSeconds` is the
container's idle stop. A container enforces the aggregate token budget and the turn deadline but no separate
per-turn budget, so its `turnTokenBudget` reports the aggregate cap.

The first connection, and the first after an idle stop, starts the session's container and waits up to about
two minutes for it to become ready. Only the `direct` transport is offered; other transports return the hosting
error for that harness. The response has `destination: "container"`, `transport: "direct"`, the connection broker's
`url` like shared sessions, and the current segment's `ahpSessionId`: the session ID, unless a [handoff](#handoffs)
started a new runtime session. The container accepts only connections the broker forwards. Closing retires the
container and releases its retained volume.

| Status | Code | Meaning |
| --- | --- | --- |
| `404` | `harness_not_found` | The harness or version is not published |
| `409` | `hosting_unavailable` | The deployment lacks the host the harness's mode needs (session containers for `isolated`), or the transport needs another host |
| `422` | `policy_rejected`, `hosting_mode_not_allowed` | A batch harness, or a harness that the effective policy rejects |
| `429` | `quota_exceeded` | No container capacity for the deployment or principal, or the retained-session limit |
| `503` | `container_starting` | The container is still starting; retry the connection |
| `503` | `container_unavailable` | The container stopped before becoming ready; the message names the reason |

Container sessions have no delegated jobs, so their jobs route returns an empty list.

## Orchestrator workers

An `orchestrator` coordinator's workers are child sessions of a shared conversation, each with its own harness, size,
and container ([plan, section 7.4](HOSTING-MODES-PLAN.md#74-mode-4-orchestrator-shared-brain-container-workers);
[architecture](ARCHITECTURE.md#orchestrator-workers)). The coordinator runs on the shared worker and manages its
workers with tools; clients attach only to the coordinator. Workers run in session containers when the deployment
enables `Parameters:orchestrator-workers` ([deployment](DEPLOYMENT.md#orchestrator-workers)); without it,
orchestrator harnesses report `hosting_unavailable` with prerequisite `worker-containers` and the lists stay empty.
The routes exist when `agent-api` is connected to the shared worker. Implemented in
[worker-routes.ts](../src/agent-api/src/worker-routes.ts) and the [worker ledger](../src/job-store/src/workers.ts),
with contracts in [workers.ts](../contracts/src/workers.ts).

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/v1/sessions/{id}/workers` | `{ workers }`: the conversation's workers, oldest first, up to 256 |
| `GET` | `/v1/sessions/{id}/workers/{worker}` | One worker, by id or name |
| `GET` | `/v1/sessions/{id}/workers/{worker}/definition` | The worker's recorded harness definition with its `digest`, `source`, crafting `template`, and creating `toolCallId`; `Cache-Control: no-store` |
| `GET` | `/v1/sessions/{id}/input-requests` | `{ requests }`: the conversation's worker approvals and questions; `state` and `limit` as in [approvals and questions](#approvals-and-questions) |
| `GET` | `/v1/worker-input-requests` | `{ requests }` across the caller's conversations |
| `POST` | `/v1/sessions/{id}/input-requests/{requestId}/respond` | A person's answer, with the same bodies as job input requests |

A worker view contains `id` (the worker's own session ID), `sessionId`, `name`, `source` (`listed` or `crafted`),
`harness` (name, version, digest), `template`, `size` and `resources`, `sharedVolume` (`none`, `read-write`, or
`read-only`), `approvalMode`, `inheritsHumanAuthority`, `state` (`starting`, `working`, `idle`, `needs_input`, or
`stopped`), `stopReason` (`archived`, `idle_timeout`, `max_lifetime`, `budget_exhausted`, `coordinator_closed`, or
`failed`), `result` (the final message of its latest completed turn, up to 16,000 characters: untrusted model output),
`error`, `usage` (`tokenBudget`, `tokensUsed`, `turns`, `containerSeconds`), `pendingMessages`, `pendingInputs`,
`capacityReleased`, and timestamps including `expiresAt` (its maximum lifetime).

The ledger enforces these rules:

- Workers, their definitions, and their requests belong to the conversation's principal; other principals receive
  `404`.
- A worker holds capacity from creation until the execution controller retires its container allocation
  (`capacityReleased`), so starting, running, and stopping workers all count against the coordinator harness's
  per-conversation and per-principal ceilings and the deployment's ceiling. Its allocation is requested when it is
  created and also counts against the deployment's execution-container limits.
- A worker reserves part of the conversation's aggregate token budget, always leaving the coordinator one turn's
  budget, and its usage is charged to the conversation when its capacity is released.
- A worker stops at its maximum lifetime, when its reservation is used up, or after its idle time, and all of a
  conversation's workers stop when it closes. A worker whose container stops while it is running has failed. A
  stopped worker keeps its record and volumes; nothing is deleted automatically.
- Worker approvals and questions come from the worker's current turn and wait for a person until they expire (the
  worker harness's `permissions.timeoutSeconds`, default 600, never past the worker's lifetime). A request ends when
  its turn ends. A coordinator never answers a permission request. When the coordinator's policy sets
  `hosting.workers.allowCoordinatorAnswers`, it may answer questions, shown as `answeredBy: "coordinator"`; answers
  through this API show `answeredBy: "principal"`.
- A crafted worker's definition is recorded and never published. The configurator's **Import** dialog opens a
  definition export as an unsaved draft ([configurator](CONFIGURATOR.md#editing-harnesses)).

## Hosting views

`GET /v1/hosting` and `GET /v1/hosting/{harness}` report where each published harness's agent loop would run and
whether this deployment can host it, from the harness's optional `hosting` block, its effective policy (the base
policy plus any override), and the hosts the deployment provides. They are read-only: they create no session, issue
no connection material, and change nothing. Any authenticated principal can read them; transports are evaluated for
the calling principal. The [hosting modes plan](HOSTING-MODES-PLAN.md) describes the modes. Today conversations run
in `isolated` mode on an optional [agent host](#experimental-demo-host-control) (the demo host or a local per-harness
owner host) or in [session containers](#session-containers), in `shared` mode on the local hybrid worker
([shared conversations](#experimental-shared-conversations)), and in `orchestrator` mode on the shared worker with
[workers](#orchestrator-workers) in session containers; batch harnesses run as jobs.
Implemented in [hosting-routes.ts](../src/agent-api/src/hosting-routes.ts) with contracts in
[hosting.ts](../contracts/src/hosting.ts).

`GET /v1/hosting` returns `{ hosts, harnesses }`. `hosts` lists what the deployment provides: the batch
`executor` (`pool` or `dedicated`), `isolatedHosts` (each managed agent host and the harness it serves, with its
transports), `sharedWorker` (the local hybrid worker), `sessionContainers` (per-session containers, when enabled), and
`workerContainers` (orchestrator workers, when enabled). Each host lists the harness `features` it implements: the
shared worker implements `remote-mcp`, `approval-modes`, `custom-approval`, and `handoffs`, plus `promotion` when
session containers are enabled; worker containers implement `approval-modes`, `crafted-workers`,
`inherited-authority`, and `shared-storage`; agent hosts and session containers implement none.
GitHub-native demo hosting runs Copilot's own sessions rather than a harness, so it adds no isolated host. Owner
principals are not returned.

Each harness view (latest version, or `?version=` on the single-harness route) contains:

| Field | Meaning |
| --- | --- |
| `harness`, `version`, `digest` | The published version evaluated |
| `interaction` | `batch` (runs as jobs on the executor) or `conversation` |
| `mode` | `isolated` (the default), `shared`, `promotable`, or `orchestrator` |
| `placement` | Where the loop starts: `executor`, `container`, or `shared` |
| `status` | `ready`, `not_allowed` (the policy does not allow the mode), `rejected` (another policy, profile, or target problem), or `unavailable` (the deployment lacks a prerequisite) |
| `problems` | Every problem in admission order; each has a `code`, a `message`, an optional harness field `path`, and for `hosting_unavailable` a `prerequisite` (`kind` `host`, `transport`, or `feature`, and its `name`) |
| `transports` | `direct` and `github`, each with `allowed` (policy and mode), `available` (offered to this principal), and the blocking `problem`; empty for batch harnesses |
| `effective` | The harness's request resolved under policy: approval mode, promotion size and approval, worker sizes and limits, handoffs, and approved remote MCP tools |
| `ceilings` | The effective policy's hosting modes, transports, approval modes, permission handlers, size catalog and default size, worker limits, promotion approvals, crafting template names, and MCP server names and tools. Server URLs and secret references are never returned |

Problem codes, and the HTTP status a route uses when it rejects a request for one of them (shared session creation
and connection return them as errors; the hosting views report them with `200`):

| Code | Status | Meaning |
| --- | --- | --- |
| `hosting_mode_not_allowed` | 422 | The effective policy does not allow the harness's mode |
| `transport_not_allowed` | 422 | The effective policy does not allow the transport, or any transport the mode supports |
| `policy_rejected` | 422 | Another field-scoped policy, conversation-profile, or worker or handoff target problem |
| `transport_unsupported` | 422 | The mode does not support the transport; `shared`, `promotable`, and `orchestrator` use direct WSS only |
| `relay_owner_only` | 403 | Only an isolated host's owner principal can use its GitHub relay |
| `hosting_unavailable` | 409 | Allowed, but the deployment lacks the named host, transport, or feature. There is no fallback to another mode |

A `ready` harness can still lack a transport for the caller: the demo host serves only its owner principal (`dev`
in the AppHost), so other principals see `hosting_unavailable` for direct WSS, naming session containers, and
`relay_owner_only` for the GitHub relay. A `ready` shared harness can be created with `POST /v1/sessions` on the
local hybrid worker.

Unknown harnesses or versions return `404 harness_not_found`; an invalid `version` returns `400 invalid_request`.

## Events

Without an SSE Accept header, `GET /v1/jobs/{id}/events?after=<seq>` returns `{ events, next }` with up to 500
events. `next` is the last sequence returned, or the supplied cursor if the page is empty. An event has
`seq`, `at`, and `body`. Sequence numbers come from a ledger-wide counter, so a job's events can have gaps;
retain the returned cursor for that job instead of assuming consecutive values.

With `Accept: text/event-stream`, the same route streams:

```text
id: 1
event: job.queued
data: {"seq":1,"at":"2026-10-05T12:00:00.000Z","body":{"type":"job.queued"}}

```

Resume with `Last-Event-ID: <seq>` or `?after=<seq>`; the header takes precedence. The server sends keep-alive
comments and closes the stream after the job reaches a terminal state. A manually retried job needs a new stream.
Browser clients must use a streaming client that can attach the caller key, not place credentials in the URL.

Events are an allowlisted application contract. By default they cover queued/started/retried/terminal jobs,
sanitized runner activity, and input requested/resolved notifications. `job.queued` carries the admitting
`policyDigest`, and `job.waiting_for_eligible_executor` (`missing`: required controls no polling executor enforces
or the policy acknowledges) is recorded once when a job cannot be claimed. If the executor is explicitly configured
with `JOB_EVENT_DETAIL=full`, runner events can additionally carry bounded SDK detail containing transcript,
reasoning, tool, usage, failure, and sub-agent payloads. Credential-shaped fields are redacted, but arbitrary
prompt or tool text can still contain sensitive data. The API returns only the events persisted for that job and
principal; changing the setting does not add detail to existing events.

Use [`JobEventBody`](../contracts/src/jobs.ts) for the complete discriminated union and
[runner events](RUNNER-PROTOCOL.md#lifecycle) for allowed activity payloads.

These cursors reconnect clients to persisted job events; they do not resume the runner's SDK session. The API
does not expose unsolicited job messages, terminal attachment, a completion webhook, or a workflow scheduler.

## Approvals and questions

`GET /v1/input-requests?state=pending&limit=50` returns pending requests oldest first. `state=all` includes
answered, expired, and cancelled requests, newest first. The default is `pending`; the limit is clamped to 1-100.

Input request views include `id`, `jobId`, `attempt`, `harness`, `state`, `request`, `createdAt`, `expiresAt`,
and optional `response` and `resolvedAt`. Use the server-assigned request `id`, not a runner-local request ID.

Send one of these bodies to the response endpoint:

```json
{ "kind": "permission", "approved": true, "scope": "once" }
```

```json
{ "kind": "permission", "approved": false, "feedback": "Do not install packages." }
```

```json
{ "kind": "question", "answer": "Use the existing dataset." }
```

Permission `scope` is optional: `kind` approves similar requests for the rest of the attempt (the same
non-read-only command names, all file writes, reads in the same folder, the same website host, or the same tool),
not every request of that type and not future jobs or retries. Shell prompts list the covered names in
`commandNames`. Feedback is limited to 2000 characters; answers must contain 1-8000 characters and satisfy
the request's choices/freeform rules. A stale, expired, cancelled, or already answered request cannot be answered
again. The caller cannot extend the request expiry by responding.

## Errors and retry decisions

Application errors use `{ "error": { "code": "...", "message": "...", "details": ... } }`; `details` is optional.

| Status | Typical code | Client action |
| --- | --- | --- |
| `400` | `invalid_request`, `invalid_input` | Correct the request or schema mismatch |
| `401` | `unauthenticated` | Supply the correct caller key |
| `404` | `not_found`, `harness_not_found` | Check the ID, principal, and published harness/version |
| `409` | `idempotency_conflict`, `invalid_state` | Resolve the conflict; refresh state before acting |
| `429` | `quota_exceeded` | Wait for open jobs to settle before submitting more |
| `422` | `policy_rejected` | Choose a supported harness/profile/configuration |

A job's `error.code` can also be `policy_revoked`: the harness's effective policy was narrowed after admission
(for example, a model or profile removed) and the job no longer qualifies when claimed. Resubmit after the
operator restores the policy or the harness changes; the job is not retried automatically.

An HTTP success on submission means the job was accepted, not that the agent succeeded. Read the job outcome.
Manual retry is allowed only from `failed` or `needs_review`, retains input and harness, and does not reset
accumulated token usage. Automatic retries require remaining attempts, a retryable failure, and either
`safeToRetry` or a failure without uncertain effects.

Runnable examples, including negative cases, are in [`http/agent-api.http`](../http/agent-api.http).

## Experimental demo host control

Agent hosts have their own control API, registered when the API is configured with hosts: the local per-harness
owner hosts (`OWNER_HOSTS`) and the single demo host (`DEMO_HOST_OWNER`). Each host serves one harness and belongs
to one API principal: an owner host's configured `principal`, or `dev` for the demo host. These routes do not
turn jobs into resumable conversations, and `/v1/harnesses` continues to list batch harnesses only. Implemented in
[host-routes.ts](../src/agent-api/src/host-routes.ts) with contracts in [host.ts](../contracts/src/host.ts).

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/v1/hosts` | Every host, for any authenticated principal: `harness`, `transport`, `execution`, `owned`, `online`, and the cost inputs `resource` and `size` (name, CPUs, memory). Only the owner also sees `environmentId` and the public `serverKey` |
| `GET` | `/v1/hosts/{harness}` | One host, as above. `404` for an unknown harness; `409 hosting_unavailable` (prerequisite `isolated-host`) when no host serves an isolated harness |
| `GET` | `/v1/hosts/{harness}/sessions` | The owner's managed sessions: ledger IDs, the client-visible `ahpSessionId` once known, harness snapshots, models, budgets, usage, and closed state. Other principals receive `404`; GitHub-native hosts `409 native_host` |
| `POST` | `/v1/hosts/{harness}/connection` | Connection material, below, with `Cache-Control: no-store` |
| `POST` | `/v1/hosts/{harness}/sessions/{id}/close` | Close a managed session (either spelling of its ledger ID) and revoke future inference |
| `GET`, `POST` | `/v1/host`, `/v1/host/sessions`, `/v1/host/connection`, `/v1/host/sessions/{id}/close` | The single demo host, unchanged, for the `dev` principal; other principals receive `404` |

`POST /v1/hosts/{harness}/connection` accepts `{ "transport"?: "direct" | "github", "sessionId"?: string }`. The
transport defaults to `direct` when the host offers it. `sessionId` names a retained managed session to resume, by
ledger ID or AHP session ID. The response is `{ harness, transport, execution, ahpSessionId? }` plus, for `direct`,
`url`, a 60-second, single-use `token`, `expiresAt`, and the host's public `serverKey`, or, for `github`, the
host's own Mission Control `environmentId`. `ahpSessionId` is the ID the CLI resumes with
(`copilot --resume <id>`). The runtime mints its own session IDs, so it is returned only after the host has recorded
the client's ID from its session catalog. The route applies the same hosting evaluation as admission, for this host:

| Request | Response |
| --- | --- |
| The relay, by a principal other than the host's owner | `403 relay_owner_only` |
| Direct WSS, by another principal | `409 hosting_unavailable` with prerequisite `session-containers` |
| A transport the harness's effective policy does not allow | `422 transport_not_allowed` |
| A host that is offline, does not enable the transport, or has not registered its environment or published its key | `409 hosting_unavailable` |
| The GitHub-native demo host, which runs Copilot's own sessions rather than the harness | `409 hosting_unavailable`; use `/v1/host/connection` |
| An unknown or closed session | `404` |

When the deployment runs the [connection broker](#experimental-shared-conversations) (hybrid mode), direct material
for a host whose endpoint the control plane knows points at the broker's `/hosts/{harness}`; otherwise `url` is the
host's own endpoint (and is absent for a deployed demo host, whose endpoint the launcher resolves). Either way, the
ticket opens only that harness's host at its current ownership epoch. The broker exchanges it, through the
dispatcher, for a one-use upstream ticket that the host checks as its own, so the client's ticket never reaches the
host. This is a host route, not `POST /v1/sessions/{id}/connection`: clients create an owner host's sessions on the
host itself, and the relay serves only the host's owner.

`online` means the control-plane ownership lease is active, not that a CLI handshake has succeeded.
Use the host's `/health` for owner-process and initial hosting readiness; it is not a live Mission Control
connectivity probe. Connection material is sensitive: do not log the response or
include token-bearing URLs in recordings. The public server key can be provisioned to a compatible
CLI through this authenticated API; it is not a secret, but its integrity is security-critical.

Each managed host retains at most ten open sessions. Closing frees a slot but does not delete retained files,
runtime history, or backups. The host observes closed sessions on its next heartbeat. Closing is not
instantaneous cancellation of an already forwarded request or rollback of external effects.

Those session limits, snapshots, and inference grants apply only to `execution: "managed"`. With
`execution: "github-native"`, `/v1/host/connection` returns the Mission Control environment ID without a
direct ticket. Copilot owns conversation lifecycle, models, permissions, and billing; the app does not
fabricate managed-session records or Foundry usage for that path.

Hosted-session inference grants are explicitly distinguished from job-attempt grants. They bind the
session, owner, host ownership epoch, models, and expiry. Renewal and host restart preserve the
session's cumulative budget. The gateway still owns Foundry authentication; an inference capability
cannot authenticate a caller to either API.
