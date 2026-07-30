//! Combat FX particle pool — a zero-per-frame-alloc port of
//! `client-3d/src/render/fx/particles.ts`.
//!
//! Three ring-buffered CPU layers (additive sparks/muzzle, normal-blend blood,
//! long-lived residue) integrate on the CPU exactly like the web client
//! (drag + gravity + a damped ground splat, with size/alpha/color lerped over
//! remaining-life fraction). Emitters push into the rings; `fill_billboards`
//! turns live particles into camera-facing quads for a textured, blended draw.
//! All storage is allocated once at construction; `push`/`step`/`fill` never
//! allocate.

use alloc::vec;
use alloc::vec::Vec;

/// Ground reference height (`FX_CONFIG.groundY`).
pub const GROUND_Y: f32 = 0.012;
/// Layer capacities (`FX_CONFIG.particles`).
pub const ADDITIVE_MAX: usize = 768;
pub const NORMAL_MAX: usize = 512;
pub const RESIDUE_MAX: usize = 192;
/// Muzzle flash drag (`FX_CONFIG.muzzle.flashDrag`).
pub const FLASH_DRAG: f32 = 3.8;

/// Deterministic xorshift RNG so emitter bursts are reproducible in tests.
#[derive(Clone, Copy, Debug)]
pub struct Rng(u32);
impl Rng {
    pub fn new(seed: u32) -> Self {
        Rng(seed.max(1))
    }
    #[inline]
    fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    /// Uniform in [0,1).
    #[inline]
    pub fn unit(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / (1u32 << 24) as f32
    }
    /// Uniform in [-1,1).
    #[inline]
    pub fn jit(&mut self) -> f32 {
        self.unit() * 2.0 - 1.0
    }
}

/// One blend layer: parallel arrays + a write cursor (ring buffer).
pub struct ParticleLayer {
    pub max: usize,
    drag: f32,
    // position (x,y,z) interleaved.
    pos: Vec<f32>,
    // current color (r,g,b) interleaved (lerped over life).
    col: Vec<f32>,
    alpha: Vec<f32>,
    size: Vec<f32>,
    vx: Vec<f32>,
    vy: Vec<f32>,
    vz: Vec<f32>,
    life: Vec<f32>,
    max_life: Vec<f32>,
    grav: Vec<f32>,
    s0: Vec<f32>,
    s1: Vec<f32>,
    a_peak: Vec<f32>,
    c0: Vec<f32>,
    c1: Vec<f32>,
    cursor: usize,
}

impl ParticleLayer {
    pub fn new(max: usize, drag: f32) -> Self {
        Self {
            max,
            drag,
            pos: vec![0.0; max * 3],
            col: vec![0.0; max * 3],
            alpha: vec![0.0; max],
            size: vec![0.0; max],
            vx: vec![0.0; max],
            vy: vec![0.0; max],
            vz: vec![0.0; max],
            life: vec![0.0; max],
            max_life: vec![0.0; max],
            grav: vec![0.0; max],
            s0: vec![0.0; max],
            s1: vec![0.0; max],
            a_peak: vec![0.0; max],
            c0: vec![0.0; max * 3],
            c1: vec![0.0; max * 3],
            cursor: 0,
        }
    }

    /// Count of currently-alive particles (life > 0).
    pub fn alive(&self) -> usize {
        self.life.iter().filter(|&&l| l > 0.0).count()
    }

    /// Push one particle into the ring (evicts the oldest slot at the cursor).
    #[allow(clippy::too_many_arguments)]
    pub fn push(
        &mut self,
        p: [f32; 3],
        v: [f32; 3],
        life: f32,
        s0: f32,
        s1: f32,
        a_peak: f32,
        grav: f32,
        c0: [f32; 3],
        c1: [f32; 3],
    ) {
        let i = self.cursor;
        self.cursor = (i + 1) % self.max;
        let i3 = i * 3;
        self.pos[i3] = p[0];
        self.pos[i3 + 1] = p[1];
        self.pos[i3 + 2] = p[2];
        self.vx[i] = v[0];
        self.vy[i] = v[1];
        self.vz[i] = v[2];
        self.life[i] = life;
        self.max_life[i] = life;
        self.grav[i] = grav;
        self.s0[i] = s0;
        self.s1[i] = s1;
        self.a_peak[i] = a_peak;
        self.c0[i3] = c0[0];
        self.c0[i3 + 1] = c0[1];
        self.c0[i3 + 2] = c0[2];
        self.c1[i3] = c1[0];
        self.c1[i3 + 1] = c1[1];
        self.c1[i3 + 2] = c1[2];
        // Prime render attributes so a just-pushed particle is visible pre-step.
        self.alpha[i] = a_peak;
        self.size[i] = s0;
        self.col[i3] = c0[0];
        self.col[i3 + 1] = c0[1];
        self.col[i3 + 2] = c0[2];
    }

