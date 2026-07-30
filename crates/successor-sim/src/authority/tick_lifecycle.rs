use super::camps::actor_inside_camp_shelter;
use super::*;
use crate::dialogue_corpus::{bark_archetype_for, bark_mood_for_sample, resolve_bark, sample_bark};

fn regen_vital_scaled(
    current: &mut i32,
    max: i32,
    carry: &mut i64,
    rate_milli_per_second: i32,
    multiplier_milli: i32,
    tick_rate_hz: u32,
) {
    let max = max.max(0);
    if *current >= max {
        *carry = 0;
        return;
    }
    if rate_milli_per_second <= 0 || multiplier_milli <= 0 {
        return;
    }
    let divisor = i64::from(tick_rate_hz.max(1))
        .saturating_mul(1_000_000)
        .max(1);
    *carry = carry.saturating_add(
        i64::from(rate_milli_per_second).saturating_mul(i64::from(multiplier_milli)),
    );
    let regen = *carry / divisor;
    if regen <= 0 {
        return;
    }
    *carry %= divisor;
    *current = current
        .saturating_add(i32::try_from(regen).unwrap_or(i32::MAX))
        .min(max);
    if *current >= max {
        *carry = 0;
    }
}

impl SliceAuthorityState {
    pub(super) fn advance_authority_tick(&mut self) -> Vec<AuthorityCombatEventSnapshot> {
        self.advance_authority_tick_with_weather_hazards(&[])
    }

    pub(super) fn advance_authority_tick_with_weather_hazards(
        &mut self,
        weather_hazards: &[AuthorityWeatherHazard],
    ) -> Vec<AuthorityCombatEventSnapshot> {
        self.expire_player_corpses();
        self.tick_inventory_ledgers();
        self.tick_weapon_reloads();
        self.tick_respawn_lifecycle();
        self.tick_link_dead_actors();
        self.tick_trade_sessions();
        self.tick_group_invite_expiry();
        self.tick_guilds();
        self.prune_expired_population_actors();
        self.tick_population_activation();
        self.tick_population_spawns();
        self.tick_encounter_barks();
        self.auto_equip_personal_shields();
        self.tick_personal_shields();
        self.tick_consumable_effects();
        let mut combat_events = self.tick_bleed_stacks();
        self.tick_incap_self_revives();
        self.tick_weather_hazards(weather_hazards);
        self.tick_passive_regen();
        self.tick_service_buffs();
        self.tick_sleep_states();
        self.tick_clone_sickness();
        self.tick_actor_postures();
        self.tick_player_move_intents();
        self.drain_due_combat_action_queues();
        self.tick_pending_resource_samples();
        self.tick_resource_sample_loops();
        self.tick_placed_extractors();
        self.tick_placed_camps();
        self.tick_plot_tending();
        self.tick_suppression_states();
        self.tick_respawn_return_actors();
        self.tick_auto_train_player_like_pawns();
        self.tick_npc_jobs();
        let ai_timer = AuthorityTimer::start();
        self.tick_ai_actors();
        combat_events.append(&mut self.runtime.pending_combat_events);
        self.runtime.current_ai_us = self
            .runtime
            .current_ai_us
            .saturating_add(ai_timer.elapsed_us());
        let route_timer = AuthorityTimer::start();
        self.tick_route_actors();
        self.face_combat_actors_toward_engagement_targets();
        self.runtime.current_route_us = self
            .runtime
            .current_route_us
            .saturating_add(route_timer.elapsed_us());
        // Resolve duel end conditions AFTER combat so a same-tick down is caught,
        // and prune expired challenges (mirrors group-invite expiry).
        self.tick_duel_lifecycle();
        combat_events
    }

    fn tick_encounter_barks(&mut self) {
        let mut zones = BTreeSet::new();
        for actor in self.runtime.durable.actors.values() {
            if actor.life_state == AuthorityLifeState::Alive
                && actor.spawn_zone_id.is_some()
                && is_skirmisher_role(&actor.role)
                && bark_archetype_for(
                    &actor.role,
                    actor.faction.faction_id.as_deref(),
                    actor.faction.social_group.as_deref(),
                )
                .is_some()
            {
                zones.insert(actor.spawn_zone_id.clone().unwrap_or_default());
            }
        }
        for zone_id in zones {
            if self
                .runtime
                .durable
                .bark_claims
                .contains_encounter(&zone_id)
            {
                continue;
            }
            let Some((speaker, _player, distance)) = self
                .runtime
                .durable
                .actors
                .values()
                .filter(|actor| {
                    actor.life_state == AuthorityLifeState::Alive
                        && actor.spawn_zone_id.as_deref() == Some(zone_id.as_str())
                        && is_skirmisher_role(&actor.role)
                        && bark_archetype_for(
                            &actor.role,
                            actor.faction.faction_id.as_deref(),
                            actor.faction.social_group.as_deref(),
                        )
                        .is_some()
                })
                .flat_map(|speaker| {
                    self.runtime
                        .durable
                        .actors
                        .values()
                        .filter(|player| {
                            is_human_player_actor(player)
                                && player.life_state == AuthorityLifeState::Alive
                                && player.area_id == speaker.area_id
                        })
                        .map(move |player| {
                            (
                                speaker,
                                player,
                                position_distance_milli(speaker.position, player.position),
                            )
                        })
                })
                .min_by(|left, right| {
                    left.2
                        .cmp(&right.2)
                        .then(left.0.id.cmp(&right.0.id))
                        .then(left.1.id.cmp(&right.1.id))
                })
            else {
                continue;
            };
            let sample = sample_bark(
                u64::from(string_hash32(&format!("encounter:{zone_id}"))),
                &zone_id,
                self.runtime.durable.tick,
            );
            if distance > sample.trigger_radius_milli as i32 {
                continue;
            }
            let Some(archetype) = bark_archetype_for(
                &speaker.role,
                speaker.faction.faction_id.as_deref(),
                speaker.faction.social_group.as_deref(),
            ) else {
                continue;
            };
            let mood = bark_mood_for_sample(sample);
            let Some(body) = resolve_bark(
                &mut self.runtime.durable.bark_claims,
                u64::from(string_hash32(&format!("encounter:{zone_id}"))),
                &zone_id,
                self.runtime.durable.tick,
                archetype,
                mood,
            ) else {
                continue;
            };
            self.runtime
                .pending_dialogue_deliveries
                .push(AuthorityDialogueDelivery {
                    actor_id: speaker.id.clone(),
                    speaker: if speaker.display_name.is_empty() {
                        speaker.label.clone()
                    } else {
                        speaker.display_name.clone()
                    },
                    body: body.to_owned(),
                    area_id: speaker.area_id.clone(),
                    x: speaker.position.x,
                    y: speaker.position.y,
                    tick: self.runtime.durable.tick,
                });
        }
    }

    pub(crate) fn take_dialogue_deliveries(&mut self) -> Vec<AuthorityDialogueDelivery> {
        std::mem::take(&mut self.runtime.pending_dialogue_deliveries)
    }

    pub(super) fn tick_link_dead_actors(&mut self) {
        let expired_actor_ids = self
            .runtime
            .durable
            .actors
            .values()
            .filter(|actor| {
                actor.link_dead
                    && actor.link_dead_expires_tick > 0
                    && self.runtime.durable.tick >= actor.link_dead_expires_tick
            })
            .map(|actor| actor.id.clone())
            .collect::<Vec<_>>();
        for actor_id in expired_actor_ids {
            if let Some(snapshot) = self.actor_snapshot(&actor_id) {
                self.runtime.current_linkdead_logout_actors.push(snapshot);
            }
            self.runtime
                .current_removed_actor_ids
                .push(actor_id.clone());
            self.remove_actor(&actor_id);
        }
    }

    /// Reap terminal trade sessions past their one-tick display window, then abort any
    /// still-open session whose participants are no longer both present, alive,
    /// connected, and in range. Clean abort — nothing was consumed before execute.
    pub(super) fn tick_trade_sessions(&mut self) {
        if self.runtime.durable.trade_proposals.is_empty() {
            return;
        }
        let current_tick = self.runtime.durable.tick;
        self.runtime
            .durable
            .trade_proposals
            .retain(|_, proposal| match proposal.closed {
                Some(close) => close.at_tick >= current_tick,
                None => true,
            });
        let to_close: Vec<(u32, TradeCloseReason)> = self
            .runtime
            .durable
            .trade_proposals
            .iter()
            .filter(|(_, proposal)| proposal.is_open())
            .filter_map(|(id, proposal)| {
                self.trade_abort_reason(proposal)
                    .map(|reason| (*id, reason))
            })
            .collect();
        for (id, reason) in to_close {
            self.close_trade_session(id, false, Some(reason));
        }
    }

    fn trade_abort_reason(&self, proposal: &TradeProposal) -> Option<TradeCloseReason> {
        match (
            self.runtime.durable.actors.get(&proposal.proposer),
            self.runtime.durable.actors.get(&proposal.partner),
        ) {
            (Some(proposer), Some(partner)) => {
                if proposer.link_dead || partner.link_dead {
                    Some(TradeCloseReason::Link)
                } else if proposer.life_state != AuthorityLifeState::Alive
                    || partner.life_state != AuthorityLifeState::Alive
                {
                    Some(TradeCloseReason::Death)
                } else if !Self::actors_within_trade_interaction_range(proposer, partner) {
                    Some(TradeCloseReason::Range)
                } else {
                    None
                }
            }
            _ => Some(TradeCloseReason::Death),
        }
    }

