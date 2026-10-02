# Copilot SDK + Aspire

A planned repository-first starter for configuring, building, running, and deploying a customer-owned Copilot SDK agent service to Azure.

The project combines two independently usable deliverables:

- **Harness Builder:** a configurator that exports harness definitions and an editable Aspire solution.
- **Agent Service Starter:** application code and infrastructure that customers keep in their own repository, run locally, and deploy using the Aspire CLI or their CI pipeline.

The platform, configurator, Aspire AppHost, and reference agent runner will use TypeScript. Approved execution profiles will support both other tool environments, such as Python, and customer-supplied agents implemented with other Copilot SDKs. Another platform implementation language should be introduced only for a demonstrated performance bottleneck.

The intended production architecture keeps inference credentials at an external gateway, uses customer-owned credential storage, and isolates agent execution from deployment credentials and privileged application services.

## Status

Planning only. This repository does not yet contain a runnable service, configurator, or deployment template. Runtime sandbox compatibility and credential-free inference paths have explicit implementation gates.

See the [detailed architecture and delivery plan](docs/PLAN.md) for scope, security boundaries, developer workflows, milestones, and acceptance criteria.
