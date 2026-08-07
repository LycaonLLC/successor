//! Native SFX runtime: MP3 decode (`rmp3`) → the software mixer
//! (`engine_core::audio`), a manifest-driven clip registry with buses, and the
//! game-event → sound trigger map (port of `client/src/audio/sfx.ts`).
//!
//! The mixer is shared behind an `Arc<Mutex<…>>` so the platform device sink
//! (`successor_platform::AudioOutput`) can pull interleaved-stereo blocks from
//! its render thread while the scene fires triggers from the frame loop. The
//! device callback never allocates; play/stop calls only touch preallocated
//! voice slots.
//!
//! Web builds decode through Web Audio and use the same trigger map; the
//! native decode path stays out of the wasm module.

#[cfg(not(target_arch = "wasm32"))]
use std::sync::{Arc, Mutex};

#[cfg(not(target_arch = "wasm32"))]
use successor_engine_core::audio::{Mixer, Pcm};
use successor_engine_core::audio::{Point, SpatialOpts};

pub mod triggers;
#[cfg(not(target_arch = "wasm32"))]
pub mod wav;
pub use triggers::*;

/// Output sample rate the native mixer runs at (manifest assets are 44.1 kHz).
#[cfg(not(target_arch = "wasm32"))]
pub const OUT_RATE: u32 = 44_100;

#[cfg(not(target_arch = "wasm32"))]
pub fn decode_mp3(bytes: &[u8]) -> Pcm {
    use rmp3::{Decoder, Frame};
    let mut decoder = Decoder::new(bytes);
    let mut out: Vec<f32> = Vec::new();
    let mut rate = OUT_RATE;
    let mut first = true;
    while let Some(frame) = decoder.next() {
        if let Frame::Audio(audio) = frame {
            if first {
                rate = audio.sample_rate();
                first = false;
            }
            let channels = audio.channels() as usize;
            let samples = audio.samples();
            if channels <= 1 {
                out.extend_from_slice(samples);
            } else {
                for chunk in samples.chunks_exact(channels) {
                    out.push(chunk.iter().sum::<f32>() / channels as f32);
                }
            }
        }
    }
    Pcm::new(out, rate)
}

#[derive(Clone, Debug)]
struct ClipInfo {
    id: String,
    #[cfg(target_arch = "wasm32")]
    path: String,
    #[cfg(not(target_arch = "wasm32"))]
    bank: usize,
    gain: f32,
    polyphony: u32,
}

#[derive(Debug)]
struct ParsedClip {
    id: String,
    path: String,
    gain: f32,
    polyphony: u32,
}

fn normalized_audio_path(path: &str) -> Option<&str> {
    let path = path.strip_prefix('/').unwrap_or(path);
    (!path.is_empty()
        && path.starts_with("successor-audio/")
        && !path.contains("..")
        && !path.contains('\\')
        && !path.contains("://")
        && !path.starts_with('/'))
    .then_some(path)
}

fn parse_manifest(manifest_json: &str) -> Result<Vec<ParsedClip>, ()> {
    let root: serde_json::Value = serde_json::from_str(manifest_json).map_err(|_| ())?;
    if root.get("schema").and_then(|v| v.as_str()) != Some("successor-sfx-manifest-v1") {
        return Err(());
    }
    let buses = root.get("buses").and_then(|v| v.as_object()).ok_or(())?;
    let mut parsed_buses = Vec::with_capacity(buses.len());
    for (name, value) in buses {
        if name.is_empty() || parsed_buses.iter().any(|(known, _)| known == name) {
            return Err(());
        }
        let gain = value.get("volume").and_then(|v| v.as_f64()).ok_or(())? as f32;
        let polyphony = value.get("polyphony").and_then(|v| v.as_u64()).ok_or(())?;
        if !gain.is_finite() || polyphony == 0 || polyphony > u32::MAX as u64 {
            return Err(());
        }
        parsed_buses.push((name.as_str(), gain));
    }
    let clips = root.get("clips").and_then(|v| v.as_array()).ok_or(())?;
    let mut parsed = Vec::with_capacity(clips.len());
    for clip in clips {
        let id = clip.get("id").and_then(|v| v.as_str()).ok_or(())?;
        if id.is_empty() || parsed.iter().any(|known: &ParsedClip| known.id == id) {
            return Err(());
        }
        let path =
            normalized_audio_path(clip.get("path").and_then(|v| v.as_str()).ok_or(())?).ok_or(())?;
        let bus = clip.get("bus").and_then(|v| v.as_str()).ok_or(())?;
        let bus_gain = parsed_buses
            .iter()
            .find(|(name, _)| *name == bus)
            .map(|(_, gain)| *gain)
            .ok_or(())?;
        let clip_gain = clip.get("volume").and_then(|v| v.as_f64()).ok_or(())? as f32;
        let polyphony = clip.get("polyphony").and_then(|v| v.as_u64()).ok_or(())?;
        if !clip_gain.is_finite() || polyphony == 0 || polyphony > u32::MAX as u64 {
            return Err(());
        }
        let gain = clip_gain * bus_gain;
        if !gain.is_finite() {
            return Err(());
        }
        parsed.push(ParsedClip {
            id: id.to_string(),
            path: path.to_string(),
            gain,
            polyphony: polyphony as u32,
        });
    }
    Ok(parsed)
}

