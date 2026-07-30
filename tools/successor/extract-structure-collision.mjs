#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

/**
 * Structure collision extractor — the mesh IS the collision source.
 *
 * Per-node AABBs are NOT collision-safe (a node containing two corner
 * pillars unions into a giant false solid across the doorway — verified on
 * house_H1), so this tool does it properly:
 *
 *   1. Decode every `wall_*` node's triangles from the GLB binary chunk.
 *   2. Keep triangles intersecting the PAWN HEIGHT BAND (y 0.15–1.90 m):
 *      floor slabs, lintels above the door opening, and parapets drop out;
 *      the door portal emerges as a genuine hole in the footprint.
 *   3. Rasterize the XZ projection of each kept triangle onto a fine grid
 *      (25 mm cells, conservative half-cell inflation).
 *   4. Greedy-merge the occupancy into axis-aligned boxes.
 *
 * Output `<asset>_collision.json` (GLB-local metres): merged wall boxes,
 * the door node's CLOSED-pose box, and the whole-model footprint the
 * renderer scales by (three's Box3.setFromObject equivalent). The fixture
 * generator applies the exact composePlacement math so sim + client collide
 * against the geometry the player SEES. No hand-authored numbers, ever.
 *
 * Usage: node tools/successor/extract-structure-collision.mjs <asset.glb> [...]
 */

const WALL_PREFIX = "wall_";
const DOOR_NODE = "door_slide";
/**
 * Solid cross-sections are taken by SLICING the wall meshes at these pawn-
 * band heights and parity-filling each slice (3D-printer-slicer approach) —
 * surface rasterization is NOT solid fill (vertical faces project to lines:
 * walls became paper strips and merge artifacts bridged the door portal).
 * Heights are epsilon-offset so slice planes never hit vertices exactly.
 * The union of slices blocks slit-window recesses while the door portal
 * (no wall geometry at any slice height) stays genuinely open.
 */
const SLICE_HEIGHTS = [0.4003, 1.0003, 1.6003];
const GRID_METERS = 0.025;

function parseGlb(glbPath) {
  const data = fs.readFileSync(glbPath);
  if (data.subarray(0, 4).toString("latin1") !== "glTF") {
    throw new Error(`${glbPath}: not a GLB container`);
  }
  const jsonLength = data.readUInt32LE(12);
  const gltf = JSON.parse(data.subarray(20, 20 + jsonLength).toString("utf8"));
  // BIN chunk follows the JSON chunk: [length u32][type "BIN\0"][payload].
  const binHeader = 20 + jsonLength;
  let bin = null;
  if (binHeader + 8 <= data.length) {
    const binLength = data.readUInt32LE(binHeader);
    const binType = data.subarray(binHeader + 4, binHeader + 8).toString("latin1");
    if (binType === "BIN\0") bin = data.subarray(binHeader + 8, binHeader + 8 + binLength);
  }
  if (!bin) throw new Error(`${glbPath}: BIN chunk missing`);
  return { gltf, bin };
}

function accessorArray(gltf, bin, accessorIndex) {
  const accessor = gltf.accessors[accessorIndex];
  if (accessor.sparse) throw new Error("sparse accessors unsupported by the structure extractor");
  const view = gltf.bufferViews[accessor.bufferView];
  const componentCounts = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
  const components = componentCounts[accessor.type];
  const componentBytes = bytesPer(accessor.componentType);
  const elementBytes = components * componentBytes;
  const stride = view.byteStride ?? elementBytes;
  const base = bin.byteOffset + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const makeView = (offset, length) => {
    switch (accessor.componentType) {
      case 5126: return new Float32Array(bin.buffer, offset, length);
      case 5125: return new Uint32Array(bin.buffer, offset, length);
      case 5123: return new Uint16Array(bin.buffer, offset, length);
      case 5121: return new Uint8Array(bin.buffer, offset, length);
      default: throw new Error(`unsupported accessor componentType ${accessor.componentType}`);
    }
  };
  if (stride === elementBytes) {
    return makeView(base, accessor.count * components);
  }
  // Interleaved bufferView: gather element-by-element honoring byteStride.
  const out = accessor.componentType === 5126
    ? new Float32Array(accessor.count * components)
    : new Uint32Array(accessor.count * components);
  for (let element = 0; element < accessor.count; element += 1) {
    const elementView = makeView(base + element * stride, components);
    for (let component = 0; component < components; component += 1) {
      out[element * components + component] = elementView[component];
    }
  }
  return out;
}

