# Product guide

[Documentation hub](README.md) | [User guide](USER-GUIDE.md) | [Architecture](ARCHITECTURE.md)

## Purpose

Turn a repository-defined Copilot SDK harness into a durable job service that its owner can inspect, extend,
run locally, and deploy into their own Azure subscription. The application does not depend on a project-operated
control plane.

The unit of work is a **job with a structured result**, not a hosted general-purpose chat conversation.
The local configurator helps author and operate the repository; the deployed console helps callers use jobs.

## Users and responsibilities

| Role | Goal | Responsibility |
| --- | --- | --- |
| Job caller | Submit a task and retrieve a result | Supply schema-valid input, answer requests, inspect uncertain outcomes before retrying |
| Harness author | Define a repeatable agent behavior | Maintain instructions, schemas, tool requests, permissions, model choices, and versions |
| Platform developer | Add tools, runner features, or service behavior | Preserve contracts and boundaries across admission, execution, both runners, and clients |
| Deployment operator | Run the service in a customer-owned environment | Approve profiles/policy, configure identity/model access, review gaps, manage infrastructure and cost |

These are product responsibilities, not separately implemented authorization roles. In particular, the job caller
and approver currently share one API-key principal.

## Core concepts

| Term | Meaning |
| --- | --- |
| Harness | Versioned instructions, schemas, model choices, tools, limits, retry policy, and runner requirements |
| Execution profile | Operator-approved runner entrypoint, available bindings, and declared protocol capabilities |
| Execution policy | Operator ceilings and required controls; a harness cannot grant itself extra authority |
| Job | Durable caller-owned task, with an admitted harness snapshot, input, state, events, and result |
| Attempt | One leased execution of a job, with its own deadline, workspace, runner process, and capability |
| Capability | Short-lived job/attempt-scoped inference authorization; not a provider credential |
| Input request | A bounded permission prompt or question answered by the job's caller |

## Supported today

| Capability | Current scope | Evidence / detail |
| --- | --- | --- |
| Repository-first configuration | Harnesses, profiles, policy, and tool code live in Git; the local UI edits harnesses and policy | [Configurator](CONFIGURATOR.md) |
| Structured agent jobs | Input validation, durable state, schema-validated results, JSON result artifact | [API](API.md) |
| Two runner implementations | TypeScript SDK reference runner and Python SDK sample on one protocol | [Runner protocol](RUNNER-PROTOCOL.md) |
| Rich harnesses | Prompt sections, reasoning/context options, sub-agents, delegated tools, packaged skills | [Harness contract](../contracts/src/harness.ts) |
| Interactive jobs | Optional built-in tools, per-kind permission rules, approvals and questions | [User interaction](USER-GUIDE.md#approvals-and-questions) |
| Durable execution | Leases, fencing, backoff, cancellation, and explicit review of uncertain effects | [Job states](ARCHITECTURE.md#job-state-transitions) |
| Controlled inference path | Foundry chat completions through a gateway with its own provider identity | [Security](SECURITY.md) |
| Local-to-Azure workflow | One AppHost; local processes/containers become Azure Container Apps and PostgreSQL | [Deployment](DEPLOYMENT.md) |

Feature support does not imply production hardening. Consult [Security](SECURITY.md#known-gaps) before making
isolation or compliance claims. Historical live-run evidence is recorded in
[the implementation status](PLAN.md#24-implementation-status); it is not a fresh validation of every checkout.

## Primary journeys

1. **First useful result:** configure model access, start locally, submit the dataset example, and inspect a
   structured answer. The [user guide](USER-GUIDE.md) owns the steps.
2. **Author a reusable behavior:** choose a template, define schemas and instructions, select approved
   capabilities, validate, version, save, and publish. New jobs use the new snapshot; existing jobs do not mutate.
3. **Complete a task requiring approval:** receive a request, inspect its proposed action, approve once or deny,
   and continue within the existing attempt deadline.
4. **Deploy and own operations:** review generated infrastructure and known gaps, deploy to a selected Azure
   target, verify a job, and retain responsibility for access, cost, and teardown.
5. **Extend the platform:** add a tool binding or compatible runner without giving execution processes provider
   credentials or authority over job state.

## Boundaries and open work

| Not currently delivered | Consequence |
| --- | --- |
| Enforced gateway-only network egress or per-job outer sandbox | This is not safe cross-customer execution isolation; approved shell/web actions can reach the network |
| Entra ID caller auth and a separate approver role | API-key principals govern caller access and approvals |
| MCP integrations | A schema term or planned placement is not a working local/remote MCP connector |
| Copilot-authenticated inference route | The implemented production route is Foundry with gateway-owned Entra identity |
| General artifact/file persistence or repository automation | Attempt files are temporary; coding jobs do not automatically check out, commit, or push a repository |
| Resumable chat/session history | Retrying a job starts a fresh attempt, not an SDK conversation resume |
| Export of a new customer starter repository | The configurator edits this repository; resolved harness JSON export is a different feature |
| Shipped OIDC deployment automation/template release pipeline | Deployment is documented from a workstation; the delivery plan describes future automation |

The [security gap register](SECURITY.md#known-gaps) owns hardening details. The
[delivery plan](PLAN.md#20-delivery-milestones) owns proposed milestones. Do not turn a proposal into a
current feature claim until the implementation and supporting evidence exist.

## Acceptance criteria for changes

These are review criteria, not claims that quality or operational metrics are already collected:

| Product outcome | Evidence to collect |
| --- | --- |
| A new user can reach a first result | Follow the documented path against the changed configuration and record any new prerequisite |
| A harness change is understandable | Valid schema examples, explicit output contract, correct versioning, and visible permission behavior |
| A failure is actionable | Caller-visible state/error and a documented next action; uncertain effects are not silently repeated |
| A runner is interchangeable where advertised | Contract/capability checks and representative execution on each supported runner |
| Deployment ownership remains clear | Inspectable resource changes, permissions, costs, and teardown documentation |
| Product claims stay trustworthy | Matching user/developer docs and diagrams; limitations remain explicit |

For a proposed feature, describe the user problem, affected journey, acceptance criteria, constraints, and whether
it is **proposed**, **implemented**, or **verified in a named environment**. Keep dates on historical evidence,
not as a blanket guarantee over the whole knowledge base. Follow [documentation maintenance](MAINTAINING-DOCS.md)
when a change moves between those states.
