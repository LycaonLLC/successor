//! Debug character builder, reached by conversing with GR0K.
//!
//! Stands in for SWG Core3's "blue frog" (`CharacterBuilderTerminal`), which is
//! a single-select nested list: one click, one grant, back to the top. Kitting a
//! character out takes dozens of round trips. This one pages the same kind of
//! tree but every leaf is a checkbox, so a tester ticks what they want across a
//! page and commits the lot in one action.
//!
//! Compiled only under `dev-tools`. The commands it emits are refused by any
//! authority that does not have `GAME_DEBUG_AUTHORITY_COMMANDS` set, so this is
//! belt and braces rather than the only gate.

use std::cell::RefCell;

use crate::windows::chrome::{self, Rows};
use crate::windows::spec::Metrics;
use crate::windows::{accent, dim, label, value, WindowAction};
use successor_engine_render::ui::UiBuilder;
use successor_net::ClientCommand;

/// Generated from the authority's own tables. See
/// `crates/successor-sim/src/bin/emit_debug_catalog.rs`; a hygiene gate fails
/// when this file drifts from the runtime.
const CATALOG_JSON: &str = include_str!("../../../../../../tools/codegen/generated/debug-catalog.generated.json");

pub struct CatalogItem {
    pub id: u32,
    pub name: String,
}

pub struct CatalogSkill {
    pub id: String,
    pub title: String,
    pub profession: String,
}

pub struct CatalogPack {
    pub label: String,
    pub items: Vec<u32>,
}

#[derive(Default)]
pub struct Catalog {
    pub items: Vec<CatalogItem>,
    pub skills: Vec<CatalogSkill>,
    pub packs: Vec<CatalogPack>,
    pub professions: Vec<String>,
    pub categories: Vec<&'static str>,
}

/// Item id bands, which the authority allocates deliberately: consumables at
/// 1_000, resource containers at 2_000, tools at 3_000, weapons from 3_100,
/// schematics at 5_000, seeds at 6_000. Deriving the grouping from the band
/// keeps the menu organised without a second table to maintain.
fn category_of(id: u32) -> &'static str {
    match id {
        1_000..=1_099 => "CONSUMABLE",
        1_100..=1_199 => "AMMO",
        1_200..=1_999 => "COMPONENT",
        2_000..=2_099 => "RESOURCE",
        2_100..=2_999 => "HARVEST",
        3_000..=3_099 => "TOOL",
        3_100..=3_199 => "WEAPON",
        3_200..=4_999 => "EQUIPMENT",
        5_000..=5_999 => "SCHEMATIC",
        6_000..=6_999 => "SEED",
        _ => "OTHER",
    }
}

fn parse_catalog() -> Catalog {
    let Ok(root) = serde_json::from_str::<serde_json::Value>(CATALOG_JSON) else {
        return Catalog::default();
    };
    let mut catalog = Catalog::default();
    for entry in root["items"].as_array().into_iter().flatten() {
        let (Some(id), Some(name)) = (entry["id"].as_u64(), entry["name"].as_str()) else {
            continue;
        };
        catalog.items.push(CatalogItem {
            id: id as u32,
            name: name.to_ascii_uppercase(),
        });
    }
    for entry in root["skillBoxes"].as_array().into_iter().flatten() {
        let (Some(id), Some(title), Some(profession)) = (
            entry["id"].as_str(),
            entry["title"].as_str(),
            entry["profession"].as_str(),
        ) else {
            continue;
        };
        catalog.skills.push(CatalogSkill {
            id: id.to_owned(),
            title: title.to_ascii_uppercase(),
            profession: profession.to_owned(),
        });
    }
    for entry in root["packs"].as_array().into_iter().flatten() {
        let Some(label) = entry["label"].as_str() else {
            continue;
        };
        catalog.packs.push(CatalogPack {
            label: label.to_ascii_uppercase(),
            items: entry["items"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_u64().map(|v| v as u32))
                .collect(),
        });
    }
    for skill in &catalog.skills {
        if !catalog.professions.contains(&skill.profession) {
            catalog.professions.push(skill.profession.clone());
        }
    }
    for item in &catalog.items {
        let category = category_of(item.id);
        if !catalog.categories.contains(&category) {
            catalog.categories.push(category);
        }
    }
    catalog
}

