//! ACTIONS — action/ability browser UI.

use super::{WindowAction, ACCENT, DIM, SLOT, TEXT};
use crate::hud::Icons;
use successor_engine_render::ui::UiBuilder;

#[derive(Clone, Debug, Default)]
pub struct ActionItem {
    pub id: String,
    pub name: String,
    pub icon_key: String,
    pub desc: String,
}

#[derive(Clone, Debug, Default)]
pub struct ActionsModel {
    pub actions: Vec<ActionItem>,
}

impl ActionsModel {
    pub fn sample() -> Self {
        Self {
            actions: vec![
                ActionItem {
                    id: "shoot".into(),
                    name: "FIRE WEAPON".into(),
                    icon_key: "crosshair".into(),
                    desc: "ATTACK WITH EQUIPPED WEAPON".into(),
                },
                ActionItem {
                    id: "reload".into(),
                    name: "RELOAD".into(),
                    icon_key: "reload".into(),
                    desc: "RELOAD CURRENT WEAPON AMMO".into(),
                },
                ActionItem {
                    id: "kneel".into(),
                    name: "KNEEL".into(),
                    icon_key: "kneel".into(),
                    desc: "CROUCH FOR STABILITY / COVER".into(),
                },
                ActionItem {
                    id: "stand".into(),
                    name: "STAND".into(),
                    icon_key: "stand".into(),
                    desc: "STAND UP TO WALK / SPRINT".into(),
                },
                ActionItem {
                    id: "peace".into(),
                    name: "PEACE".into(),
                    icon_key: "peace".into(),
                    desc: "SHEATHE WEAPONS / CEASE FIRE".into(),
                },
                ActionItem {
                    id: "inspect".into(),
                    name: "INSPECT".into(),
                    icon_key: "actions".into(),
                    desc: "EXAMINE TARGET DETAILS".into(),
                },
            ],
        }
    }
}

pub fn draw(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    model: &ActionsModel,
    icons: &Icons,
    out: &mut Vec<WindowAction>,
) {
    let [x, y, w, h] = rect;

    // Header
    ui.text("ACTION BROWSER", x, y, 2.2, ACCENT);

    // Draw default actions icon if available
    if let Some((col, row)) = icons.cell("actions") {
        ui.icon(col, row, x + w - 32.0, y - 4.0, 24.0, 24.0, ACCENT);
    }

    let start_y = y + 26.0;

    // 2 columns, N rows
    let col_w = (w - 10.0) / 2.0;
    let row_h = 44.0;
    let gap = 10.0;

    for (i, action) in model.actions.iter().enumerate() {
        let col = i % 2;
        let row = i / 2;
        let ax = x + col as f32 * (col_w + gap);
        let ay = start_y + row as f32 * (row_h + gap);

        if ay + row_h > y + h {
            break; // Clip to window height
        }

        // Interaction for hover/click
        let resp = ui.interact(ax, ay, col_w, row_h);

        let bg_color = if resp.hovered {
            [36, 48, 64, 230]
        } else {
            SLOT
        };

        ui.rect(ax, ay, col_w, row_h, bg_color);

        // Icon
        if let Some((icol, irow)) = icons.cell(&action.icon_key) {
            ui.icon(icol, irow, ax + 6.0, ay + 6.0, 32.0, 32.0, TEXT);
        }

        // Text labels (Name + Desc)
        ui.text(&action.name, ax + 44.0, ay + 6.0, 1.6, TEXT);
        ui.text(&action.desc, ax + 44.0, ay + 24.0, 1.2, DIM);

        if resp.clicked {
            out.push(WindowAction::Button(format!("action:{}", action.id)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_browser_item_click_emits_action() {
        let icons = Icons::load();
        let model = ActionsModel::sample();
        let mut ui = UiBuilder::new(icons.meta);

        // rect = [10.0, 10.0, 300.0, 400.0]
        // start_y = 10.0 + 26.0 = 36.0
        // col_w = (300.0 - 10.0) / 2.0 = 145.0
        // First item row 0, col 0 at ax = 10.0, ay = 36.0
        let bx = 10.0 + 50.0;
        let by = 36.0 + 20.0;

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
            out.contains(&WindowAction::Button("action:shoot".into())),
            "Expected action:shoot action, got {:?}",
            out
        );
    }
}
