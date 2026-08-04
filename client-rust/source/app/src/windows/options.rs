//! OPTIONS — display + input reference (exact port of
//! `ui/windows/defs/optionsWindow.ts`).
//!
//! DISPLAY: the canonical theme picker (four swatches; the dock swatch stays a
//! cycle shortcut), the live session DUST dial, and the current camera zoom
//! (display-only — the wheel owns zoom and persists it).
//! TOOLBAR: the ACTIONS browser link plus one row per slot with its bind and
//! a REBIND pending-capture button (assignment lives in the Action Browser).
//! INVENTORY: the default stack-split snap step.
//! INPUT: read-only binding rows generated from the shared gameplay registry.

use super::{accent, dim, slot, slot_edge, text, WindowAction};
use crate::hud::{code_glyph, Icons, THEMES, THEME_COUNT, THEME_LABELS};
use successor_engine_render::ui::{ButtonStyle, UiBuilder};

/// Split-snap steps (`inventory/splitPrefs.ts` SPLIT_SNAP_STEPS).
pub const SPLIT_SNAP_STEPS: [u32; 6] = [1, 5, 10, 100, 1000, 10000];

/// Typed view of the options surface. The host projects this from
/// `RuntimeSettings` + the live toolbar doc and applies emitted actions back
/// at the same scope as the reference (theme/local, dust/session, snap/local,
/// binds/toolbar doc).
#[derive(Clone, Debug)]
pub struct OptionsModel {
    pub theme_index: usize,
    /// Session dust dial 0..1 (post-pass strength; resets on relaunch).
    pub dust_strength: f32,
    /// Window fill opacity scale (0.35..=1.0, default 0.92).
    pub window_opacity: f32,
    /// HUD fill opacity scale (0.35..=1.0, default 0.90).
    pub hud_opacity: f32,
    /// Display-only camera zoom percent (wheel-owned, 55..125).
    pub zoom_percent: u16,
    pub split_snap: u32,
    /// One bind code per toolbar slot (12).
    pub toolbar_binds: Vec<String>,
    /// Slot currently capturing a new key (`PRESS KEY…`).
    pub rebind_pending: Option<usize>,
    /// Read-only gameplay binding reference rows: (LABEL, KEYS).
    pub binding_reference: Vec<(String, String)>,
}
impl Default for OptionsModel {
    fn default() -> Self {
        Self::sample()
    }
}

impl OptionsModel {
    pub fn sample() -> Self {
        Self {
            theme_index: 0,
            dust_strength: 0.5,
            window_opacity: 0.92,
            hud_opacity: 0.90,
            zoom_percent: 100,
            split_snap: 100,
            toolbar_binds: crate::hud::toolbar::DEFAULT_BINDS
                .iter()
                .map(|s| s.to_string())
                .collect(),
            rebind_pending: None,
            binding_reference: vec![
                ("MOVE".into(), "W A S D".into()),
                ("SPRINT".into(), "SHIFT / X".into()),
                ("INTERACT".into(), "F".into()),
                ("TARGET CYCLE".into(), "TAB".into()),
                ("RELOAD".into(), "R".into()),
            ],
        }
    }
}

fn section_title(ui: &mut UiBuilder, x: f32, y: f32, title: &str) -> f32 {
    ui.text(title, x, y, 1.8, accent());
    y + 22.0
}

