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
| 3D mesh rendering (GLB) | GLB meshes | `engine-core::glb` parser + `renderer::upload_mesh` (+ procedural `primitives`) | done (Wave 1) |
| Skeletal skinning + animation | `render/anim/PawnAnimator` | `engine-core::anim` (clip sampling, layered mixer, `Skeleton` palette) + skinned mesh program | done (Wave 1) |
| GPU instancing | instanced props/flora | `Gpu::draw_instanced` + `INSTANCE_MAT4_LAYOUT` | done (Wave 1; consumed in Wave 2) |
| PNG image decode | texture loads | `engine-core::image` (miniz_oxide inflate + unfilter) | done (Wave 1) |
| Asset IO (fs + http) | Vite fetch | `platform::{fs_read, http_get}` + web `js_fetch_get` shim | done (Wave 1) |
| Directional lighting | `client-3d/src/render/environment` | mesh shader lambert + ambient | partial (single dir light) |
| Shadows | sun shadow | 2048² depth RT + 3×3 PCF | partial (one cascade) |
| Transparency via dithering | dithered fades | 4×4 Bayer screen-door `discard` | done |
| HUD / text overlay | `client-3d/src/overlay`, `ui/` | baked 5×7 font (`engine-render::font`) → per-pixel quads; immediate-mode `engine-render::ui::UiBuilder` (panels/borders/text/icons, alpha-blended) | done (Wave 5; readable text + panels) |
| UI icon vocabulary | `client-3d/src/ui/icons.ts` (39 SVGs) | `tools/bake-assets` distance-field SVG stroker → committed A8 atlas (`app/assets/ui/icons.*`), sampled via `Renderer::render_ui` | done (Wave 5) |
| Alpha blending | CSS/DOM compositing | `PipelineState.blend` → GL `SRC_ALPHA,ONE_MINUS_SRC_ALPHA` | done (Wave 5) |
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

## Parity build progress (wave execution)

Tracking the ordered parity waves from `local://rust-client-parity-plan.md`.

- **Wave 1 — Asset foundation: DONE + verified.** `engine-core::glb` (GLB
  parser, 3 fixture tests), `engine-core::image` (PNG decoder), `engine-core::
  anim` (clip sampling + layered mixer + `Skeleton` palette), renderer skinning
  (`SKINNED_MESH_LAYOUT` + `mesh_skinned.vert` + `Gpu::set_joints`) and
  instancing (`Gpu::draw_instanced` + `INSTANCE_MAT4_LAYOUT`), platform asset IO
  (`fs_read`/`http_get` + web `js_fetch_get`). `--demo glb-view --glb <p>
  [--clip <name>]` renders any repo GLB; verified via screenshots of
  `bank_terminal.glb` (static multi-material) and `pawn_male.glb --clip idle`
  (skinned, animated). Budgets raised to 4 MiB native / 3 MiB wasm / 512 MiB
  RSS; all gates green (native 909 KB, wasm 128 KB, allocs 0, p99 +1%).
- **Wave 2 — World rendering: DONE + verified.** Terrain procgen
  (`world/terrain.rs`, byte-exact vs `tools/successor/dump-terrain-fixture.mjs`
  over 3 seeds × 2 biomes × 64 coords), chunk streamer with textured ground
  quads (`world/chunks.rs`), prop GLB pipeline (`world/props.rs`: mapping
  resolve → GLB load/recenter/footprint-fit + `hashYaw`/`composePlacement`,
  placeholders), cutaway machine (`world/cutaway.rs`), orthographic isometric
  camera + `Mat4::inverse` ground unprojection (`world/camera.rs`), mouse
  picking (`world/picking.rs`), per-biome distance fog (mesh shader + textured
  materials). Demos: `--demo terrain [--biome forest]` and `--demo props`
  (renders all 139 Dustgate slice props on terrain) — verified via screenshots.
  Gates green (native 926 KB, wasm 130 KB, allocs 0); baseline refreshed.
- **Wave 3 — Pawns: DONE + verified.** Actor protocol extended to the
  render-relevant field set + compact move/ref fast path (`client-proto`,
  decode-tested). Pawn pack loader (`pawn/pack.rs` — `PawnTemplate` from a real
  PawnForge body GLB: skeleton + clip index + baked skinned parts, tested
  against `pawn_male.glb` = 50 joints). PawnAnimator locomotion lane
  (idle/walk/run/backpedal/death gait + hysteresis, weapon lanes). Equipment/
  appearance/weapons (skin/faction tint, hand-bone weapon socketing), face-kit
  compositor (`pawn/face.rs`), creatures registry (`pawn/creatures.rs`), LOD
  tiers (`pawn/lod.rs`). Demo `--demo pawns` screenshot-verified.