    /// Integrate one timestep (drag + gravity + damped ground splat), updating
    /// per-particle size/alpha/color from the remaining-life fraction.
    pub fn step(&mut self, dt: f32, ground_y: f32) {
        let drag = self.drag;
        for i in 0..self.max {
            let life_i = self.life[i];
            if life_i <= 0.0 {
                continue;
            }
            let remaining = life_i - dt;
            self.life[i] = remaining;
            if remaining <= 0.0 {
                self.alpha[i] = 0.0;
                continue;
            }
            let i3 = i * 3;
            let (vx, vy, vz) = (self.vx[i], self.vy[i], self.vz[i]);
            self.pos[i3] += vx * dt;
            let mut ny = self.pos[i3 + 1] + vy * dt;
            self.pos[i3 + 2] += vz * dt;
            let mut nvy = vy - self.grav[i] * dt;
            if ny < ground_y {
                ny = ground_y;
                nvy *= -0.18;
                self.vx[i] = vx * 0.4;
                self.vz[i] = vz * 0.4;
            }
            self.pos[i3 + 1] = ny;
            self.vy[i] = nvy;
            let d = (1.0 - drag * dt).max(0.0);
            self.vx[i] *= d;
            self.vz[i] *= d;
            let frac = remaining / self.max_life[i]; // 1 -> 0
            self.size[i] = self.s1[i] + (self.s0[i] - self.s1[i]) * frac;
            self.alpha[i] = self.a_peak[i] * (frac * 1.6).min(1.0);
            self.col[i3] = self.c1[i3] + (self.c0[i3] - self.c1[i3]) * frac;
            self.col[i3 + 1] = self.c1[i3 + 1] + (self.c0[i3 + 1] - self.c1[i3 + 1]) * frac;
            self.col[i3 + 2] = self.c1[i3 + 2] + (self.c0[i3 + 2] - self.c1[i3 + 2]) * frac;
        }
    }

    /// Append camera-facing quads (`pos:3, uv:2, color:4`) for live particles.
    /// `right`/`up` are the camera basis vectors (world space). Returns the
    /// number of quads appended.
    pub fn fill_billboards(&self, right: [f32; 3], up: [f32; 3], out: &mut Vec<f32>) -> u32 {
        let mut quads = 0u32;
        for i in 0..self.max {
            if self.life[i] <= 0.0 || self.alpha[i] <= 0.003 {
                continue;
            }
            let i3 = i * 3;
            let (cx, cy, cz) = (self.pos[i3], self.pos[i3 + 1], self.pos[i3 + 2]);
            let hs = self.size[i] * 0.5;
            let (r, g, b, a) = (self.col[i3], self.col[i3 + 1], self.col[i3 + 2], self.alpha[i]);
            let rx = right[0] * hs;
            let ry = right[1] * hs;
            let rz = right[2] * hs;
            let ux = up[0] * hs;
            let uy = up[1] * hs;
            let uz = up[2] * hs;
            // Corners: bl, br, tr, tl.
            let bl = [cx - rx - ux, cy - ry - uy, cz - rz - uz];
            let br = [cx + rx - ux, cy + ry - uy, cz + rz - uz];
            let tr = [cx + rx + ux, cy + ry + uy, cz + rz + uz];
            let tl = [cx - rx + ux, cy - ry + uy, cz - rz + uz];
            let mut v = |p: [f32; 3], u: f32, w: f32| {
                out.extend_from_slice(&[p[0], p[1], p[2], u, w, r, g, b, a]);
            };
            v(bl, 0.0, 0.0);
            v(br, 1.0, 0.0);
            v(tr, 1.0, 1.0);
            v(bl, 0.0, 0.0);
            v(tr, 1.0, 1.0);
            v(tl, 0.0, 1.0);
            quads += 1;
        }
        quads
    }
}

