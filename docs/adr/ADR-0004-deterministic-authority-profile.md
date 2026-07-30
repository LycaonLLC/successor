# ADR-0004: Deterministic Authority Profile

Status: accepted, updated 2026-07-13.

## Context

Rust authority state must produce the same result for the same initial state,
commands, seed, and tick sequence. Replay, persistence checks, debugging, and
cross-process verification depend on that property. `successor-wasm` remains a
supported binding target, but no player client runs a second gameplay authority.

## Decision

Deterministic transitions in `successor-core`, `successor-inventory`, and
`successor-sim` follow these rules:

1. Use fixed/integer simulation values; convert boundary floats before they
   enter deterministic state.
2. Read no wall clock, filesystem, environment, OS randomness, or host callback
   during a transition.
3. Use project deterministic RNG helpers with explicit seeds and domains.
4. Use stable iteration and tie-breaking. Hashed state cannot depend on hash-map
   order, pointers, allocator layout, or debug formatting.
5. Serialize and hash fields in a declared canonical order.
6. Treat protocol- or hash-breaking changes as explicit version changes.
7. Keep transport, rendering, telemetry, and persistence I/O outside the state
   transition.

Workspace lint configuration and deterministic tests enforce the available
parts of this profile. Missing enforcement is tracked as verification work, not
described as already complete.

## Verification

- Rust unit/property tests cover deterministic primitives and state changes.
- Replay and state-hash tests compare repeated native runs.
- `cargo test --workspace` covers the ordinary authority build.
- `cargo build -p successor-wasm --target wasm32-unknown-unknown` checks the
  binding target when that target is part of a release.
- Any future cross-runtime replay gate must use the same neutral test builder
  and command stream as native authority tests.

## Consequences

Clients may interpolate and animate authoritative state, but they cannot become
an alternate simulation. Deterministic code accepts extra boilerplate and
explicit ordering in exchange for reproducible outcomes.
