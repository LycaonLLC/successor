//! Minimal f32 linear algebra for the renderer. `no_std`; transcendental and
//! sqrt routines go through `libm` (no dependency on `std`'s float intrinsics).
//!
//! `Mat4` is column-major (OpenGL convention): element (row r, col c) lives at
//! `m[c * 4 + r]`, and `to_cols_array()` uploads directly to a GL uniform.

#![allow(clippy::many_single_char_names)]

use libm::{cosf, sinf, sqrtf, tanf};

#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct Vec2 {
    pub x: f32,
    pub y: f32,
}

pub const fn vec2(x: f32, y: f32) -> Vec2 {
    Vec2 { x, y }
}

impl Vec2 {
    pub const ZERO: Vec2 = Vec2 { x: 0.0, y: 0.0 };
}

#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

pub const fn vec3(x: f32, y: f32, z: f32) -> Vec3 {
    Vec3 { x, y, z }
}

impl Vec3 {
    pub const ZERO: Vec3 = Vec3 {
        x: 0.0,
        y: 0.0,
        z: 0.0,
    };
    pub const ONE: Vec3 = Vec3 {
        x: 1.0,
        y: 1.0,
        z: 1.0,
    };
    pub const Y: Vec3 = Vec3 {
        x: 0.0,
        y: 1.0,
        z: 0.0,
    };

    #[allow(clippy::should_implement_trait)]
    pub fn add(self, o: Vec3) -> Vec3 {
        vec3(self.x + o.x, self.y + o.y, self.z + o.z)
    }
    #[allow(clippy::should_implement_trait)]
    pub fn sub(self, o: Vec3) -> Vec3 {
        vec3(self.x - o.x, self.y - o.y, self.z - o.z)
    }
    pub fn scale(self, s: f32) -> Vec3 {
        vec3(self.x * s, self.y * s, self.z * s)
    }
    pub fn dot(self, o: Vec3) -> f32 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }
    pub fn cross(self, o: Vec3) -> Vec3 {
        vec3(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )
    }
    pub fn length(self) -> f32 {
        sqrtf(self.dot(self))
    }
    pub fn normalize(self) -> Vec3 {
        let len = self.length();
        if len > 1e-6 {
            self.scale(1.0 / len)
        } else {
            Vec3::ZERO
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct Vec4 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}

pub const fn vec4(x: f32, y: f32, z: f32, w: f32) -> Vec4 {
    Vec4 { x, y, z, w }
}

/// Unit quaternion (x, y, z, w).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Quat {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}

impl Default for Quat {
    fn default() -> Self {
        Quat::IDENTITY
    }
}

impl Quat {
    pub const IDENTITY: Quat = Quat {
        x: 0.0,
        y: 0.0,
        z: 0.0,
        w: 1.0,
    };

    pub fn from_axis_angle(axis: Vec3, radians: f32) -> Quat {
        let a = axis.normalize();
        let half = radians * 0.5;
        let s = sinf(half);
        Quat {
            x: a.x * s,
            y: a.y * s,
            z: a.z * s,
            w: cosf(half),
        }
    }

    /// Rotation about the world Y axis — the common yaw case for pawns/cameras.
    pub fn from_yaw(radians: f32) -> Quat {
        Quat::from_axis_angle(Vec3::Y, radians)
    }

    #[allow(clippy::should_implement_trait)]
    pub fn mul(self, o: Quat) -> Quat {
        Quat {
            w: self.w * o.w - self.x * o.x - self.y * o.y - self.z * o.z,
            x: self.w * o.x + self.x * o.w + self.y * o.z - self.z * o.y,
            y: self.w * o.y - self.x * o.z + self.y * o.w + self.z * o.x,
            z: self.w * o.z + self.x * o.y - self.y * o.x + self.z * o.w,
        }
    }

    pub fn normalize(self) -> Quat {
        let len = sqrtf(self.x * self.x + self.y * self.y + self.z * self.z + self.w * self.w);
        if len > 1e-6 {
            let inv = 1.0 / len;
            Quat {
                x: self.x * inv,
                y: self.y * inv,
                z: self.z * inv,
                w: self.w * inv,
            }
        } else {
            Quat::IDENTITY
        }
    }
}

/// Column-major 4x4 matrix.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Mat4 {
    pub m: [f32; 16],
}

