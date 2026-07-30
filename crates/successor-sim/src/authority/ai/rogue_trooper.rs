use super::*;

pub(in crate::authority) fn direct_contact_approach_allowed(
    hard_suppressed: bool,
    incoming_fire: bool,
    recently_damaged: bool,
    target_can_return_fire: bool,
    squad_retreating: bool,
) -> bool {
    !hard_suppressed
        && !incoming_fire
        && !recently_damaged
        && !target_can_return_fire
        && !squad_retreating
}

impl SliceAuthorityState {
    #[allow(clippy::too_many_arguments)]
    fn advance_skirmisher_close_melee_disengage(
        &mut self,
        actor_id: &str,
        actor: &ActorAuthorityState,
        ai: &mut SkirmisherAiState,
        profile: SkirmisherProfile,
        context: Option<&SkirmisherActorTacticalContext>,
        reservations: &SkirmisherReservations,
        step_milli: i32,
        fired_this_tick: bool,
    ) -> Option<bool> {
        let threat = self.nearest_close_melee_pressure_threat(actor)?;
        let choice = self.close_melee_disengage_choice(
            actor,
            Some(ai),
            ai.seed,
            profile,
            &threat,
            context,
            reservations,
        )?;
        let choice_step_milli =
            ranged_fire_and_melee_disengage_step_milli(step_milli, fired_this_tick);
        let moved = self.move_ai_actor_toward_position_pathing(
            actor_id,
            choice.position,
            choice_step_milli,
        );
        if moved {
            clear_skirmisher_blocked_target_near(
                ai,
                choice.position,
                SKIRMISHER_BLOCKED_TARGET_RADIUS_MILLI_CELLS,
                position_distance_milli,
            );
        } else {
            note_skirmisher_blocked_target(
                ai,
                self.runtime.durable.tick,
                choice.position,
                SKIRMISHER_BLOCKED_TARGET_MEMORY_TICKS,
            );
        }
        ai.target_actor_id = Some(threat.id.clone());
        ai.cover = None;
        ai.target = if moved { Some(choice.position) } else { None };
        ai.mode = SkirmisherMode::Engage;
        ai.next_decision_tick = self
            .runtime
            .durable
            .tick
            .saturating_add(SKIRMISHER_DECISION_MIN_TICKS);
        self.record_skirmisher_debug(
            actor,
            ai,
            profile,
            context,
            Some(choice.position),
            if moved {
                "melee_disengage"
            } else {
                "melee_disengage_blocked"
            },
            choice.candidates,
        );
        Some(moved || fired_this_tick)
    }

    pub(in crate::authority) fn skirmisher_contact_approach_position(
        &self,
        actor: &ActorAuthorityState,
        target: &ActorAuthorityState,
        profile: SkirmisherProfile,
        context: Option<&SkirmisherActorTacticalContext>,
        reservations: &SkirmisherReservations,
    ) -> Option<AuthorityPosition> {
        let target_gap = position_distance_milli(actor.position, target.position);
        // Keep an aggroed target in the profile's preferred attack band before
        // holding position. The old max-range deadband left a deterministic
        // max..max+1_500 gap with no tactical candidate and no approach.
        if target_gap <= profile.preferred_range_milli {
            return None;
        }
        let (away_x_milli, away_y_milli) = normalize_components_milli(
            actor.position.x.saturating_sub(target.position.x),
            actor.position.y.saturating_sub(target.position.y),
        )?;
        for standoff in [
            profile.preferred_range_milli,
            profile.max_range_milli.saturating_sub(1_500),
            profile.min_range_milli.saturating_add(1_500),
        ] {
            let anchor = self.clamped_ai_position(
                &actor.area_id,
                AuthorityPosition {
                    x: target.position.x.saturating_add(scaled_axis_delta(
                        away_x_milli,
                        standoff,
                        1_000,
                    )),
                    y: target.position.y.saturating_add(scaled_axis_delta(
                        away_y_milli,
                        standoff,
                        1_000,
                    )),
                },
            );
            let destination = self.combat_slot_position(actor, anchor, context, reservations);
            let destination_gap = position_distance_milli(destination, target.position);
            if destination != actor.position
                && destination_gap >= profile.min_range_milli
                && destination_gap <= profile.max_range_milli
                && self.ai_destination_available(actor, destination, reservations)
                && self.ai_tactical_candidate_reachable(actor, destination)
            {
                return Some(destination);
            }
        }
        None
    }

