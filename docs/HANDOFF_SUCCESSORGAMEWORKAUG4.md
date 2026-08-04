# Successor game work handoff — 2026-08-04

Status: development-source handoff. This note does not override
`CANONICAL_CONTEXT.md`, `CURRENT_PROJECT_STATE.md`, `CURRENT_DEPLOYMENT.md`, or
`VERIFICATION.md`.

## Resume point

- Working branch: `integration/rust-ui-runtime-20260803`
- Co-developer branch: `dev/rust-client`, fully merged in, nothing outstanding
  in either direction at handoff
- Not merged to `main`. Not deployed. No public-journey claim.

Two waves are recorded here. The first (doorways, floors, viewers, character
art) is unchanged from the earlier note and kept below. The second is a UI
parity pass over the native Rust client.

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
