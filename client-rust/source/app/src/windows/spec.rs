//! Surface specs: the in-code mapping from every registered window id to its
//! closest original-SWG mediator family, plus the geometry and chrome metrics
//! that mapping implies.
//!
//! One table drives three things that used to drift apart:
//!   * **geometry** — [`Surface::bounds`] is the registration default and
//!     [`Surface::min_size`] the resize floor (`game::connected_scene`
//!     registers from here, so a spec edit moves the real window),
//!   * **content routing** — [`route`] is total over the registry and
//!     `windows::content` matches [`Route`] exhaustively, so a new id cannot
//!     silently fall through to a stub, and
//!   * **chrome density** — [`Metrics`] fixes row pitch, type sizes, and the
//!     action column, so a list in BANK reads like a list in LOOT.
//!
//! Families name the original mediator they answer to (`swgClientUserInterface`
//! class names). Nothing here imports SWG art or data: the mediator name records
//! *behavioral* intent — what the surface is for, how dense it is, whether it
//! owns tabs — and every pixel is Successor-drawn.

/// Original-client mediator family a Successor surface answers to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Family {
    /// `SwgCuiInventory` + `SwgCuiInventoryEquipment` — volume-page item field
    /// over a live paperdoll, one selected-item action footer.
    InventoryEquipment,
    /// `SwgCuiCharacterSheet` — read-mostly identity/vitals sheet.
    CharacterSheet,
    /// `SwgCuiDataStorage` (datapad) — tabbed pane: waypoints, schematics, data.
    Datapad,
    /// `SwgCuiSkills` — profession tracks with per-box prerequisites.
    SkillTree,
    /// `SwgCuiCommandBrowser` — the bindable command list assigned to the bar.
    CommandBrowser,
    /// `SwgCuiMacroEditor` — name + body editor over a saved-macro list.
    MacroBench,
    /// `SwgCuiOptions` — categorized settings rows.
    Options,
    /// `SwgCuiPlayerAssociation` — guild charter, roster, wars, directory.
    PlayerAssociation,
    /// `SwgCuiGroup` — group roster plus duel challenges.
    GroupRoster,
    /// `SwgCuiCraftAssembly` / `SwgCuiCraftExperiment` — staged bench workflow.
    CraftBench,
    /// Bioengineering bench; behaves as a `SwgCuiCraft*` staged workflow.
    SpliceBench,
    /// `SwgCuiConversation` — NPC portrait, one prose panel, numbered replies.
    Converse,
    /// `SwgCuiTrade` — mirrored two-party panes with a commit rail.
    Trade,
    /// `SwgCuiBugReport` — category + body form with a submit receipt.
    Report,
    /// `SwgCuiExamine` — object viewer over a fixed attribute list.
    Examine,
    /// `SwgCuiSurvey` — resource families, concentration readout, tool verbs.
    Survey,
    /// `SwgCuiTicketPurchase` — destination list priced per row.
    Travel,
    /// `SwgCuiLootBox` — container rows with take / take-all.
    Loot,
    /// `SwgCuiBank` — terminal-gated wallet/vault transfer lists.
    Bank,
    /// `SwgCuiCloneSelect` — clone terminal bind/respawn confirmation.
    Clone,
    /// `SwgCuiPlayerStructure` — deed/land management and placement catalog.
    Structure,
}

