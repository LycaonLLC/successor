//! Live inventory/examine GLB previews for the native client.
//!
//! Each visible item gets a small forward-rendered target, a viewport-isolated
//! model, and a screen composite. The model registry is the same checked-in
//! registry used by `client-3d`; rigid node animation and skinned animation are
//! sampled through the engine animation runtime before the item turntable yaw.

use std::collections::BTreeMap;

use successor_engine_core::anim::{apply_animation, JointTransform, Skeleton};
use successor_engine_core::ecs::{Entity, WorldOps};
use successor_engine_core::glb::{self, GlbAnimation, GlbDocument};
use successor_engine_core::math::{vec3, Mat4, Quat, Vec3};
use successor_engine_render::components::{
    CamTarget, Camera, CompositeQuad, MaterialId, MeshId, MeshRenderer, PointLight, Projection,
    RectNorm, SkinRef, Transform,
};
use successor_engine_render::gpu::{ClearSpec, Filter, Gpu, RenderTargetDesc, RenderTargetId};
use successor_engine_render::model::upload_glb;
use successor_engine_render::renderer::Renderer;
use successor_engine_render::window::{WindowManager, TITLE_H};

use crate::windows::{InventoryRow, WindowModel};
use crate::GameWorld;

const REGISTRY_JSON: &str = include_str!("../../../../client-3d/src/ui/inventory/itemModels.json");
const UNKNOWN_MODEL: &str = "assets/world-items/supply_cache.glb";
/// Live 3D icon lanes for the held grid. The original renders every inventory
/// item as a 3D icon rather than a flat picture, so this covers a full default
/// page; cards past it fall back to the atlas glyph.
pub const INVENTORY_LANES: usize = 24;
const EXAMINE_LANE: usize = INVENTORY_LANES;
const LANE_COUNT: usize = INVENTORY_LANES + 1;
/// Viewport 0 is the world and 1..=4 are the character viewers, so item icon
/// lanes start after those. 25 lanes then reach 29, inside the 32-slot mask.
const FIRST_VIEWPORT: u8 = 5;
/// Grid icons are small on screen; this is already supersampled against a
/// ~48 px card. The examine viewer is the one that needs real resolution.
const GRID_TARGET_SIZE: u32 = 96;
const EXAMINE_TARGET_SIZE: u32 = 256;

#[derive(Clone, Copy)]
struct ModelPart {
    mesh: MeshId,
    material: MaterialId,
    node: usize,
    skin: Option<usize>,
    skinned: bool,
}

#[derive(Clone)]
struct CachedModel {
    parts: Vec<ModelPart>,
    rest: Vec<JointTransform>,
    parent: Vec<Option<usize>>,
    order: Vec<usize>,
    animations: Vec<GlbAnimation>,
    skeletons: Vec<Option<Skeleton>>,
    center: Vec3,
    fit_scale: f32,
}

struct ActiveModel {
    source: CachedModel,
    pose: Vec<JointTransform>,
    globals: Vec<Mat4>,
    skin_refs: Vec<SkinRef>,
    palette: Vec<[f32; 16]>,
}

impl ActiveModel {
    fn new(source: CachedModel) -> Self {
        let node_count = source.rest.len();
        let skin_count = source.skeletons.len();
        Self {
            pose: source.rest.clone(),
            globals: vec![Mat4::IDENTITY; node_count],
            skin_refs: vec![SkinRef::NONE; skin_count],
            palette: Vec::with_capacity(64),
            source,
        }
    }
}

struct PreviewLane {
    camera: Entity,
    quad: Entity,
    target: RenderTargetId,
    entities: Vec<Entity>,
    requested: String,
    item_id: Option<u32>,
    item_key: String,
    model: Option<ActiveModel>,
}

pub struct ItemPreviewRenderer {
    registry: BTreeMap<u32, String>,
    cache: BTreeMap<String, CachedModel>,
    lanes: Vec<PreviewLane>,
}

