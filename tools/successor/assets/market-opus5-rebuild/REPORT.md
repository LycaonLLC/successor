# Valley Market — build report

A new market building for Successor, authored from first principles in this
directory. Blind experiment: no existing market/commerce asset, generator,
texture, manifest or redesign brief was opened, searched or derived from.

- **Generator (source of truth):** `src/build_market.py` (deterministic Blender Python)
- **Design record:** `DESIGN.md`, `ALTERNATIVES.md` (5 schemes compared), `CRITIQUE_PASS1.md`, `HUMAN_REVIEW_PASS1.md`, `CRITIQUE_PASS2.md`
- **Deliverables:** `build/market_house_lod{0,1,2}.glb`, `build/market_house_furnished.glb`, `build/market_house.collision.json`, `build/market_house.manifest.json`, `build/market_house_full.blend`, `build/checkpoints/market_house_checkpoint_01_full_lod0.blend`
- **Evidence:** `proofs/final/` (27 views + texture contact sheet), `proofs/pass2/` (inspection pass 2), `proofs/alts/` (scheme comparison), `logs/`

---

## 1. What the building is

**Scheme E — "Valley Market".** An asymmetric butterfly roof folds about a
valley gutter that sits **directly over the interior service wall**, so the fold
has a real load path rather than being a shape. The north plane is lifted
0.55 m above the valley, making a south-facing clerestory that washes the
service wall and staff aisle with light; its brise-soleil blades are the only
repeated element on the building and they exist to shade that glass.

Water is the parti. On an inhabited desert planet, collecting it is the thing
worth expressing: **valley → east sump → downpipe → cistern drum → rear plant**,
with an overflow that stains the north wall in exactly one place.

Exactly **one curve** exists: the vaulted entry hood. It breaks the south eave
(apex 4.60 m vs eave 4.42 m), so the entrance is the tallest event on the public
face both in elevation and in the pitched top-down game view. The south facade
is plan-stepped three times at three different setbacks — loggia (y −3.98),
trainer bay (−3.72), hood (−4.16) — so no two bays repeat.

Skyline: four different shapes at four different heights — square windcatcher
6.60, cistern drum 6.18, round flue 5.79, arched hood 4.60.

Interior: one tall public hall under a raked soffit (4.17 m at the entry falling
to 3.40 m at the valley), a low service zone behind, three terminals **docked in
deep niches** with authored backing panels, a real back-of-house staff aisle, a
vendor display line west, and a trainer consultation bay south-east.

## 2. Authority contract

| requirement | value | proof |
|---|---|---|
| footprint | authored 11.370 × 8.505 m inside the 11.40 × 8.55 limit | `assert_footprint` + `report_offenders` run every build; loader proof re-measures from the GLB |
| floor top | Y = 0.02 m | `plan.py::FLOOR_TOP` |
| front | +Z public | hood, loggia, trainer bay and door all on +Z |
| bank (3,3) | glTF x −2.375, z −0.950 | `plan.py::assert_contract`, printed each build |
| trade (6,3) | glTF x +0.475, z −0.950 | idem |
| association (9,3) | glTF x +3.325, z −0.950 | idem |
| trainer (10,6) | glTF x +4.275, z +1.900 | idem |
| door node | `door_slide`, scene-root child | Three.js proof asserts no cutaway-prefixed ancestor |
| door travel | local **X**, closed 0.0, open **−2.60 m** | measured in Three.js, leaf mesh moves 2.6000 m in world space |
| clips | `door_open`, `door_close`, **0.800 s**, 30 fps | measured from the GLB, not from Blender names |
| cutaway prefixes | `roof__ wall_front__ wall_back__ wall_left__ wall_right__` | all present as top-level nodes |
| permanent | `floor__ interior__` | idem |
| collision | `successor.structure-collision.v3`, 40 authored boxes | `build/market_house.collision.json` |
| clearance | **13/13 checks clear** | 4 fixture cells, 4 approaches, 3 terminal front-clearances, door swept volume, door walk-through |

The zero-based cell helper is the one from the review gate:
`x = -5.700 + (c+0.5)*0.950`, `z = -4.275 + (r+0.5)*0.950`, with
`plan_y = 4.275 - (r+0.5)*0.950` asserted to agree independently.

## 3. Numbers

| | tris | budget | materials | GLB |
|---|---|---|---|---|
| LOD0 | 24,572 | 90,000 | 11 | 5.96 MB |
| LOD1 | 20,012 | 45,000 | 10 | 3.49 MB |
| LOD2 | 2,504 | 20,000 | 9 | 0.51 MB |
| furnished (LOD0 + 7 props) | 42,912 | — | 41 | 8.51 MB |