/// The three-layer combat particle system.
pub struct ParticlePool {
    pub additive: ParticleLayer,
    pub normal: ParticleLayer,
    pub residue: ParticleLayer,
    rng: Rng,
}

impl ParticlePool {
    pub fn new(seed: u32) -> Self {
        Self {
            additive: ParticleLayer::new(ADDITIVE_MAX, FLASH_DRAG),
            normal: ParticleLayer::new(NORMAL_MAX, 1.2),
            residue: ParticleLayer::new(RESIDUE_MAX, 0.0),
            rng: Rng::new(seed),
        }
    }

    pub fn update(&mut self, dt: f32) {
        if dt <= 0.0 {
            return;
        }
        self.additive.step(dt, GROUND_Y);
        self.normal.step(dt, GROUND_Y);
        self.residue.step(dt, GROUND_Y);
    }

    pub fn alive(&self) -> usize {
        self.additive.alive() + self.normal.alive() + self.residue.alive()
    }

    /// Ricochet spark burst (additive) — port of `emitSparkBurst`.
    pub fn emit_spark_burst(&mut self, point: [f32; 3], normal: [f32; 3], incoming: [f32; 3], mag: f32) {
        let sm = 0.84 + 0.16 * mag;
        let vm = 0.84 + 0.16 * mag;
        let cnt = |base: f32| (libm::roundf(base * mag) as i32).max(1);
        // reflect incoming about normal
        let dn = incoming[0] * normal[0] + incoming[1] * normal[1] + incoming[2] * normal[2];
        let r = [
            incoming[0] - 2.0 * dn * normal[0],
            incoming[1] - 2.0 * dn * normal[1],
            incoming[2] - 2.0 * dn * normal[2],
        ];
        let base = [r[0] * 0.7 + normal[0] * 0.4, r[1] * 0.7 + normal[1] * 0.4, r[2] * 0.7 + normal[2] * 0.4];
        let streaks = cnt(6.0);
        for _ in 0..streaks {
            let mut e = [base[0] + self.rng.jit() * 0.7, base[1] + self.rng.jit() * 0.7 + 0.15, base[2] + self.rng.jit() * 0.7];
            normalize3(&mut e);
            let sp = (2.6 + self.rng.unit() * 4.5) * vm;
            let life = 0.16 + self.rng.unit() * 0.3;
            let sz = (0.013 + self.rng.unit() * 0.022) * sm;
            self.additive.push(point, [e[0] * sp, e[1] * sp, e[2] * sp], life, sz, sz * 0.2, 1.0, 9.5,
                [1.0, 0.95, 0.62], [1.0, 0.32, 0.06]);
        }
        let flashes = cnt(3.0);
        for _ in 0..flashes {
            let mut e = [normal[0] + self.rng.jit() * 0.5, normal[1] + self.rng.jit() * 0.5, normal[2] + self.rng.jit() * 0.5];
            normalize3(&mut e);
            let life = 0.05 + self.rng.unit() * 0.05;
            let sz = (0.05 + self.rng.unit() * 0.035) * sm;
            self.additive.push(point, [e[0] * 0.6, e[1] * 0.6, e[2] * 0.6], life, sz, sz * 0.4, 1.0, 0.0,
                [1.0, 0.92, 0.7], [1.0, 0.6, 0.3]);
        }
    }

