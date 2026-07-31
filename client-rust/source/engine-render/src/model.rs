//! Shared GLB mesh/material upload path.

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

use successor_engine_core::glb::{AlphaMode, GlbDocument, GlbPrimitive, TextureRef};
use successor_engine_core::image::decode_image;

use crate::components::{MaterialId, MeshId};
use crate::gpu::{Filter, Gpu, GpuError, MinFilter, TextureDesc, TextureFormat, TextureId, Wrap};
use crate::renderer::{MaterialDesc, Renderer};

#[derive(Clone, Copy, Debug)]
pub struct UploadedPrimitive {
    pub mesh: MeshId,
    pub material: MaterialId,
    pub source_mesh: usize,
    pub source_primitive: usize,
}

#[derive(Clone, Debug, Default)]
pub struct UploadedModel {
    pub primitives: Vec<UploadedPrimitive>,
    pub node_meshes: Vec<Option<usize>>,
    pub node_skins: Vec<Option<usize>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ModelUploadError {
    Image,
    TextureIndex,
    ImageIndex,
    VertexCount,
    JointPalette,
    Gpu(GpuError),
}

#[derive(Clone, Copy)]
struct TextureCacheEntry {
    texture: usize,
    srgb: bool,
    uploaded: TextureId,
}

pub fn upload_glb<G: Gpu>(
    renderer: &mut Renderer,
    gpu: &mut G,
    document: &GlbDocument,
) -> Result<UploadedModel, ModelUploadError> {
    if document.skins.iter().any(|skin| skin.joints.len() > 64) {
        return Err(ModelUploadError::JointPalette);
    }
    let mut uploaded = UploadedModel {
        primitives: Vec::new(),
        node_meshes: document.nodes.iter().map(|node| node.mesh).collect(),
        node_skins: document.nodes.iter().map(|node| node.skin).collect(),
    };
    let mut texture_cache: Vec<TextureCacheEntry> = Vec::new();
    for (mesh_index, mesh) in document.meshes.iter().enumerate() {
        for (primitive_index, primitive) in mesh.primitives.iter().enumerate() {
            let (vertices, indices) = pack_primitive(primitive)?;
            let mesh_id = renderer.upload_gltf_mesh(
                gpu,
                &vertices,
                &indices,
                !primitive.joints.is_empty(),
                !primitive.colors.is_empty(),
            );
            let material = match primitive
                .material
                .and_then(|index| document.materials.get(index))
            {
                Some(source) => {
                    let base_color_texture = upload_texture(
                        document,
                        gpu,
                        &mut texture_cache,
                        source.base_color_texture,
                        true,
                    )?;
                    let metallic_roughness_texture = upload_texture(
                        document,
                        gpu,
                        &mut texture_cache,
                        source.metallic_roughness_texture,
                        false,
                    )?;
                    let normal_texture = upload_texture(
                        document,
                        gpu,
                        &mut texture_cache,
                        source.normal_texture,
                        false,
                    )?;
                    let occlusion_texture = upload_texture(
                        document,
                        gpu,
                        &mut texture_cache,
                        source.occlusion_texture,
                        false,
                    )?;
                    let emissive_texture = upload_texture(
                        document,
                        gpu,
                        &mut texture_cache,
                        source.emissive_texture,
                        true,
                    )?;
                    renderer.add_material_desc(MaterialDesc {
                        base_color: source.base_color,
                        base_color_texture,
                        metallic_roughness_texture,
                        normal_texture,
                        occlusion_texture,
                        emissive_texture,
                        metallic: source.metallic,
                        roughness: source.roughness,
                        normal_scale: source.normal_scale,
                        occlusion_strength: source.occlusion_strength,
                        emissive_factor: source.emissive_factor,
                        emissive_strength: source.emissive_strength,
                        clearcoat: source.clearcoat,
                        clearcoat_roughness: source.clearcoat_roughness,
                        specular: source.specular,
                        ior: source.ior,
                        transmission: source.transmission,
                        alpha_cutoff: source.alpha_cutoff,
                        double_sided: source.double_sided,
                        blend: source.alpha_mode == AlphaMode::Blend || source.transmission > 0.0,
                        terrain: None,
                    })
                }
                None => renderer.add_material_desc(MaterialDesc::default()),
            };
            uploaded.primitives.push(UploadedPrimitive {
                mesh: mesh_id,
                material,
                source_mesh: mesh_index,
                source_primitive: primitive_index,
            });
        }
    }
    if let Some(error) = gpu.take_error() {
        return Err(ModelUploadError::Gpu(error));
    }
    Ok(uploaded)
}

fn upload_texture<G: Gpu>(
    document: &GlbDocument,
    gpu: &mut G,
    cache: &mut Vec<TextureCacheEntry>,
    reference: Option<TextureRef>,
    srgb: bool,
) -> Result<Option<TextureId>, ModelUploadError> {
    let Some(reference) = reference else {
        return Ok(None);
    };
    if reference.tex_coord != 0 {
        return Err(ModelUploadError::TextureIndex);
    }
    if let Some(entry) = cache
        .iter()
        .find(|entry| entry.texture == reference.texture && entry.srgb == srgb)
    {
        return Ok(Some(entry.uploaded));
    }
    let texture = document
        .textures
        .get(reference.texture)
        .ok_or(ModelUploadError::TextureIndex)?;
    let image = document
        .images
        .get(texture.source)
        .ok_or(ModelUploadError::ImageIndex)?;
    let decoded =
        decode_image(&image.mime_type, &image.bytes).map_err(|_| ModelUploadError::Image)?;
    let sampler = texture
        .sampler
        .and_then(|index| document.texture_samplers.get(index));
    let mag_filter = match sampler.map(|value| value.mag_filter) {
        Some(successor_engine_core::glb::MagFilter::Nearest) => Filter::Nearest,
        _ => Filter::Linear,
    };
    let min_filter = match sampler.map(|value| value.min_filter) {
        Some(successor_engine_core::glb::MinFilter::NearestMipmapNearest) => {
            MinFilter::NearestMipmapNearest
        }
        _ => MinFilter::LinearMipmapLinear,
    };
    let map_wrap = |value| match value {
        Some(successor_engine_core::glb::WrapMode::ClampToEdge) => Wrap::ClampToEdge,
        _ => Wrap::Repeat,
    };
    let uploaded = gpu.create_texture(
        &TextureDesc {
            width: decoded.width,
            height: decoded.height,
            format: if srgb {
                TextureFormat::Srgba8
            } else {
                TextureFormat::Rgba8
            },
            mag_filter,
            min_filter,
            wrap_s: map_wrap(sampler.map(|value| value.wrap_s)),
            wrap_t: map_wrap(sampler.map(|value| value.wrap_t)),
            mipmaps: true,
        },
        Some(&decoded.pixels),
    );
    cache.push(TextureCacheEntry {
        texture: reference.texture,
        srgb,
        uploaded,
    });
    Ok(Some(uploaded))
}
fn pack_primitive(primitive: &GlbPrimitive) -> Result<(Vec<u8>, Vec<u32>), ModelUploadError> {
    let count = primitive.positions.len();
    if count == 0
        || (!primitive.normals.is_empty() && primitive.normals.len() != count)
        || (!primitive.uvs.is_empty() && primitive.uvs.len() != count)
        || (!primitive.joints.is_empty() && primitive.joints.len() != count)
        || (!primitive.weights.is_empty() && primitive.weights.len() != count)
    {
        return Err(ModelUploadError::VertexCount);
    }
    let mut positions = primitive.positions.clone();
    let mut source_normals = primitive.normals.clone();
    let mut source_tangents = primitive.tangents.clone();
    for (target_index, target) in primitive.morph_targets.iter().enumerate() {
        let weight = primitive
            .morph_weights
            .get(target_index)
            .copied()
            .unwrap_or(0.0);
        if weight == 0.0 {
            continue;
        }
        for (value, delta) in positions.iter_mut().zip(&target.positions) {
            for axis in 0..3 {
                value[axis] += delta[axis] * weight;
            }
        }
        for (value, delta) in source_normals.iter_mut().zip(&target.normals) {
            for axis in 0..3 {
                value[axis] += delta[axis] * weight;
            }
        }
        for (value, delta) in source_tangents.iter_mut().zip(&target.tangents) {
            for axis in 0..3 {
                value[axis] += delta[axis] * weight;
            }
        }
    }
    let normals = if source_normals.is_empty() {
        generate_normals(&positions, &primitive.indices)
    } else {
        source_normals
    };
    let mut vertex_sources: Vec<usize> = (0..count).collect();
    let (tangents, packed_indices) =
        if source_tangents.is_empty() && primitive.uvs.len() == positions.len() {
            let corners = successor_engine_core::glb::generate_mikktspace_corner_tangents(
                &positions,
                &normals,
                &primitive.uvs,
                &primitive.indices,
            )
            .map_err(|_| ModelUploadError::VertexCount)?;
            let mut remap: BTreeMap<(u32, [u32; 4]), u32> = BTreeMap::new();
            let mut unique_tangents = Vec::new();
            let mut remapped_indices = Vec::with_capacity(primitive.indices.len());
            vertex_sources.clear();
            for (source, tangent) in primitive.indices.iter().copied().zip(corners) {
                let encoded = tangent.map(f32::to_bits);
                let next = remap.len() as u32;
                let destination = *remap.entry((source, encoded)).or_insert_with(|| {
                    vertex_sources.push(source as usize);
                    unique_tangents.push(tangent);
                    next
                });
                remapped_indices.push(destination);
            }
            (unique_tangents, remapped_indices)
        } else {
            (source_tangents, primitive.indices.clone())
        };
    let skinned = !primitive.joints.is_empty();
    let stride = if skinned { 64 } else { 52 };
    let mut vertices = Vec::with_capacity(vertex_sources.len() * stride);
    for (packed_index, &source_index) in vertex_sources.iter().enumerate() {
        for value in positions[source_index]
            .into_iter()
            .chain(normals[source_index])
            .chain(*primitive.uvs.get(source_index).unwrap_or(&[0.0, 0.0]))
            .chain(*tangents.get(packed_index).unwrap_or(&[1.0, 0.0, 0.0, 1.0]))
        {
            vertices.extend_from_slice(&value.to_ne_bytes());
        }
        vertices.extend_from_slice(
            &primitive
                .colors
                .get(source_index)
                .copied()
                .unwrap_or([255; 4]),
        );
        if skinned {
            for joint in primitive.joints[source_index] {
                let joint = u8::try_from(joint).map_err(|_| ModelUploadError::JointPalette)?;
                vertices.push(joint);
            }
            for weight in primitive.weights[source_index] {
                let encoded = libm::roundf(weight.clamp(0.0, 1.0) * 65535.0) as u16;
                vertices.extend_from_slice(&encoded.to_ne_bytes());
            }
        }
    }
    Ok((vertices, packed_indices))
}

fn generate_normals(positions: &[[f32; 3]], indices: &[u32]) -> Vec<[f32; 3]> {
    let mut normals = alloc::vec![[0.0f32; 3]; positions.len()];
    for triangle in indices.chunks_exact(3) {
        let Some(&a) = positions.get(triangle[0] as usize) else {
            continue;
        };
        let Some(&b) = positions.get(triangle[1] as usize) else {
            continue;
        };
        let Some(&c) = positions.get(triangle[2] as usize) else {
            continue;
        };
        let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let face = [
            ab[1] * ac[2] - ab[2] * ac[1],
            ab[2] * ac[0] - ab[0] * ac[2],
            ab[0] * ac[1] - ab[1] * ac[0],
        ];
        for vertex in triangle {
            if let Some(normal) = normals.get_mut(*vertex as usize) {
                normal[0] += face[0];
                normal[1] += face[1];
                normal[2] += face[2];
            }
        }
    }
    for normal in &mut normals {
        let length =
            libm::sqrtf(normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]);
        if length > 1.0e-8 {
            normal[0] /= length;
            normal[1] /= length;
            normal[2] /= length;
        } else {
            *normal = [0.0, 1.0, 0.0];
        }
    }
    normals
}

