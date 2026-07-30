use super::*;

const AUTHORITY_TIMELINE_EVENT_CAPACITY: usize = 256;
const LEGACY_INVENTORY_CURRENCY_ITEM_ID: u32 = 9_001;

fn retain_recent_timeline_events(events: &mut Vec<TimelineEventSnapshot>) {
    let excess = events
        .len()
        .saturating_sub(AUTHORITY_TIMELINE_EVENT_CAPACITY);
    if excess > 0 {
        events.drain(..excess);
    }
}

pub(super) fn migrate_legacy_currency_inventory(
    actors: &mut BTreeMap<String, ActorAuthorityState>,
    inventory: &mut Vec<InventoryStackSnapshot>,
) {
    inventory.retain_mut(|row| {
        if row.item_id != LEGACY_INVENTORY_CURRENCY_ITEM_ID {
            return true;
        }
        if let Some(actor) = actors
            .values_mut()
            .find(|actor| actor_owns_inventory_container(&actor.id, &row.container))
        {
            actor.professions.add_credits(u64::from(row.quantity));
            return false;
        }

        // Currency found outside a character-owned container remains a
        // physical, lootable voucher rather than disappearing.
        row.item = "Credit Chip".to_owned();
        row.item_id = CREDIT_CHIP_ITEM_ID;
        row.variant_id = 0;
        true
    });
}

pub(super) fn migrate_legacy_currency_trade_proposals(
    proposals: &mut BTreeMap<u32, TradeProposal>,
) {
    for proposal in proposals.values_mut() {
        let proposer_credits = proposal
            .offer
            .iter()
            .filter(|line| line.item_id == LEGACY_INVENTORY_CURRENCY_ITEM_ID)
            .map(|line| u64::from(line.quantity))
            .sum::<u64>();
        let partner_credits = proposal
            .request
            .iter()
            .filter(|line| line.item_id == LEGACY_INVENTORY_CURRENCY_ITEM_ID)
            .map(|line| u64::from(line.quantity))
            .sum::<u64>();
        if proposer_credits == 0 && partner_credits == 0 {
            continue;
        }
        proposal.proposer_coin = proposal.proposer_coin.saturating_add(proposer_credits);
        proposal.partner_coin = proposal.partner_coin.saturating_add(partner_credits);
        proposal
            .offer
            .retain(|line| line.item_id != LEGACY_INVENTORY_CURRENCY_ITEM_ID);
        proposal
            .request
            .retain(|line| line.item_id != LEGACY_INVENTORY_CURRENCY_ITEM_ID);
        proposal.clear_locks();
    }
}