pub struct SfxPlayer {
    #[cfg(not(target_arch = "wasm32"))]
    mixer: Arc<Mutex<Mixer>>,
    clips: Vec<ClipInfo>,
    listener: Point,
}

impl SfxPlayer {
    pub fn new() -> Self {
        Self {
            #[cfg(not(target_arch = "wasm32"))]
            mixer: Arc::new(Mutex::new(Mixer::new(OUT_RATE, 64))),
            clips: Vec::new(),
            listener: Point { x: 0.0, y: 0.0 },
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn shared_mixer(&self) -> Arc<Mutex<Mixer>> {
        Arc::clone(&self.mixer)
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn lock_mixer(&self) -> std::sync::MutexGuard<'_, Mixer> {
        self.mixer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn set_listener(&mut self, p: Point) {
        self.listener = p;
    }

    pub fn listener(&self) -> Point {
        self.listener
    }

    pub fn load_with(
        &mut self,
        manifest_json: &str,
        read: &mut dyn FnMut(&str) -> Option<Vec<u8>>,
    ) -> usize {
        let Ok(parsed) = parse_manifest(manifest_json) else {
            return 0;
        };
        self.clips.clear();
        for clip in parsed {
            #[cfg(not(target_arch = "wasm32"))]
            {
                let Some(bytes) = read(&clip.path) else {
                    continue;
                };
                let pcm = decode_mp3(&bytes);
                if pcm.samples.is_empty() {
                    continue;
                }
                let bank = self.lock_mixer().add_clip(pcm);
                self.clips.push(ClipInfo {
                    id: clip.id,
                    bank,
                    gain: clip.gain,
                    polyphony: clip.polyphony,
                });
            }
            #[cfg(target_arch = "wasm32")]
            {
                let _ = read;
                self.clips.push(ClipInfo {
                    id: clip.id,
                    path: clip.path,
                    gain: clip.gain,
                    polyphony: clip.polyphony,
                });
            }
        }
        self.clips.len()
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn load(&mut self, manifest_json: &str, assets_dir: &str) -> usize {
        let dir = assets_dir.trim_end_matches('/').to_string();
        self.load_with(manifest_json, &mut |stable_id: &str| {
            let file = stable_id.rsplit('/').next().unwrap_or(stable_id);
            std::fs::read(format!("{dir}/{file}")).ok()
        })
    }

    fn clip(&self, id: &str) -> Option<&ClipInfo> {
        self.clips.iter().find(|clip| clip.id == id)
    }

    fn key(id: &str) -> u32 {
        let mut hash = 0x811c_9dc5u32;
        for byte in id.bytes() {
            hash ^= byte as u32;
            hash = hash.wrapping_mul(0x0100_0193);
        }
        hash
    }

    fn dispatch(
        &self,
        clip: &ClipInfo,
        key: u32,
        gain: f32,
        pan: f32,
        looped: bool,
        polyphony: u32,
    ) -> bool {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.lock_mixer()
                .play(clip.bank, key, gain, pan, 1.0, looped, polyphony)
        }
        #[cfg(target_arch = "wasm32")]
        {
            successor_platform::web::audio_play(&clip.path, key, gain, pan, looped, polyphony)
        }
    }

    pub fn play_at(&mut self, id: &str, at: Point, opts: SpatialOpts) -> bool {
        let Some(clip) = self.clip(id) else {
            return false;
        };
        let mix = successor_engine_core::audio::spatial_mix(self.listener, at, opts);
        let gain = clip.gain * mix.gain;
        if gain <= 0.0 {
            return true;
        }
        self.dispatch(clip, Self::key(id), gain, mix.pan, false, clip.polyphony)
    }

    pub fn play_ui(&mut self, id: &str) -> bool {
        let Some(clip) = self.clip(id) else {
            return false;
        };
        self.dispatch(clip, Self::key(id), clip.gain, 0.0, false, clip.polyphony)
    }

    pub fn play_loop(&mut self, id: &str, key: u32, at: Option<Point>, volume: f32) -> bool {
        let Some(clip) = self.clip(id) else {
            return false;
        };
        let spatial = at
            .map(|point| {
                successor_engine_core::audio::spatial_mix(
                    self.listener,
                    point,
                    SpatialOpts::default(),
                )
                .gain
            })
            .unwrap_or(1.0);
        let gain = clip.gain * spatial * volume;
        if gain <= 0.0 {
            return true;
        }
        self.dispatch(clip, key, gain, 0.0, true, 1)
    }

    pub fn stop_loop(&mut self, key: u32) {
        #[cfg(not(target_arch = "wasm32"))]
        self.lock_mixer().stop_key(key);
        #[cfg(target_arch = "wasm32")]
        successor_platform::web::audio_stop(key);
    }

    pub fn clip_count(&self) -> usize {
        self.clips.len()
    }

    pub fn active_voices(&self) -> usize {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.lock_mixer().active_voices()
        }
        #[cfg(target_arch = "wasm32")]
        {
            successor_platform::web::audio_active_voices() as usize
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn render(&mut self, out: &mut [f32]) {
        self.lock_mixer().mix_into(out);
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
        assert!(
            pcm.duration_secs() > 0.3 && pcm.duration_secs() < 1.0,
            "≈0.5s, got {}",
            pcm.duration_secs()
        );
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
        let far = Point { x: 0.0, y: 200.0 };
        assert!(p.play_at("slugthrower_fire", far, SpatialOpts::default()));
        assert_eq!(p.active_voices(), 0, "distant shot culled");
    }

    #[test]
    fn loop_starts_and_stops_under_its_key() {
        let Some(manifest) = read_manifest() else {
            return;
        };
        let mut p = SfxPlayer::new();
        if p.load(&manifest, ASSETS) == 0 {
            return;
        }
        assert!(p.play_loop("campfire_crackle_loop", 0xC0FFEE, None, 1.0));
        assert!(p.active_voices() >= 1);
        p.stop_loop(0xC0FFEE);
        assert_eq!(p.active_voices(), 0, "loop torn down by key");
    }

    #[test]
    fn shared_mixer_renders_from_a_second_handle() {
        let Some(manifest) = read_manifest() else {
            return;
        };
        let mut p = SfxPlayer::new();
        if p.load(&manifest, ASSETS) == 0 {
            return;
        }
        let shared = p.shared_mixer();
        assert!(p.play_ui("ui_panel_open"));
        let mut block = vec![0.0f32; 16_384];
        shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .mix_into(&mut block);
        assert!(
            block.iter().any(|s| s.abs() > 1e-6),
            "device-sink handle hears the scene's trigger"
        );
    }

    #[test]
    fn strict_manifest_parser_preserves_gain_path_and_polyphony() {
        let manifest = read_manifest().expect("checked-in manifest");
        let clips = parse_manifest(&manifest).expect("valid manifest");
        let clip = clips
            .iter()
            .find(|clip| clip.id == "ui_panel_open")
            .expect("UI clip");
        assert_eq!(clip.path, "successor-audio/sfx/ui_panel_open.mp3");
        assert!((clip.gain - 0.255).abs() < 1.0e-6);
        assert_eq!(clip.polyphony, 4);
    }

    fn minimal_manifest(path: &str, bus: &str, volume: &str, polyphony: u32) -> String {
        format!(
            r#"{{"schema":"successor-sfx-manifest-v1","buses":{{"ui":{{"volume":0.75,"polyphony":10}}}},"clips":[{{"id":"clip","path":"{path}","bus":"{bus}","volume":{volume},"polyphony":{polyphony}}}]}}"#
        )
    }

    #[test]
    fn strict_manifest_parser_rejects_invalid_contracts() {
        assert!(parse_manifest(r#"{"schema":"wrong","buses":{},"clips":[]}"#).is_err());
        for path in [
            "../successor-audio/x.mp3",
            "/../successor-audio/x.mp3",
            "https://example.test/x.mp3",
            "//successor-audio/x.mp3",
        ] {
            assert!(parse_manifest(&minimal_manifest(path, "ui", "1.0", 1)).is_err());
        }
        assert!(parse_manifest(&minimal_manifest(
            "successor-audio/x.mp3",
            "unknown",
            "1.0",
            1,
        ))
        .is_err());
        assert!(
            parse_manifest(&minimal_manifest("successor-audio/x.mp3", "ui", "1e400", 1,)).is_err()
        );
        assert!(
            parse_manifest(&minimal_manifest("successor-audio/x.mp3", "ui", "1.0", 0,)).is_err()
        );
        let duplicate = r#"{"schema":"successor-sfx-manifest-v1","buses":{"ui":{"volume":1,"polyphony":1}},"clips":[{"id":"same","path":"successor-audio/a.mp3","bus":"ui","volume":1,"polyphony":1},{"id":"same","path":"successor-audio/b.mp3","bus":"ui","volume":1,"polyphony":1}]}"#;
        assert!(parse_manifest(duplicate).is_err());
    }
}
