# Successor Current Project State

Status: current implementation inventory as of 2026-07-31, after the
2026-07-29 public-alpha release. Exact public hashes and pointers live in
`CURRENT_DEPLOYMENT.md`.

## What is real now

Successor is playable at `https://www.successorgame.com`. The public path is a
same-origin account and character shell, an immutable browser build, one-use
game/chat tickets, and one private single-writer TypeScript/Rust authority in
AWS.

The current release includes:

- full-viewport browser play with no page content below the game;
- a parent-owned exit/full-view control and ordinary visible cursor;
- automatic keyboard focus, Enter-to-chat, and clean character switching;
- exact creator appearance through roster, Rust checkpoint, relog, and world
  rendering;
- local, zone, and global chat in the graphical HUD and terminal client;
- in-place world travel with inventory, equipment, skills, professions,
  vitals, credits, and appearance continuity;
- current-only account, character, checkpoint, and journal formats;
- hard positional-audio cutoffs and time-based loop fades;
- healthy lock, restore, persistence, commit-worker, and Rust-child readiness.

The native download ledger is empty. Browser play is the only public client
distribution until compatible graphical and terminal packages complete their
hosted authorization proofs.

Successor is still an early alpha. Accounts and characters are disposable test
data. Breaking releases use a verified backup and coherent state reset; the
runtime does not accumulate compatibility branches merely to preserve alpha
characters.

## Supported repository shape

There is one canonical checkout:

```text
~/dev/games/successor
```

It is on `main`, which is the only local long-lived branch and the only
registered Successor worktree. The supported components are:

| Path | Role |
| --- | --- |
| `client-3d/` | Three.js world, PawnForge actors, input, HUD, effects, and graphical presentation |
| `client-tui/` | Full-screen and line-oriented terminal client |
| `client/` | Shared networking, commands, chat, state projection, audio rules, and headless automation |
| `server/` | Account boundary, tickets, rooms, chat routing, persistence projection, and Rust bridge |
| `crates/successor-sim/` | Deterministic gameplay authority |
| `crates/successor-{core,inventory,net,wasm}/` | Shared Rust contracts and primitives |
| `desktop/` | Electron packaging and isolated local-authority lifecycle |
| `site/` | Marketing, account, launch, legal, roadmap, and download presentation |
| `ops/deploy/` | AWS infrastructure and immutable release/operator scripts |
| `client-rust/` | In-development native Rust client (no_std engine, desktop GL/WebGL2 renderer, Colyseus protocol) — graphical material parity implemented, unshipped, standalone workspace |

There is no supported 2D game client. `client/` has one headless entry point and
contains no visual runtime; graphical presentation belongs to `client-3d/`.
The checked-in slice and map bundle are renderer-neutral authority inputs, not
an old 2D game.

The standalone Rust client now loads the complete checked-in GLB model corpus
through one packed mesh/material path and renders deferred opaque PBR,
shadowed sun and point lights, sorted transparent and transmissive surfaces,
bloom, and FXAA on native GL and WebGL2. Its canonical spatial contract is one
authority cell = one renderer unit = one metre. Fixture buildings retain their
metric footprints, PawnForge bodies normalize to a 1.8-metre adult height,
pawns and non-building props sample terrain elevation, and the live camera
frames the actor from a metric 14-metre-up/21-metre-back offset. Streamed
terrain uses continuous deterministic displacement, matching G-buffer and
depth/shadow geometry, slope-aware three-surface desert/forest PBR, wet/dry and
clear-coated puddle regions, and pooled deterministic detail instances.
Building exclusions flatten and feather structure footprints while rejecting
rocks, grass, scrub, and shrubs. Fixed native and WebGL2 beauty views have ROI,
non-repetition, resize, and half-float-disabled fallback proof. The
fidelity-first budgets are intentionally 6 MiB native, 4 MiB wasm, 8.33 ms
runtime/terrain p99, and 16.67 ms generic render p99 while retaining zero
steady-state frame allocations. This remains source/local-build proof only:
gameplay parity and product promotion are outstanding, and the Rust client is
absent from the site and native download ledger.

Native desktop development now also has an explicit loopback-only agent
control path. `successor-control` accepts argv, command files, or piped text;
remote input overrides local GLFW state while held, screenshot requests
acknowledge only after a rendered BMP is written, and `successor.input.v1`
recordings capture frame-indexed key, pointer, text, and scroll commands for
fail-closed replay. A local live-authority proof moved an ordinary connected
actor through the existing `SetMoveIntent` path and captured the resulting
world frame. The server remains disabled by default, native-only, local
developer tooling and changes no public download or deployment identity.


