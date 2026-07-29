# Starting Settlement Opus-5 Redesign Brief

Status: experimental source-stage art and layout brief, 2026-07-29.

This document coordinates a from-zero redesign study. It does not override
`CANONICAL_CONTEXT.md`, `ART_DIRECTION.md`, the generated world fixture, Rust
authority, or the active Three.js and Unity assets. Nothing produced by this
study is integrated until it passes the repository's asset, geometry,
authority, runtime, and packaging gates.

`Dustgate` is the legacy working label only. It is not the target presentation
name for the redesigned settlement.

## Mandate

Redesign Dustgate's starting area, buildings, and interiors so the first
playable location looks intentionally art-directed and production-grade from
the locked top-down game camera. The result should feel like one place built
by one culture over time, while the cloning, commerce, travel, and shelter
functions remain visually distinct.

Start from zero. The current Dustgate buildings are compatibility references
only and are not geometry, composition, material, or style references.

## Inputs that may be used

- `docs/CANONICAL_CONTEXT.md`, especially authority, world, camera, and Unity
  renderer contracts.
- `docs/ART_DIRECTION.md`, `docs/ASSET_PIPELINE.md`, and
  `docs/PERFORMANCE_BUDGET.md`.
- Renderer loaders, structure interfaces, fixture schemas, tests, and node
  naming contracts.
- Logical ids, interaction requirements, cell scale, cardinal orientation,
  collision semantics, cutaway behavior, and equipment/player dimensions.
- The existing promoted player, character customization, clothing, equipment,
  and item assets as preserved integration dependencies. Direction studies may
  use a neutral 1.75 m capsule for fast scale reads, but runtime acceptance
  proof must load the real existing assets through their current manifests and
  loaders.
- Existing promoted world-item assets, their manifests, provenance, sockets,
  and current runtime loaders. The much larger editable source library under
  `~/dev/games/source-assets/props/` may be inspected read-only and selectively
  promoted through the normal asset pipeline when a useful item is not yet in
  the runtime library.

## Inputs that must not be used

- Do not open, import, trace, render, modify, or copy
  `cloning_facility.glb`, `commerce_facility.glb`, `house_h1.glb`, their
  textures, or their source geometry.
- Do not use the current facility builder scripts as form-generation input.
  They may be consulted only after a new direction exists, and then only to
  compare interface/export requirements.
- Do not use screenshots or renders of the current buildings as visual
  references.
- Do not redesign, replace, or destructively reinterpret the current player,
  character customization, clothing, equippables, or item library. Those
  assets stay and must remain compatible. They are integration dependencies,
  not the architecture's style baseline.
- Do not duplicate a world item merely because the architecture pass can make
  another primitive version. Inspect the authored item catalogs first.
- Do not download or kitbash third-party meshes. External references may
  inform broad architectural reasoning, but no design should reproduce a
  specific reference asset.

## Binding world and authority constraints

- Dustgate is on Ashvat, a desert planet. It is a sparse, practical,
  maintained human settlement among remnants of much older, irreproducible
  construction.
- There are no roads in this setting. Do not create roads, paths, lanes,
  connective paving, travel aprons, route-shaped striations, curbs, traffic
  furniture, bollards, or implied vehicle corridors. A building may have an
  isolated footprint or threshold treatment limited to its actual footprint.
- Authority coordinates are north-up: `+x` east, `-x` west, `-y` north, and
  `+y` south. The normal game camera is a north-up pitched orthographic view.
- Rust and the generated renderer-neutral fixture own collision, positions,
  legal interactions, movement, and gameplay. Blender geometry is never
  authority.
- Starting-area gameplay surfaces that need a deliberate home in the proposal
  are:
  - ordinary player spawn;
  - Knox Vale, the profession trainer;
  - GR0K, a neutral social droid with no invented job;
  - Dustgate travel terminal;
  - clone respawn, clone terminal, and clone pod;
  - bank, trade, and Player Association terminals;
  - an enterable starter shelter or habitat.
- Entrances, thresholds, terminals, furniture, and NPC positions must have
  measured clearances. Interaction readability cannot depend on tiny text or
  color alone.
