use serde::Serialize;
use successor_net::ClientCommand;

pub const COMMAND_MANIFEST_SCHEMA: &str = "successor.commands.manifest.v1";
pub const COMMAND_MANIFEST_REGEN_COMMAND: &str = "cargo run -p successor-sim --bin emit_command_manifest -- tools/codegen/generated/successor.commands.manifest.v1.json && node tools/codegen/commands.mjs";
const RUST_COMMAND_SOURCE: &str = "rust-client-command";
const TYPESCRIPT_WIRE_SOURCE: &str = "typescript-authority-wire";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandManifest {
    pub schema: &'static str,
    pub source: &'static str,
    pub regeneration_command: &'static str,
    pub command_count: usize,
    pub rust_command_count: usize,
    pub debug_gated_count: usize,
    pub commands: &'static [CommandSpec],
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSpec {
    pub kind: &'static str,
    pub source: &'static str,
    pub verb: &'static str,
    #[serde(skip_serializing_if = "is_empty_str_slice")]
    pub aliases: &'static [&'static str],
    pub doc: &'static str,
    pub budget_class: &'static str,
    pub debug_gated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub durable_intent: Option<DurableIntent>,
    pub args: &'static [CommandArg],
    pub reason_codes: &'static [&'static str],
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DurableIntent {
    pub kind: &'static str,
    pub when: &'static str,
    pub notes: &'static str,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandArg {
    pub name: &'static str,
    #[serde(rename = "type")]
    pub arg_type: CommandArgType,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<&'static str>,
    #[serde(skip_serializing_if = "is_empty_str_slice")]
    pub enum_values: &'static [&'static str],
    #[serde(skip_serializing_if = "is_false")]
    pub repeated: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub nullable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<&'static str>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CommandArgType {
    Int,
    Bool,
    Enum,
    IdDomain,
    Text,
}
const EMPTY: &[&str] = &[];
const BOOL: &[&str] = &["false", "true"];
const CARDINAL_DIRECTIONS: &[&str] = &["Front", "Right", "Back", "Left"];
const WEAPON_IDS: &[&str] = &[
    "Slugthrower",
    "Vibrosword",
    "WpnPistol",
    "WpnSmg",
    "WpnCarbine",
    "WpnAssault",
    "WpnShotgun",
    "WpnSniper",
    "WpnHeavy",
    "WpnLauncher",
];
const AMMO_TYPES: &[&str] = &["SlugIron", "SlugShard", "SlugSpike", "Melee"];
const COMBAT_ACTION_IDS: &[&str] = &["basic_shot", "aimed_shot"];
const ABILITY_QUEUE_CANCEL_SCOPES: &[&str] = &["owner_repeat", "combat", "posture", "all"];
const POSTURES: &[&str] = &["kneel", "stand"];
const TRAVEL_TICKET_ITEM_IDS: &[&str] = &["travel_ticket"];

const fn int_arg(name: &'static str, required: bool) -> CommandArg {
    CommandArg {
        name,
        arg_type: CommandArgType::Int,
        required,
        domain: None,
        enum_values: EMPTY,
        repeated: false,
        nullable: false,
        default: None,
    }
}
const fn bool_arg(name: &'static str, required: bool) -> CommandArg {
    CommandArg {
        name,
        arg_type: CommandArgType::Bool,
        required,
        domain: None,
        enum_values: EMPTY,
        repeated: false,
        nullable: false,
        default: None,
    }
}

const fn enum_arg(
    name: &'static str,
    required: bool,
    enum_values: &'static [&'static str],
) -> CommandArg {
    CommandArg {
        name,
        arg_type: CommandArgType::Enum,
        required,
        domain: None,
        enum_values,
        repeated: false,
        nullable: false,
        default: None,
    }
}
const fn text_arg(name: &'static str, required: bool, default: Option<&'static str>) -> CommandArg {
    CommandArg {
        name,
        arg_type: CommandArgType::Text,
        required,
        domain: None,
        enum_values: EMPTY,
        repeated: false,
        nullable: false,
        default,
    }
}

const fn id_arg(name: &'static str, required: bool, domain: &'static str) -> CommandArg {
    CommandArg {
        name,
        arg_type: CommandArgType::IdDomain,
        required,
        domain: Some(domain),
        enum_values: EMPTY,
        repeated: false,
        nullable: false,
        default: None,
    }
}

const fn repeated_id_arg(name: &'static str, required: bool, domain: &'static str) -> CommandArg {
    CommandArg {
        name,
        arg_type: CommandArgType::IdDomain,
        required,
        domain: Some(domain),
        enum_values: EMPTY,
        repeated: true,
        nullable: false,
        default: None,
    }
}

const fn nullable_id_arg(name: &'static str, required: bool, domain: &'static str) -> CommandArg {
    CommandArg {
        name,
        arg_type: CommandArgType::IdDomain,
        required,
        domain: Some(domain),
        enum_values: EMPTY,
        repeated: false,
        nullable: true,
        default: None,
    }
}

const fn defaulted_int_arg(
    name: &'static str,
    required: bool,
    default: &'static str,
) -> CommandArg {
    CommandArg {
        name,
        arg_type: CommandArgType::Int,
        required,
        domain: None,
        enum_values: EMPTY,
        repeated: false,
        nullable: false,
        default: Some(default),
    }
}

const fn defaulted_enum_arg(
    name: &'static str,
    required: bool,
    enum_values: &'static [&'static str],
    default: &'static str,
) -> CommandArg {
    CommandArg {
        name,
        arg_type: CommandArgType::Enum,
        required,
        domain: None,
        enum_values,
        repeated: false,
        nullable: false,
        default: Some(default),
    }
}

const REASONS_MOVE: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "move_rejected",
    "invalid_move_vector",
    "invalid_move_duration",
    "out_of_bounds",
    "blocked_cell",
    "actor_not_alive",
    "actor_asleep",
    "posture_locked",
    "move_cooldown",
];
const REASONS_MOVE_INTENT: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "move_intent_rejected",
    "invalid_move_vector",
    "out_of_bounds",
    "blocked_cell",
    "actor_not_alive",
    "actor_asleep",
    "posture_locked",
];
const REASONS_QUEUE_COMBAT: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "fire_rejected",
    "actor_not_alive",
    "actor_asleep",
    "queue_full",
    "no_weapon_equipped",
    "ammo_unavailable",
    "insufficient_action",
    "target_unavailable",
    "target_protected",
    "out_of_range",
    "los_blocked",
    "melee_while_kneeling",
];
const REASONS_PEACE: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "peace_rejected",
    "actor_not_alive",
    "target_unavailable",
];
const REASONS_CANCEL_QUEUE: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "fire_rejected",
    "actor_not_alive",
    "queue_entry_unknown",
    "target_unavailable",
];
const REASONS_EQUIPMENT: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "fire_rejected",
    "actor_not_alive",
    "actor_asleep",
    "unknown_item",
    "item_unavailable",
    "ammo_unavailable",
    "no_weapon_equipped",
    "not_at_stockpile",
];
const REASONS_SET_EQUIPPED_WEAPON: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "fire_rejected",
    "actor_not_alive",
    "actor_asleep",
    "unknown_item",
    "item_unavailable",
    "ammo_unavailable",
    "no_weapon_equipped",
    "weapon_not_certified",
    "not_at_stockpile",
];
const REASONS_TRANSITION: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "transition_rejected",
    "unknown_transition",
    "wrong_transition_area",
    "not_at_transition_trigger",
    "actor_not_alive",
    "actor_asleep",
];
const REASONS_CONSUMABLE: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "consumable_rejected",
    "actor_not_alive",
    "actor_asleep",
    "unknown_item",
    "item_unavailable",
    "unknown_effect",
];
const REASONS_SERVICE_BUFF: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "service_buff_rejected",
    "actor_not_alive",
    "actor_asleep",
    "unknown_effect",
    "insufficient_credits",
];
const REASONS_CLONE: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "clone_respawn_rejected",
    "no_clone_facility",
    "unknown_clone_facility",
    "invalid_clone_respawn",
];
const REASONS_REVIVE: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "revive_actor_rejected",
    "actor_not_alive",
    "actor_asleep",
    "target_unavailable",
    "unknown_item",
    "item_unavailable",
];
const REASONS_BANK: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "actor_not_alive",
    "actor_asleep",
    "not_at_bank_terminal",
    "invalid_bank_quantity",
    "bank_stack_missing",
    "bank_capacity",
    "bank_overflow",
    "insufficient_credits",
    "unknown_item",
];
const REASONS_CORPSE_CREDITS: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "loot_target_unknown",
    "loot_not_lootable",
    "loot_out_of_range",
    "loot_invalid_quantity",
];
const REASONS_POSTURE: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "posture_rejected",
    "actor_not_alive",
    "actor_asleep",
    "posture_locked",
    "queue_full",
    "target_unavailable",
];
const REASONS_RESOURCE: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "sample_resource_rejected",
    "survey_resource_rejected",
    "actor_not_alive",
    "actor_asleep",
    "invalid_resource_family",
    "missing_survey_tool",
    "economy_cooldown",
    "sample_cooldown",
    "container_full",
    // Shard-synthesized (bare /survey //sample reuse-last with no session
    // context): the honest "use your inventory tool" prompt. Resolved at shard
    // ingress; never a Rust AuthorityRejectReason.
    "no_survey_context",
    "no_sample_context",
];
const REASONS_EXTRACTOR: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "unknown_area",
    "ingress_budget_exhausted",
    "actor_not_alive",
    "actor_asleep",
    "posture_locked",
    "out_of_bounds",
    "blocked_cell",
    "invalid_resource_family",
    "unknown_item",
    "item_unavailable",
    "container_full",
    "extractor_already_placed",
    "no_placed_extractor",
    "not_extractor_owner",
    "not_at_extractor",
    "extractor_hopper_empty",
    "extractor_hopper_full",
    "extractor_busy",
    "extractor_battery_present",
    "missing_battery",
];
const REASONS_CAMP: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "unknown_area",
    "ingress_budget_exhausted",
    "actor_not_alive",
    "actor_asleep",
    "posture_locked",
    "out_of_bounds",
    "blocked_cell",
    "structure_footprint_blocked",
    "unknown_item",
    "item_unavailable",
    "camp_already_placed",
    "no_placed_camp",
    "not_camp_owner",
    "not_at_camp",
];
const REASONS_STACKS: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "split_stack_rejected",
    "merge_stacks_rejected",
    "unknown_item",
    "item_unavailable",
    "loot_missing_stack",
    "loot_invalid_quantity",
    "container_full",
];
const REASONS_DISCARD_STACK: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "discard_stack_rejected",
    "actor_not_alive",
    "actor_asleep",
    "item_unavailable",
];
const REASONS_REDEEM_CHIP: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "redeem_credit_chip_rejected",
    "actor_not_alive",
    "actor_asleep",
    "unknown_item",
    "item_unavailable",
];
const REASONS_LOOT: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "harvest_corpse_rejected",
    "loot_target_unknown",
    "target_unavailable",
    "target_not_harvestable",
    "loot_out_of_range",
    "loot_no_rights",
    "loot_not_lootable",
    "loot_missing_stack",
    "loot_invalid_quantity",
    "container_full",
];
const REASONS_TRAVEL_PURCHASE: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "travel_purchase_rejected",
    "travel_actor_not_alive",
    "travel_terminal_unknown",
    "travel_terminal_unavailable",
    "travel_out_of_range",
    "travel_destination_unknown",
    "travel_same_destination",
];
const REASONS_TRAVEL_USE: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "travel_use_rejected",
    "travel_actor_not_alive",
    "travel_ticket_not_found",
    "travel_ticket_malformed",
    "travel_origin_terminal_unknown",
    "travel_origin_wrong_terminal",
    "travel_origin_wrong_area",
    "travel_out_of_range",
    "travel_destination_unknown",
    "travel_destination_blocked",
];
const REASONS_DOOR: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "door_toggle_rejected",
    "door_actor_unavailable",
    "door_unknown",
    "door_out_of_range",
];
const REASONS_CRAFT: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "craft_item_rejected",
    "actor_not_alive",
    "actor_asleep",
    "unknown_schematic",
    "ingredient_unavailable",
    "invalid_experimentation",
    "container_full",
    "missing_survey_tool",
    "item_unavailable",
    "craft_session_active",
    "no_craft_session",
    "craft_slot_unfilled",
    "craft_slot_mismatch",
    "craft_already_assembled",
    "craft_not_assembled",
    "invalid_experiment_line",
    "invalid_craft_name",
    "schematic_uses_exceeded",
    "unknown_factory",
    "not_at_factory",
    "factory_draft_missing",
    "factory_draft_mismatch",
    "tool_already_held",
    "starter_tool_cooldown",
    "trainer_unavailable",
];
const REASONS_BIO: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "actor_not_alive",
    "actor_asleep",
    "unknown_item",
    "item_unavailable",
    "unknown_crop_species",
    "missing_gene_sampler",
    "missing_genome_scanner",
    "missing_splice_bench",
    "genome_unavailable",
    "target_unavailable",
    "economy_cooldown",
    "ingredient_unavailable",
    "splice_session_active",
    "no_splice_session",
    "splice_slot_mismatch",
    "splice_already_assembled",
    "splice_not_assembled",
    "invalid_splice_locus",
    "invalid_splice_experiment",
];
const REASONS_SKILL: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "purchase_skill_box_rejected",
    "profession_title_rejected",
    "career_goal_rejected",
    "unknown_skill_box",
    "skill_already_learned",
    "skill_not_learned",
    "skill_required_by_learned_box",
    "skill_prerequisite_missing",
    "insufficient_profession_xp",
    "insufficient_credits",
    "insufficient_skill_points",
    "trainer_unavailable",
    "unknown_profession_title",
    "unknown_career_goal",
];
const REASONS_EXCHANGE: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "unknown_item",
    "item_unavailable",
    "loot_invalid_quantity",
    "container_full",
    "insufficient_credits",
];
const REASONS_TRADE: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "actor_not_alive",
    "target_unavailable",
    "unknown_item",
    "item_unavailable",
    "loot_invalid_quantity",
    "container_full",
    "insufficient_credits",
    "trade_session_active",
    "no_trade_session",
    "trade_not_locked",
];
const REASONS_DEBUG: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "debug_authority_command_disabled",
    "ingress_budget_exhausted",
    "unknown_item",
    "item_unavailable",
    "container_full",
    "unknown_skill_box",
    "skill_already_learned",
    "skill_prerequisite_missing",
];
const REASONS_GROUP_INVITE: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "target_unavailable",
    "actor_not_alive",
    "cannot_group_self",
    "already_in_group",
    "group_full",
];
const REASONS_GROUP_ACCEPT: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "target_unavailable",
    "actor_not_alive",
    "no_pending_invite",
    "already_in_group",
    "group_full",
];
const REASONS_GROUP_DECLINE: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "no_pending_invite",
];
const REASONS_GROUP_LEAVE: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "not_in_group",
];
const REASONS_GROUP_DISBAND: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "not_in_group",
    "not_group_leader",
];
const REASONS_GROUP_KICK: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "not_in_group",
    "not_group_leader",
    "not_group_member",
    "cannot_group_self",
];
const REASONS_DUEL_CHALLENGE: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "target_unavailable",
    "actor_not_alive",
    "cannot_duel_self",
    "already_dueling",
];
const REASONS_DUEL_ACCEPT: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "target_unavailable",
    "actor_not_alive",
    "no_pending_duel_challenge",
    "already_dueling",
];
const REASONS_DUEL_DECLINE: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "no_pending_duel_challenge",
];
const REASONS_DUEL_YIELD: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "not_in_duel",
];
const REASONS_DEATHBLOW: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "actor_not_alive",
    "cannot_duel_self",
    "not_in_duel",
    "target_unavailable",
    "out_of_range",
];
const GUILD_ROLES: &[&str] = &["leader", "officer", "member"];
const REASONS_GUILD: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "actor_not_alive",
    "not_at_pa_terminal",
    "guild_name_too_long",
    "guild_tag_too_long",
    "guild_name_exists",
    "guild_tag_exists",
    "already_in_guild",
    "not_in_guild",
    "no_guild_permission",
    "guild_not_found",
    "invite_expired",
    "invite_not_found",
    "invite_already_pending",
    "already_waring",
    "not_waring",
];