impl Default for Mat4 {
    fn default() -> Self {
        Mat4::IDENTITY
    }
}

impl Mat4 {
    pub const IDENTITY: Mat4 = Mat4 {
        m: [
            1.0, 0.0, 0.0, 0.0, //
            0.0, 1.0, 0.0, 0.0, //
            0.0, 0.0, 1.0, 0.0, //
            0.0, 0.0, 0.0, 1.0, //
        ],
    };

    pub fn to_cols_array(&self) -> [f32; 16] {
        self.m
    }

    pub fn from_translation(t: Vec3) -> Mat4 {
        let mut m = Mat4::IDENTITY;
        m.m[12] = t.x;
        m.m[13] = t.y;
        m.m[14] = t.z;
        m
    }

    pub fn from_scale(s: Vec3) -> Mat4 {
        let mut m = Mat4::IDENTITY;
        m.m[0] = s.x;
        m.m[5] = s.y;
        m.m[10] = s.z;
        m
    }

    pub fn from_quat(q: Quat) -> Mat4 {
        let Quat { x, y, z, w } = q;
        let (xx, yy, zz) = (x * x, y * y, z * z);
        let (xy, xz, yz) = (x * y, x * z, y * z);
        let (wx, wy, wz) = (w * x, w * y, w * z);
        Mat4 {
            m: [
                1.0 - 2.0 * (yy + zz),
                2.0 * (xy + wz),
                2.0 * (xz - wy),
                0.0,
                2.0 * (xy - wz),
                1.0 - 2.0 * (xx + zz),
                2.0 * (yz + wx),
                0.0,
                2.0 * (xz + wy),
                2.0 * (yz - wx),
                1.0 - 2.0 * (xx + yy),
                0.0,
                0.0,
                0.0,
                0.0,
                1.0,
            ],
        }
    }

    /// Translation * Rotation * Scale.
    pub fn from_trs(t: Vec3, r: Quat, s: Vec3) -> Mat4 {
        Mat4::from_translation(t)
            .mul(Mat4::from_quat(r))
            .mul(Mat4::from_scale(s))
    }

    pub fn mul(&self, o: Mat4) -> Mat4 {
        let a = &self.m;
        let b = &o.m;
        let mut r = [0.0f32; 16];
        for col in 0..4 {
            for row in 0..4 {
                let mut sum = 0.0;
                for k in 0..4 {
                    sum += a[k * 4 + row] * b[col * 4 + k];
                }
                r[col * 4 + row] = sum;
            }
        }
        Mat4 { m: r }
    }

