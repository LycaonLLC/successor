//! Pawn pack loader: a PawnForge body GLB (`pawn_male.glb` / `pawn_female.glb` /
//! special bodies) → a reusable template of skinned mesh parts + skeleton +
//! animation clips. Parsing/baking is GPU-free (unit-testable against the real
//! asset); `upload` pushes the baked parts to the renderer for per-actor draws.

use successor_engine_core::anim::{apply_animation, JointTransform, Skeleton};
use successor_engine_core::glb::{self, GlbDocument, GlbError};
use successor_engine_render::components::{MaterialId, MeshId};
use successor_engine_render::gpu::Gpu;
use successor_engine_render::renderer::Renderer;

/// A skinned mesh part before GPU upload: interleaved `SKINNED_MESH_LAYOUT`
/// vertices + indices + base color.
pub struct BakedPart {
    pub vertices: Vec<f32>,
    pub indices: Vec<u32>,
    pub color: [f32; 4],
}

/// GPU-free body template: skeleton, animation clips (via the retained doc), and
/// baked skinned parts.
pub struct PawnTemplate {
    pub skeleton: Skeleton,
    pub parts: Vec<BakedPart>,
    doc: GlbDocument,
}

/// GPU-resident parts (one per `BakedPart`).
pub struct PawnGpuParts {
    pub parts: Vec<(MeshId, MaterialId)>,
}

impl PawnTemplate {
    pub fn from_bytes(bytes: &[u8]) -> Result<PawnTemplate, GlbError> {
        let doc = glb::parse(bytes)?;
        let skeleton = Skeleton::from_document(&doc, 0).ok_or(GlbError::Unsupported("no skin"))?;
        let mut parts = Vec::new();
        for node in &doc.nodes {
            let Some(mi) = node.mesh else { continue };
            let Some(mesh) = doc.meshes.get(mi) else { continue };
            for prim in &mesh.primitives {
                if prim.positions.is_empty() || prim.joints.is_empty() {
                    continue; // skinned parts only
                }
                let color = prim
                    .material
                    .and_then(|i| doc.materials.get(i))
                    .map(|m| m.base_color)
                    .unwrap_or([0.72, 0.70, 0.67, 1.0]);
                parts.push(BakedPart {
                    vertices: bake_skinned(prim),
                    indices: prim.indices.clone(),
                    color,
                });
            }
        }
        Ok(PawnTemplate { skeleton, parts, doc })
    }

    pub fn clip_names(&self) -> Vec<&str> {
        self.doc.animations.iter().filter_map(|a| a.name.as_deref()).collect()
    }

    pub fn animation(&self, name: &str) -> Option<&glb::GlbAnimation> {
        self.doc.animation_by_name(name)
    }

    pub fn joint_count(&self) -> usize {
        self.skeleton.joint_count()
    }

    /// A rest pose buffer sized for this skeleton.
    pub fn rest_pose(&self) -> Vec<JointTransform> {
        self.skeleton.rest_pose()
    }

    /// Sample a clip at `time` into a reusable `pose` (reset to rest first).
    pub fn pose_at(&self, clip: &str, time: f32, pose: &mut Vec<JointTransform>) {
        pose.clear();
        pose.extend_from_slice(&self.skeleton.rest);
        if let Some(anim) = self.animation(clip) {
            apply_animation(anim, time, pose);
        }
    }

    /// Upload the baked parts to the renderer (skinned meshes + materials).
    pub fn upload<G: Gpu>(&self, gpu: &mut G, renderer: &mut Renderer) -> PawnGpuParts {
        let mut parts = Vec::with_capacity(self.parts.len());
        for p in &self.parts {
            let color = if p.color[0].max(p.color[1]).max(p.color[2]) < 0.15 {
                [0.72, 0.70, 0.67, p.color[3]]
            } else {
                p.color
            };
            let mesh = renderer.upload_skinned_mesh(gpu, &p.vertices, &p.indices);
            let material = renderer.add_material(color);
            parts.push((mesh, material));
        }
        PawnGpuParts { parts }
    }
}

