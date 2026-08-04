//! Pregame surfaces — Successor's rendition of the original client's
//! entry → roster → creation flow.
//!
//! Scope contract: these screens are **presentation only**. They emit
//! [`ScreenAction`] intents and never open a socket, hold a credential, or
//! resolve a roster. The endpoint/player fields are a *development entry
//! mechanic*; ordinary launch still requires a signed launch context
//! (`--launch-context`), and nothing here is an alternate authenticated path.
//!
//! Original client bitmap assets are never loaded or copied. These screens
//! combine Successor-owned image-2 destination art and tintable shape accents
//! with sparse vector chrome in the shared runtime atlas. The visual grammar
//! keeps the original's deep-space field, saturated teal hierarchy, industrial
//! hardware points, and far-edge BACK/NEXT anchors without reproducing its
//! imagery or stacking borders around every element.
//!
//! Stages are observable so a host (or `--demo pregame`) can drive and capture
//! each one: [`EntryStage`] on [`EntryScreen`], [`CharacterStage`] on
//! [`CharacterScreen`].

use crate::net::connect::JoinOptions;
use successor_engine_render::font::text_advance;
use successor_engine_render::ui::{Response, TextField, UiBuilder};

// ── Design tokens ───────────────────────────────────────────────────────────
// Sampled from the refreshed original login/creation captures: the pregame
// pages are saturated teal (#004858 body, #007890/#008098 inner fields,
// #005060 wells) closed by a bright cyan edge (#18F8F8), with sparing
// industrial gray hardware (#98A090/#A8A898). Deep space stays near-black.
// Ink tones are lifted from the HUD SIGNAL ramp so pregame and connected text
// read as one family against the brighter teal.

const VOID: [u8; 4] = [3, 7, 10, 255];
const INK: [u8; 4] = [232, 248, 250, 255];
const INK_SOFT: [u8; 4] = [190, 228, 236, 255];
const INK_DIM: [u8; 4] = [132, 186, 198, 255];
const INK_GHOST: [u8; 4] = [88, 138, 150, 255];
/// Bright edge cyan (#18F8F8) — borders, focus, active rails.
const ACCENT: [u8; 4] = [24, 248, 248, 255];
/// Selected-row wash (#008098).
const ACCENT_SOFT: [u8; 4] = [0, 128, 152, 232];
const HAIRLINE: [u8; 4] = [0, 62, 76, 236];
const HAIRLINE_LIT: [u8; 4] = [0, 132, 152, 220];
/// Page body (#004858), translucent so the schematic reads behind it.
const PANEL_FILL: [u8; 4] = [0, 72, 88, 218];
/// Title rail (#003844).
const BAR_FILL: [u8; 4] = [0, 56, 68, 232];
/// Inner field well (#007890) — brighter than its page, as in the original.
const FIELD_FILL: [u8; 4] = [0, 120, 144, 214];
const ROW_HOVER: [u8; 4] = [0, 128, 152, 132];
/// Outer hardware (#A8A898 / #98A090) — corner brackets and wedge points only.
const RAIL: [u8; 4] = [168, 168, 152, 236];
const RAIL_DIM: [u8; 4] = [152, 160, 144, 168];
const DANGER: [u8; 4] = [255, 122, 108, 255];
const SCRIM: [u8; 4] = [1, 10, 14, 200];

// Type scale. Rendered glyph height is `8.75 * px` (see `UiBuilder::text`), so
// these read as 21 / 15 / 13 / 10.5 / 9 px at the 1280x720 reference size.
const T_TITLE: f32 = 2.35;
const T_PANEL: f32 = 1.75;
const T_BODY: f32 = 1.45;
const T_LABEL: f32 = 1.2;
const T_MICRO: f32 = 1.02;

/// Far-edge navigation anchor from the original client: the NEXT control keeps
/// the point `(W-109, H-38)` at every framebuffer size.
const NAV_INSET_X: f32 = 109.0;
const NAV_INSET_Y: f32 = 38.0;
const NAV_W: f32 = 150.0;
const NAV_H: f32 = 26.0;
const EDGE: f32 = 52.0;

/// Uniform control scale. Proportions stay fixed (controls never distort with
/// aspect) while the whole surface tracks viewport height.
fn scale(h: f32) -> f32 {
    (h / 720.0).clamp(0.8, 1.75)
}

fn glyph_h(px: f32) -> f32 {
    8.75 * px
}

fn measure(ui: &UiBuilder, text: &str, px: f32) -> f32 {
    ui.measure_text(text, px)
}

// ── Actions ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScreenAction {
    /// Development entry: the host may begin a link attempt with these options.
    Connect(JoinOptions),
    /// The in-flight link attempt was cancelled from the connecting dialog.
    CancelConnect,
    SelectCharacter(usize),
    CreateCharacter(String),
    /// Leave the pregame flow (a screen's own sub-stages never emit this).
    Back,
    Quit,
}

// ── Shared primitives ───────────────────────────────────────────────────────

fn hairline(ui: &mut UiBuilder, x: f32, y: f32, w: f32, s: f32, c: [u8; 4]) {
    ui.rect(x, y, w, (1.0 * s).max(1.0), c);
}

/// Four L-shaped corner brackets — the pregame frame chrome. Deliberately not
/// a full border: only the corners are drawn.
fn corner_brackets(ui: &mut UiBuilder, r: [f32; 4], len: f32, t: f32, c: [u8; 4]) {
    let [x, y, w, h] = r;
    ui.rect(x, y, len, t, c);
    ui.rect(x, y, t, len, c);
    ui.rect(x + w - len, y, len, t, c);
    ui.rect(x + w - t, y, t, len, c);
    ui.rect(x, y + h - t, len, t, c);
    ui.rect(x, y + h - len, t, len, c);
    ui.rect(x + w - len, y + h - t, len, t, c);
    ui.rect(x + w - t, y + h - len, t, len, c);
}

fn text_center(ui: &mut UiBuilder, text: &str, cx: f32, y: f32, px: f32, c: [u8; 4]) {
    let width = measure(ui, text, px);
    ui.text(text, cx - width * 0.5, y, px, c);
}

fn text_right(ui: &mut UiBuilder, text: &str, right: f32, y: f32, px: f32, c: [u8; 4]) {
    let width = measure(ui, text, px);
    ui.text(text, right - width, y, px, c);
}

/// Word-wrapped paragraph. Measures incrementally (no per-line re-measure, no
/// intermediate `String`s) and returns the y cursor after the last line.
#[allow(clippy::too_many_arguments)]
fn draw_wrapped(
    ui: &mut UiBuilder,
    text: &str,
    x: f32,
    y: f32,
    max_w: f32,
    px: f32,
    line_h: f32,
    max_lines: usize,
    c: [u8; 4],
) -> f32 {
    let mut rest = text.trim_start();
    let mut cy = y;
    let mut drawn = 0usize;
    while !rest.is_empty() && drawn < max_lines {
        let mut cut = rest.len();
        let mut acc = 0.0f32;
        let mut last_space = 0usize;
        for (i, ch) in rest.char_indices() {
            let adv = text_advance(ch) * px;
            if acc + adv > max_w {
                cut = if last_space > 0 { last_space } else { i.max(1) };
                break;
            }
            if ch == ' ' {
                last_space = i;
            }
            acc += adv;
        }
        ui.text(&rest[..cut], x, cy, px, c);
        cy += line_h;
        drawn += 1;
        rest = rest[cut..].trim_start();
    }
    cy
}

fn ellipse(ui: &mut UiBuilder, cx: f32, cy: f32, r: [f32; 2], segs: u32, t: f32, c: [u8; 4]) {
    let [rx, ry] = r;
    let segs = segs.max(6);
    let (mut px, mut py) = (cx + rx, cy);
    for i in 1..=segs {
        let a = i as f32 / segs as f32 * std::f32::consts::TAU;
        let (nx, ny) = (cx + a.cos() * rx, cy + a.sin() * ry);
        ui.line(px, py, nx, ny, t, c);
        px = nx;
        py = ny;
    }
}

/// Filled ellipse assembled from horizontal spans — the only way to get a soft
/// round mass out of a quad-only draw list.
fn filled_ellipse(ui: &mut UiBuilder, cx: f32, cy: f32, r: [f32; 2], rows: u32, c: [u8; 4]) {
    let [rx, ry] = r;
    let rows = rows.max(2);
    let step = 2.0 * ry / rows as f32;
    for i in 0..rows {
        let y0 = cy - ry + i as f32 * step;
        let t = (y0 + step * 0.5 - cy) / ry;
        let hw = rx * (1.0 - t * t).max(0.0).sqrt();
        if hw > 0.4 {
            ui.rect(cx - hw, y0, hw * 2.0, step + 0.6, c);
        }
    }
}

#[inline]
fn xorshift(state: &mut u32) -> u32 {
    let mut x = *state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *state = x;
    x
}

#[inline]
fn unit(state: &mut u32) -> f32 {
    (xorshift(state) >> 8) as f32 / 16_777_216.0
}

// ── Backdrop: deep space + orbital schematic ────────────────────────────────

/// Deterministic starfield, nebula bloom, blueprint station and distant hulls.
/// Fixed seed ⇒ identical every frame and every run (screenshot-stable).
fn draw_backdrop(ui: &mut UiBuilder, w: f32, h: f32, phase: f32) {
    ui.rect(0.0, 0.0, w, h, VOID);

    // Nebula bloom behind the schematic (nested translucent masses).
    let gx = w * 0.30;
    let gy = h * 0.46;
    for i in (0..9).rev() {
        let t = i as f32 / 8.0;
        filled_ellipse(
            ui,
            gx,
            gy,
            [w * (0.13 + t * 0.36), h * (0.16 + t * 0.40)],
            16,
            [9, 33, 41, 13],
        );
    }

    // Starfield.
    let mut rng: u32 = 0x9E37_79B9;
    for i in 0..168u32 {
        let x = unit(&mut rng) * w;
        let y = unit(&mut rng) * h;
        let roll = unit(&mut rng);
        let twinkle = 0.62 + 0.38 * (phase * 1.4 + i as f32 * 0.7).sin();
        let a = ((36.0 + roll * 150.0) * twinkle).clamp(8.0, 235.0) as u8;
        let sz = if roll > 0.93 { 2.0 } else { 1.0 };
        ui.rect(x, y, sz, sz, [188, 226, 236, a]);
        if roll > 0.985 {
            ui.rect(x - 2.0, y + 0.5, 5.0, 1.0, [188, 226, 236, a / 3]);
            ui.rect(x + 0.5, y - 2.0, 1.0, 5.0, [188, 226, 236, a / 3]);
        }
    }

    draw_station(ui, gx, gy, h / 720.0, phase);

    // Distant hulls: three small arrowheads at very low alpha.
    draw_hull(ui, w * 0.70, h * 0.24, 26.0 * (h / 720.0), -0.35, 34);
    draw_hull(ui, w * 0.13, h * 0.74, 34.0 * (h / 720.0), 0.22, 28);
    draw_hull(ui, w * 0.62, h * 0.79, 20.0 * (h / 720.0), 0.05, 22);

    // Lower haze band grounds the composition.
    for i in 0..10u32 {
        let a = 3 + i / 2;
        ui.rect(
            0.0,
            h - (i as f32 + 1.0) * h * 0.018,
            w,
            h * 0.018,
            [12, 44, 52, a as u8],
        );
    }
}

/// Successor orbital platform, blueprint-style: two rim discs, a spoked hub, a
/// dorsal mast with a sensor crown, docking pylons, and radiator fins.
fn draw_station(ui: &mut UiBuilder, cx: f32, cy: f32, k: f32, phase: f32) {
    let line_a = [86, 206, 224, 44];
    let line_b = [86, 206, 224, 30];
    let lit = [120, 232, 246, 70];

    let rim = 300.0 * k;
    let rim_y = 88.0 * k;
    let mid = 212.0 * k;
    let mid_y = 62.0 * k;
    let hub = 60.0 * k;
    let hub_y = 18.0 * k;

    ellipse(ui, cx, cy, [rim, rim_y], 44, 1.3, line_a);
    ellipse(
        ui,
        cx,
        cy,
        [rim - 12.0 * k, rim_y - 3.5 * k],
        44,
        1.0,
        line_b,
    );
    ellipse(ui, cx, cy, [mid, mid_y], 38, 1.0, line_b);
    ellipse(ui, cx, cy, [hub, hub_y], 26, 1.3, lit);

    // Spokes hub → mid rim.
    for i in 0..14u32 {
        let a = i as f32 / 14.0 * std::f32::consts::TAU;
        let (c, s) = (a.cos(), a.sin());
        ui.line(
            cx + c * hub,
            cy + s * hub_y,
            cx + c * mid,
            cy + s * mid_y,
            1.0,
            line_b,
        );
    }
    // Rim ticks.
    for i in 0..30u32 {
        let a = i as f32 / 30.0 * std::f32::consts::TAU;
        let (c, s) = (a.cos(), a.sin());
        ui.line(
            cx + c * (rim - 14.0 * k),
            cy + s * (rim_y - 4.0 * k),
            cx + c * rim,
            cy + s * rim_y,
            1.0,
            line_a,
        );
    }

    // Dorsal mast + sensor crown.
    let top = cy - 196.0 * k;
    ui.line(cx, cy - 14.0 * k, cx, top, 1.6, line_a);
    ui.line(cx, cy + 12.0 * k, cx, cy + 126.0 * k, 1.4, line_b);
    for i in 1..5u32 {
        let y = cy - i as f32 * 40.0 * k;
        let half = (26.0 - i as f32 * 3.5) * k;
        ui.line(cx - half, y, cx + half, y, 1.0, line_b);
    }
    ellipse(ui, cx, top, [84.0 * k, 24.0 * k], 26, 1.1, line_a);
    ellipse(ui, cx, top, [46.0 * k, 13.0 * k], 20, 1.0, line_b);
    ui.line(cx, top, cx - 96.0 * k, top - 40.0 * k, 1.0, line_b);
    ui.line(cx, top, cx + 104.0 * k, top - 30.0 * k, 1.0, line_b);
    ui.rect(cx - 100.0 * k, top - 44.0 * k, 8.0 * k, 8.0 * k, lit);
    ui.rect(cx + 100.0 * k, top - 34.0 * k, 8.0 * k, 8.0 * k, lit);

    // Docking pylons off the rim.
    for (i, a) in [0.55f32, 2.15, 3.75, 5.35].iter().enumerate() {
        let (c, s) = (a.cos(), a.sin());
        let x0 = cx + c * rim;
        let y0 = cy + s * rim_y;
        let x1 = cx + c * (rim + 70.0 * k);
        let y1 = cy + s * (rim_y + 24.0 * k) + 26.0 * k;
        ui.line(x0, y0, x1, y1, 1.2, line_a);
        ui.line(x1, y1, x1 + 34.0 * k, y1 - 8.0 * k, 1.0, line_b);
        let pulse = if (phase * 0.6 + i as f32 * 0.9) as i32 % 3 == 0 {
            lit
        } else {
            line_b
        };
        ui.rect(x1 - 4.0 * k, y1 - 4.0 * k, 9.0 * k, 9.0 * k, pulse);
    }

    // Radiator fins.
    ui.line(
        cx - rim * 0.72,
        cy - 96.0 * k,
        cx - rim * 1.05,
        cy - 150.0 * k,
        7.0 * k,
        [70, 176, 196, 18],
    );
    ui.line(
        cx + rim * 0.70,
        cy - 88.0 * k,
        cx + rim * 1.02,
        cy - 142.0 * k,
        7.0 * k,
        [70, 176, 196, 18],
    );
}

