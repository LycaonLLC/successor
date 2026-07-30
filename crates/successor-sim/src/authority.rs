use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet};
use std::ops::{Deref, DerefMut};
#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant;

use serde::{Deserialize, Serialize};
use successor_core::{StateWriter, TickIndex};
use successor_net::{
    AuthorityAmmoTypeId, AuthorityWeaponId, CardinalDirection, ClientCommand,
    ClientCommandEnvelope, PayloadSchemaId, PlayerId, ServerCommandReceipt,
    ServerRejectedCommandReceipt, ServerTickDeliveryFrame, SessionId, SnapshotDeltaBundle,
    SnapshotDeltaSection, TradeItemSpec,
};
use thiserror::Error;

use crate::dialogue_corpus::BarkClaims;
use crate::{
    AreaSpec, AreaTransitionSnapshot, CellSizeSnapshot, CellSnapshot, CloneFacilitySnapshot,
    InventoryStackSnapshot, NpcJobSnapshot, PropSnapshot, ReservationSnapshot, SliceSnapshot,
    TimelineEventSnapshot,
};

use crate::combat_ai::{
    affordance::tactical_position_near_world_edge,
    behavior::{
        tactical_cover_needed, tactical_stage_order, TacticalCoverNeedRequest,
        TacticalEngagementPolicy, TacticalStageKind, TacticalStageOrderRequest,
    },
    debug::{
        authority_ai_actor_debug_snapshot, authority_ai_situation_debug_snapshot,
        authority_ai_squad_debug_snapshot, authority_ai_tactical_candidate_debug,
        current_order_tactical_candidate, no_tactical_candidates_debug,
        AuthorityAiActorDebugSnapshotRequest, AuthorityAiDebugPosition,
        AuthorityAiSquadDebugSnapshot, AuthorityAiSquadDebugSnapshotRequest,
        AuthorityAiTacticalCandidateDebug, AuthorityAiTacticalCandidateDebugRequest,
        SliceAuthorityAiDebugSnapshot,
    },
    executor::{
        clear_skirmisher_blocked_target_near, note_skirmisher_blocked_target,
        preserve_skirmisher_move_memory, record_skirmisher_move,
        reset_skirmisher_destination_progress, select_reachable_tactical_candidate,
        skirmisher_has_tactical_contact, skirmisher_target_recently_blocked,
        tactical_candidate_reachable, tactical_pressure_replan_due, NpcAiAttitude,
        SkirmisherAiState as CombatSkirmisherAiState, SkirmisherMode, TacticalExecutionCandidate,
        TacticalPressureReplanRequest,
    },
    fire_control::{
        consume_round_or_start_reload, reload_remaining_ticks, WeaponFireReadiness,
        WeaponMagazineProfile, WeaponMagazineState,
    },
    local_avoidance::{
        micro_reversal_blocked, select_avoidance_candidate, select_axis_slide_candidate,
        select_unstuck_candidate, MicroReversalRequest,
    },
    maneuver::{
        committed_evasion_step_milli, tactical_maneuver_step_milli, tactical_min_reposition_milli,
        TacticalManeuverRequest,
    },
    perception::{
        advance_line_candidates, cover_candidates, evasion_candidates, firing_lane_candidates,
        flank_candidates, project_tactical_position_milli, retreat_candidates,
        select_tactical_slot, TacticalAdvanceLineRequest, TacticalCandidate, TacticalCoverPoint,
        TacticalCoverRequest, TacticalCoverStage, TacticalDirection, TacticalEvasionRequest,
        TacticalFiringLaneRequest, TacticalFlankRequest, TacticalFormation, TacticalPoint,
        TacticalProjectionRequest, TacticalRangeProfile, TacticalRetreatRequest,
        TacticalSlotContext, TacticalSlotRequest,
    },
    scoring::{
        cover_score_for_tactical_candidate, cover_shadow_penalty_for_tactical_candidate,
        score_tactical_candidate, tactical_ally_spacing_penalty, tactical_candidate_bad_range,
        tactical_candidate_claimed, tactical_candidate_crosses_no_mans_land_for_stage,
        tactical_candidate_inside_lane_for_stage, tactical_candidate_open_for_live_probe,
        tactical_candidate_raw_shot_probe_open, tactical_candidate_should_probe_exposure,
        tactical_candidate_should_probe_protection, tactical_candidate_too_far,
        tactical_flank_value_milli, tactical_lane_error_milli,
        tactical_position_crosses_no_mans_land, tactical_position_inside_lane,
        tactical_stage_needs_lane_probe, tactical_stage_needs_no_mans_land_probe,
        TacticalAllySpacingPenaltyRequest, TacticalCandidateBadRangeRequest,
        TacticalCandidateClaimRequest, TacticalCandidateDistanceLimitRequest,
        TacticalCandidateOpenProbeRequest, TacticalCandidateRawShotProbeRequest,
        TacticalCandidateScoreRequest, TacticalCoverScoreRequest,
        TacticalCoverShadowPenaltyRequest, TacticalFlankValueRequest, TacticalLaneErrorRequest,
        TacticalNoMansLandRequest, TacticalPositionClaim,
    },
    situation::{
        assess_combat_situation, tactical_policy_for_combat_situation,
        tactical_situation_stage_score_bias, CombatSituationRequest, CombatSituationSnapshot,
        CombatSquadOrderHint,
    },
};
use crate::faction::{ActorFactionState, FactionRelationship, FactionTable};
use crate::navigation::{
    corridor_clear, direct_step_toward, find_cell_path, nav_move_precheck,
    nav_next_position_from_path, tactical_path_reversal_allowed, NavCell, NavMovePrecheck,
    NavMovePrecheckRequest, NavPathRequest, NavPosition,
};
mod actors;
mod ai;
mod combat_roll;
mod commands;
use self::combat_roll::*;
use self::commands::normalize_command_key;
mod camps;
pub use self::camps::*;
mod crafting;
mod economy;
mod trade;
pub use self::trade::*;
mod extraction_math;
mod extractors;
pub use self::extractors::*;
mod weapons;
use self::weapons::*;
mod banking;
mod building;
use self::building::*;
mod actor_state;
mod crafting_rules;
mod delta;
mod errors;
mod inventory;
mod progression;
mod replay;
mod resources;
mod snapshots;
mod spatial;
mod state_types;
pub use self::building::AuthorityBuildDeltaPayload;
pub use self::snapshots::{AuthorityCheckpointBlob, AuthorityCheckpointError};
mod guild;
pub use self::guild::AuthorityGuildViewSnapshot;
use self::guild::{AuthorityGuildsDeltaPayload, GuildAuthorityState, PendingGuildInvite};
mod groups;
pub use self::groups::{AuthorityGroupViewSnapshot, AuthorityGroupsDeltaPayload};
use self::groups::{GroupAuthorityState, PendingGroupInvite};
mod duels;
pub use self::duels::{AuthorityDuelOutcomeSnapshot, AuthorityDuelViewSnapshot};
use self::duels::{DuelAuthorityState, PendingDuelChallenge};
mod metrics;
pub(crate) use self::metrics::ExchangeMetricsStore;
pub use self::metrics::{
    AuthorityActiveExchangeSnapshot, AuthorityClosedExchangeSnapshot,
    AuthorityExchangeMetricsSnapshot, AuthorityExchangeTotalsSnapshot,
    AuthorityWeaponExchangeCounterSnapshot,
};
mod state;
mod tick_lifecycle;
pub use self::actor_state::*;
pub use self::crafting_rules::*;
pub use self::delta::*;
pub use self::errors::*;
use self::inventory::*;
pub use self::progression::*;
pub use self::replay::*;
pub use self::resources::*;
pub use self::spatial::*;
pub use self::state_types::*;
mod helpers;
use self::helpers::*;
mod genome;
use self::genome::*;
mod splice;
use self::splice::*;
pub use self::splice::{AuthorityGenomeScanSnapshot, AuthoritySpliceSessionSnapshot};
mod loot_tables;
#[cfg(test)]
use self::loot_tables::*;
mod live_probes;
mod movement;
mod population;
mod swept_circle;
use self::population::*;
mod farm_model;
mod tactical_bridge;
use self::farm_model::*;
pub use self::farm_model::{
    AuthorityFarmPlotSnapshot, AuthorityNoClaimZoneSnapshot, AuthorityParcelClaimSnapshot,
    AuthorityParcelSnapshot, NoDeadzoneAuditReport,
};
mod growth;
use self::growth::*;
mod farming;
mod land;

