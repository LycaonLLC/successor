//! BANK — Kiosk-style bank vault content view.
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
pub struct BankModel {
    pub wallet_credits: u32,
    pub vault_credits: u32,
    pub inventory_items: Vec<ItemStack>,
    pub vault_items: Vec<ItemStack>,
}

impl BankModel {
    pub fn sample() -> Self {
        Self {
            wallet_credits: 1280,
            vault_credits: 5000,
            inventory_items: vec![
                ItemStack { id: 1, name: "SLUGTHROWER".into(), kind: "item-weapon".into(), qty: 1 },
                ItemStack { id: 2, name: "RIFLE AMMO".into(), kind: "item-ammo".into(), qty: 240 },
            ],
            vault_items: vec![
                ItemStack { id: 3, name: "MEDKIT".into(), kind: "item-medical".into(), qty: 10 },
                ItemStack { id: 4, name: "SCRAP ALLOY".into(), kind: "item-resource".into(), qty: 500 },
            ],
        }
    }
}

pub fn draw(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    model: &BankModel,
    icons: &Icons,
    out: &mut Vec<WindowAction>,
) {
    let [x, y, w, h] = rect;

    // Credits balance line at the top
    let cy = y + 8.0;
    let credits_text = format!("WALLET: {} CR  |  VAULT: {} CR", model.wallet_credits, model.vault_credits);
    ui.text(&credits_text, x + 8.0, cy, 2.0, ACCENT);

    // Columns calculations
    let col_y = y + 32.0;
    let col_w = (w - 24.0) / 2.0;
    let col_mine_x = x + 8.0;
    let col_vault_x = x + 16.0 + col_w;

    // Column Headers
    ui.text("INVENTORY", col_mine_x, col_y, 1.8, DIM);
    ui.text("VAULT", col_vault_x, col_y, 1.8, DIM);

    // ── Left Column: Inventory ──
    let mut iy = col_y + 20.0;
    if model.inventory_items.is_empty() {
        ui.text("NO ITEMS", col_mine_x + 4.0, iy, 1.6, DIM);
    } else {
        for item in &model.inventory_items {
            if iy + 30.0 > y + h - 10.0 {
                break;
            }
            ui.rect(col_mine_x, iy, col_w, 28.0, SLOT);
            ui.border(col_mine_x, iy, col_w, 28.0, 1.0, SLOT_EDGE);

            if let Some((col, row)) = icons.cell(&item.kind) {
                ui.icon(col, row, col_mine_x + 4.0, iy + 4.0, 20.0, 20.0, TEXT);
            }

            let label = if item.qty > 1 {
                format!("{} x{}", item.name, item.qty)
            } else {
                item.name.clone()
            };
            ui.text(&label, col_mine_x + 28.0, iy + 6.0, 1.6, TEXT);

            // DEPOSIT button
            let btn_w = 40.0;
            let btn_x = col_mine_x + col_w - btn_w - 4.0;
            let btn_y = iy + 3.0;
            if ui.button(btn_x, btn_y, btn_w, 22.0, "DEP", ButtonStyle::default()) {
                out.push(WindowAction::Deposit(item.id, item.qty));
            }

            iy += 32.0;
        }
    }

    // ── Right Column: Vault ──
    let mut vy = col_y + 20.0;
    if model.vault_items.is_empty() {
        ui.text("VAULT EMPTY", col_vault_x + 4.0, vy, 1.6, DIM);
    } else {
        for item in &model.vault_items {
            if vy + 30.0 > y + h - 10.0 {
                break;
            }
            ui.rect(col_vault_x, vy, col_w, 28.0, SLOT);
            ui.border(col_vault_x, vy, col_w, 28.0, 1.0, SLOT_EDGE);

            if let Some((col, row)) = icons.cell(&item.kind) {
                ui.icon(col, row, col_vault_x + 4.0, vy + 4.0, 20.0, 20.0, TEXT);
            }

            let label = if item.qty > 1 {
                format!("{} x{}", item.name, item.qty)
            } else {
                item.name.clone()
            };
            ui.text(&label, col_vault_x + 28.0, vy + 6.0, 1.6, TEXT);

            // WITHDRAW button
            let btn_w = 40.0;
            let btn_x = col_vault_x + col_w - btn_w - 4.0;
            let btn_y = vy + 3.0;
            if ui.button(btn_x, btn_y, btn_w, 22.0, "WDR", ButtonStyle::default()) {
                out.push(WindowAction::Withdraw(item.id, item.qty));
            }

            vy += 32.0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bank_deposit_button_emits_action() {
        let icons = Icons::load();
        let model = BankModel::sample();
        let mut ui = UiBuilder::new(icons.meta);

        // Rect = [100.0, 100.0, 500.0, 300.0]
        // col_w = (500 - 24) / 2 = 238.
        // col_mine_x = 100 + 8 = 108.
        // First item iy = 100 + 32 + 20 = 152.
        // DEP button at btn_x = col_mine_x + col_w - btn_w - 4 = 108 + 238 - 40 - 4 = 302.
        // btn_y = 152 + 3 = 155.
        // Center is roughly 322, 166.
        let bx = 322.0;
        let by = 166.0;

        ui.set_input(bx, by, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, [100.0, 100.0, 500.0, 300.0], &model, &icons, &mut out);

        ui.set_input(bx, by, false);
        ui.begin(1280, 720);
        out.clear();
        draw(&mut ui, [100.0, 100.0, 500.0, 300.0], &model, &icons, &mut out);

        assert_eq!(out, vec![WindowAction::Deposit(1, 1)]);
    }

    #[test]
    fn bank_withdraw_button_emits_action() {
        let icons = Icons::load();
        let model = BankModel::sample();
        let mut ui = UiBuilder::new(icons.meta);

        // Rect = [100.0, 100.0, 500.0, 300.0]
        // col_w = (500 - 24) / 2 = 238.
        // col_vault_x = 100 + 16 + 238 = 354.
        // First item vy = 100 + 32 + 20 = 152.
        // WDR button at btn_x = col_vault_x + col_w - btn_w - 4 = 354 + 238 - 40 - 4 = 548.
        // btn_y = 152 + 3 = 155.
        // Center is roughly 568, 166.
        let bx = 568.0;
        let by = 166.0;

        ui.set_input(bx, by, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, [100.0, 100.0, 500.0, 300.0], &model, &icons, &mut out);

        ui.set_input(bx, by, false);
        ui.begin(1280, 720);
        out.clear();
        draw(&mut ui, [100.0, 100.0, 500.0, 300.0], &model, &icons, &mut out);

        assert_eq!(out, vec![WindowAction::Withdraw(3, 10)]);
    }
}
