//! Terrain chunk streamer: updates continuous material/height controls around a
//! center and renders pooled tessellated patches with one shared PBR tile
//! library. It ports the `client-3d` ring-prefetch and eviction policy without
//! baking final color into per-chunk textures.

use std::collections::HashMap;

use successor_engine_core::ecs::{Entity, WorldOps};
use successor_engine_core::math::{vec3, Vec3};
use successor_engine_render::components::{MaterialId, MeshId, MeshRenderer, SkinRef, Transform};
use successor_engine_render::gpu::{
    Filter, Gpu, MinFilter, TextureArrayDesc, TextureDesc, TextureFormat, TextureId, Wrap,
};
use successor_engine_render::renderer::{
    InstanceBatchId, MaterialDesc, Renderer, TerrainMaterialDesc,
};

use super::flora::{
    biome_density, detail_instance_matrix, rock_mesh, scatter_into, shrub_mesh, tuft_mesh,
    DetailKind, FloraInstance,
};
use super::terrain::{sample_terrain, terrain_height, Biome};
use super::terrain_material::{generate_terrain_tiles, TILE_LAYERS, TILE_SIZE};
use super::{TERRAIN_MATERIAL_METERS_PER_TILE, WORLD_UNITS_PER_CELL};
use crate::GameWorld;

const CONTROL_INTERIOR_PX: u32 = 128;
const CONTROL_PX: u32 = CONTROL_INTERIOR_PX + 2;
const GRID_SEGMENTS: u32 = 32;
const HEIGHT_RANGE: f32 = 4.0;
const DETAIL_CAPACITY_PER_KIND: u32 = 128;
const DETAIL_MAX_DISTANCE: f32 = 260.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TerrainExclusion {
    pub min: [f32; 2],
    pub max: [f32; 2],
    pub feather: f32,
}

/// Flat mean ground albedo per biome, fed to the GI volume as the bounce color
/// of the y=0 plane.
fn biome_ground_albedo(biome: Biome) -> [f32; 3] {
    match biome {
        Biome::Forest => [0.30, 0.34, 0.20],
        _ => [0.79, 0.68, 0.51],
    }
}

struct TerrainSlot {
    control: TextureId,
    material: MaterialId,
    detail_matrices: [Vec<[f32; 16]>; 3],
    entity: Option<Entity>,
}

pub struct TerrainStreamer {
    seed: i32,
    biome: Biome,
    chunk_cells: f64,
    radius: i32,
    loaded: HashMap<(i32, i32), usize>,
    mask: u32,
    shared_mesh: Option<MeshId>,
    albedo_tiles: Option<TextureId>,
    nrma_tiles: Option<TextureId>,
    slots: Vec<TerrainSlot>,
    control_scratch: Vec<u8>,
    evict_scratch: Vec<(i32, i32)>,
    exclusions: Vec<TerrainExclusion>,
    detail_scratch: Vec<FloraInstance>,
    detail_matrices: [Vec<[f32; 16]>; 3],
    detail_batches: Option<[InstanceBatchId; 3]>,
    merged_detail_matrices: [Vec<[f32; 16]>; 3],
}

impl TerrainStreamer {
    pub fn new(seed: i32, biome: Biome, chunk_cells: f64, radius: i32, viewport_mask: u32) -> Self {
        let slot_count = ((radius * 2 + 1) * (radius * 2 + 1)) as usize;
        Self {
            seed,
            biome,
            chunk_cells,
            radius,
            loaded: HashMap::with_capacity(slot_count),
            mask: viewport_mask,
            shared_mesh: None,
            albedo_tiles: None,
            nrma_tiles: None,
            slots: Vec::with_capacity(slot_count),
            control_scratch: vec![0; (CONTROL_PX * CONTROL_PX * 4) as usize],
            evict_scratch: Vec::with_capacity(slot_count),
            exclusions: Vec::new(),
            detail_scratch: Vec::with_capacity(256),
            detail_matrices: core::array::from_fn(|_| {
                Vec::with_capacity(DETAIL_CAPACITY_PER_KIND as usize)
            }),
            detail_batches: None,
            merged_detail_matrices: core::array::from_fn(|_| {
                Vec::with_capacity(slot_count * DETAIL_CAPACITY_PER_KIND as usize)
            }),
        }
    }
    /// Replace the visual-ground flattening regions. Structure footprints use
    /// these before chunks are baked so props remain seated and detail scatter
    /// cannot invade buildable space.
    pub fn set_exclusions(&mut self, exclusions: &[TerrainExclusion]) {
        self.exclusions.clear();
        self.exclusions.extend_from_slice(exclusions);
    }