impl Family {
    /// Original mediator class this surface answers to (behavioral intent;
    /// surfaced as the header caption's provenance).
    pub const fn mediator(self) -> &'static str {
        match self {
            Self::InventoryEquipment => "SwgCuiInventory",
            Self::CharacterSheet => "SwgCuiCharacterSheet",
            Self::Datapad => "SwgCuiDataStorage",
            Self::SkillTree => "SwgCuiSkills",
            Self::CommandBrowser => "SwgCuiCommandBrowser",
            Self::MacroBench => "SwgCuiMacroEditor",
            Self::Options => "SwgCuiOptions",
            Self::PlayerAssociation => "SwgCuiPlayerAssociation",
            Self::GroupRoster => "SwgCuiGroup",
            Self::CraftBench => "SwgCuiCraftAssembly",
            Self::SpliceBench => "SwgCuiCraftAssembly",
            Self::Converse => "SwgCuiConversation",
            Self::Trade => "SwgCuiTrade",
            Self::Report => "SwgCuiBugReport",
            Self::Examine => "SwgCuiExamine",
            Self::Survey => "SwgCuiSurvey",
            Self::Travel => "SwgCuiTicketPurchase",
            Self::Loot => "SwgCuiLootBox",
            Self::Bank => "SwgCuiBank",
            Self::Clone => "SwgCuiCloneSelect",
            Self::Structure => "SwgCuiPlayerStructure",
        }
    }

    /// Header caption: what the surface is, in the client's own words.
    pub const fn caption(self) -> &'static str {
        match self {
            Self::InventoryEquipment => "FIELD KIT",
            Self::CharacterSheet => "PERSONNEL RECORD",
            Self::Datapad => "FIELD DATAPAD",
            Self::SkillTree => "PROFESSION TRACKS",
            Self::CommandBrowser => "BINDABLE COMMANDS",
            Self::MacroBench => "COMMAND MACROS",
            Self::Options => "CLIENT SETTINGS",
            Self::PlayerAssociation => "GUILD CHARTER",
            Self::GroupRoster => "GROUP / DUEL",
            Self::CraftBench => "FABRICATION",
            Self::SpliceBench => "GENE SEQUENCING",
            Self::Converse => "DIALOGUE",
            Self::Trade => "SECURE TRADE",
            Self::Report => "SUPPORT REPORT",
            Self::Examine => "OBJECT DETAIL",
            Self::Survey => "RESOURCE SURVEY",
            Self::Travel => "TRANSIT",
            Self::Loot => "CONTAINER",
            Self::Bank => "VAULT TERMINAL",
            Self::Clone => "CLONE TERMINAL",
            Self::Structure => "LAND MANAGEMENT",
        }
    }

    /// Chrome density this family carries.
    pub const fn density(self) -> Density {
        match self {
            Self::InventoryEquipment => Density::Grid,
            Self::CharacterSheet | Self::Examine => Density::Sheet,
            Self::Datapad
            | Self::SkillTree
            | Self::CommandBrowser
            | Self::PlayerAssociation
            | Self::GroupRoster
            | Self::Travel
            | Self::Loot
            | Self::Bank
            | Self::Structure
            | Self::Survey => Density::List,
            Self::CraftBench | Self::SpliceBench | Self::Trade => Density::Bench,
            Self::MacroBench | Self::Options | Self::Report => Density::Form,
            Self::Converse | Self::Clone => Density::Dialogue,
        }
    }
}

/// How tightly a surface packs rows, and therefore its type scale.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Density {
    /// Item field of square cards (inventory).
    Grid,
    /// Scannable rows with a right-hand action column.
    List,
    /// Labelled read-mostly blocks (character sheet, examine).
    Sheet,
    /// Staged workflow: slot rows plus a commit rail (craft, splice, trade).
    Bench,
    /// Editors and settings: field rows with generous hit targets.
    Form,
    /// Prose panel plus numbered replies.
    Dialogue,
}

/// Resolved chrome metrics. One place decides row pitch and type scale, so
/// every family reads as the same client at the same distance.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Metrics {
    /// Row pitch, including the row's own gap.
    pub row_h: f32,
    /// Primary row label size.
    pub label_px: f32,
    /// Secondary/qualifier text size.
    pub caption_px: f32,
    /// Section heading size.
    pub heading_px: f32,
    /// Action control height, always centered in its row.
    pub action_h: f32,
    /// Nominal action control width before narrow-width collapse.
    pub action_w: f32,
    /// Space between the content edge and the first glyph.
    pub gutter: f32,
}

