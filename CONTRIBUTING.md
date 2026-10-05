# Contributing

Start with the [documentation hub](docs/README.md), [product scope](docs/PRODUCT.md), and
[developer guide](docs/DEVELOPER-GUIDE.md). The developer guide owns setup, repository structure, build/test
commands, and extension checklists.

## Change workflow

1. Identify the behavior being changed and read its contracts, implementation, and focused tests.
2. Keep changes scoped. Preserve caller ownership, lease fencing, output validation, and credential boundaries.
3. Update the canonical documentation in the same change using the
   [change-to-document map](docs/MAINTAINING-DOCS.md#change-to-document-map).
4. Build affected workspace packages before running the relevant tests. Expand coverage when the changed
   contract crosses services or runners; use the [developer command guide](docs/DEVELOPER-GUIDE.md#build-and-check).
5. Describe the outcome, evidence, and remaining limitations in the pull request.

Harness features must be wired through validation, admission, profiles, executor, both advertised runners, and
affected clients. A UI control alone is not a supported runtime feature. Published harness behavior changes
need versioning; see [configuration publication](docs/DEVELOPER-GUIDE.md#configuration-publication).

## Before submitting

- [ ] The implementation and focused coverage agree with the intended behavior.
- [ ] User instructions, API/protocol reference, developer guidance, and product scope are updated where affected.
- [ ] Changed topology, state transitions, or trust boundaries are reflected in diagrams and security docs.
- [ ] Links, examples, and changed visuals have been reviewed; no secrets or private workload data are included.
- [ ] Current behavior is distinguished from proposals and historical verification.
- [ ] The PR lists documentation changes, or explains why no documentation was affected.

For documentation-only changes, review links, examples, claims, and visual rendering; no application build/test
run is required. Do not introduce duplicate overview documents when an existing canonical page owns the topic.
The complete policy is [Maintaining the knowledge base](docs/MAINTAINING-DOCS.md).