    pub(super) fn tick_actor_postures(&mut self) {
        for actor in self.runtime.durable.actors.values_mut() {
            match actor.posture {
                AuthorityActorPosture::KneelingDown
                    if self.runtime.durable.tick >= actor.posture_until_tick =>
                {
                    actor.posture = AuthorityActorPosture::Kneeling;
                    actor.posture_until_tick = 0;
                }
                AuthorityActorPosture::StandingUp
                    if self.runtime.durable.tick >= actor.posture_until_tick =>
                {
                    actor.posture = AuthorityActorPosture::Standing;
                    actor.posture_until_tick = 0;
                }
                _ => {}
            }
        }
    }

    pub(super) fn tick_incap_self_revives(&mut self) {
        let tick = self.runtime.durable.tick;
        let tick_rate_hz = self.runtime.durable.world.tick_rate_hz;
        for actor in self.runtime.durable.actors.values_mut() {
            if actor.life_state == AuthorityLifeState::Downed
                && actor.body_vanish_tick == 0
                && actor.incap_expires_tick > 0
                && tick >= actor.incap_expires_tick
            {
                Self::revive_actor_from_incap(tick, tick_rate_hz, actor);
            }
        }
    }

    pub(super) fn tick_weapon_reloads(&mut self) {
        let due_actor_ids = self
            .runtime
            .durable
            .actors
            .iter()
            .filter(|(_, actor)| {
                actor.slugthrower_magazine.reload_until_tick != 0
                    && self.runtime.durable.tick >= actor.slugthrower_magazine.reload_until_tick
            })
            .map(|(actor_id, _)| actor_id.clone())
            .collect::<Vec<_>>();

        for actor_id in due_actor_ids {
            let _ = self.complete_actor_weapon_reload_if_due(
                &actor_id,
                AuthorityWeaponId::Slugthrower,
                AuthorityAmmoTypeId::SlugIron,
            );
        }
    }

    pub(super) fn tick_personal_shields(&mut self) {
        let delay_ticks = ms_to_ticks_round(
            PERSONAL_SHIELD_RECHARGE_DELAY_MS,
            self.runtime.durable.world.tick_rate_hz,
        )
        .max(1);
        let recharge_ticks = ms_to_ticks_round(
            PERSONAL_SHIELD_RECHARGE_FULL_MS,
            self.runtime.durable.world.tick_rate_hz,
        )
        .max(1);
        let recharge_ticks_u32 = u32::try_from(recharge_ticks).unwrap_or(u32::MAX).max(1);
        let recharge_step = PERSONAL_SHIELD_MAX_CHARGE_MILLI
            .saturating_add(recharge_ticks_u32.saturating_sub(1))
            / recharge_ticks_u32;
        let recharge_step = recharge_step.max(1);
        for actor in self.runtime.durable.actors.values_mut() {
            if !actor_can_use_personal_shield(actor) {
                continue;
            }
            let Some(shield) = actor.personal_shield.as_mut() else {
                continue;
            };
            if shield.charge_milli == 0 && shield.durability_milli == 0 {
                actor.personal_shield = None;
                continue;
            }
            if shield.charge_milli >= PERSONAL_SHIELD_MAX_CHARGE_MILLI {
                continue;
            }
            if self.runtime.durable.tick < shield.last_damage_tick.saturating_add(delay_ticks) {
                continue;
            }
            let missing_charge =
                PERSONAL_SHIELD_MAX_CHARGE_MILLI.saturating_sub(shield.charge_milli);
            let restored = recharge_step
                .min(missing_charge)
                .min(shield.durability_milli);
            if restored == 0 {
                continue;
            }
            shield.charge_milli = shield
                .charge_milli
                .saturating_add(restored)
                .min(PERSONAL_SHIELD_MAX_CHARGE_MILLI);
            shield.durability_milli = shield.durability_milli.saturating_sub(restored);
            shield.durability_charges =
                personal_shield_durability_charges_from_milli(shield.durability_milli);
        }
    }

    pub(super) fn tick_consumable_effects(&mut self) {
        for actor in self.runtime.durable.actors.values_mut() {
            if actor.consumable_effects.is_empty() {
                continue;
            }
            if actor.life_state != AuthorityLifeState::Alive {
                if Self::uses_player_like_revivable_state(actor) {
                    continue;
                }
                actor.consumable_effects.clear();
                continue;
            }
            let mut medicine_use_xp = 0_u64;
            for effect in &mut actor.consumable_effects {
                if effect.heal_remaining_milli > 0 && effect.remaining_ticks > 0 {
                    let heal_milli = div_ceil_i32(
                        effect.heal_remaining_milli,
                        i32::from(effect.remaining_ticks).max(1),
                    )
                    .min(effect.heal_remaining_milli)
                    .max(0);
                    effect.heal_remaining_milli =
                        effect.heal_remaining_milli.saturating_sub(heal_milli);
                    effect.accumulated_heal_milli =
                        effect.accumulated_heal_milli.saturating_add(heal_milli);
                    let heal_points = effect.accumulated_heal_milli / 1_000;
                    if heal_points > 0 {
                        let before_health = actor.vitals.health;
                        actor.vitals.health = actor
                            .vitals
                            .health
                            .saturating_add(heal_points)
                            .min(actor.max_vitals.health);
                        let applied_heal = actor.vitals.health.saturating_sub(before_health);
                        medicine_use_xp = medicine_use_xp.saturating_add(
                            u64::try_from(applied_heal).unwrap_or(0).saturating_mul(5),
                        );
                        effect.accumulated_heal_milli %= 1_000;
                    }
                }
                effect.remaining_ticks = effect.remaining_ticks.saturating_sub(1);
            }
            if medicine_use_xp > 0 && actor.professions.has(AuthorityProfessionKind::Medic) {
                actor.professions.award_tracks_xp(
                    AuthorityProfessionKind::Medic,
                    &["medicine-use", "medicine-speed"],
                    medicine_use_xp,
                );
            }
            actor
                .consumable_effects
                .retain(|effect| effect.remaining_ticks > 0 && effect.heal_remaining_milli > 0);
        }
    }

    pub(super) fn tick_service_buffs(&mut self) {
        for actor in self.runtime.durable.actors.values_mut() {
            if actor.service_buffs.is_empty() {
                continue;
            }
            if actor.life_state != AuthorityLifeState::Alive
                && Self::uses_player_like_revivable_state(actor)
            {
                continue;
            }
            let before = actor.service_buffs.len();
            for buff in &mut actor.service_buffs {
                buff.remaining_ticks = buff.remaining_ticks.saturating_sub(1);
            }
            actor.service_buffs.retain(|buff| buff.remaining_ticks > 0);
            if actor.service_buffs.len() != before {
                refresh_actor_effective_stats(actor);
            }
        }
    }

