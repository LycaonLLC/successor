use super::perception::TacticalPoint;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct MicroReversalRequest {
    pub(crate) tick: u64,
    pub(crate) last_move_tick: u64,
    pub(crate) last_move_dx_milli: i32,
    pub(crate) last_move_dy_milli: i32,
    pub(crate) move_dx_milli: i32,
    pub(crate) move_dy_milli: i32,
    pub(crate) window_ticks: u64,
    pub(crate) max_step_milli: i32,
}

pub(crate) fn micro_reversal_blocked(request: MicroReversalRequest) -> bool {
    if request.last_move_tick == 0
        || request.tick.saturating_sub(request.last_move_tick) > request.window_ticks
    {
        return false;
    }
    let step = distance_milli_components(request.move_dx_milli, request.move_dy_milli);
    let previous_step =
        distance_milli_components(request.last_move_dx_milli, request.last_move_dy_milli);
    if step > request.max_step_milli || previous_step > request.max_step_milli {
        return false;
    }
    let dot = i64::from(request.move_dx_milli)
        .saturating_mul(i64::from(request.last_move_dx_milli))
        + i64::from(request.move_dy_milli).saturating_mul(i64::from(request.last_move_dy_milli));
    dot < 0
}

pub(crate) fn axis_slide_candidates(
    current: TacticalPoint,
    blocked_target: TacticalPoint,
) -> Option<[TacticalPoint; 2]> {
    let dx = blocked_target.x_milli - current.x_milli;
    let dy = blocked_target.y_milli - current.y_milli;
    if dx.abs() <= 1 || dy.abs() <= 1 {
        return None;
    }
    let x_only = TacticalPoint::new(blocked_target.x_milli, current.y_milli);
    let y_only = TacticalPoint::new(current.x_milli, blocked_target.y_milli);
    Some(if dx.abs() >= dy.abs() {
        [x_only, y_only]
    } else {
        [y_only, x_only]
    })
}

pub(crate) fn select_axis_slide_candidate<TPosition, FConvert, FClear>(
    current: TacticalPoint,
    blocked_target: TacticalPoint,
    mut from_tactical_point: FConvert,
    mut clear: FClear,
) -> Option<TPosition>
where
    TPosition: Copy,
    FConvert: FnMut(TacticalPoint) -> TPosition,
    FClear: FnMut(TPosition) -> bool,
{
    let candidates = axis_slide_candidates(current, blocked_target)?;
    for candidate in candidates {
        let candidate = from_tactical_point(candidate);
        if clear(candidate) {
            return Some(candidate);
        }
    }
    None
}

pub(crate) fn avoidance_candidates(
    current: TacticalPoint,
    target: TacticalPoint,
    max_step_milli: i32,
    min_step_milli: i32,
    max_step_cap_milli: i32,
) -> Option<[TacticalPoint; 5]> {
    let dx = target.x_milli - current.x_milli;
    let dy = target.y_milli - current.y_milli;
    let distance = distance_milli_components(dx, dy);
    if distance <= 1 {
        return None;
    }
    let step = avoidance_step_milli(max_step_milli, min_step_milli, max_step_cap_milli);
    let vector_candidate = |vx: i32, vy: i32| {
        let vector_distance = distance_milli_components(vx, vy).max(1);
        TacticalPoint::new(
            current
                .x_milli
                .saturating_add(scaled_axis_delta(vx, step, vector_distance)),
            current
                .y_milli
                .saturating_add(scaled_axis_delta(vy, step, vector_distance)),
        )
    };
    Some([
        vector_candidate(-dy, dx),
        vector_candidate(dy, -dx),
        vector_candidate(dx.saturating_sub(dy), dy.saturating_add(dx)),
        vector_candidate(dx.saturating_add(dy), dy.saturating_sub(dx)),
        vector_candidate(-dx, -dy),
    ])
}

pub(crate) fn select_avoidance_candidate<TPosition, FConvert, FClamp, FClear>(
    current: TacticalPoint,
    target: TacticalPoint,
    max_step_milli: i32,
    min_step_milli: i32,
    max_step_cap_milli: i32,
    mut from_tactical_point: FConvert,
    mut clamp: FClamp,
    mut clear: FClear,
) -> Option<TPosition>
where
    TPosition: Copy,
    FConvert: FnMut(TacticalPoint) -> TPosition,
    FClamp: FnMut(TPosition) -> TPosition,
    FClear: FnMut(TPosition) -> bool,
{
    let candidates = avoidance_candidates(
        current,
        target,
        max_step_milli,
        min_step_milli,
        max_step_cap_milli,
    )?;
    for candidate in candidates {
        let candidate = clamp(from_tactical_point(candidate));
        if clear(candidate) {
            return Some(candidate);
        }
    }
    None
}

