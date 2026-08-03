//! Immediate-mode UI draw-list builder.
//!
//! Widgets accumulate into a single reused vertex buffer (`UI_LAYOUT`:
//! `pos:2, uv:2, color:4`, NDC) so a whole frame's chrome — panels, borders,
//! text, and icons — draws in one blended pass over the 3D scene. Solid quads
//! carry `uv.x = -1` (the shader ignores the atlas); icon quads carry atlas UVs.
//! Coordinates are supplied in top-left-origin screen pixels and converted to
//! NDC here. The buffer is caller-owned and cleared per frame → no per-frame
//! heap growth once warmed.

use crate::font::{glyph, text_advance, RasterFont, GLYPH_H, GLYPH_W};
use alloc::vec::Vec;

/// Layout of the baked icon atlas (from `icons.json`).
#[derive(Clone, Copy, Debug)]
pub struct AtlasMeta {
    pub cell: u32,
    pub cols: u32,
    pub width: u32,
    pub height: u32,
}

impl AtlasMeta {
    /// Cell → UV rect `(u0, v0, u1, v1)`.
    pub fn uv(&self, col: u32, row: u32) -> (f32, f32, f32, f32) {
        let cw = self.cell as f32 / self.width as f32;
        let ch = self.cell as f32 / self.height as f32;
        let u0 = col as f32 * cw;
        let v0 = row as f32 * ch;
        (u0, v0, u0 + cw, v0 + ch)
    }
}

/// Fixed-cost immediate-mode skin for a nine-slice rectangle.
/// The center is painted first, then corners, then edges; each region stretches
/// independently and no geometry is allocated after warmup.
#[derive(Clone, Copy, Debug)]
pub struct RectangleStyle {
    pub north: [u8; 4],
    pub south: [u8; 4],
    pub east: [u8; 4],
    pub west: [u8; 4],
    pub center: [u8; 4],
    pub north_east: [u8; 4],
    pub north_west: [u8; 4],
    pub south_east: [u8; 4],
    pub south_west: [u8; 4],
    pub west_width: f32,
    pub east_width: f32,
    pub north_height: f32,
    pub south_height: f32,
}

pub struct UiBuilder {
    pub buf: Vec<f32>,
    pub quads: u32,
    sw: f32,
    sh: f32,
    atlas: AtlasMeta,
    font: Option<RasterFont>,
    // Input for this frame (screen px + button edges).
    mx: f32,
    my: f32,
    mdown: bool,
    mpressed: bool,
    mreleased: bool,
    prev_down: bool,
    input_enabled: bool,
}

impl UiBuilder {
    pub fn new(atlas: AtlasMeta) -> Self {
        Self {
            buf: Vec::with_capacity(64 * 1024),
            quads: 0,
            sw: 1.0,
            sh: 1.0,
            atlas,
            font: None,
            mx: 0.0,
            my: 0.0,
            mdown: false,
            mpressed: false,
            mreleased: false,
            prev_down: false,
            input_enabled: true,
        }
    }

    /// Attach a startup-rasterized font packed into the UI icon atlas.
    pub fn new_with_font(atlas: AtlasMeta, font: RasterFont) -> Self {
        let mut ui = Self::new(atlas);
        ui.font = Some(font);
        ui
    }

    /// Feed this frame's pointer state (screen px, left-button held). Call
    /// before `begin`; edges (`pressed`/`released`) are derived from the
    /// previous frame's held state.
    pub fn set_input(&mut self, mouse_x: f32, mouse_y: f32, mouse_down: bool) {
        self.mx = mouse_x;
        self.my = mouse_y;
        self.mpressed = mouse_down && !self.prev_down;
        self.mreleased = !mouse_down && self.prev_down;
        self.mdown = mouse_down;
        self.prev_down = mouse_down;
    }

    pub fn mouse(&self) -> (f32, f32) {
        (self.mx, self.my)
    }

    /// Temporarily suppress widget interaction while still drawing the same
    /// immediate-mode layer. Hosts use this when a modal overlay owns input.
    pub fn set_input_enabled(&mut self, enabled: bool) {
        self.input_enabled = enabled;
    }

