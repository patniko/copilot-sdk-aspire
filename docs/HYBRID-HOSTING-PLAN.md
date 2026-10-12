# CLI-first hybrid hosting demonstrator

[Documentation hub](README.md) | [Current architecture](ARCHITECTURE.md) | [Security](SECURITY.md) | [Original plan](PLAN.md)

Date: 2026-10-11

**Status: implementation plan, recorded before implementation.** This document owns the proposed hybrid
demonstrator and its acceptance gates. It does not add supported deployment modes, CLI options, or security
guarantees. The current guides remain authoritative until the corresponding implementation is delivered.

## 1. Purpose and agreed scope

Demonstrate an alternative to running every agent conversation in a container: keep the main agent loop on
shared, multi-tenant compute and allocate expensive execution containers only when the model needs them.
Make the architecture directly usable from Copilot CLI and visible in the configurator.

The three outcomes are:

1. Measure time to first token and compute consumption for a shared main loop versus a container main loop,
   including cold starts, warm capacity, and idle periods.
2. Exercise the real model through Copilot CLI. Let it delegate work into real, on-demand containers under
   operator-controlled limits rather than replaying a scripted animation.
3. Provide an interactive topology page that explains the deployment, exposes effective controls, and shows
   observed session, job, and container activity.

Two CLI destinations are required, not alternatives to choose between for the project:

| Destination | Main loop | Workspace | Intended use |
| --- | --- | --- | --- |
| Shared coordinator | Many tenant sessions on shared worker compute, with an in-process runtime | Session-scoped virtual filesystem | Fast conversational entry; delegate expensive work |
| Container agent | Directly attachable, container-hosted interactive session | Real filesystem with the host's existing retention semantics | Preserve today's experience and provide a comparison baseline |

The shared coordinator must not be implemented as a hidden dedicated runtime or container per user.
Multiple authenticated identities must actually share runtime compute while maintaining separate authorized
sessions. Direct container attachment must remain available without first entering a shared conversation.

This is an experimental architecture demonstrator, not a general hosted SaaS service or a claim of hostile
cross-customer isolation. It must nevertheless preserve authentication, authorization, fencing, and explicit
failure behavior. Demonstration scope is not permission to bypass an unresolved boundary.

## 2. Baseline and source evidence

The starting application revision is `06b41f6`. The working branch is `feat/hybrid-hosting`, in a separate
worktree. Existing source worktrees and ignored customer configuration are not inputs to copy wholesale.

| Current implementation | Consequence for this work |
| --- | --- |
| [AppHost](../apphost.mts) deploys an always-on executor with multiple runner slots | A runner process starting inside that container is not evidence of on-demand container provisioning |
| [Executor](../src/agent-executor/src/main.ts) polls the dispatcher | Zero polling replicas cannot wake themselves; a provisioner or external scale signal is required |
| [Attempts](../src/agent-executor/src/attempt.ts) use private, ephemeral workspaces | Persisted job results do not imply retained files or resumable execution |
| [Job contracts](../contracts/src/jobs.ts) cap an attempt at one hour | Keep that limit initially; continuous multi-hour execution is separate checkpoint/workspace work |
| [Host store](../src/job-store/src/host-store.ts) has a deployment-wide owner and lease | Do not turn the singleton schema into multi-tenancy merely by adding more sessions |
| [Host owner](../src/agent-host/src/owner.ts) serializes managed inference | This is not the target multi-tenant worker implementation |
| [CLI launcher](../configurator/server/connect-host.ts) selects local/Azure and direct/GitHub transport | Add execution destination independently; preserve existing invocation behavior |
| [Inference usage](../src/job-store/src/store.ts) is recorded after provider responses | Current accounting is not an exact monetary reservation across parent and child work |

Runtime source was reviewed at `9d9ce4c3415c75060d0d8848b9555a36f11b8d3a` on 2026-10-11.
This is a source-review reference, not a qualified package pin. Record the actual SDK, native library,
CLI, operating system, architecture, and provider combination when running the compatibility gate.

Important findings to carry into implementation:

- The application's installed SDK already exposes in-process connections and filesystem providers.
  Start with a compatibility matrix, not an assumption that the APIs require an upgrade.
- One SDK connection owns the runtime's `sessionFs` registration. Configure it before creating sessions;
  loss of that provider connection is not transparent failover to another SDK client.