impl SliceAuthorityState {
    pub fn from_snapshot(snapshot: &SliceSnapshot) -> Result<Self, SliceAuthorityBuildError> {
        let combat_model = CombatModel::from_slice_value(snapshot.combat_model.as_deref())?;
        let weapon_range_bands = build_combat_weapon_range_bands(snapshot)?;
        let mut areas = BTreeMap::new();
        for area in &snapshot.areas {
            if areas
                .insert(area.id.clone(), AreaAuthorityState::from_area(area))
                .is_some()
            {
                return Err(SliceAuthorityBuildError::DuplicateArea(area.id.clone()));
            }
        }

        let factions = FactionTable::from_snapshots(&snapshot.factions);
        let player_organizations = player_organizations_from_snapshot(snapshot)?;

        let mut actors = BTreeMap::new();
        let job_actor_ids = snapshot
            .npc_jobs
            .iter()
            .map(|job| job.actor.as_str())
            .collect::<BTreeSet<_>>();
        for actor in &snapshot.actors {
            let cell = AuthorityCell::from_snapshot(&actor.cell, "actor.cell")?;
            if !areas.contains_key(&actor.area_id) {
                return Err(SliceAuthorityBuildError::UnknownActorArea {
                    actor_id: actor.id.clone(),
                    area_id: actor.area_id.clone(),
                });
            }
            let route = route_cells_from_snapshot(&actor.route)?;
            let route_index = route_index_after_cell(&route, cell);
            let initial_route_tick_delay =
                if route.len() >= 2 && !job_actor_ids.contains(actor.id.as_str()) {
                    ROUTE_PATROL_UPDATE_CADENCE_TICKS
                } else {
                    NPC_ROUTE_STEP_INTERVAL_TICKS
                };
            let scale = actor.scale.unwrap_or(1).clamp(1, 6);
            let effective_stats = derive_effective_actor_stats_for_role(&actor.role);
            let max_vitals = actor.max_vitals.or(actor.vitals).map_or_else(
                || effective_stats.max_vitals,
                authority_vitals_from_actor_snapshot,
            );
            let vitals = actor.vitals.map_or(
                effective_stats.spawn_vitals.clamp_to_max(max_vitals),
                authority_vitals_from_actor_snapshot,
            );
            let initial_respawn_delay_ticks = actor
                .initial_respawn_delay_ms
                .map(|delay_ms| ms_to_ticks_round(delay_ms, snapshot.tick_rate_hz))
                .unwrap_or(0);
            let initial_life_state = if initial_respawn_delay_ticks > 0 {
                AuthorityLifeState::Respawning
            } else {
                AuthorityLifeState::Alive
            };
            let mut professions = ActorProfessionState::from_profession_ids(&actor.profession_ids)
                .map_err(
                    |profession_id| SliceAuthorityBuildError::UnknownActorProfessionId {
                        actor_id: actor.id.clone(),
                        profession_id,
                    },
                )?;
            professions.set_credits(actor.credits);
            professions
                .grant_skill_box_ids(&actor.skill_box_ids)
                .map_err(
                    |profession_id| SliceAuthorityBuildError::UnknownActorProfessionId {
                        actor_id: actor.id.clone(),
                        profession_id,
                    },
                )?;
            let capabilities = ActorCapabilityState::from_professions_and_grants(
                &professions,
                &actor.capabilities,
            );
            let career_goal_id = parse_authority_career_goal_id(actor.career_goal_id.as_deref())
                .map_err(
                    |career_goal_id| SliceAuthorityBuildError::UnknownActorCareerGoalId {
                        actor_id: actor.id.clone(),
                        career_goal_id,
                    },
                )?;
            let mut state = ActorAuthorityState {
                id: actor.id.clone(),
                entity: actor.entity.clone(),
                label: actor.label.clone(),
                display_name: actor.label.clone(),
                descriptor: String::new(),
                link_dead: false,
                link_dead_expires_tick: 0,
                appearance: AuthorityActorAppearanceSnapshot::default(),
                worn: Vec::new(),
                equipped_clothing: Vec::new(),
                worn_colors: BTreeMap::new(),
                sprite: actor.sprite.clone(),
                template_id: actor.template_id.clone(),
                spawn_zone_id: None,
                role: actor.role.clone(),
                faction: ActorFactionState::from_actor_snapshot(actor),
                player_organization_id: normalize_player_organization_key(
                    actor.player_organization_id.as_deref(),
                ),
                player_organization_tag: normalize_player_organization_tag(
                    actor.player_organization_tag.as_deref(),
                ),
                area_id: actor.area_id.clone(),
                cell,
                position: AuthorityPosition::from_cell(cell),
                direction: actor.direction.clone(),
                scale,
                home_area_id: actor.area_id.clone(),
                home_cell: cell,
                home_direction: actor.direction.clone(),
                home_route: route.clone(),
                life_state: initial_life_state,
                lifecycle_seq: 1,
                posture: AuthorityActorPosture::Standing,
                posture_until_tick: 0,
                vitals,
                max_vitals,
                effective_stats,
                professions,
                capabilities,
                capability_grants: actor.capabilities.clone(),
                career_goal_id,
                passive_regen_milli: AuthorityVitals::zero(),
                weather_damage_accumulated_milli: 0,
                bleed_stacks: Vec::new(),
                consumable_effects: Vec::new(),
                service_buffs: Vec::new(),
                personal_shield: None,
                sprint_action_drain_milli: 0,
                sprint_recovery_locked: false,
                sprint_recovery_regen_carry: 0,
                sprint_regen_block_until_tick: 0,
                mobility: ActorMobilityTelemetry::default(),
                downed_action_drain_milli: 0,
                downed_spirit_drain_milli: 0,
                incap_expires_tick: 0,
                incap_count: 0,
                incap_window_start_tick: 0,
                incap_grace_until_tick: 0,
                sleep: SleepAuthorityState::default(),
                suppression: SuppressionAuthorityState::default(),
                ai: ai_for_actor(&actor.id, &actor.role),
                next_fire_tick: 0,
                weapon_recoil_heat_milli: 0,
                weapon_recoil_last_tick: snapshot.tick,
                equipped_weapon_id: default_equipped_weapon_id_for_role_and_professions(
                    &actor.role,
                    &actor.profession_ids,
                ),
                equipped_weapon_item_id: 0,
                equipped_weapon_variant_id: 0,
                slugthrower_magazine: slugthrower_full_magazine_state(),
                combat_queue: AbilityQueue::default(),
                combat_until_tick: 0,
                engagement_target_id: None,
                peace_requested: false,
                next_move_tick: 0,
                move_intent: None,
                next_economy_action_tick: 0,
                next_resource_survey_tick: 0,
                pending_resource_sample: None,
                resource_sample_loop: None,
                cranking_extractor_id: None,
                craft_session: None,
                known_recipe_ids: BTreeSet::new(),
                splice_session: None,
                scanned_genomes: BTreeSet::new(),
                next_starter_tool_request_tick: 0,
                shots_fired: 0,
                last_shot_tick: None,
                last_moved_tick: None,
                stats: ActorAuthorityStats::default(),
                route,
                route_index,
                next_route_tick: snapshot.tick.saturating_add(initial_route_tick_delay),
                player_damage_ledger: Vec::new(),
                loot_rights_actor_id: None,
                gaia_harvest_entitled_actor_ids: BTreeSet::new(),
                gaia_harvest_claimed_actor_ids: BTreeSet::new(),
                body_vanish_tick: 0,
                respawn_tick: if initial_respawn_delay_ticks > 0 {
                    snapshot.tick.saturating_add(initial_respawn_delay_ticks)
                } else {
                    0
                },
                corpse_exhausted_tick: None,
                creature_corpse_harvested_tick: None,
                clone_sickness_ticks: 0,
                respawn_return: Vec::new(),
            };
            refresh_actor_presentation(&mut state, snapshot.tick);
            if actors.insert(actor.id.clone(), state).is_some() {
                return Err(SliceAuthorityBuildError::DuplicateActor(actor.id.clone()));
            }
        }

        let mut transitions = BTreeMap::new();
        for transition in &snapshot.transitions {
            let from_area = areas.get(&transition.from_area_id).ok_or_else(|| {
                SliceAuthorityBuildError::UnknownTransitionArea {
                    transition_id: transition.id.clone(),
                    area_id: transition.from_area_id.clone(),
                }
            })?;
            let to_area = areas.get(&transition.to_area_id).ok_or_else(|| {
                SliceAuthorityBuildError::UnknownTransitionArea {
                    transition_id: transition.id.clone(),
                    area_id: transition.to_area_id.clone(),
                }
            })?;
            let state = TransitionAuthorityState::from_snapshot(transition)?;
            if !from_area.contains(state.from_cell) {
                return Err(SliceAuthorityBuildError::TransitionOutOfBounds {
                    transition_id: transition.id.clone(),
                    area_id: transition.from_area_id.clone(),
                    x: state.from_cell.x,
                    y: state.from_cell.y,
                });
            }
            if !to_area.contains(state.to_cell) {
                return Err(SliceAuthorityBuildError::TransitionOutOfBounds {
                    transition_id: transition.id.clone(),
                    area_id: transition.to_area_id.clone(),
                    x: state.to_cell.x,
                    y: state.to_cell.y,
                });
            }
            if transitions.insert(transition.id.clone(), state).is_some() {
                return Err(SliceAuthorityBuildError::DuplicateTransition(
                    transition.id.clone(),
                ));
            }
        }

        let mut clone_facilities = Vec::new();
        for facility in &snapshot.clone_facilities {
            let respawn_cell =
                AuthorityCell::from_snapshot(&facility.respawn_cell, "cloneFacility.respawnCell")?;
            let area = areas.get(&facility.area_id).ok_or_else(|| {
                SliceAuthorityBuildError::UnknownCloneFacilityArea {
                    facility_id: facility.id.clone(),
                    area_id: facility.area_id.clone(),
                }
            })?;
            if !area.contains(respawn_cell) {
                return Err(SliceAuthorityBuildError::CloneFacilityOutOfBounds {
                    facility_id: facility.id.clone(),
                    area_id: facility.area_id.clone(),
                    x: respawn_cell.x,
                    y: respawn_cell.y,
                });
            }
            clone_facilities.push(CloneFacilityAuthorityState::from_snapshot(
                facility,
                respawn_cell,
                snapshot.tick_rate_hz,
            ));
        }

        let mut blocked_cells = BTreeSet::new();
        for cell in &snapshot.blocked_cells {
            if !areas.contains_key(&cell.area_id) {
                return Err(SliceAuthorityBuildError::UnknownBlockedCellArea {
                    area_id: cell.area_id.clone(),
                });
            }
            blocked_cells.insert(CellKey::new(&cell.area_id, cell.x, cell.y));
        }
        for transition in transitions.values() {
            if blocked_cells.contains(&CellKey::new(
                &transition.to_area_id,
                transition.to_cell.x,
                transition.to_cell.y,
            )) {
                return Err(SliceAuthorityBuildError::TransitionDestinationBlocked {
                    transition_id: transition.id.clone(),
                    area_id: transition.to_area_id.clone(),
                    x: transition.to_cell.x,
                    y: transition.to_cell.y,
                });
            }
        }

        let fine_collision_bounds = build_fine_collision_bounds(&snapshot.props, &areas)?;
        let door_collision_bounds = build_door_collision_bounds(&snapshot.props, &areas)?;
        let ai_clearance_blocked_cells =
            build_ai_clearance_blocked_cells(&areas, &blocked_cells, &fine_collision_bounds);
        let door_clearance_blocked_cells_by_prop =
            build_door_clearance_blocked_cells_by_prop(&areas, &door_collision_bounds);
        let cover_points = build_cover_points(
            &snapshot.props,
            &areas,
            &blocked_cells,
            &fine_collision_bounds,
        )?;
        let ammo_stockpiles = build_ammo_stockpiles(&snapshot.props, &areas)?;
        let exchange_containers = build_exchange_containers(&snapshot.props, &areas)?;
        let terminals = banking::terminals_from_props(&snapshot.props);
        let loot_caches = build_loot_caches(&snapshot.props, &areas)?;

        let population = PopulationAuthorityState::from_snapshot(snapshot, &areas)?;
        let mut inventory = snapshot.inventory.clone();
        migrate_legacy_currency_inventory(&mut actors, &mut inventory);
        let inventory_stack_counters = normalize_inventory_stack_ids(&mut inventory);

        // Central no-claim zones (§B LAND WAVE) — snap each config square OUTWARD to
        // whole lattice cells so no sub-quantum sliver ever borders a zone. Unknown
        // area => build error (catches config typos). POI/road buffers are derived on
        // demand (land.rs), never stored, so ALL exclusion has one source of truth.
        let mut no_claim_zones = Vec::with_capacity(snapshot.no_claim_zones.len());
        for zone in &snapshot.no_claim_zones {
            if !areas.contains_key(&zone.area_id) {
                return Err(SliceAuthorityBuildError::UnknownNoClaimZoneArea {
                    area_id: zone.area_id.clone(),
                });
            }
            let half = i32::try_from(zone.half_extent_cells).unwrap_or(i32::MAX);
            let raw = AuthorityRect::new(
                zone.center_x.saturating_sub(half),
                zone.center_y.saturating_sub(half),
                zone.half_extent_cells.saturating_mul(2),
                zone.half_extent_cells.saturating_mul(2),
            );
            no_claim_zones.push(NoClaimZoneAuthorityState {
                area_id: zone.area_id.clone(),
                rect: lattice_align_outward(&raw),
                label: zone.label.clone(),
            });
        }
        let mut state = Self {
            runtime: AuthorityRuntimeState {
                durable: DurableAuthorityState {
                    world: AuthoredWorldDefinition {
                        tick_rate_hz: snapshot.tick_rate_hz,
                        combat_model,
                        weapon_range_bands,
                        areas,
                        factions,
                        player_organizations,
                        transitions,
                        clone_facilities,
                        no_claim_zones,
                        blocked_cells,
                        ai_clearance_blocked_cells,
                        exchange_containers,
                        fine_collision_bounds,
                        cover_points,
                        ammo_stockpiles,
                        terminals,
                        farm_real_seconds_per_game_day: FARM_REAL_SECONDS_PER_GAME_DAY_PRODUCTION,
                    },
                    tick: snapshot.tick,
                    actors,
                    bark_claims: BarkClaims::default(),
                    population,
                    loot_caches,
                    door_collision_bounds,
                    seen_commands: BTreeSet::new(),
                    bank_accounts: BTreeMap::new(),
                    player_corpses: BTreeMap::new(),
                    next_player_corpse_id: 1,
                    inventory,
                    inventory_stack_counters,
                    reservations: snapshot.reservations.clone(),
                    npc_jobs: snapshot.npc_jobs.clone(),
                    timeline_events: snapshot.events.clone(),
                    placed_extractors: BTreeMap::new(),
                    next_extractor_id: 1,
                    placed_camps: BTreeMap::new(),
                    next_camp_id: 1,
                    crop_genomes: CropGenomeRegistry::new(),
                    parcels: BTreeMap::new(),
                    next_parcel_id: 1,
                    next_build_component_id: 1,
                    plot_tending: BTreeMap::new(),
                    drafted_schematics: BTreeMap::new(),
                    next_drafted_schematic_id: 1,
                    next_combat_event_id: 1,
                    combat_event_count: 0,
                    hits: 0,
                    deaths: 0,
                    trade_proposals: BTreeMap::new(),
                    guilds: BTreeMap::new(),
                    guild_invites: BTreeMap::new(),
                    next_guild_id: 1,
                    next_guild_invite_id: 1,
                    next_trade_proposal_id: 1,
                    groups: BTreeMap::new(),
                    group_invites: BTreeMap::new(),
                    next_group_id: 1,
                    duels: BTreeMap::new(),
                    duel_challenges: BTreeMap::new(),
                    next_duel_id: 1,
                },
                door_clearance_blocked_cells_by_prop,
                ai_debug: SliceAuthorityAiDebugSnapshot::empty(snapshot.tick),
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
            },
        };
        state.remove_unlimited_actor_ammo_inventory();
        state.seed_initial_population()?;
        for actor_id in state
            .actors
            .values()
            .filter(|a| is_human_player_actor(a))
            .map(|a| a.id.clone())
            .collect::<Vec<_>>()
        {
            state.ensure_initial_skill_backup(&actor_id);
        }
        state.ensure_npc_craftsman_field_tools_for_all();
        state.normalize_timeline_events();
        Ok(state)
    }

