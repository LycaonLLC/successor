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
    CamTarget, Camera, CompositeQuad, DirectionalLight, MeshRenderer, Projection, RectNorm,
    TextOverlay, Transform,
};
use crate::gpu::{
    BufferId, BufferUsage, ClearSpec, Cull, Filter, Gpu, PassTarget, PipelineState, ProgramId,
    RectPx, RenderTargetDesc, RenderTargetId, TextureDesc, TextureFormat, Uniform,
    UniformValue, MESH_LAYOUT, PARTICLE_LAYOUT, QUAD_LAYOUT, SKINNED_MESH_LAYOUT, UI_LAYOUT,
};
use crate::text;

/// Bounds every renderable world must satisfy. A world built with the `world!`
/// macro listing the render components implements this automatically.
pub trait RenderWorld:
    WorldOps
    + HasStorage<Transform>
    + HasStorage<MeshRenderer>
    + HasStorage<Camera>
    + HasStorage<DirectionalLight>
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
}

impl Default for RendererLimits {
    fn default() -> Self {
        Self {
            max_cameras: 16,
            max_draws: 8192,
            max_quad_floats: 64 * 1024,
            max_ui_floats: 256 * 1024,
            shadow_size: 2048,
            shadow_world_radius: 48.0,
        }
    }
}

