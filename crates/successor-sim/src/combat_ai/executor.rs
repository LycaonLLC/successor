use super::{
    affordance::{PrimitiveCell, PrimitiveMap},
    behavior::{PrimitiveBehaviorAssignment, PrimitiveBehaviorDecision},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PrimitiveExecution {
    pub(crate) reason: &'static str,
    pub(crate) target: PrimitiveCell,
    pub(crate) path: Vec<PrimitiveCell>,
    pub(crate) reachable: bool,
    pub(crate) tactical: bool,
    pub(crate) path_len: u32,
}

pub(crate) fn execute_decision(
    map: &PrimitiveMap,
    actor: PrimitiveCell,
    decision: PrimitiveBehaviorDecision,
) -> PrimitiveExecution {
    let path = map.path(actor, decision.target).unwrap_or_default();
    PrimitiveExecution {
        reason: decision.reason,
        target: decision.target,
        reachable: !path.is_empty(),
        tactical: decision.tactical,
        path_len: path.len().try_into().unwrap_or(u32::MAX),
        path,
    }
}

pub(crate) fn execute_assignment(
    map: &PrimitiveMap,
    assignment: PrimitiveBehaviorAssignment,
) -> PrimitiveExecution {
    execute_decision(map, assignment.actor, assignment.decision)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalExecutionCandidate<'a, TPosition> {
    pub(crate) index: usize,
    pub(crate) score: i64,
    pub(crate) tie_breaker: i32,
    pub(crate) position: TPosition,
    pub(crate) kind: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalExecutionChoice<TPosition> {
    pub(crate) index: usize,
    pub(crate) position: TPosition,
    pub(crate) reason: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TacticalExecutionSelection<TPosition> {
    pub(crate) choice: Option<TacticalExecutionChoice<TPosition>>,
    pub(crate) rejected_indices: Vec<usize>,
}

pub(crate) fn select_reachable_tactical_candidate<TPosition, FReachable>(
    mut candidates: Vec<TacticalExecutionCandidate<'_, TPosition>>,
    probe_limit: usize,
    mut reachable: FReachable,
) -> TacticalExecutionSelection<TPosition>
where
    TPosition: Copy,
    FReachable: FnMut(TPosition) -> bool,
{
    candidates.sort_by(|left, right| {
        (right.score, right.tie_breaker).cmp(&(left.score, left.tie_breaker))
    });

    let mut rejected_indices = Vec::new();
    for candidate in candidates.into_iter().take(probe_limit) {
        if reachable(candidate.position) {
            return TacticalExecutionSelection {
                choice: Some(TacticalExecutionChoice {
                    index: candidate.index,
                    position: candidate.position,
                    reason: tactical_reason_from_candidate_kind(candidate.kind),
                }),
                rejected_indices,
            };
        }
        rejected_indices.push(candidate.index);
    }

    TacticalExecutionSelection {
        choice: None,
        rejected_indices,
    }
}

pub(crate) fn tactical_candidate_reachable<
    TPosition,
    FDirectCorridorClear,
    FSameCell,
    FPathExists,
>(
    actor_position: TPosition,
    candidate_position: TPosition,
    mut direct_corridor_clear: FDirectCorridorClear,
    mut same_cell: FSameCell,
    mut path_exists: FPathExists,
) -> bool
where
    TPosition: Copy,
    FDirectCorridorClear: FnMut(TPosition, TPosition) -> bool,
    FSameCell: FnMut(TPosition) -> bool,
    FPathExists: FnMut(TPosition) -> bool,
{
    if direct_corridor_clear(actor_position, candidate_position) {
        return true;
    }
    if same_cell(candidate_position) {
        return false;
    }
    path_exists(candidate_position)
}

pub(crate) fn tactical_blocked_target_until_tick(tick: u64, memory_ticks: u64) -> u64 {
    tick.saturating_add(memory_ticks)
}

pub(crate) fn tactical_position_near<TPosition, FDistance>(
    left: TPosition,
    right: TPosition,
    radius_milli: i32,
    mut distance_milli: FDistance,
) -> bool
where
    TPosition: Copy,
    FDistance: FnMut(TPosition, TPosition) -> i32,
{
    distance_milli(left, right) <= radius_milli
}

pub(crate) fn tactical_blocked_target_near<TPosition, FDistance>(
    blocked_target: Option<TPosition>,
    target: TPosition,
    radius_milli: i32,
    mut distance_milli: FDistance,
) -> bool
where
    TPosition: Copy,
    FDistance: FnMut(TPosition, TPosition) -> i32,
{
    blocked_target.is_some_and(|blocked| {
        tactical_position_near(blocked, target, radius_milli, &mut distance_milli)
    })
}

pub(crate) fn tactical_target_recently_blocked<TPosition, FDistance>(
    blocked_target: Option<TPosition>,
    blocked_until_tick: u64,
    tick: u64,
    target: TPosition,
    radius_milli: i32,
    distance_milli: FDistance,
) -> bool
where
    TPosition: Copy,
    FDistance: FnMut(TPosition, TPosition) -> i32,
{
    tick <= blocked_until_tick
        && tactical_blocked_target_near(blocked_target, target, radius_milli, distance_milli)
}

pub(crate) fn note_skirmisher_blocked_target<TPosition: Copy>(
    ai: &mut SkirmisherAiState<TPosition>,
    tick: u64,
    target: TPosition,
    memory_ticks: u64,
) {
    ai.blocked_target = Some(target);
    ai.blocked_target_until_tick = tactical_blocked_target_until_tick(tick, memory_ticks);
}

pub(crate) fn record_skirmisher_move<TPosition>(
    ai: &mut SkirmisherAiState<TPosition>,
    tick: u64,
    move_dx_milli: i32,
    move_dy_milli: i32,
) {
    ai.last_move_dx_milli = move_dx_milli;
    ai.last_move_dy_milli = move_dy_milli;
    ai.last_move_tick = tick;
}

pub(crate) fn reset_skirmisher_destination_progress<TPosition>(
    ai: &mut SkirmisherAiState<TPosition>,
) {
    ai.progress_target = None;
    ai.progress_best_distance_milli = i32::MAX;
    ai.progress_last_improved_tick = 0;
}

pub(crate) fn preserve_skirmisher_move_memory<TPosition: Copy>(
    next: &mut SkirmisherAiState<TPosition>,
    live: &SkirmisherAiState<TPosition>,
) {
    if live.last_move_tick > next.last_move_tick {
        next.last_move_dx_milli = live.last_move_dx_milli;
        next.last_move_dy_milli = live.last_move_dy_milli;
        next.last_move_tick = live.last_move_tick;
    }
    if live.progress_last_improved_tick > next.progress_last_improved_tick {
        next.progress_target = live.progress_target;
        next.progress_best_distance_milli = live.progress_best_distance_milli;
        next.progress_last_improved_tick = live.progress_last_improved_tick;
    }
}

pub(crate) fn skirmisher_has_tactical_contact<TPosition>(
    ai: Option<&SkirmisherAiState<TPosition>>,
) -> bool {
    ai.is_some_and(|ai| ai.target_actor_id.is_some() || ai.target.is_some() || ai.cover.is_some())
}

pub(crate) fn clear_skirmisher_blocked_target_near<TPosition, FDistance>(
    ai: &mut SkirmisherAiState<TPosition>,
    target: TPosition,
    radius_milli: i32,
    distance_milli: FDistance,
) where
    TPosition: Copy,
    FDistance: FnMut(TPosition, TPosition) -> i32,
{
    if tactical_blocked_target_near(ai.blocked_target, target, radius_milli, distance_milli) {
        ai.blocked_target = None;
        ai.blocked_target_until_tick = 0;
    }
}

pub(crate) fn skirmisher_target_recently_blocked<TPosition, FDistance>(
    ai: Option<&SkirmisherAiState<TPosition>>,
    tick: u64,
    target: TPosition,
    radius_milli: i32,
    distance_milli: FDistance,
) -> bool
where
    TPosition: Copy,
    FDistance: FnMut(TPosition, TPosition) -> i32,
{
    ai.is_some_and(|ai| {
        tactical_target_recently_blocked(
            ai.blocked_target,
            ai.blocked_target_until_tick,
            tick,
            target,
            radius_milli,
            distance_milli,
        )
    })
}

pub(crate) fn tactical_reason_from_candidate_kind(kind: &str) -> &'static str {
    match kind {
        "high_cover" => "high_cover",
        "soft_cover" => "soft_cover",
        "firing_lane" => "firing_lane",
        "peek_lane" => "peek_lane",
        "local_peek_lane" => "local_peek_lane",
        "advance_line" => "advance_line",
        "evasion" => "evasion",
        "flank" => "flank",
        "home" => "home",
        "retreat" => "retreat",
        _ => "open_cell",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) enum SkirmisherMode {
    Engage,
    SeekCover,
    HoldCover,
}

impl SkirmisherMode {
    pub(crate) const fn label(self) -> &'static str {
        match self {
            Self::Engage => "engage",
            Self::SeekCover => "seek_cover",
            Self::HoldCover => "hold_cover",
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) enum NpcAiAttitude {
    Passive,
    Alerted,
    Hostile,
}

impl NpcAiAttitude {
    pub(crate) const fn label(self) -> &'static str {
        match self {
            Self::Passive => "passive",
            Self::Alerted => "alerted",
            Self::Hostile => "hostile",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(crate) struct SkirmisherAiState<TPosition> {
    pub(crate) mode: SkirmisherMode,
    pub(crate) target_actor_id: Option<String>,
    pub(crate) target: Option<TPosition>,
    pub(crate) cover: Option<TPosition>,
    pub(crate) next_decision_tick: u64,
    pub(crate) next_shot_tick: u64,
    pub(crate) burst_shots_remaining: u8,
    pub(crate) attitude: NpcAiAttitude,
    pub(crate) alert_until_tick: u64,
    pub(crate) next_update_tick: u64,
    pub(crate) last_update_tick: u64,
    pub(crate) last_move_dx_milli: i32,
    pub(crate) last_move_dy_milli: i32,
    pub(crate) last_move_tick: u64,
    pub(crate) progress_target: Option<TPosition>,
    pub(crate) progress_best_distance_milli: i32,
    pub(crate) progress_last_improved_tick: u64,
    pub(crate) blocked_target: Option<TPosition>,
    pub(crate) blocked_target_until_tick: u64,
    pub(crate) seed: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TacticalPressureReplanRequest {
    pub(crate) tick: u64,
    pub(crate) next_decision_tick: u64,
    pub(crate) distance_to_target_milli: Option<i32>,
    pub(crate) last_move_tick: u64,
    pub(crate) committed_move_reached_milli: i32,
    pub(crate) pressure_replan_grace_ticks: u64,
    pub(crate) incoming_fire: bool,
    pub(crate) hard_suppressed: bool,
    pub(crate) outgunned: bool,
    pub(crate) forced_withdrawal: bool,
}

pub(crate) fn tactical_pressure_replan_due(request: TacticalPressureReplanRequest) -> bool {
    if request.tick >= request.next_decision_tick {
        return true;
    }
    if !(request.incoming_fire
        || request.hard_suppressed
        || request.outgunned
        || request.forced_withdrawal)
    {
        return false;
    }
    let committed_move_in_progress = request.distance_to_target_milli.is_some_and(|distance| {
        distance > request.committed_move_reached_milli
            && request.last_move_tick > 0
            && request.tick.saturating_sub(request.last_move_tick)
                <= request.pressure_replan_grace_ticks
    });
    !committed_move_in_progress
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_skirmisher_state() -> SkirmisherAiState<i32> {
        SkirmisherAiState {
            mode: SkirmisherMode::Engage,
            target_actor_id: None,
            target: None,
            cover: None,
            next_decision_tick: 0,
            next_shot_tick: 0,
            burst_shots_remaining: 0,
            attitude: NpcAiAttitude::Hostile,
            alert_until_tick: 0,
            next_update_tick: 0,
            last_update_tick: 0,
            last_move_dx_milli: 0,
            last_move_dy_milli: 0,
            last_move_tick: 0,
            progress_target: None,
            progress_best_distance_milli: i32::MAX,
            progress_last_improved_tick: 0,
            blocked_target: None,
            blocked_target_until_tick: 0,
            seed: 0,
        }
    }

    #[test]
    fn tactical_execution_selects_highest_reachable_candidate() {
        let candidates = vec![
            TacticalExecutionCandidate {
                index: 0,
                score: 5,
                tie_breaker: 0,
                position: 10,
                kind: "firing_lane",
            },
            TacticalExecutionCandidate {
                index: 1,
                score: 10,
                tie_breaker: 0,
                position: 20,
                kind: "high_cover",
            },
            TacticalExecutionCandidate {
                index: 2,
                score: 9,
                tie_breaker: 0,
                position: 30,
                kind: "evasion",
            },
        ];

        let selected =
            select_reachable_tactical_candidate(candidates, 8, |position| position != 20);

        assert_eq!(
            selected.choice,
            Some(TacticalExecutionChoice {
                index: 2,
                position: 30,
                reason: "evasion",
            })
        );
        assert_eq!(selected.rejected_indices, vec![1]);
    }

    #[test]
    fn tactical_execution_respects_probe_limit() {
        let candidates = vec![
            TacticalExecutionCandidate {
                index: 0,
                score: 10,
                tie_breaker: 0,
                position: 10,
                kind: "high_cover",
            },
            TacticalExecutionCandidate {
                index: 1,
                score: 9,
                tie_breaker: 0,
                position: 20,
                kind: "firing_lane",
            },
        ];

        let selected =
            select_reachable_tactical_candidate(candidates, 1, |position| position == 20);

        assert_eq!(selected.choice, None);
        assert_eq!(selected.rejected_indices, vec![0]);
    }

    #[test]
    fn tactical_candidate_reachability_prefers_direct_corridor() {
        let reachable = tactical_candidate_reachable(1, 2, |_from, _to| true, |_| true, |_| false);

        assert!(reachable);
    }

    #[test]
    fn tactical_candidate_reachability_rejects_same_cell_without_corridor() {
        let reachable = tactical_candidate_reachable(1, 2, |_from, _to| false, |_| true, |_| true);

        assert!(!reachable);
    }

    #[test]
    fn tactical_candidate_reachability_falls_back_to_path_probe() {
        let reachable =
            tactical_candidate_reachable(1, 2, |_from, _to| false, |_| false, |to| to == 2);

        assert!(reachable);
    }

    #[test]
    fn tactical_blocked_target_memory_saturates_until_tick() {
        assert_eq!(tactical_blocked_target_until_tick(10, 5), 15);
        assert_eq!(
            tactical_blocked_target_until_tick(u64::MAX - 1, 5),
            u64::MAX
        );
    }

    #[test]
    fn skirmisher_destination_progress_reset_clears_tracking() {
        let mut state = test_skirmisher_state();
        state.progress_target = Some(200);
        state.progress_best_distance_milli = 7_000;
        state.progress_last_improved_tick = 102;

        reset_skirmisher_destination_progress(&mut state);
        assert_eq!(state.progress_target, None);
        assert_eq!(state.progress_best_distance_milli, i32::MAX);
        assert_eq!(state.progress_last_improved_tick, 0);
    }

    #[test]
    fn tactical_blocked_target_near_uses_distance_radius() {
        let near =
            tactical_blocked_target_near(Some(10), 14, 4, |left, right| i32::abs(left - right));
        let far =
            tactical_blocked_target_near(Some(10), 15, 4, |left, right| i32::abs(left - right));

        assert!(near);
        assert!(!far);
    }

    #[test]
    fn tactical_recently_blocked_requires_live_memory_and_radius() {
        assert!(tactical_target_recently_blocked(
            Some(10),
            20,
            20,
            12,
            2,
            |left, right| i32::abs(left - right),
        ));
        assert!(!tactical_target_recently_blocked(
            Some(10),
            20,
            21,
            12,
            2,
            |left, right| i32::abs(left - right),
        ));
        assert!(!tactical_target_recently_blocked(
            None,
            20,
            20,
            12,
            2,
            |left, right| i32::abs(left - right),
        ));
    }

    #[test]
    fn skirmisher_blocked_target_memory_mutates_state_explicitly() {
        let mut state = test_skirmisher_state();

        note_skirmisher_blocked_target(&mut state, 10, 42_i32, 5);

        assert_eq!(state.blocked_target, Some(42));
        assert_eq!(state.blocked_target_until_tick, 15);
        assert!(skirmisher_target_recently_blocked(
            Some(&state),
            15,
            44,
            2,
            |left, right| i32::abs(left - right),
        ));
        clear_skirmisher_blocked_target_near(&mut state, 44, 2, |left, right| {
            i32::abs(left - right)
        });
        assert_eq!(state.blocked_target, None);
        assert_eq!(state.blocked_target_until_tick, 0);
    }

    #[test]
    fn skirmisher_move_memory_records_and_preserves_newer_live_move() {
        let mut next = test_skirmisher_state();
        let mut live = test_skirmisher_state();

        record_skirmisher_move(&mut live, 20, 120, -80);
        preserve_skirmisher_move_memory(&mut next, &live);

        assert_eq!(next.last_move_tick, 20);
        assert_eq!(next.last_move_dx_milli, 120);
        assert_eq!(next.last_move_dy_milli, -80);

        let mut stale = test_skirmisher_state();
        record_skirmisher_move(&mut stale, 10, -999, 999);
        preserve_skirmisher_move_memory(&mut next, &stale);

        assert_eq!(next.last_move_tick, 20);
        assert_eq!(next.last_move_dx_milli, 120);
        assert_eq!(next.last_move_dy_milli, -80);
    }

    #[test]
    fn skirmisher_tactical_contact_tracks_target_actor_move_or_cover() {
        let mut state = test_skirmisher_state();
        assert!(!skirmisher_has_tactical_contact(Some(&state)));
        assert!(!skirmisher_has_tactical_contact(
            None::<&SkirmisherAiState<i32>>
        ));

        state.target_actor_id = Some("enemy-01".to_owned());
        assert!(skirmisher_has_tactical_contact(Some(&state)));

        state.target_actor_id = None;
        state.target = Some(10);
        assert!(skirmisher_has_tactical_contact(Some(&state)));

        state.target = None;
        state.cover = Some(12);
        assert!(skirmisher_has_tactical_contact(Some(&state)));
    }

    #[test]
    fn skirmisher_mode_labels_match_authority_debug_contract() {
        assert_eq!(SkirmisherMode::Engage.label(), "engage");
        assert_eq!(SkirmisherMode::SeekCover.label(), "seek_cover");
        assert_eq!(SkirmisherMode::HoldCover.label(), "hold_cover");
    }

    #[test]
    fn skirmisher_micro_state_owns_targets_cover_and_blocked_memory() {
        let state = SkirmisherAiState {
            mode: SkirmisherMode::SeekCover,
            target_actor_id: Some("target-01".to_owned()),
            target: Some(10_i32),
            cover: Some(12_i32),
            next_decision_tick: 20,
            next_shot_tick: 30,
            burst_shots_remaining: 2,
            attitude: NpcAiAttitude::Alerted,
            alert_until_tick: 77,
            next_update_tick: 40,
            last_update_tick: 39,
            last_move_dx_milli: 100,
            last_move_dy_milli: -50,
            last_move_tick: 38,
            progress_target: Some(14_i32),
            progress_best_distance_milli: 900,
            progress_last_improved_tick: 37,
            blocked_target: Some(11_i32),
            blocked_target_until_tick: 55,
            seed: 7,
        };

        assert_eq!(state.mode, SkirmisherMode::SeekCover);
        assert_eq!(state.target_actor_id.as_deref(), Some("target-01"));
        assert_eq!(state.cover, Some(12));
        assert_eq!(state.progress_target, Some(14));
        assert_eq!(state.progress_best_distance_milli, 900);
        assert_eq!(state.progress_last_improved_tick, 37);
        assert_eq!(state.blocked_target, Some(11));
        assert_eq!(state.blocked_target_until_tick, 55);
    }

    #[test]
    fn pressure_replan_preserves_recent_committed_movement() {
        assert!(!tactical_pressure_replan_due(
            TacticalPressureReplanRequest {
                tick: 110,
                next_decision_tick: 140,
                distance_to_target_milli: Some(2_400),
                last_move_tick: 104,
                committed_move_reached_milli: 900,
                pressure_replan_grace_ticks: 10,
                incoming_fire: true,
                hard_suppressed: false,
                outgunned: false,
                forced_withdrawal: false,
            }
        ));
    }

    #[test]
    fn pressure_replan_fires_when_commit_is_stale_or_due() {
        let base = TacticalPressureReplanRequest {
            tick: 120,
            next_decision_tick: 140,
            distance_to_target_milli: Some(2_400),
            last_move_tick: 104,
            committed_move_reached_milli: 900,
            pressure_replan_grace_ticks: 10,
            incoming_fire: true,
            hard_suppressed: false,
            outgunned: false,
            forced_withdrawal: false,
        };
        assert!(tactical_pressure_replan_due(base));
        assert!(tactical_pressure_replan_due(
            TacticalPressureReplanRequest {
                tick: 140,
                last_move_tick: 139,
                ..base
            }
        ));
        assert!(tactical_pressure_replan_due(
            TacticalPressureReplanRequest {
                tick: 120,
                distance_to_target_milli: Some(400),
                last_move_tick: 119,
                ..base
            }
        ));
    }
}
