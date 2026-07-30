# Valley Market — build report

A new market building for Successor, authored from first principles in this
directory. Blind experiment: no existing market/commerce asset, generator,
texture, manifest or redesign brief was opened, searched or derived from.

- **Generator (source of truth):** `src/build_market.py` (deterministic Blender Python)
- **Design record:** `DESIGN.md`, `ALTERNATIVES.md` (5 schemes compared), `CRITIQUE_PASS1.md`, `HUMAN_REVIEW_PASS1.md`, `CRITIQUE_PASS2.md`, `HUMAN_REVIEW_PASS3.md`
- **Deliverables:** `build/market_house_lod{0,1,2}.glb`, `build/market_house_furnished.glb`, `build/market_house.collision.json`, `build/market_house.manifest.json`, `build/prop_footprints.json`, `build/market_house_full.blend`, `build/checkpoints/market_house_checkpoint_01_full_lod0.blend`
- **Evidence:** `proofs/final/` (37 views + texture contact sheet), `proofs/pass3diag/` (pass-3 diagnostic pass), `proofs/pass2/`, `proofs/alts/`, `logs/`, `build/diag/`

> **Status.** `python3 src/verify.py` passes **141/141** automated assertions.
> That is a statement about the automated checks, not a claim of acceptance.
> Pass 2 also passed every check it had (76/76) and was still rejected, because
> the checks did not test the things that were broken. §7 lists what is now
> tested and §11 lists what remains a judgement call for a human reviewer.

---

## 1. What the building is

**Scheme E — "Valley Market".** An asymmetric butterfly roof folds about a
valley gutter that sits **directly over the interior service wall**, so the fold
has a real load path rather than being a shape. The north plane is lifted
0.55 m above the valley, making a south-facing clerestory that washes the
service wall and staff aisle with light; its brise-soleil blades are the only
repeated element on the building and they exist to shade that glass.

Water is the parti: **valley → east sump → downpipe → cistern drum → rear
plant**, with an overflow that stains the north wall in exactly one place.

Exactly **one curve** exists: the vaulted entry hood. It breaks the south eave
(apex 4.60 m vs eave 4.42 m), so the entrance is the tallest event on the public
face both in elevation and in the pitched top-down game view. The south facade
is plan-stepped three times at three different setbacks — loggia (y −3.98),
trainer bay (−4.06), hood (−4.16) — so no two bays repeat.

Skyline: four different shapes at four different heights — square windcatcher
6.60, cistern drum 6.18, round flue 5.79, arched hood 4.60.

Interior: one tall public hall under a raked soffit, a low service zone behind,
three terminals docked in niches under **three different projecting heads**, a
back-of-house staff corridor with a proven 1.00 m clear route, a vendor display
line west, a customer waiting nook east, and a trainer consultation booth in the
deepened south-east bay.

## 2. Authority contract

| requirement | value | proof |
|---|---|---|
| footprint | authored 11.370 × 8.505 m inside the 11.40 × 8.55 limit | `assert_footprint` + `report_offenders` every build; loader proof re-measures from the GLB |
| floor top | Y = 0.02 m | `plan.py::FLOOR_TOP` |
| front | +Z public | hood, loggia, trainer bay and door all on +Z |
| bank (3,3) | glTF x −2.375, z −0.950 | `plan.py::assert_contract`, printed each build |
| trade (6,3) | glTF x +0.475, z −0.950 | idem |
| association (9,3) | glTF x +3.325, z −0.950 | idem |
| trainer (10,6) | glTF x +4.275, z +1.900 | idem |
| door node | `door_slide`, scene-root child | Three.js proof asserts no cutaway-prefixed ancestor |
| door travel | local **X**, closed 0.0, open **−2.60 m** | measured in Three.js; leaf mesh moves 2.6000 m in world space |
| clips | `door_open`, `door_close`, **0.800 s**, 30 fps | measured from the GLB, not from Blender names |
| cutaway prefixes | `roof__ wall_front__ wall_back__ wall_left__ wall_right__` | all present as top-level nodes |
| permanent | `floor__ interior__` | idem |
| collision | `successor.structure-collision.v3`, **53** authored boxes | `build/market_house.collision.json` |
| clearance | **23/23 checks clear** | 4 fixture cells, 4 approaches, 3 terminal front-clearances, rear-door approach + walk-through, BOH route band, 3 BOH service-side reaches, 2 trainer seats, trainer standing approach, trainer sightline, door swept volume, door walk-through |