/// Distant ship: an arrowhead outline with two swept wings.
fn draw_hull(ui: &mut UiBuilder, cx: f32, cy: f32, len: f32, tilt: f32, alpha: u8) {
    let c = [104, 200, 218, alpha];
    let (dx, dy) = (tilt.cos(), tilt.sin());
    let (px, py) = (-dy, dx);
    let nose = (cx + dx * len, cy + dy * len);
    let tail = (cx - dx * len * 0.6, cy - dy * len * 0.6);
    let lw = (tail.0 + px * len * 0.42, tail.1 + py * len * 0.42);
    let rw = (tail.0 - px * len * 0.42, tail.1 - py * len * 0.42);
    ui.line(nose.0, nose.1, lw.0, lw.1, 1.2, c);
    ui.line(nose.0, nose.1, rw.0, rw.1, 1.2, c);
    ui.line(lw.0, lw.1, rw.0, rw.1, 1.0, c);
    ui.line(
        tail.0,
        tail.1,
        nose.0,
        nose.1,
        1.0,
        [104, 200, 218, alpha / 2],
    );
}

// ── Screen identity + edge navigation ───────────────────────────────────────

const STAGE_LABELS: [&str; 4] = ["LINK", "ROSTER", "LINEAGE", "IDENTITY"];

/// Top-left wordmark and the four-tick stage rail. This is the screen-level
/// hierarchy the original carried in its panel title alone.
fn draw_identity(ui: &mut UiBuilder, s: f32, active: usize) {
    let x = EDGE * s;
    let y = 26.0 * s;
    ui.rect(
        x,
        y + 2.0 * s,
        3.0 * s,
        glyph_h(T_TITLE * s) - 4.0 * s,
        ACCENT,
    );
    ui.text("SUCCESSOR", x + 12.0 * s, y, T_TITLE * s, INK);

    let rail_y = y + glyph_h(T_TITLE * s) + 14.0 * s;
    let step = 94.0 * s;
    let span = step * (STAGE_LABELS.len() - 1) as f32;
    hairline(ui, x, rail_y, span, s, HAIRLINE);
    for (i, label) in STAGE_LABELS.iter().enumerate() {
        let tx = x + i as f32 * step;
        let on = i == active;
        let tint = if on {
            ACCENT
        } else if i < active {
            INK_DIM
        } else {
            INK_GHOST
        };
        if on {
            hairline(ui, x, rail_y, tx - x, s, ACCENT);
            ui.rect(tx - 3.0 * s, rail_y - 3.0 * s, 7.0 * s, 7.0 * s, ACCENT);
        } else {
            ui.rect(tx - 2.0 * s, rail_y - 2.0 * s, 5.0 * s, 5.0 * s, tint);
        }
        ui.text(label, tx - 2.0 * s, rail_y + 9.0 * s, T_MICRO * s, tint);
    }
}

/// Centred instruction line above the navigation row, matching the original's
/// sentence-case helper copy.
fn draw_footer(ui: &mut UiBuilder, w: f32, h: f32, s: f32, line: &str, note: Option<&str>) {
    let y = h - 74.0 * s;
    text_center(ui, line, w * 0.5, y, T_BODY * s, INK_SOFT);
    if let Some(note) = note {
        text_center(ui, note, w * 0.5, y + 17.0 * s, T_MICRO * s, INK_DIM);
    }
}

/// One-line host status under the instruction copy. `bad` switches the tick and
/// text to the danger tone for a rejection; otherwise it reads as a quiet
/// pending/informational note. Same grammar as the login panel foot: a short
/// accent tick, then micro caps.
fn draw_status_line(ui: &mut UiBuilder, w: f32, h: f32, s: f32, text: &str, bad: bool) {
    if text.is_empty() {
        return;
    }
    let px = T_MICRO * s;
    let y = h - 74.0 * s + 17.0 * s;
    let tint = if bad { DANGER } else { ACCENT };
    let ink = if bad { DANGER } else { INK_DIM };
    let tw = measure(ui, text, px);
    let x = w * 0.5 - tw * 0.5;
    ui.rect(x - 8.0 * s, y + 1.0 * s, 2.0 * s, glyph_h(px), tint);
    ui.text(text, x, y, px, ink);
}

/// Far-edge navigation plates are **not** scaled: the original keeps the same
/// pixel inset at every framebuffer size, verified at 800x600 (NEXT centre
/// 691,562) and 1280x1024 (1171,986).
fn nav_back_rect(h: f32) -> [f32; 4] {
    [
        NAV_INSET_X - NAV_W * 0.5,
        h - NAV_INSET_Y - NAV_H * 0.5,
        NAV_W,
        NAV_H,
    ]
}

fn nav_next_rect(w: f32, h: f32) -> [f32; 4] {
    [
        w - NAV_INSET_X - NAV_W * 0.5,
        h - NAV_INSET_Y - NAV_H * 0.5,
        NAV_W,
        NAV_H,
    ]
}

/// Far-edge navigation wedge: a teal label bar closed by a generated,
/// tintable hardware point. Metrics are fixed because the hit area is the bar,
/// so the decoration never moves the target.
fn nav_plate(ui: &mut UiBuilder, r: [f32; 4], label: &str, forward: bool, enabled: bool) -> bool {
    let [x, y, w, h] = r;
    let resp = ui.interact(x, y, w, h);
    let fill = match (enabled, resp.held, resp.hovered) {
        (false, _, _) => [0, 44, 54, 200],
        (true, true, _) => [0, 160, 186, 246],
        (true, false, true) => [0, 136, 160, 242],
        _ => [0, 104, 126, 232],
    };
    ui.rect(x, y, w, h, fill);
    hairline(ui, x, y, w, 1.0, if enabled { ACCENT } else { HAIRLINE });
    hairline(
        ui,
        x,
        y + h - 1.0,
        w,
        1.0,
        if enabled { HAIRLINE_LIT } else { HAIRLINE },
    );

    // Image-2 hardware point on the leading edge; flat tail bar opposite.
    let point = 22.0;
    let hw = if enabled { RAIL } else { RAIL_DIM };
    if forward {
        ui.mask_uv(
            x + w,
            y - 2.0,
            point,
            h + 4.0,
            crate::hud::NAV_WEDGE_RIGHT_UV,
            hw,
        );
        ui.rect(x - 5.0, y - 2.0, 1.5, h + 4.0, hw);
    } else {
        ui.mask_uv(
            x - point,
            y - 2.0,
            point,
            h + 4.0,
            crate::hud::NAV_WEDGE_LEFT_UV,
            hw,
        );
        ui.rect(x + w + 3.5, y - 2.0, 1.5, h + 4.0, hw);
    }

    let px = T_LABEL * 1.12;
    let tint = if enabled { INK } else { INK_GHOST };
    text_center(
        ui,
        label,
        x + w * 0.5,
        y + (h - glyph_h(px)) * 0.5,
        px,
        tint,
    );
    enabled && resp.clicked
}

// ── Controls (palette-local; the shared widgets carry a gold accent) ────────

#[allow(clippy::too_many_arguments)]
fn draw_field(
    ui: &mut UiBuilder,
    field: &mut TextField,
    r: [f32; 4],
    s: f32,
    phase: f32,
    press_anywhere: bool,
    placeholder: &str,
) -> Response {
    let [x, y, w, h] = r;
    let resp = ui.interact(x, y, w, h);
    if resp.clicked {
        field.focused = true;
    } else if press_anywhere && !resp.hovered {
        field.focused = false;
    }
    if field.focused {
        ui.rect(x, y, w, h, [0, 82, 98, 104]);
    } else if resp.hovered {
        ui.rect(x, y, w, h, [0, 56, 68, 72]);
    }
    let edge = if field.focused { ACCENT } else { HAIRLINE_LIT };
    hairline(
        ui,
        x,
        y + h - (if field.focused { 2.0 } else { 1.0 }) * s,
        w,
        s,
        edge,
    );
    if field.focused {
        ui.rect(x, y + 7.0 * s, 2.0 * s, h - 14.0 * s, ACCENT);
    }
    let px = T_BODY * s;
    let ty = y + (h - glyph_h(px)) * 0.5;
    if field.text.is_empty() {
        ui.text(placeholder, x + 9.0 * s, ty, px, INK_GHOST);
    } else {
        ui.text(&field.text, x + 9.0 * s, ty, px, INK);
    }
    if field.focused && (phase * 2.0) as i32 % 2 == 0 {
        let end = x + 9.0 * s + measure(ui, &field.text, px);
        ui.rect(end + 1.5 * s, ty, 1.6 * s, glyph_h(px), ACCENT);
    }
    resp
}

/// Flat action control: fill + hairline underline, no full outline.
fn action_bar(ui: &mut UiBuilder, r: [f32; 4], s: f32, label: &str, enabled: bool) -> bool {
    let [x, y, w, h] = r;
    let resp = ui.interact(x, y, w, h);
    let fill = match (enabled, resp.held, resp.hovered) {
        (false, _, _) => [9, 19, 23, 190],
        (true, true, _) => [26, 92, 104, 240],
        (true, false, true) => [17, 66, 76, 232],
        _ => [11, 33, 39, 224],
    };
    ui.rect(x, y, w, h, fill);
    hairline(
        ui,
        x,
        y + h - 1.0 * s,
        w,
        s,
        if enabled { ACCENT } else { HAIRLINE },
    );
    let px = T_LABEL * s * 1.05;
    text_center(
        ui,
        label,
        x + w * 0.5,
        y + (h - glyph_h(px)) * 0.5,
        px,
        if enabled { INK } else { INK_GHOST },
    );
    enabled && resp.clicked
}

/// Small segmented chip used for presentation and vocation choices.
fn chip(ui: &mut UiBuilder, r: [f32; 4], s: f32, label: &str, on: bool) -> bool {
    let [x, y, w, h] = r;
    let resp = ui.interact(x, y, w, h);
    let fill = if on {
        ACCENT_SOFT
    } else if resp.hovered {
        ROW_HOVER
    } else {
        [8, 20, 24, 210]
    };
    ui.rect(x, y, w, h, fill);
    if on {
        ui.rect(x, y, 3.0 * s, h, ACCENT);
    }
    hairline(
        ui,
        x,
        y + h - 1.0 * s,
        w,
        s,
        if on { ACCENT } else { HAIRLINE },
    );
    let px = T_LABEL * s;
    ui.text(
        label,
        x + 9.0 * s,
        y + (h - glyph_h(px)) * 0.5,
        px,
        if on { INK } else { INK_DIM },
    );
    resp.clicked
}

/// Horizontal value track. Returns true while the pointer is driving it.
fn track(ui: &mut UiBuilder, r: [f32; 4], s: f32, value: &mut f32) -> bool {
    let [x, y, w, h] = r;
    let resp = ui.interact(x, y, w, h);
    let mut changed = false;
    if resp.pressed || resp.held {
        let (mx, _) = ui.mouse();
        let next = ((mx - x) / w).clamp(0.0, 1.0);
        changed = (next - *value).abs() > f32::EPSILON;
        *value = next;
    }
    let ty = y + h * 0.5 - 1.5 * s;
    ui.rect(x, ty, w, 3.0 * s, [16, 34, 40, 240]);
    ui.rect(x, ty, w * *value, 3.0 * s, ACCENT);
    for i in 0..5u32 {
        let tx = x + i as f32 / 4.0 * w;
        ui.rect(
            tx - 0.5 * s,
            y + h * 0.5 + 4.0 * s,
            1.0 * s,
            4.0 * s,
            HAIRLINE_LIT,
        );
    }
    let thumb = 9.0 * s;
    ui.rect(
        x + w * *value - thumb * 0.5,
        y + (h - thumb) * 0.5,
        thumb,
        thumb,
        if resp.held { INK } else { ACCENT },
    );
    changed
}

fn check_row(ui: &mut UiBuilder, r: [f32; 4], s: f32, label: &str, value: &mut bool) -> bool {
    let [x, y, w, h] = r;
    let resp = ui.interact(x, y, w, h);
    if resp.clicked {
        *value = !*value;
    }
    let box_s = 12.0 * s;
    let by = y + (h - box_s) * 0.5;
    ui.rect(x, by, box_s, box_s, FIELD_FILL);
    ui.border(
        x,
        by,
        box_s,
        box_s,
        (1.0 * s).max(1.0),
        if resp.hovered { ACCENT } else { HAIRLINE_LIT },
    );
    if *value {
        ui.rect(
            x + 3.0 * s,
            by + 3.0 * s,
            box_s - 6.0 * s,
            box_s - 6.0 * s,
            ACCENT,
        );
    }
    let px = T_LABEL * s;
    ui.text(
        label,
        x + box_s + 9.0 * s,
        y + (h - glyph_h(px)) * 0.5,
        px,
        if *value { INK } else { INK_DIM },
    );
    resp.clicked
}

/// Label/value pair closed by a faint rule — the readout grammar used for
/// character detail and the creation summary.
fn kv_row(ui: &mut UiBuilder, x: f32, y: f32, w: f32, s: f32, key: &str, value: &str) {
    let kp = T_LABEL * s;
    let vp = T_BODY * s;
    ui.text(key, x, y + (glyph_h(vp) - glyph_h(kp)) * 0.5, kp, INK_DIM);
    text_right(ui, value, x + w, y, vp, INK);
    hairline(ui, x, y + glyph_h(vp) + 6.0 * s, w, s, [22, 38, 44, 200]);
}

/// Panel shell: translucent charcoal body, brass corner brackets, a title bar
/// closed by one hairline. Returns the y of the content origin.
fn draw_panel(ui: &mut UiBuilder, r: [f32; 4], s: f32, title: &str, tag: Option<&str>) -> f32 {
    let [x, y, w, h] = r;
    ui.rect(x, y, w, h, PANEL_FILL);
    corner_brackets(ui, r, 24.0 * s, (1.5 * s).max(1.0), RAIL);
    let bar = 30.0 * s;
    ui.rect(x, y, w, bar, BAR_FILL);
    hairline(ui, x, y + bar - 1.0 * s, w, s, HAIRLINE_LIT);
    ui.rect(x + 12.0 * s, y + 8.0 * s, 2.0 * s, bar - 16.0 * s, ACCENT);
    let px = T_PANEL * s;
    ui.text(title, x + 22.0 * s, y + (bar - glyph_h(px)) * 0.5, px, INK);
    if let Some(tag) = tag {
        let tp = T_MICRO * s;
        text_right(
            ui,
            tag,
            x + w - 12.0 * s,
            y + (bar - glyph_h(tp)) * 0.5,
            tp,
            INK_DIM,
        );
    }
    y + bar
}

// ── Retained full-body viewer ───────────────────────────────────────────────

/// Subject of the left-hand viewer. Proportions are driven by the creation
/// draft so the figure visibly answers lineage/build/presentation changes.
pub struct Figure {
    /// 0 = slight frame, 1 = heavy frame.
    pub build: f32,
    pub female: bool,
}

