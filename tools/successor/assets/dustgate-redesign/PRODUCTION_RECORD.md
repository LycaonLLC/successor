# Starting-Settlement Production Pass — Record

Status: source-stage production pass, 2026-07-29. **Not integrated, not
canonical, not runtime-proven.** Nothing here has been written into
`client-3d/public/assets/world-items/`, `props-mapping.json`, the generated
fixture, Rust authority, or the Electron package. Every claim below rests on
Blender measurement, the repository's own collision transformer, Khronos
validation, and rendered proof.

Artifact root (git-ignored):
`verification/ledgers/artifacts/dustgate-opus5-production-20260729/`

Editable source: `tools/successor/assets/dustgate-redesign/`

---

## 1. What changed from the first study, and why

The first pass (`DIRECTION_RECORD.md`) was an honest massing study. Its layout
measurements and camera discoveries survived; almost nothing else did.

| First study | Production pass | Reason |
| --- | --- | --- |
| Authored in settlement space; door pivots reported at `8.9` and `21.5` | Authored in **structure-local** space; every unit's origin is its own footprint centre and its ground contact is exactly local Y = 0 | A settlement-space pivot is not a standalone-origin contract. `bakeGlb` recentres X/Z on the measured GLB bounds, so a unit whose origin is elsewhere silently disagrees with its own sidecar. |
| 84–110 one-cube meshes per direction | 39–44 consolidated parts per unit, joined by functional family and material under family empties | Enterable entries build **one `Mesh` per part per instance** (`buildEnterableInstances`), so part count *is* draw-call count. The renderer classifies on the mesh **or any ancestor**, so an empty named `roof__` addresses a consolidated mesh just as well as 30 cubes. |
| Flat Principled colours, no UVs, no textures | Real UV0 by world-aligned box projection on a shared 0.5 UV-units/metre grid; 8 procedural PBR sets (albedo / normal / packed ORM) at 1024², 512 texels/m | Required for HDRP; measured and reported per unit in `qa/*_build.json.uv`. |
| No bevels | Every hard arris chamfered (2-segment, 35° angle limit, clamped) then triangulated | At a locked 60° pitch a flat-shaded box returns no specular edge information. Bevels are the single largest visual difference between round 1 and the final frames. |
| Door travel declared numerically, not animated | `door_slide` node, `door_open` / `door_close` translation clips, measured travel, closed-pose blocker, numeric open/closed proofs | See §4. |
| No manifest, no sidecar, no LODs | Per unit: `.blend`, LOD0/LOD1/LOD2 GLB, manifest, `successor.structure-collision.v3` sidecar, QA report, proof packet | See §3 and §6. |

`Dustgate` remains the legacy mechanical label. The proposed replacement
display name is recorded separately in `NAMING_RECORD.md`; **no id, path, key,
test or protocol value is renamed in this lane.**

---

## 2. The coordinate and origin contract

Authored in Blender Z-up, exported with `export_yup=True`:

```
Blender +X  ->  glTF +X    structure right   (world east at yaw 0)
Blender +Z  ->  glTF +Y    up, ground contact at exactly 0
Blender -Y  ->  glTF +Z    structure FRONT   (world south at yaw 0)
```

Every sidecar box is produced by `prodkit.to_gltf_xz`, never typed by hand.
The declared footprint is asserted equal to the exported XZ bounding box, and
`prodbuild` fails the build naming the offending part if any geometry leaves
it — because a footprint that disagrees with the mesh silently rescales every
collision box at bake time.

Measured, from the reloaded exports:

| Unit | Cells | Exported span X × Z × Y (m) | Ground contact Y | Origin offset XZ | Uniform runtime fit |
| --- | --- | --- | --- | --- | --- |
| clone | 12 × 10 | 11.400 × 9.500 × 7.160 | 0.0 | 0, 0 | 1.0526316 |
| commerce | 14 × 11 | 13.300 × 10.450 × 5.700 | 0.0 | 0, 0 | 1.0526316 |
| shelter | 8 × 7 | 7.600 × 6.650 × 3.720 | 0.0 | 0, 0 | 1.0526316 |

All three share one fit, so they read as one build culture at one scale. That
is a design constraint, not a coincidence: the spans were chosen from the cell
counts.

---

## 3. Deliverables per unit

