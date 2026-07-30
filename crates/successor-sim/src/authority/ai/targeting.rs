use super::*;

impl SliceAuthorityState {
    pub(in crate::authority) fn focused_skirmisher_target(
        &self,
        actor: &ActorAuthorityState,
        ai: &mut SkirmisherAiState,
    ) -> Option<ActorAuthorityState> {
        let target_id = ai.target_actor_id.as_ref()?;
        let target = self.runtime.durable.actors.get(target_id)?;
        let creature_pressure_blocked = is_passive_creature_actor(target)
            && self.directed_creature_target_blocked_by_near_ranged_pressure(actor, target);
        let target_priority_blocked = !is_passive_creature_actor(target)
            && !self.target_allowed_while_under_ranged_pressure(actor, target);
        if target.id == actor.id
            || target.area_id != actor.area_id
            || target.life_state != AuthorityLifeState::Alive
            || target.sleep.remaining_ticks > 0
            || !self.can_actor_attack(actor, target)
            || creature_pressure_blocked
            || target_priority_blocked
        {
            ai.target_actor_id = None;
            ai.target = None;
            ai.cover = None;
            return None;
        }
        Some(target.clone())
    }

    pub(in crate::authority) fn ranged_pressure_enemy_available(
        &self,
        actor: &ActorAuthorityState,
    ) -> bool {
        self.runtime.durable.actors.values().any(|candidate| {
            candidate.id != actor.id
                && candidate.area_id == actor.area_id
                && candidate.life_state == AuthorityLifeState::Alive
                && candidate.sleep.remaining_ticks == 0
                && skirmisher_enemy_applies_ranged_pressure(candidate)
                && self.can_actor_attack(actor, candidate)
        })
    }

    pub(in crate::authority) fn ranged_pressure_enemy_near_position(
        &self,
        actor: &ActorAuthorityState,
        position: AuthorityPosition,
        radius_milli: i32,
    ) -> bool {
        self.runtime.durable.actors.values().any(|candidate| {
            candidate.id != actor.id
                && candidate.area_id == actor.area_id
                && candidate.life_state == AuthorityLifeState::Alive
                && matches!(
                    self.faction_relationship(actor, candidate),
                    FactionRelationship::Enemy
                )
                && skirmisher_enemy_applies_ranged_pressure(candidate)
                && position_distance_milli(position, candidate.position) <= radius_milli
        })
    }

    pub(in crate::authority) fn directed_creature_target_blocked_by_near_ranged_pressure(
        &self,
        actor: &ActorAuthorityState,
        target: &ActorAuthorityState,
    ) -> bool {
        is_passive_creature_actor(target)
            && self.ranged_pressure_enemy_near_position(
                actor,
                target.position,
                SKIRMISHER_DIRECTED_CREATURE_PRESSURE_RADIUS_MILLI_CELLS,
            )
    }

    pub(in crate::authority) fn target_allowed_while_under_ranged_pressure(
        &self,
        actor: &ActorAuthorityState,
        candidate: &ActorAuthorityState,
    ) -> bool {
        if is_passive_creature_actor(candidate) {
            return false;
        }
        skirmisher_enemy_applies_ranged_pressure(candidate)
            || !self.ranged_pressure_enemy_available(actor)
    }

    pub(in crate::authority) fn ai_fire_target_allowed(
        &self,
        actor: &ActorAuthorityState,
        target: &ActorAuthorityState,
    ) -> bool {
        if is_passive_creature_actor(target) {
            !self.directed_creature_target_blocked_by_near_ranged_pressure(actor, target)
        } else {
            self.target_allowed_while_under_ranged_pressure(actor, target)
        }
    }

    pub(in crate::authority) fn nearest_skirmisher_target(
        &self,
        actor: &ActorAuthorityState,
        profile: SkirmisherProfile,
    ) -> Option<ActorAuthorityState> {
        self.runtime
            .durable
            .actors
            .values()
            .filter(|candidate| candidate.id != actor.id)
            .filter(|candidate| candidate.area_id == actor.area_id)
            .filter(|candidate| candidate.life_state == AuthorityLifeState::Alive)
            .filter(|candidate| candidate.sleep.remaining_ticks == 0)
            .filter(|candidate| self.can_actor_attack(actor, candidate))
            .filter(|candidate| self.target_allowed_while_under_ranged_pressure(actor, candidate))
            .filter(|candidate| {
                position_distance_milli(actor.position, candidate.position)
                    <= SKIRMISHER_ACQUIRE_RADIUS_MILLI_CELLS
            })
            .min_by(|left, right| {
                self.skirmisher_target_score(actor, left, profile)
                    .cmp(&self.skirmisher_target_score(actor, right, profile))
                    .then_with(|| left.id.cmp(&right.id))
            })
            .cloned()
    }

