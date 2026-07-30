//! Terrain chunk streamer: bakes procgen texture chunks around a center and
//! renders each as one textured ground quad, evicting chunks outside the ring.
//! Ports the streaming policy of `client-3d/src/render/terrain/TerrainStreamer`
//! (world-space chunk grid, ring prefetch, LRU eviction) at a parameterized
//! scale — production uses `config.terrain` values (chunk 256 / texture 1024²),
//! the demo uses smaller values for fast bakes.

use std::collections::HashMap;

use successor_engine_core::ecs::{Entity, WorldOps};
use successor_engine_core::math::{vec3, Vec3};
use successor_engine_render::components::{MeshRenderer, SkinRef, Transform};
use successor_engine_render::gpu::{Filter, Gpu};
use successor_engine_render::renderer::Renderer;

use super::terrain::{paint_terrain_pixel, Biome};
use crate::GameWorld;

/// Flat mean ground albedo per biome, fed to the GI volume as the bounce color
/// of the y=0 plane.
fn biome_ground_albedo(biome: Biome) -> [f32; 3] {
    match biome {
        Biome::Forest => [0.30, 0.34, 0.20],
        _ => [0.79, 0.68, 0.51],
    }
}

pub struct TerrainStreamer {
    seed: i32,
    biome: Biome,
    /// World-units (cells) per chunk edge.
    chunk_cells: f64,
    /// Texture resolution per chunk edge.
    tex_px: u32,
    /// Ring radius in chunks kept resident around the center.
    radius: i32,
    loaded: HashMap<(i32, i32), Entity>,
    mask: u32,
}

impl TerrainStreamer {
    pub fn new(seed: i32, biome: Biome, chunk_cells: f64, tex_px: u32, radius: i32, viewport_mask: u32) -> Self {
        Self {
            seed,
            biome,
            chunk_cells,
            tex_px,
            radius,
            loaded: HashMap::new(),
            mask: viewport_mask,
        }
    }

    fn chunk_of(&self, world_x: f64, world_z: f64) -> (i32, i32) {
        (
            (world_x / self.chunk_cells).floor() as i32,
            (world_z / self.chunk_cells).floor() as i32,
        )
    }

    /// Ensure every chunk within `radius` of the world center is loaded; evict
    /// chunks beyond `radius + 1`.
    pub fn ensure_around<G: Gpu>(
        &mut self,
        world: &mut GameWorld,
        renderer: &mut Renderer,
        gpu: &mut G,
        center_x: f64,
        center_z: f64,
    ) {
        // Feed the GI volume the flat per-biome ground albedo (idempotent).
        renderer.gi_set_ground_albedo(biome_ground_albedo(self.biome));
        let (ccx, ccz) = self.chunk_of(center_x, center_z);
        for dz in -self.radius..=self.radius {
            for dx in -self.radius..=self.radius {
                let key = (ccx + dx, ccz + dz);
                if !self.loaded.contains_key(&key) {
                    let e = self.load_chunk(world, renderer, gpu, key);
                    self.loaded.insert(key, e);
                }
            }
        }
        // Evict distant chunks (despawn entity; renderer GPU meshes persist but
        // the entity no longer draws — acceptable for the demo scale).
        let evict = self.radius + 1;
        let far: Vec<(i32, i32)> = self
            .loaded
            .keys()
            .copied()
            .filter(|(cx, cz)| (cx - ccx).abs() > evict || (cz - ccz).abs() > evict)
            .collect();
        for key in far {
            if let Some(e) = self.loaded.remove(&key) {
                world.destroy(e);
            }
        }
        world.flush();
    }

