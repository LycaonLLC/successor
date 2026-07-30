//! Voxel global illumination (VXGI-lite) for a mostly-static world.
//!
//! Two cubic volumes track the camera:
//! - an **albedo volume** (RGBA8: rgb mean albedo, a occupancy) voxelized on the
//!   CPU from lightweight proxies (a flat ground plane + yaw-rotated prop boxes),
//!   rebuilt amortized only when the volume recenters or the occluder set changes;
//! - a **radiance volume** (RGBA8) filled on the GPU by layered sun-injection
//!   passes sampling the albedo volume + the shadow map, then mipmapped for cone
//!   tracing in the deferred light shader.
//!
//! No compute / image-store: injection uses `framebufferTextureLayer` fullscreen
//! passes, legal on GL 3.3 core and WebGL2. Work is amortized across frames.

use alloc::vec;
use alloc::vec::Vec;
use libm::{cosf, floorf, sinf};

use crate::gpu::{
    BufferId, BufferUsage, ClearSpec, Cull, Gpu, PipelineState, ProgramId, RectPx, Texture3dDesc,
    TextureFormat, TextureId, Uniform, UniformValue, QUAD_LAYOUT,
};

/// Cells per axis.
pub const GI_SIZE: u32 = 64;
/// Meters per cell (48 m span).
pub const GI_CELL: f32 = 0.75;
/// Fixed volume floor (world Y of the min corner); the world is flat at y=0, so
/// this keeps the ground band (cell y = 1) just below the surface.
const GI_ORIGIN_Y: f32 = -2.0 * GI_CELL;

/// A yaw-rotated box occluder proxy (static geometry) contributing bounce color.
#[derive(Clone, Copy, Debug)]
pub struct GiOccluder {
    pub center: [f32; 3],
    pub half_extents: [f32; 3],
    pub yaw: f32,
    pub albedo: [f32; 3],
}

/// CPU voxelization of one Z layer's XY grid into `out` (RGBA8, `GI_SIZE^2 * 4`
/// bytes). Ground fills the cell y-band overlapping `[-GI_CELL, 0)`; occluder
/// boxes fill cells whose center lies inside them. Pure — unit-testable.
pub fn fill_albedo_slice(
    out: &mut [u8],
    z_layer: u32,
    origin: [f32; 3],
    ground: [f32; 3],
    occ: &[GiOccluder],
) {
    let cell = GI_CELL;
    let cz = origin[2] + (z_layer as f32 + 0.5) * cell;
    for y in 0..GI_SIZE {
        let band_lo = origin[1] + y as f32 * cell;
        let band_hi = band_lo + cell;
        let is_ground_band = band_lo < 0.0 && band_hi > -cell;
        let cy = band_lo + 0.5 * cell;
        for x in 0..GI_SIZE {
            let cx = origin[0] + (x as f32 + 0.5) * cell;
            let idx = ((y * GI_SIZE + x) * 4) as usize;
            let mut rgb = [0.0f32; 3];
            let mut solid = false;
            if is_ground_band {
                rgb = ground;
                solid = true;
            }
            if !solid {
                for o in occ {
                    let dx = cx - o.center[0];
                    let dy = cy - o.center[1];
                    let dz = cz - o.center[2];
                    // Rotate into box space by -yaw around Y.
                    let c = cosf(-o.yaw);
                    let s = sinf(-o.yaw);
                    let lx = dx * c - dz * s;
                    let lz = dx * s + dz * c;
                    if lx.abs() <= o.half_extents[0]
                        && dy.abs() <= o.half_extents[1]
                        && lz.abs() <= o.half_extents[2]
                    {
                        rgb = o.albedo;
                        solid = true;
                        break;
                    }
                }
            }
            if solid {
                out[idx] = (rgb[0].clamp(0.0, 1.0) * 255.0) as u8;
                out[idx + 1] = (rgb[1].clamp(0.0, 1.0) * 255.0) as u8;
                out[idx + 2] = (rgb[2].clamp(0.0, 1.0) * 255.0) as u8;
                out[idx + 3] = 255;
            } else {
                out[idx] = 0;
                out[idx + 1] = 0;
                out[idx + 2] = 0;
                out[idx + 3] = 0;
            }
        }
    }
}

