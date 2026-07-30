//! CHARACTER — read-only sheet + the one action: profession-title select.

use super::{WindowAction, WindowModel, ACCENT, DIM, SLOT, SLOT_EDGE, TEXT};
use crate::hud::Icons;
use successor_engine_render::ui::{ButtonStyle, UiBuilder};

fn bar(ui: &mut UiBuilder, x: f32, y: f32, w: f32, frac: f32, fill: [u8; 4], label: &str) {
    ui.rect(x, y, w, 16.0, SLOT);
    if frac > 0.0 {
        ui.rect(x, y, w * frac.clamp(0.0, 1.0), 16.0, fill);
    }
    ui.border(x, y, w, 16.0, 1.0, SLOT_EDGE);
    ui.text(label, x + 4.0, y + 2.0, 1.6, TEXT);
}

pub fn draw(ui: &mut UiBuilder, rect: [f32; 4], model: &WindowModel, _icons: &Icons, out: &mut Vec<WindowAction>) {
    let [x, y, w, _h] = rect;
    let c = &model.character;

    ui.text(&c.name, x, y, 3.0, ACCENT);
    ui.text(&format!("TITLE  {}", c.title), x, y + 30.0, 2.0, DIM);

    // Vitals.
    let bw = w - 4.0;
    bar(ui, x, y + 58.0, bw, c.health / c.health_max.max(1.0), [196, 72, 68, 235],
        &format!("HEALTH {}/{}", c.health as i32, c.health_max as i32));
    bar(ui, x, y + 80.0, bw, c.action / c.action_max.max(1.0), [86, 156, 210, 235],
        &format!("ACTION {}/{}", c.action as i32, c.action_max as i32));

    // Ledger.
    ui.text(&format!("ARMOR   {}", c.armor), x, y + 108.0, 2.0, TEXT);
    ui.text(&format!("CREDITS {}", c.credits), x, y + 130.0, 2.0, ACCENT);

    // Professions.
    ui.text("PROFESSIONS", x, y + 160.0, 2.0, DIM);
    for (i, p) in c.professions.iter().enumerate() {
        let py = y + 184.0 + i as f32 * 22.0;
        ui.text(&p.label, x + 8.0, py, 1.8, TEXT);
        ui.text(&format!("LV {}", p.level), x + 180.0, py, 1.8, ACCENT);
    }

    // Title selector — the sole action.
    let ty = y + 184.0 + c.professions.len() as f32 * 22.0 + 16.0;
    ui.text("SET TITLE", x, ty, 2.0, DIM);
    let bs = ButtonStyle::default();
    let bw2 = ((w - 16.0) / c.title_options.len().max(1) as f32).min(150.0);
    for (i, opt) in c.title_options.iter().enumerate() {
        let bx = x + i as f32 * (bw2 + 6.0);
        let mut style = bs;
        if *opt == c.title {
            style.fill = [70, 92, 120, 240];
        }
        if ui.button(bx, ty + 22.0, bw2, 26.0, opt, style) {
            out.push(WindowAction::SetProfessionTitle(opt.clone()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_button_emits_set_title() {
        let icons = Icons::load();
        let model = WindowModel::sample();
        let mut ui = UiBuilder::new(icons.meta);
        // Title buttons row: ty = y + 184 + 3*22 + 16 = y+266; buttons at ty+22.
        // rect [100,100,600,700] → ty=100+266=366, button y=388. First button x=100.
        let bx = 100.0 + 60.0;
        let by = 388.0 + 12.0;
        ui.set_input(bx, by, true);
        ui.begin(1280, 900);
        let mut out = Vec::new();
        draw(&mut ui, [100.0, 100.0, 600.0, 700.0], &model, &icons, &mut out);
        ui.set_input(bx, by, false);
        ui.begin(1280, 900);
        out.clear();
        draw(&mut ui, [100.0, 100.0, 600.0, 700.0], &model, &icons, &mut out);
        assert!(
            matches!(out.first(), Some(WindowAction::SetProfessionTitle(t)) if t == "MARKSMAN"),
            "first title selected, got {out:?}"
        );
    }
}
