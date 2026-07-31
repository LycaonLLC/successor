//! World prop placement — port of `client-3d/src/render/props.ts` core: resolve
//! each slice prop through `props-mapping.json` (assetKey then kind), load+bake
//! its GLB once (recentered on its footprint, uniform-scaled to the cell
//! footprint), and spawn one entity per instance. Unmapped/`placeholder` kinds
//! render a tinted box; `skip` kinds are ignored. Doors/cutaway/animated
//! screens are later refinements; this lands static placement.

use std::collections::HashMap;

use successor_engine_core::ecs::{Entity, WorldOps};
use successor_engine_core::glb::{self, GlbDocument};
use successor_engine_core::json::Json;
use successor_engine_core::math::{vec3, Mat4, Quat, Vec3};
use successor_engine_render::components::{MaterialId, MeshId, MeshRenderer, SkinRef, Transform};
use successor_engine_render::gi::GiOccluder;
use successor_engine_render::gpu::Gpu;
use successor_engine_render::model::upload_glb;
use successor_engine_render::renderer::Renderer;

use crate::GameWorld;

/// A distinct GLB uploaded once: its parts (mesh+material) and measured XZ
/// footprint (post-recenter), used to fit instances to their cell size.
#[derive(Clone, Copy)]
struct PropPart {
    mesh: MeshId,
    material: MaterialId,
    local: Mat4,
}

struct PropModel {
    parts: Vec<PropPart>,
    footprint_x: f32,
    footprint_z: f32,
    /// Post-recenter AABB height (min-Y..max-Y), for the GI occluder proxy.
    height_y: f32,
    /// Index-weighted mean base color, for the GI occluder proxy.
    mean_albedo: [f32; 3],
}

pub struct PropsLoader<'a> {
    assets_dir: &'a str,
    mapping: Json,
    asset_base: String,
    cache: HashMap<String, PropModel>,
}

impl<'a> PropsLoader<'a> {
    #[allow(clippy::result_unit_err)]
    pub fn new(assets_dir: &'a str, mapping_json: &str) -> Result<Self, ()> {
        let mapping = Json::parse(mapping_json).map_err(|_| ())?;
        let asset_base = mapping
            .get("assetBase")
            .and_then(Json::as_str)
            .unwrap_or("/assets/world-items/")
            .to_string();
        Ok(PropsLoader {
            assets_dir,
            mapping,
            asset_base,
            cache: HashMap::new(),
        })
    }

    fn entry(&self, key: &str) -> Option<&Json> {
        self.mapping.get("entries").and_then(|e| e.get(key))
    }