    /// Reset for a new frame at the given framebuffer size (pixels).
    pub fn begin(&mut self, screen_w: u32, screen_h: u32) {
        self.buf.clear();
        self.quads = 0;
        self.sw = screen_w.max(1) as f32;
        self.sh = screen_h.max(1) as f32;
    }

    #[inline]
    fn ndc_x(&self, px: f32) -> f32 {
        px / self.sw * 2.0 - 1.0
    }
    #[inline]
    fn ndc_y(&self, py: f32) -> f32 {
        1.0 - py / self.sh * 2.0
    }

    /// Emit one quad. `u0<0` ⇒ solid color (atlas ignored).
    fn push_quad(&mut self, x: f32, y: f32, w: f32, h: f32, uv: (f32, f32, f32, f32), c: [u8; 4]) {
        let x0 = self.ndc_x(x);
        let x1 = self.ndc_x(x + w);
        let y0 = self.ndc_y(y + h); // bottom (larger py → smaller ndc)
        let y1 = self.ndc_y(y); // top
        let (u0, v0, u1, v1) = uv;
        let col = [
            c[0] as f32 / 255.0,
            c[1] as f32 / 255.0,
            c[2] as f32 / 255.0,
            c[3] as f32 / 255.0,
        ];
        // v flips: uv.v0 is the top of the cell → maps to y1 (screen top).
        let mut push = |px: f32, py: f32, u: f32, v: f32| {
            self.buf
                .extend_from_slice(&[px, py, u, v, col[0], col[1], col[2], col[3]]);
        };
        push(x0, y0, u0, v1);
        push(x1, y0, u1, v1);
        push(x1, y1, u1, v0);
        push(x0, y0, u0, v1);
        push(x1, y1, u1, v0);
        push(x0, y1, u0, v0);
        self.quads += 1;
    }

    fn push_solid_quad(&mut self, points: [(f32, f32); 4], c: [u8; 4]) {
        let col = [
            c[0] as f32 / 255.0,
            c[1] as f32 / 255.0,
            c[2] as f32 / 255.0,
            c[3] as f32 / 255.0,
        ];
        for index in [0usize, 1, 2, 0, 2, 3] {
            let (x, y) = points[index];
            self.buf.extend_from_slice(&[
                self.ndc_x(x),
                self.ndc_y(y),
                -1.0,
                -1.0,
                col[0],
                col[1],
                col[2],
                col[3],
            ]);
        }
        self.quads += 1;
    }

    /// Solid antialiased-by-MSAA line segment with arbitrary orientation.
    pub fn line(&mut self, x0: f32, y0: f32, x1: f32, y1: f32, thickness: f32, rgba: [u8; 4]) {
        let dx = x1 - x0;
        let dy = y1 - y0;
        let length = libm::sqrtf(dx * dx + dy * dy);
        if length <= f32::EPSILON || thickness <= 0.0 {
            return;
        }
        let half = thickness * 0.5;
        let nx = -dy / length * half;
        let ny = dx / length * half;
        self.push_solid_quad(
            [
                (x0 + nx, y0 + ny),
                (x1 + nx, y1 + ny),
                (x1 - nx, y1 - ny),
                (x0 - nx, y0 - ny),
            ],
            rgba,
        );
    }

    /// Fixed-segment circular stroke. Intended for instruments, not arbitrary
    /// vector art; it emits exactly `segments` quads without heap growth.
    pub fn ring(
        &mut self,
        cx: f32,
        cy: f32,
        radius: f32,
        segments: u32,
        thickness: f32,
        rgba: [u8; 4],
    ) {
        if segments < 3 || radius <= 0.0 {
            return;
        }
        let mut x0 = cx + radius;
        let mut y0 = cy;
        for index in 1..=segments {
            let angle = index as f32 / segments as f32 * core::f32::consts::TAU;
            let x1 = cx + libm::cosf(angle) * radius;
            let y1 = cy + libm::sinf(angle) * radius;
            self.line(x0, y0, x1, y1, thickness, rgba);
            x0 = x1;
            y0 = y1;
        }
    }

    /// Filled rectangle (screen px, top-left origin).
    pub fn rect(&mut self, x: f32, y: f32, w: f32, h: f32, rgba: [u8; 4]) {
        self.push_quad(x, y, w, h, (-1.0, -1.0, -1.0, -1.0), rgba);
    }

