use super::*;

const AUTHORITY_CHECKPOINT_SCHEMA: &str = "authority.checkpoint.v1";
const AUTHORITY_CHECKPOINT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityCheckpointBlob {
    schema: String,
    version: u32,
    state_hash: String,
    payload_hash: String,
    state: AuthorityCheckpointV1,
}

impl AuthorityCheckpointBlob {
    pub fn schema(&self) -> &str {
        &self.schema
    }

    pub fn version(&self) -> u32 {
        self.version
    }

    pub fn state_hash(&self) -> &str {
        &self.state_hash
    }

    pub fn payload_hash(&self) -> &str {
        &self.payload_hash
    }

    pub fn tick(&self) -> u64 {
        self.state.tick
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthorityCheckpointV1 {
    tick: u64,
    actors: BTreeMap<String, ActorAuthorityState>,
    bark_claims: BarkClaims,
    population: PopulationAuthorityState,
    loot_caches: BTreeMap<String, LootCacheAuthorityState>,
    open_door_prop_ids: BTreeSet<String>,
    seen_commands: BTreeSet<(u64, u32, u64)>,
    inventory: Vec<InventoryStackSnapshot>,
    bank_accounts: BTreeMap<String, BankAccountAuthorityState>,
    player_corpses: BTreeMap<String, PlayerCorpseState>,
    next_player_corpse_id: u64,
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
    next_trade_proposal_id: u32,
    groups: BTreeMap<u64, GroupAuthorityState>,
    group_invites: BTreeMap<String, PendingGroupInvite>,
    next_group_id: u64,
    duels: BTreeMap<u64, DuelAuthorityState>,
    duel_challenges: BTreeMap<String, PendingDuelChallenge>,
    next_duel_id: u64,
    guilds: BTreeMap<String, GuildAuthorityState>,
    guild_invites: BTreeMap<String, PendingGuildInvite>,
    next_guild_id: u64,
    next_guild_invite_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum AuthorityCheckpointError {
    #[error("authority checkpoint schema `{found}` is not supported")]
    UnsupportedSchema { found: String },
    #[error("authority checkpoint version {found} is not supported")]
    UnsupportedVersion { found: u32 },
    #[error(
        "authority checkpoint payload hash mismatch: expected {expected}, reconstructed {actual}"
    )]
    PayloadHashMismatch { expected: String, actual: String },
}

fn checkpoint_payload_hash(state: &AuthorityCheckpointV1) -> String {
    let payload = serde_json::to_vec(state).expect("authority checkpoint payload serializes");
    let mut writer = StateWriter::new();
    writer
        .write_domain_header(b"authority-checkpoint")
        .write_schema_version(AUTHORITY_CHECKPOINT_VERSION)
        .write_u32(u32::try_from(payload.len()).expect("checkpoint payload length fits u32"))
        .write_bytes(&payload);
    writer.finalize_hex()
}

impl SliceAuthorityState {
    pub fn export_checkpoint(&self) -> AuthorityCheckpointBlob {
        let state = AuthorityCheckpointV1 {
            tick: self.runtime.durable.tick,
            actors: self.runtime.durable.actors.clone(),
            bark_claims: self.runtime.durable.bark_claims.clone(),
            population: self.runtime.durable.population.clone(),
            loot_caches: self.runtime.durable.loot_caches.clone(),
            open_door_prop_ids: self
                .runtime
                .durable
                .door_collision_bounds
                .iter()
                .filter(|door| door.open)
                .map(|door| door.prop_id.clone())
                .collect(),
            seen_commands: self.runtime.durable.seen_commands.clone(),
            inventory: self.runtime.durable.inventory.clone(),
            bank_accounts: self.runtime.durable.bank_accounts.clone(),
            player_corpses: self.runtime.durable.player_corpses.clone(),
            next_player_corpse_id: self.runtime.durable.next_player_corpse_id,
            inventory_stack_counters: self.runtime.durable.inventory_stack_counters.clone(),
            reservations: self.runtime.durable.reservations.clone(),
            npc_jobs: self.runtime.durable.npc_jobs.clone(),
            timeline_events: self.runtime.durable.timeline_events.clone(),
            placed_extractors: self.runtime.durable.placed_extractors.clone(),
            next_extractor_id: self.runtime.durable.next_extractor_id,
            placed_camps: self.runtime.durable.placed_camps.clone(),
            next_camp_id: self.runtime.durable.next_camp_id,
            crop_genomes: self.runtime.durable.crop_genomes.clone(),
            parcels: self.runtime.durable.parcels.clone(),
            next_parcel_id: self.runtime.durable.next_parcel_id,
            next_build_component_id: self.runtime.durable.next_build_component_id,
            plot_tending: self.runtime.durable.plot_tending.clone(),
            drafted_schematics: self.runtime.durable.drafted_schematics.clone(),
            next_drafted_schematic_id: self.runtime.durable.next_drafted_schematic_id,
            next_combat_event_id: self.runtime.durable.next_combat_event_id,
            combat_event_count: self.runtime.durable.combat_event_count,
            hits: self.runtime.durable.hits,
            deaths: self.runtime.durable.deaths,
            trade_proposals: self.runtime.durable.trade_proposals.clone(),
            next_trade_proposal_id: self.runtime.durable.next_trade_proposal_id,
            groups: self.runtime.durable.groups.clone(),
            group_invites: self.runtime.durable.group_invites.clone(),
            next_group_id: self.runtime.durable.next_group_id,
            duels: self.runtime.durable.duels.clone(),
            duel_challenges: self.runtime.durable.duel_challenges.clone(),
            next_duel_id: self.runtime.durable.next_duel_id,
            guilds: self.runtime.durable.guilds.clone(),
            guild_invites: self.runtime.durable.guild_invites.clone(),
            next_guild_id: self.runtime.durable.next_guild_id,
            next_guild_invite_id: self.runtime.durable.next_guild_invite_id,
        };
        let payload_hash = checkpoint_payload_hash(&state);
        AuthorityCheckpointBlob {
            schema: AUTHORITY_CHECKPOINT_SCHEMA.to_owned(),
            version: AUTHORITY_CHECKPOINT_VERSION,
            state_hash: self.stable_state_hash_hex(),
            payload_hash,
            state,
        }
    }

    /// Restores durable progress into this authority's current authored world.
    ///
    /// The checkpoint never owns map geometry, combat tuning, content catalogs,
    /// or transient delivery queues. Door openness is restored by prop id onto
    /// the current authored door bounds; removed doors are ignored and new doors
    /// retain their authored closed state.
    pub fn restore_checkpoint(
        &mut self,
        blob: AuthorityCheckpointBlob,
    ) -> Result<(), AuthorityCheckpointError> {
        if blob.schema != AUTHORITY_CHECKPOINT_SCHEMA {
            return Err(AuthorityCheckpointError::UnsupportedSchema { found: blob.schema });
        }
        if blob.version != AUTHORITY_CHECKPOINT_VERSION {
            return Err(AuthorityCheckpointError::UnsupportedVersion {
                found: blob.version,
            });
        }
        let actual_payload_hash = checkpoint_payload_hash(&blob.state);
        if actual_payload_hash != blob.payload_hash {
            return Err(AuthorityCheckpointError::PayloadHashMismatch {
                expected: blob.payload_hash,
                actual: actual_payload_hash,
            });
        }

        let AuthorityCheckpointV1 {
            tick,
            mut actors,
            bark_claims,
            population,
            loot_caches,
            open_door_prop_ids,
            seen_commands,
            mut inventory,
            bank_accounts,
            player_corpses,
            next_player_corpse_id,
            inventory_stack_counters,
            reservations,
            npc_jobs,
            timeline_events,
            placed_extractors,
            next_extractor_id,
            placed_camps,
            next_camp_id,
            mut crop_genomes,
            parcels,
            next_parcel_id,
            next_build_component_id,
            plot_tending,
            drafted_schematics,
            next_drafted_schematic_id,
            next_combat_event_id,
            combat_event_count,
            hits,
            deaths,
            mut trade_proposals,
            next_trade_proposal_id,
            groups,
            group_invites,
            next_group_id,
            duels,
            duel_challenges,
            next_duel_id,
            guilds,
            guild_invites,
            next_guild_id,
            next_guild_invite_id,
        } = blob.state;

        let world = self.runtime.durable.world.clone();
        state::migrate_legacy_currency_inventory(&mut actors, &mut inventory);
        state::migrate_legacy_currency_trade_proposals(&mut trade_proposals);
        let mut door_collision_bounds = self.runtime.durable.door_collision_bounds.clone();
        for door in &mut door_collision_bounds {
            door.open = open_door_prop_ids.contains(&door.prop_id);
        }
        let door_clearance_blocked_cells_by_prop =
            build_door_clearance_blocked_cells_by_prop(&world.areas, &door_collision_bounds);
        crop_genomes.rebuild_content_index();

        self.runtime = AuthorityRuntimeState {
            durable: DurableAuthorityState {
                world,
                tick,
                actors,
                bark_claims,
                population,
                loot_caches,
                door_collision_bounds,
                seen_commands,
                bank_accounts,
                player_corpses,
                next_player_corpse_id,
                inventory,
                inventory_stack_counters,
                reservations,
                npc_jobs,
                timeline_events,
                placed_extractors,
                next_extractor_id,
                placed_camps,
                next_camp_id,
                crop_genomes,
                parcels,
                next_parcel_id,
                next_build_component_id,
                plot_tending,
                drafted_schematics,
                next_drafted_schematic_id,
                next_combat_event_id,
                combat_event_count,
                hits,
                deaths,
                trade_proposals,
                next_trade_proposal_id,
                groups,
                group_invites,
                next_group_id,
                duels,
                duel_challenges,
                next_duel_id,
                guilds,
                guild_invites,
                next_guild_id,
                next_guild_invite_id,
            },
            door_clearance_blocked_cells_by_prop,
            ai_debug: SliceAuthorityAiDebugSnapshot::empty(tick),
            cached_skirmisher_tactical_state: None,
            last_advance_timing: SliceAuthorityAdvanceTiming::default(),
            current_ai_us: 0,
            current_ai_tactical_state_us: 0,
            current_ai_passive_creature_us: 0,
            current_ai_skirmisher_us: 0,
            current_ai_tactical_state_rebuilt: 0,
            current_ai_tactical_state_reused: 0,
            current_ai_updates: 0,
            current_ai_skipped: 0,
            current_route_us: 0,
            current_path_queries: Cell::new(0),
            current_path_expansions: Cell::new(0),
            current_removed_actor_ids: Vec::new(),
            current_linkdead_logout_actors: Vec::new(),
            pending_combat_events: Vec::new(),
            pending_ability_queue_events: Vec::new(),
            pending_survey_result: None,
            pending_craft_session: None,
            pending_splice_session: None,
            pending_genome_scan: None,
            pending_harvest: None,
            pending_factory_receipt: None,
            pending_parcel_claim: None,
            pending_dialogue_deliveries: Vec::new(),
            pending_trade_session_deliveries: Vec::new(),
            pending_duel_outcomes: Vec::new(),
        };
        self.sync_guild_actor_fields();
        self.normalize_timeline_events();
        Ok(())
    }