    pub(super) fn record_timeline_event(&mut self, event: TimelineEventSnapshot) {
        if self.runtime.durable.timeline_events.len() >= AUTHORITY_TIMELINE_EVENT_CAPACITY {
            let remove_count =
                self.runtime.durable.timeline_events.len() - AUTHORITY_TIMELINE_EVENT_CAPACITY + 1;
            self.runtime.durable.timeline_events.drain(..remove_count);
        }
        self.runtime.durable.timeline_events.push(event);
    }

    pub(super) fn normalize_timeline_events(&mut self) {
        retain_recent_timeline_events(&mut self.runtime.durable.timeline_events);
    }

    pub(crate) fn timeline_events(&self) -> &[TimelineEventSnapshot] {
        &self.runtime.durable.timeline_events
    }

    pub fn tick(&self) -> u64 {
        self.runtime.durable.tick
    }

    pub fn metrics(&self) -> SliceAuthorityMetrics {
        SliceAuthorityMetrics {
            tick: self.runtime.durable.tick,
            areas: self.runtime.durable.world.areas.len(),
            actors: self.runtime.durable.actors.len(),
            transitions: self.runtime.durable.world.transitions.len(),
            blocked_cells: self.runtime.durable.world.blocked_cells.len(),
            seen_commands: self.runtime.durable.seen_commands.len(),
            shots_fired: self
                .runtime
                .durable
                .actors
                .values()
                .map(|actor| actor.shots_fired)
                .sum(),
            combat_events: self.runtime.durable.combat_event_count,
            hits: self.runtime.durable.hits,
            deaths: self.runtime.durable.deaths,
            inventory_stacks: self.runtime.durable.inventory.len(),
            reservations: self.runtime.durable.reservations.len(),
            npc_jobs: self.runtime.durable.npc_jobs.len(),
            timeline_events: self.runtime.durable.timeline_events.len(),
            placed_extractors: self.runtime.durable.placed_extractors.len(),
            state_hash: self.stable_state_hash_hex(),
        }
    }

