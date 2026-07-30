use crate::authority::{
    inventory_resource_stats_snapshot, AuthorityBankSnapshot, AuthorityBuildDeltaPayload,
    AuthorityCraftSessionSnapshot, AuthorityDialogueDelivery, AuthorityDraftedSchematicSnapshot,
    AuthorityDuelOutcomeSnapshot, AuthorityDuelViewSnapshot, AuthorityExchangeMetricsSnapshot,
    AuthorityFactoryManufactureSnapshot, AuthorityFarmPlotSnapshot, AuthorityGenomeScanSnapshot,
    AuthorityGroupViewSnapshot, AuthorityGuildViewSnapshot, AuthorityNoClaimZoneSnapshot,
    AuthorityParcelClaimSnapshot, AuthorityParcelSnapshot, AuthorityPlayerCorpseSnapshot,
    AuthoritySpliceSessionSnapshot, AuthorityTradeSessionDelivery, AuthorityTradeSessionSnapshot,
    ExchangeMetricsStore,
};
use crate::authority::{AuthorityActorWornPiece, AuthorityFixtureLoadoutItem};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant;
use successor_net::{
    AuthorityAmmoTypeId, AuthorityWeaponId, BuildPalette, CardinalDirection, ClientCommand,
    ClientCommandEnvelope, PlayerId, SessionId, TradeItemSpec,
};
use thiserror::Error;

#[cfg(test)]
use crate::AuthorityActorFaceSnapshot;
use crate::{
    AuthorityAbilityQueueEventSnapshot, AuthorityActorAppearanceSnapshot, AuthorityActorSnapshot,
    AuthorityActorUpsert, AuthorityAreaResourceSpawnsSnapshot, AuthorityCheckpointBlob,
    AuthorityCheckpointError, AuthorityCombatEventSnapshot, AuthorityCommandStatus,
    AuthorityPlacedCampSnapshot, AuthorityPlacedExtractorSnapshot, AuthorityRejectReason,
    AuthorityResourceSpawnSnapshot, AuthorityResourceStatsSnapshot, AuthoritySurveyResultSnapshot,
    AuthorityVitals, AuthorityWeatherHazard, InventoryStackSnapshot, NpcJobSnapshot,
    ReservationSnapshot, SliceAuthorityActorError, SliceAuthorityAdvanceTiming,
    SliceAuthorityAiDebugSnapshot, SliceAuthorityBuildError, SliceAuthorityConfig,
    SliceAuthorityMetrics, SliceAuthorityState, SliceSnapshot, TimelineEventSnapshot,
};

const BRIDGE_STEP_SCHEMA: &str = "successor.rust-authority-bridge-step.v1";
const BRIDGE_TICK_SCHEMA: &str = "successor.rust-authority-bridge-tick.v1";
const BRIDGE_ACTOR_SCHEMA: &str = "successor.rust-authority-bridge-actor.v1";
const BRIDGE_BATCH_SCHEMA: &str = "successor.rust-authority-bridge-batch.v1";
const BRIDGE_SCRIPT_SCHEMA: &str = "successor.rust-authority-bridge-script.v1";
const BRIDGE_DEBUG_SCHEMA: &str = "successor.rust-authority-bridge-debug.v1";
const BRIDGE_DOOR_STATE_SCHEMA: &str = "successor.rust-authority-bridge-door-state.v1";
const BRIDGE_EXPORT_STATE_SCHEMA: &str = "authority.bridge-export-state.v1";
const BRIDGE_IMPORT_STATE_SCHEMA: &str = "authority.bridge-import-state.v1";
const BRIDGE_EXCHANGE_METRICS_SCHEMA: &str = "successor.rust-authority-bridge-exchange-metrics.v1";
const EXCHANGE_METRICS_TIMEOUT_TICKS: u64 = 300;

#[derive(Debug)]
pub struct AuthorityBridge {
    state: SliceAuthorityState,
    exchange_metrics: Option<ExchangeMetricsStore>,
    last_delivered_timeline_events: Vec<TimelineEventSnapshot>,
}

impl AuthorityBridge {
    pub fn from_snapshot(snapshot: &SliceSnapshot) -> Result<Self, SliceAuthorityBuildError> {
        Self::from_snapshot_with_exchange_metrics(snapshot, true)
    }

    fn from_snapshot_with_exchange_metrics(
        snapshot: &SliceSnapshot,
        enabled: bool,
    ) -> Result<Self, SliceAuthorityBuildError> {
        Ok(Self {
            state: SliceAuthorityState::from_snapshot(snapshot)?,
            exchange_metrics: enabled.then(ExchangeMetricsStore::default),
            last_delivered_timeline_events: Vec::new(),
        })
    }

    pub fn from_snapshot_json(snapshot_json: &str) -> Result<Self, AuthorityBridgeJsonError> {
        let snapshot: SliceSnapshot =
            serde_json::from_str(snapshot_json).map_err(AuthorityBridgeJsonError::Parse)?;
        Self::from_snapshot(&snapshot).map_err(AuthorityBridgeJsonError::Build)
    }

    /// Dev/QA override for the farm cadence (F-Time §H "dev-overridable for fast
    /// QA"). Sets realSecondsPerGameDay on the underlying authority; a scratch
    /// fixture uses this so a crop matures in seconds instead of real hours. NOT
    /// a gameplay path — a deterministic sim input (like tick_rate_hz), not hashed.
    pub fn set_farm_real_seconds_per_game_day(&mut self, seconds: u32) {
        self.state.set_farm_real_seconds_per_game_day(seconds);
    }

    pub fn export_state(
        &self,
        request: AuthorityBridgeExportStateRequest,
    ) -> AuthorityBridgeExportStateOutput {
        let state = self.state.export_checkpoint();
        AuthorityBridgeExportStateOutput {
            schema: BRIDGE_EXPORT_STATE_SCHEMA.to_owned(),
            request_id: request.request_id,
            tick: state.tick(),
            state_hash: state.state_hash().to_owned(),
            state,
        }
    }

    pub fn import_state(
        &mut self,
        request: AuthorityBridgeImportStateRequest,
    ) -> Result<AuthorityBridgeImportStateOutput, AuthorityBridgeInputError> {
        let request_id = request.request_id;
        let supplied_state_hash = request.state.state_hash().to_owned();
        if let Some(expected) = request.expected_state_hash {
            if expected != supplied_state_hash {
                return Err(AuthorityBridgeInputError::StateHashMismatch {
                    expected,
                    actual: supplied_state_hash,
                });
            }
        }
        self.state.restore_checkpoint(request.state)?;
        self.reset_exchange_metrics();
        let output = self.import_state_output(request_id);
        self.last_delivered_timeline_events
            .clone_from(&output.timeline_events);
        Ok(output)
    }

    fn import_state_output(&self, request_id: Option<u64>) -> AuthorityBridgeImportStateOutput {
        let config = SliceAuthorityConfig {
            player_actor_id: "__authority_import_observer__".to_owned(),
            area_interest_radius_cells: i32::MAX,
            ..SliceAuthorityConfig::default()
        };
        AuthorityBridgeImportStateOutput {
            schema: BRIDGE_IMPORT_STATE_SCHEMA.to_owned(),
            request_id,
            tick: self.state.tick(),
            target_state_hash: self.state.stable_state_hash_hex(),
            actors: self.state.actor_snapshots_for_observer(&config),
            removed_actor_ids: Vec::new(),
            logout_actors: Vec::new(),
            combat_events: Vec::new(),
            ability_queue_events: Vec::new(),
            inventory: self.inventory_snapshots(),
            reservations: self.state.reservation_snapshots(),
            npc_jobs: self.state.npc_job_snapshots(),
            timeline_events: self.state.timeline_event_snapshots(),
            resource_spawns: self.state.resource_spawn_snapshots_for_observer(&config),
            area_resource_spawns: self.state.area_resource_spawn_snapshots(),
            placed_extractors: self.state.placed_extractor_snapshots_for_observer(&config),
            placed_camps: self.state.placed_camp_snapshots_for_observer(&config),
            placed_parcels: self.state.parcel_snapshots_for_observer(&config),
            farm_plots: self.state.farm_plot_snapshots_for_observer(&config),
            building: Some(self.state.build_delta_for_observer(&config)),
            no_claim_zones: self.state.no_claim_zone_snapshots_for_observer(&config),
            factory_receipt: None,
            drafted_schematics: self.state.drafted_schematic_snapshots(),
            group_views_by_actor_id: self.state.group_views_by_actor_id(),
            guild_views_by_actor_id: self.state.guild_views_by_actor_id(),
            duel_views_by_actor_id: self.state.duel_views_by_actor_id(),
            metrics: self.state.metrics(),
            bank: self.state.bank_snapshot_for_observer(&config),
            corpses: self.state.all_player_corpse_snapshots(),
        }
    }

    fn inventory_snapshots(&self) -> Vec<AuthorityBridgeInventorySnapshot> {
        self.state
            .inventory_snapshots()
            .into_iter()
            .map(|row| {
                let (equipped, colors) = self.state.inventory_clothing_state_exact(
                    &row.container,
                    row.item_id,
                    row.stack_id,
                    row.variant_id,
                );
                AuthorityBridgeInventorySnapshot {
                    equipped,
                    colors,
                    ..AuthorityBridgeInventorySnapshot::from(row)
                }
            })
            .collect()
    }

    fn timeline_events_if_changed(&mut self) -> Option<Vec<TimelineEventSnapshot>> {
        if self.state.timeline_events() == self.last_delivered_timeline_events.as_slice() {
            return None;
        }
        let timeline_events = self.state.timeline_events().to_vec();
        self.last_delivered_timeline_events
            .clone_from(&timeline_events);
        Some(timeline_events)
    }
    fn observer_bank_and_corpses(
        &self,
        actor_id: &str,
    ) -> (
        Option<AuthorityBankSnapshot>,
        Vec<AuthorityPlayerCorpseSnapshot>,
    ) {
        let config = SliceAuthorityConfig {
            player_actor_id: actor_id.to_owned(),
            area_interest_radius_cells: i32::MAX,
            ..SliceAuthorityConfig::default()
        };
        (
            self.state.bank_snapshot_for_observer(&config),
            self.state.all_player_corpse_snapshots(),
        )
    }

    pub fn step(
        &mut self,
        request: AuthorityBridgeStepRequest,
    ) -> Result<AuthorityBridgeStepOutput, AuthorityBridgeInputError> {
        let request_id = request.request_id;
        let config = request.config.into_authority_config()?;
        let envelope = request.envelope.into_authority_envelope()?;
        let command = envelope.command.clone();
        let frame = self.state.apply_live_envelope(&config, envelope);
        self.record_exchange_command(&config, &command, frame.status, frame.tick);
        let mut actors = Vec::new();
        if let Some(actor) = frame.actor.as_ref() {
            actors.push(actor.clone());
        }
        for event in &frame.combat_events {
            if actors.iter().any(|actor| actor.id == event.target_actor_id) {
                continue;
            }
            if let Some(actor) = self.state.actor_snapshot(&event.target_actor_id) {
                actors.push(actor);
            }
        }
        let target_state_hash = self.state.stable_state_hash_hex();
        Ok(AuthorityBridgeStepOutput {
            schema: BRIDGE_STEP_SCHEMA.to_owned(),
            request_id,
            command_id: frame.command_id,
            tick: frame.tick,
            status: frame.status,
            reason_code: frame.reason_code,
            command_hash: String::new(),
            target_state_hash,
            bundle_hash: String::new(),
            frame_hash: String::new(),
            section_subsystems: Vec::new(),
            actor: None,
            actors,
            combat_events: frame.combat_events,
            ability_queue_events: frame.ability_queue_events,
            survey_result: frame.survey_result,
            craft_session: frame
                .craft_session
                .or_else(|| self.state.craft_session_snapshot_for_observer(&config)),
            splice_session: frame
                .splice_session
                .or_else(|| self.state.splice_session_snapshot_for_observer(&config)),
            genome_scan: frame.genome_scan,
            trade_session: self.state.trade_session_snapshot_for_observer(&config),
            dialogue_deliveries: frame.dialogue_deliveries,
            trade_session_deliveries: frame.trade_session_deliveries,
            duel_outcomes: frame.duel_outcomes,
            factory_receipt: frame.factory_receipt,
            drafted_schematics: self.state.drafted_schematic_snapshots(),
            inventory: self.inventory_snapshots(),
            reservations: self.state.reservation_snapshots(),
            npc_jobs: Vec::new(),
            timeline_events: self.timeline_events_if_changed(),
            resource_spawns: self.state.resource_spawn_snapshots_for_observer(&config),
            area_resource_spawns: self.state.area_resource_spawn_snapshots(),
            placed_extractors: self.state.placed_extractor_snapshots_for_observer(&config),
            placed_camps: self.state.placed_camp_snapshots_for_observer(&config),
            placed_parcels: self.state.parcel_snapshots_for_observer(&config),
            farm_plots: self.state.farm_plot_snapshots_for_observer(&config),
            building: Some(self.state.build_delta_for_observer(&config)),
            parcel_claim: frame.parcel_claim,
            no_claim_zones: self.state.no_claim_zone_snapshots_for_observer(&config),
            group_views_by_actor_id: self.state.group_views_by_actor_id(),
            guild_views_by_actor_id: self.state.guild_views_by_actor_id(),
            duel_views_by_actor_id: self.state.duel_views_by_actor_id(),
            metrics: Some(self.state.live_metrics()),
            ai_debug: None,
            bank: self.state.bank_snapshot_for_observer(&config),
            corpses: self.state.all_player_corpse_snapshots(),
        })
    }

    pub fn batch(
        &mut self,
        request: AuthorityBridgeBatchRequest,
    ) -> Result<AuthorityBridgeBatchOutput, AuthorityBridgeInputError> {
        let request_id = request.request_id;
        let mut steps = Vec::with_capacity(request.steps.len());
        for step in request.steps {
            let mut step_output = self.step(step)?;
            step_output.metrics = None;
            steps.push(step_output);
        }
        Ok(AuthorityBridgeBatchOutput {
            schema: BRIDGE_BATCH_SCHEMA.to_owned(),
            request_id,
            tick: self.state.tick(),
            metrics: self.state.live_metrics(),
            steps,
        })
    }

    pub fn tick(
        &mut self,
        request: AuthorityBridgeTickRequest,
    ) -> Result<AuthorityBridgeTickOutput, AuthorityBridgeInputError> {
        let total_timer = BridgeTimer::start();
        let request_id = request.request_id;
        let requested_ticks = request.ticks.unwrap_or(1).max(1);
        let weather_hazards = request.weather_hazards;
        let weather_hazards_by_tick = request.weather_hazards_by_tick;
        let config = request.config.into_authority_config()?;
        let advance_timer = BridgeTimer::start();
        let combat_events = match weather_hazards_by_tick.as_deref() {
            Some(schedule) => self
                .state
                .advance_ticks_for_observer_with_weather_schedule(&config, schedule),
            None => self.state.advance_ticks_for_observer_with_weather_hazards(
                &config,
                requested_ticks,
                &weather_hazards,
            ),
        };
        let advance = self.state.last_advance_timing();
        let removed_actor_ids = self.state.removed_actor_ids_for_observer(&config);
        let logout_actors = self
            .state
            .linkdead_logout_actor_snapshots_for_observer(&config);
        let advance_us = advance_timer.elapsed_us();
        let actor_timer = BridgeTimer::start();
        let actors = self.state.actor_snapshots_for_observer(&config);
        self.record_exchange_combat_events(&combat_events);
        for actor_id in &removed_actor_ids {
            self.record_exchange_leash(actor_id);
        }
        for actor in &logout_actors {
            self.record_exchange_leash(&actor.id);
        }
        self.close_exchange_timeouts();
        let actor_snapshot_us = actor_timer.elapsed_us();
        let inventory_timer = BridgeTimer::start();
        let inventory = self.inventory_snapshots();
        let inventory_us = inventory_timer.elapsed_us();
        let reservations_timer = BridgeTimer::start();
        let reservations = self.state.reservation_snapshots();
        let reservations_us = reservations_timer.elapsed_us();
        let npc_jobs_timer = BridgeTimer::start();
        let npc_jobs = self.state.npc_job_snapshots();
        let npc_jobs_us = npc_jobs_timer.elapsed_us();
        let timeline_events_timer = BridgeTimer::start();
        let timeline_events = self.timeline_events_if_changed();
        let dialogue_deliveries = self.state.take_dialogue_deliveries();
        let timeline_events_us = timeline_events_timer.elapsed_us();
        let ability_queue_events = self.state.take_ability_queue_events_for_observer(&config);
        let duel_outcomes = self.state.take_duel_outcomes();
        let state_hash_timer = BridgeTimer::start();
        let target_state_hash = self.state.stable_state_hash_hex();
        let state_hash_us = state_hash_timer.elapsed_us();
        let metrics_timer = BridgeTimer::start();
        let metrics = self.state.metrics();
        let metrics_us = metrics_timer.elapsed_us();
        let ai_debug_timer = BridgeTimer::start();
        let ai_debug = request
            .include_ai_debug
            .then(|| self.state.ai_debug_snapshot());
        let ai_debug_us = ai_debug_timer.elapsed_us();
        let timing = AuthorityBridgeTickTiming {
            requested_ticks,
            advance_us,
            advance,
            actor_snapshot_us,
            inventory_us,
            reservations_us,
            npc_jobs_us,
            timeline_events_us,
            state_hash_us,
            metrics_us,
            ai_debug_us,
            total_before_serialize_us: total_timer.elapsed_us(),
        };
        Ok(AuthorityBridgeTickOutput {
            schema: BRIDGE_TICK_SCHEMA.to_owned(),
            request_id,
            tick: self.state.tick(),
            target_state_hash,
            actors,
            removed_actor_ids,
            logout_actors,
            combat_events,
            ability_queue_events,
            inventory,
            reservations,
            npc_jobs,
            timeline_events,
            resource_spawns: self.state.resource_spawn_snapshots_for_observer(&config),
            area_resource_spawns: self.state.area_resource_spawn_snapshots(),
            placed_extractors: self.state.placed_extractor_snapshots_for_observer(&config),
            placed_camps: self.state.placed_camp_snapshots_for_observer(&config),
            placed_parcels: self.state.parcel_snapshots_for_observer(&config),
            farm_plots: self.state.farm_plot_snapshots_for_observer(&config),
            building: Some(self.state.build_delta_for_observer(&config)),
            factory_receipt: None,
            drafted_schematics: self.state.drafted_schematic_snapshots(),
            group_views_by_actor_id: self.state.group_views_by_actor_id(),
            guild_views_by_actor_id: self.state.guild_views_by_actor_id(),
            dialogue_deliveries,
            duel_views_by_actor_id: self.state.duel_views_by_actor_id(),
            duel_outcomes,
            metrics,
            timing,
            ai_debug,
            bank: self.state.bank_snapshot_for_observer(&config),
            corpses: self.state.all_player_corpse_snapshots(),
        })
    }

    pub fn debug(&self, request: AuthorityBridgeDebugRequest) -> AuthorityBridgeDebugOutput {
        let debug_config = SliceAuthorityConfig {
            player_actor_id: "__debug_observer__".to_owned(),
            area_interest_radius_cells: i32::MAX,
            ..SliceAuthorityConfig::default()
        };
        AuthorityBridgeDebugOutput {
            schema: BRIDGE_DEBUG_SCHEMA.to_owned(),
            request_id: request.request_id,
            tick: self.state.tick(),
            area_resource_spawns: self.state.area_resource_spawn_snapshots(),
            placed_extractors: self
                .state
                .placed_extractor_snapshots_for_observer(&debug_config),
            placed_camps: self.state.placed_camp_snapshots_for_observer(&debug_config),
            placed_parcels: self.state.parcel_snapshots_for_observer(&debug_config),
            farm_plots: self.state.farm_plot_snapshots_for_observer(&debug_config),
            building: Some(self.state.build_delta_for_observer(&debug_config)),
            ai_debug: self.state.ai_debug_snapshot(),
        }
    }

