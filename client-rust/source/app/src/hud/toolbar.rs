//! TOOLBAR + DOCK — 12 icon slots (three groups of four) bottom-center and
//! the right-edge window rail (ports of `ui/hud/toolbar.ts`,
//! `ui/hud/toolbarActions.ts`, `ui/hud/toolbarStore.ts`, `ui/windows/dock.ts`).
//!
//! Persistence: one schema-3 doc (`{ schema: 3, slots: [...12], binds: [...12] }`)
//! under the Local scope — device muscle memory, not character data. Slots are
//! BLANK BY DEFAULT; assignments come from the Action Browser. Invalid action
//! ids are stripped on load (the Aim-removal migration gate). Binds default to
//! the number row `Digit1..Digit9, Digit0, Minus, Equal` and are rebindable
//! from OPTIONS via pending-capture.

use serde_json::{json, Value};
use successor_engine_render::ui::UiBuilder;

use super::{code_glyph, HudAction, HudState, Icons, LifeHud, Palette, PERMANENT_WINDOWS};

pub const SLOT_COUNT: usize = 12;
pub const SLOT_PX: f32 = 46.0;
const SLOT_GAP: f32 = 6.0;
const GROUP_GAP: f32 = 14.0;
/// Band under each slot carrying its hotkey label, as the original prints
/// `F1`..`F12` beneath the bar rather than inside the slot face.
const KEY_LABEL_H: f32 = 12.0;
const FLASH_MS: u64 = 1600;

pub const DEFAULT_BINDS: [&str; SLOT_COUNT] = [
    "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9",
    "Digit0", "Minus", "Equal",
];

// ── Action registry (port of TOOLBAR_ACTIONS) ───────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ActionKind {
    /// A gameplay verb — the host routes it through `game::actions`.
    Verb,
    /// A window shortcut (permanent dock destinations only).
    Window(&'static str),
}

#[derive(Clone, Copy, Debug)]
pub struct ToolbarAction {
    pub id: &'static str,
    /// Full label — slot tooltip + Action Browser name.
    pub label: &'static str,
    /// Atlas icon id.
    pub icon: &'static str,
    /// One-line Action Browser description.
    pub description: &'static str,
    pub kind: ActionKind,
}

/// The bindable verb set for the 12-slot bar. Window shortcuts cover the
/// PERMANENT dock destinations only.
pub const TOOLBAR_ACTIONS: [ToolbarAction; 14] = [
    ToolbarAction {
        id: "attack",
        label: "ATTACK",
        icon: "crosshair",
        description: "STRIKE THE CURRENT TARGET.",
        kind: ActionKind::Verb,
    },
    ToolbarAction {
        id: "kneel",
        label: "KNEEL",
        icon: "kneel",
        description: "DROP TO A KNEEL.",
        kind: ActionKind::Verb,
    },
    ToolbarAction {
        id: "stand",
        label: "STAND",
        icon: "stand",
        description: "RETURN TO STANDING.",
        kind: ActionKind::Verb,
    },
    ToolbarAction {
        id: "survey",
        label: "TOOL SURVEY",
        icon: "survey",
        description: "CHOOSE A RESOURCE FAMILY.",
        kind: ActionKind::Window("survey"),
    },
    ToolbarAction {
        id: "sample",
        label: "HAND SAMPLE",
        icon: "sample",
        description: "TAKE A SMALL RESOURCE SAMPLE.",
        kind: ActionKind::Window("survey"),
    },
    ToolbarAction {
        id: "reload",
        label: "RELOAD",
        icon: "reload",
        description: "RELOAD THE EQUIPPED WEAPON.",
        kind: ActionKind::Verb,
    },
    ToolbarAction {
        id: "peace",
        label: "STAND DOWN",
        icon: "peace",
        description: "CEASE FIRE AND DISENGAGE.",
        kind: ActionKind::Verb,
    },
    ToolbarAction {
        id: "clone",
        label: "ACTIVATE CLONE",
        icon: "clone",
        description: "RESPAWN AT NEAREST CLONE.",
        kind: ActionKind::Verb,
    },
    ToolbarAction {
        id: "window:inventory",
        label: "INVENTORY",
        icon: "inventory",
        description: "OPEN YOUR FIELD KIT.",
        kind: ActionKind::Window("inventory"),
    },
    ToolbarAction {
        id: "window:character",
        label: "CHARACTER",
        icon: "character",
        description: "OPEN YOUR CHARACTER SHEET.",
        kind: ActionKind::Window("character"),
    },
    ToolbarAction {
        id: "window:skills",
        label: "SKILLS",
        icon: "skills",
        description: "OPEN THE PROFESSION SKILL TREE.",
        kind: ActionKind::Window("skills"),
    },
    ToolbarAction {
        id: "window:datapad",
        label: "DATAPAD",
        icon: "datapad",
        description: "OPEN THE FIELD DATAPAD.",
        kind: ActionKind::Window("datapad"),
    },
    ToolbarAction {
        id: "window:macros",
        label: "MACROS",
        icon: "macro",
        description: "AUTHOR AND RUN COMMAND SCRIPTS.",
        kind: ActionKind::Window("macros"),
    },
    ToolbarAction {
        id: "window:options",
        label: "OPTIONS",
        icon: "options",
        description: "OPEN DISPLAY + INPUT OPTIONS.",
        kind: ActionKind::Window("options"),
    },
];

