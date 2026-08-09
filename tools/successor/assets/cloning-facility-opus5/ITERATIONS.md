# Dustgate Clone Vault — iteration log

Renders under `.game-lab/cloning-facility-opus5-20260803/iter/<tag>/` (gitignored).
Live scene surgery and inspection ran through the Blender MCP bridge on
`127.0.0.1:9876` in an isolated `CLONE_OPUS5` scene with `CLONE_OPUS5_BUILD/RIG/REF`
collections; render sheets ran headless from the same modules, because the MCP
instance renders EEVEE on the software rasteriser behind Xvfb at ~45 s/frame
against ~0.5 s/frame headless.

## Environment defects found and worked around

- **`cycles.preferences.get_devices()` segfaults Blender 5.2.0 LTS (snap 7599)
  on this host.** Reproduced headless under `--factory-startup`; crash trace in
  `cycles/properties.py::get_device_list`. Enumeration is the only way to enable
  a GPU backend, so every bake runs CPU with adaptive sampling plus OIDN. It also
  killed the shared MCP instance's addon server on the first bake attempt; a
  dedicated Blender host was started rather than disturbing the humanoid scene
  that instance was holding.
- **Bake cost is shader-bound, not sample-bound.** 1024² COMBINED took 41.6 s at
  16 spp and 44.3 s at 32 spp. Samples are nearly free here; resolution is not.

## Passes

**p01 — first full shell + interior.** 33 154 tris. Envelope over by 140 mm in X
and 70 mm in Z. Read: *a box*. The entry bay did not project legibly, the
back-left tower protruded 160 mm — less than the wall piers beside it — and the
parapet was one height all the way round.

**p02 — massing rework.** Stepped parapet runs (3.90/4.02/4.14/4.30), corner
piers carried past the coping with bronze caps, the tower rebuilt as a slim
ground shaft corbelling out over the roof deck on a 45° shoulder, bay parapet to
4.62 m with corner fins and a crest fin. Read: the mass now has a front, a
service side and a back.

**p03 — value contrast.** Palette darkened (`panel_dk` #A69C88→#8A8072, `gunmetal`
#484C50→#3B4045), architectural glazing re-read as a *dark slot* (alpha
0.26→0.62) and split from the vat canopies, which need the opposite
(`CF_GlassClear`, alpha 0.20). Clerestories enlarged and given deep gunmetal
reveals; full-height louvred slots added between the middle piers.

**p04–p05 — the vats.** First occupant pass showed the specimen as a white smudge
on a white shell. Added a gunmetal chamber liner behind the body, narrowed the
backlit diffuser to a strip, deepened the fluid (alpha 0.62→0.74) and gave the
fill level a bronze meniscus ring. That single liner change is what made the
occupied vat read.

**p06–p10 — the specimen, four failed attempts.**
1. Curling fingers about a world axis sheared the phalanges into confetti — they
   point four different ways. Curl now happens about the knuckle axis measured
   off the rig.
2. Cameras framed the torso only; the occupant stands on a foot plate 0.54 m up,
   so a room-height camera crops its head.
3. Relative bone offsets summed to a 22° backward lean at the skull.
4. Reducing them exposed the real problem: **the source rest pose is an idle
   stance with a stride and a forward stoop**, so offsets fight it. Rewritten to
   aim every limb at an absolute armature-space direction. Upright at p10.

Also found here: a rotation about world +X moves bones that grow *up* forward and
bones that hang *down* backward, so "forward" flips sign between spine and limbs.
The pose table now states the intent per bone.

**p11 — standalone props.** `clone_pod` footprint came out 0.98 × 0.971 m because
the sill ring and front detail overran the plinth; the runtime placement scale is
derived from the footprint, so it was clamped back to exactly 0.95 × 0.95.
`clone_terminal` screen showed a slice of a world-space tiling projection — the
UV generator now fits display materials to their own face.

**p12–p13 — export pipeline and exterior polish.** Reveal depth 0.06→0.09 so the
lower panel fields read as recesses rather than scribed lines; the broad
front-left segment got a real intake register with a louvre bank, bronze frames
and a duct trunk climbing to the roof plant; gunmetal skids under the roof
vessels so the pale masses sit on something.

## Export-pipeline defects found by the gates

Every one of these was caught by parsing the shipped GLB, not by looking at the
scene:

- **A factory-startup `Cube` was riding into every export.** Blender 5.2
  background *does* have `bpy.context.window`, so an earlier window-presence test
  did not fire; and the Cube stays selected in the scene it was born in, which is
  enough for `use_selection` export to pick it up even after it has been unlinked
  from the exported scene. It has to be deleted. Until then, both props measured
  2.0 × 2.0 m.
- **`REPO` was resolved one directory too shallow**, so the first successful run
  wrote the whole suite into `tools/client-3d/...`.
- **`export_animation_mode="ACTIONS"` shipped one clip.** Only the assigned
  action came out. Both clips now travel as one-strip NLA tracks.
- **Clip duration was 0.8333 s, not 0.8 s.** The exporter converts frames as
  `frame / fps`, so a 1…25 key range is 0.833 s. Keys start at frame 0.
- **The door rested OPEN in renders.** Two enabled NLA tracks blend to the open
  pose at frame 0. NLA is off for authoring and switched on only for the export
  call; the shipped rest translation is additionally patched into the GLB.
- **Atlas UV coverage was 10.6 %.** `smart_project` alone keeps every island's own
  scale and lets the largest set the bound. Equalising texel density and
  repacking with rotation, and cutting the island margin from 0.0022 to 0.0010,
  took coverage to 52.9 % — 5× the effective texture resolution for the same
  payload.
- **Six parts mixed atlas and runtime-special materials.** The classifier refuses
  them rather than silently baking a glass pane into the atlas.

## Second-eyes and honesty notes

- The atlas lands at ~66 px/m. Procedural micro-noise does not survive that;
  what survives is occlusion, light falloff and the emissive accents, which is
  what an unlit renderer needs. Any claim of fine surface texture in the shipped
  GLB would be a claim the pixels do not support.
- 20 of 37 mesh nodes are runtime-special (glass, fluid, emissive). That is 20
  small draw calls the previous asset did not have. They are what makes the
  transparency and the glow work through `convertMaterial`, and they are all
  small; but it is a real cost, stated rather than hidden.
- The top-down cutaway shows faint horizontal banding across the floor whose
  source was not tracked down. It is not visible from any gameplay bearing and
  was left rather than chased at the cost of the rest of the pass.
