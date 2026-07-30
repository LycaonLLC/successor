# Valley Market — build report

A new market building for Successor, authored from first principles in this
directory. Blind experiment: no existing market/commerce asset, generator,
texture, manifest or redesign brief was opened, searched or derived from.

- **Generator (source of truth):** `src/build_market.py` (deterministic Blender Python)
- **Design record:** `DESIGN.md`, `ALTERNATIVES.md` (5 schemes compared), `CRITIQUE_PASS1.md`, `HUMAN_REVIEW_PASS1.md`, `CRITIQUE_PASS2.md`, `HUMAN_REVIEW_PASS3.md`
- **Deliverables:** `build/market_house_lod{0,1,2}.glb`, `build/market_house_furnished.glb`, `build/market_house.collision.json`, `build/market_house.manifest.json`, `build/prop_footprints.json`, `build/market_house_full.blend`, `build/checkpoints/market_house_checkpoint_01_full_lod0.blend`
- **Evidence:** `proofs/final/` (**46 views + texture contact sheet**, all rendered from the shipped build), `proofs/pass4diag/`…`pass4diag6/` (this pass's diagnostic rounds), `proofs/pass3diag/`, `proofs/pass2/`, `proofs/alts/`, `logs/`, `build/diag/`

> **Status.** `python3 src/verify.py` passes **191/191** automated assertions.
> That is a statement about the automated checks, not a claim of acceptance.
> Pass 2 passed 76/76 and was rejected. Pass 3 passed 141/141 and was rejected.
> Both times the checks did not test the things that were broken, and both times
> the defect was visible in the shipped pixels. §7 lists what is now tested,
> §5 records what pass 4 found and changed, and §11 names what is still a
> judgement call — including one trade in the daylight section that cannot be
> won, only chosen.

---

## 1. What the building is

**Scheme E — "Valley Market".** An asymmetric butterfly roof folds about a
valley gutter that sits **directly over the interior service wall**, so the fold
has a real load path rather than being a shape. The north plane is lifted
**0.84 m** above the valley, making a south-facing clerestory that washes the
staff aisle with light; its brise-soleil blades are the only repeated element on
the building. The service wall drops to 2.86 m between four expressed piers that
carry the fold, so that clerestory is visible from a standing player's eye —
which it was not in pass 3.

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
glazed transom over the counter wall, a back-of-house staff corridor with a
proven 1.00 m clear route lit by the clerestory, a vendor display line west, a
customer waiting nook east, and a trainer consultation booth with a skills
assessment bay in the deepened south-east bay.

The two flanks do different work: **west is goods and structure** (buttress,
shuttered goods hatch, sump downpipe and spill block); **east is water and
plant** (draw-off standpipe with trough, isolator cabinet on a bund, conduit
drop). At every outside corner the sintered mass returns as an expressed pier
with a chamfered arris, a splayed base course, a brass impact guard and a brass
capping.

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
| collision | `successor.structure-collision.v3`, **60** authored boxes | `build/market_house.collision.json` |
| clearance | **23/23 checks clear** | 4 fixture cells, 4 approaches, 3 terminal front-clearances, rear-door approach + walk-through, BOH route band, 3 BOH service-side reaches, 2 trainer seats, trainer standing approach, trainer sightline, door swept volume, door walk-through |

Cell helper unchanged: `x = -5.700 + (c+0.5)*0.950`, `z = -4.275 + (r+0.5)*0.950`,
with `plan_y = 4.275 - (r+0.5)*0.950` asserted to agree independently.

## 3. Numbers

| | tris | budget | materials | GLB |
|---|---|---|---|---|
| LOD0 | 49,076 | 90,000 | 11 | 6.66 MB |
| LOD1 | 39,576 | 45,000 | 11 | 5.45 MB |
| LOD2 | 3,884 | 20,000 | 10 | 0.53 MB |
| furnished (LOD0 + 7 props) | 67,416 | — | 41 | 9.15 MB |

LOD0 grew from 40,524 to 49,076 triangles in this pass: six lower corner piers
with chamfers, base courses, guards and cappings; the rebuilt keystone at 64
radial segments; the goods hatch and the two flank service assemblies; the
service-wall piers and glazed transom; and the trainer booth's assessment
hardware. It remains at 55 % of budget. LOD0's file *shrank* (7.03 → 6.66 MB)
because the flattened base-colour maps compress far better.

Textures: **21 images / 2.34 MB on disk** — 7 PBR sets at 512² basecolor,
512² normal, 256² packed ORM. Down from 3.19 MB for the same coverage.

## 4. Materials, UVs, wear

Seven PBR materials (sinter, ceramic, plaster, screed, roof metal, steel, brass)
plus four untextured slots (glass, seal, warm lamp, cyan lamp).

**Per-material scale and response (rebuilt again this pass).** Pass 3 gave each
material its own tile scale and bounded high-frequency energy in a *band* —
floor **and** ceiling. The pass-4 review identified the floor itself as the
defect: it made "every material must contain visible noise" a build requirement,
so screed, sinter, plaster, ceramic and brass all kept an evenly distributed
procedural speckle and the close crop read as one noise family recoloured seven
ways.

**The floor is removed.** Only the ceiling remains, and it is tightened. Base
colour is now flat unless the real material genuinely has different minerals at
the surface — which only two do: sintered basalt (fused aggregate) and ground
screed (cut aggregate faces exposed by grinding). Everything the other five
materials used to say in albedo they now say in normal and roughness, where it
is physically causal: plaster's float undulation, ceramic's crazing, brass's
turning marks, steel's brush grain, galvanised spangle.

| material | tile | base-colour micro | *ceiling* | roughness micro | linear value | roughness | metallic |
|---|---|---|---|---|---|---|---|
| sinter | 1.30 m | 0.0123 | 0.030 | 0.0241 | 0.097 | 0.80 | 0 |
| ceramic | 2.40 m | 0.0004 | 0.005 | 0.0048 | 0.569 | 0.53 | 0 |
| plaster | 1.70 m | 0.0005 | 0.005 | 0.0122 | 0.495 | 0.89 | 0 |
| screed | 2.10 m | 0.0110 | 0.014 | 0.0252 | 0.057 | 0.28 | 0 |
| roof metal | 1.50 m | 0.0026 | 0.011 | 0.0337 | 0.249 | 0.70 | 1 |
| steel | 0.55 m | 0.0008 | 0.007 | 0.0193 | 0.075 | 0.44 | 1 |
| brass | 0.30 m | 0.0004 | 0.005 | 0.0172 | 0.247 | 0.23 | 1 |

Measured, and asserted by `verify.py` §17:

- the five quiet materials sit at **0.0004–0.0026** base-colour micro energy —
  effectively flat;
- **every** material carries more micro detail in roughness than in albedo;
- value spans **0.057–0.569 linear (10.0×)**, roughness **0.23–0.89**, tiles
  **0.30–2.40 m**, and the palette spans dielectric and metallic;
- there is now **no minimum micro-energy floor on any map**, and `verify.py`
  asserts that none exists, so this cannot quietly come back.

`build_market.py` still reads the tile scales from `textures.json` rather than
restating them, so designed scale and projected scale cannot drift apart.

**One honest negative result.** I measured high-frequency energy in the rendered
crops before and after, resampled to a common size. It went **up**, not down:
`14_crop_floor_wall_contact` +9.4 %, `15_crop_service_counter` +22.3 %. That is
not a failure of the change, it is a bad proxy — moving detail out of albedo and
into normal and roughness keeps high-frequency *shading* variation while changing
its character from uniform dirt in every texel to a directional specular
response, and this pass also added a lot of new geometry with new edges. The
rigorous measurement is at the texture level, where base-colour micro energy for
the five quiet materials fell from the pass-3 band of 0.007–0.025 to
**0.0004–0.0026**. I am recording the number that did not flatter the change
because picking only the other one would be the same mistake as
`VERIFY_ALL_OK`.

Sinter's albedo floor stays at 0.074 linear (raised in pass 3 from 0.036).
**Steel's was raised this pass, 0.042 → 0.061**, after a new part — the east
flank's conduit drop — rendered as a 1.5 m tall black bar at mean luminance
0.032. At 0.042 any steel member in shade collapsed into the same "void"
reading the review has now rejected twice; steel is still the darkest material
in the palette and still separates from sinter by metallic response and by
roughness 0.44 vs 0.80, not by value alone. Members that are *large flat panels*
in shade — the goods-hatch shutter, its box, the conduit and the brise blades —
were moved to galvanised sheet, which is also what they would actually be.

**UVs.** `uv_project` builds each face's UV frame from its own normal, so texel
density stays constant on battered, raked and bevelled faces. LOD0 also carries
a second, non-overlapping smart-projected `UVBake` layer in the editable
`.blend`; it is deliberately not exported.

**Wear is causal.** Tiles carry micro-detail only (`assert_micro_only`, plus the
new `assert_micro_band`). Architectural-scale variation lives in COLOR_0:
per-part tonal drift, short-ray contact AO, 26 named grime sources where hands
and goods actually go, water streaks only under things that shed water, and
wind-blown dust on up-facing surfaces low down.

## 5. What the pass-4 review rejected, and what was actually wrong

Every item states the defect, the **root cause found by measurement**, the source
change, and the evidence. Two of these were found only by rendering and looking;
one was found only because a check I wrote for something else fired.

### 1. The lower corner still read as a void *(art)*

**Cause — and it was not missing geometry.** Pass 3 sealed the *rainscreen*
corner above the datum and proved it solid by ray cast. The check was true and
the picture was still wrong, because the geometry was **doubled**.
`build/diag/diag_facepairs.py` queried the mesh directly and found that at every
outside corner two wall solids present **coplanar faces in the same plane**, back
to back — e.g. `wall_back__` plinth end-cap at x = −5.56 lying exactly on
`wall_left__` plinth face at x = −5.56, 0.375 m² each. Two coplanar faces occlude
each other's ambient rays at zero distance, so a strip **exactly one wall
thickness (0.34 m) wide** rendered at luminance 0.002 while the same sinter in
the field rendered at 0.45 — a 225× difference in one material under one light.

That is why "a ray hit something" and "not mathematically black" both passed
while the elevation still showed a void: the ray hits real material that can
never receive light.

**Change.** The lower mass gets the corner condition it always needed. At each of
the six outside corners the sintered structure **returns as an expressed pier**
whose plan return reaches both walls' inner faces — which buries the coplanar
pair inside solid geometry — with a 45° chamfered arris, a splayed base course
with a weathered chamfered top, a brass impact guard across the chamfer at
0.36–1.10 m where trolleys and shoulders strike, guard studs, a weathering
set-off, and a brass corner capping that swells the datum band where it caps the
pier and still oversails it (0.075 vs 0.055) so the drip is preserved. The upper
rainscreen joint, its closures and its drainage are untouched.

**Guard.** `diag_lowcorner_v2.py` walks both corners' three faces at eleven
heights and `verify.py` §18 asserts, **for the section below the datum only**:
every sample hits geometry; **no sample has a duplicate surface within 1 mm in
front of it**; sky visibility ≥ 0.45; at least two materials present; and the
chamfer is a real third plane. Measured now: 24 lower samples per corner, **0
duplicates**, worst sky visibility **0.81** (it was ~0.00 where the coplanar pair
sat), materials `{sinter, brass}`.

**Evidence.** `38_crop_lowcorner_sw`, `39_crop_lowcorner_ne`, `34`, `35`, `03`,
`04`. The darkest column in `34_crop_corner_sealed` went from **4.2 % to 16.2 %**
grey, and `03_left` / `04_right` lost their dark bands entirely — 1st-percentile
luminance 0.0000 → 0.045.

### 2. The keystone was a black puck *(art)*

**Cause.** A brass block with an 18-sided `MKT_Steel` cylinder (albedo 0.042)
pushed into its face. Dark, low-sided, unlit — exactly "an unfilled hole".

**Change.** A machined brass boss: a stepped block, two turned rings forming a
recess, a lit brass back disc, a lamp ring behind glass, a rebated glass roundel,
and in front of it the market mark — a hub and **four unequal spokes**, goods
arriving from four ways. 64 radial segments, smooth-shaded with creased edges.
No lettering, no settlement name.

**The bug this exposed.** My first version put a "machined step" plate 0.5 mm in
*front* of the rim, so the entire roundel was buried and `40_crop_keystone`
rendered a blank brass panel. That is the pass-3 coffer-lamp bug again — a
visible thing authored inside an opaque thing. It is now a **build-time
assertion**: `assert_not_buried()` fails the build if any visible-critical part
(lamp, glass, mark, focal insert) is both fully enclosed by an opaque part's
bounds **and** has its centre inside that part's solid material. Both conditions
are needed — enclosure alone misreports the fanlight glass inside its own annular
frame; centre-in-solid alone misreports it because one radial bar crosses its
centre. On its first run it found a **third** instance I had not noticed: the
bank/trade/assoc niche wash lamps were inside their own housings, lighting the
inside of their cans. 69 visible-critical parts are now checked every build.

**Evidence.** `40_crop_keystone`, `36_crop_hood_smooth`, `13`, `01`.

### 3. Every material was required to contain noise *(art)*

Rebuilt as described in §4. The **minimum** micro-energy floor is deleted, and
`verify.py` asserts that no floor exists on any map.

**Evidence.** `46_crop_material_family` (screed, sinter, ceramic and brass in one
full-resolution frame), `14`, `16`, `texture_contact_sheet`.

### 4. The side elevations were one dead wall each *(art)*

The two flanks now do **different** work, because the rooms behind them are
different, and each has three elements at three scales rather than a row of
equal greebles.

- **West — goods and structure**: a sintered buttress at the valley /
  service-wall line (the one place a real load lands on this flank), a shuttered
  goods hatch so stock reaches the vendor end of the hall without crossing the
  customer entrance, and the west valley sump's hopper, downpipe, clips, shoe and
  spill block — which is what makes the water stain authored on that wall true.
  The stain was moved to y 1.42 to sit under the pipe that causes it.
- **East — water and plant**: a brass draw-off standpipe with valve wheel, hose
  coupling and trough (water is the settlement's other trade), an isolator
  cabinet on a raised bund outside the switchgear it serves, and the conduit drop
  linking the roof plant to it.

Every projection is held inside 0.10 m of the wall face; the roof verge is only
0.12 m clear and the authored footprint limit is 0.14 m. Footprint unchanged, no
roads, no wheeled-traffic language.

**Evidence.** `41_west_flank_service`, `42_east_flank_service`, `03`, `04`.

### 5. The daylight section was not legible from a player viewpoint *(art)*

**Cause.** Pass 3 reported this honestly and answered it with a raised camera.
The section was the problem: a 3.35 m service wall stood directly in front of
glazing starting at 3.60 m.

**Change — the section, not the camera.** The service wall head drops to
**2.86 m** between four unequal expressed piers which continue to 3.38 m and
carry the fold; the glazed **transom** above it gives the hall a lit band over
the counter; the **valley beam moved south** of the glazing plane, under the
south deck edge, where it is also the brass-faced edge of the hall ceiling; the
clerestory posts stand **on** the service-wall piers, so the load path reads in
one line (north deck → post → pier → floor); and the north plane's lift grew
0.55 → **0.84 m**, making the band 0.62 m instead of 0.49 m, while staying below
the hood apex so the entrance is still the tallest event on the public face.

**Two things found only by ray-tracing the shipped geometry.**

*The clerestory sill and head* were centred on the glazing plane and so projected
0.11 m north of it — a 0.09 m sill 0.11 m proud is enough on its own to cut the
standing sightline to the bottom of the band. Both moved south.

*The brise-soleil was the real blocker.* `diag_raychain.py` traced a standing eye
in the BOH and found **every** sightline through the glazing met 2–4 blade
surfaces before escaping; `diag_frame.py` measured **0.00 % sky** in the whole
frame. A louvre passes rays shallower than `atan(spacing/depth)` and blocks
steeper ones — so to block a 42° sun the cut-off must be under 42°, and a
standing eye 1.35 m from the band looks **up at 56°**. **Shading this glass and
seeing through it are mutually exclusive at this section.** I chose the review's
requirement: the blades step south and up from the head, oversailing 0.63 m.
They shade the band above z 3.894 at a 42° sun (about half the aperture at
midday, more morning and evening), cast the shadow that gives the fold depth in
the pitched game view, and leave the aperture clear from inside. §11 names this
as the trade it is.

**Guard.** `diag_standing_daylight.py` measures from 1.65 m stations tested
against the shipped collision sidecar, and `verify.py` §19 asserts them. Measured
from the shipped build: glazing band 3.605–4.220 m; opaque service-wall head
**2.930 m**, i.e. **0.675 m below the sill**; from the three open-bay aisle
stations **48 % / 55 % / 35 %** of sampled rays land on the glazing and **all of
them continue outside the envelope** — it is an aperture, not a panel; the
aperture between the structural posts is clear within 0.30 m south (0
obstructions); the niches remain enclosed; the beam is south of the glazing.
`diag_daylight.py` renders the same BOH view four ways: it is **3.25× brighter**
with sun and sky than with the authored emissives alone.

The rig's stand-in lamp is gone. Pass 3 lit the aisle with a 420 W area light
placed where the glazing should have been visible, which meant the proofs showed
daylight the building did not have. Interiors now render at full sky strength and
the light arrives through the real glass.

**Evidence.** `24_interior_clerestory` (standing eye, along the aisle),
`43_interior_eye_transom` (standing eye, hall), `44_gameplay_daylight`,
`27_crop_clerestory_brise`, `37_crop_clerestory_glazing`, `23`.

### 6. The trainer booth had no training-specific identity *(art)*

The blank 1.86 × 1.00 m pinboard is replaced by a **skills assessment bay**: a
calibration column the customer stands at, with a brass contact plate, a cyan
lamp and a sensor mast with turned rings; a smaller, higher lit readout with a
graduated brass scale and five **unequal** lit bars reporting a reading; and a
demonstration rack of instruments in slotted keeps on the east wall. The old
blank east shelf stood exactly where the rack is and was removed rather than
doubled up. Both seated volumes, the standing approach, the sightline and the
trainer fixture cell are unchanged and still proven clear (23/23).

**Evidence.** `45_trainer_identity`, `33_trainer_booth`, `22`.

### 7. Proof views that did not read without their filenames

`20_crop_loggia` is now an **exterior oblique** from the south-west: all three
unequal piers, both coffer bays with joists and brass lips, the goods ledge, the
bench and the lit shopfront in one frame. You cannot show a 0.86 m deep arcade
from inside it, which is what pass 3 tried. The daylight system is shown in
architectural context — along the aisle it lights, at the transom it makes, from
outside, and in the pitched game view — not as a close crop of dark strips. Nine
new views were added, one per rejected item, and `verify.py` requires all of them
by name, checks every camera is outside collision, and now runs the true-black
column test on the lower-corner and flank crops too.

### 8. The sun was in the wrong hemisphere *(found by measurement, not reported)*

While checking why sun+sky was only 6 % brighter than sky alone, I resolved the
rig's Euler angles into world vectors (`diag_sundir.py`). The beauty sun was at
`(48, 218)`, which is a sun in the **north-west**. The building's public facade
and its clerestory both face **south**. So for three passes:

- the public south facade was in shade in **every** beauty proof;
- the south-facing clerestory received **no direct sun at all**;
- the brise-soleil shaded nothing.

The sun moved to the south-east at 42° altitude. Diagnostic crops now take a 20°
grazing sun raked **from the side of the corner being examined** — a south-west
corner photographed with the sun in the north-east, which is what pass 3 did, is
the least informative picture available. `verify.py` §20 asserts the sun lights
the south facade and the clerestory.

## 5b. What the pass-3 review rejected, and what was actually wrong

> **Historical.** This section records the pass-3 round and is left unedited so
> the trail is auditable. Where it conflicts with §5 above, §5 is current — in
> particular items 7 and 10 below (the micro-energy *band*, and the claim that
> the clerestory cannot be seen from eye level) were **themselves rejected by
> the pass-4 review** and have been superseded.

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
non-zero on any failure. **191/191 pass** (`logs/verify.txt`).

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
17. material scale/response separation is measured, not asserted — and it now
    also asserts that **no minimum micro-energy floor exists on any map**, that
    the five quiet materials are near-flat in albedo, and that every material
    carries more micro detail in roughness than in base colour;
18. **the lower corner is tested as its own section** (below `band_top`): every
    sample hits, **no duplicate coplanar surface sits in front of any sample**,
    sky visibility ≥ 0.45, ≥ 2 materials present, and the chamfer is a real
    third plane — the check that would have caught pass 3's defect;
19. **the daylight section is measured from 1.65 m standing stations** that are
    themselves proven outside the collision proxies: glazing hit fraction, that
    every glazing ray continues outside the envelope, a clear aperture between
    the posts, the service-wall head against the glazing sill, the niches still
    enclosed, the beam south of the glazing, and a rendered measurement that the
    BOH is ≥ 2× brighter with daylight than with emissives alone;
20. **the render rig's sun is resolved into world vectors** and must actually
    light the south facade and the south-facing clerestory.

Also added at build time, not verify time: `assert_not_buried()` fails the build
if any visible-critical part is enclosed by, and centred inside, opaque material.
It caught two live bugs on its first run.

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
python3 src/gen_textures.py                # tiles + micro-CEILING assertions

# ---- pass-4 diagnosis (these determined the fixes; outputs in build/diag/)
# 1. what is behind the black pixels, and does that geometry carry light?
$BL -b build/market_house_full.blend --factory-startup -noaudio \
    -P build/diag/diag_lowcorner.py
# 2. exact mesh query for coplanar face pairs at the corners  <-- found the cause
$BL -b build/market_house_full.blend --factory-startup -noaudio \
    -P build/diag/diag_facepairs.py
# 3. full chain of surfaces along a sightline                 <-- found the brise
$BL -b build/market_house_full.blend --factory-startup -noaudio \
    -P build/diag/diag_raychain.py
# 4. material histogram of a camera frame                     <-- 0.00 % sky
$BL -b build/market_house_full.blend --factory-startup -noaudio \
    -P build/diag/diag_frame.py
# 5. which way does the rig's sun point?                      <-- north-west
$BL -b --factory-startup -noaudio -P build/diag/diag_sundir.py
# 6. does the clerestory deliver daylight at all?  (renders 4 variants)
$BL -b build/market_house_full.blend --factory-startup -noaudio \
    -P build/diag/diag_daylight.py

# ---- pass-4 proofs consumed by verify.py 18/19/20
$BL -b build/market_house_full.blend --factory-startup -noaudio \
    -P build/diag/diag_lowcorner_v2.py          # -> lowcorner_v2.json
$BL -b build/market_house_full.blend --factory-startup -noaudio \
    -P build/diag/diag_standing_daylight.py     # -> standing_daylight.json
$BL -b --factory-startup -noaudio -P build/diag/diag_sundir_json.py   # -> sundir.json

# ---- pass-3 probes, still run
$BL -b build/market_house_full.blend --factory-startup -noaudio -P build/diag/diag_openings.py
$BL -b build/market_house_full.blend --factory-startup -noaudio -P build/diag/diag_seal.py

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

# diagnostic passes (moderate) then the one canonical final set
$BL -b build/market_house_full.blend --factory-startup -noaudio -P src/render.py -- \
    --out proofs/pass4diag --res 600 --samples 18 --views <subset>
# ... pass4diag2..6 are the successive correction rounds, same command
$BL -b build/market_house_full.blend --factory-startup -noaudio -P src/render.py -- \
    --out proofs/final --res 1100 --samples 64

python3 src/verify.py                      # 191 assertions
```

## 10. Iteration record

1. Blockout + 5 alternatives (`proofs/alts/`); E adopted.
2. Pass 1 — rejected at the human gate (4 contract failures + generic massing).
3. Scheme-E rebuild; pass-2 inspection (27 views) → `CRITIQUE_PASS2.md`.
4. Pass-2 corrections; 27-view final set; **76/76 automated checks passed**.
5. **Pass 3 — rejected at the human gate** (`HUMAN_REVIEW_PASS3.md`): 4 hard
   functional and 6 hard visual failures that the checks could not see.
6. Pass-3 corrections: empirical probes → source repairs → moderate diagnostic
   render (`proofs/pass3diag/`) → further corrections found in those pixels →
   full rebuild → 37-view final set; **141/141 automated checks passed**.
7. **Pass 4 — rejected at the human gate** (`HUMAN_REVIEW_PASS4.md`): 7 art and
   presentation failures, with the explicit instruction that `VERIFY_ALL_OK` is
   not visual acceptance.
8. This pass:
   - **diagnosis first.** `diag_lowcorner` proved the black corner was *not*
     missing geometry; `diag_facepairs` found the coplanar pair that was the
     real cause. My first hypothesis (a ray-stepping duplicate probe) was
     **disproven** by its own output before it cost a wrong fix.
   - **source changes**: lower corner piers, keystone, material floor removal,
     both flanks, the daylight section, trainer identity.
   - **moderate diagnostic render** (`proofs/pass4diag/`) → inspected the pixels
     → found **the keystone buried behind its own step** and **a 1.5 m black
     conduit bar** → source corrections, plus a new build-time assertion that
     caught a **third** buried-lamp instance.
   - four further diagnostic rounds (`pass4diag2..6`), each one measuring
     rather than guessing: the ray chain that found the brise blocking its own
     clerestory, the frame histogram that measured 0.00 % sky, and the sun-vector
     resolve that found the beauty sun had been in the **north-west** for three
     passes.
   - full rebuild from one revision → extended verification (141 → **191**) →
     **46-view canonical final set + contact sheet**, all rendered from the
     shipped build.

## 11. Compromises and open judgements, named honestly

1. **Automated ≠ accepted.** 191/191 is a statement about the checks. Pass 2
   passed 76/76 and was rejected; pass 3 passed 141/141 and was rejected. Both
   times the defect was in the shipped pixels and the checks were looking
   elsewhere. The items below are the ones I judge most likely to draw an
   objection this time.
2. **The brise-soleil cannot both shade this glass and let you see through it.**
   This is the one item I want read carefully, because it is a genuine trade and
   I chose a side. A louvre passes rays shallower than `atan(spacing/depth)` and
   blocks steeper ones; to block a 42° sun the cut-off must be under 42°, and a
   standing eye 1.35 m from the band looks up at 56°. Pass 3's brise hung across
   the aperture and shaded the *view* as effectively as the sun — measured 0.00 %
   sky in the frame. The blades now oversail above the head, which leaves the
   aperture clear and shades only **the band above z 3.894 at a 42° sun (about
   half the aperture at midday, more morning and evening)**. So the clerestory
   is now legible and is **less shaded than the design prose used to claim**.
   The remaining gain is carried by the tinted glazing. If shading matters more
   than legibility, the blades go back in front and the review's item 5 comes
   back with them; the only way to have both is a different section (a tilted or
   north-facing monitor), which is a larger change than this pass should make.
3. **The clerestory is visible, but 35–55 % of sampled rays — not all of them.**
   From the three open-bay standing stations in the aisle, `verify.py` §19
   measures 48 % / 55 % / 35 % of rays landing on the glazing. From under the two
   *dropped plant-bay soffits* it is 25 %, and those soffits are deliberate: the
   BOH ceiling is dropped over the plant bays and open to the north deck between
   them. That station is measured and reported but not required, which is stated
   in the probe rather than averaged away.
4. **No standing station sees raw sky through the glazing** — every ray that
   passes the glass meets the brise soffit above it. The check therefore asserts
   the honest property: every glazing ray **continues outside the envelope**, so
   the glass is an aperture rather than a panel. A "sees sky" assertion could
   only be passed by deleting the sunshade.
5. **The corner still goes dark when raked from the far side.** In
   `35_crop_corner_sealed_ne` the darkest column is 4.33 % grey. That crop lights
   a north-east corner from the north-east, so the two faces meeting there are at
   grazing incidence by construction. Raked from its own side
   (`39_crop_lowcorner_ne`) the same corner's darkest column is 2.71 % — still
   the darkest thing on the elevation, because a chamfered recess in dark basalt
   is *supposed* to be. What is gone is the true void: the coplanar pair, the
   0.002 luminance, and the 0.34 m wide band that had no light path at all.
6. **The public facade has been in shade in every proof before this one.** I did
   not notice for three passes and no check looked. It is fixed and asserted now
   (§20), but it is worth stating plainly that the renders you were shown of this
   building's front elevation were all lit from behind it.
7. **Interior proofs render at full sky strength (1.0) where exteriors use
   0.55.** This is a rig choice, not asset data. It is defensible because the
   light now enters through the real glazing — `diag_daylight.py` measures 3.25×
   over emissive-only — but a runtime with dimmer ambient will show a darker
   back-of-house than these images.
8. **Interior lighting in the proofs is still rig lighting** for the authored
   fixtures. The GLBs contain no lights, only emissive materials. The pass-3
   report noted a rig lamp masking a buried luminaire; that class of bug is now a
   build-time assertion (`assert_not_buried`), which caught two more instances.
9. **The BOH corridor is 1.00–1.12 m**, a working service corridor rather than a
   comfortable route. The east end beyond x 3.68 is a working recess, furnished
   as such.
10. **LOD0 is 6.66 MB.** It went *down* from 7.03 despite +8,552 triangles,
    because flat base-colour maps compress well. `KHR_mesh_quantization`, Draco
    or KTX2 would cut it much further, but each adds a runtime extension
    dependency I cannot verify against this client, so the payload is plain.
11. **Eight of the twelve optional props were omitted** for missing provenance,
    so the market is furnished mostly with authored geometry.
12. **The furnished GLB still emits Blender sampler warnings** from the imported
    terminals' own material graphs, which I may not modify. All four shipped GLBs
    validate with **0 errors and 0 warnings** under `gltf-transform validate`.
13. **The second UV set exists only in the `.blend`**, not in the GLBs.
14. **The settlement still has no name.** The rejected one was not restored and
    no replacement was invented, per the brief.