pub(crate) fn unstuck_candidates(
    current: TacticalPoint,
    max_step_milli: i32,
    min_step_milli: i32,
    max_step_cap_milli: i32,
) -> [TacticalPoint; 8] {
    let step = avoidance_step_milli(max_step_milli, min_step_milli, max_step_cap_milli);
    [
        TacticalPoint::new(
            current
                .x_milli
                .saturating_add(scaled_unit_component(1_000, step)),
            current.y_milli,
        ),
        TacticalPoint::new(
            current
                .x_milli
                .saturating_add(scaled_unit_component(707, step)),
            current
                .y_milli
                .saturating_add(scaled_unit_component(707, step)),
        ),
        TacticalPoint::new(
            current.x_milli,
            current
                .y_milli
                .saturating_add(scaled_unit_component(1_000, step)),
        ),
        TacticalPoint::new(
            current
                .x_milli
                .saturating_add(scaled_unit_component(-707, step)),
            current
                .y_milli
                .saturating_add(scaled_unit_component(707, step)),
        ),
        TacticalPoint::new(
            current
                .x_milli
                .saturating_add(scaled_unit_component(-1_000, step)),
            current.y_milli,
        ),
        TacticalPoint::new(
            current
                .x_milli
                .saturating_add(scaled_unit_component(-707, step)),
            current
                .y_milli
                .saturating_add(scaled_unit_component(-707, step)),
        ),
        TacticalPoint::new(
            current.x_milli,
            current
                .y_milli
                .saturating_add(scaled_unit_component(-1_000, step)),
        ),
        TacticalPoint::new(
            current
                .x_milli
                .saturating_add(scaled_unit_component(707, step)),
            current
                .y_milli
                .saturating_add(scaled_unit_component(-707, step)),
        ),
    ]
}

pub(crate) fn select_unstuck_candidate<TPosition, TScore, FConvert, FClamp, FClear, FScore>(
    current: TacticalPoint,
    max_step_milli: i32,
    min_step_milli: i32,
    max_step_cap_milli: i32,
    mut from_tactical_point: FConvert,
    mut clamp: FClamp,
    mut clear: FClear,
    mut score: FScore,
) -> Option<TPosition>
where
    TPosition: Copy,
    TScore: Ord,
    FConvert: FnMut(TacticalPoint) -> TPosition,
    FClamp: FnMut(TPosition) -> TPosition,
    FClear: FnMut(TPosition) -> bool,
    FScore: FnMut(TPosition) -> TScore,
{
    unstuck_candidates(current, max_step_milli, min_step_milli, max_step_cap_milli)
        .into_iter()
        .map(|candidate| clamp(from_tactical_point(candidate)))
        .filter(|candidate| clear(*candidate))
        .min_by_key(|candidate| score(*candidate))
}

fn avoidance_step_milli(max_step_milli: i32, min_step_milli: i32, max_step_cap_milli: i32) -> i32 {
    max_step_milli.max(min_step_milli).min(max_step_cap_milli)
}

