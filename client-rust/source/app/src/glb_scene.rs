//! `--demo glb-view`: load a repo `.glb` and orbit it, exercising the whole
//! asset path — GLB parse, mesh/material upload, static baking, and (for rigged
//! bodies) skeletal animation via the skinning pipeline. Native visual QA for
//! Wave 1; the pawn/prop game wiring builds on this in later waves.

use successor_engine_core::anim::{apply_animation, JointTransform, Skeleton};
use successor_engine_core::ecs::{Entity, WorldOps};
use successor_engine_core::glb::{self, GlbAnimation, GlbDocument};
use successor_engine_core::math::{vec3, Mat4, Vec3};
use successor_engine_render::components::{
    CamTarget, Camera, DirectionalLight, MeshRenderer, Projection, SkinRef, Transform,
};
use successor_engine_render::gpu::Gpu;
use successor_engine_render::renderer::{Renderer, RendererLimits};

use crate::GameWorld;

pub struct GlbScene {
    pub world: GameWorld,
    pub renderer: Renderer,
    skeleton: Option<Skeleton>,
    anim: Option<GlbAnimation>,
    pose: Vec<JointTransform>,
    palette: Vec<[f32; 16]>,
    skinned_entities: Vec<Entity>,
    camera: Entity,
    center: Vec3,
    orbit_radius: f32,
}

impl GlbScene {
    /// Parse `bytes` and build a scene. `clip` names the animation to play
    /// (falls back to the first animation, or none for static meshes).
    pub fn build<G: Gpu>(gpu: &mut G, bytes: &[u8], clip: Option<&str>) -> Result<GlbScene, glb::GlbError> {
        let doc = glb::parse(bytes)?;
        let mut renderer = Renderer::new(gpu, RendererLimits::default());
        renderer.set_ambient(0.35);
        let mut world = GameWorld::new();

        let globals = node_globals(&doc);
        let skinned = !doc.skins.is_empty();
        let skeleton = if skinned {
            Skeleton::from_document(&doc, 0)
        } else {
            None
        };

        // Material palette → renderer materials (index-aligned with doc order).
        let mut material_ids = Vec::with_capacity(doc.materials.len().max(1));
        for m in &doc.materials {
            // Viewer aid: matcap-shaded assets (e.g. pawns) carry a near-black
            // baseColorFactor. Substitute a neutral tone so the geometry reads
            // in this QA tool. The real matcap shading lands in a later wave.
            let c = m.base_color;
            let color = if c[0].max(c[1]).max(c[2]) < 0.15 {
                [0.72, 0.70, 0.67, c[3]]
            } else {
                c
            };
            material_ids.push(renderer.add_material(color));
        }
        let default_mat = renderer.add_material([0.75, 0.75, 0.78, 1.0]);

        let mut aabb_min = vec3(f32::MAX, f32::MAX, f32::MAX);
        let mut aabb_max = vec3(f32::MIN, f32::MIN, f32::MIN);
        let mut skinned_entities = Vec::new();

        for (node_idx, node) in doc.nodes.iter().enumerate() {
            let Some(mesh_idx) = node.mesh else { continue };
            let Some(mesh) = doc.meshes.get(mesh_idx) else { continue };
            let g = globals[node_idx];
            for prim in &mesh.primitives {
                if prim.positions.is_empty() {
                    continue;
                }
                let is_skinned = skinned && !prim.joints.is_empty() && !prim.weights.is_empty();
                let (verts, layout_skinned) = if is_skinned {
                    (build_skinned_vertices(prim), true)
                } else {
                    (build_static_vertices(prim, &g), false)
                };
                // AABB over final (baked) positions for framing.
                let stride = if layout_skinned { 16 } else { 8 };
                let mut i = 0;
                while i < verts.len() {
                    let p = vec3(verts[i], verts[i + 1], verts[i + 2]);
                    aabb_min = min3(aabb_min, p);
                    aabb_max = max3(aabb_max, p);
                    i += stride;
                }
                let mesh_id = if layout_skinned {
                    renderer.upload_skinned_mesh(gpu, &verts, &prim.indices)
                } else {
                    renderer.upload_mesh(gpu, &verts, &prim.indices)
                };
                let material = prim
                    .material
                    .and_then(|mi| material_ids.get(mi).copied())
                    .unwrap_or(default_mat);
                let e = world.spawn();
                world.set_component(e, Transform::default());
                world.set_component(
                    e,
                    MeshRenderer {
                        mesh: mesh_id,
                        material,
                        viewport_mask: 0b1,
                        skin: SkinRef::NONE,
                    },
                );
                if layout_skinned {
                    skinned_entities.push(e);
                }
            }
        }

        if aabb_min.x > aabb_max.x {
            aabb_min = vec3(-1.0, -1.0, -1.0);
            aabb_max = vec3(1.0, 1.0, 1.0);
        }
        let center = aabb_min.add(aabb_max).scale(0.5);
        let extent = aabb_max.sub(aabb_min);
        let orbit_radius = (extent.length() * 0.5).max(0.5) * 2.4;

        // Sun.
        let sun = world.spawn();
        world.set_component(
            sun,
            DirectionalLight {
                dir: vec3(-0.4, -1.0, -0.3).normalize(),
                color: [1.0, 0.98, 0.92],
                cast_shadows: true,
            },
        );

        // Orbiting perspective camera.
        let camera = world.spawn();
        world.set_component(
            camera,
            Camera {
                viewport_id: 0,
                order: 0,
                projection: Projection::Perspective { fovy: 45.0_f32.to_radians(), near: 0.05, far: 500.0 },
                target: CamTarget::Screen(successor_engine_render::components::RectNorm::FULL),
                clear: successor_engine_render::gpu::ClearSpec {
                    color: Some([0.08, 0.09, 0.11, 1.0]),
                    depth: Some(1.0),
                },
                eye: center.add(vec3(orbit_radius, orbit_radius * 0.6, orbit_radius)),
                look_at: center,
                up: Vec3::Y,
            },
        );

        let anim = clip
            .and_then(|c| doc.animation_by_name(c).cloned())
            .or_else(|| doc.animations.first().cloned());
        let pose = skeleton.as_ref().map(|s| s.rest_pose()).unwrap_or_default();

        Ok(GlbScene {
            world,
            renderer,
            skeleton,
            anim,
            pose,
            palette: Vec::new(),
            skinned_entities,
            camera,
            center,
            orbit_radius,
        })
    }

