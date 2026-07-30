# Recent Asset Catalog — 2026-07-15

This is a promotion and source-preservation snapshot, not a second live
authoring tree. Editable sources stay in PawnForge under the paths below;
reviewed bulk output stays in the clean inbox packet. Nothing in those source
roots was moved or rewritten for this pass.

The listed assets were locally authored in the project-owner workspace under
project-owner direction. Sanitized runtime provenance records them as
proprietary Successor assets authorized for Successor runtime distribution;
they grant no standalone or open-content reuse.

The complete July 11-14 packet set now also has a canonical local intake archive
at
`../source-assets/_incoming/successor-pawnforge-wave-20260711-14/`. Its 27
independent packet archives preserve each builder, texture set, `.blend`,
report, metadata file, and GLB export together. `restore-verification.txt`
records a successful clean restore: all 27 archive hashes and listings passed,
all 9,296 restored file hashes passed, and the recorded, live-source, and
restored totals matched at 6,259,686,311 bytes.

That archive protects the editable work from cleanup of PawnForge's ignored
`_bakeoff` tree, but the `source-assets` repository has no configured remote or
off-machine mirror. It is therefore not protection from host or disk loss. The
neighboring `source-assets` reorganization is also mid-move, so do not use
`git commit -a` there or stage only its tracked deletions.

## Promoted in this pass

| Asset | Source and evidence | Runtime state | Visual proof / remaining gate |
| --- | --- | --- | --- |
| Grok wedge travel terminal | `pawn-forge/pawnforgev2/_bakeoff/successor_terminal_family_20260714_run01/wedge/`; full GLB SHA-256 `a26cc0591111b5456c1ac6822d35f9b5895171cf8c036d792b62643788cbad2a`; 2,948 triangles; 1.40 x 0.78 x 0.48 m; six UV-mapped modules, embedded 2048 px base-color/normal/ORM/emissive maps, and `Socket_use` plus `Socket_screen_center` | `travel_terminal` now resolves to `client-3d/public/assets/world-items/travel_terminal_grok_wedge.glb`. `Module_screen` uses the promoted green strip with UV scroll and pulse. | Isolated start-zone camera/post-stack proof passed with a readable animated green screen in `verification/ledgers/artifacts/client3d/client3d-gate-20260714211601-5c84fefd/client3d-gate-report.json`. Proprietary runtime-distribution rights are recorded; no standalone reuse grant. |
| GR0K humanoid droid | `pawn-forge/pawnforgev2/_bakeoff/successor_droid_brother_20260714_run01/`; GLB SHA-256 `41d83904e7fdf0f6793c0306cd49c7db1a95f86af24cb7d92a9972a69c084dc5`; 1,377,764 bytes; 10,244 vertices; 9,814 source faces; 1.730855 m tall; one skinned mesh and an exact 50-joint humanoid-rig name match | Stable special-body id `droid_grok_humanoid`, sprite id `droid-grok-humanoid`, and start-zone actor `grok` / `GR0K`. It reuses shared pawn clips and intentionally skips human wardrobe pieces. Six authored material zones are preserved. The mesh has `TEXCOORD_0`; it is intentionally color/material based and has no missing texture images. | Isolated start-zone camera/post-stack body, idle, and examine proof passed in `verification/ledgers/artifacts/client3d/client3d-gate-20260714211601-5c84fefd/client3d-gate-report.json`. Proprietary runtime-distribution rights are recorded; no standalone reuse grant. |
| Scrapline Machete | `pawn-forge/pawnforgev2/_bakeoff/successor_cozy_asset_wave_20260712_run01/families/melee_early/assets/scrapline_machete.glb`; SHA-256 `129ca1b4d07dfa3df23639110bf61fecefc56ff93146551f1ae90c69fc693b10`; 7,340,724 bytes; one 1,199-vertex / 1,020-triangle mesh; 0.62 m overall length; grip midpoint at origin; `TEXCOORD_0`; one material with embedded 2048 px base-color, normal, and ORM maps | Runtime item `3105` / weapon id `scrapline-machete` resolves to a byte-identical GLB plus a right-hand attach packet and neighboring provenance record. The editable source of truth is deterministic `build.py` plus its texture inputs: the latest family `.blend` was overwritten by the final `--only field_saber` pass and does not contain Scrapline. The current pawn weapon pass converts it to matcap shading with its base-color map; embedded normal/ORM remain preserved source data rather than active shading. | Isolated stow, draw, first-swing, and kill proof passed in `verification/ledgers/artifacts/client3d/client3d-gate-20260714204314-6f9b6f2d/client3d-gate-report.json`. Proprietary runtime-distribution rights are recorded; no standalone reuse grant. The non-asset-specific family `.blend` caveat remains recorded. |
| Field Saber and Quarry Chopper | Deterministic refined PawnForge exports with neighboring runtime provenance and attachment packets | Runtime items `3106` and `3107` resolve through the authority weapon ladder, model registry, and item model registry. | Focused source, attachment, melee-presentation, and client journey coverage are checked in with the promotion. |
| Lightning Carbine | Refined Storm-family export; runtime provenance records SHA-256 `2a56f85c31a5ada64e23b9a15adcbc444d853e6f43a74cffa6acaf48100f306d`, 3,446 triangles, and a byte-identical deterministic source export | Runtime item `3121` / weapon id `lightning-carbine` is integrated with a frozen attachment contract and authoritative Marksman certification. | Headed run `weapon-carbine-progression-final-20260715` and synchronized eject/drop/reseat captures passed with zero console errors. |

