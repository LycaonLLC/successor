import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DodecahedronGeometry,
  IcosahedronGeometry,
  MeshMatcapMaterial,
  type Texture,
} from "three";
import { createPawnMatcapTexture } from "../pawns";
import { createForestFloraVariants, type ForestFloraVariants } from "./generators-forest";

export type DesertFloraStaticSpecies = "cactus_sentinel" | "shrub_thorn" | "snag_acacia" | "rock";
export type ForestFloraStaticSpecies = "pine" | "broadleaf" | "sapling" | "fern" | "log" | "mossy_boulder" | "stump";
export type FloraStaticSpecies = DesertFloraStaticSpecies | ForestFloraStaticSpecies;
export type FloraSpecies = FloraStaticSpecies | "tumbleweed";

export interface FloraWindUniforms {
  readonly uFloraWindTime: { value: number };
  readonly uFloraWindX: { value: number };
  readonly uFloraWindZ: { value: number };
  readonly uFloraWindStrength: { value: number };
  readonly uFloraWindGust: { value: number };
}

interface FloraShader {
  uniforms: Record<string, { value: unknown }>;
  vertexShader: string;
}

/** World-collision primitive a variant carries (local space; scaled/yawed per placement). */
export type FloraColliderShape =
  | { kind: "circle"; radius: number }
  | { kind: "segment"; ax: number; az: number; bx: number; bz: number; radius: number };

export interface FloraVariant {
  readonly key: string;
  readonly species: FloraStaticSpecies;
  readonly geometry: BufferGeometry;
  readonly materials: MeshMatcapMaterial | MeshMatcapMaterial[];
  /** Present = pawns collide (titan trunks, stumps, fallen boughs). */
  readonly collider?: FloraColliderShape;
}

export interface DesertFloraVariants {
  readonly cactus: readonly FloraVariant[];
  readonly shrubs: readonly FloraVariant[];
  readonly snags: readonly FloraVariant[];
  readonly rocks: readonly FloraVariant[];
}

export interface FloraGeometryKit {
  readonly matcap: Texture;
  readonly windUniforms: FloraWindUniforms;
  readonly desert: DesertFloraVariants;
  readonly forest: ForestFloraVariants;
  readonly cactus: readonly FloraVariant[];
  readonly shrubs: readonly FloraVariant[];
  readonly snags: readonly FloraVariant[];
  readonly rocks: readonly FloraVariant[];
  readonly tumbleweedGeometry: BufferGeometry;
  readonly tumbleweedMaterial: MeshMatcapMaterial;
  dispose(): void;
}

export const TUMBLEWEED_BASE_RADIUS = 0.5;

interface GeometryGroup {
  materialIndex: number;
  start: number;
  count: number;
}

export class VariantRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = Math.imul(this.state ^ (this.state >>> 15), 0x2c1b3c6d) >>> 0;
    this.state = Math.imul(this.state ^ (this.state >>> 12), 0x297a2d39) >>> 0;
    this.state = (this.state ^ (this.state >>> 15)) >>> 0;
    return this.state / 0xffffffff;
  }

  range(min: number, max: number): number {
    const t = this.next();
    return min + (max - min) * t;
  }

  int(min: number, max: number): number {
    const span = max - min + 1;
    return min + Math.floor(this.next() * span);
  }
}

export class FacetBuilder {
  readonly positions: number[] = [];
  private readonly groups: GeometryGroup[] = [];
  private currentMaterial = -1;

  addTri(materialIndex: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): void {
    this.beginMaterial(materialIndex);
    this.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    const group = this.groups[this.groups.length - 1];
    if (group) group.count += 3;
  }

  addQuad(materialIndex: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number): void {
    this.addTri(materialIndex, ax, ay, az, bx, by, bz, cx, cy, cz);
    this.addTri(materialIndex, ax, ay, az, cx, cy, cz, dx, dy, dz);
  }

