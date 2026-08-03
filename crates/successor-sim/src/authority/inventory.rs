//! Canonical inventory identities, equipment mappings, and catalog tests.

use super::*;

pub(super) fn normalize_item_command_id(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| if ch == ' ' || ch == '-' { '_' } else { ch })
        .collect()
}

pub(super) fn ammo_item_id_for_type(ammo_type: AuthorityAmmoTypeId) -> Option<u32> {
    match ammo_type {
        AuthorityAmmoTypeId::SlugIron => Some(AMMO_SLUG_IRON_ITEM_ID),
        AuthorityAmmoTypeId::SlugShard => Some(AMMO_SLUG_SHARD_ITEM_ID),
        AuthorityAmmoTypeId::SlugSpike => Some(AMMO_SLUG_SPIKE_ITEM_ID),
        AuthorityAmmoTypeId::Melee => None,
    }
}

pub(super) fn slugthrower_full_magazine_state() -> WeaponMagazineState {
    WeaponMagazineState::full(WeaponMagazineProfile {
        magazine_size: SLUGTHROWER_MAGAZINE_SIZE,
        reload_ticks: 0,
    })
}

pub(super) const fn is_melee_weapon_id(weapon_id: AuthorityWeaponId) -> bool {
    matches!(
        weapon_id,
        AuthorityWeaponId::Vibrosword
            | AuthorityWeaponId::ScraplineMachete
            | AuthorityWeaponId::FieldSaber
            | AuthorityWeaponId::QuarryChopper
            | AuthorityWeaponId::Unarmed
    )
}

pub(super) const fn uses_crafted_ranged_variant(weapon_id: AuthorityWeaponId) -> bool {
    matches!(
        weapon_id,
        AuthorityWeaponId::Slugthrower
            | AuthorityWeaponId::WpnCarbine
            | AuthorityWeaponId::LightningCarbine
    )
}

pub(super) fn incap_window_ticks(tick_rate_hz: u32) -> u64 {
    ms_to_ticks_round(INCAP_WINDOW_MS, tick_rate_hz).max(1)
}

pub(super) fn authority_weapon_id_label(weapon_id: AuthorityWeaponId) -> &'static str {
    match weapon_id {
        AuthorityWeaponId::Slugthrower => "slugthrower",
        AuthorityWeaponId::Vibrosword => "vibrosword",
        AuthorityWeaponId::ScraplineMachete => "scrapline-machete",
        AuthorityWeaponId::FieldSaber => "field-saber",
        AuthorityWeaponId::QuarryChopper => "quarry-chopper",
        AuthorityWeaponId::Unarmed => "unarmed",
        AuthorityWeaponId::WpnPistol => "wpn-pistol",
        AuthorityWeaponId::WpnSmg => "wpn-smg",
        AuthorityWeaponId::WpnCarbine => "wpn-carbine",
        AuthorityWeaponId::LightningCarbine => "lightning-carbine",
        AuthorityWeaponId::WpnAssault => "wpn-assault",
        AuthorityWeaponId::WpnShotgun => "wpn-shotgun",
        AuthorityWeaponId::WpnSniper => "wpn-sniper",
        AuthorityWeaponId::WpnHeavy => "wpn-heavy",
        AuthorityWeaponId::WpnLauncher => "wpn-launcher",
    }
}

pub(super) fn authority_weapon_id_from_label(value: &str) -> Option<AuthorityWeaponId> {
    match value {
        "slugthrower" => Some(AuthorityWeaponId::Slugthrower),
        "vibrosword" => Some(AuthorityWeaponId::Vibrosword),
        "scrapline-machete" | "scrapline_machete" => Some(AuthorityWeaponId::ScraplineMachete),
        "field-saber" => Some(AuthorityWeaponId::FieldSaber),
        "quarry-chopper" => Some(AuthorityWeaponId::QuarryChopper),
        "unarmed" => Some(AuthorityWeaponId::Unarmed),
        "wpn-pistol" => Some(AuthorityWeaponId::WpnPistol),
        "wpn-smg" => Some(AuthorityWeaponId::WpnSmg),
        "wpn-carbine" => Some(AuthorityWeaponId::WpnCarbine),
        "lightning-carbine" => Some(AuthorityWeaponId::LightningCarbine),
        "wpn-assault" => Some(AuthorityWeaponId::WpnAssault),
        "wpn-shotgun" => Some(AuthorityWeaponId::WpnShotgun),
        "wpn-sniper" => Some(AuthorityWeaponId::WpnSniper),
        "wpn-heavy" => Some(AuthorityWeaponId::WpnHeavy),
        "wpn-launcher" => Some(AuthorityWeaponId::WpnLauncher),
        _ => None,
    }
}