    pub(in crate::authority) fn skirmisher_far_contact_target(
        &self,
        actor: &ActorAuthorityState,
        profile: SkirmisherProfile,
    ) -> Option<ActorAuthorityState> {
        let max_distance = SKIRMISHER_ACQUIRE_RADIUS_MILLI_CELLS
            .saturating_mul(SKIRMISHER_FAR_CONTACT_ACQUIRE_MULTIPLIER);
        self.runtime
            .durable
            .actors
            .values()
            .filter(|candidate| candidate.id != actor.id)
            .filter(|candidate| candidate.area_id == actor.area_id)
            .filter(|candidate| candidate.life_state == AuthorityLifeState::Alive)
            .filter(|candidate| candidate.sleep.remaining_ticks == 0)
            .filter(|candidate| self.can_actor_attack(actor, candidate))
            .filter(|candidate| self.target_allowed_while_under_ranged_pressure(actor, candidate))
            .filter(|candidate| {
                position_distance_milli(actor.position, candidate.position) <= max_distance
            })
            .min_by(|left, right| {
                self.skirmisher_target_score(actor, left, profile)
                    .cmp(&self.skirmisher_target_score(actor, right, profile))
                    .then_with(|| left.id.cmp(&right.id))
            })
            .cloned()
    }

    /// Nearest attackable hostile in the same area, ignoring local acquire range.
    /// Used by skirmisher fallback paths that need a coarse same-area hostile
    /// before the per-shot visibility and pressure gates decide whether to fire.
    #[cfg(test)]
    pub(in crate::authority) fn nearest_attackable_actor_unbounded(
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
            .filter(|candidate| self.can_actor_attack(actor, candidate))
            .filter(|candidate| self.target_allowed_while_under_ranged_pressure(actor, candidate))
            .min_by(|left, right| {
                position_distance_milli(actor.position, left.position)
                    .cmp(&position_distance_milli(actor.position, right.position))
                    .then_with(|| left.id.cmp(&right.id))
            })
            .cloned()
    }

    /// Nearest reachable cover point that screens the actor from `threat_pos`.
    /// High cover is preferred, then proximity.
    #[cfg(test)]
    pub(in crate::authority) fn nearest_protective_cover_position(
        &self,
        actor: &ActorAuthorityState,
        threat_pos: AuthorityPosition,
        profile: SkirmisherProfile,
        reservations: &SkirmisherReservations,
    ) -> Option<AuthorityPosition> {
        let threat = skirmisher_cover_threat(actor, threat_pos);
        self.runtime
            .durable
            .world
            .cover_points
            .iter()
            .filter(|point| point.area_id == actor.area_id)
            .filter(|point| {
                position_distance_milli(actor.position, point.position)
                    <= profile.cover_search_radius_milli
            })
            .filter(|point| cover_point_protects_from_threat(point, threat))
            .filter(|point| !self.ai_position_blocked(&point.area_id, point.position))
            .filter(|point| !self.ai_position_clearance_blocked(&point.area_id, point.position))
            .filter(|point| !self.ai_actor_body_blocked(actor, point.position))
            .filter(|point| !self.skirmisher_candidate_claimed(actor, reservations, point.position))
            .min_by_key(|point| {
                (
                    !point.high,
                    position_distance_milli(actor.position, point.position),
                )
            })
            .map(|point| point.position)
    }

    pub(in crate::authority) fn preferred_skirmisher_target(
        &self,
        actor: &ActorAuthorityState,
        focused: Option<ActorAuthorityState>,
        nearest: Option<ActorAuthorityState>,
        profile: SkirmisherProfile,
    ) -> Option<ActorAuthorityState> {
        if focused.as_ref().is_some_and(|target| {
            is_passive_creature_actor(target)
                && (actor.professions.has(AuthorityProfessionKind::Brawler)
                    || actor.equipped_weapon_id.is_some_and(is_melee_weapon_id))
        }) {
            return focused;
        }
        match (focused, nearest) {
            (Some(focused), Some(nearest)) if focused.id != nearest.id => {
                let focused_has_shot = self.skirmisher_can_fire_at(actor, &focused, profile);
                let nearest_has_shot = self.skirmisher_can_fire_at(actor, &nearest, profile);
                let focused_is_dangerous = self.skirmisher_can_fire_at(
                    &focused,
                    actor,
                    skirmisher_profile_for_ai_state(&focused),
                );
                let nearest_is_dangerous = self.skirmisher_can_fire_at(
                    &nearest,
                    actor,
                    skirmisher_profile_for_ai_state(&nearest),
                );
                if (nearest_has_shot && !focused_has_shot)
                    || (nearest_is_dangerous && !focused_is_dangerous)
                {
                    Some(nearest)
                } else {
                    Some(focused)
                }
            }
            (Some(focused), _) => Some(focused),
            (None, Some(nearest)) => Some(nearest),
            (None, None) => None,
        }
    }