Source assets and generated runtime assets have separate homes. PawnForge
source work remains outside this repository; promoted GLBs, face atlases,
audio, and the generated world bundle are checked against manifests and
provenance rules before use. Old captures and rejected visual experiments are
not alternate runtime paths.

## Authority architecture

Rust owns gameplay truth: accepted movement, collision, targeting, combat,
life state, inventory, equipment, professions, skills, resources, crafting,
trade, camps, travel, guilds, farming, population, and economy mutation.
TypeScript owns transport, admission, projection, lifecycle coordination, and
durability scheduling. Clients animate and predict presentation only.

The former Rust `model.rs` monolith and generated C++ oracle path are gone.
Authored-world definition, durable progress, runtime caches, and one-shot
deliveries are explicit layers. Authority code is divided into domain modules
for actors, movement, combat, inventory, crafting, economy, progression,
resources, farming, guilds, groups, duels, population, snapshots, and related
rules. The old single authority-test file is now a small include root over
domain test shards.

At the current tree, `crates/successor-sim/src` is about 70,950 lines including
tests, bridge code, and command manifests. Its largest production files are:

- `authority_bridge.rs`: 4,877 lines;
- `authority/economy.rs`: 4,101 lines;
- `authority/crafting.rs`: 3,594 lines;
- `authority/combat_roll.rs`: 2,601 lines.

That is much easier to reason about than the deleted one-file model, but it is
not uniformly small. The main remaining maintainability hotspot is
`server/src/game/shard.ts` at 12,545 lines. It currently combines room-facing
orchestration, lifecycle, projection, persistence, travel, and other server
coordination. Its behavior is well covered, but future structural work should
split it by stable responsibility behind the existing `GameShard` contract,
one domain at a time. `client/src/slice-core/gameAuthoritySystem.ts` at 4,333
lines and `client-3d/src/render/pawns.ts` at 2,880 lines are the next notable
presentation hot spots.

## World and content

The default generated fixture contains two 1024 by 1024 areas:
`open-desert-overworld` and `verdance-forest-overworld`. Its stable identity is:

```text
planetfall-v5-seed-424242-size-1024-rogues-18-desert-critters-48-verdance-critters-24-areas-open-desert-overworld-verdance-forest-overworld
```

The current fixture has 91 spawn zones, three authored standing actors
(`player`, Knox Vale, and GR0K), 223 dormant population actors, the Dustgate
commerce and clone facilities, bank/trade/PA/clone terminals, and real travel
terminals in both areas. Runtime characters cannot claim an authored actor id.

The fixture and map bundle are byte-stable generated source:

- slice SHA-256:
  `69a19db8289b0d4711ccca5d4febef39b8dcd2ef662f9f70539935e49af8680e`
- map-bundle SHA-256:
  `01df5d1d178a8199b5bbd62f7e2107f017f5ae2ba1ca45081bb0ecdbb8f65795`

The authority and clients have working foundations for roster/appearance,
inventory/equipment, professions, combat and life state, surveying and
resources, crafting and factories, camps, travel, banking and trade, guilds,
duels, cloning and medicine, farming, creature harvest, genomes, and macros.
This is broad systems footing, not a claim that content, balance, onboarding,
or presentation is finished.

## Character and durability contract

The file-backed `successor.character-store.v2` record owns roster/profile
metadata, complete appearance, bounded character records, and the one-way
first-entry marker. Rust owns durable gameplay state. The checkpoint contains
inventory, equipment, position, vitals, profession and skill state, credits,
recipes, and other actor progress.

First entry is acknowledged only after the Rust actor and fixed two-piece
outfit are in a durable checkpoint and the character marker is committed. A
returning live Rust actor always wins over stale character-store projections.
There is no starter weapon or profession supply kit.

Disconnect intent, reconnect, link-dead state, and removal are serialized per
actor. Rust owns the exact 300-second link-dead expiry. A clean browser switch
sends `exit_world`, waits for authority disconnect, and only then replaces the
frame and mints another launch.

Portal and ticket travel mutate the existing Rust actor. Ticket travel uses
the bridge's `relocateActor` operation, consumes only the chosen ticket, forces
a `world-transition` checkpoint before acknowledgement, and refreshes the
character-store projection. It does not remove/recreate or upsert the actor.

The current release was proven with two tickets: one moved the character from
Open Desert to Verdance, while the other remained in inventory after clean
logout and relog. Exact worn state, face, Scout novice box, 16 spent points,
250-point cap, and destination position survived.

