# Human review — pass 4

Status: **functional baseline accepted; art and presentation rejected for another
refinement pass.**

The pass-3 package fixed the important functional regressions. Preserve its
measured terminal orientation, door contract, fixture cells, collision
sidecar, imported-prop provenance, trainer clearances, sealed openings, LOD
budgets, and continuous rear-service routes.

Do not use `VERIFY_ALL_OK` as visual acceptance. The canonical pass-3 renders
were inspected at full resolution. The following failures are authoritative.

## 1. Finish the corner repair below the datum

The upper rainscreen joints now have real backing and closures, but the lower
mass still presents near-black vertical shafts from the floor to the brass
datum in the front, side, and corner close views. They continue to read as
missing geometry.

- Continue the structural corner/backing condition from the slab/floor through
  the lower sinter mass, not only from `band_top` upward.
- Give the lower joint a legible construction condition: returned mass,
  expressed quirk, closure angle, or another tectonically credible solution.
- Preserve drainage and the upper brass closure details.
- Update the ray and pixel diagnostics to test the lower section separately.
- A close render must visibly show a surfaced joint. “A ray hit something” and
  “not mathematically black” are insufficient if it still looks like a void.

## 2. Replace the black octagonal keystone puck

The facade's declared focal detail is currently a nearly pure-black,
low-sided circle in a brass plate. It looks like an unfilled hole or viewport
artifact.

- Redesign it as a deliberate identity/focal insert: for example a smooth
  glass/emissive roundel, a machined brass boss with a dark inset, or another
  resolved non-textual market symbol.
- It must have readable depth, edge treatment, and material response.
- It must not be a featureless near-black disk.
- Use enough radial resolution and correct normals that the silhouette is
  smooth in the dedicated close view.
- Do not invent a settlement name or restore the rejected one.

## 3. Stop requiring every material to contain visible noise

The material-response work is directionally better, but the close crop still
shows the same evenly distributed procedural speckle on screed, sinter,
plaster, ceramic, and brass. The material verifier's **minimum** micro-energy
floor is encouraging the exact problem under review.

- Remove the requirement that quiet materials must exceed a minimum
  high-frequency energy. Keep sensible maxima; nearly flat base colour is
  valid for plaster, ceramic, polished screed, and machined brass.
- Put subtle directional detail in normals/roughness where physically causal;
  do not encode uniform dirt in every base-colour texel.
- Let materials separate primarily through value, roughness, metallic response,
  aggregate scale, edge treatment, and authored wear.
- Keep architectural-scale wear causal and sparse: feet, hands, goods, water,
  wind exposure, and actual joints.
- Rebuild the contact sheet and compare the full-resolution floor/wall/brass
  crop. It should no longer read as one noise family recoloured seven ways.

## 4. Compose the side elevations

Both side elevations remain dominated by one large dead lower wall while the
roof is visually busy. A single small window does not resolve the imbalance.

- Add a small number of asymmetrical, functional elements to the lower side
  masses: service access, protected ventilation, conduit/pipe runs, shade,
  structural thickening, goods handling, or another credible desert-market
  function.
- Use hierarchy and restraint. Do not replace blankness with barcode seams,
  stamped greebles, identical vents, or decorative clutter.
- Make the two sides respond to different interior uses rather than mirroring
  each other.
- Preserve the footprint and the “no roads” universe constraint.

## 5. Make the daylight section legible from a real player viewpoint

The report correctly admits the clerestory cannot be seen from standing eye
level because a 3.35 m service wall sits immediately below glazing beginning at
3.60 m. Raised inspection cameras and extreme roof crops do not make this a
successful architectural feature.

- Revise the actual section so the north-plane lift/daylight system reads from
  at least one plausible standing player viewpoint in the hall or BOH and in
  the pitched top-down gameplay view.
- You may change service-wall height, valley beam/supports, glazing position,
  light-scoop geometry, or the roof fold, provided the terminal niches remain
  enclosed, the BOH remains functional, and the load/drainage story stays
  credible.
- If a clerestory is no longer the best solution, replace it with a more
  legible daylight system and update the design prose honestly.
- Do not use a camera above normal eye height as the primary interior proof.

## 6. Give the trainer booth a stronger functional identity

The booth now fits two seats and a table, but still reads as a cramped generic
office with a blank pinboard.

- Preserve both usable seating volumes, standing approach, sightline, and the
  trainer fixture cell.
- Add one clear training-specific function and visual focus: equipment
  diagnostics, a body/skill display, certification hardware, a demonstration
  rack, or another non-textual system appropriate to the universe.
- Improve the board/shelf/credenza composition and remove anything that blocks
  or visually swallows the trainer's seat.
- Keep the treatment subordinate to the market hall rather than turning it
  into a separate scene.

## 7. Proof views must read without their filenames

`20_crop_loggia` still looks upward through a narrow slot at one ceiling lamp;
it does not show the claimed two bays, unequal piers, goods ledge, bench, or
shopfront. The clerestory views still read as anonymous dark roof bands.

- Show the loggia with an exterior oblique or cutaway that includes at least
  two bays, the pier rhythm, soffit/coffers, and one market use element.
- Show the daylight system in architectural context, not as an extreme close
  crop of dark horizontal strips.
- Keep cameras outside collision and free of clipping.
- Include normal standing eye-level and pitched gameplay views for the revised
  features.
- A geometric “subject hit fraction” is only a diagnostic. Human legibility is
  the acceptance criterion.

## Required method

1. Diagnose the lower corner and current material close crop from shipped
   geometry and pixels.
2. Make real source changes for corners, focal insert, materials, side
   composition, daylight section, and trainer identity.
3. Build and render a moderate diagnostic set.
4. Inspect the rendered pixels, name at least one defect discovered only after
   rendering, and make another source correction.
5. Rebuild every deliverable from one revision.
6. Extend verification for the lower-corner section and revised daylight
   section without weakening existing checks.
7. Render one canonical final proof set from the exact shipped build and update
   `DESIGN.md` and `REPORT.md` candidly.

Preserve the scheme-E design intent where it still works. Refinement is allowed
to alter geometry substantially; camera reframing alone is not completion.

