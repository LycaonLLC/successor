# Dustgate Clone Vault — design and contracts

Replaces `tools/successor/assets/build_cloning_facility.py` as the source of
truth for `cloning_facility`, `clone_pod` and `clone_terminal`. The legacy
script also built `bank_terminal`; that path was split out first, byte-for-byte,
to `tools/successor/assets/build_bank_terminal.py`.

## Regenerate

```bash
/snap/bin/blender -b --factory-startup -noaudio --python-exit-code 1 \
  -P tools/successor/assets/cloning-facility-opus5/src/build_clone_suite.py
```

Env knobs (for iteration only; the committed bytes come from the defaults):
`CF_ATLAS` atlas edge, `CF_BAKE_SAMPLES` Cycles samples, `CF_VALIDATE=0` skip
the glTF validator, `CF_SAVE_BLEND=0` skip the checkpoint `.blend` writes.

Render sheets:

```bash
CF_SAMPLES=32 CF_RES=1200 /snap/bin/blender -b --factory-startup -noaudio \
  -P tools/successor/assets/cloning-facility-opus5/src/cf_lab.py -- <tag> [views…]
CF_NIGHT=1 …   # the same rig at dusk, for the emissive read
```

## The one runtime fact that shapes everything

`client-3d/src/render/props.ts::convertMaterial` converts a world-prop material
that carries a base-colour texture into an **unlit `MeshBasicMaterial`**, and
one without into a flat-shaded `MeshMatcapMaterial`. Normal, ORM and AO maps are
discarded; vertex colours are not forwarded.

So a textured asset in this game gets exactly one shading input: its base
colour. Irradiance and ambient occlusion have to be *in* that map or they do not
exist in play. That is already the shipped convention for `campfire_scout`,
`barricade_concrete` and `chair_frontier_a` — one PBR material over a baked
atlas. This suite follows it:

- every tiling surface is a Cycles-evaluable procedural graph (`cf_mat.py`);
- one unique UV set is packed across the whole asset (`cf_bake.pack_atlas_uv`);
- `COMBINED` is baked through it, including the interior practicals, and
  becomes `CF_Body`'s base colour, with a packed ORM and a tangent-normal atlas
  alongside for PBR consumers;
- glass, culture fluid and the emissive accents stay **untextured** so the
  matcap/basic branches keep their authored blend transparency and emissive
  colour — the `commerce` `CM_TealGlass` precedent.

Measured: 2 070 m² of baked surface, 52.9 % atlas coverage, 4096² base colour
≈ 66 px/m. That is lightmap-class density, which is the right trade: silhouette
and relief come from geometry, and the atlas carries light.

## Frozen contracts

| Contract | Value | Why it cannot move |
|---|---|---|
| Mesh envelope | 9.5 × 7.6 m, front `+Z` | runtime scale 10/9.5 = 8/7.6 = 1.052632 |
| Floor top | y = 0.02 m | fixture asserts `0.02 × (10/9.5)` |
| Interior region | x ∈ [-4.2, 4.2], z ∈ [-3.25, 3.4] | fixture walkability |
| Structural proxy | **exactly nine** named wall boxes + one door box | `configure-open-desert-fixture.mjs` and `structure-collision-geometry.test.mjs` both assert nine |
| Door | node `door_slide`, clips `door_open`/`door_close` @ 0.8 s, local axis (-1,0,0), travel 2.40 m, closed rest | `props-mapping.json` `slideDoor` |
| Clear opening | 2.30 × 2.42 m | manifest + fixture door points |
| Cutaway roles | `roof__ wall_front__ wall_right__ wall_back__ wall_left__ floor__ interior__` | `classifyEnterablePart` |
| Reveal set | `roof__`, `wall_front__`, `wall_right__` fade when a pawn is inside | `props-mapping.json` |

The nine structural boxes are reproduced with the same ids and extents the
previous asset shipped. An art pass is not a reason to move a wall a player has
already learned to walk past, and it keeps the world fixture and its tests
untouched by the rebuild.

Everything above the parapet — the filtration tower's corbelled mass, the
process hall, the reservoir, the condensers — lives in `roof__`, both because
there is no collision contract up there and because it has to disappear with the
roof when the cutaway opens. The tower's ground shaft stays in `wall_back__` so
the building keeps a vertical anchor while you are inside it.

## Tectonics

Buildkit-opus5 register, unchanged in kind: **sintered aggregate** ground plate
and plinth, **bleached panel** skin, **bronze** datum at the construction line,
**galvanised roofmetal** copings and plant, **gunmetal** reveals and frames.
Extended with the clinical register a biomedical hall needs: **enamel**,
**stainless**, **seal rubber**, **hazard ochre**, **bio glass**, **culture
fluid**, **cyan clinic emissive**.

