//! Resource identities, generated stats, concentration fields, and harvest math.

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct ResourceStats {
    pub(super) conductivity: u16,
    pub(super) malleability: u16,
    pub(super) shock_resistance: u16,
    pub(super) thermal_resistance: u16,
    pub(super) chemical_purity: u16,
    pub(super) density: u16,
    pub(super) tensile_strength: u16,
    pub(super) flexibility: u16,
    pub(super) potency: u16,
    pub(super) nutrition: u16,
    pub(super) stability: u16,
    pub(super) extraction_yield: u16,
}

impl ResourceStats {
    /// All-zero stat vector — the base for synthesizing a medical component's
    /// slot stats (only its `potency` quality channel is non-zero).
    pub(super) fn zeroed() -> Self {
        Self {
            conductivity: 0,
            malleability: 0,
            shock_resistance: 0,
            thermal_resistance: 0,
            chemical_purity: 0,
            density: 0,
            tensile_strength: 0,
            flexibility: 0,
            potency: 0,
            nutrition: 0,
            stability: 0,
            extraction_yield: 0,
        }
    }

    pub(super) fn composite_quality(self) -> u32 {
        u32::from(self.conductivity)
            + u32::from(self.malleability)
            + u32::from(self.chemical_purity)
            + u32::from(self.tensile_strength)
            + u32::from(self.stability)
            + u32::from(self.extraction_yield)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct ResourceInstanceAuthority {
    pub(super) item_id: u32,
    pub(super) variant_id: u32,
    pub(super) seed: u32,
    pub(super) concentration_seed: u32,
    pub(super) spawn_id: String,
    pub(super) family: String,
    pub(super) spawn_name: String,
    pub(super) label: String,
    pub(super) short_label: String,
    pub(super) stats: ResourceStats,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct PendingResourceSampleState {
    pub(super) family: String,
    pub(super) area_id: String,
    pub(super) cell: AuthorityCell,
    pub(super) resolve_tick: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct ResourceSampleLoopState {
    pub(super) family: String,
    pub(super) area_id: String,
    pub(super) cell: AuthorityCell,
    pub(super) next_sample_tick: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorityResourceStatsSnapshot {
    pub conductivity: u16,
    pub malleability: u16,
    pub shock_resistance: u16,
    pub thermal_resistance: u16,
    pub chemical_purity: u16,
    pub density: u16,
    pub tensile_strength: u16,
    pub flexibility: u16,
    pub potency: u16,
    pub nutrition: u16,
    pub stability: u16,
    pub extraction_yield: u16,
}

impl From<ResourceStats> for AuthorityResourceStatsSnapshot {
    fn from(stats: ResourceStats) -> Self {
        Self {
            conductivity: stats.conductivity,
            malleability: stats.malleability,
            shock_resistance: stats.shock_resistance,
            thermal_resistance: stats.thermal_resistance,
            chemical_purity: stats.chemical_purity,
            density: stats.density,
            tensile_strength: stats.tensile_strength,
            flexibility: stats.flexibility,
            potency: stats.potency,
            nutrition: stats.nutrition,
            stability: stats.stability,
            extraction_yield: stats.extraction_yield,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityResourceSpawnSnapshot {
    pub spawn_id: String,
    pub family: String,
    pub name: String,
    pub class_label: String,
    pub variant_id: u32,
    pub stats: AuthorityResourceStatsSnapshot,
    pub active_from_tick: u64,
    pub active_until_tick: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityAreaResourceSpawnsSnapshot {
    pub area_id: String,
    pub resource_spawns: Vec<AuthorityResourceSpawnSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthoritySurveyResultSnapshot {
    pub family: String,
    pub area_id: String,
    pub spawn_id: String,
    pub spawn_name: String,
    pub center_x: i32,
    pub center_y: i32,
    pub range_cells: i32,
    pub step_cells: i32,
    pub cols: u16,
    pub rows: u16,
    pub concentration_milli: Vec<u16>,
    pub cooldown_until_tick: u64,
    pub tick: u64,
}

#[derive(Debug, Clone, Copy)]
pub(super) struct ResourceSpawnDefinition {
    spawn_id: &'static str,
    family: &'static str,
    aliases: &'static [&'static str],
    parent_class_label: &'static str,
    item_id: u32,
    family_code: u32,
    category: ResourceCategory,
    subtype: &'static str,
    seed_salt: &'static str,
    active_from_tick: u64,
    active_until_tick: Option<u64>,
}

/// Resource CATEGORY — the player-facing grouping that owns a survey tool and
/// an extractor (earlier sandbox design lineage). Several resource families can share a category
/// (mineral covers both iron and copper). The command wire stays family-keyed;
/// category is derived from the family's spawn definition so tool gating and
/// extractor identity ride one table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ResourceCategory {
    Mineral,
    Chemical,
    Gas,
    Water,
}

impl ResourceCategory {
    /// The survey-tool item required to /survey and /sample this category.
    pub(super) const fn survey_tool_item_id(self) -> u32 {
        match self {
            Self::Mineral => MINERAL_SURVEY_TOOL_ITEM_ID,
            Self::Chemical => CHEMICAL_SURVEY_TOOL_ITEM_ID,
            Self::Gas => GAS_SURVEY_TOOL_ITEM_ID,
            Self::Water => WATER_SURVEY_TOOL_ITEM_ID,
        }
    }

    /// The personal-scale extractor item placed for / returned from this
    /// category (heavy installations come later with their own ids).
    pub(super) const fn extractor_tool_item_id(self) -> u32 {
        match self {
            Self::Mineral => METAL_EXTRACTOR_TOOL_ITEM_ID,
            Self::Chemical => CHEMICAL_EXTRACTOR_TOOL_ITEM_ID,
            Self::Gas => GAS_EXTRACTOR_TOOL_ITEM_ID,
            Self::Water => WATER_EXTRACTOR_TOOL_ITEM_ID,
        }
    }
}

/// Resolve a command family (e.g. "mineral", "petro", "water", "liquid") to its
/// category via the spawn registry — one source of truth for tool gating and
/// extractor identity.
pub(super) fn resource_category_for_family(family: &str) -> Option<ResourceCategory> {
    let family_key = normalize_command_key(family);
    resource_spawn_definition_for_family(&family_key).map(|definition| definition.category)
}

const IRON_RESOURCE_ALIASES: &[&str] = &["metal", "iron", "ferrite", "mineral", "minerals", "ore"];
const COPPER_RESOURCE_ALIASES: &[&str] = &["copper", "cuprite", "cu", "conductor"];
const CARBON_RESOURCE_ALIASES: &[&str] = &["carbon", "coal", "carbonite", "graphite"];
const CHEMICAL_RESOURCE_ALIASES: &[&str] = &[
    "chemical",
    "chemicals",
    "chem",
    "petro",
    "petroleum",
    "solvent",
    "catalyst",
    "binder",
];
const GAS_RESOURCE_ALIASES: &[&str] = &["gas", "gasses", "gases", "gaseous", "vapor", "fuelgas"];
const WATER_RESOURCE_ALIASES: &[&str] = &[
    "water", "liquid", "liquids", "moisture", "aqua", "h2o", "hydro",
];
pub(super) const RESOURCE_SPAWN_REGISTRY: [ResourceSpawnDefinition; 6] = [
    ResourceSpawnDefinition {
        spawn_id: "iron",
        family: "metal",
        aliases: IRON_RESOURCE_ALIASES,
        parent_class_label: "Iron",
        item_id: RESOURCE_MINERAL_ITEM_ID,
        family_code: 1,
        category: ResourceCategory::Mineral,
        subtype: "ferrite",
        seed_salt: "v1-eternal-iron",
        active_from_tick: 0,
        active_until_tick: None,
    },
    ResourceSpawnDefinition {
        spawn_id: "copper",
        family: "copper",
        aliases: COPPER_RESOURCE_ALIASES,
        parent_class_label: "Copper",
        item_id: RESOURCE_COPPER_ITEM_ID,
        family_code: 2,
        category: ResourceCategory::Mineral,
        subtype: "cuprite",
        seed_salt: "v1-eternal-copper",
        active_from_tick: 0,
        active_until_tick: None,
    },
    ResourceSpawnDefinition {
        spawn_id: "chemical",
        family: "chemical",
        aliases: CHEMICAL_RESOURCE_ALIASES,
        parent_class_label: "Petrochemical",
        item_id: RESOURCE_CHEMICAL_ITEM_ID,
        family_code: 3,
        category: ResourceCategory::Chemical,
        subtype: "petrochemical",
        seed_salt: "v1-eternal-petrochemical",
        active_from_tick: 0,
        active_until_tick: None,
    },
    ResourceSpawnDefinition {
        spawn_id: "gas",
        family: "gas",
        aliases: GAS_RESOURCE_ALIASES,
        parent_class_label: "Reactive Gas",
        item_id: RESOURCE_GAS_ITEM_ID,
        family_code: 4,
        category: ResourceCategory::Gas,
        subtype: "reactivegas",
        seed_salt: "v1-eternal-reactivegas",
        active_from_tick: 0,
        active_until_tick: None,
    },
    ResourceSpawnDefinition {
        spawn_id: "water",
        family: "water",
        aliases: WATER_RESOURCE_ALIASES,
        parent_class_label: "Water",
        item_id: RESOURCE_LIQUID_ITEM_ID,
        family_code: 5,
        category: ResourceCategory::Water,
        subtype: "potablewater",
        seed_salt: "v1-eternal-water",
        active_from_tick: 0,
        active_until_tick: None,
    },
    ResourceSpawnDefinition {
        spawn_id: "carbon",
        family: "carbon",
        aliases: CARBON_RESOURCE_ALIASES,
        parent_class_label: "Carbon",
        item_id: RESOURCE_CARBON_ITEM_ID,
        family_code: 6,
        category: ResourceCategory::Mineral,
        subtype: "carbonite",
        seed_salt: "v1-eternal-carbon",
        active_from_tick: 0,
        active_until_tick: None,
    },
];

const DERIVED_CLODPOWDER_VARIANT_BASE: u32 = 46_000_000;
const DERIVED_CLODPOWDER_VARIANT_RANGE: u32 = 1_000_000;
const DERIVED_FUEL_VARIANT_BASE: u32 = 47_000_000;
const DERIVED_FUEL_VARIANT_RANGE: u32 = 1_000_000;
const DERIVED_POLYMER_VARIANT_BASE: u32 = 48_000_000;
const DERIVED_POLYMER_VARIANT_QUALITY_STRIDE: u32 = 1_001;
const DERIVED_POLYMER_SOURCE_FINGERPRINT_RANGE: u32 =
    (u32::MAX - DERIVED_POLYMER_VARIANT_BASE) / DERIVED_POLYMER_VARIANT_QUALITY_STRIDE;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CreatureMaterial {
    Hide,
    Meat,
    Bone,
}

impl CreatureMaterial {
    pub(super) const fn key(self) -> &'static str {
        match self {
            Self::Hide => "hide",
            Self::Meat => "meat",
            Self::Bone => "bone",
        }
    }

    pub(super) const fn harvest_all() -> [Self; 3] {
        [Self::Hide, Self::Meat, Self::Bone]
    }
}

#[cfg(test)]
pub(super) fn resource_instance_for_family(
    area_id: &str,
    family: &str,
) -> Option<ResourceInstanceAuthority> {
    resource_instance_for_family_at_tick(area_id, family, 0)
}

pub(super) fn resource_instance_for_family_at_tick(
    area_id: &str,
    family: &str,
    tick: u64,
) -> Option<ResourceInstanceAuthority> {
    let family_key = normalize_command_key(family);
    let definition = resource_spawn_definition_for_family(&family_key)?;
    resource_instance_for_spawn_definition(area_id, definition, tick)
}

pub(super) fn active_resource_spawn_snapshots_for_area(
    area_id: &str,
    tick: u64,
) -> Vec<AuthorityResourceSpawnSnapshot> {
    RESOURCE_SPAWN_REGISTRY
        .iter()
        .filter_map(|definition| resource_spawn_snapshot_for_definition(area_id, definition, tick))
        .collect()
}

fn resource_spawn_definition_for_family(
    family_key: &str,
) -> Option<&'static ResourceSpawnDefinition> {
    RESOURCE_SPAWN_REGISTRY.iter().find(|definition| {
        definition.family == family_key || definition.aliases.contains(&family_key)
    })
}

fn resource_instance_for_spawn_definition(
    area_id: &str,
    definition: &ResourceSpawnDefinition,
    tick: u64,
) -> Option<ResourceInstanceAuthority> {
    if !resource_spawn_active_at_tick(definition, tick) {
        return None;
    }
    let seed = resource_spawn_seed(area_id, definition);
    let concentration_seed = resource_spawn_concentration_seed(area_id, definition, tick);
    let variant_id = resource_spawn_variant_id(definition, seed);
    let stats = resource_stats_for_item_variant(definition.item_id, variant_id)?;
    let name = generated_resource_name(seed, definition.family, definition.subtype);
    Some(ResourceInstanceAuthority {
        item_id: definition.item_id,
        variant_id,
        seed,
        concentration_seed,
        spawn_id: resource_spawn_id(area_id, definition),
        family: definition.family.to_owned(),
        spawn_name: name.clone(),
        label: format!(
            "{} {} C{} M{} T{} P{} S{}",
            name,
            definition.parent_class_label,
            stats.conductivity,
            stats.malleability,
            stats.tensile_strength,
            stats.chemical_purity,
            stats.stability
        ),
        short_label: format!("{name} {}", definition.parent_class_label),
        stats,
    })
}

fn resource_spawn_snapshot_for_definition(
    area_id: &str,
    definition: &ResourceSpawnDefinition,
    tick: u64,
) -> Option<AuthorityResourceSpawnSnapshot> {
    let resource = resource_instance_for_spawn_definition(area_id, definition, tick)?;
    Some(AuthorityResourceSpawnSnapshot {
        spawn_id: resource.spawn_id,
        family: resource.family,
        name: resource.spawn_name,
        class_label: definition.parent_class_label.to_owned(),
        variant_id: resource.variant_id,
        stats: resource.stats.into(),
        active_from_tick: definition.active_from_tick,
        active_until_tick: definition.active_until_tick,
    })
}

fn resource_spawn_active_at_tick(definition: &ResourceSpawnDefinition, tick: u64) -> bool {
    tick >= definition.active_from_tick
        && definition
            .active_until_tick
            .is_none_or(|active_until_tick| tick < active_until_tick)
}

fn resource_spawn_seed(area_id: &str, definition: &ResourceSpawnDefinition) -> u32 {
    string_hash32(&format!(
        "resource-spawn:{area_id}:{}:{}:{}",
        definition.family, definition.spawn_id, definition.seed_salt
    ))
}

fn resource_spawn_variant_id(definition: &ResourceSpawnDefinition, seed: u32) -> u32 {
    200_000 + definition.family_code.saturating_mul(10_000) + seed % 9_973
}

fn resource_spawn_concentration_seed(
    area_id: &str,
    definition: &ResourceSpawnDefinition,
    tick: u64,
) -> u32 {
    let epoch = resource_spawn_epoch(tick);
    string_hash32(&format!(
        "resource-spawn:{area_id}:{}:{}:{}:{epoch}",
        definition.family, definition.spawn_id, definition.seed_salt
    ))
}

pub(super) fn resource_spawn_epoch(tick: u64) -> u64 {
    tick / RESOURCE_SPAWN_EPOCH_TICKS.max(1)
}

fn resource_spawn_id(area_id: &str, definition: &ResourceSpawnDefinition) -> String {
    format!("{area_id}:{}", definition.spawn_id)
}

pub(super) fn clodpowder_resource_instance_from_bone_variant(
    bone_variant_id: u32,
) -> ResourceInstanceAuthority {
    let variant_id = clodpowder_variant_from_bone_variant(bone_variant_id);
    let seed = string_hash32(&format!(
        "clodpowder-from-bone:{bone_variant_id}:variant:{variant_id}"
    ));
    let stats = clodpowder_stats_from_bone_variant(bone_variant_id);
    ResourceInstanceAuthority {
        item_id: RESOURCE_CLODPOWDER_ITEM_ID,
        variant_id,
        seed,
        concentration_seed: seed,
        spawn_id: format!("clodpowder:{bone_variant_id}"),
        family: "clodpowder".to_owned(),
        spawn_name: "Clodpowder".to_owned(),
        label: "Clodpowder".to_owned(),
        short_label: "Clodpowder".to_owned(),
        stats,
    }
}

pub(super) fn resource_cycle_index(tick: u64) -> u64 {
    tick / RESOURCE_CYCLE_TICKS.max(1)
}

pub(super) fn creature_resource_instance(
    target: &ActorAuthorityState,
    material: CreatureMaterial,
    tick: u64,
) -> ResourceInstanceAuthority {
    let (item_id, family_code, material_label) = match material {
        CreatureMaterial::Hide => (RESOURCE_CREATURE_HIDE_ITEM_ID, 11_u32, "hide"),
        CreatureMaterial::Meat => (RESOURCE_CREATURE_MEAT_ITEM_ID, 12_u32, "meat"),
        CreatureMaterial::Bone => (RESOURCE_CREATURE_BONE_ITEM_ID, 13_u32, "bone"),
    };
    let species_key = target.sprite.as_str();
    let cycle = resource_cycle_index(tick);
    let seed = string_hash32(&format!(
        "creature-resource:{}:{species_key}:{material_label}:cycle:{cycle}",
        target.home_area_id
    ));
    let variant_id = 200_000 + family_code.saturating_mul(10_000) + seed % 9_973;
    let stats = resource_stats_for_item_variant(item_id, variant_id)
        .unwrap_or_else(|| resource_stats_from_seed(seed, item_id));
    let short_label = format!("{} {material_label}", creature_species_label(target));
    let label = format!(
        "{} P{} Q{}",
        short_label, stats.potency, stats.chemical_purity
    );
    let spawn_id = format!(
        "creature:{species_key}:{}:{material_label}:cycle:{cycle}",
        target.home_area_id
    );
    ResourceInstanceAuthority {
        item_id,
        variant_id,
        seed,
        concentration_seed: seed,
        spawn_id,
        family: material_label.to_owned(),
        spawn_name: short_label.clone(),
        label,
        short_label,
        stats,
    }
}

fn creature_species_label(target: &ActorAuthorityState) -> &'static str {
    match target.sprite.as_str() {
        "creature-bellback-adult" => "Bellback",
        "creature-pebblehorn-adult" => "Pebblehorn",
        "creature-snufflefin-adult" => "Snufflefin",
        "creature-pocketclod-adult" => "Pocketclod",
        "creature-mossmuff-adult" => "Mossmuff",
        "creature-dapplepod-adult" => "Dapplepod",
        _ => "Creature",
    }
}

pub(super) fn resource_stats_for_item_variant(
    item_id: u32,
    variant_id: u32,
) -> Option<ResourceStats> {
    if !is_resource_item_id(item_id) {
        return None;
    }
    match item_id {
        RESOURCE_CLODPOWDER_ITEM_ID => {
            if let Some(bone_variant_id) = bone_variant_from_clodpowder_variant(variant_id) {
                return Some(clodpowder_stats_from_bone_variant(bone_variant_id));
            }
        }
        RESOURCE_FUEL_ITEM_ID => {
            let chemical_variant_id = chemical_variant_from_fuel_variant(variant_id)?;
            return Some(fuel_stats_from_chemical_variant(chemical_variant_id));
        }
        RESOURCE_POLYMER_ITEM_ID => {
            let quality = polymer_quality_from_variant(variant_id)?;
            return Some(ResourceStats {
                flexibility: quality,
                ..ResourceStats::zeroed()
            });
        }
        _ => {}
    }
    Some(resource_stats_from_seed(
        string_hash32(&format!("resource-stats:{item_id}:{variant_id}")),
        item_id,
    ))
}

fn clodpowder_variant_from_bone_variant(bone_variant_id: u32) -> u32 {
    DERIVED_CLODPOWDER_VARIANT_BASE
        .saturating_add(bone_variant_id % DERIVED_CLODPOWDER_VARIANT_RANGE)
}

fn bone_variant_from_clodpowder_variant(variant_id: u32) -> Option<u32> {
    let encoded = variant_id.checked_sub(DERIVED_CLODPOWDER_VARIANT_BASE)?;
    if encoded < DERIVED_CLODPOWDER_VARIANT_RANGE {
        Some(encoded)
    } else {
        None
    }
}

fn clodpowder_stats_from_bone_variant(bone_variant_id: u32) -> ResourceStats {
    let bone_stats = resource_stats_from_seed(
        string_hash32(&format!(
            "resource-stats:{RESOURCE_CREATURE_BONE_ITEM_ID}:{bone_variant_id}"
        )),
        RESOURCE_CREATURE_BONE_ITEM_ID,
    );
    ResourceStats {
        conductivity: 0,
        malleability: 0,
        shock_resistance: 0,
        thermal_resistance: 0,
        chemical_purity: bone_stats.chemical_purity,
        density: 0,
        tensile_strength: 0,
        flexibility: 0,
        potency: bone_stats.potency,
        nutrition: 0,
        stability: bone_stats.stability,
        extraction_yield: bone_stats.extraction_yield,
    }
}

pub(super) fn fuel_variant_from_chemical_variant(chemical_variant_id: u32) -> u32 {
    DERIVED_FUEL_VARIANT_BASE.saturating_add(chemical_variant_id % DERIVED_FUEL_VARIANT_RANGE)
}

fn chemical_variant_from_fuel_variant(variant_id: u32) -> Option<u32> {
    let encoded = variant_id.checked_sub(DERIVED_FUEL_VARIANT_BASE)?;
    (encoded < DERIVED_FUEL_VARIANT_RANGE).then_some(encoded)
}

fn fuel_stats_from_chemical_variant(chemical_variant_id: u32) -> ResourceStats {
    let chemical_stats = resource_stats_from_seed(
        string_hash32(&format!(
            "resource-stats:{RESOURCE_CHEMICAL_ITEM_ID}:{chemical_variant_id}"
        )),
        RESOURCE_CHEMICAL_ITEM_ID,
    );
    ResourceStats {
        chemical_purity: chemical_stats.chemical_purity,
        stability: chemical_stats.stability,
        ..ResourceStats::zeroed()
    }
}

pub(super) fn polymer_variant_from_source_variants(
    chemical_variant_id: u32,
    carbon_variant_id: u32,
    quality_milli: u16,
) -> u32 {
    let fingerprint = string_hash32(&format!(
        "polymer-from:{RESOURCE_CHEMICAL_ITEM_ID}:{chemical_variant_id}:{RESOURCE_CARBON_ITEM_ID}:{carbon_variant_id}"
    )) % DERIVED_POLYMER_SOURCE_FINGERPRINT_RANGE.max(1);
    DERIVED_POLYMER_VARIANT_BASE
        .saturating_add(fingerprint.saturating_mul(DERIVED_POLYMER_VARIANT_QUALITY_STRIDE))
        .saturating_add(u32::from(quality_milli.min(1_000)))
}

fn polymer_quality_from_variant(variant_id: u32) -> Option<u16> {
    let encoded = variant_id.checked_sub(DERIVED_POLYMER_VARIANT_BASE)?;
    u16::try_from(encoded % DERIVED_POLYMER_VARIANT_QUALITY_STRIDE).ok()
}

pub(super) fn resource_stats_from_seed(seed: u32, item_id: u32) -> ResourceStats {
    let roll = |salt: u64| -> u16 {
        let value = 250 + (ai_rand(seed, u64::from(item_id), salt) * 751.0) as u16;
        value.min(1_000)
    };
    let mut stats = ResourceStats {
        conductivity: roll(1),
        malleability: roll(2),
        shock_resistance: roll(3),
        thermal_resistance: roll(4),
        chemical_purity: roll(5),
        density: roll(6),
        tensile_strength: roll(7),
        flexibility: roll(8),
        potency: roll(9),
        nutrition: roll(10),
        stability: roll(11),
        extraction_yield: roll(12),
    };
    // Resource-stat sanity:
    // shock_resistance / thermal_resistance / nutrition have NO consumer anywhere (armor and food
    // crafting are unbuilt), so they are dead weight on every family and are zeroed globally. They
    // return (un-zeroed on their sensible families) the moment armor / food recipes land.
    stats.shock_resistance = 0;
    stats.thermal_resistance = 0;
    stats.nutrition = 0;
    // Per-family whitelist: a stat rolls only where it is a live consumer or a named-future (DORM)
    // identity stat for that family. Everything else is zeroed.
    match item_id {
        // mineral: conductivity, malleability, density, tensile_strength, stability, extraction_yield
        // (all six have live readers: Slugthrower caps, tool/battery/extractor rate, medical, sampling).
        RESOURCE_MINERAL_ITEM_ID => {
            stats.chemical_purity = 0;
            stats.flexibility = 0;
            stats.potency = 0;
        }
        // copper: the mineral set with conductivity forced high (conductor identity).
        RESOURCE_COPPER_ITEM_ID => {
            stats.conductivity = 500 + roll(1) / 2;
            stats.chemical_purity = 0;
            stats.flexibility = 0;
            stats.potency = 0;
        }
        // carbon: dense, stable mineral feedstock. Density and stability are biased high for
        // processed-polymer identity; tensile strength and extraction yield retain mineral rolls.
        RESOURCE_CARBON_ITEM_ID => {
            stats.conductivity = 0;
            stats.malleability = 0;
            stats.chemical_purity = 0;
            stats.flexibility = 0;
            stats.potency = 0;
            stats.density = 500 + roll(6) / 2;
            stats.stability = 500 + roll(11) / 2;
        }
        // chemical/petroleum: chemical_purity + stability (live via Slugthrower) + extraction_yield
        // (sampling) + potency (DORM -> future explosives/reactives).
        RESOURCE_CHEMICAL_ITEM_ID => {
            stats.conductivity = 0;
            stats.malleability = 0;
            stats.tensile_strength = 0;
            stats.flexibility = 0;
            stats.density = 0;
        }
        // flora: retained legacy stat identity for existing stacks; all channels are dormant now
        // that Polymer owns weapon grips and Water owns anti-blind eyewash.
        RESOURCE_FLORA_ITEM_ID => {
            stats.conductivity = 0;
            stats.malleability = 0;
            stats.density = 0;
            stats.tensile_strength = 0;
        }
        // gas: extraction_yield is live via sampling; chemical_purity, potency, and stability are
        // reserved for future reactive-gas recipes. Not conductive/flexible/dense as a part.
        RESOURCE_GAS_ITEM_ID => {
            stats.conductivity = 0;
            stats.malleability = 0;
            stats.density = 0;
            stats.tensile_strength = 0;
            stats.flexibility = 0;
        }
        // water/liquid: chemical_purity + extraction_yield are live via anti-blind eyewash and
        // sampling; stability remains dormant. Pure water carries no potency.
        RESOURCE_LIQUID_ITEM_ID => {
            stats.conductivity = 0;
            stats.malleability = 0;
            stats.density = 0;
            stats.tensile_strength = 0;
            stats.flexibility = 0;
            stats.potency = 0;
        }
        // creature: chemical_purity/potency/stability/extraction_yield live (bone -> clodpowder) +
        // flexibility (DORM -> leather/hide armor). chemical_purity is halved (raw organic purity).
        RESOURCE_CREATURE_HIDE_ITEM_ID
        | RESOURCE_CREATURE_MEAT_ITEM_ID
        | RESOURCE_CREATURE_BONE_ITEM_ID
        | RESOURCE_CREATURE_STRUCTURAL_ITEM_ID => {
            stats.conductivity = 0;
            stats.malleability = 0;
            stats.density = 0;
            stats.tensile_strength = 0;
            stats.chemical_purity /= 2;
        }
        _ => {}
    }
    stats
}

pub(super) fn generated_resource_name(seed: u32, family: &str, subtype: &str) -> String {
    const LEADS: [&str; 12] = [
        "Dax", "Auro", "Kav", "Moss", "Vex", "Dorn", "Luma", "Rill", "Tarn", "Nix", "Sable", "Cor",
    ];
    const CODAS: [&str; 12] = [
        "mire", "wick", "dell", "hollow", "run", "toll", "zir", "mere", "cairn", "holl", "drift",
        "brin",
    ];
    let family_bias = family.as_bytes().iter().fold(0_usize, |total, byte| {
        total.wrapping_add(usize::from(*byte))
    });
    let subtype_bias = subtype.as_bytes().iter().fold(0_usize, |total, byte| {
        total.wrapping_add(usize::from(*byte))
    });
    let lead = LEADS[((seed as usize) ^ family_bias) % LEADS.len()];
    let coda = CODAS[(((seed >> 8) as usize) ^ subtype_bias) % CODAS.len()];
    format!("{lead}{coda}")
}

/// Deterministic global resource field component: three octaves of seeded
/// value-noise over fixed integer lattices (96, 48, and 24 cells). The 96-cell
/// octave gates the lobe envelope, producing broad barrens when it falls below
/// threshold; the shorter octaves only vary richness inside lobes. All
/// interpolation is fixed-point smoothstep, so neighboring cells move gradually
/// and no per-cell allocation or wall-clock/random state is involved.
pub(super) fn resource_concentration_milli(seed: u32, cell: AuthorityCell) -> u16 {
    const FIELD_MAX_Q16: u32 = 65_535;
    const LOBE_LOW_Q16: u32 = 28_000;
    const LOBE_HIGH_Q16: u32 = 59_000;

    let coarse = resource_value_noise_q16(seed, cell.x, cell.y, 96, 0x1f3d_5b79);
    let mid = resource_value_noise_q16(seed, cell.x, cell.y, 48, 0x6c8e_9cf5);
    let fine = resource_value_noise_q16(seed, cell.x, cell.y, 24, 0xa511_e9b3);
    let envelope = resource_threshold_smooth_q16(coarse, LOBE_LOW_Q16, LOBE_HIGH_Q16);
    if envelope == 0 {
        return 0;
    }
    let detail = (mid.saturating_mul(2).saturating_add(fine)) / 3;
    let lobe_peak_milli = 920_u32.saturating_add(detail.saturating_mul(80) / FIELD_MAX_Q16);
    let milli = envelope.saturating_mul(lobe_peak_milli) / FIELD_MAX_Q16;
    u16::try_from(milli.min(1_000)).unwrap_or(1_000)
}

/// Area-aware resource field used by gameplay. It keeps the global FBM component
/// for large-world continuity, then overlays a deterministic per-area guarantee
/// lobe so small maps still contain at least one rich extraction pocket.
pub(super) fn resource_concentration_milli_in_area(
    seed: u32,
    area_id: &str,
    area_width: u32,
    area_height: u32,
    cell: AuthorityCell,
) -> u16 {
    resource_concentration_milli(seed, cell).max(resource_guarantee_lobe_concentration_milli(
        seed,
        area_id,
        area_width,
        area_height,
        cell,
    ))
}

fn resource_guarantee_lobe_concentration_milli(
    seed: u32,
    area_id: &str,
    area_width: u32,
    area_height: u32,
    cell: AuthorityCell,
) -> u16 {
    let width = i32::try_from(area_width.min(i32::MAX as u32)).unwrap_or(i32::MAX);
    let height = i32::try_from(area_height.min(i32::MAX as u32)).unwrap_or(i32::MAX);
    let min_dim = width.min(height);
    let max_radius = (min_dim - 1) / 2;
    if max_radius < 1 {
        return 0;
    }
    let preferred_radius = (min_dim / 4).clamp(16, 48);
    let radius = preferred_radius.min(max_radius);
    let center_x = resource_guarantee_lobe_center(seed, area_id, width, radius, 0x51ed_1a6d);
    let center_y = resource_guarantee_lobe_center(seed, area_id, height, radius, 0x7b1d_d391);
    let dx = i64::from(cell.x) - i64::from(center_x);
    let dy = i64::from(cell.y) - i64::from(center_y);
    let distance_sq = dx.saturating_mul(dx).saturating_add(dy.saturating_mul(dy));
    let radius_sq = i64::from(radius).saturating_mul(i64::from(radius));
    if distance_sq >= radius_sq {
        return 0;
    }
    let distance_sq_u32 = u32::try_from(distance_sq).unwrap_or(u32::MAX);
    let radius_sq_u32 = u32::try_from(radius_sq).unwrap_or(u32::MAX);
    let falloff =
        65_535_u32.saturating_sub(resource_smoothstep_q16(distance_sq_u32, radius_sq_u32));
    let peak = 920_u32.saturating_add(
        (resource_area_hash32(seed, area_id, 0xc0de_900d) & 0xffff).saturating_mul(80) / 65_535,
    );
    u16::try_from(falloff.saturating_mul(peak) / 65_535).unwrap_or(1_000)
}

fn resource_guarantee_lobe_center(
    seed: u32,
    area_id: &str,
    axis_size: i32,
    radius: i32,
    salt: u32,
) -> i32 {
    let span = axis_size.saturating_sub(radius.saturating_mul(2)).max(1);
    radius.saturating_add(
        i32::try_from(resource_area_hash32(seed, area_id, salt) % span as u32).unwrap_or(0),
    )
}

fn resource_area_hash32(seed: u32, area_id: &str, salt: u32) -> u32 {
    let mut hash = 0x811c_9dc5_u32;
    for byte in seed
        .to_le_bytes()
        .into_iter()
        .chain(salt.to_le_bytes())
        .chain(area_id.as_bytes().iter().copied())
    {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash ^= hash >> 16;
    hash = hash.wrapping_mul(0x7feb_352d);
    hash ^= hash >> 15;
    hash = hash.wrapping_mul(0x846c_a68b);
    hash ^ (hash >> 16)
}

fn resource_value_noise_q16(seed: u32, x: i32, y: i32, wavelength: i32, salt: u32) -> u32 {
    let wavelength = wavelength.max(1);
    let x = i64::from(x);
    let y = i64::from(y);
    let wavelength_i64 = i64::from(wavelength);
    let x0 = x.div_euclid(wavelength_i64);
    let y0 = y.div_euclid(wavelength_i64);
    let x_step = u32::try_from(x.rem_euclid(wavelength_i64)).unwrap_or(0);
    let y_step = u32::try_from(y.rem_euclid(wavelength_i64)).unwrap_or(0);
    let sx = resource_smoothstep_q16(x_step, wavelength as u32);
    let sy = resource_smoothstep_q16(y_step, wavelength as u32);
    let v00 = resource_lattice_hash_q16(seed, x0, y0, salt);
    let v10 = resource_lattice_hash_q16(seed, x0.saturating_add(1), y0, salt);
    let v01 = resource_lattice_hash_q16(seed, x0, y0.saturating_add(1), salt);
    let v11 = resource_lattice_hash_q16(seed, x0.saturating_add(1), y0.saturating_add(1), salt);
    let top = resource_lerp_q16(v00, v10, sx);
    let bottom = resource_lerp_q16(v01, v11, sx);
    resource_lerp_q16(top, bottom, sy)
}

fn resource_lattice_hash_q16(seed: u32, x: i64, y: i64, salt: u32) -> u32 {
    let mut value = u64::from(seed)
        ^ (x as u64).wrapping_mul(0x9e37_79b9_7f4a_7c15)
        ^ (y as u64).wrapping_mul(0xbf58_476d_1ce4_e5b9)
        ^ u64::from(salt).wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^= value >> 31;
    ((value >> 16) as u32) & 0xffff
}

fn resource_smoothstep_q16(step: u32, wavelength: u32) -> u32 {
    if wavelength == 0 {
        return 0;
    }
    let t = u64::from(step.min(wavelength)).saturating_mul(65_535) / u64::from(wavelength);
    let t2 = t.saturating_mul(t) / 65_535;
    let curve = t2.saturating_mul(3 * 65_535 - 2 * t) / 65_535;
    u32::try_from(curve.min(65_535)).unwrap_or(65_535)
}

fn resource_threshold_smooth_q16(value: u32, low: u32, high: u32) -> u32 {
    if value <= low {
        return 0;
    }
    if value >= high || high <= low {
        return 65_535;
    }
    resource_smoothstep_q16(value - low, high - low)
}

fn resource_lerp_q16(a: u32, b: u32, t: u32) -> u32 {
    let a = i64::from(a);
    let b = i64::from(b);
    let delta = b - a;
    let value = a + delta.saturating_mul(i64::from(t)) / 65_535;
    u32::try_from(value.clamp(0, 65_535)).unwrap_or(0)
}

/// First durable profession primitive: learned professions live on the actor
/// authority state and spend from a profession skill-point cap. Content and
/// bridge inputs grant profession ids explicitly; actor names are not gameplay
/// authority.
pub(super) fn actor_has_profession(
    actor: &ActorAuthorityState,
    profession: AuthorityProfessionKind,
) -> bool {
    actor.professions.has(profession)
}

pub(super) fn is_profession_trainer_authority_actor(actor: &ActorAuthorityState) -> bool {
    let role = normalize_command_key(&actor.role);
    role == "profession_trainer"
        || role.ends_with("_trainer")
        || actor
            .capabilities
            .has(AUTHORITY_CAPABILITY_TRAIN_PROFESSION)
}

pub(super) fn actor_has_capability(actor: &ActorAuthorityState, capability: &str) -> bool {
    actor.capabilities.has(capability)
}

pub(super) fn default_equipped_weapon_id_for_role_and_professions(
    role: &str,
    profession_ids: &[String],
) -> Option<AuthorityWeaponId> {
    let normalized_role = normalize_command_key(role);
    if normalized_role.contains("brawler")
        || profession_ids
            .iter()
            .any(|profession_id| normalize_command_key(profession_id) == "brawler")
    {
        return Some(AuthorityWeaponId::Vibrosword);
    }
    Some(AuthorityWeaponId::Slugthrower)
}

pub(super) fn profession_bonus_milli(actor_id: &str, specialty: &str) -> u32 {
    if actor_id.to_ascii_lowercase().contains(specialty) {
        1_500
    } else {
        1_000
    }
}

pub(super) fn actor_profession_bonus_milli(actor: &ActorAuthorityState, specialty: &str) -> u32 {
    let profession = match normalize_command_key(specialty).as_str() {
        "craftsman" | "surveyor" | "craft" => AuthorityProfessionKind::Craftsman,
        "medic" | "medical" => AuthorityProfessionKind::Medic,
        "scout" | "harvest" | "processing" => AuthorityProfessionKind::Scout,
        "brawler" | "melee" => AuthorityProfessionKind::Brawler,
        _ => return profession_bonus_milli(&actor.id, specialty),
    };
    if actor_has_profession(actor, profession) {
        1_500
    } else {
        1_000
    }
}

pub(super) fn scale_by_profession_milli(value: u32, milli: u32) -> u32 {
    u32::try_from(u64::from(value).saturating_mul(u64::from(milli)) / 1_000).unwrap_or(u32::MAX)
}

pub(super) fn resource_sample_yield(
    extraction_yield: u16,
    concentration_milli: u16,
    tool_milli: u16,
) -> u32 {
    // A fine hand pull is 30-120 g.
    // Concentration sets the base (peak 120 g at a full vein); tool quality and the resource's own
    // extraction_yield each swing the pull +/-20% so both are worth chasing (they were near-inert
    // at +/-5% before). Floor of 1 so a live vein never reads as a dud.
    let concentration = u64::from(concentration_milli.min(1_000));
    let tool_factor = 800_u64 + u64::from(tool_milli.min(1_000)) * 200 / 1_000;
    let extraction_factor = 800_u64 + u64::from(extraction_yield.min(1_000)) * 200 / 1_000;
    let raw = concentration
        .saturating_mul(120)
        .saturating_mul(tool_factor)
        .saturating_mul(extraction_factor)
        / 1_000_000_000;
    u32::try_from(raw.max(1)).unwrap_or(u32::MAX)
}

pub(super) const CREATURE_HARVEST_MIN_QUANTITY: u32 = 5;
pub(super) const CREATURE_HARVEST_MAX_QUANTITY: u32 = 100;

pub(super) fn creature_harvest_concentration_seed(
    area_id: &str,
    material: CreatureMaterial,
) -> u32 {
    string_hash32(&format!("creature-{}:{area_id}", material.key()))
}

pub(super) fn creature_harvest_base_quantity(concentration_milli: u16) -> u32 {
    u32::from(concentration_milli.min(1_000))
        .saturating_add(5)
        .saturating_div(10)
        .clamp(CREATURE_HARVEST_MIN_QUANTITY, CREATURE_HARVEST_MAX_QUANTITY)
}

pub(super) fn creature_harvest_quantity_from_concentration(
    concentration_milli: u16,
    harvest_bonus_milli: u32,
) -> u32 {
    scale_by_profession_milli(
        creature_harvest_base_quantity(concentration_milli),
        harvest_bonus_milli,
    )
    .clamp(CREATURE_HARVEST_MIN_QUANTITY, CREATURE_HARVEST_MAX_QUANTITY)
}

pub(super) fn resource_stat_value(stats: ResourceStats, key: &str) -> u16 {
    match key {
        "conductivity" => stats.conductivity,
        "malleability" => stats.malleability,
        "shock_resistance" => stats.shock_resistance,
        "thermal_resistance" => stats.thermal_resistance,
        "chemical_purity" => stats.chemical_purity,
        "density" => stats.density,
        "tensile_strength" => stats.tensile_strength,
        "flexibility" => stats.flexibility,
        "potency" => stats.potency,
        "nutrition" => stats.nutrition,
        "stability" => stats.stability,
        "extraction_yield" => stats.extraction_yield,
        _ => 0,
    }
}

pub(super) fn is_resource_item_id(item_id: u32) -> bool {
    matches!(
        item_id,
        RESOURCE_MINERAL_ITEM_ID
            | RESOURCE_COPPER_ITEM_ID
            | RESOURCE_CHEMICAL_ITEM_ID
            | RESOURCE_FLORA_ITEM_ID
            | RESOURCE_GAS_ITEM_ID
            | RESOURCE_LIQUID_ITEM_ID
            | RESOURCE_CLODPOWDER_ITEM_ID
            | RESOURCE_CARBON_ITEM_ID
            | RESOURCE_FUEL_ITEM_ID
            | RESOURCE_POLYMER_ITEM_ID
            | RESOURCE_CREATURE_HIDE_ITEM_ID
            | RESOURCE_CREATURE_MEAT_ITEM_ID
            | RESOURCE_CREATURE_BONE_ITEM_ID
            | RESOURCE_CREATURE_STRUCTURAL_ITEM_ID
    )
}