impl Density {
    /// Measured original density: generic rows, buttons, and tabs are 19 px,
    /// labels 12 px, values 13 px, primary text fields 32 px
    /// (`ui_options.inc`, `ui_auction.inc`). Only the item grid and the prose
    /// dialogue depart from the 19 px row, and only because their content is
    /// not a row.
    pub const fn metrics(self) -> Metrics {
        // 5x7 glyph scale for a measured cap height.
        const LABEL: f32 = 12.0 / 7.0;
        const VALUE: f32 = 13.0 / 7.0;
        const CAPTION: f32 = 10.0 / 7.0;
        const HEADING: f32 = 13.0 / 7.0;
        match self {
            // Item field: cards, not rows. The label strip under a cell keeps
            // the 12 px label; the cell itself is sized by the grid.
            Self::Grid => Metrics {
                row_h: 19.0,
                label_px: LABEL,
                caption_px: CAPTION,
                heading_px: HEADING,
                action_h: 17.0,
                action_w: 72.0,
                gutter: 4.0,
            },
            Self::List => Metrics {
                row_h: 19.0,
                label_px: LABEL,
                caption_px: CAPTION,
                heading_px: HEADING,
                action_h: 17.0,
                action_w: 76.0,
                gutter: 6.0,
            },
            Self::Sheet => Metrics {
                row_h: 19.0,
                label_px: VALUE,
                caption_px: CAPTION,
                heading_px: HEADING,
                action_h: 17.0,
                action_w: 92.0,
                gutter: 6.0,
            },
            Self::Bench => Metrics {
                row_h: 19.0,
                label_px: LABEL,
                caption_px: CAPTION,
                heading_px: HEADING,
                action_h: 17.0,
                action_w: 70.0,
                gutter: 6.0,
            },
            // Forms carry 32 px primary fields; their rows leave room for one.
            Self::Form => Metrics {
                row_h: 22.0,
                label_px: LABEL,
                caption_px: CAPTION,
                heading_px: HEADING,
                action_h: 19.0,
                action_w: 100.0,
                gutter: 6.0,
            },
            // Numbered dialogue replies are click targets, not dense rows.
            Self::Dialogue => Metrics {
                row_h: 22.0,
                label_px: VALUE,
                caption_px: CAPTION,
                heading_px: HEADING,
                action_h: 19.0,
                action_w: 110.0,
                gutter: 6.0,
            },
        }
    }
}

/// Content route for a registered id. `windows::content` matches this
/// exhaustively, so the compiler — not a catch-all arm — proves every mapped
/// surface draws real content.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    Inventory,
    Character,
    Skills,
    Datapad,
    CommandBrowser,
    Macros,
    Options,
    Association,
    Group,
    Craft,
    Splice,
    Converse,
    Trade,
    Report,
    Examine,
    Survey,
    Travel,
    Loot,
    Bank,
    Clone,
    Structure,
}

/// Fractional size rule, mirroring the original client's viewport-relative
/// frame defaults: take the fraction, then clamp into the family's readable
/// band. Never larger than the workspace inset.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SizeRule {
    pub frac_w: f32,
    pub min_w: f32,
    pub max_w: f32,
    pub frac_h: f32,
    pub min_h: f32,
    pub max_h: f32,
}

/// Workspace inset kept clear on every edge so a default frame never touches
/// the screen border (the dock rail owns the right gutter).
pub const MARGIN: f32 = 16.0;