    pub(super) fn tick_bleed_stacks(&mut self) -> Vec<AuthorityCombatEventSnapshot> {
        let mut bleedout_deaths = 0_u64;
        let mut bleedout_events = Vec::new();
        let mut bleed_damage_stats = Vec::new();
        let mut next_combat_event_id = self.runtime.durable.next_combat_event_id;
        let tick = self.runtime.durable.tick;
        let tick_rate_hz = self.runtime.durable.world.tick_rate_hz;
        for actor in self.runtime.durable.actors.values_mut() {
            if actor.life_state == AuthorityLifeState::Respawning {
                continue;
            }

            if actor.bleed_stacks.is_empty() {
                continue;
            }

            for stack in &mut actor.bleed_stacks {
                stack.accumulated_damage_milli = stack
                    .accumulated_damage_milli
                    .saturating_add(stack.damage_milli_per_tick);
                let health_damage = stack.accumulated_damage_milli / 1_000;
                if health_damage > 0 {
                    apply_vital_damage(&mut actor.vitals.health, health_damage);
                    bleed_damage_stats.push((
                        stack.source_actor_id.clone(),
                        actor.id.clone(),
                        health_damage,
                    ));
                    stack.accumulated_damage_milli %= 1_000;
                }
                stack.remaining_ticks = stack.remaining_ticks.saturating_sub(1);
            }
            actor.bleed_stacks.retain(|stack| stack.remaining_ticks > 0);

            if actor.life_state == AuthorityLifeState::Alive && actor.vitals.health <= 0 {
                let previous_life_state = actor.life_state;
                let source_actor_id = bleed_source_actor_id(actor);
                let bleed_stack_count = bleed_stack_count(actor);
                if Self::uses_npc_corpse_respawn_timer(actor) {
                    Self::kill_actor_for_respawn(tick, tick_rate_hz, actor);
                    bleedout_deaths = bleedout_deaths.saturating_add(1);
                    bleedout_events.push(Self::bleed_lifecycle_event(
                        next_combat_event_id,
                        tick,
                        actor,
                        previous_life_state,
                        source_actor_id,
                        bleed_stack_count,
                        AuthorityCombatLifecycleKind::Killed,
                        "bleedout",
                    ));
                    next_combat_event_id = next_combat_event_id.saturating_add(1);
                    continue;
                }
                if Self::down_player_like_actor_or_kill(tick, tick_rate_hz, actor) {
                    bleedout_deaths = bleedout_deaths.saturating_add(1);
                    bleedout_events.push(Self::bleed_lifecycle_event(
                        next_combat_event_id,
                        tick,
                        actor,
                        previous_life_state,
                        source_actor_id,
                        bleed_stack_count,
                        AuthorityCombatLifecycleKind::Killed,
                        "incap threshold",
                    ));
                    next_combat_event_id = next_combat_event_id.saturating_add(1);
                    continue;
                }
                actor.downed_action_drain_milli = 0;
                actor.downed_spirit_drain_milli = 0;
                bleedout_events.push(Self::bleed_lifecycle_event(
                    next_combat_event_id,
                    tick,
                    actor,
                    previous_life_state,
                    source_actor_id,
                    bleed_stack_count,
                    AuthorityCombatLifecycleKind::Downed,
                    "bleedout",
                ));
                next_combat_event_id = next_combat_event_id.saturating_add(1);
                continue;
            }

            if actor.life_state == AuthorityLifeState::Downed && actor.body_vanish_tick == 0 {
                if !actor.bleed_stacks.is_empty() {
                    apply_downed_bleed_pressure(actor, tick_rate_hz);
                }
                if actor.vitals.health <= 0
                    && (actor.bleed_stacks.is_empty()
                        || (actor.vitals.action <= 0 && actor.vitals.spirit <= 0))
                {
                    let previous_life_state = actor.life_state;
                    let source_actor_id = bleed_source_actor_id(actor);
                    let bleed_stack_count = bleed_stack_count(actor);
                    Self::kill_actor_for_respawn(tick, tick_rate_hz, actor);
                    bleedout_deaths = bleedout_deaths.saturating_add(1);
                    bleedout_events.push(Self::bleed_lifecycle_event(
                        next_combat_event_id,
                        tick,
                        actor,
                        previous_life_state,
                        source_actor_id,
                        bleed_stack_count,
                        AuthorityCombatLifecycleKind::Killed,
                        "bleedout",
                    ));
                    next_combat_event_id = next_combat_event_id.saturating_add(1);
                }
            }
        }
        self.runtime.durable.next_combat_event_id = next_combat_event_id;
        self.runtime.durable.combat_event_count = self
            .runtime
            .durable
            .combat_event_count
            .saturating_add(u64::try_from(bleedout_events.len()).unwrap_or(u64::MAX));
        self.runtime.durable.deaths = self.runtime.durable.deaths.saturating_add(bleedout_deaths);
        for (source_actor_id, target_actor_id, damage) in bleed_damage_stats {
            self.record_damage_stats(&source_actor_id, &target_actor_id, tick, damage, false);
        }
        for event in &bleedout_events {
            if event.lifecycle == AuthorityCombatLifecycleKind::Killed {
                self.finalize_actor_corpse_after_death(&event.target_actor_id, event.tick);
                self.award_kill_combat_xp_to_damagers(&event.target_actor_id);
            }
        }
        for event in &bleedout_events {
            self.record_combat_event_stats(event);
        }
        bleedout_events
    }

    pub(super) fn tick_weather_hazards(&mut self, weather_hazards: &[AuthorityWeatherHazard]) {
        if weather_hazards.is_empty() {
            return;
        }
        // Scout camps contribute weather-shelter exemption zones, reusing the
        // same AuthorityWeatherShelterBox primitive as prop shelters. Gathered
        // once here so the actor loop below can borrow self.actors mutably.
        let camp_shelters = self.active_camp_shelter_boxes();
        let tick = self.runtime.durable.tick;
        let tick_rate_hz = self.runtime.durable.world.tick_rate_hz;
        let tick_rate_hz_i32 = i32::try_from(tick_rate_hz.max(1))
            .unwrap_or(i32::MAX)
            .max(1);
        let mut weather_deaths = 0_u64;
        let mut weather_death_actor_ids = Vec::new();
        for hazard in weather_hazards {
            let damage_milli_per_tick =
                div_ceil_i32(hazard.dps_milli_health.max(0), tick_rate_hz_i32);
            if damage_milli_per_tick <= 0 || hazard.radius_milli <= 0 {
                continue;
            }
            let radius_sq =
                i64::from(hazard.radius_milli).saturating_mul(i64::from(hazard.radius_milli));
            for actor in self.runtime.durable.actors.values_mut() {
                if actor.area_id != hazard.area_id
                    || actor.life_state != AuthorityLifeState::Alive
                    || !weather_hazard_can_damage_actor(actor)
                    || !actor_inside_weather_radius(actor, hazard, radius_sq)
                    || actor_inside_weather_shelter(actor, hazard)
                    || actor_inside_camp_shelter(actor, &camp_shelters)
                {
                    continue;
                }
                actor.weather_damage_accumulated_milli = actor
                    .weather_damage_accumulated_milli
                    .saturating_add(damage_milli_per_tick);
                let health_damage = actor.weather_damage_accumulated_milli / 1_000;
                if health_damage <= 0 {
                    continue;
                }
                apply_vital_damage(&mut actor.vitals.health, health_damage);
                actor.weather_damage_accumulated_milli %= 1_000;
                if actor.vitals.health > 0 {
                    continue;
                }
                if Self::uses_npc_corpse_respawn_timer(actor) {
                    let actor_id = actor.id.clone();
                    Self::kill_actor_for_respawn(tick, tick_rate_hz, actor);
                    weather_death_actor_ids.push(actor_id);
                    weather_deaths = weather_deaths.saturating_add(1);
                    continue;
                }
                if Self::down_player_like_actor_or_kill(tick, tick_rate_hz, actor) {
                    weather_deaths = weather_deaths.saturating_add(1);
                }
            }
        }
        for actor_id in weather_death_actor_ids {
            self.finalize_actor_corpse_after_death(&actor_id, tick);
            self.award_kill_combat_xp_to_damagers(&actor_id);
        }
        self.runtime.durable.deaths = self.runtime.durable.deaths.saturating_add(weather_deaths);
    }

    pub(super) fn tick_passive_regen(&mut self) {
        let tick_rate_hz = self.runtime.durable.world.tick_rate_hz.max(1);
        // Field Rest: scouts resting in their OWN camp regen health/action faster (x1.0..x1.75
        // by campcraft). Computed once here so the per-actor loop can borrow actors mutably.
        let field_rest_mult_by_actor = self.field_rest_mult_by_owner_in_camp();
        for actor in self.runtime.durable.actors.values_mut() {
            if actor.life_state != AuthorityLifeState::Alive || actor.sleep.remaining_ticks > 0 {
                continue;
            }
            let player_like = is_player_like_role(&actor.role);
            let field_rest_mult = field_rest_mult_by_actor
                .get(&actor.id)
                .copied()
                .unwrap_or(1_000);
            if actor.bleed_stacks.is_empty() {
                let health_regen_target = if player_like {
                    actor.max_vitals.health
                } else {
                    actor
                        .effective_stats
                        .spawn_vitals
                        .health
                        .min(actor.max_vitals.health)
                };
                regen_vital(
                    &mut actor.vitals.health,
                    health_regen_target,
                    &mut actor.passive_regen_milli.health,
                    field_rest_scaled_rate_milli(
                        actor.effective_stats.regen_rates_milli_per_second.health,
                        field_rest_mult,
                    ),
                    tick_rate_hz,
                );
            } else {
                actor.passive_regen_milli.health = 0;
            }
            let action_regen_target = if player_like {
                actor.max_vitals.action
            } else {
                actor
                    .effective_stats
                    .spawn_vitals
                    .action
                    .min(actor.max_vitals.action)
            };
            let action_regen_rate = field_rest_scaled_rate_milli(
                actor.effective_stats.regen_rates_milli_per_second.action,
                field_rest_mult,
            );
            if actor.sprint_recovery_locked {
                regen_vital_scaled(
                    &mut actor.vitals.action,
                    action_regen_target,
                    &mut actor.sprint_recovery_regen_carry,
                    action_regen_rate,
                    SPRINT_RECOVERY_REGEN_MULTIPLIER_MILLI,
                    tick_rate_hz,
                );
                if actor.vitals.action >= action_regen_target {
                    actor.sprint_recovery_locked = false;
                    actor.sprint_recovery_regen_carry = 0;
                }
            } else if self.runtime.durable.tick > actor.sprint_regen_block_until_tick {
                regen_vital(
                    &mut actor.vitals.action,
                    action_regen_target,
                    &mut actor.passive_regen_milli.action,
                    action_regen_rate,
                    tick_rate_hz,
                );
            }
            let spirit_regen_target = if player_like {
                actor.max_vitals.spirit
            } else {
                actor
                    .effective_stats
                    .spawn_vitals
                    .spirit
                    .min(actor.max_vitals.spirit)
            };
            regen_vital(
                &mut actor.vitals.spirit,
                spirit_regen_target,
                &mut actor.passive_regen_milli.spirit,
                actor.effective_stats.regen_rates_milli_per_second.spirit,
                tick_rate_hz,
            );
        }
    }

