# pawn_male.glb swap / revert procedures (2026-07-21)

Repo file: `successor/client-3d/public/assets/pawn-pack/pawn_male.glb`
All swaps are one `cp` + F5 in the Asset Lab (Vite serves public/ live). No code changes anywhere.

## States (all in tmp/bodyprom/, sha256 first 8)

| state    | file                 | sha256    | body                                                        |
|----------|----------------------|-----------|-------------------------------------------------------------|
| OLD      | pawn_male_OLD.glb    | 3b492045  | pre-accommodation runtime body (== git HEAD 178113c7 blob)  |
| CURRENT  | pawn_male_NEW.glb    | 6eaac906  | precoresplit_0000 full (weights + 12/26mm shrink) — SHIPPED |
| P        | pawn_male_P.glb      | (see ls)  | prehelperbones_0103 full (latest lab weights + max 12mm shrink) |
| W        | pawn_male_W.glb      | (see ls)  | OLD geometry (full naked volume) + prehelper weight field   |
| H        | pawn_male_H.glb      | (see ls)  | 50% of prehelper shrink (max 6mm) + prehelper weights       |
| R        | pawn_male_R.glb      | (see ls)  | CURRENT + pose-aware clearance-budgeted volume restore, floor 6mm (max +4mm on 32 verts; render-gate PASS vs CURRENT on all 12 garments; recovers only ~0.6 of the ~12.5-point hip-band silhouette deficit — imperceptible) |

## Revert to OLD (pre-accommodation)

    cp tmp/bodyprom/pawn_male_OLD.glb successor/client-3d/public/assets/pawn-pack/pawn_male.glb

or from git (blob verified identical to /tmp backup):

    cd successor
    git checkout -- client-3d/public/assets/pawn-pack/pawn_male.glb

## Re-apply CURRENT (shipped accommodation)

    cp tmp/bodyprom/pawn_male_NEW.glb successor/client-3d/public/assets/pawn-pack/pawn_male.glb

## Try a variant

    cp tmp/bodyprom/pawn_male_P.glb successor/client-3d/public/assets/pawn-pack/pawn_male.glb   # latest lab, softer shrink
    cp tmp/bodyprom/pawn_male_W.glb successor/client-3d/public/assets/pawn-pack/pawn_male.glb   # weights-only, full volume
    cp tmp/bodyprom/pawn_male_H.glb successor/client-3d/public/assets/pawn-pack/pawn_male.glb   # half shrink

If a variant is adopted permanently, update `pawn_male.provenance.json` next to it.

## Try parked volume-restore variant R (imperceptible gain; reference only)

    cp tmp/bodyprom/pawn_male_R.glb successor/client-3d/public/assets/pawn-pack/pawn_male.glb

## Worn-state bare-body variant (2026-07-21)

The shipped accommodation body remains `client-3d/public/assets/pawn-pack/pawn_male.glb`.
When a male actor has no leg-covering equipment, runtime optionally clones
`client-3d/public/assets/pawn-pack/pawn_male_bare.glb`, a byte copy of the
verified W anchor. Any item with manifest slot `under_legs` (or the fixed
`under_bodysuit` override) selects the accommodation body again. If
`pawn_male_bare.glb` is absent, the loader falls back to the accommodation
body with no other runtime change.

To revert the variant, remove `bare_file` from
`client-3d/public/assets/pawn-pack/game_pack.json` (or remove the bare GLB);
the normal `pawn_male.glb` path remains unchanged. To restore it:

    cp verification/anchors/body-20260721/pawn_male_W.glb client-3d/public/assets/pawn-pack/pawn_male_bare.glb
