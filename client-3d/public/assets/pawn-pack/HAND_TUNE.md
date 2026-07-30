# Vibrosword hand tune

Runtime file: `client-3d/public/assets/pawn-pack/vibrosword_attach.json`.

Current weld values live in `mount_hand_r_local`:

- `pos`: hand_r-local meters for the `Gear_vibrosword` frame origin.
- `quat`: hand_r-local quaternion, xyzw.
- Weapon frame: origin at guard plane; +Z points to blade tip; -Z points down the hilt/pommel; +Y is spine/up; +X is blade right face.

Hand nudge rules:

- Edit `mount_hand_r_local.pos` for small rest/clearance moves. Use 0.005-0.02 m steps.
- To slide the sword in its own local axes, compute `pos += quat * deltaLocal`.
  - `deltaLocal.z < 0` moves the hilt so the hand lands closer to the guard.
  - `deltaLocal.z > 0` moves the hilt so the hand lands lower toward the pommel.
  - `deltaLocal.x/y` move across the blade face/spine; verify visually because the hand bone axes are not intuitive.
- Edit `mount_hand_r_local.quat` only for grip angle. For a local-axis rotation, use `quat = quat * qLocalAxis(angle)` and recompute `pos` around the desired sword-local grip pivot so the right palm stays planted.
- Keep `nodes.frame` equal to the GLB mesh node name: `Gear_vibrosword`.
- If the hilt mesh changes, update `sockets.wrap_top`, `wrap_mid`, `wrap_bottom`, and `pommel` to match the promoted GLB-local Z positions.

Re-cook / sync chain:

```bash
cd pawn-forge
blender -b -P pawnforgev2/harness/cook_game_pack_v2.py
python3 pawnforgev2/harness/verify_game_pack.py

cd successor
pnpm --dir client-3d exec node scripts/sync-pawn-pack.mjs pawn-forge/export/game_pack
npx --yes @gltf-transform/cli validate client-3d/public/assets/pawn-pack/vibrosword.glb
```

If Vite was already running, restart it after sync; the dev server snapshots `public/` at boot.

Visual-edit route:

- Open `pawn-forge/pawnforgev2/harness/weapons_play.blend`.
- Load the current `export/game_pack/pawn_male.glb` and `vibrosword.glb`.
- Pose the pawn on `melee_idle`, `melee_ready`, and `swing_h1`; parent a weapon frame empty to `hand_r` using the JSON `pos`/`quat` as the starting transform.
- Move/rotate the weapon frame until the right palm sits on the upper hilt and the left palm sits lower on the hilt, then write the frame's hand_r-local location/quaternion back to `vibrosword_attach.json`.
- Export/sync with the command chain above.
