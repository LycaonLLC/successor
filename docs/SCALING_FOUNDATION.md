# Successor Scaling Foundation

This document records the multiplayer shape that must remain valid while local
play still uses one authority process.

## Contracts

- Rust is the single writer for gameplay state.
- The default authority cadence is 30 Hz.
- The TypeScript edge validates sessions and commands, bridges Rust, and shapes
  AOI-filtered state for each client.
- Client count and nearby population, rather than total world dimensions,
  should dominate snapshot cost.
- Reconnect resumes server state; it never restores inventory, position, or
  combat truth supplied by a client.
- Cross-area travel uses explicit authoritative transitions. Seamless
  cross-shard combat is not assumed.

## Current building blocks

- `successor-core`: spatial and deterministic primitives.
- `successor-net`: bounded command and state contracts.
- `successor-sim`: movement, combat, world, lifecycle, inventory, economy, and
  progression authority.
- `server/src/game/shard.ts`: room lifecycle, Rust bridge, AOI, packet shaping,
  persistence projection, and status/debug surfaces.
- `client/`: shared interpolation, command, and projected-state runtime.

## Measurement

```bash
pnpm bench:aoi-1000
pnpm bench:game-ws
pnpm optimize:netcode
pnpm load:players:smoke
```

Every result must record fixture hash, build commit, client/entity counts,
enabled systems, duration, and host. A synthetic-client result proves the
measured server path; it does not prove 3D rendering capacity.

## Growth path

1. Keep one authoritative shard healthy with the generated world.
2. Measure AOI, command receipts, tick cost, compact-state size, and reconnect.
3. Split ownership only after a concrete load or deployment boundary requires
   it.
4. Use explicit transitions first; add ghost proxies and handoff only with a
   tested ownership protocol.
5. Route shared presence/chat/persistence through durable adapters before
   running multiple edge processes.

Broadcasting all world entities to every client is outside this architecture.
