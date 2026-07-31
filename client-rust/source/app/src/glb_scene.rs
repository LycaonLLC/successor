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
use successor_engine_render::renderer::Renderer;

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
    pub fn build<G: Gpu>(
        gpu: &mut G,
        bytes: &[u8],
        clip: Option<&str>,
    ) -> Result<GlbScene, glb::GlbError> {
        let doc = glb::parse(bytes)?;
        let mut renderer =
            Renderer::new(gpu, crate::quality_limits()).expect("renderer initialization failed");
        renderer.set_ambient(0.35);
        let mut world = GameWorld::new();

        let globals = node_globals(&doc);
        let skinned = !doc.skins.is_empty();
        let skeleton = if skinned {
            Skeleton::from_document(&doc, 0)
        } else {
            None
        };

        let uploaded = successor_engine_render::model::upload_glb(&mut renderer, gpu, &doc)
            .map_err(|_| glb::GlbError::Unsupported("model upload"))?;

        let mut aabb_min = vec3(f32::MAX, f32::MAX, f32::MAX);
        let mut aabb_max = vec3(f32::MIN, f32::MIN, f32::MIN);
        let mut skinned_entities = Vec::new();

        for (node_idx, node) in doc.nodes.iter().enumerate() {
            let Some(mesh_idx) = node.mesh else { continue };
            let Some(mesh) = doc.meshes.get(mesh_idx) else {
                continue;
            };
            let g = globals[node_idx];
            for (primitive_idx, prim) in mesh.primitives.iter().enumerate() {
                if prim.positions.is_empty() {
                    continue;
                }
                let is_skinned = skinned && !prim.joints.is_empty() && !prim.weights.is_empty();
                let uploaded_primitive = uploaded
                    .primitives
                    .iter()
                    .find(|item| {
                        item.source_mesh == mesh_idx && item.source_primitive == primitive_idx
                    })
                    .ok_or(glb::GlbError::Unsupported("missing uploaded primitive"))?;
                for position in &prim.positions {
                    let p = if is_skinned {
                        vec3(position[0], position[1], position[2])
                    } else {
                        g.transform_point(vec3(position[0], position[1], position[2]))
                    };
                    aabb_min = min3(aabb_min, p);
                    aabb_max = max3(aabb_max, p);
                }
                let e = world.spawn();
                let (pos, rot, scale) = if is_skinned {
                    (
                        Vec3::ZERO,
                        successor_engine_core::math::Quat::IDENTITY,
                        Vec3::ONE,
                    )
                } else {
                    g.to_trs()
                };
                world.set_component(e, Transform { pos, rot, scale });
                world.set_component(
                    e,
                    MeshRenderer {
                        mesh: uploaded_primitive.mesh,
                        material: uploaded_primitive.material,
                        viewport_mask: 0b1,
                        skin: SkinRef::NONE,
                    },
                );
                if is_skinned {
                    skinned_entities.push(e);
                }
            }
        }

        if aabb_min.x > aabb_max.x {
            aabb_min = vec3(-1.0, -1.0, -1.0);
            aabb_max = vec3(1.0, 1.0, 1.0);
        }
        let center = aabb_min.add(aabb_max).scale(0.5);
        renderer.gi_set_focus([center.x, center.y, center.z]);
        let extent = aabb_max.sub(aabb_min);
        // Keep degenerate meshes viewable without making sub-metre props thumbnail-sized.
        let orbit_radius = (extent.length() * 0.5).max(0.05) * 2.4;

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
                projection: Projection::Perspective {
                    fovy: 45.0_f32.to_radians(),
                    near: 0.05,
                    far: 500.0,
                },
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

fn min3(a: Vec3, b: Vec3) -> Vec3 {
    vec3(a.x.min(b.x), a.y.min(b.y), a.z.min(b.z))
}
fn max3(a: Vec3, b: Vec3) -> Vec3 {
    vec3(a.x.max(b.x), a.y.max(b.y), a.z.max(b.z))
}