/// Projection pad, volumetric figure and scan sweep — an authored abstract
/// silhouette assembled from primitives, retained across every character
/// stage exactly like the original's live avatar viewer. A host that can supply
/// a live pawn renders into [`CharacterLayout::paperdoll_rect`] and suppresses
/// the silhouette with [`CharacterScreen::set_paperdoll_hosted`]; the pad,
/// frame and caption stay so the composition does not move.
fn draw_viewer(ui: &mut UiBuilder, r: [f32; 4], s: f32, phase: f32, fig: Option<&Figure>) {
    let [rx, ry, rw, rh] = r;
    let cx = rx + rw * 0.5;
    let u = rh * 0.70;
    let feet = ry + rh * 0.87;
    let top = feet - u;

    corner_brackets(ui, r, 26.0 * s, (1.5 * s).max(1.0), RAIL_DIM);

    // Projection pad.
    let pad_y = feet + u * 0.022;
    let pad_rx = u * 0.27;
    let pad_ry = pad_rx * 0.27;
    filled_ellipse(ui, cx, pad_y, [pad_rx, pad_ry], 14, [30, 132, 150, 30]);
    ellipse(ui, cx, pad_y, [pad_rx, pad_ry], 40, 1.3, [96, 218, 236, 96]);
    ellipse(
        ui,
        cx,
        pad_y,
        [pad_rx * 0.66, pad_ry * 0.66],
        32,
        1.0,
        [96, 218, 236, 56],
    );
    for i in 0..12u32 {
        let a = i as f32 / 12.0 * std::f32::consts::TAU;
        let (c, sn) = (a.cos(), a.sin());
        ui.line(
            cx + c * pad_rx * 0.70,
            pad_y + sn * pad_ry * 0.70,
            cx + c * pad_rx,
            pad_y + sn * pad_ry,
            1.0,
            [96, 218, 236, 62],
        );
    }
    // Projection cone.
    ui.line(
        cx - pad_rx,
        pad_y,
        cx - u * 0.10,
        top,
        1.0,
        [80, 200, 220, 20],
    );
    ui.line(
        cx + pad_rx,
        pad_y,
        cx + u * 0.10,
        top,
        1.0,
        [80, 200, 220, 20],
    );

    let Some(fig) = fig else {
        return;
    };

    let fill = [74, 196, 218, 54];
    let edge = [150, 236, 248, 176];
    let build = fig.build.clamp(0.0, 1.0);
    let fem = if fig.female { 1.0f32 } else { 0.0 };

    let head_r = u * 0.058;
    let head_cy = top + u * 0.064;
    let neck_y = top + u * 0.126;
    let sh_y = top + u * 0.178;
    let sh_hw = u * (0.098 + 0.028 * build) * (1.0 - 0.08 * fem);
    let waist_y = top + u * 0.398;
    let waist_hw = u * (0.055 + 0.026 * build) * (1.0 - 0.10 * fem);
    let hip_y = top + u * 0.472;
    let hip_hw = u * (0.072 + 0.020 * build) * (1.0 + 0.10 * fem);
    let knee_y = top + u * 0.716;
    let ankle_y = top + u * 0.952;
    let elbow_y = top + u * 0.362;
    let wrist_y = top + u * 0.524;

    // Torso mass: shoulder → waist → hip interpolation as horizontal spans.
    let rows = 26u32;
    let step = (hip_y - sh_y) / rows as f32;
    for i in 0..rows {
        let t = i as f32 / (rows - 1) as f32;
        let y = sh_y + (hip_y - sh_y) * t;
        let hw = if y < waist_y {
            let k = (y - sh_y) / (waist_y - sh_y);
            sh_hw + (waist_hw - sh_hw) * k
        } else {
            let k = (y - waist_y) / (hip_y - waist_y);
            waist_hw + (hip_hw - waist_hw) * k
        };
        ui.rect(cx - hw, y, hw * 2.0, step + 0.7, fill);
    }
    // Torso contour.
    ui.line(cx - sh_hw, sh_y, cx - waist_hw, waist_y, 1.4 * s, edge);
    ui.line(cx + sh_hw, sh_y, cx + waist_hw, waist_y, 1.4 * s, edge);
    ui.line(cx - waist_hw, waist_y, cx - hip_hw, hip_y, 1.4 * s, edge);
    ui.line(cx + waist_hw, waist_y, cx + hip_hw, hip_y, 1.4 * s, edge);
    ui.line(cx - sh_hw, sh_y, cx + sh_hw, sh_y, 1.6 * s, edge);
    ui.line(
        cx,
        sh_y + u * 0.02,
        cx,
        waist_y,
        1.0 * s,
        [150, 236, 248, 70],
    );
    ui.line(cx - hip_hw, hip_y, cx + hip_hw, hip_y, 1.3 * s, edge);

    // Head + neck.
    filled_ellipse(ui, cx, head_cy, [head_r * 0.86, head_r], 12, fill);
    ellipse(ui, cx, head_cy, [head_r * 0.86, head_r], 26, 1.3 * s, edge);
    ui.rect(
        cx - u * 0.019,
        head_cy + head_r * 0.82,
        u * 0.038,
        neck_y - head_cy - head_r * 0.7,
        fill,
    );
    ui.line(cx - u * 0.02, neck_y, cx + u * 0.02, neck_y, 1.2 * s, edge);

    // Arms.
    let arm_t = u * 0.030 + u * 0.008 * build;
    for side in [-1.0f32, 1.0] {
        let sx = cx + side * sh_hw * 0.94;
        let ex = cx + side * (sh_hw * 1.10);
        let wx = cx + side * (sh_hw * 0.96);
        ui.line(sx, sh_y + u * 0.012, ex, elbow_y, arm_t, fill);
        ui.line(ex, elbow_y, wx, wrist_y, arm_t * 0.86, fill);
        ui.line(sx, sh_y + u * 0.012, ex, elbow_y, 1.2 * s, edge);
        ui.line(ex, elbow_y, wx, wrist_y, 1.2 * s, edge);
        ui.rect(wx - u * 0.016, wrist_y, u * 0.032, u * 0.042, fill);
    }

    // Legs + feet.
    let leg_t = u * 0.046 + u * 0.010 * build;
    for side in [-1.0f32, 1.0] {
        let hx = cx + side * hip_hw * 0.52;
        let kx = cx + side * hip_hw * 0.56;
        let ax = cx + side * hip_hw * 0.50;
        ui.line(hx, hip_y, kx, knee_y, leg_t, fill);
        ui.line(kx, knee_y, ax, ankle_y, leg_t * 0.84, fill);
        ui.line(hx, hip_y, kx, knee_y, 1.2 * s, edge);
        ui.line(kx, knee_y, ax, ankle_y, 1.2 * s, edge);
        ui.line(ax - u * 0.030, feet, ax + u * 0.036, feet, 2.4 * s, edge);
    }

    // Scan lines across the figure box, plus one travelling sweep.
    let box_top = head_cy - head_r * 1.4;
    let box_h = feet - box_top;
    let mut y = box_top;
    while y < feet {
        ui.rect(cx - sh_hw * 1.35, y, sh_hw * 2.7, 1.0, [140, 232, 246, 16]);
        y += 4.0 * s;
    }
    let sweep = box_top + (phase * 0.24).fract() * box_h;
    ui.rect(
        cx - sh_hw * 1.35,
        sweep,
        sh_hw * 2.7,
        2.0 * s,
        [176, 244, 252, 54],
    );
    ui.rect(
        cx - sh_hw * 1.35,
        sweep + 3.0 * s,
        sh_hw * 2.7,
        5.0 * s,
        [176, 244, 252, 18],
    );
}

// ── Entry screen ────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EntryStage {
    /// Endpoint/identity entry.
    Login,
    /// A link attempt is in flight; the dialog owns input.
    Connecting,
}

pub struct EntryLayout;
impl EntryLayout {
    /// Original `ui_loginscreen.inc` geometry, reproduced 1:1. The flow is a
    /// **fixed** 330×200 page — never scaled — centred horizontally and pinned
    /// to 33.7% of viewport height. Verified against the refreshed captures at
    /// 800×600 (x225..556, y203..403) and 1280×1024 (x466..795, y345..545).
    /// Its two text boxes are 280×40 at flow-relative y 56 and y 113, matching
    /// the source's 284×40 boxes at `(26,56)` / `(26,113)`.
    pub const PANEL_W: f32 = 330.0;
    pub const PANEL_H: f32 = 200.0;
    pub const FIELD_H: f32 = 40.0;
    pub const PAD: f32 = 25.0;
    const FIELD_Y: [f32; 2] = [56.0, 113.0];

    pub fn panel_rect(w: f32, h: f32) -> [f32; 4] {
        [
            (w - Self::PANEL_W) * 0.5,
            h * 0.337,
            Self::PANEL_W,
            Self::PANEL_H,
        ]
    }

    pub fn field_rect(w: f32, h: f32, index: usize) -> [f32; 4] {
        let [px, py, pw, _] = Self::panel_rect(w, h);
        [
            px + Self::PAD,
            py + Self::FIELD_Y[index.min(1)],
            pw - Self::PAD * 2.0,
            Self::FIELD_H,
        ]
    }

    pub fn endpoint_rect(w: f32, h: f32) -> [f32; 4] {
        Self::field_rect(w, h, 0)
    }

    pub fn player_rect(w: f32, h: f32) -> [f32; 4] {
        Self::field_rect(w, h, 1)
    }

    /// Far-edge navigation plate that begins the development link attempt.
    pub fn connect_rect(w: f32, h: f32) -> [f32; 4] {
        nav_next_rect(w, h)
    }

    /// Far-edge navigation plate that leaves the pregame flow.
    pub fn back_rect(_w: f32, h: f32) -> [f32; 4] {
        nav_back_rect(h)
    }

    /// Top-right exit affordance.
    pub fn quit_rect(w: f32, h: f32) -> [f32; 4] {
        let s = scale(h);
        let bw = 96.0 * s;
        [w - EDGE * s - bw, 27.0 * s, bw, 20.0 * s]
    }

    pub fn dialog_rect(w: f32, h: f32) -> [f32; 4] {
        let s = scale(h);
        let dw = 372.0 * s;
        let dh = 118.0 * s;
        [(w - dw) * 0.5, h * 0.46 - dh * 0.5, dw, dh]
    }

    pub fn cancel_rect(w: f32, h: f32) -> [f32; 4] {
        let s = scale(h);
        let [dx, dy, dw, dh] = Self::dialog_rect(w, h);
        let bw = 122.0 * s;
        [dx + (dw - bw) * 0.5, dy + dh - 32.0 * s, bw, 22.0 * s]
    }
}

pub struct EntryScreen {
    pub endpoint: TextField,
    pub player: TextField,
    stage: EntryStage,
    status: Option<String>,
    phase: f32,
}

impl Default for EntryScreen {
    fn default() -> Self {
        Self::new()
    }
}

impl EntryScreen {
    pub fn new() -> Self {
        let mut endpoint = TextField::new(128);
        endpoint.text = "ws://127.0.0.1:28093/".to_string();
        endpoint.caret = endpoint.text.len();

        let mut player = TextField::new(32);
        player.text = "dev-1".to_string();
        player.caret = player.text.len();

        Self {
            endpoint,
            player,
            stage: EntryStage::Login,
            status: None,
            phase: 0.0,
        }
    }

    pub fn stage(&self) -> EntryStage {
        self.stage
    }

    pub fn status(&self) -> Option<&str> {
        self.status.as_deref()
    }

    /// Advance animation clocks (starfield twinkle, caret blink, link marquee).
    pub fn tick(&mut self, dt: f32) {
        self.phase = (self.phase + dt) % 3600.0;
    }

    /// Show the connecting dialog without emitting an action — host-driven, or
    /// for isolated capture of the stage.
    pub fn begin_connecting(&mut self) {
        self.stage = EntryStage::Connecting;
        self.status = None;
    }

    /// Abandon the in-flight attempt and surface why.
    pub fn fail(&mut self, reason: impl Into<String>) {
        self.stage = EntryStage::Login;
        self.status = Some(reason.into());
    }

    pub fn reset(&mut self) {
        self.stage = EntryStage::Login;
        self.status = None;
    }

    pub fn join_options(&self) -> JoinOptions {
        JoinOptions {
            endpoint: self.endpoint.text.clone(),
            player_id: self.player.text.clone(),
            actor_id: self.player.text.clone(),
            ticket: None,
            release: None,
        }
    }

    fn can_connect(&self) -> bool {
        !self.endpoint.text.trim().is_empty() && !self.player.text.trim().is_empty()
    }

    /// Route a typed character into the focused field. Returns whether it was
    /// consumed.
    pub fn input_char(&mut self, c: char) -> bool {
        if self.stage != EntryStage::Login {
            return false;
        }
        if self.endpoint.focused {
            self.endpoint.insert(c);
            true
        } else if self.player.focused {
            self.player.insert(c);
            true
        } else {
            false
        }
    }

    pub fn backspace(&mut self) -> bool {
        if self.stage != EntryStage::Login {
            return false;
        }
        if self.endpoint.focused {
            self.endpoint.backspace();
            true
        } else if self.player.focused {
            self.player.backspace();
            true
        } else {
            false
        }
    }

    /// Tab traversal across the development fields (the shared `TextField` has
    /// no focus model of its own).
    pub fn focus_next(&mut self) {
        self.focus_step(true);
    }

    /// Shift+Tab traversal.
    pub fn focus_prev(&mut self) {
        self.focus_step(false);
    }

    fn focus_step(&mut self, forward: bool) {
        if self.stage != EntryStage::Login {
            return;
        }
        // Two stops, so forward and backward land on the same other field; the
        // direction still matters from the unfocused state.
        let to_player = if self.endpoint.focused {
            true
        } else if self.player.focused {
            false
        } else {
            !forward
        };
        self.endpoint.focused = !to_player;
        self.player.focused = to_player;
        self.endpoint.caret = self.endpoint.text.chars().count();
        self.player.caret = self.player.text.chars().count();
    }

    pub fn draw(&mut self, ui: &mut UiBuilder, w: f32, h: f32) -> Option<ScreenAction> {
        let s = scale(h);
        let connecting = self.stage == EntryStage::Connecting;
        let press = !connecting && ui.interact(0.0, 0.0, w, h).pressed;

        draw_backdrop(ui, w, h, self.phase);
        draw_identity(ui, s, 0);

        if connecting {
            ui.set_input_enabled(false);
        }
        let mut action = self.draw_login(ui, w, h, s, press);
        if connecting {
            ui.set_input_enabled(true);
            if let Some(a) = self.draw_dialog(ui, w, h, s) {
                action = Some(a);
            }
        }
        action
    }