    /// Blood droplet burst (normal blend) — port of `emitBloodBurst` (red).
    pub fn emit_blood_burst(&mut self, point: [f32; 3], incoming: [f32; 3], mag: f32) {
        let droplets = libm::roundf(10.0 * mag).max(6.0) as i32;
        let spray = [0.62, 0.05, 0.06];
        let drip = [0.40, 0.02, 0.03];
        for _ in 0..droplets {
            let mut e = [
                incoming[0] * 0.7 + self.rng.jit() * 0.6,
                self.rng.unit() * 0.5 + 0.2,
                incoming[2] * 0.7 + self.rng.jit() * 0.6,
            ];
            normalize3(&mut e);
            let sp = (1.4 + self.rng.unit() * 2.2) * (0.9 + 0.1 * mag);
            let life = 0.3 + self.rng.unit() * 0.5;
            let sz = 0.03 + self.rng.unit() * 0.03;
            self.normal.push(point, [e[0] * sp, e[1] * sp, e[2] * sp], life, sz, sz * 0.6, 0.95, 6.5,
                spray, drip);
        }
    }

    /// Muzzle flash (additive) — port of `MuzzleFx.flash`: a fat core pop at the
    /// barrel lip, a forward cone of hot streaks, and a few drifting embers.
    /// `color` is linear rgb (default warm). The web client's budgeted point
    /// light is a forward-compat no-op (pawn materials are unlit).
    pub fn emit_muzzle_flash(&mut self, point: [f32; 3], dir: [f32; 3], mag: f32, color: [f32; 3]) {
        let mut d = dir;
        normalize3(&mut d);
        let (u, w) = basis_perp(d);
        let [r, g, b] = color;
        let cnt = |base: f32| (libm::roundf(base * mag) as i32).max(1);
        // 1) core pop
        for _ in 0..cnt(1.0) {
            let sz = (0.05 + self.rng.unit() * 0.03) * (0.8 + 0.2 * mag);
            self.additive.push(
                [point[0] + d[0] * 0.02, point[1] + d[1] * 0.02, point[2] + d[2] * 0.02],
                [d[0] * 0.6, d[1] * 0.6, d[2] * 0.6],
                0.045 + self.rng.unit() * 0.03, sz, sz * 0.35, 1.0, 0.0,
                [(r + 0.2).min(1.0), (g + 0.2).min(1.0), (b + 0.2).min(1.0)],
                [r * 0.8, g * 0.6, b * 0.6],
            );
        }
        // 2) forward cone of hot streaks
        for _ in 0..cnt(6.0) {
            let ca = self.rng.unit() * core::f32::consts::TAU;
            let spread = 0.26 + self.rng.unit() * 0.2;
            let (cc, ss) = (libm::cosf(ca) * spread, libm::sinf(ca) * spread);
            let mut t = [
                d[0] + u[0] * cc + w[0] * ss,
                d[1] + u[1] * cc + w[1] * ss,
                d[2] + u[2] * cc + w[2] * ss,
            ];
            normalize3(&mut t);
            let sp = (5.5 + self.rng.unit() * 7.0) * (0.85 + 0.15 * mag);
            let life = 0.05 + self.rng.unit() * 0.1;
            let sz = (0.022 + self.rng.unit() * 0.028) * (0.85 + 0.15 * mag);
            self.additive.push(point, [t[0] * sp, t[1] * sp, t[2] * sp], life, sz, sz * 0.18, 1.0, 6.0,
                [r, g, b], [r * 0.5, g * 0.3, b * 0.3]);
        }
        // 3) lazy embers
        for _ in 0..cnt(2.0) {
            let ju = self.rng.jit() * 0.5;
            let jw = self.rng.jit() * 0.5 + 0.1;
            let mut t = [d[0] + u[0] * ju + w[0] * jw, d[1] + u[1] * ju + w[1] * jw, d[2] + u[2] * ju + w[2] * jw];
            normalize3(&mut t);
            let sp = 0.8 + self.rng.unit() * 1.8;
            let sz = 0.02 + self.rng.unit() * 0.02;
            self.additive.push(point, [t[0] * sp, t[1] * sp, t[2] * sp],
                0.18 + self.rng.unit() * 0.22, sz, sz * 0.4, 0.9, 7.0,
                [r * 0.8, g * 0.6, b * 0.4], [r * 0.3, g * 0.1, b * 0.05]);
        }
    }

