//! INVENTORY — held-stack grid + examine sidebar with Use/Equip/Drop actions.
//!
//! Reads `WindowModel::inventory` (live `InventoryModel` projection: wire
//! `GameInventoryRow`s, reservation holds, wallet credits, wielded weapon).
//! The grid shows held (non-exchange) stacks; exchange stockpile rows belong
//! to the datapad DATA tab. Selection is window-local UI state keyed by
//! `(container, stack_id)` and is joined back into the live examine projection.
//! Action payloads carry `InventoryRow::item_id`.

use super::{WindowAction, WindowModel, ACCENT, DIM, TEXT};
use crate::hud::Icons;
use core::cell::{Cell, RefCell};
use successor_engine_render::ui::{ButtonStyle, UiBuilder};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InventoryView {
    IconGrid,
    CompactList,
}

thread_local! {
    /// Window-local examine selection `(container, stack_id)`. Interim home
    /// until the shared `WindowUiState` threading lands (see `windows::mod`).
    static SELECTED: RefCell<Option<(String, String)>> = const { RefCell::new(None) };
    static GRID_PAGE: Cell<usize> = const { Cell::new(0) };
    static LIST_PAGE: Cell<usize> = const { Cell::new(0) };
    static VIEW: Cell<InventoryView> = const { Cell::new(InventoryView::IconGrid) };
}

#[derive(Clone, Copy, Debug)]
pub struct InventoryLayout {
    pub grid: [f32; 4],
    /// One shallow footer region shared by the doll, status, and item actions.
    pub footer: [f32; 4],
    /// Small aspect-correct live player doll retained in the lower-left rail.
    pub preview: [f32; 4],
    pub detail: [f32; 4],
}

const GRID_GAP: f32 = 4.0;
/// Original volume-page cell is 48x48 (`swg-ui-game` layout contract).
const GRID_CARD_MIN: f32 = 48.0;
const GRID_LABEL_H: f32 = 14.0;
const GRID_MIN_COLUMNS: usize = 3;
const GRID_MAX_COLUMNS: usize = 12;
const GRID_STATUS_H: f32 = 22.0;
const SCROLLBAR_CHANNEL_W: f32 = 10.0;
const LIST_ROW_H: f32 = 25.0;
const LIST_ROW_GAP: f32 = 2.0;
const USAGE_SEGMENTS: usize = 8;

fn current_view() -> InventoryView {
    VIEW.with(|view| view.get())
}

fn set_view(view: InventoryView) {
    VIEW.with(|current| current.set(view));
}

fn toggle_view() {
    set_view(match current_view() {
        InventoryView::IconGrid => InventoryView::CompactList,
        InventoryView::CompactList => InventoryView::IconGrid,
    });
}

fn current_page() -> usize {
    match current_view() {
        InventoryView::IconGrid => GRID_PAGE.with(|page| page.get()),
        InventoryView::CompactList => LIST_PAGE.with(|page| page.get()),
    }
}

/// SWG inventory geometry: the item field owns the window; the live character
/// doll and selected-stack actions share one shallow footer.
pub fn layout(rect: [f32; 4]) -> InventoryLayout {
    let [x, y, w, h] = rect;
    let gap = 7.0;
    let footer_h = (h * 0.23).clamp(86.0, 100.0).min((h - 120.0).max(72.0));
    let footer_y = y + h - footer_h;
    let preview_h = (footer_h - 8.0).min(80.0);
    let preview_w = preview_h * 0.6;
    let preview_x = x + 6.0;
    let detail_x = preview_x + preview_w + 8.0;
    InventoryLayout {
        grid: [x, y, w, h - footer_h - gap],
        footer: [x, footer_y, w, footer_h],
        preview: [
            preview_x,
            footer_y + (footer_h - preview_h) * 0.5,
            preview_w,
            preview_h,
        ],
        detail: [detail_x, footer_y, x + w - detail_x, footer_h],
    }
}

/// The always-visible scrollbar occupies this edge lane, not a phantom item
/// slot. Both views therefore report the capacity that is actually drawable.
fn item_well(rect: [f32; 4]) -> [f32; 4] {
    let [x, y, w, h] = layout(rect).grid;
    [x, y, (w - SCROLLBAR_CHANNEL_W).max(0.0), h]
}

