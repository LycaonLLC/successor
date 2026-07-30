//! GLB parser tests. Fixtures are assembled in-memory (no binary checked in).

use super::*;
use alloc::vec;
use alloc::vec::Vec;

/// Assemble a valid GLB from a JSON string and a BIN blob, handling the
/// 4-byte chunk padding (JSON padded with spaces, BIN with zeros).
fn build_glb(json: &str, bin: &[u8]) -> Vec<u8> {
    fn pad4(v: &mut Vec<u8>, fill: u8) {
        while v.len() % 4 != 0 {
            v.push(fill);
        }
    }
    let mut json_bytes = json.as_bytes().to_vec();
    pad4(&mut json_bytes, b' ');
    let mut bin_bytes = bin.to_vec();
    pad4(&mut bin_bytes, 0);

    let total = 12 + 8 + json_bytes.len() + 8 + bin_bytes.len();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(&GLB_MAGIC.to_le_bytes());
    out.extend_from_slice(&2u32.to_le_bytes());
    out.extend_from_slice(&(total as u32).to_le_bytes());
    out.extend_from_slice(&(json_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&CHUNK_JSON.to_le_bytes());
    out.extend_from_slice(&json_bytes);
    out.extend_from_slice(&(bin_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&CHUNK_BIN.to_le_bytes());
    out.extend_from_slice(&bin_bytes);
    out
}

fn f32s(vals: &[f32]) -> Vec<u8> {
    let mut b = Vec::new();
    for v in vals {
        b.extend_from_slice(&v.to_le_bytes());
    }
    b
}

#[test]
fn parses_static_triangle_with_material() {
    let mut bin = f32s(&[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]); // 3 vec3 = 36 bytes
    bin.extend_from_slice(&0u16.to_le_bytes());
    bin.extend_from_slice(&1u16.to_le_bytes());
    bin.extend_from_slice(&2u16.to_le_bytes()); // +6 = 42 bytes
    let json = r#"{
      "asset":{"version":"2.0"},
      "scene":0,
      "scenes":[{"nodes":[0]}],
      "nodes":[{"mesh":0,"name":"tri","translation":[1,2,3]}],
      "meshes":[{"primitives":[{"attributes":{"POSITION":0},"indices":1,"material":0}]}],
      "materials":[{"name":"red","pbrMetallicRoughness":{"baseColorFactor":[1,0,0,1]},"doubleSided":true,"alphaMode":"MASK","alphaCutoff":0.25}],
      "accessors":[
        {"bufferView":0,"componentType":5126,"count":3,"type":"VEC3"},
        {"bufferView":1,"componentType":5123,"count":3,"type":"SCALAR"}
      ],
      "bufferViews":[
        {"buffer":0,"byteOffset":0,"byteLength":36},
        {"buffer":0,"byteOffset":36,"byteLength":6}
      ],
      "buffers":[{"byteLength":42}]
    }"#;
    let doc = parse(&build_glb(json, &bin)).expect("parse");
    assert_eq!(doc.scene_roots, vec![0]);
    assert_eq!(doc.nodes.len(), 1);
    assert_eq!(doc.nodes[0].name.as_deref(), Some("tri"));
    assert_eq!(doc.nodes[0].translation, vec3(1.0, 2.0, 3.0));
    assert_eq!(doc.nodes[0].mesh, Some(0));

    let prim = &doc.meshes[0].primitives[0];
    assert_eq!(prim.positions, vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]);
    assert_eq!(prim.indices, vec![0, 1, 2]);
    assert_eq!(prim.material, Some(0));

    let mat = &doc.materials[0];
    assert_eq!(mat.base_color, [1.0, 0.0, 0.0, 1.0]);
    assert!(mat.double_sided);
    assert_eq!(mat.alpha_mode, AlphaMode::Mask);
    assert_eq!(mat.alpha_cutoff, 0.25);
}