- In-process configuration shares process-wide environment and working-directory constraints. Do not
  transplant the container runner's per-process environment construction into a tenant callback.
- Empty-mode defaults disable several ambient features, including the global session store. Application
  ownership and listing must not depend on an unscoped runtime catalog.
- AHP hosting has additional account, catalog, and workspace assumptions. SDK session multiplexing alone
  does not establish a multi-tenant CLI-facing host.
- Runtime commit `785c322c6a601f214442aa3748393e392a115ec7` fixes native plan edits to stay on the
  filesystem provider and propagate provider failures. Qualify every enabled tool on the actual bundle.

See the SDK [in-process guide](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/in-process-runtime)
and [multi-tenancy guide](https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/multi-tenancy).
Source support, a published API, and a successful deployed demonstration are different evidence levels.

The existing host's [compatibility gates](DEPLOYMENT.md#demo-host-compatibility-gate) and
[storage qualification](DEPLOYMENT.md#native-qualification-evidence) remain separate. Do not change its storage
or weaken its account checks to unblock this work.

## 3. Proposed topology and ownership

```text
                           Copilot CLI
                                |
                 Authenticated connection provisioning
                       /                    \
                      v                      v
             Shared coordinator       Container agent host
             - owner-scoped access    - existing interactive path
             - in-process runtime     - real filesystem
             - many tenant sessions   - independent lifecycle
             - session filesystem
                      |
             Model calls delegate_job
                      |
             Admission + durable job ledger
                      |
             Container execution controller
                      |
             On-demand container executions
                  Job A       Job B
                      |
             Results + immutable artifact manifests
                      |
             Durable completion inbox
                      |
             Original coordinator conversation
```

The API, dispatcher, ledger, and managed inference gateway remain shared platform services.
Managed sessions and jobs use gateway-owned provider authentication. Existing GitHub-native container
sessions continue using their existing Copilot identity, models, permissions, and billing; the topology must
show the actual route rather than drawing every request through Foundry.

One long-lived owning SDK client per shared worker manages many sessions and their filesystem callbacks.
Keep the worker separate from the public API and infrastructure controller. A native runtime failure must
not also remove admission, job ownership, or container reconciliation.

In-process hosting does not require containerless deployment. The shared worker may run as a normal process
locally and a small service container in Azure. Its compute is shared rather than allocated per user.
An explicitly selected shared-stdio mode may be useful for diagnosis and comparison; it is not a silent
fallback or evidence that in-process hosting has been qualified.

## 4. CLI connection contract: first engineering gate

Keep four choices distinct:

| Choice | Meaning |
| --- | --- |
| Deployment target | Local stack or selected Azure deployment |
| Execution destination | Shared coordinator or container agent |
| Connection transport | Direct WSS or GitHub relay, where qualified |
| Session identity | A new session or an authorized existing session at that destination |

Do not overload the existing `--transport direct` concept to mean container execution.
Connection provisioning must bind the caller, destination, host identity, and session authority.
Continue using protected provisioning rather than copying long-lived credentials or live tickets into
launcher commands. Unsupported destination/transport combinations must report their concrete prerequisite.

The first spike must use the real Copilot CLI, not substitute a browser or raw SDK request.
Resolve these questions before claiming a shared host:

- Can owner-scoped AHP participation and catalogs operate over the shared runtime and session filesystem?
- Are catalog listing, resident-session attachment, resume, file access, approvals, and cancellation
  authorized for the connecting identity, not just checked in create/resume factory callbacks?
- Does the transport support the required application-owned tools and model-provider configuration?
- What AHP catalog state remains outside `sessionFs`, and how is its ownership and recovery maintained?
- Can two distinct CLI identities use the same worker without separate per-user runtime instances?

If runtime or the pinned hosting library needs changes, record the exact missing contract and develop it
in a separate worktree. Qualify a matching artifact before enabling the shared destination.
Do not disable sealing, expected-owner enforcement, or factory restrictions; do not fall back to the
existing single-owner host and label it multi-tenant.

Preserve the existing directly attachable container host throughout this work. Attaching to an arbitrary
delegated batch job is not part of the initial contract and must not appear as a working connection button.
Changing destinations creates or resumes a session at that destination; it is not live session migration.

## 5. Session, storage, and recovery model

Separate durable identity from runtime residency:

| Record | Owns |
| --- | --- |
| Session | Tenant and principal authorization, harness snapshot, storage namespace, retention and closed state |
| Turn | Durable user message or completion continuation, deadline, outcome and limits |
| Activation lease | Current worker, ownership epoch, expiry and permission to mutate session state |
| Delegation | Stable operation identity linking a session/turn to its child job |
| Inbox/outbox | Durable delivery and deduplication of commands and completion notifications |

Serialize turns within one session initially; allow concurrency between different sessions.
Claim ownership before creating/resuming the SDK session. Bind credentials, tools, filesystem callbacks,
and permissions from trusted application context before execution.

Fence state writes, delegation admission, and inference grants against the activation epoch. Sticky
routing alone is insufficient. Reattach callbacks on cold resume and suppress automatic replay of pending
work until its recorded effects are reconciled.

Use distinct storage domains:

- Runtime history and small session files: a durable provider with explicit append, overwrite, rename,
  listing, and error semantics. Evaluate bounded PostgreSQL-backed files first.
- Lightweight workspace: an independently scoped virtual namespace with byte, file-count, and operation
  limits. Session filesystem paths are not host OS paths.
- Job artifacts: immutable blobs with manifests, checksums, sizes, provenance, and owner-scoped access.

Do not implement durability as occasional snapshots of an otherwise authoritative in-memory provider.
Every successful durable write must have a defined persistence boundary. Avoid rewriting an unbounded
transcript on each append; measure storage amplification and recovery cost.

Start without optional provider SQLite support unless a required feature needs it. The SQLite callback
contract is not permission to execute arbitrary statements against the application PostgreSQL schema.
Enable binary filesystem support only with the matching provider operations and size limits.

Idle eviction disconnects execution but retains the conversation. Browser/CLI disconnect, turn abort,
session closure, deletion, and cancellation of child jobs are separate operations.
Proposed default: session closure prevents new turns and automatic continuations; admitted child jobs
continue unless explicitly cancelled. Expose an explicit cancel-related-work operation and preserve
artifacts required by active children until their disposition is known.

## 6. Model-directed container execution

Expose a narrow, policy-bound delegation tool to the coordinator. The model selects from approved job
harnesses and supplies structured input and authorized artifact references. It cannot supply tenant identity,
arbitrary images, container commands, service credentials, or infrastructure arguments.

Reuse normal admission, policy intersection, executor eligibility, output validation, cancellation,
and uncertain-effects behavior. Keep runtime sub-agents distinct from durable, remotely scheduled jobs.
Short tasks requiring shell or untrusted executable code still belong in containers.

The delegation path must:

1. Persist the delegation operation and admitted job atomically before acknowledging acceptance.
2. Deduplicate retried submissions using the persisted operation identity. If the tool response is lost,
   recovery discovers the accepted job rather than reinferring and launching another one.
3. Provision or assign actual execution capacity under the configured limits.
4. Materialize only the selected immutable inputs into the private attempt workspace.
5. Publish output artifacts before committing successful job completion.
6. Record a completion notification durably, deduplicate delivery, and route it to the parent conversation.

Finish the initiating coordinator turn after acknowledging delegation. A child job must not keep that
turn actively polling or reserving execution compute. Completion may schedule a bounded, budgeted
continuation; combine related notifications where appropriate and never reactivate a closed session.
This is at-least-once delivery with idempotent application operations, not exactly-once external effects.

The container controller, not model code, owns infrastructure permissions:

- Local implementation: an operator-owned Docker execution adapter.
- Azure candidate: on-demand Container Apps Job executions, subject to lifecycle, networking, identity,
  and Aspire provisioning compatibility. Record that decision after the compatibility spike.
- An explicitly configured warm executor pool is an optional latency/cost mode, not the default proof
  of on-demand execution. Warm-capacity settings apply only to providers that implement them.

Record each allocation identity before/reconcile after provisioning. Handle lost start responses, duplicate
starts, stale leases, cancellation during startup, failed startup, and orphan cleanup. Enforce global and
tenant limits transactionally, including starting allocations, not just already-running containers.
Do not mount the Docker socket into the shared runtime or give execution agents Azure provisioning authority.

The initial on-demand configuration has zero warm execution containers. A normal chat must not start one.
Retire one-shot executions on completion; warm-pool retirement follows its explicit idle policy.
Report optional direct-host compute separately so it cannot be mistaken for an idle execution-pool leak.

Never share a writable main-session filesystem with a job. Snapshot selected inputs; return a manifest
and structured result. Import outputs explicitly with version/conflict checks. Do not export runtime history
or credentials as workspace context, and treat child outputs as data rather than policy instructions.

## 7. Effective controls

The following controls are planned requirements, not existing configuration keys. Put final names, bounds,
and defaults in contracts when implemented; the UI must read the same effective values.

| Control | Enforced behavior |
| --- | --- |
| Shared worker active-turn limit | Backpressure before starting more inference loops |
| Resident-session/memory limit and idle timeout | Eviction of inactive runtime sessions without deleting durable state |
| Maximum execution containers | Global allocation ceiling, counting startup and running capacity |
| Parallel jobs per conversation and tenant | Bounded spreading and fairness; excess work waits visibly |
| Warm execution capacity, including zero | Explicit latency/idle-cost tradeoff on capable providers |
| Idle retirement interval | Release reusable capacity after the configured idle period |
| Job CPU/memory and duration | Approved execution sizes and deadlines; keep the current attempt ceiling initially |
| Main-turn, child-job, and aggregate task budgets | Prevent delegation from minting unrelated fresh spending allowances |
| Fan-out, depth, and continuation limits | Prevent unbounded nested delegation or automatic follow-up loops |

Model choice is another explicit control, not a hidden architectural optimization. Demonstrate a cheaper
coordinator model separately from the same-model architecture comparison.

Use stable usage-report identities and recoverable delivery before introducing aggregate accounting.
Reservations may bound admitted allocations, but provider usage is asynchronous and can be incomplete.
Document in-flight overshoot and unknown usage; do not advertise exact dollar enforcement from token counters.

Controls need server-side validation and enforcement. Clearly label whether a change affects new work,
requires restart/redeploy, or applies immediately. Reject unsupported settings instead of silently ignoring them.
Lowering a concurrency ceiling blocks new allocations and drains existing work; it does not silently kill jobs.

## 8. Hosting and topology page

Add a first-class **Hosting & topology** page to this configurator. The visual reference is the production
hosting experience reviewed in the adjacent configurator: curated boundary boxes, selectable nodes,
highlighted incident connections, and a component inspector. Reuse the interaction pattern, not private
content or unsupported security claims.

Required surfaces:

| Surface | Content |
| --- | --- |
| Destination selector | Shared coordinator and directly attachable container agent |
| Environment selector | Local and selected Azure deployment |
| Topology | CLI connection path, shared workers, direct host, controller, job containers, state, artifacts, and actual inference routes |
| Connection actions | Authorized new/resume CLI launchers for supported destination/transport combinations |
| Component inspector | Responsibility, location, lifecycle, effective controls, current status, and limitations |
| Activity overlay | Session-to-job relationships; queued, starting, running, idle, and retiring capacity |
| Comparison panel | Container-main-loop baseline versus hybrid, including cold and warm scenarios |
| Measurement panel | Latency distribution, compute usage, inference usage, and labeled cost estimates |

Keep configured topology separate from observed state. Show freshness and unavailable/error states.
Missing telemetry is not zero usage. A diagram preview must not provision resources or change saved settings.
Unsupported connection choices remain disabled with the relevant prerequisite.

The observed topology comes from application state and infrastructure observations, not manufactured
timers. Use a stable topology projection for both diagram and accessible component list. Operator-wide
metrics are protected by the configurator/application authorization boundary, not exposed to all tenants.

Support keyboard node selection, text explanations of every connection, light/dark themes, readable labels,
and narrow-screen scrolling/list access. Do not rely only on animation or color to communicate state.
The current architecture SVGs remain unchanged until implementation changes the deployed topology.

## 9. Measurements and demonstration protocol

The architectural hypothesis is that sharing the main loop removes per-user container startup from normal
conversations and reduces unused container capacity. It does not eliminate model latency, shared service
cost, or startup time for delegated work. In-process versus shared-stdio benefit must also be measured.

| Metric | Definition |
| --- | --- |
| Connection setup | CLI provisioning/connection start to an authenticated, usable session |
| Client-observed first token | Prompt submission to first visible assistant text, excluding transport/control acknowledgements |
| Server first delta | Prompt admission to first assistant delta at the service; label separately when client timing is unavailable |
| Job queue/startup | Admission-to-allocation and allocation-to-runner-ready as separate intervals |
| Task completion | User submission to final usable result/artifact publication |
| Compute usage | Worker and execution-container lifetimes, configured vCPU/GiB seconds, active versus idle capacity |
| Cost | Measured/attributed usage with named rates and billing assumptions; estimates distinct from actual billed amounts |

Instrument correlation across deployment, session, turn, delegation, job, attempt, and allocation without
recording secrets. Capture client elapsed times on the client rather than subtracting unsynchronized clocks.
Keep workload content out of ordinary logs and use synthetic demo inputs.

Compare new and resumed sessions, cold and warm compute, concurrent tenants, and idle intervals.
Hold model/provider, prompt, tools, region, and relevant cache conditions comparable; document differences.
Report sample counts, errors, cancellations, and p50/p95 rather than a single favorable run.
Do not claim architecture-only improvements when the direct native path and shared managed path use
different inference providers or models.

No numerical TTFT or savings target has been agreed. Record the workload, trial count, and quantitative
pass criteria before collecting comparative results. Behavioral gates below are mandatory regardless of
whether measured performance improves. Report a negative result honestly rather than optimizing the display.

A representative demonstration:

1. Connect two distinct CLI identities to the same shared worker; verify independent session context.
2. Run lightweight conversations and observe zero execution-container allocations.
3. Ask the real model for a task requiring container tools; observe delegation and actual allocation.
4. Run with a concurrency ceiling of one, then a larger ceiling; observe queuing and bounded spreading.
5. Receive results and artifacts in the initiating CLI conversation.
6. Observe execution capacity retire to zero while the shared entry point stays usable.
7. Connect directly to the container agent and repeat a comparable workload.
8. Show the topology, effective controls, measured timings, and separate compute contributions.

## 10. Delivery sequence and acceptance gates

Documentation precedes implementation. Deliver vertical slices and retain explicit feature gates rather
than publishing a completed-looking UI for unimplemented runtime behavior.

| Stage | Deliverable | Required exit evidence |
| --- | --- | --- |
| 0. Plan | This document and documentation-hub links | Agreed goals, both CLI destinations, dependencies, non-goals, and acceptance criteria recorded before code changes |
| 1. CLI/runtime gate | Qualified in-process, session-FS-backed shared loop through actual CLI attachment | Two distinct identities share one worker; catalog/content/permissions stay owner-scoped; tools, streaming, reconnect, and shutdown work; direct container attachment still works |
| 2. Thin hybrid slice | Session lifecycle, durable delegation, one approved child harness, local on-demand container, completion routing | Lightweight chat allocates zero containers; a real model delegates; actual container work completes and returns to the original CLI conversation |
| 3. Controls and topology | Interactive page plus backend-enforced limits and observed activity | A ceiling of one serializes children; a higher ceiling permits bounded concurrency; diagrams match actual allocations; unsupported features and stale observations are explicit |
| 4. Azure and recovery | Qualified Azure execution adapter, artifact handoff, budget/accounting and lifecycle recovery | Zero-to-many-to-zero execution works in Azure; startup/cancellation/ownership failures reconcile without duplicate accepted jobs or unauthorized state writes |
| 5. Comparative demonstration | Repeatable cold/warm and concurrency trials using the topology page | Raw measurements and assumptions support the displayed conclusions; direct and shared routes remain usable |

A source patch is not the exit evidence for stage 1. If a required runtime/host capability is blocked, leave
the shared route unavailable and record the blocker; do not replace the CLI gate with a raw SDK smoke test.
The topology projection and layout can be developed alongside the thin slice, but live claims require real
events. Local-only evidence does not qualify Azure.

Focused failure coverage must include:

- Cross-principal list, resume, file, approval, and cancellation attempts.
- Concurrent activation and stale-owner writes after lease loss.
- Provider failure without a host-filesystem fallback.
- Lost delegation acceptance response and duplicated completion delivery.
- Worker restart after delegation but before result delivery.
- Cancellation during container startup and while executing.
- Orphan allocation cleanup, failed teardown, and capacity accounting.
- Closure during a completion continuation; exhausted budgets and pending approvals.
- Artifact authorization, path validation, input immutability, and output conflicts.
- Repeated/ambiguous usage reports and preservation of prior-attempt consumption.

Use the [documented build/test commands](DEVELOPER-GUIDE.md#build-and-check) and disposable fixtures.
Model-backed CLI runs need explicit eligible identities and supported client/runtime builds. Do not
store tokens in tests, recordings, examples, or the worktree. Azure provisioning requires an explicitly
selected deployment target and reviewed resource/cost settings.

## 11. Implementation surfaces and documentation

| Surface | Planned responsibility |
| --- | --- |
| `contracts/src` | Destination, session/turn, delegation, topology, and effective-control contracts |
| `src/agent-api` and shared admission helpers | Caller-scoped session/connection APIs and consistent job/delegation admission |
| `src/job-store` and migrations | Sessions, activations, delegation deduplication, inbox/outbox and allocation records |
| `src/job-dispatcher` | Session grants, completion delivery, allocation reconciliation and limits |
| New shared session-worker package | Owning SDK client, qualified AHP bridge, provider callbacks and bounded residency |
| `src/agent-host` | Preserve existing direct-container host and expose unambiguous destination identity |
| `src/agent-executor` and execution adapter | Targeted job execution, lifecycle reporting and artifact materialization |
| `src/harness-hosting` | Reuse policy-safe mappings; keep virtual and real-filesystem tool bindings distinct |
| `src/inference-gateway` | Session/job attribution, idempotent usage delivery and aggregate-budget integration |
| `configurator/server` and `configurator/src` | Destination-aware launchers, effective settings, topology projection and page |
| `apphost.mts` and `deploy` | Separate shared-worker, direct-host and on-demand-execution placement and identities |

Shared hosting is TypeScript first. Preserve TypeScript/Python batch parity for any changed job protocol,
artifact contract, permissions, or advertised execution capability. Do not generalize the existing
container profile schema into a session lifecycle by name alone.

As each slice lands, update the affected canonical pages according to
[the change-to-document map](MAINTAINING-DOCS.md#change-to-document-map): architecture and diagrams,
security boundaries, API, deployment, configurator, developer guide, user workflows, and product scope.
Keep this page as the delivery/design record; move supported behavior into its owning reference rather
than duplicating setup or endpoint tables here.

## 12. Explicit non-goals and decision register

Initial non-goals: replacing Copilot CLI with web chat; removing the direct-container path; a container per
shared user; arbitrary model-selected infrastructure; transparent runtime migration; attaching to every
batch job; a general workflow engine; uninterrupted multi-hour attempts; and production-hardening claims.

| Decision | Current direction | Must be resolved by |
| --- | --- | --- |
| Multi-owner CLI/AHP integration | Owner-scoped access over genuinely shared execution; identify necessary runtime/host changes | Stage 1 |
| SDK/CLI/native bundle | Pin the exact qualified combination, not an untested latest package | Stage 1 |
| AHP catalog versus session-FS persistence | Separate ownership and recovery; no assumption that `sessionFs` covers the host catalog | Stage 1 |
| Initial shared inference | Existing managed Foundry route where compatible with CLI factories; preserve native container billing separately | Stage 1 |
| Azure execution backend | Prefer on-demand job executions if lifecycle and Aspire requirements are met | Before stage 4 implementation |
| Warm-pool support | Zero-warm on-demand mode first; add reusable capacity only with safe workspace lifecycle and real enforcement | Stage 3/4 |
| Performance targets | Select representative workloads and predeclare thresholds, with no promised speedup | Before stage 5 trials |

Progress is tracked by delivered evidence, not the presence of this plan. At creation, no stage beyond
documentation is marked implemented or qualified.

## 13. Qualification record

### 2026-10-11: native session support works; virtual-workspace AHP publication is blocked

The first code slice adds an independently runnable `pnpm test:runtime` gate. It uses test SDK `1.0.19`,
bundled runtime `1.0.95` (source `f5ba50575c25c247798fb12ded26c48b421577ce`), and synthetic loopback
inference on Windows. Existing service SDK pins and deployment behavior are unchanged.

| Probe | Result | Limit |
| --- | --- | --- |
| Two sessions sharing one in-process client, separate provider namespaces, concurrent turns and resume | Passed | Synthetic inference; filesystem callbacks use a temporary disk-backed fixture, not production storage |
| AHP publication with a normal local-filesystem session | Passed | Control case; no CLI identity authentication |
| Two compute-scoped AHP listeners on the same runtime | Passed | Empty catalogs; listener separation is not account authorization |
| Publication of virtual-workspace sessions into independent AHP catalogs | Failed | `Request host.publishSession failed with message: session publication failed` |
| Real CLI attachment by two distinct identities | Not run | Virtual-workspace publication is unresolved; no explicit two-account test credentials configured |
| Linux/container execution | Not run | Docker's Linux engine was unavailable on this machine |

The published runtime's `publish_host_session` projects the session working directory into
`HostRegisterSessionRequest` and drops the inner registration error. The pinned hosting library
(`copilot-host` revision `97f78fedf34bc7186639269a3d8b20f7596820b3`) represents that directory as a host
`PathBuf`, requires an absolute host path, and resolves it through the host's workspace roots in
`CopilotBackend::publish_application_session`. It does not carry the provider path conventions or a
session-filesystem authority in that publication metadata. The `/workspace` virtual path used by this
fixture is not an absolute Windows host path.

This proves a Windows compatibility failure for that virtual-workspace publication path, not that every
host/provider/platform combination is impossible. The local-filesystem control rules out a general
in-process publication failure. Additional host changes or a qualified, explicitly designed virtual
workspace bridge are needed; creating arbitrary host directories or widening host roots is not evidence
that CLI file access and owner isolation work.

Next gate work must address publication and cold resume, CLI workspace/file operations, per-account catalog
access, and managed factories together. Do not enable shared CLI hosting based only on the three passing
primitive probes. The existing directly attachable container destination remains untouched.

Recorded commands:

| Command | Result |
| --- | --- |
| `pnpm build` | Passed |
| `pnpm typecheck:tests` | Passed |
| `pnpm exec vitest run --project unit tests\unit\demo-host.test.ts tests\unit\session-capability.test.ts` | Passed: 10 tests |
| `pnpm test:runtime` | Failed: 3 passed, 1 failed at virtual-workspace publication |
| `pnpm install --frozen-lockfile --lockfile-only --offline` | Passed |

### Local-source continuation

The user approved locally built runtime/SDK dependencies rather than waiting for a release.
The runtime worktree is `copilot-agent-runtime-hybrid`, on the existing pushed
`patniko/aspire-ahp-runtime-patches` branch. It was fast-forwarded through the existing local fixes and
merged with upstream `33071185b5a` in merge commit `5ba434564e3`, without rewriting history.
The original runtime worktree remains on its previous branch. A separate hosting-library worktree starts
at the runtime's pinned dependency revision.

The local Node SDK builds. The application test package now links that SDK; the runtime gate requires an
explicit matching local launcher/library pair through `COPILOT_CLI_PATH`. Neither a successful SDK build
nor the dependency link qualifies the native host. Native build and virtual-workspace/identity work remain
pending, and the existing service SDK pins and direct-container host are unchanged.

Windows Developer Mode is a native build prerequisite. After enabling it, restart the task-owned Bazel
server if it retained the earlier symlink-permission failure. A standalone file-symlink probe then succeeded.
The native build uses the runtime repository's vendored Bazel wrapper. No signature verification or
Windows privilege check was disabled.

### Configurator topology foundation

The configurator now has a lazy-loaded **Hosting** page with current-stack and hybrid-proposal maps,
local/Azure placement, selectable component explanations, and the existing container-host CLI launchers.
Native Copilot inference and managed Foundry inference are displayed separately. The page is read-only:
shared attachment, on-demand allocation, measurements, and future controls are explicitly unavailable.
It is not the live integration required to complete stage 3.

The UI typecheck/build and seven focused topology tests passed. An Edge browser pass using synthetic
API fixtures exercised current/hybrid maps, native/managed routes, node and keyboard selection, and
desktop/dark/mobile layouts, with no external or mutating requests. These are UI observations, not
evidence of a deployed shared runtime or successful real CLI attachment.
