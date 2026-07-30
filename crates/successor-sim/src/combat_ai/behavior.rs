use super::affordance::{
    assign_distinct_cover_slots, distance_cells, exposure_score, has_peek_option,
    nearest_reachable_open_cell, select_cover, select_evasion_target, PrimitiveCell, PrimitiveMap,
};
use super::query::{PrimitiveQueryKind, PrimitiveTacticalQuery};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TacticalStageKind {
    GoodCover,
    SoftCover,
    Evasion,
    FiringLane,
    AdvanceLine,
    Flank,
    Retreat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalStageOrderRequest {
    pub(crate) prefer_cover: bool,
    pub(crate) prefer_evasion: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalEngagementPolicy {
    pub(crate) require_shot: bool,
    pub(crate) prefer_cover: bool,
    pub(crate) cover_required: bool,
    pub(crate) prefer_evasion: bool,
    pub(crate) allow_offensive_maneuver: bool,
    pub(crate) allow_flank: bool,
    pub(crate) allow_retreat: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalCoverNeedRequest {
    pub(crate) current_action: i32,
    pub(crate) max_action: i32,
    pub(crate) suppression_pressure_milli: i32,
    pub(crate) cover_pressure_milli: i32,
    pub(crate) low_action_cover_percent: i32,
    pub(crate) hold_cover_between_shots: bool,
    pub(crate) tick: u64,
    pub(crate) next_shot_tick: u64,
    pub(crate) outgunned: bool,
}

const COVER_EVASION_STAGE_ORDER: &[TacticalStageKind] = &[
    TacticalStageKind::GoodCover,
    TacticalStageKind::SoftCover,
    TacticalStageKind::Evasion,
    TacticalStageKind::FiringLane,
    TacticalStageKind::AdvanceLine,
    TacticalStageKind::Flank,
    TacticalStageKind::Retreat,
];

const EVASION_STAGE_ORDER: &[TacticalStageKind] = &[
    TacticalStageKind::Evasion,
    TacticalStageKind::FiringLane,
    TacticalStageKind::GoodCover,
    TacticalStageKind::AdvanceLine,
    TacticalStageKind::Flank,
    TacticalStageKind::SoftCover,
    TacticalStageKind::Retreat,
];

const COVER_STAGE_ORDER: &[TacticalStageKind] = &[
    TacticalStageKind::GoodCover,
    TacticalStageKind::SoftCover,
    TacticalStageKind::FiringLane,
    TacticalStageKind::AdvanceLine,
    TacticalStageKind::Flank,
    TacticalStageKind::Retreat,
];

const OPEN_STAGE_ORDER: &[TacticalStageKind] = &[
    TacticalStageKind::FiringLane,
    TacticalStageKind::GoodCover,
    TacticalStageKind::AdvanceLine,
    TacticalStageKind::Flank,
    TacticalStageKind::SoftCover,
    TacticalStageKind::Retreat,
];

pub(crate) fn tactical_stage_order(
    request: TacticalStageOrderRequest,
) -> &'static [TacticalStageKind] {
    match (request.prefer_cover, request.prefer_evasion) {
        (true, true) => COVER_EVASION_STAGE_ORDER,
        (false, true) => EVASION_STAGE_ORDER,
        (true, false) => COVER_STAGE_ORDER,
        (false, false) => OPEN_STAGE_ORDER,
    }
}

pub(crate) fn tactical_cover_needed(request: TacticalCoverNeedRequest) -> bool {
    let max_action = request.max_action.max(1);
    let low_action = i64::from(request.current_action.max(0)).saturating_mul(100)
        <= i64::from(max_action).saturating_mul(i64::from(request.low_action_cover_percent));
    request.suppression_pressure_milli >= request.cover_pressure_milli
        || low_action
        || request.outgunned
        || (request.hold_cover_between_shots && request.tick < request.next_shot_tick)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PrimitiveBehaviorDecision {
    pub(crate) reason: &'static str,
    pub(crate) target: PrimitiveCell,
    pub(crate) tactical: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PrimitiveBehaviorAssignment {
    pub(crate) actor_id: &'static str,
    pub(crate) actor: PrimitiveCell,
    pub(crate) decision: PrimitiveBehaviorDecision,
}

pub(crate) fn choose_assignments(
    map: &PrimitiveMap,
    query: &PrimitiveTacticalQuery,
) -> Option<Vec<PrimitiveBehaviorAssignment>> {
    let assignments = match query.kind {
        PrimitiveQueryKind::Advance { target, threat } => {
            let actor = query.primary_actor()?;
            vec![PrimitiveBehaviorAssignment {
                actor_id: actor.id,
                actor: actor.cell,
                decision: choose_advance(map, actor.cell, target, threat),
            }]
        }
        PrimitiveQueryKind::ReachableMove { target, reason } => {
            let actor = query.primary_actor()?;
            vec![PrimitiveBehaviorAssignment {
                actor_id: actor.id,
                actor: actor.cell,
                decision: choose_reachable_move(map, actor.cell, target, reason),
            }]
        }
        PrimitiveQueryKind::NearestReachable {
            requested,
            max_radius,
        } => {
            let actor = query.primary_actor()?;
            vec![PrimitiveBehaviorAssignment {
                actor_id: actor.id,
                actor: actor.cell,
                decision: choose_nearest_reachable(map, actor.cell, requested, max_radius),
            }]
        }
        PrimitiveQueryKind::Cover { threat, reason } => {
            let actor = query.primary_actor()?;
            vec![PrimitiveBehaviorAssignment {
                actor_id: actor.id,
                actor: actor.cell,
                decision: choose_cover(map, actor.cell, threat, reason)?,
            }]
        }
        PrimitiveQueryKind::LateralEvasion { threat } => {
            let actor = query.primary_actor()?;
            vec![PrimitiveBehaviorAssignment {
                actor_id: actor.id,
                actor: actor.cell,
                decision: choose_lateral_evasion(map, actor.cell, threat)?,
            }]
        }
        PrimitiveQueryKind::CrowdedCover { threat } => {
            let agents = query
                .actors
                .iter()
                .map(|actor| actor.cell)
                .collect::<Vec<_>>();
            let decisions = choose_crowded_cover_slots(map, &agents, threat)?;
            query
                .actors
                .iter()
                .copied()
                .zip(decisions)
                .map(|(actor, decision)| PrimitiveBehaviorAssignment {
                    actor_id: actor.id,
                    actor: actor.cell,
                    decision,
                })
                .collect()
        }
    };

    Some(assignments)
}

pub(crate) fn choose_advance(
    map: &PrimitiveMap,
    actor: PrimitiveCell,
    target: PrimitiveCell,
    threat: PrimitiveCell,
) -> PrimitiveBehaviorDecision {
    PrimitiveBehaviorDecision {
        reason: "advance",
        target,
        tactical: distance_cells(target, threat) < distance_cells(actor, threat)
            && map.inside_combat_envelope(target),
    }
}

pub(crate) fn choose_reachable_move(
    map: &PrimitiveMap,
    actor: PrimitiveCell,
    target: PrimitiveCell,
    reason: &'static str,
) -> PrimitiveBehaviorDecision {
    PrimitiveBehaviorDecision {
        reason,
        target,
        tactical: map
            .path(actor, target)
            .is_some_and(|path| !path.is_empty() && path.iter().all(|cell| !map.blocked(*cell)))
            && map.inside_combat_envelope(target),
    }
}

pub(crate) fn choose_nearest_reachable(
    map: &PrimitiveMap,
    actor: PrimitiveCell,
    requested: PrimitiveCell,
    max_radius: i32,
) -> PrimitiveBehaviorDecision {
    nearest_reachable_open_cell(map, actor, requested, max_radius)
        .map(|target| PrimitiveBehaviorDecision {
            reason: "nearest_reachable",
            target,
            tactical: target != requested
                && !map.blocked(target)
                && distance_cells(target, requested) == 1
                && map.inside_combat_envelope(target),
        })
        .unwrap_or(PrimitiveBehaviorDecision {
            reason: "nearest_reachable_missing",
            target: requested,
            tactical: false,
        })
}

pub(crate) fn choose_cover(
    map: &PrimitiveMap,
    actor: PrimitiveCell,
    threat: PrimitiveCell,
    reason: &'static str,
) -> Option<PrimitiveBehaviorDecision> {
    select_cover(map, actor, threat).map(|target| PrimitiveBehaviorDecision {
        reason,
        target,
        tactical: exposure_score(map, target, threat) < exposure_score(map, actor, threat)
            && has_peek_option(map, target, threat)
            && !map.near_edge(target),
    })
}

pub(crate) fn choose_lateral_evasion(
    map: &PrimitiveMap,
    actor: PrimitiveCell,
    threat: PrimitiveCell,
) -> Option<PrimitiveBehaviorDecision> {
    select_evasion_target(map, actor, threat).map(|target| PrimitiveBehaviorDecision {
        reason: "lateral_evasion",
        target,
        tactical: !map.near_edge(target)
            && map.inside_combat_envelope(target)
            && distance_cells(target, threat) >= distance_cells(actor, threat),
    })
}

pub(crate) fn choose_crowded_cover_slots(
    map: &PrimitiveMap,
    agents: &[PrimitiveCell],
    threat: PrimitiveCell,
) -> Option<Vec<PrimitiveBehaviorDecision>> {
    let slots = assign_distinct_cover_slots(map, agents, threat)?;
    let distinct_slots = slots
        .iter()
        .enumerate()
        .all(|(index, slot)| !slots.iter().take(index).any(|previous| previous == slot));
    let cover_improvement = agents.iter().zip(slots.iter()).all(|(actor, slot)| {
        exposure_score(map, *slot, threat) < exposure_score(map, *actor, threat)
    });

    Some(
        slots
            .into_iter()
            .map(|target| PrimitiveBehaviorDecision {
                reason: "crowded_cover_slot",
                target,
                tactical: distinct_slots && cover_improvement,
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::{
        tactical_cover_needed, tactical_stage_order, TacticalCoverNeedRequest, TacticalStageKind,
        TacticalStageOrderRequest,
    };

    fn cover_need_request() -> TacticalCoverNeedRequest {
        TacticalCoverNeedRequest {
            current_action: 80,
            max_action: 100,
            suppression_pressure_milli: 0,
            cover_pressure_milli: 10_000,
            low_action_cover_percent: 35,
            hold_cover_between_shots: false,
            tick: 10,
            next_shot_tick: 10,
            outgunned: false,
        }
    }

    #[test]
    fn tactical_stage_order_prioritizes_cover_and_evasion_explicitly() {
        assert_eq!(
            tactical_stage_order(TacticalStageOrderRequest {
                prefer_cover: true,
                prefer_evasion: true,
            }),
            &[
                TacticalStageKind::GoodCover,
                TacticalStageKind::SoftCover,
                TacticalStageKind::Evasion,
                TacticalStageKind::FiringLane,
                TacticalStageKind::AdvanceLine,
                TacticalStageKind::Flank,
                TacticalStageKind::Retreat,
            ]
        );
        assert_eq!(
            tactical_stage_order(TacticalStageOrderRequest {
                prefer_cover: false,
                prefer_evasion: false,
            })
            .first(),
            Some(&TacticalStageKind::FiringLane)
        );
    }

    #[test]
    fn tactical_cover_needed_tracks_pressure_action_odds_and_shot_hold() {
        let mut request = cover_need_request();
        assert!(!tactical_cover_needed(request));

        request.suppression_pressure_milli = 10_000;
        assert!(tactical_cover_needed(request));

        request = cover_need_request();
        request.current_action = 35;
        assert!(tactical_cover_needed(request));

        request = cover_need_request();
        request.outgunned = true;
        assert!(tactical_cover_needed(request));

        request = cover_need_request();
        request.hold_cover_between_shots = true;
        request.next_shot_tick = 11;
        assert!(tactical_cover_needed(request));
    }
}
