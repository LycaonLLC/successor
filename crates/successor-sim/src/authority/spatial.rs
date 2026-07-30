//! Authority coordinates, collision geometry, cover, and spatial builders.

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuthorityPosition {
    pub(super) x: i32,
    pub(super) y: i32,
}

impl AuthorityPosition {
    pub(super) const fn from_cell(cell: AuthorityCell) -> Self {
        Self {
            x: cell.x * MILLI_CELLS_PER_CELL,
            y: cell.y * MILLI_CELLS_PER_CELL,
        }
    }

    pub(super) fn from_world(x: f64, y: f64) -> Option<Self> {
        if !x.is_finite() || !y.is_finite() {
            return None;
        }
        let x = (x * f64::from(MILLI_CELLS_PER_CELL)).round();
        let y = (y * f64::from(MILLI_CELLS_PER_CELL)).round();
        if x < f64::from(i32::MIN)
            || x > f64::from(i32::MAX)
            || y < f64::from(i32::MIN)
            || y > f64::from(i32::MAX)
        {
            return None;
        }
        Some(Self {
            x: x as i32,
            y: y as i32,
        })
    }

    pub(super) fn offset(self, dx: i32, dy: i32, distance_milli: i32) -> Self {
        let (offset_x, offset_y) = movement_delta_milli(dx, dy, distance_milli);
        Self {
            x: self.x.saturating_add(offset_x),
            y: self.y.saturating_add(offset_y),
        }
    }

    pub(super) fn clamp_to_area(self, area: &AreaAuthorityState) -> Self {
        let max_x = i32::try_from(area.width)
            .unwrap_or(i32::MAX / MILLI_CELLS_PER_CELL)
            .saturating_sub(2)
            .max(1)
            .saturating_mul(MILLI_CELLS_PER_CELL);
        let max_y = i32::try_from(area.height)
            .unwrap_or(i32::MAX / MILLI_CELLS_PER_CELL)
            .saturating_sub(2)
            .max(1)
            .saturating_mul(MILLI_CELLS_PER_CELL);
        Self {
            x: self.x.clamp(MILLI_CELLS_PER_CELL, max_x),
            y: self.y.clamp(MILLI_CELLS_PER_CELL, max_y),
        }
    }

    pub(super) const fn cell(self) -> AuthorityCell {
        AuthorityCell::new(
            self.x.div_euclid(MILLI_CELLS_PER_CELL),
            self.y.div_euclid(MILLI_CELLS_PER_CELL),
        )
    }

    pub(super) fn world_x(self) -> f64 {
        f64::from(self.x) / f64::from(MILLI_CELLS_PER_CELL)
    }