fn sun_key(dir: [f32; 3], color: [f32; 3]) -> i32 {
    let q = |v: f32| (v * 32.0) as i32;
    q(dir[0]).wrapping_mul(73856093)
        ^ q(dir[1]).wrapping_mul(19349663)
        ^ q(dir[2]).wrapping_mul(83492791)
        ^ q(color[0]).wrapping_mul(2654435761u32 as i32)
        ^ q(color[1]).wrapping_mul(40503)
        ^ q(color[2]).wrapping_mul(51787)
}

pub struct GiVolume {
    origin: [f32; 3],
    occluders: Vec<GiOccluder>,
    ground_albedo: [f32; 3],
    albedo_tex: TextureId,
    radiance_tex: TextureId,
    quad_buf: BufferId,
    slice_scratch: Vec<u8>,
    dirty_slice: u32, // next albedo Z slice to rebuild (GI_SIZE = clean)
    inject_slice: u32, // next radiance Z layer to inject (GI_SIZE = idle)
    needs_inject: bool,
    last_sun: i32,
}

impl GiVolume {
    pub fn new<G: Gpu>(gpu: &mut G) -> Self {
        let albedo_tex = gpu.create_texture_3d(
            &Texture3dDesc { size: GI_SIZE, format: TextureFormat::Rgba8, mips: false },
            None,
        );
        let radiance_tex = gpu.create_texture_3d(
            &Texture3dDesc { size: GI_SIZE, format: TextureFormat::Rgba8, mips: true },
            None,
        );
        // Fullscreen NDC quad (pos2, uv2) for the injection layer passes.
        let quad: [f32; 24] = [
            -1.0, -1.0, 0.0, 0.0, 1.0, -1.0, 1.0, 0.0, 1.0, 1.0, 1.0, 1.0, -1.0, -1.0, 0.0, 0.0,
            1.0, 1.0, 1.0, 1.0, -1.0, 1.0, 0.0, 1.0,
        ];
        let quad_buf = gpu.create_buffer(bytes(&quad), BufferUsage::Static);
        Self {
            origin: [0.0, GI_ORIGIN_Y, 0.0],
            occluders: Vec::with_capacity(512),
            ground_albedo: [0.5, 0.5, 0.5],
            albedo_tex,
            radiance_tex,
            quad_buf,
            slice_scratch: vec![0u8; (GI_SIZE * GI_SIZE * 4) as usize],
            dirty_slice: GI_SIZE,
            inject_slice: GI_SIZE,
            needs_inject: false,
            last_sun: 0,
        }
    }

    pub fn radiance(&self) -> TextureId {
        self.radiance_tex
    }
    pub fn origin(&self) -> [f32; 3] {
        self.origin
    }

    pub fn set_ground_albedo(&mut self, rgb: [f32; 3]) {
        if self.ground_albedo != rgb {
            self.ground_albedo = rgb;
            self.dirty_slice = 0;
        }
    }

    pub fn set_occluders(&mut self, occ: &[GiOccluder]) {
        self.occluders.clear();
        self.occluders.extend_from_slice(occ);
        self.dirty_slice = 0;
    }

    /// Snap the volume min corner so the camera `look_at` sits near its center;
    /// a moved origin marks every slice dirty.
    pub fn recenter(&mut self, look_at: [f32; 3]) {
        let half = GI_SIZE as f32 * GI_CELL * 0.5;
        let snap = |v: f32| floorf((v - half) / GI_CELL) * GI_CELL;
        let nx = snap(look_at[0]);
        let nz = snap(look_at[2]);
        if (nx - self.origin[0]).abs() > 1e-3 || (nz - self.origin[2]).abs() > 1e-3 {
            self.origin[0] = nx;
            self.origin[2] = nz;
            self.origin[1] = GI_ORIGIN_Y;
            self.dirty_slice = 0;
        }
    }

    /// Rebuild up to `budget` dirty albedo slices on the CPU and upload them.
    pub fn step_voxelize<G: Gpu>(&mut self, gpu: &mut G, budget: u32) {
        if self.dirty_slice >= GI_SIZE {
            return;
        }
        let end = (self.dirty_slice + budget).min(GI_SIZE);
        for z in self.dirty_slice..end {
            fill_albedo_slice(&mut self.slice_scratch, z, self.origin, self.ground_albedo, &self.occluders);
            gpu.update_texture_3d(self.albedo_tex, GI_SIZE, z, &self.slice_scratch);
        }
        self.dirty_slice = end;
        if self.dirty_slice >= GI_SIZE {
            // Albedo fully rebuilt → re-arm injection.
            self.needs_inject = true;
        }
    }

