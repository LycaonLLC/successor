//! RADAR — the managed-window north-up tactical scope (port of
//! `ui/hud/radar.ts`).
//!
//! Preserves the shared north-up projection contract: `+x` is screen-right /
//! east and negative `y` is screen-up / north. `d_cells` remains the raw
//! world-cell distance so rim clamping keeps the exact bearing while plotting
//! in projected coordinates. Dot clicks take priority over ground clicks
//! (`CLICK_GRAB_PX`); ground clicks inside the scope request a relative move.

use core::fmt::{self, Write};

struct TextBuffer {
    bytes: [u8; 48],
    len: usize,
}

impl TextBuffer {
    fn new() -> Self {
        Self {
            bytes: [0; 48],
            len: 0,
        }
    }

    fn as_str(&self) -> &str {
        core::str::from_utf8(&self.bytes[..self.len]).expect("formatted radar text is UTF-8")
    }
}

impl Write for TextBuffer {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        let available = self.bytes.len().saturating_sub(self.len);
        if value.len() > available {
            return Err(fmt::Error);
        }
        self.bytes[self.len..self.len + value.len()].copy_from_slice(value.as_bytes());
        self.len += value.len();
        Ok(())
    }
}

use successor_engine_render::ui::UiBuilder;

use super::{HudAction, HudState, Palette, RadarClass};

/// World radius the scope covers (cells).
pub const RADIUS_CELLS: f32 = 96.0;
/// The fixed managed-window content square. Window chrome supplies the title
/// and perimeter, so this renderer must not add another card around it.
pub const CONTENT_SIZE_PX: f32 = super::layout::RADAR_SIZE;
pub const PANEL_W: f32 = CONTENT_SIZE_PX;
pub const PANEL_H: f32 = CONTENT_SIZE_PX;
/// Square occupied by the circular scope, leaving a compact coordinate rail.
pub const SIZE_PX: f32 = 128.0;
const SCOPE_Y: f32 = 2.0;
/// Click grab radius around a dot — dot priority over ground clicks.
pub const CLICK_GRAB_PX: f32 = 11.0;
/// Visible instrument circle radius (px).
pub const SCOPE_RIM_PX: f32 = SIZE_PX / 2.0 - 1.5;
/// Plot scale: px per cell (rim padding matches the reference).
pub const SCALE: f32 = (SIZE_PX / 2.0 - 7.0) / RADIUS_CELLS;
/// Coordinate readout glyph scale.
const COORD_PX: f32 = 1.15;
/// Air between the scope rim and the coordinate readout.
const COORD_GAP: f32 = 5.0;
/// Coordinate rail kept under the scope: the readout's cap box plus its gap
/// above and a hairline of air below. Nothing else lives down here, so the rail
/// reserves what it draws instead of a rounded-up band.
pub const COORD_RAIL: f32 = COORD_GAP + COORD_PX * 7.0 + 3.0;
/// Cardinal glyph scale.
const CARDINAL_PX: f32 = 1.4;
/// Rim tick length behind each cardinal. `radar.ts` marks all four: at this
/// glyph size the tick, not the letter, is what makes a bearing readable.
const CARDINAL_TICK: f32 = 4.0;
/// Cardinal glyph centre, measured in from the rim.
const CARDINAL_INSET: f32 = 9.5;
/// Smallest legible scope.
pub const MIN_SCOPE_PX: f32 = 96.0;

/// Plot scale for a scope of `scope_px` across.
fn scale_for(scope_px: f32) -> f32 {
    (scope_px / 2.0 - 7.0).max(1.0) / RADIUS_CELLS
}

/// Scope square for a pane rect: the largest centred circle the pane can hold
/// above its coordinate rail.
fn scope_of(rect: [f32; 4]) -> (f32, f32, f32) {
    let [x, y, w, h] = rect;
    let size = w.min(h - COORD_RAIL).max(MIN_SCOPE_PX);
    (x + (w - size) * 0.5, y + SCOPE_Y, size)
}

/// True when a scope-local point lies inside the visible circle.
pub fn point_in_scope(x: f32, y: f32, center: f32, rim: f32) -> bool {
    let dx = x - center;
    let dy = y - center;
    dx * dx + dy * dy <= rim * rim
}