pub fn action_by_id(id: &str) -> Option<&'static ToolbarAction> {
    TOOLBAR_ACTIONS.iter().find(|a| a.id == id)
}

/// Whether `id` is a registered toolbar action — the migration gate for
/// stale persisted slots (removed verbs fall out on load).
pub fn is_valid_action_id(id: &str) -> bool {
    action_by_id(id).is_some()
}

// ── Persisted doc (schema 3) ────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
pub enum SlotRef {
    Action(String),
    Item(String),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct ToolbarDoc {
    pub slots: Vec<Option<SlotRef>>,
    pub binds: Vec<String>,
}

impl ToolbarDoc {
    /// Blank default: all-empty slots, number-row binds.
    pub fn blank() -> Self {
        Self {
            slots: vec![None; SLOT_COUNT],
            binds: DEFAULT_BINDS.iter().map(|s| s.to_string()).collect(),
        }
    }

    /// Read + migrate a stored doc section. Corrupt/missing → blank default;
    /// invalid action ids become empty slots; binds fall back per slot.
    pub fn load(section: Option<&Value>) -> Self {
        let mut doc = Self::blank();
        let Some(v) = section else { return doc };
        if let Some(slots) = v.get("slots").and_then(|s| s.as_array()) {
            for (i, raw) in slots.iter().take(SLOT_COUNT).enumerate() {
                doc.slots[i] = migrate_slot(raw);
            }
        }
        if let Some(binds) = v.get("binds").and_then(|s| s.as_array()) {
            for (i, raw) in binds.iter().take(SLOT_COUNT).enumerate() {
                if let Some(code) = raw.as_str() {
                    if !code.is_empty() {
                        doc.binds[i] = code.to_string();
                    }
                }
            }
        }
        doc
    }

    /// Serialize to the schema-3 section value.
    pub fn save(&self) -> Value {
        let slots: Vec<Value> = self
            .slots
            .iter()
            .map(|s| match s {
                Some(SlotRef::Action(id)) => json!({"kind": "action", "id": id}),
                Some(SlotRef::Item(item_id)) => json!({"kind": "item", "itemId": item_id}),
                None => Value::Null,
            })
            .collect();
        json!({"schema": 3, "slots": slots, "binds": self.binds})
    }

    /// Assign a ref to a slot (browser/inventory → slot drop).
    pub fn assign(&mut self, slot: usize, slot_ref: SlotRef) {
        if slot < self.slots.len() {
            self.slots[slot] = Some(slot_ref);
        }
    }

    /// Move a ref between slots, swapping if the target is occupied.
    pub fn move_or_swap(&mut self, from: usize, to: usize) {
        if from == to || from >= self.slots.len() || to >= self.slots.len() {
            return;
        }
        if self.slots[from].is_none() {
            return;
        }
        self.slots.swap(from, to);
    }

