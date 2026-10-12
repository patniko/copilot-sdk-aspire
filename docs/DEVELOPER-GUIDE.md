# Developer guide

[Documentation hub](README.md) | [Contributing](../CONTRIBUTING.md) | [Architecture](ARCHITECTURE.md)

Read the [product scope](PRODUCT.md) before adding a capability, and the [security boundaries](SECURITY.md)
before changing execution, permissions, or inference. The [user guide](USER-GUIDE.md) owns local prerequisites
and model setup; this guide owns the implementation workflow.

## Repository map

| Path | Responsibility |
| --- | --- |
| [`apphost.mts`](../apphost.mts) | Local orchestration, service wiring, identities, and Azure deployment model |
| [`contracts/src`](../contracts/src) | Zod contracts for harnesses, profiles/policy, jobs, capabilities, and JSONL protocol |
| [`src/agent-api/src`](../src/agent-api/src) | Admission, principal-scoped API, event streaming, static job console |
| [`src/job-dispatcher/src`](../src/job-dispatcher/src) | Executor claims, eligibility, leases, capability minting, attempt reports |
| [`src/job-store/src`](../src/job-store/src) | Shared transactional PostgreSQL ledger, migrations, event notifications |
| [`src/agent-executor/src`](../src/agent-executor/src) | Executor slots, uid isolation, runner lifecycle, protocol and result validation |
| [`src/agent-host/src`](../src/agent-host/src) | Experimental long-lived SDK owner, AHP ingress, connection provisioning, and host supervision |
| [`src/session-host/src`](../src/session-host/src) | Experimental native-anchor workspace bridge for a future shared host; library only, not an enabled deployment service |
| [`src/inference-gateway/src`](../src/inference-gateway/src) | Model route checks, capability authorization, upstream identity, usage reporting |
| [`src/harness-hosting/src`](../src/harness-hosting/src) | TypeScript Copilot SDK runner, session mapping, permission handlers, tool bindings |
| [`src/service-defaults/src`](../src/service-defaults/src) | Shared HTTP, auth, logging, Postgres, configuration, and registry helpers |
| [`execution-profiles`](../execution-profiles) | Approved profile manifests and Python SDK sample implementation |
| [`tools/python`](../tools/python) | Packaged Python tool implementations |
| [`examples/customer-config`](../examples/customer-config) | Committed seed harnesses and policy; editable copies live in the ignored customer workspace |
| [`configurator`](../configurator) | Local React/Vite UI and companion server for authoring and operations |
| [`deploy/Dockerfile`](../deploy/Dockerfile) | Control-plane images and executor toolchain |
| [`deploy/CopilotAgent.Hosting`](../deploy/CopilotAgent.Hosting) | Local Aspire C# integration for singleton host scale and Azure Files mount settings |
| [`tests`](../tests), [`configurator/test`](../configurator/test) | Unit and integration coverage |

The job store is shared by the API and dispatcher. "Dispatcher owns attempts" does not mean that the API forwards
all writes to it: admission, caller cancellation/retry, and input responses use the shared store directly.

## Build and check

From a fresh checkout:

```powershell
pnpm install
pnpm build
```

Workspace libraries export built `dist` files. Build before tests, and rebuild after changing shared packages
so tests do not consume stale compiled dependencies.

| Command | Scope / prerequisites |
| --- | --- |
| `pnpm build` | Contracts and `src/*` packages; does not build the configurator UI |
| `pnpm typecheck` | Contracts, services, and AppHost; AppHost needs Aspire-generated `.aspire` modules |
| `pnpm typecheck:tests` | Type-checks test code separately |
| `pnpm lint` | Current ESLint script checks `apphost.mts`, not the entire repository |
| `pnpm test:unit` | Unit tests plus configurator tests; no Docker, Azure, or model needed |
| `pnpm test:integration` | Real services/store against disposable PostgreSQL, fake runner, and fake model upstream |
| `pnpm test:runtime` | Experimental shared-runtime primitives against a locally built SDK/native runtime and synthetic loopback inference; no Docker or credentials |
| `pnpm test` | Unit and integration projects together |
| `pnpm --filter @copilot-agent/configurator typecheck` | UI and companion-server TypeScript |
| `pnpm --filter @copilot-agent/configurator build` | Vite production UI build |

