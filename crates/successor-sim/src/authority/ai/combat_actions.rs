use super::*;

const MELEE_STRIKE_ACTION_DAMAGE: i32 = 5;
const MELEE_STRIKE_SPIRIT_DAMAGE: i32 = 5;
const BRAWLER_CONTACT_SUPPRESSION_MILLI: i32 = 32_000;
const NPC_ROLL_ATTACK_CADENCE_MS: u64 = 2_000;

fn npc_roll_attack_cadence_ticks(tick_rate_hz: u32) -> u64 {
    ms_to_ticks_round(NPC_ROLL_ATTACK_CADENCE_MS, tick_rate_hz).max(1)
}

impl SliceAuthorityState {
    pub(in crate::authority) fn skirmisher_target_in_pressure_fire_range(
        &self,
        actor: &ActorAuthorityState,
        target: &ActorAuthorityState,
        profile: SkirmisherProfile,
    ) -> bool {
        actor.area_id == target.area_id
            && target.life_state == AuthorityLifeState::Alive
            && position_distance_milli(actor.position, target.position)
                <= profile.max_range_milli.saturating_add(1_500)
    }

    fn target_within_skirmisher_roll_range(
        &self,
        actor: &ActorAuthorityState,
        target: &ActorAuthorityState,
    ) -> bool {
        let Some(weapon_id) = actor.equipped_weapon_id else {
            return false;
        };
        let Some(stats) = weapon_profile(Some(weapon_id)).roll_stats else {
            return false;
        };
        actor.area_id == target.area_id
            && position_distance_milli(actor.position, target.position)
                <= self.roll_max_range_milli_for_weapon(weapon_id, stats)
            && self.roll_line_of_sight_clear_between_actors(actor, target)
    }

    fn actor_is_active_population_zone_npc(&self, actor: &ActorAuthorityState) -> bool {
        let Some(zone_id) = actor.spawn_zone_id.as_deref() else {
            return false;
        };
        self.runtime
            .durable
            .population
            .spawn_zones
            .get(zone_id)
            .is_some_and(|zone| zone.active)
    }

    pub(in crate::authority) fn note_skirmisher_roll_target_acquired(
        &mut self,
        actor_id: &str,
        actor: &ActorAuthorityState,
        ai: &mut SkirmisherAiState,
        target_actor_id: &str,
        profile: SkirmisherProfile,
    ) {
        let target_changed = ai.target_actor_id.as_deref() != Some(target_actor_id);
        ai.target_actor_id = Some(target_actor_id.to_owned());
        if profile.variant == SkirmisherVariant::Brawler
            || !target_changed
            || !self.actor_is_active_population_zone_npc(actor)
        {
            return;
        }
        self.mark_npc_target_acquired(actor_id);
        let first_attack_tick =
            self.runtime
                .durable
                .tick
                .saturating_add(npc_roll_attack_cadence_ticks(
                    self.runtime.durable.world.tick_rate_hz,
                ));
        ai.next_shot_tick = ai.next_shot_tick.max(first_attack_tick);
    }

    pub(in crate::authority) fn sync_roll_engagement_target_to_skirmisher_ai(
        &self,
        actor: &ActorAuthorityState,
        ai: &mut SkirmisherAiState,
        profile: SkirmisherProfile,
    ) {
        if profile.variant == SkirmisherVariant::Brawler {
            return;
        }
        let Some(target_actor_id) = actor.engagement_target_id.as_deref() else {
            return;
        };
        if self.engagement_target_valid_for_actor(actor, target_actor_id, true) {
            ai.target_actor_id = Some(target_actor_id.to_owned());
        }
    }