const PARCEL_TIERS: &[&str] = &["homestead", "farmstead", "plantation"];
const REASONS_CLAIM_PARCEL: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "actor_not_alive",
    "unknown_area",
    "not_in_housing_region",
    "out_of_bounds",
    "parcel_limit_reached",
    "parcel_overlap",
    "too_close_to_poi",
    "too_close_to_road",
    "no_claim_zone",
    "insufficient_credits",
    "target_unavailable",
];
const REASONS_PARCEL_OWNED: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "unknown_parcel",
    "not_parcel_owner",
];
const REASONS_PAY_UPKEEP: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "unknown_parcel",
    "not_parcel_owner",
    "upkeep_not_due",
    "insufficient_credits",
];
const REASONS_TILL_TILE: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "actor_not_alive",
    "unknown_parcel",
    "not_parcel_owner",
    "outside_farm_yard",
    "tile_already_tilled",
];
const REASONS_PLANT_SEED: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "actor_not_alive",
    "unknown_parcel",
    "not_parcel_owner",
    "outside_farm_yard",
    "tile_not_tilled",
    "tile_occupied",
    "seed_not_owned",
];
const REASONS_TILE_WORK: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "actor_not_alive",
    "unknown_parcel",
    "not_parcel_owner",
    "outside_farm_yard",
    "tile_not_tilled",
];
const REASONS_TEND_PLOT: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "actor_not_alive",
    "unknown_parcel",
    "not_parcel_owner",
    "outside_farm_yard",
];
const REASONS_PLACE_FARM_STRUCTURE: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "unknown_parcel",
    "not_parcel_owner",
    "outside_farm_yard",
    "structure_footprint_blocked",
    "unknown_item",
    "item_unavailable",
];
const REASONS_REMOVE_FARM_STRUCTURE: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "unknown_parcel",
    "not_parcel_owner",
    "no_farm_structure",
];
const REASONS_BUILD_PLACE: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "unknown_parcel",
    "not_parcel_owner",
    "unknown_schematic",
    "out_of_bounds",
    "structure_footprint_blocked",
    "ingredient_unavailable",
];
const REASONS_BUILD_REMOVE: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "unknown_parcel",
    "not_parcel_owner",
    "unknown_schematic",
];
const REASONS_BUILD_TOGGLE_DOOR: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "unknown_parcel",
    "not_parcel_owner",
    "target_unavailable",
];

const REASONS_FERTILIZE: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "actor_not_alive",
    "unknown_parcel",
    "not_parcel_owner",
    "outside_farm_yard",
    "tile_not_tilled",
    "tile_already_fertilized",
    "unknown_item",
    "item_unavailable",
];
const REASONS_HARVEST_CROP: &[&str] = &[
    "wrong_session",
    "wrong_player",
    "duplicate_command",
    "unknown_actor",
    "ingress_budget_exhausted",
    "actor_not_alive",
    "unknown_parcel",
    "not_parcel_owner",
    "outside_farm_yard",
    "tile_not_tilled",
    "tile_empty",
    "crop_not_mature",
];

macro_rules! command_specs {
    (
        $(
            $source:ident $kind:ident {
                verb: $verb:expr,
                aliases: $aliases:expr,
                doc: $doc:expr,
                budget_class: $budget_class:expr,
                debug_gated: $debug_gated:expr,
                durable_intent: $durable_intent:expr,
                args: $args:expr,
                reason_codes: $reason_codes:expr $(,)?
            }
        ),+ $(,)?
    ) => {
        pub const COMMANDS: &[CommandSpec] = &[
            $(
                CommandSpec {
                    kind: stringify!($kind),
                    source: command_specs!(@source $source),
                    verb: $verb,
                    aliases: $aliases,
                    doc: $doc,
                    budget_class: $budget_class,
                    debug_gated: $debug_gated,
                    durable_intent: $durable_intent,
                    args: $args,
                    reason_codes: $reason_codes,
                },
            )+
        ];
    };
    (@source rust) => { RUST_COMMAND_SOURCE };
    (@source wire) => { TYPESCRIPT_WIRE_SOURCE };
}

