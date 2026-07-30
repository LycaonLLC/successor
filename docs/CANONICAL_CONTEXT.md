# Successor Canonical Context

Status: current supported architecture as of 2026-07-28.

This is the repository's source of truth for product scope and ownership. Code
and tests define exact behavior; when they change this contract, update this
file in the same commit. `CURRENT_PROJECT_STATE.md` is the dated implementation
inventory. `VERIFICATION.md` owns proof commands. Other documents provide
focused design detail and cannot introduce another active runtime path.

## Supported topology

| Layer | Location | Responsibility |
| --- | --- | --- |
| Graphical client | `client-3d/` | Three.js world rendering, input, HUD, audio, shaders, effects, and local presentation |
| Terminal client | `client-tui/` | Full-screen and plain terminal presentation over the same game protocol |
| Shared client runtime | `client/` | Network host, command vocabulary, streamed-state projection, shared rules, and headless automation |
| Desktop distribution | `desktop/` | Electron packaging and lifecycle for the graphical client and an isolated local authority |
| Public site shell | `site/` | Marketing, account, connect, browser launch, roadmap, legal, and native-download presentation |
| Network edge | `server/` | Rooms, identity, chat, AOI, packet shaping, persistence projection, and the Rust bridge |
| Gameplay authority | `crates/successor-sim/` | Deterministic world simulation and gameplay mutations |
| Shared Rust contracts | `crates/successor-{core,inventory,net,wasm}/` | Types, inventory primitives, wire commands, and platform bindings |
| Public deployment | `ops/deploy/` | Immutable client/site publication, AWS infrastructure, and single-writer server operation |

There are two supported player-facing clients. `client/` is a shared package,
not a third visual client. Both clients submit the same server commands and
render the same authoritative state.

## Public alpha topology

The supported public alpha is live:

```text
www.successorgame.com
  -> S3/CloudFront site shell
  -> immutable browser-client release on CloudFront
  -> same-origin account/control routes
  -> one-use game and chat tickets
  -> world.successorgame.com ALB
  -> one private EC2 host
  -> one digest-pinned TypeScript/Rust authority container
  -> one encrypted persistent state domain
```

The marketing site and browser-client pointer are separately promotable. A site
release does not deploy gameplay, and a game release does not imply a site or
native-download promotion. The public EC2 authority remains single-writer and
has no public SSH ingress. SSM is the operator path. S3/CloudFront owns the
site, browser client, and native archives; the ALB owns public game/chat
ingress.

`CURRENT_DEPLOYMENT.md` owns the exact current site release, client manifest,
source commit, server image digest, state generation, and download manifest.
Production identity must be observed from those pointers and endpoints; it is
not inferred from the newest development branch.

The hosted roster's `Enter` and the character workshop's `ENTER WORLD` are the
single visible launch action. The parent stores only the bounded opaque
character id in a one-shot same-tab handoff, then `/play/` validates that id
against the authenticated roster and opens the 3D client directly. It must not
insert another character picker or confirmation into that path. A direct
visit to `/play/` retains the picker as a fallback, and reload never replays a
consumed handoff.

When browser play changes characters, the parent shell retires the old frame
before minting replacement tickets. It asks that exact client window at the
exact published client origin to exit the world; the child sends
`exit_world`, fences reconnect, waits for the server-side disconnect, and
acknowledges the parent. The parent then removes the frame and requests the new
one-use launch. The acknowledgement wait is bounded so a broken child cannot
hang the shell, but teardown never pretends that a timeout was a clean exit.

The release identities in a hosted launch have separate jobs.
`SUCCESSOR_CLIENT_RELEASE_ID` identifies the immutable browser build,
`SUCCESSOR_SERVER_RELEASE_ID` is the canonical server protocol/world identity
compiled into that build, and `SUCCESSOR_RELEASE_ID` may carry the broader
stamped deployment identity. A client rejects a launch when either protocol
identity differs; deployment templates must not conflate the server protocol
identity with the stamped release id.

## Runtime flow

```text
3D client or TUI
  -> Colyseus command / chat connection
  -> TypeScript game server
  -> Rust authority bridge
  -> deterministic state transition and events
  -> AOI-filtered snapshot or patch
  -> client projection and presentation
```

