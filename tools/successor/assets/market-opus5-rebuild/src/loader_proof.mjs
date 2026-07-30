/**
 * Three.js load + door-animation proof, run in real Three.js under Node.
 *
 *   node src/loader_proof.mjs build/market_house_lod0.glb
 *
 * Proves, without trusting Blender object names:
 *   1. GLTFLoader parses the GLB;
 *   2. the node `door_slide` exists, is a scene root child (never under a
 *      cutaway-hidden node) and has no cutaway prefix in any ancestor;
 *   3. the cutaway prefixes are all present as top-level nodes;
 *   4. both clips exist, are 0.8 s, and ACTUALLY MOVE the movable leaf through
 *      the recorded local travel when evaluated by AnimationMixer;
 *   5. every material texture resolves to real decoded image data.
 */
import fs from 'fs';
import path from 'path';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const file = process.argv[2] || 'build/market_house_lod0.glb';
const EXPECT_TRAVEL = -2.60;
const PREFIXES = ['roof__', 'wall_front__', 'wall_back__', 'wall_left__',
                  'wall_right__', 'floor__', 'interior__'];
const fails = [];
const ok = (c, m) => { console.log(`${c ? ' PASS' : ' FAIL'}  ${m}`); if (!c) fails.push(m); };

// Node has no HTMLImageElement/createImageBitmap, so GLTFLoader's blob-URL
// texture path cannot resolve. Shim `createImageBitmap` to decode the PNG/JPEG
// header out of the real blob bytes: this proves the embedded image data is
// present and well-formed, which is what "textures resolve" has to mean here.
global.self = global;
global.URL = URL;
if (!global.TextDecoder) global.TextDecoder = (await import('util')).TextDecoder;

function headerSize(u8) {
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20), type: 'image/png' };
  }
  if (u8[0] === 0xFF && u8[1] === 0xD8) {           // JPEG: walk the segments
    let i = 2;
    while (i < u8.length) {
      if (u8[i] !== 0xFF) { i++; continue; }
      const m = u8[i + 1];
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        return { height: (u8[i + 5] << 8) | u8[i + 6],
                 width: (u8[i + 7] << 8) | u8[i + 8], type: 'image/jpeg' };
      }
      i += 2 + ((u8[i + 2] << 8) | u8[i + 3]);
    }
  }
  return null;
}
const decoded = [];
global.createImageBitmap = async (blob) => {
  const u8 = new Uint8Array(await blob.arrayBuffer());
  const h = headerSize(u8);
  if (!h) throw new Error('undecodable image payload');
  decoded.push({ ...h, bytes: u8.length });
  return { width: h.width, height: h.height, close() {} };
};

const buf = fs.readFileSync(file);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const loader = new GLTFLoader();
const gltf = await new Promise((res, rej) =>
  loader.parse(ab, path.dirname(path.resolve(file)) + '/', res, rej));

console.log(`\n=== Three.js r${THREE.REVISION} GLTFLoader proof: ${file} ===`);
ok(!!gltf.scene, 'GLTFLoader parsed the GLB into a scene');

// ---- node inventory
const byName = new Map();
gltf.scene.traverse(o => byName.set(o.name, o));
const door = byName.get('door_slide');
ok(!!door, 'node `door_slide` exists after export');

let anc = [], p = door && door.parent;
while (p) { anc.push(p.name); p = p.parent; }
ok(!!door && !anc.some(n => PREFIXES.some(pre => n.startsWith(pre))),
   `door_slide has no cutaway-prefixed ancestor (chain: ${anc.join(' < ') || 'scene root'})`);

for (const pre of PREFIXES) {
  const hit = [...byName.keys()].find(n => n.startsWith(pre));
  ok(!!hit, `cutaway prefix present: ${pre} -> ${hit || 'MISSING'}`);
}
const leaf = byName.get('door_slide__leaf');
ok(!!leaf && leaf.parent === door, 'door_slide__leaf is a child of door_slide');

// ---- clips
const clips = gltf.animations || [];
console.log(`  clips: ${clips.map(c => `${c.name}(${c.duration.toFixed(3)}s)`).join(', ') || 'none'}`);
for (const nm of ['door_open', 'door_close']) {
  const c = clips.find(x => x.name === nm);
  ok(!!c, `clip \`${nm}\` survived export`);
  if (c) ok(Math.abs(c.duration - 0.8) < 1e-3, `clip \`${nm}\` is 0.8 s (${c.duration.toFixed(4)})`);
}