Cell helper unchanged: `x = -5.700 + (c+0.5)*0.950`, `z = -4.275 + (r+0.5)*0.950`,
with `plan_y = 4.275 - (r+0.5)*0.950` asserted to agree independently.

## 3. Numbers

| | tris | budget | materials | GLB |
|---|---|---|---|---|
| LOD0 | 40,524 | 90,000 | 11 | 7.03 MB |
| LOD1 | 34,528 | 45,000 | 11 | 5.12 MB |
| LOD2 | 3,348 | 20,000 | 10 | 0.54 MB |
| furnished (LOD0 + 7 props) | 58,864 | — | 41 | 9.52 MB |

LOD0 grew from 24,572 to 40,524 triangles in this pass. The increase is
accounted for: closing ten envelope openings with real assemblies, six authored
corner joints, the hood at 48 radial segments with split normals, per-service
dock heads and hardware, the rebuilt BOH and trainer booth, and the vendor
assortment. It remains at 45 % of budget.

Textures: **21 images / 3.19 MB on disk** — 7 PBR sets at 512² basecolor,
512² normal, 256² packed ORM.

## 4. Materials, UVs, wear

Seven PBR materials (sinter, ceramic, plaster, screed, roof metal, steel, brass)
plus four untextured slots (glass, seal, warm lamp, cyan lamp).

**Per-material scale and response (rebuilt this pass).** Every material used to
sit on the same 2.0 m tile with roughly the same micro amplitude, which is why
the review found "uniform procedural grain… sponge-like noise repeated across
screed/sinter surfaces" and brass reading "like noisy wood". Now each material
is projected at the physical scale of the thing it describes, and the tile
generator enforces a *band* — floor **and ceiling** — on high-frequency energy,
so a material can no longer be safe by being maximally grainy:

| material | tile | micro rms band | roughness |
|---|---|---|---|
| sinter | 1.30 m | 0.026–0.044 | 0.82 |
| ceramic | 2.40 m | 0.008–0.014 | 0.55 |
| plaster | 1.70 m | 0.007–0.012 | 0.91 |
| screed | 2.10 m | 0.013–0.022 | 0.32 |
| roof metal | 1.50 m | 0.014–0.025 | 0.69 |
| steel | 0.55 m | 0.013–0.023 | 0.49 |
| brass | 0.30 m | 0.007–0.012 | 0.23 |

Measured result: 7 distinct tile scales, roughness spanning **0.23–0.91**, and a
**3.10×** ratio between the coarsest and quietest micro energy. `build_market.py`
reads these scales from `textures.json` rather than restating them, so the scale
a tile was designed for and the scale it is projected at cannot drift apart.

Brass specifically: the tonal swing was halved, the directional blur reduced
from a 7 px streak to 2 px on a 0.30 m tile, and its identity moved into the
*response* — it is the glossiest material in the palette at roughness 0.23, so
it catches the lamps and reads as metal rather than grain.

Sinter's albedo floor was raised from 0.036 to 0.074 linear. The old value was
darker than any real basalt, and in raking light the plinth collapsed to 0.6 %
grey and read as missing geometry even where ray casts prove it solid.

**UVs.** `uv_project` builds each face's UV frame from its own normal, so texel
density stays constant on battered, raked and bevelled faces. LOD0 also carries
a second, non-overlapping smart-projected `UVBake` layer in the editable
`.blend`; it is deliberately not exported.

**Wear is causal.** Tiles carry micro-detail only (`assert_micro_only`, plus the
new `assert_micro_band`). Architectural-scale variation lives in COLOR_0:
per-part tonal drift, short-ray contact AO, 26 named grime sources where hands
and goods actually go, water streaks only under things that shed water, and
wind-blown dust on up-facing surfaces low down.

## 5. What the pass-3 review rejected, and what was actually wrong

Each item below states the defect, the **root cause found by measurement**, the
source change, and the evidence. Nothing here was fixed by moving a camera.

### 1. All three terminals faced backward *(hard functional)*

**Cause.** The placement code reasoned from the terminal manifests' prose
("front is +Z") to a 180° yaw. That was exactly wrong. Measured instead
(`build/diag/diag_terminal_face.py`, `diag_terminal_normal.py`):
`import_scene.gltf` **bakes** the Y-up→Z-up conversion into the mesh — every
imported root arrives at rotation (0,0,0) — and glTF **+Z lands on Blender −Y**.
Confirmed on the lit surfaces themselves; the largest polygon of each screen
material points along −Y:

