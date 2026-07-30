//! INVENTORY — item grid + examine sidebar with Use/Equip/Drop actions.

use super::{WindowAction, WindowModel, ACCENT, DIM, SLOT, SLOT_EDGE, TEXT};
use crate::hud::Icons;
use successor_engine_render::ui::{ButtonStyle, UiBuilder};

pub fn draw(ui: &mut UiBuilder, rect: [f32; 4], model: &WindowModel, icons: &Icons, out: &mut Vec<WindowAction>) {
    let [x, y, w, h] = rect;
    let inv = &model.inventory;

    // Split: grid on the left ~62%, examine sidebar on the right.
    let side_w = (w * 0.34).clamp(150.0, 260.0);
    let grid_w = w - side_w - 8.0;

    // ── Item grid ────────────────────────────────────────────────────────
    let cell = 52.0;
    let gap = 6.0;
    let cols = (((grid_w + gap) / (cell + gap)).floor() as usize).max(1);
    for (i, item) in inv.items.iter().enumerate() {
        let c = i % cols;
        let r = i / cols;
        let sx = x + c as f32 * (cell + gap);
        let sy = y + r as f32 * (cell + gap);
        if sy + cell > y + h - 24.0 {
            break; // clip to content height (row of the footer)
        }
        let resp = ui.interact(sx, sy, cell, cell);
        let selected = inv.selected == Some(item.id);
        let fill = if selected { [46, 62, 86, 235] } else if resp.hovered { [36, 48, 64, 230] } else { SLOT };
        ui.rect(sx, sy, cell, cell, fill);
        ui.border(sx, sy, cell, cell, if selected { 1.5 } else { 1.0 }, if selected { ACCENT } else { SLOT_EDGE });
        if let Some((col, row)) = icons.cell(item.kind.icon()) {
            ui.icon(col, row, sx + 8.0, sy + 6.0, cell - 16.0, cell - 20.0, TEXT);
        }
        if item.qty > 1 {
            let q = format!("{}", item.qty);
            let px = 1.5;
            let qw = UiBuilder::text_width(&q, px);
            ui.text(&q, sx + cell - qw - 3.0, sy + cell - 7.0 * px - 2.0, px, TEXT);
        }
        if item.equipped {
            ui.rect(sx + cell - 8.0, sy + 3.0, 5.0, 5.0, ACCENT);
        }
        if resp.clicked {
            out.push(WindowAction::Select(item.id));
        }
    }

    // ── Footer: capacity + credits ───────────────────────────────────────
    let fy = y + h - 18.0;
    ui.text(&format!("{}/{}", inv.items.len(), inv.capacity), x, fy, 2.0, DIM);
    let cr = format!("CR {}", inv.credits);
    ui.text(&cr, x + grid_w - UiBuilder::text_width(&cr, 2.0), fy, 2.0, ACCENT);

    // ── Examine sidebar ──────────────────────────────────────────────────
    let sx = x + grid_w + 8.0;
    ui.rect(sx, y, side_w, h, [10, 14, 20, 210]);
    ui.border(sx, y, side_w, h, 1.0, SLOT_EDGE);
    let sel = inv.selected.and_then(|id| inv.items.iter().find(|it| it.id == id));
    match sel {
        Some(item) => {
            if let Some((col, row)) = icons.cell(item.kind.icon()) {
                ui.icon(col, row, sx + side_w * 0.5 - 24.0, y + 10.0, 48.0, 48.0, TEXT);
            }
            ui.text(&item.name, sx + 8.0, y + 66.0, 2.2, ACCENT);
            ui.text(&format!("QTY {}", item.qty), sx + 8.0, y + 92.0, 2.0, TEXT);
            let kind = format!("{:?}", item.kind).to_uppercase();
            ui.text(&kind, sx + 8.0, y + 114.0, 2.0, DIM);

            let bw = side_w - 16.0;
            let bs = ButtonStyle::default();
            let by = y + h - 108.0;
            if ui.button(sx + 8.0, by, bw, 28.0, "USE", bs) {
                out.push(WindowAction::UseItem(item.id));
            }
            let eq = if item.equipped { "UNEQUIP" } else { "EQUIP" };
            if ui.button(sx + 8.0, by + 34.0, bw, 28.0, eq, bs) {
                out.push(WindowAction::EquipItem(item.id));
            }
            if ui.button(sx + 8.0, by + 68.0, bw, 28.0, "DROP", bs) {
                out.push(WindowAction::DropItem(item.id));
            }
        }
        None => {
            ui.text("NO ITEM", sx + 8.0, y + 12.0, 2.0, DIM);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn use_button_emits_action_for_selected() {
        let icons = Icons::load();
        let model = WindowModel::sample();
        let mut ui = UiBuilder::new(icons.meta);
        // Click the USE button: sidebar sits at right; button 'by = y+h-108'.
        // rect = [x=100,y=100,w=600,h=400]; side_w=clamp(600*.34=204)=204;
        // grid_w=600-204-8=388; sx=100+388+8=496; by=100+400-108=392.
        let bx = 496.0 + 8.0;
        let by = 392.0;
        ui.set_input(bx + 20.0, by + 14.0, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, [100.0, 100.0, 600.0, 400.0], &model, &icons, &mut out);
        ui.set_input(bx + 20.0, by + 14.0, false);
        ui.begin(1280, 720);
        out.clear();
        draw(&mut ui, [100.0, 100.0, 600.0, 400.0], &model, &icons, &mut out);
        assert!(out.contains(&WindowAction::UseItem(1)), "USE emitted for selected item, got {out:?}");
    }

    #[test]
    fn clicking_slot_selects_that_item() {
        let icons = Icons::load();
        let model = WindowModel::sample();
        let inv = &model.inventory;
        // Pick a grid item that is NOT the pre-selected one — proving a click can
        // move the selection off the seeded item (the reported bug).
        let (idx, item) = inv
            .items
            .iter()
            .enumerate()
            .find(|(_, it)| Some(it.id) != inv.selected)
            .expect("sample inventory needs a non-selected item");
        let want = item.id;
        // Grid geometry for rect [100,100,600,400]: cell 52, gap 6, cols 6.
        let cols = 6usize;
        let (c, r) = (idx % cols, idx / cols);
        let cx = 100.0 + c as f32 * 58.0 + 26.0;
        let cy = 100.0 + r as f32 * 58.0 + 26.0;
        let mut ui = UiBuilder::new(icons.meta);
        ui.set_input(cx, cy, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, [100.0, 100.0, 600.0, 400.0], &model, &icons, &mut out);
        ui.set_input(cx, cy, false);
        ui.begin(1280, 720);
        out.clear();
        draw(&mut ui, [100.0, 100.0, 600.0, 400.0], &model, &icons, &mut out);
        assert!(
            out.contains(&WindowAction::Select(want)),
            "clicking slot {idx} should Select item {want}, got {out:?}"
        );
    }
}
