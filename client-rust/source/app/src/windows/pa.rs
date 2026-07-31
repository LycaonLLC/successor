//! PERSONAL ARMOR — status/energy readout + ability grid.

use super::{WindowAction, ACCENT, DIM, SLOT, SLOT_EDGE, TEXT};
use crate::hud::Icons;
use successor_engine_render::ui::{ButtonStyle, UiBuilder};

#[derive(Clone, Debug, Default)]
pub struct PaAbility {
    pub id: String,
    pub name: String,
    pub cost: f32,
    pub cooldown_pct: f32, // 0.0 to 1.0
}

#[derive(Clone, Debug, Default)]
pub struct PaModel {
    pub energy: f32,
    pub energy_max: f32,
    pub abilities: Vec<PaAbility>,
}

impl PaModel {
    pub fn sample() -> Self {
        Self {
            energy: 75.0,
            energy_max: 100.0,
            abilities: vec![
                PaAbility {
                    id: "shield-overload".into(),
                    name: "SHIELD OVERLOAD".into(),
                    cost: 20.0,
                    cooldown_pct: 0.0,
                },
                PaAbility {
                    id: "capacitor-boost".into(),
                    name: "CAPACITOR BOOST".into(),
                    cost: 40.0,
                    cooldown_pct: 0.5,
                },
                PaAbility {
                    id: "system-purge".into(),
                    name: "SYSTEM PURGE".into(),
                    cost: 15.0,
                    cooldown_pct: 0.0,
                },
                PaAbility {
                    id: "overcharge".into(),
                    name: "OVERCHARGE".into(),
                    cost: 50.0,
                    cooldown_pct: 0.8,
                },
            ],
        }
    }
}

pub fn draw(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    model: &PaModel,
    icons: &Icons,
    out: &mut Vec<WindowAction>,
) {
    let [x, y, w, h] = rect;

    // Header
    ui.text("PERSONAL ARMOR SYSTEM", x, y, 2.2, ACCENT);

    // Draw icon if available (maybe 'pa' icon doesn't exist, we can check or fall back to none)
    if let Some((col, row)) = icons.cell("pa") {
        ui.icon(col, row, x + w - 32.0, y - 4.0, 24.0, 24.0, ACCENT);
    }

    // Energy Bar
    let bar_y = y + 26.0;
    let bar_w = w;
    ui.rect(x, bar_y, bar_w, 20.0, SLOT);
    if model.energy > 0.0 {
        let fill_w = bar_w * (model.energy / model.energy_max.max(1.0)).clamp(0.0, 1.0);
        ui.rect(x, bar_y, fill_w, 20.0, [86, 156, 210, 235]);
    }
    ui.border(x, bar_y, bar_w, 20.0, 1.0, SLOT_EDGE);

    let energy_text = format!(
        "ENERGY: {}/{}",
        model.energy as i32, model.energy_max as i32
    );
    ui.text(&energy_text, x + 8.0, bar_y + 4.0, 1.8, TEXT);

    // Abilities Grid
    let grid_title_y = bar_y + 32.0;
    ui.text("ARMOR ABILITIES", x, grid_title_y, 1.8, DIM);

    let start_y = grid_title_y + 20.0;
    let _grid_h = h - (start_y - y);

    // 2 columns, N rows
    let col_w = (w - 10.0) / 2.0;
    let row_h = 50.0;

    for (i, ability) in model.abilities.iter().enumerate() {
        let col = i % 2;
        let row = i / 2;
        let ax = x + col as f32 * (col_w + 10.0);
        let ay = start_y + row as f32 * (row_h + 10.0);

        if ay + row_h > y + h {
            break; // Clip to window height
        }

        // Draw ability button frame
        let mut style = ButtonStyle::default();
        let is_cooldown = ability.cooldown_pct > 0.0;
        let affordable = model.energy >= ability.cost;

        if is_cooldown {
            style.fill = [40, 40, 40, 200];
            style.text = DIM;
        } else if !affordable {
            style.fill = [60, 30, 30, 200];
            style.text = [220, 100, 100, 255];
        }

        // Button label: Name + cost/cooldown
        let label = if is_cooldown {
            format!("{} (CD {:.0}%)", ability.name, ability.cooldown_pct * 100.0)
        } else {
            format!("{} ({} EN)", ability.name, ability.cost as i32)
        };

        if ui.button(ax, ay, col_w, row_h, &label, style) && !is_cooldown && affordable {
            out.push(WindowAction::Button(format!("pa:activate:{}", ability.id)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pa_ability_button_emits_action() {
        let icons = Icons::load();
        let model = PaModel::sample();
        let mut ui = UiBuilder::new(icons.meta);

        // Let's click the first ability: row 0, col 0
        // rect = [10.0, 10.0, 300.0, 400.0]
        // grid_title_y = y + 26.0 + 32.0 = 68.0
        // start_y = 68.0 + 20.0 = 88.0
        // First ability: ax = 10.0, ay = 88.0, size = col_w x 50.0
        // col_w = (300.0 - 10.0) / 2.0 = 145.0
        let bx = 10.0 + 50.0;
        let by = 88.0 + 20.0;

        ui.set_input(bx, by, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(
            &mut ui,
            [10.0, 10.0, 300.0, 400.0],
            &model,
            &icons,
            &mut out,
        );

        ui.set_input(bx, by, false);
        ui.begin(1280, 720);
        out.clear();
        draw(
            &mut ui,
            [10.0, 10.0, 300.0, 400.0],
            &model,
            &icons,
            &mut out,
        );

        assert!(
            out.contains(&WindowAction::Button("pa:activate:shield-overload".into())),
            "Expected pa:activate:shield-overload action, got {:?}",
            out
        );
    }
}