    pub(in crate::authority) fn brawler_intercept_anchor_position(
        &self,
        target: &ActorAuthorityState,
    ) -> AuthorityPosition {
        let Some(ai) = combat_micro_state(target.ai.as_ref()) else {
            return target.position;
        };
        if ai.last_move_tick == 0
            || self.runtime.durable.tick.saturating_sub(ai.last_move_tick)
                > BRAWLER_INTERCEPT_MOVE_MEMORY_MAX_AGE_TICKS
        {
            return target.position;
        }

        let raw_lead_x = ai
            .last_move_dx_milli
            .saturating_mul(BRAWLER_INTERCEPT_LEAD_STEPS);
        let raw_lead_y = ai
            .last_move_dy_milli
            .saturating_mul(BRAWLER_INTERCEPT_LEAD_STEPS);
        let raw_distance = distance_milli_components(raw_lead_x, raw_lead_y);
        let (lead_x, lead_y) = if raw_distance > BRAWLER_INTERCEPT_LEAD_MAX_MILLI_CELLS {
            (
                scaled_axis_delta(
                    raw_lead_x,
                    BRAWLER_INTERCEPT_LEAD_MAX_MILLI_CELLS,
                    raw_distance,
                ),
                scaled_axis_delta(
                    raw_lead_y,
                    BRAWLER_INTERCEPT_LEAD_MAX_MILLI_CELLS,
                    raw_distance,
                ),
            )
        } else {
            (raw_lead_x, raw_lead_y)
        };
        self.clamped_ai_position(
            &target.area_id,
            AuthorityPosition {
                x: target.position.x.saturating_add(lead_x),
                y: target.position.y.saturating_add(lead_y),
            },
        )
    }

    pub(in crate::authority) fn skirmisher_brawler_contact_position(
        &self,
        actor: &ActorAuthorityState,
        target: &ActorAuthorityState,
        profile: SkirmisherProfile,
        context: Option<&SkirmisherActorTacticalContext>,
        reservations: &SkirmisherReservations,
    ) -> AuthorityPosition {
        let strike_range = melee_strike_range_milli(profile);
        let slot_max_distance = strike_range
            .saturating_sub(BRAWLER_MELEE_CONTACT_BUFFER_MILLI_CELLS)
            .max(1);
        let anchor = self.brawler_intercept_anchor_position(target);
        let slotted = self.combat_interaction_slot_position(
            actor,
            anchor,
            context,
            reservations,
            Some(slot_max_distance),
        );
        if slotted != actor.position
            && position_distance_milli(slotted, anchor) <= slot_max_distance
            && self.ai_destination_available(actor, slotted, reservations)
            && self.ai_tactical_candidate_reachable(actor, slotted)
        {
            return slotted;
        }
        if anchor != target.position {
            let slotted = self.combat_interaction_slot_position(
                actor,
                target.position,
                context,
                reservations,
                Some(slot_max_distance),
            );
            if slotted != actor.position
                && position_distance_milli(slotted, target.position) <= slot_max_distance
                && self.ai_destination_available(actor, slotted, reservations)
                && self.ai_tactical_candidate_reachable(actor, slotted)
            {
                return slotted;
            }
        }
        target.position
    }

