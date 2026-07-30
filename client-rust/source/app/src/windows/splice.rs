//! SPLICE — gene/crop splice bench UI.

use super::{WindowAction, TEXT, DIM, ACCENT, SLOT, SLOT_EDGE};
use crate::hud::Icons;
use successor_engine_render::ui::{UiBuilder, ButtonStyle};

#[derive(Clone, Debug, Default)]
pub struct SpliceModel {
    pub parent_a: Option<String>,
    pub parent_b: Option<String>,
    pub result_preview: Option<String>,
    pub can_combine: bool,
}

impl SpliceModel {
    pub fn sample() -> Self {
        Self {
            parent_a: Some("TATOOINE MELON SEED".into()),
            parent_b: Some("CORELLIAN CORN SPORE".into()),
            result_preview: Some("HYBRID SWEET-CORN MELON SEED".into()),
            can_combine: true,
        }
    }
}

pub fn draw(ui: &mut UiBuilder, rect: [f32; 4], model: &SpliceModel, icons: &Icons, out: &mut Vec<WindowAction>) {
    let [x, y, w, h] = rect;

    // Header
    ui.text("GENE SPLICE BENCH", x, y, 2.2, ACCENT);
    
    // Draw icon if available
    if let Some((col, row)) = icons.cell("splice") {
        ui.icon(col, row, x + w - 32.0, y - 4.0, 24.0, 24.0, ACCENT);
    }

    let start_y = y + 36.0;
    let slot_h = 44.0;

    // Parent A Slot
    ui.text("PARENT GENE A", x, start_y, 1.8, DIM);
    let slot_a_y = start_y + 16.0;
    ui.rect(x, slot_a_y, w, slot_h, SLOT);
    ui.border(x, slot_a_y, w, slot_h, 1.0, SLOT_EDGE);
    if let Some(name) = &model.parent_a {
        ui.text(name, x + 10.0, slot_a_y + 12.0, 1.8, TEXT);
    } else {
        ui.text("EMPTY SLOT - INSERT GENE", x + 10.0, slot_a_y + 12.0, 1.8, DIM);
    }

    // Parent B Slot
    let slot_b_label_y = slot_a_y + slot_h + 12.0;
    ui.text("PARENT GENE B", x, slot_b_label_y, 1.8, DIM);
    let slot_b_y = slot_b_label_y + 16.0;
    ui.rect(x, slot_b_y, w, slot_h, SLOT);
    ui.border(x, slot_b_y, w, slot_h, 1.0, SLOT_EDGE);
    if let Some(name) = &model.parent_b {
        ui.text(name, x + 10.0, slot_b_y + 12.0, 1.8, TEXT);
    } else {
        ui.text("EMPTY SLOT - INSERT GENE", x + 10.0, slot_b_y + 12.0, 1.8, DIM);
    }

    // Preview Slot
    let preview_label_y = slot_b_y + slot_h + 16.0;
    ui.text("SPLICE PREVIEW", x, preview_label_y, 1.8, ACCENT);
    let preview_y = preview_label_y + 16.0;
    ui.rect(x, preview_y, w, slot_h, SLOT);
    ui.border(x, preview_y, w, slot_h, 1.0, ACCENT);
    if let Some(name) = &model.result_preview {
        ui.text(name, x + 10.0, preview_y + 12.0, 1.8, ACCENT);
    } else {
        ui.text("NO PREVIEW AVAILABLE", x + 10.0, preview_y + 12.0, 1.8, DIM);
    }

    // COMBINE button
    let btn_y = y + h - 30.0;
    let mut btn_style = ButtonStyle::default();
    if !model.can_combine {
        btn_style.text = DIM;
    }
    
    if ui.button(x, btn_y, w, 26.0, "COMBINE GENES", btn_style) && model.can_combine {
        out.push(WindowAction::Button("splice:combine".into()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splice_combine_button_emits_action() {
        let icons = Icons::load();
        let model = SpliceModel::sample();
        let mut ui = UiBuilder::new(icons.meta);
        
        // rect = [10.0, 10.0, 300.0, 400.0]
        // COMBINE button is at bottom: btn_y = 10.0 + 400.0 - 30.0 = 380.0
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
            out.contains(&WindowAction::Button("splice:combine".into())),
            "Expected splice:combine action, got {:?}", out
        );
    }
}
