//! Cross-backend material, transparency, bloom, and edge conformance scene.

use successor_engine_core::ecs::WorldOps;
use successor_engine_core::glb;
use successor_engine_core::math::{vec3, Mat4, Quat, Vec3};
use successor_engine_render::components::{
    CamTarget, Camera, DirectionalLight, MeshRenderer, Projection, RectNorm, Transform,
};
use successor_engine_render::gpu::{
    ClearSpec, Filter, Gpu, MinFilter, TextureDesc, TextureFormat, Wrap,
};
use successor_engine_render::model::upload_glb;
use successor_engine_render::primitives;
use successor_engine_render::renderer::{MaterialDesc, Renderer};

use crate::GameWorld;

pub const WIDTH: u32 = 1280;
pub const HEIGHT: u32 = 720;
pub const ASSET_PATHS: [&str; 6] = [
    "../client-3d/public/assets/world-items/commerce_facility.glb",
    "../client-3d/public/assets/pawn-pack/weapons/custom/lightning_carbine.glb",
    "../client-3d/public/assets/creatures/mossmuff_adult.glb",
    "../client-3d/public/assets/wave-props/everyday-wave-20260719/prepared-foods/successor_food_beer_mug.glb",
    "../client-3d/public/assets/items/custom/accessories/field_cap.glb",
    "../client-3d/public/assets/world-items/megalith_brick_hex.glb",
];

