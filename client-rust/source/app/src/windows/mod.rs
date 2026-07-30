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

pub mod model;

pub use model::*;

/// Intents a window emits; the host translates them into `ClientCommand`s
/// (Wave 11 wires the live authority path).
#[derive(Clone, Debug, PartialEq)]
pub enum WindowAction {
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
}

pub mod inventory;
pub mod character;
pub mod skills;
pub mod options;
pub mod loot;
pub mod bank;
pub mod trade;
pub mod craft;
pub mod survey;
pub mod converse;
pub mod travel;
pub mod datapad;
pub mod clone;
pub mod pa;
pub mod splice;
pub mod macros;
pub mod actions;
pub mod bugreport;

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
        "options" => options::draw(ui, rect, model, icons, out),
        "loot" => loot::draw(ui, rect, &loot::LootModel::sample(), icons, out),
        "bank" => bank::draw(ui, rect, &bank::BankModel::sample(), icons, out),
        "trade" => trade::draw(ui, rect, &trade::TradeModel::sample(), icons, out),
        "craft" => craft::draw(ui, rect, &craft::CraftModel::sample(), icons, out),
        "survey" => survey::draw(ui, rect, &survey::SurveyModel::sample(), icons, out),
        "converse" => converse::draw(ui, rect, &converse::ConverseModel::sample(), icons, out),
        "travel" => travel::draw(ui, rect, &travel::TravelModel::sample(), icons, out),
        "datapad" => datapad::draw(ui, rect, &datapad::DatapadModel::sample(), icons, out),
        "clone" => clone::draw(ui, rect, &clone::CloneModel::sample(), icons, out),
        "pa" => pa::draw(ui, rect, &pa::PaModel::sample(), icons, out),
        "splice" => splice::draw(ui, rect, &splice::SpliceModel::sample(), icons, out),
        "macros" => macros::draw(ui, rect, &macros::MacrosModel::sample(), icons, out),
        "actions" => actions::draw(ui, rect, &actions::ActionsModel::sample(), icons, out),
        "bug-report" => bugreport::draw(ui, rect, &bugreport::BugReportModel::sample(), icons, out),
        _ => {
            ui.text("NO SIGNAL", rect[0] + 6.0, rect[1] + 6.0, 2.2, TEXT);
        }
    }
}

// Shared chrome palette (mirrors the HUD panel tones).
pub const TEXT: [u8; 4] = [210, 222, 236, 255];
pub const DIM: [u8; 4] = [150, 166, 184, 255];
pub const ACCENT: [u8; 4] = [240, 196, 96, 255];
pub const SLOT: [u8; 4] = [26, 34, 46, 220];
pub const SLOT_EDGE: [u8; 4] = [70, 90, 110, 255];