pub(super) const fn weapon_id_for_inventory_item(item_id: u32) -> Option<AuthorityWeaponId> {
    match item_id {
        CRAFTED_SLUGTHROWER_ITEM_ID => Some(AuthorityWeaponId::Slugthrower),
        VIBROSWORD_WEAPON_ITEM_ID | PLASMA_SWORD_ITEM_ID => Some(AuthorityWeaponId::Vibrosword),
        SCRAPLINE_MACHETE_ITEM_ID => Some(AuthorityWeaponId::ScraplineMachete),
        FIELD_SABER_ITEM_ID => Some(AuthorityWeaponId::FieldSaber),
        QUARRY_CHOPPER_ITEM_ID => Some(AuthorityWeaponId::QuarryChopper),
        STEN_MK2_ITEM_ID => Some(AuthorityWeaponId::WpnSmg),
        KILN_ENERGY_CELL_ITEM_ID => Some(AuthorityWeaponId::WpnCarbine),
        LIGHTNING_CARBINE_ITEM_ID => Some(AuthorityWeaponId::LightningCarbine),
        BADGE_BOLT_PISTOL_ITEM_ID => Some(AuthorityWeaponId::WpnPistol),
        SLAGRAIL_VANGUARD_ITEM_ID => Some(AuthorityWeaponId::WpnAssault),
        COILGATE_SCATTER_ITEM_ID => Some(AuthorityWeaponId::WpnShotgun),
        KILN_LONG_PATTERN_ITEM_ID => Some(AuthorityWeaponId::WpnSniper),
        BASTION_LMG_ITEM_ID => Some(AuthorityWeaponId::WpnHeavy),
        FLARE_NET_LAUNCHER_ITEM_ID => Some(AuthorityWeaponId::WpnLauncher),
        _ => None,
    }
}

/// Canonical inventory row used to migrate legacy human-player weapon state
/// that named a wielded weapon but had no backing item instance.
pub(super) const fn canonical_inventory_item_for_weapon_id(
    weapon_id: AuthorityWeaponId,
) -> Option<u32> {
    match weapon_id {
        AuthorityWeaponId::Slugthrower => Some(CRAFTED_SLUGTHROWER_ITEM_ID),
        AuthorityWeaponId::Vibrosword => Some(VIBROSWORD_WEAPON_ITEM_ID),
        AuthorityWeaponId::ScraplineMachete => Some(SCRAPLINE_MACHETE_ITEM_ID),
        AuthorityWeaponId::FieldSaber => Some(FIELD_SABER_ITEM_ID),
        AuthorityWeaponId::QuarryChopper => Some(QUARRY_CHOPPER_ITEM_ID),
        AuthorityWeaponId::WpnPistol => Some(BADGE_BOLT_PISTOL_ITEM_ID),
        AuthorityWeaponId::WpnSmg => Some(STEN_MK2_ITEM_ID),
        AuthorityWeaponId::WpnCarbine => Some(KILN_ENERGY_CELL_ITEM_ID),
        AuthorityWeaponId::LightningCarbine => Some(LIGHTNING_CARBINE_ITEM_ID),
        AuthorityWeaponId::WpnAssault => Some(SLAGRAIL_VANGUARD_ITEM_ID),
        AuthorityWeaponId::WpnShotgun => Some(COILGATE_SCATTER_ITEM_ID),
        AuthorityWeaponId::WpnSniper => Some(KILN_LONG_PATTERN_ITEM_ID),
        AuthorityWeaponId::WpnHeavy => Some(BASTION_LMG_ITEM_ID),
        AuthorityWeaponId::WpnLauncher => Some(FLARE_NET_LAUNCHER_ITEM_ID),
        AuthorityWeaponId::Unarmed => None,
    }
}

// ── WEAPON CERTIFICATION TABLE ────────────────────────────────────────────
// The skill box an actor MUST hold to EQUIP a weapon (the certification gate,
// combat-doctrine.md §3). The shared 3_101 Slugthrower item id uses the novice
// class gate because both base and crafted variants currently share that id;
// variant-specific certification needs a distinct item id or variant-aware gate.
// Other concrete inventory items can still demand a deeper cert than their class.
// `None` = no certification required (nothing to gate).
//
// AUTHORITY source of truth for the equip gate. The client mirrors this table
// (generated spec) for display: item badge + status-plate hint + TUI prose.
// New SyntyWeapons catalog rows drop in here — regular guns -> marksman tiers,
// elite/heavy -> commando tracks, melee -> brawler tiers.

pub(super) fn weapon_cert_requirement_for_variant(
    weapon_id: AuthorityWeaponId,
    weapon_item_id: u32,
    weapon_variant_id: u32,
) -> Option<&'static str> {
    if weapon_id == AuthorityWeaponId::Slugthrower
        && weapon_item_id == CRAFTED_SLUGTHROWER_ITEM_ID
        && decode_slugthrower_variant(weapon_variant_id).is_some()
    {
        return Some("marksman-rifle-iii");
    }
    if weapon_item_id == PLASMA_SWORD_ITEM_ID {
        return Some("brawler-melee-iv");
    }
    match weapon_id {
        AuthorityWeaponId::Slugthrower => Some("marksman-novice"),
        AuthorityWeaponId::Vibrosword => Some("brawler-melee-iii"),
        AuthorityWeaponId::ScraplineMachete
        | AuthorityWeaponId::FieldSaber
        | AuthorityWeaponId::QuarryChopper
        | AuthorityWeaponId::Unarmed => None,
        AuthorityWeaponId::WpnPistol => Some("marksman-pistol-i"),
        AuthorityWeaponId::WpnSmg => Some("marksman-pistol-iii"),
        AuthorityWeaponId::WpnAssault => Some("marksman-rifle-iii"),
        AuthorityWeaponId::WpnShotgun => Some("marksman-rifle-ii"),
        AuthorityWeaponId::WpnCarbine => Some("marksman-rifle-iv"),
        AuthorityWeaponId::LightningCarbine => Some("marksman-master"),
        AuthorityWeaponId::WpnHeavy => Some("commando-heavy-weapons-ii"),
        AuthorityWeaponId::WpnSniper => Some("commando-heavy-weapons-iv"),
        AuthorityWeaponId::WpnLauncher => Some("commando-demolitions-ii"),
    }
}

