//! Client-drawn mouse cursor.
//!
//! The original client never let the desktop cursor into the game: it hid the
//! OS pointer, drew its own from a `UICursorSet`, and clipped the hardware
//! cursor to the client rect (`Graphics::constrainMouseCursor` →
//! `ClipCursor`). The set is a vocabulary, not one bitmap — default, selection,
//! attack, activate, resize on four axes, hourglass, drag-bad and friends —
//! and the mediator under the pointer picks the entry.
//!
//! Successor draws that vocabulary instead of shipping bitmaps: every kind here
//! is built from the same primitives the window chrome uses, so the pointer is
//! made of the same material as the frames it sits on (translucent inset pane,
//! one bright perimeter, the window's own drop shadow) and it stays crisp at
//! any framebuffer without an atlas cell per resolution.
//!
//! Geometry is authored in a 16 px design space with the hotspot at the origin
//! and scaled by [`CursorStyle::size`]. Nothing here allocates.

use crate::ui::UiBuilder;

/// Design-space extent the shapes below are authored against.
const DESIGN: f32 = 16.0;

/// Classic arrow silhouette, hotspot first. Every other vertex is visible from
/// the tip, so a triangle fan from `[0]` is a valid fill.
const ARROW: [(f32, f32); 7] = [
    (0.0, 0.0),
    (0.0, 13.6),
    (3.5, 10.2),
    (5.9, 16.0),
    (8.5, 14.8),
    (6.1, 9.2),
    (10.6, 8.6),
];

/// Unit component of a 45-degree axis.
const DIAG: f32 = core::f32::consts::FRAC_1_SQRT_2;

/// What the pointer is over. Named for the original cursor set entries so the
/// mapping to `ui_cursor_*` behaviour stays legible.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum CursorKind {
    /// `ui_cursor_default`.
    #[default]
    Arrow,
    /// `ui_cursor_selection` — over something that answers a click.
    Select,
    /// `ui_cursor_attack` — over a valid hostile target.
    Attack,
    /// `ui_cursor_activate` — over a door, terminal, or other world verb.
    Interact,
    /// `ui_cursor_move` — a frame is being dragged.
    Move,
    /// `ui_cursor_resize_hor`.
    ResizeHorizontal,
    /// `ui_cursor_resize_vert`.
    ResizeVertical,
    /// `ui_cursor_resize_se` — north-west/south-east corner.
    ResizeNwSe,
    /// `ui_cursor_resize_sw` — north-east/south-west corner.
    ResizeNeSw,
    /// Text entry caret.
    Text,
    /// `ui_cursor_hourglass`.
    Busy,
    /// `ui_cursor_drag_bad` — the gesture under the pointer is refused.
    Blocked,
}

impl CursorKind {
    /// Resize cursor for an edge mask, or `None` when no edge is engaged.
    /// A corner wins over a side, which is what the original's hit order does.
    pub fn for_edges(left: bool, right: bool, top: bool, bottom: bool) -> Option<Self> {
        match (left, right, top, bottom) {
            (true, _, true, _) | (_, true, _, true) => Some(Self::ResizeNwSe),
            (_, true, true, _) | (true, _, _, true) => Some(Self::ResizeNeSw),
            (true, _, _, _) | (_, true, _, _) => Some(Self::ResizeHorizontal),
            (_, _, true, _) | (_, _, _, true) => Some(Self::ResizeVertical),
            _ => None,
        }
    }
}

/// Ink for the pointer. Defaults are the window chrome's own tones so the
/// cursor reads as part of the frame set rather than an overlay.
#[derive(Clone, Copy, Debug)]
pub struct CursorStyle {
    /// Body fill. Bright, because a pointer has to stay legible over pale
    /// desert and over a dark pane, and an outline-dominant glyph reads as
    /// mush at cursor size.
    pub fill: [u8; 4],
    /// Border. The caption ink: dark enough to hold the silhouette against
    /// any background without introducing a colour the UI does not already use.
    pub edge: [u8; 4],
    /// State glyphs — reticle, brackets, arrowheads.
    pub accent: [u8; 4],
    /// Drop shadow, matching the window frame's.
    pub shadow: [u8; 4],
    /// Refusal tone for [`CursorKind::Blocked`].
    pub danger: [u8; 4],
    /// Height of the arrow in screen pixels.
    pub size: f32,
}

impl Default for CursorStyle {
    fn default() -> Self {
        Self {
            fill: [0x1C, 0xFF, 0xFF, 242],
            edge: [0x00, 0x35, 0x4F, 255],
            accent: [0x20, 0xE0, 0xF0, 255],
            shadow: [0, 0, 0, 110],
            danger: [0xFF, 0x4C, 0x3A, 240],
            size: 21.0,
        }
    }
}

