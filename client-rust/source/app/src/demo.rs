//! The `parity-basic` demo scene and the headless stats/alloc runner.
//!
//! The scene is the standard benchmark every budget number refers to: a
//! 64x64 grid of opaque cubes plus 128 dithered-transparent cubes, one
//! shadow-casting directional light, and three cameras — a main perspective
//! (screen), an orthographic minimap and a spinning portrait, both rendered to
//! 256x256 textures and composited into the corners — plus a HUD text line.
//!
//! `run` is backend-generic: the headless gates pass `NullGpu` (full CPU path,
//! no window), while the windowed path passes the platform `GlGpu`.

use successor_engine_core::ecs::WorldOps;
use successor_engine_core::math::{vec3, Quat, Vec2, Vec3};
use successor_engine_render::components::{
    CamTarget, Camera, CompositeQuad, DirectionalLight, MaterialId, MeshId, MeshRenderer,
    Projection, RectNorm, TextOverlay, Transform,
};
use successor_engine_render::gpu::{ClearSpec, Filter, Gpu, RenderTargetDesc, RenderTargetId};
use successor_engine_render::primitives;
use successor_engine_render::renderer::Renderer;

use crate::GameWorld;

pub const SCREEN_W: u32 = 1280;
pub const SCREEN_H: u32 = 720;
const OPAQUE_SIDE: i32 = 64; // 64*64 = 4096 opaque cubes
const TRANSPARENT_COUNT: i32 = 128;

pub struct Scene {
    pub world: GameWorld,
    pub renderer: Renderer,
    portrait_cam: successor_engine_core::ecs::Entity,
    /// Spinning portrait target, reused as the UI demo's live paperdoll.
    portrait_target: RenderTargetId,
    /// Composite quad that places the paperdoll inside a UI pane.
    paperdoll_quad: successor_engine_core::ecs::Entity,
    transparent: Vec<successor_engine_core::ecs::Entity>,
}

#[derive(Clone, Copy, Debug)]
pub struct Stats {
    pub frame_p50_ms: f64,
    pub frame_p99_ms: f64,
    pub peak_rss_bytes: u64,
    pub frame_allocs_steady: u64,
}

impl Stats {
    pub fn to_json(&self) -> String {
        format!(
            "{{\n  \"frame_p50_ms\": {:.4},\n  \"frame_p99_ms\": {:.4},\n  \"peak_rss_bytes\": {},\n  \"frame_allocs_steady\": {}\n}}\n",
            self.frame_p50_ms, self.frame_p99_ms, self.peak_rss_bytes, self.frame_allocs_steady
        )
    }
}

/// Build the standard performance/reference scene, including its corner
/// render-target composites and diagnostic text overlay.
pub fn build_scene<G: Gpu>(gpu: &mut G) -> Scene {
    build_scene_with_fixture_overlays(gpu, true)
}

/// Build the same world behind an interactive UI capture, without synthetic
/// portrait/minimap cards or diagnostic text colliding with product chrome.
pub fn build_ui_scene<G: Gpu>(gpu: &mut G) -> Scene {
    build_scene_with_fixture_overlays(gpu, false)
}

