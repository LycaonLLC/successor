# ADR-0001: Context Hygiene And Spec Handoff

**Status:** accepted
**Date:** 2026-05-10

## Context

The project uses external reference material to recover mechanics, formulas, table shapes, and expected behavior. Product code needs a stable implementation target that is smaller, cleaner, and easier to verify than a raw reference dump.

## Decision

Use a context-hygienic spec handoff:

1. External reference material stays outside the product repository in the local
   reference vault.
2. The spec lane writes schema-conformant artifacts under `spec/`: formulas, tables, state machines, fixtures, distributions, source-path citations, conflicts, and uncertainty notes.
3. The implementation lane writes code from specs and fixtures, not raw reference files.
4. Denylist scanning runs in pre-commit/CI and on stored prompts/manifests.
5. Reference access is logged with `tools/reference-access-log/`.
6. Generated assets require provenance manifests; any reference-conditioned generation input is recorded and reviewed instead of being hidden from the source chain.

## Consequences

- Specs are real build inputs. A spec without fixtures, expected distributions, and uncertainty notes is not ready.
- Implementation questions go back to the spec lane instead of being answered by direct source inspection.
- The repo can run deterministic verification against spec artifacts without needing the reference tree mounted.
- The process costs some iteration speed, but keeps coding context focused on product artifacts.

## Rejected Alternatives

- Implement directly while reading reference source. Rejected because it weakens verification.
- Keep reference material inside the repo for convenience. Rejected because it pollutes search, packaging, prompts, and agent context.
- Write narrative-only specs. Rejected because formulas without fixtures and distributions are too easy to misread.

## Related

- `docs/SOURCE_ISOLATION.md`
- `docs/VERIFICATION.md`
- `docs/adr/ADR-0010-spec-extraction-methodology.md`
