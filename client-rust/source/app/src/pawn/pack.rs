//! Pawn pack loader: a PawnForge body GLB (`pawn_male.glb` / `pawn_female.glb` /
//! special bodies) → a reusable template of skinned mesh parts + skeleton +
//! animation clips. Parsing/baking is GPU-free (unit-testable against the real
//! asset); `upload` pushes the baked parts to the renderer for per-actor draws.

use successor_engine_core::anim::{apply_animation, JointTransform, Skeleton};
use successor_engine_core::glb::{self, GlbDocument, GlbError};
use successor_engine_core::math::Mat4;
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
    pub material_names: Vec<Option<String>>,
}

impl PawnTemplate {
    pub fn from_bytes(bytes: &[u8]) -> Result<PawnTemplate, GlbError> {
        let doc = glb::parse(bytes)?;
        let skeleton = Skeleton::from_document(&doc, 0).ok_or(GlbError::Unsupported("no skin"))?;
        let mut parts = Vec::new();
        for node in &doc.nodes {
            let Some(mi) = node.mesh else { continue };
            let Some(mesh) = doc.meshes.get(mi) else {
                continue;
            };
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
        Ok(PawnTemplate {
            skeleton,
            parts,
            doc,
        })
    }

    /// Height of the skinned source geometry in its authored units.
    pub fn authored_height(&self) -> Option<f32> {
        let mut min_y = f32::MAX;
        let mut max_y = f32::MIN;
        for part in &self.parts {
            for vertex in part.vertices.chunks_exact(16) {
                min_y = min_y.min(vertex[1]);
                max_y = max_y.max(vertex[1]);
            }
        }
        let height = max_y - min_y;
        (height.is_finite() && height > 1.0e-4).then_some(height)
    }

    /// Uniform conversion from authored units to a canonical world-space
    /// height. Invalid or empty source geometry fails closed.
    pub fn uniform_scale_for_height(&self, target_height: f32) -> Option<f32> {
        if !target_height.is_finite() || target_height <= 0.0 {
            return None;
        }
        Some(target_height / self.authored_height()?)
    }

    pub fn clip_names(&self) -> Vec<&str> {
        self.doc
            .animations
            .iter()
            .filter_map(|a| a.name.as_deref())
            .collect()
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
        let uploaded = successor_engine_render::model::upload_glb(renderer, gpu, &self.doc)
            .expect("parsed pawn document must upload");
        let (parts, material_names) = uploaded
            .primitives
            .into_iter()
            .filter_map(|part| {
                let primitive = self
                    .doc
                    .meshes
                    .get(part.source_mesh)?
                    .primitives
                    .get(part.source_primitive)?;
                if primitive.joints.is_empty() {
                    return None;
                }
                let material_name = primitive
                    .material
                    .and_then(|index| self.doc.materials.get(index))
                    .and_then(|material| material.name.clone());
                Some(((part.mesh, part.material), material_name))
            })
            .unzip();
        PawnGpuParts {
            parts,
            material_names,
        }
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
            p[0],
            p[1],
            p[2],
            nrm[0],
            nrm[1],
            nrm[2],
            uv[0],
            uv[1],
            j[0] as f32,
            j[1] as f32,
            j[2] as f32,
            j[3] as f32,
            w[0],
            w[1],
            w[2],
            w[3],
        ]);
    }
    out
}

/// Load a static GLB through the shared material/mesh uploader and retain each
/// source node's global transform for socket composition.
pub fn upload_static_parts<G: Gpu>(
    gpu: &mut G,
    renderer: &mut Renderer,
    bytes: &[u8],
) -> Result<Vec<(MeshId, MaterialId, Mat4)>, GlbError> {
    let doc = glb::parse(bytes)?;
    let count = doc.nodes.len();
    let mut globals = vec![Mat4::IDENTITY; count];
    let mut done = vec![false; count];
    let mut roots = doc.scene_roots.clone();
    if roots.is_empty() {
        let mut has_parent = vec![false; count];
        for node in &doc.nodes {
            for &child in &node.children {
                if child < count {
                    has_parent[child] = true;
                }
            }
        }
        roots = (0..count).filter(|&index| !has_parent[index]).collect();
    }
    let mut stack: Vec<(usize, Mat4)> = roots.iter().map(|&root| (root, Mat4::IDENTITY)).collect();
    while let Some((index, parent)) = stack.pop() {
        if index >= count || done[index] {
            continue;
        }
        done[index] = true;
        let global = parent.mul(doc.nodes[index].local_matrix());
        globals[index] = global;
        for &child in &doc.nodes[index].children {
            stack.push((child, global));
        }
    }
    let uploaded = successor_engine_render::model::upload_glb(renderer, gpu, &doc)
        .map_err(|_| GlbError::Unsupported("model upload"))?;
    let mut parts = Vec::new();
    for (node_index, node) in doc.nodes.iter().enumerate() {
        let Some(mesh_index) = node.mesh else {
            continue;
        };
        for primitive in uploaded
            .primitives
            .iter()
            .filter(|primitive| primitive.source_mesh == mesh_index)
        {
            parts.push((primitive.mesh, primitive.material, globals[node_index]));
        }
    }
    Ok(parts)
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
        assert!(
            clips.contains(&"walk_f") || clips.iter().any(|c| c.contains("walk")),
            "a walk clip present"
        );
        // Skinned vertices are 16 floats each.
        assert_eq!(tpl.parts[0].vertices.len() % 16, 0);
        let authored_height = tpl.authored_height().expect("finite pawn height");
        let scale = tpl
            .uniform_scale_for_height(crate::world::ADULT_PAWN_HEIGHT_METERS)
            .expect("pawn can normalize to world units");
        assert!(authored_height > 0.0);
        assert!((authored_height * scale - crate::world::ADULT_PAWN_HEIGHT_METERS).abs() < 1.0e-5);
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
