# Existing World-Item Audit for the Starting Settlement

Status: lineage-corrected visual and manifest triage, 2026-07-29. This is an
input to the Opus-5 production pass, not a promotion decision.

## Inventory boundary

The shallow Successor-oriented source manifests contain 1,849 entries across
the July 18–20 Grok/content waves:

- `props/successor/everyday-wave-20260719/*/manifest.json`;
- `props/successor/homebuilder-wave-20260719/*/manifest.json`;
- `props/successor/full-spectrum-wave-20260720/*/manifest.json`;
- `props/successor/grok45-wave-20260718/*/manifest.json`;
- `props/vehicles/successor/grok45-wave-20260718/*/manifest.json`.

Those shallow manifests are inventory evidence, not a latest-output resolver.
Several lanes were subsequently rebuilt under `parent-reset-01`,
`proof-batch-grok45-*`, `reset-zero-01`, or an item-specific canonical child.
The broader `source-assets/props` tree contains 3,476 GLBs because it also
contains proof copies, superseded iterations, rejected lanes, and unrelated
libraries. The active Three.js runtime has 55 promoted GLBs under
`client-3d/public/assets/world-items/`.

Therefore:

1. resolve lineage per lane and then per asset id; the top-level manifest is
   not automatically latest;
2. a later bounded proof/reset folder supersedes a parent only for the exact
   ids it contains, never for the unrepresented remainder of a lane;
3. for an already promoted id, load the active runtime artifact for integration
   proof unless a separate promotion/remake is explicitly accepted;
4. pin the final artifact by exact relative path and actual file SHA-256, not
   only by folder name, geometry hash, or a report copied from another host;
5. honor editable source, provenance, sockets, collision records, dimensions,
   and clearance records;
6. visually inspect the selected lineage proof and then the actual GLB in
   engine;
7. never promote a rejected, proof-copy, or superseded duplicate by accident.

## Latest-lineage resolver

Source root on the Mac is `~/dev/games/source-assets/`. The July source-assets
worktree is mostly untracked, so Git history alone cannot establish recency.
The resolver below was checked against batch ids, embedded reports/summaries,
coverage counts, file modification order, and actual artifact hashes. It is
the starting point for this pass; any later item-specific correction must be
recorded explicitly rather than inferred from directory depth.

| Wave / lane | Latest usable lineage for ids in this pass | Coverage / note |
| --- | --- | --- |
| vehicle Grok-4.5 / components | `props/vehicles/successor/grok45-wave-20260718/components/` | single-root wave, 124 manifest entries; no later child lineage |
| profession world weapons | `props/successor/grok45-wave-20260718/profession-world-weapons/` | single-root wave, 125 entries; not architecture input |
| everyday / world props | `props/successor/everyday-wave-20260719/everyday-world-props/` | single-root wave, 125 entries |
| homebuilder / furniture | `props/successor/homebuilder-wave-20260719/furniture/` | single-root wave, 125 entries |
| homebuilder / components | `props/successor/homebuilder-wave-20260719/building-components/` | single-root wave, 125 entries; do not use as form input for the from-zero buildings |
| full spectrum / ammunition | `props/successor/full-spectrum-wave-20260720/ammunition-packaging/parent-reset-01/` | 125 GLBs/proof collages; four ids have later targeted rebuilds in the same lineage |
| full spectrum / contraband | `props/successor/full-spectrum-wave-20260720/contraband-chemicals/parent-reset-01/` | full 125/125 build report |
| full spectrum / extraction | `props/successor/full-spectrum-wave-20260720/extraction-installations/parent-reset-01/` | full 50-id manifest and proof; materially supersedes the shallow placeholder generation |
| full spectrum / infrastructure | `props/successor/full-spectrum-wave-20260720/infrastructure-computing/parent-reset-01/` | full 150/150 rebuilt report; supersedes the earlier ten-item Grok proof batch |
| full spectrum / medical/bio | `props/successor/full-spectrum-wave-20260720/medical-bio-lab/parent-reset-01/` | full 150-id summary plus five precursor smoke ids; use the numbered full-lane ids, not the smoke duplicates |
| full spectrum / fluid pipes | `props/successor/full-spectrum-wave-20260720/modular-fluid-pipes/parent-reset-01/` | full 125/125 build report; several individual reports reflect later fixes than the batch summary |
| full spectrum / handhelds | `props/successor/full-spectrum-wave-20260720/scifi-handhelds/parent-reset-01/` | 125 GLBs/reports/proof; visual status remains hold/review-required |
| full spectrum / weapons | resolve per exact weapon id | `canonical-rebuild-01/shear_mk1/` is later only for Shear Mk-I; do not apply it to the rest of the lane |