#[derive(Clone, Copy, Debug)]
pub struct ProbeRect {
    pub name: &'static str,
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

pub const NORMAL_CONTROL: ProbeRect = ProbeRect {
    name: "normal-control",
    x: 16,
    y: 24,
    w: 112,
    h: 112,
};
pub const NORMAL_DETAIL: ProbeRect = ProbeRect {
    name: "normal-detail",
    x: 144,
    y: 24,
    w: 112,
    h: 112,
};
pub const BASE_PBR: ProbeRect = ProbeRect {
    name: "base-pbr",
    x: 336,
    y: 24,
    w: 112,
    h: 112,
};
pub const CLEARCOAT: ProbeRect = ProbeRect {
    name: "clearcoat",
    x: 464,
    y: 24,
    w: 112,
    h: 112,
};
pub const CHECKER: ProbeRect = ProbeRect {
    name: "checker",
    x: 656,
    y: 24,
    w: 112,
    h: 112,
};
pub const TRANSMISSION: ProbeRect = ProbeRect {
    name: "transmission",
    x: 784,
    y: 24,
    w: 112,
    h: 112,
};
pub const ALPHA_BACKGROUND: ProbeRect = ProbeRect {
    name: "alpha-background",
    x: 976,
    y: 24,
    w: 112,
    h: 112,
};
pub const ALPHA_OVERLAP: ProbeRect = ProbeRect {
    name: "alpha-overlap",
    x: 1104,
    y: 24,
    w: 112,
    h: 112,
};
pub const EMIT_LOW_HALO: ProbeRect = ProbeRect {
    name: "emit-1.5-halo",
    x: 16,
    y: 184,
    w: 112,
    h: 112,
};
pub const EMIT_HIGH_HALO: ProbeRect = ProbeRect {
    name: "emit-4.0-halo",
    x: 144,
    y: 184,
    w: 112,
    h: 112,
};
pub const AA_EDGE: ProbeRect = ProbeRect {
    name: "aa-edge",
    x: 336,
    y: 184,
    w: 240,
    h: 112,
};
pub const FLAT_CONTROL: ProbeRect = ProbeRect {
    name: "flat-control",
    x: 656,
    y: 184,
    w: 240,
    h: 112,
};

pub struct Scene {
    pub world: GameWorld,
    pub renderer: Renderer,
}

pub fn build<G: Gpu>(gpu: &mut G, assets: &[Vec<u8>; 6]) -> Result<Scene, String> {
    let mut renderer = Renderer::new(gpu, crate::quality_limits())
        .map_err(|error| format!("renderer initialization: {error:?}"))?;
    renderer.set_ambient(0.18);
    renderer.set_fog([0.01, 0.01, 0.015], 10_000.0, 20_000.0);
    renderer.set_grade([1.0; 3], 0.0, 1.0, 0.0);
    renderer
        .set_bloom(2.0, 0.8)
        .map_err(|error| format!("bloom settings: {error:?}"))?;
    let mut world = GameWorld::new();
    let (cube_vertices, cube_indices) = primitives::cube();
    let cube = renderer.upload_mesh(gpu, &cube_vertices, &cube_indices);

    let checker = upload_rgba(gpu, 8, 8, &checker_pixels());
    let inverse_checker = upload_rgba(gpu, 8, 8, &inverse_checker_pixels());
    let normal = upload_rgba(gpu, 8, 8, &normal_pixels());
    let white = MaterialDesc {
        base_color: [0.62, 0.57, 0.48, 1.0],
        metallic: 0.0,
        roughness: 0.8,
        specular: 0.0,
        ..MaterialDesc::default()
    };
    let materials = [
        renderer.add_material_desc(white),
        renderer.add_material_desc(MaterialDesc {
            normal_texture: Some(normal),
            normal_scale: 1.8,
            ..white
        }),
        renderer.add_material_desc(MaterialDesc {
            clearcoat: 1.0,
            clearcoat_roughness: 0.35,
            ..white
        }),
        renderer.add_material_desc(MaterialDesc {
            base_color_texture: Some(checker),
            metallic: 0.0,
            roughness: 0.7,
            ..MaterialDesc::default()
        }),
        renderer.add_material_desc(MaterialDesc {
            base_color: [0.75, 0.9, 1.0, 1.0],
            metallic: 0.0,
            roughness: 0.15,
            transmission: 1.0,
            ior: 1.45,
            blend: true,
            ..MaterialDesc::default()
        }),
        renderer.add_material_desc(MaterialDesc {
            base_color: [0.95, 0.2, 0.12, 0.55],
            metallic: 0.0,
            roughness: 0.6,
            blend: true,
            double_sided: true,
            ..MaterialDesc::default()
        }),
        renderer.add_material_desc(MaterialDesc {
            base_color_texture: Some(inverse_checker),
            metallic: 0.0,
            roughness: 0.8,
            ..MaterialDesc::default()
        }),
        renderer.add_material_desc(MaterialDesc {
            base_color: [0.03, 0.03, 0.03, 1.0],
            metallic: 0.0,
            roughness: 1.0,
            emissive_factor: [1.0, 0.35, 0.05],
            emissive_strength: 1.5,
            ..MaterialDesc::default()
        }),
        renderer.add_material_desc(MaterialDesc {
            base_color: [0.03, 0.03, 0.03, 1.0],
            metallic: 0.0,
            roughness: 1.0,
            emissive_factor: [1.0, 0.35, 0.05],
            emissive_strength: 4.0,
            ..MaterialDesc::default()
        }),
        renderer.add_material_desc(MaterialDesc {
            base_color: [0.95, 0.95, 0.95, 1.0],
            metallic: 0.0,
            roughness: 0.9,
            double_sided: true,
            ..MaterialDesc::default()
        }),
    ];

    let xs = [-6.91, -5.35, -3.02, -1.46, 0.88, 2.44, 4.77, 6.33];
    spawn_panel(
        &mut world,
        cube,
        materials[0],
        vec3(xs[0], 3.41, 0.0),
        vec3(1.36, 1.36, 0.12),
        Quat::IDENTITY,
    );
    spawn_panel(
        &mut world,
        cube,
        materials[1],
        vec3(xs[1], 3.41, 0.0),
        vec3(1.36, 1.36, 0.12),
        Quat::IDENTITY,
    );
    let highlight_rotation = Quat::from_axis_angle(vec3(1.0, 0.0, 0.0), -0.42)
        .mul(Quat::from_axis_angle(vec3(0.0, 1.0, 0.0), -0.24));
    spawn_panel(
        &mut world,
        cube,
        materials[0],
        vec3(xs[2], 3.41, 0.0),
        vec3(1.36, 1.36, 0.12),
        highlight_rotation,
    );
    spawn_panel(
        &mut world,
        cube,
        materials[2],
        vec3(xs[3], 3.41, 0.0),
        vec3(1.36, 1.36, 0.12),
        highlight_rotation,
    );
    spawn_panel(
        &mut world,
        cube,
        materials[3],
        vec3(xs[4], 3.41, -0.25),
        vec3(1.36, 1.36, 0.08),
        Quat::IDENTITY,
    );
    spawn_panel(
        &mut world,
        cube,
        materials[3],
        vec3(xs[5], 3.41, -0.25),
        vec3(1.36, 1.36, 0.08),
        Quat::IDENTITY,
    );
    spawn_panel(
        &mut world,
        cube,
        materials[4],
        vec3(xs[5], 3.41, 0.15),
        vec3(1.30, 1.30, 0.08),
        Quat::IDENTITY,
    );
    spawn_panel(
        &mut world,
        cube,
        materials[6],
        vec3(xs[6], 3.41, -0.2),
        vec3(1.36, 1.36, 0.08),
        Quat::IDENTITY,
    );
    spawn_panel(
        &mut world,
        cube,
        materials[5],
        vec3(xs[7], 3.41, 0.15),
        vec3(1.36, 1.36, 0.08),
        Quat::IDENTITY,
    );

    spawn_panel(
        &mut world,
        cube,
        materials[7],
        vec3(-6.91, 1.46, 0.0),
        vec3(0.45, 0.45, 0.12),
        Quat::IDENTITY,
    );
    spawn_panel(
        &mut world,
        cube,
        materials[8],
        vec3(-5.35, 1.46, 0.0),
        vec3(0.45, 0.45, 0.12),
        Quat::IDENTITY,
    );
    let diagonal = Quat::from_axis_angle(vec3(0.0, 0.0, 1.0), -0.45);
    spawn_panel(
        &mut world,
        cube,
        materials[9],
        vec3(-2.24, 1.46, 0.0),
        vec3(2.4, 0.035, 0.08),
        diagonal,
    );
    spawn_panel(
        &mut world,
        cube,
        materials[9],
        vec3(1.66, 1.46, 0.0),
        vec3(2.4, 1.30, 0.08),
        Quat::IDENTITY,
    );

    for (index, bytes) in assets.iter().enumerate() {
        add_asset(&mut renderer, gpu, &mut world, bytes, index)?;
    }

    let sun = world.spawn();
    world.set_component(
        sun,
        DirectionalLight {
            dir: vec3(0.4, -0.7, -0.6).normalize(),
            color: [1.0, 0.98, 0.94],
            cast_shadows: true,
        },
    );
    let camera = world.spawn();
    world.set_component(
        camera,
        Camera {
            viewport_id: 0,
            order: 0,
            projection: Projection::Perspective {
                fovy: 0.7,
                near: 0.1,
                far: 100.0,
            },
            target: CamTarget::Screen(RectNorm::FULL),
            clear: ClearSpec {
                color: Some([0.01, 0.01, 0.015, 1.0]),
                depth: Some(1.0),
            },
            eye: vec3(0.0, 0.0, 12.0),
            look_at: Vec3::ZERO,
            up: Vec3::Y,
        },
    );
    Ok(Scene { world, renderer })
}

fn spawn_panel(
    world: &mut GameWorld,
    mesh: successor_engine_render::components::MeshId,
    material: successor_engine_render::components::MaterialId,
    pos: Vec3,
    scale: Vec3,
    rot: Quat,
) {
    let entity = world.spawn();
    world.set_component(entity, Transform { pos, rot, scale });
    world.set_component(
        entity,
        MeshRenderer {
            mesh,
            material,
            viewport_mask: 1,
            ..Default::default()
        },
    );
}

fn upload_rgba<G: Gpu>(
    gpu: &mut G,
    width: u32,
    height: u32,
    pixels: &[u8],
) -> successor_engine_render::gpu::TextureId {
    gpu.create_texture(
        &TextureDesc {
            width,
            height,
            format: TextureFormat::Srgba8,
            mag_filter: Filter::Linear,
            min_filter: MinFilter::Linear,
            wrap_s: Wrap::Repeat,
            wrap_t: Wrap::Repeat,
            mipmaps: false,
        },
        Some(pixels),
    )
}

fn checker_pixels() -> Vec<u8> {
    let mut pixels = vec![0; 8 * 8 * 4];
    for y in 0..8 {
        for x in 0..8 {
            let value = if (x + y) % 2 == 0 { 235 } else { 25 };
            let offset = (y * 8 + x) * 4;
            pixels[offset..offset + 4].copy_from_slice(&[value, value, value, 255]);
        }
    }
    pixels
}

fn inverse_checker_pixels() -> Vec<u8> {
    let mut pixels = checker_pixels();
    for pixel in pixels.chunks_exact_mut(4) {
        pixel[0] = 255 - pixel[0];
        pixel[1] = 255 - pixel[1];
        pixel[2] = 255 - pixel[2];
    }
    pixels
}

fn normal_pixels() -> Vec<u8> {
    let mut pixels = vec![0; 8 * 8 * 4];
    for y in 0..8 {
        for x in 0..8 {
            let sx = if x % 2 == 0 { 70 } else { 186 };
            let sy = if y % 2 == 0 { 70 } else { 186 };
            let offset = (y * 8 + x) * 4;
            pixels[offset..offset + 4].copy_from_slice(&[sx, sy, 230, 255]);
        }
    }
    pixels
}

fn add_asset<G: Gpu>(
    renderer: &mut Renderer,
    gpu: &mut G,
    world: &mut GameWorld,
    bytes: &[u8],
    cell: usize,
) -> Result<(), String> {
    let doc = glb::parse(bytes).map_err(|error| format!("asset {cell} parse: {error:?}"))?;
    let uploaded = upload_glb(renderer, gpu, &doc)
        .map_err(|error| format!("asset {cell} upload: {error:?}"))?;
    let globals = node_globals(&doc);
    let mut min = vec3(f32::MAX, f32::MAX, f32::MAX);
    let mut max = vec3(f32::MIN, f32::MIN, f32::MIN);
    for (node_index, node) in doc.nodes.iter().enumerate() {
        let Some(mesh_index) = node.mesh else {
            continue;
        };
        let Some(mesh) = doc.meshes.get(mesh_index) else {
            continue;
        };
        for primitive in &mesh.primitives {
            for position in &primitive.positions {
                let point = globals[node_index].transform_point(vec3(
                    position[0],
                    position[1],
                    position[2],
                ));
                min = vec3(min.x.min(point.x), min.y.min(point.y), min.z.min(point.z));
                max = vec3(max.x.max(point.x), max.y.max(point.y), max.z.max(point.z));
            }
        }
    }

    if min.x > max.x {
        return Err(format!("asset {cell} has no geometry"));
    }
    let center = min.add(max).scale(0.5);
    let extent = max.sub(min);
    let cell_width = 2.34;
    let cell_height = 2.55;
    let scale = (cell_width / extent.x.max(0.001))
        .min(cell_height / extent.y.max(0.001))
        .min(cell_height / extent.z.max(0.001))
        * 0.9;
    let x = -6.49 + cell as f32 * 2.596;
    let outer = Mat4::from_trs(
        vec3(x, -2.92, 0.0).sub(center.scale(scale)),
        Quat::IDENTITY,
        vec3(scale, scale, scale),
    );
    for (node_index, node) in doc.nodes.iter().enumerate() {
        let Some(mesh_index) = node.mesh else {
            continue;
        };
        let Some(mesh) = doc.meshes.get(mesh_index) else {
            continue;
        };
        for primitive_index in 0..mesh.primitives.len() {
            let item = uploaded
                .primitives
                .iter()
                .find(|item| {
                    item.source_mesh == mesh_index && item.source_primitive == primitive_index
                })
                .ok_or_else(|| format!("asset {cell} primitive missing"))?;
            let (pos, rot, scale) = outer.mul(globals[node_index]).to_trs();
            spawn_panel(world, item.mesh, item.material, pos, scale, rot);
        }
    }
    Ok(())
}

fn node_globals(doc: &glb::GlbDocument) -> Vec<Mat4> {
    let mut globals = vec![Mat4::IDENTITY; doc.nodes.len()];
    for root in &doc.scene_roots {
        fill_globals(doc, *root, Mat4::IDENTITY, &mut globals);
    }
    globals
}

fn fill_globals(doc: &glb::GlbDocument, node_index: usize, parent: Mat4, globals: &mut [Mat4]) {
    let Some(node) = doc.nodes.get(node_index) else {
        return;
    };
    let global = parent.mul(Mat4::from_trs(node.translation, node.rotation, node.scale));
    globals[node_index] = global;
    for child in &node.children {
        fill_globals(doc, *child, global, globals);
    }
}

#[derive(Debug)]
pub struct ProbeReport {
    pub normal_difference: f32,
    pub clearcoat_peak_delta: f32,
    pub transmission_correlation: f32,
    pub opaque_correlation: f32,
    pub alpha_margin: f32,
    pub bloom_halo_delta: f32,
    pub aa_intermediate: usize,
    pub flat_difference: f32,
}

pub fn probe_rgba_top_left(
    rgba_bottom_left: &[u8],
    width: u32,
    height: u32,
) -> Result<ProbeReport, String> {
    if width != WIDTH || height != HEIGHT || rgba_bottom_left.len() != (width * height * 4) as usize
    {
        return Err(format!("probe requires {WIDTH}x{HEIGHT} RGBA readback"));
    }
    let mut rgba = vec![0; rgba_bottom_left.len()];
    let row = (width * 4) as usize;
    for y in 0..height as usize {
        rgba[y * row..(y + 1) * row].copy_from_slice(
            &rgba_bottom_left[(height as usize - 1 - y) * row..(height as usize - y) * row],
        );
    }
    let normal_difference = mean_abs_luma_difference(&rgba, width, NORMAL_CONTROL, NORMAL_DETAIL);
    let clearcoat_peak_delta =
        peak_luma(&rgba, width, CLEARCOAT) - peak_luma(&rgba, width, BASE_PBR);
    let transmission_correlation = correlation(&rgba, width, CHECKER, TRANSMISSION);
    let opaque_correlation = correlation(&rgba, width, CHECKER, ALPHA_BACKGROUND);
    let alpha_mean = mean_luma(&rgba, width, ALPHA_OVERLAP);
    let alpha_margin = (alpha_mean - mean_luma(&rgba, width, ALPHA_BACKGROUND)).abs();
    let bloom_halo_delta =
        mean_luma(&rgba, width, EMIT_HIGH_HALO) - mean_luma(&rgba, width, EMIT_LOW_HALO);
    let aa_intermediate = diagonal_intermediate_count(&rgba, width, AA_EDGE);
    let flat_difference = flat_neighbor_difference(&rgba, width, FLAT_CONTROL);
    let report = ProbeReport {
        normal_difference,
        clearcoat_peak_delta,
        transmission_correlation,
        opaque_correlation,
        alpha_margin,
        bloom_halo_delta,
        aa_intermediate,
        flat_difference,
    };
    println!("material-parity normal_difference={normal_difference:.5} rects={NORMAL_CONTROL:?}/{NORMAL_DETAIL:?}");
    println!("material-parity clearcoat_peak_delta={clearcoat_peak_delta:.5} rects={BASE_PBR:?}/{CLEARCOAT:?}");
    println!("material-parity transmission_correlation={transmission_correlation:.5} opaque_correlation={opaque_correlation:.5} rects={CHECKER:?}/{TRANSMISSION:?}/{ALPHA_BACKGROUND:?}");
    println!("material-parity alpha_margin={alpha_margin:.5} rect={ALPHA_OVERLAP:?}");
    println!("material-parity bloom_halo_delta={bloom_halo_delta:.5} rects={EMIT_LOW_HALO:?}/{EMIT_HIGH_HALO:?}");
    println!("material-parity aa_intermediate={aa_intermediate} flat_difference={flat_difference:.5} rects={AA_EDGE:?}/{FLAT_CONTROL:?}");
    if normal_difference < 0.03
        || clearcoat_peak_delta < 0.05
        || transmission_correlation < 0.50
        || opaque_correlation > 0.10
        || alpha_margin < 0.02
        || bloom_halo_delta < 0.02
        || aa_intermediate < 26
        || flat_difference > 0.01
    {
        return Err(format!("material parity inequalities failed: {report:?}"));
    }
    Ok(report)
}

fn samples(rgba: &[u8], width: u32, rect: ProbeRect) -> impl Iterator<Item = f32> + '_ {
    (rect.y..rect.y + rect.h).flat_map(move |y| {
        (rect.x..rect.x + rect.w).map(move |x| {
            let offset = ((y * width + x) * 4) as usize;
            (0.2126 * rgba[offset] as f32
                + 0.7152 * rgba[offset + 1] as f32
                + 0.0722 * rgba[offset + 2] as f32)
                / 255.0
        })
    })
}
fn mean_luma(rgba: &[u8], width: u32, rect: ProbeRect) -> f32 {
    samples(rgba, width, rect).sum::<f32>() / (rect.w * rect.h) as f32
}
fn peak_luma(rgba: &[u8], width: u32, rect: ProbeRect) -> f32 {
    samples(rgba, width, rect).fold(0.0, f32::max)
}
fn mean_abs_luma_difference(rgba: &[u8], width: u32, a: ProbeRect, b: ProbeRect) -> f32 {
    samples(rgba, width, a)
        .zip(samples(rgba, width, b))
        .map(|(x, y)| (x - y).abs())
        .sum::<f32>()
        / (a.w * a.h) as f32
}
fn correlation(rgba: &[u8], width: u32, a: ProbeRect, b: ProbeRect) -> f32 {
    let ma = mean_luma(rgba, width, a);
    let mb = mean_luma(rgba, width, b);
    let (mut num, mut da, mut db) = (0.0, 0.0, 0.0);
    for (x, y) in samples(rgba, width, a).zip(samples(rgba, width, b)) {
        let ax = x - ma;
        let by = y - mb;
        num += ax * by;
        da += ax * ax;
        db += by * by;
    }
    num / (da * db).sqrt().max(1e-6)
}
fn diagonal_intermediate_count(rgba: &[u8], width: u32, rect: ProbeRect) -> usize {
    (0..128)
        .filter(|index| {
            let x = rect.x + (*index as u32 * rect.w / 128).min(rect.w - 1);
            let y = rect.y + (*index as u32 * rect.h / 128).min(rect.h - 1);
            let value = samples(
                rgba,
                width,
                ProbeRect {
                    name: "edge-sample",
                    x,
                    y,
                    w: 1,
                    h: 1,
                },
            )
            .next()
            .unwrap_or(0.0);
            value > 0.10 && value < 0.90
        })
        .count()
}
fn flat_neighbor_difference(rgba: &[u8], width: u32, rect: ProbeRect) -> f32 {
    let shifted = ProbeRect {
        x: rect.x + 1,
        w: rect.w - 1,
        ..rect
    };
    let base = ProbeRect {
        w: rect.w - 1,
        ..rect
    };
    mean_abs_luma_difference(rgba, width, base, shifted)
}