/// Draw `kind` with its hotspot at `(x, y)`.
///
/// `phase_ms` only drives [`CursorKind::Busy`]; every other kind is static, so
/// a caller that never shows a busy pointer can pass zero.
pub fn draw(ui: &mut UiBuilder, kind: CursorKind, x: f32, y: f32, style: CursorStyle, phase_ms: u64) {
    let s = style.size / DESIGN;
    match kind {
        CursorKind::Arrow => arrow(ui, x, y, s, style),
        CursorKind::Select => {
            arrow(ui, x, y, s, style);
            // A small open reticle off the tail: the original's selection
            // cursor is the arrow plus a target box, not a different pointer.
            let (bx, by) = (x + 9.0 * s, y + 9.0 * s);
            let side = 7.0 * s;
            corner_ticks(ui, [bx, by, side, side], 2.4 * s, 1.2 * s, style.accent);
        }
        CursorKind::Attack => reticle(ui, x, y, s, style),
        CursorKind::Interact => {
            arrow(ui, x, y, s, style);
            chevron(ui, x + 10.0 * s, y + 10.0 * s, 4.5 * s, 1.5 * s, style.accent);
        }
        CursorKind::Move => four_way(ui, x, y, s, style),
        CursorKind::ResizeHorizontal => double_arrow(ui, x, y, 1.0, 0.0, s, style),
        CursorKind::ResizeVertical => double_arrow(ui, x, y, 0.0, 1.0, s, style),
        CursorKind::ResizeNwSe => double_arrow(ui, x, y, DIAG, DIAG, s, style),
        CursorKind::ResizeNeSw => double_arrow(ui, x, y, DIAG, -DIAG, s, style),
        CursorKind::Text => beam(ui, x, y, s, style),
        CursorKind::Busy => busy(ui, x, y, s, style, phase_ms),
        CursorKind::Blocked => {
            arrow(ui, x, y, s, style);
            let (cx, cy) = (x + 11.0 * s, y + 11.0 * s);
            let r = 5.0 * s;
            ui.ring(cx, cy, r, 12, 1.4 * s, style.danger);
            let d = r * DIAG;
            ui.line(cx - d, cy - d, cx + d, cy + d, 1.4 * s, style.danger);
        }
    }
}

/// Filled polygon as a triangle fan from vertex zero. Valid only for shapes
/// that are star-shaped about that vertex, which [`ARROW`] is.
fn fan(ui: &mut UiBuilder, points: &[(f32, f32)], ox: f32, oy: f32, s: f32, rgba: [u8; 4]) {
    let at = |index: usize| {
        let (px, py) = points[index];
        (ox + px * s, oy + py * s)
    };
    let a = at(0);
    for index in 1..points.len() - 1 {
        ui.tri(a, at(index), at(index + 1), rgba);
    }
}

fn outline(ui: &mut UiBuilder, points: &[(f32, f32)], ox: f32, oy: f32, s: f32, w: f32, rgba: [u8; 4]) {
    for index in 0..points.len() {
        let (x0, y0) = points[index];
        let (x1, y1) = points[(index + 1) % points.len()];
        ui.line(ox + x0 * s, oy + y0 * s, ox + x1 * s, oy + y1 * s, w, rgba);
    }
}

fn arrow(ui: &mut UiBuilder, x: f32, y: f32, s: f32, style: CursorStyle) {
    // The frame's own shadow offset, scaled, so the pointer keeps a silhouette
    // over pale desert as well as over a dark pane.
    fan(ui, &ARROW, x + 2.0 * s, y + 3.0 * s, s, style.shadow);
    fan(ui, &ARROW, x, y, s, style.fill);
    // Fixed-width border: scaling the stroke with the glyph would eat the body
    // at cursor sizes, which is exactly what makes small arrows read as mush.
    outline(ui, &ARROW, x, y, s, 1.3, style.edge);
    // Dark notch just below the point. The eye lands on the boundary between
    // the two tones, which is the hotspot, and the arrow stops reading as a
    // flat wedge.
    ui.tri(
        (x + 0.9 * s, y + 2.6 * s),
        (x + 0.9 * s, y + 6.4 * s),
        (x + 3.4 * s, y + 5.6 * s),
        style.edge,
    );
}

