/**
 * Three.js GLTFLoader proof for the Dustgate Clone Vault suite, run in real
 * Three.js under Node, plus a replay of the runtime's own material conversion
 * (client-3d/src/render/props.ts::convertMaterial) so the check exercises the
 * shading path the game actually uses rather than the glTF PBR one.
 *
 *   pnpm install   # once, so client-3d/node_modules/three exists
 *   node tools/successor/assets/cloning-facility-opus5/src/loader_proof.mjs
 */
import fs from 'fs';
import path from 'path';

// `three` is a client-3d dependency, and ESM resolves bare specifiers from the
// importing file's directory upward — which never reaches client-3d/node_modules
// from here. Import it by absolute URL instead; GLTFLoader's own `from 'three'`
// then resolves correctly because it sits inside that package.
const THREE_ROOT = new URL('../../../../../client-3d/node_modules/three/', import.meta.url);
const THREE = await import(new URL('build/three.module.js', THREE_ROOT));
const { GLTFLoader } = await import(new URL('examples/jsm/loaders/GLTFLoader.js', THREE_ROOT));

const PREFIXES = ['roof__', 'wall_front__', 'wall_back__', 'wall_left__',
                  'wall_right__', 'floor__', 'interior__'];
const REVEAL = ['roof__', 'wall_front__', 'wall_right__'];
const fails = [];
const ok = (c, m) => { console.log(`${c ? ' PASS' : ' FAIL'}  ${m}`); if (!c) fails.push(m); };

global.self = global;
global.URL = URL;
const decoded = [];
function headerSize(u8) {
  if (u8[0] === 0x89 && u8[1] === 0x50) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20), type: 'png' };
  }
  if (u8[0] === 0xff && u8[1] === 0xd8) {
    let i = 2;
    while (i < u8.length) {
      if (u8[i] !== 0xff) { i += 1; continue; }
      const m = u8[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { height: (u8[i + 5] << 8) | u8[i + 6], width: (u8[i + 7] << 8) | u8[i + 8], type: 'jpeg' };
      }
      i += 2 + ((u8[i + 2] << 8) | u8[i + 3]);
    }
  }
  return null;
}
global.createImageBitmap = async (blob) => {
  const u8 = new Uint8Array(await blob.arrayBuffer());
  const info = headerSize(u8);
  if (!info) throw new Error('unrecognised image payload');
  decoded.push(info);
  return { width: info.width, height: info.height, close() {} };
};

/** Mirror of the runtime's world-prop material conversion. */
function convertMaterial(source) {
  const map = source && source.map instanceof THREE.Texture ? source.map : null;
  const emissive = source && source.emissive instanceof THREE.Color
    && source.emissive.getHex() !== 0 ? source.emissive : null;
  if (map || emissive) {
    return new THREE.MeshBasicMaterial({
      map, color: map ? new THREE.Color(0xffffff) : emissive.clone(),
      transparent: source.transparent, opacity: source.opacity, fog: true,
    });
  }
  return new THREE.MeshMatcapMaterial({
    color: source.color ? source.color.clone() : new THREE.Color(0x8f9296),
    flatShading: true, transparent: source.transparent, opacity: source.opacity,
    depthWrite: !source.transparent,
  });
}