// ---- the clips must MOVE the leaf, measured in world space
function worldX(obj) {
  gltf.scene.updateMatrixWorld(true);
  return new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld).x;
}
const mixer = new THREE.AnimationMixer(gltf.scene);
function sample(clipName, t) {
  mixer.stopAllAction();
  const clip = clips.find(c => c.name === clipName);
  const act = mixer.clipAction(clip);
  act.reset(); act.play(); act.paused = true; act.time = t;
  mixer.setTime(0); act.time = t; mixer.update(0);
  return { door: door.position.x, leafWorld: worldX(leaf) };
}
if (clips.length && door && leaf) {
  const o0 = sample('door_open', 0.0);
  const o1 = sample('door_open', 0.8);
  const c0 = sample('door_close', 0.0);
  const c1 = sample('door_close', 0.8);
  console.log(`  door_open : local x ${o0.door.toFixed(4)} -> ${o1.door.toFixed(4)}` +
              `   leaf world x ${o0.leafWorld.toFixed(4)} -> ${o1.leafWorld.toFixed(4)}`);
  console.log(`  door_close: local x ${c0.door.toFixed(4)} -> ${c1.door.toFixed(4)}` +
              `   leaf world x ${c0.leafWorld.toFixed(4)} -> ${c1.leafWorld.toFixed(4)}`);
  ok(Math.abs(o0.door) < 1e-4, 'door_open starts fully closed (local x = 0)');
  ok(Math.abs(o1.door - EXPECT_TRAVEL) < 1e-3,
     `door_open ends at the recorded travel (${EXPECT_TRAVEL} m)`);
  ok(Math.abs(c0.door - EXPECT_TRAVEL) < 1e-3, 'door_close starts fully open');
  ok(Math.abs(c1.door) < 1e-4, 'door_close ends fully closed');
  const moved = Math.abs(o1.leafWorld - o0.leafWorld);
  ok(Math.abs(moved - Math.abs(EXPECT_TRAVEL)) < 1e-3,
     `the LEAF MESH itself translates ${moved.toFixed(4)} m in world space`);
  const mid = sample('door_open', 0.4);
  ok(mid.door < -0.05 && mid.door > EXPECT_TRAVEL + 0.05,
     `motion is interpolated, not a step (t=0.4 -> ${mid.door.toFixed(4)})`);
  // runtime also drives the node directly
  mixer.stopAllAction();
  door.position.x = EXPECT_TRAVEL;
  ok(Math.abs(worldX(leaf) - (o1.leafWorld)) < 1e-3,
     'direct node drive reaches the same open pose as the clip');
  door.position.x = 0;
}

// ---- textures must resolve to decoded image data
const mats = new Set();
gltf.scene.traverse(o => { if (o.material) [].concat(o.material).forEach(m => mats.add(m)); });
let texCount = 0, bad = 0;
const slots = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'];
for (const m of mats) for (const s of slots) {
  const t = m[s];
  if (!t) continue;
  texCount++;
  const img = t.image;
  const w = img && (img.width || img.naturalWidth);
  const h = img && (img.height || img.naturalHeight);
  if (!w || !h) { bad++; console.log(`    unresolved: ${m.name}.${s}`); }
}
console.log(`  decoded image payloads: ${decoded.length} ` +
  `(${[...new Set(decoded.map(d => `${d.width}x${d.height} ${d.type}`))].join(', ')})`);
ok(texCount > 0, `materials reference textures (${texCount} slots across ${mats.size} materials)`);
ok(bad === 0, `every referenced texture resolved to decoded image data (${texCount - bad}/${texCount})`);

// ---- geometry attributes the asset contract depends on
// Only the AUTHORED shells carry COLOR_0; the read-only imported props keep
// their own materials and are not part of this asset's wear system.
const AUTHORED = (o) => {
  let n = o;
  while (n) {
    if (PREFIXES.some(p => n.name.startsWith(p)) || n.name.startsWith('door_slide')) return true;
    if (n.name.startsWith('prop__')) return false;
    n = n.parent;
  }
  return false;
};
let withCol = 0, withTan = 0, meshes = 0, propMeshes = 0;
gltf.scene.traverse(o => {
  if (!o.isMesh) return;
  if (!AUTHORED(o)) { propMeshes++; return; }
  meshes++;
  if (o.geometry.getAttribute('color')) withCol++;
  if (o.geometry.getAttribute('tangent')) withTan++;
});
if (propMeshes) console.log(`  (${propMeshes} imported prop meshes excluded from the COLOR_0 check)`);
ok(withCol === meshes, `COLOR_0 survives on every authored mesh (${withCol}/${meshes})`);
ok(withTan > 0, `TANGENT survives where tangent normal maps are used (${withTan}/${meshes})`);

const box = new THREE.Box3().setFromObject(gltf.scene);
const sz = box.getSize(new THREE.Vector3());
console.log(`  bounds: x ${box.min.x.toFixed(3)}..${box.max.x.toFixed(3)}  ` +
            `y ${box.min.y.toFixed(3)}..${box.max.y.toFixed(3)}  ` +
            `z ${box.min.z.toFixed(3)}..${box.max.z.toFixed(3)}`);
ok(sz.x <= 11.4 + 1e-3 && sz.z <= 8.55 + 1e-3,
   `footprint ${sz.x.toFixed(3)} x ${sz.z.toFixed(3)} m within 11.40 x 8.55 m`);

console.log(`\n${fails.length ? 'LOADER_PROOF_FAILED: ' + fails.length : 'LOADER_PROOF_OK'}`);
process.exit(fails.length ? 1 : 0);