  toGeometry(name: string, addSwayAttribute: boolean): BufferGeometry {
    const geometry = new BufferGeometry();
    geometry.name = name;
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(this.positions), 3));
    for (let i = 0; i < this.groups.length; i += 1) {
      const group = this.groups[i]!;
      geometry.addGroup(group.start, group.count, group.materialIndex);
    }
    if (addSwayAttribute) this.addSwayAttribute(geometry);
    geometry.computeVertexNormals();
    return geometry;
  }

  private beginMaterial(materialIndex: number): void {
    if (this.currentMaterial === materialIndex) return;
    this.currentMaterial = materialIndex;
    this.groups.push({ materialIndex, start: this.positions.length / 3, count: 0 });
  }

  private addSwayAttribute(geometry: BufferGeometry): void {
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 1; i < this.positions.length; i += 3) {
      const y = this.positions[i]!;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const invHeight = maxY > minY ? 1 / (maxY - minY) : 0;
    const sway = new Float32Array(this.positions.length / 3);
    for (let i = 0; i < sway.length; i += 1) {
      const y = this.positions[i * 3 + 1]!;
      const normalized = Math.max(0, Math.min(1, (y - minY) * invHeight));
      sway[i] = normalized * normalized;
    }
    geometry.setAttribute("floraSway", new BufferAttribute(sway, 1));
  }
}

export function createFloraGeometryKit(): FloraGeometryKit {
  const matcap = createPawnMatcapTexture();
  const windUniforms = createWindUniforms();
  const materials: MeshMatcapMaterial[] = [];

  const cactusMaterials = [
    createMatcapMaterial(matcap, "#a8ad8e", true, windUniforms, materials),
    createMatcapMaterial(matcap, "#8f9678", true, windUniforms, materials),
    createMatcapMaterial(matcap, "#747c60", true, windUniforms, materials),
    createMatcapMaterial(matcap, "#585f4c", true, windUniforms, materials),
  ];
  const shrubMaterials = [
    createMatcapMaterial(matcap, "#6b6350", true, windUniforms, materials),
    createMatcapMaterial(matcap, "#55503f", true, windUniforms, materials),
  ];
  const snagMaterials = [
    createMatcapMaterial(matcap, "#5c5344", false, windUniforms, materials),
    createMatcapMaterial(matcap, "#4a4236", false, windUniforms, materials),
  ];
  const rockMaterials = [
    createMatcapMaterial(matcap, "#c4ad83", false, windUniforms, materials),
    createMatcapMaterial(matcap, "#a08a64", false, windUniforms, materials),
    createMatcapMaterial(matcap, "#75654c", false, windUniforms, materials),
  ];
  const tumbleweedMaterial = createMatcapMaterial(matcap, "#99865f", false, windUniforms, materials);

  const cactus: FloraVariant[] = [];
  for (let i = 0; i < 4; i += 1) {
    cactus.push({
      key: `cactus_sentinel:${i}`,
      species: "cactus_sentinel",
      geometry: createCactusGeometry(0xCA7705 + i * 0x1f3d, i),
      materials: cactusMaterials,
    });
  }

  const shrubs: FloraVariant[] = [];
  for (let i = 0; i < 2; i += 1) {
    shrubs.push({
      key: `shrub_thorn:${i}`,
      species: "shrub_thorn",
      geometry: createShrubGeometry(0x5A12B + i * 0x2d51, i),
      materials: shrubMaterials,
    });
  }

  const snags: FloraVariant[] = [];
  for (let i = 0; i < 4; i += 1) {
    snags.push({
      key: `snag_acacia:${i}`,
      species: "snag_acacia",
      geometry: createSnagGeometry(0xACAC1A + i * 0x3331, i),
      materials: snagMaterials,
    });
  }

  const rocks: FloraVariant[] = [];
  for (let i = 0; i < 3; i += 1) {
    rocks.push({
      key: `rock:${i}`,
      species: "rock",
      geometry: createRockGeometry(0xB011D3 + i * 0x571, i),
      materials: rockMaterials,
    });
  }

  const tumbleweedGeometry = createTumbleweedGeometry(0x7A3B1E);
  const forest = createForestFloraVariants(matcap, windUniforms);


  return {
    matcap,
    windUniforms,
    forest,
    desert: { cactus, shrubs, snags, rocks },
    cactus,
    shrubs,
    snags,
    rocks,
    tumbleweedGeometry,
    tumbleweedMaterial,
    dispose() {
      for (let i = 0; i < cactus.length; i += 1) cactus[i]!.geometry.dispose();
      for (let i = 0; i < shrubs.length; i += 1) shrubs[i]!.geometry.dispose();
      for (let i = 0; i < snags.length; i += 1) snags[i]!.geometry.dispose();
      for (let i = 0; i < rocks.length; i += 1) rocks[i]!.geometry.dispose();
      const forestMaterials = new Set<MeshMatcapMaterial>();
      disposeForestVariants(forest.pines, forestMaterials);
      disposeForestVariants(forest.broadleafs, forestMaterials);
      disposeForestVariants(forest.saplings, forestMaterials);
      disposeForestVariants(forest.ferns, forestMaterials);
      disposeForestVariants(forest.logs, forestMaterials);
      disposeForestVariants(forest.mossyBoulders, forestMaterials);
      disposeForestVariants(forest.stumps, forestMaterials);
      tumbleweedGeometry.dispose();
      for (let i = 0; i < materials.length; i += 1) materials[i]!.dispose();
      for (const material of forestMaterials) material.dispose();
      matcap.dispose();
    },
  };
}

