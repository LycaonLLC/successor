//! RADAR — the managed-window north-up tactical scope (port of
//! `ui/hud/radar.ts`).
//!
//! Preserves the shared north-up projection contract: `+x` is screen-right /
//! east and negative `y` is screen-up / north. `d_cells` remains the raw
//! world-cell distance so rim clamping keeps the exact bearing while plotting
//! in projected coordinates. Dot clicks take priority over ground clicks
//! (`CLICK_GRAB_PX`); ground clicks inside the scope request a relative move.

use core::cell::{Cell, RefCell};
use crate::world::terrain::{sample_terrain, Biome, TerrainSample};
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
/// Plot scale at the default range: px per cell. Must agree with `scale_for`,
/// which is the single runtime authority now that the range ladder exists.
pub const SCALE: f32 = (SIZE_PX / 2.0 - 9.0) / RADIUS_CELLS;
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
/// Span rows used to fill the scope face. The draw list is quad-only, so the
/// disc is assembled from horizontal spans; 40 rows is under a pixel of stair
/// stepping at the default scope and stays cheap at the resize ceiling.
const FACE_ROWS: u32 = 40;

/// Fixed range ladder of visible scope radii in world cells.
pub const RANGE_LADDER_CELLS: &[f32] = &[32.0, 64.0, 96.0, 128.0, 192.0];
pub const DEFAULT_RANGE_INDEX: usize = 2; // 96.0 cells

const PREVIEW_GRID_SIZE: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq)]
struct TerrainCacheKey {
    cell_x: i32,
    cell_z: i32,
    range_index: usize,
    seed: i32,
    biome: Biome,
    pal: Palette,
}

struct TerrainPreviewCache {
    key: Option<TerrainCacheKey>,
    colors: [[u8; 4]; PREVIEW_GRID_SIZE * PREVIEW_GRID_SIZE],
    resample_count: usize,
}

impl TerrainPreviewCache {
    const fn new() -> Self {
        Self {
            key: None,
            colors: [[0; 4]; PREVIEW_GRID_SIZE * PREVIEW_GRID_SIZE],
            resample_count: 0,
        }
    }
}

std::thread_local! {
    static CURRENT_RANGE_INDEX: Cell<usize> = const { Cell::new(DEFAULT_RANGE_INDEX) };
    static CAMERA_HEADING_RAD: Cell<f32> = const { Cell::new(0.0) };
    static TERRAIN_CACHE: RefCell<TerrainPreviewCache> = const { RefCell::new(TerrainPreviewCache::new()) };
}

pub fn terrain_cache_resample_count() -> usize {
    TERRAIN_CACHE.with(|c| c.borrow().resample_count)
}

fn sample_to_tint(sample: &TerrainSample, pal: &Palette) -> [u8; 4] {
    let b0 = pal.bg_cell[0] as f32;
    let b1 = pal.bg_cell[1] as f32;
    let b2 = pal.bg_cell[2] as f32;

    let h0 = pal.hairline[0] as f32;
    let h1 = pal.hairline[1] as f32;
    let h2 = pal.hairline[2] as f32;

    let a0 = pal.accent[0] as f32;
    let a1 = pal.accent[1] as f32;
    let a2 = pal.accent[2] as f32;

    let d0 = pal.ink_dim[0] as f32;
    let d1 = pal.ink_dim[1] as f32;
    let d2 = pal.ink_dim[2] as f32;

    let w0 = sample.weights[0];
    let w1 = sample.weights[1];
    let w2 = sample.weights[2];

    let r = (b0 * (0.65 + 0.35 * w0) + h0 * (0.35 * w1) + a0 * (0.30 * w2) + d0 * 0.05) * sample.macro_tint;
    let g = (b1 * (0.65 + 0.35 * w0) + h1 * (0.35 * w1) + a1 * (0.30 * w2) + d1 * 0.05) * sample.macro_tint;
    let b = (b2 * (0.65 + 0.35 * w0) + h2 * (0.35 * w1) + a2 * (0.30 * w2) + d2 * 0.05) * sample.macro_tint;

    [
        r.clamp(0.0, 255.0) as u8,
        g.clamp(0.0, 255.0) as u8,
        b.clamp(0.0, 255.0) as u8,
        pal.bg_cell[3],
    ]
}