    /// Place every visible prop from a parsed slice into the world.
    pub fn load<G: Gpu>(
        &mut self,
        world: &mut GameWorld,
        renderer: &mut Renderer,
        gpu: &mut G,
        slice: &Json,
        mask: u32,
    ) -> usize {
        let Some(props) = slice.get("props").and_then(Json::as_array) else {
            return 0;
        };
        let mut placed = 0;
        let mut occ: Vec<GiOccluder> = Vec::new();
        for prop in props {
            if prop.get("visible").and_then(Json::as_bool) == Some(false) {
                continue;
            }
            let asset_key = prop.get("assetKey").and_then(Json::as_str);
            let kind = prop.get("kind").and_then(Json::as_str);
            // Resolve mapping: assetKey first, then kind.
            let entry = asset_key
                .and_then(|k| self.entry(k))
                .or_else(|| kind.and_then(|k| self.entry(k)))
                .cloned();

            let id = prop.get("id").and_then(Json::as_str).unwrap_or("");
            let (cx, cy) = prop
                .get("cell")
                .map(|c| {
                    (
                        c.get("x").and_then(Json::as_f32).unwrap_or(0.0),
                        c.get("y").and_then(Json::as_f32).unwrap_or(0.0),
                    )
                })
                .unwrap_or((0.0, 0.0));
            let (sw, sh) = prop
                .get("size")
                .map(|s| {
                    (
                        s.get("w").and_then(Json::as_f32).unwrap_or(1.0),
                        s.get("h").and_then(Json::as_f32).unwrap_or(1.0),
                    )
                })
                .unwrap_or((1.0, 1.0));
            let rotation = prop.get("rotation").and_then(Json::as_f32).unwrap_or(0.0);

            let Some(entry) = entry else { continue };
            if entry.get("skip").and_then(Json::as_bool) == Some(true) {
                continue;
            }
            let random_yaw = entry
                .get("randomYaw")
                .and_then(Json::as_bool)
                .unwrap_or(false);

            if let Some(glb_ref) = entry.get("glb").and_then(Json::as_str) {
                if self.ensure_model(renderer, gpu, glb_ref).is_none() {
                    continue;
                }
                let model = self.cache.get(glb_ref).unwrap();
                let (fx, fz, hy, alb) = (
                    model.footprint_x,
                    model.footprint_z,
                    model.height_y,
                    model.mean_albedo,
                );
                let (yaw, scale) = placement(
                    rotation,
                    random_yaw,
                    id,
                    sw,
                    sh,
                    model.footprint_x,
                    model.footprint_z,
                );
                let pos = vec3(cx + sw / 2.0, 0.0, cy + sh / 2.0);
                let parts = model.parts.clone();
                let placement = Mat4::from_trs(pos, Quat::from_yaw(yaw), vec3(scale, scale, scale));
                for part in parts {
                    let (part_pos, part_rot, part_scale) = placement.mul(part.local).to_trs();
                    let e = world.spawn();
                    world.set_component(
                        e,
                        Transform {
                            pos: part_pos,
                            rot: part_rot,
                            scale: part_scale,
                        },
                    );
                    world.set_component(
                        e,
                        MeshRenderer {
                            mesh: part.mesh,
                            material: part.material,
                            viewport_mask: mask,
                            skin: SkinRef::NONE,
                        },
                    );
                }
                occ.push(GiOccluder {
                    center: [pos.x, hy * scale * 0.5, pos.z],
                    half_extents: [fx * scale * 0.5, hy * scale * 0.5, fz * scale * 0.5],
                    yaw,
                    albedo: alb,
                });
                placed += 1;
            } else if let Some(ph) = entry.get("placeholder") {
                let height = ph.get("height").and_then(Json::as_f32).unwrap_or(0.8);
                let tint = ph
                    .get("tint")
                    .and_then(Json::as_str)
                    .map(parse_hex)
                    .unwrap_or([0.43, 0.4, 0.34, 1.0]);
                let (yaw, _) = placement(rotation, random_yaw, id, sw, sh, 1.0, 1.0);
                let mesh = placeholder_cube(renderer, gpu);
                let material =
                    renderer.add_material_desc(successor_engine_render::renderer::MaterialDesc {
                        base_color: tint,
                        blend: (tint)[3] < 1.0,
                        ..successor_engine_render::renderer::MaterialDesc::default()
                    });
                let e = world.spawn();
                world.set_component(
                    e,
                    Transform {
                        pos: vec3(cx + sw / 2.0, height / 2.0, cy + sh / 2.0),
                        rot: Quat::from_yaw(yaw),
                        scale: vec3(sw.max(0.5), height, sh.max(0.5)),
                    },
                );
                world.set_component(
                    e,
                    MeshRenderer {
                        mesh,
                        material,
                        viewport_mask: mask,
                        skin: SkinRef::NONE,
                    },
                );
                occ.push(GiOccluder {
                    center: [cx + sw / 2.0, height * 0.5, cy + sh / 2.0],
                    half_extents: [sw.max(0.5) * 0.5, height * 0.5, sh.max(0.5) * 0.5],
                    yaw,
                    albedo: [tint[0], tint[1], tint[2]],
                });
                placed += 1;
            }
        }
        renderer.gi_set_occluders(&occ);
        placed
    }

