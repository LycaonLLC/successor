# Dustgate Redesign — Direction Record

Status: source-stage study, 2026-07-29. Not integrated, not canonical, not
runtime-proven. This record documents a from-zero direction study run under
`docs/DUSTGATE_OPUS5_REDESIGN_BRIEF.md`. No existing Dustgate GLB, builder
script, texture, or render was opened, imported, traced, or used as reference.

Proof root (git-ignored): `verification/ledgers/artifacts/dustgate-opus5-20260729/`

> **Superseded in part by the production pass.** This record is the direction
> study and its measured visual rules still stand. Its geometry, pivots, part
> counts and material handling do not: the buildings were rebuilt as standalone
> products in structure-local coordinates, with real UV0, PBR textures, bevels,
> LODs, manifests, `successor.structure-collision.v3` sidecars and an addressable
> `door_slide` contract. See `PRODUCTION_RECORD.md`, whose section 1 lists every
> change and the reason for it. Where the two disagree, the production record
> and the artifacts under
> `verification/ledgers/artifacts/dustgate-opus5-production-20260729/` win.

## 1. The three direction studies

All three were built from freshly generated primitives and rendered through the
same north-up orthographic camera (yaw 0, pitch 60, frustum 34 cells) with the
same 1.75 m capsule proxy, plus a matching plan view and a 12.5-cell gameplay
frame. Files: `directions/dir_{a,b,c}_{wide,plan,gameplay}.png`.

| | A — Leeward Terrace | B — Dust Well | C — Frame Ward |
| --- | --- | --- | --- |
| Composition | linear, in the lee of one ancient windbreak | radial, around a shallow sink | dispersed, tall sheds on plinths |
| Silhouette | low horizontal masses on a shared eave datum | half-buried cast drums with conical caps | barrel vaults, gables, masts |
| Interior | one long open bay per building | hearth-centred radial | ground floor plus mezzanine |
| Material/value | bone panel, dark reveals, cool ancient stone | monolithic pale cast, oxide caps, low contrast | dark exposed frame against bright canvas |
| Measured | 84 meshes, 3,574 tris, 11 materials | 70 meshes, 5,700 tris, 9 materials | 110 meshes, 4,158 tris, 10 materials |

### Why A was selected

A wins on evidence, not taste alone:

1. **Runtime contract fit.** The renderer's cutaway reveal set is
   `["roof__", "wall_front__", "wall_right__"]` (`client-3d/src/render/props.ts`,
   `props-mapping.json`, `props.cutaway.test.ts`). Orthogonal wall sets are a
   precondition. B's drums have no front/right/back/left wall families at all,
   so B could not be authored for the existing cutaway without inventing a
   second scheme.
2. **Collision and cell fit.** Structure collision is axis-aligned rectangles
   and `terminal_cells_kept_clear` reserves integer cells. A's rectangular
   shells map 1:1. B's circular shells would be approximated by boxes and waste
   interior cells.
3. **No terrain dependency.** B needs an excavated sink. Terrain is
   fixture-owned; a direction that requires terrain authorship to read at all is
   a worse first milestone.
4. **One place built over time.** A's shared eave datum with three different
   masses reads as one culture. C's dispersed stilted sheds read as a transient
   camp and its plinths/stilts fight ground contact and cell-aligned floors.

### What the rejected studies contributed

B and C were not discarded whole. Two rules were carried into A:

- **From B:** the roof plane must carry structure, not just colour. B's conical
  caps and lantern were the only roofs in the study that read as *form* at
  gameplay zoom. A's roofs were rebuilt around this.
- **From C:** exposed structural members (ribs, ties, fascia) give a roof its
  scale. A's fascia bars, upstands, and battens come from this observation.

## 2. Measured visual rules

These are derived from the renders, not asserted. All are enforced by `qa.py`.

**Roof-first.** At pitch 60 the roof is roughly nine tenths of a building's
pixels at gameplay framing. The first pass proved this hard: three pale roof
slabs on pale sand produced no silhouette at all
(`directions/dir_a_wide.png`).

- Rule: **the roof is the darkest large field and the ground is the lightest.**
  Measured ladder (sRGB relative luminance, `qa.json.value_ladder`):
  sand 0.431 > canvas 0.351 > panel 0.268 > roof_patch 0.128 > ancient 0.116 >
  panel_shade 0.091 > ancient_deep 0.055 > steel 0.050 > roof 0.029 >
  reveal 0.011.
- Rule: **no unbroken roof value field wider than 3.2 m.** Every roof is split
  into structural bays by upstands, fascia bars, battens, or sawtooth risers.

**The eave shadow rule.** This was the decisive measurement. Under the locked
pitch, an eave of height `h` with overhang `o` hides every ground point from `o`
south of the wall to `h / tan(60) - o` north of it. For the commerce eave that
is 1.88 m; for the clone eave 2.30 m.