    pub fn actor_snapshot(&self, actor_id: &str) -> Option<AuthorityActorSnapshot> {
        self.runtime
            .durable
            .actors
            .get(actor_id)
            .map(|actor| self.actor_snapshot_from_actor(actor))
    }

    pub fn inventory_snapshots(&self) -> Vec<InventoryStackSnapshot> {
        let mut snapshots = self.runtime.durable.inventory.clone();
        for actor in self.runtime.durable.actors.values() {
            if !is_human_player_actor(actor) || actor.equipped_weapon_item_id != 0 {
                continue;
            }
            let Some(item_id) = actor
                .equipped_weapon_id
                .and_then(canonical_inventory_item_for_weapon_id)
            else {
                continue;
            };
            if snapshots.iter().any(|row| {
                actor_owns_inventory_container(&actor.id, &row.container)
                    && row.item_id == item_id
                    && row.quantity > 0
            }) {
                continue;
            }
            snapshots.push(InventoryStackSnapshot {
                stack_id: 0,
                container: format!("{}:field-pack", actor.id),
                item: inventory_item_name(item_id)
                    .expect("canonical weapon inventory item has a display name")
                    .to_owned(),
                item_id,
                variant_id: 0,
                quantity: 1,
                reserved: 0,
                available: 1,
            });
        }
        snapshots
    }

    pub fn reservation_snapshots(&self) -> Vec<ReservationSnapshot> {
        self.runtime.durable.reservations.clone()
    }

    pub fn npc_job_snapshots(&self) -> Vec<NpcJobSnapshot> {
        self.runtime.durable.npc_jobs.clone()
    }

    pub fn timeline_event_snapshots(&self) -> Vec<TimelineEventSnapshot> {
        self.runtime.durable.timeline_events.clone()
    }

    pub fn drafted_schematic_snapshots(&self) -> Vec<AuthorityDraftedSchematicSnapshot> {
        self.runtime
            .durable
            .drafted_schematics
            .values()
            .map(AuthorityDraftedSchematicSnapshot::from_state)
            .collect()
    }

    pub fn drafted_schematic_snapshots_for_observer(
        &self,
        config: &SliceAuthorityConfig,
    ) -> Vec<AuthorityDraftedSchematicSnapshot> {
        let Some(observer) = self.observer_actor(config) else {
            return Vec::new();
        };
        self.runtime
            .durable
            .drafted_schematics
            .values()
            .filter(|schematic| schematic.owner_actor_id == observer.id)
            .map(AuthorityDraftedSchematicSnapshot::from_state)
            .collect()
    }

    pub fn resource_spawn_snapshots_for_area(
        &self,
        area_id: &str,
    ) -> Vec<AuthorityResourceSpawnSnapshot> {
        active_resource_spawn_snapshots_for_area(area_id, self.runtime.durable.tick)
    }

    pub fn resource_spawn_snapshots_for_observer(
        &self,
        config: &SliceAuthorityConfig,
    ) -> Vec<AuthorityResourceSpawnSnapshot> {
        self.observer_actor(config)
            .map(|actor| self.resource_spawn_snapshots_for_area(&actor.area_id))
            .unwrap_or_default()
    }

    pub fn area_resource_spawn_snapshots(&self) -> Vec<AuthorityAreaResourceSpawnsSnapshot> {
        self.runtime
            .durable
            .world
            .areas
            .keys()
            .map(|area_id| AuthorityAreaResourceSpawnsSnapshot {
                area_id: area_id.clone(),
                resource_spawns: self.resource_spawn_snapshots_for_area(area_id),
            })
            .collect()
    }

    pub fn ai_debug_snapshot(&self) -> SliceAuthorityAiDebugSnapshot {
        self.runtime.ai_debug.clone()
    }

    pub fn actor_snapshots_for_observer(
        &self,
        config: &SliceAuthorityConfig,
    ) -> Vec<AuthorityActorSnapshot> {
        self.actor_snapshots_for(config)
    }

    pub fn removed_actor_ids_for_observer(&self, _config: &SliceAuthorityConfig) -> Vec<String> {
        self.runtime.current_removed_actor_ids.clone()
    }

    pub fn linkdead_logout_actor_snapshots_for_observer(
        &self,
        _config: &SliceAuthorityConfig,
    ) -> Vec<AuthorityActorSnapshot> {
        self.runtime.current_linkdead_logout_actors.clone()
    }

    pub fn combat_events_for_observer(
        &self,
        config: &SliceAuthorityConfig,
        combat_events: &[AuthorityCombatEventSnapshot],
    ) -> Vec<AuthorityCombatEventSnapshot> {
        self.combat_events_for(config, combat_events)
    }

    pub fn ability_queue_events_for_observer(
        &self,
        _config: &SliceAuthorityConfig,
        events: &[AuthorityAbilityQueueEventSnapshot],
    ) -> Vec<AuthorityAbilityQueueEventSnapshot> {
        events.to_vec()
    }

    pub fn take_ability_queue_events_for_observer(
        &mut self,
        config: &SliceAuthorityConfig,
    ) -> Vec<AuthorityAbilityQueueEventSnapshot> {
        let events = std::mem::take(&mut self.runtime.pending_ability_queue_events);
        self.ability_queue_events_for_observer(config, &events)
    }

    pub fn advance_ticks_for_observer(
        &mut self,
        config: &SliceAuthorityConfig,
        ticks: u16,
    ) -> Vec<AuthorityCombatEventSnapshot> {
        self.advance_ticks_for_observer_with_weather_hazards(config, ticks, &[])
    }

    pub fn advance_ticks_for_observer_with_weather_hazards(
        &mut self,
        config: &SliceAuthorityConfig,
        ticks: u16,
        weather_hazards: &[AuthorityWeatherHazard],
    ) -> Vec<AuthorityCombatEventSnapshot> {
        let safe_ticks = ticks.max(1);
        self.advance_ticks_for_observer_with_weather_iter(
            config,
            safe_ticks,
            std::iter::repeat(weather_hazards),
        )
    }

    pub fn advance_ticks_for_observer_with_weather_schedule(
        &mut self,
        config: &SliceAuthorityConfig,
        weather_hazards_by_tick: &[Vec<AuthorityWeatherHazard>],
    ) -> Vec<AuthorityCombatEventSnapshot> {
        let safe_ticks = u16::try_from(weather_hazards_by_tick.len())
            .unwrap_or(u16::MAX)
            .max(1);
        self.advance_ticks_for_observer_with_weather_iter(
            config,
            safe_ticks,
            weather_hazards_by_tick.iter().map(Vec::as_slice),
        )
    }

    fn advance_ticks_for_observer_with_weather_iter<'a>(
        &mut self,
        config: &SliceAuthorityConfig,
        ticks: u16,
        weather_hazards_by_tick: impl IntoIterator<Item = &'a [AuthorityWeatherHazard]>,
    ) -> Vec<AuthorityCombatEventSnapshot> {
        let total_timer = AuthorityTimer::start();
        self.runtime.current_ai_us = 0;
        self.runtime.current_ai_tactical_state_us = 0;
        self.runtime.current_ai_passive_creature_us = 0;
        self.runtime.current_ai_skirmisher_us = 0;
        self.runtime.current_ai_tactical_state_rebuilt = 0;
        self.runtime.current_ai_tactical_state_reused = 0;
        self.runtime.current_ai_updates = 0;
        self.runtime.current_ai_skipped = 0;
        self.runtime.current_route_us = 0;
        self.runtime.current_path_queries.set(0);
        self.runtime.current_path_expansions.set(0);
        self.runtime.current_removed_actor_ids.clear();
        self.runtime.current_linkdead_logout_actors.clear();
        let mut events = Vec::new();
        for weather_hazards in weather_hazards_by_tick.into_iter().take(usize::from(ticks)) {
            self.runtime.durable.tick = self.runtime.durable.tick.saturating_add(1);
            events.extend(self.advance_authority_tick_with_weather_hazards(weather_hazards));
        }
        self.runtime.last_advance_timing = SliceAuthorityAdvanceTiming {
            ticks,
            total_us: total_timer.elapsed_us(),
            ai_us: self.runtime.current_ai_us,
            ai_tactical_state_us: self.runtime.current_ai_tactical_state_us,
            ai_passive_creature_us: self.runtime.current_ai_passive_creature_us,
            ai_skirmisher_us: self.runtime.current_ai_skirmisher_us,
            ai_tactical_state_rebuilt: self.runtime.current_ai_tactical_state_rebuilt,
            ai_tactical_state_reused: self.runtime.current_ai_tactical_state_reused,
            ai_updates: self.runtime.current_ai_updates,
            ai_skipped: self.runtime.current_ai_skipped,
            route_us: self.runtime.current_route_us,
            path_queries: self.runtime.current_path_queries.get(),
            path_expansions: self.runtime.current_path_expansions.get(),
        };
        self.combat_events_for_observer(config, &events)
    }

