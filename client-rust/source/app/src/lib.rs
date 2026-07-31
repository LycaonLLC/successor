//! Successor Rust client — composition root (library side).
//!
//! Binds the engine, renderer, and (native) platform + protocol into the
//! `GameWorld` and the demo/playable runners. The native binary is `main.rs`;
//! the wasm cdylib exports live here behind `target_arch = "wasm32"`.

#[cfg(not(target_arch = "wasm32"))]
pub mod audio;
pub mod demo;
#[cfg(not(target_arch = "wasm32"))]
pub mod game;
#[cfg(not(target_arch = "wasm32"))]
pub mod glb_scene;
#[cfg(not(target_arch = "wasm32"))]
pub mod hud;
pub mod material_parity;
#[cfg(not(target_arch = "wasm32"))]
pub mod net;
#[cfg(not(target_arch = "wasm32"))]
pub mod pawn;
pub mod rss;
#[cfg(not(target_arch = "wasm32"))]
pub mod screens;
#[cfg(not(target_arch = "wasm32"))]
pub mod windows;
pub mod world;

use successor_engine_core::world;
use successor_engine_render::components::{
    Camera, CompositeQuad, DirectionalLight, MeshRenderer, ModelRef, PointLight, TextOverlay,
    Transform,
};

// The concrete ECS world: the render component set (Transform/Mesh/Camera/…)
// plus `ModelRef` so asset-key prefabs resolve into `MeshRenderer`s.
world! { pub struct GameWorld {
    transform: Transform,
    model: ModelRef,
    mesh: MeshRenderer,
    camera: Camera,
    light: DirectionalLight,
    point_light: PointLight,
    composite: CompositeQuad,
    text: TextOverlay,
} }

// --- render quality selection (process-global; set from `--quality`/`?quality=`) ---
use core::sync::atomic::{AtomicU8, Ordering};
use successor_engine_render::renderer::{RenderQuality, RendererLimits};

static RENDER_QUALITY: AtomicU8 = AtomicU8::new(1); // 0=Low, 1=Medium, 2=High

/// Set the process-wide render quality tier (call before building any scene).
pub fn set_render_quality(q: RenderQuality) {
    let v = match q {
        RenderQuality::Low => 0,
        RenderQuality::Medium => 1,
        RenderQuality::High => 2,
    };
    RENDER_QUALITY.store(v, Ordering::Relaxed);
}

/// Parse a quality string (`low`/`medium`/`high`); unknown → Medium.
pub fn parse_quality(s: &str) -> RenderQuality {
    match s {
        "low" => RenderQuality::Low,
        "high" => RenderQuality::High,
        _ => RenderQuality::Medium,
    }
}

/// Current render quality tier.
pub fn render_quality() -> RenderQuality {
    match RENDER_QUALITY.load(Ordering::Relaxed) {
        0 => RenderQuality::Low,
        2 => RenderQuality::High,
        _ => RenderQuality::Medium,
    }
}

/// Renderer limits at the current quality tier (tier-derived shadow size).
pub fn quality_limits() -> RendererLimits {
    let quality = render_quality();
    RendererLimits {
        quality,
        ..RendererLimits::default()
    }
}

// Allocation-counting global allocator: installed only under `alloc-count`, so
// the `make check-allocs` build proves zero steady-state per-frame allocations
// while normal builds pay nothing.
#[cfg(feature = "alloc-count")]
#[global_allocator]
static GLOBAL: successor_engine_core::rt::alloc::CountingAllocator<std::alloc::System> =
    successor_engine_core::rt::alloc::CountingAllocator::new(std::alloc::System);

// --- wasm runtime -----------------------------------------------------------
// Exported entry points the JS shim (`web/successor.js`) drives. Keeping the
// render/engine code reachable from these `#[no_mangle]` exports is also what
// gives the wasm module a meaningful (non-DCE'd) size for the size gate.
#[cfg(target_arch = "wasm32")]
mod web_runtime {
    use crate::demo::{build_scene, Scene};
    use successor_engine_core::rt::cell::GlobalCell;
    use successor_platform::GlGpu;

