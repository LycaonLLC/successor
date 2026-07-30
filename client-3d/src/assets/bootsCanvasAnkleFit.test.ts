import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Fixed-issue footwear runtime-fit contract (owner program 2026-07-18).
 *
 * boots_canvas_ankle is worn OVER under_bodysuit; the runtime replaces
 * equipment materials with FRONT-SIDE-ONLY matcaps (equipmentMaterials.ts),
 * so the boot must (1) fully enclose the bodysuit's foot region — not just
 * the bare body — and (2) wind every face outward or it becomes invisible
 * in-world even though Blender/doubleSided previews look perfect. Both
 * failure modes shipped once; this test pins them.
 */

const publicRoot = resolve(process.cwd(), "public");
const BOOT = resolve(publicRoot, "assets/pawn-pack/equipment/Under/boots_canvas_ankle.glb");
const SUIT = resolve(publicRoot, "assets/pawn-pack/equipment/Under/under_bodysuit.glb");

interface Gltf {
  meshes?: Array<{ name?: string; primitives: Array<{ attributes: Record<string, number>; indices?: number; material?: number }> }>;
  materials?: Array<{ name?: string; doubleSided?: boolean }>;
  skins?: Array<{ joints: number[] }>;
  nodes?: Array<{ name?: string }>;
  accessors: Array<{ bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string }>;
  bufferViews: Array<{ byteOffset?: number; byteLength: number; byteStride?: number }>;
}

function readGlb(path: string): { gltf: Gltf; bin: DataView } {
  const raw = readFileSync(path);
  const data = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  expect(data.getUint32(0, true)).toBe(0x46546c67);
  let offset = 12;
  let gltf: Gltf | null = null;
  let bin: DataView | null = null;
  while (offset < data.byteLength) {
    const chunkLength = data.getUint32(offset, true);
    const chunkType = data.getUint32(offset + 4, true);
    const start = offset + 8;
    if (chunkType === 0x4e4f534a) {
      gltf = JSON.parse(Buffer.from(raw.buffer, raw.byteOffset + start, chunkLength).toString("utf8")) as Gltf;
    } else if (chunkType === 0x004e4942) {
      bin = new DataView(raw.buffer, raw.byteOffset + start, chunkLength);
    }
    offset = start + chunkLength;
  }
  if (!gltf || !bin) throw new Error(`bad GLB: ${path}`);
  return { gltf, bin };
}

const COMPONENT_SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNT: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(gltf: Gltf, bin: DataView, index: number): number[][] {
  const accessor = gltf.accessors[index]!;
  const view = gltf.bufferViews[accessor.bufferView ?? 0]!;
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const components = TYPE_COUNT[accessor.type]!;
  const size = COMPONENT_SIZE[accessor.componentType]!;
  const stride = view.byteStride ?? components * size;
  const out: number[][] = [];
  for (let i = 0; i < accessor.count; i += 1) {
    const row: number[] = [];
    for (let c = 0; c < components; c += 1) {
      const at = base + i * stride + c * size;
      row.push(
        accessor.componentType === 5126 ? bin.getFloat32(at, true)
          : accessor.componentType === 5123 ? bin.getUint16(at, true)
            : accessor.componentType === 5125 ? bin.getUint32(at, true)
              : bin.getUint8(at),
      );
    }
    out.push(row);
  }
  return out;
}

function footRegionBounds(path: string, footBone: "foot_l" | "foot_r"): { min: number[]; max: number[] } {
  const { gltf, bin } = readGlb(path);
  const jointNames = gltf.skins![0]!.joints.map((j) => gltf.nodes![j]!.name);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of gltf.meshes ?? []) {
    for (const prim of mesh.primitives) {
      if (!("JOINTS_0" in prim.attributes)) continue;
      const positions = readAccessor(gltf, bin, prim.attributes.POSITION!);
      const joints = readAccessor(gltf, bin, prim.attributes.JOINTS_0!);
      const weights = readAccessor(gltf, bin, prim.attributes.WEIGHTS_0!);
      const weightScale = gltf.accessors[prim.attributes.WEIGHTS_0!]!.componentType === 5121 ? 255
        : gltf.accessors[prim.attributes.WEIGHTS_0!]!.componentType === 5123 ? 65535 : 1;
      for (let i = 0; i < positions.length; i += 1) {
        const isFoot = joints[i]!.some((j, k) => weights[i]![k]! / weightScale > 0.3 && jointNames[j] === footBone);
        if (!isFoot) continue;
        for (let axis = 0; axis < 3; axis += 1) {
          min[axis] = Math.min(min[axis]!, positions[i]![axis]!);
          max[axis] = Math.max(max[axis]!, positions[i]![axis]!);
        }
      }
    }
  }
  return { min, max };
}

