# Successor game work handoff — 2026-08-04

Status: development-source handoff. This note does not override
`CANONICAL_CONTEXT.md`, `CURRENT_PROJECT_STATE.md`, `CURRENT_DEPLOYMENT.md`, or
`VERIFICATION.md`.

## Resume point

- Working branch: `integration/rust-ui-runtime-20260803`
- Tip at handoff: `a485288b`
- Co-developer branch: `dev/rust-client`, fully merged in, nothing outstanding
  in either direction at handoff
- Not merged to `main`. Not deployed. No public-journey claim.

The co-developer's `collision debug` overlay (`b4553b53`) is merged and built
on. Toggle it in the connected client with **Shift+C**.

## What changed

### Character viewers

Every open 3D viewer now renders at once over one shared pawn instead of the
topmost one stealing the surface. Composites are banded by the owning window's
draw rank and flushed into the UI stream between windows, which is the
original's `flushRenderQueue()` then `renderScene()` ordering. World view and
all dolls stay in lockstep because they are the same instance behind a
per-viewport mask, not clones.

### Input and interaction

Three defects, each with a mechanism worth remembering:

- A press inside a panel also reached the world. `pointer_captured` only
  latches while the windows run, which is after the host has routed the press,
  so it read false on the press itself. Every inventory click walked a move
  intent out from under the open window and cleared the selection, which made
  the equip and unequip buttons unusable by mouse. `WindowManager::covers`
  answers the same hit test at any time.
- A released movement key could leave the actor walking. Movement re-announces
  itself every six frames while held; a stop was a single edge, and the
  authority both rate-limits ingress and holds an intent for one second past
  its last accepted update. One refused command stranded the actor. A stop now
  re-announces across that expiry window.
- Changing clothes threw the arms up. A worn change destroys and respawns the
  pawn, and the respawn built a fresh animator at its bind pose. `CarriedMotion`
  carries animator, gait, interpolation and predictor across the rebuild.

### Collision

Doorways in the modular buildings were sealed. A door module ships as one solid
wall box with the opening flattened into it; the fine `boxes` array still tags
each panel `structure` or `door`, but the merged `walls` array drops that tag,
so the aperture was paved over by its own module and the leaf's open state
changed nothing. `transformStructureCollision` now surfaces the door-tagged
panels as apertures and the fixture carves them out, leaving jambs solid.

Actors also stood at terrain height indoors, sunk into their own floor slab.
The web client has always resolved this in `enterableFloorYAt`: find the
interior containing the point and take its floor. Ported as
`PropsLoader::floor_height_at`.

Two things that looked like bugs and are not, recorded so they are not chased
again:

- Stopping ~0.8 cells from a wall is correct. The streamed position is an
  anchor and the collision circle sits at `ground_center_from_anchor`, half a
  cell along both axes, with a 300 milli radius.
- A weapon riding on the back while idle is the intended stow pose.

### Character art

- Skull rebuilt as a dome of circular cross-sections on both bodies. Crown
  width over depth goes 0.57 to 1.05 male and 0.56 to 1.03 female; crown width
  42 to 66 percent of maximum. Patched into head-weighted vertex positions
  only, so vertex counts, joint transforms, inverse bind matrices, weights,
  UVs, materials and stature are untouched and all 99 wearables stay bound. A
  full lab rebuild moved stature 8 mm and tore every wearable off the
  character; do not regenerate the bodies to change the head.
- Female armour seated. Every piece was fitted to the male frame and copied,
  standing up to 18 mm clear of her with a contact fraction of zero. Now within
  0.4 mm of where the male set sits.

## Tools added

All three exist because single-point probing was the bottleneck.

- `tools/observe/pawn_observatory.py` — collects the character from every
  surface that draws it, at several angles, and finds the subject by motion
  rather than a hardcoded rect.
- `tools/observe/collision_map.py` — reproduces the authority's collision rule
  offline and floods from outside to report what fraction of each building
  interior a player can actually reach, door open and shut. This is the tool
  that turned "doors feel wrong" into a number.
- Debug orbit camera in the connected client: **Shift+V** frees it, arrows
  orbit, shift+arrow dollies. It opens on the shipped view, so nothing changes
  until it is moved.

The wearable fit gate now also detects the defect it was blind to. It only
measured cap-to-body, so a hair cap resting perfectly on skin while the skull
erupted between its vertices passed. `scalp_exposure` probes skull outward and
reports bare points whose neighbours are covered.

## Known open

- **Doorways are better, not fixed.** Interior reachability went 7/7/5 percent
  to 19/44/32 for starter/court/wing. The remaining seal is most likely the
  300 milli collision radius closing gaps under 0.6 cells against a 0.95 m wall
  pitch. Measure with `collision_map.py` before carving further; the answer may
  be a smaller radius rather than more geometry.
- **Floor sinking is not proven fixed.** The `enterableFloorYAt` port is
  correct and was genuinely missing, but `floorHeightM` is 0.021 m for the
  cloning facility and cannot explain waist-deep sinking. Something else is
  also wrong.
- **Head shape wants a human eye.** It is rounder, not bigger; maximum width is
  unchanged at 0.144 m.
- **Hair refits are parked** behind head sign-off. The gate now fails all 62
  hair variants; refitting them against a skull that may still move is wasted
  work.
- **Doll render targets alias.** A 384x640 target composited into a ~76 px
  column with no mipmaps breaks up at three-quarter angles. Sizing the target
  to its destination needs mip support on render targets across three GPU
  backends.
- **`wpn_carbine_kiln` mount is copy-pasted** from the slagrail. Its foregrip
  at z=0.07 sits in a hole in its own geometry; the real handguard is near
  z=-0.06. Re-posing affects both `wpn_carbine` and `wpn_sniper`, so it is a
  feel call.
- **No live combat exchange yet.** The weapon wields and the authority accepts
  input, but no hostile was found in the ground covered. Spawn one deliberately
  rather than hunting.

## Next safe actions

1. Fetch the branch and run `git lfs pull` before inspecting visuals or running
   asset-dependent tests.
2. Recheck `dev/rust-client`; the co-developer may have advanced it.
3. Run `python3 tools/observe/collision_map.py` first when touching collision.
   It is faster and more honest than walking into a wall.
4. Run focused checks while iterating, then the repository gates in
   `VERIFICATION.md`.
5. Treat a merge to `main`, pointer promotion, authority restart, or public
   deployment as a separate explicitly authorized operation.