pub(crate) fn inventory_resource_stats_snapshot(
    item_id: u32,
    variant_id: u32,
) -> Option<AuthorityResourceStatsSnapshot> {
    self::resources::resource_stats_for_item_variant(item_id, variant_id).map(Into::into)
}

const AUTHORITY_SCHEMA: &str = "successor.authority.v1";
const AUTHORITY_PAYLOAD_SCHEMA: PayloadSchemaId = PayloadSchemaId(1);
const MAX_MOVE_DURATION_TICKS: u16 = 30;
#[cfg(test)]
const DEFAULT_AUTHORITY_TICK_RATE_HZ: u32 = 30;

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, Clone)]
struct AuthorityTimer(Instant);

#[cfg(not(target_arch = "wasm32"))]
impl AuthorityTimer {
    // Host-only telemetry timer for authority-tick duration metrics; gated out of
    // the wasm32 deterministic build. Not consulted inside the deterministic tick.
    #[allow(clippy::disallowed_methods)]
    fn start() -> Self {
        Self(Instant::now())
    }

    fn elapsed_us(&self) -> u64 {
        self.0.elapsed().as_micros().min(u128::from(u64::MAX)) as u64
    }
}

#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone)]
struct AuthorityTimer;

#[cfg(target_arch = "wasm32")]
impl AuthorityTimer {
    fn start() -> Self {
        Self
    }

    fn elapsed_us(&self) -> u64 {
        0
    }
}
// Headed-client movement is paced at 20 commands/s. On the 30Hz shard that
// is a two-tick Move envelope; sprinting changes distance (1.357 * 4.809 * 2/30
// = 0.435 cells per command) but not cooldown. Allow four already-paced moves
// to arrive in one transport/server hitch (issued at now, +2, +4, +6): that is
// 8 ticks / 267ms / ~1.74 base-sprint cells of bounded catch-up. Larger future
// bursts still clamp to `self.tick` and trip MoveCooldown instead of deleting
// rate validation.
const MAX_MOVE_ISSUED_AT_FUTURE_TICKS: u64 = 6;

const PLAYER_SPEED_MILLI_CELLS_PER_SECOND: i32 = 1_357;
const SPRINT_SPEED_MULTIPLIER_MILLI: i32 = 4_809;
const AGENT_PLAYER_MOVEMENT_MULTIPLIER_MIN_MILLI: i32 = 1_000;
const ROGUE_TROOPER_MOVEMENT_MULTIPLIER_CAP_MILLI: i32 = 900;
const SPRINT_ACTION_DRAIN_PER_SECOND: i32 = 10;

// ── SCOUT MOVEMENT TUNING SURFACE ───────────────────────────────────────────
// Scout owns movement (combat-doctrine.md §5). All three stats scale off the
// scout track skill-box COUNT (a track skill bonus of 50 per box: novice=1 box
// through master=6 boxes). Clustered here as felt-per-box magnitudes instead
// of the old inline `*4/5`, `*6/5`, `*2` arithmetic. Walk = traversal track;
// sprint speed + sprint efficiency = the sprinting track (one coherent bundle).
const SCOUT_MOVE_BONUS_PER_BOX_MILLI: i32 = 50; // track skill bonus granted per box
const SCOUT_WALK_SPEED_ADD_MILLI_PER_BOX: i32 = 40; // traversal: +4%/box -> +24% at master
const SCOUT_SPRINT_SPEED_ADD_MILLI_PER_BOX: i32 = 60; // sprinting: +6%/box -> +36% at master
                                                      // Sprint EFFICIENCY: Action-cost multiplier cut per sprint box. Re-sloped from
                                                      // the old -10%/box (which slammed the floor at sprinting-II, wasting III/IV) to
                                                      // -5%/box so the FULL sprinting climb pays off, reaching the floor at master.
