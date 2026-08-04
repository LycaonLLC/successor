use std::cell::Cell;

use crate::windows::chrome::{self, Rows};
use crate::windows::live::shared::*;
use crate::windows::spec::Metrics;
use crate::windows::{Ctx, WindowAction, WindowModel};
use successor_engine_render::ui::UiBuilder;
use successor_net::ClientCommand;

thread_local! {
    static BANK_STEP_AMOUNT: Cell<u64> = const { Cell::new(100) };
}

pub fn bank(ui: &mut UiBuilder, ctx: Ctx, model: &WindowModel, out: &mut Vec<WindowAction>) {
    let mut pane = Pane::open(ctx);
    if !model.bank.gate.available {
        let note = if model.bank.gate.note.is_empty() {
            "AT BANK TERMINAL ONLY"
        } else {
            &model.bank.gate.note
        };
        pane.denied(ui, note);
        return;
    }
    let Some(bank) = &model.bank.bank else {
        pane.empty(ui, "BANK STATE UNAVAILABLE");
        return;
    };
    pane.field_pair(
        ui,
        ("WALLET", &format!("{} CR", model.inventory.credits)),
        ("VAULT", &format!("{} CR", bank.credits)),
    );
    let cur_amt = BANK_STEP_AMOUNT.with(|cell| cell.get());
    if let Some(index) = pane.rail(
        ui,
        &[
            &format!("DEPOSIT {cur_amt} CR"),
            &format!("WITHDRAW {cur_amt} CR"),
        ],
    ) {
        if index == 0 {
            let deposit_max = model.inventory.credits.max(0) as u64;
            let amount = cur_amt.min(deposit_max);
            if amount > 0 {
                out.push(WindowAction::Command(ClientCommand::BankDepositCredits {
                    amount,
                }));
            }
        } else {
            let withdraw_max = bank.credits.max(0) as u64;
            let amount = cur_amt.min(withdraw_max);
            if amount > 0 {
                out.push(WindowAction::Command(ClientCommand::BankWithdrawCredits {
                    amount,
                }));
            }
        }
    }
    if let Some(index) = pane.rail(ui, &["STEP 100", "STEP 1,000", "STEP 10,000", "MAX WALLET"]) {
        let new_amt = match index {
            0 => 100,
            1 => 1_000,
            2 => 10_000,
            3 => model.inventory.credits.max(0) as u64,
            _ => 100,
        };
        BANK_STEP_AMOUNT.with(|cell| cell.set(new_amt.max(1)));
    }
    let backup = pane.reserve_footer();
    let mut any = false;
    if ctx.tab == 0 {
        pane.section(ui, "CARRIED INVENTORY");
        let mut rows = pane.rows();
        for row in model.inventory.held() {
            any = true;
            let Some(mut list) = rows.next(ui) else { break };
            if row.available > 0 && list.action(ui, "STORE") {
                out.push(WindowAction::Command(ClientCommand::BankStoreItem {
                    source_stack_id: row.stack_id.clone(),
                    quantity: row.available as u32,
                }));
            }
            list.value(ui, &qty(row.available));
            list.label(ui, &row.item);
        }
        if !any {
            chrome::empty(ui, pane.x, rows.cursor(), "NOTHING HELD");
        }
    } else {
        pane.section(ui, "VAULT ITEMS");
        let mut rows = pane.rows();
        for row in &bank.items {
            any = true;
            let Some(mut list) = rows.next(ui) else { break };
            if row.quantity > 0 && list.action(ui, "RETRIEVE") {
                out.push(WindowAction::Command(ClientCommand::BankRetrieveItem {
                    bank_stack_id: row.stack_id.clone(),
                    quantity: row.quantity as u32,
                }));
            }
            list.value(ui, &qty(row.quantity));
            list.label(ui, &row.item);
        }
        if !any {
            chrome::empty(ui, pane.x, rows.cursor(), "VAULT EMPTY");
        }
    }
    if pane
        .footer(ui, backup, &["SAVE CLONE SKILL BACKUP"])
        .is_some()
    {
        out.push(WindowAction::Command(
            ClientCommand::CloneSaveSkillBackup {},
        ));
    }
}

