//! Audio output sink: renders the mixer to a 16-bit stereo WAV file. This is
//! the deterministic, device-free output path used to verify the whole audio
//! pipeline (manifest → MP3 decode → mixer → interleaved stereo). The live
//! CoreAudio device sink (`platform::audio`) consumes the same mixer blocks.

use super::{SfxPlayer, OUT_RATE};

/// Render `seconds` of the player's current mix to a 16-bit stereo WAV at `path`.
/// Pulls the mixer in fixed blocks (no per-block heap growth after warmup).
pub fn render_to_wav(player: &mut SfxPlayer, seconds: f32, path: &str) -> std::io::Result<usize> {
    let total_frames = (seconds * OUT_RATE as f32) as usize;
    let block = 1024usize;
    let mut buf = vec![0.0f32; block * 2];
    let mut pcm16: Vec<u8> = Vec::with_capacity(total_frames * 4);
    let mut done = 0usize;
    while done < total_frames {
        let n = block.min(total_frames - done);
        let slice = &mut buf[..n * 2];
        player.render(slice);
        for &s in slice.iter() {
            let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
            pcm16.extend_from_slice(&v.to_le_bytes());
        }
        done += n;
    }
    let bytes = write_wav_bytes(&pcm16, OUT_RATE, 2);
    std::fs::write(path, &bytes)?;
    Ok(total_frames)
}

/// Wrap interleaved 16-bit LE PCM in a canonical RIFF/WAVE container.
pub fn write_wav_bytes(pcm16: &[u8], sample_rate: u32, channels: u16) -> Vec<u8> {
    let byte_rate = sample_rate * channels as u32 * 2;
    let block_align = channels * 2;
    let data_len = pcm16.len() as u32;
    let mut out = Vec::with_capacity(44 + pcm16.len());
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&block_align.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    out.extend_from_slice(pcm16);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use successor_engine_core::audio::Point;

    const ASSETS: &str = "../../../client/public/successor-audio/sfx";

    #[test]
    fn renders_triggered_sfx_to_a_nonsilent_wav() {
        let Ok(manifest) = std::fs::read_to_string(format!("{ASSETS}/manifest.json")) else {
            eprintln!("skip: assets absent");
            return;
        };
        let mut p = SfxPlayer::new();
        if p.load(&manifest, ASSETS) == 0 {
            eprintln!("skip: no clips decoded");
            return;
        }
        p.set_listener(Point { x: 0.0, y: 0.0 });
        p.play_ui("ui_panel_open");
        p.play_at("slugthrower_fire", Point { x: 1.0, y: 1.0 }, Default::default());
        let out = std::env::temp_dir().join("successor_sfx_test.wav");
        let path = out.to_string_lossy().to_string();
        let frames = render_to_wav(&mut p, 0.5, &path).expect("render");
        assert_eq!(frames, (0.5 * OUT_RATE as f32) as usize);
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WAVE");
        // Non-silent: some sample past the 44-byte header is non-zero.
        let nonzero = bytes[44..].iter().any(|&b| b != 0);
        assert!(nonzero, "rendered WAV carries signal");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn wav_header_is_well_formed() {
        let pcm = vec![0u8; 400];
        let w = write_wav_bytes(&pcm, 44_100, 2);
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes([w[40], w[41], w[42], w[43]]), 400, "data chunk length");
        assert_eq!(u16::from_le_bytes([w[22], w[23]]), 2, "stereo");
        assert_eq!(u32::from_le_bytes([w[24], w[25], w[26], w[27]]), 44_100, "sample rate");
    }
}
