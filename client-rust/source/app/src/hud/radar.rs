//! RADAR — the top-right north-up tactical scope (port of `ui/hud/radar.ts`).
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
/// Instrument card width and total height.
pub const PANEL_W: f32 = 156.0;
pub const PANEL_H: f32 = 184.0;
/// Square occupied by the circular scope inside the card.
pub const SIZE_PX: f32 = 142.0;
const SCOPE_X: f32 = (PANEL_W - SIZE_PX) * 0.5;
const SCOPE_Y: f32 = 24.0;
/// Click grab radius around a dot — dot priority over ground clicks.
pub const CLICK_GRAB_PX: f32 = 11.0;
/// Visible instrument circle radius (px).
pub const SCOPE_RIM_PX: f32 = SIZE_PX / 2.0 - 1.5;
/// Plot scale: px per cell (rim padding matches the reference).
pub const SCALE: f32 = (SIZE_PX / 2.0 - 7.0) / RADIUS_CELLS;

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
pub fn plot_contact(dx_cells: f32, dy_cells: f32) -> PlottedContact {
    let d_cells = (dx_cells * dx_cells + dy_cells * dy_cells).sqrt();
    let mut sx = dx_cells * SCALE;
    let mut sy = dy_cells * SCALE;
    let r = (sx * sx + sy * sy).sqrt();
    let max_r = SIZE_PX / 2.0 - 9.0;
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

/// Resolve a scope click (scope-local px). Dot hit takes priority; ground
/// clicks inside the rim become relative move requests.
pub fn click_action(st: &HudState, click_x: f32, click_y: f32) -> Option<HudAction> {
    let center = SIZE_PX / 2.0;
    if !point_in_scope(click_x, click_y, center, SCOPE_RIM_PX) {
        return None;
    }
    // Nearest dot within the grab radius wins.
    let mut best: Option<(f32, &str)> = None;
    for contact in &st.radar_contacts {
        let plotted = plot_contact(contact.dx_cells, contact.dy_cells);
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
    Some(HudAction::RadarMove {
        dx_cells: (click_x - center) / SCALE,
        dy_cells: (click_y - center) / SCALE,
    })
}

fn class_tint(class: RadarClass, pal: &Palette) -> [u8; 4] {
    match class {
        RadarClass::Hostile => pal.danger,
        RadarClass::Passive => [232, 168, 74, 255], // amber
        RadarClass::Civilian => pal.ink_dim,
    }
}

/// Draw the scope face, contacts, waypoint chevrons and cardinals; route
/// clicks unless the pointer is captured elsewhere.
#[allow(clippy::too_many_arguments)]
pub fn draw_radar(
    ui: &mut UiBuilder,
    pal: &Palette,
    st: &HudState,
    x: f32,
    y: f32,
    captured: bool,
    out: &mut Vec<HudAction>,
) {
    let c = SIZE_PX * 0.5;
    ui.panel(x, y, PANEL_W, PANEL_H, pal.bg_panel, pal.hairline);
    ui.text("RADAR", x + 8.0, y + 6.0, 1.55, pal.ink_dim);
    let range = "96c";
    ui.text(
        range,
        x + PANEL_W - UiBuilder::text_width(range, 1.45) - 8.0,
        y + 7.0,
        1.45,
        pal.ink_dim,
    );

    let scope_x = x + SCOPE_X;
    let scope_y = y + SCOPE_Y;
    let cx = scope_x + c;
    let cy = scope_y + c;
    let rim = SCOPE_RIM_PX;
    let grid = [pal.hairline[0], pal.hairline[1], pal.hairline[2], 100];
    ui.line(cx - rim, cy, cx + rim, cy, 0.8, grid);
    ui.line(cx, cy - rim, cx, cy + rim, 0.8, grid);
    ui.ring(cx, cy, rim, 72, 1.2, pal.hairline);
    ui.ring(cx, cy, rim - 3.0, 72, 0.6, grid);
    ui.ring(cx, cy, rim * 0.66, 56, 0.7, grid);
    ui.ring(cx, cy, rim * 0.33, 40, 0.7, grid);

    ui.text("N", cx - 3.0, scope_y + 5.0, 1.4, pal.accent);
    ui.text("S", cx - 3.0, scope_y + SIZE_PX - 16.0, 1.4, pal.ink_dim);
    ui.text("W", scope_x + 5.0, cy - 5.0, 1.4, pal.ink_dim);
    ui.text("E", scope_x + SIZE_PX - 12.0, cy - 5.0, 1.4, pal.ink_dim);

    for wp in &st.radar_waypoints {
        let plotted = plot_contact(wp.dx_cells, wp.dy_cells);
        let px = cx + plotted.sx;
        let py = cy + plotted.sy;
        ui.line(px - 3.0, py + 2.0, px, py - 2.0, 1.4, [232, 168, 74, 255]);
        ui.line(px, py - 2.0, px + 3.0, py + 2.0, 1.4, [232, 168, 74, 255]);
    }

    for contact in &st.radar_contacts {
        let plotted = plot_contact(contact.dx_cells, contact.dy_cells);
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
        let _ = write!(&mut coords, "E {:.0}  ·  N {:.0}", east, north);
    } else {
        let _ = coords.write_str("E —  ·  N —");
    }
    let coord_w = UiBuilder::text_width(coords.as_str(), 1.35);
    ui.text(
        coords.as_str(),
        x + (PANEL_W - coord_w) * 0.5,
        y + PANEL_H - 15.0,
        1.35,
        pal.ink_dim,
    );

    if !captured {
        let resp = ui.interact(scope_x, scope_y, SIZE_PX, SIZE_PX);
        if resp.clicked {
            let (mx, my) = ui.mouse();
            if let Some(action) = click_action(st, mx - scope_x, my - scope_y) {
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
            1100.0,
            16.0,
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
            1100.0,
            16.0,
            false,
            &mut out,
        );
        assert!(ui.quads > base);
        assert!(out.is_empty());
    }
}
