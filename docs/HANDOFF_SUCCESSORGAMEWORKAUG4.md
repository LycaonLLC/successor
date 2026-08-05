# Successor game work handoff — 2026-08-04

Status: development-source handoff. This note does not override
`CANONICAL_CONTEXT.md`, `CURRENT_PROJECT_STATE.md`, `CURRENT_DEPLOYMENT.md`, or
`VERIFICATION.md`.

## Resume point

- Working branch: `integration/rust-ui-runtime-20260803`
- Co-developer branch: `dev/rust-client`, fully merged in, nothing outstanding
  in either direction at handoff
- Not merged to `main`. Not deployed. No public-journey claim.

Waves are recorded newest first below. Wave 6 corrects the in-game verification
claimed for Wave 5: read it before trusting any Wave 5 runtime result.

## Wave 2 — UI parity pass

Everything below was exercised against a live loopback authority and a
connected `successor-dev` client, not only unit-tested.

### Three things blocked local work and are now fixed

- **`scripts/server-local-persistent.mjs` was Linux-only.** It discovered the
  listener through `/proc/net/tcp` and `/proc/<pid>/fd`, which do not exist on
  macOS, so it started a healthy server, failed to find it, and SIGTERMed it.
  Listener discovery is now platform-split: `/proc` on Linux, `lsof` on macOS,
  same socket/process shape and the same ownership assertions on both.
- **The documented control binary could not be controlled.** `make -C
  client-rust native` builds without `dev-tools`, so `out/bin/successor`
  refused `--control-port` and `--endpoint`. There is now a `make -C client-rust
  dev` target producing `out/bin/successor-dev`; the shipped binary stays
  capability-free.
- **A durable character could not join from the native client.** The shard
  rejects the bare `{playerId, actorId}` dev shape for any id its character
  store owns (`colyseusRoom.ts:454`). The client takes `--character-id` and
  sends `{characterId}` when given one.

The local checkpoint also refused to restore, correctly: `a485288b` regenerated
the world slice for the door apertures, so the Aug 3 checkpoint belonged to a
different fixture. Backed up to `server/.local-state-archive-20260804T120839`
and reset.

### Cursor

The fixed screen-centre crosshair is gone. The original has no such reticle on
the ground HUD: aim lives on the pointer, and the cursor set switches to
`ui_cursor_attack` over a valid target.

`engine-render/src/cursor.rs` draws the original's cursor vocabulary —
arrow, select, attack, interact, move, four resize axes, text, busy, blocked —
from the same primitives the window chrome uses, so the pointer is made of the
same material as the frames it sits on. No bitmaps, no atlas cell per
resolution; SWG cursor art is proprietary and stays host-local.

The pointer is drawn last, after the composite bands, so no 3D viewer paints
over it. `Graphics::constrainMouseCursor` clips the hardware cursor to the
client rect; GLFW has no portable clip, so the equivalent is to hide the OS
pointer while it is inside the framebuffer and hand it back when it leaves.

Shape resolution follows the original's rule — the mediator under the pointer
wins, and only when nothing owns the pointer does the world speak: resize edge
or caption first, then panels, then a hostile (attack, but only while something
is wielded), then a selectable actor, then a world verb prop under the pointer.

### Windows

**Title-bar dragging silently resized instead of moving.** The 8 px
`UIWidget::RESIZE_MARGIN` was applied to the whole frame rect, and a 19 px
caption minus 8 px of top resize band leaves a 3 px move sliver — so almost
every caption press landed on the top edge. In the original the caption is a
child page that takes the press and moves the frame; only the border resizes
there. `CAPTION_RESIZE_MARGIN` is 3 px inside the caption band.

Measured over all eight dock windows through the control protocol: move
translates both axes with size preserved, bottom-right and top-left corner
resize both land exactly, close-and-reopen preserves the rect, and all 28
registered frames survive a client restart with geometry, open state, and lock
state intact. HUD panes stay locked and gameplay-transparent until a right
click unlocks them, then move and resize like any frame.

`status` now reports `window_frames`, so this is measured rather than eyeballed.

### HUD panes