#[cfg(test)]
pub(super) fn authority_weapon_certification_catalog() -> BTreeMap<String, Vec<String>> {
    let rows = [
        (
            "Slugthrower",
            AuthorityWeaponId::Slugthrower,
            CRAFTED_SLUGTHROWER_ITEM_ID,
            0,
        ),
        (
            "Crafted Slugthrower",
            AuthorityWeaponId::Slugthrower,
            CRAFTED_SLUGTHROWER_ITEM_ID,
            81_050_050,
        ),
        ("Assault Rifle", AuthorityWeaponId::WpnAssault, 0, 0),
        ("Shotgun", AuthorityWeaponId::WpnShotgun, 0, 0),
        (
            "Carbine",
            AuthorityWeaponId::WpnCarbine,
            KILN_ENERGY_CELL_ITEM_ID,
            0,
        ),
        (
            "Lightning Carbine",
            AuthorityWeaponId::LightningCarbine,
            LIGHTNING_CARBINE_ITEM_ID,
            0,
        ),
        ("Pistol", AuthorityWeaponId::WpnPistol, 0, 0),
        (
            "Submachine Gun",
            AuthorityWeaponId::WpnSmg,
            STEN_MK2_ITEM_ID,
            0,
        ),
        (
            "Vibrosword",
            AuthorityWeaponId::Vibrosword,
            VIBROSWORD_WEAPON_ITEM_ID,
            0,
        ),
        (
            "Plasma Sword",
            AuthorityWeaponId::Vibrosword,
            PLASMA_SWORD_ITEM_ID,
            0,
        ),
        ("Heavy Weapon", AuthorityWeaponId::WpnHeavy, 0, 0),
        ("Sniper Rifle", AuthorityWeaponId::WpnSniper, 0, 0),
        ("Launcher", AuthorityWeaponId::WpnLauncher, 0, 0),
    ];
    let mut catalog = BTreeMap::<String, Vec<String>>::new();
    for (label, weapon_id, item_id, variant_id) in rows {
        let requirement = weapon_cert_requirement_for_variant(weapon_id, item_id, variant_id)
            .expect("catalogued weapon has an authority certification");
        catalog
            .entry(requirement.to_owned())
            .or_default()
            .push(label.to_owned());
    }
    catalog
}

pub(super) fn authority_ammo_type_label(ammo_type: AuthorityAmmoTypeId) -> &'static str {
    match ammo_type {
        AuthorityAmmoTypeId::SlugIron => "slug_iron",
        AuthorityAmmoTypeId::SlugShard => "slug_shard",
        AuthorityAmmoTypeId::SlugSpike => "slug_spike",
        AuthorityAmmoTypeId::Melee => "melee",
    }
}

pub(super) fn ammo_item_id_from_command(value: &str) -> Option<u32> {
    match normalize_item_command_id(value).as_str() {
        "slug_iron" => Some(AMMO_SLUG_IRON_ITEM_ID),
        "slug_shard" => Some(AMMO_SLUG_SHARD_ITEM_ID),
        "slug_spike" => Some(AMMO_SLUG_SPIKE_ITEM_ID),
        _ => None,
    }
}

pub(super) fn ammo_item_name(item_id: u32) -> Option<&'static str> {
    match item_id {
        AMMO_SLUG_IRON_ITEM_ID => Some("Iron Slug"),
        AMMO_SLUG_SHARD_ITEM_ID => Some("Shard Slug"),
        AMMO_SLUG_SPIKE_ITEM_ID => Some("Spike Slug"),
        _ => None,
    }
}

pub(super) fn creator_clothing_item_id(item: &str) -> Option<u32> {
    Some(match item {
        "top_rigged_tank" => 7_301,
        "top_frayed_tunic" => 7_302,
        "top_plated_rig_vest" => 7_303,
        "top_padded_leather_vest" => 7_304,
        "top_spiked_leather_vest" => 7_305,
        "top_reinforced_crop_vest" => 7_306,
        "top_scrap_plate_tunic" => 7_307,
        "top_laced_corset_vest" => 7_308,
        "legs_wrapped_workpants" => 7_309,
        "legs_reinforced_denim_pants" => 7_310,
        "legs_plated_trousers" => 7_311,
        "legs_layered_shorts" => 7_312,
        "legs_strapped_trousers" => 7_313,
        "legs_skirted_workpants" => 7_314,
        "legs_gaitered_cargo_pants" => 7_315,
        "legs_padded_canvas_trousers" => 7_316,
        "legs_sashed_patrol_pants" => 7_317,
        "legs_layered_wrap_skirt" => 7_318,
        "boots_canvas_ankle" => 7_319,
        "boots_layered_sneakers" => 7_320,
        "boots_split_toe" => 7_321,
        "boots_trail_shoes" => 7_322,
        "boots_double_strap" => 7_323,
        "boots_rubberized_canvas" => 7_324,
        "boots_toe_capped" => 7_325,
        "boots_combat_sneakers" => 7_326,
        "boots_cuffed_runners" => 7_327,
        "boots_reinforced_street" => 7_328,
        "gloves_knuckled_half" => 7_329,
        "gloves_guarded_leather" => 7_330,
        "gloves_plain_work" => 7_331,
        "gloves_reinforced_knit" => 7_332,
        "gloves_light_utility" => 7_333,
        "gloves_tipped_work" => 7_334,
        "gloves_plated_handwraps" => 7_335,
        _ => return None,
    })
}