```
units/<uid>.blend                  editable deterministic source checkpoint
glb/<uid>_lod0.glb                 textured PBR, tangents, door clips
glb/<uid>_lod1.glb                 maps-free web base
glb/<uid>_lod2.glb                 maps-free distant silhouette
manifests/<uid>_manifest.json      building manifest
manifests/<uid>_collision.json     successor.structure-collision.v3
qa/<uid>_build.json                measured build + export report
proof/final/<uid>/*.png            16-frame proof packet
```

### Why LOD1 and LOD2 ship maps-free

`convertMaterial` in `client-3d/src/render/props.ts` routes **any** material
carrying a `map` to an unlit `MeshBasicMaterial`, and maps-free materials to the
authored `MeshMatcapMaterial` path. A fully textured GLB therefore renders flat
and unlit in the Three client while importing correctly into HDRP. So LOD0 is
the textured product for Unity/HDRP and LOD1 — the web base — carries the same
silhouette with maps-free palette materials the matcap path shades properly.
This is a deliberate, recorded split, not an omission.

Measured LODs (`qa/*_build.json.lods`):

| Unit | LOD0 tris / parts | LOD1 tris / parts | LOD1 fraction | LOD2 tris / parts | LOD2 fraction | Silhouette span delta at LOD2 |
| --- | --- | --- | --- | --- | --- | --- |
| clone | 29,140 / 44 | 18,072 / 40 | 0.620 | 5,080 / 19 | 0.174 | −0.02 X, −0.14 depth, 0 height |
| commerce | 20,268 / 39 | 13,168 / 35 | 0.650 | 3,744 / 17 | 0.185 | 0, 0, 0 |
| shelter | 15,456 / 40 | 10,680 / 35 | 0.691 | 3,740 / 17 | 0.242 | 0, −0.19 depth, 0 |

Every LOD retains a `floor__` mesh and a `door_slide` mesh
(`keeps_door_floor_opening: true`), so no LOD can break the functional
contract. LODs are generated by rebuilding from the same deterministic source
at a detail cap (`CORE` / `MID` / `FINE`), not by decimation, which is why the
door, floor, opening and collision silhouette are preserved by construction
rather than by luck.

---

## 4. The sliding-door contract

One leaf, surface-hung on the outside face of the front wall, running on an
exposed top track and parking over blank wall. **Not bi-part:** `advanceDoors`
translates the whole door node rigidly along one axis, so two leaves would be
driven the same direction and shear the opening.

Measured (`qa/*_build.json.door`), all in glTF metres:

| | clone | commerce | shelter |
| --- | --- | --- | --- |
| Node | `door_slide` | `door_slide` | `door_slide` |
| Slide axis (local, normalized) | `[-1, 0, 0]` | `[-1, 0, 0]` | `[-1, 0, 0]` |
| Travel | 3.280 | 3.700 | 1.960 |
| Clear opening (w × h) | 2.60 × 2.39 | 3.00 × 2.44 | 1.30 × 2.08 |
| Leaf span | 2.94 | 3.38 | 1.60 |
| Closed: opening coverage | 2.60 (full) | 3.00 (full) | 1.30 (full) |
| Closed: leaf ∩ blocker | 2.94 | 3.38 | 1.60 |
| Open: clearance past the jamb | +0.510 | +0.510 | +0.510 |
| Open: fouls | none | none | none |
| Open: laps onto | `front_wall_left`, 2.94 | `front_wall_left`, 3.38 | `front_wall_left`, 1.60 |
| Exported node translation | `[0, 0.16, 4.58]` | `[0, 0.16, 5.055]` | `[0.6, 0.16, 3.215]` |

Travel is **derived, not typed**: it is `leaf_x1 − pier_x0 + 0.09`, i.e. sized
to clear the west jamb pier plus a service gap, because a travel sized on the
clear opening alone parks the leaf through the pier.

Blocker state, matching `client/src/slice-core/worldQueries.ts`:
closed → `prop.door.blocker` is an active movement blocker; open →
disabled when `serverAuthority.propStates[propId].doorOpen === true`. The
threshold is measured clear at the player radius when open and blocked when
closed, in all three units.

`door_open` / `door_close` are authored as NLA-stashed translation clips for
interchange parity. **The Three runtime never evaluates them** — it drives the
node directly from `axisLocal * distance` — and the record says so in the
manifest.