#[test]
fn reads_skin_joints_weights_and_ibm() {
    // 1 vertex: pos(0,0,0), joints u8 [0,1,0,0], weights [0.5,0.5,0,0]; 2 IBM identity mats.
    let mut bin = f32s(&[0.0, 0.0, 0.0]); // POSITION, offset 0, 12 bytes
    bin.extend_from_slice(&[0u8, 1, 0, 0]); // JOINTS_0 u8x4, offset 12, 4 bytes
    bin.extend_from_slice(&f32s(&[0.5, 0.5, 0.0, 0.0])); // WEIGHTS_0, offset 16, 16 bytes
    // IBM: two identity mat4s, offset 32, 128 bytes
    for _ in 0..2 {
        let id = Mat4::IDENTITY;
        bin.extend_from_slice(&f32s(&id.m));
    }
    let json = r#"{
      "asset":{"version":"2.0"},
      "nodes":[{"mesh":0,"skin":0},{"name":"j0"},{"name":"j1"}],
      "meshes":[{"primitives":[{"attributes":{"POSITION":0,"JOINTS_0":1,"WEIGHTS_0":2}}]}],
      "skins":[{"joints":[1,2],"inverseBindMatrices":3}],
      "accessors":[
        {"bufferView":0,"componentType":5126,"count":1,"type":"VEC3"},
        {"bufferView":1,"componentType":5121,"count":1,"type":"VEC4"},
        {"bufferView":2,"componentType":5126,"count":1,"type":"VEC4"},
        {"bufferView":3,"componentType":5126,"count":2,"type":"MAT4"}
      ],
      "bufferViews":[
        {"buffer":0,"byteOffset":0,"byteLength":12},
        {"buffer":0,"byteOffset":12,"byteLength":4},
        {"buffer":0,"byteOffset":16,"byteLength":16},
        {"buffer":0,"byteOffset":32,"byteLength":128}
      ],
      "buffers":[{"byteLength":160}]
    }"#;
    let doc = parse(&build_glb(json, &bin)).expect("parse");
    let prim = &doc.meshes[0].primitives[0];
    assert_eq!(prim.joints, vec![[0, 1, 0, 0]]);
    assert_eq!(prim.weights, vec![[0.5, 0.5, 0.0, 0.0]]);
    assert_eq!(doc.skins[0].joints, vec![1, 2]);
    assert_eq!(doc.skins[0].inverse_bind.len(), 2);
    assert_eq!(doc.skins[0].inverse_bind[0], Mat4::IDENTITY);
}

#[test]
fn reads_animation_channels() {
    // sampler input: 2 times [0,1]; output: 2 vec3 translations.
    let mut bin = f32s(&[0.0, 1.0]); // input, offset 0, 8 bytes
    bin.extend_from_slice(&f32s(&[0.0, 0.0, 0.0, 5.0, 0.0, 0.0])); // output, offset 8, 24 bytes
    let json = r#"{
      "asset":{"version":"2.0"},
      "nodes":[{"name":"n0"}],
      "animations":[{"name":"idle","samplers":[{"input":0,"output":1,"interpolation":"LINEAR"}],"channels":[{"sampler":0,"target":{"node":0,"path":"translation"}}]}],
      "accessors":[
        {"bufferView":0,"componentType":5126,"count":2,"type":"SCALAR"},
        {"bufferView":1,"componentType":5126,"count":2,"type":"VEC3"}
      ],
      "bufferViews":[
        {"buffer":0,"byteOffset":0,"byteLength":8},
        {"buffer":0,"byteOffset":8,"byteLength":24}
      ],
      "buffers":[{"byteLength":32}]
    }"#;
    let doc = parse(&build_glb(json, &bin)).expect("parse");
    let anim = doc.animation_by_name("idle").expect("idle anim");
    assert_eq!(anim.duration, 1.0);
    assert_eq!(anim.channels.len(), 1);
    assert_eq!(anim.channels[0].path, ChannelPath::Translation);
    assert_eq!(anim.samplers[0].input, vec![0.0, 1.0]);
    assert_eq!(anim.samplers[0].output, vec![0.0, 0.0, 0.0, 5.0, 0.0, 0.0]);
}

#[test]
fn rejects_bad_magic() {
    let bytes = [0u8; 20];
    assert!(matches!(parse(&bytes), Err(GlbError::BadMagic)));
}