    fn chunk_of(&self, world_x: f64, world_z: f64) -> (i32, i32) {
        (
            (world_x / self.chunk_cells).floor() as i32,
            (world_z / self.chunk_cells).floor() as i32,
        )
    }

    fn ensure_shared<G: Gpu>(&mut self, renderer: &mut Renderer, gpu: &mut G) {
        if self.shared_mesh.is_some() {
            return;
        }
        let tiles = generate_terrain_tiles(self.biome);
        let albedo_tiles = gpu.create_texture_array(
            &TextureArrayDesc {
                width: TILE_SIZE,
                height: TILE_SIZE,
                layers: TILE_LAYERS,
                format: TextureFormat::Srgba8,
                mipmaps: true,
            },
            Some(&tiles.albedo),
        );
        let nrma_tiles = gpu.create_texture_array(
            &TextureArrayDesc {
                width: TILE_SIZE,
                height: TILE_SIZE,
                layers: TILE_LAYERS,
                format: TextureFormat::Rgba8,
                mipmaps: true,
            },
            Some(&tiles.nrma),
        );
        let size = self.chunk_cells as f32;
        let (verts, indices) = chunk_grid(size, GRID_SEGMENTS);
        let mesh = renderer.upload_mesh(gpu, &verts, &indices);
        let control_desc = control_texture_desc();
        let zeros = vec![0; self.control_scratch.len()];
        let slot_count = self.slots.capacity();
        let (rock_vertices, rock_indices) = rock_mesh();
        let (cover_vertices, cover_indices) = tuft_mesh();
        let (shrub_vertices, shrub_indices) = shrub_mesh();
        let detail_meshes = [
            renderer.upload_mesh(gpu, &rock_vertices, &rock_indices),
            renderer.upload_mesh(gpu, &cover_vertices, &cover_indices),
            renderer.upload_mesh(gpu, &shrub_vertices, &shrub_indices),
        ];
        let detail_materials = detail_materials(renderer, self.biome);
        for _ in 0..slot_count {
            let control = gpu.create_texture(&control_desc, Some(&zeros));
            let material = renderer.add_material_desc(MaterialDesc {
                metallic: 0.0,
                roughness: 1.0,
                terrain: Some(TerrainMaterialDesc {
                    control_texture: control,
                    albedo_tiles,
                    nrma_tiles,
                    world_origin: [0.0, 0.0],
                    world_size: size,
                    tile_scale: TERRAIN_MATERIAL_METERS_PER_TILE,
                    normal_strength: 1.2,
                    biome: biome_id(self.biome),
                }),
                ..MaterialDesc::default()
            });
            self.slots.push(TerrainSlot {
                control,
                material,
                detail_matrices: core::array::from_fn(|_| {
                    Vec::with_capacity(DETAIL_CAPACITY_PER_KIND as usize)
                }),
                entity: None,
            });
        }
        self.detail_batches = Some(core::array::from_fn(|kind| {
            renderer.add_instance_batch(
                gpu,
                detail_meshes[kind],
                detail_materials[kind],
                slot_count as u32 * DETAIL_CAPACITY_PER_KIND,
                self.mask,
                DETAIL_MAX_DISTANCE,
            )
        }));
        self.shared_mesh = Some(mesh);
        self.albedo_tiles = Some(albedo_tiles);
        self.nrma_tiles = Some(nrma_tiles);
    }