The earlier `proof-batch-grok45-*` outputs remain provenance and comparison
evidence. They are not the default source when a later full-lane parent reset
covers the same id. Conversely, an item-specific later rebuild never promotes
unrelated siblings merely because its directory is newer.

The browser Asset Lab mirror at
`client-3d/public/assets/wave-props/manifest.json` currently exposes 2,097
wave entries. The reviewed extraction, infrastructure, pipe, and vehicle
candidate copies match the selected source GLBs byte-for-byte by SHA-256, so
that mirror is valid for the current visual lab. It is not a general lineage
authority: `client-3d/tools/build-wave-props.mjs` currently chooses one reset
directory for an entire lane and cannot overlay a later bounded correction for
only matching ids. Always re-check source lineage before regenerating that
catalog or promoting an item.

## First-pass evidence

The first pass inspected manifest records and proof collages for representative
items from everyday props, reinforced furniture, infrastructure/computing,
medical/bio, modular pipes, extraction installations, and vehicle components.
The corrected pass then re-inspected the actual latest
`extraction-installations/parent-reset-01`,
`infrastructure-computing/parent-reset-01`,
`medical-bio-lab/parent-reset-01`, and
`modular-fluid-pipes/parent-reset-01` proof rather than judging their obsolete
shallow or bounded predecessor outputs. It also checked the current runtime
mapping and recent promoted-asset catalog.

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
- latest extraction-parent `mineral_power_skid`, `mineral_control_panel`,
  `extraction_maintenance_cart`, `extraction_survey_tripod`,
  `mineral_survey_scanner`, `mineral_dust_filter`,
  `petrochemical_separator_skid`, `petrochemical_flowline_manifold`, and
  `mineral_core_sampler`;
- latest pipe-parent `manifold_057`, `valve_064`, `gauge_077`, `pump_091`,
  and `filter_085`;
- latest infrastructure-parent `infra_001` server rack, `infra_021` network
  cabinet, and `infra_121` field computer;
- current promoted clone pod/terminal, bank/trade/PA terminals, frontier
  footlocker, work benches, industrial battery pack, communications antenna,
  heavy cargo crate, rooftop air conditioner, and frontier water tank.

The corrected extraction reset has authored generator/control/survey/process
silhouettes and is no longer blanket-rejected. Its strongest candidates are
still industrial-scale: test them outside or in a deliberately measured
service bay instead of shrinking them to dress a room.

The following exact latest-lineage candidates were hash-checked against their
actual Mac GLBs. These are audit inputs, not automatic placement approvals:

| Asset id | Latest relative GLB path suffix | Actual SHA-256 | Export size X×Y×Z m |
| --- | --- | --- | --- |
| `successor_extraction_mineral_power_skid` | `extraction-installations/parent-reset-01/assets/successor_extraction_mineral_power_skid.glb` | `b16fbbc4421b953139fef711aa4799b2b9841b2e029618e5afef4346e3177145` | 2.189×2.031×1.515 |
| `successor_extraction_mineral_control_panel` | `extraction-installations/parent-reset-01/assets/successor_extraction_mineral_control_panel.glb` | `67177454c7699be6324f98d9b958586a2651b9aa493dea5865c3164a165ca202` | 2.015×2.351×1.649 |
| `successor_extraction_extraction_maintenance_cart` | `extraction-installations/parent-reset-01/assets/successor_extraction_extraction_maintenance_cart.glb` | `5f1458288d50a73c577ba3e67920cc3428c86dd01f40aa1c9df054a9fdea8e62` | 1.526×2.192×1.275 |
| `successor_extraction_extraction_survey_tripod` | `extraction-installations/parent-reset-01/assets/successor_extraction_extraction_survey_tripod.glb` | `782a271997eaacd532b5ffc41783bbed86c5bb2a50ae5fdbb5456d94d8d6579e` | 1.360×3.714×1.079 |
| `successor_extraction_mineral_survey_scanner` | `extraction-installations/parent-reset-01/assets/successor_extraction_mineral_survey_scanner.glb` | `3d432a549bc8cd55ef7542d447f0243face1e2cd7663fc5f2c61389b219bc841` | 2.068×3.762×1.649 |
| `successor_extraction_mineral_dust_filter` | `extraction-installations/parent-reset-01/assets/successor_extraction_mineral_dust_filter.glb` | `cf8d6517cabfa62b10245eb5a0a505f4d6b19adca50da82fb658246167ce2ba5` | 2.116×2.375×1.878 |
| `successor_extraction_petrochemical_separator_skid` | `extraction-installations/parent-reset-01/assets/successor_extraction_petrochemical_separator_skid.glb` | `76a07ea99a11d5091fccbe743ca55e8941cde3d256526458efb3df9debe69881` | 1.649×1.415×1.531 |
| `successor_extraction_petrochemical_flowline_manifold` | `extraction-installations/parent-reset-01/assets/successor_extraction_petrochemical_flowline_manifold.glb` | `16d994346f7ba9e57cc878bef421665f1dcd464c5a4a70435e2279aa79afc044` | 2.196×1.553×1.700 |
| `successor_extraction_mineral_core_sampler` | `extraction-installations/parent-reset-01/assets/successor_extraction_mineral_core_sampler.glb` | `c6b4ea325163586e7babfdb31621c1383e5e196a570b6591ae67d82d5dd89af2` | 1.649×2.916×1.455 |

The current promoted terminal and item assets are preserved compatibility
inputs. If one is visually rejected later, record that as a separate item
remake proposal; do not replace it incidentally inside an architecture pass.

## Hold or reject for this direction

- The shallow extraction proof was obsolete rounded box-and-cap placeholder
  output. It remains rejected even though the later parent reset is
  conditional/usable.
- Latest `medical-bio-lab/parent-reset-01` equipment still repeats a black
  cylinder/box plus over-bright white/pink display grammar across analyzers,
  incubators, pumps, scanners, and monitors. It is too weak for the clone
  facility's primary read. Tiny shelf dressing may be reconsidered only after
  isolated runtime inspection.
- The ten-item infrastructure Grok proof batch remains rejected. The later
  150-item parent reset is materially better, but most variants remain generic
  monochrome cabinets. Only the three conditional ids above should enter the
  runtime lab before expanding that allowlist.
- Handheld parent-reset proof remains hold/review-required and has no current
  architectural function.
- Everyday/home assets are intentionally simple. Use a few for human scale and
  occupancy, not enough to drag the architecture back toward generic domestic
  furniture.

## Production-pass requirements

Before building interiors or assembling the settlement:

1. Resolve the exact candidate id through the table above and verify the
   selected actual GLB SHA-256. A folder label or geometry hash alone is not
   enough.
2. Render a compact normal-camera audit sheet of the actual conditional GLBs.
3. Record the selected GLB hash, dimensions, origin, mount transform, material
   behavior, and clearance envelope.
4. Assign every selected item to a functional anchor in clone, commerce,
   shelter, or the settlement assembly.
5. Keep walkable and interaction approach cells clear in the layout/sidecars.
6. Use the actual runtime loader in Unity proof; no embedded copies and no
   primitive replacements.
7. Budget repeated props as instances and author LOD/material variants only
   through explicit, reversible item-pipeline work.
