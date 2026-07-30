//! Native SFX runtime: MP3 decode (`rmp3`) → the software mixer
//! (`engine_core::audio`), a manifest-driven clip registry with buses, and the
//! game-event → sound trigger map (port of `client/src/audio/sfx.ts`).
//!
//! Web builds decode through Web Audio and are out of scope here (native-only).

use successor_engine_core::audio::{Mixer, Pcm, Point, SpatialOpts};

pub mod triggers;
pub mod wav;
pub use triggers::*;

/// Output sample rate the mixer runs at (manifest assets are 44.1 kHz).
pub const OUT_RATE: u32 = 44_100;

/// Decode an MP3 byte stream to mono f32 PCM (downmixing channels). Returns the
/// source sample rate from the first audio frame.
pub fn decode_mp3(bytes: &[u8]) -> Pcm {
    use rmp3::{Decoder, Frame};
    let mut decoder = Decoder::new(bytes);
    let mut out: Vec<f32> = Vec::new();
    let mut rate = OUT_RATE;
    while let Some(frame) = decoder.next() {
        if let Frame::Audio(audio) = frame {
            rate = audio.sample_rate();
            let ch = audio.channels().max(1) as usize;
            let s = audio.samples();
            let frames = s.len() / ch;
            out.reserve(frames);
            for f in 0..frames {
                let mut acc = 0.0f32;
                for c in 0..ch {
                    acc += s[f * ch + c];
                }
                out.push(acc / ch as f32);
            }
        }
    }
    Pcm::new(out, rate)
}

#[derive(Clone, Debug)]
struct ClipInfo {
    id: String,
    bank: usize,
    volume: f32,
    polyphony: u32,
    bus: String,
}

/// The SFX player: owns the mixer + decoded clip bank + bus gains.
pub struct SfxPlayer {
    mixer: Mixer,
    clips: Vec<ClipInfo>,
    buses: Vec<(String, f32)>,
    listener: Point,
}

impl SfxPlayer {
    pub fn new() -> Self {
        Self { mixer: Mixer::new(OUT_RATE, 64), clips: Vec::new(), buses: Vec::new(), listener: Point { x: 0.0, y: 0.0 } }
    }

    pub fn mixer_mut(&mut self) -> &mut Mixer {
        &mut self.mixer
    }
    pub fn set_listener(&mut self, p: Point) {
        self.listener = p;
    }

    /// Load a manifest (JSON string) and decode each clip's MP3 from
    /// `assets_dir`. Missing/failed clips are skipped (logged), so a partial
    /// asset tree still yields a working player.
    pub fn load(&mut self, manifest_json: &str, assets_dir: &str) -> usize {
        let v: serde_json::Value = match serde_json::from_str(manifest_json) {
            Ok(v) => v,
            Err(_) => return 0,
        };
        if let Some(buses) = v.get("buses").and_then(|b| b.as_object()) {
            for (name, cfg) in buses {
                let vol = cfg.get("volume").and_then(|x| x.as_f64()).unwrap_or(1.0) as f32;
                self.buses.push((name.clone(), vol));
            }
        }
        let mut loaded = 0;
        if let Some(clips) = v.get("clips").and_then(|c| c.as_array()) {
            for c in clips {
                let id = match c.get("id").and_then(|x| x.as_str()) {
                    Some(s) => s.to_string(),
                    None => continue,
                };
                let path = c.get("path").and_then(|x| x.as_str()).unwrap_or("");
                let file = path.rsplit('/').next().unwrap_or(path);
                let full = format!("{}/{}", assets_dir.trim_end_matches('/'), file);
                let bytes = match std::fs::read(&full) {
                    Ok(b) => b,
                    Err(_) => continue,
                };
                let pcm = decode_mp3(&bytes);
                if pcm.samples.is_empty() {
                    continue;
                }
                let bank = self.mixer.add_clip(pcm);
                self.clips.push(ClipInfo {
                    id,
                    bank,
                    volume: c.get("volume").and_then(|x| x.as_f64()).unwrap_or(1.0) as f32,
                    polyphony: c.get("polyphony").and_then(|x| x.as_u64()).unwrap_or(4) as u32,
                    bus: c.get("bus").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                });
                loaded += 1;
            }
        }
        loaded
    }

