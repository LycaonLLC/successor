//! Skeletal animation runtime: clip sampling, a layered pose mixer with
//! per-joint masks and cross-fade weights, and joint-palette computation for
//! GPU skinning. `no_std` + `alloc`.
//!
//! This is the substrate the pawn animator (Wave 3) layers gait/upper/grip/
//! montage clips onto. Here we provide the primitives: sample a `GlbAnimation`
//! into a per-node local pose, blend poses, and flatten a node hierarchy into
//! the `joint * inverseBind` skin matrices a skinned vertex shader consumes.

use alloc::vec::Vec;

use crate::glb::{ChannelPath, GlbAnimation, GlbDocument, GlbSampler, Interp};
use crate::math::{vec3, Mat4, Quat, Vec3};

/// One node's local transform (glTF TRS).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct JointTransform {
    pub t: Vec3,
    pub r: Quat,
    pub s: Vec3,
}

impl Default for JointTransform {
    fn default() -> Self {
        JointTransform {
            t: Vec3::ZERO,
            r: Quat::IDENTITY,
            s: Vec3::ONE,
        }
    }
}

impl JointTransform {
    pub fn matrix(&self) -> Mat4 {
        Mat4::from_trs(self.t, self.r, self.s)
    }
}

/// Find the keyframe interval `[i, i+1]` containing `time` and the interpolation
/// factor `f` in `[0,1]`. Clamps to the ends.
fn locate(input: &[f32], time: f32) -> (usize, usize, f32) {
    if input.len() <= 1 {
        return (0, 0, 0.0);
    }
    if time <= input[0] {
        return (0, 0, 0.0);
    }
    let last = input.len() - 1;
    if time >= input[last] {
        return (last, last, 0.0);
    }
    let mut i = 0;
    while i + 1 < input.len() && input[i + 1] < time {
        i += 1;
    }
    let t0 = input[i];
    let t1 = input[i + 1];
    let f = if t1 > t0 { (time - t0) / (t1 - t0) } else { 0.0 };
    (i, i + 1, f)
}

fn sample_vec3(s: &GlbSampler, time: f32) -> Option<Vec3> {
    if s.output.len() < 3 {
        return None;
    }
    let (i0, i1, f) = locate(&s.input, time);
    let a = vec3(s.output[i0 * 3], s.output[i0 * 3 + 1], s.output[i0 * 3 + 2]);
    if s.interp == Interp::Step || i0 == i1 {
        return Some(a);
    }
    let b = vec3(s.output[i1 * 3], s.output[i1 * 3 + 1], s.output[i1 * 3 + 2]);
    Some(a.add(b.sub(a).scale(f)))
}

fn sample_quat(s: &GlbSampler, time: f32) -> Option<Quat> {
    if s.output.len() < 4 {
        return None;
    }
    let (i0, i1, f) = locate(&s.input, time);
    let a = Quat {
        x: s.output[i0 * 4],
        y: s.output[i0 * 4 + 1],
        z: s.output[i0 * 4 + 2],
        w: s.output[i0 * 4 + 3],
    };
    if s.interp == Interp::Step || i0 == i1 {
        return Some(a);
    }
    let b = Quat {
        x: s.output[i1 * 4],
        y: s.output[i1 * 4 + 1],
        z: s.output[i1 * 4 + 2],
        w: s.output[i1 * 4 + 3],
    };
    Some(nlerp(a, b, f))
}

/// Normalized lerp with shortest-arc correction — cheaper than slerp and
/// visually equivalent for animation keyframe density.
pub fn nlerp(a: Quat, mut b: Quat, f: f32) -> Quat {
    let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
    if dot < 0.0 {
        b = Quat { x: -b.x, y: -b.y, z: -b.z, w: -b.w };
    }
    Quat {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        z: a.z + (b.z - a.z) * f,
        w: a.w + (b.w - a.w) * f,
    }
    .normalize()
}

