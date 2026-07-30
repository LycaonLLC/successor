use super::*;

impl SliceAuthorityState {
    pub(in crate::authority) fn advance_passive_creature_locomotion_tick(
        &mut self,
        actor_id: &str,
        actor: &ActorAuthorityState,
        ai: &PassiveCreatureAiState,
    ) -> bool {
        if ai.mode == PassiveCreatureMode::Idle {
            return false;
        }
        let Some(target) = ai.target else {
            return false;
        };
        if position_distance_milli(actor.position, target) <= 240 {
            return false;
        }
        let speed = match ai.mode {
            PassiveCreatureMode::Flee => PASSIVE_CREATURE_FLEE_SPEED_MILLI_CELLS_PER_SECOND,
            PassiveCreatureMode::Engage => CREATURE_ENGAGE_SPEED_MILLI_CELLS_PER_SECOND,
            PassiveCreatureMode::Roam | PassiveCreatureMode::Idle => {
                PASSIVE_CREATURE_ROAM_SPEED_MILLI_CELLS_PER_SECOND
            }
        };
        let speed = scaled_milli(speed, movement_speed_multiplier_milli_for_actor(actor));
        self.move_passive_creature_toward_position(
            actor_id,
            target,
            distance_for_ticks(
                speed,
                AI_UPDATE_CADENCE_TICKS,
                self.runtime.durable.world.tick_rate_hz,
            ),
            ai.mode,
            ai.seed,
        )
    }

    pub(in crate::authority) fn advance_passive_creature_ai(
        &mut self,
        actor_id: &str,
        actor: &ActorAuthorityState,
        ai: &mut PassiveCreatureAiState,
    ) -> bool {
        // Species-gated danger brain first: may flip into Engage, keep chase, or escape.
        if self.tick_creature_danger_ai(actor_id, actor, ai) {
            // Engage path already advanced locomotion / strike this decision.
            return true;
        }

        if ai.mode == PassiveCreatureMode::Flee && self.runtime.durable.tick >= ai.panic_until_tick
        {
            ai.mode = PassiveCreatureMode::Roam;
            ai.threat = None;
            ai.threat_actor_id = None;
            ai.target = None;
            ai.chase_until_tick = 0;
            ai.next_decision_tick = self.runtime.durable.tick;
        }
        let cadence = if ai.mode == PassiveCreatureMode::Idle {
            PASSIVE_CREATURE_IDLE_CADENCE_TICKS
        } else {
            AI_DECISION_CADENCE_TICKS
        };
        let Some(elapsed_ticks) = scheduled_ai_elapsed_ticks(
            ai.seed,
            self.runtime.durable.tick,
            cadence,
            101,
            &mut ai.next_update_tick,
            &mut ai.last_update_tick,
        ) else {
            return self.advance_passive_creature_locomotion_tick(actor_id, actor, ai);
        };
        let elapsed_ticks = elapsed_ticks.clamp(1, AI_UPDATE_CADENCE_TICKS);
        let target_reached = ai
            .target
            .is_some_and(|target| position_distance_milli(actor.position, target) <= 240);
        let decision_due = self.runtime.durable.tick >= ai.next_decision_tick;
        let should_choose_target = ai.target.is_none()
            || target_reached
            || (decision_due && ai.mode != PassiveCreatureMode::Roam);
        if should_choose_target {
            self.choose_passive_creature_target(actor, ai);
        }
        if ai.mode == PassiveCreatureMode::Idle {
            return false;
        }
        let Some(target) = ai.target else {
            return false;
        };
        let speed = match ai.mode {
            PassiveCreatureMode::Flee => PASSIVE_CREATURE_FLEE_SPEED_MILLI_CELLS_PER_SECOND,
            PassiveCreatureMode::Engage => CREATURE_ENGAGE_SPEED_MILLI_CELLS_PER_SECOND,
            PassiveCreatureMode::Roam | PassiveCreatureMode::Idle => {
                PASSIVE_CREATURE_ROAM_SPEED_MILLI_CELLS_PER_SECOND
            }
        };
        let speed = scaled_milli(speed, movement_speed_multiplier_milli_for_actor(actor));
        self.move_passive_creature_toward_position(
            actor_id,
            target,
            distance_for_ticks(
                speed,
                elapsed_ticks,
                self.runtime.durable.world.tick_rate_hz,
            ),
            ai.mode,
            ai.seed,
        )
    }