    pub fn advance_ticks_with_changed_actor_snapshots_for_observer(
        &mut self,
        config: &SliceAuthorityConfig,
        ticks: u16,
    ) -> (
        Vec<AuthorityActorSnapshot>,
        Vec<AuthorityCombatEventSnapshot>,
    ) {
        let combat_events = self.advance_ticks_for_observer(config, ticks);
        let actors = self.actor_snapshots_for_observer(config);
        (actors, combat_events)
    }

    pub fn stable_state_hash_hex(&self) -> String {
        let mut w = StateWriter::new();
        w.write_domain_header(b"authority")
            .write_schema_version(1)
            .write_tick(self.runtime.durable.tick)
            .write_u32(self.runtime.durable.world.tick_rate_hz);
        w.write_u32(self.runtime.durable.world.combat_model.code());
        w.write_u32(
            u32::try_from(self.runtime.durable.world.weapon_range_bands.len())
                .expect("weapon range band count fits u32"),
        );
        for (weapon_id, bands) in &self.runtime.durable.world.weapon_range_bands {
            write_string(&mut w, authority_weapon_id_label(*weapon_id));
            w.write_i64(i64::from(bands.point_blank_cells))
                .write_i64(i64::from(bands.ideal_cells))
                .write_i64(i64::from(bands.max_cells));
        }
        w.write_u32(
            u32::try_from(self.runtime.durable.world.areas.len()).expect("area count fits u32"),
        );
        for area in self.runtime.durable.world.areas.values() {
            write_string(&mut w, &area.id);
            write_string(&mut w, &area.kind);
            w.write_u32(area.width)
                .write_u32(area.height)
                .write_i64(i64::from(area.level));
        }
        w.write_u32(
            u32::try_from(self.runtime.durable.world.clone_facilities.len())
                .expect("clone facility count fits u32"),
        );
        for facility in &self.runtime.durable.world.clone_facilities {
            write_string(&mut w, &facility.id);
            write_string(&mut w, &facility.area_id);
            w.write_i64(i64::from(facility.respawn_cell.x))
                .write_i64(i64::from(facility.respawn_cell.y));
            write_string(&mut w, &facility.respawn_facing);
            w.write_tick(facility.sickness_duration_ticks);
        }
        w.write_u32(
            u32::try_from(self.runtime.durable.world.factions.len())
                .expect("faction count fits u32"),
        );
        for faction in self.runtime.durable.world.factions.rules() {
            write_string(&mut w, &faction.id);
            write_string(&mut w, &faction.label);
            w.write_bool(faction.player_allowed)
                .write_i64(i64::from(faction.adjust_factor_milli))
                .write_u32(
                    u32::try_from(faction.enemies.len()).expect("enemy faction count fits u32"),
                );
            for enemy in &faction.enemies {
                write_string(&mut w, enemy);
            }
            w.write_u32(u32::try_from(faction.allies.len()).expect("ally faction count fits u32"));
            for ally in &faction.allies {
                write_string(&mut w, ally);
            }
        }
        w.write_u32(
            u32::try_from(self.runtime.durable.world.player_organizations.len())
                .expect("player organization count fits u32"),
        );
        for organization in self.runtime.durable.world.player_organizations.values() {
            write_string(&mut w, &organization.id);
            write_string(&mut w, &organization.label);
            write_string(&mut w, &organization.tag);
            w.write_u32(
                u32::try_from(organization.member_actor_ids.len())
                    .expect("player organization member count fits u32"),
            );
            for member_actor_id in &organization.member_actor_ids {
                write_string(&mut w, member_actor_id);
            }
            w.write_u32(
                u32::try_from(organization.ally_organization_ids.len())
                    .expect("player organization ally count fits u32"),
            );
            for ally_id in &organization.ally_organization_ids {
                write_string(&mut w, ally_id);
            }
            w.write_u32(
                u32::try_from(organization.enemy_organization_ids.len())
                    .expect("player organization enemy count fits u32"),
            );
            for enemy_id in &organization.enemy_organization_ids {
                write_string(&mut w, enemy_id);
            }
        }
        w.write_u32(
            u32::try_from(self.runtime.durable.actors.len()).expect("actor count fits u32"),
        );
        for actor in self.runtime.durable.actors.values() {
            write_string(&mut w, &actor.id);
            write_string(&mut w, &actor.entity);
            write_string(&mut w, &actor.label);
            write_string(&mut w, &actor.display_name);
            w.write_bool(actor.link_dead)
                .write_tick(actor.link_dead_expires_tick);
            write_string(&mut w, &actor.appearance.skin);
            write_optional_string(&mut w, actor.appearance.hair.as_deref());
            write_string(&mut w, &actor.appearance.hair_mat);
            // Empty-gated for legacy compatibility: None writes no hash bytes.
            if let Some(face) = actor.appearance.face.as_ref() {
                w.write_domain_header(b"actor.face").write_schema_version(1);
                write_string(&mut w, &face.eyes);
                write_string(&mut w, &face.brows);
                write_string(&mut w, &face.nose);
                write_string(&mut w, &face.mouth);
                write_string(&mut w, &face.eye_color);
                write_string(&mut w, &face.brow_color);
                write_string(&mut w, &face.lip_color);
            }
            write_string(&mut w, &actor.sprite);
            write_optional_string(&mut w, actor.template_id.as_deref());
            write_optional_string(&mut w, actor.spawn_zone_id.as_deref());
            write_string(&mut w, &actor.role);
            write_optional_string(&mut w, actor.faction.faction_id.as_deref());
            write_optional_string(&mut w, actor.faction.social_group.as_deref());
            w.write_u32(actor.faction.pvp_status.code());
            write_optional_string(&mut w, actor.player_organization_id.as_deref());
            write_optional_string(&mut w, actor.player_organization_tag.as_deref());
            write_string(&mut w, &actor.area_id);
            write_string(&mut w, &actor.home_area_id);
            w.write_i64(i64::from(actor.cell.x))
                .write_i64(i64::from(actor.cell.y))
                .write_i64(i64::from(actor.position.x))
                .write_i64(i64::from(actor.position.y))
                .write_i64(i64::from(actor.home_cell.x))
                .write_i64(i64::from(actor.home_cell.y))
                .write_u32(actor.scale)
                .write_i64(i64::from(actor.vitals.health))
                .write_i64(i64::from(actor.vitals.action))
                .write_i64(i64::from(actor.vitals.spirit))
                .write_u32(actor.life_state.code())
                .write_u64(actor.lifecycle_seq)
                .write_u32(actor.posture.code())
                .write_tick(actor.posture_until_tick)
                .write_tick(actor.next_fire_tick)
                .write_u32(actor.equipped_weapon_id.map_or(0, AuthorityWeaponId::code))
                .write_u32(actor.equipped_weapon_item_id);
            // Empty-gated so pre-variant checkpoints retain their stable hash.
            // Exact crafted instances still contribute whenever the variant is nonzero.
            if actor.equipped_weapon_variant_id != 0 {
                w.write_u32(actor.equipped_weapon_variant_id);
            }
            // Empty-gated for v4 compatibility: historical checkpoints omitted
            // clothing instance identity and therefore hash no bytes.
            if !actor.equipped_clothing.is_empty() {
                w.write_u32(
                    u32::try_from(actor.equipped_clothing.len())
                        .expect("equipped clothing count fits u32"),
                );
                for clothing in &actor.equipped_clothing {
                    // Legacy v4 identities deserialize with an empty container.
                    // Hash those byte-for-byte like the pre-container format;
                    // nonempty current identities still distinguish containers.
                    if !clothing.container.is_empty() {
                        write_string(&mut w, &clothing.container);
                    }
                    w.write_u64(clothing.stack_id)
                        .write_u32(clothing.item_id)
                        .write_u32(clothing.variant_id);
                }
            }
            w.write_u32(actor.slugthrower_magazine.loaded_rounds)
                .write_tick(actor.slugthrower_magazine.reload_until_tick)
                .write_tick(actor.next_move_tick);
            w.write_bool(actor.move_intent.is_some());
            if let Some(intent) = actor.move_intent.as_ref() {
                w.write_i64(i64::from(intent.dx))
                    .write_i64(i64::from(intent.dy))
                    .write_u32(intent.facing.map_or(0, cardinal_direction_code))
                    .write_bool(intent.sprint)
                    .write_tick(intent.updated_tick)
                    .write_tick(intent.expires_tick);
            }
            w.write_tick(actor.next_economy_action_tick)
                .write_tick(actor.next_resource_survey_tick)
                .write_tick(actor.body_vanish_tick)
                .write_tick(actor.respawn_tick)
                .write_tick(actor.clone_sickness_ticks)
                .write_u64(actor.shots_fired);
            w.write_u32(
                u32::try_from(actor.player_damage_ledger.len())
                    .expect("player damage ledger count fits u32"),
            );
            for entry in &actor.player_damage_ledger {
                write_string(&mut w, &entry.source_actor_id);
                w.write_u32(entry.cumulative_damage)
                    .write_tick(entry.first_damage_tick);
            }
            write_optional_string(&mut w, actor.loot_rights_actor_id.as_deref());
            write_optional_tick(&mut w, actor.corpse_exhausted_tick);
            write_optional_tick(&mut w, actor.creature_corpse_harvested_tick);
            if !actor.gaia_harvest_entitled_actor_ids.is_empty()
                || !actor.gaia_harvest_claimed_actor_ids.is_empty()
            {
                w.write_u32(
                    u32::try_from(actor.gaia_harvest_entitled_actor_ids.len())
                        .expect("Gaia entitlement count fits u32"),
                );
                for actor_id in &actor.gaia_harvest_entitled_actor_ids {
                    write_string(&mut w, actor_id);
                }
                w.write_u32(
                    u32::try_from(actor.gaia_harvest_claimed_actor_ids.len())
                        .expect("Gaia claim count fits u32"),
                );
                for actor_id in &actor.gaia_harvest_claimed_actor_ids {
                    write_string(&mut w, actor_id);
                }
            }
            w.write_tick(actor.combat_until_tick);
            write_optional_string(&mut w, actor.engagement_target_id.as_deref());
            w.write_bool(actor.peace_requested);
            actor.combat_queue.write_stable_hash(&mut w);
            write_optional_tick(&mut w, actor.last_moved_tick);
            w.write_bool(actor.pending_resource_sample.is_some());
            if let Some(sample) = actor.pending_resource_sample.as_ref() {
                write_string(&mut w, &sample.family);
                write_string(&mut w, &sample.area_id);
                w.write_i64(i64::from(sample.cell.x))
                    .write_i64(i64::from(sample.cell.y))
                    .write_tick(sample.resolve_tick);
            }
            w.write_bool(actor.resource_sample_loop.is_some());
            if let Some(sample_loop) = actor.resource_sample_loop.as_ref() {
                write_string(&mut w, &sample_loop.family);
                write_string(&mut w, &sample_loop.area_id);
                w.write_i64(i64::from(sample_loop.cell.x))
                    .write_i64(i64::from(sample_loop.cell.y))
                    .write_tick(sample_loop.next_sample_tick);
            }
            write_optional_string(&mut w, actor.cranking_extractor_id.as_deref());
            write_craft_session_state(&mut w, actor.craft_session.as_ref());
            w.write_u32(
                u32::try_from(actor.known_recipe_ids.len()).expect("known recipe count fits u32"),
            );
            for recipe_id in &actor.known_recipe_ids {
                write_string(&mut w, recipe_id);
            }
            // Splice session + permanent scan knowledge are gameplay-authoritative
            // (accepted SpliceChooseAllele / experiment / ScanGenome mutate only these).
            // Hash-participate them so replicas cannot diverge in session/scan state
            // under an identical hash (P0-1). Empty-gated: a None session + empty scan
            // set write ZERO bytes, so worlds with no bio activity stay byte-identical.
            if let Some(splice) = actor.splice_session.as_ref() {
                write_splice_session_state(&mut w, splice);
            }
            if !actor.scanned_genomes.is_empty() {
                w.write_u32(
                    u32::try_from(actor.scanned_genomes.len())
                        .expect("scanned genome count fits u32"),
                );
                for handle in &actor.scanned_genomes {
                    w.write_u32(*handle);
                }
            }
            w.write_tick(actor.next_starter_tool_request_tick);
            write_optional_tick(&mut w, actor.last_shot_tick);
            w.write_u64(actor.stats.damage_done)
                .write_u64(actor.stats.damage_taken)
                .write_u64(actor.stats.kills)
                .write_u64(actor.stats.npc_kills)
                .write_u64(actor.stats.player_kills)
                .write_u64(actor.stats.deaths)
                .write_u64(actor.stats.shots_fired)
                .write_u64(actor.stats.hits_dealt)
                .write_u64(actor.stats.hits_taken)
                .write_u64(actor.stats.distance_moved_milli);
            write_optional_tick(&mut w, actor.stats.last_damage_dealt_tick);
            write_optional_tick(&mut w, actor.stats.last_damage_taken_tick);
            write_optional_tick(&mut w, actor.stats.last_kill_tick);
            w.write_bool(actor.stats.last_death.is_some());
            if let Some(death) = actor.stats.last_death.as_ref() {
                w.write_tick(death.tick);
                write_string(&mut w, &death.killer_actor_id);
                write_string(&mut w, &death.cause);
                w.write_u32(death.weapon_id.code())
                    .write_u32(death.ammo_type.code());
            }
            w.write_u32(
                u32::try_from(actor.stats.buckets.len())
                    .expect("actor stats bucket count fits u32"),
            );
            for bucket in &actor.stats.buckets {
                w.write_tick(bucket.start_tick)
                    .write_u64(bucket.damage_done)
                    .write_u64(bucket.damage_taken)
                    .write_u64(bucket.kills)
                    .write_u64(bucket.npc_kills)
                    .write_u64(bucket.player_kills)
                    .write_u64(bucket.deaths)
                    .write_u64(bucket.shots_fired)
                    .write_u64(bucket.hits_dealt)
                    .write_u64(bucket.hits_taken)
                    .write_u64(bucket.distance_moved_milli);
            }
            w.write_u32(u32::from(actor.sleep.stacks))
                .write_u32(u32::from(actor.sleep.remaining_ticks))
                .write_i64(i64::from(actor.suppression.pressure_milli))
                .write_bool(actor.suppression.source.is_some())
                .write_u32(
                    u32::try_from(actor.bleed_stacks.len()).expect("bleed stack count fits u32"),
                );
            for stack in &actor.bleed_stacks {
                w.write_i64(i64::from(stack.damage_milli_per_tick))
                    .write_i64(i64::from(stack.accumulated_damage_milli))
                    .write_u32(u32::from(stack.remaining_ticks))
                    .write_u32(
                        u32::try_from(stack.source_actor_id.len())
                            .expect("source actor id length fits u32"),
                    )
                    .write_bytes(stack.source_actor_id.as_bytes());
            }
            w.write_i64(i64::from(actor.weather_damage_accumulated_milli));
            w.write_i64(i64::from(actor.sprint_action_drain_milli))
                .write_bool(actor.sprint_recovery_locked)
                .write_i64(actor.sprint_recovery_regen_carry);
            w.write_tick(actor.sprint_regen_block_until_tick);
            w.write_i64(i64::from(actor.downed_action_drain_milli))
                .write_i64(i64::from(actor.downed_spirit_drain_milli))
                .write_tick(actor.incap_expires_tick)
                .write_u32(u32::from(actor.incap_count))
                .write_tick(actor.incap_window_start_tick)
                .write_tick(actor.incap_grace_until_tick)
                .write_i64(i64::from(actor.passive_regen_milli.health))
                .write_i64(i64::from(actor.passive_regen_milli.action))
                .write_i64(i64::from(actor.passive_regen_milli.spirit));
            w.write_u32(
                u32::try_from(actor.consumable_effects.len())
                    .expect("consumable effect count fits u32"),
            );
            for effect in &actor.consumable_effects {
                write_string(&mut w, &effect.item_id);
                write_string(&mut w, &effect.effect_id);
                w.write_u32(u32::from(effect.remaining_ticks))
                    .write_u32(u32::from(effect.total_ticks))
                    .write_i64(i64::from(effect.heal_remaining_milli))
                    .write_i64(i64::from(effect.accumulated_heal_milli));
            }
            w.write_u32(
                u32::try_from(actor.service_buffs.len()).expect("service buff count fits u32"),
            );
            for buff in &actor.service_buffs {
                write_string(&mut w, &buff.effect_id);
                w.write_tick(buff.remaining_ticks)
                    .write_tick(buff.total_ticks)
                    .write_i64(i64::from(buff.body_delta))
                    .write_i64(i64::from(buff.spirit_delta))
                    .write_i64(i64::from(buff.defense_vs_state_milli));
            }
            w.write_bool(actor.personal_shield.is_some());
            if let Some(shield) = actor.personal_shield.as_ref() {
                w.write_u32(shield.charge_milli)
                    .write_u32(shield.durability_milli)
                    .write_u32(u32::from(shield.durability_charges))
                    .write_tick(shield.last_damage_tick)
                    .write_tick(shield.last_block_tick);
            }
            w.write_i64(i64::from(actor.weapon_recoil_heat_milli))
                .write_tick(actor.weapon_recoil_last_tick);
            w.write_u32(
                u32::try_from(actor.professions.learned.len())
                    .expect("actor profession count fits u32"),
            );
            for profession in &actor.professions.learned {
                write_string(&mut w, profession.id());
            }
            w.write_u32(
                u32::try_from(actor.professions.xp.len())
                    .expect("actor profession xp count fits u32"),
            );
            for (profession, xp) in &actor.professions.xp {
                write_string(&mut w, profession.id());
                w.write_u64(*xp);
            }
            w.write_u32(
                u32::try_from(actor.professions.track_xp.len())
                    .expect("actor profession track xp count fits u32"),
            );
            for (track_key, xp) in &actor.professions.track_xp {
                write_string(&mut w, track_key);
                w.write_u64(*xp);
            }
            w.write_u32(u32::from(actor.professions.skill_point_cap))
                .write_u32(u32::from(actor.professions.skill_points_used()));
            w.write_u32(
                u32::try_from(actor.professions.skill_boxes.len())
                    .expect("actor skill box count fits u32"),
            );
            for skill_box_id in &actor.professions.skill_boxes {
                write_string(&mut w, skill_box_id);
            }
            write_string(
                &mut w,
                actor.professions.active_title_id.as_deref().unwrap_or(""),
            );
            w.write_u64(actor.professions.credits);
            w.write_u32(
                u32::try_from(actor.capabilities.granted.len())
                    .expect("actor capability count fits u32"),
            );
            for capability in &actor.capabilities.granted {
                write_string(&mut w, capability);
            }
            w.write_u32(
                u32::try_from(actor.capability_grants.len())
                    .expect("actor explicit capability grant count fits u32"),
            );
            for capability in &actor.capability_grants {
                write_string(&mut w, capability);
            }
            write_string(&mut w, actor.career_goal_id.as_deref().unwrap_or(""));
            if let Some(source) = actor.suppression.source {
                w.write_i64(i64::from(source.x))
                    .write_i64(i64::from(source.y));
            }
            write_ai_state_hash(&mut w, actor.ai.as_ref());
            write_string(&mut w, &actor.direction);
            write_string(&mut w, &actor.home_direction);
            w.write_u32(u32::try_from(actor.home_route.len()).expect("home route length fits u32"));
            for route_cell in &actor.home_route {
                w.write_i64(i64::from(route_cell.x))
                    .write_i64(i64::from(route_cell.y));
            }
            w.write_u32(u32::try_from(actor.route.len()).expect("route length fits u32"));
            for route_cell in &actor.route {
                w.write_i64(i64::from(route_cell.x))
                    .write_i64(i64::from(route_cell.y));
            }
            w.write_u32(u32::try_from(actor.route_index).expect("route index fits u32"))
                .write_tick(actor.next_route_tick);
            w.write_u32(
                u32::try_from(actor.respawn_return.len()).expect("respawn return length fits u32"),
            );
            for step in &actor.respawn_return {
                match step {
                    RespawnReturnStepAuthorityState::Walk { area_id, cell } => {
                        w.write_u32(1);
                        write_string(&mut w, area_id);
                        w.write_i64(i64::from(cell.x)).write_i64(i64::from(cell.y));
                    }
                }
            }
        }
        // Empty-gated to preserve historical v1-v3 hashes. Once a claim exists
        // it participates in the current v4 state hash.
        if self.runtime.durable.bark_claims.entries().next().is_some() {
            let entries = self
                .runtime
                .durable
                .bark_claims
                .entries()
                .collect::<Vec<_>>();
            w.write_u32(u32::try_from(entries.len()).expect("bark claim count fits u32"));
            for entry in entries {
                write_string(&mut w, entry);
            }
        }
        self.runtime.durable.population.write_stable_hash(&mut w);
        w.write_u32(
            u32::try_from(self.runtime.durable.world.blocked_cells.len())
                .expect("blocked cell count fits u32"),
        );
        for cell in &self.runtime.durable.world.blocked_cells {
            write_string(&mut w, &cell.area_id);
            w.write_i64(i64::from(cell.x)).write_i64(i64::from(cell.y));
        }
        w.write_u32(
            u32::try_from(self.runtime.durable.world.fine_collision_bounds.len())
                .expect("fine collision bound count fits u32"),
        );
        for bounds in &self.runtime.durable.world.fine_collision_bounds {
            write_string(&mut w, &bounds.prop_id);
            write_string(&mut w, &bounds.area_id);
            w.write_i64(i64::from(bounds.left))
                .write_i64(i64::from(bounds.right))
                .write_i64(i64::from(bounds.top))
                .write_i64(i64::from(bounds.bottom));
        }
        w.write_u32(
            u32::try_from(self.runtime.durable.door_collision_bounds.len())
                .expect("door collision bound count fits u32"),
        );
        for bounds in &self.runtime.durable.door_collision_bounds {
            write_string(&mut w, &bounds.prop_id);
            write_string(&mut w, &bounds.area_id);
            w.write_i64(i64::from(bounds.left))
                .write_i64(i64::from(bounds.right))
                .write_i64(i64::from(bounds.top))
                .write_i64(i64::from(bounds.bottom))
                .write_bool(bounds.open);
        }
        w.write_u32(
            u32::try_from(self.runtime.durable.world.cover_points.len())
                .expect("cover point count fits u32"),
        );
        for point in &self.runtime.durable.world.cover_points {
            write_string(&mut w, &point.prop_id);
            write_string(&mut w, &point.area_id);
            w.write_i64(i64::from(point.cell.x))
                .write_i64(i64::from(point.cell.y))
                .write_i64(i64::from(point.position.x))
                .write_i64(i64::from(point.position.y))
                .write_u32(point.side.code())
                .write_i64(i64::from(point.rating_milli))
                .write_bool(point.high)
                .write_i64(i64::from(point.prop_left))
                .write_i64(i64::from(point.prop_right))
                .write_i64(i64::from(point.prop_top))
                .write_i64(i64::from(point.prop_bottom));
        }
        w.write_u32(
            u32::try_from(self.runtime.durable.world.ammo_stockpiles.len())
                .expect("ammo stockpile count fits u32"),
        );
        for stockpile in &self.runtime.durable.world.ammo_stockpiles {
            write_string(&mut w, &stockpile.prop_id);
            write_string(&mut w, &stockpile.area_id);
            write_string(&mut w, &stockpile.container);
            write_optional_string(&mut w, stockpile.faction_id.as_deref());
            w.write_i64(i64::from(stockpile.position.x))
                .write_i64(i64::from(stockpile.position.y))
                .write_i64(i64::from(stockpile.cell.x))
                .write_i64(i64::from(stockpile.cell.y))
                .write_u32(stockpile.item_id)
                .write_u32(stockpile.quantity);
        }
        w.write_u32(
            u32::try_from(self.runtime.durable.world.exchange_containers.len())
                .expect("exchange container count fits u32"),
        );
        for container in &self.runtime.durable.world.exchange_containers {
            write_string(&mut w, &container.prop_id);
            write_string(&mut w, &container.area_id);
            write_optional_string(&mut w, container.owner_actor_id.as_deref());
            w.write_u32(
                u32::try_from(container.allowed_actor_ids.len())
                    .expect("exchange allowed actor count fits u32"),
            );
            for actor_id in &container.allowed_actor_ids {
                write_string(&mut w, actor_id);
            }
            w.write_u32(
                u32::try_from(container.allowed_faction_ids.len())
                    .expect("exchange allowed faction count fits u32"),
            );
            for faction_id in &container.allowed_faction_ids {
                write_string(&mut w, faction_id);
            }
            w.write_i64(i64::from(container.position.x))
                .write_i64(i64::from(container.position.y))
                .write_i64(i64::from(container.cell.x))
                .write_i64(i64::from(container.cell.y))
                .write_i64(i64::from(container.left_milli))
                .write_i64(i64::from(container.right_milli))
                .write_i64(i64::from(container.top_milli))
                .write_i64(i64::from(container.bottom_milli))
                .write_i64(i64::from(container.interaction_radius_milli));
        }
        // Preserve the reserved empty combat-state slot in Roll-era v1 exports.
        // Current saves retain no state at this position.
        w.write_u32(0);
        w.write_u32(
            u32::try_from(self.runtime.durable.placed_extractors.len())
                .expect("placed extractor count fits u32"),
        );
        for extractor in self.runtime.durable.placed_extractors.values() {
            let extractor = self.materialized_placed_extractor_state(extractor);
            write_string(&mut w, &extractor.extractor_id);
            write_string(&mut w, &extractor.owner_actor_id);
            write_string(&mut w, &extractor.area_id);
            w.write_i64(i64::from(extractor.cell.x))
                .write_i64(i64::from(extractor.cell.y))
                .write_i64(i64::from(extractor.position.x))
                .write_i64(i64::from(extractor.position.y));
            write_string(&mut w, &extractor.family);
            w.write_u32(extractor.resource_item_id)
                .write_u32(extractor.resource_variant_id)
                .write_u32(extractor.tool_variant_id)
                .write_u64(extractor.hopper_milli)
                .write_tick(extractor.placed_at_tick)
                .write_u32(extractor.mode.code())
                .write_tick(extractor.next_extractor_tick)
                .write_u32(extractor.biome.code())
                .write_u32(extractor.battery_remaining_seconds)
                .write_u32(extractor.battery_variant_id)
                .write_tick(extractor.extraction_started_tick)
                .write_tick(extractor.battery_inserted_tick);
        }
        w.write_u32(
            u32::try_from(self.runtime.durable.placed_camps.len())
                .expect("placed camp count fits u32"),
        );
        for camp in self.runtime.durable.placed_camps.values() {
            write_string(&mut w, &camp.camp_id);
            write_string(&mut w, &camp.owner_actor_id);
            write_string(&mut w, &camp.area_id);
            w.write_i64(i64::from(camp.cell.x))
                .write_i64(i64::from(camp.cell.y))
                .write_i64(i64::from(camp.position.x))
                .write_i64(i64::from(camp.position.y))
                .write_tick(camp.placed_at_tick)
                .write_bool(camp.teardown_tick.is_some())
                .write_tick(camp.teardown_tick.unwrap_or(0));
        }
        w.write_u64(self.runtime.durable.next_extractor_id);
        w.write_u32(
            u32::try_from(self.runtime.durable.drafted_schematics.len())
                .expect("drafted schematic count fits u32"),
        );
        for schematic in self.runtime.durable.drafted_schematics.values() {
            write_string(&mut w, &schematic.id);
            write_string(&mut w, &schematic.owner_actor_id);
            write_string(&mut w, &schematic.recipe_id);
            write_resource_locks(&mut w, &schematic.resource_locks);
            w.write_u32(schematic.output_item_id)
                .write_u32(schematic.output_variant_id)
                .write_u32(schematic.schematic_item_variant_id)
                .write_u32(u32::from(schematic.max_uses))
                .write_u32(u32::from(schematic.remaining_uses));
        }
        w.write_u64(self.runtime.durable.next_drafted_schematic_id);
        // Bio-Engineer genome registry (empty writes nothing; §0.2).
        self.runtime.durable.crop_genomes.write_stable_hash(&mut w);
        w.write_u32(
            u32::try_from(self.runtime.durable.inventory.len()).expect("inventory count fits u32"),
        );
        for row in &self.runtime.durable.inventory {
            write_string(&mut w, &row.container);
            write_string(&mut w, &row.item);
            w.write_u64(row.stack_id)
                .write_u32(row.item_id)
                .write_u32(row.variant_id)
                .write_u32(row.quantity)
                .write_u32(row.reserved)
                .write_u32(row.available);
        }
        w.write_u32(
            u32::try_from(self.runtime.durable.inventory_stack_counters.len())
                .expect("inventory stack counter count fits u32"),
        );
        for (container, next_stack_id) in &self.runtime.durable.inventory_stack_counters {
            write_string(&mut w, container);
            w.write_u64(*next_stack_id);
        }
        w.write_u32(
            u32::try_from(self.runtime.durable.reservations.len())
                .expect("reservation count fits u32"),
        );
        for reservation in &self.runtime.durable.reservations {
            w.write_u32(reservation.id);
            write_string(&mut w, &reservation.actor);
            write_string(&mut w, &reservation.purpose);
            write_string(&mut w, &reservation.from);
            write_string(&mut w, &reservation.item);
            w.write_u32(reservation.quantity);
            match reservation.expires_at_tick {
                Some(tick) => {
                    w.write_bool(true).write_tick(tick);
                }
                None => {
                    w.write_bool(false);
                }
            }
        }
        w.write_u32(
            u32::try_from(self.runtime.durable.npc_jobs.len()).expect("npc job count fits u32"),
        );
        for job in &self.runtime.durable.npc_jobs {
            write_string(&mut w, &job.actor);
            write_string(&mut w, &job.kind);
            write_string(&mut w, &job.label);
            write_optional_string(&mut w, job.target_prop_id.as_deref());
            write_optional_cell_snapshot(&mut w, job.target_cell.as_ref());
            w.write_u32(job.priority);
            write_string(&mut w, &job.state);
        }
        w.write_u32(
            u32::try_from(self.runtime.durable.timeline_events.len())
                .expect("timeline event count fits u32"),
        );
        for event in &self.runtime.durable.timeline_events {
            w.write_tick(event.tick);
            write_string(&mut w, &event.label);
            write_optional_cell_snapshot(&mut w, event.cell.as_ref());
        }
        // Retain the three reserved zero slots in the v1 state hash so Roll saves
        // remain importable after the retired combat state was removed.
        w.write_u64(1)
            .write_u64(self.runtime.durable.next_combat_event_id)
            .write_u64(self.runtime.durable.combat_event_count)
            .write_u64(self.runtime.durable.hits)
            .write_u64(self.runtime.durable.deaths)
            .write_u64(0)
            .write_u64(0)
            .write_u64(0);
        self.write_trade_sessions_stable_hash(&mut w);
        self.write_groups_stable_hash(&mut w);
        self.write_duels_stable_hash(&mut w);
        self.write_parcels_stable_hash(&mut w);
        self.write_building_stable_hash(&mut w);
        self.write_guilds_stable_hash(&mut w);
        self.write_plot_tending_stable_hash(&mut w);
        self.write_camp_shelter_footprints_stable_hash(&mut w);
        self.write_bank_and_corpses_stable_hash(&mut w);
        w.finalize_hex()
    }
    fn write_bank_and_corpses_stable_hash(&self, w: &mut StateWriter) {
        if self.runtime.durable.world.terminals.is_empty()
            && self.runtime.durable.bank_accounts.is_empty()
            && self.runtime.durable.player_corpses.is_empty()
            && self.runtime.durable.next_player_corpse_id == 1
        {
            return;
        }
        write_string(w, "bank-clone-corpse.v3");
        w.write_u32(
            u32::try_from(self.runtime.durable.world.terminals.len())
                .expect("terminal count fits u32"),
        );
        for terminal in &self.runtime.durable.world.terminals {
            write_string(w, &terminal.id);
            write_string(w, &terminal.kind);
            write_string(w, &terminal.area_id);
            w.write_i64(i64::from(terminal.cell.x))
                .write_i64(i64::from(terminal.cell.y));
        }
        w.write_u32(
            u32::try_from(self.runtime.durable.bank_accounts.len())
                .expect("bank account count fits u32"),
        );
        for (actor_id, account) in &self.runtime.durable.bank_accounts {
            write_string(w, actor_id);
            w.write_u64(account.bank_credits);
            w.write_bool(account.skill_backup.is_some());
            if let Some(backup) = account.skill_backup.as_ref() {
                w.write_u64(backup.saved_tick)
                    .write_u32(u32::try_from(backup.learned.len()).unwrap_or(u32::MAX));
                for profession in &backup.learned {
                    write_string(w, profession.id());
                }
                w.write_u32(u32::try_from(backup.xp.len()).unwrap_or(u32::MAX));
                for (profession, xp) in &backup.xp {
                    write_string(w, profession.id());
                    w.write_u64(*xp);
                }
                w.write_u32(u32::try_from(backup.track_xp.len()).unwrap_or(u32::MAX));
                for (track, xp) in &backup.track_xp {
                    write_string(w, track);
                    w.write_u64(*xp);
                }
                w.write_u32(u32::try_from(backup.skill_boxes.len()).unwrap_or(u32::MAX));
                for skill in &backup.skill_boxes {
                    write_string(w, skill);
                }
                write_optional_string(w, backup.active_title_id.as_deref());
                w.write_u32(u32::from(backup.skill_point_cap));
            }
        }
        w.write_u32(
            u32::try_from(self.runtime.durable.player_corpses.len())
                .expect("corpse count fits u32"),
        );
        for corpse in self.runtime.durable.player_corpses.values() {
            write_string(w, &corpse.id);
            write_string(w, &corpse.owner_actor_id);
            write_string(w, &corpse.owner_label);
            write_string(w, &corpse.area_id);
            w.write_i64(i64::from(corpse.cell.x))
                .write_i64(i64::from(corpse.cell.y))
                .write_i64(i64::from(corpse.position.x))
                .write_i64(i64::from(corpse.position.y))
                .write_tick(corpse.created_tick)
                .write_tick(corpse.expiry_tick)
                .write_u64(corpse.credits);
            write_string(w, &corpse.container);
        }
        w.write_u64(self.runtime.durable.next_player_corpse_id);
    }