fn build_scene_with_fixture_overlays<G: Gpu>(gpu: &mut G, fixture_overlays: bool) -> Scene {
    let mut renderer = crate::configured_renderer(gpu).expect("renderer initialization failed");
    let mut world = GameWorld::new();
    renderer.gi_set_focus([31.5, 0.0, 31.5]);

    // Meshes + materials.
    let (cv, ci) = primitives::cube();
    let cube: MeshId = renderer.upload_mesh(gpu, &cv, &ci);
    let (pv, pi) = primitives::plane(160.0);
    let plane: MeshId = renderer.upload_mesh(gpu, &pv, &pi);
    let (kv, ki) = primitives::capsule(0.4, 1.8, 12, 6);
    let capsule: MeshId = renderer.upload_mesh(gpu, &kv, &ki);
    let ground: MaterialId =
        renderer.add_material_desc(successor_engine_render::renderer::MaterialDesc {
            base_color: [0.35, 0.30, 0.20, 1.0],
            blend: false,
            ..successor_engine_render::renderer::MaterialDesc::default()
        });
    let opaque: MaterialId =
        renderer.add_material_desc(successor_engine_render::renderer::MaterialDesc {
            base_color: [0.72, 0.58, 0.36, 1.0],
            blend: false,
            ..successor_engine_render::renderer::MaterialDesc::default()
        });
    let glass: MaterialId =
        renderer.add_material_desc(successor_engine_render::renderer::MaterialDesc {
            base_color: [0.30, 0.55, 0.85, 0.5],
            blend: ([0.30, 0.55, 0.85, 0.5])[3] < 1.0,
            ..successor_engine_render::renderer::MaterialDesc::default()
        }); // alpha<1 -> dithered
    let hero: MaterialId =
        renderer.add_material_desc(successor_engine_render::renderer::MaterialDesc {
            base_color: [0.85, 0.85, 0.90, 1.0],
            blend: false,
            ..successor_engine_render::renderer::MaterialDesc::default()
        });

    // Ground plane (visible in main + minimap).
    let g = world.spawn();
    world.set_component(
        g,
        Transform {
            pos: vec3(31.5, 0.0, 31.5),
            rot: Quat::IDENTITY,
            scale: Vec3::ONE,
        },
    );
    world.set_component(
        g,
        MeshRenderer {
            mesh: plane,
            material: ground,
            viewport_mask: 0b011,
            ..Default::default()
        },
    );

    // 64x64 opaque cubes (main + minimap).
    for x in 0..OPAQUE_SIDE {
        for z in 0..OPAQUE_SIDE {
            let e = world.spawn();
            world.set_component(
                e,
                Transform {
                    pos: vec3(x as f32, 0.5, z as f32),
                    rot: Quat::IDENTITY,
                    scale: vec3(0.9, 0.9, 0.9),
                },
            );
            world.set_component(
                e,
                MeshRenderer {
                    mesh: cube,
                    material: opaque,
                    viewport_mask: 0b011,
                    ..Default::default()
                },
            );
        }
    }

    // 128 dithered-transparent cubes floating above (main only), animated.
    let mut transparent = Vec::with_capacity(TRANSPARENT_COUNT as usize);
    for i in 0..TRANSPARENT_COUNT {
        let e = world.spawn();
        let fx = (i % 16) as f32 * 4.0;
        let fz = (i / 16) as f32 * 4.0;
        world.set_component(
            e,
            Transform {
                pos: vec3(fx, 3.0, fz),
                rot: Quat::IDENTITY,
                scale: Vec3::ONE,
            },
        );
        world.set_component(
            e,
            MeshRenderer {
                mesh: cube,
                material: glass,
                viewport_mask: 0b001,
                ..Default::default()
            },
        );
        transparent.push(e);
    }

    // Hero capsule visible in ALL viewports (main + minimap + portrait).
    let hero_e = world.spawn();
    world.set_component(
        hero_e,
        Transform {
            pos: vec3(31.5, 0.9, 31.5),
            rot: Quat::IDENTITY,
            scale: Vec3::ONE,
        },
    );
    world.set_component(
        hero_e,
        MeshRenderer {
            mesh: capsule,
            material: hero,
            viewport_mask: 0b111,
            ..Default::default()
        },
    );

    // Shadow-casting sun.
    let sun = world.spawn();
    world.set_component(
        sun,
        DirectionalLight {
            dir: vec3(-0.5, -1.0, -0.35),
            color: [1.0, 0.97, 0.9],
            cast_shadows: true,
        },
    );

    // Offscreen targets for minimap + portrait.
    let rt_minimap = make_rt(gpu);
    let rt_portrait = make_rt(gpu);

    // Cameras (render order: minimap -2, portrait -1, main 0).
    let main = world.spawn();
    world.set_component(
        main,
        Camera {
            viewport_id: 0,
            order: 0,
            projection: Projection::Perspective {
                fovy: 1.05,
                near: 0.1,
                far: 400.0,
            },
            target: CamTarget::Screen(RectNorm::FULL),
            clear: ClearSpec {
                color: Some([0.05, 0.06, 0.08, 1.0]),
                depth: Some(1.0),
            },
            eye: vec3(31.5, 40.0, 92.0),
            look_at: vec3(31.5, 0.0, 31.5),
            up: Vec3::Y,
        },
    );
    let minimap = world.spawn();
    world.set_component(
        minimap,
        Camera {
            viewport_id: 1,
            order: -2,
            projection: Projection::Ortho {
                half_height: 40.0,
                near: 0.1,
                far: 200.0,
            },
            target: CamTarget::Texture(rt_minimap),
            clear: ClearSpec {
                color: Some([0.02, 0.03, 0.04, 1.0]),
                depth: Some(1.0),
            },
            eye: vec3(31.5, 120.0, 31.5),
            look_at: vec3(31.5, 0.0, 31.5),
            up: vec3(0.0, 0.0, -1.0),
        },
    );
    let portrait = world.spawn();
    world.set_component(
        portrait,
        Camera {
            viewport_id: 2,
            order: -1,
            projection: Projection::Perspective {
                fovy: 0.8,
                near: 0.05,
                far: 20.0,
            },
            target: CamTarget::Texture(rt_portrait),
            clear: ClearSpec {
                color: Some([0.10, 0.10, 0.12, 1.0]),
                depth: Some(1.0),
            },
            eye: vec3(31.5, 1.4, 34.0),
            look_at: vec3(31.5, 0.9, 31.5),
            up: Vec3::Y,
        },
    );

    if fixture_overlays {
        // Composite the two RTs into corners for the renderer performance gate.
        let q1 = world.spawn();
        world.set_component(
            q1,
            CompositeQuad {
                source: rt_minimap,
                rect: RectNorm {
                    x: 0.75,
                    y: 0.74,
                    w: 0.24,
                    h: 0.24,
                },
                order: 0,
            },
        );
        let q2 = world.spawn();
        world.set_component(
            q2,
            CompositeQuad {
                source: rt_portrait,
                rect: RectNorm {
                    x: 0.01,
                    y: 0.01,
                    w: 0.20,
                    h: 0.20,
                },
                order: 1,
            },
        );

        let hud = world.spawn();
        world.set_component(
            hud,
            TextOverlay::new(
                "successor rust client",
                Vec2 { x: 0.02, y: 0.05 },
                [220, 230, 240, 255],
            ),
        );
    }

    let paperdoll_quad = world.spawn();

    Scene {
        world,
        renderer,
        portrait_cam: portrait,
        portrait_target: rt_portrait,
        paperdoll_quad,
        transparent,
    }
}