```
CM_ScreenBank  n = (0.000, -0.978,  0.208)
CM_ScreenTrade n = (0.000, -0.960,  0.280)
CM_ScreenPA    n = (0.000, -1.000,  0.000)
```

Blender −Y is the public front. The correct yaw is therefore **0°**, and the
dock y-position is derived from each prop's *measured* back half-depth.

**Guard.** `src/term_face_proof.mjs` re-measures this from the **shipped
furnished GLB**, in glTF space, from the screen geometry — not from placement
numbers and not from prose. All three now report a screen normal of +Z.

**Evidence.** `28_term_bank_face`, `29_term_trade_face`, `30_term_assoc_face`,
`09_interior_eye_hall`, `15_crop_service_counter`.

### 2. Rear service entrance and BOH circulation obstructed *(hard functional)*

**Cause.** The authored tank stood at (2.30, 3.16) r 0.44 — inside the rear
doorway's approach, 0.22 m from the niche backs. The bench (0.62 m) and shelving
(0.48 m) each ran across the full aisle as well. There was no route at all.

**Change.** The BOH was rebuilt as an explicit corridor. A reserved band
(`BOH_ROUTE_Y0/Y1`) runs the length of it; bulky plant may only occupy the four
**pier alcoves** — the x-bands where the service wall has no niche pocket and
there is 0.39 m of extra depth. The tank is gone: its stored-water role was
already carried by the roof cistern drum, which is the building's actual water
parti, and it is replaced by two slim filter columns in an alcove that **no
opening looks through**. Bench and shelving moved into alcoves; switchgear
turned onto the east wall; ladder stringers flattened against the rear wall.
The niche pocket back moved from 2.50 to 2.32 with a thinner slab, widening the
aisle. The route is declared in the floor with a brass inlay.

**Guard.** `verify.py` §13 builds a 0.02 m occupancy grid from the collision
proxies **in the body-height band (0.12–1.85 m)**, computes an exact Euclidean
distance transform, and runs a max-min bottleneck search from outside the rear
doorway to a stance behind each fixture. Measured minimum widths:

```
rear door -> rear of bank   1.000 m
rear door -> rear of trade  1.120 m
rear door -> rear of assoc  1.120 m
rear doorway threshold      1.120 m     (requirement: 0.90 m)
```

**Evidence.** `26_crop_rear_service_door`, `31_boh_route_from_rear_door`,
`32_boh_route_along_aisle`, `23_interior_eye_backofhouse`.

### 3. Trainer consultation spot cramped and blocked *(hard functional)*

**Cause.** A 1.70 × 0.42 m desk against a 0.60 m deep bay, with a full-height
shelf stack and a display case standing in the sightline.

**Change.** The bay is deepened from −3.72 to −4.06 (0.94 m clear, the three
south setbacks still unequal). The desk becomes a consultation **table** at the
bay mouth; the trainer sits behind it, the visitor is drawn up to its north
side; the tall built-ins are demoted to a waist-height credenza in the bay's
dead south-west corner. A booth downlight and a wall-washed route board were
added.

**Guard.** Four new clearance checks — both seated volumes, the standing
approach, and a **sightline** check at eye height (1.00–1.70 m) between the
customer and the table.

**Evidence.** `22_interior_eye_trainer`, `33_trainer_booth`.

### 4. Collision verification omitted these failure modes

`verify.py` grew from 76 to **141** assertions, in six new sections: terminal
orientation measured from the shipped GLB (§11), loose-prop footprints vs.
authored collision (§12), the sampled BOH path/width search (§13), trainer booth
and rear-door clearances (§14), envelope closure by ray cast (§15), proof-set
staleness (§16), and material scale/response (§17).

Two of these caught real defects on their first run, which is the point:
§12 found the crate intersecting the vendor counter by 24 mm and the footlocker
inside the service wall; §13 initially reported 0.160 m because the route did
not exist yet.

### 5. Open black corner voids *(hard visual)*

**Two causes, and the larger one was not the corners.**

*Corners:* `shell_wall` insets the ceramic skin 0.07 m behind each wall's outer
plane. Where two walls meet, each skin ran to the other's outer plane, leaving
an open 0.07 × 0.07 m vertical shaft from the datum band to the gable — 0.82 m
tall on the flanks. Six authored corner joints now close them, with a sinter
backing block, a folded brass closure angle lapping both skins, head flashing, a
projecting sill and a weep so the joint drains onto the datum band.