/// Target reticle: the original's attack cursor, and where the old fixed
/// screen-centre crosshair's meaning now lives — on the pointer, where the
/// swing is actually aimed.
fn reticle(ui: &mut UiBuilder, x: f32, y: f32, s: f32, style: CursorStyle) {
    let r = 8.0 * s;
    let w = (1.4 * s).max(1.0);
    ui.ring(x, y, r + 1.0, 16, w + 1.0, style.shadow);
    ui.ring(x, y, r, 16, w, style.accent);
    let inner = r * 0.45;
    let outer = r * 1.5;
    for (dx, dy) in [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)] {
        ui.line(
            x + dx * inner,
            y + dy * inner,
            x + dx * outer,
            y + dy * outer,
            w,
            style.accent,
        );
    }
    ui.rect(x - s, y - s, 2.0 * s, 2.0 * s, style.accent);
}

fn four_way(ui: &mut UiBuilder, x: f32, y: f32, s: f32, style: CursorStyle) {
    let arm = 8.0 * s;
    let w = (1.4 * s).max(1.0);
    for (dx, dy) in [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)] {
        ui.line(x, y, x + dx * arm, y + dy * arm, w, style.edge);
        head(ui, x + dx * arm, y + dy * arm, dx, dy, 3.4 * s, style.edge);
    }
    ui.rect(x - 1.5 * s, y - 1.5 * s, 3.0 * s, 3.0 * s, style.accent);
}

/// Double-headed arrow along `(dx, dy)`, centred on the hotspot.
fn double_arrow(ui: &mut UiBuilder, x: f32, y: f32, dx: f32, dy: f32, s: f32, style: CursorStyle) {
    let arm = 8.5 * s;
    let w = (1.5 * s).max(1.0);
    ui.line(
        x - dx * arm + s,
        y - dy * arm + s,
        x + dx * arm + s,
        y + dy * arm + s,
        w + 1.0,
        style.shadow,
    );
    ui.line(x - dx * arm, y - dy * arm, x + dx * arm, y + dy * arm, w, style.edge);
    head(ui, x + dx * arm, y + dy * arm, dx, dy, 4.0 * s, style.accent);
    head(ui, x - dx * arm, y - dy * arm, -dx, -dy, 4.0 * s, style.accent);
}

/// Solid arrowhead at `(hx, hy)` pointing along the unit vector `(dx, dy)`.
fn head(ui: &mut UiBuilder, hx: f32, hy: f32, dx: f32, dy: f32, size: f32, rgba: [u8; 4]) {
    let (nx, ny) = (-dy, dx);
    let base = size * 0.55;
    ui.tri(
        (hx + dx * size, hy + dy * size),
        (hx + nx * base, hy + ny * base),
        (hx - nx * base, hy - ny * base),
        rgba,
    );
}

fn beam(ui: &mut UiBuilder, x: f32, y: f32, s: f32, style: CursorStyle) {
    let half = 7.0 * s;
    let serif = 2.6 * s;
    let w = (1.2 * s).max(1.0);
    ui.line(x, y - half, x, y + half, w, style.edge);
    ui.line(x - serif, y - half, x + serif, y - half, w, style.edge);
    ui.line(x - serif, y + half, x + serif, y + half, w, style.edge);
}

/// A ring with one bright arc sweeping it. The original shows an hourglass;
/// a sweep says the same thing without a bitmap and without a text glyph.
fn busy(ui: &mut UiBuilder, x: f32, y: f32, s: f32, style: CursorStyle, phase_ms: u64) {
    let r = 7.0 * s;
    let w = (1.6 * s).max(1.0);
    ui.ring(x, y, r, 16, w, style.fill);
    let turn = (phase_ms % 1_200) as f32 / 1_200.0 * core::f32::consts::TAU;
    let mut prev = (
        x + libm::cosf(turn) * r,
        y + libm::sinf(turn) * r,
    );
    for step in 1..=5 {
        let angle = turn + step as f32 / 5.0 * (core::f32::consts::TAU * 0.28);
        let next = (x + libm::cosf(angle) * r, y + libm::sinf(angle) * r);
        ui.line(prev.0, prev.1, next.0, next.1, w, style.accent);
        prev = next;
    }
}

/// Four L-brackets inset into a rect — the original's selection box, reused by
/// the world target indicator.
pub fn corner_ticks(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    arm: f32,
    thickness: f32,
    rgba: [u8; 4],
) {
    let [x, y, w, h] = rect;
    let arm = arm.min(w * 0.5).min(h * 0.5);
    let t = thickness.max(1.0);
    for (cx, sx) in [(x, 1.0), (x + w, -1.0)] {
        for (cy, sy) in [(y, 1.0), (y + h, -1.0)] {
            ui.rect(cx.min(cx + sx * arm), cy - t * 0.5, arm, t, rgba);
            ui.rect(cx - t * 0.5, cy.min(cy + sy * arm), t, arm, rgba);
        }
    }
}

