//! Camera-independent, world-aligned voxel GI for a mostly-static world.
//!
//! A 64³ toroidal volume is updated in 8×64×8 bricks. X/Z physical slots are
//! derived from world coordinates with Euclidean modulo, so scrolling preserves
//! overlapping data and only uploads newly exposed bricks. Animated meshes are
//! intentionally excluded: they receive GI but contribute through direct shadows.

use alloc::vec;
use alloc::vec::Vec;
use libm::{cosf, floorf, sinf, sqrtf};

use crate::gpu::{Gpu, Texture3dDesc, TextureFormat, TextureId};

pub const GI_SIZE: u32 = 64;
pub const GI_CELL: f32 = 0.75;
pub const GI_BRICK_SIZE: u32 = 8;
pub const GI_BRICKS_PER_FRAME: usize = 4;
const GI_BRICKS: i32 = (GI_SIZE / GI_BRICK_SIZE) as i32;
const GI_ORIGIN_Y: f32 = -2.0 * GI_CELL;
const BRICK_VOXELS: usize = (GI_BRICK_SIZE * GI_SIZE * GI_BRICK_SIZE) as usize;
const FADE_FRAMES: f32 = 8.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GiOccluder {
    pub center: [f32; 3],
    pub half_extents: [f32; 3],
    pub yaw: f32,
    pub albedo: [f32; 3],
}

#[derive(Clone, Copy, Debug)]
struct PreparedGiOccluder {
    source: GiOccluder,
    sin_yaw: f32,
    cos_yaw: f32,
    min: [f32; 3],
    max: [f32; 3],
}

impl PreparedGiOccluder {
    fn new(source: GiOccluder) -> Self {
        let sin_yaw = sinf(source.yaw);
        let cos_yaw = cosf(source.yaw);
        let ex = cos_yaw.abs() * source.half_extents[0] + sin_yaw.abs() * source.half_extents[2];
        let ez = sin_yaw.abs() * source.half_extents[0] + cos_yaw.abs() * source.half_extents[2];
        Self {
            source,
            sin_yaw,
            cos_yaw,
            min: [
                source.center[0] - ex,
                source.center[1] - source.half_extents[1],
                source.center[2] - ez,
            ],
            max: [
                source.center[0] + ex,
                source.center[1] + source.half_extents[1],
                source.center[2] + ez,
            ],
        }
    }

    fn contains(&self, p: [f32; 3]) -> bool {
        let dx = p[0] - self.source.center[0];
        let dz = p[2] - self.source.center[2];
        let lx = dx * self.cos_yaw + dz * self.sin_yaw;
        let lz = -dx * self.sin_yaw + dz * self.cos_yaw;
        lx.abs() <= self.source.half_extents[0]
            && (p[1] - self.source.center[1]).abs() <= self.source.half_extents[1]
            && lz.abs() <= self.source.half_extents[2]
    }

