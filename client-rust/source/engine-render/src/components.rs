//! Renderer state expressed as ECS components.
//!
//! Every drawable/camera/light/overlay is an entity component, so the renderer
//! is "just systems over the world". The user-facing rule: an entity renders in
//! camera *C* iff its `viewport_mask` has bit `C.viewport_id` set — one entity
//! can appear in many viewports.
//!
//! Prefab-serializable components (`Transform`, `ModelRef`) carry asset *keys*
//! (strings); the projection layer resolves a `ModelRef` key to a concrete
//! `MeshRenderer` via `assets::AssetManifest` + the `Gpu`, mirroring how
//! `client-3d`'s `props.ts` keeps an `assetKey` and instances it lazily.

use alloc::string::{String, ToString};

use successor_engine_core::json::{Json, JsonWriter};
use successor_engine_core::math::{Quat, Vec2, Vec3};
use successor_engine_core::prefab::{PrefabComponent, PrefabError};
use successor_engine_core::{impl_component, math};

use crate::gpu::{ClearSpec, RenderTargetId};

/// Index into the renderer's mesh table (procedural or GLB-derived).
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct MeshId(pub u32);

/// Index into the renderer's material table.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct MaterialId(pub u32);

/// World transform (dense — most entities have one).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Transform {
    pub pos: Vec3,
    pub rot: Quat,
    pub scale: Vec3,
}

impl Default for Transform {
    fn default() -> Self {
        Self {
            pos: Vec3::ZERO,
            rot: Quat::IDENTITY,
            scale: Vec3::ONE,
        }
    }
}

/// Prefab-authored model reference by stable asset key. Resolved into a
/// `MeshRenderer` by the projection layer.
#[derive(Clone, PartialEq, Debug)]
pub struct ModelRef {
    pub key: String,
    pub viewport_mask: u32,
}

/// GPU-skinning binding: `count` joint matrices starting at `offset` in the
/// renderer's per-frame skin palette arena. `count == 0` means a static mesh.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct SkinRef {
    pub offset: u32,
    pub count: u32,
}

impl SkinRef {
    pub const NONE: SkinRef = SkinRef { offset: 0, count: 0 };
    pub fn is_skinned(&self) -> bool {
        self.count > 0
    }
}

/// Resolved drawable (runtime; not prefab-serialized).
#[derive(Clone, Copy, PartialEq, Debug, Default)]
pub struct MeshRenderer {
    pub mesh: MeshId,
    pub material: MaterialId,
    /// Bit *i* set => visible in the camera whose `viewport_id == i`.
    pub viewport_mask: u32,
    /// Skinning palette binding; `SkinRef::NONE` for static meshes.
    pub skin: SkinRef,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Projection {
    Perspective { fovy: f32, near: f32, far: f32 },
    /// Orthographic half-height in world units (width derived from aspect).
    Ortho { half_height: f32, near: f32, far: f32 },
}

/// Normalized screen rectangle in [0,1], origin bottom-left.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct RectNorm {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl RectNorm {
    pub const FULL: RectNorm = RectNorm { x: 0.0, y: 0.0, w: 1.0, h: 1.0 };
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum CamTarget {
    /// Render to (a sub-rectangle of) the screen.
    Screen(RectNorm),
    /// Render to an offscreen color+depth target (composited later).
    Texture(RenderTargetId),
}

/// A camera entity (sparse — few cameras).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Camera {
    pub viewport_id: u8,
    /// Lower renders first; composite/screen order follows this.
    pub order: i16,
    pub projection: Projection,
    pub target: CamTarget,
    pub clear: ClearSpec,
    pub eye: Vec3,
    pub look_at: Vec3,
    pub up: Vec3,
}

/// A directional light (sparse). The first shadow-casting light drives the
/// single shadow map.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct DirectionalLight {
    pub dir: Vec3,
    pub color: [f32; 3],
    pub cast_shadows: bool,
}

