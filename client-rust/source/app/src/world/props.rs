//! World prop placement — port of `client-3d/src/render/props.ts` core: resolve
//! each slice prop through `props-mapping.json` (assetKey then kind), load+bake
//! its GLB once (recentered on its footprint, uniform-scaled to the cell
//! footprint), and spawn one entity per instance. Props are area-scoped (the
//! reference `propsForArea`), GLBs resolve through a stable-id byte reader
//! (platform asset read — no filesystem assumptions here), spawned entities
//! are tracked so an area transition can release them, and a mapped GLB that
//! fails to load renders the explicit missing-asset marker plus a typed
//! [`WorldAssetIssue`]. Unmapped/`placeholder` kinds render a tinted box;
//! `skip` kinds are ignored.

use std::collections::HashMap;

use serde_json::Value;

use super::cutaway::{self, CutawayState, RegionMilli};
use super::streamed::WorldAssetIssue;
use crate::GameWorld;
use successor_engine_core::ecs::{Entity, WorldOps};
use successor_engine_core::glb::{self, GlbDocument};
use successor_engine_core::json::Json;
use successor_engine_core::math::{vec3, Mat4, Quat, Vec3};
use successor_engine_render::components::{
    HeightCutaway, MaterialId, MeshId, MeshRenderer, SkinRef, Transform,
};
use successor_engine_render::gi::GiOccluder;
use successor_engine_render::gpu::Gpu;
use successor_engine_render::model::upload_glb;
use successor_engine_render::renderer::Renderer;

/// A distinct GLB uploaded once: its parts (mesh+material) and measured XZ
/// footprint (post-recenter), used to fit instances to their cell size.
#[derive(Clone, Copy)]
struct PropPart {
    mesh: MeshId,
    material: MaterialId,
    local: Mat4,
    /// Source GLB node, retained so per-placement metadata can select only
    /// authored roof/wall/door parts after the model is cached.
    node_index: usize,
}

struct PropModel {
    parts: Vec<PropPart>,
    /// Names and ancestry stay alongside the baked parts; GLB node identity
    /// must survive upload because enterable metadata names source nodes.
    node_names: Vec<Option<String>>,
    node_parents: Vec<Option<usize>>,
    footprint_x: f32,
    footprint_z: f32,
    /// Post-recenter AABB height (min-Y..max-Y), for the GI occluder proxy.
    height_y: f32,
    /// Index-weighted mean base color, for the GI occluder proxy.
    mean_albedo: [f32; 3],
}
struct EnterableProp {
    entities: Vec<Entity>,
    region: crate::world::cutaway::RegionMilli,
    state: crate::world::cutaway::CutawayState,
    fade_seconds: f64,
}

#[derive(Clone, Copy)]
struct PlacedPart {
    part: PropPart,
    reveal: bool,
    door: bool,
}

/// A roof or wall entity selected by authored enterable metadata.
#[derive(Clone, Copy)]
struct RevealEntity {
    entity: Entity,
}

#[derive(Clone, Copy)]
struct DoorPart {
    entity: Entity,
    /// The decomposed placement * baked-local pose, copied verbatim on close.
    closed: Transform,
    /// Fully-open pose calculated once at placement, never per frame.
    open: Transform,
}

struct DoorInstance {
    prop_id: String,
    open: bool,
    parts: Vec<DoorPart>,
}

struct EnterableInstance {
    cell_x: f32,
    cell_z: f32,
    regions: Vec<RegionMilli>,
    reveal: Vec<RevealEntity>,
    cutaway: CutawayState,
    fade_seconds: f64,
}

#[derive(Clone, Copy)]
struct SlideDoor<'a> {
    node: &'a str,
    axis: Vec3,
    distance: f32,
}

pub struct PropsLoader {
    mapping: Json,
    asset_base: String,
    cache: HashMap<String, Option<PropModel>>,
    /// Entities spawned by the last `load` calls (released by `clear`).
    spawned: Vec<Entity>,
    /// Area-local cutaway state and its explicitly selected render entities.
    enterables: Vec<EnterableInstance>,
    /// Legacy whole-prop height cutaways for mappings without reveal prefixes.
    height_cutaways: Vec<EnterableProp>,
    /// Area-local door state and closed/open transforms.
    doors: Vec<DoorInstance>,
    /// Typed optional-asset degradation (bounded, deduped).
    issues: Vec<WorldAssetIssue>,
}

const MAX_PROP_ISSUES: usize = 32;
/// Explicit missing-asset marker tint (matches the streamed-world pylon).
const MISSING_TINT: [f32; 4] = [0.9, 0.15, 0.75, 1.0];
/// Clear the wall slightly above the normalized adult pawn's head.
const CUTAWAY_HEAD_CLEARANCE_METERS: f32 = 0.2;

impl PropsLoader {
    #[allow(clippy::result_unit_err)]
    pub fn new(mapping_json: &str) -> Result<Self, ()> {
        let mapping = Json::parse(mapping_json).map_err(|_| ())?;
        let asset_base = mapping
            .get("assetBase")
            .and_then(Json::as_str)
            .unwrap_or("/assets/world-items/")
            .to_string();
        Ok(PropsLoader {
            mapping,
            asset_base,
            cache: HashMap::new(),
            spawned: Vec::new(),
            enterables: Vec::new(),
            height_cutaways: Vec::new(),
            doors: Vec::new(),
            issues: Vec::new(),
        })
    }

    /// Typed degradation log (each missing model recorded once).
    pub fn issues(&self) -> &[WorldAssetIssue] {
        &self.issues
    }

    fn record(&mut self, issue: WorldAssetIssue) {
        if self.issues.len() < MAX_PROP_ISSUES && !self.issues.contains(&issue) {
            self.issues.push(issue);
        }
    }

    /// Release every entity and area-local presentation record from prior
    /// `load` calls (area transition).
    pub fn clear(&mut self, world: &mut GameWorld) {
        for e in self.spawned.drain(..) {
            world.destroy(e);
        }
        self.enterables.clear();
        self.height_cutaways.clear();
        self.doors.clear();
        world.flush();
    }

    fn entry(&self, key: &str) -> Option<&Json> {
        self.mapping.get("entries").and_then(|e| e.get(key))
    }