command_specs! {
    rust Move {
        verb: "move",
        aliases: EMPTY,
        doc: "Move the controlled actor by one bounded grid vector for a short duration.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[int_arg("dx", true), int_arg("dy", true), int_arg("duration_ticks", true), enum_arg("facing", false, CARDINAL_DIRECTIONS), defaulted_enum_arg("sprint", false, BOOL, "false")],
        reason_codes: REASONS_MOVE,
    },
    rust SetMoveIntent {
        verb: "move-intent",
        aliases: &["set-move-intent"],
        doc: "Set the held movement vector used by continuous player locomotion.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[int_arg("dx", true), int_arg("dy", true), enum_arg("facing", false, CARDINAL_DIRECTIONS), defaulted_enum_arg("sprint", false, BOOL, "false")],
        reason_codes: REASONS_MOVE_INTENT,
    },
    rust QueueCombatAction {
        verb: "attack",
        aliases: &["queue-combat-action"],
        doc: "Queue a roll-combat action against a target; basic_shot arms the server repeat intent.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: Some(DurableIntent { kind: "repeat_intent", when: "action_id=basic_shot", notes: "One accepted basic_shot arms owner repeat fire until cancelled, peace, invalid target, or dismissal." }),
        args: &[enum_arg("action_id", true, COMBAT_ACTION_IDS), id_arg("target_actor_id", true, "actor_id")],
        reason_codes: REASONS_QUEUE_COMBAT,
    },
    rust Peace {
        verb: "peace",
        aliases: EMPTY,
        doc: "Request peace and dismiss queued combat repeat/entries for the controlled player-like actor.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[],
        reason_codes: REASONS_PEACE,
    },
    rust CancelAbilityQueue {
        verb: "cancel-queue",
        aliases: &["cancel-ability-queue"],
        doc: "Cancel one ability queue entry or a queue scope such as owner_repeat, combat, posture, or all.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("queue_entry_id", false, "ability_queue_entry_id"), enum_arg("scope", false, ABILITY_QUEUE_CANCEL_SCOPES)],
        reason_codes: REASONS_CANCEL_QUEUE,
    },
    rust ReloadWeapon {
        verb: "reload-weapon",
        aliases: &["reload"],
        doc: "Reload a weapon from available ammunition or a stockpile.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[enum_arg("weapon_id", false, WEAPON_IDS), enum_arg("ammo_type", false, AMMO_TYPES)],
        reason_codes: REASONS_EQUIPMENT,
    },
    rust SetEquippedWeapon {
        verb: "set-equipped-weapon",
        aliases: &["equip-weapon"],
        doc: "Equip or clear a weapon by weapon enum and optional inventory item id.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[nullable_id_arg("weapon_id", false, "weapon_id"), id_arg("weapon_item_id", false, "inventory_item_numeric_id")],
        reason_codes: REASONS_SET_EQUIPPED_WEAPON,
    },
    rust SetEquippedClothing {
        verb: "set-equipped-clothing",
        aliases: &["equip-clothing"],
        doc: "Equip or unequip one owned clothing inventory instance; loot clothing requires exact stack and variant.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[
            int_arg("item_id", true),
            bool_arg("equipped", true),
            id_arg("container", false, "inventory_container_id"),
            id_arg("stack_id", false, "inventory_stack_id"),
            int_arg("variant_id", false),
        ],
        reason_codes: REASONS_EQUIPMENT,
    },
    rust DebugGiveItem {
        verb: "debug-give-item",
        aliases: EMPTY,
        doc: "Debug-only item grant command gated by GAME_DEBUG_AUTHORITY_COMMANDS.",
        budget_class: "authority-debug",
        debug_gated: true,
        durable_intent: None,
        args: &[id_arg("item_id", true, "item_numeric_id"), defaulted_int_arg("variant_id", false, "0"), defaulted_int_arg("quantity", false, "1"), defaulted_enum_arg("equip", false, BOOL, "false")],
        reason_codes: REASONS_DEBUG,
    },
    rust DebugGrantSkillBoxes {
        verb: "debug-grant-skill-boxes",
        aliases: EMPTY,
        doc: "Debug-only skill-box grant command gated by GAME_DEBUG_AUTHORITY_COMMANDS.",
        budget_class: "authority-debug",
        debug_gated: true,
        durable_intent: None,
        args: &[repeated_id_arg("skill_box_ids", true, "skill_box_id")],
        reason_codes: REASONS_DEBUG,
    },
    rust EnterTransition {
        verb: "enter-transition",
        aliases: &["transition"],
        doc: "Use an area transition trigger by id.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("transition_id", true, "transition_id")],
        reason_codes: REASONS_TRANSITION,
    },
    rust UseConsumable {
        verb: "use-consumable",
        aliases: &["use"],
        doc: "Use a consumable by string item id and optional numeric item/variant ids.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("item_id", true, "item_id"), id_arg("item_numeric_id", false, "item_numeric_id"), id_arg("variant_id", false, "item_variant_id")],
        reason_codes: REASONS_CONSUMABLE,
    },
    rust RefillAmmo {
        verb: "refill-ammo",
        aliases: EMPTY,
        doc: "Refill an ammo item stack from authority inventory/stockpile state.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("item_id", true, "item_id")],
        reason_codes: REASONS_EQUIPMENT,
    },
    rust ApplyServiceBuff {
        verb: "apply-service-buff",
        aliases: &["service-buff"],
        doc: "Apply a service buff effect to the controlled actor.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("effect_id", true, "service_buff_effect_id")],
        reason_codes: REASONS_SERVICE_BUFF,
    },
    rust CloneRespawn {
        verb: "clone-respawn",
        aliases: &["clone"],
        doc: "Respawn through a clone facility, optionally naming the facility id.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[nullable_id_arg("facility_id", false, "clone_facility_id")],
        reason_codes: REASONS_CLONE,
    },
    rust ReviveActor {
        verb: "revive-actor",
        aliases: &["revive"],
        doc: "Revive a target actor using available authority medical state.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("target_actor_id", true, "actor_id")],
        reason_codes: REASONS_REVIVE,
    },
    rust SetPosture {
        verb: "posture",
        aliases: &["set-posture", "kneel", "stand"],
        doc: "Queue or apply a kneel/stand posture change.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[enum_arg("posture", true, POSTURES)],
        reason_codes: REASONS_POSTURE,
    },
    rust SampleResource {
        verb: "sample",
        aliases: &["sample-resource", "stop-sample"],
        doc: "Sample a resource family into the player's inventory and arm a durable auto-repeat loop; stop=true cancels the loop.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: Some(DurableIntent { kind: "resource_sample_loop", when: "accepted stop=false", notes: "Accepted sampling repeats server-side every RESOURCE_SAMPLE_AUTO_REPEAT_CADENCE_TICKS until movement, posture break, area change, death, or stop=true." }),
        args: &[id_arg("family", true, "resource_family"), defaulted_enum_arg("stop", false, BOOL, "false")],
        reason_codes: REASONS_RESOURCE,
    },
    rust BankStoreItem {
        verb: "bank-store-item",
        aliases: &["bank-store"],
        doc: "Move an exact carried stack quantity into the owning character bank.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("source_stack_id", true, "inventory_stack_id"), int_arg("quantity", true)],
        reason_codes: REASONS_BANK,
    },
    rust BankRetrieveItem {
        verb: "bank-retrieve-item",
        aliases: &["bank-retrieve"],
        doc: "Move an exact bank stack quantity into carried inventory.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("bank_stack_id", true, "inventory_stack_id"), int_arg("quantity", true)],
        reason_codes: REASONS_BANK,
    },
    rust BankDepositCredits {
        verb: "bank-deposit-credits",
        aliases: &["bank-deposit"],
        doc: "Deposit positive wallet credits into the owning character bank.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[int_arg("amount", true)],
        reason_codes: REASONS_BANK,
    },
    rust BankWithdrawCredits {
        verb: "bank-withdraw-credits",
        aliases: &["bank-withdraw"],
        doc: "Withdraw positive bank credits into the wallet.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[int_arg("amount", true)],
        reason_codes: REASONS_BANK,
    },
    rust CloneSaveSkillBackup {
        verb: "clone-save-skill-backup",
        aliases: &["save-skill-backup"],
        doc: "Save or update the profession backup for clone restoration, costing 1000 credits after the implicit initial backup.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[],
        reason_codes: REASONS_BANK,
    },
    rust CorpseTakeCredits {
        verb: "corpse-take-credits",
        aliases: &["take-corpse-credits"],
        doc: "Take all remaining credits from a public player corpse.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("corpse_id", true, "player_corpse_id")],
        reason_codes: REASONS_CORPSE_CREDITS,
    },
    rust SurveyResource {
        verb: "survey",
        aliases: &["survey-resource"],
        doc: "Survey nearby spawns for a resource family and emit a survey result.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("family", true, "resource_family")],
        reason_codes: REASONS_RESOURCE,
    },
    rust PlaceExtractor {
        verb: "place-extractor",
        aliases: &["place-extract"],
        doc: "Place one carried extractor for a surveyed resource family at the actor's current position.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: Some(DurableIntent { kind: "placed_extractor", when: "accepted", notes: "One accepted placement persists a server-owned extractor until collected or destroyed." }),
        args: &[id_arg("family", true, "resource_family")],
        reason_codes: REASONS_EXTRACTOR,
    },
    rust CrankExtractor {
        verb: "crank-extractor",
        aliases: &["crank"],
        doc: "Start manual extraction on an owned nearby extractor; standing actors enter the kneel-down lock first.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: Some(DurableIntent { kind: "manual_extraction", when: "accepted", notes: "The actor keeps cranking until StopCrank, stand/move/death, range failure, or hopper full." }),
        args: &[id_arg("extractor_id", true, "placed_extractor_id")],
        reason_codes: REASONS_EXTRACTOR,
    },
    rust StopCrank {
        verb: "stop-crank",
        aliases: EMPTY,
        doc: "Stop the actor's current manual extractor crank, if any.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[],
        reason_codes: REASONS_EXTRACTOR,
    },
    rust InsertBattery {
        verb: "insert-battery",
        aliases: &["battery-extractor"],
        doc: "Consume one owned extractor battery stack and start autonomous extraction on a nearby owned extractor.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: Some(DurableIntent { kind: "battery_extraction", when: "accepted", notes: "A battery keeps extracting until power depletes, the hopper fills, or the extractor is destroyed." }),
        args: &[id_arg("extractor_id", true, "placed_extractor_id"), id_arg("container", true, "inventory_container"), id_arg("stack_id", true, "inventory_stack_id"), int_arg("variant_id", true)],
        reason_codes: REASONS_EXTRACTOR,
    },
    rust CollectExtractor {
        verb: "collect-extractor",
        aliases: &["collect-extract"],
        doc: "Collect whole resource units from an owned nearby extractor hopper into inventory.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("extractor_id", true, "placed_extractor_id")],
        reason_codes: REASONS_EXTRACTOR,
    },
    rust DestroyExtractor {
        verb: "destroy-extractor",
        aliases: &["pickup-extractor"],
        doc: "Remove an owned nearby extractor, discarding hopper contents and returning the device item.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("extractor_id", true, "placed_extractor_id")],
        reason_codes: REASONS_EXTRACTOR,
    },
    rust PlaceCamp {
        verb: "place-camp",
        aliases: &["pitch-camp"],
        doc: "Pitch the carried camp kit at the actor's position, spawning a one-per-player scout camp (weather-shelter zone). Consumes the kit.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: Some(DurableIntent { kind: "placed_camp", when: "accepted", notes: "One accepted placement persists a server-owned scout camp until packed up or auto-torn-down after the abandonment grace." }),
        args: &[],
        reason_codes: REASONS_CAMP,
    },
    rust PackUpCamp {
        verb: "pack-up-camp",
        aliases: &["strike-camp"],
        doc: "Strike the actor's own nearby scout camp, freeing the one-per-player slot. The kit was consumed on placement (single-use rule), so nothing is returned.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[],
        reason_codes: REASONS_CAMP,
    },
    rust SplitStack {
        verb: "split-stack",
        aliases: EMPTY,
        doc: "Split quantity out of an inventory stack.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("container", true, "inventory_container_id"), id_arg("stack_id", true, "inventory_stack_id"), id_arg("item_id", true, "item_numeric_id"), id_arg("variant_id", true, "item_variant_id"), int_arg("quantity", true)],
        reason_codes: REASONS_STACKS,
    },
    rust DiscardStack {
        verb: "discard-stack",
        aliases: EMPTY,
        doc: "Discard an entire exact carried inventory stack owned by the acting player.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("container", true, "inventory_container_id"), id_arg("stack_id", true, "inventory_stack_id"), id_arg("item_id", true, "item_numeric_id"), id_arg("variant_id", true, "item_variant_id")],
        reason_codes: REASONS_DISCARD_STACK,
    },
    rust MergeStacks {
        verb: "merge-stacks",
        aliases: EMPTY,
        doc: "Merge one inventory stack into another stack in the same container.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("container", true, "inventory_container_id"), id_arg("source_stack_id", true, "inventory_stack_id"), id_arg("target_stack_id", true, "inventory_stack_id")],
        reason_codes: REASONS_STACKS,
    },
    rust RedeemCreditChip {
        verb: "redeem-chip",
        aliases: &["redeem"],
        doc: "Redeem a Credit Chip stack from a player-owned container into the credit balance; the chip's quantity is its face value and the stack is consumed.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("container", true, "inventory_container_id"), id_arg("stack_id", true, "inventory_stack_id")],
        reason_codes: REASONS_REDEEM_CHIP,
    },
    rust HarvestCorpse {
        verb: "harvest-corpse",
        aliases: &["harvest"],
        doc: "Harvest all creature resources from a corpse: Hide, Meat, and Bone.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("target_actor_id", true, "actor_id")],
        reason_codes: REASONS_LOOT,
    },
    rust TakeLootItem {
        verb: "loot",
        aliases: &["take-loot", "take-loot-item"],
        doc: "Take a loot stack from a corpse/cache container.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("container", true, "loot_container_id"), id_arg("itemId", true, "item_numeric_id"), id_arg("variantId", true, "item_variant_id"), int_arg("quantity", true)],
        reason_codes: REASONS_LOOT,
    },
    wire PurchaseTravelTicket {
        verb: "purchase-travel-ticket",
        aliases: &["buy-ticket"],
        doc: "Purchase a travel ticket from a terminal to a destination planet/city.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("terminal_prop_id", true, "prop_id"), id_arg("to_planet_id", true, "planet_id"), id_arg("to_city_id", true, "city_id")],
        reason_codes: REASONS_TRAVEL_PURCHASE,
    },
    wire UseTravelTicket {
        verb: "use-travel-ticket",
        aliases: &["travel"],
        doc: "Consume a travel ticket and move to its recorded destination.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("container", false, "inventory_container_id"), id_arg("stack_id", false, "inventory_stack_id"), id_arg("ticket_id", false, "travel_ticket_id"), enum_arg("item_id", false, TRAVEL_TICKET_ITEM_IDS), id_arg("item_numeric_id", false, "item_numeric_id"), id_arg("variant_id", false, "item_variant_id")],
        reason_codes: REASONS_TRAVEL_USE,
    },
    wire ToggleDoor {
        verb: "toggle-door",
        aliases: &["door"],
        doc: "Toggle an interactive door prop near the actor.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("prop_id", true, "prop_id")],
        reason_codes: REASONS_DOOR,
    },
    rust CraftItem {
        verb: "craft-item",
        aliases: &["craft"],
        doc: "Craft a schematic with allocated experimentation points.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("schematic_id", true, "schematic_id"), int_arg("experiment_power", true), int_arg("experiment_handling", true), int_arg("experiment_reliability", true)],
        reason_codes: REASONS_CRAFT,
    },
    rust CraftBegin {
        verb: "craft-begin",
        aliases: EMPTY,
        doc: "Begin a multi-step crafting session for an unlocked recipe.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("recipe_id", true, "craft_recipe_id")],
        reason_codes: REASONS_CRAFT,
    },
    rust CraftAssignSlot {
        verb: "craft-assign-slot",
        aliases: EMPTY,
        doc: "Assign an exact inventory resource stack to a crafting session slot.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[int_arg("slot_index", true), id_arg("container", true, "inventory_container_id"), id_arg("stack_id", true, "inventory_stack_id"), int_arg("variant_id", true)],
        reason_codes: REASONS_CRAFT,
    },
    rust CraftClearSlot {
        verb: "craft-clear-slot",
        aliases: EMPTY,
        doc: "Clear a slot assignment before assembly.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[int_arg("slot_index", true)],
        reason_codes: REASONS_CRAFT,
    },
    rust CraftAssemble {
        verb: "craft-assemble",
        aliases: EMPTY,
        doc: "Consume assigned resources and assemble the prototype shell.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: Some(DurableIntent { kind: "point_of_no_return", when: "accepted", notes: "Accepted assembly consumes the exact assigned resource stacks; later cancel is lossy." }),
        args: &[],
        reason_codes: REASONS_CRAFT,
    },
    rust CraftExperiment {
        verb: "craft-experiment",
        aliases: EMPTY,
        doc: "Spend experimentation points on one assembled prototype stat line.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[int_arg("line_id", true), int_arg("points", true)],
        reason_codes: REASONS_CRAFT,
    },
    rust CraftFinalizePrototype {
        verb: "craft-finalize-prototype",
        aliases: EMPTY,
        doc: "Finalize an assembled prototype into the crafted inventory item.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[text_arg("custom_name", false, Some(""))],
        reason_codes: REASONS_CRAFT,
    },
    rust CraftFinalizePractice {
        verb: "craft-finalize-practice",
        aliases: EMPTY,
        doc: "Complete assembled practice without creating an item.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[],
        reason_codes: REASONS_CRAFT,
    },
    rust CraftDraftSchematic {
        verb: "craft-draft-schematic",
        aliases: EMPTY,
        doc: "Mint a drafted factory schematic handle from an assembled prototype.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[int_arg("max_uses", true)],
        reason_codes: REASONS_CRAFT,
    },
    rust FactoryManufacture {
        verb: "factory-manufacture",
        aliases: EMPTY,
        doc: "Spend one physical drafted schematic run at a factory workbench.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("factory_id", true, "factory_id"), id_arg("schematic_id", true, "schematic_id")],
        reason_codes: REASONS_CRAFT,
    },
    rust CraftCancel {
        verb: "craft-cancel",
        aliases: EMPTY,
        doc: "Cancel the active crafting session; after assembly this is lossy.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[],
        reason_codes: REASONS_CRAFT,
    },
    rust RequestStarterTool {
        verb: "request-starter-tool",
        aliases: &["starter-tool"],
        doc: "Ask a craftsman trainer to issue any missing Field Multitool and Mineral Survey Tool from the starter bundle.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("trainer_actor_id", true, "actor_id")],
        reason_codes: REASONS_CRAFT,
    },
    rust PurchaseSkillBox {
        verb: "purchase-skill-box",
        aliases: &["train-skill"],
        doc: "Purchase/train a skill box from a trainer actor.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("skill_box_id", true, "skill_box_id"), id_arg("trainer_actor_id", true, "actor_id")],
        reason_codes: REASONS_SKILL,
    },
    rust UnlearnSkillBox {
        verb: "unlearn-skill-box",
        aliases: &["untrain-skill"],
        doc: "Unlearn one skill box through a trainer, refunding its skill-point cost.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("skill_box_id", true, "skill_box_id"), id_arg("trainer_actor_id", true, "actor_id")],
        reason_codes: REASONS_SKILL,
    },
    rust SetProfessionTitle {
        verb: "set-profession-title",
        aliases: &["title"],
        doc: "Set or clear the active profession title.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[nullable_id_arg("title_id", false, "profession_title_id")],
        reason_codes: REASONS_SKILL,
    },
    rust SetCareerGoal {
        verb: "set-career-goal",
        aliases: &["career-goal"],
        doc: "Set the actor career goal through a trainer actor.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("goal_id", true, "career_goal_id"), id_arg("trainer_actor_id", true, "actor_id")],
        reason_codes: REASONS_SKILL,
    },
    rust StoreToExchange {
        verb: "store-to-exchange",
        aliases: EMPTY,
        doc: "Move a quantity from actor inventory into exchange storage.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("item_id", true, "item_numeric_id"), id_arg("variant_id", true, "item_variant_id"), int_arg("quantity", true)],
        reason_codes: REASONS_EXCHANGE,
    },
    rust RetrieveFromExchange {
        verb: "retrieve-from-exchange",
        aliases: EMPTY,
        doc: "Retrieve a quantity from exchange storage into actor inventory.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("item_id", true, "item_numeric_id"), id_arg("variant_id", true, "item_variant_id"), int_arg("quantity", true)],
        reason_codes: REASONS_EXCHANGE,
    },
    rust ProposeTrade {
        verb: "trade",
        aliases: &["propose-trade"],
        doc: "Propose a bilateral trade offer/request with another actor.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("partner_actor_id", true, "actor_id"), repeated_id_arg("offer", true, "trade_item_spec"), repeated_id_arg("request", true, "trade_item_spec")],
        reason_codes: REASONS_TRADE,
    },
    rust AcceptTrade {
        verb: "accept-trade",
        aliases: EMPTY,
        doc: "Accept a pending trade proposal.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("proposal_id", true, "trade_proposal_id")],
        reason_codes: REASONS_TRADE,
    },
    rust DeclineTrade {
        verb: "decline-trade",
        aliases: EMPTY,
        doc: "Decline or cancel a pending trade proposal.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("proposal_id", true, "trade_proposal_id")],
        reason_codes: REASONS_TRADE,
    },
    rust AddTradeItem {
        verb: "add-trade-item",
        aliases: EMPTY,
        doc: "Add an item line to the sender's own side of an open trade session (clears both accept-locks).",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("proposal_id", true, "trade_proposal_id"), id_arg("item", true, "trade_item_spec")],
        reason_codes: REASONS_TRADE,
    },
    rust RemoveTradeItem {
        verb: "remove-trade-item",
        aliases: EMPTY,
        doc: "Remove an item line from the sender's own side of an open trade session (clears both accept-locks).",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("proposal_id", true, "trade_proposal_id"), id_arg("item", true, "trade_item_spec")],
        reason_codes: REASONS_TRADE,
    },
    rust SetTradeCoin {
        verb: "set-trade-coin",
        aliases: EMPTY,
        doc: "Set the sender's own wallet-credit offer on an open trade session (clears both accept-locks).",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("proposal_id", true, "trade_proposal_id"), int_arg("amount", true)],
        reason_codes: REASONS_TRADE,
    },
    rust ConfirmTrade {
        verb: "confirm-trade",
        aliases: EMPTY,
        doc: "Final OK on a fully-locked trade session; both confirms execute the atomic swap.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("proposal_id", true, "trade_proposal_id")],
        reason_codes: REASONS_TRADE,
    },
    rust GroupInvite {
        verb: "group-invite",
        aliases: &["invite"],
        doc: "Invite a player into your group; a solo inviter forms a new group on accept.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("target_actor_id", true, "actor_id")],
        reason_codes: REASONS_GROUP_INVITE,
    },
    rust GroupAccept {
        verb: "group-accept",
        aliases: &["accept-invite"],
        doc: "Accept your pending group invite, joining the inviter's group.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[],
        reason_codes: REASONS_GROUP_ACCEPT,
    },
    rust GroupDecline {
        verb: "group-decline",
        aliases: &["decline-invite"],
        doc: "Decline your pending group invite.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[],
        reason_codes: REASONS_GROUP_DECLINE,
    },
    rust GroupLeave {
        verb: "group-leave",
        aliases: &["leave-group"],
        doc: "Leave your current group; deterministic leader succession applies.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[],
        reason_codes: REASONS_GROUP_LEAVE,
    },
    rust GroupDisband {
        verb: "group-disband",
        aliases: &["disband-group"],
        doc: "Disband your group entirely; leader only.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[],
        reason_codes: REASONS_GROUP_DISBAND,
    },
    rust GroupKick {
        verb: "group-kick",
        aliases: &["kick-member"],
        doc: "Remove a member from your group; leader only, cannot target self.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("target_actor_id", true, "actor_id")],
        reason_codes: REASONS_GROUP_KICK,
    },
    rust DuelChallenge {
        verb: "duel-challenge",
        aliases: &["duel"],
        doc: "Challenge a specific player to a consensual 1v1 duel; expires like a group invite.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("target_actor_id", true, "actor_id")],
        reason_codes: REASONS_DUEL_CHALLENGE,
    },
    rust DuelAccept {
        verb: "duel-accept",
        aliases: &["accept-duel"],
        doc: "Accept your pending duel challenge, forming the duel and opening damage within the pair.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[],
        reason_codes: REASONS_DUEL_ACCEPT,
    },
    rust DuelDecline {
        verb: "duel-decline",
        aliases: &["decline-duel"],
        doc: "Decline your pending duel challenge.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[],
        reason_codes: REASONS_DUEL_DECLINE,
    },
    rust DuelYield {
        verb: "duel-yield",
        aliases: &["yield-duel", "forfeit"],
        doc: "Yield your active duel; the yielder concedes and lives, the opponent wins.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[],
        reason_codes: REASONS_DUEL_YIELD,
    },
    rust Deathblow {
        verb: "deathblow",
        aliases: &[],
        doc: "Explicitly finish a downed opponent in your active duel at close range.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("target_actor_id", true, "actor_id")],
        reason_codes: REASONS_DEATHBLOW,
    },
    rust GeneSample {
        verb: "gene-sample",
        aliases: &["sample-flora"],
        doc: "Sample a deterministic wild-flora landrace seed of a crop species with the Gene Sampler.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("species", true, "crop_species_id")],
        reason_codes: REASONS_BIO,
    },
    rust ScanGenome {
        verb: "scan-genome",
        aliases: &["scan-seed"],
        doc: "Reveal a seed's genome with the Genome Scanner; depth is gated by the Sequencing track.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("container", true, "inventory_container_id"), id_arg("stack_id", true, "inventory_stack_id"), int_arg("variant_id", true)],
        reason_codes: REASONS_BIO,
    },
    rust SpliceBegin {
        verb: "splice-begin",
        aliases: EMPTY,
        doc: "Open a splice session for a crop species at a Splice Bench (Bio-Engineer).",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("species", true, "crop_species_id")],
        reason_codes: REASONS_BIO,
    },
    rust SpliceAssignSlot {
        verb: "splice-assign-slot",
        aliases: EMPTY,
        doc: "Assign a parent seed (slots 0-1) or a reagent (slots 2-5) to the splice session.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[int_arg("slot_index", true), id_arg("container", true, "inventory_container_id"), id_arg("stack_id", true, "inventory_stack_id"), int_arg("variant_id", true)],
        reason_codes: REASONS_BIO,
    },
    rust SpliceClearSlot {
        verb: "splice-clear-slot",
        aliases: EMPTY,
        doc: "Clear a splice session slot before assembly.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[int_arg("slot_index", true)],
        reason_codes: REASONS_BIO,
    },
    rust SpliceChooseAllele {
        verb: "splice-choose-allele",
        aliases: EMPTY,
        doc: "Directed segregation choice: pick which allele (0/1) to take from a parent (0/1) at a locus.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[int_arg("locus", true), int_arg("from_parent", true), int_arg("allele", true)],
        reason_codes: REASONS_BIO,
    },
    rust SpliceAssemble {
        verb: "splice-assemble",
        aliases: EMPTY,
        doc: "Consume parents + reagents and compute deterministic per-locus base/cap lines (point of no return).",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: Some(DurableIntent { kind: "point_of_no_return", when: "accepted", notes: "Accepted assembly consumes the assigned parent seeds and reagents; later cancel is lossy." }),
        args: &[],
        reason_codes: REASONS_BIO,
    },
    rust SpliceExperimentLocus {
        verb: "splice-experiment-locus",
        aliases: EMPTY,
        doc: "Spend experimentation points to lift one assembled locus deterministically toward its cap.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[int_arg("locus", true), int_arg("points", true)],
        reason_codes: REASONS_BIO,
    },
    rust SpliceMint {
        verb: "splice-mint",
        aliases: EMPTY,
        doc: "Intern the child genome into the registry and hand the breeder the new seed handle.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[nullable_id_arg("cultivar_name", false, "cultivar_name")],
        reason_codes: REASONS_BIO,
    },
    rust SpliceCancel {
        verb: "splice-cancel",
        aliases: EMPTY,
        doc: "Cancel the active splice session; after assembly the consumed inputs are not returned.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[],
        reason_codes: REASONS_BIO,
    },
    rust ClaimParcel {
        verb: "claim-parcel",
        aliases: &["claim"],
        doc: "Stake a mini-mayor land claim (max 2 globally per character); spends wallet credits at a Land Registry terminal.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: Some(DurableIntent { kind: "placed_parcel", when: "accepted", notes: "Each accepted claim persists a server-owned parcel until abandoned; a character may hold at most two globally." }),
        args: &[id_arg("planet_id", true, "planet_id"), id_arg("area_id", true, "area_id"), int_arg("x", true), int_arg("y", true), enum_arg("tier", true, PARCEL_TIERS)],
        reason_codes: REASONS_CLAIM_PARCEL,
    },
    rust AbandonParcel {
        verb: "abandon-parcel",
        aliases: &["abandon"],
        doc: "Release an owned parcel; returns placed structure items, crops are lost. Frees one global claim slot.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("parcel_id", true, "parcel_id")],
        reason_codes: REASONS_PARCEL_OWNED,
    },
    rust RenameParcel {
        verb: "rename-parcel",
        aliases: EMPTY,
        doc: "Rename an owned parcel (owner-only cosmetic).",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("parcel_id", true, "parcel_id"), id_arg("name", true, "parcel_label")],
        reason_codes: REASONS_PARCEL_OWNED,
    },
    rust PayUpkeep {
        verb: "pay-upkeep",
        aliases: &["upkeep"],
        doc: "Pay light periodic credit upkeep on an owned parcel; lapse pauses the farm, never confiscates.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("parcel_id", true, "parcel_id")],
        reason_codes: REASONS_PAY_UPKEEP,
    },
    rust TillTile {
        verb: "till",
        aliases: &["till-tile"],
        doc: "Hoe a farm-yard cell into tillable soil.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("parcel_id", true, "parcel_id"), int_arg("cell_x", true), int_arg("cell_y", true)],
        reason_codes: REASONS_TILL_TILE,
    },
    rust PlantSeed {
        verb: "plant",
        aliases: &["plant-seed"],
        doc: "Plant one seed on a tilled tile; caches the projected AgronomicProfile (seed->soil boundary).",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("parcel_id", true, "parcel_id"), int_arg("cell_x", true), int_arg("cell_y", true), id_arg("container", true, "inventory_container_id"), id_arg("stack_id", true, "inventory_stack_id"), int_arg("variant_id", true)],
        reason_codes: REASONS_PLANT_SEED,
    },
    rust ClearTile {
        verb: "clear-tile",
        aliases: &["clear"],
        doc: "Scythe a tile: remove its crop, keep the soil tilled (dry).",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("parcel_id", true, "parcel_id"), int_arg("cell_x", true), int_arg("cell_y", true)],
        reason_codes: REASONS_TILE_WORK,
    },
    rust WaterTile {
        verb: "water",
        aliases: &["water-tile"],
        doc: "Water a tile: settle growth to now, then refill moisture and revive a dormant crop from saved progress.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("parcel_id", true, "parcel_id"), int_arg("cell_x", true), int_arg("cell_y", true)],
        reason_codes: REASONS_TILE_WORK,
    },
    rust TendPlot {
        verb: "tend",
        aliases: &["tend-plot", "stop-tend"],
        doc: "Kneel and auto-tend the plot on a cadence (waters dry tiles, settles growth) until you move/stand/leave; stop=true cancels.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: Some(DurableIntent { kind: "plot_tending", when: "accepted stop=false", notes: "Accepted tending repeats server-side every cadence until movement, stand, area change, death, loss of ownership, or stop=true." }),
        args: &[id_arg("parcel_id", true, "parcel_id"), defaulted_enum_arg("stop", false, BOOL, "false")],
        reason_codes: REASONS_TEND_PLOT,
    },
    rust PlaceFarmStructure {
        verb: "place-farm-structure",
        aliases: &["place-structure"],
        doc: "Place a farm structure (W3: irrigation sprinkler) inside a parcel; consumes the 6_3xx item.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("parcel_id", true, "parcel_id"), id_arg("structure_item_id", true, "item_numeric_id"), int_arg("cell_x", true), int_arg("cell_y", true)],
        reason_codes: REASONS_PLACE_FARM_STRUCTURE,
    },
    rust RemoveFarmStructure {
        verb: "remove-farm-structure",
        aliases: &["remove-structure"],
        doc: "Remove an owned parcel's farm structure; returns the item.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("parcel_id", true, "parcel_id"), id_arg("structure_id", true, "farm_structure_id")],
        reason_codes: REASONS_REMOVE_FARM_STRUCTURE,
    },
    rust BuildPlace {
        verb: "build-place",
        aliases: &[],
        doc: "Place a catalogued one-level building component inside an owned parcel build zone.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("catalog_id", true, "build_catalog_id"), id_arg("parcel_id", true, "parcel_id"), int_arg("cell_x", true), int_arg("cell_y", true), int_arg("rotation_quarters", true)],
        reason_codes: REASONS_BUILD_PLACE,
    },
    rust BuildRemove {
        verb: "build-remove",
        aliases: &[],
        doc: "Remove an owned building component and return its deterministic salvage.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("component_id", true, "build_component_id")],
        reason_codes: REASONS_BUILD_REMOVE,
    },
    rust BuildToggleDoor {
        verb: "build-toggle-door",
        aliases: &[],
        doc: "Toggle an owned sliding building door between open and closed states.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("component_id", true, "build_component_id")],
        reason_codes: REASONS_BUILD_TOGGLE_DOOR,
    },


    rust Fertilize {
        verb: "fertilize",
        aliases: &["fertilise"],
        doc: "Apply one soil amendment (speed/quality/yield) to a tilled tile; one kind per tile, consumes the fertilizer item.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("parcel_id", true, "parcel_id"), int_arg("cell_x", true), int_arg("cell_y", true), id_arg("container", true, "inventory_container_id"), id_arg("stack_id", true, "inventory_stack_id"), int_arg("variant_id", true)],
        reason_codes: REASONS_FERTILIZE,
    },
    rust HarvestCrop {
        verb: "reap",
        aliases: &["harvest-crop"],
        doc: "Harvest a mature crop: mint produce + offspring seeds (mint_harvest_seed; sterile => none) + regrowth reset or clear to tilled.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("parcel_id", true, "parcel_id"), int_arg("cell_x", true), int_arg("cell_y", true)],
        reason_codes: REASONS_HARVEST_CROP,
    },
    rust GuildCreate {
        verb: "guild-create",
        aliases: &["create-guild"],
        doc: "Create a guild at the player's authorized public-affairs terminal.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[text_arg("name", true, None), text_arg("tag", true, None), id_arg("terminal_prop_id", true, "prop_id")],
        reason_codes: REASONS_GUILD,
    },
    rust GuildInvite {
        verb: "guild-invite",
        aliases: &["invite-guild"],
        doc: "Invite another actor to join the player's guild.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("target_actor_id", true, "actor_id")],
        reason_codes: REASONS_GUILD,
    },
    rust GuildAcceptInvite {
        verb: "guild-accept-invite",
        aliases: &["accept-guild-invite"],
        doc: "Accept a pending guild invitation.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("invite_id", true, "guild_invite_id")],
        reason_codes: REASONS_GUILD,
    },
    rust GuildDeclineInvite {
        verb: "guild-decline-invite",
        aliases: &["decline-guild-invite"],
        doc: "Decline a pending guild invitation.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("invite_id", true, "guild_invite_id")],
        reason_codes: REASONS_GUILD,
    },
    rust GuildLeave {
        verb: "guild-leave",
        aliases: &["leave-guild"],
        doc: "Leave the player's current guild.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[],
        reason_codes: REASONS_GUILD,
    },
    rust GuildKick {
        verb: "guild-kick",
        aliases: &["kick-guild-member"],
        doc: "Remove a target member from the player's guild.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("target_actor_id", true, "actor_id")],
        reason_codes: REASONS_GUILD,
    },
    rust GuildSetRole {
        verb: "guild-set-role",
        aliases: &["set-guild-role"],
        doc: "Set a guild member's role.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("target_actor_id", true, "actor_id"), enum_arg("role", true, GUILD_ROLES)],
        reason_codes: REASONS_GUILD,
    },
    rust GuildSetPermissions {
        verb: "guild-set-permissions",
        aliases: &["set-guild-permissions"],
        doc: "Set a guild member's permission bit mask.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("target_actor_id", true, "actor_id"), int_arg("permissions", true)],
        reason_codes: REASONS_GUILD,
    },
    rust GuildTransferLeadership {
        verb: "guild-transfer-leadership",
        aliases: &["transfer-guild-leadership"],
        doc: "Transfer guild leadership to another member.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("target_actor_id", true, "actor_id")],
        reason_codes: REASONS_GUILD,
    },
    rust GuildDeclareWar {
        verb: "guild-declare-war",
        aliases: &["declare-guild-war"],
        doc: "Declare war on another guild.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("opposing_guild_id", true, "guild_id")],
        reason_codes: REASONS_GUILD,
    },
    rust GuildAcceptWar {
        verb: "guild-accept-war",
        aliases: &["accept-guild-war"],
        doc: "Accept an incoming guild war request.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("opposing_guild_id", true, "guild_id")],
        reason_codes: REASONS_GUILD,
    },
    rust GuildRescindWar {
        verb: "guild-rescind-war",
        aliases: &["rescind-guild-war"],
        doc: "Rescind an outgoing guild war request.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[id_arg("opposing_guild_id", true, "guild_id")],
        reason_codes: REASONS_GUILD,
    },
    rust GuildDisband {
        verb: "guild-disband",
        aliases: &["disband-guild"],
        doc: "Disband the player's guild.",
        budget_class: "authority",
        debug_gated: false,
        durable_intent: None,
        args: &[],
        reason_codes: REASONS_GUILD,
    },
}