fn chevron(ui: &mut UiBuilder, x: f32, y: f32, size: f32, thickness: f32, rgba: [u8; 4]) {
    ui.line(x, y - size, x + size * 0.8, y, thickness, rgba);
    ui.line(x + size * 0.8, y, x, y + size, thickness, rgba);
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;
    use crate::ui::AtlasMeta;

    const ATLAS: AtlasMeta = AtlasMeta {
        cell: 32,
        cols: 8,
        width: 256,
        height: 160,
    };

    fn builder() -> UiBuilder {
        let mut ui = UiBuilder::new(ATLAS);
        ui.begin(1280, 720);
        ui
    }

    #[test]
    fn every_kind_draws_geometry() {
        for kind in [
            CursorKind::Arrow,
            CursorKind::Select,
            CursorKind::Attack,
            CursorKind::Interact,
            CursorKind::Move,
            CursorKind::ResizeHorizontal,
            CursorKind::ResizeVertical,
            CursorKind::ResizeNwSe,
            CursorKind::ResizeNeSw,
            CursorKind::Text,
            CursorKind::Busy,
            CursorKind::Blocked,
        ] {
            let mut ui = builder();
            draw(&mut ui, kind, 640.0, 360.0, CursorStyle::default(), 400);
            assert!(ui.quads > 0, "{kind:?} drew nothing");
        }
    }

    /// The hotspot is the click point: the arrow's ink must start there and
    /// extend down-right, never straddle it.
    #[test]
    fn arrow_ink_starts_at_the_hotspot() {
        let mut ui = builder();
        draw(&mut ui, CursorKind::Arrow, 100.0, 100.0, CursorStyle::default(), 0);
        let style = CursorStyle::default();
        // Tallest arrow vertex is 16 design units; the shadow adds a 3-unit
        // offset and the outline stroke half a pixel on top of that.
        let extent = (DESIGN + 3.0) * (style.size / DESIGN) + 1.0;
        let (min_x, min_y, max_x, max_y) = ink_bounds(&ui, 1280.0, 720.0);
        assert!(min_x >= 100.0 - 1.5, "ink left of the hotspot: {min_x}");
        assert!(min_y >= 100.0 - 1.5, "ink above the hotspot: {min_y}");
        assert!(max_x <= 100.0 + extent, "arrow wider than its silhouette: {max_x}");
        assert!(max_y <= 100.0 + extent, "arrow taller than its silhouette: {max_y}");
    }

    /// Centred kinds straddle the hotspot; a resize pointer that only grew
    /// down-right would sit visibly off the edge it grabs.
    #[test]
    fn resize_and_reticle_are_centred_on_the_hotspot() {
        for kind in [
            CursorKind::ResizeHorizontal,
            CursorKind::ResizeVertical,
            CursorKind::ResizeNwSe,
            CursorKind::ResizeNeSw,
            CursorKind::Attack,
            CursorKind::Move,
        ] {
            let mut ui = builder();
            draw(&mut ui, kind, 400.0, 300.0, CursorStyle::default(), 0);
            let (min_x, min_y, max_x, max_y) = ink_bounds(&ui, 1280.0, 720.0);
            assert!(min_x < 400.0 && max_x > 400.0, "{kind:?} not centred in x");
            assert!(min_y < 300.0 && max_y > 300.0, "{kind:?} not centred in y");
        }
    }

    #[test]
    fn corner_edges_win_over_sides() {
        assert_eq!(
            CursorKind::for_edges(true, false, true, false),
            Some(CursorKind::ResizeNwSe)
        );
        assert_eq!(
            CursorKind::for_edges(false, true, true, false),
            Some(CursorKind::ResizeNeSw)
        );
        assert_eq!(
            CursorKind::for_edges(false, true, false, false),
            Some(CursorKind::ResizeHorizontal)
        );
        assert_eq!(
            CursorKind::for_edges(false, false, false, true),
            Some(CursorKind::ResizeVertical)
        );
        assert_eq!(CursorKind::for_edges(false, false, false, false), None);
    }

    /// Vertices are NDC; map back to pixels to reason about placement.
    fn ink_bounds(ui: &UiBuilder, sw: f32, sh: f32) -> (f32, f32, f32, f32) {
        let (mut min_x, mut min_y) = (f32::MAX, f32::MAX);
        let (mut max_x, mut max_y) = (f32::MIN, f32::MIN);
        for vertex in ui.buf.chunks_exact(8) {
            let px = (vertex[0] + 1.0) * 0.5 * sw;
            let py = (1.0 - vertex[1]) * 0.5 * sh;
            min_x = min_x.min(px);
            min_y = min_y.min(py);
            max_x = max_x.max(px);
            max_y = max_y.max(py);
        }
        (min_x, min_y, max_x, max_y)
    }
}