    pub fn actor(
        &mut self,
        request: AuthorityBridgeActorRequest,
    ) -> Result<AuthorityBridgeActorOutput, AuthorityBridgeInputError> {
        let request_id = request.request_id;
        let bare_start = request.actor.bare_start;
        let returning = request.actor.returning;
        let (actor_input, verification_loadout) = request.actor.into_authority_actor()?;
        if !verification_loadout.is_empty() && bare_start {
            return Err(AuthorityBridgeInputError::FixtureLoadout(
                "verificationLoadout requires bareStart=false".to_owned(),
            ));
        }
        if !verification_loadout.is_empty() && returning {
            return Err(AuthorityBridgeInputError::FixtureLoadout(
                "verificationLoadout cannot resume a returning character".to_owned(),
            ));
        }
        validate_verification_loadout(&verification_loadout)?;
        let mut actor = self
            .state
            .upsert_actor(actor_input)
            .map_err(AuthorityBridgeInputError::Actor)?;
        if !verification_loadout.is_empty() {
            self.state
                .apply_verification_fixture_loadout(&actor.id, &verification_loadout)
                .map_err(AuthorityBridgeInputError::Reject)?;
            actor = self
                .state
                .actor_snapshot(&actor.id)
                .expect("fixture loadout actor remains registered");
        }
        let resource_spawns = self.state.resource_spawn_snapshots_for_area(&actor.area_id);
        let (bank, corpses) = self.observer_bank_and_corpses(&actor.id);
        Ok(AuthorityBridgeActorOutput {
            schema: BRIDGE_ACTOR_SCHEMA.to_owned(),
            request_id,
            tick: self.state.tick(),
            target_state_hash: self.state.stable_state_hash_hex(),
            actor: Some(actor.clone()),
            inventory: self.inventory_snapshots(),
            reservations: self.state.reservation_snapshots(),
            timeline_events: self.timeline_events_if_changed(),
            resource_spawns,
            area_resource_spawns: self.state.area_resource_spawn_snapshots(),
            placed_extractors: self.state.placed_extractor_snapshots_for_observer(
                &SliceAuthorityConfig {
                    player_actor_id: actor.id.clone(),
                    area_interest_radius_cells: i32::MAX,
                    ..SliceAuthorityConfig::default()
                },
            ),
            placed_camps: self
                .state
                .placed_camp_snapshots_for_observer(&SliceAuthorityConfig {
                    player_actor_id: actor.id.clone(),
                    area_interest_radius_cells: i32::MAX,
                    ..SliceAuthorityConfig::default()
                }),
            placed_parcels: self
                .state
                .parcel_snapshots_for_observer(&SliceAuthorityConfig {
                    player_actor_id: actor.id.clone(),
                    area_interest_radius_cells: i32::MAX,
                    ..SliceAuthorityConfig::default()
                }),
            farm_plots: self
                .state
                .farm_plot_snapshots_for_observer(&SliceAuthorityConfig {
                    player_actor_id: actor.id.clone(),
                    area_interest_radius_cells: i32::MAX,
                    ..SliceAuthorityConfig::default()
                }),
            building: Some(self.state.build_delta_for_observer(&SliceAuthorityConfig {
                player_actor_id: actor.id.clone(),
                area_interest_radius_cells: i32::MAX,
                ..SliceAuthorityConfig::default()
            })),
            group_views_by_actor_id: self.state.group_views_by_actor_id(),
            guild_views_by_actor_id: self.state.guild_views_by_actor_id(),
            duel_views_by_actor_id: self.state.duel_views_by_actor_id(),
            metrics: self.state.metrics(),
            bank,
            corpses,
        })
    }

    pub fn remove_actor(
        &mut self,
        request: AuthorityBridgeRemoveActorRequest,
    ) -> AuthorityBridgeActorOutput {
        let request_id = request.request_id;
        self.record_exchange_leash(&request.actor_id);
        self.state
            .remove_actor_and_purge_inventory(&request.actor_id, request.purge_inventory);
        AuthorityBridgeActorOutput {
            schema: BRIDGE_ACTOR_SCHEMA.to_owned(),
            request_id,
            tick: self.state.tick(),
            target_state_hash: self.state.stable_state_hash_hex(),
            actor: None,
            inventory: if request.purge_inventory {
                self.inventory_snapshots()
            } else {
                Vec::new()
            },
            reservations: if request.purge_inventory {
                self.state.reservation_snapshots()
            } else {
                Vec::new()
            },
            timeline_events: self.timeline_events_if_changed(),
            resource_spawns: Vec::new(),
            area_resource_spawns: self.state.area_resource_spawn_snapshots(),
            placed_extractors: Vec::new(),
            placed_camps: Vec::new(),
            placed_parcels: Vec::new(),
            farm_plots: Vec::new(),
            building: None,
            group_views_by_actor_id: self.state.group_views_by_actor_id(),
            guild_views_by_actor_id: self.state.guild_views_by_actor_id(),
            duel_views_by_actor_id: self.state.duel_views_by_actor_id(),
            metrics: self.state.metrics(),
            bank: None,
            corpses: Vec::new(),
        }
    }

    pub fn set_actor_link_dead(
        &mut self,
        request: AuthorityBridgeLinkDeadActorRequest,
    ) -> Result<AuthorityBridgeActorOutput, AuthorityBridgeInputError> {
        let request_id = request.request_id;
        let actor = self
            .state
            .set_actor_link_dead(&request.actor_id, request.link_dead, request.deadline_tick)
            .map_err(AuthorityBridgeInputError::Reject)?;
        let (bank, corpses) = self.observer_bank_and_corpses(&actor.id);
        Ok(AuthorityBridgeActorOutput {
            schema: BRIDGE_ACTOR_SCHEMA.to_owned(),
            request_id,
            tick: self.state.tick(),
            target_state_hash: self.state.stable_state_hash_hex(),
            actor: Some(actor.clone()),
            inventory: self.inventory_snapshots(),
            reservations: self.state.reservation_snapshots(),
            timeline_events: self.timeline_events_if_changed(),
            resource_spawns: Vec::new(),
            area_resource_spawns: self.state.area_resource_spawn_snapshots(),
            placed_extractors: Vec::new(),
            placed_camps: Vec::new(),
            placed_parcels: Vec::new(),
            farm_plots: Vec::new(),
            building: None,
            group_views_by_actor_id: self.state.group_views_by_actor_id(),
            guild_views_by_actor_id: self.state.guild_views_by_actor_id(),
            duel_views_by_actor_id: self.state.duel_views_by_actor_id(),
            metrics: self.state.metrics(),
            bank,
            corpses,
        })
    }

    pub fn relocate_actor(
        &mut self,
        request: AuthorityBridgeRelocateActorRequest,
    ) -> Result<AuthorityBridgeActorOutput, AuthorityBridgeInputError> {
        let request_id = request.request_id;
        let actor = self
            .state
            .relocate_actor(
                &request.actor_id,
                &request.area_id,
                request.x,
                request.y,
                &request.direction,
            )
            .map_err(AuthorityBridgeInputError::Reject)?;
        let resource_spawns = self.state.resource_spawn_snapshots_for_area(&actor.area_id);
        let observer = SliceAuthorityConfig {
            player_actor_id: actor.id.clone(),
            area_interest_radius_cells: i32::MAX,
            ..SliceAuthorityConfig::default()
        };
        let (bank, corpses) = self.observer_bank_and_corpses(&actor.id);
        Ok(AuthorityBridgeActorOutput {
            schema: BRIDGE_ACTOR_SCHEMA.to_owned(),
            request_id,
            tick: self.state.tick(),
            target_state_hash: self.state.stable_state_hash_hex(),
            actor: Some(actor),
            inventory: self.inventory_snapshots(),
            reservations: self.state.reservation_snapshots(),
            timeline_events: self.timeline_events_if_changed(),
            resource_spawns,
            area_resource_spawns: self.state.area_resource_spawn_snapshots(),
            placed_extractors: self
                .state
                .placed_extractor_snapshots_for_observer(&observer),
            placed_camps: self.state.placed_camp_snapshots_for_observer(&observer),
            placed_parcels: self.state.parcel_snapshots_for_observer(&observer),
            farm_plots: self.state.farm_plot_snapshots_for_observer(&observer),
            building: Some(self.state.build_delta_for_observer(&observer)),
            group_views_by_actor_id: self.state.group_views_by_actor_id(),
            guild_views_by_actor_id: self.state.guild_views_by_actor_id(),
            duel_views_by_actor_id: self.state.duel_views_by_actor_id(),
            metrics: self.state.metrics(),
            bank,
            corpses,
        })
    }

    pub fn restock_actor(
        &mut self,
        request: AuthorityBridgeRestockActorRequest,
    ) -> Result<AuthorityBridgeActorOutput, AuthorityBridgeInputError> {
        let request_id = request.request_id;
        let actor = self
            .state
            .restore_player_like_loadout_for_actor(&request.actor_id)
            .map_err(AuthorityBridgeInputError::Reject)?;
        let resource_spawns = self.state.resource_spawn_snapshots_for_area(&actor.area_id);
        Ok(AuthorityBridgeActorOutput {
            schema: BRIDGE_ACTOR_SCHEMA.to_owned(),
            request_id,
            tick: self.state.tick(),
            target_state_hash: self.state.stable_state_hash_hex(),
            actor: Some(actor.clone()),
            inventory: self.inventory_snapshots(),
            reservations: self.state.reservation_snapshots(),
            timeline_events: self.timeline_events_if_changed(),
            resource_spawns,
            area_resource_spawns: self.state.area_resource_spawn_snapshots(),
            placed_extractors: self.state.placed_extractor_snapshots_for_observer(
                &SliceAuthorityConfig {
                    player_actor_id: actor.id.clone(),
                    area_interest_radius_cells: i32::MAX,
                    ..SliceAuthorityConfig::default()
                },
            ),
            placed_camps: self
                .state
                .placed_camp_snapshots_for_observer(&SliceAuthorityConfig {
                    player_actor_id: actor.id.clone(),
                    area_interest_radius_cells: i32::MAX,
                    ..SliceAuthorityConfig::default()
                }),
            placed_parcels: self
                .state
                .parcel_snapshots_for_observer(&SliceAuthorityConfig {
                    player_actor_id: actor.id.clone(),
                    area_interest_radius_cells: i32::MAX,
                    ..SliceAuthorityConfig::default()
                }),
            farm_plots: self
                .state
                .farm_plot_snapshots_for_observer(&SliceAuthorityConfig {
                    player_actor_id: actor.id.clone(),
                    area_interest_radius_cells: i32::MAX,
                    ..SliceAuthorityConfig::default()
                }),
            building: Some(self.state.build_delta_for_observer(&SliceAuthorityConfig {
                player_actor_id: actor.id.clone(),
                area_interest_radius_cells: i32::MAX,
                ..SliceAuthorityConfig::default()
            })),
            group_views_by_actor_id: self.state.group_views_by_actor_id(),
            guild_views_by_actor_id: self.state.guild_views_by_actor_id(),
            duel_views_by_actor_id: self.state.duel_views_by_actor_id(),
            metrics: self.state.metrics(),
            bank: None,
            corpses: Vec::new(),
        })
    }

    pub fn door_state(
        &mut self,
        request: AuthorityBridgeDoorStateRequest,
    ) -> AuthorityBridgeDoorStateOutput {
        let applied = self
            .state
            .set_door_open(&request.prop_id, request.door_open);
        AuthorityBridgeDoorStateOutput {
            schema: BRIDGE_DOOR_STATE_SCHEMA.to_owned(),
            request_id: request.request_id,
            tick: self.state.tick(),
            prop_id: request.prop_id,
            door_open: request.door_open,
            applied,
            target_state_hash: self.state.stable_state_hash_hex(),
            metrics: self.state.metrics(),
        }
    }

    pub fn exchange_metrics(
        &self,
        request: AuthorityBridgeExchangeMetricsRequest,
    ) -> AuthorityBridgeExchangeMetricsOutput {
        AuthorityBridgeExchangeMetricsOutput {
            schema: BRIDGE_EXCHANGE_METRICS_SCHEMA.to_owned(),
            request_id: request.request_id,
            tick: self.state.tick(),
            exchange_metrics: self.exchange_metrics_snapshot(),
        }
    }

    fn exchange_metrics_snapshot(&self) -> AuthorityExchangeMetricsSnapshot {
        self.exchange_metrics.as_ref().map_or_else(
            || ExchangeMetricsStore::default().snapshot(self.state.tick()),
            |metrics| metrics.snapshot(self.state.tick()),
        )
    }

    fn reset_exchange_metrics(&mut self) {
        if let Some(metrics) = self.exchange_metrics.as_mut() {
            *metrics = ExchangeMetricsStore::default();
        }
    }

    fn record_exchange_command(
        &mut self,
        config: &SliceAuthorityConfig,
        command: &ClientCommand,
        status: AuthorityCommandStatus,
        tick: u64,
    ) {
        if self.exchange_metrics.is_none() || status != AuthorityCommandStatus::Accepted {
            return;
        }
        match command {
            ClientCommand::QueueCombatAction {
                target_actor_id, ..
            } => {
                let area =
                    self.exchange_area_for_actor_pair(&config.player_actor_id, target_actor_id);
                if let Some(metrics) = self.exchange_metrics.as_mut() {
                    metrics.record_queue_entry(
                        &config.player_actor_id,
                        target_actor_id,
                        &area,
                        tick,
                    );
                }
            }
            ClientCommand::Peace {} => {
                if let Some(metrics) = self.exchange_metrics.as_mut() {
                    metrics.record_peace(&config.player_actor_id, tick);
                }
            }
            _ => {}
        }
        self.close_exchange_timeouts();
    }

    fn record_exchange_combat_events(&mut self, combat_events: &[AuthorityCombatEventSnapshot]) {
        if self.exchange_metrics.is_none() {
            return;
        }
        for event in combat_events {
            let area = self.exchange_area_for_event(event);
            if let Some(metrics) = self.exchange_metrics.as_mut() {
                metrics.record_combat_event(event, &area);
            }
        }
    }

    fn record_exchange_leash(&mut self, actor_id: &str) {
        let tick = self.state.tick();
        if let Some(metrics) = self.exchange_metrics.as_mut() {
            metrics.record_leash_actor(actor_id, tick);
        }
    }

    fn close_exchange_timeouts(&mut self) {
        let tick = self.state.tick();
        if let Some(metrics) = self.exchange_metrics.as_mut() {
            metrics.close_timeouts(tick, EXCHANGE_METRICS_TIMEOUT_TICKS);
        }
    }

    fn exchange_area_for_event(&self, event: &AuthorityCombatEventSnapshot) -> String {
        let attacker_id = event
            .attacker_actor_id
            .as_deref()
            .unwrap_or(&event.shooter_actor_id);
        self.exchange_area_for_actor_pair(attacker_id, &event.target_actor_id)
    }

    fn exchange_area_for_actor_pair(&self, actor_id: &str, target_actor_id: &str) -> String {
        self.state
            .actor_snapshot(actor_id)
            .or_else(|| self.state.actor_snapshot(target_actor_id))
            .map(|actor| actor.area_id)
            .unwrap_or_default()
    }

    pub fn step_json(&mut self, request_json: &str) -> Result<String, AuthorityBridgeJsonError> {
        let request: AuthorityBridgeStepRequest =
            serde_json::from_str(request_json).map_err(AuthorityBridgeJsonError::Parse)?;
        let output = self
            .step(request)
            .map_err(AuthorityBridgeJsonError::Input)?;
        serde_json::to_string(&output).map_err(AuthorityBridgeJsonError::Serialize)
    }

    pub fn batch_json(&mut self, request_json: &str) -> Result<String, AuthorityBridgeJsonError> {
        let request: AuthorityBridgeBatchRequest =
            serde_json::from_str(request_json).map_err(AuthorityBridgeJsonError::Parse)?;
        let output = self
            .batch(request)
            .map_err(AuthorityBridgeJsonError::Input)?;
        serde_json::to_string(&output).map_err(AuthorityBridgeJsonError::Serialize)
    }

    pub fn tick_json(&mut self, request_json: &str) -> Result<String, AuthorityBridgeJsonError> {
        let request: AuthorityBridgeTickRequest =
            serde_json::from_str(request_json).map_err(AuthorityBridgeJsonError::Parse)?;
        let requested_ticks = usize::from(request.ticks.unwrap_or(1).max(1));
        if let Some(schedule) = &request.weather_hazards_by_tick {
            if schedule.len() != requested_ticks {
                return Err(AuthorityBridgeInputError::TickWeatherSchedule {
                    ticks: requested_ticks,
                    schedule_len: schedule.len(),
                }
                .into());
            }
        }
        let output = self
            .tick(request)
            .map_err(AuthorityBridgeJsonError::Input)?;
        serde_json::to_string(&output).map_err(AuthorityBridgeJsonError::Serialize)
    }

    pub fn debug_json(&mut self, request_json: &str) -> Result<String, AuthorityBridgeJsonError> {
        let request: AuthorityBridgeDebugRequest =
            serde_json::from_str(request_json).map_err(AuthorityBridgeJsonError::Parse)?;
        serde_json::to_string(&self.debug(request)).map_err(AuthorityBridgeJsonError::Serialize)
    }

    pub fn exchange_metrics_json(
        &mut self,
        request_json: &str,
    ) -> Result<String, AuthorityBridgeJsonError> {
        let request: AuthorityBridgeExchangeMetricsRequest =
            serde_json::from_str(request_json).map_err(AuthorityBridgeJsonError::Parse)?;
        serde_json::to_string(&self.exchange_metrics(request))
            .map_err(AuthorityBridgeJsonError::Serialize)
    }

    pub fn actor_json(&mut self, request_json: &str) -> Result<String, AuthorityBridgeJsonError> {
        let request: AuthorityBridgeActorRequest =
            serde_json::from_str(request_json).map_err(AuthorityBridgeJsonError::Parse)?;
        let output = self
            .actor(request)
            .map_err(AuthorityBridgeJsonError::Input)?;
        serde_json::to_string(&output).map_err(AuthorityBridgeJsonError::Serialize)
    }

    pub fn remove_actor_json(
        &mut self,
        request_json: &str,
    ) -> Result<String, AuthorityBridgeJsonError> {
        let request: AuthorityBridgeRemoveActorRequest =
            serde_json::from_str(request_json).map_err(AuthorityBridgeJsonError::Parse)?;
        serde_json::to_string(&self.remove_actor(request))
            .map_err(AuthorityBridgeJsonError::Serialize)
    }

    pub fn set_actor_link_dead_json(
        &mut self,
        request_json: &str,
    ) -> Result<String, AuthorityBridgeJsonError> {
        let request: AuthorityBridgeLinkDeadActorRequest =
            serde_json::from_str(request_json).map_err(AuthorityBridgeJsonError::Parse)?;
        let output = self
            .set_actor_link_dead(request)
            .map_err(AuthorityBridgeJsonError::Input)?;
        serde_json::to_string(&output).map_err(AuthorityBridgeJsonError::Serialize)
    }

    pub fn relocate_actor_json(
        &mut self,
        request_json: &str,
    ) -> Result<String, AuthorityBridgeJsonError> {
        let request: AuthorityBridgeRelocateActorRequest =
            serde_json::from_str(request_json).map_err(AuthorityBridgeJsonError::Parse)?;
        let output = self
            .relocate_actor(request)
            .map_err(AuthorityBridgeJsonError::Input)?;
        serde_json::to_string(&output).map_err(AuthorityBridgeJsonError::Serialize)
    }

    pub fn restock_actor_json(
        &mut self,
        request_json: &str,
    ) -> Result<String, AuthorityBridgeJsonError> {
        let request: AuthorityBridgeRestockActorRequest =
            serde_json::from_str(request_json).map_err(AuthorityBridgeJsonError::Parse)?;
        let output = self
            .restock_actor(request)
            .map_err(AuthorityBridgeJsonError::Input)?;
        serde_json::to_string(&output).map_err(AuthorityBridgeJsonError::Serialize)
    }

    pub fn door_state_json(
        &mut self,
        request_json: &str,
    ) -> Result<String, AuthorityBridgeJsonError> {
        let request: AuthorityBridgeDoorStateRequest =
            serde_json::from_str(request_json).map_err(AuthorityBridgeJsonError::Parse)?;
        serde_json::to_string(&self.door_state(request))
            .map_err(AuthorityBridgeJsonError::Serialize)
    }

    pub fn export_state_json(
        &mut self,
        request_json: &str,
    ) -> Result<String, AuthorityBridgeJsonError> {
        let request: AuthorityBridgeExportStateRequest =
            serde_json::from_str(request_json).map_err(AuthorityBridgeJsonError::Parse)?;
        serde_json::to_string(&self.export_state(request))
            .map_err(AuthorityBridgeJsonError::Serialize)
    }

    pub fn import_state_json(
        &mut self,
        request_json: &str,
    ) -> Result<String, AuthorityBridgeJsonError> {
        let request: AuthorityBridgeImportStateRequest =
            serde_json::from_str(request_json).map_err(AuthorityBridgeJsonError::Parse)?;
        let output = self
            .import_state(request)
            .map_err(AuthorityBridgeJsonError::Input)?;
        serde_json::to_string(&output).map_err(AuthorityBridgeJsonError::Serialize)
    }

