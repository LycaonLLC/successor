//! BUGREPORT — bug report submission window UI.

use super::{WindowAction, DIM, ACCENT};
use crate::hud::Icons;
use successor_engine_render::ui::{UiBuilder, ButtonStyle, TextField};
use std::cell::RefCell;

thread_local! {
    static BUG_BODY: RefCell<TextField> = RefCell::new(TextField::new(256));
}

#[derive(Clone, Debug, Default)]
pub struct BugReportModel {
    pub category: String,
    pub status_text: Option<String>,
}

impl BugReportModel {
    pub fn sample() -> Self {
        Self {
            category: "interface".into(),
            status_text: None,
        }
    }
}

pub fn draw(ui: &mut UiBuilder, rect: [f32; 4], model: &BugReportModel, icons: &Icons, out: &mut Vec<WindowAction>) {
    let [x, y, w, h] = rect;

    // Header
    ui.text("SUBMIT BUG REPORT", x, y, 2.2, ACCENT);
    
    // Draw icon if available
    if let Some((col, row)) = icons.cell("bug-report") {
        ui.icon(col, row, x + w - 32.0, y - 4.0, 24.0, 24.0, ACCENT);
    }

    let start_y = y + 26.0;

    // Help Intro
    ui.text("TELL US WHAT BROKE, WHAT YOU EXPECTED,", x, start_y, 1.4, DIM);
    ui.text("AND HOW TO REPRODUCE IT.", x, start_y + 12.0, 1.4, DIM);

    // Category Selector
    let cat_y = start_y + 32.0;
    ui.text("AREA", x, cat_y, 1.4, DIM);

    let categories = [
        ("gameplay", "GAMEPLAY"),
        ("interface", "INTERFACE"),
        ("connection", "CONNECTION"),
        ("graphics_audio", "GRAPHICS/AUDIO"),
        ("other", "OTHER"),
    ];

    let cat_btn_w = (w - 12.0) / 3.0;
    let cat_btn_h = 22.0;
    
    for (i, &(cat_id, label)) in categories.iter().enumerate() {
        let col = i % 3;
        let row = i / 3;
        let bx = x + col as f32 * (cat_btn_w + 6.0);
        let by = cat_y + 14.0 + row as f32 * (cat_btn_h + 6.0);

        let mut style = ButtonStyle::default();
        let is_selected = model.category == cat_id;
        if is_selected {
            style.fill = [70, 92, 120, 240];
            style.edge = ACCENT;
        }

        if ui.button(bx, by, cat_btn_w, cat_btn_h, label, style) {
            out.push(WindowAction::Button(format!("bug:category:{}", cat_id)));
        }
    }

    // Text Field for body
    let body_label_y = cat_y + 14.0 + 2.0 * (cat_btn_h + 6.0) + 12.0;
    ui.text("WHAT HAPPENED?", x, body_label_y, 1.4, DIM);

    let body_field_y = body_label_y + 14.0;
    let body_field_h = h - (body_field_y - y) - 52.0; // leave space for diagnostics + submit button
    
    BUG_BODY.with(|f| {
        let mut f = f.borrow_mut();
        ui.text_field(&mut f, x, body_field_y, w, body_field_h, 1.6, true);
    });

    // Diagnostics / Status Foot
    let foot_y = body_field_y + body_field_h + 8.0;
    ui.text("SESSION DIAGNOSTICS WILL BE SENT AUTOMATICALLY.", x, foot_y, 1.2, DIM);

    if let Some(status) = &model.status_text {
        ui.text(status, x, foot_y + 14.0, 1.4, ACCENT);
    }

    // Submit Button
    let btn_y = y + h - 30.0;
    let submit_style = ButtonStyle::default();
    if ui.button(x, btn_y, w, 26.0, "SEND REPORT", submit_style) {
        out.push(WindowAction::Button("bug:submit".into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bug_report_submit_button_emits_action() {
        let icons = Icons::load();
        let model = BugReportModel::sample();
        let mut ui = UiBuilder::new(icons.meta);
        
        // rect = [10.0, 10.0, 300.0, 400.0]
        // Submit button is at bottom: btn_y = 10.0 + 400.0 - 30.0 = 380.0
        // Size = 300.0 x 26.0, x = 10.0
        let bx = 10.0 + 150.0;
        let by = 380.0 + 10.0;

        ui.set_input(bx, by, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, [10.0, 10.0, 300.0, 400.0], &model, &icons, &mut out);

        ui.set_input(bx, by, false);
        ui.begin(1280, 720);
        out.clear();
        draw(&mut ui, [10.0, 10.0, 300.0, 400.0], &model, &icons, &mut out);

        assert!(
            out.contains(&WindowAction::Button("bug:submit".into())),
            "Expected bug:submit action, got {:?}", out
        );
    }
}
