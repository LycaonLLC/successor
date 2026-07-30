use serde::{Deserialize, Serialize};

use super::{
    affordance::{PrimitiveCell, PrimitiveMap},
    executor::PrimitiveExecution,
    situation::CombatSituationSnapshot,
};

const SLICE_AUTHORITY_AI_DEBUG_SCHEMA: &str = "successor.authority-ai-debug.v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceAuthorityAiDebugSnapshot {
    pub schema: String,
    pub tick: u64,
    pub squads: Vec<AuthorityAiSquadDebugSnapshot>,
    pub actors: Vec<AuthorityAiActorDebugSnapshot>,
}

impl SliceAuthorityAiDebugSnapshot {
    pub(crate) fn empty(tick: u64) -> Self {
        Self::with_squads(tick, Vec::new())
    }

    pub(crate) fn with_squads(tick: u64, squads: Vec<AuthorityAiSquadDebugSnapshot>) -> Self {
        Self {
            schema: SLICE_AUTHORITY_AI_DEBUG_SCHEMA.to_owned(),
            tick,
            squads,
            actors: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityAiDebugPosition {
    pub x_milli: i32,
    pub y_milli: i32,
    pub cell_x: i32,
    pub cell_y: i32,
}

impl AuthorityAiDebugPosition {
    pub(crate) const fn from_milli_cell(
        x_milli: i32,
        y_milli: i32,
        cell_x: i32,
        cell_y: i32,
    ) -> Self {
        Self {
            x_milli,
            y_milli,
            cell_x,
            cell_y,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityAiSquadDebugSnapshot {
    pub squad_id: String,
    pub area_id: String,
    pub faction: String,
    pub order: String,
    pub confidence: String,
    pub member_count: usize,
    pub enemy_count: usize,
    pub center: AuthorityAiDebugPosition,
    pub enemy_center: Option<AuthorityAiDebugPosition>,
    pub direction_x_milli: i32,
    pub direction_y_milli: i32,
    pub front_width_milli: i32,
    pub no_mans_land: Option<AuthorityAiDebugPosition>,
    pub strength_milli: i32,
    pub enemy_strength_milli: i32,
}

pub(crate) struct AuthorityAiSquadDebugSnapshotRequest {
    pub(crate) squad_id: String,
    pub(crate) area_id: String,
    pub(crate) faction: String,
    pub(crate) order: String,
    pub(crate) confidence: String,
    pub(crate) member_count: usize,
    pub(crate) enemy_count: usize,
    pub(crate) center: AuthorityAiDebugPosition,
    pub(crate) enemy_center: Option<AuthorityAiDebugPosition>,
    pub(crate) direction_x_milli: i32,
    pub(crate) direction_y_milli: i32,
    pub(crate) front_width_milli: i32,
    pub(crate) no_mans_land: Option<AuthorityAiDebugPosition>,
    pub(crate) strength_milli: i32,
    pub(crate) enemy_strength_milli: i32,
}

pub(crate) fn authority_ai_squad_debug_snapshot(
    request: AuthorityAiSquadDebugSnapshotRequest,
) -> AuthorityAiSquadDebugSnapshot {
    AuthorityAiSquadDebugSnapshot {
        squad_id: request.squad_id,
        area_id: request.area_id,
        faction: request.faction,
        order: request.order,
        confidence: request.confidence,
        member_count: request.member_count,
        enemy_count: request.enemy_count,
        center: request.center,
        enemy_center: request.enemy_center,
        direction_x_milli: request.direction_x_milli,
        direction_y_milli: request.direction_y_milli,
        front_width_milli: request.front_width_milli,
        no_mans_land: request.no_mans_land,
        strength_milli: request.strength_milli,
        enemy_strength_milli: request.enemy_strength_milli,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityAiActorDebugSnapshot {
    pub actor_id: String,
    pub squad_id: Option<String>,
    pub faction: Option<String>,
    pub variant: String,
    pub mode: String,
    pub order: String,
    pub confidence: String,
    pub situation: Option<AuthorityAiSituationDebugSnapshot>,
    pub target_actor_id: Option<String>,
    pub target: Option<AuthorityAiDebugPosition>,
    pub cover: Option<AuthorityAiDebugPosition>,
    pub move_target: Option<AuthorityAiDebugPosition>,
    pub slot_claim: Option<AuthorityAiDebugPosition>,
    pub lane_index: Option<usize>,
    pub lane_count: Option<usize>,
    pub reason: String,
    pub candidates: Vec<AuthorityAiTacticalCandidateDebug>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityAiSituationDebugSnapshot {
    pub posture: String,
    pub local_force_ratio_milli: i32,
    pub incoming_pressure_milli: i32,
    pub cover_readiness_milli: i32,
    pub cohesion_milli: i32,
    pub isolation_risk_milli: i32,
    pub resource_risk_milli: i32,
    pub stall_ticks: u64,
    pub reasons: Vec<String>,
}

pub(crate) fn authority_ai_situation_debug_snapshot(
    situation: &CombatSituationSnapshot,
) -> AuthorityAiSituationDebugSnapshot {
    AuthorityAiSituationDebugSnapshot {
        posture: situation.posture.label().to_owned(),
        local_force_ratio_milli: situation.local_force_ratio_milli,
        incoming_pressure_milli: situation.incoming_pressure_milli,
        cover_readiness_milli: situation.cover_readiness_milli,
        cohesion_milli: situation.cohesion_milli,
        isolation_risk_milli: situation.isolation_risk_milli,
        resource_risk_milli: situation.resource_risk_milli,
        stall_ticks: situation.stall_ticks,
        reasons: situation
            .reasons
            .iter()
            .map(|reason| (*reason).to_owned())
            .collect(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorityAiTacticalCandidateDebug {
    pub stage: String,
    pub kind: String,
    pub position: AuthorityAiDebugPosition,
    pub score: i64,
    pub accepted: bool,
    pub rejection: Option<String>,
    pub has_shot: bool,
    pub protected: bool,
    pub pathable: bool,
    pub terrain_pathable: bool,
    pub pathfinder_pathable: bool,
    pub body_blocked: bool,
    pub claimed: bool,
    pub inside_lane: bool,
    pub crosses_no_mans_land: bool,
    pub range_error_milli: i32,
    pub lane_error_milli: i32,
    pub cover_prop_id: Option<String>,
}

pub(crate) struct AuthorityAiTacticalCandidateDebugRequest {
    pub(crate) stage: String,
    pub(crate) kind: String,
    pub(crate) position: AuthorityAiDebugPosition,
    pub(crate) score: i64,
    pub(crate) accepted: bool,
    pub(crate) rejection: Option<String>,
    pub(crate) has_shot: bool,
    pub(crate) protected: bool,
    pub(crate) pathable: bool,
    pub(crate) terrain_pathable: bool,
    pub(crate) pathfinder_pathable: bool,
    pub(crate) body_blocked: bool,
    pub(crate) claimed: bool,
    pub(crate) inside_lane: bool,
    pub(crate) crosses_no_mans_land: bool,
    pub(crate) range_error_milli: i32,
    pub(crate) lane_error_milli: i32,
    pub(crate) cover_prop_id: Option<String>,
}

pub(crate) fn authority_ai_tactical_candidate_debug(
    request: AuthorityAiTacticalCandidateDebugRequest,
) -> AuthorityAiTacticalCandidateDebug {
    AuthorityAiTacticalCandidateDebug {
        stage: request.stage,
        kind: request.kind,
        position: request.position,
        score: request.score,
        accepted: request.accepted,
        rejection: request.rejection,
        has_shot: request.has_shot,
        protected: request.protected,
        pathable: request.pathable,
        terrain_pathable: request.terrain_pathable,
        pathfinder_pathable: request.pathfinder_pathable,
        body_blocked: request.body_blocked,
        claimed: request.claimed,
        inside_lane: request.inside_lane,
        crosses_no_mans_land: request.crosses_no_mans_land,
        range_error_milli: request.range_error_milli,
        lane_error_milli: request.lane_error_milli,
        cover_prop_id: request.cover_prop_id,
    }
}

pub(crate) fn no_tactical_candidates_debug(
    position: AuthorityAiDebugPosition,
) -> AuthorityAiTacticalCandidateDebug {
    authority_ai_tactical_candidate_debug(AuthorityAiTacticalCandidateDebugRequest {
        stage: "none".to_owned(),
        kind: "no_candidates".to_owned(),
        position,
        score: 0,
        accepted: false,
        rejection: Some("no_candidates".to_owned()),
        has_shot: false,
        protected: false,
        pathable: false,
        terrain_pathable: false,
        pathfinder_pathable: false,
        body_blocked: false,
        claimed: false,
        inside_lane: false,
        crosses_no_mans_land: false,
        range_error_milli: 0,
        lane_error_milli: 0,
        cover_prop_id: None,
    })
}

pub(crate) struct AuthorityAiActorDebugSnapshotRequest {
    pub(crate) actor_id: String,
    pub(crate) squad_id: Option<String>,
    pub(crate) faction: Option<String>,
    pub(crate) variant: String,
    pub(crate) mode: String,
    pub(crate) order: String,
    pub(crate) confidence: String,
    pub(crate) situation: Option<AuthorityAiSituationDebugSnapshot>,
    pub(crate) target_actor_id: Option<String>,
    pub(crate) target: Option<AuthorityAiDebugPosition>,
    pub(crate) cover: Option<AuthorityAiDebugPosition>,
    pub(crate) move_target: Option<AuthorityAiDebugPosition>,
    pub(crate) slot_claim: Option<AuthorityAiDebugPosition>,
    pub(crate) lane_index: Option<usize>,
    pub(crate) lane_count: Option<usize>,
    pub(crate) reason: String,
    pub(crate) candidates: Vec<AuthorityAiTacticalCandidateDebug>,
    pub(crate) candidate_limit: usize,
}

pub(crate) fn authority_ai_actor_debug_snapshot(
    request: AuthorityAiActorDebugSnapshotRequest,
) -> AuthorityAiActorDebugSnapshot {
    AuthorityAiActorDebugSnapshot {
        actor_id: request.actor_id,
        squad_id: request.squad_id,
        faction: request.faction,
        variant: request.variant,
        mode: request.mode,
        order: request.order,
        confidence: request.confidence,
        situation: request.situation,
        target_actor_id: request.target_actor_id,
        target: request.target,
        cover: request.cover,
        move_target: request.move_target,
        slot_claim: request.slot_claim,
        lane_index: request.lane_index,
        lane_count: request.lane_count,
        reason: request.reason,
        candidates: trim_authority_tactical_candidates(request.candidates, request.candidate_limit),
    }
}

pub(crate) fn current_order_tactical_candidate(
    reason: &str,
    position: AuthorityAiDebugPosition,
    has_shot: bool,
    protected: bool,
) -> AuthorityAiTacticalCandidateDebug {
    AuthorityAiTacticalCandidateDebug {
        stage: "current_order".to_owned(),
        kind: reason.to_owned(),
        position,
        score: if has_shot { 1_000 } else { 1 },
        accepted: true,
        rejection: None,
        has_shot,
        protected,
        pathable: true,
        terrain_pathable: true,
        pathfinder_pathable: true,
        body_blocked: false,
        claimed: false,
        inside_lane: true,
        crosses_no_mans_land: false,
        range_error_milli: 0,
        lane_error_milli: 0,
        cover_prop_id: None,
    }
}

pub(crate) fn trim_authority_tactical_candidates(
    candidates: Vec<AuthorityAiTacticalCandidateDebug>,
    limit: usize,
) -> Vec<AuthorityAiTacticalCandidateDebug> {
    trim_best_accepted_tactical_candidates(
        candidates,
        limit,
        |candidate| candidate.accepted,
        |candidate| candidate.score,
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimitiveDecisionTrace {
    pub map_id: &'static str,
    pub actor_id: &'static str,
    pub actor: PrimitiveCell,
    pub query_kind: &'static str,
    pub reason: &'static str,
    pub target: PrimitiveCell,
    pub reachable: bool,
    pub tactical: bool,
    pub path_len: u32,
    pub failure_flags: Vec<&'static str>,
}

pub(crate) fn decision_trace(
    map: &PrimitiveMap,
    query_kind: &'static str,
    actor_id: &'static str,
    actor: PrimitiveCell,
    execution: &PrimitiveExecution,
) -> PrimitiveDecisionTrace {
    PrimitiveDecisionTrace {
        map_id: map.id,
        actor_id,
        actor,
        query_kind,
        reason: execution.reason,
        target: execution.target,
        reachable: execution.reachable,
        tactical: execution.tactical,
        path_len: execution.path_len,
        failure_flags: failure_flags(map, execution),
    }
}

fn failure_flags(map: &PrimitiveMap, execution: &PrimitiveExecution) -> Vec<&'static str> {
    let mut flags = Vec::new();
    if !execution.reachable {
        flags.push("unreachable");
    }
    if !execution.tactical {
        flags.push("not_tactical");
    }
    if map.near_edge(execution.target) {
        flags.push("near_edge");
    }
    if !map.inside_combat_envelope(execution.target) {
        flags.push("outside_combat_envelope");
    }
    if execution.path_len <= 1 {
        flags.push("no_progress");
    }
    flags
}

pub(crate) fn trim_best_accepted_tactical_candidates<T, FAccepted, FScore>(
    candidates: Vec<T>,
    limit: usize,
    mut accepted: FAccepted,
    mut score: FScore,
) -> Vec<T>
where
    T: Clone,
    FAccepted: FnMut(&T) -> bool,
    FScore: FnMut(&T) -> i64,
{
    if candidates.len() <= limit {
        return candidates;
    }

    let mut best_accepted: Option<(i64, T)> = None;
    for candidate in &candidates {
        if !accepted(candidate) {
            continue;
        }
        let candidate_score = score(candidate);
        let replaces_best = match best_accepted.as_ref() {
            Some((best_score, _)) => candidate_score > *best_score,
            None => true,
        };
        if replaces_best {
            best_accepted = Some((candidate_score, candidate.clone()));
        }
    }

    let mut trimmed: Vec<_> = candidates.into_iter().take(limit).collect();
    if !trimmed.iter().any(accepted) {
        if let (Some((_, candidate)), Some(last)) = (best_accepted, trimmed.last_mut()) {
            *last = candidate;
        }
    }
    trimmed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct Candidate {
        accepted: bool,
        score: i64,
    }

    #[test]
    fn trim_tactical_candidates_preserves_best_accepted_candidate() {
        let mut candidates = vec![
            Candidate {
                accepted: false,
                score: 1,
            },
            Candidate {
                accepted: false,
                score: 2,
            },
        ];
        candidates.push(Candidate {
            accepted: true,
            score: 99,
        });

        let trimmed = trim_best_accepted_tactical_candidates(
            candidates,
            2,
            |candidate| candidate.accepted,
            |candidate| candidate.score,
        );

        assert_eq!(trimmed.len(), 2);
        assert!(trimmed.iter().any(|candidate| candidate.accepted));
        assert!(trimmed.iter().any(|candidate| candidate.score == 99));
    }

    #[test]
    fn current_order_candidate_uses_order_stage_and_score() {
        let candidate = current_order_tactical_candidate(
            "current_hold",
            AuthorityAiDebugPosition::from_milli_cell(12_000, 7_000, 12, 7),
            true,
            false,
        );

        assert_eq!(candidate.stage, "current_order");
        assert_eq!(candidate.kind, "current_hold");
        assert_eq!(candidate.score, 1_000);
        assert!(candidate.accepted);
        assert!(candidate.has_shot);
        assert!(!candidate.protected);
        assert!(candidate.pathable);
    }

    #[test]
    fn debug_snapshot_builder_sets_schema_tick_and_squads() {
        let squad = authority_ai_squad_debug_snapshot(AuthorityAiSquadDebugSnapshotRequest {
            squad_id: "area:faction".to_owned(),
            area_id: "area".to_owned(),
            faction: "faction".to_owned(),
            order: "advance".to_owned(),
            confidence: "neutral".to_owned(),
            member_count: 2,
            enemy_count: 3,
            center: AuthorityAiDebugPosition::from_milli_cell(1_000, 2_000, 1, 2),
            enemy_center: None,
            direction_x_milli: 1_000,
            direction_y_milli: 0,
            front_width_milli: 3_000,
            no_mans_land: None,
            strength_milli: 2_000,
            enemy_strength_milli: 3_000,
        });

        let snapshot = SliceAuthorityAiDebugSnapshot::with_squads(42, vec![squad.clone()]);

        assert_eq!(snapshot.schema, SLICE_AUTHORITY_AI_DEBUG_SCHEMA);
        assert_eq!(snapshot.tick, 42);
        assert_eq!(snapshot.squads, vec![squad]);
        assert!(snapshot.actors.is_empty());
    }

    #[test]
    fn tactical_candidate_debug_builder_preserves_rejection_flags() {
        let row = authority_ai_tactical_candidate_debug(AuthorityAiTacticalCandidateDebugRequest {
            stage: "cover".to_owned(),
            kind: "high_cover".to_owned(),
            position: AuthorityAiDebugPosition::from_milli_cell(1_000, 2_000, 1, 2),
            score: -50,
            accepted: false,
            rejection: Some("terrain_blocked".to_owned()),
            has_shot: false,
            protected: true,
            pathable: false,
            terrain_pathable: false,
            pathfinder_pathable: true,
            body_blocked: true,
            claimed: true,
            inside_lane: false,
            crosses_no_mans_land: true,
            range_error_milli: 250,
            lane_error_milli: 500,
            cover_prop_id: Some("cover-01".to_owned()),
        });

        assert_eq!(row.stage, "cover");
        assert_eq!(row.kind, "high_cover");
        assert_eq!(row.position.cell_x, 1);
        assert_eq!(row.score, -50);
        assert_eq!(row.rejection.as_deref(), Some("terrain_blocked"));
        assert!(row.protected);
        assert!(!row.pathable);
        assert!(row.body_blocked);
        assert!(row.claimed);
        assert!(row.crosses_no_mans_land);
        assert_eq!(row.cover_prop_id.as_deref(), Some("cover-01"));
    }

    #[test]
    fn no_tactical_candidates_debug_is_a_rejected_fallback_row() {
        let row = no_tactical_candidates_debug(AuthorityAiDebugPosition::from_milli_cell(
            3_000, 4_000, 3, 4,
        ));

        assert_eq!(row.stage, "none");
        assert_eq!(row.kind, "no_candidates");
        assert_eq!(row.position.cell_x, 3);
        assert!(!row.accepted);
        assert_eq!(row.rejection.as_deref(), Some("no_candidates"));
        assert!(!row.pathable);
        assert!(!row.inside_lane);
    }

    #[test]
    fn actor_debug_snapshot_trims_candidates_with_policy() {
        let rejected = |index: i64| AuthorityAiTacticalCandidateDebug {
            stage: "good_cover".to_owned(),
            kind: format!("rejected-{index}"),
            position: AuthorityAiDebugPosition::from_milli_cell(index as i32, 0, 0, 0),
            score: index,
            accepted: false,
            rejection: Some("blocked".to_owned()),
            has_shot: false,
            protected: false,
            pathable: false,
            terrain_pathable: false,
            pathfinder_pathable: false,
            body_blocked: false,
            claimed: false,
            inside_lane: true,
            crosses_no_mans_land: false,
            range_error_milli: 0,
            lane_error_milli: 0,
            cover_prop_id: None,
        };
        let mut candidates = vec![rejected(1), rejected(2)];
        candidates.push(current_order_tactical_candidate(
            "chosen-late",
            AuthorityAiDebugPosition::from_milli_cell(99_000, 0, 99, 0),
            false,
            true,
        ));

        let snapshot = authority_ai_actor_debug_snapshot(AuthorityAiActorDebugSnapshotRequest {
            actor_id: "agent-01".to_owned(),
            squad_id: Some("squad-01".to_owned()),
            faction: Some("desert_wardens".to_owned()),
            variant: "agent".to_owned(),
            mode: "engage".to_owned(),
            order: "advance".to_owned(),
            confidence: "steady".to_owned(),
            situation: None,
            target_actor_id: Some("target-01".to_owned()),
            target: None,
            cover: None,
            move_target: None,
            slot_claim: None,
            lane_index: Some(1),
            lane_count: Some(2),
            reason: "skirmisher_tactical".to_owned(),
            candidates,
            candidate_limit: 2,
        });

        assert_eq!(snapshot.actor_id, "agent-01");
        assert_eq!(snapshot.candidates.len(), 2);
        assert!(snapshot
            .candidates
            .iter()
            .any(|candidate| candidate.kind == "chosen-late" && candidate.accepted));
    }

    #[test]
    fn squad_debug_snapshot_preserves_live_context() {
        let center = AuthorityAiDebugPosition::from_milli_cell(1_000, 2_000, 1, 2);
        let enemy_center = AuthorityAiDebugPosition::from_milli_cell(8_000, 2_000, 8, 2);
        let no_mans_land = AuthorityAiDebugPosition::from_milli_cell(4_500, 2_000, 4, 2);

        let snapshot = authority_ai_squad_debug_snapshot(AuthorityAiSquadDebugSnapshotRequest {
            squad_id: "area:faction".to_owned(),
            area_id: "area".to_owned(),
            faction: "faction".to_owned(),
            order: "advance".to_owned(),
            confidence: "steady".to_owned(),
            member_count: 2,
            enemy_count: 3,
            center: center.clone(),
            enemy_center: Some(enemy_center.clone()),
            direction_x_milli: 1_000,
            direction_y_milli: 0,
            front_width_milli: 3_000,
            no_mans_land: Some(no_mans_land.clone()),
            strength_milli: 2_000,
            enemy_strength_milli: 3_000,
        });

        assert_eq!(snapshot.squad_id, "area:faction");
        assert_eq!(snapshot.center, center);
        assert_eq!(snapshot.enemy_center, Some(enemy_center));
        assert_eq!(snapshot.no_mans_land, Some(no_mans_land));
        assert_eq!(snapshot.member_count, 2);
        assert_eq!(snapshot.enemy_count, 3);
    }
}
