//! Deterministic flora and small world-object scatter over terrain.
//! Produces instance transforms for the renderer's instanced mesh path.

use successor_engine_core::math::{vec3, Mat4, Quat};
use successor_engine_render::primitives;

use super::terrain::Biome;

/// A single placed flora instance.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FloraInstance {
    pub pos: [f32; 3],
    pub yaw: f32,
    pub scale: f32,
    pub kind: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum DetailKind {
    Rock = 0,
    GroundCover = 1,
    Shrub = 2,
}

impl DetailKind {
    pub fn from_hash(value: u8) -> Self {
        if value < 64 {
            Self::Rock
        } else if value < 204 {
            Self::GroundCover
        } else {
            Self::Shrub
        }
    }
}

/// Computes the 32-bit FNV-1a hash of a byte slice.
fn fnv1a_32(data: &[u8]) -> u32 {
    let mut hash = 0x811c9dc5u32;
    for &byte in data {
        hash ^= byte as u32;
        hash = hash.wrapping_mul(0x01000193u32);
    }
    hash
}

/// Generates a deterministic float in `[0.0, 1.0]` using FNV-1a.
fn hash_to_float(seed: i32, cx: i32, cz: i32, index: i32, salt: u32) -> f32 {
    let mut bytes = [0u8; 20];
    bytes[0..4].copy_from_slice(&seed.to_le_bytes());
    bytes[4..8].copy_from_slice(&cx.to_le_bytes());
    bytes[8..12].copy_from_slice(&cz.to_le_bytes());
    bytes[12..16].copy_from_slice(&index.to_le_bytes());
    bytes[16..20].copy_from_slice(&salt.to_le_bytes());
    let h = fnv1a_32(&bytes);
    h as f32 / 4294967295.0
}

/// Deterministically scatters flora instances over an area.
///
/// * `seed` - World seed.
/// * `area_min` - Minimum coordinate boundary `[x, z]`.
/// * `area_max` - Maximum coordinate boundary `[x, z]`.
/// * `density` - Controls average flora instances per cell.
/// * `is_blocked` - Closure to skip placements on blocked regions.
pub fn scatter(
    seed: i32,
    area_min: [f32; 2],
    area_max: [f32; 2],
    density: f32,
    is_blocked: impl Fn([f32; 2]) -> bool,
) -> Vec<FloraInstance> {
    let mut instances = Vec::new();
    scatter_into(
        &mut instances,
        seed,
        area_min,
        area_max,
        density,
        is_blocked,
    );
    instances
}

/// Allocation-stable scatter variant used by pooled terrain chunks.
pub fn scatter_into(
    instances: &mut Vec<FloraInstance>,
    seed: i32,
    area_min: [f32; 2],
    area_max: [f32; 2],
    density: f32,
    is_blocked: impl Fn([f32; 2]) -> bool,
) {
    instances.clear();
    if density <= 0.0 {
        return;
    }

    let x_min = area_min[0].floor() as i32;
    let x_max = area_max[0].floor() as i32;
    let z_min = area_min[1].floor() as i32;
    let z_max = area_max[1].floor() as i32;
    if x_min > x_max || z_min > z_max {
        return;
    }

    for cx in x_min..=x_max {
        for cz in z_min..=z_max {
            let count_roll = hash_to_float(seed, cx, cz, -1, 0);
            let base_count = density.floor() as i32;
            let fract = density - base_count as f32;
            let count = if count_roll < fract {
                base_count + 1
            } else {
                base_count
            };
            for i in 0..count {
                let px = cx as f32 + hash_to_float(seed, cx, cz, i, 1);
                let pz = cz as f32 + hash_to_float(seed, cx, cz, i, 2);
                if px < area_min[0]
                    || px > area_max[0]
                    || pz < area_min[1]
                    || pz > area_max[1]
                    || is_blocked([px, pz])
                {
                    continue;
                }
                instances.push(FloraInstance {
                    pos: [px, 0.0, pz],
                    yaw: hash_to_float(seed, cx, cz, i, 3) * 2.0 * std::f32::consts::PI,
                    scale: 0.5 + hash_to_float(seed, cx, cz, i, 4),
                    kind: (hash_to_float(seed, cx, cz, i, 5) * 255.0) as u8,
                });
            }
        }
    }
}

