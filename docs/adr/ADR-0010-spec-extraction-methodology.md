# ADR-0010: Spec Extraction Methodology

**Status:** accepted
**Date:** 2026-05-10
**Updated:** 2026-07-13 for the 3D/TUI consolidation

## Context

Complex gameplay systems become unmaintainable if constants, formulas, and
state transitions live only in code. Successor needs a spec lane for Roll
combat, bleed, buffs, inventory, economy, crafting, NPC jobs, chat routing, and
shard behavior.

## Decision

Gameplay-facing systems should move toward versioned specs with fixtures and
acceptance metrics:

```text
spec or JSON data -> deterministic reducer/sim -> replay fixture -> browser/runtime proof
```

Each mature spec should include:

- stable `spec_id` and semver
- command/event/state shape
- formulas and clamps
- tuning constants
- RNG contract if stochastic
- valid/invalid input examples
- fixtures and expected outputs
- replay/hash expectations where applicable
- known uncertainty
- migration notes for breaking changes

## Extraction Sources

Allowed inputs:

- current product code
- current measured runtime behavior
- designer-authored formulas
- purchased asset manifests and pack documentation
- sanitized reference notes that pass source-isolation policy
- Strata-inspired system patterns when rewritten in Successor vocabulary and
  backed by Successor fixtures

Do not copy code-shaped reference material into specs. Product code implements
the spec, not raw external source.

## Review Rules

- Specs without fixtures are drafts.
- Specs that affect economy, inventory, combat, or identity need idempotency or
  replay proof.
- Multi-source disagreements stay in an uncertainty/conflict section until a
  fixture or product decision resolves them.
- Old specs are immutable once a breaking v2 is issued.

## Consequences

- Combat formulas belong in authority data/specs; renderer code owns only
  event-driven presentation.
- Asset manifests are part of the spec chain for runtime visuals.
- Verification can mutate data constants, not only TypeScript/Rust code.

## Related

- `docs/CANONICAL_CONTEXT.md`
- `docs/VERIFICATION.md`
- ADR-0001 (Source isolation and spec handoff)
- ADR-0009 (Verification methodology rigor)
