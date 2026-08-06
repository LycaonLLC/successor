#![no_std]

mod solver;

pub use solver::{
    circle_intersects_aabb, resolve_circle_move_milli, CircleAabb, CirclePoint,
    CIRCLE_COLLISION_RADIUS_MILLI, CIRCLE_TRACE_SKIN_MILLI,
};