function bytesPer(componentType) {
  return componentType === 5126 || componentType === 5125 ? 4 : componentType === 5123 ? 2 : 1;
}

/** Column-major 4x4 world matrix for a node (TRS or `matrix`, parent chain). */
function nodeWorldMatrix(gltf, nodeIndex, parents) {
  const node = gltf.nodes[nodeIndex];
  const local = node.matrix ? node.matrix.slice() : trsMatrix(node);
  const parent = parents.get(nodeIndex);
  return parent === undefined ? local : multiply4(nodeWorldMatrix(gltf, parent, parents), local);
}

function trsMatrix(node) {
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x2 = qx + qx; const y2 = qy + qy; const z2 = qz + qz;
  const xx = qx * x2; const xy = qx * y2; const xz = qx * z2;
  const yy = qy * y2; const yz = qy * z2; const zz = qz * z2;
  const wx = qw * x2; const wy = qw * y2; const wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function multiply4(a, b) {
  const out = new Array(16).fill(0);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[col * 4 + row] = a[row] * b[col * 4] + a[4 + row] * b[col * 4 + 1] + a[8 + row] * b[col * 4 + 2] + a[12 + row] * b[col * 4 + 3];
    }
  }
  return out;
}

function applyMatrix(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

function extract(glbPath) {
  const { gltf, bin } = parseGlb(glbPath);
  const nodes = gltf.nodes ?? [];
  // Parent chain map (glTF stores children only).
  const parents = new Map();
  nodes.forEach((node, index) => {
    for (const child of node.children ?? []) parents.set(child, index);
  });

  let footprint = null;
  let door = null;
  const wallTriangles = [];

  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
    const node = nodes[nodeIndex];
    if (node.mesh === undefined) continue;
    const world = nodeWorldMatrix(gltf, nodeIndex, parents);
    const mesh = gltf.meshes[node.mesh];
    const name = node.name ?? "";

    for (const primitive of mesh.primitives ?? []) {
      const accessor = gltf.accessors[primitive.attributes?.POSITION];
      if (!accessor?.min || !accessor?.max) throw new Error(`${glbPath}: "${name}" lacks POSITION min/max`);
      // World AABB via the 8 transformed corners (exact for identity
      // pivots; conservative under any future rotation).
      let box = null;
      for (let corner = 0; corner < 8; corner += 1) {
        const [wx, wy, wz] = applyMatrix(
          world,
          (corner & 1) === 0 ? accessor.min[0] : accessor.max[0],
          (corner & 2) === 0 ? accessor.min[1] : accessor.max[1],
          (corner & 4) === 0 ? accessor.min[2] : accessor.max[2],
        );
        box = box === null
          ? { minX: wx, minY: wy, minZ: wz, maxX: wx, maxY: wy, maxZ: wz }
          : {
            minX: Math.min(box.minX, wx), minY: Math.min(box.minY, wy), minZ: Math.min(box.minZ, wz),
            maxX: Math.max(box.maxX, wx), maxY: Math.max(box.maxY, wy), maxZ: Math.max(box.maxZ, wz),
          };
      }
      footprint = footprint === null ? { ...box } : {
        minX: Math.min(footprint.minX, box.minX), minY: Math.min(footprint.minY, box.minY), minZ: Math.min(footprint.minZ, box.minZ),
        maxX: Math.max(footprint.maxX, box.maxX), maxY: Math.max(footprint.maxY, box.maxY), maxZ: Math.max(footprint.maxZ, box.maxZ),
      };
      if (name === DOOR_NODE) {
        door = {
          node: name,
          closed: { minX: r4(box.minX), minZ: r4(box.minZ), maxX: r4(box.maxX), maxZ: r4(box.maxZ) },
        };
        continue;
      }
      if (!name.startsWith(WALL_PREFIX)) continue;

      // Decode FULL 3D triangles for slice-based solid fill (world TRS).
      const positions = accessorArray(gltf, bin, primitive.attributes.POSITION);
      const indices = primitive.indices !== undefined
        ? accessorArray(gltf, bin, primitive.indices)
        : null;
      const triCount = (indices ? indices.length : positions.length / 3) / 3;
      for (let tri = 0; tri < triCount; tri += 1) {
        const i0 = indices ? indices[tri * 3] : tri * 3;
        const i1 = indices ? indices[tri * 3 + 1] : tri * 3 + 1;
        const i2 = indices ? indices[tri * 3 + 2] : tri * 3 + 2;
        const a = applyMatrix(world, positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]);
        const b = applyMatrix(world, positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
        const c = applyMatrix(world, positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]);
        wallTriangles.push([a, b, c]);
      }
    }
  }

  if (!footprint) throw new Error(`${glbPath}: no mesh nodes found`);
  if (wallTriangles.length === 0) throw new Error(`${glbPath}: no ${WALL_PREFIX}* triangles found`);

  const boxes = sliceAndMerge(wallTriangles, footprint);
  if (door) assertDoorCorridorOpen(glbPath, boxes, door.closed);

  const sidecar = {
    schema: "successor.structure-collision.v2",
    source: path.basename(glbPath),
    generatedBy: "tools/successor/extract-structure-collision.mjs",
    sliceHeights: SLICE_HEIGHTS,
    gridMeters: GRID_METERS,
    footprint: {
      minX: r4(footprint.minX), minZ: r4(footprint.minZ),
      maxX: r4(footprint.maxX), maxZ: r4(footprint.maxZ),
      spanX: r4(footprint.maxX - footprint.minX), spanZ: r4(footprint.maxZ - footprint.minZ),
      centerX: r4((footprint.minX + footprint.maxX) / 2), centerZ: r4((footprint.minZ + footprint.maxZ) / 2),
    },
    walls: boxes,
    door,
  };

  const outPath = glbPath.replace(/\.glb$/i, "_collision.json");
  fs.writeFileSync(outPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  return { outPath, wallBoxes: boxes.length, triangles: wallTriangles.length, door: Boolean(door) };
}

