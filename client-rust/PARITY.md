# Rust client — parity matrix

Tracks progress toward 1:1 parity with the existing web client (`client-3d/`)
so "replace the web client" is measurable. This client is **pre-parity and
unshipped**; the web/desktop/TUI clients remain the supported surfaces.

Status legend: **done** (delivered + gated), **partial** (foundation present,
not complete), **backlog** (not started — ordered wave).

## Foundation (this milestone)

| Capability | Web-client reference | Engine mechanism | Status |
| --- | --- | --- | --- |
| ECS (entities/components/systems) | `client/src/slice-core/*` | `successor-engine-core::ecs` (`world!`, dense/sparse storage, `Query1/2`) | done |
| Prefab / JSON / asset layer | `client/src/slice-core/specs`, `client-3d/.../props-mapping.json`, `runtimePublicPaths.ts` | `engine-core::{json, assets, prefab}` (versioned `schema`/`format`, manifest-by-id, fail-closed path resolver, `world_prefab!`) | done |
| Renderer core | `client-3d/src/render/` | `engine-render` `Gpu` trait + `Renderer` (generic, monomorphized) | done |
| Multiple cameras | `client-3d/src/render/` cameras | `Camera` component (`viewport_id`, `order`) | done |
| Render-to-texture + compositing | portrait/minimap/overlay renders | `CamTarget::Texture` + `CompositeQuad` | done |
| Viewport tagging (entity in many views) | n/a (new model) | `MeshRenderer.viewport_mask` bitmask vs `Camera.viewport_id` | done |
| Basic 3D mesh rendering | GLB meshes | `primitives::{cube,plane,capsule}` + indexed draw | partial (procedural only) |
| Directional lighting | `client-3d/src/render/environment` | mesh shader lambert + ambient | partial (single dir light) |
| Shadows | sun shadow | 2048² depth RT + 3×3 PCF | partial (one cascade) |
| Transparency via dithering | dithered fades | 4×4 Bayer screen-door `discard` | done |
| HUD / text overlay | `client-3d/src/overlay`, `ui/` | `TextOverlay` + block-glyph layout | partial (block glyphs) |
| Wire protocol (Colyseus) | `@colyseus/sdk` in `gameAuthoritySystem.ts` | `client-proto::{colyseus, session}` (sans-IO) | done |
| Command vocabulary | `crates/successor-net` | reuse `ClientCommand`/`ClientCommandEnvelope` (117 cmds) | done |
| Snapshot/delta projection | `gameAuthoritySystem.ts` | `client-proto::packets` + `game/projection.rs` | partial (actor id/pos/vitals/dir) |
| Movement input → command | `authorityMovementSystem.ts` | `game/movement.rs` (`SetMoveIntent`) | done |
| Follow + minimap cameras (live) | camera rig | `connected::run` | done (compile+unit; live Bunker-gated) |
| Chat UI (input + overlay) | `client/src/chat/chatClient.ts` HUD | `game/chat.rs` | partial (UI only) |
| Platform abstraction (desktop/web) | Vite/Electron | `successor-platform` (GLFW/GL native, WebGL2 web) | done |
| Size / alloc / perf / RSS gates | n/a | `budgets.json` + `bench/compare.py` + Makefile | done |

## Backlog waves (ordered)

1. **Real bitmap-font text** — replace block glyphs with an 8×16 atlas sampled
   per glyph (`text.rs` / `TextOverlay`).
2. **GLB / PawnForge pawns** — load promoted GLB actors + face compositor
   (`client-3d/src/render/pawns.ts`, `faceDecal.ts`) instead of capsules;
   requires a glTF loader behind the asset manifest already in `engine-core`.
3. **Map-bundle world geometry** — consume `open-desert-map-bundle.json`
   (props/anchors/structures/transitions) via `assets::AssetManifest` +
   `props-mapping.json` instead of the flat ground plane.
4. **Full HUD + panels** — inventory, crafting, trade, guild, vitals, radar
   (`client-3d/src/ui/`, `client/src/slice-core/*System.ts`).