    /// The placement-validated camp footprint was added to v1 checkpoints as a
    /// compatible optional extension. Emit nothing when every camp is legacy so
    /// its pre-extension state hash still verifies during import.
    fn write_camp_shelter_footprints_stable_hash(&self, w: &mut StateWriter) {
        let footprints = self
            .runtime
            .durable
            .placed_camps
            .values()
            .filter_map(|camp| {
                camp.shelter_half_extent_milli_cells
                    .map(|half_extent| (&camp.camp_id, half_extent))
            })
            .collect::<Vec<_>>();
        if footprints.is_empty() {
            return;
        }
        write_string(w, "camp-shelter-footprints.v1");
        w.write_u32(u32::try_from(footprints.len()).expect("camp footprint count fits u32"));
        for (camp_id, half_extent) in footprints {
            write_string(w, camp_id);
            w.write_i64(i64::from(half_extent));
        }
    }

    /// Trade session state contributes to the stable hash ONLY when non-empty, so a
    /// world that has never opened a trade hashes byte-identically to the pre-trade era
    /// (the groups precedent). A live session hashes offers, coins, both accept-locks,
    /// both confirms, and any terminal close marker — the full double-lock state.
    fn write_trade_sessions_stable_hash(&self, w: &mut StateWriter) {
        if self.runtime.durable.trade_proposals.is_empty() {
            return;
        }
        w.write_u32(
            u32::try_from(self.runtime.durable.trade_proposals.len())
                .expect("trade proposal count fits u32"),
        );
        for (id, proposal) in &self.runtime.durable.trade_proposals {
            w.write_u32(*id);
            write_string(w, &proposal.proposer);
            write_string(w, &proposal.partner);
            write_trade_item_specs(w, &proposal.offer);
            write_trade_item_specs(w, &proposal.request);
            w.write_u64(proposal.proposer_coin)
                .write_u64(proposal.partner_coin)
                .write_bool(proposal.proposer_locked)
                .write_bool(proposal.partner_locked)
                .write_bool(proposal.proposer_confirmed)
                .write_bool(proposal.partner_confirmed)
                .write_bool(proposal.closed.is_some());
            if let Some(close) = proposal.closed {
                w.write_bool(close.executed)
                    .write_u32(close.reason.map_or(0, TradeCloseReason::code))
                    .write_tick(close.at_tick);
            }
        }
        w.write_u32(self.runtime.durable.next_trade_proposal_id);
    }