/**
 * Slice the wall meshes at SLICE_HEIGHTS, parity-fill each cross-section
 * into a shared occupancy grid, then greedy-merge into boxes.
 */
function sliceAndMerge(triangles, footprint) {
  const originX = footprint.minX;
  const originZ = footprint.minZ;
  const cols = Math.ceil((footprint.maxX - originX) / GRID_METERS) + 1;
  const rows = Math.ceil((footprint.maxZ - originZ) / GRID_METERS) + 1;
  const grid = new Uint8Array(cols * rows);

  for (const sliceY of SLICE_HEIGHTS) {
    // 1. Cross-section segments: triangle ∩ plane y = sliceY.
    const segments = [];
    for (const [a, b, c] of triangles) {
      const seg = trianglePlaneSegment(a, b, c, sliceY);
      if (seg) segments.push(seg);
    }
    // 2. Parity fill per grid row: sorted x-crossings of the row's z line.
    for (let row = 0; row < rows; row += 1) {
      const pz = originZ + (row + 0.5) * GRID_METERS;
      const crossings = [];
      for (const [x1, z1, x2, z2] of segments) {
        if (z1 === z2) continue; // tangent to the row line
        if ((z1 - pz) * (z2 - pz) > 0) continue;
        crossings.push(x1 + ((pz - z1) * (x2 - x1)) / (z2 - z1));
      }
      if (crossings.length < 2) continue;
      crossings.sort((left, right) => left - right);
      for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
        const startCol = Math.max(0, Math.round((crossings[pair] - originX) / GRID_METERS));
        const endCol = Math.min(cols - 1, Math.round((crossings[pair + 1] - originX) / GRID_METERS) - 1);
        for (let col = startCol; col <= endCol; col += 1) grid[row * cols + col] = 1;
      }
    }
  }

  // Greedy merge: horizontal runs, then extend runs downward while identical.
  const consumed = new Uint8Array(cols * rows);
  const boxes = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const at = row * cols + col;
      if (!grid[at] || consumed[at]) continue;
      let runEnd = col;
      while (runEnd + 1 < cols && grid[row * cols + runEnd + 1] && !consumed[row * cols + runEnd + 1]) runEnd += 1;
      let rowEnd = row;
      outer: while (rowEnd + 1 < rows) {
        for (let c = col; c <= runEnd; c += 1) {
          const below = (rowEnd + 1) * cols + c;
          if (!grid[below] || consumed[below]) break outer;
        }
        rowEnd += 1;
      }
      for (let rr = row; rr <= rowEnd; rr += 1) {
        for (let c = col; c <= runEnd; c += 1) consumed[rr * cols + c] = 1;
      }
      boxes.push({
        minX: r4(originX + col * GRID_METERS),
        minZ: r4(originZ + row * GRID_METERS),
        maxX: r4(originX + (runEnd + 1) * GRID_METERS),
        maxZ: r4(originZ + (rowEnd + 1) * GRID_METERS),
      });
    }
  }
  return boxes;
}

