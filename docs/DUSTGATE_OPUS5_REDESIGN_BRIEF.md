# Dustgate Opus-5 Redesign Brief

Status: experimental source-stage art and layout brief, 2026-07-29.

This document coordinates a from-zero redesign study. It does not override
`CANONICAL_CONTEXT.md`, `ART_DIRECTION.md`, the generated world fixture, Rust
authority, or the active Three.js and Unity assets. Nothing produced by this
study is integrated until it passes the repository's asset, geometry,
authority, runtime, and packaging gates.

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
- A neutral 1.75 m capsule or similarly plain proxy for player scale.

## Inputs that must not be used

- Do not open, import, trace, render, modify, or copy
  `cloning_facility.glb`, `commerce_facility.glb`, `house_h1.glb`, their
  textures, or their source geometry.
- Do not use the current facility builder scripts as form-generation input.
  They may be consulted only after a new direction exists, and then only to
  compare interface/export requirements.
- Do not use screenshots or renders of the current buildings as visual
  references.
- Do not treat the current player, clothing, terminals, or equippables as the
  new environment's style baseline. Their scale and logical function may be
  preserved.
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

## Geometry and export contract

Use an editable `.blend` file generated by deterministic Blender Python as the
source of truth. Never hand-edit an exported GLB.

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
4. A selected blockout `.blend` and review GLB.
5. A numeric QA report with bounds, clearances, mesh/material/triangle counts,
   ground contact, node families, and layout consistency.
6. A proof packet containing:
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