pub fn draw(
    ui: &mut UiBuilder,
    ctx: super::Ctx,
    model: &OptionsModel,
    _icons: &Icons,
    out: &mut Vec<WindowAction>,
) {
    let [x, y, w, h] = ctx.rect;
    let bottom = y + h - 6.0;
    let mut cy = y + 4.0;

    // ── DISPLAY ──────────────────────────────────────────────────────────
    cy = section_title(ui, x, cy, "DISPLAY");

    // THEME — four swatches, active ring, exact reference palettes.
    ui.text("THEME", x, cy + 4.0, 1.6, text());
    let sw_px = 26.0;
    for (i, theme) in THEMES.iter().enumerate().take(THEME_COUNT) {
        let bx = x + 130.0 + i as f32 * (sw_px + 8.0);
        let resp = ui.interact(bx, cy, sw_px, sw_px);
        ui.rect(bx, cy, sw_px, sw_px, theme.accent);
        if i == model.theme_index {
            ui.rect(bx, cy + sw_px + 2.0, sw_px, 2.0, accent());
        } else if resp.hovered {
            ui.rect(bx + 5.0, cy + sw_px + 2.0, sw_px - 10.0, 2.0, dim());
        }
        if resp.hovered {
            ui.text(THEME_LABELS[i], x + 130.0, cy + sw_px + 3.0, 1.3, dim());
        }
        if resp.clicked {
            out.push(WindowAction::SetTheme(i));
        }
    }
    cy += sw_px + 18.0;

    // DUST — live session dial (0..1, step 0.05 via slider granularity).
    ui.text("DUST", x, cy + 2.0, 1.6, text());
    let mut dust = model.dust_strength.clamp(0.0, 1.0);
    if ui.slider(x + 130.0, cy - 2.0, w - 200.0, 16.0, &mut dust, 0.0, 1.0) {
        // Reference input uses step=0.05 — quantize to the same grid.
        let quantized = (dust / 0.05).round() * 0.05;
        out.push(WindowAction::SetDust(quantized));
    }
    ui.text(
        &format!("{:.2}", model.dust_strength),
        x + w - 56.0,
        cy + 2.0,
        1.5,
        dim(),
    );
    cy += 22.0;

    // WINDOW OPACITY — 0.35..=1.0 slider
    ui.text("WINDOW OPACITY", x, cy + 2.0, 1.6, text());
    let mut window_op = model.window_opacity.clamp(0.35, 1.0);
    if ui.slider(x + 130.0, cy - 2.0, w - 200.0, 16.0, &mut window_op, 0.35, 1.0) {
        let quantized = (window_op / 0.01).round() * 0.01;
        out.push(WindowAction::SetWindowOpacity(quantized));
    }
    ui.text(
        &format!("{:.2}", model.window_opacity),
        x + w - 56.0,
        cy + 2.0,
        1.5,
        dim(),
    );
    cy += 22.0;

    // HUD OPACITY — 0.35..=1.0 slider
    ui.text("HUD OPACITY", x, cy + 2.0, 1.6, text());
    let mut hud_op = model.hud_opacity.clamp(0.35, 1.0);
    if ui.slider(x + 130.0, cy - 2.0, w - 200.0, 16.0, &mut hud_op, 0.35, 1.0) {
        let quantized = (hud_op / 0.01).round() * 0.01;
        out.push(WindowAction::SetHudOpacity(quantized));
    }
    ui.text(
        &format!("{:.2}", model.hud_opacity),
        x + w - 56.0,
        cy + 2.0,
        1.5,
        dim(),
    );
    cy += 22.0;
    // ZOOM — display-only; the wheel owns zoom and persists it.
    ui.text("ZOOM", x, cy + 2.0, 1.6, text());
    ui.text(
        &format!("{}%", model.zoom_percent),
        x + 130.0,
        cy + 2.0,
        1.6,
        dim(),
    );
    ui.text("WHEEL-OWNED", x + 190.0, cy + 3.0, 1.2, dim());
    cy += 24.0;

    // ── TOOLBAR ──────────────────────────────────────────────────────────
    cy = section_title(ui, x, cy, "TOOLBAR");
    ui.text("ACTIONS", x, cy + 4.0, 1.6, text());
    if ui.button(
        x + 130.0,
        cy,
        118.0,
        20.0,
        "OPEN BROWSER",
        ButtonStyle::default(),
    ) {
        out.push(WindowAction::OpenWindow("actions".into()));
    }
    cy += 26.0;

    let slot_count = model.toolbar_binds.len().min(12);
    for slot in 0..slot_count {
        if cy + 18.0 > bottom - 120.0 {
            // Keep the lower sections visible in shorter windows; remaining
            // slots list continues in the same rhythm on taller windows.
            ui.text("...RESIZE FOR ALL SLOTS", x, cy, 1.3, dim());
            cy += 16.0;
            break;
        }
        ui.text(&format!("SLOT {:02}", slot + 1), x, cy + 3.0, 1.5, text());
        // Dotted leader.
        let leader_x0 = x + 74.0;
        let leader_x1 = x + 150.0;
        let mut lx = leader_x0;
        while lx < leader_x1 {
            ui.rect(lx, cy + 9.0, 2.0, 1.0, slot_edge());
            lx += 6.0;
        }
        let key_label = code_glyph(&model.toolbar_binds[slot]);
        ui.rect(x + 158.0, cy, 44.0, 16.0, super::slot());

        let klw = ui.measure_text(key_label, 1.5);
        ui.text(
            key_label,
            x + 158.0 + (44.0 - klw) * 0.5,
            cy + 3.0,
            1.5,
            text(),
        );
        let pending = model.rebind_pending == Some(slot);
        let btn_label = if pending { "PRESS KEY..." } else { "REBIND" };
        let mut style = ButtonStyle::default();
        if pending {
            style.edge = accent();
            style.text = accent();
        }
        if ui.button(x + 210.0, cy, 86.0, 16.0, btn_label, style) && !pending {
            out.push(WindowAction::RebindToolbarSlot(slot));
        }
        cy += 19.0;
    }
    cy += 6.0;

    // ── INVENTORY ────────────────────────────────────────────────────────
    cy = section_title(ui, x, cy, "INVENTORY");
    ui.text("DEFAULT SNAP", x, cy + 4.0, 1.6, text());
    let mut bx = x + 130.0;
    for step in SPLIT_SNAP_STEPS {
        let label = if step >= 1000 {
            format!("{}K", step / 1000)
        } else {
            format!("{step}")
        };
        let bw = ui.measure_text(&label, 1.5) + 14.0;
        let active = model.split_snap == step;
        let resp = ui.interact(bx, cy, bw, 18.0);
        ui.rect(
            bx,
            cy,
            bw,
            18.0,
            if active { [70, 92, 120, 240] } else { slot() },
        );

        ui.text(&label, bx + 7.0, cy + 4.0, 1.5, text());
        if resp.clicked && !active {
            out.push(WindowAction::SetSplitSnap(step));
        }
        bx += bw + 6.0;
    }
    cy += 26.0;

    // ── INPUT (read-only reference) ──────────────────────────────────────
    cy = section_title(ui, x, cy, "INPUT");
    for (label, keys) in &model.binding_reference {
        if cy + 14.0 > bottom {
            break;
        }
        ui.text(label, x, cy, 1.5, text());
        let kw = ui.measure_text(keys, 1.5);
        ui.text(keys, x + w - kw - 8.0, cy, 1.5, dim());
        cy += 15.0;
    }
}

