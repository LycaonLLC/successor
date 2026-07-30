# Successor Asset Pipeline

Status: current promotion workflow for 3D assets, code-native visuals, and
audio. Art decisions come from `ART_DIRECTION.md`; provenance requirements
come from `ASSET_PROVENANCE_POLICY.md`.

## Maturity states

Every content item is one of:

- **Source**: editable work, deterministic builder, experiment, or purchased
  candidate. It is not promised to load in the game.
- **Cataloged**: stable id, manifest/registry entry, loadable runtime asset, and
  provenance. It may not appear in the generated world.
- **Integrated**: selected by current gameplay or fixture data and exercised in
  the consuming client.

Do not call a file integrated because it sits under `public/`.

## Source and runtime roots

| Kind | Source | Runtime |
| --- | --- | --- |
| Humanoids, rigged equipment, animations, weapons | Bunker `~/dev/games/pawn-forge/pawnforgev2/` | `client-3d/public/assets/pawn-pack/` |
| Creatures | Blender/build recipes in the active media/source workspace | `client-3d/public/assets/creatures/` |
| Items, crops, food, tools, medical and gene-lab models | deterministic builders or `.blend` sources | `client-3d/public/assets/items/` |
| Curated world props | deterministic builders or source models | `client-3d/public/assets/world-items/` |
| Purchased selection library | licensed source pack | `client-3d/public/assets/trial-props/` |
| Shaders and effects | TypeScript/GLSL source | `client-3d/src/render/` |
| UI icons | code-native SVG or reviewed source | `client-3d/src/ui/` and `client-3d/public/assets/ui/` |
| Audio | source/project manifest | `client/public/successor-audio/` |
| World data | fixture generator | `client/public/successor-slice/` |

Generated asset-lab thumbnails and catalogs are ignored local cache.

## GLB loop

1. Read the consuming runtime first: scale, axis, ground plane, material path,
   socket, node names, animation names, bounds, and registry schema.
2. Write a short form/behavior contract with measurable acceptance checks.
3. Build from an editable `.blend` or deterministic Blender script.
4. Validate mesh, transforms, materials, clips, sockets, bounds, collision, and
   declared footprint.
5. Render matched camera angles and inspect through the Successor camera and
   post stack.
6. Promote one stable runtime id and preserve its source recipe, provenance,
   manifest, and checks.
7. Wire the correct registry and add a focused load/presentation test.

Use `blender-glb-asset-iteration` for measured Blender-to-GLB changes. Reopen
the exported GLB during QA; a healthy `.blend` does not prove the export.

## PawnForge contract

The external PawnForge checkout is the source of humanoid bodies, rigged
equipment, attachment sockets, and animation packs. Before exporting, verify
the current `CONTRACT.md`, template manifest, and harness rather than copying
constants from documentation.

The promotion packet includes:

- source `.blend` or deterministic builder;
- exported GLB;
- attachment metadata where applicable;
- animation or equipment manifest changes;
- scale/bounds/socket verification;
- matched-camera renders;
- provenance and review note with the exported GLB's exact SHA-256.

The fixed two-piece starter outfit is a promoted PawnForge contract: the
accepted `boots_canvas_ankle` runtime GLB hash is
`sha256:84a8472ecb14636b57619078d7cf8704ad35f8d1bf709a1cd7b4fd3a55c266cc`,
recorded in its provenance sidecar under
`client-3d/public/assets/pawn-pack/equipment/Under/`. A replacement boot
export is not accepted until its headed fit evidence and provenance hash are
updated together.

`client-3d/scripts/sync-pawn-pack.mjs` copies the approved pack into the game
client. Review its diff; sync is not an approval step.

## Materials by consumer

Material handling differs by render path:

- world props use the conversion in `render/props.ts`;
- pawn bodies and wearable equipment use PawnForge tint/material rules;
- held weapons use the weapon conversion and attachment rig;
- inventory turntables preserve authored materials under their own light rig;
- creature models use the creature material path in `render/pawns.ts`.

Author against the actual consumer. A material that looks correct in Blender
may become flat, white, overbright, or unreadable after conversion and post.

## Structures and collision

Human buildings split roof, near walls, far walls, floor, interior, and doors
into predictable nodes. Doors retain valid pivots and a manifest describing
motion. Collision metadata uses the same footprint and door geometry as the
authority.

Collision ships as a mesh-derived sidecar (`<glb>_collision.json`) referenced
from the model manifest as a structural-only proxy. Both Dustgate facility
sidecars are emitted directly at schema `successor.structure-collision.v3` by
their deterministic builders: the cloning facility
(`tools/successor/assets/build_cloning_facility.py`) carries nine stable
structural proxy boxes plus the `closed_door_panel` door blocker, and the
commerce facility (`tools/successor/assets/build_commerce_facility.py`)
carries its wall boxes, 15 named furniture blockers, and a door blocker.
Those sidecar boxes are the collision authority; detail meshes never are.
Older sidecars (house, pod tent) were extracted by
`tools/successor/extract-structure-collision.mjs` and remain on v2. The
cloning facility's authored floor is 0.02 m; the runtime floor after the
fixture's uniform fit is 0.021052631578947368 m. Cutaway hide sets never
include the floor, the interior keep set, or the door.

Large monuments are modular. Keep atom dimensions, integer footprints, origin,
orientation, placement class, and material bands in a machine-readable kit
manifest. Multi-screen forms are assemblies of modules so the world can stream
and instance them.

## Creatures and crops

Creature promotion requires measured adult bounds, grounded locomotion, species
id, runtime GLB mapping, selection bounds, and calm/flee/damage/death review.

Each crop species keeps the four world stages together with seed and produce
models. The item registry, crop renderer, and authoritative crop stage names
must agree. A stage set is promoted as one contract.

## Code-native visuals

Shaders, post passes, particles, beams, shields, status effects, weather, and
procedural geometry are source assets even though they are code. Promotion
requires:

- an explicit event or renderer hook;
- bounded allocation and cleanup;
- deterministic configuration where gameplay timing matters;
- a focused unit or visual-lab test;
- proof under the final post chain.

Preserve good source-stage effects that are not yet selected. Label their
maturity in the current-state inventory instead of adding fake fixture hooks.

## Trial-prop library

The purchased trial-prop tree is a selection library. Do not instantiate it by
path from fixture data. Promote a candidate by assigning a Successor id, copying
or mapping the approved model through the runtime registry, documenting its
license/provenance, checking scale/materials/collision, and proving it in the
game camera. Unselected candidates remain cataloged.

## Audio loop

1. Define the gameplay or ambience event and duration/loop requirement.
2. Generate or edit at source quality and record provenance.
3. Trim, de-click, normalize, and test loop seams where applicable.
4. Add one stable runtime audio id and manifest entry.
5. Verify triggering, spatial behavior, concurrency, and mix in the client.

Dedicated sounds should be removed when their only gameplay event is removed.

## World generation

`configure-open-desert-fixture.mjs` owns logical world source. The compiler
produces a renderer-neutral bundle and verifies it exactly. Art registries map
logical prop ids to GLBs; the world generator does not encode mesh paths or
render frames.

## Promotion checklist

- source and license are known;
- runtime id is stable and non-duplicated;
- provenance is stored beside the asset or in its source recipe;
- scale, pivot, bounds, sockets, materials, and clips pass;
- registry/manifest references resolve;
- focused tests pass;
- graphical assets were reviewed in camera and after post;
- desktop packaging was rebuilt if runtime assets changed;
- generated caches and large review dumps are not staged as source.