Rust owns movement acceptance, structure collision, targeting legality, combat
resolution, damage, life state, inventory mutations, resources, crafting,
professions, farming, trade settlement, NPC behavior, population activation,
and economy events. TypeScript owns transport and projection; it does not run a
parallel actor or combat simulation. Clients may predict or animate, but they
do not make gameplay results true.

Active trade negotiation remains Rust-owned. The TypeScript server may cache
the latest participant-scoped authoritative `GameTradeSession` projection by
actor and replay it after `game.hello` when that participant reconnects.
Terminal trade delivery clears both participants from the cache. The cache
never settles a trade, and actors outside the trade never receive it.

Durable character identity and Rust gameplay state form one persistence
contract. The file-backed character store owns roster/profile metadata and a
one-way first-world-entry marker; the Rust checkpoint owns inventory,
equipment, position, vitals, professions, credits, and other gameplay truth.
First entry is not acknowledged until the Rust actor and inventory have been
published in a durable checkpoint and the marker has then been committed.
First-entry safety only changes the spawn selected for an explicit never-entered
durable character, using clone respawnCell/facing before checkpoint and
CharacterStore claim; it never moves returning/live/link-dead actors and adds
no immunity. Returning-character profile snapshots are presentation metadata and
must not overwrite restored Rust gameplay state.
On a returning live join, a Rust actor that is still registered wins outright
and receives no seed. Only when the live Rust actor is absent does the durable
character store's gameplay metadata seed the replacement actor, exactly once,
before its returning upsert.

World travel keeps that same durable Rust actor. `EnterTransition` changes only
the actor's spatial fields and cancels resource sampling. Ticketed travel uses
the bridge's in-place `relocateActor` operation; it must never force an actor
upsert. Inventory, equipment, professions, credits, vitals, recipes, and other
durable state remain attached to the actor. An accepted portal or ticket move
forces a `world-transition` checkpoint before the server acknowledges it, then
refreshes the character-store projection.

The current file format is `successor.character-store.v2`. Every record carries
its owner, complete appearance (including an explicit nullable face), worn
projection, position/vitals, profession/profile fields, bounded record kinds,
world-entry marker, and timestamps. The standalone account database head is
`alpha-control-bug-reports-v2`; startup has one explicit, checksum-pinned
upgrade from `alpha-control-current-v1` that preserves accounts and adds the
player-report ledger. Every browser or device launch carries immutable
provenance. Older character formats, unknown account migration heads,
claim-code ownership repair, and synthesized ticket identity are not supported
inputs.

The bridge keeps the wire request names `exportState` and `importState`, but the
payload is the current-only `authority.checkpoint.v1` schema at version `1`.
It stores durable progress and the ids of open authored doors. It does not own
map geometry, tuning, content catalogs, static collision, rebuildable caches,
metrics, or one-shot delivery queues. Restore validates `payloadHash` and
places durable progress into the authority constructed from the current
authored world. `stateHash` records the source authority state at export;
`payloadHash` protects the serialized checkpoint payload. Unknown schemas,
unknown versions, and altered payloads fail closed.

Character creation requires one ordinary novice profession allocation. That
box spends its normal 16 points from the ordinary 250-point cap; it is not a
free, protected, permanent, or class-like slot. Creation grants no profession
supply kit and no starter weapon. Every new or freshly cloned character owns
exactly the fixed two-piece outfit: `under_bodysuit` (item 9,900,001, color
`#89cff0`) and `boots_canvas_ankle` (item 7,319, colors `#303030`/`#808080`).
Both fixed rows are immutable, are restored by the clone lifecycle, and never
enter a corpse. Training changes skill ownership and budget only; it never
grants or reissues equipment.

`activeTitleId` is authority input. An explicit null remains null during actor
registration; a display-derived title must not be promoted into that field.
Rust validates any non-null title against the actor's claimed skill boxes.

## World contract

The checked-in default world is generated by
`tools/successor/configure-open-desert-fixture.mjs` and compiled by
`tools/successor/compile-map-bundle.mjs`.

The source and compiled output are:

- `client/public/successor-slice/open-desert-slice.json`
- `client/public/successor-slice/open-desert-map-bundle.json`

The fixture contains two 1024 by 1024 areas: the open desert and Verdance
forest. It has one camp spawn, travel in both directions, the Dustgate clone
facility, the Dustgate commerce facility, and 91 spawn zones: 18 roaming
two-member rogue camp zones, one camp sparring zone, and 72 wildlife zones.
There are no starter caches, monuments, or cover props. Its six wildlife
species are Bellback, Pebblehorn, Snufflefin, Pocketclod, Mossmuff, and
Dapplepod.