- Buildings are authored for open interiors. Floors and doors always remain;
  roof and camera-facing wall sets can fade for the active interior.
- Dustgate is an assembly of reusable units, not one monolithic scene asset.
  Every building must work when instantiated alone at an arbitrary legal map
  anchor. The holistic settlement composition is a validation and layout
  layer assembled from those independent units.
- Functional behavior must match the real renderer contracts. A doorway is
  not a visual notch: it has an independently addressable `door_slide` node,
  measured closed blocker, clear threshold, declared local slide axis and
  travel, and server-authoritative open-state presentation. Enterable units
  likewise expose independently addressable floor, interior-keep, wall, roof,
  and cutaway node families.

## Existing world-item reuse contract

The authored item library is part of the redesign, not debris to work around.
Read
`tools/successor/assets/dustgate-redesign/EXISTING_WORLD_ITEM_AUDIT.md`
before the building production pass.

- Inspect manifests and existing proof before choosing props. A numeric
  generator `PASS` is not sufficient visual acceptance.
- Use real authored assets for furniture, storage, tools, tanks, power,
  terminals, and equipment when they fit the function, scale, and new
  direction.
- Keep reusable props as independently loaded or instanced assets with their
  own ids, origins, sockets, provenance, and materials. Do not join them into a
  building GLB or silently copy their geometry into the architecture source.
- Record every selected prop id, source manifest, intended building/anchor,
  transform, clearance envelope, collision treatment, and whether it is
  already promoted.
- Preserve the current travel, clone, bank, trade, and Player Association
  terminal/item contracts. Architecture should accommodate the actual assets
  and interaction sockets instead of replacing them with facade decoration.
- A source-library candidate that clashes visually may receive an explicit,
  reversible material-variant plan after review. Do not destructively edit the
  canonical item source just to make one settlement render match.
- Runtime proof must instance the actual selected assets through the renderer
  loader. Primitive stand-ins do not satisfy acceptance.

## Settlement naming

Replace the legacy presentation name `Dustgate` as part of the selected
direction.

- Produce 8–12 genuinely considered names, screen them against repository
  names and obvious real-world/product collisions, and select one
  autonomously.
- Favor a name that sounds used by residents and fits Ashvat's human culture
  and the settlement's history.
- Avoid generic sci-fi compounds assembled from `dust`, `sand`, or `ash` plus
  `gate`, `port`, `outpost`, or `haven`.
- Record pronunciation, short rationale, and how residents use the name.
- Do not rename canonical ids, fixture keys, asset paths, tests, or protocol
  values during the source-stage study. The accepted display name and the
  mechanical migration are separate commits.

## Creative latitude

The new direction may change every building mass, proportion, roof language,
material family, interior arrangement, prop design, and relative starting-area
placement. It may replace the existing facility and terminal presentation
entirely. It may introduce a fresh modular construction kit and a restrained
ancient backdrop. It should avoid generic spaceport, clean NASA outpost,
suburban, contemporary military-base, and neon cyberpunk reads.

Favor:

- strong roof and north-up three-quarter silhouettes at gameplay scale;
- obvious construction logic, repair history, weather protection, and ground
  contact;
- a coherent shared kit with meaningful variation rather than cloned boxes;
- larger functional forms, layered depth, and controlled material/value bands
  instead of decorative greeble noise;
- interiors that remain composed and legible after the cutaway;
- one memorable visual read for cloning, one for exchange/commerce, and one
  for shelter;
- production-quality UV and material planning that can support HDRP without
  making the web renderer impossible to service with lower LODs.

## First milestone: direction and layout

Create three genuinely distinct, all-3D massing/layout studies from primitive
or freshly generated geometry. They must differ in settlement composition,
building silhouettes, interior organization, and material/value strategy—not
only color. Render each through a north-up orthographic gameplay camera with
the same scale proxy.

Inspect the renders and select the strongest direction autonomously. Continue
with that direction; do not stop at a prose recommendation or wait for a user
vote.

The selected proposal must define a renderer-neutral layout document with:

- a local integer-cell origin and north/east labels;
- building footprint rectangles and yaw;
- door opening and blocker rectangles;
- walkable interior bounds and floor heights;
- spawn and clone-respawn points;
- terminal and NPC anchor cells;
- reserved clear approach regions;
- structure collision proxy rectangles;
- no connective surface or route geometry.

The proposal initially lives outside the checked-in fixture. A later
integration pass will update the fixture generator, sidecars, hashes, Rust
collision proof, and migrations together if the layout is accepted.

The selected layout builder must instantiate standalone building assets; it
must not join or bake them into one settlement mesh.

## Geometry and export contract

Use an editable `.blend` file generated by deterministic Blender Python as the
source of truth. Never hand-edit an exported GLB.

Each clone, commerce, and shelter building has its own deterministic source
entry point, local origin/pivot contract, individual `.blend` checkpoint,
individual GLB, manifest, collision sidecar, QA report, and proof packet. A
combined Dustgate study `.blend` may reference or instantiate those units for
holistic review, but it is not their source of truth.

Fresh structure geometry must provide predictable node families:

- `roof__*`;
- `wall_front__*`, `wall_right__*`, `wall_back__*`, and `wall_left__*`;
- `floor__*`;
- `interior__*`;
- `door_slide` with declared local axis, travel, opening, and pivot;
- structural collision proxies and furniture blockers in sidecar data, not
  detail-mesh collision.

Record dimensions, origin, ground contact, triangle counts, material counts,
texture plan, UV coverage/overlap intent, and candidate LOD strategy. Do not
force concept geometry into the active runtime asset ids.

Before promotion, exercise each functional unit in the actual Unity renderer:

- instantiate the building from its individual manifest;
- drive `door_slide` from streamed authoritative door state and confirm the
  visual threshold agrees with blocker enable/disable behavior;
- enter and exit through the doorway and prove the real floor remains;
- trigger the existing cutaway hysteresis/fade while preserving doors and
  interior-keep nodes;
- load existing promoted characters, clothing/equipment, and representative
  inventory/world items beside and inside it without asset replacement;
- verify interaction targeting and terminal/NPC approach clearances;
- capture console-clean exterior, door-open/closed, and interior frames.

## Required source-stage deliverables

Place editable study code under
`tools/successor/assets/dustgate-redesign/`. Place generated `.blend`, GLB,
render, contact-sheet, crop, and numeric proof artifacts under the ignored
directory
`verification/ledgers/artifacts/dustgate-opus5-20260729/`.

Required files:

1. A direction record explaining the three studies, selected direction,
   measured visual rules, palette/material families, modular kit, and rejected
   alternatives.
2. A renderer-neutral selected-layout JSON proposal.
3. Deterministic Blender builder and render scripts.
4. Independent clone, commerce, and shelter blockout `.blend`/GLB units plus a
   selected holistic assembly used only for layout review.
5. A numeric QA report with bounds, clearances, mesh/material/triangle counts,
   ground contact, node families, and layout consistency.
6. A world-item selection record with accepted, conditional, and rejected
   catalog candidates plus measured placement/clearance plans.
7. A naming record with the screened shortlist and selected replacement
   display name.
8. A proof packet containing:
   - equal-framing views of all three direction studies;
   - selected-layout top view;
   - front, back, left, right, top/three-quarter, and normal gameplay views;
   - close crops of each building's threshold/contact, primary functional
     detail, and worst-risk cutaway seam or functional side;
   - an exterior and cutaway/interior gameplay frame with scale proxies.

## Iteration and acceptance

- A first plausible render is not completion.
- Run at least two build, measure, render, and close-inspection passes on the
  selected direction.
- Validate every review GLB with glTF Transform/Khronos validation and inspect
  its actual scene/mesh/material report.
- Reopen or reload the fresh export before final render/runtime proof to avoid
  stale Blender state.
- Inspect the required crops at pixel scale and make at least one deliberate
  correction based on measured or visible evidence.
- Report compromises honestly. Do not call the study integrated, canonical,
  final, production-ready, or runtime-proven until the later promotion lane
  earns those claims.
