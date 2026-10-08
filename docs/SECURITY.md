# Security model

[Documentation hub](README.md) | [Architecture](ARCHITECTURE.md) | [Product boundaries](PRODUCT.md#boundaries-and-open-work)

This document lists the boundaries the reference implementation enforces today, how each was verified, and the
gaps that remain. Gaps are explicit: a requirement the execution target cannot enforce must be acknowledged in the
job's effective policy — the customer workspace's `policy/execution-policy.json` (seeded from
[`examples/customer-config/policy/execution-policy.json`](../examples/customer-config/policy/execution-policy.json))
plus any `policy/harnesses/<harness>.json` override — or no executor on that target claims the job.

The ignored customer workspace is a local configuration boundary, not a secrets vault or an authorization
boundary. Anyone who can modify it before build/start can change admitted harness behavior and operator policy.
Store no credentials there, protect its delivery like application configuration, and review it before deployment.

## Enforced boundaries

| Boundary | Mechanism | Verified by |
| --- | --- | --- |
| No provider credential in execution | Runners get a job-scoped HS256 capability (attempt, principal, models, token budget, expiry). The gateway verifies it, checks revocation and budget with the dispatcher, strips every caller header, and attaches its own Entra token. | `tests/unit/gateway.test.ts`, end-to-end test, live run against Foundry |
| No direct-provider fallback | Routes come from trusted configuration only; HTTPS required; no credentials in URLs; redirects refused; authorization failures fail closed. | `tests/unit/gateway.test.ts` |
| Least-privilege model access | Only the gateway's managed identity holds `Cognitive Services OpenAI User`, scoped to the one Foundry account. | Generated Bicep (`inference-gateway-roles-foundry`) |
| Runner process isolation | Runners execute as an unprivileged user dedicated to their executor slot (uid 10001–10008), with a private 0700 workspace and an allowlisted environment (PATH, HOME/TMP in the workspace, locale, non-secret profile settings). Concurrent attempts on one executor cannot read each other's workspaces. The executor's environment, including its dispatcher key and the platform identity header, is unreadable to the runner. | Container inspection of a live runner and Copilot runtime process |
| Executor holds no data or provider access | The executor has no database reference, no Azure role, and no ingress; it authenticates to the dispatcher with one service key. | Generated Bicep (`agent-executor`) |
| Authoritative, fenced job state | Leases with random lease tokens; heartbeats, events, and completion are rejected for stale owners; lost leases are retried only for read-only harnesses, otherwise `needs_review`. | `tests/integration/job-store.test.ts` |
| Cancellation and revocation | Cancel records capability revocation in the ledger and signals the executor through heartbeat responses; the runner is asked to abort and unresponsive runners are killed. Gateway introspection may be cached for up to 2 seconds; already-forwarded inference and external side effects are not rolled back. | Integration test; `src/inference-gateway/src/dispatcher-client.ts`, `src/agent-executor/src/attempt.ts` |
| Output validation | Results must match the harness output schema in the runner and again in the executor. | End-to-end test |
| Caller isolation | API keys map to principals; every read and write is scoped to the principal, including idempotency keys. | `tests/integration/job-store.test.ts` |
| Policy cannot be widened by callers or harnesses | Effective limits are the intersection of harness, effective operator policy, and caller request; profiles, models, and tool bindings must be approved. The effective policy is the base policy plus an operator-owned override for that harness name; harness definitions cannot select or contain policy. The API refuses to start if an override names an unpublished harness. Jobs record the effective policy digest, and the dispatcher fails queued jobs with `policy_revoked` if a narrowed policy no longer allows them. | `tests/unit/admission.test.ts`, `tests/unit/policy-overrides.test.ts`, end-to-end test |
| Per-job control matching | Executors report what they enforce on every claim. A job is handed only to an executor that enforces each control its effective policy requires or whose missing controls that policy acknowledges; each attempt records the gaps it actually ran with. | `tests/integration/job-store.test.ts`, end-to-end test |
| Payload capture off by default | Services log identifiers, outcomes, and token counts; auth headers and query strings are redacted. Runner events use an allowlisted contract. Optional `JOB_EVENT_DETAIL=full` capture is explicit, bounded, credential-key-redacted, and persisted only in the principal-scoped job event stream. | Code review, `tests/unit/contracts.test.ts` |
| Copilot SDK lockdown | `mode: "empty"`, explicit tool allowlist, configuration discovery and custom instructions disabled, per-attempt `COPILOT_HOME`. Built-in tools are off unless the harness enables groups the policy allows; every SDK permission request follows the harness rules and is denied by default. `ask` mirrors the Copilot CLI defaults: only reads inside the attempt workspace (resolved through symlinks), read-only commands confined to it without redirection or URLs, and read-only MCP tools run without a person. | Reference runner and Python sample, `tests/unit/runner-permissions*.test.ts` |
| People in the loop | Permission requests and questions from `ask` rules are stored by the dispatcher (fenced by the attempt lease) and answered only through the authenticated API by the job's principal. The runner cannot answer its own requests. Unanswered requests expire and are denied; requests are cancelled when the attempt ends. Agent-generated request content is rendered as text. | `tests/integration/*input*`, job console |
| Policy ceilings for tools and approvals | The operator policy lists the built-in tool groups and permission modes (`ask`, `allow`) harnesses may use; admission rejects anything else. | `tests/unit/admission.test.ts`, configurator validation |

## Known gaps

| Gap | Current state | Path to close |
| --- | --- | --- |
| Full diagnostic capture can retain sensitive workload content | When explicitly enabled, prompts, responses, reasoning, tool arguments/results, and SDK metadata are stored in PostgreSQL and returned to the job principal. Key-name redaction and size bounds do not detect secrets embedded in arbitrary text, and there is no per-field classification or separate retention policy. | Keep capture disabled in shared environments; add tenant-managed encryption, retention/deletion controls, content classification, and audit access before broader use. |
| Egress is not enforced | Acknowledged (`egress-not-enforced`) and recorded on every job. Runners can open arbitrary outbound connections; they hold no credentials besides their capability. This matters more for harnesses with shell or web tools: an approved (or `allow`ed) command can reach the internet and internal endpoints. A per-harness override can require or acknowledge egress differently, but no shipped executor enforces it, so requiring it without acknowledgement leaves that harness's jobs queued. | Enforcement must be identical locally and in Azure. Container Apps grants neither `NET_ADMIN` nor user/network namespaces (probed 2026-10-07), so it needs a separately networked executor environment, which the Aspire 13.6 TypeScript AppHost cannot yet wire (see [plan](PLAN.md#per-harness-egress-allowlists-deferred)). Remove the acknowledgement only once both targets enforce it. |
| `allow` (yolo) permissions | When the policy allows it, a harness can approve shell commands, file writes and web access without review. The blast radius is the attempt's workspace, the runner user's view of the container, and the network (see egress). | Keep `allow` out of the policy for shared deployments; prefer `ask`. Per-job sandboxes would bound it further. |
| Approver identity | The person who can answer a request is the job's principal (its API key). There is no separate approver role yet. | Entra ID callers and an approvers list per harness. |
| Copilot runtime OS sandbox not enabled | SDK 1.0.16 exposes it experimentally (`session.rpc.options.update({ sandboxConfig })`), but its Linux backend reports network sandboxing unsupported in the executor container: Docker's default profile and Container Apps refuse the unprivileged user and network namespaces Bubblewrap needs (probed 2026-10-07). | Revisit on compute that permits namespaces; enable before untrusted initialization once supported. |
| Executor runs as root | Required to launch runners under another uid. A compromised executor can reach its dispatcher key. | Run with only `CAP_SETUID`/`CAP_SETGID` where the platform allows, or move execution to per-job sandboxes. |
| Shared registry identity on the executor | The executor app carries the environment's AcrPull identity. The runner cannot use it (no identity header in its environment). | Separate pull identity per app, or image pull without an attached identity. |
| PostgreSQL network exposure | Public endpoint with the "allow Azure services" firewall rule; password authentication disabled (Entra only). The API and dispatcher identities are Entra administrators. | Private networking and least-privilege database roles. |
| Service keys are Container Apps secrets | Dispatcher, executor, and gateway keys plus the capability signing key are generated parameters stored as Container Apps secrets. | Key Vault references and a rotation procedure. |
| API keys for callers | Suitable for development and service-to-service use. | Microsoft Entra ID authentication with application authorization. |
| MCP not implemented | Local and remote MCP placements from the plan are not yet available. | Implement with the same capability and gateway model. |
| Single trust boundary per deployment | Principals are isolated in the API and ledger, but share execution infrastructure. | Do not market as cross-customer isolation. |

## Experimental host boundaries

The optional `agent-host` is a single-trusted-owner demo integration. The table above primarily describes
batch execution; its guarantees must not be transferred automatically to AHP or retained workspaces.
Managed profiles require the [runtime compatibility gate](DEPLOYMENT.md#demo-host-compatibility-gate).
GitHub-native mode uses the released CLI server, host-owned sessions, and existing Mission Control owner binding;
it does not disable a managed-path check to run an unqualified managed session.

Direct connections use an application-API-issued, 60-second, single-use ticket at the public proxy. The
dispatcher atomically checks its digest, owner, host epoch, expiry, and unused state. The separate private
listener credential never leaves the host. This protects discovery too: the underlying AHP host can expose
catalog metadata before GitHub resource authentication. A reconnect needs a new ticket.

The CLI must obtain the server's authentication public key through trusted provisioning and pin the exact
endpoint. Public-key integrity, required sealed authentication, and runtime enforcement of the expected GitHub
account are independent requirements. A token in a URL is not sufficient account authorization. Treat tickets
as secrets despite their short lifetime; do not capture them in command recordings or logs.

Mission Control registers an environment using the configured owner's GitHub credential, after the app verifies
that the credential's numeric GitHub identity matches its pinned owner. Registration and
traffic use GitHub/WPS infrastructure outside the customer Azure deployment. It is a deliberate GitHub-centric
path, not a claim that every byte remains inside an Azure subscription. Native inference goes to GitHub Copilot,
not the Foundry gateway, and uses Copilot permissions and billing. Environment registration alone is not
proof that a particular CLI/account can discover or attach.

The supervisor owns a narrowly scoped dispatcher key; uid-isolated execution receives session capabilities,
not database, signing, or Foundry credentials. The runtime necessarily handles GitHub authentication, and
Mission Control hosting supplies an owner credential. Protect runtime history, configuration, and backups
accordingly; these are not the ephemeral, credential-minimized batch workspaces.

In managed mode, harness restrictions apply to agent tool execution and model use. Native GitHub mode intentionally
does not apply those harness restrictions or Foundry budgets. The AHP protocol also exposes owner-operated
runtime functionality; this demo is not a hostile-caller sandbox or a substitute for a complete authorization
layer. Do not enable arbitrary native SDK TCP access. Egress remains unenforced and the executor's root-launcher,
shared-infrastructure, asynchronous-usage, and in-flight revocation limitations still matter.

Durable storage correctness, single-writer revision handling, account binding, permission arbitration, and
real deployed transport behavior require explicit qualification. No production-hardening, multi-customer
isolation, automatic retention/deletion, or uninterrupted failover is claimed.
