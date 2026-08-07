//! Software audio mixer + spatialization — a `no_std` port of the mixing math
//! in `client/src/audio/sfx.ts` (Web Audio there, a CPU voice mixer here).
//!
//! [`spatial_mix`] reproduces `computeSfxSpatialMix` exactly (distance rolloff
//! with a smooth far cutoff + horizontal pan). [`Mixer`] owns a fixed voice pool
//! that mixes mono PCM sources into an interleaved stereo buffer with per-voice
//! gain, equal-power pan, and pitch (resampling), honoring per-clip polyphony
//! and a concurrency-overload attenuation. All storage is allocated up front;
//! `mix_into` never allocates.

use alloc::vec;
use alloc::vec::Vec;

/// A point in the sim plane (cells). Sim (x,y); the listener/source live here.
#[derive(Clone, Copy, Debug)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}

/// Spatial options (mirror `SfxPlayOptions` spatial fields, with defaults).
#[derive(Clone, Copy, Debug)]
pub struct SpatialOpts {
    pub min_distance: f32,
    pub max_distance: f32,
    pub rolloff: f32,
    pub far_gain_floor: f32,
    pub max_pan: f32,
    pub pan_distance: f32,
}

impl Default for SpatialOpts {
    fn default() -> Self {
        Self {
            min_distance: 3.5,
            max_distance: 34.0,
            rolloff: 1.35,
            far_gain_floor: 0.0,
            max_pan: 0.85,
            pan_distance: 13.0,
        }
    }
}

/// Result of [`spatial_mix`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpatialMix {
    pub distance: f32,
    pub gain: f32,
    pub pan: f32,
}

#[inline]
fn clampf(v: f32, lo: f32, hi: f32) -> f32 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

/// Port of `computeSfxSpatialMix`: distance-based gain with a smoothstep far
/// cutoff (silent at/after `max_distance`) + clamped horizontal pan.
pub fn spatial_mix(listener: Point, position: Point, o: SpatialOpts) -> SpatialMix {
    let dx = position.x - listener.x;
    let dy = position.y - listener.y;
    let distance = libm::sqrtf(dx * dx + dy * dy);
    let min_d = o.min_distance;
    let max_d = (min_d + 0.1).max(o.max_distance);
    let t = clampf((distance - min_d) / (max_d - min_d), 0.0, 1.0);
    let far_floor = clampf(o.far_gain_floor, 0.0, 0.5);
    let shaped = far_floor + libm::powf(1.0 - t, o.rolloff) * (1.0 - far_floor);
    // Smoothly take every curve to zero over the final 18% of the range.
    let cutoff_t = clampf((t - 0.82) / 0.18, 0.0, 1.0);
    let cutoff_gain = 1.0 - cutoff_t * cutoff_t * (3.0 - 2.0 * cutoff_t);
    let gain = clampf(shaped * cutoff_gain, 0.0, 1.0);
    let max_pan = clampf(o.max_pan, 0.0, 1.0);
    let pan = clampf(dx / o.pan_distance, -max_pan, max_pan);
    SpatialMix {
        distance,
        gain,
        pan,
    }
}

/// Hard polyphony ceiling for a clip (port of `hardPolyphonyLimit`).
pub fn hard_polyphony_limit(polyphony: u32, looped: bool) -> u32 {
    if looped {
        return polyphony;
    }
    let a = polyphony;
    let b = (64u32).min(libm::ceilf((polyphony as f32) * 2.5) as u32);
    let c = polyphony + 12;
    a.max(b.min(c)).max(a) // max(polyphony, min(64, ceil(*2.5), +12))
}

/// Concurrency-overload attenuation (port of `voiceConcurrencyGain`).
pub fn voice_concurrency_gain(overload_voices: i32) -> f32 {
    if overload_voices <= 0 {
        return 1.0;
    }
    clampf(
        1.0 / libm::sqrtf(1.0 + overload_voices as f32 * 0.72),
        0.38,
        1.0,
    )
}