    pub(super) fn delta_bundle(
        &self,
        config: &SliceAuthorityConfig,
        baseline_tick: u64,
        previous_state_hash: &str,
        target_state_hash: &str,
        combat_events: &[AuthorityCombatEventSnapshot],
    ) -> SnapshotDeltaBundle {
        let actors = AuthorityDeltaPayload::from_state_for_observer(self, config);
        let combat_events = AuthorityCombatEventDeltaPayload {
            schema: "successor.authority-combat-events.v1".to_owned(),
            tick: self.runtime.durable.tick,
            events: self.combat_events_for(config, combat_events),
        };
        let inventory = AuthorityInventoryDeltaPayload {
            schema: "successor.authority-inventory.v1".to_owned(),
            tick: self.runtime.durable.tick,
            inventory: self.inventory_snapshots(),
            reservations: self.reservation_snapshots(),
        };
        let npc_jobs = AuthorityNpcJobsDeltaPayload {
            schema: "successor.authority-npc-jobs.v1".to_owned(),
            tick: self.runtime.durable.tick,
            npc_jobs: self.npc_job_snapshots(),
        };
        let timeline_events = AuthorityTimelineEventsDeltaPayload {
            schema: "successor.authority-timeline-events.v1".to_owned(),
            tick: self.runtime.durable.tick,
            events: self.timeline_event_snapshots(),
        };
        SnapshotDeltaBundle {
            baseline_tick,
            target_tick: self.runtime.durable.tick,
            previous_state_hash: previous_state_hash.to_owned(),
            target_state_hash: target_state_hash.to_owned(),
            sections: vec![
                payload_section("authority.actors", AUTHORITY_PAYLOAD_SCHEMA, &actors),
                payload_section(
                    "authority.combatEvents",
                    AUTHORITY_COMBAT_EVENT_SCHEMA,
                    &combat_events,
                ),
                payload_section(
                    "authority.inventory",
                    AUTHORITY_INVENTORY_SCHEMA,
                    &inventory,
                ),
                payload_section(
                    "authority.bank",
                    AUTHORITY_BANK_SCHEMA,
                    &AuthorityBankDeltaPayload {
                        schema: "successor.authority-bank.v1".to_owned(),
                        tick: self.runtime.durable.tick,
                        bank: self.bank_snapshot_for_observer(config),
                    },
                ),
                payload_section(
                    "authority.corpses",
                    AUTHORITY_CORPSES_SCHEMA,
                    &AuthorityPlayerCorpsesDeltaPayload {
                        schema: "successor.authority-corpses.v1".to_owned(),
                        tick: self.runtime.durable.tick,
                        corpses: self.corpse_snapshots_for_observer(config),
                    },
                ),
                payload_section("authority.npcJobs", AUTHORITY_NPC_JOBS_SCHEMA, &npc_jobs),
                payload_section(
                    "authority.placedExtractors",
                    AUTHORITY_PLACED_EXTRACTORS_SCHEMA,
                    &AuthorityPlacedExtractorsDeltaPayload {
                        schema: "successor.authority-placed-extractors.v1".to_owned(),
                        tick: self.runtime.durable.tick,
                        placed_extractors: self.placed_extractor_snapshots_for_observer(config),
                    },
                ),
                payload_section(
                    "authority.placedCamps",
                    AUTHORITY_PLACED_CAMPS_SCHEMA,
                    &AuthorityPlacedCampsDeltaPayload {
                        schema: "successor.authority-placed-camps.v1".to_owned(),
                        tick: self.runtime.durable.tick,
                        placed_camps: self.placed_camp_snapshots_for_observer(config),
                    },
                ),
                payload_section(
                    "authority.parcels",
                    AUTHORITY_PARCELS_SCHEMA,
                    &AuthorityParcelsDeltaPayload {
                        schema: "successor.authority-parcels.v1".to_owned(),
                        tick: self.runtime.durable.tick,
                        parcels: self.parcel_snapshots_for_observer(config),
                    },
                ),
                payload_section(
                    "authority.building",
                    AUTHORITY_BUILDING_SCHEMA,
                    &self.build_delta_for_observer(config),
                ),
                payload_section(
                    "authority.farmPlot",
                    AUTHORITY_FARM_PLOT_SCHEMA,
                    &AuthorityFarmPlotDeltaPayload {
                        schema: "successor.authority-farm-plot.v1".to_owned(),
                        tick: self.runtime.durable.tick,
                        farm_plot: self.farm_plot_snapshot_for_observer(config),
                    },
                ),
                payload_section(
                    "authority.craftSession",
                    AUTHORITY_CRAFT_SESSION_SCHEMA,
                    &AuthorityCraftSessionDeltaPayload {
                        schema: "successor.authority-craft-session.v1".to_owned(),
                        tick: self.runtime.durable.tick,
                        craft_session: self.craft_session_snapshot_for_observer(config),
                    },
                ),
                payload_section(
                    "authority.guilds",
                    AUTHORITY_GUILDS_SCHEMA,
                    &AuthorityGuildsDeltaPayload {
                        schema: "successor.authority-guilds.v1".to_owned(),
                        tick: self.runtime.durable.tick,
                        guilds: self.guild_view_for_observer(config),
                    },
                ),
                payload_section(
                    "authority.draftedSchematics",
                    AUTHORITY_DRAFTED_SCHEMATICS_SCHEMA,
                    &AuthorityDraftedSchematicsDeltaPayload {
                        schema: "successor.authority-drafted-schematics.v1".to_owned(),
                        tick: self.runtime.durable.tick,
                        drafted_schematics: self.drafted_schematic_snapshots_for_observer(config),
                    },
                ),
                payload_section(
                    "authority.timelineEvents",
                    AUTHORITY_TIMELINE_EVENTS_SCHEMA,
                    &timeline_events,
                ),
                payload_section(
                    "authority.groups",
                    AUTHORITY_GROUPS_SCHEMA,
                    &AuthorityGroupsDeltaPayload {
                        schema: "successor.authority-groups.v1".to_owned(),
                        tick: self.runtime.durable.tick,
                        view: self.group_view_for_observer(config),
                    },
                ),
            ],
        }
    }