/** Triangle ∩ horizontal plane → XZ segment [x1, z1, x2, z2] or null. */
function trianglePlaneSegment(a, b, c, sliceY) {
  const points = [];
  for (const [p, q] of [[a, b], [b, c], [c, a]]) {
    const dp = p[1] - sliceY;
    const dq = q[1] - sliceY;
    if (dp === 0 && dq === 0) continue; // in-plane edge: handled by neighbors
    if (dp * dq > 0) continue;
    const t = dp / (dp - dq);
    points.push([p[0] + (q[0] - p[0]) * t, p[2] + (q[2] - p[2]) * t]);
  }
  if (points.length < 2) return null;
  const [p0, p1] = points;
  if (Math.abs(p0[0] - p1[0]) < 1e-9 && Math.abs(p0[1] - p1[1]) < 1e-9) return null;
  return [p0[0], p0[1], p1[0], p1[1]];
}

/**
 * INVARIANT: the door corridor (the closed door panel's footprint, jamb
 * margin inset, extended across the full wall depth) must contain ZERO
 * static wall cells — otherwise the doorway stays blocked even when open.
 */
function assertDoorCorridorOpen(glbPath, boxes, closedBox) {
  const corridor = {
    minX: closedBox.minX + 0.08,
    maxX: closedBox.maxX - 0.08,
    minZ: closedBox.minZ - 0.55,
    maxZ: closedBox.maxZ + 0.55,
  };
  const offenders = boxes.filter((box) => box.minX < corridor.maxX && box.maxX > corridor.minX
    && box.minZ < corridor.maxZ && box.maxZ > corridor.minZ);
  if (offenders.length > 0) {
    throw new Error(`${glbPath}: ${offenders.length} static wall box(es) intersect the door corridor ${JSON.stringify(corridor)}: ${JSON.stringify(offenders.slice(0, 4))}`);
  }
}

function r4(value) {
  return Math.round(value * 10000) / 10000;
}

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  console.error("usage: extract-structure-collision.mjs <asset.glb> [...]");
  process.exit(2);
}
for (const input of inputs) {
  const result = extract(path.resolve(input));
  console.log(JSON.stringify(result));
}
