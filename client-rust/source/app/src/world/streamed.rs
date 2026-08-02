//! Streamed world-entity families → ECS presentation. Every AOI-scoped
//! section the authority streams (placed extractors, camps, player corpses,
//! farm plots, parcels, player-built structures) gets an explicit, pooled,
//! state-keyed presentation reconciled against the store each frame:
//! entities spawn on first sight, restyle only when their decoded state
//! changes, and despawn the frame their row leaves the stream — the
//! `placedCamps` reconcile pattern from the reference renderers
//! (`extractors.ts`, `camps.ts`, `playerCorpses.ts`, `crops.ts`,
//! `building/renderer.ts`). Steady state (no row/state churn) touches no ECS
//! entity and allocates nothing.
//!
//! Optional GLB models (extractor category models, the scout podtent +
//! campfire) load through the platform asset reader; a miss records a typed
//! [`WorldAssetIssue`] once and the instance renders the explicit placeholder
//! marker instead — never invisible, never silent.

use std::collections::HashMap;

use serde_json::Value;
use successor_engine_core::ecs::{Entity, WorldOps};
use successor_engine_core::math::{vec3, Mat4, Quat, Vec3};
use successor_engine_render::components::{MaterialId, MeshId, MeshRenderer, SkinRef, Transform};
use successor_engine_render::gpu::Gpu;
use successor_engine_render::renderer::{MaterialDesc, Renderer};

use crate::game::authority::AuthorityStore;
use crate::world::area::fnv1a32;
use crate::world::chunks::TerrainStreamer;
use crate::world::WORLD_UNITS_PER_CELL;
use crate::GameWorld;

/// Typed optional world-asset degradation (bounded, deduped).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorldAssetIssue {
    MissingModel { stable_id: String },
}

const MAX_ISSUES: usize = 32;
/// Entities rendered in the main + minimap viewports.
const MASK: u32 = 0b11;

/// FNV-1a over words — cheap state keys for change detection.
fn state_key(parts: &[u64]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for p in parts {
        for b in p.to_le_bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}

fn qf(v: f32) -> u64 {
    (v * 1000.0) as i64 as u64
}

struct Slot {
    entities: Vec<Entity>,
    key: u64,
    mark: u64,
}

#[derive(Default)]
struct Pool {
    slots: HashMap<String, Slot>,
}

impl Pool {
    /// True if the row is unchanged (slot marked); false → caller respawns.
    /// A changed slot has its entities despawned here.
    fn keep_if_unchanged(
        &mut self,
        world: &mut GameWorld,
        id: &str,
        key: u64,
        generation: u64,
    ) -> bool {
        if let Some(slot) = self.slots.get_mut(id) {
            if slot.key == key {
                slot.mark = generation;
                return true;
            }
            for e in slot.entities.drain(..) {
                world.destroy(e);
            }
        }
        false
    }

    fn insert(&mut self, id: String, entities: Vec<Entity>, key: u64, generation: u64) {
        self.slots.insert(
            id,
            Slot {
                entities,
                key,
                mark: generation,
            },
        );
    }

    /// Sweep every slot not marked with `generation`.
    fn sweep(&mut self, world: &mut GameWorld, generation: u64) {
        self.slots.retain(|_, slot| {
            if slot.mark == generation {
                true
            } else {
                for e in &slot.entities {
                    world.destroy(*e);
                }
                false
            }
        });
    }
}

/// A cached optional GLB model (uploaded once) or its typed absence.
enum ModelSlot {
    Loaded(Vec<(MeshId, MaterialId, Mat4)>),
    Missing,
}

/// Decoded farm-tile presentation (unit-testable without a GPU).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FarmTileView {
    pub cell_x: f32,
    pub cell_y: f32,
    pub tilled: bool,
    pub moisture01: f32,
    /// 0..1 growth (stage / stageCount); None = no crop.
    pub growth: Option<f32>,
    pub mature: bool,
    pub blighted: bool,
}