    fn ray_hit(&self, origin: [f32; 3], dir: [f32; 3]) -> bool {
        let ox = origin[0] - self.source.center[0];
        let oz = origin[2] - self.source.center[2];
        let local_o = [
            ox * self.cos_yaw + oz * self.sin_yaw,
            origin[1] - self.source.center[1],
            -ox * self.sin_yaw + oz * self.cos_yaw,
        ];
        let local_d = [
            dir[0] * self.cos_yaw + dir[2] * self.sin_yaw,
            dir[1],
            -dir[0] * self.sin_yaw + dir[2] * self.cos_yaw,
        ];
        let mut t_min: f32 = 0.001;
        let mut t_max = f32::MAX;
        for axis in 0..3 {
            let extent = self.source.half_extents[axis];
            if local_d[axis].abs() < 1.0e-6 {
                if local_o[axis].abs() > extent {
                    return false;
                }
            } else {
                let inv = 1.0 / local_d[axis];
                let mut a = (-extent - local_o[axis]) * inv;
                let mut b = (extent - local_o[axis]) * inv;
                if a > b {
                    core::mem::swap(&mut a, &mut b);
                }
                t_min = t_min.max(a);
                t_max = t_max.min(b);
                if t_max < t_min {
                    return false;
                }
            }
        }
        t_max >= t_min
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GiWorkCounters {
    pub albedo_builds: u64,
    pub radiance_builds: u64,
    pub resident_uploads: u64,
    pub mipmap_rebuilds: u64,
    pub full_rebuilds: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct GiBinding {
    pub radiance: TextureId,
    pub origin: [f32; 3],
    pub valid_min: [f32; 3],
    pub valid_max: [f32; 3],
    pub blend: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WorkKind {
    None,
    Geometry,
    Radiance,
    Scroll,
}

pub struct GiVolume {
    committed_origin: [i32; 2],
    requested_origin: [i32; 2],
    active_origin: [i32; 2],
    valid_min: [i32; 2],
    valid_max: [i32; 2],
    focus: [f32; 3],
    occluders: Vec<GiOccluder>,
    prepared: Vec<PreparedGiOccluder>,
    ground_albedo: [f32; 3],
    albedo_tex: TextureId,
    radiance_tex: TextureId,
    albedo_scratch: Vec<u8>,
    radiance_scratch: Vec<u8>,
    owner_scratch: Vec<u32>,
    dirty_bricks: Vec<[i32; 2]>,
    dirty_index: usize,
    work: WorkKind,
    geometry_dirty: bool,
    light_dirty: bool,
    ready: bool,
    blend: f32,
    fade: i8,
    sun_dir: [f32; 3],
    sun_color: [f32; 3],
    last_sun: i32,
    counters: GiWorkCounters,
}

impl GiVolume {
    pub fn new<G: Gpu>(gpu: &mut G) -> Self {
        let albedo_tex = gpu.create_texture_3d(
            &Texture3dDesc {
                size: GI_SIZE,
                format: TextureFormat::Rgba8,
                mips: false,
                wrap_xz: true,
            },
            None,
        );
        let radiance_tex = gpu.create_texture_3d(
            &Texture3dDesc {
                size: GI_SIZE,
                format: TextureFormat::Rgba8,
                mips: true,
                wrap_xz: true,
            },
            None,
        );
        let mut volume = Self {
            committed_origin: [-(GI_SIZE as i32) / 2, -(GI_SIZE as i32) / 2],
            requested_origin: [-(GI_SIZE as i32) / 2, -(GI_SIZE as i32) / 2],
            active_origin: [-(GI_SIZE as i32) / 2, -(GI_SIZE as i32) / 2],
            valid_min: [-(GI_SIZE as i32) / 2, -(GI_SIZE as i32) / 2],
            valid_max: [GI_SIZE as i32 / 2, GI_SIZE as i32 / 2],
            focus: [0.0, 0.0, 0.0],
            occluders: Vec::with_capacity(512),
            prepared: Vec::with_capacity(512),
            ground_albedo: [0.5, 0.5, 0.5],
            albedo_tex,
            radiance_tex,
            albedo_scratch: vec![0; BRICK_VOXELS * 4],
            radiance_scratch: vec![0; BRICK_VOXELS * 4],
            owner_scratch: vec![0; BRICK_VOXELS],
            dirty_bricks: Vec::with_capacity((GI_BRICKS * GI_BRICKS) as usize),
            dirty_index: 0,
            work: WorkKind::None,
            geometry_dirty: false,
            light_dirty: false,
            ready: false,
            blend: 0.0,
            fade: 0,
            sun_dir: [0.0, -1.0, 0.0],
            sun_color: [1.0, 1.0, 1.0],
            last_sun: 0,
            counters: GiWorkCounters::default(),
        };
        volume.start_full(WorkKind::Geometry, volume.requested_origin);
        volume
    }

    pub(crate) fn radiance_texture(&self) -> TextureId {
        self.radiance_tex
    }

    pub fn binding(&self) -> Option<GiBinding> {
        if !self.ready {
            return None;
        }
        Some(GiBinding {
            radiance: self.radiance_tex,
            origin: [
                self.committed_origin[0] as f32 * GI_CELL,
                GI_ORIGIN_Y,
                self.committed_origin[1] as f32 * GI_CELL,
            ],
            valid_min: [
                self.valid_min[0] as f32 * GI_CELL,
                GI_ORIGIN_Y,
                self.valid_min[1] as f32 * GI_CELL,
            ],
            valid_max: [
                self.valid_max[0] as f32 * GI_CELL,
                GI_ORIGIN_Y + GI_SIZE as f32 * GI_CELL,
                self.valid_max[1] as f32 * GI_CELL,
            ],
            blend: self.blend,
        })
    }

    pub fn counters(&self) -> GiWorkCounters {
        self.counters
    }

    pub fn is_idle(&self) -> bool {
        self.work == WorkKind::None && self.fade == 0 && !self.geometry_dirty && !self.light_dirty
    }

    pub fn set_focus(&mut self, focus: [f32; 3]) {
        self.focus = focus;
        let brick_cells = GI_BRICK_SIZE as i32;
        let center_brick_x = floorf(focus[0] / (GI_CELL * GI_BRICK_SIZE as f32)) as i32;
        let center_brick_z = floorf(focus[2] / (GI_CELL * GI_BRICK_SIZE as f32)) as i32;
        self.requested_origin = [
            (center_brick_x - GI_BRICKS / 2) * brick_cells,
            (center_brick_z - GI_BRICKS / 2) * brick_cells,
        ];
    }

    pub fn set_ground_albedo(&mut self, rgb: [f32; 3]) {
        if self.ground_albedo != rgb {
            self.ground_albedo = rgb;
            self.geometry_dirty = true;
            self.begin_fade_out();
        }
    }

    pub fn set_occluders(&mut self, occ: &[GiOccluder]) {
        if self.occluders == occ {
            return;
        }
        self.occluders.clear();
        self.occluders.extend_from_slice(occ);
        self.prepared.clear();
        self.prepared
            .extend(occ.iter().copied().map(PreparedGiOccluder::new));
        self.geometry_dirty = true;
        self.begin_fade_out();
    }

    pub fn step<G: Gpu>(&mut self, gpu: &mut G, sun_dir: [f32; 3], sun_color: [f32; 3]) {
        let key = sun_key(sun_dir, sun_color);
        self.sun_dir = sun_dir;
        self.sun_color = sun_color;
        if self.last_sun != 0 && key != self.last_sun {
            self.light_dirty = true;
            self.begin_fade_out();
        }
        self.last_sun = key;

        if self.fade < 0 {
            self.blend = (self.blend - 1.0 / FADE_FRAMES).max(0.0);
            if self.blend > 0.0 {
                return;
            }
            self.fade = 0;
            if self.geometry_dirty {
                self.geometry_dirty = false;
                self.light_dirty = false;
                self.start_full(WorkKind::Geometry, self.requested_origin);
            } else if self.light_dirty {
                self.light_dirty = false;
                self.start_full(WorkKind::Radiance, self.committed_origin);
            }
        }

        if self.work == WorkKind::None {
            if self.geometry_dirty {
                self.begin_fade_out();
                return;
            }
            if self.requested_origin != self.committed_origin {
                self.start_scroll();
            } else if self.light_dirty {
                self.begin_fade_out();
                return;
            } else if self.fade > 0 {
                self.blend = (self.blend + 1.0 / FADE_FRAMES).min(1.0);
                if self.blend >= 1.0 {
                    self.fade = 0;
                }
                return;
            } else {
                return;
            }
        }

        let end = (self.dirty_index + GI_BRICKS_PER_FRAME).min(self.dirty_bricks.len());
        while self.dirty_index < end {
            let world_brick = self.dirty_bricks[self.dirty_index];
            fill_albedo_brick(
                &mut self.albedo_scratch,
                &mut self.owner_scratch,
                world_brick,
                self.ground_albedo,
                &self.prepared,
            );
            if self.work != WorkKind::Radiance {
                self.counters.albedo_builds += 1;
                let offset = brick_offset(world_brick);
                gpu.update_texture_3d_region(
                    self.albedo_tex,
                    offset,
                    [GI_BRICK_SIZE, GI_SIZE, GI_BRICK_SIZE],
                    &self.albedo_scratch,
                );
            }
            fill_radiance_brick(
                &mut self.radiance_scratch,
                &self.albedo_scratch,
                &self.owner_scratch,
                world_brick,
                self.sun_dir,
                self.sun_color,
                &self.prepared,
            );
            self.counters.radiance_builds += 1;
            gpu.update_texture_3d_region(
                self.radiance_tex,
                brick_offset(world_brick),
                [GI_BRICK_SIZE, GI_SIZE, GI_BRICK_SIZE],
                &self.radiance_scratch,
            );
            self.counters.resident_uploads += 1;
            self.dirty_index += 1;
        }

        if self.dirty_index == self.dirty_bricks.len() {
            gpu.generate_mipmaps_3d(self.radiance_tex);
            self.counters.mipmap_rebuilds += 1;
            let completed = self.work;
            self.work = WorkKind::None;
            if completed == WorkKind::Scroll || completed == WorkKind::Geometry {
                self.committed_origin = self.active_origin;
            }
            self.valid_min = self.committed_origin;
            self.valid_max = [
                self.committed_origin[0] + GI_SIZE as i32,
                self.committed_origin[1] + GI_SIZE as i32,
            ];
            self.ready = true;
            if completed != WorkKind::Scroll || self.blend < 1.0 {
                self.fade = 1;
            }
        }
    }

    fn begin_fade_out(&mut self) {
        if self.ready && self.work == WorkKind::None && self.fade >= 0 {
            self.fade = -1;
        }
    }

    fn start_full(&mut self, kind: WorkKind, origin: [i32; 2]) {
        self.dirty_bricks.clear();
        let bx0 = origin[0].div_euclid(GI_BRICK_SIZE as i32);
        let bz0 = origin[1].div_euclid(GI_BRICK_SIZE as i32);
        for z in 0..GI_BRICKS {
            for x in 0..GI_BRICKS {
                self.dirty_bricks.push([bx0 + x, bz0 + z]);
            }
        }
        self.dirty_index = 0;
        self.work = kind;
        self.active_origin = origin;
        self.counters.full_rebuilds += 1;
    }

    fn start_scroll(&mut self) {
        let dx = self.requested_origin[0] - self.committed_origin[0];
        let dz = self.requested_origin[1] - self.committed_origin[1];
        if dx.abs() >= GI_SIZE as i32 || dz.abs() >= GI_SIZE as i32 {
            self.start_full(WorkKind::Geometry, self.requested_origin);
            return;
        }
        self.dirty_bricks.clear();
        let old_min = [
            self.committed_origin[0].div_euclid(GI_BRICK_SIZE as i32),
            self.committed_origin[1].div_euclid(GI_BRICK_SIZE as i32),
        ];
        let new_min = [
            self.requested_origin[0].div_euclid(GI_BRICK_SIZE as i32),
            self.requested_origin[1].div_euclid(GI_BRICK_SIZE as i32),
        ];
        for z in 0..GI_BRICKS {
            for x in 0..GI_BRICKS {
                let b = [new_min[0] + x, new_min[1] + z];
                if b[0] < old_min[0]
                    || b[0] >= old_min[0] + GI_BRICKS
                    || b[1] < old_min[1]
                    || b[1] >= old_min[1] + GI_BRICKS
                {
                    self.dirty_bricks.push(b);
                }
            }
        }
        self.dirty_index = 0;
        self.work = WorkKind::Scroll;
        self.active_origin = self.requested_origin;
        self.valid_min = [
            self.committed_origin[0].max(self.requested_origin[0]),
            self.committed_origin[1].max(self.requested_origin[1]),
        ];
        self.valid_max = [
            (self.committed_origin[0] + GI_SIZE as i32)
                .min(self.requested_origin[0] + GI_SIZE as i32),
            (self.committed_origin[1] + GI_SIZE as i32)
                .min(self.requested_origin[1] + GI_SIZE as i32),
        ];
    }
}

fn fill_albedo_brick(
    out: &mut [u8],
    owners: &mut [u32],
    world_brick: [i32; 2],
    ground: [f32; 3],
    occluders: &[PreparedGiOccluder],
) {
    out.fill(0);
    owners.fill(u32::MAX);
    let world_min_x = world_brick[0] as f32 * GI_BRICK_SIZE as f32 * GI_CELL;
    let world_min_z = world_brick[1] as f32 * GI_BRICK_SIZE as f32 * GI_CELL;
    let world_max_x = world_min_x + GI_BRICK_SIZE as f32 * GI_CELL;
    let world_max_z = world_min_z + GI_BRICK_SIZE as f32 * GI_CELL;

    for z in 0..GI_BRICK_SIZE {
        for y in 0..GI_SIZE {
            let band_lo = GI_ORIGIN_Y + y as f32 * GI_CELL;
            let band_hi = band_lo + GI_CELL;
            if band_lo < 0.0 && band_hi > -GI_CELL {
                for x in 0..GI_BRICK_SIZE {
                    write_voxel(out, brick_index(x, y, z), ground);
                }
            }
        }
    }

    for (owner, occ) in occluders.iter().enumerate() {
        if occ.max[0] < world_min_x
            || occ.min[0] > world_max_x
            || occ.max[2] < world_min_z
            || occ.min[2] > world_max_z
        {
            continue;
        }
        let x0 = floorf((occ.min[0] - world_min_x) / GI_CELL).max(0.0) as u32;
        let x1 = (floorf((occ.max[0] - world_min_x) / GI_CELL) as i32 + 1)
            .clamp(0, GI_BRICK_SIZE as i32) as u32;
        let z0 = floorf((occ.min[2] - world_min_z) / GI_CELL).max(0.0) as u32;
        let z1 = (floorf((occ.max[2] - world_min_z) / GI_CELL) as i32 + 1)
            .clamp(0, GI_BRICK_SIZE as i32) as u32;
        let y0 = floorf((occ.min[1] - GI_ORIGIN_Y) / GI_CELL).max(0.0) as u32;
        let y1 = (floorf((occ.max[1] - GI_ORIGIN_Y) / GI_CELL) as i32 + 1).clamp(0, GI_SIZE as i32)
            as u32;
        for z in z0..z1 {
            for y in y0..y1 {
                for x in x0..x1 {
                    let idx = brick_index(x, y, z);
                    if out[idx * 4 + 3] != 0 {
                        continue;
                    }
                    let p = [
                        world_min_x + (x as f32 + 0.5) * GI_CELL,
                        GI_ORIGIN_Y + (y as f32 + 0.5) * GI_CELL,
                        world_min_z + (z as f32 + 0.5) * GI_CELL,
                    ];
                    if occ.contains(p) {
                        write_voxel(out, idx, occ.source.albedo);
                        owners[idx] = owner as u32;
                    }
                }
            }
        }
    }
}

fn fill_radiance_brick(
    out: &mut [u8],
    albedo: &[u8],
    owners: &[u32],
    world_brick: [i32; 2],
    sun_dir: [f32; 3],
    sun_color: [f32; 3],
    occluders: &[PreparedGiOccluder],
) {
    out.fill(0);
    let length = sqrtf(sun_dir[0] * sun_dir[0] + sun_dir[1] * sun_dir[1] + sun_dir[2] * sun_dir[2])
        .max(1.0e-6);
    let ray = [
        -sun_dir[0] / length,
        -sun_dir[1] / length,
        -sun_dir[2] / length,
    ];
    let min_x = world_brick[0] as f32 * GI_BRICK_SIZE as f32 * GI_CELL;
    let min_z = world_brick[1] as f32 * GI_BRICK_SIZE as f32 * GI_CELL;
    for z in 0..GI_BRICK_SIZE {
        for y in 0..GI_SIZE {
            for x in 0..GI_BRICK_SIZE {
                let idx = brick_index(x, y, z);
                if albedo[idx * 4 + 3] == 0 {
                    continue;
                }
                let p = [
                    min_x + (x as f32 + 0.5) * GI_CELL,
                    GI_ORIGIN_Y + (y as f32 + 0.5) * GI_CELL,
                    min_z + (z as f32 + 0.5) * GI_CELL,
                ];
                let source = owners[idx];
                let shadowed = occluders
                    .iter()
                    .enumerate()
                    .any(|(i, occ)| i as u32 != source && occ.ray_hit(p, ray));
                let visibility = if shadowed { 0.0 } else { 0.75 };
                out[idx * 4] =
                    (albedo[idx * 4] as f32 * sun_color[0].max(0.0) * visibility).min(255.0) as u8;
                out[idx * 4 + 1] = (albedo[idx * 4 + 1] as f32 * sun_color[1].max(0.0) * visibility)
                    .min(255.0) as u8;
                out[idx * 4 + 2] = (albedo[idx * 4 + 2] as f32 * sun_color[2].max(0.0) * visibility)
                    .min(255.0) as u8;
                out[idx * 4 + 3] = 255;
            }
        }
    }
}

fn write_voxel(out: &mut [u8], idx: usize, rgb: [f32; 3]) {
    out[idx * 4] = (rgb[0].clamp(0.0, 1.0) * 255.0) as u8;
    out[idx * 4 + 1] = (rgb[1].clamp(0.0, 1.0) * 255.0) as u8;
    out[idx * 4 + 2] = (rgb[2].clamp(0.0, 1.0) * 255.0) as u8;
    out[idx * 4 + 3] = 255;
}

fn brick_index(x: u32, y: u32, z: u32) -> usize {
    ((z * GI_SIZE + y) * GI_BRICK_SIZE + x) as usize
}

fn brick_offset(world_brick: [i32; 2]) -> [u32; 3] {
    [
        (world_brick[0].rem_euclid(GI_BRICKS) as u32) * GI_BRICK_SIZE,
        0,
        (world_brick[1].rem_euclid(GI_BRICKS) as u32) * GI_BRICK_SIZE,
    ]
}

fn sun_key(dir: [f32; 3], color: [f32; 3]) -> i32 {
    let q = |v: f32| (v * 32.0) as i32;
    q(dir[0]).wrapping_mul(73_856_093)
        ^ q(dir[1]).wrapping_mul(19_349_663)
        ^ q(dir[2]).wrapping_mul(83_492_791)
        ^ q(color[0]).wrapping_mul(2_654_435_761u32 as i32)
        ^ q(color[1]).wrapping_mul(40_503)
        ^ q(color[2]).wrapping_mul(51_787)
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;
    use crate::gpu::{MockCall, MockGpu};

    fn settle(vol: &mut GiVolume, gpu: &mut MockGpu) {
        for _ in 0..256 {
            vol.step(gpu, [0.2, -1.0, 0.1], [1.0, 0.9, 0.8]);
            if vol.is_idle() {
                return;
            }
        }
        panic!("GI did not settle");
    }

    #[test]
    fn focus_scroll_updates_entering_bricks_only() {
        let mut gpu = MockGpu::default();
        let mut vol = GiVolume::new(&mut gpu);
        settle(&mut vol, &mut gpu);
        let before = vol.counters();
        vol.set_focus([GI_BRICK_SIZE as f32 * GI_CELL, 0.0, 0.0]);
        settle(&mut vol, &mut gpu);
        let after = vol.counters();
        assert_eq!(after.albedo_builds - before.albedo_builds, 8);
        assert_eq!(after.radiance_builds - before.radiance_builds, 8);
        assert_eq!(after.resident_uploads - before.resident_uploads, 8);
        assert_eq!(after.mipmap_rebuilds - before.mipmap_rebuilds, 1);
        assert_eq!(after.full_rebuilds - before.full_rebuilds, 0);
    }

    #[test]
    fn identical_inputs_are_noops() {
        let mut gpu = MockGpu::default();
        let mut vol = GiVolume::new(&mut gpu);
        settle(&mut vol, &mut gpu);
        let before = vol.counters();
        vol.set_focus([0.0, 0.0, 0.0]);
        vol.set_ground_albedo([0.5, 0.5, 0.5]);
        vol.set_occluders(&[]);
        settle(&mut vol, &mut gpu);
        assert_eq!(vol.counters(), before);
    }

    #[test]
    fn geometry_and_light_invalidation_are_separate() {
        let mut gpu = MockGpu::default();
        let mut vol = GiVolume::new(&mut gpu);
        settle(&mut vol, &mut gpu);
        let before = vol.counters();
        vol.set_ground_albedo([0.4, 0.3, 0.2]);
        settle(&mut vol, &mut gpu);
        let geometry = vol.counters();
        assert_eq!(geometry.albedo_builds - before.albedo_builds, 64);
        assert_eq!(geometry.radiance_builds - before.radiance_builds, 64);
        vol.step(&mut gpu, [0.4, -1.0, 0.1], [1.0, 0.9, 0.8]);
        settle(&mut vol, &mut gpu);
        let light = vol.counters();
        assert_eq!(light.albedo_builds - geometry.albedo_builds, 0);
        assert_eq!(light.radiance_builds - geometry.radiance_builds, 64);
    }

    #[test]
    fn static_proxy_radiance_shadows_ground() {
        let occ = PreparedGiOccluder::new(GiOccluder {
            center: [2.5, 1.0, 2.5],
            half_extents: [0.75, 1.0, 0.75],
            yaw: 0.0,
            albedo: [1.0, 0.1, 0.1],
        });
        let mut albedo = vec![0; BRICK_VOXELS * 4];
        let mut owners = vec![0; BRICK_VOXELS];
        fill_albedo_brick(&mut albedo, &mut owners, [0, 0], [0.5; 3], &[occ]);
        let mut radiance = vec![0; BRICK_VOXELS * 4];
        fill_radiance_brick(
            &mut radiance,
            &albedo,
            &owners,
            [0, 0],
            [-1.0, -1.0, 0.0],
            [1.0; 3],
            &[occ],
        );
        let open = brick_index(7, 1, 0) * 4;
        let behind = brick_index(1, 1, 3) * 4;
        assert!(radiance[open] > radiance[behind]);
    }

    #[test]
    fn regional_uploads_are_bounded() {
        let mut gpu = MockGpu::default();
        let mut vol = GiVolume::new(&mut gpu);
        settle(&mut vol, &mut gpu);
        assert!(gpu.log.iter().any(|call| matches!(
            call,
            MockCall::UpdateTexture3dRegion {
                extent: [8, 64, 8],
                ..
            }
        )));
    }
}
