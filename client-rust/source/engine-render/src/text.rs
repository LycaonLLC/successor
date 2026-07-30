//! Screen-space text layout.
//!
//! v1 uses a block-glyph representation: each non-space character emits one
//! filled cell quad advancing along X. This makes the `TextOverlay` ECS path
//! real and allocation-free (quads accumulate into a caller-owned, reused
//! buffer), while true bitmap-font rasterization (an `8x16` atlas sampled per
//! glyph) is tracked as a `PARITY.md` follow-up. Quads use `gpu::QUAD_LAYOUT`
//! (`pos:2, uv:2`) in NDC; the text shader fills them with a solid color.

use alloc::vec::Vec;

/// Append block-cell quads for `text` starting at NDC `(x, y)` (top-left),
/// advancing right by `cell_w` with cell height `cell_h`. Whitespace advances
/// without emitting a quad. Returns the number of quads appended.
pub fn push_text_quads(
    text: &str,
    x: f32,
    y: f32,
    cell_w: f32,
    cell_h: f32,
    out: &mut Vec<f32>,
) -> u32 {
    let mut cursor = x;
    let mut count = 0u32;
    let pad = cell_w * 0.12;
    for ch in text.chars() {
        if ch != ' ' && !ch.is_control() {
            let x0 = cursor + pad;
            let x1 = cursor + cell_w - pad;
            let y0 = y - cell_h;
            let y1 = y;
            // Two triangles as 6 (pos2, uv2) vertices (no shared index buffer so
            // callers can draw arrays directly).
            out.extend_from_slice(&[x0, y0, 0.0, 0.0]);
            out.extend_from_slice(&[x1, y0, 1.0, 0.0]);
            out.extend_from_slice(&[x1, y1, 1.0, 1.0]);
            out.extend_from_slice(&[x0, y0, 0.0, 0.0]);
            out.extend_from_slice(&[x1, y1, 1.0, 1.0]);
            out.extend_from_slice(&[x0, y1, 0.0, 1.0]);
            count += 1;
        }
        cursor += cell_w;
    }
    count
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;

    #[test]
    fn emits_quad_per_visible_char_and_skips_spaces() {
        let mut buf = Vec::new();
        let n = push_text_quads("ab c", 0.0, 1.0, 0.02, 0.04, &mut buf);
        assert_eq!(n, 3, "3 visible chars, space skipped");
        assert_eq!(buf.len(), 3 * 6 * 4, "6 verts * 4 floats per visible char");
    }
}