    /// 1px..Npx border stroke around a rect (four edges, drawn inside the rect).
    pub fn border(&mut self, x: f32, y: f32, w: f32, h: f32, t: f32, rgba: [u8; 4]) {
        self.rect(x, y, w, t, rgba); // top
        self.rect(x, y + h - t, w, t, rgba); // bottom
        self.rect(x, y, t, h, rgba); // left
        self.rect(x + w - t, y, t, h, rgba); // right
    }

    /// A filled panel. Callers that need a semantic rail or focus indicator
    /// draw that one accent explicitly instead of framing every surface.
    pub fn panel(&mut self, x: f32, y: f32, w: f32, h: f32, fill: [u8; 4], _edge: [u8; 4]) {
        self.rect(x, y, w, h, fill);
    }

    /// Render the nine independently stretched regions of a rectangle style.
    /// The center is painted first, followed by corners and edges.
    pub fn nine_slice(&mut self, x: f32, y: f32, w: f32, h: f32, style: &RectangleStyle) {
        let west = style.west_width.max(0.0).min(w * 0.5);
        let east = style.east_width.max(0.0).min(w * 0.5);
        let north = style.north_height.max(0.0).min(h * 0.5);
        let south = style.south_height.max(0.0).min(h * 0.5);
        let center_w = (w - west - east).max(0.0);
        let center_h = (h - north - south).max(0.0);

        if center_w > 0.0 && center_h > 0.0 {
            self.rect(x + west, y + north, center_w, center_h, style.center);
        }
        if east > 0.0 && north > 0.0 {
            self.rect(x + w - east, y, east, north, style.north_east);
        }
        if west > 0.0 && north > 0.0 {
            self.rect(x, y, west, north, style.north_west);
        }
        if east > 0.0 && south > 0.0 {
            self.rect(x + w - east, y + h - south, east, south, style.south_east);
        }
        if west > 0.0 && south > 0.0 {
            self.rect(x, y + h - south, west, south, style.south_west);
        }
        if west > 0.0 && center_h > 0.0 {
            self.rect(x, y + north, west, center_h, style.west);
        }
        if east > 0.0 && center_h > 0.0 {
            self.rect(x + w - east, y + north, east, center_h, style.east);
        }
        if north > 0.0 && center_w > 0.0 {
            self.rect(x + west, y, center_w, north, style.north);
        }
        if south > 0.0 && center_w > 0.0 {
            self.rect(x + west, y + h - south, center_w, south, style.south);
        }
    }

    /// Draw `text` at `(x, y)` (top-left) with a glyph pixel size of `px`
    /// (each 5×7 dot is `px`×`px`). Returns the advanced x cursor.
    pub fn text(&mut self, text: &str, x: f32, y: f32, px: f32, rgba: [u8; 4]) -> f32 {
        if self.font.is_some() {
            return self.raster_text(text, x, y, px, rgba);
        }
        let mut cursor = x;
        for ch in text.chars() {
            if let Some(rows) = glyph(ch) {
                for (r, row) in rows.iter().enumerate() {
                    let bits = *row;
                    for col in 0..GLYPH_W {
                        if bits & (1 << (GLYPH_W - 1 - col)) != 0 {
                            self.rect(cursor + col as f32 * px, y + r as f32 * px, px, px, rgba);
                        }
                    }
                }
            }
            cursor += text_advance(ch) * px;
        }
        cursor
    }

    fn raster_text(&mut self, text: &str, x: f32, y: f32, px: f32, rgba: [u8; 4]) -> f32 {
        let (ascent, line_height) = {
            let font = self.font.as_ref().expect("raster font checked");
            (font.ascent, font.line_height)
        };
        let target_height = 8.75 * px;
        let scale = target_height / line_height.max(1.0);
        let mut cursor = x;
        for ch in text.chars() {
            if let Some(glyph) = self.font.as_ref().and_then(|font| font.glyph(ch)) {
                if glyph.width > 0.0 && glyph.height > 0.0 {
                    let gx = cursor + glyph.xmin * scale;
                    let gy = y + (ascent - (glyph.ymin + glyph.height)) * scale;
                    self.push_quad(
                        gx,
                        gy,
                        glyph.width * scale,
                        glyph.height * scale,
                        glyph.uv,
                        rgba,
                    );
                }
                cursor += glyph.advance * scale;
            } else {
                cursor += text_advance(ch) * px;
            }
        }
        cursor
    }

