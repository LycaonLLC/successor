# Successor Character System

Status: current development-source character contract. The public alpha may
trail this source; exact production identity lives in `CURRENT_DEPLOYMENT.md`.

## Ownership

The server character store owns the roster and durable character profile. Rust
owns in-world gameplay state. The graphical client owns creation and roster
presentation; neither client may create a durable character or inventory result
locally.

`server/src/game/characterStore.ts` is the current code source for record shape,
validation, slot limits, snapshots, and record-kind storage.

### Identity invariants

Identity has five distinct layers; code must not use one as a substitute for
another:

- `ownerRef` identifies the account/profile that may select a character. It is
  an authorization scope, not an in-world actor id.
- `characterId` is the stable durable character identity and the owner key for
  character-scoped records and client storage.
- the TypeScript shard actor id for a durable player is the `characterId`;
  network session ids are connection-local and never durable.
- Rust `ActorAuthorityState.id` is the runtime simulation key. An authored
  player may retain a Rust placeholder id such as `player`, but its `entity`
  and the shard's fail-closed placeholder-owner map bind that slot to exactly
  one durable `characterId`.
- the 3D camera pawn, local presentation, authoritative player id, and command
  target must all resolve to the selected `characterId`. The server hello must
  match that provisional client identity before commands are enabled.

Placeholder ownership is never transferred to another character when the owner
disconnects or expires link-dead. Checkpoint restore reconstructs both
character-to-actor maps before ticks, periodic saves, or link-dead reaping can
run. Direct ticket entry carries the selected `characterId`; the redeemed
ticket remains the authorization source, and any hello mismatch fails closed.

## Record shape

A character record contains:

- stable canonical character id and owner reference;
- unique validated name;
- appearance: skin tone, hair style or shaved state, hair material, and an
  explicit nullable face selection (four face-kit feature styles plus
  eye/brow/lip colors, validated against the generated `face.gen` registry;
  null = intentionally blank face);
- presentation-only `worn` keys and a `wornColors` palette cache; neither can
  override Rust inventory or equipped state;
- last authoritative position and vitals snapshot;
- profession state, active title, and career goal;
- bounded versioned record kinds for macros and character-scoped social
  contacts;
- a one-way first-world-entry marker;
- created/seen/logout timestamps and accumulated play time.

Durable character ids use lowercase ASCII letters, digits, `_`, `.`, and `-`,
begin with a letter or digit, and are at most 64 characters. The same canonical
shape is enforced by the character store, desktop preflight, verification
fixtures, and transport identity.

Hair is appearance, not inventory. Creator clothing choice is retired. The
record may cache worn presentation, but Rust owns each equipped clothing
identity, its physical inventory row, colors, gameplay equipment, and weapons.

## Creation and roster

The 3D client starts at the roster unless a development launch explicitly
auto-enters. The roster shows live state and a 3D doll. Creation validates
name, skin, hair, ownership, uniqueness, and the account slot cap on the
server. Submitted creator worn pieces and colors are ignored; every character
uses the fixed authority outfit.

New names are globally unique without regard to case. They contain 3–16 ASCII
letters, with single hyphens allowed only between nonempty letter runs. Stored
records must satisfy the same grammar; an incompatible older record fails the
current store load instead of creating another name-resolution path.

Local development uses owner reference `local` and a five-character fallback
cap. Redeemed entitlements may supply the cap, clamped by the server's current
limit. Existing records are not deleted when an entitlement changes.

Local deletion is available only before a character's first world entry. Once
the one-way marker is set, or the shard finds durable Rust actor, inventory, or
placeholder-ownership evidence, deletion is refused even while the character
is offline. Retiring an entered character requires a future coordinated shard
cleanup/recovery flow; deleting only the roster row could orphan or later
misassign authoritative inventory.

## Appearance and equipment

PawnForge provides male/female bodies, hair pieces, creator wardrobe, armor,
weapons, sockets, tint zones, and animations. The same attachment/material
resolver is used by roster dolls, paper dolls, dialogue portraits, and world
pawns.

Facial features are a compositor texture, not geometry: the vendored
polygon-forge face kit (`client-3d/src/assets/faceKit/`, atlases under
`client-3d/public/assets/face-kit/`) renders onto a runtime-cut skinned overlay
made from the body mesh's forward, head-weighted triangles
(`client-3d/src/render/faceDecal.ts`). The overlay shares the body's skeleton,
wraps the actual head, and cannot drift like a billboard card. One cached
texture/material per exact face signature and one overlay geometry per body
geometry are shared by world pawns, roster dolls, paper dolls, and dialogue
portraits. Style ids and palettes are generated into
`server/src/game/face.gen.ts` and `client-3d/src/assets/face.gen.ts` by
`node tools/codegen/face.mjs`; the server validates creation against the same
registry the creator renders.

