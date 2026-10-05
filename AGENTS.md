# Repository guidance

## Documentation is part of a code change

- Start at `docs/README.md` for the canonical user, developer, product, and reference documents.
- Before changing behavior, consult `docs/MAINTAINING-DOCS.md` and its change-to-document map.
- Update affected canonical docs and diagrams in the same change. If docs are unaffected, explain why in the
  change summary instead of making cosmetic edits.
- Treat contracts, implementation, and relevant tests as evidence of current behavior. `docs/PLAN.md` contains
  proposals and historical evidence, not a blanket statement of current support.
- Keep product claims and diagrams consistent with `docs/SECURITY.md`; do not imply enforced egress,
  cross-customer isolation, or production hardening that is not implemented.
- Edit architecture SVGs directly and Mermaid flows in `docs/ARCHITECTURE.md`; preserve alt text and source links.
- Do not copy secrets, local configuration, or private job data into examples or screenshots.

## Implementation workflow

- Follow `CONTRIBUTING.md` and the build/test and extension guidance in `docs/DEVELOPER-GUIDE.md`.
- Preserve TypeScript/Python runner parity for features advertised by both execution profiles.
- Keep docs focused: link to a canonical page rather than duplicate setup, API, or security reference material.
- Documentation-only changes need link/example/visual review, not application builds or model-backed runs.
