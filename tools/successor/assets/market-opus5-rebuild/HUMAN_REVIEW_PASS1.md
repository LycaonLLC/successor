# Human review gate — pass 1 rejected

The first authored pass is a failed checkpoint, not an acceptable asset.
Continue the same blind experiment, but do not preserve weak geometry merely
because it already exists. You may discard and rebuild any or all of this
attempt. The forbidden-reference and held-out rules in `CLAUDE_TASK.md` remain
in force.

## Visual verdict

The current building still reads as a generic, washed-out civic box rather than
a production-quality science-fiction market:

- The silhouette is mostly stacked rectangular parapets around one large roof
  box. The stepped volumes are not enough to make the architecture distinctive.
- The public facade has giant blank white slabs, thin black slot bands, and an
  entrance that reads more like a garage/loading opening than a market arrival.
- The same panel seams, roof bars, louver rows, and concrete piers repeat with
  little hierarchy. This is the exact lazy repetition the task rejects.
- Brass is used as a continuous decorative outline and is covered in repeated
  procedural pits/bumps. It looks noisy and cheap rather than engineered or
  worn. Large ceramic and sinter areas also show obvious procedural texture.
- The interior is three terminal alcoves behind a railing with oversized blank
  walls. It does not read as a complete bank/trade/registry/vendor/trainer
  facility with believable staff, storage, service, lighting, and circulation
  logic.
- The cone pendant, generic rail, flat bays, and unintegrated terminal niches
  look like placeholders. Imported terminals are more resolved than the
  architecture surrounding them.
- Roof and rear plant are plausible only at blockout fidelity. Repeated vents,
  bars, cubes, and a cylinder do not constitute a resolved service system.

Do a real architectural and interior redesign. Do not call the current massing,
datum, loggia, plan, or door mechanism protected. Keep only elements that earn
their place after comparison with a genuinely stronger alternative.

The next direction still must be coherent hard-surface science fiction for an
inhabited desert planet, but it needs:

- a distinctive plan-readable silhouette and public identity;
- an unmistakable, human-scaled market entrance and sheltered transition;
- structural depth, load paths, service logic, and material transitions that
  feel designed rather than layered onto a box;
- focal detail and asymmetry balanced against a reusable construction system;
- a complete interior with authored ceilings, lighting, counters, partitions,
  staff/service access, storage, vendor display, trainer consultation, queueing,
  and clear customer approaches;
- restrained PBR materials with variation at architectural scale and localized
  causal wear. Eliminate uniform pockmarks, dotted grids, barcode seams, and
  noise stamped over every surface.

## Objective contract failures

### Fixture coordinates are zero-based

The live authority layout uses zero-based local cells from the north-west
corner. The current helper incorrectly subtracts `0.5`, shifting every service
point one full cell west and north.

For a 12-by-9 footprint with 0.95 m authored cells, the exact glTF asset-space
cell center is:

```text
x = -5.700 + (column + 0.5) * 0.950
z = -4.275 + (row    + 0.5) * 0.950
```

If the generator keeps a north-positive plan-space Y coordinate before glTF
axis conversion:

```text
plan_y = 4.275 - (row + 0.5) * 0.950
```

Required centers are therefore:

```text
bank        (3,3):  glTF x=-2.375, z=-0.950
trade       (6,3):  glTF x= 0.475, z=-0.950
association (9,3):  glTF x= 3.325, z=-0.950
trainer    (10,6):  glTF x= 4.275, z= 1.900
```

Correct the helper, all terminal/zone geometry and loose-prop placement, grime
locations, backing panels, furniture, collision proxies, approaches, and
manifest records. Add explicit assertions for these four centers. Prove each
whole promised cell and its customer approach clear against the final authored
collision sidecar.

### Door proofs are identical

`proofs/pass1/10_door_closed.png` and `11_door_open.png` have an exact pixel
RMSE of zero. The render rig's manual root transform is being overridden by
active NLA evaluation. Fix the proof rig and verify visibly distinct closed and
fully open states with an automated nonzero pixel-difference check.

Independently verify that the exported `door_slide` node and both 0.8-second
clips actually animate the movable leaf through the recorded local travel in
Three.js. Do not infer runtime behavior from Blender object names.

### Cutaway and proof cameras fail

- The roof-off view keeps ceiling planes, so it does not expose the interior.
  Ceiling/roof-hidden parts must use the appropriate `roof__` grouping.
- The trainer-bay proof is almost entirely occluded by a foreground wall.
- The entrance crop does not clearly prove the modeled door mechanism.
- The interior views do not demonstrate the complete zones or circulation.

Rebuild the proof rig so every named image shows its claimed subject. Include
at least one useful full-plan roof-off view and several human-eye interior views
that reveal different zones.

### Export warnings are blockers

The full build log reports:

- active vertex colors are not exported because the material node trees do not
  consume them;
- tangent calculation failures on multiple meshes that use normal maps;
- multiple image nodes competing for one glTF texture sampler.

Fix the material graphs and export geometry. Strict inspection must prove
`COLOR_0` survives where authored wear depends on it and valid tangents survive
where tangent normal maps are used. Triangulate or otherwise correct malformed
faces/UVs before export. Eliminate the competing-sampler warnings rather than
hiding log output.

### Texture evidence is stale and visibly repetitive

The texture contact sheet predates the last generated maps. Regenerate it from
the exact final files. Replace the repeated elongated steel marks, dotted/pitted
brass, broad cloudy noise, and uniform surface damage with a restrained system
that holds up both close and at gameplay distance.

## Required continuation loop

1. Correct the coordinate helper and add measured assertions first.
2. Produce at least two materially different architectural alternatives in
   cheap diagnostic blockout renders. Compare them bluntly and choose or combine
   the stronger one. Do not spend final-render time polishing the existing box.
3. Rebuild exterior, entrance, roof/service systems, and interior architecture
   at geometry level. Rebuild the weak textures and material graphs.
4. Generate a complete second inspection set at moderate resolution. Inspect
   the images using the available image-reading capability and run objective
   image comparisons where applicable.
5. Write `CRITIQUE_PASS2.md` that includes failures found by this human review,
   not only failures the first critique noticed.
6. Make at least one substantive geometry/material/camera correction after pass
   2, then rebuild, revalidate, and render the final set.
7. Finish every original deliverable: editable final Blend, numbered pre-final
   checkpoint, LOD0/1/2 and furnished GLBs, v3 collision sidecar, manifest with
   hashes/provenance/contracts, strict validate/inspect logs, Three.js loader
   and animation proof, final texture sheet, final proof views, and an honest
   `REPORT.md`.

Use low samples and moderate resolution for alternatives and intermediate
diagnostics so the session budget goes into design changes. Reserve expensive
renders for the verified final candidate. Do not declare completion if any gate
or deliverable remains unfinished.
