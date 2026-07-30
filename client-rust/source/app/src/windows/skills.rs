//! SKILLS — progression nodes with rank + progress bar; locked nodes dimmed.

use super::{WindowAction, WindowModel, ACCENT, DIM, SLOT, SLOT_EDGE, TEXT};
use crate::hud::Icons;
use successor_engine_render::ui::UiBuilder;

pub fn draw(ui: &mut UiBuilder, rect: [f32; 4], model: &WindowModel, icons: &Icons, out: &mut Vec<WindowAction>) {
    let [x, y, w, _h] = rect;
    for (i, node) in model.skills.nodes.iter().enumerate() {
        let ny = y + i as f32 * 40.0;
        let text_col = if node.locked { DIM } else { TEXT };
        // Lock glyph for locked nodes.
        if node.locked {
            if let Some((c, r)) = icons.cell("lock") {
                ui.icon(c, r, x, ny, 18.0, 18.0, DIM);
            }
        }
        ui.text(&node.label, x + 22.0, ny, 2.0, text_col);
        ui.text(&format!("R{}", node.rank), x + 22.0, ny + 20.0, 1.6, ACCENT);

        // Progress bar.
        let bx = x + 180.0;
        let bw = (w - 190.0).max(60.0);
        ui.rect(bx, ny + 2.0, bw, 14.0, SLOT);
        if !node.locked && node.progress > 0.0 {
            ui.rect(bx, ny + 2.0, bw * node.progress.clamp(0.0, 1.0), 14.0, [120, 170, 220, 235]);
        }
        ui.border(bx, ny + 2.0, bw, 14.0, 1.0, SLOT_EDGE);
        let pct = format!("{}%", (node.progress * 100.0) as i32);
        ui.text(&pct, bx + bw + 6.0, ny + 2.0, 1.6, text_col);

        // Clicking an unlocked node emits a generic inspect action.
        let resp = ui.interact(x, ny, w, 34.0);
        if resp.clicked && !node.locked {
            out.push(WindowAction::Button(format!("skill:{}", node.label)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clicking_unlocked_node_emits_inspect() {
        let icons = Icons::load();
        let model = WindowModel::sample();
        let mut ui = UiBuilder::new(icons.meta);
        // First node row at y=100 (rect y=100). Click within row.
        ui.set_input(150.0, 108.0, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, [100.0, 100.0, 500.0, 400.0], &model, &icons, &mut out);
        ui.set_input(150.0, 108.0, false);
        ui.begin(1280, 720);
        out.clear();
        draw(&mut ui, [100.0, 100.0, 500.0, 400.0], &model, &icons, &mut out);
        assert_eq!(out, vec![WindowAction::Button("skill:RIFLES".into())]);
    }

    #[test]
    fn locked_node_ignores_click() {
        let icons = Icons::load();
        let model = WindowModel::sample();
        let mut ui = UiBuilder::new(icons.meta);
        // PILOTING is index 4 (locked): row y = 100 + 4*40 = 260.
        ui.set_input(150.0, 268.0, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, [100.0, 100.0, 500.0, 400.0], &model, &icons, &mut out);
        ui.set_input(150.0, 268.0, false);
        ui.begin(1280, 720);
        out.clear();
        draw(&mut ui, [100.0, 100.0, 500.0, 400.0], &model, &icons, &mut out);
        assert!(out.is_empty(), "locked node emits nothing, got {out:?}");
    }
}