/// Overlay one animation's channels onto an existing per-node pose at `time`.
/// Channels only touch the nodes they target, so unanimated joints keep their
/// current (rest or previously-blended) value.
pub fn apply_animation(anim: &GlbAnimation, time: f32, pose: &mut [JointTransform]) {
    for ch in &anim.channels {
        let Some(sampler) = anim.samplers.get(ch.sampler) else {
            continue;
        };
        if ch.target_node >= pose.len() {
            continue;
        }
        match ch.path {
            ChannelPath::Translation => {
                if let Some(v) = sample_vec3(sampler, time) {
                    pose[ch.target_node].t = v;
                }
            }
            ChannelPath::Rotation => {
                if let Some(q) = sample_quat(sampler, time) {
                    pose[ch.target_node].r = q;
                }
            }
            ChannelPath::Scale => {
                if let Some(v) = sample_vec3(sampler, time) {
                    pose[ch.target_node].s = v;
                }
            }
        }
    }
}

/// Blend `overlay` into `base` per joint by `weight` (0 = keep base, 1 = take
/// overlay). `mask`, when present, gates which joints the overlay may touch
/// (`true` = affected) — the mechanism the pawn animator uses for upper-body /
/// montage layers.
pub fn blend_into(
    base: &mut [JointTransform],
    overlay: &[JointTransform],
    weight: f32,
    mask: Option<&[bool]>,
) {
    if weight <= 0.0 {
        return;
    }
    let w = weight.min(1.0);
    let n = base.len().min(overlay.len());
    for i in 0..n {
        if let Some(m) = mask {
            if !m.get(i).copied().unwrap_or(false) {
                continue;
            }
        }
        let a = base[i];
        let b = overlay[i];
        base[i] = JointTransform {
            t: a.t.add(b.t.sub(a.t).scale(w)),
            r: nlerp(a.r, b.r, w),
            s: a.s.add(b.s.sub(a.s).scale(w)),
        };
    }
}

/// A flattened skeleton: node hierarchy in parent-first order plus the skin's
/// joint list and inverse bind matrices. Built once per body template.
#[derive(Clone, Debug)]
pub struct Skeleton {
    /// Per-node parent (`None` for roots).
    pub parent: Vec<Option<usize>>,
    /// Per-node rest local transform.
    pub rest: Vec<JointTransform>,
    /// Node indices, topologically ordered so a parent precedes its children.
    pub order: Vec<usize>,
    /// Skin joint node indices (palette order).
    pub joints: Vec<usize>,
    /// Inverse bind matrix per joint.
    pub inverse_bind: Vec<Mat4>,
    /// Per-node name (for socket/bone lookup by name).
    pub names: Vec<Option<alloc::string::String>>,
    /// Scratch global matrices per node (reused; no per-frame alloc).
    globals: Vec<Mat4>,
}

impl Skeleton {
    /// Build from a parsed document and a skin index.
    pub fn from_document(doc: &GlbDocument, skin_index: usize) -> Option<Skeleton> {
        let skin = doc.skins.get(skin_index)?;
        let node_count = doc.nodes.len();
        let mut parent = alloc::vec![None; node_count];
        for (i, node) in doc.nodes.iter().enumerate() {
            for &c in &node.children {
                if c < node_count {
                    parent[c] = Some(i);
                }
            }
        }
        let rest: Vec<JointTransform> = doc
            .nodes
            .iter()
            .map(|n| JointTransform {
                t: n.translation,
                r: n.rotation,
                s: n.scale,
            })
            .collect();
        // Topological order: roots first, then breadth-first via children.
        let mut order = Vec::with_capacity(node_count);
        let mut visited = alloc::vec![false; node_count];
        let mut stack: Vec<usize> = (0..node_count).filter(|&i| parent[i].is_none()).collect();
        // Process as a queue preserving parent-before-child.
        let mut qi = 0;
        while qi < stack.len() {
            let n = stack[qi];
            qi += 1;
            if visited[n] {
                continue;
            }
            visited[n] = true;
            order.push(n);
            for &c in &doc.nodes[n].children {
                if c < node_count && !visited[c] {
                    stack.push(c);
                }
            }
        }
        Some(Skeleton {
            parent,
            rest,
            order,
            joints: skin.joints.clone(),
            inverse_bind: skin.inverse_bind.clone(),
            names: doc.nodes.iter().map(|n| n.name.clone()).collect(),
            globals: alloc::vec![Mat4::IDENTITY; node_count],
        })
    }