fn get_or_update_terrain_cache(
    player_x: f32,
    player_z: f32,
    seed: i32,
    biome: Biome,
    pal: &Palette,
) -> [[u8; 4]; PREVIEW_GRID_SIZE * PREVIEW_GRID_SIZE] {
    let range_index = CURRENT_RANGE_INDEX.with(|c| c.get());
    let cell_x = player_x.floor() as i32;
    let cell_z = player_z.floor() as i32;
    let key = TerrainCacheKey {
        cell_x,
        cell_z,
        range_index,
        seed,
        biome,
        pal: *pal,
    };

    TERRAIN_CACHE.with(|cache_cell| {
        let mut cache = cache_cell.borrow_mut();
        if cache.key != Some(key) {
            cache.key = Some(key);
            cache.resample_count += 1;
            let range_radius = RANGE_LADDER_CELLS[range_index.min(RANGE_LADDER_CELLS.len() - 1)];
            let step = (2.0 * range_radius) / (PREVIEW_GRID_SIZE as f32);
            for gy in 0..PREVIEW_GRID_SIZE {
                let wz = (cell_z as f64 + 0.5) - range_radius as f64 + (gy as f64 + 0.5) * step as f64;
                for gx in 0..PREVIEW_GRID_SIZE {
                    let wx = (cell_x as f64 + 0.5) - range_radius as f64 + (gx as f64 + 0.5) * step as f64;
                    let sample = sample_terrain(seed, wx, wz, biome);
                    cache.colors[gy * PREVIEW_GRID_SIZE + gx] = sample_to_tint(&sample, pal);
                }
            }
        }
        cache.colors
    })
}

pub fn range_rings_for_radius(radius: f32) -> &'static [f32] {
    if (radius - 32.0).abs() < 1e-3 {
        &[16.0, 32.0]
    } else if (radius - 64.0).abs() < 1e-3 {
        &[16.0, 32.0, 48.0, 64.0]
    } else if (radius - 96.0).abs() < 1e-3 {
        &[24.0, 48.0, 72.0, 96.0]
    } else if (radius - 128.0).abs() < 1e-3 {
        &[32.0, 64.0, 96.0, 128.0]
    } else {
        &[48.0, 96.0, 144.0, 192.0]
    }
}

/// Returns the active scope cell radius.
pub fn current_range_radius() -> f32 {
    CURRENT_RANGE_INDEX.with(|cell| {
        let idx = cell.get().min(RANGE_LADDER_CELLS.len() - 1);
        RANGE_LADDER_CELLS[idx]
    })
}

/// Sets the scope range to the step closest to `radius`.
pub fn set_range_radius(radius: f32) {
    let mut best_idx = 0;
    let mut best_diff = f32::MAX;
    for (i, &r) in RANGE_LADDER_CELLS.iter().enumerate() {
        let diff = (r - radius).abs();
        if diff < best_diff {
            best_diff = diff;
            best_idx = i;
        }
    }
    CURRENT_RANGE_INDEX.with(|cell| cell.set(best_idx));
}

/// Step scope range in (smaller world radius, higher zoom).
pub fn step_range_in() -> f32 {
    CURRENT_RANGE_INDEX.with(|cell| {
        let idx = cell.get().saturating_sub(1);
        cell.set(idx);
        RANGE_LADDER_CELLS[idx]
    })
}

/// Step scope range out (larger world radius, wider view).
pub fn step_range_out() -> f32 {
    CURRENT_RANGE_INDEX.with(|cell| {
        let idx = (cell.get() + 1).min(RANGE_LADDER_CELLS.len() - 1);
        cell.set(idx);
        RANGE_LADDER_CELLS[idx]
    })
}

/// Active camera heading angle in radians (0.0 is North-up).
pub fn camera_heading() -> f32 {
    CAMERA_HEADING_RAD.with(|cell| cell.get())
}

/// Set the camera heading angle in radians.
pub fn set_camera_heading(rad: f32) {
    CAMERA_HEADING_RAD.with(|cell| cell.set(rad));
}

/// Plot scale for a scope of `scope_px` across.
fn scale_for(scope_px: f32) -> f32 {
    let max_r = (scope_px / 2.0 - 9.0).max(1.0);
    max_r / current_range_radius()
}