const SCOUT_SPRINT_EFFICIENCY_CUT_MILLI_PER_BOX: i32 = 50; // sprinting: -5%/box
const SCOUT_SPRINT_EFFICIENCY_FLOOR_MILLI: i32 = 700; // cap: 30% cheaper sprint at master
const ACTION_REGEN_RATE_MULTIPLIER: i32 = 10;
const SPRINT_RECOVERY_REGEN_MULTIPLIER_MILLI: i32 = 800;
const SPRINT_REGEN_BLOCK_GRACE_TICKS: u64 = 6;
const MILLI_CELLS_PER_CELL: i32 = 1_000;
const DIAGONAL_MOVE_COMPONENT_MILLI: i64 = 707;
const AIM_VECTOR_SCALE_MILLI: i32 = 1_000;
const AUTHORITY_COMBAT_EVENT_SCHEMA: PayloadSchemaId = PayloadSchemaId(3);
const AUTHORITY_INVENTORY_SCHEMA: PayloadSchemaId = PayloadSchemaId(4);
const AUTHORITY_NPC_JOBS_SCHEMA: PayloadSchemaId = PayloadSchemaId(5);
const AUTHORITY_TIMELINE_EVENTS_SCHEMA: PayloadSchemaId = PayloadSchemaId(6);
const AUTHORITY_PLACED_EXTRACTORS_SCHEMA: PayloadSchemaId = PayloadSchemaId(7);
const AUTHORITY_CRAFT_SESSION_SCHEMA: PayloadSchemaId = PayloadSchemaId(9);
const AUTHORITY_DRAFTED_SCHEMATICS_SCHEMA: PayloadSchemaId = PayloadSchemaId(10);
const AUTHORITY_GUILDS_SCHEMA: PayloadSchemaId = PayloadSchemaId(15);
const AUTHORITY_GROUPS_SCHEMA: PayloadSchemaId = PayloadSchemaId(11);
const AUTHORITY_PLACED_CAMPS_SCHEMA: PayloadSchemaId = PayloadSchemaId(12);
const AUTHORITY_PARCELS_SCHEMA: PayloadSchemaId = PayloadSchemaId(13);
const AUTHORITY_FARM_PLOT_SCHEMA: PayloadSchemaId = PayloadSchemaId(14);
const AUTHORITY_BANK_SCHEMA: PayloadSchemaId = PayloadSchemaId(15);
const AUTHORITY_CORPSES_SCHEMA: PayloadSchemaId = PayloadSchemaId(16);
const AUTHORITY_BUILDING_SCHEMA: PayloadSchemaId = PayloadSchemaId(17);
const SLUGTHROWER_RELOAD_MS: u64 = 2_000;
const SLUGTHROWER_MAGAZINE_SIZE: u32 = 30;
const SLUGTHROWER_BASE_SPREAD_DEGREES_MILLI: i32 = 350;
const SLUGTHROWER_RECOIL_PER_SHOT_MILLI: i32 = 1_150;
const SLUGTHROWER_RECOIL_MAX_MILLI: i32 = 7_000;
const SLUGTHROWER_RECOIL_DECAY_MILLI_PER_SECOND: i32 = 3_400;
const SLUGTHROWER_RECOIL_SPREAD_DEGREES_MILLI: i32 = 450;
const SLUGTHROWER_RECOIL_MAX_SPREAD_DEGREES_MILLI: i32 = 3_600;
// Roll-resolution tuning for the capacitor-and-throw-coil Slugthrower family.
const SLUGTHROWER_ROLL_ATTACK_SPEED_MS: u64 = 1_100;
const SLUGTHROWER_ROLL_DAMAGE_MIN: u32 = 9;
const SLUGTHROWER_ROLL_DAMAGE_MAX: u32 = 14;
const SLUGTHROWER_ROLL_POINT_BLANK_ACC: i32 = 60;
const SLUGTHROWER_ROLL_IDEAL_ACC: i32 = 45;
const SLUGTHROWER_ROLL_MAX_ACC: i32 = 15;
const SLUGTHROWER_ROLL_POINT_BLANK_RANGE_CELLS: i32 = 8;
const SLUGTHROWER_ROLL_IDEAL_RANGE_CELLS: i32 = 24;
const SLUGTHROWER_ROLL_MAX_RANGE_CELLS: i32 = 56;
const MELEE_STOCK_ATTACK_SPEED_MS: u64 = 5_000;
const MELEE_MIN_ATTACK_INTERVAL_MS: u64 = 1_000;
const BRAWLER_MELEE_SPEED_POINTS_PER_BOX: i32 = 18;
const BRAWLER_NOVICE_MELEE_SPEED_POINTS: i32 = 10;
const BRAWLER_MELEE_SPEED_POINTS_CAP: i32 = 90;
const VIBROSWORD_ROLL_ATTACK_SPEED_MS: u64 = MELEE_STOCK_ATTACK_SPEED_MS;
const VIBROSWORD_ROLL_DAMAGE_MIN: u32 = 18;
const VIBROSWORD_ROLL_DAMAGE_MAX: u32 = 24;
const VIBROSWORD_ROLL_POINT_BLANK_ACC: i32 = 85;
const VIBROSWORD_ROLL_IDEAL_ACC: i32 = 70;
const VIBROSWORD_ROLL_MAX_ACC: i32 = 35;
const VIBROSWORD_ROLL_POINT_BLANK_RANGE_CELLS: i32 = 1;
const VIBROSWORD_ROLL_IDEAL_RANGE_CELLS: i32 = 2;
const VIBROSWORD_ROLL_MAX_RANGE_CELLS: i32 = 3;
const HUMAN_PLAYER_SPREAD_BIAS_DEGREES_MILLI: i32 = 150;
const AGENT_PLAYER_SPREAD_BIAS_DEGREES_MILLI: i32 = 250;
const DEFAULT_ACTOR_SPREAD_BIAS_DEGREES_MILLI: i32 = 600;
const SKIRMISHER_SPREAD_BIAS_DEGREES_MILLI: i32 = 24_000;
/// Extra spread for Marksman-profession actors with no rifle-track skill boxes.
/// Bare novices keep the full role envelope, but do not double it.
const MARKSMAN_NOVICE_RIFLE_SPREAD_PENALTY_DEGREES_MILLI: i32 = 0;
const SKIRMISHER_DEADEYE_SPREAD_BIAS_DEGREES_MILLI: i32 = 7_200;
const HUMAN_PLAYER_MOVING_FIRE_SPREAD_DEGREES_MILLI: i32 = 450;
const AGENT_PLAYER_MOVING_FIRE_SPREAD_DEGREES_MILLI: i32 = 100;
const DEFAULT_MOVING_FIRE_SPREAD_DEGREES_MILLI: i32 = 900;
const SKIRMISHER_MOVING_FIRE_SPREAD_DEGREES_MILLI: i32 = 12_000;
const LOW_ACTION_FIRE_SPREAD_DEGREES_MILLI: i32 = 1_400;
const HUMAN_PLAYER_LOW_ACTION_FIRE_SPREAD_DEGREES_MILLI: i32 = 700;
const AGENT_PLAYER_LOW_ACTION_FIRE_SPREAD_DEGREES_MILLI: i32 = 150;
const DEFAULT_HEALTH: i32 = 100;
const DEFAULT_ACTION: i32 = 100;
const DEFAULT_SPIRIT: i32 = 100;
const PLAYER_LIKE_BASE_DODGE_CHANCE_MILLI: i32 = 100;
const DOWNED_BLEEDOUT_TARGET_SECONDS: u64 = 14;
const INCAP_BASE_SECONDS: u64 = 20;
const INCAP_MIN_OVERKILL_SECONDS: u64 = 1;
const INCAP_WINDOW_MS: u64 = 15 * 60 * 1_000;
const INCAP_MAX_COUNT: u8 = 3;
const INCAP_SELF_REVIVE_GRACE_MS: u64 = 3_000;
const STIMPAK_A_ITEM_ID: u32 = 1_001;
const FIELD_BANDAGE_ITEM_ID: u32 = 1_002;
const RESUSCITATION_KIT_ITEM_ID: u32 = 1_003;
const PERSONAL_SHIELD_GENERATOR_ITEM_ID: u32 = 1_004;
const BODY_ENHANCEMENT_PACK_A_ITEM_ID: u32 = 1_005;
const SPIRIT_ENHANCEMENT_PACK_A_ITEM_ID: u32 = 1_006;
// MEDIC WAVE — component-built consumables (1_0xx consumable band) + the earlier sandbox design
// medical-component band (1_2xx, adjacent to 1_1xx ammo). Components are
// intermediate crafted goods whose crafted quality is SLOTTED into the Advanced
// Stimpak, carrying into the final heal (component-quality crafting).
const ADVANCED_STIMPAK_ITEM_ID: u32 = 1_007;
const ANTI_DIZZY_STIM_ITEM_ID: u32 = 1_008;
const ANTI_BLIND_STIM_ITEM_ID: u32 = 1_009;
const BIO_EFFECT_CONTROLLER_ITEM_ID: u32 = 1_201;
const LIQUID_SUSPENSION_ITEM_ID: u32 = 1_202;
const CHEMICAL_RELEASE_MECHANISM_ITEM_ID: u32 = 1_203;
const SOLID_DELIVERY_SHELL_ITEM_ID: u32 = 1_204;
const AMMO_SLUG_IRON_ITEM_ID: u32 = 1_101;
const AMMO_SLUG_SHARD_ITEM_ID: u32 = 1_102;
const AMMO_SLUG_SPIKE_ITEM_ID: u32 = 1_103;
const RESOURCE_MINERAL_ITEM_ID: u32 = 2_001;
const RESOURCE_CHEMICAL_ITEM_ID: u32 = 2_002;
const RESOURCE_FLORA_ITEM_ID: u32 = 2_003;
const RESOURCE_GAS_ITEM_ID: u32 = 2_004;
const RESOURCE_LIQUID_ITEM_ID: u32 = 2_005;
const RESOURCE_CREATURE_HIDE_ITEM_ID: u32 = 2_101;
const RESOURCE_CREATURE_MEAT_ITEM_ID: u32 = 2_102;
const RESOURCE_CREATURE_BONE_ITEM_ID: u32 = 2_103;
const RESOURCE_CREATURE_STRUCTURAL_ITEM_ID: u32 = 2_104;
const FIELD_MULTITOOL_ITEM_ID: u32 = 3_001;
const CRAFTED_SLUGTHROWER_ITEM_ID: u32 = 3_101;
const VIBROSWORD_WEAPON_ITEM_ID: u32 = 3_103;
const PLASMA_SWORD_ITEM_ID: u32 = 3_104;
const SCRAPLINE_MACHETE_ITEM_ID: u32 = 3_105;
const FIELD_SABER_ITEM_ID: u32 = 3_106;
const QUARRY_CHOPPER_ITEM_ID: u32 = 3_107;
// Canonical loot-table combat helmet. Acquisition remains loot-only outside
// explicitly gated debug grants; this id now resolves as a wearable item.
const COMBAT_HELM_ITEM_ID: u32 = 7_103;
// Approved custom ranged items. The weapon class carries combat stats; only
// these player-facing inventory rows are canonical.
const STEN_MK2_ITEM_ID: u32 = 3_111;
const KILN_ENERGY_CELL_ITEM_ID: u32 = 3_112;
const LIGHTNING_CARBINE_ITEM_ID: u32 = 3_121;
// Credit Chip: a PHYSICAL, lootable/tradeable currency item whose `quantity` IS
// its credit value (owner ruling 2026-07-08). Redeemed into the scalar
// `professions.credits` balance via RedeemCreditChip; split/merge like any stack.
const CREDIT_CHIP_ITEM_ID: u32 = 9_002;
const RESOURCE_STACK_CAP: u32 = 100_000;
// One chip holds up to 1e9 credits (< u32::MAX, so no wire widening). Stacking two
// chips past the cap is refused by the shared stack-cap gate, exactly like resources.
const CREDIT_CHIP_STACK_CAP: u32 = 1_000_000_000;
const METAL_EXTRACTOR_STACK_CAP: u32 = 1;
const SURVEY_TOOL_STACK_CAP: u32 = 1;
const CAMP_KIT_STACK_CAP: u32 = 10;
const EXTRACTOR_BATTERY_STACK_CAP: u32 = 10;
const AMMO_SLUG_STACK_CAP: u32 = 1_000;
const STIMPAK_A_STACK_CAP: u32 = 25;
const FIELD_BANDAGE_STACK_CAP: u32 = 100;
const RESUSCITATION_KIT_STACK_CAP: u32 = 10;
const PERSONAL_SHIELD_GENERATOR_STACK_CAP: u32 = 1;
const ENHANCEMENT_PACK_A_STACK_CAP: u32 = 100;
const ADVANCED_STIMPAK_STACK_CAP: u32 = 25;
const ANTI_STATE_STIM_STACK_CAP: u32 = 25;
const MEDICAL_COMPONENT_STACK_CAP: u32 = 100;
const PERSONAL_SHIELD_MAX_HIT_POINTS: u32 = 100;
const PERSONAL_SHIELD_HIT_POINT_MILLI: u32 = 1_000;
const PERSONAL_SHIELD_MAX_CHARGE_MILLI: u32 =
    PERSONAL_SHIELD_MAX_HIT_POINTS.saturating_mul(PERSONAL_SHIELD_HIT_POINT_MILLI);
