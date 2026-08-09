# THE GRIP FORMULA — any Synty weapon into pawn hands, dark + fully attached

> Preserved on 2026-07-28. This is design source, not current runtime
> documentation. Recheck every code path, hash, and implementation-status claim
> against the current source tree before using it. Current truth lives in
> `docs/CANONICAL_CONTEXT.md`, `docs/CURRENT_PROJECT_STATE.md`, and
> `docs/VERIFICATION.md`.

**Status:** proven on the curated set (8 weapons, 2026-07-08). This is the
repeatable recipe so the NEXT 50 weapons are mechanical: run four scripts, do
ONE visual confirm, land two data rows. Authoring home:
`pawn-forge/pawnforgev2/_bakeoff/synty_weapons_20260708/` (gitignored source of
truth: `scripts/`, `glb/`, `attach/`, `qa/`, `renders/`).

The formula's job is to eliminate per-weapon guesswork. Everything below is
derived ONCE per weapon in headless Blender against the ACTUAL pawn rig
(`ue5_mannequin_50`, hand_r weld, slugthrower calibration), then frozen.

---

## 0. Why this is a formula and not a vibe

Two hard runtime truths drive every choice:

1. **Weapon material survival (opposite of props!).** `pawns.ts` builds
   `MeshMatcapMaterial({ matcap, map })` for weapon scenes — it KEEPS the
   baseColorTexture MAP and DROPS material color. A plain-colored weapon renders
   white. So a weapon ships ONE material (`PawnPalette`) + a small flat palette
   PNG; faces are UV'd into palette cells. Dark reskin = tint the palette
   (texture × tint), source GLB never overwritten. (Props are the reverse: keep
   color, drop map — do not cross the wires.)
2. **Attach is a socket registry, not a parallel pipeline.** The pawn pack
   already has `SlugthrowerAttachSpec` (grip/foregrip/muzzle/stock sockets +
   `mount_hand_r_local`). Each weapon EXTENDS that registry with one spec row.
   The runtime `SlugthrowerRig` is generalized to take `(scene, spec, scale)`;
   validation proves `muzzleWorld` through the fx probe.

## 1. Per-weapon manifest schema (`<id>_attach.json`, `successor-weapon-attach/1`)

The whole deliverable per weapon is ONE JSON (all in weapon-GLB-local glTF space):

| field | meaning | how derived |
|---|---|---|
| `sockets.grip` | right-hand weld point (palm) | geometry: low cluster behind mid-bore |
| `sockets.foregrip` | off-hand support point (two-handed) | bore·frac forward, under the shroud |
| `sockets.muzzle` | muzzle-flash / tracer origin node | thin-cross-section bore end |
| `sockets.stock` | butt / rear reference | thick bore end |
| `mount_hand_r_local` {pos,quat} | the GRIP TRANSFORM (hand_r-local weld) | **mount-transfer** (§3) |
| `scale_to_pawn` | uniform weaponRoot scale | `class_target_len / measured_bore_len` |
| `orientation` {forward,up} | bore axis + weapon up | forward = normalize(muzzle−grip) |
| `silhouette_class` | pistol/smg/rifle/shotgun/launcher/melee | filename → class |
| `stow_socket` {space,pos,rot_deg} | back (long guns) / hip (pistols) | spine_03-local, class default |

## 2. Axis conversion (the one that bites)

Blender's glTF importer rotates loose meshes **+90° about X**. So a Blender
consumer maps a glTF-local socket `(x,y,z)` → Blender `(x, −z, y)`; the inverse
(measure in Blender, write glTF) is `(x, z, −y)`. `solve_socket.py` measures in
Blender space and writes glTF-local via `b2g`. three.js consumes glTF-local
directly. This is the single source of the "why is my muzzle 90° off" class of
bug — it is handled once, in the solver, and never re-derived.

## 3. Mount-transfer: reuse the owner-tuned Slugthrower hand pose

The Slugthrower's `mount_hand_r_local` is owner-tuned by eye (the locked palm pose +
bore-forward hold). We do NOT re-tune per weapon. Instead we TRANSFER that hand
calibration onto each new weapon's own grip+bore frame:

```
# Slugthrower reference (glTF-local):  grip_s, bore_s = norm(muzzle_s - grip_s), up_s, mount_s{q,p}
P_palm    = mount_s.q * grip_s + mount_s.p           # palm point in hand_r space
F_hand    = mat(mount_s.q) · frame(bore_s, up_s)     # the tuned hand frame
# New weapon:  grip_n, bore_n = norm(muzzle_n - grip_n), up_n=+Y, scale
mount.q   = quat( F_hand · frame(bore_n, up_n)^T )   # rotate weapon bore->hand bore
mount.p   = P_palm - mount.q * (grip_n * scale)      # scaled grip lands at the palm
```

Result: every weapon inherits the exact hold the owner locked for the Slugthrower,
refit to its geometry — no per-weapon hand tuning. `frame(a,b)` = orthonormal
basis (col0=a, col1=b⊥a, col2=a×b).

## 4. Scale-to-pawn

`scale_to_pawn = class_target_len / measured_bore_len`. Class targets (m):
pistol 0.34, smg 0.60, rifle 0.90, shotgun 0.85, launcher 1.05, melee 0.95.
Synty rifles land ~0.9 m (≈ Slugthrower 0.85 m span) so most guns scale ≈ 1; snipers
(1.66 m) scale ~0.54, shotguns (0.64 m) scale ~1.32. The runtime sets
`weaponRoot.scale = scale` and the mount already folds scale into `pos`.

