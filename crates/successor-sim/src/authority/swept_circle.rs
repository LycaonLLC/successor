//! Integer swept circle-vs-AABB resolver shared with the client-side predictor.
//!
//! The TypeScript mirror lives in `client/src/slice-core/movementSystem.ts`
//! (`resolveCircleMove`). Keep the constants and scenario table in these two
//! files aligned: player center is swept in milli-cells, radius is 300 milli,
//! skin is 2 milli, and at most three slide iterations are performed.

use std::cmp::Ordering;

pub(super) const CIRCLE_COLLISION_RADIUS_MILLI: i32 = 300;
pub(super) const CIRCLE_TRACE_SKIN_MILLI: i32 = 2;
const CIRCLE_DEPENETRATION_EPSILON_MILLI: i32 = 1;
const MAX_INITIAL_DEPENETRATION_ITERATIONS: usize = 4;
const MAX_TRACE_SLIDE_ITERATIONS: usize = 3;
const TOI_SCALE: i64 = 1_000_000;
const NORMAL_SCALE_MILLI: i32 = 1_000;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct CirclePoint {
    pub(super) x: i32,
    pub(super) y: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct CircleAabb {
    pub(super) left: i32,
    pub(super) top: i32,
    pub(super) right: i32,
    pub(super) bottom: i32,
}

impl CircleAabb {
    pub(super) const fn new(left: i32, top: i32, right: i32, bottom: i32) -> Self {
        Self {
            left,
            top,
            right,
            bottom,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RationalToi {
    num: i64,
    den: i64,
}

impl RationalToi {
    const ONE: Self = Self { num: 1, den: 1 };

    fn new(num: i64, den: i64) -> Self {
        debug_assert!(den > 0);
        Self { num, den }
    }

    fn cmp(self, other: Self) -> Ordering {
        (i128::from(self.num) * i128::from(other.den))
            .cmp(&(i128::from(other.num) * i128::from(self.den)))
    }

    fn ge(self, other: Self) -> bool {
        self.cmp(other) != Ordering::Less
    }

    fn scaled_floor(self) -> i64 {
        if self.num <= 0 {
            return 0;
        }
        if self.ge(Self::ONE) {
            return TOI_SCALE;
        }
        ((i128::from(self.num) * i128::from(TOI_SCALE)) / i128::from(self.den))
            .clamp(0, i128::from(TOI_SCALE)) as i64
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CircleTraceHit {
    t_scaled: i64,
    normal_x_milli: i32,
    normal_y_milli: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CircleOverlapPush {
    depth: i32,
    push_x: i32,
    push_y: i32,
}

/// Resolve a center sweep against stable-order AABB faces plus rounded corner caps.
///
/// TOI is represented as rational/fixed-point integer values: face hits use
/// exact rational slab times, corner hits solve the circle quadratic with
/// integer square roots, and the selected impact is projected onto a 1e6
/// fixed-point scale for the skin/slide step. This keeps comparisons
/// deterministic without floats while staying below the 2-milli parity
/// tolerance used by the client/Rust shared scenario table.
pub(super) fn resolve_circle_move_milli(
    origin: CirclePoint,
    delta_x: i32,
    delta_y: i32,
    radius_milli: i32,
    blockers: &[CircleAabb],
) -> CirclePoint {
    let mut position = origin;
    let radius_milli = radius_milli.max(0);
    if blockers.is_empty() {
        position.x = position.x.saturating_add(delta_x);
        position.y = position.y.saturating_add(delta_y);
        return position;
    }

    depenetrate_initial_circle_position(&mut position, radius_milli, blockers);

    let mut remaining_x = i64::from(delta_x);
    let mut remaining_y = i64::from(delta_y);
    for _ in 0..MAX_TRACE_SLIDE_ITERATIONS {
        let distance = integer_sqrt_ceil(
            remaining_x
                .saturating_mul(remaining_x)
                .saturating_add(remaining_y.saturating_mul(remaining_y)) as u64,
        ) as i64;
        if distance <= 0 {
            break;
        }
        let Some(hit) = trace_circle_against_blockers(
            position,
            remaining_x,
            remaining_y,
            radius_milli,
            blockers,
        ) else {
            position.x = saturating_i64_to_i32(i64::from(position.x).saturating_add(remaining_x));
            position.y = saturating_i64_to_i32(i64::from(position.y).saturating_add(remaining_y));
            break;
        };

        let t_scaled = hit.t_scaled;
        let skin_scaled = div_ceil_i64(i64::from(CIRCLE_TRACE_SKIN_MILLI) * TOI_SCALE, distance);
        let travel_scaled = t_scaled.saturating_sub(skin_scaled).clamp(0, TOI_SCALE);
        let travel_x = scale_i64(remaining_x, travel_scaled, TOI_SCALE);
        let travel_y = scale_i64(remaining_y, travel_scaled, TOI_SCALE);
        position.x = saturating_i64_to_i32(i64::from(position.x).saturating_add(travel_x));
        position.y = saturating_i64_to_i32(i64::from(position.y).saturating_add(travel_y));

        let leftover_scale = TOI_SCALE.saturating_sub(travel_scaled).clamp(0, TOI_SCALE);
        remaining_x = scale_i64(remaining_x, leftover_scale, TOI_SCALE);
        remaining_y = scale_i64(remaining_y, leftover_scale, TOI_SCALE);
        let normal_x = i64::from(hit.normal_x_milli);
        let normal_y = i64::from(hit.normal_y_milli);
        let normal_len_sq = normal_x
            .saturating_mul(normal_x)
            .saturating_add(normal_y.saturating_mul(normal_y))
            .max(1);
        let normal_dot = remaining_x
            .saturating_mul(normal_x)
            .saturating_add(remaining_y.saturating_mul(normal_y));
        if normal_dot < 0 {
            let remove_x = div_round_i128(
                i128::from(normal_x) * i128::from(normal_dot),
                i128::from(normal_len_sq),
            );
            let remove_y = div_round_i128(
                i128::from(normal_y) * i128::from(normal_dot),
                i128::from(normal_len_sq),
            );
            remaining_x = saturating_i128_to_i64(i128::from(remaining_x).saturating_sub(remove_x));
            remaining_y = saturating_i128_to_i64(i128::from(remaining_y).saturating_sub(remove_y));
        }
    }

    position
}

pub(super) fn circle_intersects_aabb(
    center: CirclePoint,
    radius_milli: i32,
    blocker: CircleAabb,
) -> bool {
    circle_aabb_overlap_push(center, radius_milli.max(0), blocker).is_some()
}

fn depenetrate_initial_circle_position(
    position: &mut CirclePoint,
    radius_milli: i32,
    blockers: &[CircleAabb],
) {
    for _ in 0..MAX_INITIAL_DEPENETRATION_ITERATIONS {
        let mut best: Option<CircleOverlapPush> = None;
        for blocker in blockers {
            let Some(push) = circle_aabb_overlap_push(*position, radius_milli, *blocker) else {
                continue;
            };
            if best.is_none_or(|candidate| push.depth > candidate.depth) {
                best = Some(push);
            }
        }
        let Some(push) = best else { break };
        if push.depth <= CIRCLE_DEPENETRATION_EPSILON_MILLI {
            break;
        }
        position.x = position.x.saturating_add(push.push_x);
        position.y = position.y.saturating_add(push.push_y);
    }
}

fn trace_circle_against_blockers(
    position: CirclePoint,
    dx: i64,
    dy: i64,
    radius_milli: i32,
    blockers: &[CircleAabb],
) -> Option<CircleTraceHit> {
    let mut best: Option<CircleTraceHit> = None;
    for blocker in blockers {
        let Some(hit) =
            sweep_segment_against_rounded_aabb(position, dx, dy, radius_milli, *blocker)
        else {
            continue;
        };
        if best.is_none_or(|candidate| hit.t_scaled < candidate.t_scaled) {
            best = Some(hit);
        }
    }
    best
}

fn sweep_segment_against_rounded_aabb(
    position: CirclePoint,
    dx: i64,
    dy: i64,
    radius_milli: i32,
    blocker: CircleAabb,
) -> Option<CircleTraceHit> {
    if let Some(hit) = overlapping_circle_trace_hit(position, dx, dy, radius_milli, blocker) {
        return Some(hit);
    }

    let mut best: Option<CircleTraceHit> = None;
    trace_vertical_face(
        &mut best,
        position,
        dx,
        dy,
        i64::from(blocker.left).saturating_sub(i64::from(radius_milli)),
        blocker.top,
        blocker.bottom,
        -NORMAL_SCALE_MILLI,
    );
    trace_vertical_face(
        &mut best,
        position,
        dx,
        dy,
        i64::from(blocker.right).saturating_add(i64::from(radius_milli)),
        blocker.top,
        blocker.bottom,
        NORMAL_SCALE_MILLI,
    );
    trace_horizontal_face(
        &mut best,
        position,
        dx,
        dy,
        i64::from(blocker.top).saturating_sub(i64::from(radius_milli)),
        blocker.left,
        blocker.right,
        -NORMAL_SCALE_MILLI,
    );
    trace_horizontal_face(
        &mut best,
        position,
        dx,
        dy,
        i64::from(blocker.bottom).saturating_add(i64::from(radius_milli)),
        blocker.left,
        blocker.right,
        NORMAL_SCALE_MILLI,
    );

    trace_corner(
        &mut best,
        position,
        dx,
        dy,
        radius_milli,
        blocker.left,
        blocker.top,
    );
    trace_corner(
        &mut best,
        position,
        dx,
        dy,
        radius_milli,
        blocker.right,
        blocker.top,
    );
    trace_corner(
        &mut best,
        position,
        dx,
        dy,
        radius_milli,
        blocker.left,
        blocker.bottom,
    );
    trace_corner(
        &mut best,
        position,
        dx,
        dy,
        radius_milli,
        blocker.right,
        blocker.bottom,
    );
    best
}

fn overlapping_circle_trace_hit(
    position: CirclePoint,
    dx: i64,
    dy: i64,
    radius_milli: i32,
    blocker: CircleAabb,
) -> Option<CircleTraceHit> {
    let push = circle_aabb_overlap_push(position, radius_milli, blocker)?;
    let (normal_x_milli, normal_y_milli) =
        normal_milli_from_vector(i128::from(push.push_x), i128::from(push.push_y));
    let normal_dot = dx
        .saturating_mul(i64::from(normal_x_milli))
        .saturating_add(dy.saturating_mul(i64::from(normal_y_milli)));
    if normal_dot >= 0 {
        return None;
    }
    Some(CircleTraceHit {
        t_scaled: 0,
        normal_x_milli,
        normal_y_milli,
    })
}

fn trace_vertical_face(
    best: &mut Option<CircleTraceHit>,
    position: CirclePoint,
    dx: i64,
    dy: i64,
    plane_x: i64,
    span_top: i32,
    span_bottom: i32,
    normal_x_milli: i32,
) {
    let den = if normal_x_milli < 0 { dx } else { -dx };
    if den <= 0 {
        return;
    }
    let x = i64::from(position.x);
    let t_num = if normal_x_milli < 0 {
        plane_x.saturating_sub(x)
    } else {
        x.saturating_sub(plane_x)
    };
    if t_num < 0 || t_num > den {
        return;
    }
    let contact_y_num =
        i128::from(position.y) * i128::from(den) + i128::from(dy) * i128::from(t_num);
    let top = i128::from(span_top) * i128::from(den);
    let bottom = i128::from(span_bottom) * i128::from(den);
    if contact_y_num < top || contact_y_num > bottom {
        return;
    }
    keep_earliest_hit(
        best,
        CircleTraceHit {
            t_scaled: RationalToi::new(t_num, den).scaled_floor(),
            normal_x_milli,
            normal_y_milli: 0,
        },
    );
}

fn trace_horizontal_face(
    best: &mut Option<CircleTraceHit>,
    position: CirclePoint,
    dx: i64,
    dy: i64,
    plane_y: i64,
    span_left: i32,
    span_right: i32,
    normal_y_milli: i32,
) {
    let den = if normal_y_milli < 0 { dy } else { -dy };
    if den <= 0 {
        return;
    }
    let y = i64::from(position.y);
    let t_num = if normal_y_milli < 0 {
        plane_y.saturating_sub(y)
    } else {
        y.saturating_sub(plane_y)
    };
    if t_num < 0 || t_num > den {
        return;
    }
    let contact_x_num =
        i128::from(position.x) * i128::from(den) + i128::from(dx) * i128::from(t_num);
    let left = i128::from(span_left) * i128::from(den);
    let right = i128::from(span_right) * i128::from(den);
    if contact_x_num < left || contact_x_num > right {
        return;
    }
    keep_earliest_hit(
        best,
        CircleTraceHit {
            t_scaled: RationalToi::new(t_num, den).scaled_floor(),
            normal_x_milli: 0,
            normal_y_milli,
        },
    );
}

fn trace_corner(
    best: &mut Option<CircleTraceHit>,
    position: CirclePoint,
    dx: i64,
    dy: i64,
    radius_milli: i32,
    corner_x: i32,
    corner_y: i32,
) {
    let ox = i64::from(position.x).saturating_sub(i64::from(corner_x));
    let oy = i64::from(position.y).saturating_sub(i64::from(corner_y));
    let a = i128::from(dx)
        .saturating_mul(i128::from(dx))
        .saturating_add(i128::from(dy).saturating_mul(i128::from(dy)));
    if a <= 0 {
        return;
    }
    let b = 2_i128.saturating_mul(
        i128::from(ox)
            .saturating_mul(i128::from(dx))
            .saturating_add(i128::from(oy).saturating_mul(i128::from(dy))),
    );
    let radius = i128::from(radius_milli.max(0));
    let c = i128::from(ox)
        .saturating_mul(i128::from(ox))
        .saturating_add(i128::from(oy).saturating_mul(i128::from(oy)))
        .saturating_sub(radius.saturating_mul(radius));
    if c <= 0 {
        return;
    }
    let discriminant = b
        .saturating_mul(b)
        .saturating_sub(4_i128.saturating_mul(a).saturating_mul(c));
    if discriminant < 0 {
        return;
    }
    let sqrt_discriminant = integer_sqrt_ceil_u128(discriminant as u128) as i128;
    let numerator = b.saturating_neg().saturating_sub(sqrt_discriminant);
    let denominator = 2_i128.saturating_mul(a);
    if numerator < 0 || numerator > denominator {
        return;
    }
    let t_scaled = ((numerator.saturating_mul(i128::from(TOI_SCALE))) / denominator)
        .clamp(0, i128::from(TOI_SCALE)) as i64;
    let offset_x_scaled = i128::from(ox)
        .saturating_mul(i128::from(TOI_SCALE))
        .saturating_add(i128::from(dx).saturating_mul(i128::from(t_scaled)));
    let offset_y_scaled = i128::from(oy)
        .saturating_mul(i128::from(TOI_SCALE))
        .saturating_add(i128::from(dy).saturating_mul(i128::from(t_scaled)));
    let (normal_x_milli, normal_y_milli) =
        normal_milli_from_vector(offset_x_scaled, offset_y_scaled);
    let normal_dot = i128::from(dx)
        .saturating_mul(i128::from(normal_x_milli))
        .saturating_add(i128::from(dy).saturating_mul(i128::from(normal_y_milli)));
    if normal_dot >= 0 {
        return;
    }
    keep_earliest_hit(
        best,
        CircleTraceHit {
            t_scaled,
            normal_x_milli,
            normal_y_milli,
        },
    );
}

fn keep_earliest_hit(best: &mut Option<CircleTraceHit>, hit: CircleTraceHit) {
    if !(0..=TOI_SCALE).contains(&hit.t_scaled) {
        return;
    }
    if best.is_none_or(|candidate| hit.t_scaled < candidate.t_scaled) {
        *best = Some(hit);
    }
}

fn circle_aabb_overlap_push(
    center: CirclePoint,
    radius_milli: i32,
    blocker: CircleAabb,
) -> Option<CircleOverlapPush> {
    let x = i64::from(center.x);
    let y = i64::from(center.y);
    let left = i64::from(blocker.left);
    let right = i64::from(blocker.right);
    let top = i64::from(blocker.top);
    let bottom = i64::from(blocker.bottom);
    let radius = i64::from(radius_milli.max(0));

    if x >= left && x <= right && y >= top && y <= bottom {
        let left_distance = (x - left).max(0);
        let right_distance = (right - x).max(0);
        let top_distance = (y - top).max(0);
        let bottom_distance = (bottom - y).max(0);
        let mut face_distance = left_distance;
        let mut normal_x = -1;
        let mut normal_y = 0;
        if right_distance < face_distance {
            face_distance = right_distance;
            normal_x = 1;
            normal_y = 0;
        }
        if top_distance < face_distance {
            face_distance = top_distance;
            normal_x = 0;
            normal_y = -1;
        }
        if bottom_distance < face_distance {
            face_distance = bottom_distance;
            normal_x = 0;
            normal_y = 1;
        }
        let depth = radius.saturating_add(face_distance);
        let push = depth.saturating_add(i64::from(CIRCLE_DEPENETRATION_EPSILON_MILLI));
        return Some(CircleOverlapPush {
            depth: saturating_i64_to_i32(depth),
            push_x: saturating_i64_to_i32(i64::from(normal_x).saturating_mul(push)),
            push_y: saturating_i64_to_i32(i64::from(normal_y).saturating_mul(push)),
        });
    }

    let closest_x = x.clamp(left, right);
    let closest_y = y.clamp(top, bottom);
    let offset_x = x.saturating_sub(closest_x);
    let offset_y = y.saturating_sub(closest_y);
    let dist_sq = offset_x
        .saturating_mul(offset_x)
        .saturating_add(offset_y.saturating_mul(offset_y));
    let min_clearance = radius.saturating_sub(i64::from(CIRCLE_DEPENETRATION_EPSILON_MILLI));
    if dist_sq >= min_clearance.saturating_mul(min_clearance) {
        return None;
    }
    if dist_sq <= 0 {
        return Some(CircleOverlapPush {
            depth: radius_milli,
            push_x: radius_milli.saturating_add(CIRCLE_DEPENETRATION_EPSILON_MILLI),
            push_y: 0,
        });
    }
    let distance = integer_sqrt_floor(dist_sq as u64).max(1) as i64;
    let depth = radius.saturating_sub(distance).max(0);
    let push_distance = depth.saturating_add(i64::from(CIRCLE_DEPENETRATION_EPSILON_MILLI));
    let mut push_x = scale_i64(offset_x, push_distance, distance);
    let mut push_y = scale_i64(offset_y, push_distance, distance);
    if push_x == 0 && offset_x != 0 {
        push_x = offset_x.signum();
    }
    if push_y == 0 && offset_y != 0 {
        push_y = offset_y.signum();
    }
    Some(CircleOverlapPush {
        depth: saturating_i64_to_i32(depth),
        push_x: saturating_i64_to_i32(push_x),
        push_y: saturating_i64_to_i32(push_y),
    })
}

fn scale_i64(value: i64, scale: i64, denom: i64) -> i64 {
    if denom <= 0 || value == 0 || scale == 0 {
        return 0;
    }
    let numerator = i128::from(value) * i128::from(scale);
    let denom = i128::from(denom);
    if numerator >= 0 {
        ((numerator + denom / 2) / denom).clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64
    } else {
        ((numerator - denom / 2) / denom).clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64
    }
}

fn div_round_i128(value: i128, denom: i128) -> i128 {
    if denom <= 0 || value == 0 {
        return 0;
    }
    if value >= 0 {
        (value + denom / 2) / denom
    } else {
        (value - denom / 2) / denom
    }
}

fn normal_milli_from_vector(x: i128, y: i128) -> (i32, i32) {
    let dist_sq = x.saturating_mul(x).saturating_add(y.saturating_mul(y));
    if dist_sq <= 0 {
        return (NORMAL_SCALE_MILLI, 0);
    }
    let distance = integer_sqrt_floor_u128(dist_sq as u128).max(1) as i128;
    let normal_x = div_round_i128(x.saturating_mul(i128::from(NORMAL_SCALE_MILLI)), distance).clamp(
        i128::from(-NORMAL_SCALE_MILLI),
        i128::from(NORMAL_SCALE_MILLI),
    ) as i32;
    let normal_y = div_round_i128(y.saturating_mul(i128::from(NORMAL_SCALE_MILLI)), distance).clamp(
        i128::from(-NORMAL_SCALE_MILLI),
        i128::from(NORMAL_SCALE_MILLI),
    ) as i32;
    if normal_x == 0 && normal_y == 0 {
        (NORMAL_SCALE_MILLI, 0)
    } else {
        (normal_x, normal_y)
    }
}

fn div_ceil_i64(value: i64, denom: i64) -> i64 {
    if denom <= 0 {
        return 0;
    }
    if value <= 0 {
        return value / denom;
    }
    (value + denom - 1) / denom
}

fn integer_sqrt_floor(value: u64) -> u64 {
    if value <= 1 {
        return value;
    }
    let mut low = 1_u64;
    let mut high = value.min(u64::from(u32::MAX) * u64::from(u32::MAX));
    while low <= high {
        let mid = low + (high - low) / 2;
        let sq = u128::from(mid) * u128::from(mid);
        match sq.cmp(&u128::from(value)) {
            Ordering::Equal => return mid,
            Ordering::Less => low = mid.saturating_add(1),
            Ordering::Greater => high = mid.saturating_sub(1),
        }
    }
    high
}

fn integer_sqrt_ceil(value: u64) -> u64 {
    let floor = integer_sqrt_floor(value);
    if floor.saturating_mul(floor) == value {
        floor
    } else {
        floor.saturating_add(1)
    }
}

fn integer_sqrt_floor_u128(value: u128) -> u128 {
    if value <= 1 {
        return value;
    }
    let mut low = 1_u128;
    let mut high = value;
    while low <= high {
        let mid = low + (high - low) / 2;
        let sq = mid.saturating_mul(mid);
        match sq.cmp(&value) {
            Ordering::Equal => return mid,
            Ordering::Less => low = mid.saturating_add(1),
            Ordering::Greater => high = mid.saturating_sub(1),
        }
    }
    high
}

fn integer_sqrt_ceil_u128(value: u128) -> u128 {
    let floor = integer_sqrt_floor_u128(value);
    if floor.saturating_mul(floor) == value {
        floor
    } else {
        floor.saturating_add(1)
    }
}

fn saturating_i128_to_i64(value: i128) -> i64 {
    value.clamp(i128::from(i64::MIN), i128::from(i64::MAX)) as i64
}

fn saturating_i64_to_i32(value: i64) -> i32 {
    value.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    const WALL: CircleAabb = CircleAabb::new(5_000, 0, 5_295, 10_000);
    const DOOR_LEFT_JAMB: CircleAabb = CircleAabb::new(1_000, 5_000, 2_442, 5_295);
    const DOOR_RIGHT_JAMB: CircleAabb = CircleAabb::new(3_558, 5_000, 5_000, 5_295);
    const HOUSE_LEFT_LOWER_SILL: CircleAabb = CircleAabb::new(502_658, 511_895, 502_921, 511_921);
    const HOUSE_RIGHT_LOWER_SILL: CircleAabb = CircleAabb::new(504_026, 511_895, 504_158, 511_921);

    fn resolve(
        origin: CirclePoint,
        delta_x: i32,
        delta_y: i32,
        blockers: &[CircleAabb],
    ) -> CirclePoint {
        resolve_circle_move_milli(
            origin,
            delta_x,
            delta_y,
            CIRCLE_COLLISION_RADIUS_MILLI,
            blockers,
        )
    }

    #[test]
    fn sprint_length_swept_move_stops_radius_plus_skin_outside_thin_band() {
        let result = resolve(CirclePoint { x: 2_000, y: 5_000 }, 10_000, 0, &[WALL]);
        assert_eq!(
            result.x,
            WALL.left - CIRCLE_COLLISION_RADIUS_MILLI - CIRCLE_TRACE_SKIN_MILLI
        );
        assert_eq!(result.y, 5_000);
        assert!(!circle_intersects_aabb(
            result,
            CIRCLE_COLLISION_RADIUS_MILLI,
            WALL
        ));
    }

    #[test]
    fn diagonal_slide_preserves_tangential_travel() {
        let result = resolve(CirclePoint { x: 4_600, y: 2_000 }, 1_000, 1_000, &[WALL]);
        assert!(
            (WALL.left - CIRCLE_COLLISION_RADIUS_MILLI - CIRCLE_TRACE_SKIN_MILLI
                ..=WALL.left - CIRCLE_COLLISION_RADIUS_MILLI)
                .contains(&result.x)
        );
        assert!((2_998..=3_002).contains(&result.y), "slide y={}", result.y);
        assert!(!circle_intersects_aabb(
            result,
            CIRCLE_COLLISION_RADIUS_MILLI,
            WALL
        ));
    }

    #[test]
    fn origin_inside_recovers_outward_without_crossing_far_face() {
        let result = resolve(CirclePoint { x: 5_150, y: 6_000 }, 0, 0, &[WALL]);
        assert_eq!(
            result.x,
            WALL.right + CIRCLE_COLLISION_RADIUS_MILLI + CIRCLE_DEPENETRATION_EPSILON_MILLI
        );
        assert_eq!(result.y, 6_000);
        assert!(result.x > WALL.right);
        assert!(!circle_intersects_aabb(
            result,
            CIRCLE_COLLISION_RADIUS_MILLI,
            WALL
        ));
    }

    #[test]
    fn closed_door_blocker_stops_gap_and_open_door_passes() {
        let closed = [CircleAabb::new(2_442, 5_000, 3_558, 5_295)];
        let stopped = resolve(CirclePoint { x: 3_000, y: 5_900 }, 0, -1_700, &closed);
        assert!(stopped.y >= 5_295 + CIRCLE_COLLISION_RADIUS_MILLI);
        assert!(!circle_intersects_aabb(
            stopped,
            CIRCLE_COLLISION_RADIUS_MILLI,
            closed[0]
        ));

        let open = resolve(CirclePoint { x: 3_000, y: 5_900 }, 0, -1_700, &[]);
        assert_eq!(open, CirclePoint { x: 3_000, y: 4_200 });
    }

    #[test]
    fn rounded_corner_trace_stops_on_arc_instead_of_square_corner_face() {
        let box_blocker = CircleAabb::new(5_000, 5_000, 6_000, 6_000);
        let result = resolve(
            CirclePoint { x: 4_000, y: 4_000 },
            2_000,
            2_000,
            &[box_blocker],
        );

        assert!(
            (4_784..=4_788).contains(&result.x) && (4_784..=4_788).contains(&result.y),
            "corner arc stop should be near the true circle-vs-corner TOI, got {:?}",
            result
        );
        assert!(!circle_intersects_aabb(
            result,
            CIRCLE_COLLISION_RADIUS_MILLI,
            box_blocker
        ));
    }

    #[test]
    fn doorway_sill_brush_keeps_northward_progress() {
        let blockers = [HOUSE_LEFT_LOWER_SILL, HOUSE_RIGHT_LOWER_SILL];
        let origin = CirclePoint {
            x: 503_150,
            y: 512_350,
        };
        let result = resolve(origin, 0, -3_000, &blockers);

        assert!(
            result.y < 511_000,
            "rounded corner response should glide through a door-sill brush instead of stopping at the square inflated bottom face: {:?}",
            result
        );
        assert!(
            result.x > origin.x,
            "left sill brush should push toward the open doorway, got {:?}",
            result
        );
        for blocker in blockers {
            assert!(!circle_intersects_aabb(
                result,
                CIRCLE_COLLISION_RADIUS_MILLI,
                blocker
            ));
        }
    }

    #[allow(clippy::type_complexity)]
    #[test]
    fn shared_client_parity_scenario_table() {
        let cases: &[(&str, CirclePoint, (i32, i32), &[CircleAabb], CirclePoint)] = &[
            (
                "head-on stop",
                CirclePoint { x: 2_000, y: 5_000 },
                (10_000, 0),
                &[WALL],
                CirclePoint { x: 4_698, y: 5_000 },
            ),
            (
                "diagonal slide",
                CirclePoint { x: 4_600, y: 2_000 },
                (1_000, 1_000),
                &[WALL],
                CirclePoint { x: 4_699, y: 3_000 },
            ),
            (
                "corner",
                CirclePoint { x: 4_000, y: 4_000 },
                (2_000, 2_000),
                &[CircleAabb::new(5_000, 5_000, 6_000, 6_000)],
                CirclePoint { x: 4_786, y: 4_786 },
            ),
            (
                "door-gap pass",
                CirclePoint { x: 3_000, y: 5_900 },
                (0, -1_700),
                &[DOOR_LEFT_JAMB, DOOR_RIGHT_JAMB],
                CirclePoint { x: 3_000, y: 4_200 },
            ),
            (
                "origin-inside recovery",
                CirclePoint { x: 5_150, y: 6_000 },
                (0, 0),
                &[WALL],
                CirclePoint { x: 5_596, y: 6_000 },
            ),
        ];

        for (label, origin, (dx, dy), blockers, expected) in cases {
            let actual = resolve(*origin, *dx, *dy, blockers);
            assert!(
                actual.x.abs_diff(expected.x) <= 2 && actual.y.abs_diff(expected.y) <= 2,
                "{label}: expected {:?}, got {:?}",
                expected,
                actual
            );
        }
    }
}