    fn draw_login(
        &mut self,
        ui: &mut UiBuilder,
        w: f32,
        h: f32,
        s: f32,
        press: bool,
    ) -> Option<ScreenAction> {
        let panel = EntryLayout::panel_rect(w, h);
        let [px, py, pw, ph] = panel;
        draw_panel(ui, panel, s, "LOG IN", Some("DEV ENTRY"));

        let pad = EntryLayout::PAD * s;
        let inner_w = pw - pad * 2.0;
        let lp = T_LABEL * s;

        for (index, (label, hint)) in [("ENDPOINT", "ws://host:port/"), ("PLAYER ID", "identity")]
            .iter()
            .enumerate()
        {
            let rect = EntryLayout::field_rect(w, h, index);
            ui.text(label, rect[0] + 9.0 * s, rect[1] - 10.0 * s, lp, INK_DIM);
            let field = if index == 0 {
                &mut self.endpoint
            } else {
                &mut self.player
            };
            draw_field(ui, field, rect, s, self.phase, press, hint);
        }

        // Status / development disclosure in the panel foot.
        let foot_y = py + ph - 26.0 * s;
        hairline(ui, px + pad, foot_y - 10.0 * s, inner_w, s, HAIRLINE);
        match &self.status {
            Some(reason) => {
                ui.rect(px + pad, foot_y + s, 2.0 * s, glyph_h(T_MICRO * s), DANGER);
                ui.text(reason, px + pad + 8.0 * s, foot_y, T_MICRO * s, DANGER);
            }
            None => {
                ui.text(
                    "DEVELOPMENT ENTRY - NOT AN AUTHENTICATED PATH",
                    px + pad,
                    foot_y,
                    T_MICRO * s,
                    INK_DIM,
                );
            }
        }

        // Top-right exit.
        let quit = EntryLayout::quit_rect(w, h);
        let qr = ui.interact(quit[0], quit[1], quit[2], quit[3]);
        let qp = T_LABEL * s;
        let qw = measure(ui, "EXIT CLIENT", qp);
        text_right(
            ui,
            "EXIT CLIENT",
            quit[0] + quit[2],
            quit[1] + (quit[3] - glyph_h(qp)) * 0.5,
            qp,
            if qr.hovered { DANGER } else { INK_DIM },
        );
        if qr.hovered {
            hairline(
                ui,
                quit[0] + quit[2] - qw,
                quit[1] + quit[3] - 2.0 * s,
                qw,
                s,
                DANGER,
            );
        }

        draw_footer(
            ui,
            w,
            h,
            s,
            "Enter a development endpoint and identity, then continue to link.",
            Some("ORDINARY LAUNCH USES A SIGNED LAUNCH CONTEXT"),
        );

        let can = self.can_connect();
        let next = EntryLayout::connect_rect(w, h);
        if !can {
            text_right(
                ui,
                "ENDPOINT AND IDENTITY REQUIRED",
                next[0] + next[2],
                next[1] - 16.0 * s,
                T_MICRO * s,
                DANGER,
            );
        }
        if nav_plate(ui, next, "CONNECT", true, can) {
            self.stage = EntryStage::Connecting;
            self.status = None;
            return Some(ScreenAction::Connect(self.join_options()));
        }
        if nav_plate(ui, EntryLayout::back_rect(w, h), "BACK", false, true) {
            return Some(ScreenAction::Back);
        }
        if qr.clicked {
            return Some(ScreenAction::Quit);
        }
        None
    }

    fn draw_dialog(&mut self, ui: &mut UiBuilder, w: f32, h: f32, s: f32) -> Option<ScreenAction> {
        ui.rect(0.0, 0.0, w, h, SCRIM);
        let r = EntryLayout::dialog_rect(w, h);
        let [dx, dy, dw, dh] = r;
        ui.rect(dx, dy, dw, dh, [12, 48, 56, 244]);
        ui.border(dx, dy, dw, dh, (1.0 * s).max(1.0), ACCENT);
        corner_brackets(ui, r, 18.0 * s, (1.5 * s).max(1.0), RAIL);

        text_center(
            ui,
            "ESTABLISHING LINK",
            dx + dw * 0.5,
            dy + 14.0 * s,
            T_PANEL * s * 0.94,
            INK,
        );

        // Indeterminate marquee: a three-block group travelling the track. The
        // client has no progress signal here, so it must not fake one.
        let cells = 12u32;
        let gap = 4.0 * s;
        let cw = (dw - 40.0 * s - gap * (cells - 1) as f32) / cells as f32;
        let cy = dy + 46.0 * s;
        let head = ((self.phase * 7.0) as u32) % (cells + 3);
        for i in 0..cells {
            let lit = i + 3 > head && i <= head;
            ui.rect(
                dx + 20.0 * s + i as f32 * (cw + gap),
                cy,
                cw,
                10.0 * s,
                if lit { ACCENT } else { [10, 34, 40, 232] },
            );
        }

        text_center(
            ui,
            self.endpoint.text.as_str(),
            dx + dw * 0.5,
            cy + 16.0 * s,
            T_MICRO * s,
            [150, 214, 226, 220],
        );

        if action_bar(ui, EntryLayout::cancel_rect(w, h), s, "CANCEL", true) {
            self.stage = EntryStage::Login;
            self.status = Some("LINK ATTEMPT CANCELLED".to_string());
            return Some(ScreenAction::CancelConnect);
        }
        None
    }
}

// ── Character screens ───────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CharacterStage {
    /// Roster-focused selection with the selected character presented left.
    Roster,
    /// Creation step one — lineage, presentation and build.
    CreateProfile,
    /// Creation step two — naming and the final summary.
    CreateIdentity,
}

/// One roster row. `id` is an opaque host-owned stable identifier; screens
/// only retain it so their selection intent can be routed without deriving an
/// identity from display text. Meta fields are optional: a host that only knows
/// names leaves them empty and the detail block says so rather than inventing
/// data.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RosterEntry {
    pub id: String,
    /// Safe body projection for the retained roster viewer.
    pub female: bool,
    pub name: String,
    pub lineage: String,
    pub vocation: String,
    pub location: String,
    pub played: String,
}

impl RosterEntry {
    pub fn named(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            ..Default::default()
        }
    }
}

/// A Successor-owned playable lineage. Names, homeworlds and copy are original
/// to this project — the original client's species table is not reproduced.
pub struct Lineage {
    pub id: &'static str,
    pub name: &'static str,
    pub home: &'static str,
    pub blurb: &'static str,
}

pub const LINEAGES: [Lineage; 6] = [
    Lineage {
        id: "terran",
        name: "TERRAN",
        home: "CORE WORLDS",
        blurb: "Baseline settlers of the inner colonies, found on every registered world in the sector. Terran recruits carry no innate bonus and no innate penalty, which gives them the widest starting spread of any lineage and the shortest path into a second vocation.",
    },
    Lineage {
        id: "voskan",
        name: "VOSKAN",
        home: "HEAVY BELT",
        blurb: "Raised under crushing gravity in the belt foundries. Dense musculature, deliberate movement, and a frame built to hold ground. Voskan carry loads no other lineage will attempt, and pay for it in sprint endurance.",
    },
    Lineage {
        id: "iridian",
        name: "IRIDIAN",
        home: "SALT FLATS",
        blurb: "Nomads of the dry basins, built for heat and glare, with reflective scale patterning across the shoulders and forearms. Iridian scouts read terrain and weather earlier than the instruments issued to them do.",
    },
    Lineage {
        id: "kelmari",
        name: "KELMARI",
        home: "TIDEWORKS",
        blurb: "Amphibious dockhands out of the flooded works. Broad hands, a sealed airway, and a pressure tolerance that makes salvage diving routine labour rather than hazard pay.",
    },
    Lineage {
        id: "thalsi",
        name: "THALSI",
        home: "CANOPY REACH",
        blurb: "Arboreal climbers with long limbs and a low centre of mass. Thalsi read vertical space instinctively, take falls that would ground a Terran, and dislike open ground for exactly that reason.",
    },
    Lineage {
        id: "ogrim",
        name: "OGRIM",
        home: "ASH TERRACES",
        blurb: "Ash-terrace labourers with thickened hide and a slow metabolism. Ogrim endure exposure, airborne toxins and hunger well past the point where any other recruit files for extraction.",
    },
];

pub const VOCATIONS: [&str; 4] = ["TECHNICIAN", "SCOUT", "MEDIC", "MARKSMAN"];

/// Roster ceiling; the original capped characters per galaxy, and the creation
/// entry point goes inert at the cap rather than disappearing.
pub const ROSTER_CAP: usize = 8;

const NAME_HEADS: [&str; 12] = [
    "Sar", "Vel", "Tor", "Mek", "Ash", "Kel", "Dru", "Bel", "Nyx", "Ora", "Tav", "Zin",
];
const NAME_TAILS: [&str; 12] = [
    "ath", "ira", "on", "us", "el", "ka", "dan", "ris", "mo", "vek", "tia", "ur",
];
const SURNAMES: [&str; 12] = [
    "Halvex", "Draymond", "Okoro", "Vantel", "Sarn", "Ilbrecht", "Moss", "Karrow", "Deleon",
    "Ferrick", "Ostrand", "Yuel",
];

/// Deterministic Successor name from a seed — same seed, same name.
pub fn generated_name(seed: u32) -> (String, String) {
    let mut state = seed.wrapping_mul(0x9E37_79B9) | 1;
    let a = (xorshift(&mut state) % NAME_HEADS.len() as u32) as usize;
    let b = (xorshift(&mut state) % NAME_TAILS.len() as u32) as usize;
    let c = (xorshift(&mut state) % SURNAMES.len() as u32) as usize;
    (
        format!("{}{}", NAME_HEADS[a], NAME_TAILS[b]),
        SURNAMES[c].to_string(),
    )
}

pub struct CharacterLayout;
impl CharacterLayout {
    /// Creation stages composition: one tall framed controls pane sits flush
    /// right at roughly a quarter of the viewport, top-anchored.
    pub const PANEL_W: f32 = 340.0;
    pub const PANEL_MARGIN: f32 = 24.0;
    pub const PANEL_TOP: f32 = 34.0;
    pub const PANEL_BOTTOM_GAP: f32 = 118.0;
    pub const PAD: f32 = 14.0;
    pub const FIELD_H: f32 = 32.0;
    /// Roster selection frame from `character-selection.png`: a compact 527×273
    /// frame flush top-right (x487, y6 at 1024×768).
    pub const ROSTER_PANEL_W: f32 = 527.0;
    pub const ROSTER_PANEL_H: f32 = 273.0;

    pub fn panel_rect(w: f32, h: f32) -> [f32; 4] {
        let s = scale(h);
        let pw = Self::PANEL_W * s;
        let py = Self::PANEL_TOP * s;
        [
            w - pw - Self::PANEL_MARGIN * s,
            py,
            pw,
            h - py - Self::PANEL_BOTTOM_GAP * s,
        ]
    }

    pub fn roster_panel_rect(w: f32, h: f32) -> [f32; 4] {
        let s = scale(h);
        let pw = Self::ROSTER_PANEL_W * s;
        let ph = Self::ROSTER_PANEL_H * s;
        [w - pw - 10.0 * s, 6.0 * s, pw, ph]
    }

    /// Viewport reserved for the retained full-body presentation. A host with a
    /// live pawn renders into exactly this rect.
    ///
    /// Derived from the panel's left edge rather than a fixed viewport
    /// fraction, so the viewer keeps clear of the rail at 4:3 as well as 16:9.
    pub fn paperdoll_rect(w: f32, h: f32) -> [f32; 4] {
        let s = scale(h);
        let left = 40.0 * s;
        let right = Self::panel_rect(w, h)[0] - 24.0 * s;
        let avail = (right - left).max(1.0);
        let pw = (360.0 * s).min(avail);
        [left + (avail - pw) * 0.5, h * 0.10, pw, h * 0.76]
    }

    pub fn content_x(w: f32, h: f32) -> f32 {
        Self::panel_rect(w, h)[0] + Self::PAD * scale(h)
    }

    pub fn content_w(h: f32) -> f32 {
        let s = scale(h);
        Self::PANEL_W * s - Self::PAD * s * 2.0
    }

    pub fn roster_rows_visible(_w: f32, _h: f32) -> usize {
        6
    }

    /// Rect for the `slot`-th *visible* row (0 = topmost on screen).
    pub fn roster_row_rect(w: f32, h: f32, slot: usize) -> [f32; 4] {
        let s = scale(h);
        let [px, py, pw, _] = Self::roster_panel_rect(w, h);
        [
            px + 10.0 * s,
            py + 58.0 * s + slot as f32 * 26.0 * s,
            pw - 20.0 * s,
            24.0 * s,
        ]
    }

    pub fn page_up_rect(w: f32, h: f32) -> [f32; 4] {
        let s = scale(h);
        let [px, py, pw, _] = Self::roster_panel_rect(w, h);
        [px + pw - 42.0 * s, py + 6.0 * s, 20.0 * s, 20.0 * s]
    }

    pub fn page_down_rect(w: f32, h: f32) -> [f32; 4] {
        let s = scale(h);
        let [px, py, pw, _] = Self::roster_panel_rect(w, h);
        [px + pw - 20.0 * s, py + 6.0 * s, 20.0 * s, 20.0 * s]
    }

    pub fn new_character_rect(w: f32, h: f32) -> [f32; 4] {
        let s = scale(h);
        let [px, py, pw, ph] = Self::roster_panel_rect(w, h);
        let bw = (pw - 28.0 * s) * 0.5;
        [px + pw * 0.5 + 4.0 * s, py + ph - 34.0 * s, bw, 24.0 * s]
    }

    pub fn delete_character_rect(w: f32, h: f32) -> [f32; 4] {
        let s = scale(h);
        let [px, py, pw, ph] = Self::roster_panel_rect(w, h);
        let bw = (pw - 28.0 * s) * 0.5;
        [px + 10.0 * s, py + ph - 34.0 * s, bw, 24.0 * s]
    }

    pub fn lineage_row_rect(w: f32, h: f32, index: usize) -> [f32; 4] {
        let s = scale(h);
        [
            Self::content_x(w, h),
            Self::panel_rect(w, h)[1] + 232.0 * s + index as f32 * 26.0 * s,
            Self::content_w(h),
            26.0 * s,
        ]
    }

    pub fn gender_rect(w: f32, h: f32, female: bool) -> [f32; 4] {
        let s = scale(h);
        let cw = 92.0 * s;
        [
            Self::content_x(w, h) + if female { cw + 8.0 * s } else { 0.0 },
            Self::panel_rect(w, h)[1] + 424.0 * s,
            cw,
            24.0 * s,
        ]
    }

    pub fn build_rect(w: f32, h: f32) -> [f32; 4] {
        let s = scale(h);
        let label = 74.0 * s;
        [
            Self::content_x(w, h) + label,
            Self::panel_rect(w, h)[1] + 460.0 * s,
            Self::content_w(h) - label,
            22.0 * s,
        ]
    }

    pub fn vocation_rect(w: f32, h: f32, index: usize) -> [f32; 4] {
        let s = scale(h);
        let cw = (Self::content_w(h) - 8.0 * s) * 0.5;
        [
            Self::content_x(w, h) + (index % 2) as f32 * (cw + 8.0 * s),
            Self::panel_rect(w, h)[1] + 508.0 * s + (index / 2) as f32 * 28.0 * s,
            cw,
            24.0 * s,
        ]
    }

    pub fn name_field_rect(w: f32, h: f32) -> [f32; 4] {
        let s = scale(h);
        [
            Self::content_x(w, h),
            Self::panel_rect(w, h)[1] + 57.0 * s,
            Self::content_w(h),
            Self::FIELD_H * s,
        ]
    }