### Two real defects this lane caught and fixed

1. **The exporter baked the door OPEN.** Blender's glTF exporter samples every
   NLA action to emit the clips, then writes the node TRS from the sampled
   state. The authoring scene stayed closed through export (verified by
   printing the object location at every step) and only the *file* came out
   open. Fixed by giving each strip `extrapolation = "NOTHING"`, placing them
   off frame 1, and patching the exported node translation directly in the GLB
   JSON chunk (`prodkit.force_node_translation`).
2. **The importer re-posed it on load.** `bpy.ops.import_scene.gltf` builds
   actions for the imported clips and leaves objects posed on one, so a
   freshly imported unit *looked* open even once the file was right. Both the
   verification step and the proof renderer now call
   `prodkit.rest_pose_from_glb`, which restores what the file actually says and
   drops the imported animation.

Round 2's `08_door_closed.png` shows the empty opening this produced. Round 3's
shows the leaf. That is the single most valuable thing the iteration rounds
bought.

---

## 5. Why the entry bay is the southernmost mass

Measured, not asserted. Under the locked north-up 60° camera, an element of
height `h` standing `d` metres south of a target hides that target when
`h > target_top + d·tan(60°)`. A 4.5 m eave with a 0.5 m overhang therefore
hides a 2.45 m door head standing 0.5 m behind it
(`2.45 + 0.5 × 1.732 = 3.32 < 4.5`).

So recessed porches, deep verandas and full-width eaves over the threshold are
all invisible at this pitch — which is exactly what the first study's commerce
threshold crop showed. The rule enforced in `produnits.entry_bay` and re-derived
in `qa/*_build.json.camera` is:

```
hood_top < door_head + hood_overhang · tan(60°)
```

| Unit | Door head | Hood overhang south | Hood top | Occlusion limit | Margin |
| --- | --- | --- | --- | --- | --- |
| clone | 2.55 | 0.24 | 2.850 | 2.966 | +0.116 |
| commerce | 2.60 | 0.24 | 2.900 | 3.016 | +0.116 |
| shelter | 2.24 | 0.18 | 2.472 | 2.552 | +0.080 |

The clone consequently grew a low flat **entry deck** at 3.24 m in front of the
sawtooth: it is what lets the first sawtooth bay start far enough north for its
2.18 m camera-facing louvred riser to be fully visible instead of self-hidden.

---

## 6. Collision, clearance and egress

Sidecars are `successor.structure-collision.v3`, emitted with the repository's
formatting convention (`indent=2`, `sort_keys=True`, trailing newline, metres
rounded to 4 dp).

`prodsidecar.mjs` drives the **repository's own**
`tools/successor/structure-collision-geometry.mjs` over all three sidecars at
0/90/180/270, re-deriving the door approach points the fixture generator would
bake:

```
clone     walls  7  furniture 11  regions 1  floorTopM 0.16842  door 3094x463 milli  interior/exterior clear true/true
commerce  walls  7  furniture 12  regions 1  floorTopM 0.16842  door 3558x463 milli  interior/exterior clear true/true
shelter   walls  7  furniture  6  regions 1  floorTopM 0.16842  door 1685x421 milli  interior/exterior clear true/true
```

Every baked box is integral, non-negative and inside the prop rect (Rust
clamps silently otherwise); wall and region counts are rotation-invariant; the
doorway exceeds the 900-milli safe diameter at every rotation; and every
`contract.terminal_cells_kept_clear` cell is free of walls, furniture and the
closed door.

### Egress is searched, not drawn

The first study shipped a skipped/blocked `front_cell` as a pass. That is a QA
defect, so this lane replaced hand-drawn waypoints with a breadth-first search
over a 0.10 m occupancy grid swept at the 0.30 m player radius against every
structural wall, built-in mass and instanced item, from an exterior target
outside the threshold.

| Anchor | Unit | Clear at player radius | Clear with equipment envelope | Route |
| --- | --- | --- | --- | --- |
| `clone_respawn_point` | clone | yes | yes | 7.40 m |
| `clone_terminal_use` | clone | yes | yes | 10.10 m |
| `clone_pod_use_centre` | clone | yes | yes | 7.40 m |
| `bank_terminal_civic` | commerce | yes | yes | 11.60 m |
| `trade_terminal` | commerce | yes | yes | 8.10 m |
| `pa_terminal` | commerce | yes | yes | 11.40 m |
| `trainer_npc` (Knox Vale) | commerce | yes | yes | 11.10 m |
| `shelter_interior_stand` | shelter | yes | yes | 4.60 m |