/// Decode one `FarmTileVM`; malformed tiles are skipped (fail closed).
pub fn decode_farm_tile(tile: &Value) -> Option<FarmTileView> {
    let cell_x = tile.get("cellX")?.as_f64()? as f32;
    let cell_y = tile.get("cellY")?.as_f64()? as f32;
    if !cell_x.is_finite() || !cell_y.is_finite() {
        return None;
    }
    let tilled = tile.get("tilled").and_then(Value::as_bool).unwrap_or(false);
    let moisture01 = (tile
        .get("moisturePct")
        .and_then(Value::as_f64)
        .unwrap_or(0.0) as f32
        / 100.0)
        .clamp(0.0, 1.0);
    let crop = tile.get("crop").filter(|c| !c.is_null());
    let (growth, mature, blighted) = match crop {
        Some(c) => {
            let stage = c.get("stage").and_then(Value::as_f64).unwrap_or(0.0) as f32;
            let count = c
                .get("stageCount")
                .and_then(Value::as_f64)
                .unwrap_or(1.0)
                .max(1.0) as f32;
            let mature = c.get("mature").and_then(Value::as_bool).unwrap_or(false);
            let blight = c
                .get("blight")
                .and_then(Value::as_str)
                .map(|b| b != "none" && !b.is_empty())
                .unwrap_or(false);
            (Some((stage / count).clamp(0.0, 1.0)), mature, blight)
        }
        None => (None, false, false),
    };
    Some(FarmTileView {
        cell_x,
        cell_y,
        tilled,
        moisture01,
        growth,
        mature,
        blighted,
    })
}

/// Extractor family label → model category (mirrors `extractors.ts` GLB map).
pub fn extractor_category(family_label: &str) -> &'static str {
    let lower = family_label.to_ascii_lowercase();
    if lower.contains("gas") {
        "gas"
    } else if lower.contains("chem") {
        "chemical"
    } else if lower.contains("water") || lower.contains("liquid") {
        "water"
    } else {
        "mineral"
    }
}

pub struct StreamedWorld {
    extractors: Pool,
    camps: Pool,
    corpses: Pool,
    farm_tiles: Pool,
    parcels: Pool,
    building: Pool,
    generation: u64,
    /// stable id → uploaded model (or typed absence).
    models: HashMap<String, ModelSlot>,
    issues: Vec<WorldAssetIssue>,
    // Shared primitive resources (built on first use).
    cube: Option<MeshId>,
    materials: HashMap<u32, MaterialId>,
    /// Character-scoped world waypoint beam (datapad-owned; scene sets it).
    waypoint: Option<(f32, f32)>,
    waypoint_entity: Option<Entity>,
    waypoint_pulse: f32,
    /// Scratch for farm tile ids (reused).
    tile_id_scratch: String,
}

impl Default for StreamedWorld {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamedWorld {
    pub fn new() -> Self {
        Self {
            extractors: Pool::default(),
            camps: Pool::default(),
            corpses: Pool::default(),
            farm_tiles: Pool::default(),
            parcels: Pool::default(),
            building: Pool::default(),
            generation: 0,
            models: HashMap::new(),
            issues: Vec::new(),
            cube: None,
            materials: HashMap::new(),
            waypoint: None,
            waypoint_entity: None,
            waypoint_pulse: 0.0,
            tile_id_scratch: String::with_capacity(64),
        }
    }

    pub fn issues(&self) -> &[WorldAssetIssue] {
        &self.issues
    }

    /// Set/clear the world waypoint beam target (sim cells).
    pub fn set_waypoint(&mut self, target: Option<(f32, f32)>) {
        self.waypoint = target;
    }

    /// Drop every spawned entity (area transition: area-scoped state must be
    /// released before the new area builds).
    pub fn clear(&mut self, world: &mut GameWorld) {
        self.generation += 1;
        let generation = self.generation;
        self.extractors.sweep(world, generation);
        self.camps.sweep(world, generation);
        self.corpses.sweep(world, generation);
        self.farm_tiles.sweep(world, generation);
        self.parcels.sweep(world, generation);
        self.building.sweep(world, generation);
        if let Some(e) = self.waypoint_entity.take() {
            world.destroy(e);
        }
        world.flush();
    }

    fn record(&mut self, issue: WorldAssetIssue) {
        if self.issues.len() < MAX_ISSUES && !self.issues.contains(&issue) {
            self.issues.push(issue);
        }
    }

    fn cube<G: Gpu>(&mut self, renderer: &mut Renderer, gpu: &mut G) -> MeshId {
        *self.cube.get_or_insert_with(|| {
            let (v, i) = successor_engine_render::primitives::cube();
            renderer.upload_mesh(gpu, &v, &i)
        })
    }

    fn material(&mut self, renderer: &mut Renderer, rgba: [f32; 4]) -> MaterialId {
        let key = (((rgba[0] * 255.0) as u32) << 24)
            | (((rgba[1] * 255.0) as u32) << 16)
            | (((rgba[2] * 255.0) as u32) << 8)
            | ((rgba[3] * 255.0) as u32);
        *self.materials.entry(key).or_insert_with(|| {
            renderer.add_material_desc(MaterialDesc {
                base_color: rgba,
                blend: rgba[3] < 1.0,
                ..MaterialDesc::default()
            })
        })
    }