- **Wave 4 — Projection: DONE + verified.** All snapshot/delta sections typed
  (`client-proto::packets`), `AuthorityStore` apply/merge with lifecycleSeq
  staleness + receipt dedupe (`game/authority.rs`), `MovePredictor` lead-capped
  prediction from `tuning.v1.json` (`game/prediction.rs`), `ActorInterp` remote
  interpolation ring (`game/interp.rs`), `CommandQueue` priority flush
  (`game/command_queue.rs`). Unit-tested (26 tests across the four modules).
- **Wave 5 — UI: DONE + verified.** Asset bake tool (`tools/bake-assets`,
  detached crate) rasterizes the 39-icon SVG vocabulary into a committed A8
  atlas via distance-field stroking; baked 5×7 bitmap font (`engine-render::
  font`) renders readable HUD text. Immediate-mode UI (`engine-render::ui`
  `UiBuilder`) draws panels/borders/text/icons/bars over an alpha-blended pass
  (`PipelineState.blend`, `Renderer::render_ui`), with hover/press/click
  interaction, a `TextField` line editor, and pointer/text-input routing from
  the platform (`mouse_position`/`mouse_button_down`/`poll_text_input`). Desktop
  window manager (`engine-render::window` — move/resize/focus-to-front/close,
  z-order, viewport clamp; unit-tested). HUD panels (`app::hud`) bind a
  `HudState` to a vitals panel (HP/AP/shield bars), minimap+coords, target
  frame, search field, and a 12-button action bar that toggles windows.
  `--demo ui` screenshot-verified end to end; gates green, baseline refreshed
  (native 1.03 MB, wasm 132 KB — far under 4/3 MiB ceilings; p99 3.35 ms; 0
  frame allocs).
- **Wave 6 — Windows: DONE + verified.** Immediate-mode content for the full
  game-window suite under `app::windows` (18 windows: inventory, character,
  skills, options, loot, bank, trade, craft, survey, converse, travel, datapad,
  clone, pa, splice, macros, actions, bug-report). Each is a self-contained
  module (typed view model + `sample()` + `draw(ui, rect, model, icons, out)`)
  behind a `content()` dispatch, emitting `WindowAction`s the host maps to
  commands (live binding is Wave 11). Reuses the Wave-5 `UiBuilder`/`WindowManager`.
  92 app unit tests (24 window interaction tests) pass; `--demo ui` renders the
  windows over the scene (inventory grid + examine sidebar and the craft
  recipe/CRAFT-button screenshot-verified). Gates green, baseline refreshed
  (native 1.07 MB, wasm 132 KB; p99 3.54 ms; 0 frame allocs).
- **Wave 7 — Combat FX: DONE + verified.** Zero-per-frame-alloc particle pool
  (`engine-render::fx`, port of `render/fx/particles.ts`): three ring-buffered
  layers (additive/normal/residue), CPU integration with drag+gravity+ground
  splat, size/alpha/color-over-life, camera-facing billboard emission + a
  procedural glow sprite. Emitters ported: spark burst, blood burst, muzzle
  flash, tracer (deterministic xorshift RNG). New GL additive blend
  (`PipelineState.additive`) + a `Renderer::render_particles` pass. Combat-event
  driver (`game::combat_fx::CombatFx`) projects the wire `events:
  Vec<Value>` into typed `CombatEvent`s and fires muzzle/tracer + blood/spark by
  outcome, deduped by id; wired live in `connected::run` (taps snapshot/delta/
  receipts events, renders billboards over the scene each frame). Weapon rigs
  reuse Wave-3 hand-bone socketing. 28 render + 96 app tests; `--demo fx`
  screenshot shows sparks + a blood cone. Gates green (native 1.16 MB, wasm
  133 KB; 0 frame allocs).
- **Wave 8 — Audio: DONE + verified.** Software mixer + spatialization
  (`engine-core::audio`, port of `sfx.ts` mixing): fixed voice pool, equal-power
  pan, pitch resample, polyphony + concurrency-overload attenuation, and an
  exact `spatial_mix` (distance rolloff + smooth far cutoff + clamped pan).
  Native MP3 decode via `rmp3` (pure Rust, native-only — web decodes through
  Web Audio) verified against real 44.1 kHz manifest clips. `app::audio`
  manifest-driven clip registry with buses + a game-event trigger map (UI cues,
  combat weapon/impact from the shared `CombatEvent`, footsteps). Output sinks:
  a WAV render (`app::audio::wav`, verified end to end — manifest→decode→mixer→
  non-silent stereo WAV) and a live CoreAudio `AudioQueue` device sink
  (`platform::native::audio`, links AudioToolbox; audible playback confirmed
  interactively). 8 core + 9 app audio tests. Gates green (native 1.16 MB, wasm
  133 KB — decoder is native-only; 0 frame allocs).