    pub fn surname_field_rect(w: f32, h: f32) -> [f32; 4] {
        let s = scale(h);
        [
            Self::content_x(w, h),
            Self::panel_rect(w, h)[1] + 116.0 * s,
            Self::content_w(h),
            Self::FIELD_H * s,
        ]
    }

    pub fn generate_rect(w: f32, h: f32) -> [f32; 4] {
        let s = scale(h);
        let bw = 190.0 * s;
        [
            Self::content_x(w, h) + (Self::content_w(h) - bw) * 0.5,
            Self::panel_rect(w, h)[1] + 160.0 * s,
            bw,
            22.0 * s,
        ]
    }

    pub fn tutorial_rect(w: f32, h: f32) -> [f32; 4] {
        let s = scale(h);
        let [_, py, _, ph] = Self::panel_rect(w, h);
        [
            Self::content_x(w, h),
            py + ph - 30.0 * s,
            Self::content_w(h),
            20.0 * s,
        ]
    }

    pub fn next_rect(w: f32, h: f32) -> [f32; 4] {
        nav_next_rect(w, h)
    }

    pub fn back_rect(_w: f32, h: f32) -> [f32; 4] {
        nav_back_rect(h)
    }
}

/// Mutable creation state carried across the two creation stages.
pub struct CreationDraft {
    pub lineage: usize,
    pub vocation: usize,
    pub female: bool,
    pub build: f32,
    pub tutorial: bool,
    pub name: TextField,
    pub surname: TextField,
    seed: u32,
}

impl Default for CreationDraft {
    fn default() -> Self {
        Self {
            lineage: 0,
            vocation: 0,
            female: false,
            build: 0.5,
            tutorial: true,
            name: TextField::new(24),
            surname: TextField::new(24),
            seed: 1,
        }
    }
}

impl CreationDraft {
    /// `NAME SURNAME`, trimmed; empty when no given name has been entered.
    pub fn full_name(&self) -> String {
        let first = self.name.text.trim();
        let last = self.surname.text.trim();
        if first.is_empty() {
            String::new()
        } else if last.is_empty() {
            first.to_string()
        } else {
            format!("{first} {last}")
        }
    }

    pub fn build_label(&self) -> &'static str {
        match self.build {
            b if b < 0.2 => "SLIGHT",
            b if b < 0.4 => "LEAN",
            b if b < 0.6 => "STANDARD",
            b if b < 0.8 => "SOLID",
            _ => "HEAVY",
        }
    }

    pub fn lineage(&self) -> &'static Lineage {
        &LINEAGES[self.lineage.min(LINEAGES.len() - 1)]
    }

    pub fn vocation(&self) -> &'static str {
        VOCATIONS[self.vocation.min(VOCATIONS.len() - 1)]
    }

    /// Fill both name fields with the next deterministic suggestion.
    pub fn generate(&mut self) {
        let (first, last) = generated_name(self.seed.wrapping_add(self.lineage as u32 * 977));
        self.seed = self.seed.wrapping_add(1);
        self.name.text = first;
        self.name.caret = self.name.text.chars().count();
        self.surname.text = last;
        self.surname.caret = self.surname.text.chars().count();
    }
}

pub struct CharacterScreen {
    pub roster: Vec<RosterEntry>,
    pub draft: CreationDraft,
    stage: CharacterStage,
    selected: usize,
    scroll: usize,
    paperdoll_hosted: bool,
    status: Option<String>,
    status_bad: bool,
    phase: f32,
}

impl CharacterScreen {
    /// Name-only roster (the host has not projected character detail yet).
    pub fn new(roster: Vec<String>) -> Self {
        Self::with_entries(roster.into_iter().map(RosterEntry::named).collect())
    }

    pub fn with_entries(roster: Vec<RosterEntry>) -> Self {
        Self {
            roster,
            draft: CreationDraft::default(),
            stage: CharacterStage::Roster,
            selected: 0,
            scroll: 0,
            paperdoll_hosted: false,
            status: None,
            status_bad: false,
            phase: 0.0,
        }
    }
    pub fn selected(&self) -> usize {
        self.selected
    }

    /// The opaque stable id of the highlighted roster entry, when the host
    /// projected one. Presentation-only/demo rows intentionally have none.
    pub fn selected_stable_id(&self) -> Option<&str> {
        self.roster
            .get(self.selected)
            .filter(|entry| !entry.id.is_empty())
            .map(|entry| entry.id.as_str())
    }

    /// Replace the host projection while preserving the selected stable id when
    /// it remains present. This lets a refreshed roster reorder safely.
    pub fn replace_roster(&mut self, roster: Vec<RosterEntry>) {
        let selected_id = self.selected_stable_id().map(str::to_owned);
        self.roster = roster;
        self.selected = selected_id
            .as_deref()
            .and_then(|id| self.roster.iter().position(|entry| entry.id == id))
            .unwrap_or_else(|| self.selected.min(self.roster.len().saturating_sub(1)));
        self.scroll = self.scroll.min(self.selected);
    }

    /// Highlight a projected stable id. A host calls this after a successful
    /// creation refresh so the new authoritative row remains the subject.
    pub fn select_stable_id(&mut self, id: &str) -> bool {
        let Some(index) = self.roster.iter().position(|entry| entry.id == id) else {
            return false;
        };
        self.selected = index;
        self.scroll = index;
        true
    }

    pub fn scroll(&self) -> usize {
        self.scroll
    }

    pub fn stage(&self) -> CharacterStage {
        self.stage
    }

    pub fn set_stage(&mut self, stage: CharacterStage) {
        self.stage = stage;
    }

    /// Suppress the abstract silhouette because the host draws a live pawn into
    /// [`CharacterLayout::paperdoll_rect`]. Pad, frame and caption stay.
    pub fn set_paperdoll_hosted(&mut self, hosted: bool) {
        self.paperdoll_hosted = hosted;
    }

    pub fn paperdoll_hosted(&self) -> bool {
        self.paperdoll_hosted
    }

    /// One-line status under the instruction copy — a pending/handoff note.
    /// Rendered on every character stage, so a hosted create that is waiting or
    /// rejected is visible on the surface that produced it.
    pub fn set_status(&mut self, status: impl Into<String>) {
        self.status = Some(status.into());
        self.status_bad = false;
    }

    /// Same line in the danger tone — for a bounded rejection.
    pub fn set_status_error(&mut self, status: impl Into<String>) {
        self.status = Some(status.into());
        self.status_bad = true;
    }

    pub fn status(&self) -> Option<&str> {
        self.status.as_deref()
    }

    pub fn status_is_error(&self) -> bool {
        self.status_bad
    }

    pub fn clear_status(&mut self) {
        self.status = None;
        self.status_bad = false;
    }

    pub fn tick(&mut self, dt: f32) {
        self.phase = (self.phase + dt) % 3600.0;
    }

    /// Move the roster highlight, keeping it inside the scrolled viewport.
    pub fn move_selection(&mut self, delta: i32, w: f32, h: f32) {
        if self.roster.is_empty() {
            return;
        }
        let last = self.roster.len() - 1;
        self.selected = (self.selected as i32 + delta).clamp(0, last as i32) as usize;
        let visible = CharacterLayout::roster_rows_visible(w, h);
        if self.selected < self.scroll {
            self.scroll = self.selected;
        } else if self.selected >= self.scroll + visible {
            self.scroll = self.selected + 1 - visible;
        }
    }

    fn focused_field(&mut self) -> Option<&mut TextField> {
        if self.stage != CharacterStage::CreateIdentity {
            return None;
        }
        if self.draft.name.focused {
            Some(&mut self.draft.name)
        } else if self.draft.surname.focused {
            Some(&mut self.draft.surname)
        } else {
            None
        }
    }

    pub fn input_char(&mut self, c: char) -> bool {
        match self.focused_field() {
            Some(field) => {
                field.insert(c);
                true
            }
            None => false,
        }
    }

    pub fn backspace(&mut self) -> bool {
        match self.focused_field() {
            Some(field) => {
                field.backspace();
                true
            }
            None => false,
        }
    }

    /// Tab traversal across the naming fields.
    pub fn focus_next(&mut self) {
        self.focus_step(true);
    }

    /// Shift+Tab traversal.
    pub fn focus_prev(&mut self) {
        self.focus_step(false);
    }

    fn focus_step(&mut self, forward: bool) {
        if self.stage != CharacterStage::CreateIdentity {
            return;
        }
        let to_surname = if self.draft.name.focused {
            true
        } else if self.draft.surname.focused {
            false
        } else {
            !forward
        };
        self.draft.name.focused = !to_surname;
        self.draft.surname.focused = to_surname;
        self.draft.name.caret = self.draft.name.text.chars().count();
        self.draft.surname.caret = self.draft.surname.text.chars().count();
    }

    pub fn draw(&mut self, ui: &mut UiBuilder, w: f32, h: f32) -> Option<ScreenAction> {
        let s = scale(h);
        let press = ui.interact(0.0, 0.0, w, h).pressed;
        draw_backdrop(ui, w, h, self.phase);
        draw_identity(
            ui,
            s,
            match self.stage {
                CharacterStage::Roster => 1,
                CharacterStage::CreateProfile => 2,
                CharacterStage::CreateIdentity => 3,
            },
        );
        self.draw_presentation(ui, w, h, s);

        match self.stage {
            CharacterStage::Roster => self.draw_roster(ui, w, h, s),
            CharacterStage::CreateProfile => self.draw_profile(ui, w, h, s),
            CharacterStage::CreateIdentity => self.draw_summary(ui, w, h, s, press),
        }
    }

    /// Retained left-hand presentation: viewer plus the subject's caption. Runs
    /// on every stage so the figure never disappears between steps.
    fn draw_presentation(&mut self, ui: &mut UiBuilder, w: f32, h: f32, s: f32) {
        let rect = CharacterLayout::paperdoll_rect(w, h);
        let creating = self.stage != CharacterStage::Roster;
        let has_subject = creating || !self.roster.is_empty();
        let figure = (!self.paperdoll_hosted && has_subject).then(|| Figure {
            build: if creating { self.draft.build } else { 0.5 },
            female: if creating {
                self.draft.female
            } else {
                self.roster
                    .get(self.selected)
                    .is_some_and(|entry| entry.female)
            },
        });
        draw_viewer(ui, rect, s, self.phase, figure.as_ref());

        let cx = rect[0] + rect[2] * 0.5;
        let cy = rect[1] + rect[3] * 0.95;
        let (title, sub) = if creating {
            let name = self.draft.full_name();
            (
                if name.is_empty() {
                    "UNNAMED".to_string()
                } else {
                    name.to_uppercase()
                },
                format!(
                    "{} / {} / {}",
                    self.draft.lineage().name,
                    if self.draft.female { "FEMALE" } else { "MALE" },
                    self.draft.build_label()
                ),
            )
        } else if let Some(entry) = self.roster.get(self.selected) {
            (entry.name.clone(), String::new())
        } else {
            (
                "NO CHARACTER".to_string(),
                "CREATE ONE TO CONTINUE".to_string(),
            )
        };
        let tp = T_TITLE * s * 0.86;
        text_center(ui, &title, cx, cy, tp, INK);
        if !sub.is_empty() {
            hairline(
                ui,
                cx - 60.0 * s,
                cy + glyph_h(tp) + 7.0 * s,
                120.0 * s,
                s,
                HAIRLINE_LIT,
            );
            text_center(
                ui,
                &sub,
                cx,
                cy + glyph_h(tp) + 14.0 * s,
                T_MICRO * s,
                INK_DIM,
            );
        }
    }

    fn draw_roster(&mut self, ui: &mut UiBuilder, w: f32, h: f32, s: f32) -> Option<ScreenAction> {
        let panel = CharacterLayout::roster_panel_rect(w, h);
        let [px, py, pw, _ph] = panel;
        let count = self.roster.len();
        draw_panel(
            ui,
            panel,
            s,
            "SELECT A CHARACTER",
            Some("AVAILABLE CHARACTERS"),
        );

        let visible = CharacterLayout::roster_rows_visible(w, h);
        self.scroll = self.scroll.min(count.saturating_sub(visible));

        // 4-column header bar (pill-like header buttons)
        let hy = py + 34.0 * s;
        let hw = pw - 20.0 * s;
        let hx = px + 10.0 * s;
        let cols = [
            ("Name", 0.38f32),
            ("Galaxy", 0.20),
            ("Planet", 0.24),
            ("Server", 0.18),
        ];
        ui.rect(hx, hy, hw, 18.0 * s, [0, 56, 68, 152]);
        hairline(ui, hx, hy + 18.0 * s, hw, s, HAIRLINE_LIT);
        let mut cur_x = hx;
        for (column, (name, ratio)) in cols.into_iter().enumerate() {
            let col_w = hw * ratio;
            // Column rhythm comes from the same left anchors as each row, not
            // four bordered cells.
            ui.text(
                name,
                cur_x + if column == 0 { 6.0 * s } else { 4.0 * s },
                hy + 3.0 * s,
                T_MICRO * s,
                INK_SOFT,
            );
            cur_x += col_w;
        }
        let mut action = None;

        // Paging chevrons, drawn only when the list overflows the viewport.
        if count > visible {
            for (r, up, live) in [
                (CharacterLayout::page_up_rect(w, h), true, self.scroll > 0),
                (
                    CharacterLayout::page_down_rect(w, h),
                    false,
                    self.scroll + visible < count,
                ),
            ] {
                let resp = ui.interact(r[0], r[1], r[2], r[3]);
                let tint = if !live {
                    INK_GHOST
                } else if resp.hovered {
                    ACCENT
                } else {
                    INK_DIM
                };
                let mid = r[0] + r[2] * 0.5;
                let (y0, y1) = if up {
                    (r[1] + r[3] * 0.64, r[1] + r[3] * 0.36)
                } else {
                    (r[1] + r[3] * 0.36, r[1] + r[3] * 0.64)
                };
                ui.line(mid - 5.0 * s, y0, mid, y1, 1.6 * s, tint);
                ui.line(mid, y1, mid + 5.0 * s, y0, 1.6 * s, tint);
                if live && resp.clicked {
                    self.scroll = if up {
                        self.scroll.saturating_sub(visible)
                    } else {
                        (self.scroll + visible).min(count - visible)
                    };
                }
            }
        }

        if count == 0 {
            let list_y = py + 58.0 * s;
            text_center(
                ui,
                "NO CHARACTERS ON THIS SHARD",
                px + pw * 0.5,
                list_y + 26.0 * s,
                T_BODY * s,
                INK_DIM,
            );
            text_center(
                ui,
                "Create one to continue.",
                px + pw * 0.5,
                list_y + 46.0 * s,
                T_MICRO * s,
                INK_GHOST,
            );
        }

        for slot in 0..visible.min(count.saturating_sub(self.scroll)) {
            let index = self.scroll + slot;
            let r = CharacterLayout::roster_row_rect(w, h, slot);
            let on = index == self.selected;
            let resp = ui.interact(r[0], r[1], r[2], r[3]);
            if on {
                ui.rect(r[0], r[1], r[2], r[3], ACCENT_SOFT);
                ui.rect(r[0], r[1], 3.0 * s, r[3], ACCENT);
                ui.mask_uv(
                    r[0] + r[2] - 11.0 * s,
                    r[1] + (r[3] - 13.0 * s) * 0.5,
                    8.0 * s,
                    13.0 * s,
                    crate::hud::ROSTER_CHEVRON_UV,
                    INK,
                );
            } else if resp.hovered {
                ui.rect(r[0], r[1], r[2], r[3], ROW_HOVER);
            } else if slot % 2 == 1 {
                ui.rect(r[0], r[1], r[2], r[3], [0, 44, 54, 68]);
            }
            let entry = &self.roster[index];
            let np = T_MICRO * s * 1.15;
            let col_y = r[1] + (r[3] - glyph_h(np)) * 0.5;

            // Col 0: Name
            ui.text(
                &entry.name,
                r[0] + 6.0 * s,
                col_y,
                np,
                if on { INK } else { INK_SOFT },
            );

            // Col 1: Galaxy
            let galaxy = if entry.lineage.is_empty() {
                "Core3"
            } else {
                &entry.lineage
            };
            ui.text(
                galaxy,
                r[0] + hw * 0.38 + 4.0 * s,
                col_y,
                np,
                if on { INK } else { INK_DIM },
            );

            // Col 2: Planet
            let planet = if entry.location.is_empty() {
                "Aboard a Space Station"
            } else {
                &entry.location
            };
            ui.text(
                planet,
                r[0] + hw * 0.58 + 4.0 * s,
                col_y,
                np,
                if on { INK } else { INK_DIM },
            );

            // Col 3: Server
            let server = if entry.vocation.is_empty() {
                "Online"
            } else {
                &entry.vocation
            };
            ui.text(
                server,
                r[0] + hw * 0.82 + 4.0 * s,
                col_y,
                np,
                if on { INK } else { INK_DIM },
            );

            if resp.clicked {
                if on {
                    action = Some(ScreenAction::SelectCharacter(index));
                } else {
                    self.selected = index;
                }
            }
        }

        // Delete & Create buttons on the roster panel's bottom band
        let delete_rect = CharacterLayout::delete_character_rect(w, h);
        if action_bar(ui, delete_rect, s, "Delete", count > 0) && count > 0 {
            self.status = Some(format!(
                "DELETE REQUESTED FOR {}",
                self.roster[self.selected].name
            ));
        }

        let create_rect = CharacterLayout::new_character_rect(w, h);
        if action_bar(ui, create_rect, s, "Create", count < ROSTER_CAP) {
            self.stage = CharacterStage::CreateProfile;
            self.status = None;
            return None;
        }

        // Bottom footer instructions
        // A host status (create rejected / awaiting authority) takes the second
        // line; otherwise the static helper copy keeps it.
        draw_footer(
            ui,
            w,
            h,
            s,
            "Choose the Character you would like to play now.",
            self.status.is_none().then_some(
                "You may also choose to Create a new Character, or Delete one of your existing Characters.",
            ),
        );
        if let Some(status) = self.status.as_deref() {
            draw_status_line(ui, w, h, s, status, self.status_bad);
        }

        // Exit button at bottom-left corner
        let exit_rect = [
            16.0 * s,
            h - NAV_INSET_Y * s - NAV_H * s * 0.5,
            120.0 * s,
            NAV_H * s,
        ];
        if action_bar(ui, exit_rect, s, "Exit", true) {
            action = Some(ScreenAction::Back);
        }

        // NEXT wedge at bottom-right corner
        if nav_plate(
            ui,
            CharacterLayout::next_rect(w, h),
            "NEXT",
            true,
            count > 0,
        ) {
            action = Some(ScreenAction::SelectCharacter(self.selected));
        }

        action
    }

