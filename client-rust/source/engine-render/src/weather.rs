//! Presentation weather system (rain / dust / storm) that drives the particle pool.

use libm::{cosf, sinf};
use crate::fx::ParticlePool;

/// Deterministic xorshift RNG for weather particle emission.
#[derive(Clone, Copy, Debug)]
pub struct Rng(u32);

impl Rng {
    pub fn new(seed: u32) -> Self {
        Rng(seed.max(1))
    }

    #[inline]
    pub fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }

    /// Uniform in [0.0, 1.0).
    #[inline]
    pub fn unit(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / (1u32 << 24) as f32
    }

    /// Uniform in [-1.0, 1.0).
    #[inline]
    pub fn jit(&mut self) -> f32 {
        self.unit() * 2.0 - 1.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum WeatherKind {
    Clear,
    Rain,
    DustStorm,
}

pub struct Weather {
    kind: WeatherKind,
    intensity: f32,
    current: f32,
    wind: [f32; 2],
    time: f32,
    rng: Rng,
}

impl Weather {
    pub fn new(seed: u32) -> Self {
        let mut w = Self {
            kind: WeatherKind::Clear,
            intensity: 0.0,
            current: 0.0,
            wind: [0.0, 0.0],
            time: 0.0,
            rng: Rng::new(seed),
        };
        w.update_wind();
        w
    }

    pub fn set(&mut self, kind: WeatherKind, intensity: f32) {
        self.kind = kind;
        self.intensity = intensity.max(0.0).min(1.0);
    }

    pub fn update(&mut self, dt: f32) {
        if dt <= 0.0 {
            return;
        }

        // Easing current toward intensity at fixed rate 1.35
        let diff = self.intensity - self.current;
        if diff.abs() > 1e-5 {
            let sign = if diff > 0.0 { 1.0 } else { -1.0 };
            let step = sign * 1.35 * dt;
            if diff.abs() <= step.abs() {
                self.current = self.intensity;
            } else {
                self.current += step;
            }
        } else {
            self.current = self.intensity;
        }

        // Advance time
        self.time += dt;
        self.update_wind();
    }

    fn update_wind(&mut self) {
        let t = self.time;
        let pi = core::f32::consts::PI;
        let wander = sinf((t * pi * 2.0) / 210.0 + 0.8 * sinf(t * 0.011));
        let dir_deg = 115.0 + wander * 40.0;
        let dir_rad = dir_deg * pi / 180.0;
        let dir_x = cosf(dir_rad);
        let dir_z = sinf(dir_rad);
        let gust_phase = (t * pi * 2.0) / 7.5;
        let gust01 = (0.5 + 0.55 * sinf(gust_phase) + 0.25 * sinf(gust_phase * 2.7 + 1.3)).max(0.0).min(1.0);
        let strength01 = (0.3 + gust01 * 0.45).max(0.0).min(1.0);
        self.wind = [dir_x * strength01, dir_z * strength01];
    }

    pub fn emit_into(&mut self, pool: &mut ParticlePool, listener: [f32; 3], area: f32) {
        if self.current <= 0.0 {
            return;
        }

        match self.kind {
            WeatherKind::Clear => {}
            WeatherKind::Rain => {
                const RAIN_BASE_COUNT: f32 = 20.0;
                let count = (self.current * RAIN_BASE_COUNT) as usize;
                for _ in 0..count {
                    // Spawn rain streaks (fast downward, into normal layer)
                    let p = [
                        listener[0] + self.rng.jit() * area,
                        listener[1] + 10.0 + self.rng.unit() * 5.0,
                        listener[2] + self.rng.jit() * area,
                    ];
                    let v = [
                        self.wind[0] * 2.0,
                        -12.0 - self.rng.unit() * 4.0,
                        self.wind[1] * 2.0,
                    ];
                    let life = 0.5 + self.rng.unit() * 0.3;
                    let sz = 0.02 + self.rng.unit() * 0.01;
                    let s0 = sz;
                    let s1 = sz * 0.5;
                    let a_peak = 0.6;
                    let grav = 0.0;
                    let c0 = [0.7, 0.75, 0.8];
                    let c1 = [0.6, 0.65, 0.7];

                    pool.normal.push(p, v, life, s0, s1, a_peak, grav, c0, c1);
                }
            }
            WeatherKind::DustStorm => {
                const DUST_BASE_COUNT: f32 = 30.0;
                let count = (self.current * DUST_BASE_COUNT) as usize;
                for i in 0..count {
                    // Spawn dust motes (slow wind-drift, additive/normal)
                    let p = [
                        listener[0] + self.rng.jit() * area,
                        listener[1] + self.rng.unit() * 6.0,
                        listener[2] + self.rng.jit() * area,
                    ];
                    let v = [
                        self.wind[0] * 1.5 + self.rng.jit() * 0.2,
                        self.rng.jit() * 0.1,
                        self.wind[1] * 1.5 + self.rng.jit() * 0.2,
                    ];
                    let life = 2.0 + self.rng.unit() * 1.5;
                    let sz = 0.05 + self.rng.unit() * 0.05;
                    let s0 = sz;
                    let s1 = sz * 0.8;
                    let a_peak = 0.4;
                    let grav = 0.0;
                    let c0 = [0.8, 0.7, 0.5];
                    let c1 = [0.7, 0.6, 0.4];

                    // Alternate/split between normal and additive layers
                    if i % 2 == 0 {
                        pool.normal.push(p, v, life, s0, s1, a_peak, grav, c0, c1);
                    } else {
                        pool.additive.push(p, v, life, s0, s1, a_peak, grav, c0, c1);
                    }
                }
            }
        }
    }

    pub fn current_intensity(&self) -> f32 {
        self.current
    }

    pub fn wind(&self) -> [f32; 2] {
        self.wind
    }
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;

    #[test]
    fn test_update_eases_current() {
        let mut weather = Weather::new(42);
        assert_eq!(weather.current_intensity(), 0.0);

        weather.set(WeatherKind::Rain, 0.8);
        assert_eq!(weather.current_intensity(), 0.0);

        // Update several times, check monotonicity
        let mut last_current = 0.0;
        for _ in 0..5 {
            weather.update(0.1);
            let cur = weather.current_intensity();
            assert!(cur > last_current, "Must be monotonic increasing");
            assert!(cur <= 0.8, "Must not exceed target");
            last_current = cur;
        }

        // Run long enough to fully reach target
        weather.update(1.0);
        assert_eq!(weather.current_intensity(), 0.8);

        // Ease back down to 0.3
        weather.set(WeatherKind::Rain, 0.3);
        weather.update(0.1);
        assert!(weather.current_intensity() < 0.8);
        assert!(weather.current_intensity() >= 0.3);

        weather.update(1.0);
        assert_eq!(weather.current_intensity(), 0.3);
    }

    #[test]
    fn test_emit_into_grows_and_clear_none() {
        let mut weather = Weather::new(12345);
        let mut pool = ParticlePool::new(999);

        // Initial Clear at 0 intensity
        weather.emit_into(&mut pool, [0.0, 0.0, 0.0], 10.0);
        assert_eq!(pool.normal.alive(), 0);
        assert_eq!(pool.additive.alive(), 0);

        // Set Rain and ease to intensity 1.0
        weather.set(WeatherKind::Rain, 1.0);
        weather.update(1.0);
        assert_eq!(weather.current_intensity(), 1.0);

        weather.emit_into(&mut pool, [0.0, 0.0, 0.0], 10.0);
        assert!(pool.normal.alive() > 0, "Rain must push particles");

        // Clear weather shouldn't push any
        let mut pool2 = ParticlePool::new(999);
        let mut weather_clear = Weather::new(12345);
        weather_clear.set(WeatherKind::Clear, 1.0);
        weather_clear.update(1.0);
        weather_clear.emit_into(&mut pool2, [0.0, 0.0, 0.0], 10.0);
        assert_eq!(pool2.normal.alive(), 0);
        assert_eq!(pool2.additive.alive(), 0);
    }

    #[test]
    fn test_emission_scales_with_intensity() {
        let mut weather1 = Weather::new(777);
        let mut pool1 = ParticlePool::new(111);
        weather1.set(WeatherKind::Rain, 0.3);
        weather1.update(1.0);
        weather1.emit_into(&mut pool1, [0.0, 0.0, 0.0], 10.0);
        let count_0_3 = pool1.normal.alive();

        let mut weather2 = Weather::new(777);
        let mut pool2 = ParticlePool::new(111);
        weather2.set(WeatherKind::Rain, 1.0);
        weather2.update(1.0);
        weather2.emit_into(&mut pool2, [0.0, 0.0, 0.0], 10.0);
        let count_1_0 = pool2.normal.alive();

        assert!(count_1_0 > count_0_3, "Emission must scale with intensity: 1.0 count ({}) > 0.3 count ({})", count_1_0, count_0_3);
    }

    #[test]
    fn test_wind_bounds_and_determinism() {
        let mut weather1 = Weather::new(101);
        let mut weather2 = Weather::new(101);

        for _ in 0..100 {
            weather1.update(1.5);
            weather2.update(1.5);

            let w1 = weather1.wind();
            let w2 = weather2.wind();

            // Determinism
            assert_eq!(w1, w2);

            // Magnitude bounds
            let mag = libm::sqrtf(w1[0] * w1[0] + w1[1] * w1[1]);
            assert!(mag >= 0.299, "Wind strength must be >= 0.3, got {}", mag);
            assert!(mag <= 0.751, "Wind strength must be <= 0.75, got {}", mag);

            // Direction bounds (deg in [43, 187])
            let dir_rad = libm::atan2f(w1[1], w1[0]);
            let mut dir_deg = dir_rad * 180.0 / core::f32::consts::PI;
            if dir_deg < 0.0 {
                dir_deg += 360.0;
            }
            assert!(dir_deg >= 42.9 && dir_deg <= 187.1, "Wind direction degrees out of bounds: {}", dir_deg);
        }
    }
}