pub fn client_command_kind_for_manifest(command: &ClientCommand) -> &'static str {
    match command {
        ClientCommand::Move { .. } => "Move",
        ClientCommand::SetMoveIntent { .. } => "SetMoveIntent",
        ClientCommand::QueueCombatAction { .. } => "QueueCombatAction",
        ClientCommand::Peace { .. } => "Peace",
        ClientCommand::CancelAbilityQueue { .. } => "CancelAbilityQueue",
        ClientCommand::ReloadWeapon { .. } => "ReloadWeapon",
        ClientCommand::SetEquippedWeapon { .. } => "SetEquippedWeapon",
        ClientCommand::SetEquippedClothing { .. } => "SetEquippedClothing",
        ClientCommand::DebugGiveItem { .. } => "DebugGiveItem",
        ClientCommand::DebugGrantSkillBoxes { .. } => "DebugGrantSkillBoxes",
        ClientCommand::EnterTransition { .. } => "EnterTransition",
        ClientCommand::UseConsumable { .. } => "UseConsumable",
        ClientCommand::RefillAmmo { .. } => "RefillAmmo",
        ClientCommand::ApplyServiceBuff { .. } => "ApplyServiceBuff",
        ClientCommand::CloneRespawn { .. } => "CloneRespawn",
        ClientCommand::ReviveActor { .. } => "ReviveActor",
        ClientCommand::BankStoreItem { .. } => "BankStoreItem",
        ClientCommand::BankRetrieveItem { .. } => "BankRetrieveItem",
        ClientCommand::BankDepositCredits { .. } => "BankDepositCredits",
        ClientCommand::BankWithdrawCredits { .. } => "BankWithdrawCredits",
        ClientCommand::CloneSaveSkillBackup {} => "CloneSaveSkillBackup",
        ClientCommand::CorpseTakeCredits { .. } => "CorpseTakeCredits",
        ClientCommand::SetPosture { .. } => "SetPosture",
        ClientCommand::SampleResource { .. } => "SampleResource",
        ClientCommand::SurveyResource { .. } => "SurveyResource",
        ClientCommand::PlaceExtractor { .. } => "PlaceExtractor",
        ClientCommand::CrankExtractor { .. } => "CrankExtractor",
        ClientCommand::StopCrank { .. } => "StopCrank",
        ClientCommand::InsertBattery { .. } => "InsertBattery",
        ClientCommand::CollectExtractor { .. } => "CollectExtractor",
        ClientCommand::DestroyExtractor { .. } => "DestroyExtractor",
        ClientCommand::PlaceCamp { .. } => "PlaceCamp",
        ClientCommand::PackUpCamp { .. } => "PackUpCamp",
        ClientCommand::DiscardStack { .. } => "DiscardStack",
        ClientCommand::SplitStack { .. } => "SplitStack",
        ClientCommand::MergeStacks { .. } => "MergeStacks",
        ClientCommand::RedeemCreditChip { .. } => "RedeemCreditChip",
        ClientCommand::HarvestCorpse { .. } => "HarvestCorpse",
        ClientCommand::TakeLootItem { .. } => "TakeLootItem",
        ClientCommand::CraftItem { .. } => "CraftItem",
        ClientCommand::CraftBegin { .. } => "CraftBegin",
        ClientCommand::CraftAssignSlot { .. } => "CraftAssignSlot",
        ClientCommand::CraftClearSlot { .. } => "CraftClearSlot",
        ClientCommand::CraftAssemble { .. } => "CraftAssemble",
        ClientCommand::CraftExperiment { .. } => "CraftExperiment",
        ClientCommand::CraftFinalizePrototype { .. } => "CraftFinalizePrototype",
        ClientCommand::CraftFinalizePractice {} => "CraftFinalizePractice",
        ClientCommand::CraftDraftSchematic { .. } => "CraftDraftSchematic",
        ClientCommand::FactoryManufacture { .. } => "FactoryManufacture",
        ClientCommand::CraftCancel { .. } => "CraftCancel",
        ClientCommand::RequestStarterTool { .. } => "RequestStarterTool",
        ClientCommand::PurchaseSkillBox { .. } => "PurchaseSkillBox",
        ClientCommand::UnlearnSkillBox { .. } => "UnlearnSkillBox",
        ClientCommand::SetProfessionTitle { .. } => "SetProfessionTitle",
        ClientCommand::SetCareerGoal { .. } => "SetCareerGoal",
        ClientCommand::StoreToExchange { .. } => "StoreToExchange",
        ClientCommand::RetrieveFromExchange { .. } => "RetrieveFromExchange",
        ClientCommand::ProposeTrade { .. } => "ProposeTrade",
        ClientCommand::AcceptTrade { .. } => "AcceptTrade",
        ClientCommand::DeclineTrade { .. } => "DeclineTrade",
        ClientCommand::AddTradeItem { .. } => "AddTradeItem",
        ClientCommand::RemoveTradeItem { .. } => "RemoveTradeItem",
        ClientCommand::SetTradeCoin { .. } => "SetTradeCoin",
        ClientCommand::ConfirmTrade { .. } => "ConfirmTrade",
        ClientCommand::GroupInvite { .. } => "GroupInvite",
        ClientCommand::GroupAccept { .. } => "GroupAccept",
        ClientCommand::GroupDecline { .. } => "GroupDecline",
        ClientCommand::GroupLeave { .. } => "GroupLeave",
        ClientCommand::GroupDisband { .. } => "GroupDisband",
        ClientCommand::GroupKick { .. } => "GroupKick",
        ClientCommand::DuelChallenge { .. } => "DuelChallenge",
        ClientCommand::Deathblow { .. } => "Deathblow",
        ClientCommand::DuelAccept { .. } => "DuelAccept",
        ClientCommand::DuelDecline { .. } => "DuelDecline",
        ClientCommand::DuelYield { .. } => "DuelYield",
        ClientCommand::GeneSample { .. } => "GeneSample",
        ClientCommand::ScanGenome { .. } => "ScanGenome",
        ClientCommand::SpliceBegin { .. } => "SpliceBegin",
        ClientCommand::SpliceAssignSlot { .. } => "SpliceAssignSlot",
        ClientCommand::SpliceClearSlot { .. } => "SpliceClearSlot",
        ClientCommand::SpliceChooseAllele { .. } => "SpliceChooseAllele",
        ClientCommand::SpliceAssemble { .. } => "SpliceAssemble",
        ClientCommand::SpliceExperimentLocus { .. } => "SpliceExperimentLocus",
        ClientCommand::SpliceMint { .. } => "SpliceMint",
        ClientCommand::SpliceCancel { .. } => "SpliceCancel",
        ClientCommand::ClaimParcel { .. } => "ClaimParcel",
        ClientCommand::AbandonParcel { .. } => "AbandonParcel",
        ClientCommand::RenameParcel { .. } => "RenameParcel",
        ClientCommand::PayUpkeep { .. } => "PayUpkeep",
        ClientCommand::TillTile { .. } => "TillTile",
        ClientCommand::PlantSeed { .. } => "PlantSeed",
        ClientCommand::ClearTile { .. } => "ClearTile",
        ClientCommand::WaterTile { .. } => "WaterTile",
        ClientCommand::TendPlot { .. } => "TendPlot",
        ClientCommand::PlaceFarmStructure { .. } => "PlaceFarmStructure",
        ClientCommand::RemoveFarmStructure { .. } => "RemoveFarmStructure",
        ClientCommand::BuildPlace { .. } => "BuildPlace",
        ClientCommand::BuildRemove { .. } => "BuildRemove",
        ClientCommand::BuildToggleDoor { .. } => "BuildToggleDoor",
        ClientCommand::Fertilize { .. } => "Fertilize",
        ClientCommand::GuildCreate { .. } => "GuildCreate",
        ClientCommand::GuildInvite { .. } => "GuildInvite",
        ClientCommand::GuildAcceptInvite { .. } => "GuildAcceptInvite",
        ClientCommand::GuildDeclineInvite { .. } => "GuildDeclineInvite",
        ClientCommand::GuildLeave { .. } => "GuildLeave",
        ClientCommand::GuildKick { .. } => "GuildKick",
        ClientCommand::GuildSetRole { .. } => "GuildSetRole",
        ClientCommand::GuildSetPermissions { .. } => "GuildSetPermissions",
        ClientCommand::GuildTransferLeadership { .. } => "GuildTransferLeadership",
        ClientCommand::GuildDeclareWar { .. } => "GuildDeclareWar",
        ClientCommand::GuildAcceptWar { .. } => "GuildAcceptWar",
        ClientCommand::GuildRescindWar { .. } => "GuildRescindWar",
        ClientCommand::GuildDisband { .. } => "GuildDisband",
        ClientCommand::HarvestCrop { .. } => "HarvestCrop",
        ClientCommand::PurchaseTravelTicket { .. } => "PurchaseTravelTicket",
        ClientCommand::UseTravelTicket { .. } => "UseTravelTicket",
        ClientCommand::ToggleDoor { .. } => "ToggleDoor",
    }
}