Textures: **21 images / 4.61 MB on disk** — 7 PBR sets (basecolor 512², normal
512², packed ORM 256²) at a uniform 256 px/m on a 2.0 m tile. In the shipped
GLBs the exporter payload is trimmed per slot (basecolor 512, normal 256,
ORM/occlusion 128) because normal and ORM carry micro-detail only.

## 4. Materials, UVs, wear

Seven PBR materials (sinter, ceramic, plaster, screed, roof metal, steel, brass)
plus four untextured slots (glass, seal, warm lamp, cyan lamp). Tints re-pitch
the palette for a desert settlement without adding image data.

Three export rules are encoded in `src/mlib.py` and were arrived at by isolating
each warning in `build/diag/`:

1. n-gons must be triangulated or glTF tangent generation fails;
2. every material must consume the `Col` layer or COLOR_0 is dropped from the
   whole primitive;
3. a packed ORM image must be linked from **exactly one** socket (Roughness), or
   Blender emits "More than one shader node tex image…". Metallic is therefore a
   per-material constant, and `occlusionTexture` is re-attached to that same
   texture after export by `src/post_gltf.mjs`.

**UVs.** `uv_project` builds each face's UV frame from its own normal, so texel
density stays constant on battered, raked and bevelled faces — this is what
killed the pass-1 stretch banding (worst measured length ratio 2.000). LOD0 also
carries a second, non-overlapping smart-projected `UVBake` layer in the editable
`.blend` for future baking; it is deliberately **not** exported, to keep
TEXCOORD_1 out of the runtime payload.

**Wear is causal, not noise.** Tiles carry micro-detail only (enforced by
`gen_textures.py::assert_micro_only`, low-frequency RMS budget 0.055). Everything
at architectural scale lives in COLOR_0: per-part tonal drift, short-ray contact
AO (0.55 m rays, so occlusion darkens creases instead of dimming the building),
26 named grime sources at places hands/goods/feet actually go, water streaks only
under things that shed water (datum band, cistern overflow, west sump), and
wind-blown dust on up-facing surfaces low down. All of it is clamped into 0..1
because glTF clamps COLOR_0.

## 5. Iteration record

1. **Blockout + 5 alternatives** (`proofs/alts/`, `ALTERNATIVES.md`) — A control
   stepped box, B vault hall, C fold & towers, D colonnade ring, E synthesis.
   E adopted; A and D rejected outright; B and C partially adopted.
2. **Pass 1** — rejected by the human review gate. Four objective contract
   failures (shifted fixture cells, identical door proofs, cutaway keeping
   ceilings, export warnings) plus a generic-massing verdict.
3. **Scheme-E rebuild** — `src/build_market.py` rewritten end to end for E.
4. **Pass 2 inspection** (`proofs/pass2/`, 27 views) → `CRITIQUE_PASS2.md`.
5. **Post-pass-2 corrections** (all executed, all re-measured — see §6).
6. **Final set** (`proofs/final/`, 27 views at 1100 px / 64 samples). Reviewing
   that set found two more geometry defects (E9, E10), four proof cameras that
   missed their subject, two cameras that were *inside* geometry, and a staff
   aisle that was too dark to read. All were fixed — camera positions are now
   validated against the authored collision proxies before rendering — and the
   whole set was re-rendered from one build so no proof is stale.

## 6. Corrections made after pass 2, with measurements

| defect | correction | measured effect |
|---|---|---|
| **E1** roof read as a barcode (column-profile sd 0.0368, dominant 113-cycle component) | roof rebuilt as a *system*: four unequal expressed rafters on the purlin lines, a trimmer header where the hood penetrates, two unequal dark collector arrays with real gaps, a service walk on the entry axis; seams demoted to the walk and verge bays only and reduced to 0.026 × 0.028 m | field sd 0.074 → 0.091 with the variation now coming from hierarchy rather than stripes |
| **E2** all rooftop plant in one east-west row (y-centroid sd 36.7 px) | every item re-sited with cause and staggered in y: windcatcher 2.55, condensers 3.50 / 2.42, flue 3.44, drum 2.86, hatch 3.30 | visibly staggered in `05_top`, `07_gameplay_ortho`, `18_roof_plant_deck` |
| **E3** no silhouette (building 0.471 vs ground 0.441, separation 0.030) | palette re-pitched: ceramic and roof metal tinted warm-dark, plinth kept dark, COLOR_0 base lowered to 0.88 with dust lifting toward 1.0 | separation 0.030 → **0.041**, and the mass is now *darker* than the sand instead of the same value |
| **E4** butterfly fold illegible from the game camera | collector arrays pulled back from the valley so the fold reads as a dark slot; brise-soleil deepened | fold + clerestory legible in `07`, `27_crop_clerestory_brise` |
| **E5** blank north service wall | authored rear elevation: recessed loading porch with canopy/drip/stays/lamp, trolley kerb, pipe rack on brackets, three staggered vents each over what it serves, meter cabinet, hose bib | `17_rear_service`, `26_crop_rear_service_door` |
| **E6** blank trainer-bay walls | bay built-ins: three-step shelf stack, backing panel, display case, brass rail, edge markers | `22_interior_eye_trainer` |
| **E7** entry/door proofs framed inside the hood throat | cameras pulled back and widened (38 mm / 46 mm) | `10`, `11`, `12` now read as an entrance |
| **E8** flat loggia soffit | coffers with brass lips between the joists | `20_crop_loggia` |
| extra | hood ring was a thin outline | inner radius 1.62 → 1.42, so the modelled arch ring is **0.48 m** deep, with the wall opening and collision proxies derived from it | `13_crop_facade_hood` |
| **E9** (found while reviewing the final set) the service wall between the niches was a blank ceramic slab at eye level | articulated with three members already in the building's vocabulary: a brass kick where trolleys hit, a shallow recessed panel, and a datum reveal continuing the niche lintel line across each solid pier | `15_crop_service_counter`, `09_interior_eye_hall` |
| **E10** (same review) the docked terminals sat in their own shadow, so the fixture the player interacts with was the darkest thing in the bay | added a second authored fixture per niche — a housed wash lamp at the niche head aimed at the terminal face — plus a matching rig practical so the proofs show it honestly | `15`, `09` |