pub(super) fn creator_clothing_item_key(item_id: u32) -> Option<&'static str> {
    Some(match item_id {
        7_301 => "top_rigged_tank",
        7_302 => "top_frayed_tunic",
        7_303 => "top_plated_rig_vest",
        7_304 => "top_padded_leather_vest",
        7_305 => "top_spiked_leather_vest",
        7_306 => "top_reinforced_crop_vest",
        7_307 => "top_scrap_plate_tunic",
        7_308 => "top_laced_corset_vest",
        7_309 => "legs_wrapped_workpants",
        7_310 => "legs_reinforced_denim_pants",
        7_311 => "legs_plated_trousers",
        7_312 => "legs_layered_shorts",
        7_313 => "legs_strapped_trousers",
        7_314 => "legs_skirted_workpants",
        7_315 => "legs_gaitered_cargo_pants",
        7_316 => "legs_padded_canvas_trousers",
        7_317 => "legs_sashed_patrol_pants",
        7_318 => "legs_layered_wrap_skirt",
        7_319 => "boots_canvas_ankle",
        7_320 => "boots_layered_sneakers",
        7_321 => "boots_split_toe",
        7_322 => "boots_trail_shoes",
        7_323 => "boots_double_strap",
        7_324 => "boots_rubberized_canvas",
        7_325 => "boots_toe_capped",
        7_326 => "boots_combat_sneakers",
        7_327 => "boots_cuffed_runners",
        7_328 => "boots_reinforced_street",
        7_329 => "gloves_knuckled_half",
        7_330 => "gloves_guarded_leather",
        7_331 => "gloves_plain_work",
        7_332 => "gloves_reinforced_knit",
        7_333 => "gloves_light_utility",
        7_334 => "gloves_tipped_work",
        7_335 => "gloves_plated_handwraps",
        _ => return None,
    })
}
/// Canonical clothing key for both creator wardrobe rows and humanoid loot
/// aliases. Loot keeps its numeric row and 60M variant in inventory, while
/// worn state deliberately carries the presentation key.
pub(super) fn authority_clothing_item_key(item_id: u32) -> Option<&'static str> {
    match item_id {
        7_101 => Some("top_plated_rig_vest"),
        7_102 => Some("top_scrap_plate_tunic"),
        7_103 => Some("helmet_s2"),
        7_104 => Some("legs_gaitered_cargo_pants"),
        7_201 => Some("top_frayed_tunic"),
        7_202 => Some("legs_padded_canvas_trousers"),
        7_203 => Some("hat_field_cap"),
        7_204 => Some("top_padded_leather_vest"),
        _ => creator_clothing_item_key(item_id),
    }
}

/// Reverse lookup for persisted worn keys. Prefer the legacy loot id where a
/// canonical key is shared by a loot alias and a creator wardrobe row.
pub(super) fn authority_clothing_item_id_for_key(item: &str) -> Option<u32> {
    match item {
        "top_plated_rig_vest" => Some(7_101),
        "top_scrap_plate_tunic" => Some(7_102),
        "helmet_s2" => Some(7_103),
        "legs_gaitered_cargo_pants" => Some(7_104),
        "top_frayed_tunic" => Some(7_201),
        "legs_padded_canvas_trousers" => Some(7_202),
        "hat_field_cap" => Some(7_203),
        "top_padded_leather_vest" => Some(7_204),
        _ => creator_clothing_item_id(item),
    }
}

pub(super) fn is_creator_clothing_item_id(item_id: u32) -> bool {
    creator_clothing_item_key(item_id).is_some()
}