    /// Returns true when the creature spent this tick in the engage brain
    /// (chase/strike/escape), so the calm roam path should not also move it.
    fn tick_creature_danger_ai(
        &mut self,
        actor_id: &str,
        actor: &ActorAuthorityState,
        ai: &mut PassiveCreatureAiState,
    ) -> bool {
        if !creature_species_can_engage(actor) {
            // Non-danger species never hold engage state.
            if ai.mode == PassiveCreatureMode::Engage || ai.threat_actor_id.is_some() {
                self.clear_creature_engagement(actor_id, ai);
            }
            return false;
        }

        // Proactive acquisition for Bellback while calm.
        if ai.mode != PassiveCreatureMode::Engage
            && ai.mode != PassiveCreatureMode::Flee
            && creature_species_is_proactive(actor)
        {
            if let Some(target) =
                self.nearest_creature_hostile_player(actor, CREATURE_DETECT_RADIUS_MILLI_CELLS)
            {
                self.begin_creature_engagement(actor_id, ai, &target);
            }
        }

        if ai.mode != PassiveCreatureMode::Engage {
            return false;
        }

        let home = AuthorityPosition::from_cell(actor.home_cell);
        let leash_broken =
            position_distance_milli(actor.position, home) > CREATURE_LEASH_RADIUS_MILLI_CELLS;
        let chase_expired =
            ai.chase_until_tick > 0 && self.runtime.durable.tick >= ai.chase_until_tick;

        let focused = ai
            .threat_actor_id
            .as_ref()
            .and_then(|id| self.runtime.durable.actors.get(id).cloned())
            .filter(|target| self.creature_target_is_valid(actor, target));

        let focused = match focused {
            Some(target) => {
                let gap = position_distance_milli(actor.position, target.position);
                if gap > CREATURE_DISENGAGE_RADIUS_MILLI_CELLS {
                    None
                } else {
                    Some(target)
                }
            }
            None => None,
        };

        if leash_broken || chase_expired || focused.is_none() {
            // Escape / disengage: prepared players can break contact.
            self.start_creature_escape(actor_id, actor, ai, focused.as_ref().map(|t| t.position));
            // Still run one flee locomotion step this tick.
            let _ = self.advance_passive_creature_locomotion_tick(actor_id, actor, ai);
            return true;
        }

        let target = focused.expect("engage target present");
        ai.threat = Some(target.position);
        ai.threat_actor_id = Some(target.id.clone());
        if let Some(live) = self.runtime.durable.actors.get_mut(actor_id) {
            live.engagement_target_id = Some(target.id.clone());
        }

        let gap = position_distance_milli(actor.position, target.position);
        // Contact holds the chase clock. Sprint/leash/disengage still break out;
        // standing in claws must not free-win when CREATURE_CHASE_TIMEOUT_MS elapses.
        if gap <= CREATURE_ATTACK_RANGE_MILLI_CELLS {
            let chase_ticks = ms_to_ticks_round(
                CREATURE_CHASE_TIMEOUT_MS,
                self.runtime.durable.world.tick_rate_hz,
            )
            .max(1);
            ai.chase_until_tick = self.runtime.durable.tick.saturating_add(chase_ticks);
        }
        let mut acted = false;
        if gap <= CREATURE_ATTACK_RANGE_MILLI_CELLS {
            acted = self.strike_creature_melee_if_ready(actor_id, actor, &target, ai);
            ai.target = Some(target.position);
        } else {
            ai.target = Some(target.position);
        }

        // Decision cadence while engaged stays tight so chase feels live.
        let cadence = AI_UPDATE_CADENCE_TICKS;
        let Some(elapsed_ticks) = scheduled_ai_elapsed_ticks(
            ai.seed,
            self.runtime.durable.tick,
            cadence,
            103,
            &mut ai.next_update_tick,
            &mut ai.last_update_tick,
        ) else {
            let moved = self.advance_passive_creature_locomotion_tick(actor_id, actor, ai);
            return acted || moved;
        };
        let elapsed_ticks = elapsed_ticks.clamp(1, AI_UPDATE_CADENCE_TICKS);
        if gap > CREATURE_ATTACK_RANGE_MILLI_CELLS {
            let speed = scaled_milli(
                CREATURE_ENGAGE_SPEED_MILLI_CELLS_PER_SECOND,
                movement_speed_multiplier_milli_for_actor(actor),
            );
            let moved = self.move_passive_creature_toward_position(
                actor_id,
                target.position,
                distance_for_ticks(
                    speed,
                    elapsed_ticks,
                    self.runtime.durable.world.tick_rate_hz,
                ),
                PassiveCreatureMode::Engage,
                ai.seed,
            );
            acted = acted || moved;
        }
        ai.next_decision_tick = self
            .runtime
            .durable
            .tick
            .saturating_add(AI_DECISION_CADENCE_TICKS);
        acted
    }

