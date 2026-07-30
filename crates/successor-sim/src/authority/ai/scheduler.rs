use super::*;

const ROGUE_ALERT_RADIUS_MILLI_CELLS: i32 = 14 * MILLI_CELLS_PER_CELL;
const ROGUE_ALERT_DECAY_RADIUS_MILLI_CELLS: i32 = 20 * MILLI_CELLS_PER_CELL;
const ROGUE_SOCIAL_ASSIST_RADIUS_MILLI_CELLS: i32 = 24 * MILLI_CELLS_PER_CELL;
const ROGUE_ALERT_DECAY_MS: u64 = 8_000;

impl SliceAuthorityState {
    pub(in crate::authority) fn skirmisher_tactical_state_for_tick(
        &mut self,
    ) -> (SkirmisherTacticalState, bool) {
        let actor_count = self.runtime.durable.actors.len();
        let combat_actor_count = self
            .runtime
            .durable
            .actors
            .values()
            .filter(|actor| {
                actor.life_state == AuthorityLifeState::Alive
                    && actor.sleep.remaining_ticks == 0
                    && actor_requires_skirmisher_tactical_apparatus(actor)
            })
            .count();
        if combat_actor_count == 0 {
            self.runtime.cached_skirmisher_tactical_state = None;
            return (
                SkirmisherTacticalState {
                    by_actor: BTreeMap::new(),
                    reservations: self.skirmisher_reservations(),
                    squads_debug: Vec::new(),
                },
                false,
            );
        }
        if let Some(cached) = &self.runtime.cached_skirmisher_tactical_state {
            let cache_age = self.runtime.durable.tick.saturating_sub(cached.tick);
            if cache_age < SKIRMISHER_TACTICAL_STATE_REFRESH_TICKS
                && cached.actor_count == actor_count
                && cached.combat_actor_count == combat_actor_count
            {
                let mut state = cached.state.clone();
                state.reservations = self.skirmisher_reservations();
                return (state, true);
            }
        }

        let state = self.build_skirmisher_tactical_state();
        self.runtime.cached_skirmisher_tactical_state = Some(CachedSkirmisherTacticalState {
            tick: self.runtime.durable.tick,
            actor_count,
            combat_actor_count,
            state: state.clone(),
        });
        (state, false)
    }