    pub(super) fn bleed_lifecycle_event(
        event_id: u64,
        tick: u64,
        actor: &ActorAuthorityState,
        previous_life_state: AuthorityLifeState,
        source_actor_id: String,
        bleed_stack_count: u8,
        lifecycle: AuthorityCombatLifecycleKind,
        lifecycle_cause: &str,
    ) -> AuthorityCombatEventSnapshot {
        AuthorityCombatEventSnapshot {
            id: event_id,
            command_id: None,
            tick,
            shooter_actor_id: source_actor_id,
            target_actor_id: actor.id.clone(),
            origin_x: None,
            origin_y: None,
            hit_x: cell_units_from_milli(actor.position.x + MILLI_CELLS_PER_CELL / 2),
            hit_y: cell_units_from_milli(actor.position.y + MILLI_CELLS_PER_CELL / 2),
            damage: 0,
            previous_life_state,
            life_state: actor.life_state,
            target_lifecycle_seq: actor.lifecycle_seq,
            bleed_stack_count,
            lifecycle,
            zone: "torso".to_owned(),
            weapon_id: AuthorityWeaponId::Slugthrower,
            ammo_type: AuthorityAmmoTypeId::SlugIron,
            effect: None,
            lifecycle_cause: lifecycle_cause.to_owned(),
            kind: None,
            attacker_actor_id: None,
            action_id: None,
            hit: None,
            pool: None,
            roll_milli: None,
            to_hit_milli: None,
            block_roll_milli: None,
            block_chance_milli: None,
        }
    }

    pub(super) fn tick_sleep_states(&mut self) {
        for actor in self.runtime.durable.actors.values_mut() {
            actor.sleep.remaining_ticks = actor.sleep.remaining_ticks.saturating_sub(1);
            if actor.sleep.remaining_ticks == 0 {
                actor.sleep.stacks = 0;
            }
        }
    }

    pub(super) fn tick_clone_sickness(&mut self) {
        for actor in self.runtime.durable.actors.values_mut() {
            actor.clone_sickness_ticks = actor.clone_sickness_ticks.saturating_sub(1);
        }
    }

    pub(super) fn tick_suppression_states(&mut self) {
        let base_decay = div_ceil_i32(
            SUPPRESSION_DECAY_MILLI_PER_SECOND,
            self.runtime.durable.world.tick_rate_hz.max(1) as i32,
        );
        for actor in self.runtime.durable.actors.values_mut() {
            if actor.suppression.pressure_milli <= 0 {
                continue;
            }
            let decay = suppression_decay_milli_per_tick_for_actor(actor, base_decay);
            actor.suppression.pressure_milli = actor
                .suppression
                .pressure_milli
                .saturating_sub(decay)
                .max(0);
            if actor.suppression.pressure_milli == 0 {
                actor.suppression.source = None;
            }
            let threshold = suppression_threshold_milli_for_actor(actor);
            if actor.suppression.pressure_milli >= threshold {
                if let (Some(source), Some(AuthorityAiState::PassiveCreature(ai))) =
                    (actor.suppression.source, actor.ai.as_mut())
                {
                    if ai.mode == PassiveCreatureMode::Engage {
                        ai.threat = Some(source);
                    } else if ai.mode != PassiveCreatureMode::Flee {
                        ai.mode = PassiveCreatureMode::Flee;
                        ai.threat_actor_id = None;
                        ai.chase_until_tick = 0;
                        ai.target = None;
                        ai.next_decision_tick = self.runtime.durable.tick;
                        ai.last_update_tick = self.runtime.durable.tick;
                    }
                    ai.threat = Some(source);
                    ai.panic_until_tick = ai
                        .panic_until_tick
                        .max(self.runtime.durable.tick.saturating_add(2));
                    if ai.next_update_tick > self.runtime.durable.tick {
                        ai.next_update_tick = self.runtime.durable.tick;
                    }
                }
            }
        }
    }

    pub(super) fn tick_inventory_ledgers(&mut self) {
        if self.runtime.durable.reservations.is_empty() {
            return;
        }
        let mut expired = Vec::new();
        self.runtime.durable.reservations.retain(|reservation| {
            if reservation
                .expires_at_tick
                .is_some_and(|expires_at_tick| expires_at_tick <= self.runtime.durable.tick)
            {
                expired.push(reservation.clone());
                false
            } else {
                true
            }
        });
        for reservation in expired {
            if let Some(row) = self
                .runtime
                .durable
                .inventory
                .iter_mut()
                .find(|row| row.container == reservation.from && row.item == reservation.item)
            {
                row.reserved = row.reserved.saturating_sub(reservation.quantity);
                row.available = row.quantity.saturating_sub(row.reserved);
            }
            self.record_timeline_event(TimelineEventSnapshot {
                tick: self.runtime.durable.tick,
                label: format!("reservation #{} expired", reservation.id),
                cell: None,
            });
        }
    }

    pub(super) fn tick_npc_jobs(&mut self) {
        for job_index in 0..self.runtime.durable.npc_jobs.len() {
            let (actor_id, job_kind, target_cell) = {
                let job = &self.runtime.durable.npc_jobs[job_index];
                (
                    job.actor.clone(),
                    job.kind.clone(),
                    target_cell_from_job(job),
                )
            };
            let Some(target_cell) = target_cell else {
                continue;
            };
            let Some(actor) = self.runtime.durable.actors.get(&actor_id) else {
                self.runtime.durable.npc_jobs[job_index].state = "missing_actor".to_owned();
                continue;
            };
            if actor.role == "player"
                || actor.id.starts_with("game-ws-")
                || actor.life_state != AuthorityLifeState::Alive
                || actor.sleep.remaining_ticks > 0
                || self.runtime.durable.tick < actor.next_route_tick
            {
                continue;
            }
            let at_target = actor.cell == target_cell;
            let area_id = actor.area_id.clone();
            let (dx, dy) = route_step_toward(actor.cell, target_cell);
            let next_cell = AuthorityCell::new(actor.cell.x + dx, actor.cell.y + dy);
            let outside_area = match self.runtime.durable.world.areas.get(&area_id) {
                Some(area) => !area.contains(next_cell),
                None => true,
            };
            let blocked = !at_target
                && (outside_area
                    || self
                        .runtime
                        .durable
                        .world
                        .blocked_cells
                        .contains(&CellKey::new(&area_id, next_cell.x, next_cell.y)));

            let Some(actor) = self.runtime.durable.actors.get_mut(&actor_id) else {
                continue;
            };
            actor.next_route_tick = self
                .runtime
                .durable
                .tick
                .saturating_add(NPC_ROUTE_STEP_INTERVAL_TICKS);
            if at_target {
                self.runtime.durable.npc_jobs[job_index].state =
                    npc_job_terminal_state(&job_kind).to_owned();
                continue;
            }
            if blocked {
                self.runtime.durable.npc_jobs[job_index].state = "blocked".to_owned();
                continue;
            }
            actor.cell = next_cell;
            actor.position = AuthorityPosition::from_cell(next_cell);
            actor.direction = direction_for_delta(dx, dy).to_owned();
            self.runtime.durable.npc_jobs[job_index].state = if actor.cell == target_cell {
                npc_job_terminal_state(&job_kind).to_owned()
            } else {
                "moving".to_owned()
            };
        }
    }

    pub(super) fn tick_respawn_return_actors(&mut self) {
        let actor_ids = self
            .runtime
            .durable
            .actors
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for actor_id in actor_ids {
            let Some(actor) = self.runtime.durable.actors.get(&actor_id) else {
                continue;
            };
            if actor.respawn_return.is_empty()
                || actor.life_state != AuthorityLifeState::Alive
                || actor.sleep.remaining_ticks > 0
                || self.runtime.durable.tick < actor.next_route_tick
            {
                continue;
            }
            let step = actor.respawn_return[0].clone();
            match step {
                RespawnReturnStepAuthorityState::Walk { area_id, cell } => {
                    let (same_area, at_target, current_position, blocked) = {
                        let Some(actor) = self.runtime.durable.actors.get(&actor_id) else {
                            continue;
                        };
                        if actor.area_id != area_id {
                            (false, false, actor.position, false)
                        } else {
                            let (dx, dy) = route_step_toward(actor.cell, cell);
                            let next_cell =
                                AuthorityCell::new(actor.cell.x + dx, actor.cell.y + dy);
                            let at_target = dx == 0 && dy == 0;
                            let outside_area = match self.runtime.durable.world.areas.get(&area_id)
                            {
                                Some(area) => !area.contains(next_cell),
                                None => true,
                            };
                            let blocked = !at_target
                                && (outside_area
                                    || self.runtime.durable.world.blocked_cells.contains(
                                        &CellKey::new(&area_id, next_cell.x, next_cell.y),
                                    ));
                            (true, at_target, actor.position, blocked)
                        }
                    };
                    if !same_area {
                        let Some(actor) = self.runtime.durable.actors.get_mut(&actor_id) else {
                            continue;
                        };
                        actor.next_route_tick = self
                            .runtime
                            .durable
                            .tick
                            .saturating_add(ROUTE_PATROL_UPDATE_CADENCE_TICKS);
                        actor.area_id = area_id;
                        actor.cell = cell;
                        actor.position = AuthorityPosition::from_cell(cell);
                        actor.respawn_return.remove(0);
                        if actor.respawn_return.is_empty() {
                            Self::complete_respawn_return(actor);
                        }
                        continue;
                    }
                    if at_target {
                        let Some(actor) = self.runtime.durable.actors.get_mut(&actor_id) else {
                            continue;
                        };
                        actor.next_route_tick = self
                            .runtime
                            .durable
                            .tick
                            .saturating_add(ROUTE_PATROL_UPDATE_CADENCE_TICKS);
                        actor.cell = cell;
                        actor.position = AuthorityPosition::from_cell(cell);
                        actor.respawn_return.remove(0);
                        if actor.respawn_return.is_empty() {
                            Self::complete_respawn_return(actor);
                        }
                        continue;
                    }
                    if blocked {
                        if let Some(actor) = self.runtime.durable.actors.get_mut(&actor_id) {
                            actor.next_route_tick = self
                                .runtime
                                .durable
                                .tick
                                .saturating_add(ROUTE_PATROL_UPDATE_CADENCE_TICKS);
                        }
                        continue;
                    }
                    let step_target = route_patrol_axis_target(
                        current_position,
                        AuthorityPosition::from_cell(cell),
                    );
                    let moved = self.move_ai_actor_toward_position(
                        &actor_id,
                        step_target,
                        route_patrol_distance_for_ticks(ROUTE_PATROL_UPDATE_CADENCE_TICKS),
                    );
                    let Some(actor) = self.runtime.durable.actors.get_mut(&actor_id) else {
                        continue;
                    };
                    actor.next_route_tick = self
                        .runtime
                        .durable
                        .tick
                        .saturating_add(ROUTE_PATROL_UPDATE_CADENCE_TICKS);
                    if moved
                        && position_distance_milli(
                            actor.position,
                            AuthorityPosition::from_cell(cell),
                        ) <= 1
                    {
                        actor.cell = cell;
                        actor.position = AuthorityPosition::from_cell(cell);
                        actor.respawn_return.remove(0);
                    }
                    if actor.respawn_return.is_empty() {
                        Self::complete_respawn_return(actor);
                    }
                }
            }
        }
    }

