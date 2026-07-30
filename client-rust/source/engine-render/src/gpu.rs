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
    /// 32-bit depth (shadow map / RTT depth).
    Depth,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Filter {
    Nearest,
    Linear,
}

#[derive(Clone, Copy, Debug)]
pub struct TextureDesc {
    pub width: u32,
    pub height: u32,
    pub format: TextureFormat,
    pub filter: Filter,
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

#[derive(Clone, Copy, Debug)]
pub struct PipelineState {
    pub depth_test: bool,
    pub depth_write: bool,
    pub cull: Cull,
    /// Draw only back faces of the depth pass to reduce shadow acne (front-face
    /// culling in the shadow pass). Ordinary passes use `cull` directly.
    pub color_write: bool,
}

impl Default for PipelineState {
    fn default() -> Self {
        Self {
            depth_test: true,
            depth_write: true,
            cull: Cull::Back,
            color_write: true,
        }
    }
}

/// A shader uniform value. No UBOs in v1 — plain uniforms only.
#[derive(Clone, Copy, Debug)]
pub enum UniformValue {
    Float(f32),
    Vec3([f32; 3]),
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

/// One vertex attribute: shader location, component count, byte offset.
#[derive(Clone, Copy, Debug)]
pub struct VertexAttr {
    pub location: u32,
    pub components: u32,
    pub offset: u32,
}

#[derive(Clone, Copy, Debug)]
pub struct VertexLayout {
    pub stride: u32,
    pub attrs: &'static [VertexAttr],
}

/// Interleaved `pos:3, normal:3, uv:2` — the mesh vertex format.
pub const MESH_LAYOUT: VertexLayout = VertexLayout {
    stride: 32,
    attrs: &[
        VertexAttr { location: 0, components: 3, offset: 0 },
        VertexAttr { location: 1, components: 3, offset: 12 },
        VertexAttr { location: 2, components: 2, offset: 24 },
    ],
};

/// Interleaved `pos:2, uv:2` — composite/text quads in NDC.
pub const QUAD_LAYOUT: VertexLayout = VertexLayout {
    stride: 16,
    attrs: &[
        VertexAttr { location: 0, components: 2, offset: 0 },
        VertexAttr { location: 1, components: 2, offset: 8 },
    ],
};

/// The backend contract. All resource creation happens at load; the per-frame
/// path is `begin_pass`/`set_pipeline`/`set_uniforms`/`bind_texture`/`draw`/
/// `end_pass` and allocates nothing on the Rust heap.
pub trait Gpu {
    fn create_buffer(&mut self, data: &[u8], usage: BufferUsage) -> BufferId;
    fn update_buffer(&mut self, id: BufferId, data: &[u8]);
    fn create_program(&mut self, vert_src: &str, frag_src: &str) -> ProgramId;
    fn create_texture(&mut self, desc: &TextureDesc, data: Option<&[u8]>) -> TextureId;
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
}

#[cfg(feature = "std")]
#[derive(Clone, Debug, PartialEq)]
pub enum MockCall {
    BeginPass { target: PassTarget, viewport: RectPx },
    Draw { count: u32 },
    EndPass,
}

#[cfg(feature = "std")]
impl MockGpu {
    fn mint(&mut self) -> u32 {
        self.next += 1;
        self.next
    }

    pub fn draw_calls(&self) -> usize {
        self.log.iter().filter(|c| matches!(c, MockCall::Draw { .. })).count()
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
    fn set_pipeline(&mut self, _p: ProgramId, _s: &PipelineState) {}
    fn set_uniforms(&mut self, _u: &[Uniform]) {}
    fn bind_texture(&mut self, _slot: u32, _tex: TextureId) {}
    fn draw(&mut self, _v: BufferId, _i: Option<BufferId>, _l: &VertexLayout, count: u32) {
        self.log.push(MockCall::Draw { count });
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
    fn end_pass(&mut self) {}
}
