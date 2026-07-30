# Published Opus settlement experiment

This branch is a held-out art and asset experiment. It is not merged into the
live fixture, browser renderer, native renderer, or Unity prototype, and this
record does not claim runtime integration or runtime visual proof.

The original direction and production iterations were performed on Michael's
Mac through OMP with `anthropic/claude-opus-5`; they did not use Claude Code
CLI. The preserved source was rebuilt and checked on Bunker with Blender 5.2.0
LTS from source commit `0c6eb961`.

The historical `dustgate-redesign` path is retained so existing evidence and
prompts remain traceable. It is not a live world-name decision. `Lintel` remains
only a candidate display name.

## Published inputs and outputs

- `source-items/`: 29 exact non-runtime GLBs plus a manifest, 30 files and
  7,127,408 bytes. Every GLB is pinned by SHA-256.
- Existing runtime assets: 11 audited assets remain referenced from their
  canonical repository paths rather than duplicated.
- Production artifact root:
  `verification/ledgers/artifacts/dustgate-opus5-production-20260729/`,
  197 files and 258,777,060 bytes.
- The artifact root includes three editable `.blend` checkpoints, nine
  standalone GLBs, manifests and collision sidecars, eight PBR texture sets,
  40-item audit evidence, 48 standalone proof renders, a nine-frame assembly
  review, and machine-readable validation reports.

All large binary media in the branch is stored through Git LFS.

## Standalone products

| Unit | LOD | Triangles | Primitives | Materials | SHA-256 |
| --- | ---: | ---: | ---: | ---: | --- |
| Clone facility | 0 | 29,140 | 44 | 8 | `d1fb1bd195ecb370f1833ab347bcac4a7094d6a110ab1d28d80f88e08a1e116a` |
| Clone facility | 1 | 18,072 | 40 | 8 | `18d07f7172455b1bdd7ae2028dc0161b4da4c89bb09ffa13f98cafb2165ffd61` |
| Clone facility | 2 | 5,080 | 19 | 6 | `6a7dd675b43a14ca635f8aec39fc0c7d16b106f5d2500ac7924e01cd651396c9` |
| Commerce hall | 0 | 20,268 | 39 | 8 | `48946c7277cb7c2071b5fb48328c9c620b9cedcd388ac1e7ad35b66e28740d39` |
| Commerce hall | 1 | 13,168 | 35 | 8 | `07719641c97920d9c6d83328aab2e5e041846db89c1aae5a387f846d9619cab1` |
| Commerce hall | 2 | 3,744 | 17 | 5 | `960c0c67224de4360da7c36a7f1d309678ea9480090cbfb71be04d383fac20af` |
| Shelter | 0 | 15,456 | 40 | 8 | `ae4950c009dff34ce1891d4ed4a2f0878655c022902a70ab556e657f8d6cdd71` |
| Shelter | 1 | 10,680 | 35 | 7 | `62c3973b6e47f2da3fafcf479b11dcdc5c3d9df41d4c3d90f8b723c35d8920b4` |
| Shelter | 2 | 3,740 | 17 | 5 | `d5a8ddde87cf4a49209b6ea03475831eaf52ebbd9ec53270fb99c706f4d42985` |

LOD0 carries PBR textures and `door_open` / `door_close` clips. LOD1 and LOD2
retain the mapped node and collision contracts but intentionally use the
maps-free material path documented in `PRODUCTION_RECORD.md`.

## Verification

- The complete pipeline was run with
  `SUCCESSOR_PROP_SOURCE_ROOT=/nonexistent`. No external source-asset library
  was available to satisfy a missing input.
- The item audit measured all 40 candidates with zero failures: 29 vendored
  source items and 11 canonical runtime items.
- Khronos validation reports zero errors and zero warnings across all nine
  GLBs.
- Each collision sidecar transforms and derives clear interior/exterior door
  points at 0°, 90°, 180°, and 270° with no failures.
- Every building is grounded at zero, stays inside its declared footprint, has
  UV0 on every mesh, has a single `door_slide` node, and provides walkable
  egress from its promised service anchors.
- After canonicalizing post-modifier UV precision, three consecutive
  factory-startup builds produced byte-identical GLBs and manifests. Blender
  `.blend` serialization contains volatile internal session data. The
  checked-in Python generators are the canonical authoring source; `.blend`
  byte hashes are not.
- The 48 standalone proof frames were rendered only after re-importing the
  exact final GLBs into clean scenes. The close-inspection contact sheet has
  SHA-256
  `2bbad411333fa4fde3f66981c23b62c96697e915f6402f8760d116b0acf640c5`.

The assembly contains three standalone building instances, 28 external assets,
162,006 scene triangles, and nine review frames. It deliberately authors no
roads, paths, paving, aprons, or route-shaped marks.

## Honest visual status

The three individual buildings are the useful result: their silhouettes,
functional sliding doors, interiors, cutaways, LODs, and collision contracts
are coherent enough for a renderer-integration trial.

The settlement assembly is still only an art-direction test bed. Its ancient
remnant is oversized, dark, and coarse; the overall layout is sparse; and the
render-only interior lamps are substitutes for runtime lighting. The assembly
should be revised or replaced before any promotion. These limitations do not
invalidate the standalone building products.

## Reproduce

From the repository root on a Blender 5.2 host:

```sh
export SUCCESSOR_PROP_SOURCE_ROOT=/nonexistent
cd tools/successor/assets/dustgate-redesign
blender -b --factory-startup -P textures.py
blender -b --factory-startup -P proditems.py -- all
blender -b --factory-startup -P prodbuild.py -- all
blender -b --factory-startup -P prodproof.py -- all --round final
blender -b --factory-startup -P prodassemble.py
cd ../../../..
node tools/successor/assets/dustgate-redesign/prodvalidate.mjs
node tools/successor/assets/dustgate-redesign/prodsidecar.mjs
```