    /// Pixel width a string will occupy at glyph size `px`.
    pub fn text_width(text: &str, px: f32) -> f32 {
        text.chars().map(text_advance).sum::<f32>() * px
    }

    /// An icon from the baked atlas, scaled into `w`×`h` at `(x, y)`, tinted.
    #[allow(clippy::too_many_arguments)]
    pub fn icon(&mut self, col: u32, row: u32, x: f32, y: f32, w: f32, h: f32, rgba: [u8; 4]) {
        let uv = self.atlas.uv(col, row);
        self.push_quad(x, y, w, h, uv, rgba);
    }

    /// Whether `(mx, my)` (screen px) lies inside a rect — hit-testing helper.
    pub fn hit(x: f32, y: f32, w: f32, h: f32, mx: f32, my: f32) -> bool {
        mx >= x && mx < x + w && my >= y && my < y + h
    }

    /// Pointer hover/press/click state for a rect this frame.
    pub fn interact(&self, x: f32, y: f32, w: f32, h: f32) -> Response {
        if !self.input_enabled {
            return Response::default();
        }
        let over = Self::hit(x, y, w, h, self.mx, self.my);
        Response {
            hovered: over,
            pressed: over && self.mpressed,
            released: over && self.mreleased,
            clicked: over && self.mreleased,
            held: over && self.mdown,
        }
    }

    /// A labeled button. Draws a hover/press-tinted body + centered text and
    /// returns whether it was clicked (released inside) this frame.
    pub fn button(
        &mut self,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        label: &str,
        style: ButtonStyle,
    ) -> bool {
        let r = self.interact(x, y, w, h);
        let fill = if r.held {
            style.active
        } else if r.hovered {
            style.hover
        } else {
            style.fill
        };
        self.rect(x, y, w, h, fill);
        // Size the 5×7 label so it fits the button: glyph height = 7·px must fit
        // ~half the height, and the whole label width = n·6·px must fit ~85% of
        // the width — take the smaller so long labels ("UNEQUIP") never overflow.
        let n = label.chars().count().max(1) as f32;
        let px_h = (h * 0.5) / GLYPH_H as f32;
        let px_w = (w * 0.85) / (n * (GLYPH_W as f32 + 1.0));
        let px = px_h.min(px_w).max(1.0);
        let tw = Self::text_width(label, px);
        let tx = x + (w - tw) * 0.5;
        let ty = y + (h - GLYPH_H as f32 * px) * 0.5;
        self.text(label, tx, ty, px, style.text);
        r.clicked
    }

    /// An icon button (atlas glyph centered in a hover-tinted slot). Returns
    /// whether it was clicked this frame.
    pub fn icon_button(
        &mut self,
        col: u32,
        row: u32,
        x: f32,
        y: f32,
        size: f32,
        style: ButtonStyle,
    ) -> bool {
        let r = self.interact(x, y, size, size);
        let fill = if r.held {
            style.active
        } else if r.hovered {
            style.hover
        } else {
            style.fill
        };
        self.rect(x, y, size, size, fill);
        let pad = size * 0.18;
        self.icon(
            col,
            row,
            x + pad,
            y + pad,
            size - 2.0 * pad,
            size - 2.0 * pad,
            style.text,
        );
        r.clicked
    }

