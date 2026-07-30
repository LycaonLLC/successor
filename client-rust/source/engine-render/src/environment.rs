//! World environment: server world-clock → presentation (port of
//! `SUCCESSOR_3D_CONFIG.environment`). Maps a minute-of-day to the sun
//! direction/elevation/color and a time-of-day color grade (fog clear color,
//! bone tint, desaturate, scene darken, black lift, bloom) by interpolating the
//! authored grade anchors, wrapping across midnight. Pure + `no_std`.

use libm::{cosf, sinf, sqrtf};

/// Minutes in a day.
pub const DAY_MINUTES: f32 = 1440.0;

/// One authored grade anchor.
#[derive(Clone, Copy, Debug)]
pub struct GradeAnchor {
    pub minute: f32,
    pub fog: [f32; 3],
    pub bone_tint: [f32; 3],
    pub desaturate: f32,
    pub scene_darken: f32,
    pub black_lift: f32,
    pub bloom: f32,
}

const fn rgb(r: u8, g: u8, b: u8) -> [f32; 3] {
    [r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0]
}

/// The authored day grade (config `environment.grade.anchors`).
pub const GRADE: [GradeAnchor; 7] = [
    GradeAnchor { minute: 0.0, fog: rgb(0x2b, 0x30, 0x40), bone_tint: [0.86, 0.92, 1.14], desaturate: 0.34, scene_darken: 0.38, black_lift: 0.05, bloom: 0.65 },
    GradeAnchor { minute: 360.0, fog: rgb(0xb9, 0x7d, 0x58), bone_tint: [1.1, 0.95, 0.82], desaturate: 0.16, scene_darken: 0.85, black_lift: 0.04, bloom: 0.5 },
    GradeAnchor { minute: 480.0, fog: rgb(0xc9, 0xa9, 0x7e), bone_tint: [1.06, 0.99, 0.88], desaturate: 0.18, scene_darken: 0.96, black_lift: 0.015, bloom: 0.18 },
    GradeAnchor { minute: 720.0, fog: rgb(0xc9, 0xad, 0x82), bone_tint: [1.04, 1.0, 0.9], desaturate: 0.2, scene_darken: 1.0, black_lift: 0.03, bloom: 0.35 },
    GradeAnchor { minute: 1080.0, fog: rgb(0xc9, 0x9a, 0x6e), bone_tint: [1.07, 0.97, 0.86], desaturate: 0.17, scene_darken: 0.9, black_lift: 0.025, bloom: 0.32 },
    GradeAnchor { minute: 1140.0, fog: rgb(0xb0, 0x6a, 0x4a), bone_tint: [1.12, 0.92, 0.85], desaturate: 0.14, scene_darken: 0.8, black_lift: 0.04, bloom: 0.55 },
    GradeAnchor { minute: 1260.0, fog: rgb(0x33, 0x3a, 0x52), bone_tint: [0.88, 0.94, 1.12], desaturate: 0.32, scene_darken: 0.42, black_lift: 0.05, bloom: 0.6 },
];

/// Sun light tints (config `environment.sun.tints`).
const NOON: [f32; 3] = rgb(0xff, 0xf3, 0xe2);
const DAWN_DUSK: [f32; 3] = rgb(0xff, 0xb2, 0x77);
const NIGHT: [f32; 3] = rgb(0x8f, 0xa0, 0xc8);

/// Sampled environment for a given time of day.
#[derive(Clone, Copy, Debug)]
pub struct EnvSample {
    /// Direction the sunlight travels (normalized, world space).
    pub sun_dir: [f32; 3],
    /// Sun/moon light color.
    pub sun_color: [f32; 3],
    /// 0 at horizon, 1 at zenith (drives shadow strength + brightness).
    pub sun_elevation01: f32,
    /// Whether the sun is above the horizon (else moonlit night).
    pub is_day: bool,
    pub fog: [f32; 3],
    pub bone_tint: [f32; 3],
    pub desaturate: f32,
    pub scene_darken: f32,
    pub black_lift: f32,
    pub bloom: f32,
}

#[inline]
fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}
#[inline]
fn lerp3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)]
}

/// Interpolate the grade anchors at `minute` (wrapping across midnight).
pub fn sample_grade(minute: f32) -> GradeAnchor {
    let m = wrap_day(minute);
    let n = GRADE.len();
    // Find the anchor pair bracketing m (wrapping).
    for i in 0..n {
        let a = GRADE[i];
        let b = GRADE[(i + 1) % n];
        let bm = if b.minute <= a.minute { b.minute + DAY_MINUTES } else { b.minute };
        let mm = if m < a.minute { m + DAY_MINUTES } else { m };
        if mm >= a.minute && mm <= bm {
            let t = if bm > a.minute { (mm - a.minute) / (bm - a.minute) } else { 0.0 };
            return GradeAnchor {
                minute: m,
                fog: lerp3(a.fog, b.fog, t),
                bone_tint: lerp3(a.bone_tint, b.bone_tint, t),
                desaturate: lerp(a.desaturate, b.desaturate, t),
                scene_darken: lerp(a.scene_darken, b.scene_darken, t),
                black_lift: lerp(a.black_lift, b.black_lift, t),
                bloom: lerp(a.bloom, b.bloom, t),
            };
        }
    }
    GRADE[0]
}