*Openings:* **five wall openings had no glazing at all.** The south daylight
slot, both west high slots, both BOH windows and the trainer bay window were
literal holes; only the vendor shopfront was ever filled. Every opening now
receives a complete assembly — external surround, set-back glazing frame with
rebate, glass, mullions where the span needs one, a projecting throated sill,
and an internal liner. The three rear vents get blade louvres over a dark
backing plate with mesh.

**Guard.** `build/diag/diag_openings.py` fires 25 rays through each opening and
`diag_seal.py` fires 41 per corner along the bisector. All **10 openings closed,
all 6 corners sealed** (first hit at exactly 2.8284 m = the corner plane). The
probe demonstrably discriminates: run against a stale `.blend` it reported 6 of
10 open.

**Evidence.** `03_left`, `04_right`, `16_crop_uv_seam_corner`,
`34_crop_corner_sealed`, `35_crop_corner_sealed_ne`, `17_rear_service`.

### 6. Under-resolved focal arch *(hard visual)*

**Cause.** 20 segments over a half turn is a 9° facet (0.30 m chord at r=1.90),
**and** every face was flat-shaded, so each facet read as its own tone.

**Change.** 48 segments (3.75° / 0.124 m) plus a new `mlib.smooth()` that marks
faces smooth and only genuinely creased edges sharp. Verified that the split
normals survive triangulation and joining (caps stay flat at (0,0,−1) while the
barrel interpolates). The review's named list is now built: rebated fanlight
frame and stop, an arch lining through the wall thickness with a brass
penetration ring, a throated drip at the springing discharging into a downpipe
run down each pier to a shoe and spill block, impost blocks where the curve
lands, and a flashed saddle where the apex breaks the eave.

While fixing the fanlight bars I found a **latent bug in the same family**:
`mlib` bakes world coordinates into mesh data and leaves objects at identity, so
`rotation_euler` rotated parts about the **world origin**. The fanlight bars had
been silently collapsing to one vertical bar since pass 1, and the new louvre
blades flew up to 0.68 m outside the footprint. `rot_about()` now transforms
mesh data about the part's own pivot.

**Evidence.** `13_crop_facade_hood`, `36_crop_hood_smooth`, `12_crop_entrance_door`.

### 7. Uniform procedural grain *(hard visual)*

Rebuilt as described in §4. Measured: 7 distinct tile scales, roughness spread
0.68, micro-energy ratio 3.10×, all 7 materials inside their own band.

**Evidence.** `14_crop_floor_wall_contact` (coarse sinter against polished
screed at the same contact), `16`, `20`, `texture_contact_sheet`.

### 8. Sparse, generic interior *(hard visual)*

Each service point now projects a **different head** at a different depth —
bank 1.50 (deepest: a hooded private transaction recess with side privacy fins,
a screened deposit drawer and a ledger ledge), trade 1.58 (an open inspection
gantry with a hanging scale, weight shelf and a lit inspection strip), assoc
1.66 (a shallow public registry brow with a notice frame, waiting bench and a
low cyan beacon). All hardware sits on the piers, never in the customer
approach — re-proven every build. The wash lamp moved from behind the terminal
face to in front of it, so the fixture the player interacts with is lit.

The vendor line was stocked with an authored assortment (heaped roots, stacked
discs, sacks, jars with brass lids, hung goods, a delivery pallet) — the runtime
library has no provenance-backed produce props. The dead east hall wall became a
customer waiting nook with a bench, card shelf, lit sign band and floor
wayfinding studs.

**Evidence.** `09_interior_eye_hall`, `21_interior_eye_vendor`, `15`, `28`–`30`.

### 9. Under-composed side and rear elevations *(hard visual)*

The glazed openings, louvred vents, corner joints and hood downpipes above are
most of this. Functional water/plant logic is preserved.

**Evidence.** `03_left`, `04_right`, `17_rear_service`, `18_roof_plant_deck`.

### 10. Proof views that did not prove their subject *(hard visual)*

Rather than guess again, `build/diag/diag_sweep.py` **chooses cameras by
measurement**: it defines a geometric predicate for each subject, sweeps
candidate stations (filtered to those outside every authored collision proxy),
ray-casts a grid through each frame, and scores by how much of the frame lands
on the subject — penalising sky and rewarding a standoff far enough back to give
context. This found:

- the **clerestory cannot be seen from eye level in the BOH at all**: the glazing
  is at y 1.85, z 3.60–4.09 and the service wall rises to 3.35 immediately north
  of it. `24` is now a raised inspection station (42.6 % subject fill) and a new
  `37_crop_clerestory_glazing` shows the band, brise and valley from outside.
- the **loggia is 0.86 m deep and 3.05 m tall** — you cannot stand back from a
  soffit you are underneath. `20` looks west along the arcade instead.

The loggia crop also exposed a **real asset bug**: the coffered soffit had one
lamp 1.3 m from either coffer, so the pans were lit by sky bounce alone. Coffer
downlights were authored — and the first attempt buried the emissive face
*inside* the plaster pan (lamp z 2.837–2.853 within a pan of 2.825–2.965), so it
emitted into the inside of its own housing. Fixed by placing the luminaire below
the pan soffit.

**Evidence.** `20_crop_loggia`, `24_interior_clerestory`,
`27_crop_clerestory_brise`, `37_crop_clerestory_glazing`, `26`, `31`, `33`.

## 6. Naming and invariants

- The rejected place name has been removed from all source, design and report
  prose. The asset is **Valley Market**; the settlement is referred to
  generically until a replacement name is chosen.
- Authority grid, zero-based fixture centres, footprint, floor elevation,
  cutaway prefixes, door node/clips/travel, LOD budgets and the deterministic
  generator are all unchanged.
- No roads, asphalt, road markings or wheeled-traffic language.
- No forbidden prior commerce building or its art was inspected or reused.

## 7. Automated verification — what is actually tested

`python3 src/verify.py` re-checks the package from the files on disk and exits
non-zero on any failure. **141/141 pass** (`logs/verify.txt`).

1. coordinate contract, asserted in both spaces;
2. all 8 deliverables exist;
3. every manifest sha256 and byte count matches disk;
4. triangle budgets, footprint, door contract, 23/23 clearance checks;
5. every imported prop hashes to the runtime file and has provenance; 8 optional
   props correctly omitted;
6. `gltf-transform validate`: 0 errors, 0 warnings on all four GLBs;
7. Three.js `GLTFLoader` + `AnimationMixer` proof on all four (27 assertions each);
8. 37 final views present, every mandatory view present, none effectively black,
   door closed vs open measurably different;
9. texture contact sheet's stamped hashes match the final maps;
10. every proof camera sits outside the authored collision proxies;
11. **terminal interaction faces measured from the shipped GLB** point +Z;
12. **loose-prop footprints** measured after placement do not intersect any
    authored collision proxy;
13. **sampled BOH path search** proves a continuous ≥0.90 m staff route from
    outside the rear door to behind all three fixtures, and reports the
    measured minimum width;
14. trainer seats/approach/sightline and rear-door clearances present and clear;
15. **envelope closure by ray cast** — 10 openings, 6 corners — plus a
    true-black column test on the elevations and corner crops;
16. **no proof view is stale** — every PNG is newer than every build artefact;
17. material scale/response separation is measured, not asserted.

## 8. Loose props

Only props with provenance were used: `bank_terminal_civic.glb`,
`trade_terminal.glb`, `pa_terminal.glb` (required service fixtures, docked
facing their cells), `chair_frontier_a.glb`, `chair_frontier_b.glb`,
`crate_planked.glb`, `footlocker_frontier.glb`.

**Omitted for missing provenance** (recorded as `props_omitted`):
`stall_vendor`, `crate_cargo_heavy`, `barrel_ribbed`, `barrel_scav`,
`battery_pack_industrial`, `aircon_rooftop`, `antenna_comms`,
`tank_water_frontier`.

`build/prop_footprints.json` records each prop's **measured** bounds after
placement; §12 tests them.

## 9. Commands