The fixture identity string remains
`planetfall-v5-seed-424242-size-1024-rogues-18-desert-critters-48-verdance-critters-24-areas-open-desert-overworld-verdance-forest-overworld`.
The compiled slice contains 139 stable logical props/anchors, including the humanoid
camps' solid props, 19 take-only footlockers, sparse 15-prop Dustgate occupation,
and the interactive factory `dustgate-occupation-workbench` at cell (494, 508).
Dustgate hammer was removed instead of increasing asset caps. Bank and clone anchors
are `dustgate-bank-terminal`, `dustgate-cloning-facility`,
`dustgate-clone-terminal`, and `dustgate-clone-pod`; commerce anchors are
`dustgate-commerce-facility`, `dustgate-trade-terminal`, and
`dustgate-pa-terminal`.

The identity string is unchanged. The checked-in slice hash is
`69a19db8289b0d4711ccca5d4febef39b8dcd2ef662f9f70539935e49af8680e` and the
map-bundle hash is
`01df5d1d178a8199b5bbd62f7e2107f017f5ae2ba1ca45081bb0ecdbb8f65795`. The clone
facility sits at cell (513, 499), size 10 by 8, yaw 0, on the north edge of the
Dustgate plaza with its entrance facing south into the plaza. Its authored
floor is 0.02 m; the runtime floor after the fixture's uniform fit is
0.021052631578947368 m. The commerce facility sits at cell (500, 498), size
12 by 9. Inside it are the authoritative Dustgate bank terminal (503, 501),
trade terminal (506, 501), and PA terminal (509, 501); the profession trainer
Knox Vale stands at (510, 504). Bank, trade, and guild interactions are
validated against these terminal props within the 1,750 milli-cell terminal
interaction radius; the terminals are authority surface, not decoration.

Structure collision is anchor-based. The canonical anchor is the serialized
actor position; the collision ground center is that anchor plus 500/500
milli-cells. Rust resolves movement with a swept circle of radius 300
milli-cells and a 2-milli skin, running up to four depenetration passes and
three slide iterations. Facility collision comes from structural sidecars
(`successor.structure-collision.v3`): the clone facility carries nine stable
structural proxy boxes plus the `closed_door_panel` door blocker; the commerce
facility carries its wall boxes, 15 named furniture blockers, and a door
blocker. The sidecar's `terminal_cells_kept_clear` contract reserves local
cells (3, 3), (6, 3), (9, 3), and (10, 6) for the bank, trade, PA, and trainer
surfaces. No wall, furniture, or door proxy may overlap those cells. Detail
meshes are never collision. Humanoid camp props are solid world collision in
the slice itself.

Authority checkpoints use version 1 under `authority.checkpoint.v1`.
Bank storage is character-private in `bank:<actor-id>` with 100 distinct slots.
Clone death creates a public 120-minute corpse and restores the saved skill
backup plus the fixed two-piece outfit; the two fixed rows never drop into the
corpse. Medic resurrection preserves state and creates no corpse. The corpse
interaction radius is 1,750 milli-cells.

Dustgate's authored start-zone anchors are Knox Vale, the travel terminal, and
GR0K. GR0K is a neutral named social actor using the promoted humanoid droid
body. It has no trainer, merchant, quest, or combat role until one is explicitly
designed and authority-backed. The travel-terminal gameplay contract remains
authority-owned even when its visual asset or animated screen changes.

Rogues use deterministic combat behavior. Each humanoid camp is a permanently
clearable two-member encounter: exactly two members spawn at authored
spawn/patrol points among solid camp props, and no replacement wave appears
after both die. Each camp's durable footlocker is take-only; nothing can be
deposited into it. Procedural skirmishers ignore weather hazards regardless of
position. Player-placed Scout camps separately retain their physical
weather-shelter boxes. Hostile camps deliver one-shot, archetype-typed barks:
each encounter zone's bark claim is consumed once, including on a failed
chance roll, and never repeats.