    /// Ensure every chunk within `radius` of the world center is loaded. Slots,
    /// textures, materials, and the quad mesh are fixed after first warmup.
    pub fn ensure_around<G: Gpu>(
        &mut self,
        world: &mut GameWorld,
        renderer: &mut Renderer,
        gpu: &mut G,
        center_x: f64,
        center_z: f64,
    ) {
        renderer.gi_set_ground_albedo(biome_ground_albedo(self.biome));
        self.ensure_shared(renderer, gpu);
        let (ccx, ccz) = self.chunk_of(center_x, center_z);

        self.evict_scratch.clear();
        self.evict_scratch.extend(
            self.loaded.keys().copied().filter(|(cx, cz)| {
                (cx - ccx).abs() > self.radius || (cz - ccz).abs() > self.radius
            }),
        );
        for key in self.evict_scratch.drain(..) {
            if let Some(slot_index) = self.loaded.remove(&key) {
                if let Some(entity) = self.slots[slot_index].entity.take() {
                    world.destroy(entity);
                }
                for matrices in &mut self.slots[slot_index].detail_matrices {
                    matrices.clear();
                }
            }
        }
        world.flush();

        for dz in -self.radius..=self.radius {
            for dx in -self.radius..=self.radius {
                let key = (ccx + dx, ccz + dz);
                if !self.loaded.contains_key(&key) {
                    self.load_chunk(world, renderer, gpu, key);
                }
            }
        }
        world.flush();
        self.upload_detail_batches(renderer, gpu, center_x as f32, center_z as f32);
    }

    /// Release every area-scoped chunk: despawn chunk entities, forget the
    /// residency map, and zero the flora instance batches so a dropped
    /// streamer leaves nothing rendering. Used on area transition before a
    /// new streamer (new seed/biome) is built.
    pub fn clear<G: Gpu>(&mut self, world: &mut GameWorld, renderer: &mut Renderer, gpu: &mut G) {
        for slot in &mut self.slots {
            if let Some(entity) = slot.entity.take() {
                world.destroy(entity);
            }
            for matrices in &mut slot.detail_matrices {
                matrices.clear();
            }
        }
        self.loaded.clear();
        for matrices in &mut self.merged_detail_matrices {
            matrices.clear();
        }
        if let Some(batches) = self.detail_batches {
            for batch in batches {
                let _ = renderer.update_instance_batch(gpu, batch, &[], [0.0, 0.0, 0.0]);
            }
        }
        world.flush();
    }

    fn load_chunk<G: Gpu>(
        &mut self,
        world: &mut GameWorld,
        renderer: &mut Renderer,
        gpu: &mut G,
        (cx, cz): (i32, i32),
    ) {
        let slot_index = self
            .slots
            .iter()
            .position(|slot| slot.entity.is_none())
            .expect("terrain slot pool exhausted");
        let origin_x = cx as f64 * self.chunk_cells;
        let origin_z = cz as f64 * self.chunk_cells;
        self.bake_control(origin_x, origin_z);
        self.scatter_details(origin_x as f32, origin_z as f32);
        let slot = &mut self.slots[slot_index];
        gpu.update_texture(slot.control, &control_texture_desc(), &self.control_scratch);
        renderer.update_material_desc(
            slot.material,
            MaterialDesc {
                metallic: 0.0,
                roughness: 1.0,
                terrain: Some(TerrainMaterialDesc {
                    control_texture: slot.control,
                    albedo_tiles: self.albedo_tiles.expect("terrain albedo tiles"),
                    nrma_tiles: self.nrma_tiles.expect("terrain NRMA tiles"),
                    world_origin: [origin_x as f32, origin_z as f32],
                    world_size: self.chunk_cells as f32,
                    tile_scale: TERRAIN_MATERIAL_METERS_PER_TILE,
                    normal_strength: 1.2,
                    biome: biome_id(self.biome),
                }),
                ..MaterialDesc::default()
            },
        );
        for kind in 0..3 {
            slot.detail_matrices[kind].clear();
            core::mem::swap(
                &mut slot.detail_matrices[kind],
                &mut self.detail_matrices[kind],
            );
        }
        let entity = world.spawn();
        world.set_component(
            entity,
            Transform {
                pos: vec3(origin_x as f32, 0.0, origin_z as f32),
                ..Default::default()
            },
        );
        world.set_component(
            entity,
            MeshRenderer {
                mesh: self.shared_mesh.expect("terrain mesh"),
                material: slot.material,
                viewport_mask: self.mask,
                skin: SkinRef::NONE,
            },
        );
        slot.entity = Some(entity);
        self.loaded.insert((cx, cz), slot_index);
    }