    /// Ensure a model is cached; true when loaded, false → typed miss.
    fn model<G: Gpu>(
        &mut self,
        renderer: &mut Renderer,
        gpu: &mut G,
        read: &mut dyn FnMut(&str) -> Option<Vec<u8>>,
        stable_id: &str,
    ) -> bool {
        if !self.models.contains_key(stable_id) {
            let slot = match read(stable_id).and_then(|bytes| {
                crate::pawn::pack::upload_static_parts(gpu, renderer, &bytes).ok()
            }) {
                Some(parts) => ModelSlot::Loaded(parts),
                None => {
                    self.record(WorldAssetIssue::MissingModel {
                        stable_id: stable_id.to_string(),
                    });
                    ModelSlot::Missing
                }
            };
            self.models.insert(stable_id.to_string(), slot);
        }
        matches!(self.models.get(stable_id), Some(ModelSlot::Loaded(_)))
    }

    /// Spawn one box entity (unit cube scaled), returning it.
    #[allow(clippy::too_many_arguments)]
    fn spawn_box<G: Gpu>(
        &mut self,
        world: &mut GameWorld,
        renderer: &mut Renderer,
        gpu: &mut G,
        center: Vec3,
        scale: Vec3,
        yaw: f32,
        rgba: [f32; 4],
    ) -> Entity {
        let mesh = self.cube(renderer, gpu);
        let material = self.material(renderer, rgba);
        let e = world.spawn();
        world.set_component(
            e,
            Transform {
                pos: center,
                rot: Quat::from_yaw(yaw),
                scale,
            },
        );
        world.set_component(
            e,
            MeshRenderer {
                mesh,
                material,
                viewport_mask: MASK,
                skin: SkinRef::NONE,
            },
        );
        e
    }

    /// Spawn a loaded model's parts at a placement; appends the entities.
    fn spawn_model(
        &mut self,
        world: &mut GameWorld,
        stable_id: &str,
        placement: Mat4,
        out: &mut Vec<Entity>,
    ) {
        let Some(ModelSlot::Loaded(parts)) = self.models.get(stable_id) else {
            return;
        };
        // Snapshot part descriptors first: spawning borrows `world`, not
        // `self`, but `parts` borrows `self.models` — copy the small list.
        let baked: Vec<(MeshId, MaterialId, Mat4)> = parts.clone();
        for (mesh, material, local) in baked {
            let (pos, rot, scale) = placement.mul(local).to_trs();
            let e = world.spawn();
            world.set_component(e, Transform { pos, rot, scale });
            world.set_component(
                e,
                MeshRenderer {
                    mesh,
                    material,
                    viewport_mask: MASK,
                    skin: SkinRef::NONE,
                },
            );
            out.push(e);
        }
    }

    /// The explicit missing-asset marker: a magenta pylon. Any optional model
    /// that fails to load renders this instead of nothing.
    fn spawn_missing_marker<G: Gpu>(
        &mut self,
        world: &mut GameWorld,
        renderer: &mut Renderer,
        gpu: &mut G,
        at: Vec3,
        out: &mut Vec<Entity>,
    ) {
        let e = self.spawn_box(
            world,
            renderer,
            gpu,
            at.add(vec3(0.0, 0.6, 0.0)),
            vec3(0.35, 1.2, 0.35),
            core::f32::consts::FRAC_PI_4,
            [0.9, 0.15, 0.75, 1.0],
        );
        out.push(e);
    }