pub(super) fn inventory_item_name(item_id: u32) -> Option<&'static str> {
    if is_creator_clothing_item_id(item_id) {
        return creator_clothing_item_key(item_id);
    }
    match item_id {
        STIMPAK_A_ITEM_ID => Some("Stimpak A"),
        FIELD_BANDAGE_ITEM_ID => Some("Field Bandage"),
        RESUSCITATION_KIT_ITEM_ID => Some("Resuscitation Kit"),
        PERSONAL_SHIELD_GENERATOR_ITEM_ID => Some("Personal Shield Generator"),
        BODY_ENHANCEMENT_PACK_A_ITEM_ID => Some("Body Enhancement Pack A"),
        SPIRIT_ENHANCEMENT_PACK_A_ITEM_ID => Some("Spirit Enhancement Pack A"),
        ADVANCED_STIMPAK_ITEM_ID => Some("Advanced Stimpak"),
        ANTI_DIZZY_STIM_ITEM_ID => Some("Anti-Dizzy Stim"),
        ANTI_BLIND_STIM_ITEM_ID => Some("Anti-Blind Stim"),
        BIO_EFFECT_CONTROLLER_ITEM_ID => Some("Biological Effect Controller"),
        LIQUID_SUSPENSION_ITEM_ID => Some("Liquid Suspension"),
        CHEMICAL_RELEASE_MECHANISM_ITEM_ID => Some("Chemical Release Duration Mechanism"),
        SOLID_DELIVERY_SHELL_ITEM_ID => Some("Solid Delivery Shell"),
        RESOURCE_MINERAL_ITEM_ID => Some("Iron Resource Container"),
        RESOURCE_COPPER_ITEM_ID => Some("Copper Resource Container"),
        RESOURCE_CHEMICAL_ITEM_ID => Some("Petrochemical Resource Container"),
        RESOURCE_FLORA_ITEM_ID => Some("Flora Resource Container"),
        RESOURCE_GAS_ITEM_ID => Some("Gas Resource Container"),
        RESOURCE_LIQUID_ITEM_ID => Some("Liquid Resource Container"),
        RESOURCE_CLODPOWDER_ITEM_ID => Some("Clodpowder Resource Container"),
        RESOURCE_CARBON_ITEM_ID => Some("Carbon Resource Container"),
        RESOURCE_FUEL_ITEM_ID => Some("Fuel Resource Container"),
        RESOURCE_POLYMER_ITEM_ID => Some("Polymer Resource Container"),
        RESOURCE_CREATURE_HIDE_ITEM_ID => Some("Creature Hide Container"),
        RESOURCE_CREATURE_MEAT_ITEM_ID => Some("Creature Meat Container"),
        RESOURCE_CREATURE_BONE_ITEM_ID => Some("Creature Bone Container"),
        RESOURCE_CREATURE_STRUCTURAL_ITEM_ID => Some("Creature Structural Container"),
        FIELD_MULTITOOL_ITEM_ID => Some("Field Multitool"),
        SCOUT_PROCESSING_TOOL_ITEM_ID => Some("Scout Processing Kit"),
        MINERAL_SURVEY_TOOL_ITEM_ID => Some("Mineral Survey Tool"),
        CHEMICAL_SURVEY_TOOL_ITEM_ID => Some("Chemical Survey Device"),
        GAS_SURVEY_TOOL_ITEM_ID => Some("Gas Survey Tool"),
        WATER_SURVEY_TOOL_ITEM_ID => Some("Water Survey Tool"),
        METAL_EXTRACTOR_TOOL_ITEM_ID => Some("Personal Mineral Sampler"),
        CHEMICAL_EXTRACTOR_TOOL_ITEM_ID => Some("Personal Chemical Extractor"),
        GAS_EXTRACTOR_TOOL_ITEM_ID => Some("Personal Gas Harvester"),
        WATER_EXTRACTOR_TOOL_ITEM_ID => Some("Survival Moisture Vaporator"),
        CAMP_KIT_ITEM_ID => Some("Camp Kit"),
        EXTRACTOR_BATTERY_ITEM_ID => Some("Extractor Battery"),
        LOOTED_SCHEMATIC_ITEM_ID => Some("Looted Schematic"),
        DRAFTED_SCHEMATIC_ITEM_ID => Some("Drafted Factory Schematic"),
        CRAFTED_SLUGTHROWER_ITEM_ID => Some("Crafted Slugthrower Mk I"),
        VIBROSWORD_WEAPON_ITEM_ID => Some("Vibrosword"),
        PLASMA_SWORD_ITEM_ID => Some("Plasma Sword"),
        SCRAPLINE_MACHETE_ITEM_ID => Some("Scrapline Machete"),
        FIELD_SABER_ITEM_ID => Some("Field Saber"),
        QUARRY_CHOPPER_ITEM_ID => Some("Quarry Chopper"),
        STEN_MK2_ITEM_ID => Some("STEN Mk II"),
        KILN_ENERGY_CELL_ITEM_ID => Some("Kiln Energy Cell Carbine"),
        LIGHTNING_CARBINE_ITEM_ID => Some("Lightning Carbine"),
        BADGE_BOLT_PISTOL_ITEM_ID => Some("Badge Bolt Pistol"),
        SLAGRAIL_VANGUARD_ITEM_ID => Some("Slagrail Vanguard"),
        COILGATE_SCATTER_ITEM_ID => Some("Coilgate Scatter"),
        KILN_LONG_PATTERN_ITEM_ID => Some("Kiln Long Pattern"),
        BASTION_LMG_ITEM_ID => Some("Bastion LMG"),
        FLARE_NET_LAUNCHER_ITEM_ID => Some("Flare Net Launcher"),
        COMBAT_HELM_ITEM_ID => Some("Combat Helm"),
        CREDIT_CHIP_ITEM_ID => Some("Credit Chip"),
        // Bio-Engineer seeds (6_0xx), tools + reagents (6_2xx) — bioengineer-design.md §0.5.
        CROP_ASHGRAIN_ITEM_ID => Some("Ashgrain Seed Cassette"),
        CROP_SUNMELON_ITEM_ID => Some("Sunmelon Seed Cassette"),
        CROP_CAVEMOSS_ITEM_ID => Some("Cavemoss Spore Cassette"),
        CROP_EMBERBEAN_ITEM_ID => Some("Emberbean Seed Cassette"),
        CROP_RIFTROOT_ITEM_ID => Some("Riftroot Set Cassette"),
        CROP_BRINELEAF_ITEM_ID => Some("Brineleaf Spore Cassette"),
        CROP_GLASSPEPPER_ITEM_ID => Some("Glasspepper Seed Cassette"),
        CROP_COILREED_ITEM_ID => Some("Coilreed Node Cassette"),
        CROP_NIGHTPLUM_ITEM_ID => Some("Nightplum Pit Cassette"),
        GENE_SAMPLER_ITEM_ID => Some("Gene Sampler"),
        SPLICE_BENCH_ITEM_ID => Some("Splice Bench"),
        GENOME_SCANNER_ITEM_ID => Some("Genome Scanner"),
        CULTURE_MEDIUM_ITEM_ID => Some("Culture Medium"),
        MUTAGEN_ITEM_ID => Some("Mutagen"),
        STABILIZER_ITEM_ID => Some("Stabilizer"),
        SERUM_ITEM_ID => Some("Serum"),
        GENE_LOCK_KIT_ITEM_ID => Some("Gene-Lock Kit"),
        IRRIGATION_SPRINKLER_ITEM_ID => Some("Irrigation Sprinkler"),
        FERTILIZER_SPEED_ITEM_ID => Some("Growth Tonic"),
        FERTILIZER_QUALITY_ITEM_ID => Some("Quality Compost"),
        FERTILIZER_YIELD_ITEM_ID => Some("Yield Booster"),
        // Produce (6_1xx, one per species): the harvested crop, quality in variant.
        PRODUCE_ASHGRAIN_ITEM_ID => Some("Ashgrain Sheaf"),
        PRODUCE_SUNMELON_ITEM_ID => Some("Sunmelon"),
        PRODUCE_CAVEMOSS_ITEM_ID => Some("Cavemoss Brick"),
        PRODUCE_EMBERBEAN_ITEM_ID => Some("Emberbean Pods"),
        PRODUCE_RIFTROOT_ITEM_ID => Some("Riftroot Tubers"),
        PRODUCE_BRINELEAF_ITEM_ID => Some("Brineleaf Fronds"),
        PRODUCE_GLASSPEPPER_ITEM_ID => Some("Glasspeppers"),
        PRODUCE_COILREED_ITEM_ID => Some("Coilreed Stalks"),
        PRODUCE_NIGHTPLUM_ITEM_ID => Some("Nightplums"),
        BIO_ADDITIVE_DENSITY_LIGHT_ITEM_ID => Some("Light Density Matrix"),
        BIO_ADDITIVE_DENSITY_MEDIUM_ITEM_ID => Some("Medium Density Matrix"),
        BIO_ADDITIVE_DENSITY_HEAVY_ITEM_ID => Some("Heavy Density Matrix"),
        BIO_ADDITIVE_SAVOR_LIGHT_ITEM_ID => Some("Light Savor Matrix"),
        BIO_ADDITIVE_SAVOR_MEDIUM_ITEM_ID => Some("Medium Savor Matrix"),
        BIO_ADDITIVE_SAVOR_HEAVY_ITEM_ID => Some("Heavy Savor Matrix"),
        BIO_ADDITIVE_NUTRIENT_LIGHT_ITEM_ID => Some("Light Nutrient Matrix"),
        BIO_ADDITIVE_NUTRIENT_MEDIUM_ITEM_ID => Some("Medium Nutrient Matrix"),
        BIO_ADDITIVE_NUTRIENT_HEAVY_ITEM_ID => Some("Heavy Nutrient Matrix"),
        BIO_ADDITIVE_BATCH_LIGHT_ITEM_ID => Some("Light Batch Matrix"),
        BIO_ADDITIVE_BATCH_MEDIUM_ITEM_ID => Some("Medium Batch Matrix"),
        BIO_ADDITIVE_BATCH_HEAVY_ITEM_ID => Some("Heavy Batch Matrix"),
        INGREDIENT_ASHGRAIN_MEAL_ITEM_ID => Some("Ashgrain Meal"),
        INGREDIENT_SUNMELON_PRESS_ITEM_ID => Some("Sunmelon Press"),
        INGREDIENT_CAVEMOSS_EXTRACT_ITEM_ID => Some("Cavemoss Extract"),
        INGREDIENT_EMBERBEAN_CURD_ITEM_ID => Some("Emberbean Curd"),
        INGREDIENT_RIFTROOT_STARCH_ITEM_ID => Some("Riftroot Starch"),
        INGREDIENT_BRINELEAF_SALT_ITEM_ID => Some("Brineleaf Salt"),
        INGREDIENT_GLASSPEPPER_MASH_ITEM_ID => Some("Glasspepper Mash"),
        INGREDIENT_COILREED_SYRUP_ITEM_ID => Some("Coilreed Syrup"),
        INGREDIENT_NIGHTPLUM_PRESERVE_ITEM_ID => Some("Nightplum Preserve"),
        INGREDIENT_FIELD_DOUGH_ITEM_ID => Some("Field Dough"),
        INGREDIENT_HEARTH_BROTH_ITEM_ID => Some("Hearth Broth"),
        INGREDIENT_CLODMEAT_MINCE_ITEM_ID => Some("Clodmeat Mince"),
        INGREDIENT_FERMENT_CULTURE_ITEM_ID => Some("Ferment Culture"),
        INGREDIENT_RENDERED_FAT_ITEM_ID => Some("Rendered Fat"),
        INGREDIENT_SEASONING_BRICK_ITEM_ID => Some("Seasoning Brick"),
        FOOD_ASHGRAIN_HEARTH_LOAF_ITEM_ID => Some("Ashgrain Hearth Loaf"),
        FOOD_SUNMELON_SLICECAKE_ITEM_ID => Some("Sunmelon Slicecake"),
        FOOD_CAVEMOSS_BROTH_ITEM_ID => Some("Cavemoss Broth"),
        FOOD_EMBERBEAN_GRIDDLE_CAKES_ITEM_ID => Some("Emberbean Griddle Cakes"),
        FOOD_RIFTROOT_SKILLET_HASH_ITEM_ID => Some("Riftroot Skillet Hash"),
        FOOD_BRINELEAF_NOODLE_BOWL_ITEM_ID => Some("Brineleaf Noodle Bowl"),
        FOOD_GLASSPEPPER_CLOD_SKEWER_ITEM_ID => Some("Glasspepper Clod Skewer"),
        FOOD_COILREED_GLAZE_BUN_ITEM_ID => Some("Coilreed Glaze Bun"),
        FOOD_NIGHTPLUM_HAND_PIE_ITEM_ID => Some("Nightplum Hand Pie"),
        FOOD_CLODMEAT_STEW_TIN_ITEM_ID => Some("Clodmeat Stew Tin"),
        FOOD_TRAIL_RATION_TRAY_ITEM_ID => Some("Trail Ration Tray"),
        FOOD_FIELD_DUMPLINGS_ITEM_ID => Some("Field Dumplings"),
        FOOD_SMOKED_CLOD_CUTLET_ITEM_ID => Some("Smoked Clod Cutlet"),
        FOOD_PRESSED_FRUIT_BAR_ITEM_ID => Some("Pressed Fruit Bar"),
        FOOD_NIGHT_WATCH_SOUP_ITEM_ID => Some("Night Watch Soup"),
        FOOD_FARMHAND_BREAKFAST_ITEM_ID => Some("Farmhand Breakfast"),
        FOOD_SPICED_RIFTROOT_MASH_ITEM_ID => Some("Spiced Riftroot Mash"),
        FOOD_HARVEST_LAYER_CAKE_ITEM_ID => Some("Harvest Layer Cake"),
        FOOD_CAVEMOSS_STEEP_ITEM_ID => Some("Cavemoss Steep"),
        FOOD_SUNMELON_COOLER_ITEM_ID => Some("Sunmelon Cooler"),
        _ => ammo_item_name(item_id),
    }
}