    fn load_chunk<G: Gpu>(
        &self,
        world: &mut GameWorld,
        renderer: &mut Renderer,
        gpu: &mut G,
        (cx, cz): (i32, i32),
    ) -> Entity {
        let origin_x = cx as f64 * self.chunk_cells;
        let origin_z = cz as f64 * self.chunk_cells;
        let rgba = self.bake(origin_x, origin_z);
        let material = renderer.add_textured_material_pbr(gpu, self.tex_px, self.tex_px, &rgba, Filter::Linear, 0.0, 1.0);
        let size = self.chunk_cells as f32;
        let (verts, indices) = chunk_quad(size);
        let mesh = renderer.upload_mesh(gpu, &verts, &indices);
        let e = world.spawn();
        world.set_component(
            e,
            Transform {
                pos: vec3(origin_x as f32, 0.0, origin_z as f32),
                ..Default::default()
            },
        );
        world.set_component(
            e,
            MeshRenderer {
                mesh,
                material,
                viewport_mask: self.mask,
                skin: SkinRef::NONE,
            },
        );
        e
    }

    /// Paint the chunk's texture in world space (texel centers map to cells).
    fn bake(&self, origin_x: f64, origin_z: f64) -> Vec<u8> {
        let px = self.tex_px as usize;
        let mut out = vec![0u8; px * px * 4];
        let step = self.chunk_cells / self.tex_px as f64;
        for j in 0..px {
            let wz = origin_z + (j as f64 + 0.5) * step;
            for i in 0..px {
                let wx = origin_x + (i as f64 + 0.5) * step;
                let texel = paint_terrain_pixel(self.seed, wx, wz, self.biome);
                let o = (j * px + i) * 4;
                out[o] = texel.rgba[0];
                out[o + 1] = texel.rgba[1];
                out[o + 2] = texel.rgba[2];
                out[o + 3] = texel.rgba[3];
            }
        }
        out
    }
}

/// One ground quad on the XZ plane, `size` on a side, origin at its min corner
/// (the entity `Transform` positions it), normal +Y, UV 0..1 mapping x→u z→v.
fn chunk_quad(size: f32) -> (Vec<f32>, Vec<u32>) {
    let n = [0.0f32, 1.0, 0.0];
    // pos(3) normal(3) uv(2)
    let v = vec![
        0.0, 0.0, 0.0, n[0], n[1], n[2], 0.0, 0.0,
        size, 0.0, 0.0, n[0], n[1], n[2], 1.0, 0.0,
        size, 0.0, size, n[0], n[1], n[2], 1.0, 1.0,
        0.0, 0.0, size, n[0], n[1], n[2], 0.0, 1.0,
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
}

impl TerrainScene {
    pub fn build<G: Gpu>(gpu: &mut G, biome: Biome) -> TerrainScene {
        use successor_engine_render::components::{CamTarget, Camera, DirectionalLight, Projection, RectNorm};
        use successor_engine_render::gpu::ClearSpec;

        let mut renderer = Renderer::new(gpu, crate::quality_limits());
        renderer.set_ambient(0.55);
        let fog = match biome {
            Biome::Forest => [0.615, 0.658, 0.408],
            Biome::Desert => [0.788, 0.678, 0.510],
        };
        renderer.set_fog(fog, 120.0, 260.0);
        let mut world = GameWorld::new();

        // Demo-scale streaming (fast bake); production plugs config.terrain values.
        let mut streamer = TerrainStreamer::new(0x0d3d_071e, biome, 64.0, 128, 2, 0b1);
        let center = vec3(0.0, 0.0, 0.0);
        streamer.ensure_around(&mut world, &mut renderer, gpu, center.x as f64, center.z as f64);

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
                projection: Projection::Perspective { fovy: 50.0_f32.to_radians(), near: 0.5, far: 2000.0 },
                target: CamTarget::Screen(RectNorm::FULL),
                clear: ClearSpec { color: Some([fog[0], fog[1], fog[2], 1.0]), depth: Some(1.0) },
                eye: center.add(vec3(orbit, orbit * 0.9, orbit)),
                look_at: center,
                up: Vec3::Y,
            },
        );

        TerrainScene { world, renderer, streamer, camera, center, orbit }
    }

    pub fn animate(&mut self, frame: u64) {
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