    fn ensure_model<G: Gpu>(
        &mut self,
        renderer: &mut Renderer,
        gpu: &mut G,
        glb_ref: &str,
    ) -> Option<()> {
        if self.cache.contains_key(glb_ref) {
            return Some(());
        }
        // Resolve public path -> local file.
        let public = if glb_ref.starts_with('/') {
            glb_ref.to_string()
        } else {
            format!("{}{}", self.asset_base, glb_ref)
        };
        let local = format!(
            "{}{}",
            self.assets_dir,
            public.strip_prefix("/assets").unwrap_or(&public)
        );
        let bytes = std::fs::read(&local).ok()?;
        let doc = glb::parse(&bytes).ok()?;
        let model = upload_model(renderer, gpu, &doc)?;
        self.cache.insert(glb_ref.to_string(), model);
        Some(())
    }
}

/// composePlacement: yaw + uniform fit scale.
fn placement(
    rotation: f32,
    random_yaw: bool,
    id: &str,
    sw: f32,
    sh: f32,
    fx: f32,
    fz: f32,
) -> (f32, f32) {
    let deg2rad = core::f32::consts::PI / 180.0;
    let swap = rotation == 90.0 || rotation == 270.0;
    let target_w = if swap { sh } else { sw };
    let target_d = if swap { sw } else { sh };
    let use_random = random_yaw && rotation == 0.0;
    let yaw = if rotation != 0.0 {
        -rotation * deg2rad
    } else if use_random {
        hash_yaw(id)
    } else {
        0.0
    };
    let fit_w = if use_random {
        target_w.min(target_d)
    } else {
        target_w
    };
    let fit_d = if use_random {
        target_w.min(target_d)
    } else {
        target_d
    };
    let scale = (fit_w / fx.max(1e-3)).min(fit_d / fz.max(1e-3));
    (yaw, scale)
}

/// FNV-1a over the id → yaw in [0, 2π).
fn hash_yaw(id: &str) -> f32 {
    let mut hash: u32 = 2166136261;
    for b in id.bytes() {
        hash ^= b as u32;
        hash = hash.wrapping_mul(16777619);
    }
    (hash % 3600) as f32 * (core::f32::consts::PI / 1800.0)
}

/// Bake all static primitives (node globals applied), recenter on the footprint
/// (XZ center → 0, min-Y → 0), and upload. Returns parts + XZ footprint.
fn upload_model<G: Gpu>(
    renderer: &mut Renderer,
    gpu: &mut G,
    doc: &GlbDocument,
) -> Option<PropModel> {
    let globals = node_globals(doc);
    // First pass: AABB over baked positions.
    let mut min = vec3(f32::MAX, f32::MAX, f32::MAX);
    let mut max = vec3(f32::MIN, f32::MIN, f32::MIN);
    for (ni, node) in doc.nodes.iter().enumerate() {
        let Some(mi) = node.mesh else { continue };
        let Some(mesh) = doc.meshes.get(mi) else {
            continue;
        };
        for prim in &mesh.primitives {
            for p in &prim.positions {
                let w = globals[ni].transform_point(vec3(p[0], p[1], p[2]));
                min = vec3(min.x.min(w.x), min.y.min(w.y), min.z.min(w.z));
                max = vec3(max.x.max(w.x), max.y.max(w.y), max.z.max(w.z));
            }
        }
    }
    if min.x > max.x {
        return None;
    }
    let cx = (min.x + max.x) * 0.5;
    let cz = (min.z + max.z) * 0.5;
    let offset = vec3(-cx, -min.y, -cz);

    let uploaded = upload_glb(renderer, gpu, doc).ok()?;

    // Accumulate a mean albedo (weighted by index count) for the GI occluder proxy.
    let mut albedo_sum = [0.0f32; 3];
    let mut albedo_weight = 0.0f32;

    let mut parts = Vec::new();
    let recenter = Mat4::from_translation(offset);
    for (node_index, node) in doc.nodes.iter().enumerate() {
        let Some(mesh_index) = node.mesh else {
            continue;
        };
        for primitive in uploaded
            .primitives
            .iter()
            .filter(|primitive| primitive.source_mesh == mesh_index)
        {
            let source = doc
                .meshes
                .get(mesh_index)
                .and_then(|mesh| mesh.primitives.get(primitive.source_primitive));
            let base = source
                .and_then(|primitive| primitive.material)
                .and_then(|material| doc.materials.get(material))
                .map(|material| material.base_color)
                .unwrap_or([0.7, 0.68, 0.64, 1.0]);
            let weight = source.map_or(0.0, |primitive| primitive.indices.len() as f32);
            albedo_sum[0] += base[0] * weight;
            albedo_sum[1] += base[1] * weight;
            albedo_sum[2] += base[2] * weight;
            albedo_weight += weight;
            parts.push(PropPart {
                mesh: primitive.mesh,
                material: primitive.material,
                local: recenter.mul(globals[node_index]),
            });
        }
    }
    let mean_albedo = if albedo_weight > 0.0 {
        [
            albedo_sum[0] / albedo_weight,
            albedo_sum[1] / albedo_weight,
            albedo_sum[2] / albedo_weight,
        ]
    } else {
        [0.7, 0.68, 0.64]
    };
    Some(PropModel {
        parts,
        footprint_x: (max.x - min.x).max(0.01),
        footprint_z: (max.z - min.z).max(0.01),
        height_y: (max.y - min.y).max(0.01),
        mean_albedo,
    })
}