The promoted terminal, terminal screen, GR0K, world props, campfire, and custom
weapons each have neighboring `.provenance.json` records with source hashes,
builder/source paths, runtime references, and review state. Records leave
unknown provider or authoring-session fields uninferred rather than borrowing
metadata from another asset.

The terminal's full PBR maps are preserved in the source/runtime GLB, but the
current intentionally unlit Successor world pass converts its meshes to
`MeshBasicMaterial` and uses only a base/emissive map plus the separate animated
screen treatment. Normal, ORM, metalness, and roughness are therefore source
fidelity for a future lit/stylized material pass, not active runtime shading.
GR0K similarly uses the shared matcap/unlit pawn language while preserving its
six authored material zones.

## Already in the runtime

| Asset | Current truth | Follow-up |
| --- | --- | --- |
| Kiln Energy Cell Carbine | Runtime `client-3d/public/assets/pawn-pack/weapons/custom/wpn_carbine_kiln.glb` is SHA-256 `c7638b3239d6120cfa274828a1c5a8cf73079fe12290f728746dc70673f0f4e2`, byte-identical to the current accepted source at `pawn-forge/pawnforgev2/_bakeoff/sten_mk2_schematic_luna56_20260711_run01/modular/sten_cell_kiln/assets/sten_cell_kiln_full.glb`. | Restamp `successor_sten_kiln_promotion_luna56_20260712/runtime-packet.json`; it still records an older `abf1f664...` source/runtime hash and must not be treated as current proof. |

## Hold at source

| Asset | Source evidence | Why it is held |
| --- | --- | --- |
| Astromech droid | `pawn-forge/pawnforgev2/_bakeoff/successor_astromech_20260714_run01/assets/astromech.glb`; SHA-256 `b7f496084fed24295797d7ebf29670ccaf1796be78c1e33971cee921e02abd55`; 12,688 exported triangles; clean PBR atlas | It has no rig, skin, animation clips, or locomotion sockets. Treat it as prop-grade source until a static/hover/rig runtime contract is chosen and proven. |
| Cloudsheep | `pawn-forge/pawnforgev2/_bakeoff/successor_cloudsheep_20260714_run01/`; wooly SHA-256 `40448e01c376686b4db0b4bcf6d8dc168be1809b840d73443ceb9310490c70d3` at 3,264 triangles; shaved SHA-256 `38adbf14166cb0c71f0ebc22cf7752155aaf279d801c0a75f7cfea6f769056d1` at 2,334 triangles; both use 16 deform bones and `idle`, `walk`, `rest` clips | Promote wooly/shaved as two states of one species, not unrelated creatures. It still needs the creature packet: species id, calm/flee/damage/death behavior, bounds, selection, state transition, and in-camera proof. |

## Reviewed bulk library