    /// Reconcile every streamed family against the store. Terrain supplies
    /// ground heights; `read` supplies optional models; `area_id` scopes
    /// area-tagged rows.
    #[allow(clippy::too_many_arguments)]
    pub fn sync<G: Gpu>(
        &mut self,
        world: &mut GameWorld,
        renderer: &mut Renderer,
        gpu: &mut G,
        terrain: &TerrainStreamer,
        store: &AuthorityStore,
        area_id: &str,
        read: &mut dyn FnMut(&str) -> Option<Vec<u8>>,
        dt: f32,
    ) {
        self.generation += 1;
        let generation = self.generation;

        // ── Placed extractors ────────────────────────────────────────────
        for row in &store.placed_extractors {
            let Some(id) = row.get("extractorId").and_then(Value::as_str) else {
                continue;
            };
            if row.get("areaId").and_then(Value::as_str) != Some(area_id) {
                continue;
            }
            let (Some(cx), Some(cy)) = (
                row.get("cellX").and_then(Value::as_f64),
                row.get("cellY").and_then(Value::as_f64),
            ) else {
                continue;
            };
            let mode = row.get("mode").and_then(Value::as_str).unwrap_or("idle");
            let hopper = row.get("hopperPct").and_then(Value::as_f64).unwrap_or(0.0) as f32;
            let battery = row.get("batteryPct").and_then(Value::as_f64).unwrap_or(0.0) as f32;
            let family = row.get("familyLabel").and_then(Value::as_str).unwrap_or("");
            let key = state_key(&[
                qf(cx as f32),
                qf(cy as f32),
                fnv1a32(mode) as u64,
                qf(hopper),
                qf(battery),
            ]);
            if self
                .extractors
                .keep_if_unchanged(world, id, key, generation)
            {
                continue;
            }
            let wx = (cx as f32 + 0.5) * WORLD_UNITS_PER_CELL;
            let wz = (cy as f32 + 0.5) * WORLD_UNITS_PER_CELL;
            let ground = vec3(wx, terrain.height_at(wx, wz), wz);
            let category = extractor_category(family);
            let stable_id = format!("assets/world-items/extractor_{category}.glb");
            let mut entities = Vec::new();
            if self.model(renderer, gpu, read, &stable_id) {
                // Authored ~0.6 m; reference upscales 1.25× for readability.
                let placement = Mat4::from_trs(ground, Quat::from_yaw(0.0), vec3(1.25, 1.25, 1.25));
                self.spawn_model(world, &stable_id, placement, &mut entities);
            } else {
                self.spawn_missing_marker(world, renderer, gpu, ground, &mut entities);
            }
            // State column: hopper fill (amber), battery sliver (cyan), and
            // a mode lamp (green manual / blue battery / dark idle).
            let fill = hopper.clamp(0.0, 100.0) / 100.0;
            if fill > 0.01 {
                let h = 0.5 * fill;
                let e = self.spawn_box(
                    world,
                    renderer,
                    gpu,
                    ground.add(vec3(0.55, h * 0.5, 0.0)),
                    vec3(0.1, h.max(0.02), 0.1),
                    0.0,
                    [0.94, 0.77, 0.38, 1.0],
                );
                entities.push(e);
            }
            if battery > 0.5 {
                let e = self.spawn_box(
                    world,
                    renderer,
                    gpu,
                    ground.add(vec3(-0.55, 0.15, 0.0)),
                    vec3(0.1, 0.3 * (battery / 100.0).clamp(0.05, 1.0), 0.1),
                    0.0,
                    [0.35, 0.8, 0.9, 1.0],
                );
                entities.push(e);
            }
            let lamp = match mode {
                "manual" => [0.35, 0.9, 0.4, 1.0],
                "battery" => [0.35, 0.55, 0.95, 1.0],
                _ => [0.25, 0.25, 0.25, 1.0],
            };
            let e = self.spawn_box(
                world,
                renderer,
                gpu,
                ground.add(vec3(0.0, 0.95, 0.0)),
                vec3(0.08, 0.08, 0.08),
                0.0,
                lamp,
            );
            entities.push(e);
            self.extractors
                .insert(id.to_string(), entities, key, generation);
        }
        self.extractors.sweep(world, generation);

        // ── Placed camps ─────────────────────────────────────────────────
        for row in &store.placed_camps {
            let Some(id) = row.get("campId").and_then(Value::as_str) else {
                continue;
            };
            if row.get("areaId").and_then(Value::as_str) != Some(area_id) {
                continue;
            }
            let (Some(cx), Some(cy)) = (
                row.get("cellX").and_then(Value::as_f64),
                row.get("cellY").and_then(Value::as_f64),
            ) else {
                continue;
            };
            let packing = row
                .get("abandonSecondsRemaining")
                .and_then(Value::as_f64)
                .is_some();
            let key = state_key(&[qf(cx as f32), qf(cy as f32), packing as u64]);
            if self.camps.keep_if_unchanged(world, id, key, generation) {
                continue;
            }
            let wx = (cx as f32 + 0.5) * WORLD_UNITS_PER_CELL;
            let wz = (cy as f32 + 0.5) * WORLD_UNITS_PER_CELL;
            let ground = vec3(wx, terrain.height_at(wx, wz), wz);
            let mut entities = Vec::new();
            const TENT: &str = "assets/world-items/podtent_scout.glb";
            const FIRE: &str = "assets/world-items/campfire_scout.glb";
            // Pack-up presentation: the armed shelter shrinks toward its crate.
            let tent_scale = if packing { 0.6 } else { 1.0 };
            if self.model(renderer, gpu, read, TENT) {
                let placement = Mat4::from_trs(
                    ground,
                    Quat::from_yaw(0.0),
                    vec3(tent_scale, tent_scale, tent_scale),
                );
                self.spawn_model(world, TENT, placement, &mut entities);
            } else {
                self.spawn_missing_marker(world, renderer, gpu, ground, &mut entities);
            }
            let fire_at = ground.add(vec3(1.6, 0.0, 1.2));
            if self.model(renderer, gpu, read, FIRE) {
                let placement =
                    Mat4::from_trs(fire_at, Quat::from_yaw(0.6), vec3(1.15, 1.15, 1.15));
                self.spawn_model(world, FIRE, placement, &mut entities);
            }
            self.camps.insert(id.to_string(), entities, key, generation);
        }
        self.camps.sweep(world, generation);

        // ── Player corpses (built-in body bag; no GLB fetch by design) ───
        for row in &store.player_corpses {
            let Some(id) = row.get("id").and_then(Value::as_str) else {
                continue;
            };
            if row.get("areaId").and_then(Value::as_str) != Some(area_id) {
                continue;
            }
            let (Some(x), Some(y)) = (
                row.get("x").and_then(Value::as_f64),
                row.get("y").and_then(Value::as_f64),
            ) else {
                continue;
            };
            let is_owner = row.get("isOwner").and_then(Value::as_bool).unwrap_or(false);
            let key = state_key(&[qf(x as f32), qf(y as f32), is_owner as u64]);
            if self.corpses.keep_if_unchanged(world, id, key, generation) {
                continue;
            }
            let wx = (x as f32 + 0.5) * WORLD_UNITS_PER_CELL;
            let wz = (y as f32 + 0.5) * WORLD_UNITS_PER_CELL;
            let g = vec3(wx, terrain.height_at(wx, wz), wz);
            let yaw = (fnv1a32(id) % 628) as f32 / 100.0;
            let graphite = [0.16, 0.17, 0.19, 1.0];
            // Own-corpse accent: the established amber; strangers stay brass.
            let strap = if is_owner {
                [0.54, 0.39, 0.13, 1.0]
            } else {
                [0.30, 0.28, 0.26, 1.0]
            };
            let tag = if is_owner {
                [0.91, 0.70, 0.25, 1.0]
            } else {
                [0.69, 0.55, 0.34, 1.0]
            };
            let mut entities = Vec::new();
            let (s, c) = yaw.sin_cos();
            let along = vec3(c, 0.0, -s);
            // Flat-lying body bag + two straps + tag plate.
            entities.push(self.spawn_box(
                world,
                renderer,
                gpu,
                g.add(vec3(0.0, 0.18, 0.0)),
                vec3(1.8, 0.34, 0.72),
                yaw,
                graphite,
            ));
            for side in [0.45f32, -0.45] {
                entities.push(self.spawn_box(
                    world,
                    renderer,
                    gpu,
                    g.add(vec3(along.x * side, 0.37, along.z * side)),
                    vec3(0.08, 0.04, 0.78),
                    yaw,
                    strap,
                ));
            }
            entities.push(self.spawn_box(
                world,
                renderer,
                gpu,
                g.add(vec3(along.x * 0.8, 0.38, along.z * 0.8)),
                vec3(0.16, 0.02, 0.12),
                yaw,
                tag,
            ));
            self.corpses
                .insert(id.to_string(), entities, key, generation);
        }
        self.corpses.sweep(world, generation);

        // ── Farm plots (per-tile soil + growth) ──────────────────────────
        for plot in &store.farm_plots {
            if plot.get("areaId").and_then(Value::as_str) != Some(area_id) {
                continue;
            }
            let parcel = plot
                .get("parcelId")
                .and_then(Value::as_str)
                .unwrap_or("plot");
            let Some(tiles) = plot.get("tiles").and_then(Value::as_array) else {
                continue;
            };
            for tile in tiles {
                let Some(view) = decode_farm_tile(tile) else {
                    continue;
                };
                if !view.tilled && view.growth.is_none() {
                    continue;
                }
                use core::fmt::Write as _;
                self.tile_id_scratch.clear();
                let _ = write!(
                    self.tile_id_scratch,
                    "{parcel}:{}:{}",
                    view.cell_x as i64, view.cell_y as i64
                );
                let key = state_key(&[
                    view.tilled as u64,
                    qf(view.moisture01),
                    view.growth.map(qf).unwrap_or(u64::MAX),
                    view.mature as u64,
                    view.blighted as u64,
                ]);
                let tile_id = core::mem::take(&mut self.tile_id_scratch);
                if self
                    .farm_tiles
                    .keep_if_unchanged(world, &tile_id, key, generation)
                {
                    self.tile_id_scratch = tile_id;
                    continue;
                }
                let wx = (view.cell_x + 0.5) * WORLD_UNITS_PER_CELL;
                let wz = (view.cell_y + 0.5) * WORLD_UNITS_PER_CELL;
                let g = vec3(wx, terrain.height_at(wx, wz), wz);
                let mut entities = Vec::new();
                if view.tilled {
                    // Moist soil reads darker.
                    let m = view.moisture01;
                    let soil = [
                        0.42 + (0.24 - 0.42) * m,
                        0.30 + (0.17 - 0.30) * m,
                        0.20 + (0.12 - 0.20) * m,
                        1.0,
                    ];
                    entities.push(self.spawn_box(
                        world,
                        renderer,
                        gpu,
                        g.add(vec3(0.0, 0.03, 0.0)),
                        vec3(0.94, 0.06, 0.94),
                        0.0,
                        soil,
                    ));
                }
                if let Some(growth) = view.growth {
                    let h = 0.15 + growth * 0.75;
                    let healthy = if view.mature {
                        [0.45, 0.68, 0.25, 1.0]
                    } else {
                        [0.35, 0.58, 0.30, 1.0]
                    };
                    let color = if view.blighted {
                        [0.48, 0.42, 0.22, 1.0]
                    } else {
                        healthy
                    };
                    // Crossed-blade plant marker scaled by growth stage.
                    for (sx, sz) in [(0.08f32, 0.30f32), (0.30, 0.08)] {
                        entities.push(self.spawn_box(
                            world,
                            renderer,
                            gpu,
                            g.add(vec3(0.0, h * 0.5 + 0.06, 0.0)),
                            vec3(sx, h, sz),
                            0.0,
                            color,
                        ));
                    }
                    if view.mature {
                        entities.push(self.spawn_box(
                            world,
                            renderer,
                            gpu,
                            g.add(vec3(0.0, h + 0.14, 0.0)),
                            vec3(0.12, 0.12, 0.12),
                            0.6,
                            [0.9, 0.75, 0.3, 1.0],
                        ));
                    }
                }
                self.farm_tiles.insert(tile_id, entities, key, generation);
            }
        }
        self.farm_tiles.sweep(world, generation);

        // ── Parcels (claimed-land boundary posts) ────────────────────────
        for row in &store.placed_parcels {
            let Some(id) = row.get("parcelId").and_then(Value::as_str) else {
                continue;
            };
            if row.get("areaId").and_then(Value::as_str) != Some(area_id) {
                continue;
            }
            let Some(rect) = row.get("rect") else {
                continue;
            };
            let (Some(x), Some(y), Some(w), Some(h)) = (
                rect.get("x").and_then(Value::as_f64),
                rect.get("y").and_then(Value::as_f64),
                rect.get("w").and_then(Value::as_f64),
                rect.get("h").and_then(Value::as_f64),
            ) else {
                continue;
            };
            let is_owner = row.get("isOwner").and_then(Value::as_bool).unwrap_or(false);
            let key = state_key(&[
                qf(x as f32),
                qf(y as f32),
                qf(w as f32),
                qf(h as f32),
                is_owner as u64,
            ]);
            if self.parcels.keep_if_unchanged(world, id, key, generation) {
                continue;
            }
            let color = if is_owner {
                [0.91, 0.70, 0.25, 1.0]
            } else {
                [0.55, 0.55, 0.5, 1.0]
            };
            let mut entities = Vec::new();
            let corners = [
                (x as f32, y as f32),
                (x as f32 + w as f32, y as f32),
                (x as f32, y as f32 + h as f32),
                (x as f32 + w as f32, y as f32 + h as f32),
            ];
            for (cx, cy) in corners {
                let wx = cx * WORLD_UNITS_PER_CELL;
                let wz = cy * WORLD_UNITS_PER_CELL;
                let g = vec3(wx, terrain.height_at(wx, wz), wz);
                entities.push(self.spawn_box(
                    world,
                    renderer,
                    gpu,
                    g.add(vec3(0.0, 0.55, 0.0)),
                    vec3(0.12, 1.1, 0.12),
                    0.0,
                    color,
                ));
            }
            self.parcels
                .insert(id.to_string(), entities, key, generation);
        }
        self.parcels.sweep(world, generation);

        // ── Player-built structures (Rust-authority building projection) ─
        let components = store
            .building
            .as_ref()
            .and_then(|p| p.get("components"))
            .and_then(Value::as_array);
        if let Some(components) = components {
            for comp in components {
                let Some(id) = comp.get("componentId").and_then(Value::as_str) else {
                    continue;
                };
                if comp.get("areaId").and_then(Value::as_str) != Some(area_id) {
                    continue;
                }
                let (Some(cx), Some(cy)) = (
                    comp.get("cellX").and_then(Value::as_f64),
                    comp.get("cellY").and_then(Value::as_f64),
                ) else {
                    continue;
                };
                let kind = comp.get("kind").and_then(Value::as_str).unwrap_or("wall");
                let quarters = comp
                    .get("rotationQuarters")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0) as i64;
                let door_open = comp
                    .get("doorOpen")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let key = state_key(&[
                    qf(cx as f32),
                    qf(cy as f32),
                    fnv1a32(kind) as u64,
                    quarters as u64,
                    door_open as u64,
                ]);
                if self.building.keep_if_unchanged(world, id, key, generation) {
                    continue;
                }
                let wx = (cx as f32 + 0.5) * WORLD_UNITS_PER_CELL;
                let wz = (cy as f32 + 0.5) * WORLD_UNITS_PER_CELL;
                let g = vec3(wx, terrain.height_at(wx, wz), wz);
                let yaw = quarters as f32 * core::f32::consts::FRAC_PI_2;
                let primary = comp
                    .get("palette")
                    .and_then(|p| p.get("primary"))
                    .and_then(Value::as_str)
                    .map(hex_rgba)
                    .unwrap_or([0.55, 0.5, 0.45, 1.0]);
                let mut entities = Vec::new();
                match kind {
                    "floor" => entities.push(self.spawn_box(
                        world,
                        renderer,
                        gpu,
                        g.add(vec3(0.0, 0.04, 0.0)),
                        vec3(1.0, 0.08, 1.0),
                        yaw,
                        primary,
                    )),
                    "door" => {
                        // Frame posts + a panel that swings open 100°.
                        let (s, c) = yaw.sin_cos();
                        let across = vec3(c, 0.0, -s);
                        for side in [-0.45f32, 0.45] {
                            entities.push(self.spawn_box(
                                world,
                                renderer,
                                gpu,
                                g.add(vec3(across.x * side, 1.1, across.z * side)),
                                vec3(0.12, 2.2, 0.12),
                                yaw,
                                primary,
                            ));
                        }
                        let panel_yaw = if door_open { yaw + 1.75 } else { yaw };
                        let (ps, pc) = panel_yaw.sin_cos();
                        let panel_across = vec3(pc, 0.0, -ps);
                        // Hinge at the -side post; the panel extends across.
                        let hinge = g.add(vec3(across.x * -0.45, 0.0, across.z * -0.45));
                        entities.push(self.spawn_box(
                            world,
                            renderer,
                            gpu,
                            hinge.add(vec3(panel_across.x * 0.42, 1.05, panel_across.z * 0.42)),
                            vec3(0.84, 2.1, 0.08),
                            panel_yaw,
                            [primary[0] * 0.85, primary[1] * 0.85, primary[2] * 0.85, 1.0],
                        ));
                    }
                    "roof" => entities.push(self.spawn_box(
                        world,
                        renderer,
                        gpu,
                        g.add(vec3(0.0, 2.45, 0.0)),
                        vec3(1.04, 0.1, 1.04),
                        yaw,
                        [primary[0] * 0.8, primary[1] * 0.8, primary[2] * 0.8, 1.0],
                    )),
                    // Walls and unrecognized kinds present as a wall slab —
                    // explicit; collision stays authority-owned.
                    _ => entities.push(self.spawn_box(
                        world,
                        renderer,
                        gpu,
                        g.add(vec3(0.0, 1.2, 0.0)),
                        vec3(1.0, 2.4, 0.15),
                        yaw,
                        primary,
                    )),
                }
                self.building
                    .insert(id.to_string(), entities, key, generation);
            }
        }
        self.building.sweep(world, generation);