Gaia wildlife species are Bellback, Pebblehorn, Snufflefin, Pocketclod, Mossmuff,
and Dapplepod. Bellback is proactive hostile. Pebblehorn retaliates after player
damage. Snufflefin, Pocketclod, Mossmuff, and Dapplepod remain passive. At corpse
creation, harvest rights freeze to the winning damage party: contributors are
partitioned by durable authority group or solo actor, and highest aggregate party
damage wins. Every individually contributing member of the winning group receives
full solo-equivalent kill XP and may claim one independent full Hide/Meat/Bone yield.
Losing parties and non-contributing group members receive nothing. Entitlements and
claims survive disconnect, group mutation, and restart.

Duels end by dissolution, yield (the yielder lives), a third incapacitation,
or an explicit close-range `Deathblow` against the downed opponent. Deathblow
is the only player-controlled finishing path; AI targeting never issues it,
and ordinary combat cannot damage a downed actor. A third incap or deathblow
uses the normal death/respawn lifecycle and ends the duel.

Chat routing reads the actor's current authority position on every send.
`LOCAL` reaches actors in the same area within 24 cells and is not replayed
from history. `ZONE` follows the sender's current area. `GLOBAL` reaches the
whole shard. Only `LOCAL` creates a pawn speech bubble; zone, global, guild,
trade, and whisper traffic stays in chat UI.

Guilds (Player Associations) are Rust authority state. `GuildCreate` requires
an authorized PA terminal, unique name and tag, and exactly 250,000 credits.
Invites, membership, roles, ordered permission masks, leadership transfer,
wars, and disbanding are authority commands. Public directory rows expose only
identity and member count; roster presence, location, last-seen state,
permissions, and wars remain member-private. Guild chat checks current
membership for every send and recipient. Guild state persists in the current
checkpoint. Fixture population, cells, hashes, and tuning must come from the
generator or generated JSON rather than prose copied into code.

The map bundle is renderer-neutral. It contains area/chunk metadata, logical
prop anchors, structure and transition data, spawn points, lighting zones, and
audio zones. It has no dependency on a visual asset atlas.

## Combat and life state

The active combat model is `roll`. Players enqueue named combat actions against
authoritative targets. Rust resolves attacks, range, accuracy, mitigation,
damage, resource costs, cooldowns, and lifecycle events. The graphical client
turns streamed roll events into tracers, muzzle motion, impact effects, sound,
and outcome text. The terminal client describes the same events in prose.
There is no authoritative physical-projectile entity stream in this model;
tracers and impact travel are event-driven presentation.

The Slugthrower authority identity remains the base ranged path; item 3101 now
uses the STEN-derived presentation. STEN Mk II, Kiln, and Lightning form the
later Marksman ladder, with Kiln at Rifle IV and Lightning at Marksman Master.
Scrapline Machete, Field Saber, and Quarry Chopper are primitive no-certification
blades. Vibrosword requires Brawler Melee III and Plasma Sword requires Melee IV.
Every live player can still use the basic attack unarmed. Unarmed has no visible
model and never implies a hidden Vibrosword. Exact profiles and action timing
belong to Rust content tables and `docs/COMBAT_ROLL_MODEL.md`.

Life state, downing, revival, cloning, sickness, loot eligibility, and corpse
harvest are authority-owned. A client overlay or animation is never evidence of
a completed transition without the corresponding streamed state.

## Gameplay systems in scope

The current authority and clients contain working foundations for:

- character roster, appearance, equipment, and persistence projection;
- chat, groups, targeting, interaction, radial actions, and macros;
- inventory containers, stacking, transfer, loot, equipment, and examination;
- professions, trainers, abilities, certifications, and progression;
- surveying, sampling, extraction, resource identity, and resource containers;
- crafting sessions, experimentation, schematics, components, and item quality;
- factory manufacturing via `FactoryManufacture` taking `factory_id` and
  `schematic_id`, validated by Rust for range, ownership, physical draft,
  ingredients, and output variant before infallible atomic debit/output/use mutation,
  where final use retires physical draft and receipt is owner-only;
- camps, travel, clone facilities, trade, physical currency, and exchanges;
- hosted macro CRUD (GET/POST/DELETE) under authenticated same-origin parent/server
  boundary with `CharacterStore` as sole writer, `x-csrf-token` protection,
  generation ordering, and no iframe secrets;
- duels with yield, third-incap, and explicit deathblow endings;
- guilds (Player Associations) with charter, invites, roles, permissions,
  wars, guild chat, and a public directory;
- farming plots, seeds, crop stages, additives, ingredients, and prepared food;
- extractor lifecycle, creature harvest, gene sampling, genome scanning, and
  splice-workbench flows, where unknown genomes fail closed;
