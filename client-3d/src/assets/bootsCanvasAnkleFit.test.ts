import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Fixed-issue footwear runtime-fit contract.
 *
 * The bodysuit now terminates at the ankle and the boot owns the foot zones.
 * Each sex therefore ships a boot authored from its promoted body: the shell
 * must enclose that body's feet, retain the three dye materials with outward
 * faces, and preserve smooth body-native weights so the shaft follows hard
 * ankle folds instead of detaching as the former binary split did.
 */

const publicRoot = resolve(process.cwd(), "public");
const pawnPack = resolve(publicRoot, "assets/pawn-pack");
const CASES = [
  {
    label: "male",
    body: resolve(pawnPack, "pawn_male.glb"),
    boot: resolve(pawnPack, "equipment/Under/boots_canvas_ankle.glb"),
  },
  {
    label: "female",
    body: resolve(pawnPack, "pawn_female.glb"),
    boot: resolve(pawnPack, "equipment/Female/Under/boots_canvas_ankle.glb"),
  },
] as const;

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
  it("keeps the wardrobe material and mesh contract on both authored variants", () => {
    for (const variant of CASES) {
      const { gltf } = readGlb(variant.boot);
      const names = (gltf.materials ?? []).map((material) => material.name);
      expect(names, variant.label).toEqual([
        "boots_canvas_ankle_c0",
        "boots_canvas_ankle_c1",
        "boots_canvas_ankle_c3",
      ]);
      for (const material of gltf.materials ?? []) {
        expect(material.doubleSided, `${variant.label} ${material.name}`).toBe(true);
      }
      expect((gltf.meshes ?? []).map((mesh) => mesh.name), variant.label).toEqual([
        "boots_canvas_ankle_l",
        "boots_canvas_ankle_r",
      ]);
    }
  });

  it("encloses each promoted body's foot region on both feet", () => {
    for (const variant of CASES) {
      const { gltf, bin } = readGlb(variant.boot);
      for (const [footBone, meshIndex] of [["foot_l", 0], ["foot_r", 1]] as const) {
        const body = footRegionBounds(variant.body, footBone);
        expect(body.min.every(Number.isFinite), `${variant.label} ${footBone} body minimum`).toBe(true);
        expect(body.max.every(Number.isFinite), `${variant.label} ${footBone} body maximum`).toBe(true);

        const bootMin = [Infinity, Infinity, Infinity];
        const bootMax = [-Infinity, -Infinity, -Infinity];
        for (const primitive of gltf.meshes![meshIndex]!.primitives) {
          for (const position of readAccessor(gltf, bin, primitive.attributes.POSITION!)) {
            for (let axis = 0; axis < 3; axis += 1) {
              bootMin[axis] = Math.min(bootMin[axis]!, position[axis]!);
              bootMax[axis] = Math.max(bootMax[axis]!, position[axis]!);
            }
          }
        }

        const slack = 0.002;
        expect(bootMin[0]!, `${variant.label} ${footBone} inner/outer x`).toBeLessThanOrEqual(body.min[0]! + slack);
        expect(bootMax[0]!, `${variant.label} ${footBone} inner/outer x`).toBeGreaterThanOrEqual(body.max[0]! - slack);
        expect(bootMin[1]!, `${variant.label} ${footBone} sole`).toBeLessThanOrEqual(body.min[1]!);
        expect(bootMin[2]!, `${variant.label} ${footBone} heel`).toBeLessThanOrEqual(body.min[2]! + slack);
        expect(bootMax[2]!, `${variant.label} ${footBone} toe`).toBeGreaterThanOrEqual(body.max[2]! - slack);
      }
    }
  });

  it("winds boot faces outward for the runtime's front-side materials", () => {
    for (const variant of CASES) {
      const { gltf, bin } = readGlb(variant.boot);
      for (const [meshIndex, mesh] of (gltf.meshes ?? []).entries()) {
        const footBone = meshIndex === 0 ? "foot_l" : "foot_r";
        const body = footRegionBounds(variant.body, footBone);
        const centerX = (body.min[0]! + body.max[0]!) * 0.5;
        for (const primitive of mesh.primitives) {
          const material = gltf.materials![primitive.material ?? 0]!.name ?? "";
          const positions = readAccessor(gltf, bin, primitive.attributes.POSITION!);
          const indices = readAccessor(gltf, bin, primitive.indices!).map((row) => row[0]!);
          let outward = 0;
          let total = 0;
          for (let i = 0; i < indices.length; i += 3) {
            const [a, b, c] = [
              positions[indices[i]!]!,
              positions[indices[i + 1]!]!,
              positions[indices[i + 2]!]!,
            ];
            const u = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
            const v = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
            const normal = [
              u[1]! * v[2]! - u[2]! * v[1]!,
              u[2]! * v[0]! - u[0]! * v[2]!,
              u[0]! * v[1]! - u[1]! * v[0]!,
            ];
            const cx = (a[0]! + b[0]! + c[0]!) / 3;
            const cy = (a[1]! + b[1]! + c[1]!) / 3;
            const cz = (a[2]! + b[2]! + c[2]!) / 3;
            const reference = cy > 0.09
              ? [centerX, cy, 0]
              : [centerX, Math.min(cy + 0.02, 0.055), Math.max(-0.03, Math.min(cz, 0.17))];
            const radial = [cx - reference[0]!, cy - reference[1]!, cz - reference[2]!];
            const dot = normal[0]! * radial[0]! + normal[1]! * radial[1]! + normal[2]! * radial[2]!;
            total += 1;
            if (dot > 0) outward += 1;
          }
          // c0/c3 include inward-facing cuff/outsole thickness. The exterior
          // still has a clear outward majority; a fully inverted shell is ~0.5.
          const threshold = material.endsWith("_c1") ? 0.8 : 0.7;
          expect(outward / total, `${variant.label} ${mesh.name} ${material}`).toBeGreaterThan(threshold);
        }
      }
    }
  });

  it("preserves normalized smooth body-native skin weights", () => {
    for (const variant of CASES) {
      const { gltf, bin } = readGlb(variant.boot);
      let blendedRows = 0;
      for (const mesh of gltf.meshes ?? []) {
        for (const primitive of mesh.primitives) {
          const accessorIndex = primitive.attributes.WEIGHTS_0!;
          const accessor = gltf.accessors[accessorIndex]!;
          const scale = accessor.componentType === 5121 ? 255 : accessor.componentType === 5123 ? 65535 : 1;
          for (const encoded of readAccessor(gltf, bin, accessorIndex)) {
            const weights = encoded.map((weight) => weight / scale);
            expect(weights.every((weight) => Number.isFinite(weight) && weight >= 0 && weight <= 1)).toBe(true);
            expect(weights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 4);
            const sorted = [...weights].sort((a, b) => b - a);
            if (sorted[1]! > 0.01) blendedRows += 1;
          }
        }
      }
      expect(blendedRows, `${variant.label} blended ankle rows`).toBeGreaterThan(0);
    }
  });

  it("keeps c0 confined to the authored 185-215 mm cuff band", () => {
    for (const variant of CASES) {
      const { gltf, bin } = readGlb(variant.boot);
      for (const mesh of gltf.meshes ?? []) {
        for (const primitive of mesh.primitives) {
          const material = gltf.materials![primitive.material ?? 0]!.name!;
          if (!material.endsWith("_c0")) continue;
          const positions = readAccessor(gltf, bin, primitive.attributes.POSITION!);
          expect(positions.length, `${variant.label} ${mesh.name} trim vertices`).toBeGreaterThan(20);
          for (const position of positions) {
            expect(position[1]!, `${variant.label} trim minimum`).toBeGreaterThan(0.18);
            expect(position[1]!, `${variant.label} trim maximum`).toBeLessThan(0.225);
          }
        }
      }
    }
  });
});
