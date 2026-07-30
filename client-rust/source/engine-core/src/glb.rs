//! Hand-rolled binary glTF (`.glb`) reader — the subset the Successor asset
//! corpus actually uses.
//!
//! Probed against the shipped assets: `extensionsUsed` is absent everywhere,
//! there are no embedded images (materials are `baseColorFactor` only), and the
//! single buffer is the GLB `BIN` chunk. So this reader supports exactly:
//! nodes (TRS or matrix), meshes with `POSITION`/`NORMAL`/`TEXCOORD_0`/
//! `JOINTS_0`/`WEIGHTS_0` and `u8`/`u16`/`u32` indices, `pbrMetallicRoughness.
//! baseColorFactor` + `doubleSided` + `alphaMode`/`alphaCutoff`, skins
//! (joints + inverse bind matrices), and animations with `LINEAR`/`STEP`
//! T/R/S channels. Everything else (sparse accessors, external/data-URI
//! buffers, Draco, `CUBICSPLINE`, interleaved-into-multiple-buffers) fails
//! closed with a typed [`GlbError`].
//!
//! `no_std` + `alloc`, no `core::fmt`.

use alloc::string::String;
use alloc::vec::Vec;

use crate::json::{Json, JsonError};
use crate::math::{vec3, Mat4, Quat, Vec3};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GlbError {
    BadMagic,
    BadVersion,
    BadChunk,
    MissingBin,
    Json(JsonError),
    /// A feature outside the supported subset (named for diagnostics).
    Unsupported(&'static str),
    /// An index or byte range pointed outside the file.
    OutOfRange,
    /// Accessor component/type combination we do not read.
    BadAccessor,
}

impl From<JsonError> for GlbError {
    fn from(e: JsonError) -> Self {
        GlbError::Json(e)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AlphaMode {
    Opaque,
    Mask,
    Blend,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Interp {
    Linear,
    Step,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ChannelPath {
    Translation,
    Rotation,
    Scale,
}

#[derive(Clone, Debug)]
pub struct GlbNode {
    pub name: Option<String>,
    pub translation: Vec3,
    pub rotation: Quat,
    pub scale: Vec3,
    pub children: Vec<usize>,
    pub mesh: Option<usize>,
    pub skin: Option<usize>,
}

impl GlbNode {
    /// Local TRS as a column-major matrix.
    pub fn local_matrix(&self) -> Mat4 {
        Mat4::from_trs(self.translation, self.rotation, self.scale)
    }
}

#[derive(Clone, Debug, Default)]
pub struct GlbPrimitive {
    pub positions: Vec<[f32; 3]>,
    pub normals: Vec<[f32; 3]>,
    pub uvs: Vec<[f32; 2]>,
    pub joints: Vec<[u16; 4]>,
    pub weights: Vec<[f32; 4]>,
    pub indices: Vec<u32>,
    pub material: Option<usize>,
}

#[derive(Clone, Debug, Default)]
pub struct GlbMesh {
    pub name: Option<String>,
    pub primitives: Vec<GlbPrimitive>,
}

#[derive(Clone, Debug)]
pub struct GlbMaterial {
    pub name: Option<String>,
    pub base_color: [f32; 4],
    pub metallic: f32,
    pub roughness: f32,
    pub double_sided: bool,
    pub alpha_mode: AlphaMode,
    pub alpha_cutoff: f32,
}

impl Default for GlbMaterial {
    fn default() -> Self {
        GlbMaterial {
            name: None,
            base_color: [1.0, 1.0, 1.0, 1.0],
            // Deliberate deviation from the glTF spec default (metallic=1,
            // roughness=1): shipped assets author only baseColorFactor, and a
            // metallic default of 1 would render them near-black. Non-metal,
            // fairly rough stylized surfaces are the correct fallback here.
            metallic: 0.0,
            roughness: 0.85,
            double_sided: false,
            alpha_mode: AlphaMode::Opaque,
            alpha_cutoff: 0.5,
        }
    }
}

#[derive(Clone, Debug)]
pub struct GlbSkin {
    pub joints: Vec<usize>,
    pub inverse_bind: Vec<Mat4>,
    pub skeleton_root: Option<usize>,
}

#[derive(Clone, Debug)]
pub struct GlbSampler {
    /// Keyframe times, seconds, ascending.
    pub input: Vec<f32>,
    /// Flat output values (3 per T/S key, 4 per R key).
    pub output: Vec<f32>,
    pub interp: Interp,
}

#[derive(Clone, Copy, Debug)]
pub struct GlbChannel {
    pub sampler: usize,
    pub target_node: usize,
    pub path: ChannelPath,
}

#[derive(Clone, Debug, Default)]
pub struct GlbAnimation {
    pub name: Option<String>,
    pub channels: Vec<GlbChannel>,
    pub samplers: Vec<GlbSampler>,
    pub duration: f32,
}

#[derive(Clone, Debug, Default)]
pub struct GlbDocument {
    pub nodes: Vec<GlbNode>,
    pub meshes: Vec<GlbMesh>,
    pub materials: Vec<GlbMaterial>,
    pub skins: Vec<GlbSkin>,
    pub animations: Vec<GlbAnimation>,
    /// Root node indices of the default scene (falls back to scene 0).
    pub scene_roots: Vec<usize>,
}

impl GlbDocument {
    pub fn animation_by_name(&self, name: &str) -> Option<&GlbAnimation> {
        self.animations
            .iter()
            .find(|a| a.name.as_deref() == Some(name))
    }
}

// ---------------------------------------------------------------------------
// Little-endian primitives
// ---------------------------------------------------------------------------

fn rd_u32(b: &[u8], o: usize) -> Result<u32, GlbError> {
    if o + 4 > b.len() {
        return Err(GlbError::OutOfRange);
    }
    Ok(b[o] as u32 | (b[o + 1] as u32) << 8 | (b[o + 2] as u32) << 16 | (b[o + 3] as u32) << 24)
}

fn rd_u16(b: &[u8], o: usize) -> Result<u16, GlbError> {
    if o + 2 > b.len() {
        return Err(GlbError::OutOfRange);
    }
    Ok(b[o] as u16 | (b[o + 1] as u16) << 8)
}

fn rd_f32(b: &[u8], o: usize) -> Result<f32, GlbError> {
    Ok(f32::from_bits(rd_u32(b, o)?))
}

// ---------------------------------------------------------------------------
// Accessor plumbing
// ---------------------------------------------------------------------------

const CT_I8: u32 = 5120;
const CT_U8: u32 = 5121;
const CT_I16: u32 = 5122;
const CT_U16: u32 = 5123;
const CT_U32: u32 = 5125;
const CT_F32: u32 = 5126;

fn comp_size(ct: u32) -> Result<usize, GlbError> {
    match ct {
        CT_I8 | CT_U8 => Ok(1),
        CT_I16 | CT_U16 => Ok(2),
        CT_U32 | CT_F32 => Ok(4),
        _ => Err(GlbError::BadAccessor),
    }
}

fn type_comps(t: &str) -> Result<usize, GlbError> {
    match t {
        "SCALAR" => Ok(1),
        "VEC2" => Ok(2),
        "VEC3" => Ok(3),
        "VEC4" => Ok(4),
        "MAT4" => Ok(16),
        _ => Err(GlbError::BadAccessor),
    }
}

/// A resolved accessor: where each element sits in `bin`, and how big it is.
struct AccessorView {
    offset: usize,
    stride: usize,
    count: usize,
    comp_type: u32,
    num_comps: usize,
}

fn u(v: &Json, key: &str) -> Option<usize> {
    v.get(key).and_then(Json::as_i64).map(|n| n as usize)
}

fn resolve_accessor(gltf: &Json, idx: usize, bin_len: usize) -> Result<AccessorView, GlbError> {
    let accessors = gltf
        .get("accessors")
        .and_then(Json::as_array)
        .ok_or(GlbError::BadAccessor)?;
    let acc = accessors.get(idx).ok_or(GlbError::OutOfRange)?;
    if acc.get("sparse").is_some() {
        return Err(GlbError::Unsupported("sparse accessor"));
    }
    let comp_type = u(acc, "componentType").ok_or(GlbError::BadAccessor)? as u32;
    let count = u(acc, "count").ok_or(GlbError::BadAccessor)?;
    let num_comps = type_comps(acc.get("type").and_then(Json::as_str).ok_or(GlbError::BadAccessor)?)?;
    let acc_off = u(acc, "byteOffset").unwrap_or(0);

    let bv_idx = u(acc, "bufferView").ok_or(GlbError::Unsupported("accessor without bufferView"))?;
    let views = gltf
        .get("bufferViews")
        .and_then(Json::as_array)
        .ok_or(GlbError::BadAccessor)?;
    let bv = views.get(bv_idx).ok_or(GlbError::OutOfRange)?;
    // Single-buffer contract: every bufferView must target buffer 0 (the BIN chunk).
    if u(bv, "buffer").unwrap_or(0) != 0 {
        return Err(GlbError::Unsupported("multi-buffer glb"));
    }
    let bv_off = u(bv, "byteOffset").unwrap_or(0);
    let elem = num_comps * comp_size(comp_type)?;
    let stride = u(bv, "byteStride").unwrap_or(elem);
    let offset = bv_off + acc_off;
    if count > 0 && offset + (count - 1) * stride + elem > bin_len {
        return Err(GlbError::OutOfRange);
    }
    Ok(AccessorView {
        offset,
        stride,
        count,
        comp_type,
        num_comps,
    })
}

/// Read one scalar component as f32 (only valid for float accessors).
fn read_floats(bin: &[u8], av: &AccessorView) -> Result<Vec<f32>, GlbError> {
    if av.comp_type != CT_F32 {
        return Err(GlbError::BadAccessor);
    }
    let mut out = Vec::with_capacity(av.count * av.num_comps);
    for i in 0..av.count {
        let base = av.offset + i * av.stride;
        for c in 0..av.num_comps {
            out.push(rd_f32(bin, base + c * 4)?);
        }
    }
    Ok(out)
}

fn chunk3(flat: &[f32]) -> Vec<[f32; 3]> {
    flat.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect()
}
fn chunk2(flat: &[f32]) -> Vec<[f32; 2]> {
    flat.chunks_exact(2).map(|c| [c[0], c[1]]).collect()
}
fn chunk4(flat: &[f32]) -> Vec<[f32; 4]> {
    flat.chunks_exact(4).map(|c| [c[0], c[1], c[2], c[3]]).collect()
}

fn read_indices(bin: &[u8], av: &AccessorView) -> Result<Vec<u32>, GlbError> {
    let mut out = Vec::with_capacity(av.count);
    for i in 0..av.count {
        let o = av.offset + i * av.stride;
        let v = match av.comp_type {
            CT_U8 => bin.get(o).copied().ok_or(GlbError::OutOfRange)? as u32,
            CT_U16 => rd_u16(bin, o)? as u32,
            CT_U32 => rd_u32(bin, o)?,
            _ => return Err(GlbError::BadAccessor),
        };
        out.push(v);
    }
    Ok(out)
}

fn read_joints(bin: &[u8], av: &AccessorView) -> Result<Vec<[u16; 4]>, GlbError> {
    if av.num_comps != 4 {
        return Err(GlbError::BadAccessor);
    }
    let mut out = Vec::with_capacity(av.count);
    for i in 0..av.count {
        let base = av.offset + i * av.stride;
        let mut j = [0u16; 4];
        for (c, slot) in j.iter_mut().enumerate() {
            *slot = match av.comp_type {
                CT_U8 => *bin.get(base + c).ok_or(GlbError::OutOfRange)? as u16,
                CT_U16 => rd_u16(bin, base + c * 2)?,
                _ => return Err(GlbError::BadAccessor),
            };
        }
        out.push(j);
    }
    Ok(out)
}

fn read_mat4s(bin: &[u8], av: &AccessorView) -> Result<Vec<Mat4>, GlbError> {
    if av.num_comps != 16 || av.comp_type != CT_F32 {
        return Err(GlbError::BadAccessor);
    }
    let mut out = Vec::with_capacity(av.count);
    for i in 0..av.count {
        let base = av.offset + i * av.stride;
        let mut m = [0.0f32; 16];
        for (c, slot) in m.iter_mut().enumerate() {
            *slot = rd_f32(bin, base + c * 4)?;
        }
        out.push(Mat4 { m });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Top-level parse
// ---------------------------------------------------------------------------

const GLB_MAGIC: u32 = 0x4654_6C67; // "glTF" little-endian
const CHUNK_JSON: u32 = 0x4E4F_534A; // "JSON"
const CHUNK_BIN: u32 = 0x004E_4942; // "BIN\0"

/// Parse a `.glb` byte blob into a [`GlbDocument`].
pub fn parse(bytes: &[u8]) -> Result<GlbDocument, GlbError> {
    if bytes.len() < 12 || rd_u32(bytes, 0)? != GLB_MAGIC {
        return Err(GlbError::BadMagic);
    }
    if rd_u32(bytes, 4)? != 2 {
        return Err(GlbError::BadVersion);
    }
    // Walk chunks.
    let mut pos = 12usize;
    let mut json_bytes: Option<&[u8]> = None;
    let mut bin_bytes: Option<&[u8]> = None;
    while pos + 8 <= bytes.len() {
        let clen = rd_u32(bytes, pos)? as usize;
        let ctype = rd_u32(bytes, pos + 4)?;
        let start = pos + 8;
        let end = start.checked_add(clen).ok_or(GlbError::BadChunk)?;
        if end > bytes.len() {
            return Err(GlbError::BadChunk);
        }
        match ctype {
            CHUNK_JSON => json_bytes = Some(&bytes[start..end]),
            CHUNK_BIN => bin_bytes = Some(&bytes[start..end]),
            _ => {}
        }
        // Chunks are 4-byte aligned.
        pos = end + ((4 - (clen & 3)) & 3);
    }
    let json_slice = json_bytes.ok_or(GlbError::BadChunk)?;
    let json_str = core::str::from_utf8(json_slice).map_err(|_| GlbError::BadChunk)?;
    let gltf = Json::parse(json_str.trim_end_matches(' '))?;

    if gltf.get("extensionsRequired").is_some() {
        return Err(GlbError::Unsupported("extensionsRequired"));
    }
    let bin = bin_bytes.unwrap_or(&[]);

    Ok(GlbDocument {
        nodes: parse_nodes(&gltf)?,
        meshes: parse_meshes(&gltf, bin)?,
        materials: parse_materials(&gltf),
        skins: parse_skins(&gltf, bin)?,
        animations: parse_animations(&gltf, bin)?,
        scene_roots: parse_scene_roots(&gltf),
    })
}

fn parse_nodes(gltf: &Json) -> Result<Vec<GlbNode>, GlbError> {
    let mut out = Vec::new();
    let Some(nodes) = gltf.get("nodes").and_then(Json::as_array) else {
        return Ok(out);
    };
    for n in nodes {
        let (t, r, s) = if let Some(m) = n.get("matrix").and_then(Json::as_array) {
            decompose_matrix(m)?
        } else {
            let t = read_vec3(n.get("translation"), Vec3::ZERO);
            let r = read_quat(n.get("rotation"));
            let s = read_vec3(n.get("scale"), Vec3::ONE);
            (t, r, s)
        };
        let children = n
            .get("children")
            .and_then(Json::as_array)
            .map(|a| a.iter().filter_map(|c| c.as_i64().map(|x| x as usize)).collect())
            .unwrap_or_default();
        out.push(GlbNode {
            name: n.get("name").and_then(Json::as_str).map(String::from),
            translation: t,
            rotation: r,
            scale: s,
            children,
            mesh: u(n, "mesh"),
            skin: u(n, "skin"),
        });
    }
    Ok(out)
}

fn read_vec3(v: Option<&Json>, fallback: Vec3) -> Vec3 {
    match v.and_then(Json::as_array) {
        Some(a) if a.len() >= 3 => vec3(
            a[0].as_f32().unwrap_or(fallback.x),
            a[1].as_f32().unwrap_or(fallback.y),
            a[2].as_f32().unwrap_or(fallback.z),
        ),
        _ => fallback,
    }
}

fn read_quat(v: Option<&Json>) -> Quat {
    match v.and_then(Json::as_array) {
        Some(a) if a.len() >= 4 => Quat {
            x: a[0].as_f32().unwrap_or(0.0),
            y: a[1].as_f32().unwrap_or(0.0),
            z: a[2].as_f32().unwrap_or(0.0),
            w: a[3].as_f32().unwrap_or(1.0),
        },
        _ => Quat::IDENTITY,
    }
}

/// Decompose a column-major TRS matrix into translation/rotation/scale.
fn decompose_matrix(m: &[Json]) -> Result<(Vec3, Quat, Vec3), GlbError> {
    if m.len() < 16 {
        return Err(GlbError::Unsupported("short node.matrix"));
    }
    let mut a = [0.0f32; 16];
    for (i, slot) in a.iter_mut().enumerate() {
        *slot = m[i].as_f32().ok_or(GlbError::Unsupported("bad node.matrix"))?;
    }
    let t = vec3(a[12], a[13], a[14]);
    // Column basis vectors.
    let c0 = vec3(a[0], a[1], a[2]);
    let c1 = vec3(a[4], a[5], a[6]);
    let c2 = vec3(a[8], a[9], a[10]);
    let s = vec3(c0.length(), c1.length(), c2.length());
    let r0 = if s.x > 1e-8 { c0.scale(1.0 / s.x) } else { c0 };
    let r1 = if s.y > 1e-8 { c1.scale(1.0 / s.y) } else { c1 };
    let r2 = if s.z > 1e-8 { c2.scale(1.0 / s.z) } else { c2 };
    let q = quat_from_basis(r0, r1, r2);
    Ok((t, q, s))
}

/// Rotation quaternion from three orthonormal basis columns.
fn quat_from_basis(x: Vec3, y: Vec3, z: Vec3) -> Quat {
    let trace = x.x + y.y + z.z;
    let q = if trace > 0.0 {
        let s = libm::sqrtf(trace + 1.0) * 2.0;
        Quat {
            w: 0.25 * s,
            x: (y.z - z.y) / s,
            y: (z.x - x.z) / s,
            z: (x.y - y.x) / s,
        }
    } else if x.x > y.y && x.x > z.z {
        let s = libm::sqrtf(1.0 + x.x - y.y - z.z) * 2.0;
        Quat {
            w: (y.z - z.y) / s,
            x: 0.25 * s,
            y: (y.x + x.y) / s,
            z: (z.x + x.z) / s,
        }
    } else if y.y > z.z {
        let s = libm::sqrtf(1.0 + y.y - x.x - z.z) * 2.0;
        Quat {
            w: (z.x - x.z) / s,
            x: (y.x + x.y) / s,
            y: 0.25 * s,
            z: (z.y + y.z) / s,
        }
    } else {
        let s = libm::sqrtf(1.0 + z.z - x.x - y.y) * 2.0;
        Quat {
            w: (x.y - y.x) / s,
            x: (z.x + x.z) / s,
            y: (z.y + y.z) / s,
            z: 0.25 * s,
        }
    };
    q.normalize()
}

fn parse_meshes(gltf: &Json, bin: &[u8]) -> Result<Vec<GlbMesh>, GlbError> {
    let mut out = Vec::new();
    let Some(meshes) = gltf.get("meshes").and_then(Json::as_array) else {
        return Ok(out);
    };
    for m in meshes {
        let mut mesh = GlbMesh {
            name: m.get("name").and_then(Json::as_str).map(String::from),
            primitives: Vec::new(),
        };
        let prims = m.get("primitives").and_then(Json::as_array).unwrap_or(&[]);
        for p in prims {
            if let Some(mode) = u(p, "mode") {
                if mode != 4 {
                    return Err(GlbError::Unsupported("non-triangle primitive"));
                }
            }
            let attrs = p.get("attributes").ok_or(GlbError::BadAccessor)?;
            let mut prim = GlbPrimitive {
                material: u(p, "material"),
                ..Default::default()
            };
            if let Some(i) = u(attrs, "POSITION") {
                prim.positions = chunk3(&read_floats(bin, &resolve_accessor(gltf, i, bin.len())?)?);
            }
            if let Some(i) = u(attrs, "NORMAL") {
                prim.normals = chunk3(&read_floats(bin, &resolve_accessor(gltf, i, bin.len())?)?);
            }
            if let Some(i) = u(attrs, "TEXCOORD_0") {
                prim.uvs = chunk2(&read_floats(bin, &resolve_accessor(gltf, i, bin.len())?)?);
            }
            if let Some(i) = u(attrs, "JOINTS_0") {
                prim.joints = read_joints(bin, &resolve_accessor(gltf, i, bin.len())?)?;
            }
            if let Some(i) = u(attrs, "WEIGHTS_0") {
                prim.weights = chunk4(&read_floats(bin, &resolve_accessor(gltf, i, bin.len())?)?);
            }
            if let Some(i) = u(p, "indices") {
                prim.indices = read_indices(bin, &resolve_accessor(gltf, i, bin.len())?)?;
            } else {
                // Non-indexed: synthesize a trivial index list.
                prim.indices = (0..prim.positions.len() as u32).collect();
            }
            mesh.primitives.push(prim);
        }
        out.push(mesh);
    }
    Ok(out)
}

fn parse_materials(gltf: &Json) -> Vec<GlbMaterial> {
    let mut out = Vec::new();
    let Some(mats) = gltf.get("materials").and_then(Json::as_array) else {
        return out;
    };
    for m in mats {
        let mut mat = GlbMaterial {
            name: m.get("name").and_then(Json::as_str).map(String::from),
            double_sided: m.get("doubleSided").and_then(Json::as_bool).unwrap_or(false),
            ..Default::default()
        };
        if let Some(pbr) = m.get("pbrMetallicRoughness") {
            if let Some(bc) = pbr.get("baseColorFactor").and_then(Json::as_array) {
                for (i, slot) in mat.base_color.iter_mut().enumerate() {
                    if let Some(v) = bc.get(i).and_then(Json::as_f32) {
                        *slot = v;
                    }
                }
            }
            if let Some(v) = pbr.get("metallicFactor").and_then(Json::as_f32) {
                mat.metallic = v;
            }
            if let Some(v) = pbr.get("roughnessFactor").and_then(Json::as_f32) {
                mat.roughness = v;
            }
        }
        mat.alpha_mode = match m.get("alphaMode").and_then(Json::as_str) {
            Some("MASK") => AlphaMode::Mask,
            Some("BLEND") => AlphaMode::Blend,
            _ => AlphaMode::Opaque,
        };
        if let Some(c) = m.get("alphaCutoff").and_then(Json::as_f32) {
            mat.alpha_cutoff = c;
        }
        out.push(mat);
    }
    out
}

fn parse_skins(gltf: &Json, bin: &[u8]) -> Result<Vec<GlbSkin>, GlbError> {
    let mut out = Vec::new();
    let Some(skins) = gltf.get("skins").and_then(Json::as_array) else {
        return Ok(out);
    };
    for s in skins {
        let joints = s
            .get("joints")
            .and_then(Json::as_array)
            .map(|a| a.iter().filter_map(|j| j.as_i64().map(|x| x as usize)).collect::<Vec<_>>())
            .unwrap_or_default();
        let inverse_bind = if let Some(i) = u(s, "inverseBindMatrices") {
            read_mat4s(bin, &resolve_accessor(gltf, i, bin.len())?)?
        } else {
            joints.iter().map(|_| Mat4::IDENTITY).collect()
        };
        out.push(GlbSkin {
            joints,
            inverse_bind,
            skeleton_root: u(s, "skeleton"),
        });
    }
    Ok(out)
}

fn parse_animations(gltf: &Json, bin: &[u8]) -> Result<Vec<GlbAnimation>, GlbError> {
    let mut out = Vec::new();
    let Some(anims) = gltf.get("animations").and_then(Json::as_array) else {
        return Ok(out);
    };
    for a in anims {
        let mut samplers = Vec::new();
        let mut duration = 0.0f32;
        for s in a.get("samplers").and_then(Json::as_array).unwrap_or(&[]) {
            let input_idx = u(s, "input").ok_or(GlbError::BadAccessor)?;
            let output_idx = u(s, "output").ok_or(GlbError::BadAccessor)?;
            let input = read_floats(bin, &resolve_accessor(gltf, input_idx, bin.len())?)?;
            let output = read_floats(bin, &resolve_accessor(gltf, output_idx, bin.len())?)?;
            let interp = match s.get("interpolation").and_then(Json::as_str) {
                Some("STEP") => Interp::Step,
                Some("CUBICSPLINE") => return Err(GlbError::Unsupported("cubicspline")),
                _ => Interp::Linear,
            };
            if let Some(&last) = input.last() {
                if last > duration {
                    duration = last;
                }
            }
            samplers.push(GlbSampler { input, output, interp });
        }
        let mut channels = Vec::new();
        for c in a.get("channels").and_then(Json::as_array).unwrap_or(&[]) {
            let sampler = u(c, "sampler").ok_or(GlbError::BadAccessor)?;
            let target = c.get("target").ok_or(GlbError::BadAccessor)?;
            let Some(node) = u(target, "node") else {
                continue; // untargeted channel (e.g. weights on absent node): skip.
            };
            let path = match target.get("path").and_then(Json::as_str) {
                Some("translation") => ChannelPath::Translation,
                Some("rotation") => ChannelPath::Rotation,
                Some("scale") => ChannelPath::Scale,
                Some("weights") => continue, // morph targets unsupported: skip.
                _ => return Err(GlbError::BadAccessor),
            };
            channels.push(GlbChannel {
                sampler,
                target_node: node,
                path,
            });
        }
        out.push(GlbAnimation {
            name: a.get("name").and_then(Json::as_str).map(String::from),
            channels,
            samplers,
            duration,
        });
    }
    Ok(out)
}

fn parse_scene_roots(gltf: &Json) -> Vec<usize> {
    let scene_idx = u(gltf, "scene").unwrap_or(0);
    gltf.get("scenes")
        .and_then(Json::as_array)
        .and_then(|s| s.get(scene_idx))
        .and_then(|s| s.get("nodes"))
        .and_then(Json::as_array)
        .map(|a| a.iter().filter_map(|n| n.as_i64().map(|x| x as usize)).collect())
        .unwrap_or_default()
}

#[cfg(all(test, feature = "std"))]
mod tests;