fn make_rt<G: Gpu>(gpu: &mut G) -> RenderTargetId {
    gpu.create_render_target(&RenderTargetDesc {
        width: 256,
        height: 256,
        color: true,
        depth: true,
        filter: Filter::Linear,
    })
}

impl Scene {
    /// Advance one frame of animation (spin transparents, orbit portrait cam).
    pub fn animate(&mut self, frame: u64) {
        let t = frame as f32 * 0.016;
        let yaw = Quat::from_yaw(t);
        for i in 0..self.transparent.len() {
            let e = self.transparent[i];
            if let Some(tr) = self.world.get_component::<Transform>(e) {
                tr.rot = yaw;
                tr.pos.y = 3.0 + (t + i as f32).sin() * 0.5;
            }
        }
        if let Some(cam) = self.world.get_component::<Camera>(self.portrait_cam) {
            let r = 3.0;
            cam.eye = vec3(31.5 + t.cos() * r, 1.4, 31.5 + t.sin() * r);
        }
    }

    /// Place the spinning portrait target inside a UI pane, in framebuffer
    /// pixels. `None` removes it. The UI demo uses this so an inventory or
    /// examine capture shows the same live rotating doll connected mode draws.
    pub fn set_paperdoll_viewport(&mut self, rect: Option<[f32; 4]>, screen_w: f32, screen_h: f32) {
        let Some([x, y, w, h]) = rect.filter(|r| r[2] > 1.0 && r[3] > 1.0) else {
            self.world
                .remove_component::<CompositeQuad>(self.paperdoll_quad);
            return;
        };
        self.world.set_component(
            self.paperdoll_quad,
            CompositeQuad {
                source: self.portrait_target,
                rect: RectNorm {
                    x: x / screen_w,
                    y: 1.0 - (y + h) / screen_h,
                    w: w / screen_w,
                    h: h / screen_h,
                },
                order: 0,
            },
        );
    }

    pub fn render<G: Gpu>(&mut self, gpu: &mut G) {
        self.renderer
            .render(gpu, &mut self.world, SCREEN_W, SCREEN_H)
            .expect("render failed");
    }
}

/// Run `frames` frames headlessly through `NullGpu`, returning stats measured
/// after the 120-frame warmup. Used by `make runtime-check` / `check-allocs`.
pub fn run_headless(frames: u64) -> Stats {
    use successor_engine_render::gpu::NullGpu;
    let mut gpu = NullGpu::default();
    let mut scene = build_scene(&mut gpu);

    let warmup: u64 = 120;
    let measured = frames.saturating_sub(warmup) as usize;
    let mut times: Vec<f64> = Vec::with_capacity(measured.max(1));
    let mut max_alloc: u64 = 0;

    for f in 0..frames {
        successor_engine_core::rt::alloc::reset_alloc_count();
        let t0 = std::time::Instant::now();
        scene.animate(f);
        scene.render(&mut gpu);
        let dt_ms = t0.elapsed().as_secs_f64() * 1000.0;
        let allocs = successor_engine_core::rt::alloc::alloc_count();
        if f >= warmup {
            times.push(dt_ms);
            if allocs > max_alloc {
                max_alloc = allocs;
            }
        }
    }

    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p = |q: f64| -> f64 {
        if times.is_empty() {
            0.0
        } else {
            let idx = ((times.len() as f64 - 1.0) * q).round() as usize;
            times[idx]
        }
    };
    Stats {
        frame_p50_ms: p(0.50),
        frame_p99_ms: p(0.99),
        peak_rss_bytes: crate::rss::peak_rss_bytes(),
        frame_allocs_steady: max_alloc,
    }
}