    pub(in crate::authority) fn advance_roll_simple_skirmisher_locomotion_tick(
        &mut self,
        actor_id: &str,
        actor: &ActorAuthorityState,
        ai: &mut SkirmisherAiState,
        profile: SkirmisherProfile,
        context: Option<&SkirmisherActorTacticalContext>,
    ) -> bool {
        if profile.variant == SkirmisherVariant::Brawler {
            return self.advance_skirmisher_locomotion_tick(actor_id, actor, ai, profile, context);
        }
        let Some(target_actor_id) = ai.target_actor_id.clone() else {
            ai.target = None;
            ai.cover = None;
            return false;
        };
        let Some(target) = self.runtime.durable.actors.get(&target_actor_id).cloned() else {
            ai.target_actor_id = None;
            ai.target = None;
            ai.cover = None;
            return false;
        };
        let Some((ideal_milli, max_milli)) = self.roll_range_bands_milli_for_actor(actor) else {
            ai.target = None;
            ai.cover = None;
            return false;
        };
        self.advance_roll_simple_skirmisher_band(
            actor_id,
            actor,
            ai,
            &target,
            profile,
            context,
            self.skirmisher_one_tick_step_milli(actor, profile),
            ideal_milli,
            max_milli,
            false,
        )
    }

    pub(in crate::authority) fn advance_roll_simple_skirmisher_ai(
        &mut self,
        actor_id: &str,
        actor: &ActorAuthorityState,
        ai: &mut SkirmisherAiState,
        target: &ActorAuthorityState,
        profile: SkirmisherProfile,
        context: Option<&SkirmisherActorTacticalContext>,
        step_milli: i32,
    ) -> bool {
        let Some((ideal_milli, max_milli)) = self.roll_range_bands_milli_for_actor(actor) else {
            ai.target = None;
            ai.cover = None;
            self.record_skirmisher_debug(
                actor,
                ai,
                profile,
                context,
                None,
                "roll_no_ranged_weapon",
                Vec::new(),
            );
            return false;
        };
        self.advance_roll_simple_skirmisher_band(
            actor_id,
            actor,
            ai,
            target,
            profile,
            context,
            step_milli,
            ideal_milli,
            max_milli,
            true,
        )
    }

    fn advance_roll_simple_skirmisher_band(
        &mut self,
        actor_id: &str,
        actor: &ActorAuthorityState,
        ai: &mut SkirmisherAiState,
        target: &ActorAuthorityState,
        profile: SkirmisherProfile,
        context: Option<&SkirmisherActorTacticalContext>,
        step_milli: i32,
        ideal_milli: i32,
        max_milli: i32,
        allow_fire: bool,
    ) -> bool {
        let distance_milli = position_distance_milli(actor.position, target.position);
        let reapproach_milli = ideal_milli.saturating_mul(5) / 4;
        let holding_band =
            ai.cover.is_some() && distance_milli <= reapproach_milli && distance_milli <= max_milli;
        if !holding_band && distance_milli > ideal_milli {
            ai.cover = None;
            ai.target = Some(target.position);
            ai.mode = SkirmisherMode::Engage;
            ai.next_decision_tick = self.runtime.durable.tick.saturating_add(1);
            let max_step_milli = step_milli.min(distance_milli.saturating_sub(ideal_milli).max(1));
            let moved = self.move_ai_actor_toward_position_pathing(
                actor_id,
                target.position,
                max_step_milli,
            );
            if moved {
                clear_skirmisher_blocked_target_near(
                    ai,
                    target.position,
                    SKIRMISHER_BLOCKED_TARGET_RADIUS_MILLI_CELLS,
                    position_distance_milli,
                );
            } else {
                note_skirmisher_blocked_target(
                    ai,
                    self.runtime.durable.tick,
                    target.position,
                    SKIRMISHER_BLOCKED_TARGET_MEMORY_TICKS,
                );
            }
            self.record_skirmisher_debug(
                actor,
                ai,
                profile,
                context,
                Some(target.position),
                if moved {
                    "roll_ideal_approach"
                } else {
                    "roll_ideal_approach_blocked"
                },
                Vec::new(),
            );
            return moved;
        }

        ai.cover = Some(actor.position);
        ai.target = None;
        ai.mode = SkirmisherMode::Engage;
        ai.next_decision_tick = self.runtime.durable.tick.saturating_add(1);
        let has_los = self.roll_line_of_sight_clear_between_actors(actor, target);
        let fired = allow_fire
            && has_los
            && self.fire_skirmisher_roll_if_ready(actor_id, actor, target, ai);
        self.record_skirmisher_debug(
            actor,
            ai,
            profile,
            context,
            None,
            if fired {
                "roll_hold_fire"
            } else if has_los {
                "roll_hold"
            } else {
                "roll_hold_los_blocked"
            },
            Vec::new(),
        );
        fired
    }
    fn fire_skirmisher_roll_if_ready(
        &mut self,
        actor_id: &str,
        actor: &ActorAuthorityState,
        target: &ActorAuthorityState,
        ai: &mut SkirmisherAiState,
    ) -> bool {
        if self.runtime.durable.tick < ai.next_shot_tick {
            return false;
        }
        if !self.target_within_skirmisher_roll_range(actor, target) {
            return false;
        }
        match self.resolve_npc_roll_attack(actor_id, &target.id) {
            Ok(()) => {
                ai.burst_shots_remaining = 0;
                ai.next_shot_tick =
                    self.runtime
                        .durable
                        .tick
                        .saturating_add(npc_roll_attack_cadence_ticks(
                            self.runtime.durable.world.tick_rate_hz,
                        ));
                ai.next_decision_tick = self.runtime.durable.tick.saturating_add(1);
                ai.target = None;
                true
            }
            Err(AuthorityRejectReason::AmmoUnavailable) => {
                ai.burst_shots_remaining = 0;
                ai.next_shot_tick =
                    self.runtime
                        .durable
                        .tick
                        .saturating_add(npc_roll_attack_cadence_ticks(
                            self.runtime.durable.world.tick_rate_hz,
                        ));
                ai.next_decision_tick = self.runtime.durable.tick.saturating_add(1);
                ai.target = None;
                false
            }
            Err(_) => {
                ai.target_actor_id = None;
                ai.target = None;
                ai.next_decision_tick = self.runtime.durable.tick.saturating_add(1);
                false
            }
        }
    }