The player status plate reserved 92 px for content that was often 59 px: a tag
band most sessions never carry, and a weapon readout that only exists while
something is wielded. State chips moved onto the name row, and the weapon
readout became its own pane. The plate is now exactly name + RUN + the three
pools.

Weapon and group are managed panes of the same grammar as the target plate,
each painting nothing when it has no content — an unarmed solo player sees one
tight plate and no empty furniture. `HUD_SURFACE_COUNT` is 9.

### Inventory

Equipment slot rails frame the paperdoll — six cells left, five right, filled
slots carrying the item glyph, click to select and click again to unequip. The
column reserves the rail lanes before the doll claims the width; below a
96 px doll the rails drop and the portrait takes the column, which is what the
250x244 resize floor gets.

Also: category filter, a three-way sort over the filtered rows, an inline split
stepper replacing the hardcoded 50 % split, and an honest held-stack count in
place of a meter that reported UI page slots.

**One defect the filter work exposed:** the composited 3D item models were
keyed off `held()` while the cards drew from the filtered, sorted, paged order,
so every filter put models under the wrong labels. The preview lanes now
consume the same order the 2D layer drew.

### Theme, transparency, sound, radar

- Window surfaces carried hardcoded cyan ink, so a theme change recoloured the
  HUD and left every workspace frame cyan. Ink resolves from
  `hud::active_palette()`; one theme covers the whole UI.
- `WINDOW OPACITY` and `HUD OPACITY` settings, `0.35..=1.0`, persisted under the
  `uiOpacity` section. Fills fade; type, icons, and the bright perimeter do not,
  because a translucent glyph over terrain is unreadable.
- Thirteen `UiCue` variants existed and exactly two ever fired. Panel open and
  close, deny on every rejection, item transfer, credits, area transition, chat
  send and receive, and both toolbar cues are now wired at their event sites,
  with a retrigger floor so a bulk transfer does not stack into a click storm.
- Radar: scale mismatch between plotting and clamping caused edge flicker,
  `scope_of` did not subtract its own top inset so the scope escaped the pane on
  resize, cardinals ignored camera heading, and there was no range control.
  Fixed, with a 32/64/96/128/192-cell range ladder.

### Wave 3 — measured hi-fi audit of all 30 surfaces

`tools/observe/pane_gallery.py` opens every registered surface alone under two
themes and grades it. The first run said the UI was in worse shape than it
looked, and every number below is from that harness.

**Panes were near-black slabs.** Every theme's `bg_panel` was around `#070b0d`,
so 80–94% of a window's own ink was near-black and a window read as a hole
punched in the world. The original's pane is a translucent tint under a bright
outline (`ui_options.inc` centre `#003848`). All four palettes were re-derived
from their accent and checked against WCAG AA at small-text size — ink clears
7.2:1, dim ink 4.6:1, accent 4.7:1 — and `every_theme_is_readable_and_tinted`
now fails the build if a future palette regresses either property. Oxide's rust
accent could not clear the bar against any warm pane and was lifted from
`#c44a26` to `#e0673a`.

**Three widgets no theme could reach.** `ButtonStyle::default`, `text_field`,
`slider`, and `checkbox` were hardcoded slate-and-gold in `engine-render`,
which has no palette. They were the largest frozen surface in the UI, frozen
across chat, options, macros, the bug report, the inventory footer, the
character sheet, and the graphics tuner. The engine widgets now take their
chrome as a parameter and the app passes `hud::button_style()`.

**The chat console was 0% themed** — a hardcoded near-black slab, the darkest
thing on screen and the only pane that never followed the theme.

**Empty examine and converse windows were black rectangles.** A live 3D viewer
needs an unlit backdrop, but that was implemented by darkening the whole frame,
so a pane that is mostly viewer went black. `chrome::viewer_seat` now paints
only the viewer cell and the frame stays themed.

Result across 30 surfaces: 26 are 98–100% themed with zero near-black and
contrast 6.6–10.5. The rest are explained, not outstanding — pool tints and the
composited paperdoll are identity and must not theme, and four HUD panes draw
nothing without a target, a weapon, a group, or a queued ability.

