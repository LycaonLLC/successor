//! The frame renderer: shadow pass -> ordered camera passes (screen or RTT,
//! culled by viewport mask) -> composite RTT quads -> text overlays.
//!
//! All per-frame collections are reused scratch fields (`cameras`, `quad`,
//! `uniforms`), so after warmup the render path performs no heap allocation —
//! the property the `alloc-count` gate enforces.

use alloc::vec::Vec;

use successor_engine_core::ecs::{HasStorage, WorldOps};
use successor_engine_core::math::{Mat4, Vec3};

use crate::components::{
    CamTarget, Camera, CompositeQuad, DirectionalLight, MeshRenderer, PointLight, Projection,
    RectNorm, TextOverlay, Transform,
};
use crate::gi::{GiOccluder, GiVolume, GiWorkCounters};
use crate::gpu::{
    BufferId, BufferUsage, ClearSpec, Cull, Filter, ForwardLight, Gpu, GpuCaps, GpuError, MrtDesc,
    PassTarget, PipelineState, ProgramId, RectPx, RenderTargetDesc, RenderTargetId, TextureDesc,
    TextureFormat, Uniform, UniformValue, VertexLayout, GLTF_MESH_LAYOUT, GLTF_SKINNED_MESH_LAYOUT,
    INSTANCE_MAT4_LAYOUT, MESH_LAYOUT, PARTICLE_LAYOUT, POINT_LIGHT_INSTANCE_LAYOUT, QUAD_LAYOUT,
    SKINNED_MESH_LAYOUT, UI_LAYOUT,
};
use crate::text;

/// Render quality tier. Presets over ONE deferred code path (shadow filtering,
/// GI cone count, shadow map size, HDR target); selected at load.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RenderQuality {
    Low,
    Medium,
    High,
}

impl RenderQuality {
    fn shadow_size(self) -> u32 {
        match self {
            RenderQuality::Low => 1024,
            _ => 2048,
        }
    }
    /// Diffuse GI cone count (0 disables VXGI → hemisphere ambient).
    fn gi_cones(self) -> u32 {
        match self {
            RenderQuality::Low => 0,
            RenderQuality::Medium => 4,
            RenderQuality::High => 6,
        }
    }
}

/// Bounds every renderable world must satisfy. A world built with the `world!`
/// macro listing the render components implements this automatically.
pub trait RenderWorld:
    WorldOps
    + HasStorage<Transform>
    + HasStorage<MeshRenderer>
    + HasStorage<Camera>
    + HasStorage<DirectionalLight>
    + HasStorage<PointLight>
    + HasStorage<CompositeQuad>
    + HasStorage<TextOverlay>
{
}

impl<W> RenderWorld for W where
    W: WorldOps
        + HasStorage<Transform>
        + HasStorage<MeshRenderer>
        + HasStorage<Camera>
        + HasStorage<DirectionalLight>
        + HasStorage<PointLight>
        + HasStorage<CompositeQuad>
        + HasStorage<TextOverlay>
{
}

#[derive(Clone, Copy)]
struct MeshGpu {
    vbo: BufferId,
    ebo: BufferId,
    index_count: u32,
    skinned: bool,
    layout: VertexLayout,
    has_vertex_color: bool,
    has_tangent: bool,
}

#[derive(Clone, Copy)]
struct Material {
    desc: MaterialDesc,
}

#[derive(Clone, Copy)]
struct DrawRecord {
    entity_index: u64,
    entity_generation: u64,
    mesh: MeshRenderer,
    transform: Transform,
}