fn grid_columns(rect: [f32; 4]) -> usize {
    let width = item_well(rect)[2];
    (((width - GRID_GAP) / (GRID_CARD_MIN + GRID_GAP)).floor() as usize)
        .clamp(GRID_MIN_COLUMNS, GRID_MAX_COLUMNS)
}

fn icon_grid_card_rect(rect: [f32; 4], index: usize) -> Option<[f32; 4]> {
    let [grid_x, grid_y, grid_w, grid_h] = item_well(rect);
    let columns = grid_columns(rect);
    let card_size = (grid_w - GRID_GAP * (columns as f32 + 1.0)) / columns as f32;
    let column = index % columns;
    let row = index / columns;
    let x = grid_x + GRID_GAP + column as f32 * (card_size + GRID_GAP);
    let y = grid_y + GRID_GAP + row as f32 * (card_size + GRID_LABEL_H + GRID_GAP);
    let height = card_size + GRID_LABEL_H;
    (y + height <= grid_y + grid_h - GRID_STATUS_H).then_some([x, y, card_size, height])
}

fn compact_list_row_rect(rect: [f32; 4], index: usize) -> Option<[f32; 4]> {
    let [grid_x, grid_y, grid_w, grid_h] = item_well(rect);
    let y = grid_y + GRID_GAP + index as f32 * (LIST_ROW_H + LIST_ROW_GAP);
    (y + LIST_ROW_H <= grid_y + grid_h - GRID_STATUS_H).then_some([
        grid_x + GRID_GAP,
        y,
        (grid_w - GRID_GAP * 2.0).max(0.0),
        LIST_ROW_H,
    ])
}

/// Visible item bounds for a page-local held-stack index in the active view.
/// The name remains stable because the live radial and item-preview hosts use
/// this shared hit geometry.
pub fn grid_card_rect(rect: [f32; 4], index: usize) -> Option<[f32; 4]> {
    match current_view() {
        InventoryView::IconGrid => icon_grid_card_rect(rect, index),
        InventoryView::CompactList => compact_list_row_rect(rect, index),
    }
}

/// Exact square occupied by a live item model. Compact rows use atlas glyphs,
/// so they deliberately deactivate the separate 3D preview lanes.
pub fn grid_preview_rect(rect: [f32; 4], index: usize) -> Option<[f32; 4]> {
    if current_view() != InventoryView::IconGrid {
        return None;
    }
    let [x, y, width, _] = icon_grid_card_rect(rect, index)?;
    Some([x + 2.0, y + 2.0, width - 4.0, width - 4.0])
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
    let page = current_page().min(last_page);
    set_page(page);
    let start = page * capacity;
    (start, (start + capacity).min(held_count))
}

fn set_page(page: usize) {
    match current_view() {
        InventoryView::IconGrid => GRID_PAGE.with(|current| current.set(page)),
        InventoryView::CompactList => LIST_PAGE.with(|current| current.set(page)),
    }
}

pub fn selected_identity() -> Option<(String, String)> {
    SELECTED.with(|selected| selected.borrow().clone())
}

/// Make `(container, stack_id)` the live selection. The host calls this when a
/// pointer gesture outside the window picks a stack (the right-click radial
/// route), so the footer and the radial always address the same object.
pub fn select_identity(container: &str, stack_id: &str) {
    SELECTED.with(|selected| {
        *selected.borrow_mut() = Some((container.to_string(), stack_id.to_string()));
    });
}

/// Clear the live selection (the picked stack left the projection).
pub fn clear_selection() {
    SELECTED.with(|selected| *selected.borrow_mut() = None);
}

pub fn selected_row(model: &WindowModel) -> Option<&super::InventoryRow> {
    let (container, stack_id) = selected_identity()?;
    model
        .inventory
        .row(&container, &stack_id)
        .filter(|row| !row.in_exchange())
}

#[derive(Clone, Copy, Debug)]
struct FooterLayout {
    info: [f32; 4],
    actions: [f32; 4],
    change_view: [f32; 4],
}

