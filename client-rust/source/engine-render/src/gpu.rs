//! The GPU backend contract.
//!
//! `engine-render` is `no_std` and platform-free: it expresses every draw as
//! calls on this trait. The `platform` crate provides the single concrete
//! implementation (`GlGpu`) for the compiled target (desktop GL or WebGL2). The
//! renderer is generic `Renderer<G: Gpu>`, so calls monomorphize with no dynamic
//! dispatch. Handles are opaque `u32` newtypes minted by the backend.

#[cfg(feature = "std")]
use alloc::vec::Vec;

macro_rules! handle {
    ($name:ident) => {
        #[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
        pub struct $name(pub u32);
    };
}

handle!(BufferId);
handle!(ProgramId);
handle!(TextureId);
handle!(RenderTargetId);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BufferUsage {
    /// Uploaded once at load (mesh geometry).
    Static,
    /// Re-uploaded per frame (text/composite quads).
    Dynamic,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TextureFormat {
    Rgba8,
    Srgba8,
    R8,
    Rg8,
    /// 16-bit half-float RGBA (HDR scene accumulation target). Render-target
    /// only; `create_texture_3d`/`create_render_target_mrt` allocate it.
    Rgba16F,
    /// 32-bit depth (shadow map / RTT depth).
    Depth,
}

/// Backend capability probe (queried once at load).
#[derive(Clone, Copy, Debug)]
pub struct GpuCaps {
    /// A half-float (RGBA16F) color attachment can be rendered to.
    pub half_float_target: bool,
    pub max_color_attachments: u32,
    pub max_draw_buffers: u32,
}

impl Default for GpuCaps {
    fn default() -> Self {
        Self {
            half_float_target: false,
            max_color_attachments: 4,
            max_draw_buffers: 4,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GpuError {
    ShaderCompile,
    ProgramLink,
    IncompleteFramebuffer,
    InvalidResource,
}

/// A cubic 3D texture (`size` per axis). Used by the VXGI volumes.
#[derive(Clone, Copy, Debug)]
pub struct Texture3dDesc {
    pub size: u32,
    pub format: TextureFormat,
    /// Allocate a mip chain (radiance volume) with trilinear min filtering.
    pub mips: bool,
    /// Wrap X/Z for world-aligned toroidal volumes; Y always clamps.
    pub wrap_xz: bool,
}

/// A 2D texture array with equally sized RGBA8 layers.
#[derive(Clone, Copy, Debug)]
pub struct TextureArrayDesc {
    pub width: u32,
    pub height: u32,
    pub layers: u32,
    pub format: TextureFormat,
    pub mipmaps: bool,
}

/// Multi-render-target descriptor: `colors` lists the attachment formats
/// (`COLOR_ATTACHMENT0..`), `depth` allocates a sampleable D24.
#[derive(Clone, Copy, Debug)]
pub struct MrtDesc {
    pub width: u32,
    pub height: u32,
    pub colors: &'static [TextureFormat],
    pub depth: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Filter {
    Nearest,
    Linear,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MinFilter {
    Nearest,
    Linear,
    NearestMipmapNearest,
    LinearMipmapLinear,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Wrap {
    ClampToEdge,
    Repeat,
}

#[derive(Clone, Copy, Debug)]
pub struct TextureDesc {
    pub width: u32,
    pub height: u32,
    pub format: TextureFormat,
    pub mag_filter: Filter,
    pub min_filter: MinFilter,
    pub wrap_s: Wrap,
    pub wrap_t: Wrap,
    pub mipmaps: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct RenderTargetDesc {
    pub width: u32,
    pub height: u32,
    /// Allocate a sampleable color attachment (RTT cameras). Depth-only targets
    /// (shadow maps) set this false.
    pub color: bool,
    /// Allocate a sampleable depth attachment.
    pub depth: bool,
    pub filter: Filter,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PassTarget {
    Screen,
    RenderTarget(RenderTargetId),
}

/// Pixel rectangle (GL viewport convention: origin bottom-left).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct RectPx {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct ClearSpec {
    pub color: Option<[f32; 4]>,
    pub depth: Option<f32>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Cull {
    None,
    Back,
    Front,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PipelineState {
    pub depth_test: bool,
    pub depth_write: bool,
    pub cull: Cull,
    /// Draw only back faces of the depth pass to reduce shadow acne (front-face
    /// culling in the shadow pass). Ordinary passes use `cull` directly.
    pub color_write: bool,
    /// Enable alpha blending. Straight (src_alpha, 1-src_alpha) unless
    /// `additive`, which uses (src_alpha, one) for glow/spark accumulation.
    pub blend: bool,
    pub additive: bool,
}

impl Default for PipelineState {
    fn default() -> Self {
        Self {
            depth_test: true,
            depth_write: true,
            cull: Cull::Back,
            color_write: true,
            blend: false,
            additive: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ForwardLight {
    pub position: [f32; 3],
    pub radius: f32,
    pub color: [f32; 3],
    pub intensity: f32,
}

/// A shader uniform value. No UBOs in v1 — plain uniforms only.
#[derive(Clone, Copy, Debug)]
pub enum UniformValue {
    Float(f32),
    Vec3([f32; 3]),
    Vec2([f32; 2]),
    Vec4([f32; 4]),
    Mat4([f32; 16]),
    Int(i32),
    /// Texture unit index for a sampler uniform.
    Sampler(i32),
}

#[derive(Clone, Copy, Debug)]
pub struct Uniform {
    pub name: &'static str,
    pub value: UniformValue,
}

/// GPU scalar representation for one vertex attribute.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VertexFormat {
    F32,
    U8,
    U8Norm,
    U16Norm,
}

/// One vertex attribute: shader location, component count, representation, and byte offset.
#[derive(Clone, Copy, Debug)]
pub struct VertexAttr {
    pub location: u32,
    pub components: u32,
    pub format: VertexFormat,
    pub offset: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct VertexLayout {
    pub stride: u32,
    pub attrs: &'static [VertexAttr],
}

const fn f32_attr(location: u32, components: u32, offset: u32) -> VertexAttr {
    VertexAttr {
        location,
        components,
        format: VertexFormat::F32,
        offset,
    }
}

/// Interleaved `pos:3, normal:3, uv:2` — the mesh vertex format.
pub const MESH_LAYOUT: VertexLayout = VertexLayout {
    stride: 32,
    attrs: &[f32_attr(0, 3, 0), f32_attr(1, 3, 12), f32_attr(2, 2, 24)],
};

/// Interleaved `pos:2, uv:2` — composite/text quads in NDC.
pub const QUAD_LAYOUT: VertexLayout = VertexLayout {
    stride: 16,
    attrs: &[f32_attr(0, 2, 0), f32_attr(1, 2, 8)],
};

/// Interleaved `pos:2, uv:2, color:4` — immediate-mode UI quads in NDC.
pub const UI_LAYOUT: VertexLayout = VertexLayout {
    stride: 32,
    attrs: &[f32_attr(0, 2, 0), f32_attr(1, 2, 8), f32_attr(2, 4, 16)],
};

/// Interleaved `pos:3, uv:2, color:4` — world-space particle billboards.
pub const PARTICLE_LAYOUT: VertexLayout = VertexLayout {
    stride: 36,
    attrs: &[f32_attr(0, 3, 0), f32_attr(1, 2, 12), f32_attr(2, 4, 20)],
};

/// Legacy interleaved `pos:3, normal:3, uv:2, joints:4, weights:4`.
pub const SKINNED_MESH_LAYOUT: VertexLayout = VertexLayout {
    stride: 64,
    attrs: &[
        f32_attr(0, 3, 0),
        f32_attr(1, 3, 12),
        f32_attr(2, 2, 24),
        f32_attr(5, 4, 32),
        f32_attr(6, 4, 48),
    ],
};

/// Packed glTF static vertex with tangent and normalized U8 color.
pub const GLTF_MESH_LAYOUT: VertexLayout = VertexLayout {
    stride: 52,
    attrs: &[
        f32_attr(0, 3, 0),
        f32_attr(1, 3, 12),
        f32_attr(2, 2, 24),
        f32_attr(3, 4, 32),
        VertexAttr {
            location: 4,
            components: 4,
            format: VertexFormat::U8Norm,
            offset: 48,
        },
    ],
};

/// Packed glTF skinned vertex with U8 joints and normalized U16 weights.
pub const GLTF_SKINNED_MESH_LAYOUT: VertexLayout = VertexLayout {
    stride: 64,
    attrs: &[
        f32_attr(0, 3, 0),
        f32_attr(1, 3, 12),
        f32_attr(2, 2, 24),
        f32_attr(3, 4, 32),
        VertexAttr {
            location: 4,
            components: 4,
            format: VertexFormat::U8Norm,
            offset: 48,
        },
        VertexAttr {
            location: 5,
            components: 4,
            format: VertexFormat::U8,
            offset: 52,
        },
        VertexAttr {
            location: 6,
            components: 4,
            format: VertexFormat::U16Norm,
            offset: 56,
        },
    ],
};

/// Per-instance model matrix, four `vec4` columns at locations 7..=10.
pub const INSTANCE_MAT4_LAYOUT: VertexLayout = VertexLayout {
    stride: 64,
    attrs: &[
        f32_attr(7, 4, 0),
        f32_attr(8, 4, 16),
        f32_attr(9, 4, 32),
        f32_attr(10, 4, 48),
    ],
};

/// Per-instance point-light data (divisor 1): `pos_radius` = world xyz + radius,
/// `color_intensity` = linear rgb + intensity. Consumed by the deferred
/// point-light volume program.
pub const POINT_LIGHT_INSTANCE_LAYOUT: VertexLayout = VertexLayout {
    stride: 32,
    attrs: &[f32_attr(5, 4, 0), f32_attr(6, 4, 16)],
};

/// The backend contract. All resource creation happens at load; the per-frame
/// path is `begin_pass`/`set_pipeline`/`set_uniforms`/`bind_texture`/`draw`/
/// `end_pass` and allocates nothing on the Rust heap.
pub trait Gpu {
    fn create_buffer(&mut self, data: &[u8], usage: BufferUsage) -> BufferId;
    /// Create an index (element-array) buffer. WebGL2 fixes a buffer's target on
    /// first bind, so index buffers must be created bound to ELEMENT_ARRAY_BUFFER
    /// (a vertex buffer can't later be rebound as an index buffer). Backends that
    /// don't distinguish targets fall back to `create_buffer`.
    fn create_index_buffer(&mut self, data: &[u8], usage: BufferUsage) -> BufferId {
        self.create_buffer(data, usage)
    }
    fn update_buffer(&mut self, id: BufferId, data: &[u8]);
    fn create_program(&mut self, vert_src: &str, frag_src: &str) -> ProgramId;
    fn create_texture(&mut self, desc: &TextureDesc, data: Option<&[u8]>) -> TextureId;
    /// Replace a complete RGBA8/SRGBA8 2D texture at mip level zero.
    fn update_texture(&mut self, _id: TextureId, _desc: &TextureDesc, _data: &[u8]) {}
    /// Create a 2D texture array. Layer payloads are tightly packed in ascending order.
    fn create_texture_array(
        &mut self,
        _desc: &TextureArrayDesc,
        _data: Option<&[u8]>,
    ) -> TextureId {
        TextureId(0)
    }
    /// Bind a 2D texture array to a sampler slot.
    fn bind_texture_array(&mut self, _slot: u32, _tex: TextureId) {}
    fn create_render_target(&mut self, desc: &RenderTargetDesc) -> RenderTargetId;
    /// The sampleable color texture of a render target (RTT compositing).
    fn render_target_color(&self, rt: RenderTargetId) -> Option<TextureId>;
    /// The sampleable depth texture of a render target (shadow sampling).
    fn render_target_depth(&self, rt: RenderTargetId) -> Option<TextureId>;

    fn begin_pass(&mut self, target: PassTarget, viewport: RectPx, clear: ClearSpec);
    fn set_pipeline(&mut self, program: ProgramId, state: &PipelineState);
    fn set_uniforms(&mut self, uniforms: &[Uniform]);
    fn bind_texture(&mut self, slot: u32, tex: TextureId);
    fn draw(
        &mut self,
        vertices: BufferId,
        indices: Option<BufferId>,
        layout: &VertexLayout,
        count: u32,
    );
    /// Upload the joint palette (`u_joints` mat4 array) for the next skinned
    /// draw. Default no-op for backends that don't skin (tests/headless).
    fn set_joints(&mut self, _mats: &[[f32; 16]]) {}
    /// Upload nearest point lights for the active forward material program.
    fn set_forward_lights(&mut self, _lights: &[ForwardLight]) {}
    /// Instanced indexed draw: `instance_buf` holds one record per instance in
    /// `instance_layout` (attribute divisor 1); `layout` describes the shared
    /// vertex buffer. Default no-op; only the GL backend implements it.
    #[allow(clippy::too_many_arguments)]
    fn draw_instanced(
        &mut self,
        _vertices: BufferId,
        _indices: Option<BufferId>,
        _layout: &VertexLayout,
        _index_count: u32,
        _instance_buf: BufferId,
        _instance_layout: &VertexLayout,
        _instances: u32,
    ) {
    }
    /// Return and clear the first backend resource/program error.
    fn take_error(&mut self) -> Option<GpuError> {
        None
    }
    /// Backend capabilities (half-float target support). Queried once at load.
    fn caps(&self) -> GpuCaps {
        GpuCaps::default()
    }
    /// Create a cubic 3D texture (VXGI volume). `data`, if present, is the full
    /// `size^3 * 4` byte payload (RGBA8) uploaded at level 0.
    fn create_texture_3d(&mut self, _desc: &Texture3dDesc, _data: Option<&[u8]>) -> TextureId {
        TextureId(0)
    }
    /// Upload a tightly packed 3D subvolume at mip level zero.
    fn update_texture_3d_region(
        &mut self,
        _id: TextureId,
        _offset: [u32; 3],
        _extent: [u32; 3],
        _data: &[u8],
    ) {
    }
    /// Regenerate the mip chain of a 3D texture.
    fn generate_mipmaps_3d(&mut self, _id: TextureId) {}
    /// Bind a 3D texture to a sampler slot.
    fn bind_texture_3d(&mut self, _slot: u32, _tex: TextureId) {}
    /// Create a multi-render-target (deferred G-buffer / HDR scene target).
    fn create_render_target_mrt(&mut self, _desc: &MrtDesc) -> RenderTargetId {
        RenderTargetId(0)
    }
    /// The `index`-th sampleable color attachment of an MRT render target.
    fn render_target_color_n(&self, _rt: RenderTargetId, _index: usize) -> Option<TextureId> {
        None
    }
    /// Free an FBO and its attachments (G-buffer / scene RT recreation on resize).
    fn delete_render_target(&mut self, _rt: RenderTargetId) {}
    /// Block until submitted GPU work completes. Used only by opt-in timing.
    fn finish(&mut self) {}
    fn end_pass(&mut self);
}

/// A headless recording backend for unit tests. Records every call so tests can
/// assert pass ordering, cull decisions, and viewport math without a real GL
/// context. Available only with the `std` feature (tests/tools).
#[cfg(feature = "std")]
#[derive(Default)]
pub struct MockGpu {
    next: u32,
    pub log: Vec<MockCall>,
    pub error: Option<GpuError>,
    pub caps: GpuCaps,
}

#[cfg(feature = "std")]
#[derive(Clone, Debug, PartialEq)]
pub enum MockCall {
    BeginPass {
        target: PassTarget,
        viewport: RectPx,
    },
    SetPipeline {
        program: ProgramId,
        state: PipelineState,
    },
    UniformFloat {
        name: &'static str,
        value: f32,
    },
    Draw {
        count: u32,
    },
    DrawInstanced {
        instances: u32,
    },
    EndPass,
    CreateTexture3d,
    CreateTextureArray,
    UpdateTexture,
    UpdateTexture3dRegion {
        id: TextureId,
        offset: [u32; 3],
        extent: [u32; 3],
    },
    ForwardLights(Vec<ForwardLight>),
    GenMips3d,
    CreateMrt,
    DeleteRenderTarget,
}

#[cfg(feature = "std")]
impl MockGpu {
    fn mint(&mut self) -> u32 {
        self.next += 1;
        self.next
    }

    pub fn draw_calls(&self) -> usize {
        self.log
            .iter()
            .filter(|c| matches!(c, MockCall::Draw { .. }))
            .count()
    }

    pub fn pass_targets(&self) -> Vec<PassTarget> {
        self.log
            .iter()
            .filter_map(|c| match c {
                MockCall::BeginPass { target, .. } => Some(*target),
                _ => None,
            })
            .collect()
    }
}

#[cfg(feature = "std")]
impl Gpu for MockGpu {
    fn create_buffer(&mut self, _data: &[u8], _usage: BufferUsage) -> BufferId {
        BufferId(self.mint())
    }
    fn update_buffer(&mut self, _id: BufferId, _data: &[u8]) {}
    fn create_program(&mut self, _v: &str, _f: &str) -> ProgramId {
        ProgramId(self.mint())
    }
    fn create_texture(&mut self, _d: &TextureDesc, _data: Option<&[u8]>) -> TextureId {
        TextureId(self.mint())
    }
    fn update_texture(&mut self, _id: TextureId, _desc: &TextureDesc, _data: &[u8]) {
        self.log.push(MockCall::UpdateTexture);
    }
    fn create_texture_array(&mut self, _d: &TextureArrayDesc, _data: Option<&[u8]>) -> TextureId {
        self.log.push(MockCall::CreateTextureArray);
        TextureId(self.mint())
    }
    fn bind_texture_array(&mut self, _slot: u32, _tex: TextureId) {}
    fn create_render_target(&mut self, _d: &RenderTargetDesc) -> RenderTargetId {
        RenderTargetId(self.mint())
    }
    fn render_target_color(&self, rt: RenderTargetId) -> Option<TextureId> {
        Some(TextureId(rt.0 + 100_000))
    }
    fn render_target_depth(&self, rt: RenderTargetId) -> Option<TextureId> {
        Some(TextureId(rt.0 + 200_000))
    }
    fn begin_pass(&mut self, target: PassTarget, viewport: RectPx, _clear: ClearSpec) {
        self.log.push(MockCall::BeginPass { target, viewport });
    }
    fn set_pipeline(&mut self, program: ProgramId, state: &PipelineState) {
        self.log.push(MockCall::SetPipeline {
            program,
            state: *state,
        });
    }
    fn set_forward_lights(&mut self, lights: &[ForwardLight]) {
        self.log.push(MockCall::ForwardLights(lights.to_vec()));
    }
    fn set_uniforms(&mut self, uniforms: &[Uniform]) {
        for uniform in uniforms {
            if let UniformValue::Float(value) = uniform.value {
                self.log.push(MockCall::UniformFloat {
                    name: uniform.name,
                    value,
                });
            }
        }
    }
    fn bind_texture(&mut self, _slot: u32, _tex: TextureId) {}
    fn draw(&mut self, _v: BufferId, _i: Option<BufferId>, _l: &VertexLayout, count: u32) {
        self.log.push(MockCall::Draw { count });
    }
    fn draw_instanced(
        &mut self,
        _v: BufferId,
        _i: Option<BufferId>,
        _l: &VertexLayout,
        _index_count: u32,
        _instance_buf: BufferId,
        _instance_layout: &VertexLayout,
        instances: u32,
    ) {
        self.log.push(MockCall::DrawInstanced { instances });
    }
    fn take_error(&mut self) -> Option<GpuError> {
        self.error.take()
    }
    fn caps(&self) -> GpuCaps {
        self.caps
    }
    fn create_texture_3d(&mut self, _d: &Texture3dDesc, _data: Option<&[u8]>) -> TextureId {
        self.log.push(MockCall::CreateTexture3d);
        TextureId(self.mint())
    }
    fn update_texture_3d_region(
        &mut self,
        id: TextureId,
        offset: [u32; 3],
        extent: [u32; 3],
        _data: &[u8],
    ) {
        self.log
            .push(MockCall::UpdateTexture3dRegion { id, offset, extent });
    }
    fn generate_mipmaps_3d(&mut self, _id: TextureId) {
        self.log.push(MockCall::GenMips3d);
    }
    fn bind_texture_3d(&mut self, _slot: u32, _tex: TextureId) {}
    fn create_render_target_mrt(&mut self, _d: &MrtDesc) -> RenderTargetId {
        self.log.push(MockCall::CreateMrt);
        RenderTargetId(self.mint())
    }
    fn render_target_color_n(&self, rt: RenderTargetId, index: usize) -> Option<TextureId> {
        Some(TextureId(rt.0 + 100_000 + index as u32))
    }
    fn delete_render_target(&mut self, _rt: RenderTargetId) {
        self.log.push(MockCall::DeleteRenderTarget);
    }
    fn end_pass(&mut self) {
        self.log.push(MockCall::EndPass);
    }
}

/// A no-op backend for headless runtime gating: it runs the entire CPU render
/// path (ECS iteration, matrix math, draw-list/byte packing) while ignoring all
/// GPU work, so the alloc and frame-time gates need no window or GL driver.
/// `no_std`, always available.
#[derive(Default)]
pub struct NullGpu {
    next: u32,
}

impl NullGpu {
    fn mint(&mut self) -> u32 {
        self.next += 1;
        self.next
    }
}

impl Gpu for NullGpu {
    fn create_buffer(&mut self, _data: &[u8], _usage: BufferUsage) -> BufferId {
        BufferId(self.mint())
    }
    fn update_buffer(&mut self, _id: BufferId, _data: &[u8]) {}
    fn create_program(&mut self, _v: &str, _f: &str) -> ProgramId {
        ProgramId(self.mint())
    }
    fn create_texture(&mut self, _d: &TextureDesc, _data: Option<&[u8]>) -> TextureId {
        TextureId(self.mint())
    }
    fn create_render_target(&mut self, _d: &RenderTargetDesc) -> RenderTargetId {
        RenderTargetId(self.mint())
    }
    fn render_target_color(&self, rt: RenderTargetId) -> Option<TextureId> {
        Some(TextureId(rt.0))
    }
    fn render_target_depth(&self, rt: RenderTargetId) -> Option<TextureId> {
        Some(TextureId(rt.0))
    }
    fn begin_pass(&mut self, _t: PassTarget, _v: RectPx, _c: ClearSpec) {}
    fn set_pipeline(&mut self, _p: ProgramId, _s: &PipelineState) {}
    fn set_uniforms(&mut self, _u: &[Uniform]) {}
    fn bind_texture(&mut self, _slot: u32, _tex: TextureId) {}
    fn draw(&mut self, _v: BufferId, _i: Option<BufferId>, _l: &VertexLayout, _count: u32) {}
    fn create_texture_3d(&mut self, _d: &Texture3dDesc, _data: Option<&[u8]>) -> TextureId {
        TextureId(self.mint())
    }
    fn create_render_target_mrt(&mut self, _d: &MrtDesc) -> RenderTargetId {
        RenderTargetId(self.mint())
    }
    fn render_target_color_n(&self, rt: RenderTargetId, _index: usize) -> Option<TextureId> {
        Some(TextureId(rt.0))
    }
    fn end_pass(&mut self) {}
}
