//! Developer-only visualization of the movement collision inputs visible to the client.
//!
//! Geometry mirrors the authority's milli-cell AABBs. It never participates in
//! movement, picking, shadows, GI, or any other gameplay path.

use serde_json::Value;
use successor_engine_core::ecs::{Entity, WorldOps};
use successor_engine_core::json::Json;
use successor_engine_core::math::{vec3, Quat};
use successor_engine_render::components::{MaterialId, MeshId, MeshRenderer, SkinRef, Transform};
use successor_engine_render::gpu::Gpu;
use successor_engine_render::renderer::{MaterialDesc, Renderer};

use crate::world::chunks::TerrainStreamer;
use crate::world::{ADULT_PAWN_HEIGHT_METERS, WORLD_UNITS_PER_CELL};
use crate::GameWorld;

const ACTIVE_MASK: u32 = 0b1;
const HIDDEN_MASK: u32 = 0;
const EDGE_THICKNESS: f32 = 0.025;
const PLAYER_RADIUS_CELLS: f32 = 0.3;
const CLEARANCE_RADIUS_CELLS: f32 = 0.3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CollisionKind {
    BlockedCell,
    StaticProp,
    Door,
    Building,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CollisionAabb {
    pub left_milli: i32,
    pub top_milli: i32,
    pub right_milli: i32,
    pub bottom_milli: i32,
    pub kind: CollisionKind,
}

#[derive(Clone, Copy)]
struct DebugInstance {
    entity: Entity,
    clearance_entity: Option<Entity>,
    active: bool,
    kind: CollisionKind,
    bound: Option<CollisionAabb>,
}

struct DoorInstance {
    prop_id: String,
    debug: DebugInstance,
}

pub struct CollisionDebugOverlay {
    enabled: bool,
    box_mesh: MeshId,
    player_mesh: MeshId,
    active_static: MaterialId,
    active_dynamic: MaterialId,
    inactive: MaterialId,
    clearance: MaterialId,
    authority: MaterialId,
    predicted: MaterialId,
    player: MaterialId,
    static_instances: Vec<DebugInstance>,
    doors: Vec<DoorInstance>,
    buildings: Vec<DebugInstance>,
    player_entity: Option<Entity>,
    authority_entity: Option<Entity>,
    predicted_entity: Option<Entity>,
    building_hash: u64,
}

impl CollisionDebugOverlay {
    pub fn new<G: Gpu>(renderer: &mut Renderer, gpu: &mut G) -> Self {
        let (box_vertices, box_indices) = wire_box_mesh();
        let box_mesh = renderer.upload_mesh(gpu, &box_vertices, &box_indices);
        let (player_vertices, player_indices) = wire_cylinder_mesh(20);
        let player_mesh = renderer.upload_mesh(gpu, &player_vertices, &player_indices);
        let active_static = debug_material(renderer, [1.0, 0.08, 0.04]);
        let active_dynamic = debug_material(renderer, [1.0, 0.48, 0.03]);
        let inactive = debug_material(renderer, [0.08, 0.65, 0.72]);
        let clearance = debug_material(renderer, [0.18, 1.0, 0.12]);
        let authority = debug_material(renderer, [0.05, 0.75, 1.0]);
        let predicted = debug_material(renderer, [1.0, 0.92, 0.05]);
        let player = debug_material(renderer, [1.0, 0.05, 0.85]);
        Self {
            enabled: false,
            box_mesh,
            player_mesh,
            active_static,
            active_dynamic,
            inactive,
            clearance,
            authority,
            predicted,
            player,
            static_instances: Vec::new(),
            doors: Vec::new(),
            buildings: Vec::new(),
            player_entity: None,
            authority_entity: None,
            predicted_entity: None,
            building_hash: 0,
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn set_enabled(&mut self, world: &mut GameWorld, enabled: bool) {
        self.enabled = enabled;
        for instance in self
            .static_instances
            .iter()
            .chain(self.doors.iter().map(|door| &door.debug))
            .chain(self.buildings.iter())
        {
            apply_instance(
                world,
                *instance,
                enabled,
                self.active_static,
                self.active_dynamic,
                self.inactive,
                self.clearance,
            );
        }
        ensure_marker(
            world,
            &mut self.player_entity,
            self.player_mesh,
            self.player,
            PLAYER_RADIUS_CELLS,
            enabled,
        );
        ensure_marker(
            world,
            &mut self.authority_entity,
            self.player_mesh,
            self.authority,
            PLAYER_RADIUS_CELLS * 0.72,
            enabled,
        );
        ensure_marker(
            world,
            &mut self.predicted_entity,
            self.player_mesh,
            self.predicted,
            PLAYER_RADIUS_CELLS * 0.86,
            enabled,
        );
    }

    pub fn toggle(&mut self, world: &mut GameWorld) {
        self.set_enabled(world, !self.enabled);
    }

    pub fn clear_area(&mut self, world: &mut GameWorld) {
        for instance in self.static_instances.drain(..) {
            world.destroy(instance.entity);
            if let Some(entity) = instance.clearance_entity {
                world.destroy(entity);
            }
        }
        for door in self.doors.drain(..) {
            world.destroy(door.debug.entity);
            if let Some(entity) = door.debug.clearance_entity {
                world.destroy(entity);
            }
        }
        for instance in self.buildings.drain(..) {
            world.destroy(instance.entity);
            if let Some(entity) = instance.clearance_entity {
                world.destroy(entity);
            }
        }
        self.building_hash = 0;
        world.flush();
    }

    pub fn load_area<G: Gpu>(
        &mut self,
        world: &mut GameWorld,
        renderer: &mut Renderer,
        gpu: &mut G,
        slice: &Json,
        area_id: &str,
        terrain: &TerrainStreamer,
        prop_states: &std::collections::HashMap<String, Value>,
    ) {
        self.clear_area(world);
        let static_bounds = authored_collision_bounds(slice, area_id);
        if let Some(instance) =
            self.spawn_static_batch(world, renderer, gpu, &static_bounds, terrain)
        {
            self.static_instances.push(instance);
        }
        if let Some(props) = slice.get("props").and_then(Json::as_array) {
            for prop in props {
                if prop.get("areaId").and_then(Json::as_str) != Some(area_id) {
                    continue;
                }
                let Some(blocker) = prop.get("door").and_then(|door| door.get("blocker")) else {
                    continue;
                };
                let Some(bound) = placed_bound(prop, blocker, CollisionKind::Door, slice, area_id)
                else {
                    continue;
                };
                let prop_id = prop.get("id").and_then(Json::as_str).unwrap_or("");
                let active = door_blocker_active(prop_states.get(prop_id));
                let debug = self.spawn_bound(world, bound, terrain, active);
                self.doors.push(DoorInstance {
                    prop_id: prop_id.to_owned(),
                    debug,
                });
            }
        }
        self.set_enabled(world, self.enabled);
    }

    pub fn sync_dynamic(
        &mut self,
        world: &mut GameWorld,
        area_id: &str,
        terrain: &TerrainStreamer,
        prop_states: &std::collections::HashMap<String, Value>,
        building: Option<&Value>,
    ) -> bool {
        let mut changed = false;
        for door in &mut self.doors {
            let active = door_blocker_active(prop_states.get(&door.prop_id));
            if active != door.debug.active {
                changed = true;
                door.debug.active = active;
                apply_instance(
                    world,
                    door.debug,
                    self.enabled,
                    self.active_static,
                    self.active_dynamic,
                    self.inactive,
                    self.clearance,
                );
            }
        }

        // Only `components` feed collision bounds; sibling metadata (`tick`,
        // `schema`, …) churns every authority snapshot and must not trigger a
        // destroy/respawn + movement-collision rebuild every frame.
        let hash = building
            .and_then(|value| value.get("components"))
            .map(stable_json_hash)
            .unwrap_or(0);
        if hash != self.building_hash {
            changed = true;
            for instance in self.buildings.drain(..) {
                world.destroy(instance.entity);
                if let Some(entity) = instance.clearance_entity {
                    world.destroy(entity);
                }
            }
            self.building_hash = hash;
            if let Some(components) = building
                .and_then(|value| value.get("components"))
                .and_then(Value::as_array)
            {
                for component in components {
                    if component.get("areaId").and_then(Value::as_str) != Some(area_id) {
                        continue;
                    }
                    let kind = component.get("kind").and_then(Value::as_str).unwrap_or("");
                    if !matches!(kind, "wall" | "window" | "door") {
                        continue;
                    }
                    let active = kind != "door"
                        || !component
                            .get("doorOpen")
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                    if let Some(bound) = building_bound(component) {
                        let instance = self.spawn_bound(world, bound, terrain, active);
                        self.buildings.push(instance);
                    }
                }
            }
            self.set_enabled(world, self.enabled);
        }
        changed
    }
    pub fn append_active_dynamic_bounds(&self, out: &mut Vec<successor_movement::CircleAabb>) {
        out.extend(
            self.doors
                .iter()
                .map(|door| &door.debug)
                .chain(self.buildings.iter())
                .filter(|instance| instance.active)
                .filter_map(|instance| instance.bound)
                .map(|bound| {
                    successor_movement::CircleAabb::new(
                        bound.left_milli,
                        bound.top_milli,
                        bound.right_milli,
                        bound.bottom_milli,
                    )
                }),
        );
    }

    pub fn update_player(
        &mut self,
        world: &mut GameWorld,
        rendered: (f32, f32),
        authoritative: (f32, f32),
        predicted: (f32, f32),
        ground_y: f32,
    ) {
        update_marker(world, self.player_entity, rendered, ground_y);
        update_marker(world, self.authority_entity, authoritative, ground_y);
        update_marker(world, self.predicted_entity, predicted, ground_y);
    }

    fn spawn_bound(
        &self,
        world: &mut GameWorld,
        bound: CollisionAabb,
        terrain: &TerrainStreamer,
        active: bool,
    ) -> DebugInstance {
        let left = bound.left_milli as f32 / 1_000.0 * WORLD_UNITS_PER_CELL;

        let top = bound.top_milli as f32 / 1_000.0 * WORLD_UNITS_PER_CELL;
        let right = bound.right_milli as f32 / 1_000.0 * WORLD_UNITS_PER_CELL;
        let bottom = bound.bottom_milli as f32 / 1_000.0 * WORLD_UNITS_PER_CELL;
        let center_x = (left + right) * 0.5;
        let center_z = (top + bottom) * 0.5;
        let ground = terrain.height_at(center_x, center_z);
        let entity = spawn_box_entity(
            world,
            self.box_mesh,
            material_for_kind(bound.kind, active, self.active_static, self.active_dynamic, self.inactive),
            self.enabled,
            center_x,
            center_z,
            ground,
            (right - left).max(0.001),
            (bottom - top).max(0.001),
        );
        let clearance_entity = spawn_box_entity(
            world,
            self.box_mesh,
            self.clearance,
            self.enabled,
            center_x,
            center_z,
            ground + EDGE_THICKNESS,
            (right - left).max(0.001) + CLEARANCE_RADIUS_CELLS * 2.0 * WORLD_UNITS_PER_CELL,
            (bottom - top).max(0.001) + CLEARANCE_RADIUS_CELLS * 2.0 * WORLD_UNITS_PER_CELL,
        );
        let instance = DebugInstance {
            entity,
            active,
            kind: bound.kind,
            bound: Some(bound),
            clearance_entity: Some(clearance_entity),
        };

        instance
    }
    fn spawn_static_batch<G: Gpu>(
        &self,
        world: &mut GameWorld,
        renderer: &mut Renderer,
        gpu: &mut G,
        bounds: &[CollisionAabb],
        terrain: &TerrainStreamer,
    ) -> Option<DebugInstance> {
        if bounds.is_empty() {
            return None;
        }
        let (vertices, indices) = wire_bounds_mesh(bounds, terrain, 0.0);
        let mesh = renderer.upload_mesh(gpu, &vertices, &indices);
        let entity = world.spawn();
        world.set_component(entity, Transform::default());
        world.set_component(
            entity,
            MeshRenderer {
                mesh,
                material: self.active_static,
                viewport_mask: if self.enabled { ACTIVE_MASK } else { HIDDEN_MASK },
                skin: SkinRef::NONE,
            },
        );
        let (clearance_vertices, clearance_indices) =
            wire_bounds_mesh(bounds, terrain, CLEARANCE_RADIUS_CELLS);
        let clearance_mesh =
            renderer.upload_mesh(gpu, &clearance_vertices, &clearance_indices);
        let clearance_entity = world.spawn();
        world.set_component(clearance_entity, Transform::default());
        world.set_component(
            clearance_entity,
            MeshRenderer {
                mesh: clearance_mesh,
                material: self.clearance,
                viewport_mask: if self.enabled { ACTIVE_MASK } else { HIDDEN_MASK },
                skin: SkinRef::NONE,
            },
        );
        Some(DebugInstance {
            entity,
            active: true,
            kind: CollisionKind::StaticProp,
            bound: None,
            clearance_entity: Some(clearance_entity),
        })
    }
}

fn spawn_box_entity(
    world: &mut GameWorld,
    mesh: MeshId,
    material: MaterialId,
    enabled: bool,
    center_x: f32,
    center_z: f32,
    ground: f32,
    width: f32,
    depth: f32,
) -> Entity {
    let entity = world.spawn();
    world.set_component(
        entity,
        Transform {
            pos: vec3(
                center_x,
                ground + ADULT_PAWN_HEIGHT_METERS * 0.5,
                center_z,
            ),
            rot: Quat::IDENTITY,
            scale: vec3(width, ADULT_PAWN_HEIGHT_METERS, depth),
        },
    );
    world.set_component(
        entity,
        MeshRenderer {
            mesh,
            material,
            viewport_mask: if enabled { ACTIVE_MASK } else { HIDDEN_MASK },
            skin: SkinRef::NONE,
        },
    );
    entity
}

fn ensure_marker(
    world: &mut GameWorld,
    slot: &mut Option<Entity>,
    mesh: MeshId,
    material: MaterialId,
    radius_cells: f32,
    enabled: bool,
) {
    if slot.is_none() {
        let entity = world.spawn();
        world.set_component(
            entity,
            Transform {
                pos: vec3(0.0, ADULT_PAWN_HEIGHT_METERS * 0.5, 0.0),
                rot: Quat::IDENTITY,
                scale: vec3(
                    radius_cells * 2.0,
                    ADULT_PAWN_HEIGHT_METERS,
                    radius_cells * 2.0,
                ),
            },
        );
        world.set_component(
            entity,
            MeshRenderer {
                mesh,
                material,
                viewport_mask: if enabled { ACTIVE_MASK } else { HIDDEN_MASK },
                skin: SkinRef::NONE,
            },
        );
        *slot = Some(entity);
    } else if let Some(render) = (*slot).and_then(|entity| world.get_component::<MeshRenderer>(entity)) {
        render.viewport_mask = if enabled { ACTIVE_MASK } else { HIDDEN_MASK };
    }
}

fn update_marker(
    world: &mut GameWorld,
    entity: Option<Entity>,
    position_cells: (f32, f32),
    ground_y: f32,
) {
    if let Some(transform) = entity.and_then(|entity| world.get_component::<Transform>(entity)) {
        transform.pos = vec3(
            (position_cells.0 + 0.5) * WORLD_UNITS_PER_CELL,
            ground_y + ADULT_PAWN_HEIGHT_METERS * 0.5,
            (position_cells.1 + 0.5) * WORLD_UNITS_PER_CELL,
        );
    }
}

fn material_for_kind(
    kind: CollisionKind,
    active: bool,
    static_mat: MaterialId,
    dynamic_mat: MaterialId,
    inactive: MaterialId,
) -> MaterialId {
    if !active {
        inactive
    } else if matches!(kind, CollisionKind::Door | CollisionKind::Building) {
        dynamic_mat
    } else {
        static_mat
    }
}

fn debug_material(renderer: &mut Renderer, color: [f32; 3]) -> MaterialId {
    renderer.add_material_desc(MaterialDesc {
        base_color: [color[0], color[1], color[2], 1.0],
        metallic: 0.0,
        roughness: 0.25,
        emissive_factor: color,
        emissive_strength: 2.0,
        blend: false,
        double_sided: true,
        ..MaterialDesc::default()
    })
}

fn material_for(
    instance: DebugInstance,
    static_mat: MaterialId,
    dynamic_mat: MaterialId,
    inactive: MaterialId,
) -> MaterialId {
    material_for_kind(
        instance.kind,
        instance.active,
        static_mat,
        dynamic_mat,
        inactive,
    )
}

fn apply_instance(
    world: &mut GameWorld,
    instance: DebugInstance,
    enabled: bool,
    static_mat: MaterialId,
    dynamic_mat: MaterialId,
    inactive: MaterialId,
    clearance: MaterialId,
) {
    if let Some(render) = world.get_component::<MeshRenderer>(instance.entity) {
        render.viewport_mask = if enabled { ACTIVE_MASK } else { HIDDEN_MASK };
        render.material = material_for(instance, static_mat, dynamic_mat, inactive);
    }
    if let Some(render) = instance
        .clearance_entity
        .and_then(|entity| world.get_component::<MeshRenderer>(entity))
    {
        render.viewport_mask = if enabled && instance.active {
            ACTIVE_MASK
        } else {
            HIDDEN_MASK
        };
        render.material = clearance;
    }
}

pub fn authored_collision_bounds(slice: &Json, area_id: &str) -> Vec<CollisionAabb> {
    let mut out = Vec::new();
    if let Some(cells) = slice.get("blockedCells").and_then(Json::as_array) {
        for cell in cells {
            if cell.get("areaId").and_then(Json::as_str) != Some(area_id) {
                continue;
            }
            let (Some(x), Some(y)) = (
                cell.get("x")
                    .and_then(Json::as_i64)
                    .and_then(|v| i32::try_from(v).ok()),
                cell.get("y")
                    .and_then(Json::as_i64)
                    .and_then(|v| i32::try_from(v).ok()),
            ) else {
                continue;
            };
            out.push(CollisionAabb {
                left_milli: x.saturating_mul(1_000),
                top_milli: y.saturating_mul(1_000),
                right_milli: x.saturating_add(1).saturating_mul(1_000),
                bottom_milli: y.saturating_add(1).saturating_mul(1_000),
                kind: CollisionKind::BlockedCell,
            });
        }
    }
    if let Some(props) = slice.get("props").and_then(Json::as_array) {
        for prop in props {
            if prop.get("areaId").and_then(Json::as_str) != Some(area_id) {
                continue;
            }
            if let Some(bounds) = prop.get("collisionBounds").and_then(Json::as_array) {
                for bound in bounds {
                    if let Some(bound) =
                        placed_bound(prop, bound, CollisionKind::StaticProp, slice, area_id)
                    {
                        out.push(bound);
                    }
                }
            }
        }
    }
    out
}

fn placed_bound(
    prop: &Json,
    bound: &Json,
    kind: CollisionKind,
    slice: &Json,
    area_id: &str,
) -> Option<CollisionAabb> {
    let cell = prop.get("cell")?;
    let size = prop.get("size")?;
    let cell_x = i32::try_from(cell.get("x")?.as_i64()?).ok()?;
    let cell_y = i32::try_from(cell.get("y")?.as_i64()?).ok()?;
    let width = i32::try_from(size.get("w")?.as_i64()?)
        .ok()?
        .max(1)
        .saturating_mul(1_000);
    let height = i32::try_from(size.get("h")?.as_i64()?)
        .ok()?
        .max(1)
        .saturating_mul(1_000);
    let x = i32::try_from(bound.get("xMilli")?.as_i64()?)
        .ok()?
        .clamp(0, width);
    let y = i32::try_from(bound.get("yMilli")?.as_i64()?)
        .ok()?
        .clamp(0, height);
    let w = i32::try_from(bound.get("wMilli")?.as_i64()?).ok()?.max(0);
    let h = i32::try_from(bound.get("hMilli")?.as_i64()?).ok()?.max(0);
    let mut right = x.saturating_add(w).clamp(0, width);
    let mut bottom = y.saturating_add(h).clamp(0, height);
    if right <= x || bottom <= y {
        return None;
    }
    let (area_w, area_h) = area_size_milli(slice, area_id);
    let left = cell_x
        .saturating_mul(1_000)
        .saturating_add(x)
        .clamp(0, area_w);
    let top = cell_y
        .saturating_mul(1_000)
        .saturating_add(y)
        .clamp(0, area_h);
    right = cell_x
        .saturating_mul(1_000)
        .saturating_add(right)
        .clamp(0, area_w);
    bottom = cell_y
        .saturating_mul(1_000)
        .saturating_add(bottom)
        .clamp(0, area_h);
    (right > left && bottom > top).then_some(CollisionAabb {
        left_milli: left,
        top_milli: top,
        right_milli: right,
        bottom_milli: bottom,
        kind,
    })
}

fn area_size_milli(slice: &Json, area_id: &str) -> (i32, i32) {
    slice
        .get("areas")
        .and_then(Json::as_array)
        .and_then(|areas| {
            areas
                .iter()
                .find(|area| area.get("id").and_then(Json::as_str) == Some(area_id))
        })
        .map(|area| {
            let w = area
                .get("width")
                .and_then(Json::as_i64)
                .and_then(|v| i32::try_from(v).ok())
                .unwrap_or(i32::MAX / 1_000)
                .saturating_mul(1_000);
            let h = area
                .get("height")
                .and_then(Json::as_i64)
                .and_then(|v| i32::try_from(v).ok())
                .unwrap_or(i32::MAX / 1_000)
                .saturating_mul(1_000);
            (w, h)
        })
        .unwrap_or((i32::MAX, i32::MAX))
}

fn door_blocker_active(state: Option<&Value>) -> bool {
    !state
        .and_then(|value| value.get("doorOpen"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn building_bound(component: &Value) -> Option<CollisionAabb> {
    let x = i32::try_from(component.get("cellX")?.as_i64()?)
        .ok()?
        .saturating_mul(1_000);
    let y = i32::try_from(component.get("cellY")?.as_i64()?)
        .ok()?
        .saturating_mul(1_000);
    let q = component
        .get("rotationQuarters")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .rem_euclid(4);
    let (left, top, right, bottom) = match q {
        0 => (x, y - 50, x + 1_000, y + 50),
        1 => (x + 950, y, x + 1_050, y + 1_000),
        2 => (x, y + 950, x + 1_000, y + 1_050),
        _ => (x - 50, y, x + 50, y + 1_000),
    };
    Some(CollisionAabb {
        left_milli: left,
        top_milli: top,
        right_milli: right,
        bottom_milli: bottom,
        kind: CollisionKind::Building,
    })
}

fn stable_json_hash(value: &Value) -> u64 {
    fn add(hash: &mut u64, bytes: &[u8]) {
        for byte in bytes {
            *hash ^= u64::from(*byte);
            *hash = hash.wrapping_mul(0x100_0000_01b3);
        }
    }
    fn visit(hash: &mut u64, value: &Value) {
        match value {
            Value::Null => add(hash, b"n"),
            Value::Bool(v) => add(hash, if *v { b"t" } else { b"f" }),
            Value::Number(v) => {
                if let Some(number) = v.as_i64() {
                    add(hash, &number.to_le_bytes());
                } else if let Some(number) = v.as_u64() {
                    add(hash, &number.to_le_bytes());
                } else if let Some(number) = v.as_f64() {
                    add(hash, &number.to_bits().to_le_bytes());
                }
            }
            Value::String(v) => add(hash, v.as_bytes()),
            Value::Array(values) => {
                for value in values {
                    visit(hash, value);
                }
            }
            Value::Object(values) => {
                for (key, value) in values {
                    add(hash, key.as_bytes());
                    visit(hash, value);
                }
            }
        }
    }
    let mut hash = 0xcbf2_9ce4_8422_2325;
    visit(&mut hash, value);
    hash
}

fn wire_box_mesh() -> (Vec<f32>, Vec<u32>) {
    let mut vertices = Vec::with_capacity(12 * 24 * 8);
    let mut indices = Vec::with_capacity(12 * 36);
    let edges = [
        ([0.0, -0.5, -0.5], [1.0, EDGE_THICKNESS, EDGE_THICKNESS]),
        ([0.0, -0.5, 0.5], [1.0, EDGE_THICKNESS, EDGE_THICKNESS]),
        ([0.0, 0.5, -0.5], [1.0, EDGE_THICKNESS, EDGE_THICKNESS]),
        ([0.0, 0.5, 0.5], [1.0, EDGE_THICKNESS, EDGE_THICKNESS]),
        ([-0.5, -0.5, 0.0], [EDGE_THICKNESS, EDGE_THICKNESS, 1.0]),
        ([0.5, -0.5, 0.0], [EDGE_THICKNESS, EDGE_THICKNESS, 1.0]),
        ([-0.5, 0.5, 0.0], [EDGE_THICKNESS, EDGE_THICKNESS, 1.0]),
        ([0.5, 0.5, 0.0], [EDGE_THICKNESS, EDGE_THICKNESS, 1.0]),
        ([-0.5, 0.0, -0.5], [EDGE_THICKNESS, 1.0, EDGE_THICKNESS]),
        ([0.5, 0.0, -0.5], [EDGE_THICKNESS, 1.0, EDGE_THICKNESS]),
        ([-0.5, 0.0, 0.5], [EDGE_THICKNESS, 1.0, EDGE_THICKNESS]),
        ([0.5, 0.0, 0.5], [EDGE_THICKNESS, 1.0, EDGE_THICKNESS]),
    ];

    for (center, scale) in edges {
        append_cube(&mut vertices, &mut indices, center, scale);
    }
    (vertices, indices)
}
fn wire_bounds_mesh(
    bounds: &[CollisionAabb],
    terrain: &TerrainStreamer,
    expand_cells: f32,
) -> (Vec<f32>, Vec<u32>) {
    let (unit_vertices, unit_indices) = wire_box_mesh();
    let mut vertices = Vec::with_capacity(unit_vertices.len() * bounds.len());
    let mut indices = Vec::with_capacity(unit_indices.len() * bounds.len());
    let expand = expand_cells * WORLD_UNITS_PER_CELL;
    for bound in bounds {
        let left = bound.left_milli as f32 / 1_000.0 * WORLD_UNITS_PER_CELL;
        let top = bound.top_milli as f32 / 1_000.0 * WORLD_UNITS_PER_CELL;
        let right = bound.right_milli as f32 / 1_000.0 * WORLD_UNITS_PER_CELL;
        let bottom = bound.bottom_milli as f32 / 1_000.0 * WORLD_UNITS_PER_CELL;
        let center_x = (left + right) * 0.5;
        let center_z = (top + bottom) * 0.5;
        let ground = terrain.height_at(center_x, center_z) + expand_cells.signum() * EDGE_THICKNESS;
        let width = (right - left).max(0.001) + expand * 2.0;
        let depth = (bottom - top).max(0.001) + expand * 2.0;
        let base = (vertices.len() / 8) as u32;
        for vertex in unit_vertices.chunks_exact(8) {
            vertices.extend_from_slice(&[
                center_x + vertex[0] * width,
                ground + ADULT_PAWN_HEIGHT_METERS * 0.5 + vertex[1] * ADULT_PAWN_HEIGHT_METERS,
                center_z + vertex[2] * depth,
                vertex[3],
                vertex[4],
                vertex[5],
                vertex[6],
                vertex[7],
            ]);
        }
        indices.extend(unit_indices.iter().map(|index| base + *index));
    }
    (vertices, indices)
}

fn wire_cylinder_mesh(segments: usize) -> (Vec<f32>, Vec<u32>) {
    let mut vertices = Vec::with_capacity(segments * 3 * 24 * 8);
    let mut indices = Vec::with_capacity(segments * 3 * 36);
    let tau = core::f32::consts::TAU;
    for i in 0..segments {
        let a = i as f32 / segments as f32 * tau;
        let b = (i + 1) as f32 / segments as f32 * tau;
        let (sa, ca) = a.sin_cos();
        let (sb, cb) = b.sin_cos();
        let dx = cb - ca;
        let dz = sb - sa;
        let length = (dx * dx + dz * dz).sqrt();
        let yaw = dz.atan2(dx);
        append_rotated_cube(
            &mut vertices,
            &mut indices,
            [(ca + cb) * 0.5, -0.5, (sa + sb) * 0.5],
            [length, EDGE_THICKNESS, EDGE_THICKNESS],
            yaw,
        );
        append_rotated_cube(
            &mut vertices,
            &mut indices,
            [(ca + cb) * 0.5, 0.5, (sa + sb) * 0.5],
            [length, EDGE_THICKNESS, EDGE_THICKNESS],
            yaw,
        );
        append_cube(
            &mut vertices,
            &mut indices,
            [ca, 0.0, sa],
            [EDGE_THICKNESS, 1.0, EDGE_THICKNESS],
        );
    }
    (vertices, indices)
}

fn append_cube(vertices: &mut Vec<f32>, indices: &mut Vec<u32>, center: [f32; 3], scale: [f32; 3]) {
    append_rotated_cube(vertices, indices, center, scale, 0.0);
}

fn append_rotated_cube(
    vertices: &mut Vec<f32>,
    indices: &mut Vec<u32>,
    center: [f32; 3],
    scale: [f32; 3],
    yaw: f32,
) {
    let (source, source_indices) = successor_engine_render::primitives::cube();
    let base = (vertices.len() / 8) as u32;
    let (s, c) = yaw.sin_cos();
    for vertex in source.chunks_exact(8) {
        let x = vertex[0] * scale[0];
        let y = vertex[1] * scale[1];
        let z = vertex[2] * scale[2];
        vertices.extend_from_slice(&[
            center[0] + x * c - z * s,
            center[1] + y,
            center[2] + x * s + z * c,
            vertex[3],
            vertex[4],
            vertex[5],
            vertex[6],
            vertex[7],
        ]);
    }
    indices.extend(source_indices.into_iter().map(|index| base + index));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authored_bounds_match_authority_clamping_without_rotation() {
        let slice = Json::parse(r#"{"areas":[{"id":"a","width":8,"height":8}],"blockedCells":[{"areaId":"a","x":1,"y":2}],"props":[{"id":"p","areaId":"a","cell":{"x":3,"y":4},"size":{"w":2,"h":2},"rotation":90,"collisionBounds":[{"xMilli":-50,"yMilli":100,"wMilli":3000,"hMilli":400}]}]}"#).unwrap();
        let bounds = authored_collision_bounds(&slice, "a");
        assert_eq!(
            bounds[0],
            CollisionAabb {
                left_milli: 1000,
                top_milli: 2000,
                right_milli: 2000,
                bottom_milli: 3000,
                kind: CollisionKind::BlockedCell
            }
        );
        assert_eq!(
            bounds[1],
            CollisionAabb {
                left_milli: 3000,
                top_milli: 4100,
                right_milli: 5000,
                bottom_milli: 4500,
                kind: CollisionKind::StaticProp
            }
        );
    }

    #[test]
    fn building_bounds_match_authority_quarters() {
        for (q, expected) in [
            (0, (2000, 2950, 3000, 3050)),
            (1, (2950, 3000, 3050, 4000)),
            (2, (2000, 3950, 3000, 4050)),
            (3, (1950, 3000, 2050, 4000)),
        ] {
            let value = serde_json::json!({"cellX":2,"cellY":3,"rotationQuarters":q});
            let bound = building_bound(&value).unwrap();
            assert_eq!(
                (
                    bound.left_milli,
                    bound.top_milli,
                    bound.right_milli,
                    bound.bottom_milli
                ),
                expected
            );
        }
    }

    #[test]
    fn dynamic_state_changes_door_activity_and_building_identity() {
        let closed = serde_json::json!({"doorOpen":false});
        let open = serde_json::json!({"doorOpen":true});
        assert!(door_blocker_active(None));
        assert!(door_blocker_active(Some(&closed)));
        assert!(!door_blocker_active(Some(&open)));

        let building = serde_json::json!({"components":[{"kind":"door","doorOpen":false}]});
        let unchanged = building.clone();
        let changed = serde_json::json!({"components":[{"kind":"door","doorOpen":true}]});
        assert_eq!(stable_json_hash(&building), stable_json_hash(&unchanged));
        assert_ne!(stable_json_hash(&building), stable_json_hash(&changed));
    }

    #[test]
    fn authored_bounds_rebuild_for_only_the_requested_area() {
        let slice = Json::parse(
            r#"{"areas":[{"id":"a","width":4,"height":4},{"id":"b","width":4,"height":4}],"blockedCells":[{"areaId":"a","x":1,"y":1},{"areaId":"b","x":2,"y":2}],"props":[]}"#,
        )
        .unwrap();
        let a = authored_collision_bounds(&slice, "a");
        let b = authored_collision_bounds(&slice, "b");
        assert_eq!(a.len(), 1);
        assert_eq!(b.len(), 1);
        assert_eq!(a[0].left_milli, 1_000);
        assert_eq!(b[0].left_milli, 2_000);
    }

    #[test]
    fn wire_meshes_are_triangle_complete() {
        let (box_vertices, box_indices) = wire_box_mesh();
        let (circle_vertices, circle_indices) = wire_cylinder_mesh(20);
        assert_eq!(box_vertices.len(), 12 * 24 * 8);
        assert_eq!(box_indices.len(), 12 * 36);
        assert_eq!(circle_vertices.len(), 20 * 3 * 24 * 8);
        assert_eq!(circle_indices.len(), 20 * 3 * 36);
    }
}