    pub(in crate::authority) fn advance_skirmisher_ai(
        &mut self,
        actor_id: &str,
        actor: &ActorAuthorityState,
        ai: &mut SkirmisherAiState,
        context: Option<&SkirmisherActorTacticalContext>,
        reservations: &SkirmisherReservations,
    ) -> bool {
        if actor_uses_passive_rogue_attitude(actor) && ai.attitude != NpcAiAttitude::Hostile {
            hold_skirmisher_passive(ai);
            ai.next_decision_tick = self.runtime.durable.tick.saturating_add(1);
            self.record_skirmisher_debug(
                actor,
                ai,
                skirmisher_profile_for_actor(actor, ai.seed),
                context,
                None,
                ai.attitude.label(),
                Vec::new(),
            );
            return false;
        }
        let Some(elapsed_ticks) = scheduled_ai_elapsed_ticks(
            ai.seed,
            self.runtime.durable.tick,
            AI_DECISION_CADENCE_TICKS,
            401,
            &mut ai.next_update_tick,
            &mut ai.last_update_tick,
        ) else {
            let profile = skirmisher_profile_for_actor(actor, ai.seed);
            if actor_uses_roll_simple_ranged_brain(actor) {
                self.sync_roll_engagement_target_to_skirmisher_ai(actor, ai, profile);
                return self.advance_roll_simple_skirmisher_locomotion_tick(
                    actor_id, actor, ai, profile, context,
                );
            }
            return self.advance_skirmisher_locomotion_tick(actor_id, actor, ai, profile, context);
        };
        let elapsed_ticks = elapsed_ticks.clamp(1, AI_UPDATE_CADENCE_TICKS);

        let profile = skirmisher_profile_for_actor(actor, ai.seed);
        let step_milli = distance_for_ticks(
            scaled_milli(
                profile.speed_milli_cells_per_second,
                movement_speed_multiplier_milli_for_actor(actor),
            ),
            elapsed_ticks,
            self.runtime.durable.world.tick_rate_hz,
        );
        if actor_uses_roll_simple_ranged_brain(actor) {
            self.sync_roll_engagement_target_to_skirmisher_ai(actor, ai, profile);
        }
        let focused_target = self.focused_skirmisher_target(actor, ai);
        let nearest_target = self.nearest_skirmisher_target(actor, profile);
        let far_contact_target = if nearest_target.is_none() {
            self.skirmisher_far_contact_target(actor, profile)
        } else {
            None
        };
        let keep_focus = focused_target.as_ref().is_some_and(|target| {
            let focused_distance = position_distance_milli(actor.position, target.position);
            let brawler_directed_creature = is_passive_creature_actor(target)
                && (actor.professions.has(AuthorityProfessionKind::Brawler)
                    || actor.equipped_weapon_id.is_some_and(is_melee_weapon_id));
            if brawler_directed_creature {
                return focused_distance
                    <= SKIRMISHER_ACQUIRE_RADIUS_MILLI_CELLS
                        .saturating_mul(SKIRMISHER_FAR_CONTACT_ACQUIRE_MULTIPLIER);
            }
            let focused_has_shot = self.skirmisher_can_fire_at(actor, target, profile);
            let closer_immediate_threat = nearest_target.as_ref().is_some_and(|nearest| {
                if nearest.id == target.id {
                    return false;
                }
                let nearest_distance = position_distance_milli(actor.position, nearest.position);
                self.skirmisher_can_fire_at(actor, nearest, profile)
                    || self.skirmisher_can_fire_at(
                        nearest,
                        actor,
                        skirmisher_profile_for_ai_state(nearest),
                    )
                    || nearest_distance.saturating_add(3_000) < focused_distance
            });
            focused_distance <= SKIRMISHER_ACQUIRE_RADIUS_MILLI_CELLS
                && (focused_has_shot
                    || (!closer_immediate_threat
                        && self.runtime.durable.tick < ai.next_decision_tick))
        });
        let focused_target = if keep_focus { focused_target } else { None };
        let Some(target) = self.preferred_skirmisher_target(
            actor,
            focused_target,
            nearest_target.or(far_contact_target),
            profile,
        ) else {
            ai.target_actor_id = None;
            ai.mode = SkirmisherMode::HoldCover;
            ai.target = None;
            ai.cover = None;
            self.record_skirmisher_debug(
                actor,
                ai,
                profile,
                context,
                None,
                "no_hostile_target",
                Vec::new(),
            );
            return false;
        };

        let incoming_fire = actor.suppression.pressure_milli > 0;
        let target_changed = ai.target_actor_id.as_deref() != Some(target.id.as_str());
        self.note_skirmisher_roll_target_acquired(actor_id, actor, ai, &target.id, profile);
        if target_changed {
            ai.target = None;
            ai.cover = None;
        }
        if profile.variant == SkirmisherVariant::Brawler {
            if self.strike_skirmisher_melee_if_ready(actor_id, actor, &target, ai, profile) {
                self.record_skirmisher_debug(
                    actor,
                    ai,
                    profile,
                    context,
                    None,
                    "melee_strike",
                    Vec::new(),
                );
                return true;
            }
            let strike_range = melee_strike_range_milli(profile);
            let windup_range = strike_range
                .saturating_sub(BRAWLER_MELEE_CONTACT_BUFFER_MILLI_CELLS)
                .max(1);
            let target_gap = position_distance_milli(actor.position, target.position);
            let target_can_return_fire = self.skirmisher_can_fire_at(
                &target,
                actor,
                skirmisher_profile_for_ai_state(&target),
            );
            if target_gap <= windup_range {
                ai.target = None;
                ai.cover = None;
                ai.mode = SkirmisherMode::Engage;
                let wait_ticks = if self.runtime.durable.tick < ai.next_shot_tick {
                    ai.next_shot_tick
                        .saturating_sub(self.runtime.durable.tick)
                        .clamp(1, SKIRMISHER_DECISION_MIN_TICKS)
                } else {
                    1
                };
                ai.next_decision_tick = self.runtime.durable.tick.saturating_add(wait_ticks);
                self.record_skirmisher_debug(
                    actor,
                    ai,
                    profile,
                    context,
                    None,
                    "melee_windup",
                    Vec::new(),
                );
                return false;
            }
            if target_can_return_fire {
                ai.target = None;
                ai.cover = None;
                ai.mode = SkirmisherMode::Engage;
                ai.next_decision_tick = self.runtime.durable.tick.saturating_add(1);
                self.record_skirmisher_debug(
                    actor,
                    ai,
                    profile,
                    context,
                    None,
                    "melee_hold_return_fire",
                    Vec::new(),
                );
                return false;
            }
            let destination = self.skirmisher_brawler_contact_position(
                actor,
                &target,
                profile,
                context,
                reservations,
            );
            if destination != actor.position {
                let under_immediate_pressure = incoming_fire || target_can_return_fire;
                let melee_step_milli = brawler_melee_advance_step_milli(
                    actor,
                    &target,
                    step_milli,
                    target_gap,
                    strike_range,
                    incoming_fire,
                    under_immediate_pressure,
                );
                let moved = self.move_ai_actor_toward_position_pathing(
                    actor_id,
                    destination,
                    melee_step_milli,
                );
                if moved {
                    clear_skirmisher_blocked_target_near(
                        ai,
                        destination,
                        SKIRMISHER_BLOCKED_TARGET_RADIUS_MILLI_CELLS,
                        position_distance_milli,
                    );
                } else {
                    note_skirmisher_blocked_target(
                        ai,
                        self.runtime.durable.tick,
                        destination,
                        SKIRMISHER_BLOCKED_TARGET_MEMORY_TICKS,
                    );
                }
                ai.target = Some(destination);
                ai.cover = None;
                ai.mode = SkirmisherMode::Engage;
                ai.next_decision_tick = self.runtime.durable.tick.saturating_add(1);
                self.record_skirmisher_debug(
                    actor,
                    ai,
                    profile,
                    context,
                    Some(destination),
                    if moved {
                        "melee_advance"
                    } else {
                        "melee_advance_blocked"
                    },
                    Vec::new(),
                );
                return moved;
            }
            ai.target = None;
            ai.cover = None;
            ai.mode = SkirmisherMode::Engage;
            ai.next_decision_tick = self.runtime.durable.tick.saturating_add(1);
            self.record_skirmisher_debug(
                actor,
                ai,
                profile,
                context,
                None,
                "melee_recover",
                Vec::new(),
            );
            return false;
        }
        if actor_uses_roll_simple_ranged_brain(actor) {
            return self.advance_roll_simple_skirmisher_ai(
                actor_id, actor, ai, &target, profile, context, step_milli,
            );
        }
        let has_shot = self.skirmisher_can_fire_at(actor, &target, profile);
        let hard_suppressed = actor.suppression.pressure_milli >= profile.cover_pressure_milli;
        let recently_damaged = actor.stats.last_damage_taken_tick.is_some_and(|tick| {
            self.runtime.durable.tick.saturating_sub(tick)
                <= u64::from(self.runtime.durable.world.tick_rate_hz.max(1)).saturating_mul(2)
        });
        if has_shot {
            if let Some(threat) = self.nearest_close_melee_pressure_threat(actor) {
                if ranged_close_melee_threat_requires_disengage_before_fire(actor, &threat) {
                    if let Some(disengaged) = self.advance_skirmisher_close_melee_disengage(
                        actor_id,
                        actor,
                        ai,
                        profile,
                        context,
                        reservations,
                        step_milli,
                        false,
                    ) {
                        return disengaged;
                    }
                }
            }
        }
        if has_shot && self.fire_skirmisher_if_ready(actor_id, actor, &target, ai, profile) {
            if let Some(disengaged) = self.advance_skirmisher_close_melee_disengage(
                actor_id,
                actor,
                ai,
                profile,
                context,
                reservations,
                step_milli,
                true,
            ) {
                return disengaged;
            }
            self.record_skirmisher_debug(actor, ai, profile, context, None, "fired", Vec::new());
            return true;
        }
        if !has_shot
            && self.combat_pressure_fire_due()
            && self.skirmisher_target_in_pressure_fire_range(actor, &target, profile)
            && self.fire_skirmisher_suppressive_if_ready(actor_id, actor, &target, ai, profile)
        {
            self.record_skirmisher_debug(
                actor,
                ai,
                profile,
                context,
                None,
                "suppressive_fire",
                Vec::new(),
            );
            return true;
        }
        let outgunned = self.skirmisher_outgunned(actor);
        let squad_retreat_order =
            context.is_some_and(|ctx| ctx.squad.order == SkirmisherSquadOrder::Retreat);
        let target_can_return_fire =
            self.skirmisher_can_fire_at(&target, actor, skirmisher_profile_for_ai_state(&target));
        let squad_retreating = squad_retreat_order
            && (incoming_fire || hard_suppressed || recently_damaged || target_can_return_fire);
        let direct_approach_allowed = direct_contact_approach_allowed(
            hard_suppressed,
            incoming_fire,
            recently_damaged,
            target_can_return_fire,
            squad_retreating,
        );
        let pressure_replan_due = tactical_pressure_replan_due(TacticalPressureReplanRequest {
            tick: self.runtime.durable.tick,
            next_decision_tick: ai.next_decision_tick,
            distance_to_target_milli: ai
                .target
                .map(|target| position_distance_milli(actor.position, target)),
            last_move_tick: ai.last_move_tick,
            committed_move_reached_milli: SKIRMISHER_COVER_REACHED_MILLI_CELLS,
            pressure_replan_grace_ticks: TACTICAL_PRESSURE_REPLAN_GRACE_TICKS,
            incoming_fire,
            hard_suppressed,
            outgunned,
            forced_withdrawal: squad_retreating,
        });
        let cover_needed = incoming_fire
            || tactical_cover_needed(TacticalCoverNeedRequest {
                current_action: actor.vitals.action,
                max_action: actor.max_vitals.action,
                suppression_pressure_milli: actor.suppression.pressure_milli,
                cover_pressure_milli: profile.cover_pressure_milli,
                low_action_cover_percent: profile.low_action_cover_percent,
                hold_cover_between_shots: profile.hold_cover_between_shots,
                tick: self.runtime.durable.tick,
                next_shot_tick: ai.next_shot_tick,
                outgunned,
            })
            || squad_retreating;
        let mut candidates = Vec::new();
        let mut reason = "holding_lane";
        if has_shot && self.fire_skirmisher_if_ready(actor_id, actor, &target, ai, profile) {
            self.record_skirmisher_debug(
                actor,
                ai,
                profile,
                context,
                None,
                "fired_from_lane",
                candidates,
            );
            return true;
        }

        if let Some(disengaged) = self.advance_skirmisher_close_melee_disengage(
            actor_id,
            actor,
            ai,
            profile,
            context,
            reservations,
            step_milli,
            false,
        ) {
            return disengaged;
        }

        if has_shot && !cover_needed {
            ai.cover = None;
            ai.target = None;
            ai.mode = SkirmisherMode::Engage;
            self.record_skirmisher_debug(
                actor,
                ai,
                profile,
                context,
                None,
                "holding_firing_lane",
                candidates,
            );
            return false;
        }

        let distant_unpressured_contact = !has_shot
            && !cover_needed
            && position_distance_milli(actor.position, target.position)
                > profile.max_range_milli.saturating_add(1_500)
            && !hard_suppressed
            && !incoming_fire
            && !recently_damaged
            && !target_can_return_fire;
        if distant_unpressured_contact {
            if let Some(destination) = self.skirmisher_contact_approach_position(
                actor,
                &target,
                profile,
                context,
                reservations,
            ) {
                let moved = self.move_ai_actor_toward_position_pathing(
                    actor_id,
                    destination,
                    skirmisher_maneuver_step_milli(step_milli, "advance_to_contact", false),
                );
                if moved {
                    clear_skirmisher_blocked_target_near(
                        ai,
                        destination,
                        SKIRMISHER_BLOCKED_TARGET_RADIUS_MILLI_CELLS,
                        position_distance_milli,
                    );
                } else {
                    note_skirmisher_blocked_target(
                        ai,
                        self.runtime.durable.tick,
                        destination,
                        SKIRMISHER_BLOCKED_TARGET_MEMORY_TICKS,
                    );
                }
                ai.target = Some(destination);
                ai.cover = None;
                ai.mode = SkirmisherMode::Engage;
                ai.next_decision_tick = self
                    .runtime
                    .durable
                    .tick
                    .saturating_add(SKIRMISHER_DECISION_MIN_TICKS);
                self.record_skirmisher_debug(
                    actor,
                    ai,
                    profile,
                    context,
                    Some(destination),
                    if moved {
                        "advance_to_contact"
                    } else {
                        "advance_to_contact_blocked"
                    },
                    Vec::new(),
                );
                return moved;
            }
        }

        let current_cover_reached = ai.cover.is_some_and(|cover| {
            position_distance_milli(actor.position, cover) <= SKIRMISHER_COVER_REACHED_MILLI_CELLS
        });
        if cover_needed && (ai.cover.is_none() || (pressure_replan_due && !current_cover_reached)) {
            let request = TacticalEngagementPolicy {
                require_shot: false,
                prefer_cover: true,
                cover_required: !squad_retreating,
                prefer_evasion: hard_suppressed || incoming_fire,
                allow_offensive_maneuver: false,
                allow_flank: false,
                allow_retreat: true,
            };
            if let Some(choice) = self.best_skirmisher_tactical_choice(
                actor,
                Some(ai),
                ai.seed,
                &target,
                profile,
                context,
                reservations,
                request,
            ) {
                candidates = choice.candidates;
                reason = choice.reason;
                ai.cover = Some(choice.position);
                ai.target = Some(choice.position);
                ai.mode = if squad_retreating {
                    SkirmisherMode::Engage
                } else {
                    SkirmisherMode::SeekCover
                };
                ai.next_decision_tick = self.runtime.durable.tick
                    + SKIRMISHER_DECISION_MIN_TICKS
                    + (ai_rand(ai.seed, self.runtime.durable.tick, 402)
                        * (SKIRMISHER_DECISION_MAX_TICKS - SKIRMISHER_DECISION_MIN_TICKS) as f64)
                        as u64;
            } else {
                reason = if squad_retreating {
                    "retreat_no_path"
                } else {
                    "cover_needed_no_cover"
                };
            }
        }

        if let Some(cover) = ai.cover {
            let distance_to_cover = position_distance_milli(actor.position, cover);
            if distance_to_cover > SKIRMISHER_COVER_REACHED_MILLI_CELLS {
                let moved = self.move_ai_actor_toward_position_pathing(actor_id, cover, step_milli);
                ai.mode = if cover_needed {
                    SkirmisherMode::SeekCover
                } else {
                    SkirmisherMode::Engage
                };
                if moved {
                    clear_skirmisher_blocked_target_near(
                        ai,
                        cover,
                        SKIRMISHER_BLOCKED_TARGET_RADIUS_MILLI_CELLS,
                        position_distance_milli,
                    );
                    self.record_skirmisher_debug(
                        actor,
                        ai,
                        profile,
                        context,
                        Some(cover),
                        reason,
                        candidates,
                    );
                    return true;
                }
                note_skirmisher_blocked_target(
                    ai,
                    self.runtime.durable.tick,
                    cover,
                    SKIRMISHER_BLOCKED_TARGET_MEMORY_TICKS,
                );
                if hard_suppressed {
                    ai.cover = None;
                    ai.target = None;
                    ai.mode = SkirmisherMode::Engage;
                    ai.next_decision_tick = self.runtime.durable.tick;
                }
                let request = TacticalEngagementPolicy {
                    require_shot: !hard_suppressed,
                    prefer_cover: false,
                    cover_required: false,
                    prefer_evasion: hard_suppressed || incoming_fire,
                    allow_offensive_maneuver: !(hard_suppressed
                        || incoming_fire
                        || squad_retreating),
                    allow_flank: profile.variant == SkirmisherVariant::Flanker,
                    allow_retreat: hard_suppressed || incoming_fire,
                };
                if let Some(choice) = self.best_skirmisher_tactical_choice(
                    actor,
                    Some(ai),
                    ai.seed,
                    &target,
                    profile,
                    context,
                    reservations,
                    request,
                ) {
                    let choice_step_milli = skirmisher_maneuver_step_milli(
                        step_milli,
                        choice.reason,
                        hard_suppressed || incoming_fire || recently_damaged || squad_retreating,
                    );
                    let moved = self.move_ai_actor_toward_position_pathing(
                        actor_id,
                        choice.position,
                        choice_step_milli,
                    );
                    if moved {
                        clear_skirmisher_blocked_target_near(
                            ai,
                            choice.position,
                            SKIRMISHER_BLOCKED_TARGET_RADIUS_MILLI_CELLS,
                            position_distance_milli,
                        );
                    } else {
                        note_skirmisher_blocked_target(
                            ai,
                            self.runtime.durable.tick,
                            choice.position,
                            SKIRMISHER_BLOCKED_TARGET_MEMORY_TICKS,
                        );
                    }
                    ai.target = if moved || !has_shot {
                        Some(choice.position)
                    } else {
                        None
                    };
                    ai.cover = None;
                    ai.mode = SkirmisherMode::Engage;
                    ai.next_decision_tick =
                        self.runtime.durable.tick + SKIRMISHER_DECISION_MIN_TICKS;
                    let debug_reason = if moved {
                        choice.reason
                    } else if has_shot {
                        "holding_firing_lane"
                    } else if hard_suppressed {
                        "cover_blocked_no_escape"
                    } else {
                        "cover_blocked_no_firing_lane"
                    };
                    let debug_target = if moved || !has_shot {
                        Some(choice.position)
                    } else {
                        None
                    };
                    self.record_skirmisher_debug(
                        actor,
                        ai,
                        profile,
                        context,
                        debug_target,
                        debug_reason,
                        choice.candidates,
                    );
                    return moved;
                }
                ai.cover = None;
                ai.target = None;
                ai.mode = SkirmisherMode::Engage;
                ai.next_decision_tick = self.runtime.durable.tick + SKIRMISHER_DECISION_MIN_TICKS;
                self.record_skirmisher_debug(
                    actor,
                    ai,
                    profile,
                    context,
                    if has_shot { None } else { Some(cover) },
                    if has_shot {
                        "holding_firing_lane"
                    } else if hard_suppressed {
                        "cover_blocked_no_escape"
                    } else {
                        "cover_blocked_no_firing_lane"
                    },
                    candidates,
                );
                return false;
            }

            if (hard_suppressed || incoming_fire || recently_damaged) && pressure_replan_due {
                let request = TacticalEngagementPolicy {
                    require_shot: false,
                    prefer_cover: false,
                    cover_required: false,
                    prefer_evasion: true,
                    allow_offensive_maneuver: false,
                    allow_flank: profile.variant == SkirmisherVariant::Flanker,
                    allow_retreat: true,
                };
                if let Some(choice) = self.best_skirmisher_tactical_choice(
                    actor,
                    Some(ai),
                    ai.seed,
                    &target,
                    profile,
                    context,
                    reservations,
                    request,
                ) {
                    let choice_step_milli = skirmisher_maneuver_step_milli(
                        step_milli,
                        choice.reason,
                        hard_suppressed || incoming_fire || recently_damaged || squad_retreating,
                    );
                    let moved = self.move_ai_actor_toward_position_pathing(
                        actor_id,
                        choice.position,
                        choice_step_milli,
                    );
                    if moved {
                        clear_skirmisher_blocked_target_near(
                            ai,
                            choice.position,
                            SKIRMISHER_BLOCKED_TARGET_RADIUS_MILLI_CELLS,
                            position_distance_milli,
                        );
                        ai.cover = None;
                        ai.target = Some(choice.position);
                        ai.mode = SkirmisherMode::Engage;
                        ai.next_decision_tick =
                            self.runtime.durable.tick + SKIRMISHER_DECISION_MIN_TICKS;
                    } else {
                        note_skirmisher_blocked_target(
                            ai,
                            self.runtime.durable.tick,
                            choice.position,
                            SKIRMISHER_BLOCKED_TARGET_MEMORY_TICKS,
                        );
                        ai.next_decision_tick = self.runtime.durable.tick.saturating_add(1);
                    }
                    self.record_skirmisher_debug(
                        actor,
                        ai,
                        profile,
                        context,
                        Some(choice.position),
                        if moved {
                            choice.reason
                        } else {
                            "cover_damage_escape_blocked"
                        },
                        choice.candidates,
                    );
                    if moved {
                        return true;
                    }
                }
            }

            if self.fire_skirmisher_if_ready(actor_id, actor, &target, ai, profile) {
                if !cover_needed && !profile.hold_cover_between_shots {
                    ai.cover = None;
                    ai.target = None;
                } else {
                    ai.cover = Some(cover);
                    ai.target = Some(cover);
                    ai.mode = SkirmisherMode::HoldCover;
                }
                self.record_skirmisher_debug(
                    actor,
                    ai,
                    profile,
                    context,
                    Some(cover),
                    "fired_from_cover",
                    candidates,
                );
                return true;
            }

            if self.runtime.durable.tick >= ai.next_shot_tick
                && (!has_shot || cover_needed)
                && self.runtime.durable.tick >= ai.next_decision_tick
            {
                let request = TacticalEngagementPolicy {
                    require_shot: true,
                    prefer_cover: false,
                    cover_required: false,
                    prefer_evasion: false,
                    allow_offensive_maneuver: !squad_retreating,
                    allow_flank: profile.variant == SkirmisherVariant::Flanker,
                    allow_retreat: false,
                };
                if let Some(choice) = self.best_skirmisher_tactical_choice(
                    actor,
                    Some(ai),
                    ai.seed,
                    &target,
                    profile,
                    context,
                    reservations,
                    request,
                ) {
                    let choice_step_milli = skirmisher_maneuver_step_milli(
                        step_milli,
                        choice.reason,
                        hard_suppressed || incoming_fire || recently_damaged || squad_retreating,
                    );
                    let moved = self.move_ai_actor_toward_position_pathing(
                        actor_id,
                        choice.position,
                        choice_step_milli,
                    );
                    if moved {
                        clear_skirmisher_blocked_target_near(
                            ai,
                            choice.position,
                            SKIRMISHER_BLOCKED_TARGET_RADIUS_MILLI_CELLS,
                            position_distance_milli,
                        );
                    } else {
                        note_skirmisher_blocked_target(
                            ai,
                            self.runtime.durable.tick,
                            choice.position,
                            SKIRMISHER_BLOCKED_TARGET_MEMORY_TICKS,
                        );
                    }
                    ai.target = Some(choice.position);
                    ai.cover = None;
                    ai.mode = SkirmisherMode::Engage;
                    ai.next_decision_tick =
                        self.runtime.durable.tick + SKIRMISHER_DECISION_MIN_TICKS;
                    self.record_skirmisher_debug(
                        actor,
                        ai,
                        profile,
                        context,
                        Some(choice.position),
                        if moved {
                            choice.reason
                        } else {
                            "peek_path_blocked"
                        },
                        choice.candidates,
                    );
                    return moved;
                }
            }

            if !cover_needed && self.runtime.durable.tick >= ai.next_decision_tick {
                ai.cover = None;
                ai.target = None;
                ai.mode = SkirmisherMode::Engage;
            }
            self.record_skirmisher_debug(
                actor,
                ai,
                profile,
                context,
                None,
                "holding_cover",
                candidates,
            );
            return false;
        }

        ai.mode = SkirmisherMode::Engage;
        if self.fire_skirmisher_if_ready(actor_id, actor, &target, ai, profile) {
            self.record_skirmisher_debug(actor, ai, profile, context, None, "fired", candidates);
            return true;
        }

        if !has_shot {
            let request = TacticalEngagementPolicy {
                require_shot: true,
                prefer_cover: false,
                cover_required: false,
                prefer_evasion: false,
                allow_offensive_maneuver: !squad_retreating,
                allow_flank: profile.variant == SkirmisherVariant::Flanker,
                allow_retreat: false,
            };
            if let Some(choice) = self.best_skirmisher_tactical_choice(
                actor,
                Some(ai),
                ai.seed,
                &target,
                profile,
                context,
                reservations,
                request,
            ) {
                ai.target = Some(choice.position);
                ai.next_decision_tick = self.runtime.durable.tick + SKIRMISHER_DECISION_MIN_TICKS;
                candidates = choice.candidates;
                reason = choice.reason;
            } else {
                reason = "no_firing_lane";
            }
        }

        if ai.target.is_none()
            || self.runtime.durable.tick >= ai.next_decision_tick
            || ai.target.is_some_and(|target| {
                position_distance_milli(actor.position, target)
                    <= SKIRMISHER_COVER_REACHED_MILLI_CELLS
            })
        {
            let request = TacticalEngagementPolicy {
                require_shot: false,
                prefer_cover: context.is_some_and(|ctx| {
                    ctx.squad.order == SkirmisherSquadOrder::Defend
                        || profile.hold_cover_between_shots
                }),
                cover_required: false,
                prefer_evasion: hard_suppressed || incoming_fire,
                allow_offensive_maneuver: !squad_retreating,
                allow_flank: profile.variant == SkirmisherVariant::Flanker,
                allow_retreat: squad_retreating,
            };
            if let Some(choice) = self.best_skirmisher_tactical_choice(
                actor,
                Some(ai),
                ai.seed,
                &target,
                profile,
                context,
                reservations,
                request,
            ) {
                ai.target = Some(choice.position);
                candidates = choice.candidates;
                reason = choice.reason;
            } else if direct_approach_allowed {
                if let Some(destination) = self.skirmisher_contact_approach_position(
                    actor,
                    &target,
                    profile,
                    context,
                    reservations,
                ) {
                    ai.target = Some(destination);
                    candidates = Vec::new();
                    reason = "advance_to_contact";
                } else {
                    ai.target = None;
                    reason = "no_tactical_position";
                }
            } else {
                ai.target = None;
                reason = "no_tactical_position";
            }
            ai.next_decision_tick = self.runtime.durable.tick
                + SKIRMISHER_DECISION_MIN_TICKS
                + (ai_rand(ai.seed, self.runtime.durable.tick, 403)
                    * (SKIRMISHER_DECISION_MAX_TICKS - SKIRMISHER_DECISION_MIN_TICKS) as f64)
                    as u64;
        }

        let mut moved = ai.target.is_some_and(|target| {
            self.move_ai_actor_toward_position_pathing(
                actor_id,
                target,
                skirmisher_maneuver_step_milli(
                    step_milli,
                    reason,
                    hard_suppressed || incoming_fire || recently_damaged || squad_retreating,
                ),
            )
        });
        let mut debug_target = ai.target;
        let mut debug_reason = if moved { reason } else { "no_move" };
        if let Some(target) = ai.target {
            if moved {
                clear_skirmisher_blocked_target_near(
                    ai,
                    target,
                    SKIRMISHER_BLOCKED_TARGET_RADIUS_MILLI_CELLS,
                    position_distance_milli,
                );
            } else {
                note_skirmisher_blocked_target(
                    ai,
                    self.runtime.durable.tick,
                    target,
                    SKIRMISHER_BLOCKED_TARGET_MEMORY_TICKS,
                );
            }
        }
        if direct_approach_allowed && !moved && !has_shot {
            if let Some(destination) = self.skirmisher_contact_approach_position(
                actor,
                &target,
                profile,
                context,
                reservations,
            ) {
                moved = self.move_ai_actor_toward_position_pathing(
                    actor_id,
                    destination,
                    skirmisher_maneuver_step_milli(
                        step_milli,
                        "advance_to_contact",
                        hard_suppressed || incoming_fire || recently_damaged || squad_retreating,
                    ),
                );
                if moved {
                    clear_skirmisher_blocked_target_near(
                        ai,
                        destination,
                        SKIRMISHER_BLOCKED_TARGET_RADIUS_MILLI_CELLS,
                        position_distance_milli,
                    );
                } else {
                    note_skirmisher_blocked_target(
                        ai,
                        self.runtime.durable.tick,
                        destination,
                        SKIRMISHER_BLOCKED_TARGET_MEMORY_TICKS,
                    );
                }
                ai.target = Some(destination);
                ai.cover = None;
                ai.mode = SkirmisherMode::Engage;
                ai.next_decision_tick = self
                    .runtime
                    .durable
                    .tick
                    .saturating_add(SKIRMISHER_DECISION_MIN_TICKS);
                debug_target = Some(destination);
                debug_reason = if moved {
                    "advance_to_contact"
                } else {
                    "advance_to_contact_blocked"
                };
                candidates = Vec::new();
            }
        }
        self.record_skirmisher_debug(
            actor,
            ai,
            profile,
            context,
            debug_target,
            debug_reason,
            candidates,
        );
        moved
    }
}