- world clock, lighting, weather, ambience, terrain streaming, and flora scatter.

Universal baseline verbs include bare-handed basic attack, resource hand
sampling, and eligible-corpse harvesting. Profession ownership is still
required for its specialist equipment, yields, recipes, and progression. The
first physical action must not be circularly locked behind the materials it is
supposed to obtain.

The basic Camp Kit is a Scout-novice hands recipe using 24 Bone and 36 Hide. It
does not require copper, coal, a survey tool, or a Field Multitool. A placed
owner camp persists while occupied or revisited and tears down only after the
owner has remained outside its six-cell radius for more than ten minutes.

These are foundations at different depths. A catalog row, GLB, UI window, or
test fixture does not by itself mean a complete player loop. The dated state
document distinguishes integrated runtime content from preserved library work.

## Client contracts

### World cardinal contract

Authority coordinates are the one canonical compass basis: `+x` is east,
`-x` is west, `-y` is north, and `+y` is south. Graphical world `z` preserves
authority `y` directly. Therefore north is screen-up, south is screen-down,
east is screen-right, and west is screen-left in movement, the 3D world,
radar, both datapad map framings, survey displays, waypoints, and terminal
bearings. The graphical camera is locked at yaw `0`; pitch may change framing
but must not rotate the compass. Player-facing code must not add a
camera-relative or isometric coordinate transform.

Radar input uses the visible circular scope as its hit region; transparent
corners pass through to the world canvas. An actor dot wins over ground input.
Radar and orbital ground movement are alive-only, clear selection, examine,
and soft explicit locks, clamp destinations to legal cell-center anchors, and
call the same `setClickMoveTarget` path that emits normal Rust `Move` commands.
Map waypoints are presentation-owned markers and do not bypass movement
authority.

### Graphical client

`client-3d/` uses a locked north-up pitched orthographic camera, GLB actors and props,
terrain streaming, authored creature rigs, PawnForge humanoids, and a custom
post-processing stack. Its HUD uses one visible cursor and server-driven target,
interaction, inventory, combat, and world state.

Presentation code may derive interpolation, labels, particles, audio layers,
and temporary camera state. It must not invent position, damage, inventory,
cooldowns, or lifecycle truth.

Positional effects are hard-silent at and beyond their authored maximum range;
there is no nonzero far-distance floor. Short combat impacts use short ranges,
while firearm reports may carry farther. Ambient and combat loops use
time-based fades rather than distance-independent starts or abrupt stops.

Interior cutaway is presentation only. It uses 250-milli inner and outer
hysteresis, flips only after two consecutive authority snapshots agree, and
fades over 0.25 s. Floors, the interior keep set, and the door never hide.

Empty-ground click movement is deterministic presentation-side A* over blocked
and movementBlockers with 384 expansions, 48 waypoints, and 6 replans, emitting
`SetMoveIntent` octants only. It does not add path or position authority. Direct
keyboard input, combat-sensitive control, blocked movement, area changes,
death, arrival, and no-progress detection cancel the current click target.

The graphical sprint toggle stores player intent. Rust owns speed, Action
drain, exhaustion, and recovery. Reaching zero Action sets
`sprintRecoveryLocked`; movement is forced to walking until Action is full,
and locked recovery is exactly 800/1000 of normal regen. The client keeps the
toggle armed, shows `WINDED` from the streamed lock, and may resume sprint only
after Rust clears it.

The first-session guide is character-scoped, one-shot presentation. It teaches
MOVE, USE, and ACT without creating quest authority. MOVE starts tracking only
after the authority player actor has hydrated and completes on real movement.
USE completes on an ordinary interaction. The trainer breadcrumb remains until
the player reaches Knox Vale; talking to another actor or opening an ordinary
container cannot complete it.

The macro directory resolves character-owned records first, local read-only
`.macro` files second, and the checked-in starter pack last. Local files never
become editable character data implicitly. Hosted macro CRUD (GET/POST/DELETE)
lives under the authenticated same-origin parent/server boundary, with
`CharacterStore` as sole writer, `x-csrf-token` CSRF protection, and generation
ordering to prevent rollback. The iframe receives no account, session, or CSRF
secrets. Desktop and TUI loaders reject symlinks, path escape, invalid UTF-8,
invalid names, oversized bodies, and excess files.

