# Fresh Market Building Rebuild

This is a blind, held-out asset experiment. Build a new, production-quality
market building for Successor from first principles.

## Isolation rule

Do not inspect, open, search, copy, import, or derive from any existing or
previous market/commerce building, its generator, its `.blend`/GLB, its
textures, screenshots, manifests, collision sidecars, or prior redesign
briefs. In particular, all of these are forbidden reference material:

- `tools/successor/assets/build_commerce_facility.py`
- `client-3d/public/assets/world-items/commerce_facility*`
- `client-3d/public/assets/world-items/commerce_*`
- `tools/successor/assets/dustgate-redesign/`
- any prior Opus market/building render or experiment

Do not replace or modify the currently integrated building. Work only inside
`tools/successor/assets/market-opus5-rebuild/`, apart from using explicitly
allowed loose props as read-only imports.

You have no visual reference image and no inherited art-direction document.
Choose and document a fresh, coherent design language suitable for a serious
hard-surface science-fiction settlement on an inhabited desert planet. The
game uses a locked north-up, pitched orthographic camera, but the building
must also hold up at human eye level and in close interior views.

The rejected failure mode is a dressed rectangular shed with repeated wall
panels. Author an actual building: intentional architectural massing,
structure, facade hierarchy, entry sequence, roof line, rear/service logic,
interior zoning, built-ins, lighting, material transitions, and wear that
responds to use and environment. Repetition may support construction logic,
but it must not read as a texture or panel stamp tiled across every surface.

## Functional contract

The asset must be capable of replacing the current 12-by-9-cell market without
changing game authority:

- Asset axes: `+Y` up, `+Z` is the public/front side.
- Maximum authored footprint: 11.4 m by 8.55 m, centered at the origin.
- Floor top: `Y=0.02 m`; walkable interior must remain comfortably inside the
  footprint.
- One unmistakable public entrance faces `+Z`.
- Create a genuinely modeled sliding door from scratch. The movable root node
  must be named exactly `door_slide`. It must have collision-safe fully closed
  and fully open states, travel laterally in local space, and provide
  `door_open` and `door_close` animation clips of 0.8 seconds. The runtime also
  drives this node directly, so record the exact local axis and distance.
- Segment cutaway parts with these prefixes:
  `roof__`, `wall_front__`, `wall_back__`, `wall_left__`, and
  `wall_right__`. Permanent floor/interior parts use `floor__` and
  `interior__`. The door must never be parented under a cutaway-hidden node.
- Preserve clear interaction space around these local fixture cells:
  bank `(3,3)`, trade `(6,3)`, association `(9,3)`, and trainer `(10,6)`,
  where cells are measured from the north-west corner of the 12-by-9 footprint.
- The interior must provide readable, usable zones for:
  a bank/private-value service point, a trade/exchange service point, a player
  association registry point, at least one small vendor/display area, a
  trainer consultation spot, circulation/queuing, and plausible
  storage/back-of-house or service access.
- Imported interactable terminals must face a reachable customer position.
  Do not bury them in counters or use them as visual clutter.
- Create an explicit `successor.structure-collision.v3` sidecar from named,
  simple authored proxies for outer structure, built-in furniture, and the
  closed door. Decorative detail never becomes collision. Terminal/trainer
  cells and the door path must be proven clear.
- No roads, road markings, wheeled-traffic language, or asphalt belong in this
  universe.

## Allowed read-only loose props

Only the items listed in `ALLOWED_PROPS.md` may be imported from the current
runtime library. Use them selectively; they are furnishing, not a substitute
for architectural authorship. The shell, foundation/floor, roof, facade,
entry, door, built-in counters/shelving, architectural lighting fixtures,
UVs, and building materials/textures must all be newly created here.

Do not reuse any file whose name begins `commerce_`, including the material
maps used by the allowed terminal GLBs. An allowed terminal may retain its own
embedded material when imported as a separate loose prop, but it must not
dictate or supply the new building material system.

## Authoring and quality requirements

- Treat a deterministic Blender Python generator as source of truth. Keep the
  script readable and parameterized by architectural subsystem rather than
  emitting one opaque mesh.
- Save an editable final `.blend` plus at least one numbered pre-final
  checkpoint.
- Use real UVs and newly authored PBR maps: base color, tangent normal, and
  packed metallic/roughness/AO or equivalent. Establish consistent texel
  density, gutters, and non-overlapping bake UVs where required.
- Build material variation at sensible architectural scales. Add localized
  contact grime, abrasion, dust deposition, edge response, service markings,
  and unique focal details without painting noise uniformly over everything.
- Avoid generated text and fake glyph soup. Geometric identifiers or a few
  deliberate abstract marks are acceptable.
- Give exterior, roof, entrance, interior, and rear/service side all an
  authored finish. Do not hide unfinished geometry behind the top-down camera.
- Target at most 90,000 triangles for LOD0, 45,000 for LOD1, and 20,000 for
  LOD2, excluding separately instanced loose props. Keep material count and
  texture memory credible for a browser client.
- Export fresh GLBs for LOD0/LOD1/LOD2 and a manifest recording dimensions,
  triangle/material/texture counts, door contract, cutaway prefixes, interior
  bounds, prop provenance, and file hashes.
- Validate every GLB strictly with `@gltf-transform/cli validate` and inspect
  it. Prove that the final LOD0 can load through Three.js `GLTFLoader`, that
  the required nodes/clips survive export, and that all textures resolve.

## Mandatory iteration loop

Do not stop at the first plausible render.

1. Make an architectural blockout and render exterior, overhead, cutaway
   interior, entrance, and rear/service views.
2. Write a blunt visual self-critique identifying generic massing, lazy
   repetition, weak hierarchy, scale errors, unfinished sides, poor material
   response, circulation problems, and anything that reads below
   production-quality.
3. Rebuild the weak systems, not merely their colors. Complete materials/UVs,
   detailing, loose-prop placement, door behavior, and collision.
4. Render a second full inspection pass. Inspect close crops for the entrance
   and door, primary facade detail, floor/wall contact, main service counter,
   worst UV seam, and rear/service side.
5. Make and verify at least one substantive correction after that second
   inspection before producing the final proof set.

The final proof set must include front, back, left, right, top, exterior
three-quarter, gameplay-distance orthographic, roof-off interior overview,
human-eye-level interior, door closed, door open, and the mandatory close
crops. Use unflattering diagnostic lighting in addition to beauty lighting
where it helps expose defects.

Record exact build, validation, measurement, render, and loader-proof commands
in `REPORT.md`. Name compromises honestly. Completion is the verified asset
package and evidence, not a prose plan.