#[cfg(all(test, feature = "std"))]
mod tests {
    use super::*;
    use crate::gpu::{VertexFormat, GLTF_MESH_LAYOUT, GLTF_SKINNED_MESH_LAYOUT};

    #[test]
    fn packed_static_layout_keeps_u8_color_without_float_inflation() {
        let primitive = GlbPrimitive {
            positions: alloc::vec![[1.0, 2.0, 3.0]],
            normals: alloc::vec![[0.0, 1.0, 0.0]],
            uvs: alloc::vec![[0.25, 0.75]],
            tangents: alloc::vec![[1.0, 0.0, 0.0, -1.0]],
            colors: alloc::vec![[17, 34, 51, 68]],
            indices: alloc::vec![0],
            ..GlbPrimitive::default()
        };
        let (vertices, indices) = pack_primitive(&primitive).expect("pack");
        assert_eq!(vertices.len(), GLTF_MESH_LAYOUT.stride as usize);
        assert_eq!(&vertices[48..52], &[17, 34, 51, 68]);
        assert_eq!(indices, alloc::vec![0]);
        assert_eq!(GLTF_MESH_LAYOUT.attrs[4].format, VertexFormat::U8Norm);
    }

    #[test]
    fn packed_skin_layout_uses_u8_joints_and_normalized_u16_weights() {
        let primitive = GlbPrimitive {
            positions: alloc::vec![[0.0; 3]],
            normals: alloc::vec![[0.0, 1.0, 0.0]],
            uvs: alloc::vec![[0.0; 2]],
            tangents: alloc::vec![[1.0, 0.0, 0.0, 1.0]],
            joints: alloc::vec![[1, 2, 3, 51]],
            weights: alloc::vec![[1.0, 0.5, 0.0, 0.25]],
            indices: alloc::vec![0],
            ..GlbPrimitive::default()
        };
        let (vertices, _) = pack_primitive(&primitive).expect("pack");
        assert_eq!(vertices.len(), GLTF_SKINNED_MESH_LAYOUT.stride as usize);
        assert_eq!(&vertices[52..56], &[1, 2, 3, 51]);
        assert_eq!(u16::from_ne_bytes([vertices[56], vertices[57]]), u16::MAX);
        assert_eq!(u16::from_ne_bytes([vertices[58], vertices[59]]), 32_768);
        assert_eq!(GLTF_SKINNED_MESH_LAYOUT.attrs[5].format, VertexFormat::U8);
        assert_eq!(
            GLTF_SKINNED_MESH_LAYOUT.attrs[6].format,
            VertexFormat::U16Norm
        );
    }

