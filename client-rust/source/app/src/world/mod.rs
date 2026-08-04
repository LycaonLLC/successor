//! World rendering: procedural terrain, prop placement, and the chunk streamer
//! that turns the shared map fixture into GPU geometry.

/// Canonical spatial contract shared by simulation, terrain, props, pawns, and
/// cameras: one authority cell is one renderer world unit and represents one
/// metre. Asset loaders normalize authored geometry into this scale instead of
/// carrying source-package units into gameplay.
pub const WORLD_UNITS_PER_CELL: f32 = 1.0;
pub const ADULT_PAWN_HEIGHT_METERS: f32 = 1.8;
pub const TERRAIN_MATERIAL_METERS_PER_TILE: f32 = 1.25;
pub const FOLLOW_CAMERA_HEIGHT_METERS: f32 = 14.0;
pub const FOLLOW_CAMERA_BACK_METERS: f32 = 21.0;

pub mod area;
pub mod camera;
pub mod chunks;
pub mod collision_debug;
pub mod cutaway;
pub mod environs;
pub mod flora;
pub mod picking;
pub mod props;
pub mod streamed;
pub mod terrain;
pub mod terrain_material;

const _: () = {
    assert!(WORLD_UNITS_PER_CELL == 1.0);
    assert!(ADULT_PAWN_HEIGHT_METERS == 1.8);
    assert!(TERRAIN_MATERIAL_METERS_PER_TILE >= WORLD_UNITS_PER_CELL);
    assert!(TERRAIN_MATERIAL_METERS_PER_TILE <= WORLD_UNITS_PER_CELL * 2.0);
};