#[derive(Clone, Copy)]
struct SceneLight {
    entity_index: u64,
    entity_generation: u64,
    light: ForwardLight,
    distance2: f32,
}
#[derive(Clone, Copy, Debug)]
pub struct TerrainMaterialDesc {
    pub control_texture: crate::gpu::TextureId,
    pub albedo_tiles: crate::gpu::TextureId,
    pub nrma_tiles: crate::gpu::TextureId,
    pub world_origin: [f32; 2],
    pub world_size: f32,
    pub tile_scale: f32,
    pub normal_strength: f32,
    /// `0` desert, `1` forest. Kept explicit so both vertex displacement and
    /// fragment material state use the same biome profile.
    pub biome: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InstanceBatchId(pub u32);

#[derive(Clone, Copy)]
struct InstanceBatch {
    mesh: crate::components::MeshId,
    material: crate::components::MaterialId,
    buffer: BufferId,
    count: u32,
    capacity: u32,
    viewport_mask: u32,
    center: Vec3,
    max_distance: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct MaterialDesc {
    pub base_color: [f32; 4],
    pub base_color_texture: Option<crate::gpu::TextureId>,
    pub metallic_roughness_texture: Option<crate::gpu::TextureId>,
    pub normal_texture: Option<crate::gpu::TextureId>,
    pub occlusion_texture: Option<crate::gpu::TextureId>,
    pub emissive_texture: Option<crate::gpu::TextureId>,
    pub metallic: f32,
    pub roughness: f32,
    pub normal_scale: f32,
    pub occlusion_strength: f32,
    pub emissive_factor: [f32; 3],
    pub emissive_strength: f32,
    pub clearcoat: f32,
    pub clearcoat_roughness: f32,
    pub specular: f32,
    pub ior: f32,
    pub transmission: f32,
    pub alpha_cutoff: f32,
    pub double_sided: bool,
    pub blend: bool,
    pub terrain: Option<TerrainMaterialDesc>,
}

impl Default for MaterialDesc {
    fn default() -> Self {
        Self {
            base_color: [1.0; 4],
            base_color_texture: None,
            metallic_roughness_texture: None,
            normal_texture: None,
            occlusion_texture: None,
            emissive_texture: None,
            metallic: 1.0,
            roughness: 1.0,
            normal_scale: 1.0,
            occlusion_strength: 1.0,
            emissive_factor: [0.0; 3],
            emissive_strength: 1.0,
            clearcoat: 0.0,
            clearcoat_roughness: 0.0,
            specular: 1.0,
            ior: 1.5,
            transmission: 0.0,
            alpha_cutoff: 0.5,
            double_sided: false,
            blend: false,
            terrain: None,
        }
    }
}

#[derive(Clone, Copy)]
pub struct RendererLimits {
    pub max_cameras: usize,
    pub max_draws: usize,
    /// Max floats in the dynamic quad scratch (composite + text per frame).
    pub max_quad_floats: usize,
    /// Max floats in the immediate-mode UI vertex buffer (UI_LAYOUT).
    pub max_ui_floats: usize,
    pub shadow_size: u32,
    pub shadow_world_radius: f32,
    /// Quality tier (shadow filtering, GI cones, HDR target).
    pub quality: RenderQuality,
    /// Maximum nearest point lights supplied to one transparent draw.
    pub max_forward_lights: usize,
}

impl Default for RendererLimits {
    fn default() -> Self {
        Self {
            max_cameras: 16,
            max_draws: 8192,
            max_quad_floats: 64 * 1024,
            max_ui_floats: 256 * 1024,
            shadow_size: RenderQuality::Medium.shadow_size(),
            shadow_world_radius: 48.0,
            quality: RenderQuality::Medium,
            max_forward_lights: 32,
        }
    }
}

/// Grade parameters applied by the tonemap pass (defaults = neutral).
#[derive(Clone, Copy)]
struct Grade {
    bone_tint: [f32; 3],
    desaturate: f32,
    scene_darken: f32,
    black_lift: f32,
}

impl Default for Grade {
    fn default() -> Self {
        Self {
            bone_tint: [1.0, 1.0, 1.0],
            desaturate: 0.0,
            scene_darken: 1.0,
            black_lift: 0.0,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct BloomSettings {
    pub threshold: f32,
    pub intensity: f32,
}

/// Presentation gain applied after bloom extraction and blur.
const BLOOM_INTENSITY_GAIN: f32 = 2.0;

impl Default for BloomSettings {
    fn default() -> Self {
        Self {
            threshold: 1.0,
            intensity: 0.0,
        }
    }
}

/// User-mastered directional sun controls. Azimuth rotates around world Y;
/// elevation is the angle above the horizon.
#[derive(Clone, Copy, Debug)]
pub struct SunSettings {
    pub azimuth_degrees: f32,
    pub elevation_degrees: f32,
    pub color: [f32; 3],
    pub intensity: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct AaSettings {
    pub enabled: bool,
    pub edge_threshold_min: f32,
    pub edge_threshold: f32,
    pub subpixel_blend: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct ShadowSettings {
    pub map_size: u32,
    pub world_radius: f32,
    pub depth_bias: f32,
    pub normal_bias: f32,
    pub penumbra: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct ColorGradeSettings {
    pub saturation: f32,
    pub contrast: f32,
    pub gamma: f32,
    pub temperature: f32,
    pub tint: f32,
    pub lift: [f32; 3],
    pub color_gamma: [f32; 3],
    pub gain: [f32; 3],
}

#[derive(Clone, Copy, Debug)]
pub struct PaletteSettings {
    pub enabled: bool,
    pub levels: u32,
    pub strength: f32,
    pub dither: f32,
}

/// Validated runtime controls. JSON ownership remains in the app shell so the
/// no_std renderer stays independent of serialization and filesystem policy.
#[derive(Clone, Copy, Debug)]
pub struct RendererSettings {
    pub ambient_intensity: f32,
    pub emissive_scalar: f32,
    pub exposure: f32,
    pub ao_intensity: f32,
    pub bloom_threshold: f32,
    pub bloom_intensity: f32,
    pub bloom_radius: f32,
    pub sun: SunSettings,
    pub aa: AaSettings,
    pub shadows: ShadowSettings,
    pub color_grade: ColorGradeSettings,
    pub palette: PaletteSettings,
}

impl Default for RendererSettings {
    fn default() -> Self {
        Self {
            ambient_intensity: 0.28,
            emissive_scalar: 1.0,
            exposure: 1.0,
            ao_intensity: 1.0,
            bloom_threshold: 1.0,
            bloom_intensity: 0.0,
            bloom_radius: 1.0,
            sun: SunSettings {
                azimuth_degrees: -45.0,
                elevation_degrees: 55.0,
                color: [1.0, 0.97, 0.9],
                intensity: 1.0,
            },
            aa: AaSettings {
                enabled: true,
                edge_threshold_min: 0.0312,
                edge_threshold: 0.125,
                subpixel_blend: 0.75,
            },
            shadows: ShadowSettings {
                map_size: 2048,
                world_radius: 48.0,
                depth_bias: 0.0015,
                normal_bias: 1.5,
                penumbra: 40.0,
            },
            color_grade: ColorGradeSettings {
                saturation: 1.0,
                contrast: 1.0,
                gamma: 1.0,
                temperature: 0.0,
                tint: 0.0,
                lift: [0.0; 3],
                color_gamma: [1.0; 3],
                gain: [1.0; 3],
            },
            palette: PaletteSettings {
                enabled: false,
                levels: 16,
                strength: 0.0,
                dither: 0.0,
            },
        }
    }
}

impl RendererSettings {
    fn valid(self) -> bool {
        let finite3 = |v: [f32; 3]| v.into_iter().all(f32::is_finite);
        matches!(self.shadows.map_size, 512 | 1024 | 2048 | 4096)
            && self.ambient_intensity.is_finite()
            && self.emissive_scalar.is_finite()
            && self.exposure.is_finite()
            && self.ao_intensity.is_finite()
            && self.bloom_threshold.is_finite()
            && self.bloom_intensity.is_finite()
            && self.bloom_radius.is_finite()
            && self.sun.azimuth_degrees.is_finite()
            && self.sun.elevation_degrees.is_finite()
            && finite3(self.sun.color)
            && self.sun.intensity.is_finite()
            && self.aa.edge_threshold_min.is_finite()
            && self.aa.edge_threshold.is_finite()
            && self.aa.subpixel_blend.is_finite()
            && self.shadows.world_radius.is_finite()
            && self.shadows.depth_bias.is_finite()
            && self.shadows.normal_bias.is_finite()
            && self.shadows.penumbra.is_finite()
            && self.color_grade.saturation.is_finite()
            && self.color_grade.contrast.is_finite()
            && self.color_grade.gamma.is_finite()
            && self.color_grade.temperature.is_finite()
            && self.color_grade.tint.is_finite()
            && finite3(self.color_grade.lift)
            && finite3(self.color_grade.color_gamma)
            && finite3(self.color_grade.gain)
            && (2..=64).contains(&self.palette.levels)
            && self.palette.strength.is_finite()
            && self.palette.dither.is_finite()
    }

    fn sun_light(self) -> DirectionalLight {
        let azimuth = self.sun.azimuth_degrees * core::f32::consts::PI / 180.0;
        let elevation = self.sun.elevation_degrees * core::f32::consts::PI / 180.0;
        let horizontal = libm::cosf(elevation);
        DirectionalLight {
            dir: Vec3 {
                x: horizontal * libm::sinf(azimuth),
                y: -libm::sinf(elevation),
                z: horizontal * libm::cosf(azimuth),
            },
            color: [
                self.sun.color[0] * self.sun.intensity,
                self.sun.color[1] * self.sun.intensity,
                self.sun.color[2] * self.sun.intensity,
            ],
            cast_shadows: true,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RenderConfigError {
    InvalidBloom,
    InvalidSettings,
    Gpu(GpuError),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RendererInitError {
    InsufficientMrt,
    Gpu(GpuError),
}

/// A screen-sized deferred render target plus the dimensions it was built for.
struct SizedRt {
    rt: RenderTargetId,
    w: u32,
    h: u32,
}

pub struct Renderer {
    // Forward programs (RTT cameras: minimap/portraits) — unchanged.
    mesh_prog: ProgramId,
    mesh_skinned_prog: ProgramId,
    depth_prog: ProgramId,
    depth_skinned_prog: ProgramId,
    terrain_depth_prog: ProgramId,
    instance_depth_prog: ProgramId,
    composite_prog: ProgramId,
    text_prog: ProgramId,
    // Deferred programs.
    gbuffer_prog: ProgramId,
    gbuffer_skinned_prog: ProgramId,
    terrain_gbuffer_prog: ProgramId,
    instance_gbuffer_prog: ProgramId,
    light_prog: ProgramId,
    tonemap_prog: ProgramId,
    bloom_extract_prog: ProgramId,
    bloom_blur_prog: ProgramId,
    fxaa_prog: ProgramId,
    copy_prog: ProgramId,
    point_light_prog: ProgramId,
    shadow_rt: RenderTargetId,
    ui_prog: ProgramId,
    ui_buf: BufferId,
    ui_atlas: Option<crate::gpu::TextureId>,
    particle_prog: ProgramId,
    particle_buf: BufferId,
    particle_tex: Option<crate::gpu::TextureId>,
    white_tex: crate::gpu::TextureId,
    normal_tex: crate::gpu::TextureId,
    black_tex: crate::gpu::TextureId,
    shadow_size: u32,
    shadow_world_radius: f32,
    quality: RenderQuality,
    caps: GpuCaps,
    dyn_buf: BufferId,
    // Deferred screen targets (recreated on resize).
    gbuffer_rt: Option<SizedRt>,
    scene_rt: Option<SizedRt>,
    bloom_extract_rt: Option<SizedRt>,
    scene_copy_rt: Option<SizedRt>,
    bloom_blur_rt: Option<SizedRt>,
    ldr_rt: Option<SizedRt>,
    exposure: f32,
    // Point-light volume resources.
    pl_vbo: BufferId,
    pl_ebo: BufferId,
    pl_index_count: u32,
    pl_inst_buf: BufferId,
    pl_scratch: Vec<f32>,
    // Voxel GI (None below Medium tier).
    gi: Option<GiVolume>,
    meshes: Vec<MeshGpu>,
    materials: Vec<Material>,
    instance_batches: Vec<InstanceBatch>,
    ambient: f32,
    grade: Grade,
    bloom: BloomSettings,
    settings: RendererSettings,
    // reused scratch
    cameras: Vec<Camera>,
    comp_quads: Vec<CompositeQuad>,
    overlays: Vec<TextOverlay>,
    quad: Vec<f32>,
    uniforms: Vec<Uniform>,
    draw_scratch: Vec<usize>,
    scene_draws: Vec<DrawRecord>,
    scene_lights: Vec<SceneLight>,
    forward_lights: Vec<ForwardLight>,
    max_forward_lights: usize,
    shadow_view_proj: [f32; 16],
    skin_arena: Vec<[f32; 16]>,
    fog_color: [f32; 3],
    fog_near: f32,
    fog_far: f32,
}

impl Renderer {
    pub fn new<G: Gpu>(gpu: &mut G, limits: RendererLimits) -> Result<Self, RendererInitError> {
        let caps = gpu.caps();
        if caps.max_color_attachments < 4 || caps.max_draw_buffers < 4 {
            return Err(RendererInitError::InsufficientMrt);
        }
        let q = limits.quality;
        let pbr_common = include_str!("../../../assets/shaders/pbr_common.glsl");
        let mesh_fragment = alloc::format!(
            "{}\n{}",
            pbr_common,
            include_str!("../../../assets/shaders/mesh.frag")
        );
        let mesh_prog = gpu.create_program(
            include_str!("../../../assets/shaders/mesh.vert"),
            &mesh_fragment,
        );
        let mesh_skinned_prog = gpu.create_program(
            include_str!("../../../assets/shaders/mesh_skinned.vert"),
            &mesh_fragment,
        );
        let depth_prog = gpu.create_program(
            include_str!("../../../assets/shaders/depth.vert"),
            include_str!("../../../assets/shaders/depth.frag"),
        );
        let depth_skin_src = alloc::format!(
            "#define SKINNED 1\n{}",
            include_str!("../../../assets/shaders/depth.vert")
        );
        let depth_skinned_prog = gpu.create_program(
            &depth_skin_src,
            include_str!("../../../assets/shaders/depth.frag"),
        );
        let depth_instance_src = alloc::format!(
            "#define INSTANCED 1\n{}",
            include_str!("../../../assets/shaders/depth.vert")
        );
        let instance_depth_prog = gpu.create_program(
            &depth_instance_src,
            include_str!("../../../assets/shaders/depth.frag"),
        );
        let composite_prog = gpu.create_program(
            include_str!("../../../assets/shaders/composite.vert"),
            include_str!("../../../assets/shaders/composite.frag"),
        );
        let text_prog = gpu.create_program(
            include_str!("../../../assets/shaders/text.vert"),
            include_str!("../../../assets/shaders/text.frag"),
        );
        let ui_prog = gpu.create_program(
            include_str!("../../../assets/shaders/ui.vert"),
            include_str!("../../../assets/shaders/ui.frag"),
        );
        let particle_prog = gpu.create_program(
            include_str!("../../../assets/shaders/particles.vert"),
            include_str!("../../../assets/shaders/particles.frag"),
        );
        // Deferred programs. Tier `#define`s are prepended after the version
        // header (create_program prepends `#version`), so they precede the body.
        let gbuffer_prog = gpu.create_program(
            include_str!("../../../assets/shaders/gbuffer.vert"),
            include_str!("../../../assets/shaders/gbuffer.frag"),
        );
        let gb_skin_src = alloc::format!(
            "#define SKINNED 1\n{}",
            include_str!("../../../assets/shaders/gbuffer.vert")
        );
        let gbuffer_skinned_prog = gpu.create_program(
            &gb_skin_src,
            include_str!("../../../assets/shaders/gbuffer.frag"),
        );
        let gb_instance_src = alloc::format!(
            "#define INSTANCED 1\n{}",
            include_str!("../../../assets/shaders/gbuffer.vert")
        );
        let instance_gbuffer_prog = gpu.create_program(
            &gb_instance_src,
            include_str!("../../../assets/shaders/gbuffer.frag"),
        );
        let terrain_depth_prog = gpu.create_program(
            include_str!("../../../assets/shaders/terrain_depth.vert"),
            include_str!("../../../assets/shaders/depth.frag"),
        );
        let terrain_gbuffer_prog = gpu.create_program(
            include_str!("../../../assets/shaders/terrain_gbuffer.vert"),
            include_str!("../../../assets/shaders/terrain_gbuffer.frag"),
        );
        let (taps, pcss, cones, spec) = match q {
            RenderQuality::Low => (4, 0, 0, 0),
            RenderQuality::Medium => (12, 0, 4, 0),
            RenderQuality::High => (16, 1, 6, 1),
        };
        let light_src = alloc::format!(
            "#define SHADOW_TAPS {}\n#define PCSS {}\n#define GI_CONES {}\n#define GI_SPECULAR {}\n{}\n{}",
            taps,
            pcss,
            cones,
            spec,
            pbr_common,
            include_str!("../../../assets/shaders/deferred_light.frag")
        );
        let light_prog = gpu.create_program(
            include_str!("../../../assets/shaders/post.vert"),
            &light_src,
        );
        let tonemap_prog = gpu.create_program(
            include_str!("../../../assets/shaders/post.vert"),
            include_str!("../../../assets/shaders/tonemap.frag"),
        );
        let bloom_extract_prog = gpu.create_program(
            include_str!("../../../assets/shaders/post.vert"),
            include_str!("../../../assets/shaders/bloom_extract.frag"),
        );
        let bloom_blur_prog = gpu.create_program(
            include_str!("../../../assets/shaders/post.vert"),
            include_str!("../../../assets/shaders/bloom_blur.frag"),
        );
        let fxaa_prog = gpu.create_program(
            include_str!("../../../assets/shaders/post.vert"),
            include_str!("../../../assets/shaders/fxaa.frag"),
        );
        let copy_prog = gpu.create_program(
            include_str!("../../../assets/shaders/post.vert"),
            include_str!("../../../assets/shaders/copy.frag"),
        );
        let point_fragment = alloc::format!(
            "{}\n{}",
            pbr_common,
            include_str!("../../../assets/shaders/point_light.frag")
        );
        let point_light_prog = gpu.create_program(
            include_str!("../../../assets/shaders/point_light.vert"),
            &point_fragment,
        );
        let shadow_size = if matches!(limits.shadow_size, 512 | 1024 | 2048 | 4096) {
            limits.shadow_size
        } else {
            q.shadow_size()
        };
        let shadow_rt = gpu.create_render_target(&RenderTargetDesc {
            width: shadow_size,
            height: shadow_size,
            color: false,
            depth: true,
            filter: Filter::Nearest,
        });
        // Seed the dynamic buffer with its max capacity so per-frame updates
        // never grow it (allocation stability).
        let seed = alloc::vec![0u8; limits.max_quad_floats * 4];
        let dyn_buf = gpu.create_buffer(&seed, BufferUsage::Dynamic);
        let ui_seed = alloc::vec![0u8; limits.max_ui_floats * 4];
        let ui_buf = gpu.create_buffer(&ui_seed, BufferUsage::Dynamic);
        let particle_buf = gpu.create_buffer(&ui_seed, BufferUsage::Dynamic);
        // Unit sphere for point-light bounding volumes.
        let (pl_verts, pl_indices) = crate::primitives::capsule(1.0, 2.0, 8, 4);
        let pl_vbo = gpu.create_buffer(f32_bytes(&pl_verts), BufferUsage::Static);
        let pl_ebo = gpu.create_index_buffer(u32_bytes(&pl_indices), BufferUsage::Static);
        let pl_inst_seed = alloc::vec![0u8; 256 * 8 * 4];
        let pl_inst_buf = gpu.create_buffer(&pl_inst_seed, BufferUsage::Dynamic);
        let gi = if q.gi_cones() > 0 {
            Some(GiVolume::new(gpu))
        } else {
            None
        };
        let default_texture = |gpu: &mut G, rgba: [u8; 4]| {
            gpu.create_texture(
                &TextureDesc {
                    width: 1,
                    height: 1,
                    format: TextureFormat::Rgba8,
                    mag_filter: Filter::Nearest,
                    min_filter: crate::gpu::MinFilter::Nearest,
                    wrap_s: crate::gpu::Wrap::ClampToEdge,
                    wrap_t: crate::gpu::Wrap::ClampToEdge,
                    mipmaps: false,
                },
                Some(&rgba),
            )
        };
        let white_tex = default_texture(gpu, [255, 255, 255, 255]);
        let normal_tex = default_texture(gpu, [128, 128, 255, 255]);
        let black_tex = default_texture(gpu, [0, 0, 0, 255]);
        let mut settings = RendererSettings::default();
        settings.shadows.map_size = shadow_size;
        settings.shadows.world_radius = limits.shadow_world_radius;
        let renderer = Self {
            mesh_prog,
            mesh_skinned_prog,
            depth_prog,
            depth_skinned_prog,
            terrain_depth_prog,
            instance_depth_prog,
            composite_prog,
            text_prog,
            gbuffer_prog,
            gbuffer_skinned_prog,
            terrain_gbuffer_prog,
            instance_gbuffer_prog,
            light_prog,
            tonemap_prog,
            point_light_prog,
            bloom_extract_prog,
            bloom_blur_prog,
            fxaa_prog,
            shadow_rt,
            copy_prog,
            ui_prog,
            ui_buf,
            ui_atlas: None,
            particle_prog,
            particle_buf,
            particle_tex: None,
            shadow_size,
            shadow_world_radius: limits.shadow_world_radius,
            quality: q,
            caps,
            dyn_buf,
            gbuffer_rt: None,
            white_tex,
            normal_tex,
            black_tex,
            scene_rt: None,
            exposure: 1.0,
            pl_vbo,
            scene_copy_rt: None,
            bloom_extract_rt: None,
            bloom_blur_rt: None,
            ldr_rt: None,
            pl_ebo,
            pl_index_count: pl_indices.len() as u32,
            pl_inst_buf,
            pl_scratch: Vec::with_capacity(256 * 8),
            gi,
            meshes: Vec::new(),
            materials: Vec::new(),
            instance_batches: Vec::new(),
            ambient: settings.ambient_intensity,
            grade: Grade::default(),
            cameras: Vec::with_capacity(limits.max_cameras),
            comp_quads: Vec::with_capacity(limits.max_cameras),
            overlays: Vec::with_capacity(16),
            scene_lights: Vec::with_capacity(limits.max_draws),
            forward_lights: Vec::with_capacity(limits.max_forward_lights),
            max_forward_lights: limits.max_forward_lights.min(32),
            quad: Vec::with_capacity(limits.max_quad_floats),
            uniforms: Vec::with_capacity(48),
            draw_scratch: Vec::with_capacity(limits.max_draws),
            scene_draws: Vec::with_capacity(limits.max_draws),
            shadow_view_proj: Mat4::IDENTITY.to_cols_array(),
            skin_arena: Vec::with_capacity(64 * 16),
            fog_color: [0.788, 0.678, 0.510],
            fog_near: 180.0,
            fog_far: 320.0,
            bloom: BloomSettings::default(),
            settings,
        };
        if let Some(error) = gpu.take_error() {
            return Err(RendererInitError::Gpu(error));
        }
        Ok(renderer)
    }

    /// Upload the baked icon atlas (RGBA8; coverage in the alpha channel) that
    /// the UI pass samples. Call once at load.
    pub fn set_ui_atlas<G: Gpu>(&mut self, gpu: &mut G, width: u32, height: u32, rgba: &[u8]) {
        let tex = gpu.create_texture(
            &TextureDesc {
                width,
                height,
                format: TextureFormat::Rgba8,
                mag_filter: Filter::Linear,
                min_filter: crate::gpu::MinFilter::Linear,
                wrap_s: crate::gpu::Wrap::ClampToEdge,
                wrap_t: crate::gpu::Wrap::ClampToEdge,
                mipmaps: false,
            },
            Some(rgba),
        );
        self.ui_atlas = Some(tex);
    }

    /// Draw an immediate-mode UI vertex buffer (`UI_LAYOUT`, NDC) over the
    /// current framebuffer with alpha blending. `quads` is the quad count
    /// (`buf` holds `quads * 6 * 8` floats). No-op until an atlas is uploaded.
    pub fn render_ui<G: Gpu>(
        &mut self,
        gpu: &mut G,
        buf: &[f32],
        quads: u32,
        screen_w: u32,
        screen_h: u32,
    ) {
        if quads == 0 {
            return;
        }
        let atlas = match self.ui_atlas {
            Some(a) => a,
            None => return,
        };
        gpu.begin_pass(
            PassTarget::Screen,
            RectPx {
                x: 0,
                y: 0,
                w: screen_w as i32,
                h: screen_h as i32,
            },
            ClearSpec::default(),
        );
        gpu.set_pipeline(
            self.ui_prog,
            &PipelineState {
                depth_test: false,
                depth_write: false,
                cull: Cull::None,
                color_write: true,
                blend: true,
                additive: false,
            },
        );
        gpu.bind_texture(0, atlas);
        self.uniforms.clear();
        self.uniforms.push(Uniform {
            name: "u_atlas",
            value: UniformValue::Sampler(0),
        });
        gpu.set_uniforms(&self.uniforms);
        gpu.update_buffer(self.ui_buf, f32_bytes(buf));
        gpu.draw(self.ui_buf, None, &UI_LAYOUT, quads * 6);
        gpu.end_pass();
    }

    /// Upload the shared glow sprite (RGBA8) the particle pass samples.
    pub fn set_particle_atlas<G: Gpu>(
        &mut self,
        gpu: &mut G,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) {
        let tex = gpu.create_texture(
            &TextureDesc {
                width,
                height,
                format: TextureFormat::Rgba8,
                mag_filter: Filter::Linear,
                min_filter: crate::gpu::MinFilter::Linear,
                wrap_s: crate::gpu::Wrap::ClampToEdge,
                wrap_t: crate::gpu::Wrap::ClampToEdge,
                mipmaps: false,
            },
            Some(rgba),
        );
        self.particle_tex = Some(tex);
    }

    /// Draw a world-space particle billboard buffer (`PARTICLE_LAYOUT`) over the
    /// current screen framebuffer, depth-testing against the scene but not
    /// writing depth. `additive` selects the blend mode. No-op until a sprite is
    /// uploaded. `buf` holds `quads * 6 * 9` floats.
    #[allow(clippy::too_many_arguments)]
    pub fn render_particles<G: Gpu>(
        &mut self,
        gpu: &mut G,
        buf: &[f32],
        quads: u32,
        view_proj: &[f32; 16],
        additive: bool,
        screen_w: u32,
        screen_h: u32,
    ) {
        if quads == 0 {
            return;
        }
        let tex = match self.particle_tex {
            Some(t) => t,
            None => return,
        };
        gpu.begin_pass(
            PassTarget::Screen,
            RectPx {
                x: 0,
                y: 0,
                w: screen_w as i32,
                h: screen_h as i32,
            },
            ClearSpec::default(),
        );
        gpu.set_pipeline(
            self.particle_prog,
            &PipelineState {
                depth_test: true,
                depth_write: false,
                cull: Cull::None,
                color_write: true,
                blend: true,
                additive,
            },
        );
        gpu.bind_texture(0, tex);
        self.uniforms.clear();
        self.uniforms.push(Uniform {
            name: "u_tex",
            value: UniformValue::Sampler(0),
        });
        self.uniforms.push(Uniform {
            name: "u_viewProj",
            value: UniformValue::Mat4(*view_proj),
        });
        gpu.set_uniforms(&self.uniforms);
        gpu.update_buffer(self.particle_buf, f32_bytes(buf));
        gpu.draw(self.particle_buf, None, &PARTICLE_LAYOUT, quads * 6);
        gpu.end_pass();
    }

    /// Set the tonemap color-grade parameters (environment day-night grade),
    /// applied internally by `render`'s tonemap pass. `bone_tint` is linear rgb.
    pub fn set_grade(
        &mut self,
        bone_tint: [f32; 3],
        desaturate: f32,
        scene_darken: f32,
        black_lift: f32,
    ) {
        self.grade = Grade {
            bone_tint,
            desaturate,
            scene_darken,
            black_lift,
        };
    }

    pub fn set_bloom(&mut self, threshold: f32, intensity: f32) -> Result<(), RenderConfigError> {
        if !threshold.is_finite() || threshold < 0.0 || !intensity.is_finite() || intensity < 0.0 {
            return Err(RenderConfigError::InvalidBloom);
        }
        self.bloom = BloomSettings {
            threshold,
            intensity,
        };
        Ok(())
    }

    /// Apply a complete validated tuning snapshot. Only a shadow-map size
    /// change recreates GPU resources; all other controls become uniforms on
    /// the next frame and allocate nothing in the steady-state render loop.
    pub fn apply_settings<G: Gpu>(
        &mut self,
        gpu: &mut G,
        settings: RendererSettings,
    ) -> Result<(), RenderConfigError> {
        if !settings.valid() {
            return Err(RenderConfigError::InvalidSettings);
        }
        if settings.shadows.map_size != self.shadow_size {
            let next = gpu.create_render_target(&RenderTargetDesc {
                width: settings.shadows.map_size,
                height: settings.shadows.map_size,
                color: false,
                depth: true,
                filter: Filter::Nearest,
            });
            if let Some(error) = gpu.take_error() {
                gpu.delete_render_target(next);
                return Err(RenderConfigError::Gpu(error));
            }
            let previous = core::mem::replace(&mut self.shadow_rt, next);
            gpu.delete_render_target(previous);
            self.shadow_size = settings.shadows.map_size;
        }
        self.shadow_world_radius = settings.shadows.world_radius;
        self.ambient = settings.ambient_intensity;
        self.bloom = BloomSettings {
            threshold: settings.bloom_threshold,
            intensity: settings.bloom_intensity,
        };
        self.settings = settings;
        Ok(())
    }

    pub fn settings(&self) -> RendererSettings {
        self.settings
    }

    /// Set the flat per-biome ground albedo the GI volume voxelizes (no-op below
    /// Medium tier, where VXGI is disabled).
    pub fn gi_set_ground_albedo(&mut self, rgb: [f32; 3]) {
        if let Some(gi) = self.gi.as_mut() {
            gi.set_ground_albedo(rgb);
        }
    }

    /// Replace the GI static occluder proxy set (no-op below Medium tier).
    pub fn gi_set_occluders(&mut self, occ: &[GiOccluder]) {
        if let Some(gi) = self.gi.as_mut() {
            gi.set_occluders(occ);
        }
    }

    /// Set world-space GI coverage focus. Render cameras never imply GI focus.
    pub fn gi_set_focus(&mut self, focus: [f32; 3]) {
        if let Some(gi) = self.gi.as_mut() {
            gi.set_focus(focus);
        }
    }

    pub fn upload_gltf_mesh<G: Gpu>(
        &mut self,
        gpu: &mut G,
        vertices: &[u8],
        indices: &[u32],
        skinned: bool,
        has_vertex_color: bool,
    ) -> crate::components::MeshId {
        let vbo = gpu.create_buffer(vertices, BufferUsage::Static);
        let ebo = gpu.create_index_buffer(u32_bytes(indices), BufferUsage::Static);
        self.meshes.push(MeshGpu {
            vbo,
            ebo,
            index_count: indices.len() as u32,
            skinned,
            layout: if skinned {
                GLTF_SKINNED_MESH_LAYOUT
            } else {
                GLTF_MESH_LAYOUT
            },
            has_vertex_color,
            has_tangent: true,
        });
        crate::components::MeshId((self.meshes.len() - 1) as u32)
    }

    pub fn gi_work_counters(&self) -> GiWorkCounters {
        self.gi
            .as_ref()
            .map_or_else(GiWorkCounters::default, GiVolume::counters)
    }

    pub fn gi_is_idle(&self) -> bool {
        self.gi.as_ref().is_none_or(GiVolume::is_idle)
    }

    /// Upload an indexed mesh (vertex format `MESH_LAYOUT`). Returns a handle
    /// to store in a `MeshRenderer`.
    pub fn upload_mesh<G: Gpu>(
        &mut self,
        gpu: &mut G,
        vertices: &[f32],
        indices: &[u32],
    ) -> crate::components::MeshId {
        let vbo = gpu.create_buffer(f32_bytes(vertices), BufferUsage::Static);
        let ebo = gpu.create_index_buffer(u32_bytes(indices), BufferUsage::Static);
        self.meshes.push(MeshGpu {
            vbo,
            ebo,
            index_count: indices.len() as u32,
            skinned: false,
            layout: MESH_LAYOUT,
            has_vertex_color: false,
            has_tangent: false,
        });
        crate::components::MeshId((self.meshes.len() - 1) as u32)
    }

    /// Upload a skinned mesh (vertex format `SKINNED_MESH_LAYOUT`: 16 f32/vert).
    pub fn upload_skinned_mesh<G: Gpu>(
        &mut self,
        gpu: &mut G,
        vertices: &[f32],
        indices: &[u32],
    ) -> crate::components::MeshId {
        let vbo = gpu.create_buffer(f32_bytes(vertices), BufferUsage::Static);
        let ebo = gpu.create_index_buffer(u32_bytes(indices), BufferUsage::Static);
        self.meshes.push(MeshGpu {
            vbo,
            ebo,
            index_count: indices.len() as u32,
            skinned: true,
            layout: SKINNED_MESH_LAYOUT,
            has_vertex_color: false,
            has_tangent: false,
        });
        crate::components::MeshId((self.meshes.len() - 1) as u32)
    }

    /// Clear the per-frame joint palette arena. Call once before pushing this
    /// frame's skinned poses.
    pub fn begin_skin_frame(&mut self) {
        self.skin_arena.clear();
    }

    /// Append a joint palette; returns the offset for a `SkinRef`.
    pub fn push_skin_palette(&mut self, mats: &[[f32; 16]]) -> u32 {
        let offset = self.skin_arena.len() as u32;
        self.skin_arena.extend_from_slice(mats);
        offset
    }

    pub fn add_material_desc(&mut self, desc: MaterialDesc) -> crate::components::MaterialId {
        self.materials.push(Material { desc });
        crate::components::MaterialId((self.materials.len() - 1) as u32)
    }

    pub fn update_material_desc(&mut self, id: crate::components::MaterialId, desc: MaterialDesc) {
        if let Some(material) = self.materials.get_mut(id.0 as usize) {
            material.desc = desc;
        }
    }

    /// Allocate a fixed-capacity instanced mesh batch. Terrain streamers create
    /// these once per pool slot and only replace matrix contents thereafter.
    pub fn add_instance_batch<G: Gpu>(
        &mut self,
        gpu: &mut G,
        mesh: crate::components::MeshId,
        material: crate::components::MaterialId,
        capacity: u32,
        viewport_mask: u32,
        max_distance: f32,
    ) -> InstanceBatchId {
        assert!(capacity > 0, "instance batch capacity must be nonzero");
        let seed = alloc::vec![0u8; capacity as usize * 64];
        let buffer = gpu.create_buffer(&seed, BufferUsage::Dynamic);
        self.instance_batches.push(InstanceBatch {
            mesh,
            material,
            buffer,
            count: 0,
            capacity,
            viewport_mask,
            center: Vec3::ZERO,
            max_distance,
        });
        InstanceBatchId((self.instance_batches.len() - 1) as u32)
    }

    /// Replace a batch without reallocating it. Returns `false` for a stale ID
    /// or an over-capacity update, preserving the previous batch contents.
    pub fn update_instance_batch<G: Gpu>(
        &mut self,
        gpu: &mut G,
        id: InstanceBatchId,
        matrices: &[[f32; 16]],
        center: [f32; 3],
    ) -> bool {
        let Some(batch) = self.instance_batches.get_mut(id.0 as usize) else {
            return false;
        };
        if matrices.len() > batch.capacity as usize {
            return false;
        }
        if !matrices.is_empty() {
            gpu.update_buffer(batch.buffer, mat4_bytes(matrices));
        }
        batch.count = matrices.len() as u32;
        batch.center = Vec3 {
            x: center[0],
            y: center[1],
            z: center[2],
        };
        true
    }

    pub fn instance_batch_count(&self) -> usize {
        self.instance_batches.len()
    }
    pub fn set_ambient(&mut self, a: f32) {
        self.ambient = a;
    }

    /// Per-biome distance fog: RGB color the far apron melts into, plus the
    /// world-distance near/far band. Chosen so the in-frame iso view stays
    /// clear and only the streamed apron dissolves (uniform-air doctrine).
    pub fn set_fog(&mut self, color: [f32; 3], near: f32, far: f32) {
        self.fog_color = color;
        self.fog_near = near;
        self.fog_far = far;
    }

    /// Render one frame of `world` into a `screen_w x screen_h` framebuffer.
    /// The first screen camera renders deferred (G-buffer → PBR sun + GI → point
    /// lights → tonemap to screen); RTT cameras stay forward. Composite + text
    /// close the frame on screen.
    pub fn render<G: Gpu, W: RenderWorld>(
        &mut self,
        gpu: &mut G,
        world: &mut W,
        screen_w: u32,
        screen_h: u32,
    ) -> Result<(), GpuError> {
        if screen_w == 0 || screen_h == 0 {
            return Ok(());
        }
        // --- gather lights ---
        let mut main_light: Option<DirectionalLight> = None;
        let mut shadow_light: Option<DirectionalLight> = None;
        {
            let mut q = world.query1::<DirectionalLight>();
            while let Some((_, l)) = q.next() {
                if main_light.is_none() {
                    main_light = Some(*l);
                }
                if l.cast_shadows && shadow_light.is_none() {
                    shadow_light = Some(*l);
                }
            }
        }
        // Authored light entities declare whether a scene has a sun and casts
        // shadows; mastered settings own its direction and radiance.
        let tuned_sun = self.settings.sun_light();
        if main_light.is_some() {
            main_light = Some(tuned_sun);
        }
        if shadow_light.is_some() {
            shadow_light = Some(tuned_sun);
        }

        // --- gather + sort cameras (copy out; keeps queries non-overlapping) ---
        self.scene_lights.clear();
        {
            let mut query = world.query2::<PointLight, Transform>();
            while let Some((entity, light, transform)) = query.next() {
                if self.scene_lights.len() == self.scene_lights.capacity() {
                    break;
                }
                self.scene_lights.push(SceneLight {
                    entity_index: entity.index,
                    entity_generation: entity.generation,
                    light: ForwardLight {
                        position: [transform.pos.x, transform.pos.y, transform.pos.z],
                        radius: light.radius,
                        color: light.color,
                        intensity: light.intensity,
                    },
                    distance2: 0.0,
                });
            }
        }
        self.cameras.clear();
        {
            let mut q = world.query1::<Camera>();
            while let Some((_, c)) = q.next() {
                self.cameras.push(*c);
            }
        }
        self.cameras.sort_by_key(|c| c.order);
        self.scene_draws.clear();
        {
            let mut query = world.query2::<MeshRenderer, Transform>();
            while let Some((entity, mesh, transform)) = query.next() {
                if self.scene_draws.len() == self.scene_draws.capacity() {
                    break;
                }
                self.scene_draws.push(DrawRecord {
                    entity_index: entity.index,
                    entity_generation: entity.generation,
                    mesh: *mesh,
                    transform: *transform,
                });
            }
        }

        // --- shadow pass (texel-snapped ortho fit) ---
        let use_shadow = shadow_light.is_some();
        if let Some(light) = shadow_light {
            let center = self
                .cameras
                .iter()
                .find(|c| matches!(c.target, CamTarget::Screen(_)))
                .map(|c| c.look_at)
                .unwrap_or(Vec3::ZERO);
            self.shadow_view_proj = light_view_proj(
                light.dir,
                center,
                self.shadow_world_radius,
                self.shadow_size,
            );
            gpu.begin_pass(
                PassTarget::RenderTarget(self.shadow_rt),
                RectPx {
                    x: 0,
                    y: 0,
                    w: self.shadow_size as i32,
                    h: self.shadow_size as i32,
                },
                ClearSpec {
                    color: None,
                    depth: Some(1.0),
                },
            );
            let depth_state = PipelineState {
                depth_test: true,
                depth_write: true,
                cull: Cull::Front,
                color_write: false,
                blend: false,
                additive: false,
            };
            let skinned_depth_state = PipelineState {
                cull: Cull::None,
                ..depth_state
            };
            self.uniforms.clear();
            self.uniforms.push(Uniform {
                name: "u_lightViewProj",
                value: UniformValue::Mat4(self.shadow_view_proj),
            });
            gpu.set_pipeline(self.depth_prog, &depth_state);
            gpu.set_uniforms(&self.uniforms);
            gpu.set_pipeline(self.depth_skinned_prog, &skinned_depth_state);
            self.uniforms.clear();
            self.uniforms.push(Uniform {
                name: "u_lightViewProj",
                value: UniformValue::Mat4(self.shadow_view_proj),
            });
            gpu.set_uniforms(&self.uniforms);
            self.draw_all_meshes(gpu, world, DrawMode::Depth, 0, None, Vec3::ZERO);
            self.draw_instance_batches(gpu, DrawMode::Depth, 0, self.shadow_view_proj, Vec3::ZERO);
            gpu.end_pass();
        }

        // The first screen camera (lowest order) renders deferred.
        let deferred_idx = self
            .cameras
            .iter()
            .position(|c| matches!(c.target, CamTarget::Screen(_)));

        if deferred_idx.is_some() {
            self.ensure_screen_targets(gpu, screen_w, screen_h)?;
            // GI update is driven only by explicit world focus and static scene
            // inputs. Camera/view changes cannot invalidate the volume.
            let ld = main_light.map(|l| l.dir).unwrap_or(DEFAULT_LIGHT_DIR);
            let lc = main_light.map(|l| l.color).unwrap_or([1.0, 1.0, 1.0]);
            if let Some(gi) = self.gi.as_mut() {
                gi.step(gpu, [ld.x, ld.y, ld.z], lc);
            }
        }

        // --- camera passes ---
        let cam_count = self.cameras.len();
        for ci in 0..cam_count {
            let cam = self.cameras[ci];
            if Some(ci) == deferred_idx {
                self.deferred_camera(gpu, world, cam, screen_w, screen_h, main_light, use_shadow);
            } else {
                self.forward_camera(gpu, world, cam, screen_w, screen_h, main_light, use_shadow);
            }
        }

        // --- composite + text on screen ---
        self.composite_pass(gpu, world, screen_w, screen_h);
        self.text_pass(gpu, world, screen_w, screen_h);
        match gpu.take_error() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// (Re)create the G-buffer, scene, and half-resolution bloom targets.
    fn ensure_screen_targets<G: Gpu>(
        &mut self,
        gpu: &mut G,
        w: u32,
        h: u32,
    ) -> Result<(), GpuError> {
        let need = self
            .gbuffer_rt
            .as_ref()
            .is_none_or(|s| s.w != w || s.h != h);
        if !need {
            return Ok(());
        }
        let hdr = self.caps.half_float_target && self.quality != RenderQuality::Low;
        let scene_fmt: &'static [TextureFormat] = if hdr {
            &SCENE_HDR_FORMATS
        } else {
            &SCENE_LDR_FORMATS
        };
        let gb = gpu.create_render_target_mrt(&MrtDesc {
            width: w,
            height: h,
            colors: &GBUFFER_FORMATS,
            depth: true,
        });
        let scene = gpu.create_render_target_mrt(&MrtDesc {
            width: w,
            height: h,
            colors: scene_fmt,
            depth: false,
        });
        let scene_copy = gpu.create_render_target_mrt(&MrtDesc {
            width: w,
            height: h,
            colors: scene_fmt,
            depth: false,
        });
        let ldr = gpu.create_render_target_mrt(&MrtDesc {
            width: w,
            height: h,
            colors: &SCENE_LDR_FORMATS,
            depth: false,
        });
        let bloom_w = w.div_ceil(2).max(1);
        let bloom_h = h.div_ceil(2).max(1);
        let bloom_extract = gpu.create_render_target_mrt(&MrtDesc {
            width: bloom_w,
            height: bloom_h,
            colors: scene_fmt,
            depth: false,
        });
        let bloom_blur = gpu.create_render_target_mrt(&MrtDesc {
            width: bloom_w,
            height: bloom_h,
            colors: scene_fmt,
            depth: false,
        });
        if let Some(error) = gpu.take_error() {
            for target in [gb, scene, scene_copy, ldr, bloom_extract, bloom_blur] {
                gpu.delete_render_target(target);
            }
            return Err(error);
        }
        for target in [
            self.gbuffer_rt.take(),
            self.scene_rt.take(),
            self.scene_copy_rt.take(),
            self.ldr_rt.take(),
            self.bloom_extract_rt.take(),
            self.bloom_blur_rt.take(),
        ]
        .into_iter()
        .flatten()
        {
            gpu.delete_render_target(target.rt);
        }
        self.exposure = if hdr { 1.0 } else { 0.25 };
        self.gbuffer_rt = Some(SizedRt { rt: gb, w, h });
        self.scene_rt = Some(SizedRt { rt: scene, w, h });
        self.scene_copy_rt = Some(SizedRt {
            rt: scene_copy,
            w,
            h,
        });
        self.ldr_rt = Some(SizedRt { rt: ldr, w, h });
        self.bloom_extract_rt = Some(SizedRt {
            rt: bloom_extract,
            w: bloom_w,
            h: bloom_h,
        });
        self.bloom_blur_rt = Some(SizedRt {
            rt: bloom_blur,
            w: bloom_w,
            h: bloom_h,
        });
        Ok(())
    }

    /// Deferred screen camera: G-buffer → sun light → point lights → tonemap.
    #[allow(clippy::too_many_arguments)]
    fn deferred_camera<G: Gpu, W: RenderWorld>(
        &mut self,
        gpu: &mut G,
        world: &mut W,
        cam: Camera,
        screen_w: u32,
        screen_h: u32,
        main_light: Option<DirectionalLight>,
        use_shadow: bool,
    ) {
        let rect = match cam.target {
            CamTarget::Screen(r) => r,
            _ => return,
        };
        let (gb_rt, scene_rt, ldr_rt, gw, gh) =
            match (&self.gbuffer_rt, &self.scene_rt, &self.ldr_rt) {
                (Some(g), Some(s), Some(ldr)) => (g.rt, s.rt, ldr.rt, g.w, g.h),
                _ => return,
            };
        let vp = viewport_px(rect, screen_w, screen_h);
        let aspect = if vp.h != 0 {
            vp.w as f32 / vp.h as f32
        } else {
            1.0
        };
        let view = Mat4::look_at(cam.eye, cam.look_at, cam.up);
        let proj = projection_matrix(cam.projection, aspect);
        let vp_mat = proj.mul(view);
        let view_proj = vp_mat.to_cols_array();
        let inv_view_proj = vp_mat.inverse().to_cols_array();
        let full = RectPx {
            x: 0,
            y: 0,
            w: gw as i32,
            h: gh as i32,
        };
        let ld = main_light.map(|l| l.dir).unwrap_or(DEFAULT_LIGHT_DIR);
        let lc = main_light.map(|l| l.color).unwrap_or([1.0, 1.0, 1.0]);

        // --- G-buffer pass (full target) ---
        let clear_color = cam.clear.color.unwrap_or([0.0, 0.0, 0.0, 1.0]);
        gpu.begin_pass(
            PassTarget::RenderTarget(gb_rt),
            full,
            ClearSpec {
                color: Some(clear_color),
                depth: Some(1.0),
            },
        );
        gpu.set_pipeline(self.gbuffer_prog, &PipelineState::default());
        self.uniforms.clear();
        self.uniforms.push(Uniform {
            name: "u_viewProj",
            value: UniformValue::Mat4(view_proj),
        });
        self.uniforms.push(Uniform {
            name: "u_albedo",
            value: UniformValue::Sampler(0),
        });
        gpu.set_uniforms(&self.uniforms);
        gpu.set_pipeline(self.gbuffer_skinned_prog, &PipelineState::default());
        self.uniforms.clear();
        self.uniforms.push(Uniform {
            name: "u_viewProj",
            value: UniformValue::Mat4(view_proj),
        });
        self.uniforms.push(Uniform {
            name: "u_albedo",
            value: UniformValue::Sampler(0),
        });
        gpu.set_uniforms(&self.uniforms);
        gpu.set_pipeline(self.terrain_gbuffer_prog, &PipelineState::default());
        self.uniforms.clear();
        self.uniforms.push(Uniform {
            name: "u_viewProj",
            value: UniformValue::Mat4(view_proj),
        });
        gpu.set_uniforms(&self.uniforms);
        self.draw_all_meshes(
            gpu,
            world,
            DrawMode::GBuffer,
            cam.viewport_id,
            None,
            cam.eye,
        );
        self.draw_instance_batches(gpu, DrawMode::GBuffer, cam.viewport_id, view_proj, cam.eye);
        gpu.end_pass();

        // --- deferred sun light pass → HDR scene target ---
        gpu.begin_pass(
            PassTarget::RenderTarget(scene_rt),
            full,
            ClearSpec {
                color: Some([0.0, 0.0, 0.0, 1.0]),
                depth: None,
            },
        );
        gpu.set_pipeline(
            self.light_prog,
            &PipelineState {
                depth_test: false,
                depth_write: false,
                cull: Cull::None,
                color_write: true,
                blend: false,
                additive: false,
            },
        );
        if let Some(t) = gpu.render_target_color_n(gb_rt, 0) {
            gpu.bind_texture(0, t);
        }
        if let Some(t) = gpu.render_target_color_n(gb_rt, 1) {
            gpu.bind_texture(1, t);
        }
        if let Some(t) = gpu.render_target_depth(gb_rt) {
            gpu.bind_texture(2, t);
        }
        if let Some(t) = gpu.render_target_depth(self.shadow_rt) {
            gpu.bind_texture(3, t);
        }
        if let Some(t) = gpu.render_target_color_n(gb_rt, 2) {
            gpu.bind_texture(5, t);
        }
        if let Some(t) = gpu.render_target_color_n(gb_rt, 3) {
            gpu.bind_texture(6, t);
        }
        let gi_binding = self.gi.as_ref().and_then(GiVolume::binding);
        if let Some(gi) = self.gi.as_ref() {
            gpu.bind_texture_3d(4, gi.radiance_texture());
        }
        let world_texel = 2.0 * self.shadow_world_radius / self.shadow_size as f32;
        self.uniforms.clear();
        self.uniforms.push(Uniform {
            name: "u_gb0",
            value: UniformValue::Sampler(0),
        });
        self.uniforms.push(Uniform {
            name: "u_gb1",
            value: UniformValue::Sampler(1),
        });
        self.uniforms.push(Uniform {
            name: "u_gb2",
            value: UniformValue::Sampler(5),
        });
        self.uniforms.push(Uniform {
            name: "u_gb3",
            value: UniformValue::Sampler(6),
        });
        self.uniforms.push(Uniform {
            name: "u_depth",
            value: UniformValue::Sampler(2),
        });
        self.uniforms.push(Uniform {
            name: "u_shadowMap",
            value: UniformValue::Sampler(3),
        });
        self.uniforms.push(Uniform {
            name: "u_gi",
            value: UniformValue::Sampler(4),
        });
        self.uniforms.push(Uniform {
            name: "u_invViewProj",
            value: UniformValue::Mat4(inv_view_proj),
        });
        self.uniforms.push(Uniform {
            name: "u_lightViewProj",
            value: UniformValue::Mat4(self.shadow_view_proj),
        });
        self.uniforms.push(Uniform {
            name: "u_lightDir",
            value: UniformValue::Vec3([ld.x, ld.y, ld.z]),
        });
        self.uniforms.push(Uniform {
            name: "u_lightColor",
            value: UniformValue::Vec3(lc),
        });
        self.uniforms.push(Uniform {
            name: "u_camEye",
            value: UniformValue::Vec3([cam.eye.x, cam.eye.y, cam.eye.z]),
        });
        self.uniforms.push(Uniform {
            name: "u_ambient",
            value: UniformValue::Float(self.ambient),
        });
        self.uniforms.push(Uniform {
            name: "u_fogColor",
            value: UniformValue::Vec3(self.fog_color),
        });
        self.uniforms.push(Uniform {
            name: "u_fogNear",
            value: UniformValue::Float(self.fog_near),
        });
        self.uniforms.push(Uniform {
            name: "u_fogFar",
            value: UniformValue::Float(self.fog_far),
        });
        self.uniforms.push(Uniform {
            name: "u_shadowTexelUV",
            value: UniformValue::Float(1.0 / self.shadow_size as f32),
        });
        self.uniforms.push(Uniform {
            name: "u_shadowWorldTexel",
            value: UniformValue::Float(world_texel),
        });
        self.uniforms.push(Uniform {
            name: "u_sunPenumbraScale",
            value: UniformValue::Float(self.settings.shadows.penumbra),
        });
        self.uniforms.push(Uniform {
            name: "u_shadowDepthBias",
            value: UniformValue::Float(self.settings.shadows.depth_bias),
        });
        self.uniforms.push(Uniform {
            name: "u_shadowNormalBias",
            value: UniformValue::Float(self.settings.shadows.normal_bias),
        });
        self.uniforms.push(Uniform {
            name: "u_emissiveScalar",
            value: UniformValue::Float(self.settings.emissive_scalar),
        });
        self.uniforms.push(Uniform {
            name: "u_aoIntensity",
            value: UniformValue::Float(self.settings.ao_intensity),
        });
        self.uniforms.push(Uniform {
            name: "u_giReady",
            value: UniformValue::Int(if gi_binding.is_some() { 1 } else { 0 }),
        });
        self.uniforms.push(Uniform {
            name: "u_giOrigin",
            value: UniformValue::Vec3(gi_binding.map_or([0.0; 3], |b| b.origin)),
        });
        self.uniforms.push(Uniform {
            name: "u_giValidMin",
            value: UniformValue::Vec3(gi_binding.map_or([0.0; 3], |b| b.valid_min)),
        });
        self.uniforms.push(Uniform {
            name: "u_giValidMax",
            value: UniformValue::Vec3(gi_binding.map_or([0.0; 3], |b| b.valid_max)),
        });
        self.uniforms.push(Uniform {
            name: "u_giBlend",
            value: UniformValue::Float(gi_binding.map_or(0.0, |b| b.blend)),
        });
        self.uniforms.push(Uniform {
            name: "u_giCell",
            value: UniformValue::Float(crate::gi::GI_CELL),
        });
        self.uniforms.push(Uniform {
            name: "u_giStrength",
            value: UniformValue::Float(1.4),
        });
        self.uniforms.push(Uniform {
            name: "u_exposure",
            value: UniformValue::Float(self.exposure),
        });
        gpu.set_uniforms(&self.uniforms);
        self.draw_fullscreen(gpu);
        gpu.end_pass();

        // --- point-light volumes (additive into the HDR scene target) ---
        self.point_light_pass(
            gpu,
            world,
            scene_rt,
            full,
            &view_proj,
            &inv_view_proj,
            cam.eye,
            gw,
            gh,
        );
        let scene_copy_rt = self.scene_copy_rt.as_ref().expect("screen targets").rt;
        gpu.begin_pass(
            PassTarget::RenderTarget(scene_copy_rt),
            full,
            ClearSpec::default(),
        );
        gpu.set_pipeline(
            self.copy_prog,
            &PipelineState {
                depth_test: false,
                depth_write: false,
                cull: Cull::None,
                color_write: true,
                blend: false,
                additive: false,
            },
        );
        if let Some(texture) = gpu.render_target_color(scene_rt) {
            gpu.bind_texture(0, texture);
        }
        self.uniforms.clear();
        self.uniforms.push(Uniform {
            name: "u_source",
            value: UniformValue::Sampler(0),
        });
        gpu.set_uniforms(&self.uniforms);
        self.draw_fullscreen(gpu);
        gpu.end_pass();
        self.transparent_pass(
            gpu, world, scene_rt, full, cam, view_proj, ld, lc, use_shadow,
        );
        self.bloom_passes(gpu, scene_rt);

        // --- tonemap + grade → LDR target ---
        gpu.begin_pass(PassTarget::RenderTarget(ldr_rt), full, ClearSpec::default());
        gpu.set_pipeline(
            self.tonemap_prog,
            &PipelineState {
                depth_test: false,
                depth_write: false,
                cull: Cull::None,
                color_write: true,
                blend: false,
                additive: false,
            },
        );
        if let Some(t) = gpu.render_target_color(scene_rt) {
            gpu.bind_texture(0, t);
        }
        if let Some(t) = gpu.render_target_depth(gb_rt) {
            gpu.bind_texture(1, t);
        }
        if let Some(bloom) = self
            .bloom_extract_rt
            .as_ref()
            .and_then(|target| gpu.render_target_color(target.rt))
        {
            gpu.bind_texture(2, bloom);
        }
        let g = self.grade;
        self.uniforms.clear();
        self.uniforms.push(Uniform {
            name: "u_scene",
            value: UniformValue::Sampler(0),
        });
        self.uniforms.push(Uniform {
            name: "u_depth",
            value: UniformValue::Sampler(1),
        });
        self.uniforms.push(Uniform {
            name: "u_bloomTex",
            value: UniformValue::Sampler(2),
        });
        self.uniforms.push(Uniform {
            name: "u_boneTint",
            value: UniformValue::Vec3(g.bone_tint),
        });
        self.uniforms.push(Uniform {
            name: "u_desaturate",
            value: UniformValue::Float(g.desaturate),
        });
        self.uniforms.push(Uniform {
            name: "u_sceneDarken",
            value: UniformValue::Float(g.scene_darken),
        });
        self.uniforms.push(Uniform {
            name: "u_blackLift",
            value: UniformValue::Float(g.black_lift),
        });
        self.uniforms.push(Uniform {
            name: "u_invExposure",
            value: UniformValue::Float(1.0 / self.exposure),
        });
        self.uniforms.push(Uniform {
            name: "u_bloomIntensity",
            value: UniformValue::Float(self.bloom.intensity * BLOOM_INTENSITY_GAIN),
        });
        let master = self.settings.color_grade;
        let palette = self.settings.palette;
        self.uniforms.push(Uniform {
            name: "u_masterExposure",
            value: UniformValue::Float(self.settings.exposure),
        });
        self.uniforms.push(Uniform {
            name: "u_saturation",
            value: UniformValue::Float(master.saturation),
        });
        self.uniforms.push(Uniform {
            name: "u_contrast",
            value: UniformValue::Float(master.contrast),
        });
        self.uniforms.push(Uniform {
            name: "u_gamma",
            value: UniformValue::Float(master.gamma),
        });
        self.uniforms.push(Uniform {
            name: "u_temperature",
            value: UniformValue::Float(master.temperature),
        });
        self.uniforms.push(Uniform {
            name: "u_tint",
            value: UniformValue::Float(master.tint),
        });
        self.uniforms.push(Uniform {
            name: "u_lift",
            value: UniformValue::Vec3(master.lift),
        });
        self.uniforms.push(Uniform {
            name: "u_colorGamma",
            value: UniformValue::Vec3(master.color_gamma),
        });
        self.uniforms.push(Uniform {
            name: "u_gain",
            value: UniformValue::Vec3(master.gain),
        });
        self.uniforms.push(Uniform {
            name: "u_paletteEnabled",
            value: UniformValue::Int(palette.enabled as i32),
        });
        self.uniforms.push(Uniform {
            name: "u_paletteLevels",
            value: UniformValue::Float(palette.levels as f32),
        });
        self.uniforms.push(Uniform {
            name: "u_paletteStrength",
            value: UniformValue::Float(palette.strength),
        });
        self.uniforms.push(Uniform {
            name: "u_paletteDither",
            value: UniformValue::Float(palette.dither),
        });
        gpu.set_uniforms(&self.uniforms);
        self.draw_fullscreen(gpu);
        gpu.end_pass();
        // --- FXAA 3.11 preset 12 → screen, restoring opaque depth ---
        gpu.begin_pass(PassTarget::Screen, vp, ClearSpec::default());
        gpu.set_pipeline(
            self.fxaa_prog,
            &PipelineState {
                depth_test: false,
                depth_write: true,
                cull: Cull::None,
                color_write: true,
                blend: false,
                additive: false,
            },
        );
        if let Some(texture) = gpu.render_target_color(ldr_rt) {
            gpu.bind_texture(0, texture);
        }
        if let Some(depth) = gpu.render_target_depth(gb_rt) {
            gpu.bind_texture(1, depth);
        }
        self.uniforms.clear();
        self.uniforms.push(Uniform {
            name: "u_ldr",
            value: UniformValue::Sampler(0),
        });
        self.uniforms.push(Uniform {
            name: "u_depth",
            value: UniformValue::Sampler(1),
        });
        self.uniforms.push(Uniform {
            name: "u_invResolution",
            value: UniformValue::Vec2([1.0 / gw as f32, 1.0 / gh as f32]),
        });
        self.uniforms.push(Uniform {
            name: "u_enabled",
            value: UniformValue::Int(self.settings.aa.enabled as i32),
        });
        self.uniforms.push(Uniform {
            name: "u_edgeThresholdMin",
            value: UniformValue::Float(self.settings.aa.edge_threshold_min),
        });
        self.uniforms.push(Uniform {
            name: "u_edgeThreshold",
            value: UniformValue::Float(self.settings.aa.edge_threshold),
        });
        self.uniforms.push(Uniform {
            name: "u_subpixelBlend",
            value: UniformValue::Float(self.settings.aa.subpixel_blend),
        });
        gpu.set_uniforms(&self.uniforms);
        self.draw_fullscreen(gpu);
        gpu.end_pass();
    }

    fn bloom_passes<G: Gpu>(&mut self, gpu: &mut G, scene_rt: RenderTargetId) {
        let (extract, blur, width, height) = match (&self.bloom_extract_rt, &self.bloom_blur_rt) {
            (Some(extract), Some(blur)) => (extract.rt, blur.rt, extract.w, extract.h),
            _ => return,
        };
        let viewport = RectPx {
            x: 0,
            y: 0,
            w: width as i32,
            h: height as i32,
        };
        gpu.begin_pass(
            PassTarget::RenderTarget(extract),
            viewport,
            ClearSpec {
                color: Some([0.0; 4]),
                depth: None,
            },
        );
        gpu.set_pipeline(
            self.bloom_extract_prog,
            &PipelineState {
                depth_test: false,
                depth_write: false,
                cull: Cull::None,
                color_write: true,
                blend: false,
                additive: false,
            },
        );
        if let Some(scene) = gpu.render_target_color(scene_rt) {
            gpu.bind_texture(0, scene);
        }
        self.uniforms.clear();
        self.uniforms.push(Uniform {
            name: "u_scene",
            value: UniformValue::Sampler(0),
        });
        self.uniforms.push(Uniform {
            name: "u_threshold",
            value: UniformValue::Float(self.bloom.threshold * self.exposure),
        });
        gpu.set_uniforms(&self.uniforms);
        self.draw_fullscreen(gpu);
        gpu.end_pass();

        let radius = self.settings.bloom_radius;
        for (source, target, direction) in [
            (extract, blur, [radius / width as f32, 0.0]),
            (blur, extract, [0.0, radius / height as f32]),
        ] {
            gpu.begin_pass(
                PassTarget::RenderTarget(target),
                viewport,
                ClearSpec {
                    color: Some([0.0; 4]),
                    depth: None,
                },
            );
            gpu.set_pipeline(
                self.bloom_blur_prog,
                &PipelineState {
                    depth_test: false,
                    depth_write: false,
                    cull: Cull::None,
                    color_write: true,
                    blend: false,
                    additive: false,
                },
            );
            if let Some(texture) = gpu.render_target_color(source) {
                gpu.bind_texture(0, texture);
            }
            self.uniforms.clear();
            self.uniforms.push(Uniform {
                name: "u_source",
                value: UniformValue::Sampler(0),
            });
            self.uniforms.push(Uniform {
                name: "u_direction",
                value: UniformValue::Vec2(direction),
            });
            gpu.set_uniforms(&self.uniforms);
            self.draw_fullscreen(gpu);
            gpu.end_pass();
        }
    }

    /// Point-light volume pass: gather lights, additive PBR into `scene_rt`.
    #[allow(clippy::too_many_arguments)]
    fn point_light_pass<G: Gpu, W: RenderWorld>(
        &mut self,
        gpu: &mut G,
        world: &mut W,
        scene_rt: RenderTargetId,
        full: RectPx,
        view_proj: &[f32; 16],
        inv_view_proj: &[f32; 16],
        cam_eye: Vec3,
        gw: u32,
        gh: u32,
    ) {
        self.pl_scratch.clear();
        let mut count = 0u32;
        {
            let mut q = world.query2::<PointLight, Transform>();
            while let Some((_, pl, tr)) = q.next() {
                if count >= 256 {
                    break;
                }
                self.pl_scratch.extend_from_slice(&[
                    tr.pos.x,
                    tr.pos.y,
                    tr.pos.z,
                    pl.radius,
                    pl.color[0],
                    pl.color[1],
                    pl.color[2],
                    pl.intensity,
                ]);
                count += 1;
            }
        }
        if count == 0 {
            return;
        }
        gpu.begin_pass(
            PassTarget::RenderTarget(scene_rt),
            full,
            ClearSpec::default(),
        );
        gpu.set_pipeline(
            self.point_light_prog,
            &PipelineState {
                depth_test: false,
                depth_write: false,
                cull: Cull::Front,
                color_write: true,
                blend: true,
                additive: true,
            },
        );
        if let Some(t) = gpu.render_target_color_n(self.gbuffer_rt.as_ref().unwrap().rt, 0) {
            gpu.bind_texture(0, t);
        }
        if let Some(t) = gpu.render_target_color_n(self.gbuffer_rt.as_ref().unwrap().rt, 1) {
            gpu.bind_texture(1, t);
        }
        if let Some(t) = gpu.render_target_depth(self.gbuffer_rt.as_ref().unwrap().rt) {
            gpu.bind_texture(2, t);
        }
        if let Some(t) = gpu.render_target_color_n(self.gbuffer_rt.as_ref().unwrap().rt, 3) {
            gpu.bind_texture(3, t);
        }
        self.uniforms.clear();
        self.uniforms.push(Uniform {
            name: "u_viewProj",
            value: UniformValue::Mat4(*view_proj),
        });
        self.uniforms.push(Uniform {
            name: "u_invViewProj",
            value: UniformValue::Mat4(*inv_view_proj),
        });
        self.uniforms.push(Uniform {
            name: "u_gb0",
            value: UniformValue::Sampler(0),
        });
        self.uniforms.push(Uniform {
            name: "u_gb1",
            value: UniformValue::Sampler(1),
        });
        self.uniforms.push(Uniform {
            name: "u_gb3",
            value: UniformValue::Sampler(3),
        });
        self.uniforms.push(Uniform {
            name: "u_depth",
            value: UniformValue::Sampler(2),
        });
        self.uniforms.push(Uniform {
            name: "u_camEye",
            value: UniformValue::Vec3([cam_eye.x, cam_eye.y, cam_eye.z]),
        });
        self.uniforms.push(Uniform {
            name: "u_screenSize",
            value: UniformValue::Vec4([gw as f32, gh as f32, 0.0, 0.0]),
        });
        self.uniforms.push(Uniform {
            name: "u_exposure",
            value: UniformValue::Float(self.exposure),
        });
        gpu.set_uniforms(&self.uniforms);
        gpu.update_buffer(self.pl_inst_buf, f32_bytes(&self.pl_scratch));
        gpu.draw_instanced(
            self.pl_vbo,
            Some(self.pl_ebo),
            &MESH_LAYOUT,
            self.pl_index_count,
            self.pl_inst_buf,
            &POINT_LIGHT_INSTANCE_LAYOUT,
            count,
        );
        gpu.end_pass();
    }

    #[allow(clippy::too_many_arguments)]
    fn transparent_pass<G: Gpu, W: RenderWorld>(
        &mut self,
        gpu: &mut G,
        world: &mut W,
        scene_rt: RenderTargetId,
        full: RectPx,
        cam: Camera,
        view_proj: [f32; 16],
        light_dir: Vec3,
        light_color: [f32; 3],
        use_shadow: bool,
    ) {
        gpu.begin_pass(
            PassTarget::RenderTarget(scene_rt),
            full,
            ClearSpec::default(),
        );
        for program in [self.mesh_prog, self.mesh_skinned_prog] {
            gpu.set_pipeline(program, &PipelineState::default());
            self.uniforms.clear();
            self.uniforms.push(Uniform {
                name: "u_viewProj",
                value: UniformValue::Mat4(view_proj),
            });
            self.uniforms.push(Uniform {
                name: "u_lightViewProj",
                value: UniformValue::Mat4(self.shadow_view_proj),
            });
            self.uniforms.push(Uniform {
                name: "u_lightDir",
                value: UniformValue::Vec3([light_dir.x, light_dir.y, light_dir.z]),
            });
            self.uniforms.push(Uniform {
                name: "u_sceneCopy",
                value: UniformValue::Sampler(6),
            });
            self.uniforms.push(Uniform {
                name: "u_opaqueDepth",
                value: UniformValue::Sampler(7),
            });
            self.uniforms.push(Uniform {
                name: "u_screenSize",
                value: UniformValue::Vec2([full.w as f32, full.h as f32]),
            });
            self.uniforms.push(Uniform {
                name: "u_transparentPass",
                value: UniformValue::Int(1),
            });
            if let Some(copy) =
                gpu.render_target_color(self.scene_copy_rt.as_ref().expect("screen targets").rt)
            {
                gpu.bind_texture(6, copy);
            }
            if let Some(depth) =
                gpu.render_target_depth(self.gbuffer_rt.as_ref().expect("screen targets").rt)
            {
                gpu.bind_texture(7, depth);
            }
            self.uniforms.push(Uniform {
                name: "u_lightColor",
                value: UniformValue::Vec3(light_color),
            });
            self.uniforms.push(Uniform {
                name: "u_ambient",
                value: UniformValue::Float(self.ambient),
            });
            self.uniforms.push(Uniform {
                name: "u_shadowMap",
                value: UniformValue::Sampler(0),
            });
            self.uniforms.push(Uniform {
                name: "u_useShadow",
                value: UniformValue::Int(use_shadow as i32),
            });
            self.uniforms.push(Uniform {
                name: "u_albedo",
                value: UniformValue::Sampler(1),
            });
            self.uniforms.push(Uniform {
                name: "u_camEye",
                value: UniformValue::Vec3([cam.eye.x, cam.eye.y, cam.eye.z]),
            });
            self.uniforms.push(Uniform {
                name: "u_fogColor",
                value: UniformValue::Vec3(self.fog_color),
            });
            self.uniforms.push(Uniform {
                name: "u_fogNear",
                value: UniformValue::Float(self.fog_near),
            });
            self.uniforms.push(Uniform {
                name: "u_fogFar",
                value: UniformValue::Float(self.fog_far),
            });
            gpu.set_uniforms(&self.uniforms);
            if let Some(depth_tex) = gpu.render_target_depth(self.shadow_rt) {
                gpu.bind_texture(0, depth_tex);
            }
        }
        self.draw_all_meshes(
            gpu,
            world,
            DrawMode::Transparent,
            cam.viewport_id,
            None,
            cam.eye,
        );
        gpu.end_pass();
    }

    /// Forward camera (RTT minimap/portraits): unchanged lit forward path.
    #[allow(clippy::too_many_arguments)]
    fn forward_camera<G: Gpu, W: RenderWorld>(
        &mut self,
        gpu: &mut G,
        world: &mut W,
        cam: Camera,
        screen_w: u32,
        screen_h: u32,
        main_light: Option<DirectionalLight>,
        use_shadow: bool,
    ) {
        let (target, vp) = match cam.target {
            CamTarget::Screen(rect) => (PassTarget::Screen, viewport_px(rect, screen_w, screen_h)),
            CamTarget::Texture(rt) => (
                PassTarget::RenderTarget(rt),
                RectPx {
                    x: 0,
                    y: 0,
                    w: rt_side(screen_w),
                    h: rt_side(screen_w),
                },
            ),
        };
        let aspect = if vp.h != 0 {
            vp.w as f32 / vp.h as f32
        } else {
            1.0
        };
        let view = Mat4::look_at(cam.eye, cam.look_at, cam.up);
        let proj = projection_matrix(cam.projection, aspect);
        let view_proj = proj.mul(view).to_cols_array();
        let ld = main_light.map(|l| l.dir).unwrap_or(DEFAULT_LIGHT_DIR);
        let lc = main_light.map(|l| l.color).unwrap_or([1.0, 1.0, 1.0]);

        gpu.begin_pass(target, vp, cam.clear);
        for prog in [self.mesh_prog, self.mesh_skinned_prog] {
            gpu.set_pipeline(prog, &PipelineState::default());
            self.uniforms.clear();
            self.uniforms.push(Uniform {
                name: "u_viewProj",
                value: UniformValue::Mat4(view_proj),
            });
            self.uniforms.push(Uniform {
                name: "u_lightViewProj",
                value: UniformValue::Mat4(self.shadow_view_proj),
            });
            self.uniforms.push(Uniform {
                name: "u_lightDir",
                value: UniformValue::Vec3([ld.x, ld.y, ld.z]),
            });
            self.uniforms.push(Uniform {
                name: "u_lightColor",
                value: UniformValue::Vec3(lc),
            });
            self.uniforms.push(Uniform {
                name: "u_ambient",
                value: UniformValue::Float(self.ambient),
            });
            self.uniforms.push(Uniform {
                name: "u_shadowMap",
                value: UniformValue::Sampler(0),
            });
            self.uniforms.push(Uniform {
                name: "u_useShadow",
                value: UniformValue::Int(if use_shadow { 1 } else { 0 }),
            });
            self.uniforms.push(Uniform {
                name: "u_albedo",
                value: UniformValue::Sampler(1),
            });
            self.uniforms.push(Uniform {
                name: "u_camEye",
                value: UniformValue::Vec3([cam.eye.x, cam.eye.y, cam.eye.z]),
            });
            self.uniforms.push(Uniform {
                name: "u_screenSize",
                value: UniformValue::Vec2([vp.w as f32, vp.h as f32]),
            });
            self.uniforms.push(Uniform {
                name: "u_transparentPass",
                value: UniformValue::Int(0),
            });
            self.uniforms.push(Uniform {
                name: "u_fogColor",
                value: UniformValue::Vec3(self.fog_color),
            });
            self.uniforms.push(Uniform {
                name: "u_fogNear",
                value: UniformValue::Float(self.fog_near),
            });
            self.uniforms.push(Uniform {
                name: "u_fogFar",
                value: UniformValue::Float(self.fog_far),
            });
            gpu.set_uniforms(&self.uniforms);
            if let Some(depth_tex) = gpu.render_target_depth(self.shadow_rt) {
                gpu.bind_texture(0, depth_tex);
            }
        }
        self.draw_all_meshes(
            gpu,
            world,
            DrawMode::Forward,
            cam.viewport_id,
            None,
            cam.eye,
        );
        gpu.end_pass();
    }

    /// Draw a fullscreen NDC quad from the reused dynamic buffer.
    fn draw_fullscreen<G: Gpu>(&mut self, gpu: &mut G) {
        self.quad.clear();
        self.quad.extend_from_slice(&FS_QUAD);
        gpu.update_buffer(self.dyn_buf, f32_bytes(&self.quad));
        gpu.draw(self.dyn_buf, None, &QUAD_LAYOUT, 6);
    }

    fn draw_all_meshes<G: Gpu, W: RenderWorld>(
        &mut self,
        gpu: &mut G,
        _world: &mut W,
        mode: DrawMode,
        viewport_id: u8,
        _want_skinned: Option<bool>,
        camera_eye: Vec3,
    ) {
        let visible_only = !matches!(mode, DrawMode::Depth);
        self.draw_scratch.clear();
        let meshes = &self.meshes;
        let materials = &self.materials;
        for (scene_index, record) in self.scene_draws.iter().enumerate() {
            let mesh = record.mesh;
            if meshes.get(mesh.mesh.0 as usize).is_none() {
                continue;
            }
            if visible_only && (mesh.viewport_mask & (1u32 << viewport_id)) == 0 {
                continue;
            }
            let material = materials.get(mesh.material.0 as usize).copied();
            let desc = material.map(|value| value.desc).unwrap_or_default();
            let transparent = desc.blend || desc.transmission > 0.0;
            if (matches!(mode, DrawMode::Depth | DrawMode::GBuffer) && transparent)
                || (matches!(mode, DrawMode::Transparent) && !transparent)
            {
                continue;
            }
            self.draw_scratch.push(scene_index);
        }
        if matches!(mode, DrawMode::Transparent) {
            self.draw_scratch.sort_unstable_by(|left, right| {
                let left_record = self.scene_draws[*left];
                let right_record = self.scene_draws[*right];
                let left_delta = left_record.transform.pos.sub(camera_eye);
                let right_delta = right_record.transform.pos.sub(camera_eye);
                right_delta
                    .dot(right_delta)
                    .total_cmp(&left_delta.dot(left_delta))
                    .then_with(|| left_record.entity_index.cmp(&right_record.entity_index))
                    .then_with(|| {
                        left_record
                            .entity_generation
                            .cmp(&right_record.entity_generation)
                    })
                    .then_with(|| {
                        left_record
                            .mesh
                            .material
                            .0
                            .cmp(&right_record.mesh.material.0)
                    })
            });
        }
        for draw_index in 0..self.draw_scratch.len() {
            let record = self.scene_draws[self.draw_scratch[draw_index]];
            let mr = record.mesh;
            let tr = record.transform;
            let mesh = match self.meshes.get(mr.mesh.0 as usize) {
                Some(mesh) => *mesh,
                None => continue,
            };
            let model = Mat4::from_trs(tr.pos, tr.rot, tr.scale).to_cols_array();
            let material = self.materials.get(mr.material.0 as usize).copied();
            let material_desc = material.map(|value| value.desc).unwrap_or_default();
            let transparent = material_desc.blend || material_desc.transmission > 0.0;
            let program = match mode {
                DrawMode::Depth => {
                    if material_desc.terrain.is_some() {
                        self.terrain_depth_prog
                    } else if mesh.skinned {
                        self.depth_skinned_prog
                    } else {
                        self.depth_prog
                    }
                }
                DrawMode::Forward | DrawMode::Transparent => {
                    if mesh.skinned {
                        self.mesh_skinned_prog
                    } else {
                        self.mesh_prog
                    }
                }
                DrawMode::GBuffer => {
                    if material_desc.terrain.is_some() {
                        self.terrain_gbuffer_prog
                    } else if mesh.skinned {
                        self.gbuffer_skinned_prog
                    } else {
                        self.gbuffer_prog
                    }
                }
            };
            gpu.set_pipeline(
                program,
                &PipelineState {
                    depth_test: !matches!(mode, DrawMode::Transparent),
                    depth_write: !matches!(mode, DrawMode::Transparent) && !transparent,
                    cull: if material_desc.double_sided {
                        Cull::None
                    } else {
                        Cull::Back
                    },
                    color_write: true,
                    blend: matches!(mode, DrawMode::Transparent) || material_desc.blend,
                    additive: false,
                },
            );
            self.uniforms.clear();
            self.uniforms.push(Uniform {
                name: "u_model",
                value: UniformValue::Mat4(model),
            });
            if matches!(mode, DrawMode::Forward | DrawMode::Transparent) {
                for light in &mut self.scene_lights {
                    let dx = light.light.position[0] - tr.pos.x;
                    let dy = light.light.position[1] - tr.pos.y;
                    let dz = light.light.position[2] - tr.pos.z;
                    light.distance2 = dx * dx + dy * dy + dz * dz;
                }
                self.scene_lights.sort_unstable_by(|left, right| {
                    left.distance2
                        .total_cmp(&right.distance2)
                        .then_with(|| left.entity_index.cmp(&right.entity_index))
                        .then_with(|| left.entity_generation.cmp(&right.entity_generation))
                });
                self.forward_lights.clear();
                for light in self.scene_lights.iter().take(self.max_forward_lights) {
                    self.forward_lights.push(light.light);
                }
                gpu.set_forward_lights(&self.forward_lights);
            }
            self.uniforms.push(Uniform {
                name: "u_hasVertexColor",
                value: UniformValue::Int(mesh.has_vertex_color as i32),
            });
            self.uniforms.push(Uniform {
                name: "u_hasTangent",
                value: UniformValue::Int(mesh.has_tangent as i32),
            });
            let mut albedo_tex = None;
            match mode {
                DrawMode::Depth => {
                    if let Some(terrain) = material_desc.terrain {
                        self.uniforms.push(Uniform {
                            name: "u_terrainControl",
                            value: UniformValue::Sampler(0),
                        });
                        self.uniforms.push(Uniform {
                            name: "u_terrainOrigin",
                            value: UniformValue::Vec2(terrain.world_origin),
                        });
                        self.uniforms.push(Uniform {
                            name: "u_terrainWorldSize",
                            value: UniformValue::Float(terrain.world_size),
                        });
                        gpu.bind_texture(0, terrain.control_texture);
                    }
                }
                DrawMode::Forward | DrawMode::Transparent => {
                    self.uniforms.push(Uniform {
                        name: "u_transmission",
                        value: UniformValue::Float(material_desc.transmission),
                    });
                    self.uniforms.push(Uniform {
                        name: "u_ior",
                        value: UniformValue::Float(material_desc.ior),
                    });
                    self.uniforms.push(Uniform {
                        name: "u_metallic",
                        value: UniformValue::Float(material_desc.metallic),
                    });
                    self.uniforms.push(Uniform {
                        name: "u_roughness",
                        value: UniformValue::Float(material_desc.roughness),
                    });
                    let ior = material_desc.ior.max(1.0);
                    let ratio = (ior - 1.0) / (ior + 1.0);
                    self.uniforms.push(Uniform {
                        name: "u_dielectricF0",
                        value: UniformValue::Float(ratio * ratio * material_desc.specular),
                    });
                    self.uniforms.push(Uniform {
                        name: "u_clearcoat",
                        value: UniformValue::Float(material_desc.clearcoat),
                    });
                    self.uniforms.push(Uniform {
                        name: "u_clearcoatRoughness",
                        value: UniformValue::Float(material_desc.clearcoat_roughness),
                    });
                    let mat = self.materials.get(mr.material.0 as usize).copied();
                    let color = mat
                        .map(|m| m.desc.base_color)
                        .unwrap_or([0.8, 0.8, 0.8, 1.0]);
                    albedo_tex = mat.and_then(|m| m.desc.base_color_texture);
                    self.uniforms.push(Uniform {
                        name: "u_color",
                        value: UniformValue::Vec4(color),
                    });
                    self.uniforms.push(Uniform {
                        name: "u_hasTex",
                        value: UniformValue::Int(if albedo_tex.is_some() { 1 } else { 0 }),
                    });
                    self.uniforms.push(Uniform {
                        name: "u_aoTex",
                        value: UniformValue::Sampler(2),
                    });
                    self.uniforms.push(Uniform {
                        name: "u_emissiveTex",
                        value: UniformValue::Sampler(3),
                    });
                    self.uniforms.push(Uniform {
                        name: "u_hasAoTex",
                        value: UniformValue::Int(material_desc.occlusion_texture.is_some() as i32),
                    });
                    self.uniforms.push(Uniform {
                        name: "u_hasEmissiveTex",
                        value: UniformValue::Int(material_desc.emissive_texture.is_some() as i32),
                    });
                    self.uniforms.push(Uniform {
                        name: "u_aoStrength",
                        value: UniformValue::Float(
                            material_desc.occlusion_strength.clamp(0.0, 1.0),
                        ),
                    });
                    self.uniforms.push(Uniform {
                        name: "u_aoIntensity",
                        value: UniformValue::Float(self.settings.ao_intensity),
                    });
                    self.uniforms.push(Uniform {
                        name: "u_emissiveFactor",
                        value: UniformValue::Vec3(material_desc.emissive_factor),
                    });
                    self.uniforms.push(Uniform {
                        name: "u_emissiveStrength",
                        value: UniformValue::Float(
                            material_desc.emissive_strength * self.settings.emissive_scalar,
                        ),
                    });
                    gpu.bind_texture(2, material_desc.occlusion_texture.unwrap_or(self.white_tex));
                    gpu.bind_texture(3, material_desc.emissive_texture.unwrap_or(self.black_tex));
                    self.uniforms.push(Uniform {
                        name: "u_pointCount",
                        value: UniformValue::Int(self.forward_lights.len() as i32),
                    });
                }
                DrawMode::GBuffer => {
                    if let Some(terrain) = material_desc.terrain {
                        albedo_tex = Some(terrain.control_texture);
                        self.uniforms.push(Uniform {
                            name: "u_terrainControl",
                            value: UniformValue::Sampler(0),
                        });
                        self.uniforms.push(Uniform {
                            name: "u_terrainAlbedo",
                            value: UniformValue::Sampler(1),
                        });
                        self.uniforms.push(Uniform {
                            name: "u_terrainNrma",
                            value: UniformValue::Sampler(2),
                        });
                        self.uniforms.push(Uniform {
                            name: "u_terrainOrigin",
                            value: UniformValue::Vec2(terrain.world_origin),
                        });
                        self.uniforms.push(Uniform {
                            name: "u_terrainWorldSize",
                            value: UniformValue::Float(terrain.world_size),
                        });
                        self.uniforms.push(Uniform {
                            name: "u_terrainBiome",
                            value: UniformValue::Int(terrain.biome),
                        });
                        self.uniforms.push(Uniform {
                            name: "u_terrainTileScale",
                            value: UniformValue::Float(terrain.tile_scale),
                        });
                        self.uniforms.push(Uniform {
                            name: "u_terrainNormalStrength",
                            value: UniformValue::Float(terrain.normal_strength),
                        });
                        self.uniforms.push(Uniform {
                            name: "u_camEye",
                            value: UniformValue::Vec3([camera_eye.x, camera_eye.y, camera_eye.z]),
                        });
                        gpu.bind_texture_array(1, terrain.albedo_tiles);
                        gpu.bind_texture_array(2, terrain.nrma_tiles);
                    } else {
                        let mat = self.materials.get(mr.material.0 as usize).copied();
                        let color = mat
                            .map(|m| m.desc.base_color)
                            .unwrap_or([0.8, 0.8, 0.8, 1.0]);
                        albedo_tex = mat.and_then(|m| m.desc.base_color_texture);
                        let metallic = mat.map(|m| m.desc.metallic).unwrap_or(1.0);
                        let roughness = mat.map(|m| m.desc.roughness).unwrap_or(1.0);
                        self.uniforms.push(Uniform {
                            name: "u_color",
                            value: UniformValue::Vec4(color),
                        });
                        self.uniforms.push(Uniform {
                            name: "u_hasTex",
                            value: UniformValue::Int(if albedo_tex.is_some() { 1 } else { 0 }),
                        });
                        self.uniforms.push(Uniform {
                            name: "u_metallic",
                            value: UniformValue::Float(metallic),
                        });
                        self.uniforms.push(Uniform {
                            name: "u_roughness",
                            value: UniformValue::Float(roughness),
                        });
                        let desc = mat.map(|material| material.desc).unwrap_or_default();
                        let texture_uniforms = [
                            ("u_mrTex", desc.metallic_roughness_texture, 1),
                            ("u_normalTex", desc.normal_texture, 2),
                            ("u_aoTex", desc.occlusion_texture, 3),
                            ("u_emissiveTex", desc.emissive_texture, 4),
                        ];
                        for (name, texture, slot) in texture_uniforms {
                            self.uniforms.push(Uniform {
                                name,
                                value: UniformValue::Sampler(slot),
                            });
                            let fallback = match slot {
                                2 => self.normal_tex,
                                4 => self.black_tex,
                                _ => self.white_tex,
                            };
                            gpu.bind_texture(slot as u32, texture.unwrap_or(fallback));
                        }
                        self.uniforms.push(Uniform {
                            name: "u_hasMrTex",
                            value: UniformValue::Int(
                                desc.metallic_roughness_texture.is_some() as i32
                            ),
                        });
                        self.uniforms.push(Uniform {
                            name: "u_hasNormalTex",
                            value: UniformValue::Int(desc.normal_texture.is_some() as i32),
                        });
                        self.uniforms.push(Uniform {
                            name: "u_hasAoTex",
                            value: UniformValue::Int(desc.occlusion_texture.is_some() as i32),
                        });
                        self.uniforms.push(Uniform {
                            name: "u_hasEmissiveTex",
                            value: UniformValue::Int(desc.emissive_texture.is_some() as i32),
                        });
                        self.uniforms.push(Uniform {
                            name: "u_normalScale",
                            value: UniformValue::Float(desc.normal_scale),
                        });
                        // Keep authored occlusion/emission in the G-buffer.
                        // Their global mastering controls are applied once in
                        // the deferred lighting pass, not baked into the
                        // material and multiplied a second time.
                        self.uniforms.push(Uniform {
                            name: "u_aoStrength",
                            value: UniformValue::Float(desc.occlusion_strength.clamp(0.0, 1.0)),
                        });
                        self.uniforms.push(Uniform {
                            name: "u_emissiveFactor",
                            value: UniformValue::Vec3(desc.emissive_factor),
                        });
                        self.uniforms.push(Uniform {
                            name: "u_emissiveStrength",
                            value: UniformValue::Float(desc.emissive_strength),
                        });
                        self.uniforms.push(Uniform {
                            name: "u_clearcoat",
                            value: UniformValue::Float(desc.clearcoat),
                        });
                        self.uniforms.push(Uniform {
                            name: "u_clearcoatRoughness",
                            value: UniformValue::Float(desc.clearcoat_roughness),
                        });
                        let ior = desc.ior.max(1.0);
                        let ratio = (ior - 1.0) / (ior + 1.0);
                        self.uniforms.push(Uniform {
                            name: "u_dielectricF0",
                            value: UniformValue::Float(ratio * ratio * desc.specular),
                        });
                        self.uniforms.push(Uniform {
                            name: "u_alphaCutoff",
                            value: UniformValue::Float(if desc.blend {
                                0.0
                            } else {
                                desc.alpha_cutoff
                            }),
                        });
                    }
                }
            }
            gpu.set_uniforms(&self.uniforms);
            let albedo = albedo_tex.unwrap_or(self.white_tex);
            gpu.bind_texture(
                if matches!(mode, DrawMode::GBuffer) {
                    0
                } else {
                    1
                },
                albedo,
            );
            if mesh.skinned {
                let o = mr.skin.offset as usize;
                let c = mr.skin.count as usize;
                let Some(end) = o.checked_add(c) else {
                    continue;
                };
                if c == 0 || end > self.skin_arena.len() {
                    continue;
                }
                gpu.set_joints(&self.skin_arena[o..end]);
            }
            gpu.draw(mesh.vbo, Some(mesh.ebo), &mesh.layout, mesh.index_count);
        }
    }

    fn draw_instance_batches<G: Gpu>(
        &mut self,
        gpu: &mut G,
        mode: DrawMode,
        viewport_id: u8,
        view_proj: [f32; 16],
        camera_eye: Vec3,
    ) {
        if !matches!(mode, DrawMode::Depth | DrawMode::GBuffer) {
            return;
        }
        for index in 0..self.instance_batches.len() {
            let batch = self.instance_batches[index];
            if batch.count == 0 || !visible_in(batch.viewport_mask, viewport_id) {
                continue;
            }
            if matches!(mode, DrawMode::GBuffer) && batch.max_distance > 0.0 {
                let delta = batch.center.sub(camera_eye);
                if delta.dot(delta) > batch.max_distance * batch.max_distance {
                    continue;
                }
            }
            let Some(mesh) = self.meshes.get(batch.mesh.0 as usize).copied() else {
                continue;
            };
            let Some(material) = self.materials.get(batch.material.0 as usize).copied() else {
                continue;
            };
            let desc = material.desc;
            let program = if matches!(mode, DrawMode::Depth) {
                self.instance_depth_prog
            } else {
                self.instance_gbuffer_prog
            };
            gpu.set_pipeline(
                program,
                &PipelineState {
                    depth_test: true,
                    depth_write: true,
                    cull: if desc.double_sided {
                        Cull::None
                    } else {
                        Cull::Back
                    },
                    color_write: matches!(mode, DrawMode::GBuffer),
                    blend: false,
                    additive: false,
                },
            );
            self.uniforms.clear();
            self.uniforms.push(Uniform {
                name: "u_model",
                value: UniformValue::Mat4(Mat4::IDENTITY.to_cols_array()),
            });
            if matches!(mode, DrawMode::Depth) {
                self.uniforms.push(Uniform {
                    name: "u_lightViewProj",
                    value: UniformValue::Mat4(view_proj),
                });
            } else {
                self.uniforms.push(Uniform {
                    name: "u_viewProj",
                    value: UniformValue::Mat4(view_proj),
                });
                self.uniforms.push(Uniform {
                    name: "u_hasVertexColor",
                    value: UniformValue::Int(0),
                });
                self.uniforms.push(Uniform {
                    name: "u_hasTangent",
                    value: UniformValue::Int(0),
                });
                self.uniforms.push(Uniform {
                    name: "u_color",
                    value: UniformValue::Vec4(desc.base_color),
                });
                self.uniforms.push(Uniform {
                    name: "u_metallic",
                    value: UniformValue::Float(desc.metallic),
                });
                self.uniforms.push(Uniform {
                    name: "u_roughness",
                    value: UniformValue::Float(desc.roughness),
                });
                self.uniforms.push(Uniform {
                    name: "u_clearcoat",
                    value: UniformValue::Float(desc.clearcoat),
                });
                self.uniforms.push(Uniform {
                    name: "u_clearcoatRoughness",
                    value: UniformValue::Float(desc.clearcoat_roughness),
                });
                let ior = desc.ior.max(1.0);
                let ratio = (ior - 1.0) / (ior + 1.0);
                self.uniforms.push(Uniform {
                    name: "u_dielectricF0",
                    value: UniformValue::Float(ratio * ratio * desc.specular),
                });
            }
            gpu.set_uniforms(&self.uniforms);
            gpu.draw_instanced(
                mesh.vbo,
                Some(mesh.ebo),
                &mesh.layout,
                mesh.index_count,
                batch.buffer,
                &INSTANCE_MAT4_LAYOUT,
                batch.count,
            );
        }
    }

    fn composite_pass<G: Gpu, W: RenderWorld>(
        &mut self,
        gpu: &mut G,
        world: &mut W,
        screen_w: u32,
        screen_h: u32,
    ) {
        self.comp_quads.clear();
        {
            let mut q = world.query1::<CompositeQuad>();
            while let Some((_, cq)) = q.next() {
                self.comp_quads.push(*cq);
            }
        }
        if self.comp_quads.is_empty() {
            return;
        }
        self.comp_quads.sort_by_key(|q| q.order);
        gpu.begin_pass(
            PassTarget::Screen,
            RectPx {
                x: 0,
                y: 0,
                w: screen_w as i32,
                h: screen_h as i32,
            },
            ClearSpec::default(),
        );
        gpu.set_pipeline(
            self.composite_prog,
            &PipelineState {
                depth_test: false,
                depth_write: false,
                cull: Cull::None,
                color_write: true,
                blend: false,
                additive: false,
            },
        );
        for i in 0..self.comp_quads.len() {
            let cq = self.comp_quads[i];
            self.quad.clear();
            push_quad_ndc(&mut self.quad, cq.rect);
            gpu.update_buffer(self.dyn_buf, f32_bytes(&self.quad));
            if let Some(tex) = gpu.render_target_color(cq.source) {
                gpu.bind_texture(0, tex);
            }
            self.uniforms.clear();
            self.uniforms.push(Uniform {
                name: "u_tex",
                value: UniformValue::Sampler(0),
            });
            gpu.set_uniforms(&self.uniforms);
            gpu.draw(self.dyn_buf, None, &QUAD_LAYOUT, 6);
        }
        gpu.end_pass();
    }

    fn text_pass<G: Gpu, W: RenderWorld>(
        &mut self,
        gpu: &mut G,
        world: &mut W,
        screen_w: u32,
        screen_h: u32,
    ) {
        // Cell size in NDC: ~9px wide, ~18px tall.
        let cell_w = 9.0 / screen_w as f32 * 2.0;
        let cell_h = 18.0 / screen_h as f32 * 2.0;
        let mut any = false;
        self.overlays.clear();
        {
            let mut q = world.query1::<TextOverlay>();
            while let Some((_, t)) = q.next() {
                self.overlays.push(*t);
            }
        }
        if self.overlays.is_empty() {
            return;
        }
        for i in 0..self.overlays.len() {
            let ov = self.overlays[i];
            self.quad.clear();
            let x_ndc = ov.pos.x * 2.0 - 1.0;
            let y_ndc = 1.0 - ov.pos.y * 2.0;
            let n =
                text::push_text_quads(ov.as_str(), x_ndc, y_ndc, cell_w, cell_h, &mut self.quad);
            if n == 0 {
                continue;
            }
            if !any {
                gpu.begin_pass(
                    PassTarget::Screen,
                    RectPx {
                        x: 0,
                        y: 0,
                        w: screen_w as i32,
                        h: screen_h as i32,
                    },
                    ClearSpec::default(),
                );
                gpu.set_pipeline(
                    self.text_prog,
                    &PipelineState {
                        depth_test: false,
                        depth_write: false,
                        cull: Cull::None,
                        color_write: true,
                        blend: false,
                        additive: false,
                    },
                );
                any = true;
            }
            gpu.update_buffer(self.dyn_buf, f32_bytes(&self.quad));
            let c = ov.rgba;
            self.uniforms.clear();
            self.uniforms.push(Uniform {
                name: "u_color",
                value: UniformValue::Vec4([
                    c[0] as f32 / 255.0,
                    c[1] as f32 / 255.0,
                    c[2] as f32 / 255.0,
                    c[3] as f32 / 255.0,
                ]),
            });
            gpu.set_uniforms(&self.uniforms);
            gpu.draw(self.dyn_buf, None, &QUAD_LAYOUT, n * 6);
        }
        if any {
            gpu.end_pass();
        }
    }
}

/// Mesh draw variant: shadow depth, forward RTT, deferred G-buffer, or scene transparency.
#[derive(Clone, Copy)]
enum DrawMode {
    Depth,
    Forward,
    GBuffer,
    Transparent,
}
static GBUFFER_FORMATS: [TextureFormat; 4] = [
    TextureFormat::Rgba8,
    TextureFormat::Rgba8,
    TextureFormat::Rgba8,
    TextureFormat::Rgba8,
];

const DEFAULT_LIGHT_DIR: Vec3 = Vec3 {
    x: -0.4,
    y: -1.0,
    z: -0.3,
};

/// Deferred target attachment format tables (`'static` for `MrtDesc::colors`).
static SCENE_HDR_FORMATS: [TextureFormat; 1] = [TextureFormat::Rgba16F];
static SCENE_LDR_FORMATS: [TextureFormat; 1] = [TextureFormat::Rgba8];

/// Fullscreen NDC quad (pos2, uv2) for deferred light/tonemap passes.
const FS_QUAD: [f32; 24] = [
    -1.0, -1.0, 0.0, 0.0, 1.0, -1.0, 1.0, 0.0, 1.0, 1.0, 1.0, 1.0, -1.0, -1.0, 0.0, 0.0, 1.0, 1.0,
    1.0, 1.0, -1.0, 1.0, 0.0, 1.0,
];

fn projection_matrix(p: Projection, aspect: f32) -> Mat4 {
    match p {
        Projection::Perspective { fovy, near, far } => Mat4::perspective(fovy, aspect, near, far),
        Projection::Ortho {
            half_height,
            near,
            far,
        } => {
            let hw = half_height * aspect;
            Mat4::ortho(-hw, hw, -half_height, half_height, near, far)
        }
    }
}

fn light_view_proj(dir: Vec3, center: Vec3, radius: f32, shadow_size: u32) -> [f32; 16] {
    let d = dir.normalize();
    let distance = radius * 2.0;
    let up_ref = if d.y.abs() > 0.99 {
        Vec3 {
            x: 0.0,
            y: 0.0,
            z: 1.0,
        }
    } else {
        Vec3::Y
    };
    // Texel-snap the center along the light's right/up axes to stabilize the map
    // (kills shadow shimmer as the camera moves).
    let right = d.cross(up_ref).normalize();
    let up = right.cross(d).normalize();
    let texel = 2.0 * radius / shadow_size as f32;
    let cr = center.dot(right);
    let cu = center.dot(up);
    let sr = libm::roundf(cr / texel) * texel;
    let su = libm::roundf(cu / texel) * texel;
    let center = center.add(right.scale(sr - cr)).add(up.scale(su - cu));
    let eye = center.sub(d.scale(distance));
    let view = Mat4::look_at(eye, center, up);
    let proj = Mat4::ortho(
        -radius,
        radius,
        -radius,
        radius,
        0.1,
        distance + radius * 2.0,
    );
    proj.mul(view).to_cols_array()
}

fn viewport_px(rect: RectNorm, w: u32, h: u32) -> RectPx {
    RectPx {
        x: (rect.x * w as f32) as i32,
        y: (rect.y * h as f32) as i32,
        w: (rect.w * w as f32) as i32,
        h: (rect.h * h as f32) as i32,
    }
}

/// RTT square side derived from the screen width bucket (256 for small screens).
fn rt_side(_screen_w: u32) -> i32 {
    256
}

fn push_quad_ndc(out: &mut Vec<f32>, rect: RectNorm) {
    let x0 = rect.x * 2.0 - 1.0;
    let y0 = rect.y * 2.0 - 1.0;
    let x1 = (rect.x + rect.w) * 2.0 - 1.0;
    let y1 = (rect.y + rect.h) * 2.0 - 1.0;
    out.extend_from_slice(&[x0, y0, 0.0, 0.0]);
    out.extend_from_slice(&[x1, y0, 1.0, 0.0]);
    out.extend_from_slice(&[x1, y1, 1.0, 1.0]);
    out.extend_from_slice(&[x0, y0, 0.0, 0.0]);
    out.extend_from_slice(&[x1, y1, 1.0, 1.0]);
    out.extend_from_slice(&[x0, y1, 0.0, 1.0]);
}

fn f32_bytes(s: &[f32]) -> &[u8] {
    // SAFETY: f32 has no padding/invalid bit patterns; reinterpreting as bytes
    // for GPU upload is sound and the lifetime is tied to `s`.
    unsafe { core::slice::from_raw_parts(s.as_ptr() as *const u8, core::mem::size_of_val(s)) }
}

fn mat4_bytes(matrices: &[[f32; 16]]) -> &[u8] {
    // SAFETY: arrays of f32 are contiguous and have no padding or invalid bit
    // patterns; the returned view cannot outlive `matrices`.
    unsafe {
        core::slice::from_raw_parts(
            matrices.as_ptr() as *const u8,
            core::mem::size_of_val(matrices),
        )
    }
}

fn u32_bytes(s: &[u32]) -> &[u8] {
    // SAFETY: as above for u32.
    unsafe { core::slice::from_raw_parts(s.as_ptr() as *const u8, core::mem::size_of_val(s)) }
}

/// Visibility rule exposed for tests and game code: does `mask` include `vp`?
pub fn visible_in(mask: u32, viewport_id: u8) -> bool {
    (mask & (1u32 << viewport_id)) != 0
}