    pub(super) fn observer_actor(
        &self,
        config: &SliceAuthorityConfig,
    ) -> Option<&ActorAuthorityState> {
        self.runtime.durable.actors.get(&config.player_actor_id)
    }

    pub(super) fn actor_snapshots_for(
        &self,
        config: &SliceAuthorityConfig,
    ) -> Vec<AuthorityActorSnapshot> {
        let Some(observer) = self.observer_actor(config) else {
            return self
                .runtime
                .durable
                .actors
                .values()
                .map(|actor| self.actor_snapshot_from_actor(actor))
                .collect();
        };
        self.runtime
            .durable
            .actors
            .values()
            .filter(|actor| {
                self.actor_in_interest(observer, actor, config.area_interest_radius_cells)
            })
            .map(|actor| self.actor_snapshot_from_actor(actor))
            .collect()
    }

    fn actor_snapshot_from_actor(&self, actor: &ActorAuthorityState) -> AuthorityActorSnapshot {
        AuthorityActorSnapshot::from_actor_with_loot(
            actor,
            self.runtime.durable.tick,
            self.runtime.durable.world.tick_rate_hz,
            self.corpse_has_loot(&actor.id),
        )
    }

    pub(super) fn combat_events_for(
        &self,
        config: &SliceAuthorityConfig,
        combat_events: &[AuthorityCombatEventSnapshot],
    ) -> Vec<AuthorityCombatEventSnapshot> {
        let Some(observer) = self.observer_actor(config) else {
            return combat_events.to_vec();
        };
        combat_events
            .iter()
            .filter(|event| {
                event.shooter_actor_id == observer.id
                    || event.target_actor_id == observer.id
                    || distance_sq(
                        AuthorityCell::new(event.hit_x.floor() as i32, event.hit_y.floor() as i32),
                        observer.cell,
                    ) <= interest_radius_sq(config.area_interest_radius_cells)
            })
            .cloned()
            .collect()
    }