    pub(super) fn tick_route_actors(&mut self) {
        let actor_ids = self
            .runtime
            .durable
            .actors
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for actor_id in actor_ids {
            let Some(actor) = self.runtime.durable.actors.get(&actor_id) else {
                continue;
            };
            if actor.role == "player"
                || actor.id.starts_with("game-ws-")
                || actor.route.len() < 2
                || (actor_uses_combat_tactics(actor)
                    && self.skirmisher_has_active_tactical_contact(actor))
                || !actor.respawn_return.is_empty()
                || self.actor_has_active_npc_job(&actor.id)
                || actor.life_state != AuthorityLifeState::Alive
                || actor.sleep.remaining_ticks > 0
                || self.runtime.durable.tick < actor.next_route_tick
            {
                continue;
            }
            let route_index = actor.route_index % actor.route.len();
            let target = actor.route[route_index];
            let target_position = AuthorityPosition::from_cell(target);
            let at_target = position_distance_milli(actor.position, target_position) <= 1;
            if at_target {
                let Some(actor) = self.runtime.durable.actors.get_mut(&actor_id) else {
                    continue;
                };
                actor.cell = target;
                actor.position = target_position;
                actor.route_index = (route_index + 1) % actor.route.len();
                actor.next_route_tick = self
                    .runtime
                    .durable
                    .tick
                    .saturating_add(ROUTE_PATROL_UPDATE_CADENCE_TICKS);
                continue;
            }

            let step_target = route_patrol_axis_target(actor.position, target_position);
            let moved = self.move_ai_actor_toward_position(
                &actor_id,
                step_target,
                route_patrol_distance_for_ticks(ROUTE_PATROL_UPDATE_CADENCE_TICKS),
            );
            let Some(actor) = self.runtime.durable.actors.get_mut(&actor_id) else {
                continue;
            };
            actor.next_route_tick = self
                .runtime
                .durable
                .tick
                .saturating_add(ROUTE_PATROL_UPDATE_CADENCE_TICKS);
            if moved && position_distance_milli(actor.position, target_position) <= 1 {
                actor.cell = target;
                actor.position = target_position;
                actor.route_index = (route_index + 1) % actor.route.len();
            }
        }
    }

    pub(super) fn skirmisher_has_active_tactical_contact(
        &self,
        actor: &ActorAuthorityState,
    ) -> bool {
        if combat_actor_has_tactical_contact(actor) {
            return true;
        }
        if actor.next_fire_tick > self.runtime.durable.tick || actor.suppression.pressure_milli > 0
        {
            return true;
        }
        self.nearest_skirmisher_target(actor, skirmisher_profile_for_ai_state(actor))
            .is_some()
    }

    pub(super) fn tick_respawn_lifecycle(&mut self) {
        let expired_player_like_actor_ids = self
            .runtime
            .durable
            .actors
            .values()
            .filter(|actor| {
                Self::uses_player_like_revivable_state(actor)
                    && actor.life_state == AuthorityLifeState::Downed
                    && actor.body_vanish_tick > 0
                    && self.runtime.durable.tick >= actor.body_vanish_tick
            })
            .map(|actor| actor.id.clone())
            .collect::<Vec<_>>();
        let expired_corpse_actor_ids = self
            .runtime
            .durable
            .actors
            .values()
            .filter(|actor| {
                !Self::uses_player_like_revivable_state(actor)
                    && actor.life_state == AuthorityLifeState::Downed
                    && actor.body_vanish_tick > 0
                    && self.runtime.durable.tick >= actor.body_vanish_tick
            })
            .map(|actor| actor.id.clone())
            .collect::<Vec<_>>();
        for actor_id in &expired_corpse_actor_ids {
            self.discard_corpse_inventory(actor_id);
        }
        for actor in self.runtime.durable.actors.values_mut() {
            Self::repair_skirmisher_respawn_deadlines(
                self.runtime.durable.tick,
                self.runtime.durable.world.tick_rate_hz,
                actor,
            );
            if actor.life_state == AuthorityLifeState::Downed
                && actor.body_vanish_tick > 0
                && !Self::uses_player_like_revivable_state(actor)
            {
                if self.runtime.durable.tick >= actor.body_vanish_tick {
                    Self::set_actor_life_state(actor, AuthorityLifeState::Respawning);
                    actor.body_vanish_tick = 0;
                    actor.respawn_tick = self
                        .runtime
                        .durable
                        .tick
                        .saturating_add(Self::corpse_respawn_delay_ticks());
                    Self::clear_actor_transient_respawn_state(actor);
                } else {
                    // New and restored visible corpses cannot count down a
                    // hidden respawn before their actual vanish transition.
                    actor.respawn_tick = 0;
                }
            }
        }

        for actor_id in expired_player_like_actor_ids {
            let _ = self.clone_respawn_actor_id(&actor_id, None);
        }

        let ready_respawn_actor_ids = self
            .runtime
            .durable
            .actors
            .values()
            .filter(|actor| {
                let squad_hold = self.should_hold_skirmisher_respawn_for_squad(actor);
                let enemy_hold = self.should_hold_skirmisher_respawn_for_enemy(actor);
                actor.life_state == AuthorityLifeState::Respawning
                    && actor.respawn_tick > 0
                    && self.runtime.durable.tick >= actor.respawn_tick
                    && !self
                        .runtime
                        .durable
                        .population
                        .actor_sources
                        .contains_key(&actor.id)
                    && !enemy_hold
                    && (!squad_hold || self.skirmisher_respawn_squad_ready_wave(actor))
            })
            .map(|actor| actor.id.clone())
            .collect::<Vec<_>>();

        for actor_id in ready_respawn_actor_ids {
            let has_population_capacity = self
                .runtime
                .durable
                .actors
                .get(&actor_id)
                .map(|actor| self.population_actor_has_alive_capacity(actor))
                .unwrap_or(true);
            if !has_population_capacity {
                continue;
            }
            if self
                .runtime
                .durable
                .actors
                .get(&actor_id)
                .is_some_and(Self::uses_player_like_revivable_state)
            {
                let _ = self.clone_respawn_actor_id(&actor_id, None);
                continue;
            }
            {
                let Some(actor) = self.runtime.durable.actors.get_mut(&actor_id) else {
                    continue;
                };
                if actor.life_state == AuthorityLifeState::Respawning
                    && actor.respawn_tick > 0
                    && self.runtime.durable.tick >= actor.respawn_tick
                {
                    Self::respawn_actor(self.runtime.durable.tick, actor, None);
                    if actor_uses_unlimited_ammo(actor) {
                        actor.slugthrower_magazine.reload_until_tick = 0;
                    }
                }
            }
        }
    }

    pub(super) fn repair_skirmisher_respawn_deadlines(
        _tick: u64,
        _tick_rate_hz: u32,
        actor: &mut ActorAuthorityState,
    ) {
        if !is_skirmisher_role(&actor.role)
            || !matches!(
                actor.life_state,
                AuthorityLifeState::Downed | AuthorityLifeState::Respawning
            )
        {
            return;
        }
        let Some(last_death_tick) = actor.stats.last_death.as_ref().map(|death| death.tick) else {
            return;
        };
        let no_loot_body_deadline = last_death_tick.saturating_add(CORPSE_BODY_NO_LOOT_TICKS);
        let max_body_deadline = last_death_tick.saturating_add(CORPSE_BODY_WITH_LOOT_TICKS);
        let max_respawn_deadline =
            max_body_deadline.saturating_add(Self::corpse_respawn_delay_ticks());
        if actor.life_state == AuthorityLifeState::Respawning {
            actor.body_vanish_tick = 0;
            if actor.respawn_tick == 0 || actor.respawn_tick > max_respawn_deadline {
                actor.respawn_tick =
                    no_loot_body_deadline.saturating_add(Self::corpse_respawn_delay_ticks());
            }
            return;
        }
        if actor.body_vanish_tick == 0 || actor.body_vanish_tick > max_body_deadline {
            actor.body_vanish_tick = no_loot_body_deadline;
        }
        // A visible corpse is still Downed, not already counting down a hidden
        // respawn. The Downed -> Respawning transition assigns this deadline.
        actor.respawn_tick = 0;
    }

