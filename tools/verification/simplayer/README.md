# SimPlayer population soak

Synthetic long-horizon players that run human-plausible sessions against a live,
server-authoritative Successor shard — the tier above the per-system journey
harnesses. This README and the adjacent runner modules define the maintained
harness contract.

## Run

```bash
pnpm sim:players -- --minutes 20 --population 4 --port 29720
pnpm sim:players -- --minutes 3 --population 4 --port 29721   # quick iteration
pnpm sim:players -- --minutes 2 --profile farm --port 29722    # supply-bounded rate probe
```

Flags: `--minutes N` (soak length), `--population N` (SimPlayer count),
`--profile population|farm`, `--port P` (claimed scratch port; the maintained
standing authority and client ports are rejected), `--seed N` (deterministic
behaviour seed), `--out DIR`. `SUCCESSOR_SIMPLAYER_QUIET=1` silences the live
beat stream.

Requires a built stack in this checkout (the runner spins its own shard):
`cargo build -p successor-sim --example authority_bridge_server`,
`pnpm --dir server build`, `pnpm --dir client build:headless`.

## What it does

Spins ONE scratch shard (`GAME_SHARD_PERSISTENCE=0`, `rustLive`), staggers N
logins, and runs concurrent personality-weighted activity loops plus a
choreography director that stages group-up, a SimPlayer↔SimPlayer trade, and a
duel. Hunting+loot, survey→sample→craft, camp pitch+rest, trainer visits and
chat run throughout. The shard is torn down and asserted inactive at the end.

## Artifacts (`verification/ledgers/artifacts/simplayer/<runId>/`, or `--out DIR`)

- `soak-transcript.txt` + `player-<id>.transcript.txt` — human-review-able beats.
- `kpi.json` — per-player + population KPI, accepted/rejected counts by command kind, rejects-by-kind/reason table, `loottables_telemetry` (kills/hour).
- `telemetry.json` — status samples: sessions, source hash, bridge child health, memory, tick-rate drift, and error-level journal lines.
- `invariants.json` — reject-storm / stuck-loop / rubber-band monitors + breaches.
- `run.json` — config, shard teardown, final counters, profile-specific verdict (`population` 10-check, `farm` rate-probe check).

## Modules

| file | role |
|---|---|
| `rng.mjs` | mulberry32 + FNV-1a seeded RNG (sim's pattern; no wall-clock/float) |
| `personality.mjs` | trait vectors, archetypes, pacing derivation, weighted menu |
| `sim-player.mjs` | driver + chat session, `pace()`/`act()`/`say()`, transcript, serial queue |
| `behaviors.mjs` | activity loops + group/duel/trade choreography (over PlayFlows primitives) |
| `kpi.mjs` | KPI counters + oracle reconciliation + invariant monitors |
| `world.mjs` | soak-slice + character-store materialization, shard spin, provisioning |
| `population-runner.mjs` | CLI: roster, staggered logins, solo arcs + director, artifacts, verdict |

## Truth source

The shard's own oracle (`/game/debug/oracle`), receipts, and status counters are
authoritative. Headline KPI counters are driver-observed accepted receipts;
kills/deaths/wallet credits are reconciled from the oracle. The population profile
exits non-zero unless all 10 acceptance checks pass with zero invariant
breaches. The farm profile uses a farm-specific green verdict: all hunters
booted, at least one NPC kill, at least one accepted combat command, zero
invariant breaches, no fatal error, and shard teardown. Deaths/rejects are still
reported as rate-probe pressure, not hidden.