### Terminal client

`client-tui/` is a first-class game client. It supports a full-screen terminal
layout and line-oriented plain mode, keyboard movement, slash commands, chat,
combat narration, vitals, queue state, radar, inventory/crafting language, and
automated terminal journeys. It must remain DOM-, WebGL-, and GPU-free.

## Assets and content maturity

Runtime assets live under:

- `client-3d/public/assets/`
- `client/public/successor-audio/`
- `client/public/successor-slice/`

PawnForge source files live in the neighboring source checkout at
`pawn-forge/pawnforgev2`. Runtime copies are exported and
synced into `client-3d/public/assets/pawn-pack/`.

Production asset closure is 420 files and 229,373,434 bytes under unchanged
caps of 420 files and 230,000,000 bytes. Dustgate hammer was removed instead
of increasing the cap. Bundle source policy forbids `feature-*` references in
emitted `index.html`, keeps Three.js on the eager vendor path while the emitted
index has no static `feature-*` JS/CSS, and loads features dynamically.

The public browser release, authority image, native manifest, and site release
are recorded in `CURRENT_DEPLOYMENT.md`. The primary development branch is
`main` and may be ahead of the production game source; integrated does not mean
promoted.

Use these maturity labels when discussing content:

- **Integrated**: selected by the default fixture or a player-facing runtime
  registry and exercised by a focused test or journey.
- **Cataloged**: has a stable id, manifest/registry entry, and loadable asset,
  but may not appear in the default world.
- **Source**: preserved authoring work, experiment, shader, effect, or model that
  is not yet promised by a runtime registry.

Keep authored shaders, effects, weather, crops, flora, equipment, creatures,
props, source `.blend` files, socket metadata, and provenance even when they are
only cataloged or source-stage. Generated builds, screenshots, local caches,
and asset-lab thumbnails are not source assets.

## Local contracts

Default local endpoints are:

- authority: `127.0.0.1:28093`
- graphical client: `127.0.0.1:5179`

The desktop shell selects an isolated authority port for its own lifetime. A
listening client page is not proof of the expected shard. Check `/game/status`
and match the fixture state hash before a play claim.

The desktop distribution keeps its roster, checkpoint, and journal together
under one durable state directory and holds an exclusive kernel lock for the
full authority lifetime. Clean shutdown is a save barrier: failure to publish
the final Rust checkpoint is surfaced as a failed shutdown, not treated as a
successful exit. A missing, corrupt, or slice-incompatible checkpoint is kept
in place and blocks startup when entered characters or journal evidence show
that durable world state should exist; recovery, migration, or an explicit
reset is required instead of silently starting a fresh world.

The former versioned authority-export and authored-world migration ladder is
not an active compatibility surface. Current builds read only the current
checkpoint schema. An incompatible pre-refactor save may be archived for
forensics, but using it requires new deliberate conversion work; normal alpha
development uses an explicitly authorized reset. Startup must never rename,
discard, replace, or silently freshen incompatible durable state.

Desktop accepts only the current character store beside the current checkpoint
and journal. A new state directory gets an empty v2 roster. Missing,
split-layout, or older-schema state fails closed when the other durability
files imply an existing world; the launcher never imports
`server/data/characters.json` from the source checkout.

Pre-alpha account, character, and world data are disposable test state. Do not
build compatibility branches solely to retain it. An intentionally incompatible
release uses the operator-controlled backup and coherent-reset procedure in
`OPERATIONS.md`; startup itself never performs that reset.

`pnpm server:local:persistent` remains a loopback developer helper, not the
desktop durability contract or a supported multiplayer deployment lane. It
must not be presented as a persistence-safe friend host until its state-domain
locking, character-store colocation, restore readiness, and graceful restart
ordering match the desktop supervisor.

Changes under `client-3d/` or `client/src/` require `pnpm desktop:build` before
handoff because the desktop launcher consumes packaged output.

## Scope discipline

New work must extend this topology rather than create a parallel authority,
fixture, visual client, asset namespace, or gameplay-specific test world. Use
small neutral test builders for unit coverage and the generated open-desert
fixture for end-to-end proof. Add a new product surface only through an explicit
decision recorded here.

`docs/future/` contains retained design briefs, not current contracts or
implementation claims. Revalidate a brief against `main` before using it, then
move any implemented contract into the canonical docs or a focused current
specification in the same change.