Massing decisions, in the order they mattered:

1. **Stepped parapet.** One height around a rectangle is what made the previous
   asset read as a box from every bearing. Four runs at 3.90 / 4.02 / 4.14 /
   4.30 m give the mass a front, a service side and a back.
2. **Corner piers carried past the parapet** and capped in bronze, so the volume
   has four legible vertical edges instead of one continuous white band.
3. **Corbelled tower.** The frozen footprint leaves a 0.55 m wall band at ground
   level, so the shaft is slim where a pawn can touch it and flares out over the
   roof deck on a 45° shoulder — the wall-pier move at building scale.
4. **Raised portal mass**: bay parapet at 4.62 m over a double-stepped coping,
   corner fins to 4.92 m, a crest fin to 5.18 m, a brow with a warm downlight
   bar, and a bronze bioseal architrave traced by an energised cyan line.
5. **Dark openings.** Deep-reveal clerestories and full-height louvred slots are
   the only large dark rectangles on the building; without them a 7 m bleached
   wall has nothing to read against.

## Interior

The room has to explain in one glance from the threshold that bodies are grown
here, so there is no domestic furniture in it at all.

- **Left wall, three full-size vats** at z = +1.52 / 0.00 / -1.52:
  `empty` (canopy swung 62° open, bare cradle, drained, hoses slack),
  `occupied` (charged, bronze meniscus, a posed specimen, green stack),
  `primed` (charged, vacant, amber standby).
  Chamber clear volume 1.88 m × 0.89 m authored, 1.98 m × 0.94 m at runtime
  scale. A dark gunmetal liner behind the specimen is the single most
  load-bearing decision in the unit: a pale body in front of a white shell is a
  silhouette-free smudge.
- **Aisle gantry** on rails in front of the bank, its articulated arm parked
  over the open unit, clear of head height everywhere a pawn walks.
- **Back wall process bank**: two buffer vessels with sight glasses, two pump
  skids with volute pipework, a three-level valve manifold with hand wheels, a
  control cabinet, wall-hung filter housings, a cable tray, and one eyewash
  station.
- **Right wall control bank**: three-face monitor wall on an authored pictogram
  readout, bronze-edged operator ledge, glazed reagent rack, autoclave, and one
  instrument trolley parked out of the walk lane.
- **Circulation**: a hazard-striped lane from the portal to the operator island,
  a sterile-zone inlay around the vat apron, a stainless drain channel across the
  hall to a sump, and two reserved pads for the world props the fixture places
  inside the building.

## The specimen

`pawn_male.glb` from `successor-humanoid-runtime-refit-20260802`, read-only. The
rig poses the mesh and is then discarded with all 47 clips, so the building ships
a static mesh and never inherits a skeleton (`no_skins_or_armatures` gate).

Two things had to be got right:

- **Absolute aiming, not relative offsets.** The source rest pose is an idle
  stance with a stride and a forward stoop; small relative rotations fight it
  instead of replacing it. Every limb is aimed at an explicit armature-space
  direction.
- **Mesh height ≠ runtime height.** Both the building and a 1×1 prop are placed
  at 1.052632 uniform scale, so the specimen is authored at 1.6388 m to stand
  exactly 1.725 m in the world the player walks around in.

Materials are replaced with `CF_skin`, which also means the clone has no face.
That is deliberate: an unfinished body in a growth tank should not have one.

## Props

`clone_pod` is authored on a 0.95 × 0.95 m footprint so its runtime scale is
exactly the building's, and ships **primed** — sealed, charged, amber standby, no
occupant. That is the right read for the pod a player is about to respawn into;
the occupied-with-a-body story is told by the facility's vat B, where it carries
dramatic weight. No fourth asset was added, so the runtime prop surface is
unchanged.

`clone_terminal` is the operator island: splayed foot, enamel column, bronze
datum, a raked switch deck with a palm reader and sample dock, and a raked
display head. Its emissive face is a deterministic numpy pictogram raster — body
chart with growth fill, viability ring, vitals traces, bay pips. No lettering
anywhere, so nothing on it can collide with a real wordmark.

## Fixture change

`configure-open-desert-fixture.mjs` moved `clonePod` from `facilityCell + (5, 5)`
to `facilityCell + (2, 1)`. The old cell put a solid 1×1 blocker two cells inside
the portal, directly in the entry lane; the new one completes the vat bank in the
back-left corner. `cloneTerminal` stays at `facilityCell + (5, 3)`, the centre of
the hall, which is exactly where an operator island belongs.
