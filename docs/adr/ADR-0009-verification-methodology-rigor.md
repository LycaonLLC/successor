# ADR-0009: Verification Methodology Rigor

**Status:** accepted
**Date:** 2026-05-10
**Updated:** 2026-07-13 for the 3D/TUI consolidation
**Drives:** `docs/VERIFICATION.md`

## Context

Successor needs proof that gameplay is correct, smooth, and scalable before
systems accrete around a false-green prototype. The critical risk is accepting
a client that looks playable but has client-owned truth, synthetic combat
results, unstable movement, unmeasured fan-out, or screenshots without runtime
metrics.

## Decision

Verification is layered:

1. **Behavioral correctness.** Deterministic replay, command receipts,
   authority events, state hashes, property tests, and packet/content fuzzing.
2. **Perceptual correctness.** Browser proofs, frame-time metrics,
   smoothness checks, actor/tracer/decal counts, and visual screenshots.
3. **Game-feel correctness.** TTK distributions, hit timing, latency curves,
   correction distances, and impact/audio/VFX timing.
4. **Mutation and spec pressure.** Gameplay constants and specs should have
   tests strong enough to catch damaging mutations before they become tuning.
5. **Live-ops drift.** Production metrics are segmented by shard, cohort,
   patch, system, and account risk.

## Rules

- A first green run is not enough when the feel is bad. Profile, fix the largest
  observed bottleneck, and rerun.
- Browser screenshots alone are not proof. Pair them with probe JSON and timing
  metrics.
- Roll combat requires authority-chain proof: command -> receipt -> Rust combat
  event -> snapshot/delta -> 3D or TUI presentation.
- Generated ledgers are evidence and may be deleted/regenerated. Architecture
  lives in `docs/CANONICAL_CONTEXT.md`.
- LLM or human video review can triage feel, but cannot replace numeric runtime
  metrics.

## Consequences

- Verification scripts should write structured ledgers when they run.
- Runtime probes should expose enough state to distinguish render bugs from
  authority bugs.
- Load tests must report client counts, commands, receipts, rejects, latency,
  bytes, and packet errors.
- Combat tests must report TTK, wounds, bleed states, deaths, respawns, and
  replay hashes.

## Related

- `docs/CANONICAL_CONTEXT.md`
- `docs/VERIFICATION.md`
- `docs/PERFORMANCE_BUDGET.md`
- ADR-0004 (Deterministic authority profile)
- ADR-0010 (Spec extraction methodology)
