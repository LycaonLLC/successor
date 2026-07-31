//! Face-kit compositor — port of the texture side of
//! `client-3d/src/render/faceDecal.ts` (+ `assets/faceKit/face-kit`): composite
//! the selected eyes/brows/nose/mouth style cells from the atlas sheets onto a
//! skin-toned 256² face texture, chroma-keying the atlas background. Uses the
//! Wave-1 PNG decoder. The head-overlay geometry projection (attaching this
//! texture to the pawn head) is a follow-on render integration.
//!
//! Atlas contract from `face-kit/metadata/atlas-layout.json`: a 4×2 grid of 8
//! named styles per feature sheet; `backgroundKey` [202,136,97] is transparent.

use successor_engine_core::image::{decode_png, ImageError, RgbaImage};

pub const FACE_TEXTURE_SIZE: u32 = 256;
const GRID_COLS: u32 = 4;
const GRID_ROWS: u32 = 2;
const BG_KEY: [u8; 3] = [202, 136, 97];
const BG_TOLERANCE: i32 = 10;

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

/// Composite a face texture for a style over a skin-toned base. Later features
/// paint over earlier ones (brows/nose/mouth over eyes).
pub fn render_face_texture(kit: &FaceKit, style: usize, skin: [u8; 3]) -> RgbaImage {
    let size = FACE_TEXTURE_SIZE;
    let mut out = RgbaImage {
        width: size,
        height: size,
        pixels: vec![0u8; (size * size * 4) as usize],
    };
    for p in out.pixels.chunks_exact_mut(4) {
        p[0] = skin[0];
        p[1] = skin[1];
        p[2] = skin[2];
        p[3] = 255;
    }
    // Order: eyes, brows, nose, mouth (mouth on top).
    composite_cell(&mut out, &kit.eyes, style);
    composite_cell(&mut out, &kit.brows, style);
    composite_cell(&mut out, &kit.noses, style);
    composite_cell(&mut out, &kit.mouths, style);
    out
}

/// Composite one atlas cell (nearest-scaled to `out`) with chroma-key + alpha.
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
            if a < 8 || is_bg_key(r, g, b) {
                continue;
            }
            let di = ((oy * out.width + ox) * 4) as usize;
            let af = a as f32 / 255.0;
            out.pixels[di] = blend(out.pixels[di], r, af);
            out.pixels[di + 1] = blend(out.pixels[di + 1], g, af);
            out.pixels[di + 2] = blend(out.pixels[di + 2], b, af);
            out.pixels[di + 3] = 255;
        }
    }
}

fn is_bg_key(r: u8, g: u8, b: u8) -> bool {
    (r as i32 - BG_KEY[0] as i32).abs() <= BG_TOLERANCE
        && (g as i32 - BG_KEY[1] as i32).abs() <= BG_TOLERANCE
        && (b as i32 - BG_KEY[2] as i32).abs() <= BG_TOLERANCE
}

fn blend(dst: u8, src: u8, a: f32) -> u8 {
    (dst as f32 * (1.0 - a) + src as f32 * a) as u8
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
    fn composites_real_face_texture() {
        let Ok(kit) = FaceKit::load(FACE_KIT) else {
            eprintln!("skip: face-kit not present");
            return;
        };
        let skin = [204, 153, 120];
        let tex = render_face_texture(&kit, style_index("rogue"), skin);
        assert_eq!(tex.width, FACE_TEXTURE_SIZE);
        assert_eq!(tex.height, FACE_TEXTURE_SIZE);
        // Features must paint SOME pixels different from the flat skin base.
        let mut diff = 0;
        for p in tex.pixels.chunks_exact(4) {
            if p[0] != skin[0] || p[1] != skin[1] || p[2] != skin[2] {
                diff += 1;
            }
        }
        assert!(diff > 100, "expected composited feature pixels, got {diff}");
    }
}