The equipment envelope is 0.86 × 0.62 m, taken from the widest promoted pawn
plus shouldered equipment. Interior clear heights are 3.46 m (clone), 2.94 m
(commerce) and 2.40 m (shelter) against the 1.75 m proxy. Walkable interior
regions are 81.3 / 108.2 / 30.5 m².

The search found two real interior-program faults during the pass: the
commerce strongroom face walled off the PA counter's approach (moved east of
x = 4.95), and the trainer station sat inside a blocker (moved to 4.20, 0.55).

---

## 7. Node families and the cutaway

Exported family census (`qa/*_build.json.census.node_families`):

| Family | clone | commerce | shelter | Cutaway class |
| --- | --- | --- | --- | --- |
| `floor__` | 4 | 4 | 4 | keep (hard override) |
| `interior__` | 7 | 6 | 4 | keep |
| `mass__` | 8 | 5 | 7 | keep (non-reveal) |
| `wall_front__` | 5 | 5 | 5 | reveal |
| `wall_right__` | 5 | 3 | 5 | reveal |
| `wall_back__` | 3 | 3 | 3 | keep |
| `wall_left__` | 3 | 3 | 4 | keep |
| `roof__` | 5 | 6 | 4 | reveal |
| `door_slide` | 4 | 4 | 4 | door (hard override) |

`prodproof.apply_cutaway` reproduces `classifyEnterablePart` exactly —
door > floor > reveal > keep, matched on the mesh or any ancestor — against the
shipped reveal set `["roof__", "wall_front__", "wall_right__"]`. Measured on the
reloaded exports: 15/14/14 meshes hidden, 29/25/26 retained, and floor, door and
interior retention are asserted true for all three units before the packet is
accepted.

`mass__` exists because a camera-facing attached mass named `wall_right__`
would be punched out of the exterior silhouette when the cutaway fires. It
needs no renderer change: anything outside the reveal prefixes is already
classified keep.

**Cutaway shadow fix, not workaround.** The first study recorded retained
`mass__` elements casting sun shadows across the revealed floor. The production
entry bay, track hood, sill and service masses are all *outside* the shell, so
their shadows fall on the threshold rather than the interior. The one element
still overhead is the clone's exhaust stack; its shadow is visible in
`proof/final/clone/15_cutaway.png` and is recorded as a remaining risk, not
claimed as solved.

---

## 8. Material and UV plan

Eight materials per unit, one atlas set each, all sharing one texel density.

| Family | Role | Textured |
| --- | --- | --- |
| `KIT_panel` | ribbed steel wall cladding, 0.5 m ribs, one panel joint | yes |
| `KIT_roof` | standing-seam roof metal, 0.5 m seams, oxide pooling | yes |
| `KIT_canvas` | woven storm fabric: upstands, sills, patches, dado | yes |
| `KIT_plinth` | cast footing and floor deck, form-board lines | yes |
| `KIT_steel` | structural plate: fascia, pilasters, purlins, door | yes |
| `KIT_oxide` | the one functional accent per building | yes |
| `KIT_reveal_flat` | recessed vents, glazing, deep slots | solid, by design |
| `KIT_amber_flat` | the one signal per building | solid + emissive |

Plus `KIT_ancient` and `KIT_sand`, used only by the settlement test bed.

UV0 is a per-polygon planar projection onto the plane of each face's dominant
normal, at `1 / 2.0 m` UV units per metre and 512 texels/m. Because every unit
is authored at identity transform in structure-local metres, mesh coordinates
*are* the projection coordinates, so texel density is uniform across all three
buildings and adjacent parts continue each other's pattern. Measured UV-area to
mesh-area ratio is 0.228–0.263 across every part in every unit — a tight band,
which is the check that no part is stretched.

**Overlapping UVs are intentional** for repeated kit parts and these must never
be lightmapped. Only a floor or the ancient mass would need a second
non-overlapping channel if baked AO is ever wanted.

---

## 9. Validation

`prodvalidate.mjs` runs glTF Transform `inspect` and Khronos `validate` on all
nine outputs and parses each GLB's own JSON chunk.

