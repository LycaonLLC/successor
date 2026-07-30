//! Deterministic flora and small world-object scatter over terrain.
//! Produces instance transforms for the renderer's instanced mesh path.

use successor_engine_core::math::{Mat4, Quat, vec3};

/// A single placed flora instance.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FloraInstance {
    pub pos: [f32; 3],
    pub yaw: f32,
    pub scale: f32,
    pub kind: u8,
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
    if density <= 0.0 {
        return Vec::new();
    }

    let x_min = area_min[0].floor() as i32;
    let x_max = area_max[0].floor() as i32;
    let z_min = area_min[1].floor() as i32;
    let z_max = area_max[1].floor() as i32;

    if x_min > x_max || z_min > z_max {
        return Vec::new();
    }

    let mut instances = Vec::new();

    for cx in x_min..=x_max {
        for cz in z_min..=z_max {
            // Roll count for this cell deterministically
            let count_roll = hash_to_float(seed, cx, cz, -1, 0);
            let base_count = density.floor() as i32;
            let fract = density - base_count as f32;
            let count = if count_roll < fract {
                base_count + 1
            } else {
                base_count
            };

            for i in 0..count {
                // Compute jittered position in the cell
                let dx = hash_to_float(seed, cx, cz, i, 1);
                let dz = hash_to_float(seed, cx, cz, i, 2);
                let px = cx as f32 + dx;
                let pz = cz as f32 + dz;

                // Check bounds and exclusion predicate
                if px >= area_min[0] && px <= area_max[0] && pz >= area_min[1] && pz <= area_max[1] {
                    if !is_blocked([px, pz]) {
                        let yaw_roll = hash_to_float(seed, cx, cz, i, 3);
                        let yaw = yaw_roll * 2.0 * std::f32::consts::PI;

                        let scale_roll = hash_to_float(seed, cx, cz, i, 4);
                        let scale = 0.5 + scale_roll * 1.0;

                        let kind_roll = hash_to_float(seed, cx, cz, i, 5);
                        let kind = ((kind_roll * 256.0) as u32).min(255) as u8;

                        instances.push(FloraInstance {
                            pos: [px, 0.0, pz],
                            yaw,
                            scale,
                            kind,
                        });
                    }
                }
            }
        }
    }

    instances
}

/// Converts a flora instance's TRS components into a column-major 4x4 matrix array.
pub fn instance_matrix(f: &FloraInstance) -> [f32; 16] {
    let t = vec3(f.pos[0], f.pos[1], f.pos[2]);
    let r = Quat::from_yaw(f.yaw);
    let s = vec3(f.scale, f.scale, f.scale);
    Mat4::from_trs(t, r, s).to_cols_array()
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
            assert!(inst.pos[0] <= 5.0, "Found inst in blocked region: {:?}", inst.pos);
        }

        // Without blocking, some elements should be in x > 5.0
        let res_unblocked = scatter(seed, area_min, area_max, density, |_| false);
        let has_some_above_5 = res_unblocked.iter().any(|inst| inst.pos[0] > 5.0);
        assert!(has_some_above_5, "Expected some unblocked instances above x=5.0");
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