    /// A compact checkbox with a text label. Returns true when the value
    /// changed this frame.
    pub fn checkbox(&mut self, x: f32, y: f32, size: f32, label: &str, value: &mut bool) -> bool {
        let label_w = Self::text_width(label, 1.5);
        let response = self.interact(x, y, size + 8.0 + label_w, size);
        let changed = response.clicked;
        if changed {
            *value = !*value;
        }
        self.rect(x, y, size, size, [18, 24, 34, 235]);
        self.border(
            x,
            y,
            size,
            size,
            1.0,
            if response.hovered {
                [240, 196, 96, 255]
            } else {
                [90, 112, 138, 255]
            },
        );
        if *value {
            let pad = (size * 0.24).max(2.0);
            self.rect(
                x + pad,
                y + pad,
                size - pad * 2.0,
                size - pad * 2.0,
                [240, 196, 96, 255],
            );
        }
        let ty = y + (size - GLYPH_H as f32 * 1.5) * 0.5;
        self.text(label, x + size + 8.0, ty, 1.5, [210, 222, 236, 255]);
        changed
    }

    /// Horizontal floating-point slider. Clicking or dragging on the track
    /// updates `value`; the caller owns labels and numeric formatting.
    #[allow(clippy::too_many_arguments)]
    pub fn slider(
        &mut self,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        value: &mut f32,
        min: f32,
        max: f32,
    ) -> bool {
        let response = self.interact(x, y, w, h);
        let mut changed = false;
        if (response.pressed || response.held) && max > min {
            let next = (min + ((self.mx - x) / w).clamp(0.0, 1.0) * (max - min)).clamp(min, max);
            changed = (next - *value).abs() > f32::EPSILON;
            *value = next;
        }
        let t = if max > min {
            ((*value - min) / (max - min)).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let track_y = y + h * 0.5 - 2.0;
        self.rect(x, track_y, w, 4.0, [38, 50, 66, 255]);
        self.rect(x, track_y, w * t, 4.0, [220, 170, 74, 255]);
        let thumb = 10.0;
        let thumb_x = x + w * t - thumb * 0.5;
        self.rect(
            thumb_x,
            y + (h - thumb) * 0.5,
            thumb,
            thumb,
            if response.held {
                [255, 218, 122, 255]
            } else {
                [236, 192, 92, 255]
            },
        );
        changed
    }
}

/// Result of pointer interaction with a rect for one frame.
#[derive(Clone, Copy, Debug, Default)]
pub struct Response {
    pub hovered: bool,
    pub pressed: bool,
    pub released: bool,
    pub clicked: bool,
    pub held: bool,
}

/// Colors for `button`/`icon_button` across idle/hover/active states.
#[derive(Clone, Copy, Debug)]
pub struct ButtonStyle {
    pub fill: [u8; 4],
    pub hover: [u8; 4],
    pub active: [u8; 4],
    pub edge: [u8; 4],
    pub text: [u8; 4],
}

impl Default for ButtonStyle {
    fn default() -> Self {
        Self {
            fill: [30, 40, 54, 210],
            hover: [48, 62, 82, 230],
            active: [70, 92, 120, 240],
            edge: [80, 100, 122, 255],
            text: [210, 222, 236, 255],
        }
    }
}

/// A single-line text edit buffer. The host feeds characters (from
/// `poll_text_input`) and control keys; the widget owns the string + caret and
/// only draws when handed to `UiBuilder::text_field`.
#[derive(Clone, Debug, Default)]
pub struct TextField {
    pub text: alloc::string::String,
    pub focused: bool,
    pub caret: usize,
    pub max_len: usize,
}

impl TextField {
    pub fn new(max_len: usize) -> Self {
        Self {
            text: alloc::string::String::new(),
            focused: false,
            caret: 0,
            max_len,
        }
    }

    /// Insert a printable character at the caret (bounded by `max_len`).
    pub fn insert(&mut self, c: char) {
        if c.is_control() || (self.max_len != 0 && self.text.chars().count() >= self.max_len) {
            return;
        }
        let byte = self.byte_at(self.caret);
        self.text.insert(byte, c);
        self.caret += 1;
    }

    /// Delete the character before the caret.
    pub fn backspace(&mut self) {
        if self.caret == 0 {
            return;
        }
        let end = self.byte_at(self.caret);
        let start = self.byte_at(self.caret - 1);
        self.text.replace_range(start..end, "");
        self.caret -= 1;
    }

    pub fn clear(&mut self) {
        self.text.clear();
        self.caret = 0;
    }

    pub fn move_left(&mut self) {
        self.caret = self.caret.saturating_sub(1);
    }
    pub fn move_right(&mut self) {
        let n = self.text.chars().count();
        if self.caret < n {
            self.caret += 1;
        }
    }