/// Draws a render target's color texture onto the screen (RTT compositing).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct CompositeQuad {
    pub source: RenderTargetId,
    pub rect: RectNorm,
    pub order: i16,
}

/// A screen-space text line (sparse). Fixed inline buffer => no per-overlay heap.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct TextOverlay {
    pub text: [u8; 128],
    pub len: u8,
    /// Top-left position in normalized screen coords [0,1].
    pub pos: Vec2,
    pub rgba: [u8; 4],
}

impl TextOverlay {
    pub fn new(s: &str, pos: Vec2, rgba: [u8; 4]) -> Self {
        let mut text = [0u8; 128];
        let bytes = s.as_bytes();
        let len = bytes.len().min(128);
        text[..len].copy_from_slice(&bytes[..len]);
        Self {
            text,
            len: len as u8,
            pos,
            rgba,
        }
    }

    pub fn as_str(&self) -> &str {
        core::str::from_utf8(&self.text[..self.len as usize]).unwrap_or("")
    }
}

impl_component!(Transform: dense);
impl_component!(ModelRef: sparse);
impl_component!(MeshRenderer: dense);
impl_component!(Camera: sparse);
impl_component!(DirectionalLight: sparse);
impl_component!(CompositeQuad: sparse);
impl_component!(TextOverlay: sparse);

// --- Prefab support (asset-key carrying components) --------------------------

fn read_vec3(v: &Json, fallback: Vec3) -> Vec3 {
    match v.as_array() {
        Some(a) if a.len() == 3 => math::vec3(
            a[0].as_f32().unwrap_or(fallback.x),
            a[1].as_f32().unwrap_or(fallback.y),
            a[2].as_f32().unwrap_or(fallback.z),
        ),
        _ => fallback,
    }
}

fn write_vec3(w: &mut JsonWriter, v: Vec3) {
    w.begin_array();
    w.value_f32(v.x);
    w.value_f32(v.y);
    w.value_f32(v.z);
    w.end_array();
}

impl PrefabComponent for Transform {
    const NAME: &'static str = "transform";

    fn from_json(v: &Json) -> Result<Self, PrefabError> {
        let pos = v.get("pos").map(|p| read_vec3(p, Vec3::ZERO)).unwrap_or(Vec3::ZERO);
        let scale = v.get("scale").map(|s| read_vec3(s, Vec3::ONE)).unwrap_or(Vec3::ONE);
        let rot = match v.get("rot").and_then(Json::as_array) {
            Some(a) if a.len() == 4 => Quat {
                x: a[0].as_f32().unwrap_or(0.0),
                y: a[1].as_f32().unwrap_or(0.0),
                z: a[2].as_f32().unwrap_or(0.0),
                w: a[3].as_f32().unwrap_or(1.0),
            }
            .normalize(),
            _ => Quat::IDENTITY,
        };
        Ok(Transform { pos, rot, scale })
    }

    fn to_json(&self, w: &mut JsonWriter) {
        w.begin_obj();
        w.key("pos");
        write_vec3(w, self.pos);
        w.key("rot");
        w.begin_array();
        w.value_f32(self.rot.x);
        w.value_f32(self.rot.y);
        w.value_f32(self.rot.z);
        w.value_f32(self.rot.w);
        w.end_array();
        w.key("scale");
        write_vec3(w, self.scale);
        w.end_obj();
    }
}

impl PrefabComponent for ModelRef {
    const NAME: &'static str = "model";

    fn from_json(v: &Json) -> Result<Self, PrefabError> {
        let key = v
            .get("key")
            .and_then(Json::as_str)
            .ok_or(PrefabError::BadComponent)?
            .to_string();
        let viewport_mask = v.get("viewportMask").and_then(Json::as_i64).unwrap_or(1) as u32;
        Ok(ModelRef { key, viewport_mask })
    }

    fn to_json(&self, w: &mut JsonWriter) {
        w.begin_obj();
        w.field_str("key", &self.key);
        w.field_i64("viewportMask", self.viewport_mask as i64);
        w.end_obj();
    }
}
