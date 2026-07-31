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
pub mod gi;
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
    use super::gpu::{ClearSpec, Gpu, MockCall, MockGpu, PassTarget};
    use super::renderer::{Renderer, RendererLimits};
    use successor_engine_core::ecs::WorldOps;
    use successor_engine_core::math::{vec3, Vec2, Vec3};
    use successor_engine_core::world;

    world! { pub struct RWorld {
        transform: Transform,
        mesh: MeshRenderer,
        camera: Camera,
        light: DirectionalLight,
        point_light: PointLight,
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
        w.set_component(
            l,
            DirectionalLight {
                dir: vec3(-0.4, -1.0, -0.3),
                color: [1.0; 3],
                cast_shadows: true,
            },
        );

        // Main screen camera (viewport 0) and minimap RTT camera (viewport 1).
        let rt = gpu.create_render_target(&super::gpu::RenderTargetDesc {
            width: 256,
            height: 256,
            color: true,
            depth: true,
            filter: super::gpu::Filter::Nearest,
        });
        let cam_main = w.spawn();
        w.set_component(
            cam_main,
            Camera {
                viewport_id: 0,
                order: 0,
                projection: Projection::Perspective {
                    fovy: 1.1,
                    near: 0.1,
                    far: 200.0,
                },
            target: CamTarget::Screen(RectNorm::FULL),
                clear: ClearSpec {
                    color: Some([0.0, 0.0, 0.0, 1.0]),
                    depth: Some(1.0),
                },
                eye: vec3(0.0, 5.0, 10.0),
                look_at: Vec3::ZERO,
                up: Vec3::Y,
            },
        );
        let cam_map = w.spawn();
        w.set_component(
            cam_map,
            Camera {
                viewport_id: 1,
                order: -1, // renders BEFORE main (lower order first)
                projection: Projection::Ortho {
                    half_height: 20.0,
                    near: 0.1,
                    far: 200.0,
                },
            target: CamTarget::Texture(rt),
                clear: ClearSpec {
                    color: Some([0.1, 0.1, 0.1, 1.0]),
                    depth: Some(1.0),
                },
                eye: vec3(0.0, 50.0, 0.0),
                look_at: Vec3::ZERO,
                up: vec3(0.0, 0.0, -1.0),
            },
        );

        // Two meshes: one visible in both viewports, one only in main.
        let e_both = w.spawn();
        w.set_component(e_both, Transform::default());
        w.set_component(
            e_both,
            MeshRenderer {
                mesh,
                material: mat,
                viewport_mask: 0b11,
                ..Default::default()
            },
        );
        let e_main = w.spawn();
        w.set_component(
            e_main,
            Transform {
                pos: vec3(3.0, 0.0, 0.0),
                ..Transform::default()
            },
        );
        w.set_component(
            e_main,
            MeshRenderer {
                mesh,
                material: mat,
                viewport_mask: 0b01,
                ..Default::default()
            },
        );

        // Composite the minimap RT + one HUD text line.
        let q = w.spawn();
        w.set_component(
            q,
            CompositeQuad {
                source: rt,
                rect: RectNorm {
                    x: 0.75,
                    y: 0.75,
                    w: 0.24,
                    h: 0.24,
                },
                order: 0,
            },
        );
        let t = w.spawn();
        w.set_component(
            t,
            TextOverlay::new("hp 100", Vec2 { x: 0.02, y: 0.05 }, [255, 255, 255, 255]),
        );

        r.render(&mut gpu, &mut w, 1280, 720);

        let targets = gpu.pass_targets();
        // Deferred sequence: shadow → RTT minimap (forward) → G-buffer → scene
        // light → tonemap(screen) → composite(screen) → text(screen).
        assert!(
            matches!(targets[0], PassTarget::RenderTarget(_)),
            "shadow pass first"
        );
        assert!(
            matches!(targets[1], PassTarget::RenderTarget(_)),
            "RTT minimap camera second"
        );
        assert!(
            matches!(targets[2], PassTarget::RenderTarget(_)),
            "G-buffer pass"
        );
        assert!(
            matches!(targets[3], PassTarget::RenderTarget(_)),
            "deferred light → scene RT"
        );
        assert_eq!(targets[4], PassTarget::Screen, "tonemap to screen");
        // Remaining passes (composite + text) are screen passes.
        assert!(targets[4..].iter().all(|t| *t == PassTarget::Screen));
        assert!(
            targets.len() >= 7,
            "shadow + RTT + gbuffer + light + tonemap + composite + text"
        );

        // Two G-buffer MRTs (gbuffer + scene) were created for the screen.
        let mrt = gpu
            .log
            .iter()
            .filter(|c| matches!(c, MockCall::CreateMrt))
            .count();
        assert_eq!(mrt, 2, "G-buffer + HDR scene targets");

        // Draw-call sanity: shadow (2 casters) + gbuffer main (2) + minimap (1)
        // + light fullscreen (1) + tonemap (1) + composite (1) + text (1).
        assert!(gpu.draw_calls() >= 2 + 2 + 1 + 1 + 1 + 1 + 1);
    }

    #[test]
    fn resize_recreates_deferred_targets() {
        let (mut gpu, mut r, mut w, mesh, mat) = setup();
        let l = w.spawn();
        w.set_component(
            l,
            DirectionalLight {
                dir: vec3(-0.4, -1.0, -0.3),
                color: [1.0; 3],
                cast_shadows: true,
            },
        );
        let cam = w.spawn();
        w.set_component(
            cam,
            Camera {
                viewport_id: 0,
                order: 0,
                projection: Projection::Perspective {
                    fovy: 1.1,
                    near: 0.1,
                    far: 200.0,
                },
            target: CamTarget::Screen(RectNorm::FULL),
                clear: ClearSpec {
                    color: Some([0.0, 0.0, 0.0, 1.0]),
                    depth: Some(1.0),
                },
                eye: vec3(0.0, 5.0, 10.0),
                look_at: Vec3::ZERO,
                up: Vec3::Y,
            },
        );
        let e = w.spawn();
        w.set_component(e, Transform::default());
        w.set_component(
            e,
            MeshRenderer {
                mesh,
                material: mat,
                viewport_mask: 0b01,
                ..Default::default()
            },
        );

        r.render(&mut gpu, &mut w, 800, 600);
        gpu.log.clear();
        // Same size → no target churn.
        r.render(&mut gpu, &mut w, 800, 600);
        assert_eq!(
            gpu.log
                .iter()
                .filter(|c| matches!(c, MockCall::DeleteRenderTarget))
                .count(),
            0
        );
        assert_eq!(
            gpu.log
                .iter()
                .filter(|c| matches!(c, MockCall::CreateMrt))
                .count(),
            0
        );
        gpu.log.clear();
        // Different size → old targets deleted, new ones created.
        r.render(&mut gpu, &mut w, 1024, 768);
        assert_eq!(
            gpu.log
                .iter()
                .filter(|c| matches!(c, MockCall::DeleteRenderTarget))
                .count(),
            2
        );
        assert_eq!(
            gpu.log
                .iter()
                .filter(|c| matches!(c, MockCall::CreateMrt))
                .count(),
            2
        );
    }

    fn deferred_scene() -> (MockGpu, Renderer, RWorld, MeshId, MaterialId) {
        let (mut gpu, r, mut w, mesh, mat) = setup();
        let l = w.spawn();
        w.set_component(
            l,
            DirectionalLight {
                dir: vec3(-0.4, -1.0, -0.3),
                color: [1.0; 3],
                cast_shadows: true,
            },
        );
        let cam = w.spawn();
        w.set_component(
            cam,
            Camera {
                viewport_id: 0,
                order: 0,
                projection: Projection::Perspective {
                    fovy: 1.1,
                    near: 0.1,
                    far: 200.0,
                },
            target: CamTarget::Screen(RectNorm::FULL),
                clear: ClearSpec {
                    color: Some([0.0, 0.0, 0.0, 1.0]),
                    depth: Some(1.0),
                },
                eye: vec3(0.0, 5.0, 10.0),
                look_at: Vec3::ZERO,
                up: Vec3::Y,
            },
        );
        let e = w.spawn();
        w.set_component(e, Transform::default());
        w.set_component(
            e,
            MeshRenderer {
                mesh,
                material: mat,
                viewport_mask: 0b01,
                ..Default::default()
            },
        );
        let _ = &mut gpu;
        (gpu, r, w, mesh, mat)
    }

    #[test]
    fn point_light_pass_only_when_lights_present() {
        // No point lights → no instanced draw.
        let (mut gpu, mut r, mut w, _, _) = deferred_scene();
        r.render(&mut gpu, &mut w, 640, 480);
        assert_eq!(
            gpu.log
                .iter()
                .filter(|c| matches!(c, MockCall::DrawInstanced { .. }))
                .count(),
            0,
            "no point-light volumes without lights"
        );

        // One point light → exactly one instanced draw of one instance.
        let (mut gpu, mut r, mut w, _, _) = deferred_scene();
        let pl = w.spawn();
        w.set_component(
            pl,
            Transform {
                pos: vec3(1.0, 1.0, 1.0),
                ..Transform::default()
            },
        );
        w.set_component(
            pl,
            PointLight {
                color: [1.0, 0.8, 0.5],
                intensity: 5.0,
                radius: 4.0,
            },
        );
        r.render(&mut gpu, &mut w, 640, 480);
        let inst: Vec<u32> = gpu
            .log
            .iter()
            .filter_map(|c| match c {
                MockCall::DrawInstanced { instances } => Some(*instances),
                _ => None,
            })
            .collect();
        assert_eq!(
            inst,
            vec![1],
            "one instanced point-light draw of 1 instance"
        );
    }

    #[test]
    fn camera_motion_does_not_schedule_gi_work() {
        let (mut gpu, mut r, mut w, _, _) = deferred_scene();
        for _ in 0..64 {
            r.render(&mut gpu, &mut w, 640, 480);
            if r.gi_is_idle() {
                break;
            }
        }
        assert!(r.gi_is_idle());
        let before = r.gi_work_counters();
        gpu.log.clear();
        {
            let mut cameras = w.query1::<Camera>();
            let (_, camera) = cameras.next().expect("screen camera");
            camera.eye = vec3(8.0, 7.0, 12.0);
            camera.look_at = vec3(-8.0, 0.0, 4.0);
        }
        r.render(&mut gpu, &mut w, 640, 480);
        assert_eq!(r.gi_work_counters(), before);
        assert!(!gpu.log.iter().any(|call| matches!(
            call,
            MockCall::UpdateTexture3dRegion { .. } | MockCall::GenMips3d
        )));
    }

    fn shadow_pass_draws(gpu: &MockGpu) -> usize {
        let start = gpu
            .log
            .iter()
            .position(|call| matches!(call, MockCall::BeginPass { .. }))
            .unwrap();
        let end = gpu.log[start..]
            .iter()
            .position(|call| matches!(call, MockCall::EndPass))
            .map(|offset| start + offset)
            .unwrap();
        gpu.log[start..end]
            .iter()
            .filter(|call| matches!(call, MockCall::Draw { .. }))
            .count()
    }

    #[test]
    fn skinned_mesh_draws_in_shadow_pass() {
        let (mut gpu, mut r, mut w, mesh, mat) = deferred_scene();
        let static_entity = w.spawn();
        w.set_component(static_entity, Transform::default());
        w.set_component(
            static_entity,
            MeshRenderer {
                mesh,
                material: mat,
                viewport_mask: 1,
                ..Default::default()
            },
        );
        let skinned_vertices = vec![0.0f32; 16 * 3];
        let skinned = r.upload_skinned_mesh(&mut gpu, &skinned_vertices, &[0, 1, 2]);
        r.begin_skin_frame();
        let offset = r.push_skin_palette(&[[
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ]]);
        let pawn = w.spawn();
        w.set_component(pawn, Transform::default());
        w.set_component(
            pawn,
            MeshRenderer {
                mesh: skinned,
                material: mat,
                viewport_mask: 1,
                skin: SkinRef { offset, count: 1 },
            },
        );
        gpu.log.clear();
        r.render(&mut gpu, &mut w, 640, 480);
        assert_eq!(shadow_pass_draws(&gpu), 3);
    }

    #[test]
    fn invalid_skin_ref_is_not_drawn() {
        let (mut gpu, mut r, mut w, _, mat) = deferred_scene();
        let skinned_vertices = vec![0.0f32; 16 * 3];
        let skinned = r.upload_skinned_mesh(&mut gpu, &skinned_vertices, &[0, 1, 2]);
        let pawn = w.spawn();
        w.set_component(pawn, Transform::default());
        w.set_component(
            pawn,
            MeshRenderer {
                mesh: skinned,
                material: mat,
                viewport_mask: 1,
                skin: SkinRef {
                    offset: 9,
                    count: 1,
                },
            },
        );
        gpu.log.clear();
        r.render(&mut gpu, &mut w, 640, 480);
        assert_eq!(shadow_pass_draws(&gpu), 1);
    }
}
