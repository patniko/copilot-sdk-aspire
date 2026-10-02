# Copilot SDK + Aspire: architecture and delivery plan

Date: 2026-10-01

Status: plan with a reference implementation through M3 (secure execution, durable service, Azure deployment). See [section 24](#24-implementation-status) for what is built, how it was verified, and the gates that remain open.

## 1. Product goal

Enable a developer to configure a Copilot SDK harness, put the resulting application in their own repository, implement their tools, run the system locally, and deploy a secure agent service into their own Azure subscription.

The product promise is:

> Configure the harness. Own the code. Run locally. Deploy the same application model to your Azure subscription.

The generated application must remain usable without the public configurator or a project-operated control plane. Customers own their source, infrastructure, identities, data, and deployment lifecycle.

The production architecture should realize the responsibilities described on the existing Harness Builder's production hosting page: authenticated ingress, an application and policy tier, private agent execution, an external inference gateway, controlled MCP/tool access, credential brokering, durable state, and auditability.

### Success criteria

- A customer can export a project, place it in a Git repository, and build it with documented prerequisites.
- The project can run locally through Aspire and deploy through the same AppHost from a workstation or CI runner.
- A configured harness can execute a durable job and return a validated result.
- Provider credentials do not enter the agent execution environment.
- The execution environment cannot directly reach model providers, privileged control-plane services, or arbitrary network destinations.
- Supported local and remote MCP connections have explicit placement, authority, credential, and lifecycle policies.
- Missing security capabilities block readiness or job admission instead of triggering weaker fallbacks.
- Application code and infrastructure remain inspectable, editable, and upgradeable.
- The TypeScript platform supports both Python tool execution and customer-authored Python agents through approved execution profiles and a common runner contract.

## 2. Decisions and open proposals

### Agreed direction

| Decision | Consequence |
| --- | --- |
| Repository-first delivery | The primary artifact is an editable application repository, not a hosted deployment session. |
| Separate authoring from execution/deployment | The configurator and starter are independently usable. |
| Aspire for composition and deployment | Use existing Aspire commands rather than creating a competing deployment orchestrator. |
| TypeScript platform end to end | Author the configurator, AppHost, services, shared contracts, and reference agent runner in TypeScript. |
| Polyglot customer workloads | Support configurable tool environments and customer-supplied agents implemented with Python or other SDKs without rewriting the platform. |
| Performance-driven platform exceptions | Introduce another platform implementation language only when profiling demonstrates a meaningful bottleneck and an isolated alternative improves the measured outcome. |
| Customer-owned Azure infrastructure | No project-operated service needs ongoing access to customer subscriptions. |
| External inference gateway | Model credentials and refresh logic stay outside agent execution. |
| Credential storage and masking | Separate storage, credential-use mediation, and output redaction. |
| Production hosting architecture as the baseline | Security boundaries are part of the first reference implementation. |
| Local and remote MCP support | Placement is a first-class configuration choice, not merely an endpoint string. |
| Manual local deployment before CI | Customers can understand and operate the deployment before automating it. |

### Recommended starting choices, subject to implementation gates

| Proposal | Reason or gate |
| --- | --- |
| TypeScript AppHost and Node.js services using a pnpm workspace | Keep application code in one language; verify the required Aspire integrations and TypeScript SDK capabilities against pinned versions. |
| React/TypeScript configurator | Reuse the existing configurator's authoring model and validation. |
| TypeScript reference runner using `@github/copilot-sdk` | One first-party runner, with a versioned interoperability contract for customer-supplied runners. |
| Node.js and Python execution profiles first | Cover TypeScript agents using Python tools and Python-authored agents before claiming support for additional language/runtime combinations. |
| Foundry-backed inference first | An existing Azure/Foundry environment is available for the first deployment; use gateway-side managed identity where the selected endpoint supports it. |
| Copilot-authenticated inference as a separate supported route | Must prove entitlement, billing, discovery, and refresh without exposing upstream credentials to execution. |
| PostgreSQL for durable jobs, leases, events, and metadata | Avoid a separate broker and Redis until a measured requirement justifies them. |
| Container Apps for control-plane services | Execution compute remains a separate compatibility decision. |
| API Management for managed inference/remote MCP gateway capabilities | Confirm protocol, networking, tier, cost, and streaming requirements before fixing the default SKU. |
| Linux execution images | Validate the runtime sandbox and native dependencies on the actual Azure target. |
| Public configurator without Azure authentication initially | Project export provides value without a multitenant deployment portal. |

Do not interpret these proposals as proof that a particular released SDK, Azure SKU, or sandbox profile already supports the complete architecture.

### Language policy and runtime terminology

Keep these independent choices explicit:

| Concern | Meaning | Initial direction |
| --- | --- | --- |
| Platform language | Implementation of the builder, control plane, adapters, and deployment tooling | TypeScript |
| Agent implementation | Code using a Copilot SDK to define and run an agent | TypeScript reference runner; customer-authored Python and other compatible runners |
| Tool execution environment | Interpreters, executables, packages, and MCP dependencies available to an agent | Approved Node.js, Python, or combined images |
| Copilot runtime placement | How the SDK reaches the agent engine | Managed child process initially; independent of agent language |
| Isolation backend | Infrastructure and OS policy that confine execution | Selected through the Azure compatibility gate |

For example, a TypeScript agent can execute Python analysis tools, while a customer-authored Python agent can run through the same job service and gateway boundaries. Neither requires a Python control plane.

The one-language preference applies to code maintained as the platform, not to customer workloads or third-party runtimes. Aspire may use .NET internally, the Copilot runtime may be native, and infrastructure can require declarative Bicep/YAML without introducing another application implementation.

Do not maintain parallel Python, Go, or Rust versions of the platform for ecosystem coverage. A future performance-specific component needs profiling, a representative benchmark, a defined latency/throughput/memory/cost improvement, and a narrow interface. Measure inference and tool latency separately from platform overhead before deciding that a language change would help.

## 3. Product boundaries

### Harness Builder

The builder designs and exports:

- Instructions, prompt assets, skills, model preferences, and custom-agent definitions.
- Tool inventories and references to host implementations.
- Local and remote MCP connection definitions.
- Agent implementation and toolchain requirements, mapped to approved execution profiles.
- Required identity and credential references.
- Job input/output contracts and execution limits.
- A supported Azure deployment profile.
- An editable Aspire starter project and actionable preflight diagnostics.

The initial public builder does not need Azure credentials. Downloading a project or configuration bundle is sufficient. Creating a GitHub repository from the UI is a later convenience.

### Agent Service Starter

The starter contains:

- The AppHost, application entry points, and host binding code.
- Durable job admission, execution, cancellation, and result handling.
- The security and infrastructure integrations for the selected profile.
- Local configuration and deployment documentation.
- CI and deployment workflows.
- Focused tests and failure-injection scenarios.

The runtime hosting library should not depend on Aspire. Existing applications should be able to embed it without adopting the complete service template.

The TypeScript starter can also launch customer-supplied runner images. Supporting such workloads does not require generating a second implementation of the control plane or maintaining a first-party runner for every SDK.

### Not in the initial scope

- A hosted, cross-customer deployment or subscription-management service.
- An arbitrary-code build service operated by this project.
- Parallel platform implementations or first-party runners for all six SDK languages.
- A general-purpose workflow engine, agent marketplace, or visual DAG designer.
- Transparent exactly-once agent execution.
- Automatic cold-session migration or uninterrupted multi-hour execution without proven recovery.
- Shared runtime pools, native in-process hosting, or AHP as prerequisites.
- Multiple clouds or simultaneous production support for every Azure execution target.
- Claims that prompt instructions, session IDs, masking, or a child process provide a complete security boundary.

## 4. Repository and packaging strategy

Begin with one development repository for the builder, shared contracts, reusable hosting components, and reference deployment. Keep logical boundaries clear before creating independently versioned repositories or packages.

Suggested development layout:

```text
copilot-sdk-aspire\
  package.json
  pnpm-workspace.yaml
  pnpm-lock.yaml
  apphost.mts
  aspire.config.json
  docs\
  configurator\
  contracts\
  src\
    service-defaults\
    agent-api\
    job-dispatcher\
    agent-executor\
    harness-hosting\
    credential-broker\
  execution-profiles\
  infra\
  templates\
  tests\
  .github\
    workflows\
```

These are responsibility boundaries, not a requirement to deploy every project as a separate service. Co-locate trusted control-plane responsibilities where reasonable. Do not combine the credential boundary with untrusted execution merely to reduce the resource count.

A generated customer repository should be smaller and focused on the selected profile:

```text
MyAgent\
  package.json
  pnpm-workspace.yaml
  pnpm-lock.yaml
  tsconfig.json
  apphost.mts
  aspire.config.json
  harness\
    harness.json
    prompts\
    skills\
  src\
    service-defaults\
    api\
    worker\
    host-bindings\
  execution-profiles\
  infra\
  tests\
  .github\
    workflows\
      ci.yml
      deploy.yml
  README.md
```

### Ownership and upgrades

- Customers own tool implementations, business logic, prompts, and application customization.
- Reusable lifecycle, gateway, policy, and persistence integrations should become pinned dependencies once their boundaries stabilize.
- Generated infrastructure should use versioned modules shared with the reference deployment.
- Record template and schema versions in the generated project.
- Regeneration must not overwrite edited application code. Configuration updates should be narrow or emitted as reviewable changes.
- Prefer one maintained template plus configuration over large, divergent generated architectures.
- Retain a standalone source path; neither running nor deploying should require contacting the public builder.
- Keep customer runner images and toolchain dependencies versioned separately from the TypeScript platform; record their immutable identities with each attempt.

## 5. Configuration contracts

Keep three logical boundaries, without inventing three independent configuration frameworks.

| Boundary | Contents | Authority |
| --- | --- | --- |
| Harness definition | Instructions, assets, tools, agents, model preferences, input/output schemas | Requests capabilities; does not grant them |
| Host bindings | Tool implementations, approved MCP destinations, credential references, workspace/artifact adapters | Controlled by application owners/operators |
| Execution policy | Isolation, egress, deadlines, retry eligibility, concurrency, retention, budgets | Operator-enforced ceiling |

Effective capabilities are the intersection of harness requests, caller authorization, and operator policy.

### Configuration requirements

- Use a versioned, language-neutral schema and explicit migrations.
- Treat the existing configurator's planner JSON as a planning document, not serialized SDK session configuration.
- Normalize the plan and map it to the selected SDK version through an adapter.
- Separate SDK language, runtime placement, application shape, and deployment target. Aspire is not a new SDK language or transport.
- Reference approved agent-runner and toolchain profiles independently. A language selection cannot authorize an arbitrary image, command, package installation, or weaker security profile.
- Store secret references only, never real values.
- Treat prompts, tool schemas, assets, and connection metadata as potentially confidential even when they contain no credentials.
- Reject unsupported options and unresolved required bindings with field-specific errors.
- Validate local asset paths and package them reproducibly; do not export arbitrary host paths.
- Compile custom tool code and MCP dependencies during build, not from untrusted job input.
- Validate policy on both configuration publication and job admission.
- Running jobs retain their admitted configuration and policy snapshot; edits do not silently change in-flight work.

Record harness digest, assets, policy revision, executor and runner image digests, runner protocol version, toolchain profile, SDK/runtime versions, and tool implementation version per attempt. This establishes provenance, not deterministic model behavior.

## 6. Target trust architecture

```text
Customer application / authorized user
                  |
          Authenticated service API
                  |
       Dispatcher + authoritative job state
                  |
        Job-scoped execution authorization
                  |
    +--------------------------------------+
    | Isolated execution environment       |
    | SDK + Copilot runtime                |
    | Job workspace                        |
    | Confined shell / local MCP processes |
    | No upstream inference credentials    |
    | No Azure deployment credentials      |
    +--------------------------------------+
                  |
          Approved routes only
                  |
                  +--> Inference gateway --> Approved model provider
                  +--> Tool/MCP gateway --> Approved connectors
                  +--> Job/artifact API

Gateway and connector identities --> Credential broker / Key Vault
Control plane --> PostgreSQL and artifact storage
All tiers --> Sanitized audit and telemetry
```

### Trust assumptions

- Treat model-generated actions, repository contents, MCP responses, and job inputs as untrusted.
- Trusted host tool handlers are application code; the runtime's child sandbox does not automatically constrain them.
- The control plane and gateways are trusted to enforce authorization, but must not execute agent-generated code.
- One customer-owned trust boundary per deployment is the initial default. Do not market it as hardened cross-customer SaaS isolation.
- Process separation is a lifecycle and credential-handling boundary, not equivalent to a VM or tenant boundary.
- The service has no public runtime control port. Expose only authenticated application endpoints.
- Public service access, where enabled, requires both authentication and application authorization. "Any signed-in Entra user" is insufficient.

### Execution identity

The executor must not have:

- Azure resource deployment or role-assignment permissions.
- Key Vault secret-reading permissions for upstream credentials.
- Direct model-provider authorization.
- Broad database or artifact-store access.
- Access to a developer's CLI credential cache or host home directory.

Prefer a job-scoped gateway capability or narrowly scoped workload identity. Bind authorization to the job, principal, permitted operations, expiry, and budget. Assume compromised job code can exercise any capability reachable within its environment.

The dispatcher owns job leases and authoritative state. Executors report progress and results through an authenticated boundary rather than receiving database administrator credentials.

## 7. Inference gateway

### Responsibilities

- Resolve approved provider/model routes from trusted configuration.
- Own provider credentials and refresh outside execution.
- Authenticate the caller and authorize the job/model combination.
- Enforce request-size, concurrency, rate, and usage limits.
- Preserve streaming, cancellation, tool-call payloads, and provider errors.
- Reject arbitrary upstream URLs, credential forwarding, and caller-supplied identity assertions.
- Remove untrusted authentication headers before attaching upstream credentials.
- Apply explicit destination and redirect rules.
- Record usage and sanitized operational metadata without logging prompts or response bodies by default.
- Never silently fall back to a direct provider connection or an unapproved provider.

Do not automatically retry partially streamed inference as if nothing happened. Distinguish transport failure before acceptance from an unknown or partially delivered outcome.

### Foundry route

Use the existing Foundry environment for the first reference deployment:

- Select the actual model deployment, API shape, region, and endpoint.
- Use gateway-side managed identity if that endpoint supports it.
- Assign the minimum provider-specific role at the required scope.
- Keep provider credentials out of the executor even in local development.
- Confirm supported API semantics rather than assuming all Foundry endpoints are interchangeable.
- Treat model entitlement, quota, and region availability as prerequisites, not resources the template can guarantee.

### Copilot-authenticated route

The SDK contains an experimental inference request handler and the runtime has a registered inference-provider callback path. This is an integration opportunity, not proof of a credential-free Copilot runtime.

Before supporting this route, demonstrate:

- Session creation and model discovery without giving upstream credentials to execution.
- Correct user/organization entitlement and policy behavior.
- Correct usage attribution and billing identity.
- Token acquisition and refresh outside execution.
- Coverage of auxiliary model requests, subagents, and background inference.
- Streaming, cancellation, and provider-disconnection behavior.
- No direct-network fallback.

The inference-provider registration is runtime/server scoped and must be installed before sessions are active. Its lifecycle and ownership must be reflected in the hosting design.

Do not substitute BYOK silently if the Copilot route is unavailable. Report the unsupported combination or identify the required SDK/runtime enhancement.

### Token lifetime

The currently reviewed S2S path uses GitHub App installation tokens in runtime environment authentication and documents runtime restart for refresh. A gateway-only alternative must be proven before it replaces that constraint.

An active token broker is required for short-lived installation credentials. APIM Key Vault named-value refresh is not a sufficient one-hour installation-token refresh strategy.

## 8. Credential storage, use, and redaction

### Storage

- Azure Key Vault is the production credential source of truth.
- Scope gateway and connector identities to their required secrets.
- Prefer managed identity over stored keys when the upstream service supports it.
- Do not export credentials into source, image layers, harness documents, browser storage, deployment URLs, or deployment outputs.
- Do not use the runtime's OS keychain/file fallback as the production vault.
- Define rotation, revocation, cache expiry, and failure behavior.
- Do not keep using stale credentials indefinitely when refresh fails.

### Credential use

- The default strict profile keeps inference and remote MCP credentials outside execution.
- Credential-dependent tools should preferably execute in separate trusted connectors.
- Local credential masking is an explicit compatibility profile: it can protect child processes while real values remain in runtime-side memory.
- Document that this local-masking profile is weaker than keeping all downstream credentials outside the entire execution environment.
- Token destinations, audiences, and scopes come from approved bindings, not model arguments.
- A destination allowlist constrains where a credential can be used; it does not authorize every operation at that destination.

### Redaction

- Disable payload capture in runtime, application, gateway, and tracing exporters by default.
- Remove credentials and sensitive headers before persistence or telemetry export.
- Use structured event allowlists instead of serializing arbitrary SDK events and exceptions.
- Cover tool output, errors, OAuth diagnostics, SSE payloads, crash diagnostics, and artifact publication.
- Reuse runtime secret filtering as defense in depth, not as proof that application-side logs are safe.
- Do not distribute secrets to the executor just to populate its redactor.
- Treat response data from authenticated upstreams as sensitive; an upstream can echo a credential.
- Acknowledge that transformed or unknown secrets cannot be reliably eliminated by string matching.

## 9. Runtime sandbox and masking integration

The reviewed runtime has OS-backed child-process confinement and separate policy checks for in-process tools. Its documented sandbox is experimental/feature-gated in the reviewed source.

### Required execution policy

- Use empty mode with explicit base/session storage and explicit tool allowlists.
- Enable the required sandbox before any untrusted initialization or execution.
- Prohibit sandbox bypass and MCP/LSP sandbox opt-outs.
- Disable ambient instruction discovery, repository hooks, plugins, and host Git operations unless explicitly required and reviewed.
- Disable automatic broad developer-tool/cache grants; add narrowly required paths.
- Use per-job workspace and temporary storage.
- Do not mount credential stores, Docker sockets, deployment state, or developer home directories.
- Enforce explicit network policy; an empty `allowedHosts` list is not deny-all in the reviewed runtime.
- Restrict access to metadata services, local control endpoints, private destinations, and DNS-based destination changes through the complete network architecture.
- Keep enforcement errors visible and fail closed.

### Initialization ordering

The reviewed developer documentation says high-level create/resume APIs do not forward sandbox configuration directly; a subsequent options update is available.

The implementation must not create MCP processes, run hooks, discover executable extensions, or perform other untrusted initialization before policy is applied. Establish a supported initialization sequence or obtain a suitable API change. Merely setting policy before the first user prompt is not sufficient.

Requested settings are not necessarily effective settings. Managed policy and runtime session state must be accounted for when displaying or verifying enforcement.

### Linux prerequisites

The reviewed Bubblewrap path requires Linux user namespaces and `bwrap`. Outbound-network profiles also require `slirp4netns`, suitable util-linux tools, iptables tooling, and access to `/dev/net/tun`.

An outer container platform may deny namespaces or required device access. Installing packages into an image does not prove enforcement will work.

Probe the actual Azure environment with the intended image and policy. Do not enable broad privilege or disable confinement to make the deployment pass.

### Credential masking limits

- Selected child environment values become per-launch sentinels.
- Substitution occurs at approved HTTPS header destinations after upstream certificate validation.
- Runtime masking does not generally cover inference, remote MCP authentication, arbitrary secret files, request bodies, URLs, signed requests, or non-HTTP protocols.
- The documented interception path has HTTP/client-trust compatibility limitations, including certificate pinning and JVM-specific configuration.
- Bypass or opted-out child routes lose masking protection.
- Masking proxy CA private material and credential registries must remain inaccessible to job code.
- Certificate/trust material and child leases need explicit lifecycle and cleanup.

## 10. Execution profiles and Azure target gate

### Configurable agent and tool runtimes

Support both meanings of a customer choosing Python:

| Example | Agent implementation | Tools available inside the approved environment |
| --- | --- | --- |
| Default starter | TypeScript Copilot SDK runner | Node.js and explicitly packaged tools |
| Python-capable tools | TypeScript Copilot SDK runner | Python interpreter, pinned Python dependencies, and approved local MCP servers |
| Python-authored agent | Customer runner using the Python Copilot SDK | Python and any other explicitly packaged tools |
| Other customer agent | Runner using another compatible SDK | Its reviewed image and declared toolchain |

An execution profile records the immutable image, approved entrypoint, supported runner protocol, agent SDK/runtime versions, toolchain/dependency versions, required capabilities, resource limits, and security-policy reference.

Operators approve profiles before job callers can select them. Custom images are treated as untrusted execution workloads, not trusted extensions loaded into the control-plane process. Language choice must not grant credentials, disable confinement, or expand network access.

Build dependencies into images from versioned manifests and lockfiles. Platform developers should not need every customer's interpreter installed locally; the selected execution image supplies workload dependencies. A combined Node/Python tool image does not imply a Python SDK agent implementation.

### Customer runner contract

Define a small, versioned job-runner protocol with a TypeScript host adapter. Select its concrete transport during the compatibility milestone based on the execution target; do not expose an unauthenticated runtime port for convenience.

The contract must cover:

- A start envelope with job/attempt identity, approved harness and profile references, structured input, deadline, and trace context.
- Capability/version negotiation before job admission.
- Ordered progress events, structured terminal results, and explicit failures.
- Cancellation, bounded shutdown, and executor lifecycle/health reporting.
- Approved inference, MCP/tool, and artifact access through job-scoped authorization.
- Stable idempotency context for tools with external effects.
- Runtime cleanup and reporting of uncertain external outcomes.

The dispatcher remains authoritative. A customer runner cannot choose its tenant identity, self-approve broader capabilities, extend its lease, or declare a security prerequisite satisfied merely by reporting success.

Validate requested capabilities against the language SDK and runtime combination. An unsupported sandbox, gateway, credential, or cancellation integration must be rejected rather than emulated with an unsafe fallback.

Python-authored agents are an initial interoperability acceptance target. Additional SDK languages are supported only after their runner/profile passes the same contract and boundary requirements; language-neutral does not mean automatically compatible.

### Azure target compatibility

Do not select execution compute solely because Aspire can deploy a container to it.

| Candidate | Intended role | Required evidence |
| --- | --- | --- |
| Ordinary Azure Container Apps | API, dispatcher, gateway adapters, trusted connectors; possibly constrained execution | Runtime namespace/device support and enforceable routing for the selected execution profile |
| Dynamic Sessions custom containers | Disposable outer isolation for untrusted execution | Gateway connectivity, egress enforcement, lifecycle, image compatibility, artifact transfer, and runtime sandbox compatibility |
| Azure Container Apps Sandboxes preview | Experimental isolated execution target with Aspire integration | Preview access, actual endpoint authorization, destination policy, data-plane lifecycle, and runtime compatibility |
| Supported VM-backed pool | Alternative when managed container targets cannot enforce requirements | Reproducible hardened images, per-job isolation, patching, autoscaling, cleanup, and operational cost |

Dynamic Sessions' egress-enabled setting is not an approved-destination policy by itself.

The reviewed Aspire Sandboxes target is preview, uses additional data-plane deployment steps, and exposes external endpoints with authentication behavior that still requires application-level tenant/principal authorization. Its behavior must not be assumed equivalent to private Container Apps service discovery.

Reject unsupported profiles. Keep the production gate explicit rather than shipping a misleading "secure" checkbox.

## 11. MCP deployment model

| Placement | Packaging and access | Credential handling |
| --- | --- | --- |
| Job-local stdio | Pinned executable/dependencies in the execution image; confined process with job workspace | No secrets by default; explicit supported masking profile only when necessary |
| Customer-hosted private service | Separately deployed connector or MCP service, private routing, reviewed tool exposure | Connector identity or broker-owned credentials |
| Existing remote HTTPS service | Approved endpoint through a compatible gateway/connector | Upstream auth and refresh outside the executor |
| Laptop/on-premises service | Local-only by default; explicit private connectivity or supported connector for Azure | Customer-managed connection and consent |

### Required behavior

- The configurator distinguishes transport, placement, startup dependencies, tool grants, and credential modes.
- A developer-machine `localhost` endpoint cannot be exported as a working cloud service.
- Build local MCP dependencies into images; do not run arbitrary package installers on job startup.
- Use explicit environment allowlists, working directories, and resource limits.
- Do not share mutable MCP process state across unrelated trust boundaries.
- Treat MCP tool descriptions, instructions, resources, and responses as untrusted input.
- Enforce operation and downstream-resource authorization outside the model.
- Distinguish service-account credentials from delegated user OAuth.
- Consent and scope escalation require a defined administrator/user flow; never replace delegated access with a shared account silently.
- Headless authentication failure becomes an actionable state, not an indefinitely blocked worker.
- Do not log raw OAuth challenge diagnostics or resolved client secrets.
- Preserve streaming/cancellation semantics through gateways.
- Validate gateway support for the selected MCP protocol, transport, tools, resources, and prompts. APIM support is not universal MCP compatibility.

## 12. Durable job semantics

The application job ledger is authoritative. SDK sessions are execution context, not a replacement for a durable queue.

### State model

```text
queued -> running -> succeeded
             |
             +-> retry_wait -> queued
             +-> cancel_requested -> cancelled
             +-> failed
             +-> needs_review
```

Attempt records and renewable leases track ownership separately from the public job state. A queued job can be cancelled without starting an attempt.

### Admission and ownership

- Return acceptance only after the job and immutable execution references are durable.
- Scope idempotency keys to the authenticated caller/tenant and operation.
- Reject reuse of an idempotency key with different input.
- Claim jobs atomically with a lease, heartbeat, and fencing/attempt token.
- Reject stale-worker updates.
- Generate opaque job/session IDs and store ownership in the database.
- Reauthorize all status, event, cancellation, retry, resume, and artifact operations.
- Preserve authorization and budget boundaries when retrying or resuming.

### Effects and retries

- Assume at-least-once execution.
- Durable inputs do not make external tool effects safe to repeat.
- Mutating tools need stable business-operation idempotency or query/reconcile support.
- Fencing protects owned state; it cannot undo an already dispatched external action.
- Distinguish configuration/authentication/authorization failures from eligible transient failures.
- Use bounded backoff, retry counts, deadlines, and cost limits.
- An uncertain external outcome becomes `needs_review` or a defined reconciliation state.
- Do not retry an entire turn blindly after successful earlier tool effects.

### Cancellation and completion

- Persist cancellation intent and propagate it through runtime, inference, MCP, and host tools.
- Cancellation is not rollback.
- Reconcile effects before claiming an unqualified cancelled outcome.
- Validate the expected output schema and business completion conditions.
- Runtime idle or an assistant message is not sufficient proof of success.
- Unattended jobs cannot wait forever for interactive prompts or approvals. Initially reject unsupported interaction or report a bounded needs-review outcome.

### Persistence and recovery

Keep separate:

- Durable job/attempt/event metadata.
- Durable input and output artifacts.
- Optional runtime conversation/session state.

Start with bounded independent jobs and retries restricted to safe workloads. Later add durable session recovery only after proving storage semantics, callback/credential reattachment, exclusive ownership, and version compatibility.

Avoid sharing writable runtime home directories between active executors. Session filesystem abstractions do not eliminate locking, consistency, or authorization requirements.

## 13. Service API

Initial application API, subject to contract review:

```text
POST /v1/jobs
GET  /v1/jobs/{jobId}
GET  /v1/jobs/{jobId}/events
POST /v1/jobs/{jobId}:cancel
POST /v1/jobs/{jobId}:retry
GET  /v1/jobs/{jobId}/artifacts
GET  /health
GET  /alive
```

- Submission references an approved immutable harness version, structured inputs, and artifact references.
- Submission selects an approved runner/toolchain profile where the harness permits it; profile compatibility is checked before queuing.
- Ordinary job callers cannot upload executable handlers, choose arbitrary MCP URLs, or weaken isolation.
- SSE supports ordered application events and reconnect cursors.
- Do not expose raw SDK events as a permanent public contract.
- Administrative harness publication is separate from job execution authorization.
- Start with file/Git-based harness publication; add authenticated runtime publication when needed.
- Keep readiness and liveness distinct and expose production health routes only through appropriate network/access controls.

## 14. Azure infrastructure

The supported deployment profile should provision or explicitly attach:

- Control-plane compute and the selected execution target.
- Key Vault and narrowly scoped managed identities.
- Inference gateway and required credential-broker integration.
- Approved MCP services/connectors and gateway routes.
- PostgreSQL, artifact storage, and retention configuration.
- Container registry and image-pull identity.
- Network boundaries, routing, private endpoints/DNS where required, and egress enforcement.
- Production telemetry export, access controls, and audit retention.

Use Aspire integrations where supported and reusable provisioning/Bicep modules for remaining resources. Keep security configuration in the deployment source rather than a list of manual portal steps.

### Customer-supplied inputs

- Tenant, subscription, region, and new/existing resource group.
- Existing or new network profile.
- Foundry/model resource and deployment selection.
- Required model entitlement/quota.
- Existing credential references or external consent.
- Capacity and budget limits.

Minimize inputs through defaults and discovery, but do not hide unavoidable prerequisites.

### Permissions and costs

- Deployment requires resource-write and deployment permissions.
- Identity role assignments require separate authorization; Contributor alone may be insufficient.
- Existing model resources outside the deployment group may require separately scoped grants.
- Prefer narrowly scoped deployment identities over subscription-wide Owner.
- Show fixed infrastructure costs and capacity choices; scale-to-zero execution does not make gateways, storage, databases, or networking free.
- Tag created resources and distinguish them from attached customer-owned resources.
- Cleanup must never delete attached resources as if they were created by the starter.
- Azure policy, region availability, preview access, and provider registration can block deployment. Surface actionable diagnostics.

## 15. Scaling and operational behavior

- Scale from dispatchable backlog, active leases, worker capacity, and queue age.
- Include in-flight work in the scaling design; queue depth can drop to zero while jobs are still running.
- Bound worker concurrency, per-principal/tenant usage, and total provider pressure.
- More compute does not create more model quota.
- Apply backpressure and admission control rather than allowing unbounded pending work.
- Stop claiming work during drain; continue necessary lease renewal until an orderly handoff or termination.
- Assume forced termination remains possible despite grace periods and cooldowns.
- Restore safe work or mark uncertain effects explicitly after lease expiry.
- Evaluate KEDA's PostgreSQL scaler against the actual Azure target and authentication path.
- If a separate broker becomes necessary, use an outbox or equivalent durable handoff rather than an unreliable database/message dual write.
- Plan retention and deletion for job records, events, artifacts, runtime state, and local masking material.

## 16. Observability

Correlate request, job, attempt, harness version, executor, runtime session, and approved tool operations.

Initial signals:

- Admission, queue delay, active leases, attempts, completion, and failure classification.
- Runtime startup and readiness.
- Inference latency, usage, provider throttling, and budget rejection.
- Tool authorization decisions and execution outcomes.
- Sandbox/policy failures and blocked egress.
- Credential refresh failures without credential values.
- Cancellation progress, stale-owner updates, and reconciliation backlog.

Use bounded-cardinality metrics; keep per-job details in access-controlled traces/events. Disable content capture by default. The Aspire Dashboard is a development aid, not the job ledger or a public customer management UI.

The TypeScript SDK integration must explicitly wire the supported trace-context callbacks and restore context around host tool execution. Customer runners propagate the same job/attempt trace context across their process or service boundary.

## 17. Local developer workflow

The commands below run against this repository's reference implementation; the README has the exact parameters. A generated customer repository would expose the same commands.

Prerequisites:

- Pinned compatible Node.js, pnpm, and Aspire CLI versions.
- Aspire's host prerequisites for the selected version, including .NET components if required; generated application code remains TypeScript.
- Azure CLI and an authorized account.
- Supported container engine.
- Selected TypeScript SDK/runtime distribution and approved execution images; Python and other workload prerequisites are packaged in those images.
- Access to the selected model deployment and approved MCP services.

### Build and run

```powershell
az login --tenant "<tenant-id>"

pnpm install --frozen-lockfile
pnpm build

aspire run --apphost .\apphost.mts
```

The generated workspace must provide the documented build scripts and a committed lockfile. Customers build custom agent/tool images from their own repositories; the TypeScript platform does not require those implementations to use TypeScript.

The AppHost should provide local dependencies, endpoint wiring, health, and telemetry. The gateway can use a developer identity locally, but executor processes and containers must not inherit its credential cache.

Local behavior should retain the same policy intent. Unsupported sandbox enforcement must be reported; production claims cannot be inferred from an unsandboxed local run.

### Inspect and deploy

```powershell
$env:Azure__SubscriptionId = "<subscription-id>"
$env:Azure__Location = "<azure-region>"
$env:Azure__ResourceGroup = "my-agent-staging"

aspire deploy `
  --apphost .\apphost.mts `
  --environment Staging `
  --list-steps

aspire deploy `
  --apphost .\apphost.mts `
  --environment Staging
```

Listing pipeline steps is not an Azure resource-change preview. Provide the appropriate validation/what-if path for the profile and require deliberate approval before applying infrastructure changes.

### Artifact-first deployment

```powershell
aspire publish `
  --apphost .\apphost.mts `
  --environment Staging `
  --output-path .\artifacts\deployment
```

Publish emits artifacts for an external deployment workflow. It is not a prerequisite for `aspire deploy`, and `aspire deploy` does not simply apply previously published files.

Targets with additional image or data-plane operations must include those steps in the documented workflow. A Bicep/ARM export alone is not automatically the complete Aspire deployment.

## 18. CI/CD and release lifecycle

### Customer repository automation

- CI builds, validates configuration, runs tests, and checks images without production deployment credentials.
- Deployment begins as a manual workflow with protected environments and explicit target selection.
- Use GitHub Actions OIDC/workload identity federation rather than stored Azure client secrets.
- Provide an explicit one-time bootstrap for the deployment identity and federated repository/environment trust.
- Restrict federated subjects and role scopes; do not grant credentials to untrusted pull-request code.
- Invoke the same AppHost pipeline used locally rather than reimplementing infrastructure in workflow YAML.
- Pin dependencies, actions, container bases, and runtime versions.
- Build and validate approved runner/toolchain images separately when their customer-owned code or dependencies change.
- Record image digests and provenance; define how signature verification is enforced rather than assuming signing alone is sufficient.
- Make database migrations and application rollback/version compatibility explicit.

### Shared starter releases

Release the template, schema, hosting components, and infrastructure modules as a compatible set. Include upgrade notes and configuration migrations. Avoid automatic regeneration that destroys customer edits.

## 19. Configurator implementation and distribution

Reuse the existing builder's React components and domain concepts selectively:

- Plan schema and validation.
- Plan analysis and required host bindings.
- SDK configuration projection.
- Bootstrap export structure and blocker reporting.
- Hosting architecture explanations.

Add an application/deployment export target rather than treating Aspire as another SDK language. Preserve import/export compatibility through explicit version handling.

### Initial user journey

```text
Create/import harness
  -> Choose model route and MCP placement
  -> Select agent runner, toolchain, and supported execution/deployment profile
  -> Review capabilities, credential references, and costs
  -> Export editable project
  -> Put code in customer repository
  -> Implement required bindings
  -> Build and run locally
  -> Deploy manually
  -> Enable CI deployment
```

Do not publish internal research catalogs, unpublished capabilities, private assets, or source snapshots merely because they exist in the internal configurator. Public distribution needs a deliberate content and dependency review.

### Later convenience features

- Public template repository and optional create-repository flow.
- Local configurator experience for editing an existing harness.
- Azure Portal deployment handoff for prebuilt profiles.
- Direct browser-based Azure deployment for profiles with packaged deployment steps.

The direct-browser option would use MSAL authorization code flow with PKCE and delegated ARM access. It adds consent, tenant selection, browser token handling, RBAC diagnostics, and deployment recovery; it is not required for the initial product.

Keep deployment and confidential harness publication separate. Do not place customer prompts or credentials into public template URLs or ordinary deployment parameters. Private services require private connectivity, customer-hosted tooling, or CI for publication.

## 20. Delivery milestones

| Milestone | Scope | Exit condition |
| --- | --- | --- |
| M0: compatibility and threat-model decisions | Pin TypeScript SDK/runtime and Aspire candidates, define the runner protocol, select initial model route, compare execution targets, map trust boundaries | Documented supported profiles and explicit blockers, including Python interoperability requirements; no unsupported security claims |
| M1: secure reference execution | External Foundry inference, isolated execution, TypeScript reference runner, Python tool environment, customer Python runner interoperability, one local and one remote MCP integration | TypeScript and Python-agent jobs complete through the same authorized boundaries without upstream inference credentials in execution; prohibited access is blocked |
| M2: durable service | Admission, leases, attempts, events, cancellation, results, artifact retention | Accepted jobs survive control-plane restart; worker loss produces safe recovery or explicit uncertainty |
| M3: reproducible Azure deployment | AppHost, provisioning modules, identities, networking, gateway policies, capacity settings | Deployment from a clean checkout works in the available Azure environment without undocumented portal edits |
| M4: starter and configurator export | TypeScript customer template, normalized harness contract, runner/toolchain selection, host binding diagnostics, reusable UI | Exported project builds, runs, and deploys with approved profiles; customer edits survive configuration updates |
| M5: customer automation and distribution | OIDC deployment workflow, template releases, upgrade path, public-safe content | A second repository/subscription onboarding exercise succeeds using only published instructions |

M1 includes security integration; it is not a plain execution demo with security deferred. M2 and M3 must use the same boundaries rather than reintroducing broad worker credentials.

The first representative workload should be a read-only analysis job with structured results. Add effectful tools only after idempotency and reconciliation contracts are implemented.

## 21. Acceptance and failure scenarios

| Area | Required scenario |
| --- | --- |
| Configuration | Unknown schema/options, unresolved tools, invalid assets, or policy widening are rejected before execution |
| Runtime selection | A TypeScript agent executes Python tools, and a customer Python SDK agent uses the same service contract; unsupported profile/capability combinations are rejected |
| Inference | Streaming and cancellation work through the gateway; a gateway outage does not trigger direct-provider fallback |
| Credentials | Canary credentials do not appear in child environments, workspaces, job events, traces, artifacts, or deployment outputs outside their explicitly authorized boundary |
| Rotation | Gateway refresh and revocation work during supported job lifetimes; failures are explicit |
| Sandbox | Prohibited filesystem access, bypass, process routes, direct egress, and metadata access are blocked on actual deployment compute |
| Initialization | No untrusted MCP/hook process starts before the effective confinement policy is established |
| Masking | Supported clients work; unsupported TLS/protocol cases fail without exposing real credentials |
| MCP | Local packaging, remote authentication, refresh, denied tools, cancellation, and headless auth failure behave as documented |
| Job ownership | Duplicate submission, concurrent claims, expired leases, and stale-worker completion are handled consistently |
| Effects | Worker loss before/after an external side effect produces safe retry or reconciliation, not duplicate success |
| Cancellation | Cancel before start, during inference, during MCP, and during an effectful tool |
| Results | Invalid/missing structured output is not reported as successful completion |
| Events | Reconnect cursors preserve event ordering and authorization without exposing raw sensitive SDK payloads |
| Scaling | Bursts distribute work; provider throttling applies backpressure; forced scale-in does not silently lose admitted jobs |
| Tenancy | Cross-principal job/session/artifact access and forged identity headers are denied |
| Deployment | Missing RBAC, region support, quota, or preview access produces actionable failure and identifiable partial resources |
| Local/CI parity | The same AppHost and parameters drive both manual and automated deployment |
| Language interoperability | Runner protocol, cancellation, results, trace correlation, and security invariants hold across supported agent languages |
| Upgrades | Configuration migration, image pinning, schema changes, and rollback retain supported job/state behavior |

Use deterministic fakes for inexpensive contract tests and opt-in real-provider/Azure scenarios with explicit cost limits. Before declaring performance readiness, choose workload-specific targets for cold start, queue delay, concurrency, memory, cancellation latency, and cost; measure those exact targets instead of borrowing unrelated runtime benchmarks.

## 22. Principal risks and release gates

| Risk | Required response |
| --- | --- |
| Runtime sandbox cannot operate on chosen managed compute | Change execution target or reject profile; never silently weaken enforcement |
| High-level SDK initialization starts capabilities before sandbox policy | Establish safe supported sequencing or obtain an API change before release |
| Copilot auth requires credentials inside the runtime | Gate that provider profile and pursue a supported gateway integration; do not mislabel BYOK |
| Local masking is interpreted as whole-environment secretlessness | Expose the trust distinction and prefer external connectors |
| Gateway buffering or transformations break inference/MCP | Conformance scenarios for every supported API/transport |
| Managed identity becomes accessible to job code | Remove broad identity privileges; enforce narrow gateway capability and endpoint access |
| Autoscaling duplicates externally visible effects | Stable effect idempotency, ownership fencing, and reconciliation |
| Confidential harness data leaks through deployment tooling | Separate publication and minimize/redact deployment metadata |
| Public export drifts from internal SDK/runtime snapshots | Pin a supported compatibility matrix and review public content |
| A new agent language bypasses platform safeguards | Require the same runner conformance and execution-profile admission gates; do not trust language-specific claims of enforcement |
| Premature platform rewrites add complexity without benefit | Keep platform code TypeScript unless profiling and representative benchmarks justify a bounded performance-specific component |
| Too much platform work delays usable delivery | Focus on one secure reference profile and repository workflow before optional portals and targets |

## 23. Research sources and compatibility notes

The following local checkout revisions were recorded when creating this plan:

| Repository | Revision |
| --- | --- |
| `github/copilot-sdk` | `19e9a4b9c620d1032110cb6739961c4c1a651278` |
| `github/copilot-agent-runtime` | `216810c58bc1a46169fa6c5cd4680ca83d6189f2` |
| `github/copilot-sdk-internal` | `1fab2cf337ad19a529343bea00d1bf89583344eb` |

These identify research snapshots, not a selected production dependency set. Source availability, documentation, experimental annotations, and published package support can differ. Reconcile them during M0.

### Local source references

- `..\copilot-sdk-internal\configurator\README.md`: builder boundaries and existing exports.
- `..\copilot-sdk-internal\configurator\src\domain\plan.ts`: existing planner schema.
- `..\copilot-sdk-internal\configurator\src\domain\bootstrap\common.ts`: SDK configuration projection and host requirements.
- `..\copilot-sdk-internal\configurator\src\domain\bootstrap\typescript.ts`: TypeScript generation and required bindings.
- `..\copilot-sdk-internal\configurator\src\content\hosting.ts`: production architecture responsibilities.
- `..\copilot-sdk\docs\setup\multi-tenancy.md`: empty mode, explicit tools, and ownership requirements.
- `..\copilot-sdk\docs\auth\server-to-server-tokens.md`: current installation-token authentication and refresh constraints.
- `..\copilot-sdk\nodejs\src\types.ts` and `client.ts`: runtime options, empty-mode requirements, and SDK lifecycle.
- `..\copilot-sdk\nodejs\src\copilotRequestHandler.ts`: TypeScript inference request handler.
- `..\copilot-sdk\nodejs\src\generated\rpc.ts`: experimental sandbox configuration contract.
- `..\copilot-agent-runtime\docs\developer-docs\sandbox.md`: policy scope, masking limitations, initialization notes, and Linux prerequisites.
- `..\copilot-agent-runtime\docs\sdk-mcp-host-token-injection.md`: remote MCP OAuth lifecycle and sensitive diagnostic fields.
- `..\copilot-agent-runtime\src\runtime\src\shared_api\llm_inference.rs`: provider registration ownership and no-direct-fallback behavior.
- `..\copilot-agent-runtime\src\runtime\src\sandbox_base\secret_store.rs`: runtime keychain/file fallback, distinct from Azure Key Vault.

Local paths are relative to the repository root and assume sibling research checkouts. They are not dependencies of the future generated customer project.

### External references

- [What Aspire is](https://aspire.dev/get-started/what-is-aspire/)
- [Aspire languages and runtimes](https://aspire.dev/languages-and-runtimes/)
- [Aspire Azure deployment](https://aspire.dev/deployment/azure/)
- [Aspire Container Apps deployment](https://aspire.dev/deployment/azure/container-apps/)
- [Aspire Azure Sandboxes deployment, preview](https://aspire.dev/deployment/azure/sandboxes/)
- [Aspire run](https://aspire.dev/reference/cli/commands/aspire-run/)
- [Aspire deploy](https://aspire.dev/reference/cli/commands/aspire-deploy/)
- [Aspire publish](https://aspire.dev/reference/cli/commands/aspire-publish/)
- [Aspire CI/CD](https://aspire.dev/deployment/ci-cd/)
- [Azure API Management AI gateway](https://learn.microsoft.com/en-us/azure/api-management/genai-gateway-capabilities)
- [API Management remote MCP support](https://learn.microsoft.com/en-us/azure/api-management/expose-existing-mcp-server)
- [API Management Key Vault references](https://learn.microsoft.com/en-us/azure/api-management/api-management-howto-properties)
- [Container Apps network controls](https://learn.microsoft.com/en-us/azure/container-apps/firewall-integration)
- [Container Apps Dynamic Sessions](https://learn.microsoft.com/en-us/azure/container-apps/sessions)
- [Dynamic Sessions usage and security](https://learn.microsoft.com/en-us/azure/container-apps/sessions-usage)
- [KEDA PostgreSQL scaler](https://keda.sh/docs/2.18/scalers/postgresql/)
- [Azure role assignment prerequisites](https://learn.microsoft.com/en-us/azure/role-based-access-control/role-assignments-template)
- [Deploy to Azure button](https://learn.microsoft.com/en-us/azure/azure-resource-manager/templates/deploy-to-azure-button)
- [Microsoft identity authorization code flow and PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)

## 24. Implementation status

Date: 2026-10-02. This section records what the reference implementation in this repository delivers against the
milestones in section 20, how it was verified, and which gates remain open. [SECURITY.md](SECURITY.md) has the
boundary-by-boundary detail.

### Pinned compatibility set

| Component | Version | Notes |
| --- | --- | --- |
| Aspire CLI and hosting integrations | 13.6.0 | TypeScript AppHost (`apphost.mts`); integrations restored through NuGet |
| `@github/copilot-sdk` | 1.0.16 | Bundles runtime 1.0.90; BYOK provider requires no GitHub authentication |
| `github-copilot-sdk` (Python) | 1.0.14 | Runtime 1.0.85 downloaded into the execution image at build time |
| Node.js / Python in execution image | 24 / 3.11 | Debian bookworm base |
| Model route | Foundry `grok-4.6` | OpenAI v1 chat completions, Entra authentication |

### Milestones

| Milestone | State | Evidence |
| --- | --- | --- |
| M0 compatibility and threat model | Partial | SDK BYOK verified for TypeScript and Python against Foundry with Entra tokens; runner protocol v1 defined ([RUNNER-PROTOCOL.md](RUNNER-PROTOCOL.md)); uid-based runner isolation verified locally and on Container Apps. Runtime OS sandbox and egress enforcement on Container Apps not yet probed or available. |
| M1 secure reference execution | Done, with acknowledged gaps | External gateway with job-scoped capabilities; TypeScript reference runner using a pinned Python tool; customer Python runner on the same contract; no provider, database, or service credential in runner environments (inspected on live processes). Gaps: egress not enforced (explicitly acknowledged in policy), MCP integrations not implemented. |
| M2 durable service | Done | PostgreSQL ledger with idempotent admission, fenced leases, heartbeats, lease recovery, retry/backoff, `needs_review` for uncertain effects, cancellation with capability revocation, ordered events with SSE cursors, output schema validation. Covered by integration tests. |
| M3 reproducible Azure deployment | Done | `aspire deploy` from a clean checkout created Container Apps, ACR, PostgreSQL (Entra-only), identities, and a least-privilege model role on the existing Foundry account. TypeScript and Python agent jobs succeeded in Azure; cancellation verified; internal services not routable from the internet. |
| M4 starter and configurator export | Not started | |
| M5 customer automation and distribution | Not started | OIDC deployment workflow and template releases remain. |

### Decisions taken during implementation

- **Inference capability.** Runners authenticate to the gateway with an HS256 JWT minted per attempt (models,
  token budget, expiry). The gateway checks revocation and remaining budget with the dispatcher on each request
  (2-second cache) and reports usage back. Capabilities are revoked on cancellation and attempt completion.
- **Executor eligibility.** Executors report the controls they enforce. A policy requirement that an executor
  cannot meet blocks claiming unless the operator lists it in `acknowledgedGaps`; acknowledged gaps are stored on
  each attempt and returned with the job. The shipped policy requires uid isolation and gateway-only egress and
  acknowledges only `egress-not-enforced`.
- **Execution placement.** Runners execute as child processes of the executor container under a dedicated uid.
  Per-job outer isolation (Dynamic Sessions, VM pools) remains future work behind the same runner protocol.
- **Configuration publication.** Harnesses, execution profiles, and policy are file-published and baked into
  images, matching the "file/Git-based publication first" decision in section 13.
- **Deployment inputs.** `aspire deploy` runs in the Production environment and reads `Azure__*` and
  `Parameters__*` environment variables; user secrets are a development convenience only.

### Open gates before production claims

1. Enforce egress (dedicated execution environment with network rules or per-job sandbox) and remove the
   `egress-not-enforced` acknowledgement.
2. Probe and enable the Copilot runtime sandbox on the execution target once the SDK exposes safe initialization.
3. Private networking for PostgreSQL and least-privilege database roles.
4. Key Vault-backed service keys with rotation; Entra ID caller authentication instead of API keys.
5. Local and remote MCP placements through the gateway/connector model.
6. CI with OIDC deployment (M5) and the configurator export (M4).
