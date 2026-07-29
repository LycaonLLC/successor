# Opus-5 Production Task: Turn the Starting-Settlement Study Into Real Building Units

Continue as the lead 3-D environment designer and technical artist for
Successor. This is an implementation and iteration task, not a recommendation
or a concept-only exercise.

Read, completely:

1. `AGENTS.md` and the canonical documents it routes to;
2. `docs/DUSTGATE_OPUS5_REDESIGN_BRIEF.md`;
3. `tools/successor/assets/dustgate-redesign/DIRECTION_RECORD.md`;
4. `tools/successor/assets/dustgate-redesign/EXISTING_WORLD_ITEM_AUDIT.md`;
5. the current renderer code and tests for prop mapping, authority-driven
   sliding doors, cutaways, manifests, and
   `successor.structure-collision.v3`.

The first Leeward Terrace pass is an honest massing study, not the quality bar.
Its layout measurements and camera discoveries are evidence. Its rectangular
primitive forms, sparse interiors, flat materials, global-looking pivots,
high object count, and current details are not sacred. Rebuild or materially
change them wherever necessary to make the architecture look authored,
specific, and production-grade from both normal gameplay distance and close
inspection.

## Binding interpretation

- This is not one hero scene. Clone, commerce, and shelter are independently
  authored, independently placeable building products.
- The settlement assembly is only a layout, compatibility, and holistic
  art-direction test bed. Never join or bake its buildings or reusable props.
- Preserve the existing promoted player/body, character customization,
  clothes, equipment, inventory items, world items, and interaction
  contracts. They are compatibility inputs, not architecture style baselines.
- Inspect and reuse strong Grok-authored/promoted world items before making a
  new prop. Keep them external and instanced through ids/manifests.
- Resolve every source-library candidate through the latest-lineage table in
  `EXISTING_WORLD_ITEM_AUDIT.md`. Never default to a shallow manifest or judge,
  copy, or place an obsolete sibling. A later bounded batch supersedes only
  exact ids it contains. Pin the final input by exact relative path and actual
  SHA-256 before generation begins.
- There are no roads, paths, lanes, travel aprons, connective paving,
  route-shaped terrain marks, curbs, traffic/road furniture, or implied
  corridors.
- Existing facility/house geometry remains forbidden input. Do not open,
  import, trace, render, or copy the old building GLBs, textures, source
  geometry, builders as form input, or screenshots. Standalone current
  terminal, pod, furniture, equipment, and world-item assets may be inspected
  because those are preserved integration inputs.
- Do not mutate active runtime assets, fixture data, authority, existing
  renderers, canonical ids, credentials, remotes, or unrelated files in this
  lane. Do not commit or push.

## First correct the asset architecture

The existing study reports settlement-space door pivots such as `8.9` and
`21.5`; that is not a trustworthy standalone-origin contract. Correct it.

For each building:

- generate in structure-local coordinates with a deliberate origin near the
  footprint center, exported ground contact at local Y=0, and front `+Z`;
- declare source and export basis explicitly;
- emit a standalone deterministic builder entry point, editable `.blend`,
  LOD0 GLB, manifest, v3 collision sidecar, QA JSON, and proof directory;
- make the combined settlement assembler instance that standalone asset at a
  map transform without changing or duplicating its internal geometry;
- prove the standalone GLB retains correct bounds/origin when loaded by itself.

Do not author hundreds of one-cube render meshes. Consolidate static geometry
by functional family/material where possible. Ancestor transforms or empties
may carry the required node-family name so the renderer contract remains
addressable without turning every trim piece into a draw call. Record actual
renderer/primitive/material/draw-call counts from the fresh export.

## Functional-unit contract

Every enterable building must behave like the real renderer asset, not facade
theater.

### Sliding door

- Exact independently addressable transform named `door_slide`.
- Closed pose is the authored/default local transform.
- Declared normalized local slide axis and measured travel distance.
- Travel fully clears the measured opening without clipping a jamb, rail,
  retained mass, prop, or interaction approach.
- Export `door_open` and `door_close` translation clips for interchange
  parity, while remaining compatible with Unity/Three presentation that
  streams `propStates[propId].doorOpen` and drives the transform directly.
- Emit a local closed-door blocker in the v3 collision sidecar with node
  `door_slide`.
- Numerically prove closed visual panel/blocker overlap and open visual
  clearance. Record the blocker-disabled/open state expected from authority.
- Render the exact standalone fresh export in closed, half-open, and fully open
  states plus a threshold transit crop.

### Interior and cutaway

- `floor__*` and `door_slide` always remain.
- `interior__*` contains retained built-in interior surfaces/fixtures.
- `wall_front__*`, `wall_right__*`, `wall_back__*`, `wall_left__*`, and
  `roof__*` are independently classifiable.
- Manifest declares reveal/keep faces and interior regions.
- Sidecar declares structural wall boxes, furniture/fixture blockers,
  walkable interior regions, floor top, footprint, and door blocker.
- Cutaway proof must show a composed interior, not sparse boxes, and must not
  leave arbitrary retained-mass shadows across the revealed floor.

### Gameplay clearances

- Fit and record a 1.75 m human proxy plus representative actual character,
  clothing/equipment, and item bounds.