    pub fn transform_point(&self, p: Vec3) -> Vec3 {
        let m = &self.m;
        vec3(
            m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12],
            m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13],
            m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14],
        )
    }

    /// Right-handed perspective, NDC z in [-1, 1] (GL). `fovy` in radians.
    pub fn perspective(fovy: f32, aspect: f32, near: f32, far: f32) -> Mat4 {
        let f = 1.0 / tanf(fovy * 0.5);
        let nf = 1.0 / (near - far);
        let mut m = [0.0f32; 16];
        m[0] = f / aspect;
        m[5] = f;
        m[10] = (far + near) * nf;
        m[11] = -1.0;
        m[14] = 2.0 * far * near * nf;
        Mat4 { m }
    }

    /// Right-handed orthographic, NDC z in [-1, 1] (GL).
    pub fn ortho(left: f32, right: f32, bottom: f32, top: f32, near: f32, far: f32) -> Mat4 {
        let mut m = Mat4::IDENTITY;
        m.m[0] = 2.0 / (right - left);
        m.m[5] = 2.0 / (top - bottom);
        m.m[10] = -2.0 / (far - near);
        m.m[12] = -(right + left) / (right - left);
        m.m[13] = -(top + bottom) / (top - bottom);
        m.m[14] = -(far + near) / (far - near);
        m
    }

    /// Right-handed view matrix (camera at `eye` looking at `center`).
    pub fn look_at(eye: Vec3, center: Vec3, up: Vec3) -> Mat4 {
        let f = center.sub(eye).normalize();
        let s = f.cross(up).normalize();
        let u = s.cross(f);
        Mat4 {
            m: [
                s.x,
                u.x,
                -f.x,
                0.0, //
                s.y,
                u.y,
                -f.y,
                0.0, //
                s.z,
                u.z,
                -f.z,
                0.0, //
                -s.dot(eye),
                -u.dot(eye),
                f.dot(eye),
                1.0, //
            ],
        }
    }

    /// Full 4x4 inverse (column-major). Returns identity if singular. Used for
    /// unprojecting screen rays (`inverse(viewProj)`).
    pub fn inverse(&self) -> Mat4 {
        let m = &self.m;
        let mut inv = [0.0f32; 16];
        inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15]
            + m[9] * m[7] * m[14]
            + m[13] * m[6] * m[11]
            - m[13] * m[7] * m[10];
        inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15]
            - m[8] * m[7] * m[14]
            - m[12] * m[6] * m[11]
            + m[12] * m[7] * m[10];
        inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15]
            + m[8] * m[7] * m[13]
            + m[12] * m[5] * m[11]
            - m[12] * m[7] * m[9];
        inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14]
            - m[8] * m[6] * m[13]
            - m[12] * m[5] * m[10]
            + m[12] * m[6] * m[9];
        inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15]
            - m[9] * m[3] * m[14]
            - m[13] * m[2] * m[11]
            + m[13] * m[3] * m[10];
        inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15]
            + m[8] * m[3] * m[14]
            + m[12] * m[2] * m[11]
            - m[12] * m[3] * m[10];
        inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15]
            - m[8] * m[3] * m[13]
            - m[12] * m[1] * m[11]
            + m[12] * m[3] * m[9];
        inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14]
            + m[8] * m[2] * m[13]
            + m[12] * m[1] * m[10]
            - m[12] * m[2] * m[9];
        inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15]
            + m[5] * m[3] * m[14]
            + m[13] * m[2] * m[7]
            - m[13] * m[3] * m[6];
        inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15]
            - m[4] * m[3] * m[14]
            - m[12] * m[2] * m[7]
            + m[12] * m[3] * m[6];
        inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15]
            + m[4] * m[3] * m[13]
            + m[12] * m[1] * m[7]
            - m[12] * m[3] * m[5];
        inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14]
            - m[4] * m[2] * m[13]
            - m[12] * m[1] * m[6]
            + m[12] * m[2] * m[5];
        inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11]
            - m[5] * m[3] * m[10]
            - m[9] * m[2] * m[7]
            + m[9] * m[3] * m[6];
        inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11]
            + m[4] * m[3] * m[10]
            + m[8] * m[2] * m[7]
            - m[8] * m[3] * m[6];
        inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11]
            - m[4] * m[3] * m[9]
            - m[8] * m[1] * m[7]
            + m[8] * m[3] * m[5];
        inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10]
            + m[4] * m[2] * m[9]
            + m[8] * m[1] * m[6]
            - m[8] * m[2] * m[5];
        let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
        if det.abs() < 1e-12 {
            return Mat4::IDENTITY;
        }
        let inv_det = 1.0 / det;
        for v in inv.iter_mut() {
            *v *= inv_det;
        }
        Mat4 { m: inv }
    }

    /// Transform a point through the full matrix, dividing by w (for unproject).
    pub fn project_point(&self, p: Vec3) -> Vec3 {
        let m = &self.m;
        let x = m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12];
        let y = m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13];
        let z = m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14];
        let w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
        let inv_w = if w.abs() > 1e-12 { 1.0 / w } else { 1.0 };
        vec3(x * inv_w, y * inv_w, z * inv_w)
    }

    /// Decompose a TRS matrix into translation / rotation / scale (assumes no
    /// shear; scale is per-axis basis length). Used to place a socketed mesh at
    /// a posed bone via the engine's TRS `Transform`.
    pub fn to_trs(&self) -> (Vec3, Quat, Vec3) {
        let m = &self.m;
        let t = vec3(m[12], m[13], m[14]);
        let c0 = vec3(m[0], m[1], m[2]);
        let c1 = vec3(m[4], m[5], m[6]);
        let c2 = vec3(m[8], m[9], m[10]);
        let s = vec3(c0.length(), c1.length(), c2.length());
        let r0 = if s.x > 1e-8 { c0.scale(1.0 / s.x) } else { c0 };
        let r1 = if s.y > 1e-8 { c1.scale(1.0 / s.y) } else { c1 };
        let r2 = if s.z > 1e-8 { c2.scale(1.0 / s.z) } else { c2 };
        let trace = r0.x + r1.y + r2.z;
        let q = if trace > 0.0 {
            let w4 = sqrtf(trace + 1.0) * 2.0;
            Quat {
                w: 0.25 * w4,
                x: (r1.z - r2.y) / w4,
                y: (r2.x - r0.z) / w4,
                z: (r0.y - r1.x) / w4,
            }
        } else if r0.x > r1.y && r0.x > r2.z {
            let s4 = sqrtf(1.0 + r0.x - r1.y - r2.z) * 2.0;
            Quat {
                w: (r1.z - r2.y) / s4,
                x: 0.25 * s4,
                y: (r1.x + r0.y) / s4,
                z: (r2.x + r0.z) / s4,
            }
        } else if r1.y > r2.z {
            let s4 = sqrtf(1.0 + r1.y - r0.x - r2.z) * 2.0;
            Quat {
                w: (r2.x - r0.z) / s4,
                x: (r1.x + r0.y) / s4,
                y: 0.25 * s4,
                z: (r2.y + r1.z) / s4,
            }
        } else {
            let s4 = sqrtf(1.0 + r2.z - r0.x - r1.y) * 2.0;
            Quat {
                w: (r0.y - r1.x) / s4,
                x: (r2.x + r0.z) / s4,
                y: (r2.y + r1.z) / s4,
                z: 0.25 * s4,
            }
        };
        (t, q.normalize(), s)
    }
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-4
    }

    #[test]
    fn identity_mul_is_noop() {
        let t = Mat4::from_translation(vec3(1.0, 2.0, 3.0));
        let r = Mat4::IDENTITY.mul(t);
        assert_eq!(r, t);
    }

    #[test]
    fn translation_transforms_point() {
        let t = Mat4::from_translation(vec3(1.0, 2.0, 3.0));
        let p = t.transform_point(vec3(0.0, 0.0, 0.0));
        assert_eq!(p, vec3(1.0, 2.0, 3.0));
    }

    #[test]
    fn yaw_90_rotates_x_to_minus_z() {
        let q = Quat::from_yaw(core::f32::consts::FRAC_PI_2);
        let p = Mat4::from_quat(q).transform_point(vec3(1.0, 0.0, 0.0));
        assert!(
            approx(p.x, 0.0) && approx(p.y, 0.0) && approx(p.z, -1.0),
            "{p:?}"
        );
    }

    #[test]
    fn cross_and_normalize() {
        let c = vec3(1.0, 0.0, 0.0).cross(vec3(0.0, 1.0, 0.0));
        assert_eq!(c, vec3(0.0, 0.0, 1.0));
        assert!(approx(vec3(3.0, 4.0, 0.0).length(), 5.0));
    }

    #[test]
    fn trs_composition_order() {
        // Scale then rotate(yaw 90) then translate: a point at +x scaled by 2
        // becomes (2,0,0), rotates to (0,0,-2), translates by (10,0,0).
        let m = Mat4::from_trs(
            vec3(10.0, 0.0, 0.0),
            Quat::from_yaw(core::f32::consts::FRAC_PI_2),
            vec3(2.0, 2.0, 2.0),
        );
        let p = m.transform_point(vec3(1.0, 0.0, 0.0));
        assert!(
            approx(p.x, 10.0) && approx(p.y, 0.0) && approx(p.z, -2.0),
            "{p:?}"
        );
    }
}