**Not done:** the functional panes are still thinner than the web client's.
`survey` renders four resource rows where `client-3d/src/ui/windows/defs/
surveyToolWindow.ts` renders a concentration heatmap and sample results;
`bank`, `craft`, `loot`, and `trade` are similarly behind
`client-3d/src/ui/`. Most of those gaps are UI-only — `WindowModel` already
carries the data — but they are a feature build, not a polish pass.

## Equipment on both bodies — measured

- 101 skinned wearables, each with a male and a female GLB. Female armour seats
  within 0.36 mm of the male set.
- 17 rigid socket attachments. **Male and female mount positions are identical
  to 0.000 mm** — both bodies share one 45-joint skeleton, so every socket
  resolves to the same world point. Rigid equipment is equally correct on both.
- Five weapons bury their grip 64.9–66.2 mm in the hand **on both bodies**:
  `wpn_smg`, `wpn_carbine`, `wpn_sniper`, `lightning_carbine`, `wpn_launcher`.
  The earlier note flagged this for `wpn_carbine_kiln` alone; it is five mounts
  sharing one copy-pasted pose. Re-posing affects how each weapon reads in the
  hand, so it stays a deliberate art call, not a silent fix.
- `hat_field_cap` is the one genuine per-body rigid defect: 1.25 mm into the
  male scalp, 10.7 mm floating off the female head.
- Hair is unchanged and still parked behind head sign-off: 30 male and 26
  female variants fail the scalp gate.

`content-pipeline/labs/humanoid-runtime-refit/probe_weapons.py` is the new gate
for all of that; it writes `reports/rigid_mount_fit.json` and fails closed.

## Known open

- The five buried weapon mounts and the female field cap above.
- Hair refits, still behind head sign-off.
- **Doorways are better, not fixed.** Interior reachability went 7/7/5 percent
  to 19/44/32 for starter/court/wing. The remaining seal is most likely the
  300 milli collision radius closing gaps under 0.6 cells against a 0.95 m wall
  pitch. Measure with `collision_map.py` before carving further.
- **Floor sinking is not proven fixed.** The `enterableFloorYAt` port was
  genuinely missing, but `floorHeightM` is 0.021 m for the cloning facility and
  cannot explain waist-deep sinking. Something else is also wrong.
- **Doll render targets alias.** A 384x640 target composited into a ~76 px
  column with no mipmaps breaks up at three-quarter angles.
- **No live combat exchange yet.** The weapon wields and the authority accepts
  input, but no hostile was found in the ground covered. Spawn one deliberately
  rather than hunting. The attack cursor is therefore unit-proven, not
  journey-proven.
- Inventory still has no drag-and-drop and no sub-container navigation.


## Wave 6 — HUD anchors to the real framebuffer; Wave 5 proof corrected

### The bottom band floated mid-screen on anything but 720p

A `ConnectedScene` is built before its first framebuffer exists, so
`framebuffer` starts at the `(1280, 720)` placeholder. `load_persisted` ran
before any real frame and matched the saved layout's viewport stamp against
that placeholder: a 720p document looked authoritative, so its rects were
applied verbatim. The first real frame then set the live size but found no
pending HUD slots, so nothing re-anchored. On a 1600x1000 window the chat
console, notification strip, and ground radar all stayed pinned to `y=720`,
floating in the middle of the world.

The decision cannot be made at restore time. `restore_window_layout` now
applies saved rects unconditionally and the scene records the document's
viewport stamp; `frame` compares that stamp against the real framebuffer and
re-anchors the band when they disagree. This covers first launch and a live
window resize through one path.

`hud_surfaces_re_anchor_when_the_framebuffer_changes` passed throughout the
regression. It only ever drove `register_hud_surfaces_at` with an explicit
viewport — the one path production never takes. It now asserts the stamp
comparison directly and proves the stranded-mid-screen state before the
reconcile pulls the band back to the edge.

Measured live through the control server's `window_frames`:

| framebuffer | max HUD bottom | max HUD right |
|---|---|---|
| 1600x1000 | 992 | 1600 |
| 1728x1052 | 1044 | 1728 |

The 1728x1052 case is the useful one: macOS clamped a `--size 1920x1200`
request down, and the HUD followed the framebuffer it actually got rather than
the one that was asked for.

### Correction to the Wave 5 record

