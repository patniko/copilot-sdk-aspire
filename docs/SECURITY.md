# Security model

This document lists the boundaries the reference implementation enforces today, how each was verified, and the
gaps that remain. Gaps are explicit: a requirement the execution target cannot enforce must be acknowledged in
[`policy/execution-policy.json`](../policy/execution-policy.json), or executors on that target cannot claim work.

## Enforced boundaries

| Boundary | Mechanism | Verified by |
| --- | --- | --- |
| No provider credential in execution | Runners get a job-scoped HS256 capability (attempt, principal, models, token budget, expiry). The gateway verifies it, checks revocation and budget with the dispatcher, strips every caller header, and attaches its own Entra token. | `tests/unit/gateway.test.ts`, end-to-end test, live run against Foundry |
| No direct-provider fallback | Routes come from trusted configuration only; HTTPS required; no credentials in URLs; redirects refused; authorization failures fail closed. | `tests/unit/gateway.test.ts` |
| Least-privilege model access | Only the gateway's managed identity holds `Cognitive Services OpenAI User`, scoped to the one Foundry account. | Generated Bicep (`inference-gateway-roles-foundry`) |
| Runner process isolation | Runners execute as an unprivileged user dedicated to their executor slot (uid 10001–10008), with a private 0700 workspace and an allowlisted environment (PATH, HOME/TMP in the workspace, locale, non-secret profile settings). Concurrent attempts on one executor cannot read each other's workspaces. The executor's environment, including its dispatcher key and the platform identity header, is unreadable to the runner. | Container inspection of a live runner and Copilot runtime process |
| Executor holds no data or provider access | The executor has no database reference, no Azure role, and no ingress; it authenticates to the dispatcher with one service key. | Generated Bicep (`agent-executor`) |
| Authoritative, fenced job state | Leases with random lease tokens; heartbeats, events, and completion are rejected for stale owners; lost leases are retried only for read-only harnesses, otherwise `needs_review`. | `tests/integration/job-store.test.ts` |
| Cancellation and revocation | Cancel revokes the attempt's capability immediately, signals the executor, and the runner aborts its SDK session; unresponsive runners are killed. | Integration test, live run |
| Output validation | Results must match the harness output schema in the runner and again in the executor. | End-to-end test |
| Caller isolation | API keys map to principals; every read and write is scoped to the principal, including idempotency keys. | `tests/integration/job-store.test.ts` |
| Policy cannot be widened by callers | Effective limits are the intersection of harness, operator policy, and caller request; profiles, models, and tool bindings must be approved. | `tests/unit/admission.test.ts` |
| No payload logging | Services log identifiers, outcomes, and token counts; auth headers and query strings are redacted. Raw SDK events are never forwarded; runner events are an allowlisted contract. | Code review, `tests/unit/contracts.test.ts` |
| Copilot SDK lockdown | `mode: "empty"`, explicit tool allowlist, configuration discovery and custom instructions disabled, per-attempt `COPILOT_HOME`. Built-in tools are off unless the harness enables groups the policy allows; every SDK permission request follows the harness rules and is denied by default. | Reference runner and Python sample, `tests/unit/runner-permissions*.test.ts` |
| People in the loop | Permission requests and questions from `ask` rules are stored by the dispatcher (fenced by the attempt lease) and answered only through the authenticated API by the job's principal. The runner cannot answer its own requests. Unanswered requests expire and are denied; requests are cancelled when the attempt ends. Agent-generated request content is rendered as text. | `tests/integration/*input*`, job console |
| Policy ceilings for tools and approvals | The operator policy lists the built-in tool groups and permission modes (`ask`, `allow`) harnesses may use; admission rejects anything else. | `tests/unit/admission.test.ts`, configurator validation |

## Known gaps

| Gap | Current state | Path to close |
| --- | --- | --- |
| Egress is not enforced | Acknowledged (`egress-not-enforced`) and recorded on every job. Runners can open arbitrary outbound connections; they hold no credentials besides their capability. This matters more for harnesses with shell or web tools: an approved (or `allow`ed) command can reach the internet and internal endpoints. | Dedicated execution environment with NSG/UDR or firewall egress rules, Dynamic Sessions egress control, or a network namespace that only forwards to the gateway, then remove the acknowledgement. |
| `allow` (yolo) permissions | When the policy allows it, a harness can approve shell commands, file writes and web access without review. The blast radius is the attempt's workspace, the runner user's view of the container, and the network (see egress). | Keep `allow` out of the policy for shared deployments; prefer `ask`. Per-job sandboxes would bound it further. |
| Approver identity | The person who can answer a request is the job's principal (its API key). There is no separate approver role yet. | Entra ID callers and an approvers list per harness. |
| Copilot runtime OS sandbox not enabled | The runtime sandbox is not exposed through the public SDK API used here, and its Linux prerequisites have not been probed on Container Apps. | M0 compatibility probe on the target compute; enable before untrusted initialization once supported. |
| Executor runs as root | Required to launch runners under another uid. A compromised executor can reach its dispatcher key. | Run with only `CAP_SETUID`/`CAP_SETGID` where the platform allows, or move execution to per-job sandboxes. |
| Shared registry identity on the executor | The executor app carries the environment's AcrPull identity. The runner cannot use it (no identity header in its environment). | Separate pull identity per app, or image pull without an attached identity. |
| PostgreSQL network exposure | Public endpoint with the "allow Azure services" firewall rule; password authentication disabled (Entra only). The API and dispatcher identities are Entra administrators. | Private networking and least-privilege database roles. |
| Service keys are Container Apps secrets | Dispatcher, executor, and gateway keys plus the capability signing key are generated parameters stored as Container Apps secrets. | Key Vault references and a rotation procedure. |
| API keys for callers | Suitable for development and service-to-service use. | Microsoft Entra ID authentication with application authorization. |
| MCP not implemented | Local and remote MCP placements from the plan are not yet available. | Implement with the same capability and gateway model. |
| Single trust boundary per deployment | Principals are isolated in the API and ledger, but share execution infrastructure. | Do not market as cross-customer isolation. |
