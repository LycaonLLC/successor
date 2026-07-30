use super::*;
use crate::authority::crafting::{
    authority_crafting_unlock_catalog, craft_assembly_seed, craft_batch_risk_per_extra_point_milli,
    normalize_craft_name,
};
use crate::authority::inventory::authority_weapon_certification_catalog;
use crate::authority::progression::authority_capability_unlock_catalog;
use crate::authority_bridge::AuthorityBridgeImportStateRequest;
use crate::{AuthorityBridge, AuthorityBridgeActorInput, AuthorityBridgeActorRequest};
use successor_net::{
    AuthorityAmmoTypeId, AuthorityWeaponId, CardinalDirection, ClientCommand, ClientCommandEnvelope,
};

const TEST_ROLL_DAMAGE: i32 = 10;

const OPEN_DESERT_FIXTURE_JSON: &str =
    include_str!("../../../../client/public/successor-slice/open-desert-slice.json");

include!("tests/core_and_combat.rs");
include!("tests/combat_ai.rs");
include!("tests/movement_and_world.rs");
include!("tests/durability_and_resources.rs");
include!("tests/loot_and_population.rs");
include!("tests/progression_and_economy.rs");
include!("tests/crafting_systems.rs");
include!("tests/camps_trade_and_duels.rs");
include!("tests/professions_and_biology.rs");
include!("tests/extraction_loot_weapons.rs");
include!("tests/medical_and_inventory.rs");
include!("tests/combat_gaia_and_factory.rs");
