//! Criterion microbenches for the CPU paths that back the perf budget: ECS
//! iteration/spawn, matrix math, and render draw-list building (via `NullGpu`,
//! so no GL/window). Requires `--features std`. Never enabled for game builds.
//! Never initializes the platform layer.

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};

use successor_engine_core::ecs::WorldOps;
use successor_engine_core::math::{vec3, Mat4, Quat, Vec2, Vec3};
use successor_engine_core::{impl_component, world};
use successor_engine_render::components::*;
use successor_engine_render::gpu::NullGpu;
use successor_engine_render::renderer::{Renderer, RendererLimits};

#[derive(Clone, Copy)]
#[allow(dead_code)]
struct Pos(f32, f32, f32);
#[derive(Clone, Copy)]
#[allow(dead_code)]
struct Vel(f32, f32, f32);
impl_component!(Pos: dense);
impl_component!(Vel: dense);
world! { pub struct EcsWorld { pos: Pos, vel: Vel } }

fn bench_ecs(c: &mut Criterion) {
    let n = 4096u64;
    c.bench_function("ecs/spawn-set/4096", |b| {
        b.iter(|| {
            let mut w = EcsWorld::new();
            for i in 0..n {
                let e = w.spawn();
                w.set_component(e, Pos(i as f32, 0.0, 0.0));
            }
            core::hint::black_box(w.entity_count())
        })
    });

    let mut w = EcsWorld::new();
    for i in 0..n {
        let e = w.spawn();
        w.set_component(e, Pos(i as f32, 0.0, 0.0));
        if i % 2 == 0 {
            w.set_component(e, Vel(1.0, 0.0, 0.0));
        }
    }
    c.bench_function("ecs/query1/4096", |b| {
        b.iter(|| {
            let mut sum = 0.0f32;
            let mut q = w.query1::<Pos>();
            while let Some((_, p)) = q.next() {
                sum += p.0;
            }
            core::hint::black_box(sum)
        })
    });
    c.bench_function("ecs/query2/4096", |b| {
        b.iter(|| {
            let mut sum = 0.0f32;
            let mut q = w.query2::<Vel, Pos>();
            while let Some((_, v, p)) = q.next() {
                sum += v.0 + p.0;
            }
            core::hint::black_box(sum)
        })
    });
}

fn bench_math(c: &mut Criterion) {
    let a = Mat4::from_trs(vec3(1.0, 2.0, 3.0), Quat::from_yaw(0.5), Vec3::ONE);
    let b = Mat4::perspective(1.1, 1.7, 0.1, 100.0);
    c.bench_with_input(BenchmarkId::new("math/mat4-mul", 1024), &1024, |bn, &count| {
        bn.iter(|| {
            let mut m = a;
            for _ in 0..count {
                m = m.mul(b);
            }
            core::hint::black_box(m.m[0])
        })
    });
}

world! { pub struct RWorld {
    transform: Transform,
    mesh: MeshRenderer,
    camera: Camera,
    light: DirectionalLight,
    point_light: PointLight,
    composite: CompositeQuad,
    text: TextOverlay,
} }

fn bench_render(c: &mut Criterion) {
    let mut gpu = NullGpu::default();
    let mut r = Renderer::new(&mut gpu, RendererLimits::default());
    let (v, i) = successor_engine_render::primitives::cube();
    let mesh = r.upload_mesh(&mut gpu, &v, &i);
    let mat = r.add_material([0.7, 0.7, 0.7, 1.0]);

    let mut w = RWorld::new();
    let l = w.spawn();
    w.set_component(l, DirectionalLight { dir: vec3(-0.4, -1.0, -0.3), color: [1.0; 3], cast_shadows: true });
    let cam = w.spawn();
    w.set_component(cam, Camera {
        viewport_id: 0, order: 0,
        projection: Projection::Perspective { fovy: 1.1, near: 0.1, far: 300.0 },
        target: CamTarget::Screen(RectNorm::FULL),
        clear: Default::default(),
        eye: vec3(0.0, 40.0, 60.0), look_at: Vec3::ZERO, up: Vec3::Y,
    });
    let side = 64;
    for x in 0..side {
        for z in 0..side {
            let e = w.spawn();
            w.set_component(e, Transform { pos: vec3(x as f32, 0.0, z as f32), rot: Quat::IDENTITY, scale: Vec3::ONE });
            w.set_component(e, MeshRenderer { mesh, material: mat, viewport_mask: 0b1, ..Default::default() });
        }
    }
    let t = w.spawn();
    w.set_component(t, TextOverlay::new("frame p50", Vec2 { x: 0.02, y: 0.04 }, [255; 4]));

    c.bench_function("render/build-drawlist/4096", |b| {
        b.iter(|| {
            r.render(&mut gpu, &mut w, 1280, 720);
            core::hint::black_box(&r as *const _)
        })
    });
}

criterion_group!(benches, bench_ecs, bench_math, bench_render);
criterion_main!(benches);
