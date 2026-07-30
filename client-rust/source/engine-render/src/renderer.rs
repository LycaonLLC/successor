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
use crate::gpu::{
    BufferId, BufferUsage, ClearSpec, Cull, Filter, GpuCaps, Gpu, MrtDesc, PassTarget,
    PipelineState, ProgramId, RectPx, RenderTargetDesc, RenderTargetId, TextureDesc,
    TextureFormat, Uniform, UniformValue, MESH_LAYOUT, PARTICLE_LAYOUT,
    POINT_LIGHT_INSTANCE_LAYOUT, QUAD_LAYOUT, SKINNED_MESH_LAYOUT, UI_LAYOUT,
};
use crate::gi::{GiOccluder, GiVolume};
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
}

#[derive(Clone, Copy)]
struct Material {
    /// rgb + alpha; alpha < 1 triggers dithered transparency in the shader.
    color: [f32; 4],
    /// Optional albedo texture (terrain/props). Replaces `color` when present.
    tex: Option<crate::gpu::TextureId>,
    /// PBR metallic-roughness factors (deferred G-buffer).
    metallic: f32,
    roughness: f32,
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
    bloom: f32,
}

impl Default for Grade {
    fn default() -> Self {
        Self { bone_tint: [1.0, 1.0, 1.0], desaturate: 0.0, scene_darken: 1.0, black_lift: 0.0, bloom: 0.0 }
    }
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
    composite_prog: ProgramId,
    text_prog: ProgramId,
    // Deferred programs.
    gbuffer_prog: ProgramId,
    gbuffer_skinned_prog: ProgramId,
    light_prog: ProgramId,
    tonemap_prog: ProgramId,
    point_light_prog: ProgramId,
    inject_prog: ProgramId,
    shadow_rt: RenderTargetId,
    ui_prog: ProgramId,
    ui_buf: BufferId,
    ui_atlas: Option<crate::gpu::TextureId>,
    particle_prog: ProgramId,
    particle_buf: BufferId,
    particle_tex: Option<crate::gpu::TextureId>,
    shadow_size: u32,
    shadow_world_radius: f32,
    quality: RenderQuality,
    caps: GpuCaps,
    dyn_buf: BufferId,
    // Deferred screen targets (recreated on resize).
    gbuffer_rt: Option<SizedRt>,
    scene_rt: Option<SizedRt>,
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
    ambient: f32,
    grade: Grade,
    // reused scratch
    cameras: Vec<Camera>,
    comp_quads: Vec<CompositeQuad>,
    overlays: Vec<TextOverlay>,
    quad: Vec<f32>,
    uniforms: Vec<Uniform>,
    shadow_view_proj: [f32; 16],
    skin_arena: Vec<[f32; 16]>,
    fog_color: [f32; 3],
    fog_near: f32,
    fog_far: f32,
}