- Keep terminal/item interaction sockets and approach envelopes clear.
- Clone respawn must have a direct, measured walkable egress to the door. The
  current skipped/blocked `front_cell` behavior is a QA defect, not a valid
  pass. Gate the actual respawn point, facing space, threshold, and continuous
  route against walls, furniture, and the closed/open door semantics.
- Keep ordinary spawn, Knox Vale, GR0K, travel-terminal, and targeting
  clearances legible in the holistic layout proposal.

## Interior program and existing item use

Perform an actual normal-camera audit of the conditional/high-confidence GLBs
listed in `EXISTING_WORLD_ITEM_AUDIT.md`. Update that record with selected,
conditional, and rejected ids plus visual evidence. For every selected item,
record hash, source manifest, dimensions, origin/socket, local placement,
clearance, collision handling, promotion state, and intended runtime loader.

Treat lineage resolution as a blocking preflight for item use:

1. use the active runtime artifact for an already promoted id;
2. otherwise resolve the exact source id through the audit's lane table;
3. verify the actual file SHA-256 against the pinned record/report;
4. inspect the proof and GLB from that exact lineage;
5. exclude all older shallow, smoke, proof-copy, and rejected siblings.

The corrected latest extraction parent is materially better than its obsolete
shallow predecessor and must receive a fair audit. Test its listed power skid,
control panel, maintenance cart, survey equipment, dust filter, separator,
manifold, and core sampler at their real scale where functionally plausible.
Do not force them into an interior by shrinking them. The latest medical reset
and most infrastructure variants remain visually weak; do not use them merely
because they are newer or numerically valid.

At minimum test these functional combinations:

- clone: actual current clone pod and clone terminal; Grok battery bank,
  folding workbench, service tool cabinet, and task light where they fit;
- commerce: actual current bank, trade, and Player Association terminals;
  Grok cargo crates plus restrained shelving/storage where they fit;
- shelter: actual current footlocker plus a reviewed bunk/bedroll, water tank,
  storage, and lighting where they fit;
- assembly: actual current Grok wedge travel terminal, real existing
  player/character/equipment assets, Knox Vale compatibility, and GR0K
  compatibility.

These are tests, not a requirement to keep an asset that fails visual,
clearance, provenance, or performance review. Do not replace a failed
preserved item incidentally; record a separate future item-remake proposal.
Never embed selected item meshes in the building GLBs.

## Production visual pass

Advance far beyond the flat blockout:

- authored hard-surface topology with purposeful bevels, joins, panel depth,
  drainage, weather shielding, repairs, and believable ground contact;
- distinct clone, commerce, and shelter silhouettes within one measured shared
  construction grammar;
- complete interior compositions with clear functional zones and actual
  reusable item anchors;
- real UV0 on every visible production mesh, consistent texel density, and no
  accidental overlaps;
- glTF-friendly PBR albedo, normal, and ORM/metal-roughness texture authoring,
  with restrained large-scale wear and material response rather than noisy
  generated scratches;
- HDRP-quality LOD0 plus measured LOD1/LOD2 outputs or deterministic generation
  steps that preserve the door, floor, opening, and collision silhouette;
- no tiny text, texture-only interaction cues, arbitrary greeble noise, generic
  clean-NASA base, contemporary military base, suburb, or neon cyberpunk look.

Texture outputs and binary/proof artifacts belong under the ignored root:

`verification/ledgers/artifacts/dustgate-opus5-production-20260729/`

Editable deterministic source code and records belong under:

`tools/successor/assets/dustgate-redesign/`

## Naming

`Dustgate` is only the legacy mechanical label. Produce 8–12 considered,
resident-credible replacement display names, check repository conflicts and
obvious product/real-world baggage, and select the strongest. Avoid generic
`dust/sand/ash` plus `gate/port/outpost/haven` compounds. Record pronunciation,
rationale, and resident usage in `NAMING_RECORD.md`. Do not rename runtime ids
or paths in this lane.

## Mandatory iteration and proof

Use a todo list. Work autonomously and inspect your own results.

1. Create equal-framing normal-game-camera and close-review baseline renders
   of each standalone study asset.
2. Run at least three visible build/measure/render/close-inspection correction
   rounds per building. Record what each round changed and why.
3. Render every standalone unit from cardinal sides, top/three-quarter,
   normal gameplay, door closed/half/open, threshold crop, contact crop,
   functional-detail crop, worst seam/topology crop, and cutaway interior.
4. Render the holistic assembly only after standalone proof exists. Include
   actual external item/character instances and natural terrain, never a road
   substitute.
5. Export fresh standalone GLBs, reopen/reload each export, then produce the
   final proof.
6. Run Blender numeric QA and glTF Transform/Khronos `inspect` and `validate`
   on every LOD0/LOD1/LOD2 output.
7. Check UV attributes, texture references/embedding, animations, exact node
   names, local origins, bounds, ground contact, triangles, renderer
   primitives, materials, and draw calls from the actual GLBs.
8. Run focused structure/layout QA, `pnpm verify:successor-context`,
   `bash tools/denylist/check.sh`, and `git diff --check`.

Do not stop at a plan, naming list, asset audit, first plausible render, or
blockout. If a pass still looks generic or sparse, iterate. Report honestly
what is source-proven and what still requires fixture/Rust/Unity runtime
integration; do not call this canonical, integrated, final, or runtime-proven.