/// One registered surface.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Surface {
    pub id: &'static str,
    /// Frame title (title bar, dock tooltip).
    pub title: &'static str,
    /// Atlas icon id for the title bar / dock button.
    pub icon: &'static str,
    pub family: Family,
    /// Tab labels the surface owns; empty when it is a single pane.
    pub tabs: &'static [&'static str],
    /// Whether the body draws a caption header. False for frames whose body
    /// starts with a live 3D viewport anchored at the content origin — those
    /// carry their name in the title bar only.
    pub header: bool,
    /// Dock-visible (a permanent window with a rail button and hotkey badge).
    pub dock: bool,
    /// `KeyboardEvent.code` the dock advertises for this window; empty when the
    /// surface opens from a terminal/target/item route instead.
    pub hotkey: &'static str,
    pub size: SizeRule,
    /// Resize floor `(w, h)`: the narrowest geometry the content stays
    /// readable at.
    pub min: (f32, f32),
    /// Workspace alignment in `[0,1]` per axis (0 = left/top, 0.5 = centered).
    pub anchor: (f32, f32),
}

impl Surface {
    pub const fn metrics(&self) -> Metrics {
        self.family.density().metrics()
    }

    /// Default frame rect for a viewport, in workspace pixels.
    pub fn bounds(&self, viewport_w: f32, viewport_h: f32) -> [f32; 4] {
        let avail_w = (viewport_w - MARGIN * 2.0).max(120.0);
        let avail_h = (viewport_h - MARGIN * 2.0).max(120.0);
        let w = (viewport_w * self.size.frac_w)
            .round()
            .clamp(self.size.min_w, self.size.max_w)
            .min(avail_w);
        let h = (viewport_h * self.size.frac_h)
            .round()
            .clamp(self.size.min_h, self.size.max_h)
            .min(avail_h);
        [
            MARGIN + (avail_w - w) * self.anchor.0,
            MARGIN + (avail_h - h) * self.anchor.1,
            w,
            h,
        ]
    }

    /// Resize floor. Held at or under the smallest supported framebuffer
    /// (800×600 less the workspace inset) so a min-size frame always fits.
    pub const fn min_size(&self) -> (f32, f32) {
        self.min
    }
}

const fn size(
    frac_w: f32,
    min_w: f32,
    max_w: f32,
    frac_h: f32,
    min_h: f32,
    max_h: f32,
) -> SizeRule {
    SizeRule {
        frac_w,
        min_w,
        max_w,
        frac_h,
        min_h,
        max_h,
    }
}

