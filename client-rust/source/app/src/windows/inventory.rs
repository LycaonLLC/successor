//! INVENTORY — held-stack grid + examine sidebar with Use/Equip/Drop actions.
//!
//! Reads `WindowModel::inventory` (live `InventoryModel` projection: wire
//! `GameInventoryRow`s, reservation holds, wallet credits, wielded weapon).
//! The grid shows held (non-exchange) stacks; exchange stockpile rows belong
//! to the datapad DATA tab. Selection is window-local UI state keyed by
//! `(container, stack_id)` and is joined back into the live examine projection.
//! Action payloads carry `InventoryRow::item_id`.

use super::{accent, dim, slot, slot_edge, text, WindowAction, WindowModel};
use crate::hud::Icons;
use core::cell::{Cell, RefCell};
use successor_engine_render::ui::{UiBuilder};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InventoryView {
    IconGrid,
    CompactList,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EquipSlotKind {
    Head,
    Face,
    Torso,
    Back,
    ArmLeft,
    ArmRight,
    Hands,
    Belt,
    Legs,
    Feet,
    Weapon,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum CategoryFilter {
    #[default]
    All,
    Weapon,
    Armor,
    Clothing,
    Consumable,
    Resource,
    Misc,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum SortMode {
    #[default]
    Name,
    Category,
    Quantity,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SplitStepperState {
    container: String,
    stack_id: String,
    quantity: u32,
}

thread_local! {
    /// Window-local examine selection `(container, stack_id)`. Interim home
    /// until the shared `WindowUiState` threading lands (see `windows::mod`).
    static SELECTED: RefCell<Option<(String, String)>> = const { RefCell::new(None) };
    static GRID_PAGE: Cell<usize> = const { Cell::new(0) };
    static LIST_PAGE: Cell<usize> = const { Cell::new(0) };
    static VIEW: Cell<InventoryView> = const { Cell::new(InventoryView::IconGrid) };
    static FILTER: Cell<CategoryFilter> = const { Cell::new(CategoryFilter::All) };
    static SORT: Cell<SortMode> = const { Cell::new(SortMode::Name) };
    static SORTED_INDICES: RefCell<Vec<usize>> = const { RefCell::new(Vec::new()) };
    static SORT_CACHE_KEY: Cell<(CategoryFilter, SortMode, usize, u64)> =
        const { Cell::new((CategoryFilter::All, SortMode::Name, 0, 0)) };
    static SPLIT_STEPPER: RefCell<Option<SplitStepperState>> = const { RefCell::new(None) };
}

fn current_filter() -> CategoryFilter {
    FILTER.with(|f| f.get())
}

fn set_filter(filter: CategoryFilter) {
    FILTER.with(|f| f.set(filter));
}

fn current_sort() -> SortMode {
    SORT.with(|s| s.get())
}

fn cycle_sort() {
    let next = match current_sort() {
        SortMode::Name => SortMode::Category,
        SortMode::Category => SortMode::Quantity,
        SortMode::Quantity => SortMode::Name,
    };
    SORT.with(|s| s.set(next));
}

fn matches_filter(row: &super::InventoryRow, filter: CategoryFilter) -> bool {
    match filter {
        CategoryFilter::All => true,
        CategoryFilter::Weapon => row.kind() == super::ItemKind::Weapon,
        CategoryFilter::Armor => {
            if row.kind() == super::ItemKind::Gear {
                let name = row.item.to_ascii_uppercase();
                name.contains("ARMOR")
                    || name.contains("HELM")
                    || name.contains("VEST")
                    || name.contains("CHEST")
                    || name.contains("GREAVE")
                    || name.contains("BRACER")
                    || name.contains("GAUNTLET")
                    || name.contains("SHIELD")
                    || name.contains("SUIT")
            } else {
                false
            }
        }
        CategoryFilter::Clothing => {
            if row.kind() == super::ItemKind::Gear {
                let name = row.item.to_ascii_uppercase();
                !(name.contains("ARMOR")
                    || name.contains("HELM")
                    || name.contains("VEST")
                    || name.contains("CHEST")
                    || name.contains("GREAVE")
                    || name.contains("BRACER")
                    || name.contains("GAUNTLET")
                    || name.contains("SHIELD")
                    || name.contains("SUIT"))
            } else {
                false
            }
        }
        CategoryFilter::Consumable => {
            matches!(row.kind(), super::ItemKind::Medical | super::ItemKind::Ammo)
        }
        CategoryFilter::Resource => row.kind() == super::ItemKind::Resource,
        CategoryFilter::Misc => {
            matches!(
                row.kind(),
                super::ItemKind::Tool | super::ItemKind::Currency | super::ItemKind::Item
            )
        }
    }
}

fn kind_sort_order(kind: super::ItemKind) -> usize {
    match kind {
        super::ItemKind::Weapon => 0,
        super::ItemKind::Gear => 1,
        super::ItemKind::Medical => 2,
        super::ItemKind::Ammo => 3,
        super::ItemKind::Resource => 4,
        super::ItemKind::Tool => 5,
        super::ItemKind::Currency => 6,
        super::ItemKind::Item => 7,
    }
}

#[derive(Clone, Copy, Debug)]
pub struct InventoryLayout {
    pub grid: [f32; 4],
    /// Shallow footer shared by inventory status, economy, and item actions.
    pub footer: [f32; 4],
    /// Equipment column on the left, holding the live character doll.
    pub equipment: [f32; 4],
    /// The doll viewport itself, inset and aspect-held inside `equipment`.
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
/// Equipment column share of the window, from the original's 232/468 content
/// split, with its 88 px floor and 232 px ceiling.
const EQUIPMENT_WIDTH_RATIO: f32 = 232.0 / 468.0;
const EQUIPMENT_MIN_W: f32 = 88.0;
const EQUIPMENT_MAX_W: f32 = 232.0;
/// Equipment slot cell, and the lane one rail of them occupies. The original
/// frames the paperdoll with its slots rather than overlaying them, so the
/// column has to reserve the lane before the doll claims the width.
pub const EQUIP_SLOT: f32 = 20.0;
const EQUIP_RAIL_W: f32 = EQUIP_SLOT + 8.0;
/// Doll width below which the rails are not worth their cost: the portrait
/// would read as a thumbnail. At that point the rails drop and the doll takes
/// the whole column, which is what the 250x244 resize floor gets.
const EQUIP_DOLL_MIN_W: f32 = 96.0;
/// Rails also need vertical room to space eleven cells without touching.
const EQUIP_RAIL_MIN_H: f32 = 160.0;
/// Doll viewport aspect, from the original's 225x367 paperdoll rect.
const DOLL_ASPECT: f32 = 225.0 / 367.0;

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

/// SWG inventory geometry: an equipment column carrying the live character
/// doll owns the left of the window, the item field owns the right, and one
/// shallow footer carries status, economy, and the selected stack's actions.
///
/// Proportions follow the original's `ui_pda_inventory.inc`: in its shipped
/// 483x450 window the equipment panel is 232 of 468 content px with an 88 px
/// floor, and the doll viewport inside it is 225x367 — a tall portrait, not a
/// thumbnail.
pub fn layout(rect: [f32; 4]) -> InventoryLayout {
    let [x, y, w, h] = rect;
    let gap = 7.0;
    let footer_h = (h * 0.23).clamp(86.0, 100.0).min((h - 120.0).max(72.0));
    let footer_y = y + h - footer_h;
    let body_h = (footer_y - gap - y).max(0.0);

    // Equipment column: the original's 232/468 share, floored at 88 so a
    // narrow window keeps a usable doll, and never more than half the window.
    let equipment_w = (w * EQUIPMENT_WIDTH_RATIO)
        .clamp(EQUIPMENT_MIN_W, EQUIPMENT_MAX_W)
        .min(w * 0.5);
    let equipment = [x, y, equipment_w, body_h];

    // The doll holds the original's 225x367 portrait aspect inside the lane
    // the slot rails leave it, so resizing never stretches the character and
    // the slots never overlap it.
    let inset = 3.0;
    let avail_w = (equipment_w - inset * 2.0).max(0.0);
    let avail_h = (body_h - inset * 2.0).max(0.0);
    let rails = avail_w - EQUIP_RAIL_W * 2.0 >= EQUIP_DOLL_MIN_W && avail_h >= EQUIP_RAIL_MIN_H;
    let rail_w = if rails { EQUIP_RAIL_W } else { 0.0 };
    let doll_w = (avail_w - rail_w * 2.0).max(0.0);
    let preview_w = doll_w.min(avail_h * DOLL_ASPECT);
    let preview_h = if DOLL_ASPECT > 0.0 {
        avail_h.min(doll_w / DOLL_ASPECT)
    } else {
        avail_h
    };
    let preview = [
        x + inset + rail_w + (doll_w - preview_w) * 0.5,
        y + inset + (avail_h - preview_h) * 0.5,
        preview_w,
        preview_h,
    ];

    let grid_x = x + equipment_w + gap;
    InventoryLayout {
        grid: [grid_x, y, (x + w - grid_x).max(0.0), body_h],
        footer: [x, footer_y, w, footer_h],
        equipment,
        preview,
        detail: [x, footer_y, w, footer_h],
    }
}

const FILTER_BAR_H: f32 = 20.0;

/// The item well sits below the compact category filter row and leaves an edge channel for the scrollbar.
fn item_well(rect: [f32; 4]) -> [f32; 4] {
    let [x, y, w, h] = layout(rect).grid;
    [
        x,
        y + FILTER_BAR_H,
        (w - SCROLLBAR_CHANNEL_W).max(0.0),
        (h - FILTER_BAR_H).max(0.0),
    ]
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

/// Copy the held-stack indices the grid is drawing right now, in draw order,
/// into `out`; returns how many were written.
///
/// The 3D item lanes composite behind the cards, so they have to consume the
/// same filtered, sorted, paged order the 2D layer used. Re-deriving it from
/// `held()` puts a model under the wrong label the moment a filter or sort is
/// active. Caller-owned buffer: this runs every frame and must not allocate.
pub fn copy_visible_held_indices(rect: [f32; 4], out: &mut [usize]) -> usize {
    let filtered = SORTED_INDICES.with(|indices| indices.borrow().len());
    let (start, end) = visible_held_range(rect, filtered);
    SORTED_INDICES.with(|indices| {
        let indices = indices.borrow();
        if start >= indices.len() {
            return 0;
        }
        let slice = &indices[start..end.min(indices.len())];
        let count = slice.len().min(out.len());
        out[..count].copy_from_slice(&slice[..count]);
        count
    })
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

fn ensure_sorted_indices(model: &WindowModel) {
    let filter = current_filter();
    let sort = current_sort();
    let held_rows: Vec<&super::InventoryRow> = model.inventory.held().collect();
    let count = held_rows.len();

    let mut checksum: u64 = 0;
    for (idx, row) in held_rows.iter().enumerate() {
        checksum = checksum.wrapping_add((idx as u64 + 1) * 31);
        checksum = checksum.wrapping_add(row.item_id as u64);
        checksum = checksum.wrapping_add(row.quantity as u64);
        checksum = checksum.wrapping_add(if row.equipped { 1 } else { 0 });
    }

    let key = (filter, sort, count, checksum);
    SORT_CACHE_KEY.with(|cache| {
        if cache.get() == key {
            return;
        }
        cache.set(key);
        SORTED_INDICES.with(|indices| {
            let mut vec = indices.borrow_mut();
            vec.clear();
            for (idx, row) in held_rows.iter().enumerate() {
                if matches_filter(row, filter) {
                    vec.push(idx);
                }
            }
            match sort {
                SortMode::Name => {
                    vec.sort_by(|&a, &b| {
                        held_rows[a]
                            .item
                            .to_ascii_uppercase()
                            .cmp(&held_rows[b].item.to_ascii_uppercase())
                            .then_with(|| a.cmp(&b))
                    });
                }
                SortMode::Category => {
                    vec.sort_by(|&a, &b| {
                        kind_sort_order(held_rows[a].kind())
                            .cmp(&kind_sort_order(held_rows[b].kind()))
                            .then_with(|| {
                                held_rows[a]
                                    .item
                                    .to_ascii_uppercase()
                                    .cmp(&held_rows[b].item.to_ascii_uppercase())
                            })
                            .then_with(|| a.cmp(&b))
                    });
                }
                SortMode::Quantity => {
                    vec.sort_by(|&a, &b| {
                        held_rows[b]
                            .quantity
                            .cmp(&held_rows[a].quantity)
                            .then_with(|| {
                                held_rows[a]
                                    .item
                                    .to_ascii_uppercase()
                                    .cmp(&held_rows[b].item.to_ascii_uppercase())
                            })
                            .then_with(|| a.cmp(&b))
                    });
                }
            }
        });
    });
}

fn reveal_selected_stack(rect: [f32; 4], model: &WindowModel) {
    let Some((container, stack_id)) = selected_identity() else {
        return;
    };
    ensure_sorted_indices(model);
    let held_rows: Vec<&super::InventoryRow> = model.inventory.held().collect();
    let found_pos = SORTED_INDICES.with(|indices| {
        indices.borrow().iter().position(|&idx| {
            if idx < held_rows.len() {
                let row = held_rows[idx];
                row.container == container && row.stack_id == stack_id
            } else {
                false
            }
        })
    });
    if let Some(index) = found_pos {
        set_page(index / grid_capacity(rect).max(1));
    }
}

fn match_equip_slot(row: &super::InventoryRow) -> Option<EquipSlotKind> {
    if !row.equipped {
        return None;
    }
    let kind = row.kind();
    if kind == super::ItemKind::Weapon {
        return Some(EquipSlotKind::Weapon);
    }
    let name = row.item.to_ascii_uppercase();
    let key = row.item_key.as_deref().unwrap_or("").to_ascii_lowercase();

    if name.contains("HEAD")
        || name.contains("HELM")
        || name.contains("HAT")
        || name.contains("CAP")
        || name.contains("HOOD")
        || name.contains("CROWN")
        || key.contains("head")
        || key.contains("helm")
    {
        Some(EquipSlotKind::Head)
    } else if name.contains("FACE")
        || name.contains("EYES")
        || name.contains("VISOR")
        || name.contains("GOGGLE")
        || name.contains("GLASSES")
        || name.contains("MONOCLE")
        || key.contains("face")
        || key.contains("visor")
    {
        Some(EquipSlotKind::Face)
    } else if name.contains("BACK")
        || name.contains("CAPE")
        || name.contains("CLOAK")
        || name.contains("PACK")
        || key.contains("back")
        || key.contains("cape")
    {
        Some(EquipSlotKind::Back)
    } else if name.contains("ARM L")
        || name.contains("BICEP L")
        || name.contains("LEFT ARM")
        || name.contains("BRACER L")
        || name.contains("SHOULDER L")
        || key.contains("arm_l")
        || key.contains("bicep_l")
    {
        Some(EquipSlotKind::ArmLeft)
    } else if name.contains("ARM R")
        || name.contains("BICEP R")
        || name.contains("RIGHT ARM")
        || name.contains("BRACER R")
        || name.contains("SHOULDER R")
        || key.contains("arm_r")
        || key.contains("bicep_r")
    {
        Some(EquipSlotKind::ArmRight)
    } else if name.contains("HAND")
        || name.contains("GLOVE")
        || name.contains("GAUNTLET")
        || key.contains("glove")
        || key.contains("hand")
    {
        Some(EquipSlotKind::Hands)
    } else if name.contains("BELT")
        || name.contains("WAIST")
        || name.contains("BANDOLIER")
        || name.contains("SASH")
        || key.contains("belt")
    {
        Some(EquipSlotKind::Belt)
    } else if name.contains("LEG")
        || name.contains("PANT")
        || name.contains("TROUSER")
        || name.contains("GREAVE")
        || name.contains("KILT")
        || name.contains("SKIRT")
        || key.contains("leg")
        || key.contains("pant")
    {
        Some(EquipSlotKind::Legs)
    } else if name.contains("FEET")
        || name.contains("BOOT")
        || name.contains("SHOE")
        || key.contains("boot")
        || key.contains("feet")
    {
        Some(EquipSlotKind::Feet)
    } else {
        Some(EquipSlotKind::Torso)
    }
}

fn draw_equipment_slot_rails(
    ui: &mut UiBuilder,
    model: &WindowModel,
    icons: &Icons,
    equipment_rect: [f32; 4],
    preview_rect: [f32; 4],
    out: &mut Vec<WindowAction>,
) {
    let [eq_x, _eq_y, eq_w, _eq_h] = equipment_rect;
    let [px, py, pw, ph] = preview_rect;

    let left_space = px - eq_x;
    let right_space = (eq_x + eq_w) - (px + pw);

    // `layout` already reserved the lanes; this only refuses to draw when a
    // caller hands over a rect the reservation could not honour.
    let slot_size = EQUIP_SLOT;
    if left_space < slot_size + 4.0 || right_space < slot_size + 4.0 || ph < 120.0 {
        return;
    }

    const LEFT_SLOTS: [EquipSlotKind; 6] = [
        EquipSlotKind::Head,
        EquipSlotKind::Face,
        EquipSlotKind::Torso,
        EquipSlotKind::ArmLeft,
        EquipSlotKind::Hands,
        EquipSlotKind::Weapon,
    ];

    const RIGHT_SLOTS: [EquipSlotKind; 5] = [
        EquipSlotKind::Back,
        EquipSlotKind::ArmRight,
        EquipSlotKind::Belt,
        EquipSlotKind::Legs,
        EquipSlotKind::Feet,
    ];

    let left_x = eq_x + (left_space - slot_size) * 0.5;
    let right_x = px + pw + (right_space - slot_size) * 0.5;

    let left_step = if LEFT_SLOTS.len() > 1 {
        (ph - slot_size) / (LEFT_SLOTS.len() - 1) as f32
    } else {
        0.0
    };
    for (i, &slot) in LEFT_SLOTS.iter().enumerate() {
        let sy = py + i as f32 * left_step;
        draw_single_equip_slot(ui, model, icons, slot, [left_x, sy, slot_size], out);
    }

    let right_step = if RIGHT_SLOTS.len() > 1 {
        (ph - slot_size) / (RIGHT_SLOTS.len() - 1) as f32
    } else {
        0.0
    };
    for (j, &slot) in RIGHT_SLOTS.iter().enumerate() {
        let sy = py + j as f32 * right_step;
        draw_single_equip_slot(ui, model, icons, slot, [right_x, sy, slot_size], out);
    }
}

fn draw_single_equip_slot(
    ui: &mut UiBuilder,
    model: &WindowModel,
    icons: &Icons,
    slot: EquipSlotKind,
    cell: [f32; 3],
    out: &mut Vec<WindowAction>,
) {
    let [sx, sy, slot_size] = cell;
    let equipped_row = model
        .inventory
        .held()
        .find(|r| r.equipped && match_equip_slot(r) == Some(slot));

    let is_selected = equipped_row.is_some_and(|r| {
        SELECTED.with(|sel| {
            sel.borrow()
                .as_ref()
                .is_some_and(|(c, s)| c == &r.container && s == &r.stack_id)
        })
    });

    ui.rect(sx, sy, slot_size, slot_size, super::slot());
    if is_selected {
        ui.border(sx, sy, slot_size, slot_size, 1.5, accent());
    } else {
        ui.border(sx, sy, slot_size, slot_size, 1.0, slot_edge());
    }

    if let Some(row) = equipped_row {
        let kind = row.kind();
        if let Some((col, glyph_row)) = icons.cell(kind.icon()) {
            ui.icon(
                col,
                glyph_row,
                sx + 2.0,
                sy + 2.0,
                slot_size - 4.0,
                slot_size - 4.0,
                text(),
            );
        }

        let resp = ui.interact(sx, sy, slot_size, slot_size);
        if resp.hovered && !is_selected {
            ui.border(sx, sy, slot_size, slot_size, 1.0, super::chrome::hover());
        }

        if resp.clicked {
            if is_selected {
                let command = if row.kind() == super::ItemKind::Gear {
                    successor_net::ClientCommand::SetEquippedClothing {
                        item_id: row.item_id,
                        equipped: false,
                        container: Some(row.container.clone()),
                        stack_id: Some(row.stack_id.clone()),
                        variant_id: Some(row.variant_id),
                    }
                } else {
                    successor_net::ClientCommand::SetEquippedWeapon {
                        weapon_id: None,
                        weapon_item_id: None,
                        weapon_variant_id: None,
                    }
                };
                out.push(WindowAction::Command(command));
            } else {
                select_identity(&row.container, &row.stack_id);
                out.push(WindowAction::Select(row.item_id));
            }
        }
    }
}

fn draw_filter_and_sort_bar(
    ui: &mut UiBuilder,
    grid_rect: [f32; 4],
    rect: [f32; 4],
    model: &WindowModel,
) {
    let [grid_x, grid_y, grid_w, _grid_h] = grid_rect;
    let avail_w = (grid_w - SCROLLBAR_CHANNEL_W).max(0.0);
    if avail_w <= 0.0 {
        return;
    }

    let current_f = current_filter();
    let current_s = current_sort();

    let sort_w = (avail_w * 0.22).clamp(50.0, 75.0);
    let filter_avail_w = (avail_w - sort_w - 4.0).max(0.0);

    const FILTERS: [(CategoryFilter, &str); 7] = [
        (CategoryFilter::All, "ALL"),
        (CategoryFilter::Weapon, "WEAPON"),
        (CategoryFilter::Armor, "ARMOR"),
        (CategoryFilter::Clothing, "CLOTHING"),
        (CategoryFilter::Consumable, "CONSUMABLE"),
        (CategoryFilter::Resource, "RESOURCE"),
        (CategoryFilter::Misc, "MISC"),
    ];

    let tab_w = filter_avail_w / FILTERS.len() as f32;

    for (i, &(f, label)) in FILTERS.iter().enumerate() {
        let tx = grid_x + i as f32 * tab_w;
        let ty = grid_y;
        let is_active = current_f == f;

        let style = crate::hud::button_style();
        if ui.button(tx, ty, tab_w, 18.0, label, style) && current_f != f {
            set_filter(f);
            set_page(0);
            reveal_selected_stack(rect, model);
        }
        if is_active {
            ui.rect(tx + 1.0, ty + 16.0, (tab_w - 2.0).max(0.0), 2.0, accent());
        }
    }

    let sort_x = grid_x + avail_w - sort_w;
    let sort_label = match current_s {
        SortMode::Name => "SORT: NAME",
        SortMode::Category => "SORT: CAT",
        SortMode::Quantity => "SORT: QTY",
    };
    if ui.button(sort_x, grid_y, sort_w, 18.0, sort_label, crate::hud::button_style()) {
        cycle_sort();
    }
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
    let track_y = grid_y + FILTER_BAR_H + 3.0;
    let track_h = (grid_h - FILTER_BAR_H - GRID_STATUS_H - 6.0).max(0.0);
    ui.rect(
        channel_x,
        grid_y + FILTER_BAR_H + 1.0,
        SCROLLBAR_CHANNEL_W,
        track_h + 4.0,
        slot(),
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
        accent(),
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
                accent()
            } else {
                slot()
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
    let nav = crate::hud::button_style();
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
    let view = current_view();

    ensure_sorted_indices(model);
    let filtered_count = SORTED_INDICES.with(|idx| idx.borrow().len());
    let capacity = grid_capacity(rect).max(1);
    let (visible_start, visible_end) = visible_held_range(rect, filtered_count);

    super::chrome::region(ui, [gx, gy, gw, gh]);
    super::chrome::region(ui, panes.equipment);
    super::chrome::viewer_seat(ui, panes.preview);

    draw_equipment_slot_rails(ui, model, icons, panes.equipment, panes.preview, out);
    draw_filter_and_sort_bar(ui, panes.grid, rect, model);

    let page = visible_start / capacity;
    let page_count = if filtered_count == 0 {
        0
    } else {
        filtered_count.saturating_sub(1) / capacity + 1
    };

    let held_rows: Vec<&super::InventoryRow> = inv.held().collect();

    SORTED_INDICES.with(|indices| {
        let b = indices.borrow();
        let slice = if visible_start < b.len() {
            &b[visible_start..visible_end.min(b.len())]
        } else {
            &[]
        };

        for (index, &row_idx) in slice.iter().enumerate() {
            if row_idx >= held_rows.len() {
                continue;
            }
            let row = held_rows[row_idx];
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
            if selected {
                ui.rect(sx, sy, card_w, card_h, super::chrome::selected());
            } else if resp.hovered {
                ui.rect(sx, sy, card_w, card_h, super::chrome::hover());
            }
            if selected {
                match view {
                    InventoryView::IconGrid => {
                        ui.rect(sx, sy + card_h - 2.0, card_w, 2.0, accent());
                    }
                    InventoryView::CompactList => {
                        ui.rect(sx + 1.0, sy + 2.0, 2.0, (card_h - 4.0).max(0.0), accent());
                    }
                }
            }

            let kind = row.kind();
            match view {
                InventoryView::IconGrid => {
                    ui.text(kind_label(kind), sx + 4.0, sy + 3.0, 1.0, dim());
                    let hosted = index < crate::item_preview::INVENTORY_LANES;
                    if let Some((column, glyph_row)) = icons.cell(kind.icon()).filter(|_| !hosted) {
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
                            text(),
                        );
                    }
                    super::chrome::text_clipped(
                        ui,
                        &row.item,
                        sx + 3.0,
                        sy + card_w + 3.0,
                        1.05,
                        (card_w - 6.0).max(0.0),
                        text(),
                    );
                    let quantity = row.quantity.to_string();
                    ui.text(
                        &quantity,
                        sx + card_w - ui.measure_text(&quantity, 1.2) - 3.0,
                        sy + card_w - 12.0,
                        1.2,
                        text(),
                    );
                    if row.equipped {
                        ui.rect(sx + 3.0, sy + card_w - 4.0, card_w - 6.0, 2.0, accent());
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
                            text(),
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
                        text(),
                    );
                    ui.text(kind_label(kind), label_x, sy + 14.0, 0.9, dim());
                    ui.text(&quantity, quantity_x, sy + 14.0, 1.1, text());
                    if row.equipped {
                        ui.rect(sx + 4.0, sy + card_h - 3.0, 10.0, 2.0, accent());
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
    });

    draw_scrollbar(ui, rect, filtered_count, capacity, page, page_count);
    if filtered_count == 0 {
        ui.text("NO HELD STACKS", gx + 6.0, gy + FILTER_BAR_H + 8.0, 1.15, dim());
    }
    draw_page_navigation(ui, [gx, gy, gw, gh], page, page_count);

    super::chrome::region(ui, panes.footer);
    let footer = footer_layout(rect);
    let view_label = match view {
        InventoryView::IconGrid => "GRID",
        InventoryView::CompactList => "LIST",
    };
    let page_label = if page_count == 0 {
        "PAGE 0/0".to_string()
    } else {
        format!("PAGE {}/{}", page + 1, page_count)
    };

    // InventoryModel currently exposes no container volume capacity field.
    // We report held_count honestly as HELD STACKS <N>, without inventing a fake capacity.
    let status = format!(
        "{} {} / HELD STACKS {}",
        view_label, page_label, inv.held().count()
    );
    super::chrome::text_clipped(
        ui,
        &status,
        footer.info[0],
        footer.info[1],
        1.0,
        (footer.change_view[0] - footer.info[0] - 5.0).max(0.0),
        dim(),
    );
    if ui.button(
        footer.change_view[0],
        footer.change_view[1],
        footer.change_view[2],
        footer.change_view[3],
        "CHANGE VIEW",
        crate::hud::button_style(),
    ) {
        toggle_view();
        reveal_selected_stack(rect, model);
    }
    draw_segmented_usage_meter(
        ui,
        footer.info[0],
        footer.info[1] + 15.0,
        (footer.info[2] * 0.45).clamp(0.0, 96.0),
        inv.held().count(),
        inv.held().count().max(1),
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
        accent(),
    );
    let wielded = format!("WIELD {}", inv.weapon_label.as_deref().unwrap_or("--"));
    super::chrome::text_clipped(
        ui,
        &wielded,
        footer.info[0],
        footer.info[1] + 40.0,
        1.0,
        footer.info[2],
        text(),
    );

    let current_selected_row = selected_row(model);

    // Keep split stepper in sync with selection
    let is_split_armed = current_selected_row.as_ref().is_some_and(|row| {
        SPLIT_STEPPER.with(|s| {
            s.borrow()
                .as_ref()
                .is_some_and(|st| st.container == row.container && st.stack_id == row.stack_id && row.available > 1)
        })
    });

    if !is_split_armed && current_selected_row.as_ref().is_none() {
        SPLIT_STEPPER.with(|s| *s.borrow_mut() = None);
    }

    match current_selected_row {
        Some(row) => {
            super::chrome::text_clipped(
                ui,
                &row.item,
                footer.info[0],
                footer.info[1] + 53.0,
                1.15,
                footer.info[2],
                text(),
            );

            let mut details = format!("{} / QTY {}", kind_label(row.kind()), row.quantity);
            if let Some(potency) = row.potency {
                details.push_str(&format!(" / POT {}", potency));
            }
            if let Some(purity) = row.purity {
                details.push_str(&format!(" / PUR {}", purity));
            }

            if is_split_armed {
                let stepper_qty = SPLIT_STEPPER.with(|s| s.borrow().as_ref().map(|st| st.quantity).unwrap_or(1));
                details = format!("SPLIT STACK / QTY {} / MAX {}", stepper_qty, row.available - 1);
            }

            super::chrome::text_clipped(
                ui,
                &details,
                footer.info[0],
                footer.info[1] + 67.0,
                0.95,
                footer.info[2],
                dim(),
            );

            let button = crate::hud::button_style();
            let buttons = action_button_rects(footer);

            if is_split_armed {
                let max_split = (row.available - 1).max(1) as u32;
                let mut stepper_qty = SPLIT_STEPPER.with(|s| s.borrow().as_ref().map(|st| st.quantity).unwrap_or(1)).clamp(1, max_split);
                let step = 1u32;

                let [minus_x, minus_y, minus_w, minus_h] = buttons[0];
                if ui.button(minus_x, minus_y, minus_w, minus_h, "-", button) {
                    stepper_qty = stepper_qty.saturating_sub(step).clamp(1, max_split);
                    SPLIT_STEPPER.with(|s| {
                        if let Some(st) = s.borrow_mut().as_mut() {
                            st.quantity = stepper_qty;
                        }
                    });
                }

                let [plus_x, plus_y, plus_w, plus_h] = buttons[1];
                if ui.button(plus_x, plus_y, plus_w, plus_h, "+", button) {
                    stepper_qty = (stepper_qty + step).clamp(1, max_split);
                    SPLIT_STEPPER.with(|s| {
                        if let Some(st) = s.borrow_mut().as_mut() {
                            st.quantity = stepper_qty;
                        }
                    });
                }

                let [half_x, half_y, half_w, half_h] = buttons[2];
                if ui.button(half_x, half_y, half_w, half_h, "HALF", button) {
                    stepper_qty = ((row.available / 2).max(1) as u32).min(max_split);
                    SPLIT_STEPPER.with(|s| {
                        if let Some(st) = s.borrow_mut().as_mut() {
                            st.quantity = stepper_qty;
                        }
                    });
                }

                let [all_x, all_y, all_w, all_h] = buttons[3];
                if ui.button(all_x, all_y, all_w, all_h, "ALL", button) {
                    stepper_qty = max_split;
                    SPLIT_STEPPER.with(|s| {
                        if let Some(st) = s.borrow_mut().as_mut() {
                            st.quantity = stepper_qty;
                        }
                    });
                }

                let [confirm_x, confirm_y, confirm_w, confirm_h] = buttons[4];
                if ui.button(confirm_x, confirm_y, confirm_w, confirm_h, "CONFIRM", button) {
                    out.push(WindowAction::Command(
                        successor_net::ClientCommand::SplitStack {
                            container: row.container.clone(),
                            stack_id: row.stack_id.clone(),
                            item_id: row.item_id,
                            variant_id: row.variant_id,
                            quantity: stepper_qty,
                        },
                    ));
                    SPLIT_STEPPER.with(|s| *s.borrow_mut() = None);
                }

                let [cancel_x, cancel_y, cancel_w, cancel_h] = buttons[5];
                if ui.button(cancel_x, cancel_y, cancel_w, cancel_h, "CANCEL", button) {
                    SPLIT_STEPPER.with(|s| *s.borrow_mut() = None);
                }
            } else {
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
                    let max_split = (row.available - 1).max(1) as u32;
                    let initial_qty = ((row.available / 2).max(1) as u32).min(max_split);
                    SPLIT_STEPPER.with(|s| {
                        *s.borrow_mut() = Some(SplitStepperState {
                            container: row.container.clone(),
                            stack_id: row.stack_id.clone(),
                            quantity: initial_qty,
                        });
                    });
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
        }
        None => {
            ui.text(
                "SELECT AN ITEM",
                footer.info[0],
                footer.info[1] + 53.0,
                1.15,
                dim(),
            );
            ui.text(
                "DETAILS AND ACTIONS",
                footer.info[0],
                footer.info[1] + 67.0,
                0.95,
                dim(),
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
        set_filter(CategoryFilter::All);
        SORT.with(|s| s.set(SortMode::Name));
        SORT_CACHE_KEY.with(|k| k.set((CategoryFilter::All, SortMode::Name, 0, 0)));
        SPLIT_STEPPER.with(|s| *s.borrow_mut() = None);
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
    #[test]
    fn slot_click_selects_and_second_slot_click_unequips() {
        reset_ui_state();
        let icons = Icons::load();
        let mut model = WindowModel::sample();
        model.inventory.rows = vec![InventoryRow {
            container: "player:pack".into(),
            stack_id: "vest-1".into(),
            item: "Armor Vest".into(),
            item_id: 2001,
            quantity: 1,
            available: 1,
            equipped: true,
            ..Default::default()
        }];
        let mut ui = UiBuilder::new(icons.meta);

        let panes = layout(RECT);
        let slot_size = 20.0;
        let left_space = panes.preview[0] - panes.equipment[0];
        let slot_x = panes.equipment[0] + (left_space - slot_size) * 0.5;
        let left_step = (panes.preview[3] - slot_size) / 5.0;
        let slot_y = panes.preview[1] + 2.0 * left_step;

        let out = click(&mut ui, &model, &icons, slot_x + slot_size * 0.5, slot_y + slot_size * 0.5);
        assert!(out.contains(&WindowAction::Select(2001)), "first slot click selects stack");
        assert_eq!(selected_identity(), Some(("player:pack".into(), "vest-1".into())));

        let out = click(&mut ui, &model, &icons, slot_x + slot_size * 0.5, slot_y + slot_size * 0.5);
        assert!(
            out.contains(&WindowAction::Command(
                successor_net::ClientCommand::SetEquippedClothing {
                    item_id: 2001,
                    equipped: false,
                    container: Some("player:pack".into()),
                    stack_id: Some("vest-1".into()),
                    variant_id: Some(0),
                }
            )),
            "second click unequips stack, got {out:?}"
        );
        reset_ui_state();
    }

    #[test]
    fn filter_narrows_rows() {
        reset_ui_state();
        let icons = Icons::load();
        let mut model = WindowModel::sample();
        model.inventory.rows = vec![
            InventoryRow {
                container: "player".into(),
                stack_id: "w1".into(),
                item: "Pistol".into(),
                item_id: 3101,
                quantity: 1,
                available: 1,
                ..Default::default()
            },
            InventoryRow {
                container: "player".into(),
                stack_id: "r1".into(),
                item: "Copper Ore".into(),
                item_id: 501,
                quantity: 10,
                available: 10,
                resource_stats: Some(Default::default()),
                ..Default::default()
            },
        ];
        let mut ui = UiBuilder::new(icons.meta);

        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, RECT, &model, &icons, &mut out);
        assert_eq!(SORTED_INDICES.with(|i| i.borrow().len()), 2);

        set_filter(CategoryFilter::Weapon);
        ui.begin(1280, 720);
        draw(&mut ui, RECT, &model, &icons, &mut out);
        assert_eq!(SORTED_INDICES.with(|i| i.borrow().len()), 1);

        set_filter(CategoryFilter::Resource);
        ui.begin(1280, 720);
        draw(&mut ui, RECT, &model, &icons, &mut out);
        assert_eq!(SORTED_INDICES.with(|i| i.borrow().len()), 1);

        reset_ui_state();
    }

    #[test]
    fn sort_reorders_deterministically() {
        reset_ui_state();
        let icons = Icons::load();
        let mut model = WindowModel::sample();
        model.inventory.rows = vec![
            InventoryRow {
                container: "player".into(),
                stack_id: "s1".into(),
                item: "Zebra Skin".into(),
                item_id: 1,
                quantity: 5,
                ..Default::default()
            },
            InventoryRow {
                container: "player".into(),
                stack_id: "s2".into(),
                item: "Alpha Fiber".into(),
                item_id: 2,
                quantity: 100,
                ..Default::default()
            },
        ];
        let mut ui = UiBuilder::new(icons.meta);

        SORT.with(|s| s.set(SortMode::Name));
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, RECT, &model, &icons, &mut out);
        SORTED_INDICES.with(|i| {
            assert_eq!(*i.borrow(), vec![1, 0]);
        });

        SORT.with(|s| s.set(SortMode::Quantity));
        ui.begin(1280, 720);
        draw(&mut ui, RECT, &model, &icons, &mut out);
        SORTED_INDICES.with(|i| {
            assert_eq!(*i.borrow(), vec![1, 0]);
        });

        reset_ui_state();
    }

    #[test]
    fn split_stepper_clamps_and_emits_exact_quantity() {
        reset_ui_state();
        let icons = Icons::load();
        let mut model = WindowModel::sample();
        model.inventory.rows = vec![InventoryRow {
            container: "player:pack".into(),
            stack_id: "stim-stack".into(),
            item: "Field Stim".into(),
            item_id: 101,
            quantity: 10,
            available: 10,
            ..Default::default()
        }];
        let mut ui = UiBuilder::new(icons.meta);

        select_identity("player:pack", "stim-stack");
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, RECT, &model, &icons, &mut out);

        let buttons = action_button_rects(footer_layout(RECT));
        let [split_x, split_y, split_w, split_h] = buttons[3];
        let _ = click(&mut ui, &model, &icons, split_x + split_w * 0.5, split_y + split_h * 0.5);

        let armed_qty = SPLIT_STEPPER.with(|s| s.borrow().as_ref().map(|st| st.quantity));
        assert_eq!(armed_qty, Some(5));

        let _ = click(&mut ui, &model, &icons, split_x + split_w * 0.5, split_y + split_h * 0.5);
        let armed_qty = SPLIT_STEPPER.with(|s| s.borrow().as_ref().map(|st| st.quantity));
        assert_eq!(armed_qty, Some(9));

        let [confirm_x, confirm_y, confirm_w, confirm_h] = buttons[4];
        let out = click(&mut ui, &model, &icons, confirm_x + confirm_w * 0.5, confirm_y + confirm_h * 0.5);
        assert!(
            out.contains(&WindowAction::Command(
                successor_net::ClientCommand::SplitStack {
                    container: "player:pack".into(),
                    stack_id: "stim-stack".into(),
                    item_id: 101,
                    variant_id: 0,
                    quantity: 9,
                }
            )),
            "CONFIRM emits SplitStack with exact quantity, got {out:?}"
        );
        assert!(SPLIT_STEPPER.with(|s| s.borrow().is_none()));

        reset_ui_state();
    }

    #[test]
    fn min_size_frame_draws_without_panicking_and_without_overlapping_lanes() {
        reset_ui_state();
        let icons = Icons::load();
        let model = fixture();
        let min_rect: [f32; 4] = [0.0, 0.0, 250.0, 244.0];
        let mut ui = UiBuilder::new(icons.meta);
        ui.begin(1280, 720);
        let mut out = Vec::new();
        draw(&mut ui, min_rect, &model, &icons, &mut out);

        let footer = footer_layout(min_rect);
        assert!(footer.info[0] + footer.info[2] <= footer.actions[0] + 0.1);
        assert!(footer.actions[2] >= 0.0);

        reset_ui_state();
    }
}
