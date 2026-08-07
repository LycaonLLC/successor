//! Window content: the per-surface layouts drawn inside `WindowManager` frames.
//!
//! [`content`] is the single dispatch point. It resolves the id to its
//! [`spec::Surface`] (family, tabs, geometry, chrome density), draws the shared
//! header and tab strip, then hands the surface a [`Ctx`] carrying the body rect
//! and the active tab. Surfaces are read-only over a typed [`WindowModel`]
//! (projected from the authority store in the connected client), so content
//! rendering stays deterministic, unit-testable, and free of transport concerns.
//!
//! Routing is total over the registry: [`spec::route`] maps every registered id
//! to a [`spec::Route`] and the match below is exhaustive over that enum, so a
//! new surface cannot silently fall through to a stub.

use successor_engine_render::ui::UiBuilder;

pub mod chrome;
pub mod live;
pub mod model;
pub mod project;
pub mod spec;

pub use model::*;

/// Intents a window emits; the host translates them into `ClientCommand`s.
#[derive(Clone, Debug, PartialEq)]
pub enum WindowAction {
    /// The canonical live path: an exact shared wire command with its full
    /// typed payload, built by the window from projected authority state.
    /// `resolve()` forwards it verbatim through `CommandQueue`; development-only
    /// commands are refused on this path.
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
    /// Open a window by id (action browser → context surface, dock routes).
    OpenWindow(String),
    /// Right-click on an inventory card: the host opens the object radial over
    /// this exact stack (`SwgCuiInventory::openSelectedRadial`). The window has
    /// already made the stack the live selection, so the footer and the radial
    /// address the same object.
    OpenInventoryRadial {
        container: String,
        stack_id: String,
    },
    /// Theme swatch pick (index into `hud::THEMES`).
    SetTheme(usize),
    /// Live session dust/edge-fog dial (0..1, 0.05 grid).
    SetDust(f32),
    /// Window fill opacity scale (0.35..=1.0).
    SetWindowOpacity(f32),
    /// HUD fill opacity scale (0.35..=1.0).
    SetHudOpacity(f32),
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
    /// Host opens the inventory object radial over this stack.
    OpenInventoryRadial {
        container: String,
        stack_id: String,
    },
    SetTheme(usize),
    SetDust(f32),
    SetWindowOpacity(f32),
    SetHudOpacity(f32),
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
                // Release builds refuse debug commands outright. Under
                // `dev-tools` they pass, because that is the only build where
                // the character builder exists to emit them - and the authority
                // still refuses them unless GAME_DEBUG_AUTHORITY_COMMANDS is
                // set, so this is the outer of two independent gates.
                #[cfg(not(feature = "dev-tools"))]
                if command.is_debug_only() {
                    return WindowActionResult::Rejected(
                        "debug commands are development-gated".into(),
                    );
                }
                WindowActionResult::Command(command)
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
            OpenInventoryRadial {
                container,
                stack_id,
            } => WindowActionResult::Local(WindowLocalAction::OpenInventoryRadial {
                container,
                stack_id,
            }),
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
            SetWindowOpacity(v) => WindowActionResult::Local(WindowLocalAction::SetWindowOpacity(v)),
            SetHudOpacity(v) => WindowActionResult::Local(WindowLocalAction::SetHudOpacity(v)),
            ExchangeRetrieve(_) | ExchangeStore(_) => {
                WindowActionResult::Rejected("exchange requires item variant and quantity".into())
            }
        }
    }
}

pub mod bugreport;
pub mod character;
pub mod commands;
pub mod inventory;
pub mod options;
pub mod skills;

/// What a surface needs to draw its body: its family spec, the content rect
/// below the shared header/tab strip, and the active tab.
#[derive(Clone, Copy)]
pub struct Ctx {
    pub spec: &'static spec::Surface,
    /// Body rect `[x, y, w, h]` — already inset below the header and tabs.
    pub rect: [f32; 4],
    /// Active tab index (0 when the surface owns no tabs).
    pub tab: usize,
}

impl Ctx {
    pub fn metrics(&self) -> spec::Metrics {
        self.spec.metrics()
    }
}

/// Active tab for a surface. Window-local UI state, never authority state.
pub fn active_tab(route: spec::Route) -> usize {
    TAB_STATE.with(|tabs| tabs.borrow()[route as usize] as usize)
}

pub fn set_active_tab(route: spec::Route, tab: usize) {
    TAB_STATE.with(|tabs| tabs.borrow_mut()[route as usize] = tab.min(u8::MAX as usize) as u8);
}