    pub(super) fn should_hold_skirmisher_respawn_for_enemy(
        &self,
        actor: &ActorAuthorityState,
    ) -> bool {
        if !is_skirmisher_role(&actor.role) {
            return false;
        }
        let Some(_) = self.actor_faction_id(actor) else {
            return false;
        };

        let mut saw_enemy = false;
        let mut all_enemies_ready = true;
        for enemy in self.runtime.durable.actors.values() {
            if enemy.id == actor.id
                || !is_skirmisher_role(&enemy.role)
                || enemy.home_area_id != actor.home_area_id
            {
                continue;
            }
            if !matches!(
                self.faction_relationship(actor, enemy),
                FactionRelationship::Enemy
            ) {
                continue;
            }
            saw_enemy = true;
            match enemy.life_state {
                AuthorityLifeState::Alive => return false,
                AuthorityLifeState::Respawning
                    if enemy.respawn_tick > 0
                        && self.runtime.durable.tick >= enemy.respawn_tick => {}
                AuthorityLifeState::Downed | AuthorityLifeState::Respawning
                    if enemy.respawn_tick > 0 =>
                {
                    all_enemies_ready = false
                }
                _ => return false,
            }
        }

        saw_enemy && !all_enemies_ready
    }

    pub(super) fn should_hold_skirmisher_respawn_for_squad(
        &self,
        actor: &ActorAuthorityState,
    ) -> bool {
        if !is_skirmisher_role(&actor.role) {
            return false;
        }
        let actor_social_group = actor.faction.social_group.as_deref();
        let actor_faction_id = actor.faction.faction_id.as_deref();
        if actor_social_group.is_none() && actor_faction_id.is_none() {
            return false;
        }

        for squadmate in self.runtime.durable.actors.values() {
            if squadmate.id == actor.id
                || !is_skirmisher_role(&squadmate.role)
                || squadmate.home_area_id != actor.home_area_id
                || !same_respawn_squad(actor_social_group, actor_faction_id, squadmate)
            {
                continue;
            }
            match squadmate.life_state {
                AuthorityLifeState::Respawning
                    if squadmate.respawn_tick > 0
                        && self.runtime.durable.tick >= squadmate.respawn_tick => {}
                _ => return true,
            }
        }
        false
    }

    pub(super) fn skirmisher_respawn_squad_ready_wave(&self, actor: &ActorAuthorityState) -> bool {
        if !is_skirmisher_role(&actor.role)
            || actor.life_state != AuthorityLifeState::Respawning
            || actor.respawn_tick == 0
        {
            return false;
        }
        let actor_social_group = actor.faction.social_group.as_deref();
        let actor_faction_id = actor.faction.faction_id.as_deref();
        if actor_social_group.is_none() && actor_faction_id.is_none() {
            return false;
        }

        let mut saw_squadmate = false;
        let mut latest_respawn_tick = actor.respawn_tick;
        for squadmate in self.runtime.durable.actors.values() {
            if squadmate.id == actor.id
                || !is_skirmisher_role(&squadmate.role)
                || squadmate.home_area_id != actor.home_area_id
                || !same_respawn_squad(actor_social_group, actor_faction_id, squadmate)
            {
                continue;
            }
            saw_squadmate = true;
            if squadmate.life_state == AuthorityLifeState::Alive || squadmate.respawn_tick == 0 {
                return false;
            }
            latest_respawn_tick = latest_respawn_tick.max(squadmate.respawn_tick);
        }

        saw_squadmate && self.runtime.durable.tick >= latest_respawn_tick
    }

    pub(super) fn down_player_like_actor_or_kill(
        tick: u64,
        tick_rate_hz: u32,
        actor: &mut ActorAuthorityState,
    ) -> bool {
        if !Self::uses_player_like_revivable_state(actor) {
            Self::kill_actor_for_respawn(tick, tick_rate_hz, actor);
            return true;
        }
        let window_ticks = incap_window_ticks(tick_rate_hz);
        if actor.incap_window_start_tick == 0
            || tick.saturating_sub(actor.incap_window_start_tick) > window_ticks
        {
            actor.incap_window_start_tick = tick;
            actor.incap_count = 0;
        }
        actor.incap_count = actor.incap_count.saturating_add(1);
        if actor.incap_count >= INCAP_MAX_COUNT {
            Self::kill_actor_for_respawn(tick, tick_rate_hz, actor);
            return true;
        }
        let negative_health = 0_i32.saturating_sub(actor.vitals.health);
        let overkill_seconds = u64::try_from(negative_health)
            .unwrap_or(0)
            .max(INCAP_MIN_OVERKILL_SECONDS);
        let duration_seconds = INCAP_BASE_SECONDS.saturating_add(overkill_seconds);
        let duration_ticks = duration_seconds.saturating_mul(u64::from(tick_rate_hz.max(1)));
        Self::clear_actor_revivable_death_state(actor);
        Self::set_actor_life_state(actor, AuthorityLifeState::Downed);
        actor.vitals.health = 0;
        actor.body_vanish_tick = 0;
        actor.respawn_tick = 0;
        actor.incap_expires_tick = tick.saturating_add(duration_ticks.max(1));
        actor.incap_grace_until_tick = 0;
        actor.downed_action_drain_milli = 0;
        actor.downed_spirit_drain_milli = 0;
        false
    }

    fn revive_actor_from_incap(tick: u64, tick_rate_hz: u32, actor: &mut ActorAuthorityState) {
        Self::set_actor_life_state(actor, AuthorityLifeState::Alive);
        // Self-revive from incap: no medic, so the flat baseline percent applies.
        actor.vitals = AuthorityVitals {
            health: revived_vital_value(actor.max_vitals.health, REVIVE_RESTORE_VITALS_PERCENT),
            action: revived_vital_value(actor.max_vitals.action, REVIVE_RESTORE_VITALS_PERCENT),
            spirit: revived_vital_value(actor.max_vitals.spirit, REVIVE_RESTORE_VITALS_PERCENT),
        };
        Self::clear_actor_revivable_death_state(actor);
        actor.body_vanish_tick = 0;
        actor.respawn_tick = 0;
        actor.incap_expires_tick = 0;
        actor.incap_grace_until_tick = tick.saturating_add(Self::incap_grace_ticks(tick_rate_hz));
        Self::clear_actor_corpse_tracking(actor);
    }

    fn incap_grace_ticks(tick_rate_hz: u32) -> u64 {
        ms_to_ticks_round(INCAP_SELF_REVIVE_GRACE_MS, tick_rate_hz).max(1)
    }

    pub(super) fn kill_actor_for_respawn(
        tick: u64,
        _tick_rate_hz: u32,
        actor: &mut ActorAuthorityState,
    ) {
        actor.vitals = AuthorityVitals {
            health: 0,
            action: 0,
            spirit: 0,
        };
        actor.loot_rights_actor_id = Self::loot_rights_winner(actor);
        actor.corpse_exhausted_tick = None;
        actor.creature_corpse_harvested_tick = None;
        if !is_harvestable_creature_actor(actor) {
            actor.gaia_harvest_entitled_actor_ids.clear();
            actor.gaia_harvest_claimed_actor_ids.clear();
        }
        if Self::uses_player_like_revivable_state(actor) {
            Self::clear_actor_transient_respawn_state(actor);
            Self::set_actor_life_state(actor, AuthorityLifeState::Respawning);
            actor.body_vanish_tick = 0;
            actor.respawn_tick = tick.saturating_add(SESSION_RESPAWN_TICKS);
        } else if Self::uses_npc_corpse_respawn_timer(actor) {
            let loaded_rounds = actor.slugthrower_magazine.loaded_rounds;
            Self::clear_actor_transient_respawn_state(actor);
            actor.slugthrower_magazine.loaded_rounds = loaded_rounds;
            actor.slugthrower_magazine.reload_until_tick = 0;
            Self::set_actor_life_state(actor, AuthorityLifeState::Downed);
            Self::set_actor_corpse_deadlines(actor, tick, false);
        } else {
            Self::clear_actor_transient_respawn_state(actor);
            Self::set_actor_life_state(actor, AuthorityLifeState::Respawning);
            actor.body_vanish_tick = 0;
            actor.respawn_tick = tick.saturating_add(SESSION_RESPAWN_TICKS);
        }
    }

