# Maintaining the knowledge base

[Documentation hub](README.md) | [Contributing](../CONTRIBUTING.md)

Documentation is part of the implementation change, not a separate cleanup phase. Keep current behavior,
user expectations, and known limitations synchronized without turning every page into a copy of the README.

## Sources of truth

| Question | Primary evidence | Documentation home |
| --- | --- | --- |
| What inputs and messages are valid? | `contracts/src`, schema tests, API/protocol handlers | [API](API.md), [runner protocol](RUNNER-PROTOCOL.md) |
| How does a job behave? | Admission, shared store, dispatcher/executor, integration tests | [Architecture](ARCHITECTURE.md), [user guide](USER-GUIDE.md) |
| What runs where? | `apphost.mts`, `deploy/Dockerfile`, reviewed deployment output | [Architecture](ARCHITECTURE.md), [deployment](DEPLOYMENT.md) |
| What does an operator configure? | Harness/profile/policy manifests and loaders | [Configurator](CONFIGURATOR.md), [developer guide](DEVELOPER-GUIDE.md) |
| What can we claim about safety? | Enforced controls, policy, tests, environment-specific evidence | [Security](SECURITY.md) |
| What does the product promise, and what could come next? | Current capability evidence, explicit proposals, and acceptance criteria | [Product contract](PRODUCT.md), [detailed assessment and enterprise direction](PRODUCT-OVERVIEW.md), [historical plan](PLAN.md) |
| Which commands are available? | `package.json`, package scripts, test configuration | [Developer guide](DEVELOPER-GUIDE.md) |

Tests are evidence of the behavior they exercise, not proof of every deployed property. When prose and code
disagree, investigate and correct the discrepancy; do not silently redefine intended behavior to match a bug.
The original plan is historical/design context and must not override the current implementation guides.

## Change-to-document map