Wave 5's code landed as described above, and the repository gates were green
for it. Its *in-game* verification was not real and should not be relied on:

- The local authority's Rust bridge child had exited. The Node shard kept
  serving a frozen world (tick stuck, `sessionCount: 0`) and closed every join
  with `1011 durable character entry failed`, which the client discards without
  printing. Restarting the client against that zombie shard cannot succeed, and
  it was restarted many times instead of being restarted itself.
- The screenshots filed as proof of the inventory radial, the GR0K builder, and
  the brightened buildings are three crops of the same PLANETFALL loading
  screen. They show a client that never left `AWAITING WORLD SNAPSHOT`.

A clean `node scripts/server-local-persistent.mjs` brings the bridge back; the
same client then reaches `app_mode: Connected` and streams the area. Before
trusting an in-game claim, check `/game/status` shows a rising `tick` **and**
`sessionCount: 1`, and that `successor-control status` reports
`game_connection: Connected` — a screenshot alone does not distinguish the
world from the loading screen.

### Still unverified in-game

Wave 5's radial menu, character builder, converse bust camera, and item
preview fill light are code-complete and unit-covered, but no longer carry an
in-game proof. They need a pass against a live shard.

## Wave 5 — GR0K character builder, inventory radial, debug grants, item preview fill light

### GR0K conversational debug character builder

Stands in for SWG Core3's `CharacterBuilderTerminal` ("blue frog"):

- **Multi-select page navigation**: Root -> Packs / Item Categories / Professions / Credits -> Multi-select leaf list. A tester can tick several items, packs, or skills and commit them in one action via `GRANT SELECTED`.
- **Data-driven from runtime**: `tools/codegen/generated/debug-catalog.generated.json` (schema `successor.debug-catalog.v1`) is generated directly by `crates/successor-sim/src/bin/emit_debug_catalog.rs` probing `inventory_item_name` (173 items), `authority_skill_box_definition` (126 skills across all 7 professions), and curated packs. A `--check` flag is wired into the `run.sh --rust` hygiene gate so catalog drift fails the build.
- **Wire commands**: `ClientCommand::DebugGiveCredits { amount }` (kind 98) added across `successor-net`, `successor-sim`, `authority_bridge`, and server protocol schemas. Negative amounts drain the wallet. Skills commit as ONE `DebugGrantSkillBoxes` call with a list of IDs.
- **Dual debug gating**: `WindowAction::resolve` gates debug commands under `#[cfg(not(feature = "dev-tools"))]` in release builds; the server gates via `GAME_DEBUG_AUTHORITY_COMMANDS=1` on both HTTP and socket paths. Debug grants are exempted from `consumeIngressBudget` when the flag is enabled so multi-item packs commit without `ingress_budget_exhausted` drops.

### Inventory radial menu & converse bust

