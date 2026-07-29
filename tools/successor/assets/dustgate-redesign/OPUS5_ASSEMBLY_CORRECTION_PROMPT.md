# Opus 5 — Starting-Settlement Assembly Correction

You are the principal 3D author for a narrow correction pass in the Successor
starting-settlement redesign. Work directly in this checkout and leave
reproducible source, generated proof, measured QA, and an honest record.

## Scope lock

The three standalone building products (`clone`, `commerce`, and `shelter`) are
accepted for this pass. Do not remodel them, edit their internal geometry,
change their manifests/sidecars, rename node families, or replace their
instanced world items. They must remain standalone units imported by
`prodassemble.py`.

Correct only the assembly context and placement authored by
`prodassemble.py`, plus the corresponding assembly section of
`PRODUCTION_RECORD.md`. Do not integrate or promote anything into runtime
paths. Do not change canonical IDs, fixture keys, protocols, Rust authority,
the existing web/Electron renderer, or the Unity lane.

## Mandatory visual review

Before editing, inspect the actual current assembly frames under:

`verification/ledgers/artifacts/dustgate-opus5-production-20260729/assembly/`

At minimum inspect `02_gameplay_wide.png`, `03_gameplay_frame.png`,
`04_three_quarter.png`, and `08_windbreak.png` at useful resolution. Preserve
the rejected frames under an explicitly named ignored proof subdirectory before
rerendering.

Two defects are already rejected:

1. The box-built “wind-drift swells” read as rectangular tan plazas, aprons, or
   roads. There are no roads in this universe at this site. Remove them. The
   settlement must sit in continuous natural desert. If you add relief, it must
   be genuinely organic mesh terrain/rocks/dunes and must not form a connected
   route, corridor, lane, platform, perimeter, or building apron. A plain
   continuous desert plane is better than fake naturalism.
2. The ancient windbreak still reads as a repeated row of shipping containers,
   tombstones, or industrial wall panels. Rebuild or materially re-author this
   assembly-only context from zero. It should read as one ancient,
   irreproducible, terrain-scale remnant: irregular in plan and section,
   asymmetrically eroded/collapsed, with a coherent overall silhouette from
   top-down gameplay and three-quarter views. It must not read as a fourth
   modular human building or a repeated prop line.

Also inspect the three extraction yard props currently squeezed between the
clone and commerce units. Keep only the visually reviewed, exact pinned
lineages when they help the site read; redistribute or reduce them if the
current alley looks cramped or noisy. Do not browse sibling folders and choose
something merely because it is newer-looking.

## Exact world-item lineage rule

`proditems.py` is authority for the 40 audited candidates. It pins every exact
file by SHA-256 and has no fuzzy matching:

- extraction and infrastructure: the visually reviewed `parent-reset-01`
  products;
- vehicle components: the Grok 4.5 component wave;
- everyday and homebuilder: their later root products;
- exact promoted runtime equivalents win where present;
- explicit runtime aliases only:
  `water_tank_frontier` → `tank_water_frontier.glb`,
  `workbench_field` → `bench_welder.glb`.

“Latest lineage” does not mean “accepted visual quality.” The audit’s
conditional/rejected lanes remain rejected. Do not use arbitrary contents of a
parent, Grok, reset, or sibling folder; some are known trash.

## Functional and compositional requirements

- Preserve the three unit placements unless a small map-transform adjustment
  is clearly needed for legibility; never edit the unit meshes themselves.
- Keep existing player/pawn/item assets and their roles. They are compatibility
  instances, not style baselines.
- Preserve the functional travel terminal and open walkable approaches to all
  three sliding doors.
- Preserve the starting-area gameplay hierarchy: readable spawn, clone works,
  commerce/trainer, shelter, travel terminal, and open desert egress.
- No roads, paths, lanes, paving, aprons, kerbs, traffic furniture, tire marks,
  route-shaped decals, or rectangular ground patches.
- Avoid evenly spaced repetition. Do not call a repeated primitive row
  “ancient” merely by varying its height.
- Keep the locked top-down 60° gameplay camera useful; also judge plan and
  three-quarter views.

## Iteration and proof

Perform at least two visible assembly build → render → inspect → correct
rounds. Do not stop after source edits without looking at the result.

The final packet must include the existing eight assembly viewpoints and add,
if needed, one closer proof that makes the remnant construction legible.
Record:

- before/after frame locations;
- what was removed or rebuilt and why;
- exact external asset paths and SHA-256 values;
- confirmation that standalone unit GLB SHA-256 values are unchanged;
- confirmation that no route-like ground geometry exists;
- scene triangle/object counts and honest remaining visual risks.

Run:

- Python syntax compilation for edited scripts;
- the 40-file pinned-candidate resolver check;
- `node tools/successor/assets/dustgate-redesign/prodvalidate.mjs`;
- `node tools/successor/assets/dustgate-redesign/prodsidecar.mjs`;
- `pnpm verify:successor-context`;
- `bash tools/denylist/check.sh`;
- `git diff --check`.

Do not claim runtime integration or production acceptance. Finish with a concise
summary of exact edits, proof inspected, validation results, and remaining
risks.
