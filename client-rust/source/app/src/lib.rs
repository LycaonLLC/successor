//! Successor Rust client — composition root (library side).
//!
//! Binds the engine, renderer, and (native) platform + protocol into the
//! `GameWorld` and the demo/playable runners. The native binary is `main.rs`;
//! the wasm cdylib exports live here behind `target_arch = "wasm32"`.

pub mod demo;
#[cfg(not(target_arch = "wasm32"))]
pub mod game;
pub mod rss;

use successor_engine_core::world;
use successor_engine_render::components::{
    Camera, CompositeQuad, DirectionalLight, MeshRenderer, ModelRef, TextOverlay, Transform,
};

// The concrete ECS world: the render component set (Transform/Mesh/Camera/…)
// plus `ModelRef` so asset-key prefabs resolve into `MeshRenderer`s.
world! { pub struct GameWorld {
    transform: Transform,
    model: ModelRef,
    mesh: MeshRenderer,
    camera: Camera,
    light: DirectionalLight,
    composite: CompositeQuad,
    text: TextOverlay,
} }

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
    static FRAME: GlobalCell<u64> = GlobalCell::new();
    static SIZE: GlobalCell<(u32, u32)> = GlobalCell::new();

    #[no_mangle]
    pub extern "C" fn init() {
        successor_platform::init("Successor", 1280, 720);
        let mut gpu = successor_platform::create_gpu();
        let scene = build_scene(&mut gpu);
        GPU.set(gpu);
        SCENE.set(scene);
        FRAME.set(0);
        SIZE.set((1280, 720));
    }

    #[no_mangle]
    pub extern "C" fn resize(w: i32, h: i32) {
        SIZE.set((w.max(1) as u32, h.max(1) as u32));
    }

    #[no_mangle]
    pub extern "C" fn update(_dt_ms: f32) {
        let f = FRAME.get_mut().map(|f| { *f += 1; *f }).unwrap_or(0);
        if let Some(scene) = SCENE.get_mut() {
            scene.animate(f);
        }
    }

    #[no_mangle]
    pub extern "C" fn render() {
        let (w, h) = SIZE.get_mut().copied().unwrap_or((1280, 720));
        if let (Some(gpu), Some(scene)) = (GPU.get_mut(), SCENE.get_mut()) {
            scene.renderer.render(gpu, &mut scene.world, w, h);
        }
    }
}