/// Mono PCM sample (normalized f32) at a given sample rate.
#[derive(Clone, Debug)]
pub struct Pcm {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

impl Pcm {
    pub fn new(samples: Vec<f32>, sample_rate: u32) -> Self {
        Self {
            samples,
            sample_rate,
        }
    }
    pub fn duration_secs(&self) -> f32 {
        if self.sample_rate == 0 {
            0.0
        } else {
            self.samples.len() as f32 / self.sample_rate as f32
        }
    }
}

#[derive(Clone, Copy)]
struct Voice {
    clip: usize, // index into the clip bank
    cursor: f32, // fractional read position (samples)
    step: f32,   // per-output-sample advance (pitch × sr ratio)
    gain: f32,
    pan: f32, // -1..1
    looped: bool,
    active: bool,
    key: u32, // clip/source key for polyphony accounting
}

/// A fixed-voice CPU mixer producing interleaved stereo f32.
pub struct Mixer {
    out_rate: u32,
    clips: Vec<Pcm>,
    voices: Vec<Voice>,
    master: f32,
}

impl Mixer {
    pub fn new(out_rate: u32, max_voices: usize) -> Self {
        Self {
            out_rate,
            clips: Vec::new(),
            voices: vec![
                Voice {
                    clip: 0,
                    cursor: 0.0,
                    step: 0.0,
                    gain: 0.0,
                    pan: 0.0,
                    looped: false,
                    active: false,
                    key: 0
                };
                max_voices
            ],
            master: 1.0,
        }
    }

    pub fn set_master(&mut self, g: f32) {
        self.master = clampf(g, 0.0, 1.0);
    }

    /// Register a clip; returns its bank index (a handle for `play`).
    pub fn add_clip(&mut self, pcm: Pcm) -> usize {
        self.clips.push(pcm);
        self.clips.len() - 1
    }

    pub fn active_voices(&self) -> usize {
        self.voices.iter().filter(|v| v.active).count()
    }

    fn voices_for_key(&self, key: u32) -> u32 {
        self.voices
            .iter()
            .filter(|v| v.active && v.key == key)
            .count() as u32
    }

    /// Start a voice. `pitch` scales playback speed (1.0 = native). Enforces
    /// `polyphony` per `key` (steals the oldest-cursor voice of that key when
    /// full). Returns false if the clip index is invalid.
    #[allow(clippy::too_many_arguments)]
    pub fn play(
        &mut self,
        clip: usize,
        key: u32,
        gain: f32,
        pan: f32,
        pitch: f32,
        looped: bool,
        polyphony: u32,
    ) -> bool {
        if clip >= self.clips.len() {
            return false;
        }
        let limit = hard_polyphony_limit(polyphony.max(1), looped);
        if self.voices_for_key(key) >= limit {
            // Steal the most-advanced (nearest-finished) voice of this key.
            let mut steal = None;
            let mut best = f32::MIN;
            for (i, v) in self.voices.iter().enumerate() {
                if v.active && v.key == key && v.cursor > best {
                    best = v.cursor;
                    steal = Some(i);
                }
            }
            if let Some(i) = steal {
                self.voices[i].active = false;
            }
        }
        let ratio = self.clips[clip].sample_rate as f32 / self.out_rate as f32;
        let slot = self.voices.iter().position(|v| !v.active);
        let slot = match slot {
            Some(s) => s,
            None => {
                // Pool full: steal the most-advanced voice overall.
                let mut best = f32::MIN;
                let mut idx = 0;
                for (i, v) in self.voices.iter().enumerate() {
                    if v.cursor > best {
                        best = v.cursor;
                        idx = i;
                    }
                }
                idx
            }
        };
        self.voices[slot] = Voice {
            clip,
            cursor: 0.0,
            step: ratio * pitch.max(0.01),
            gain: clampf(gain, 0.0, 4.0),
            pan: clampf(pan, -1.0, 1.0),
            looped,
            active: true,
            key,
        };
        true
    }

    pub fn stop_key(&mut self, key: u32) {
        for v in self.voices.iter_mut() {
            if v.key == key {
                v.active = false;
            }
        }
    }

    /// Mix all active voices into `out` (interleaved stereo L,R). `out.len()`
    /// must be even. Applies equal-power pan, per-voice gain, a concurrency
    /// attenuation, and the master gain. Voices that reach the end deactivate
    /// (or loop). No allocation.
    pub fn mix_into(&mut self, out: &mut [f32]) {
        for s in out.iter_mut() {
            *s = 0.0;
        }
        let overload = self.active_voices() as i32 - 8;
        let conc = voice_concurrency_gain(overload) * self.master;
        let frames = out.len() / 2;
        for v in self.voices.iter_mut() {
            if !v.active {
                continue;
            }
            let clip = &self.clips[v.clip];
            let n = clip.samples.len();
            if n == 0 {
                v.active = false;
                continue;
            }
            // Equal-power pan.
            let p = (v.pan + 1.0) * 0.5; // 0..1
            let l_gain = libm::sqrtf(1.0 - p) * v.gain * conc;
            let r_gain = libm::sqrtf(p) * v.gain * conc;
            for f in 0..frames {
                let idx = v.cursor as usize;
                if idx >= n {
                    if v.looped {
                        v.cursor -= n as f32;
                    } else {
                        v.active = false;
                        break;
                    }
                }
                let idx = v.cursor as usize;
                // Linear interpolation between idx and idx+1.
                let frac = v.cursor - idx as f32;
                let s0 = clip.samples[idx.min(n - 1)];
                let s1 = clip.samples[(idx + 1).min(n - 1)];
                let s = s0 + (s1 - s0) * frac;
                out[f * 2] += s * l_gain;
                out[f * 2 + 1] += s * r_gain;
                v.cursor += v.step;
            }
        }
        // Soft clip to [-1,1].
        for s in out.iter_mut() {
            *s = clampf(*s, -1.0, 1.0);
        }
    }
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;