    pub(in crate::authority) fn tick_ai_attitudes(&mut self) {
        let players = self
            .runtime
            .durable
            .actors
            .values()
            .filter(|actor| {
                is_human_player_actor(actor)
                    && actor.life_state == AuthorityLifeState::Alive
                    && actor.sleep.remaining_ticks == 0
            })
            .map(|actor| (actor.id.clone(), actor.area_id.clone(), actor.position))
            .collect::<Vec<_>>();
        if players.is_empty() {
            return;
        }
        let decay_ticks = ms_to_ticks_round(
            ROGUE_ALERT_DECAY_MS,
            self.runtime.durable.world.tick_rate_hz,
        )
        .max(1);
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
            if actor.life_state != AuthorityLifeState::Alive
                || !actor_uses_passive_rogue_attitude(actor)
            {
                continue;
            }
            let Some(AuthorityAiState::Skirmisher(ai)) = actor.ai.as_ref() else {
                continue;
            };
            if ai.attitude == NpcAiAttitude::Hostile {
                continue;
            }
            let nearest_player = players
                .iter()
                .filter(|(_, area_id, _)| area_id == &actor.area_id)
                .map(|(player_id, _, position)| {
                    (
                        player_id.as_str(),
                        *position,
                        position_distance_milli(actor.position, *position),
                    )
                })
                .min_by(|left, right| left.2.cmp(&right.2).then(left.0.cmp(right.0)));
            let next_alert_until_tick = if nearest_player
                .is_some_and(|(_, _, distance)| distance <= ROGUE_ALERT_DECAY_RADIUS_MILLI_CELLS)
            {
                self.runtime.durable.tick.saturating_add(decay_ticks)
            } else {
                ai.alert_until_tick
            };
            let next_attitude = match nearest_player {
                Some((_, _, distance)) if distance <= ROGUE_ALERT_RADIUS_MILLI_CELLS => {
                    NpcAiAttitude::Alerted
                }
                _ if ai.attitude == NpcAiAttitude::Alerted
                    && self.runtime.durable.tick >= next_alert_until_tick =>
                {
                    NpcAiAttitude::Passive
                }
                _ => ai.attitude,
            };
            let face_direction = nearest_player
                .filter(|(_, _, distance)| *distance <= ROGUE_ALERT_RADIUS_MILLI_CELLS)
                .map(|(_, position, _)| {
                    direction_for_milli_delta(
                        position.x.saturating_sub(actor.position.x),
                        position.y.saturating_sub(actor.position.y),
                    )
                    .to_owned()
                });
            if let Some(actor) = self.runtime.durable.actors.get_mut(&actor_id) {
                if let Some(AuthorityAiState::Skirmisher(ai)) = actor.ai.as_mut() {
                    ai.alert_until_tick = next_alert_until_tick;
                    ai.attitude = next_attitude;
                    if next_attitude != NpcAiAttitude::Hostile {
                        hold_skirmisher_passive(ai);
                        actor.engagement_target_id = None;
                        actor.combat_queue = AbilityQueue::default();
                    }
                }
                if let Some(direction) = face_direction {
                    actor.direction = direction;
                }
            }
        }
    }

    pub(in crate::authority) fn provoke_rogue_social_assist(
        &mut self,
        target_actor_id: &str,
        attacker_actor_id: &str,
    ) {
        let Some(target) = self.runtime.durable.actors.get(target_actor_id).cloned() else {
            return;
        };
        if !actor_uses_passive_rogue_attitude(&target) {
            return;
        }
        let Some(attacker) = self.runtime.durable.actors.get(attacker_actor_id).cloned() else {
            return;
        };
        if attacker.life_state != AuthorityLifeState::Alive || attacker.area_id != target.area_id {
            return;
        }
        let target_social_group = target.faction.social_group.clone();
        let assist_ids = self
            .runtime
            .durable
            .actors
            .values()
            .filter(|candidate| {
                candidate.life_state == AuthorityLifeState::Alive
                    && candidate.area_id == target.area_id
                    && actor_uses_passive_rogue_attitude(candidate)
                    && (candidate.id == target.id
                        || target_social_group.as_deref().is_some_and(|group| {
                            candidate.faction.social_group.as_deref() == Some(group)
                                && position_distance_milli(candidate.position, target.position)
                                    <= ROGUE_SOCIAL_ASSIST_RADIUS_MILLI_CELLS
                        }))
            })
            .map(|candidate| candidate.id.clone())
            .collect::<Vec<_>>();
        for assist_actor_id in assist_ids {
            let can_attack = assist_actor_id == target.id
                || self
                    .runtime
                    .durable
                    .actors
                    .get(&assist_actor_id)
                    .is_some_and(|actor| self.can_actor_attack(actor, &attacker));
            if !can_attack {
                continue;
            }
            if let Some(actor) = self.runtime.durable.actors.get_mut(&assist_actor_id) {
                if let Some(AuthorityAiState::Skirmisher(ai)) = actor.ai.as_mut() {
                    ai.attitude = NpcAiAttitude::Hostile;
                    ai.alert_until_tick = 0;
                }
                set_skirmisher_engagement_target(actor, attacker_actor_id);
                actor.peace_requested = false;
            }
            bump_actor_combat_until(self, &assist_actor_id, self.runtime.durable.tick);
        }
    }

    pub(in crate::authority) fn tick_ai_actors(&mut self) {
        self.tick_ai_attitudes();
        let tactical_state_timer = AuthorityTimer::start();
        let (skirmisher_tactics, tactical_state_reused) = self.skirmisher_tactical_state_for_tick();
        self.runtime.current_ai_tactical_state_us = self
            .runtime
            .current_ai_tactical_state_us
            .saturating_add(tactical_state_timer.elapsed_us());
        if tactical_state_reused {
            self.runtime.current_ai_tactical_state_reused = self
                .runtime
                .current_ai_tactical_state_reused
                .saturating_add(1);
        } else {
            self.runtime.current_ai_tactical_state_rebuilt = self
                .runtime
                .current_ai_tactical_state_rebuilt
                .saturating_add(1);
        }
        let mut skirmisher_reservations = skirmisher_tactics.reservations.clone();
        self.runtime.ai_debug = SliceAuthorityAiDebugSnapshot::with_squads(
            self.runtime.durable.tick,
            skirmisher_tactics.squads_debug.clone(),
        );
        let actor_ids = self
            .runtime
            .durable
            .actors
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for actor_id in actor_ids {
            let Some(actor) = self.runtime.durable.actors.get(&actor_id).cloned() else {
                continue;
            };
            let Some(mut ai) = actor.ai.clone() else {
                continue;
            };
            if actor.id.starts_with("game-ws-")
                || (actor.route.len() >= 2 && !actor_uses_combat_tactics(&actor))
                || !actor.respawn_return.is_empty()
                || self.actor_has_active_npc_job(&actor.id)
                || actor.life_state != AuthorityLifeState::Alive
                || actor.sleep.remaining_ticks > 0
            {
                self.runtime.current_ai_skipped = self.runtime.current_ai_skipped.saturating_add(1);
                continue;
            }

            let actor_ai_timer = AuthorityTimer::start();
            let updated = match &mut ai {
                AuthorityAiState::PassiveCreature(creature) => {
                    let updated = self.advance_passive_creature_ai(&actor_id, &actor, creature);
                    self.runtime.current_ai_passive_creature_us = self
                        .runtime
                        .current_ai_passive_creature_us
                        .saturating_add(actor_ai_timer.elapsed_us());
                    updated
                }
                AuthorityAiState::Skirmisher(skirmisher) => {
                    let updated = self.advance_skirmisher_ai(
                        &actor_id,
                        &actor,
                        skirmisher,
                        skirmisher_tactics.by_actor.get(&actor_id),
                        &skirmisher_reservations,
                    );
                    self.runtime.current_ai_skirmisher_us = self
                        .runtime
                        .current_ai_skirmisher_us
                        .saturating_add(actor_ai_timer.elapsed_us());
                    updated
                }
            };
            if updated {
                self.runtime.current_ai_updates = self.runtime.current_ai_updates.saturating_add(1);
            } else {
                self.runtime.current_ai_skipped = self.runtime.current_ai_skipped.saturating_add(1);
            }
            let skirmisher_claim = match &ai {
                AuthorityAiState::Skirmisher(skirmisher) => {
                    Some(skirmisher.cover.or(skirmisher.target))
                }
                _ => None,
            };
            let mut next_ai = ai;
            if let Some(actor) = self.runtime.durable.actors.get(&actor_id) {
                preserve_skirmisher_live_move_memory(&mut next_ai, actor.ai.as_ref());
            }
            if let Some(actor) = self.runtime.durable.actors.get_mut(&actor_id) {
                actor.ai = Some(next_ai);
            }
            self.face_ai_actor_toward_engagement_target(&actor_id);
            if let Some(claim) = skirmisher_claim {
                self.update_combat_position_claims(&actor_id, claim, &mut skirmisher_reservations);
            }
        }
        let recorded_actor_ids = self
            .runtime
            .ai_debug
            .actors
            .iter()
            .map(|actor| actor.actor_id.clone())
            .collect::<BTreeSet<_>>();
        let passive_debug_actors = self
            .runtime
            .durable
            .actors
            .values()
            .filter(|actor| {
                actor.life_state == AuthorityLifeState::Alive
                    && actor.sleep.remaining_ticks == 0
                    && actor_requires_skirmisher_tactical_apparatus(actor)
                    && !recorded_actor_ids.contains(&actor.id)
            })
            .cloned()
            .collect::<Vec<_>>();
        for actor in passive_debug_actors {
            if let Some(AuthorityAiState::Skirmisher(ai)) = actor.ai.as_ref() {
                self.record_skirmisher_debug(
                    &actor,
                    ai,
                    skirmisher_profile_for_actor(&actor, ai.seed),
                    skirmisher_tactics.by_actor.get(&actor.id),
                    None,
                    "scheduled_wait",
                    Vec::new(),
                );
            }
        }
    }

    pub(in crate::authority) fn last_combat_shot_tick(&self) -> Option<u64> {
        self.runtime
            .durable
            .actors
            .values()
            .filter(|actor| actor.life_state == AuthorityLifeState::Alive)
            .filter_map(|actor| actor.last_shot_tick)
            .max()
    }

    pub(in crate::authority) fn combat_pressure_fire_due(&self) -> bool {
        match self.last_combat_shot_tick() {
            Some(last_shot_tick) => {
                self.runtime.durable.tick.saturating_sub(last_shot_tick)
                    >= SKIRMISHER_PRESSURE_FIRE_GAP_TICKS
            }
            None => true,
        }
    }
}