    fn upload_detail_batches<G: Gpu>(
        &mut self,
        renderer: &mut Renderer,
        gpu: &mut G,
        center_x: f32,
        center_z: f32,
    ) {
        for matrices in &mut self.merged_detail_matrices {
            matrices.clear();
        }
        for slot in &self.slots {
            if slot.entity.is_none() {
                continue;
            }
            for (merged, chunk) in self
                .merged_detail_matrices
                .iter_mut()
                .zip(&slot.detail_matrices)
            {
                merged.extend_from_slice(chunk);
            }
        }
        let batches = self.detail_batches.expect("terrain detail batches");
        for (kind, batch) in batches.into_iter().enumerate() {
            let updated = renderer.update_instance_batch(
                gpu,
                batch,
                &self.merged_detail_matrices[kind],
                [center_x, 0.0, center_z],
            );
            debug_assert!(updated, "terrain detail pool exceeded fixed capacity");
        }
    }

    fn scatter_details(&mut self, origin_x: f32, origin_z: f32) {
        let size = self.chunk_cells as f32;
        let exclusions = &self.exclusions;
        scatter_into(
            &mut self.detail_scratch,
            self.seed ^ 0x51a7_3e2d,
            [origin_x, origin_z],
            [origin_x + size, origin_z + size],
            biome_density(self.biome) * (64.0 / size).powi(2),
            |point| point_blocked(exclusions, point),
        );
        for matrices in &mut self.detail_matrices {
            matrices.clear();
        }
        for instance in &mut self.detail_scratch {
            instance.pos[1] = flattened_height(
                self.seed,
                self.biome,
                exclusions,
                instance.pos[0],
                instance.pos[2],
            );
            let kind = DetailKind::from_hash(instance.kind);
            self.detail_matrices[kind as usize]
                .push(detail_instance_matrix(instance, kind, self.biome));
        }
    }

    fn bake_control(&mut self, origin_x: f64, origin_z: f64) {
        let step = self.chunk_cells / (CONTROL_INTERIOR_PX - 1) as f64;
        for y in 0..CONTROL_PX {
            let world_z = origin_z + (y as f64 - 1.0) * step;
            for x in 0..CONTROL_PX {
                let world_x = origin_x + (x as f64 - 1.0) * step;
                let sample = sample_terrain(self.seed, world_x, world_z, self.biome);
                let height = self.height_at(world_x as f32, world_z as f32);
                let offset = ((y * CONTROL_PX + x) * 4) as usize;
                self.control_scratch[offset] = unit_byte(sample.weights[0]);
                self.control_scratch[offset + 1] = unit_byte(sample.weights[1]);
                self.control_scratch[offset + 2] = unit_byte(sample.weights[2]);
                self.control_scratch[offset + 3] =
                    unit_byte((height + HEIGHT_RANGE) / (HEIGHT_RANGE * 2.0));
            }
        }
    }

    pub fn height_at(&self, world_x: f32, world_z: f32) -> f32 {
        flattened_height(self.seed, self.biome, &self.exclusions, world_x, world_z)
    }

    #[cfg(test)]
    fn resident_resources(&self) -> (usize, usize, usize) {
        (
            self.slots.len(),
            self.loaded.len(),
            usize::from(self.shared_mesh.is_some()),
        )
    }
}