    #[cfg(test)]
    pub(in crate::authority) fn best_cover_position_for_actor(
        &self,
        actor: &ActorAuthorityState,
        threat: AuthorityPosition,
        profile: SkirmisherProfile,
    ) -> Option<AuthorityPosition> {
        self.runtime
            .durable
            .world
            .cover_points
            .iter()
            .filter(|point| point.area_id == actor.area_id)
            .filter(|point| cover_point_protects_from_threat(point, threat))
            .filter(|point| {
                position_distance_milli(actor.position, point.position)
                    <= profile.cover_search_radius_milli
            })
            .filter(|point| !self.ai_position_blocked(&point.area_id, point.position))
            .filter(|point| !self.ai_position_clearance_blocked(&point.area_id, point.position))
            .filter(|point| {
                self.actor_position_protected_from_threat(actor, point.position, threat)
            })
            .filter(|point| !self.cover_position_claimed(actor, point.position))
            .max_by_key(|point| cover_score_for_actor(point, actor, threat, profile))
            .map(|point| point.position)
    }

    #[cfg(test)]
    pub(in crate::authority) fn cover_position_claimed(
        &self,
        actor: &ActorAuthorityState,
        position: AuthorityPosition,
    ) -> bool {
        self.runtime.durable.actors.values().any(|candidate| {
            candidate.id != actor.id
                && candidate.area_id == actor.area_id
                && candidate.life_state == AuthorityLifeState::Alive
                && position_distance_milli(candidate.position, position) <= 650
        })
    }

    pub(in crate::authority) fn skirmisher_outgunned(&self, actor: &ActorAuthorityState) -> bool {
        let Some(_) = self.actor_faction_id(actor) else {
            return false;
        };
        let mut allies = 0_i32;
        let mut hostiles = 0_i32;
        for candidate in self.runtime.durable.actors.values() {
            if candidate.id == actor.id
                || candidate.area_id != actor.area_id
                || candidate.life_state != AuthorityLifeState::Alive
                || candidate.sleep.remaining_ticks > 0
                || position_distance_milli(actor.position, candidate.position) > 12_000
            {
                continue;
            }
            match self.faction_relationship(actor, candidate) {
                FactionRelationship::Same | FactionRelationship::Ally => allies += 1,
                FactionRelationship::Enemy
                    if skirmisher_enemy_applies_ranged_pressure(candidate) =>
                {
                    hostiles += 1
                }
                FactionRelationship::Enemy | FactionRelationship::Neutral => {}
            }
        }
        hostiles > allies + 1
    }

    pub(in crate::authority) fn skirmisher_target_score(
        &self,
        actor: &ActorAuthorityState,
        candidate: &ActorAuthorityState,
        profile: SkirmisherProfile,
    ) -> i64 {
        let dx = candidate.position.x - actor.position.x;
        let dy = candidate.position.y - actor.position.y;
        let distance = distance_milli_components(dx, dy);
        let range_error = (distance - profile.preferred_range_milli).abs();
        let lane_bonus = if dx.abs() <= 450 || dy.abs() <= 450 {
            3_200
        } else if dx.abs() <= 1_500 || dy.abs() <= 1_500 {
            1_400
        } else {
            0
        };
        let forward_bonus = if let Some((forward_x, forward_y)) = normalize_components_milli(dx, dy)
        {
            let facing = aim_vector_for_direction_name(&actor.direction);
            let dot = (i64::from(forward_x) * i64::from(facing.x_milli)
                + i64::from(forward_y) * i64::from(facing.y_milli))
                / i64::from(AIM_VECTOR_SCALE_MILLI);
            i32::try_from(dot.max(0) / 1_000).unwrap_or(0).min(1_200)
        } else {
            0
        };
        let ranged_pressure_bonus = if skirmisher_enemy_applies_ranged_pressure(candidate) {
            50_000
        } else {
            0
        };
        let close_melee_pressure_bonus = if actor_applies_close_melee_pressure(candidate)
            && distance
                <= close_melee_pressure_radius_milli(skirmisher_profile_for_ai_state(candidate))
        {
            90_000
        } else {
            0
        };
        let wounded_bonus = body_strain_milli(candidate) / 2;
        let shaken_bonus = spirit_strain_milli(candidate) / 4;
        i64::from(range_error / 5) + i64::from(distance / 28)
            - i64::from(lane_bonus)
            - i64::from(forward_bonus)
            - i64::from(wounded_bonus)
            - i64::from(shaken_bonus)
            - i64::from(ranged_pressure_bonus)
            - i64::from(close_melee_pressure_bonus)
    }

    pub(in crate::authority) fn actor_has_active_npc_job(&self, actor_id: &str) -> bool {
        self.runtime
            .durable
            .npc_jobs
            .iter()
            .any(|job| job.actor == actor_id && job.target_cell.is_some())
    }
}
