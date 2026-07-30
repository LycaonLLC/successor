# Clearance-budgeted volume restoration — outcome: STOPPED at ceiling (2026-07-21)

Goal was to restore naked hip/glute/thigh volume on the accommodated body without
re-clipping any of the 12 runtime bottoms (10 legs_* + under_bodysuit + under_shorts).
Result: **the approach has a hard, measured ceiling far below perceptibility. CURRENT
stays shipped unchanged (sha256 6eaac906…).**

## Why it cannot work (numbers)

- The 112 accommodation-shrunk verts sit 12–26 mm inside the OLD silhouette.
- The runtime garments were REFIT SNUG to the shrunken body. Measured minimum
  clearance from each shrunk vert to the tightest garment across walk_f+run_f
  (8 frames each, pose-aware, along posed vertex normal):
  **min 0.0 mm / p25 0.8 mm / median 3.2 mm / p75 7.3 mm / max 18.3 mm.**
- Binding constraints are spread (run_f × under_shorts, run_f × under_bodysuit,
  walk_f × under_shorts, plus five different pants) — no single garment to fix.
- Max render-clean restore (floor 6 mm): 4.5 % of the shrink (32 verts, ≤4 mm).
  Floor 3 mm / 2 mm restore 10–13 % but FAIL the render gate (32–45 px skin
  blobs on legs_plated_trousers rear-3/4 and others).

## Acceptance instrument (exhaustive, validated)

Local geometric penetration metrics (nearest-face sign, parity rays, smooth-normal
sign) are ill-posed on this asset (interpenetrating thighs, hanging straps, concave
pockets) — three variants all produced phantom regressions 40–300 mm from any moved
vert. Final gate = **rendered visible-skin regression**: Workbench flat masks
(skin magenta / garment green), 12 garments × 12 frames (walk_f+run_f) × 6 orbit
cameras × 448 px, pixel-diffed vs CURRENT (skin pixels appearing over fabric
interior, 7 px silhouette tolerance). Validation: OLD body lights up 13k–200k px
per garment (bodysuit worst) — exactly the owner-reported clipping. Scripts in
tmp/bodyprom/{render_sweep.py,compare_renders.py,inflate_v7.py}.

## Parked artifact

`pawn_male_R.glb` — CURRENT + max safe restore (floor 6 mm): 50 joints / 47 clips
byte-identical, JOINTS_0/WEIGHTS_0 byte-identical to CURRENT, 32 verts moved ≤4 mm,
gltf validate 0 errors, render gate PASS on all 12 garments
(`sweep_render_gate_R.json`). Hip-band naked silhouette: OLD 100 % → CURRENT
87.5 % → R 88.1 % → (failing R2 89.2 %). Not worth shipping.

## If the naked body must be fixed for real

Geometry-only cannot do it under these garments. The honest levers are:
1. **Worn-state body swap** — serve full-volume positions when no bottoms equipped
   (runtime name-match/equip hook exists; pack can carry both position sets).
2. Refit the garments with more clearance (the "rewrite 28 garments" path the lab
   rejected as a shredder — would need the refit pipeline re-run, not hand edits).
