//! INVENTORY — held-stack grid + examine sidebar with Use/Equip/Drop actions.
//!
//! Reads `WindowModel::inventory` (live `InventoryModel` projection: wire
//! `GameInventoryRow`s, reservation holds, wallet credits, wielded weapon).
//! The grid shows held (non-exchange) stacks; exchange stockpile rows belong
//! to the datapad DATA tab. Examine selection is window-local UI state keyed
//! by `(container, stack_id)` — it is NOT part of the projected model, so a
//! connected frame rebuild can never carry stale selection. Action payloads
//! carry `InventoryRow::item_id`.

use super::{WindowAction, WindowModel, ACCENT, DIM, SLOT, SLOT_EDGE, TEXT};
use crate::hud::Icons;
use core::cell::RefCell;
use successor_engine_render::ui::{ButtonStyle, UiBuilder};

thread_local! {
    /// Window-local examine selection `(container, stack_id)`. Interim home
    /// until the shared `WindowUiState` threading lands (see `windows::mod`).
    static SELECTED: RefCell<Option<(String, String)>> = const { RefCell::new(None) };
}

pub fn draw(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    model: &WindowModel,
    icons: &Icons,
    out: &mut Vec<WindowAction>,
) {
    let [x, y, w, h] = rect;
    let inv = &model.inventory;

    // Split: grid on the left ~62%, examine sidebar on the right.
    let side_w = (w * 0.34).clamp(150.0, 260.0);
    let grid_w = w - side_w - 8.0;

    // ── Held-stack grid ──────────────────────────────────────────────────
    let cell = 52.0;
    let gap = 6.0;
    let cols = (((grid_w + gap) / (cell + gap)).floor() as usize).max(1);
    let mut held_count = 0usize;
    for (i, row) in inv.held().enumerate() {
        held_count += 1;
        let c = i % cols;
        let r = i / cols;
        let sx = x + c as f32 * (cell + gap);
        let sy = y + r as f32 * (cell + gap);
        if sy + cell > y + h - 24.0 {
            break; // clip to content height (row of the footer)
        }
        let resp = ui.interact(sx, sy, cell, cell);
        let selected = SELECTED.with(|s| {
            s.borrow()
                .as_ref()
                .is_some_and(|(cont, id)| *cont == row.container && *id == row.stack_id)
        });
        let fill = if selected {
            [46, 62, 86, 235]
        } else if resp.hovered {
            [36, 48, 64, 230]
        } else {
            SLOT
        };
        ui.rect(sx, sy, cell, cell, fill);
        ui.border(
            sx,
            sy,
            cell,
            cell,
            if selected { 1.5 } else { 1.0 },
            if selected { ACCENT } else { SLOT_EDGE },
        );
        if let Some((col, irow)) = icons.cell(row.kind().icon()) {
            ui.icon(
                col,
                irow,
                sx + 8.0,
                sy + 6.0,
                cell - 16.0,
                cell - 20.0,
                TEXT,
            );
        }
        if row.quantity > 1 {
            let q = format!("{}", row.quantity);
            let px = 1.5;
            let qw = UiBuilder::text_width(&q, px);
            ui.text(
                &q,
                sx + cell - qw - 3.0,
                sy + cell - 7.0 * px - 2.0,
                px,
                TEXT,
            );
        }
        if row.equipped {
            ui.rect(sx + cell - 8.0, sy + 3.0, 5.0, 5.0, ACCENT);
        }
        if row.reserved > 0 {
            // Pending-hold marker (visible reservation against this stack).
            ui.rect(sx + 3.0, sy + 3.0, 5.0, 5.0, [214, 138, 62, 255]);
        }
        if resp.clicked {
            SELECTED.with(|s| {
                *s.borrow_mut() = Some((row.container.clone(), row.stack_id.clone()));
            });
            out.push(WindowAction::Select(row.item_id));
        }
    }

    // ── Footer: stack/reservation tally + wallet credits ─────────────────
    let fy = y + h - 18.0;
    let tally = if inv.reservations.is_empty() {
        format!("{} STACKS", held_count)
    } else {
        format!(
            "{} STACKS · {} RESERVED",
            held_count,
            inv.reservations.len()
        )
    };
    ui.text(&tally, x, fy, 2.0, DIM);
    let cr = format!("CR {}", inv.credits);
    ui.text(
        &cr,
        x + grid_w - UiBuilder::text_width(&cr, 2.0),
        fy,
        2.0,
        ACCENT,
    );

    // ── Examine sidebar ──────────────────────────────────────────────────
    let sx = x + grid_w + 8.0;
    ui.rect(sx, y, side_w, h, [10, 14, 20, 210]);
    ui.border(sx, y, side_w, h, 1.0, SLOT_EDGE);
    let sel = SELECTED.with(|s| s.borrow().clone());
    let sel = sel
        .as_ref()
        .and_then(|(cont, id)| inv.row(cont, id))
        .filter(|r| !r.in_exchange());
    match sel {
        Some(row) => {
            if let Some((col, irow)) = icons.cell(row.kind().icon()) {
                ui.icon(
                    col,
                    irow,
                    sx + side_w * 0.5 - 24.0,
                    y + 10.0,
                    48.0,
                    48.0,
                    TEXT,
                );
            }
            ui.text(&row.item, sx + 8.0, y + 66.0, 2.2, ACCENT);
            ui.text(
                &format!("QTY {}", row.quantity),
                sx + 8.0,
                y + 92.0,
                2.0,
                TEXT,
            );
            if row.reserved > 0 {
                ui.text(
                    &format!("AVAIL {}", row.available),
                    sx + 8.0,
                    y + 112.0,
                    1.8,
                    [214, 138, 62, 255],
                );
            }
            let kind = format!("{:?}", row.kind()).to_uppercase();
            ui.text(&kind, sx + 8.0, y + 132.0, 2.0, DIM);
            let mut dy = y + 152.0;
            if let Some(pot) = row.potency {
                ui.text(&format!("POTENCY {}", pot), sx + 8.0, dy, 1.8, TEXT);
                dy += 18.0;
            }
            if let Some(pur) = row.purity {
                ui.text(&format!("PURITY {}", pur), sx + 8.0, dy, 1.8, TEXT);
            }

            let bw = side_w - 16.0;
            let bs = ButtonStyle::default();
            let by = y + h - 176.0;
            if ui.button(sx + 8.0, by, bw, 24.0, "USE", bs) {
                let command = if row.is_credit_chip() {
                    successor_net::ClientCommand::RedeemCreditChip {
                        container: row.container.clone(),
                        stack_id: row.stack_id.clone(),
                    }
                } else if row.kind() == super::ItemKind::Ammo {
                    successor_net::ClientCommand::RefillAmmo {
                        item_id: row
                            .item_key
                            .clone()
                            .unwrap_or_else(|| row.item_id.to_string()),
                    }
                } else {
                    successor_net::ClientCommand::UseConsumable {
                        item_id: row
                            .item_key
                            .clone()
                            .unwrap_or_else(|| row.item_id.to_string()),
                        item_numeric_id: Some(row.item_id),
                        variant_id: Some(row.variant_id),
                    }
                };
                out.push(WindowAction::Command(command));
            }
            let eq = if row.equipped { "UNEQUIP" } else { "EQUIP" };
            if ui.button(sx + 8.0, by + 29.0, bw, 24.0, eq, bs) {
                let command = if row.kind() == super::ItemKind::Gear {
                    successor_net::ClientCommand::SetEquippedClothing {
                        item_id: row.item_id,
                        equipped: !row.equipped,
                        container: Some(row.container.clone()),
                        stack_id: Some(row.stack_id.clone()),
                        variant_id: Some(row.variant_id),
                    }
                } else {
                    successor_net::ClientCommand::SetEquippedWeapon {
                        weapon_id: None,
                        weapon_item_id: (!row.equipped).then_some(row.item_id),
                        weapon_variant_id: (!row.equipped).then_some(row.variant_id),
                    }
                };
                out.push(WindowAction::Command(command));
            }
            if ui.button(sx + 8.0, by + 58.0, bw, 24.0, "DROP", bs) {
                out.push(WindowAction::Command(
                    successor_net::ClientCommand::DiscardStack {
                        container: row.container.clone(),
                        stack_id: row.stack_id.clone(),
                        item_id: row.item_id,
                        variant_id: row.variant_id,
                    },
                ));
            }
            if row.available > 1 && ui.button(sx + 8.0, by + 87.0, bw, 24.0, "SPLIT HALF", bs) {
                out.push(WindowAction::Command(
                    successor_net::ClientCommand::SplitStack {
                        container: row.container.clone(),
                        stack_id: row.stack_id.clone(),
                        item_id: row.item_id,
                        variant_id: row.variant_id,
                        quantity: (row.available / 2).max(1) as u32,
                    },
                ));
            }
            if let Some(target) = inv.held().find(|other| {
                other.stack_id != row.stack_id
                    && other.container == row.container
                    && other.item_id == row.item_id
                    && other.variant_id == row.variant_id
            }) {
                if ui.button(sx + 8.0, by + 116.0, bw, 24.0, "MERGE", bs) {
                    out.push(WindowAction::Command(
                        successor_net::ClientCommand::MergeStacks {
                            container: row.container.clone(),
                            source_stack_id: row.stack_id.clone(),
                            target_stack_id: target.stack_id.clone(),
                        },
                    ));
                }
            }
            if row.available > 0 && ui.button(sx + 8.0, by + 145.0, bw, 24.0, "STORE", bs) {
                out.push(WindowAction::Command(
                    successor_net::ClientCommand::StoreToExchange {
                        item_id: row.item_id,
                        variant_id: row.variant_id,
                        quantity: row.available as u32,
                    },
                ));
            }
        }
        None => {
            ui.text("NO ITEM", sx + 8.0, y + 12.0, 2.0, DIM);
            if let Some(weapon) = &inv.weapon_label {
                ui.text("WIELDING", sx + 8.0, y + 40.0, 1.8, DIM);
                ui.text(weapon, sx + 8.0, y + 58.0, 2.0, TEXT);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::windows::model::{InventoryRow, EXCHANGE_CONTAINER};

    /// Explicit test fixture — `WindowModel::sample()` is intentionally empty
    /// so demo/test state can never masquerade as a live projection.
    fn fixture() -> WindowModel {
        let mut m = WindowModel::sample();
        m.inventory.credits = 250;
        m.inventory.rows = vec![
            InventoryRow {
                container: "player".into(),
                stack_id: "1".into(),
                item: "Field Stim".into(),
                item_id: 11,
                quantity: 3,
                available: 3,
                ..Default::default()
            },
            InventoryRow {
                container: "player".into(),
                stack_id: "2".into(),
                item: "Slugthrower Pistol".into(),
                item_id: 12,
                quantity: 1,
                available: 1,
                equipped: true,
                ..Default::default()
            },
            InventoryRow {
                container: EXCHANGE_CONTAINER.into(),
                stack_id: "9".into(),
                item: "Copper Ore".into(),
                item_id: 13,
                quantity: 40,
                available: 40,
                ..Default::default()
            },
        ];
        m
    }

    /// Grid geometry for rect [100,100,600,400]: side_w = clamp(204,150,260)
    /// = 204, grid_w = 388, cell 52 gap 6 ⇒ cols 6. Cell i sits at
    /// (100 + (i%6)*58, 100 + (i/6)*58).
    const RECT: [f32; 4] = [100.0, 100.0, 600.0, 400.0];

    fn click(
        ui: &mut UiBuilder,
        model: &WindowModel,
        icons: &Icons,
        cx: f32,
        cy: f32,
    ) -> Vec<WindowAction> {
        ui.set_input(cx, cy, true);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(ui, RECT, model, icons, &mut out);
        ui.set_input(cx, cy, false);
        ui.begin(1280, 720);
        out.clear();
        draw(ui, RECT, model, icons, &mut out);
        out
    }

    #[test]
    fn click_selects_then_use_emits_typed_stack_command() {
        let icons = Icons::load();
        let model = fixture();
        let mut ui = UiBuilder::new(icons.meta);
        // Select the first held stack (Field Stim, item_id 11).
        let out = click(&mut ui, &model, &icons, 126.0, 126.0);
        assert!(
            out.contains(&WindowAction::Select(11)),
            "clicking slot 0 selects the stack, got {out:?}"
        );
        // USE button: sidebar x = 496, by = 100+400-176 = 324.
        let out = click(&mut ui, &model, &icons, 524.0, 336.0);
        assert!(
            out.contains(&WindowAction::Command(
                successor_net::ClientCommand::UseConsumable {
                    item_id: "11".into(),
                    item_numeric_id: Some(11),
                    variant_id: Some(0),
                }
            )),
            "USE emits the complete typed stack command, got {out:?}"
        );
    }

    #[test]
    fn exchange_rows_stay_out_of_the_grid() {
        let icons = Icons::load();
        let model = fixture();
        let mut ui = UiBuilder::new(icons.meta);
        // Two held rows ⇒ grid index 2 (x=216..268) is empty; the exchange
        // stack must not occupy it.
        let out = click(&mut ui, &model, &icons, 242.0, 126.0);
        assert!(
            out.is_empty(),
            "exchange stockpile row must not render in the held grid, got {out:?}"
        );
    }

    #[test]
    fn empty_model_renders_without_actions() {
        let icons = Icons::load();
        let model = WindowModel::sample();
        let mut ui = UiBuilder::new(icons.meta);
        let out = click(&mut ui, &model, &icons, 126.0, 126.0);
        assert!(
            out.is_empty(),
            "empty projection emits nothing, got {out:?}"
        );
    }
}