#[cfg(test)]
mod catalog_tests {
    use super::*;
    use std::collections::BTreeSet;

    const CATALOG_NAMES: &[(u32, &str)] = &[
        (6_001, "Ashgrain Seed Cassette"),
        (6_002, "Sunmelon Seed Cassette"),
        (6_003, "Cavemoss Spore Cassette"),
        (6_004, "Emberbean Seed Cassette"),
        (6_005, "Riftroot Set Cassette"),
        (6_006, "Brineleaf Spore Cassette"),
        (6_007, "Glasspepper Seed Cassette"),
        (6_008, "Coilreed Node Cassette"),
        (6_009, "Nightplum Pit Cassette"),
        (6_101, "Ashgrain Sheaf"),
        (6_102, "Sunmelon"),
        (6_103, "Cavemoss Brick"),
        (6_104, "Emberbean Pods"),
        (6_105, "Riftroot Tubers"),
        (6_106, "Brineleaf Fronds"),
        (6_107, "Glasspeppers"),
        (6_108, "Coilreed Stalks"),
        (6_109, "Nightplums"),
        (6_313, "Light Density Matrix"),
        (6_314, "Medium Density Matrix"),
        (6_315, "Heavy Density Matrix"),
        (6_316, "Light Savor Matrix"),
        (6_317, "Medium Savor Matrix"),
        (6_318, "Heavy Savor Matrix"),
        (6_319, "Light Nutrient Matrix"),
        (6_320, "Medium Nutrient Matrix"),
        (6_321, "Heavy Nutrient Matrix"),
        (6_322, "Light Batch Matrix"),
        (6_323, "Medium Batch Matrix"),
        (6_324, "Heavy Batch Matrix"),
        (6_401, "Ashgrain Meal"),
        (6_402, "Sunmelon Press"),
        (6_403, "Cavemoss Extract"),
        (6_404, "Emberbean Curd"),
        (6_405, "Riftroot Starch"),
        (6_406, "Brineleaf Salt"),
        (6_407, "Glasspepper Mash"),
        (6_408, "Coilreed Syrup"),
        (6_409, "Nightplum Preserve"),
        (6_410, "Field Dough"),
        (6_411, "Hearth Broth"),
        (6_412, "Clodmeat Mince"),
        (6_413, "Ferment Culture"),
        (6_414, "Rendered Fat"),
        (6_415, "Seasoning Brick"),
        (6_501, "Ashgrain Hearth Loaf"),
        (6_502, "Sunmelon Slicecake"),
        (6_503, "Cavemoss Broth"),
        (6_504, "Emberbean Griddle Cakes"),
        (6_505, "Riftroot Skillet Hash"),
        (6_506, "Brineleaf Noodle Bowl"),
        (6_507, "Glasspepper Clod Skewer"),
        (6_508, "Coilreed Glaze Bun"),
        (6_509, "Nightplum Hand Pie"),
        (6_510, "Clodmeat Stew Tin"),
        (6_511, "Trail Ration Tray"),
        (6_512, "Field Dumplings"),
        (6_513, "Smoked Clod Cutlet"),
        (6_514, "Pressed Fruit Bar"),
        (6_515, "Night Watch Soup"),
        (6_516, "Farmhand Breakfast"),
        (6_517, "Spiced Riftroot Mash"),
        (6_518, "Harvest Layer Cake"),
        (6_519, "Cavemoss Steep"),
        (6_520, "Sunmelon Cooler"),
    ];