| file | triangles | primitives | materials | textures | animations | errors | warnings |
| --- | --- | --- | --- | --- | --- | --- | --- |
| clone_lod0.glb | 29140 | 44 | 8 | 18 | 2 | 0 | 0 |
| clone_lod1.glb | 18072 | 40 | 8 | 0 | 0 | 0 | 0 |
| clone_lod2.glb | 5080 | 19 | 6 | 0 | 0 | 0 | 0 |
| commerce_lod0.glb | 20268 | 39 | 8 | 18 | 2 | 0 | 0 |
| commerce_lod1.glb | 13168 | 35 | 8 | 0 | 0 | 0 | 0 |
| commerce_lod2.glb | 3744 | 17 | 5 | 0 | 0 | 0 | 0 |
| shelter_lod0.glb | 15456 | 40 | 8 | 18 | 2 | 0 | 0 |
| shelter_lod1.glb | 10680 | 35 | 7 | 0 | 0 | 0 | 0 |
| shelter_lod2.glb | 3740 | 17 | 5 | 0 | 0 | 0 | 0 |

It took two corrections to get there:

- The first tangent-free export raised **101**
  `MESH_PRIMITIVE_GENERATED_TANGENT_SPACE` warnings, because normal-mapped
  materials without tangents leave the tangent basis to each runtime. Fixed by
  `export_tangents=True`.
- That exposed **7 `ACCESSOR_VECTOR3_NON_UNIT` errors** on commerce: bevelling
  thin members left slivers whose triangles have no area, so the exporter wrote
  zero-length tangents. Fixed by welding and dissolving degenerate geometry
  before triangulation (`prodkit._clean`), which also removed 16 dead triangles.

Every mesh in every file has `TEXCOORD_0`; all textures are embedded; LOD0 files
carry exactly two animations and exactly one node named `door_slide`; LOD1 and
LOD2 carry none.

---

## 10. Iteration rounds

Three visible build → measure → render → close-inspection rounds per building,
each with a recorded correction. All frames from the *reloaded* export, never
from the authoring scene.

**Round 1** (`proof/r1/`) — first full export.
Found by inspecting the frames:
- roof upstands were authored as horizontal bars at ridge height, so they flew
  off every falling roof plane as loose sticks;
- the clone's entire pod-bank read was buried under the eave and invisible from
  the gameplay camera;
- the revealed interior was near-black: dark steel floor slab, dark plinth wall
  lining, and 0.17 m purlins that became the loudest thing in the room;
- roof patches read as pale decals painted on the slope;
- the threshold crop was occluded by its own scale proxy.

**Round 2** (`proof/r2/`) — corrections applied:
sloped upstands that terminate at the roof edge; a roof maintenance walkway as
the one legible light band; roof patches given real lapped steel edges; roof cut
back 0.10 m west of the clone shell so the pod bank is open to the sky; sawtooth
ridge datum raised to 5.42 m with a 1.24 m fall so risers carry real louvres;
pale cast floor deck with steel service bands; pale canvas dado over a shaded
skirt; purlins reduced to 0.05 m; render-only interior practicals; proxy moved
beside the opening. Inspecting *these* frames found the door defect in §4:
`08_door_closed.png` showed an empty opening.

**Round 3** (`proof/r3/`) — door pose fixed at both ends (exporter and
importer), plus a reload gate that fails the build if the exported leaf is not
at its closed pose. `08_door_closed.png` now shows the leaf, its kick plate,
rail, vision slot and pull; `10_door_open.png` shows a clear opening and the
sill.

**Final** (`proof/final/`) — re-rendered from the current exports after the
tangent and degenerate-geometry fixes. Inspecting the shelter's three-quarter
frame found one more real fault: the 1.18 m west service-bay roof cantilever
had nothing under it, which reads as a rendering trick rather than something a
resident built. Three posts on cast pads with knee braces back to the wall head
were added (+1,188 triangles), and the packet re-rendered.

Per unit the packet is: four cardinal elevations, plan, three-quarter, gameplay,
door closed/half/open, threshold crop, contact crop, functional-detail crop,
worst seam crop, cutaway, cutaway at gameplay framing.

---

## 11. The settlement test bed