/// District exchange holdings. Drawn as the datapad's DATA pane, so it opens on
/// a section rule and inherits the datapad's metrics rather than resolving a
/// surface of its own.
pub fn exchange(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    metrics: Metrics,
    model: &WindowModel,
    out: &mut Vec<WindowAction>,
) {
    let [x, y, w, h] = rect;
    let w = w.max(0.0);
    let top = chrome::section(ui, x, y, w, "EXCHANGE", metrics);
    let mut rows = Rows::new([x, top, w, (y + h - top).max(0.0)], metrics);
    let mut any = false;
    for row in model.inventory.exchange().take(10) {
        any = true;
        let Some(mut list) = rows.next(ui) else { break };
        if row.quantity > 0 && list.action(ui, "RETRIEVE") {
            out.push(WindowAction::Command(ClientCommand::RetrieveFromExchange {
                item_id: row.item_id,
                variant_id: row.variant_id,
                quantity: row.quantity as u32,
            }));
        }
        list.value(ui, &qty(row.quantity));
        list.label(ui, &row.item);
    }
    if !any {
        chrome::empty(ui, x, rows.cursor(), "EXCHANGE EMPTY");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hud::Icons;
    use crate::windows::model::{BankSnapshot, Gate, InventoryRow};

    fn test_ctx(rect: [f32; 4], tab: usize) -> Ctx {
        Ctx {
            spec: crate::windows::spec::surface("bank").expect("bank surface"),
            rect,
            tab,
        }
    }

    const RECT: [f32; 4] = [100.0, 100.0, 400.0, 500.0];

    #[test]
    fn test_bank_denied_when_gate_closed() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let mut model = WindowModel::default();
        model.bank.gate = Gate::closed("AT BANK TERMINAL ONLY");

        let ctx = test_ctx(RECT, 0);
        let mut out = Vec::new();
        bank(&mut ui, ctx, &model, &mut out);

        assert!(out.is_empty());
    }

    #[test]
    fn test_bank_empty_when_no_snapshot() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let mut model = WindowModel::default();
        model.bank.gate = Gate::open("bank_terminal_1");
        model.bank.bank = None;

        let ctx = test_ctx(RECT, 0);
        let mut out = Vec::new();
        bank(&mut ui, ctx, &model, &mut out);

        assert!(out.is_empty());
    }

    #[test]
    fn test_bank_deposit_withdraw_store_retrieve() {
        let icons = Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let mut model = WindowModel::default();
        model.bank.gate = Gate::open("bank_terminal_1");
        model.inventory.credits = 5000;
        model.inventory.rows = vec![InventoryRow {
            container: "inventory".to_string(),
            stack_id: "inv_1".to_string(),
            item: "HEAVY AMMO".to_string(),
            quantity: 50,
            available: 50,
            ..Default::default()
        }];
        model.bank.bank = Some(BankSnapshot {
            credits: 2000,
            items: vec![InventoryRow {
                container: "bank".to_string(),
                stack_id: "bank_1".to_string(),
                item: "MEDKIT".to_string(),
                quantity: 10,
                available: 10,
                ..Default::default()
            }],
            ..Default::default()
        });

        // Press DEPOSIT button on tab 0
        let ctx = test_ctx(RECT, 0);
        let bx = RECT[0] + 10.0;
        let by = RECT[1] + 30.0;
        ui.set_input(bx, by, true);
        ui.begin(1280, 900);
        let mut out = Vec::new();
        bank(&mut ui, ctx, &model, &mut out);

        ui.set_input(bx, by, false);
        ui.begin(1280, 900);
        out.clear();
        bank(&mut ui, ctx, &model, &mut out);

        assert!(out.contains(&WindowAction::Command(ClientCommand::BankDepositCredits {
            amount: 100
        })));

        // Test tab 1 retrieve
        let ctx_tab1 = test_ctx(RECT, 1);
        ui.begin(1280, 900);
        out.clear();
        bank(&mut ui, ctx_tab1, &model, &mut out);
    }
}