    pub fn live_metrics(&self) -> SliceAuthorityMetrics {
        SliceAuthorityMetrics {
            tick: self.runtime.durable.tick,
            areas: self.runtime.durable.world.areas.len(),
            actors: self.runtime.durable.actors.len(),
            transitions: self.runtime.durable.world.transitions.len(),
            blocked_cells: self.runtime.durable.world.blocked_cells.len(),
            seen_commands: self.runtime.durable.seen_commands.len(),
            shots_fired: self
                .runtime
                .durable
                .actors
                .values()
                .map(|actor| actor.shots_fired)
                .sum(),
            combat_events: self.runtime.durable.combat_event_count,
            hits: self.runtime.durable.hits,
            deaths: self.runtime.durable.deaths,
            inventory_stacks: self.runtime.durable.inventory.len(),
            reservations: self.runtime.durable.reservations.len(),
            npc_jobs: self.runtime.durable.npc_jobs.len(),
            timeline_events: self.runtime.durable.timeline_events.len(),
            placed_extractors: self.runtime.durable.placed_extractors.len(),
            state_hash: String::new(),
        }
    }

    pub fn last_advance_timing(&self) -> SliceAuthorityAdvanceTiming {
        self.runtime.last_advance_timing.clone()
    }
}

fn build_combat_weapon_range_bands(
    snapshot: &SliceSnapshot,
) -> Result<BTreeMap<AuthorityWeaponId, WeaponRollRangeBands>, SliceAuthorityBuildError> {
    let mut bands = BTreeMap::new();
    for weapon_id in ROLL_TUNABLE_WEAPON_IDS {
        let weapon = weapon_profile(Some(*weapon_id));
        let Some(stats) = weapon.roll_stats else {
            continue;
        };
        let range_bands = stats.range_bands();
        validate_combat_weapon_range_bands(authority_weapon_id_label(*weapon_id), range_bands)?;
        bands.insert(*weapon_id, range_bands);
    }

    let Some(tuning) = snapshot.combat_tuning.as_ref() else {
        return Ok(bands);
    };
    for (weapon_id_label, tuning_bands) in &tuning.weapon_range_bands {
        let weapon_id = authority_weapon_id_from_label(weapon_id_label).ok_or_else(|| {
            SliceAuthorityBuildError::UnknownCombatTuningWeaponId {
                weapon_id: weapon_id_label.clone(),
            }
        })?;
        let weapon = weapon_profile(Some(weapon_id));
        if weapon.roll_stats.is_none() {
            return Err(SliceAuthorityBuildError::UnknownCombatTuningWeaponId {
                weapon_id: weapon_id_label.clone(),
            });
        }
        let range_bands = weapon_range_bands_from_tuning(tuning_bands);
        validate_combat_weapon_range_bands(weapon_id_label, range_bands)?;
        bands.insert(weapon_id, range_bands);
    }
    Ok(bands)
}

