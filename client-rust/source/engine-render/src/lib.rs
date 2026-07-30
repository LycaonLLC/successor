//! Successor Rust client — render graph.
//!
//! `no_std` + `alloc`. Defines the [`gpu::Gpu`] backend contract, the ECS
//! render components, procedural primitives, block-glyph text layout, and the
//! [`renderer::Renderer`] frame passes (shadow -> ordered cameras with viewport
//! culling -> RTT composite -> text). Platform-free: the `platform` crate
//! supplies the concrete `Gpu`.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub mod components;
pub mod environment;
pub mod font;
pub mod fx;
pub mod gpu;
pub mod primitives;
pub mod renderer;
pub mod text;
pub mod ui;
pub mod weather;
pub mod window;

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::components::*;
    use super::gpu::{ClearSpec, Gpu, MockGpu, PassTarget};
    use super::renderer::{Renderer, RendererLimits};
    use successor_engine_core::ecs::WorldOps;
    use successor_engine_core::math::{vec3, Vec2, Vec3};
    use successor_engine_core::world;

    world! { pub struct RWorld {
        transform: Transform,
        mesh: MeshRenderer,
        camera: Camera,
        light: DirectionalLight,
        composite: CompositeQuad,
        text: TextOverlay,
    } }

    #[test]
    fn viewport_mask_visibility() {
        assert!(super::renderer::visible_in(0b01, 0));
        assert!(!super::renderer::visible_in(0b01, 1));
        assert!(super::renderer::visible_in(0b11, 1));
        assert!(super::renderer::visible_in(0b101, 2));
    }

    fn setup() -> (MockGpu, Renderer, RWorld, MeshId, MaterialId) {
        let mut gpu = MockGpu::default();
        let mut r = Renderer::new(&mut gpu, RendererLimits::default());
        let (v, i) = super::primitives::cube();
        let mesh = r.upload_mesh(&mut gpu, &v, &i);
        let mat = r.add_material([0.8, 0.5, 0.2, 1.0]);
        (gpu, r, RWorld::new(), mesh, mat)
    }

    #[test]
    fn pass_order_shadow_cameras_composite_text() {
        let (mut gpu, mut r, mut w, mesh, mat) = setup();

        // Shadow-casting light.
        let l = w.spawn();
        w.set_component(l, DirectionalLight { dir: vec3(-0.4, -1.0, -0.3), color: [1.0; 3], cast_shadows: true });

        // Main screen camera (viewport 0) and minimap RTT camera (viewport 1).
        let rt = gpu.create_render_target(&super::gpu::RenderTargetDesc {
            width: 256, height: 256, color: true, depth: true, filter: super::gpu::Filter::Nearest,
        });
        let cam_main = w.spawn();
        w.set_component(cam_main, Camera {
            viewport_id: 0, order: 0,
            projection: Projection::Perspective { fovy: 1.1, near: 0.1, far: 200.0 },
            target: CamTarget::Screen(RectNorm::FULL),
            clear: ClearSpec { color: Some([0.0, 0.0, 0.0, 1.0]), depth: Some(1.0) },
            eye: vec3(0.0, 5.0, 10.0), look_at: Vec3::ZERO, up: Vec3::Y,
        });
        let cam_map = w.spawn();
        w.set_component(cam_map, Camera {
            viewport_id: 1, order: -1, // renders BEFORE main (lower order first)
            projection: Projection::Ortho { half_height: 20.0, near: 0.1, far: 200.0 },
            target: CamTarget::Texture(rt),
            clear: ClearSpec { color: Some([0.1, 0.1, 0.1, 1.0]), depth: Some(1.0) },
            eye: vec3(0.0, 50.0, 0.0), look_at: Vec3::ZERO, up: vec3(0.0, 0.0, -1.0),
        });

        // Two meshes: one visible in both viewports, one only in main.
        let e_both = w.spawn();
        w.set_component(e_both, Transform::default());
        w.set_component(e_both, MeshRenderer { mesh, material: mat, viewport_mask: 0b11, ..Default::default() });
        let e_main = w.spawn();
        w.set_component(e_main, Transform { pos: vec3(3.0, 0.0, 0.0), ..Transform::default() });
        w.set_component(e_main, MeshRenderer { mesh, material: mat, viewport_mask: 0b01, ..Default::default() });

        // Composite the minimap RT + one HUD text line.
        let q = w.spawn();
        w.set_component(q, CompositeQuad { source: rt, rect: RectNorm { x: 0.75, y: 0.75, w: 0.24, h: 0.24 }, order: 0 });
        let t = w.spawn();
        w.set_component(t, TextOverlay::new("hp 100", Vec2 { x: 0.02, y: 0.05 }, [255, 255, 255, 255]));

        r.render(&mut gpu, &mut w, 1280, 720);

        let targets = gpu.pass_targets();
        // First pass is the shadow depth target.
        assert!(matches!(targets[0], PassTarget::RenderTarget(_)), "shadow pass first");
        // The two camera passes follow, ordered by camera.order: map(-1) then main(0).
        assert!(matches!(targets[1], PassTarget::RenderTarget(_)), "RTT minimap camera second");
        assert_eq!(targets[2], PassTarget::Screen, "main screen camera third");
        // Composite + text are screen passes at the end.
        assert!(targets[3..].iter().all(|t| *t == PassTarget::Screen));
        assert!(targets.len() >= 5, "shadow + 2 cameras + composite + text");

        // Draw-call sanity: shadow draws 2 casters; main viewport draws 2;
        // minimap viewport draws 1 (mask 0b01 excluded); composite 1; text 1.
        assert!(gpu.draw_calls() >= 2 + 2 + 1 + 1 + 1);
    }
}