`prodassemble.py` is a **layout, compatibility and art-direction test bed, not
an asset.** Each building is imported from its own exported GLB and placed at a
map transform reproducing `composePlacement`
(`scale = min(cellsX/spanX, cellsZ/spanZ)`). Mesh datablocks are shared; nothing
is joined or baked; `assembly.json` records `joined_or_baked: false` and the
sha256 of every source GLB.

Local block is 42 × 32 cells, `+x` east, `+y` south, origin at the north-west
corner. Placements: clone at (4, 6) 12×10, commerce at (20, 5) 14×11, shelter at
(9, 21) 8×7, all at fit 1.0526316.

Instanced from real assets, never re-modelled: the promoted travel terminal —
with the `[-90, 0, 0]` asset rotation the mapping applies, without which it lies
flat on the sand — promoted clothed and bare pawns at spawn, at Knox Vale's
station and as residents, a promoted vibrosword for equipment scale, the three
clone pods, the clone/bank/trade/PA terminals, the frontier footlocker, Grok
cargo crates, battery bank, folding workbench, tool cabinet, water tank, and
three extraction skids tested **outdoors at their real size**, because the audit
verdict is that those are site equipment and shrinking them to dress a room was
explicitly rejected. The skids now stand as a loose yard on the open desert east
of commerce — (36.8, 9.4) yaw 24°, (39.4, 12.9) yaw −38°, (36.2, 14.8) yaw 112°
— non-collinear and at unrelated yaws. Round 1 of this pass stacked all three in
the four-cell alley between the clone and commerce units at 2.8-cell spacing,
which crowded the only direct link between the two buildings and read as a
service lane; the alley is now clear walkable sand.

**GR0K has no promoted asset.** Its anchor at (24, 19.5) is reserved and
recorded as reserved; nothing was invented to fill it.

The world-item candidate resolver is deliberately strict. It names one exact
file from the visually reviewed latest lineage for each lane: extraction and
infrastructure use `parent-reset-01`, vehicle components use the Grok 4.5 wave,
and the everyday/homebuilder lanes use their later root products. Promoted
runtime equivalents take precedence where they already exist. All 40 audited
candidates are pinned by SHA-256 in `proditems.py`; a missing or changed file is
a hard failure. There is no glob, token search, or fuzzy “closest name”
fallback. The two filename mismatches are explicit aliases:
`water_tank_frontier` → `tank_water_frontier.glb` and `workbench_field` →
`bench_welder.glb`.

The published experimental branch also vendors the 29 audited inputs that are
not already canonical runtime assets under `source-items/`. Every consumer
resolves through the same hash-checking candidate table, and required proof or
assembly inputs now fail closed instead of being skipped. The publication build
was exercised with `SUCCESSOR_PROP_SOURCE_ROOT=/nonexistent` to prove that the
branch is self-contained.

There are no roads, paths, lanes, aprons, kerbs, paving, traffic furniture,
rectangular ground patches or route-shaped ground marks anywhere in the layout.
The desert is one continuous plane. The only authored relief is the ancient
remnant landform along the north and the mass fallen off it; `assembly.json`
records `ground_relief` and `roads_paths_aprons_or_paving: none authored`.

---

## 11a. Assembly correction pass (2026-07-29, post-review)

Visual review of the first assembly rejected two assembly-only elements. The
three standalone building products were not rejected and were not touched: the
nine unit GLB and six manifest/collision sha256 values are byte-identical before
and after this pass (`clone_lod0` `5ddd6ae6…`, `clone_lod1` `8460df57…`,
`clone_lod2` `3ee5702e…`, `commerce_lod0` `ef4b31cb…`, `commerce_lod1`
`d9a7f40f…`, `commerce_lod2` `a7493ef3…`, `shelter_lod0` `8fb15ac4…`,
`shelter_lod1` `5aed074e…`, `shelter_lod2` `7cfb4498…`). The correction changes
only `prodassemble.py`, its preserved iteration prompt, and this record; no unit
authoring source or standalone product changed. The rejected frames are preserved under
`assembly/rejected-precorrection-ignored/` (git-ignored, like every artifact).

**Rejected defect 1 — the wind-drift swells.** Four low `boxm` solids with
truncated flat tops. They were never connected route geometry, but a truncated
box is a rectangle, and in `03_gameplay_frame.png` they read as a tan plaza with
hard straight edges running across the middle of the frame. **Removed.**
`terrain()` now authors one continuous 180 m sand plane and nothing else. A
plain desert surface is better than fake naturalism.