    pub(super) fn world_y(self) -> f64 {
        f64::from(self.y) / f64::from(MILLI_CELLS_PER_CELL)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct AuthorityActorHitBox {
    pub(super) left: i32,
    pub(super) right: i32,
    pub(super) top: i32,
    pub(super) bottom: i32,
}

impl AuthorityActorHitBox {
    pub(super) const fn center(self) -> AuthorityPosition {
        AuthorityPosition {
            x: (self.left + self.right) / 2,
            y: (self.top + self.bottom) / 2,
        }
    }

    pub(super) const fn intersects(self, other: AuthorityActorHitBox) -> bool {
        self.left < other.right
            && self.right > other.left
            && self.top < other.bottom
            && self.bottom > other.top
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct AuthorityCell {
    pub(super) x: i32,
    pub(super) y: i32,
}

impl AuthorityCell {
    pub(super) const fn new(x: i32, y: i32) -> Self {
        Self { x, y }
    }

    pub(super) fn from_snapshot(
        cell: &CellSnapshot,
        field: &'static str,
    ) -> Result<Self, SliceAuthorityBuildError> {
        Ok(Self {
            x: number_to_i32(&cell.x, field)?,
            y: number_to_i32(&cell.y, field)?,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub(super) struct CellKey {
    pub(super) area_id: String,
    pub(super) x: i32,
    pub(super) y: i32,
}

impl CellKey {
    pub(super) fn new(area_id: &str, x: i32, y: i32) -> Self {
        Self {
            area_id: area_id.to_owned(),
            x,
            y,
        }
    }
}

pub(super) fn number_to_i32(
    number: &serde_json::Number,
    field: &'static str,
) -> Result<i32, SliceAuthorityBuildError> {
    let Some(value) = number.as_i64() else {
        return Err(SliceAuthorityBuildError::InvalidCellCoordinate { field });
    };
    i32::try_from(value).map_err(|_| SliceAuthorityBuildError::InvalidCellCoordinate { field })
}

pub(super) fn movement_distance_milli(
    duration_ticks: u16,
    tick_rate_hz: u32,
    movement_speed_multiplier_milli: i32,
) -> i32 {
    let hz = tick_rate_hz.max(1);
    let speed = scaled_milli(
        PLAYER_SPEED_MILLI_CELLS_PER_SECOND,
        movement_speed_multiplier_milli,
    );
    let distance = i64::from(speed).saturating_mul(i64::from(duration_ticks)) / i64::from(hz);
    i32::try_from(distance).unwrap_or(i32::MAX)
}

pub(super) fn valid_move_vector(dx: i32, dy: i32) -> bool {
    matches!(dx, -1..=1) && matches!(dy, -1..=1) && (dx != 0 || dy != 0)
}

pub(super) fn movement_delta_milli(dx: i32, dy: i32, distance_milli: i32) -> (i32, i32) {
    if !valid_move_vector(dx, dy) || distance_milli <= 0 {
        return (0, 0);
    }
    if dx != 0 && dy != 0 {
        let component = ((i64::from(distance_milli) * DIAGONAL_MOVE_COMPONENT_MILLI) + 500) / 1_000;
        let component = i32::try_from(component).unwrap_or(i32::MAX);
        return (dx.saturating_mul(component), dy.saturating_mul(component));
    }
    (
        dx.saturating_mul(distance_milli),
        dy.saturating_mul(distance_milli),
    )
}

pub(super) fn route_cells_from_snapshot(
    route: &[CellSnapshot],
) -> Result<Vec<AuthorityCell>, SliceAuthorityBuildError> {
    route
        .iter()
        .map(|cell| AuthorityCell::from_snapshot(cell, "actor.route"))
        .collect()
}

pub(super) fn route_index_after_cell(route: &[AuthorityCell], cell: AuthorityCell) -> usize {
    route.iter().position(|point| *point != cell).unwrap_or(0)
}

pub(super) fn route_step_toward(origin: AuthorityCell, target: AuthorityCell) -> (i32, i32) {
    let dx = (target.x - origin.x).signum();
    if dx != 0 {
        return (dx, 0);
    }
    (0, (target.y - origin.y).signum())
}

pub(super) fn route_patrol_axis_target(
    current: AuthorityPosition,
    target: AuthorityPosition,
) -> AuthorityPosition {
    if current.x.abs_diff(target.x) > 1 {
        return AuthorityPosition {
            x: target.x,
            y: current.y,
        };
    }
    if current.y.abs_diff(target.y) > 1 {
        return AuthorityPosition {
            x: current.x,
            y: target.y,
        };
    }
    target
}

pub(super) fn target_cell_from_job(job: &NpcJobSnapshot) -> Option<AuthorityCell> {
    let cell = job.target_cell.as_ref()?;
    let x = i32::try_from(cell.x.as_i64()?).ok()?;
    let y = i32::try_from(cell.y.as_i64()?).ok()?;
    Some(AuthorityCell::new(x, y))
}

pub(super) fn npc_job_terminal_state(kind: &str) -> &'static str {
    match kind {
        "combat_watch" => "watching",
        "trade_idle" => "reserved",
        _ => "working",
    }
}

pub(super) fn average_actor_position(actors: &[ActorAuthorityState]) -> AuthorityPosition {
    if actors.is_empty() {
        return AuthorityPosition { x: 0, y: 0 };
    }
    let mut x = 0_i64;
    let mut y = 0_i64;
    for actor in actors {
        x = x.saturating_add(i64::from(actor.position.x));
        y = y.saturating_add(i64::from(actor.position.y));
    }
    let count = i64::try_from(actors.len()).unwrap_or(1).max(1);
    AuthorityPosition {
        x: (x / count).clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        y: (y / count).clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
    }
}

pub(super) fn normalize_components_milli(x_milli: i32, y_milli: i32) -> Option<(i32, i32)> {
    let distance = distance_milli_components(x_milli, y_milli);
    if distance <= 0 {
        return None;
    }
    Some((
        scaled_axis_delta(x_milli, AIM_VECTOR_SCALE_MILLI, distance),
        scaled_axis_delta(y_milli, AIM_VECTOR_SCALE_MILLI, distance),
    ))
}

pub(super) fn projected_actor_width_milli(
    actors: &[ActorAuthorityState],
    origin: AuthorityPosition,
    axis_x_milli: i32,
    axis_y_milli: i32,
) -> i32 {
    let Some(first) = actors.first() else {
        return 0;
    };
    let mut min = project_position_milli(first.position, origin, axis_x_milli, axis_y_milli);
    let mut max = min;
    for actor in &actors[1..] {
        let value = project_position_milli(actor.position, origin, axis_x_milli, axis_y_milli);
        min = min.min(value);
        max = max.max(value);
    }
    max.saturating_sub(min)
}

pub(super) fn skirmisher_actor_strength_milli(actor: &ActorAuthorityState) -> i32 {
    let max_total = actor
        .max_vitals
        .health
        .saturating_add(actor.max_vitals.action)
        .saturating_add(actor.max_vitals.spirit)
        .max(1);
    let total = actor
        .vitals
        .health
        .max(0)
        .saturating_add(actor.vitals.action.max(0))
        .saturating_add(actor.vitals.spirit.max(0));
    let vitality = i64::from(total).saturating_mul(1_000) / i64::from(max_total);
    let suppression_penalty = i64::from(actor.suppression.pressure_milli.max(0) / 80);
    (vitality - suppression_penalty)
        .clamp(100, 1_250)
        .try_into()
        .unwrap_or(100)
}

pub(super) fn skirmisher_enemy_pressure_strength_milli(actor: &ActorAuthorityState) -> i32 {
    if skirmisher_enemy_applies_ranged_pressure(actor) {
        skirmisher_actor_strength_milli(actor)
    } else {
        0
    }
}

pub(super) fn skirmisher_enemy_applies_ranged_pressure(actor: &ActorAuthorityState) -> bool {
    actor_uses_combat_tactics(actor)
        || (is_player_like_role(&actor.role)
            && actor_has_capability(actor, AUTHORITY_CAPABILITY_COMBAT_RANGED_BASIC))
}

pub(super) fn skirmisher_confidence(
    strength_milli: i32,
    enemy_strength_milli: i32,
) -> SkirmisherConfidence {
    if enemy_strength_milli <= 0 {
        return SkirmisherConfidence::Heroic;
    }
    let ratio = i64::from(strength_milli.max(0)).saturating_mul(1_000)
        / i64::from(enemy_strength_milli.max(1));
    match ratio {
        0..=599 => SkirmisherConfidence::Panicked,
        600..=849 => SkirmisherConfidence::Worried,
        850..=1_249 => SkirmisherConfidence::Neutral,
        1_250..=1_699 => SkirmisherConfidence::Confident,
        _ => SkirmisherConfidence::Heroic,
    }
}

pub(super) fn skirmisher_order_for_confidence(
    confidence: SkirmisherConfidence,
) -> SkirmisherSquadOrder {
    match confidence {
        SkirmisherConfidence::Panicked => SkirmisherSquadOrder::Retreat,
        SkirmisherConfidence::Worried | SkirmisherConfidence::Neutral => {
            SkirmisherSquadOrder::Defend
        }
        SkirmisherConfidence::Confident | SkirmisherConfidence::Heroic => {
            SkirmisherSquadOrder::Advance
        }
    }
}

pub(super) fn lane_center_offset_milli(index: usize, count: usize, front_width_milli: i32) -> i32 {
    if count <= 1 {
        return 0;
    }
    let count_i32 = i32::try_from(count).unwrap_or(i32::MAX / 4).max(1);
    let index_i32 = i32::try_from(index).unwrap_or(i32::MAX / 4);
    let slot_width = (front_width_milli / count_i32).max(SKIRMISHER_LANE_WIDTH_MILLI_CELLS);
    let span = slot_width.saturating_mul(count_i32.saturating_sub(1));
    index_i32
        .saturating_mul(slot_width)
        .saturating_sub(span / 2)
}

pub(super) fn project_position_milli(
    position: AuthorityPosition,
    origin: AuthorityPosition,
    axis_x_milli: i32,
    axis_y_milli: i32,
) -> i32 {
    project_tactical_position_milli(TacticalProjectionRequest {
        position: tactical_point_from_authority_position(position),
        origin: tactical_point_from_authority_position(origin),
        axis_x_milli,
        axis_y_milli,
    })
}

pub(super) fn build_fine_collision_bounds(
    props: &[crate::PropSnapshot],
    areas: &BTreeMap<String, AreaAuthorityState>,
) -> Result<Vec<FineCollisionBoundsAuthorityState>, SliceAuthorityBuildError> {
    let mut bounds = Vec::new();
    for prop in props {
        if prop.collision_bounds.is_empty() {
            continue;
        }
        let Some(area) = areas.get(&prop.area_id) else {
            continue;
        };
        let cell = AuthorityCell::from_snapshot(&prop.cell, "prop.cell")?;
        let prop_left = cell.x.saturating_mul(MILLI_CELLS_PER_CELL);
        let prop_top = cell.y.saturating_mul(MILLI_CELLS_PER_CELL);
        let prop_width = i32::try_from(prop.size.w.min(area.width.max(1)))
            .unwrap_or(i32::MAX)
            .max(1)
            .saturating_mul(MILLI_CELLS_PER_CELL);
        let prop_height = i32::try_from(prop.size.h.min(area.height.max(1)))
            .unwrap_or(i32::MAX)
            .max(1)
            .saturating_mul(MILLI_CELLS_PER_CELL);
        let area_right = i32::try_from(area.width)
            .unwrap_or(i32::MAX)
            .saturating_mul(MILLI_CELLS_PER_CELL);
        let area_bottom = i32::try_from(area.height)
            .unwrap_or(i32::MAX)
            .saturating_mul(MILLI_CELLS_PER_CELL);
        for bound in &prop.collision_bounds {
            let local_left = bound.x_milli.clamp(0, prop_width);
            let local_top = bound.y_milli.clamp(0, prop_height);
            let local_right = local_left
                .saturating_add(bound.w_milli.max(0))
                .clamp(0, prop_width);
            let local_bottom = local_top
                .saturating_add(bound.h_milli.max(0))
                .clamp(0, prop_height);
            let left = prop_left.saturating_add(local_left).clamp(0, area_right);
            let top = prop_top.saturating_add(local_top).clamp(0, area_bottom);
            let right = prop_left.saturating_add(local_right).clamp(0, area_right);
            let bottom = prop_top.saturating_add(local_bottom).clamp(0, area_bottom);
            if right <= left || bottom <= top {
                continue;
            }
            bounds.push(FineCollisionBoundsAuthorityState {
                prop_id: prop.id.clone(),
                area_id: prop.area_id.clone(),
                left,
                right,
                top,
                bottom,
            });
        }
    }
    Ok(bounds)
}

pub(super) fn build_door_collision_bounds(
    props: &[crate::PropSnapshot],
    areas: &BTreeMap<String, AreaAuthorityState>,
) -> Result<Vec<DoorCollisionBoundsAuthorityState>, SliceAuthorityBuildError> {
    let mut bounds = Vec::new();
    for prop in props {
        let Some(door) = prop.door.as_ref() else {
            continue;
        };
        let Some(area) = areas.get(&prop.area_id) else {
            continue;
        };
        let cell = AuthorityCell::from_snapshot(&prop.cell, "prop.cell")?;
        let prop_left = cell.x.saturating_mul(MILLI_CELLS_PER_CELL);
        let prop_top = cell.y.saturating_mul(MILLI_CELLS_PER_CELL);
        let prop_width = i32::try_from(prop.size.w.min(area.width.max(1)))
            .unwrap_or(i32::MAX)
            .max(1)
            .saturating_mul(MILLI_CELLS_PER_CELL);
        let prop_height = i32::try_from(prop.size.h.min(area.height.max(1)))
            .unwrap_or(i32::MAX)
            .max(1)
            .saturating_mul(MILLI_CELLS_PER_CELL);
        let area_right = i32::try_from(area.width)
            .unwrap_or(i32::MAX)
            .saturating_mul(MILLI_CELLS_PER_CELL);
        let area_bottom = i32::try_from(area.height)
            .unwrap_or(i32::MAX)
            .saturating_mul(MILLI_CELLS_PER_CELL);
        let local_left = door.blocker.x_milli.clamp(0, prop_width);
        let local_top = door.blocker.y_milli.clamp(0, prop_height);
        let local_right = local_left
            .saturating_add(door.blocker.w_milli.max(0))
            .clamp(0, prop_width);
        let local_bottom = local_top
            .saturating_add(door.blocker.h_milli.max(0))
            .clamp(0, prop_height);
        let left = prop_left.saturating_add(local_left).clamp(0, area_right);
        let top = prop_top.saturating_add(local_top).clamp(0, area_bottom);
        let right = prop_left.saturating_add(local_right).clamp(0, area_right);
        let bottom = prop_top.saturating_add(local_bottom).clamp(0, area_bottom);
        if right <= left || bottom <= top {
            continue;
        }
        bounds.push(DoorCollisionBoundsAuthorityState {
            prop_id: prop.id.clone(),
            area_id: prop.area_id.clone(),
            left,
            right,
            top,
            bottom,
            open: false,
        });
    }
    Ok(bounds)
}

pub(super) fn build_ai_clearance_blocked_cells(
    areas: &BTreeMap<String, AreaAuthorityState>,
    blocked_cells: &BTreeSet<CellKey>,
    fine_collision_bounds: &[FineCollisionBoundsAuthorityState],
) -> BTreeSet<CellKey> {
    let mut clearance = BTreeSet::new();
    for area in areas.values() {
        let width = i32::try_from(area.width).unwrap_or(0).max(0);
        let height = i32::try_from(area.height).unwrap_or(0).max(0);
        let area_bounds = fine_collision_bounds
            .iter()
            .filter(|bounds| bounds.area_id == area.id)
            .collect::<Vec<_>>();
        for y in 0..height {
            for x in 0..width {
                let cell = AuthorityCell::new(x, y);
                let key = CellKey::new(&area.id, x, y);
                if blocked_cells.contains(&key) {
                    clearance.insert(key);
                    continue;
                }
                let body = ai_clearance_hit_box_for_cell(cell);
                let blocked_by_static_cell = blocked_cells.iter().any(|blocked| {
                    blocked.area_id == area.id
                        && body.intersects(cell_hit_box(blocked.x, blocked.y))
                });
                if blocked_by_static_cell
                    || area_bounds
                        .iter()
                        .any(|bounds| body.intersects(bounds.hit_box()))
                {
                    clearance.insert(key);
                }
            }
        }
    }
    clearance
}

pub(super) fn build_door_clearance_blocked_cells_by_prop(
    areas: &BTreeMap<String, AreaAuthorityState>,
    door_collision_bounds: &[DoorCollisionBoundsAuthorityState],
) -> BTreeMap<String, BTreeSet<CellKey>> {
    let mut by_prop = BTreeMap::new();
    for door in door_collision_bounds {
        if door.open {
            continue;
        }
        let cells = door_clearance_blocked_cells_for_bound(areas, door);
        if !cells.is_empty() {
            by_prop.insert(door.prop_id.clone(), cells);
        }
    }
    by_prop
}

pub(super) fn door_clearance_blocked_cells_for_bound(
    areas: &BTreeMap<String, AreaAuthorityState>,
    door: &DoorCollisionBoundsAuthorityState,
) -> BTreeSet<CellKey> {
    let mut cells = BTreeSet::new();
    let Some(area) = areas.get(&door.area_id) else {
        return cells;
    };
    let width = i32::try_from(area.width).unwrap_or(0).max(0);
    let height = i32::try_from(area.height).unwrap_or(0).max(0);
    let door_box = door.hit_box();
    for y in 0..height {
        for x in 0..width {
            let cell = AuthorityCell::new(x, y);
            if ai_clearance_hit_box_for_cell(cell).intersects(door_box) {
                cells.insert(CellKey::new(&area.id, x, y));
            }
        }
    }
    cells
}

pub(super) fn ai_clearance_hit_box_for_cell(cell: AuthorityCell) -> AuthorityActorHitBox {
    expand_actor_hit_box(
        actor_hit_box_for_position(AuthorityPosition::from_cell(cell), 1, false),
        AI_OBSTACLE_CLEARANCE_MILLI_CELLS,
    )
}

pub(super) fn cell_hit_box(x: i32, y: i32) -> AuthorityActorHitBox {
    let left = x.saturating_mul(MILLI_CELLS_PER_CELL);
    let top = y.saturating_mul(MILLI_CELLS_PER_CELL);
    AuthorityActorHitBox {
        left,
        right: left.saturating_add(MILLI_CELLS_PER_CELL),
        top,
        bottom: top.saturating_add(MILLI_CELLS_PER_CELL),
    }
}

pub(super) fn build_cover_points(
    props: &[crate::PropSnapshot],
    areas: &BTreeMap<String, AreaAuthorityState>,
    blocked_cells: &BTreeSet<CellKey>,
    fine_collision_bounds: &[FineCollisionBoundsAuthorityState],
) -> Result<Vec<CoverPointAuthorityState>, SliceAuthorityBuildError> {
    let mut points = Vec::new();
    for prop in props {
        let Some(cover) = prop.cover.as_ref() else {
            continue;
        };
        if cover.rating == 0 {
            continue;
        }
        let Some(area) = areas.get(&prop.area_id) else {
            continue;
        };
        let cell = AuthorityCell::from_snapshot(&prop.cell, "prop.cell")?;
        let width = i32::try_from(prop.size.w.min(area.width.max(1)))
            .unwrap_or(i32::MAX)
            .max(1);
        let height = i32::try_from(prop.size.h.min(area.height.max(1)))
            .unwrap_or(i32::MAX)
            .max(1);
        let rating_milli = i32::from(cover.rating.clamp(1, 100)).saturating_mul(10);
        let high = cover.height.eq_ignore_ascii_case("high");
        let fine_bounds = fine_collision_bounds
            .iter()
            .filter(|bounds| bounds.prop_id == prop.id && bounds.area_id == prop.area_id)
            .collect::<Vec<_>>();
        if fine_bounds.is_empty() {
            push_cover_points_for_bounds(
                &mut points,
                prop,
                area,
                blocked_cells,
                cell.x.saturating_mul(MILLI_CELLS_PER_CELL),
                cell.x
                    .saturating_add(width)
                    .saturating_mul(MILLI_CELLS_PER_CELL),
                cell.y.saturating_mul(MILLI_CELLS_PER_CELL),
                cell.y
                    .saturating_add(height)
                    .saturating_mul(MILLI_CELLS_PER_CELL),
                rating_milli,
                high,
            );
        } else {
            for bounds in fine_bounds {
                push_cover_points_for_bounds(
                    &mut points,
                    prop,
                    area,
                    blocked_cells,
                    bounds.left,
                    bounds.right,
                    bounds.top,
                    bounds.bottom,
                    rating_milli,
                    high,
                );
            }
        }
    }
    Ok(points)
}

pub(super) fn build_exchange_containers(
    props: &[PropSnapshot],
    areas: &BTreeMap<String, AreaAuthorityState>,
) -> Result<Vec<ExchangeContainerAuthorityState>, SliceAuthorityBuildError> {
    let mut containers = Vec::new();
    for prop in props {
        if !is_exchange_container_prop(prop) {
            continue;
        }
        let Some(area) = areas.get(&prop.area_id) else {
            return Err(SliceAuthorityBuildError::UnknownExchangeContainerArea {
                prop_id: prop.id.clone(),
                area_id: prop.area_id.clone(),
            });
        };
        let cell = AuthorityCell::from_snapshot(&prop.cell, "prop.cell")?;
        if !area.contains(cell) {
            return Err(SliceAuthorityBuildError::ExchangeContainerOutOfBounds {
                prop_id: prop.id.clone(),
                area_id: prop.area_id.clone(),
                x: cell.x,
                y: cell.y,
            });
        }
        let width = i32::try_from(prop.size.w.min(area.width.max(1)))
            .unwrap_or(i32::MAX)
            .max(1);
        let height = i32::try_from(prop.size.h.min(area.height.max(1)))
            .unwrap_or(i32::MAX)
            .max(1);
        let (owner_actor_id, allowed_actor_ids, allowed_faction_ids) =
            exchange_container_permissions(prop);
        let left_milli = cell.x.saturating_mul(MILLI_CELLS_PER_CELL);
        let top_milli = cell.y.saturating_mul(MILLI_CELLS_PER_CELL);
        let right_milli = left_milli.saturating_add(width.saturating_mul(MILLI_CELLS_PER_CELL));
        let bottom_milli = top_milli.saturating_add(height.saturating_mul(MILLI_CELLS_PER_CELL));
        let half_extent_milli = width.max(height).saturating_mul(MILLI_CELLS_PER_CELL) / 2;
        containers.push(ExchangeContainerAuthorityState {
            prop_id: prop.id.clone(),
            area_id: prop.area_id.clone(),
            position: AuthorityPosition {
                x: left_milli.saturating_add(width.saturating_mul(MILLI_CELLS_PER_CELL) / 2),
                y: top_milli.saturating_add(height.saturating_mul(MILLI_CELLS_PER_CELL) / 2),
            },
            cell,
            left_milli,
            right_milli,
            top_milli,
            bottom_milli,
            interaction_radius_milli: EXCHANGE_INTERACTION_RADIUS_MILLI_CELLS
                .saturating_add(half_extent_milli),
            owner_actor_id,
            allowed_actor_ids,
            allowed_faction_ids,
        });
    }
    Ok(containers)
}

pub(super) fn build_loot_caches(
    props: &[PropSnapshot],
    areas: &BTreeMap<String, AreaAuthorityState>,
) -> Result<BTreeMap<String, LootCacheAuthorityState>, SliceAuthorityBuildError> {
    let mut caches = BTreeMap::new();
    for prop in props {
        if !is_loot_cache_prop(prop) {
            continue;
        }
        let Some(area) = areas.get(&prop.area_id) else {
            return Err(SliceAuthorityBuildError::UnknownLootCacheArea {
                prop_id: prop.id.clone(),
                area_id: prop.area_id.clone(),
            });
        };
        let cell = AuthorityCell::from_snapshot(&prop.cell, "prop.cell")?;
        if !area.contains(cell) {
            return Err(SliceAuthorityBuildError::LootCacheOutOfBounds {
                prop_id: prop.id.clone(),
                area_id: prop.area_id.clone(),
                x: cell.x,
                y: cell.y,
            });
        }
        let width = i32::try_from(prop.size.w.min(area.width.max(1)))
            .unwrap_or(i32::MAX)
            .max(1);
        let height = i32::try_from(prop.size.h.min(area.height.max(1)))
            .unwrap_or(i32::MAX)
            .max(1);
        caches.insert(
            prop.id.clone(),
            LootCacheAuthorityState {
                prop_id: prop.id.clone(),
                area_id: prop.area_id.clone(),
                position: AuthorityPosition {
                    x: cell
                        .x
                        .saturating_mul(MILLI_CELLS_PER_CELL)
                        .saturating_add(width.saturating_mul(MILLI_CELLS_PER_CELL) / 2),
                    y: cell
                        .y
                        .saturating_mul(MILLI_CELLS_PER_CELL)
                        .saturating_add(height.saturating_mul(MILLI_CELLS_PER_CELL) / 2),
                },
                cell,
                container: prop
                    .container
                    .clone()
                    .unwrap_or_else(|| format!("cache:{}", prop.id)),
                interaction_radius_milli: HARVEST_INTERACTION_RADIUS_MILLI_CELLS,
                emptied: false,
            },
        );
    }
    Ok(caches)
}

pub(super) fn is_loot_cache_prop(prop: &PropSnapshot) -> bool {
    let entity = prop.entity.to_ascii_lowercase();
    let id = prop.id.to_ascii_lowercase();
    let kind = prop.kind.to_ascii_lowercase();
    prop.interactive
        && (kind == "storage_chest"
            || entity.starts_with("cache:")
            || entity.starts_with("loot-cache:")
            || id.contains("cache"))
}

pub(super) fn is_exchange_container_prop(prop: &PropSnapshot) -> bool {
    let entity = prop.entity.to_ascii_lowercase();
    let id = prop.id.to_ascii_lowercase();
    let kind = prop.kind.to_ascii_lowercase();
    entity.starts_with("container:district-exchange")
        || entity.starts_with("container:district_exchange")
        || id.contains("district-exchange")
        || id.contains("district_exchange")
        || (kind == "resource_container" && entity.contains("district-exchange"))
        || (kind == "resource_container" && entity.contains("district_exchange"))
}

pub(super) fn exchange_container_permissions(
    prop: &PropSnapshot,
) -> (Option<String>, BTreeSet<String>, BTreeSet<String>) {
    let mut owner_actor_id = None;
    let mut allowed_actor_ids = BTreeSet::new();
    let mut allowed_faction_ids = BTreeSet::new();
    for token in prop.entity.split(':').skip(2) {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        if let Some(value) = token.strip_prefix("owner=") {
            let owner = value.trim();
            if !owner.is_empty() {
                owner_actor_id = Some(owner.to_owned());
            }
            continue;
        }
        if let Some(value) = token.strip_prefix("allow=") {
            for actor_id in value
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                allowed_actor_ids.insert(actor_id.to_owned());
            }
            continue;
        }
        if let Some(value) = token.strip_prefix("faction=") {
            for faction_id in value
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                allowed_faction_ids.insert(faction_id.to_owned());
            }
            continue;
        }
        if token.contains('_') {
            allowed_faction_ids.insert(token.to_owned());
        } else {
            allowed_actor_ids.insert(token.to_owned());
        }
    }
    (owner_actor_id, allowed_actor_ids, allowed_faction_ids)
}

pub(super) fn build_ammo_stockpiles(
    props: &[PropSnapshot],
    areas: &BTreeMap<String, AreaAuthorityState>,
) -> Result<Vec<AmmoStockpileAuthorityState>, SliceAuthorityBuildError> {
    let mut stockpiles = Vec::new();
    for prop in props {
        if !is_ammo_stockpile_prop(prop) {
            continue;
        }
        let Some(area) = areas.get(&prop.area_id) else {
            return Err(SliceAuthorityBuildError::UnknownAmmoStockpileArea {
                prop_id: prop.id.clone(),
                area_id: prop.area_id.clone(),
            });
        };
        let cell = AuthorityCell::from_snapshot(&prop.cell, "prop.cell")?;
        if !area.contains(cell) {
            return Err(SliceAuthorityBuildError::AmmoStockpileOutOfBounds {
                prop_id: prop.id.clone(),
                area_id: prop.area_id.clone(),
                x: cell.x,
                y: cell.y,
            });
        }
        let width = i32::try_from(prop.size.w.min(area.width.max(1)))
            .unwrap_or(i32::MAX)
            .max(1);
        let height = i32::try_from(prop.size.h.min(area.height.max(1)))
            .unwrap_or(i32::MAX)
            .max(1);
        stockpiles.push(AmmoStockpileAuthorityState {
            prop_id: prop.id.clone(),
            area_id: prop.area_id.clone(),
            position: AuthorityPosition {
                x: cell
                    .x
                    .saturating_mul(MILLI_CELLS_PER_CELL)
                    .saturating_add(width.saturating_mul(MILLI_CELLS_PER_CELL) / 2),
                y: cell
                    .y
                    .saturating_mul(MILLI_CELLS_PER_CELL)
                    .saturating_add(height.saturating_mul(MILLI_CELLS_PER_CELL) / 2),
            },
            cell,
            container: format!("{}:ammo-stockpile", prop.id),
            faction_id: ammo_stockpile_faction(prop),
            item_id: AMMO_SLUG_IRON_ITEM_ID,
            quantity: AMMO_REFILL_BATCH_QUANTITY,
        });
    }
    Ok(stockpiles)
}

pub(super) fn is_ammo_stockpile_prop(prop: &PropSnapshot) -> bool {
    let entity = prop.entity.to_ascii_lowercase();
    let id = prop.id.to_ascii_lowercase();
    entity.starts_with("stockpile:ammo") || id.contains("ammo-stockpile")
}

pub(super) fn ammo_stockpile_faction(prop: &PropSnapshot) -> Option<String> {
    let entity = prop.entity.trim();
    entity
        .strip_prefix("stockpile:ammo:")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

pub(super) fn stockpile_allows_actor(
    stockpile: &AmmoStockpileAuthorityState,
    actor: &ActorAuthorityState,
) -> bool {
    stockpile
        .faction_id
        .as_deref()
        .is_none_or(|faction_id| actor.faction.faction_id.as_deref() == Some(faction_id))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn push_cover_points_for_bounds(
    points: &mut Vec<CoverPointAuthorityState>,
    prop: &crate::PropSnapshot,
    area: &AreaAuthorityState,
    blocked_cells: &BTreeSet<CellKey>,
    left_milli: i32,
    right_milli: i32,
    top_milli: i32,
    bottom_milli: i32,
    rating_milli: i32,
    high: bool,
) {
    if right_milli <= left_milli || bottom_milli <= top_milli {
        return;
    }
    let left_cell = left_milli.div_euclid(MILLI_CELLS_PER_CELL);
    let top_cell = top_milli.div_euclid(MILLI_CELLS_PER_CELL);
    let right_cell = div_ceil_i32(right_milli, MILLI_CELLS_PER_CELL).max(left_cell + 1);
    let bottom_cell = div_ceil_i32(bottom_milli, MILLI_CELLS_PER_CELL).max(top_cell + 1);
    let area_width = i32::try_from(area.width).unwrap_or(i32::MAX);
    let area_height = i32::try_from(area.height).unwrap_or(i32::MAX);

    for x in left_cell.max(0)..right_cell.min(area_width) {
        push_cover_point(
            points,
            prop,
            area,
            blocked_cells,
            AuthorityCell::new(x, top_cell.saturating_sub(1)),
            CoverSide::North,
            rating_milli,
            high,
            left_milli,
            right_milli,
            top_milli,
            bottom_milli,
        );
        push_cover_point(
            points,
            prop,
            area,
            blocked_cells,
            AuthorityCell::new(x, bottom_cell),
            CoverSide::South,
            rating_milli,
            high,
            left_milli,
            right_milli,
            top_milli,
            bottom_milli,
        );
    }
    for y in top_cell.max(0)..bottom_cell.min(area_height) {
        push_cover_point(
            points,
            prop,
            area,
            blocked_cells,
            AuthorityCell::new(left_cell.saturating_sub(1), y),
            CoverSide::West,
            rating_milli,
            high,
            left_milli,
            right_milli,
            top_milli,
            bottom_milli,
        );
        push_cover_point(
            points,
            prop,
            area,
            blocked_cells,
            AuthorityCell::new(right_cell, y),
            CoverSide::East,
            rating_milli,
            high,
            left_milli,
            right_milli,
            top_milli,
            bottom_milli,
        );
    }
    if high {
        push_high_cover_shadow_points(
            points,
            prop,
            area,
            blocked_cells,
            left_cell,
            right_cell,
            top_cell,
            bottom_cell,
            rating_milli,
            left_milli,
            right_milli,
            top_milli,
            bottom_milli,
        );
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn push_high_cover_shadow_points(
    points: &mut Vec<CoverPointAuthorityState>,
    prop: &crate::PropSnapshot,
    area: &AreaAuthorityState,
    blocked_cells: &BTreeSet<CellKey>,
    left_cell: i32,
    right_cell: i32,
    top_cell: i32,
    bottom_cell: i32,
    rating_milli: i32,
    left_milli: i32,
    right_milli: i32,
    top_milli: i32,
    bottom_milli: i32,
) {
    for depth in 1..=HIGH_COVER_SHADOW_DEPTH_CELLS {
        for x in left_cell.saturating_sub(HIGH_COVER_SHADOW_LATERAL_PAD_CELLS)
            ..right_cell.saturating_add(HIGH_COVER_SHADOW_LATERAL_PAD_CELLS)
        {
            push_cover_point(
                points,
                prop,
                area,
                blocked_cells,
                AuthorityCell::new(x, top_cell.saturating_sub(depth)),
                CoverSide::North,
                rating_milli,
                true,
                left_milli,
                right_milli,
                top_milli,
                bottom_milli,
            );
            push_cover_point(
                points,
                prop,
                area,
                blocked_cells,
                AuthorityCell::new(x, bottom_cell.saturating_add(depth).saturating_sub(1)),
                CoverSide::South,
                rating_milli,
                true,
                left_milli,
                right_milli,
                top_milli,
                bottom_milli,
            );
        }
        for y in top_cell.saturating_sub(HIGH_COVER_SHADOW_LATERAL_PAD_CELLS)
            ..bottom_cell.saturating_add(HIGH_COVER_SHADOW_LATERAL_PAD_CELLS)
        {
            push_cover_point(
                points,
                prop,
                area,
                blocked_cells,
                AuthorityCell::new(left_cell.saturating_sub(depth), y),
                CoverSide::West,
                rating_milli,
                true,
                left_milli,
                right_milli,
                top_milli,
                bottom_milli,
            );
            push_cover_point(
                points,
                prop,
                area,
                blocked_cells,
                AuthorityCell::new(right_cell.saturating_add(depth).saturating_sub(1), y),
                CoverSide::East,
                rating_milli,
                true,
                left_milli,
                right_milli,
                top_milli,
                bottom_milli,
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn push_cover_point(
    points: &mut Vec<CoverPointAuthorityState>,
    prop: &crate::PropSnapshot,
    area: &AreaAuthorityState,
    blocked_cells: &BTreeSet<CellKey>,
    cell: AuthorityCell,
    side: CoverSide,
    rating_milli: i32,
    high: bool,
    prop_left: i32,
    prop_right: i32,
    prop_top: i32,
    prop_bottom: i32,
) {
    if !area.contains(cell)
        || blocked_cells.contains(&CellKey::new(&prop.area_id, cell.x, cell.y))
        || points.iter().any(|point| {
            point.prop_id == prop.id
                && point.area_id == prop.area_id
                && point.cell == cell
                && point.side == side
        })
    {
        return;
    }
    points.push(CoverPointAuthorityState {
        prop_id: prop.id.clone(),
        area_id: prop.area_id.clone(),
        position: AuthorityPosition::from_cell(cell),
        cell,
        side,
        rating_milli,
        high,
        prop_left,
        prop_right,
        prop_top,
        prop_bottom,
    });
}

pub(super) fn cover_point_protects_from_threat(
    point: &CoverPointAuthorityState,
    threat: AuthorityPosition,
) -> bool {
    let prop_center_x = point.prop_left.saturating_add(point.prop_right) / 2;
    let prop_center_y = point.prop_top.saturating_add(point.prop_bottom) / 2;
    let threat_x = threat.x.saturating_add(MILLI_CELLS_PER_CELL / 2);
    let threat_y = threat.y.saturating_add(MILLI_CELLS_PER_CELL / 2);
    let dx = threat_x.saturating_sub(prop_center_x);
    let dy = threat_y.saturating_sub(prop_center_y);
    if dx == 0 && dy == 0 {
        return true;
    }
    if dx.abs() >= dy.abs() {
        return if dx < 0 {
            point.side == CoverSide::East
        } else {
            point.side == CoverSide::West
        };
    }
    if dy < 0 {
        point.side == CoverSide::South
    } else {
        point.side == CoverSide::North
    }
}
