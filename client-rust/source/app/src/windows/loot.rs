//! LOOT — Lootable container/corpse content view.
use super::{WindowAction, TEXT, DIM, ACCENT, SLOT, SLOT_EDGE};
use crate::hud::Icons;
use successor_engine_render::ui::{UiBuilder, ButtonStyle};

#[derive(Clone, Debug)]
pub struct ItemStack {
    pub id: u32,
    pub name: String,
    pub kind: String,
    pub qty: u32,
}

#[derive(Clone, Debug, Default)]
pub struct LootModel {
    pub source_name: String,
    pub items: Vec<ItemStack>,
}

impl LootModel {
    pub fn sample() -> Self {
        Self {
            source_name: "CORPSE OF DUSTGATE SCOUT".into(),
            items: vec![
                ItemStack { id: 101, name: "SLUGTHROWER".into(), kind: "item-weapon".into(), qty: 1 },
                ItemStack { id: 102, name: "RIFLE AMMO".into(), kind: "item-ammo".into(), qty: 120 },
                ItemStack { id: 103, name: "MEDKIT".into(), kind: "item-medical".into(), qty: 2 },
            ],
        }
    }
}

pub fn draw(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    model: &LootModel,
    icons: &Icons,
    out: &mut Vec<WindowAction>,
) {
    let [x, y, w, h] = rect;

    // Header: source name
    ui.text(&model.source_name, x + 8.0, y + 8.0, 2.0, ACCENT);

    if model.items.is_empty() {
        let empty_text = "NOTHING REMAINS";
        let tw = UiBuilder::text_width(empty_text, 2.0);
        ui.text(empty_text, x + (w - tw) * 0.5, y + h * 0.4, 2.0, DIM);
    } else {
        let mut iy = y + 32.0;
        for item in &model.items {
            if iy + 30.0 > y + h - 44.0 {
                break; // Leave room for LOOT ALL button
            }

            // Draw item row background / border
            ui.rect(x + 8.0, iy, w - 16.0, 30.0, SLOT);
            ui.border(x + 8.0, iy, w - 16.0, 30.0, 1.0, SLOT_EDGE);

            // Icon
            if let Some((col, row)) = icons.cell(&item.kind) {
                ui.icon(col, row, x + 14.0, iy + 5.0, 20.0, 20.0, TEXT);
            }

            // Name & qty
            let label = if item.qty > 1 {
                format!("{} x{}", item.name, item.qty)
            } else {
                item.name.clone()
            };
            ui.text(&label, x + 40.0, iy + 7.0, 1.6, TEXT);

            // LOOT button
            let btn_w = 60.0;
            let btn_h = 22.0;
            let btn_x = x + w - btn_w - 14.0;
            let btn_y = iy + 4.0;
            if ui.button(btn_x, btn_y, btn_w, btn_h, "LOOT", ButtonStyle::default()) {
                out.push(WindowAction::LootItem(item.id));
            }

            iy += 34.0;
        }
    }

    // LOOT ALL button at the bottom
    let lay_y = y + h - 36.0;
    let mut loot_all_style = ButtonStyle::default();
    loot_all_style.fill = [180, 130, 40, 210]; // Warm accent-like color
    if ui.button(x + 8.0, lay_y, w - 16.0, 28.0, "LOOT ALL", loot_all_style) {
        out.push(WindowAction::LootAll);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loot_item_button_emits_action() {
        let icons = Icons::load();
        let model = LootModel::sample();
        let mut ui = UiBuilder::new(icons.meta);

        // Rect = [100.0, 100.0, 400.0, 300.0]
        // First item iy = 100 + 32 = 132.
        // Button is at btn_x = 100 + 400 - 60 - 14 = 426.
        // btn_y = 132 + 4 = 136.
        // Center is roughly 456, 147.
        let bx = 456.0;
        let by = 147.0;

        ui.set_input(bx, by, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, [100.0, 100.0, 400.0, 300.0], &model, &icons, &mut out);

        ui.set_input(bx, by, false);
        ui.begin(1280, 720);
        out.clear();
        draw(&mut ui, [100.0, 100.0, 400.0, 300.0], &model, &icons, &mut out);

        assert_eq!(out, vec![WindowAction::LootItem(101)]);
    }

    #[test]
    fn loot_all_button_emits_action() {
        let icons = Icons::load();
        let model = LootModel::sample();
        let mut ui = UiBuilder::new(icons.meta);

        // Rect = [100.0, 100.0, 400.0, 300.0]
        // LOOT ALL is at lay_y = 100 + 300 - 36 = 364.
        // x = 100 + 8 = 108. Width = 400 - 16 = 384.
        // Center is 108 + 192 = 300, 364 + 14 = 378.
        let bx = 300.0;
        let by = 378.0;

        ui.set_input(bx, by, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, [100.0, 100.0, 400.0, 300.0], &model, &icons, &mut out);

        ui.set_input(bx, by, false);
        ui.begin(1280, 720);
        out.clear();
        draw(&mut ui, [100.0, 100.0, 400.0, 300.0], &model, &icons, &mut out);

        assert_eq!(out, vec![WindowAction::LootAll]);
    }
}