    pub(super) fn actor_in_interest(
        &self,
        observer: &ActorAuthorityState,
        actor: &ActorAuthorityState,
        radius_cells: i32,
    ) -> bool {
        actor.id == observer.id
            || (actor.area_id == observer.area_id
                && distance_sq(actor.cell, observer.cell) <= interest_radius_sq(radius_cells))
    }
}

fn write_trade_item_specs(w: &mut StateWriter, items: &[TradeItemSpec]) {
    w.write_u32(u32::try_from(items.len()).expect("trade item count fits u32"));
    for item in items {
        w.write_u32(item.item_id)
            .write_u32(item.variant_id)
            .write_u32(item.quantity);
    }
}

fn write_resource_locks(w: &mut StateWriter, locks: &[CraftResourceLock]) {
    w.write_u32(u32::try_from(locks.len()).expect("craft lock count fits u32"));
    for lock in locks {
        w.write_u32(lock.item_id)
            .write_u32(lock.variant_id)
            .write_u32(lock.quantity);
    }
}

fn write_splice_session_state(w: &mut StateWriter, session: &SpliceSessionState) {
    w.write_u32(session.phase.code())
        .write_u32(session.species_id);
    w.write_u32(u32::try_from(session.slots.len()).expect("splice slot count fits u32"));
    for slot in &session.slots {
        match slot {
            Some(slot) => {
                w.write_bool(true).write_u32(u32::from(slot.slot_index));
                write_string(w, &slot.container);
                w.write_u64(slot.stack_id)
                    .write_u32(slot.item_id)
                    .write_u32(slot.variant_id);
            }
            None => {
                w.write_bool(false);
            }
        }
    }
    w.write_u32(u32::try_from(session.allele_choices.len()).expect("allele choice count fits u32"));
    for (locus, (pick_a, pick_b)) in &session.allele_choices {
        // 0xFF sentinel = "no explicit pick" (default elite selection).
        w.write_u32(u32::from(*locus))
            .write_u32(pick_a.map_or(0xFF, u32::from))
            .write_u32(pick_b.map_or(0xFF, u32::from));
    }
    w.write_u32(u32::from(session.assembly_quality_milli))
        .write_u32(u32::from(session.points_total))
        .write_u32(u32::from(session.points_remaining))
        .write_u32(u32::from(session.gain_per_point));
    w.write_u32(u32::try_from(session.child_alleles.len()).expect("child allele count fits u32"));
    for locus in &session.child_alleles {
        w.write_u32(u32::from(locus.a1))
            .write_u32(u32::from(locus.a2));
    }
    w.write_u32(u32::try_from(session.lines.len()).expect("splice line count fits u32"));
    for line in &session.lines {
        w.write_u32(u32::from(line.locus));
        write_string(w, &line.label);
        w.write_u32(u32::from(line.base_milli))
            .write_u32(u32::from(line.value_milli))
            .write_u32(u32::from(line.cap_milli));
    }
    w.write_u32(session.parent_handles[0])
        .write_u32(session.parent_handles[1])
        .write_u32(u32::from(session.child_generation));
}

