//! Typed view models the window content reads, decoded from the authority
//! wire payloads by their EXACT server field names (`server/src/game/protocol.ts`
//! VM interfaces). Windows never read raw `serde_json::Value` — projection
//! (`windows::project`) decodes each store section into these plain-data
//! structs, so window layout stays deterministic and unit-testable and the
//! decode itself is exercised by feeding wire-shaped JSON in tests.
//!
//! The demo executable and isolated UI tests seed state through these same
//! decoders, so fixtures cannot drift from the wire contract. Connected mode
//! never uses `sample()` (it is intentionally empty) — the live sections are
//! rebuilt from the accepted store by `windows::project::project`.

use serde::{Deserialize, Deserializer};
use std::collections::HashMap;

// ─────────────────────────── shared decode helpers ──────────────────────────

/// Wire ids arrive as JSON numbers (inventory `stackId`) or strings (bank
/// `stackId`). Commands carry them as strings — normalize at decode time.
pub fn de_string_or_num<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum V {
        S(String),
        N(serde_json::Number),
        B(bool),
        None,
    }
    Ok(match V::deserialize(d)? {
        V::S(s) => s,
        V::N(n) => n.to_string(),
        V::B(b) => b.to_string(),
        V::None => String::new(),
    })
}

/// Item category → toolbar/inventory glyph id (`icons.ts` vocabulary).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemKind {
    Weapon,
    Ammo,
    Medical,
    Resource,
    Tool,
    Gear,
    Currency,
    Item,
}

impl ItemKind {
    /// Icon id for this category (resolved against the baked atlas by the host).
    pub fn icon(self) -> &'static str {
        match self {
            ItemKind::Weapon => "item-weapon",
            ItemKind::Ammo => "item-ammo",
            ItemKind::Medical => "item-medical",
            ItemKind::Resource => "item-resource",
            ItemKind::Tool => "item-tool",
            ItemKind::Gear => "item-gear",
            ItemKind::Currency => "item-currency",
            ItemKind::Item => "item-item",
        }
    }
}

/// Rust-authoritative resource stat block (wire `GameResourceStats`,
/// snake_case on the wire — field names match exactly).
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct ResourceStats {
    pub conductivity: i64,
    pub malleability: i64,
    pub shock_resistance: i64,
    pub thermal_resistance: i64,
    pub chemical_purity: i64,
    pub density: i64,
    pub tensile_strength: i64,
    pub flexibility: i64,
    pub potency: i64,
    pub nutrition: i64,
    pub stability: i64,
    pub extraction_yield: i64,
}

impl ResourceStats {
    /// (label, value) pairs in the reference examine order.
    pub fn rows(&self) -> [(&'static str, i64); 12] {
        [
            ("COND", self.conductivity),
            ("MALL", self.malleability),
            ("SHOCK", self.shock_resistance),
            ("THERM", self.thermal_resistance),
            ("PURITY", self.chemical_purity),
            ("DENS", self.density),
            ("TENS", self.tensile_strength),
            ("FLEX", self.flexibility),
            ("POT", self.potency),
            ("NUTR", self.nutrition),
            ("STAB", self.stability),
            ("YIELD", self.extraction_yield),
        ]
    }
}

// ─────────────────────────── inventory / economy ────────────────────────────

/// One inventory/bank/loot row (wire `GameInventoryRow` / `GameBankItemRow`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct InventoryRow {
    pub container: String,
    #[serde(deserialize_with = "de_string_or_num")]
    pub stack_id: String,
    pub item: String,
    pub item_id: u32,
    pub variant_id: u32,
    pub quantity: i64,
    pub reserved: i64,
    pub available: i64,
    pub equipped: bool,
    pub potency: Option<i64>,
    pub purity: Option<i64>,
    pub item_key: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub resource_stats: Option<ResourceStats>,
    pub colors: Vec<String>,
}

/// Exchange stockpile container id (datapad STORE/RETRIEVE in the reference).
pub const EXCHANGE_CONTAINER: &str = "district-exchange";

impl InventoryRow {
    pub fn kind(&self) -> ItemKind {
        let key = self.item_key.as_deref().unwrap_or("");
        let name = self.item.to_ascii_uppercase();
        if self.is_credit_chip() {
            ItemKind::Currency
        } else if self.resource_stats.is_some() || key.starts_with("resource") {
            ItemKind::Resource
        } else if name.contains("AMMO") || name.contains("ROUNDS") {
            ItemKind::Ammo
        } else if name.contains("MEDKIT") || name.contains("STIM") || name.contains("BANDAGE") {
            ItemKind::Medical
        } else if name.contains("TOOL")
            || name.contains("SCANNER")
            || name.contains("EXTRACTOR")
            || name.contains("BATTERY")
        {
            ItemKind::Tool
        } else if name.contains("PISTOL")
            || name.contains("RIFLE")
            || name.contains("CARBINE")
            || name.contains("SWORD")
            || name.contains("SABER")
            || name.contains("MACHETE")
            || name.contains("SLUGTHROWER")
            || name.contains("SHOTGUN")
            || name.contains("SMG")
        {
            ItemKind::Weapon
        } else if !self.colors.is_empty()
            || name.contains("VEST")
            || name.contains("JACKET")
            || name.contains("BOOTS")
            || name.contains("HELM")
        {
            ItemKind::Gear
        } else {
            ItemKind::Item
        }
    }