fn weapon_range_bands_from_tuning(
    tuning: &crate::WeaponRangeBandTuningSnapshot,
) -> WeaponRollRangeBands {
    WeaponRollRangeBands {
        point_blank_cells: tuning.point_blank_cells,
        ideal_cells: tuning.ideal_cells,
        max_cells: tuning.max_cells,
    }
}

fn validate_combat_weapon_range_bands(
    weapon_id: &str,
    bands: WeaponRollRangeBands,
) -> Result<(), SliceAuthorityBuildError> {
    if 0 < bands.point_blank_cells
        && bands.point_blank_cells < bands.ideal_cells
        && bands.ideal_cells < bands.max_cells
        && bands.max_cells <= 96
    {
        return Ok(());
    }
    Err(
        SliceAuthorityBuildError::InvalidCombatTuningWeaponRangeBands {
            weapon_id: weapon_id.to_owned(),
            point_blank_cells: bands.point_blank_cells,
            ideal_cells: bands.ideal_cells,
            max_cells: bands.max_cells,
        },
    )
}

fn normalize_inventory_stack_ids(
    inventory: &mut [InventoryStackSnapshot],
) -> BTreeMap<String, u64> {
    let mut used_by_container: BTreeMap<String, BTreeSet<u64>> = BTreeMap::new();
    let mut next_by_container: BTreeMap<String, u64> = BTreeMap::new();
    for row in inventory {
        let used = used_by_container.entry(row.container.clone()).or_default();
        let next = next_by_container.entry(row.container.clone()).or_insert(1);
        if row.stack_id == 0 || used.contains(&row.stack_id) {
            row.stack_id = *next;
        }
        used.insert(row.stack_id);
        *next = (*next).max(row.stack_id.saturating_add(1));
    }
    next_by_container
}