fn node_globals(doc: &GlbDocument) -> Vec<Mat4> {
    let n = doc.nodes.len();
    let mut globals = vec![Mat4::IDENTITY; n];
    let mut done = vec![false; n];
    let mut roots = doc.scene_roots.clone();
    if roots.is_empty() {
        let mut has_parent = vec![false; n];
        for node in &doc.nodes {
            for &c in &node.children {
                if c < n {
                    has_parent[c] = true;
                }
            }
        }
        roots = (0..n).filter(|&i| !has_parent[i]).collect();
    }
    let mut stack: Vec<(usize, Mat4)> = roots.iter().map(|&r| (r, Mat4::IDENTITY)).collect();
    while let Some((idx, parent)) = stack.pop() {
        if idx >= n || done[idx] {
            continue;
        }
        done[idx] = true;
        let g = parent.mul(doc.nodes[idx].local_matrix());
        globals[idx] = g;
        for &c in &doc.nodes[idx].children {
            stack.push((c, g));
        }
    }
    globals
}

fn placeholder_cube<G: Gpu>(renderer: &mut Renderer, gpu: &mut G) -> MeshId {
    // Unit cube centered at origin, base at y=-0.5; scaled by the caller.
    let (v, i) = successor_engine_render::primitives::cube();
    renderer.upload_mesh(gpu, &v, &i)
}

fn parse_hex(s: &str) -> [f32; 4] {
    let h = s.trim_start_matches('#');
    if h.len() >= 6 {
        let r = u8::from_str_radix(&h[0..2], 16).unwrap_or(110) as f32 / 255.0;
        let g = u8::from_str_radix(&h[2..4], 16).unwrap_or(101) as f32 / 255.0;
        let b = u8::from_str_radix(&h[4..6], 16).unwrap_or(87) as f32 / 255.0;
        [r, g, b, 1.0]
    } else {
        [0.43, 0.4, 0.34, 1.0]
    }
}

// ---------------------------------------------------------------------------
// Combined world scene: terrain + props + orbiting camera (`--demo props`).
// ---------------------------------------------------------------------------

use super::chunks::TerrainStreamer;
use super::terrain::Biome;

pub struct WorldScene {
    pub world: GameWorld,
    pub renderer: Renderer,
    camera: Entity,
    center: Vec3,
    orbit: f32,
}

