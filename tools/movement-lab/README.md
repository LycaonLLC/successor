# Movement Lab

Single isolated run: `node tools/movement-lab/run-scenarios.mjs --port=18093 --actor=<unique-id> --run-id=<id> --server-trace`.
Never use 18092: the harness refuses it; boot a dedicated shard with `OPEN_DESERT_PORT=18093 node tools/successor/serve-open-desert-fixture.mjs`.
Headless-only: the harness forces `headless: true` and rejects `--headless=0`; use `xvfb-run` only if a browser backend ever requires a display.
Outputs: metrics `/tmp/movement-lab/metrics-<runId>.json`, run archive `/tmp/movement-lab/<runId>/`, server trace `/tmp/movement-lab/<runId>/server-trace.jsonl`, screenshots `/tmp/movement-lab/<scenario>/*.jpg`.
Strict gate: add `--strict` (`--max-rejects=N`, `--max-snapbacks=N`; defaults 0 in strict).
Energy hygiene: every sample includes `actionVitals`; scenarios wait for full action before start and rerun up to `--energy-retries` if `metrics.actionContamination.fraction > --max-action-contamination` (default 0.10); threshold defaults `--sprint-action-threshold=10`.
Server trace boot: after serve-script build/reset, hand-run the 18093 unit with `systemd-run --user --unit=successor-open-desert-18093 ... --setenv=GAME_MOVE_TRACE=1 /usr/bin/node server/dist/index.js`.
Keep actor IDs unique; Vite 5179 serves any dedicated shard via `gamePort`, or run scratch Vite (for example 5181) and pass `--vite-port=5181`.