    fn begin_creature_engagement(
        &mut self,
        actor_id: &str,
        ai: &mut PassiveCreatureAiState,
        target: &ActorAuthorityState,
    ) {
        let chase_ticks = ms_to_ticks_round(
            CREATURE_CHASE_TIMEOUT_MS,
            self.runtime.durable.world.tick_rate_hz,
        )
        .max(1);
        ai.mode = PassiveCreatureMode::Engage;
        ai.threat_actor_id = Some(target.id.clone());
        ai.threat = Some(target.position);
        ai.target = Some(target.position);
        ai.panic_until_tick = 0;
        ai.chase_until_tick = self.runtime.durable.tick.saturating_add(chase_ticks);
        ai.next_decision_tick = self.runtime.durable.tick;
        ai.next_update_tick = self.runtime.durable.tick;
        ai.last_update_tick = self.runtime.durable.tick;
        if let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) {
            actor.engagement_target_id = Some(target.id.clone());
            actor.peace_requested = false;
        }
        bump_actor_combat_until(self, actor_id, self.runtime.durable.tick);
    }

    fn clear_creature_engagement(&mut self, actor_id: &str, ai: &mut PassiveCreatureAiState) {
        ai.mode = PassiveCreatureMode::Roam;
        ai.threat_actor_id = None;
        ai.threat = None;
        ai.target = None;
        ai.chase_until_tick = 0;
        ai.next_attack_tick = 0;
        ai.next_decision_tick = self.runtime.durable.tick;
        if let Some(actor) = self.runtime.durable.actors.get_mut(actor_id) {
            actor.engagement_target_id = None;
        }
    }

    fn start_creature_escape(
        &mut self,
        actor_id: &str,
        actor: &ActorAuthorityState,
        ai: &mut PassiveCreatureAiState,
        threat_pos: Option<AuthorityPosition>,
    ) {
        let threat = threat_pos
            .or(ai.threat)
            .unwrap_or_else(|| AuthorityPosition::from_cell(actor.home_cell));
        let panic_ticks = ms_to_ticks_round(
            CREATURE_CHASE_TIMEOUT_MS / 2,
            self.runtime.durable.world.tick_rate_hz,
        )
        .max(1);
        ai.mode = PassiveCreatureMode::Flee;
        ai.threat_actor_id = None;
        ai.threat = Some(threat);
        ai.target = None;
        ai.chase_until_tick = 0;
        ai.next_attack_tick = 0;
        ai.panic_until_tick = self.runtime.durable.tick.saturating_add(panic_ticks);
        ai.next_decision_tick = self.runtime.durable.tick;
        ai.next_update_tick = self.runtime.durable.tick;
        if let Some(live) = self.runtime.durable.actors.get_mut(actor_id) {
            live.engagement_target_id = None;
        }
    }

    pub(in crate::authority) fn creature_target_is_valid(
        &self,
        actor: &ActorAuthorityState,
        target: &ActorAuthorityState,
    ) -> bool {
        if target.id == actor.id {
            return false;
        }
        if target.area_id != actor.area_id {
            return false;
        }
        if target.life_state != AuthorityLifeState::Alive {
            return false;
        }
        if target.link_dead {
            return false;
        }
        if target.sleep.remaining_ticks > 0 {
            return false;
        }
        if !is_human_player_actor(target) {
            return false;
        }
        // Engagement itself is the attack-permission source for Gaia danger.
        true
    }

    /// Deterministic nearest living hostile player inside `radius_milli`.
    /// Tie-break: shorter distance, then lexicographic actor id.
    pub(in crate::authority) fn nearest_creature_hostile_player(
        &self,
        actor: &ActorAuthorityState,
        radius_milli: i32,
    ) -> Option<ActorAuthorityState> {
        self.runtime
            .durable
            .actors
            .values()
            .filter(|candidate| self.creature_target_is_valid(actor, candidate))
            .filter(|candidate| {
                position_distance_milli(actor.position, candidate.position) <= radius_milli
            })
            .min_by(|left, right| {
                position_distance_milli(actor.position, left.position)
                    .cmp(&position_distance_milli(actor.position, right.position))
                    .then_with(|| left.id.cmp(&right.id))
            })
            .cloned()
    }

    /// Player damage / combat contact may provoke retaliatory wildlife.
    pub(in crate::authority) fn provoke_creature_retaliation(
        &mut self,
        target_actor_id: &str,
        attacker_actor_id: &str,
    ) {
        let Some(target) = self.runtime.durable.actors.get(target_actor_id).cloned() else {
            return;
        };
        if !is_passive_creature_actor(&target) || !creature_species_is_retaliatory(&target) {
            return;
        }
        if target.life_state != AuthorityLifeState::Alive || target.sleep.remaining_ticks > 0 {
            return;
        }
        let Some(attacker) = self.runtime.durable.actors.get(attacker_actor_id).cloned() else {
            return;
        };
        if !self.creature_target_is_valid(&target, &attacker) {
            return;
        }
        let Some(AuthorityAiState::PassiveCreature(mut ai)) = target.ai.clone() else {
            return;
        };
        // Already chasing this attacker: refresh leash timer only.
        if ai.mode == PassiveCreatureMode::Engage
            && ai.threat_actor_id.as_deref() == Some(attacker_actor_id)
        {
            let chase_ticks = ms_to_ticks_round(
                CREATURE_CHASE_TIMEOUT_MS,
                self.runtime.durable.world.tick_rate_hz,
            )
            .max(1);
            ai.chase_until_tick = self.runtime.durable.tick.saturating_add(chase_ticks);
            ai.threat = Some(attacker.position);
            if let Some(live) = self.runtime.durable.actors.get_mut(target_actor_id) {
                live.ai = Some(AuthorityAiState::PassiveCreature(ai));
                live.engagement_target_id = Some(attacker_actor_id.to_owned());
            }
            bump_actor_combat_until(self, target_actor_id, self.runtime.durable.tick);
            return;
        }
        self.begin_creature_engagement(target_actor_id, &mut ai, &attacker);
        if let Some(live) = self.runtime.durable.actors.get_mut(target_actor_id) {
            live.ai = Some(AuthorityAiState::PassiveCreature(ai));
        }
    }

    pub(in crate::authority) fn strike_creature_melee_if_ready(
        &mut self,
        actor_id: &str,
        actor: &ActorAuthorityState,
        target: &ActorAuthorityState,
        ai: &mut PassiveCreatureAiState,
    ) -> bool {
        if self.runtime.durable.tick < ai.next_attack_tick {
            return false;
        }
        if !posture_allows_melee_attack(actor.posture) {
            return false;
        }
        if !self.creature_target_is_valid(actor, target) {
            return false;
        }
        // Use the in-tick AI state: the actor snapshot passed into the scheduler is
        // cloned before AI mutation, so live can_actor_attack would still see calm AI.
        if ai.mode != PassiveCreatureMode::Engage
            || ai.threat_actor_id.as_deref() != Some(target.id.as_str())
        {
            return false;
        }
        if position_distance_milli(actor.position, target.position)
            > CREATURE_ATTACK_RANGE_MILLI_CELLS
        {
            return false;
        }
        let Some(aim_vector) = normalize_aim_vector_milli(
            actor_center_position(target)
                .x
                .saturating_sub(actor_center_position(actor).x),
            actor_center_position(target)
                .y
                .saturating_sub(actor_center_position(actor).y),
        ) else {
            return false;
        };
        let direction_name = direction_for_aim_vector(aim_vector);
        let cooldown_ticks = ms_to_ticks_round(
            CREATURE_ATTACK_INTERVAL_MS,
            self.runtime.durable.world.tick_rate_hz,
        )
        .max(1);
        if let Some(shooter) = self.runtime.durable.actors.get_mut(actor_id) {
            shooter.direction = direction_name.to_owned();
            shooter.next_fire_tick = self.runtime.durable.tick.saturating_add(cooldown_ticks);
            shooter.shots_fired = shooter.shots_fired.saturating_add(1);
            shooter.last_shot_tick = Some(self.runtime.durable.tick);
            shooter.stats.record_shot(
                self.runtime.durable.tick,
                self.runtime.durable.world.tick_rate_hz,
            );
        }
        let origin = actor_center_position(actor);
        let impact = actor_center_position(target);
        if self
            .apply_melee_contact_strike(actor_id, target, None, origin, impact)
            .is_none()
        {
            return false;
        }
        ai.next_attack_tick = self.runtime.durable.tick.saturating_add(cooldown_ticks);
        ai.next_decision_tick = self
            .runtime
            .durable
            .tick
            .saturating_add(AI_DECISION_CADENCE_TICKS);
        true
    }

    pub(in crate::authority) fn choose_passive_creature_target(
        &self,
        actor: &ActorAuthorityState,
        ai: &mut PassiveCreatureAiState,
    ) {
        if ai.mode == PassiveCreatureMode::Engage {
            return;
        }
        if ai.mode == PassiveCreatureMode::Flee {
            if let Some(threat) = ai.threat {
                ai.target = Some(self.creature_flee_target(actor, ai, threat));
                ai.next_decision_tick = self.runtime.durable.tick
                    + 10
                    + (ai_rand(ai.seed, self.runtime.durable.tick, 1) * 15.0) as u64;
                return;
            }
            ai.mode = PassiveCreatureMode::Roam;
        }

        let distance_home = position_distance_milli(
            actor.position,
            AuthorityPosition::from_cell(actor.home_cell),
        );
        let roll = ai_rand(ai.seed, self.runtime.durable.tick, 2);
        if distance_home <= CREATURE_HOME_RADIUS_MILLI_CELLS * 3 / 4 && roll < 0.18 {
            ai.mode = PassiveCreatureMode::Idle;
            ai.target = None;
            ai.next_decision_tick = self.runtime.durable.tick
                + 10
                + (ai_rand(ai.seed, self.runtime.durable.tick, 3) * 22.0) as u64;
            return;
        }

        ai.mode = PassiveCreatureMode::Roam;
        ai.target = Some(self.creature_roam_target(actor, ai, distance_home));
        ai.next_decision_tick = self.runtime.durable.tick
            + 18
            + (ai_rand(ai.seed, self.runtime.durable.tick, 4) * 38.0) as u64;
    }

    pub(in crate::authority) fn creature_roam_target(
        &self,
        actor: &ActorAuthorityState,
        ai: &PassiveCreatureAiState,
        distance_home: i32,
    ) -> AuthorityPosition {
        let home = AuthorityPosition::from_cell(actor.home_cell);
        if distance_home > CREATURE_HOME_RADIUS_MILLI_CELLS {
            let dx = home.x - actor.position.x;
            let dy = home.y - actor.position.y;
            return self.best_ai_target(
                actor,
                actor.position.x + dx * 55 / 100,
                actor.position.y + dy * 55 / 100,
                2_500,
                10,
                ai.seed,
            );
        }

        for attempt in 0..8_u64 {
            let angle = ai_rand(ai.seed, self.runtime.durable.tick + attempt * 7, 5)
                * std::f64::consts::TAU;
            let radius = 1_250.0
                + ai_rand(ai.seed, self.runtime.durable.tick + attempt * 11, 6)
                    * f64::from(CREATURE_HOME_RADIUS_MILLI_CELLS);
            let x = home.x + (angle.cos() * radius).round() as i32;
            let y = home.y + (angle.sin() * radius).round() as i32;
            let target = self.best_ai_target(actor, x, y, 1_100, attempt as i32, ai.seed);
            if position_distance_milli(actor.position, target) > 650 {
                return target;
            }
        }
        self.best_ai_target(actor, home.x, home.y, 1_100, 0, ai.seed)
    }

    pub(in crate::authority) fn creature_flee_target(
        &self,
        actor: &ActorAuthorityState,
        ai: &PassiveCreatureAiState,
        threat: AuthorityPosition,
    ) -> AuthorityPosition {
        let away_x = actor.position.x + MILLI_CELLS_PER_CELL / 2 - threat.x;
        let away_y = actor.position.y + MILLI_CELLS_PER_CELL / 2 - threat.y;
        let away_distance = f64::from(distance_milli_components(away_x, away_y).max(1));
        let nx = f64::from(away_x) / away_distance;
        let ny = f64::from(away_y) / away_distance;
        let side = if ai_rand(ai.seed, self.runtime.durable.tick, 7) < 0.5 {
            -1.0
        } else {
            1.0
        };
        let flee_distance = 4_000.0 + ai_rand(ai.seed, self.runtime.durable.tick, 8) * 3_500.0;
        let lateral = (ai_rand(ai.seed, self.runtime.durable.tick, 9) - 0.5) * 4_000.0 * side;
        self.best_ai_target(
            actor,
            actor.position.x + (nx * flee_distance + -ny * lateral).round() as i32,
            actor.position.y + (ny * flee_distance + nx * lateral).round() as i32,
            2_000,
            12,
            ai.seed,
        )
    }

    pub(in crate::authority) fn best_ai_target(
        &self,
        actor: &ActorAuthorityState,
        x: i32,
        y: i32,
        fallback_radius: i32,
        salt: i32,
        seed: u32,
    ) -> AuthorityPosition {
        let primary = self.clamped_ai_position(&actor.area_id, AuthorityPosition { x, y });
        if primary != actor.position && !self.ai_position_blocked(&actor.area_id, primary) {
            return primary;
        }
        for attempt in 0..8_i32 {
            let roll = ai_rand(
                seed,
                self.runtime.durable.tick + attempt as u64,
                (60 + salt + attempt) as u64,
            );
            let angle = roll * std::f64::consts::TAU;
            let radius = f64::from(fallback_radius + attempt * 750);
            let candidate = self.clamped_ai_position(
                &actor.area_id,
                AuthorityPosition {
                    x: actor.position.x + (angle.cos() * radius).round() as i32,
                    y: actor.position.y + (angle.sin() * radius).round() as i32,
                },
            );
            if candidate != actor.position && !self.ai_position_blocked(&actor.area_id, candidate) {
                return candidate;
            }
        }
        actor.position
    }
}
