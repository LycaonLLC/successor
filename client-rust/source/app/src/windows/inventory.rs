//! INVENTORY — held-stack grid + examine sidebar with Use/Equip/Drop actions.
//!
//! Reads `WindowModel::inventory` (live `InventoryModel` projection: wire
//! `GameInventoryRow`s, reservation holds, wallet credits, wielded weapon).
//! The grid shows held (non-exchange) stacks; exchange stockpile rows belong
//! to the datapad DATA tab. Selection is window-local UI state keyed by
//! `(container, stack_id)` and is joined back into the live examine projection.
//! Action payloads carry `InventoryRow::item_id`.

use super::{WindowAction, WindowModel, ACCENT, DIM, SLOT_EDGE, TEXT};
use crate::hud::Icons;
use core::cell::{Cell, RefCell};
use successor_engine_render::ui::{ButtonStyle, UiBuilder};

thread_local! {
    /// Window-local examine selection `(container, stack_id)`. Interim home
    /// until the shared `WindowUiState` threading lands (see `windows::mod`).
    static SELECTED: RefCell<Option<(String, String)>> = const { RefCell::new(None) };
    static PAGE: Cell<usize> = const { Cell::new(0) };
}

#[derive(Clone, Copy, Debug)]
pub struct InventoryLayout {
    pub grid: [f32; 4],
    pub preview: [f32; 4],
    pub detail: [f32; 4],
}
const GRID_COLUMNS: usize = 3;
const GRID_GAP: f32 = 5.0;

/// Shared inventory geometry used by both the UI and the render-to-texture
/// paperdoll compositor.
pub fn layout(rect: [f32; 4]) -> InventoryLayout {
    let [x, y, w, h] = rect;
    let gap = 10.0;
    let preview_w = (h * 0.60).min((w - 300.0).max(220.0));
    let right_x = x + preview_w + gap;
    let right_w = w - preview_w - gap;
    let detail_h = (h * 0.32).clamp(145.0, 180.0);
    InventoryLayout {
        grid: [right_x, y, right_w, h - detail_h - gap],
        preview: [x, y, preview_w, h],
        detail: [right_x, y + h - detail_h, right_w, detail_h],
    }
}
/// Visible card bounds for a held-stack index. The 3D preview compositor uses
/// this exact geometry, so models and hit targets cannot drift apart.
pub fn grid_card_rect(rect: [f32; 4], index: usize) -> Option<[f32; 4]> {
    let [gx, gy, gw, gh] = layout(rect).grid;
    let card_size = (gw - GRID_GAP * (GRID_COLUMNS as f32 + 1.0)) / GRID_COLUMNS as f32;
    let col = index % GRID_COLUMNS;
    let line = index / GRID_COLUMNS;
    let sx = gx + GRID_GAP + col as f32 * (card_size + GRID_GAP);
    let sy = gy + GRID_GAP + line as f32 * (card_size + GRID_GAP);
    (sy + card_size <= gy + gh - 24.0).then_some([sx, sy, card_size, card_size])
}

pub fn grid_capacity(rect: [f32; 4]) -> usize {
    let mut count = 0;
    while grid_card_rect(rect, count).is_some() {
        count += 1;
    }
    count
}

/// Held-stack indices visible on the current inventory page.
pub fn visible_held_range(rect: [f32; 4], held_count: usize) -> (usize, usize) {
    let capacity = grid_capacity(rect).max(1);
    let last_page = held_count.saturating_sub(1) / capacity;
    let page = PAGE.with(|page| {
        let clamped = page.get().min(last_page);
        page.set(clamped);
        clamped
    });
    let start = page * capacity;
    (start, (start + capacity).min(held_count))
}

fn set_page(page: usize) {
    PAGE.with(|current| current.set(page));
}

pub fn selected_identity() -> Option<(String, String)> {
    SELECTED.with(|selected| selected.borrow().clone())
}

pub fn selected_row(model: &WindowModel) -> Option<&super::InventoryRow> {
    let (container, stack_id) = selected_identity()?;
    model
        .inventory
        .row(&container, &stack_id)
        .filter(|row| !row.in_exchange())
}