The character store persists the complete appearance. First entry sends that
appearance into the Rust actor, whose current checkpoint includes the face
fields. Rust streams it back through the TypeScript projection and shared
client to the renderer on reconnect. The graphical debug probe exposes the
local face-paint signature and readiness, so a creator-to-relog journey can
prove the exact styles and colors reached the real pawn rather than merely
existing in a roster response.

Appearance ids are validated shapes backed by the current PawnForge manifest.
Wardrobe pieces are generated into `server/src/game/wardrobe.gen.ts` and checked
against allowed slots and color zones.

Equipped gameplay items are streamed from authority state. Headwear may suppress
hair presentation, but it does not mutate the stored hair choice. Removing the
headwear restores the character's appearance hair.

## Entering and leaving the world

Entering a character resolves the join identity and authoritative actor. On
first entry, the server seeds Rust once from the creator/profile record,
forces a checkpoint containing the actor, the fixed two-piece starter outfit
(`under_bodysuit`, item 9,900,001, color `#89cff0`; `boots_canvas_ankle`,
item 7,319, colors `#303030`/`#808080`), and authored-placeholder ownership,
and only then commits the character's one-way entry marker. There is no
profession supply kit and no starter weapon; the two fixed rows are immutable
and are the entire first inventory. The hello packet is withheld until both
writes succeed. If a crash lands between those writes, durable Rust evidence
wins and the retry follows the returning path without granting a second
outfit.

On later entries, the exact Rust checkpoint is gameplay authority. When a
returning character joins and its live Rust actor is still registered, Rust
wins: character record snapshots of position, vitals, worn state, professions,
titles, and bounded record kinds are metadata/projection and must not reseed
or overwrite restored inventory, reservations, credits, vitals, or profession
state. Only when the live Rust actor is absent does the durable character
store's gameplay metadata seed the replacement actor, exactly once, before
its returning upsert.

Clothing on a returning already-registered actor is Rust-authoritative. Hello
waits for the `setActorLinkDead(false)` Rust refresh and projects the exact Rust
outfit. Character-store clothing is cleared only from a complete authority
inventory response; a partial response cannot erase fixed or current pieces.

Live state is `offline`, `online`, or `linkdead`. Disconnect intent is recorded
before the server chooses between an existing registration and an in-flight
first upsert. Per-actor bridge effects are serialized, reconnect can cancel a
pending disconnect, and stale late responses cannot project over the newer
desired state. Rust alone owns expiry at exactly 300 seconds. TypeScript has no
second expiry timer. Removal clears lifecycle maps, waits pending bridge work,
and removes the Rust actor before an authored placeholder is restored.

The hosted browser parent uses the clean exit path when changing characters.
It sends an exact-source/origin exit request to the current iframe; the client
fences reconnect, transmits `exit_world`, waits for the authority disconnect,
and acknowledges before the parent removes the frame and mints replacement
tickets. A raw iframe removal is an unclean disconnect and may correctly
produce link-dead state.

The desktop launcher stores the character roster, Rust checkpoint, and journal
under Electron's `app.getPath("appData")/successor/game-state` root. On Linux,
that honors `XDG_CONFIG_HOME` and otherwise normally resolves to
`~/.config/successor/game-state/`. It holds an exclusive state lock while the
authority runs. A clean close or update restart forces and waits for the
final checkpoint. Writes use temporary files, file synchronization, atomic
publication, and directory synchronization. A checkpoint is not published
until its journal marker is durable.

The desktop launcher accepts only `successor.character-store.v2` in that
durable directory. With no durability evidence, startup creates a new empty v2
roster. A missing roster beside checkpoint/journal evidence, a split layout, or
an older character schema fails closed instead of importing checkout-local
developer characters or manufacturing defaults.

Startup restores Rust before accepting sessions or simulation ticks. Missing,
corrupt, hash-divergent, or authored-slice-incompatible state fails closed when
the roster/journal says entered characters exist; the old files are retained
for migration or explicit recovery instead of silently creating a new world.
Most mutations can still rewind to the last periodic checkpoint after an
ungraceful process kill or power loss (currently a short, roughly five-second
window). Accepted world transitions are an exception: they force a checkpoint
before acknowledgement.

## World travel

