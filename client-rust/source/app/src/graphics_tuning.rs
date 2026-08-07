//! Developer graphics mastering overlay, toggled by Backquote.

use crate::render_settings::{self, QualityPreset, RenderSettingsDocument};
use successor_engine_render::gpu::Gpu;
use successor_engine_render::renderer::Renderer;
use successor_engine_render::ui::{ButtonStyle, UiBuilder};

const PANEL_W: f32 = 574.0;
const PANEL_H: f32 = 688.0;
const ROW_H: f32 = 25.0;
const TEXT: [u8; 4] = [218, 228, 238, 255];
const MUTED: [u8; 4] = [145, 162, 180, 255];
const ACCENT: [u8; 4] = [240, 196, 96, 255];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Page {
    Lighting,
    Post,
    Color,
}

pub struct GraphicsTuner {
    open: bool,
    previous_toggle: bool,
    page: Page,
    document: RenderSettingsDocument,
    status: String,
}

impl GraphicsTuner {
    pub fn new() -> Self {
        Self {
            open: false,
            previous_toggle: false,
            page: Page::Lighting,
            document: render_settings::document(),
            status: "BACKQUOTE CLOSES THIS OVERLAY".to_string(),
        }
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    /// Dismiss the overlay without changing the backquote edge state.
    pub fn dismiss(&mut self) -> bool {
        if !self.open {
            return false;
        }
        self.open = false;
        self.status = "TUNING CLOSED".to_string();
        true
    }

    pub fn handle_toggle(&mut self, down: bool) -> bool {
        let changed = down && !self.previous_toggle;
        self.previous_toggle = down;
        if changed {
            self.open = !self.open;
            self.status = if self.open {
                "LIVE TUNING ACTIVE".to_string()
            } else {
                "TUNING CLOSED".to_string()
            };
        }
        changed
    }

    pub fn draw<G: Gpu>(
        &mut self,
        ui: &mut UiBuilder,
        renderer: &mut Renderer,
        gpu: &mut G,
        screen_w: u32,
        screen_h: u32,
    ) {
        if !self.open {
            return;
        }
        let x = (screen_w as f32 - PANEL_W - 14.0).max(8.0);
        let y = ((screen_h as f32 - PANEL_H) * 0.5).max(8.0);
        let h = PANEL_H.min(screen_h as f32 - y - 8.0);
        ui.panel(x, y, PANEL_W, h, [10, 15, 23, 248], [118, 142, 168, 255]);
        ui.rect(x + 1.0, y + 1.0, PANEL_W - 2.0, 38.0, [26, 36, 50, 255]);
        ui.text("GRAPHICS MASTERING", x + 16.0, y + 12.0, 2.0, ACCENT);
        ui.text("`", x + PANEL_W - 30.0, y + 12.0, 2.0, MUTED);

        let mut changed = self.draw_preset_row(ui, x, y + 48.0);
        self.draw_page_tabs(ui, x, y + 86.0);
        ui.rect(x + 12.0, y + 122.0, PANEL_W - 24.0, 1.0, [65, 82, 102, 255]);

        let content_y = y + 132.0;
        changed |= match self.page {
            Page::Lighting => self.draw_lighting(ui, x, content_y),
            Page::Post => self.draw_post(ui, x, content_y),
            Page::Color => self.draw_color(ui, x, content_y),
        };

        if changed {
            self.apply(renderer, gpu);
        }

        let actions_y = y + h - 42.0;
        let style = crate::hud::button_style();
        if ui.button(x + 14.0, actions_y, 104.0, 28.0, "SAVE", style) {
            match render_settings::save(&self.document) {
                Ok(()) => self.status = "SAVED ASSETS/RENDER/SETTINGS.JSON".to_string(),
                Err(error) => self.status = format!("SAVE FAILED: {error}"),
            }
        }
        if ui.button(x + 126.0, actions_y, 104.0, 28.0, "RELOAD", style) {
            match render_settings::reload() {
                Ok(document) => {
                    self.document = document;
                    crate::set_render_quality(self.document.selected_preset.render_quality());
                    self.apply(renderer, gpu);
                    self.status = "RELOADED DISK SETTINGS".to_string();
                }
                Err(error) => self.status = format!("RELOAD FAILED: {error}"),
            }
        }
        if ui.button(x + 238.0, actions_y, 144.0, 28.0, "RESET PRESET", style) {
            self.document.reset_selected();
            self.apply(renderer, gpu);
            self.status = "RESET ACTIVE PRESET".to_string();
        }
        ui.text(
            &truncate_status(&self.status),
            x + 392.0,
            actions_y + 9.0,
            1.0,
            MUTED,
        );
    }

    fn draw_preset_row(&mut self, ui: &mut UiBuilder, x: f32, y: f32) -> bool {
        ui.text("QUALITY", x + 16.0, y + 9.0, 1.4, TEXT);
        let mut changed = false;
        for (index, preset) in QualityPreset::ALL.into_iter().enumerate() {
            let bx = x + 124.0 + index as f32 * 112.0;
            let selected = self.document.selected_preset == preset;
            if ui.button(bx, y, 104.0, 28.0, preset.label(), selected_style(selected)) {
                self.document.select(preset);
                crate::set_render_quality(preset.render_quality());
                self.status = "PRESET APPLIED; SHADER TIER ON RESTART".to_string();
                changed = true;
            }
        }
        changed
    }

    fn draw_page_tabs(&mut self, ui: &mut UiBuilder, x: f32, y: f32) {
        for (index, (page, label)) in [
            (Page::Lighting, "LIGHTING"),
            (Page::Post, "POST / AA"),
            (Page::Color, "COLOR / PALETTE"),
        ]
        .into_iter()
        .enumerate()
        {
            if ui.button(
                x + 14.0 + index as f32 * 180.0,
                y,
                170.0,
                28.0,
                label,
                selected_style(self.page == page),
            ) {
                self.page = page;
            }
        }
    }

    fn draw_lighting(&mut self, ui: &mut UiBuilder, x: f32, mut y: f32) -> bool {
        let preset = self.document.selected_mut();
        let mut changed = false;
        changed |= slider_row(
            ui,
            x,
            y,
            "AMBIENT",
            &mut preset.ambient_intensity,
            0.0,
            2.0,
            2,
        );
        y += ROW_H;
        changed |= slider_row(
            ui,
            x,
            y,
            "EMISSIVE",
            &mut preset.emissive_scalar,
            0.0,
            8.0,
            2,
        );
        y += ROW_H;
        changed |= slider_row(
            ui,
            x,
            y,
            "AO INTENSITY",
            &mut preset.ao.intensity,
            0.0,
            4.0,
            2,
        );
        y += ROW_H;
        changed |= slider_row(
            ui,
            x,
            y,
            "SUN AZIMUTH",
            &mut preset.sun.azimuth_degrees,
            -180.0,
            180.0,
            1,
        );
        y += ROW_H;
        changed |= slider_row(
            ui,
            x,
            y,
            "SUN ELEVATION",
            &mut preset.sun.elevation_degrees,
            5.0,
            89.0,
            1,
        );
        y += ROW_H;
        changed |= slider_row(
            ui,
            x,
            y,
            "SUN INTENSITY",
            &mut preset.sun.intensity,
            0.0,
            8.0,
            2,
        );
        for channel in 0..3 {
            y += ROW_H;
            changed |= slider_row(
                ui,
                x,
                y,
                ["SUN RED", "SUN GREEN", "SUN BLUE"][channel],
                &mut preset.sun.color[channel],
                0.0,
                4.0,
                2,
            );
        }
        y += ROW_H;
        changed |= option_row(
            ui,
            x,
            y,
            "SHADOW SIZE",
            &mut preset.shadows.map_size,
            &[512, 1024, 2048, 4096],
        );
        y += ROW_H;
        changed |= slider_row(
            ui,
            x,
            y,
            "SHADOW RANGE",
            &mut preset.shadows.world_radius,
            8.0,
            256.0,
            1,
        );
        y += ROW_H;
        changed |= slider_row(
            ui,
            x,
            y,
            "DEPTH BIAS",
            &mut preset.shadows.depth_bias,
            0.0,
            0.05,
            4,
        );
        y += ROW_H;
        changed |= slider_row(
            ui,
            x,
            y,
            "NORMAL BIAS",
            &mut preset.shadows.normal_bias,
            0.0,
            8.0,
            2,
        );
        y += ROW_H;
        changed |= slider_row(
            ui,
            x,
            y,
            "PENUMBRA",
            &mut preset.shadows.penumbra,
            0.0,
            100.0,
            1,
        );
        changed
    }

    fn draw_post(&mut self, ui: &mut UiBuilder, x: f32, mut y: f32) -> bool {
        let preset = self.document.selected_mut();
        let mut changed = false;
        changed |= slider_row(ui, x, y, "EXPOSURE", &mut preset.exposure, 0.1, 4.0, 2);
        y += ROW_H;
        changed |= slider_row(
            ui,
            x,
            y,
            "BLOOM THRESHOLD",
            &mut preset.bloom.threshold,
            0.0,
            8.0,
            2,
        );
        y += ROW_H;
        changed |= slider_row(
            ui,
            x,
            y,
            "BLOOM INTENSITY",
            &mut preset.bloom.intensity,
            0.0,
            4.0,
            2,
        );
        y += ROW_H;
        changed |= slider_row(
            ui,
            x,
            y,
            "BLOOM SIZE",
            &mut preset.bloom.radius,
            0.25,
            4.0,
            2,
        );
        y += ROW_H + 5.0;
        changed |= ui.checkbox(x + 18.0, y, 18.0, "FXAA ENABLED", &mut preset.aa.enabled, crate::hud::button_style());
        y += ROW_H + 5.0;
        changed |= slider_row(
            ui,
            x,
            y,
            "AA MIN EDGE",
            &mut preset.aa.edge_threshold_min,
            0.001,
            0.5,
            3,
        );
        y += ROW_H;
        changed |= slider_row(
            ui,
            x,
            y,
            "AA EDGE",
            &mut preset.aa.edge_threshold,
            0.01,
            0.5,
            3,
        );
        y += ROW_H;
        changed |= slider_row(
            ui,
            x,
            y,
            "AA SUBPIXEL",
            &mut preset.aa.subpixel_blend,
            0.0,
            1.0,
            2,
        );
        changed
    }

    fn draw_color(&mut self, ui: &mut UiBuilder, x: f32, mut y: f32) -> bool {
        let preset = self.document.selected_mut();
        let grade = &mut preset.color_grading;
        let mut changed = false;
        changed |= slider_row(ui, x, y, "SATURATION", &mut grade.saturation, 0.0, 2.0, 2);
        y += ROW_H;
        changed |= slider_row(ui, x, y, "CONTRAST", &mut grade.contrast, 0.0, 2.0, 2);
        y += ROW_H;
        changed |= slider_row(ui, x, y, "DISPLAY GAMMA", &mut grade.gamma, 0.5, 2.5, 2);
        y += ROW_H;
        changed |= slider_row(
            ui,
            x,
            y,
            "TEMPERATURE",
            &mut grade.temperature,
            -1.0,
            1.0,
            2,
        );
        y += ROW_H;
        changed |= slider_row(ui, x, y, "TINT", &mut grade.tint, -1.0, 1.0, 2);
        for channel in 0..3 {
            y += ROW_H;
            changed |= slider_row(
                ui,
                x,
                y,
                ["LIFT R", "LIFT G", "LIFT B"][channel],
                &mut grade.lift[channel],
                -1.0,
                1.0,
                2,
            );
        }
        for channel in 0..3 {
            y += ROW_H;
            changed |= slider_row(
                ui,
                x,
                y,
                ["COLOR GAMMA R", "COLOR GAMMA G", "COLOR GAMMA B"][channel],
                &mut grade.color_gamma[channel],
                0.1,
                4.0,
                2,
            );
        }
        for channel in 0..3 {
            y += ROW_H;
            changed |= slider_row(
                ui,
                x,
                y,
                ["GAIN R", "GAIN G", "GAIN B"][channel],
                &mut grade.gain[channel],
                0.0,
                4.0,
                2,
            );
        }
        y += ROW_H + 3.0;
        changed |= ui.checkbox(
            x + 18.0,
            y,
            18.0,
            "PALETTE QUANTIZATION",
            &mut preset.palette.enabled,
            crate::hud::button_style(),
        );
        y += ROW_H + 3.0;
        changed |= option_row(
            ui,
            x,
            y,
            "PALETTE LEVELS",
            &mut preset.palette.levels,
            &[2, 4, 8, 16, 32, 64],
        );
        y += ROW_H;
        changed |= slider_row(
            ui,
            x,
            y,
            "PALETTE STRENGTH",
            &mut preset.palette.strength,
            0.0,
            1.0,
            2,
        );
        y += ROW_H;
        changed |= slider_row(
            ui,
            x,
            y,
            "PALETTE DITHER",
            &mut preset.palette.dither,
            0.0,
            1.0,
            2,
        );
        changed
    }

    fn apply<G: Gpu>(&mut self, renderer: &mut Renderer, gpu: &mut G) {
        match self.document.selected().validate("active") {
            Ok(()) => {
                match renderer.apply_settings(gpu, self.document.selected().renderer_settings()) {
                    Ok(()) => {
                        if let Err(error) = render_settings::replace(self.document.clone()) {
                            self.status = format!("SETTINGS STATE FAILED: {error}");
                        } else if !self.status.starts_with("PRESET") {
                            self.status = "LIVE SETTINGS APPLIED".to_string();
                        }
                    }
                    Err(error) => self.status = format!("GPU APPLY FAILED: {error:?}"),
                }
            }
            Err(error) => self.status = format!("INVALID SETTINGS: {error}"),
        }
    }
}

impl Default for GraphicsTuner {
    fn default() -> Self {
        Self::new()
    }
}

fn selected_style(selected: bool) -> ButtonStyle {
    if selected {
        ButtonStyle {
            fill: [104, 77, 32, 245],
            hover: [126, 94, 38, 255],
            active: [150, 112, 44, 255],
            edge: ACCENT,
            text: [255, 232, 174, 255],
        }
    } else {
        crate::hud::button_style()
    }
}

#[allow(clippy::too_many_arguments)]
fn slider_row(
    ui: &mut UiBuilder,
    x: f32,
    y: f32,
    label: &str,
    value: &mut f32,
    min: f32,
    max: f32,
    precision: usize,
) -> bool {
    ui.text(label, x + 18.0, y + 7.0, 1.25, TEXT);
    let display = format!("{value:.precision$}");
    let display_w = ui.measure_text(&display, 1.2);
    ui.text(&display, x + 208.0 - display_w, y + 7.0, 1.2, MUTED);
    ui.slider(x + 220.0, y + 2.0, 330.0, 20.0, value, min, max, crate::hud::button_style())
}

fn option_row(
    ui: &mut UiBuilder,
    x: f32,
    y: f32,
    label: &str,
    value: &mut u32,
    options: &[u32],
) -> bool {
    ui.text(label, x + 18.0, y + 7.0, 1.25, TEXT);
    let button_w = 326.0 / options.len() as f32;
    let mut changed = false;
    for (index, option) in options.iter().copied().enumerate() {
        let label = option.to_string();
        if ui.button(
            x + 220.0 + index as f32 * button_w,
            y,
            button_w - 3.0,
            22.0,
            &label,
            selected_style(*value == option),
        ) {
            *value = option;
            changed = true;
        }
    }
    changed
}

fn truncate_status(status: &str) -> String {
    status.chars().take(27).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backquote_toggle_is_edge_triggered() {
        let mut tuner = GraphicsTuner::new();
        assert!(tuner.handle_toggle(true));
        assert!(tuner.is_open());
        assert!(!tuner.handle_toggle(true));
        assert!(!tuner.handle_toggle(false));
        assert!(tuner.handle_toggle(true));
        assert!(!tuner.is_open());
    }
}