    pub(in crate::authority) fn fire_skirmisher_if_ready(
        &mut self,
        actor_id: &str,
        actor: &ActorAuthorityState,
        target: &ActorAuthorityState,
        ai: &mut SkirmisherAiState,
        _profile: SkirmisherProfile,
    ) -> bool {
        if self.runtime.durable.tick < ai.next_shot_tick {
            return false;
        }
        if !self.target_within_skirmisher_roll_range(actor, target) {
            return false;
        }
        self.fire_skirmisher_roll_if_ready(actor_id, actor, target, ai)
    }

    pub(in crate::authority) fn fire_skirmisher_suppressive_if_ready(
        &mut self,
        actor_id: &str,
        actor: &ActorAuthorityState,
        target: &ActorAuthorityState,
        ai: &mut SkirmisherAiState,
        _profile: SkirmisherProfile,
    ) -> bool {
        if self.runtime.durable.tick < ai.next_shot_tick {
            return false;
        }
        if !self.target_within_skirmisher_roll_range(actor, target) {
            return false;
        }
        self.fire_skirmisher_roll_if_ready(actor_id, actor, target, ai)
    }

    pub(in crate::authority) fn apply_melee_contact_strike(
        &mut self,
        actor_id: &str,
        target: &ActorAuthorityState,
        command_id: Option<u64>,
        origin: AuthorityPosition,
        impact: AuthorityPosition,
    ) -> Option<AuthorityCombatEventSnapshot> {
        let attacker = self.runtime.durable.actors.get(actor_id)?.clone();
        if !posture_allows_melee_attack(attacker.posture) {
            return None;
        }
        let weapon_id = attacker
            .equipped_weapon_id
            .filter(|weapon_id| is_melee_weapon_id(*weapon_id))
            .unwrap_or(AuthorityWeaponId::Unarmed);
        // Passive wildlife has no weapon slot; use species melee authority
        // instead of shared Unarmed so player/NPC bare-hand stays unchanged.
        let base_damage = if is_passive_creature_actor(&attacker) {
            CREATURE_MELEE_BASE_DAMAGE
        } else {
            weapon_profile(Some(weapon_id)).base_damage
        };
        let melee_damage = melee_flat_damage_with_bonus(&attacker, base_damage);
        let event_id = self.runtime.durable.next_combat_event_id;
        let (event, counted_hit) = {
            let target_actor = self.runtime.durable.actors.get_mut(&target.id)?;
            if target_actor.lifecycle_seq != target.lifecycle_seq {
                return None;
            }
            if target_actor.life_state != AuthorityLifeState::Alive {
                return None;
            }
            let previous_life_state = target_actor.life_state;
            let mut damage = apply_defender_damage_taken_reduction(target_actor, melee_damage);
            let mut effect = None;
            let mut lifecycle = AuthorityCombatLifecycleKind::Hit;
            let mut lifecycle_cause = "melee strike".to_owned();
            let mut counted_hit = true;
            if melee_stat_dodge_rolls(actor_id, event_id, target_actor, self.runtime.durable.tick) {
                damage = 0;
                counted_hit = false;
                effect = Some(AuthorityCombatEffectSnapshot {
                    kind: "dodge".to_owned(),
                    stacks: 0,
                    threshold: 0,
                    remaining_ticks: 0,
                });
                lifecycle_cause = "dodged".to_owned();
            } else {
                let shielded = if let Some(shield_outcome) = Self::try_block_with_personal_shield(
                    target_actor,
                    self.runtime.durable.tick,
                    self.runtime.durable.world.tick_rate_hz,
                    damage,
                ) {
                    damage = shield_outcome.damage_after_shield;
                    effect = Some(shield_outcome.effect);
                    lifecycle_cause = if damage > 0 {
                        "personal shield overflow".to_owned()
                    } else {
                        "personal shield".to_owned()
                    };
                    true
                } else {
                    false
                };
                if !shielded {
                    Self::record_personal_shield_damage_seen(
                        target_actor,
                        self.runtime.durable.tick,
                    );
                }
                if damage > 0 {
                    apply_vital_damage(&mut target_actor.vitals.health, damage);
                    apply_vital_damage(&mut target_actor.vitals.action, MELEE_STRIKE_ACTION_DAMAGE);
                    apply_vital_damage(&mut target_actor.vitals.spirit, MELEE_STRIKE_SPIRIT_DAMAGE);
                    if target_actor.vitals.health <= 0 {
                        if Self::uses_npc_corpse_respawn_timer(target_actor) {
                            Self::kill_actor_for_respawn(
                                self.runtime.durable.tick,
                                self.runtime.durable.world.tick_rate_hz,
                                target_actor,
                            );
                            self.runtime.durable.deaths =
                                self.runtime.durable.deaths.saturating_add(1);
                            lifecycle = AuthorityCombatLifecycleKind::Killed;
                            lifecycle_cause = "critical melee trauma".to_owned();
                        } else if Self::down_player_like_actor_or_kill(
                            self.runtime.durable.tick,
                            self.runtime.durable.world.tick_rate_hz,
                            target_actor,
                        ) {
                            self.runtime.durable.deaths =
                                self.runtime.durable.deaths.saturating_add(1);
                            lifecycle = AuthorityCombatLifecycleKind::Killed;
                            lifecycle_cause = "incap threshold".to_owned();
                        } else {
                            lifecycle = AuthorityCombatLifecycleKind::Downed;
                            lifecycle_cause = "critical melee trauma".to_owned();
                        }
                    }
                }
            }

            self.runtime.durable.next_combat_event_id =
                self.runtime.durable.next_combat_event_id.saturating_add(1);
            self.runtime.durable.combat_event_count =
                self.runtime.durable.combat_event_count.saturating_add(1);
            (
                AuthorityCombatEventSnapshot {
                    id: event_id,
                    command_id,
                    tick: self.runtime.durable.tick,
                    shooter_actor_id: actor_id.to_owned(),
                    target_actor_id: target_actor.id.clone(),
                    origin_x: Some(cell_units_from_milli(origin.x)),
                    origin_y: Some(cell_units_from_milli(origin.y)),
                    hit_x: cell_units_from_milli(impact.x),
                    hit_y: cell_units_from_milli(impact.y),
                    damage,
                    previous_life_state,
                    life_state: target_actor.life_state,
                    target_lifecycle_seq: target_actor.lifecycle_seq,
                    bleed_stack_count: bleed_stack_count(target_actor),
                    lifecycle,
                    zone: "torso".to_owned(),
                    weapon_id,
                    ammo_type: AuthorityAmmoTypeId::Melee,
                    effect,
                    lifecycle_cause,
                    kind: None,
                    attacker_actor_id: None,
                    action_id: None,
                    hit: None,
                    pool: None,
                    roll_milli: None,
                    to_hit_milli: None,
                    block_roll_milli: None,
                    block_chance_milli: None,
                },
                counted_hit,
            )
        };

        if counted_hit {
            self.apply_suppression_to_actor(
                &event.target_actor_id,
                BRAWLER_CONTACT_SUPPRESSION_MILLI,
                origin,
            );
            self.runtime.durable.hits = self.runtime.durable.hits.saturating_add(1);
            self.record_combat_event_stats(&event);
            if event.damage > 0 {
                self.provoke_creature_retaliation(&event.target_actor_id, actor_id);
            }
        }
        // Combat XP cutover: NPC attackers keep per-hit accrual; human players are paid
        // full ledger XP at kill time instead (see award_kill_combat_xp_to_damagers).
        if event.damage > 0
            && !self
                .runtime
                .durable
                .actors
                .get(actor_id)
                .is_some_and(is_human_player_actor)
        {
            let xp = u64::try_from(event.damage).unwrap_or(0);
            let _ = self.award_profession_tracks_xp(
                actor_id,
                AuthorityProfessionKind::Brawler,
                &["melee", "guard", "movement-speed", "attack-speed"],
                xp,
            );
        }
        if event.previous_life_state == AuthorityLifeState::Alive
            && event.life_state != AuthorityLifeState::Alive
        {
            self.award_kill_combat_xp_to_damagers(&event.target_actor_id);
        }
        self.runtime.pending_combat_events.push(event.clone());
        Some(event)
    }