impl ItemPreviewRenderer {
    pub fn new<G: Gpu>(gpu: &mut G, world: &mut GameWorld) -> Self {
        let registry = serde_json::from_str::<BTreeMap<String, serde_json::Value>>(REGISTRY_JSON)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|(key, value)| {
                let item_id = key.parse::<u32>().ok()?;
                let path = value.as_str()?.trim_start_matches('/').to_string();
                Some((item_id, path))
            })
            .collect();
        let preview_light = world.spawn();
        world.set_component(
            preview_light,
            Transform {
                pos: vec3(1.8, 2.2, 2.4),
                rot: Quat::IDENTITY,
                scale: Vec3::ONE,
            },
        );
        world.set_component(
            preview_light,
            PointLight {
                color: [1.0, 0.94, 0.84],
                intensity: 10.0,
                radius: 8.0,
            },
        );
        let mut lanes = Vec::with_capacity(LANE_COUNT);
        for lane_index in 0..LANE_COUNT {
            let size = if lane_index == EXAMINE_LANE {
                EXAMINE_TARGET_SIZE
            } else {
                GRID_TARGET_SIZE
            };
            let target = gpu.create_render_target(&RenderTargetDesc {
                width: size,
                height: size,
                color: true,
                depth: true,
                filter: Filter::Linear,
            });
            lanes.push(PreviewLane {
                camera: world.spawn(),
                quad: world.spawn(),
                target,
                entities: Vec::new(),
                requested: String::new(),
                item_id: None,
                item_key: String::new(),
                model: None,
            });
        }
        Self {
            registry,
            cache: BTreeMap::new(),
            lanes,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn sync<G: Gpu>(
        &mut self,
        gpu: &mut G,
        renderer: &mut Renderer,
        world: &mut GameWorld,
        windows: &WindowManager,
        model: &WindowModel,
        screen_w: u32,
        screen_h: u32,
        time: f32,
        read_asset: &mut dyn FnMut(&str) -> Option<Vec<u8>>,
    ) {
        // Icons belong to the window that hosts them: banding their composites
        // by that window's draw rank keeps them under anything stacked above,
        // the same ordering the doll viewers use.
        let band = |id: &str| -> i16 {
            windows.z_rank(id).map_or(0, |rank| {
                rank as i16 * crate::game::connected_scene::DOLL_BAND
            })
        };
        let mut lane_index = 0usize;
        if windows.is_open("inventory") {
            let inventory_band = band("inventory");
            if let Some(content) = window_content(windows, "inventory") {
                // Draw order, not wire order: the grid filters, sorts, and
                // pages its rows, and a lane keyed off `held()` would sit a
                // model under someone else's label.
                let mut visible = [0usize; INVENTORY_LANES];
                let visible_count =
                    crate::windows::inventory::copy_visible_held_indices(content, &mut visible);
                for (slot, &held_index) in visible.iter().take(visible_count).enumerate() {
                    if lane_index >= INVENTORY_LANES {
                        break;
                    }
                    let Some(row) = model.inventory.held().nth(held_index) else {
                        continue;
                    };
                    let Some(preview) = crate::windows::inventory::grid_preview_rect(content, slot)
                    else {
                        break;
                    };
                    let path = self.changed_path(lane_index, row);
                    self.sync_lane(
                        lane_index,
                        path.as_deref(),
                        preview,
                        inventory_band + 1 + lane_index as i16,
                        gpu,
                        renderer,
                        world,
                        screen_w,
                        screen_h,
                        time,
                        read_asset,
                    );
                    lane_index += 1;
                }
            }
        }
        while lane_index < INVENTORY_LANES {
            self.deactivate_lane(lane_index, world);
            lane_index += 1;
        }

        if windows.is_open("examine") {
            if let (Some(row), Some(content)) =
                (&model.examine.item, window_content(windows, "examine"))
            {
                let preview = crate::windows::live::examine_item_preview_rect(content);
                let path = self.changed_path(EXAMINE_LANE, row);
                self.sync_lane(
                    EXAMINE_LANE,
                    path.as_deref(),
                    preview,
                    band("examine") + 1,
                    gpu,
                    renderer,
                    world,
                    screen_w,
                    screen_h,
                    time,
                    read_asset,
                );
            } else {
                self.deactivate_lane(EXAMINE_LANE, world);
            }
        } else {
            self.deactivate_lane(EXAMINE_LANE, world);
        }
    }

    fn model_path(&self, row: &InventoryRow) -> String {
        if (7301..=7335).contains(&row.item_id) && valid_equipment_key(&row.item) {
            return format!("assets/pawn-pack/equipment/Under/{}.glb", row.item);
        }
        self.registry
            .get(&row.item_id)
            .cloned()
            .unwrap_or_else(|| UNKNOWN_MODEL.to_string())
    }

    fn changed_path(&mut self, index: usize, row: &InventoryRow) -> Option<String> {
        let changed = self.lanes[index].item_id != Some(row.item_id)
            || self.lanes[index].item_key != row.item;
        if !changed {
            return None;
        }
        let path = self.model_path(row);
        self.lanes[index].item_id = Some(row.item_id);
        self.lanes[index].item_key.clone_from(&row.item);
        Some(path)
    }

    #[allow(clippy::too_many_arguments)]
    fn sync_lane<G: Gpu>(
        &mut self,
        index: usize,
        requested: Option<&str>,
        rect: [f32; 4],
        order: i16,
        gpu: &mut G,
        renderer: &mut Renderer,
        world: &mut GameWorld,
        screen_w: u32,
        screen_h: u32,
        time: f32,
        read_asset: &mut dyn FnMut(&str) -> Option<Vec<u8>>,
    ) {
        if let Some(requested) = requested {
            let loaded = self
                .load_model(requested, gpu, renderer, read_asset)
                .or_else(|| {
                    (requested != UNKNOWN_MODEL)
                        .then(|| self.load_model(UNKNOWN_MODEL, gpu, renderer, read_asset))
                        .flatten()
                });
            self.assign_model(index, requested, loaded, world);
        }
        let viewport = FIRST_VIEWPORT + index as u8;
        let lane = &mut self.lanes[index];
        let Some(active) = lane.model.as_mut() else {
            self.deactivate_lane(index, world);
            return;
        };

        active.pose.copy_from_slice(&active.source.rest);
        for animation in &active.source.animations {
            let sample_time = if animation.duration > 0.0 {
                time.rem_euclid(animation.duration)
            } else {
                0.0
            };
            apply_animation(animation, sample_time, &mut active.pose);
        }
        compute_globals(
            &active.pose,
            &active.source.parent,
            &active.source.order,
            &mut active.globals,
        );
        for (skin_index, skeleton) in active.source.skeletons.iter_mut().enumerate() {
            let Some(skeleton) = skeleton else {
                active.skin_refs[skin_index] = SkinRef::NONE;
                continue;
            };
            skeleton.compute_palette(&active.pose, &mut active.palette);
            let count = active.palette.len() as u32;
            let offset = renderer.push_skin_palette(&active.palette);
            active.skin_refs[skin_index] = SkinRef { offset, count };
        }

        let yaw = time * 0.62 + index as f32 * 0.73;
        let root = Mat4::from_trs(
            Vec3::ZERO,
            Quat::from_yaw(yaw),
            vec3(
                active.source.fit_scale,
                active.source.fit_scale,
                active.source.fit_scale,
            ),
        )
        .mul(Mat4::from_translation(active.source.center.scale(-1.0)));
        for (part_index, part) in active.source.parts.iter().enumerate() {
            let local = if part.skinned {
                Mat4::IDENTITY
            } else {
                active
                    .globals
                    .get(part.node)
                    .copied()
                    .unwrap_or(Mat4::IDENTITY)
            };
            let (pos, rot, scale) = root.mul(local).to_trs();
            world.set_component(lane.entities[part_index], Transform { pos, rot, scale });
            world.set_component(
                lane.entities[part_index],
                MeshRenderer {
                    mesh: part.mesh,
                    material: part.material,
                    viewport_mask: 1u32 << viewport,
                    skin: part
                        .skin
                        .and_then(|skin| active.skin_refs.get(skin).copied())
                        .unwrap_or(SkinRef::NONE),
                },
            );
        }

        world.set_component(
            lane.camera,
            Camera {
                viewport_id: viewport,
                order: -20 + index as i16,
                projection: Projection::Perspective {
                    fovy: 0.58,
                    near: 0.02,
                    far: 20.0,
                },
                target: CamTarget::Texture(lane.target),
                // The original punches the viewer straight through the 2D UI
                // and clears depth/stencil only, never colour, so the panel
                // shows behind the model. The equivalent here is a fully
                // transparent clear: geometry writes its own alpha and the
                // composite blends the rest away.
                clear: ClearSpec {
                    color: Some([0.0, 0.0, 0.0, 0.0]),
                    depth: Some(1.0),
                },
                eye: vec3(0.0, 0.12, 3.25),
                look_at: Vec3::ZERO,
                up: Vec3::Y,
            },
        );
        world.set_component(
            lane.quad,
            CompositeQuad {
                source: lane.target,
                rect: rect_norm(rect, screen_w, screen_h),
                order,
            },
        );
    }

    fn assign_model(
        &mut self,
        index: usize,
        requested: &str,
        model: Option<CachedModel>,
        world: &mut GameWorld,
    ) {
        let lane = &mut self.lanes[index];
        lane.requested.clear();
        lane.requested.push_str(requested);
        lane.model = model.map(ActiveModel::new);
        let part_count = lane
            .model
            .as_ref()
            .map(|model| model.source.parts.len())
            .unwrap_or(0);
        while lane.entities.len() < part_count {
            lane.entities.push(world.spawn());
        }
        for entity in lane.entities.iter().skip(part_count) {
            world.remove_component::<MeshRenderer>(*entity);
        }
    }

    fn deactivate_lane(&mut self, index: usize, world: &mut GameWorld) {
        let lane = &self.lanes[index];
        world.remove_component::<Camera>(lane.camera);
        world.remove_component::<CompositeQuad>(lane.quad);
        for entity in &lane.entities {
            world.remove_component::<MeshRenderer>(*entity);
        }
    }

    fn load_model<G: Gpu>(
        &mut self,
        path: &str,
        gpu: &mut G,
        renderer: &mut Renderer,
        read_asset: &mut dyn FnMut(&str) -> Option<Vec<u8>>,
    ) -> Option<CachedModel> {
        if let Some(model) = self.cache.get(path) {
            return Some(model.clone());
        }
        let bytes = read_asset(path)?;
        let doc = glb::parse(&bytes).ok()?;
        let model = build_cached_model(gpu, renderer, &doc)?;
        self.cache.insert(path.to_string(), model.clone());
        Some(model)
    }
}

fn window_content(windows: &WindowManager, id: &str) -> Option<[f32; 4]> {
    let [x, y, w, h] = windows.rect(id)?;
    Some([x + 6.0, y + TITLE_H + 6.0, w - 12.0, h - TITLE_H - 12.0])
}

fn rect_norm(rect: [f32; 4], screen_w: u32, screen_h: u32) -> RectNorm {
    RectNorm {
        x: rect[0] / screen_w.max(1) as f32,
        y: 1.0 - (rect[1] + rect[3]) / screen_h.max(1) as f32,
        w: rect[2] / screen_w.max(1) as f32,
        h: rect[3] / screen_h.max(1) as f32,
    }
}

fn valid_equipment_key(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(|ch| ch.is_ascii_lowercase())
        && value.contains('_')
        && value
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
}

fn build_cached_model<G: Gpu>(
    gpu: &mut G,
    renderer: &mut Renderer,
    doc: &GlbDocument,
) -> Option<CachedModel> {
    let uploaded = upload_glb(renderer, gpu, doc).ok()?;
    let (parent, order) = hierarchy(doc);
    let rest: Vec<JointTransform> = doc
        .nodes
        .iter()
        .map(|node| JointTransform {
            t: node.translation,
            r: node.rotation,
            s: node.scale,
        })
        .collect();
    let mut rest_globals = vec![Mat4::IDENTITY; rest.len()];
    compute_globals(&rest, &parent, &order, &mut rest_globals);

    let mut parts = Vec::new();
    let mut min = vec3(f32::MAX, f32::MAX, f32::MAX);
    let mut max = vec3(f32::MIN, f32::MIN, f32::MIN);
    for (node_index, node) in doc.nodes.iter().enumerate() {
        let Some(mesh_index) = node.mesh else {
            continue;
        };
        let mesh = doc.meshes.get(mesh_index)?;
        for primitive in uploaded
            .primitives
            .iter()
            .filter(|part| part.source_mesh == mesh_index)
        {
            let source = mesh.primitives.get(primitive.source_primitive)?;
            let skinned = !source.joints.is_empty();
            parts.push(ModelPart {
                mesh: primitive.mesh,
                material: primitive.material,
                node: node_index,
                skin: node.skin,
                skinned,
            });
            let node_matrix = if skinned {
                Mat4::IDENTITY
            } else {
                rest_globals[node_index]
            };
            for position in &source.positions {
                let p = node_matrix.transform_point(vec3(position[0], position[1], position[2]));
                min.x = min.x.min(p.x);
                min.y = min.y.min(p.y);
                min.z = min.z.min(p.z);
                max.x = max.x.max(p.x);
                max.y = max.y.max(p.y);
                max.z = max.z.max(p.z);
            }
        }
    }
    if parts.is_empty() || min.x == f32::MAX {
        return None;
    }
    let span = max.sub(min);
    let largest = span.x.max(span.y).max(span.z).max(0.001);
    let center = min.add(max).scale(0.5);
    let animations = preview_animations(doc);
    let skeletons = (0..doc.skins.len())
        .map(|skin| Skeleton::from_document(doc, skin))
        .collect();
    Some(CachedModel {
        parts,
        rest,
        parent,
        order,
        animations,
        skeletons,
        center,
        fit_scale: 1.62 / largest,
    })
}

fn hierarchy(doc: &GlbDocument) -> (Vec<Option<usize>>, Vec<usize>) {
    let mut parent = vec![None; doc.nodes.len()];
    for (index, node) in doc.nodes.iter().enumerate() {
        for &child in &node.children {
            if child < parent.len() {
                parent[child] = Some(index);
            }
        }
    }
    let mut order = Vec::with_capacity(doc.nodes.len());
    let mut queue: Vec<usize> = (0..doc.nodes.len())
        .filter(|&index| parent[index].is_none())
        .collect();
    let mut cursor = 0usize;
    while cursor < queue.len() {
        let index = queue[cursor];
        cursor += 1;
        order.push(index);
        for &child in &doc.nodes[index].children {
            if child < doc.nodes.len() {
                queue.push(child);
            }
        }
    }
    (parent, order)
}

fn compute_globals(
    pose: &[JointTransform],
    parent: &[Option<usize>],
    order: &[usize],
    out: &mut [Mat4],
) {
    for &index in order {
        let local = pose.get(index).copied().unwrap_or_default().matrix();
        out[index] = parent[index]
            .and_then(|parent| out.get(parent).copied())
            .map(|parent| parent.mul(local))
            .unwrap_or(local);
    }
}

fn preview_animations(doc: &GlbDocument) -> Vec<GlbAnimation> {
    if let Some(idle) = doc.animations.iter().find(|animation| {
        animation
            .name
            .as_deref()
            .is_some_and(|name| name.eq_ignore_ascii_case("idle"))
    }) {
        return vec![idle.clone()];
    }
    let loops: Vec<_> = doc
        .animations
        .iter()
        .filter(|animation| {
            animation
                .name
                .as_deref()
                .is_some_and(|name| name.to_ascii_lowercase().contains("loop"))
        })
        .cloned()
        .collect();
    if !loops.is_empty() {
        return loops;
    }
    doc.animations.iter().take(2).cloned().collect()
}