| If you change... | Review/update these canonical pages and assets |
| --- | --- |
| Public endpoint, auth, pagination, event, or response shape | [API](API.md), [REST examples](../http/agent-api.http), affected user workflow |
| Job state, leases, retry, cancellation, or budget semantics | [Architecture job flows](ARCHITECTURE.md#job-execution), [API](API.md), [user outcomes](USER-GUIDE.md#understand-the-outcome) |
| Concurrency, SDK/session durability, steering, or human waits | [Architecture](ARCHITECTURE.md#concurrency-and-durability), [user guide](USER-GUIDE.md), product overview [instances](PRODUCT-OVERVIEW.md#2-what-is-an-instance-and-can-several-run-concurrently) and [interaction matrix](PRODUCT-OVERVIEW.md#supported-interaction) |
| Version immutability, provenance, measurement, or evaluation support | [Publication rules](DEVELOPER-GUIDE.md#configuration-publication), [API measurement limits](API.md#measurement-limits), product overview [evidence inventory and comparisons](PRODUCT-OVERVIEW.md#5-can-it-version-configurations-run-comparisons-and-store-results) |
| Harness field, tool group, permissions, skill, sub-agent, or model option | [Configurator](CONFIGURATOR.md), [runner protocol](RUNNER-PROTOCOL.md), [developer feature checklist](DEVELOPER-GUIDE.md#add-a-harness-feature), [product scope](PRODUCT.md#supported-today) |
| Runner wire message, capability, SDK mapping, or tool binding | [Runner protocol](RUNNER-PROTOCOL.md), [developer guide](DEVELOPER-GUIDE.md), affected sample harness |
| Component, service connection, trust boundary, or credential path | [Architecture](ARCHITECTURE.md), [architecture.svg](images/architecture.svg), [security](SECURITY.md) |
| AppHost placement, Azure resources, identity, ingress, or deployment input | [Deployment](DEPLOYMENT.md), [topology image](images/local-and-azure.svg), [architecture](ARCHITECTURE.md#local-and-azure-topology), [detailed product topology views](PRODUCT-OVERVIEW.md#1-where-does-a-configured-harness-eventually-run) |
| Configurator UI, job console, local setup, or activation/reload behavior | [Configurator](CONFIGURATOR.md), [user guide](USER-GUIDE.md), affected screenshot, [publication rules](DEVELOPER-GUIDE.md#configuration-publication) |
| Package scripts, prerequisites, packaging, or test setup | [Developer guide](DEVELOPER-GUIDE.md), [user prerequisites](USER-GUIDE.md#before-you-start), README quick start if affected |
| Security control, acknowledged gap, or isolation claim | [Security](SECURITY.md), diagrams and product/user claims that depend on it |
| Product scope, non-goal, or implemented milestone | [Product contract](PRODUCT.md) and [detailed assessment](PRODUCT-OVERVIEW.md); add dated evidence to [plan status](PLAN.md#24-implementation-status) when warranted |
| Document name, heading, or file location | [Documentation hub](README.md), incoming links, README and contribution/agent guidance |

Review does not require changing every listed file. If a behavior is unchanged, say why no documentation change
is needed in the PR rather than making cosmetic edits.

## Authoring rules

- Give each topic one canonical home using the [topic map](README.md#canonical-topic-map). Link from overview
  pages instead of duplicating endpoint tables, setup sequences, or gap registers.
- Write procedures as prerequisites, actions, expected result, and recovery. Label whether a command is local,
  deployed, illustrative, or destructive. Never point test cleanup at a working database.
- Use repository-relative links to implementation and tests for non-obvious claims. Prefer durable symbols and
  file links over line-number references that become stale after edits.
- Keep **proposed**, **implemented**, and **verified in a named environment** distinct. Do not add "production
  ready," "fully isolated," "unlimited," or exact budget guarantees without corresponding evidence.
- Put versions and defaults in their owning manifest/contract first. Avoid copying them into multiple guides;
  when a runnable example needs a concrete version, update it with the sample.
- Never include real keys, tenant/account identifiers, job inputs, or approval content from a private workload.
  Use placeholders and synthetic examples, including in screenshots.
- Preserve useful design history in `PLAN.md`; mark superseded assumptions and link to current behavior instead
  of rewriting old evidence as if it had been reverified.
- Keep the dated assessment in `PRODUCT-OVERVIEW.md` distinct from the concise contract in `PRODUCT.md`.
  Update affected answers and evidence when behavior changes; do not present its proposed comparison or enterprise
  layers as implemented merely because they appear in a diagram or delivery sequence.

## Diagrams and screenshots

| Asset | Editable source | How to maintain |
| --- | --- | --- |
| System overview | [`images/architecture.svg`](images/architecture.svg) itself | Update components, arrow direction, credential labels, and limitation note together |
| Placement comparison | [`images/local-and-azure.svg`](images/local-and-azure.svg) itself | Compare with both AppHost execution modes and Docker stages |
| Job execution, states, and interaction flows | Mermaid fences in [ARCHITECTURE.md](ARCHITECTURE.md) | Keep labels aligned with contract names and actual caller paths |
| Detailed local/Azure product views and proposed comparison layer | Mermaid fences in [PRODUCT-OVERVIEW.md](PRODUCT-OVERVIEW.md) | Keep runtime views aligned with the architecture; preserve the future-work label on the comparison design |
| Configurator and job-console screenshots | PNGs in [`images`](images) | Recapture only when the pictured UI meaningfully changes, with synthetic data and no tokens |

The SVGs are source-controlled drawings, not generated exports; **there is no second diagram source or render
pipeline to keep in sync**. Edit the XML or use an SVG editor, then inspect the diff and open the result in a browser.
Keep the `title`/`desc` accessibility text, explicit background, readable labels, and meaningful Markdown alt text.
Do not replace editable architecture diagrams with screenshot-only PNGs.

Mermaid renders in GitHub Markdown. Preview edited fences in a Mermaid-capable local viewer or GitHub preview;
do not send private architecture or code to a public diagram-rendering service. Accompany flows with prose and
source links so terminal readers do not have to interpret raw diagram syntax.

For each changed drawing, check the normal documentation display size, not just a zoomed editor: text must not
clip, arrows must not cross labels, and dashed/solid lines or colors must not be the only explanation of a boundary.

## Review loop

1. Before editing, identify the affected behavior and its canonical documents.
2. Change implementation, focused tests, and documentation together. Update diagrams when connections or
   state transitions change.
3. Check local links and heading anchors, including source links and renamed files. Read examples against the
   schemas and command definitions; documentation-only changes do not require application builds.
4. Preview changed images and Mermaid, review for secrets and unsupported claims, and ensure the hub still
   offers a clear user/developer/product reading path.
5. In the PR, list the docs updated or explain why none are affected. State what was actually verified and what
   was not; a historical live run is not evidence for a new change.

The [pull request template](../.github/pull_request_template.md) carries the checklist, and root
[`AGENTS.md`](../AGENTS.md) points coding agents at these same rules. These are review conventions, not an
automated documentation freshness gate.