    pub(super) fn finalize_actor_corpse_after_death(&mut self, actor_id: &str, death_tick: u64) {
        let should_prepare_loot = self
            .runtime
            .durable
            .actors
            .get(actor_id)
            .is_some_and(|actor| {
                Self::uses_npc_corpse_respawn_timer(actor)
                    && actor.life_state == AuthorityLifeState::Downed
            });
        let has_loot = if should_prepare_loot {
            // House inventory the corpse carried (rarely anything, per owner ruling
            // that NPCs discard ammo) OR a fresh Diablo-style humanoid loot roll
            // deposited into the SAME corpse container. Either makes the body
            // lootable and switches it to the 5-minute lootable-body timer.
            let moved = self.move_actor_inventory_to_corpse_container(actor_id);
            let rolled = self.roll_and_deposit_humanoid_loot(actor_id, death_tick);
            moved || rolled
        } else {
            false
        };
        if self
            .runtime
            .durable
            .actors
            .get(actor_id)
            .is_some_and(is_harvestable_creature_actor)
        {
            self.freeze_gaia_harvest_entitlements(actor_id);
        }
        let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) else {
            return;
        };
        actor.loot_rights_actor_id = Self::loot_rights_winner(actor);
        if Self::uses_player_like_revivable_state(actor) {
            if actor.life_state == AuthorityLifeState::Downed {
                let deadline = death_tick.saturating_add(CORPSE_BODY_NO_LOOT_TICKS);
                actor.body_vanish_tick = deadline;
                actor.respawn_tick = deadline;
            }
            return;
        }
        if actor.life_state == AuthorityLifeState::Downed
            && Self::uses_npc_corpse_respawn_timer(actor)
        {
            Self::set_actor_corpse_deadlines(actor, death_tick, has_loot);
        }
    }

    pub(super) fn record_player_damage_for_loot_rights(
        target: &mut ActorAuthorityState,
        source_actor_id: &str,
        tick: u64,
        damage: u32,
    ) {
        if damage == 0 {
            return;
        }
        if let Some(entry) = target
            .player_damage_ledger
            .iter_mut()
            .find(|entry| entry.source_actor_id == source_actor_id)
        {
            entry.cumulative_damage = entry.cumulative_damage.saturating_add(damage);
            return;
        }
        target.player_damage_ledger.push(PlayerDamageLedgerEntry {
            source_actor_id: source_actor_id.to_owned(),
            cumulative_damage: damage,
            first_damage_tick: tick,
        });
    }

    fn loot_rights_winner(actor: &ActorAuthorityState) -> Option<String> {
        actor
            .player_damage_ledger
            .iter()
            .max_by(|left, right| {
                left.cumulative_damage
                    .cmp(&right.cumulative_damage)
                    .then_with(|| right.first_damage_tick.cmp(&left.first_damage_tick))
                    .then_with(|| right.source_actor_id.cmp(&left.source_actor_id))
            })
            .map(|entry| entry.source_actor_id.clone())
    }

    fn compute_gaia_harvest_entitlements(&self, target: &ActorAuthorityState) -> BTreeSet<String> {
        let contributors = target
            .player_damage_ledger
            .iter()
            .filter(|entry| {
                self.runtime
                    .durable
                    .actors
                    .get(&entry.source_actor_id)
                    .is_some_and(is_human_player_actor)
            })
            .map(|entry| (entry.source_actor_id.clone(), entry.cumulative_damage))
            .collect::<Vec<_>>();
        if contributors.is_empty() {
            return BTreeSet::new();
        }

        let mut parties = BTreeMap::<String, (u64, Vec<String>)>::new();
        for (actor_id, damage) in contributors {
            let party_key = self
                .actor_group_id(&actor_id)
                .map(|group_id| format!("group:{group_id:020}"))
                .unwrap_or_else(|| format!("solo:{actor_id}"));
            let party = parties.entry(party_key).or_insert_with(|| (0, Vec::new()));
            party.0 = party.0.saturating_add(u64::from(damage));
            party.1.push(actor_id);
        }
        parties
            .into_iter()
            .max_by(|left, right| {
                left.1
                     .0
                    .cmp(&right.1 .0)
                    .then_with(|| right.0.cmp(&left.0))
            })
            .map(|(_, (_, winners))| winners.into_iter().collect())
            .unwrap_or_default()
    }

    fn freeze_gaia_harvest_entitlements(&mut self, target_actor_id: &str) {
        let Some(target) = self.runtime.durable.actors.get(target_actor_id) else {
            return;
        };
        let entitled = self.compute_gaia_harvest_entitlements(target);
        if let Some(target) = self.runtime.durable.actors.get_mut(target_actor_id) {
            target.gaia_harvest_entitled_actor_ids = entitled;
            target.gaia_harvest_claimed_actor_ids.clear();
        }
    }

    /// Owner-ratified combat XP rule: on a defeat, every human player recorded in the
    /// target's loot-rights damage ledger receives the FULL combat XP for the kill — no
    /// proportional split, no group requirement (powerleveling is a feature). The XP
    /// magnitude reuses the ledger exactly: the total player damage the target sustained
    /// (sum of cumulative_damage). Each damager's track is routed by their currently
    /// equipped weapon (melee or bare hands -> Brawler tracks, ranged -> Marksman rifle).
    /// Attacking is universal, but progression is not: the routed profession must be
    /// learned at award time, matching universal hand-sampling and creature-harvest XP.
    /// NPC damage never enters the ledger, so only trained players are rewarded, and every
    /// eligible damager gets the full amount regardless of who landed the killing blow.
    pub(super) fn award_kill_combat_xp_to_damagers(&mut self, target_actor_id: &str) {
        let Some(target) = self.runtime.durable.actors.get(target_actor_id) else {
            return;
        };
        let total_damage: u64 = target
            .player_damage_ledger
            .iter()
            .map(|entry| u64::from(entry.cumulative_damage))
            .sum();
        if total_damage == 0 {
            return;
        }
        let damager_ids: Vec<String> = target
            .player_damage_ledger
            .iter()
            .map(|entry| entry.source_actor_id.clone())
            .collect();
        let gaia_entitled_actor_ids = is_harvestable_creature_actor(target)
            .then(|| target.gaia_harvest_entitled_actor_ids.clone());
        for damager_id in damager_ids {
            let Some(damager) = self.runtime.durable.actors.get(&damager_id) else {
                continue;
            };
            if gaia_entitled_actor_ids
                .as_ref()
                .is_some_and(|ids| !ids.contains(&damager_id))
            {
                continue;
            }
            if !is_human_player_actor(damager) {
                continue;
            }
            let melee_route = damager.equipped_weapon_id.is_none_or(is_melee_weapon_id);
            let profession = if melee_route {
                AuthorityProfessionKind::Brawler
            } else {
                AuthorityProfessionKind::Marksman
            };
            if !damager.professions.has(profession) {
                continue;
            }
            if melee_route {
                let _ = self.award_profession_tracks_xp(
                    &damager_id,
                    profession,
                    &["melee", "guard", "movement-speed", "attack-speed"],
                    total_damage,
                );
            } else {
                let _ =
                    self.award_profession_track_xp(&damager_id, profession, "rifle", total_damage);
            }
        }
    }

    fn set_actor_corpse_deadlines(
        actor: &mut ActorAuthorityState,
        death_tick: u64,
        has_loot: bool,
    ) {
        let body_ticks = if has_loot {
            CORPSE_BODY_WITH_LOOT_TICKS
        } else {
            CORPSE_BODY_NO_LOOT_TICKS
        };
        actor.body_vanish_tick = death_tick.saturating_add(body_ticks);
        actor.respawn_tick = 0;
    }

    fn corpse_respawn_delay_ticks() -> u64 {
        CORPSE_BODY_NO_LOOT_TICKS
    }

    fn move_actor_inventory_to_corpse_container(&mut self, actor_id: &str) -> bool {
        let corpse_container = format!("corpse:{actor_id}");
        self.runtime.durable.reservations.retain(|reservation| {
            reservation.actor != actor_id
                && !actor_owns_inventory_container(actor_id, &reservation.from)
                && reservation.from != corpse_container
        });
        let indices = self
            .runtime
            .durable
            .inventory
            .iter()
            .enumerate()
            .filter(|(_, row)| actor_owns_inventory_container(actor_id, &row.container))
            .filter(|(_, row)| row.quantity > 0)
            .filter(|(_, row)| ammo_item_name(row.item_id).is_none())
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        for index in indices {
            let next_stack_id = self
                .runtime
                .durable
                .inventory_stack_counters
                .entry(corpse_container.clone())
                .or_insert(0);
            let stack_id = *next_stack_id;
            *next_stack_id = next_stack_id.saturating_add(1);
            if let Some(row) = self.runtime.durable.inventory.get_mut(index) {
                row.stack_id = stack_id;
                row.container = corpse_container.clone();
                row.reserved = 0;
                row.available = row.quantity;
            }
        }
        self.runtime.durable.inventory.retain(|row| {
            row.quantity > 0
                && !(ammo_item_name(row.item_id).is_some()
                    && (actor_owns_inventory_container(actor_id, &row.container)
                        || row.container == corpse_container))
        });
        self.runtime
            .durable
            .inventory
            .iter()
            .any(|row| row.container == corpse_container && row.available > 0)
    }

    fn discard_corpse_inventory(&mut self, actor_id: &str) {
        let corpse_container = format!("corpse:{actor_id}");
        self.runtime
            .durable
            .reservations
            .retain(|reservation| reservation.from != corpse_container);
        self.runtime
            .durable
            .inventory
            .retain(|row| row.container != corpse_container);
    }

    fn clear_actor_corpse_tracking(actor: &mut ActorAuthorityState) {
        actor.player_damage_ledger.clear();
        actor.loot_rights_actor_id = None;
        actor.corpse_exhausted_tick = None;
        actor.creature_corpse_harvested_tick = None;
        actor.gaia_harvest_entitled_actor_ids.clear();
        actor.gaia_harvest_claimed_actor_ids.clear();
    }

    pub(super) fn set_actor_life_state(
        actor: &mut ActorAuthorityState,
        life_state: AuthorityLifeState,
    ) {
        if actor.life_state == life_state {
            return;
        }
        actor.life_state = life_state;
        actor.lifecycle_seq = actor.lifecycle_seq.saturating_add(1);
        if life_state != AuthorityLifeState::Alive {
            actor.posture = AuthorityActorPosture::Standing;
            actor.posture_until_tick = 0;
            actor.pending_resource_sample = None;
            actor.resource_sample_loop = None;
            actor.move_intent = None;
            actor.combat_queue = AbilityQueue::default();
            actor.cranking_extractor_id = None;
            actor.craft_session = None;
        }
    }

    pub(super) fn uses_npc_corpse_respawn_timer(actor: &ActorAuthorityState) -> bool {
        !is_player_like_role(&actor.role) && !actor.id.starts_with("game-ws-")
    }

    pub(super) fn uses_player_like_revivable_state(actor: &ActorAuthorityState) -> bool {
        is_player_like_role(&actor.role)
    }

    pub(super) fn clear_actor_revivable_death_state(actor: &mut ActorAuthorityState) {
        actor.bleed_stacks.clear();
        actor.sprint_action_drain_milli = 0;
        actor.sprint_recovery_locked = false;
        actor.sprint_recovery_regen_carry = 0;
        actor.sprint_regen_block_until_tick = 0;
        actor.downed_action_drain_milli = 0;
        actor.downed_spirit_drain_milli = 0;
        actor.passive_regen_milli = AuthorityVitals::zero();
        actor.weather_damage_accumulated_milli = 0;
        actor.posture = AuthorityActorPosture::Standing;
        actor.posture_until_tick = 0;
        actor.pending_resource_sample = None;
        actor.resource_sample_loop = None;
        actor.sleep = SleepAuthorityState::default();
        actor.suppression = SuppressionAuthorityState::default();
        if let Some(ai) = actor.ai.as_mut() {
            reset_ai_transient_state(ai);
        }
        actor.next_fire_tick = 0;
        actor.next_move_tick = 0;
        actor.move_intent = None;
        actor.combat_queue = AbilityQueue::default();
        actor.cranking_extractor_id = None;
        actor.craft_session = None;
        actor.respawn_return.clear();
        actor.incap_expires_tick = 0;
        actor.incap_grace_until_tick = 0;
    }

    pub(super) fn revive_actor_from_corpse(actor: &mut ActorAuthorityState, vitals_percent: i32) {
        Self::set_actor_life_state(actor, AuthorityLifeState::Alive);
        // Medic trauma track sets revived vitals 25% -> 60% (replaces the flat hardcode).
        actor.vitals = AuthorityVitals {
            health: revived_vital_value(actor.max_vitals.health, vitals_percent),
            action: revived_vital_value(actor.max_vitals.action, vitals_percent),
            spirit: revived_vital_value(actor.max_vitals.spirit, vitals_percent),
        };
        Self::clear_actor_revivable_death_state(actor);
        actor.body_vanish_tick = 0;
        actor.respawn_tick = 0;
        Self::clear_actor_corpse_tracking(actor);
    }

    pub(super) fn clear_actor_transient_respawn_state(actor: &mut ActorAuthorityState) {
        actor.bleed_stacks.clear();
        actor.consumable_effects.clear();
        actor.sprint_action_drain_milli = 0;
        actor.sprint_recovery_locked = false;
        actor.sprint_recovery_regen_carry = 0;
        actor.sprint_regen_block_until_tick = 0;
        actor.downed_action_drain_milli = 0;
        actor.downed_spirit_drain_milli = 0;
        actor.passive_regen_milli = AuthorityVitals::zero();
        actor.weather_damage_accumulated_milli = 0;
        actor.posture = AuthorityActorPosture::Standing;
        actor.posture_until_tick = 0;
        actor.pending_resource_sample = None;
        actor.resource_sample_loop = None;
        actor.sleep = SleepAuthorityState::default();
        actor.suppression = SuppressionAuthorityState::default();
        if let Some(ai) = actor.ai.as_mut() {
            reset_ai_transient_state(ai);
        }
        actor.next_fire_tick = 0;
        actor.slugthrower_magazine = slugthrower_full_magazine_state();
        actor.next_move_tick = 0;
        actor.move_intent = None;
        actor.combat_queue = AbilityQueue::default();
        actor.cranking_extractor_id = None;
        actor.craft_session = None;
        actor.clone_sickness_ticks = 0;
        actor.respawn_return.clear();
        actor.incap_expires_tick = 0;
        actor.incap_count = 0;
        actor.incap_window_start_tick = 0;
        actor.incap_grace_until_tick = 0;
    }

    pub(super) fn respawn_actor(
        tick: u64,
        actor: &mut ActorAuthorityState,
        clone_facility: Option<&CloneFacilityAuthorityState>,
    ) {
        Self::set_actor_life_state(actor, AuthorityLifeState::Alive);
        actor.vitals = actor.max_vitals;
        Self::clear_actor_transient_respawn_state(actor);
        actor.body_vanish_tick = 0;
        actor.respawn_tick = 0;
        Self::clear_actor_corpse_tracking(actor);
        if is_skirmisher_role(&actor.role) {
            refresh_actor_presentation(actor, tick);
            Self::finish_respawn_return_at_home(actor);
            actor.next_route_tick = tick.saturating_add(NPC_ROUTE_STEP_INTERVAL_TICKS);
            return;
        }
        if let Some(facility) =
            clone_facility.filter(|_| Self::uses_player_like_revivable_state(actor))
        {
            actor.area_id = facility.area_id.clone();
            actor.cell = facility.respawn_cell;
            actor.position = AuthorityPosition::from_cell(facility.respawn_cell);
            actor.direction = facility.respawn_facing.clone();
            actor.route.clear();
            actor.route_index = 0;
            actor.clone_sickness_ticks = facility.sickness_duration_ticks;
            actor.respawn_return = Vec::new();
            actor.next_route_tick = tick.saturating_add(NPC_ROUTE_STEP_INTERVAL_TICKS);
        } else {
            Self::finish_respawn_return_at_home(actor);
            actor.next_route_tick = tick.saturating_add(NPC_ROUTE_STEP_INTERVAL_TICKS);
        }
    }

    pub(super) fn complete_respawn_return(actor: &mut ActorAuthorityState) {
        if Self::uses_ai_respawn_rejoin(actor) {
            Self::release_respawn_return_to_ai(actor);
        } else {
            Self::finish_respawn_return_at_home(actor);
        }
    }

    pub(super) fn release_respawn_return_to_ai(actor: &mut ActorAuthorityState) {
        actor.route.clear();
        actor.route_index = 0;
        actor.respawn_return.clear();
        if let Some(ai) = actor.ai.as_mut() {
            reset_ai_transient_state(ai);
        }
    }

    pub(super) fn finish_respawn_return_at_home(actor: &mut ActorAuthorityState) {
        actor.area_id = actor.home_area_id.clone();
        actor.cell = actor.home_cell;
        actor.position = AuthorityPosition::from_cell(actor.home_cell);
        actor.direction = actor.home_direction.clone();
        actor.route = actor.home_route.clone();
        actor.route_index = route_index_after_cell(&actor.route, actor.cell);
        actor.respawn_return.clear();
    }

    pub(super) fn uses_ai_respawn_rejoin(actor: &ActorAuthorityState) -> bool {
        actor.home_route.is_empty()
            && matches!(actor.ai, Some(AuthorityAiState::PassiveCreature(_)))
    }
}