describe("boots_canvas_ankle runtime fit contract", () => {
  it("keeps the wardrobe material contract (3 dye-slot materials, doubleSided source)", () => {
    const { gltf } = readGlb(BOOT);
    const names = (gltf.materials ?? []).map((m) => m.name);
    expect(names).toEqual(["boots_canvas_ankle_c0", "boots_canvas_ankle_c1", "boots_canvas_ankle_c3"]);
    for (const material of gltf.materials ?? []) expect(material.doubleSided).toBe(true);
    expect((gltf.meshes ?? []).map((m) => m.name)).toEqual(["boots_canvas_ankle_l", "boots_canvas_ankle_r"]);
  });

  it("encloses the WORN bodysuit foot region (not just the bare body) on both feet", () => {
    for (const [footBone, side] of [["foot_l", 1], ["foot_r", -1]] as const) {
      const suit = footRegionBounds(SUIT, footBone);
      const { gltf, bin } = readGlb(BOOT);
      const meshIndex = footBone === "foot_l" ? 0 : 1;
      const bootMin = [Infinity, Infinity, Infinity];
      const bootMax = [-Infinity, -Infinity, -Infinity];
      for (const prim of gltf.meshes![meshIndex]!.primitives) {
        const positions = readAccessor(gltf, bin, prim.attributes.POSITION!);
        for (const p of positions) {
          for (let axis = 0; axis < 3; axis += 1) {
            bootMin[axis] = Math.min(bootMin[axis]!, p[axis]!);
            bootMax[axis] = Math.max(bootMax[axis]!, p[axis]!);
          }
        }
      }
      // The boot shell must reach past the suit's foot cloud on every axis
      // (except upward, where the leg exits the collar). 2 mm slack, BOTH
      // X sides, BOTH feet — no side may degrade to a no-op.
      void side;
      const slack = 0.002;
      expect(bootMin[0]!).toBeLessThanOrEqual(suit.min[0]! + slack);
      expect(bootMax[0]!).toBeGreaterThanOrEqual(suit.max[0]! - slack);
      expect(bootMin[1]!).toBeLessThanOrEqual(suit.min[1]!);          // sole under-reach
      expect(bootMin[2]!).toBeLessThanOrEqual(suit.min[2]! + slack);  // heel
      expect(bootMax[2]!).toBeGreaterThanOrEqual(suit.max[2]! - slack); // toe
    }
  });

  it("winds boot faces outward (runtime equipment materials are front-side only)", () => {
    const { gltf, bin } = readGlb(BOOT);
    for (const mesh of gltf.meshes ?? []) {
      const centerX = mesh.name === "boots_canvas_ankle_l" ? 0.086 : -0.086;
      for (const prim of mesh.primitives) {
        const material = gltf.materials![prim.material ?? 0]!.name ?? "";
        const positions = readAccessor(gltf, bin, prim.attributes.POSITION!);
        const indices = readAccessor(gltf, bin, prim.indices!).map((row) => row[0]!);
        let outward = 0;
        let total = 0;
        for (let i = 0; i < indices.length; i += 3) {
          const [a, b, c] = [positions[indices[i]!]!, positions[indices[i + 1]!]!, positions[indices[i + 2]!]!];
          const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
          const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
          const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
          const cx = (a[0]! + b[0]! + c[0]!) / 3;
          const cy = (a[1]! + b[1]! + c[1]!) / 3;
          const cz = (a[2]! + b[2]! + c[2]!) / 3;
          // interior reference: shaft axis above the ankle, foot core below
          const ref = cy > 0.09 ? [centerX, cy, 0.0] : [centerX, Math.min(cy + 0.02, 0.055), Math.max(-0.03, Math.min(cz, 0.17))];
          const d = [cx - ref[0]!, cy - ref[1]!, cz - ref[2]!];
          const dot = n[0]! * d[0]! + n[1]! * d[1]! + n[2]! * d[2]!;
          total += 1;
          if (dot > 0) outward += 1;
        }
        // the interior liner sleeve (part of c1) legitimately faces inward,
        // and a few heel-counter/lace faces sit oblique to this coarse ref
        // heuristic; the contract pins "overwhelmingly outward" (the broken
        // pre-fix dome measured ~0.5 on c1).
        const threshold = material.endsWith("_c1") ? 0.8 : material.endsWith("_c3") ? 0.7 : 0.9;
        // c3 (outsole slab): its top ring legitimately faces up into the
        // hidden shell interior, which this coarse core-point heuristic
        // counts as inward — the fully inverted pre-fix state measured ~0.5.
        expect(outward / total, `${mesh.name} ${material} outward fraction`).toBeGreaterThan(threshold);
      }
    }
  });

  it("skins with the pack-native BINARY foot/calf split (gradient blends smear against the binary bodysuit and read as collapse)", () => {
    const { gltf, bin } = readGlb(BOOT);
    for (const mesh of gltf.meshes ?? []) {
      for (const prim of mesh.primitives) {
        const weights = readAccessor(gltf, bin, prim.attributes.WEIGHTS_0!);
        for (const w of weights) {
          const sorted = [...w].sort((a, b) => b - a);
          expect(sorted[0]!).toBeGreaterThan(0.999); // dominant bone owns the vertex fully
          expect(sorted[1]!).toBeLessThan(0.001);
        }
      }
    }
  });

  it("keeps c0 as the cuff trim ring only (simplified basic-boot contract: no layered foot panels)", () => {
    const { gltf, bin } = readGlb(BOOT);
    for (const mesh of gltf.meshes ?? []) {
      for (const prim of mesh.primitives) {
        const material = gltf.materials![prim.material ?? 0]!.name!;
        if (!material.endsWith("_c0")) continue;
        const positions = readAccessor(gltf, bin, prim.attributes.POSITION!);
        expect(positions.length).toBeGreaterThan(20);
        for (const p of positions) {
          // the ONLY light-panel geometry is the collar trim band; anything
          // lower reintroduces the layered-shell interleaving failure mode
          expect(p[1]!).toBeGreaterThan(0.18);
        }
      }
    }
  });
});