pub fn biome_density(biome: Biome) -> f32 {
    match biome {
        Biome::Desert => 0.021,
        Biome::Forest => 0.043,
    }
}

/// Converts a flora instance's TRS components into a column-major 4x4 matrix array.
pub fn instance_matrix(f: &FloraInstance) -> [f32; 16] {
    let t = vec3(f.pos[0], f.pos[1], f.pos[2]);
    let r = Quat::from_yaw(f.yaw);
    let s = vec3(f.scale, f.scale, f.scale);
    Mat4::from_trs(t, r, s).to_cols_array()
}

/// Per-kind nonuniform transforms keep one tiny shared mesh from reading as
/// stamped clones. Desert ground cover is scrub; forest ground cover is grass.
pub fn detail_instance_matrix(f: &FloraInstance, kind: DetailKind, biome: Biome) -> [f32; 16] {
    let t = vec3(f.pos[0], f.pos[1], f.pos[2]);
    let r = Quat::from_yaw(f.yaw);
    let s = match (kind, biome) {
        (DetailKind::Rock, _) => vec3(0.55 * f.scale, 0.34 * f.scale, 0.48 * f.scale),
        (DetailKind::GroundCover, Biome::Desert) => {
            vec3(0.42 * f.scale, 0.48 * f.scale, 0.42 * f.scale)
        }
        (DetailKind::GroundCover, Biome::Forest) => {
            vec3(0.22 * f.scale, 0.72 * f.scale, 0.22 * f.scale)
        }
        (DetailKind::Shrub, Biome::Desert) => vec3(1.02 * f.scale, 0.92 * f.scale, 1.02 * f.scale),
        (DetailKind::Shrub, Biome::Forest) => vec3(0.78 * f.scale, 0.90 * f.scale, 0.78 * f.scale),
    };
    Mat4::from_trs(t, r, s).to_cols_array()
}

/// Faceted low-poly boulder shared by every rock instance.
pub fn rock_mesh() -> (Vec<f32>, Vec<u32>) {
    let (mut vertices, indices) = primitives::capsule(0.60, 0.92, 7, 2);
    for (index, vertex) in vertices.chunks_exact_mut(8).enumerate() {
        let warp_x = 0.82 + (index.wrapping_mul(17) % 7) as f32 * 0.045;
        let warp_z = 0.84 + (index.wrapping_mul(11) % 5) as f32 * 0.055;
        vertex[0] *= warp_x;
        vertex[1] *= 0.72;
        vertex[2] *= warp_z;
    }
    (vertices, indices)
}

