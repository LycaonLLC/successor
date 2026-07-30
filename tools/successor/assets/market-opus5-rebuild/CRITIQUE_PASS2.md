# Inspection pass 2 — blunt self-critique (scheme E, first full build)

Evidence: `proofs/pass2/` (27 views, 760 px / 26 samples), measured with numpy
where a claim was testable. This critique includes the failures the **human
review gate** found in pass 1, not only the ones I noticed myself.

## Verdict

The architecture is now real: the plan-stepped south face, the single vaulted
hood, the butterfly fold with a working clerestory, the docked terminals and the
staff aisle all read. Four pass-1 contract failures are fixed and verified
(coordinates, door proofs, cutaway, export warnings). But **the surface the
gameplay camera actually sees — the roof — is still the weakest thing in the
asset**, and the building has no value identity against its ground.

## Carried-over failures from the human review gate, and their status

| review finding | status | evidence |
|---|---|---|
| fixture cells were shifted one cell (`c-0.5` bug) | **fixed** | `plan.py::assert_contract` asserts all four centres in both spaces; build prints them |
| door proofs pixel-identical (RMSE 0) | **fixed** | rig mutes NLA before transforming; measured RMSE 78.3, 80.1 % pixels changed |
| roof-off cutaway kept ceilings | **fixed** | all ceilings are `roof__ceil_*`; `08_interior_roofoff` shows the full plan |
| export warnings (tangents, COLOR_0, samplers) | **fixed for authored geometry** | lod0/1/2 export with **0** warnings; the 19 remaining sampler warnings come only from the read-only terminal GLBs' own materials |
| trainer-bay proof occluded | **fixed** | `22_interior_eye_trainer` shows desk, board, sconce, seat |
| entrance crop did not prove the mechanism | **partly fixed** | `25_crop_door_mechanism` shows track/rollers, but `10`/`11`/`12` were framed inside the hood throat and read as flat panel, not as an entrance |
| stale texture sheet | **pending** | must be regenerated from the final files at the end |

## New defects found in pass 2

**E1 — The roof is a striped field. (severe; this is the primary camera)**
`05_top`, `07_gameplay_ortho`. Measured: the across-roof column profile has
sd 0.0368 with a dominant 113-cycle component over 547 px. A plain field is
~0.010. This is the pass-1 barcode defect at a finer pitch — repetition still
reads as a stamp because the seams are the *only* thing on the plane.
Fix: this is not a texture problem, it is a missing subsystem. The south plane
needs real roof architecture — expressed structural bays at the interior purlin
lines, a tilted collector field, a walkway, and seams demoted to infill between
bays.

**E2 — Rooftop plant is a single east-west row. (severe; primary camera)**
Measured: bright plant pixels have y-centroid sd 36.7 px over a 200 px band
(< 0.22 of the band) — objectively one row. It reads as objects on a shelf, the
exact criticism the human review made of pass 1's roof.
Fix: stagger every item in y, and give each a reason to be where it is.

**E3 — No silhouette against the ground. (severe; gameplay distance)**
Measured on `07_gameplay_ortho`: building mean luma 0.471, ground 0.441 —
separation 0.030. The asset nearly disappears into the desert at gameplay
distance. Ceramic basecolor is 0.746 luma, far too pale and too cool for a
desert settlement.
Fix: warm and darken the ceramic and roof metal so the mass sits at a different
value from the sand, and let the plinth carry the dark end.

**E4 — The butterfly fold is not legible from the game camera.**
At 52° pitch the north plane compresses to a thin strip; the fold, the valley
and the clerestory are hidden behind the south plane's ridge. The building's
whole parti is invisible in the view that matters most.
Fix: deepen the clerestory zone and widen the valley so the fold reads as a dark
slot across the plan, and pull the collector field back from it so the slot is
not crowded.

**E5 — The north service wall is under-composed.**
`17_rear_service`, `26_crop_rear_service_door`. One louvre band and one door on
a 11.4 m wall. The measured sd is high (0.157) only because the crop contains
the dark opening; the *wall* itself has no order.
Fix: a real service composition — loading canopy, plinth-height kerb, a shelf
line, staggered vents tied to what is behind them.

**E6 — Trainer bay walls are blank.**
`22_interior_eye_trainer` — good furniture, but the bay's own west and south
walls are flat plaster with nothing on them.

**E7 — Entry/door proof cameras sit inside the hood throat.**
`10`, `11`, `12` fill the frame with the leaf and jamb. The states are
provably distinct (RMSE 78.3), but the images do not read as *an entrance*.
Fix: pull back and widen so the hood order, the leaf and the approach are in
one frame.

**E8 — The loggia deck is a plain slab underneath.**
`20_crop_loggia` — the joists are there but the soffit between them is flat.

## Correction plan (executed before the final set)

1. Rebuild the roof as a system: expressed bays on the purlin lines, a tilted
   collector field of unequal panels, walkway, and demoted seams. (E1, E4)
2. Stagger all rooftop plant in y with cause. (E2)
3. Re-pitch the palette: warm/darken ceramic and roof metal, keep the plinth
   dark, so the mass separates from sand. (E3)
4. Author the north service elevation: canopy, kerb, shelf, staggered vents. (E5)
5. Trainer bay wall built-ins. (E6)
6. Reframe the entry/door proof cameras. (E7)
7. Coffer the loggia soffit between joists. (E8)