    /// Byte offset of the `n`-th char (for insert/delete on UTF-8 text).
    fn byte_at(&self, n: usize) -> usize {
        self.text
            .char_indices()
            .nth(n)
            .map(|(b, _)| b)
            .unwrap_or(self.text.len())
    }
}

impl UiBuilder {
    /// Draw a text-field box; clicking toggles focus. Renders the buffer and,
    /// when focused, a caret. Returns the field's interaction response.
    #[allow(clippy::too_many_arguments)]
    pub fn text_field(
        &mut self,
        field: &mut TextField,
        x: f32,
        y: f32,
        w: f32,
        h: f32,
        px: f32,
        show_caret: bool,
    ) -> Response {
        let r = self.interact(x, y, w, h);
        if r.clicked {
            field.focused = true;
        } else if self.mpressed && !r.hovered {
            field.focused = false;
        }
        let edge = if field.focused {
            [240, 196, 96, 255]
        } else {
            [80, 100, 122, 255]
        };
        self.rect(x, y, w, h, [18, 24, 34, 220]);
        self.border(x, y, w, h, 1.0, edge);
        let ty = y + (h - GLYPH_H as f32 * px) * 0.5;
        let end = self.text(&field.text, x + 6.0, ty, px, [210, 222, 236, 255]);
        if field.focused && show_caret {
            self.rect(end + 1.0, ty, px, GLYPH_H as f32 * px, [240, 196, 96, 255]);
        }
        r
    }
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;

    const ATLAS: AtlasMeta = AtlasMeta {
        cell: 32,
        cols: 8,
        width: 256,
        height: 160,
    };

    #[test]
    fn rect_emits_one_quad_solid() {
        let mut ui = UiBuilder::new(ATLAS);
        ui.begin(1000, 500);
        ui.rect(100.0, 50.0, 200.0, 40.0, [10, 20, 30, 255]);
        assert_eq!(ui.quads, 1);
        assert_eq!(ui.buf.len(), 6 * 8);
        // uv.x sentinel < 0 for solid quads.
        assert!(ui.buf[2] < 0.0);
    }

    #[test]
    fn nine_slice_emits_center_corners_then_edges() {
        let mut ui = UiBuilder::new(ATLAS);
        ui.begin(100, 50);
        let style = RectangleStyle {
            north: [1, 1, 1, 255],
            south: [2, 2, 2, 255],
            east: [3, 3, 3, 255],
            west: [4, 4, 4, 255],
            center: [10, 20, 30, 40],
            north_east: [6, 6, 6, 255],
            north_west: [7, 7, 7, 255],
            south_east: [8, 8, 8, 255],
            south_west: [9, 9, 9, 255],
            west_width: 5.0,
            east_width: 5.0,
            north_height: 4.0,
            south_height: 4.0,
        };
        ui.nine_slice(0.0, 0.0, 100.0, 50.0, &style);
        assert_eq!(ui.quads, 9);
        assert!((ui.buf[4] - 10.0 / 255.0).abs() < 1e-6);
        assert!((ui.buf[7] - 40.0 / 255.0).abs() < 1e-6);
    }

    #[test]
    fn ring_emits_one_oriented_quad_per_segment() {
        let mut ui = UiBuilder::new(ATLAS);
        ui.begin(100, 100);
        ui.ring(50.0, 50.0, 40.0, 32, 1.0, [255; 4]);
        assert_eq!(ui.quads, 32);
        assert_eq!(ui.buf.len(), 32 * 6 * 8);
    }

    #[test]
    fn ndc_maps_corners() {
        let mut ui = UiBuilder::new(ATLAS);
        ui.begin(1000, 500);
        ui.rect(0.0, 0.0, 1000.0, 500.0, [0; 4]);
        // First vertex is bottom-left of the full screen → NDC (-1, -1).
        assert!((ui.buf[0] + 1.0).abs() < 1e-5);
        assert!((ui.buf[1] + 1.0).abs() < 1e-5);
    }

