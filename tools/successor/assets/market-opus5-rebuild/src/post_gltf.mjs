/**
 * Post-export ORM wiring.
 *
 * Blender's exporter emits "More than one shader node tex image used for a
 * texture" whenever one image feeds more than one socket, so build_market.py
 * links the packed ORM map from EXACTLY ONE socket (Roughness) and keeps
 * metallic as a per-material constant. glTF's occlusionTexture is therefore
 * missing from the exported file even though the R channel of that same image
 * already holds micro AO.
 *
 * This script re-attaches it: for every material that has a
 * metallicRoughnessTexture, set occlusionTexture to the SAME texture (glTF
 * defines occlusion=R, roughness=G, metalness=B, which is exactly our packing).
 * No new image data is added; the sampler is shared.
 *
 *   node src/post_gltf.mjs build/market_house_lod0.glb [strength]
 */
import { NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, textureCompress } from '@gltf-transform/functions';
import { listTextureSlots } from '@gltf-transform/functions';
import sharp from 'sharp';

const file = process.argv[2];
const strength = process.argv[3] ? parseFloat(process.argv[3]) : 1.0;
// LOD1/LOD2 are viewed at distance: halving/quartering texture side keeps
// texture memory credible for a browser client without touching LOD0 quality.
const maxTex = process.argv[4] ? parseInt(process.argv[4], 10) : 0;
if (!file) { console.error('usage: post_gltf.mjs <glb> [strength] [maxTexSize]'); process.exit(2); }

const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);
const doc = await io.read(file);
let wired = 0, skipped = 0;
for (const mat of doc.getRoot().listMaterials()) {
  const mr = mat.getMetallicRoughnessTexture();
  if (!mr) { skipped++; continue; }
  if (mat.getOcclusionTexture()) { skipped++; continue; }
  mat.setOcclusionTexture(mr);
  const info = mat.getMetallicRoughnessTextureInfo();
  const oinfo = mat.getOcclusionTextureInfo();
  if (info && oinfo) {
    oinfo.setTexCoord(info.getTexCoord());
    const w = info.getWrapS(); const h = info.getWrapT();
    oinfo.setWrapS(w); oinfo.setWrapT(h);
    if (info.getMagFilter() !== null) oinfo.setMagFilter(info.getMagFilter());
    if (info.getMinFilter() !== null) oinfo.setMinFilter(info.getMinFilter());
  }
  mat.setOcclusionStrength(strength);
  wired++;
}
// Strip attributes the validator reports as unused: TANGENT on primitives whose
// material has no normal map, and TEXCOORD_0 on primitives with no texture at
// all (the untextured lamp/glass/seal slots). This is pure payload removal.
// prune can drop textures, which turns further primitives into "no normal map"
// cases, so strip and prune are iterated until the document stops changing.
let stripT = 0, stripUV = 0;
for (let pass = 0; pass < 8; pass++) {
  let changed = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      if (!mat) continue;
      if (!mat.getNormalTexture() && prim.getAttribute('TANGENT')) {
        prim.setAttribute('TANGENT', null); stripT++; changed++;
      }
      const textured = mat.getBaseColorTexture() || mat.getNormalTexture() ||
        mat.getMetallicRoughnessTexture() || mat.getOcclusionTexture() ||
        mat.getEmissiveTexture();
      if (!textured && prim.getAttribute('TEXCOORD_0')) {
        prim.setAttribute('TEXCOORD_0', null); stripUV++; changed++;
      }
    }
  }
  await doc.transform(prune({ keepAttributes: false, keepLeaves: false }));
  if (!changed) break;
}
// Per-slot budget. Base colour is the only map a player reads directly at
// close range; the normal map carries micro-relief only and survives halving;
// the packed ORM carries micro AO + roughness and survives quartering.
const SLOT_MAX = { baseColorTexture: 512, normalTexture: 256,
                   metallicRoughnessTexture: 128, occlusionTexture: 128,
                   emissiveTexture: 256 };
let resized = 0;
for (const tex of doc.getRoot().listTextures()) {
  const slots = listTextureSlots(tex);
  let budget = Math.min(...slots.map(s => SLOT_MAX[s] ?? 512));
  if (!isFinite(budget)) budget = 512;
  if (maxTex > 0) budget = Math.min(budget, maxTex);
  const size = tex.getSize();
  if (!size) continue;
  const target = Math.min(budget, Math.max(size[0], size[1]));
  if (target >= Math.max(size[0], size[1])) continue;
  const img = tex.getImage();
  const out = await sharp(Buffer.from(img))
    .resize(target, target, { kernel: 'lanczos3' })
    .png({ compressionLevel: 9, effort: 10 }).toBuffer();
  tex.setImage(new Uint8Array(out)).setMimeType('image/png');
  resized++;
}
await io.write(file, doc);
const names = doc.getRoot().listMaterials()
  .map(m => `${m.getName()}:${m.getOcclusionTexture() ? 'AO' : '--'}`).join(' ');
console.log(`post_gltf ${file}: occlusion wired=${wired} skipped=${skipped} ` +
  `strength=${strength} strippedTangent=${stripT} strippedUV=${stripUV} ` +
  `maxTex=${maxTex || 'native'} resizedTextures=${resized}`);
console.log(`  ${names}`);
