use super::*;

impl SliceAuthorityState {
    pub(in crate::authority) fn skirmisher_one_tick_step_milli(
        &self,
        actor: &ActorAuthorityState,
        profile: SkirmisherProfile,
    ) -> i32 {
        distance_for_ticks(
            scaled_milli(
                profile.speed_milli_cells_per_second,
                movement_speed_multiplier_milli_for_actor(actor),
            ),
            AI_UPDATE_CADENCE_TICKS,
            self.runtime.durable.world.tick_rate_hz,
        )
    }

    pub(in crate::authority) fn advance_skirmisher_locomotion_tick(
        &mut self,
        actor_id: &str,
        actor: &ActorAuthorityState,
        ai: &mut SkirmisherAiState,
        profile: SkirmisherProfile,
        context: Option<&SkirmisherActorTacticalContext>,
    ) -> bool {
        let Some(destination) = ai.cover.or(ai.target) else {
            return false;
        };
        if position_distance_milli(actor.position, destination)
            <= SKIRMISHER_COVER_REACHED_MILLI_CELLS
        {
            return false;
        }
        let base_step_milli = self.skirmisher_one_tick_step_milli(actor, profile);
        let step_milli = if profile.variant == SkirmisherVariant::Brawler {
            let lunge_distance = melee_strike_range_milli(profile)
                .saturating_add(BRAWLER_MELEE_LUNGE_START_MARGIN_MILLI_CELLS);
            if position_distance_milli(actor.position, destination) > lunge_distance {
                skirmisher_maneuver_step_milli(base_step_milli, "melee_advance", true)
            } else {
                base_step_milli
            }
        } else {
            base_step_milli
        };
        let moved = self.move_ai_actor_toward_position_pathing(actor_id, destination, step_milli);
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
        self.record_skirmisher_debug(
            actor,
            ai,
            profile,
            context,
            Some(destination),
            if moved {
                "continue_move"
            } else {
                "continue_move_blocked"
            },
            Vec::new(),
        );
        moved
    }

    pub(in crate::authority) fn nearest_close_melee_pressure_threat(
        &self,
        actor: &ActorAuthorityState,
    ) -> Option<ActorAuthorityState> {
        self.runtime
            .durable
            .actors
            .values()
            .filter(|candidate| candidate.id != actor.id)
            .filter(|candidate| candidate.area_id == actor.area_id)
            .filter(|candidate| candidate.life_state == AuthorityLifeState::Alive)
            .filter(|candidate| candidate.sleep.remaining_ticks == 0)
            .filter(|candidate| self.can_actor_attack(candidate, actor))
            .filter(|candidate| actor_applies_close_melee_pressure(candidate))
            .filter(|candidate| {
                let pressure_radius =
                    close_melee_pressure_radius_milli(skirmisher_profile_for_ai_state(candidate));
                position_distance_milli(actor.position, candidate.position) <= pressure_radius
            })
            .min_by(|left, right| {
                position_distance_milli(actor.position, left.position)
                    .cmp(&position_distance_milli(actor.position, right.position))
                    .then_with(|| left.id.cmp(&right.id))
            })
            .cloned()
    }

    pub(in crate::authority) fn close_melee_disengage_choice(
        &self,
        actor: &ActorAuthorityState,
        ai: Option<&SkirmisherAiState>,
        seed: u32,
        profile: SkirmisherProfile,
        threat: &ActorAuthorityState,
        context: Option<&SkirmisherActorTacticalContext>,
        reservations: &SkirmisherReservations,
    ) -> Option<SkirmisherTacticalChoice> {
        let request = TacticalEngagementPolicy {
            require_shot: false,
            prefer_cover: false,
            cover_required: false,
            prefer_evasion: true,
            allow_offensive_maneuver: false,
            allow_flank: false,
            allow_retreat: true,
        };
        self.best_skirmisher_tactical_choice(
            actor,
            ai,
            seed,
            threat,
            profile,
            context,
            reservations,
            request,
        )
    }
}