/// Every registered surface: dock-visible frames first (in rail order), then
/// context frames. `hud::PERMANENT_WINDOWS` / `hud::CONTEXT_WINDOWS` are
/// generated from this table, so registry and spec cannot drift.
pub const SURFACES: [Surface; 21] = [
    // ── Permanent (dock-visible) ────────────────────────────────────────────
    Surface {
        id: "character",
        title: "CHARACTER",
        icon: "character",
        family: Family::CharacterSheet,
        tabs: &[],
        header: true,
        dock: true,
        hotkey: "KeyC",
        size: size(0.30, 340.0, 420.0, 0.60, 360.0, 500.0),
        min: (320.0, 300.0),
        anchor: (0.12, 0.16),
    },
    Surface {
        id: "inventory",
        title: "INVENTORY",
        icon: "inventory",
        family: Family::InventoryEquipment,
        tabs: &[],
        // The item field and the live player doll are anchored at the content
        // origin by `inventory::layout`; the frame title carries the caption.
        header: false,
        dock: true,
        hotkey: "KeyI",
        // Original-client oracle: the shipped inventory frame is a FIXED
        // 660x521 at every framebuffer (measured x=176 y=123 w=660 h=521 at
        // 1024x768) and `SwgCuiHudWindowManager::createInventory` centers it
        // with `page.Center()`. It does not scale with the viewport; at 800x600
        // it only clamps. Reflow happens on user resize, never on default.
        size: size(0.0, 660.0, 660.0, 0.0, 521.0, 521.0),
        // `swg-ui-game` layout contract: the original minimum is 250x244.
        min: (250.0, 244.0),
        anchor: (0.5, 0.5),
    },
    Surface {
        id: "datapad",
        title: "DATAPAD",
        icon: "datapad",
        family: Family::Datapad,
        tabs: &["MAP", "SCHEMATICS", "DATA"],
        header: true,
        dock: true,
        hotkey: "KeyP",
        size: size(0.40, 420.0, 560.0, 0.62, 400.0, 620.0),
        min: (400.0, 340.0),
        anchor: (0.86, 0.14),
    },
    Surface {
        id: "skills",
        title: "SKILLS",
        icon: "skills",
        family: Family::SkillTree,
        tabs: &[],
        header: true,
        dock: true,
        hotkey: "KeyK",
        size: size(0.52, 520.0, 720.0, 0.62, 400.0, 640.0),
        min: (460.0, 340.0),
        anchor: (0.72, 0.18),
    },
    Surface {
        id: "actions",
        title: "ACTIONS",
        icon: "actions",
        family: Family::CommandBrowser,
        tabs: &[],
        header: true,
        dock: true,
        hotkey: "KeyB",
        size: size(0.30, 320.0, 440.0, 0.66, 320.0, 640.0),
        min: (300.0, 280.0),
        anchor: (0.95, 0.5),
    },
    Surface {
        id: "macros",
        title: "MACROS",
        icon: "macro",
        family: Family::MacroBench,
        tabs: &[],
        header: true,
        dock: true,
        hotkey: "KeyM",
        size: size(0.42, 460.0, 600.0, 0.60, 400.0, 600.0),
        min: (400.0, 360.0),
        anchor: (0.08, 0.22),
    },
    Surface {
        id: "options",
        title: "OPTIONS",
        icon: "options",
        family: Family::Options,
        tabs: &[],
        header: true,
        dock: true,
        hotkey: "KeyO",
        size: size(0.30, 360.0, 420.0, 0.78, 380.0, 720.0),
        min: (340.0, 340.0),
        anchor: (0.78, 0.06),
    },
    Surface {
        id: "pa",
        title: "ASSOCIATION",
        icon: "association",
        family: Family::PlayerAssociation,
        tabs: &[],
        header: true,
        dock: true,
        hotkey: "KeyG",
        size: size(0.34, 440.0, 560.0, 0.58, 400.0, 600.0),
        min: (400.0, 340.0),
        anchor: (0.4, 0.34),
    },
    // ── Context (opened from a terminal, target, roster, or item route) ─────
    Surface {
        id: "craft",
        title: "CRAFT",
        icon: "craft",
        family: Family::CraftBench,
        tabs: &[],
        header: true,
        dock: false,
        hotkey: "",
        size: size(0.46, 520.0, 700.0, 0.64, 420.0, 640.0),
        min: (460.0, 360.0),
        anchor: (0.36, 0.2),
    },
    Surface {
        id: "splice",
        title: "GENE BENCH",
        icon: "splice",
        family: Family::SpliceBench,
        tabs: &[],
        header: true,
        dock: false,
        hotkey: "",
        size: size(0.48, 540.0, 700.0, 0.66, 440.0, 660.0),
        min: (460.0, 380.0),
        anchor: (0.5, 0.36),
    },
    Surface {
        id: "converse",
        title: "CONVERSE",
        icon: "converse",
        family: Family::Converse,
        tabs: &[],
        // The NPC viewer is anchored at the content origin.
        header: false,
        dock: false,
        hotkey: "",
        size: size(0.34, 440.0, 600.0, 0.50, 340.0, 520.0),
        min: (400.0, 300.0),
        anchor: (0.14, 0.2),
    },
    Surface {
        id: "trade",
        title: "TRADE",
        icon: "trade",
        family: Family::Trade,
        tabs: &[],
        header: true,
        dock: false,
        hotkey: "",
        size: size(0.42, 500.0, 640.0, 0.62, 420.0, 620.0),
        min: (460.0, 360.0),
        anchor: (0.1, 0.5),
    },
    Surface {
        id: "bug-report",
        title: "REPORT",
        icon: "bug-report",
        family: Family::Report,
        tabs: &[],
        header: true,
        dock: false,
        hotkey: "",
        size: size(0.42, 420.0, 540.0, 0.58, 390.0, 560.0),
        min: (380.0, 340.0),
        anchor: (0.5, 0.5),
    },
    Surface {
        id: "examine",
        title: "EXAMINE",
        icon: "examine",
        family: Family::Examine,
        tabs: &[],
        // The object viewer is anchored at the content origin.
        header: false,
        dock: false,
        hotkey: "",
        size: size(0.26, 320.0, 380.0, 0.60, 340.0, 520.0),
        min: (300.0, 320.0),
        anchor: (0.9, 0.42),
    },
    Surface {
        id: "survey",
        title: "SURVEY",
        icon: "survey",
        family: Family::Survey,
        tabs: &["RESOURCES", "EXTRACTORS"],
        header: true,
        dock: false,
        hotkey: "",
        size: size(0.28, 360.0, 460.0, 0.60, 400.0, 600.0),
        min: (340.0, 340.0),
        anchor: (0.0, 0.18),
    },
    Surface {
        id: "travel",
        title: "TRAVEL",
        icon: "travel",
        family: Family::Travel,
        tabs: &["DESTINATIONS", "TICKETS"],
        header: true,
        dock: false,
        hotkey: "",
        size: size(0.40, 460.0, 600.0, 0.50, 360.0, 520.0),
        min: (400.0, 320.0),
        anchor: (0.5, 0.44),
    },
    Surface {
        id: "loot",
        title: "LOOT",
        icon: "loot",
        family: Family::Loot,
        tabs: &[],
        header: true,
        dock: false,
        hotkey: "",
        size: size(0.30, 380.0, 520.0, 0.52, 330.0, 520.0),
        min: (340.0, 300.0),
        anchor: (0.66, 0.5),
    },
    Surface {
        id: "bank",
        title: "BANK",
        icon: "bank",
        family: Family::Bank,
        tabs: &["HELD", "VAULT"],
        header: true,
        dock: false,
        hotkey: "",
        size: size(0.34, 420.0, 560.0, 0.56, 360.0, 560.0),
        min: (380.0, 320.0),
        anchor: (0.5, 0.42),
    },
    Surface {
        id: "clone",
        title: "CLONING",
        icon: "clone-facility",
        family: Family::Clone,
        tabs: &[],
        header: true,
        dock: false,
        hotkey: "",
        size: size(0.30, 400.0, 520.0, 0.44, 320.0, 460.0),
        min: (360.0, 280.0),
        anchor: (0.5, 0.42),
    },
    Surface {
        id: "build",
        title: "LAND / BUILD",
        icon: "options",
        family: Family::Structure,
        tabs: &["PARCEL", "CATALOG"],
        header: true,
        dock: false,
        hotkey: "",
        size: size(0.44, 480.0, 640.0, 0.62, 420.0, 620.0),
        min: (440.0, 360.0),
        anchor: (0.28, 0.28),
    },
    Surface {
        id: "group",
        title: "GROUP",
        // No dedicated group glyph exists in the Successor atlas; the
        // association mark is the closest owned symbol and this frame is
        // context-only, so it never sits beside ASSOCIATION in the dock.
        icon: "association",
        family: Family::GroupRoster,
        tabs: &[],
        header: true,
        dock: false,
        hotkey: "",
        size: size(0.30, 380.0, 500.0, 0.50, 340.0, 520.0),
        min: (360.0, 300.0),
        anchor: (0.22, 0.5),
    },
];

