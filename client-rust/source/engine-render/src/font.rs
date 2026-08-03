//! Baked 5×7 bitmap font (uppercase, digits, punctuation) for HUD/UI text.
//!
//! This is the "font" output of the asset bake step: a compact, deterministic
//! glyph table (no external font file — the repo ships only a Saira woff2, which
//! is display-only and not runtime-rasterizable here). Each glyph is 7 rows;
//! each row's low 5 bits are columns, bit 4 = leftmost. Lowercase folds to
//! uppercase. The text pass emits one small quad per lit pixel, reusing the
//! existing solid-quad text shader (no atlas texture required).

use alloc::vec::Vec;

/// Glyph cell dimensions in pixels (5 wide, 7 tall) + 1px inter-glyph advance.
pub const GLYPH_W: u32 = 5;
pub const GLYPH_H: u32 = 7;
/// Shared text advance in legacy `px` units. Kept fixed so existing HUD
/// geometry remains allocation-free while the rendered glyphs are antialiased.
pub const GLYPH_ADVANCE: f32 = 5.5;

/// PT Sans advance estimate in legacy `px` units. Runtime drawing uses the
/// exact rasterized advance; this allocation-free table keeps static layout
/// measurement within a fraction of a pixel for the supported ASCII UI set.
pub fn text_advance(ch: char) -> f32 {
    let em = match ch {
        ' ' => 0.30,
        'I' | 'i' | 'l' | '!' | '|' | '\'' | '.' | ',' | ':' | ';' => 0.28,
        'f' | 'j' | 'r' | 't' | '(' | ')' | '[' | ']' => 0.36,
        'm' | 'w' => 0.78,
        'M' | 'W' => 0.84,
        '-' | '_' | '/' | '\\' => 0.40,
        '0'..='9' => 0.54,
        'A'..='Z' => 0.60,
        'a'..='z' => 0.50,
        _ => 0.55,
    };
    em * 8.75
}

/// One pre-rasterized glyph inside the shared UI texture atlas.
#[derive(Clone, Copy, Debug, Default)]
pub struct RasterGlyph {
    pub ch: char,
    pub uv: (f32, f32, f32, f32),
    pub width: f32,
    pub height: f32,
    pub xmin: f32,
    pub ymin: f32,
    pub advance: f32,
}

/// Startup-built scalable font metadata. Glyph coverage lives in the same
/// texture as UI icons, preserving the renderer's single blended UI pass.
#[derive(Clone, Debug)]
pub struct RasterFont {
    pub source_px: f32,
    pub ascent: f32,
    pub line_height: f32,
    pub glyphs: Vec<RasterGlyph>,
}

impl RasterFont {
    pub fn glyph(&self, ch: char) -> Option<RasterGlyph> {
        self.glyphs
            .iter()
            .find(|glyph| glyph.ch == ch)
            .copied()
            .or_else(|| self.glyphs.iter().find(|glyph| glyph.ch == '?').copied())
    }
}

/// Row bitmaps for a character, or `None` for unmapped (rendered blank).
pub fn glyph(ch: char) -> Option<[u8; 7]> {
    let c = ch.to_ascii_uppercase();
    Some(match c {
        ' ' => [0, 0, 0, 0, 0, 0, 0],
        '0' => [
            0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110,
        ],
        '1' => [
            0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
        ],
        '2' => [
            0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111,
        ],
        '3' => [
            0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110,
        ],
        '4' => [
            0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010,
        ],
        '5' => [
            0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110,
        ],
        '6' => [
            0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110,
        ],
        '7' => [
            0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000,
        ],
        '8' => [
            0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110,
        ],
        '9' => [
            0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100,
        ],
        'A' => [
            0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001,
        ],
        'B' => [
            0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110,
        ],
        'C' => [
            0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110,
        ],
        'D' => [
            0b11100, 0b10010, 0b10001, 0b10001, 0b10001, 0b10010, 0b11100,
        ],
        'E' => [
            0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111,
        ],
        'F' => [
            0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000,
        ],
        'G' => [
            0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111,
        ],
        'H' => [
            0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001,
        ],
        'I' => [
            0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
        ],
        'J' => [
            0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100,
        ],
        'K' => [
            0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001,
        ],
        'L' => [
            0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111,
        ],
        'M' => [
            0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001,
        ],
        'N' => [
            0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001, 0b10001,
        ],
        'O' => [
            0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110,
        ],
        'P' => [
            0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000,
        ],
        'Q' => [
            0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101,
        ],
        'R' => [
            0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001,
        ],
        'S' => [
            0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110,
        ],
        'T' => [
            0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100,
        ],
        'U' => [
            0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110,
        ],
        'V' => [
            0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100,
        ],
        'W' => [
            0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b11011, 0b10001,
        ],
        'X' => [
            0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001,
        ],
        'Y' => [
            0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100,
        ],
        'Z' => [
            0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111,
        ],
        '.' => [0, 0, 0, 0, 0, 0b00110, 0b00110],
        ',' => [0, 0, 0, 0, 0b00110, 0b00100, 0b01000],
        ':' => [0, 0b00110, 0b00110, 0, 0b00110, 0b00110, 0],
        '-' => [0, 0, 0, 0b11111, 0, 0, 0],
        '_' => [0, 0, 0, 0, 0, 0, 0b11111],
        '/' => [
            0b00001, 0b00010, 0b00100, 0b00100, 0b01000, 0b10000, 0b10000,
        ],
        '(' => [
            0b00010, 0b00100, 0b01000, 0b01000, 0b01000, 0b00100, 0b00010,
        ],
        ')' => [
            0b01000, 0b00100, 0b00010, 0b00010, 0b00010, 0b00100, 0b01000,
        ],
        '+' => [0, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0],
        '!' => [0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0, 0b00100],
        '?' => [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0, 0b00100],
        '\'' => [0b00100, 0b00100, 0b01000, 0, 0, 0, 0],
        '<' => [
            0b00010, 0b00100, 0b01000, 0b10000, 0b01000, 0b00100, 0b00010,
        ],
        '>' => [
            0b01000, 0b00100, 0b00010, 0b00001, 0b00010, 0b00100, 0b01000,
        ],
        '=' => [0, 0, 0b11111, 0, 0b11111, 0, 0],
        '#' => [
            0b01010, 0b11111, 0b01010, 0b01010, 0b01010, 0b11111, 0b01010,
        ],
        '*' => [0, 0b00100, 0b10101, 0b01110, 0b10101, 0b00100, 0],
        '%' => [0b11001, 0b11010, 0b00100, 0b01000, 0b10110, 0b00101, 0],
        _ => return None,
    })
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;

    #[test]
    fn known_glyph_shape() {
        // 'A' top row is a centered arc: 0b01110.
        assert_eq!(glyph('A').unwrap()[0], 0b01110);
        // Lowercase folds to uppercase.
        assert_eq!(glyph('a'), glyph('A'));
    }

    #[test]
    fn space_is_blank_unknown_is_none() {
        assert_eq!(glyph(' ').unwrap(), [0; 7]);
        assert!(glyph('€').is_none());
    }
}