    pub fn clear(&mut self, slot: usize) {
        if slot < self.slots.len() {
            self.slots[slot] = None;
        }
    }
}

fn migrate_slot(raw: &Value) -> Option<SlotRef> {
    if let Some(id) = raw.as_str() {
        // Legacy v1 shape: a bare action id string.
        return is_valid_action_id(id).then(|| SlotRef::Action(id.to_string()));
    }
    let kind = raw.get("kind")?.as_str()?;
    match kind {
        "action" => {
            let id = raw.get("id")?.as_str()?;
            is_valid_action_id(id).then(|| SlotRef::Action(id.to_string()))
        }
        "item" => {
            let item_id = raw.get("itemId")?.as_str()?;
            (!item_id.is_empty()).then(|| SlotRef::Item(item_id.to_string()))
        }
        _ => None,
    }
}

// ── Live toolbar state ──────────────────────────────────────────────────────

/// Transient interaction state layered over the persisted doc.
pub struct Toolbar {
    pub doc: ToolbarDoc,
    /// Slot index a drag started from (move/swap/clear on release).
    drag_from: Option<usize>,
    drag_started: bool,
    /// OPTIONS-initiated pending key capture for a slot bind.
    pub rebind_slot: Option<usize>,
    /// Action Browser pending assignment: next slot click assigns this id.
    pub pending_assign: Option<String>,
    /// Receipt flash line above the bar.
    flash_text: String,
    flash_bad: bool,
    flash_until_ms: u64,
    /// Last drawn slot rects (for release routing).
    slot_rects: [[f32; 4]; SLOT_COUNT],
    bar_rect: [f32; 4],
}

impl Toolbar {
    pub fn new(doc: ToolbarDoc) -> Self {
        Self {
            doc,
            drag_from: None,
            drag_started: false,
            rebind_slot: None,
            pending_assign: None,
            flash_text: String::new(),
            flash_bad: false,
            flash_until_ms: 0,
            slot_rects: [[0.0; 4]; SLOT_COUNT],
            bar_rect: [0.0; 4],
        }
    }

    /// Flash a receipt line above the bar (`ATTACK QUEUED`, `DENIED · RANGE`).
    pub fn flash(&mut self, text: &str, bad: bool, now_ms: u64) {
        self.flash_text.clear();
        self.flash_text.push_str(text);
        self.flash_bad = bad;
        self.flash_until_ms = now_ms + FLASH_MS;
    }

    /// OPTIONS window: begin capture for a slot bind (Esc cancels).
    pub fn begin_rebind(&mut self, slot: usize) {
        if slot < SLOT_COUNT {
            self.rebind_slot = Some(slot);
        }
    }

    /// Feed a key code while a rebind capture is pending. Returns true when
    /// the code was consumed (capture ends). `Escape` cancels.
    pub fn feed_rebind_code(&mut self, code: &str) -> bool {
        let Some(slot) = self.rebind_slot else {
            return false;
        };
        self.rebind_slot = None;
        if code == "Escape" {
            return true;
        }
        if slot < self.doc.binds.len() {
            self.doc.binds[slot] = code.to_string();
        }
        true
    }

    /// Hotkey path: execute the slot bound to `code`. Returns the resolved
    /// action; `None` when no slot consumes the code.
    pub fn press_code(&mut self, code: &str, out: &mut Vec<HudAction>) -> bool {
        if self.rebind_slot.is_some() {
            let consumed = self.feed_rebind_code(code);
            if consumed {
                out.push(HudAction::ToolbarChanged);
            }
            return consumed;
        }
        let Some(slot) = self.doc.binds.iter().position(|b| b == code) else {
            return false;
        };
        self.activate(slot, out)
    }