```bash
cd tools/successor/assets/market-opus5-rebuild
BL=/snap/blender/current/blender

python3 src/plan.py                        # coordinate contract
python3 src/gen_textures.py                # tiles + micro-band assertions

# empirical probes (these determined the fixes; outputs in build/diag/)
$BL -b --factory-startup -noaudio -P build/diag/diag_terminal_face.py
$BL -b --factory-startup -noaudio -P build/diag/diag_terminal_normal.py
$BL -b --factory-startup -noaudio -P build/diag/diag_openings.py
$BL -b --factory-startup -noaudio -P build/diag/diag_seal.py
$BL -b --factory-startup -noaudio -P build/diag/diag_sweep.py     # camera choice
$BL -b --factory-startup -noaudio -P build/diag/diag_blackpix.py  # name dark pixels

# geometry-only check: names any part leaving the footprint, no export
$BL -b --factory-startup -noaudio -P src/build_market.py -- --stage full --lods 0 --no-export

# full build: LOD0/1/2 + furnished + collision + prop footprints + blend
$BL -b --factory-startup -noaudio -P src/build_market.py -- --stage full

node src/post_gltf.mjs build/market_house_lod0.glb 1.0
node src/post_gltf.mjs build/market_house_lod1.glb 1.0 256
node src/post_gltf.mjs build/market_house_lod2.glb 1.0 128
node src/post_gltf.mjs build/market_house_furnished.glb 1.0

npx gltf-transform validate build/market_house_lod0.glb
node src/loader_proof.mjs build/market_house_lod0.glb
node src/term_face_proof.mjs build/market_house_furnished.glb
python3 src/manifest.py
python3 src/texture_sheet.py proofs/final

# diagnostic pass (moderate) then final evidence
$BL -b build/market_house_full.blend --factory-startup -noaudio -P src/render.py -- \
    --out proofs/pass3diag --res 620 --samples 20
$BL -b build/market_house_full.blend --factory-startup -noaudio -P src/render.py -- \
    --out proofs/final --res 1100 --samples 64

python3 src/verify.py                      # 141 assertions
```

## 10. Iteration record

1. Blockout + 5 alternatives (`proofs/alts/`); E adopted.
2. Pass 1 — rejected at the human gate (4 contract failures + generic massing).
3. Scheme-E rebuild; pass-2 inspection (27 views) → `CRITIQUE_PASS2.md`.
4. Pass-2 corrections; 27-view final set; **76/76 automated checks passed**.
5. **Pass 3 — rejected at the human gate** (`HUMAN_REVIEW_PASS3.md`): 4 hard
   functional and 6 hard visual failures that the checks could not see.
6. This pass: empirical probes → source repairs → moderate diagnostic render
   (`proofs/pass3diag/`) → **further source corrections found by inspecting
   those pixels** (sinter albedo floor, sinter corner backing, buried coffer
   lamp, the world-origin rotation bug) → full rebuild → extended verification
   → 37-view final set, all rendered from one build.

## 11. Compromises and open judgements, named honestly

1. **Automated ≠ accepted.** 141/141 is a statement about the checks. Pass 2
   passed 76/76 and was rejected. The items below are the ones I judge most
   likely to draw a human objection.
2. **The clerestory is not visible from standing eye level indoors.** This is
   geometry, not framing: the service wall (3.35 m) is directly below the
   glazing (3.60 m). `24` is therefore a raised inspection station rather than a
   human-eye view, and `37`/`27` carry the system from outside. If an eye-level
   interior read of the clerestory is required, the service wall or the valley
   height has to change.
3. **`20_crop_loggia` is a close view of one coffer bay**, not the whole arcade.
   The loggia is 0.86 m deep and 3.05 m tall; no station under that soffit can
   step back far enough. The arcade in context is in `01`, `03`, `06`.
4. **The corner joint reads dark in raking diagnostic light** (darkest column
   4.2 % grey in `34`). Ray casts prove it solid and the sinter backing is a
   real material at a real albedo, but it is a recessed joint and it will always
   be the darkest thing on the elevation.
5. **LOD0 is 7.03 MB**, up from 5.96. `KHR_mesh_quantization`, Draco or KTX2
   would cut this substantially, but each adds a runtime extension dependency I
   cannot verify against this client, so the payload is left plain.
6. **Interior lighting in the proofs is render-rig lighting.** The GLBs contain
   no lights, only emissive materials. `render.py` adds area lights standing in
   for authored fixtures. A runtime without its own lighting will look flatter.
   The one place this nearly misled me is documented in §5.10: a rig lamp was
   masking a real bug where the authored coffer lamp was buried inside its pan.
7. **The BOH corridor is 1.00–1.12 m**, which is a working service corridor, not
   a comfortable circulation route. The east end beyond x 3.68 is a working
   recess (bench, switchgear), not a through route, and is furnished as such.
8. **Eight of the twelve optional props were omitted** for missing provenance,
   so the market is furnished mostly with authored geometry — including the
   entire vendor assortment.
9. **The furnished GLB still emits 19 Blender sampler warnings** from the
   imported terminals' own material graphs, which I may not modify. The three
   deliverable LODs are clean.
10. **The second UV set exists only in the `.blend`**, not in the GLBs.