/// Which page the builder is showing. The stack is one level deep by design:
/// a tester should never be lost, and a breadcrumb plus BACK beats a tree.
#[derive(Clone, PartialEq, Eq)]
pub enum Page {
    Root,
    Packs,
    Items(&'static str),
    ItemCategories,
    Professions,
    Skills(String),
    Credits,
}

pub struct BuilderState {
    pub catalog: Catalog,
    pub page: Page,
    pub items: Vec<u32>,
    pub skills: Vec<String>,
    pub credits: i64,
    pub last_result: Option<String>,
    /// Whether the builder has taken over the reply column.
    pub opened: bool,
}

impl BuilderState {
    fn new() -> Self {
        Self {
            catalog: parse_catalog(),
            page: Page::Root,
            items: Vec::new(),
            skills: Vec::new(),
            credits: 10_000,
            last_result: None,
            opened: false,
        }
    }

    fn toggle_item(&mut self, id: u32) {
        match self.items.iter().position(|held| *held == id) {
            Some(index) => {
                self.items.remove(index);
            }
            None => self.items.push(id),
        }
    }

    fn toggle_skill(&mut self, id: &str) {
        match self.skills.iter().position(|held| held == id) {
            Some(index) => {
                self.skills.remove(index);
            }
            None => self.skills.push(id.to_owned()),
        }
    }

    pub fn selected(&self) -> usize {
        self.items.len() + self.skills.len()
    }

