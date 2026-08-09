//! Screen-space text layout using the baked 5×7 bitmap font.
//!
//! Each glyph is drawn as one small quad per lit pixel (`font::glyph`), reusing
//! the solid-quad text shader (`gpu::QUAD_LAYOUT`: `pos:2, uv:2`, NDC). This
//! yields readable HUD text with no atlas texture and no per-frame heap
//! allocation (quads accumulate into a caller-owned, reused buffer).

use crate::font::{glyph, GLYPH_H, GLYPH_W};
use alloc::vec::Vec;

/// Append pixel quads for `text` starting at NDC `(x, y)` (top-left of the first
/// glyph cell), where `cell_w`/`cell_h` are the full advance-cell size in NDC
/// (glyph = 5×7 pixels plus a 1-pixel gap → 6×8 cell). Whitespace and unmapped
/// characters advance without emitting quads. Returns the number of quads
/// (lit pixels) appended.
pub fn push_text_quads(
    text: &str,
    x: f32,
    y: f32,
    cell_w: f32,
    cell_h: f32,
    out: &mut Vec<f32>,
) -> u32 {
    // Sub-cell pixel size: 6 columns (5 glyph + 1 gap), 8 rows (7 glyph + 1 gap).
    let px = cell_w / (GLYPH_W as f32 + 1.0);
    let py = cell_h / (GLYPH_H as f32 + 1.0);
    let mut cursor = x;
    let mut count = 0u32;
    for ch in text.chars() {
        if let Some(rows) = glyph(ch) {
            for (r, row) in rows.iter().enumerate() {
                let bits = *row;
                for c in 0..GLYPH_W {
                    // bit (GLYPH_W-1 - c) is column c (bit 4 = leftmost).
                    if bits & (1 << (GLYPH_W - 1 - c)) != 0 {
                        let x0 = cursor + c as f32 * px;
                        let x1 = x0 + px;
                        let y1 = y - r as f32 * py;
                        let y0 = y1 - py;
                        out.extend_from_slice(&[x0, y0, 0.0, 0.0]);
                        out.extend_from_slice(&[x1, y0, 1.0, 0.0]);
                        out.extend_from_slice(&[x1, y1, 1.0, 1.0]);
                        out.extend_from_slice(&[x0, y0, 0.0, 0.0]);
                        out.extend_from_slice(&[x1, y1, 1.0, 1.0]);
                        out.extend_from_slice(&[x0, y1, 0.0, 1.0]);
                        count += 1;
                    }
                }
            }
        }
        cursor += cell_w;
    }
    count
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;

    #[test]
    fn emits_pixel_quads_and_skips_spaces() {
        let mut buf = Vec::new();
        // 'A' has 15 lit pixels in the 5×7 table; space emits none.
        let lit_a: u32 = crate::font::glyph('A')
            .unwrap()
            .iter()
            .map(|r| r.count_ones())
            .sum();
        let n = push_text_quads("A A", 0.0, 1.0, 0.06, 0.08, &mut buf);
        assert_eq!(n, lit_a * 2, "two 'A's, space contributes nothing");
        assert_eq!(buf.len() as u32, n * 6 * 4, "6 verts * 4 floats per quad");
    }

    #[test]
    fn advances_by_cell_per_char() {
        // First lit pixel of "1" (top of stem at column 2) should sit within the
        // first cell; the second char starts a full cell to the right.
        let mut buf = Vec::new();
        let n = push_text_quads("11", 0.0, 1.0, 0.06, 0.08, &mut buf);
        assert!(n > 0);
        // x of the last vertex group must be >= one cell width in.
        let last_x = buf[buf.len() - 4 * 6];
        assert!(last_x >= 0.06, "second glyph advanced by a cell");
    }
}