    /// Tracer streak (additive): lay a line of short-lived hot points from
    /// `from` (muzzle) to `to` (impact). A pragmatic stand-in for the web
    /// client's pooled cylinder+head tracer that reuses the particle layer.
    pub fn emit_tracer(&mut self, from: [f32; 3], to: [f32; 3], mag: f32) {
        let seg = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
        let len = libm::sqrtf(seg[0] * seg[0] + seg[1] * seg[1] + seg[2] * seg[2]);
        if len < 1e-4 {
            return;
        }
        let steps = ((len / 0.18) as i32).clamp(2, 64);
        let sz = (0.026 + 0.004 * mag).max(0.02);
        for k in 0..=steps {
            let f = k as f32 / steps as f32;
            let p = [from[0] + seg[0] * f, from[1] + seg[1] * f, from[2] + seg[2] * f];
            self.additive.push(p, [0.0, 0.0, 0.0], 0.08 + self.rng.unit() * 0.04, sz, sz * 0.4, 0.9, 0.0,
                [1.0, 0.89, 0.60], [1.0, 0.60, 0.20]);
        }
    }
}

/// Procedural soft radial glow sprite (RGBA8, `size`×`size`) — the shared point
/// texture (`makeGlowSprite`): white core fading to transparent edge.
pub fn glow_sprite(size: usize) -> Vec<u8> {
    let mut out = vec![0u8; size * size * 4];
    let half = size as f32 / 2.0;
    for y in 0..size {
        for x in 0..size {
            let dx = (x as f32 + 0.5) - half;
            let dy = (y as f32 + 0.5) - half;
            let r = libm::sqrtf(dx * dx + dy * dy) / half; // 0..~1
            // Piecewise gradient matching the canvas stops.
            let a: f32 = if r >= 1.0 {
                0.0
            } else if r <= 0.3 {
                1.0 - (1.0 - 0.95) * (r / 0.3)
            } else if r <= 0.65 {
                0.95 + (0.35 - 0.95) * ((r - 0.3) / 0.35)
            } else {
                0.35 + (0.0 - 0.35) * ((r - 0.65) / 0.35)
            };
            let i = (y * size + x) * 4;
            out[i] = 255;
            out[i + 1] = 255;
            out[i + 2] = 255;
            out[i + 3] = (a.clamp(0.0, 1.0) * 255.0) as u8;
        }
    }
    out
}

