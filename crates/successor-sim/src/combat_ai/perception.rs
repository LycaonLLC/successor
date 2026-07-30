#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalPoint {
    pub(crate) x_milli: i32,
    pub(crate) y_milli: i32,
}

impl TacticalPoint {
    pub(crate) const fn new(x_milli: i32, y_milli: i32) -> Self {
        Self { x_milli, y_milli }
    }

    fn offset(self, dx_milli: i32, dy_milli: i32) -> Self {
        Self {
            x_milli: self.x_milli.saturating_add(dx_milli),
            y_milli: self.y_milli.saturating_add(dy_milli),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalProjectionRequest {
    pub(crate) position: TacticalPoint,
    pub(crate) origin: TacticalPoint,
    pub(crate) axis_x_milli: i32,
    pub(crate) axis_y_milli: i32,
}

pub(crate) fn project_tactical_position_milli(request: TacticalProjectionRequest) -> i32 {
    let dx = i64::from(request.position.x_milli - request.origin.x_milli);
    let dy = i64::from(request.position.y_milli - request.origin.y_milli);
    let value = dx.saturating_mul(i64::from(request.axis_x_milli))
        + dy.saturating_mul(i64::from(request.axis_y_milli));
    (value / 1_000).clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalSlotContext {
    pub(crate) lateral_x_milli: i32,
    pub(crate) lateral_y_milli: i32,
    pub(crate) lane_center_offset_milli: i32,
    pub(crate) lane_width_milli: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalSlotRequest {
    pub(crate) actor_hash: u32,
    pub(crate) actor_position: TacticalPoint,
    pub(crate) anchor: TacticalPoint,
    pub(crate) slot_distance_milli: i32,
    pub(crate) inner_slot_distance_milli: i32,
    pub(crate) reject_anchor: bool,
    pub(crate) max_anchor_distance_milli: Option<i32>,
    pub(crate) context: Option<TacticalSlotContext>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalDirection {
    pub(crate) toward_x_milli: i32,
    pub(crate) toward_y_milli: i32,
    pub(crate) lateral_x_milli: i32,
    pub(crate) lateral_y_milli: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalFormation {
    pub(crate) direction: TacticalDirection,
    pub(crate) lane_center_offset_milli: i32,
    pub(crate) lane_width_milli: i32,
    pub(crate) front_width_milli: i32,
    pub(crate) no_mans_land: Option<TacticalPoint>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalRangeProfile {
    pub(crate) min_range_milli: i32,
    pub(crate) preferred_range_milli: i32,
    pub(crate) max_range_milli: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalCandidate {
    pub(crate) point: TacticalPoint,
    pub(crate) kind: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TacticalCoverStage {
    Good,
    Soft,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalCoverPoint {
    pub(crate) source_index: usize,
    pub(crate) point: TacticalPoint,
    pub(crate) high: bool,
    pub(crate) rating_milli: i32,
    pub(crate) protects_from_threat: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalCoverRequest {
    pub(crate) actor: TacticalPoint,
    pub(crate) search_radius_milli: i32,
    pub(crate) soft_cover_extra_radius_milli: i32,
    pub(crate) min_good_cover_rating_milli: i32,
    pub(crate) stage: TacticalCoverStage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalCoverCandidate {
    pub(crate) source_index: usize,
    pub(crate) point: TacticalPoint,
    pub(crate) kind: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalFiringLaneRequest {
    pub(crate) actor: TacticalPoint,
    pub(crate) target: TacticalPoint,
    pub(crate) direction: TacticalDirection,
    pub(crate) formation: Option<TacticalFormation>,
    pub(crate) range: TacticalRangeProfile,
    pub(crate) evasion_step_milli: i32,
    pub(crate) jitter: Option<(i32, i32)>,
    pub(crate) kind: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalEvasionRequest {
    pub(crate) actor: TacticalPoint,
    pub(crate) direction: TacticalDirection,
    pub(crate) evasion_step_milli: i32,
    pub(crate) lane_width_milli: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalAdvanceLineRequest {
    pub(crate) actor: TacticalPoint,
    pub(crate) target: TacticalPoint,
    pub(crate) formation: Option<TacticalFormation>,
    pub(crate) range: TacticalRangeProfile,
    pub(crate) no_mans_land_margin_milli: i32,
    pub(crate) frontline_min_standoff_milli: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalFlankRequest {
    pub(crate) target: TacticalPoint,
    pub(crate) formation: Option<TacticalFormation>,
    pub(crate) range: TacticalRangeProfile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalRetreatRequest {
    pub(crate) actor: TacticalPoint,
    pub(crate) home: TacticalPoint,
    pub(crate) formation: Option<TacticalFormation>,
    pub(crate) range: TacticalRangeProfile,
}

pub(crate) fn select_tactical_slot<FClamp, FAvailable>(
    request: TacticalSlotRequest,
    clamp: FClamp,
    available: FAvailable,
) -> TacticalPoint
where
    FClamp: Fn(TacticalPoint) -> TacticalPoint,
    FAvailable: Fn(TacticalPoint) -> bool,
{
    let clamped_anchor = clamp(request.anchor);
    if let Some(context) = request.context {
        for candidate in lane_candidates(clamped_anchor, context) {
            let candidate = clamp(candidate);
            if slot_candidate_allowed(request, clamped_anchor, candidate) && available(candidate) {
                return candidate;
            }
        }
    } else if !request.reject_anchor && available(clamped_anchor) {
        return clamped_anchor;
    }

    if let Some(candidate) = adjacent_slot_candidate(
        request,
        request.slot_distance_milli,
        clamped_anchor,
        &clamp,
        &available,
    ) {
        return candidate;
    }
    if request.max_anchor_distance_milli.is_some()
        && request.inner_slot_distance_milli > 0
        && request.inner_slot_distance_milli != request.slot_distance_milli
    {
        if let Some(candidate) = adjacent_slot_candidate(
            request,
            request.inner_slot_distance_milli,
            clamped_anchor,
            &clamp,
            &available,
        ) {
            return candidate;
        }
    }

    request.actor_position
}

pub(crate) fn cover_candidates<I>(
    request: TacticalCoverRequest,
    points: I,
) -> Vec<TacticalCoverCandidate>
where
    I: IntoIterator<Item = TacticalCoverPoint>,
{
    let max_distance =
        request
            .search_radius_milli
            .saturating_add(if request.stage == TacticalCoverStage::Soft {
                request.soft_cover_extra_radius_milli
            } else {
                0
            });
    points
        .into_iter()
        .filter(|point| distance_milli(request.actor, point.point) <= max_distance)
        .filter(|point| {
            request.stage != TacticalCoverStage::Good
                || (point.high
                    && point.protects_from_threat
                    && point.rating_milli >= request.min_good_cover_rating_milli)
        })
        .map(|point| TacticalCoverCandidate {
            source_index: point.source_index,
            point: point.point,
            kind: if point.high {
                "high_cover"
            } else {
                "soft_cover"
            },
        })
        .collect()
}

pub(crate) fn firing_lane_candidates(request: TacticalFiringLaneRequest) -> Vec<TacticalCandidate> {
    let mut candidates = Vec::new();
    for lateral_sign in [-1, 1] {
        for (forward, lateral) in [
            (0, request.evasion_step_milli),
            (request.evasion_step_milli / 2, request.evasion_step_milli),
            (request.evasion_step_milli, request.evasion_step_milli / 2),
        ] {
            candidates.push(TacticalCandidate {
                point: request.actor.offset(
                    scaled_unit_component(request.direction.toward_x_milli, forward)
                        .saturating_add(scaled_unit_component(
                            request.direction.lateral_x_milli,
                            lateral.saturating_mul(lateral_sign),
                        )),
                    scaled_unit_component(request.direction.toward_y_milli, forward)
                        .saturating_add(scaled_unit_component(
                            request.direction.lateral_y_milli,
                            lateral.saturating_mul(lateral_sign),
                        )),
                ),
                kind: "peek_lane",
            });
        }
    }

    let local_units = [
        (1_000, 0),
        (-1_000, 0),
        (0, 1_000),
        (0, -1_000),
        (707, 707),
        (707, -707),
        (-707, 707),
        (-707, -707),
    ];
    for radius in [1_500, 3_000, 4_500, 6_000, 8_000] {
        for (unit_x, unit_y) in local_units {
            candidates.push(TacticalCandidate {
                point: request.actor.offset(
                    scaled_unit_component(unit_x, radius),
                    scaled_unit_component(unit_y, radius),
                ),
                kind: "local_peek_lane",
            });
        }
    }

    if let Some(formation) = request.formation {
        for range in firing_lane_ranges(request.range) {
            for lane_offset in formation.lane_offsets() {
                candidates.push(TacticalCandidate {
                    point: request.target.offset(
                        0_i32
                            .saturating_sub(scaled_unit_component(
                                formation.direction.toward_x_milli,
                                range,
                            ))
                            .saturating_add(scaled_unit_component(
                                formation.direction.lateral_x_milli,
                                lane_offset,
                            )),
                        0_i32
                            .saturating_sub(scaled_unit_component(
                                formation.direction.toward_y_milli,
                                range,
                            ))
                            .saturating_add(scaled_unit_component(
                                formation.direction.lateral_y_milli,
                                lane_offset,
                            )),
                    ),
                    kind: request.kind,
                });
            }
        }
    }

    for range in firing_lane_ranges(request.range) {
        for sign in [-1, 1] {
            candidates.push(TacticalCandidate {
                point: TacticalPoint::new(
                    request.target.x_milli.saturating_add(sign * range),
                    request.target.y_milli,
                ),
                kind: request.kind,
            });
            candidates.push(TacticalCandidate {
                point: TacticalPoint::new(
                    request.target.x_milli,
                    request.target.y_milli.saturating_add(sign * range),
                ),
                kind: request.kind,
            });
        }
    }

    if request.formation.is_none() {
        if let Some((jitter_x, jitter_y)) = request.jitter {
            candidates.push(TacticalCandidate {
                point: request.actor.offset(jitter_x, jitter_y),
                kind: "open_cell",
            });
        }
    }

    candidates
}

pub(crate) fn evasion_candidates(request: TacticalEvasionRequest) -> Vec<TacticalCandidate> {
    let mut candidates = Vec::new();
    let lateral_steps = [
        request.evasion_step_milli,
        request
            .evasion_step_milli
            .saturating_add(request.lane_width_milli / 2),
    ];
    for sign in [-1, 1] {
        for lateral_step in lateral_steps {
            candidates.push(TacticalCandidate {
                point: request.actor.offset(
                    scaled_unit_component(
                        request.direction.lateral_x_milli,
                        lateral_step.saturating_mul(sign),
                    )
                    .saturating_sub(scaled_unit_component(
                        request.direction.toward_x_milli,
                        request.evasion_step_milli / 3,
                    )),
                    scaled_unit_component(
                        request.direction.lateral_y_milli,
                        lateral_step.saturating_mul(sign),
                    )
                    .saturating_sub(scaled_unit_component(
                        request.direction.toward_y_milli,
                        request.evasion_step_milli / 3,
                    )),
                ),
                kind: "evasion",
            });
        }
    }
    candidates
}

pub(crate) fn advance_line_candidates(
    request: TacticalAdvanceLineRequest,
) -> Vec<TacticalCandidate> {
    let stand_offs = [
        request.no_mans_land_margin_milli.saturating_add(
            (request.range.preferred_range_milli / 2).max(request.frontline_min_standoff_milli),
        ),
        request
            .no_mans_land_margin_milli
            .saturating_add(request.range.preferred_range_milli),
        request.no_mans_land_margin_milli.saturating_add(
            (request.range.min_range_milli / 2).max(request.frontline_min_standoff_milli),
        ),
    ];
    let mut candidates = Vec::new();
    if let Some(formation) = request.formation {
        if let Some(no_mans_land) = formation.no_mans_land {
            for stand_off in stand_offs {
                for lane_offset in formation.lane_offsets() {
                    candidates.push(TacticalCandidate {
                        point: no_mans_land.offset(
                            0_i32
                                .saturating_sub(scaled_unit_component(
                                    formation.direction.toward_x_milli,
                                    stand_off,
                                ))
                                .saturating_add(scaled_unit_component(
                                    formation.direction.lateral_x_milli,
                                    lane_offset,
                                )),
                            0_i32
                                .saturating_sub(scaled_unit_component(
                                    formation.direction.toward_y_milli,
                                    stand_off,
                                ))
                                .saturating_add(scaled_unit_component(
                                    formation.direction.lateral_y_milli,
                                    lane_offset,
                                )),
                        ),
                        kind: "advance_line",
                    });
                }
            }
            return candidates;
        }
    }

    let gap = distance_milli(request.actor, request.target);
    if gap <= request.range.max_range_milli.saturating_add(1_500) {
        return candidates;
    }
    let dx = request.actor.x_milli.saturating_sub(request.target.x_milli);
    let dy = request.actor.y_milli.saturating_sub(request.target.y_milli);
    let gap = gap.max(1);
    let away_x = ((i64::from(dx) * 1_000) / i64::from(gap))
        .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
    let away_y = ((i64::from(dy) * 1_000) / i64::from(gap))
        .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32;
    let lateral_x = -away_y;
    let lateral_y = away_x;
    let fallback_stand_offs = [
        request.range.preferred_range_milli,
        request.range.max_range_milli.saturating_sub(1_500),
        request.range.min_range_milli.saturating_add(1_500),
    ];
    let lateral_offsets = [0, 2_000, -2_000];
    for stand_off in fallback_stand_offs {
        for lane_offset in lateral_offsets {
            candidates.push(TacticalCandidate {
                point: request.target.offset(
                    scaled_unit_component(away_x, stand_off)
                        .saturating_add(scaled_unit_component(lateral_x, lane_offset)),
                    scaled_unit_component(away_y, stand_off)
                        .saturating_add(scaled_unit_component(lateral_y, lane_offset)),
                ),
                kind: "advance_to_contact",
            });
        }
    }
    candidates
}

pub(crate) fn flank_candidates(request: TacticalFlankRequest) -> Vec<TacticalCandidate> {
    let mut candidates = Vec::new();
    for sign in [-1, 1] {
        let point = if let Some(formation) = request.formation {
            let flank_base = (formation.front_width_milli / 2)
                .saturating_add(formation.lane_width_milli)
                .saturating_mul(sign);
            request.target.offset(
                0_i32
                    .saturating_sub(scaled_unit_component(
                        formation.direction.toward_x_milli,
                        request.range.preferred_range_milli,
                    ))
                    .saturating_add(scaled_unit_component(
                        formation.direction.lateral_x_milli,
                        flank_base,
                    )),
                0_i32
                    .saturating_sub(scaled_unit_component(
                        formation.direction.toward_y_milli,
                        request.range.preferred_range_milli,
                    ))
                    .saturating_add(scaled_unit_component(
                        formation.direction.lateral_y_milli,
                        flank_base,
                    )),
            )
        } else {
            TacticalPoint::new(
                request
                    .target
                    .x_milli
                    .saturating_add(sign * request.range.preferred_range_milli),
                request
                    .target
                    .y_milli
                    .saturating_add(sign * request.range.min_range_milli / 2),
            )
        };
        candidates.push(TacticalCandidate {
            point,
            kind: "flank",
        });
    }
    candidates
}

pub(crate) fn retreat_candidates(request: TacticalRetreatRequest) -> Vec<TacticalCandidate> {
    let mut candidates = vec![TacticalCandidate {
        point: request.home,
        kind: "home",
    }];
    if let Some(formation) = request.formation {
        for range in [
            request.range.preferred_range_milli,
            request.range.preferred_range_milli.saturating_add(3_000),
        ] {
            candidates.push(TacticalCandidate {
                point: request.actor.offset(
                    0_i32.saturating_sub(scaled_unit_component(
                        formation.direction.toward_x_milli,
                        range,
                    )),
                    0_i32.saturating_sub(scaled_unit_component(
                        formation.direction.toward_y_milli,
                        range,
                    )),
                ),
                kind: "retreat",
            });
        }
    }
    candidates
}

fn lane_candidates(
    anchor: TacticalPoint,
    context: TacticalSlotContext,
) -> impl Iterator<Item = TacticalPoint> {
    [
        context.lane_center_offset_milli,
        context
            .lane_center_offset_milli
            .saturating_sub(context.lane_width_milli / 2),
        context
            .lane_center_offset_milli
            .saturating_add(context.lane_width_milli / 2),
    ]
    .into_iter()
    .map(move |offset| {
        anchor.offset(
            scaled_unit_component(context.lateral_x_milli, offset),
            scaled_unit_component(context.lateral_y_milli, offset),
        )
    })
}

fn adjacent_slot_candidate<FClamp, FAvailable>(
    request: TacticalSlotRequest,
    slot_distance_milli: i32,
    clamped_anchor: TacticalPoint,
    clamp: &FClamp,
    available: &FAvailable,
) -> Option<TacticalPoint>
where
    FClamp: Fn(TacticalPoint) -> TacticalPoint,
    FAvailable: Fn(TacticalPoint) -> bool,
{
    let offsets = [
        (slot_distance_milli, 0),
        (0, slot_distance_milli),
        (-slot_distance_milli, 0),
        (0, -slot_distance_milli),
        (slot_distance_milli, slot_distance_milli),
        (-slot_distance_milli, slot_distance_milli),
        (-slot_distance_milli, -slot_distance_milli),
        (slot_distance_milli, -slot_distance_milli),
    ];
    let start = request.actor_hash as usize % offsets.len();
    for index in 0..offsets.len() {
        let (dx_milli, dy_milli) = offsets[(start + index) % offsets.len()];
        let candidate = clamp(clamped_anchor.offset(dx_milli, dy_milli));
        if slot_candidate_allowed(request, clamped_anchor, candidate) && available(candidate) {
            return Some(candidate);
        }
    }
    None
}

fn slot_candidate_allowed(
    request: TacticalSlotRequest,
    clamped_anchor: TacticalPoint,
    candidate: TacticalPoint,
) -> bool {
    if request.reject_anchor && distance_milli(candidate, clamped_anchor) <= 1 {
        return false;
    }
    if request
        .max_anchor_distance_milli
        .is_some_and(|max_distance| distance_milli(candidate, clamped_anchor) > max_distance)
    {
        return false;
    }
    true
}

impl TacticalFormation {
    fn lane_offsets(self) -> [i32; 3] {
        [
            self.lane_center_offset_milli,
            self.lane_center_offset_milli
                .saturating_sub(self.lane_width_milli / 2),
            self.lane_center_offset_milli
                .saturating_add(self.lane_width_milli / 2),
        ]
    }
}

fn firing_lane_ranges(range: TacticalRangeProfile) -> [i32; 3] {
    [
        range.preferred_range_milli,
        (range.min_range_milli + range.preferred_range_milli) / 2,
        range
            .max_range_milli
            .min(range.preferred_range_milli.saturating_add(3_500)),
    ]
}

fn scaled_unit_component(unit_milli: i32, distance_milli: i32) -> i32 {
    let value = i64::from(unit_milli).saturating_mul(i64::from(distance_milli)) / 1_000;
    value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

pub(crate) fn distance_milli(left: TacticalPoint, right: TacticalPoint) -> i32 {
    let dx = i64::from(left.x_milli.saturating_sub(right.x_milli));
    let dy = i64::from(left.y_milli.saturating_sub(right.y_milli));
    (dx as f64)
        .hypot(dy as f64)
        .round()
        .clamp(0.0, f64::from(i32::MAX)) as i32
}

#[cfg(test)]
mod tests {
    use super::{
        advance_line_candidates, cover_candidates, distance_milli, evasion_candidates,
        firing_lane_candidates, flank_candidates, project_tactical_position_milli,
        retreat_candidates, select_tactical_slot, TacticalAdvanceLineRequest, TacticalCoverPoint,
        TacticalCoverRequest, TacticalCoverStage, TacticalDirection, TacticalEvasionRequest,
        TacticalFiringLaneRequest, TacticalFlankRequest, TacticalFormation, TacticalPoint,
        TacticalProjectionRequest, TacticalRangeProfile, TacticalRetreatRequest,
        TacticalSlotContext, TacticalSlotRequest,
    };

    #[test]
    fn tactical_projection_projects_position_onto_scaled_axis() {
        let projected = project_tactical_position_milli(TacticalProjectionRequest {
            position: TacticalPoint::new(10_000, 7_000),
            origin: TacticalPoint::new(4_000, 3_000),
            axis_x_milli: 707,
            axis_y_milli: 707,
        });

        assert_eq!(projected, 7_070);
    }

    #[test]
    fn tactical_slot_uses_lane_before_adjacent_fallback() {
        let request = TacticalSlotRequest {
            actor_hash: 0,
            actor_position: TacticalPoint::new(0, 0),
            anchor: TacticalPoint::new(10_000, 10_000),
            slot_distance_milli: 2_000,
            inner_slot_distance_milli: 1_000,
            reject_anchor: false,
            max_anchor_distance_milli: None,
            context: Some(TacticalSlotContext {
                lateral_x_milli: 1_000,
                lateral_y_milli: 0,
                lane_center_offset_milli: 3_000,
                lane_width_milli: 2_000,
            }),
        };

        let selected = select_tactical_slot(request, |point| point, |_| true);
        assert_eq!(selected, TacticalPoint::new(13_000, 10_000));
    }

    #[test]
    fn tactical_slot_rejects_anchor_and_honors_max_distance() {
        let request = TacticalSlotRequest {
            actor_hash: 0,
            actor_position: TacticalPoint::new(0, 0),
            anchor: TacticalPoint::new(10_000, 10_000),
            slot_distance_milli: 2_000,
            inner_slot_distance_milli: 1_000,
            reject_anchor: true,
            max_anchor_distance_milli: Some(1_000),
            context: None,
        };
        let selected = select_tactical_slot(request, |point| point, |_| true);

        assert_eq!(selected, TacticalPoint::new(11_000, 10_000));
    }

    #[test]
    fn tactical_slot_returns_actor_position_when_no_candidate_is_available() {
        let request = TacticalSlotRequest {
            actor_hash: 0,
            actor_position: TacticalPoint::new(5_000, 5_000),
            anchor: TacticalPoint::new(10_000, 10_000),
            slot_distance_milli: 1_000,
            inner_slot_distance_milli: 1_000,
            reject_anchor: true,
            max_anchor_distance_milli: Some(1_000),
            context: None,
        };
        let selected = select_tactical_slot(request, |point| point, |_| false);

        assert_eq!(selected, TacticalPoint::new(5_000, 5_000));
    }

    #[test]
    fn tactical_candidate_generators_emit_atomic_stage_shapes() {
        let direction = TacticalDirection {
            toward_x_milli: 1_000,
            toward_y_milli: 0,
            lateral_x_milli: 0,
            lateral_y_milli: 1_000,
        };
        let formation = TacticalFormation {
            direction,
            lane_center_offset_milli: 0,
            lane_width_milli: 2_000,
            front_width_milli: 6_000,
            no_mans_land: Some(TacticalPoint::new(20_000, 10_000)),
        };
        let range = TacticalRangeProfile {
            min_range_milli: 4_000,
            preferred_range_milli: 8_000,
            max_range_milli: 12_000,
        };

        let firing = firing_lane_candidates(TacticalFiringLaneRequest {
            actor: TacticalPoint::new(4_000, 10_000),
            target: TacticalPoint::new(24_000, 10_000),
            direction,
            formation: Some(formation),
            range,
            evasion_step_milli: 3_000,
            jitter: None,
            kind: "firing_lane",
        });
        assert!(firing.iter().any(|candidate| candidate.kind == "peek_lane"));
        assert!(firing
            .iter()
            .any(|candidate| candidate.kind == "local_peek_lane"));
        assert!(firing
            .iter()
            .any(|candidate| candidate.kind == "firing_lane"));

        let evasion = evasion_candidates(TacticalEvasionRequest {
            actor: TacticalPoint::new(4_000, 10_000),
            direction,
            evasion_step_milli: 3_000,
            lane_width_milli: 2_000,
        });
        assert_eq!(evasion.len(), 4);
        assert!(evasion.iter().all(|candidate| candidate.kind == "evasion"));

        let advance = advance_line_candidates(TacticalAdvanceLineRequest {
            actor: TacticalPoint::new(4_000, 10_000),
            target: TacticalPoint::new(24_000, 10_000),
            formation: Some(formation),
            range,
            no_mans_land_margin_milli: 2_000,
            frontline_min_standoff_milli: 2_000,
        });
        assert_eq!(advance.len(), 9);
        assert!(advance
            .iter()
            .all(|candidate| candidate.kind == "advance_line"));

        let contact_advance = advance_line_candidates(TacticalAdvanceLineRequest {
            actor: TacticalPoint::new(80_000, 10_000),
            target: TacticalPoint::new(20_000, 10_000),
            formation: None,
            range,
            no_mans_land_margin_milli: 2_000,
            frontline_min_standoff_milli: 2_000,
        });
        assert_eq!(contact_advance.len(), 9);
        assert!(contact_advance
            .iter()
            .all(|candidate| candidate.kind == "advance_to_contact"));
        assert!(contact_advance.iter().any(|candidate| {
            distance_milli(candidate.point, TacticalPoint::new(20_000, 10_000))
                == range.preferred_range_milli
        }));

        let flank = flank_candidates(TacticalFlankRequest {
            target: TacticalPoint::new(24_000, 10_000),
            formation: Some(formation),
            range,
        });
        assert_eq!(flank.len(), 2);
        assert!(flank.iter().all(|candidate| candidate.kind == "flank"));

        let retreat = retreat_candidates(TacticalRetreatRequest {
            actor: TacticalPoint::new(14_000, 10_000),
            home: TacticalPoint::new(2_000, 2_000),
            formation: Some(formation),
            range,
        });
        assert_eq!(retreat.len(), 3);
        assert_eq!(retreat[0].kind, "home");
    }

    #[test]
    fn tactical_cover_candidates_filter_good_cover_and_soft_radius() {
        let points = [
            TacticalCoverPoint {
                source_index: 0,
                point: TacticalPoint::new(2_000, 0),
                high: true,
                rating_milli: 600,
                protects_from_threat: true,
            },
            TacticalCoverPoint {
                source_index: 1,
                point: TacticalPoint::new(2_500, 0),
                high: true,
                rating_milli: 300,
                protects_from_threat: true,
            },
            TacticalCoverPoint {
                source_index: 2,
                point: TacticalPoint::new(5_000, 0),
                high: false,
                rating_milli: 100,
                protects_from_threat: false,
            },
        ];

        let good = cover_candidates(
            TacticalCoverRequest {
                actor: TacticalPoint::new(0, 0),
                search_radius_milli: 3_000,
                soft_cover_extra_radius_milli: 3_000,
                min_good_cover_rating_milli: 500,
                stage: TacticalCoverStage::Good,
            },
            points,
        );
        assert_eq!(good.len(), 1);
        assert_eq!(good[0].source_index, 0);
        assert_eq!(good[0].kind, "high_cover");

        let soft = cover_candidates(
            TacticalCoverRequest {
                actor: TacticalPoint::new(0, 0),
                search_radius_milli: 3_000,
                soft_cover_extra_radius_milli: 3_000,
                min_good_cover_rating_milli: 500,
                stage: TacticalCoverStage::Soft,
            },
            points,
        );
        assert_eq!(soft.len(), 3);
        assert_eq!(soft[2].source_index, 2);
        assert_eq!(soft[2].kind, "soft_cover");
    }
}
