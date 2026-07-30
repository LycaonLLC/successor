# Multiplayer Optimization Method

Use this loop for authority, transport, AOI, interpolation, and population
performance work.

## Evidence rule

An optimization must improve an emitted metric or fix a reproduced semantic
failure without moving gameplay truth out of Rust. Record the fixture, build,
host, load profile, and before/after outputs.

## Primary suite

```bash
pnpm optimize:netcode
```

Supporting entry points are listed in `PERFORMANCE_BUDGET.md`. Generated
ledgers belong under `verification/ledgers/` and are regenerated rather than
treated as permanent source truth.

## Iteration

1. Reproduce one failing metric or behavior on a named fixture.
2. Identify the authority, edge, AOI, serialization, projection, or rendering
   stage responsible.
3. Add instrumentation if the suspected cost is not visible.
4. Change one stage.
5. Run its focused check, then the original end-to-end measurement.
6. Compare semantic results as well as timing and bandwidth.
7. Keep the change only when the evidence improves and adjacent gates remain
   healthy.

Useful measures include authority tick percentiles, command receipt latency,
snapshot bytes per client, AOI entity counts, dropped/coalesced updates,
interpolation correction, reconnect time, process memory, and 3D frame time.

Stop after three controlled attempts fail to improve the selected metric. At
that point, revise the hypothesis or request a product/budget decision.