const PERSONAL_SHIELD_MIN_BLOCK_CHARGE_COST_MILLI: u32 = PERSONAL_SHIELD_HIT_POINT_MILLI;
const PERSONAL_SHIELD_MAX_DURABILITY_CHARGES: u16 = PERSONAL_SHIELD_MAX_HIT_POINTS as u16;
const PERSONAL_SHIELD_MAX_DURABILITY_MILLI: u32 =
    PERSONAL_SHIELD_MAX_CHARGE_MILLI.saturating_mul(PERSONAL_SHIELD_MAX_DURABILITY_CHARGES as u32);
const PERSONAL_SHIELD_RECHARGE_DELAY_MS: u64 = 10_000;
const PERSONAL_SHIELD_RECHARGE_FULL_MS: u64 = 2_500;
// Ground resource identity stays stable while its survey/extraction concentration
// field rotates by real-time epochs.
const RESOURCE_SPAWN_EPOCH_TICKS: u64 = 7 * 86_400 * 30;
// Creature-derived resources still cycle every 30 in-game days.
const RESOURCE_CYCLE_TICKS: u64 = 270_000;
// Shared 50-slot district exchange: a public stash players store into / retrieve from.
// Distinct (item_id, variant_id) stacks count toward the slot cap.
const EXCHANGE_CONTAINER: &str = "district-exchange";
const EXCHANGE_CONTAINER_SLOTS: usize = 50;
// Posture transitions are deterministic tick locks at 30 Hz: kneel down is
// intentionally quicker than standing back up for visible sampling commitment.
const POSTURE_KNEEL_DOWN_TICKS: u64 = 21;
const POSTURE_STAND_UP_TICKS: u64 = 27;
// Sampling v1 resolves after two seconds of kneeling, then leaves a short
// economy-lane cooldown so repeated extraction is paced without wall-clock time.
const RESOURCE_SAMPLE_DURATION_TICKS: u64 = 60;
// Idle auto-sampling cadence. Halved from 900 (30s) to 450 (15s) as the compensating knob for
// the 5x per-pull yield cut (resource-units-design.md s5.1): keeps idle throughput reasonable
// while staying far below the AFK extractor's bulk role (hand ~3 g/s active vs 86.4 kg hopper).
const RESOURCE_SAMPLE_AUTO_REPEAT_CADENCE_TICKS: u64 = 450;
// Gram doctrine: the barrel, receiver, and throw-coil assembly use 3.5 kg of mineral.
const CRAFT_SLUGTHROWER_MINERAL_QTY: u32 = 3_500;
// Capacitor dielectric fill uses ~60 g of petrochemical; launch is electromagnetic,
// with no combustion or gunpowder.
const CRAFT_SLUGTHROWER_CHEMICAL_QTY: u32 = 60;
// Insulated stock and grip: 0.9 kg of processed polymer.
const CRAFT_SLUGTHROWER_POLYMER_QTY: u32 = 900;
const CRAFT_FIELD_MULTITOOL_IRON_QTY: u32 = 24;
const CRAFT_FIELD_MULTITOOL_COPPER_QTY: u32 = 12;
const CRAFT_IRRIGATION_SPRINKLER_COPPER_QTY: u32 = 24;
const CRAFT_IRRIGATION_SPRINKLER_POLYMER_QTY: u32 = 12;
const CRAFT_METAL_EXTRACTOR_IRON_QTY: u32 = 80;
const CRAFT_METAL_EXTRACTOR_COPPER_QTY: u32 = 36;
const CRAFT_EXTRACTOR_BATTERY_COPPER_QTY: u32 = 24;
const CRAFT_EXTRACTOR_BATTERY_IRON_QTY: u32 = 12;
const CRAFT_EXTRACTOR_BATTERY_FUEL_QTY: u32 = 12;
// Processed-resource batches preserve mass and yield one immediately useful downstream batch.
const CRAFT_FUEL_PETROCHEMICAL_QTY: u32 = 12;
const CRAFT_FUEL_OUTPUT_QTY: u32 = 12;
const CRAFT_POLYMER_PETROCHEMICAL_QTY: u32 = 450;
const CRAFT_POLYMER_CARBON_QTY: u32 = 450;
const CRAFT_POLYMER_OUTPUT_QTY: u32 = 900;
// Clodpowder: the orange binding agent processed from PassiveCreature bone (not
// ground-sampled). It behaves like a statted resource spawn once processed:
// one named/statted resource instance per area+cycle.
const RESOURCE_CLODPOWDER_ITEM_ID: u32 = 2_006;
const RESOURCE_COPPER_ITEM_ID: u32 = 2_007;
const RESOURCE_CARBON_ITEM_ID: u32 = 2_008;
const RESOURCE_FUEL_ITEM_ID: u32 = 2_009;
const RESOURCE_POLYMER_ITEM_ID: u32 = 2_010;
const SCOUT_PROCESSING_TOOL_ITEM_ID: u32 = 3_004;
const METAL_EXTRACTOR_TOOL_ITEM_ID: u32 = 3_006;
// Category survey tools use /survey + the matching sampling gate. The Field Multitool and
// Mineral Survey Tool form the trainer-issued bootstrap bundle; other category tools are crafted.
const MINERAL_SURVEY_TOOL_ITEM_ID: u32 = 3_008;
const CHEMICAL_SURVEY_TOOL_ITEM_ID: u32 = 3_009;
const GAS_SURVEY_TOOL_ITEM_ID: u32 = 3_010;
const WATER_SURVEY_TOOL_ITEM_ID: u32 = 3_011;
// Personal-scale category extractors. MINERAL keeps id 3_006 (formerly the
// "Metal Extractor"; display renamed to "Personal Mineral Sampler"). Heavy
// mining installations arrive later with their own namespace.
const CHEMICAL_EXTRACTOR_TOOL_ITEM_ID: u32 = 3_012;
const GAS_EXTRACTOR_TOOL_ITEM_ID: u32 = 3_013;
const WATER_EXTRACTOR_TOOL_ITEM_ID: u32 = 3_014;
const CAMP_KIT_ITEM_ID: u32 = 3_007;
const EXTRACTOR_BATTERY_ITEM_ID: u32 = 3_201;
const LOOTED_SCHEMATIC_ITEM_ID: u32 = 5_002;
const DRAFTED_SCHEMATIC_ITEM_ID: u32 = 5_003;
// Bio-Engineer / Crop-engineering item bands (co-owned 6_xxx; bioengineer-design.md §0.5).
// 6_0xx = seeds (one item_id per crop species, variant_id = genome handle; Bio-Engineer owns).
// 6_1xx = produce (Agriculture owns). 6_2xx = bio tools & reagents (Bio-Engineer owns).
// 6_3xx = farm placeables (Agriculture owns). Seeds STACK by (item_id, variant_id) like any stack.
const CROP_ASHGRAIN_ITEM_ID: u32 = 6_001;
const CROP_SUNMELON_ITEM_ID: u32 = 6_002;
const CROP_CAVEMOSS_ITEM_ID: u32 = 6_003;
const CROP_EMBERBEAN_ITEM_ID: u32 = 6_004;
const CROP_RIFTROOT_ITEM_ID: u32 = 6_005;
const CROP_BRINELEAF_ITEM_ID: u32 = 6_006;
const CROP_GLASSPEPPER_ITEM_ID: u32 = 6_007;
const CROP_COILREED_ITEM_ID: u32 = 6_008;
const CROP_NIGHTPLUM_ITEM_ID: u32 = 6_009;
// Produce (6_1xx, Agriculture owns; one per species = PRODUCE_ID_BASE + seed%100).
const PRODUCE_ASHGRAIN_ITEM_ID: u32 = 6_101;
const PRODUCE_SUNMELON_ITEM_ID: u32 = 6_102;
const PRODUCE_CAVEMOSS_ITEM_ID: u32 = 6_103;
const PRODUCE_EMBERBEAN_ITEM_ID: u32 = 6_104;
const PRODUCE_RIFTROOT_ITEM_ID: u32 = 6_105;
const PRODUCE_BRINELEAF_ITEM_ID: u32 = 6_106;
const PRODUCE_GLASSPEPPER_ITEM_ID: u32 = 6_107;
const PRODUCE_COILREED_ITEM_ID: u32 = 6_108;
const PRODUCE_NIGHTPLUM_ITEM_ID: u32 = 6_109;
const GENE_SAMPLER_ITEM_ID: u32 = 6_201;
const SPLICE_BENCH_ITEM_ID: u32 = 6_202;
const GENOME_SCANNER_ITEM_ID: u32 = 6_203;
const CULTURE_MEDIUM_ITEM_ID: u32 = 6_204;
const MUTAGEN_ITEM_ID: u32 = 6_205;
const STABILIZER_ITEM_ID: u32 = 6_206;
const SERUM_ITEM_ID: u32 = 6_207;
const GENE_LOCK_KIT_ITEM_ID: u32 = 6_208;
// Bio-additive matrices (6_313..6_324) are inventory/crafting-role entries only.
const BIO_ADDITIVE_DENSITY_LIGHT_ITEM_ID: u32 = 6_313;
const BIO_ADDITIVE_DENSITY_MEDIUM_ITEM_ID: u32 = 6_314;
const BIO_ADDITIVE_DENSITY_HEAVY_ITEM_ID: u32 = 6_315;
const BIO_ADDITIVE_SAVOR_LIGHT_ITEM_ID: u32 = 6_316;
const BIO_ADDITIVE_SAVOR_MEDIUM_ITEM_ID: u32 = 6_317;
const BIO_ADDITIVE_SAVOR_HEAVY_ITEM_ID: u32 = 6_318;
const BIO_ADDITIVE_NUTRIENT_LIGHT_ITEM_ID: u32 = 6_319;
const BIO_ADDITIVE_NUTRIENT_MEDIUM_ITEM_ID: u32 = 6_320;
const BIO_ADDITIVE_NUTRIENT_HEAVY_ITEM_ID: u32 = 6_321;
const BIO_ADDITIVE_BATCH_LIGHT_ITEM_ID: u32 = 6_322;
const BIO_ADDITIVE_BATCH_MEDIUM_ITEM_ID: u32 = 6_323;
const BIO_ADDITIVE_BATCH_HEAVY_ITEM_ID: u32 = 6_324;
// Processed ingredients (6_401..6_415) and prepared foods (6_501..6_520)
// are catalog entries only; no consumption or cooking runtime is implied.
const INGREDIENT_ASHGRAIN_MEAL_ITEM_ID: u32 = 6_401;
const INGREDIENT_SUNMELON_PRESS_ITEM_ID: u32 = 6_402;
const INGREDIENT_CAVEMOSS_EXTRACT_ITEM_ID: u32 = 6_403;
const INGREDIENT_EMBERBEAN_CURD_ITEM_ID: u32 = 6_404;
const INGREDIENT_RIFTROOT_STARCH_ITEM_ID: u32 = 6_405;
const INGREDIENT_BRINELEAF_SALT_ITEM_ID: u32 = 6_406;
const INGREDIENT_GLASSPEPPER_MASH_ITEM_ID: u32 = 6_407;
const INGREDIENT_COILREED_SYRUP_ITEM_ID: u32 = 6_408;
const INGREDIENT_NIGHTPLUM_PRESERVE_ITEM_ID: u32 = 6_409;
const INGREDIENT_FIELD_DOUGH_ITEM_ID: u32 = 6_410;
const INGREDIENT_HEARTH_BROTH_ITEM_ID: u32 = 6_411;
const INGREDIENT_CLODMEAT_MINCE_ITEM_ID: u32 = 6_412;
const INGREDIENT_FERMENT_CULTURE_ITEM_ID: u32 = 6_413;
const INGREDIENT_RENDERED_FAT_ITEM_ID: u32 = 6_414;
const INGREDIENT_SEASONING_BRICK_ITEM_ID: u32 = 6_415;
const FOOD_ASHGRAIN_HEARTH_LOAF_ITEM_ID: u32 = 6_501;
const FOOD_SUNMELON_SLICECAKE_ITEM_ID: u32 = 6_502;
const FOOD_CAVEMOSS_BROTH_ITEM_ID: u32 = 6_503;
const FOOD_EMBERBEAN_GRIDDLE_CAKES_ITEM_ID: u32 = 6_504;
const FOOD_RIFTROOT_SKILLET_HASH_ITEM_ID: u32 = 6_505;
const FOOD_BRINELEAF_NOODLE_BOWL_ITEM_ID: u32 = 6_506;
const FOOD_GLASSPEPPER_CLOD_SKEWER_ITEM_ID: u32 = 6_507;
const FOOD_COILREED_GLAZE_BUN_ITEM_ID: u32 = 6_508;
const FOOD_NIGHTPLUM_HAND_PIE_ITEM_ID: u32 = 6_509;
const FOOD_CLODMEAT_STEW_TIN_ITEM_ID: u32 = 6_510;
const FOOD_TRAIL_RATION_TRAY_ITEM_ID: u32 = 6_511;
const FOOD_FIELD_DUMPLINGS_ITEM_ID: u32 = 6_512;
const FOOD_SMOKED_CLOD_CUTLET_ITEM_ID: u32 = 6_513;
const FOOD_PRESSED_FRUIT_BAR_ITEM_ID: u32 = 6_514;
const FOOD_NIGHT_WATCH_SOUP_ITEM_ID: u32 = 6_515;
const FOOD_FARMHAND_BREAKFAST_ITEM_ID: u32 = 6_516;
const FOOD_SPICED_RIFTROOT_MASH_ITEM_ID: u32 = 6_517;
const FOOD_HARVEST_LAYER_CAKE_ITEM_ID: u32 = 6_518;
const FOOD_CAVEMOSS_STEEP_ITEM_ID: u32 = 6_519;
const FOOD_SUNMELON_COOLER_ITEM_ID: u32 = 6_520;
// Starter seed packet + baseline bio-tool quality granted at bioengineer-novice (§1.5).
const BIO_STARTER_TOOL_QUALITY_MILLI: u32 = 500;
const BIO_SEED_STACK_CAP: u32 = 1_000;
const BIO_REAGENT_STACK_CAP: u32 = 100;
const EXTRACTOR_BATTERY_VARIANT_BASE: u32 = 32_000_000;
const EXTRACTOR_BATTERY_VARIANT_MAX_RUNTIME_SECONDS: u32 = 86_400;
const CRAFT_PROFESSION_TOOL_IRON_QTY: u32 = 72;
const CRAFT_CLODPOWDER_BONE_QTY: u32 = 36;
const CRAFT_CLODPOWDER_OUTPUT_QTY: u32 = 72;
// Coil Slug batches press Clodpowder into charge wafers for the capacitor-and-throw-coil
// launch cycle; the wafer never burns and is not gunpowder.
const CRAFT_SUPPLY_AMMO_OUTPUT_QTY: u32 = 240;
const CRAFT_SUPPLY_AMMO_CLODPOWDER_QTY: u32 = 24;
const CRAFT_SUPPLY_AMMO_IRON_QTY: u32 = 36;
const CRAFT_SUPPLY_BANDAGE_OUTPUT_QTY: u32 = 20;
const CRAFT_SUPPLY_BANDAGE_CLODPOWDER_QTY: u32 = 8;
const CRAFT_SUPPLY_BANDAGE_IRON_QTY: u32 = 6;
const CRAFT_SUPPLY_STIMPAK_OUTPUT_QTY: u32 = 4;
const CRAFT_SUPPLY_STIMPAK_CLODPOWDER_QTY: u32 = 16;
const CRAFT_SUPPLY_STIMPAK_IRON_QTY: u32 = 12;
const CRAFT_SUPPLY_ENHANCEMENT_PACK_OUTPUT_QTY: u32 = 20;
const CRAFT_SUPPLY_ENHANCEMENT_PACK_CLODPOWDER_QTY: u32 = 18;
const CRAFT_SUPPLY_ENHANCEMENT_PACK_IRON_QTY: u32 = 12;
const CRAFT_SUPPLY_RESUSCITATION_KIT_OUTPUT_QTY: u32 = 4;
const CRAFT_SUPPLY_RESUSCITATION_KIT_CLODPOWDER_QTY: u32 = 8;
const CRAFT_SUPPLY_RESUSCITATION_KIT_IRON_QTY: u32 = 6;
const CRAFT_SUPPLY_PERSONAL_SHIELD_GENERATOR_OUTPUT_QTY: u32 = 1;
const CRAFT_SUPPLY_PERSONAL_SHIELD_GENERATOR_CLODPOWDER_QTY: u32 = 24;
const CRAFT_SUPPLY_PERSONAL_SHIELD_GENERATOR_IRON_QTY: u32 = 18;
const RESOURCE_SAMPLE_ACTION_MS: u64 = 5_000;
const RESOURCE_SURVEY_ACTION_MS: u64 = 10_000;
const HARVEST_CORPSE_ACTION_MS: u64 = 5_000;
const CRAFT_SUPPLY_AMMO_BATCH_MS: u64 = 10_000;
const CRAFT_SUPPLY_BANDAGE_BATCH_MS: u64 = 6_000;
const CRAFT_SUPPLY_STIMPAK_BATCH_MS: u64 = 10_000;
const CRAFT_SUPPLY_ENHANCEMENT_PACK_BATCH_MS: u64 = 10_000;
const CRAFT_SUPPLY_RESUSCITATION_KIT_BATCH_MS: u64 = 8_000;
const CRAFT_SUPPLY_PERSONAL_SHIELD_GENERATOR_BATCH_MS: u64 = 12_000;
const CRAFT_PROFESSION_TOOL_BATCH_MS: u64 = 8_000;
const CRAFT_XP_PER_TIER: u64 = 20;
const CRAFT_XP_PER_EXPERIMENT_POINT: u64 = 5;
// Bio-Engineer action pacing + XP + grant quantities (bioengineer-design.md §1.4/§1.5).
const BIO_SAMPLE_ACTION_MS: u64 = 5_000;
const BIO_XP_PER_SAMPLE: u64 = 20;
const BIO_XP_PER_SCAN: u64 = 10;
const BIO_XP_PER_SPLICE_ASSEMBLE: u64 = 20;
const BIO_XP_PER_SPLICE_POINT: u64 = 5;
const BIO_XP_PER_SPLICE_MINT: u64 = 20;
const BIO_STARTER_SEED_PACKET_QTY: u32 = 5;
const SPLICE_MINT_SEED_QTY: u32 = 1;
const REQUEST_STARTER_TOOL_COOLDOWN_MS: u64 = 300_000;
const STARTER_FIELD_MULTITOOL_QUALITY_MILLI: u32 = 500;
const IMPROVISED_HANDS_TOOL_QUALITY_MILLI: u16 = 250;
const CRAFT_CLODPOWDER_BATCH_MS: u64 = 8_000;
const PLAYER_RESPAWN_STIMPAK_A_QUANTITY: u32 = 16;
const PLAYER_RESPAWN_FIELD_BANDAGE_QUANTITY: u32 = 16;
const PLAYER_RESPAWN_SLUG_AMMO_QUANTITY: u32 = 240;
const AMMO_REFILL_BATCH_QUANTITY: u32 = 240;
const AMMO_REFILL_RADIUS_MILLI_CELLS: i32 = 3_000;
const POINT_BLANK_INTERACTION_RADIUS_MILLI_CELLS: i32 = 1_500;
const EXCHANGE_INTERACTION_RADIUS_MILLI_CELLS: i32 = POINT_BLANK_INTERACTION_RADIUS_MILLI_CELLS;
const HARVEST_INTERACTION_RADIUS_MILLI_CELLS: i32 = 1_750;
const REVIVE_INTERACTION_RADIUS_MILLI_CELLS: i32 = POINT_BLANK_INTERACTION_RADIUS_MILLI_CELLS;
const REVIVE_HOSTILE_PRESSURE_RADIUS_MILLI_CELLS: i32 = 12_000;
const REVIVE_CLOSE_HOSTILE_PRESSURE_RADIUS_MILLI_CELLS: i32 =
    POINT_BLANK_INTERACTION_RADIUS_MILLI_CELLS * 2;