    /// Run up to `budget` radiance injection layer passes; regenerate the
    /// radiance mip chain once a full round completes.
    #[allow(clippy::too_many_arguments)]
    pub fn step_inject<G: Gpu>(
        &mut self,
        gpu: &mut G,
        inject_prog: ProgramId,
        shadow_depth: TextureId,
        light_view_proj: &[f32; 16],
        sun_dir: [f32; 3],
        sun_color: [f32; 3],
        budget: u32,
    ) {
        // Re-arm a full round when the sun changed or albedo was rebuilt.
        let key = sun_key(sun_dir, sun_color);
        if key != self.last_sun {
            self.last_sun = key;
            self.needs_inject = true;
        }
        if self.needs_inject && self.inject_slice >= GI_SIZE {
            self.inject_slice = 0;
            self.needs_inject = false;
        }
        if self.inject_slice >= GI_SIZE {
            return;
        }
        let end = (self.inject_slice + budget).min(GI_SIZE);
        for z in self.inject_slice..end {
            gpu.begin_layer_pass(
                self.radiance_tex,
                z,
                RectPx { x: 0, y: 0, w: GI_SIZE as i32, h: GI_SIZE as i32 },
                ClearSpec { color: Some([0.0, 0.0, 0.0, 0.0]), depth: None },
            );
            gpu.set_pipeline(
                inject_prog,
                &PipelineState {
                    depth_test: false,
                    depth_write: false,
                    cull: Cull::None,
                    color_write: true,
                    blend: false,
                    additive: false,
                },
            );
            gpu.bind_texture_3d(0, self.albedo_tex);
            gpu.bind_texture(1, shadow_depth);
            let uniforms = [
                Uniform { name: "u_albedoVol", value: UniformValue::Sampler(0) },
                Uniform { name: "u_shadowMap", value: UniformValue::Sampler(1) },
                Uniform { name: "u_layer", value: UniformValue::Float(z as f32) },
                Uniform { name: "u_giOrigin", value: UniformValue::Vec3(self.origin) },
                Uniform { name: "u_giCell", value: UniformValue::Float(GI_CELL) },
                Uniform { name: "u_lightViewProj", value: UniformValue::Mat4(*light_view_proj) },
                Uniform { name: "u_lightDir", value: UniformValue::Vec3(sun_dir) },
                Uniform { name: "u_lightColor", value: UniformValue::Vec3(sun_color) },
            ];
            gpu.set_uniforms(&uniforms);
            gpu.draw(self.quad_buf, None, &QUAD_LAYOUT, 6);
            gpu.end_pass();
        }
        self.inject_slice = end;
        if self.inject_slice >= GI_SIZE {
            gpu.generate_mipmaps_3d(self.radiance_tex);
        }
    }
}

