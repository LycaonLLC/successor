//! Procedural mesh builders. Vertex format matches `gpu::MESH_LAYOUT`:
//! interleaved `pos:3, normal:3, uv:2` (8 floats/vertex). Returns
//! `(vertices, indices)` for indexed drawing.

use alloc::vec::Vec;
use libm::{cosf, sinf};

pub type Mesh = (Vec<f32>, Vec<u32>);

fn push_v(v: &mut Vec<f32>, p: [f32; 3], n: [f32; 3], uv: [f32; 2]) {
    v.extend_from_slice(&[p[0], p[1], p[2], n[0], n[1], n[2], uv[0], uv[1]]);
}

/// Unit cube centered at the origin (edge length 1), per-face normals.
pub fn cube() -> Mesh {
    let mut v = Vec::with_capacity(24 * 8);
    let mut idx = Vec::with_capacity(36);
    // (normal, u-axis, v-axis) for each of the 6 faces.
    let faces: [([f32; 3], [f32; 3], [f32; 3]); 6] = [
        ([0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),   // +Z
        ([0.0, 0.0, -1.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0]), // -Z
        ([1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]),  // +X
        ([-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),  // -X
        ([0.0, 1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, -1.0]),  // +Y
        ([0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),  // -Y
    ];
    for (n, uax, vax) in faces {
        let base = (v.len() / 8) as u32;
        for (su, sv, uv) in [
            (-0.5, -0.5, [0.0, 0.0]),
            (0.5, -0.5, [1.0, 0.0]),
            (0.5, 0.5, [1.0, 1.0]),
            (-0.5, 0.5, [0.0, 1.0]),
        ] {
            let p = [
                n[0] * 0.5 + uax[0] * su + vax[0] * sv,
                n[1] * 0.5 + uax[1] * su + vax[1] * sv,
                n[2] * 0.5 + uax[2] * su + vax[2] * sv,
            ];
            push_v(&mut v, p, n, uv);
        }
        idx.extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
    (v, idx)
}

/// Flat plane on the XZ ground plane (y=0), centered, `size` on a side, normal +Y.
pub fn plane(size: f32) -> Mesh {
    let h = size * 0.5;
    let n = [0.0, 1.0, 0.0];
    let mut v = Vec::with_capacity(4 * 8);
    push_v(&mut v, [-h, 0.0, -h], n, [0.0, 0.0]);
    push_v(&mut v, [h, 0.0, -h], n, [1.0, 0.0]);
    push_v(&mut v, [h, 0.0, h], n, [1.0, 1.0]);
    push_v(&mut v, [-h, 0.0, h], n, [0.0, 1.0]);
    (v, alloc::vec![0, 1, 2, 0, 2, 3])
}

/// Capsule along +Y: two hemispheres of `radius` joined by a cylinder so the
/// total height is `height`. `segments` = longitude divisions; `rings` = per
/// hemisphere latitude divisions.
pub fn capsule(radius: f32, height: f32, segments: u32, rings: u32) -> Mesh {
    let seg = segments.max(3);
    let rings = rings.max(1);
    let cyl_half = ((height - 2.0 * radius) * 0.5).max(0.0);
    let mut v: Vec<f32> = Vec::new();
    let mut idx: Vec<u32> = Vec::new();
    let two_pi = core::f32::consts::PI * 2.0;
    let half_pi = core::f32::consts::FRAC_PI_2;

    // Build latitude rings from bottom (-Y) to top (+Y).
    // Bottom hemisphere latitudes: -pi/2 .. 0 ; top hemisphere: 0 .. pi/2.
    let mut ring_rows: Vec<(f32, f32)> = Vec::new(); // (y_center_offset, lat)
    for i in 0..=rings {
        let lat = -half_pi + (i as f32 / rings as f32) * half_pi; // bottom cap
        ring_rows.push((-cyl_half, lat));
    }
    for i in 0..=rings {
        let lat = (i as f32 / rings as f32) * half_pi; // top cap
        ring_rows.push((cyl_half, lat));
    }

    let cols = seg + 1;
    for (y_off, lat) in &ring_rows {
        let cy = sinf(*lat) * radius + *y_off;
        let cr = cosf(*lat) * radius;
        for j in 0..cols {
            let lon = (j as f32 / seg as f32) * two_pi;
            let x = cosf(lon) * cr;
            let z = sinf(lon) * cr;
            // Normal points radially from the capsule axis segment.
            let nx = cosf(lon) * cosf(*lat);
            let ny = sinf(*lat);
            let nz = sinf(lon) * cosf(*lat);
            push_v(
                &mut v,
                [x, cy, z],
                [nx, ny, nz],
                [j as f32 / seg as f32, (cy + height) / (2.0 * height)],
            );
        }
    }

    let rows = ring_rows.len() as u32;
    for r in 0..rows - 1 {
        for c in 0..seg {
            let a = r * cols + c;
            let b = (r + 1) * cols + c;
            idx.extend_from_slice(&[a, b, a + 1, a + 1, b, b + 1]);
        }
    }
    (v, idx)
}

/// A full-screen (or sub-rect) textured quad in NDC. Format: `pos:2, uv:2`
/// (`gpu::QUAD_LAYOUT`). `rect` is in NDC [-1,1].
pub fn ndc_quad(x0: f32, y0: f32, x1: f32, y1: f32) -> Mesh {
    let mut v = Vec::with_capacity(4 * 4);
    v.extend_from_slice(&[x0, y0, 0.0, 0.0]);
    v.extend_from_slice(&[x1, y0, 1.0, 0.0]);
    v.extend_from_slice(&[x1, y1, 1.0, 1.0]);
    v.extend_from_slice(&[x0, y1, 0.0, 1.0]);
    (v, alloc::vec![0, 1, 2, 0, 2, 3])
}