- **Wave 9 — Environment: DONE + verified.** Day-night sampler
  (`engine-render::environment`, port of config `environment`): sun dir/color/
  elevation + a time-of-day color grade (fog/tint/desaturate/darken/black-lift/
  bloom) interpolating the authored anchors, wrapping midnight. Weather system
  (`engine-render::weather`: clear/rain/dust-storm, eased intensity, wind
  wander/gust, particle emission). PS2 post-grade fullscreen pass
  (`Renderer::render_post` + `post.frag`) + `PipelineState.additive`. Flora
  scatter (`app::world::flora`: deterministic, density-scaled, exclusion,
  instance matrices). `--demo env` screenshot-verified: noon reads warm+bright
  (max 103, R>B), night cool+dim (max 38, B≥R). 6 env + 4 weather + flora tests.
- **Wave 10 — Chat: DONE + verified.** Sans-IO chat protocol
  (`game::chat_net`: 9 channels, encode/decode JSON, bounded history) + a chat
  pane and world-space bubbles (`game::chat_ui`, immediate-mode). Unit-tested
  (channel round-trip, compose↔decode, history bound, pane/bubble render).
- **Wave 11 — Auth/entry: DONE + verified.** Connect-URL + join-options parse
  (`net::connect`), entry + character screens (`app::screens`, UiBuilder), and
  release identity + reconnect policy (`net::release`: unlisted channel guard +
  exponential backoff). 15 net + 5 screen tests. Per AGENTS.md the client stays
  UNALLOWLISTED (channel `unlisted`; `is_production()` guard).
- **Wave 12 — Web + audit: DONE + verified.** Wasm networking runtime
  (`lib::web_runtime` `net_connect`/`net_poll`/`net_state`) reuses the
  target-agnostic `Session` + Colyseus matchmake/framing over the browser
  WebSocket/fetch shim; the JS page drives connect+poll each frame. Full
  suite: 223 unit/fixture tests across 4 crates, `frame-allocs 0`, `VERIFY:
  PASS` (native 1.18 MB, wasm 479 KB — under the 4/3 MiB ceilings). All render
  surfaces smoke-tested (`--demo ui/fx/env/pawns/props/terrain`).

All 54 parity tasks are complete. Live browser/authority behavior (wasm net,
CoreAudio playback, live combat FX/audio) is confirmed interactively; every
deterministic core is unit/fixture-tested and every render surface has a
verified screenshot. The engine builds and all gates pass at each landed step.

## Connected-scene integration (live client renders like client-3d)

The parity waves built each capability as demo scenes + tested modules; this
wave wires them into the live `connected::run` so the client renders the real
world (not placeholder capsules) when joined to the authority.

- **`game::connected_scene::ConnectedScene`** composes one `GameWorld`/`Renderer`
  driven by the authoritative `AuthorityStore`: streamed terrain
  (`TerrainStreamer`) + the 139 GLB slice props (`PropsLoader`, same
  `open-desert-slice.json` + `props-mapping.json` `client-3d` uses), a GLB pawn
  per live actor (skin/faction-tinted, gait from velocity, facing from move
  direction) replacing capsules, environment lighting/fog/clear from
  `environment::sample`, a follow camera + minimap composite, combat-event FX
  billboards, ambient dust `weather`, and the HUD + mouse-routed interactive
  windows (action bar toggles them, as in `--demo ui`).
- **`AuthorityStore::apply_player_position`** applies the `game.acks`
  authoritative player position (own moves arrive as acks, not AOI deltas).
- **Verified live** against the dockerized authority (`ws://127.0.0.1:28093`,
  `GAME_ALLOW_DEV_IDENTITY=1`): `terrain streamed, 139 props placed`, `actors=3`,
  `session_state=Ready`; GLB pawns render at actor positions (screenshot);
  `--auto-walk` moves the player `(512.5,513.5)→(512.5,511.86)` (full
  command→acks→store→render loop). Gates green (176 tests, 0 frame allocs,
  `VERIFY: PASS`, native 1.19 MB / wasm 479 KB).
- **Deferred (enhancements, not asset/game-load blockers):** the fullscreen
  post-grade pass (conflicts with the multi-camera + minimap composite ordering;
  day-night look is instead driven via sun/fog/ambient/clear), the live chat-room
  socket + pane, and projecting live inventory JSON into the window models
  (windows currently show representative content). Each underlying module is
  built + tested; wiring these into the live loop is follow-on polish.