impl WorldScene {
    /// Build terrain + all slice props around the slice's prop centroid.
    #[allow(clippy::result_unit_err)]
    pub fn build<G: Gpu>(
        gpu: &mut G,
        assets_dir: &str,
        mapping_json: &str,
        slice_json: &str,
    ) -> Result<WorldScene, ()> {
        use successor_engine_render::components::{
            CamTarget, Camera, DirectionalLight, Projection, RectNorm,
        };
        use successor_engine_render::gpu::ClearSpec;

        let slice = Json::parse(slice_json).map_err(|_| ())?;
        let mut renderer =
            Renderer::new(gpu, crate::quality_limits()).expect("renderer initialization failed");
        renderer.set_ambient(0.5);
        renderer.set_fog([0.788, 0.678, 0.510], 140.0, 320.0);
        let mut world = GameWorld::new();

        // Centroid of props → focus point.
        let (mut sx, mut sz, mut n) = (0.0f32, 0.0f32, 0.0f32);
        if let Some(props) = slice.get("props").and_then(Json::as_array) {
            for p in props {
                if let Some(c) = p.get("cell") {
                    sx += c.get("x").and_then(Json::as_f32).unwrap_or(0.0);
                    sz += c.get("y").and_then(Json::as_f32).unwrap_or(0.0);
                    n += 1.0;
                }
            }
        }
        let center = if n > 0.0 {
            vec3(sx / n, 0.0, sz / n)
        } else {
            vec3(512.0, 0.0, 512.0)
        };
        renderer.gi_set_focus([center.x, center.y, center.z]);

        // Terrain ground under the props.
        let mut streamer = TerrainStreamer::new(0x0d3d_071e, Biome::Desert, 64.0, 3, 0b1);
        streamer.ensure_around(
            &mut world,
            &mut renderer,
            gpu,
            center.x as f64,
            center.z as f64,
        );

        // Props.
        let mut loader = PropsLoader::new(assets_dir, mapping_json)?;
        let placed = loader.load(&mut world, &mut renderer, gpu, &slice, 0b1);
        eprintln!("props: placed {placed} instances");

        let sun = world.spawn();
        world.set_component(
            sun,
            DirectionalLight {
                dir: vec3(-0.4, -1.0, -0.3).normalize(),
                color: [1.0, 0.98, 0.92],
                cast_shadows: true,
            },
        );

        let orbit = 60.0f32;
        let camera = world.spawn();
        world.set_component(
            camera,
            Camera {
                viewport_id: 0,
                order: 0,
                projection: Projection::Perspective {
                    fovy: 45.0_f32.to_radians(),
                    near: 0.5,
                    far: 2000.0,
                },
                target: CamTarget::Screen(RectNorm::FULL),
                clear: ClearSpec {
                    color: Some([0.788, 0.678, 0.510, 1.0]),
                    depth: Some(1.0),
                },
                eye: center.add(vec3(orbit, orbit * 0.8, orbit)),
                look_at: center,
                up: Vec3::Y,
            },
        );

        Ok(WorldScene {
            world,
            renderer,
            camera,
            center,
            orbit,
        })
    }

    pub fn animate(&mut self, frame: u64) {
        use successor_engine_render::components::Camera;
        let angle = frame as f32 * 0.01;
        let eye = self.center.add(vec3(
            angle.cos() * self.orbit,
            self.orbit * 0.8,
            angle.sin() * self.orbit,
        ));
        if let Some(cam) = self.world.get_component::<Camera>(self.camera) {
            cam.eye = eye;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_yaw_deterministic_and_in_range() {
        let a = hash_yaw("dustgate-cloning-facility");
        let b = hash_yaw("dustgate-cloning-facility");
        assert_eq!(a, b);
        assert!((0.0..core::f32::consts::PI * 2.0).contains(&a));
        assert!(hash_yaw("barrel_scav-1") != hash_yaw("barrel_scav-2"));
    }

    #[test]
    fn placement_fits_footprint() {
        // A 4×4-cell prop from an 8-unit GLB footprint → 0.5 uniform scale.
        let (yaw, scale) = placement(0.0, false, "x", 4.0, 4.0, 8.0, 8.0);
        assert_eq!(yaw, 0.0);
        assert!((scale - 0.5).abs() < 1e-4);
    }

    #[test]
    fn rotation_90_yaw() {
        let (yaw, _) = placement(90.0, false, "x", 2.0, 4.0, 2.0, 4.0);
        assert!((yaw - (-90.0f32).to_radians()).abs() < 1e-4);
    }

    #[test]
    fn parse_hex_basic() {
        assert_eq!(parse_hex("#ff0000"), [1.0, 0.0, 0.0, 1.0]);
    }
}