fn control_texture_desc() -> TextureDesc {
    TextureDesc {
        width: CONTROL_PX,
        height: CONTROL_PX,
        format: TextureFormat::Rgba8,
        mag_filter: Filter::Linear,
        min_filter: MinFilter::Linear,
        wrap_s: Wrap::ClampToEdge,
        wrap_t: Wrap::ClampToEdge,
        mipmaps: false,
    }
}

fn unit_byte(value: f32) -> u8 {
    (value.clamp(0.0, 1.0) * 255.0 + 0.5) as u8
}

fn biome_id(biome: Biome) -> i32 {
    match biome {
        Biome::Desert => 0,
        Biome::Forest => 1,
    }
}

fn detail_materials(renderer: &mut Renderer, biome: Biome) -> [MaterialId; 3] {
    let colors = match biome {
        Biome::Desert => [
            [0.30, 0.23, 0.17, 1.0],
            [0.23, 0.27, 0.10, 1.0],
            [0.25, 0.18, 0.095, 1.0],
        ],
        Biome::Forest => [
            [0.22, 0.25, 0.20, 1.0],
            [0.10, 0.27, 0.055, 1.0],
            [0.065, 0.19, 0.04, 1.0],
        ],
    };
    core::array::from_fn(|kind| {
        renderer.add_material_desc(MaterialDesc {
            base_color: colors[kind],
            metallic: 0.0,
            roughness: if kind == DetailKind::Rock as usize {
                0.76
            } else {
                0.91
            },
            double_sided: kind == DetailKind::GroundCover as usize,
            ..MaterialDesc::default()
        })
    })
}

fn point_blocked(exclusions: &[TerrainExclusion], point: [f32; 2]) -> bool {
    exclusions.iter().any(|exclusion| {
        point[0] >= exclusion.min[0]
            && point[0] <= exclusion.max[0]
            && point[1] >= exclusion.min[1]
            && point[1] <= exclusion.max[1]
    })
}

fn flattened_height(
    seed: i32,
    biome: Biome,
    exclusions: &[TerrainExclusion],
    world_x: f32,
    world_z: f32,
) -> f32 {
    let base = terrain_height(seed, world_x as f64, world_z as f64, biome);
    let mut keep = 1.0f32;
    for exclusion in exclusions {
        let dx = if world_x < exclusion.min[0] {
            exclusion.min[0] - world_x
        } else if world_x > exclusion.max[0] {
            world_x - exclusion.max[0]
        } else {
            0.0
        };
        let dz = if world_z < exclusion.min[1] {
            exclusion.min[1] - world_z
        } else if world_z > exclusion.max[1] {
            world_z - exclusion.max[1]
        } else {
            0.0
        };
        let outside = (dx * dx + dz * dz).sqrt();
        keep = keep.min(smoothstep01(outside / exclusion.feather.max(0.001)));
    }
    base * keep
}

fn smoothstep01(value: f32) -> f32 {
    let value = value.clamp(0.0, 1.0);
    value * value * (3.0 - 2.0 * value)
}

/// Shared tessellated patch. Displacement is sampled from each slot's control
/// texture in the terrain vertex shader.
fn chunk_grid(size: f32, segments: u32) -> (Vec<f32>, Vec<u32>) {
    let segments = segments.max(1);
    let side = segments + 1;
    let mut vertices = Vec::with_capacity((side * side * 8) as usize);
    let mut indices = Vec::with_capacity((segments * segments * 6) as usize);
    for z in 0..=segments {
        for x in 0..=segments {
            let u = x as f32 / segments as f32;
            let v = z as f32 / segments as f32;
            vertices.extend_from_slice(&[u * size, 0.0, v * size, 0.0, 1.0, 0.0, u, v]);
        }
    }
    for z in 0..segments {
        for x in 0..segments {
            let a = z * side + x;
            let b = a + 1;
            let c = a + side;
            let d = c + 1;
            indices.extend_from_slice(&[a, d, b, a, c, d]);
        }
    }
    (vertices, indices)
}

