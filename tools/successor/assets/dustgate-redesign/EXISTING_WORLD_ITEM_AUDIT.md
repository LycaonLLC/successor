# Existing World-Item Audit for the Starting Settlement

Status: first visual and manifest triage, 2026-07-29. This is an input to the
Opus-5 production pass, not a promotion decision.

## Inventory boundary

The editable Successor-oriented source manifests currently contain 1,849
primary entries across the July 18–20 Grok/content waves:

- `props/successor/everyday-wave-20260719/*/manifest.json`;
- `props/successor/homebuilder-wave-20260719/*/manifest.json`;
- `props/successor/full-spectrum-wave-20260720/*/manifest.json`;
- `props/successor/grok45-wave-20260718/*/manifest.json`;
- `props/vehicles/successor/grok45-wave-20260718/*/manifest.json`.

The broader `source-assets/props` tree contains 3,476 GLBs because it also
contains proof copies, superseded iterations, rejected lanes, and unrelated
libraries. The active Three.js runtime has 55 promoted GLBs under
`client-3d/public/assets/world-items/`.

Therefore:

1. select by the primary manifest and report, never by walking every GLB;
2. honor `files.glb`, editable source, hash, provenance, socket, and collision
   records;
3. visually inspect the proof and then inspect the actual GLB in engine;
4. never promote a rejected/proof duplicate by accident.

## First-pass evidence

The first pass inspected manifest records and proof collages for representative
items from everyday props, reinforced furniture, infrastructure/computing,
medical/bio, modular pipes, extraction installations, and vehicle components.
It also checked the current runtime mapping and recent promoted-asset catalog.

The pass deliberately separates generator validity from art usefulness.
Several libraries report `PASS` while their representative proof is extremely
repetitive or visually placeholder-like.

## High-confidence reuse candidates

These Grok vehicle-component assets have the strongest representative proof,
measured origins/sockets, clean Khronos validation in their reports, and two
recorded visual correction passes. They should be tested as independent
interior/exterior props:

| Asset id | Initial use | Reported cost / fit |
| --- | --- | --- |
| `successor_vehicle_component_cargo_crate_small` | commerce stock and service storage | 3,680 tris, 6 draw calls, visual passes 2 |
| `successor_vehicle_component_cargo_crate_long` | commerce stock wall or shelter storage | use the manifest/report clearance envelope |
| `successor_vehicle_component_workbench_fold` | clone maintenance or shelter utility surface | 2,420 tris, 6 draw calls, visual passes 2 |
| `successor_vehicle_component_battery_bank_quad` | clone-facility power plant | 4,352 tris, 6 draw calls, 1.551 × 1.064 × 0.554 m, visual passes 2 |
| `successor_vehicle_component_utility_water_tank` | shelter water system | 2,928 manifest tris / 3,432 final report tris, 5 draw calls, 0.86 × 0.67 × 0.773 m, visual passes 2 |
| `successor_vehicle_component_rear_worklight` | mounted task lighting | 1,472 tris, 6 draw calls, visual passes 2 |
| `successor_vehicle_component_service_tool_cabinet` | clone maintenance wall | 4,372 manifest tris / 5,948 final report tris, 6 draw calls, 0.94 × 0.325 × 1.088 m, visual passes 2 |

The manifest/report triangle differences on two final assets must be resolved
against the actual selected GLB hash before promotion. Do not copy these meshes
into a structure GLB; instantiate them through a prop manifest and preserve
their mount sockets.

The already promoted
`travel_terminal_grok_wedge.glb` is also high confidence. Existing repository
evidence records 2,948 triangles, six UV-mapped modules, embedded 2048 maps,
`Socket_use`, `Socket_screen_center`, and runtime screen animation proof.
Retain its actual item/interaction contract and design its local setting
around it.

## Conditional candidates

These shapes can support the new buildings, but the production pass must test
their actual material response and gameplay-camera read before selecting them:

- everyday `workbench`, `shelf_unit`, `chest_trunk`, `bedroll`,
  `barrel_rain`, and `wooden_crate_open`;
- reinforced home `bunk_bed`, `open_shelving`, `base_cabinet`, and
  `wall_sconce`;
- modular-pipe `manifold_057`, `valve_064`, `gauge_077`, `pump_091`, and
  `filter_085`;
- current promoted clone pod/terminal, bank/trade/PA terminals, frontier
  footlocker, work benches, industrial battery pack, communications antenna,
  heavy cargo crate, rooftop air conditioner, and frontier water tank.

The current promoted terminal and item assets are preserved compatibility
inputs. If one is visually rejected later, record that as a separate item
remake proposal; do not replace it incidentally inside an architecture pass.

## Hold or reject for this direction

- Representative `extraction-installations` proof for control panels, power
  skids, dust filter, maintenance cart, and survey tripod renders as nearly
  identical rounded box-and-cap forms. Do not use those merely because their
  lane reports `PASS`.
- Representative `medical-bio-lab` equipment repeats a cylinder-plus-red-block
  grammar across analyzers, incubators, autoclaves, monitors, lamps, and
  oxygenators. It is too weak for the clone facility's primary read. Tiny shelf
  dressing may be reconsidered only after isolated runtime inspection.
- Representative infrastructure/computing terminal, antenna, and sensor
  variants are highly repetitive and their current proof framing is too weak
  to establish production quality. Hold until an isolated normal-camera
  runtime audit says otherwise.
- Everyday/home assets are intentionally simple. Use a few for human scale and
  occupancy, not enough to drag the architecture back toward generic domestic
  furniture.

## Production-pass requirements

Before building interiors:

1. Render a compact normal-camera audit sheet of the actual conditional GLBs.
2. Record the selected GLB hash, dimensions, origin, mount transform, material
   behavior, and clearance envelope.
3. Assign every selected item to a functional anchor in clone, commerce,
   shelter, or the settlement assembly.
4. Keep walkable and interaction approach cells clear in the layout/sidecars.
5. Use the actual runtime loader in Unity proof; no embedded copies and no
   primitive replacements.
6. Budget repeated props as instances and author LOD/material variants only
   through explicit, reversible item-pipeline work.