**Rejected defect 2 — the windbreak.** Ten hand-tuned battered boxes on a shared
plinth. Varying width, height, batter and lean did not help: a box row is a box
row, and it still read as shipping containers or tombstones. **Rebuilt from
zero** as a swept solid. Forty-two authored stations, each contributing one
15-point cross-section of ONE closed mesh; consecutive sections are bridged, so
there is no repeated element and no seam where a pier could start or stop. It
runs from x −7 to x 49 — off both edges of the 42-cell block — so it reads as
terrain that continues, not as an object placed in a plot.

Macro silhouette, authored not generated: a heavy 9.4 m massif west of the clone
unit, sheared through at x 7, a collapsed 2-3 m spine sanded over across the
middle with a single surviving stub at x 17-18, breached almost to sand level at
x 23, then rising again to an 8.7 m massif east of commerce. **The settlement
sits inside the breach, which is why a settlement is there at all.**

Four corrections were made against rendered frames during this pass, each after
looking at the result:

1. **Round 1 → 2.** Narrow crests on 10-11.5 m stations killed the modular
   reading but produced a jagged natural rock ridge with pointed summits that
   dominated the top of the gameplay frame. Crests were broadened into a dished
   bench between two eroded rims — a natural ridge has no reason to be higher at
   both edges of a flat top than in the middle, so the rim is the one
   construction cue the form keeps — and peaks were dropped below 9.5 m.
2. **Round 2 → 3.** The massifs read as smooth grey lumps. Added a per-station
   windward flute (23 authored values against 42 stations, on a station pitch
   that itself varies from 0.45 to 2.7 cells, so the fluting never lands on a
   regular rhythm) which steps the scarp in and out into vertical buttresses and
   clefts. The flute moves the section's whole outer envelope, not individual
   points: weighting points differently folds the profile back on itself and the
   sweep self-intersects.
3. **Round 3 → 5.** A 6-8 m lee toe on a shallow exponent made a large smooth
   ruled surface between stations that read as folded drapery, and letting the
   depth collapse as fast as the height turned the shear into a blade. The lee
   toe is now roughly 0.8 of the windward toe on a 1.40 exponent, and the
   collapsed run keeps its width while losing its height.
4. **Round 5 → 6, the one that mattered.** `pk.Unit.consolidate` smooth-shades
   every part and marks sharp edges above 38°. That is right for cast panels and
   wrong for stone: on a low-poly swept landform it blends whole runs of facets
   into one continuous curved surface, and rounds 2-5 all read as creased cloth
   in close inspection no matter what the silhouette did. `facet()` flat-shades
   the consolidated remnant parts and the same geometry reads as rock.

Twenty blocks of fallen mass sit where the remnant actually failed — the shear
at x 7, the breach at x 21-25 and the two scarp feet — not scattered evenly. The
largest are tabular (long in one axis, strongly leaned, barely tapered) and read
as collapsed courses off the crest; the rest is broken rubble. Each is built
from four jittered rings whose centres step along a lean vector, so the lean is
in the vertices and no object transform is needed. Nothing is collinear, nothing
forms a line or a fan, and nothing comes near the door approaches on the south
faces.

Under the locked north-up 60° camera an element of height `h` standing north of
a target projects its crest `h / tan 60 = 0.577 h` cells south on screen. Every
station that has a building behind it satisfies `crest_y + crest_half_width +
0.577 × crest_z + windward_flute ≤ wall_y`. Computed over all 42 stations: the
worst such station is x 5.4 at a projected y of 3.78 against the clone's north
wall at y 6.0, a 2.22-cell margin. The four stations that do project past y 5
(x 2.9 and x 37.1-40.9) stand in open desert west of the clone and east of
commerce, with nothing behind them. Confirmed in `02_gameplay_wide.png`: all
three units fully legible, no roof occluded, the alley clear, and the remnant
reading as backdrop. The southernmost point of the remnant's toe reaches y 2.52,
leaving at least 2.5 cells of open walkable desert between it and any building;
the travel terminal, the spawn and all three sliding-door approaches — which are
on the south faces, the far side of every unit — are untouched.