pub fn draw(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    model: &WindowModel,
    _icons: &Icons,
    out: &mut Vec<WindowAction>,
) {
    let inv = &model.inventory;
    let panes = layout(rect);
    let [gx, gy, gw, gh] = panes.grid;
    let [px, py, pw, ph] = panes.preview;
    let [dx, dy, dw, dh] = panes.detail;

    ui.rect(gx, gy, gw, gh, [3, 8, 9, 12]);

    let held_count = inv.held().count();
    let (visible_start, visible_end) = visible_held_range(rect, held_count);
    for (index, row) in inv
        .held()
        .skip(visible_start)
        .take(visible_end - visible_start)
        .enumerate()
    {
        let Some([sx, sy, card_w, card_h]) = grid_card_rect(rect, index) else {
            break;
        };
        let resp = ui.interact(sx, sy, card_w, card_h);
        let selected = SELECTED.with(|selection| {
            selection
                .borrow()
                .as_ref()
                .is_some_and(|(container, stack_id)| {
                    *container == row.container && *stack_id == row.stack_id
                })
        });
        let fill = if selected {
            [12, 39, 44, 110]
        } else if resp.hovered {
            [10, 24, 27, 80]
        } else {
            [4, 10, 11, 42]
        };
        ui.rect(sx, sy, card_w, card_h, fill);
        ui.border(
            sx,
            sy,
            card_w,
            card_h,
            1.0,
            if selected { ACCENT } else { SLOT_EDGE },
        );

        ui.text(kind_label(row.kind()), sx + 5.0, sy + 4.0, 1.05, DIM);
        let max_chars = ((card_w - 8.0) / UiBuilder::text_width("M", 1.2))
            .floor()
            .max(1.0) as usize;
        let (label, clipped) = char_prefix(&row.item, max_chars.saturating_sub(2));
        ui.text(label, sx + 4.0, sy + card_h - 25.0, 1.2, TEXT);
        if clipped {
            ui.text(
                "..",
                sx + 4.0 + UiBuilder::text_width(label, 1.2),
                sy + card_h - 25.0,
                1.2,
                DIM,
            );
        }
        let quantity = format!("{}", row.quantity);
        ui.text(
            &quantity,
            sx + card_w - UiBuilder::text_width(&quantity, 1.35) - 4.0,
            sy + card_h - 12.0,
            1.35,
            TEXT,
        );
        if row.equipped {
            ui.rect(sx + 3.0, sy + card_h - 5.0, card_w - 6.0, 2.0, ACCENT);
        }
        if row.reserved > 0 {
            ui.rect(sx + card_w - 7.0, sy + 4.0, 4.0, 4.0, [214, 138, 62, 255]);
        }
        if resp.clicked {
            SELECTED.with(|selection| {
                *selection.borrow_mut() = Some((row.container.clone(), row.stack_id.clone()));
            });
            out.push(WindowAction::Select(row.item_id));
        }
    }
    let tally = if held_count == 0 {
        "0 STACKS".to_string()
    } else {
        format!("{}-{} / {}", visible_start + 1, visible_end, held_count)
    };
    ui.text(&tally, gx + 6.0, gy + gh - 17.0, 1.25, DIM);
    let capacity = grid_capacity(rect).max(1);
    let page = visible_start / capacity;
    let page_count = held_count.saturating_sub(1) / capacity + 1;
    if page_count > 1 {
        let nav = ButtonStyle::default();
        let nav_y = gy + gh - 21.0;
        let center_x = gx + gw * 0.5;
        if ui.button(center_x - 55.0, nav_y, 42.0, 18.0, "PREV", nav) && page > 0 {
            set_page(page - 1);
        }
        ui.text(
            &format!("{}/{}", page + 1, page_count),
            center_x - 8.0,
            gy + gh - 17.0,
            1.15,
            DIM,
        );
        if ui.button(center_x + 18.0, nav_y, 42.0, 18.0, "NEXT", nav) && page + 1 < page_count {
            set_page(page + 1);
        }
    }
    let credits = format!("CR {}", inv.credits);
    ui.text(
        &credits,
        gx + gw - UiBuilder::text_width(&credits, 1.25) - 6.0,
        gy + gh - 17.0,
        1.25,
        ACCENT,
    );

    // The renderer composites the live character target behind this pane.
    ui.rect(px, py, pw, ph, [4, 10, 10, 18]);

    ui.rect(dx, dy, dw, dh, [7, 14, 15, 232]);

    let selection = SELECTED.with(|selected| selected.borrow().clone());
    let selected = selection
        .as_ref()
        .and_then(|(container, stack_id)| inv.row(container, stack_id))
        .filter(|row| !row.in_exchange());
    match selected {
        Some(row) => {
            ui.text(&row.item, dx + 8.0, dy + 8.0, 1.8, TEXT);
            let meta = format!("{} · QTY {}", kind_label(row.kind()), row.quantity);
            ui.text(&meta, dx + 8.0, dy + 30.0, 1.25, DIM);
            let mut info_y = dy + 48.0;
            if let Some(potency) = row.potency {
                ui.text(&format!("POTENCY {}", potency), dx + 8.0, info_y, 1.2, TEXT);
                info_y += 15.0;
            }
            if let Some(purity) = row.purity {
                ui.text(&format!("PURITY {}", purity), dx + 8.0, info_y, 1.2, TEXT);
            }
            let button_gap = 5.0;
            let button_w = (dw - 16.0 - button_gap) * 0.5;
            let button_y = dy + dh - 76.0;
            let button = ButtonStyle::default();
            if ui.button(dx + 6.0, button_y, button_w, 21.0, "USE", button) {
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
            let equip = if row.equipped { "UNEQUIP" } else { "EQUIP" };
            if ui.button(
                dx + 6.0 + button_w + button_gap,
                button_y,
                button_w,
                21.0,
                equip,
                button,
            ) {
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
            if ui.button(dx + 6.0, button_y + 26.0, button_w, 21.0, "DROP", button) {
                out.push(WindowAction::Command(
                    successor_net::ClientCommand::DiscardStack {
                        container: row.container.clone(),
                        stack_id: row.stack_id.clone(),
                        item_id: row.item_id,
                        variant_id: row.variant_id,
                    },
                ));
            }
            if row.available > 1
                && ui.button(
                    dx + 6.0 + button_w + button_gap,
                    button_y + 26.0,
                    button_w,
                    21.0,
                    "SPLIT",
                    button,
                )
            {
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
                if ui.button(dx + 6.0, button_y + 52.0, button_w, 21.0, "MERGE", button) {
                    out.push(WindowAction::Command(
                        successor_net::ClientCommand::MergeStacks {
                            container: row.container.clone(),
                            source_stack_id: row.stack_id.clone(),
                            target_stack_id: target.stack_id.clone(),
                        },
                    ));
                }
            }
            if row.available > 0
                && ui.button(
                    dx + 6.0 + button_w + button_gap,
                    button_y + 52.0,
                    button_w,
                    21.0,
                    "STORE",
                    button,
                )
            {
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
            ui.text("SELECT AN ITEM", dx + 8.0, dy + 10.0, 1.35, DIM);
            if let Some(weapon) = &inv.weapon_label {
                ui.text("WIELDING", dx + 8.0, dy + 36.0, 1.15, DIM);
                ui.text(weapon, dx + 8.0, dy + 52.0, 1.35, TEXT);
            }
        }
    }
}

fn kind_label(kind: super::ItemKind) -> &'static str {
    match kind {
        super::ItemKind::Weapon => "WPN",
        super::ItemKind::Ammo => "AMMO",
        super::ItemKind::Medical => "MED",
        super::ItemKind::Resource => "RES",
        super::ItemKind::Tool => "TOOL",
        super::ItemKind::Gear => "GEAR",
        super::ItemKind::Currency => "CR",
        super::ItemKind::Item => "ITEM",
    }
}

fn char_prefix(text: &str, max_chars: usize) -> (&str, bool) {
    match text.char_indices().nth(max_chars) {
        Some((byte, _)) => (&text[..byte], true),
        None => (text, false),
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

    /// Fixed test surface. Layout yields a 372px grid, three 117.3px cards,
    /// and a 220px preview/detail column.
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
        let [x, y, w, h] = grid_card_rect(RECT, 0).expect("first grid card");
        let out = click(&mut ui, &model, &icons, x + w * 0.5, y + h * 0.5);
        assert!(
            out.contains(&WindowAction::Select(11)),
            "clicking slot 0 selects the stack, got {out:?}"
        );
        let [dx, dy, dw, dh] = layout(RECT).detail;
        let button_w = (dw - 21.0) * 0.5;
        let button_y = dy + dh - 76.0;
        let out = click(
            &mut ui,
            &model,
            &icons,
            dx + 6.0 + button_w * 0.5,
            button_y + 10.5,
        );
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
        // Two held rows occupy columns 0 and 1; column 2 is empty. Exchange
        // stock must not leak into that third card.
        let [x, y, w, h] = grid_card_rect(RECT, 2).expect("third grid card");
        let out = click(&mut ui, &model, &icons, x + w * 0.5, y + h * 0.5);
        assert!(
            out.is_empty(),
            "exchange stockpile row must not render in the held grid, got {out:?}"
        );
    }

    #[test]
    fn approved_weapon_item_ids_classify_as_weapons() {
        for (item_id, item) in [
            (3101, "Slugthrower"),
            (3103, "Vibrosword"),
            (3104, "Plasma Sword"),
            (3105, "Scrapline Machete"),
            (3106, "Field Saber"),
            (3107, "Quarry Chopper"),
            (3111, "STEN Mk II"),
            (3112, "Kiln Energy Cell Carbine"),
            (3121, "Lightning Carbine"),
            (3122, "Badge Bolt Pistol"),
            (3123, "Slagrail Vanguard"),
            (3124, "Coilgate Scatter"),
            (3125, "Kiln Long Pattern"),
            (3126, "Bastion LMG"),
            (3127, "Flare Net Launcher"),
        ] {
            let row = InventoryRow {
                item_id,
                item: item.into(),
                ..Default::default()
            };
            assert_eq!(row.kind(), crate::windows::ItemKind::Weapon, "{item_id}");
        }
    }

    #[test]
    fn last_weapon_page_equips_its_concrete_item_id() {
        let icons = Icons::load();
        let mut model = WindowModel::sample();
        let weapon_ids = [
            3101, 3103, 3104, 3105, 3106, 3107, 3111, 3112, 3121, 3122, 3123, 3124, 3125, 3126,
            3127,
        ];
        model.inventory.rows = weapon_ids
            .iter()
            .enumerate()
            .map(|(index, item_id)| InventoryRow {
                container: "player:field-pack".into(),
                stack_id: format!("weapon-{index}"),
                item: format!("Weapon {item_id}"),
                item_id: *item_id,
                quantity: 1,
                available: 1,
                ..Default::default()
            })
            .collect();
        let capacity = grid_capacity(RECT);
        let target_index = weapon_ids.len() - 1;
        set_page(target_index / capacity);
        let local_index = target_index % capacity;
        let [x, y, w, h] = grid_card_rect(RECT, local_index).expect("target grid card");
        let mut ui = UiBuilder::new(icons.meta.clone());
        let selected = click(&mut ui, &model, &icons, x + w * 0.5, y + h * 0.5);
        assert!(selected.contains(&WindowAction::Select(3127)));

        let [dx, dy, dw, dh] = layout(RECT).detail;
        let button_gap = 5.0;
        let button_w = (dw - 16.0 - button_gap) * 0.5;
        let button_y = dy + dh - 76.0;
        let equipped = click(
            &mut ui,
            &model,
            &icons,
            dx + 6.0 + button_w + button_gap + button_w * 0.5,
            button_y + 10.5,
        );
        assert!(equipped.contains(&WindowAction::Command(
            successor_net::ClientCommand::SetEquippedWeapon {
                weapon_id: None,
                weapon_item_id: Some(3127),
                weapon_variant_id: Some(0),
            }
        )));
        set_page(0);
    }

    #[test]
    fn pagination_exposes_every_held_stack() {
        set_page(0);
        let capacity = grid_capacity(RECT);
        assert!(capacity > 0);
        let held_count = capacity + 2;
        assert_eq!(visible_held_range(RECT, held_count), (0, capacity));
        set_page(1);
        assert_eq!(visible_held_range(RECT, held_count), (capacity, held_count));
        set_page(usize::MAX);
        assert_eq!(
            visible_held_range(RECT, held_count),
            (capacity, held_count),
            "page clamps after inventory changes"
        );
        set_page(0);
    }

    #[test]
    fn empty_model_renders_without_actions() {
        let icons = Icons::load();
        let model = WindowModel::sample();
        let mut ui = UiBuilder::new(icons.meta);
        let [x, y, w, h] = grid_card_rect(RECT, 0).expect("first grid card");
        let out = click(&mut ui, &model, &icons, x + w * 0.5, y + h * 0.5);
        assert!(
            out.is_empty(),
            "empty projection emits nothing, got {out:?}"
        );
    }
}
