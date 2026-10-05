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
| [`src/inference-gateway/src`](../src/inference-gateway/src) | Model route checks, capability authorization, upstream identity, usage reporting |
| [`src/harness-hosting/src`](../src/harness-hosting/src) | TypeScript Copilot SDK runner, session mapping, permission handlers, tool bindings |
| [`src/service-defaults/src`](../src/service-defaults/src) | Shared HTTP, auth, logging, Postgres, configuration, and registry helpers |
| [`execution-profiles`](../execution-profiles) | Approved profile manifests and Python SDK sample implementation |
| [`tools/python`](../tools/python) | Packaged Python tool implementations |
| [`harnesses`](../harnesses), [`policy`](../policy) | File-published behavior and operator ceilings |
| [`configurator`](../configurator) | Local React/Vite UI and companion server for authoring and operations |
| [`deploy/Dockerfile`](../deploy/Dockerfile) | Control-plane images and executor toolchain |
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
| `pnpm test` | Unit and integration projects together |
| `pnpm --filter @copilot-agent/configurator typecheck` | UI and companion-server TypeScript |
| `pnpm --filter @copilot-agent/configurator build` | Vite production UI build |

If AppHost type-checking cannot resolve its generated modules, first initialize it through the documented
[local Aspire run](USER-GUIDE.md#run-locally-without-the-configurator). Do not hand-edit `.aspire` output.
Use [configurator development mode](CONFIGURATOR.md#developing-the-configurator) for UI hot reload.

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

The loader in [`registry.ts`](../src/service-defaults/src/registry.ts) reads harness manifests, instructions,
skills, execution profiles, and policy from `CONFIG_ROOT`:

- On disk, a harness uses `instructionsFile`; the published definition contains the resolved `instructions`.
- Skill folder names resolve to `skills/<name>/SKILL.md` and are inlined into the snapshot.
- The loader validates schemas and computes a digest over canonicalized resolved content.
- Admission selects a version/profile and stores the harness snapshot with the job.
- Configuration is loaded at process startup, not continuously watched by runtime services.

| Change | Local activation | Azure activation |
| --- | --- | --- |
| Harness instructions, schema, or skills | Save/version, then reload or restart `agent-api` | Rebuild/redeploy the API image carrying the updated registry |
| Operator policy | Restart API and dispatcher so admission and claiming agree | Rebuild/redeploy affected control-plane images |
| Profile manifest | Restart API and rebuild/restart executor; deploy aligned profile definitions | Rebuild/redeploy API and executor images |
| Runner or packaged tool | Rebuild/restart executor image | Rebuild/redeploy executor image |
| AppHost wiring, gateway route, or identity inputs | Restart the affected stack resources | Review published infrastructure and deploy |

The configurator's **Reload harnesses** is an API restart, not a universal configuration reload. An admitted job
keeps its harness snapshot, but profiles/tool code are image-owned and the dispatcher uses its loaded policy;
do not describe the whole runtime environment as an immutable per-job snapshot.

Increment a published harness version when instructions, schemas, skills, or behavior change. Add a versioned
folder such as `harnesses/<name>@<version>` when retaining an older version; duplicate name/version pairs are
rejected. Updating the version in the only folder removes that old version from *new admission*, not from
already stored job snapshots.

Versioning is a contributor convention, not an enforced immutable registry. The configurator warns when committed
content changes without a version bump, but an operator can still publish changed content under that label.
Two jobs can therefore have the same name/version and different digests. Preserve candidate versions separately
and verify the returned job digest when reproducibility matters.

The harness digest does not cover runner/tool binaries, images, operator policy, or the provider implementation.
Attempt provenance is only partially captured and has no public export endpoint. For evaluation tooling, retain
the original input and trial-to-job mapping externally, and record the environment/scorer identity separately.
See the [evidence inventory and comparison design](PRODUCT-OVERVIEW.md#5-can-it-version-configurations-run-comparisons-and-store-results)
before treating stored jobs as a complete experiment record.

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