fn player_organizations_from_snapshot(
    snapshot: &SliceSnapshot,
) -> Result<BTreeMap<String, PlayerOrganizationAuthorityState>, SliceAuthorityBuildError> {
    let mut organizations = BTreeMap::new();
    for org in &snapshot.player_organizations {
        let Some(id) = normalize_player_organization_key(Some(&org.id)) else {
            return Err(SliceAuthorityBuildError::InvalidPopulationConfig(
                "player organization id cannot be empty".to_owned(),
            ));
        };
        let label = org.label.trim();
        if label.is_empty() {
            return Err(SliceAuthorityBuildError::InvalidPopulationConfig(format!(
                "player organization {id} label cannot be empty"
            )));
        }
        let tag = org.tag.trim();
        if tag.is_empty() {
            return Err(SliceAuthorityBuildError::InvalidPopulationConfig(format!(
                "player organization {id} tag cannot be empty"
            )));
        }
        let state = PlayerOrganizationAuthorityState {
            id,
            label: label.to_owned(),
            tag: tag.to_owned(),
            member_actor_ids: normalized_string_list(&org.member_actor_ids),
            ally_organization_ids: normalized_organization_list(&org.ally_organization_ids),
            enemy_organization_ids: normalized_organization_list(&org.enemy_organization_ids),
        };
        if organizations.insert(state.id.clone(), state).is_some() {
            return Err(SliceAuthorityBuildError::InvalidPopulationConfig(
                "duplicate player organization id".to_owned(),
            ));
        }
    }
    Ok(organizations)
}

fn normalize_player_organization_key(value: Option<&str>) -> Option<String> {
    crate::faction::normalize_optional_key(value)
}

fn normalize_player_organization_tag(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn normalized_organization_list(values: &[String]) -> Vec<String> {
    values
        .iter()
        .filter_map(|value| normalize_player_organization_key(Some(value)))
        .collect()
}

fn normalized_string_list(values: &[String]) -> Vec<String> {
    values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}
