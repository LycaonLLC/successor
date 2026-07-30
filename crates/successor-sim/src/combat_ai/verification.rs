use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;

use super::affordance::{naive_evasion_target, PrimitiveCell, PrimitiveMap};
use super::behavior::{choose_assignments, PrimitiveBehaviorDecision};
use super::debug::{decision_trace, PrimitiveDecisionTrace};
use super::executor::{execute_assignment, execute_decision, PrimitiveExecution};
use super::query::{PrimitiveQueryActor, PrimitiveTacticalQuery};
use crate::navigation::{extract_blocked_cell_rects, NavCell, NavObstacleRect};

const REPORT_SCHEMA: &str = "successor.combat_ai.primitive_verification.v1";
const PRIMITIVE_MAP_SCHEMA: &str = "successor.combat_ai.primitive_map_bundle.v1";
const NAVIGATION_OVERLAY_SCHEMA: &str = "successor.combat_ai.navigation_overlay.v1";
const TACTICAL_AFFORDANCE_SCHEMA: &str = "successor.combat_ai.tactical_affordance_overlay.v1";
const REASON_HISTOGRAM_SCHEMA: &str = "successor.combat_ai.reason_histogram.v1";
const EDGE_DWELL_FAIL_MS: u32 = 5_000;
const REPEATED_NO_PROGRESS_FAIL_MS: u32 = 5_000;
const MIN_COMBAT_ENVELOPE_RATIO_MILLI: u32 = 950;
const MAX_EVASION_DOMINANCE_RATIO_MILLI: u32 = 350;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimitiveVerificationReport {
    pub schema: &'static str,
    pub passed: bool,
    pub maps: Vec<PrimitiveMapReport>,
    pub failures: Vec<String>,
    pub negative_controls: Vec<NegativeControlReport>,
    pub required_live_artifacts: Vec<&'static str>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimitiveMapReport {
    pub map_id: &'static str,
    pub width: i32,
    pub height: i32,
    pub blocked_cells: Vec<PrimitiveCell>,
    pub selected_moves: Vec<PrimitiveMoveReport>,
    pub debug_traces: Vec<PrimitiveDecisionTrace>,
    pub pathable: bool,
    pub cover_improvement: bool,
    pub distinct_slots: bool,
    pub edge_dwell_ms: u32,
    pub combat_envelope_ratio_milli: u32,
    pub evasion_dominance_ratio_milli: u32,
    pub bad_move_target_count: u32,
    pub repeated_no_progress_ms: u32,
    pub failures: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimitiveMoveReport {
    pub actor_id: &'static str,
    pub reason: &'static str,
    pub target: PrimitiveCell,
    pub path: Vec<PrimitiveCell>,
    pub reachable: bool,
    pub tactical: bool,
    pub path_len: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NegativeControlReport {
    pub id: &'static str,
    pub failed_as_expected: bool,
    pub observed_failures: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimitiveMapArtifact {
    pub schema: &'static str,
    pub maps: Vec<PrimitiveMapArtifactMap>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimitiveMapArtifactMap {
    pub map_id: &'static str,
    pub width: i32,
    pub height: i32,
    pub blocked_cells: Vec<PrimitiveCell>,
    pub obstacles: Vec<PrimitiveObstacleRect>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationOverlayArtifact {
    pub schema: &'static str,
    pub maps: Vec<NavigationOverlayMap>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationOverlayMap {
    pub map_id: &'static str,
    pub obstacles: Vec<PrimitiveObstacleRect>,
    pub paths: Vec<NavigationPathOverlay>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationPathOverlay {
    pub actor_id: &'static str,
    pub reason: &'static str,
    pub target: PrimitiveCell,
    pub reachable: bool,
    pub path_len: u32,
    pub path: Vec<PrimitiveCell>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimitiveObstacleRect {
    pub min: PrimitiveCell,
    pub max: PrimitiveCell,
    pub cell_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TacticalAffordanceOverlayArtifact {
    pub schema: &'static str,
    pub maps: Vec<TacticalAffordanceOverlayMap>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TacticalAffordanceOverlayMap {
    pub map_id: &'static str,
    pub metrics: TacticalAffordanceMetrics,
    pub selected_targets: Vec<TacticalAffordanceTarget>,
    pub debug_traces: Vec<PrimitiveDecisionTrace>,
    pub failures: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TacticalAffordanceMetrics {
    pub pathable: bool,
    pub cover_improvement: bool,
    pub distinct_slots: bool,
    pub edge_dwell_ms: u32,
    pub combat_envelope_ratio_milli: u32,
    pub evasion_dominance_ratio_milli: u32,
    pub bad_move_target_count: u32,
    pub repeated_no_progress_ms: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TacticalAffordanceTarget {
    pub actor_id: &'static str,
    pub reason: &'static str,
    pub target: PrimitiveCell,
    pub reachable: bool,
    pub tactical: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasonHistogramArtifact {
    pub schema: &'static str,
    pub total: BTreeMap<String, u32>,
    pub by_map: Vec<ReasonHistogramMap>,
    pub negative_controls: Vec<NegativeControlHistogram>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasonHistogramMap {
    pub map_id: &'static str,
    pub reasons: BTreeMap<String, u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NegativeControlHistogram {
    pub id: &'static str,
    pub failed_as_expected: bool,
    pub failure_reasons: BTreeMap<String, u32>,
}

#[derive(Debug, Clone, Copy)]
struct GateExpectation {
    cover_required: bool,
    distinct_slots_required: bool,
}

#[derive(Debug, Clone)]
struct PrimitiveMoveBundle {
    moves: Vec<PrimitiveMoveReport>,
    traces: Vec<PrimitiveDecisionTrace>,
}

pub fn verify_primitive_maps() -> PrimitiveVerificationReport {
    let maps = vec![
        verify_open_field(),
        verify_single_blocker(),
        verify_l_cover(),
        verify_two_cover_islands(),
        verify_corridor_choke(),
        verify_edge_bait(),
        verify_crowded_cover(),
    ];
    let negative_controls = verify_negative_controls();

    let mut failures = Vec::new();
    for map in &maps {
        failures.extend(
            map.failures
                .iter()
                .map(|failure| format!("{}: {failure}", map.map_id)),
        );
    }
    for control in &negative_controls {
        if !control.failed_as_expected {
            failures.push(format!(
                "negative control {} unexpectedly passed",
                control.id
            ));
        }
    }

    PrimitiveVerificationReport {
        schema: REPORT_SCHEMA,
        passed: failures.is_empty(),
        maps,
        failures,
        negative_controls,
        required_live_artifacts: vec![
            "report.json",
            "primitive-map.json",
            "navigation-overlay.json",
            "tactical-affordance-overlay.json",
            "reason-histogram.json",
            "start/mid/final screenshots",
            "30-60s browser clip for live soaks",
        ],
    }
}

pub fn primitive_map_artifact(report: &PrimitiveVerificationReport) -> PrimitiveMapArtifact {
    PrimitiveMapArtifact {
        schema: PRIMITIVE_MAP_SCHEMA,
        maps: report
            .maps
            .iter()
            .map(|map| PrimitiveMapArtifactMap {
                map_id: map.map_id,
                width: map.width,
                height: map.height,
                blocked_cells: map.blocked_cells.clone(),
                obstacles: obstacle_rects_for_blocked_cells(&map.blocked_cells),
            })
            .collect(),
    }
}

pub fn navigation_overlay_artifact(
    report: &PrimitiveVerificationReport,
) -> NavigationOverlayArtifact {
    NavigationOverlayArtifact {
        schema: NAVIGATION_OVERLAY_SCHEMA,
        maps: report
            .maps
            .iter()
            .map(|map| NavigationOverlayMap {
                map_id: map.map_id,
                obstacles: obstacle_rects_for_blocked_cells(&map.blocked_cells),
                paths: map
                    .selected_moves
                    .iter()
                    .map(|selected| NavigationPathOverlay {
                        actor_id: selected.actor_id,
                        reason: selected.reason,
                        target: selected.target,
                        reachable: selected.reachable,
                        path_len: selected.path_len,
                        path: selected.path.clone(),
                    })
                    .collect(),
            })
            .collect(),
    }
}

fn obstacle_rects_for_blocked_cells(blocked_cells: &[PrimitiveCell]) -> Vec<PrimitiveObstacleRect> {
    extract_blocked_cell_rects(
        blocked_cells
            .iter()
            .map(|cell| NavCell::new(cell.x, cell.y)),
    )
    .into_iter()
    .map(primitive_obstacle_rect)
    .collect()
}

fn primitive_obstacle_rect(rect: NavObstacleRect) -> PrimitiveObstacleRect {
    PrimitiveObstacleRect {
        min: PrimitiveCell::from(rect.min),
        max: PrimitiveCell::from(rect.max),
        cell_count: rect.cell_count(),
    }
}

pub fn tactical_affordance_overlay_artifact(
    report: &PrimitiveVerificationReport,
) -> TacticalAffordanceOverlayArtifact {
    TacticalAffordanceOverlayArtifact {
        schema: TACTICAL_AFFORDANCE_SCHEMA,
        maps: report
            .maps
            .iter()
            .map(|map| TacticalAffordanceOverlayMap {
                map_id: map.map_id,
                metrics: TacticalAffordanceMetrics {
                    pathable: map.pathable,
                    cover_improvement: map.cover_improvement,
                    distinct_slots: map.distinct_slots,
                    edge_dwell_ms: map.edge_dwell_ms,
                    combat_envelope_ratio_milli: map.combat_envelope_ratio_milli,
                    evasion_dominance_ratio_milli: map.evasion_dominance_ratio_milli,
                    bad_move_target_count: map.bad_move_target_count,
                    repeated_no_progress_ms: map.repeated_no_progress_ms,
                },
                selected_targets: map
                    .selected_moves
                    .iter()
                    .map(|selected| TacticalAffordanceTarget {
                        actor_id: selected.actor_id,
                        reason: selected.reason,
                        target: selected.target,
                        reachable: selected.reachable,
                        tactical: selected.tactical,
                    })
                    .collect(),
                debug_traces: map.debug_traces.clone(),
                failures: map.failures.clone(),
            })
            .collect(),
    }
}

pub fn reason_histogram_artifact(report: &PrimitiveVerificationReport) -> ReasonHistogramArtifact {
    let mut total = BTreeMap::new();
    let by_map = report
        .maps
        .iter()
        .map(|map| {
            let mut reasons = BTreeMap::new();
            for selected in &map.selected_moves {
                increment_reason(&mut reasons, selected.reason);
                increment_reason(&mut total, selected.reason);
            }
            ReasonHistogramMap {
                map_id: map.map_id,
                reasons,
            }
        })
        .collect();
    let negative_controls = report
        .negative_controls
        .iter()
        .map(|control| NegativeControlHistogram {
            id: control.id,
            failed_as_expected: control.failed_as_expected,
            failure_reasons: failure_reason_histogram(&control.observed_failures),
        })
        .collect();

    ReasonHistogramArtifact {
        schema: REASON_HISTOGRAM_SCHEMA,
        total,
        by_map,
        negative_controls,
    }
}

fn increment_reason(histogram: &mut BTreeMap<String, u32>, reason: &str) {
    let entry = histogram.entry(reason.to_owned()).or_insert(0);
    *entry = entry.saturating_add(1);
}

fn failure_reason_histogram(failures: &[String]) -> BTreeMap<String, u32> {
    let mut histogram = BTreeMap::new();
    for failure in failures {
        let reason = failure
            .split_once(' ')
            .map(|(reason, _)| reason)
            .unwrap_or(failure.as_str());
        increment_reason(&mut histogram, reason);
    }
    histogram
}

fn verify_open_field() -> PrimitiveMapReport {
    let map = PrimitiveMap::open_field();
    let actor = PrimitiveCell::new(3, 6);
    let threat = PrimitiveCell::new(14, 6);
    let target = PrimitiveCell::new(8, 6);
    let Some(bundle) = query_move_bundle(
        &map,
        &PrimitiveTacticalQuery::advance("agent-01", actor, target, threat),
        |_| true,
    ) else {
        return failed_map_report(&map, "advance query produced no decision");
    };

    build_map_report(
        &map,
        bundle.moves,
        bundle.traces,
        true,
        true,
        0,
        GateExpectation {
            cover_required: false,
            distinct_slots_required: false,
        },
    )
}

fn verify_single_blocker() -> PrimitiveMapReport {
    let map = PrimitiveMap::single_blocker();
    let actor = PrimitiveCell::new(3, 6);
    let target = PrimitiveCell::new(14, 6);
    let blocked_target = PrimitiveCell::new(8, 6);
    let path = map.path(actor, target).unwrap_or_default();
    let routes_around_blocker = path.len() > 12 && path.iter().all(|cell| !map.blocked(*cell));
    let Some(around_blocker) = query_move_bundle(
        &map,
        &PrimitiveTacticalQuery::reachable_move("agent-01", actor, target, "around_blocker"),
        |_| routes_around_blocker,
    ) else {
        return failed_map_report(&map, "around-blocker query produced no decision");
    };
    let Some(blocked_target_fallback) = query_move_bundle(
        &map,
        &PrimitiveTacticalQuery::nearest_reachable("agent-01", actor, blocked_target, 3),
        |_| true,
    ) else {
        return failed_map_report(&map, "nearest-reachable query produced no decision");
    };

    build_map_report(
        &map,
        [around_blocker.moves, blocked_target_fallback.moves].concat(),
        [around_blocker.traces, blocked_target_fallback.traces].concat(),
        true,
        true,
        0,
        GateExpectation {
            cover_required: false,
            distinct_slots_required: false,
        },
    )
}

fn verify_l_cover() -> PrimitiveMapReport {
    let map = PrimitiveMap::l_cover();
    let actor = PrimitiveCell::new(5, 8);
    let threat = PrimitiveCell::new(14, 8);
    let Some(bundle) = query_move_bundle(
        &map,
        &PrimitiveTacticalQuery::cover("agent-01", actor, threat, "seek_cover"),
        |_| true,
    ) else {
        return failed_map_report(&map, "no protective cover candidate found");
    };
    let cover_improvement = bundle.moves.iter().all(|movement| movement.tactical);

    build_map_report(
        &map,
        bundle.moves,
        bundle.traces,
        cover_improvement,
        true,
        0,
        GateExpectation {
            cover_required: true,
            distinct_slots_required: false,
        },
    )
}

fn verify_two_cover_islands() -> PrimitiveMapReport {
    let map = PrimitiveMap::two_cover_islands();
    let actor = PrimitiveCell::new(4, 11);
    let threat = PrimitiveCell::new(20, 7);
    let Some(bundle) = query_move_bundle(
        &map,
        &PrimitiveTacticalQuery::cover("agent-01", actor, threat, "ranked_cover"),
        |_| true,
    ) else {
        return failed_map_report(&map, "no island cover candidate found");
    };
    let cover_improvement = bundle.moves.iter().all(|movement| movement.tactical);

    build_map_report(
        &map,
        bundle.moves,
        bundle.traces,
        cover_improvement,
        true,
        0,
        GateExpectation {
            cover_required: true,
            distinct_slots_required: false,
        },
    )
}

fn verify_corridor_choke() -> PrimitiveMapReport {
    let map = PrimitiveMap::corridor_choke();
    let actor = PrimitiveCell::new(3, 6);
    let target = PrimitiveCell::new(16, 6);
    let path = map.path(actor, target).unwrap_or_default();
    let gap = PrimitiveCell::new(9, 6);
    let tactical = path.contains(&gap) && path.iter().all(|cell| !map.blocked(*cell));
    let Some(bundle) = query_move_bundle(
        &map,
        &PrimitiveTacticalQuery::reachable_move("agent-01", actor, target, "corridor_advance"),
        |_| tactical,
    ) else {
        return failed_map_report(&map, "corridor advance query produced no decision");
    };

    build_map_report(
        &map,
        bundle.moves,
        bundle.traces,
        true,
        true,
        0,
        GateExpectation {
            cover_required: false,
            distinct_slots_required: false,
        },
    )
}

fn verify_edge_bait() -> PrimitiveMapReport {
    let map = PrimitiveMap::edge_bait();
    let actor = PrimitiveCell::new(8, 1);
    let threat = PrimitiveCell::new(8, 6);
    let Some(bundle) = query_move_bundle(
        &map,
        &PrimitiveTacticalQuery::lateral_evasion("agent-01", actor, threat),
        |_| true,
    ) else {
        return failed_map_report(&map, "no legal non-edge evasion target found");
    };

    build_map_report(
        &map,
        bundle.moves,
        bundle.traces,
        true,
        true,
        250,
        GateExpectation {
            cover_required: false,
            distinct_slots_required: false,
        },
    )
}

fn verify_crowded_cover() -> PrimitiveMapReport {
    let map = PrimitiveMap::crowded_cover();
    let agents = [
        PrimitiveCell::new(4, 2),
        PrimitiveCell::new(5, 2),
        PrimitiveCell::new(4, 10),
    ];
    let threat = PrimitiveCell::new(17, 7);
    let Some(bundle) = query_move_bundle(
        &map,
        &PrimitiveTacticalQuery::crowded_cover(
            vec![
                PrimitiveQueryActor::new("agent-01", agents[0]),
                PrimitiveQueryActor::new("agent-02", agents[1]),
                PrimitiveQueryActor::new("agent-03", agents[2]),
            ],
            threat,
        ),
        |_| true,
    ) else {
        return failed_map_report(&map, "not enough distinct cover slots");
    };
    let distinct_slots = bundle
        .moves
        .iter()
        .map(|movement| movement.target)
        .collect::<BTreeSet<_>>()
        .len()
        == bundle.moves.len();
    let cover_improvement = bundle.moves.iter().all(|movement| movement.tactical);

    build_map_report(
        &map,
        bundle.moves,
        bundle.traces,
        cover_improvement,
        distinct_slots,
        0,
        GateExpectation {
            cover_required: true,
            distinct_slots_required: true,
        },
    )
}

fn verify_negative_controls() -> Vec<NegativeControlReport> {
    vec![
        negative_edge_bait_naive_evasion(),
        negative_blocked_no_progress(),
    ]
}

fn negative_edge_bait_naive_evasion() -> NegativeControlReport {
    let map = PrimitiveMap::edge_bait();
    let actor = PrimitiveCell::new(8, 1);
    let threat = PrimitiveCell::new(8, 6);
    let target = naive_evasion_target(&map, actor, threat);
    let tactical = !map.near_edge(target) && map.inside_combat_envelope(target);
    let bundle = direct_move_bundle(
        &map,
        "agent-01",
        "naive_away_evasion",
        actor,
        target,
        tactical,
    );
    let report = build_map_report(
        &map,
        bundle.moves,
        bundle.traces,
        true,
        true,
        1_000,
        GateExpectation {
            cover_required: false,
            distinct_slots_required: false,
        },
    );
    NegativeControlReport {
        id: "edge_bait_naive_evasion",
        failed_as_expected: !report.failures.is_empty(),
        observed_failures: report.failures,
    }
}

fn negative_blocked_no_progress() -> NegativeControlReport {
    let map = PrimitiveMap::single_blocker();
    let actor = PrimitiveCell::new(3, 6);
    let blocked_target = PrimitiveCell::new(8, 6);
    let bundle = direct_move_bundle(
        &map,
        "agent-01",
        "blocked_straight_target",
        actor,
        blocked_target,
        false,
    );
    let report = build_map_report(
        &map,
        bundle.moves,
        bundle.traces,
        true,
        true,
        0,
        GateExpectation {
            cover_required: false,
            distinct_slots_required: false,
        },
    );
    NegativeControlReport {
        id: "blocked_no_progress",
        failed_as_expected: !report.failures.is_empty(),
        observed_failures: report.failures,
    }
}

fn build_map_report(
    map: &PrimitiveMap,
    selected_moves: Vec<PrimitiveMoveReport>,
    debug_traces: Vec<PrimitiveDecisionTrace>,
    cover_improvement: bool,
    distinct_slots: bool,
    evasion_dominance_ratio_milli: u32,
    expectation: GateExpectation,
) -> PrimitiveMapReport {
    let edge_dwell_ms = if selected_moves
        .iter()
        .any(|selected| map.near_edge(selected.target))
    {
        EDGE_DWELL_FAIL_MS.saturating_add(1)
    } else {
        0
    };
    let combat_envelope_ratio_milli = if selected_moves.is_empty() {
        0
    } else {
        let valid = selected_moves
            .iter()
            .filter(|selected| map.inside_combat_envelope(selected.target))
            .count();
        u32::try_from(valid.saturating_mul(1_000) / selected_moves.len()).unwrap_or(0)
    };
    let bad_move_target_count = selected_moves
        .iter()
        .filter(|selected| !selected.reachable || !selected.tactical)
        .count()
        .try_into()
        .unwrap_or(u32::MAX);
    let repeated_no_progress_ms = if selected_moves
        .iter()
        .any(|selected| !selected.reachable || selected.path_len <= 1)
    {
        REPEATED_NO_PROGRESS_FAIL_MS.saturating_add(1)
    } else {
        0
    };
    let pathable = selected_moves.iter().all(|selected| selected.reachable);

    let mut failures = Vec::new();
    if edge_dwell_ms > EDGE_DWELL_FAIL_MS {
        failures.push(format!("edgeDwellMs {edge_dwell_ms}"));
    }
    if combat_envelope_ratio_milli < MIN_COMBAT_ENVELOPE_RATIO_MILLI {
        failures.push(format!(
            "combatEnvelopeRatioMilli {combat_envelope_ratio_milli}"
        ));
    }
    if expectation.cover_required && !cover_improvement {
        failures.push("coverImprovement false".to_owned());
    }
    if evasion_dominance_ratio_milli > MAX_EVASION_DOMINANCE_RATIO_MILLI {
        failures.push(format!(
            "evasionDominanceRatioMilli {evasion_dominance_ratio_milli}"
        ));
    }
    if bad_move_target_count > 0 {
        failures.push(format!("badMoveTargetCount {bad_move_target_count}"));
    }
    if repeated_no_progress_ms > REPEATED_NO_PROGRESS_FAIL_MS {
        failures.push(format!("repeatedNoProgressMs {repeated_no_progress_ms}"));
    }
    if expectation.distinct_slots_required && !distinct_slots {
        failures.push("distinctSlots false".to_owned());
    }

    PrimitiveMapReport {
        map_id: map.id,
        width: map.width,
        height: map.height,
        blocked_cells: map.blocked.iter().copied().collect(),
        selected_moves,
        debug_traces,
        pathable,
        cover_improvement,
        distinct_slots,
        edge_dwell_ms,
        combat_envelope_ratio_milli,
        evasion_dominance_ratio_milli,
        bad_move_target_count,
        repeated_no_progress_ms,
        failures,
    }
}

fn failed_map_report(map: &PrimitiveMap, failure: &str) -> PrimitiveMapReport {
    PrimitiveMapReport {
        map_id: map.id,
        width: map.width,
        height: map.height,
        blocked_cells: map.blocked.iter().copied().collect(),
        selected_moves: Vec::new(),
        debug_traces: Vec::new(),
        pathable: false,
        cover_improvement: false,
        distinct_slots: false,
        edge_dwell_ms: 0,
        combat_envelope_ratio_milli: 0,
        evasion_dominance_ratio_milli: 0,
        bad_move_target_count: 1,
        repeated_no_progress_ms: REPEATED_NO_PROGRESS_FAIL_MS.saturating_add(1),
        failures: vec![failure.to_owned()],
    }
}

fn move_report(actor_id: &'static str, execution: PrimitiveExecution) -> PrimitiveMoveReport {
    PrimitiveMoveReport {
        actor_id,
        reason: execution.reason,
        target: execution.target,
        path: execution.path,
        reachable: execution.reachable,
        tactical: execution.tactical,
        path_len: execution.path_len,
    }
}

fn query_move_bundle(
    map: &PrimitiveMap,
    query: &PrimitiveTacticalQuery,
    tactical_filter: impl Fn(&PrimitiveExecution) -> bool,
) -> Option<PrimitiveMoveBundle> {
    let mut moves = Vec::new();
    let mut traces = Vec::new();
    for assignment in choose_assignments(map, query)? {
        let mut execution = execute_assignment(map, assignment);
        execution.tactical = execution.tactical && tactical_filter(&execution);
        traces.push(decision_trace(
            map,
            query.kind.label(),
            assignment.actor_id,
            assignment.actor,
            &execution,
        ));
        moves.push(move_report(assignment.actor_id, execution));
    }
    Some(PrimitiveMoveBundle { moves, traces })
}

fn direct_move_bundle(
    map: &PrimitiveMap,
    actor_id: &'static str,
    reason: &'static str,
    actor: PrimitiveCell,
    target: PrimitiveCell,
    tactical: bool,
) -> PrimitiveMoveBundle {
    let decision = PrimitiveBehaviorDecision {
        reason,
        target,
        tactical,
    };
    let execution = execute_decision(map, actor, decision);
    PrimitiveMoveBundle {
        moves: vec![move_report(actor_id, execution.clone())],
        traces: vec![decision_trace(
            map,
            "negative_control",
            actor_id,
            actor,
            &execution,
        )],
    }
}

impl PrimitiveMap {
    fn open_field() -> Self {
        Self::new("open_field", 18, 12, [])
    }

    fn single_blocker() -> Self {
        Self::new(
            "single_blocker",
            18,
            12,
            (3..=8).map(|y| PrimitiveCell::new(8, y)),
        )
    }

    fn l_cover() -> Self {
        let vertical = (3..=6).map(|y| PrimitiveCell::new(9, y));
        let horizontal = (9..=12).map(|x| PrimitiveCell::new(x, 6));
        Self::new("l_cover", 18, 12, vertical.chain(horizontal))
    }

    fn two_cover_islands() -> Self {
        let first = (5..=8).map(|y| PrimitiveCell::new(9, y));
        let second = (4..=6).map(|y| PrimitiveCell::new(15, y));
        Self::new("two_cover_islands", 22, 14, first.chain(second))
    }

    fn corridor_choke() -> Self {
        Self::new(
            "corridor_choke",
            20,
            12,
            (0..12)
                .filter(|y| *y != 6)
                .map(|y| PrimitiveCell::new(9, y)),
        )
    }

    fn edge_bait() -> Self {
        Self::new("edge_bait", 18, 12, [])
    }

    fn crowded_cover() -> Self {
        let first = (5..=8).map(|y| PrimitiveCell::new(10, y));
        let second = (9..=11).map(|y| PrimitiveCell::new(12, y));
        Self::new("crowded_cover", 22, 14, first.chain(second))
    }
}

#[cfg(test)]
mod tests {
    use super::super::affordance::{
        assign_distinct_cover_slots, exposure_score, nearest_reachable_open_cell,
    };
    use super::*;

    #[test]
    fn combat_ai_primitive_maps_pass_current_gates() {
        let report = verify_primitive_maps();
        assert!(
            report.passed,
            "primitive map verification failed: {}",
            serde_json::to_string_pretty(&report).unwrap()
        );
        assert_eq!(report.maps.len(), 7);
    }

    #[test]
    fn combat_ai_primitive_negative_controls_fail() {
        let report = verify_primitive_maps();
        assert!(
            report
                .negative_controls
                .iter()
                .all(|control| control.failed_as_expected),
            "a negative control unexpectedly passed: {:?}",
            report.negative_controls
        );
        assert!(
            report
                .negative_controls
                .iter()
                .any(|control| control.id == "edge_bait_naive_evasion"
                    && control
                        .observed_failures
                        .iter()
                        .any(|failure| failure.contains("edgeDwellMs"))),
            "edge-flight negative control did not trip edge dwell"
        );
    }

    #[test]
    fn combat_ai_primitive_artifacts_cover_required_bundle() {
        let report = verify_primitive_maps();
        let primitive_map = primitive_map_artifact(&report);
        let navigation = navigation_overlay_artifact(&report);
        let affordance = tactical_affordance_overlay_artifact(&report);
        let reasons = reason_histogram_artifact(&report);

        assert_eq!(primitive_map.maps.len(), 7);
        assert_eq!(navigation.maps.len(), 7);
        assert_eq!(affordance.maps.len(), 7);
        assert_eq!(
            reasons.total.get("crowded_cover_slot"),
            Some(&3),
            "reason histogram should preserve multi-agent cover-slot proof"
        );
        assert!(
            navigation
                .maps
                .iter()
                .flat_map(|map| map.paths.iter())
                .any(|path| path.reason == "around_blocker" && path.path_len > 12),
            "navigation overlay should expose the around-blocker detour path"
        );
        assert!(
            navigation
                .maps
                .iter()
                .flat_map(|map| map.paths.iter())
                .any(|path| path.reason == "nearest_reachable"
                    && path.target == PrimitiveCell::new(7, 6)
                    && path.reachable),
            "navigation overlay should expose blocked-target nearest reachable fallback"
        );
        assert!(
            affordance.maps.iter().any(|map| map.map_id == "edge_bait"
                && map.metrics.edge_dwell_ms == 0
                && map.metrics.bad_move_target_count == 0),
            "tactical overlay should expose edge-bait safety metrics"
        );
        assert!(
            affordance
                .maps
                .iter()
                .flat_map(|map| map.debug_traces.iter())
                .any(|trace| trace.query_kind == "nearest_reachable"
                    && trace.reason == "nearest_reachable"
                    && trace.failure_flags.is_empty()),
            "tactical overlay should expose query/debug traces for primitive decisions"
        );
    }

    #[test]
    fn combat_ai_primitive_queries_emit_debug_traces() {
        let report = verify_primitive_maps();
        let traces = report
            .maps
            .iter()
            .flat_map(|map| map.debug_traces.iter())
            .collect::<Vec<_>>();

        assert!(
            traces.iter().any(|trace| trace.query_kind == "cover"
                && matches!(trace.reason, "seek_cover" | "ranked_cover")
                && trace.tactical),
            "cover queries should produce tactical debug traces"
        );
        assert!(
            traces
                .iter()
                .any(|trace| trace.query_kind == "crowded_cover"
                    && trace.reason == "crowded_cover_slot"
                    && trace.actor_id == "agent-03"),
            "multi-agent cover queries should trace every assigned actor"
        );
        assert!(
            traces.iter().all(|trace| trace.failure_flags.is_empty()),
            "passing primitive maps should not emit debug failure flags: {traces:?}"
        );
    }

    #[test]
    fn combat_ai_primitive_blocked_target_selects_nearest_reachable_cell() {
        let map = PrimitiveMap::single_blocker();
        let actor = PrimitiveCell::new(3, 6);
        let blocked_target = PrimitiveCell::new(8, 6);
        let fallback = nearest_reachable_open_cell(&map, actor, blocked_target, 3)
            .expect("blocked target should have a reachable adjacent fallback");

        assert_eq!(fallback, PrimitiveCell::new(7, 6));
        assert!(!map.blocked(fallback));
        assert!(map.path(actor, fallback).is_some());
    }

    #[test]
    fn combat_ai_primitive_crowded_cover_assigns_distinct_slots() {
        let map = PrimitiveMap::crowded_cover();
        let agents = [
            PrimitiveCell::new(4, 2),
            PrimitiveCell::new(5, 2),
            PrimitiveCell::new(4, 10),
        ];
        let threat = PrimitiveCell::new(17, 7);
        let slots = assign_distinct_cover_slots(&map, &agents, threat)
            .expect("crowded cover should have enough legal slots");

        assert_eq!(
            slots.iter().copied().collect::<BTreeSet<_>>().len(),
            slots.len()
        );
        for (agent, slot) in agents.iter().zip(slots.iter()) {
            assert!(
                exposure_score(&map, *slot, threat) < exposure_score(&map, *agent, threat),
                "{slot:?} should improve cover for {agent:?}"
            );
        }
    }
}