impl Renderer {
    pub fn new<G: Gpu>(gpu: &mut G, limits: RendererLimits) -> Self {
        let q = limits.quality;
        let mesh_prog = gpu.create_program(
            include_str!("../../../assets/shaders/mesh.vert"),
            include_str!("../../../assets/shaders/mesh.frag"),
        );
        let mesh_skinned_prog = gpu.create_program(
            include_str!("../../../assets/shaders/mesh_skinned.vert"),
            include_str!("../../../assets/shaders/mesh.frag"),
        );
        let depth_prog = gpu.create_program(
            include_str!("../../../assets/shaders/depth.vert"),
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
        let (taps, pcss, cones, spec) = match q {
            RenderQuality::Low => (4, 0, 0, 0),
            RenderQuality::Medium => (12, 0, 4, 0),
            RenderQuality::High => (16, 1, 6, 1),
        };
        let light_src = alloc::format!(
            "#define SHADOW_TAPS {}\n#define PCSS {}\n#define GI_CONES {}\n#define GI_SPECULAR {}\n{}",
            taps, pcss, cones, spec,
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
        let point_light_prog = gpu.create_program(
            include_str!("../../../assets/shaders/point_light.vert"),
            include_str!("../../../assets/shaders/point_light.frag"),
        );
        let inject_prog = gpu.create_program(
            include_str!("../../../assets/shaders/post.vert"),
            include_str!("../../../assets/shaders/voxel_inject.frag"),
        );
        let shadow_size = q.shadow_size();
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
        let gi = if q.gi_cones() > 0 { Some(GiVolume::new(gpu)) } else { None };
        let caps = gpu.caps();
        Self {
            mesh_prog,
            mesh_skinned_prog,
            depth_prog,
            composite_prog,
            text_prog,
            gbuffer_prog,
            gbuffer_skinned_prog,
            light_prog,
            tonemap_prog,
            point_light_prog,
            inject_prog,
            shadow_rt,
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
            scene_rt: None,
            exposure: 1.0,
            pl_vbo,
            pl_ebo,
            pl_index_count: pl_indices.len() as u32,
            pl_inst_buf,
            pl_scratch: Vec::with_capacity(256 * 8),
            gi,
            meshes: Vec::new(),
            materials: Vec::new(),
            ambient: 0.28,
            grade: Grade::default(),
            cameras: Vec::with_capacity(limits.max_cameras),
            comp_quads: Vec::with_capacity(limits.max_cameras),
            overlays: Vec::with_capacity(16),
            quad: Vec::with_capacity(limits.max_quad_floats),
            uniforms: Vec::with_capacity(24),
            shadow_view_proj: Mat4::IDENTITY.to_cols_array(),
            skin_arena: Vec::with_capacity(64 * 16),
            fog_color: [0.788, 0.678, 0.510],
            fog_near: 180.0,
            fog_far: 320.0,
        }
    }

    /// Upload the baked icon atlas (RGBA8; coverage in the alpha channel) that
    /// the UI pass samples. Call once at load.
    pub fn set_ui_atlas<G: Gpu>(&mut self, gpu: &mut G, width: u32, height: u32, rgba: &[u8]) {
        let tex = gpu.create_texture(
            &TextureDesc { width, height, format: TextureFormat::Rgba8, filter: Filter::Linear },
            Some(rgba),
        );
        self.ui_atlas = Some(tex);
    }

    /// Draw an immediate-mode UI vertex buffer (`UI_LAYOUT`, NDC) over the
    /// current framebuffer with alpha blending. `quads` is the quad count
    /// (`buf` holds `quads * 6 * 8` floats). No-op until an atlas is uploaded.
    pub fn render_ui<G: Gpu>(&mut self, gpu: &mut G, buf: &[f32], quads: u32, screen_w: u32, screen_h: u32) {
        if quads == 0 {
            return;
        }
        let atlas = match self.ui_atlas {
            Some(a) => a,
            None => return,
        };
        gpu.begin_pass(
            PassTarget::Screen,
            RectPx { x: 0, y: 0, w: screen_w as i32, h: screen_h as i32 },
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
        self.uniforms.push(Uniform { name: "u_atlas", value: UniformValue::Sampler(0) });
        gpu.set_uniforms(&self.uniforms);
        gpu.update_buffer(self.ui_buf, f32_bytes(buf));
        gpu.draw(self.ui_buf, None, &UI_LAYOUT, quads * 6);
        gpu.end_pass();
    }

    /// Upload the shared glow sprite (RGBA8) the particle pass samples.
    pub fn set_particle_atlas<G: Gpu>(&mut self, gpu: &mut G, width: u32, height: u32, rgba: &[u8]) {
        let tex = gpu.create_texture(
            &TextureDesc { width, height, format: TextureFormat::Rgba8, filter: Filter::Linear },
            Some(rgba),
        );
        self.particle_tex = Some(tex);
    }

    /// Draw a world-space particle billboard buffer (`PARTICLE_LAYOUT`) over the
    /// current screen framebuffer, depth-testing against the scene but not
    /// writing depth. `additive` selects the blend mode. No-op until a sprite is
    /// uploaded. `buf` holds `quads * 6 * 9` floats.
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
            RectPx { x: 0, y: 0, w: screen_w as i32, h: screen_h as i32 },
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
        self.uniforms.push(Uniform { name: "u_tex", value: UniformValue::Sampler(0) });
        self.uniforms.push(Uniform { name: "u_viewProj", value: UniformValue::Mat4(*view_proj) });
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
        bloom: f32,
    ) {
        self.grade = Grade { bone_tint, desaturate, scene_darken, black_lift, bloom };
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

    pub fn add_material(&mut self, rgba: [f32; 4]) -> crate::components::MaterialId {
        self.add_material_pbr(rgba, 0.0, 0.85)
    }

    /// Register a solid-color PBR material with explicit metallic/roughness.
    pub fn add_material_pbr(
        &mut self,
        rgba: [f32; 4],
        metallic: f32,
        roughness: f32,
    ) -> crate::components::MaterialId {
        self.materials.push(Material { color: rgba, tex: None, metallic, roughness });
        crate::components::MaterialId((self.materials.len() - 1) as u32)
    }

    /// Register an RGBA8 texture and a material sampling it (terrain/props).
    pub fn add_textured_material<G: Gpu>(
        &mut self,
        gpu: &mut G,
        width: u32,
        height: u32,
        rgba: &[u8],
        filter: crate::gpu::Filter,
    ) -> crate::components::MaterialId {
        self.add_textured_material_pbr(gpu, width, height, rgba, filter, 0.0, 0.85)
    }

    /// Textured PBR material with explicit metallic/roughness factors.
    #[allow(clippy::too_many_arguments)]
    pub fn add_textured_material_pbr<G: Gpu>(
        &mut self,
        gpu: &mut G,
        width: u32,
        height: u32,
        rgba: &[u8],
        filter: crate::gpu::Filter,
        metallic: f32,
        roughness: f32,
    ) -> crate::components::MaterialId {
        let tex = gpu.create_texture(
            &crate::gpu::TextureDesc { width, height, format: crate::gpu::TextureFormat::Rgba8, filter },
            Some(rgba),
        );
        self.materials.push(Material { color: [1.0, 1.0, 1.0, 1.0], tex: Some(tex), metallic, roughness });
        crate::components::MaterialId((self.materials.len() - 1) as u32)
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
    ) {
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

        // --- gather + sort cameras (copy out; keeps queries non-overlapping) ---
        self.cameras.clear();
        {
            let mut q = world.query1::<Camera>();
            while let Some((_, c)) = q.next() {
                self.cameras.push(*c);
            }
        }
        self.cameras.sort_by_key(|c| c.order);

        // --- shadow pass (texel-snapped ortho fit) ---
        let use_shadow = shadow_light.is_some();
        if let Some(light) = shadow_light {
            let center = self
                .cameras
                .iter()
                .find(|c| matches!(c.target, CamTarget::Screen(_)))
                .map(|c| c.look_at)
                .unwrap_or(Vec3::ZERO);
            self.shadow_view_proj =
                light_view_proj(light.dir, center, self.shadow_world_radius, self.shadow_size);
            gpu.begin_pass(
                PassTarget::RenderTarget(self.shadow_rt),
                RectPx { x: 0, y: 0, w: self.shadow_size as i32, h: self.shadow_size as i32 },
                ClearSpec { color: None, depth: Some(1.0) },
            );
            gpu.set_pipeline(
                self.depth_prog,
                &PipelineState {
                    depth_test: true,
                    depth_write: true,
                    cull: Cull::Front,
                    color_write: false,
                    blend: false,
                    additive: false,
                },
            );
            self.uniforms.clear();
            self.uniforms.push(Uniform {
                name: "u_lightViewProj",
                value: UniformValue::Mat4(self.shadow_view_proj),
            });
            gpu.set_uniforms(&self.uniforms);
            self.draw_all_meshes(gpu, world, DrawMode::Depth, 0, false);
            gpu.end_pass();
        }

        // The first screen camera (lowest order) renders deferred.
        let deferred_idx = self
            .cameras
            .iter()
            .position(|c| matches!(c.target, CamTarget::Screen(_)));

        if let Some(di) = deferred_idx {
            self.ensure_screen_targets(gpu, screen_w, screen_h);
            // --- VXGI update: recenter + amortized voxelize + sun injection ---
            if self.gi.is_some() {
                if let Some(depth_tex) = gpu.render_target_depth(self.shadow_rt) {
                    let look = self.cameras[di].look_at;
                    let ld = main_light.map(|l| l.dir).unwrap_or(DEFAULT_LIGHT_DIR);
                    let lc = main_light.map(|l| l.color).unwrap_or([1.0, 1.0, 1.0]);
                    let lvp = self.shadow_view_proj;
                    let inj = self.inject_prog;
                    if let Some(gi) = self.gi.as_mut() {
                        gi.recenter([look.x, look.y, look.z]);
                        gi.step_voxelize(gpu, 8);
                        gi.step_inject(gpu, inj, depth_tex, &lvp, [ld.x, ld.y, ld.z], lc, 16);
                    }
                }
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
    }

    /// (Re)create the G-buffer and HDR scene targets when missing or resized.
    fn ensure_screen_targets<G: Gpu>(&mut self, gpu: &mut G, w: u32, h: u32) {
        let need = self.gbuffer_rt.as_ref().map_or(true, |s| s.w != w || s.h != h);
        if !need {
            return;
        }
        if let Some(s) = self.gbuffer_rt.take() {
            gpu.delete_render_target(s.rt);
        }
        if let Some(s) = self.scene_rt.take() {
            gpu.delete_render_target(s.rt);
        }
        let gb = gpu.create_render_target_mrt(&MrtDesc {
            width: w,
            height: h,
            colors: &GBUFFER_FORMATS,
            depth: true,
        });
        let hdr = self.caps.half_float_target && self.quality != RenderQuality::Low;
        let scene_fmt: &'static [TextureFormat] = if hdr { &SCENE_HDR_FORMATS } else { &SCENE_LDR_FORMATS };
        let scene = gpu.create_render_target_mrt(&MrtDesc {
            width: w,
            height: h,
            colors: scene_fmt,
            depth: false,
        });
        self.exposure = if hdr { 1.0 } else { 0.25 };
        self.gbuffer_rt = Some(SizedRt { rt: gb, w, h });
        self.scene_rt = Some(SizedRt { rt: scene, w, h });
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
        _use_shadow: bool,
    ) {
        let rect = match cam.target {
            CamTarget::Screen(r) => r,
            _ => return,
        };
        let (gb_rt, scene_rt, gw, gh) = match (&self.gbuffer_rt, &self.scene_rt) {
            (Some(g), Some(s)) => (g.rt, s.rt, g.w, g.h),
            _ => return,
        };
        let vp = viewport_px(rect, screen_w, screen_h);
        let aspect = if vp.h != 0 { vp.w as f32 / vp.h as f32 } else { 1.0 };
        let view = Mat4::look_at(cam.eye, cam.look_at, cam.up);
        let proj = projection_matrix(cam.projection, aspect);
        let vp_mat = proj.mul(view);
        let view_proj = vp_mat.to_cols_array();
        let inv_view_proj = vp_mat.inverse().to_cols_array();
        let full = RectPx { x: 0, y: 0, w: gw as i32, h: gh as i32 };
        let ld = main_light.map(|l| l.dir).unwrap_or(DEFAULT_LIGHT_DIR);
        let lc = main_light.map(|l| l.color).unwrap_or([1.0, 1.0, 1.0]);

        // --- G-buffer pass (full target) ---
        let clear_color = cam.clear.color.unwrap_or([0.0, 0.0, 0.0, 1.0]);
        gpu.begin_pass(
            PassTarget::RenderTarget(gb_rt),
            full,
            ClearSpec { color: Some(clear_color), depth: Some(1.0) },
        );
        gpu.set_pipeline(self.gbuffer_prog, &PipelineState::default());
        self.uniforms.clear();
        self.uniforms.push(Uniform { name: "u_viewProj", value: UniformValue::Mat4(view_proj) });
        self.uniforms.push(Uniform { name: "u_albedo", value: UniformValue::Sampler(0) });
        gpu.set_uniforms(&self.uniforms);
        self.draw_all_meshes(gpu, world, DrawMode::GBuffer, cam.viewport_id, false);
        gpu.set_pipeline(self.gbuffer_skinned_prog, &PipelineState::default());
        self.uniforms.clear();
        self.uniforms.push(Uniform { name: "u_viewProj", value: UniformValue::Mat4(view_proj) });
        self.uniforms.push(Uniform { name: "u_albedo", value: UniformValue::Sampler(0) });
        gpu.set_uniforms(&self.uniforms);
        self.draw_all_meshes(gpu, world, DrawMode::GBuffer, cam.viewport_id, true);
        gpu.end_pass();

        // --- deferred sun light pass → HDR scene target ---
        gpu.begin_pass(
            PassTarget::RenderTarget(scene_rt),
            full,
            ClearSpec { color: Some([0.0, 0.0, 0.0, 1.0]), depth: None },
        );
        gpu.set_pipeline(
            self.light_prog,
            &PipelineState { depth_test: false, depth_write: false, cull: Cull::None, color_write: true, blend: false, additive: false },
        );
        if let Some(t) = gpu.render_target_color_n(gb_rt, 0) { gpu.bind_texture(0, t); }
        if let Some(t) = gpu.render_target_color_n(gb_rt, 1) { gpu.bind_texture(1, t); }
        if let Some(t) = gpu.render_target_depth(gb_rt) { gpu.bind_texture(2, t); }
        if let Some(t) = gpu.render_target_depth(self.shadow_rt) { gpu.bind_texture(3, t); }
        let gi_origin = self.gi.as_ref().map(|g| g.origin()).unwrap_or([0.0, 0.0, 0.0]);
        if let Some(gi) = self.gi.as_ref() {
            gpu.bind_texture_3d(4, gi.radiance());
        }
        let world_texel = 2.0 * self.shadow_world_radius / self.shadow_size as f32;
        self.uniforms.clear();
        self.uniforms.push(Uniform { name: "u_gb0", value: UniformValue::Sampler(0) });
        self.uniforms.push(Uniform { name: "u_gb1", value: UniformValue::Sampler(1) });
        self.uniforms.push(Uniform { name: "u_depth", value: UniformValue::Sampler(2) });
        self.uniforms.push(Uniform { name: "u_shadowMap", value: UniformValue::Sampler(3) });
        self.uniforms.push(Uniform { name: "u_gi", value: UniformValue::Sampler(4) });
        self.uniforms.push(Uniform { name: "u_invViewProj", value: UniformValue::Mat4(inv_view_proj) });
        self.uniforms.push(Uniform { name: "u_lightViewProj", value: UniformValue::Mat4(self.shadow_view_proj) });
        self.uniforms.push(Uniform { name: "u_lightDir", value: UniformValue::Vec3([ld.x, ld.y, ld.z]) });
        self.uniforms.push(Uniform { name: "u_lightColor", value: UniformValue::Vec3(lc) });
        self.uniforms.push(Uniform { name: "u_camEye", value: UniformValue::Vec3([cam.eye.x, cam.eye.y, cam.eye.z]) });
        self.uniforms.push(Uniform { name: "u_ambient", value: UniformValue::Float(self.ambient) });
        self.uniforms.push(Uniform { name: "u_fogColor", value: UniformValue::Vec3(self.fog_color) });
        self.uniforms.push(Uniform { name: "u_fogNear", value: UniformValue::Float(self.fog_near) });
        self.uniforms.push(Uniform { name: "u_fogFar", value: UniformValue::Float(self.fog_far) });
        self.uniforms.push(Uniform { name: "u_shadowTexelUV", value: UniformValue::Float(1.0 / self.shadow_size as f32) });
        self.uniforms.push(Uniform { name: "u_shadowWorldTexel", value: UniformValue::Float(world_texel) });
        self.uniforms.push(Uniform { name: "u_sunPenumbraScale", value: UniformValue::Float(40.0) });
        self.uniforms.push(Uniform { name: "u_giOrigin", value: UniformValue::Vec3(gi_origin) });
        self.uniforms.push(Uniform { name: "u_giCell", value: UniformValue::Float(crate::gi::GI_CELL) });
        self.uniforms.push(Uniform { name: "u_giStrength", value: UniformValue::Float(1.4) });
        self.uniforms.push(Uniform { name: "u_exposure", value: UniformValue::Float(self.exposure) });
        gpu.set_uniforms(&self.uniforms);
        self.draw_fullscreen(gpu);
        gpu.end_pass();

        // --- point-light volumes (additive into the HDR scene target) ---
        self.point_light_pass(gpu, world, scene_rt, full, &view_proj, &inv_view_proj, cam.eye, gw, gh);

        // --- tonemap + grade → screen (restores scene depth for particles) ---
        gpu.begin_pass(PassTarget::Screen, vp, ClearSpec::default());
        gpu.set_pipeline(
            self.tonemap_prog,
            &PipelineState { depth_test: false, depth_write: true, cull: Cull::None, color_write: true, blend: false, additive: false },
        );
        if let Some(t) = gpu.render_target_color(scene_rt) { gpu.bind_texture(0, t); }
        if let Some(t) = gpu.render_target_depth(gb_rt) { gpu.bind_texture(1, t); }
        let g = self.grade;
        self.uniforms.clear();
        self.uniforms.push(Uniform { name: "u_scene", value: UniformValue::Sampler(0) });
        self.uniforms.push(Uniform { name: "u_depth", value: UniformValue::Sampler(1) });
        self.uniforms.push(Uniform { name: "u_boneTint", value: UniformValue::Vec3(g.bone_tint) });
        self.uniforms.push(Uniform { name: "u_desaturate", value: UniformValue::Float(g.desaturate) });
        self.uniforms.push(Uniform { name: "u_sceneDarken", value: UniformValue::Float(g.scene_darken) });
        self.uniforms.push(Uniform { name: "u_blackLift", value: UniformValue::Float(g.black_lift) });
        self.uniforms.push(Uniform { name: "u_bloom", value: UniformValue::Float(g.bloom) });
        self.uniforms.push(Uniform { name: "u_invExposure", value: UniformValue::Float(1.0 / self.exposure) });
        gpu.set_uniforms(&self.uniforms);
        self.draw_fullscreen(gpu);
        gpu.end_pass();
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
                    tr.pos.x, tr.pos.y, tr.pos.z, pl.radius,
                    pl.color[0], pl.color[1], pl.color[2], pl.intensity,
                ]);
                count += 1;
            }
        }
        if count == 0 {
            return;
        }
        gpu.begin_pass(PassTarget::RenderTarget(scene_rt), full, ClearSpec::default());
        gpu.set_pipeline(
            self.point_light_prog,
            &PipelineState { depth_test: false, depth_write: false, cull: Cull::Front, color_write: true, blend: true, additive: true },
        );
        if let Some(t) = gpu.render_target_color_n(self.gbuffer_rt.as_ref().unwrap().rt, 0) { gpu.bind_texture(0, t); }
        if let Some(t) = gpu.render_target_color_n(self.gbuffer_rt.as_ref().unwrap().rt, 1) { gpu.bind_texture(1, t); }
        if let Some(t) = gpu.render_target_depth(self.gbuffer_rt.as_ref().unwrap().rt) { gpu.bind_texture(2, t); }
        self.uniforms.clear();
        self.uniforms.push(Uniform { name: "u_viewProj", value: UniformValue::Mat4(*view_proj) });
        self.uniforms.push(Uniform { name: "u_invViewProj", value: UniformValue::Mat4(*inv_view_proj) });
        self.uniforms.push(Uniform { name: "u_gb0", value: UniformValue::Sampler(0) });
        self.uniforms.push(Uniform { name: "u_gb1", value: UniformValue::Sampler(1) });
        self.uniforms.push(Uniform { name: "u_depth", value: UniformValue::Sampler(2) });
        self.uniforms.push(Uniform { name: "u_camEye", value: UniformValue::Vec3([cam_eye.x, cam_eye.y, cam_eye.z]) });
        self.uniforms.push(Uniform { name: "u_screenSize", value: UniformValue::Vec4([gw as f32, gh as f32, 0.0, 0.0]) });
        self.uniforms.push(Uniform { name: "u_exposure", value: UniformValue::Float(self.exposure) });
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
                RectPx { x: 0, y: 0, w: rt_side(screen_w), h: rt_side(screen_w) },
            ),
        };
        let aspect = if vp.h != 0 { vp.w as f32 / vp.h as f32 } else { 1.0 };
        let view = Mat4::look_at(cam.eye, cam.look_at, cam.up);
        let proj = projection_matrix(cam.projection, aspect);
        let view_proj = proj.mul(view).to_cols_array();
        let ld = main_light.map(|l| l.dir).unwrap_or(DEFAULT_LIGHT_DIR);
        let lc = main_light.map(|l| l.color).unwrap_or([1.0, 1.0, 1.0]);