        // ── Waypoint beam ────────────────────────────────────────────────
        self.waypoint_pulse += dt;
        match self.waypoint {
            Some((sx, sy)) => {
                let wx = (sx + 0.5) * WORLD_UNITS_PER_CELL;
                let wz = (sy + 0.5) * WORLD_UNITS_PER_CELL;
                let base = terrain.height_at(wx, wz);
                let pulse = 0.85 + 0.15 * (self.waypoint_pulse * 2.4).sin();
                if self.waypoint_entity.is_none() {
                    let e = self.spawn_box(
                        world,
                        renderer,
                        gpu,
                        vec3(wx, base + 6.0, wz),
                        vec3(0.18, 12.0, 0.18),
                        0.0,
                        [0.98, 0.78, 0.30, 0.55],
                    );
                    self.waypoint_entity = Some(e);
                }
                if let Some(e) = self.waypoint_entity {
                    if let Some(tr) = world.get_component::<Transform>(e) {
                        tr.pos = vec3(wx, base + 6.0, wz);
                        tr.scale = vec3(0.18 * pulse, 12.0, 0.18 * pulse);
                    }
                }
            }
            None => {
                if let Some(e) = self.waypoint_entity.take() {
                    world.destroy(e);
                }
            }
        }

        world.flush();
    }