- **Inventory radial menu unblocked**: `connected_scene::handle_pointer` was swallowing right-clicks over interactive windows at `covers()` before the inventory radial branch ran. Inventory card right-clicks now resolve above the window swallow, opening the object radial with `UNEQUIP`, `EXAMINE`, `DISCARD`, `SPLICE`. Relabelled `DROP` to `DISCARD` to match the authority's `DiscardStack` semantics.
- **Converse NPC bust camera**: `connected_scene` camera calculation for the converse window turned the camera to follow pawn yaw (looking at the NPC's back when turned away). Converse viewer camera now dead-ons the NPC's front (`yaw + PI`), looking the speaker in the eye. Trainer detection range widened from 2.5 to 16.0 cells with `in_range` gating preserved for skill purchases.
- **Viewer seat transparency**: `VIEWER_SEAT` alpha lowered from 245 to 28 so 3D composite cells blend with the pane's translucent background instead of punching an opaque black rectangle through see-through windows.
- **Item preview fill light**: Added secondary fill light (`PointLight { color: [0.72, 0.85, 0.96], intensity: 6.0 }`) to `ItemPreviewRenderer` in `item_preview.rs` so unlit sides of 3D item models in inventory wells remain legible.


## Wave 4 - functional panes, HUD defaults, chat, radar

### The thin panes were filled

`windows/live.rs` was 2063 lines holding 20 surfaces, so no two people could
edit a surface at once. It is now one file per surface under `windows/live/`
sharing `live/shared.rs` (the pane cursor, the prose writer, the retained text
fields). On that footing five surfaces went from a stub line to the content the
web client has always carried: `bank` had rendered only its out-of-range notice
even while in range, `converse` only `NO DIALOGUE TARGET`, `survey` four
resource rows under a 70% empty pane. `craft` and `splice` now run their full
staged flows.

`trade` mirrors the web `machine.ts` seal rules: any offer change clears both
seals, and the pane withdraws every mutating control the moment your side is
sealed, so a stale frame cannot emit a change the server has already sealed
against.

### What the parity pass got wrong, and what caught it

Worth knowing because the same failure will recur. A first pass produced 100
lines of client-side trade state machine that nothing called, with 17 assertions
proving it - a green suite over dead code. It is deleted; the trade tests now
drive the real pane. Two more classes of defect only a screenshot caught:

- 16 string literals used `-` and `·`. `hud::Icons` bakes ASCII 32..=126, so
  they rendered as `?` in-game while every test passed.
  `tools/hygiene/drawable_glyphs.py` is now a hard gate. Player-authored text is
  deliberately out of its scope.
- `survey` drew two-line `label_caption` rows into one-line `next()` rows, so
  each spawn's class line landed on the next spawn's name.

### HUD defaults

- The notification strip no longer opens on first run. It repeated the shard
  state and zone name into the bottom-right corner over the world; it stays
  registered and reachable.
- The target plate is flush top-right, mirroring the player plate's flush
  top-left, wherever the twelve-slot command bar still fits between them. Below
  that width it keeps its old lane under the bar rather than overlapping it. The
  bar's measured 474 px is never narrowed - that would resize every slot.
- The radar lane is the scope plus the coordinate rail the radar itself draws.
  It had been reserving a window caption and footer that a chromeless pane never
  paints: 52 px of dead band around the instrument.
- Hotkey glyphs under the command bar lost their dark seats. Twelve chips in a
  row read as a second broken bar under the real one.
- Body cap heights are 13/14/11 px against the original's 12/13/10. The original
  was measured on a 1024x768 CRT; the 19 px row absorbs the extra pixel without
  reflowing anything, and row height is deliberately NOT scaled with it.

### Window chrome

Frames carry a stepped corner bracket, traced from a generated reference sheet
into vector draw calls rather than shipped as art. Every corner now has exactly
one mark: bracket top-left and bottom-left, close control top-right, resize grip
bottom-right. The top bracket's ink follows the caption rail - dark caption ink
over the focused accent, edge tone over the unfocused rail - because one fixed
choice vanishes in the other state. The resize grip is three ticks and always
drawn; a grip you can only find by hovering is a grip players do not know exists.

### Nameplates

Two divergences from the web renderer, both fixed:

- The plate was pushed 8 px BELOW its head anchor and top-anchored, where the
  web lifts 24 px from a text baseline. It sat on the pawn's head. `y` is now
  the baseline, `NAMEPLATE_SCREEN_LIFT_PX` mirrors the web constant.
- Relation ink followed the theme, so a grouped ally was cyan in one palette and
  teal in another.

Relation colour is now owner-ruled (2026-08-04) and this ruling outranks the web
client, which does not match it everywhere yet:

| Read | Colour |
|---|---|
| NPC, and every corpse | white `#f8f7f1` |
| Passive attackable NPC | yellow `#f1d06b` |
| Passive that has been attacked | red |
| Aggressive attackable NPC | red `#d33b32` |
| Player, neutral | bright blue `#4aa9ff` |
| Player, same guild or faction | purple `#b066ff` |
| Player, PVP open | red |

`RelationHud` variants were renamed to those reads - `Hostile`, `Attackable`,
`Social`, `Player`, `Allied` - because `Friendly` meaning "neutral player, blue"
is a trap for the next reader. Classification is by actor `role` against the
shared `actorRoleProfiles` table, plus `will_auto_aggro`, `in_combat`,
`pvp_status`, and the viewer's own `player_organization_id`.

### Chat

All four tabs were driven against a live authority. Filtering is correct. Three
defects found and fixed:

- Every line was attributed to `char_0254efc180a54b6a`. The chat route defaulted
  `displayName` to the user id before the hub saw it, so the hub's own lookups
  never ran. The route now passes an empty fallback and the hub resolves the
  name from the live shard, then the character store, then the raw id.
  `ChatNameAuthority` is wired from `gameShard.chatDisplayNameForActor`.
- A `chat.error` marked the whole socket `Degraded`. It is a refusal of ONE
  request - no guild, rate limited, moderated - and the socket is fine. It now
  surfaces as a system line, which is also the only way the player learns the
  message they typed went nowhere.
- An empty tab reported `CHAT DEGRADED`. An empty tab is a filter result; it now
  names what is empty and reports the socket only when the socket is unwell.

Global history survived a client restart, so channel persistence is confirmed.

### Radar

The scope was a flat disc with a crosshair and three unlabelled rings. It now
draws a terrain preview sampled from `world::terrain::sample_terrain` - the same
function the 3D terrain path uses - on a 32x32 grid cached until the player
crosses a cell, the zoom step changes, or the palette changes. Plus a world-cell
grid that slides as you move, and range rings labelled in metres at every step
of the existing 32/64/96/128/192 ladder.

### Known open from this wave

- `pnpm --dir client-3d build` fails on a pre-existing asset budget:
  295,462,367 bytes against a 292,000,000 limit, 504 of 510 files. No
  `client-3d` file was touched in this wave. Raising the limit would hide it.
- The Rust client still sends no `displayName` in its chat handshake. The server
  resolves it, so this is redundancy rather than a defect.
- Functional panes report their own NEEDS-PROJECTION gaps: survey concentration
  interpolation and scan-disc history, datapad terrain bake and weather storms,
  macro runtime state, trade item preview.
- The local authority's state-lock supervisor loses a restart race often enough
  to notice; clearing `server/.local-state/*.pid` and starting fresh works.

## Wave 1 — doorways, floors, viewers, character art

### Character viewers

Every open 3D viewer renders at once over one shared pawn instead of the
topmost one stealing the surface. Composites are banded by the owning window's
draw rank and flushed into the UI stream between windows, which is the
original's `flushRenderQueue()` then `renderScene()` ordering.

### Input and interaction

- A press inside a panel also reached the world. `pointer_captured` only
  latches while the windows run, which is after the host has routed the press.
  `WindowManager::covers` answers the same hit test at any time.
- A released movement key could leave the actor walking. A stop now
  re-announces across the authority's one-second intent expiry.
- Changing clothes threw the arms up. `CarriedMotion` carries animator, gait,
  interpolation and predictor across the pawn rebuild.

### Collision

A door module ships as one solid wall box with the opening flattened into it.
`transformStructureCollision` now surfaces the door-tagged panels as apertures
and the fixture carves them out, leaving jambs solid. Actors also stood at
terrain height indoors; `PropsLoader::floor_height_at` ports the web client's
`enterableFloorYAt`.

Two things that looked like bugs and are not: stopping ~0.8 cells from a wall
is correct (the streamed position is an anchor and the collision circle sits at
`ground_center_from_anchor`), and a weapon riding on the back while idle is the
intended stow pose.

### Character art

Skull rebuilt as a dome of circular cross-sections on both bodies, patched into
head-weighted vertex positions only, so all 99 wearables stay bound. A full lab
rebuild moved stature 8 mm and tore every wearable off the character; do not
regenerate the bodies to change the head.

## Next safe actions

1. Fetch the branch and run `git lfs pull` before inspecting visuals or running
   asset-dependent tests.
2. Recheck `dev/rust-client`; the co-developer may have advanced it.
3. Bring up the stack with `node scripts/server-local-persistent.mjs`, then
   drive `client-rust/out/bin/successor-dev` from `client-rust/` per
   `TOOLS_AVAILABLE.md`.
4. Run `python3 tools/observe/collision_map.py` first when touching collision.
5. Run focused checks while iterating, then the repository gates in
   `VERIFICATION.md`.
6. Treat a merge to `main`, pointer promotion, authority restart, or public
   deployment as a separate explicitly authorized operation.
