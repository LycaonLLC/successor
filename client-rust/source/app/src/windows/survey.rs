//! SURVEY — resource survey tool with concentrations readout.

use super::{WindowAction, TEXT, DIM, ACCENT, SLOT, SLOT_EDGE};
use crate::hud::Icons;
use successor_engine_render::ui::{UiBuilder, ButtonStyle};

#[derive(Clone, Debug, Default)]
pub struct SurveyResource {
    pub name: String,
    pub concentration: f32, // 0.0 to 1.0
}

#[derive(Clone, Debug, Default)]
pub struct SurveyModel {
    pub location_name: String,
    pub detected: Vec<SurveyResource>,
}

impl SurveyModel {
    pub fn sample() -> Self {
        Self {
            location_name: "DUSTGATE OUTPOST".to_string(),
            detected: vec![
                SurveyResource {
                    name: "Copper".to_string(),
                    concentration: 0.45,
                },
                SurveyResource {
                    name: "Iron".to_string(),
                    concentration: 0.78,
                },
                SurveyResource {
                    name: "Fuel".to_string(),
                    concentration: 0.12,
                },
                SurveyResource {
                    name: "Silica".to_string(),
                    concentration: 0.55,
                },
            ],
        }
    }
}

pub fn draw(ui: &mut UiBuilder, rect: [f32; 4], model: &SurveyModel, icons: &Icons, out: &mut Vec<WindowAction>) {
    let [x, y, w, h] = rect;

    // ── Header (radar-style) ─────────────────────────────────────────────
    let header_h = 44.0;
    ui.rect(x, y, w, header_h, [10, 14, 20, 210]);
    ui.border(x, y, w, header_h, 1.0, SLOT_EDGE);

    // Survey icon (using "survey" key)
    if let Some((col, row)) = icons.cell("survey") {
        ui.icon(col, row, x + 8.0, y + 6.0, 32.0, 32.0, ACCENT);
    }

    // Title
    ui.text("RESOURCE SURVEY", x + 46.0, y + 6.0, 1.8, ACCENT);
    let loc_text = format!("LOC: {}", model.location_name.to_uppercase());
    ui.text(&loc_text, x + 46.0, y + 24.0, 1.4, DIM);

    // Divider below header
    ui.rect(x, y + header_h, w, 1.0, SLOT_EDGE);

    // ── Concentrations Readout ───────────────────────────────────────────
    let list_y = y + header_h + 12.0;
    for (i, res) in model.detected.iter().enumerate() {
        let ry = list_y + i as f32 * 26.0;
        if ry + 20.0 > y + h - 46.0 {
            break; // Clip list before action button
        }

        // Resource Name label
        ui.text(&res.name.to_uppercase(), x + 8.0, ry + 2.0, 1.6, TEXT);

        // Progress bar for concentration
        let bar_x = x + 100.0;
        let bar_w = (w - 100.0 - 64.0).max(60.0);
        let pct_x = bar_x + bar_w + 8.0;

        ui.rect(bar_x, ry + 2.0, bar_w, 14.0, SLOT);
        if res.concentration > 0.0 {
            let fill_color = [70, 120, 180, 235]; // Nice blue/cyan
            ui.rect(bar_x, ry + 2.0, bar_w * res.concentration.clamp(0.0, 1.0), 14.0, fill_color);
        }
        ui.border(bar_x, ry + 2.0, bar_w, 14.0, 1.0, SLOT_EDGE);

        // Percentage text next to bar
        let pct_text = format!("{:.1}%", res.concentration * 100.0);
        ui.text(&pct_text, pct_x, ry + 2.0, 1.4, ACCENT);
    }

    // ── Survey Action Button ─────────────────────────────────────────────
    let btn_style = ButtonStyle::default();
    let btn_y = y + h - 38.0;
    if ui.button(x + 8.0, btn_y, w - 16.0, 30.0, "SURVEY / SAMPLE", btn_style) {
        out.push(WindowAction::Survey);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clicking_survey_button_emits_survey_action() {
        let icons = Icons::load();
        let model = SurveyModel::sample();
        let mut ui = UiBuilder::new(icons.meta);

        // Rect is [100.0, 100.0, 300.0, 250.0]
        // Button Y: y + h - 38 = 100.0 + 250.0 - 38 = 312.0. Height is 30.0. Center Y: 327.0.
        // Button X: x + 8 = 108.0. Width: 300.0 - 16.0 = 284.0. Center X: 108.0 + 142.0 = 250.0.
        ui.set_input(250.0, 327.0, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, [100.0, 100.0, 300.0, 250.0], &model, &icons, &mut out);

        ui.set_input(250.0, 327.0, false);
        ui.begin(1280, 720);
        out.clear();
        draw(&mut ui, [100.0, 100.0, 300.0, 250.0], &model, &icons, &mut out);

        assert_eq!(out, vec![WindowAction::Survey]);
    }
}