    /// Emit one command per ticked item and ONE command carrying every ticked
    /// skill - `DebugGrantSkillBoxes` already takes a list, so a whole
    /// profession is a single round trip rather than twenty.
    fn commit(&mut self, out: &mut Vec<WindowAction>) {
        for id in &self.items {
            out.push(WindowAction::Command(ClientCommand::DebugGiveItem {
                item_id: *id,
                variant_id: 0,
                quantity: 1,
                equip: false,
            }));
        }
        if !self.skills.is_empty() {
            out.push(WindowAction::Command(
                ClientCommand::DebugGrantSkillBoxes {
                    skill_box_ids: self.skills.clone(),
                },
            ));
        }
        self.last_result = Some(format!(
            "GRANTED {} ITEM(S), {} SKILL(S)",
            self.items.len(),
            self.skills.len()
        ));
        self.items.clear();
        self.skills.clear();
    }
}

thread_local! {
    static STATE: RefCell<BuilderState> = RefCell::new(BuilderState::new());
}

/// Run `f` against the retained builder state. Exposed for tests, which drive
/// the same state the pane does rather than a parallel copy.
pub fn with_state<R>(f: impl FnOnce(&mut BuilderState) -> R) -> R {
    STATE.with(|state| f(&mut state.borrow_mut()))
}

/// Draw the builder into `rect`. Returns false when the player asked to leave,
/// so the caller can hand the column back to ordinary dialogue.
pub fn draw(ui: &mut UiBuilder, rect: [f32; 4], metrics: Metrics, out: &mut Vec<WindowAction>) -> bool {
    with_state(|state| draw_state(state, ui, rect, metrics, out))
}

fn draw_state(
    state: &mut BuilderState,
    ui: &mut UiBuilder,
    rect: [f32; 4],
    metrics: Metrics,
    out: &mut Vec<WindowAction>,
) -> bool {
    let [x, y, w, h] = rect;
    let mut open = true;

    // Breadcrumb: the tester always knows where they are and how to get out.
    let crumb = match &state.page {
        Page::Root => "BUILDER".to_string(),
        Page::Packs => "BUILDER / PACKS".to_string(),
        Page::ItemCategories => "BUILDER / ITEMS".to_string(),
        Page::Items(category) => format!("BUILDER / ITEMS / {category}"),
        Page::Professions => "BUILDER / SKILLS".to_string(),
        Page::Skills(profession) => {
            format!("BUILDER / SKILLS / {}", profession.to_ascii_uppercase())
        }
        Page::Credits => "BUILDER / CREDITS".to_string(),
    };
    ui.text(&crumb, x + metrics.gutter, y + 2.0, metrics.caption_px, dim());

    let selected = state.selected();
    if selected > 0 {
        let tally = format!("{selected} SELECTED");
        let tw = ui.measure_text(&tally, metrics.caption_px);
        ui.text(
            &tally,
            x + w - tw - metrics.gutter,
            y + 2.0,
            metrics.caption_px,
            accent(),
        );
    }

    // The commit rail is reserved before the list so a long page can never
    // push GRANT off the bottom.
    let rail_h = metrics.row_h + 4.0;
    let list_y = y + metrics.caption_px * 7.0 + 8.0;
    let list_h = (h - (list_y - y) - rail_h).max(0.0);
    let mut rows = Rows::new([x, list_y, w, list_h], metrics);

    match state.page.clone() {
        Page::Root => {
            for (title, page) in [
                ("PACKS", Page::Packs),
                ("ITEMS", Page::ItemCategories),
                ("SKILLS", Page::Professions),
                ("CREDITS", Page::Credits),
            ] {
                let Some(mut row) = rows.next(ui) else { break };
                row.label(ui, title);
                if row.clicked(ui) {
                    state.page = page;
                }
            }
            if let Some(mut row) = rows.next(ui) {
                row.label(ui, "CLOSE BUILDER");
                if row.clicked(ui) {
                    open = false;
                }
            }
            if let Some(result) = &state.last_result {
                if let Some(mut row) = rows.next(ui) {
                    row.label_tinted(ui, result, accent());
                }
            }
        }
        Page::Packs => {
            for pack in &state.catalog.packs {
                let Some(mut row) = rows.next(ui) else { break };
                let ticked = pack.items.iter().all(|id| state.items.contains(id));
                row.value(ui, &format!("{} ITEMS", pack.items.len()));
                row.label(ui, &format!("{} {}", tick(ticked), pack.label));
                if row.clicked(ui) {
                    for id in &pack.items {
                        let held = state.items.contains(id);
                        if ticked == held {
                            // Ticking a pack adds all of it; unticking removes
                            // exactly what the pack put there.
                            toggle(&mut state.items, *id);
                        }
                    }
                }
            }
        }
        Page::ItemCategories => {
            for category in state.catalog.categories.clone() {
                let Some(mut row) = rows.next(ui) else { break };
                let count = state
                    .catalog
                    .items
                    .iter()
                    .filter(|item| category_of(item.id) == category)
                    .count();
                row.value(ui, &count.to_string());
                row.label(ui, category);
                if row.clicked(ui) {
                    state.page = Page::Items(category);
                }
            }
        }
        Page::Items(category) => {
            let ids: Vec<(u32, String)> = state
                .catalog
                .items
                .iter()
                .filter(|item| category_of(item.id) == category)
                .map(|item| (item.id, item.name.clone()))
                .collect();
            for (id, name) in ids {
                let Some(mut row) = rows.next(ui) else { break };
                let ticked = state.items.contains(&id);
                row.value(ui, &id.to_string());
                row.label(ui, &format!("{} {name}", tick(ticked)));
                if row.clicked(ui) {
                    state.toggle_item(id);
                }
            }
        }
        Page::Professions => {
            for profession in state.catalog.professions.clone() {
                let Some(mut row) = rows.next(ui) else { break };
                row.label(ui, &profession.to_ascii_uppercase());
                if row.clicked(ui) {
                    state.page = Page::Skills(profession);
                }
            }
        }
        Page::Skills(profession) => {
            let boxes: Vec<(String, String)> = state
                .catalog
                .skills
                .iter()
                .filter(|skill| skill.profession == profession)
                .map(|skill| (skill.id.clone(), skill.title.clone()))
                .collect();
            // Whole-profession tick first: the common case is "give me this
            // profession", not twenty individual boxes.
            if let Some(mut row) = rows.next(ui) {
                let all = boxes.iter().all(|(id, _)| state.skills.contains(id));
                row.label_tinted(ui, &format!("{} ENTIRE PROFESSION", tick(all)), accent());
                if row.clicked(ui) {
                    for (id, _) in &boxes {
                        let held = state.skills.contains(id);
                        if all == held {
                            toggle_str(&mut state.skills, id);
                        }
                    }
                }
            }
            for (id, title) in boxes {
                let Some(mut row) = rows.next(ui) else { break };
                let ticked = state.skills.contains(&id);
                row.label(ui, &format!("{} {title}", tick(ticked)));
                if row.clicked(ui) {
                    state.toggle_skill(&id);
                }
            }
        }
        Page::Credits => {
            if let Some(mut row) = rows.next(ui) {
                row.value(ui, &format!("{} CR", state.credits));
                row.label(ui, "AMOUNT");
            }
            for amount in [1_000i64, 10_000, 100_000, 1_000_000] {
                let Some(mut row) = rows.next(ui) else { break };
                row.label(ui, &format!("SET {amount} CR"));
                if row.clicked(ui) {
                    state.credits = amount;
                }
            }
            if let Some(mut row) = rows.next(ui) {
                row.label_tinted(ui, "GIVE CREDITS", accent());
                if row.clicked(ui) {
                    out.push(WindowAction::Command(ClientCommand::DebugGiveCredits {
                        amount: state.credits,
                    }));
                    state.last_result = Some(format!("GAVE {} CR", state.credits));
                }
            }
            if let Some(mut row) = rows.next(ui) {
                row.label_tinted(ui, "DRAIN WALLET", dim());
                if row.clicked(ui) {
                    out.push(WindowAction::Command(ClientCommand::DebugGiveCredits {
                        amount: -1_000_000_000,
                    }));
                    state.last_result = Some("WALLET DRAINED".to_string());
                }
            }
        }
    }

    // Commit rail.
    let rail_y = y + h - rail_h;
    ui.rect(x, rail_y, w, 1.0, chrome::hairline());
    let mut rail = Rows::new([x, rail_y + 2.0, w, rail_h], metrics);
    if let Some(mut row) = rail.next(ui) {
        if state.page != Page::Root && row.quiet_action(ui, "BACK") {
            state.page = match state.page {
                Page::Items(_) => Page::ItemCategories,
                Page::Skills(_) => Page::Professions,
                _ => Page::Root,
            };
        }
        if selected > 0 && row.action(ui, "GRANT SELECTED") {
            state.commit(out);
        }
        let tally = if selected > 0 {
            format!("{selected} TICKED")
        } else {
            "NOTHING SELECTED".to_string()
        };
        row.label_tinted(ui, &tally, if selected > 0 { value() } else { dim() });
    }
    open
}

fn tick(on: bool) -> &'static str {
    if on {
        "[X]"
    } else {
        "[ ]"
    }
}