fn footer_layout(rect: [f32; 4]) -> FooterLayout {
    let [detail_x, detail_y, detail_w, detail_h] = layout(rect).detail;
    let side = 6.0;
    // The action lane owns the right edge. It contracts before the summary
    // lane, so its controls cannot cover finance or the view switch at resize.
    let desired_action_w = (detail_w * 0.39).clamp(116.0, 210.0);
    let action_w = desired_action_w.min((detail_w - side * 3.0 - 80.0).max(0.0));
    let action_x = detail_x + detail_w - side - action_w;
    let info_x = detail_x + side;
    let info_w = (action_x - info_x - side).max(0.0);
    let change_w = info_w.min(88.0);
    FooterLayout {
        info: [info_x, detail_y + 5.0, info_w, (detail_h - 10.0).max(0.0)],
        actions: [
            action_x,
            detail_y + 6.0,
            action_w,
            (detail_h - 12.0).max(0.0),
        ],
        change_view: [info_x + info_w - change_w, detail_y + 4.0, change_w, 18.0],
    }
}

fn action_button_rects(footer: FooterLayout) -> [[f32; 4]; 6] {
    let [x, y, width, height] = footer.actions;
    let gap = 4.0;
    let button_w = ((width - gap) * 0.5).max(0.0);
    let button_h = ((height - gap * 2.0) / 3.0).clamp(0.0, 19.0);
    [
        [x, y, button_w, button_h],
        [x + button_w + gap, y, button_w, button_h],
        [x, y + button_h + gap, button_w, button_h],
        [x + button_w + gap, y + button_h + gap, button_w, button_h],
        [x, y + (button_h + gap) * 2.0, button_w, button_h],
        [
            x + button_w + gap,
            y + (button_h + gap) * 2.0,
            button_w,
            button_h,
        ],
    ]
}

fn reveal_selected_stack(rect: [f32; 4], model: &WindowModel) {
    let Some((container, stack_id)) = selected_identity() else {
        return;
    };
    let Some(index) = model
        .inventory
        .held()
        .position(|row| row.container == container && row.stack_id == stack_id)
    else {
        return;
    };
    set_page(index / grid_capacity(rect).max(1));
}

fn draw_scrollbar(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    held_count: usize,
    capacity: usize,
    page: usize,
    page_count: usize,
) {
    let [grid_x, grid_y, grid_w, grid_h] = layout(rect).grid;
    let channel_x = grid_x + grid_w - SCROLLBAR_CHANNEL_W;
    let track_y = grid_y + 3.0;
    let track_h = (grid_h - GRID_STATUS_H - 6.0).max(0.0);
    ui.rect(
        channel_x,
        grid_y + 1.0,
        SCROLLBAR_CHANNEL_W,
        track_h + 4.0,
        [0x00, 0x28, 0x30, 235],
    );
    ui.rect(
        channel_x,
        grid_y + 1.0,
        1.0,
        track_h + 4.0,
        super::chrome::RAIL,
    );
    if track_h <= 0.0 {
        return;
    }
    let viewport_fraction = capacity as f32 / held_count.max(capacity) as f32;
    let min_thumb_h = track_h.min(12.0);
    let thumb_h = if held_count == 0 {
        track_h
    } else {
        (track_h * viewport_fraction).clamp(min_thumb_h, track_h)
    };
    let page_fraction = if page_count > 1 {
        page as f32 / (page_count - 1) as f32
    } else {
        0.0
    };
    let thumb_y = track_y + (track_h - thumb_h).max(0.0) * page_fraction;
    ui.rect(
        channel_x + 3.0,
        thumb_y,
        (SCROLLBAR_CHANNEL_W - 5.0).max(0.0),
        thumb_h,
        ACCENT,
    );
}