## Chat and input

Chat routing reads live authority position:

- `LOCAL`: same area, inclusive 24-cell radius, no history replay;
- `ZONE`: sender's current area;
- `GLOBAL`: every connected area on the shard;
- party, guild, trade, whisper, friend, ignore, and presence paths remain
  available under their existing policies.

The graphical HUD has a global feed and send channel; the TUI supports
`/global` and `/g`. Only local chat makes a world-space speech bubble.

When the game canvas has focus, Enter opens chat without a preliminary click.
After submit, focus returns to gameplay so WASD and other world keys work.
Pointer input and menu focus do not create a second movement authority.

## Audio

Positional sound uses one shared attenuation rule. Gain falls monotonically and
every positional source reaches exact silence at its authored maximum range;
the final 18 percent of the range is a smooth cutoff taper. A source at or
beyond the cutoff does not allocate a Web Audio voice.

Current important ranges are:

- unarmed body impact: 14 cells;
- heavier melee/down impact: up to 18 cells;
- ordinary ranged impact: 24 cells, heavier down impact 28;
- nearby NPC footsteps: 18 cells;
- remote firearm transient: 58 cells;
- firearm tail: 74–82 cells.

The longer firearm tail is intentional; punch and body-impact audio cannot leak
across the map. Ambient wildlife is sparse and bounded. Area changes stop all
loops over 900 ms. Settlement ambience fades over 1.5 seconds, day/night music
over 1.8 seconds, and combat music over 1.1 seconds. Combat ambience/music
returns to its ordinary mix across the six-second post-combat tail.

## Browser and terminal presentation

The browser launch page is a full-viewport game shell. The client uses a normal
visible cursor, not pointer lock. The parent exit control is always outside the
cross-origin iframe and remains the reliable way back to site chrome; Escape
continues to belong to in-game UI.

Current source treats roster `Enter` and workshop `ENTER WORLD` as the one
launch action. A valid one-shot same-tab handoff opens the 3D client directly
through a neutral loading surface; it does not flash the `/play/` character
picker or require a second click. Opening `/play/` directly still presents the
picker as a recovery path. This source behavior is not public until a new site
release is promoted.

The face compositor uses a runtime-cut skinned overlay from the PawnForge body
mesh. It shares the body skeleton and renders exact stored styles/colors in
world pawns, roster dolls, paper dolls, and portraits.

The TUI is a first-class protocol client with full-screen and plain modes,
movement, chat, combat narration, vitals, radar, inventory/crafting language,
and automated journeys. The website preview uses a real 80x24 TUI fixture.
There is no public TUI archive yet.

## Repository recovery and retained plans

The 2026-07-28 cleanup reduced 210 registered worktrees to the one canonical
checkout. Every old ref, worktree tip, dirty patch, non-reproducible payload,
and the corrupt-checkout raw tree was preserved before removal at:

```text
~/dev/releases/successor-preconsolidation-20260728T1811-MDT
```

The verified `successor-all-refs.bundle` and `SHA256SUMS` are the recovery
boundary. Do not recreate the full worktree farm; extract one named item into a
temporary worktree and reevaluate it against `main`.

Eleven useful Creative Wave briefs remain under `docs/future/` with explicit
non-current status. They were not deleted. The unfinished property/farming
iteration remains excluded from `main` as archive commit
`fa7a9977200f1e668e26a04a08a24e4e654eca94` and
`property-farm-wip.patch` in the recovery archive. It contains partial
land-claim, parcel, starter-seed, server projection, and farm-HUD work; it is
not built, published, or part of the current runtime.

## What is still pending

The next work should be chosen from these actual gaps:

1. Split `server/src/game/shard.ts` behind stable, tested domain boundaries.
   This is maintainability work, not a rewrite of gameplay authority.
2. Build new graphical/TUI packages from an accepted client release and prove
   hosted device authorization before repopulating the download ledger.
3. Run an independent isolated restore rehearsal of the latest complete
   pre-reset archive.
4. Repair the public `/current.json` CloudFront route, which currently returns
   403 while the authenticated S3 pointer remains correct.
5. Deliberately rework the archived property/farming changes or leave them
   archived; do not merge the old patch as if it were finished.
6. Continue real game content, balance, onboarding, performance budgets, and
   focused visual gates. The systems breadth is ahead of the playable content.

`main` may contain documentation or site changes newer than the deployed
authority. Built, published, promoted, and player-verified states must always
be reported separately.