fn toggle(list: &mut Vec<u32>, id: u32) {
    match list.iter().position(|held| *held == id) {
        Some(index) => {
            list.remove(index);
        }
        None => list.push(id),
    }
}

fn toggle_str(list: &mut Vec<String>, id: &str) {
    match list.iter().position(|held| held == id) {
        Some(index) => {
            list.remove(index);
        }
        None => list.push(id.to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> BuilderState {
        let mut state = BuilderState::new();
        state.page = Page::Root;
        state.items.clear();
        state.skills.clear();
        state
    }

    #[test]
    fn the_catalog_carries_the_runtime_tables() {
        let state = fresh();
        assert!(
            state.catalog.items.len() > 100,
            "expected the generated item table, got {}",
            state.catalog.items.len()
        );
        assert!(!state.catalog.skills.is_empty());
        assert!(!state.catalog.packs.is_empty());
        assert!(state.catalog.professions.len() >= 5);
    }

    #[test]
    fn selection_accumulates_and_commit_clears_it() {
        let mut state = fresh();
        state.toggle_item(3008);
        state.toggle_item(3001);
        state.toggle_skill("marksman-novice");
        assert_eq!(state.selected(), 3);

        state.toggle_item(3001);
        assert_eq!(state.selected(), 2, "a second tick must untick");

        let mut out = Vec::new();
        state.commit(&mut out);
        assert_eq!(state.selected(), 0, "commit clears the basket");
        assert!(state.last_result.is_some());
    }

    #[test]
    fn skills_commit_as_one_command_carrying_every_ticked_id() {
        let mut state = fresh();
        state.toggle_skill("marksman-novice");
        state.toggle_skill("marksman-rifle-i");
        state.toggle_skill("marksman-rifle-ii");

        let mut out = Vec::new();
        state.commit(&mut out);

        let grants: Vec<&WindowAction> = out
            .iter()
            .filter(|action| {
                matches!(
                    action,
                    WindowAction::Command(ClientCommand::DebugGrantSkillBoxes { .. })
                )
            })
            .collect();
        assert_eq!(grants.len(), 1, "three skills must be ONE round trip");
        let WindowAction::Command(ClientCommand::DebugGrantSkillBoxes { skill_box_ids }) =
            grants[0]
        else {
            panic!("expected a skill grant");
        };
        assert_eq!(skill_box_ids.len(), 3);
    }

    #[test]
    fn items_commit_one_command_each() {
        let mut state = fresh();
        state.toggle_item(3008);
        state.toggle_item(3001);

        let mut out = Vec::new();
        state.commit(&mut out);

        let ids: Vec<u32> = out
            .iter()
            .filter_map(|action| match action {
                WindowAction::Command(ClientCommand::DebugGiveItem { item_id, .. }) => {
                    Some(*item_id)
                }
                _ => None,
            })
            .collect();
        assert_eq!(ids, vec![3008, 3001]);
    }

    #[test]
    fn every_pack_references_a_real_item() {
        let state = fresh();
        for pack in &state.catalog.packs {
            assert!(!pack.items.is_empty(), "{} is empty", pack.label);
            for id in &pack.items {
                assert!(
                    state.catalog.items.iter().any(|item| item.id == *id),
                    "{} references unknown item {id}",
                    pack.label
                );
            }
        }
    }
}