## 5. Muzzle/stock detection + the ONE manual confirm

The barrel end is the THINNER cross-section; the stock end is thicker (stock +
grip + mag). The solver picks muzzle = thin end. This is a HEURISTIC — a few
weapons (short pistols, bullpups) can read backwards. The formula's only manual
step: render the weapon in-hand / in-game once; if the bore points at the
character, re-run `solve_socket.py … --flip` and freeze. Everything else is
deterministic.

## 6. RESKIN DARK (texture × tint)

`convert_weapon.py` samples each face's atlas color (convert_props heuristics),
quantizes to ≤16 zones, and writes a 64×64 (4×4-cell) palette PNG with faces
UV'd to cell centers. The DARK tint:

- **Gunmetal (non-accent):** value-only remap into a tight dark band
  (`luma_floor 0.045 + luma_span 0.235·luma^0.85`), FULLY NEUTRAL grey (ART
  DIRECTION "value over hue") + a value-scaled cool bias so warm source zones
  never leak amber and near-blacks stay neutral.
- **Accent (minimal, consistent):** the single most-saturated zone whose
  SURFACE AREA ≤ 7% (a light/sight/cell — never the body) is remapped to a
  FIXED house ember (`hue 0.055, sat 0.60, luma 0.38`). Weapons with no small
  saturated detail get pure gunmetal (no accent) — that is correct "minimal".

Verified by decoding the palette PNG pixels (ground truth) — the matcap render
is a secondary check; a dark-on-dark EEVEE render is an unreliable visual judge,
in-game matcap+post is authoritative.

## 7. Runtime wire (FE render, no parallel pipeline)

- **Assets:** `client-3d/public/assets/pawn-pack/weapons/<id>.glb` (dark palette
  embedded) + `<id>_attach.json` + `weapons_manifest.json`.
- **Loader:** `pawnPack.ts` `loadWeaponsRegistry()` (404-safe) → `pack.weapons:
  Map<assetKey, {scene, spec, scale, silhouetteClass}>`.
- **Rig:** `SlugthrowerRig` ctor extended with optional `(spec, weaponScene, scale)`
  defaulting to the Slugthrower — one class, per-weapon parameterized; drop
  lifecycle untouched. Mag node optional (synty guns are single-mesh; reload
  still ticks server-side, no mag-swap visual).
- **Selection:** `pawns.ts` `syntyWeaponAssetKey(actor)` maps equipped
  `weaponItemId` (wins) or `weaponId` string → assetKey; `ensureSlugthrower` builds the
  rig with that model; the rig rebuilds on weapon change. Weapon-scene materials
  matcap-converted once (map survives).
- **Verification hook:** `window.__successorWeaponModel = "<assetKey>"` forces
  the model on armed pawns (harness smoke / attach proof), mirroring
  `__successor3dWeapon` / `__successorFx`.

## 8. Verification gates (per weapon)

1. `gltf-transform validate` rc 0 (numErrors 0), one material `PawnPalette`,
   baseColorTexture present, TEXCOORD_0 present, tris ≤ 3000.
2. Palette-pixel check: ≤1 accent cell (area-capped), rest neutral dark.
3. EEVEE matcap hero (render_matcap.py) — silhouette/value read.
4. **In-game (authoritative):** equip → `__successorFx` muzzle origin ≈
   the weapon's `muzzle` socket world (not chest fallback); held / aimed /
   fired / stowed screenshots. Iso lies about held barrels — assert muzzle
   NUMERICALLY (grip→muzzle world vector), not by eye.

## 9. The mechanical recipe (copy for weapon N+1)

```bash
cd pawn-forge/pawnforgev2/_bakeoff/synty_weapons_20260708
FBX=stage/sw__SM_Wep_XXX.fbx; ID=wpn_xxx; CLS=rifle
SLUGTHROWER="${SUCCESSOR_REPO_ROOT:?set Successor repository root}/client-3d/public/assets/pawn-pack/slugthrower_attach.json"
# 1) dark GLB (palette map + tint)
blender -b --factory-startup -P scripts/convert_weapon.py -- --input $FBX --output glb/${ID}_dark.glb --id $ID --report qa/${ID}.json
# 2) attach spec (grip formula, mount-transfer vs pawn rig)
blender -b --factory-startup -P scripts/solve_socket.py  -- glb/${ID}_dark.glb attach/${ID}_attach.json $CLS $SLUGTHROWER
# 3) EEVEE matcap hero
blender -b --factory-startup -P scripts/render_matcap.py -- glb/${ID}_dark.glb renders $ID 3q side front
# 4) validate
npx @gltf-transform/cli validate glb/${ID}_dark.glb
# 5) stage into client-3d + add a weapons_manifest.json row; add SYNTY_MODEL_BY_ITEM/ID entry
# 6) in-game confirm (window.__successorWeaponModel="wpn_xxx"); --flip if backwards; freeze.
```

Two data rows land per weapon: a `weapons_manifest.json` entry and a
`SYNTY_MODEL_BY_ITEM` / `SYNTY_MODEL_BY_WEAPONID` map entry. The CLASS stats +
cert tier are the sim/CombatDoctrine's rows keyed on the weapon id. The model is
cosmetic; the class carries the intrinsic stats — the owner's
profession-learned-vs-weapon-intrinsic split falls out cleanly.