fn write_craft_session_state(w: &mut StateWriter, session: Option<&CraftSessionState>) {
    w.write_bool(session.is_some());
    let Some(session) = session else {
        return;
    };
    write_string(w, &session.recipe_id);
    w.write_u32(session.phase.code())
        .write_u32(u32::try_from(session.slots.len()).expect("craft slot count fits u32"));
    for slot in &session.slots {
        w.write_bool(slot.is_some());
        if let Some(slot) = slot {
            w.write_u32(u32::from(slot.slot_index));
            write_string(w, &slot.container);
            w.write_u64(slot.stack_id)
                .write_u32(slot.item_id)
                .write_u32(slot.variant_id)
                .write_u32(slot.quantity);
            write_resource_stats(w, slot.stats);
        }
    }
    write_resource_locks(w, &session.resource_locks);
    w.write_u32(session.assembly_seed)
        .write_u32(u32::from(session.assembly_quality_milli))
        .write_u32(u32::from(session.experimentation_points_remaining))
        .write_u32(u32::try_from(session.lines.len()).expect("craft line count fits u32"));
    for line in &session.lines {
        w.write_u32(u32::from(line.line_id));
        write_string(w, &line.label);
        w.write_u32(u32::from(line.value_milli))
            .write_u32(u32::from(line.cap_milli));
    }
    w.write_bool(session.limited_schematic.is_some());
    if let Some(limited) = session.limited_schematic.as_ref() {
        write_string(w, &limited.container);
        w.write_u64(limited.stack_id)
            .write_u32(limited.variant_id)
            .write_u32(u32::from(limited.remaining_uses));
    }
}

fn write_resource_stats(w: &mut StateWriter, stats: ResourceStats) {
    w.write_u32(u32::from(stats.conductivity))
        .write_u32(u32::from(stats.malleability))
        .write_u32(u32::from(stats.shock_resistance))
        .write_u32(u32::from(stats.thermal_resistance))
        .write_u32(u32::from(stats.chemical_purity))
        .write_u32(u32::from(stats.density))
        .write_u32(u32::from(stats.tensile_strength))
        .write_u32(u32::from(stats.flexibility))
        .write_u32(u32::from(stats.potency))
        .write_u32(u32::from(stats.nutrition))
        .write_u32(u32::from(stats.stability))
        .write_u32(u32::from(stats.extraction_yield));
}

#[cfg(test)]
mod checkpoint_tests {
    use super::*;
    use crate::{CollisionBoundsSnapshot, DoorSnapshot};

    fn door_prop(id: &str, cell: CellSnapshot) -> PropSnapshot {
        PropSnapshot {
            id: id.to_owned(),
            entity: format!("checkpoint:{id}"),
            area_id: crate::AUTHORITY_TEST_AREA_ID.to_owned(),
            label: id.to_owned(),
            kind: "facility".to_owned(),
            cell,
            size: CellSizeSnapshot { w: 1, h: 1 },
            interactive: true,
            cover: None,
            collision_bounds: vec![CollisionBoundsSnapshot {
                x_milli: 0,
                y_milli: 0,
                w_milli: 1_000,
                h_milli: 1_000,
            }],
            door: Some(DoorSnapshot {
                blocker: CollisionBoundsSnapshot {
                    x_milli: 0,
                    y_milli: 0,
                    w_milli: 500,
                    h_milli: 250,
                },
            }),
            container: None,
        }
    }

    #[test]
    fn checkpoint_restores_durable_progress_into_current_authored_world() {
        let mut source_snapshot = crate::authority_test_slice();
        source_snapshot
            .props
            .push(door_prop("checkpoint-door", CellSnapshot::new(25, 25)));
        let mut source = SliceAuthorityState::from_snapshot(&source_snapshot).unwrap();
        source.tick = 98_765;
        source.hits = 19;
        source.deaths = 4;
        source
            .actors
            .get_mut("player")
            .expect("fixture player")
            .display_name = "Durable Player".to_owned();
        source.inventory.push(InventoryStackSnapshot {
            stack_id: 900_001,
            container: "player:field-pack".to_owned(),
            item: "Checkpoint Keepsake".to_owned(),
            item_id: 990_001,
            variant_id: 77,
            quantity: 11,
            reserved: 3,
            available: 8,
        });
        source
            .door_collision_bounds
            .iter_mut()
            .find(|door| door.prop_id == "checkpoint-door")
            .expect("source door")
            .open = true;
        source
            .runtime
            .current_removed_actor_ids
            .push("transient-only".to_owned());

        let source_door_left = source
            .door_collision_bounds
            .iter()
            .find(|door| door.prop_id == "checkpoint-door")
            .expect("source door")
            .left;
        let blob = source.export_checkpoint();
        let source_state_hash = blob.state_hash().to_owned();
        assert_eq!(blob.schema(), AUTHORITY_CHECKPOINT_SCHEMA);
        assert_eq!(blob.version(), AUTHORITY_CHECKPOINT_VERSION);
        assert!(!blob.payload_hash().is_empty());

        let encoded = serde_json::to_value(&blob).expect("checkpoint serializes");
        assert!(encoded.pointer("/state/areas").is_none());
        assert!(encoded.pointer("/state/terminals").is_none());
        assert!(encoded.pointer("/state/tickRateHz").is_none());
        assert!(encoded.pointer("/state/doorCollisionBounds").is_none());
        assert!(encoded.pointer("/state/pendingCombatEvents").is_none());

        let mut current_snapshot = source_snapshot.clone();
        let checkpoint_door = current_snapshot
            .props
            .iter_mut()
            .find(|prop| prop.id == "checkpoint-door")
            .expect("current door");
        checkpoint_door.cell = CellSnapshot::new(31, 29);
        let mut restored = SliceAuthorityState::from_snapshot(&current_snapshot).unwrap();
        let current_door_left = restored
            .door_collision_bounds
            .iter()
            .find(|door| door.prop_id == "checkpoint-door")
            .expect("current door")
            .left;
        assert_ne!(current_door_left, source_door_left);

        restored
            .restore_checkpoint(blob)
            .expect("current checkpoint restores");

        assert_eq!(restored.tick, 98_765);
        assert_eq!(restored.hits, 19);
        assert_eq!(restored.deaths, 4);
        assert_eq!(restored.actors["player"].display_name, "Durable Player");
        assert!(restored
            .inventory
            .iter()
            .any(|row| row.item == "Checkpoint Keepsake"));
        let restored_door = restored
            .door_collision_bounds
            .iter()
            .find(|door| door.prop_id == "checkpoint-door")
            .expect("restored current door");
        assert!(restored_door.open);
        assert_eq!(restored_door.left, current_door_left);
        assert!(restored.runtime.current_removed_actor_ids.is_empty());
        assert!(restored.runtime.pending_combat_events.is_empty());
        assert!(restored.runtime.pending_ability_queue_events.is_empty());
        assert_ne!(
            restored.stable_state_hash_hex(),
            source_state_hash,
            "current authored geometry changes the live hash without invalidating durable progress"
        );
    }

    #[test]
    fn checkpoint_payload_tamper_is_rejected_without_mutating_live_state() {
        let source = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
        let mut blob = source.export_checkpoint();
        blob.state.tick = blob.state.tick.saturating_add(1);

        let mut target =
            SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
        let before = target.stable_state_hash_hex();
        assert!(matches!(
            target.restore_checkpoint(blob),
            Err(AuthorityCheckpointError::PayloadHashMismatch { .. })
        ));
        assert_eq!(target.stable_state_hash_hex(), before);
    }

    #[test]
    fn checkpoint_rejects_old_schema_and_unknown_version() {
        let source = SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();

        let mut old_schema = source.export_checkpoint();
        old_schema.schema = "authority.state-export.v1".to_owned();
        let mut target =
            SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
        assert!(matches!(
            target.restore_checkpoint(old_schema),
            Err(AuthorityCheckpointError::UnsupportedSchema { .. })
        ));

        let mut unknown_version = source.export_checkpoint();
        unknown_version.version = AUTHORITY_CHECKPOINT_VERSION + 1;
        assert!(matches!(
            target.restore_checkpoint(unknown_version),
            Err(AuthorityCheckpointError::UnsupportedVersion { .. })
        ));
    }

    #[test]
    fn checkpoint_roundtrip_preserves_current_live_hash() {
        let mut source =
            SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
        source.tick = 321;
        source.bank_accounts.get_mut("player").unwrap().bank_credits = 777;
        let expected_hash = source.stable_state_hash_hex();
        let blob = source.export_checkpoint();

        let mut restored =
            SliceAuthorityState::from_snapshot(&crate::authority_test_slice()).unwrap();
        restored
            .restore_checkpoint(blob)
            .expect("same authored world restores exactly");
        assert_eq!(restored.stable_state_hash_hex(), expected_hash);
    }
}
