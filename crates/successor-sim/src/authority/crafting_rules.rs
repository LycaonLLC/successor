//! Craft sessions, public projections, variants, and deterministic crafting rules.

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum CraftSessionPhase {
    SlotFill,
    Assembled,
}

impl CraftSessionPhase {
    pub(super) const fn code(self) -> u32 {
        match self {
            Self::SlotFill => 1,
            Self::Assembled => 2,
        }
    }

    pub(super) const fn label(self) -> &'static str {
        match self {
            Self::SlotFill => "slots",
            Self::Assembled => "assembled",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CraftSessionLineState {
    pub(super) line_id: u8,
    pub(super) label: String,
    pub(super) value_milli: u16,
    pub(super) cap_milli: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CraftLimitedSchematicUseState {
    pub(super) container: String,
    pub(super) stack_id: u64,
    pub(super) variant_id: u32,
    pub(super) remaining_uses: u16,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CraftSlotAssignmentState {
    pub(super) slot_index: u8,
    pub(super) container: String,
    pub(super) stack_id: u64,
    pub(super) item_id: u32,
    pub(super) variant_id: u32,
    pub(super) quantity: u32,
    pub(super) stats: ResourceStats,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CraftResourceLock {
    pub(super) item_id: u32,
    pub(super) variant_id: u32,
    pub(super) quantity: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CraftSessionState {
    pub(super) recipe_id: String,
    pub(super) phase: CraftSessionPhase,
    pub(super) slots: Vec<Option<CraftSlotAssignmentState>>,
    pub(super) resource_locks: Vec<CraftResourceLock>,
    pub(super) assembly_seed: u32,
    pub(super) assembly_quality_milli: u16,
    pub(super) experimentation_points_remaining: u8,
    pub(super) lines: Vec<CraftSessionLineState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) limited_schematic: Option<CraftLimitedSchematicUseState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DraftedSchematicState {
    pub(super) id: String,
    pub(super) owner_actor_id: String,
    pub(super) recipe_id: String,
    pub(super) resource_locks: Vec<CraftResourceLock>,
    pub(super) output_item_id: u32,
    pub(super) output_variant_id: u32,
    /// Exact physical drafted-schematic inventory variant locked to this durable row.
    #[serde(default)]
    pub(super) schematic_item_variant_id: u32,
    pub(super) max_uses: u16,
    pub(super) remaining_uses: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CraftResourceLockSnapshot {
    pub item_id: u32,
    pub variant_id: u32,
    pub quantity: u32,
}

impl From<&CraftResourceLock> for CraftResourceLockSnapshot {
    fn from(lock: &CraftResourceLock) -> Self {
        Self {
            item_id: lock.item_id,
            variant_id: lock.variant_id,
            quantity: lock.quantity,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityDraftedSchematicSnapshot {
    pub id: String,
    pub owner_actor_id: String,
    pub recipe_id: String,
    pub resource_locks: Vec<CraftResourceLockSnapshot>,
    pub output_item_id: u32,
    pub output_variant_id: u32,
    pub schematic_item_variant_id: u32,
    pub max_uses: u16,
    pub remaining_uses: u16,
}

impl AuthorityDraftedSchematicSnapshot {
    pub(super) fn from_state(schematic: &DraftedSchematicState) -> Self {
        Self {
            id: schematic.id.clone(),
            owner_actor_id: schematic.owner_actor_id.clone(),
            recipe_id: schematic.recipe_id.clone(),
            resource_locks: schematic
                .resource_locks
                .iter()
                .map(CraftResourceLockSnapshot::from)
                .collect(),
            output_item_id: schematic.output_item_id,
            output_variant_id: schematic.output_variant_id,
            schematic_item_variant_id: schematic.schematic_item_variant_id,
            max_uses: schematic.max_uses,
            remaining_uses: schematic.remaining_uses,
        }
    }
}

/// Owner-only factory manufacture receipt for one accepted physical draft run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityFactoryManufactureSnapshot {
    pub factory_id: String,
    pub schematic_id: String,
    pub recipe_id: String,
    pub output_item_id: u32,
    pub output_variant_id: u32,
    pub output_quantity: u32,
    pub remaining_uses: u16,
    pub max_uses: u16,
    pub spent: bool,
    pub tick: u64,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CraftRecipeSummarySnapshot {
    pub recipe_id: String,
    pub name: String,
    pub category: String,
    pub output_item_id: u32,
    pub output_preview_variant_id: u32,
    pub unlocked: bool,
    pub required_tool_item_id: u32,
    pub required_profession: String,
    pub hands_craftable: bool,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remaining_uses: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CraftSlotSpecSnapshot {
    pub slot_index: u8,
    pub symbol: String,
    pub resource_kind_label: String,
    pub required_item_id: Option<u32>,
    pub required_family: Option<String>,
    pub requirement_kind: String,
    pub required_item_name: String,
    pub required_qty: u32,
    pub craft_relevant_stat: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CraftRecipeDetailSnapshot {
    pub recipe_id: String,
    pub output_item_id: u32,
    pub output_preview_variant_id: u32,
    pub slots: Vec<CraftSlotSpecSnapshot>,
    pub stat_lines: Vec<CraftStatLinePreviewSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CraftStatLinePreviewSnapshot {
    pub line_id: u8,
    pub label: String,
    pub cap_estimate_milli: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CraftSlotAssignmentSnapshot {
    pub container: String,
    pub stack_id: String,
    pub variant_id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CraftResourceOptionSnapshot {
    pub container: String,
    pub stack_id: String,
    pub item_id: u32,
    pub variant_id: u32,
    pub name: String,
    pub qty_available: u32,
    pub craft_relevant_stat_value: u16,
    pub recommended: bool,
    pub stats: AuthorityResourceStatsSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CraftSlotFillSnapshot {
    pub slot_index: u8,
    pub symbol: String,
    pub resource_kind_label: String,
    pub required_qty: u32,
    pub required_item_id: Option<u32>,
    pub required_family: Option<String>,
    pub requirement_kind: String,
    pub required_item_name: String,
    pub eligible: Vec<CraftResourceOptionSnapshot>,
    pub assigned: Option<CraftSlotAssignmentSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CraftSlotScreenSnapshot {
    pub recipe_id: String,
    pub slots: Vec<CraftSlotFillSnapshot>,
    pub can_assemble: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CraftAssembledLineSnapshot {
    pub line_id: u8,
    pub label: String,
    pub value_milli: u16,
    pub cap_milli: u16,
    pub can_raise: bool,
    #[serde(default)]
    pub one_point_success_milli: u16,
    #[serde(default)]
    pub batch_risk_per_extra_point_milli: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CraftAssembledSnapshot {
    pub recipe_id: String,
    pub assembly_quality_milli: u16,
    pub experimentation_points_remaining: u8,
    pub lines: Vec<CraftAssembledLineSnapshot>,
    pub output_preview_variant_id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityCraftSessionSnapshot {
    pub phase: String,
    pub recipe_id: Option<String>,
    pub recipes: Vec<CraftRecipeSummarySnapshot>,
    pub detail: Option<CraftRecipeDetailSnapshot>,
    pub slot_screen: Option<CraftSlotScreenSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub details: Vec<CraftRecipeDetailSnapshot>,
    pub assembled: Option<CraftAssembledSnapshot>,
    pub tick: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityCraftSessionDeltaPayload {
    pub schema: String,
    pub tick: u64,
    pub craft_session: Option<AuthorityCraftSessionSnapshot>,
}

/// One item line on a side of a trade session VM (display name resolved server
/// side so the counterparty never needs the item taxonomy).

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityDraftedSchematicsDeltaPayload {
    pub schema: String,
    pub tick: u64,
    pub drafted_schematics: Vec<AuthorityDraftedSchematicSnapshot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct SlugthrowerCraftStats {
    pub(super) power: u16,
    pub(super) handling: u16,
    pub(super) reliability: u16,
}

impl SlugthrowerCraftStats {
    pub(super) const fn power_damage_multiplier_per_100(self) -> i32 {
        100 + self.power.saturating_sub(40) as i32 / 2
    }

    pub(super) const fn handling_accuracy_bonus(self) -> i32 {
        self.handling.saturating_sub(50) as i32 / 5
    }

    pub(super) const fn handling_attack_interval_reduction_percent(self) -> u32 {
        (self.handling.saturating_sub(50) as u32).saturating_mul(2) / 5
    }

    pub(super) const fn reliability_reload_reduction_percent(self) -> u32 {
        self.reliability.saturating_sub(50) as u32 / 2
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum MedicalSchematicKind {
    StimpakA,
    BodyEnhancementPackA,
    SpiritEnhancementPackA,
    /// Component-built high-heal stimpak.
    AdvancedStimpak,
    /// Anti-state stims. Potency drives defense magnitude; quantity is batch size.
    AntiDizzyStim,
    AntiBlindStim,
}

impl MedicalSchematicKind {
    pub(super) const fn item_id(self) -> u32 {
        match self {
            Self::StimpakA => STIMPAK_A_ITEM_ID,
            Self::BodyEnhancementPackA => BODY_ENHANCEMENT_PACK_A_ITEM_ID,
            Self::SpiritEnhancementPackA => SPIRIT_ENHANCEMENT_PACK_A_ITEM_ID,
            Self::AdvancedStimpak => ADVANCED_STIMPAK_ITEM_ID,
            Self::AntiDizzyStim => ANTI_DIZZY_STIM_ITEM_ID,
            Self::AntiBlindStim => ANTI_BLIND_STIM_ITEM_ID,
        }
    }

    pub(super) const fn label(self) -> &'static str {
        match self {
            Self::StimpakA => "Stimpak A",
            Self::BodyEnhancementPackA => "Body Enhancement Pack A",
            Self::SpiritEnhancementPackA => "Spirit Enhancement Pack A",
            Self::AdvancedStimpak => "Advanced Stimpak",
            Self::AntiDizzyStim => "Anti-Dizzy Stim",
            Self::AntiBlindStim => "Anti-Blind Stim",
        }
    }

    const fn variant_code(self) -> u32 {
        match self {
            Self::StimpakA => 1,
            Self::BodyEnhancementPackA => 2,
            Self::SpiritEnhancementPackA => 3,
            Self::AdvancedStimpak => 4,
            Self::AntiDizzyStim => 5,
            Self::AntiBlindStim => 6,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct MedicalCraftCaps {
    pub(super) potency: u16,
    pub(super) quantity: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct MedicalCraftStats {
    pub(super) potency: u16,
    pub(super) quantity: u16,
}

pub(super) const CRAFT_EXPERIMENT_SUCCESS_GAIN: u16 = 12;
pub(super) fn quality_cap_percent(weighted_sum: u32) -> u16 {
    let normalized = (weighted_sum / 100).min(1_000);
    u16::try_from(45 + normalized.saturating_mul(55) / 1_000).unwrap_or(100)
}

pub(super) fn experiment_line(
    base: u16,
    cap: u16,
    seed: u32,
    salt: u64,
    points: u8,
    experimentation_bonus: i32,
) -> u16 {
    experiment_line_with_context(base, cap, seed, salt, points, experimentation_bonus, 500)
}

pub(super) fn experiment_line_with_context(
    base: u16,
    cap: u16,
    seed: u32,
    salt: u64,
    points: u8,
    experimentation_bonus: i32,
    malleability_milli: u16,
) -> u16 {
    if points == 0 || base >= cap {
        return base.min(cap);
    }
    let base_success = 500_i32
        .saturating_add((i32::from(malleability_milli.min(1_000)) - 500) / 4)
        .saturating_add(experimentation_bonus.saturating_mul(2));
    let mut value = base;
    for point in 0..points {
        let success_milli = (base_success - i32::from(point) * 50).clamp(100, 950);
        let roll = (ai_rand(seed, u64::from(point) + 1, salt) * 1_000.0) as i32;
        let delta: i32 = if roll <= success_milli {
            i32::from(CRAFT_EXPERIMENT_SUCCESS_GAIN)
        } else {
            -4
        };
        value = if delta >= 0 {
            value.saturating_add(u16::try_from(delta).unwrap_or(u16::MAX))
        } else {
            value.saturating_sub(u16::try_from(-delta).unwrap_or(u16::MAX))
        }
        .clamp(0, cap);
    }
    value
}
pub(super) const MELEE_WEAPON_SPEED_VARIANT_BASE: u32 = 51_000_000;
const MELEE_WEAPON_SPEED_VARIANT_MAX_MS: u32 = 30_000;

pub(super) fn encode_slugthrower_variant(stats: SlugthrowerCraftStats) -> u32 {
    31_000_000
        + u32::from(stats.power.min(100)).saturating_mul(1_000_000)
        + u32::from(stats.handling.min(100)).saturating_mul(1_000)
        + u32::from(stats.reliability.min(100))
}

pub(super) fn decode_slugthrower_variant(variant_id: u32) -> Option<SlugthrowerCraftStats> {
    let encoded = variant_id.checked_sub(31_000_000)?;
    Some(SlugthrowerCraftStats {
        power: u16::try_from((encoded / 1_000_000).min(100)).ok()?,
        handling: u16::try_from((encoded / 1_000 % 1_000).min(100)).ok()?,
        reliability: u16::try_from((encoded % 1_000).min(100)).ok()?,
    })
}
pub(super) fn slugthrower_stats_for_variant(variant_id: u32) -> Option<SlugthrowerCraftStats> {
    decode_slugthrower_variant(variant_id)
}

pub(super) fn slugthrower_power_damage_multiplier_per_100(variant_id: u32) -> i32 {
    slugthrower_stats_for_variant(variant_id)
        .map(SlugthrowerCraftStats::power_damage_multiplier_per_100)
        .unwrap_or(100)
}

pub(super) fn slugthrower_handling_accuracy_bonus(variant_id: u32) -> i32 {
    slugthrower_stats_for_variant(variant_id)
        .map(SlugthrowerCraftStats::handling_accuracy_bonus)
        .unwrap_or(0)
}

pub(super) fn slugthrower_attack_interval_ms(base_ms: u64, variant_id: u32) -> u64 {
    let Some(stats) = slugthrower_stats_for_variant(variant_id) else {
        return base_ms;
    };
    let reduction = u64::from(stats.handling_attack_interval_reduction_percent().min(100));
    base_ms
        .saturating_mul(100_u64.saturating_sub(reduction))
        .saturating_add(99)
        / 100
}

pub(super) fn slugthrower_reload_time_ms(base_ms: u64, variant_id: u32) -> u64 {
    let Some(stats) = slugthrower_stats_for_variant(variant_id) else {
        return base_ms;
    };
    let reduction = u64::from(stats.reliability_reload_reduction_percent().min(100));
    base_ms
        .saturating_mul(100_u64.saturating_sub(reduction))
        .saturating_add(99)
        / 100
}

// schematic output side lands with the crafting follow-up lane (melee-cadence.md craft audit)
#[allow(dead_code)]
pub(super) fn encode_melee_weapon_speed_variant_ms(speed_ms: u64) -> u32 {
    MELEE_WEAPON_SPEED_VARIANT_BASE.saturating_add(
        u32::try_from(speed_ms.min(u64::from(MELEE_WEAPON_SPEED_VARIANT_MAX_MS)))
            .unwrap_or(MELEE_WEAPON_SPEED_VARIANT_MAX_MS),
    )
}

pub(super) fn decode_melee_weapon_speed_variant_ms(variant_id: u32) -> Option<u64> {
    let speed_ms = variant_id.checked_sub(MELEE_WEAPON_SPEED_VARIANT_BASE)?;
    if (1..=MELEE_WEAPON_SPEED_VARIANT_MAX_MS).contains(&speed_ms) {
        Some(u64::from(speed_ms))
    } else {
        None
    }
}

pub(super) fn encode_battery_variant(runtime_seconds: u32) -> u32 {
    EXTRACTOR_BATTERY_VARIANT_BASE
        .saturating_add(runtime_seconds.min(EXTRACTOR_BATTERY_VARIANT_MAX_RUNTIME_SECONDS))
}

pub(super) fn decode_battery_runtime_seconds(variant_id: u32) -> Option<u32> {
    let seconds = variant_id.checked_sub(EXTRACTOR_BATTERY_VARIANT_BASE)?;
    (seconds <= EXTRACTOR_BATTERY_VARIANT_MAX_RUNTIME_SECONDS).then_some(seconds)
}

// Produce (6_1xx) variant namespace: base + quality milli (0..=1000). Distinct
// from Slugthrower 31M / battery 32M / medical 41M / loot 60-65M so a produce variant
// never collides with another domain's encoding. Quality bands never merge (each
// quality is its own variant), matching the resource stat-identity discipline.
const PRODUCE_VARIANT_BASE: u32 = 66_000_000;
pub(super) fn encode_produce_variant(quality_milli: u16) -> u32 {
    PRODUCE_VARIANT_BASE.saturating_add(u32::from(quality_milli.min(1_000)))
}
#[allow(dead_code)] // decode half of the produce-variant pair; used by tests + future produce tooltips
pub(super) fn decode_produce_quality_milli(variant_id: u32) -> Option<u16> {
    let quality = variant_id.checked_sub(PRODUCE_VARIANT_BASE)?;
    (quality <= 1_000).then_some(quality as u16)
}

pub(super) fn medical_schematic_kind(schematic: &str) -> Option<MedicalSchematicKind> {
    match normalize_command_key(schematic).as_str() {
        "stimpak" | "stimpak_a" => Some(MedicalSchematicKind::StimpakA),
        "body_enhancement_pack"
        | "body_enhancement_pack_a"
        | "body_pack"
        | "body_buff_pack"
        | "medic_prep_pack" => Some(MedicalSchematicKind::BodyEnhancementPackA),
        "spirit_enhancement_pack"
        | "spirit_enhancement_pack_a"
        | "spirit_pack"
        | "spirit_buff_pack"
        | "entertainer_session_pack" => Some(MedicalSchematicKind::SpiritEnhancementPackA),
        _ => None,
    }
}

pub(super) fn medical_craft_caps(
    kind: MedicalSchematicKind,
    clodpowder: ResourceStats,
    mineral: ResourceStats,
) -> MedicalCraftCaps {
    let potency_quality = quality_cap_percent(
        u32::from(clodpowder.potency) * 58
            + u32::from(clodpowder.stability) * 22
            + u32::from(mineral.stability) * 20,
    );
    let quantity_quality = quality_cap_percent(
        u32::from(clodpowder.extraction_yield) * 34
            + u32::from(clodpowder.stability) * 28
            + u32::from(mineral.malleability) * 38,
    );
    MedicalCraftCaps {
        potency: medical_stat_at_quality(
            medical_potency_floor(kind),
            medical_potency_ceiling(kind),
            potency_quality,
        ),
        quantity: medical_stat_at_quality(
            medical_quantity_floor(kind),
            medical_quantity_ceiling(kind),
            quantity_quality,
        ),
    }
}

pub(super) fn medical_assembly_quality(
    kind: MedicalSchematicKind,
    caps: MedicalCraftCaps,
    tool_quality_milli: u16,
    crafting_bonus: i32,
    assembly_milli: u16,
) -> MedicalCraftStats {
    let crafting_bonus = u16::try_from(crafting_bonus.max(0)).unwrap_or(u16::MAX);
    let assembly_percent = 35_u16
        .saturating_add(tool_quality_milli.min(1_000) / 50)
        .saturating_add(assembly_milli.min(1_000) / 60)
        .saturating_add(crafting_bonus.min(250) / 8)
        .min(100);
    MedicalCraftStats {
        potency: medical_stat_at_quality(
            medical_potency_floor(kind),
            caps.potency,
            assembly_percent,
        ),
        quantity: medical_stat_at_quality(
            medical_quantity_floor(kind),
            caps.quantity,
            assembly_percent,
        ),
    }
}

pub(super) fn experiment_medical_stats(
    caps: MedicalCraftCaps,
    base: MedicalCraftStats,
    seed: u32,
    potency_points: u8,
    quantity_points: u8,
    experimentation_bonus: i32,
) -> MedicalCraftStats {
    // P1 fix: medic experimentation success scales off the medic's medical-crafting
    // track (medical_experimentation_bonus) exactly like the craftsman's 60->95% curve.
    // Previously a hardcoded 0 pinned every medic to 50% regardless of training.
    MedicalCraftStats {
        potency: experiment_line(
            base.potency,
            caps.potency,
            seed,
            11,
            potency_points,
            experimentation_bonus,
        ),
        quantity: experiment_line(
            base.quantity,
            caps.quantity,
            seed,
            12,
            quantity_points,
            experimentation_bonus,
        ),
    }
}

pub(super) fn encode_medical_variant(kind: MedicalSchematicKind, stats: MedicalCraftStats) -> u32 {
    41_000_000
        + kind.variant_code().saturating_mul(1_000_000)
        + u32::from(stats.potency.min(999)).saturating_mul(1_000)
        + u32::from(stats.quantity.min(999))
}

pub(super) fn decode_medical_variant(
    kind: MedicalSchematicKind,
    variant_id: u32,
) -> Option<MedicalCraftStats> {
    let encoded = variant_id.checked_sub(41_000_000)?;
    if encoded / 1_000_000 != kind.variant_code() {
        return None;
    }
    Some(MedicalCraftStats {
        potency: u16::try_from((encoded / 1_000 % 1_000).min(999)).ok()?,
        quantity: u16::try_from((encoded % 1_000).min(999)).ok()?,
    })
}

pub(super) fn decode_medical_variant_or_default(
    kind: MedicalSchematicKind,
    variant_id: u32,
) -> MedicalCraftStats {
    decode_medical_variant(kind, variant_id).unwrap_or_else(|| medical_default_stats(kind))
}

pub(super) fn medical_stimpak_heal_milli(stats: MedicalCraftStats, medicine_use_bonus: i32) -> i32 {
    i32::from(stats.potency)
        .saturating_mul(1_000)
        .saturating_mul(1_000 + medicine_use_bonus.max(0))
        / 1_000
}

pub(super) fn medical_enhancement_delta(stats: MedicalCraftStats, medicine_use_bonus: i32) -> i32 {
    i32::from(stats.potency).saturating_mul(1_000 + medicine_use_bonus.max(0)) / 1_000
}

fn medical_default_stats(kind: MedicalSchematicKind) -> MedicalCraftStats {
    MedicalCraftStats {
        potency: match kind {
            MedicalSchematicKind::StimpakA => {
                u16::try_from(STIMPAK_A_HEAL_MILLI / 1_000).unwrap_or(100)
            }
            MedicalSchematicKind::BodyEnhancementPackA => {
                u16::try_from(MEDIC_PREP_BODY_DELTA).unwrap_or(70)
            }
            MedicalSchematicKind::SpiritEnhancementPackA => {
                u16::try_from(ENTERTAINER_SESSION_SPIRIT_DELTA).unwrap_or(75)
            }
            MedicalSchematicKind::AdvancedStimpak
            | MedicalSchematicKind::AntiDizzyStim
            | MedicalSchematicKind::AntiBlindStim => medical_potency_floor(kind),
        },
        quantity: medical_quantity_floor(kind),
    }
}

/// MEDIC WAVE: map a W6 craft session's two line values (0..1000 milli) onto a
/// medical variant's `MedicalCraftStats`. Component quality drives the line CAP;
/// experimentation drives the value toward it; the value then scales the medical
/// stat between the kind's floor and ceiling. This is the quality carry-through:
/// better components + more experimentation = a stronger final product.
pub(super) fn medical_stats_from_craft_lines(
    kind: MedicalSchematicKind,
    potency_line_milli: u16,
    quantity_line_milli: u16,
) -> MedicalCraftStats {
    MedicalCraftStats {
        potency: medical_stat_at_quality(
            medical_potency_floor(kind),
            medical_potency_ceiling(kind),
            (potency_line_milli.min(1_000) / 10).min(100),
        ),
        quantity: medical_stat_at_quality(
            medical_quantity_floor(kind),
            medical_quantity_ceiling(kind),
            (quantity_line_milli.min(1_000) / 10).min(100),
        ),
    }
}

/// MEDIC WAVE: the ONE unified `defense_vs_state` magnitude an anti-state stim
/// grants (owner law: no per-state defense stats). Crafted potency P -> permille,
/// clamp 700 so it stays under a full immunity block (§5, fork F-M5 default).
pub(super) fn anti_state_defense_vs_state_milli(potency: u16) -> i32 {
    (i32::from(potency).saturating_mul(2)).clamp(0, 700)
}

/// MEDIC WAVE: intermediate medical components (1_2xx). Their crafted quality is
/// slotted into the Advanced Stimpak (see `craft_slot_stats`).
pub(super) fn is_medical_component_item_id(item_id: u32) -> bool {
    matches!(
        item_id,
        BIO_EFFECT_CONTROLLER_ITEM_ID
            | LIQUID_SUSPENSION_ITEM_ID
            | CHEMICAL_RELEASE_MECHANISM_ITEM_ID
            | SOLID_DELIVERY_SHELL_ITEM_ID
    )
}

/// A component's variant IS its crafted quality (0..1000), like the Field Multitool.
pub(super) fn medical_component_quality_from_variant(variant_id: u32) -> u16 {
    u16::try_from(variant_id.min(1_000)).unwrap_or(1_000)
}

/// Unified slot-ingredient stat reader for craft sessions. Raw and processed resources read
/// deterministic resource stats; medical components synthesize a potency channel from quality.
pub(super) fn craft_slot_stats(item_id: u32, variant_id: u32) -> Option<ResourceStats> {
    if is_medical_component_item_id(item_id) {
        let quality = medical_component_quality_from_variant(variant_id);
        return Some(ResourceStats {
            potency: quality,
            ..ResourceStats::zeroed()
        });
    }
    resource_stats_for_item_variant(item_id, variant_id)
}

fn medical_potency_floor(kind: MedicalSchematicKind) -> u16 {
    match kind {
        MedicalSchematicKind::StimpakA => 80,
        MedicalSchematicKind::BodyEnhancementPackA => 45,
        MedicalSchematicKind::SpiritEnhancementPackA => 45,
        // Advanced stimpak: even the worst advanced (cap ~450 -> ~256) beats the
        // best basic (160) -> advanced is always the upgrade.
        MedicalSchematicKind::AdvancedStimpak => 180,
        // Anti-state potency IS the defense_vs_state source (see anti_state_defense_vs_state_milli).
        MedicalSchematicKind::AntiDizzyStim | MedicalSchematicKind::AntiBlindStim => 80,
    }
}

fn medical_potency_ceiling(kind: MedicalSchematicKind) -> u16 {
    match kind {
        MedicalSchematicKind::StimpakA => 160,
        MedicalSchematicKind::BodyEnhancementPackA => 100,
        MedicalSchematicKind::SpiritEnhancementPackA => 100,
        MedicalSchematicKind::AdvancedStimpak => 350,
        MedicalSchematicKind::AntiDizzyStim | MedicalSchematicKind::AntiBlindStim => 300,
    }
}

fn medical_quantity_floor(kind: MedicalSchematicKind) -> u16 {
    match kind {
        MedicalSchematicKind::StimpakA => {
            u16::try_from(CRAFT_SUPPLY_STIMPAK_OUTPUT_QTY).unwrap_or(4)
        }
        MedicalSchematicKind::BodyEnhancementPackA
        | MedicalSchematicKind::SpiritEnhancementPackA => {
            u16::try_from(CRAFT_SUPPLY_ENHANCEMENT_PACK_OUTPUT_QTY).unwrap_or(20)
        }
        MedicalSchematicKind::AdvancedStimpak => 6,
        MedicalSchematicKind::AntiDizzyStim | MedicalSchematicKind::AntiBlindStim => 3,
    }
}

fn medical_quantity_ceiling(kind: MedicalSchematicKind) -> u16 {
    match kind {
        MedicalSchematicKind::StimpakA => 20,
        MedicalSchematicKind::BodyEnhancementPackA
        | MedicalSchematicKind::SpiritEnhancementPackA => 40,
        MedicalSchematicKind::AdvancedStimpak => 24,
        MedicalSchematicKind::AntiDizzyStim | MedicalSchematicKind::AntiBlindStim => 12,
    }
}

fn medical_stat_at_quality(floor: u16, cap: u16, quality_percent: u16) -> u16 {
    if cap <= floor {
        return cap;
    }
    let span = cap.saturating_sub(floor);
    floor
        .saturating_add(span.saturating_mul(quality_percent.min(100)) / 100)
        .min(cap)
}