/// A ready-to-render terrain scene for `--demo terrain`.
pub struct TerrainScene {
    pub world: GameWorld,
    pub renderer: Renderer,
    streamer: TerrainStreamer,
    camera: Entity,
    center: Vec3,
    orbit: f32,
    fixed_camera: bool,
}

impl TerrainScene {
    pub fn build<G: Gpu>(gpu: &mut G, biome: Biome) -> TerrainScene {
        use successor_engine_render::components::{
            CamTarget, Camera, DirectionalLight, Projection, RectNorm,
        };
        use successor_engine_render::gpu::ClearSpec;

        let mut renderer = crate::configured_renderer(gpu).expect("renderer initialization failed");
        renderer.set_ambient(0.55);
        let fog = match biome {
            Biome::Forest => [0.615, 0.658, 0.408],
            Biome::Desert => [0.788, 0.678, 0.510],
        };
        renderer.set_fog(fog, 120.0, 260.0);
        let mut world = GameWorld::new();

        // Demo-scale streaming; production supplies the authoritative chunk size.
        let mut streamer = TerrainStreamer::new(
            0x0d3d_071e,
            biome,
            64.0 * WORLD_UNITS_PER_CELL as f64,
            2,
            0b1,
        );
        let center = vec3(0.0, 0.0, 0.0);
        renderer.gi_set_focus([center.x, center.y, center.z]);
        streamer.ensure_around(
            &mut world,
            &mut renderer,
            gpu,
            center.x as f64,
            center.z as f64,
        );

        let sun = world.spawn();
        world.set_component(
            sun,
            DirectionalLight {
                dir: vec3(-0.4, -1.0, -0.3).normalize(),
                color: [1.0, 0.98, 0.92],
                cast_shadows: false,
            },
        );

        let orbit = 150.0f32;
        let camera = world.spawn();
        world.set_component(
            camera,
            Camera {
                viewport_id: 0,
                order: 0,
                projection: Projection::Perspective {
                    fovy: 50.0_f32.to_radians(),
                    near: 0.5,
                    far: 2000.0,
                },
                target: CamTarget::Screen(RectNorm::FULL),
                clear: ClearSpec {
                    color: Some([fog[0], fog[1], fog[2], 1.0]),
                    depth: Some(1.0),
                },
                eye: center.add(vec3(orbit, orbit * 0.9, orbit)),
                look_at: center,
                up: Vec3::Y,
            },
        );

        TerrainScene {
            world,
            renderer,
            streamer,
            camera,
            center,
            orbit,
            fixed_camera: false,
        }
    }

    pub fn use_material_detail_view(&mut self) {
        self.fixed_camera = true;
        let (eye, look) = match self.streamer.biome {
            Biome::Desert => (vec3(40.0, 15.0, 33.0), vec3(0.0, 0.0, -10.0)),
            Biome::Forest => (vec3(36.0, 13.0, 30.0), vec3(0.0, 0.0, -8.0)),
        };
        if let Some(camera) = self
            .world
            .get_component::<successor_engine_render::components::Camera>(self.camera)
        {
            camera.eye = self.center.add(eye);
            camera.look_at = self.center.add(look);
        }
    }