/// Dispatch content for the window `id` into `ui`.
pub fn content(
    ui: &mut UiBuilder,
    id: &str,
    rect: [f32; 4],
    model: &WindowModel,
    icons: &crate::hud::Icons,
    out: &mut Vec<WindowAction>,
) {
    let (Some(surface), Some(route)) = (spec::surface(id), spec::route(id)) else {
        // Unreachable for a registered id (`spec::route` is total over the
        // registry and tested); named loudly so an unmapped surface reads as a
        // defect instead of a blank pane.
        ui.text(
            "UNMAPPED SURFACE",
            rect[0] + 6.0,
            rect[1] + 6.0,
            chrome::scale(chrome::VALUE_PX),
            chrome::warn(),
        );
        ui.text(
            id,
            rect[0] + 6.0,
            rect[1] + 6.0 + chrome::ROW_H,
            chrome::scale(chrome::LABEL_PX),
            dim(),
        );
        return;
    };

    // The compact static panes receive a host-built body context. Authority-
    // backed live panes own the same shared header/tab primitives internally
    // because their tab state and footer reservations are pane-local.
    let host_owns_chrome = matches!(
        route,
        spec::Route::Character
            | spec::Route::Skills
            | spec::Route::CommandBrowser
            | spec::Route::Options
            | spec::Route::Report
    );
    let mut body = rect;
    if host_owns_chrome && surface.header {
        let y = chrome::header(ui, rect, surface);
        body = [rect[0], y, rect[2], (rect[1] + rect[3] - y).max(0.0)];
    }
    if host_owns_chrome && !surface.tabs.is_empty() {
        if let Some(next) = chrome::tabs(
            ui,
            body[0],
            body[1],
            body[2],
            surface.tabs,
            active_tab(route),
        ) {
            set_active_tab(route, next);
        }
        let step = chrome::TAB_H + 8.0;
        body = [body[0], body[1] + step, body[2], (body[3] - step).max(0.0)];
    }
    let ctx = Ctx {
        spec: surface,
        rect: body,
        tab: active_tab(route),
    };

    match route {
        spec::Route::Inventory => inventory::draw(ui, body, model, icons, out),
        spec::Route::Character => character::draw(ui, ctx, model, icons, out),
        spec::Route::Skills => skills::draw(ui, ctx, model, icons, out),
        spec::Route::CommandBrowser => commands::draw(ui, ctx, icons, out),
        spec::Route::Options => {
            OPTIONS_MODEL.with(|options| options::draw(ui, ctx, &options.borrow(), icons, out));
        }
        spec::Route::Report => {
            BUG_MODEL.with(|bug| bugreport::draw(ui, ctx, &mut bug.borrow_mut(), icons, out));
        }
        spec::Route::Datapad => live::datapad(ui, ctx, model, out),
        spec::Route::Macros => live::macros_live(ui, ctx, model, out),
        spec::Route::Association => live::guild(ui, ctx, model, out),
        spec::Route::Group => live::group(ui, ctx, model, out),
        spec::Route::Craft => live::craft(ui, ctx, model, out),
        spec::Route::Splice => live::splice(ui, ctx, model, out),
        spec::Route::Converse => live::converse(ui, ctx, model, out),
        spec::Route::Trade => live::trade(ui, ctx, model, out),
        spec::Route::Examine => live::examine(ui, ctx, model, out),
        spec::Route::Survey => live::survey(ui, ctx, model, out),
        spec::Route::Travel => live::travel(ui, ctx, model, out),
        spec::Route::Loot => live::loot(ui, ctx, model, out),
        spec::Route::Bank => live::bank(ui, ctx, model, out),
        spec::Route::Clone => live::clone_terminal(ui, ctx, model, out),
        spec::Route::Structure => live::agriculture(ui, ctx, model, out),
    }
}

// Per-window interactive state for the section-7 windows. Interim home until
// the shared `WindowUiState` threading lands — dispatch stays immutable-model
// for every other window.
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
    /// One tab index per `spec::Route`.
    static TAB_STATE: core::cell::RefCell<[u8; 32]> = const { core::cell::RefCell::new([0; 32]) };
}

// ── Shared ink ──────────────────────────────────────────────────────────────
// Measured from the original dense-window crops (8-level quantization) and the
// original frame includes, then used as the single palette for every surface.
// Frame and well tones live in [`chrome`]; these are the type colors.

/// Primary body ink.
#[inline]
pub fn text() -> [u8; 4] {
    crate::hud::active_palette().ink
}

/// Row/field labels.
#[inline]
pub fn label() -> [u8; 4] {
    crate::hud::active_palette().ink
}

/// Numeric values and readouts.
#[inline]
pub fn value() -> [u8; 4] {
    crate::hud::active_palette().ink
}

