//! Orthographic isometric camera — port of `client-3d/src/render/camera.ts`
//! (`IsometricCameraController`) using `config.camera` constants. Produces the
//! engine `Camera` component's eye/look-at/ortho each frame with smoothed
//! follow, and exposes zoom clamping. Ground-ray unprojection for picking lives
//! in `picking.rs`.

use successor_engine_core::math::{vec3, Vec3};
use successor_engine_render::components::{Camera, Projection};

// config.camera
const YAW_DEG: f32 = 0.0;
const PITCH_DEG: f32 = 60.0;
const DISTANCE_CELLS: f32 = 96.0;
const BASE_FRUSTUM_HEIGHT_CELLS: f32 = 12.5;
const MIN_ZOOM_PERCENT: f32 = 55.0;
const MAX_ZOOM_PERCENT: f32 = 140.0;
const FOLLOW_LERP_PER_SECOND: f32 = 12.0;
pub const NEAR: f32 = 0.1;
pub const FAR: f32 = 320.0;

pub fn clamp_zoom_percent(pct: f32) -> f32 {
    pct.clamp(MIN_ZOOM_PERCENT, MAX_ZOOM_PERCENT)
}

/// Fixed camera offset from the focus point (yaw 0, pitch 60°, distance 96).
pub fn camera_offset() -> Vec3 {
    let yaw = YAW_DEG.to_radians();
    let pitch = PITCH_DEG.to_radians();
    let horizontal = pitch.cos() * DISTANCE_CELLS;
    let height = pitch.sin() * DISTANCE_CELLS;
    vec3(yaw.sin() * horizontal, height, yaw.cos() * horizontal)
}

pub struct IsoCamera {
    center: Vec3,
    zoom_percent: f32,
    initialized: bool,
}

impl Default for IsoCamera {
    fn default() -> Self {
        IsoCamera {
            center: Vec3::ZERO,
            zoom_percent: MIN_ZOOM_PERCENT,
            initialized: false,
        }
    }
}

impl IsoCamera {
    pub fn set_zoom(&mut self, pct: f32) {
        self.zoom_percent = clamp_zoom_percent(pct);
    }

    pub fn zoom_percent(&self) -> f32 {
        self.zoom_percent
    }

    pub fn center(&self) -> Vec3 {
        self.center
    }

    /// Ortho half-height in world units at the current zoom.
    pub fn half_height(&self) -> f32 {
        (BASE_FRUSTUM_HEIGHT_CELLS / (self.zoom_percent / 100.0)) * 0.5
    }

    /// Smoothly follow `(x, z)` on the ground plane (exponential lerp; snaps on
    /// the first call).
    pub fn update_focus(&mut self, x: f32, z: f32, dt_seconds: f32) {
        let desired = vec3(x, 0.0, z);
        if !self.initialized {
            self.center = desired;
            self.initialized = true;
        } else {
            let alpha = 1.0 - (-FOLLOW_LERP_PER_SECOND * dt_seconds.max(0.0)).exp();
            self.center = self.center.add(desired.sub(self.center).scale(alpha));
        }
    }

    /// Write eye/look-at/projection into a `Camera` component (ortho iso).
    pub fn apply(&self, cam: &mut Camera) {
        cam.eye = self.center.add(camera_offset());
        cam.look_at = self.center;
        cam.up = Vec3::Y;
        cam.projection = Projection::Ortho {
            half_height: self.half_height(),
            near: NEAR,
            far: FAR,
        };
    }

    /// The combined view-projection matrix at a given aspect ratio.
    pub fn view_proj(&self, aspect: f32) -> successor_engine_core::math::Mat4 {
        use successor_engine_core::math::Mat4;
        let eye = self.center.add(camera_offset());
        let view = Mat4::look_at(eye, self.center, Vec3::Y);
        let hh = self.half_height();
        let hw = hh * aspect;
        let proj = Mat4::ortho(-hw, hw, -hh, hh, NEAR, FAR);
        proj.mul(view)
    }

    /// Unproject a normalized device coord (`-1..1`, y up) to the ground plane
    /// (y = 0). Returns `None` if the ray is parallel or points away.
    pub fn ground_pick(&self, aspect: f32, ndc_x: f32, ndc_y: f32) -> Option<Vec3> {
        let inv = self.view_proj(aspect).inverse();
        let near = inv.project_point(vec3(ndc_x, ndc_y, -1.0));
        let far = inv.project_point(vec3(ndc_x, ndc_y, 1.0));
        let dir = far.sub(near);
        if dir.y.abs() < 1e-6 {
            return None;
        }
        let t = -near.y / dir.y;
        if t < 0.0 || !t.is_finite() {
            return None;
        }
        let hit = near.add(dir.scale(t));
        if hit.x.is_finite() && hit.z.is_finite() {
            Some(hit)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offset_pitch_60() {
        let o = camera_offset();
        assert!(o.x.abs() < 1e-4, "yaw 0 → no x offset");
        // pitch 60°: height = sin60*96 ≈ 83.14, horizontal = cos60*96 = 48.
        assert!((o.y - 83.138).abs() < 0.01);
        assert!((o.z - 48.0).abs() < 0.01);
    }

    #[test]
    fn zoom_clamps() {
        assert_eq!(clamp_zoom_percent(10.0), 55.0);
        assert_eq!(clamp_zoom_percent(999.0), 140.0);
        assert_eq!(clamp_zoom_percent(100.0), 100.0);
    }

    #[test]
    fn half_height_scales_inverse_zoom() {
        let mut c = IsoCamera::default();
        c.set_zoom(55.0);
        assert!((c.half_height() - (12.5 / 0.55) * 0.5).abs() < 1e-3);
        c.set_zoom(140.0);
        assert!((c.half_height() - (12.5 / 1.4) * 0.5).abs() < 1e-3);
    }

    #[test]
    fn follow_snaps_then_converges() {
        let mut c = IsoCamera::default();
        c.update_focus(10.0, 20.0, 0.016);
        assert_eq!(c.center(), vec3(10.0, 0.0, 20.0)); // first call snaps
        // Move target; center should approach but not overshoot.
        for _ in 0..200 {
            c.update_focus(30.0, 20.0, 0.016);
        }
        assert!((c.center().x - 30.0).abs() < 0.1);
    }
}