## 7. Every gate the review gate set, and its evidence

- **Coordinates** — corrected helper + hard assertions in both spaces, printed
  every build (`logs/build_full.log`).
- **Door proofs** — automated pixel check. At the pass-2 close framing:
  **RMSE 78.32**, 80.1 % of pixels changed. At the wider final framing, where
  the leaf is a smaller part of the frame: **RMSE 17.59**, 7.8 % of pixels
  changed. Root cause of the pass-1 zero-RMSE was the render
  rig's manual transform being overwritten by active NLA evaluation; `door()`
  now mutes the tracks and clears the action first.
- **Runtime animation** — verified in real Three.js r169, not inferred from
  Blender names: both clips are 0.800 s, `door_open` drives local X 0.0 →
  −2.6000, the **leaf mesh** translates 2.6000 m in world space, motion is
  interpolated (t=0.4 → −1.3000), and driving the node directly reaches the same
  pose. 27/27 assertions pass on LOD0/1/2 and furnished.
- **Cutaway** — ceilings are `roof__ceil_*`; `08_interior_roofoff` shows the
  whole plan. Loader proof asserts all five cutaway prefixes exist as top-level
  nodes and that `door_slide` has no cutaway-prefixed ancestor.
- **Export warnings** — LOD0/1/2 and furnished all export with **0 warnings**
  from authored geometry. The 19 sampler warnings that remain in the furnished
  build come only from the read-only terminal GLBs' own material graphs; they
  are outside this asset's authorship and are not hidden.
- **Strict validation** — `gltf-transform validate`: **0 errors, 0 warnings,
  0 info** on all four GLBs.
- **Texture sheet** — regenerated from the final files, with each tile's sha256
  prefix stamped into the image and a sidecar json listing the hashes shown, so
  a stale sheet is detectable.

## 8. Loose props

Only props with provenance were used, as `ALLOWED_PROPS.md` requires:

- `bank_terminal_civic.glb`, `trade_terminal.glb`, `pa_terminal.glb` (required
  service fixtures, docked in niches, facing their cells)
- `chair_frontier_a.glb`, `chair_frontier_b.glb`, `crate_planked.glb`,
  `footlocker_frontier.glb`

**Omitted for missing provenance** (recorded in the manifest as
`props_omitted`): `stall_vendor`, `crate_cargo_heavy`, `barrel_ribbed`,
`barrel_scav`, `battery_pack_industrial`, `aircon_rooftop`, `antenna_comms`,
`tank_water_frontier`. Their roles are authored instead — the vendor line,
rooftop condensers, cistern drum, comms-free skyline and the BOH water tank are
all new geometry.

Terminals sit in niches whose back is at y 2.455 authoring, so each terminal
face stands 0.40–0.44 m clear of its promised cell, and the manifest's 0.8 m
front clearance is proven as its own collision check.

## 9. Commands

