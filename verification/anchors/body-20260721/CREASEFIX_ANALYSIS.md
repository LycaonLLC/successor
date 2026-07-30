# Run-peak hip-crease collapse — root cause + shipped fix (2026-07-21)

## Root-cause verdict (evidence-backed)

- **H1 (helper-bone export dependency): FALSE.** The runtime 07-10 `Under/legs_*.glb`
  are **geometrically and weight-identical** to the pre-helper 07-08 handtuned
  exports (`synty-fit/handtuned/bottoms/bottoms_apoc_outl_NN.glb`): position delta
  0.00 mm, 0/all weight rows changed, no helper joints in either (checked 01, 02, 08;
  sha256 differences are materials/metadata only). Tool: tmp/bodyprom/crease_diff.py.
- **H2 (07-08 exports deform better): NULL by construction** — same geometry+weights.
- **H0 (body promotion): ruled out by Main's bisect** (collapse identical on OLD body).
- **Actual cause: intrinsic LBS crease collapse.** At the true run_f hip-flexion peak
  (frame 11, thigh at 71.4° from vertical — found by max thigh angle, not fixed time)
  the crease-band fabric folds up to **60 mm below the body surface** (52 verts >2 mm
  inside). This is exactly the failure class the lab's helper rig was built to mask —
  and helpers cannot ship (50-bone contract). The old body's disagreeing weights used
  to poke skin through the folded fabric, visually "holding the crease open" as
  clipping; every regime since always had the fold.

## Fix shipped (not a bandaid — the documented lab repair)

`pose_sweep_declip` rest-shape repair reimplemented against the runtime deformation
chain (tmp/bodyprom/creasefix.py): sweep walk_f+run_f every frame vs the promoted
body; where fabric sinks >3 mm below skin, push the rest vert out along the
worst-frame normal back-transformed through the vert's exact LBS matrix
(+2 mm clearance, 12 mm cap round 1; +6 mm cap round 2 for padded_canvas, denim,
wrap_skirt; strapped_trousers kept at round 1 — round 2 oscillated on its hanging
straps). Only POSITION accessors patched into the runtime GLBs — weights, joints,
indices, materials byte-identical (verified). Bodysuit + Shorts intentionally
untouched (skin-tight by design; fixing them regressed calves).

## Gates

- 12-garment rendered clip-regression sweep vs pre-fix pants (12 frames × 6 cams,
  interior-only metric, `creasefix_gate_FINAL.json`): worst interior cell 13 px
  (legs_strapped_trousers f06_c3) — human-verified 1-px-high sliver at knee fold;
  hard-10 px cells (10/10/13) all verified negligible slivers; bodysuit/shorts 0 px.
  Instrument validated: OLD body scores 6942 px worst cell on the same metric.
- Blender A/B at run peak: dent → smooth ride-over, no ballooning (`M_crease_AB.png`).
- Real asset-lab A/B at run peak: IMPROVED (workpants zoom `zoomlab_workpants_run_t42.png`;
  denim/canvas lab diffs confounded by per-load palette tint, verified in Blender).
- vitest specialHumanoid + pawnPack.catalog (9/9) + tsc clean. pawn_male.glb untouched.

## Revert

    cp verification/anchors/body-20260721/pants-pre-creasefix/legs_*.glb \
       client-3d/public/assets/pawn-pack/equipment/Under/

Shipped hashes: `pants-creasefix-shipped.HASHES.txt`.

## Bonus: dark rectangular block at groin (owner report) — IDENTIFIED

It is the **body's own authored crotch underside**: 4 downward-facing faces
(normals nz ≈ −0.96/−0.64) forming a flat shelf at z≈0.81 between the thighs,
single PF2_Skin material — no stray box, no texture issue. The asset lab renders
the body with `MeshMatcapMaterial`; straight-down normals sample the darkest
matcap texel → reads as an unlit near-black rectangle (visible naked and through
every crotch gap; invisible in studio-lit Blender renders). Proof: scene bisect
(only visible mesh in the pawn subtree is `body`) + normal audit. Fix options
(owner decision): soften/tilt those 4 face normals, or lift the matcap's bottom
row, or brighten the lab ground bounce. Nothing shipped for this.

---

# POSTMORTEM (2026-07-21, same day): rest-shape repair REVERTED by owner review