        gpu.begin_pass(target, vp, cam.clear);
        for (prog, skinned) in [(self.mesh_prog, false), (self.mesh_skinned_prog, true)] {
            gpu.set_pipeline(prog, &PipelineState::default());
            self.uniforms.clear();
            self.uniforms.push(Uniform { name: "u_viewProj", value: UniformValue::Mat4(view_proj) });
            self.uniforms.push(Uniform { name: "u_lightViewProj", value: UniformValue::Mat4(self.shadow_view_proj) });
            self.uniforms.push(Uniform { name: "u_lightDir", value: UniformValue::Vec3([ld.x, ld.y, ld.z]) });
            self.uniforms.push(Uniform { name: "u_lightColor", value: UniformValue::Vec3(lc) });
            self.uniforms.push(Uniform { name: "u_ambient", value: UniformValue::Float(self.ambient) });
            self.uniforms.push(Uniform { name: "u_shadowMap", value: UniformValue::Sampler(0) });
            self.uniforms.push(Uniform { name: "u_useShadow", value: UniformValue::Int(if use_shadow { 1 } else { 0 }) });
            self.uniforms.push(Uniform { name: "u_albedo", value: UniformValue::Sampler(1) });
            self.uniforms.push(Uniform { name: "u_camEye", value: UniformValue::Vec3([cam.eye.x, cam.eye.y, cam.eye.z]) });
            self.uniforms.push(Uniform { name: "u_fogColor", value: UniformValue::Vec3(self.fog_color) });
            self.uniforms.push(Uniform { name: "u_fogNear", value: UniformValue::Float(self.fog_near) });
            self.uniforms.push(Uniform { name: "u_fogFar", value: UniformValue::Float(self.fog_far) });
            gpu.set_uniforms(&self.uniforms);
            if let Some(depth_tex) = gpu.render_target_depth(self.shadow_rt) {
                gpu.bind_texture(0, depth_tex);
            }
            self.draw_all_meshes(gpu, world, DrawMode::Forward, cam.viewport_id, skinned);
        }
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
        world: &mut W,
        mode: DrawMode,
        viewport_id: u8,
        want_skinned: bool,
    ) {
        let visible_only = !matches!(mode, DrawMode::Depth);
        let mut q = world.query2::<MeshRenderer, Transform>();
        while let Some((_, mr, tr)) = q.next() {
            let mesh = match self.meshes.get(mr.mesh.0 as usize) {
                Some(m) => *m,
                None => continue,
            };
            if mesh.skinned != want_skinned {
                continue;
            }
            if visible_only && (mr.viewport_mask & (1u32 << viewport_id)) == 0 {
                continue;
            }
            let model = Mat4::from_trs(tr.pos, tr.rot, tr.scale).to_cols_array();
            self.uniforms.clear();
            self.uniforms.push(Uniform { name: "u_model", value: UniformValue::Mat4(model) });
            let mut albedo_tex = None;
            match mode {
                DrawMode::Depth => {}
                DrawMode::Forward => {
                    let mat = self.materials.get(mr.material.0 as usize).copied();
                    let color = mat.map(|m| m.color).unwrap_or([0.8, 0.8, 0.8, 1.0]);
                    albedo_tex = mat.and_then(|m| m.tex);
                    self.uniforms.push(Uniform { name: "u_color", value: UniformValue::Vec4(color) });
                    self.uniforms.push(Uniform {
                        name: "u_hasTex",
                        value: UniformValue::Int(if albedo_tex.is_some() { 1 } else { 0 }),
                    });
                }
                DrawMode::GBuffer => {
                    let mat = self.materials.get(mr.material.0 as usize).copied();
                    let color = mat.map(|m| m.color).unwrap_or([0.8, 0.8, 0.8, 1.0]);
                    albedo_tex = mat.and_then(|m| m.tex);
                    let metallic = mat.map(|m| m.metallic).unwrap_or(0.0);
                    let roughness = mat.map(|m| m.roughness).unwrap_or(0.85);
                    self.uniforms.push(Uniform { name: "u_color", value: UniformValue::Vec4(color) });
                    self.uniforms.push(Uniform {
                        name: "u_hasTex",
                        value: UniformValue::Int(if albedo_tex.is_some() { 1 } else { 0 }),
                    });
                    self.uniforms.push(Uniform { name: "u_metallic", value: UniformValue::Float(metallic) });
                    self.uniforms.push(Uniform { name: "u_roughness", value: UniformValue::Float(roughness) });
                }
            }
            gpu.set_uniforms(&self.uniforms);
            if let Some(tex) = albedo_tex {
                gpu.bind_texture(if matches!(mode, DrawMode::GBuffer) { 0 } else { 1 }, tex);
            }
            if want_skinned {
                let o = mr.skin.offset as usize;
                let c = mr.skin.count as usize;
                if c > 0 && o + c <= self.skin_arena.len() {
                    gpu.set_joints(&self.skin_arena[o..o + c]);
                }
                gpu.draw(mesh.vbo, Some(mesh.ebo), &SKINNED_MESH_LAYOUT, mesh.index_count);
            } else {
                gpu.draw(mesh.vbo, Some(mesh.ebo), &MESH_LAYOUT, mesh.index_count);
            }
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
            RectPx { x: 0, y: 0, w: screen_w as i32, h: screen_h as i32 },
            ClearSpec::default(),
        );
        gpu.set_pipeline(
            self.composite_prog,
            &PipelineState { depth_test: false, depth_write: false, cull: Cull::None, color_write: true, blend: false, additive: false },
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
            self.uniforms.push(Uniform { name: "u_tex", value: UniformValue::Sampler(0) });
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
            let n = text::push_text_quads(ov.as_str(), x_ndc, y_ndc, cell_w, cell_h, &mut self.quad);
            if n == 0 {
                continue;
            }
            if !any {
                gpu.begin_pass(
                    PassTarget::Screen,
                    RectPx { x: 0, y: 0, w: screen_w as i32, h: screen_h as i32 },
                    ClearSpec::default(),
                );
                gpu.set_pipeline(
                    self.text_prog,
                    &PipelineState { depth_test: false, depth_write: false, cull: Cull::None, color_write: true, blend: false, additive: false },
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

/// Mesh draw variant: shadow depth-only, forward lit (RTT), or deferred G-buffer.
#[derive(Clone, Copy)]
enum DrawMode {
    Depth,
    Forward,
    GBuffer,
}

const DEFAULT_LIGHT_DIR: Vec3 = Vec3 { x: -0.4, y: -1.0, z: -0.3 };

/// Deferred target attachment format tables (`'static` for `MrtDesc::colors`).
static GBUFFER_FORMATS: [TextureFormat; 2] = [TextureFormat::Rgba8, TextureFormat::Rgba8];
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
        Projection::Ortho { half_height, near, far } => {
            let hw = half_height * aspect;
            Mat4::ortho(-hw, hw, -half_height, half_height, near, far)
        }
    }
}

fn light_view_proj(dir: Vec3, center: Vec3, radius: f32, shadow_size: u32) -> [f32; 16] {
    let d = dir.normalize();
    let distance = radius * 2.0;
    let up_ref = if d.y.abs() > 0.99 { Vec3 { x: 0.0, y: 0.0, z: 1.0 } } else { Vec3::Y };
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
    let proj = Mat4::ortho(-radius, radius, -radius, radius, 0.1, distance + radius * 2.0);
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

fn u32_bytes(s: &[u32]) -> &[u8] {
    // SAFETY: as above for u32.
    unsafe { core::slice::from_raw_parts(s.as_ptr() as *const u8, core::mem::size_of_val(s)) }
}

/// Visibility rule exposed for tests and game code: does `mask` include `vp`?
pub fn visible_in(mask: u32, viewport_id: u8) -> bool {
    (mask & (1u32 << viewport_id)) != 0
}
