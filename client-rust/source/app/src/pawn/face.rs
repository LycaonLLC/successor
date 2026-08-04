//! Face-kit compositor — port of the transparent texture side of
//! `client-3d/src/render/faceDecal.ts` (+ `assets/faceKit/face-kit`).
//! It chroma-keys the atlas skin colour and returns only eyes, brows, nose, and
//! mouth as straight RGBA. The pawn's opaque head skin stays underneath; baking
//! another skin rectangle into this texture is the dark-face regression this
//! module must not reintroduce. Head-overlay geometry attachment remains a
//! follow-on render integration.
//!
//! Atlas contract from `face-kit/metadata/atlas-layout.json`: a 4×2 grid of 8
//! named styles per feature sheet; `backgroundKey` [202,136,97] is transparent.

use successor_engine_core::image::{decode_png, ImageError, RgbaImage};

pub const FACE_TEXTURE_SIZE: u32 = 256;
const GRID_COLS: u32 = 4;
const GRID_ROWS: u32 = 2;
const BG_KEY: [u8; 3] = [202, 136, 97];

/// The eight atlas style cells in grid order.
pub const CELL_ORDER: [&str; 8] = [
    "stoic", "rogue", "youth", "ghost", "sharp", "feral", "regal", "veteran",
];

/// Decoded feature sheets.
pub struct FaceKit {
    pub eyes: RgbaImage,
    pub brows: RgbaImage,
    pub noses: RgbaImage,
    pub mouths: RgbaImage,
}

impl FaceKit {
    /// Load the four feature sheets from a face-kit asset directory.
    pub fn load(face_kit_dir: &str) -> Result<FaceKit, ImageError> {
        let read = |name: &str| -> Result<RgbaImage, ImageError> {
            let path = format!("{face_kit_dir}/assets/{name}");
            let bytes = std::fs::read(&path).map_err(|_| ImageError::Truncated)?;
            decode_png(&bytes)
        };
        Ok(FaceKit {
            eyes: read("face-eyes-v3.png")?,
            brows: read("face-brows-v3.png")?,
            noses: read("face-noses-v3.png")?,
            mouths: read("face-mouths-v3.png")?,
        })
    }
}

/// Resolve a style name to its grid index (falls back to 0/"stoic").
pub fn style_index(name: &str) -> usize {
    CELL_ORDER.iter().position(|&c| c == name).unwrap_or(0)
}

/// Distance from the sampled canvas colour below which a pixel is pure
/// backdrop, and the distance at which a pixel is a fully opaque feature.
///
/// Measured against the shipped `RB_Face` panels: 93% of the texture sits
/// within 9 of its own border colour (the flat skin canvas), the 10..19 band
/// holds 0.15%, and every painted feature lies past 20. Keying at 12..40
/// therefore erases the canvas and its shading drift while keeping brows,
/// eyes, nose, and mouth, with a soft edge in between.
const CANVAS_KEEP: f32 = 12.0;
const FEATURE_FULL: f32 = 40.0;

/// Erase an authored face panel's baked skin canvas, leaving only the painted
/// features.
///
/// The body GLB ships `RB_Face` as a fully opaque rectangle whose background is
/// a fixed skin colour. Drawn untinted over a tinted head that reads as a skin
/// patch layered on the face; drawn tinted it double-darkens. Keying the
/// canvas out lets the head's own tinted skin show through, so one face asset
/// serves every skin tone.
pub fn key_face_panel(panel: &RgbaImage) -> RgbaImage {
    let mut out = RgbaImage {
        width: panel.width,
        height: panel.height,
        pixels: panel.pixels.clone(),
    };
    let Some(canvas) = border_colour(panel) else {
        return out;
    };
    for index in (0..out.pixels.len()).step_by(4) {
        let distance = chebyshev(&out.pixels[index..index + 3], canvas);
        let t = ((distance - CANVAS_KEEP) / (FEATURE_FULL - CANVAS_KEEP)).clamp(0.0, 1.0);
        let keep = t * t * (3.0 - 2.0 * t);
        let alpha = out.pixels[index + 3] as f32 * keep;
        out.pixels[index + 3] = alpha.round().clamp(0.0, 255.0) as u8;
    }
    out
}

