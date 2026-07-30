# wasm-determinism-audit

Scans WASM artifacts produced by deterministic crates for forbidden constructs (per ADR-0004).

## What it checks

Using `wasmparser` + `wasm-tools`:

- **Relaxed-SIMD opcodes.** WebAssembly relaxed-SIMD is explicitly nondeterministic. Hits fail the build.
- **Forbidden imports.** Banned: any host import not on the audited deterministic interface (no clocks, no random, no JS callbacks into tick code).
- **`memory.grow` after init.** Pre-allocate deterministic arenas; growth during tick fails the build.
- **Unexpected proposals.** Any proposal beyond the deterministic-profile set fails the build.
- **Mismatched section ordering.** Stable section order required.

## Usage

```
wasm-determinism-audit \
  --target wasm32-unknown-unknown \
  --profile release \
  --crate successor-wasm
```

Exit 0: clean. Exit 1: violation found, with offending opcode + offset + crate.

## CI integration target

This should run after
`cargo build -p successor-wasm --target wasm32-unknown-unknown --release` in
`.github/workflows/ci.yml`. It is not currently wired into CI.

## Status

Stub. Implementation pending; spec is in ADR-0004 for the avoidance set.