    /// True once either cutaway path has stably entered a placed interior.
    /// This is intentionally independent of fade progress.
    pub fn player_inside_enterable(&self) -> bool {
        self.enterables
            .iter()
            .any(|enterable| enterable.cutaway.inside)
            || self
                .height_cutaways
                .iter()
                .any(|enterable| enterable.state.inside)
    }

    /// Synchronize area-local enterable and door presentation from accepted
    /// authority data. Cutaway updates reuse placement-time component storage.
    pub fn sync_enterable_presentation(
        &mut self,
        world: &mut GameWorld,
        snapshot_tick: u64,
        player_world_x: f32,
        player_world_y: f32,
        player_world_z: f32,
        prop_states: &HashMap<String, Value>,
        dt: f32,
    ) {
        let player_cell_x = player_world_x / WORLD_UNITS_PER_CELL;
        let player_cell_z = player_world_z / WORLD_UNITS_PER_CELL;
        for enterable in &mut self.enterables {
            let amount = sample_enterable(
                &mut enterable.cutaway,
                snapshot_tick,
                &enterable.regions,
                enterable.cell_x,
                enterable.cell_z,
                player_cell_x,
                player_cell_z,
                enterable.fade_seconds,
                dt,
            );
            for record in &enterable.reveal {
                world.set_component(
                    record.entity,
                    HeightCutaway {
                        cutoff_y: player_head_cutoff_y(player_world_y),
                        amount,
                    },
                );
            }
        }
        for door in &mut self.doors {
            let open = prop_states
                .get(&door.prop_id)
                .and_then(|state| state.get("doorOpen"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if open == door.open {
                continue;
            }
            door.open = open;
            for part in &door.parts {
                if let Some(transform) = world.get_component::<Transform>(part.entity) {
                    *transform = door_pose(part.closed, part.open, open);
                }
            }
        }
    }

    /// Place every visible prop of one area from a parsed slice into the
    /// world. `area_id = None` places every area (developer world demo);
    /// connected rendering always scopes to the accepted active area. `read`
    /// resolves stable asset ids (`assets/world-items/*.glb`) to bytes.
    #[allow(clippy::too_many_arguments)]
    pub fn load<G: Gpu>(
        &mut self,
        world: &mut GameWorld,
        renderer: &mut Renderer,
        gpu: &mut G,
        slice: &Json,
        terrain: &TerrainStreamer,
        area_id: Option<&str>,
        read: &mut dyn FnMut(&str) -> Option<Vec<u8>>,
        mask: u32,
    ) -> usize {
        let Some(props) = slice.get("props").and_then(Json::as_array) else {
            return 0;
        };
        let mut placed = 0;
        let mut occ: Vec<GiOccluder> = Vec::new();
        for prop in props {
            if prop.get("visible").and_then(Json::as_bool) == Some(false) {
                continue;
            }
            if let Some(area) = area_id {
                if prop.get("areaId").and_then(Json::as_str) != Some(area) {
                    continue;
                }
            }
            let asset_key = prop.get("assetKey").and_then(Json::as_str);
            let kind = prop.get("kind").and_then(Json::as_str);
            // Resolve mapping: assetKey first, then kind.
            let entry = asset_key
                .and_then(|k| self.entry(k))
                .or_else(|| kind.and_then(|k| self.entry(k)))
                .cloned();

            let id = prop.get("id").and_then(Json::as_str).unwrap_or("");
            let (cell_x, cell_z) = prop
                .get("cell")
                .map(|cell| {
                    (
                        cell.get("x").and_then(Json::as_f32).unwrap_or(0.0),
                        cell.get("y").and_then(Json::as_f32).unwrap_or(0.0),
                    )
                })
                .unwrap_or((0.0, 0.0));
            let cx = cell_x * WORLD_UNITS_PER_CELL;
            let cy = cell_z * WORLD_UNITS_PER_CELL;
            let (size_w_cells, size_h_cells) = prop
                .get("size")
                .map(|size| {
                    (
                        size.get("w").and_then(Json::as_f32).unwrap_or(1.0),
                        size.get("h").and_then(Json::as_f32).unwrap_or(1.0),
                    )
                })
                .unwrap_or((1.0, 1.0));
            let sw = size_w_cells * WORLD_UNITS_PER_CELL;
            let sh = size_h_cells * WORLD_UNITS_PER_CELL;
            let rotation = prop.get("rotation").and_then(Json::as_f32).unwrap_or(0.0);

            let Some(entry) = entry else { continue };
            if entry.get("skip").and_then(Json::as_bool) == Some(true) {
                continue;
            }
            let random_yaw = entry
                .get("randomYaw")
                .and_then(Json::as_bool)
                .unwrap_or(false);

            if let Some(glb_ref) = entry.get("glb").and_then(Json::as_str) {
                if !self.ensure_model(renderer, gpu, read, glb_ref) {
                    // Never invisible: the mapped model failed to load, so the
                    // instance renders the explicit missing-asset marker.
                    let ground_x = cx + sw / 2.0;
                    let ground_z = cy + sh / 2.0;
                    let ground_y = terrain.height_at(ground_x, ground_z);
                    let mesh = placeholder_cube(renderer, gpu);
                    let material = renderer.add_material_desc(
                        successor_engine_render::renderer::MaterialDesc {
                            base_color: MISSING_TINT,
                            ..successor_engine_render::renderer::MaterialDesc::default()
                        },
                    );
                    let e = world.spawn();
                    world.set_component(
                        e,
                        Transform {
                            pos: vec3(ground_x, ground_y + 0.6, ground_z),
                            rot: Quat::from_yaw(core::f32::consts::FRAC_PI_4),
                            scale: vec3(0.35, 1.2, 0.35),
                        },
                    );
                    world.set_component(
                        e,
                        MeshRenderer {
                            mesh,
                            material,
                            viewport_mask: mask,
                            skin: SkinRef::NONE,
                        },
                    );
                    self.spawned.push(e);
                    continue;
                }
                let enterable = entry.get("enterable");
                let reveal_prefixes = enterable.and_then(enterable_reveal_prefixes);
                let slide_door = parse_slide_door(&entry);
                let (fx, fz, hy, alb, parts) = {
                    let model = self.cache.get(glb_ref).unwrap().as_ref().unwrap();
                    let parts: Vec<PlacedPart> = model
                        .parts
                        .iter()
                        .copied()
                        .map(|part| PlacedPart {
                            reveal: reveal_prefixes.is_some_and(|prefixes| {
                                part_matches_reveal_prefixes(
                                    &model.node_names,
                                    &model.node_parents,
                                    part.node_index,
                                    prefixes,
                                    slide_door.map(|door| door.node),
                                )
                            }),
                            door: slide_door.is_some_and(|door| {
                                node_or_ancestor_matches(
                                    &model.node_names,
                                    &model.node_parents,
                                    part.node_index,
                                    |name| name == door.node,
                                )
                            }),
                            part,
                        })
                        .collect();
                    (
                        model.footprint_x,
                        model.footprint_z,
                        model.height_y,
                        model.mean_albedo,
                        parts,
                    )
                };
                let (fit_x, fit_z) = fit_footprint(&entry, fx, fz);
                let (yaw, scale) = placement(rotation, random_yaw, id, sw, sh, fit_x, fit_z);
                let ground_x = cx + sw / 2.0;
                let ground_z = cy + sh / 2.0;
                let pos = vec3(ground_x, terrain.height_at(ground_x, ground_z), ground_z);
                let initial_cutoff_y = player_head_cutoff_y(pos.y);

                let mut instance_entities = if enterable.is_some() && reveal_prefixes.is_none() {
                    Some(Vec::with_capacity(parts.len()))
                } else {
                    None
                };
                let placement = Mat4::from_trs(pos, Quat::from_yaw(yaw), vec3(scale, scale, scale));
                let mut reveal = Vec::new();
                let mut door_parts = Vec::new();
                for placed_part in parts {
                    let part = placed_part.part;
                    let (part_pos, part_rot, part_scale) = placement.mul(part.local).to_trs();
                    let transform = Transform {
                        pos: part_pos,
                        rot: part_rot,
                        scale: part_scale,
                    };
                    let e = world.spawn();
                    self.spawned.push(e);
                    if let Some(entities) = instance_entities.as_mut() {
                        entities.push(e);
                    }
                    world.set_component(e, transform);
                    let mesh_renderer = MeshRenderer {
                        mesh: part.mesh,
                        material: part.material,
                        viewport_mask: mask,
                        skin: SkinRef::NONE,
                    };
                    world.set_component(e, mesh_renderer);
                    if placed_part.reveal {
                        world.set_component(
                            e,
                            HeightCutaway {
                                cutoff_y: initial_cutoff_y,
                                amount: 0.0,
                            },
                        );
                        reveal.push(RevealEntity { entity: e });
                    } else if instance_entities.is_some() {
                        world.set_component(
                            e,
                            HeightCutaway {
                                cutoff_y: initial_cutoff_y,
                                amount: 0.0,
                            },
                        );
                    }
                    if placed_part.door {
                        if let Some(door) = slide_door {
                            door_parts.push(DoorPart {
                                entity: e,
                                closed: transform,
                                open: door_open_transform(
                                    transform,
                                    yaw,
                                    scale,
                                    door.axis,
                                    door.distance,
                                ),
                            });
                        }
                    }
                }
                if let (Some(enterable), Some(_)) = (enterable, reveal_prefixes) {
                    self.enterables.push(EnterableInstance {
                        cell_x,
                        cell_z,
                        regions: placed_interior_regions(prop, size_w_cells, size_h_cells),
                        reveal,
                        cutaway: CutawayState::default(),
                        fade_seconds: enterable_fade_seconds(enterable),
                    });
                }
                if !door_parts.is_empty() {
                    self.doors.push(DoorInstance {
                        prop_id: id.to_string(),
                        open: false,
                        parts: door_parts,
                    });
                }
                if let (Some(enterable), Some(entities)) = (enterable, instance_entities) {
                    self.height_cutaways.push(EnterableProp {
                        entities,
                        region: RegionMilli {
                            x_milli: cx as f64 * 1000.0,
                            y_milli: cy as f64 * 1000.0,
                            w_milli: sw as f64 * 1000.0,
                            h_milli: sh as f64 * 1000.0,
                        },
                        state: CutawayState::default(),
                        fade_seconds: enterable_fade_seconds(enterable),
                    });
                }
                occ.push(GiOccluder {
                    center: [pos.x, pos.y + hy * scale * 0.5, pos.z],
                    half_extents: [fx * scale * 0.5, hy * scale * 0.5, fz * scale * 0.5],
                    yaw,
                    albedo: alb,
                });
                placed += 1;
            } else if let Some(ph) = entry.get("placeholder") {
                let height = ph.get("height").and_then(Json::as_f32).unwrap_or(0.8);
                let tint = ph
                    .get("tint")
                    .and_then(Json::as_str)
                    .map(parse_hex)
                    .unwrap_or([0.43, 0.4, 0.34, 1.0]);
                let (yaw, _) = placement(rotation, random_yaw, id, sw, sh, 1.0, 1.0);
                let ground_x = cx + sw / 2.0;
                let ground_z = cy + sh / 2.0;
                let ground_y = terrain.height_at(ground_x, ground_z);
                let mesh = placeholder_cube(renderer, gpu);
                let material =
                    renderer.add_material_desc(successor_engine_render::renderer::MaterialDesc {
                        base_color: tint,
                        blend: (tint)[3] < 1.0,
                        ..successor_engine_render::renderer::MaterialDesc::default()
                    });
                let e = world.spawn();
                self.spawned.push(e);
                world.set_component(
                    e,
                    Transform {
                        pos: vec3(ground_x, ground_y + height / 2.0, ground_z),
                        rot: Quat::from_yaw(yaw),
                        scale: vec3(sw.max(0.5), height, sh.max(0.5)),
                    },
                );
                world.set_component(
                    e,
                    MeshRenderer {
                        mesh,
                        material,
                        viewport_mask: mask,
                        skin: SkinRef::NONE,
                    },
                );
                occ.push(GiOccluder {
                    center: [ground_x, ground_y + height * 0.5, ground_z],
                    half_extents: [sw.max(0.5) * 0.5, height * 0.5, sh.max(0.5) * 0.5],
                    yaw,
                    albedo: [tint[0], tint[1], tint[2]],
                });
                placed += 1;
            }
        }
        renderer.gi_set_occluders(&occ);
        placed
    }

    /// Update authored enterable props from the authoritative local player.
    pub fn update_cutaways(
        &mut self,
        world: &mut GameWorld,
        tick: u64,
        player_x: f32,
        player_y: f32,
        player_ground_y: f32,
        dt: f32,
    ) {
        for enterable in &mut self.height_cutaways {
            crate::world::cutaway::sample(
                &mut enterable.state,
                tick as f64,
                &[enterable.region],
                player_x as f64 * 1000.0,
                player_y as f64 * 1000.0,
            );
            let amount = crate::world::cutaway::advance_fade(
                &mut enterable.state,
                dt as f64,
                enterable.fade_seconds,
                false,
            ) as f32;
            for entity in &enterable.entities {
                world.set_component(
                    *entity,
                    HeightCutaway {
                        cutoff_y: player_head_cutoff_y(player_ground_y),
                        amount,
                    },
                );
            }
        }
    }

    /// Ensure a model is cached; `true` when loaded, `false` → typed miss
    /// (recorded once; the miss itself is cached so it is not re-read).
    fn ensure_model<G: Gpu>(
        &mut self,
        renderer: &mut Renderer,
        gpu: &mut G,
        read: &mut dyn FnMut(&str) -> Option<Vec<u8>>,
        glb_ref: &str,
    ) -> bool {
        if let Some(slot) = self.cache.get(glb_ref) {
            return slot.is_some();
        }
        // Public path (`/assets/world-items/foo.glb`) → stable asset id.
        let public = if glb_ref.starts_with('/') {
            glb_ref.to_string()
        } else {
            format!("{}{}", self.asset_base, glb_ref)
        };
        let stable_id = public.trim_start_matches('/').to_string();
        let model = read(&stable_id)
            .and_then(|bytes| glb::parse(&bytes).ok())
            .and_then(|doc| upload_model(renderer, gpu, &doc));
        if model.is_none() {
            self.record(WorldAssetIssue::MissingModel { stable_id });
        }
        let loaded = model.is_some();
        self.cache.insert(glb_ref.to_string(), model);
        loaded
    }
}

/// `enterable` opts an entry into the current presentation convention only
/// when it supplies actual, non-empty node prefixes. Legacy mappings therefore
/// retain their old presentation rather than falling back to a whole-prop hide.
fn enterable_reveal_prefixes(enterable: &Json) -> Option<&[Json]> {
    let prefixes = enterable.get("revealPrefixes").and_then(Json::as_array)?;
    prefixes
        .iter()
        .filter_map(Json::as_str)
        .any(|prefix| !prefix.is_empty())
        .then_some(prefixes)
}

fn enterable_fade_seconds(enterable: &Json) -> f64 {
    let seconds = enterable
        .get("fadeSeconds")
        .and_then(Json::as_f64)
        .unwrap_or(0.25);
    if seconds.is_finite() {
        seconds.max(0.01)
    } else {
        0.25
    }
}

fn player_head_cutoff_y(player_ground_y: f32) -> f32 {
    player_ground_y + crate::world::ADULT_PAWN_HEIGHT_METERS + CUTAWAY_HEAD_CLEARANCE_METERS
}

fn parse_slide_door(entry: &Json) -> Option<SlideDoor<'_>> {
    let door = entry.get("slideDoor")?;
    let node = door.get("node").and_then(Json::as_str)?;
    if node.is_empty() {
        return None;
    }
    let axis = door.get("axisLocal").and_then(Json::as_array)?;
    if axis.len() != 3 {
        return None;
    }
    let axis = vec3(axis[0].as_f32()?, axis[1].as_f32()?, axis[2].as_f32()?);
    if !axis.x.is_finite() || !axis.y.is_finite() || !axis.z.is_finite() {
        return None;
    }
    let axis = axis.normalize();
    if axis == Vec3::ZERO {
        return None;
    }
    let distance = door.get("distance").and_then(Json::as_f32)?;
    if !distance.is_finite() || distance <= 0.0 {
        return None;
    }
    Some(SlideDoor {
        node,
        axis,
        distance,
    })
}

/// Top-level `interiorRegions` is the placed collision authoring; nested
/// `enterable.interiorBounds` is the compatible snapshot form. Both are
/// post-rotation prop-local milli-cell AABBs, so sampling must not rotate them
/// again. A mapped enterable with neither retains the legacy footprint region.
fn placed_interior_regions(prop: &Json, size_w_cells: f32, size_h_cells: f32) -> Vec<RegionMilli> {
    let mut regions = Vec::new();
    if let Some(values) = prop.get("interiorRegions").and_then(Json::as_array) {
        append_regions(&mut regions, values);
    }
    if regions.is_empty() {
        if let Some(values) = prop
            .get("enterable")
            .and_then(|enterable| enterable.get("interiorBounds"))
            .and_then(Json::as_array)
        {
            append_regions(&mut regions, values);
        }
    }
    if regions.is_empty() {
        let w_milli = f64::from(size_w_cells).max(0.0) * 1000.0;
        let h_milli = f64::from(size_h_cells).max(0.0) * 1000.0;
        if w_milli > 0.0 && h_milli > 0.0 {
            regions.push(RegionMilli {
                x_milli: 0.0,
                y_milli: 0.0,
                w_milli,
                h_milli,
            });
        }
    }
    regions
}

fn append_regions(out: &mut Vec<RegionMilli>, values: &[Json]) {
    for value in values {
        let (Some(x_milli), Some(y_milli), Some(w_milli), Some(h_milli)) = (
            value.get("xMilli").and_then(Json::as_f64),
            value.get("yMilli").and_then(Json::as_f64),
            value.get("wMilli").and_then(Json::as_f64),
            value.get("hMilli").and_then(Json::as_f64),
        ) else {
            continue;
        };
        if x_milli.is_finite()
            && y_milli.is_finite()
            && w_milli.is_finite()
            && h_milli.is_finite()
            && w_milli > 0.0
            && h_milli > 0.0
        {
            out.push(RegionMilli {
                x_milli,
                y_milli,
                w_milli,
                h_milli,
            });
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn sample_enterable(
    state: &mut CutawayState,
    snapshot_tick: u64,
    regions: &[RegionMilli],
    cell_x: f32,
    cell_z: f32,
    player_cell_x: f32,
    player_cell_z: f32,
    fade_seconds: f64,
    dt: f32,
) -> f32 {
    cutaway::sample(
        state,
        snapshot_tick as f64,
        regions,
        (f64::from(player_cell_x) - f64::from(cell_x)) * 1000.0,
        (f64::from(player_cell_z) - f64::from(cell_z)) * 1000.0,
    );
    cutaway::advance_fade(state, f64::from(dt), fade_seconds, false) as f32
}

/// Applies the placement's yaw and uniform fit scale to a node-local door
/// axis. The supplied closed transform is never recomputed, so closing writes
/// its exact original bytes back to the entity.
fn door_open_transform(
    closed: Transform,
    placement_yaw: f32,
    placement_scale: f32,
    axis_local: Vec3,
    distance: f32,
) -> Transform {
    let offset = Mat4::from_trs(
        Vec3::ZERO,
        Quat::from_yaw(placement_yaw),
        vec3(placement_scale, placement_scale, placement_scale),
    )
    .transform_point(axis_local.normalize().scale(distance));
    Transform {
        pos: closed.pos.add(offset),
        ..closed
    }
}

fn door_pose(closed: Transform, open: Transform, is_open: bool) -> Transform {
    if is_open {
        open
    } else {
        closed
    }
}

/// Prefix selection walks GLB ancestry so a mesh beneath a named group is
/// selected. Floors and gameplay doors are never reveal candidates, even if a
/// malformed mapping happens to mention their parent group.
fn part_matches_reveal_prefixes(
    node_names: &[Option<String>],
    node_parents: &[Option<usize>],
    node_index: usize,
    prefixes: &[Json],
    door_node: Option<&str>,
) -> bool {
    if node_or_ancestor_matches(node_names, node_parents, node_index, |name| {
        name.starts_with("door_slide") || door_node.is_some_and(|door| name == door)
    }) {
        return false;
    }
    if node_or_ancestor_matches(node_names, node_parents, node_index, |name| {
        ascii_contains_ignore_case(name, "floor")
    }) {
        return false;
    }
    node_or_ancestor_matches(node_names, node_parents, node_index, |name| {
        prefixes
            .iter()
            .filter_map(Json::as_str)
            .any(|prefix| !prefix.is_empty() && name.starts_with(prefix))
    })
}

fn node_or_ancestor_matches(
    node_names: &[Option<String>],
    node_parents: &[Option<usize>],
    node_index: usize,
    mut matches: impl FnMut(&str) -> bool,
) -> bool {
    let mut current = Some(node_index);
    for _ in 0..node_names.len() {
        let Some(index) = current else {
            break;
        };
        if let Some(Some(name)) = node_names.get(index) {
            if matches(name) {
                return true;
            }
        }
        current = node_parents.get(index).copied().flatten();
    }
    false
}

fn ascii_contains_ignore_case(haystack: &str, needle: &str) -> bool {
    let needle = needle.as_bytes();
    haystack.as_bytes().windows(needle.len()).any(|candidate| {
        candidate
            .iter()
            .zip(needle)
            .all(|(left, right)| left.to_ascii_lowercase() == right.to_ascii_lowercase())
    })
}

/// Build visual-ground and detail-scatter exclusions from authoritative
/// building cells. Small props do not flatten the landscape; only structures
/// whose placement contract owns a footprint do. `area_id = None` spans every
/// area (developer demo); connected use scopes to the active area.
pub fn building_terrain_exclusions(
    slice: &Json,
    area_id: Option<&str>,
    padding: f32,
) -> Vec<TerrainExclusion> {
    let Some(props) = slice.get("props").and_then(Json::as_array) else {
        return Vec::new();
    };
    let padding = padding.max(0.0);
    let mut exclusions = Vec::new();
    for prop in props {
        if prop.get("visible").and_then(Json::as_bool) == Some(false)
            || prop.get("kind").and_then(Json::as_str) != Some("building")
        {
            continue;
        }
        if let Some(area) = area_id {
            if prop.get("areaId").and_then(Json::as_str) != Some(area) {
                continue;
            }
        }
        let Some(cell) = prop.get("cell") else {
            continue;
        };
        let cx = cell.get("x").and_then(Json::as_f32).unwrap_or(0.0) * WORLD_UNITS_PER_CELL;
        let cz = cell.get("y").and_then(Json::as_f32).unwrap_or(0.0) * WORLD_UNITS_PER_CELL;
        let (width, depth) = prop
            .get("size")
            .map(|size| {
                (
                    size.get("w").and_then(Json::as_f32).unwrap_or(1.0) * WORLD_UNITS_PER_CELL,
                    size.get("h").and_then(Json::as_f32).unwrap_or(1.0) * WORLD_UNITS_PER_CELL,
                )
            })
            .unwrap_or((1.0, 1.0));
        exclusions.push(TerrainExclusion {
            min: [cx - padding, cz - padding],
            max: [cx + width + padding, cz + depth + padding],
            feather: 3.0,
        });
    }
    exclusions
}

fn fit_footprint(entry: &Json, measured_x: f32, measured_z: f32) -> (f32, f32) {
    let Some(values) = entry.get("fitFootprintM").and_then(Json::as_array) else {
        return (measured_x, measured_z);
    };
    if values.len() != 2 {
        return (measured_x, measured_z);
    }
    let (Some(x), Some(z)) = (values[0].as_f32(), values[1].as_f32()) else {
        return (measured_x, measured_z);
    };
    if x > 0.0 && z > 0.0 {
        (x, z)
    } else {
        (measured_x, measured_z)
    }
}

/// composePlacement: yaw + uniform fit scale.
fn placement(
    rotation: f32,
    random_yaw: bool,
    id: &str,
    sw: f32,
    sh: f32,
    fx: f32,
    fz: f32,
) -> (f32, f32) {
    let deg2rad = core::f32::consts::PI / 180.0;
    let swap = rotation == 90.0 || rotation == 270.0;
    let target_w = if swap { sh } else { sw };
    let target_d = if swap { sw } else { sh };
    let use_random = random_yaw && rotation == 0.0;
    let yaw = if rotation != 0.0 {
        -rotation * deg2rad
    } else if use_random {
        hash_yaw(id)
    } else {
        0.0
    };
    let fit_w = if use_random {
        target_w.min(target_d)
    } else {
        target_w
    };
    let fit_d = if use_random {
        target_w.min(target_d)
    } else {
        target_d
    };
    let scale = (fit_w / fx.max(1e-3)).min(fit_d / fz.max(1e-3));
    (yaw, scale)
}

/// FNV-1a over the id → yaw in [0, 2π).
fn hash_yaw(id: &str) -> f32 {
    let mut hash: u32 = 2166136261;
    for b in id.bytes() {
        hash ^= b as u32;
        hash = hash.wrapping_mul(16777619);
    }
    (hash % 3600) as f32 * (core::f32::consts::PI / 1800.0)
}

/// Bake all static primitives (node globals applied), recenter on the footprint
/// (XZ center → 0, min-Y → 0), and upload. Returns parts + XZ footprint.
fn upload_model<G: Gpu>(
    renderer: &mut Renderer,
    gpu: &mut G,
    doc: &GlbDocument,
) -> Option<PropModel> {
    let globals = node_globals(doc);
    let node_names = doc.nodes.iter().map(|node| node.name.clone()).collect();
    let parents = node_parents(doc);
    // First pass: AABB over baked positions.
    let mut min = vec3(f32::MAX, f32::MAX, f32::MAX);
    let mut max = vec3(f32::MIN, f32::MIN, f32::MIN);
    for (ni, node) in doc.nodes.iter().enumerate() {
        let Some(mi) = node.mesh else { continue };
        let Some(mesh) = doc.meshes.get(mi) else {
            continue;
        };
        for prim in &mesh.primitives {
            for p in &prim.positions {
                let w = globals[ni].transform_point(vec3(p[0], p[1], p[2]));
                min = vec3(min.x.min(w.x), min.y.min(w.y), min.z.min(w.z));
                max = vec3(max.x.max(w.x), max.y.max(w.y), max.z.max(w.z));
            }
        }
    }
    if min.x > max.x {
        return None;
    }
    let cx = (min.x + max.x) * 0.5;
    let cz = (min.z + max.z) * 0.5;
    let offset = vec3(-cx, -min.y, -cz);

    let uploaded = upload_glb(renderer, gpu, doc).ok()?;

    // Accumulate a mean albedo (weighted by index count) for the GI occluder proxy.
    let mut albedo_sum = [0.0f32; 3];
    let mut albedo_weight = 0.0f32;

    let mut parts = Vec::new();
    let recenter = Mat4::from_translation(offset);
    for (node_index, node) in doc.nodes.iter().enumerate() {
        let Some(mesh_index) = node.mesh else {
            continue;
        };
        for primitive in uploaded
            .primitives
            .iter()
            .filter(|primitive| primitive.source_mesh == mesh_index)
        {
            let source = doc
                .meshes
                .get(mesh_index)
                .and_then(|mesh| mesh.primitives.get(primitive.source_primitive));
            let base = source
                .and_then(|primitive| primitive.material)
                .and_then(|material| doc.materials.get(material))
                .map(|material| material.base_color)
                .unwrap_or([0.7, 0.68, 0.64, 1.0]);
            let weight = source.map_or(0.0, |primitive| primitive.indices.len() as f32);
            albedo_sum[0] += base[0] * weight;
            albedo_sum[1] += base[1] * weight;
            albedo_sum[2] += base[2] * weight;
            albedo_weight += weight;
            parts.push(PropPart {
                mesh: primitive.mesh,
                material: primitive.material,
                local: recenter.mul(globals[node_index]),
                node_index,
            });
        }
    }
    let mean_albedo = if albedo_weight > 0.0 {
        [
            albedo_sum[0] / albedo_weight,
            albedo_sum[1] / albedo_weight,
            albedo_sum[2] / albedo_weight,
        ]
    } else {
        [0.7, 0.68, 0.64]
    };
    Some(PropModel {
        parts,
        node_names,
        node_parents: parents,
        footprint_x: (max.x - min.x).max(0.01),
        footprint_z: (max.z - min.z).max(0.01),
        height_y: (max.y - min.y).max(0.01),
        mean_albedo,
    })
}

fn node_globals(doc: &GlbDocument) -> Vec<Mat4> {
    let n = doc.nodes.len();
    let mut globals = vec![Mat4::IDENTITY; n];
    let mut done = vec![false; n];
    let mut roots = doc.scene_roots.clone();
    if roots.is_empty() {
        let mut has_parent = vec![false; n];
        for node in &doc.nodes {
            for &c in &node.children {
                if c < n {
                    has_parent[c] = true;
                }
            }
        }
        roots = (0..n).filter(|&i| !has_parent[i]).collect();
    }
    let mut stack: Vec<(usize, Mat4)> = roots.iter().map(|&r| (r, Mat4::IDENTITY)).collect();
    while let Some((idx, parent)) = stack.pop() {
        if idx >= n || done[idx] {
            continue;
        }
        done[idx] = true;
        let g = parent.mul(doc.nodes[idx].local_matrix());
        globals[idx] = g;
        for &c in &doc.nodes[idx].children {
            stack.push((c, g));
        }
    }
    globals
}

fn node_parents(doc: &GlbDocument) -> Vec<Option<usize>> {
    let mut parents = vec![None; doc.nodes.len()];
    for (parent, node) in doc.nodes.iter().enumerate() {
        for &child in &node.children {
            if child < parents.len() && parents[child].is_none() {
                parents[child] = Some(parent);
            }
        }
    }
    parents
}

fn placeholder_cube<G: Gpu>(renderer: &mut Renderer, gpu: &mut G) -> MeshId {
    // Unit cube centered at origin, base at y=-0.5; scaled by the caller.
    let (v, i) = successor_engine_render::primitives::cube();
    renderer.upload_mesh(gpu, &v, &i)
}

fn parse_hex(s: &str) -> [f32; 4] {
    let h = s.trim_start_matches('#');
    if h.len() >= 6 {
        let r = u8::from_str_radix(&h[0..2], 16).unwrap_or(110) as f32 / 255.0;
        let g = u8::from_str_radix(&h[2..4], 16).unwrap_or(101) as f32 / 255.0;
        let b = u8::from_str_radix(&h[4..6], 16).unwrap_or(87) as f32 / 255.0;
        [r, g, b, 1.0]
    } else {
        [0.43, 0.4, 0.34, 1.0]
    }
}

// ---------------------------------------------------------------------------
// Combined world scene: terrain + props + orbiting camera (`--demo props`).
// ---------------------------------------------------------------------------

use super::chunks::{TerrainExclusion, TerrainStreamer};
use super::terrain::Biome;
use super::WORLD_UNITS_PER_CELL;

pub struct WorldScene {
    pub world: GameWorld,
    pub renderer: Renderer,
    camera: Entity,
    center: Vec3,
    orbit: f32,
}

impl WorldScene {
    /// Build terrain + all slice props around the slice's prop centroid.
    #[allow(clippy::result_unit_err)]
    pub fn build<G: Gpu>(
        gpu: &mut G,
        assets_dir: &str,
        mapping_json: &str,
        slice_json: &str,
    ) -> Result<WorldScene, ()> {
        use successor_engine_render::components::{
            CamTarget, Camera, DirectionalLight, Projection, RectNorm,
        };
        use successor_engine_render::gpu::ClearSpec;

        let slice = Json::parse(slice_json).map_err(|_| ())?;
        let mut renderer = crate::configured_renderer(gpu).expect("renderer initialization failed");
        renderer.set_ambient(0.5);
        renderer.set_fog([0.788, 0.678, 0.510], 140.0, 320.0);
        let mut world = GameWorld::new();

        // Centroid of props → focus point.
        let (mut sx, mut sz, mut n) = (0.0f32, 0.0f32, 0.0f32);
        if let Some(props) = slice.get("props").and_then(Json::as_array) {
            for p in props {
                if let Some(c) = p.get("cell") {
                    sx += c.get("x").and_then(Json::as_f32).unwrap_or(0.0) * WORLD_UNITS_PER_CELL;
                    sz += c.get("y").and_then(Json::as_f32).unwrap_or(0.0) * WORLD_UNITS_PER_CELL;
                    n += 1.0;
                }
            }
        }
        let center = if n > 0.0 {
            vec3(sx / n, 0.0, sz / n)
        } else {
            vec3(
                512.0 * WORLD_UNITS_PER_CELL,
                0.0,
                512.0 * WORLD_UNITS_PER_CELL,
            )
        };
        renderer.gi_set_focus([center.x, center.y, center.z]);

        // Terrain ground under the props.
        let mut streamer = TerrainStreamer::new(
            0x0d3d_071e,
            Biome::Desert,
            64.0 * WORLD_UNITS_PER_CELL as f64,
            3,
            0b1,
        );
        let exclusions = building_terrain_exclusions(&slice, None, 1.5);
        streamer.set_exclusions(&exclusions);
        streamer.ensure_around(
            &mut world,
            &mut renderer,
            gpu,
            center.x as f64,
            center.z as f64,
        );

        // Props (all areas — developer demo; stable ids resolve under the
        // public root implied by `assets_dir`).
        let public_root = assets_dir
            .strip_suffix("/assets")
            .unwrap_or(assets_dir)
            .to_string();
        let mut read = move |stable_id: &str| -> Option<Vec<u8>> {
            if stable_id.is_empty() || stable_id.contains("..") || stable_id.starts_with('/') {
                return None;
            }
            std::fs::read(format!("{public_root}/{stable_id}")).ok()
        };
        let mut loader = PropsLoader::new(mapping_json)?;
        let placed = loader.load(
            &mut world,
            &mut renderer,
            gpu,
            &slice,
            &streamer,
            None,
            &mut read,
            0b1,
        );
        eprintln!("props: placed {placed} instances");

        let sun = world.spawn();
        world.set_component(
            sun,
            DirectionalLight {
                dir: vec3(-0.4, -1.0, -0.3).normalize(),
                color: [1.0, 0.98, 0.92],
                cast_shadows: true,
            },
        );

        let orbit = 60.0f32;
        let camera = world.spawn();
        world.set_component(
            camera,
            Camera {
                viewport_id: 0,
                order: 0,
                projection: Projection::Perspective {
                    fovy: 45.0_f32.to_radians(),
                    near: 0.5,
                    far: 2000.0,
                },
                target: CamTarget::Screen(RectNorm::FULL),
                clear: ClearSpec {
                    color: Some([0.788, 0.678, 0.510, 1.0]),
                    depth: Some(1.0),
                },
                eye: center.add(vec3(orbit, orbit * 0.8, orbit)),
                look_at: center,
                up: Vec3::Y,
            },
        );

        Ok(WorldScene {
            world,
            renderer,
            camera,
            center,
            orbit,
        })
    }

    pub fn animate(&mut self, frame: u64) {
        use successor_engine_render::components::Camera;
        let angle = frame as f32 * 0.01;
        let eye = self.center.add(vec3(
            angle.cos() * self.orbit,
            self.orbit * 0.8,
            angle.sin() * self.orbit,
        ));
        if let Some(cam) = self.world.get_component::<Camera>(self.camera) {
            cam.eye = eye;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_yaw_deterministic_and_in_range() {
        let a = hash_yaw("dustgate-cloning-facility");
        let b = hash_yaw("dustgate-cloning-facility");
        assert_eq!(a, b);
        assert!((0.0..core::f32::consts::PI * 2.0).contains(&a));
        assert!(hash_yaw("barrel_scav-1") != hash_yaw("barrel_scav-2"));
    }

    #[test]
    fn placement_fits_footprint() {
        // A 4×4-cell prop from an 8-unit GLB footprint → 0.5 uniform scale.
        let (yaw, scale) = placement(0.0, false, "x", 4.0, 4.0, 8.0, 8.0);
        assert_eq!(yaw, 0.0);
        assert!((scale - 0.5).abs() < 1e-4);
    }
    #[test]
    fn authored_occupancy_footprint_ignores_decorative_overhangs() {
        let entry = Json::parse(r#"{"fitFootprintM":[7.6,5.7]}"#).expect("mapping entry");
        assert_eq!(fit_footprint(&entry, 8.056, 7.454), (7.6, 5.7));
        let fallback = Json::parse("{}").expect("mapping entry");
        assert_eq!(fit_footprint(&fallback, 8.056, 7.454), (8.056, 7.454));
    }

    #[test]
    fn rotation_90_yaw() {
        let (yaw, _) = placement(90.0, false, "x", 2.0, 4.0, 2.0, 4.0);
        assert!((yaw - (-90.0f32).to_radians()).abs() < 1e-4);
    }

    #[test]
    fn only_visible_buildings_reserve_terrain_footprints() {
        let slice = Json::parse(
            r#"{"props":[
                {"kind":"building","cell":{"x":10,"y":20},"size":{"w":4,"h":3}},
                {"kind":"prop","cell":{"x":30,"y":40},"size":{"w":8,"h":8}},
                {"kind":"building","visible":false,"cell":{"x":50,"y":60}}
            ]}"#,
        )
        .expect("slice");
        let exclusions = building_terrain_exclusions(&slice, None, 1.5);
        // Area scoping: no prop carries `areaId` here, so a scoped call
        // excludes them all (fail closed rather than leak across areas).
        assert!(building_terrain_exclusions(&slice, Some("a"), 1.5).is_empty());
        assert_eq!(
            exclusions,
            vec![TerrainExclusion {
                min: [8.5, 18.5],
                max: [15.5, 24.5],
                feather: 3.0,
            }]
        );
    }

    #[test]
    fn enterable_prefixes_select_only_authored_shell_parts() {
        let names = vec![
            Some("root".to_string()),
            Some("roof__shell".to_string()),
            Some("wall_front__frame".to_string()),
            Some("floor__slab".to_string()),
            Some("door_slide__leaf".to_string()),
            Some("interior__counter".to_string()),
            Some("wall_back__far".to_string()),
            Some("trim__roof_child".to_string()),
        ];
        let parents = vec![
            None,
            Some(0),
            Some(0),
            Some(0),
            Some(0),
            Some(0),
            Some(0),
            Some(1),
        ];
        let enterable =
            Json::parse(r#"{"revealPrefixes":["roof__","wall_front__","wall_right__"]}"#)
                .expect("enterable mapping");
        let prefixes = enterable_reveal_prefixes(&enterable).expect("reveal prefixes");

        assert!(part_matches_reveal_prefixes(
            &names,
            &parents,
            1,
            prefixes,
            Some("door_slide")
        ));
        assert!(part_matches_reveal_prefixes(
            &names,
            &parents,
            2,
            prefixes,
            Some("door_slide")
        ));
        assert!(part_matches_reveal_prefixes(
            &names,
            &parents,
            7,
            prefixes,
            Some("door_slide")
        ));
        for node in [3, 4, 5, 6] {
            assert!(!part_matches_reveal_prefixes(
                &names,
                &parents,
                node,
                prefixes,
                Some("door_slide")
            ));
        }
    }

    #[test]
    fn placed_regions_prefer_collision_authoring_then_snapshot_bounds() {
        let placed = Json::parse(
            r#"{
                "interiorRegions":[{"xMilli":579,"yMilli":579,"wMilli":8842,"hMilli":7000}],
                "enterable":{"interiorBounds":[{"xMilli":1,"yMilli":2,"wMilli":3,"hMilli":4}]}
            }"#,
        )
        .expect("placed prop");
        assert_eq!(
            placed_interior_regions(&placed, 10.0, 8.0),
            vec![RegionMilli {
                x_milli: 579.0,
                y_milli: 579.0,
                w_milli: 8842.0,
                h_milli: 7000.0,
            }]
        );

        let snapshot = Json::parse(
            r#"{"enterable":{"interiorBounds":[{"xMilli":505,"yMilli":2553,"wMilli":8490,"hMilli":2447}]}}"#,
        )
        .expect("snapshot prop");
        assert_eq!(
            placed_interior_regions(&snapshot, 10.0, 8.0),
            vec![RegionMilli {
                x_milli: 505.0,
                y_milli: 2553.0,
                w_milli: 8490.0,
                h_milli: 2447.0,
            }]
        );
    }

    #[test]
    fn stable_entry_exit_animates_cutaway_above_player_head() {
        let regions = [RegionMilli {
            x_milli: 0.0,
            y_milli: 0.0,
            w_milli: 1000.0,
            h_milli: 1000.0,
        }];
        let mut state = CutawayState::default();

        assert_eq!(
            sample_enterable(&mut state, 1, &regions, 10.0, 20.0, 10.5, 20.5, 0.25, 0.05),
            0.0
        );
        let entering =
            sample_enterable(&mut state, 2, &regions, 10.0, 20.0, 10.5, 20.5, 0.25, 0.05);
        assert!(state.inside);
        assert!(entering > 0.0 && entering < 1.0);

        sample_enterable(&mut state, 2, &regions, 10.0, 20.0, 10.5, 20.5, 0.25, 0.1);
        let interior = sample_enterable(&mut state, 2, &regions, 10.0, 20.0, 10.5, 20.5, 0.25, 0.1);
        assert_eq!(interior, 1.0);
        assert_eq!(player_head_cutoff_y(2.0), 4.0);

        assert_eq!(
            sample_enterable(&mut state, 3, &regions, 10.0, 20.0, 12.0, 22.0, 0.25, 0.05),
            1.0
        );
        let exiting = sample_enterable(&mut state, 4, &regions, 10.0, 20.0, 12.0, 22.0, 0.25, 0.05);
        assert!(!state.inside);
        assert!(exiting > 0.0 && exiting < 1.0);
    }

    #[test]
    fn door_open_applies_placement_yaw_scale_and_close_is_exact() {
        let closed = Transform {
            pos: vec3(10.0, 1.5, 20.0),
            rot: Quat::from_yaw(0.37),
            scale: vec3(1.2, 0.9, 1.1),
        };
        let open = door_open_transform(
            closed,
            core::f32::consts::FRAC_PI_2,
            2.0,
            vec3(2.0, 0.0, 0.0),
            3.0,
        );
        assert!((open.pos.x - 10.0).abs() < 1e-5);
        assert!((open.pos.y - 1.5).abs() < 1e-5);
        assert!((open.pos.z - 14.0).abs() < 1e-5);
        assert_eq!(open.rot, closed.rot);
        assert_eq!(open.scale, closed.scale);
        assert_eq!(door_pose(closed, open, false), closed);
    }
    #[test]
    fn parse_hex_basic() {
        assert_eq!(parse_hex("#ff0000"), [1.0, 0.0, 0.0, 1.0]);
    }
}