    pub fn animate(&mut self, frame: u64) {
        if self.fixed_camera {
            return;
        }
        use successor_engine_render::components::Camera;
        let angle = frame as f32 * 0.008;
        let eye = self.center.add(vec3(
            angle.cos() * self.orbit,
            self.orbit * 0.9,
            angle.sin() * self.orbit,
        ));
        if let Some(cam) = self.world.get_component::<Camera>(self.camera) {
            cam.eye = eye;
        }
        let _ = &self.streamer; // streaming re-runs only when the center moves (static demo).
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use successor_engine_render::gpu::{MockCall, MockGpu};
    use successor_engine_render::renderer::{RenderQuality, RendererLimits};

    #[test]
    fn traversal_reuses_fixed_terrain_resources() {
        let mut gpu = MockGpu::default();
        let mut renderer = Renderer::new(
            &mut gpu,
            RendererLimits {
                quality: RenderQuality::Low,
                ..RendererLimits::default()
            },
        )
        .expect("renderer");
        let mut world = GameWorld::new();
        let mut streamer = TerrainStreamer::new(7, Biome::Desert, 256.0, 1, 1);
        streamer.ensure_around(&mut world, &mut renderer, &mut gpu, 0.0, 0.0);
        let first = streamer.resident_resources();
        let first_detail_batches = renderer.instance_batch_count();
        streamer.ensure_around(&mut world, &mut renderer, &mut gpu, 2560.0, -2560.0);
        let second = streamer.resident_resources();
        let second_detail_batches = renderer.instance_batch_count();
        assert_eq!(first, (9, 9, 1));
        assert_eq!(second, first);
        assert_eq!(first_detail_batches, 3);
        assert_eq!(second_detail_batches, first_detail_batches);
        assert_eq!(
            gpu.log
                .iter()
                .filter(|call| matches!(call, MockCall::CreateTextureArray))
                .count(),
            2
        );
    }
    #[test]
    fn tessellated_patch_has_shared_edges_and_expected_topology() {
        let (vertices, indices) = chunk_grid(64.0, 32);
        assert_eq!(vertices.len(), 33 * 33 * 8);
        assert_eq!(indices.len(), 32 * 32 * 6);
        let first = &vertices[0..8];
        let last = &vertices[(33 * 33 - 1) * 8..33 * 33 * 8];
        assert_eq!(&first[0..3], &[0.0, 0.0, 0.0]);
        assert_eq!(&last[0..3], &[64.0, 0.0, 64.0]);
        assert!(indices.iter().all(|index| *index < 33 * 33));
    }

    #[test]
    fn structure_exclusions_flatten_only_the_padded_footprint() {
        let mut streamer = TerrainStreamer::new(7, Biome::Forest, 64.0, 1, 1);
        streamer.set_exclusions(&[TerrainExclusion {
            min: [10.0, 20.0],
            max: [18.0, 28.0],
            feather: 4.0,
        }]);
        assert_eq!(streamer.height_at(14.0, 24.0), 0.0);
        assert_eq!(streamer.height_at(10.0, 20.0), 0.0);
        let feathered = streamer.height_at(20.0, 24.0);
        let base = terrain_height(7, 20.0, 24.0, Biome::Forest);
        assert!((feathered - base * 0.5).abs() < 1.0e-5);
        assert_eq!(
            streamer.height_at(30.0, 24.0),
            terrain_height(7, 30.0, 24.0, Biome::Forest)
        );
    }

    #[test]
    fn detail_scatter_respects_structure_exclusions_and_capacity() {
        let mut streamer = TerrainStreamer::new(17, Biome::Forest, 64.0, 1, 1);
        let exclusion = TerrainExclusion {
            min: [8.0, 8.0],
            max: [56.0, 56.0],
            feather: 3.0,
        };
        streamer.set_exclusions(&[exclusion]);
        streamer.scatter_details(0.0, 0.0);
        let mut count = 0;
        for matrices in &streamer.detail_matrices {
            assert!(matrices.len() <= DETAIL_CAPACITY_PER_KIND as usize);
            for matrix in matrices {
                count += 1;
                assert!(!point_blocked(&[exclusion], [matrix[12], matrix[14]]));
            }
        }
        assert!(count > 0);
    }

    #[test]
    fn terrain_scene_reaches_deferred_draws() {
        let mut gpu = MockGpu::default();
        let mut scene = TerrainScene::build(&mut gpu, Biome::Desert);
        gpu.log.clear();
        scene
            .renderer
            .render(&mut gpu, &mut scene.world, 1280, 720)
            .expect("terrain render");
        assert!(
            gpu.draw_calls() >= 25,
            "all resident terrain chunks must draw"
        );
        assert!(gpu.log.iter().any(|call| matches!(
            call,
            MockCall::UniformFloat {
                name: "u_terrainWorldSize",
                ..
            }
        )));
        assert!(gpu
            .log
            .iter()
            .any(|call| matches!(call, MockCall::DrawInstanced { instances } if *instances > 0)));
    }
}
