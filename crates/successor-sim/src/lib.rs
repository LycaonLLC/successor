//! Simulation host and early Successor playable/readable slices.

#![forbid(unsafe_code)]
// Authority mutation methods deliberately receive their domain inputs
// explicitly. Narrow these signatures as their domain APIs mature.
#![allow(clippy::too_many_arguments)]

mod authority;
mod authority_bridge;
pub mod combat_ai;
pub mod command_manifest;
pub mod dialogue_corpus;
mod faction;
mod navigation;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[cfg(test)]
use successor_core::{
    CellCoord2, EntityId, Level, SpatialCategory, SpatialEntry, SpatialIndex, SpatialOccupancyKind,
    StateWriter, TickIndex, ZoneCell, ZoneId,
};
#[cfg(test)]
use successor_inventory::{
    ContainerId, InventoryActorId, InventoryState, ItemId, ItemVariantId, ReservationPurpose,
    StockKey,
};
use successor_net::{ClientCommand, ClientCommandEnvelope, PlayerId, SessionId};
use thiserror::Error;

pub use authority::debug_catalog;
pub use authority::{
    AbilityQueueEntryClass, AbilityQueueLifecycle, AuthorityAbilityQueueEntrySnapshot,
    AuthorityAbilityQueueEventSnapshot, AuthorityAbilityQueueSnapshot,
    AuthorityActiveExchangeSnapshot, AuthorityActorAppearanceSnapshot,
    AuthorityActorCapabilitySnapshot, AuthorityActorDeathStatsSnapshot, AuthorityActorFaceSnapshot,
    AuthorityActorPosture, AuthorityActorSnapshot, AuthorityActorStatsSnapshot,
    AuthorityActorUpsert, AuthorityActorWeaponSnapshot, AuthorityAreaResourceSpawnsSnapshot,
    AuthorityBleedSnapshot, AuthorityCheckpointBlob, AuthorityCheckpointError,
    AuthorityClosedExchangeSnapshot, AuthorityCombatEffectSnapshot, AuthorityCombatEventSnapshot,
    AuthorityCombatLifecycleKind, AuthorityCommandFrame, AuthorityCommandStatus,
    AuthorityExchangeMetricsSnapshot, AuthorityExchangeTotalsSnapshot, AuthorityLifeState,
    AuthorityNoClaimZoneSnapshot, AuthorityParcelClaimSnapshot, AuthorityPlacedCampSnapshot,
    AuthorityPlacedExtractorSnapshot, AuthorityRejectReason, AuthorityReplay,
    AuthorityResourceSpawnSnapshot, AuthorityResourceStatsSnapshot, AuthoritySleepSnapshot,
    AuthoritySuppressionSnapshot, AuthoritySurveyResultSnapshot, AuthorityVitals,
    AuthorityWeaponExchangeCounterSnapshot, AuthorityWeatherHazard, AuthorityWeatherShelterBox,
    NoDeadzoneAuditReport, SliceAuthorityActorError, SliceAuthorityAdvanceTiming,
    SliceAuthorityBuildError, SliceAuthorityConfig, SliceAuthorityMetrics, SliceAuthorityState,
};
pub use authority_bridge::{
    authority_bridge_script_json, AuthorityBridge, AuthorityBridgeActorInput,
    AuthorityBridgeActorOutput, AuthorityBridgeActorRequest, AuthorityBridgeConfigInput,
    AuthorityBridgeEnvelopeInput, AuthorityBridgeExchangeMetricsOutput,
    AuthorityBridgeExchangeMetricsRequest, AuthorityBridgeInputError, AuthorityBridgeJsonError,
    AuthorityBridgeRemoveActorRequest, AuthorityBridgeScriptInput, AuthorityBridgeScriptOutput,
    AuthorityBridgeStepOutput, AuthorityBridgeStepRequest, AuthorityBridgeTickOutput,
    AuthorityBridgeTickRequest,
};
pub use combat_ai::debug::{
    AuthorityAiActorDebugSnapshot, AuthorityAiDebugPosition, AuthorityAiSituationDebugSnapshot,
    AuthorityAiSquadDebugSnapshot, AuthorityAiTacticalCandidateDebug,
    SliceAuthorityAiDebugSnapshot,
};

#[cfg(test)]
const SLICE_SCHEMA: &str = "successor.slice.v1";
#[cfg(test)]
const AUTHORITY_TEST_AREA_ID: &str = "authority-test-overworld";
#[cfg(test)]
const AUTHORITY_TEST_INTERIOR_ID: &str = "authority-test-workshop";