    pub fn animate(&mut self, frame: u64) {
        // Orbit the camera.
        let angle = frame as f32 * 0.012;
        let eye = self.center.add(vec3(
            angle.cos() * self.orbit_radius,
            self.orbit_radius * 0.55,
            angle.sin() * self.orbit_radius,
        ));
        if let Some(cam) = self.world.get_component::<Camera>(self.camera) {
            cam.eye = eye;
        }

        // Skinned animation.
        if let (Some(sk), Some(anim)) = (self.skeleton.as_mut(), self.anim.as_ref()) {
            let duration = anim.duration.max(0.001);
            let t = (frame as f32 / 60.0) % duration;
            self.pose.copy_from_slice(&sk.rest);
            apply_animation(anim, t, &mut self.pose);
            sk.compute_palette(&self.pose, &mut self.palette);
            self.renderer.begin_skin_frame();
            let offset = self.renderer.push_skin_palette(&self.palette);
            let count = self.palette.len() as u32;
            for &e in &self.skinned_entities {
                if let Some(mr) = self.world.get_component::<MeshRenderer>(e) {
                    mr.skin = SkinRef { offset, count };
                }
            }
        }
    }
}

/// World matrices for every node (roots outward).
fn node_globals(doc: &GlbDocument) -> Vec<Mat4> {
    let n = doc.nodes.len();
    let mut globals = alloc_vec_identity(n);
    let mut done = vec![false; n];
    // Depth-first from scene roots (fallback: nodes with no parent, else all).
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

fn alloc_vec_identity(n: usize) -> Vec<Mat4> {
    vec![Mat4::IDENTITY; n]
}

/// Interleave `pos:3, normal:3, uv:2`, baking the node's world matrix in.
fn build_static_vertices(prim: &glb::GlbPrimitive, g: &Mat4) -> Vec<f32> {
    let n = prim.positions.len();
    let mut out = Vec::with_capacity(n * 8);
    for i in 0..n {
        let p = prim.positions[i];
        let wp = g.transform_point(vec3(p[0], p[1], p[2]));
        let nrm = prim.normals.get(i).copied().unwrap_or([0.0, 1.0, 0.0]);
        // Rotate normal by the matrix's upper 3x3 (assumes ~uniform scale).
        let wn = transform_dir(g, vec3(nrm[0], nrm[1], nrm[2])).normalize();
        let uv = prim.uvs.get(i).copied().unwrap_or([0.0, 0.0]);
        out.extend_from_slice(&[wp.x, wp.y, wp.z, wn.x, wn.y, wn.z, uv[0], uv[1]]);
    }
    out
}

/// Interleave `pos:3, normal:3, uv:2, joints:4(f32), weights:4` (skin space).
fn build_skinned_vertices(prim: &glb::GlbPrimitive) -> Vec<f32> {
    let n = prim.positions.len();
    let mut out = Vec::with_capacity(n * 16);
    for i in 0..n {
        let p = prim.positions[i];
        let nrm = prim.normals.get(i).copied().unwrap_or([0.0, 1.0, 0.0]);
        let uv = prim.uvs.get(i).copied().unwrap_or([0.0, 0.0]);
        let j = prim.joints.get(i).copied().unwrap_or([0, 0, 0, 0]);
        let w = prim.weights.get(i).copied().unwrap_or([1.0, 0.0, 0.0, 0.0]);
        out.extend_from_slice(&[
            p[0], p[1], p[2], nrm[0], nrm[1], nrm[2], uv[0], uv[1],
            j[0] as f32, j[1] as f32, j[2] as f32, j[3] as f32,
            w[0], w[1], w[2], w[3],
        ]);
    }
    out
}

fn transform_dir(g: &Mat4, v: Vec3) -> Vec3 {
    let m = &g.m;
    vec3(
        m[0] * v.x + m[4] * v.y + m[8] * v.z,
        m[1] * v.x + m[5] * v.y + m[9] * v.z,
        m[2] * v.x + m[6] * v.y + m[10] * v.z,
    )
}

fn min3(a: Vec3, b: Vec3) -> Vec3 {
    vec3(a.x.min(b.x), a.y.min(b.y), a.z.min(b.z))
}
fn max3(a: Vec3, b: Vec3) -> Vec3 {
    vec3(a.x.max(b.x), a.y.max(b.y), a.z.max(b.z))
}