/// Full environment sample at `minute` of the day.
pub fn sample(minute: f32) -> EnvSample {
    let m = wrap_day(minute);
    let grade = sample_grade(m);
    // Daylight window 6:00 (360) .. 18:00 (1080). Azimuth 0..π over the arc
    // (sunrise=0, noon=π/2, dusk=π); env horizontal dir = (-cos a, -sin a).
    let day = (360.0..=1080.0).contains(&m);
    let (sun_dir, elevation01, color) = if day {
        let p = (m - 360.0) / 720.0; // 0..1
        let a = p * core::f32::consts::PI;
        let elev = sinf(a).max(0.0); // 0 at horizon, 1 at noon
        // Light travels downward + along the horizontal azimuth.
        let hx = -cosf(a);
        let hz = -sinf(a);
        let mut dir = [hx, -(0.2 + 0.8 * elev), hz];
        norm3(&mut dir);
        // Color: dawn/dusk ember near horizon → bone white at noon.
        let c = lerp3(DAWN_DUSK, NOON, elev);
        (dir, elev, c)
    } else {
        // Night: dim moonlight straight-ish down, slate blue.
        ([0.1, -0.98, 0.1], 0.0, NIGHT)
    };
    EnvSample {
        sun_dir,
        sun_color: color,
        sun_elevation01: elevation01,
        is_day: day,
        fog: grade.fog,
        bone_tint: grade.bone_tint,
        desaturate: grade.desaturate,
        scene_darken: grade.scene_darken,
        black_lift: grade.black_lift,
        bloom: grade.bloom,
    }
}

fn wrap_day(m: f32) -> f32 {
    m - libm::floorf(m / DAY_MINUTES) * DAY_MINUTES
}

fn norm3(v: &mut [f32; 3]) {
    let l = sqrtf(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if l > 1e-6 {
        v[0] /= l;
        v[1] /= l;
        v[2] /= l;
    }
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;

    #[test]
    fn midnight_is_dark_blue_night() {
        let e = sample(0.0);
        assert!(!e.is_day, "midnight is night");
        // Fog ≈ #2b3040.
        assert!((e.fog[2] - 0x40 as f32 / 255.0).abs() < 0.02, "blueish fog");
        assert!(e.scene_darken < 0.5, "dim at midnight");
    }

    #[test]
    fn noon_is_bright_desert() {
        let e = sample(720.0);
        assert!(e.is_day);
        assert!((e.scene_darken - 1.0).abs() < 1e-3, "peak brightness at noon");
        // Fog ≈ #c9ad82 (warm sand): red channel high.
        assert!(e.fog[0] > 0.7 && e.fog[0] > e.fog[2], "warm noon fog");
        assert!(e.sun_elevation01 > 0.98, "sun near zenith at noon");
    }

    #[test]
    fn sun_climbs_from_dawn_to_noon() {
        let dawn = sample(420.0);
        let noon = sample(720.0);
        assert!(noon.sun_elevation01 > dawn.sun_elevation01, "sun higher at noon");
        // Dawn light is warmer (more red vs blue) than noon.
        assert!(dawn.sun_color[0] - dawn.sun_color[2] >= noon.sun_color[0] - noon.sun_color[2]);
    }

    #[test]
    fn grade_interpolates_between_anchors() {
        // Halfway between 480 and 720 (=600) → fields between the two anchors.
        let g = sample_grade(600.0);
        assert!(g.scene_darken > 0.96 && g.scene_darken <= 1.0);
        assert!(g.fog[0] > 0.0);
    }

    #[test]
    fn wraps_across_midnight() {
        // 1350 sits between anchor 1260 and wrapped 0(=1440).
        let g = sample_grade(1350.0);
        // Between #333a52 and #2b3040 → dark.
        assert!(g.scene_darken < 0.45, "late night is dim, got {}", g.scene_darken);
    }

    #[test]
    fn sun_dir_points_downward_during_day() {
        let e = sample(600.0);
        assert!(e.sun_dir[1] < 0.0, "sunlight travels downward");
        let len = (e.sun_dir[0].powi(2) + e.sun_dir[1].powi(2) + e.sun_dir[2].powi(2)).sqrt();
        assert!((len - 1.0).abs() < 1e-4, "normalized");
    }
}