5. **Chat network path** — second Colyseus chat room (chat ticket +
   `chatClient.ts` vocabulary) feeding `game/chat.rs::push_incoming`; LOCAL
   speech bubbles.
6. **Combat presentation** — roll tracers, muzzle, impact FX, outcome text
   (`client-3d/src/combat/`), driven by streamed combat events.
7. **Weather / day-night / lighting zones**, **positional audio**
   (`ambientAudioSystem.ts`, `combatAudioSystem.ts`), **effects**
   (`effectsSystem.ts`).
8. **Web runtime networking** — drive `client-proto` from the wasm build via
   the `js_ws_*`/`js_fetch_*` shim (currently the wasm renders the demo scene
   only; native does networking).
9. **Ticketed public auth** — replace dev-identity join with launch tickets.
10. **TUI + mobile backends** — new `Gpu`/platform impls behind the existing
    compile-time seam.

## Live playable-slice run (DEMONSTRATED)

The full bidirectional round-trip has been run end-to-end on macOS against a
Linux **container** authority (macOS lacks `/usr/bin/flock`, which the
persistent authority requires; a Linux container has it). Observed: session
reaches `Ready` (matchmake → join → `game.ready` → `game.hello`), the client
projects the live authority actors as capsules (player distinguished), a
`SetMoveIntent` moves the player and the new position streams back via
`game.acks` (e.g. `(512,513) → (512,511.36)`), and `exit_world` closes cleanly.

### Recipe (macOS host + Linux container authority)

```bash
# 1. Build + run the dev authority container (legacy mode, dev identity,
#    util-linux flock, persistence on). Native arm64 — no emulation.
docker build -f ops/docker/Dockerfile.dev -t successor-authority:dev .
docker run -d --name successor-authority -p 28093:28093 successor-authority:dev
curl -fsS http://127.0.0.1:28093/game/status | jq .readiness   # all true

# 2. Run the native client against the container (auto-exits after N frames).
make -C client-rust native
./client-rust/out/bin/successor \
  --endpoint ws://127.0.0.1:28093 --player-id dev-1 --actor-id dev-1 \
  --frames 900 --auto-walk --screenshot client-rust/out/live.bmp
# omit --auto-walk for interactive WASD; add --gl is implied for connected mode.
```

`--auto-walk` drives a constant north `SetMoveIntent` so the round-trip is
exercised without a keyboard; the run prints a `connected summary` with the
authority-streamed player position and writes a screenshot of the live scene.

### Alternative: host ephemeral authority (no container, no flock)

`legacy` mode + `GAME_SHARD_PERSISTENCE=0` skips the state lock entirely, so the
authority also runs directly on macOS (no persistence across relog):

```bash
cargo build -q -p successor-sim --example authority_bridge_server
PORT=28093 HOST=127.0.0.1 GAME_ALLOW_DEV_IDENTITY=1 GAME_SHARD_PERSISTENCE=0 \
  SUCCESSOR_CONTROL_PLANE_MODE=legacy \
  GAME_SLICE_PATH=client/public/successor-slice/open-desert-slice.json \
  GAME_RUST_AUTHORITY_BRIDGE_BIN=target/debug/examples/authority_bridge_server \
  node server/dist/index.js
```

### Client protocol notes (learned from the live bring-up)

- Send `game.ready` immediately on room join (the server emits `game.hello` in
  response); do not wait for hello first.
- Declare AOI `game.view` interest once `Ready`, or the shard streams nothing
  after the hello.
- Strip `null` fields from the command payload — the server's zod command
  schema uses `.optional()` (absent), not `.nullable()`; `Option::None`
  serialized as `null` is rejected.
- `SetMoveIntent` is a per-tick input: resend it while the intent is nonzero,
  not only on change, for continuous movement.

`ops/docker/Dockerfile.dev` is a LOCAL dev image only — `ops/deploy` owns the
production (amd64, standalone) publication path.
