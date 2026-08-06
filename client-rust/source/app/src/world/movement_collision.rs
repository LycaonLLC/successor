use successor_engine_core::json::Json;
use successor_movement::{
    resolve_circle_move_milli, CircleAabb, CirclePoint, CIRCLE_COLLISION_RADIUS_MILLI,
};

use crate::world::collision_debug::{authored_collision_bounds, CollisionDebugOverlay};

#[derive(Default)]
pub struct MovementCollisionWorld {
    blockers: Vec<CircleAabb>,
}

impl MovementCollisionWorld {
    pub fn rebuild(&mut self, slice: &Json, area_id: &str, dynamic: &CollisionDebugOverlay) {
        self.blockers.clear();
        self.blockers.extend(authored_collision_bounds(slice, area_id).into_iter().map(|bound| {
            CircleAabb::new(
                bound.left_milli,
                bound.top_milli,
                bound.right_milli,
                bound.bottom_milli,
            )
        }));
        dynamic.append_active_dynamic_bounds(&mut self.blockers);
    }

    pub fn resolve_anchor_move(
        &self,
        anchor_x: f32,
        anchor_y: f32,
        delta_x: f32,
        delta_y: f32,
    ) -> (f32, f32) {
        let center = CirclePoint {
            x: (anchor_x * 1_000.0).round() as i32 + 500,
            y: (anchor_y * 1_000.0).round() as i32 + 500,
        };
        let resolved = resolve_circle_move_milli(
            center,
            (delta_x * 1_000.0).round() as i32,
            (delta_y * 1_000.0).round() as i32,
            CIRCLE_COLLISION_RADIUS_MILLI,
            &self.blockers,
        );
        (
            (resolved.x - 500) as f32 / 1_000.0,
            (resolved.y - 500) as f32 / 1_000.0,
        )
    }
    pub fn anchor_clear(&self, anchor_x: f32, anchor_y: f32) -> bool {
        let center = CirclePoint {
            x: (anchor_x * 1_000.0).round() as i32 + 500,
            y: (anchor_y * 1_000.0).round() as i32 + 500,
        };
        !self.blockers.iter().copied().any(|blocker| {
            successor_movement::circle_intersects_aabb(
                center,
                CIRCLE_COLLISION_RADIUS_MILLI,
                blocker,
            )
        })
    }


    pub fn blocker_count(&self) -> usize {
        self.blockers.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doorway_clearance_uses_player_radius_not_cell_occupancy() {
        let world = MovementCollisionWorld {
            blockers: vec![
                CircleAabb::new(0, 0, 1_100, 2_000),
                CircleAabb::new(1_698, 0, 3_000, 2_000),
            ],
        };
        assert!(
            !world.anchor_clear(0.9, 0.5),
            "598-milli doorway is too narrow for a 600-milli diameter actor"
        );
        let clear_world = MovementCollisionWorld {
            blockers: vec![
                CircleAabb::new(0, 0, 1_000, 2_000),
                CircleAabb::new(1_800, 0, 3_000, 2_000),
            ],
        };
        assert!(clear_world.anchor_clear(0.9, 0.5));
    }
}
