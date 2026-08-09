//! Remote-actor position interpolation — port of `actorInterpolationSamples` /
//! `shouldResetRemoteActorInterpolation` from `gameAuthoritySystem.ts`. Each
//! remote actor keeps a short ring of timestamped authority samples; the render
//! position is the buffered interpolation at `now - delay`, smoothing the
//! 10–20 Hz authority stream into per-frame motion. A large jump (teleport /
//! lifecycle change) resets the buffer so we snap instead of sliding across the
//! map.

use std::collections::VecDeque;

const SAMPLE_LIMIT: usize = 12;
const RESET_CELLS: f32 = 12.0;

#[derive(Clone, Copy)]
struct Sample {
    t: f32,
    x: f32,
    y: f32,
}

#[derive(Default)]
pub struct ActorInterp {
    samples: VecDeque<Sample>,
    last_seq: i64,
    interval_ema: f32,
}

impl ActorInterp {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record an authority sample at wall-time `t`. A position jump beyond
    /// `RESET_CELLS`, or a `lifecycle_seq` change, clears the buffer (snap).
    pub fn push(&mut self, t: f32, x: f32, y: f32, lifecycle_seq: i64) {
        let reset = lifecycle_seq != self.last_seq
            || self
                .samples
                .back()
                .map(|s| ((x - s.x).powi(2) + (y - s.y).powi(2)).sqrt() > RESET_CELLS)
                .unwrap_or(false);
        if let Some(previous) = self.samples.back() {
            let interval = t - previous.t;
            if interval > 0.0 && interval <= 1.0 {
                self.interval_ema = if self.interval_ema > 0.0 {
                    self.interval_ema * 0.8 + interval * 0.2
                } else {
                    interval
                };
            }
        }
        self.last_seq = lifecycle_seq;
        if reset {
            self.samples.clear();
        }
        self.samples.push_back(Sample { t, x, y });
        while self.samples.len() > SAMPLE_LIMIT {
            self.samples.pop_front();
        }
    }

    /// Interpolated render position at wall-time `now`. Delay follows observed
    /// packet cadence so jitter remains bracketed without adding fixed latency.
    pub fn sample(&self, now: f32) -> Option<(f32, f32)> {
        let newest = *self.samples.back()?;
        let front = *self.samples.front()?;
        let delay = (self.interval_ema.max(1.0 / 30.0) * 1.5).clamp(0.05, 0.25);
        let target = now - delay;
        if target <= front.t {
            return Some((front.x, front.y));
        }
        if target >= newest.t {
            return Some((newest.x, newest.y));
        }
        for i in 0..self.samples.len() - 1 {
            let a = self.samples[i];
            let b = self.samples[i + 1];
            if a.t <= target && target <= b.t {
                return Some(lerp_pair(a, b, target));
            }
        }
        Some((newest.x, newest.y))
    }

    pub fn len(&self) -> usize {
        self.samples.len()
    }

    pub fn is_empty(&self) -> bool {
        self.samples.is_empty()
    }
}

fn lerp_pair(a: Sample, b: Sample, t: f32) -> (f32, f32) {
    let span = b.t - a.t;
    let f = if span > 1e-6 { (t - a.t) / span } else { 0.0 };
    (a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpolates_between_samples_at_observed_cadence() {
        let mut it = ActorInterp::new();
        it.push(0.0, 0.0, 0.0, 1);
        it.push(0.1, 10.0, 0.0, 1);
        // 100 ms cadence buffers 150 ms. At now=200 ms the target is 50 ms.
        let (x, _) = it.sample(0.2).unwrap();
        assert!((x - 5.0).abs() < 1e-3, "got {x}");
    }

    #[test]
    fn interpolation_delay_adapts_to_packet_cadence() {
        let mut fast = ActorInterp::new();
        fast.push(0.0, 0.0, 0.0, 1);
        fast.push(0.05, 1.0, 0.0, 1);
        let mut slow = ActorInterp::new();
        slow.push(0.0, 0.0, 0.0, 1);
        slow.push(0.2, 1.0, 0.0, 1);

        // At the same wall-clock offset after the newest packet, the fast
        // stream has advanced farther because it needs less jitter buffering.
        let fast_x = fast.sample(0.25).unwrap().0;
        let slow_x = slow.sample(0.4).unwrap().0;
        assert!(fast_x > slow_x, "fast={fast_x} slow={slow_x}");
    }

    #[test]
    fn clamps_to_ends() {
        let mut it = ActorInterp::new();
        it.push(0.0, 0.0, 0.0, 1);
        it.push(1.0, 10.0, 0.0, 1);
        assert_eq!(it.sample(0.0).unwrap().0, 0.0); // before first (delay)
        assert_eq!(it.sample(5.0).unwrap().0, 10.0); // past newest
    }

    #[test]
    fn large_jump_resets_buffer() {
        let mut it = ActorInterp::new();
        it.push(0.0, 0.0, 0.0, 1);
        it.push(0.1, 1.0, 0.0, 1);
        assert_eq!(it.len(), 2);
        it.push(0.2, 100.0, 0.0, 1); // > 12 cells → reset
        assert_eq!(it.len(), 1);
        assert_eq!(it.sample(0.3).unwrap(), (100.0, 0.0));
    }

    #[test]
    fn lifecycle_change_resets() {
        let mut it = ActorInterp::new();
        it.push(0.0, 0.0, 0.0, 1);
        it.push(0.1, 1.0, 0.0, 2); // seq changed → reset
        assert_eq!(it.len(), 1);
    }

    #[test]
    fn ring_capacity_bounded() {
        let mut it = ActorInterp::new();
        for i in 0..30 {
            it.push(i as f32 * 0.1, i as f32 * 0.1, 0.0, 1);
        }
        assert!(it.len() <= SAMPLE_LIMIT);
    }
}