- Consequence: **a threshold flush with the wall cannot be seen.** The first
  build's commerce threshold crop showed no door, no jamb, and no ground contact
  — the eave and the shade sails ate the entire facade.
- Rule: **south eave overhang stays at or under 0.55 m**, and every threshold
  projects past the eave shadow line. The wind lock does this: two return walls
  1.3–1.5 m deep, a head beam above head height only, and a raised pale sill
  whose southern 0.95–1.00 m strip is always open to the sky. Measured per
  structure in `qa.json.structures[].threshold`.
- Rule: **shade structures flank thresholds, never cover them.** The commerce
  sails were moved off the door for exactly this reason.

**Camera-facing function.** Every roof step, riser, louvre, vent, and monitor
face points SOUTH. The clone sawtooth was authored with its ridge at each bay's
*south* edge falling north precisely so the riser faces are camera-facing; the
opposite orientation self-hides all three of them.

**Repetition is noise.** The first louvre pass put six oxide bars per riser and
seven on the monitor; at gameplay zoom that read as decorative dashes and as the
loudest thing in the settlement. Reduced to three hooded panels per riser and
one recessed vent band with two mullions on the monitor.

**No route furniture.** The first travel terminal was a mast with two horizontal
cross-arms. In the south elevation it read unmistakably as a roadside utility
pole, which this setting does not have. Replaced with a squat drum beacon: base
drum, steel band, oxide head, amber lens, angled dish, total 2.78 m.

## 3. Palette and material families

Eleven materials in the exported review GLB, all flat Principled, no textures
yet, all single-sided (`doubleSided: false` confirmed by
`@gltf-transform/cli inspect`).

| Family | Hex | Role |
| --- | --- | --- |
| `DG_sand` | `#c1ad8d` | ground; the lightest field in the scene |
| `DG_canvas` | `#ab9f85` | sails, battens, upstands, wind lock sills, annex cap |
| `DG_panel` | `#9a8c72` | human wall panel, pod shells, monitor body |
| `DG_roof_patch` | `#6d6355` | mismatched replacement roof panels only |
| `DG_ancient` | `#5f6060` | ancient stone mass; cool, so it never shares hue with human panel |
| `DG_panel_shade` | `#5c5449` | wall bases, plinths, wind lock returns, furniture |
| `DG_ancient_deep` | `#414341` | deep reveals between ancient piers |
| `DG_steel` | `#413f3a` | fascia, ties, jambs, hoops, gantry, floor slabs |
| `DG_roof` | `#332f2a` | primary roof metal; the darkest large field |
| `DG_reveal` | `#1d1a17` | recessed vents, glazing, deep shadow slots |
| `DG_oxide` | `#8d4a2b` | the one functional accent per building |

Human work is warm; ancient work is cool. That keeps the two scales separated by
hue as well as value, so neither reads as the other after posterisation.

## 4. The shared kit

One kit, three buildings, meaningful variation rather than cloned boxes:

- **Shell:** 0.30–0.35 m wall panel, `wall_back__` / `wall_left__` /
  `wall_right__` / `wall_front__` families, a `panel_shade` base band, and a
  chamfered `steel` floor slab with a 0.10 m flare for ground contact.
- **Wind lock:** two return walls plus a head beam and a raised sill. Identical
  parametrisation, three depths (1.5 / 1.5 / 1.3 m), all with a 3.00 m clear
  span against a 1.80 m door.
- **Facade articulation:** a `steel` panel-joint band at 2.35 m and two hooded
  recessed low vents, sized off the wind lock returns.
- **Roof language:** 0.18–0.24 m slab depth, a `steel` fascia at every high
  edge, `canvas` upstands or battens dividing bays, and `roof_patch` replacement
  panels.
- **Door:** `door_slide` panel 1.95 m wide, local axis `[-1, 0, 0]`, travel
  1.95 m, plus an over-door rail. Identical in all three.
- **Accent:** one `oxide` functional element and one `amber` signal per
  building.

### One memorable read per function

| Function | Read | Measured |
| --- | --- | --- |
| Cloning | three-bay sawtooth roof with south-facing louvred risers, a bank of three clone drums bulging through the west wall, an overhead hoist gantry projecting south past the eave, and a 7.6 m exhaust stack — the settlement's only vertical accent | 83 nodes, 2,196 tris, 11.36 × 10.64 × 8.44 m, walkable 67.89 m² |
| Exchange | east-west ridge under a louvred monitor, four upstand bays with the two western bays re-skinned in a lighter panel behind a raised flashing bar, two shade sails flanking the threshold, and a strongroom annex welded to the east gable | 86 nodes, 1,624 tris, 15.77 × 11.72 × 6.82 m, walkable 93.79 m² |
| Shelter | a single north-falling pitch draining into a gutter, downpipe, and hooped cistern drum; lowest and smallest mass | 43 nodes, 1,036 tris, 8.36 × 7.87 × 3.79 m, walkable 29.16 m² |