fn scaled_axis_delta(component: i32, amount: i32, distance: i32) -> i32 {
    if distance == 0 {
        return 0;
    }
    let value = i64::from(component) * i64::from(amount) / i64::from(distance);
    value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

fn scaled_unit_component(unit_milli: i32, distance_milli: i32) -> i32 {
    let value = i64::from(unit_milli).saturating_mul(i64::from(distance_milli)) / 1_000_i64;
    value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
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

    #[test]
    fn micro_reversal_blocks_short_immediate_opposing_step() {
        assert!(micro_reversal_blocked(MicroReversalRequest {
            tick: 100,
            last_move_tick: 90,
            last_move_dx_milli: 0,
            last_move_dy_milli: 120,
            move_dx_milli: 0,
            move_dy_milli: -120,
            window_ticks: 180,
            max_step_milli: 650,
        }));
    }

    #[test]
    fn micro_reversal_allows_same_direction_and_large_steps() {
        assert!(!micro_reversal_blocked(MicroReversalRequest {
            tick: 100,
            last_move_tick: 90,
            last_move_dx_milli: 0,
            last_move_dy_milli: 120,
            move_dx_milli: 0,
            move_dy_milli: 120,
            window_ticks: 180,
            max_step_milli: 650,
        }));
        assert!(!micro_reversal_blocked(MicroReversalRequest {
            tick: 100,
            last_move_tick: 90,
            last_move_dx_milli: 0,
            last_move_dy_milli: 900,
            move_dx_milli: 0,
            move_dy_milli: -900,
            window_ticks: 180,
            max_step_milli: 650,
        }));
    }

    #[test]
    fn axis_slide_candidates_prefer_dominant_axis_first() {
        let current = TacticalPoint::new(10_000, 10_000);
        assert_eq!(
            axis_slide_candidates(current, TacticalPoint::new(13_000, 11_000)),
            Some([
                TacticalPoint::new(13_000, 10_000),
                TacticalPoint::new(10_000, 11_000),
            ])
        );
        assert_eq!(
            axis_slide_candidates(current, TacticalPoint::new(11_000, 13_000)),
            Some([
                TacticalPoint::new(10_000, 13_000),
                TacticalPoint::new(11_000, 10_000),
            ])
        );
    }

    #[test]
    fn axis_slide_candidates_reject_axis_locked_target() {
        assert_eq!(
            axis_slide_candidates(
                TacticalPoint::new(10_000, 10_000),
                TacticalPoint::new(10_001, 13_000)
            ),
            None
        );
    }

    #[test]
    fn select_axis_slide_candidate_returns_first_clear_candidate() {
        let current = TacticalPoint::new(10_000, 10_000);
        let blocked_target = TacticalPoint::new(13_000, 11_000);
        let mut checked = Vec::new();

        let selected = select_axis_slide_candidate(
            current,
            blocked_target,
            |point| point,
            |candidate| {
                checked.push(candidate);
                candidate == TacticalPoint::new(10_000, 11_000)
            },
        );

        assert_eq!(selected, Some(TacticalPoint::new(10_000, 11_000)));
        assert_eq!(
            checked,
            vec![
                TacticalPoint::new(13_000, 10_000),
                TacticalPoint::new(10_000, 11_000),
            ]
        );
    }

    #[test]
    fn select_axis_slide_candidate_rejects_when_none_clear() {
        let current = TacticalPoint::new(10_000, 10_000);
        let blocked_target = TacticalPoint::new(13_000, 11_000);
        let mut checked = 0;

        let selected = select_axis_slide_candidate(
            current,
            blocked_target,
            |point| point,
            |_candidate| {
                checked += 1;
                false
            },
        );

        assert_eq!(selected, None);
        assert_eq!(checked, 2);

        let selected = select_axis_slide_candidate(
            current,
            TacticalPoint::new(10_001, 13_000),
            |point| point,
            |_candidate| panic!("axis-locked targets should not be probed"),
        );
        assert_eq!(selected, None);
    }

    #[test]
    fn avoidance_candidates_match_lateral_and_reverse_order() {
        let candidates = avoidance_candidates(
            TacticalPoint::new(10_000, 10_000),
            TacticalPoint::new(14_000, 10_000),
            600,
            250,
            1_000,
        )
        .expect("nonzero target vector should emit candidates");

        assert_eq!(
            candidates,
            [
                TacticalPoint::new(10_000, 10_600),
                TacticalPoint::new(10_000, 9_400),
                TacticalPoint::new(10_424, 10_424),
                TacticalPoint::new(10_424, 9_576),
                TacticalPoint::new(9_400, 10_000),
            ]
        );
    }

    #[test]
    fn select_avoidance_candidate_returns_first_clear_candidate() {
        let current = TacticalPoint::new(10_000, 10_000);
        let target = TacticalPoint::new(14_000, 10_000);
        let mut checked = Vec::new();

        let selected = select_avoidance_candidate(
            current,
            target,
            600,
            250,
            1_000,
            |point| point,
            |point| point,
            |candidate| {
                checked.push(candidate);
                candidate == TacticalPoint::new(10_000, 9_400)
            },
        );

        assert_eq!(selected, Some(TacticalPoint::new(10_000, 9_400)));
        assert_eq!(
            checked,
            vec![
                TacticalPoint::new(10_000, 10_600),
                TacticalPoint::new(10_000, 9_400),
            ]
        );
    }

    #[test]
    fn select_avoidance_candidate_rejects_when_none_clear() {
        let current = TacticalPoint::new(10_000, 10_000);
        let target = TacticalPoint::new(14_000, 10_000);

        let selected = select_avoidance_candidate(
            current,
            target,
            600,
            250,
            1_000,
            |point| point,
            |point| point,
            |_candidate| false,
        );

        assert_eq!(selected, None);
        assert_eq!(
            select_avoidance_candidate(
                current,
                current,
                600,
                250,
                1_000,
                |point| point,
                |point| point,
                |_candidate| panic!("zero vector should not be probed")
            ),
            None
        );
    }

    #[test]
    fn unstuck_candidates_emit_compass_ring() {
        let candidates = unstuck_candidates(TacticalPoint::new(10_000, 10_000), 600, 250, 1_000);

        assert_eq!(candidates[0], TacticalPoint::new(10_600, 10_000));
        assert_eq!(candidates[2], TacticalPoint::new(10_000, 10_600));
        assert_eq!(candidates[4], TacticalPoint::new(9_400, 10_000));
        assert_eq!(candidates[6], TacticalPoint::new(10_000, 9_400));
    }

    #[test]
    fn select_unstuck_candidate_filters_then_uses_lowest_score() {
        let current = TacticalPoint::new(10_000, 10_000);

        let selected = select_unstuck_candidate(
            current,
            600,
            250,
            1_000,
            |point| point,
            |point| point,
            |candidate| candidate.x_milli >= 10_000,
            |candidate| (candidate.y_milli.abs_diff(9_400), candidate.x_milli),
        );

        assert_eq!(selected, Some(TacticalPoint::new(10_000, 9_400)));
    }

    #[test]
    fn select_unstuck_candidate_rejects_when_none_clear() {
        let selected = select_unstuck_candidate(
            TacticalPoint::new(10_000, 10_000),
            600,
            250,
            1_000,
            |point| point,
            |point| point,
            |_candidate| false,
            |_candidate| 0_i32,
        );

        assert_eq!(selected, None);
    }
}
