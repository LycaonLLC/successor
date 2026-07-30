import { NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import fs from 'fs'; import path from 'path';
const PD = path.resolve('../../../../client-3d/public/assets/world-items');
const names = process.argv.slice(2);
const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);
for (const n of names) {
  const doc = await io.read(path.join(PD, n + '.glb'));
  const root = doc.getRoot();
  let mn=[1e9,1e9,1e9], mx=[-1e9,-1e9,-1e9], tris=0;
  const walk = (node, m) => {
    const t = node.getMatrix();
    const M = mul(m, t);
    const mesh = node.getMesh();
    if (mesh) for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      const idx = prim.getIndices();
      tris += (idx ? idx.getCount() : pos.getCount())/3;
      for (let i=0;i<pos.getCount();i++){
        const p=[0,0,0]; pos.getElement(i,p);
        const w=xf(M,p);
        for(let k=0;k<3;k++){mn[k]=Math.min(mn[k],w[k]);mx[k]=Math.max(mx[k],w[k]);}
      }
    }
    for (const c of node.listChildren()) walk(c, M);
  };
  const I=[1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  for (const s of root.listScenes()) for (const nd of s.listChildren()) walk(nd, I);
  const sz = mx.map((v,i)=>v-mn[i]);
  console.log(`${n.padEnd(26)} size=[${sz.map(v=>v.toFixed(3)).join(', ')}] min=[${mn.map(v=>v.toFixed(3)).join(', ')}] max=[${mx.map(v=>v.toFixed(3)).join(', ')}] tris=${tris} mats=${root.listMaterials().length}`);
}
function mul(a,b){const o=new Array(16).fill(0);for(let r=0;r<4;r++)for(let c=0;c<4;c++)for(let k=0;k<4;k++)o[c*4+r]+=a[k*4+r]*b[c*4+k];return o;}
function xf(m,p){return [m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12], m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13], m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]];}