    #[test]
    fn all_catalog_items_have_unique_banded_ids_and_canonical_names() {
        assert_eq!(CATALOG_NAMES.len(), 65);
        let mut ids = BTreeSet::new();
        for (item_id, expected_name) in CATALOG_NAMES {
            assert!(ids.insert(*item_id), "duplicate catalog item {item_id}");
            assert!(
                (6_001..=6_009).contains(item_id)
                    || (6_101..=6_109).contains(item_id)
                    || (6_313..=6_324).contains(item_id)
                    || (6_401..=6_415).contains(item_id)
                    || (6_501..=6_520).contains(item_id),
                "item {item_id} escaped its catalog band"
            );
            assert_eq!(inventory_item_name(*item_id), Some(*expected_name));
        }
        assert_eq!(ids.len(), 65);
    }

    #[test]
    fn concrete_ranged_items_have_canonical_inventory_rows() {
        let concrete_items = [
            (STEN_MK2_ITEM_ID, AuthorityWeaponId::WpnSmg, "STEN Mk II"),
            (
                KILN_ENERGY_CELL_ITEM_ID,
                AuthorityWeaponId::WpnCarbine,
                "Kiln Energy Cell Carbine",
            ),
            (
                LIGHTNING_CARBINE_ITEM_ID,
                AuthorityWeaponId::LightningCarbine,
                "Lightning Carbine",
            ),
            (
                BADGE_BOLT_PISTOL_ITEM_ID,
                AuthorityWeaponId::WpnPistol,
                "Badge Bolt Pistol",
            ),
            (
                SLAGRAIL_VANGUARD_ITEM_ID,
                AuthorityWeaponId::WpnAssault,
                "Slagrail Vanguard",
            ),
            (
                COILGATE_SCATTER_ITEM_ID,
                AuthorityWeaponId::WpnShotgun,
                "Coilgate Scatter",
            ),
            (
                KILN_LONG_PATTERN_ITEM_ID,
                AuthorityWeaponId::WpnSniper,
                "Kiln Long Pattern",
            ),
            (
                BASTION_LMG_ITEM_ID,
                AuthorityWeaponId::WpnHeavy,
                "Bastion LMG",
            ),
            (
                FLARE_NET_LAUNCHER_ITEM_ID,
                AuthorityWeaponId::WpnLauncher,
                "Flare Net Launcher",
            ),
        ];
        for (item_id, weapon_id, name) in concrete_items {
            assert_eq!(weapon_id_for_inventory_item(item_id), Some(weapon_id));
            assert_eq!(inventory_item_name(item_id), Some(name));
            assert_eq!(
                canonical_inventory_item_for_weapon_id(weapon_id),
                Some(item_id)
            );
            assert_eq!(
                SliceAuthorityState::inventory_stack_cap_for_item(item_id, 99),
                PERSONAL_SHIELD_GENERATOR_STACK_CAP
            );
        }

        let retired_item_ids = [3_110, 3_113, 3_114, 3_115, 3_116, 3_117];
        let loot_variant = encode_loot_variant(LootTier::Marked, 0);
        for item_id in retired_item_ids {
            assert!(
                weapon_id_for_inventory_item(item_id).is_none(),
                "retired item {item_id} must not equip"
            );
            assert!(
                inventory_item_name(item_id).is_none(),
                "retired item {item_id} must not have a catalog name"
            );
            assert!(
                rolled_loot_item_name(item_id, loot_variant).is_none(),
                "retired item {item_id} must not have a loot path"
            );
        }
    }
}
