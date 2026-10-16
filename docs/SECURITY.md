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
| Egress is not enforced | Acknowledged (`egress-not-enforced`) and recorded on every job. Runners can open arbitrary outbound connections; they hold no credentials besides their capability. This matters more for harnesses with shell or web tools: an approved (or `allow`ed) command can reach the internet and internal endpoints. A per-harness override can require or acknowledge egress differently, but no shipped executor enforces it, so requiring it without acknowledgement leaves that harness's jobs queued. The [shared-placement egress filter](#shared-placement-egress-and-remote-mcp) covers only requests a shared worker makes through it, not containers. | Enforcement must be identical locally and in Azure. Container Apps grants neither `NET_ADMIN` nor user/network namespaces (probed 2026-10-07), so it needs a separately networked executor environment, which the Aspire 13.6 TypeScript AppHost cannot yet wire (see [plan](PLAN.md#per-harness-egress-allowlists-deferred)). Remove the acknowledgement only once both targets enforce it. |
| `allow` (yolo) permissions | When the policy allows it, a harness can approve shell commands, file writes and web access without review. The blast radius is the attempt's workspace, the runner user's view of the container, and the network (see egress). | Keep `allow` out of the policy for shared deployments; prefer `ask`. Per-job sandboxes would bound it further. |
| Approver identity | The person who can answer a request is the job's principal (its API key). There is no separate approver role yet. | Entra ID callers and an approvers list per harness. |
| Copilot runtime OS sandbox not enabled | SDK 1.0.16 exposes it experimentally (`session.rpc.options.update({ sandboxConfig })`), but its Linux backend reports network sandboxing unsupported in the executor container: Docker's default profile and Container Apps refuse the unprivileged user and network namespaces Bubblewrap needs (probed 2026-10-07). | Revisit on compute that permits namespaces; enable before untrusted initialization once supported. |
| Executor runs as root | Required to launch runners under another uid. A compromised executor can reach its dispatcher key. | Run with only `CAP_SETUID`/`CAP_SETGID` where the platform allows, or move execution to per-job sandboxes. |
| Shared registry identity on the executor | The executor app carries the environment's AcrPull identity. The runner cannot use it (no identity header in its environment). | Separate pull identity per app, or image pull without an attached identity. |
| PostgreSQL network exposure | Public endpoint with the "allow Azure services" firewall rule; password authentication disabled (Entra only). The API and dispatcher identities are Entra administrators. | Private networking and least-privilege database roles. |
| Service keys are Container Apps secrets | Dispatcher, executor, and gateway keys plus the capability signing key are generated parameters stored as Container Apps secrets. | Key Vault references and a rotation procedure. |
| API keys for callers | Suitable for development and service-to-service use. | Microsoft Entra ID authentication with application authorization. |
| MCP partially implemented | Local (stdio) MCP is not available, and remote MCP is available only in shared placement, through the [remote MCP client](#shared-placement-egress-and-remote-mcp) with one service credential per server. Per-user sign-in (OAuth) is not implemented. | Implement local MCP with the same capability and gateway model; extend remote MCP to container placements; add per-user OAuth. |
| Single trust boundary per deployment | Principals are isolated in the API and ledger, but share execution infrastructure. | Do not market as cross-customer isolation. |

## Local authoring boundaries

The configurator's optional [Copilot-assisted authoring](CONFIGURATOR.md#copilot-assisted-authoring) uses a
separate, server-side GitHub Copilot SDK session. It is not a batch job: Foundry gateway credentials, job
capabilities, managed job budgets, uid isolation, and the Demo Host credential do not apply to it.
The existing loopback Host/Origin checks and per-launch configurator token protect `POST /api/authoring/draft`.
Possession of that token authorizes a model request charged to the server-side GitHub identity.

The model receives only the submitted description and an explicit configuration catalog, not automatic
workspace context, instructions, skill bodies, schemas/examples, or settings. This is data minimization, not
secret detection: descriptions and catalog fields may themselves contain sensitive data. GitHub Copilot
inference leaves the local machine; do not describe this feature as a Foundry-only or customer-Azure-only path.
Credentials stay in the SDK process/server environment and are not returned to the browser or placed in prompts.
Raw SDK errors are not logged or returned because they can contain credentials or prompt payloads.

Each request creates an SDK `mode: "empty"` runtime in a temporary working/data directory with a narrow
environment allowlist, no configuration discovery, file hooks, host Git operations, skills, shared session
store, remote session export, or session telemetry. The only exposed tool submits a structured draft;
permission requests are denied. This is tool-surface restriction, not an OS or egress sandbox.
The runtime is stopped and its temporary directory removed when the request ends. A process or machine crash
can leave temporary files; no crash-proof retention/deletion guarantee is claimed.
Requests are limited to one concurrent draft per companion and 90 seconds, including startup; cancellation
stops the request-owned runtime. This is not an exact inference-token or spend cap.

Drafts are validated against existing contracts, effective harness policy and profiles before returning to the
editor. They never update policy or files automatically. New tool code proposals are bounded, inert text:
they can only be viewed/downloaded, never installed, registered or executed by the configurator. They are
not compiled or semantically verified by generation. Normal platform code review, both-runner integration,
tests, image packaging and deployment remain necessary.

## Experimental host boundaries

Agent hosts, the optional `agent-host` and the local per-harness owner hosts, are single-trusted-owner demo
integrations: each host serves one harness for one GitHub owner and one API principal. Several owner hosts in one
deployment share that GitHub owner, so they separate harnesses, leases, volumes, keys, and environments, not tenants.
The table above primarily describes batch execution; its guarantees must not be transferred automatically to AHP or
retained workspaces.
Managed profiles require the [runtime compatibility gate](DEPLOYMENT.md#demo-host-compatibility-gate).
GitHub-native mode uses the released CLI server, host-owned sessions, and existing Mission Control owner binding;
it does not disable a managed-path check to run an unqualified managed session.

Direct connections use an application-API-issued, 60-second, single-use ticket at the public proxy. Only the
host's owner principal can obtain one. The dispatcher atomically checks its digest, harness, owner, host epoch,
expiry, and unused state, and each host authenticates to the dispatcher with its own service key, so a ticket or a
key for one harness's host opens no other host. Through the connection broker (hybrid mode), the broker consumes the
client's ticket by harness through the dispatcher, which in the same transaction issues a one-use upstream ticket
for the same host epoch; the client's ticket never reaches the host, and the broker key authorizes only that
exchange. A ticket issued before a host was replaced opens nothing. The separate private listener credential never
leaves the host. This protects discovery too: the underlying AHP host can expose catalog metadata before GitHub
resource authentication. A reconnect needs a new ticket.

The CLI must obtain the server's authentication public key through trusted provisioning and pin the exact
endpoint. Public-key integrity, required sealed authentication, and runtime enforcement of the expected GitHub
account are independent requirements. A token in a URL is not sufficient account authorization. Treat tickets
as secrets despite their short lifetime; do not capture them in command recordings or logs.

Mission Control registers an environment using the configured owner's GitHub credential, after the app verifies
that the credential's numeric GitHub identity matches its pinned owner. Each relay-enabled host registers its own
environment, and GitHub identity, not the application's principals, decides who can attach through it, so the API
gives the environment ID only to the host's owner principal and answers others with `relay_owner_only`. A host's
volume records its harness, numeric GitHub owner, and compute identity: a host for another harness or owner refuses
the volume, and the ledger refuses a volume whose compute identity differs from the harness's durable host. Registration and
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

The Azure host template limits each revision to one replica and gives the execution uid private Azure Files
mount permissions. This is not a deployment-wide singleton during rolling replacement: drain/deactivate the old
revision first and check for reactivation after deployment. A real native conversation resumed successfully in
Azure qualification, but the [synthetic storage probe](../deploy/verify-host-storage.py) failed SQLite WAL setup
on a fresh database. Neither one successful resume nor private mount permissions establish general durability.
The storage gate remains open; see [qualification evidence](DEPLOYMENT.md#native-qualification-evidence).

Durable storage correctness, single-writer revision handling, account binding, permission arbitration, and
real deployed transport behavior require explicit qualification. No production-hardening, multi-customer
isolation, automatic retention/deletion, or uninterrupted failover is claimed.

## Local hybrid boundaries

The experimental shared worker is a separate trust model from the single-owner agent hosts. It runs harness-driven
conversations for many harnesses and principals in one process. API principals are bound to operator-configured
GitHub numeric identities. The API forwards principal-bound
control requests using a worker service key; ticket digests are one-use, short-lived and activation-bound.
The CLI still needs trusted key provisioning and sealed GitHub authentication to its expected account.
The runtime has been exercised with one real account; independent synthetic scopes and negative checks
do not substitute for the remaining two-real-account qualification.

CLI connections terminate at the separate connection broker. It holds only its own service key, which the
dispatcher accepts solely for ticket consumption and placement lookup and the shared worker accepts solely
for forwarded AHP connections. It holds no caller API key, database credential, worker control key, signing
key, inference grant, or provider credential. The dispatcher consumes each ticket atomically against its
digest, session, expiry, activation epoch and placement generation; the worker then admits the forwarded
connection only for the activation the ticket was issued for, and refuses public tickets and query strings.
The broker forwards AHP bytes without interpreting them. Pinning the server key lets the CLI seal its GitHub
authentication to the runtime, but the broker can read the rest of the session traffic it forwards, so it is
inside the same trust boundary as the worker. Locally it listens for plain WebSocket connections and
the API returns unencrypted URLs only for a loopback broker; TLS ingress, Azure placement, and multi-replica
routing are not implemented. The `moved` close is a routing signal, not an authorization control.

The shared worker holds PostgreSQL access and its dispatcher grant key. Each session runs the harness snapshot
admitted at creation, re-checked against the current effective policy whenever it activates. Its agent sessions
expose only the shared base tools that the harness requests: workspace file tools over the session's
PostgreSQL-backed file store, a task list, the [filtered `web_fetch`](#shared-placement-egress-and-remote-mcp),
approved remote MCP tools, delegation bindings that the conversation profile marks safe in-process, and the
harness's own in-runtime sub-agents. Validation rejects shell, Python, and stdio MCP tools for shared harnesses,
the runtime's built-in agents are not offered, and native shell/project/terminal operations are restricted in
provider mode. Per-harness resident-session and
turn ceilings keep one harness from taking every slot; they are scheduling controls, not isolation.
There is no Docker socket, provider credential, or allocation-signing key in the worker. Native anchors
contain no agent content; filesystem callbacks and API operations are fenced by principal and lease epoch.
In-process isolation is application isolation, not a hostile-code/OS boundary.

The host-side controller alone has Docker authority. It accepts only operator image/settings, resolves
images to immutable IDs, persists allocations before creation, and reconciles only its labeled containers.
The bound namespace must remain stable for recovery. Docker contexts must use a local socket/named pipe.
On-demand executors receive an allocation-scoped credential; dispatcher routes restrict it to the assigned
job/attempt. Runner processes receive only inference capabilities, not executor, database, or provisioning
credentials. The Docker capability set is narrowed but still supports uid switching and cleanup; egress
is **not** enforced. Neither Docker labels nor separate containers establish cross-customer security.

Turn/child reservations and stable request IDs prevent duplicated usage and unbounded fresh allowances.
Unknown requests consume a conservative reservation; late excess usage remains counted. Provider calls
already in flight can exceed remaining tokens. These are admission/accounting controls, not exact dollar caps.
Historical session files, immutable snapshots and successful output artifacts need operator-managed
retention: closing a session does not delete them.

Output collection is Linux-only and descriptor-relative under the pinned output directory. It rejects
symlinks, hard links, nonregular files and oversized trees. Only successful-attempt output artifacts are
available to the job principal. Imports require explicit destination preconditions. Child outputs are
untrusted model data; automatic completion turns are bounded and cannot delegate further jobs.
Ambiguous completion delivery is visible through session/job notification status instead of being
silently replayed. A public service, Azure adapter, robust hostile-tenant containment and crash/failover
qualification remain outside the proven local scope.

### Shared conversation approvals

A shared harness chooses its [approval mode](HOSTING-MODES-PLAN.md#approval-modes) within the effective policy's
`approvalModes`. Its per-kind `deny` and `allow` rules decide first, before the runtime raises a request, so no mode
runs a denied tool. Only requests the rules send to a person reach the approval mode, and the worker never approves
on a person's behalf ([`permissions.ts`](../src/session-host/src/permissions.ts)).

- `manual`: the runtime prompts the attached client through AHP. With nobody attached, the request stays pending
  and does not run; the turn ends at its deadline.
- `assisted`: the runtime's LLM judge reviews the request first, through the session's own provider, so the judge's
  calls pass through the inference gateway and count against the session's budget. A request the judge approves
  runs without a prompt: the AHP host acts on the verdict while a client is attached, and otherwise the worker follows
  it through the SDK's `followAssistedApproval`. A decline or a judge error goes to the attached person; with nobody
  attached it does not run. The worker never rejects on the judge's behalf, which would pre-empt the person. The
  judge is a probabilistic review, not a security boundary; only a person's messages grant authority. This needs
  runtime `d89cfe45b29` (host `006b030`) or later.
- `allow-all`: the runtime approves requests without asking, except those the harness's rules deny. It is offered
  only when the policy allows it.
- `custom`: an integrator handler that the worker registers by name decides
  ([`permission-handlers.ts`](../src/session-host/src/permission-handlers.ts)). Handlers are reviewed code with the
  trust of tool implementations, and policy and the conversation profile must both allow the name. A handler can
  approve, deny, or ask a person; one that throws, returns no valid decision, or does not answer within five seconds
  denies. The session stays in `manual`, so the runtime never approves without the handler.

The worker starts each session in its harness's mode and applies managed settings that refuse the runtime modes the
policy does not allow, so a client cannot switch into them. Batch harnesses keep `manual`.

### Shared-placement egress and remote MCP

Status: the harness-driven shared worker uses this code for `web` and remote MCP; served-harness evidence is in
the [shared mode record](HOSTING-MODES-PLAN.md#stage-2-harness-driven-shared-mode). The filter, client, and tools
were verified locally by unit tests and an opt-in in-process runtime test, recorded in the
[egress qualification record](HOSTING-MODES-PLAN.md#stage-2-shared-placement-egress-and-remote-mcp).

A shared worker can reach PostgreSQL, internal services, and cloud metadata endpoints, so web and remote
MCP requests it makes for an agent must not. [`EgressFilter`](../src/service-defaults/src/egress.ts) is an
in-process filter for the requests made through it: the shared replacement for the runtime's `web_fetch`
and the [remote MCP client](../src/service-defaults/src/remote-mcp.ts).

- It refuses every destination that is not global unicast: loopback, unspecified, RFC 1918, shared
  (CGNAT), link-local, IPv6 unique-local and site-local, multicast, broadcast, reserved, documentation and
  benchmarking ranges, IPv4-mapped, IPv4-compatible and NAT64 forms, 6to4 and Teredo, and cloud metadata and
  platform addresses such as `169.254.169.254`, `fd00:ec2::254`, and `168.63.129.16`. Special-use names
  (`localhost`, `.local`, `.internal`, `.arpa`, and others) and single-label names are refused before DNS.
- It refuses the deployment's own endpoints, by name and by resolved address and port, even when public.
  The shared worker's adapter (`createSharedEgress`) configures them from Aspire service discovery and
  connection strings, plus any operator-supplied hosts and networks. Until each configured host name has
  resolved once, outbound requests are paused rather than allowed.
- It resolves DNS once per hop, refuses the request if any answer is disallowed, and pins the connection to
  the vetted addresses, so a second lookup cannot rebind it. Every redirect hop is vetted again, and
  HTTPS-to-HTTP redirects are refused.
- One deadline bounds each request, including redirects and the body; the body is bounded after
  decompression. Credentials go only to the configured origin on the first hop, never after a redirect,
  and only over HTTPS to public addresses. Native network errors, which can name internal addresses, are
  replaced with generic messages.

`web_fetch` keeps the runtime's permission request, so the host's permission handler decides each call, and
it also applies the harness `url` rule itself: `deny` never fetches and only `allow` follows a redirect to
another host. The remote MCP client refuses all redirects, exposes only tools in both the operator catalog
and the harness request, resolves each server's single credential inside the host from a secret reference
(`MCP_SECRET_<NAME>` environment variables locally), and redacts the credential and common encodings of it
from tool descriptions, schemas, results, and errors. Redaction guards against accidental echo; a server
can always disclose its own credential deliberately. A server's read-only hint never relaxes approval.

The Copilot runtime moves a tool result above 20 KiB into a temporary file and gives the model a pointer to view it
with tools that shared placement does not have. Shared sessions disable that, which holds for turns no client drives;
with a client attached, runtime `d89cfe45b29` moves large results anyway. Remote MCP results are therefore bounded to
16 KiB of UTF-8 text, with a note asking for a narrower result, and stay inline. A `web_fetch` page near its
20,000-character maximum or a workspace read above 20 KiB can still be moved while a client is attached; smaller
pages and ranges avoid it.

An operator can set `allowPrivateNetwork` on one catalog server for development. Only that exact origin may
then use a local or single-label host name, resolve to loopback, private, shared, or unique-local
addresses, and use plain HTTP; link-local and metadata addresses, the deployment's internal endpoints, and
redirects stay refused.

Not covered: traffic that does not use the filter, including the runtime's own networking, other code in
the process, and every container, so egress remains unenforced there. The filter is not a network sandbox
and does not contain a compromised worker; the Azure design adds an egress proxy in front of the shared
worker. Fetched pages and remote MCP tool descriptions, schemas, and results remain untrusted model input.

### Session container boundaries

Per-session containers ([architecture](ARCHITECTURE.md#session-containers)) separate sessions by container,
process user, and Docker named volume. They are not VM or hostile-tenant isolation: containers share the host
kernel, the Docker daemon, and its default network, and egress is **not** enforced. Docker labels identify the
controller's containers and volumes for reconciliation; they are not a security boundary.

| Concern | Control |
| --- | --- |
| Credentials in the container | The supervisor receives an allocation-scoped credential and a per-allocation ingress credential, both derived with the controller's signing key. Dispatcher routes accept the allocation credential only for its own session: its spec, readiness, heartbeat, and inference grants. No database, Docker, signing, provider, broker, or relay credential is present, and job allocation credentials cannot use these routes (nor session credentials the job routes) |
| Agent loop and tools | The runtime, shell, file tools, and packaged tools run as uid 10001 under `no-new-privileges`, with the supervisor's environment unreadable to that user. They hold the private loopback listener token and short-lived session inference grants, so tools can obtain the current grant, as batch runners can obtain their job capability |
| Supervisor | Runs as root to start the owner as uid 10001; the controller drops every capability except `SETUID`, `SETGID`, `CHOWN`, `DAC_OVERRIDE`, and `KILL`. A compromised supervisor can use its allocation credential for its own session only |
| Client attachment | Clients attach through the connection broker, which consumes the 60-second one-use ticket (bound to the allocation and placement generation) through the dispatcher and forwards to the container's ingress, published on host loopback, with the per-allocation ingress credential in `x-internal-key`. The ledger stores that credential for the broker; the container refuses public tickets and query strings. It reaches only the AHP handshake: the runtime still requires sealed authentication as the session's bound GitHub account against a pinned server key |
| Inference | Two-minute session grants are fenced by the allocation, the session's open state, and its aggregate budget, and rechecked against current policy models. Usage is charged once per gateway request. Like other grants, these are admission and accounting controls, not exact spending caps |
| Data at rest | Runtime history and workspace files persist in the session's named volume, which outlives every container. Closing a session releases its volume for retention; nothing deletes it automatically. Protect the Docker host's volume storage like runtime history and backups |
| Policy changes | Narrowed policy blocks new containers for an existing session and stops new inference grants for models it no longer approves; it does not stop a running container |

The local gate verified the credential and environment scoping, uid, capability, and mount checks, and the refusal
of tickets presented directly at the container, against a real container. Azure container reachability (the
broker reaches a host-loopback port locally) and egress control remain unimplemented.

### Orchestrator worker boundaries

Orchestrator workers ([architecture](ARCHITECTURE.md#orchestrator-workers)) run in session containers, so the
[session container boundaries](#session-container-boundaries) apply to each worker. A worker and its coordinator do
not share a process, and two conversations' workers do not share volumes. Workers of **one** conversation that mount
its shared volume are not isolated from each other's files, and the coordinator's instructions to them are model
output.

| Concern | Control |
| --- | --- |
| Worker credentials | Each container's allocation credential is bound to one worker. The dispatcher's worker routes accept it only for that worker's spec, messages, turn and request reports, authority grants, and inference grants charged to the worker's reservation; session-container and job credentials are refused there, and worker credentials on their routes. The unprivileged owner reaches these routes only through its supervisor, over IPC, for a fixed list of operations |
| Who approves | Only a person decides a worker's permission request, through the principal-scoped request queue. The coordinator has no tool that approves; with `hosting.workers.allowCoordinatorAnswers` it may answer questions only, recorded as `answeredBy: "coordinator"`. A request belongs to the turn that raised it and ends with that turn, and nothing is approved on a person's behalf |
| Coordinator text | Messages reach a worker with the source `agent-<coordinatorId>`, so its runtime and judge treat them as data, never as the person's words. Tasks, messages, worker results, and crafted instructions are untrusted model input |
| Inherited human authority | Off unless the coordinator harness sets `humanAuthority: "inherit"` and policy allows it, and only for `assisted` workers. Grants come only from the person's recorded messages in the coordinator's runtime history, read by the shared worker, never from tool arguments; each grant and what the worker's runtime accepted are recorded. The judge remains guidance, not a security boundary: a person's broad wording can authorize more than they meant, so keep per-kind `deny` rules for what must never run |
| Crafted workers | A crafted definition passes the same schema, hosted admission, and policy checks as a published harness and cannot exceed its operator template: tools, models, approval modes, limits, and sizes. It is recorded, never published, and cannot select an image, command, or mount |
| Shared volume access | The coordinator's file tools use the execution controller's file service with a dedicated key held only by the shared worker. Each operation runs in a helper container with no network, a read-only image filesystem, and only that conversation's shared volume mounted (read-only unless writing); it refuses symbolic links and paths outside the volume and bounds sizes. Nothing locks files between writers |
| Capacity and cost | Worker ceilings per conversation, principal, and deployment count starting, running, and stopping workers until their containers are retired; reservations come from the conversation's aggregate budget. These are admission and accounting controls, not exact spending caps |
| Data at rest | Private and shared volumes outlive their workers and are released, never deleted, when the worker stops or the coordinator closes |

The integration suites verify the worker credential scoping above. The local real-container gate verified both
sizes, both mounts, person-only approvals, a request covered by the person's inherited words running without a
prompt while one only the coordinator asked for reached a person, and capacity returning to zero, with synthetic
inference. Clients cannot attach to workers.

### Promotion boundaries

[Promotion](ARCHITECTURE.md#promotion) moves a conversation from the shared worker into its own session container;
from the cutover on, the [session container boundaries](#session-container-boundaries) apply. It adds no isolation
beyond them, and egress stays unenforced in both placements.

| Concern | Control |
| --- | --- |
| Who can promote | Only `promotable` harnesses get `promote_session`, and the API route promotes only the caller's own session. Each request re-checks the harness's current effective policy (mode, promotion size and approval) and the deployment's container capacity, and is recorded once per tool call or idempotency key |
| Approval | With `approval: "ask"` the tool call is a request for a person in the session's approval flow: under `manual` the attached person decides, and with nobody attached it does not run. Under `assisted`, `allow-all`, or `custom` the runtime or handler decides it like any other request, which can approve the move without a person; that combination is not separately verified. Pair `ask` with `manual` when a person must approve every move. `allow` runs without a prompt |
| Snapshot integrity | The snapshot is read in one transaction that holds the session's storage namespace lock under a fresh lease, and is stored with per-file SHA-256 digests and a manifest digest bound to the session. The container verifies the manifest digest before writing, then each file's size and digest; it refuses paths outside its two areas and creates every entry exclusively in fresh directories (an existing link or a non-empty target fails the restore), owned by uid 10001 |
| Snapshot access | Only the allocation the ledger started for the promotion can fetch its snapshot, through that allocation's credential, and only while the promotion is starting. A failed promotion retires the allocation, whose credential then stops working |
| Consent | The runtime's provider-scoped consent files (`permissions.json`, `settings.json`, `config.json`) are not carried, so approvals given while the session had no shell or real filesystem do not apply in the container. Spilled tool output (`temp/`) is not carried either |
| Fencing and direction | The cutover replaces and pins the shared storage lease epoch in the same transaction as the placement change, so the shared worker can no longer write the session or issue tickets for it, and a commit whose snapshot is stale is refused. A ledger trigger refuses any return to `shared` placement and any generation decrease; there is no demotion route |
| Client continuity | A move closes attached clients with `4301 moved`. The launcher's supervisor re-provisions through the API with the person's API key and restarts the CLI pinned to the container's server key, which the API returns with the one-use ticket; the CLI still authenticates as the session's bound GitHub account. The relay is loopback-only with a per-run secret. No per-session host key moves with the session (plan decision N5), so seamless continuity depends on the launcher |
| Data at rest | After the cutover the shared namespace stays read-only in PostgreSQL, next to the stored snapshot; nothing deletes either automatically. Retain and protect them like runtime history |

The local gates verified the history transplant from the Windows-hosted worker and from the Linux shared-worker image
into Linux containers, digest and path refusals, fencing and the one-way trigger, every failure before cutover
leaving the session shared, and a real CLI promoting mid-task and continuing with shell and files in the same
terminal, through a crash of the promoted container, all with synthetic inference
([record](HOSTING-MODES-PLAN.md#stage-5-promotion)). Azure, paid models, and GitHub relay continuity were not exercised.