If AppHost type-checking cannot resolve its generated modules, first initialize it through the documented
[local Aspire run](USER-GUIDE.md#run-locally-without-the-configurator). Do not hand-edit `.aspire` output.
Use [configurator development mode](CONFIGURATOR.md#developing-the-configurator) for UI hot reload.

The AppHost also builds a small .NET 10 hosting integration referenced by `aspire.config.json`.
After changing it, run `dotnet build deploy\CopilotAgent.Hosting\CopilotAgent.Hosting.csproj` and
`aspire restore --apphost apphost.mts` before AppHost type-checking. The integration analyzers are enabled
and warnings are errors. Its generated methods are not hand-maintained.

For a focused test run after building:

```powershell
pnpm exec vitest run --project unit tests\unit\contracts.test.ts tests\unit\admission.test.ts
```

Integration setup starts `postgres:17-alpine` unless `TEST_DATABASE_URL` is set.
**Only point that variable at a disposable test database:** integration suites truncate the jobs ledger with
`TRUNCATE jobs CASCADE`. They must never run against a local working stack or a deployed database.

Integration tests do not prove real SDK/Foundry compatibility or container uid isolation. Changes affecting
those boundaries need a representative container/model-backed run as well, with the environment and limitations
recorded in the change description. Documentation-only changes do not require application builds or tests.

## Configuration publication

The loader in [`registry.ts`](../src/service-defaults/src/registry.ts) uses two ownership roots:

- `CONFIG_ROOT` contains customer-owned `harnesses/` and `policy/`. Locally this is
  `.copilot-agent-workspace/`; deployed images copy the same workspace content into `/config`.
- `PLATFORM_ROOT` contains platform-owned `execution-profiles/` and the runner/tool implementation paths used by
  profile `{root}` placeholders. Locally this is the checkout; executor images use `/app`.

- On disk, a harness uses `instructionsFile`; the published definition contains the resolved `instructions`.
- Skill folder names resolve to `skills/<name>/SKILL.md` and are inlined into the snapshot.
- The loader validates schemas and computes a digest over canonicalized resolved content.
- Admission selects a version/profile and stores the harness snapshot with the job.
- Operator policy is `policy/execution-policy.json` plus optional `policy/harnesses/<harness>.json` overrides
  ([`HarnessPolicyOverride`](../contracts/src/profile.ts)). Admission resolves the harness's effective policy and
  stores its digest, required controls, acknowledged gaps, and retry backoff with the job; the dispatcher matches
  executors per job and rechecks the current effective policy at claim time. Lease timing and per-caller quotas
  are global. The API fails startup when an override names an unpublished harness.
- Configuration is loaded at process startup, not continuously watched by runtime services.

| Change | Local activation | Azure activation |
| --- | --- | --- |
| Harness instructions, schema, or skills | Save/version in the customer workspace, then reload or restart `agent-api` | Rebuild/redeploy the API image carrying the workspace registry |
| Operator policy or a per-harness override | Restart API and dispatcher so admission and claiming agree | Rebuild/redeploy affected control-plane images |
| Profile manifest | Restart API and rebuild/restart executor; deploy aligned profile definitions | Rebuild/redeploy API and executor images |
| Runner or packaged tool | Rebuild/restart executor image | Rebuild/redeploy executor image |
| AppHost wiring, gateway route, or identity inputs | Restart the affected stack resources | Review published infrastructure and deploy |

The configurator's **Reload harnesses** is an API restart, not a universal configuration reload. An admitted job
keeps its harness snapshot, but profiles/tool code are image-owned and the dispatcher uses its loaded policy;
do not describe the whole runtime environment as an immutable per-job snapshot.

Increment a published harness version when instructions, schemas, skills, or behavior change. Add a versioned
folder such as `.copilot-agent-workspace/harnesses/<name>@<version>` when retaining an older version; duplicate
name/version pairs are rejected. Updating the version in the only folder removes that old version from *new
admission*, not from already stored job snapshots.

In the configurator, saving an edited version number asks whether to **Save as new version** (preserve the
original folder and save the complete draft separately) or **Update existing** (replace the selected folder,
including its version number). See the [editor workflow](CONFIGURATOR.md#editing-harnesses).

Versioning is an author convention, not an enforced immutable registry. The configurator warns when content
differs from a matching platform example without a version bump, but an operator can still publish changed content
under that label.
Two jobs can therefore have the same name/version and different digests. Preserve candidate versions separately
and verify the returned job digest when reproducibility matters.

The harness digest does not cover runner/tool binaries, images, operator policy, or the provider implementation.
Attempt provenance is only partially captured and has no public export endpoint. For evaluation tooling, retain
the original input and trial-to-job mapping externally, and record the environment/scorer identity separately.
See the [evidence inventory and comparison design](PRODUCT-OVERVIEW.md#5-can-it-version-configurations-run-comparisons-and-store-results)
before treating stored jobs as a complete experiment record.

## Hosted conversations

The managed demo path requires `interaction: "conversation"`; ordinary batch admission rejects these
harnesses. `buildSessionOptions(..., "conversation")` omits the terminal result contract while the default
three-argument mapping remains unchanged for batch runners. The hosted implementation is TypeScript only;
Python/TypeScript batch parity remains required.

GitHub-native mode instead starts host-owned sessions through the released CLI server pinned in the host
package. It supplies no app factories or custom provider and uses the standard Mission Control owner binding.
Keep it independent of the deferred managed-runtime flags. Its Copilot models, permissions, and billing are
not aliases for the app's Foundry settings.

Host control uses separate PostgreSQL records and versioned session inference claims. Never synthesize a job
or extend an attempt token indefinitely to represent a conversation. Session grant renewal must retain usage,
respect current policy, and be fenced by the active host epoch. The connection proxy uses one-time tickets,
not the private listener token.

Run the focused host unit/store tests after building. The opt-in real-runtime test uses a real GitHub
authentication exchange, a Linux host image and persistent Docker volume, but a fake model upstream:

```powershell
pnpm exec vitest run --project unit tests\unit\demo-host.test.ts tests\unit\session-capability.test.ts
pnpm exec vitest run --project integration tests\integration\host-store.test.ts
```

`tests/integration/host-runtime.test.ts` additionally requires `DEMO_HOST_RUNTIME_TESTS=1`,
`DEMO_TEST_GITHUB_TOKEN`, `DEMO_TEST_GITHUB_OWNER`, and a qualified image named
`copilot-aspire-agent-host:demo` (or `DEMO_HOST_TEST_IMAGE`). Supply credentials through your normal protected
environment, never in test source or recordings. Build that test image from `examples/customer-config`,
not private customer data. `DEMO_HOST_TEST_SOURCE=1` is a local debugging mode that mounts the built host
JavaScript; it does not qualify a production image or change runtime authentication requirements.

A Docker/store test does not prove Azure Files behavior, direct CLI compatibility, or Mission Control
attachment. Collect those results separately and keep the [known compatibility gate](DEPLOYMENT.md#demo-host-compatibility-gate)
explicit until the matching runtime/client artifact is qualified.

### Hybrid runtime qualification

`pnpm test:runtime` uses a separate Vitest configuration and is not part of the ordinary unit/integration
suites. It exercises an in-process runtime, independent provider-backed session state, and separate AHP
catalogs on one runtime. On the experimental hybrid branch, `tests/package.json` links the Node SDK in the
sibling `copilot-agent-runtime-hybrid` worktree. Build that SDK before restoring this application's
dependencies. Existing batch/host package pins remain independent; this link does not upgrade a deployed service.

The runtime worktree tracks `patniko/aspire-ahp-runtime-patches` and preserves the existing proposals.
Follow its native build instructions and build the Node SDK from `src/sdk/nodejs`. Stage the resulting
native launcher and its matching library together; set `COPILOT_CLI_PATH` to the launcher's absolute path
before running `pnpm test:runtime`. The suite refuses a missing local artifact rather than downloading
or falling back to a published runtime. Local native builds and their SDK outputs are not committed here.

The fixtures use temporary files and synthetic loopback inference without GitHub or provider credentials.
They do not prove real-model behavior, CLI attachment, or cross-account authorization. Those remain the
first delivery gate in the [hybrid hosting plan](HYBRID-HOSTING-PLAN.md#4-cli-connection-contract-first-engineering-gate).
The `koffi` dependency build is allowed for the native in-process transport; existing batch execution
continues to use its existing runtime configuration.

The experimental `session-host` package also links the local SDK. `SessionWorkspace` gives the runtime
filesystem provider and the AHP resource callback one per-activation operation lane. Its AHP side accepts
only file URIs under the bound native anchor; content is read/written through the supplied storage provider,
never through the anchor's native files. It supports bounded binary/text files and byte-position writes,
and serializes create-only/etag checks with SDK file mutations. It does not provide cross-worker fencing
or durable storage itself; the owning application must supply both. Access requests confirm only the
already-bound namespace and never widen it. Optional session SQLite and directory copying are unsupported.
The package is excluded from the existing Docker build context until a dedicated shared-host image stages
its local SDK/native artifacts. Existing container services continue building from their published SDK pins.

`SessionFileStore` in `job-store` provides the prototype's PostgreSQL storage authority.
Namespaces bind a principal to an expiring activation epoch; every filesystem read/write locks and checks
that lease. Replacement epochs cannot act as the previous owner, and resuming cannot widen admitted
storage quotas. The initial bounds are eight MiB per file, 64 MiB and 2,048 entries per namespace
(lower namespace ceilings are accepted). Quota failures roll back both file and parent-directory writes.
Metadata/listing queries do not load file payloads. This is bounded session storage, not the large-job artifact
store; append rewrites a bounded file and needs measurement before high-volume transcript use.
The `postgresSessionFilesystem` adapter supplies that storage to the shared-host library without native
filesystem I/O. Windows provider keys are case-folded within their namespace.

`SharedSessionRuntime` is a local prototype owner over one in-process client. It publishes one
account/workspace-scoped AHP listener per admitted conversation, backed by PostgreSQL session files.
Opening is bounded, storage leases renew during activation, and deactivation retains the conversation.
New conversations are application-provisioned; the CLI attaches to the published session rather than
creating arbitrary sessions through AHP. Returned listener tokens are private provisioning material:
a public service must still supply authenticated one-time tickets and independently trusted server keys.
The library does not yet implement the public session API, inference-budget grants, turn scheduling,
idle eviction, or container delegation, and is not wired into the deployed AppHost.
Set `COPILOT_AHP_FACTORY_PROFILE=managed` on the hosting process before initialization. An in-process
runtime cannot use the child-runtime `env` option; this existing managed profile keeps AHP identity
credentials separate from the application's model provider. The library refuses to start without it.

The opt-in integration `tests/integration/shared-session-runtime.test.ts` requires
`HYBRID_SESSION_RUNTIME_TESTS=1`, a local native pair, and disposable PostgreSQL.
It checks independent published conversations, capacity, ownership, unchanged configuration on resume,
and runtime replacement without model calls or real-account authentication.

The initially probed published bundle could not publish pure virtual workspace paths on Windows.
The selected design now uses tiny native directory anchors while keeping content in the provider.
The suite verifies that unsupported virtual-only publication is rejected, separately from the working
anchor controls and per-account host scopes. Passing these primitive checks does not qualify the
remaining CLI resource bridge or real multi-account attachment.
See the [qualification record](HYBRID-HOSTING-PLAN.md#13-qualification-record).
Ordinary `pnpm test`, unit, and integration selections do not include this native-runtime suite.

`tests/runtime/workspace-ahp.test.ts` is additionally opt-in with `HYBRID_RESOURCE_AUTH_TESTS=1`.
Supply `DEMO_TEST_GITHUB_TOKEN` explicitly, or set `HYBRID_USE_GH_ACCOUNT=1` to authorize using the
account already signed in through `gh`. It authenticates a task-owned loopback host and checks provider
resource read/write behavior without model calls. It never prints or persists the credential.
Do not enable either option for an unattended run without permission to use that account.

`tests/integration/shared-cli.test.ts` is a separate real-CLI gate, enabled with `HYBRID_CLI_TESTS=1`.
Build the matching local CLI first, set `HYBRID_CLI_PATH` to its absolute `dist-cli/index.js` path,
and supply the local native pair, managed hosting profile, disposable PostgreSQL, and explicitly
authorized GitHub account described above. The test loads `node-pty` from that CLI worktree,
authenticates to a task-owned loopback host with an explicitly pinned server key, and drives the
interactive CLI against synthetic loopback inference. `--ahp-authenticate-with-github` is required
to consent to sharing GitHub identity with this host; it is not a model-provider credential.
This gate does not contact a paid model provider or qualify two-account operation. For example:

```powershell
# Use the actual paths to your locally built, matching artifacts.
$env:COPILOT_CLI_PATH = 'C:\projects\copilot-agent-runtime-hybrid\dist-cli\prebuilds\win32-arm64\copilot-runtime.exe'
$env:HYBRID_CLI_PATH = 'C:\projects\copilot-agent-runtime-hybrid\dist-cli\index.js'
$env:COPILOT_AHP_FACTORY_PROFILE = 'managed'
$env:HYBRID_CLI_TESTS = '1'
$env:HYBRID_USE_GH_ACCOUNT = '1' # Explicit approval to use the account signed in through gh.
pnpm exec vitest run --project integration tests\integration\shared-cli.test.ts
```

The separate `tests/integration/github-native-host.test.ts` opt-in uses `DEMO_GITHUB_HOST_TESTS=1`,
the same explicit GitHub credential variables, and `copilot-aspire-agent-host:native-demo` (or
`DEMO_GITHUB_HOST_TEST_IMAGE`). It exercises the actual native container, Mission Control registration,
replacement with the same environment identity, and retained workspace. It does not claim CLI feature
eligibility or send model prompts. Temporary environment IDs created by the test are removed after shutdown.

Validate the **generated native host template**, not a text copy of the AppHost, after publishing with
`Parameters__demo-host-transport=github` and the normal deployment inputs:

```powershell
az bicep build --file .\artifacts\deployment\agent-host\agent-host.bicep --outfile .\artifacts\host-template.json
$env:DEMO_HOST_TEMPLATE = (Resolve-Path .\artifacts\host-template.json).Path
pnpm exec vitest run --project unit tests\unit\host-deployment.test.ts
Remove-Item Env:DEMO_HOST_TEMPLATE
```

This opt-in test checks emitted singleton scale, Single revision mode, private ingress, credential references,
explicit storage/share/binding dependencies, and the execution-uid Azure Files mount options.
Without `DEMO_HOST_TEMPLATE`, it is skipped, not evidence of
deployment correctness. The [deployed qualification procedure](DEPLOYMENT.md#qualify-the-deployed-native-host)
owns the real storage/restart/relay checks; its storage probe never opens the runtime's own databases.

## Add a harness or tool

Use the [configurator](CONFIGURATOR.md#editing-harnesses) for harness authoring. For a custom tool:

1. Implement the binding in the applicable runner tool layer; use
   [`tools.ts`](../src/harness-hosting/src/tools.ts) and the
   [Python runner](../execution-profiles/python-agent/runner.py) as reference implementations.
2. Package the code and dependencies in the executor image. Do not install them from job input.
3. Declare the binding in each execution profile that supports it, then request it in the harness.
4. Test input/output validation, errors, cancellation, and retry implications. Advertise the tool only for
   runners that implement it.
5. Update the sample, relevant user instructions, and [runner protocol](RUNNER-PROTOCOL.md) if the wire contract changes.

Existing custom harness tools are approved bindings, not a substitute for SDK permission prompts. Treat a tool's
external side effects explicitly; do not mark a workload `safeToRetry` just because the tool often succeeds.

## Add a harness feature

Follow the complete feature path rather than changing only a schema or an editor:

| Surface | What must agree |
| --- | --- |
| [Harness contract](../contracts/src/harness.ts) and [profile/policy contract](../contracts/src/profile.ts) | Validation, defaults, policy ceilings, and required runner capability |
| [Registry](../src/service-defaults/src/registry.ts) | File representation, resolved snapshot, digest behavior |
| [Admission](../src/agent-api/src/admission.ts) | Supported profile/bindings/options rejected before queuing if unavailable |
| [Executor](../src/agent-executor/src/attempt.ts) and [wire contract](../contracts/src/runner-protocol.ts) | Capability check on `hello`, lifecycle, bounded messages, output validation |
| [TypeScript session mapping](../src/harness-hosting/src/session-config.ts) | SDK options, tool exposure, agent/skill mapping |
| [Python runner](../execution-profiles/python-agent/runner.py) | Equivalent `session_options()` behavior with snake_case SDK fields |
| [Configurator](../configurator) and [console](../src/agent-api/src/console.ts) | Validation, help, templates, authoring, and caller interaction where applicable |
| Tests and canonical docs | Behavior, failure paths, examples, feature scope, and affected diagrams |

Preserve optional-field omission when appropriate: adding materialized defaults to resolved harnesses can change
their digests. Changing prompt behavior must not silently widen tool access. Permissions and built-in tool groups
remain subject to the operator policy.

For a new language or runtime, implement [runner protocol v1](RUNNER-PROTOCOL.md), package an approved execution
profile, and report actual capabilities. Do not claim unsupported controls or add a direct-provider fallback.

## Change a service or data contract

Use shared helpers in `service-defaults` and transactional operations in `job-store`. Keep caller operations
principal-scoped and attempt operations fenced by attempt identity and lease token. Schema-valid output is
checked at the executor boundary, even if a runner validates it itself.

Ledger SQL migrations live in [`src/job-store/migrations`](../src/job-store/migrations); the
[`migration runner`](../src/job-store/src/migrate.ts) applies them during API/dispatcher startup.
Review compatibility with existing data and concurrent service revisions before changing persisted state.
For API changes, update [API.md](API.md), the [REST Client examples](../http/agent-api.http), and any affected
console/configurator clients.

## Workspace and packaging constraints

Aspire installs the root AppHost with `pnpm install --ignore-workspace`. Keep root dependencies free of
`workspace:` references and keep lockfile-affecting settings out of
[`pnpm-workspace.yaml`](../pnpm-workspace.yaml). Workspace test dependencies belong in
[`tests/package.json`](../tests/package.json). The executor and service image stages use the committed lockfile.

The TypeScript runner package has no Aspire dependency. Keep orchestration in the AppHost and execution policy
in the platform rather than coupling an SDK runner to local orchestration details.

Before submitting a change, apply the [documentation change map](MAINTAINING-DOCS.md#change-to-document-map)
and [contribution checklist](../CONTRIBUTING.md#before-submitting).