fn normalize3(v: &mut [f32; 3]) {
    let len = libm::sqrtf(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
    if len > 1e-6 {
        v[0] /= len;
        v[1] /= len;
        v[2] /= len;
    }
}

/// Orthonormal pair spanning the plane perpendicular to `dir` (port of
/// `MuzzleFx.basisPerp`).
fn basis_perp(dir: [f32; 3]) -> ([f32; 3], [f32; 3]) {
    let mut helper = [0.0, 1.0, 0.0];
    if (dir[0] * helper[0] + dir[1] * helper[1] + dir[2] * helper[2]).abs() > 0.92 {
        helper = [1.0, 0.0, 0.0];
    }
    let mut u = cross(dir, helper);
    normalize3(&mut u);
    let mut w = cross(dir, u);
    normalize3(&mut w);
    (u, w)
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;

    #[test]
    fn push_makes_particle_alive_then_expires() {
        let mut l = ParticleLayer::new(16, 1.0);
        l.push([0.0, 1.0, 0.0], [0.0, 0.0, 0.0], 0.10, 0.05, 0.0, 1.0, 0.0, [1.0, 1.0, 1.0], [0.0, 0.0, 0.0]);
        assert_eq!(l.alive(), 1);
        l.step(0.05, GROUND_Y);
        assert_eq!(l.alive(), 1, "still alive at half life");
        l.step(0.06, GROUND_Y); // total 0.11 > 0.10
        assert_eq!(l.alive(), 0, "expired");
    }

    #[test]
    fn ring_buffer_evicts_oldest_and_never_grows() {
        let mut l = ParticleLayer::new(4, 0.0);
        for _ in 0..10 {
            l.push([0.0, 1.0, 0.0], [0.0, 0.0, 0.0], 1.0, 0.05, 0.0, 1.0, 0.0, [1.0; 3], [0.0; 3]);
        }
        assert!(l.alive() <= 4, "capacity bounded to max");
        assert_eq!(l.pos.len(), 4 * 3, "storage fixed");
    }

    #[test]
    fn gravity_pulls_down_and_ground_splats() {
        let mut l = ParticleLayer::new(4, 0.0);
        // Start just above ground, moving down, heavy gravity.
        l.push([0.0, GROUND_Y + 0.01, 0.0], [0.0, -1.0, 0.0], 1.0, 0.05, 0.05, 1.0, 20.0, [1.0; 3], [1.0; 3]);
        l.step(0.1, GROUND_Y);
        // Clamped to ground and vy reflected (damped).
        assert!(l.pos[1] >= GROUND_Y - 1e-4, "settled at/above ground: {}", l.pos[1]);
    }

    #[test]
    fn size_and_alpha_lerp_over_life() {
        let mut l = ParticleLayer::new(4, 0.0);
        l.push([0.0, 1.0, 0.0], [0.0, 0.0, 0.0], 1.0, 0.10, 0.02, 1.0, 0.0, [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]);
        l.step(0.5, GROUND_Y); // frac ~ 0.5
        assert!(l.size[0] > 0.02 && l.size[0] < 0.10, "size between s1 and s0");
        // color lerps from c1(blue) toward c0(red) as frac->1; at 0.5 mixed.
        assert!(l.col[0] > 0.4 && l.col[0] < 0.6, "red channel ~0.5, got {}", l.col[0]);
    }

    #[test]
    fn spark_burst_emits_additive_and_is_deterministic() {
        let mut a = ParticlePool::new(1234);
        a.emit_spark_burst([0.0, 1.0, 0.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0], 1.0);
        let n = a.additive.alive();
        assert!(n > 0, "sparks emitted");
        let mut b = ParticlePool::new(1234);
        b.emit_spark_burst([0.0, 1.0, 0.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0], 1.0);
        assert_eq!(a.additive.alive(), b.additive.alive(), "deterministic with same seed");
    }

    #[test]
    fn billboards_emit_six_verts_per_alive_particle() {
        let mut l = ParticleLayer::new(8, 0.0);
        l.push([0.0, 1.0, 0.0], [0.0, 0.0, 0.0], 1.0, 0.1, 0.1, 1.0, 0.0, [1.0; 3], [1.0; 3]);
        l.step(0.01, GROUND_Y);
        let mut out = Vec::new();
        let q = l.fill_billboards([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], &mut out);
        assert_eq!(q, 1);
        assert_eq!(out.len(), 6 * 9, "6 verts * 9 floats (pos3+uv2+color4)");
    }

    #[test]
    fn glow_sprite_center_opaque_edge_transparent() {
        let s = glow_sprite(64);
        let center = s[(32 * 64 + 32) * 4 + 3];
        let corner = s[3]; // (0,0)
        assert!(center > 200, "center bright");
        assert_eq!(corner, 0, "corner transparent");
    }

    #[test]
    fn muzzle_flash_emits_additive_core_cone_embers() {
        let mut p = ParticlePool::new(99);
        p.emit_muzzle_flash([0.0, 1.3, 0.0], [1.0, 0.0, 0.0], 1.0, [1.0, 0.7, 0.3]);
        // core(>=1) + cone(6) + embers(2) at mag 1.
        assert!(p.additive.alive() >= 8, "flash particles emitted, got {}", p.additive.alive());
    }

    #[test]
    fn tracer_lays_a_line_of_points() {
        let mut p = ParticlePool::new(7);
        p.emit_tracer([0.0, 1.0, 0.0], [3.6, 1.0, 0.0], 1.0);
        // length 3.6 / 0.18 = 20 steps + 1.
        assert!(p.additive.alive() >= 20, "tracer points laid, got {}", p.additive.alive());
    }

    #[test]
    fn basis_perp_is_orthonormal() {
        let d = [0.0, 1.0, 0.0];
        let (u, w) = basis_perp(d);
        let dot = |a: [f32; 3], b: [f32; 3]| a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        assert!(dot(u, d).abs() < 1e-5, "u ⟂ dir");
        assert!(dot(w, d).abs() < 1e-5, "w ⟂ dir");
        assert!(dot(u, w).abs() < 1e-5, "u ⟂ w");
        assert!((dot(u, u) - 1.0).abs() < 1e-4, "u unit");
    }
}