    fn clip(&self, id: &str) -> Option<&ClipInfo> {
        self.clips.iter().find(|c| c.id == id)
    }
    fn bus_volume(&self, bus: &str) -> f32 {
        self.buses.iter().find(|(n, _)| n == bus).map(|(_, v)| *v).unwrap_or(1.0)
    }

    /// A stable per-clip voice key (FNV-1a of the id) for polyphony accounting.
    fn key(id: &str) -> u32 {
        let mut h = 0x811c_9dc5u32;
        for b in id.bytes() {
            h ^= b as u32;
            h = h.wrapping_mul(0x0100_0193);
        }
        h
    }

    /// Play a 2-D clip. `at` is the world/sim position; the listener + spatial
    /// options shape gain + pan. Returns false if the clip is unknown.
    pub fn play_at(&mut self, id: &str, at: Point, opts: SpatialOpts) -> bool {
        let (bank, base_gain, poly, pan) = match self.clip(id) {
            Some(c) => {
                let mix = successor_engine_core::audio::spatial_mix(self.listener, at, opts);
                (c.bank, c.volume * self.bus_volume(&c.bus) * mix.gain, c.polyphony, mix.pan)
            }
            None => return false,
        };
        if base_gain <= 0.0 {
            return true; // culled by distance — nothing to play
        }
        self.mixer.play(bank, Self::key(id), base_gain, pan, 1.0, false, poly)
    }

    /// Play a non-spatial (UI) clip at full listener-relative gain.
    pub fn play_ui(&mut self, id: &str) -> bool {
        let (bank, gain, poly) = match self.clip(id) {
            Some(c) => (c.bank, c.volume * self.bus_volume(&c.bus), c.polyphony),
            None => return false,
        };
        self.mixer.play(bank, Self::key(id), gain, 0.0, 1.0, false, poly)
    }

    pub fn clip_count(&self) -> usize {
        self.clips.len()
    }
    pub fn active_voices(&self) -> usize {
        self.mixer.active_voices()
    }

    /// Render the next block of interleaved-stereo audio (for the output sink).
    pub fn render(&mut self, out: &mut [f32]) {
        self.mixer.mix_into(out);
    }
}

impl Default for SfxPlayer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ASSETS: &str = "../../../client/public/successor-audio/sfx";

    fn read_manifest() -> Option<String> {
        std::fs::read_to_string(format!("{ASSETS}/manifest.json")).ok()
    }

    #[test]
    fn decodes_a_real_manifest_mp3() {
        let path = format!("{ASSETS}/ui_panel_open.mp3");
        let Ok(bytes) = std::fs::read(&path) else {
            eprintln!("skip: asset absent");
            return;
        };
        let pcm = decode_mp3(&bytes);
        assert!(!pcm.samples.is_empty(), "decoded PCM non-empty");
        assert_eq!(pcm.sample_rate, 44_100, "44.1 kHz source");
        // Manifest says ~0.522s; allow slack for encoder padding.
        assert!(pcm.duration_secs() > 0.3 && pcm.duration_secs() < 1.0, "≈0.5s, got {}", pcm.duration_secs());
    }

    #[test]
    fn loads_manifest_and_plays_ui_clip() {
        let Some(manifest) = read_manifest() else {
            eprintln!("skip: manifest absent");
            return;
        };
        let mut p = SfxPlayer::new();
        let n = p.load(&manifest, ASSETS);
        assert!(n > 50, "loaded a substantial clip bank, got {n}");
        assert!(p.play_ui("ui_panel_open"), "known UI clip plays");
        assert_eq!(p.active_voices(), 1);
        assert!(!p.play_ui("does_not_exist"), "unknown clip rejected");
    }

    #[test]
    fn distant_spatial_clip_is_culled() {
        let Some(manifest) = read_manifest() else {
            return;
        };
        let mut p = SfxPlayer::new();
        if p.load(&manifest, ASSETS) == 0 {
            return;
        }
        p.set_listener(Point { x: 0.0, y: 0.0 });
        // Far away → gain 0 → no voice, but returns true (handled).
        let far = Point { x: 0.0, y: 200.0 };
        assert!(p.play_at("slugthrower_fire", far, SpatialOpts::default()));
        assert_eq!(p.active_voices(), 0, "distant shot culled");
    }
}
