use super::*;

impl SliceAuthorityState {
    pub(in crate::authority) fn record_skirmisher_debug(
        &mut self,
        actor: &ActorAuthorityState,
        ai: &SkirmisherAiState,
        profile: SkirmisherProfile,
        context: Option<&SkirmisherActorTacticalContext>,
        move_target: Option<AuthorityPosition>,
        reason: &'static str,
        mut candidates: Vec<AuthorityAiTacticalCandidateDebug>,
    ) {
        let target_actor = ai
            .target_actor_id
            .as_ref()
            .and_then(|target_id| self.runtime.durable.actors.get(target_id))
            .cloned();
        if candidates.is_empty() && !actor_uses_roll_simple_ranged_brain(actor) {
            if let Some(position) = move_target
                .or(ai.cover)
                .or(ai.target)
                .or_else(|| target_actor.as_ref().map(|target| target.position))
            {
                let has_shot = target_actor.as_ref().is_some_and(|target| {
                    self.skirmisher_has_shot_from_position(actor, position, target)
                });
                let protected = target_actor.as_ref().is_some_and(|target| {
                    self.actor_position_protected_from_threat(actor, position, target.position)
                });
                candidates.push(current_order_tactical_candidate(
                    reason,
                    authority_ai_debug_position_from_position(position),
                    has_shot,
                    protected,
                ));
            }
        }
        let target = target_actor
            .as_ref()
            .map(|target| authority_ai_debug_position_from_position(target.position));
        let situation = self.combat_situation_for_actor(
            actor,
            Some(ai),
            profile,
            context,
            target_actor.as_ref(),
        );
        let slot_claim = move_target
            .or(ai.cover)
            .or(ai.target)
            .map(authority_ai_debug_position_from_position);
        self.runtime
            .ai_debug
            .actors
            .push(authority_ai_actor_debug_snapshot(
                AuthorityAiActorDebugSnapshotRequest {
                    actor_id: actor.id.clone(),
                    squad_id: context.map(|ctx| ctx.squad.squad_id.clone()),
                    faction: context.map(|ctx| ctx.squad.faction.clone()),
                    variant: profile.variant.label().to_owned(),
                    mode: ai.mode.label().to_owned(),
                    order: context
                        .map_or("none", |ctx| ctx.squad.order.label())
                        .to_owned(),
                    confidence: context
                        .map_or("none", |ctx| ctx.squad.confidence.label())
                        .to_owned(),
                    situation: Some(authority_ai_situation_debug_snapshot(&situation)),
                    target_actor_id: ai.target_actor_id.clone(),
                    target,
                    cover: ai.cover.map(authority_ai_debug_position_from_position),
                    move_target: move_target.map(authority_ai_debug_position_from_position),
                    slot_claim,
                    lane_index: context
                        .and_then(|ctx| ctx.lane.as_ref().map(|lane| lane.lane_index)),
                    lane_count: context
                        .and_then(|ctx| ctx.lane.as_ref().map(|lane| lane.lane_count)),
                    reason: reason.to_owned(),
                    candidates,
                    candidate_limit: SKIRMISHER_TACTICAL_CANDIDATE_DEBUG_LIMIT,
                },
            ));
    }
}