/// Subordinate captions, disabled rows, unavailable notes.
#[inline]
pub fn dim() -> [u8; 4] {
    crate::hud::active_palette().ink_dim
}

/// Active/selected accent (tab underline, selection rail, focus).
#[inline]
pub fn active() -> [u8; 4] {
    crate::hud::active_palette().accent
}

/// Heading accent. Alias of [`active`] so headings and selection agree.
#[inline]
pub fn accent() -> [u8; 4] {
    active()
}

/// Affirmative state (learned skill box, satisfied requirement, gain).
#[inline]
pub fn positive() -> [u8; 4] {
    crate::hud::active_palette().accent
}

/// Recessed slot/cell fill.
#[inline]
pub fn slot() -> [u8; 4] {
    crate::hud::faded(crate::hud::active_palette().bg_cell)
}

/// Slot separator.
#[inline]
pub fn slot_edge() -> [u8; 4] {
    crate::hud::active_palette().hairline
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn theme_indices_produce_distinct_ink_sets() {
        let mut inks = Vec::new();
        for i in 0..crate::hud::THEME_COUNT {
            crate::hud::set_active_palette(crate::hud::palette(i));
            let set = (text(), dim(), active(), slot_edge());
            assert!(!inks.contains(&set), "theme {i} produced duplicate ink set");
            inks.push(set);
        }
        assert_eq!(inks.len(), crate::hud::THEME_COUNT);
    }

    #[test]
    fn faded_affects_fills_but_not_text() {
        crate::hud::set_active_palette(crate::hud::palette(0));
        crate::hud::set_fill_opacity(1.0);
        let slot_full = slot();
        let text_full = text();
        let dim_full = dim();
        let active_full = active();

        crate::hud::set_fill_opacity(0.5);
        let slot_half = slot();
        let text_half = text();
        let dim_half = dim();
        let active_half = active();

        assert!(slot_half[3] < slot_full[3], "fill opacity must scale slot alpha");
        assert_eq!(text_half, text_full, "text ink must not be faded");
        assert_eq!(dim_half, dim_full, "dim ink must not be faded");
        assert_eq!(active_half, active_full, "active ink must not be faded");
    }

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

    #[test]
    fn inventory_radial_stays_a_local_host_route() {
        assert_eq!(
            WindowAction::OpenInventoryRadial {
                container: "player".into(),
                stack_id: "7".into(),
            }
            .resolve(),
            WindowActionResult::Local(WindowLocalAction::OpenInventoryRadial {
                container: "player".into(),
                stack_id: "7".into(),
            })
        );
    }

    #[test]
    fn tab_state_is_per_surface() {
        set_active_tab(spec::Route::Datapad, 2);
        set_active_tab(spec::Route::Bank, 1);
        assert_eq!(active_tab(spec::Route::Datapad), 2);
        assert_eq!(active_tab(spec::Route::Bank), 1);
        assert_eq!(active_tab(spec::Route::Survey), 0);
        set_active_tab(spec::Route::Datapad, 0);
        set_active_tab(spec::Route::Bank, 0);
    }

    /// Every registered surface renders on every tab, at its resize floor, from
    /// an empty projection, without panicking and without drawing nothing.
    #[test]
    fn every_surface_draws_at_its_resize_floor() {
        let icons = crate::hud::Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let model = WindowModel::sample();
        let mut out = Vec::new();
        for surface in &spec::SURFACES {
            let (w, h) = surface.min_size();
            let route = spec::route(surface.id).expect("mapped surface");
            for tab in 0..surface.tabs.len().max(1) {
                set_active_tab(route, tab);
                ui.begin(1280, 720);
                out.clear();
                content(
                    &mut ui,
                    surface.id,
                    [24.0, 24.0, w, h],
                    &model,
                    &icons,
                    &mut out,
                );
                assert!(
                    ui.quads > 0,
                    "{} tab {tab} drew nothing at its resize floor",
                    surface.id
                );
            }
            set_active_tab(route, 0);
        }
    }

    #[test]
    fn an_unmapped_id_is_named_not_blank() {
        let icons = crate::hud::Icons::load();
        let mut ui = UiBuilder::new(icons.meta);
        let model = WindowModel::sample();
        let mut out = Vec::new();
        ui.begin(1280, 720);
        content(
            &mut ui,
            "not-a-surface",
            [0.0, 0.0, 300.0, 200.0],
            &model,
            &icons,
            &mut out,
        );
        assert!(ui.quads > 0, "an unmapped id must still say so on screen");
        assert!(out.is_empty(), "an unmapped id must emit no intents");
    }
}
