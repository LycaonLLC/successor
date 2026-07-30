use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct NavCell {
    pub(crate) x: i32,
    pub(crate) y: i32,
}

impl NavCell {
    pub(crate) const fn new(x: i32, y: i32) -> Self {
        Self { x, y }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct NavPosition {
    pub(crate) x_milli: i32,
    pub(crate) y_milli: i32,
}

impl NavPosition {
    pub(crate) const fn new(x_milli: i32, y_milli: i32) -> Self {
        Self { x_milli, y_milli }
    }
}

pub(crate) struct NavPathRequest<'a> {
    pub(crate) start: NavCell,
    pub(crate) goal: NavCell,
    pub(crate) max_expansions: usize,
    pub(crate) contains: &'a dyn Fn(NavCell) -> bool,
    pub(crate) blocked: &'a dyn Fn(NavCell) -> bool,
    pub(crate) transition_clear: &'a dyn Fn(NavCell, NavCell) -> bool,
}

pub(crate) struct NavPathResult {
    pub(crate) path: Option<Vec<NavCell>>,
    pub(crate) expansions: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NavMovePrecheck {
    Allowed,
    Rejected(NavMoveRejection),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NavMoveRejection {
    NonPositiveStep,
    Arrived,
    TacticalDeadband,
    AxisLockedMicroCorrection,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct NavMovePrecheckRequest {
    pub(crate) dx_milli: i32,
    pub(crate) dy_milli: i32,
    pub(crate) distance_milli: i32,
    pub(crate) max_step_milli: i32,
    pub(crate) tactical_deadband_actor: bool,
    pub(crate) min_tactical_reposition_milli: i32,
    pub(crate) micro_correction_deadband_milli: i32,
    pub(crate) micro_correction_axis_lock_milli: i32,
}

pub(crate) fn nav_move_precheck(request: NavMovePrecheckRequest) -> NavMovePrecheck {
    if request.max_step_milli <= 0 {
        return NavMovePrecheck::Rejected(NavMoveRejection::NonPositiveStep);
    }
    if request.distance_milli <= 1 {
        return NavMovePrecheck::Rejected(NavMoveRejection::Arrived);
    }
    if request.tactical_deadband_actor
        && request.distance_milli <= request.min_tactical_reposition_milli
    {
        return NavMovePrecheck::Rejected(NavMoveRejection::TacticalDeadband);
    }
    if request.tactical_deadband_actor
        && request.distance_milli <= request.micro_correction_deadband_milli
        && (request.dx_milli.abs() <= request.micro_correction_axis_lock_milli
            || request.dy_milli.abs() <= request.micro_correction_axis_lock_milli)
    {
        return NavMovePrecheck::Rejected(NavMoveRejection::AxisLockedMicroCorrection);
    }
    NavMovePrecheck::Allowed
}

pub(crate) const fn tactical_path_reversal_allowed(
    allow_reversal: bool,
    distance_milli: i32,
    cover_reached_milli: i32,
) -> bool {
    allow_reversal && distance_milli > cover_reached_milli * 4
}

pub(crate) fn nav_next_position_from_path<TCell, TPosition, FPositionFromCell>(
    current_cell: TCell,
    target_cell: TCell,
    target_position: TPosition,
    path: &[TCell],
    mut position_from_cell: FPositionFromCell,
) -> Option<TPosition>
where
    TCell: Copy + Eq,
    TPosition: Copy,
    FPositionFromCell: FnMut(TCell) -> TPosition,
{
    if current_cell == target_cell {
        return Some(target_position);
    }
    let next_cell = *path.get(1)?;
    if next_cell == target_cell {
        Some(target_position)
    } else {
        Some(position_from_cell(next_cell))
    }
}

pub(crate) fn direct_step_toward(
    current: NavPosition,
    target: NavPosition,
    max_step_milli: i32,
) -> Option<NavPosition> {
    if max_step_milli <= 0 {
        return None;
    }
    let dx = target.x_milli - current.x_milli;
    let dy = target.y_milli - current.y_milli;
    let distance = distance_milli_components(dx, dy);
    if distance <= 1 {
        return None;
    }
    let amount = max_step_milli.min(distance);
    Some(NavPosition::new(
        current
            .x_milli
            .saturating_add(scaled_axis_delta(dx, amount, distance)),
        current
            .y_milli
            .saturating_add(scaled_axis_delta(dy, amount, distance)),
    ))
}

pub(crate) fn corridor_sample_points(
    start: NavPosition,
    end: NavPosition,
    step_milli: i32,
    max_samples: i32,
) -> Vec<NavPosition> {
    let distance = position_distance_milli(start, end);
    if distance <= 1 {
        return Vec::new();
    }
    let step_milli = step_milli.max(1);
    let steps = div_ceil_i32(distance, step_milli).clamp(1, max_samples.max(1));
    let mut samples = Vec::with_capacity(usize::try_from(steps).unwrap_or(1));
    for step in 1..=steps {
        if step == steps {
            samples.push(end);
            continue;
        }
        let amount = step.saturating_mul(step_milli);
        samples.push(NavPosition::new(
            start.x_milli + scaled_axis_delta(end.x_milli - start.x_milli, amount, distance),
            start.y_milli + scaled_axis_delta(end.y_milli - start.y_milli, amount, distance),
        ));
    }
    samples
}

pub(crate) fn corridor_clear<FBlocked>(
    start: NavPosition,
    end: NavPosition,
    step_milli: i32,
    max_samples: i32,
    mut blocked: FBlocked,
) -> bool
where
    FBlocked: FnMut(NavPosition, bool) -> bool,
{
    let samples = corridor_sample_points(start, end, step_milli, max_samples);
    if samples.is_empty() {
        return true;
    }
    let terminal_index = samples.len().saturating_sub(1);
    for (index, sample) in samples.into_iter().enumerate() {
        let is_terminal = index == terminal_index;
        let sample = if is_terminal { end } else { sample };
        if blocked(sample, is_terminal) {
            return false;
        }
    }
    true
}

pub(crate) fn find_cell_path(request: NavPathRequest<'_>) -> NavPathResult {
    if !(request.contains)(request.start)
        || !(request.contains)(request.goal)
        || (request.blocked)(request.goal)
    {
        return NavPathResult {
            path: None,
            expansions: 0,
        };
    }
    if request.start == request.goal {
        return NavPathResult {
            path: Some(vec![request.start]),
            expansions: 0,
        };
    }

    let mut open = vec![request.start];
    let mut closed = BTreeSet::new();
    let mut came_from = BTreeMap::<NavCell, NavCell>::new();
    let mut g_score = BTreeMap::<NavCell, i32>::from([(request.start, 0)]);
    let mut expansions = 0_usize;

    while !open.is_empty() && expansions < request.max_expansions {
        let mut best_index = 0_usize;
        let mut best_key = path_sort_key(open[0], request.goal, &g_score);
        for (index, cell) in open.iter().enumerate().skip(1) {
            let key = path_sort_key(*cell, request.goal, &g_score);
            if key < best_key {
                best_index = index;
                best_key = key;
            }
        }

        let current = open.swap_remove(best_index);
        if current == request.goal {
            return NavPathResult {
                path: Some(reconstruct_path(came_from, current)),
                expansions,
            };
        }
        if !closed.insert(current) {
            continue;
        }
        expansions = expansions.saturating_add(1);

        for neighbor in path_neighbors(current) {
            if closed.contains(&neighbor)
                || !(request.contains)(neighbor)
                || (request.blocked)(neighbor)
                || !(request.transition_clear)(current, neighbor)
            {
                continue;
            }
            let tentative = g_score
                .get(&current)
                .copied()
                .unwrap_or(i32::MAX / 4)
                .saturating_add(1);
            if tentative >= g_score.get(&neighbor).copied().unwrap_or(i32::MAX / 4) {
                continue;
            }
            came_from.insert(neighbor, current);
            g_score.insert(neighbor, tentative);
            if !open.contains(&neighbor) {
                open.push(neighbor);
            }
        }
    }

    NavPathResult {
        path: None,
        expansions,
    }
}

fn path_sort_key(
    cell: NavCell,
    goal: NavCell,
    g_score: &BTreeMap<NavCell, i32>,
) -> (i32, i32, i32, i32) {
    let g = g_score.get(&cell).copied().unwrap_or(i32::MAX / 4);
    let h = (goal.x - cell.x)
        .abs()
        .saturating_add((goal.y - cell.y).abs());
    (g.saturating_add(h), h, cell.y, cell.x)
}

fn reconstruct_path(came_from: BTreeMap<NavCell, NavCell>, mut current: NavCell) -> Vec<NavCell> {
    let mut path = vec![current];
    while let Some(previous) = came_from.get(&current).copied() {
        current = previous;
        path.push(current);
    }
    path.reverse();
    path
}

fn path_neighbors(cell: NavCell) -> [NavCell; 4] {
    [
        NavCell::new(cell.x.saturating_add(1), cell.y),
        NavCell::new(cell.x.saturating_sub(1), cell.y),
        NavCell::new(cell.x, cell.y.saturating_add(1)),
        NavCell::new(cell.x, cell.y.saturating_sub(1)),
    ]
}

fn scaled_axis_delta(component: i32, amount: i32, distance: i32) -> i32 {
    if distance == 0 {
        return 0;
    }
    let value = i64::from(component) * i64::from(amount) / i64::from(distance);
    value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

fn distance_milli_components(dx: i32, dy: i32) -> i32 {
    f64::from(dx)
        .hypot(f64::from(dy))
        .round()
        .clamp(0.0, f64::from(i32::MAX)) as i32
}

fn position_distance_milli(left: NavPosition, right: NavPosition) -> i32 {
    distance_milli_components(left.x_milli - right.x_milli, left.y_milli - right.y_milli)
}

fn div_ceil_i32(value: i32, divisor: i32) -> i32 {
    if divisor <= 0 {
        return 0;
    }
    value.saturating_add(divisor - 1) / divisor
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nav_move_precheck_rejects_arrived_and_nonpositive_steps() {
        assert_eq!(
            nav_move_precheck(NavMovePrecheckRequest {
                dx_milli: 100,
                dy_milli: 0,
                distance_milli: 100,
                max_step_milli: 0,
                tactical_deadband_actor: false,
                min_tactical_reposition_milli: 650,
                micro_correction_deadband_milli: 450,
                micro_correction_axis_lock_milli: 150,
            }),
            NavMovePrecheck::Rejected(NavMoveRejection::NonPositiveStep)
        );
        assert_eq!(
            nav_move_precheck(NavMovePrecheckRequest {
                dx_milli: 0,
                dy_milli: 0,
                distance_milli: 1,
                max_step_milli: 650,
                tactical_deadband_actor: false,
                min_tactical_reposition_milli: 650,
                micro_correction_deadband_milli: 450,
                micro_correction_axis_lock_milli: 150,
            }),
            NavMovePrecheck::Rejected(NavMoveRejection::Arrived)
        );
    }

    #[test]
    fn nav_move_precheck_applies_tactical_deadband_only_to_tactical_actors() {
        let request = NavMovePrecheckRequest {
            dx_milli: 500,
            dy_milli: 500,
            distance_milli: 700,
            max_step_milli: 650,
            tactical_deadband_actor: true,
            min_tactical_reposition_milli: 800,
            micro_correction_deadband_milli: 450,
            micro_correction_axis_lock_milli: 150,
        };

        assert_eq!(
            nav_move_precheck(request),
            NavMovePrecheck::Rejected(NavMoveRejection::TacticalDeadband)
        );
        assert_eq!(
            nav_move_precheck(NavMovePrecheckRequest {
                tactical_deadband_actor: false,
                ..request
            }),
            NavMovePrecheck::Allowed
        );
    }

    #[test]
    fn nav_move_precheck_rejects_axis_locked_micro_corrections() {
        assert_eq!(
            nav_move_precheck(NavMovePrecheckRequest {
                dx_milli: 50,
                dy_milli: 320,
                distance_milli: 400,
                max_step_milli: 650,
                tactical_deadband_actor: true,
                min_tactical_reposition_milli: 300,
                micro_correction_deadband_milli: 450,
                micro_correction_axis_lock_milli: 150,
            }),
            NavMovePrecheck::Rejected(NavMoveRejection::AxisLockedMicroCorrection)
        );
    }

    #[test]
    fn tactical_path_reversal_requires_flag_past_local_cover_band() {
        assert!(tactical_path_reversal_allowed(true, 4_001, 1_000));
        assert!(!tactical_path_reversal_allowed(true, 4_000, 1_000));
        assert!(!tactical_path_reversal_allowed(true, 2_001, 1_000));
        assert!(!tactical_path_reversal_allowed(false, 5_000, 1_000));
    }

    #[test]
    fn nav_next_position_returns_exact_target_for_same_or_terminal_cell() {
        assert_eq!(
            nav_next_position_from_path(3, 3, "target", &[], |_| "cell"),
            Some("target")
        );
        assert_eq!(
            nav_next_position_from_path(1, 3, "target", &[1, 3], |_| "cell"),
            Some("target")
        );
    }

    #[test]
    fn nav_next_position_uses_next_cell_when_path_has_intermediate_step() {
        assert_eq!(
            nav_next_position_from_path(1, 4, "target", &[1, 2, 3, 4], |cell| {
                match cell {
                    2 => "two",
                    _ => "other",
                }
            }),
            Some("two")
        );
    }

    #[test]
    fn nav_next_position_rejects_missing_path_step() {
        assert_eq!(
            nav_next_position_from_path(1, 4, "target", &[1], |_| "cell"),
            None
        );
    }

    #[test]
    fn direct_step_toward_moves_by_max_step_on_vector() {
        assert_eq!(
            direct_step_toward(
                NavPosition::new(10_000, 10_000),
                NavPosition::new(14_000, 10_000),
                650
            ),
            Some(NavPosition::new(10_650, 10_000))
        );
        assert_eq!(
            direct_step_toward(
                NavPosition::new(10_000, 10_000),
                NavPosition::new(10_300, 10_400),
                650
            ),
            Some(NavPosition::new(10_300, 10_400))
        );
    }

    #[test]
    fn direct_step_toward_rejects_zero_or_arrived_steps() {
        assert_eq!(
            direct_step_toward(
                NavPosition::new(10_000, 10_000),
                NavPosition::new(10_000, 10_000),
                650
            ),
            None
        );
        assert_eq!(
            direct_step_toward(
                NavPosition::new(10_000, 10_000),
                NavPosition::new(11_000, 10_000),
                0
            ),
            None
        );
    }

    #[test]
    fn corridor_sample_points_end_at_exact_target() {
        assert_eq!(
            corridor_sample_points(
                NavPosition::new(0, 0),
                NavPosition::new(2_500, 0),
                1_000,
                256
            ),
            vec![
                NavPosition::new(1_000, 0),
                NavPosition::new(2_000, 0),
                NavPosition::new(2_500, 0),
            ]
        );
    }

    #[test]
    fn corridor_sample_points_cap_samples_but_preserve_terminal_point() {
        assert_eq!(
            corridor_sample_points(NavPosition::new(0, 0), NavPosition::new(5_000, 0), 1_000, 2),
            vec![NavPosition::new(1_000, 0), NavPosition::new(5_000, 0)]
        );
    }

    #[test]
    fn corridor_clear_checks_each_sample_and_exact_terminal() {
        let mut visited = Vec::new();
        assert!(corridor_clear(
            NavPosition::new(0, 0),
            NavPosition::new(2_500, 0),
            1_000,
            256,
            |sample, is_terminal| {
                visited.push((sample, is_terminal));
                false
            },
        ));
        assert_eq!(
            visited,
            vec![
                (NavPosition::new(1_000, 0), false),
                (NavPosition::new(2_000, 0), false),
                (NavPosition::new(2_500, 0), true),
            ]
        );
    }

    #[test]
    fn corridor_clear_rejects_first_blocked_sample() {
        assert!(!corridor_clear(
            NavPosition::new(0, 0),
            NavPosition::new(3_000, 0),
            1_000,
            256,
            |sample, _is_terminal| sample == NavPosition::new(2_000, 0),
        ));
    }
}