    pub fn dispatch_json(
        &mut self,
        request_json: &str,
    ) -> Result<String, AuthorityBridgeJsonError> {
        let value: serde_json::Value =
            serde_json::from_str(request_json).map_err(AuthorityBridgeJsonError::Parse)?;
        match value.get("type").and_then(serde_json::Value::as_str) {
            Some("tick") => self.tick_json(request_json),
            Some("batch") => self.batch_json(request_json),
            Some("upsertActor") => self.actor_json(request_json),
            Some("removeActor") => self.remove_actor_json(request_json),
            Some("restockActorLoadout") => self.restock_actor_json(request_json),
            Some("setActorLinkDead") => self.set_actor_link_dead_json(request_json),
            Some("relocateActor") => self.relocate_actor_json(request_json),
            Some("setDoorOpen") => self.door_state_json(request_json),
            Some("exportState") => self.export_state_json(request_json),
            Some("importState") => self.import_state_json(request_json),
            Some("debug") => self.debug_json(request_json),
            Some("metrics") => self.exchange_metrics_json(request_json),
            _ => self.step_json(request_json),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeInventorySnapshot {
    #[serde(default)]
    pub stack_id: u64,
    pub container: String,
    pub item: String,
    pub item_id: u32,
    pub variant_id: u32,
    pub quantity: u32,
    pub reserved: u32,
    pub available: u32,
    #[serde(default)]
    pub equipped: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub colors: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_stats: Option<AuthorityResourceStatsSnapshot>,
}

impl From<InventoryStackSnapshot> for AuthorityBridgeInventorySnapshot {
    fn from(row: InventoryStackSnapshot) -> Self {
        let resource_stats = inventory_resource_stats_snapshot(row.item_id, row.variant_id);
        Self {
            equipped: false,
            colors: Vec::new(),
            stack_id: row.stack_id,
            container: row.container,
            item: row.item,
            item_id: row.item_id,
            variant_id: row.variant_id,
            quantity: row.quantity,
            reserved: row.reserved,
            available: row.available,
            resource_stats,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeStepRequest {
    pub request_id: Option<u64>,
    pub config: AuthorityBridgeConfigInput,
    pub envelope: AuthorityBridgeEnvelopeInput,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeExportStateRequest {
    #[serde(rename = "type")]
    pub request_type: String,
    pub request_id: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeExportStateOutput {
    pub schema: String,
    pub request_id: Option<u64>,
    pub tick: u64,
    pub state_hash: String,
    pub state: AuthorityCheckpointBlob,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeImportStateRequest {
    #[serde(rename = "type")]
    pub request_type: String,
    pub request_id: Option<u64>,
    pub state: AuthorityCheckpointBlob,
    #[serde(default)]
    pub expected_state_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeImportStateOutput {
    pub schema: String,
    pub request_id: Option<u64>,
    pub tick: u64,
    pub target_state_hash: String,
    pub actors: Vec<AuthorityActorSnapshot>,
    pub removed_actor_ids: Vec<String>,
    pub logout_actors: Vec<AuthorityActorSnapshot>,
    pub combat_events: Vec<AuthorityCombatEventSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ability_queue_events: Vec<AuthorityAbilityQueueEventSnapshot>,
    pub inventory: Vec<AuthorityBridgeInventorySnapshot>,
    pub reservations: Vec<ReservationSnapshot>,
    pub npc_jobs: Vec<NpcJobSnapshot>,
    pub timeline_events: Vec<TimelineEventSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resource_spawns: Vec<AuthorityResourceSpawnSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub area_resource_spawns: Vec<AuthorityAreaResourceSpawnsSnapshot>,
    #[serde(default)]
    pub placed_extractors: Vec<AuthorityPlacedExtractorSnapshot>,
    #[serde(default)]
    pub placed_camps: Vec<AuthorityPlacedCampSnapshot>,
    #[serde(default)]
    pub placed_parcels: Vec<AuthorityParcelSnapshot>,
    #[serde(default)]
    pub farm_plots: Vec<AuthorityFarmPlotSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub building: Option<AuthorityBuildDeltaPayload>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub no_claim_zones: Vec<AuthorityNoClaimZoneSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub factory_receipt: Option<AuthorityFactoryManufactureSnapshot>,
    pub drafted_schematics: Vec<AuthorityDraftedSchematicSnapshot>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub group_views_by_actor_id: BTreeMap<String, AuthorityGroupViewSnapshot>,
    pub guild_views_by_actor_id: BTreeMap<String, AuthorityGuildViewSnapshot>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub duel_views_by_actor_id: BTreeMap<String, AuthorityDuelViewSnapshot>,
    pub metrics: SliceAuthorityMetrics,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bank: Option<AuthorityBankSnapshot>,
    #[serde(default, rename = "playerCorpses")]
    pub corpses: Vec<AuthorityPlayerCorpseSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeExchangeMetricsRequest {
    #[serde(rename = "type")]
    pub request_type: String,
    pub request_id: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeExchangeMetricsOutput {
    pub schema: String,
    pub request_id: Option<u64>,
    pub tick: u64,
    pub exchange_metrics: AuthorityExchangeMetricsSnapshot,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeStepOutput {
    pub schema: String,
    pub request_id: Option<u64>,
    pub command_id: u64,
    pub tick: u64,
    pub status: AuthorityCommandStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub command_hash: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub target_state_hash: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub bundle_hash: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub frame_hash: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub section_subsystems: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actor: Option<AuthorityActorSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actors: Vec<AuthorityActorSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub combat_events: Vec<AuthorityCombatEventSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ability_queue_events: Vec<AuthorityAbilityQueueEventSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub survey_result: Option<AuthoritySurveyResultSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub craft_session: Option<AuthorityCraftSessionSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub splice_session: Option<AuthoritySpliceSessionSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub genome_scan: Option<AuthorityGenomeScanSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogue_deliveries: Vec<AuthorityDialogueDelivery>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trade_session: Option<AuthorityTradeSessionSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub trade_session_deliveries: Vec<AuthorityTradeSessionDelivery>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub duel_outcomes: Vec<AuthorityDuelOutcomeSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub factory_receipt: Option<AuthorityFactoryManufactureSnapshot>,
    pub drafted_schematics: Vec<AuthorityDraftedSchematicSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inventory: Vec<AuthorityBridgeInventorySnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reservations: Vec<ReservationSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub npc_jobs: Vec<NpcJobSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeline_events: Option<Vec<TimelineEventSnapshot>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resource_spawns: Vec<AuthorityResourceSpawnSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub area_resource_spawns: Vec<AuthorityAreaResourceSpawnsSnapshot>,
    #[serde(default)]
    pub placed_extractors: Vec<AuthorityPlacedExtractorSnapshot>,
    #[serde(default)]
    pub placed_camps: Vec<AuthorityPlacedCampSnapshot>,
    #[serde(default)]
    pub placed_parcels: Vec<AuthorityParcelSnapshot>,
    #[serde(default)]
    pub farm_plots: Vec<AuthorityFarmPlotSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub building: Option<AuthorityBuildDeltaPayload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parcel_claim: Option<AuthorityParcelClaimSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub no_claim_zones: Vec<AuthorityNoClaimZoneSnapshot>,
    pub guild_views_by_actor_id: BTreeMap<String, AuthorityGuildViewSnapshot>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub group_views_by_actor_id: BTreeMap<String, AuthorityGroupViewSnapshot>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub duel_views_by_actor_id: BTreeMap<String, AuthorityDuelViewSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metrics: Option<SliceAuthorityMetrics>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_debug: Option<SliceAuthorityAiDebugSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bank: Option<AuthorityBankSnapshot>,
    #[serde(default, rename = "playerCorpses")]
    pub corpses: Vec<AuthorityPlayerCorpseSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeBatchRequest {
    #[serde(rename = "type")]
    pub request_type: String,
    pub request_id: Option<u64>,
    pub steps: Vec<AuthorityBridgeStepRequest>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeBatchOutput {
    pub schema: String,
    pub request_id: Option<u64>,
    pub tick: u64,
    pub metrics: SliceAuthorityMetrics,
    pub steps: Vec<AuthorityBridgeStepOutput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeTickRequest {
    #[serde(rename = "type")]
    pub request_type: String,
    pub request_id: Option<u64>,
    pub config: AuthorityBridgeConfigInput,
    pub ticks: Option<u16>,
    #[serde(default)]
    pub include_ai_debug: bool,
    #[serde(default)]
    pub weather_hazards: Vec<AuthorityWeatherHazard>,
    #[serde(default)]
    pub weather_hazards_by_tick: Option<Vec<Vec<AuthorityWeatherHazard>>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeTickOutput {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub logout_actors: Vec<AuthorityActorSnapshot>,
    pub schema: String,
    pub request_id: Option<u64>,
    pub tick: u64,
    pub target_state_hash: String,
    pub actors: Vec<AuthorityActorSnapshot>,
    pub removed_actor_ids: Vec<String>,
    pub combat_events: Vec<AuthorityCombatEventSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ability_queue_events: Vec<AuthorityAbilityQueueEventSnapshot>,
    pub inventory: Vec<AuthorityBridgeInventorySnapshot>,
    pub reservations: Vec<ReservationSnapshot>,
    pub npc_jobs: Vec<NpcJobSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeline_events: Option<Vec<TimelineEventSnapshot>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resource_spawns: Vec<AuthorityResourceSpawnSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub area_resource_spawns: Vec<AuthorityAreaResourceSpawnsSnapshot>,
    #[serde(default)]
    pub placed_extractors: Vec<AuthorityPlacedExtractorSnapshot>,
    #[serde(default)]
    pub placed_camps: Vec<AuthorityPlacedCampSnapshot>,
    #[serde(default)]
    pub placed_parcels: Vec<AuthorityParcelSnapshot>,
    #[serde(default)]
    pub farm_plots: Vec<AuthorityFarmPlotSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub building: Option<AuthorityBuildDeltaPayload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub factory_receipt: Option<AuthorityFactoryManufactureSnapshot>,
    pub drafted_schematics: Vec<AuthorityDraftedSchematicSnapshot>,
    pub guild_views_by_actor_id: BTreeMap<String, AuthorityGuildViewSnapshot>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub group_views_by_actor_id: BTreeMap<String, AuthorityGroupViewSnapshot>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub duel_views_by_actor_id: BTreeMap<String, AuthorityDuelViewSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bank: Option<AuthorityBankSnapshot>,
    #[serde(default, rename = "playerCorpses")]
    pub corpses: Vec<AuthorityPlayerCorpseSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dialogue_deliveries: Vec<AuthorityDialogueDelivery>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub duel_outcomes: Vec<AuthorityDuelOutcomeSnapshot>,
    pub metrics: SliceAuthorityMetrics,
    pub timing: AuthorityBridgeTickTiming,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ai_debug: Option<SliceAuthorityAiDebugSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeTickTiming {
    pub requested_ticks: u16,
    pub advance_us: u64,
    pub advance: SliceAuthorityAdvanceTiming,
    pub actor_snapshot_us: u64,
    pub inventory_us: u64,
    pub reservations_us: u64,
    pub npc_jobs_us: u64,
    pub timeline_events_us: u64,
    pub state_hash_us: u64,
    pub metrics_us: u64,
    pub ai_debug_us: u64,
    pub total_before_serialize_us: u64,
}

#[cfg(not(target_arch = "wasm32"))]
struct BridgeTimer(Instant);

#[cfg(not(target_arch = "wasm32"))]
impl BridgeTimer {
    // Host-only telemetry timer for bridge-tick duration metrics; gated out of
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
struct BridgeTimer;

#[cfg(target_arch = "wasm32")]
impl BridgeTimer {
    fn start() -> Self {
        Self
    }

    fn elapsed_us(&self) -> u64 {
        0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeDebugRequest {
    #[serde(rename = "type")]
    pub request_type: String,
    pub request_id: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeDebugOutput {
    pub schema: String,
    pub request_id: Option<u64>,
    pub tick: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub area_resource_spawns: Vec<AuthorityAreaResourceSpawnsSnapshot>,
    #[serde(default)]
    pub placed_extractors: Vec<AuthorityPlacedExtractorSnapshot>,
    #[serde(default)]
    pub placed_camps: Vec<AuthorityPlacedCampSnapshot>,
    #[serde(default)]
    pub placed_parcels: Vec<AuthorityParcelSnapshot>,
    #[serde(default)]
    pub farm_plots: Vec<AuthorityFarmPlotSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub building: Option<AuthorityBuildDeltaPayload>,
    pub ai_debug: SliceAuthorityAiDebugSnapshot,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeActorRequest {
    #[serde(rename = "type")]
    pub request_type: String,
    pub request_id: Option<u64>,
    pub actor: AuthorityBridgeActorInput,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeRemoveActorRequest {
    #[serde(rename = "type")]
    pub request_type: String,
    pub request_id: Option<u64>,
    pub actor_id: String,
    #[serde(default)]
    pub purge_inventory: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeLinkDeadActorRequest {
    #[serde(rename = "type")]
    pub request_type: String,
    pub request_id: Option<u64>,
    pub actor_id: String,
    pub link_dead: bool,
    #[serde(default)]
    pub deadline_tick: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeRelocateActorRequest {
    #[serde(rename = "type")]
    pub request_type: String,
    pub request_id: Option<u64>,
    pub actor_id: String,
    pub area_id: String,
    pub x: i32,
    pub y: i32,
    pub direction: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeRestockActorRequest {
    #[serde(rename = "type")]
    pub request_type: String,
    pub request_id: Option<u64>,
    pub actor_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeDoorStateRequest {
    #[serde(rename = "type")]
    pub request_type: String,
    pub request_id: Option<u64>,
    pub prop_id: String,
    pub door_open: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeDoorStateOutput {
    pub schema: String,
    pub request_id: Option<u64>,
    pub tick: u64,
    pub prop_id: String,
    pub door_open: bool,
    pub applied: bool,
    pub target_state_hash: String,
    pub metrics: SliceAuthorityMetrics,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeActorInput {
    pub id: String,
    pub area_id: String,
    pub x: f64,
    pub y: f64,
    pub direction: String,
    pub entity: Option<String>,
    pub label: Option<String>,
    #[serde(default, alias = "displayName")]
    pub display_name: Option<String>,
    #[serde(default, alias = "linkDead")]
    pub link_dead: bool,
    #[serde(default, alias = "bareStart")]
    pub bare_start: bool,
    #[serde(default)]
    pub returning: bool,
    #[serde(default)]
    pub verification_loadout: Vec<AuthorityFixtureLoadoutItem>,
    #[serde(default)]
    pub worn_colors: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub worn: Vec<AuthorityActorWornPiece>,
    pub appearance: Option<AuthorityActorAppearanceSnapshot>,
    pub sprite: Option<String>,
    pub template_id: Option<String>,
    pub spawn_zone_id: Option<String>,
    pub role: Option<String>,
    #[serde(default)]
    pub profession_ids: Vec<String>,
    #[serde(default, alias = "skillBoxes", alias = "learnedSkillBoxes")]
    pub skill_box_ids: Vec<String>,
    #[serde(default)]
    pub active_title_id: Option<String>,
    #[serde(default)]
    pub credits: Option<u64>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    pub career_goal_id: Option<String>,
    pub faction_id: Option<String>,
    pub social_group: Option<String>,
    pub pvp_status: Option<String>,
    pub player_organization_id: Option<String>,
    pub player_organization_tag: Option<String>,
    pub scale: Option<u32>,
    pub vitals: Option<AuthorityVitals>,
    pub max_vitals: Option<AuthorityVitals>,
}

impl AuthorityBridgeActorInput {
    fn into_authority_actor(
        self,
    ) -> Result<(AuthorityActorUpsert, Vec<AuthorityFixtureLoadoutItem>), AuthorityBridgeInputError>
    {
        let verification_loadout = self.verification_loadout;
        Ok((
            AuthorityActorUpsert {
                id: self.id.clone(),
                entity: self.entity.unwrap_or_else(|| self.id.clone()),
                label: self.label,
                display_name: self.display_name,
                link_dead: self.link_dead,
                bare_start: self.bare_start,
                returning: self.returning,
                appearance: self.appearance,
                worn: self.worn,
                worn_colors: self.worn_colors,
                sprite: self.sprite,
                template_id: self.template_id,
                spawn_zone_id: self.spawn_zone_id,
                role: self.role.unwrap_or_else(|| "player".to_owned()),
                profession_ids: self.profession_ids,
                skill_box_ids: self.skill_box_ids,
                active_title_id: self.active_title_id,
                credits: self.credits,
                capabilities: self.capabilities,
                career_goal_id: self.career_goal_id,
                faction_id: self.faction_id,
                social_group: self.social_group,
                pvp_status: self.pvp_status,
                player_organization_id: self.player_organization_id,
                player_organization_tag: self.player_organization_tag,
                area_id: self.area_id,
                x: self.x,
                y: self.y,
                direction: parse_actor_direction(&self.direction)?,
                scale: self.scale.unwrap_or(1),
                vitals: self.vitals.unwrap_or_default(),
                max_vitals: self.max_vitals.unwrap_or_default(),
            },
            verification_loadout,
        ))
    }
}

fn validate_verification_loadout(
    items: &[AuthorityFixtureLoadoutItem],
) -> Result<(), AuthorityBridgeInputError> {
    if items.len() > 16 {
        return Err(AuthorityBridgeInputError::FixtureLoadout(
            "too many items".to_owned(),
        ));
    }
    let mut seen = std::collections::BTreeSet::new();
    let mut equipped = 0_u8;
    for item in items {
        if item.item_id == 0 || item.quantity == 0 {
            return Err(AuthorityBridgeInputError::FixtureLoadout(
                "item id and quantity must be positive".to_owned(),
            ));
        }
        if !seen.insert((item.item_id, item.variant_id)) {
            return Err(AuthorityBridgeInputError::FixtureLoadout(
                "duplicate item stack".to_owned(),
            ));
        }
        if item.equipped {
            equipped = equipped.saturating_add(1);
        }
    }
    if equipped > 1 {
        return Err(AuthorityBridgeInputError::FixtureLoadout(
            "multiple equipped items".to_owned(),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeActorOutput {
    pub schema: String,
    pub request_id: Option<u64>,
    pub tick: u64,
    pub target_state_hash: String,
    pub actor: Option<AuthorityActorSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inventory: Vec<AuthorityBridgeInventorySnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reservations: Vec<ReservationSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeline_events: Option<Vec<TimelineEventSnapshot>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub resource_spawns: Vec<AuthorityResourceSpawnSnapshot>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub area_resource_spawns: Vec<AuthorityAreaResourceSpawnsSnapshot>,
    #[serde(default)]
    pub placed_extractors: Vec<AuthorityPlacedExtractorSnapshot>,
    #[serde(default)]
    pub placed_camps: Vec<AuthorityPlacedCampSnapshot>,
    #[serde(default)]
    pub placed_parcels: Vec<AuthorityParcelSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bank: Option<AuthorityBankSnapshot>,
    #[serde(default, rename = "playerCorpses")]
    pub corpses: Vec<AuthorityPlayerCorpseSnapshot>,
    #[serde(default)]
    pub farm_plots: Vec<AuthorityFarmPlotSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub building: Option<AuthorityBuildDeltaPayload>,
    pub guild_views_by_actor_id: BTreeMap<String, AuthorityGuildViewSnapshot>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub group_views_by_actor_id: BTreeMap<String, AuthorityGroupViewSnapshot>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub duel_views_by_actor_id: BTreeMap<String, AuthorityDuelViewSnapshot>,
    pub metrics: SliceAuthorityMetrics,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeScriptInput {
    pub config: AuthorityBridgeConfigInput,
    pub commands: Vec<AuthorityBridgeEnvelopeInput>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeScriptOutput {
    pub schema: String,
    pub initial_state_hash: String,
    pub final_state_hash: String,
    pub metrics: SliceAuthorityMetrics,
    pub steps: Vec<AuthorityBridgeStepOutput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityBridgeConfigInput {
    pub session: u64,
    pub player: u32,
    pub player_actor_id: String,
    pub area_interest_radius_cells: Option<i32>,
    #[serde(default)]
    pub craft_roll_key: Option<String>,
}

impl AuthorityBridgeConfigInput {
    fn into_authority_config(self) -> Result<SliceAuthorityConfig, AuthorityBridgeInputError> {
        let craft_roll_key = match self.craft_roll_key.as_deref() {
            Some(value) => {
                parse_craft_roll_key(value).ok_or(AuthorityBridgeInputError::InvalidCraftRollKey)?
            }
            None => SliceAuthorityConfig::default().craft_roll_key,
        };
        Ok(SliceAuthorityConfig {
            session: SessionId(self.session),
            player: PlayerId(self.player),
            player_actor_id: self.player_actor_id,
            area_interest_radius_cells: self.area_interest_radius_cells.unwrap_or(64),
            craft_roll_key,
        })
    }
}
fn parse_craft_roll_key(value: &str) -> Option<[u8; 32]> {
    let bytes = value.as_bytes();
    if bytes.len() != 64 {
        return None;
    }
    let mut key = [0_u8; 32];
    for (index, pair) in bytes.chunks_exact(2).enumerate() {
        let high = (pair[0] as char).to_digit(16)?;
        let low = (pair[1] as char).to_digit(16)?;
        key[index] = u8::try_from((high << 4) | low).ok()?;
    }
    Some(key)
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeEnvelopeInput {
    pub session: u64,
    pub player: u32,
    #[serde(alias = "commandId")]
    pub command_id: u64,
    #[serde(alias = "issuedAtTick")]
    pub issued_at_tick: u64,
    pub command: AuthorityBridgeCommandInput,
}

impl AuthorityBridgeEnvelopeInput {
    fn into_authority_envelope(self) -> Result<ClientCommandEnvelope, AuthorityBridgeInputError> {
        Ok(ClientCommandEnvelope {
            session: SessionId(self.session),
            player: PlayerId(self.player),
            command_id: self.command_id,
            issued_at_tick: self.issued_at_tick,
            command: self.command.into_authority_command()?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum AuthorityBridgeCommandInput {
    Move {
        #[serde(rename = "Move")]
        command: AuthorityBridgeMoveInput,
    },
    SetMoveIntent {
        #[serde(rename = "SetMoveIntent")]
        command: AuthorityBridgeMoveIntentInput,
    },
    CancelAbilityQueue {
        #[serde(rename = "CancelAbilityQueue")]
        command: AuthorityBridgeCancelAbilityQueueInput,
    },
    QueueCombatAction {
        #[serde(rename = "QueueCombatAction")]
        command: AuthorityBridgeQueueCombatActionInput,
    },
    Peace {
        #[serde(rename = "Peace")]
        command: AuthorityBridgeEmptyCommandInput,
    },
    ReloadWeapon {
        #[serde(rename = "ReloadWeapon")]
        command: AuthorityBridgeReloadWeaponInput,
    },
    SetEquippedWeapon {
        #[serde(rename = "SetEquippedWeapon")]
        command: AuthorityBridgeSetEquippedWeaponInput,
    },
    SetEquippedClothing {
        #[serde(rename = "SetEquippedClothing")]
        command: AuthorityBridgeSetEquippedClothingInput,
    },
    DebugGiveItem {
        #[serde(rename = "DebugGiveItem")]
        command: AuthorityBridgeDebugGiveItemInput,
    },
    DebugGrantSkillBoxes {
        #[serde(rename = "DebugGrantSkillBoxes")]
        command: AuthorityBridgeDebugGrantSkillBoxesInput,
    },
    EnterTransition {
        #[serde(rename = "EnterTransition")]
        command: AuthorityBridgeTransitionInput,
    },
    UseConsumable {
        #[serde(rename = "UseConsumable")]
        command: AuthorityBridgeConsumableInput,
    },
    RefillAmmo {
        #[serde(rename = "RefillAmmo")]
        command: AuthorityBridgeRefillAmmoInput,
    },
    ApplyServiceBuff {
        #[serde(rename = "ApplyServiceBuff")]
        command: AuthorityBridgeServiceBuffInput,
    },
    CloneRespawn {
        #[serde(rename = "CloneRespawn")]
        command: AuthorityBridgeCloneRespawnInput,
    },
    ReviveActor {
        #[serde(rename = "ReviveActor")]
        command: AuthorityBridgeReviveActorInput,
    },
    BankStoreItem {
        #[serde(rename = "BankStoreItem")]
        command: AuthorityBridgeBankStoreItemInput,
    },
    BankRetrieveItem {
        #[serde(rename = "BankRetrieveItem")]
        command: AuthorityBridgeBankRetrieveItemInput,
    },
    BankDepositCredits {
        #[serde(rename = "BankDepositCredits")]
        command: AuthorityBridgeBankCreditsInput,
    },
    BankWithdrawCredits {
        #[serde(rename = "BankWithdrawCredits")]
        command: AuthorityBridgeBankCreditsInput,
    },
    CloneSaveSkillBackup {
        #[serde(rename = "CloneSaveSkillBackup")]
        command: AuthorityBridgeEmptyCommandInput,
    },
    CorpseTakeCredits {
        #[serde(rename = "CorpseTakeCredits")]
        command: AuthorityBridgeCorpseInput,
    },
    SetPosture {
        #[serde(rename = "SetPosture")]
        command: AuthorityBridgeSetPostureInput,
    },
    SampleResource {
        #[serde(rename = "SampleResource")]
        command: AuthorityBridgeSampleResourceInput,
    },
    SurveyResource {
        #[serde(rename = "SurveyResource")]
        command: AuthorityBridgeSampleResourceInput,
    },
    PlaceExtractor {
        #[serde(rename = "PlaceExtractor")]
        command: AuthorityBridgeResourceFamilyInput,
    },
    CrankExtractor {
        #[serde(rename = "CrankExtractor")]
        command: AuthorityBridgeExtractorIdInput,
    },
    StopCrank {
        #[serde(rename = "StopCrank")]
        command: AuthorityBridgeEmptyCommandInput,
    },
    InsertBattery {
        #[serde(rename = "InsertBattery")]
        command: AuthorityBridgeInsertBatteryInput,
    },
    CollectExtractor {
        #[serde(rename = "CollectExtractor")]
        command: AuthorityBridgeExtractorIdInput,
    },
    DestroyExtractor {
        #[serde(rename = "DestroyExtractor")]
        command: AuthorityBridgeExtractorIdInput,
    },
    PlaceCamp {
        #[serde(rename = "PlaceCamp")]
        command: AuthorityBridgeEmptyCommandInput,
    },
    PackUpCamp {
        #[serde(rename = "PackUpCamp")]
        command: AuthorityBridgeEmptyCommandInput,
    },
    DiscardStack {
        #[serde(rename = "DiscardStack")]
        command: AuthorityBridgeDiscardStackInput,
    },
    SplitStack {
        #[serde(rename = "SplitStack")]
        command: AuthorityBridgeSplitStackInput,
    },
    MergeStacks {
        #[serde(rename = "MergeStacks")]
        command: AuthorityBridgeMergeStacksInput,
    },
    RedeemCreditChip {
        #[serde(rename = "RedeemCreditChip")]
        command: AuthorityBridgeRedeemCreditChipInput,
    },
    HarvestCorpse {
        #[serde(rename = "HarvestCorpse")]
        command: AuthorityBridgeHarvestCorpseInput,
    },
    TakeLootItem {
        #[serde(rename = "TakeLootItem")]
        command: AuthorityBridgeTakeLootItemInput,
    },
    CraftItem {
        #[serde(rename = "CraftItem")]
        command: AuthorityBridgeCraftItemInput,
    },
    CraftBegin {
        #[serde(rename = "CraftBegin")]
        command: AuthorityBridgeCraftBeginInput,
    },
    CraftAssignSlot {
        #[serde(rename = "CraftAssignSlot")]
        command: AuthorityBridgeCraftAssignSlotInput,
    },
    CraftClearSlot {
        #[serde(rename = "CraftClearSlot")]
        command: AuthorityBridgeCraftClearSlotInput,
    },
    CraftAssemble {
        #[serde(rename = "CraftAssemble")]
        command: AuthorityBridgeEmptyCommandInput,
    },
    CraftExperiment {
        #[serde(rename = "CraftExperiment")]
        command: AuthorityBridgeCraftExperimentInput,
    },
    CraftFinalizePrototype {
        #[serde(rename = "CraftFinalizePrototype")]
        command: AuthorityBridgeCraftFinalizePrototypeInput,
    },
    CraftFinalizePractice {
        #[serde(rename = "CraftFinalizePractice")]
        command: AuthorityBridgeEmptyCommandInput,
    },
    CraftDraftSchematic {
        #[serde(rename = "CraftDraftSchematic")]
        command: AuthorityBridgeCraftDraftSchematicInput,
    },
    FactoryManufacture {
        #[serde(rename = "FactoryManufacture")]
        command: AuthorityBridgeFactoryManufactureInput,
    },
    CraftCancel {
        #[serde(rename = "CraftCancel")]
        command: AuthorityBridgeEmptyCommandInput,
    },
    RequestStarterTool {
        #[serde(rename = "RequestStarterTool")]
        command: AuthorityBridgeRequestStarterToolInput,
    },
    PurchaseSkillBox {
        #[serde(rename = "PurchaseSkillBox")]
        command: AuthorityBridgePurchaseSkillBoxInput,
    },
    UnlearnSkillBox {
        #[serde(rename = "UnlearnSkillBox")]
        command: AuthorityBridgePurchaseSkillBoxInput,
    },
    SetProfessionTitle {
        #[serde(rename = "SetProfessionTitle")]
        command: AuthorityBridgeSetProfessionTitleInput,
    },
    SetCareerGoal {
        #[serde(rename = "SetCareerGoal")]
        command: AuthorityBridgeSetCareerGoalInput,
    },
    StoreToExchange {
        #[serde(rename = "StoreToExchange")]
        command: AuthorityBridgeExchangeInput,
    },
    RetrieveFromExchange {
        #[serde(rename = "RetrieveFromExchange")]
        command: AuthorityBridgeExchangeInput,
    },
    ProposeTrade {
        #[serde(rename = "ProposeTrade")]
        command: AuthorityBridgeProposeTradeInput,
    },
    AcceptTrade {
        #[serde(rename = "AcceptTrade")]
        command: AuthorityBridgeTradeIdInput,
    },
    DeclineTrade {
        #[serde(rename = "DeclineTrade")]
        command: AuthorityBridgeTradeIdInput,
    },
    AddTradeItem {
        #[serde(rename = "AddTradeItem")]
        command: AuthorityBridgeTradeItemLineInput,
    },
    RemoveTradeItem {
        #[serde(rename = "RemoveTradeItem")]
        command: AuthorityBridgeTradeItemLineInput,
    },
    SetTradeCoin {
        #[serde(rename = "SetTradeCoin")]
        command: AuthorityBridgeSetTradeCoinInput,
    },
    ConfirmTrade {
        #[serde(rename = "ConfirmTrade")]
        command: AuthorityBridgeTradeIdInput,
    },
    GroupInvite {
        #[serde(rename = "GroupInvite")]
        command: AuthorityBridgeGroupTargetInput,
    },
    GroupAccept {
        #[serde(rename = "GroupAccept")]
        command: AuthorityBridgeEmptyCommandInput,
    },
    GroupDecline {
        #[serde(rename = "GroupDecline")]
        command: AuthorityBridgeEmptyCommandInput,
    },
    GroupLeave {
        #[serde(rename = "GroupLeave")]
        command: AuthorityBridgeEmptyCommandInput,
    },
    GroupDisband {
        #[serde(rename = "GroupDisband")]
        command: AuthorityBridgeEmptyCommandInput,
    },
    GroupKick {
        #[serde(rename = "GroupKick")]
        command: AuthorityBridgeGroupTargetInput,
    },
    GuildCreate {
        #[serde(rename = "GuildCreate")]
        command: AuthorityBridgeGuildCreateInput,
    },
    GuildInvite {
        #[serde(rename = "GuildInvite")]
        command: AuthorityBridgeGroupTargetInput,
    },
    GuildAcceptInvite {
        #[serde(rename = "GuildAcceptInvite")]
        command: AuthorityBridgeInviteIdInput,
    },
    GuildDeclineInvite {
        #[serde(rename = "GuildDeclineInvite")]
        command: AuthorityBridgeInviteIdInput,
    },
    GuildLeave {
        #[serde(rename = "GuildLeave")]
        command: AuthorityBridgeEmptyCommandInput,
    },
    GuildKick {
        #[serde(rename = "GuildKick")]
        command: AuthorityBridgeGroupTargetInput,
    },
    GuildSetRole {
        #[serde(rename = "GuildSetRole")]
        command: AuthorityBridgeGuildRoleInput,
    },
    GuildSetPermissions {
        #[serde(rename = "GuildSetPermissions")]
        command: AuthorityBridgeGuildPermissionsInput,
    },
    GuildTransferLeadership {
        #[serde(rename = "GuildTransferLeadership")]
        command: AuthorityBridgeGroupTargetInput,
    },
    GuildDeclareWar {
        #[serde(rename = "GuildDeclareWar")]
        command: AuthorityBridgeGuildTargetInput,
    },
    GuildAcceptWar {
        #[serde(rename = "GuildAcceptWar")]
        command: AuthorityBridgeGuildTargetInput,
    },
    GuildRescindWar {
        #[serde(rename = "GuildRescindWar")]
        command: AuthorityBridgeGuildTargetInput,
    },
    GuildDisband {
        #[serde(rename = "GuildDisband")]
        command: AuthorityBridgeEmptyCommandInput,
    },
    DuelChallenge {
        #[serde(rename = "DuelChallenge")]
        command: AuthorityBridgeDuelChallengeInput,
    },
    DuelAccept {
        #[serde(rename = "DuelAccept")]
        command: AuthorityBridgeEmptyCommandInput,
    },
    DuelDecline {
        #[serde(rename = "DuelDecline")]
        command: AuthorityBridgeEmptyCommandInput,
    },
    DuelYield {
        #[serde(rename = "DuelYield")]
        command: AuthorityBridgeEmptyCommandInput,
    },
    Deathblow {
        #[serde(rename = "Deathblow")]
        command: AuthorityBridgeDuelChallengeInput,
    },
    // Bio-Engineer (80-89) + Agriculture parcel family (69-79, attributed to
    // AgriCore) — DEF-8: the untagged input enum stopped at DuelYield, so every
    // post-duel command was bridge-dead on the live JSON path. Wired here.
    GeneSample {
        #[serde(rename = "GeneSample")]
        command: AuthorityBridgeSpeciesInput,
    },
    ScanGenome {
        #[serde(rename = "ScanGenome")]
        command: AuthorityBridgeScanGenomeInput,
    },
    SpliceBegin {
        #[serde(rename = "SpliceBegin")]
        command: AuthorityBridgeSpeciesInput,
    },
    SpliceAssignSlot {
        #[serde(rename = "SpliceAssignSlot")]
        command: AuthorityBridgeSpliceAssignSlotInput,
    },
    SpliceClearSlot {
        #[serde(rename = "SpliceClearSlot")]
        command: AuthorityBridgeSpliceClearSlotInput,
    },
    SpliceChooseAllele {
        #[serde(rename = "SpliceChooseAllele")]
        command: AuthorityBridgeSpliceChooseAlleleInput,
    },
    SpliceAssemble {
        #[serde(rename = "SpliceAssemble")]
        command: AuthorityBridgeEmptyCommandInput,
    },
    SpliceExperimentLocus {
        #[serde(rename = "SpliceExperimentLocus")]
        command: AuthorityBridgeSpliceExperimentLocusInput,
    },
    SpliceMint {
        #[serde(rename = "SpliceMint")]
        command: AuthorityBridgeSpliceMintInput,
    },
    SpliceCancel {
        #[serde(rename = "SpliceCancel")]
        command: AuthorityBridgeEmptyCommandInput,
    },
    ClaimParcel {
        #[serde(rename = "ClaimParcel")]
        command: AuthorityBridgeClaimParcelInput,
    },
    AbandonParcel {
        #[serde(rename = "AbandonParcel")]
        command: AuthorityBridgeParcelIdInput,
    },
    RenameParcel {
        #[serde(rename = "RenameParcel")]
        command: AuthorityBridgeRenameParcelInput,
    },
    PayUpkeep {
        #[serde(rename = "PayUpkeep")]
        command: AuthorityBridgeParcelIdInput,
    },
    TillTile {
        #[serde(rename = "TillTile")]
        command: AuthorityBridgeTileInput,
    },
    PlantSeed {
        #[serde(rename = "PlantSeed")]
        command: AuthorityBridgePlantSeedInput,
    },
    ClearTile {
        #[serde(rename = "ClearTile")]
        command: AuthorityBridgeTileInput,
    },
    WaterTile {
        #[serde(rename = "WaterTile")]
        command: AuthorityBridgeTileInput,
    },
    TendPlot {
        #[serde(rename = "TendPlot")]
        command: AuthorityBridgeTendPlotInput,
    },
    PlaceFarmStructure {
        #[serde(rename = "PlaceFarmStructure")]
        command: AuthorityBridgePlaceFarmStructureInput,
    },
    RemoveFarmStructure {
        #[serde(rename = "RemoveFarmStructure")]
        command: AuthorityBridgeRemoveFarmStructureInput,
    },
    BuildPlace {
        #[serde(rename = "BuildPlace")]
        command: AuthorityBridgeBuildPlaceInput,
    },
    BuildRemove {
        #[serde(rename = "BuildRemove")]
        command: AuthorityBridgeBuildRemoveInput,
    },
    BuildToggleDoor {
        #[serde(rename = "BuildToggleDoor")]
        command: AuthorityBridgeBuildToggleDoorInput,
    },
    Fertilize {
        // Same wire shape as PlantSeed (tile + inventory container).
        #[serde(rename = "Fertilize")]
        command: AuthorityBridgePlantSeedInput,
    },
    HarvestCrop {
        #[serde(rename = "HarvestCrop")]
        command: AuthorityBridgeTileInput,
    },
}

impl AuthorityBridgeCommandInput {
    pub(crate) fn into_authority_command(self) -> Result<ClientCommand, AuthorityBridgeInputError> {
        match self {
            Self::Move { command } => Ok(ClientCommand::Move {
                dx: command.dx,
                dy: command.dy,
                duration_ticks: command.duration_ticks,
                facing: command
                    .facing
                    .as_deref()
                    .map(parse_cardinal_direction)
                    .transpose()?,
                sprint: command.sprint,
            }),
            Self::SetMoveIntent { command } => Ok(ClientCommand::SetMoveIntent {
                dx: command.dx,
                dy: command.dy,
                facing: command
                    .facing
                    .as_deref()
                    .map(parse_cardinal_direction)
                    .transpose()?,
                sprint: command.sprint,
            }),
            Self::CancelAbilityQueue { command } => Ok(ClientCommand::CancelAbilityQueue {
                queue_entry_id: command.queue_entry_id,
                scope: command.scope,
            }),
            Self::QueueCombatAction { command } => Ok(ClientCommand::QueueCombatAction {
                action_id: command.action_id,
                target_actor_id: command.target_actor_id,
            }),
            Self::Peace { .. } => Ok(ClientCommand::Peace {}),
            Self::ReloadWeapon { command } => Ok(ClientCommand::ReloadWeapon {
                weapon_id: parse_weapon_id(command.weapon_id.as_deref())?,
                ammo_type: parse_ammo_type(command.ammo_type.as_deref())?,
            }),
            Self::SetEquippedWeapon { command } => Ok(ClientCommand::SetEquippedWeapon {
                weapon_id: parse_weapon_id(command.weapon_id.as_deref())?,
                weapon_item_id: command.weapon_item_id,
                weapon_variant_id: command.weapon_variant_id,
            }),
            Self::SetEquippedClothing { command } => Ok(ClientCommand::SetEquippedClothing {
                item_id: command.item_id,
                equipped: command.equipped,
                container: command.container,
                stack_id: command.stack_id,
                variant_id: command.variant_id,
            }),
            Self::DebugGiveItem { command } => Ok(ClientCommand::DebugGiveItem {
                item_id: command.item_id,
                variant_id: command.variant_id.unwrap_or(0),
                quantity: command.quantity.unwrap_or(1),
                equip: command.equip,
            }),
            Self::DebugGrantSkillBoxes { command } => Ok(ClientCommand::DebugGrantSkillBoxes {
                skill_box_ids: command.skill_box_ids,
            }),
            Self::EnterTransition { command } => Ok(ClientCommand::EnterTransition {
                transition_id: command.transition_id,
            }),
            Self::UseConsumable { command } => Ok(ClientCommand::UseConsumable {
                item_id: command.item_id,
                item_numeric_id: command.item_numeric_id,
                variant_id: command.variant_id,
            }),
            Self::RefillAmmo { command } => Ok(ClientCommand::RefillAmmo {
                item_id: command.item_id,
            }),
            Self::ApplyServiceBuff { command } => Ok(ClientCommand::ApplyServiceBuff {
                effect_id: command.effect_id,
            }),
            Self::CloneRespawn { command } => Ok(ClientCommand::CloneRespawn {
                facility_id: command.facility_id,
            }),
            Self::ReviveActor { command } => Ok(ClientCommand::ReviveActor {
                target_actor_id: command.target_actor_id,
            }),
            Self::BankStoreItem { command } => Ok(ClientCommand::BankStoreItem {
                source_stack_id: command.source_stack_id,
                quantity: command.quantity,
            }),
            Self::BankRetrieveItem { command } => Ok(ClientCommand::BankRetrieveItem {
                bank_stack_id: command.bank_stack_id,
                quantity: command.quantity,
            }),
            Self::BankDepositCredits { command } => Ok(ClientCommand::BankDepositCredits {
                amount: command.amount,
            }),
            Self::BankWithdrawCredits { command } => Ok(ClientCommand::BankWithdrawCredits {
                amount: command.amount,
            }),
            Self::CloneSaveSkillBackup { .. } => Ok(ClientCommand::CloneSaveSkillBackup {}),
            Self::CorpseTakeCredits { command } => Ok(ClientCommand::CorpseTakeCredits {
                corpse_id: command.corpse_id,
            }),
            Self::SetPosture { command } => Ok(ClientCommand::SetPosture {
                posture: command.posture,
            }),
            Self::SampleResource { command } => Ok(ClientCommand::SampleResource {
                family: command.family,
                stop: command.stop,
            }),
            Self::SurveyResource { command } => Ok(ClientCommand::SurveyResource {
                family: command.family,
            }),
            Self::PlaceExtractor { command } => Ok(ClientCommand::PlaceExtractor {
                family: command.family,
            }),
            Self::CrankExtractor { command } => Ok(ClientCommand::CrankExtractor {
                extractor_id: command.extractor_id,
            }),
            Self::StopCrank { .. } => Ok(ClientCommand::StopCrank {}),
            Self::InsertBattery { command } => Ok(ClientCommand::InsertBattery {
                extractor_id: command.extractor_id,
                container: command.container,
                stack_id: command.stack_id,
                variant_id: command.variant_id,
            }),
            Self::CollectExtractor { command } => Ok(ClientCommand::CollectExtractor {
                extractor_id: command.extractor_id,
            }),
            Self::DestroyExtractor { command } => Ok(ClientCommand::DestroyExtractor {
                extractor_id: command.extractor_id,
            }),
            Self::PlaceCamp { .. } => Ok(ClientCommand::PlaceCamp {}),
            Self::PackUpCamp { .. } => Ok(ClientCommand::PackUpCamp {}),
            Self::DiscardStack { command } => Ok(ClientCommand::DiscardStack {
                container: command.container,
                stack_id: command.stack_id,
                item_id: command.item_id,
                variant_id: command.variant_id,
            }),
            Self::SplitStack { command } => Ok(ClientCommand::SplitStack {
                container: command.container,
                stack_id: command.stack_id,
                item_id: command.item_id,
                variant_id: command.variant_id,
                quantity: command.quantity,
            }),
            Self::MergeStacks { command } => Ok(ClientCommand::MergeStacks {
                container: command.container,
                source_stack_id: command.source_stack_id,
                target_stack_id: command.target_stack_id,
            }),
            Self::RedeemCreditChip { command } => Ok(ClientCommand::RedeemCreditChip {
                container: command.container,
                stack_id: command.stack_id,
            }),
            Self::HarvestCorpse { command } => Ok(ClientCommand::HarvestCorpse {
                target_actor_id: command.target_actor_id,
            }),
            Self::TakeLootItem { command } => Ok(ClientCommand::TakeLootItem {
                container: command.container,
                item_id: command.item_id,
                variant_id: command.variant_id,
                quantity: command.quantity,
            }),
            Self::CraftItem { command } => Ok(ClientCommand::CraftItem {
                schematic_id: command.schematic_id,
                experiment_power: command.experiment_power,
                experiment_handling: command.experiment_handling,
                experiment_reliability: command.experiment_reliability,
            }),
            Self::CraftBegin { command } => Ok(ClientCommand::CraftBegin {
                recipe_id: command.recipe_id,
            }),
            Self::CraftAssignSlot { command } => Ok(ClientCommand::CraftAssignSlot {
                slot_index: command.slot_index,
                container: command.container,
                stack_id: command.stack_id,
                variant_id: command.variant_id,
            }),
            Self::CraftClearSlot { command } => Ok(ClientCommand::CraftClearSlot {
                slot_index: command.slot_index,
            }),
            Self::CraftAssemble { .. } => Ok(ClientCommand::CraftAssemble {}),
            Self::CraftExperiment { command } => Ok(ClientCommand::CraftExperiment {
                line_id: command.line_id,
                points: command.points,
            }),
            Self::CraftFinalizePrototype { command } => Ok(ClientCommand::CraftFinalizePrototype {
                custom_name: command.custom_name,
            }),
            Self::CraftFinalizePractice { .. } => Ok(ClientCommand::CraftFinalizePractice {}),
            Self::CraftDraftSchematic { command } => Ok(ClientCommand::CraftDraftSchematic {
                max_uses: command.max_uses,
            }),
            Self::FactoryManufacture { command } => Ok(ClientCommand::FactoryManufacture {
                factory_id: command.factory_id,
                schematic_id: command.schematic_id,
            }),
            Self::CraftCancel { .. } => Ok(ClientCommand::CraftCancel {}),
            Self::RequestStarterTool { command } => Ok(ClientCommand::RequestStarterTool {
                trainer_actor_id: command.trainer_actor_id,
            }),
            Self::PurchaseSkillBox { command } => Ok(ClientCommand::PurchaseSkillBox {
                skill_box_id: command.skill_box_id,
                trainer_actor_id: command.trainer_actor_id,
            }),
            Self::UnlearnSkillBox { command } => Ok(ClientCommand::UnlearnSkillBox {
                skill_box_id: command.skill_box_id,
                trainer_actor_id: command.trainer_actor_id,
            }),
            Self::SetProfessionTitle { command } => Ok(ClientCommand::SetProfessionTitle {
                title_id: command.title_id,
            }),
            Self::SetCareerGoal { command } => Ok(ClientCommand::SetCareerGoal {
                goal_id: command.goal_id,
                trainer_actor_id: command.trainer_actor_id,
            }),
            Self::StoreToExchange { command } => Ok(ClientCommand::StoreToExchange {
                item_id: command.item_id,
                variant_id: command.variant_id,
                quantity: command.quantity,
            }),
            Self::RetrieveFromExchange { command } => Ok(ClientCommand::RetrieveFromExchange {
                item_id: command.item_id,
                variant_id: command.variant_id,
                quantity: command.quantity,
            }),
            Self::ProposeTrade { command } => Ok(ClientCommand::ProposeTrade {
                partner_actor_id: command.partner_actor_id,
                offer: command
                    .offer
                    .into_iter()
                    .map(|item| TradeItemSpec {
                        item_id: item.item_id,
                        variant_id: item.variant_id,
                        quantity: item.quantity,
                    })
                    .collect(),
                request: command
                    .request
                    .into_iter()
                    .map(|item| TradeItemSpec {
                        item_id: item.item_id,
                        variant_id: item.variant_id,
                        quantity: item.quantity,
                    })
                    .collect(),
            }),
            Self::AcceptTrade { command } => Ok(ClientCommand::AcceptTrade {
                proposal_id: command.proposal_id,
            }),
            Self::DeclineTrade { command } => Ok(ClientCommand::DeclineTrade {
                proposal_id: command.proposal_id,
            }),
            Self::AddTradeItem { command } => Ok(ClientCommand::AddTradeItem {
                proposal_id: command.proposal_id,
                item: TradeItemSpec {
                    item_id: command.item.item_id,
                    variant_id: command.item.variant_id,
                    quantity: command.item.quantity,
                },
            }),
            Self::RemoveTradeItem { command } => Ok(ClientCommand::RemoveTradeItem {
                proposal_id: command.proposal_id,
                item: TradeItemSpec {
                    item_id: command.item.item_id,
                    variant_id: command.item.variant_id,
                    quantity: command.item.quantity,
                },
            }),
            Self::SetTradeCoin { command } => Ok(ClientCommand::SetTradeCoin {
                proposal_id: command.proposal_id,
                amount: command.amount,
            }),
            Self::ConfirmTrade { command } => Ok(ClientCommand::ConfirmTrade {
                proposal_id: command.proposal_id,
            }),
            Self::GroupInvite { command } => Ok(ClientCommand::GroupInvite {
                target_actor_id: command.target_actor_id,
            }),
            Self::GroupAccept { .. } => Ok(ClientCommand::GroupAccept {}),
            Self::GroupDecline { .. } => Ok(ClientCommand::GroupDecline {}),
            Self::GroupLeave { .. } => Ok(ClientCommand::GroupLeave {}),
            Self::GroupDisband { .. } => Ok(ClientCommand::GroupDisband {}),
            Self::GroupKick { command } => Ok(ClientCommand::GroupKick {
                target_actor_id: command.target_actor_id,
            }),
            Self::GuildCreate { command } => Ok(ClientCommand::GuildCreate {
                name: command.name,
                tag: command.tag,
                terminal_prop_id: command.terminal_prop_id,
            }),
            Self::GuildInvite { command } => Ok(ClientCommand::GuildInvite {
                target_actor_id: command.target_actor_id,
            }),
            Self::GuildAcceptInvite { command } => Ok(ClientCommand::GuildAcceptInvite {
                invite_id: command.invite_id,
            }),
            Self::GuildDeclineInvite { command } => Ok(ClientCommand::GuildDeclineInvite {
                invite_id: command.invite_id,
            }),
            Self::GuildLeave { .. } => Ok(ClientCommand::GuildLeave {}),
            Self::GuildKick { command } => Ok(ClientCommand::GuildKick {
                target_actor_id: command.target_actor_id,
            }),
            Self::GuildSetRole { command } => Ok(ClientCommand::GuildSetRole {
                target_actor_id: command.target_actor_id,
                role: command.role,
            }),
            Self::GuildSetPermissions { command } => Ok(ClientCommand::GuildSetPermissions {
                target_actor_id: command.target_actor_id,
                permissions: command.permissions,
            }),
            Self::GuildTransferLeadership { command } => {
                Ok(ClientCommand::GuildTransferLeadership {
                    target_actor_id: command.target_actor_id,
                })
            }
            Self::GuildDeclareWar { command } => Ok(ClientCommand::GuildDeclareWar {
                opposing_guild_id: command.opposing_guild_id,
            }),
            Self::GuildAcceptWar { command } => Ok(ClientCommand::GuildAcceptWar {
                opposing_guild_id: command.opposing_guild_id,
            }),
            Self::GuildRescindWar { command } => Ok(ClientCommand::GuildRescindWar {
                opposing_guild_id: command.opposing_guild_id,
            }),
            Self::GuildDisband { .. } => Ok(ClientCommand::GuildDisband {}),
            Self::DuelChallenge { command } => Ok(ClientCommand::DuelChallenge {
                target_actor_id: command.target_actor_id,
            }),
            Self::Deathblow { command } => Ok(ClientCommand::Deathblow {
                target_actor_id: command.target_actor_id,
            }),
            Self::DuelAccept { .. } => Ok(ClientCommand::DuelAccept {}),
            Self::DuelDecline { .. } => Ok(ClientCommand::DuelDecline {}),
            Self::DuelYield { .. } => Ok(ClientCommand::DuelYield {}),
            Self::GeneSample { command } => Ok(ClientCommand::GeneSample {
                species: command.species,
            }),
            Self::ScanGenome { command } => Ok(ClientCommand::ScanGenome {
                container: command.container,
                stack_id: command.stack_id,
                variant_id: command.variant_id,
            }),
            Self::SpliceBegin { command } => Ok(ClientCommand::SpliceBegin {
                species: command.species,
            }),
            Self::SpliceAssignSlot { command } => Ok(ClientCommand::SpliceAssignSlot {
                slot_index: command.slot_index,
                container: command.container,
                stack_id: command.stack_id,
                variant_id: command.variant_id,
            }),
            Self::SpliceClearSlot { command } => Ok(ClientCommand::SpliceClearSlot {
                slot_index: command.slot_index,
            }),
            Self::SpliceChooseAllele { command } => Ok(ClientCommand::SpliceChooseAllele {
                locus: command.locus,
                from_parent: command.from_parent,
                allele: command.allele,
            }),
            Self::SpliceAssemble { .. } => Ok(ClientCommand::SpliceAssemble {}),
            Self::SpliceExperimentLocus { command } => Ok(ClientCommand::SpliceExperimentLocus {
                locus: command.locus,
                points: command.points,
            }),
            Self::SpliceMint { command } => Ok(ClientCommand::SpliceMint {
                cultivar_name: command.cultivar_name,
            }),
            Self::SpliceCancel { .. } => Ok(ClientCommand::SpliceCancel {}),
            Self::ClaimParcel { command } => Ok(ClientCommand::ClaimParcel {
                planet_id: command.planet_id,
                area_id: command.area_id,
                x: command.x,
                y: command.y,
                tier: command.tier,
            }),
            Self::AbandonParcel { command } => Ok(ClientCommand::AbandonParcel {
                parcel_id: command.parcel_id,
            }),
            Self::RenameParcel { command } => Ok(ClientCommand::RenameParcel {
                parcel_id: command.parcel_id,
                name: command.name,
            }),
            Self::PayUpkeep { command } => Ok(ClientCommand::PayUpkeep {
                parcel_id: command.parcel_id,
            }),
            Self::TillTile { command } => Ok(ClientCommand::TillTile {
                parcel_id: command.parcel_id,
                cell_x: command.cell_x,
                cell_y: command.cell_y,
            }),
            Self::PlantSeed { command } => Ok(ClientCommand::PlantSeed {
                parcel_id: command.parcel_id,
                cell_x: command.cell_x,
                cell_y: command.cell_y,
                container: command.container,
                stack_id: command.stack_id,
                variant_id: command.variant_id,
            }),
            Self::ClearTile { command } => Ok(ClientCommand::ClearTile {
                parcel_id: command.parcel_id,
                cell_x: command.cell_x,
                cell_y: command.cell_y,
            }),
            Self::WaterTile { command } => Ok(ClientCommand::WaterTile {
                parcel_id: command.parcel_id,
                cell_x: command.cell_x,
                cell_y: command.cell_y,
            }),
            Self::TendPlot { command } => Ok(ClientCommand::TendPlot {
                parcel_id: command.parcel_id,
                stop: command.stop,
            }),
            Self::PlaceFarmStructure { command } => Ok(ClientCommand::PlaceFarmStructure {
                parcel_id: command.parcel_id,
                structure_item_id: command.structure_item_id,
                cell_x: command.cell_x,
                cell_y: command.cell_y,
            }),
            Self::RemoveFarmStructure { command } => Ok(ClientCommand::RemoveFarmStructure {
                parcel_id: command.parcel_id,
                structure_id: command.structure_id,
            }),
            Self::BuildPlace { command } => Ok(ClientCommand::BuildPlace {
                catalog_id: command.catalog_id,
                parcel_id: command.parcel_id,
                cell_x: command.cell_x,
                cell_y: command.cell_y,
                rotation_quarters: command.rotation_quarters,
                palette: command.palette,
            }),
            Self::BuildRemove { command } => Ok(ClientCommand::BuildRemove {
                component_id: command.component_id,
            }),
            Self::BuildToggleDoor { command } => Ok(ClientCommand::BuildToggleDoor {
                component_id: command.component_id,
            }),
            Self::Fertilize { command } => Ok(ClientCommand::Fertilize {
                parcel_id: command.parcel_id,
                cell_x: command.cell_x,
                cell_y: command.cell_y,
                container: command.container,
                stack_id: command.stack_id,
                variant_id: command.variant_id,
            }),
            Self::HarvestCrop { command } => Ok(ClientCommand::HarvestCrop {
                parcel_id: command.parcel_id,
                cell_x: command.cell_x,
                cell_y: command.cell_y,
            }),
        }
    }
}

// DEF-8 Bio-Engineer + Agriculture bridge input structs (snake_case with camelCase aliases).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeSpeciesInput {
    pub species: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeScanGenomeInput {
    pub container: String,
    #[serde(alias = "stackId")]
    pub stack_id: String,
    #[serde(alias = "variantId")]
    pub variant_id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeSpliceAssignSlotInput {
    #[serde(alias = "slotIndex")]
    pub slot_index: u8,
    pub container: String,
    #[serde(alias = "stackId")]
    pub stack_id: String,
    #[serde(alias = "variantId")]
    pub variant_id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeSpliceClearSlotInput {
    #[serde(alias = "slotIndex")]
    pub slot_index: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeSpliceChooseAlleleInput {
    pub locus: u8,
    #[serde(alias = "fromParent")]
    pub from_parent: u8,
    pub allele: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeSpliceExperimentLocusInput {
    pub locus: u8,
    pub points: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeSpliceMintInput {
    #[serde(alias = "cultivarName")]
    pub cultivar_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeClaimParcelInput {
    #[serde(alias = "planetId")]
    pub planet_id: String,
    #[serde(alias = "areaId")]
    pub area_id: String,
    pub x: i32,
    pub y: i32,
    pub tier: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeParcelIdInput {
    #[serde(alias = "parcelId")]
    pub parcel_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeRenameParcelInput {
    #[serde(alias = "parcelId")]
    pub parcel_id: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeTileInput {
    #[serde(alias = "parcelId")]
    pub parcel_id: String,
    #[serde(alias = "cellX")]
    pub cell_x: i32,
    #[serde(alias = "cellY")]
    pub cell_y: i32,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeGuildCreateInput {
    pub name: String,
    pub tag: String,
    pub terminal_prop_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeInviteIdInput {
    pub invite_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeGuildRoleInput {
    pub target_actor_id: String,
    pub role: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeGuildPermissionsInput {
    pub target_actor_id: String,
    pub permissions: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeGuildTargetInput {
    pub opposing_guild_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgePlantSeedInput {
    #[serde(alias = "parcelId")]
    pub parcel_id: String,
    #[serde(alias = "cellX")]
    pub cell_x: i32,
    #[serde(alias = "cellY")]
    pub cell_y: i32,
    pub container: String,
    #[serde(alias = "stackId")]
    pub stack_id: String,
    #[serde(alias = "variantId")]
    pub variant_id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeTendPlotInput {
    #[serde(alias = "parcelId")]
    pub parcel_id: String,
    #[serde(default)]
    pub stop: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgePlaceFarmStructureInput {
    #[serde(alias = "parcelId")]
    pub parcel_id: String,
    #[serde(alias = "structureItemId")]
    pub structure_item_id: u32,
    #[serde(alias = "cellX")]
    pub cell_x: i32,
    #[serde(alias = "cellY")]
    pub cell_y: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeRemoveFarmStructureInput {
    #[serde(alias = "parcelId")]
    pub parcel_id: String,
    #[serde(alias = "structureId")]
    pub structure_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeBuildPlaceInput {
    pub catalog_id: String,
    pub parcel_id: String,
    pub cell_x: i32,
    pub cell_y: i32,
    pub rotation_quarters: u8,
    #[serde(default)]
    pub palette: Option<BuildPalette>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeBuildRemoveInput {
    pub component_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeBuildToggleDoorInput {
    pub component_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeGroupTargetInput {
    #[serde(alias = "targetActorId")]
    pub target_actor_id: String,
}

/// `DuelChallenge` carries the challenged actor id. The TS shard maps it across
/// the claimed-placeholder boundary (`rustActorIdFor`) before it lands here.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeDuelChallengeInput {
    #[serde(alias = "targetActorId")]
    pub target_actor_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeMoveInput {
    pub dx: i32,
    pub dy: i32,
    pub duration_ticks: u16,
    pub facing: Option<String>,
    #[serde(default)]
    pub sprint: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeMoveIntentInput {
    pub dx: i32,
    pub dy: i32,
    pub facing: Option<String>,
    #[serde(default)]
    pub sprint: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeCancelAbilityQueueInput {
    pub queue_entry_id: Option<String>,
    pub scope: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeQueueCombatActionInput {
    pub action_id: String,
    pub target_actor_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorityBridgeEmptyCommandInput {}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeReloadWeaponInput {
    pub weapon_id: Option<String>,
    pub ammo_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeSetEquippedWeaponInput {
    #[serde(default)]
    pub weapon_id: Option<String>,
    #[serde(default, alias = "weaponItemId")]
    pub weapon_item_id: Option<u32>,
    #[serde(default, alias = "weaponVariantId")]
    pub weapon_variant_id: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeSetEquippedClothingInput {
    #[serde(alias = "itemId")]
    pub item_id: u32,
    #[serde(default)]
    pub equipped: bool,
    #[serde(default, alias = "container")]
    pub container: Option<String>,
    #[serde(default, alias = "stackId")]
    pub stack_id: Option<String>,
    #[serde(default, alias = "variantId")]
    pub variant_id: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeDebugGiveItemInput {
    #[serde(alias = "itemId")]
    pub item_id: u32,
    #[serde(default, alias = "variantId")]
    pub variant_id: Option<u32>,
    #[serde(default)]
    pub quantity: Option<u32>,
    #[serde(default)]
    pub equip: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeDebugGrantSkillBoxesInput {
    #[serde(alias = "skillBoxIds")]
    pub skill_box_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeTransitionInput {
    pub transition_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeConsumableInput {
    pub item_id: String,
    #[serde(default, alias = "itemNumericId")]
    pub item_numeric_id: Option<u32>,
    #[serde(default, alias = "variantId")]
    pub variant_id: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeRefillAmmoInput {
    pub item_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeServiceBuffInput {
    pub effect_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeCloneRespawnInput {
    #[serde(default)]
    pub facility_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeReviveActorInput {
    pub target_actor_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeBankStoreItemInput {
    pub source_stack_id: String,
    pub quantity: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeBankRetrieveItemInput {
    pub bank_stack_id: String,
    pub quantity: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeBankCreditsInput {
    pub amount: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeCorpseInput {
    pub corpse_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeSetPostureInput {
    pub posture: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeSampleResourceInput {
    pub family: String,
    #[serde(default)]
    pub stop: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeResourceFamilyInput {
    pub family: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeExtractorIdInput {
    #[serde(alias = "extractorId")]
    pub extractor_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeInsertBatteryInput {
    #[serde(alias = "extractorId")]
    pub extractor_id: String,
    pub container: String,
    #[serde(alias = "stackId")]
    pub stack_id: String,
    #[serde(alias = "variantId")]
    pub variant_id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeDiscardStackInput {
    pub container: String,
    pub stack_id: String,
    pub item_id: u32,
    pub variant_id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeSplitStackInput {
    pub container: String,
    pub stack_id: String,
    pub item_id: u32,
    pub variant_id: u32,
    pub quantity: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeMergeStacksInput {
    pub container: String,
    pub source_stack_id: String,
    pub target_stack_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeRedeemCreditChipInput {
    pub container: String,
    pub stack_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeHarvestCorpseInput {
    pub target_actor_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeTakeLootItemInput {
    pub container: String,
    #[serde(rename = "itemId")]
    pub item_id: u32,
    #[serde(rename = "variantId")]
    pub variant_id: u32,
    pub quantity: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeCraftItemInput {
    pub schematic_id: String,
    pub experiment_power: u8,
    pub experiment_handling: u8,
    pub experiment_reliability: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeCraftBeginInput {
    #[serde(alias = "recipeId")]
    pub recipe_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeCraftAssignSlotInput {
    #[serde(alias = "slotIndex")]
    pub slot_index: u8,
    pub container: String,
    #[serde(alias = "stackId")]
    pub stack_id: String,
    #[serde(alias = "variantId")]
    pub variant_id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeCraftClearSlotInput {
    #[serde(alias = "slotIndex")]
    pub slot_index: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeCraftExperimentInput {
    #[serde(alias = "lineId")]
    pub line_id: u8,
    pub points: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeCraftFinalizePrototypeInput {
    #[serde(default, alias = "customName")]
    pub custom_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeCraftDraftSchematicInput {
    #[serde(alias = "maxUses")]
    pub max_uses: u16,
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeFactoryManufactureInput {
    #[serde(alias = "factoryId")]
    pub factory_id: String,
    #[serde(alias = "schematicId")]
    pub schematic_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeRequestStarterToolInput {
    #[serde(alias = "trainerActorId")]
    pub trainer_actor_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgePurchaseSkillBoxInput {
    pub skill_box_id: String,
    pub trainer_actor_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeSetProfessionTitleInput {
    #[serde(default, alias = "titleId")]
    pub title_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeSetCareerGoalInput {
    #[serde(alias = "goalId")]
    pub goal_id: String,
    pub trainer_actor_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeExchangeInput {
    pub item_id: u32,
    pub variant_id: u32,
    pub quantity: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeTradeItemInput {
    #[serde(alias = "itemId")]
    pub item_id: u32,
    #[serde(alias = "variantId")]
    pub variant_id: u32,
    pub quantity: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeProposeTradeInput {
    pub partner_actor_id: String,
    #[serde(default)]
    pub offer: Vec<AuthorityBridgeTradeItemInput>,
    #[serde(default)]
    pub request: Vec<AuthorityBridgeTradeItemInput>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeTradeIdInput {
    pub proposal_id: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeTradeItemLineInput {
    #[serde(alias = "proposalId")]
    pub proposal_id: u32,
    pub item: AuthorityBridgeTradeItemInput,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthorityBridgeSetTradeCoinInput {
    #[serde(alias = "proposalId")]
    pub proposal_id: u32,
    pub amount: u64,
}

#[derive(Debug, Error)]
pub enum AuthorityBridgeJsonError {
    #[error("authority bridge JSON did not parse: {0}")]
    Parse(serde_json::Error),
    #[error("authority bridge JSON did not serialize: {0}")]
    Serialize(serde_json::Error),
    #[error("authority bridge state did not build: {0}")]
    Build(SliceAuthorityBuildError),
    #[error("authority bridge input is invalid: {0}")]
    Input(#[from] AuthorityBridgeInputError),
}

#[derive(Debug, Error)]
pub enum AuthorityBridgeInputError {
    #[error("unknown cardinal direction `{0}`")]
    UnknownDirection(String),
    #[error("unknown authority weapon id `{0}`")]
    UnknownWeaponId(String),
    #[error("unknown authority ammo type `{0}`")]
    UnknownAmmoType(String),
    #[error("actor input is invalid: {0}")]
    Actor(SliceAuthorityActorError),
    #[error("authority rejected debug bridge operation: {0:?}")]
    Reject(AuthorityRejectReason),
    #[error("verification fixture loadout is invalid: {0}")]
    FixtureLoadout(String),
    #[error("tick weather schedule length {schedule_len} does not match requested ticks {ticks}")]
    TickWeatherSchedule { ticks: usize, schedule_len: usize },
    #[error("authority checkpoint is invalid: {0}")]
    Checkpoint(#[from] AuthorityCheckpointError),
    #[error("authority checkpoint source hash mismatch: expected {expected}, found {actual}")]
    StateHashMismatch { expected: String, actual: String },
    #[error("craft-roll key must be exactly 64 hexadecimal characters")]
    InvalidCraftRollKey,
}

pub fn authority_bridge_script_json(
    snapshot_json: &str,
    script_json: &str,
) -> Result<String, AuthorityBridgeJsonError> {
    let snapshot: SliceSnapshot =
        serde_json::from_str(snapshot_json).map_err(AuthorityBridgeJsonError::Parse)?;
    let script: AuthorityBridgeScriptInput =
        serde_json::from_str(script_json).map_err(AuthorityBridgeJsonError::Parse)?;
    let mut bridge =
        AuthorityBridge::from_snapshot(&snapshot).map_err(AuthorityBridgeJsonError::Build)?;
    let initial_state_hash = bridge.state.stable_state_hash_hex();
    let config = script.config;
    let steps = script
        .commands
        .into_iter()
        .map(|envelope| {
            bridge.step(AuthorityBridgeStepRequest {
                request_id: None,
                config: config.clone(),
                envelope,
            })
        })
        .collect::<Result<Vec<_>, _>>()
        .map_err(AuthorityBridgeJsonError::Input)?;
    let final_state_hash = bridge.state.stable_state_hash_hex();
    let output = AuthorityBridgeScriptOutput {
        schema: BRIDGE_SCRIPT_SCHEMA.to_owned(),
        initial_state_hash,
        final_state_hash,
        metrics: bridge.state.metrics(),
        steps,
    };
    serde_json::to_string_pretty(&output).map_err(AuthorityBridgeJsonError::Serialize)
}

fn parse_actor_direction(value: &str) -> Result<String, AuthorityBridgeInputError> {
    match value {
        "front" | "Front" => Ok("front".to_owned()),
        "right" | "Right" => Ok("right".to_owned()),
        "back" | "Back" => Ok("back".to_owned()),
        "left" | "Left" => Ok("left".to_owned()),
        other => Err(AuthorityBridgeInputError::UnknownDirection(
            other.to_owned(),
        )),
    }
}

fn parse_cardinal_direction(value: &str) -> Result<CardinalDirection, AuthorityBridgeInputError> {
    match value {
        "Front" => Ok(CardinalDirection::Front),
        "Right" => Ok(CardinalDirection::Right),
        "Back" => Ok(CardinalDirection::Back),
        "Left" => Ok(CardinalDirection::Left),
        other => Err(AuthorityBridgeInputError::UnknownDirection(
            other.to_owned(),
        )),
    }
}

fn parse_weapon_id(
    value: Option<&str>,
) -> Result<Option<AuthorityWeaponId>, AuthorityBridgeInputError> {
    match value {
        None => Ok(None),
        Some("slugthrower" | "Slugthrower") => Ok(Some(AuthorityWeaponId::Slugthrower)),
        Some("vibrosword" | "Vibrosword") => Ok(Some(AuthorityWeaponId::Vibrosword)),
        Some("scrapline-machete" | "ScraplineMachete") => {
            Ok(Some(AuthorityWeaponId::ScraplineMachete))
        }
        Some("field-saber" | "FieldSaber") => Ok(Some(AuthorityWeaponId::FieldSaber)),
        Some("quarry-chopper" | "QuarryChopper") => Ok(Some(AuthorityWeaponId::QuarryChopper)),
        Some("unarmed" | "Unarmed") => Ok(Some(AuthorityWeaponId::Unarmed)),
        Some("wpn-pistol" | "WpnPistol") => Ok(Some(AuthorityWeaponId::WpnPistol)),
        Some("wpn-smg" | "WpnSmg") => Ok(Some(AuthorityWeaponId::WpnSmg)),
        Some("wpn-carbine" | "WpnCarbine") => Ok(Some(AuthorityWeaponId::WpnCarbine)),
        Some("lightning-carbine" | "LightningCarbine") => {
            Ok(Some(AuthorityWeaponId::LightningCarbine))
        }
        Some("wpn-assault" | "WpnAssault") => Ok(Some(AuthorityWeaponId::WpnAssault)),
        Some("wpn-shotgun" | "WpnShotgun") => Ok(Some(AuthorityWeaponId::WpnShotgun)),
        Some("wpn-sniper" | "WpnSniper") => Ok(Some(AuthorityWeaponId::WpnSniper)),
        Some("wpn-heavy" | "WpnHeavy") => Ok(Some(AuthorityWeaponId::WpnHeavy)),
        Some("wpn-launcher" | "WpnLauncher") => Ok(Some(AuthorityWeaponId::WpnLauncher)),
        Some(other) => Err(AuthorityBridgeInputError::UnknownWeaponId(other.to_owned())),
    }
}

fn parse_ammo_type(
    value: Option<&str>,
) -> Result<Option<AuthorityAmmoTypeId>, AuthorityBridgeInputError> {
    match value {
        None => Ok(None),
        Some("slug_iron" | "SlugIron") => Ok(Some(AuthorityAmmoTypeId::SlugIron)),
        Some("slug_shard" | "SlugShard") => Ok(Some(AuthorityAmmoTypeId::SlugShard)),
        Some("slug_spike" | "SlugSpike") => Ok(Some(AuthorityAmmoTypeId::SlugSpike)),
        Some("melee" | "Melee") => Ok(Some(AuthorityAmmoTypeId::Melee)),
        Some(other) => Err(AuthorityBridgeInputError::UnknownAmmoType(other.to_owned())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bridge_config_rejects_a_malformed_craft_roll_key() {
        let config = AuthorityBridgeConfigInput {
            session: 1,
            player: 1,
            player_actor_id: "player".to_owned(),
            area_interest_radius_cells: None,
            craft_roll_key: Some("not-a-private-key".to_owned()),
        };
        assert!(matches!(
            config.into_authority_config(),
            Err(AuthorityBridgeInputError::InvalidCraftRollKey)
        ));
    }
    fn bridge_retirement_state() -> AuthorityBridge {
        let mut snapshot = crate::authority_test_slice();
        assert!(snapshot.actors.iter().any(|actor| actor.id == "player"));
        assert!(snapshot.actors.iter().any(|actor| actor.id == "vendor"));
        snapshot.inventory.extend([
            InventoryStackSnapshot {
                stack_id: 90_001,
                container: "player:field-pack".to_owned(),
                item: "retirement-field-pack-item".to_owned(),
                item_id: 90_001,
                variant_id: 0,
                quantity: 2,
                reserved: 1,
                available: 1,
            },
            InventoryStackSnapshot {
                stack_id: 90_002,
                container: "bank:player".to_owned(),
                item: "retirement-bank-item".to_owned(),
                item_id: 90_002,
                variant_id: 0,
                quantity: 3,
                reserved: 1,
                available: 2,
            },
            InventoryStackSnapshot {
                stack_id: 90_003,
                container: "vendor:field-pack".to_owned(),
                item: "vendor-item".to_owned(),
                item_id: 90_003,
                variant_id: 0,
                quantity: 4,
                reserved: 1,
                available: 3,
            },
            InventoryStackSnapshot {
                stack_id: 90_004,
                container: "bank:vendor".to_owned(),
                item: "vendor-bank-item".to_owned(),
                item_id: 90_004,
                variant_id: 0,
                quantity: 5,
                reserved: 1,
                available: 4,
            },
        ]);
        snapshot.reservations.extend([
            ReservationSnapshot {
                id: 90_001,
                actor: "player".to_owned(),
                purpose: "retirement-field-pack".to_owned(),
                from: "player:field-pack".to_owned(),
                item: "retirement-field-pack-item".to_owned(),
                quantity: 1,
                expires_at_tick: None,
            },
            ReservationSnapshot {
                id: 90_002,
                actor: "vendor".to_owned(),
                purpose: "retirement-bank".to_owned(),
                from: "bank:player".to_owned(),
                item: "retirement-bank-item".to_owned(),
                quantity: 1,
                expires_at_tick: None,
            },
            ReservationSnapshot {
                id: 90_003,
                actor: "vendor".to_owned(),
                purpose: "vendor-preserved".to_owned(),
                from: "vendor:field-pack".to_owned(),
                item: "vendor-item".to_owned(),
                quantity: 1,
                expires_at_tick: None,
            },
            ReservationSnapshot {
                id: 90_004,
                actor: "vendor".to_owned(),
                purpose: "vendor-bank-preserved".to_owned(),
                from: "bank:vendor".to_owned(),
                item: "vendor-bank-item".to_owned(),
                quantity: 1,
                expires_at_tick: None,
            },
        ]);
        AuthorityBridge::from_snapshot(&snapshot).expect("test slice")
    }

    #[test]
    fn remove_actor_without_purge_preserves_durable_inventory_and_reservations() {
        let mut bridge = bridge_retirement_state();
        let inventory_before = bridge.state.inventory_snapshots();
        let reservations_before = bridge.state.reservation_snapshots();
        let durable_inventory_before = inventory_before
            .iter()
            .filter(|row| row.stack_id >= 90_001)
            .cloned()
            .collect::<Vec<_>>();

        let output = bridge
            .dispatch_json(r#"{"type":"removeActor","requestId":901,"actorId":"player"}"#)
            .expect("removeActor dispatch");
        let response: AuthorityBridgeActorOutput =
            serde_json::from_str(&output).expect("removeActor response");

        assert!(response.inventory.is_empty());
        assert!(response.reservations.is_empty());
        assert!(bridge.state.actor_snapshot("player").is_none());
        let durable_inventory_after = bridge
            .state
            .inventory_snapshots()
            .into_iter()
            .filter(|row| row.stack_id >= 90_001)
            .collect::<Vec<_>>();
        assert_eq!(durable_inventory_after, durable_inventory_before);
        assert_eq!(bridge.state.reservation_snapshots(), reservations_before);
    }

    #[test]
    fn remove_actor_with_purge_removes_owned_rows_and_projects_remaining_state() {
        let mut bridge = bridge_retirement_state();

        let output = bridge
            .dispatch_json(
                r#"{"type":"removeActor","requestId":902,"actorId":"player","purgeInventory":true}"#,
            )
            .expect("removeActor purge dispatch");
        let response: AuthorityBridgeActorOutput =
            serde_json::from_str(&output).expect("removeActor purge response");

        assert!(bridge.state.actor_snapshot("player").is_none());
        assert!(response
            .inventory
            .iter()
            .all(|row| { row.container != "player:field-pack" && row.container != "bank:player" }));
        assert!(response.reservations.iter().all(|row| {
            row.actor != "player" && row.from != "player:field-pack" && row.from != "bank:player"
        }));
        assert!(response
            .inventory
            .iter()
            .any(|row| row.container == "vendor:field-pack" && row.item == "vendor-item"));
        assert!(response
            .inventory
            .iter()
            .any(|row| row.container == "bank:vendor" && row.item == "vendor-bank-item"));
        assert!(response.reservations.iter().any(|row| {
            row.actor == "vendor" && row.from == "vendor:field-pack" && row.item == "vendor-item"
        }));
        assert!(response.reservations.iter().any(|row| {
            row.actor == "vendor" && row.from == "bank:vendor" && row.item == "vendor-bank-item"
        }));
        assert_eq!(
            response.inventory.len(),
            bridge.state.inventory_snapshots().len()
        );
        assert_eq!(response.reservations, bridge.state.reservation_snapshots());
    }

    fn bridge_metrics_snapshot() -> SliceSnapshot {
        let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
        let mut snapshot: SliceSnapshot = serde_json::from_str(fixture).unwrap();
        snapshot.combat_model = Some("roll".to_owned());
        snapshot
    }

    fn bridge_metrics_upsert_target_json(request_id: u64) -> String {
        format!(
            r#"{{
          "type": "upsertActor",
          "requestId": {request_id},
          "actor": {{
            "id": "metrics-target",
            "areaId": "open-desert-overworld",
            "x": 514,
            "y": 513,
            "direction": "left",
            "role": "skirmisher",
            "factionId": "rogue_troopers",
            "pvpStatus": "overt",
            "vitals": {{ "health": 100000, "action": 100, "spirit": 100 }},
            "maxVitals": {{ "health": 100000, "action": 100, "spirit": 100 }}
          }}
        }}"#
        )
    }

    fn bridge_metrics_step_json(request_id: u64, command_id: u64, command_json: &str) -> String {
        format!(
            r#"{{
          "requestId": {request_id},
          "config": {{
            "session": 1,
            "player": 1,
            "playerActorId": "player",
            "areaInterestRadiusCells": 64
          }},
          "envelope": {{
            "session": 1,
            "player": 1,
            "command_id": {command_id},
            "issued_at_tick": 24,
            "command": {command_json}
          }}
        }}"#
        )
    }

    fn bridge_metrics_queue_json(request_id: u64, command_id: u64) -> String {
        bridge_metrics_step_json(
            request_id,
            command_id,
            r#"{"QueueCombatAction":{"action_id":"basic_shot","target_actor_id":"metrics-target"}}"#,
        )
    }

    fn bridge_metrics_peace_json(request_id: u64, command_id: u64) -> String {
        bridge_metrics_step_json(request_id, command_id, r#"{"Peace":{}}"#)
    }

    fn bridge_metrics_query_json(request_id: u64) -> String {
        format!(r#"{{"type":"metrics","requestId":{request_id}}}"#)
    }

    #[test]
    fn bridge_exchange_metrics_query_opens_and_closes_on_peace() {
        let snapshot = bridge_metrics_snapshot();
        let mut bridge = AuthorityBridge::from_snapshot(&snapshot).unwrap();
        bridge
            .dispatch_json(&bridge_metrics_upsert_target_json(100))
            .unwrap();
        let queue_output: AuthorityBridgeStepOutput = serde_json::from_str(
            &bridge
                .dispatch_json(&bridge_metrics_queue_json(101, 1))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(queue_output.status, AuthorityCommandStatus::Accepted);

        let active: AuthorityBridgeExchangeMetricsOutput = serde_json::from_str(
            &bridge
                .dispatch_json(&bridge_metrics_query_json(102))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(active.schema, BRIDGE_EXCHANGE_METRICS_SCHEMA);
        assert_eq!(active.request_id, Some(102));
        assert_eq!(active.exchange_metrics.totals.active, 1);
        assert_eq!(active.exchange_metrics.totals.closed_lifetime, 0);
        let participants = &active.exchange_metrics.active_exchanges[0].participants;
        assert!(participants
            .iter()
            .any(|participant| participant == "player"));
        assert!(participants
            .iter()
            .any(|participant| participant == "metrics-target"));

        let peace_output: AuthorityBridgeStepOutput = serde_json::from_str(
            &bridge
                .dispatch_json(&bridge_metrics_peace_json(103, 2))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(peace_output.status, AuthorityCommandStatus::Accepted);
        let closed: AuthorityBridgeExchangeMetricsOutput = serde_json::from_str(
            &bridge
                .dispatch_json(&bridge_metrics_query_json(104))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(closed.exchange_metrics.totals.active, 0);
        assert_eq!(closed.exchange_metrics.totals.closed_lifetime, 1);
        assert_eq!(
            closed
                .exchange_metrics
                .closed_exchanges
                .last()
                .expect("closed exchange retained")
                .outcome,
            "peace"
        );
    }

    #[test]
    fn bridge_exchange_metrics_do_not_affect_hash_or_command_outputs() {
        let snapshot = bridge_metrics_snapshot();
        let mut enabled =
            AuthorityBridge::from_snapshot_with_exchange_metrics(&snapshot, true).unwrap();
        let mut disabled =
            AuthorityBridge::from_snapshot_with_exchange_metrics(&snapshot, false).unwrap();
        for request in [
            bridge_metrics_upsert_target_json(200),
            bridge_metrics_queue_json(201, 1),
            bridge_metrics_peace_json(202, 2),
        ] {
            assert_eq!(
                enabled.dispatch_json(&request).unwrap(),
                disabled.dispatch_json(&request).unwrap(),
                "exchange metrics must not alter command outputs"
            );
        }
        assert_eq!(
            enabled.state.stable_state_hash_hex(),
            disabled.state.stable_state_hash_hex(),
            "exchange metrics must not participate in stable state hash"
        );

        let enabled_metrics: AuthorityBridgeExchangeMetricsOutput = serde_json::from_str(
            &enabled
                .dispatch_json(&bridge_metrics_query_json(203))
                .unwrap(),
        )
        .unwrap();
        let disabled_metrics: AuthorityBridgeExchangeMetricsOutput = serde_json::from_str(
            &disabled
                .dispatch_json(&bridge_metrics_query_json(204))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(enabled_metrics.exchange_metrics.totals.closed_lifetime, 1);
        assert_eq!(disabled_metrics.exchange_metrics.totals.closed_lifetime, 0);
    }

    #[test]
    fn bridge_set_actor_link_dead_preserves_full_state() {
        let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
        let snapshot: SliceSnapshot = serde_json::from_str(fixture).unwrap();
        let mut bridge = AuthorityBridge::from_snapshot(&snapshot).unwrap();

        let request = AuthorityBridgeLinkDeadActorRequest {
            request_type: "setActorLinkDead".to_owned(),
            request_id: Some(123),
            actor_id: "player".to_owned(),
            link_dead: false,
            deadline_tick: None,
        };

        let output = bridge.set_actor_link_dead(request).unwrap();
        assert_eq!(output.request_id, Some(123));
        assert!(output.actor.is_some());
        let returned_actor = output.actor.unwrap();
        assert_eq!(returned_actor.id, "player");
        assert!(!returned_actor.link_dead);

        // Verify output inventory is NOT empty and contains real inventory rows
        assert!(
            !output.inventory.is_empty(),
            "inventory output should not be empty"
        );
        // Verify reservations and timeline events match state snapshots exactly
        assert_eq!(
            output.reservations.len(),
            bridge.state.reservation_snapshots().len()
        );
        assert_eq!(
            output.timeline_events.as_ref().map_or(0, |v| v.len()),
            bridge
                .timeline_events_if_changed()
                .unwrap_or_default()
                .len()
        );
    }

    #[test]
    fn bridge_relocate_actor_preserves_progression_inventory_and_checkpoint_state() {
        let mut snapshot = crate::authority_test_slice();
        let player = snapshot
            .actors
            .iter_mut()
            .find(|actor| actor.id == "player")
            .expect("authority test player");
        player.profession_ids = vec!["scout".to_owned()];
        player.skill_box_ids = vec!["scout-novice".to_owned()];
        player.credits = Some(7_654);
        player.vitals = Some(crate::ActorVitalsSnapshot {
            health: 83,
            action: 71,
            spirit: 64,
        });
        snapshot.inventory.push(InventoryStackSnapshot {
            stack_id: 91_001,
            container: "player:field-pack".to_owned(),
            item: "travel-proof-item".to_owned(),
            item_id: 91_001,
            variant_id: 42,
            quantity: 3,
            reserved: 0,
            available: 3,
        });
        let mut bridge = AuthorityBridge::from_snapshot(&snapshot).unwrap();
        let mut expected_actor = bridge.state.actor_snapshot("player").unwrap();
        expected_actor.area_id = crate::AUTHORITY_TEST_INTERIOR_ID.to_owned();
        expected_actor.x = 9.0;
        expected_actor.y = 8.0;
        expected_actor.direction = "front".to_owned();
        let inventory_before = bridge.state.inventory_snapshots();

        let output = bridge
            .dispatch_json(&format!(
                r#"{{"type":"relocateActor","requestId":124,"actorId":"player","areaId":"{}","x":9,"y":8,"direction":"front"}}"#,
                crate::AUTHORITY_TEST_INTERIOR_ID,
            ))
            .expect("relocateActor dispatch");
        let response: AuthorityBridgeActorOutput =
            serde_json::from_str(&output).expect("relocateActor response");
        assert_eq!(response.request_id, Some(124));
        assert_eq!(response.actor.as_ref(), Some(&expected_actor));
        assert_eq!(
            bridge.state.actor_snapshot("player"),
            Some(expected_actor.clone())
        );
        assert_eq!(bridge.state.inventory_snapshots(), inventory_before);

        let saved_hash = bridge.state.stable_state_hash_hex();
        let encoded = serde_json::to_string(&bridge.state.export_checkpoint())
            .expect("relocated authority checkpoint serializes");
        let checkpoint: AuthorityCheckpointBlob =
            serde_json::from_str(&encoded).expect("relocated authority checkpoint deserializes");
        let mut restored = bridge.state.clone();
        restored
            .restore_checkpoint(checkpoint)
            .expect("relocated authority checkpoint restores");
        assert_eq!(restored.stable_state_hash_hex(), saved_hash);
        assert_eq!(restored.actor_snapshot("player"), Some(expected_actor));
        assert_eq!(restored.inventory_snapshots(), inventory_before);
    }

    #[test]
    fn bridge_accepts_current_roll_command_shape() {
        let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
        let mut bridge = AuthorityBridge::from_snapshot_json(fixture).unwrap();
        let request = r#"{
          "requestId": 7,
          "config": {
            "session": 1,
            "player": 1,
            "playerActorId": "player",
            "areaInterestRadiusCells": 64
          },
          "envelope": {
            "session": 1,
            "player": 1,
            "command_id": 2,
            "issued_at_tick": 24,
            "command": { "Peace": {} }
          }
        }"#;

        let output: AuthorityBridgeStepOutput =
            serde_json::from_str(&bridge.step_json(request).unwrap()).unwrap();

        assert_eq!(output.schema, BRIDGE_STEP_SCHEMA);
        assert_eq!(output.request_id, Some(7));
        assert_eq!(output.command_id, 2);
        assert_eq!(output.status, AuthorityCommandStatus::Accepted);
        assert_eq!(output.reason_code, None);
        assert!(output.actors.iter().any(|actor| actor.id == "player"));
        assert!(output.ai_debug.is_none());
    }

    #[test]
    fn bridge_batch_json_serializes_survey_result_on_the_step_in_camel_case() {
        let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
        let mut snapshot: SliceSnapshot = serde_json::from_str(fixture).unwrap();
        let player = snapshot
            .actors
            .iter_mut()
            .find(|actor| actor.id == "player")
            .expect("fixture player");
        player.profession_ids.push("craftsman".to_owned());
        player.skill_box_ids.push("craftsman-novice".to_owned());
        let mut bridge = AuthorityBridge::from_snapshot(&snapshot).unwrap();
        bridge
            .step_json(
                r#"{
                  "requestId": 800,
                  "config": { "session": 1, "player": 1, "playerActorId": "player", "areaInterestRadiusCells": 64 },
                  "envelope": {
                    "session": 1,
                    "player": 1,
                    "commandId": 50,
                    "issuedAtTick": 23,
                    "command": { "DebugGiveItem": { "itemId": 3008, "quantity": 1 } }
                  }
                }"#,
            )
            .expect("survey tool setup should be accepted before the batch boundary");
        let response_json = bridge
            .batch_json(
                r#"{
                  "type": "batch",
                  "requestId": 801,
                  "steps": [{
                    "requestId": 802,
                    "config": {
                      "session": 1,
                      "player": 1,
                      "playerActorId": "player",
                      "areaInterestRadiusCells": 64
                    },
                    "envelope": {
                      "session": 1,
                      "player": 1,
                      "commandId": 51,
                      "issuedAtTick": 24,
                      "command": { "SurveyResource": { "family": "mineral" } }
                    }
                  }]
                }"#,
            )
            .expect("SurveyResource batch request should serialize");
        let response: serde_json::Value =
            serde_json::from_str(&response_json).expect("batch response must be JSON");

        let survey = response
            .pointer("/steps/0/surveyResult")
            .and_then(serde_json::Value::as_object)
            .expect("SurveyResource batch step must retain its surveyResult payload");
        assert_eq!(
            survey
                .get("family")
                .and_then(serde_json::Value::as_str),
            Some("metal"),
            "survey result must retain the canonical resource family across the batch JSON boundary"
        );
        assert!(
            response.pointer("/steps/0/survey_result").is_none(),
            "wire output must not regress to Rust snake_case survey_result"
        );
    }

    #[test]
    fn bridge_script_preserves_receipt_and_duplicate_semantics() {
        let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
        let script = r#"{
          "config": {
            "session": 1,
            "player": 1,
            "playerActorId": "player",
            "areaInterestRadiusCells": 64
          },
          "commands": [
            {
              "session": 1,
              "player": 1,
              "command_id": 1,
              "issued_at_tick": 24,
              "command": { "Move": { "dx": 1, "dy": 0, "duration_ticks": 3, "facing": "Right" } }
            },
            {
              "session": 1,
              "player": 1,
              "command_id": 1,
              "issued_at_tick": 25,
              "command": { "Move": { "dx": 1, "dy": 0, "duration_ticks": 3, "facing": "Right" } }
            }
          ]
        }"#;

        let output: AuthorityBridgeScriptOutput =
            serde_json::from_str(&authority_bridge_script_json(fixture, script).unwrap()).unwrap();

        assert_eq!(output.schema, BRIDGE_SCRIPT_SCHEMA);
        assert_eq!(output.steps.len(), 2);
        assert_eq!(output.steps[0].status, AuthorityCommandStatus::Accepted);
        assert_eq!(output.steps[1].status, AuthorityCommandStatus::Rejected);
        assert_eq!(
            output.steps[1].reason_code.as_deref(),
            Some("duplicate_command")
        );
        assert_ne!(output.initial_state_hash, output.final_state_hash);
    }

    #[test]
    fn bridge_dispatch_tick_request_is_single_authority_tick() {
        let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
        let mut bridge = AuthorityBridge::from_snapshot_json(fixture).unwrap();
        let request = r#"{
          "type": "tick",
          "requestId": 11,
          "ticks": 1,
          "config": {
            "session": 0,
            "player": 0,
            "playerActorId": "__server_tick_observer__",
            "areaInterestRadiusCells": 64
          }
        }"#;

        let raw = bridge.dispatch_json(request).unwrap();
        assert!(
            raw.contains("\"placedExtractors\":[]"),
            "empty placedExtractors must serialize so the shard clears stale extractor rows"
        );
        let output: AuthorityBridgeTickOutput = serde_json::from_str(&raw).unwrap();

        assert_eq!(output.schema, BRIDGE_TICK_SCHEMA);
        assert_eq!(output.request_id, Some(11));
        assert_eq!(output.tick, 1);
        assert_eq!(output.timing.requested_ticks, 1);
        assert!(
            output.actors.len() < 50,
            "tick bridge should emit changed actor deltas, not the full slice"
        );
        assert!(output.ai_debug.is_none());
    }

    #[test]
    fn bridge_rejects_malformed_tick_weather_schedule_without_advancing() {
        let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
        let mut bridge = AuthorityBridge::from_snapshot_json(fixture).unwrap();

        let error = bridge.dispatch_json(
            r#"{"type":"tick","requestId":12,"ticks":2,"config":{"session":0,"player":0,"playerActorId":"__server_tick_observer__","areaInterestRadiusCells":64},"weatherHazardsByTick":[[]]}"#,
        ).unwrap_err();
        assert!(
            error.to_string().contains("tick weather schedule length 1 does not match requested ticks 2"),
            "malformed present schedules must be rejected instead of falling back to legacy hazards"
        );

        let raw = bridge.dispatch_json(
            r#"{"type":"tick","requestId":13,"ticks":1,"config":{"session":0,"player":0,"playerActorId":"__server_tick_observer__","areaInterestRadiusCells":64}}"#,
        ).unwrap();
        let output: AuthorityBridgeTickOutput = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            output.tick, 1,
            "rejected schedule must not advance bridge state"
        );
    }

    #[test]
    fn bridge_batched_ticks_match_successive_live_tick_semantics() {
        let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
        let mut control = AuthorityBridge::from_snapshot_json(fixture).unwrap();
        let mut batched = AuthorityBridge::from_snapshot_json(fixture).unwrap();
        let setup = [
            r#"{"type":"upsertActor","requestId":1,"actor":{"id":"duel-b","areaId":"open-desert-overworld","x":38,"y":21,"direction":"Left","entity":"actor.duel-b","label":"B","role":"player"}}"#,
            r#"{"requestId":2,"config":{"session":1,"player":1,"playerActorId":"player","areaInterestRadiusCells":64},"envelope":{"session":1,"player":1,"command_id":1,"issued_at_tick":0,"command":{"DuelChallenge":{"target_actor_id":"duel-b"}}}}"#,
            r#"{"requestId":3,"config":{"session":2,"player":2,"playerActorId":"duel-b","areaInterestRadiusCells":64},"envelope":{"session":2,"player":2,"command_id":1,"issued_at_tick":0,"command":{"DuelAccept":{}}}}"#,
            r#"{"type":"removeActor","requestId":4,"actorId":"duel-b"}"#,
        ];

        for (index, request) in setup.iter().enumerate() {
            let control_raw = control.dispatch_json(request).unwrap();
            let batched_raw = batched.dispatch_json(request).unwrap();
            if matches!(index, 1 | 2) {
                let control_receipt: AuthorityBridgeStepOutput =
                    serde_json::from_str(&control_raw).unwrap();
                let batched_receipt: AuthorityBridgeStepOutput =
                    serde_json::from_str(&batched_raw).unwrap();
                assert_eq!(
                    (
                        control_receipt.request_id,
                        control_receipt.command_id,
                        control_receipt.tick,
                        control_receipt.status,
                        control_receipt.reason_code,
                        control_receipt.target_state_hash,
                    ),
                    (
                        batched_receipt.request_id,
                        batched_receipt.command_id,
                        batched_receipt.tick,
                        batched_receipt.status,
                        batched_receipt.reason_code,
                        batched_receipt.target_state_hash,
                    ),
                    "command receipt boundary diverged before virtual advancement"
                );
            } else {
                assert_eq!(
                    control_raw, batched_raw,
                    "identical lifecycle setup diverged"
                );
            }
        }

        let mut control_combat_events = Vec::new();
        let mut control_ability_queue_events = Vec::new();
        let mut control_removed_actor_ids = Vec::new();
        let mut control_logout_actors = Vec::new();
        let mut control_duel_outcomes = Vec::new();
        let mut control_final = None;
        for request_id in 10..13 {
            let raw = control.dispatch_json(&format!(
                r#"{{"type":"tick","requestId":{request_id},"ticks":1,"config":{{"session":1,"player":1,"playerActorId":"player","areaInterestRadiusCells":64}}}}"#
            )).unwrap();
            let output: AuthorityBridgeTickOutput = serde_json::from_str(&raw).unwrap();
            assert_eq!(
                output.timing.requested_ticks, 1,
                "live control must remain one tick per bridge request"
            );
            control_combat_events.extend(output.combat_events);
            control_ability_queue_events.extend(output.ability_queue_events);
            control_removed_actor_ids.extend(output.removed_actor_ids);
            control_logout_actors.extend(output.logout_actors);
            control_duel_outcomes.extend(output.duel_outcomes);
            control_final = Some((output.tick, output.target_state_hash.clone()));
        }

        let batched_raw = batched.dispatch_json(
            r#"{"type":"tick","requestId":20,"ticks":3,"config":{"session":1,"player":1,"playerActorId":"player","areaInterestRadiusCells":64},"weatherHazardsByTick":[[],[],[]]}"#,
        ).unwrap();
        let batched_output: AuthorityBridgeTickOutput = serde_json::from_str(&batched_raw).unwrap();
        let (control_tick, control_state_hash) =
            control_final.expect("three live ticks produce a final output");

        assert_eq!(batched_output.timing.requested_ticks, 3);
        assert_eq!(batched_output.tick, control_tick);
        assert_eq!(batched_output.target_state_hash, control_state_hash);
        assert_eq!(batched_output.combat_events, control_combat_events);
        assert_eq!(
            batched_output.ability_queue_events,
            control_ability_queue_events
        );
        assert_eq!(batched_output.removed_actor_ids, control_removed_actor_ids);
        assert_eq!(batched_output.logout_actors, control_logout_actors);
        assert_eq!(batched_output.duel_outcomes, control_duel_outcomes);
    }

    #[test]
    fn bridge_dispatch_rejects_ambiguous_exchange_command_without_variant() {
        let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
        let mut bridge = AuthorityBridge::from_snapshot_json(fixture).unwrap();
        let request = r#"{
          "requestId": 47,
          "config": {
            "session": 1,
            "player": 1,
            "playerActorId": "player",
            "areaInterestRadiusCells": 64
          },
          "envelope": {
            "session": 1,
            "player": 1,
            "command_id": 1,
            "issued_at_tick": 24,
            "command": {
              "StoreToExchange": { "item_id": 2001, "quantity": 1 }
            }
          }
        }"#;

        assert!(bridge.dispatch_json(request).is_err());
    }

    #[test]
    fn bridge_dispatch_returns_ai_debug_only_for_explicit_debug_request() {
        let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
        let mut bridge = AuthorityBridge::from_snapshot_json(fixture).unwrap();
        let request = r#"{
          "type": "debug",
          "requestId": 12
        }"#;

        let output: AuthorityBridgeDebugOutput =
            serde_json::from_str(&bridge.dispatch_json(request).unwrap()).unwrap();

        assert_eq!(output.schema, BRIDGE_DEBUG_SCHEMA);
        assert_eq!(output.request_id, Some(12));
        assert_eq!(output.ai_debug.schema, "successor.authority-ai-debug.v1");
    }

    #[test]
    fn bridge_dispatch_upserts_runtime_actor() {
        let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
        let mut bridge = AuthorityBridge::from_snapshot_json(fixture).unwrap();
        let upsert = r#"{
          "type": "upsertActor",
          "requestId": 12,
          "actor": {
            "id": "runtime-observer",
            "areaId": "open-desert-overworld",
            "x": 5,
            "y": 5,
            "direction": "right",
            "appearance": {
              "skin": "skin-test",
              "hair": "hair_mop",
              "hair_mat": "hair_raven",
              "face": {
                "eyes": "eyes_wide",
                "brows": "brows_soft",
                "nose": "nose_button",
                "mouth": "mouth_smile",
                "eye_color": "eye-blue",
                "brow_color": "brow-brown",
                "lip_color": "lip-red"
              }
            }
          }
        }"#;

        let output: AuthorityBridgeActorOutput =
            serde_json::from_str(&bridge.dispatch_json(upsert).unwrap()).unwrap();

        assert_eq!(output.schema, BRIDGE_ACTOR_SCHEMA);
        assert_eq!(output.request_id, Some(12));
        let actor = output.actor.expect("runtime actor was upserted");
        assert_eq!(actor.id, "runtime-observer");
        assert_eq!(
            actor.appearance.face,
            Some(AuthorityActorFaceSnapshot {
                eyes: "eyes_wide".to_owned(),
                brows: "brows_soft".to_owned(),
                nose: "nose_button".to_owned(),
                mouth: "mouth_smile".to_owned(),
                eye_color: "eye-blue".to_owned(),
                brow_color: "brow-brown".to_owned(),
                lip_color: "lip-red".to_owned(),
            })
        );
        let exported = bridge.export_state(AuthorityBridgeExportStateRequest {
            request_type: "exportState".to_owned(),
            request_id: Some(17),
        });
        let encoded = serde_json::to_value(exported.state).unwrap();
        assert_eq!(
            encoded
                .pointer("/state/actors/runtime-observer/appearance/face")
                .cloned(),
            Some(serde_json::json!({
                "eyes": "eyes_wide",
                "brows": "brows_soft",
                "nose": "nose_button",
                "mouth": "mouth_smile",
                "eye_color": "eye-blue",
                "brow_color": "brow-brown",
                "lip_color": "lip-red"
            }))
        );
        assert!((actor.x - 5.0).abs() < 0.001);
        assert!((actor.y - 5.0).abs() < 0.001);
        let deploy_rows = output
            .inventory
            .iter()
            .filter(|row| row.container == "runtime-observer:field-pack")
            .collect::<Vec<_>>();
        assert_eq!(
            deploy_rows.iter().filter(|row| row.item_id == 3_104).count(),
            0,
            "owner fresh-start ruling (2026-07-08): the standard deploy loadout must NOT grant the plasma sword"
        );
        assert_eq!(
            deploy_rows
                .iter()
                .find(|row| row.item_id == 1_101)
                .map(|row| row.quantity),
            Some(240),
            "runtime player deploy should receive the standard rifle ammo stack"
        );

        let repeated_output: AuthorityBridgeActorOutput =
            serde_json::from_str(&bridge.dispatch_json(upsert).unwrap()).unwrap();
        let repeated_deploy = repeated_output
            .inventory
            .iter()
            .filter(|row| row.container == "runtime-observer:field-pack")
            .collect::<Vec<_>>();
        assert_eq!(
            repeated_deploy
                .iter()
                .filter(|row| row.item_id == 3_104)
                .count(),
            0,
            "repeat deploy upsert still grants no plasma sword"
        );
        assert_eq!(
            repeated_deploy
                .iter()
                .filter(|row| row.item_id == 1_101)
                .count(),
            1,
            "repeat deploy upsert must restore the ammo stack in place, not duplicate it"
        );
        let legacy_upsert = r#"{
          "type": "upsertActor",
          "requestId": 16,
          "actor": {
            "id": "runtime-observer-legacy",
            "areaId": "open-desert-overworld",
            "x": 6,
            "y": 5,
            "direction": "right"
          }
        }"#;
        let legacy_output: AuthorityBridgeActorOutput =
            serde_json::from_str(&bridge.dispatch_json(legacy_upsert).unwrap()).unwrap();
        assert_eq!(
            legacy_output
                .actor
                .expect("legacy actor was upserted")
                .appearance
                .face,
            None
        );
    }

    #[test]
    fn bridge_dispatch_upserts_runtime_actor_capability_grants() {
        let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
        let mut bridge = AuthorityBridge::from_snapshot_json(fixture).unwrap();
        let upsert = r#"{
          "type": "upsertActor",
          "requestId": 13,
          "actor": {
            "id": "runtime-carrier",
            "areaId": "open-desert-overworld",
            "x": 6,
            "y": 5,
            "direction": "right",
            "capabilities": [
              " debug:bridge_capability ",
              "",
              "debug:bridge_capability"
            ]
          }
        }"#;

        let output: AuthorityBridgeActorOutput =
            serde_json::from_str(&bridge.dispatch_json(upsert).unwrap()).unwrap();

        assert_eq!(output.schema, BRIDGE_ACTOR_SCHEMA);
        assert_eq!(output.request_id, Some(13));
        let actor = output.actor.expect("runtime actor was upserted");
        assert_eq!(actor.id, "runtime-carrier");
        assert_eq!(
            actor
                .capabilities
                .iter()
                .filter(|capability| capability.id == "debug:bridge_capability")
                .count(),
            1,
            "bridge actor capability grants should be trimmed and deduplicated"
        );
    }

    #[test]
    fn bridge_dispatch_upserts_runtime_actor_profession_ids() {
        let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
        let mut bridge = AuthorityBridge::from_snapshot_json(fixture).unwrap();
        let upsert = r#"{
          "type": "upsertActor",
          "requestId": 14,
          "actor": {
            "id": "runtime-caregiver",
            "areaId": "open-desert-overworld",
            "x": 7,
            "y": 5,
            "direction": "right",
            "professionIds": [
              " medic ",
              "",
              "medic"
            ]
          }
        }"#;

        let output: AuthorityBridgeActorOutput =
            serde_json::from_str(&bridge.dispatch_json(upsert).unwrap()).unwrap();

        let actor = output.actor.expect("runtime actor was upserted");
        assert_eq!(
            actor
                .professions
                .iter()
                .filter(|profession| profession.id == "medic")
                .count(),
            1,
            "bridge actor profession grants should be parsed and deduplicated"
        );
        assert!(
            actor
                .capabilities
                .iter()
                .any(|capability| capability.id == "craft:medicine"),
            "profession ids should feed Rust profession-derived compatibility capabilities"
        );
        assert!(
            !actor
                .professions
                .iter()
                .any(|profession| profession.id == "marksman"),
            "test actor id should not receive readable-id marksman fallback"
        );
    }

    #[test]
    fn bridge_dispatch_preserves_explicit_runtime_actor_active_title() {
        let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
        let mut bridge = AuthorityBridge::from_snapshot_json(fixture).unwrap();
        let upsert = r#"{
          "type": "upsertActor",
          "requestId": 15,
          "actor": {
            "id": "runtime-craftsman-title",
            "areaId": "open-desert-overworld",
            "x": 8,
            "y": 5,
            "direction": "right",
            "professionIds": ["marksman"],
            "skillBoxIds": ["craftsman-novice"],
            "activeTitleId": "craftsman-novice"
          }
        }"#;

        let output: AuthorityBridgeActorOutput =
            serde_json::from_str(&bridge.dispatch_json(upsert).unwrap()).unwrap();
        let active_title = output
            .actor
            .expect("runtime actor was upserted")
            .active_title
            .expect("explicit active title was retained");

        assert_eq!(active_title.id, "craftsman-novice");
        assert_eq!(active_title.label, "Novice Craftsman");
    }

    #[test]
    fn bridge_dispatch_rejects_unknown_runtime_actor_profession_ids() {
        let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
        let mut bridge = AuthorityBridge::from_snapshot_json(fixture).unwrap();
        let upsert = r#"{
          "type": "upsertActor",
          "requestId": 15,
          "actor": {
            "id": "runtime-invalid-profession",
            "areaId": "open-desert-overworld",
            "x": 8,
            "y": 5,
            "direction": "right",
            "professionIds": [
              " scrapper "
            ]
          }
        }"#;

        let error = bridge.dispatch_json(upsert).unwrap_err();
        assert!(
            matches!(
                &error,
                AuthorityBridgeJsonError::Input(AuthorityBridgeInputError::Actor(
                    SliceAuthorityActorError::UnknownProfessionId {
                        actor_id,
                        profession_id,
                    },
                )) if actor_id == "runtime-invalid-profession" && profession_id == "scrapper"
            ),
            "unknown runtime profession id should be rejected through actor upsert, got {error:?}"
        );
    }

    #[test]
    fn bridge_dispatch_batches_current_roll_command_steps() {
        let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
        let mut bridge = AuthorityBridge::from_snapshot_json(fixture).unwrap();
        let request = r#"{
          "type": "batch",
          "requestId": 13,
          "steps": [
            {
              "requestId": 21,
              "config": { "session": 1, "player": 1, "playerActorId": "player", "areaInterestRadiusCells": 64 },
              "envelope": {
                "session": 1,
                "player": 1,
                "command_id": 21,
                "issued_at_tick": 24,
                "command": { "Peace": {} }
              }
            },
            {
              "requestId": 22,
              "config": { "session": 1, "player": 1, "playerActorId": "player", "areaInterestRadiusCells": 64 },
              "envelope": {
                "session": 1,
                "player": 1,
                "command_id": 21,
                "issued_at_tick": 25,
                "command": { "Peace": {} }
              }
            }
          ]
        }"#;

        let output: AuthorityBridgeBatchOutput =
            serde_json::from_str(&bridge.dispatch_json(request).unwrap()).unwrap();

        assert_eq!(output.schema, BRIDGE_BATCH_SCHEMA);
        assert_eq!(output.request_id, Some(13));
        assert_eq!(output.steps.len(), 2);
        assert_eq!(output.tick, 0);
        assert_eq!(output.steps[0].request_id, Some(21));
        assert_eq!(output.steps[1].request_id, Some(22));
        assert_eq!(output.steps[0].status, AuthorityCommandStatus::Accepted);
        assert_eq!(output.steps[1].status, AuthorityCommandStatus::Rejected);
        assert_eq!(
            output.steps[1].reason_code.as_deref(),
            Some("duplicate_command")
        );
    }

    #[test]
    fn bridge_deserializes_take_loot_item_camel_payload() {
        let input: AuthorityBridgeCommandInput = serde_json::from_str(
            r#"{
              "TakeLootItem": {
                "container": "corpse:loot-trooper",
                "itemId": 1001,
                "variantId": 7,
                "quantity": 3
              }
            }"#,
        )
        .unwrap();

        assert_eq!(
            input.into_authority_command().unwrap(),
            ClientCommand::TakeLootItem {
                container: "corpse:loot-trooper".to_owned(),
                item_id: 1001,
                variant_id: 7,
                quantity: 3,
            }
        );
    }

    #[test]
    fn bridge_deserializes_group_command_payloads() {
        let cases = [
            (
                r#"{"GroupInvite":{"target_actor_id":"p2"}}"#,
                ClientCommand::GroupInvite {
                    target_actor_id: "p2".to_owned(),
                },
            ),
            (
                r#"{"GroupInvite":{"targetActorId":"p3"}}"#,
                ClientCommand::GroupInvite {
                    target_actor_id: "p3".to_owned(),
                },
            ),
            (r#"{"GroupAccept":{}}"#, ClientCommand::GroupAccept {}),
            (r#"{"GroupDecline":{}}"#, ClientCommand::GroupDecline {}),
            (r#"{"GroupLeave":{}}"#, ClientCommand::GroupLeave {}),
            (r#"{"GroupDisband":{}}"#, ClientCommand::GroupDisband {}),
            (
                r#"{"GroupKick":{"target_actor_id":"p2"}}"#,
                ClientCommand::GroupKick {
                    target_actor_id: "p2".to_owned(),
                },
            ),
            (r#"{"DuelAccept":{}}"#, ClientCommand::DuelAccept {}),
            (r#"{"DuelDecline":{}}"#, ClientCommand::DuelDecline {}),
            (r#"{"DuelYield":{}}"#, ClientCommand::DuelYield {}),
        ];
        for (json, expected) in cases {
            let input: AuthorityBridgeCommandInput =
                serde_json::from_str(json).unwrap_or_else(|err| panic!("{json}: {err}"));
            assert_eq!(input.into_authority_command().unwrap(), expected, "{json}");
        }
    }

    #[test]
    fn bridge_deserializes_build_commands_with_server_snake_case_payloads() {
        let cases = [
            (
                serde_json::json!({
                    "BuildPlace": {
                        "catalog_id": "wall_basic",
                        "parcel_id": "parcel:planet-a:1",
                        "cell_x": 12,
                        "cell_y": -4,
                        "rotation_quarters": 3,
                        "palette": {
                            "primary": "#112233",
                            "secondary": "#445566",
                            "accent": "#778899"
                        }
                    }
                }),
                ClientCommand::BuildPlace {
                    catalog_id: "wall_basic".to_owned(),
                    parcel_id: "parcel:planet-a:1".to_owned(),
                    cell_x: 12,
                    cell_y: -4,
                    rotation_quarters: 3,
                    palette: Some(BuildPalette {
                        primary: Some("#112233".to_owned()),
                        secondary: Some("#445566".to_owned()),
                        accent: Some("#778899".to_owned()),
                    }),
                },
            ),
            (
                serde_json::json!({
                    "BuildRemove": {
                        "component_id": "build:parcel:planet-a:1:1"
                    }
                }),
                ClientCommand::BuildRemove {
                    component_id: "build:parcel:planet-a:1:1".to_owned(),
                },
            ),
            (
                serde_json::json!({
                    "BuildToggleDoor": {
                        "component_id": "build:parcel:planet-a:1:2"
                    }
                }),
                ClientCommand::BuildToggleDoor {
                    component_id: "build:parcel:planet-a:1:2".to_owned(),
                },
            ),
        ];

        for (json, expected) in cases {
            let parsed: AuthorityBridgeCommandInput = serde_json::from_value(json.clone())
                .unwrap_or_else(|error| panic!("deserialize {json}: {error}"));
            assert_eq!(
                parsed
                    .into_authority_command()
                    .unwrap_or_else(|error| panic!("map {json}: {error}")),
                expected,
                "{json}"
            );
        }
    }

    #[test]
    fn bridge_tick_output_emits_duel_outcome_on_disconnect() {
        // A tick-path duel end (here: disconnect) must surface its one-shot outcome on
        // the NEXT tick output's duelOutcomes (proves the tick-output drain, not just the
        // command-frame drain).
        let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
        let mut bridge = AuthorityBridge::from_snapshot_json(fixture).unwrap();
        bridge
            .dispatch_json(
                r#"{"type":"upsertActor","requestId":1,"actor":{"id":"duel-b","areaId":"open-desert-overworld","x":38,"y":21,"direction":"Left","entity":"actor.duel-b","label":"B","role":"player"}}"#,
            )
            .unwrap();
        bridge
            .dispatch_json(
                r#"{"requestId":2,"config":{"session":1,"player":1,"playerActorId":"player","areaInterestRadiusCells":64},"envelope":{"session":1,"player":1,"command_id":1,"issued_at_tick":0,"command":{"DuelChallenge":{"target_actor_id":"duel-b"}}}}"#,
            )
            .unwrap();
        bridge
            .dispatch_json(
                r#"{"requestId":3,"config":{"session":2,"player":2,"playerActorId":"duel-b","areaInterestRadiusCells":64},"envelope":{"session":2,"player":2,"command_id":1,"issued_at_tick":0,"command":{"DuelAccept":{}}}}"#,
            )
            .unwrap();
        bridge
            .dispatch_json(r#"{"type":"removeActor","requestId":4,"actorId":"duel-b"}"#)
            .unwrap();
        let tick_raw = bridge
            .dispatch_json(
                r#"{"type":"tick","requestId":5,"config":{"session":1,"player":1,"playerActorId":"player","areaInterestRadiusCells":64}}"#,
            )
            .unwrap();
        let tick: serde_json::Value = serde_json::from_str(&tick_raw).unwrap();
        let outcomes = tick
            .get("duelOutcomes")
            .and_then(serde_json::Value::as_array)
            .expect("tick output carries duelOutcomes");
        let player_outcome = outcomes
            .iter()
            .find(|o| o.get("actorId").and_then(serde_json::Value::as_str) == Some("player"))
            .expect("remaining participant gets a disconnect outcome on the tick output");
        assert_eq!(
            player_outcome
                .get("reason")
                .and_then(serde_json::Value::as_str),
            Some("disconnect")
        );
        assert_eq!(
            player_outcome
                .get("result")
                .and_then(serde_json::Value::as_str),
            Some("dissolved")
        );
    }

    #[test]
    fn bridge_outputs_group_views_for_server_fanout() {
        let fixture = include_str!("../../../client/public/successor-slice/open-desert-slice.json");
        let mut bridge = AuthorityBridge::from_snapshot_json(fixture).unwrap();
        bridge
            .dispatch_json(
                r#"{
                  "type": "upsertActor",
                  "requestId": 1,
                  "actor": {
                    "id": "p2",
                    "areaId": "open-desert-overworld",
                    "x": 7,
                    "y": 5,
                    "direction": "Right",
                    "entity": "actor.p2",
                    "label": "P2",
                    "role": "player"
                  }
                }"#,
            )
            .unwrap();

        let invite_raw = bridge
            .dispatch_json(
                r#"{
                  "requestId": 2,
                  "config": { "session": 1, "player": 1, "playerActorId": "player", "areaInterestRadiusCells": 64 },
                  "envelope": {
                    "session": 1,
                    "player": 1,
                    "command_id": 10,
                    "issued_at_tick": 0,
                    "command": { "GroupInvite": { "target_actor_id": "p2" } }
                  }
                }"#,
            )
            .unwrap();
        let invite_output: AuthorityBridgeStepOutput = serde_json::from_str(&invite_raw).unwrap();
        assert_eq!(
            invite_output
                .group_views_by_actor_id
                .get("p2")
                .and_then(|view| view.pending_invite.as_ref())
                .map(|invite| invite.inviter_actor_id.as_str()),
            Some("player"),
            "bridge surfaces pending invite to the invited actor for server fanout"
        );

        let accept_raw = bridge
            .dispatch_json(
                r#"{
                  "requestId": 3,
                  "config": { "session": 2, "player": 2, "playerActorId": "p2", "areaInterestRadiusCells": 64 },
                  "envelope": {
                    "session": 2,
                    "player": 2,
                    "command_id": 11,
                    "issued_at_tick": 0,
                    "command": { "GroupAccept": {} }
                  }
                }"#,
            )
            .unwrap();
        let accept_output: AuthorityBridgeStepOutput = serde_json::from_str(&accept_raw).unwrap();
        let player_view = accept_output
            .group_views_by_actor_id
            .get("player")
            .expect("player view exists");
        let p2_view = accept_output
            .group_views_by_actor_id
            .get("p2")
            .expect("p2 view exists");
        assert_eq!(player_view.members.len(), 2);
        assert_eq!(p2_view.members.len(), 2);
        assert_eq!(
            player_view
                .group
                .as_ref()
                .map(|group| group.leader_actor_id.as_str()),
            Some("player")
        );
    }

    #[test]
    fn bridge_deserializes_harvest_corpse_without_material_selector() {
        let input: AuthorityBridgeCommandInput = serde_json::from_str(
            r#"{
              "HarvestCorpse": {
                "target_actor_id": "passive-creature-1"
              }
            }"#,
        )
        .unwrap();

        assert_eq!(
            input.into_authority_command().unwrap(),
            ClientCommand::HarvestCorpse {
                target_actor_id: "passive-creature-1".to_owned(),
            }
        );
    }

    #[test]
    fn bridge_deserializes_extractor_command_payloads() {
        let cases = [
            (
                r#"{"PlaceExtractor":{"family":"metal"}}"#,
                ClientCommand::PlaceExtractor {
                    family: "metal".to_owned(),
                },
            ),
            (
                r#"{"CrankExtractor":{"extractor_id":"extractor:player:1"}}"#,
                ClientCommand::CrankExtractor {
                    extractor_id: "extractor:player:1".to_owned(),
                },
            ),
            (r#"{"StopCrank":{}}"#, ClientCommand::StopCrank {}),
            (
                r#"{"InsertBattery":{"extractor_id":"extractor:player:1","container":"player:field-pack","stack_id":"7","variant_id":32000060}}"#,
                ClientCommand::InsertBattery {
                    extractor_id: "extractor:player:1".to_owned(),
                    container: "player:field-pack".to_owned(),
                    stack_id: "7".to_owned(),
                    variant_id: 32_000_060,
                },
            ),
            (
                r#"{"CollectExtractor":{"extractor_id":"extractor:player:1"}}"#,
                ClientCommand::CollectExtractor {
                    extractor_id: "extractor:player:1".to_owned(),
                },
            ),
            (
                r#"{"DestroyExtractor":{"extractor_id":"extractor:player:1"}}"#,
                ClientCommand::DestroyExtractor {
                    extractor_id: "extractor:player:1".to_owned(),
                },
            ),
            (r#"{"PlaceCamp":{}}"#, ClientCommand::PlaceCamp {}),
            (r#"{"PackUpCamp":{}}"#, ClientCommand::PackUpCamp {}),
        ];

        for (json, expected) in cases {
            let input: AuthorityBridgeCommandInput = serde_json::from_str(json).unwrap();
            assert_eq!(input.into_authority_command().unwrap(), expected);
        }
    }

    #[test]
    fn client_command_deserializes_take_loot_item_camel_payload() {
        let command: ClientCommand = serde_json::from_str(
            r#"{
              "TakeLootItem": {
                "container": "corpse:loot-trooper",
                "itemId": 1001,
                "variantId": 7,
                "quantity": 3
              }
            }"#,
        )
        .unwrap();

        assert_eq!(
            command,
            ClientCommand::TakeLootItem {
                container: "corpse:loot-trooper".to_owned(),
                item_id: 1001,
                variant_id: 7,
                quantity: 3,
            }
        );

        assert!(serde_json::from_str::<ClientCommand>(
            r#"{
              "TakeLootItem": {
                "container": "corpse:loot-trooper",
                "item_id": 1001,
                "variant_id": 7,
                "quantity": 3
              }
            }"#,
        )
        .is_err());
    }
    #[test]
    fn bridge_deserializes_all_guild_commands_into_client_commands() {
        let cases = [
            (
                r#"{"GuildCreate":{"name":"Dust","tag":"DST","terminal_prop_id":"pa-1"}}"#,
                ClientCommand::GuildCreate {
                    name: "Dust".to_owned(),
                    tag: "DST".to_owned(),
                    terminal_prop_id: "pa-1".to_owned(),
                },
            ),
            (
                r#"{"GuildInvite":{"target_actor_id":"a"}}"#,
                ClientCommand::GuildInvite {
                    target_actor_id: "a".to_owned(),
                },
            ),
            (
                r#"{"GuildAcceptInvite":{"invite_id":"i"}}"#,
                ClientCommand::GuildAcceptInvite {
                    invite_id: "i".to_owned(),
                },
            ),
            (
                r#"{"GuildDeclineInvite":{"invite_id":"i"}}"#,
                ClientCommand::GuildDeclineInvite {
                    invite_id: "i".to_owned(),
                },
            ),
            (r#"{"GuildLeave":{}}"#, ClientCommand::GuildLeave {}),
            (
                r#"{"GuildKick":{"target_actor_id":"a"}}"#,
                ClientCommand::GuildKick {
                    target_actor_id: "a".to_owned(),
                },
            ),
            (
                r#"{"GuildSetRole":{"target_actor_id":"a","role":"officer"}}"#,
                ClientCommand::GuildSetRole {
                    target_actor_id: "a".to_owned(),
                    role: "officer".to_owned(),
                },
            ),
            (
                r#"{"GuildSetPermissions":{"target_actor_id":"a","permissions":31}}"#,
                ClientCommand::GuildSetPermissions {
                    target_actor_id: "a".to_owned(),
                    permissions: 31,
                },
            ),
            (
                r#"{"GuildTransferLeadership":{"target_actor_id":"a"}}"#,
                ClientCommand::GuildTransferLeadership {
                    target_actor_id: "a".to_owned(),
                },
            ),
            (
                r#"{"GuildDeclareWar":{"opposing_guild_id":"g"}}"#,
                ClientCommand::GuildDeclareWar {
                    opposing_guild_id: "g".to_owned(),
                },
            ),
            (
                r#"{"GuildAcceptWar":{"opposing_guild_id":"g"}}"#,
                ClientCommand::GuildAcceptWar {
                    opposing_guild_id: "g".to_owned(),
                },
            ),
            (
                r#"{"GuildRescindWar":{"opposing_guild_id":"g"}}"#,
                ClientCommand::GuildRescindWar {
                    opposing_guild_id: "g".to_owned(),
                },
            ),
            (r#"{"GuildDisband":{}}"#, ClientCommand::GuildDisband {}),
        ];
        for (json, expected) in cases {
            let parsed: AuthorityBridgeCommandInput = serde_json::from_str(json).unwrap();
            assert_eq!(parsed.into_authority_command().unwrap(), expected, "{json}");
        }
    }
}
