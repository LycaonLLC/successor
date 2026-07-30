use super::*;

impl SliceAuthorityState {
    pub(super) fn clamped_ai_position(
        &self,
        area_id: &str,
        position: AuthorityPosition,
    ) -> AuthorityPosition {
        let Some(area) = self.runtime.durable.world.areas.get(area_id) else {
            return position;
        };
        position.clamp_to_area(area)
    }

    pub(super) fn ai_tactical_position_near_world_edge(
        &self,
        area_id: &str,
        position: AuthorityPosition,
    ) -> bool {
        let Some(area) = self.runtime.durable.world.areas.get(area_id) else {
            return false;
        };
        let width = i32::try_from(area.width)
            .unwrap_or(i32::MAX / MILLI_CELLS_PER_CELL)
            .saturating_mul(MILLI_CELLS_PER_CELL);
        let height = i32::try_from(area.height)
            .unwrap_or(i32::MAX / MILLI_CELLS_PER_CELL)
            .saturating_mul(MILLI_CELLS_PER_CELL);
        tactical_position_near_world_edge(
            nav_position_from_authority_position(position),
            width,
            height,
            AI_TACTICAL_EDGE_MARGIN_MILLI_CELLS,
        )
    }

    pub(super) fn actor_position_protected_from_threat(
        &self,
        actor: &ActorAuthorityState,
        position: AuthorityPosition,
        threat: AuthorityPosition,
    ) -> bool {
        let protected_box =
            actor_hit_box_for_position(position, actor.scale, is_creature_body_actor(actor));
        let target_center = protected_box.center();
        !self.roll_line_of_sight_clear(&actor.area_id, threat, target_center)
    }

    pub(super) fn skirmisher_can_fire_at(
        &self,
        actor: &ActorAuthorityState,
        target: &ActorAuthorityState,
        profile: SkirmisherProfile,
    ) -> bool {
        if profile.variant != SkirmisherVariant::Brawler {
            let Some((_, max_milli)) = self.roll_range_bands_milli_for_actor(actor) else {
                return false;
            };
            return actor.area_id == target.area_id
                && target.life_state == AuthorityLifeState::Alive
                && self.can_actor_attack(actor, target)
                && position_distance_milli(actor.position, target.position) <= max_milli
                && self.roll_line_of_sight_clear_between_actors(actor, target);
        }
        if profile.variant == SkirmisherVariant::Brawler {
            return actor.area_id == target.area_id
                && target.life_state == AuthorityLifeState::Alive
                && self.can_actor_attack(actor, target)
                && position_distance_milli(actor.position, target.position)
                    <= profile.max_range_milli.saturating_add(250);
        }
        false
    }

    pub(super) fn skirmisher_has_shot_from_position(
        &self,
        actor: &ActorAuthorityState,
        position: AuthorityPosition,
        target: &ActorAuthorityState,
    ) -> bool {
        let mut probe = actor.clone();
        probe.position = position;
        probe.cell = position.cell();
        let Some((_, max_milli)) = self.roll_range_bands_milli_for_actor(&probe) else {
            return false;
        };
        probe.area_id == target.area_id
            && target.life_state == AuthorityLifeState::Alive
            && self.can_actor_attack(&probe, target)
            && position_distance_milli(probe.position, target.position) <= max_milli
            && self.roll_line_of_sight_clear_between_actors(&probe, target)
    }
}