Three interior terminal reads are distinct by form, not label: the bank terminal
carries a strongbox head with a wheel, the trade terminal a balance column with
two pans, the PA terminal a tall banner mast.

## 5. Texture, UV, and LOD plan

Recorded in `qa.json.texture_and_lod_plan`.

- One 2048 trim atlas (albedo/roughness/normal) per settlement kit: panel, roof
  metal, canvas, cast plinth, steel, oxide. Ancient stone gets its own 1024
  tiling set so the two scales never share texel density.
- Box-projected trim UVs on a shared 0.5 m texel grid; no per-object unwrap.
  **Overlapping UVs are intended** for repeated kit parts (roof bays, louvres,
  battens, piers) and must not be lightmapped. Only floors and the ancient wall
  would get a second non-overlapping channel if baked AO is ever wanted.
- LOD0 as authored. LOD1 drops louvres, hoods, battens, hoops, mullions, rubble,
  and roof patch plates, and merges each roof bay set into one slab (target ~45
  percent triangles); the web renderer ships LOD1 as its base. LOD2 keeps shell,
  roof silhouette, wind lock, stack, and cistern only.

## 6. Node families

Exported census (`qa.json.export.node_families`): `roof__` 59, `interior__` 44,
`mass__` 44, `wall_front__` 35, `ancient__` 19, `floor__` 12, `prop__` 8,
`wall_back__` 6, `door_slide__` 6, `wall_left__` 3, `wall_right__` 3.

`mass__` is a new declared family for non-enterable attached exterior masses:
the strongroom annex, hoist gantry, wind lock returns, cistern, sails, and their
posts. It exists because the first cutaway pass hid the strongroom annex — it
had been named `wall_right__`, so revealing the camera-facing walls punched a
hole in the exterior silhouette. Anything outside the reveal prefixes is already
classified "keep" by the existing runtime classifier, so `mass__` needs no
renderer change.

The combined review GLB suffixes door nodes (`door_slide__clone`) because
Blender object names must be unique. The three per-structure GLBs each carry the
exact node name `door_slide`.

## 7. Rejected alternatives inside the selected direction

- **Deep veranda over the commerce door** (2.05 m eave). Killed by measurement:
  it hid the entire facade and threshold.
- **Heavy threshold piers at eave height.** At pitch 60 a 4.3 m pier reads as a
  small dark block on the roof edge, not as a jamb. Replaced by the lower wind
  lock returns.
- **Pale roofs with dark reveals.** No silhouette against pale sand. Inverted.
- **Shelter storm-porch canvas slab.** Read as a blank floating card and hid its
  own threshold. Replaced by the wind lock.
- **Mast-and-cross-arm travel terminal.** Reads as route furniture. Replaced.
- **Sunken plaza (direction B's sink).** Requires terrain authorship the study
  is not allowed to own.

## 8. Honest compromises and open risks

- **Cutaway lighting, not geometry.** With the reveal set hidden, retained
  `mass__` elements (gantry, wind lock head, sails) cast sun shadows straight
  onto the interior floor — visible in `packet/08_cutaway_clone.png`. Promotion
  must either keep a shadow-only proxy for the hidden roof or exclude attached
  masses from shadow casting while a cutaway is active. Recorded in
  `qa.json.known_risks`.
- **This is a blockout.** No textures, no UV authoring, no LODs, no collision
  sidecar, no manifest, no animation. Door travel is declared numerically but
  not animated.
- **The layout carries no world origin.** It is a local 40 × 28 cell block.
  Placing it, and reconciling it with the fixture's authored cell positions, is
  the integration pass's job.
- **Ids are `study-` prefixed on purpose.** Nothing here claims a canonical id.
- **The settlement is 38.5 m wide** against a 22-cell gameplay viewport, so it
  is deliberately about two screens across. That is a composition choice, not an
  oversight, but it has not been tested against camera follow or AOI.
- **Not runtime-proven.** No fixture, Rust collision, packaging, or in-engine
  frame has been produced. Every claim here rests on Blender measurement,
  glTF Transform inspection/validation, and the rendered proof packet.

## 9. Reproduce

```
cd tools/successor/assets/dustgate-redesign
python3 layout.py                                  # validate + emit layout JSON
blender -b -P directions.py -- a                   # and -- b, -- c
blender -b -P build_selected.py -- all             # blend + review GLB
blender -b -P build_selected.py -- structures      # per-structure GLBs
blender -b -P qa.py                                # numeric QA report
blender -b -P proof.py                             # proof packet from the export
cd ../../../../verification/ledgers/artifacts/dustgate-opus5-20260729/glb
npx --yes @gltf-transform/cli inspect  dustgate_selected_review.glb
npx --yes @gltf-transform/cli validate dustgate_selected_review.glb
```