/// A classified, projected contact: scope-local plot offsets plus the raw
/// distance. Rim clamping preserves bearing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlottedContact {
    pub sx: f32,
    pub sy: f32,
    pub d_cells: f32,
    pub clamped: bool,
}

/// Project raw north-up world deltas into scope-local px offsets, clamping to
/// the rim while preserving the exact bearing.
pub fn plot_contact_at(dx_cells: f32, dy_cells: f32, scope_px: f32) -> PlottedContact {
    let d_cells = (dx_cells * dx_cells + dy_cells * dy_cells).sqrt();
    let scale = scale_for(scope_px);
    let mut sx = dx_cells * scale;
    let mut sy = dy_cells * scale;
    let r = (sx * sx + sy * sy).sqrt();
    let max_r = scope_px / 2.0 - 9.0;
    let clamped = r > max_r;
    if clamped && r > 0.0 {
        sx = sx / r * max_r;
        sy = sy / r * max_r;
    }
    PlottedContact {
        sx,
        sy,
        d_cells,
        clamped,
    }
}

/// Plot against the default scope size.
pub fn plot_contact(dx_cells: f32, dy_cells: f32) -> PlottedContact {
    plot_contact_at(dx_cells, dy_cells, SIZE_PX)
}

/// Resolve a scope click (scope-local px). Dot hit takes priority; ground
/// clicks inside the rim become relative move requests.
pub fn click_action_at(
    st: &HudState,
    click_x: f32,
    click_y: f32,
    scope_px: f32,
) -> Option<HudAction> {
    let center = scope_px / 2.0;
    if !point_in_scope(click_x, click_y, center, center - 1.5) {
        return None;
    }
    // Nearest dot within the grab radius wins.
    let mut best: Option<(f32, &str)> = None;
    for contact in &st.radar_contacts {
        let plotted = plot_contact_at(contact.dx_cells, contact.dy_cells, scope_px);
        let dx = center + plotted.sx - click_x;
        let dy = center + plotted.sy - click_y;
        let d2 = dx * dx + dy * dy;
        if d2 <= CLICK_GRAB_PX * CLICK_GRAB_PX && best.map(|(bd, _)| d2 < bd).unwrap_or(true) {
            best = Some((d2, contact.actor_id.as_str()));
        }
    }
    if let Some((_, id)) = best {
        return Some(HudAction::RadarSelect(id.to_string()));
    }
    let scale = scale_for(scope_px);
    Some(HudAction::RadarMove {
        dx_cells: (click_x - center) / scale,
        dy_cells: (click_y - center) / scale,
    })
}

/// Resolve a click against the default scope size.
pub fn click_action(st: &HudState, click_x: f32, click_y: f32) -> Option<HudAction> {
    click_action_at(st, click_x, click_y, SIZE_PX)
}

fn class_tint(class: RadarClass, pal: &Palette) -> [u8; 4] {
    match class {
        RadarClass::Hostile => pal.danger,
        RadarClass::Passive => [232, 168, 74, 255], // amber
        RadarClass::Civilian => pal.ink_dim,
    }
}