fn draw_segmented_usage_meter(
    ui: &mut UiBuilder,
    x: f32,
    y: f32,
    width: f32,
    occupied: usize,
    capacity: usize,
) {
    if width <= 0.0 {
        return;
    }
    let gap = (width / (USAGE_SEGMENTS as f32 * 2.0)).min(2.0);
    let segment_w = ((width - gap * (USAGE_SEGMENTS - 1) as f32) / USAGE_SEGMENTS as f32).max(0.0);
    let filled = if capacity == 0 {
        0
    } else {
        ((occupied as f32 / capacity as f32) * USAGE_SEGMENTS as f32).ceil() as usize
    };
    for index in 0..USAGE_SEGMENTS {
        ui.rect(
            x + index as f32 * (segment_w + gap),
            y,
            segment_w,
            4.0,
            if index < filled {
                ACCENT
            } else {
                [0x00, 0x28, 0x30, 235]
            },
        );
    }
}

fn draw_page_navigation(ui: &mut UiBuilder, grid: [f32; 4], page: usize, page_count: usize) {
    if page_count <= 1 {
        return;
    }
    let [grid_x, grid_y, grid_w, grid_h] = grid;
    let button_w = 42.0;
    let gap = 4.0;
    let nav_x = grid_x + (grid_w - button_w * 2.0 - gap) * 0.5;
    let nav_y = grid_y + grid_h - GRID_STATUS_H + 2.0;
    let nav = ButtonStyle::default();
    if ui.button(nav_x, nav_y, button_w, 18.0, "PREV", nav) && page > 0 {
        set_page(page - 1);
    }
    if ui.button(nav_x + button_w + gap, nav_y, button_w, 18.0, "NEXT", nav)
        && page + 1 < page_count
    {
        set_page(page + 1);
    }
}
pub fn draw(
    ui: &mut UiBuilder,
    rect: [f32; 4],
    model: &WindowModel,
    icons: &Icons,
    out: &mut Vec<WindowAction>,
) {
    let inv = &model.inventory;
    let panes = layout(rect);
    let [gx, gy, gw, gh] = panes.grid;
    let [px, py, pw, ph] = panes.preview;
    let view = current_view();

    // One true content region: the item field. Fill plus a single top hairline,
    // never a box around the grid and never a box per cell.
    super::chrome::region(ui, [gx, gy, gw, gh]);

    let held_count = inv.held().count();
    let capacity = grid_capacity(rect).max(1);
    let (visible_start, visible_end) = visible_held_range(rect, held_count);
    let page = visible_start / capacity;
    let page_count = if held_count == 0 {
        0
    } else {
        held_count.saturating_sub(1) / capacity + 1
    };
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
        // Original item fields stay open: only hover/selection paints a hit
        // target. Unselected stacks share the single inventory well.
        if selected {
            ui.rect(sx, sy, card_w, card_h, super::chrome::SELECTED);
        } else if resp.hovered {
            ui.rect(sx, sy, card_w, card_h, super::chrome::HOVER);
        }
        if selected {
            match view {
                InventoryView::IconGrid => {
                    ui.rect(sx, sy + card_h - 2.0, card_w, 2.0, ACCENT);
                }
                InventoryView::CompactList => {
                    ui.rect(sx + 1.0, sy + 2.0, 2.0, (card_h - 4.0).max(0.0), ACCENT);
                }
            }
        }

        let kind = row.kind();
        match view {
            InventoryView::IconGrid => {
                ui.text(kind_label(kind), sx + 4.0, sy + 3.0, 1.0, DIM);
                if let Some((column, glyph_row)) = icons.cell(kind.icon()) {
                    let icon_size = (card_w * 0.36)
                        .clamp(14.0, 28.0)
                        .min((card_w - 20.0).max(0.0));
                    let icon_top = sy + 15.0;
                    let icon_bottom = sy + card_w - 17.0;
                    ui.icon(
                        column,
                        glyph_row,
                        sx + (card_w - icon_size) * 0.5,
                        icon_top + ((icon_bottom - icon_top - icon_size) * 0.5).max(0.0),
                        icon_size,
                        icon_size,
                        TEXT,
                    );
                }
                super::chrome::text_clipped(
                    ui,
                    &row.item,
                    sx + 3.0,
                    sy + card_w + 3.0,
                    1.05,
                    (card_w - 6.0).max(0.0),
                    TEXT,
                );
                let quantity = row.quantity.to_string();
                ui.text(
                    &quantity,
                    sx + card_w - ui.measure_text(&quantity, 1.2) - 3.0,
                    sy + card_w - 12.0,
                    1.2,
                    TEXT,
                );
                if row.equipped {
                    ui.rect(sx + 3.0, sy + card_w - 4.0, card_w - 6.0, 2.0, ACCENT);
                }
                if row.reserved > 0 {
                    ui.rect(sx + card_w - 7.0, sy + 4.0, 4.0, 4.0, [214, 138, 62, 255]);
                }
            }
            InventoryView::CompactList => {
                let icon_size = (card_h - 6.0).clamp(0.0, 18.0);
                if let Some((column, glyph_row)) = icons.cell(kind.icon()) {
                    ui.icon(
                        column,
                        glyph_row,
                        sx + 5.0,
                        sy + (card_h - icon_size) * 0.5,
                        icon_size,
                        icon_size,
                        TEXT,
                    );
                }
                let label_x = sx + icon_size + 10.0;
                let quantity = row.quantity.to_string();
                let quantity_x = sx + card_w - ui.measure_text(&quantity, 1.1) - 6.0;
                super::chrome::text_clipped(
                    ui,
                    &row.item,
                    label_x,
                    sy + 3.0,
                    1.1,
                    (quantity_x - label_x - 6.0).max(0.0),
                    TEXT,
                );
                ui.text(kind_label(kind), label_x, sy + 14.0, 0.9, DIM);
                ui.text(&quantity, quantity_x, sy + 14.0, 1.1, TEXT);
                if row.equipped {
                    ui.rect(sx + 4.0, sy + card_h - 3.0, 10.0, 2.0, ACCENT);
                }
                if row.reserved > 0 {
                    ui.rect(sx + 17.0, sy + card_h - 3.0, 4.0, 2.0, [214, 138, 62, 255]);
                }
            }
        }
        if resp.clicked {
            SELECTED.with(|selection| {
                *selection.borrow_mut() = Some((row.container.clone(), row.stack_id.clone()));
            });
            out.push(WindowAction::Select(row.item_id));
        }
    }

    draw_scrollbar(ui, rect, held_count, capacity, page, page_count);
    if held_count == 0 {
        ui.text("NO HELD STACKS", gx + 6.0, gy + 8.0, 1.15, DIM);
    }
    draw_page_navigation(ui, [gx, gy, gw, gh], page, page_count);

    // The footer is one shallow region: its target, inventory status, economy
    // snapshot, selected details, and controls all share the same frame.
    super::chrome::region(ui, panes.footer);
    // The renderer composites the live rotating character target into this
    // cell, so the cell itself stays unpainted — an opaque fill would hide the
    // doll. A hairline seat marks the lane whether or not a target is hosted.
    ui.border(px, py, pw, ph, 1.0, super::chrome::HAIRLINE);
    let footer = footer_layout(rect);
    let visible_count = visible_end - visible_start;
    let view_label = match view {
        InventoryView::IconGrid => "GRID",
        InventoryView::CompactList => "LIST",
    };
    let page_label = if page_count == 0 {
        "PAGE 0/0".to_string()
    } else {
        format!("PAGE {}/{}", page + 1, page_count)
    };
    let status = format!(
        "{} {} / VIEWPORT {}/{}",
        view_label, page_label, visible_count, capacity
    );
    super::chrome::text_clipped(
        ui,
        &status,
        footer.info[0],
        footer.info[1],
        1.0,
        (footer.change_view[0] - footer.info[0] - 5.0).max(0.0),
        DIM,
    );
    if ui.button(
        footer.change_view[0],
        footer.change_view[1],
        footer.change_view[2],
        footer.change_view[3],
        "CHANGE VIEW",
        ButtonStyle::default(),
    ) {
        toggle_view();
        reveal_selected_stack(rect, model);
    }
    draw_segmented_usage_meter(
        ui,
        footer.info[0],
        footer.info[1] + 15.0,
        (footer.info[2] * 0.45).clamp(0.0, 96.0),
        visible_count,
        capacity,
    );
    let bank = model
        .bank
        .bank
        .as_ref()
        .map(|snapshot| snapshot.credits.to_string())
        .unwrap_or_else(|| "--".to_string());
    let finance = format!("CASH {} CR  BANK {}", inv.credits, bank);
    super::chrome::text_clipped(
        ui,
        &finance,
        footer.info[0],
        footer.info[1] + 27.0,
        1.0,
        footer.info[2],
        ACCENT,
    );
    let wielded = format!("WIELD {}", inv.weapon_label.as_deref().unwrap_or("--"));
    super::chrome::text_clipped(
        ui,
        &wielded,
        footer.info[0],
        footer.info[1] + 40.0,
        1.0,
        footer.info[2],
        TEXT,
    );

    match selected_row(model) {
        Some(row) => {
            super::chrome::text_clipped(
                ui,
                &row.item,
                footer.info[0],
                footer.info[1] + 53.0,
                1.15,
                footer.info[2],
                TEXT,
            );
            let mut details = format!("{} / QTY {}", kind_label(row.kind()), row.quantity);
            if let Some(potency) = row.potency {
                details.push_str(&format!(" / POT {}", potency));
            }
            if let Some(purity) = row.purity {
                details.push_str(&format!(" / PUR {}", purity));
            }
            super::chrome::text_clipped(
                ui,
                &details,
                footer.info[0],
                footer.info[1] + 67.0,
                0.95,
                footer.info[2],
                DIM,
            );

            let button = ButtonStyle::default();
            let buttons = action_button_rects(footer);
            let [use_x, use_y, use_w, use_h] = buttons[0];
            if ui.button(use_x, use_y, use_w, use_h, "USE", button) {
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
            let [equip_x, equip_y, equip_w, equip_h] = buttons[1];
            let equip = if row.equipped { "UNEQUIP" } else { "EQUIP" };
            if ui.button(equip_x, equip_y, equip_w, equip_h, equip, button) {
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
            let [drop_x, drop_y, drop_w, drop_h] = buttons[2];
            if ui.button(drop_x, drop_y, drop_w, drop_h, "DROP", button) {
                out.push(WindowAction::Command(
                    successor_net::ClientCommand::DiscardStack {
                        container: row.container.clone(),
                        stack_id: row.stack_id.clone(),
                        item_id: row.item_id,
                        variant_id: row.variant_id,
                    },
                ));
            }
            let [split_x, split_y, split_w, split_h] = buttons[3];
            if row.available > 1 && ui.button(split_x, split_y, split_w, split_h, "SPLIT", button) {
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
            let [merge_x, merge_y, merge_w, merge_h] = buttons[4];
            if let Some(target) = inv.held().find(|other| {
                other.stack_id != row.stack_id
                    && other.container == row.container
                    && other.item_id == row.item_id
                    && other.variant_id == row.variant_id
            }) {
                if ui.button(merge_x, merge_y, merge_w, merge_h, "MERGE", button) {
                    out.push(WindowAction::Command(
                        successor_net::ClientCommand::MergeStacks {
                            container: row.container.clone(),
                            source_stack_id: row.stack_id.clone(),
                            target_stack_id: target.stack_id.clone(),
                        },
                    ));
                }
            }
            let [store_x, store_y, store_w, store_h] = buttons[5];
            if row.available > 0 && ui.button(store_x, store_y, store_w, store_h, "STORE", button) {
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
            ui.text(
                "SELECT AN ITEM",
                footer.info[0],
                footer.info[1] + 53.0,
                1.15,
                DIM,
            );
            ui.text(
                "DETAILS AND ACTIONS",
                footer.info[0],
                footer.info[1] + 67.0,
                0.95,
                DIM,
            );
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

    fn reset_ui_state() {
        set_view(InventoryView::IconGrid);
        set_page(0);
        clear_selection();
    }

    /// 600x400 content geometry is the minimum visual-regression surface.
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
        reset_ui_state();
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
        let [button_x, button_y, button_w, button_h] = action_button_rects(footer_layout(RECT))[0];
        let out = click(
            &mut ui,
            &model,
            &icons,
            button_x + button_w * 0.5,
            button_y + button_h * 0.5,
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
        reset_ui_state();
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
        reset_ui_state();
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
        let mut ui = UiBuilder::new(icons.meta);
        let selected = click(&mut ui, &model, &icons, x + w * 0.5, y + h * 0.5);
        assert!(selected.contains(&WindowAction::Select(3127)));

        let [button_x, button_y, button_w, button_h] = action_button_rects(footer_layout(RECT))[1];
        let equipped = click(
            &mut ui,
            &model,
            &icons,
            button_x + button_w * 0.5,
            button_y + button_h * 0.5,
        );
        assert!(equipped.contains(&WindowAction::Command(
            successor_net::ClientCommand::SetEquippedWeapon {
                weapon_id: None,
                weapon_item_id: Some(3127),
                weapon_variant_id: Some(0),
            }
        )));
        reset_ui_state();
    }

    #[test]
    fn pagination_exposes_every_held_stack() {
        reset_ui_state();
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
        reset_ui_state();
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

    #[test]
    fn change_view_toggles_compact_list_with_selectable_items() {
        reset_ui_state();
        let icons = Icons::load();
        let model = fixture();
        let mut ui = UiBuilder::new(icons.meta);
        let [x, y, w, h] = footer_layout(RECT).change_view;
        let _ = click(&mut ui, &model, &icons, x + w * 0.5, y + h * 0.5);
        assert_eq!(current_view(), InventoryView::CompactList);

        let [row_x, row_y, row_w, row_h] = grid_card_rect(RECT, 0).expect("first compact-list row");
        assert_eq!(row_h, LIST_ROW_H);
        let out = click(
            &mut ui,
            &model,
            &icons,
            row_x + row_w * 0.5,
            row_y + row_h * 0.5,
        );
        assert!(
            out.contains(&WindowAction::Select(11)),
            "compact-list row keeps the same typed selection, got {out:?}"
        );

        let [x, y, w, h] = footer_layout(RECT).change_view;
        let _ = click(&mut ui, &model, &icons, x + w * 0.5, y + h * 0.5);
        assert_eq!(current_view(), InventoryView::IconGrid);
        reset_ui_state();
    }

    #[test]
    fn visual_sample_is_explicit_and_sample_remains_empty() {
        let empty = WindowModel::sample();
        assert!(!empty.connected);
        assert!(empty.inventory.rows.is_empty());
        assert_eq!(empty.inventory.credits, 0);
        assert!(empty.inventory.weapon_label.is_none());
        assert!(empty.bank.bank.is_none());

        let visual = WindowModel::visual_sample();
        let held = visual.inventory.held().collect::<Vec<_>>();
        assert!(
            !visual.connected,
            "visual data must not claim a live session"
        );
        assert!(
            (8..=10).contains(&held.len()),
            "visual fixture needs representative held stacks, got {}",
            held.len()
        );
        assert_eq!(held.first().map(|row| row.item_id), Some(3101));
        assert!(held.iter().all(|row| !row.in_exchange()));
        assert_eq!(visual.inventory.credits, 2_750);
        assert_eq!(
            visual.inventory.weapon_label.as_deref(),
            Some("SLUGTHROWER PISTOL")
        );
        assert_eq!(
            visual.bank.bank.as_ref().map(|snapshot| snapshot.credits),
            Some(18_450)
        );
    }

    #[test]
    fn footer_lanes_stay_separate_at_supported_sizes() {
        for rect in [RECT, [100.0, 100.0, 660.0, 521.0]] {
            let footer = footer_layout(rect);
            assert!(
                footer.change_view[0] >= footer.info[0]
                    && footer.change_view[0] + footer.change_view[2]
                        <= footer.info[0] + footer.info[2]
            );
            assert!(
                footer.info[0] + footer.info[2] + 6.0 <= footer.actions[0],
                "summary/view lane must finish before actions at {rect:?}"
            );
            for button in action_button_rects(footer) {
                assert!(
                    button[0] >= footer.actions[0]
                        && button[0] + button[2] <= footer.actions[0] + footer.actions[2]
                        && button[1] >= footer.actions[1]
                        && button[1] + button[3] <= footer.actions[1] + footer.actions[3],
                    "action button escaped its reserved lane at {rect:?}: {button:?}"
                );
            }
        }
    }
}
