//! Screen-space picking — port of `client-3d/src/render/picking.ts`'s core:
//! screen→NDC→ground unprojection (via `IsoCamera::ground_pick`) plus ray/AABB
//! prop hit-testing and nearest-actor selection on the ground plane. CPU-side,
//! no per-frame allocation (callers pass their own candidate slices).

use successor_engine_core::math::Vec3;

use super::camera::IsoCamera;

/// Pixel (top-left origin) → NDC (`-1..1`, y up).
pub fn screen_to_ndc(px: f32, py: f32, w: f32, h: f32) -> (f32, f32) {
    ((px / w) * 2.0 - 1.0, -((py / h) * 2.0 - 1.0))
}

/// Axis-aligned box in world space (prop footprint / bounds).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Aabb {
    pub min: Vec3,
    pub max: Vec3,
}

/// Slab ray/AABB intersection; returns the near hit distance if the ray
/// (origin + t·dir, t ≥ 0) enters the box.
pub fn ray_aabb(origin: Vec3, dir: Vec3, b: &Aabb) -> Option<f32> {
    let mut tmin = 0.0f32;
    let mut tmax = f32::INFINITY;
    for axis in 0..3 {
        let (o, d, lo, hi) = match axis {
            0 => (origin.x, dir.x, b.min.x, b.max.x),
            1 => (origin.y, dir.y, b.min.y, b.max.y),
            _ => (origin.z, dir.z, b.min.z, b.max.z),
        };
        if d.abs() < 1e-8 {
            if o < lo || o > hi {
                return None;
            }
        } else {
            let inv = 1.0 / d;
            let mut t1 = (lo - o) * inv;
            let mut t2 = (hi - o) * inv;
            if t1 > t2 {
                core::mem::swap(&mut t1, &mut t2);
            }
            tmin = tmin.max(t1);
            tmax = tmax.min(t2);
            if tmin > tmax {
                return None;
            }
        }
    }
    Some(tmin)
}

/// Result of a world pick at a screen position.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Pick {
    /// A ground cell (world x, z).
    Ground(f32, f32),
    /// A prop by its caller-supplied index, at hit distance.
    Prop(usize, f32),
    /// An actor by its caller-supplied index.
    Actor(usize),
}

/// Pick the closest of: props (ray/AABB), actors (ground-disc around the foot),
/// else the ground point. `props`/`actors` carry caller indices.
pub fn pick(
    camera: &IsoCamera,
    aspect: f32,
    ndc_x: f32,
    ndc_y: f32,
    props: &[(usize, Aabb)],
    actors: &[(usize, Vec3, f32)], // (index, foot pos, select radius)
) -> Option<Pick> {
    let ground = camera.ground_pick(aspect, ndc_x, ndc_y)?;
    // Ray from the camera eye toward the ground hit (ortho: constant dir).
    let eye = camera.center().add(super::camera::camera_offset());
    let dir = ground.sub(eye).normalize();

    let mut best_prop: Option<(usize, f32)> = None;
    for (idx, aabb) in props {
        if let Some(t) = ray_aabb(eye, dir, aabb) {
            if best_prop.map(|(_, bt)| t < bt).unwrap_or(true) {
                best_prop = Some((*idx, t));
            }
        }
    }

    // Actor selection: nearest foot within its select radius of the ground hit.
    let mut best_actor: Option<(usize, f32)> = None;
    for (idx, foot, radius) in actors {
        let dx = foot.x - ground.x;
        let dz = foot.z - ground.z;
        let d2 = dx * dx + dz * dz;
        if d2 <= radius * radius && best_actor.map(|(_, bd)| d2 < bd).unwrap_or(true) {
            best_actor = Some((*idx, d2));
        }
    }

    // Priority: an actor under the cursor wins over a prop wins over bare ground.
    if let Some((idx, _)) = best_actor {
        return Some(Pick::Actor(idx));
    }
    if let Some((idx, t)) = best_prop {
        return Some(Pick::Prop(idx, t));
    }
    Some(Pick::Ground(ground.x, ground.z))
}

#[cfg(test)]
mod tests {
    use super::*;
    use successor_engine_core::math::vec3;

    #[test]
    fn ndc_center_is_origin() {
        let (x, y) = screen_to_ndc(640.0, 360.0, 1280.0, 720.0);
        assert!(x.abs() < 1e-6 && y.abs() < 1e-6);
    }

    #[test]
    fn iso_center_screen_hits_focus() {
        let mut cam = IsoCamera::default();
        cam.update_focus(0.0, 0.0, 0.016);
        let hit = cam
            .ground_pick(16.0 / 9.0, 0.0, 0.0)
            .expect("center hits ground");
        assert!(hit.x.abs() < 0.5, "x≈0 got {}", hit.x);
        assert!(hit.z.abs() < 0.5, "z≈0 got {}", hit.z);
    }

    #[test]
    fn ray_aabb_hit_and_miss() {
        let b = Aabb {
            min: vec3(-1.0, -1.0, -1.0),
            max: vec3(1.0, 1.0, 1.0),
        };
        assert!(ray_aabb(vec3(0.0, 0.0, -5.0), vec3(0.0, 0.0, 1.0), &b).is_some());
        assert!(ray_aabb(vec3(5.0, 5.0, -5.0), vec3(0.0, 0.0, 1.0), &b).is_none());
    }

    #[test]
    fn actor_beats_ground() {
        let mut cam = IsoCamera::default();
        cam.update_focus(0.0, 0.0, 0.016);
        let actors = [(7usize, vec3(0.0, 0.0, 0.0), 1.5f32)];
        let p = pick(&cam, 16.0 / 9.0, 0.0, 0.0, &[], &actors).unwrap();
        assert_eq!(p, Pick::Actor(7));
    }
}
