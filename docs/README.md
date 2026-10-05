# Documentation

This is the entry point for the repository's knowledge base. Guides describe the implementation in this
checkout; proposals and historical verification belong in the delivery plan, not in current feature claims.

## Reading paths

| Audience | Start here | Then read |
| --- | --- | --- |
| Job user | [User guide](USER-GUIDE.md) | [Configurator](CONFIGURATOR.md) for authoring; [API](API.md) for client integration |
| Developer | [Developer guide](DEVELOPER-GUIDE.md) | [Architecture](ARCHITECTURE.md), [runner protocol](RUNNER-PROTOCOL.md), [contribution workflow](../CONTRIBUTING.md) |
| Product contributor | [Product guide](PRODUCT.md) | [Security limitations](SECURITY.md#known-gaps), then [historical plan](PLAN.md) |
| Deployment operator | [Deployment guide](DEPLOYMENT.md) | [Security model](SECURITY.md) and [local/Azure topology](ARCHITECTURE.md#local-and-azure-topology) |

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
| [Documentation maintenance](MAINTAINING-DOCS.md) | Source-of-truth rules, change-to-document map, diagram editing, review checklist |
| [Plan](PLAN.md) | Original proposals, design rationale, dated milestone and verification history |

## Diagrams and images

- [System architecture](images/architecture.svg): service connections and credential boundaries.
- [Local and Azure topology](images/local-and-azure.svg): what runs where.
- [Job execution](ARCHITECTURE.md#job-execution), [job states](ARCHITECTURE.md#job-state-transitions), and
  [approval flow](ARCHITECTURE.md#approvals-and-questions): editable Mermaid diagrams embedded in the architecture guide.
- Product screenshots live with the [configurator](CONFIGURATOR.md) and [user guide](USER-GUIDE.md).

The SVG files are editable vector sources, not exports from a separate drawing. Mermaid fences render on
GitHub. Every diagram has accompanying prose so the meaning remains available in text-only readers.

## When changing code

Start with [Contributing](../CONTRIBUTING.md), find the affected canonical pages using the
[change-to-document map](MAINTAINING-DOCS.md#change-to-document-map), and update them in the same change.
Use implementation and tests as evidence; do not promote a planned capability to "supported" based only on prose.