#[cfg(test)]
mod tests {
    fn test_ctx(rect: [f32; 4]) -> crate::windows::Ctx {
        crate::windows::Ctx {
            spec: crate::windows::spec::surface("options").expect("options surface"),
            rect,
            tab: 0,
        }
    }

    use super::*;

    fn setup() -> (UiBuilder, OptionsModel, Icons) {
        let icons = Icons::load();
        let ui = UiBuilder::new(icons.meta);
        (ui, OptionsModel::sample(), icons)
    }

    const RECT: [f32; 4] = [100.0, 60.0, 380.0, 640.0];

    fn click(
        ui: &mut UiBuilder,
        model: &OptionsModel,
        icons: &Icons,
        bx: f32,
        by: f32,
    ) -> Vec<WindowAction> {
        ui.set_input(bx, by, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(ui, test_ctx(RECT), model, icons, &mut out);
        ui.set_input(bx, by, false);
        ui.begin(1280, 720);
        out.clear();
        draw(ui, test_ctx(RECT), model, icons, &mut out);
        out
    }

    #[test]
    fn theme_swatch_click_sets_theme() {
        let (mut ui, model, icons) = setup();
        // Swatches start at x+130, y = 60+4 (title consumed 22 → cy=86)…
        // swatch row cy after section_title = 60+4+22 = 86; third swatch at
        // 130 + 2*(26+8) = x+198.
        let out = click(&mut ui, &model, &icons, 100.0 + 198.0 + 13.0, 86.0 + 13.0);
        assert_eq!(out, vec![WindowAction::SetTheme(2)]);
    }

    // Layout walk for RECT: DISPLAY title→86, swatches 86..112, DUST row 130,
    // ZOOM row 152, TOOLBAR title→198(=176+22), ACTIONS row 198..224, slot
    // rows from 224 step 19, INVENTORY title after 458→480, snap segs at 480.
    #[test]
    fn snap_segment_emits_step() {
        let (mut ui, model, icons) = setup();
        let mut button_x = 100.0 + 130.0;
        for label in ["1", "5", "10", "100"] {
            button_x += ui.measure_text(label, 1.5) + 14.0 + 6.0;
        }
        let button_w = ui.measure_text("1K", 1.5) + 14.0;
        let out = click(
            &mut ui,
            &model,
            &icons,
            button_x + button_w * 0.5,
            524.0 + 9.0,
        );
        assert_eq!(out, vec![WindowAction::SetSplitSnap(1000)]);
    }

    #[test]
    fn rebind_button_begins_capture_for_slot_one() {
        let (mut ui, model, icons) = setup();
        // Slot rows start at cy=224; REBIND button at x+210, 86 wide, 16 tall.
        let out = click(&mut ui, &model, &icons, 100.0 + 210.0 + 43.0, 268.0 + 8.0);
        assert_eq!(out, vec![WindowAction::RebindToolbarSlot(0)]);
    }

    #[test]
    fn dust_slider_press_emits_quantized_value() {
        let (mut ui, model, icons) = setup();
        // Slider track: x+130..x+130+(w-200) at y 128..144. Press at 75%.
        let track_x = 100.0 + 130.0;
        let track_w = 380.0 - 200.0;
        ui.set_input(track_x + track_w * 0.75, 136.0, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, test_ctx(RECT), &model, &icons, &mut out);
        let dust = out.iter().find_map(|a| match a {
            WindowAction::SetDust(v) => Some(*v),
            _ => None,
        });
        let v = dust.expect("slider press emits SetDust");
        assert!(
            (v - 0.75).abs() < 0.051,
            "quantized near press point, got {v}"
        );
        // Quantized to the reference 0.05 grid.
        assert!(((v / 0.05).round() * 0.05 - v).abs() < 1e-6);
    }
    #[test]
    fn window_opacity_slider_press_emits_action() {
        let (mut ui, model, icons) = setup();
        let track_x = 100.0 + 130.0;
        let track_w = 380.0 - 200.0;
        // WINDOW OPACITY slider is row at y=152..168. Press at 50% (0.35..1.0 => 0.675).
        ui.set_input(track_x + track_w * 0.5, 158.0, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, test_ctx(RECT), &model, &icons, &mut out);
        let opacity = out.iter().find_map(|a| match a {
            WindowAction::SetWindowOpacity(v) => Some(*v),
            _ => None,
        });
        let v = opacity.expect("slider press emits SetWindowOpacity");
        assert!((v - 0.675).abs() < 0.05, "got {v}");
    }

    #[test]
    fn hud_opacity_slider_press_emits_action() {
        let (mut ui, model, icons) = setup();
        let track_x = 100.0 + 130.0;
        let track_w = 380.0 - 200.0;
        // HUD OPACITY slider is row at y=174..190. Press at 50% (0.35..1.0 => 0.675).
        ui.set_input(track_x + track_w * 0.5, 180.0, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, test_ctx(RECT), &model, &icons, &mut out);
        let opacity = out.iter().find_map(|a| match a {
            WindowAction::SetHudOpacity(v) => Some(*v),
            _ => None,
        });
        let v = opacity.expect("slider press emits SetHudOpacity");
        assert!((v - 0.675).abs() < 0.05, "got {v}");
    }

    #[test]
    fn options_surface_quad_count() {
        let (mut ui, model, icons) = setup();
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, test_ctx(RECT), &model, &icons, &mut out);
        assert!(ui.quads > 0, "options surface draws quads, got {}", ui.quads);
    }
    fn zoom_is_display_only_no_action_path() {
        let (mut ui, model, icons) = setup();
        // Clicking the zoom readout (row at y≈152) emits nothing.
        let out = click(&mut ui, &model, &icons, 100.0 + 140.0, 156.0);
        assert!(out.is_empty(), "zoom row is inert, got {out:?}");
    }
}