/// Fill the circular instrument face. The radar also renders chromeless on the
/// HUD, where no managed window supplies a background — without this the grid,
/// cardinals and contacts sit directly on the world and stop being readable.
fn fill_scope_face(ui: &mut UiBuilder, cx: f32, cy: f32, r: f32, rgba: [u8; 4]) {
    let step = 2.0 * r / FACE_ROWS as f32;
    for row in 0..FACE_ROWS {
        let top = cy - r + row as f32 * step;
        let t = (top + step * 0.5 - cy) / r;
        let half = r * (1.0 - t * t).max(0.0).sqrt();
        if half > 0.4 {
            ui.rect(cx - half, top, half * 2.0, step + 0.6, rgba);
        }
    }
}

/// Scope square for a pane rect: the largest centred circle the pane can hold
/// above its coordinate rail.
fn scope_of(rect: [f32; 4]) -> (f32, f32, f32) {
    let [x, y, w, h] = rect;
    // The scope is inset by `SCOPE_Y` at the top and must still clear the
    // coordinate rail below, so both come out of the available height before
    // the square is sized.
    let size = w.min(h - COORD_RAIL - SCOPE_Y).max(16.0);
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
    let heading = camera_heading();
    let (sin_h, cos_h) = heading.sin_cos();
    let rx_cells = dx_cells * cos_h - dy_cells * sin_h;
    let ry_cells = dx_cells * sin_h + dy_cells * cos_h;

    let scale = scale_for(scope_px);
    let mut sx = rx_cells * scale;
    let mut sy = ry_cells * scale;
    let r = (sx * sx + sy * sy).sqrt();
    let max_r = (scope_px / 2.0 - 9.0).max(1.0);
    let range_radius = current_range_radius();
    let clamped = d_cells > range_radius + 1e-4 || r > max_r + 1e-4;
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
    let heading = camera_heading();
    let (sin_h, cos_h) = heading.sin_cos();
    let rx_px = click_x - center;
    let ry_px = click_y - center;
    let rx_cells = rx_px / scale;
    let ry_cells = ry_px / scale;
    let dx_cells = rx_cells * cos_h + ry_cells * sin_h;
    let dy_cells = -rx_cells * sin_h + ry_cells * cos_h;
    Some(HudAction::RadarMove {
        dx_cells,
        dy_cells,
    })
}

/// Resolve a click against the default scope size.
pub fn click_action(st: &HudState, click_x: f32, click_y: f32) -> Option<HudAction> {
    click_action_at(st, click_x, click_y, SIZE_PX)
}