    /// Campfire flame emission for live camps (bounded: one particle per camp
    /// per frame into the shared pool, distance-culled).
    pub fn emit_camp_fx(
        &self,
        terrain: &TerrainStreamer,
        store: &AuthorityStore,
        area_id: &str,
        pool: &mut successor_engine_render::fx::ParticlePool,
        listener: [f32; 3],
    ) {
        for row in &store.placed_camps {
            if row.get("areaId").and_then(Value::as_str) != Some(area_id) {
                continue;
            }
            let (Some(cx), Some(cy)) = (
                row.get("cellX").and_then(Value::as_f64),
                row.get("cellY").and_then(Value::as_f64),
            ) else {
                continue;
            };
            let wx = (cx as f32 + 0.5) * WORLD_UNITS_PER_CELL + 1.6;
            let wz = (cy as f32 + 0.5) * WORLD_UNITS_PER_CELL + 1.2;
            let dx = wx - listener[0];
            let dz = wz - listener[2];
            if dx * dx + dz * dz > 60.0 * 60.0 {
                continue; // visual/audible cutoff
            }
            let y = terrain.height_at(wx, wz) + 0.25;
            pool.additive.push(
                [wx, y, wz],
                [0.0, 0.9, 0.0],
                0.7,
                0.16,
                0.05,
                0.8,
                0.0,
                [1.0, 0.62, 0.22],
                [0.7, 0.2, 0.05],
            );
        }
    }
}

