# verification

Operational home for proof harnesses. See `docs/VERIFICATION.md` and
`docs/CANONICAL_CONTEXT.md` for the current rules.

## Structure

```text
verification/
  ledgers/          generated JSONL proof ledgers and tracked schemas
  mutation/         mutation-testing notes/config
  fixtures/         cross-subsystem fixtures
  golden-replays/   captured replay streams when applicable
  playtest-bots/    scripted soak/playtest scenarios
```

## Ledgers

`verification/ledgers/*.jsonl` and `verification/ledgers/artifacts/` are local
generated outputs and ignored by git. Regenerate them with the relevant proof
scripts instead of treating stale entries as context.

Useful direct gates:

```bash
pnpm verify:successor-context
pnpm check:commands
pnpm check:coverage
pnpm denylist
pnpm -r build
pnpm -r test
cargo test --workspace
pnpm check:zero-gpu
GAME_ALLOW_DEV_IDENTITY=1 pnpm tui:gate
GAME_ALLOW_DEV_IDENTITY=1 pnpm 3d:gate
pnpm desktop:smoke
pnpm bench:aoi-1000
pnpm bench:game-ws
```

Screenshots and video are review aids, not pass/fail authority. Keep them out of
the repository and pair any visual review with backend status, journey results,
and deterministic authority evidence.