    static GPU: GlobalCell<GlGpu> = GlobalCell::new();
    static SCENE: GlobalCell<Scene> = GlobalCell::new();
    static PARITY_SCENE: GlobalCell<crate::material_parity::Scene> = GlobalCell::new();
    static TERRAIN_SCENE: GlobalCell<crate::world::chunks::TerrainScene> = GlobalCell::new();
    static DEMO_SELECTOR: GlobalCell<u32> = GlobalCell::new();
    static FRAME: GlobalCell<u64> = GlobalCell::new();
    static SIZE: GlobalCell<(u32, u32)> = GlobalCell::new();

    #[no_mangle]
    pub extern "C" fn init(demo_selector: u32) {
        successor_platform::init("Successor", 1280, 720);
        let mut gpu = successor_platform::create_gpu();
        if demo_selector == 1 {
            let assets = [
                successor_platform::http_get("parity-assets/commerce_facility.glb")
                    .expect("commerce asset"),
                successor_platform::http_get("parity-assets/lightning_carbine.glb")
                    .expect("lightning asset"),
                successor_platform::http_get("parity-assets/mossmuff_adult.glb")
                    .expect("mossmuff asset"),
                successor_platform::http_get("parity-assets/successor_food_beer_mug.glb")
                    .expect("beer mug asset"),
                successor_platform::http_get("parity-assets/field_cap.glb")
                    .expect("field cap asset"),
                successor_platform::http_get("parity-assets/megalith_brick_hex.glb")
                    .expect("megalith asset"),
            ];
            let scene =
                crate::material_parity::build(&mut gpu, &assets).expect("material parity scene");
            PARITY_SCENE.set(scene);
        } else if demo_selector == 2 {
            let mut scene = crate::world::chunks::TerrainScene::build(
                &mut gpu,
                crate::world::terrain::Biome::Desert,
            );
            scene.use_material_detail_view();
            TERRAIN_SCENE.set(scene);
        } else {
            SCENE.set(build_scene(&mut gpu));
        }
        GPU.set(gpu);
        DEMO_SELECTOR.set(demo_selector);
        FRAME.set(0);
        SIZE.set((1280, 720));
    }

    #[no_mangle]
    pub extern "C" fn resize(w: i32, h: i32) {
        SIZE.set((w.max(1) as u32, h.max(1) as u32));
    }

    #[no_mangle]
    pub extern "C" fn update(_dt_ms: f32) {
        let f = FRAME
            .get_mut()
            .map(|f| {
                *f += 1;
                *f
            })
            .unwrap_or(0);
        if DEMO_SELECTOR.get_mut().copied().unwrap_or(0) == 0 {
            if let Some(scene) = SCENE.get_mut() {
                scene.animate(f);
            }
        }
    }

    #[no_mangle]
    pub extern "C" fn render() {
        let (w, h) = SIZE.get_mut().copied().unwrap_or((1280, 720));
        if let Some(gpu) = GPU.get_mut() {
            if DEMO_SELECTOR.get_mut().copied().unwrap_or(0) == 1 {
                if let Some(scene) = PARITY_SCENE.get_mut() {
                    scene
                        .renderer
                        .render(gpu, &mut scene.world, w, h)
                        .expect("render failed");
                }
            } else if DEMO_SELECTOR.get_mut().copied().unwrap_or(0) == 2 {
                if let Some(scene) = TERRAIN_SCENE.get_mut() {
                    scene
                        .renderer
                        .render(gpu, &mut scene.world, w, h)
                        .expect("terrain render failed");
                }
            } else if let Some(scene) = SCENE.get_mut() {
                scene
                    .renderer
                    .render(gpu, &mut scene.world, w, h)
                    .expect("render failed");
            }
        }
    }

    #[no_mangle]
    pub extern "C" fn probe_material_parity() -> u32 {
        if DEMO_SELECTOR.get_mut().copied().unwrap_or(0) != 1 {
            return 0;
        }
        let (width, height) = SIZE.get_mut().copied().unwrap_or((0, 0));
        let pixels = successor_platform::read_pixels_rgba(width as i32, height as i32);
        match crate::material_parity::probe_rgba_top_left(&pixels, width, height) {
            Ok(_) => 1,
            Err(error) => {
                successor_engine_core::rt::log::log_str(&error);
                0
            }
        }
    }