fn revived_vital_value(max_vital: i32, percent: i32) -> i32 {
    max_vital.saturating_mul(percent.clamp(0, 100)) / 100
}

fn weather_hazard_can_damage_actor(actor: &ActorAuthorityState) -> bool {
    // Procedural humanoid encounters are weather-proof combatants; storms do
    // not advance or replace their encounter lifecycle.
    if actor.spawn_zone_id.is_some() && is_skirmisher_role(&actor.role) {
        return false;
    }
    is_player_like_role(&actor.role)
        || actor_uses_combat_tactics(actor)
        || is_pressure_reactive_actor(actor)
        || is_creature_body_actor(actor)
}

fn actor_inside_weather_radius(
    actor: &ActorAuthorityState,
    hazard: &AuthorityWeatherHazard,
    radius_sq: i64,
) -> bool {
    let dx = i64::from(actor.position.x) - i64::from(hazard.center_x_milli);
    let dy = i64::from(actor.position.y) - i64::from(hazard.center_y_milli);
    dx.saturating_mul(dx).saturating_add(dy.saturating_mul(dy)) <= radius_sq
}

fn actor_inside_weather_shelter(
    actor: &ActorAuthorityState,
    hazard: &AuthorityWeatherHazard,
) -> bool {
    hazard.shelters.iter().any(|shelter| {
        actor.position.x >= shelter.min_x_milli
            && actor.position.x <= shelter.max_x_milli
            && actor.position.y >= shelter.min_y_milli
            && actor.position.y <= shelter.max_y_milli
    })
}