    pub(in crate::authority) fn strike_skirmisher_melee_if_ready(
        &mut self,
        actor_id: &str,
        actor: &ActorAuthorityState,
        target: &ActorAuthorityState,
        ai: &mut SkirmisherAiState,
        profile: SkirmisherProfile,
    ) -> bool {
        if profile.variant != SkirmisherVariant::Brawler
            || self.runtime.durable.tick < ai.next_shot_tick
        {
            return false;
        }
        if !posture_allows_melee_attack(actor.posture) {
            return false;
        }
        if actor.area_id != target.area_id
            || actor.life_state != AuthorityLifeState::Alive
            || target.life_state != AuthorityLifeState::Alive
            || !self.can_actor_attack(actor, target)
            || !self.ai_fire_target_allowed(actor, target)
            || position_distance_milli(actor.position, target.position)
                > melee_strike_range_milli(profile)
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
        let weapon_id = actor
            .equipped_weapon_id
            .filter(|weapon_id| is_melee_weapon_id(*weapon_id))
            .unwrap_or(AuthorityWeaponId::Vibrosword);
        let cooldown_ticks =
            self.melee_attack_interval_ticks_for_actor(actor, weapon_profile(Some(weapon_id)));

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
        };
        ai.burst_shots_remaining = 0;
        ai.next_shot_tick = self.runtime.durable.tick.saturating_add(cooldown_ticks);
        ai.next_decision_tick = self
            .runtime
            .durable
            .tick
            .saturating_add(SKIRMISHER_DECISION_MIN_TICKS);
        ai.target = None;
        true
    }
}

fn melee_stat_dodge_rolls(
    shooter_actor_id: &str,
    event_id: u64,
    target: &ActorAuthorityState,
    tick: u64,
) -> bool {
    let chance_milli = combat_dodge_chance_milli(target, tick);
    if chance_milli <= 0 {
        return false;
    }
    let seed = string_hash32(&format!(
        "melee-dodge:{}:{}:{}",
        target.id, shooter_actor_id, event_id
    ));
    let roll_milli =
        (ai_rand(seed, tick, event_id.wrapping_mul(0x9e37_79b9_7f4a_7c15)) * 1_000.0) as i32;
    roll_milli < chance_milli
}
