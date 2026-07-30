# Inspection pass 1 — blunt self-critique

Evidence: `proofs/blockout/` (massing) and `proofs/pass1/` (full build, 20 views).
Verified by measurement where a hypothesis was testable, not by eye alone.

## Verdict

The massing, facade hierarchy and entry sequence hold up: the four-volume step
(3.62 / 4.02 / 4.72 / 5.85), the carved loggia and the continuous datum line all
read from the gameplay camera. The *execution* is below production quality in
eleven specific ways, and two of them are outright contract failures.

## Defects

**D1 — Roof seams read as a barcode. (severe; primary camera)**
In `05_top` and `07_gameplay_ortho` the standing seams dominate the whole asset
as hard black stripes. Cause: 0.07 m tall seams at 0.60 m spacing under a low
sun throw full-height shadows, and the roof deck albedo is too low underneath.
This is precisely the "repetition reading as a stamp" failure the brief rejects.
Fix: seam profile to 0.028 x 0.038 m at 0.42 m, lighten the deck, and give the
roof real hierarchy — ridge cap, walkway pad, crickets, drains, equipment curbs.

**D2 — The roof-off cutaway does not reveal the interior. (contract failure)**
`08_interior_roofoff` still shows a closed lid. Cause: I put the ceiling planes
under `interior__`, which the cutaway keeps permanently visible. Ceilings are
part of what a roof cutaway must remove.
Fix: move all `interior__ceil_*` to `roof__ceil_*`; beams stay `interior__`.

**D3 — Everything is ~40% too dark. (severe, global)**
Measured: COLOR_0 mean 0.601 across all shells (interior 0.601, walls 0.612,
floor 0.513). Pale bone ceramic renders as grey-blue slab in `09_interior_eye`
and `15_crop_service_counter`. Cause: `0.42 + 0.58*ao` with a 1.15 m AO ray in a
small interior means nearly every surface sees neighbouring geometry and is
treated as occluded. AO stopped being contact shading and became a global dimmer.
Fix: `0.70 + 0.30*ao`, AO ray distance 0.55 m, so occlusion darkens creases only.

**D4 — Terminal alcoves punch through to daylight. (functional + visual)**
`15_crop_service_counter` shows bright back-of-house behind each terminal, so a
service point reads as a hole in a wall.
Fix: authored backing panel per bay — roll shutter, transaction slot, service
light — closing the bay while keeping the staff aisle behind it real.

**D5 — Interior is unlit in practice.**
Emissive fixtures exist but contribute almost nothing; the interior is lit only
by clerestory spill, so the floor is nearly black.
Fix: raise fixture emission, add real Cycles area lights to the *render rig*
only (never exported), so interior proofs show authored lighting honestly.

**D6 — UV stretch banding on sloped faces.**
Measured worst UV length ratio 2.000 on the west wall. Cause: box projection
takes the dominant-normal axis and ignores foreshortening, so battered and
bevelled faces compress by cos(theta) and stripe.
Fix: divide the projected UV by the axis cosine so texel density stays constant.

**D7 — Loggia interior is a black void.** No bounce, no authored fill; the entry
sequence disappears exactly where the player enters. Fix with D5 plus a brighter
soffit and a working cove.

**D8 — Monitor roof is a blank slab.** The largest unbroken plane in the top-down
view has no seams, no fall, no fixings. Fix: seam it, add a ridge flashing and
end closures.

**D9 — North louver band is a row of identical white boxes.** Repetition without
hierarchy. Fix: vary bay widths, recess the frames, add a lintel and sill line.

**D10 — Trainer bay is invisible from the gameplay camera.** Its roof is a plain
plane; the program has exterior identity in elevation but not in plan.
Fix: authored roof-top expression (hood, vent, sun scoop) over the bay.

**D11 — Three proof cameras miss their subject.** `12_crop_entrance_door` frames
a terminal instead of the door; `08` and `15` are badly placed. Proof cameras
must show the thing they claim to prove. Fix the rig.

## What I will not change

The four-volume massing, the sinter/ceramic tectonic split, the datum line, the
loggia depth, the plan zoning and the door mechanism are working. The fixes
below are surgical, not a redesign.