pub struct Renderer {
    mesh_prog: ProgramId,
    mesh_skinned_prog: ProgramId,
    depth_prog: ProgramId,
    composite_prog: ProgramId,
    text_prog: ProgramId,
    shadow_rt: RenderTargetId,
    ui_prog: ProgramId,
    ui_buf: BufferId,
    ui_atlas: Option<crate::gpu::TextureId>,
    particle_prog: ProgramId,
    particle_buf: BufferId,
    particle_tex: Option<crate::gpu::TextureId>,
    post_prog: ProgramId,
    shadow_size: u32,
    shadow_world_radius: f32,
    dyn_buf: BufferId,
    meshes: Vec<MeshGpu>,
    materials: Vec<Material>,
    ambient: f32,
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
        let post_prog = gpu.create_program(
            include_str!("../../../assets/shaders/post.vert"),
            include_str!("../../../assets/shaders/post.frag"),
        );
        let shadow_rt = gpu.create_render_target(&RenderTargetDesc {
            width: limits.shadow_size,
            height: limits.shadow_size,
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
        Self {
            mesh_prog,
            mesh_skinned_prog,
            depth_prog,
            composite_prog,
            text_prog,
            shadow_rt,
            ui_prog,
            ui_buf,
        ui_atlas: None,
        particle_prog,
        particle_buf,
        particle_tex: None,
        post_prog,
            shadow_size: limits.shadow_size,
            shadow_world_radius: limits.shadow_world_radius,
            dyn_buf,
            meshes: Vec::new(),
            materials: Vec::new(),
            ambient: 0.28,
            cameras: Vec::with_capacity(limits.max_cameras),
            comp_quads: Vec::with_capacity(limits.max_cameras),
            overlays: Vec::with_capacity(16),
            quad: Vec::with_capacity(limits.max_quad_floats),
            uniforms: Vec::with_capacity(8),
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

    /// Full-screen PS2 color-grade pass: sample `src_tex` (the scene render
    /// target's color) and apply the environment grade to the screen. Draw the
    /// scene into an RTT first, then call this. `bone_tint` is linear rgb.
    #[allow(clippy::too_many_arguments)]
    pub fn render_post<G: Gpu>(
        &mut self,
        gpu: &mut G,
        src_tex: crate::gpu::TextureId,
        bone_tint: [f32; 3],
        desaturate: f32,
        scene_darken: f32,
        black_lift: f32,
        bloom: f32,
        screen_w: u32,
        screen_h: u32,
    ) {
        // Fullscreen NDC quad (pos2, uv2).
        self.quad.clear();
        self.quad.extend_from_slice(&[
            -1.0, -1.0, 0.0, 0.0, 1.0, -1.0, 1.0, 0.0, 1.0, 1.0, 1.0, 1.0,
            -1.0, -1.0, 0.0, 0.0, 1.0, 1.0, 1.0, 1.0, -1.0, 1.0, 0.0, 1.0,
        ]);
        gpu.begin_pass(
            PassTarget::Screen,
            RectPx { x: 0, y: 0, w: screen_w as i32, h: screen_h as i32 },
            ClearSpec::default(),
        );
        gpu.set_pipeline(
            self.post_prog,
            &PipelineState { depth_test: false, depth_write: false, cull: Cull::None, color_write: true, blend: false, additive: false },
        );
        gpu.bind_texture(0, src_tex);
        self.uniforms.clear();
        self.uniforms.push(Uniform { name: "u_scene", value: UniformValue::Sampler(0) });
        self.uniforms.push(Uniform { name: "u_boneTint", value: UniformValue::Vec3(bone_tint) });
        self.uniforms.push(Uniform { name: "u_desaturate", value: UniformValue::Float(desaturate) });
        self.uniforms.push(Uniform { name: "u_sceneDarken", value: UniformValue::Float(scene_darken) });
        self.uniforms.push(Uniform { name: "u_blackLift", value: UniformValue::Float(black_lift) });
        self.uniforms.push(Uniform { name: "u_bloom", value: UniformValue::Float(bloom) });
        gpu.set_uniforms(&self.uniforms);
        gpu.update_buffer(self.dyn_buf, f32_bytes(&self.quad));
        gpu.draw(self.dyn_buf, None, &QUAD_LAYOUT, 6);
        gpu.end_pass();
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
        let ebo = gpu.create_buffer(u32_bytes(indices), BufferUsage::Static);
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
        let ebo = gpu.create_buffer(u32_bytes(indices), BufferUsage::Static);
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
        self.materials.push(Material { color: rgba, tex: None });
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
        let tex = gpu.create_texture(
            &crate::gpu::TextureDesc { width, height, format: crate::gpu::TextureFormat::Rgba8, filter },
            Some(rgba),
        );
        self.materials.push(Material { color: [1.0, 1.0, 1.0, 1.0], tex: Some(tex) });
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

        // --- shadow pass ---
        let use_shadow = shadow_light.is_some();
        if let Some(light) = shadow_light {
            let center = self
                .cameras
                .iter()
                .find(|c| matches!(c.target, CamTarget::Screen(_)))
                .map(|c| c.look_at)
                .unwrap_or(Vec3::ZERO);
            self.shadow_view_proj = light_view_proj(light.dir, center, self.shadow_world_radius);
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
            gpu.set_pipeline(
                self.depth_prog,
                &PipelineState {
                    depth_test: true,
                    depth_write: true,
                    cull: Cull::Front, // front-face cull reduces shadow acne
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
            self.draw_all_meshes(gpu, world, ShadowMode::Depth, 0, false);
            gpu.end_pass();
        }

        // --- camera passes ---
        // Copy the camera list out of the scratch field so the borrow doesn't
        // conflict with the per-camera mesh queries.
        let cam_count = self.cameras.len();
        for ci in 0..cam_count {
            let cam = self.cameras[ci];
            let (target, vp) = match cam.target {
                CamTarget::Screen(rect) => (PassTarget::Screen, viewport_px(rect, screen_w, screen_h)),
                CamTarget::Texture(rt) => (
                    PassTarget::RenderTarget(rt),
                    // RTT viewport covers the whole target; size is the shadow
                    // convention reused (callers size RTs on creation).
                    RectPx { x: 0, y: 0, w: rt_side(screen_w), h: rt_side(screen_w) },
                ),
            };
            let aspect = if vp.h != 0 { vp.w as f32 / vp.h as f32 } else { 1.0 };
            let view = Mat4::look_at(cam.eye, cam.look_at, cam.up);
            let proj = projection_matrix(cam.projection, aspect);
            let view_proj = proj.mul(view).to_cols_array();

            gpu.begin_pass(target, vp, cam.clear);
            gpu.set_pipeline(self.mesh_prog, &PipelineState::default());

            // Global uniforms (persist per program in GL until changed).
            let ld = main_light.map(|l| l.dir).unwrap_or(Vec3 { x: -0.4, y: -1.0, z: -0.3 });
            let lc = main_light.map(|l| l.color).unwrap_or([1.0, 1.0, 1.0]);
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

            self.draw_all_meshes(gpu, world, ShadowMode::Lit, cam.viewport_id, false);

            // Skinned sub-pass: same globals, skinning program, joint palettes.
            gpu.set_pipeline(self.mesh_skinned_prog, &PipelineState::default());
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
            self.draw_all_meshes(gpu, world, ShadowMode::Lit, cam.viewport_id, true);
            gpu.end_pass();
        }

        // --- composite + text on screen ---
        self.composite_pass(gpu, world, screen_w, screen_h);
        self.text_pass(gpu, world, screen_w, screen_h);
    }

    fn draw_all_meshes<G: Gpu, W: RenderWorld>(
        &mut self,
        gpu: &mut G,
        world: &mut W,
        mode: ShadowMode,
        viewport_id: u8,
        want_skinned: bool,
    ) {
        let mut q = world.query2::<MeshRenderer, Transform>();
        while let Some((_, mr, tr)) = q.next() {
            let mesh = match self.meshes.get(mr.mesh.0 as usize) {
                Some(m) => *m,
                None => continue,
            };
            if mesh.skinned != want_skinned {
                continue;
            }
            if matches!(mode, ShadowMode::Lit) && (mr.viewport_mask & (1u32 << viewport_id)) == 0 {
                continue;
            }
            let model = Mat4::from_trs(tr.pos, tr.rot, tr.scale).to_cols_array();
            self.uniforms.clear();
            self.uniforms.push(Uniform { name: "u_model", value: UniformValue::Mat4(model) });
            let mut albedo_tex = None;
            if matches!(mode, ShadowMode::Lit) {
                let mat = self.materials.get(mr.material.0 as usize).copied();
                let color = mat.map(|m| m.color).unwrap_or([0.8, 0.8, 0.8, 1.0]);
                albedo_tex = mat.and_then(|m| m.tex);
                self.uniforms.push(Uniform { name: "u_color", value: UniformValue::Vec4(color) });
                self.uniforms.push(Uniform {
                    name: "u_hasTex",
                    value: UniformValue::Int(if albedo_tex.is_some() { 1 } else { 0 }),
                });
            }
            gpu.set_uniforms(&self.uniforms);
            if let Some(tex) = albedo_tex {
                gpu.bind_texture(1, tex);
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

#[derive(Clone, Copy)]
enum ShadowMode {
    Depth,
    Lit,
}

fn projection_matrix(p: Projection, aspect: f32) -> Mat4 {
    match p {
        Projection::Perspective { fovy, near, far } => Mat4::perspective(fovy, aspect, near, far),
        Projection::Ortho { half_height, near, far } => {
            let hw = half_height * aspect;
            Mat4::ortho(-hw, hw, -half_height, half_height, near, far)
        }
    }
}

fn light_view_proj(dir: Vec3, center: Vec3, radius: f32) -> [f32; 16] {
    let d = dir.normalize();
    let distance = radius * 2.0;
    let eye = center.sub(d.scale(distance));
    let up = if d.y.abs() > 0.99 { Vec3 { x: 0.0, y: 0.0, z: 1.0 } } else { Vec3::Y };
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
