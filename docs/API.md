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

| Method | Path | Behavior |
| --- | --- | --- |
| `POST` | `/v1/sessions` | Body `{ "label": "Optional label" }` for the shared coordinator, or `{ "harness": { "name": "...", "version": "optional" }, "label": "..." }` for a [session container](#session-containers); `201` with a retained session and `Location`. Does not allocate an execution container or activate a runtime session. |
| `GET` | `/v1/sessions` | `{ sessions }`, up to 100 recent principal-owned sessions, including closed ones |
| `GET` | `/v1/sessions/{id}` | Session model, limits, activity timestamp, closed/online state, used/reserved/remaining budget, jobs and continuation count |
| `POST` | `/v1/sessions/{id}/connection` | Activate/resume, then return `{ sessionId, destination, url, token, expiresAt, serverKey, ahpSessionId? }` with `Cache-Control: no-store` |
| `GET` | `/v1/sessions/{id}/jobs` | Child job IDs/states and completion-notification state/error, including `needs_review` |
| `POST` | `/v1/sessions/{id}/close` | Body `{ "cancelChildren": false }` by default; prevents new work and disconnects runtime residency without deleting retained data |

Connection tokens are 60-second, one-use tickets bound to the principal/session/activation epoch. They are
not internal AHP listener credentials. A reconnect requires a new ticket and a trusted server-key pin.
The CLI separately authenticates its matching GitHub identity. Unknown, other-principal, closed, or
account-mismatched sessions return `404`; capacity/budget limits return `429`. Successful creation is not
idempotent: retain its returned UUID rather than automatically repeating a lost creation response.

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

### Session containers

With session containers deployed, the views from `GET /v1/sessions` and `GET /v1/sessions/{id}` are the same
shape for every session and add `placement` (`shared` or `container`), `mode`, `segment` (generation,
placement, `ahpSessionId`, start time) and, for container sessions, `harness` (name, version, digest) and
`container` (`state`: `dormant`, `starting`, `running`, `stopping` or `closed`; size, CPUs, memory, idle seconds
and activation count). The harness must be a published `interaction: "conversation"` harness whose hosting
mode is `isolated` and allowed by its effective policy; its admitted snapshot, model, budget and size are
retained with the session.

The first connection, and the first after an idle stop, starts the session's container and waits up to about
two minutes for it to become ready. It accepts an optional body `{ "transport": "direct" }`; other transports
return the hosting error for that harness. The response has `destination: "container"` and
`ahpSessionId` equal to the session ID. Closing retires the container and releases its retained volume.

| Status | Code | Meaning |
| --- | --- | --- |
| `404` | `harness_not_found` | The harness or version is not published |
| `409` | `hosting_unavailable` | The deployment lacks session containers, or the transport or hosting mode needs another host |
| `422` | `policy_rejected`, `hosting_mode_not_allowed` | A batch harness, or a harness that the effective policy rejects |
| `429` | `quota_exceeded` | No container capacity for the deployment or principal, or the retained-session limit |
| `503` | `container_starting` | The container is still starting; retry the connection |
| `503` | `container_unavailable` | The container stopped before becoming ready; the message names the reason |

Container sessions have no delegated jobs, so their jobs route returns an empty list.

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

The optional conversation host has a separate control API. These routes are registered only when
`DEMO_HOST_OWNER` is configured on the API. They require the configured demo principal's caller key
(`dev` in the AppHost); other authenticated principals receive `404`. They do not turn jobs into
resumable conversations, and `/v1/harnesses` continues to list batch harnesses only.

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/v1/host` | Transport, execution kind, active ownership lease (`online`), optional Mission Control environment ID and public server key |
| `GET` | `/v1/host/sessions` | Managed sessions: IDs, harness snapshots, models, budgets, usage, and closed state; `409 native_host` for GitHub-native mode |
| `POST` | `/v1/host/connection` | Explicit connection-material retrieval; `Cache-Control: no-store`; issues a 60-second, single-use direct connection ticket when enabled |
| `POST` | `/v1/host/sessions/{id}/close` | Close a managed session and revoke future inference; `409 native_host` for GitHub-native mode |

`online` means the control-plane ownership lease is active, not that a CLI handshake has succeeded.
Use the host's `/health` for owner-process and initial hosting readiness; it is not a live Mission Control
connectivity probe. Connection material is sensitive: do not log the response or
include token-bearing URLs in recordings. The public server key can be provisioned to a compatible
CLI through this authenticated API; it is not a secret, but its integrity is security-critical.

Managed hosting retains at most ten open sessions. Closing frees a slot but does not delete retained files,
runtime history, or backups. The host observes closed sessions on its next heartbeat. Closing is not
instantaneous cancellation of an already forwarded request or rollback of external effects.

Those session limits, snapshots, and inference grants apply only to `execution: "managed"`. With
`execution: "github-native"`, connection provisioning returns the Mission Control environment ID without a
direct ticket. Copilot owns conversation lifecycle, models, permissions, and billing; the app does not
fabricate managed-session records or Foundry usage for that path.

Hosted-session inference grants are explicitly distinguished from job-attempt grants. They bind the
session, owner, host ownership epoch, models, and expiry. Renewal and host restart preserve the
session's cumulative budget. The gateway still owns Foundry authentication; an inference capability
cannot authenticate a caller to either API.