/// Three crossed tapered blades. Double-sided materials make the silhouette
/// stable from any view without alpha textures or overdraw-heavy billboards.
pub fn tuft_mesh() -> (Vec<f32>, Vec<u32>) {
    let mut vertices = Vec::with_capacity(12 * 8);
    let mut indices = Vec::with_capacity(18);
    for blade in 0..3u32 {
        let angle = blade as f32 * std::f32::consts::PI / 3.0;
        let right = [angle.cos() * 0.22, 0.0, angle.sin() * 0.22];
        let normal = [-angle.sin(), 0.0, angle.cos()];
        let base = vertices.len() as u32 / 8;
        for (x, y, u, v) in [
            (-1.0, 0.0, 0.0, 0.0),
            (1.0, 0.0, 1.0, 0.0),
            (0.38, 1.0, 1.0, 1.0),
            (-0.38, 1.0, 0.0, 1.0),
        ] {
            vertices.extend_from_slice(&[
                right[0] * x,
                y,
                right[2] * x,
                normal[0],
                normal[1],
                normal[2],
                u,
                v,
            ]);
        }
        indices.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
    (vertices, indices)
}

/// Three offset faceted clumps form bushes and dry tumbleweed silhouettes.
pub fn shrub_mesh() -> (Vec<f32>, Vec<u32>) {
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    for (offset, scale) in [
        ([-0.28, 0.16, -0.04], [0.78, 0.72, 0.72]),
        ([0.25, 0.12, 0.08], [0.70, 0.66, 0.78]),
        ([0.0, 0.38, -0.10], [0.82, 0.74, 0.70]),
    ] {
        let (mut clump_vertices, clump_indices) = primitives::capsule(0.52, 0.90, 6, 2);
        let base = vertices.len() as u32 / 8;
        for vertex in clump_vertices.chunks_exact_mut(8) {
            vertex[0] = vertex[0] * scale[0] + offset[0];
            vertex[1] = vertex[1] * scale[1] + offset[1];
            vertex[2] = vertex[2] * scale[2] + offset[2];
        }
        vertices.extend_from_slice(&clump_vertices);
        indices.extend(clump_indices.into_iter().map(|index| base + index));
    }
    (vertices, indices)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_determinism() {
        let seed = 12345;
        let area_min = [0.0, 0.0];
        let area_max = [10.0, 10.0];
        let density = 1.5;
        let is_blocked = |_| false;

        let res1 = scatter(seed, area_min, area_max, density, is_blocked);
        let res2 = scatter(seed, area_min, area_max, density, is_blocked);

        assert!(!res1.is_empty());
        assert_eq!(res1, res2);

        // Different seed should result in different output
        let res_diff_seed = scatter(54321, area_min, area_max, density, is_blocked);
        assert_ne!(res1, res_diff_seed);
    }

    #[test]
    fn test_density_scaling() {
        let seed = 42;
        let area_min = [0.0, 0.0];
        let area_max = [10.0, 10.0];
        let is_blocked = |_| false;

        let res_low = scatter(seed, area_min, area_max, 0.5, is_blocked);
        let res_high = scatter(seed, area_min, area_max, 2.5, is_blocked);

        assert!(res_high.len() > res_low.len());
    }

    #[test]
    fn test_exclusion() {
        let seed = 999;
        let area_min = [0.0, 0.0];
        let area_max = [10.0, 10.0];
        let density = 2.0;

        // Block elements where x > 5.0
        let is_blocked = |pos: [f32; 2]| pos[0] > 5.0;

        let res = scatter(seed, area_min, area_max, density, is_blocked);
        assert!(!res.is_empty());

        for inst in &res {
            assert!(
                inst.pos[0] <= 5.0,
                "Found inst in blocked region: {:?}",
                inst.pos
            );
        }

        // Without blocking, some elements should be in x > 5.0
        let res_unblocked = scatter(seed, area_min, area_max, density, |_| false);
        let has_some_above_5 = res_unblocked.iter().any(|inst| inst.pos[0] > 5.0);
        assert!(
            has_some_above_5,
            "Expected some unblocked instances above x=5.0"
        );
    }

    #[test]
    fn biome_scatter_fits_fixed_batches_and_contains_every_kind() {
        for biome in [Biome::Desert, Biome::Forest] {
            let mut peak = [0usize; 3];
            for seed in 0..32 {
                let instances =
                    scatter(seed, [0.0, 0.0], [64.0, 64.0], biome_density(biome), |_| {
                        false
                    });
                let mut counts = [0usize; 3];
                for instance in instances {
                    counts[DetailKind::from_hash(instance.kind) as usize] += 1;
                }
                for kind in 0..3 {
                    peak[kind] = peak[kind].max(counts[kind]);
                    assert!(counts[kind] <= 128);
                }
            }
            assert!(peak.iter().all(|count| *count > 0));
        }
    }

    #[test]
    fn procedural_detail_meshes_are_indexed_and_finite() {
        for (vertices, indices) in [rock_mesh(), tuft_mesh(), shrub_mesh()] {
            assert!(!vertices.is_empty());
            assert!(!indices.is_empty());
            assert_eq!(vertices.len() % 8, 0);
            assert!(vertices.iter().all(|value| value.is_finite()));
            assert!(indices
                .iter()
                .all(|index| *index < (vertices.len() / 8) as u32));
        }
    }

    #[test]
    fn test_instance_matrix() {
        let inst = FloraInstance {
            pos: [4.5, -1.2, 9.1],
            yaw: 0.0,
            scale: 2.5,
            kind: 3,
        };

        let matrix = instance_matrix(&inst);

        // Column-major layout translation is in the last column
        assert_eq!(matrix[12], 4.5);
        assert_eq!(matrix[13], -1.2);
        assert_eq!(matrix[14], 9.1);
        assert_eq!(matrix[15], 1.0);

        // Scale should be applied along the diagonal since yaw = 0
        assert_eq!(matrix[0], 2.5);
        assert_eq!(matrix[5], 2.5);
        assert_eq!(matrix[10], 2.5);
    }
}