function disposeForestVariants(variants: readonly FloraVariant[], materials: Set<MeshMatcapMaterial>): void {
  for (let i = 0; i < variants.length; i += 1) {
    const variant = variants[i]!;
    variant.geometry.dispose();
    collectForestMaterials(variant.materials, materials);
  }
}

function collectForestMaterials(source: MeshMatcapMaterial | readonly MeshMatcapMaterial[], materials: Set<MeshMatcapMaterial>): void {
  if (source instanceof MeshMatcapMaterial) {
    materials.add(source);
    return;
  }
  for (let i = 0; i < source.length; i += 1) materials.add(source[i]!);
}

export function updateFloraWindUniforms(uniforms: FloraWindUniforms, wind: { dirX: number; dirZ: number; strength01: number; gust01: number }, nowMs: number): void {
  uniforms.uFloraWindTime.value = nowMs * 0.001;
  uniforms.uFloraWindX.value = wind.dirX;
  uniforms.uFloraWindZ.value = wind.dirZ;
  uniforms.uFloraWindStrength.value = wind.strength01;
  uniforms.uFloraWindGust.value = wind.gust01;
}

function createWindUniforms(): FloraWindUniforms {
  return {
    uFloraWindTime: { value: 0 },
    uFloraWindX: { value: 1 },
    uFloraWindZ: { value: 0 },
    uFloraWindStrength: { value: 0 },
    uFloraWindGust: { value: 0 },
  };
}

function createMatcapMaterial(matcap: Texture, colorHex: string, sway: boolean, uniforms: FloraWindUniforms, materials: MeshMatcapMaterial[]): MeshMatcapMaterial {
  const material = new MeshMatcapMaterial({ matcap, color: new Color(colorHex), flatShading: true, fog: true });
  material.name = `flora:${colorHex}`;
  if (sway) installWindSway(material, uniforms);
  materials.push(material);
  return material;
}

