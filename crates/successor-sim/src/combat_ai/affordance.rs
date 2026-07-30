use std::collections::BTreeSet;

use serde::Serialize;

use crate::navigation::{find_cell_path, NavCell, NavPathRequest, NavPosition};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimitiveCell {
    pub x: i32,
    pub y: i32,
}

impl PrimitiveCell {
    pub(crate) const fn new(x: i32, y: i32) -> Self {
        Self { x, y }
    }

    fn nav(self) -> NavCell {
        NavCell::new(self.x, self.y)
    }
}

impl From<NavCell> for PrimitiveCell {
    fn from(cell: NavCell) -> Self {
        Self::new(cell.x, cell.y)
    }
}

#[derive(Clone)]
pub(crate) struct PrimitiveMap {
    pub(crate) id: &'static str,
    pub(crate) width: i32,
    pub(crate) height: i32,
    pub(crate) blocked: BTreeSet<PrimitiveCell>,
}

impl PrimitiveMap {
    pub(crate) fn new<I>(id: &'static str, width: i32, height: i32, blocked: I) -> Self
    where
        I: IntoIterator<Item = PrimitiveCell>,
    {
        Self {
            id,
            width,
            height,
            blocked: blocked.into_iter().collect(),
        }
    }

    pub(crate) fn contains(&self, cell: PrimitiveCell) -> bool {
        cell.x >= 0 && cell.y >= 0 && cell.x < self.width && cell.y < self.height
    }

    pub(crate) fn blocked(&self, cell: PrimitiveCell) -> bool {
        self.blocked.contains(&cell)
    }

    pub(crate) fn open(&self, cell: PrimitiveCell) -> bool {
        self.contains(cell) && !self.blocked(cell)
    }

    pub(crate) fn path(
        &self,
        start: PrimitiveCell,
        goal: PrimitiveCell,
    ) -> Option<Vec<PrimitiveCell>> {
        let contains = |cell: NavCell| self.contains(cell.into());
        let blocked = |cell: NavCell| self.blocked(cell.into());
        let transition_clear = |_: NavCell, _: NavCell| true;
        let result = find_cell_path(NavPathRequest {
            start: start.nav(),
            goal: goal.nav(),
            max_expansions: 512,
            contains: &contains,
            blocked: &blocked,
            transition_clear: &transition_clear,
        });
        result
            .path
            .map(|path| path.into_iter().map(PrimitiveCell::from).collect())
    }

    pub(crate) fn near_edge(&self, cell: PrimitiveCell) -> bool {
        cell.x <= 1 || cell.y <= 1 || cell.x >= self.width - 2 || cell.y >= self.height - 2
    }

    pub(crate) fn inside_combat_envelope(&self, cell: PrimitiveCell) -> bool {
        self.open(cell) && !self.near_edge(cell)
    }

    pub(crate) fn clamp(&self, cell: PrimitiveCell) -> PrimitiveCell {
        PrimitiveCell::new(
            cell.x.clamp(0, self.width - 1),
            cell.y.clamp(0, self.height - 1),
        )
    }

    pub(crate) fn nudge_inside_envelope(&self, cell: PrimitiveCell) -> PrimitiveCell {
        PrimitiveCell::new(
            cell.x.clamp(2, self.width - 3),
            cell.y.clamp(2, self.height - 3),
        )
    }

    pub(crate) fn line_of_sight(&self, start: PrimitiveCell, end: PrimitiveCell) -> bool {
        trace_line(start, end)
            .into_iter()
            .filter(|cell| *cell != start && *cell != end)
            .all(|cell| !self.blocked(cell))
    }
}

pub(crate) fn select_cover(
    map: &PrimitiveMap,
    actor: PrimitiveCell,
    threat: PrimitiveCell,
) -> Option<PrimitiveCell> {
    let start_exposure = exposure_score(map, actor, threat);
    cover_candidates(map)
        .into_iter()
        .filter(|candidate| map.path(actor, *candidate).is_some())
        .filter(|candidate| !map.near_edge(*candidate))
        .filter(|candidate| exposure_score(map, *candidate, threat) < start_exposure)
        .filter(|candidate| has_peek_option(map, *candidate, threat))
        .min_by_key(|candidate| {
            (
                exposure_score(map, *candidate, threat),
                map.path(actor, *candidate)
                    .map(|path| path.len())
                    .unwrap_or(usize::MAX),
                distance_cells(*candidate, threat),
            )
        })
}

pub(crate) fn select_evasion_target(
    map: &PrimitiveMap,
    actor: PrimitiveCell,
    threat: PrimitiveCell,
) -> Option<PrimitiveCell> {
    let dx = (actor.x - threat.x).signum();
    let dy = (actor.y - threat.y).signum();
    let lateral = if dx.abs() >= dy.abs() {
        [(0, 4), (0, -4)]
    } else {
        [(4, 0), (-4, 0)]
    };
    let candidates = [
        map.nudge_inside_envelope(PrimitiveCell::new(
            actor.x + lateral[0].0,
            actor.y + lateral[0].1,
        )),
        map.nudge_inside_envelope(PrimitiveCell::new(
            actor.x + lateral[1].0,
            actor.y + lateral[1].1,
        )),
        map.nudge_inside_envelope(PrimitiveCell::new(
            actor.x + dx * 3 + lateral[0].0 / 2,
            actor.y + dy * 3 + lateral[0].1 / 2,
        )),
        map.nudge_inside_envelope(PrimitiveCell::new(
            actor.x + dx * 3 + lateral[1].0 / 2,
            actor.y + dy * 3 + lateral[1].1 / 2,
        )),
    ];
    candidates
        .into_iter()
        .filter(|candidate| map.open(*candidate))
        .filter(|candidate| !map.near_edge(*candidate))
        .filter(|candidate| map.inside_combat_envelope(*candidate))
        .filter(|candidate| map.path(actor, *candidate).is_some())
        .max_by_key(|candidate| {
            (
                distance_cells(*candidate, threat),
                -i32::try_from(
                    map.path(actor, *candidate)
                        .map(|path| path.len())
                        .unwrap_or(99),
                )
                .unwrap_or(99),
            )
        })
}

pub(crate) fn naive_evasion_target(
    map: &PrimitiveMap,
    actor: PrimitiveCell,
    threat: PrimitiveCell,
) -> PrimitiveCell {
    let dx = (actor.x - threat.x).signum();
    let dy = (actor.y - threat.y).signum();
    map.clamp(PrimitiveCell::new(actor.x + dx * 4, actor.y + dy * 4))
}

pub(crate) fn nearest_reachable_open_cell(
    map: &PrimitiveMap,
    actor: PrimitiveCell,
    requested: PrimitiveCell,
    max_radius: i32,
) -> Option<PrimitiveCell> {
    let mut candidates = Vec::new();
    for radius in 0..=max_radius.max(0) {
        for dx in -radius..=radius {
            for dy in -radius..=radius {
                let candidate = PrimitiveCell::new(requested.x + dx, requested.y + dy);
                if distance_cells(candidate, requested) <= radius {
                    candidates.push(candidate);
                }
            }
        }
    }
    candidates
        .into_iter()
        .filter(|candidate| map.open(*candidate))
        .filter(|candidate| map.inside_combat_envelope(*candidate))
        .filter_map(|candidate| {
            map.path(actor, candidate).map(|path| {
                (
                    candidate,
                    distance_cells(candidate, requested),
                    path.len(),
                    distance_cells(candidate, actor),
                )
            })
        })
        .min_by_key(|(candidate, target_distance, path_len, actor_distance)| {
            (
                *target_distance,
                *path_len,
                *actor_distance,
                candidate.y,
                candidate.x,
            )
        })
        .map(|(candidate, _, _, _)| candidate)
}

pub(crate) fn assign_distinct_cover_slots(
    map: &PrimitiveMap,
    agents: &[PrimitiveCell],
    threat: PrimitiveCell,
) -> Option<Vec<PrimitiveCell>> {
    let mut assigned = BTreeSet::new();
    let mut slots = Vec::new();
    for agent in agents {
        let start_exposure = exposure_score(map, *agent, threat);
        let selected = cover_candidates(map)
            .into_iter()
            .filter(|candidate| !assigned.contains(candidate))
            .filter(|candidate| !map.near_edge(*candidate))
            .filter(|candidate| map.path(*agent, *candidate).is_some())
            .filter(|candidate| exposure_score(map, *candidate, threat) < start_exposure)
            .filter(|candidate| has_peek_option(map, *candidate, threat))
            .min_by_key(|candidate| {
                (
                    exposure_score(map, *candidate, threat),
                    map.path(*agent, *candidate)
                        .map(|path| path.len())
                        .unwrap_or(usize::MAX),
                )
            })?;
        assigned.insert(selected);
        slots.push(selected);
    }
    Some(slots)
}

pub(crate) fn tactical_position_near_world_edge(
    position: NavPosition,
    width_milli: i32,
    height_milli: i32,
    margin_milli: i32,
) -> bool {
    let margin_milli = margin_milli.max(0);
    if width_milli <= margin_milli.saturating_mul(2)
        || height_milli <= margin_milli.saturating_mul(2)
    {
        return false;
    }
    position.x_milli <= margin_milli
        || position.y_milli <= margin_milli
        || position.x_milli >= width_milli.saturating_sub(margin_milli)
        || position.y_milli >= height_milli.saturating_sub(margin_milli)
}

pub(crate) fn has_peek_option(
    map: &PrimitiveMap,
    cover: PrimitiveCell,
    threat: PrimitiveCell,
) -> bool {
    neighbors4(cover)
        .into_iter()
        .any(|peek| map.open(peek) && map.line_of_sight(peek, threat))
}

pub(crate) fn exposure_score(
    map: &PrimitiveMap,
    position: PrimitiveCell,
    threat: PrimitiveCell,
) -> u32 {
    if map.line_of_sight(position, threat) {
        100
    } else {
        20
    }
}

pub(crate) fn distance_cells(a: PrimitiveCell, b: PrimitiveCell) -> i32 {
    (a.x - b.x).abs().saturating_add((a.y - b.y).abs())
}

fn cover_candidates(map: &PrimitiveMap) -> Vec<PrimitiveCell> {
    let mut candidates = BTreeSet::new();
    for blocked in &map.blocked {
        for neighbor in neighbors4(*blocked) {
            if map.open(neighbor) {
                candidates.insert(neighbor);
            }
        }
    }
    candidates.into_iter().collect()
}

fn neighbors4(cell: PrimitiveCell) -> [PrimitiveCell; 4] {
    [
        PrimitiveCell::new(cell.x.saturating_add(1), cell.y),
        PrimitiveCell::new(cell.x.saturating_sub(1), cell.y),
        PrimitiveCell::new(cell.x, cell.y.saturating_add(1)),
        PrimitiveCell::new(cell.x, cell.y.saturating_sub(1)),
    ]
}

fn trace_line(start: PrimitiveCell, end: PrimitiveCell) -> Vec<PrimitiveCell> {
    let mut cells = Vec::new();
    let mut x = start.x;
    let mut y = start.y;
    let dx = (end.x - start.x).abs();
    let dy = -(end.y - start.y).abs();
    let sx = if start.x < end.x { 1 } else { -1 };
    let sy = if start.y < end.y { 1 } else { -1 };
    let mut err = dx + dy;

    loop {
        cells.push(PrimitiveCell::new(x, y));
        if x == end.x && y == end.y {
            break;
        }
        let e2 = err.saturating_mul(2);
        if e2 >= dy {
            err = err.saturating_add(dy);
            x = x.saturating_add(sx);
        }
        if e2 <= dx {
            err = err.saturating_add(dx);
            y = y.saturating_add(sy);
        }
    }

    cells
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tactical_position_near_world_edge_uses_margin_and_bounds() {
        let width = 100_000;
        let height = 80_000;
        let margin = 10_000;

        assert!(tactical_position_near_world_edge(
            NavPosition::new(9_000, 40_000),
            width,
            height,
            margin,
        ));
        assert!(tactical_position_near_world_edge(
            NavPosition::new(50_000, 72_000),
            width,
            height,
            margin,
        ));
        assert!(!tactical_position_near_world_edge(
            NavPosition::new(50_000, 40_000),
            width,
            height,
            margin,
        ));
    }

    #[test]
    fn tactical_position_near_world_edge_ignores_tiny_spaces() {
        assert!(!tactical_position_near_world_edge(
            NavPosition::new(1_000, 1_000),
            10_000,
            10_000,
            5_000,
        ));
    }
}
