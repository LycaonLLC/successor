/**
 * Prove, from the SHIPPED GLB, that each terminal's interaction face points at
 * the customer.
 *
 * Pass-3 review defect 1: all three terminals faced backward, showing service
 * backs, vents and access panels to the customer.  The placement code had
 * reasoned from the terminal manifests' prose ("front is +Z") to a 180 deg
 * yaw, which was exactly wrong, and nothing in the check set could tell.
 *
 * This measures instead of reasoning.  It walks the furnished GLB, finds each
 * terminal's screen/interaction primitives by material name, takes the LARGEST
 * triangle of each (the screen plane itself, not the bezel returns, which
 * cancel), transforms its normal to world space, and asserts it points +Z --
 * the public/customer side in asset space.
 *
 *   node src/term_face_proof.mjs build/market_house_furnished.glb
 */
import { NodeIO } from '@gltf-transform/core';
import { KHRMaterialsEmissiveStrength, ALL_EXTENSIONS } from '@gltf-transform/extensions';

const path = process.argv[2] || 'build/market_house_furnished.glb';

// The furnished GLB flattens the imported prop hierarchies, so node names
// carry no terminal prefix.  Key off each terminal's own unique SCREEN
// material instead -- CM_ScreenBank / CM_ScreenTrade / CM_ScreenPA are
// one-per-terminal and are the interaction surface by definition.
const TERMS = [
  { key: 'bank', match: /^CM_ScreenBank/i },
  { key: 'trade', match: /^CM_ScreenTrade/i },
  { key: 'assoc', match: /^CM_ScreenPA/i },
];
const SCREEN = /^CM_Screen/i;

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(path);
const root = doc.getRoot();

function nodeWorld(node) {
  // compose parent chain
  let m = node.getWorldMatrix ? node.getWorldMatrix() : null;
  if (m) return m;
  return null;
}

function mul(a, b) {
  const o = new Array(16).fill(0);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++)
      for (let k = 0; k < 4; k++) o[j * 4 + i] += a[k * 4 + i] * b[j * 4 + k];
  return o;
}

function localMatrix(node) {
  const t = node.getTranslation(), r = node.getRotation(), s = node.getScale();
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

function xformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function len(a) { return Math.hypot(a[0], a[1], a[2]); }

// walk scene graph accumulating world matrices
const found = {};
function walk(node, parent) {
  const m = mul(parent, localMatrix(node));
  const mesh = node.getMesh();
  if (mesh) {
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      const mname = mat ? mat.getName() : '';
      if (!SCREEN.test(mname)) continue;
      const term = TERMS.find((t) => t.match.test(mname));
      if (!term) continue;
      const pos = prim.getAttribute('POSITION');
      const idx = prim.getIndices();
      const n = idx ? idx.getCount() : pos.getCount();
      let bestArea = -1, bestN = null, bestC = null;
      for (let i = 0; i + 2 < n; i += 3) {
        const ia = idx ? idx.getScalar(i) : i;
        const ib = idx ? idx.getScalar(i + 1) : i + 1;
        const ic = idx ? idx.getScalar(i + 2) : i + 2;
        const a = xformPoint(m, pos.getElement(ia, [0, 0, 0]));
        const b = xformPoint(m, pos.getElement(ib, [0, 0, 0]));
        const c = xformPoint(m, pos.getElement(ic, [0, 0, 0]));
        const nv = cross(sub(b, a), sub(c, a));
        const area = len(nv) / 2;
        if (area > bestArea) {
          bestArea = area;
          bestN = [nv[0] / (2 * area), nv[1] / (2 * area), nv[2] / (2 * area)];
          bestC = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
        }
      }
      if (bestN) {
        const cur = found[term.key];
        if (!cur || bestArea > cur.area) {
          found[term.key] = { area: bestArea, n: bestN, c: bestC, material: mname };
        }
      }
    }
  }
  for (const ch of node.listChildren()) walk(ch, m);
}

const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
for (const scene of root.listScenes()) for (const nd of scene.listChildren()) walk(nd, I);

let fails = 0;
console.log('  terminal interaction-face normals, measured from the shipped GLB:');
for (const t of TERMS) {
  const f = found[t.key];
  if (!f) {
    console.log(`  FAIL  ${t.key}: no screen primitive found`);
    fails++;
    continue;
  }
  const nz = f.n[2];
  const ok = nz > 0.5;
  if (!ok) fails++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${t.key.padEnd(6)} ${f.material.padEnd(15)} ` +
    `largest screen face n=(${f.n.map((v) => v.toFixed(3)).join(', ')}) ` +
    `at z=${f.c[2].toFixed(3)}  -> ${nz > 0.5 ? 'faces +Z (customer)' : 'FACES AWAY FROM CUSTOMER'}`);
}
if (fails) {
  console.error(`TERM_FACE_FAIL: ${fails} terminal(s) do not face the customer`);
  process.exit(1);
}
console.log('TERM_FACE_OK');