    #[test]
    fn icon_uses_atlas_uv_nonnegative() {
        let mut ui = UiBuilder::new(ATLAS);
        ui.begin(800, 600);
        ui.icon(1, 0, 0.0, 0.0, 32.0, 32.0, [255; 4]);
        // Icon quad uv.x is >= 0 (first cell col 1 → 32/256 = 0.125).
        assert!(ui.buf[2] >= 0.0);
        assert!((ui.buf[2] - 0.125).abs() < 1e-5);
    }

    #[test]
    fn text_advances_and_emits_pixels() {
        let mut ui = UiBuilder::new(ATLAS);
        ui.begin(1920, 1080);
        let end = ui.text("HI", 0.0, 0.0, 2.0, [255; 4]);
        assert!(ui.quads > 0);
        assert!((end - UiBuilder::text_width("HI", 2.0)).abs() < 1e-4);
    }

    #[test]
    fn hit_test() {
        assert!(UiBuilder::hit(10.0, 10.0, 20.0, 20.0, 15.0, 15.0));
        assert!(!UiBuilder::hit(10.0, 10.0, 20.0, 20.0, 31.0, 15.0));
    }

    #[test]
    fn button_click_edge() {
        let mut ui = UiBuilder::new(ATLAS);
        // press inside then release inside → clicked exactly on release frame.
        ui.set_input(50.0, 50.0, true); // press
        ui.begin(800, 600);
        assert!(!ui.button(40.0, 40.0, 40.0, 30.0, "OK", ButtonStyle::default()));
        ui.set_input(50.0, 50.0, false); // release inside
        ui.begin(800, 600);
        assert!(ui.button(40.0, 40.0, 40.0, 30.0, "OK", ButtonStyle::default()));
        // release outside → no click.
        ui.set_input(500.0, 500.0, true);
        ui.begin(800, 600);
        ui.button(40.0, 40.0, 40.0, 30.0, "OK", ButtonStyle::default());
        ui.set_input(500.0, 500.0, false);
        ui.begin(800, 600);
        assert!(!ui.button(40.0, 40.0, 40.0, 30.0, "OK", ButtonStyle::default()));
    }

    #[test]
    fn textfield_edit() {
        let mut f = TextField::new(8);
        f.insert('H');
        f.insert('i');
        assert_eq!(f.text, "Hi");
        assert_eq!(f.caret, 2);
        f.backspace();
        assert_eq!(f.text, "H");
        // control chars ignored.
        f.insert('\n');
        assert_eq!(f.text, "H");
        // max_len bound.
        for _ in 0..20 {
            f.insert('x');
        }
        assert_eq!(f.text.chars().count(), 8);
    }

    #[test]
    fn slider_tracks_pointer_and_clamps() {
        let mut ui = UiBuilder::new(ATLAS);
        let mut value = 0.0;
        ui.set_input(75.0, 15.0, true);
        ui.begin(200, 100);
        assert!(ui.slider(0.0, 0.0, 100.0, 30.0, &mut value, -1.0, 1.0));
        assert!((value - 0.5).abs() < 1.0e-6);
        ui.set_input(150.0, 15.0, true);
        ui.begin(200, 100);
        assert!(!ui.slider(0.0, 0.0, 100.0, 30.0, &mut value, -1.0, 1.0));
        assert!((value - 0.5).abs() < 1.0e-6);
    }

    #[test]
    fn checkbox_changes_on_release_and_modal_capture_suppresses_it() {
        let mut ui = UiBuilder::new(ATLAS);
        let mut value = false;
        ui.set_input(8.0, 8.0, true);
        ui.begin(200, 100);
        assert!(!ui.checkbox(0.0, 0.0, 20.0, "AA", &mut value));
        ui.set_input(8.0, 8.0, false);
        ui.begin(200, 100);
        assert!(ui.checkbox(0.0, 0.0, 20.0, "AA", &mut value));
        assert!(value);

        ui.set_input_enabled(false);
        ui.set_input(8.0, 8.0, true);
        ui.begin(200, 100);
        ui.checkbox(0.0, 0.0, 20.0, "AA", &mut value);
        ui.set_input(8.0, 8.0, false);
        ui.begin(200, 100);
        assert!(!ui.checkbox(0.0, 0.0, 20.0, "AA", &mut value));
        assert!(value);
    }
}