    /// A fresh pose initialized to the rest transforms.
    pub fn rest_pose(&self) -> Vec<JointTransform> {
        self.rest.clone()
    }

    /// Compute the skinning palette (`global[joint] * inverseBind[joint]`) for a
    /// pose, writing `joints.len()` matrices into `out` (cleared first).
    pub fn compute_palette(&mut self, pose: &[JointTransform], out: &mut Vec<[f32; 16]>) {
        for &n in &self.order {
            let local = pose.get(n).copied().unwrap_or_default().matrix();
            self.globals[n] = match self.parent[n] {
                Some(p) => self.globals[p].mul(local),
                None => local,
            };
        }
        out.clear();
        for (j, &node) in self.joints.iter().enumerate() {
            let g = self.globals.get(node).copied().unwrap_or(Mat4::IDENTITY);
            let ibm = self.inverse_bind.get(j).copied().unwrap_or(Mat4::IDENTITY);
            out.push(g.mul(ibm).to_cols_array());
        }
    }

    pub fn joint_count(&self) -> usize {
        self.joints.len()
    }

    /// First node whose name contains `substr` (case-sensitive) — socket lookup.
    pub fn find_bone(&self, substr: &str) -> Option<usize> {
        self.names
            .iter()
            .position(|n| n.as_deref().map(|s| s.contains(substr)).unwrap_or(false))
    }

    /// World matrix of a node from the last `compute_palette` call.
    pub fn bone_global(&self, node: usize) -> Mat4 {
        self.globals.get(node).copied().unwrap_or(Mat4::IDENTITY)
    }
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;
    use crate::glb::{GlbChannel, GlbSampler};

    fn lin_sampler(input: Vec<f32>, output: Vec<f32>) -> GlbSampler {
        GlbSampler {
            input,
            output,
            interp: Interp::Linear,
        }
    }

    #[test]
    fn samples_translation_midpoint() {
        let anim = GlbAnimation {
            name: None,
            samplers: alloc::vec![lin_sampler(alloc::vec![0.0, 1.0], alloc::vec![0.0, 0.0, 0.0, 4.0, 0.0, 0.0])],
            channels: alloc::vec![GlbChannel {
                sampler: 0,
                target_node: 0,
                path: ChannelPath::Translation,
            }],
            duration: 1.0,
        };
        let mut pose = alloc::vec![JointTransform::default()];
        apply_animation(&anim, 0.5, &mut pose);
        assert!((pose[0].t.x - 2.0).abs() < 1e-5);
    }

    #[test]
    fn step_holds_left_key() {
        let mut s = lin_sampler(alloc::vec![0.0, 1.0], alloc::vec![0.0, 0.0, 0.0, 9.0, 0.0, 0.0]);
        s.interp = Interp::Step;
        assert_eq!(sample_vec3(&s, 0.9).unwrap().x, 0.0);
        assert_eq!(sample_vec3(&s, 1.0).unwrap().x, 9.0);
    }

    #[test]
    fn blend_weight_zero_and_one() {
        let mut base = alloc::vec![JointTransform::default()];
        let overlay = alloc::vec![JointTransform {
            t: vec3(10.0, 0.0, 0.0),
            ..Default::default()
        }];
        let mut b0 = base.clone();
        blend_into(&mut b0, &overlay, 0.0, None);
        assert_eq!(b0[0].t.x, 0.0);
        blend_into(&mut base, &overlay, 1.0, None);
        assert!((base[0].t.x - 10.0).abs() < 1e-5);
    }

    #[test]
    fn mask_gates_joints() {
        let mut base = alloc::vec![JointTransform::default(), JointTransform::default()];
        let overlay = alloc::vec![
            JointTransform { t: vec3(5.0, 0.0, 0.0), ..Default::default() },
            JointTransform { t: vec3(5.0, 0.0, 0.0), ..Default::default() },
        ];
        blend_into(&mut base, &overlay, 1.0, Some(&[true, false]));
        assert!((base[0].t.x - 5.0).abs() < 1e-5);
        assert_eq!(base[1].t.x, 0.0);
    }
}
