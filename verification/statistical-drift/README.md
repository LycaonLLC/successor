# statistical-drift

Live-ops Shewhart-style SPC dashboards. Wired in Phase 7. Scaffolded here so the gap is visible.

## Metrics tracked (planned)

- Faucet/sink ratio per resource class
- TTK medians per encounter archetype
- Resource scarcity index (concentration percentile per planet)
- Market concentration (Gini-like)
- Death rate per zone, per hour
- Travel time distributions
- Crafting success rate
- Account creation → first-action latency
- Daily-active / weekly-active player counts

## Output

- CSV / JSON exports for human inspection
- Optional Grafana dashboards (deferred until live ops)
- Out-of-control signals route to a triage queue

## What this isn't

It is not real-time anti-cheat. It is the slow signal that the economy is rotting, the encounter is harder/easier than designed, or a content patch broke a balance assumption.
