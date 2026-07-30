use super::{
    behavior::TacticalStageKind,
    perception::{project_tactical_position_milli, TacticalPoint, TacticalProjectionRequest},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalCandidateDistanceLimitRequest {
    pub(crate) stage: TacticalStageKind,
    pub(crate) actor_distance_milli: i32,
    pub(crate) cover_search_radius_milli: i32,
    pub(crate) max_range_milli: i32,
    pub(crate) acquire_radius_milli: i32,
    pub(crate) retreat_extra_milli: i32,
    pub(crate) default_extra_milli: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalCandidateBadRangeRequest {
    pub(crate) stage: TacticalStageKind,
    pub(crate) target_distance_milli: i32,
    pub(crate) min_range_milli: i32,
    pub(crate) max_range_milli: i32,
    pub(crate) prefer_cover: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalCoverScoreRequest {
    pub(crate) rating_milli: i32,
    pub(crate) high: bool,
    pub(crate) anchor_profile: bool,
    pub(crate) actor_distance_milli: i32,
    pub(crate) threat_distance_milli: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalCoverShadowPenaltyRequest {
    pub(crate) candidate_x_milli: i32,
    pub(crate) candidate_y_milli: i32,
    pub(crate) prop_left_milli: i32,
    pub(crate) prop_right_milli: i32,
    pub(crate) prop_top_milli: i32,
    pub(crate) prop_bottom_milli: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalLaneErrorRequest {
    pub(crate) position: TacticalPoint,
    pub(crate) origin: TacticalPoint,
    pub(crate) lateral_x_milli: i32,
    pub(crate) lateral_y_milli: i32,
    pub(crate) min_offset_milli: i32,
    pub(crate) max_offset_milli: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalNoMansLandRequest {
    pub(crate) position: TacticalPoint,
    pub(crate) no_mans_land: TacticalPoint,
    pub(crate) direction_x_milli: i32,
    pub(crate) direction_y_milli: i32,
    pub(crate) margin_milli: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalFlankValueRequest {
    pub(crate) position: TacticalPoint,
    pub(crate) origin: TacticalPoint,
    pub(crate) lateral_x_milli: i32,
    pub(crate) lateral_y_milli: i32,
    pub(crate) max_value_milli: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalPositionClaim<'a, TPosition> {
    pub(crate) actor_id: &'a str,
    pub(crate) area_id: &'a str,
    pub(crate) position: TPosition,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalCandidateClaimRequest<'a, TPosition> {
    pub(crate) actor_id: &'a str,
    pub(crate) area_id: &'a str,
    pub(crate) position: TPosition,
    pub(crate) claim_radius_milli: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalAllySpacingPenaltyRequest<'a, TPosition> {
    pub(crate) actor_id: &'a str,
    pub(crate) area_id: &'a str,
    pub(crate) position: TPosition,
    pub(crate) spacing_radius_milli: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalCandidateScoreRequest {
    pub(crate) stage: TacticalStageKind,
    pub(crate) actor_distance_milli: i32,
    pub(crate) range_error_milli: i32,
    pub(crate) lane_error_milli: i32,
    pub(crate) flank_value_milli: i32,
    pub(crate) spacing_penalty_milli: i32,
    pub(crate) cover_shadow_penalty_milli: i32,
    pub(crate) cover_score: i64,
    pub(crate) near_world_edge: bool,
    pub(crate) has_cover_point: bool,
    pub(crate) terrain_blocked: bool,
    pub(crate) body_blocked: bool,
    pub(crate) clearance_blocked: bool,
    pub(crate) recently_blocked: bool,
    pub(crate) too_far: bool,
    pub(crate) claimed: bool,
    pub(crate) crosses_no_mans_land: bool,
    pub(crate) inside_lane_before_shot: bool,
    pub(crate) bad_range: bool,
    pub(crate) raw_has_shot: bool,
    pub(crate) require_shot: bool,
    pub(crate) cover_required: bool,
    pub(crate) prefer_evasion: bool,
    pub(crate) allow_offensive_maneuver: bool,
    pub(crate) situation_bias_score: i64,
    pub(crate) tactic_bias_score: i64,
    pub(crate) protected_by_cover: bool,
    pub(crate) exposed_to_target: bool,
    pub(crate) min_reposition_milli: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalCandidateRawShotProbeRequest {
    pub(crate) stage: TacticalStageKind,
    pub(crate) target_distance_milli: i32,
    pub(crate) max_range_milli: i32,
    pub(crate) blocked: bool,
    pub(crate) too_far: bool,
    pub(crate) claimed: bool,
    pub(crate) crosses_no_mans_land: bool,
    pub(crate) bad_range: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalCandidateOpenProbeRequest {
    pub(crate) stage: TacticalStageKind,
    pub(crate) actor_distance_milli: i32,
    pub(crate) min_reposition_milli: i32,
    pub(crate) terrain_blocked: bool,
    pub(crate) body_blocked: bool,
    pub(crate) clearance_blocked: bool,
    pub(crate) recently_blocked: bool,
    pub(crate) near_world_edge: bool,
    pub(crate) has_cover_point: bool,
    pub(crate) too_far: bool,
    pub(crate) claimed: bool,
    pub(crate) crosses_no_mans_land: bool,
    pub(crate) inside_lane_before_shot: bool,
    pub(crate) raw_has_shot: bool,
    pub(crate) bad_range: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalCandidateScore {
    pub(crate) score: i64,
    pub(crate) accepted: bool,
    pub(crate) rejection: Option<&'static str>,
    pub(crate) has_shot: bool,
    pub(crate) protected: bool,
    pub(crate) pathable: bool,
    pub(crate) terrain_pathable: bool,
    pub(crate) pathfinder_pathable: bool,
    pub(crate) claimed: bool,
    pub(crate) inside_lane: bool,
    pub(crate) crosses_no_mans_land: bool,
}

pub(crate) fn tactical_candidate_too_far(request: TacticalCandidateDistanceLimitRequest) -> bool {
    let max_actor_distance = if request.stage == TacticalStageKind::AdvanceLine {
        request.acquire_radius_milli
    } else {
        request
            .cover_search_radius_milli
            .max(request.max_range_milli)
            .saturating_add(if request.stage == TacticalStageKind::Retreat {
                request.retreat_extra_milli
            } else {
                request.default_extra_milli
            })
    };
    request.actor_distance_milli > max_actor_distance
}

pub(crate) fn tactical_candidate_bad_range(request: TacticalCandidateBadRangeRequest) -> bool {
    let pressure_range_milli = request.max_range_milli.saturating_add(2_500);
    let withdrawal_range_milli = request.max_range_milli.saturating_add(6_000);
    match request.stage {
        TacticalStageKind::Evasion => request.target_distance_milli > pressure_range_milli,
        TacticalStageKind::Retreat => request.target_distance_milli > withdrawal_range_milli,
        TacticalStageKind::AdvanceLine => false,
        TacticalStageKind::GoodCover | TacticalStageKind::SoftCover if request.prefer_cover => {
            request.target_distance_milli > pressure_range_milli
        }
        _ => request.target_distance_milli > pressure_range_milli,
    }
}

pub(crate) fn cover_score_for_tactical_candidate(request: TacticalCoverScoreRequest) -> i64 {
    let high_bonus = if request.high { 800 } else { 0 };
    let anchor_bonus = if request.anchor_profile {
        request.rating_milli.saturating_mul(2)
    } else {
        0
    };

    i64::from(
        request
            .rating_milli
            .saturating_mul(8)
            .saturating_add(anchor_bonus),
    ) + i64::from(high_bonus)
        + i64::from(request.threat_distance_milli / 12)
        - i64::from(request.actor_distance_milli / 2)
}

pub(crate) fn cover_shadow_penalty_for_tactical_candidate(
    request: TacticalCoverShadowPenaltyRequest,
) -> i32 {
    let prop_center_x = request
        .prop_left_milli
        .saturating_add(request.prop_right_milli)
        / 2;
    let prop_center_y = request
        .prop_top_milli
        .saturating_add(request.prop_bottom_milli)
        / 2;
    distance_milli_components(
        request.candidate_x_milli - prop_center_x,
        request.candidate_y_milli - prop_center_y,
    ) / 2
}

pub(crate) fn tactical_lane_error_milli(request: TacticalLaneErrorRequest) -> i32 {
    let offset = project_tactical_position_milli(TacticalProjectionRequest {
        position: request.position,
        origin: request.origin,
        axis_x_milli: request.lateral_x_milli,
        axis_y_milli: request.lateral_y_milli,
    });
    if offset < request.min_offset_milli {
        request.min_offset_milli - offset
    } else if offset > request.max_offset_milli {
        offset - request.max_offset_milli
    } else {
        0
    }
}

pub(crate) const fn tactical_position_inside_lane(
    lane_error_milli: i32,
    lane_width_milli: i32,
) -> bool {
    lane_error_milli <= lane_width_milli
}

pub(crate) const fn tactical_candidate_inside_lane_for_stage(
    stage: TacticalStageKind,
    position_inside_lane: bool,
) -> bool {
    match stage {
        TacticalStageKind::Evasion | TacticalStageKind::Flank | TacticalStageKind::Retreat => true,
        _ => position_inside_lane,
    }
}

pub(crate) const fn tactical_stage_needs_lane_probe(stage: TacticalStageKind) -> bool {
    !matches!(
        stage,
        TacticalStageKind::Evasion | TacticalStageKind::Flank | TacticalStageKind::Retreat
    )
}

pub(crate) fn tactical_position_crosses_no_mans_land(request: TacticalNoMansLandRequest) -> bool {
    project_tactical_position_milli(TacticalProjectionRequest {
        position: request.position,
        origin: request.no_mans_land,
        axis_x_milli: request.direction_x_milli,
        axis_y_milli: request.direction_y_milli,
    }) > request.margin_milli
}

pub(crate) const fn tactical_candidate_crosses_no_mans_land_for_stage(
    stage: TacticalStageKind,
    position_crosses_no_mans_land: bool,
) -> bool {
    match stage {
        TacticalStageKind::Evasion | TacticalStageKind::Retreat => false,
        _ => position_crosses_no_mans_land,
    }
}

pub(crate) const fn tactical_stage_needs_no_mans_land_probe(stage: TacticalStageKind) -> bool {
    !matches!(
        stage,
        TacticalStageKind::Evasion | TacticalStageKind::Retreat
    )
}

pub(crate) fn tactical_flank_value_milli(request: TacticalFlankValueRequest) -> i32 {
    project_tactical_position_milli(TacticalProjectionRequest {
        position: request.position,
        origin: request.origin,
        axis_x_milli: request.lateral_x_milli,
        axis_y_milli: request.lateral_y_milli,
    })
    .abs()
    .min(request.max_value_milli)
}

pub(crate) fn tactical_candidate_claimed<'a, TPosition, Claims, FDistance>(
    request: TacticalCandidateClaimRequest<'a, TPosition>,
    claims: Claims,
    mut distance_milli: FDistance,
) -> bool
where
    TPosition: Copy + 'a,
    Claims: IntoIterator<Item = TacticalPositionClaim<'a, TPosition>>,
    FDistance: FnMut(TPosition, TPosition) -> i32,
{
    claims.into_iter().any(|claim| {
        claim.actor_id != request.actor_id
            && claim.area_id == request.area_id
            && distance_milli(claim.position, request.position) <= request.claim_radius_milli
    })
}

pub(crate) fn tactical_ally_spacing_penalty<'a, TPosition, Claims, FDistance>(
    request: TacticalAllySpacingPenaltyRequest<'a, TPosition>,
    claims: Claims,
    mut distance_milli: FDistance,
) -> i32
where
    TPosition: Copy + 'a,
    Claims: IntoIterator<Item = TacticalPositionClaim<'a, TPosition>>,
    FDistance: FnMut(TPosition, TPosition) -> i32,
{
    claims
        .into_iter()
        .filter(|claim| claim.actor_id != request.actor_id && claim.area_id == request.area_id)
        .map(|claim| distance_milli(claim.position, request.position))
        .filter(|distance| *distance < request.spacing_radius_milli)
        .map(|distance| request.spacing_radius_milli - distance)
        .sum::<i32>()
}

pub(crate) fn tactical_candidate_raw_shot_probe_open(
    request: TacticalCandidateRawShotProbeRequest,
) -> bool {
    request.target_distance_milli <= request.max_range_milli.saturating_add(1_500)
        && request.stage != TacticalStageKind::AdvanceLine
        && request.stage != TacticalStageKind::Retreat
        && !request.blocked
        && !request.too_far
        && !request.claimed
        && !request.crosses_no_mans_land
        && !request.bad_range
}

// Intentional readable conjunction of independent gating flags; clippy's
// whole-expression rewrite collapses it into a dense negated disjunction that
// is harder to audit. Keep the flag-by-flag form.
#[allow(clippy::nonminimal_bool)]
pub(crate) fn tactical_candidate_open_for_live_probe(
    request: TacticalCandidateOpenProbeRequest,
) -> bool {
    let inside_lane_after_shot = request.inside_lane_before_shot
        || (request.stage == TacticalStageKind::FiringLane && request.raw_has_shot);
    request.actor_distance_milli >= request.min_reposition_milli
        && !request.terrain_blocked
        && !request.body_blocked
        && !request.clearance_blocked
        && !request.recently_blocked
        && !(request.near_world_edge && !request.has_cover_point)
        && !request.too_far
        && !request.claimed
        && !request.crosses_no_mans_land
        && inside_lane_after_shot
        && !request.bad_range
}

pub(crate) const fn tactical_candidate_should_probe_protection(
    stage: TacticalStageKind,
    cover_required: bool,
) -> bool {
    cover_required
        || matches!(
            stage,
            TacticalStageKind::GoodCover | TacticalStageKind::SoftCover
        )
}

pub(crate) const fn tactical_candidate_should_probe_exposure(stage: TacticalStageKind) -> bool {
    !matches!(
        stage,
        TacticalStageKind::AdvanceLine | TacticalStageKind::Retreat
    )
}

pub(crate) fn score_tactical_candidate(
    request: TacticalCandidateScoreRequest,
) -> TacticalCandidateScore {
    let terrain_pathable =
        !request.terrain_blocked && !request.body_blocked && !request.clearance_blocked;
    let inside_lane = request.inside_lane_before_shot
        || (request.stage == TacticalStageKind::FiringLane && request.raw_has_shot);
    let offensive_maneuver_blocked = !request.allow_offensive_maneuver
        && matches!(
            request.stage,
            TacticalStageKind::FiringLane
                | TacticalStageKind::AdvanceLine
                | TacticalStageKind::Flank
        );

    let mut rejection = if request.actor_distance_milli < request.min_reposition_milli {
        Some("current_position")
    } else if request.terrain_blocked {
        Some("terrain_blocked")
    } else if request.body_blocked {
        Some("body_blocked")
    } else if request.clearance_blocked {
        Some("clearance_blocked")
    } else if request.recently_blocked {
        Some("recently_blocked")
    } else if request.near_world_edge && !request.has_cover_point {
        Some("edge_band")
    } else if request.too_far {
        Some("too_far")
    } else if request.claimed {
        Some("claimed")
    } else if request.crosses_no_mans_land {
        Some("crosses_no_mans_land")
    } else if !inside_lane {
        Some("outside_lane")
    } else if offensive_maneuver_blocked {
        Some("offensive_maneuver_blocked")
    } else if request.bad_range {
        Some("bad_range")
    } else {
        None
    };

    let has_shot = rejection.is_none() && request.raw_has_shot;
    if rejection.is_none()
        && (request.require_shot || request.stage == TacticalStageKind::FiringLane)
        && request.stage != TacticalStageKind::AdvanceLine
        && !has_shot
    {
        rejection = Some("no_firing_lane");
    }

    let should_probe_protection = request.cover_required
        || request.stage == TacticalStageKind::GoodCover
        || request.stage == TacticalStageKind::SoftCover;
    let protected = rejection.is_none() && should_probe_protection && request.protected_by_cover;
    if rejection.is_none()
        && request.cover_required
        && request.stage != TacticalStageKind::Evasion
        && !protected
    {
        rejection = Some("unprotected");
    } else if rejection.is_none() && request.stage == TacticalStageKind::GoodCover && !protected {
        rejection = Some("unprotected_good_cover");
    }

    let pathfinder_pathable = rejection.is_none() && terrain_pathable;
    if rejection.is_none() && !pathfinder_pathable {
        rejection = Some("no_path");
    }

    let pathable = terrain_pathable && pathfinder_pathable;
    let exposed = rejection.is_none()
        && request.stage != TacticalStageKind::AdvanceLine
        && request.stage != TacticalStageKind::Retreat
        && request.exposed_to_target;

    let score = i64::from(stage_score(request.stage, request.prefer_evasion))
        + if request.stage == TacticalStageKind::Flank {
            i64::from(request.flank_value_milli / 2)
        } else {
            0
        }
        + request.cover_score
        + request.situation_bias_score
        + request.tactic_bias_score
        + if has_shot { 9_000 } else { 0 }
        + if protected { 5_000 } else { 0 }
        - if exposed { 4_000 } else { 0 }
        - i64::from(request.actor_distance_milli / 3)
        - i64::from(request.range_error_milli / 3)
        - i64::from(request.lane_error_milli / 2)
        - i64::from(request.spacing_penalty_milli)
        - i64::from(request.cover_shadow_penalty_milli);

    TacticalCandidateScore {
        score,
        accepted: rejection.is_none(),
        rejection,
        has_shot,
        protected,
        pathable,
        terrain_pathable,
        pathfinder_pathable,
        claimed: request.claimed,
        inside_lane,
        crosses_no_mans_land: request.crosses_no_mans_land,
    }
}

const fn stage_score(stage: TacticalStageKind, prefer_evasion: bool) -> i32 {
    match stage {
        TacticalStageKind::GoodCover => 18_000,
        TacticalStageKind::SoftCover => 10_000,
        TacticalStageKind::Evasion => {
            if prefer_evasion {
                14_000
            } else {
                6_000
            }
        }
        TacticalStageKind::FiringLane => 7_000,
        TacticalStageKind::AdvanceLine => 6_500,
        TacticalStageKind::Flank => 8_500,
        TacticalStageKind::Retreat => 5_500,
    }
}

fn distance_milli_components(dx: i32, dy: i32) -> i32 {
    f64::from(dx)
        .hypot(f64::from(dy))
        .round()
        .clamp(0.0, f64::from(i32::MAX)) as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tactical_point_distance_milli(left: TacticalPoint, right: TacticalPoint) -> i32 {
        distance_milli_components(left.x_milli - right.x_milli, left.y_milli - right.y_milli)
    }

    fn base_request(stage: TacticalStageKind) -> TacticalCandidateScoreRequest {
        TacticalCandidateScoreRequest {
            stage,
            actor_distance_milli: 2_000,
            range_error_milli: 500,
            lane_error_milli: 0,
            flank_value_milli: 0,
            spacing_penalty_milli: 0,
            cover_shadow_penalty_milli: 0,
            cover_score: 0,
            near_world_edge: false,
            has_cover_point: false,
            terrain_blocked: false,
            body_blocked: false,
            clearance_blocked: false,
            recently_blocked: false,
            too_far: false,
            claimed: false,
            crosses_no_mans_land: false,
            inside_lane_before_shot: true,
            bad_range: false,
            raw_has_shot: false,
            require_shot: false,
            cover_required: false,
            prefer_evasion: false,
            allow_offensive_maneuver: true,
            situation_bias_score: 0,
            tactic_bias_score: 0,
            protected_by_cover: false,
            exposed_to_target: false,
            min_reposition_milli: 900,
        }
    }

    #[test]
    fn offensive_maneuver_gate_rejects_forward_pressure_stages() {
        for stage in [
            TacticalStageKind::FiringLane,
            TacticalStageKind::AdvanceLine,
            TacticalStageKind::Flank,
        ] {
            let mut request = base_request(stage);
            request.allow_offensive_maneuver = false;
            request.raw_has_shot = stage == TacticalStageKind::FiringLane;
            let scored = score_tactical_candidate(request);
            assert_eq!(scored.rejection, Some("offensive_maneuver_blocked"));
            assert!(!scored.accepted);
        }

        let mut cover = base_request(TacticalStageKind::GoodCover);
        cover.allow_offensive_maneuver = false;
        cover.has_cover_point = true;
        cover.cover_score = 2_000;
        cover.protected_by_cover = true;
        assert!(score_tactical_candidate(cover).accepted);
    }

    #[test]
    fn firing_lane_requires_a_shot_and_rewards_it() {
        let no_shot = score_tactical_candidate(base_request(TacticalStageKind::FiringLane));
        assert_eq!(no_shot.rejection, Some("no_firing_lane"));
        assert!(!no_shot.accepted);

        let mut with_shot = base_request(TacticalStageKind::FiringLane);
        with_shot.inside_lane_before_shot = false;
        with_shot.raw_has_shot = true;
        let scored = score_tactical_candidate(with_shot);
        assert!(scored.accepted);
        assert!(scored.has_shot);
        assert!(scored.inside_lane);
        assert!(scored.score > no_shot.score);
    }

    #[test]
    fn exposed_good_cover_is_rejected_until_protected() {
        let mut request = base_request(TacticalStageKind::GoodCover);
        request.has_cover_point = true;
        request.cover_score = 2_000;
        let exposed = score_tactical_candidate(request);
        assert_eq!(exposed.rejection, Some("unprotected_good_cover"));
        assert!(!exposed.accepted);

        request.protected_by_cover = true;
        let protected = score_tactical_candidate(request);
        assert!(protected.accepted);
        assert!(protected.protected);
    }

    #[test]
    fn edge_band_is_rejected_without_cover_point() {
        let mut request = base_request(TacticalStageKind::Evasion);
        request.near_world_edge = true;
        let scored = score_tactical_candidate(request);
        assert_eq!(scored.rejection, Some("edge_band"));
    }

    #[test]
    fn raw_shot_probe_gate_matches_combat_stage_and_range_policy() {
        let request = TacticalCandidateRawShotProbeRequest {
            stage: TacticalStageKind::FiringLane,
            target_distance_milli: 20_000,
            max_range_milli: 19_000,
            blocked: false,
            too_far: false,
            claimed: false,
            crosses_no_mans_land: false,
            bad_range: false,
        };
        assert!(tactical_candidate_raw_shot_probe_open(request));

        assert!(!tactical_candidate_raw_shot_probe_open(
            TacticalCandidateRawShotProbeRequest {
                stage: TacticalStageKind::AdvanceLine,
                ..request
            }
        ));
        assert!(!tactical_candidate_raw_shot_probe_open(
            TacticalCandidateRawShotProbeRequest {
                target_distance_milli: 20_501,
                ..request
            }
        ));
        assert!(!tactical_candidate_raw_shot_probe_open(
            TacticalCandidateRawShotProbeRequest {
                claimed: true,
                ..request
            }
        ));
    }

    #[test]
    fn open_live_probe_gate_tracks_blockers_lane_and_edge_cover() {
        let request = TacticalCandidateOpenProbeRequest {
            stage: TacticalStageKind::Evasion,
            actor_distance_milli: 1_200,
            min_reposition_milli: 900,
            terrain_blocked: false,
            body_blocked: false,
            clearance_blocked: false,
            recently_blocked: false,
            near_world_edge: false,
            has_cover_point: false,
            too_far: false,
            claimed: false,
            crosses_no_mans_land: false,
            inside_lane_before_shot: true,
            raw_has_shot: false,
            bad_range: false,
        };
        assert!(tactical_candidate_open_for_live_probe(request));

        assert!(!tactical_candidate_open_for_live_probe(
            TacticalCandidateOpenProbeRequest {
                body_blocked: true,
                ..request
            }
        ));
        assert!(!tactical_candidate_open_for_live_probe(
            TacticalCandidateOpenProbeRequest {
                near_world_edge: true,
                ..request
            }
        ));
        assert!(tactical_candidate_open_for_live_probe(
            TacticalCandidateOpenProbeRequest {
                near_world_edge: true,
                has_cover_point: true,
                ..request
            }
        ));
        assert!(tactical_candidate_open_for_live_probe(
            TacticalCandidateOpenProbeRequest {
                stage: TacticalStageKind::FiringLane,
                inside_lane_before_shot: false,
                raw_has_shot: true,
                ..request
            }
        ));
    }

    #[test]
    fn live_probe_stage_helpers_match_cover_and_exposure_policy() {
        assert!(tactical_candidate_should_probe_protection(
            TacticalStageKind::GoodCover,
            false
        ));
        assert!(tactical_candidate_should_probe_protection(
            TacticalStageKind::FiringLane,
            true
        ));
        assert!(!tactical_candidate_should_probe_protection(
            TacticalStageKind::FiringLane,
            false
        ));
        assert!(tactical_candidate_should_probe_exposure(
            TacticalStageKind::FiringLane
        ));
        assert!(!tactical_candidate_should_probe_exposure(
            TacticalStageKind::AdvanceLine
        ));
        assert!(!tactical_candidate_should_probe_exposure(
            TacticalStageKind::Retreat
        ));
    }

    #[test]
    fn cover_score_prefers_high_rated_anchor_cover() {
        let ordinary = cover_score_for_tactical_candidate(TacticalCoverScoreRequest {
            rating_milli: 600,
            high: false,
            anchor_profile: false,
            actor_distance_milli: 2_000,
            threat_distance_milli: 8_000,
        });
        let anchor_high = cover_score_for_tactical_candidate(TacticalCoverScoreRequest {
            rating_milli: 600,
            high: true,
            anchor_profile: true,
            actor_distance_milli: 2_000,
            threat_distance_milli: 8_000,
        });

        assert!(anchor_high > ordinary);
    }

    #[test]
    fn cover_shadow_penalty_uses_prop_center_and_half_distance() {
        let penalty =
            cover_shadow_penalty_for_tactical_candidate(TacticalCoverShadowPenaltyRequest {
                candidate_x_milli: 11_000,
                candidate_y_milli: 8_000,
                prop_left_milli: 4_000,
                prop_right_milli: 8_000,
                prop_top_milli: 4_000,
                prop_bottom_milli: 8_000,
            });

        assert_eq!(penalty, 2_692);
    }

    #[test]
    fn cover_shadow_penalty_preserves_saturating_midpoint_math() {
        let penalty =
            cover_shadow_penalty_for_tactical_candidate(TacticalCoverShadowPenaltyRequest {
                candidate_x_milli: i32::MAX / 2,
                candidate_y_milli: 0,
                prop_left_milli: i32::MAX,
                prop_right_milli: i32::MAX,
                prop_top_milli: 0,
                prop_bottom_milli: 0,
            });

        assert_eq!(penalty, 0);
    }

    #[test]
    fn tactical_lane_error_uses_lateral_projection_window() {
        let inside = tactical_lane_error_milli(TacticalLaneErrorRequest {
            position: TacticalPoint::new(5_000, 6_000),
            origin: TacticalPoint::new(5_000, 5_000),
            lateral_x_milli: 0,
            lateral_y_milli: 1_000,
            min_offset_milli: -1_000,
            max_offset_milli: 1_000,
        });
        let outside = tactical_lane_error_milli(TacticalLaneErrorRequest {
            position: TacticalPoint::new(5_000, 7_500),
            origin: TacticalPoint::new(5_000, 5_000),
            lateral_x_milli: 0,
            lateral_y_milli: 1_000,
            min_offset_milli: -1_000,
            max_offset_milli: 1_000,
        });

        assert_eq!(inside, 0);
        assert_eq!(outside, 1_500);
        assert!(tactical_position_inside_lane(outside, 2_000));
        assert!(!tactical_position_inside_lane(outside, 1_000));
    }

    #[test]
    fn tactical_stage_policy_controls_lane_and_no_mans_land_gates() {
        assert!(tactical_candidate_inside_lane_for_stage(
            TacticalStageKind::Evasion,
            false
        ));
        assert!(tactical_candidate_inside_lane_for_stage(
            TacticalStageKind::Flank,
            false
        ));
        assert!(tactical_candidate_inside_lane_for_stage(
            TacticalStageKind::Retreat,
            false
        ));
        assert!(!tactical_candidate_inside_lane_for_stage(
            TacticalStageKind::FiringLane,
            false
        ));
        assert!(!tactical_stage_needs_lane_probe(TacticalStageKind::Evasion));
        assert!(!tactical_stage_needs_lane_probe(TacticalStageKind::Flank));
        assert!(!tactical_stage_needs_lane_probe(TacticalStageKind::Retreat));
        assert!(tactical_stage_needs_lane_probe(
            TacticalStageKind::FiringLane
        ));

        assert!(!tactical_candidate_crosses_no_mans_land_for_stage(
            TacticalStageKind::Evasion,
            true
        ));
        assert!(!tactical_candidate_crosses_no_mans_land_for_stage(
            TacticalStageKind::Retreat,
            true
        ));
        assert!(tactical_candidate_crosses_no_mans_land_for_stage(
            TacticalStageKind::FiringLane,
            true
        ));
        assert!(!tactical_stage_needs_no_mans_land_probe(
            TacticalStageKind::Evasion
        ));
        assert!(!tactical_stage_needs_no_mans_land_probe(
            TacticalStageKind::Retreat
        ));
        assert!(tactical_stage_needs_no_mans_land_probe(
            TacticalStageKind::FiringLane
        ));
    }

    #[test]
    fn no_mans_land_and_flank_value_use_tactical_projection() {
        assert!(tactical_position_crosses_no_mans_land(
            TacticalNoMansLandRequest {
                position: TacticalPoint::new(6_501, 0),
                no_mans_land: TacticalPoint::new(5_000, 0),
                direction_x_milli: 1_000,
                direction_y_milli: 0,
                margin_milli: 1_500,
            },
        ));
        assert!(!tactical_position_crosses_no_mans_land(
            TacticalNoMansLandRequest {
                position: TacticalPoint::new(6_500, 0),
                no_mans_land: TacticalPoint::new(5_000, 0),
                direction_x_milli: 1_000,
                direction_y_milli: 0,
                margin_milli: 1_500,
            },
        ));

        let flank = tactical_flank_value_milli(TacticalFlankValueRequest {
            position: TacticalPoint::new(0, -12_000),
            origin: TacticalPoint::new(0, 0),
            lateral_x_milli: 0,
            lateral_y_milli: 1_000,
            max_value_milli: 8_000,
        });
        assert_eq!(flank, 8_000);
    }

    #[test]
    fn tactical_claim_policy_ignores_self_and_other_areas() {
        let claims = [
            TacticalPositionClaim {
                actor_id: "self",
                area_id: "street",
                position: TacticalPoint::new(0, 0),
            },
            TacticalPositionClaim {
                actor_id: "ally",
                area_id: "other",
                position: TacticalPoint::new(100, 0),
            },
            TacticalPositionClaim {
                actor_id: "ally",
                area_id: "street",
                position: TacticalPoint::new(800, 0),
            },
        ];

        assert!(tactical_candidate_claimed(
            TacticalCandidateClaimRequest {
                actor_id: "self",
                area_id: "street",
                position: TacticalPoint::new(0, 0),
                claim_radius_milli: 850,
            },
            claims,
            tactical_point_distance_milli,
        ));
        assert!(!tactical_candidate_claimed(
            TacticalCandidateClaimRequest {
                actor_id: "self",
                area_id: "street",
                position: TacticalPoint::new(2_000, 0),
                claim_radius_milli: 850,
            },
            claims,
            tactical_point_distance_milli,
        ));
    }

    #[test]
    fn tactical_spacing_penalty_sums_near_same_area_allies() {
        let claims = [
            TacticalPositionClaim {
                actor_id: "self",
                area_id: "street",
                position: TacticalPoint::new(0, 0),
            },
            TacticalPositionClaim {
                actor_id: "near",
                area_id: "street",
                position: TacticalPoint::new(500, 0),
            },
            TacticalPositionClaim {
                actor_id: "other_area",
                area_id: "other",
                position: TacticalPoint::new(500, 0),
            },
            TacticalPositionClaim {
                actor_id: "far",
                area_id: "street",
                position: TacticalPoint::new(2_500, 0),
            },
        ];

        let penalty = tactical_ally_spacing_penalty(
            TacticalAllySpacingPenaltyRequest {
                actor_id: "self",
                area_id: "street",
                position: TacticalPoint::new(0, 0),
                spacing_radius_milli: 2_000,
            },
            claims,
            tactical_point_distance_milli,
        );

        assert_eq!(penalty, 1_500);
    }

    #[test]
    fn distance_and_range_gates_match_stage_policy() {
        assert!(tactical_candidate_too_far(
            TacticalCandidateDistanceLimitRequest {
                stage: TacticalStageKind::Retreat,
                actor_distance_milli: 39_001,
                cover_search_radius_milli: 20_000,
                max_range_milli: 28_000,
                acquire_radius_milli: 115_000,
                retreat_extra_milli: 8_000,
                default_extra_milli: 3_000,
            },
        ));
        assert!(!tactical_candidate_bad_range(
            TacticalCandidateBadRangeRequest {
                stage: TacticalStageKind::Evasion,
                target_distance_milli: 1_000,
                min_range_milli: 6_000,
                max_range_milli: 18_000,
                prefer_cover: false,
            },
        ));
        assert!(tactical_candidate_bad_range(
            TacticalCandidateBadRangeRequest {
                stage: TacticalStageKind::Evasion,
                target_distance_milli: 21_000,
                min_range_milli: 6_000,
                max_range_milli: 18_000,
                prefer_cover: false,
            },
        ));
        assert!(!tactical_candidate_bad_range(
            TacticalCandidateBadRangeRequest {
                stage: TacticalStageKind::Retreat,
                target_distance_milli: 23_500,
                min_range_milli: 6_000,
                max_range_milli: 18_000,
                prefer_cover: false,
            },
        ));
        assert!(tactical_candidate_bad_range(
            TacticalCandidateBadRangeRequest {
                stage: TacticalStageKind::Retreat,
                target_distance_milli: 24_001,
                min_range_milli: 6_000,
                max_range_milli: 18_000,
                prefer_cover: false,
            },
        ));
        assert!(!tactical_candidate_bad_range(
            TacticalCandidateBadRangeRequest {
                stage: TacticalStageKind::FiringLane,
                target_distance_milli: 0,
                min_range_milli: 6_000,
                max_range_milli: 18_000,
                prefer_cover: false,
            },
        ));
        assert!(tactical_candidate_bad_range(
            TacticalCandidateBadRangeRequest {
                stage: TacticalStageKind::FiringLane,
                target_distance_milli: 21_000,
                min_range_milli: 6_000,
                max_range_milli: 18_000,
                prefer_cover: false,
            },
        ));
    }
}
