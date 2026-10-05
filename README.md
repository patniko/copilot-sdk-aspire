# Copilot SDK + Aspire

A repository-first agent service for the GitHub Copilot SDK: configure a harness, own the code, run locally
with Aspire, and deploy the same application model into your Azure subscription.

The control plane is TypeScript. Agent implementations are pluggable through approved execution profiles:
the repository ships a TypeScript Copilot SDK runner with Python tools and a Python Copilot SDK runner.
Both use the same durable job API, runner protocol, and inference gateway.

**Start with the [documentation hub](docs/README.md).** Current behavior is documented separately from the
original delivery plan; the [product guide](docs/PRODUCT.md) distinguishes shipped capabilities from open work.
For a source-based explanation of the product, local/cloud topology, sessions, authoring, supervision, and harness
comparison support, see the [detailed product overview](docs/PRODUCT-OVERVIEW.md).

## Quick start

With Node.js, pnpm, Aspire, Docker, and Azure CLI available:

```powershell
pnpm install
pnpm configure
```

The local configurator edits harnesses and policy, configures model access, and drives build, local run,
test jobs, and Azure deployment. It does not commit or push your changes.

Follow the [user guide](docs/USER-GUIDE.md) for prerequisites, model configuration, your first job, approvals,
and troubleshooting. Prefer the command line? Use [Run locally without the configurator](docs/USER-GUIDE.md#run-locally-without-the-configurator).

## Architecture

![Architecture: callers use the job API; API and dispatcher share PostgreSQL; an executor runs agents that call Foundry through the inference gateway.](docs/images/architecture.svg)

The API admits jobs into PostgreSQL. Executors claim leased attempts from the dispatcher and launch runners
with a private workspace and a job-scoped inference capability. Only the gateway holds the model-provider
identity; the runner holds no provider, database, or service credential.

This is a reference implementation, **not a claim of production hardening or cross-customer isolation**.
Egress is not enforced and other controls remain open. Read the [security model](docs/SECURITY.md) before
running workloads with sensitive data or external side effects.

## Choose your guide

| I want to... | Read |
| --- | --- |
| Run jobs, inspect results, and answer approvals | [User guide](docs/USER-GUIDE.md) |
| Create or edit a harness in the UI | [Configurator](docs/CONFIGURATOR.md) |
| Integrate a client with the job service | [Job API reference](docs/API.md) and [REST Client examples](http/agent-api.http) |
| Understand the product, scope, and open work | [Product guide](docs/PRODUCT.md) |
| Understand instances, sessions, comparisons, and the enterprise vision | [Product overview](docs/PRODUCT-OVERVIEW.md) |
| Understand components, trust boundaries, and job flows | [Architecture](docs/ARCHITECTURE.md) |
| Change, extend, or test the implementation | [Developer guide](docs/DEVELOPER-GUIDE.md) |
| Implement another agent runner | [Runner protocol](docs/RUNNER-PROTOCOL.md) |
| Deploy, operate, or remove the Azure resources | [Deployment guide](docs/DEPLOYMENT.md) |
| Keep code and documentation synchronized | [Contributing](CONTRIBUTING.md) and [documentation maintenance](docs/MAINTAINING-DOCS.md) |

The [original architecture and delivery plan](docs/PLAN.md) preserves design rationale and milestone history.
It is not the setup guide or the authority for current runtime behavior.