fn bytes(s: &[f32]) -> &[u8] {
    // SAFETY: f32 has no invalid bit patterns; reinterpreting for GPU upload.
    unsafe { core::slice::from_raw_parts(s.as_ptr() as *const u8, core::mem::size_of_val(s)) }
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;
    use crate::gpu::MockGpu;

    fn cell_at(out: &[u8], x: u32, y: u32) -> [u8; 4] {
        let i = ((y * GI_SIZE + x) * 4) as usize;
        [out[i], out[i + 1], out[i + 2], out[i + 3]]
    }

    #[test]
    fn ground_band_only_on_expected_layer() {
        let origin = [0.0, GI_ORIGIN_Y, 0.0];
        let mut out = vec![0u8; (GI_SIZE * GI_SIZE * 4) as usize];
        // Ground band is cell y = 1 (band [-0.75, 0)).
        fill_albedo_slice(&mut out, 0, origin, [0.4, 0.3, 0.2], &[]);
        assert_eq!(cell_at(&out, 10, 0)[3], 0, "y=0 band is below ground, empty");
        assert_eq!(cell_at(&out, 10, 1)[3], 255, "y=1 band is the ground");
        assert_eq!(cell_at(&out, 10, 2)[3], 0, "y=2 band is above ground, empty");
    }

    #[test]
    fn box_occluder_marks_center_cells() {
        // A box centered near the volume center at world y ~ 2m.
        let origin = [0.0, GI_ORIGIN_Y, 0.0];
        let half = GI_SIZE as f32 * GI_CELL * 0.5; // 24
        let bx = origin[0] + half;
        let bz = origin[2] + half;
        let occ = [GiOccluder {
            center: [bx, 2.0, bz],
            half_extents: [1.5, 1.5, 1.5],
            yaw: 0.0,
            albedo: [0.9, 0.1, 0.1],
        }];
        // Z layer through the box center.
        let z = ((2.0f32 /* placeholder */).max(0.0)) as u32; // not used; compute below
        let _ = z;
        let zc = (((bz - origin[2]) / GI_CELL) as u32).min(GI_SIZE - 1);
        let mut out = vec![0u8; (GI_SIZE * GI_SIZE * 4) as usize];
        fill_albedo_slice(&mut out, zc, origin, [0.4, 0.3, 0.2], &occ);
        let xc = (((bx - origin[0]) / GI_CELL) as u32).min(GI_SIZE - 1);
        // World y=2 → cell y = (2 - origin.y)/cell = (2+1.5)/0.75 = 4.67 → 4.
        let yc = (((2.0 - origin[1]) / GI_CELL) as u32).min(GI_SIZE - 1);
        let c = cell_at(&out, xc, yc);
        assert_eq!(c[3], 255, "box center cell is solid");
        assert!(c[0] > c[2], "box albedo is reddish");
    }

    #[test]
    fn recenter_is_idempotent_and_dirties() {
        let mut gpu = MockGpu::default();
        let mut vol = GiVolume::new(&mut gpu);
        vol.dirty_slice = GI_SIZE; // clean
        vol.recenter([100.0, 0.0, 200.0]);
        assert_eq!(vol.dirty_slice, 0, "moving the origin dirties all slices");
        // Fully voxelize, then a same-target recenter must not re-dirty.
        vol.step_voxelize(&mut gpu, GI_SIZE);
        assert_eq!(vol.dirty_slice, GI_SIZE);
        vol.recenter([100.0, 0.0, 200.0]);
        assert_eq!(vol.dirty_slice, GI_SIZE, "same origin does not re-dirty");
    }

    #[test]
    fn voxelize_amortizes_to_full_upload() {
        let mut gpu = MockGpu::default();
        let mut vol = GiVolume::new(&mut gpu);
        vol.recenter([10.0, 0.0, 10.0]);
        gpu.log.clear();
        let budget = 8;
        let rounds = GI_SIZE.div_ceil(budget);
        for _ in 0..rounds {
            vol.step_voxelize(&mut gpu, budget);
        }
        let uploads = gpu
            .log
            .iter()
            .filter(|c| matches!(c, crate::gpu::MockCall::UpdateTexture3d { .. }))
            .count();
        assert_eq!(uploads, GI_SIZE as usize, "every slice uploaded exactly once");
    }

    #[test]
    fn inject_round_then_single_mipgen() {
        let mut gpu = MockGpu::default();
        let mut vol = GiVolume::new(&mut gpu);
        vol.recenter([10.0, 0.0, 10.0]);
        vol.step_voxelize(&mut gpu, GI_SIZE); // arms injection
        gpu.log.clear();
        let prog = ProgramId(1);
        let lvp = [0.0f32; 16];
        let budget = 16;
        let rounds = GI_SIZE.div_ceil(budget);
        for _ in 0..rounds {
            vol.step_inject(&mut gpu, prog, TextureId(2), &lvp, [0.0, -1.0, 0.0], [1.0, 1.0, 1.0], budget);
        }
        let layer_passes = gpu
            .log
            .iter()
            .filter(|c| matches!(c, crate::gpu::MockCall::BeginLayerPass { .. }))
            .count();
        let mipgens = gpu
            .log
            .iter()
            .filter(|c| matches!(c, crate::gpu::MockCall::GenMips3d))
            .count();
        assert_eq!(layer_passes, GI_SIZE as usize, "one pass per layer");
        assert_eq!(mipgens, 1, "mips regenerated once per completed round");
    }
}