    /// Resolve one slot activation into a HUD action.
    pub fn activate(&self, slot: usize, out: &mut Vec<HudAction>) -> bool {
        match self.doc.slots.get(slot).and_then(|s| s.as_ref()) {
            Some(SlotRef::Action(id)) => match action_by_id(id) {
                Some(action) => {
                    match action.kind {
                        ActionKind::Verb => out.push(HudAction::RunVerb(action.id)),
                        ActionKind::Window(window_id) => {
                            out.push(HudAction::ToggleWindow(window_id))
                        }
                    }
                    true
                }
                None => false,
            },
            Some(SlotRef::Item(item_id)) => {
                out.push(HudAction::UseToolbarItem(item_id.clone()));
                true
            }
            None => false,
        }
    }
}

// ── Drawing ─────────────────────────────────────────────────────────────────

/// Right-edge dock rail: one button per PERMANENT window with a hotkey glyph
/// beneath, plus the theme-cycle swatch at the rail bottom.
#[allow(clippy::too_many_arguments)]
pub fn draw_dock(
    ui: &mut UiBuilder,
    icons: &Icons,
    pal: &Palette,
    _toolbar: &Toolbar,
    rail: [f32; 4],
    captured: bool,
    out: &mut Vec<HudAction>,
) {
    let btn = rail[2];
    let count = PERMANENT_WINDOWS.len() as f32;
    // Buttons plus the theme swatch share the rail height, so the rail keeps a
    // stable footprint at every framebuffer.
    let step = ((rail[3] - btn * 0.5) / (count + 0.5)).max(btn + 2.0);
    let x = rail[0];
    let mut y = rail[1];
    let gap = (step - btn).max(2.0);
    for (id, title, icon, hotkey) in PERMANENT_WINDOWS.iter() {
        let resp = ui.interact(x, y, btn, btn);
        let fill = if resp.hovered {
            pal.accent_soft
        } else {
            pal.bg_panel
        };
        ui.rect(x, y, btn, btn, fill);

        if let Some((col, row)) = icons.cell(icon) {
            ui.icon(col, row, x + 6.0, y + 6.0, btn - 12.0, btn - 12.0, pal.ink);
        }
        ui.text(
            code_glyph(hotkey),
            x + btn * 0.5 - 3.0,
            y + btn + 1.0,
            1.2,
            pal.ink_dim,
        );
        if resp.hovered {
            // Tooltip: title to the left of the rail.
            let tw = ui.measure_text(title, 1.5);
            ui.rect(x - tw - 14.0, y + 8.0, tw + 10.0, 14.0, pal.bg_panel);
            ui.text(title, x - tw - 9.0, y + 11.0, 1.5, pal.ink);
        }
        if resp.clicked && !captured {
            out.push(HudAction::ToggleWindow(id));
        }
        y += btn + gap;
    }
    // Theme-cycle swatch (OPTIONS keeps the full named picker).
    let resp = ui.interact(x, y + gap, btn, btn * 0.5);
    ui.rect(x, y + gap, btn, btn * 0.5, pal.accent);

    if resp.clicked && !captured {
        out.push(HudAction::CycleTheme);
    }
}

/// The 12-slot toolbar. Handles click activation, drag move/swap/clear,
/// right-click clear, pending Action-Browser assignment, hotkey badges,
/// unavailable overlays and the receipt flash line.
#[allow(clippy::too_many_arguments)]
pub fn draw_toolbar(
    ui: &mut UiBuilder,
    icons: &Icons,
    pal: &Palette,
    toolbar: &mut Toolbar,
    st: &HudState,
    bar: [f32; 4],
    captured: bool,
    right_pressed: bool,
    now_ms: u64,
    out: &mut Vec<HudAction>,
) {
    let groups = 3usize;
    let per_group = 4usize;
    let nominal = (SLOT_COUNT as f32) * SLOT_PX
        + ((SLOT_COUNT - groups) as f32) * SLOT_GAP
        + ((groups - 1) as f32) * GROUP_GAP;
    // The bar keeps a stable slot footprint; it only shifts, never restyles.
    let x0 = bar[0] + (bar[2] - nominal) * 0.5;
    // The slot row and its key labels are one block, centred in the bar rect.
    let y = bar[1] + (bar[3] - (SLOT_PX + KEY_LABEL_H)) * 0.5;
    toolbar.bar_rect = [bar[0], bar[1], bar[2], bar[3]];

    let (mx, my) = ui.mouse();
    let verbs_locked = st.life != LifeHud::Alive;

    let mut slot_x = x0;
    for slot in 0..SLOT_COUNT {
        if slot > 0 {
            slot_x += SLOT_PX
                + if slot % per_group == 0 {
                    GROUP_GAP
                } else {
                    SLOT_GAP
                };
        }
        toolbar.slot_rects[slot] = [slot_x, y, SLOT_PX, SLOT_PX];
        let resp = ui.interact(slot_x, y, SLOT_PX, SLOT_PX);
        let occupied = toolbar.doc.slots[slot].is_some();
        let assigning = toolbar.pending_assign.is_some();
        // Every slot keeps a visible cell, as the original bar does: the twelve
        // cells are the bar. An empty cell is just a quieter seat.
        let mut empty_seat = pal.bg_panel;
        empty_seat[3] = 205;
        let fill = if resp.hovered && (occupied || assigning) {
            pal.accent_soft
        } else if occupied {
            pal.bg_panel
        } else {
            empty_seat
        };
        ui.rect(slot_x, y, SLOT_PX, SLOT_PX, fill);
        ui.border(slot_x, y, SLOT_PX, SLOT_PX, 1.0, pal.hairline);
        if assigning && resp.hovered {
            ui.rect(slot_x, y + SLOT_PX - 2.0, SLOT_PX, 2.0, pal.accent);
        }

        // Glyph.
        match toolbar.doc.slots[slot].as_ref() {
            Some(SlotRef::Action(id)) => {
                if let Some(action) = action_by_id(id) {
                    if let Some((col, row)) = icons.cell(action.icon) {
                        let tint = if verbs_locked && action.kind == ActionKind::Verb {
                            pal.ink_dim
                        } else {
                            pal.ink
                        };
                        ui.icon(
                            col,
                            row,
                            slot_x + 8.0,
                            y + 8.0,
                            SLOT_PX - 16.0,
                            SLOT_PX - 16.0,
                            tint,
                        );
                    }
                    if resp.hovered && toolbar.drag_from.is_none() {
                        let tw = ui.measure_text(action.label, 1.5);
                        ui.rect(mx - tw * 0.5 - 5.0, y - 22.0, tw + 10.0, 15.0, pal.bg_panel);
                        ui.text(action.label, mx - tw * 0.5, y - 19.0, 1.5, pal.ink);
                    }
                }
            }
            Some(SlotRef::Item(_)) => {
                if let Some((col, row)) = icons.cell("item-item") {
                    ui.icon(
                        col,
                        row,
                        slot_x + 8.0,
                        y + 8.0,
                        SLOT_PX - 16.0,
                        SLOT_PX - 16.0,
                        pal.ink,
                    );
                }
            }
            None => {}
        }

        // Hotkey label under the slot, as the original prints F1..F12 beneath
        // the bar. The glyph keeps a small dark seat so it stays legible over
        // bright terrain without boxing the slot itself.
        let key = code_glyph(&toolbar.doc.binds[slot]);
        let key_w = ui.measure_text(key, 1.3);
        let key_x = slot_x + (SLOT_PX - key_w) * 0.5;
        let mut key_backing = pal.bg_panel;
        key_backing[3] = 200;
        ui.rect(
            key_x - 3.0,
            y + SLOT_PX + 1.0,
            key_w + 6.0,
            KEY_LABEL_H - 2.0,
            key_backing,
        );
        ui.text(key, key_x, y + SLOT_PX + 3.0, 1.3, pal.accent);

        // Unavailable overlay for verbs while down/dead.
        if verbs_locked {
            if let Some(SlotRef::Action(id)) = toolbar.doc.slots[slot].as_ref() {
                if action_by_id(id).map(|a| a.kind == ActionKind::Verb) == Some(true) {
                    ui.rect(slot_x, y, SLOT_PX, SLOT_PX, [10, 10, 10, 140]);
                }
            }
        }

        if captured {
            continue;
        }

        // Right-click clears a filled slot.
        if right_pressed && resp.hovered && occupied {
            toolbar.doc.clear(slot);
            out.push(HudAction::ToolbarChanged);
            continue;
        }

        // Press starts a potential drag from a filled slot.
        if resp.pressed && occupied && toolbar.pending_assign.is_none() {
            toolbar.drag_from = Some(slot);
            toolbar.drag_started = false;
        }
    }

    // Drag tracking: any movement past a threshold turns the press into a drag.
    if let Some(from) = toolbar.drag_from {
        let [fx, fy, _, _] = toolbar.slot_rects[from];
        if !toolbar.drag_started
            && ((mx - fx - SLOT_PX * 0.5).abs() > 10.0 || (my - fy - SLOT_PX * 0.5).abs() > 10.0)
        {
            toolbar.drag_started = true;
        }
        if toolbar.drag_started {
            // Ghost glyph under the cursor.
            ui.rect(mx - 12.0, my - 12.0, 24.0, 24.0, pal.accent_soft);
        }
    }

    // Release routing: click-activate, drop move/swap, drop-off clear, assign.
    // Screen-wide release: a drop anywhere resolves the drag, including a drop
    // off the bar (which clears the source slot).
    let released = ui
        .interact(f32::MIN * 0.5, f32::MIN * 0.5, f32::MAX, f32::MAX)
        .released;
    if released && !captured {
        let target_slot = (0..SLOT_COUNT).find(|&i| {
            let [rx, ry, rw, rh] = toolbar.slot_rects[i];
            UiBuilder::hit(rx, ry, rw, rh, mx, my)
        });
        if let Some(assign_id) = toolbar.pending_assign.clone() {
            if let Some(slot) = target_slot {
                toolbar.doc.assign(slot, SlotRef::Action(assign_id));
                toolbar.pending_assign = None;
                out.push(HudAction::ToolbarChanged);
            }
        } else if let Some(from) = toolbar.drag_from.take() {
            if toolbar.drag_started {
                match target_slot {
                    Some(to) if to != from => {
                        toolbar.doc.move_or_swap(from, to);
                        out.push(HudAction::ToolbarChanged);
                    }
                    Some(_) => {}
                    None => {
                        // Dropped off the bar → clear the source slot.
                        toolbar.doc.clear(from);
                        out.push(HudAction::ToolbarChanged);
                    }
                }
                toolbar.drag_started = false;
            } else if target_slot == Some(from) {
                // Plain click: activate.
                toolbar.activate(from, out);
            }
        }
    }

    // Receipt flash line (drawn above the bar).
    if !toolbar.flash_text.is_empty() && toolbar.flash_until_ms > now_ms {
        let tint = if toolbar.flash_bad {
            pal.danger
        } else {
            pal.accent
        };
        let tw = ui.measure_text(&toolbar.flash_text, 1.6);
        ui.text(
            &toolbar.flash_text,
            bar[0] + (bar[2] - tw) * 0.5,
            y - 20.0,
            1.6,
            tint,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blank_doc_matches_owner_spec() {
        let doc = ToolbarDoc::blank();
        assert_eq!(doc.slots.len(), SLOT_COUNT);
        assert!(doc.slots.iter().all(|s| s.is_none()));
        assert_eq!(doc.binds[0], "Digit1");
        assert_eq!(doc.binds[9], "Digit0");
        assert_eq!(doc.binds[10], "Minus");
        assert_eq!(doc.binds[11], "Equal");
    }

    #[test]
    fn load_strips_invalid_action_ids_and_keeps_items() {
        let section = json!({
            "schema": 3,
            "slots": [
                {"kind": "action", "id": "attack"},
                {"kind": "action", "id": "aimed_shot"},
                {"kind": "item", "itemId": "medkit-4"},
                "reload",
                "removed_verb",
                null
            ],
            "binds": ["KeyQ", "", 7]
        });
        let doc = ToolbarDoc::load(Some(&section));
        assert_eq!(doc.slots[0], Some(SlotRef::Action("attack".into())));
        assert_eq!(doc.slots[1], None, "removed verbs are stripped on load");
        assert_eq!(doc.slots[2], Some(SlotRef::Item("medkit-4".into())));
        assert_eq!(
            doc.slots[3],
            Some(SlotRef::Action("reload".into())),
            "legacy string slots promote"
        );
        assert_eq!(doc.slots[4], None);
        assert_eq!(doc.binds[0], "KeyQ");
        assert_eq!(doc.binds[1], "Digit2", "empty bind falls back to default");
        assert_eq!(doc.binds[2], "Digit3", "non-string bind falls back");
    }

    #[test]
    fn save_round_trips() {
        let mut doc = ToolbarDoc::blank();
        doc.assign(0, SlotRef::Action("peace".into()));
        doc.assign(5, SlotRef::Item("chip-9".into()));
        doc.binds[3] = "KeyT".into();
        let reloaded = ToolbarDoc::load(Some(&doc.save()));
        assert_eq!(reloaded, doc);
        assert_eq!(doc.save()["schema"], 3);
    }

    #[test]
    fn move_or_swap_rules() {
        let mut doc = ToolbarDoc::blank();
        doc.assign(0, SlotRef::Action("attack".into()));
        doc.assign(1, SlotRef::Action("peace".into()));
        // Occupied target → swap.
        doc.move_or_swap(0, 1);
        assert_eq!(doc.slots[0], Some(SlotRef::Action("peace".into())));
        assert_eq!(doc.slots[1], Some(SlotRef::Action("attack".into())));
        // Empty target → move.
        doc.move_or_swap(1, 4);
        assert_eq!(doc.slots[1], None);
        assert_eq!(doc.slots[4], Some(SlotRef::Action("attack".into())));
        // Empty source / out-of-range → no-op.
        doc.move_or_swap(7, 8);
        doc.move_or_swap(0, 99);
        assert_eq!(doc.slots[0], Some(SlotRef::Action("peace".into())));
    }

    #[test]
    fn press_code_activates_and_rebind_captures() {
        let mut doc = ToolbarDoc::blank();
        doc.assign(0, SlotRef::Action("attack".into()));
        doc.assign(1, SlotRef::Action("window:options".into()));
        doc.assign(2, SlotRef::Item("stim-1".into()));
        let mut tb = Toolbar::new(doc);
        let mut out = Vec::new();
        assert!(tb.press_code("Digit1", &mut out));
        assert!(tb.press_code("Digit2", &mut out));
        assert!(tb.press_code("Digit3", &mut out));
        assert!(
            !tb.press_code("Digit4", &mut out),
            "empty slot consumes nothing"
        );
        assert!(
            !tb.press_code("KeyZ", &mut out),
            "unbound code passes through"
        );
        assert_eq!(
            out,
            vec![
                HudAction::RunVerb("attack"),
                HudAction::ToggleWindow("options"),
                HudAction::UseToolbarItem("stim-1".into()),
            ]
        );
        // Rebind capture: next code lands in the bind; Escape cancels.
        out.clear();
        tb.begin_rebind(4);
        assert!(tb.press_code("KeyH", &mut out));
        assert_eq!(tb.doc.binds[4], "KeyH");
        assert_eq!(out, vec![HudAction::ToolbarChanged]);
        tb.begin_rebind(5);
        assert!(tb.feed_rebind_code("Escape"));
        assert_eq!(tb.doc.binds[5], "Digit6", "escape keeps the old bind");
    }

    #[test]
    fn registry_covers_reference_set() {
        for id in [
            "attack",
            "kneel",
            "stand",
            "survey",
            "sample",
            "reload",
            "peace",
            "clone",
            "window:inventory",
            "window:character",
            "window:skills",
            "window:datapad",
            "window:macros",
            "window:options",
        ] {
            assert!(is_valid_action_id(id), "missing registry action {id}");
        }
        assert!(!is_valid_action_id("aimed_shot"), "Aim stays removed");
    }
}
