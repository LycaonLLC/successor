//! Terrain chunk streamer: updates continuous world-space control maps around
//! a center and renders pooled quads with one shared PBR tile library. It ports
//! the `client-3d` ring-prefetch and eviction policy without baking final color
//! into per-chunk textures.

use std::collections::HashMap;

use successor_engine_core::ecs::{Entity, WorldOps};
use successor_engine_core::math::{vec3, Vec3};
use successor_engine_render::components::{MaterialId, MeshId, MeshRenderer, SkinRef, Transform};
use successor_engine_render::gpu::{
    Filter, Gpu, MinFilter, TextureArrayDesc, TextureDesc, TextureFormat, TextureId, Wrap,
};
use successor_engine_render::renderer::{MaterialDesc, Renderer, TerrainMaterialDesc};

use super::terrain::{sample_terrain, Biome};
use super::terrain_material::{generate_terrain_tiles, TILE_LAYERS, TILE_SIZE};
use crate::GameWorld;

const CONTROL_INTERIOR_PX: u32 = 128;
const CONTROL_PX: u32 = CONTROL_INTERIOR_PX + 2;

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
        }
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
        let (verts, indices) = chunk_quad(size);
        let mesh = renderer.upload_mesh(gpu, &verts, &indices);
        let control_desc = control_texture_desc();
        let zeros = vec![0; self.control_scratch.len()];
        let slot_count = self.slots.capacity();
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
                    tile_scale: 2.0,
                    normal_strength: 1.2,
                }),
                ..MaterialDesc::default()
            });
            self.slots.push(TerrainSlot {
                control,
                material,
                entity: None,
            });
        }
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
                    tile_scale: 2.0,
                    normal_strength: 1.2,
                }),
                ..MaterialDesc::default()
            },
        );
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

    fn bake_control(&mut self, origin_x: f64, origin_z: f64) {
        let step = self.chunk_cells / (CONTROL_INTERIOR_PX - 1) as f64;
        for y in 0..CONTROL_PX {
            let world_z = origin_z + (y as f64 - 1.0) * step;
            for x in 0..CONTROL_PX {
                let world_x = origin_x + (x as f64 - 1.0) * step;
                let sample = sample_terrain(self.seed, world_x, world_z, self.biome);
                let offset = ((y * CONTROL_PX + x) * 4) as usize;
                self.control_scratch[offset] = unit_byte(sample.weights[0]);
                self.control_scratch[offset + 1] = unit_byte(sample.weights[1]);
                self.control_scratch[offset + 2] = unit_byte(sample.weights[2]);
                self.control_scratch[offset + 3] = unit_byte((sample.macro_tint - 0.78) / 0.44);
            }
        }
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

/// One ground quad on the XZ plane, `size` on a side, origin at its min corner
/// (the entity `Transform` positions it), normal +Y, UV 0..1 mapping x→u z→v.
fn chunk_quad(size: f32) -> (Vec<f32>, Vec<u32>) {
    let n = [0.0f32, 1.0, 0.0];
    // pos(3) normal(3) uv(2)
    let v = vec![
        0.0, 0.0, 0.0, n[0], n[1], n[2], 0.0, 0.0, size, 0.0, 0.0, n[0], n[1], n[2], 1.0, 0.0,
        size, 0.0, size, n[0], n[1], n[2], 1.0, 1.0, 0.0, 0.0, size, n[0], n[1], n[2], 0.0, 1.0,
    ];
    // CCW as seen from +Y.
    (v, vec![0, 2, 1, 0, 3, 2])
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

        let mut renderer =
            Renderer::new(gpu, crate::quality_limits()).expect("renderer initialization failed");
        renderer.set_ambient(0.55);
        let fog = match biome {
            Biome::Forest => [0.615, 0.658, 0.408],
            Biome::Desert => [0.788, 0.678, 0.510],
        };
        renderer.set_fog(fog, 120.0, 260.0);
        let mut world = GameWorld::new();

        // Demo-scale streaming; production supplies the authoritative chunk size.
        let mut streamer = TerrainStreamer::new(0x0d3d_071e, biome, 64.0, 2, 0b1);
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
        self.orbit = 54.0;
        if let Some(camera) = self
            .world
            .get_component::<successor_engine_render::components::Camera>(self.camera)
        {
            camera.eye = self.center.add(vec3(42.0, 24.0, 36.0));
            camera.look_at = self.center.add(vec3(0.0, 0.0, -8.0));
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
        streamer.ensure_around(&mut world, &mut renderer, &mut gpu, 2560.0, -2560.0);
        let second = streamer.resident_resources();
        assert_eq!(first, (9, 9, 1));
        assert_eq!(second, first);
        assert_eq!(
            gpu.log
                .iter()
                .filter(|call| matches!(call, MockCall::CreateTextureArray))
                .count(),
            2
        );
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
    }
}