    fn draw_profile(&mut self, ui: &mut UiBuilder, w: f32, h: f32, s: f32) -> Option<ScreenAction> {
        let panel = CharacterLayout::panel_rect(w, h);
        let py = panel[1];
        draw_panel(ui, panel, s, "LINEAGE & BUILD", Some("STEP 1 OF 2"));

        let cx = CharacterLayout::content_x(w, h);
        let cw = CharacterLayout::content_w(h);
        let lineage = self.draft.lineage();

        ui.text(lineage.home, cx, py + 40.0 * s, T_LABEL * s, ACCENT);
        draw_wrapped(
            ui,
            lineage.blurb,
            cx,
            py + 58.0 * s,
            cw,
            T_BODY * s,
            15.0 * s,
            8,
            INK_SOFT,
        );

        hairline(ui, cx, py + 200.0 * s, cw, s, HAIRLINE_LIT);
        ui.text("LINEAGE", cx, py + 210.0 * s, T_LABEL * s, INK_DIM);
        for (i, item) in LINEAGES.iter().enumerate() {
            let r = CharacterLayout::lineage_row_rect(w, h, i);
            let on = i == self.draft.lineage;
            let resp = ui.interact(r[0], r[1], r[2], r[3]);
            if on {
                ui.rect(r[0], r[1], r[2], r[3], ACCENT_SOFT);
                ui.rect(r[0], r[1], 3.0 * s, r[3], ACCENT);
            } else if resp.hovered {
                ui.rect(r[0], r[1], r[2], r[3], ROW_HOVER);
            }
            let np = T_BODY * s;
            ui.text(
                item.name,
                r[0] + 12.0 * s,
                r[1] + (r[3] - glyph_h(np)) * 0.5,
                np,
                if on { INK } else { INK_SOFT },
            );
            let mp = T_MICRO * s;
            text_right(
                ui,
                item.home,
                r[0] + r[2] - 10.0 * s,
                r[1] + (r[3] - glyph_h(mp)) * 0.5,
                mp,
                INK_DIM,
            );
            hairline(ui, r[0], r[1] + r[3] - 1.0 * s, r[2], s, [20, 34, 40, 190]);
            if resp.clicked {
                self.draft.lineage = i;
            }
        }

        ui.text("PRESENTATION", cx, py + 402.0 * s, T_LABEL * s, INK_DIM);
        if chip(
            ui,
            CharacterLayout::gender_rect(w, h, false),
            s,
            "MALE",
            !self.draft.female,
        ) {
            self.draft.female = false;
        }
        if chip(
            ui,
            CharacterLayout::gender_rect(w, h, true),
            s,
            "FEMALE",
            self.draft.female,
        ) {
            self.draft.female = true;
        }

        let build_rect = CharacterLayout::build_rect(w, h);
        let bp = T_LABEL * s;
        ui.text(
            "BUILD",
            cx,
            build_rect[1] + (build_rect[3] - glyph_h(bp)) * 0.5,
            bp,
            INK_DIM,
        );
        track(ui, build_rect, s, &mut self.draft.build);
        text_right(
            ui,
            self.draft.build_label(),
            cx + cw,
            build_rect[1] - 15.0 * s,
            T_MICRO * s,
            ACCENT,
        );

        ui.text(
            "STARTING VOCATION",
            cx,
            py + 490.0 * s,
            T_LABEL * s,
            INK_DIM,
        );
        for (i, name) in VOCATIONS.iter().enumerate() {
            if chip(
                ui,
                CharacterLayout::vocation_rect(w, h, i),
                s,
                name,
                i == self.draft.vocation,
            ) {
                self.draft.vocation = i;
            }
        }

        draw_footer(
            ui,
            w,
            h,
            s,
            "Choose a lineage, presentation and build for your new character.",
            None,
        );
        if let Some(status) = self.status.as_deref() {
            draw_status_line(ui, w, h, s, status, self.status_bad);
        }

        if nav_plate(ui, CharacterLayout::next_rect(w, h), "NEXT", true, true) {
            self.stage = CharacterStage::CreateIdentity;
            return None;
        }
        if nav_plate(ui, CharacterLayout::back_rect(w, h), "BACK", false, true) {
            self.stage = CharacterStage::Roster;
        }
        None
    }

    fn draw_summary(
        &mut self,
        ui: &mut UiBuilder,
        w: f32,
        h: f32,
        s: f32,
        press: bool,
    ) -> Option<ScreenAction> {
        let panel = CharacterLayout::panel_rect(w, h);
        let [_, py, _, ph] = panel;
        draw_panel(ui, panel, s, "CHARACTER SUMMARY", Some("STEP 2 OF 2"));

        let cx = CharacterLayout::content_x(w, h);
        let cw = CharacterLayout::content_w(h);
        let centre = cx + cw * 0.5;
        let lp = T_LABEL * s;

        // Centred labels above centred fields, as the original summary page.
        let name_rect = CharacterLayout::name_field_rect(w, h);
        text_center(ui, "NAME", centre, name_rect[1] - 15.0 * s, lp, INK_SOFT);
        draw_field(
            ui,
            &mut self.draft.name,
            name_rect,
            s,
            self.phase,
            press,
            "given name",
        );

        let sur_rect = CharacterLayout::surname_field_rect(w, h);
        text_center(ui, "SURNAME", centre, sur_rect[1] - 15.0 * s, lp, INK_SOFT);
        draw_field(
            ui,
            &mut self.draft.surname,
            sur_rect,
            s,
            self.phase,
            press,
            "optional",
        );

        if action_bar(
            ui,
            CharacterLayout::generate_rect(w, h),
            s,
            "GENERATE A NAME",
            true,
        ) {
            self.draft.generate();
        }

        hairline(ui, cx, py + 196.0 * s, cw, s, HAIRLINE_LIT);
        ui.text("PROFILE", cx, py + 206.0 * s, T_LABEL * s, INK_DIM);
        let lineage = self.draft.lineage();
        let mut ry = py + 226.0 * s;
        for (key, value) in [
            ("LINEAGE", lineage.name),
            ("HOMEWORLD", lineage.home),
            (
                "PRESENTATION",
                if self.draft.female { "FEMALE" } else { "MALE" },
            ),
            ("BUILD", self.draft.build_label()),
            ("VOCATION", self.draft.vocation()),
        ] {
            kv_row(ui, cx, ry, cw, s, key, value);
            ry += 21.0 * s;
        }

        hairline(ui, cx, ry + 6.0 * s, cw, s, HAIRLINE_LIT);
        ui.text("DOSSIER", cx, ry + 16.0 * s, T_LABEL * s, INK_DIM);
        let dossier_top = ry + 34.0 * s;
        let dossier_h = py + ph - 46.0 * s - dossier_top;
        ui.rect(cx, dossier_top, cw, dossier_h, [6, 15, 19, 190]);
        let full = self.draft.full_name();
        let dossier = if full.is_empty() {
            format!(
                "Awaiting a name. This recruit will file out of the {}, {} build, trained toward {}.",
                lineage.home.to_lowercase(),
                self.draft.build_label().to_lowercase(),
                self.draft.vocation().to_lowercase()
            )
        } else {
            format!(
                "{full} files as {} out of the {}, {} build, trained toward {}. The record opens on first landfall and follows this recruit for the length of service.",
                lineage.name.to_lowercase(),
                lineage.home.to_lowercase(),
                self.draft.build_label().to_lowercase(),
                self.draft.vocation().to_lowercase()
            )
        };
        let line_h = 15.0 * s;
        let max_lines = ((dossier_h - 12.0 * s) / line_h).floor().max(1.0) as usize;
        draw_wrapped(
            ui,
            &dossier,
            cx + 8.0 * s,
            dossier_top + 7.0 * s,
            cw - 22.0 * s,
            T_BODY * s,
            line_h,
            max_lines,
            INK_SOFT,
        );
        // Scroll rail sized to the fraction the area shows.
        ui.rect(
            cx + cw - 5.0 * s,
            dossier_top,
            3.0 * s,
            dossier_h,
            [14, 30, 36, 220],
        );
        ui.rect(
            cx + cw - 5.0 * s,
            dossier_top,
            3.0 * s,
            dossier_h * 0.72,
            HAIRLINE_LIT,
        );

        check_row(
            ui,
            CharacterLayout::tutorial_rect(w, h),
            s,
            "SHOW NEW PLAYER TUTORIAL",
            &mut self.draft.tutorial,
        );

        draw_footer(
            ui,
            w,
            h,
            s,
            "Review the profile and name your character, then continue to create.",
            None,
        );
        if let Some(status) = self.status.as_deref() {
            draw_status_line(ui, w, h, s, status, self.status_bad);
        }

        let can = !full.is_empty();
        let next = CharacterLayout::next_rect(w, h);
        if !can {
            text_right(
                ui,
                "A GIVEN NAME IS REQUIRED",
                next[0] + next[2],
                next[1] - 16.0 * s,
                T_MICRO * s,
                DANGER,
            );
        }
        if nav_plate(ui, next, "CREATE", true, can) {
            return Some(ScreenAction::CreateCharacter(full));
        }
        if nav_plate(ui, CharacterLayout::back_rect(w, h), "BACK", false, true) {
            self.stage = CharacterStage::CreateProfile;
        }
        None
    }
}
// ── Loading screen ──────────────────────────────────────────────────────────

/// Replayable loading presentation — bridges roster/creation selection into the
/// connected world.
pub struct LoadingScreen {
    pub zone_name: String,
    pub zone_sub: String,
    pub tip: String,
    pub progress: f32,
    pub indeterminate: bool,
    pub status_text: String,
    phase: f32,
}

impl Default for LoadingScreen {
    fn default() -> Self {
        Self::new("OPEN DESERT", "PLANETFALL // OPEN-DESERT-OVERWORLD")
    }
}

impl LoadingScreen {
    pub fn new(zone_name: impl Into<String>, zone_sub: impl Into<String>) -> Self {
        Self {
            zone_name: zone_name.into(),
            zone_sub: zone_sub.into(),
            tip: "Planetary waypoints can be created from your datapad or shared with group members via chat.".to_string(),
            progress: 0.68,
            indeterminate: false,
            status_text: "INITIALIZING ENVIRONMENT".to_string(),
            phase: 0.0,
        }
    }

    pub fn tick(&mut self, dt: f32) {
        self.phase = (self.phase + dt) % 3600.0;
    }

    pub fn set_progress(&mut self, progress: f32) {
        self.progress = progress.clamp(0.0, 1.0);
    }

