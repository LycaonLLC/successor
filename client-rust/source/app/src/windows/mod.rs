//! Window content: the per-window layouts drawn inside `WindowManager` frames.
//!
//! Each window group is a submodule exposing `draw(ui, rect, model, out)`, where
//! `rect = [x, y, w, h]` (px) is the content area the manager returned and `out`
//! collects `WindowAction`s the host maps onto `ClientCommand`s. Windows are
//! read-only over a typed [`WindowModel`] (projected from the authority store in
//! the connected client; the demo seeds it with representative state). This
//! keeps content rendering deterministic + unit-testable and free of transport
//! concerns.

use successor_engine_render::ui::UiBuilder;

pub mod live;
pub mod model;
pub mod project;

pub use model::*;

/// Intents a window emits; the host translates them into `ClientCommand`s
/// (Wave 11 wires the live authority path).
#[derive(Clone, Debug, PartialEq)]
pub enum WindowAction {
    /// The canonical live path: an exact shared wire command with its full
    /// typed payload, built by the window from projected authority state
    /// (`WindowModel` sections carry every id/quantity/variant the command
    /// needs). `resolve()` forwards it verbatim through `CommandQueue`;
    /// development-only commands are refused on this path. Every domain
    /// workflow (inventory/economy, resource/camp/extractor, craft/factory,
    /// progression, dialogue/travel/doors, trade, groups/duels, splice,
    /// farming/building, guild) emits through this variant.
    Command(successor_net::ClientCommand),
    Close,
    UseItem(u32),
    EquipItem(u32),
    DropItem(u32),
    Select(u32),
    SetProfessionTitle(String),
    Deposit(u32, u32),
    Withdraw(u32, u32),
    LootItem(u32),
    LootAll,
    TradeOffer(u32),
    TradeAccept,
    Craft(String),
    Survey,
    DialogueChoice(usize),
    TravelTo(String),
    Toggle(String),
    Button(String),
    // ── Section-7 surfaces (HUD/social/support owner) ──────────────────
    /// Open a window by id (options → action browser link, dock routes).
    OpenWindow(String),
    /// Theme swatch pick (index into `hud::THEMES`).
    SetTheme(usize),
    /// Live session dust/edge-fog dial (0..1, 0.05 grid).
    SetDust(f32),
    /// Inventory default stack-split snap step (1|5|10|100|1000|10000).
    SetSplitSnap(u32),
    /// Begin pending key capture for a toolbar slot (options → toolbar).
    RebindToolbarSlot(usize),
    /// Action browser: begin assign-to-slot for a registry action id.
    BeginAssignAction(String),
    /// Action browser: run a registry action through the public verb path.
    RunActionId(String),
    /// Macro bench intents (engine is host-owned; gates stay in the public
    /// action path).
    RunMacro(String),
    StopMacro(String),
    SaveMacro {
        name: String,
        body: String,
    },
    DeleteMacro(String),
    /// Bug report submit (body already sanitized/bounded) + received reset.
    SubmitBugReport {
        category: String,
        body: String,
    },
    BugReportReset,
    /// Datapad waypoint mutations (character-scoped local store).
    CreateWaypoint {
        x: f32,
        y: f32,
        name: Option<String>,
    },
    RenameWaypoint {
        id: u32,
        name: String,
    },
    SetWaypointActive {
        id: u32,
        active: bool,
    },
    DeleteWaypoint(u32),
    /// Datapad DATA tab exchange routes.
    ExchangeRetrieve(String),
    ExchangeStore(String),
}