A portal `EnterTransition` command mutates the existing Rust actor's area,
cell, position, and facing. It does not recreate the actor. Ticketed travel is
validated by the server and applied through Rust's in-place `relocateActor`
bridge operation. It consumes the ticket and clears only travel-incompatible
movement or sampling activity; it does not use an actor upsert.

Both paths preserve inventory, equipment, clothing, professions, skill boxes,
credits, vitals, recipes, genomes, and the rest of the durable actor. After an
accepted move, the shard forces a `world-transition` Rust checkpoint before
returning the receipt and then writes the current position to the
character-store projection.

## Life state

Downing, death, revival, cloning, sickness, respawn location, and restored
vitals are Rust-owned world transitions. The character record is not a second
life-state authority. Durable snapshots follow the authoritative actor after
the transition.
Each actor has a private bank container `bank:<actor-id>` with 100 distinct
slots, reached through the authoritative bank terminal in the Dustgate
commerce facility. A clone terminal backup costs 1,000 credits and pays bank
credits before the wallet. Clone death exposes a public corpse for 120
simulation minutes and restores the saved skill backup plus the fixed
two-piece outfit; the two immutable fixed rows never enter the corpse. Medic
resurrection preserves the character state and creates no corpse. Corpse
harvest and terminal interactions require authority proximity within 1,750
milli-cells.

## Client presentation

The graphical client provides the roster, creator, 3D preview, paper doll,
equipment views, character sheet, profession/title views, and death/clone UI.
The TUI receives the same character/world identity and presents relevant vitals,
equipment, professions, and life-state messages without graphical dependencies.

Client-side appearance cache is a presentation optimization. Streamed Rust
inventory and equipped clothing win after reconnect; character-store worn
metadata never becomes a second equipment authority.

## Production boundary

The public alpha uses the standalone same-origin account/control boundary at
`www.successorgame.com`. Its `CharacterStore` remains file-backed inside the
locked AWS state domain, while account sessions and one-use launch tickets
authenticate roster selection, game entry, and chat. The runtime continues to
key characters by an opaque owner reference and does not own account billing or
subscription policy.

The ComPress integration in `COMPRESS_HOSTING_FOUNDATION.md` and ADR-0011 is a
future scale-out direction, not the implementation behind the current public
alpha.

The current shard replaces an older session for the same `characterId` but
allows two different characters under one `ownerRef` to be online
simultaneously. That is the explicit current alpha multibox policy, not an
identity inference. A one-active-character-per-account rule, if required, must
be enforced at the authenticated owner/session boundary.

Friend and ignore edges use the durable `characterId` on both sides. `ownerRef`
is never a social key, so two characters owned by one account keep separate
lists. Ticket-authenticated chat binds to the selected character id. Social
rows persist in `successor.social.v1` inside the file-backed character store on
both desktop and the current single-host alpha. A relational/provider-backed
store remains future scale-out work.

Chat presence and routing follow the bound actor rather than the launch-time
zone. `LOCAL` is same-area proximity chat with a 24-cell inclusive radius;
`ZONE` follows the actor's current area; `GLOBAL` reaches the shard. Local
history is not replayed, and only local messages create world-space speech
bubbles. The graphical HUD and TUI both expose global send commands.

Guild (Player Association) membership, roles, permissions, tags, and wars are
Rust authority state keyed by actor id and projected through the
server-verified guild view. The character record is not a guild authority and
stores no guild rows; the client's ASSOCIATION window and guild chat channel
read only the projection.

Hosted roster mutation, character selection, one-use ticket entry, and
per-character macro GET/POST/DELETE are present in the public alpha. Hosted
macro mutation is same-origin and CSRF-protected, uses `CharacterStore` as the
sole writer, and never gives the iframe account/session/CSRF secrets. This does
not make the current file store a multi-host database or complete future
account-provider integration.

## Verification

Character changes require focused current-schema validation/projection tests,
route and room identity tests, graphical roster/appearance tests, and an
enter/reconnect proof. Incompatible pre-alpha state is backed up and reset; it
does not require a production compatibility test. Inventory persistence
changes additionally require a real Rust-process restart proof with exact
per-character rows, raw checkpoint inspection, reversed reconnect order, and
no duplicate or cross-character ownership.
The maintained restart proof is
`desktop/test/durable-character-inventory.integration.test.mjs`, which also
holds learned profession skill boxes and the active title exact across a real
desktop process restart.
World-travel changes additionally require an exact Rust actor comparison before
and after a portal, an in-place relocation proof, and a serialized checkpoint
restore that holds actor state and inventory.
Equipment/appearance changes also require PawnForge load, socket, material,
paper-doll, and world-pawn coverage.
