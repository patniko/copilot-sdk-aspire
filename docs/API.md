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
| `GET` | `/v1/jobs/{id}/artifacts` | `{ artifacts }`; only `result.json` for succeeded jobs, otherwise an empty list |
| `GET` | `/v1/jobs/{id}/artifacts/result.json` | The structured result as JSON; `404` unless succeeded |
| `GET` | `/v1/input-requests` | `{ requests }` across the caller's jobs |
| `GET` | `/v1/jobs/{id}/input-requests` | `{ requests }` for one job, all states, oldest first, up to 100 |
| `POST` | `/v1/jobs/{id}/input-requests/{requestId}/respond` | Updated input request after a permission decision or answer |
| `GET` | `/` | Optional same-origin browser console |
| `GET` | `/health`, `/alive` | Readiness (database check) and liveness |

## Submit a job

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
`maxDurationSeconds`, `attempts`, `maxAttempts`, `acknowledgedGaps`, `usage`, and `pendingInputs`.
`usage` contains `inputTokens`, `outputTokens`, and `requests`. `result` is present for a succeeded detail view;
`error` (`code`, `message`) is included for failed, review-needed, or retry-waiting jobs.

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

Events are an allowlisted application contract, **not raw SDK events or a full chat transcript**. They cover
queued/started/retried/terminal jobs, sanitized runner activity, and input requested/resolved notifications.
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

Permission `scope` is optional: `kind` approves that permission type for the rest of the attempt, not future
jobs or retries. Feedback is limited to 2000 characters; answers must contain 1-8000 characters and satisfy
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

An HTTP success on submission means the job was accepted, not that the agent succeeded. Read the job outcome.
Manual retry is allowed only from `failed` or `needs_review`, retains input and harness, and does not reset
accumulated token usage. Automatic retries require remaining attempts, a retryable failure, and either
`safeToRetry` or a failure without uncertain effects.

Runnable examples, including negative cases, are in [`http/agent-api.http`](../http/agent-api.http).