/// Spec for a registered id.
pub fn surface(id: &str) -> Option<&'static Surface> {
    SURFACES.iter().find(|surface| surface.id == id)
}

/// Content route for a registered id. `None` means the id is not a mapped
/// surface — `windows::content` renders that as a named diagnostic rather than
/// a blank `NO SIGNAL`, and `every_registry_id_routes` fails on it.
pub fn route(id: &str) -> Option<Route> {
    Some(match id {
        "inventory" => Route::Inventory,
        "character" => Route::Character,
        "skills" => Route::Skills,
        "datapad" => Route::Datapad,
        "actions" => Route::CommandBrowser,
        "macros" => Route::Macros,
        "options" => Route::Options,
        "pa" => Route::Association,
        "group" => Route::Group,
        "craft" => Route::Craft,
        "splice" => Route::Splice,
        "converse" => Route::Converse,
        "trade" => Route::Trade,
        "bug-report" => Route::Report,
        "examine" => Route::Examine,
        "survey" => Route::Survey,
        "travel" => Route::Travel,
        "loot" => Route::Loot,
        "bank" => Route::Bank,
        "clone" => Route::Clone,
        "build" => Route::Structure,
        _ => return None,
    })
}

/// Registration geometry for `id`: default bounds at the given viewport plus
/// the resize floor. Unknown ids get a readable centered default instead of a
/// zero-size frame.
pub fn geometry(id: &str, viewport_w: f32, viewport_h: f32) -> ([f32; 4], f32, f32) {
    match surface(id) {
        Some(spec) => {
            let (min_w, min_h) = spec.min_size();
            (spec.bounds(viewport_w, viewport_h), min_w, min_h)
        }
        None => {
            let w = 480.0_f32.min(viewport_w - MARGIN * 2.0).max(120.0);
            let h = 360.0_f32.min(viewport_h - MARGIN * 2.0).max(120.0);
            (
                [(viewport_w - w) * 0.5, (viewport_h - h) * 0.5, w, h],
                w.min(320.0),
                h.min(240.0),
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every framebuffer the original-client UI matrix covers.
    const MATRIX: [(f32, f32); 4] = [
        (800.0, 600.0),
        (1024.0, 768.0),
        (1280.0, 1024.0),
        (1600.0, 1200.0),
    ];

    #[test]
    fn every_registry_id_routes() {
        for (id, _, _, _) in crate::hud::PERMANENT_WINDOWS {
            assert!(route(id).is_some(), "permanent window {id} has no route");
            assert!(surface(id).is_some(), "permanent window {id} has no spec");
        }
        for (id, _, _) in crate::hud::CONTEXT_WINDOWS {
            assert!(route(id).is_some(), "context window {id} has no route");
            assert!(surface(id).is_some(), "context window {id} has no spec");
        }
        assert_eq!(
            SURFACES.len(),
            crate::hud::PERMANENT_WINDOWS.len() + crate::hud::CONTEXT_WINDOWS.len(),
            "registry and spec table disagree on surface count"
        );
    }

    #[test]
    fn ids_and_routes_are_unique() {
        for (index, spec) in SURFACES.iter().enumerate() {
            assert!(
                !SURFACES[..index].iter().any(|other| other.id == spec.id),
                "duplicate surface id {}",
                spec.id
            );
            let taken = route(spec.id).expect("mapped surface");
            assert!(
                !SURFACES[..index]
                    .iter()
                    .any(|other| route(other.id) == Some(taken)),
                "two surfaces share route {taken:?}"
            );
        }
    }

    #[test]
    fn surface_families_match_their_mediator_intent() {
        assert_eq!(
            surface("actions").expect("actions").family,
            Family::CommandBrowser,
            "ACTIONS is the command browser, not the group roster"
        );
        assert_eq!(
            surface("group").expect("group").family.mediator(),
            "SwgCuiGroup"
        );
        assert_eq!(
            surface("pa").expect("pa").family.mediator(),
            "SwgCuiPlayerAssociation"
        );
        assert_eq!(
            surface("inventory").expect("inventory").family,
            Family::InventoryEquipment
        );
        assert_eq!(surface("build").expect("build").family, Family::Structure);
        // Frames whose body starts with a live 3D viewport draw no body header.
        for id in ["inventory", "examine", "converse"] {
            assert!(
                !surface(id).expect("spec").header,
                "{id} anchors a 3D viewport at the content origin"
            );
        }
    }

    #[test]
    fn defaults_fit_and_respect_the_resize_floor_at_every_matrix_size() {
        for (vw, vh) in MATRIX {
            for spec in &SURFACES {
                let [x, y, w, h] = spec.bounds(vw, vh);
                let (min_w, min_h) = spec.min_size();
                assert!(
                    x >= 0.0 && y >= 0.0 && x + w <= vw && y + h <= vh,
                    "{} escapes {vw}x{vh}: {:?}",
                    spec.id,
                    [x, y, w, h]
                );
                assert!(
                    min_w <= vw - MARGIN * 2.0 && min_h <= vh - MARGIN * 2.0,
                    "{} floor {min_w}x{min_h} cannot fit {vw}x{vh}",
                    spec.id
                );
                assert!(
                    w >= min_w.min(vw - MARGIN * 2.0),
                    "{} default {w} under floor {min_w} at {vw}x{vh}",
                    spec.id
                );
                assert!(
                    h >= min_h.min(vh - MARGIN * 2.0),
                    "{} default {h} under floor {min_h} at {vw}x{vh}",
                    spec.id
                );
            }
        }
    }

    #[test]
    fn inventory_is_the_measured_fixed_rect_centered_at_every_matrix_size() {
        let inventory = surface("inventory").expect("inventory spec");
        // Matrix measured the shipped frame at exactly 660x521, x=176 y=123 at
        // 1024x768, and it does not scale with the viewport: only clamping.
        let [x, y, w, h] = inventory.bounds(1024.0, 768.0);
        assert_eq!((w, h), (660.0, 521.0));
        assert!(
            (x - 176.0).abs() <= 8.0,
            "x={x} should sit at the measured 176 within workspace-inset slack"
        );
        assert!(
            (y - 123.0).abs() <= 8.0,
            "y={y} should sit at the measured 123 within workspace-inset slack"
        );
        for (vw, vh) in MATRIX {
            let [x, y, w, h] = inventory.bounds(vw, vh);
            assert_eq!(
                (w, h),
                (660.0, 521.0),
                "inventory must stay fixed at {vw}x{vh}, clamping only"
            );
            // `SwgCuiHudWindowManager::createInventory` calls page.Center().
            assert!(
                ((x + w * 0.5) - vw * 0.5).abs() <= 0.5,
                "inventory off-center at {vw}x{vh}: x={x}"
            );
            assert!(
                ((y + h * 0.5) - vh * 0.5).abs() <= 0.5,
                "inventory off-center at {vw}x{vh}: y={y}"
            );
        }
    }

    #[test]
    fn density_metrics_stay_readable() {
        for density in [
            Density::Grid,
            Density::List,
            Density::Sheet,
            Density::Bench,
            Density::Form,
            Density::Dialogue,
        ] {
            let metrics = density.metrics();
            // A row must clear its own action control, and glyphs must not
            // exceed the row they sit in (5×7 font: cap height = 7·px).
            assert!(
                metrics.row_h >= metrics.action_h + 2.0,
                "{density:?} row {} cannot hold a {} action",
                metrics.row_h,
                metrics.action_h
            );
            assert!(
                metrics.label_px * 7.0 < metrics.row_h,
                "{density:?} label clips its row"
            );
            assert!(
                metrics.caption_px < metrics.label_px,
                "{density:?} caption must stay subordinate"
            );
        }
    }

    #[test]
    fn dock_surfaces_lead_the_table_and_declare_hotkeys() {
        let dock_count = SURFACES.iter().filter(|spec| spec.dock).count();
        for (index, spec) in SURFACES.iter().enumerate() {
            assert_eq!(
                spec.dock,
                index < dock_count,
                "{} breaks the dock-first table order",
                spec.id
            );
            assert_eq!(
                spec.dock,
                !spec.hotkey.is_empty(),
                "{} dock/hotkey disagreement",
                spec.id
            );
        }
    }
}