```bash
cd tools/successor/assets/market-opus5-rebuild
BL=/snap/blender/current/blender          # snap wrapper mangles argv under some shells

# coordinate contract
python3 src/plan.py

# textures (deterministic; micro-only assertions)
python3 src/gen_textures.py

# architectural alternatives (cheap diagnostics)
$BL -b --factory-startup -noaudio -P src/alts.py -- --res 640 --samples 32

# geometry-only check: names any part leaving the footprint, no export
$BL -b --factory-startup -noaudio -P src/build_market.py -- --stage full --lods 0 --no-export

# full build: LOD0/1/2 + furnished + collision + report + blend + checkpoint
$BL -b --factory-startup -noaudio -P src/build_market.py -- --stage full

# post-export ORM occlusion wiring, unused-attribute prune, per-slot texture budget
node src/post_gltf.mjs build/market_house_lod0.glb 1.0
node src/post_gltf.mjs build/market_house_lod1.glb 1.0 256
node src/post_gltf.mjs build/market_house_lod2.glb 1.0 128
node src/post_gltf.mjs build/market_house_furnished.glb 1.0

# strict validation + inspection
npx gltf-transform validate build/market_house_lod0.glb
npx gltf-transform inspect  build/market_house_lod0.glb

# Three.js load + door animation proof (real GLTFLoader + AnimationMixer)
node src/loader_proof.mjs build/market_house_lod0.glb

# manifest from the files on disk (hashes are of the shipped artefacts)
python3 src/manifest.py

# texture contact sheet from the final maps
python3 src/texture_sheet.py proofs/final

# proof renders
$BL -b build/market_house_full.blend --factory-startup -noaudio -P src/render.py -- \
    --out proofs/pass2 --res 760 --samples 26
$BL -b build/market_house_full.blend --factory-startup -noaudio -P src/render.py -- \
    --out proofs/final --res 1100 --samples 64

# ONE COMMAND that re-checks the whole shipped package (76 assertions)
python3 src/verify.py

# measured door-proof difference
python3 -c "
import numpy as np; from PIL import Image
a=np.asarray(Image.open('proofs/final/10_door_closed.png').convert('RGB'),float)
b=np.asarray(Image.open('proofs/final/11_door_open.png').convert('RGB'),float)
print('RMSE',((a-b)**2).mean()**.5)"
```

## 10. Re-runnable verification

`python3 src/verify.py` re-checks the package from the files on disk and exits
non-zero on any failure. Current result: **76/76 pass** (`logs/verify.txt`).

1. coordinate contract asserts in both spaces;
2. all 8 deliverables exist;
3. every manifest sha256 and byte count matches the file on disk;
4. triangle budgets, footprint, door contract, 13/13 clearance checks;
5. every imported prop hashes to the runtime file and has provenance; 8 optional
   props correctly omitted;
6. `gltf-transform validate`: 0 errors and 0 warnings on all four GLBs;
7. Three.js loader + animation proof passes on all four (27 assertions each);
8. 27 final views present, every mandatory view present, none effectively black,
   door closed vs open measurably different;
9. the texture contact sheet's stamped hashes match the final maps;
10. every proof camera sits outside the authored collision proxies — this check
    exists because two cameras were found *inside* geometry during the final
    review, and one was 6 cm above the queue rail.

## 11. Compromises, named honestly

1. **LOD0 is 5.85 MB.** ~2.7 MB of that is geometry stored as float32
   POSITION/NORMAL/TANGENT/TEXCOORD/COLOR. `KHR_mesh_quantization` would roughly
   halve it, and Draco or KTX2 would cut more, but all three add a runtime
   extension dependency I cannot verify against this client, so I left the
   payload plain and documented the option instead of shipping something the
   loader might reject.
2. **Interior lighting in the proofs is render-rig lighting.** The exported GLBs
   contain no lights — only emissive materials. `render.py` adds ten area
   lights: six practicals standing in for authored fixtures (hall, service wall,
   three niche washes, staff aisle, trainer bay, entry, vendor) plus one wide
   source representing the daylight that arrives *through* the clerestory. A
   runtime without its own lighting will look flatter than `09`/`21`–`24`.
3. **The staff aisle is 1.11 m wide behind the niches** (1.42 m elsewhere). That
   is a maintenance aisle, not a comfortable circulation route. It is the direct
   cost of docking terminals deep enough to keep every promised cell clear, and
   I chose the cell clearance.
4. **The second UV set exists only in the `.blend`.** Non-overlapping bake UVs
   are authored and verifiable, but shipping TEXCOORD_1 in the GLB would add
   payload for a bake that this asset does not currently use.
5. **Nine of the twelve optional props were omitted** because they have no
   `.provenance.json`. This is what `ALLOWED_PROPS.md` demands, but it does mean
   the market is furnished mostly with authored geometry.
6. **The furnished GLB still emits 19 Blender sampler warnings.** They come from
   the imported terminals' own material graphs, which I may not modify. The
   three deliverable LODs are clean.
7. **Ceramic/normal-map micro-detail is subtle at gameplay distance.** The
   micro-only tile policy is what stopped the pass-1 "noise stamped over
   everything", but it means close crops carry the material identity and the
   ortho view leans on geometry and COLOR_0 instead.
