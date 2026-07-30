# Successor Game Lab

Versioned, isolated QA harness for the 3D open-desert shard.

```bash
node tools/game-lab/lab.mjs run
node tools/game-lab/lab.mjs run movement fx-smoke
node tools/game-lab/lab.mjs list
node tools/game-lab/lab.mjs compare <runA> <runB>
```

`run` auto-picks a free backend port `>=18093`, refuses the standing authority and client ports, starts an isolated open-desert systemd unit, uses headless Playwright, and archives under `.game-lab/runs/<runId>/`.

Each run writes `manifest.json`, per-battery `metrics.json`, `traces/`, `shots/`, logs, and `session-recording.jsonl` from `window.__successorGameTrace.drain()`.

Batteries:
- `movement`: invokes `tools/movement-lab/run-scenarios.mjs` with isolation + server trace flags.
- `fx-smoke`: fires every `window.__successorFx` demo hook and captures stats/screens.
- `combat-smoke` v2: uses the current Slugthrower roll-combat path against a spawned Gaia creature until a kill/down or timeout.
- `ui-smoke`: opens FX LAB + DATAPAD waypoints and create/delete-smokes a waypoint.

Add a battery by adding a version key, a `run<Battery>Battery` function, and returning a `successor.game-lab.battery-metrics.v1` metrics file with `verdict` and `failures`.