/// Global claim-lattice quantum in cells (§A LAND WAVE). Every parcel origin snaps
/// to a multiple of this; every tier lot dim is an integer multiple (16/24/32 =
/// 2/3/4 quantum). Public because the claim-UX FE mirrors it for the live ghost.
pub const LATTICE_QUANTUM_CELLS: i32 = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceSnapshot {
    pub schema: String,
    pub tick: u64,
    pub tick_rate_hz: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub combat_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub combat_tuning: Option<CombatTuningSnapshot>,
    pub grid: GridSpec,
    pub zone: ZoneSpec,
    pub areas: Vec<AreaSpec>,
    pub state_hash: String,
    pub camera: CameraSpec,
    #[serde(default)]
    pub factions: Vec<FactionSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub player_organizations: Vec<PlayerOrganizationSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub population_templates: Vec<PopulationTemplateSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub spawn_zones: Vec<PopulationSpawnZoneSnapshot>,
    pub actors: Vec<ActorSnapshot>,
    #[serde(default)]
    pub props: Vec<PropSnapshot>,
    #[serde(default)]
    pub blocked_cells: Vec<BlockedCellSnapshot>,
    #[serde(default)]
    pub no_claim_zones: Vec<NoClaimZoneSnapshot>,
    #[serde(default)]
    pub transitions: Vec<AreaTransitionSnapshot>,
    #[serde(default)]
    pub clone_facilities: Vec<CloneFacilitySnapshot>,
    #[serde(default)]
    pub inventory: Vec<InventoryStackSnapshot>,
    #[serde(default)]
    pub reservations: Vec<ReservationSnapshot>,
    #[serde(default)]
    pub npc_jobs: Vec<NpcJobSnapshot>,
    #[serde(default)]
    pub events: Vec<TimelineEventSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GridSpec {
    pub cell_size_px: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoneSpec {
    pub id: u32,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub level: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AreaSpec {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub width: u32,
    pub height: u32,
    pub level: i32,
}

/// Central no-claim zone config (§B / §7 contract) — a SQUARE, snapped to the
/// lattice at build so no sub-quantum sliver ever borders it. Per-area: the starter
/// desert gets one; future maps choose. At the target 10k desert this becomes a
/// ~2km square (halfExtentCells 1024); on the current 1024 world it is smaller.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoClaimZoneSnapshot {
    pub area_id: String,
    pub center_x: i32,
    pub center_y: i32,
    /// Half-extent in cells: the square spans [center-half, center+half) per axis.
    pub half_extent_cells: u32,
    #[serde(default)]
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraSpec {
    pub follow_actor: String,
    pub zoom: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorVitalsSnapshot {
    pub health: i32,
    pub action: i32,
    pub spirit: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FactionSnapshot {
    pub id: String,
    pub label: String,
    #[serde(default = "default_faction_player_allowed")]
    pub player_allowed: bool,
    #[serde(default)]
    pub enemies: Vec<String>,
    #[serde(default)]
    pub allies: Vec<String>,
    #[serde(default = "default_faction_adjust_factor_milli")]
    pub adjust_factor_milli: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerOrganizationSnapshot {
    pub id: String,
    pub label: String,
    pub tag: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub member_actor_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ally_organization_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub enemy_organization_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PopulationTemplateSnapshot {
    pub id: String,
    pub label_prefix: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub labels: Vec<String>,
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub faction_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub social_group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pvp_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub player_organization_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub player_organization_tag: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub profession_ids: Vec<String>,
    #[serde(
        default,
        alias = "skillBoxes",
        alias = "learnedSkillBoxes",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub skill_box_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credits: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub career_goal_id: Option<String>,
    pub sprite: String,
    pub pose_set: String,
    pub direction: String,
    #[serde(default)]
    pub scale: Option<u32>,
    #[serde(default)]
    pub vitals: Option<ActorVitalsSnapshot>,
    #[serde(default)]
    pub max_vitals: Option<ActorVitalsSnapshot>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PopulationSpawnZoneSnapshot {
    pub id: String,
    pub actor_id_prefix: String,
    pub template_id: String,
    pub area_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidate_cells: Vec<CellSnapshot>,
    #[serde(default)]
    pub initial_count: u16,
    #[serde(default)]
    pub max_alive: u16,
    #[serde(default)]
    pub spawn_every_seconds: u64,
    #[serde(default)]
    pub batch_min: u16,
    #[serde(default)]
    pub batch_max: u16,
    #[serde(default)]
    pub seed: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activation: Option<PopulationSpawnZoneActivationSnapshot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PopulationSpawnZoneActivationSnapshot {
    pub radius_cells: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leash_radius_cells: Option<u32>,
    /// Deactivation radius (cells). The zone only goes dormant — and its
    /// alive actors release — once NO player is within this radius for
    /// `linger_ticks`. Defaults to `leash_radius_cells` so legacy fixtures
    /// keep their old despawn threshold; set larger (e.g. 96 for rogue
    /// zones) so a brief leash-out keeps actors alive and they leash back
    /// to post instead of vanishing on screen. Must be >= leash radius.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deactivation_radius_cells: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub release_ticks: Option<u64>,
    /// Linger (ticks) a zone stays active after the last player leaves the
    /// deactivation radius before its alive actors release. Defaults to
    /// `release_ticks` for backward compatibility.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linger_ticks: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check_every_ticks: Option<u64>,
}

fn default_population_spawn_zone_activation_check_every_ticks() -> u64 {
    10
}

impl PopulationSpawnZoneActivationSnapshot {
    pub fn check_every_ticks_or_default(&self) -> u64 {
        self.check_every_ticks
            .unwrap_or_else(default_population_spawn_zone_activation_check_every_ticks)
    }
}

fn default_faction_player_allowed() -> bool {
    true
}

fn default_faction_adjust_factor_milli() -> i32 {
    1_000
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorSnapshot {
    pub id: String,
    pub entity: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
    pub area_id: String,
    pub label: String,
    pub role: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub profession_ids: Vec<String>,
    #[serde(
        default,
        alias = "skillBoxes",
        alias = "learnedSkillBoxes",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub skill_box_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credits: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub career_goal_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub faction_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub social_group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pvp_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub player_organization_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub player_organization_tag: Option<String>,
    pub sprite: String,
    pub pose_set: String,
    pub direction: String,
    pub cell: CellSnapshot,
    pub route: Vec<CellSnapshot>,
    #[serde(default)]
    pub scale: Option<u32>,
    #[serde(default)]
    pub vitals: Option<ActorVitalsSnapshot>,
    #[serde(default)]
    pub max_vitals: Option<ActorVitalsSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_respawn_delay_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropSnapshot {
    pub id: String,
    pub entity: String,
    pub area_id: String,
    pub label: String,
    pub kind: String,
    pub cell: CellSnapshot,
    pub size: CellSizeSnapshot,
    pub interactive: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<CoverSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub collision_bounds: Vec<CollisionBoundsSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub door: Option<DoorSnapshot>,
    /// Authored loot container identity; legacy props derive `cache:<id>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverSnapshot {
    pub rating: u8,
    pub height: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoorSnapshot {
    pub blocker: CollisionBoundsSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollisionBoundsSnapshot {
    pub x_milli: i32,
    pub y_milli: i32,
    pub w_milli: i32,
    pub h_milli: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellSnapshot {
    pub x: serde_json::Number,
    pub y: serde_json::Number,
}

impl CellSnapshot {
    pub fn new(x: i32, y: i32) -> Self {
        Self {
            x: serde_json::Number::from(x),
            y: serde_json::Number::from(y),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedCellSnapshot {
    pub area_id: String,
    pub x: i32,
    pub y: i32,
}

impl BlockedCellSnapshot {
    pub fn new(area_id: &str, x: i32, y: i32) -> Self {
        Self {
            area_id: area_id.to_owned(),
            x,
            y,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AreaTransitionSnapshot {
    pub id: String,
    pub label: String,
    pub style: String,
    pub from_area_id: String,
    pub from_cell: CellSnapshot,
    pub trigger_size: CellSizeSnapshot,
    pub to_area_id: String,
    pub to_cell: CellSnapshot,
    pub to_facing: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneFacilitySnapshot {
    pub id: String,
    pub label: String,
    pub area_id: String,
    pub respawn_cell: CellSnapshot,
    pub respawn_facing: String,
    pub sickness_duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CombatTuningSnapshot {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub weapon_range_bands: BTreeMap<String, WeaponRangeBandTuningSnapshot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeaponRangeBandTuningSnapshot {
    pub point_blank_cells: i32,
    pub ideal_cells: i32,
    pub max_cells: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellSizeSnapshot {
    pub w: u32,
    pub h: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryStackSnapshot {
    #[serde(default)]
    pub stack_id: u64,
    pub container: String,
    pub item: String,
    pub item_id: u32,
    pub variant_id: u32,
    pub quantity: u32,
    pub reserved: u32,
    pub available: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReservationSnapshot {
    pub id: u32,
    pub actor: String,
    pub purpose: String,
    pub from: String,
    pub item: String,
    pub quantity: u32,
    pub expires_at_tick: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEventSnapshot {
    pub tick: u64,
    pub label: String,
    pub cell: Option<CellSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NpcJobSnapshot {
    pub actor: String,
    pub kind: String,
    pub label: String,
    pub target_prop_id: Option<String>,
    pub target_cell: Option<CellSnapshot>,
    pub priority: u32,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityReplayOutput {
    pub schema: String,
    pub config: AuthorityReplayConfig,
    pub replay: AuthorityReplaySummary,
    pub frames: Vec<AuthorityReplayFrameSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityReplayConfig {
    pub fixture: String,
    pub commands: usize,
    pub session: u64,
    pub player: u32,
    pub player_actor_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityReplaySummary {
    pub initial_state_hash: String,
    pub final_state_hash: String,
    pub replay_hash: String,
    pub repeat_replay_hash: String,
    pub native_repeat_matches: bool,
    pub accepted: usize,
    pub rejected: usize,
    pub final_area_id: String,
    pub final_x: f64,
    pub final_y: f64,
    pub final_direction: String,
    pub state_ticks: u64,
    pub actors: usize,
    pub areas: usize,
    pub transitions: usize,
    pub blocked_cells: usize,
    pub first_frame_hash: String,
    pub last_frame_hash: String,
    pub combat_events: u64,
    pub hits: u64,
    pub deaths: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityReplayFrameSummary {
    pub command_id: u64,
    pub tick: u64,
    pub status: AuthorityCommandStatus,
    pub reason_code: Option<String>,
    pub command_hash: String,
    pub bundle_hash: String,
    pub frame_hash: String,
    pub target_state_hash: String,
    pub section_subsystems: Vec<String>,
    pub combat_event_count: usize,
}

#[derive(Debug, Error)]
pub enum AuthorityReplayJsonError {
    #[error("slice fixture did not parse: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("authority state did not build: {0}")]
    Build(#[from] SliceAuthorityBuildError),
}

pub fn current_authority_replay_json(
    snapshot_json: &str,
) -> Result<String, AuthorityReplayJsonError> {
    let snapshot: SliceSnapshot = serde_json::from_str(snapshot_json)?;
    let output = current_authority_replay_output(
        &snapshot,
        "client/public/successor-slice/open-desert-slice.json",
    )?;
    serde_json::to_string_pretty(&output).map_err(AuthorityReplayJsonError::Parse)
}

pub fn current_authority_replay_output(
    snapshot: &SliceSnapshot,
    fixture: &str,
) -> Result<AuthorityReplayOutput, SliceAuthorityBuildError> {
    let config = SliceAuthorityConfig::default();
    let commands = current_authority_replay_commands(&config);
    let replay = run_authority_replay(snapshot, &config, commands.clone())?;
    let repeat = run_authority_replay(snapshot, &config, commands)?;
    let final_actor = replay
        .frames
        .last()
        .and_then(|frame| frame.actor.clone())
        .expect("current replay fixture always has a player actor frame");
    let summary = AuthorityReplaySummary {
        initial_state_hash: replay.initial_state_hash.clone(),
        final_state_hash: replay.final_state_hash.clone(),
        replay_hash: replay.replay_hash.clone(),
        repeat_replay_hash: repeat.replay_hash.clone(),
        native_repeat_matches: replay.replay_hash == repeat.replay_hash,
        accepted: replay
            .frames
            .iter()
            .filter(|frame| frame.status == AuthorityCommandStatus::Accepted)
            .count(),
        rejected: replay
            .frames
            .iter()
            .filter(|frame| frame.status == AuthorityCommandStatus::Rejected)
            .count(),
        final_area_id: final_actor.area_id,
        final_x: final_actor.x,
        final_y: final_actor.y,
        final_direction: final_actor.direction,
        state_ticks: replay.metrics.tick,
        actors: replay.metrics.actors,
        areas: replay.metrics.areas,
        transitions: replay.metrics.transitions,
        blocked_cells: replay.metrics.blocked_cells,
        combat_events: replay.metrics.combat_events,
        hits: replay.metrics.hits,
        deaths: replay.metrics.deaths,
        first_frame_hash: replay
            .frames
            .first()
            .map(|frame| frame.frame_hash.clone())
            .unwrap_or_default(),
        last_frame_hash: replay
            .frames
            .last()
            .map(|frame| frame.frame_hash.clone())
            .unwrap_or_default(),
    };
    let frames = replay
        .frames
        .iter()
        .map(|frame| AuthorityReplayFrameSummary {
            command_id: frame.command_id,
            tick: frame.tick,
            status: frame.status,
            reason_code: frame.reason_code.clone(),
            command_hash: frame.command_hash.clone(),
            bundle_hash: frame.bundle_hash.clone(),
            frame_hash: frame.frame_hash.clone(),
            target_state_hash: frame.target_state_hash.clone(),
            section_subsystems: frame
                .bundle
                .sections
                .iter()
                .map(|section| section.subsystem.clone())
                .collect(),
            combat_event_count: frame.combat_events.len(),
        })
        .collect();

    Ok(AuthorityReplayOutput {
        schema: "successor.authority-command-replay.v1".to_owned(),
        config: AuthorityReplayConfig {
            fixture: fixture.to_owned(),
            commands: replay.frames.len(),
            session: config.session.0,
            player: config.player.0,
            player_actor_id: config.player_actor_id,
        },
        replay: summary,
        frames,
    })
}

pub fn current_authority_replay_commands(
    config: &SliceAuthorityConfig,
) -> Vec<ClientCommandEnvelope> {
    let mut commands = vec![
        authority_envelope(
            config,
            1,
            ClientCommand::QueueCombatAction {
                action_id: "basic_shot".to_owned(),
                target_actor_id: "camp-trainer".to_owned(),
            },
        ),
        authority_envelope(
            config,
            1,
            ClientCommand::QueueCombatAction {
                action_id: "basic_shot".to_owned(),
                target_actor_id: "camp-trainer".to_owned(),
            },
        ),
        authority_envelope(
            config,
            2,
            ClientCommand::Move {
                dx: 1,
                dy: 0,
                duration_ticks: 1,
                facing: None,
                sprint: false,
            },
        ),
        authority_envelope(
            config,
            3,
            ClientCommand::Move {
                dx: 1,
                dy: 0,
                duration_ticks: 1,
                facing: None,
                sprint: false,
            },
        ),
        authority_envelope(
            config,
            4,
            ClientCommand::Move {
                dx: 1,
                dy: 0,
                duration_ticks: 1,
                facing: None,
                sprint: false,
            },
        ),
        authority_envelope(
            config,
            5,
            ClientCommand::EnterTransition {
                transition_id: "skirmish-missing-transition".to_owned(),
            },
        ),
        authority_envelope(config, 6, ClientCommand::Peace {}),
        authority_envelope(config, 6, ClientCommand::Peace {}),
    ];

    for command_id in 7..=24 {
        commands.push(authority_envelope(
            config,
            command_id,
            ClientCommand::EnterTransition {
                transition_id: format!("deterministic-wait-{command_id}"),
            },
        ));
    }

    commands
}

fn run_authority_replay(
    snapshot: &SliceSnapshot,
    config: &SliceAuthorityConfig,
    commands: Vec<ClientCommandEnvelope>,
) -> Result<AuthorityReplay, SliceAuthorityBuildError> {
    let mut state = SliceAuthorityState::from_snapshot(snapshot)?;
    Ok(state.apply_script(config, commands))
}

fn authority_envelope(
    config: &SliceAuthorityConfig,
    command_id: u64,
    command: ClientCommand,
) -> ClientCommandEnvelope {
    ClientCommandEnvelope {
        session: SessionId(config.session.0),
        player: PlayerId(config.player.0),
        command_id,
        issued_at_tick: 24 + command_id,
        command,
    }
}

#[cfg(test)]
pub(crate) fn authority_test_slice() -> SliceSnapshot {
    let tick = TickIndex(24);
    let zone = ZoneId(1);
    let level = Level(0);
    let mut spatial = SpatialIndex::new();

    let player = EntityId::first(1);
    let vendor = EntityId::first(2);
    let mechanic = EntityId::first(3);
    let runner = EntityId::first(4);
    let guard = EntityId::first(5);
    let kiosk = EntityId::first(10);
    let facade = EntityId::first(11);
    let door = EntityId::first(12);
    let sign = EntityId::first(13);
    let target = EntityId::first(14);
    let repair_counter = EntityId::first(15);
    let parts_locker = EntityId::first(16);
    let exit_door = EntityId::first(17);

    insert(
        &mut spatial,
        player,
        zone,
        level,
        37,
        21,
        SpatialCategory::Player,
        SpatialOccupancyKind::Exclusive,
    );
    insert(
        &mut spatial,
        vendor,
        zone,
        level,
        13,
        17,
        SpatialCategory::Npc,
        SpatialOccupancyKind::Exclusive,
    );
    insert(
        &mut spatial,
        mechanic,
        zone,
        level,
        9,
        5,
        SpatialCategory::Npc,
        SpatialOccupancyKind::Exclusive,
    );
    insert(
        &mut spatial,
        runner,
        zone,
        level,
        24,
        22,
        SpatialCategory::Npc,
        SpatialOccupancyKind::Exclusive,
    );
    insert(
        &mut spatial,
        guard,
        zone,
        level,
        11,
        20,
        SpatialCategory::Npc,
        SpatialOccupancyKind::Exclusive,
    );
    insert(
        &mut spatial,
        kiosk,
        zone,
        level,
        10,
        18,
        SpatialCategory::HarvestNode,
        SpatialOccupancyKind::Interaction,
    );
    insert(
        &mut spatial,
        facade,
        zone,
        level,
        35,
        14,
        SpatialCategory::CraftingStation,
        SpatialOccupancyKind::Blocking,
    );
    insert(
        &mut spatial,
        door,
        zone,
        level,
        39,
        18,
        SpatialCategory::Door,
        SpatialOccupancyKind::Blocking,
    );
    insert(
        &mut spatial,
        sign,
        zone,
        level,
        28,
        13,
        SpatialCategory::Prop,
        SpatialOccupancyKind::Marker,
    );
    insert(
        &mut spatial,
        target,
        zone,
        level,
        8,
        19,
        SpatialCategory::Prop,
        SpatialOccupancyKind::Interaction,
    );
    insert(
        &mut spatial,
        repair_counter,
        zone,
        level,
        3,
        4,
        SpatialCategory::CraftingStation,
        SpatialOccupancyKind::Interaction,
    );
    insert(
        &mut spatial,
        parts_locker,
        zone,
        level,
        13,
        4,
        SpatialCategory::HarvestNode,
        SpatialOccupancyKind::Interaction,
    );
    insert(
        &mut spatial,
        exit_door,
        zone,
        level,
        8,
        1,
        SpatialCategory::Door,
        SpatialOccupancyKind::Blocking,
    );

    let blocked_cells = authority_test_blocked_cells();
    for (offset, cell) in blocked_cells.iter().enumerate() {
        let entity =
            EntityId::first(100 + u32::try_from(offset).expect("blocked offset fits in u32"));
        insert(
            &mut spatial,
            entity,
            zone,
            level,
            cell.x,
            cell.y,
            SpatialCategory::Prop,
            SpatialOccupancyKind::Blocking,
        );
    }

    let mut inventory = InventoryState::new();
    inventory.add_container(ContainerId(100), "Successor pockets");
    inventory.add_container(ContainerId(200), "Back-alley stash");
    let scrap = StockKey::new(ItemId(1), ItemVariantId(0));
    let craft_fiber = StockKey::new(ItemId(2), ItemVariantId(0));
    let slugthrower_frame = StockKey::new(ItemId(3), ItemVariantId(0));
    let crafted_slugthrower = StockKey::new(ItemId(4), ItemVariantId(0));
    let vibrosword = StockKey::new(ItemId(5), ItemVariantId(0));
    let iron_slugs = StockKey::new(ItemId(6), ItemVariantId(0));
    let camp_supplies = StockKey::new(ItemId(7), ItemVariantId(0));
    inventory
        .put_stock(ContainerId(100), scrap, 3)
        .expect("demo inventory has pockets");
    inventory
        .put_stock(ContainerId(100), craft_fiber, 2)
        .expect("demo inventory has pockets");
    inventory
        .put_stock(ContainerId(200), slugthrower_frame, 1)
        .expect("demo inventory has stash");
    inventory
        .put_stock(ContainerId(100), crafted_slugthrower, 1)
        .expect("demo inventory has pockets");
    inventory
        .put_stock(ContainerId(200), vibrosword, 1)
        .expect("demo inventory has stash");
    inventory
        .put_stock(ContainerId(100), iron_slugs, 68)
        .expect("demo inventory has pockets");
    inventory
        .put_stock(ContainerId(200), camp_supplies, 30)
        .expect("demo inventory has stash");
    let scrap_reservation = inventory
        .reserve_stock(
            ContainerId(100),
            scrap,
            1,
            InventoryActorId(player.index()),
            ReservationPurpose::Craft,
            Some(TickIndex(45)),
        )
        .expect("demo inventory can reserve scrap");
    let craft_fiber_reservation = inventory
        .reserve_stock(
            ContainerId(100),
            craft_fiber,
            1,
            InventoryActorId(player.index()),
            ReservationPurpose::Craft,
            Some(TickIndex(45)),
        )
        .expect("demo inventory can reserve fiber");

    let spatial_hash = spatial.stable_hash_hex();
    let inventory_hash = inventory.stable_hash_hex();
    let state_hash = slice_hash(tick, &spatial_hash, &inventory_hash);

    SliceSnapshot {
        schema: SLICE_SCHEMA.to_owned(),
        tick: tick.0,
        tick_rate_hz: 30,
        combat_model: Some("roll".to_owned()),
        combat_tuning: None,
        grid: GridSpec { cell_size_px: 60 },
        zone: ZoneSpec {
            id: zone.0,
            name: "Authority Test Field".to_owned(),
            width: 64,
            height: 36,
            level: level.0,
        },
        areas: vec![
            area(
                AUTHORITY_TEST_AREA_ID,
                "Authority Test Field",
                "overworld",
                64,
                36,
                level.0,
            ),
            area(
                AUTHORITY_TEST_INTERIOR_ID,
                "Authority Test Workshop",
                "public_interior",
                18,
                12,
                level.0,
            ),
        ],
        state_hash,
        camera: CameraSpec {
            follow_actor: "player".to_owned(),
            zoom: 72,
        },
        factions: Vec::new(),
        player_organizations: Vec::new(),
        population_templates: Vec::new(),
        spawn_zones: Vec::new(),
        actors: vec![
            ActorSnapshot {
                id: "player".to_owned(),
                entity: entity_label(player),
                template_id: None,
                area_id: AUTHORITY_TEST_AREA_ID.to_owned(),
                label: "Test Player".to_owned(),
                role: "player".to_owned(),
                profession_ids: Vec::new(),
                skill_box_ids: Vec::new(),
                credits: None,
                capabilities: Vec::new(),
                career_goal_id: None,
                faction_id: None,
                social_group: None,
                pvp_status: None,
                player_organization_id: None,
                player_organization_tag: None,
                sprite: "adventurer-premium-male".to_owned(),
                pose_set: "walk".to_owned(),
                direction: "right".to_owned(),
                cell: CellSnapshot::new(37, 21),
                route: vec![
                    CellSnapshot::new(37, 21),
                    CellSnapshot::new(38, 21),
                    CellSnapshot::new(39, 20),
                    CellSnapshot::new(40, 20),
                    CellSnapshot::new(41, 21),
                ],
                scale: None,
                vitals: None,
                max_vitals: None,
                initial_respawn_delay_ms: None,
            },
            ActorSnapshot {
                id: "vendor".to_owned(),
                entity: entity_label(vendor),
                template_id: None,
                area_id: AUTHORITY_TEST_AREA_ID.to_owned(),
                label: "Test Vendor".to_owned(),
                role: "public_shopkeeper".to_owned(),
                profession_ids: Vec::new(),
                skill_box_ids: Vec::new(),
                credits: None,
                capabilities: Vec::new(),
                career_goal_id: None,
                faction_id: None,
                social_group: None,
                pvp_status: None,
                player_organization_id: None,
                player_organization_tag: None,
                sprite: "adventurer-premium-female".to_owned(),
                pose_set: "idle".to_owned(),
                direction: "front".to_owned(),
                cell: CellSnapshot::new(13, 17),
                route: Vec::new(),
                scale: None,
                vitals: None,
                max_vitals: None,
                initial_respawn_delay_ms: None,
            },
            ActorSnapshot {
                id: "mechanic".to_owned(),
                entity: entity_label(mechanic),
                template_id: None,
                area_id: AUTHORITY_TEST_INTERIOR_ID.to_owned(),
                label: "Test Shopkeeper".to_owned(),
                role: "public_shopkeeper".to_owned(),
                profession_ids: Vec::new(),
                skill_box_ids: Vec::new(),
                credits: None,
                capabilities: Vec::new(),
                career_goal_id: None,
                faction_id: None,
                social_group: None,
                pvp_status: None,
                player_organization_id: None,
                player_organization_tag: None,
                sprite: "adventurer-premium-female".to_owned(),
                pose_set: "idle".to_owned(),
                direction: "front".to_owned(),
                cell: CellSnapshot::new(9, 5),
                route: Vec::new(),
                scale: None,
                vitals: None,
                max_vitals: None,
                initial_respawn_delay_ms: None,
            },
            ActorSnapshot {
                id: "runner".to_owned(),
                entity: entity_label(runner),
                template_id: None,
                area_id: AUTHORITY_TEST_AREA_ID.to_owned(),
                label: "Test Runner".to_owned(),
                role: "scripted_player".to_owned(),
                profession_ids: Vec::new(),
                skill_box_ids: Vec::new(),
                credits: None,
                capabilities: Vec::new(),
                career_goal_id: None,
                faction_id: None,
                social_group: None,
                pvp_status: None,
                player_organization_id: None,
                player_organization_tag: None,
                sprite: "adventurer-premium-male".to_owned(),
                pose_set: "walk".to_owned(),
                direction: "right".to_owned(),
                cell: CellSnapshot::new(24, 22),
                route: vec![
                    CellSnapshot::new(24, 22),
                    CellSnapshot::new(28, 22),
                    CellSnapshot::new(31, 21),
                    CellSnapshot::new(28, 20),
                    CellSnapshot::new(24, 21),
                ],
                scale: None,
                vitals: None,
                max_vitals: None,
                initial_respawn_delay_ms: None,
            },
            ActorSnapshot {
                id: "range-guard".to_owned(),
                entity: entity_label(guard),
                template_id: None,
                area_id: AUTHORITY_TEST_AREA_ID.to_owned(),
                label: "Test Guard".to_owned(),
                role: "range_guard".to_owned(),
                profession_ids: Vec::new(),
                skill_box_ids: Vec::new(),
                credits: None,
                capabilities: Vec::new(),
                career_goal_id: None,
                faction_id: None,
                social_group: None,
                pvp_status: None,
                player_organization_id: None,
                player_organization_tag: None,
                sprite: "adventurer-premium-male".to_owned(),
                pose_set: "idle".to_owned(),
                direction: "right".to_owned(),
                cell: CellSnapshot::new(11, 20),
                route: vec![
                    CellSnapshot::new(11, 20),
                    CellSnapshot::new(14, 20),
                    CellSnapshot::new(14, 18),
                    CellSnapshot::new(11, 18),
                ],
                scale: None,
                vitals: None,
                max_vitals: None,
                initial_respawn_delay_ms: None,
            },
        ],
        props: vec![
            prop(
                "scrap-kiosk",
                kiosk,
                AUTHORITY_TEST_AREA_ID,
                "Scrap Kiosk",
                "harvest_node",
                10,
                18,
                2,
                2,
                true,
            ),
            prop(
                "test-workshop-facade",
                facade,
                AUTHORITY_TEST_AREA_ID,
                "Authority Test Workshop",
                "building",
                35,
                14,
                10,
                6,
                false,
            ),
            prop(
                "test-workshop-door",
                door,
                AUTHORITY_TEST_AREA_ID,
                "Workshop Door",
                "door",
                39,
                18,
                2,
                2,
                true,
            ),
            prop(
                "repair-counter",
                repair_counter,
                AUTHORITY_TEST_INTERIOR_ID,
                "Repair Counter",
                "crafting_station",
                3,
                4,
                4,
                2,
                true,
            ),
            prop(
                "parts-locker",
                parts_locker,
                AUTHORITY_TEST_INTERIOR_ID,
                "Parts Locker",
                "harvest_node",
                13,
                4,
                2,
                2,
                true,
            ),
            prop(
                "street-exit",
                exit_door,
                AUTHORITY_TEST_INTERIOR_ID,
                "Street Exit",
                "door",
                8,
                1,
                2,
                1,
                true,
            ),
            prop(
                "test-sign",
                sign,
                AUTHORITY_TEST_AREA_ID,
                "Test Sign",
                "sign",
                28,
                13,
                3,
                1,
                false,
            ),
            prop(
                "tin-totem",
                target,
                AUTHORITY_TEST_AREA_ID,
                "Test Target",
                "target",
                8,
                19,
                1,
                1,
                true,
            ),
        ],
        blocked_cells,
        no_claim_zones: Vec::new(),
        transitions: vec![
            transition(
                "test-workshop-entry",
                "Enter Test Workshop",
                "door_fade",
                AUTHORITY_TEST_AREA_ID,
                CellSnapshot::new(39, 20),
                CellSizeSnapshot { w: 2, h: 1 },
                AUTHORITY_TEST_INTERIOR_ID,
                CellSnapshot::new(9, 8),
                "back",
            ),
            transition(
                "test-workshop-exit",
                "Exit to Test Field",
                "door_fade",
                AUTHORITY_TEST_INTERIOR_ID,
                CellSnapshot::new(8, 2),
                CellSizeSnapshot { w: 2, h: 1 },
                AUTHORITY_TEST_AREA_ID,
                CellSnapshot::new(39, 21),
                "front",
            ),
        ],
        clone_facilities: Vec::new(),
        inventory: inventory_rows(&inventory),
        reservations: vec![
            reservation_row(
                scrap_reservation.0,
                "player",
                "craft",
                "Successor pockets",
                "scrap_chip",
                1,
                Some(45),
            ),
            reservation_row(
                craft_fiber_reservation.0,
                "player",
                "craft",
                "Successor pockets",
                "craft_fiber",
                1,
                Some(45),
            ),
        ],
        npc_jobs: vec![
            npc_job(
                "vendor",
                "trade_idle",
                "Watch scrap kiosk demand",
                Some("scrap-kiosk"),
                Some(CellSnapshot::new(10, 18)),
                42,
                "reserved",
            ),
            npc_job(
                "mechanic",
                "craft_service",
                "Inspect long-gun frame",
                Some("repair-counter"),
                Some(CellSnapshot::new(3, 4)),
                78,
                "working",
            ),
            npc_job(
                "runner",
                "haul",
                "Carry shells from stash route",
                Some("test-workshop-door"),
                Some(CellSnapshot::new(39, 18)),
                55,
                "moving",
            ),
            npc_job(
                "range-guard",
                "combat_watch",
                "Keep the target lane clear",
                Some("tin-totem"),
                Some(CellSnapshot::new(8, 19)),
                61,
                "watching",
            ),
        ],
        events: vec![
            event(
                0,
                "spawned in authority test field",
                Some(CellSnapshot::new(6, 9)),
            ),
            event(8, "scrap kiosk scanned", Some(CellSnapshot::new(10, 9))),
            event(
                16,
                "craft ingredients reserved",
                Some(CellSnapshot::new(21, 11)),
            ),
            event(24, "server slice snapshot emitted", None),
        ],
    }
}

#[cfg(test)]
fn insert(
    spatial: &mut SpatialIndex,
    entity: EntityId,
    zone: ZoneId,
    level: Level,
    x: i32,
    y: i32,
    category: SpatialCategory,
    occupancy: SpatialOccupancyKind,
) {
    spatial.insert(SpatialEntry::new(
        entity,
        ZoneCell::new(zone, level, CellCoord2::new(x, y)),
        category,
        occupancy,
    ));
}

#[cfg(test)]
fn slice_hash(tick: TickIndex, spatial_hash: &str, inventory_hash: &str) -> String {
    let mut w = StateWriter::new();
    w.write_domain_header(b"slice")
        .write_schema_version(1)
        .write_tick(tick.0)
        .write_u32(u32::try_from(SLICE_SCHEMA.len()).expect("schema length fits in u32"))
        .write_bytes(SLICE_SCHEMA.as_bytes())
        .write_u32(u32::try_from(spatial_hash.len()).expect("hash length fits in u32"))
        .write_bytes(spatial_hash.as_bytes())
        .write_u32(u32::try_from(inventory_hash.len()).expect("hash length fits in u32"))
        .write_bytes(inventory_hash.as_bytes());
    w.finalize_hex()
}

#[cfg(test)]
fn entity_label(entity: EntityId) -> String {
    format!("{}:{}", entity.index(), entity.generation().get())
}

#[cfg(test)]
fn area(id: &str, name: &str, kind: &str, width: u32, height: u32, level: i32) -> AreaSpec {
    AreaSpec {
        id: id.to_owned(),
        name: name.to_owned(),
        kind: kind.to_owned(),
        width,
        height,
        level,
    }
}

#[cfg(test)]
fn prop(
    id: &str,
    entity: EntityId,
    area_id: &str,
    label: &str,
    kind: &str,
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    interactive: bool,
) -> PropSnapshot {
    PropSnapshot {
        id: id.to_owned(),
        entity: entity_label(entity),
        area_id: area_id.to_owned(),
        label: label.to_owned(),
        kind: kind.to_owned(),
        cell: CellSnapshot::new(x, y),
        size: CellSizeSnapshot { w, h },
        interactive,
        cover: None,
        collision_bounds: Vec::new(),
        door: None,
        container: None,
    }
}

#[cfg(test)]
fn transition(
    id: &str,
    label: &str,
    style: &str,
    from_area_id: &str,
    from_cell: CellSnapshot,
    trigger_size: CellSizeSnapshot,
    to_area_id: &str,
    to_cell: CellSnapshot,
    to_facing: &str,
) -> AreaTransitionSnapshot {
    AreaTransitionSnapshot {
        id: id.to_owned(),
        label: label.to_owned(),
        style: style.to_owned(),
        from_area_id: from_area_id.to_owned(),
        from_cell,
        trigger_size,
        to_area_id: to_area_id.to_owned(),
        to_cell,
        to_facing: to_facing.to_owned(),
    }
}

#[cfg(test)]
fn reservation_row(
    id: u32,
    actor: &str,
    purpose: &str,
    from: &str,
    item: &str,
    quantity: u32,
    expires_at_tick: Option<u64>,
) -> ReservationSnapshot {
    ReservationSnapshot {
        id,
        actor: actor.to_owned(),
        purpose: purpose.to_owned(),
        from: from.to_owned(),
        item: item.to_owned(),
        quantity,
        expires_at_tick,
    }
}

#[cfg(test)]
fn event(tick: u64, label: &str, cell: Option<CellSnapshot>) -> TimelineEventSnapshot {
    TimelineEventSnapshot {
        tick,
        label: label.to_owned(),
        cell,
    }
}

#[cfg(test)]
fn npc_job(
    actor: &str,
    kind: &str,
    label: &str,
    target_prop_id: Option<&str>,
    target_cell: Option<CellSnapshot>,
    priority: u32,
    state: &str,
) -> NpcJobSnapshot {
    NpcJobSnapshot {
        actor: actor.to_owned(),
        kind: kind.to_owned(),
        label: label.to_owned(),
        target_prop_id: target_prop_id.map(str::to_owned),
        target_cell,
        priority,
        state: state.to_owned(),
    }
}

#[cfg(test)]
fn inventory_rows(inventory: &InventoryState) -> Vec<InventoryStackSnapshot> {
    let mut rows = Vec::new();
    for container_id in [ContainerId(100), ContainerId(200)] {
        let Some(container) = inventory.container(container_id) else {
            continue;
        };
        let mut next_stack_id = 1_u64;
        for stack in container.stacks.values() {
            rows.push(InventoryStackSnapshot {
                stack_id: {
                    let stack_id = next_stack_id;
                    next_stack_id = next_stack_id.saturating_add(1);
                    stack_id
                },
                container: container.label.clone(),
                item: item_name(stack.key.item).to_owned(),
                item_id: stack.key.item.0,
                variant_id: stack.key.variant.0,
                quantity: stack.quantity,
                reserved: stack.reserved,
                available: stack.available_quantity(),
            });
        }
    }
    rows
}

#[cfg(test)]
fn item_name(item: ItemId) -> &'static str {
    match item.0 {
        1 => "scrap_chip",
        2 => "craft_fiber",
        3 => "slugthrower_frame",
        4 => "crafted_slugthrower",
        5 => "vibrosword",
        6 => "iron_slug",
        7 => "camp_supply",
        _ => "unknown_item",
    }
}

#[cfg(test)]
fn authority_test_blocked_cells() -> Vec<BlockedCellSnapshot> {
    let mut cells = Vec::new();
    for x in 0..64 {
        cells.push(BlockedCellSnapshot::new(AUTHORITY_TEST_AREA_ID, x, 0));
        cells.push(BlockedCellSnapshot::new(AUTHORITY_TEST_AREA_ID, x, 35));
    }
    for y in 1..35 {
        cells.push(BlockedCellSnapshot::new(AUTHORITY_TEST_AREA_ID, 0, y));
        cells.push(BlockedCellSnapshot::new(AUTHORITY_TEST_AREA_ID, 63, y));
    }
    for x in 3..9 {
        cells.push(BlockedCellSnapshot::new(AUTHORITY_TEST_AREA_ID, x, 15));
    }
    for x in 22..29 {
        cells.push(BlockedCellSnapshot::new(AUTHORITY_TEST_AREA_ID, x, 25));
    }
    for y in 12..18 {
        cells.push(BlockedCellSnapshot::new(AUTHORITY_TEST_AREA_ID, 51, y));
    }

    for x in 0..18 {
        cells.push(BlockedCellSnapshot::new(AUTHORITY_TEST_INTERIOR_ID, x, 0));
        cells.push(BlockedCellSnapshot::new(AUTHORITY_TEST_INTERIOR_ID, x, 11));
    }
    for y in 1..11 {
        cells.push(BlockedCellSnapshot::new(AUTHORITY_TEST_INTERIOR_ID, 0, y));
        cells.push(BlockedCellSnapshot::new(AUTHORITY_TEST_INTERIOR_ID, 17, y));
    }
    for x in 3..6 {
        cells.push(BlockedCellSnapshot::new(AUTHORITY_TEST_INTERIOR_ID, x, 7));
    }
    for x in 12..15 {
        cells.push(BlockedCellSnapshot::new(AUTHORITY_TEST_INTERIOR_ID, x, 7));
    }
    cells
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authority_test_slice_is_deterministic_and_roll_current() {
        let left = authority_test_slice();
        let right = authority_test_slice();
        assert_eq!(left, right);
        assert_eq!(left.schema, SLICE_SCHEMA);
        assert_eq!(left.areas.len(), 2);
        assert_eq!(left.transitions.len(), 2);
        assert_eq!(left.actors.len(), 5);
        assert_eq!(left.npc_jobs.len(), 4);
        assert_eq!(left.combat_model.as_deref(), Some("roll"));
        assert_eq!(
            left.inventory.iter().map(|row| row.quantity).sum::<u32>(),
            106
        );
    }

    #[test]
    fn authority_test_slice_json_round_trips() {
        let json = serde_json::to_string_pretty(&authority_test_slice()).unwrap();
        let snapshot: SliceSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(snapshot, authority_test_slice());
    }

    #[test]
    fn historical_prop_json_defaults_authored_container_to_none() {
        let legacy = r#"{
            "id": "legacy-cache",
            "entity": "cache:legacy-cache",
            "areaId": "arena",
            "label": "Legacy Cache",
            "kind": "storage_chest",
            "cell": { "x": 1, "y": 2 },
            "size": { "w": 1, "h": 1 },
            "interactive": true
        }"#;
        let prop: PropSnapshot = serde_json::from_str(legacy).unwrap();
        assert_eq!(prop.container, None);
    }

    #[test]
    fn current_open_desert_fixture_matches_slice_schema() {
        let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
        let snapshot: SliceSnapshot = serde_json::from_str(fixture).unwrap();
        assert_eq!(snapshot.schema, SLICE_SCHEMA);
        assert!(snapshot
            .areas
            .iter()
            .any(|area| area.id == "open-desert-overworld"));
        assert!(!snapshot.state_hash.is_empty());
        let overworld = snapshot
            .areas
            .iter()
            .find(|area| area.id == "open-desert-overworld")
            .expect("active fixture should declare overworld area");
        assert_eq!(overworld.width, 1_024);
        assert_eq!(overworld.height, 1_024);
        assert!(snapshot.props.iter().all(|prop| {
            let width = prop.size.w;
            let height = prop.size.h;
            width > 0
                && height > 0
                && prop.cover.is_none()
                && !matches!(
                    prop.id.as_str(),
                    "open-desert-camp-fallen-block"
                        | "open-desert-camp-road-barrier"
                        | "open-desert-camp-plinth"
                        | "open-desert-camp-brick"
                        | "open-desert-camp-brick-shard"
                )
                && !prop.id.starts_with("open-desert-cache-")
                && prop.collision_bounds.iter().all(|bounds| {
                    bounds.w_milli > 0
                        && bounds.h_milli > 0
                        && bounds.x_milli >= 0
                        && bounds.y_milli >= 0
                        && bounds.x_milli + bounds.w_milli <= (width as i32) * 1_000
                        && bounds.y_milli + bounds.h_milli <= (height as i32) * 1_000
                })
        }));
        assert!(snapshot.factions.iter().any(|faction| {
            faction.id == "desert_wardens" && faction.enemies.contains(&"rogue_troopers".to_owned())
        }));
        assert!(snapshot.factions.iter().any(|faction| {
            faction.id == "rogue_troopers"
                && !faction.player_allowed
                && faction.enemies.contains(&"desert_wardens".to_owned())
        }));
        assert_eq!(snapshot.areas.len(), 2);
        assert_eq!(snapshot.actors.len(), 3);
        assert!(snapshot
            .actors
            .iter()
            .any(|actor| actor.id == "player" && actor.area_id == "open-desert-overworld"));
        assert_eq!(snapshot.transitions.len(), 0);
        assert_eq!(snapshot.clone_facilities.len(), 1);
        for prop_id in [
            "dustgate-commerce-facility",
            "dustgate-bank-terminal",
            "dustgate-trade-terminal",
            "dustgate-pa-terminal",
            "dustgate-cloning-facility",
            "dustgate-clone-terminal",
            "dustgate-clone-pod",
        ] {
            assert!(
                snapshot.props.iter().any(|prop| prop.id == prop_id),
                "current fixture should declare {prop_id}"
            );
        }
        assert!(snapshot.actors.iter().any(|actor| {
            actor.id == "camp-trainer"
                && actor.role == "profession_trainer"
                && actor.area_id == "open-desert-overworld"
        }));
        assert!(snapshot.actors.iter().any(|actor| {
            actor.id == "grok"
                && actor.label == "GR0K"
                && actor.role == "scripted_player"
                && actor.sprite == "droid-grok-humanoid"
                && actor.area_id == "open-desert-overworld"
        }));
        assert_eq!(snapshot.population_templates.len(), 7);
        assert_eq!(snapshot.spawn_zones.len(), 91);
        assert_eq!(snapshot.combat_model.as_deref(), Some("roll"));
        assert!(snapshot.actors.iter().all(|actor| {
            actor.id == "player"
                || actor.role == "profession_trainer"
                || actor.role == "agent_player"
                || actor.role == "creature"
                || (actor.id == "grok" && actor.role == "scripted_player")
        }));
    }
}