/// Result of translating a window intent. Commands are submitted by the host
/// through `CommandQueue`; local intents never touch authority projection.
#[derive(Clone, Debug, PartialEq)]
pub enum WindowActionResult {
    Command(successor_net::ClientCommand),
    Local(WindowLocalAction),
    Rejected(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum WindowLocalAction {
    Close,
    Select(u32),
    OpenWindow(String),
    SetTheme(usize),
    SetDust(f32),
    SetSplitSnap(u32),
    RebindToolbarSlot(usize),
    BeginAssignAction(String),
    RunMacro(String),
    StopMacro(String),
    SaveMacro {
        name: String,
        body: String,
    },
    DeleteMacro(String),
    SubmitBugReport {
        category: String,
        body: String,
    },
    BugReportReset,
    CreateWaypoint {
        x: f32,
        y: f32,
        name: Option<String>,
    },
    RenameWaypoint {
        id: u32,
        name: String,
    },
    SetWaypointActive {
        id: u32,
        active: bool,
    },
    DeleteWaypoint(u32),
}

impl WindowAction {
    /// Translate every window intent without mutating the authority projection.
    /// Context-free legacy intents fail visibly rather than being discarded.
    pub fn resolve(self) -> WindowActionResult {
        use WindowAction::*;
        match self {
            Command(command) => {
                if command.is_debug_only() {
                    WindowActionResult::Rejected("debug commands are development-gated".into())
                } else {
                    WindowActionResult::Command(command)
                }
            }
            Close => WindowActionResult::Local(WindowLocalAction::Close),
            Select(id) => WindowActionResult::Local(WindowLocalAction::Select(id)),
            UseItem(id) => {
                WindowActionResult::Command(successor_net::ClientCommand::UseConsumable {
                    item_id: id.to_string(),
                    item_numeric_id: Some(id),
                    variant_id: None,
                })
            }
            EquipItem(id) => {
                WindowActionResult::Command(successor_net::ClientCommand::SetEquippedWeapon {
                    weapon_id: None,
                    weapon_item_id: Some(id),
                    weapon_variant_id: None,
                })
            }
            DropItem(_) => WindowActionResult::Rejected(
                "discard requires container, stack, and variant".into(),
            ),
            SetProfessionTitle(title) => {
                WindowActionResult::Command(successor_net::ClientCommand::SetProfessionTitle {
                    title_id: Some(title),
                })
            }
            Deposit(stack, quantity) => {
                WindowActionResult::Command(successor_net::ClientCommand::BankStoreItem {
                    source_stack_id: stack.to_string(),
                    quantity,
                })
            }
            Withdraw(stack, quantity) => {
                WindowActionResult::Command(successor_net::ClientCommand::BankRetrieveItem {
                    bank_stack_id: stack.to_string(),
                    quantity,
                })
            }
            LootItem(_) | LootAll => WindowActionResult::Rejected(
                "loot requires an authority container and target".into(),
            ),
            TradeOffer(_) | TradeAccept => WindowActionResult::Rejected(
                "trade requires an authority proposal and item spec".into(),
            ),
            Craft(schematic) => {
                WindowActionResult::Command(successor_net::ClientCommand::CraftItem {
                    schematic_id: schematic,
                    experiment_power: 0,
                    experiment_handling: 0,
                    experiment_reliability: 0,
                })
            }
            Survey => {
                WindowActionResult::Rejected("survey requires a selected resource family".into())
            }
            DialogueChoice(_) => {
                WindowActionResult::Rejected("dialogue choices require an active delivery".into())
            }
            TravelTo(id) => {
                WindowActionResult::Command(successor_net::ClientCommand::EnterTransition {
                    transition_id: id,
                })
            }
            Toggle(_) | Button(_) => {
                WindowActionResult::Rejected("unsupported generic window action".into())
            }
            OpenWindow(id) => WindowActionResult::Local(WindowLocalAction::OpenWindow(id)),
            SetTheme(i) => WindowActionResult::Local(WindowLocalAction::SetTheme(i)),
            SetDust(v) => WindowActionResult::Local(WindowLocalAction::SetDust(v.clamp(0.0, 1.0))),
            SetSplitSnap(v) => WindowActionResult::Local(WindowLocalAction::SetSplitSnap(v)),
            RebindToolbarSlot(i) => {
                WindowActionResult::Local(WindowLocalAction::RebindToolbarSlot(i))
            }
            BeginAssignAction(id) => {
                WindowActionResult::Local(WindowLocalAction::BeginAssignAction(id))
            }
            RunActionId(id) => {
                WindowActionResult::Rejected(format!("action registry dispatch unavailable: {id}"))
            }
            RunMacro(id) => WindowActionResult::Local(WindowLocalAction::RunMacro(id)),
            StopMacro(id) => WindowActionResult::Local(WindowLocalAction::StopMacro(id)),
            SaveMacro { name, body } => {
                WindowActionResult::Local(WindowLocalAction::SaveMacro { name, body })
            }
            DeleteMacro(id) => WindowActionResult::Local(WindowLocalAction::DeleteMacro(id)),
            SubmitBugReport { category, body } => {
                WindowActionResult::Local(WindowLocalAction::SubmitBugReport { category, body })
            }
            BugReportReset => WindowActionResult::Local(WindowLocalAction::BugReportReset),
            CreateWaypoint { x, y, name } => {
                WindowActionResult::Local(WindowLocalAction::CreateWaypoint { x, y, name })
            }
            RenameWaypoint { id, name } => {
                WindowActionResult::Local(WindowLocalAction::RenameWaypoint { id, name })
            }
            SetWaypointActive { id, active } => {
                WindowActionResult::Local(WindowLocalAction::SetWaypointActive { id, active })
            }
            DeleteWaypoint(id) => WindowActionResult::Local(WindowLocalAction::DeleteWaypoint(id)),
            ExchangeRetrieve(_) | ExchangeStore(_) => {
                WindowActionResult::Rejected("exchange requires item variant and quantity".into())
            }
        }
    }
}

pub mod actions;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_actions_are_typed() {
        assert!(matches!(
            WindowAction::UseItem(7).resolve(),
            WindowActionResult::Command(successor_net::ClientCommand::UseConsumable {
                item_numeric_id: Some(7),
                ..
            })
        ));
        assert!(matches!(
            WindowAction::Deposit(9, 2).resolve(),
            WindowActionResult::Command(successor_net::ClientCommand::BankStoreItem {
                quantity: 2,
                ..
            })
        ));
    }

    #[test]
    fn contextless_actions_reject_instead_of_disappearing() {
        assert!(matches!(
            WindowAction::Button("x".into()).resolve(),
            WindowActionResult::Rejected(_)
        ));
        assert!(matches!(
            WindowAction::LootAll.resolve(),
            WindowActionResult::Rejected(_)
        ));
    }
}
pub mod bank;
pub mod bugreport;
pub mod character;
pub mod clone;
pub mod converse;
pub mod craft;
pub mod datapad;
pub mod inventory;
pub mod loot;
pub mod macros;
pub mod options;
pub mod pa;
pub mod skills;
pub mod splice;
pub mod survey;
pub mod trade;
pub mod travel;

/// Dispatch content for the window `id` into `ui`. Unknown ids draw a stub.
pub fn content(
    ui: &mut UiBuilder,
    id: &str,
    rect: [f32; 4],
    model: &WindowModel,
    icons: &crate::hud::Icons,
    out: &mut Vec<WindowAction>,
) {
    match id {
        "inventory" => inventory::draw(ui, rect, model, icons, out),
        "character" => character::draw(ui, rect, model, icons, out),
        "skills" => skills::draw(ui, rect, model, icons, out),
        "options" => {
            OPTIONS_MODEL.with(|m| options::draw(ui, rect, &m.borrow(), icons, out));
        }
        "loot" => live::loot(ui, rect, model, out),
        "bank" => live::bank(ui, rect, model, out),
        "trade" => live::trade(ui, rect, model, out),
        "craft" => live::craft(ui, rect, model, out),
        "survey" => live::survey(ui, rect, model, out),
        "converse" => live::converse(ui, rect, model, out),
        "travel" => live::travel(ui, rect, model, out),
        "datapad" => live::datapad(ui, rect, model, out),
        "clone" => live::clone_terminal(ui, rect, model, out),
        "pa" => live::guild(ui, rect, model, out),
        "splice" => live::splice(ui, rect, model, out),
        "build" => live::agriculture(ui, rect, model, out),
        "macros" => live::macros_live(ui, rect, model, out),
        "actions" => live::group(ui, rect, model, out),
        "examine" => live::examine(ui, rect, model, out),
        "bug-report" => {
            BUG_MODEL.with(|m| bugreport::draw(ui, rect, &mut m.borrow_mut(), icons, out));
        }
        _ => {
            ui.text("NO SIGNAL", rect[0] + 6.0, rect[1] + 6.0, 2.2, TEXT);
        }
    }
}

// Per-window interactive state for the section-7 windows. Interim home until
// the shared `WindowUiState` threading lands with the section-6 rewrite —
// dispatch stays immutable-model for every other window.
pub fn set_bug_report_pending(request_id: String) {
    BUG_MODEL.with(|model| {
        model.borrow_mut().status = bugreport::BugStatus::Pending { request_id };
    });
}

pub fn apply_bug_report_result(payload: &serde_json::Value) {
    BUG_MODEL.with(|model| {
        let mut model = model.borrow_mut();
        let bugreport::BugStatus::Pending { request_id } = &model.status else {
            return;
        };
        if let Some(status) = bugreport::result_for_request(payload, request_id) {
            model.status = status;
        }
    });
}

pub fn reset_bug_report() {
    BUG_MODEL.with(|model| {
        model.borrow_mut().status = bugreport::BugStatus::Idle;
    });
}

pub fn set_options_model(model: options::OptionsModel) {
    OPTIONS_MODEL.with(|state| *state.borrow_mut() = model);
}

thread_local! {
    static OPTIONS_MODEL: core::cell::RefCell<options::OptionsModel> =
        core::cell::RefCell::new(options::OptionsModel::default());
    static BUG_MODEL: core::cell::RefCell<bugreport::BugReportModel> =
        core::cell::RefCell::new(bugreport::BugReportModel::new());
}

// Shared chrome palette (mirrors the HUD panel tones).
pub const TEXT: [u8; 4] = [210, 222, 236, 255];
pub const DIM: [u8; 4] = [150, 166, 184, 255];
pub const ACCENT: [u8; 4] = [240, 196, 96, 255];
pub const SLOT: [u8; 4] = [26, 34, 46, 220];
pub const SLOT_EDGE: [u8; 4] = [70, 90, 110, 255];