Micro erosion is deterministic: one `random.Random(20260729)` drives every
section jitter, station offset and fragment ring. Verified by running
`prodassemble.py` twice back to back — `assembly.json` is byte-identical, so the
geometry, bounds, triangle counts and instanced mesh datablocks reproduce
exactly. The nine PNGs are **not** byte-identical between runs: Cycles is left
on its default sampling seed, so frame bytes carry sampling noise even though the
scene does not. Scene totals for the corrected assembly: 416 mesh objects,
162,006 triangles, nine frames. `09_remnant_shear.png` is the added close proof
that the remnant is one swept mass with a real shear, not a row of piers.

**Still honest about the remnant:** the `ancient` tiling texture is projected
per-polygon, so the strata bands change direction across facets; at close range
that reads as coarse bedding rather than authored rock surfacing. The collapsed
run between x 9 and x 16 still shows some flat-lying shelf facets in
`09_remnant_shear.png` — they read as broken slabs, which is the intent, but they
are a consequence of a 15-point section, not authored detail. Nothing in this
section is a runtime asset, is exported, or is proposed for promotion.

---

## 12. Honest compromises and remaining risks

- **Not runtime-proven.** No fixture, no Rust collision run, no Unity or Three
  frame, no packaging. The renderer contract has been read, reproduced and
  measured against — it has not been executed.
- **44 / 39 / 40 draw calls per building instance.** Enterable props are not
  instanced by the Three renderer, so a three-building settlement is ~123 draw
  calls before props. LOD1 reduces to 40 / 35 / 35. This is measured and
  recorded; it has not been profiled in-engine, and it is the first thing an
  integration pass should challenge.
- **LOD0 triangle counts (14k–29k) are HDRP-scale, not web-scale.** LOD1 is the
  intended web base. No LOD switching distance has been chosen.
- **The clone exhaust stack still casts a shadow across the revealed floor**
  under the cutaway. Visible in `proof/final/clone/15_cutaway.png`. Promotion
  must either exclude retained masses from shadow casting while a cutaway is
  active, or accept it.
- **Interior lighting in the proof frames is render-only.** The units author
  emissive task lights, but Blender emission alone does not light a room at
  these sample counts, so `prodproof.interior_lights` adds four area lamps that
  are never exported. The runtime supplies its own interior lighting; the
  frames show the room that was built, not the room the runtime will light.
- **The promoted pawns render in rest pose**, T-posed and untextured in the
  assembly frames. They are there as real scale and compatibility instances,
  not as a character-art claim.
- **Procedural textures, not authored ones.** The eight material sets are
  deterministic numpy fields, seamless and measured, but they are trim material
  response — not hand-authored surfacing. They are good enough to judge value,
  scale and material family at gameplay distance and hold up at the close crops
  in the packet; they are not a substitute for an art pass on hero surfaces.
- **The proof camera is a Blender reconstruction** of the gameplay camera
  (orthographic, yaw 0, pitch 60). It matches the documented contract. It is not
  the engine's camera.
- **`terminal_cells_kept_clear` promises approach cells, not terminal cells.**
  That matches how the existing commerce sidecar is validated, but the semantics
  should be confirmed with the fixture owner before promotion.
- **No fixture reconciliation.** The settlement block carries no world origin
  and has not been placed against the authored open-desert cells, camera follow,
  or AOI.

---

## 13. Reproduce

```
cd tools/successor/assets/dustgate-redesign
export SUCCESSOR_PROP_SOURCE_ROOT=/nonexistent                    # use vendored pins
blender -b --factory-startup -P textures.py                       # 8 PBR sets
blender -b --factory-startup -P proditems.py -- all               # item audit
blender -b --factory-startup -P prodbuild.py -- all               # units + LODs
blender -b --factory-startup -P prodproof.py  -- all --round final
blender -b --factory-startup -P prodassemble.py                   # test bed
cd ../../../..
node tools/successor/assets/dustgate-redesign/prodvalidate.mjs    # Khronos
node tools/successor/assets/dustgate-redesign/prodsidecar.mjs     # v3 gate
```

`prodbuild.py` exits non-zero on: a footprint/mesh disagreement, geometry
outside the declared footprint, an open leaf that fouls or fails to clear, an
occluded door head, an anchor with no walkable egress, ground contact off zero,
a missing or duplicated `door_slide` node, a door leaf not at its closed pose in
the exported file, missing clips, or a mesh without UV0.