fn hex_rgba(s: &str) -> [f32; 4] {
    let h = s.trim_start_matches('#');
    if h.len() >= 6 {
        let r = u8::from_str_radix(&h[0..2], 16).unwrap_or(140) as f32 / 255.0;
        let g = u8::from_str_radix(&h[2..4], 16).unwrap_or(128) as f32 / 255.0;
        let b = u8::from_str_radix(&h[4..6], 16).unwrap_or(115) as f32 / 255.0;
        [r, g, b, 1.0]
    } else {
        [0.55, 0.5, 0.45, 1.0]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn farm_tile_decodes_growth_and_moisture() {
        let tile = json!({
            "cellX": 40, "cellY": 40, "tilled": true, "moisturePct": 50,
            "crop": { "species": "graincorn", "stage": 2, "stageCount": 4,
                      "health": "healthy", "blight": "none", "mature": false },
            "legalVerbs": [],
        });
        let v = decode_farm_tile(&tile).expect("decodes");
        assert!(v.tilled);
        assert!((v.moisture01 - 0.5).abs() < 1e-6);
        assert_eq!(v.growth, Some(0.5));
        assert!(!v.mature);
        assert!(!v.blighted);
    }

    #[test]
    fn farm_tile_blight_and_null_crop() {
        let tile = json!({
            "cellX": 1, "cellY": 2, "tilled": true, "moisturePct": 0, "crop": null,
        });
        let v = decode_farm_tile(&tile).unwrap();
        assert_eq!(v.growth, None);

        let sick = json!({
            "cellX": 1, "cellY": 2, "tilled": true, "moisturePct": 0,
            "crop": { "stage": 4, "stageCount": 4, "blight": "rot", "mature": true },
        });
        let v = decode_farm_tile(&sick).unwrap();
        assert!(v.blighted);
        assert!(v.mature);
        assert_eq!(v.growth, Some(1.0));
    }

    #[test]
    fn malformed_tile_fails_closed() {
        assert_eq!(decode_farm_tile(&json!({ "tilled": true })), None);
        assert_eq!(decode_farm_tile(&json!({ "cellX": "a", "cellY": 2 })), None);
    }

    #[test]
    fn extractor_category_routing() {
        assert_eq!(extractor_category("Ferrous Metals"), "mineral");
        assert_eq!(extractor_category("Reactive Gas"), "gas");
        assert_eq!(extractor_category("Chemical Slurry"), "chemical");
        assert_eq!(extractor_category("Ground Water"), "water");
        assert_eq!(extractor_category(""), "mineral");
    }

    #[test]
    fn state_keys_differ_on_state_change() {
        let a = state_key(&[qf(1.0), qf(2.0), 0]);
        let b = state_key(&[qf(1.0), qf(2.0), 1]);
        let c = state_key(&[qf(1.0), qf(2.0), 0]);
        assert_ne!(a, b);
        assert_eq!(a, c);
    }
}