const REVIVE_ACTION_MS: u64 = 5_000;
const REVIVE_RESTORE_VITALS_PERCENT: i32 = 35;
const TRADE_INTERACTION_RADIUS_MILLI_CELLS: i32 = POINT_BLANK_INTERACTION_RADIUS_MILLI_CELLS;
const STIMPAK_A_HEAL_MILLI: i32 = 100_000;
const STIMPAK_A_DURATION_MS: u64 = 4_000;
const SERVICE_BUFF_DURATION_MS: u64 = 10_800_000;
const MEDIC_PREP_EFFECT_ID: &str = "medic-prep";
const ENTERTAINER_SESSION_EFFECT_ID: &str = "entertainer-session";
const MEDIC_PREP_BODY_DELTA: i32 = 70;
const ENTERTAINER_SESSION_SPIRIT_DELTA: i32 = 75;
// Anti-state defense lasts for 30 minutes, shorter than the three-hour service
// buffs. Both anti-state stim variants contribute to this one unified effect.
const ANTI_STATE_DEFENSE_BUFF_DURATION_MS: u64 = 1_800_000;
const STATE_DEFENSE_EFFECT_ID: &str = "state-defense";
const CRAFT_ADVANCED_STIMPAK_COMPONENT_QTY: u32 = 1;
const SLEEP_KILL_THRESHOLD: u8 = 4;
// Corpse body timers are authority ticks at the fixed 30Hz gameplay cadence:
// 300 ticks = 10 seconds, 900 ticks = 30 seconds, 9000 ticks = 5 minutes.
// These are not milliseconds.
const CORPSE_BODY_NO_LOOT_TICKS: u64 = 900;
const CORPSE_BODY_WITH_LOOT_TICKS: u64 = 9_000;
const CORPSE_EXHAUSTED_CLAMP_TICKS: u64 = 900;
const CREATURE_CORPSE_EXHAUSTED_LINGER_TICKS: u64 = 300;
const SESSION_RESPAWN_TICKS: u64 = 90;
const NPC_ROUTE_STEP_INTERVAL_TICKS: u64 = 18;
const ROUTE_PATROL_UPDATE_CADENCE_TICKS: u64 = 3;
const PASSIVE_CREATURE_ROAM_SPEED_MILLI_CELLS_PER_SECOND: i32 = 900;
const PASSIVE_CREATURE_FLEE_SPEED_MILLI_CELLS_PER_SECOND: i32 = 1_650;
const PASSIVE_CREATURE_SEPARATION_RADIUS_MILLI_CELLS: i32 = 1_350;
const CREATURE_HOME_RADIUS_MILLI_CELLS: i32 = 5_500;
// Engage base is composed through movement_speed_multiplier_milli_for_actor
// (role move mult * body_output). Creature spawn spirit is strained, so the
// live multiplier is ~0.705 (not the full-spirit 0.885). Base 2100 yields
// ~1480 effective > player walk 1357, while sprint (~6525) still escapes
// inside CREATURE_CHASE_TIMEOUT_MS.
const CREATURE_ENGAGE_SPEED_MILLI_CELLS_PER_SECOND: i32 = 2_100;
const CREATURE_DETECT_RADIUS_MILLI_CELLS: i32 = 12_000;
const CREATURE_ATTACK_RANGE_MILLI_CELLS: i32 = 2_350;
const CREATURE_LEASH_RADIUS_MILLI_CELLS: i32 = 14_000;
const CREATURE_CHASE_TIMEOUT_MS: u64 = 8_000;
const CREATURE_ATTACK_INTERVAL_MS: u64 = 1_600;
// Wildlife-only melee flat damage. Do NOT raise shared Unarmed (2):
// humanoid bare fists and player unarmed stay on the weapon profile.
const CREATURE_MELEE_BASE_DAMAGE: i32 = 18;
const CREATURE_DISENGAGE_RADIUS_MILLI_CELLS: i32 = 16_000;
const ROGUE_TROOPER_SPEED_MILLI_CELLS_PER_SECOND: i32 = 5_000;
const SKIRMISHER_ACQUIRE_RADIUS_MILLI_CELLS: i32 = 115_000;
const SKIRMISHER_MIN_RANGE_MILLI_CELLS: i32 = 21_000;
const SKIRMISHER_PREFERRED_RANGE_MILLI_CELLS: i32 = 25_000;
const SKIRMISHER_MAX_RANGE_MILLI_CELLS: i32 = 30_000;
const ROGUE_TROOPER_MIN_RANGE_MILLI_CELLS: i32 = 4_500;
const ROGUE_TROOPER_PREFERRED_RANGE_MILLI_CELLS: i32 = 16_000;
const ROGUE_TROOPER_MAX_RANGE_MILLI_CELLS: i32 = 26_000;
const SKIRMISHER_DECISION_MIN_TICKS: u64 = 18;
const SKIRMISHER_DECISION_MAX_TICKS: u64 = 30;
const ROGUE_TROOPER_SHOT_COOLDOWN_MIN_TICKS: u64 = 20;
const ROGUE_TROOPER_SHOT_COOLDOWN_MAX_TICKS: u64 = 54;
const ROGUE_TROOPER_BURST_MIN_SHOTS: u8 = 2;
const ROGUE_TROOPER_BURST_MAX_SHOTS: u8 = 4;
const AGENT_PLAYER_TACTICAL_SPEED_MILLI_CELLS_PER_SECOND: i32 = 6_850;
const AGENT_PLAYER_MIN_RANGE_MILLI_CELLS: i32 = 3_500;
const AGENT_PLAYER_PREFERRED_RANGE_MILLI_CELLS: i32 = 9_000;
const AGENT_PLAYER_MAX_RANGE_MILLI_CELLS: i32 = 31_500;
const AGENT_PLAYER_COVER_SEARCH_RADIUS_MILLI_CELLS: i32 = 30_000;
const AGENT_PLAYER_SUPPRESSION_COVER_MILLI: i32 = 22_000;
const AGENT_PLAYER_LOW_ACTION_COVER_PERCENT: i32 = 22;
const AGENT_PLAYER_SHOT_COOLDOWN_MIN_TICKS: u64 = 5;
const AGENT_PLAYER_SHOT_COOLDOWN_MAX_TICKS: u64 = 16;
const AGENT_PLAYER_BURST_MIN_SHOTS: u8 = 4;
const AGENT_PLAYER_BURST_MAX_SHOTS: u8 = 8;
const TACTICAL_PRESSURE_REPLAN_GRACE_TICKS: u64 = 10;
const SKIRMISHER_PRESSURE_FIRE_GAP_TICKS: u64 = 90;
const ROGUE_TROOPER_COVER_SEARCH_RADIUS_MILLI_CELLS: i32 = 20_000;
const SKIRMISHER_COVER_REACHED_MILLI_CELLS: i32 = 1_100;
const SKIRMISHER_MIN_TACTICAL_REPOSITION_MILLI_CELLS: i32 = 900;
const SKIRMISHER_MICRO_CORRECTION_DEADBAND_MILLI_CELLS: i32 = 1_450;
const SKIRMISHER_MICRO_CORRECTION_AXIS_LOCK_MILLI_CELLS: i32 = 280;
const SKIRMISHER_MICRO_REVERSAL_STEP_MILLI_CELLS: i32 = 800;
const SKIRMISHER_MICRO_REVERSAL_WINDOW_TICKS: u64 = 150;
const SKIRMISHER_BLOCKED_TARGET_MEMORY_TICKS: u64 = 60;
const SKIRMISHER_BLOCKED_TARGET_RADIUS_MILLI_CELLS: i32 = 1_750;
const ROGUE_TROOPER_SUPPRESSION_COVER_MILLI: i32 = 8_000;
const AI_UPDATE_CADENCE_TICKS: u64 = 1;
const AI_DECISION_CADENCE_TICKS: u64 = 3;
const SKIRMISHER_TACTICAL_STATE_REFRESH_TICKS: u64 = 3;
const SKIRMISHER_TACTICAL_CANDIDATE_DEBUG_LIMIT: usize = 12;
const SKIRMISHER_LANE_WIDTH_MILLI_CELLS: i32 = 3_000;
const SKIRMISHER_NO_MANS_LAND_MARGIN_MILLI_CELLS: i32 = 1_500;
const SKIRMISHER_FRONTLINE_MIN_STANDOFF_MILLI_CELLS: i32 = 3_500;
const SKIRMISHER_PATH_MAX_EXPANSIONS: usize = 4_096;
const SKIRMISHER_REACHABLE_CANDIDATE_PROBE_LIMIT: usize = 8;
const SKIRMISHER_EVASION_STEP_MILLI_CELLS: i32 = 2_400;
const AI_ACTOR_BODY_SEPARATION_MILLI_CELLS: i32 = 900;
const AI_ACTOR_BODY_SEPARATION_RELEASE_MILLI_CELLS: i32 = 80;
const AI_OBSTACLE_CLEARANCE_MILLI_CELLS: i32 = 450;
const AI_AVOIDANCE_STEP_MIN_MILLI_CELLS: i32 = 450;
const AI_TACTICAL_EDGE_MARGIN_MILLI_CELLS: i32 = 4_000;
const HIGH_COVER_SHADOW_DEPTH_CELLS: i32 = 4;
const HIGH_COVER_SHADOW_LATERAL_PAD_CELLS: i32 = 2;
const PASSIVE_CREATURE_IDLE_CADENCE_TICKS: u64 = 20;
const RANGED_SUPPRESSION_THRESHOLD_MILLI: i32 = 24_000;
const SUPPRESSION_MAX_PRESSURE_MILLI: i32 = 100_000;
const SUPPRESSION_DECAY_MILLI_PER_SECOND: i32 = 18_000;
const RANGED_SUPPRESSION_MAX_AMOUNT_MILLI: i32 = 64_000;
const SUPPRESSION_PANIC_BASE_TICKS: u64 = 36;
const SUPPRESSION_PANIC_SCALE_MILLI_TICKS_PER_PRESSURE: u64 = 1_400;
const SUPPRESSION_SPIRIT_DRAIN_DIVISOR_MILLI: i32 = 64_000;
const ACTOR_STATS_BUCKET_SECONDS: u64 = 5;
const ACTOR_STATS_BUCKET_COUNT: usize = 24;
const ACTOR_STATS_RECENT_10_SECONDS: u64 = 10;
const ACTOR_STATS_RECENT_60_SECONDS: u64 = 60;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceAuthorityConfig {
    pub session: SessionId,
    pub player: PlayerId,
    pub player_actor_id: String,
    pub area_interest_radius_cells: i32,
    pub craft_roll_key: [u8; 32],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(super) enum CombatModel {
    Roll,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityActorWornPiece {
    pub item: String,
    pub colors: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityEquippedClothingInstance {
    #[serde(default)]
    pub container: String,
    pub stack_id: u64,
    pub item_id: u32,
    pub variant_id: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AuthorityActorUpsert {
    pub id: String,
    pub entity: String,
    pub label: Option<String>,
    pub sprite: Option<String>,
    pub display_name: Option<String>,
    pub link_dead: bool,
    pub bare_start: bool,
    pub returning: bool,
    pub appearance: Option<AuthorityActorAppearanceSnapshot>,
    pub worn: Vec<AuthorityActorWornPiece>,
    pub worn_colors: BTreeMap<String, Vec<String>>,
    pub template_id: Option<String>,
    pub spawn_zone_id: Option<String>,
    pub role: String,
    pub profession_ids: Vec<String>,
    pub skill_box_ids: Vec<String>,
    pub profession_xp: BTreeMap<String, u64>,
    pub profession_track_xp: BTreeMap<String, u64>,
    pub skill_point_cap: Option<u16>,
    pub active_title_id: Option<String>,
    pub credits: Option<u64>,
    pub capabilities: Vec<String>,
    pub career_goal_id: Option<String>,
    pub faction_id: Option<String>,
    pub social_group: Option<String>,
    pub pvp_status: Option<String>,
    pub player_organization_id: Option<String>,
    pub player_organization_tag: Option<String>,
    pub area_id: String,
    pub x: f64,
    pub y: f64,
    pub direction: String,
    pub scale: u32,
    pub vitals: AuthorityVitals,
    pub max_vitals: AuthorityVitals,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityFixtureLoadoutItem {
    pub item_id: u32,
    pub variant_id: u32,
    pub quantity: u32,
    pub equipped: bool,
}

impl Default for SliceAuthorityConfig {
    fn default() -> Self {
        Self {
            session: SessionId(1),
            player: PlayerId(1),
            player_actor_id: "player".to_owned(),
            craft_roll_key: [0x42; 32],
            area_interest_radius_cells: 64,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceAuthorityMetrics {
    pub tick: u64,
    pub areas: usize,
    pub actors: usize,
    pub transitions: usize,
    pub blocked_cells: usize,
    pub seen_commands: usize,
    pub shots_fired: u64,
    pub combat_events: u64,
    pub hits: u64,
    pub deaths: u64,
    pub inventory_stacks: usize,
    pub reservations: usize,
    pub npc_jobs: usize,
    pub timeline_events: usize,
    pub placed_extractors: usize,
    pub state_hash: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceAuthorityAdvanceTiming {
    pub ticks: u16,
    pub total_us: u64,
    pub ai_us: u64,
    pub ai_tactical_state_us: u64,
    pub ai_passive_creature_us: u64,
    pub ai_skirmisher_us: u64,
    pub ai_tactical_state_rebuilt: u64,
    pub ai_tactical_state_reused: u64,
    pub ai_updates: u64,
    pub ai_skipped: u64,
    pub route_us: u64,
    pub path_queries: u64,
    pub path_expansions: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CachedSkirmisherTacticalState {
    tick: u64,
    actor_count: usize,
    combat_actor_count: usize,
    state: SkirmisherTacticalState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct PlayerOrganizationAuthorityState {
    id: String,
    label: String,
    tag: String,
    member_actor_ids: Vec<String>,
    ally_organization_ids: Vec<String>,
    enemy_organization_ids: Vec<String>,
}

/// Immutable or content-authored inputs used to construct an authority.
///
/// These values come from the reviewed slice and are not player progress. A
/// checkpoint must be restored into a current authored world rather than
/// carrying old geometry and tuning forward as if they were save data.
#[doc(hidden)]
#[derive(Debug, Clone)]
pub struct AuthoredWorldDefinition {
    tick_rate_hz: u32,
    combat_model: CombatModel,
    weapon_range_bands: BTreeMap<AuthorityWeaponId, WeaponRollRangeBands>,
    areas: BTreeMap<String, AreaAuthorityState>,
    factions: FactionTable,
    player_organizations: BTreeMap<String, PlayerOrganizationAuthorityState>,
    transitions: BTreeMap<String, TransitionAuthorityState>,
    clone_facilities: Vec<CloneFacilityAuthorityState>,
    no_claim_zones: Vec<NoClaimZoneAuthorityState>,
    blocked_cells: BTreeSet<CellKey>,
    ai_clearance_blocked_cells: BTreeSet<CellKey>,
    exchange_containers: Vec<ExchangeContainerAuthorityState>,
    fine_collision_bounds: Vec<FineCollisionBoundsAuthorityState>,
    cover_points: Vec<CoverPointAuthorityState>,
    ammo_stockpiles: Vec<AmmoStockpileAuthorityState>,
    terminals: Vec<AuthorityTerminalState>,
    farm_real_seconds_per_game_day: u32,
}

/// State whose effects survive an authority restart.
#[doc(hidden)]
#[derive(Debug, Clone)]
pub struct DurableAuthorityState {
    world: AuthoredWorldDefinition,
    tick: u64,
    actors: BTreeMap<String, ActorAuthorityState>,
    bark_claims: BarkClaims,
    population: PopulationAuthorityState,
    loot_caches: BTreeMap<String, LootCacheAuthorityState>,
    door_collision_bounds: Vec<DoorCollisionBoundsAuthorityState>,
    seen_commands: BTreeSet<(u64, u32, u64)>,
    bank_accounts: BTreeMap<String, BankAccountAuthorityState>,
    player_corpses: BTreeMap<String, PlayerCorpseState>,
    next_player_corpse_id: u64,
    inventory: Vec<InventoryStackSnapshot>,
    inventory_stack_counters: BTreeMap<String, u64>,
    reservations: Vec<ReservationSnapshot>,
    npc_jobs: Vec<NpcJobSnapshot>,
    timeline_events: Vec<TimelineEventSnapshot>,
    placed_extractors: BTreeMap<String, PlacedExtractorState>,
    next_extractor_id: u64,
    placed_camps: BTreeMap<String, PlacedCampState>,
    next_camp_id: u64,
    crop_genomes: CropGenomeRegistry,
    parcels: BTreeMap<String, ParcelAuthorityState>,
    next_parcel_id: u64,
    next_build_component_id: u64,
    plot_tending: BTreeMap<String, PlotTendingState>,
    drafted_schematics: BTreeMap<String, DraftedSchematicState>,
    next_drafted_schematic_id: u64,
    next_combat_event_id: u64,
    combat_event_count: u64,
    hits: u64,
    deaths: u64,
    trade_proposals: BTreeMap<u32, TradeProposal>,
    guilds: BTreeMap<String, GuildAuthorityState>,
    guild_invites: BTreeMap<String, PendingGuildInvite>,
    next_guild_id: u64,
    next_guild_invite_id: u64,
    next_trade_proposal_id: u32,
    groups: BTreeMap<u64, GroupAuthorityState>,
    group_invites: BTreeMap<String, PendingGroupInvite>,
    next_group_id: u64,
    duels: BTreeMap<u64, DuelAuthorityState>,
    duel_challenges: BTreeMap<String, PendingDuelChallenge>,
    next_duel_id: u64,
}

/// Rebuildable caches, measurements, and one-shot command deliveries.
#[doc(hidden)]
#[derive(Debug, Clone)]
pub struct AuthorityRuntimeState {
    durable: DurableAuthorityState,
    door_clearance_blocked_cells_by_prop: BTreeMap<String, BTreeSet<CellKey>>,
    ai_debug: SliceAuthorityAiDebugSnapshot,
    cached_skirmisher_tactical_state: Option<CachedSkirmisherTacticalState>,
    last_advance_timing: SliceAuthorityAdvanceTiming,
    current_ai_us: u64,
    current_ai_tactical_state_us: u64,
    current_ai_passive_creature_us: u64,
    current_ai_skirmisher_us: u64,
    current_ai_tactical_state_rebuilt: u64,
    current_ai_tactical_state_reused: u64,
    current_ai_updates: u64,
    current_ai_skipped: u64,
    current_route_us: u64,
    current_path_queries: Cell<u64>,
    current_path_expansions: Cell<u64>,
    current_removed_actor_ids: Vec<String>,
    current_linkdead_logout_actors: Vec<AuthorityActorSnapshot>,
    pending_combat_events: Vec<AuthorityCombatEventSnapshot>,
    pending_ability_queue_events: Vec<AuthorityAbilityQueueEventSnapshot>,
    pending_survey_result: Option<AuthoritySurveyResultSnapshot>,
    pending_craft_session: Option<AuthorityCraftSessionSnapshot>,
    pending_splice_session: Option<AuthoritySpliceSessionSnapshot>,
    pending_genome_scan: Option<AuthorityGenomeScanSnapshot>,
    pending_harvest: Option<AuthorityHarvestSnapshot>,
    pending_factory_receipt: Option<AuthorityFactoryManufactureSnapshot>,
    pending_parcel_claim: Option<AuthorityParcelClaimSnapshot>,
    pending_dialogue_deliveries: Vec<AuthorityDialogueDelivery>,
    pending_trade_session_deliveries: Vec<AuthorityTradeSessionDelivery>,
    pending_duel_outcomes: Vec<AuthorityDuelOutcomeSnapshot>,
}

#[derive(Debug, Clone)]
pub struct SliceAuthorityState {
    runtime: AuthorityRuntimeState,
}

impl Deref for SliceAuthorityState {
    type Target = AuthorityRuntimeState;

    fn deref(&self) -> &Self::Target {
        &self.runtime
    }
}

impl DerefMut for SliceAuthorityState {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.runtime
    }
}

impl Deref for AuthorityRuntimeState {
    type Target = DurableAuthorityState;

    fn deref(&self) -> &Self::Target {
        &self.durable
    }
}

impl DerefMut for AuthorityRuntimeState {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.durable
    }
}

impl Deref for DurableAuthorityState {
    type Target = AuthoredWorldDefinition;

    fn deref(&self) -> &Self::Target {
        &self.world
    }
}

impl DerefMut for DurableAuthorityState {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.world
    }
}

mod farming_tests;
#[cfg(test)]
mod tests;
