# ADR-0005: Zone Shard + AOI from Day One

**Status:** accepted
**Date:** 2026-05-10
**Updated:** 2026-05-12 for Successor region/interior world shape
**Supersedes-on-overlap:** earlier "Phase 7 deferral" framing for sharding in the original plan

## Context

The original plan deferred sharding and area-of-interest (AOI) replication to Phase 7. Research pushed back: retrofitting ownership, visibility, transfer semantics, and snapshot prioritization after the first vertical slice converts gameplay design choices into avoidable systems debt. First playable can run a single shard, but entity IDs, ownership, AOI replication shapes, handoff seams, and telemetry must exist from day one.

Public data on browser MMO shard CCU and snapshot bytes/player is weak. Hordes.io and similar deployments are public proof of feasibility, not sizing gospel. The project must measure its own pipeline early.

## Decision

Use **zone shards with spatial AOI** for first playable. Successor starts as one logical world made of authoritative public regions plus lightweight interior shards. Each outdoor district or public interior is owned by one Rust zone shard. Private houses, apartments, player stores, and guild halls are separate owned interior shards attached to door records.

The shard runs at 30 Hz authoritative simulation. Clients receive snapshots at 10–20 Hz, interpolated at 60 Hz.

### Ownership

- Single-writer per entity. The owning shard is the only mutator.
- Border handoff via ghost proxies: neighboring shards receive enough read-only state to render or predict border entities, but only one shard holds combat authority.
- First playable avoids cross-zone combat authority. Use safe seams: doors, elevators, transit gates, alleys, clinics, apartments, guild halls, and station transitions. Seamless open-world handoff is a later feature.
- IDs, zone ownership, and AOI messages exist day one. Implementations can be stubbed for first playable, but the shapes must be in place.

### World identity

- Prefer one world identity over many cloned worlds.
- Public regions can have population caps, but overflow clones are an emergency or event tool, not the default fiction.
- When a region is full, route players to neighboring districts with similar incentives before cloning the same district.
- Private interiors are expected and cheap: player rooms, houses, guild halls, shops, crafting garages, and instanced mission spaces.
- Travel between distant regions should be diegetic and measurable: train, elevator, gate, shuttle, door, or loading corridor.

### AOI rings

Concentric priority rings, snapshot rate per ring tuned per shard:

1. Self state and reconciliation (every tick).
2. Combat targets and incoming threats (high rate).
3. Nearby players and creatures (medium rate).
4. Resource nodes and interactables (low-medium rate).
5. Far-field players represented as low-rate impostors or aggregate crowd hints (lowest rate).

AOI implementation: spatial hash or grid + concentric ring filter. The exact data structure is an implementation detail; the snapshot priority and update cadence per ring are an architectural commitment.

### Snapshot budget revisions

Per `docs/PERFORMANCE_BUDGET.md`:

- **Target P95: 12–16 KB/s per player** in ordinary crowded play.
- **Emergency ceiling P95: 24 KB/s per player** during combat spikes.
- Degrade fairly when overloaded: lower far-field rates, reduce cosmetic entity replication, aggregate crowds, throttle noncombat props **before** touching combat correctness.

### Telemetry from day one

Shard-side metrics required from Phase 2:

- Tick time per shard (P50, P95, P99)
- Entities per shard
- AOI entities per player
- Snapshot bytes per player per second
- Snapshot drop rate
- Border ghost-proxy count
- Handoff events (success, retry, failure)

Telemetry uses the OpenTelemetry semantic-convention naming agreed in `tools/telemetry/`.

## Consequences

- Phase 2 vertical slice carries a non-trivial AOI scaffold even though it runs one shard. The investment surfaces design assumptions early.
- The transport abstraction in `successor-net` must support per-ring snapshot rates from the start (see ADR-0002 + future WebTransport migration).
- Cross-zone combat authority is not on the first-playable critical path; design choices that require it (e.g., border zone bosses) must wait or use safe-seam transitions.
- The deterministic core's tick boundary is the single-writer commit point. Parallel jobs may compute local results but commit through a sorted `(tick, phase, entity_id, component_id)` queue.

## Verification

- Phase 2 exit gate includes a single-shard load test that records the per-ring snapshot bytes/player budget against `docs/PERFORMANCE_BUDGET.md`.
- Phase 7 exit gate requires a multi-shard zone-handoff test with border ghost proxies and at least one safe-seam transition.

## Related

- ADR-0002 (WebSocket now, WebTransport later) — snapshot transport.
- ADR-0004 (Deterministic authority profile) — single-writer commit invariant.
- ADR-0006 (Asset delivery) — zone-bundle structure.
