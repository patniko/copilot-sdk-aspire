# Documentation

This is the entry point for the repository's knowledge base. Guides describe the implementation in this
checkout. Proposed product layers are explicitly labeled in the product documents; historical verification
belongs in the delivery plan, not in current feature claims.

## Reading paths

| Audience | Start here | Then read |
| --- | --- | --- |
| Job user | [User guide](USER-GUIDE.md) | [Configurator](CONFIGURATOR.md) for authoring; [API](API.md) for client integration |
| Developer | [Developer guide](DEVELOPER-GUIDE.md) | [Architecture](ARCHITECTURE.md), [runner protocol](RUNNER-PROTOCOL.md), [contribution workflow](../CONTRIBUTING.md) |
| Product contributor | [Product guide](PRODUCT.md) | [Detailed product assessment](PRODUCT-OVERVIEW.md), [security limitations](SECURITY.md#known-gaps), [hybrid hosting record](HYBRID-HOSTING-PLAN.md), [per-harness hosting modes plan](HOSTING-MODES-PLAN.md), then [historical plan](PLAN.md) |
| Deployment operator | [Deployment guide](DEPLOYMENT.md) | [Security model](SECURITY.md) and [local/Azure topology](ARCHITECTURE.md#local-and-azure-topology) |
| Interactive demo operator | [Demo agent host](USER-GUIDE.md#demo-agent-host) | [Hosting topology view](CONFIGURATOR.md#hosting-and-topology), [per-harness owner hosts](DEPLOYMENT.md#per-harness-owner-hosts), [GitHub-native client eligibility](DEPLOYMENT.md#github-native-client-eligibility), [managed compatibility gate](DEPLOYMENT.md#demo-host-compatibility-gate), and [host boundaries](SECURITY.md#experimental-host-boundaries) |
| Local hybrid operator | [Local hybrid deployment](DEPLOYMENT.md#experimental-local-hybrid-deployment) | [Shared conversation API](API.md#experimental-shared-conversations), [architecture](ARCHITECTURE.md#local-hybrid-hosting), [session containers](DEPLOYMENT.md#session-containers), [orchestrator workers](DEPLOYMENT.md#orchestrator-workers), [promotion](ARCHITECTURE.md#promotion), [boundaries](SECURITY.md#local-hybrid-boundaries), and [qualification](DEVELOPER-GUIDE.md#hybrid-runtime-qualification) |

## Canonical topic map

Keep each fact in one primary document. Other pages should summarize and link, rather than repeat command
sequences, endpoint tables, or security guarantees.

| Document | Owns |
| --- | --- |
| [User guide](USER-GUIDE.md) | Prerequisites, first run, job console, results, approvals, user troubleshooting |
| [Configurator](CONFIGURATOR.md) | UI authoring workflow, settings storage, local companion behavior |
| [API](API.md) | Public endpoints, authentication, request/response semantics, events, errors |
| [Developer guide](DEVELOPER-GUIDE.md) | Repository map, build/test commands, extension points, publication behavior |
| [Architecture](ARCHITECTURE.md) | Current components, data/control flows, job states, deployment topology |
| [Runner protocol](RUNNER-PROTOCOL.md) | Executor/runner wire contract and SDK session mapping |
| [Security](SECURITY.md) | Enforced boundaries, acknowledged gaps, limits on security claims |
| [Deployment](DEPLOYMENT.md) | Azure inputs, permissions, provisioning, costs, verification, teardown |
| [Product](PRODUCT.md) | Intended users, value, supported scope, non-goals, acceptance criteria |
| [Product overview](PRODUCT-OVERVIEW.md) | Six-question capability assessment, comparison methodology, evidence limitations, and proposed enterprise delivery sequence |
| [Documentation maintenance](MAINTAINING-DOCS.md) | Source-of-truth rules, change-to-document map, diagram editing, review checklist |
| [Plan](PLAN.md) | Original proposals, design rationale, dated milestone and verification history |
| [Hybrid hosting plan](HYBRID-HOSTING-PLAN.md) | Design/delivery record and qualification evidence; canonical architecture/deployment pages describe the implemented local path, while Azure and remaining gates stay explicit |
| [Hosting modes plan](HOSTING-MODES-PLAN.md) | Design/delivery record for per-harness hosting modes (isolated, shared, promotable, orchestrator), handoffs, the client connection matrix, the OpenAI Agents API comparison, delivery gates, and stage qualification evidence; canonical pages describe stages 1 to 6, implemented locally, while Azure and comparisons stay explicit |

## Diagrams and images

- [System architecture](images/architecture.svg): service connections and credential boundaries.
- [Local and Azure topology](images/local-and-azure.svg): what runs where.
- [Job execution](ARCHITECTURE.md#job-execution), [job states](ARCHITECTURE.md#job-state-transitions),
  [approval flow](ARCHITECTURE.md#approvals-and-questions), [local hybrid hosting and shared-session approvals](ARCHITECTURE.md#local-hybrid-hosting),
  [session container flow and states](ARCHITECTURE.md#session-containers), [orchestrator workers](ARCHITECTURE.md#orchestrator-workers),
  [promotion](ARCHITECTURE.md#promotion), and [agent hosts](ARCHITECTURE.md#optional-demo-agent-host):
  editable Mermaid diagrams embedded in the architecture guide.
- [Detailed product views](PRODUCT-OVERVIEW.md#1-where-does-a-configured-harness-eventually-run) and the
  [proposed comparison layer](PRODUCT-OVERVIEW.md#recommended-comparison-layer-future-work): supplemental Mermaid
  diagrams in the product overview, with current and future scope explicitly separated.
- [Hosting-mode design topology](HOSTING-MODES-PLAN.md#4-topology), session lifecycle, and promotion flow: Mermaid
  diagrams in the hosting modes plan, kept as the design record; the architecture guide's flows above describe what
  is implemented.
- Product screenshots live with the [configurator](CONFIGURATOR.md) and [user guide](USER-GUIDE.md).

The SVG files are editable vector sources, not exports from a separate drawing. Mermaid fences render on
GitHub. Every diagram has accompanying prose so the meaning remains available in text-only readers.

## When changing code

Start with [Contributing](../CONTRIBUTING.md), find the affected canonical pages using the
[change-to-document map](MAINTAINING-DOCS.md#change-to-document-map), and update them in the same change.
Use implementation and tests as evidence; do not promote a planned capability to "supported" based only on prose.