/// Mean colour of the panel's one-pixel border, which is always canvas.
fn border_colour(panel: &RgbaImage) -> Option<[u8; 3]> {
    let (w, h) = (panel.width as usize, panel.height as usize);
    if w < 2 || h < 2 {
        return None;
    }
    let mut sums = [0u64; 3];
    let mut count = 0u64;
    let mut sample = |x: usize, y: usize| {
        let i = (y * w + x) * 4;
        for (channel, sum) in sums.iter_mut().enumerate() {
            *sum += panel.pixels[i + channel] as u64;
        }
        count += 1;
    };
    for x in 0..w {
        sample(x, 0);
        sample(x, h - 1);
    }
    for y in 0..h {
        sample(0, y);
        sample(w - 1, y);
    }
    (count > 0).then(|| {
        [
            (sums[0] / count) as u8,
            (sums[1] / count) as u8,
            (sums[2] / count) as u8,
        ]
    })
}

fn chebyshev(pixel: &[u8], reference: [u8; 3]) -> f32 {
    (0..3)
        .map(|c| (pixel[c] as i32 - reference[c] as i32).abs())
        .max()
        .unwrap_or(0) as f32
}

/// Composite a transparent face-component overlay for one style. Later
/// features paint over earlier ones (brows/nose/mouth over eyes).
pub fn render_face_overlay(kit: &FaceKit, style: usize) -> RgbaImage {
    let size = FACE_TEXTURE_SIZE;
    let mut out = RgbaImage {
        width: size,
        height: size,
        pixels: vec![0u8; (size * size * 4) as usize],
    };
    composite_cell(&mut out, &kit.eyes, style);
    composite_cell(&mut out, &kit.brows, style);
    composite_cell(&mut out, &kit.noses, style);
    composite_cell(&mut out, &kit.mouths, style);
    out
}

/// Composite one atlas cell with a soft background key and straight-alpha over.
fn composite_cell(out: &mut RgbaImage, sheet: &RgbaImage, style: usize) {
    let cell_w = sheet.width / GRID_COLS;
    let cell_h = sheet.height / GRID_ROWS;
    if cell_w == 0 || cell_h == 0 {
        return;
    }
    let col = (style as u32) % GRID_COLS;
    let row = ((style as u32) / GRID_COLS) % GRID_ROWS;
    let src_x0 = col * cell_w;
    let src_y0 = row * cell_h;
    for oy in 0..out.height {
        let sy = src_y0 + oy * cell_h / out.height;
        for ox in 0..out.width {
            let sx = src_x0 + ox * cell_w / out.width;
            let si = ((sy * sheet.width + sx) * 4) as usize;
            let (r, g, b, a) = (
                sheet.pixels[si],
                sheet.pixels[si + 1],
                sheet.pixels[si + 2],
                sheet.pixels[si + 3],
            );
            let source_alpha = a as f32 / 255.0 * mark_strength(r, g, b);
            if source_alpha <= 0.0 {
                continue;
            }
            let di = ((oy * out.width + ox) * 4) as usize;
            over_straight(&mut out.pixels[di..di + 4], [r, g, b], source_alpha);
        }
    }
}