The shipped rest-shape declip was reverted to `pants-pre-creasefix/` (revert
hash-verified against the anchor, all 10 pants). Owner review caught what the
gate did not: at MID-STRIDE phases the pushed-out rest verts read as a chunk
gouged out of the thigh. My render gate judged clip regressions (skin-over-fabric)
across 12 frames but had no metric for outward silhouette distortion at
non-peak phases — a worst-frame rest edit rides through EVERY pose by
construction, and we proved that failure mode live.

## 1. The three empirically mapped states

| state | rest geometry | deep-flexion crease | rest/mid-stride |
|---|---|---|---|
| pre-promotion (OLD body) | original | fabric folds, skin CLIPS through and visually "holds" the crease | shallow all-over clipping |
| current (promoted body, original pants) | original | fabric folds/dents INTO the leg (owner report) | clean |
| rest-shape declip (reverted) | crease band pushed out ≤18 mm | fold rounded over (verified at peak) | GOUGE/dent reads at mid-stride |

Why static rest geometry cannot solve this: the crease deficit is
**pose-dependent** (0 mm needed at rest, up to 60 mm at 71° hip flexion), but a
rest-vertex edit is **pose-constant** — the same world-space correction (bent
through the LBS map) is present in every frame. Any rest shape is therefore a
compromise: enough outward push to survive deep flexion necessarily deforms
the fabric at all other phases (gouge/balloon), and the 50-bone contract
forbids the helper bones that made this work in the lab. There is no
rest-geometry point that satisfies both ends of the flexion range; the
correction must be a function of pose.

## 2. Recommended shippable fix (future session): pose-driven corrective morphs (PSD-lite)

- **Asset side:** for each pants, bake the validated declip delta
  (`tmp/bodyprom/creasefix/` npys — worst-frame LBS back-transformed rest
  deltas, the exact data already computed) as a **morph target** on the garment
  primitives (`POSITION` deltas, sparse). glTF supports morphs on skinned
  meshes; three.js applies morphs BEFORE skinning, which is exactly the
  back-transformed rest-space correction we already produce. One target per
  pants ("crease_flex"), optionally split L/R for per-leg drive.
- **Runtime side (pawns.ts):** drive `morphTargetInfluences` per frame from the
  thigh flexion angle: `w = smoothstep(40°, 70°, angle(thigh, pelvis-down))`,
  per leg if split. Correction is ZERO at rest/walk (no cross-pose damage) and
  full only at deep flexion where the fold lives. This is standard pose-space
  deformation lite; no new bones, 50-bone contract intact, no constraint
  evaluation, cost = one morph per equipped pants.
- **Rough scope:** (a) baker script: extend `tmp/bodyprom/patch_garments.py`
  to emit morph targets instead of overwriting POSITION (~half day incl.
  sparse-accessor plumbing); (b) runtime: locate the equipment mesh setup in
  pawns.ts, add flexion-angle sampler + influence write (~few hours + tests);
  (c) re-run the existing 12-garment render gate at peak AND mid-stride frames
  with the influence curve active, plus owner-scenario frames. The gate must
  add a silhouette-distortion metric at non-peak phases (compare garment mask
  vs baseline, both directions) — the gap this postmortem exposed.

## 3. Parked artifacts (all inputs for the morph approach exist)

- `tmp/bodyprom/creasefix.py` — pose-swept declip delta generator (LBS
  back-transform, caps, smoothing) + `tmp/bodyprom/creasefix{,2}/*.npy` —
  per-vertex rest deltas keyed by original rest position, per garment mesh.
- `tmp/bodyprom/patch_garments.py` — surgical GLB POSITION patcher
  (y-up/z-up matching, strided accessors) — morph-target baker starting point.
- `tmp/bodyprom/fixedFinal/*.glb` — the reverted rest-edit pants (reference
  for what full correction looks like at peak).
- `tmp/bodyprom/peak_repro.py` (true-peak finder + fold metric),
  `render_sweep.py` + `compare_renders.py` (validated 12-garment render gate),
  `crease_diff.py` (lineage forensics).
- Anchors here: `pants-pre-creasefix/` (canonical pants, currently shipped),
  `creasefix_gate_FINAL.json`, `M_crease_repro.png`, `M_crease_AB.png`,
  `zoomlab_workpants_run_t42.png`.

> DURABILITY NOTE (Main, 2026-07-21): every tmp/bodyprom/ path above has a durable copy in verification/anchors/body-20260721/creasefix-toolkit/ — /tmp dies on reboot; use the toolkit copies.
