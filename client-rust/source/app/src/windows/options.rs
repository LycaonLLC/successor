//! OPTIONS — sliders (master/music volume) + toggles (fullscreen, invert-Y…).

use super::model::OptionKind;
use super::{WindowAction, WindowModel, ACCENT, DIM, SLOT, SLOT_EDGE, TEXT};
use crate::hud::Icons;
use successor_engine_render::ui::UiBuilder;

pub fn draw(ui: &mut UiBuilder, rect: [f32; 4], model: &WindowModel, _icons: &Icons, out: &mut Vec<WindowAction>) {
    let [x, y, w, _h] = rect;
    let ctrl_x = x + 220.0;
    let ctrl_w = (w - 230.0).max(80.0);
    for (i, row) in model.options.rows.iter().enumerate() {
        let ry = y + i as f32 * 38.0;
        ui.text(&row.label, x, ry + 4.0, 2.0, TEXT);
        match row.kind {
            OptionKind::Slider(v) => {
                // Track + fill + knob.
                let ty = ry + 8.0;
                ui.rect(ctrl_x, ty, ctrl_w, 8.0, SLOT);
                ui.rect(ctrl_x, ty, ctrl_w * v.clamp(0.0, 1.0), 8.0, [120, 170, 220, 235]);
                let kx = ctrl_x + ctrl_w * v.clamp(0.0, 1.0) - 5.0;
                ui.rect(kx, ty - 4.0, 10.0, 16.0, ACCENT);
                ui.border(ctrl_x, ty, ctrl_w, 8.0, 1.0, SLOT_EDGE);
                ui.text(&format!("{}", (v * 100.0) as i32), ctrl_x + ctrl_w + 8.0, ry + 4.0, 1.8, DIM);
                // Drag/click on the track sets a new value.
                let resp = ui.interact(ctrl_x, ty - 4.0, ctrl_w, 16.0);
                if resp.held {
                    let (mx, _) = ui.mouse();
                    let nv = ((mx - ctrl_x) / ctrl_w).clamp(0.0, 1.0);
                    out.push(WindowAction::Button(format!("opt:{}={:.2}", row.label, nv)));
                }
            }
            OptionKind::Toggle(on) => {
                let bw = 54.0;
                let bx = ctrl_x;
                let fill = if on { [70, 150, 96, 235] } else { SLOT };
                ui.rect(bx, ry, bw, 22.0, fill);
                ui.border(bx, ry, bw, 22.0, 1.0, SLOT_EDGE);
                let lbl = if on { "ON" } else { "OFF" };
                ui.text(lbl, bx + 8.0, ry + 4.0, 1.8, TEXT);
                let resp = ui.interact(bx, ry, bw, 22.0);
                if resp.clicked {
                    out.push(WindowAction::Toggle(row.label.clone()));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toggle_click_emits_toggle() {
        let icons = Icons::load();
        let model = WindowModel::sample();
        let mut ui = UiBuilder::new(icons.meta);
        // FULLSCREEN is row index 2 (toggle): ry = y + 2*38 = y+76. rect y=100.
        // ctrl_x = x+220 = 320. toggle at (320, 176) size 54x22.
        ui.set_input(340.0, 186.0, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, [100.0, 100.0, 500.0, 400.0], &model, &icons, &mut out);
        ui.set_input(340.0, 186.0, false);
        ui.begin(1280, 720);
        out.clear();
        draw(&mut ui, [100.0, 100.0, 500.0, 400.0], &model, &icons, &mut out);
        assert_eq!(out, vec![WindowAction::Toggle("FULLSCREEN".into())]);
    }

    #[test]
    fn slider_drag_emits_value() {
        let icons = Icons::load();
        let model = WindowModel::sample();
        let mut ui = UiBuilder::new(icons.meta);
        // MASTER VOLUME row 0: ry=100, track y=108. Click mid-track.
        // ctrl_x=320, ctrl_w=500-230=270. mid = 320+135.
        ui.set_input(320.0 + 135.0, 110.0, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, [100.0, 100.0, 500.0, 400.0], &model, &icons, &mut out);
        assert!(out.iter().any(|a| matches!(a, WindowAction::Button(s) if s.starts_with("opt:MASTER VOLUME="))), "slider emits value, got {out:?}");
    }
}