    pub fn is_travel_ticket(&self) -> bool {
        self.item_key.as_deref() == Some("travel_ticket")
            || self
                .metadata
                .as_ref()
                .map(|m| m.get("travelTicket").is_some())
                .unwrap_or(false)
    }

    pub fn is_credit_chip(&self) -> bool {
        self.item.to_ascii_uppercase().contains("CREDIT CHIP")
            || self.item_key.as_deref() == Some("credit_chip")
    }

    /// Ticket destination "PLANET · CITY" from `metadata.travelTicket`.
    pub fn ticket_destination(&self) -> Option<String> {
        let t = self.metadata.as_ref()?.get("travelTicket")?;
        let planet = t.get("toPlanetId").and_then(|v| v.as_str()).unwrap_or("?");
        let city = t.get("toCityId").and_then(|v| v.as_str()).unwrap_or("?");
        Some(format!("{} · {}", planet, city).to_ascii_uppercase())
    }

    /// True when this stack sits in the district exchange stockpile.
    pub fn in_exchange(&self) -> bool {
        self.container == EXCHANGE_CONTAINER
    }
}

/// Wire `GameReservationRow` — visible pending holds against stacks.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ReservationRow {
    pub id: i64,
    pub actor: String,
    pub purpose: String,
    pub from: String,
    pub item: String,
    pub quantity: i64,
}

#[derive(Clone, Debug, Default)]
pub struct InventoryModel {
    pub rows: Vec<InventoryRow>,
    pub reservations: Vec<ReservationRow>,
    /// Wallet credits (player actor scalar).
    pub credits: i64,
    /// Currently wielded weapon label (from the player actor weapon state).
    pub weapon_label: Option<String>,
}

impl InventoryModel {
    /// Held (player-owned, non-exchange) rows in wire order.
    pub fn held(&self) -> impl Iterator<Item = &InventoryRow> {
        self.rows.iter().filter(|r| !r.in_exchange())
    }
    /// Rows stored in the district exchange.
    pub fn exchange(&self) -> impl Iterator<Item = &InventoryRow> {
        self.rows.iter().filter(|r| r.in_exchange())
    }
    pub fn row(&self, container: &str, stack_id: &str) -> Option<&InventoryRow> {
        self.rows
            .iter()
            .find(|r| r.container == container && r.stack_id == stack_id)
    }
}

/// Wire `GameBankSnapshot` (owner-scoped; also carries the clone skill backup).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BankSnapshot {
    pub credits: i64,
    pub items: Vec<InventoryRow>,
    pub backup_present: bool,
    pub backup_saved_tick: Option<i64>,
    pub backup_skill_count: i64,
    pub backup_cost: i64,
}

/// A range/terminal gate the reference expresses as an "AT TERMINAL ONLY"
/// unavailable state. `available == false` ⇒ the window must not emit the
/// gated commands and shows `note` instead.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Gate {
    pub available: bool,
    pub note: String,
    /// The linked terminal/prop id when available.
    pub prop_id: Option<String>,
}