/// Interleave one primitive into `SKINNED_MESH_LAYOUT` (pos3,norm3,uv2,joints4,weights4).
fn bake_skinned(prim: &glb::GlbPrimitive) -> Vec<f32> {
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

#[cfg(test)]
mod tests {
    use super::*;

    // Path from the app crate root (client-rust/source/app) to the repo asset.
    const PAWN_MALE: &str = "../../../client-3d/public/assets/pawn-pack/pawn_male.glb";

    #[test]
    fn loads_pawn_male_template() {
        let Ok(bytes) = std::fs::read(PAWN_MALE) else {
            eprintln!("skip: {PAWN_MALE} not present");
            return;
        };
        let tpl = PawnTemplate::from_bytes(&bytes).expect("parse pawn");
        assert_eq!(tpl.joint_count(), 50, "pawn rig joint count");
        assert!(!tpl.parts.is_empty(), "has skinned parts");
        let clips = tpl.clip_names();
        assert!(clips.contains(&"idle"), "idle clip present");
        assert!(clips.contains(&"walk_f") || clips.iter().any(|c| c.contains("walk")), "a walk clip present");
        // Skinned vertices are 16 floats each.
        assert_eq!(tpl.parts[0].vertices.len() % 16, 0);
    }

    #[test]
    fn pose_at_resets_to_rest_then_animates() {
        let Ok(bytes) = std::fs::read(PAWN_MALE) else {
            return;
        };
        let tpl = PawnTemplate::from_bytes(&bytes).expect("parse");
        let mut pose = tpl.rest_pose();
        let len = pose.len();
        tpl.pose_at("idle", 0.5, &mut pose);
        assert_eq!(pose.len(), len, "pose stays skeleton-sized");
    }
}

/// Load a static (non-skinned) GLB's parts, baking node-global transforms into
/// vertices (no recentering). Used for socketed weapons attached to a bone.
pub fn upload_static_parts<G: Gpu>(
    gpu: &mut G,
    renderer: &mut Renderer,
    bytes: &[u8],
) -> Result<Vec<(MeshId, MaterialId)>, GlbError> {
    use successor_engine_core::math::{vec3, Mat4};
    let doc = glb::parse(bytes)?;
    // Node globals (roots outward).
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
    let mut parts = Vec::new();
    for (ni, node) in doc.nodes.iter().enumerate() {
        let Some(mi) = node.mesh else { continue };
        let Some(mesh) = doc.meshes.get(mi) else { continue };
        let g = globals[ni];
        for prim in &mesh.primitives {
            if prim.positions.is_empty() {
                continue;
            }
            let mut verts = Vec::with_capacity(prim.positions.len() * 8);
            for i in 0..prim.positions.len() {
                let p = prim.positions[i];
                let w = g.transform_point(vec3(p[0], p[1], p[2]));
                let nrm = prim.normals.get(i).copied().unwrap_or([0.0, 1.0, 0.0]);
                let uv = prim.uvs.get(i).copied().unwrap_or([0.0, 0.0]);
                verts.extend_from_slice(&[w.x, w.y, w.z, nrm[0], nrm[1], nrm[2], uv[0], uv[1]]);
            }
            let color = prim
                .material
                .and_then(|i| doc.materials.get(i))
                .map(|m| m.base_color)
                .unwrap_or([0.4, 0.4, 0.42, 1.0]);
            let color = if color[0].max(color[1]).max(color[2]) < 0.12 { [0.35, 0.35, 0.38, color[3]] } else { color };
            let mesh_id = renderer.upload_mesh(gpu, &verts, &prim.indices);
            let material = renderer.add_material(color);
            parts.push((mesh_id, material));
        }
    }
    Ok(parts)
}