The July 12 cozy asset wave remains locally bundled at
`pawn-forge/pawnforgev2/_bakeoff/successor_cozy_asset_wave_20260712_run01/`,
with the clean review packet at
`dev-inbox:successor-cozy-asset-wave-20260712/`. Review verification
records 120 of 120 assets across 12 lanes: 18 melee, 18 components, 24 junk, 18
food, 30 plants, and 12 creatures, with no review-verification errors. This is a
reviewed source library (`integration: none`), not permission to mass-copy all
120 assets into the runtime. Promote them one stable gameplay id and one proven
consumer contract at a time.

## Full July 11-14 local packet census

The promotion list above is intentionally selective; this census is the wider
findability index the local bakeoff tree was missing. As of this review there
are 27 recently touched top-level packets occupying about 5.9 GiB, containing
453 GLB files and 112 Blender files. Those numbers include variants,
intermediate exports, and promotion copies, so they are not a claim of 453
unique gameplay-ready assets. Every row is rooted at
`pawn-forge/pawnforgev2/_bakeoff/`.

| Packet | GLB | `.blend` | Files | Size |
| --- | ---: | ---: | ---: | ---: |
| `baofeng_uv5r_photoreal_20260714_run01` | 4 | 2 | 60 | 48 MiB |
| `coilcaster_luna3_20260711` | 3 | 3 | 22 | 3.1 MiB |
| `critter_six_method_20260711` | 52 | 12 | 638 | 266 MiB |
| `emberline_terse3_twround_20260711_run01` | 3 | 6 | 33 | 8.6 MiB |
| `needleburst_promptstyles_20260711_run01` | 3 | 3 | 18 | 4.5 MiB |
| `nokia_3310_photoreal_20260714_run01` | 2 | 1 | 21 | 13 MiB |
| `sten_mk2_schematic_luna56_20260711_run01` | 78 | 17 | 620 | 597 MiB |
| `successor_astromech_20260714_run01` | 1 | 1 | 58 | 64 MiB |
| `successor_bio_additives_fable5_20260712_run01` | 12 | 1 | 50 | 26 MiB |
| `successor_chef_outfit_20260714_run01` | 5 | 0 | 46 | 13 MiB |
| `successor_cloudsheep_20260714_run01` | 2 | 2 | 109 | 15 MiB |
| `successor_cozy_asset_wave_20260712_run01` | 136 | 34 | 4,489 | 2.8 GiB |
| `successor_crops_fable5_20260712_run01` | 54 | 1 | 176 | 64 MiB |
| `successor_droid_brother_20260714_run01` | 1 | 2 | 127 | 58 MiB |
| `successor_food_dishes_fable5_20260712_run01` | 20 | 1 | 119 | 51 MiB |
| `successor_food_ingredients_fable5_20260712_run01` | 0 | 1 | 89 | 46 MiB |
| `successor_hats_functional_20260714_run01` | 6 | 6 | 198 | 138 MiB |
| `successor_inventory_accessory_7203_fable5_20260712_run01` | 1 | 1 | 33 | 26 MiB |
| `successor_inventory_chits_currency_luna56_20260712_run01` | 6 | 6 | 271 | 128 MiB |
| `successor_inventory_farm_luna56_20260712_run01` | 4 | 1 | 174 | 106 MiB |
| `successor_inventory_field_tools_luna56_20260712_run01` | 11 | 1 | 852 | 382 MiB |
| `successor_inventory_gene_lab_luna56_20260712_run01` | 8 | 4 | 346 | 210 MiB |
| `successor_inventory_medical_luna56_20260712_run01` | 3 | 1 | 562 | 358 MiB |
| `successor_sten_kiln_promotion_luna56_20260712` | 4 | 0 | 6 | 17 MiB |
| `successor_terminal_brutalist_20260713_run01` | 7 | 1 | 38 | 132 MiB |
| `successor_terminal_family_20260714_run01` | 21 | 3 | 85 | 367 MiB |
| `successor_vibrosword_grounded_luna56_20260712_run01` | 6 | 1 | 56 | 23 MiB |

The Successor-specific inventory therefore covers the previously omitted crop,
food, additive, field-tool, gene-lab, farm, currency, medical, hat, outfit,
terminal, droid, creature, and weapon families as well as the 120-asset cozy
review packet. The Baofeng and Nokia packets are recorded for completeness but
are not presumed to be Successor content. Counts were taken from the live local
tree and frozen in the canonical local intake's `packet-stats.tsv` and
`files.sha256`; they should be regenerated for any later bakeoff additions.