impl Gate {
    pub fn open(prop_id: &str) -> Self {
        Gate {
            available: true,
            note: String::new(),
            prop_id: Some(prop_id.to_string()),
        }
    }
    pub fn closed(note: &str) -> Self {
        Gate {
            available: false,
            note: note.to_string(),
            prop_id: None,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct BankModel {
    pub gate: Gate,
    pub bank: Option<BankSnapshot>,
}

// ─────────────────────────────── loot ────────────────────────────────────────

/// Wire `GamePlayerCorpseSnapshot` (`playerCorpses[]` section).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PlayerCorpse {
    pub id: String,
    pub owner_label: String,
    pub area_id: String,
    pub cell_x: i64,
    pub cell_y: i64,
    pub x: f32,
    pub y: f32,
    pub expiry_tick: i64,
    pub has_items: bool,
    pub credits_present: bool,
    pub credits_count: i64,
    pub is_owner: bool,
    /// Loot container id the corpse's `GameInventoryRow`s address.
    pub container: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LootTargetKind {
    Corpse,
    Cache,
}

#[derive(Clone, Debug)]
pub struct LootModel {
    pub kind: LootTargetKind,
    /// Corpse id / cache prop id.
    pub target_id: String,
    /// Loot container the rows live in (`corpse:<id>` / cache container).
    pub container: String,
    pub label: String,
    pub rows: Vec<InventoryRow>,
    pub credits_present: bool,
    pub credits_count: i64,
    pub in_reach: bool,
    /// Loot rights: mine (or public).
    pub rights_mine: bool,
    /// Corpse only: HARVEST available (target actor id).
    pub harvest_actor_id: Option<String>,
}

// ─────────────────────────────── trade ───────────────────────────────────────

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TradeItemLine {
    pub item_id: u32,
    pub variant_id: u32,
    pub name: String,
    pub quantity: i64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TradeSide {
    pub actor_id: String,
    pub items: Vec<TradeItemLine>,
    pub coin: i64,
    pub locked: bool,
    pub confirmed: bool,
}

/// Wire `GameTradeSession` (streamed to both participants).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TradeSession {
    pub proposal_id: u32,
    pub partner_actor_id: String,
    pub mine: TradeSide,
    pub theirs: TradeSide,
    pub both_locked: bool,
    /// "negotiating" | "confirm" | "executed" | "declined"
    pub stage: String,
    pub close_reason: Option<String>,
    pub tick: i64,
}

#[derive(Clone, Debug, Default)]
pub struct TradeModel {
    pub session: Option<TradeSession>,
    pub partner_label: String,
    /// Player rows eligible to add to the offer (available > 0, not exchange).
    pub offerable: Vec<InventoryRow>,
    /// Selected target for a PROPOSE action when no session is live.
    pub propose_target: Option<(String, String)>, // (actor_id, label)
}

// ─────────────────────────────── crafting ────────────────────────────────────

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CraftRecipeSummary {
    pub recipe_id: String,
    pub name: String,
    pub category: String,
    pub output_item_id: u32,
    pub unlocked: bool,
    pub required_tool_item_id: u32,
    pub required_profession: String,
    pub hands_craftable: bool,
    pub source: String,
    pub remaining_uses: Option<i64>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CraftStatLine {
    pub line_id: u8,
    pub label: String,
    pub cap_estimate_milli: i64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CraftSlotSpec {
    pub slot_index: u8,
    pub symbol: String,
    pub resource_kind_label: String,
    pub required_item_name: Option<String>,
    pub required_qty: i64,
    pub craft_relevant_stat: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CraftRecipeDetail {
    pub recipe_id: String,
    pub output_item_id: u32,
    pub slots: Vec<CraftSlotSpec>,
    pub stat_lines: Vec<CraftStatLine>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CraftResourceOption {
    pub container: String,
    #[serde(deserialize_with = "de_string_or_num")]
    pub stack_id: String,
    pub item_id: u32,
    pub variant_id: u32,
    pub name: String,
    pub qty_available: i64,
    pub craft_relevant_stat_value: i64,
    pub recommended: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CraftAssigned {
    pub container: String,
    #[serde(deserialize_with = "de_string_or_num")]
    pub stack_id: String,
    pub variant_id: u32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CraftSlotFill {
    pub slot_index: u8,
    pub symbol: String,
    pub resource_kind_label: String,
    pub required_qty: i64,
    pub required_item_name: Option<String>,
    pub eligible: Vec<CraftResourceOption>,
    pub assigned: Option<CraftAssigned>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CraftSlotScreen {
    pub recipe_id: String,
    pub slots: Vec<CraftSlotFill>,
    pub can_assemble: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CraftAssembledLine {
    pub line_id: u8,
    pub label: String,
    pub value_milli: i64,
    pub cap_milli: i64,
    pub can_raise: bool,
    pub one_point_success_milli: Option<i64>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CraftAssembled {
    pub recipe_id: String,
    pub assembly_quality_milli: i64,
    pub experimentation_points_remaining: i64,
    pub lines: Vec<CraftAssembledLine>,
}

/// Wire `GameCraftSession` (targeted `craftSession` room message + sections).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CraftSession {
    /// "browse" | "slots" | "assembled" (server-owned phase string).
    pub phase: String,
    pub recipe_id: Option<String>,
    pub recipes: Vec<CraftRecipeSummary>,
    pub detail: Option<CraftRecipeDetail>,
    pub details: Vec<CraftRecipeDetail>,
    pub slot_screen: Option<CraftSlotScreen>,
    pub assembled: Option<CraftAssembled>,
    pub tick: i64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DraftedSchematic {
    pub id: String,
    pub recipe_id: String,
    pub output_item_id: u32,
    pub max_uses: i64,
    pub remaining_uses: i64,
}

#[derive(Clone, Debug, Default)]
pub struct CraftModel {
    pub session: Option<CraftSession>,
    pub drafts: Vec<DraftedSchematic>,
    /// Factory terminal gate (FactoryManufacture).
    pub factory: Gate,
    /// In-range trainer (RequestStarterTool origin), if any.
    pub trainer_actor_id: Option<String>,
}

// ───────────────────────── survey / extraction / camps ──────────────────────

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ResourceSpawn {
    pub spawn_id: String,
    pub family: String,
    pub name: String,
    pub class_label: String,
    pub variant_id: u32,
    pub stats: ResourceStats,
}

/// Wire `GameSurveyResult` (targeted `surveyResult` room message).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SurveyResult {
    pub family: String,
    pub area_id: String,
    pub spawn_id: String,
    pub spawn_name: String,
    pub center_x: f32,
    pub center_y: f32,
    pub range_cells: i64,
    pub step_cells: i64,
    pub cols: i64,
    pub rows: i64,
    pub concentration_milli: Vec<i64>,
    pub cooldown_until_tick: i64,
    pub tick: i64,
}

impl SurveyResult {
    /// Richest sampled point → (world x, world y, milli).
    pub fn richest(&self) -> Option<(f32, f32, i64)> {
        let mut best: Option<(usize, i64)> = None;
        for (i, &m) in self.concentration_milli.iter().enumerate() {
            if best.map(|(_, b)| m > b).unwrap_or(true) {
                best = Some((i, m));
            }
        }
        let (idx, milli) = best?;
        let cols = self.cols.max(1);
        let col = (idx as i64 % cols) as f32;
        let row = (idx as i64 / cols) as f32;
        let step = self.step_cells as f32;
        let half_w = (self.cols.max(1) - 1) as f32 * 0.5;
        let half_h = (self.rows.max(1) - 1) as f32 * 0.5;
        Some((
            self.center_x + (col - half_w) * step,
            self.center_y + (row - half_h) * step,
            milli,
        ))
    }
}

/// Wire `PlacedExtractorVM`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PlacedExtractor {
    pub extractor_id: String,
    pub area_id: String,
    pub cell_x: i64,
    pub cell_y: i64,
    /// "idle" | "manual" | "battery"
    pub mode: String,
    pub biome: String,
    pub hopper_pct: f64,
    pub collectable_units: i64,
    pub battery_pct: f64,
    pub is_owner: bool,
    pub family_label: String,
}

/// Wire `PlacedCampVM`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PlacedCamp {
    pub camp_id: String,
    pub area_id: String,
    pub cell_x: i64,
    pub cell_y: i64,
    pub is_owner: bool,
    pub render_kind: String,
    pub abandon_seconds_remaining: Option<i64>,
}

/// Sim `POINT_BLANK_INTERACTION_RADIUS` — every extractor verb.
pub const EXTRACTOR_REACH_CELLS: f32 = 1.5;
/// Camp verbs work inside the tent's 5×5 footprint.
pub const CAMP_FOOTPRINT_CELLS: f32 = 2.5;

#[derive(Clone, Debug)]
pub struct ExtractorView {
    pub vm: PlacedExtractor,
    pub distance: f32,
    pub in_reach: bool,
}

#[derive(Clone, Debug)]
pub struct CampView {
    pub vm: PlacedCamp,
    pub distance: f32,
    pub in_footprint: bool,
}

/// One selectable survey/sample family with a live-spawn label.
#[derive(Clone, Debug, PartialEq)]
pub struct SurveyFamilyOption {
    pub family: String,
    pub label: String,
}

#[derive(Clone, Debug, Default)]
pub struct SurveyModel {
    /// Live target families from the authority resource-spawn snapshot.
    pub families: Vec<SurveyFamilyOption>,
    /// Newest survey result per family for the active area.
    pub results: Vec<SurveyResult>,
    /// Sample cooldown: ticks remaining until the next sample (0 = ready).
    pub sample_cooldown_ticks: i64,
    /// Nearby resource spawn detail rows (taxonomy examine).
    pub spawns: Vec<ResourceSpawn>,
    pub extractors: Vec<ExtractorView>,
    pub camps: Vec<CampView>,
    /// Player already owns a placed camp (PlaceCamp is one-at-a-time).
    pub own_camp_placed: bool,
    /// Battery cells in inventory eligible for `InsertBattery`.
    pub batteries: Vec<InventoryRow>,
}

impl SurveyModel {
    pub fn result_for(&self, family: &str) -> Option<&SurveyResult> {
        self.results.iter().find(|r| r.family == family)
    }
}

// ─────────────────────── progression / character ─────────────────────────────

/// Wire `GameActorProfessionSnapshot` (actor `professions[]`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProfessionState {
    pub id: String,
    pub label: String,
    pub xp: i64,
    pub track_xp: HashMap<String, i64>,
    pub skill_points: i64,
    pub skill_boxes: Vec<String>,
}

/// Wire `GameActorProfessionTitleSnapshot`.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct ProfessionTitle {
    pub id: String,
    pub label: String,
    pub skill_box_id: String,
}

/// Wire `GameActorWeaponSnapshot` (decoded from the actor JSON).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WeaponState {
    pub weapon_id: String,
    pub ammo_type: String,
    pub loaded_rounds: i64,
    pub magazine_size: i64,
    pub reload_remaining_ticks: i64,
}

/// Wire `GameActorStatusSnapshot`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct StatusEffect {
    pub id: String,
    pub label: String,
    pub severity: i64,
    pub remaining_ms: i64,
    pub stacks: Option<i64>,
}

/// Wire `GameActorPersonalShieldSnapshot`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct PersonalShield {
    pub charge_milli: i64,
    pub max_charge_milli: i64,
    pub durability_charges: i64,
    pub max_durability_charges: i64,
}

/// The player actor decoded once per rebuild from its wire-named JSON view.
/// Absent fields (pre-expansion store) decode to defaults, never panic.
#[derive(Clone, Debug, Default)]
pub struct PlayerSummary {
    pub actor_id: String,
    pub name: String,
    pub health: f32,
    pub health_max: f32,
    pub action: f32,
    pub action_max: f32,
    pub life_state: String,
    pub posture: String,
    pub credits: i64,
    pub faction_id: Option<String>,
    pub pvp_status: String,
    pub professions: Vec<ProfessionState>,
    pub active_title: Option<ProfessionTitle>,
    pub career_goal_id: Option<String>,
    pub skill_points_used: i64,
    pub skill_points_cap: i64,
    pub weapon: Option<WeaponState>,
    pub shield: Option<PersonalShield>,
    pub statuses: Vec<StatusEffect>,
    pub in_combat: bool,
    pub clone_sickness_remaining_ms: i64,
    pub next_sample_tick: i64,
    pub worn: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct CharacterModel {
    pub player: PlayerSummary,
    pub area_id: String,
    /// Earned selectable titles (from trained skill boxes carrying `title`).
    pub title_options: Vec<ProfessionTitle>,
    /// Human label for the active career goal.
    pub career_goal_label: Option<String>,
}

/// One skill box joined from the checked-in progression spec + actor state.
#[derive(Clone, Debug, Default)]
pub struct SkillBoxView {
    pub id: String,
    pub label: String,
    pub row: u8,
    pub column: u8,
    pub xp_cost: i64,
    pub skill_point_cost: i64,
    pub credit_cost: i64,
    pub title: Option<String>,
    pub grants: Vec<String>,
    pub prerequisites: Vec<String>,
    pub trained: bool,
    /// Purchasable right now (prereqs + xp + points + credits + trainer).
    pub available: bool,
    /// Why not (reference deny copy) when `available == false` and untrained.
    pub deny_reason: String,
}

#[derive(Clone, Debug, Default)]
pub struct ProfessionTreeView {
    pub id: String,
    pub label: String,
    pub xp: i64,
    pub boxes: Vec<SkillBoxView>,
}

#[derive(Clone, Debug, Default)]
pub struct TrainerView {
    pub actor_id: String,
    pub name: String,
    pub profession_id: String,
    pub in_range: bool,
}

#[derive(Clone, Debug, Default)]
pub struct SkillsModel {
    pub professions: Vec<ProfessionTreeView>,
    pub skill_points_used: i64,
    pub skill_points_cap: i64,
    pub credits: i64,
    /// Purchase/unlearn require a live in-range trainer (reference DENY_RANGE).
    pub trainer: Option<TrainerView>,
}

// ───────────────────────────── clone terminal ────────────────────────────────

#[derive(Clone, Debug, Default)]
pub struct CloneModel {
    pub gate: Gate,
    pub backup_present: bool,
    pub backup_saved_tick: Option<i64>,
    pub backup_skill_count: i64,
    pub backup_cost: i64,
    pub vault_credits: i64,
    pub wallet_credits: i64,
    /// Player downed/dead ⇒ CLONE NOW (CloneRespawn) surfaces here too.
    pub dead: bool,
    pub clone_sickness_remaining_ms: i64,
}

// ─────────────────────────── dialogue / converse ─────────────────────────────

/// Wire `GameDialogueDelivery` (delta `dialogueDeliveries[]`).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DialogueDelivery {
    pub actor_id: String,
    pub speaker: String,
    pub body: String,
    pub tick: i64,
}

/// Reference deny copy for out-of-range trainer actions.
pub const DENY_RANGE: &str = "MOVE CLOSER TO THE TRAINER";

#[derive(Clone, Debug, Default)]
pub struct ConverseModel {
    /// Live NPC target (trainer or talker); None ⇒ NO ONE TO TALK TO state.
    pub npc: Option<TrainerView>,
    /// Streamed dialogue lines addressed to/near us, oldest → newest (bounded).
    pub deliveries: Vec<DialogueDelivery>,
    /// Career goals the trainer offers (from the checked-in script content).
    pub career_goals: Vec<(String, String)>, // (goal_id, label)
    /// Purchasable teach list for the trainer's profession.
    pub teachable: Vec<SkillBoxView>,
    pub career_goal_id: Option<String>,
}

// ─────────────────────────────── travel ──────────────────────────────────────

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TravelCity {
    pub id: String,
    pub label: String,
    pub terminal_prop_id: String,
    pub price: i64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TravelPlanet {
    pub id: String,
    pub label: String,
    pub cities: Vec<TravelCity>,
}

/// Sim `TRAVEL_USE_RANGE_CELLS` — buy/use requires origin-terminal proximity.
pub const TRAVEL_USE_RANGE_CELLS: f32 = 10.0;

#[derive(Clone, Debug, Default)]
pub struct TravelModel {
    pub gate: Gate,
    /// Origin terminal context (planet id, city id) when linked.
    pub origin: Option<(String, String)>,
    pub planets: Vec<TravelPlanet>,
    /// Held travel tickets (inventory rows with `metadata.travelTicket`).
    pub tickets: Vec<InventoryRow>,
    pub wallet_credits: i64,
}

// ──────────────────────── player association (guild) ────────────────────────

/// Authoritative charter price (sim re-validates; UI shows the exact figure).
pub const GUILD_CHARTER_FEE_CREDITS: i64 = 250_000;
/// Charter/management kiosk reach (shared with bank/clone terminals).
pub const KIOSK_REACH_CELLS: f32 = 1.75;

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GuildWar {
    pub opposing_guild_id: String,
    pub opposing_name: String,
    pub opposing_tag: String,
    /// "outgoing" | "incoming" | "mutual"
    pub state: String,
    pub declared_tick: i64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GuildSummary {
    pub id: String,
    pub name: String,
    pub tag: String,
    pub leader_actor_id: String,
    pub member_count: i64,
    pub wars: Vec<GuildWar>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GuildRosterEntry {
    pub actor_id: String,
    pub name: String,
    /// "leader" | "officer" | "member" (server-derived).
    pub role: String,
    /// Server-derived permission strings: invite/kick/roles/war/disband.
    pub permissions: Vec<String>,
    pub online: bool,
    pub area_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GuildPendingInvite {
    pub invite_id: String,
    pub guild_id: String,
    pub guild_name: String,
    pub guild_tag: String,
    pub inviter_name: String,
    pub expires_tick: i64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GuildDirectoryEntry {
    pub id: String,
    pub name: String,
    pub tag: String,
    pub member_count: i64,
}

/// Wire `GameGuildView` (owner-scoped section).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GuildView {
    pub guild: Option<GuildSummary>,
    pub roster: Vec<GuildRosterEntry>,
    pub pending_invites: Vec<GuildPendingInvite>,
    pub directory: Vec<GuildDirectoryEntry>,
}

#[derive(Clone, Debug, Default)]
pub struct PaModel {
    pub gate: Gate,
    pub view: GuildView,
    pub my_actor_id: String,
    pub wallet_credits: i64,
    /// Selected player eligible for invite actions.
    pub target: Option<(String, String)>,
}

impl PaModel {
    /// The local player's roster entry (server-derived role/permissions).
    pub fn me(&self) -> Option<&GuildRosterEntry> {
        self.view
            .roster
            .iter()
            .find(|r| r.actor_id == self.my_actor_id)
    }
    pub fn has_permission(&self, p: &str) -> bool {
        self.me()
            .map(|m| m.role == "leader" || m.permissions.iter().any(|x| x == p))
            .unwrap_or(false)
    }
    pub fn is_leader(&self) -> bool {
        self.me().map(|m| m.role == "leader").unwrap_or(false)
    }
}

// ───────────────────────────── groups / duels ───────────────────────────────

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(default)]
pub struct GroupVitals {
    pub health: f32,
    pub action: f32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GroupMember {
    pub actor_id: String,
    pub name: String,
    pub area_id: String,
    pub vitals: GroupVitals,
    pub max_vitals: GroupVitals,
    pub life_state: String,
    pub is_leader: bool,
    pub link_dead: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GroupSummary {
    pub group_id: i64,
    pub leader_actor_id: String,
    pub member_actor_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GroupPendingInvite {
    pub inviter_actor_id: String,
    pub inviter_name: String,
    pub expires_tick: i64,
}

/// Wire `GameGroupView`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GroupView {
    pub group: Option<GroupSummary>,
    pub members: Vec<GroupMember>,
    pub pending_invite: Option<GroupPendingInvite>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DuelSummary {
    pub duel_id: i64,
    pub opponent_actor_id: String,
    pub opponent_name: String,
    pub expires_tick: i64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DuelChallenge {
    pub other_actor_id: String,
    pub other_name: String,
    pub expires_tick: i64,
}

/// Wire `GameDuelView`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DuelView {
    pub active_duel: Option<DuelSummary>,
    pub incoming_challenge: Option<DuelChallenge>,
    pub outgoing_challenge: Option<DuelChallenge>,
}

/// Wire `GameDuelOutcome` (targeted `duelOutcome` room message).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DuelOutcome {
    pub opponent_name: String,
    /// "won" | "lost" | "dissolved"
    pub result: String,
    /// "yield" | "down" | "range" | "timeout" | "disconnect"
    pub reason: String,
    pub tick: i64,
}

#[derive(Clone, Debug, Default)]
pub struct GroupModel {
    pub my_actor_id: String,
    pub group: GroupView,
    pub duel: DuelView,
    pub outcomes: Vec<DuelOutcome>,
    /// Selected target for INVITE/CHALLENGE (actor id, label, is_player).
    pub target: Option<(String, String, bool)>,
    /// Downed duel opponent eligible for DEATHBLOW.
    pub deathblow_target: Option<(String, String)>,
}

impl GroupModel {
    pub fn is_leader(&self) -> bool {
        self.group
            .group
            .as_ref()
            .map(|g| g.leader_actor_id == self.my_actor_id)
            .unwrap_or(false)
    }
}

// ─────────────────────────── farming / parcels ──────────────────────────────

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(default)]
pub struct FarmRect {
    pub x: i64,
    pub y: i64,
    pub w: i64,
    pub h: i64,
}

/// Wire `ParcelVM`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Parcel {
    pub parcel_id: String,
    pub planet_id: String,
    pub area_id: String,
    pub name: String,
    pub rect: FarmRect,
    pub tier: String,
    pub is_owner: bool,
    pub upkeep_due_in_game_days: Option<f64>,
    pub tilled_tiles: i64,
    pub planted_tiles: i64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FarmCrop {
    pub species: String,
    pub stage: i64,
    pub stage_count: i64,
    pub health: String,
    pub blight: String,
    pub time_to_mature_game_days: Option<f64>,
    pub quality_so_far_milli: i64,
    pub mature: bool,
}

/// Wire `FarmTileVM` — `legal_verbs` is blanked server-side for non-owners.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FarmTile {
    pub cell_x: i64,
    pub cell_y: i64,
    pub tilled: bool,
    pub moisture_pct: f64,
    pub crop: Option<FarmCrop>,
    pub legal_verbs: Vec<String>,
}

/// Wire `FarmPlotVM`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct FarmPlot {
    pub parcel_id: String,
    pub area_id: String,
    pub tiles: Vec<FarmTile>,
}

#[derive(Clone, Debug, Default)]
pub struct FarmModel {
    pub parcels: Vec<Parcel>,
    pub plots: Vec<FarmPlot>,
    /// Seed stacks in inventory (PlantSeed candidates).
    pub seeds: Vec<InventoryRow>,
    /// Fertilizer stacks in inventory (Fertilize candidates).
    pub fertilizers: Vec<InventoryRow>,
    /// Farm structure kits in inventory (PlaceFarmStructure candidates).
    pub structures: Vec<InventoryRow>,
    /// Claim context: player cell + area/planet for ClaimParcel.
    pub player_cell: (i64, i64),
    pub area_id: String,
    pub planet_id: String,
}

impl FarmModel {
    pub fn plot_for(&self, parcel_id: &str) -> Option<&FarmPlot> {
        self.plots.iter().find(|p| p.parcel_id == parcel_id)
    }
}

// ────────────────────────────── construction ────────────────────────────────

/// Wire `GameBuildingProjection` (`building` section envelope).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BuildingProjection {
    pub schema: String,
    pub tick: i64,
    pub components: Vec<BuildComponent>,
}

/// Wire `GameBuildComponent`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BuildComponent {
    pub component_id: String,
    pub owner_actor_id: String,
    pub parcel_id: String,
    pub catalog_id: String,
    pub kind: String,
    pub cell_x: i64,
    pub cell_y: i64,
    pub rotation_quarters: i64,
    pub door_open: bool,
}

/// One placeable entry from the checked-in build catalog.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BuildCatalogItem {
    pub catalog_id: String,
    pub label: String,
    pub category: String,
    /// (material id, units) costs.
    pub costs: Vec<(String, i64)>,
    pub w: i64,
    pub h: i64,
    pub is_door: bool,
}

/// Ghost placement preview the world layer computes (cursor cell + validity).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BuildGhost {
    pub cell_x: i64,
    pub cell_y: i64,
    pub rotation_quarters: u8,
    pub valid: bool,
    pub invalid_reason: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct BuildModel {
    /// Owned parcel the player stands in (build gate) — label shown in strip.
    pub parcel: Option<Parcel>,
    pub catalog: Vec<BuildCatalogItem>,
    /// Owned material units by material id (authority inventory projection).
    pub materials: Vec<(String, i64)>,
    pub ghost: Option<BuildGhost>,
    /// Own components (BuildRemove / BuildToggleDoor targets), nearest first.
    pub components: Vec<BuildComponent>,
}

impl BuildModel {
    pub fn material_units(&self, id: &str) -> i64 {
        self.materials
            .iter()
            .find(|(m, _)| m == id)
            .map(|(_, n)| *n)
            .unwrap_or(0)
    }
    pub fn affordable(&self, item: &BuildCatalogItem) -> bool {
        item.costs.iter().all(|(m, n)| self.material_units(m) >= *n)
    }
}

// ─────────────────────────── bioengineering ─────────────────────────────────

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SpliceSlot {
    pub slot_index: u8,
    /// "parent" | "reagent"
    pub kind: String,
    pub label: String,
    pub filled: bool,
    pub item_id: u32,
    pub variant_id: u32,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SpliceLine {
    pub locus: u8,
    pub label: String,
    pub base_milli: i64,
    pub value_milli: i64,
    pub cap_milli: i64,
    pub can_raise: bool,
}

/// Wire `GameSpliceSession` (targeted `spliceSession` room message).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SpliceSession {
    /// "browse" | "slots" | "assembled"
    pub phase: String,
    pub species_id: i64,
    pub species_name: String,
    pub slots: Vec<SpliceSlot>,
    pub lines: Vec<SpliceLine>,
    pub assembly_quality_milli: i64,
    pub points_total: i64,
    pub points_remaining: i64,
    pub can_assemble: bool,
    pub tick: i64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GenomeScanLocus {
    pub locus: u8,
    pub label: String,
    pub express_milli: i64,
    pub heterozygous: Option<bool>,
    pub a1: Option<i64>,
    pub a2: Option<i64>,
}

/// Wire `GameGenomeScan` (targeted `genomeScan` room message).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GenomeScan {
    pub item_id: u32,
    pub variant_id: u32,
    pub species_name: String,
    pub cultivar_name: String,
    /// "phenotype" | "hidden_presence" | "allele_values" | "full"
    pub tier: String,
    pub fertile: bool,
    pub loci: Vec<GenomeScanLocus>,
    pub generation: Option<i64>,
    pub tick: i64,
}

#[derive(Clone, Debug, Default)]
pub struct SpliceModel {
    pub session: Option<SpliceSession>,
    pub scans: Vec<GenomeScan>,
    /// Genome-bearing stacks eligible for ScanGenome / SpliceAssignSlot.
    pub samples: Vec<InventoryRow>,
    /// Live creature target for GeneSample (species, actor id, in range).
    pub sample_target: Option<(String, String, bool)>,
}

// ─────────────────────────────── examine ────────────────────────────────────

#[derive(Clone, Debug, Default)]
pub struct ExamineActor {
    pub actor_id: String,
    pub name: String,
    pub descriptor: String,
    pub life_state: String,
    pub faction_id: Option<String>,
    pub pvp_status: String,
    pub organization_tag: Option<String>,
    pub health: f32,
    pub health_max: f32,
}

#[derive(Clone, Debug, Default)]
pub struct ExamineModel {
    pub actor: Option<ExamineActor>,
    pub item: Option<InventoryRow>,
    pub prop: Option<(String, String)>, // (prop id, label)
}

// ─────────────────────────── receipts / pending ─────────────────────────────

/// A resolved command receipt joined with its sent kind (256-entry sent log,
/// port of the reference `createRejectWatcher` kind resolution).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ReceiptView {
    pub command_id: u64,
    pub kind: String,
    pub accepted: bool,
    pub reason_code: Option<String>,
    pub at_ms: f64,
}

impl ReceiptView {
    /// Reference deny copy: `DENIED · REASON CODE`.
    pub fn denied_copy(&self) -> String {
        format!(
            "DENIED · {}",
            self.reason_code
                .as_deref()
                .unwrap_or("unspecified")
                .replace('_', " ")
                .to_ascii_uppercase()
        )
    }
}

/// Reference status-flash window (`STATUS_FLASH_MS` ≈ 2.6 s).
pub const STATUS_FLASH_MS: f64 = 2600.0;

#[derive(Clone, Debug, Default)]
pub struct ReceiptsModel {
    /// Kinds currently pending/in flight (queue not yet settled).
    pub pending_kinds: Vec<String>,
    pub last: Option<ReceiptView>,
}

impl ReceiptsModel {
    /// True while a command of one of `kinds` is pending (drives PENDING… UI).
    pub fn is_pending(&self, kinds: &[&str]) -> bool {
        self.pending_kinds
            .iter()
            .any(|k| kinds.iter().any(|w| k == w))
    }

    /// Fresh rejection flash for this window's kinds (reference RejectWatcher):
    /// only rejections of watched kinds, only within the flash window.
    pub fn denied(&self, kinds: &[&str], now_ms: f64) -> Option<String> {
        let r = self.last.as_ref()?;
        if r.accepted || now_ms - r.at_ms > STATUS_FLASH_MS {
            return None;
        }
        if !kinds.iter().any(|k| *k == r.kind) {
            return None;
        }
        Some(r.denied_copy())
    }
}

// ───────────────────────── options (HUD/support slice) ──────────────────────
// Owned by the section-7 worker; retained so the options window keeps
// compiling until its live rewrite lands.

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum OptionKind {
    Slider(f32), // 0..1
    Toggle(bool),
}

#[derive(Clone, Debug)]
pub struct OptionRow {
    pub label: String,
    pub kind: OptionKind,
}

#[derive(Clone, Debug, Default)]
pub struct Options {
    pub rows: Vec<OptionRow>,
}

// ────────────────────────────── aggregate ───────────────────────────────────

/// Aggregate the windows read from. Fields default empty; each window renders
/// its reference "unavailable" state when its section is unset.
#[derive(Clone, Debug, Default)]
pub struct WindowModel {
    pub connected: bool,
    pub tick: u64,
    pub player: PlayerSummary,
    pub inventory: InventoryModel,
    pub bank: BankModel,
    pub loot: Option<LootModel>,
    pub trade: TradeModel,
    pub craft: CraftModel,
    pub survey: SurveyModel,
    pub character: CharacterModel,
    pub skills: SkillsModel,
    pub clone: CloneModel,
    pub converse: ConverseModel,
    pub travel: TravelModel,
    pub pa: PaModel,
    pub group: GroupModel,
    pub farm: FarmModel,
    pub build: BuildModel,
    pub splice: SpliceModel,
    pub examine: ExamineModel,
    pub receipts: ReceiptsModel,
    pub waypoints: Vec<crate::hud::waypoints::Waypoint>,
    pub macros: Vec<crate::game::macro_runtime::MacroSource>,
    pub options: Options,
}

impl WindowModel {
    /// Empty model for explicit developer demos and isolated UI tests.
    /// Connected mode must populate this from the accepted authority frame.
    pub fn sample() -> Self {
        Self::default()
    }
}