    #[test]
    fn spatial_close_is_loud_centered() {
        let m = spatial_mix(
            Point { x: 0.0, y: 0.0 },
            Point { x: 0.0, y: 0.0 },
            SpatialOpts::default(),
        );
        assert!(m.gain > 0.99, "at listener → full gain");
        assert!(m.pan.abs() < 1e-6, "centered");
    }

    #[test]
    fn spatial_far_is_silent() {
        let m = spatial_mix(
            Point { x: 0.0, y: 0.0 },
            Point { x: 0.0, y: 40.0 },
            SpatialOpts::default(),
        );
        assert_eq!(m.gain, 0.0, "beyond max distance → silent");
    }

    #[test]
    fn spatial_pan_follows_side() {
        let o = SpatialOpts::default();
        let right = spatial_mix(Point { x: 0.0, y: 0.0 }, Point { x: 10.0, y: 2.0 }, o);
        let left = spatial_mix(Point { x: 0.0, y: 0.0 }, Point { x: -10.0, y: 2.0 }, o);
        assert!(right.pan > 0.0 && left.pan < 0.0, "pan sign tracks dx");
        assert!(right.pan <= 0.85 && left.pan >= -0.85, "clamped to max pan");
    }

    #[test]
    fn concurrency_gain_drops_with_overload() {
        assert_eq!(voice_concurrency_gain(0), 1.0);
        assert!(voice_concurrency_gain(8) < 1.0);
        assert!(voice_concurrency_gain(1000) >= 0.38, "floored");
    }

    #[test]
    fn polyphony_limit_matches_reference() {
        // non-looped: max(p, min(64, ceil(p*2.5), p+12))
        assert_eq!(hard_polyphony_limit(4, false), 10); // min(64, ceil(10), 16)=10 → max(4,10)=10
        assert_eq!(hard_polyphony_limit(1, true), 1); // looped keeps polyphony
    }

    #[test]
    fn mixer_sums_voice_into_stereo() {
        let mut mx = Mixer::new(48_000, 8);
        // A constant DC sample at native rate.
        let clip = mx.add_clip(Pcm::new(vec![0.5; 48_000], 48_000));
        assert!(mx.play(clip, 1, 1.0, 0.0, 1.0, false, 4));
        assert_eq!(mx.active_voices(), 1);
        let mut buf = vec![0.0f32; 512]; // 256 stereo frames
        mx.mix_into(&mut buf);
        // Centered pan → both channels ~ 0.5 * sqrt(0.5) = 0.3535.
        assert!((buf[0] - 0.3535).abs() < 0.02, "L ~0.354, got {}", buf[0]);
        assert!((buf[1] - 0.3535).abs() < 0.02, "R ~0.354, got {}", buf[1]);
    }

    #[test]
    fn non_looped_voice_finishes_and_frees() {
        let mut mx = Mixer::new(48_000, 4);
        let clip = mx.add_clip(Pcm::new(vec![1.0; 4], 48_000));
        mx.play(clip, 1, 1.0, 0.0, 1.0, false, 4);
        let mut buf = vec![0.0f32; 64];
        mx.mix_into(&mut buf); // 32 frames >> 4 samples → finishes
        assert_eq!(mx.active_voices(), 0, "short clip finished and freed");
    }

    #[test]
    fn hard_pan_left_silences_right() {
        let mut mx = Mixer::new(48_000, 4);
        let clip = mx.add_clip(Pcm::new(vec![1.0; 4800], 48_000));
        mx.play(clip, 1, 1.0, -1.0, 1.0, false, 4);
        let mut buf = vec![0.0f32; 8];
        mx.mix_into(&mut buf);
        assert!(buf[0] > 0.5, "left has signal");
        assert!(buf[1].abs() < 1e-3, "right silent on hard-left pan");
    }
}