    #[test]
    fn generated_corner_tangent_discontinuities_remap_indices() {
        let primitive = GlbPrimitive {
            positions: alloc::vec![
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [1.0, 1.0, 0.0],
                [0.0, 1.0, 0.0],
            ],
            normals: alloc::vec![[0.0, 0.0, 1.0]; 4],
            uvs: alloc::vec![[0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [1.0, 1.0]],
            indices: alloc::vec![0, 1, 2, 0, 2, 3],
            ..GlbPrimitive::default()
        };
        let (vertices, indices) = pack_primitive(&primitive).expect("pack");
        assert_eq!(indices.len(), primitive.indices.len());
        assert_eq!(vertices.len() % GLTF_MESH_LAYOUT.stride as usize, 0);
        assert!(vertices.len() / GLTF_MESH_LAYOUT.stride as usize >= 4);
    }
    #[test]
    fn upload_surfaces_backend_errors() {
        let mut gpu = crate::gpu::MockGpu::default();
        let mut renderer =
            Renderer::new(&mut gpu, crate::renderer::RendererLimits::default()).expect("renderer");
        gpu.error = Some(GpuError::InvalidResource);
        assert!(matches!(
            upload_glb(&mut renderer, &mut gpu, &GlbDocument::default()),
            Err(ModelUploadError::Gpu(GpuError::InvalidResource))
        ));
    }
}