    pub fn set_indeterminate(&mut self, indeterminate: bool) {
        self.indeterminate = indeterminate;
        if indeterminate && self.status_text == "INITIALIZING ENVIRONMENT" {
            self.status_text = "AWAITING WORLD SNAPSHOT".to_string();
        }
    }
    pub fn draw(&mut self, ui: &mut UiBuilder, w: f32, h: f32) -> Option<ScreenAction> {
        let s = scale(h);
        draw_backdrop(ui, w, h, self.phase);

        // Minimal, unboxed spatial presentation: open typography plus one
        // authored destination image, without nested outlines or panel stacks.
        let margin = (32.0 * s).max(16.0);
        let top_y = 28.0 * s;

        ui.text(
            "SUCCESSOR / TRANSFER CONTROL",
            margin,
            top_y,
            T_LABEL * s,
            INK,
        );
        text_right(ui, "WORLD LINK 01", w - margin, top_y, T_LABEL * s, INK_DIM);
        hairline(
            ui,
            margin,
            top_y + 18.0 * s,
            w - margin * 2.0,
            s,
            HAIRLINE_LIT,
        );

        let content_y = top_y + 36.0 * s;
        let content_h = h - content_y - 84.0 * s;
        let aperture_x = margin;
        let aperture_w = (w - margin * 2.0) * 0.46;

        let art_size = aperture_w.min(content_h - 32.0 * s).max(1.0);
        let art_x = aperture_x + (aperture_w - art_size) * 0.5;
        let art_y = content_y + 10.0 * s;
        ui.image_uv(
            art_x,
            art_y,
            art_size,
            art_size,
            crate::hud::LOADING_DESTINATION_UV,
            [255, 255, 255, 250],
        );
        ui.text(
            "DESTINATION VISUAL",
            aperture_x,
            content_y,
            T_LABEL * s,
            ACCENT,
        );
        ui.text(
            &self.zone_sub,
            aperture_x,
            content_y + content_h - 16.0 * s,
            T_LABEL * s,
            INK_SOFT,
        );

        let info_x = aperture_x + aperture_w + 36.0 * s;
        let info_y = content_y;
        let info_w = w - margin - info_x;

        ui.text("TRANSFER DOSSIER", info_x, info_y, T_LABEL * s, ACCENT);
        ui.text(
            &self.zone_name,
            info_x,
            info_y + 24.0 * s,
            T_TITLE * 1.3 * s,
            INK,
        );
        ui.text(
            &self.zone_sub,
            info_x,
            info_y + 56.0 * s,
            T_BODY * s,
            INK_SOFT,
        );
        hairline(ui, info_x, info_y + 80.0 * s, info_w, s, HAIRLINE_LIT);

        let field_y = info_y + 96.0 * s;
        ui.text("TRANSFER", info_x, field_y, T_LABEL * s, INK_DIM);
        text_right(
            ui,
            if self.indeterminate {
                "STREAMING"
            } else {
                "STAGED"
            },
            info_x + info_w,
            field_y,
            T_BODY * s,
            INK,
        );
        ui.text(
            "AUTHORITY",
            info_x,
            field_y + 24.0 * s,
            T_LABEL * s,
            INK_DIM,
        );
        text_right(
            ui,
            "WORLD SNAPSHOT",
            info_x + info_w,
            field_y + 24.0 * s,
            T_BODY * s,
            INK,
        );
        ui.text(
            "FIELD BRIEFING",
            info_x,
            field_y + 58.0 * s,
            T_LABEL * s,
            ACCENT,
        );
        draw_wrapped(
            ui,
            &self.tip,
            info_x,
            field_y + 80.0 * s,
            info_w,
            T_BODY * s,
            18.0 * s,
            6,
            INK_SOFT,
        );

        // Segmented radial progress instrument at bottom right.
        let progress_cx = info_x + info_w * 0.5;
        let progress_cy = h - 68.0 * s;
        let radius = 30.0 * s;
        let segments = 18u32;
        let filled = ((self.progress * segments as f32).round() as u32).min(segments);
        let head = ((self.phase * 12.0) as u32) % segments;
        ui.mask_uv(
            progress_cx - radius,
            progress_cy - radius,
            radius * 2.0,
            radius * 2.0,
            crate::hud::RADIAL_TICK_CROWN_UV,
            [8, 70, 82, 220],
        );
        let arc_radius = radius - 10.0 * s;
        ui.mask_uv(
            progress_cx - arc_radius,
            progress_cy - arc_radius,
            arc_radius * 2.0,
            arc_radius * 2.0,
            crate::hud::PROGRESS_ARC_UV,
            [80, 224, 244, 160],
        );
        for i in 0..segments {
            let a =
                -std::f32::consts::FRAC_PI_2 + i as f32 / segments as f32 * std::f32::consts::TAU;
            let (c, sn) = (a.cos(), a.sin());
            let active = if self.indeterminate {
                (head + segments - i) % segments < 7
            } else {
                i < filled
            };
            let marker = !self.indeterminate && i == filled && self.progress < 1.0;
            if !active && !marker {
                continue;
            }
            let color = if active { [98, 255, 21, 255] } else { ACCENT };
            ui.line(
                progress_cx + c * (radius - 8.0 * s),
                progress_cy + sn * (radius - 8.0 * s),
                progress_cx + c * radius,
                progress_cy + sn * radius,
                (2.0 * s).max(1.0),
                color,
            );
        }
        if self.indeterminate {
            text_center(
                ui,
                "SYNC",
                progress_cx,
                progress_cy - 5.0 * s,
                T_LABEL * s,
                INK,
            );
        } else {
            let percent = format!("{}%", (self.progress * 100.0) as u32);
            text_center(
                ui,
                &percent,
                progress_cx,
                progress_cy - 5.0 * s,
                T_LABEL * s,
                INK,
            );
        }
        text_center(
            ui,
            &self.status_text,
            progress_cx,
            progress_cy + radius + 8.0 * s,
            T_LABEL * s,
            INK_SOFT,
        );
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use successor_engine_render::ui::AtlasMeta;

    const ATLAS: AtlasMeta = AtlasMeta {
        cell: 32,
        cols: 8,
        width: 256,
        height: 160,
    };
    const W: f32 = 1280.0;
    const H: f32 = 720.0;

    fn builder() -> UiBuilder {
        UiBuilder::new(ATLAS)
    }

    /// A click needs a press frame and a release frame; the action is whatever
    /// the release frame emits. Asserts the press frame stayed silent.
    fn tap<F>(ui: &mut UiBuilder, rect: [f32; 4], mut draw: F) -> Option<ScreenAction>
    where
        F: FnMut(&mut UiBuilder) -> Option<ScreenAction>,
    {
        let cx = rect[0] + rect[2] * 0.5;
        let cy = rect[1] + rect[3] * 0.5;
        ui.set_input(cx, cy, true);
        ui.begin(W as u32, H as u32);
        assert!(draw(ui).is_none(), "press frame must not emit an action");
        ui.set_input(cx, cy, false);
        ui.begin(W as u32, H as u32);
        draw(ui)
    }

    /// One frame with the pointer parked off every control.
    fn idle<F>(ui: &mut UiBuilder, mut draw: F) -> Option<ScreenAction>
    where
        F: FnMut(&mut UiBuilder) -> Option<ScreenAction>,
    {
        ui.set_input(-100.0, -100.0, false);
        ui.begin(W as u32, H as u32);
        draw(ui)
    }

    fn sample_roster(n: usize) -> Vec<RosterEntry> {
        (0..n)
            .map(|i| RosterEntry {
                id: format!("demo-{i}"),
                female: false,
                name: format!("RECRUIT {i}"),
                lineage: "TERRAN".into(),
                vocation: "SCOUT".into(),
                location: "TIDEWORKS".into(),
                played: "12H".into(),
            })
            .collect()
    }

    // ── Entry ──────────────────────────────────────────────────────────────

    #[test]
    fn entry_defaults_are_development_values() {
        let screen = EntryScreen::new();
        assert_eq!(screen.endpoint.text, "ws://127.0.0.1:28093/");
        assert_eq!(screen.player.text, "dev-1");
        assert_eq!(screen.stage(), EntryStage::Login);
    }

    #[test]
    fn entry_connect_emits_options_and_enters_connecting_stage() {
        let mut screen = EntryScreen::new();
        let mut ui = builder();
        let action = tap(&mut ui, EntryLayout::connect_rect(W, H), |ui| {
            screen.draw(ui, W, H)
        });
        match action {
            Some(ScreenAction::Connect(opts)) => {
                assert_eq!(opts.endpoint, "ws://127.0.0.1:28093/");
                assert_eq!(opts.player_id, "dev-1");
                assert_eq!(opts.actor_id, "dev-1");
                assert!(opts.ticket.is_none());
                assert!(opts.release.is_none());
            }
            other => panic!("expected Connect, got {other:?}"),
        }
        assert_eq!(screen.stage(), EntryStage::Connecting);
    }

    #[test]
    fn entry_refuses_connect_without_identity() {
        let mut screen = EntryScreen::new();
        screen.player.text.clear();
        let mut ui = builder();
        let rect = EntryLayout::connect_rect(W, H);
        let cx = rect[0] + rect[2] * 0.5;
        let cy = rect[1] + rect[3] * 0.5;
        ui.set_input(cx, cy, true);
        ui.begin(W as u32, H as u32);
        assert!(screen.draw(&mut ui, W, H).is_none());
        ui.set_input(cx, cy, false);
        ui.begin(W as u32, H as u32);
        assert!(screen.draw(&mut ui, W, H).is_none());
        assert_eq!(screen.stage(), EntryStage::Login);
    }

    #[test]
    fn entry_cancel_returns_to_login_and_reports() {
        let mut screen = EntryScreen::new();
        screen.begin_connecting();
        let mut ui = builder();
        let action = tap(&mut ui, EntryLayout::cancel_rect(W, H), |ui| {
            screen.draw(ui, W, H)
        });
        assert_eq!(action, Some(ScreenAction::CancelConnect));
        assert_eq!(screen.stage(), EntryStage::Login);
        assert_eq!(screen.status(), Some("LINK ATTEMPT CANCELLED"));
    }

    #[test]
    fn connecting_dialog_owns_input() {
        // The login controls behind the modal must be inert while it is up.
        let mut screen = EntryScreen::new();
        screen.begin_connecting();
        let mut ui = builder();
        let action = tap(&mut ui, EntryLayout::connect_rect(W, H), |ui| {
            screen.draw(ui, W, H)
        });
        assert_eq!(action, None);
        assert_eq!(screen.stage(), EntryStage::Connecting);
    }

    #[test]
    fn entry_back_and_quit_outputs() {
        let mut screen = EntryScreen::new();
        let mut ui = builder();
        let back = tap(&mut ui, EntryLayout::back_rect(W, H), |ui| {
            screen.draw(ui, W, H)
        });
        assert_eq!(back, Some(ScreenAction::Back));
        assert_eq!(screen.stage(), EntryStage::Login);

        let mut screen = EntryScreen::new();
        let mut ui = builder();
        let quit = tap(&mut ui, EntryLayout::quit_rect(W, H), |ui| {
            screen.draw(ui, W, H)
        });
        assert_eq!(quit, Some(ScreenAction::Quit));
    }

    #[test]
    fn entry_field_click_focuses_and_typing_routes() {
        let mut screen = EntryScreen::new();
        let mut ui = builder();
        let action = tap(&mut ui, EntryLayout::player_rect(W, H), |ui| {
            screen.draw(ui, W, H)
        });
        assert_eq!(action, None);
        assert!(screen.player.focused);
        assert!(!screen.endpoint.focused);

        screen.player.clear();
        assert!(screen.input_char('x'));
        assert_eq!(screen.player.text, "x");
        assert!(screen.backspace());
        assert!(screen.player.text.is_empty());
    }

    #[test]
    fn entry_tab_traversal_cycles_both_directions() {
        let mut screen = EntryScreen::new();
        // From nothing focused, Tab lands on the first stop, Shift+Tab the last.
        screen.focus_next();
        assert!(screen.endpoint.focused && !screen.player.focused);
        screen.focus_next();
        assert!(screen.player.focused && !screen.endpoint.focused);
        screen.focus_prev();
        assert!(screen.endpoint.focused && !screen.player.focused);

        let mut screen = EntryScreen::new();
        screen.focus_prev();
        assert!(screen.player.focused && !screen.endpoint.focused);
    }

    #[test]
    fn connecting_stage_swallows_text_input() {
        let mut screen = EntryScreen::new();
        screen.endpoint.focused = true;
        screen.begin_connecting();
        assert!(!screen.input_char('z'));
        assert!(!screen.backspace());
        assert_eq!(screen.endpoint.text, "ws://127.0.0.1:28093/");
    }

    #[test]
    fn entry_failure_surfaces_and_resets_stage() {
        let mut screen = EntryScreen::new();
        screen.begin_connecting();
        screen.fail("LINK REFUSED");
        assert_eq!(screen.stage(), EntryStage::Login);
        assert_eq!(screen.status(), Some("LINK REFUSED"));
        let mut ui = builder();
        assert!(idle(&mut ui, |ui| screen.draw(ui, W, H)).is_none());
    }

    // ── Roster ─────────────────────────────────────────────────────────────

    #[test]
    fn roster_click_highlights_then_confirms() {
        let mut screen = CharacterScreen::with_entries(sample_roster(3));
        let mut ui = builder();
        let row = CharacterLayout::roster_row_rect(W, H, 1);

        let first = tap(&mut ui, row, |ui| screen.draw(ui, W, H));
        assert_eq!(first, None, "first click only moves the highlight");
        assert_eq!(screen.selected(), 1);

        let second = tap(&mut ui, row, |ui| screen.draw(ui, W, H));
        assert_eq!(second, Some(ScreenAction::SelectCharacter(1)));
    }

    #[test]
    fn roster_enter_plate_confirms_the_highlight() {
        let mut screen = CharacterScreen::with_entries(sample_roster(3));
        let mut ui = builder();
        tap(&mut ui, CharacterLayout::roster_row_rect(W, H, 2), |ui| {
            screen.draw(ui, W, H)
        });
        assert_eq!(screen.selected(), 2);

        let action = tap(&mut ui, CharacterLayout::next_rect(W, H), |ui| {
            screen.draw(ui, W, H)
        });
        assert_eq!(action, Some(ScreenAction::SelectCharacter(2)));
    }

    #[test]
    fn empty_roster_cannot_be_confirmed() {
        let mut screen = CharacterScreen::new(vec![]);
        let mut ui = builder();
        let rect = CharacterLayout::next_rect(W, H);
        let cx = rect[0] + rect[2] * 0.5;
        let cy = rect[1] + rect[3] * 0.5;
        ui.set_input(cx, cy, true);
        ui.begin(W as u32, H as u32);
        assert!(screen.draw(&mut ui, W, H).is_none());
        ui.set_input(cx, cy, false);
        ui.begin(W as u32, H as u32);
        assert!(screen.draw(&mut ui, W, H).is_none());
    }

    #[test]
    fn roster_back_leaves_the_flow() {
        let mut screen = CharacterScreen::with_entries(sample_roster(2));
        let mut ui = builder();
        let action = tap(&mut ui, CharacterLayout::back_rect(W, H), |ui| {
            screen.draw(ui, W, H)
        });
        assert_eq!(action, Some(ScreenAction::Back));
        assert_eq!(screen.stage(), CharacterStage::Roster);
    }

    #[test]
    fn roster_pages_long_lists_inside_the_panel() {
        let visible = CharacterLayout::roster_rows_visible(W, H);
        let total = visible + 5;
        let mut screen = CharacterScreen::with_entries(sample_roster(total));
        let mut ui = builder();

        let action = tap(&mut ui, CharacterLayout::page_down_rect(W, H), |ui| {
            screen.draw(ui, W, H)
        });
        assert_eq!(action, None);
        assert_eq!(screen.scroll(), total - visible);

        let up = tap(&mut ui, CharacterLayout::page_up_rect(W, H), |ui| {
            screen.draw(ui, W, H)
        });
        assert_eq!(up, None);
        assert_eq!(screen.scroll(), 0);
    }

    #[test]
    fn keyboard_selection_follows_the_scrolled_viewport() {
        let visible = CharacterLayout::roster_rows_visible(W, H);
        let total = visible + 3;
        let mut screen = CharacterScreen::with_entries(sample_roster(total));
        for _ in 0..total + 4 {
            screen.move_selection(1, W, H);
        }
        assert_eq!(screen.selected(), total - 1, "selection clamps at the end");
        assert_eq!(screen.scroll(), total - visible);
        assert!(screen.selected() >= screen.scroll());
        assert!(screen.selected() < screen.scroll() + visible);

        for _ in 0..total + 4 {
            screen.move_selection(-1, W, H);
        }
        assert_eq!(screen.selected(), 0);
        assert_eq!(screen.scroll(), 0);
    }

    // ── Creation ───────────────────────────────────────────────────────────

    #[test]
    fn new_character_opens_the_profile_stage() {
        let mut screen = CharacterScreen::with_entries(sample_roster(1));
        let mut ui = builder();
        let action = tap(&mut ui, CharacterLayout::new_character_rect(W, H), |ui| {
            screen.draw(ui, W, H)
        });
        assert_eq!(action, None);
        assert_eq!(screen.stage(), CharacterStage::CreateProfile);
    }

    #[test]
    fn full_roster_cannot_start_another_character() {
        let mut screen = CharacterScreen::with_entries(sample_roster(ROSTER_CAP));
        let mut ui = builder();
        let action = tap(&mut ui, CharacterLayout::new_character_rect(W, H), |ui| {
            screen.draw(ui, W, H)
        });
        assert_eq!(action, None);
        assert_eq!(screen.stage(), CharacterStage::Roster);
    }

    #[test]
    fn creation_stages_advance_and_unwind() {
        let mut screen = CharacterScreen::new(vec![]);
        screen.set_stage(CharacterStage::CreateProfile);
        let mut ui = builder();

        tap(&mut ui, CharacterLayout::next_rect(W, H), |ui| {
            screen.draw(ui, W, H)
        });
        assert_eq!(screen.stage(), CharacterStage::CreateIdentity);

        tap(&mut ui, CharacterLayout::back_rect(W, H), |ui| {
            screen.draw(ui, W, H)
        });
        assert_eq!(screen.stage(), CharacterStage::CreateProfile);

        // Backing out of the first creation step returns to the roster and does
        // NOT leak a `Back` action to the host.
        let action = tap(&mut ui, CharacterLayout::back_rect(W, H), |ui| {
            screen.draw(ui, W, H)
        });
        assert_eq!(action, None);
        assert_eq!(screen.stage(), CharacterStage::Roster);
    }

    #[test]
    fn profile_choices_bind_to_the_draft() {
        let mut screen = CharacterScreen::new(vec![]);
        screen.set_stage(CharacterStage::CreateProfile);
        let mut ui = builder();

        tap(&mut ui, CharacterLayout::lineage_row_rect(W, H, 3), |ui| {
            screen.draw(ui, W, H)
        });
        assert_eq!(screen.draft.lineage, 3);
        assert_eq!(screen.draft.lineage().name, LINEAGES[3].name);

        tap(&mut ui, CharacterLayout::gender_rect(W, H, true), |ui| {
            screen.draw(ui, W, H)
        });
        assert!(screen.draft.female);

        tap(&mut ui, CharacterLayout::vocation_rect(W, H, 2), |ui| {
            screen.draw(ui, W, H)
        });
        assert_eq!(screen.draft.vocation(), VOCATIONS[2]);

        // The build track is a drag control: pressing at 20% sets 20%.
        let bar = CharacterLayout::build_rect(W, H);
        ui.set_input(bar[0] + bar[2] * 0.3, bar[1] + bar[3] * 0.5, true);
        ui.begin(W as u32, H as u32);
        screen.draw(&mut ui, W, H);
        assert!((screen.draft.build - 0.3).abs() < 0.02);
        assert_eq!(screen.draft.build_label(), "LEAN");
    }

    #[test]
    fn create_requires_a_name_then_emits_it() {
        let mut screen = CharacterScreen::new(vec![]);
        screen.set_stage(CharacterStage::CreateIdentity);
        let mut ui = builder();

        let rect = CharacterLayout::next_rect(W, H);
        let cx = rect[0] + rect[2] * 0.5;
        let cy = rect[1] + rect[3] * 0.5;
        ui.set_input(cx, cy, true);
        ui.begin(W as u32, H as u32);
        assert!(screen.draw(&mut ui, W, H).is_none());
        ui.set_input(cx, cy, false);
        ui.begin(W as u32, H as u32);
        assert!(
            screen.draw(&mut ui, W, H).is_none(),
            "CREATE is inert without a given name"
        );

        screen.draft.name.text = "CHARLIE".to_string();
        screen.draft.name.caret = screen.draft.name.text.chars().count();
        let action = tap(&mut ui, rect, |ui| screen.draw(ui, W, H));
        assert_eq!(
            action,
            Some(ScreenAction::CreateCharacter("CHARLIE".to_string()))
        );

        screen.draft.surname.text = "MOSS".to_string();
        let action = tap(&mut ui, rect, |ui| screen.draw(ui, W, H));
        assert_eq!(
            action,
            Some(ScreenAction::CreateCharacter("CHARLIE MOSS".to_string()))
        );
    }

    #[test]
    fn generate_fills_both_name_fields_deterministically() {
        let mut screen = CharacterScreen::new(vec![]);
        screen.set_stage(CharacterStage::CreateIdentity);
        let mut ui = builder();
        tap(&mut ui, CharacterLayout::generate_rect(W, H), |ui| {
            screen.draw(ui, W, H)
        });
        let first = screen.draft.full_name();
        assert!(!first.is_empty());
        assert!(first.contains(' '), "generated names include a surname");

        // Same seed ⇒ same name; the generator is not a nondeterminism source.
        assert_eq!(generated_name(7), generated_name(7));
        assert_ne!(generated_name(7), generated_name(8));
    }

    #[test]
    fn summary_tab_traversal_and_typing() {
        let mut screen = CharacterScreen::new(vec![]);
        screen.set_stage(CharacterStage::CreateIdentity);
        screen.focus_next();
        assert!(screen.draft.name.focused);
        assert!(screen.input_char('A'));
        screen.focus_next();
        assert!(screen.draft.surname.focused);
        assert!(screen.input_char('B'));
        screen.focus_prev();
        assert!(screen.draft.name.focused);
        assert_eq!(screen.draft.full_name(), "A B");
    }

    #[test]
    fn roster_stage_ignores_naming_input() {
        let mut screen = CharacterScreen::with_entries(sample_roster(1));
        screen.draft.name.focused = true;
        assert!(!screen.input_char('q'));
        assert!(!screen.backspace());
        screen.focus_next();
        assert!(screen.draft.name.focused, "traversal is a no-op off-stage");
    }

    // ── Layout invariants ──────────────────────────────────────────────────

    #[test]
    fn navigation_keeps_the_original_far_edge_anchor() {
        // The original client pins NEXT to (W-109, H-38) at every size.
        for (w, h) in [(1280.0f32, 720.0f32), (1024.0, 768.0), (1920.0, 1080.0)] {
            let next = nav_next_rect(w, h);
            let back = nav_back_rect(h);
            let cx = next[0] + next[2] * 0.5;
            let cy = next[1] + next[3] * 0.5;
            assert!((cx - (w - NAV_INSET_X)).abs() < 0.01, "{w}x{h} next x");
            assert!((cy - (h - NAV_INSET_Y)).abs() < 0.01, "{w}x{h} next y");
            assert!(
                (back[0] + back[2] * 0.5 - NAV_INSET_X).abs() < 0.01,
                "{w}x{h} back x"
            );
            assert!(
                next[0] > w * 0.5 && back[0] < w * 0.5,
                "plates sit in corners"
            );
        }
    }

    #[test]
    fn layout_is_viewport_relative_and_stays_on_screen() {
        for (w, h) in [(1280.0f32, 720.0f32), (1024.0, 768.0), (1600.0, 900.0)] {
            let panel = CharacterLayout::panel_rect(w, h);
            let doll = CharacterLayout::paperdoll_rect(w, h);
            let nav = nav_next_rect(w, h);

            assert!(panel[0] > 0.0 && panel[0] + panel[2] < w, "{w}x{h} panel x");
            assert!(panel[1] > 0.0 && panel[1] + panel[3] < h, "{w}x{h} panel y");
            // The panel owns the right rail; the viewer keeps the left.
            assert!(
                panel[0] > w * 0.5 && panel[0] + panel[2] > w * 0.9,
                "{w}x{h} panel is a flush-right rail"
            );
            // A quarter of a 16:9 viewport, naturally a little more at 4:3 —
            // but always a minority rail, never a half-and-half split.
            assert!(panel[2] < w * 0.40, "{w}x{h} rail stays a minority");
            assert!(
                doll[2] > panel[2],
                "{w}x{h} the viewer, not the rail, owns the composition"
            );
            assert!(doll[0] + doll[2] < panel[0], "{w}x{h} viewer clears panel");
            assert!(doll[0] > 0.0 && doll[1] > 0.0);
            assert!(panel[1] + panel[3] < nav[1], "{w}x{h} panel clears nav");

            let r_panel = CharacterLayout::roster_panel_rect(w, h);
            let last = CharacterLayout::roster_rows_visible(w, h) - 1;
            for r in [
                CharacterLayout::roster_row_rect(w, h, last),
                CharacterLayout::new_character_rect(w, h),
                CharacterLayout::delete_character_rect(w, h),
            ] {
                assert!(r[0] >= r_panel[0], "{w}x{h} control left edge");
                assert!(
                    r[0] + r[2] <= r_panel[0] + r_panel[2] + 0.01,
                    "{w}x{h} right"
                );
                assert!(
                    r[1] + r[3] <= r_panel[1] + r_panel[3] + 0.01,
                    "{w}x{h} bottom"
                );
            }
            // Creation controls stay inside too.
            for i in 0..LINEAGES.len() {
                let r = CharacterLayout::lineage_row_rect(w, h, i);
                assert!(r[1] + r[3] <= panel[1] + panel[3] + 0.01, "{w}x{h} lineage");
            }
            for i in 0..VOCATIONS.len() {
                let r = CharacterLayout::vocation_rect(w, h, i);
                assert!(
                    r[1] + r[3] <= panel[1] + panel[3] + 0.01,
                    "{w}x{h} vocation"
                );
            }

            // Entry panel is centred and clear of the navigation row.
            let entry = EntryLayout::panel_rect(w, h);
            assert!((entry[0] + entry[2] * 0.5 - w * 0.5).abs() < 0.01);
            assert!(entry[1] + entry[3] < nav[1], "{w}x{h} login clears nav");
            for i in 0..2 {
                let f = EntryLayout::field_rect(w, h, i);
                assert!(f[0] > entry[0] && f[0] + f[2] < entry[0] + entry[2]);
                assert!(f[1] > entry[1] && f[1] + f[3] < entry[1] + entry[3]);
            }
        }
    }

    #[test]
    fn hit_targets_track_the_viewport() {
        // Same logical control, two framebuffer sizes ⇒ different pixel rects.
        let a = CharacterLayout::roster_row_rect(1280.0, 720.0, 0);
        let b = CharacterLayout::roster_row_rect(1600.0, 900.0, 0);
        assert!(b[0] > a[0] && b[3] > a[3]);
        assert!(
            !UiBuilder::hit(b[0], b[1], b[2], b[3], a[0] + 4.0, a[1] + 4.0),
            "a 720p hit point must not land on the 900p rect"
        );
    }

    #[test]
    fn hosted_paperdoll_suppresses_the_silhouette_not_the_frame() {
        let mut screen = CharacterScreen::with_entries(sample_roster(1));
        let mut ui = builder();
        idle(&mut ui, |ui| screen.draw(ui, W, H));
        let with_figure = ui.quads;

        screen.set_paperdoll_hosted(true);
        assert!(screen.paperdoll_hosted());
        idle(&mut ui, |ui| screen.draw(ui, W, H));
        let hosted = ui.quads;

        assert!(hosted < with_figure, "figure geometry is dropped");
        assert!(hosted > 0, "pad, frame and caption still draw");
    }

    #[test]
    fn loading_screen_renders_progress() {
        let mut screen = LoadingScreen::default();
        screen.set_progress(0.75);
        assert_eq!(screen.progress, 0.75);
        screen.tick(0.016);
        let mut ui = builder();
        ui.begin(W as u32, H as u32);
        assert!(screen.draw(&mut ui, W, H).is_none());
        assert!(ui.quads > 0);
    }

    #[test]
    fn host_status_is_visible_on_every_character_stage() {
        // A hosted create that is waiting or rejected must surface on the stage
        // that produced it, not only on the roster.
        for stage in [
            CharacterStage::Roster,
            CharacterStage::CreateProfile,
            CharacterStage::CreateIdentity,
        ] {
            let mut screen = CharacterScreen::with_entries(sample_roster(1));
            screen.set_stage(stage);
            let mut ui = builder();
            idle(&mut ui, |ui| screen.draw(ui, W, H));
            // Quad count is not a valid proxy here: on the roster the status
            // takes the place of a longer static line, so the frame can shrink.
            // Compare the emitted geometry instead.
            let quiet: Vec<f32> = ui.buf.clone();

            screen.set_status_error("NAME ALREADY TAKEN");
            assert_eq!(screen.status(), Some("NAME ALREADY TAKEN"));
            assert!(screen.status_is_error());
            idle(&mut ui, |ui| screen.draw(ui, W, H));
            assert!(ui.buf != quiet, "{stage:?} must draw the host status line");
            assert!(ui.quads > 0);

            screen.clear_status();
            assert!(screen.status().is_none());
            assert!(!screen.status_is_error());
        }
    }

    #[test]
    fn status_tone_distinguishes_pending_from_rejection() {
        let mut screen = CharacterScreen::new(vec![]);
        screen.set_status("AWAITING AUTHORITY");
        assert_eq!(screen.status(), Some("AWAITING AUTHORITY"));
        assert!(!screen.status_is_error(), "a pending note is not an error");

        screen.set_status_error("CREATE REJECTED");
        assert!(screen.status_is_error());

        // A later neutral status clears the danger tone.
        screen.set_status("AWAITING AUTHORITY");
        assert!(!screen.status_is_error());
    }

    #[test]
    fn every_stage_renders_without_panicking_at_odd_sizes() {
        for (w, h) in [(1280.0f32, 720.0f32), (800.0, 600.0), (1920.0, 1080.0)] {
            let mut entry = EntryScreen::new();
            let mut ui = builder();
            ui.set_input(-1.0, -1.0, false);
            ui.begin(w as u32, h as u32);
            entry.draw(&mut ui, w, h);
            entry.begin_connecting();
            ui.begin(w as u32, h as u32);
            entry.draw(&mut ui, w, h);
            assert!(ui.quads > 0);

            for stage in [
                CharacterStage::Roster,
                CharacterStage::CreateProfile,
                CharacterStage::CreateIdentity,
            ] {
                // Empty roster is the hardest case: no subject, no detail.
                let mut screen = CharacterScreen::new(vec![]);
                screen.set_stage(stage);
                screen.tick(0.016);
                ui.begin(w as u32, h as u32);
                screen.draw(&mut ui, w, h);
                assert!(ui.quads > 0, "{stage:?} at {w}x{h} drew nothing");
            }
        }
    }
}
