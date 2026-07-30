# mutation

Mutation testing config + recorded scores per subsystem.

Tool: [`cargo-mutants`](https://mutants.rs/).

```bash
cargo install cargo-mutants
just mutate           # runs against all crates
cargo mutants -p successor-sim      # one crate
```

## Score history

Recorded in `<crate>/mutation_score.jsonl` (one entry per run, append-only). The latest entry is also reflected in the corresponding spec document under `mutation_score`.

## Bar

- **Initial:** 70% (a subsystem cannot ship below this)
- **Target:** 85%

## Out-of-bar workflow

If a mutation survives, either:

1. The test suite has a hole — add a test that catches it.
2. The mutation is equivalent (e.g. a constant substitution that changes nothing observable). Mark as "skip" with rationale in the suppression file (`<crate>/mutants.toml`). Reviewer must approve.

The suppression file is part of the spec review.