const base = 'client-3d/public/assets/world-items/';
async function load(file) {
  const buf = fs.readFileSync(base + file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return new Promise((res, rej) => new GLTFLoader().parse(ab, path.resolve(base) + '/', res, rej));
}

console.log(`\n=== Three.js r${THREE.REVISION} loader proof ===`);

// ---------------------------------------------------------------- facility
{
  const gltf = await load('cloning_facility.glb');
  ok(!!gltf.scene, 'cloning_facility parsed');
  const byName = new Map();
  gltf.scene.traverse((o) => byName.set(o.name, o));
  const door = byName.get('door_slide');
  ok(!!door, 'node `door_slide` exists');
  let anc = [], p = door && door.parent;
  while (p) { anc.push(p.name); p = p.parent; }
  ok(!!door && !anc.some((n) => PREFIXES.some((pre) => n.startsWith(pre))),
     `door_slide has no cutaway-prefixed ancestor (${anc.join(' < ') || 'root'})`);
  ok(!!byName.get('door_slide__leaf') && byName.get('door_slide__leaf').parent === door,
     'door_slide__leaf is a child of door_slide');
  for (const pre of PREFIXES) {
    const n = [...byName.keys()].filter((k) => k.startsWith(pre)).length;
    ok(n > 0, `cutaway prefix ${pre} present (${n} nodes)`);
  }
  const clips = gltf.animations || [];
  console.log(`  clips: ${clips.map((c) => `${c.name}(${c.duration.toFixed(3)}s)`).join(', ')}`);
  for (const nm of ['door_open', 'door_close']) ok(clips.some((c) => c.name === nm), `clip ${nm} present`);

  const leaf = byName.get('door_slide__leaf');
  const worldX = (o) => { o.updateWorldMatrix(true, false); return new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).x; };
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const sample = (name, t) => {
    mixer.stopAllAction();
    const a = mixer.clipAction(clips.find((c) => c.name === name));
    a.play(); mixer.setTime(0); mixer.setTime(t);
    gltf.scene.updateMatrixWorld(true);
    return worldX(leaf);
  };
  const closedX = sample('door_open', 0);
  const openX = sample('door_open', 0.8);
  ok(Math.abs((openX - closedX) + 2.40) < 1e-2,
     `door_open travels -2.40 m on X (measured ${(openX - closedX).toFixed(4)})`);
  const back = sample('door_close', 0.8);
  ok(Math.abs(back - closedX) < 1e-2, `door_close returns to the closed pose (${back.toFixed(4)})`);
  mixer.stopAllAction(); gltf.scene.updateMatrixWorld(true);

  // reveal / keep classification must not hide the walk surface or the door
  const reveal = [...byName.keys()].filter((k) => REVEAL.some((p2) => k.startsWith(p2)));
  const keep = [...byName.keys()].filter((k) => k.startsWith('floor__') || k.startsWith('interior__'));
  ok(reveal.length >= 6, `reveal set non-trivial (${reveal.length} nodes)`);
  ok(keep.length >= 6, `keep set non-trivial (${keep.length} nodes)`);
  ok(!reveal.some((k) => k.startsWith('floor__')), 'no floor node in the reveal set');

  // material conversion through the runtime path
  const mats = new Set();
  gltf.scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => mats.add(m)); });
  let basic = 0, matcap = 0, transparent = 0;
  for (const m of mats) {
    const c = convertMaterial(m);
    if (c.isMeshBasicMaterial) basic += 1; else matcap += 1;
    if (c.transparent) transparent += 1;
  }
  console.log(`  runtime conversion: ${basic} unlit-basic, ${matcap} matcap, ${transparent} transparent`);
  ok(basic >= 1, 'the baked body material converts to the unlit basic path');
  ok(transparent >= 2, 'glass and fluid keep their authored blend transparency');

  let texSlots = 0, badTex = 0;
  for (const m of mats) for (const s of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) {
    const t = m[s];
    if (t && t.isTexture) { texSlots += 1; if (!t.image || !t.image.width) badTex += 1; }
  }
  ok(texSlots > 0, `materials reference textures (${texSlots} slots over ${mats.size} materials)`);
  ok(badTex === 0, `every referenced texture decoded (${texSlots - badTex}/${texSlots})`);
  console.log(`  decoded payloads: ${[...new Set(decoded.map((d) => `${d.width}x${d.height} ${d.type}`))].join(', ')}`);

  const box = new THREE.Box3().setFromObject(gltf.scene);
  const sz = box.getSize(new THREE.Vector3());
  console.log(`  bounds x ${box.min.x.toFixed(3)}..${box.max.x.toFixed(3)}  y ${box.min.y.toFixed(3)}..${box.max.y.toFixed(3)}  z ${box.min.z.toFixed(3)}..${box.max.z.toFixed(3)}`);
  ok(Math.abs(sz.x - 9.5) < 2e-3 && Math.abs(sz.z - 7.6) < 2e-3, `footprint ${sz.x.toFixed(4)} x ${sz.z.toFixed(4)} m`);
  ok(!gltf.parser.json.skins, 'no skins survived from the humanoid source');
  const occ = [...byName.keys()].filter((k) => k.includes('occupant'));
  ok(occ.length === 1, `exactly one baked occupant node (${occ.join(',') || 'none'})`);
  const occBox = new THREE.Box3().setFromObject(byName.get(occ[0]));
  const occH = occBox.getSize(new THREE.Vector3()).y;
  ok(Math.abs(occH * 1.052632 - 1.725) < 5e-3,
     `occupant stands ${(occH * 1.052632).toFixed(4)} m at runtime scale (authored ${occH.toFixed(4)} m)`);
}

// ------------------------------------------------------------------- props
for (const [file, root, foot] of [['clone_pod.glb', 'Gear_clone_pod', [0.95, 0.95]],
                                  ['clone_terminal.glb', 'Gear_clone_terminal', [0.956, 0.792]]]) {
  const gltf = await load(file);
  const names = new Set(); gltf.scene.traverse((o) => names.add(o.name));
  ok(names.has(root), `${file}: root node ${root}`);
  ok((gltf.animations || []).length === 0, `${file}: no animations`);
  const box = new THREE.Box3().setFromObject(gltf.scene);
  const sz = box.getSize(new THREE.Vector3());
  ok(Math.abs(sz.x - foot[0]) < 5e-3 && Math.abs(sz.z - foot[1]) < 5e-3,
     `${file}: footprint ${sz.x.toFixed(4)} x ${sz.z.toFixed(4)} m (declared ${foot.join(' x ')})`);
  ok(Math.abs(box.min.y) < 1e-3, `${file}: sits on grade (min y ${box.min.y.toFixed(5)})`);
  console.log(`  ${file}: height ${sz.y.toFixed(4)} m`);
}

console.log(`\n${fails.length ? 'LOADER_PROOF_FAILED: ' + fails.length : 'LOADER_PROOF_OK'}`);
process.exit(fails.length ? 1 : 0);