pub fn command_manifest() -> CommandManifest {
    CommandManifest {
        schema: COMMAND_MANIFEST_SCHEMA,
        source: "crates/successor-sim command_manifest over successor_net::ClientCommand plus current TypeScript authority wire commands",
        regeneration_command: COMMAND_MANIFEST_REGEN_COMMAND,
        command_count: COMMANDS.len(),
        rust_command_count: COMMANDS
            .iter()
            .filter(|command| command.source == RUST_COMMAND_SOURCE)
            .count(),
        debug_gated_count: COMMANDS.iter().filter(|command| command.debug_gated).count(),
        commands: COMMANDS,
    }
}

pub fn command_manifest_json_pretty() -> serde_json::Result<String> {
    serde_json::to_string_pretty(&command_manifest())
}

fn is_empty_str_slice(values: &&[&str]) -> bool {
    values.is_empty()
}

fn is_false(value: &bool) -> bool {
    !*value
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use successor_net::{AuthorityAmmoTypeId, AuthorityWeaponId, CardinalDirection, TradeItemSpec};

    #[test]
    fn command_manifest_golden_shape_covers_sp0_keystones() {
        let manifest = command_manifest();
        assert_eq!(manifest.schema, COMMAND_MANIFEST_SCHEMA);
        assert_eq!(manifest.command_count, 117);
        assert_eq!(manifest.rust_command_count, 114);
        assert_eq!(manifest.debug_gated_count, 2);

        let cancel = command("CancelAbilityQueue");
        assert_eq!(cancel.verb, "cancel-queue");
        assert!(cancel
            .args
            .iter()
            .any(|arg| arg.name == "scope" && arg.enum_values == ABILITY_QUEUE_CANCEL_SCOPES));

        let debug = command("DebugGrantSkillBoxes");
        assert!(debug.debug_gated);
        assert_eq!(debug.budget_class, "authority-debug");
        assert!(debug
            .reason_codes
            .contains(&"debug_authority_command_disabled"));

        let queue = command("QueueCombatAction");
        assert_eq!(queue.verb, "attack");
        let durable = queue
            .durable_intent
            .expect("QueueCombatAction durable intent annotation");
        assert_eq!(durable.kind, "repeat_intent");
        assert!(durable.when.contains("basic_shot"));

        let json = command_manifest_json_pretty().expect("manifest serializes");
        assert!(json.contains("successor.commands.manifest.v1"));
        assert!(json.contains("DebugGrantSkillBoxes"));
        assert!(json.contains("id-domain"));
    }

    #[test]
    fn rust_client_command_enum_variants_are_reflected_in_manifest() {
        let mut reflected = BTreeSet::new();
        for command in sample_rust_client_commands() {
            reflected.insert(client_command_kind_for_manifest(&command));
        }
        assert_eq!(
            reflected.len(),
            114,
            "sample_rust_client_commands must cover every stable ClientCommand variant"
        );
        let manifest_kinds = COMMANDS
            .iter()
            .filter(|command| command.source == RUST_COMMAND_SOURCE)
            .map(|command| command.kind)
            .collect::<BTreeSet<_>>();
        assert_eq!(
            reflected, manifest_kinds,
            "sampled ClientCommand kinds and manifest rust rows drifted"
        );
        assert_eq!(reflected.len(), command_manifest().rust_command_count);
        for kind in reflected {
            let row = command(kind);
            assert_eq!(row.source, RUST_COMMAND_SOURCE);
        }
    }

    #[test]
    fn every_rust_client_command_round_trips_through_the_bridge_input_enum() {
        // DEF-8 systemic gate (bridge hop): every ClientCommand the manifest
        // advertises must deserialize through the real (untagged)
        // AuthorityBridgeCommandInput used on the LIVE JSON bridge path. The bug
        // this ends: the input enum stopped at DuelYield, leaving bio 80-89 + farm
        // 69-79 bridge-dead ("did not match any variant of untagged enum ...").
        // In-process apply_envelope tests fly below this layer; this test does not.
        for command in sample_rust_client_commands() {
            let kind = client_command_kind_for_manifest(&command);
            let json = serde_json::to_value(&command)
                .unwrap_or_else(|error| panic!("serialize {kind}: {error}"));
            let parsed: Result<crate::authority_bridge::AuthorityBridgeCommandInput, _> =
                serde_json::from_value(json.clone());
            let parsed = parsed.unwrap_or_else(|error| {
                panic!(
                    "AuthorityBridgeCommandInput rejects {kind} on the live path: {json} ({error})"
                )
            });
            assert_eq!(
                parsed
                    .into_authority_command()
                    .unwrap_or_else(|error| panic!("convert {kind}: {error}")),
                command,
                "AuthorityBridgeCommandInput changed {kind} payload values"
            );
        }
    }

    #[test]
    fn manifest_rows_are_unique_and_reason_codes_are_snake_case() {
        let mut kinds = BTreeSet::new();
        let mut verbs = BTreeSet::new();
        // The WHOLE slash namespace (verbs + aliases) must be globally unique: the
        // client verb registry flattens verb+aliases into one map, so a collision
        // silently shadows (last-wins) one command. This gate reds on any overlap
        // (the HarvestCrop/HarvestCorpse "harvest" collision that slipped past a
        // verb-only check). No two commands may share ANY invocation token.
        let mut tokens: std::collections::BTreeMap<&'static str, &'static str> =
            std::collections::BTreeMap::new();
        for command in COMMANDS {
            for token in std::iter::once(command.verb).chain(command.aliases.iter().copied()) {
                if let Some(prev) = tokens.insert(token, command.kind) {
                    panic!(
                        "slash token {token:?} claimed by both {prev} and {} — verbs+aliases must be globally unique (no silent last-wins shadowing)",
                        command.kind
                    );
                }
            }
        }
        for command in COMMANDS {
            assert!(
                kinds.insert(command.kind),
                "duplicate command kind {}",
                command.kind
            );
            assert!(
                verbs.insert(command.verb),
                "duplicate command verb {}",
                command.verb
            );
            for reason_code in command.reason_codes {
                assert!(
                    is_snake_case(reason_code),
                    "{}/{} is not snake_case",
                    command.kind,
                    reason_code
                );
            }
        }
    }

    fn command(kind: &str) -> &'static CommandSpec {
        COMMANDS
            .iter()
            .find(|command| command.kind == kind)
            .unwrap_or_else(|| panic!("missing manifest command {kind}"))
    }

    fn is_snake_case(value: &str) -> bool {
        !value.is_empty()
            && value
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
            && !value.starts_with('_')
            && !value.ends_with('_')
            && !value.contains("__")
    }

    fn sample_rust_client_commands() -> Vec<ClientCommand> {
        vec![
            ClientCommand::Move {
                dx: 1,
                dy: 0,
                duration_ticks: 1,
                facing: Some(CardinalDirection::Right),
                sprint: false,
            },
            ClientCommand::SetMoveIntent {
                dx: 0,
                dy: 1,
                facing: Some(CardinalDirection::Front),
                sprint: true,
            },
            ClientCommand::QueueCombatAction {
                action_id: "basic_shot".to_owned(),
                target_actor_id: "target".to_owned(),
            },
            ClientCommand::Peace {},
            ClientCommand::CancelAbilityQueue {
                queue_entry_id: Some("1".to_owned()),
                scope: Some("owner_repeat".to_owned()),
            },
            ClientCommand::ReloadWeapon {
                weapon_id: Some(AuthorityWeaponId::Slugthrower),
                ammo_type: Some(AuthorityAmmoTypeId::SlugIron),
            },
            ClientCommand::SetEquippedWeapon {
                weapon_id: Some(AuthorityWeaponId::Vibrosword),
                weapon_item_id: Some(3_103),
                weapon_variant_id: None,
            },
            ClientCommand::SetEquippedClothing {
                item_id: 7_301,
                equipped: true,
                container: None,
                stack_id: None,
                variant_id: None,
            },
            ClientCommand::DebugGiveItem {
                item_id: 1_001,
                variant_id: 0,
                quantity: 1,
                equip: false,
            },
            ClientCommand::DebugGrantSkillBoxes {
                skill_box_ids: vec!["marksman_novice".to_owned()],
            },
            ClientCommand::EnterTransition {
                transition_id: "door-a".to_owned(),
            },
            ClientCommand::UseConsumable {
                item_id: "stimpak_a".to_owned(),
                item_numeric_id: Some(1_001),
                variant_id: Some(0),
            },
            ClientCommand::RefillAmmo {
                item_id: "ammo".to_owned(),
            },
            ClientCommand::ApplyServiceBuff {
                effect_id: "buff_medic".to_owned(),
            },
            ClientCommand::CloneRespawn { facility_id: None },
            ClientCommand::ReviveActor {
                target_actor_id: "target".to_owned(),
            },
            ClientCommand::SetPosture {
                posture: "kneel".to_owned(),
            },
            ClientCommand::SampleResource {
                family: "iron".to_owned(),
                stop: false,
            },
            ClientCommand::SurveyResource {
                family: "iron".to_owned(),
            },
            ClientCommand::PlaceExtractor {
                family: "iron".to_owned(),
            },
            ClientCommand::CrankExtractor {
                extractor_id: "extractor:player:1".to_owned(),
            },
            ClientCommand::StopCrank {},
            ClientCommand::InsertBattery {
                extractor_id: "extractor:player:1".to_owned(),
                container: "player:field-pack".to_owned(),
                stack_id: "1".to_owned(),
                variant_id: 32_000_060,
            },
            ClientCommand::CollectExtractor {
                extractor_id: "extractor:player:1".to_owned(),
            },
            ClientCommand::DestroyExtractor {
                extractor_id: "extractor:player:1".to_owned(),
            },
            ClientCommand::PlaceCamp {},
            ClientCommand::PackUpCamp {},
            ClientCommand::DiscardStack {
                container: "inventory".to_owned(),
                stack_id: "1".to_owned(),
                item_id: 2_001,
                variant_id: 0,
            },
            ClientCommand::SplitStack {
                container: "inventory".to_owned(),
                stack_id: "1".to_owned(),
                item_id: 2_001,
                variant_id: 0,
                quantity: 1,
            },
            ClientCommand::MergeStacks {
                container: "inventory".to_owned(),
                source_stack_id: "1".to_owned(),
                target_stack_id: "2".to_owned(),
            },
            ClientCommand::RedeemCreditChip {
                container: "inventory".to_owned(),
                stack_id: "1".to_owned(),
            },
            ClientCommand::HarvestCorpse {
                target_actor_id: "corpse".to_owned(),
            },
            ClientCommand::TakeLootItem {
                container: "corpse:target".to_owned(),
                item_id: 2_101,
                variant_id: 0,
                quantity: 1,
            },
            ClientCommand::CraftItem {
                schematic_id: "field_bandage".to_owned(),
                experiment_power: 0,
                experiment_handling: 0,
                experiment_reliability: 0,
            },
            ClientCommand::PurchaseSkillBox {
                skill_box_id: "marksman_novice".to_owned(),
                trainer_actor_id: "trainer".to_owned(),
            },
            ClientCommand::UnlearnSkillBox {
                skill_box_id: "marksman_novice".to_owned(),
                trainer_actor_id: "trainer".to_owned(),
            },
            ClientCommand::SetProfessionTitle {
                title_id: Some("marksman".to_owned()),
            },
            ClientCommand::SetCareerGoal {
                goal_id: "marksman_master".to_owned(),
                trainer_actor_id: "trainer".to_owned(),
            },
            ClientCommand::StoreToExchange {
                item_id: 2_001,
                variant_id: 0,
                quantity: 1,
            },
            ClientCommand::RetrieveFromExchange {
                item_id: 2_001,
                variant_id: 0,
                quantity: 1,
            },
            ClientCommand::ProposeTrade {
                partner_actor_id: "partner".to_owned(),
                offer: vec![TradeItemSpec {
                    item_id: 2_001,
                    variant_id: 0,
                    quantity: 1,
                }],
                request: vec![],
            },
            ClientCommand::AcceptTrade { proposal_id: 1 },
            ClientCommand::DeclineTrade { proposal_id: 1 },
            ClientCommand::AddTradeItem {
                proposal_id: 1,
                item: TradeItemSpec {
                    item_id: 2_001,
                    variant_id: 0,
                    quantity: 1,
                },
            },
            ClientCommand::RemoveTradeItem {
                proposal_id: 1,
                item: TradeItemSpec {
                    item_id: 2_001,
                    variant_id: 0,
                    quantity: 1,
                },
            },
            ClientCommand::SetTradeCoin {
                proposal_id: 1,
                amount: 250,
            },
            ClientCommand::ConfirmTrade { proposal_id: 1 },
            ClientCommand::CraftBegin {
                recipe_id: "field_bandage".to_owned(),
            },
            ClientCommand::CraftAssignSlot {
                slot_index: 0,
                container: "player:field-pack".to_owned(),
                stack_id: "1".to_owned(),
                variant_id: 0,
            },
            ClientCommand::CraftClearSlot { slot_index: 0 },
            ClientCommand::CraftAssemble {},
            ClientCommand::CraftExperiment {
                line_id: 0,
                points: 1,
            },
            ClientCommand::CraftFinalizePrototype {
                custom_name: String::new(),
            },
            ClientCommand::CraftDraftSchematic { max_uses: 10 },
            ClientCommand::FactoryManufacture {
                factory_id: "dustgate-occupation-workbench".to_owned(),
                schematic_id: "draft:player:1".to_owned(),
            },
            ClientCommand::CraftCancel {},
            ClientCommand::RequestStarterTool {
                trainer_actor_id: "trainer".to_owned(),
            },
            ClientCommand::GroupInvite {
                target_actor_id: "p2".to_owned(),
            },
            ClientCommand::GroupAccept {},
            ClientCommand::GroupDecline {},
            ClientCommand::GroupLeave {},
            ClientCommand::GroupDisband {},
            ClientCommand::GroupKick {
                target_actor_id: "p2".to_owned(),
            },
            ClientCommand::DuelChallenge {
                target_actor_id: "p2".to_owned(),
            },
            ClientCommand::DuelAccept {},
            ClientCommand::DuelDecline {},
            ClientCommand::DuelYield {},
            ClientCommand::Deathblow {
                target_actor_id: "p2".to_owned(),
            },
            ClientCommand::GeneSample {
                species: "ashgrain".to_owned(),
            },
            ClientCommand::ScanGenome {
                container: "player:field-pack".to_owned(),
                stack_id: "1".to_owned(),
                variant_id: 1,
            },
            ClientCommand::SpliceBegin {
                species: "ashgrain".to_owned(),
            },
            ClientCommand::SpliceAssignSlot {
                slot_index: 0,
                container: "player:field-pack".to_owned(),
                stack_id: "1".to_owned(),
                variant_id: 1,
            },
            ClientCommand::SpliceClearSlot { slot_index: 0 },
            ClientCommand::SpliceChooseAllele {
                locus: 0,
                from_parent: 0,
                allele: 1,
            },
            ClientCommand::SpliceAssemble {},
            ClientCommand::SpliceExperimentLocus {
                locus: 0,
                points: 4,
            },
            ClientCommand::SpliceMint {
                cultivar_name: Some("Kestrel".to_owned()),
            },
            ClientCommand::SpliceCancel {},
            ClientCommand::ClaimParcel {
                planet_id: "planet-a".to_owned(),
                area_id: "open-desert".to_owned(),
                x: 10,
                y: 12,
                tier: "homestead".to_owned(),
            },
            ClientCommand::AbandonParcel {
                parcel_id: "parcel:planet-a:1".to_owned(),
            },
            ClientCommand::RenameParcel {
                parcel_id: "parcel:planet-a:1".to_owned(),
                name: "Test Parcel".to_owned(),
            },
            ClientCommand::PayUpkeep {
                parcel_id: "parcel:planet-a:1".to_owned(),
            },
            ClientCommand::TillTile {
                parcel_id: "parcel:planet-a:1".to_owned(),
                cell_x: 3,
                cell_y: 4,
            },
            ClientCommand::PlantSeed {
                parcel_id: "parcel:planet-a:1".to_owned(),
                cell_x: 3,
                cell_y: 4,
                container: "player:field-pack".to_owned(),
                stack_id: "1".to_owned(),
                variant_id: 0,
            },
            ClientCommand::ClearTile {
                parcel_id: "parcel:planet-a:1".to_owned(),
                cell_x: 3,
                cell_y: 4,
            },
            ClientCommand::WaterTile {
                parcel_id: "parcel:planet-a:1".to_owned(),
                cell_x: 3,
                cell_y: 4,
            },
            ClientCommand::TendPlot {
                parcel_id: "parcel:planet-a:1".to_owned(),
                stop: false,
            },
            ClientCommand::PlaceFarmStructure {
                parcel_id: "parcel:planet-a:1".to_owned(),
                structure_item_id: 6_301,
                cell_x: 3,
                cell_y: 4,
            },
            ClientCommand::RemoveFarmStructure {
                parcel_id: "parcel:planet-a:1".to_owned(),
                structure_id: "parcel:planet-a:1:struct:1".to_owned(),
            },
            ClientCommand::BuildPlace {
                catalog_id: "floor_1x1".to_owned(),
                parcel_id: "parcel:planet-a:1".to_owned(),
                cell_x: 3,
                cell_y: 4,
                rotation_quarters: 1,
                palette: Some(successor_net::BuildPalette {
                    primary: Some("#112233".to_owned()),
                    secondary: Some("#445566".to_owned()),
                    accent: Some("#778899".to_owned()),
                }),
            },
            ClientCommand::BuildRemove {
                component_id: "build:parcel:planet-a:1:1".to_owned(),
            },
            ClientCommand::BuildToggleDoor {
                component_id: "build:parcel:planet-a:1:2".to_owned(),
            },
            ClientCommand::Fertilize {
                parcel_id: "parcel:planet-a:1".to_owned(),
                cell_x: 3,
                cell_y: 4,
                container: "player:field-pack".to_owned(),
                stack_id: "1".to_owned(),
                variant_id: 0,
            },
            ClientCommand::HarvestCrop {
                parcel_id: "parcel:planet-a:1".to_owned(),
                cell_x: 3,
                cell_y: 4,
            },
            ClientCommand::GuildCreate {
                name: "Dust Cooperative".to_owned(),
                tag: "DUST".to_owned(),
                terminal_prop_id: "pa-terminal".to_owned(),
            },
            ClientCommand::GuildInvite {
                target_actor_id: "p2".to_owned(),
            },
            ClientCommand::GuildAcceptInvite {
                invite_id: "invite:1".to_owned(),
            },
            ClientCommand::GuildDeclineInvite {
                invite_id: "invite:2".to_owned(),
            },
            ClientCommand::GuildLeave {},
            ClientCommand::GuildKick {
                target_actor_id: "p2".to_owned(),
            },
            ClientCommand::GuildSetRole {
                target_actor_id: "p2".to_owned(),
                role: "officer".to_owned(),
            },
            ClientCommand::GuildSetPermissions {
                target_actor_id: "p2".to_owned(),
                permissions: 31,
            },
            ClientCommand::GuildTransferLeadership {
                target_actor_id: "p2".to_owned(),
            },
            ClientCommand::GuildDeclareWar {
                opposing_guild_id: "guild:2".to_owned(),
            },
            ClientCommand::GuildAcceptWar {
                opposing_guild_id: "guild:2".to_owned(),
            },
            ClientCommand::GuildRescindWar {
                opposing_guild_id: "guild:2".to_owned(),
            },
            ClientCommand::GuildDisband {},
            ClientCommand::CraftFinalizePractice {},
            ClientCommand::BankStoreItem {
                source_stack_id: "1".to_owned(),
                quantity: 1,
            },
            ClientCommand::BankRetrieveItem {
                bank_stack_id: "2".to_owned(),
                quantity: 1,
            },
            ClientCommand::BankDepositCredits { amount: 1 },
            ClientCommand::BankWithdrawCredits { amount: 1 },
            ClientCommand::CloneSaveSkillBackup {},
            ClientCommand::CorpseTakeCredits {
                corpse_id: "player-corpse:1".to_owned(),
            },
        ]
    }
}