fn mark_strength(r: u8, g: u8, b: u8) -> f32 {
    let distance = [
        (r as i32 - BG_KEY[0] as i32).abs(),
        (g as i32 - BG_KEY[1] as i32).abs(),
        (b as i32 - BG_KEY[2] as i32).abs(),
    ]
    .into_iter()
    .max()
    .unwrap_or(0) as f32;
    let t = ((distance - 4.0) / 14.0).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn over_straight(dst: &mut [u8], source: [u8; 3], source_alpha: f32) {
    let destination_alpha = dst[3] as f32 / 255.0;
    let inverse = 1.0 - source_alpha;
    let output_alpha = source_alpha + destination_alpha * inverse;
    if output_alpha <= 0.0 {
        return;
    }
    for channel in 0..3 {
        let premultiplied = source[channel] as f32 * source_alpha
            + dst[channel] as f32 * destination_alpha * inverse;
        dst[channel] = (premultiplied / output_alpha).round().clamp(0.0, 255.0) as u8;
    }
    dst[3] = (output_alpha * 255.0).round().clamp(0.0, 255.0) as u8;
}

#[cfg(test)]
mod tests {
    use super::*;

    const FACE_KIT: &str = "../../../client-3d/public/assets/face-kit";

    #[test]
    fn style_index_lookup() {
        assert_eq!(style_index("stoic"), 0);
        assert_eq!(style_index("veteran"), 7);
        assert_eq!(style_index("unknown"), 0);
    }

    #[test]
    fn composites_background_erased_face_overlay() {
        let Ok(kit) = FaceKit::load(FACE_KIT) else {
            eprintln!("skip: face-kit not present");
            return;
        };
        let tex = render_face_overlay(&kit, style_index("rogue"));
        assert_eq!(tex.width, FACE_TEXTURE_SIZE);
        assert_eq!(tex.height, FACE_TEXTURE_SIZE);

        let mut transparent = 0;
        let mut painted = 0;
        for pixel in tex.pixels.chunks_exact(4) {
            if pixel[3] == 0 {
                transparent += 1;
            } else {
                painted += 1;
            }
        }
        assert!(
            painted > 100,
            "expected composited feature pixels, got {painted}"
        );
        assert!(
            transparent > (FACE_TEXTURE_SIZE * FACE_TEXTURE_SIZE / 2) as usize,
            "skin-coloured atlas background survived the chroma key"
        );
        for (x, y) in [
            (0, 0),
            (FACE_TEXTURE_SIZE - 1, 0),
            (0, FACE_TEXTURE_SIZE - 1),
            (FACE_TEXTURE_SIZE - 1, FACE_TEXTURE_SIZE - 1),
        ] {
            let offset = ((y * FACE_TEXTURE_SIZE + x) * 4 + 3) as usize;
            assert_eq!(tex.pixels[offset], 0, "corner ({x},{y}) is not transparent");
        }
    }

    #[test]
    fn keying_the_face_panel_erases_its_skin_canvas_and_keeps_features() {
        // A shipped panel is a flat skin canvas with painted features on top.
        // Keying must leave the canvas fully transparent so the head's own
        // tinted skin reads through, and keep the features fully opaque.
        let canvas = [204u8, 153, 120];
        let (w, h) = (32u32, 32u32);
        let mut pixels = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                // A dark brow band across the middle; canvas everywhere else.
                let feature = (12..20).contains(&y) && (6..26).contains(&x);
                let rgb = if feature { [48u8, 32, 28] } else { canvas };
                pixels.extend_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
            }
        }
        let panel = RgbaImage {
            width: w,
            height: h,
            pixels,
        };

        let keyed = key_face_panel(&panel);
        let alpha_at = |x: u32, y: u32| keyed.pixels[((y * w + x) * 4 + 3) as usize];
        assert_eq!(alpha_at(1, 1), 0, "canvas corner must key out");
        assert_eq!(alpha_at(16, 4), 0, "canvas above the brow must key out");
        assert_eq!(alpha_at(16, 16), 255, "the painted brow must stay opaque");

        // Colour is untouched; only alpha changes.
        let feature_index = ((16 * w + 16) * 4) as usize;
        assert_eq!(
            &keyed.pixels[feature_index..feature_index + 3],
            &[48, 32, 28]
        );

        // Canvas shading drift inside the keep band still keys out.
        let mut drifted = RgbaImage {
            width: w,
            height: h,
            pixels: vec![0u8; (w * h * 4) as usize],
        };
        for index in (0..drifted.pixels.len()).step_by(4) {
            drifted.pixels[index] = 213;
            drifted.pixels[index + 1] = 162;
            drifted.pixels[index + 2] = 129;
            drifted.pixels[index + 3] = 255;
        }
        let drifted = key_face_panel(&drifted);
        assert!(
            drifted.pixels.iter().skip(3).step_by(4).all(|a| *a == 0),
            "a uniformly shaded canvas must key out entirely"
        );
    }
}