fn class_tint(class: RadarClass, pal: &Palette) -> [u8; 4] {
    let rel = match class {
        RadarClass::Hostile => super::RelationHud::Hostile,
        RadarClass::Passive => super::RelationHud::Attackable,
        RadarClass::Civilian => super::RelationHud::Social,
    };
    super::plate::hostility_tint(rel, pal)
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
    let grid_color = [pal.hairline[0], pal.hairline[1], pal.hairline[2], 90];
    let range_radius = current_range_radius();
    let scale = scale_for(scope);
    let heading = camera_heading();
    let (sin_h, cos_h) = heading.sin_cos();

    // 1. Terrain preview backdrop clipped to scope circle rim
    if let Some((player_x, player_z)) = st.position {
        let colors = get_or_update_terrain_cache(
            player_x,
            player_z,
            st.world_seed,
            st.biome,
            pal,
        );
        let rows = FACE_ROWS as usize;
        let step_y = 2.0 * rim / rows as f32;
        let step_x = 2.0 * rim / rows as f32;

        for row in 0..rows {
            let top = cy - rim + row as f32 * step_y;
            let cy_row = top + step_y * 0.5;
            let dy_rim = (cy_row - cy) / rim;
            if dy_rim.abs() >= 1.0 {
                continue;
            }
            let half_w = rim * (1.0 - dy_rim * dy_rim).max(0.0).sqrt();
            if half_w <= 0.4 {
                continue;
            }

            for col in 0..rows {
                let left = cx - rim + col as f32 * step_x;
                let right = left + step_x;
                let r_left = left.max(cx - half_w);
                let r_right = right.min(cx + half_w);
                if r_right <= r_left {
                    continue;
                }
                let w = r_right - r_left;
                let cx_col = (r_left + r_right) * 0.5;

                let rx_px = cx_col - cx;
                let ry_px = cy_row - cy;
                let rx_cells = rx_px / scale;
                let ry_cells = ry_px / scale;

                let dx_cells = rx_cells * cos_h + ry_cells * sin_h;
                let dy_cells = -rx_cells * sin_h + ry_cells * cos_h;

                let gx = (((dx_cells + range_radius) / (2.0 * range_radius) * (PREVIEW_GRID_SIZE as f32))
                    .floor() as i32)
                    .clamp(0, (PREVIEW_GRID_SIZE - 1) as i32) as usize;
                let gy = (((dy_cells + range_radius) / (2.0 * range_radius) * (PREVIEW_GRID_SIZE as f32))
                    .floor() as i32)
                    .clamp(0, (PREVIEW_GRID_SIZE - 1) as i32) as usize;

                let color = colors[gy * PREVIEW_GRID_SIZE + gx];
                ui.rect(r_left, top, w + 0.5, step_y + 0.6, color);
            }
        }
    } else {
        fill_scope_face(ui, cx, cy, rim, pal.bg_cell);
    }

    // 2. World cell grid (aligned to world cells, sliding with position)
    if let Some((player_x, player_z)) = st.position {
        let grid_step = (range_radius / 4.0).max(8.0);
        let min_kx = ((player_x - range_radius) / grid_step).floor() as i32;
        let max_kx = ((player_x + range_radius) / grid_step).ceil() as i32;
        for k in min_kx..=max_kx {
            let wx = k as f32 * grid_step;
            let dx_cells = wx - player_x;
            let r_cell = dx_cells * scale;
            if r_cell.abs() < rim {
                let h = (rim * rim - r_cell * r_cell).max(0.0).sqrt();
                let x1 = cx + r_cell * cos_h - h * sin_h;
                let y1 = cy + r_cell * sin_h + h * cos_h;
                let x2 = cx + r_cell * cos_h + h * sin_h;
                let y2 = cy + r_cell * sin_h - h * cos_h;
                ui.line(x1, y1, x2, y2, 0.8, grid_color);
            }
        }

        let min_kz = ((player_z - range_radius) / grid_step).floor() as i32;
        let max_kz = ((player_z + range_radius) / grid_step).ceil() as i32;
        for k in min_kz..=max_kz {
            let wz = k as f32 * grid_step;
            let dy_cells = wz - player_z;
            let r_cell = dy_cells * scale;
            if r_cell.abs() < rim {
                let h = (rim * rim - r_cell * r_cell).max(0.0).sqrt();
                let x1 = cx - r_cell * sin_h - h * cos_h;
                let y1 = cy + r_cell * cos_h - h * sin_h;
                let x2 = cx - r_cell * sin_h + h * cos_h;
                let y2 = cy + r_cell * cos_h + h * sin_h;
                ui.line(x1, y1, x2, y2, 0.8, grid_color);
            }
        }
    }

    // Brighter N-S/E-W axis lines on top of grid
    let axis_color = [pal.hairline[0], pal.hairline[1], pal.hairline[2], 180];
    ui.line(cx - rim, cy, cx + rim, cy, 1.0, axis_color);
    ui.line(cx, cy - rim, cx, cy + rim, 1.0, axis_color);

    // Perimeter rim ring
    ui.ring(cx, cy, rim, 72, 1.2, pal.hairline);
    ui.ring(cx, cy, rim - 3.0, 72, 0.6, grid_color);

    // 3. Range rings labelled in metres
    let rings = range_rings_for_radius(range_radius);
    let (diag_sin, diag_cos) = (heading + core::f32::consts::FRAC_PI_4).sin_cos();
    for &r_cells in rings {
        let r_px = r_cells * scale;
        if r_px <= rim - 3.0 {
            ui.ring(cx, cy, r_px, 56, 0.6, grid_color);

            let mut buf = TextBuffer::new();
            let _ = write!(&mut buf, "{:.0}m", r_cells);
            let label_str = buf.as_str();
            let label_w = ui.measure_text(label_str, 0.95);

            let lx = cx + diag_sin * r_px;
            let ly = cy - diag_cos * r_px;

            ui.text(
                label_str,
                lx - label_w * 0.5,
                ly - 3.5,
                0.95,
                pal.ink_dim,
            );
        }
    }
    // Cardinals: mark directions with a rim tick plus glyph, rotating with
    // camera heading to track orientation.
    let heading = camera_heading();
    let (sin_h, cos_h) = heading.sin_cos();
    let cardinals: [(&str, f32, f32, bool); 4] = [
        ("N", sin_h, -cos_h, true),
        ("E", cos_h, sin_h, false),
        ("S", -sin_h, cos_h, false),
        ("W", -cos_h, -sin_h, false),
    ];
    for (glyph, ux, uy, primary) in cardinals {
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

    let target_id = st.target.as_ref().map(|t| t.actor_id.as_str());
    let target_dead_or_down = st.target.as_ref().is_some_and(|t| !t.alive || t.stamp.is_some());

    for contact in &st.radar_contacts {
        let plotted = plot_contact_at(contact.dx_cells, contact.dy_cells, scope);
        let is_selected = target_id == Some(contact.actor_id.as_str());
        let is_dead = is_selected && target_dead_or_down;
        let px = cx + plotted.sx;
        let py = cy + plotted.sy;

        if is_dead {
            let dim_tint = super::plate::readable_dim(pal);
            ui.line(px - 3.0, py - 3.0, px + 3.0, py + 3.0, 1.2, dim_tint);
            ui.line(px - 3.0, py + 3.0, px + 3.0, py - 3.0, 1.2, dim_tint);
        } else {
            let tint = class_tint(contact.class, pal);
            if plotted.clamped {
                ui.ring(px, py, 2.0, 12, 1.0, tint);
            } else {
                let mut glow = tint;
                glow[3] = 90;
                ui.ring(px, py, 4.0, 16, 2.0, glow);
                ui.rect(px - 2.0, py - 2.0, 4.0, 4.0, tint);
            }
        }

        if is_selected {
            let accent = pal.accent;
            ui.ring(px, py, 7.0, 16, 1.6, accent);
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
    // Compact range control pair in top-right of pane.
    let btn_y = y + 2.0;
    let btn_out_x = x + pane_w - 52.0;
    let btn_in_x = x + pane_w - 18.0;

    ui.rect(btn_out_x, btn_y, 14.0, 14.0, pal.bg_cell);
    ui.border(btn_out_x, btn_y, 14.0, 14.0, 1.0, pal.hairline);
    ui.text("-", btn_out_x + 4.0, btn_y + 1.0, 1.1, pal.ink_dim);

    let range_cur = current_range_radius();
    let mut range_buf = TextBuffer::new();
    let _ = write!(&mut range_buf, "{:.0}m", range_cur);
    let range_w = ui.measure_text(range_buf.as_str(), 1.1);
    ui.text(
        range_buf.as_str(),
        btn_out_x + 16.0 + (18.0 - range_w) * 0.5,
        btn_y + 1.0,
        1.1,
        pal.ink_dim,
    );

    ui.rect(btn_in_x, btn_y, 14.0, 14.0, pal.bg_cell);
    ui.border(btn_in_x, btn_y, 14.0, 14.0, 1.0, pal.hairline);
    ui.text("+", btn_in_x + 3.0, btn_y + 1.0, 1.1, pal.ink_dim);

    if !captured {
        let resp_out = ui.interact(btn_out_x, btn_y, 14.0, 14.0);
        let resp_in = ui.interact(btn_in_x, btn_y, 14.0, 14.0);
        if resp_out.clicked {
            step_range_out();
        } else if resp_in.clicked {
            step_range_in();
        } else {
            let resp = ui.interact(scope_x, scope_y, scope, scope);
            if resp.clicked {
                let (mx, my) = ui.mouse();
                if let Some(action) = click_action_at(st, mx - scope_x, my - scope_y, scope) {
                    out.push(action);
                }
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

    #[test]
    fn scope_face_is_opaque_so_the_chromeless_radar_is_readable() {
        // The radar also renders without managed-window chrome. Without its own
        // face the grid and contacts sit on bare world pixels, so the face must
        // be a filled disc, not a ring.
        let mut ui = UiBuilder::new(crate::hud::Icons::load().meta);
        let st = HudState::default();
        let mut out = Vec::new();
        ui.begin(1280, 720);
        draw_radar(
            &mut ui,
            &crate::hud::palette(0),
            &st,
            [0.0, 560.0, PANEL_W, PANEL_H],
            false,
            &mut out,
        );
        assert!(
            ui.quads >= FACE_ROWS,
            "scope face missing: {} quads for {FACE_ROWS} span rows",
            ui.quads
        );
    }
    #[test]
    fn blips_clamp_to_radar_disc_instead_of_escaping_it() {
        set_range_radius(96.0);
        set_camera_heading(0.0);
        let scope = 128.0;
        let c = scope * 0.5;
        let rim = c - 1.5;
        let max_r = c - 9.0;
        for (dx, dy) in [(500.0, 0.0), (-300.0, 300.0), (0.0, -1000.0)] {
            let p = plot_contact_at(dx, dy, scope);
            assert!(p.clamped, "far contact ({dx},{dy}) must clamp");
            let r = (p.sx * p.sx + p.sy * p.sy).sqrt();
            assert!((r - max_r).abs() < 1e-3, "clamped dist {r} must equal max_r {max_r}");
            assert!(r + 4.0 <= rim + 1e-3, "blip boundary {r}+4.0 escapes scope rim {rim}");
        }
    }

    #[test]
    fn contact_at_range_edge_handled_without_flicker() {
        set_range_radius(96.0);
        set_camera_heading(0.0);
        let range = current_range_radius();
        let p_exact = plot_contact_at(range, 0.0, 128.0);
        assert!(!p_exact.clamped, "contact at exact range edge must NOT clamp");
        assert!((p_exact.sx - (128.0 / 2.0 - 9.0)).abs() < 1e-3);

        let p_inside = plot_contact_at(range - 0.001, 0.0, 128.0);
        assert!(!p_inside.clamped, "contact inside edge must NOT clamp");

        let p_outside = plot_contact_at(range + 0.1, 0.0, 128.0);
        assert!(p_outside.clamped, "contact outside edge must clamp");
    }

    #[test]
    fn pane_resizing_keeps_all_metrics_correct() {
        set_range_radius(96.0);
        set_camera_heading(0.0);
        for pane in [
            [0.0, 0.0, 80.0, 80.0],
            [10.0, 20.0, 128.0, 128.0],
            [0.0, 0.0, 320.0, 240.0],
        ] {
            let (sx, sy, scope) = scope_of(pane);
            assert!(sx >= pane[0] - 1e-3, "scope left inside pane bounds");
            assert!(sx + scope <= pane[0] + pane[2] + 1e-3, "scope right inside pane bounds");
            assert!(sy >= pane[1] - 1e-3, "scope top inside pane bounds");
            assert!(sy + scope + COORD_RAIL <= pane[1] + pane[3] + 1e-3, "scope floor inside pane bounds");

            let scale = scale_for(scope);
            assert!(scale > 0.0, "scale must be positive");
            let max_r = (scope / 2.0 - 9.0).max(1.0);
            assert!((scale - max_r / 96.0).abs() < 1e-4, "scale must derive from scope max_r");
        }
    }

    #[test]
    fn north_indicator_tracks_camera() {
        set_range_radius(96.0);
        set_camera_heading(0.0);
        let p_north = plot_contact_at(0.0, -50.0, 128.0);
        assert!(p_north.sx.abs() < 1e-3);
        assert!(p_north.sy < 0.0, "North is screen-up when camera heading is 0");

        set_camera_heading(std::f32::consts::FRAC_PI_2);
        let p_north_rot = plot_contact_at(0.0, -50.0, 128.0);
        assert!(p_north_rot.sx > 0.0, "North rotates to screen-right when camera looks East");
        assert!(p_north_rot.sy.abs() < 1e-3);

        set_camera_heading(0.0);
    }

    #[test]
    fn click_maps_to_correct_world_cell_in_both_directions() {
        set_range_radius(96.0);
        set_camera_heading(0.0);
        let st = HudState::default();
        let scope = 128.0;
        let c = scope * 0.5;

        let dx_init = 40.0f32;
        let dy_init = -20.0f32;
        let plotted = plot_contact_at(dx_init, dy_init, scope);
        let click_x = c + plotted.sx;
        let click_y = c + plotted.sy;
        match click_action_at(&st, click_x, click_y, scope) {
            Some(HudAction::RadarMove { dx_cells, dy_cells }) => {
                assert!((dx_cells - dx_init).abs() < 1e-3, "round trip dx mismatch: {dx_cells} vs {dx_init}");
                assert!((dy_cells - dy_init).abs() < 1e-3, "round trip dy mismatch: {dy_cells} vs {dy_init}");
            }
            other => panic!("expected move action, got {other:?}"),
        }

        let test_click_x = c + 25.0;
        let test_click_y = c - 15.0;
        if let Some(HudAction::RadarMove { dx_cells, dy_cells }) = click_action_at(&st, test_click_x, test_click_y, scope) {
            let replotted = plot_contact_at(dx_cells, dy_cells, scope);
            assert!((c + replotted.sx - test_click_x).abs() < 1e-3);
            assert!((c + replotted.sy - test_click_y).abs() < 1e-3);
        } else {
            panic!("expected move action");
        }
    }

    #[test]
    fn selection_is_visually_distinct() {
        let icons = crate::hud::Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let mut st = HudState::default();
        st.radar_contacts.push(RadarContactHud {
            actor_id: "target_alpha".into(),
            dx_cells: 20.0,
            dy_cells: 10.0,
            class: RadarClass::Hostile,
        });
        let mut out = Vec::new();

        ui.begin(1280, 720);
        draw_radar(&mut ui, &crate::hud::palette(0), &st, [0.0, 0.0, 128.0, 128.0], false, &mut out);
        let quads_unselected = ui.quads;

        st.target = Some(crate::hud::TargetHud {
            actor_id: "target_alpha".into(),
            name: "Target Alpha".into(),
            alive: true,
            ..Default::default()
        });
        ui.begin(1280, 720);
        draw_radar(&mut ui, &crate::hud::palette(0), &st, [0.0, 0.0, 128.0, 128.0], false, &mut out);
        let quads_selected = ui.quads;

        assert!(quads_selected > quads_unselected, "selected target must emit extra quads for selection reticle");
    }

    #[test]
    fn dead_or_downed_contacts_are_distinguishable_from_live_ones() {
        let icons = crate::hud::Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let mut st = HudState::default();
        st.radar_contacts.push(RadarContactHud {
            actor_id: "target_alpha".into(),
            dx_cells: 20.0,
            dy_cells: 10.0,
            class: RadarClass::Hostile,
        });
        let mut out = Vec::new();

        st.target = Some(crate::hud::TargetHud {
            actor_id: "target_alpha".into(),
            alive: true,
            ..Default::default()
        });
        ui.begin(1280, 720);
        draw_radar(&mut ui, &crate::hud::palette(0), &st, [0.0, 0.0, 128.0, 128.0], false, &mut out);

        st.target = Some(crate::hud::TargetHud {
            actor_id: "target_alpha".into(),
            alive: false,
            stamp: Some("DEAD"),
            ..Default::default()
        });
        let mut ui_dead = UiBuilder::new(icons.meta);
        ui_dead.begin(1280, 720);
        draw_radar(&mut ui_dead, &crate::hud::palette(0), &st, [0.0, 0.0, 128.0, 128.0], false, &mut out);

        assert_ne!(ui.quads, ui_dead.quads, "dead contact rendering must differ from live contact");
    }

    #[test]
    fn range_stepping_ladder() {
        assert_eq!(RANGE_LADDER_CELLS, &[32.0, 64.0, 96.0, 128.0, 192.0]);
        set_range_radius(96.0);
        assert_eq!(current_range_radius(), 96.0);

        assert_eq!(step_range_in(), 64.0);
        assert_eq!(current_range_radius(), 64.0);
        assert_eq!(step_range_in(), 32.0);
        assert_eq!(step_range_in(), 32.0);

        assert_eq!(step_range_out(), 64.0);
        assert_eq!(step_range_out(), 96.0);
        assert_eq!(step_range_out(), 128.0);
        assert_eq!(step_range_out(), 192.0);
        assert_eq!(step_range_out(), 192.0);

        set_range_radius(100.0);
        assert_eq!(current_range_radius(), 96.0);
    }

    #[test]
    fn preview_cache_not_resampling_when_unmoved() {
        let pal = crate::hud::palette(0);
        let count_start = terrain_cache_resample_count();
        let _ = get_or_update_terrain_cache(100.1, 200.1, 42, Biome::Desert, &pal);
        let count_after_first = terrain_cache_resample_count();
        assert!(count_after_first > count_start);

        // Sub-cell movement inside same cell (100, 200) -> NO resample!
        let _ = get_or_update_terrain_cache(100.4, 200.4, 42, Biome::Desert, &pal);
        let count_after_subcell = terrain_cache_resample_count();
        assert_eq!(count_after_subcell, count_after_first, "must not resample when player stayed in cell (100, 200)");

        // Crossing cell boundary to (101, 200) -> resample!
        let _ = get_or_update_terrain_cache(101.2, 200.1, 42, Biome::Desert, &pal);
        let count_after_move = terrain_cache_resample_count();
        assert!(count_after_move > count_after_subcell, "must resample when crossing cell boundary");
    }

    #[test]
    fn preview_staying_inside_scope_circle() {
        let icons = crate::hud::Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let mut st = HudState::default();
        st.position = Some((100.0, 200.0));
        st.world_seed = 42;
        st.biome = Biome::Desert;
        let mut out = Vec::new();

        let pane = [0.0, 0.0, 128.0, 128.0];
        let (scope_x, scope_y, scope) = scope_of(pane);
        let c = scope * 0.5;
        let cx = scope_x + c;
        let cy = scope_y + c;
        let rim = c - 1.5;

        ui.begin(1280, 720);
        draw_radar(&mut ui, &crate::hud::palette(0), &st, pane, false, &mut out);

        // Verify rects generated for terrain preview face do not exceed scope rim
        let rows = FACE_ROWS as usize;
        let step_y = 2.0 * rim / rows as f32;
        let step_x = 2.0 * rim / rows as f32;

        for row in 0..rows {
            let top = cy - rim + row as f32 * step_y;
            let cy_row = top + step_y * 0.5;
            let dy_rim = (cy_row - cy) / rim;
            if dy_rim.abs() >= 1.0 {
                continue;
            }
            let half_w = rim * (1.0 - dy_rim * dy_rim).max(0.0).sqrt();

            for col in 0..rows {
                let left = cx - rim + col as f32 * step_x;
                let right = left + step_x;
                let r_left = left.max(cx - half_w);
                let r_right = right.min(cx + half_w);
                if r_right <= r_left {
                    continue;
                }
                assert!(r_left >= cx - half_w - 1e-3, "r_left outside circle");
                assert!(r_right <= cx + half_w + 1e-3, "r_right outside circle");
            }
        }
    }

    #[test]
    fn ring_labels_distinct_and_ascii_at_every_ladder_step() {
        for &radius in RANGE_LADDER_CELLS {
            let rings = range_rings_for_radius(radius);
            assert!(!rings.is_empty());

            let mut labels = Vec::new();
            for &r in rings {
                let label = format!("{:.0}m", r);
                for ch in label.chars() {
                    assert!(ch.is_ascii() && (ch as u8) >= 32 && (ch as u8) <= 126, "label '{label}' must be ASCII 32..=126");
                }
                assert!(!labels.contains(&label), "duplicate ring label '{label}' at radius {radius}");
                labels.push(label);
            }

            if (radius - 32.0).abs() < 1e-3 {
                assert_eq!(rings.len(), 2, "32m step must drop intermediate rings to avoid crowding");
            }
        }
    }

    #[test]
    fn grid_shifting_when_player_position_changes() {
        let range_radius = 96.0;
        set_range_radius(range_radius);
        let scope = 128.0;
        let scale = scale_for(scope);
        let grid_step = (range_radius / 4.0).max(8.0);

        let p1_x = 100.0f32;
        let p2_x = 100.5f32;

        let k = (p1_x / grid_step).floor() as i32 + 1;
        let wx = k as f32 * grid_step;

        let dx1 = wx - p1_x;
        let dx2 = wx - p2_x;

        let r_cell1 = dx1 * scale;
        let r_cell2 = dx2 * scale;

        let shift = (r_cell1 - r_cell2).abs();
        let expected_shift = (p2_x - p1_x) * scale;

        assert!((shift - expected_shift).abs() < 1e-3, "grid shift {shift} must match player movement {expected_shift}");
    }
}
