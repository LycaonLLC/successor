use super::*;

impl SliceAuthorityState {
    pub(super) fn best_skirmisher_tactical_choice(
        &self,
        actor: &ActorAuthorityState,
        ai: Option<&SkirmisherAiState>,
        seed: u32,
        target: &ActorAuthorityState,
        profile: SkirmisherProfile,
        context: Option<&SkirmisherActorTacticalContext>,
        reservations: &SkirmisherReservations,
        request: TacticalEngagementPolicy,
    ) -> Option<SkirmisherTacticalChoice> {
        let situation = self.combat_situation_for_actor(actor, ai, profile, context, Some(target));
        let advanced_situation_scoring = actor_uses_advanced_combat_situation(actor);
        let request = if advanced_situation_scoring {
            tactical_policy_for_combat_situation(request, &situation)
        } else {
            request
        };
        let stages = tactical_stage_order(TacticalStageOrderRequest {
            prefer_cover: request.prefer_cover,
            prefer_evasion: request.prefer_evasion,
        });
        let mut debug = Vec::new();
        for stage in stages.iter().copied().map(SkirmisherTacticalStage::from) {
            if stage == SkirmisherTacticalStage::Flank && !request.allow_flank {
                continue;
            }
            if stage == SkirmisherTacticalStage::Retreat && !request.allow_retreat {
                continue;
            }
            let mut best: Option<(i64, i32, AuthorityPosition, &'static str)> = None;
            for (position, kind, cover_point) in self.skirmisher_tactical_candidates_for_stage(
                actor, seed, target, profile, context, stage, request,
            ) {
                best = self.consider_skirmisher_tactical_candidate(
                    best,
                    actor,
                    ai,
                    target,
                    profile,
                    context,
                    reservations,
                    request,
                    stage,
                    position,
                    kind,
                    cover_point.as_ref(),
                    advanced_situation_scoring.then_some(&situation),
                    &mut debug,
                );
            }
            if best.is_some() {
                if let Some((position, reason)) =
                    self.best_reachable_skirmisher_tactical_choice(actor, stage, &mut debug)
                {
                    return Some(SkirmisherTacticalChoice {
                        position,
                        reason,
                        candidates: debug,
                    });
                }
            }
        }
        if debug.is_empty() {
            debug.push(no_tactical_candidates_debug(
                authority_ai_debug_position_from_position(actor.position),
            ));
        }
        None
    }

    pub(super) fn best_reachable_skirmisher_tactical_choice(
        &self,
        actor: &ActorAuthorityState,
        stage: SkirmisherTacticalStage,
        debug: &mut [AuthorityAiTacticalCandidateDebug],
    ) -> Option<(AuthorityPosition, &'static str)> {
        let stage_label = stage.label();
        let candidates = debug
            .iter()
            .enumerate()
            .filter(|(_, candidate)| candidate.accepted && candidate.stage == stage_label)
            .map(|(index, candidate)| {
                let position = AuthorityPosition {
                    x: candidate.position.x_milli,
                    y: candidate.position.y_milli,
                };
                let tie_breaker = -position_distance_milli(actor.position, position);
                TacticalExecutionCandidate {
                    index,
                    score: candidate.score,
                    tie_breaker,
                    position,
                    kind: candidate.kind.as_str(),
                }
            })
            .collect::<Vec<_>>();
        let selection = select_reachable_tactical_candidate(
            candidates,
            SKIRMISHER_REACHABLE_CANDIDATE_PROBE_LIMIT,
            |position| self.ai_tactical_candidate_reachable(actor, position),
        );
        for index in selection.rejected_indices {
            if let Some(candidate) = debug.get_mut(index) {
                candidate.accepted = false;
                candidate.rejection = Some("no_path".to_owned());
                candidate.pathable = false;
                candidate.pathfinder_pathable = false;
            }
        }
        selection
            .choice
            .map(|choice| (choice.position, choice.reason))
    }

    pub(super) fn ai_tactical_candidate_reachable(
        &self,
        actor: &ActorAuthorityState,
        position: AuthorityPosition,
    ) -> bool {
        tactical_candidate_reachable(
            actor.position,
            position,
            |from, to| self.ai_actor_direct_corridor_clear(actor, from, to),
            |position| actor.cell == position.cell(),
            |position| self.find_ai_cell_path(actor, position.cell()).is_some(),
        )
    }

    pub(super) fn skirmisher_tactical_candidates_for_stage(
        &self,
        actor: &ActorAuthorityState,
        seed: u32,
        target: &ActorAuthorityState,
        profile: SkirmisherProfile,
        context: Option<&SkirmisherActorTacticalContext>,
        stage: SkirmisherTacticalStage,
        request: TacticalEngagementPolicy,
    ) -> Vec<(
        AuthorityPosition,
        &'static str,
        Option<CoverPointAuthorityState>,
    )> {
        let mut candidates = Vec::new();
        let threat = skirmisher_cover_threat(actor, target.position);
        match stage {
            SkirmisherTacticalStage::GoodCover | SkirmisherTacticalStage::SoftCover => {
                let cover_points = self
                    .runtime
                    .durable
                    .world
                    .cover_points
                    .iter()
                    .filter(|point| point.area_id == actor.area_id)
                    .cloned()
                    .collect::<Vec<_>>();
                let tactical_points =
                    cover_points
                        .iter()
                        .enumerate()
                        .map(|(source_index, point)| TacticalCoverPoint {
                            source_index,
                            point: tactical_point_from_authority_position(point.position),
                            high: point.high,
                            rating_milli: point.rating_milli,
                            protects_from_threat: cover_point_protects_from_threat(point, threat),
                        });
                for candidate in cover_candidates(
                    TacticalCoverRequest {
                        actor: tactical_point_from_authority_position(actor.position),
                        search_radius_milli: profile.cover_search_radius_milli,
                        soft_cover_extra_radius_milli: 3_000,
                        min_good_cover_rating_milli: 500,
                        stage: match stage {
                            SkirmisherTacticalStage::GoodCover => TacticalCoverStage::Good,
                            _ => TacticalCoverStage::Soft,
                        },
                    },
                    tactical_points,
                ) {
                    let Some(cover_point) = cover_points.get(candidate.source_index) else {
                        continue;
                    };
                    candidates.push((
                        authority_position_from_tactical_point(candidate.point),
                        candidate.kind,
                        Some(cover_point.clone()),
                    ));
                }
            }
            SkirmisherTacticalStage::FiringLane => {
                push_authority_tactical_candidates(
                    &mut candidates,
                    firing_lane_candidates(TacticalFiringLaneRequest {
                        actor: tactical_point_from_authority_position(actor.position),
                        target: tactical_point_from_authority_position(target.position),
                        direction: tactical_direction_for_stage(actor, target, context),
                        formation: tactical_formation_from_context(context),
                        range: tactical_range_from_profile(profile),
                        evasion_step_milli: committed_evasion_step_milli(
                            SKIRMISHER_EVASION_STEP_MILLI_CELLS,
                            request.prefer_evasion,
                        ),
                        jitter: (context.is_none()).then(|| {
                            (
                                ((ai_rand(
                                    seed,
                                    self.runtime.durable.tick / SKIRMISHER_DECISION_MAX_TICKS,
                                    414,
                                ) - 0.5)
                                    * 1_400.0)
                                    .round() as i32,
                                ((ai_rand(
                                    seed,
                                    self.runtime.durable.tick / SKIRMISHER_DECISION_MAX_TICKS,
                                    415,
                                ) - 0.5)
                                    * 1_400.0)
                                    .round() as i32,
                            )
                        }),
                        kind: "firing_lane",
                    }),
                );
            }
            SkirmisherTacticalStage::Evasion => {
                push_authority_tactical_candidates(
                    &mut candidates,
                    evasion_candidates(TacticalEvasionRequest {
                        actor: tactical_point_from_authority_position(actor.position),
                        direction: tactical_direction_for_stage(actor, target, context),
                        evasion_step_milli: committed_evasion_step_milli(
                            SKIRMISHER_EVASION_STEP_MILLI_CELLS,
                            request.prefer_evasion,
                        ),
                        lane_width_milli: SKIRMISHER_LANE_WIDTH_MILLI_CELLS,
                    }),
                );
            }
            SkirmisherTacticalStage::AdvanceLine => {
                push_authority_tactical_candidates(
                    &mut candidates,
                    advance_line_candidates(TacticalAdvanceLineRequest {
                        actor: tactical_point_from_authority_position(actor.position),
                        target: tactical_point_from_authority_position(target.position),
                        formation: tactical_formation_from_context(context),
                        range: tactical_range_from_profile(profile),
                        no_mans_land_margin_milli: SKIRMISHER_NO_MANS_LAND_MARGIN_MILLI_CELLS,
                        frontline_min_standoff_milli: SKIRMISHER_FRONTLINE_MIN_STANDOFF_MILLI_CELLS,
                    }),
                );
            }
            SkirmisherTacticalStage::Flank => {
                push_authority_tactical_candidates(
                    &mut candidates,
                    flank_candidates(TacticalFlankRequest {
                        target: tactical_point_from_authority_position(target.position),
                        formation: tactical_formation_from_context(context),
                        range: tactical_range_from_profile(profile),
                    }),
                );
            }
            SkirmisherTacticalStage::Retreat => {
                push_authority_tactical_candidates(
                    &mut candidates,
                    retreat_candidates(TacticalRetreatRequest {
                        actor: tactical_point_from_authority_position(actor.position),
                        home: tactical_point_from_authority_position(AuthorityPosition::from_cell(
                            actor.home_cell,
                        )),
                        formation: tactical_formation_from_context(context),
                        range: tactical_range_from_profile(profile),
                    }),
                );
            }
        }
        candidates
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn consider_skirmisher_tactical_candidate(
        &self,
        best: Option<(i64, i32, AuthorityPosition, &'static str)>,
        actor: &ActorAuthorityState,
        ai: Option<&SkirmisherAiState>,
        target: &ActorAuthorityState,
        profile: SkirmisherProfile,
        context: Option<&SkirmisherActorTacticalContext>,
        reservations: &SkirmisherReservations,
        request: TacticalEngagementPolicy,
        stage: SkirmisherTacticalStage,
        position: AuthorityPosition,
        kind: &'static str,
        cover_point: Option<&CoverPointAuthorityState>,
        situation: Option<&CombatSituationSnapshot>,
        debug: &mut Vec<AuthorityAiTacticalCandidateDebug>,
    ) -> Option<(i64, i32, AuthorityPosition, &'static str)> {
        let candidate = self.clamped_ai_position(&actor.area_id, position);
        let near_world_edge = self.ai_tactical_position_near_world_edge(&actor.area_id, candidate);
        let terrain_blocked = self.ai_position_blocked(&actor.area_id, candidate);
        let body_blocked = self.ai_actor_body_blocked(actor, candidate);
        let clearance_blocked = self.ai_position_clearance_blocked(&actor.area_id, candidate);
        let squad_slot_conflict = self.ai_same_squad_slot_conflicts(actor, candidate);
        let recently_blocked = skirmisher_target_recently_blocked(
            ai,
            self.runtime.durable.tick,
            candidate,
            SKIRMISHER_BLOCKED_TARGET_RADIUS_MILLI_CELLS,
            position_distance_milli,
        );
        let blocked = terrain_blocked || body_blocked || clearance_blocked || squad_slot_conflict;
        let actor_distance = position_distance_milli(actor.position, candidate);
        let target_distance = position_distance_milli(candidate, target.position);
        let range_error = (target_distance - profile.preferred_range_milli).abs();
        let scoring_stage = tactical_stage_kind(stage);
        let too_far = tactical_candidate_too_far(TacticalCandidateDistanceLimitRequest {
            stage: scoring_stage,
            actor_distance_milli: actor_distance,
            cover_search_radius_milli: profile.cover_search_radius_milli,
            max_range_milli: profile.max_range_milli,
            acquire_radius_milli: SKIRMISHER_ACQUIRE_RADIUS_MILLI_CELLS,
            retreat_extra_milli: 8_000,
            default_extra_milli: 3_000,
        });
        let lane_error = self.skirmisher_lane_error_milli(candidate, context);
        let inside_lane = tactical_candidate_inside_lane_for_stage(
            scoring_stage,
            tactical_stage_needs_lane_probe(scoring_stage)
                && self.skirmisher_candidate_inside_lane(candidate, context),
        );
        let crosses_no_mans_land = tactical_candidate_crosses_no_mans_land_for_stage(
            scoring_stage,
            tactical_stage_needs_no_mans_land_probe(scoring_stage)
                && self.skirmisher_crosses_no_mans_land(candidate, context),
        );
        let bad_range = tactical_candidate_bad_range(TacticalCandidateBadRangeRequest {
            stage: scoring_stage,
            target_distance_milli: target_distance,
            min_range_milli: profile.min_range_milli,
            max_range_milli: profile.max_range_milli,
            prefer_cover: request.prefer_cover,
        });
        let claimed = !blocked
            && !too_far
            && self.skirmisher_candidate_claimed(actor, reservations, candidate);
        let raw_has_shot =
            tactical_candidate_raw_shot_probe_open(TacticalCandidateRawShotProbeRequest {
                stage: scoring_stage,
                target_distance_milli: target_distance,
                max_range_milli: profile.max_range_milli,
                blocked,
                too_far,
                claimed,
                crosses_no_mans_land,
                bad_range,
            }) && self.skirmisher_has_shot_from_position(actor, candidate, target);

        let cover_score = cover_point.map_or(0_i64, |point| {
            cover_score_for_tactical_candidate(TacticalCoverScoreRequest {
                rating_milli: point.rating_milli,
                high: point.high,
                anchor_profile: profile.variant == SkirmisherVariant::Anchor,
                actor_distance_milli: position_distance_milli(actor.position, point.position),
                threat_distance_milli: position_distance_milli(target.position, point.position),
            })
        });
        let cover_shadow_penalty = cover_point.map_or(0, |point| {
            cover_shadow_penalty_for_tactical_candidate(TacticalCoverShadowPenaltyRequest {
                candidate_x_milli: candidate.x,
                candidate_y_milli: candidate.y,
                prop_left_milli: point.prop_left,
                prop_right_milli: point.prop_right,
                prop_top_milli: point.prop_top,
                prop_bottom_milli: point.prop_bottom,
            })
        });
        let min_reposition_milli = tactical_min_reposition_milli(
            SKIRMISHER_MIN_TACTICAL_REPOSITION_MILLI_CELLS,
            request.prefer_evasion,
        );
        let candidate_open_for_probe =
            tactical_candidate_open_for_live_probe(TacticalCandidateOpenProbeRequest {
                stage: scoring_stage,
                actor_distance_milli: actor_distance,
                min_reposition_milli,
                terrain_blocked,
                body_blocked,
                clearance_blocked,
                recently_blocked,
                near_world_edge,
                has_cover_point: cover_point.is_some(),
                too_far,
                claimed,
                crosses_no_mans_land,
                inside_lane_before_shot: inside_lane,
                raw_has_shot,
                bad_range,
            });
        let should_probe_protection =
            tactical_candidate_should_probe_protection(scoring_stage, request.cover_required);
        let protected_by_cover = candidate_open_for_probe
            && should_probe_protection
            && self.actor_position_protected_from_threat(
                actor,
                candidate,
                skirmisher_cover_threat(actor, target.position),
            );
        let exposed_to_target = candidate_open_for_probe
            && tactical_candidate_should_probe_exposure(scoring_stage)
            && self.skirmisher_candidate_exposed_to_target(actor, target, candidate);
        let candidate_score = score_tactical_candidate(TacticalCandidateScoreRequest {
            stage: scoring_stage,
            actor_distance_milli: actor_distance,
            range_error_milli: range_error,
            lane_error_milli: lane_error,
            flank_value_milli: self.skirmisher_flank_value_milli(candidate, context),
            spacing_penalty_milli: self.skirmisher_ally_spacing_penalty(
                actor,
                reservations,
                candidate,
            ),
            cover_shadow_penalty_milli: cover_shadow_penalty,
            cover_score,
            near_world_edge,
            has_cover_point: cover_point.is_some(),
            terrain_blocked,
            body_blocked,
            clearance_blocked,
            recently_blocked,
            too_far,
            claimed,
            crosses_no_mans_land,
            inside_lane_before_shot: inside_lane,
            bad_range,
            raw_has_shot,
            require_shot: request.require_shot,
            cover_required: request.cover_required,
            prefer_evasion: request.prefer_evasion,
            allow_offensive_maneuver: request.allow_offensive_maneuver,
            situation_bias_score: situation
                .map(|situation| tactical_situation_stage_score_bias(situation, scoring_stage))
                .unwrap_or(0),
            tactic_bias_score: 0,
            protected_by_cover,
            exposed_to_target,
            min_reposition_milli,
        });
        if debug.len() < SKIRMISHER_TACTICAL_CANDIDATE_DEBUG_LIMIT || candidate_score.accepted {
            debug.push(authority_ai_tactical_candidate_debug(
                AuthorityAiTacticalCandidateDebugRequest {
                    stage: stage.label().to_owned(),
                    kind: kind.to_owned(),
                    position: authority_ai_debug_position_from_position(candidate),
                    score: candidate_score.score,
                    accepted: candidate_score.accepted,
                    rejection: candidate_score.rejection.map(str::to_owned),
                    has_shot: candidate_score.has_shot,
                    protected: candidate_score.protected,
                    pathable: candidate_score.pathable,
                    terrain_pathable: candidate_score.terrain_pathable,
                    pathfinder_pathable: candidate_score.pathfinder_pathable,
                    body_blocked,
                    claimed: candidate_score.claimed,
                    inside_lane: candidate_score.inside_lane,
                    crosses_no_mans_land: candidate_score.crosses_no_mans_land,
                    range_error_milli: range_error,
                    lane_error_milli: lane_error,
                    cover_prop_id: cover_point.map(|point| point.prop_id.clone()),
                },
            ));
        }
        if !candidate_score.accepted {
            return best;
        }

        let tie_breaker = -actor_distance;
        match best {
            Some(existing @ (best_score, best_tie, _, _))
                if (candidate_score.score, tie_breaker) <= (best_score, best_tie) =>
            {
                Some(existing)
            }
            _ => Some((candidate_score.score, tie_breaker, candidate, kind)),
        }
    }

    pub(super) fn skirmisher_candidate_claimed(
        &self,
        actor: &ActorAuthorityState,
        reservations: &SkirmisherReservations,
        position: AuthorityPosition,
    ) -> bool {
        tactical_candidate_claimed(
            TacticalCandidateClaimRequest {
                actor_id: actor.id.as_str(),
                area_id: actor.area_id.as_str(),
                position,
                claim_radius_milli: 850,
            },
            reservations.claims.iter().map(tactical_position_claim),
            position_distance_milli,
        )
    }

    pub(super) fn combat_slot_position(
        &self,
        actor: &ActorAuthorityState,
        destination: AuthorityPosition,
        context: Option<&SkirmisherActorTacticalContext>,
        reservations: &SkirmisherReservations,
    ) -> AuthorityPosition {
        self.select_authority_tactical_slot(actor, destination, context, reservations, false, None)
    }

    pub(super) fn combat_interaction_slot_position(
        &self,
        actor: &ActorAuthorityState,
        anchor: AuthorityPosition,
        context: Option<&SkirmisherActorTacticalContext>,
        reservations: &SkirmisherReservations,
        max_anchor_distance: Option<i32>,
    ) -> AuthorityPosition {
        self.select_authority_tactical_slot(
            actor,
            anchor,
            context,
            reservations,
            true,
            max_anchor_distance,
        )
    }

    pub(super) fn select_authority_tactical_slot(
        &self,
        actor: &ActorAuthorityState,
        anchor: AuthorityPosition,
        context: Option<&SkirmisherActorTacticalContext>,
        reservations: &SkirmisherReservations,
        reject_anchor: bool,
        max_anchor_distance: Option<i32>,
    ) -> AuthorityPosition {
        let context = context.map(|ctx| TacticalSlotContext {
            lateral_x_milli: ctx.squad.lateral_x_milli,
            lateral_y_milli: ctx.squad.lateral_y_milli,
            lane_center_offset_milli: ctx.lane.as_ref().map_or(0, |lane| lane.center_offset_milli),
            lane_width_milli: SKIRMISHER_LANE_WIDTH_MILLI_CELLS,
        });
        let request = TacticalSlotRequest {
            actor_hash: string_hash32(&actor.id),
            actor_position: tactical_point_from_authority_position(actor.position),
            anchor: tactical_point_from_authority_position(anchor),
            slot_distance_milli: AI_ACTOR_BODY_SEPARATION_MILLI_CELLS
                .saturating_mul(2)
                .max(MILLI_CELLS_PER_CELL),
            inner_slot_distance_milli: AI_ACTOR_BODY_SEPARATION_MILLI_CELLS,
            reject_anchor,
            max_anchor_distance_milli: max_anchor_distance,
            context,
        };
        let selected = select_tactical_slot(
            request,
            |point| {
                tactical_point_from_authority_position(self.clamped_ai_position(
                    &actor.area_id,
                    authority_position_from_tactical_point(point),
                ))
            },
            |point| {
                self.ai_destination_available(
                    actor,
                    authority_position_from_tactical_point(point),
                    reservations,
                )
            },
        );
        authority_position_from_tactical_point(selected)
    }

    pub(super) fn ai_destination_available(
        &self,
        actor: &ActorAuthorityState,
        candidate: AuthorityPosition,
        reservations: &SkirmisherReservations,
    ) -> bool {
        position_distance_milli(candidate, actor.position) > 1
            && !self.ai_position_blocked(&actor.area_id, candidate)
            && !self.ai_position_clearance_blocked(&actor.area_id, candidate)
            && !self.ai_actor_body_blocked(actor, candidate)
            && !self.ai_same_squad_slot_conflicts(actor, candidate)
            && !self.skirmisher_candidate_claimed(actor, reservations, candidate)
    }

    /// Same-squad SLOT-SELECTION separation (owner ruling 2026-07-04: actors
    /// never block movement — this is assignment-level spread only, the same
    /// class as population spawn scatter). A candidate stand point conflicts
    /// when a LIVING SQUADMATE already stands within body separation of it;
    /// strangers, corpses, and players never matter here.
    pub(super) fn ai_same_squad_slot_conflicts(
        &self,
        actor: &ActorAuthorityState,
        candidate: AuthorityPosition,
    ) -> bool {
        let social_group = actor.faction.social_group.as_deref();
        let faction_id = actor.faction.faction_id.as_deref();
        if social_group.is_none() && faction_id.is_none() {
            return false;
        }
        for other in self.runtime.durable.actors.values() {
            if other.id == actor.id
                || other.life_state != AuthorityLifeState::Alive
                || other.area_id != actor.area_id
            {
                continue;
            }
            if !same_respawn_squad(social_group, faction_id, other) {
                continue;
            }
            if position_distance_milli(other.position, candidate)
                < AI_ACTOR_BODY_SEPARATION_MILLI_CELLS
            {
                return true;
            }
        }
        false
    }

    pub(super) fn skirmisher_lane_error_milli(
        &self,
        position: AuthorityPosition,
        context: Option<&SkirmisherActorTacticalContext>,
    ) -> i32 {
        let Some(ctx) = context else {
            return 0;
        };
        let Some(lane) = ctx.lane.as_ref() else {
            return 0;
        };
        tactical_lane_error_milli(TacticalLaneErrorRequest {
            position: tactical_point_from_authority_position(position),
            origin: tactical_point_from_authority_position(ctx.squad.center),
            lateral_x_milli: ctx.squad.lateral_x_milli,
            lateral_y_milli: ctx.squad.lateral_y_milli,
            min_offset_milli: lane.min_offset_milli,
            max_offset_milli: lane.max_offset_milli,
        })
    }

    pub(super) fn skirmisher_candidate_inside_lane(
        &self,
        position: AuthorityPosition,
        context: Option<&SkirmisherActorTacticalContext>,
    ) -> bool {
        tactical_position_inside_lane(
            self.skirmisher_lane_error_milli(position, context),
            SKIRMISHER_LANE_WIDTH_MILLI_CELLS,
        )
    }

    pub(super) fn skirmisher_crosses_no_mans_land(
        &self,
        position: AuthorityPosition,
        context: Option<&SkirmisherActorTacticalContext>,
    ) -> bool {
        let Some(ctx) = context else {
            return false;
        };
        let Some(no_mans_land) = ctx.squad.no_mans_land else {
            return false;
        };
        tactical_position_crosses_no_mans_land(TacticalNoMansLandRequest {
            position: tactical_point_from_authority_position(position),
            no_mans_land: tactical_point_from_authority_position(no_mans_land),
            direction_x_milli: ctx.squad.direction_x_milli,
            direction_y_milli: ctx.squad.direction_y_milli,
            margin_milli: SKIRMISHER_NO_MANS_LAND_MARGIN_MILLI_CELLS,
        })
    }

    pub(super) fn skirmisher_candidate_exposed_to_target(
        &self,
        actor: &ActorAuthorityState,
        target: &ActorAuthorityState,
        position: AuthorityPosition,
    ) -> bool {
        if self.actor_position_protected_from_threat(actor, position, target.position) {
            return false;
        }
        let mut probe = actor.clone();
        probe.position = position;
        probe.cell = position.cell();
        self.skirmisher_can_fire_at(target, &probe, skirmisher_profile_for_ai_state(target))
    }

    pub(super) fn skirmisher_flank_value_milli(
        &self,
        position: AuthorityPosition,
        context: Option<&SkirmisherActorTacticalContext>,
    ) -> i32 {
        let Some(ctx) = context else {
            return 0;
        };
        tactical_flank_value_milli(TacticalFlankValueRequest {
            position: tactical_point_from_authority_position(position),
            origin: tactical_point_from_authority_position(ctx.squad.center),
            lateral_x_milli: ctx.squad.lateral_x_milli,
            lateral_y_milli: ctx.squad.lateral_y_milli,
            max_value_milli: 8_000,
        })
    }

    pub(super) fn skirmisher_ally_spacing_penalty(
        &self,
        actor: &ActorAuthorityState,
        reservations: &SkirmisherReservations,
        position: AuthorityPosition,
    ) -> i32 {
        tactical_ally_spacing_penalty(
            TacticalAllySpacingPenaltyRequest {
                actor_id: actor.id.as_str(),
                area_id: actor.area_id.as_str(),
                position,
                spacing_radius_milli: 2_000,
            },
            reservations.claims.iter().map(tactical_position_claim),
            position_distance_milli,
        )
    }
}
