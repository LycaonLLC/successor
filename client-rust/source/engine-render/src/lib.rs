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
pub mod model;
pub mod primitives;
pub mod renderer;
pub mod text;
pub mod ui;
pub mod weather;
pub mod window;

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::components::*;
    use super::gpu::{ClearSpec, Cull, Gpu, GpuCaps, GpuError, MockCall, MockGpu, PassTarget};
    use super::renderer::{
        MaterialDesc, RenderConfigError, Renderer, RendererInitError, RendererLimits,
    };
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
        let mut r = Renderer::new(&mut gpu, RendererLimits::default())
            .expect("renderer initialization failed");
        let (v, i) = super::primitives::cube();
        let mesh = r.upload_mesh(&mut gpu, &v, &i);
        let mat = r.add_material_desc(MaterialDesc {
            base_color: [0.8, 0.5, 0.2, 1.0],
            ..MaterialDesc::default()
        });
        (gpu, r, RWorld::new(), mesh, mat)
    }
    #[test]
    fn renderer_init_requires_four_mrt_attachments() {
        let mut gpu = MockGpu::default();
        gpu.caps = GpuCaps {
            max_color_attachments: 3,
            max_draw_buffers: 4,
            ..GpuCaps::default()
        };
        assert!(matches!(
            Renderer::new(&mut gpu, RendererLimits::default()),
            Err(RendererInitError::InsufficientMrt)
        ));
    }

    #[test]
    fn renderer_init_surfaces_backend_errors() {
        let mut gpu = MockGpu::default();
        gpu.error = Some(GpuError::ShaderCompile);
        assert!(matches!(
            Renderer::new(&mut gpu, RendererLimits::default()),
            Err(RendererInitError::Gpu(GpuError::ShaderCompile))
        ));
    }

    #[test]
    fn tuning_snapshot_resizes_shadow_target_and_rejects_nonfinite_values() {
        let (mut gpu, mut renderer, _, _, _) = setup();
        gpu.log.clear();
        let mut settings = renderer.settings();
        settings.shadows.map_size = 4096;
        settings.bloom_radius = 1.75;
        settings.palette.enabled = true;
        settings.palette.levels = 8;
        renderer
            .apply_settings(&mut gpu, settings)
            .expect("valid settings apply");
        assert_eq!(renderer.settings().shadows.map_size, 4096);
        assert_eq!(renderer.settings().palette.levels, 8);
        assert_eq!(
            gpu.log
                .iter()
                .filter(|call| matches!(call, MockCall::DeleteRenderTarget))
                .count(),
            1
        );

        let before = renderer.settings();
        let mut invalid = before;
        invalid.exposure = f32::NAN;
        assert_eq!(
            renderer.apply_settings(&mut gpu, invalid),
            Err(RenderConfigError::InvalidSettings)
        );
        assert_eq!(renderer.settings().exposure, before.exposure);
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

        r.render(&mut gpu, &mut w, 1280, 720)
            .expect("render failed");

        let targets = gpu.pass_targets();
        // Deferred sequence: shadow → RTT minimap → G-buffer → scene light →
        // opaque copy → transparency → bloom → tonemap LDR → FXAA → overlays.
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
        let first_screen = targets
            .iter()
            .position(|target| *target == PassTarget::Screen)
            .expect("FXAA screen pass");
        assert!(
            targets[..first_screen]
                .iter()
                .all(|target| matches!(target, PassTarget::RenderTarget(_))),
            "all deferred and post-process targets precede screen presentation"
        );
        assert!(
            targets[first_screen..]
                .iter()
                .all(|target| *target == PassTarget::Screen),
            "FXAA, composite, and text are screen passes"
        );
        assert_eq!(
            first_screen, 10,
            "FXAA follows tonemap and all linear passes"
        );
        assert_eq!(targets[3], targets[5], "transparency composites into scene");
        assert_ne!(targets[3], targets[4], "opaque copy must not alias scene");
        assert_eq!(
            targets[6], targets[8],
            "vertical bloom returns to extract target"
        );
        assert_ne!(targets[6], targets[7], "bloom blur ping-pongs");
        let begin_passes: Vec<_> = gpu
            .log
            .iter()
            .filter_map(|call| match call {
                MockCall::BeginPass { target, viewport } => Some((*target, *viewport)),
                _ => None,
            })
            .collect();
        assert_eq!(begin_passes[6].1.w, 640);
        assert_eq!(begin_passes[6].1.h, 360);
        assert_eq!(begin_passes[10].0, PassTarget::Screen);

        // G-buffer, scene, opaque copy, bloom pair, and LDR presentation target.
        let mrt = gpu
            .log
            .iter()
            .filter(|c| matches!(c, MockCall::CreateMrt))
            .count();
        assert_eq!(mrt, 6, "all deferred screen targets");

        // Draw-call sanity: shadow (2 casters) + gbuffer main (2) + minimap (1)
        // + light fullscreen (1) + tonemap (1) + composite (1) + text (1).
        assert!(gpu.draw_calls() > 2 + 2 + 1 + 1 + 1 + 1);
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

        r.render(&mut gpu, &mut w, 800, 600).expect("render failed");
        gpu.log.clear();
        // Same size → no target churn.
        r.render(&mut gpu, &mut w, 800, 600).expect("render failed");
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
        r.render(&mut gpu, &mut w, 1024, 768)
            .expect("render failed");
        assert_eq!(
            gpu.log
                .iter()
                .filter(|c| matches!(c, MockCall::DeleteRenderTarget))
                .count(),
            6
        );
        assert_eq!(
            gpu.log
                .iter()
                .filter(|c| matches!(c, MockCall::CreateMrt))
                .count(),
            6
        );
    }

    #[test]
    fn zero_sized_frame_is_a_no_op() {
        let (mut gpu, mut renderer, mut world, _, _) = deferred_scene();
        gpu.log.clear();
        renderer
            .render(&mut gpu, &mut world, 0, 720)
            .expect("zero-sized frame");
        assert!(gpu.log.is_empty());
    }

    #[test]
    fn failed_target_resize_is_reported_and_new_targets_are_discarded() {
        let (mut gpu, mut renderer, mut world, _, _) = deferred_scene();
        gpu.log.clear();
        gpu.error = Some(GpuError::IncompleteFramebuffer);
        assert_eq!(
            renderer.render(&mut gpu, &mut world, 1280, 720),
            Err(GpuError::IncompleteFramebuffer)
        );
        assert_eq!(
            gpu.log
                .iter()
                .filter(|call| matches!(call, MockCall::CreateMrt))
                .count(),
            6
        );
        assert_eq!(
            gpu.log
                .iter()
                .filter(|call| matches!(call, MockCall::DeleteRenderTarget))
                .count(),
            6
        );
        gpu.log.clear();
        renderer
            .render(&mut gpu, &mut world, 1280, 720)
            .expect("retry after target failure");
        assert_eq!(
            gpu.log
                .iter()
                .filter(|call| matches!(call, MockCall::CreateMrt))
                .count(),
            6
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
    fn mastered_shader_controls_are_emitted_as_runtime_uniforms() {
        let (mut gpu, mut renderer, mut world, _, _) = deferred_scene();
        let mut settings = renderer.settings();
        settings.emissive_scalar = 2.25;
        settings.ao_intensity = 1.75;
        settings.exposure = 1.4;
        settings.bloom_radius = 1.6;
        settings.aa.edge_threshold = 0.08;
        renderer
            .apply_settings(&mut gpu, settings)
            .expect("settings apply");
        gpu.log.clear();
        renderer
            .render(&mut gpu, &mut world, 640, 480)
            .expect("render");
        let has = |name: &'static str, expected: f32| {
            gpu.log.iter().any(|call| {
                matches!(
                    call,
                    MockCall::UniformFloat { name: actual, value }
                        if *actual == name && (*value - expected).abs() < 1.0e-6
                )
            })
        };
        assert!(has("u_emissiveScalar", 2.25));
        assert!(has("u_aoIntensity", 1.75));
        // Global mastering must not also be baked into material uniforms.
        assert!(has("u_emissiveStrength", 1.0));
        assert!(has("u_aoStrength", 1.0));
        assert!(has("u_masterExposure", 1.4));
        assert!(has("u_edgeThreshold", 0.08));
    }

    #[test]
    fn forward_materials_apply_master_ao_and_emissive_once() {
        let (mut gpu, mut renderer, mut world, _, material) = deferred_scene();
        renderer.update_material_desc(
            material,
            MaterialDesc {
                blend: true,
                emissive_factor: [1.0, 0.5, 0.25],
                emissive_strength: 2.0,
                ..MaterialDesc::default()
            },
        );
        let mut settings = renderer.settings();
        settings.emissive_scalar = 3.0;
        settings.ao_intensity = 1.75;
        renderer
            .apply_settings(&mut gpu, settings)
            .expect("settings apply");
        gpu.log.clear();
        renderer
            .render(&mut gpu, &mut world, 640, 480)
            .expect("render");
        let has = |name: &'static str, expected: f32| {
            gpu.log.iter().any(|call| {
                matches!(
                    call,
                    MockCall::UniformFloat { name: actual, value }
                        if *actual == name && (*value - expected).abs() < 1.0e-6
                )
            })
        };
        assert!(has("u_emissiveStrength", 6.0));
        assert!(has("u_aoIntensity", 1.75));
    }

    #[test]
    fn point_light_pass_only_when_lights_present() {
        // No point lights → no instanced draw.
        let (mut gpu, mut r, mut w, _, _) = deferred_scene();
        r.render(&mut gpu, &mut w, 640, 480).expect("render failed");
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
        r.render(&mut gpu, &mut w, 640, 480).expect("render failed");
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
    fn opaque_materials_write_depth_and_honor_cull_mode() {
        let (mut gpu, mut renderer, mut world, mesh, _) = deferred_scene();
        let double_sided = renderer.add_material_desc(MaterialDesc {
            double_sided: true,
            ..MaterialDesc::default()
        });
        let entity = world.spawn();
        world.set_component(entity, Transform::default());
        world.set_component(
            entity,
            MeshRenderer {
                mesh,
                material: double_sided,
                viewport_mask: 0b01,
                ..Default::default()
            },
        );

        renderer
            .render(&mut gpu, &mut world, 640, 480)
            .expect("opaque render");
        let opaque_states: Vec<_> = gpu
            .log
            .iter()
            .filter_map(|call| match call {
                MockCall::SetPipeline { state, .. }
                    if state.depth_test
                        && state.depth_write
                        && state.color_write
                        && !state.blend =>
                {
                    Some(*state)
                }
                _ => None,
            })
            .collect();
        assert!(
            opaque_states.iter().any(|state| state.cull == Cull::Back),
            "single-sided opaque material must back-face cull"
        );
        assert!(
            opaque_states.iter().any(|state| state.cull == Cull::None),
            "double-sided opaque material must disable culling"
        );
        assert!(
            opaque_states
                .iter()
                .all(|state| state.depth_test && state.depth_write && !state.blend),
            "opaque material pipelines must test/write depth without blending"
        );
    }

    #[test]
    fn transparent_meshes_draw_far_to_near_across_meshes() {
        let (mut gpu, mut renderer, mut world, near_mesh, _) = deferred_scene();
        let (vertices, indices) = super::primitives::cube();
        let far_mesh = renderer.upload_mesh(&mut gpu, &vertices, &indices[..3]);
        let transparent = renderer.add_material_desc(MaterialDesc {
            base_color: [0.5, 0.7, 1.0, 0.5],
            blend: true,
            ..MaterialDesc::default()
        });
        for (mesh, z) in [(far_mesh, -20.0), (near_mesh, 8.0)] {
            let entity = world.spawn();
            world.set_component(
                entity,
                Transform {
                    pos: vec3(0.0, 0.0, z),
                    ..Transform::default()
                },
            );
            world.set_component(
                entity,
                MeshRenderer {
                    mesh,
                    material: transparent,
                    viewport_mask: 0b01,
                    ..Default::default()
                },
            );
        }

        renderer
            .render(&mut gpu, &mut world, 640, 480)
            .expect("transparent render");
        let mesh_draw_counts: Vec<_> = gpu
            .log
            .iter()
            .filter_map(|call| match call {
                MockCall::Draw { count } if *count == 3 || *count == 36 => Some(*count),
                _ => None,
            })
            .collect();
        assert!(
            mesh_draw_counts.ends_with(&[3, 36]),
            "transparent draws must be globally sorted far-to-near: {mesh_draw_counts:?}"
        );
    }

    #[test]
    fn transparent_draw_receives_nearest_thirty_two_point_lights() {
        let (mut gpu, mut renderer, mut world, mesh, _) = deferred_scene();
        let transparent = renderer.add_material_desc(MaterialDesc {
            base_color: [1.0, 1.0, 1.0, 0.5],
            blend: true,
            ..MaterialDesc::default()
        });
        let entity = world.spawn();
        world.set_component(entity, Transform::default());
        world.set_component(
            entity,
            MeshRenderer {
                mesh,
                material: transparent,
                viewport_mask: 0b01,
                ..Default::default()
            },
        );
        for index in 0..33 {
            let light = world.spawn();
            world.set_component(
                light,
                Transform {
                    pos: vec3(index as f32, 0.0, 0.0),
                    ..Transform::default()
                },
            );
            world.set_component(
                light,
                PointLight {
                    color: [1.0, 0.5, 0.25],
                    intensity: 2.0,
                    radius: 10.0,
                },
            );
        }

        renderer
            .render(&mut gpu, &mut world, 640, 480)
            .expect("transparent point lights");
        let lights = gpu
            .log
            .iter()
            .filter_map(|call| match call {
                MockCall::ForwardLights(lights) => Some(lights),
                _ => None,
            })
            .next_back()
            .expect("forward light upload");
        assert_eq!(lights.len(), 32);
        assert_eq!(lights.first().expect("nearest").position, [0.0, 0.0, 0.0]);
        assert_eq!(
            lights.last().expect("furthest selected").position,
            [31.0, 0.0, 0.0]
        );
    }

    #[test]
    fn transmission_without_alpha_blend_uses_sampled_depth_pipeline() {
        let (mut gpu, mut renderer, mut world, mesh, _) = deferred_scene();
        let transmissive = renderer.add_material_desc(MaterialDesc {
            transmission: 0.9,
            ior: 1.45,
            ..MaterialDesc::default()
        });
        let entity = world.spawn();
        world.set_component(entity, Transform::default());
        world.set_component(
            entity,
            MeshRenderer {
                mesh,
                material: transmissive,
                viewport_mask: 0b01,
                ..Default::default()
            },
        );

        renderer
            .render(&mut gpu, &mut world, 640, 480)
            .expect("transmission render");
        assert!(
            gpu.log.iter().any(|call| matches!(
                call,
                MockCall::SetPipeline {
                    state,
                    ..
                } if !state.depth_test && !state.depth_write && state.blend
            )),
            "transmission must use sorted blending with sampled opaque depth"
        );
    }

    #[test]
    fn rgba8_bloom_preserves_scene_linear_threshold_and_applies_presentation_gain() {
        let (mut gpu, mut renderer, mut world, _, _) = deferred_scene();
        renderer.set_bloom(2.0, 0.5).expect("valid bloom");
        renderer
            .render(&mut gpu, &mut world, 640, 480)
            .expect("RGBA8 fallback render");
        assert!(gpu.log.iter().any(|call| matches!(
            call,
            MockCall::UniformFloat {
                name: "u_threshold",
                value
            } if (*value - 0.5).abs() < f32::EPSILON
        )));
        assert!(gpu.log.iter().any(|call| matches!(
            call,
            MockCall::UniformFloat {
                name: "u_invExposure",
                value
            } if (*value - 4.0).abs() < f32::EPSILON
        )));
        assert!(gpu.log.iter().any(|call| matches!(
            call,
            MockCall::UniformFloat {
                name: "u_bloomIntensity",
                value
            } if (*value - 1.0).abs() < f32::EPSILON
        )));
    }

    #[test]
    fn camera_motion_does_not_schedule_gi_work() {
        let (mut gpu, mut r, mut w, _, _) = deferred_scene();
        for _ in 0..64 {
            r.render(&mut gpu, &mut w, 640, 480).expect("render failed");
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
        r.render(&mut gpu, &mut w, 640, 480).expect("render failed");
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
        r.render(&mut gpu, &mut w, 640, 480).expect("render failed");
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
        r.render(&mut gpu, &mut w, 640, 480).expect("render failed");
        assert_eq!(shadow_pass_draws(&gpu), 1);
    }
}