    #[no_mangle]
    pub extern "C" fn probe_terrain_material() -> u32 {
        if DEMO_SELECTOR.get_mut().copied().unwrap_or(0) != 2 {
            return 0;
        }
        let (width, height) = SIZE.get_mut().copied().unwrap_or((0, 0));
        let pixels = successor_platform::read_pixels_rgba(width as i32, height as i32);
        match crate::world::terrain_material::probe_rgba(&pixels, width, height) {
            Ok(probe) => {
                successor_engine_core::rt::log::log_str(&format!(
                    "terrain probe stddev={:.5} neighbor={:.5}\n",
                    probe.luma_stddev, probe.neighbor_delta
                ));
                1
            }
            Err(error) => {
                successor_engine_core::rt::log::log_str(&error);
                0
            }
        }
    }

    // --- wasm networking runtime --------------------------------------------
    // The sans-IO `Session` FSM + Colyseus matchmake/framing (client-proto) are
    // target-agnostic; here they run on the browser WebSocket/fetch shim
    // (`platform::web::net`). JS drives `net_connect` once, then `net_poll` each
    // frame; `net_state` exposes the handshake state for the page.
    use serde_json::json;
    use successor_client_proto::colyseus;
    use successor_client_proto::session::{Session, SessionOut, WsInput};

    static SESSION: GlobalCell<Session> = GlobalCell::new();
    static WS: GlobalCell<successor_platform::WsHandle> = GlobalCell::new();

    #[no_mangle]
    pub extern "C" fn net_connect() {
        // Dev endpoint; the server gates on GAME_ALLOW_DEV_IDENTITY. A
        // configurable endpoint from the page lands with the connect-URL wiring.
        let endpoint = "ws://127.0.0.1:28093";
        let http = endpoint
            .replacen("wss://", "https://", 1)
            .replacen("ws://", "http://", 1);
        let opts = json!({ "playerId": "dev-1", "actorId": "dev-1" });
        let (url, body) = match colyseus::build_matchmake_request(&http, &opts) {
            Ok(v) => v,
            Err(_) => return,
        };
        let resp = match successor_platform::http_post_json(&url, &body) {
            Ok(r) => r,
            Err(_) => return,
        };
        let seat = match colyseus::parse_seat_reservation(&resp) {
            Ok(s) => s,
            Err(_) => return,
        };
        let ws_url = colyseus::build_ws_url(endpoint, &seat);
        if let Ok(ws) = successor_platform::ws_connect(&ws_url) {
            let mut s = Session::new();
            s.start_connecting();
            SESSION.set(s);
            WS.set(ws);
        }
    }

    #[no_mangle]
    pub extern "C" fn net_poll() {
        let (sess, ws) = match (SESSION.get_mut(), WS.get_mut()) {
            (Some(s), Some(w)) => (s, w),
            _ => return,
        };
        let mut buf: Vec<u8> = Vec::new();
        loop {
            buf.clear();
            let ev = successor_platform::ws_poll(ws, &mut buf);
            let outs = match ev {
                successor_platform::WsEvent::Open => sess.on_ws_event(WsInput::Open),
                successor_platform::WsEvent::Frame(n) => {
                    sess.on_ws_event(WsInput::Frame(&buf[..n]))
                }
                successor_platform::WsEvent::Closed => {
                    let o = sess.on_ws_event(WsInput::Closed);
                    send_frames(ws, o);
                    break;
                }
                successor_platform::WsEvent::Error => {
                    let o = sess.on_ws_event(WsInput::Error("ws error"));
                    send_frames(ws, o);
                    break;
                }
                successor_platform::WsEvent::None => break,
            };
            send_frames(ws, outs);
        }
    }

    fn send_frames(ws: &mut successor_platform::WsHandle, outs: Vec<SessionOut>) {
        for o in outs {
            if let SessionOut::SendFrame(f) = o {
                successor_platform::ws_send(ws, &f);
            }
        }
    }

    /// Session handshake state as a small code for the page (0 = not started).
    #[no_mangle]
    pub extern "C" fn net_state() -> u32 {
        SESSION.get_mut().map(|s| s.state() as u32).unwrap_or(0)
    }
}