export function installWindSway(material: MeshMatcapMaterial, uniforms: FloraWindUniforms): void {
  material.onBeforeCompile = (shader: FloraShader) => {
    shader.uniforms.uFloraWindTime = uniforms.uFloraWindTime;
    shader.uniforms.uFloraWindX = uniforms.uFloraWindX;
    shader.uniforms.uFloraWindZ = uniforms.uFloraWindZ;
    shader.uniforms.uFloraWindStrength = uniforms.uFloraWindStrength;
    shader.uniforms.uFloraWindGust = uniforms.uFloraWindGust;
    shader.vertexShader = shader.vertexShader.replace(
      "#include <common>",
      `#include <common>
attribute float floraSway;
uniform float uFloraWindTime;
uniform float uFloraWindX;
uniform float uFloraWindZ;
uniform float uFloraWindStrength;
uniform float uFloraWindGust;`,
    );
    shader.vertexShader = shader.vertexShader.replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
#ifdef USE_INSTANCING
vec3 floraInstanceOffset = vec3(instanceMatrix[3].x, 0.0, instanceMatrix[3].z);
vec3 floraWorldWind = vec3(uFloraWindX, 0.0, uFloraWindZ);
vec2 floraWindDir = normalize(vec2(
  dot(floraWorldWind, normalize(instanceMatrix[0].xyz)),
  dot(floraWorldWind, normalize(instanceMatrix[2].xyz))
) + vec2(0.0001, 0.0));
#else
vec3 floraInstanceOffset = vec3(modelMatrix[3].x, 0.0, modelMatrix[3].z);
vec2 floraWindDir = normalize(vec2(uFloraWindX, uFloraWindZ) + vec2(0.0001, 0.0));
#endif
float floraPhase = dot(floraInstanceOffset.xz, vec2(0.117, 0.071));
float floraOsc = sin(uFloraWindTime * 6.9115 + floraPhase) + 0.35 * sin(uFloraWindTime * 9.37 + floraPhase * 1.73);
float floraAmp = 0.02 * uFloraWindStrength * (1.0 + uFloraWindGust * 0.35) * floraSway;
transformed.xz += floraWindDir * floraOsc * floraAmp;`,
    );
  };
}

function createCactusGeometry(seed: number, variantIndex: number): BufferGeometry {
  const rng = new VariantRng(seed);
  const height = rng.range(1.3, 2.4);
  const radialSegments = rng.int(8, 10);
  const leanRad = rng.range(0, Math.PI * 2);
  const leanDistance = Math.tan(rng.range(0, Math.PI / 45)) * height;
  const leanX = Math.cos(leanRad) * leanDistance;
  const leanZ = Math.sin(leanRad) * leanDistance;
  const radius = rng.range(0.14, 0.22);
  const topRadius = radius * rng.range(0.72, 0.88);
  const builder = new FacetBuilder();

  addTube(builder, 0, 0, 0, leanX * 0.18, height * 0.18, leanZ * 0.18, radius * 1.08, radius, radialSegments, 3, true, false);
  addTube(builder, leanX * 0.18, height * 0.18, leanZ * 0.18, leanX * 0.58, height * 0.58, leanZ * 0.58, radius, radius * 0.94, radialSegments, 2, false, false);
  addTube(builder, leanX * 0.58, height * 0.58, leanZ * 0.58, leanX * 0.9, height * 0.9, leanZ * 0.9, radius * 0.94, topRadius, radialSegments, 1, false, false);
  addTube(builder, leanX * 0.9, height * 0.9, leanZ * 0.9, leanX, height, leanZ, topRadius, topRadius * 0.82, radialSegments, 0, false, true);

  const armCount = rng.int(0, 3);
  const truncatedArm = armCount > 0 && rng.next() < 0.25 ? rng.int(0, armCount - 1) : -1;
  for (let i = 0; i < armCount; i += 1) {
    const t = rng.range(0.38, 0.72);
    const angle = (Math.PI * 2 * i) / Math.max(1, armCount) + rng.range(-0.65, 0.65) + variantIndex * 0.41;
    const dirX = Math.cos(angle);
    const dirZ = Math.sin(angle);
    const centerX = leanX * t;
    const centerZ = leanZ * t;
    const centerY = height * t;
    const startX = centerX + dirX * radius * 0.72;
    const startZ = centerZ + dirZ * radius * 0.72;
    const elbowX = centerX + dirX * rng.range(0.28, 0.46);
    const elbowZ = centerZ + dirZ * rng.range(0.28, 0.46);
    const elbowY = centerY + rng.range(0.04, 0.16);
    const armHeight = i === truncatedArm ? rng.range(0.16, 0.28) : rng.range(0.28, 0.58);
    const tipX = elbowX + dirX * rng.range(-0.03, 0.04);
    const tipZ = elbowZ + dirZ * rng.range(-0.03, 0.04);
    const tipY = Math.min(height * 0.94, elbowY + armHeight);
    const armRadius = radius * rng.range(0.34, 0.48);
    addTube(builder, startX, centerY, startZ, elbowX, elbowY, elbowZ, armRadius * 0.95, armRadius, 6, 2, true, false);
    addTube(builder, elbowX, elbowY, elbowZ, tipX, tipY, tipZ, armRadius, armRadius * 0.72, 6, i === truncatedArm ? 0 : 1, false, true);
  }

  return builder.toGeometry(`flora:cactus_sentinel:${variantIndex}`, true);
}

function createShrubGeometry(seed: number, variantIndex: number): BufferGeometry {
  const rng = new VariantRng(seed);
  const builder = new FacetBuilder();
  addShrubBlob(builder, seed ^ 0x51AB, -0.12, 0, 0.42 + variantIndex * 0.04, 0.28, 0.26, rng.range(0, Math.PI * 2));
  addShrubBlob(builder, seed ^ 0x9127, 0.11, 0.03, 0.34, 0.22 + variantIndex * 0.04, 0.34, rng.range(0, Math.PI * 2));
  return builder.toGeometry(`flora:shrub_thorn:${variantIndex}`, true);
}

function createSnagGeometry(seed: number, variantIndex: number): BufferGeometry {
  const rng = new VariantRng(seed);
  const builder = new FacetBuilder();
  const height = rng.range(2.2, 3.2);
  const leanAngle = rng.range(0, Math.PI * 2);
  const lean = rng.range(0.08, 0.2);
  const midX = Math.cos(leanAngle) * lean * 0.45;
  const midZ = Math.sin(leanAngle) * lean * 0.45;
  const topX = Math.cos(leanAngle) * lean;
  const topZ = Math.sin(leanAngle) * lean;
  addTube(builder, 0, 0, 0, midX, height * 0.55, midZ, 0.13, 0.08, 6, 1, true, false);
  addTube(builder, midX, height * 0.55, midZ, topX, height, topZ, 0.08, 0.045, 6, 0, false, true);

  const branches = rng.int(3, 5);
  for (let i = 0; i < branches; i += 1) {
    const angle = (Math.PI * 2 * i) / branches + rng.range(-0.5, 0.5) + variantIndex * 0.27;
    const dirX = Math.cos(angle);
    const dirZ = Math.sin(angle);
    const startT = rng.range(0.62, 0.88);
    const startX = topX * startT;
    const startZ = topZ * startT;
    const startY = height * startT;
    const reach = rng.range(0.55, 1.2);
    const elbowX = startX + dirX * reach * 0.45;
    const elbowZ = startZ + dirZ * reach * 0.45;
    const elbowY = startY + rng.range(0.12, 0.35);
    const tipX = startX + dirX * reach;
    const tipZ = startZ + dirZ * reach;
    const tipY = elbowY - rng.range(0.08, 0.42);
    const branchRadius = rng.range(0.035, 0.06);
    addTube(builder, startX, startY, startZ, elbowX, elbowY, elbowZ, branchRadius, branchRadius * 0.68, 5, 1, true, false);
    addTube(builder, elbowX, elbowY, elbowZ, tipX, tipY, tipZ, branchRadius * 0.68, branchRadius * 0.28, 5, 0, false, true);
  }

  return builder.toGeometry(`flora:snag_acacia:${variantIndex}`, false);
}

function createRockGeometry(seed: number, variantIndex: number): BufferGeometry {
  const rng = new VariantRng(seed);
  const dodecahedron = new DodecahedronGeometry(0.5, 0);
  const source = dodecahedron.index ? dodecahedron.toNonIndexed() : dodecahedron;
  const position = source.getAttribute("position");
  const xs = new Float32Array(position.count);
  const ys = new Float32Array(position.count);
  const zs = new Float32Array(position.count);
  const scaleX = [0.72, 1.0, 1.28][variantIndex] ?? 1;
  const scaleY = [0.42, 0.62, 0.5][variantIndex] ?? 0.5;
  const scaleZ = [0.95, 0.78, 1.08][variantIndex] ?? 1;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const rough = 0.78 + hashFloat(seed, i, variantIndex, 0xB0) * 0.38;
    xs[i] = x * rough * scaleX;
    ys[i] = y * rough * scaleY;
    zs[i] = z * rough * scaleZ;
    if (ys[i]! < minY) minY = ys[i]!;
    if (ys[i]! > maxY) maxY = ys[i]!;
  }

  const builder = new FacetBuilder();
  const invHeight = maxY > minY ? 1 / (maxY - minY) : 0;
  for (let i = 0; i < position.count; i += 3) {
    const y0 = ys[i]! - minY;
    const y1 = ys[i + 1]! - minY;
    const y2 = ys[i + 2]! - minY;
    const band = ((y0 + y1 + y2) / 3) * invHeight;
    const materialIndex = band > 0.62 ? 0 : band > 0.25 ? 1 : 2;
    builder.addTri(materialIndex, xs[i]!, y0, zs[i]!, xs[i + 1]!, y1, zs[i + 1]!, xs[i + 2]!, y2, zs[i + 2]!);
  }
  source.dispose();
  return builder.toGeometry(`flora:rock:${variantIndex}`, false);
}

function createTumbleweedGeometry(seed: number): BufferGeometry {
  const rng = new VariantRng(seed);
  const builder = new FacetBuilder();
  for (let i = 0; i < 58; i += 1) {
    const ax = rng.range(-1, 1);
    const ay = rng.range(-0.82, 0.82);
    const az = rng.range(-1, 1);
    const aLen = Math.max(0.001, Math.hypot(ax, ay, az));
    const bx = ax / aLen + rng.range(-0.75, 0.75);
    const by = ay / aLen + rng.range(-0.55, 0.55);
    const bz = az / aLen + rng.range(-0.75, 0.75);
    const bLen = Math.max(0.001, Math.hypot(bx, by, bz));
    const ar = rng.range(TUMBLEWEED_BASE_RADIUS * 0.72, TUMBLEWEED_BASE_RADIUS * 1.04);
    const br = rng.range(TUMBLEWEED_BASE_RADIUS * 0.7, TUMBLEWEED_BASE_RADIUS * 1.02);
    addTube(
      builder,
      (ax / aLen) * ar,
      (ay / aLen) * ar,
      (az / aLen) * ar,
      (bx / bLen) * br,
      (by / bLen) * br,
      (bz / bLen) * br,
      rng.range(0.006, 0.012),
      rng.range(0.004, 0.01),
      4,
      0,
      false,
      false,
    );
  }
  return builder.toGeometry("flora:tumbleweed", false);
}

function addShrubBlob(builder: FacetBuilder, seed: number, offsetX: number, offsetZ: number, scaleX: number, scaleY: number, scaleZ: number, yaw: number): void {
  const icosahedron = new IcosahedronGeometry(1, 1);
  const source = icosahedron.index ? icosahedron.toNonIndexed() : icosahedron;
  const position = source.getAttribute("position");
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const transformed = new Float32Array(position.count * 3);

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const length = Math.max(0.001, Math.hypot(x, y, z));
    const rough = 0.72 + hashFloat(seed, Math.round(x * 997), Math.round(y * 991 + z * 613), i) * 0.48;
    const px = (x / length) * rough * scaleX;
    const py = (y / length) * rough * scaleY + scaleY * 1.05;
    const pz = (z / length) * rough * scaleZ;
    transformed[i * 3] = px * cosYaw - pz * sinYaw + offsetX;
    transformed[i * 3 + 1] = Math.max(0, py);
    transformed[i * 3 + 2] = px * sinYaw + pz * cosYaw + offsetZ;
  }

  for (let i = 0; i < position.count; i += 3) {
    const y0 = transformed[i * 3 + 1]!;
    const y1 = transformed[(i + 1) * 3 + 1]!;
    const y2 = transformed[(i + 2) * 3 + 1]!;
    const materialIndex = (y0 + y1 + y2) / 3 > scaleY * 1.08 ? 0 : 1;
    builder.addTri(
      materialIndex,
      transformed[i * 3]!, y0, transformed[i * 3 + 2]!,
      transformed[(i + 1) * 3]!, y1, transformed[(i + 1) * 3 + 2]!,
      transformed[(i + 2) * 3]!, y2, transformed[(i + 2) * 3 + 2]!,
    );
  }
  source.dispose();
}

export function addTube(builder: FacetBuilder, sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, radiusStart: number, radiusEnd: number, radialSegments: number, materialIndex: number, capStart: boolean, capEnd: boolean): void {
  const ax = ex - sx;
  const ay = ey - sy;
  const az = ez - sz;
  const length = Math.hypot(ax, ay, az);
  if (length <= 0.0001) return;
  const nx = ax / length;
  const ny = ay / length;
  const nz = az / length;

  let ux = -nz;
  let uy = 0;
  let uz = nx;
  let uLen = Math.hypot(ux, uy, uz);
  if (uLen <= 0.0001) {
    ux = 1;
    uy = 0;
    uz = 0;
    uLen = 1;
  }
  ux /= uLen;
  uy /= uLen;
  uz /= uLen;
  const vx = ny * uz - nz * uy;
  const vy = nz * ux - nx * uz;
  const vz = nx * uy - ny * ux;

  for (let i = 0; i < radialSegments; i += 1) {
    const a0 = (i / radialSegments) * Math.PI * 2;
    const a1 = ((i + 1) / radialSegments) * Math.PI * 2;
    const c0 = Math.cos(a0);
    const s0 = Math.sin(a0);
    const c1 = Math.cos(a1);
    const s1 = Math.sin(a1);
    const s0x = sx + (ux * c0 + vx * s0) * radiusStart;
    const s0y = sy + (uy * c0 + vy * s0) * radiusStart;
    const s0z = sz + (uz * c0 + vz * s0) * radiusStart;
    const s1x = sx + (ux * c1 + vx * s1) * radiusStart;
    const s1y = sy + (uy * c1 + vy * s1) * radiusStart;
    const s1z = sz + (uz * c1 + vz * s1) * radiusStart;
    const e0x = ex + (ux * c0 + vx * s0) * radiusEnd;
    const e0y = ey + (uy * c0 + vy * s0) * radiusEnd;
    const e0z = ez + (uz * c0 + vz * s0) * radiusEnd;
    const e1x = ex + (ux * c1 + vx * s1) * radiusEnd;
    const e1y = ey + (uy * c1 + vy * s1) * radiusEnd;
    const e1z = ez + (uz * c1 + vz * s1) * radiusEnd;
    builder.addQuad(materialIndex, s0x, s0y, s0z, e0x, e0y, e0z, e1x, e1y, e1z, s1x, s1y, s1z);
    if (capStart) builder.addTri(materialIndex, sx, sy, sz, s1x, s1y, s1z, s0x, s0y, s0z);
    if (capEnd) builder.addTri(materialIndex, ex, ey, ez, e0x, e0y, e0z, e1x, e1y, e1z);
  }
}

export function hashFloat(seed: number, a: number, b: number, c: number): number {
  let h = (seed ^ Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 0xffffffff;
}
