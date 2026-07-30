# Verification Ledgers

This directory contains append-only JSONL proof ledgers for Successor.

Ledgers are not logs. A ledger entry is a durable acceptance artifact: it records what ran, against which repo/build state, what passed or failed, which artifacts were produced, and which metrics changed.

## Current Ledgers

- `open-desert-current.jsonl`: optional combined baseline for the canonical 3D/TUI fixture.
- `browser-proof-ledger.jsonl`: Playwright/browser proof entries and screenshot artifact pointers.
- `chat-ledger.jsonl`: chat route/load/throughput proof entries.
- `client-render-ledger.jsonl`: frame-time/render backend measurements.
- `sim-replay-ledger.jsonl`: deterministic sim native/WASM replay proofs.
- `net-snapshot-ledger.jsonl`: snapshot byte budget and correction proofs.
- `combat-ledger.jsonl`: combat scenarios, TTK, wounds, bleeds, replay hashes.
- `asset-ledger.jsonl`: atlas, frame coverage, anchors, contact sheets.
- `db-ledger.jsonl`: migrations, constraints, idempotency, transaction timings.

## Schema

Use `schemas/ledger-entry.schema.json` for the common envelope. Subsystem payloads go in `metrics`, `artifacts`, and `details`.

Every entry should include:

- `runId`: stable ID for one proof run.
- `ledger`: ledger filename stem.
- `status`: `pass`, `fail`, or `waived`.
- `repo`: branch, commit, dirty status, and package hash.
- `command`: exact command and duration.
- `metrics`: machine-readable measurements.
- `artifacts`: screenshot/probe/report paths.

## Writer

Use `tools/verification/ledger.mjs` from Node scripts:

```js
import { appendLedgerEntry, createRunId, repoSnapshot } from "../../tools/verification/ledger.mjs";
```

Do not manually edit existing JSONL lines. Append a new entry.