/// Draw the scope face, contacts, waypoint chevrons and cardinals inside the
/// managed window content; route clicks unless the pointer is captured
/// elsewhere.
///
/// `rect` is the pane's live content bounds — the scope grows and shrinks with
/// the frame instead of clipping at a fixed square.
pub fn draw_radar(
    ui: &mut UiBuilder,
    pal: &Palette,
    st: &HudState,
    rect: [f32; 4],
    captured: bool,
    out: &mut Vec<HudAction>,
) {
    let [x, y, pane_w, pane_h] = rect;
    let (scope_x, scope_y, scope) = scope_of(rect);
    let c = scope * 0.5;
    let cx = scope_x + c;
    let cy = scope_y + c;
    let rim = c - 1.5;
    let grid = [pal.hairline[0], pal.hairline[1], pal.hairline[2], 100];
    ui.line(cx - rim, cy, cx + rim, cy, 0.8, grid);
    ui.line(cx, cy - rim, cx, cy + rim, 0.8, grid);
    ui.ring(cx, cy, rim, 72, 1.2, pal.hairline);
    ui.ring(cx, cy, rim - 3.0, 72, 0.6, grid);
    ui.ring(cx, cy, rim * 0.66, 56, 0.7, grid);
    ui.ring(cx, cy, rim * 0.33, 40, 0.7, grid);

    // Cardinals: `radar.ts` marks every direction with a rim tick plus a glyph,
    // north accented and the rest in plain instrument ink. Tick and glyph share
    // one radius, so the compass stays symmetric at any scope size instead of
    // relying on offsets tuned for a single one.
    const CARDINALS: [(&str, f32, f32, bool); 4] = [
        ("N", 0.0, -1.0, true),
        ("E", 1.0, 0.0, false),
        ("S", 0.0, 1.0, false),
        ("W", -1.0, 0.0, false),
    ];
    for (glyph, ux, uy, primary) in CARDINALS {
        let (ink, tick, weight) = if primary {
            (pal.accent, pal.accent, 1.4)
        } else {
            (pal.ink, pal.ink_dim, 1.0)
        };
        ui.line(
            cx + ux * (rim - CARDINAL_TICK),
            cy + uy * (rim - CARDINAL_TICK),
            cx + ux * (rim - 0.5),
            cy + uy * (rim - 0.5),
            weight,
            tick,
        );
        let label_r = rim - CARDINAL_INSET;
        let glyph_w = ui.measure_text(glyph, CARDINAL_PX);
        ui.text(
            glyph,
            cx + ux * label_r - glyph_w * 0.5,
            cy + uy * label_r - CARDINAL_PX * 3.5,
            CARDINAL_PX,
            ink,
        );
    }

    for wp in &st.radar_waypoints {
        let plotted = plot_contact_at(wp.dx_cells, wp.dy_cells, scope);
        let px = cx + plotted.sx;
        let py = cy + plotted.sy;
        ui.line(px - 3.0, py + 2.0, px, py - 2.0, 1.4, [232, 168, 74, 255]);
        ui.line(px, py - 2.0, px + 3.0, py + 2.0, 1.4, [232, 168, 74, 255]);
    }

    for contact in &st.radar_contacts {
        let plotted = plot_contact_at(contact.dx_cells, contact.dy_cells, scope);
        let tint = class_tint(contact.class, pal);
        let px = cx + plotted.sx;
        let py = cy + plotted.sy;
        if plotted.clamped {
            ui.ring(px, py, 2.0, 12, 1.0, tint);
        } else {
            let mut glow = tint;
            glow[3] = 90;
            ui.ring(px, py, 4.0, 16, 2.0, glow);
            ui.rect(px - 2.0, py - 2.0, 4.0, 4.0, tint);
        }
    }

    ui.ring(cx, cy, 5.0, 20, 2.0, [42, 225, 231, 80]);
    ui.rect(cx - 2.0, cy - 2.0, 4.0, 4.0, pal.accent);
    let mut coords = TextBuffer::new();
    if let Some((east, north)) = st.position {
        let _ = write!(&mut coords, "E {:.0} / N {:.0}", east, north);
    } else {
        let _ = coords.write_str("E -- / N --");
    }
    let coord_w = ui.measure_text(coords.as_str(), COORD_PX);
    // The readout hugs the instrument it describes rather than the pane floor,
    // so a pane taller than its scope carries no dead band between the two. The
    // clamp keeps it inside the rail when the pane is exactly scope-sized, and
    // above the floor when the scope has bottomed out at MIN_SCOPE_PX.
    let coord_y = (scope_y + scope + COORD_GAP).min(y + pane_h - COORD_RAIL + COORD_GAP);
    ui.text(
        coords.as_str(),
        x + (pane_w - coord_w) * 0.5,
        coord_y,
        COORD_PX,
        pal.ink_dim,
    );

    if !captured {
        let resp = ui.interact(scope_x, scope_y, scope, scope);
        if resp.clicked {
            let (mx, my) = ui.mouse();
            if let Some(action) = click_action_at(st, mx - scope_x, my - scope_y, scope) {
                out.push(action);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hud::{RadarContactHud, RadarWaypointHud};

    #[test]
    fn plot_preserves_bearing_when_clamped() {
        // A contact far east: clamps to the rim, still due east.
        let p = plot_contact(500.0, 0.0);
        assert!(p.clamped);
        assert!(p.sx > 0.0);
        assert!(p.sy.abs() < 1e-4);
        assert!((p.sx - (SIZE_PX / 2.0 - 9.0)).abs() < 1e-3);
        assert!((p.d_cells - 500.0).abs() < 1e-3);
        // Bearing preserved on a diagonal clamp.
        let q = plot_contact(300.0, 300.0);
        assert!(q.clamped);
        assert!((q.sx - q.sy).abs() < 1e-3);
    }

    #[test]
    fn plot_inside_radius_is_linear() {
        let p = plot_contact(48.0, -24.0);
        assert!(!p.clamped);
        assert!((p.sx - 48.0 * SCALE).abs() < 1e-4);
        assert!((p.sy + 24.0 * SCALE).abs() < 1e-4);
    }

    #[test]
    fn click_prefers_dot_over_ground() {
        let mut st = HudState::default();
        st.radar_contacts.push(RadarContactHud {
            actor_id: "bandit".into(),
            dx_cells: 10.0,
            dy_cells: 0.0,
            class: RadarClass::Hostile,
        });
        let c = SIZE_PX / 2.0;
        let dot_x = c + 10.0 * SCALE;
        // Click within the grab radius of the dot → select.
        match click_action(&st, dot_x + 4.0, c + 2.0) {
            Some(HudAction::RadarSelect(id)) => assert_eq!(id, "bandit"),
            other => panic!("expected select, got {other:?}"),
        }
        // Ground click away from any dot → relative move with correct cells.
        match click_action(&st, c + 40.0, c) {
            Some(HudAction::RadarMove { dx_cells, dy_cells }) => {
                assert!((dx_cells - 40.0 / SCALE).abs() < 1e-3);
                assert!(dy_cells.abs() < 1e-3);
            }
            other => panic!("expected move, got {other:?}"),
        }
        // Outside the scope circle → the world owns the click.
        assert_eq!(click_action(&st, 1.0, 1.0), None);
    }

    #[test]
    fn scope_fits_every_pane_size_it_is_given() {
        assert_eq!(PANEL_W, crate::hud::layout::RADAR_SIZE);
        assert_eq!(PANEL_H, PANEL_W);
        for pane in [
            [0.0, 0.0, PANEL_W, PANEL_H],
            [10.0, 20.0, 96.0, 116.0],
            [0.0, 0.0, 320.0, 240.0],
        ] {
            let (scope_x, scope_y, scope) = scope_of(pane);
            assert!(scope >= MIN_SCOPE_PX, "scope {scope} under the floor");
            assert!(scope_x >= pane[0] - 1e-3, "scope left of its pane");
            assert!(
                scope_x + scope <= pane[0] + pane[2].max(scope) + 1e-3,
                "scope wider than its pane"
            );
            assert!((scope_y - (pane[1] + SCOPE_Y)).abs() < 1e-3);
            // The coordinate rail always has room under the scope.
            assert!(scope + COORD_RAIL >= pane[3].min(scope + COORD_RAIL));
        }
    }

    #[test]
    fn draw_radar_renders_waypoints_and_contacts() {
        let icons = crate::hud::Icons::load();
        let mut ui = successor_engine_render::ui::UiBuilder::new(icons.meta);
        ui.begin(1280, 720);
        let mut st = HudState::default();
        let mut out = Vec::new();
        draw_radar(
            &mut ui,
            &crate::hud::palette(0),
            &st,
            [1100.0, 16.0, PANEL_W, PANEL_H],
            false,
            &mut out,
        );
        let base = ui.quads;
        st.radar_contacts.push(RadarContactHud {
            actor_id: "a".into(),
            dx_cells: 5.0,
            dy_cells: 5.0,
            class: RadarClass::Passive,
        });
        st.radar_waypoints.push(RadarWaypointHud {
            id: 1,
            dx_cells: -30.0,
            dy_cells: 12.0,
        });
        ui.begin(1280, 720);
        draw_radar(
            &mut ui,
            &crate::hud::palette(0),
            &st,
            [1100.0, 16.0, PANEL_W, PANEL_H],
            false,
            &mut out,
        );
        assert!(ui.quads > base);
        assert!(out.is_empty());
    }
}
