import {
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
  type Scene,
} from "three";
import { SUCCESSOR_3D_CONFIG, type SuccessorBiomeId } from "../../config";
import { clearingMaskAt } from "../terrain/procgen";
import { markSunShadowCaster } from "../environment/sunShadow";
import type {
  FloraGeometryKit,
  FloraStaticSpecies,
  FloraVariant,
  ForestFloraStaticSpecies,
} from "./generators";

export interface FloraPlacement {
  readonly species: FloraStaticSpecies;
  readonly variant: number;
  readonly x: number;
  readonly z: number;
  readonly y: number;
  readonly yaw: number;
  readonly scale: number;
  readonly valueJitter: number;
}

export type FloraPlacementCounts = Record<FloraStaticSpecies, number>;

/** World-space collision primitive resolved from a placed variant. */
export type WorldFloraCollider =
  | { kind: "circle"; x: number; z: number; r: number }
  | { kind: "segment"; ax: number; az: number; bx: number; bz: number; r: number };

interface FloraChunk {
  cx: number;
  cy: number;
  group: Group;
  meshes: InstancedMesh[];
  colliders: WorldFloraCollider[];
  desiredFrame: number;
  visibleFrame: number;
  lastUsedFrame: number;
  instanceCount: number;
}

interface PlacementBucket {
  variant: FloraVariant;
  placements: FloraPlacement[];
}

const CHUNK_CELLS = SUCCESSOR_3D_CONFIG.terrain.chunkCells;
const VISIBLE_CHUNK_RADIUS = Math.max(1, Math.ceil(SUCCESSOR_3D_CONFIG.terrain.visibleApronCells / CHUNK_CELLS));
const LRU_FLOOR = 9;
const LRU_CAP = 25;
const UINT_TO_UNIT = 1 / 0xffffffff;

const SPECIES_SALT: Record<FloraStaticSpecies, number> = {
  cactus_sentinel: 0xCA7705,
  shrub_thorn: 0x5712B,
  snag_acacia: 0xACAC1A,
  rock: 0xB011D3,
  pine: 0x91A5E,
  broadleaf: 0xB10AD,
  fern: 0xFEA35,
  log: 0x10AD5,
  mossy_boulder: 0xB0D1E,
  stump: 0x57A9,
  sapling: 0x5AB1,
};
const ROCK_VARIANT_HEIGHTS = [0.48, 0.68, 0.56] as const;

export class FloraScatterStream {
  private readonly columns = new Map<number, Map<number, FloraChunk>>();
  private readonly chunks: FloraChunk[] = [];
  private readonly matrix = new Matrix4();
  private readonly rotation = new Quaternion();
  private readonly position = new Vector3();
  private readonly scale = new Vector3();
  private readonly color = new Color();
  private frame = 0;
  private worldSeed = SUCCESSOR_3D_CONFIG.terrain.fallbackWorldSeed >>> 0;
  private densityScale = 1;
  private visibleInstanceCount = 0;
  private biome: SuccessorBiomeId = "desert";

  constructor(private readonly scene: Scene, private readonly kit: FloraGeometryKit) {}

  get visibleInstances(): number {
    return this.visibleInstanceCount;
  }

  get chunkCount(): number {
    return this.chunks.length;
  }

  setWorldSeed(worldSeed: number): void {
    const normalized = normalizeWorldSeed(worldSeed);
    if (normalized === this.worldSeed) return;
    this.clear();
    this.worldSeed = normalized;
  }

  setBiome(biome: SuccessorBiomeId): void {
    if (biome === this.biome) return;
    this.clear();
    this.biome = biome;
  }

  setDensityScale(densityScale: number): void {
    const normalized = normalizeDensityScale(densityScale);
    if (normalized === this.densityScale) return;
    this.clear();
    this.densityScale = normalized;
  }

  update(focusX: number, focusZ: number): void {
    this.frame += 1;
    this.visibleInstanceCount = 0;
    const focusCx = Math.floor(focusX / CHUNK_CELLS);
    const focusCy = Math.floor(focusZ / CHUNK_CELLS);
    for (let cx = focusCx - VISIBLE_CHUNK_RADIUS; cx <= focusCx + VISIBLE_CHUNK_RADIUS; cx += 1) {
      for (let cy = focusCy - VISIBLE_CHUNK_RADIUS; cy <= focusCy + VISIBLE_CHUNK_RADIUS; cy += 1) {
        const chunk = this.ensureChunk(cx, cy);
        chunk.desiredFrame = this.frame;
        chunk.visibleFrame = this.frame;
        chunk.lastUsedFrame = this.frame;
      }
    }
    for (let i = 0; i < this.chunks.length; i += 1) {
      const chunk = this.chunks[i]!;
      const visible = chunk.visibleFrame === this.frame;
      chunk.group.visible = visible;
      if (visible) this.visibleInstanceCount += chunk.instanceCount;
    }
    this.evictOverCap();
  }

  dispose(): void {
    this.clear();
  }

  private ensureChunk(cx: number, cy: number): FloraChunk {
    let column = this.columns.get(cx);
    if (!column) {
      column = new Map<number, FloraChunk>();
      this.columns.set(cx, column);
    }
    const existing = column.get(cy);
    if (existing) return existing;

    const group = new Group();
    group.name = `flora:${this.biome}:${this.worldSeed}:${cx}:${cy}`;
    const placements = planFloraChunk(this.worldSeed, cx, cy, this.densityScale, this.biome);
    const buckets = this.bucketPlacements(placements);
    const meshes: InstancedMesh[] = [];
    const colliders: WorldFloraCollider[] = [];
    let instanceCount = 0;

    for (let i = 0; i < buckets.length; i += 1) {
      const bucket = buckets[i]!;
      const mesh = new InstancedMesh(bucket.variant.geometry, bucket.variant.materials, bucket.placements.length);
      mesh.name = `flora:${bucket.variant.key}:${cx}:${cy}`;
      mesh.frustumCulled = false;
      this.writeBucketInstances(mesh, bucket.placements);
      collectWorldColliders(colliders, bucket.variant, bucket.placements);
      group.add(mesh);
      meshes.push(mesh);
      instanceCount += bucket.placements.length;
    }

    markSunShadowCaster(group);
    this.scene.add(group);
    const chunk: FloraChunk = {
      cx,
      cy,
      group,
      meshes,
      colliders,
      desiredFrame: -1,
      visibleFrame: -1,
      lastUsedFrame: this.frame,
      instanceCount,
    };
    column.set(cy, chunk);
    this.chunks.push(chunk);
    return chunk;
  }

  /**
   * Fill `out` with resident colliders within `radius` cells of (x, z);
   * returns the count. Reuses the caller's array (movement clamp scratch).
   */
  collidersNear(x: number, z: number, radius: number, out: WorldFloraCollider[]): number {
    out.length = 0;
    const reach = radius + CHUNK_CELLS * 0.5;
    for (const chunk of this.chunks) {
      const centerX = (chunk.cx + 0.5) * CHUNK_CELLS;
      const centerZ = (chunk.cy + 0.5) * CHUNK_CELLS;
      if (Math.abs(x - centerX) > reach + CHUNK_CELLS * 0.5 || Math.abs(z - centerZ) > reach + CHUNK_CELLS * 0.5) continue;
      for (const collider of chunk.colliders) {
        if (collider.kind === "circle") {
          const dx = collider.x - x;
          const dz = collider.z - z;
          const range = radius + collider.r;
          if (dx * dx + dz * dz <= range * range) out.push(collider);
        } else {
          const midX = (collider.ax + collider.bx) / 2;
          const midZ = (collider.az + collider.bz) / 2;
          const halfLen = Math.hypot(collider.bx - collider.ax, collider.bz - collider.az) / 2;
          const range = radius + collider.r + halfLen;
          const dx = midX - x;
          const dz = midZ - z;
          if (dx * dx + dz * dz <= range * range) out.push(collider);
        }
      }
    }
    return out.length;
  }

  private bucketPlacements(placements: readonly FloraPlacement[]): PlacementBucket[] {
    const buckets: PlacementBucket[] = [];
    for (let i = 0; i < placements.length; i += 1) {
      const placement = placements[i]!;
      const speciesVariants = this.variantsForSpecies(placement.species);
      if (speciesVariants.length === 0) continue;
      const variant = speciesVariants[placement.variant % speciesVariants.length]!;
      let bucket: PlacementBucket | null = null;
      for (let j = 0; j < buckets.length; j += 1) {
        if (buckets[j]!.variant === variant) {
          bucket = buckets[j]!;
          break;
        }
      }
      if (!bucket) {
        bucket = { variant, placements: [] };
        buckets.push(bucket);
      }
      bucket.placements.push(placement);
    }
    return buckets;
  }

  private variantsForSpecies(species: FloraStaticSpecies): readonly FloraVariant[] {
    if (species === "rock") return this.kit.desert.rocks;
    if (species === "shrub_thorn") return this.kit.desert.shrubs;
    if (species === "cactus_sentinel") return this.kit.desert.cactus;
    if (species === "snag_acacia") return this.kit.desert.snags;
    if (species === "pine") return this.kit.forest.pines;
    if (species === "sapling") return this.kit.forest.saplings;
    if (species === "broadleaf") return this.kit.forest.broadleafs;
    if (species === "fern") return this.kit.forest.ferns;
    if (species === "log") return this.kit.forest.logs;
    if (species === "mossy_boulder") return this.kit.forest.mossyBoulders;
    return this.kit.forest.stumps;
  }

  private writeBucketInstances(mesh: InstancedMesh, placements: readonly FloraPlacement[]): void {
    for (let i = 0; i < placements.length; i += 1) {
      const placement = placements[i]!;
      this.position.set(placement.x, placement.y, placement.z);
      this.rotation.setFromAxisAngle(this.position.set(0, 1, 0), placement.yaw);
      this.position.set(placement.x, placement.y, placement.z);
      this.scale.setScalar(placement.scale);
      this.matrix.compose(this.position, this.rotation, this.scale);
      mesh.setMatrixAt(i, this.matrix);
      this.color.setRGB(placement.valueJitter, placement.valueJitter, placement.valueJitter);
      mesh.setColorAt(i, this.color);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  private evictOverCap(): void {
    while (this.chunks.length > LRU_CAP && this.chunks.length > LRU_FLOOR) {
      let oldestIndex = -1;
      let oldestFrame = Infinity;
      for (let i = 0; i < this.chunks.length; i += 1) {
        const chunk = this.chunks[i]!;
        if (chunk.desiredFrame === this.frame) continue;
        if (chunk.lastUsedFrame < oldestFrame) {
          oldestFrame = chunk.lastUsedFrame;
          oldestIndex = i;
        }
      }
      if (oldestIndex < 0) return;
      this.evictChunkAt(oldestIndex);
    }
  }

  private evictChunkAt(index: number): void {
    const chunk = this.chunks[index]!;
    const column = this.columns.get(chunk.cx);
    column?.delete(chunk.cy);
    if (column && column.size === 0) this.columns.delete(chunk.cx);
    const last = this.chunks.pop();
    if (last && last !== chunk) this.chunks[index] = last;
    this.scene.remove(chunk.group);
    for (let i = 0; i < chunk.meshes.length; i += 1) chunk.meshes[i]!.dispose();
    chunk.group.clear();
  }

  private clear(): void {
    for (let i = 0; i < this.chunks.length; i += 1) {
      const chunk = this.chunks[i]!;
      this.scene.remove(chunk.group);
      for (let j = 0; j < chunk.meshes.length; j += 1) chunk.meshes[j]!.dispose();
      chunk.group.clear();
    }
    this.columns.clear();
    this.chunks.length = 0;
    this.visibleInstanceCount = 0;
  }
}

export function planFloraChunk(
  worldSeed: number,
  chunkX: number,
  chunkY: number,
  densityScale: number,
  biome: SuccessorBiomeId = "desert",
): FloraPlacement[] {
  const normalizedSeed = normalizeWorldSeed(worldSeed);
  const scale = normalizeDensityScale(densityScale);
  const placements: FloraPlacement[] = [];
  if (biome === "forest") {
    planForestFlora(placements, normalizedSeed, chunkX, chunkY, scale);
    return placements.filter((placement) => !inSettlementExclusion(placement.x, placement.z));
  }
  planRocks(placements, normalizedSeed, chunkX, chunkY, scale);
  planShrubs(placements, normalizedSeed, chunkX, chunkY, scale);
  planCactus(placements, normalizedSeed, chunkX, chunkY, scale);
  planSnags(placements, normalizedSeed, chunkX, chunkY, scale);
  return placements.filter((placement) => !inSettlementExclusion(placement.x, placement.z));
}

/**
 * Settlement exclusion rings: player spawn + travel terminal on every planet
 * share these coordinates (fixture contract). Flora never crowds an arrival
 * point or blocks the kiosk approach; the ring reads as a worn camp clearing.
 */
const SETTLEMENT_EXCLUSIONS: ReadonlyArray<{ x: number; z: number; r: number }> = [
  { x: 512.5, z: 512.5, r: 24 },
  { x: 524.5, z: 512.5, r: 18 },
];

function inSettlementExclusion(x: number, z: number): boolean {
  for (const ring of SETTLEMENT_EXCLUSIONS) {
    const dx = x - ring.x;
    const dz = z - ring.z;
    if (dx * dx + dz * dz <= ring.r * ring.r) return true;
  }
  return false;
}

/** Resolve a variant's local collider into world space per placement. */
function collectWorldColliders(out: WorldFloraCollider[], variant: FloraVariant, placements: readonly FloraPlacement[]): void {
  const shape = variant.collider;
  if (!shape) return;
  for (const placement of placements) {
    if (shape.kind === "circle") {
      out.push({ kind: "circle", x: placement.x, z: placement.z, r: shape.radius * placement.scale });
      continue;
    }
    // three.js Y-rotation of a local (x, z): x' = x·cos + z·sin, z' = −x·sin + z·cos.
    const cos = Math.cos(placement.yaw);
    const sin = Math.sin(placement.yaw);
    out.push({
      kind: "segment",
      ax: placement.x + (shape.ax * cos + shape.az * sin) * placement.scale,
      az: placement.z + (-shape.ax * sin + shape.az * cos) * placement.scale,
      bx: placement.x + (shape.bx * cos + shape.bz * sin) * placement.scale,
      bz: placement.z + (-shape.bx * sin + shape.bz * cos) * placement.scale,
      r: shape.radius * placement.scale,
    });
  }
}

export function floraPlacementCounts(placements: readonly FloraPlacement[]): FloraPlacementCounts {
  const counts: FloraPlacementCounts = {
    cactus_sentinel: 0,
    shrub_thorn: 0,
    snag_acacia: 0,
    rock: 0,
    pine: 0,
    broadleaf: 0,
    fern: 0,
    log: 0,
    mossy_boulder: 0,
    stump: 0,
    sapling: 0,
  };
  for (let i = 0; i < placements.length; i += 1) {
    const placement = placements[i]!;
    counts[placement.species] += 1;
  }
  return counts;
}

function planRocks(out: FloraPlacement[], seed: number, cx: number, cy: number, densityScale: number): void {
  const count = scaledCount(randomInt(seed, cx, cy, "rock", 0, 24, 40), densityScale);
  for (let i = 0; i < count; i += 1) {
    const sizeScale = 0.42 + hashUnit(seed, cx, cy, SPECIES_SALT.rock + i * 17) * 0.42;
    const placement = basePlacement(seed, cx, cy, "rock", i, 3, sizeScale, 0);
    const height = ROCK_VARIANT_HEIGHTS[placement.variant] ?? 0.56;
    const sunkRatio = 0.1 + hashUnit(seed, cx, cy, SPECIES_SALT.rock + i * 17 + 1) * 0.15;
    out.push({ ...placement, y: -height * placement.scale * sunkRatio });
  }
}

function planShrubs(out: FloraPlacement[], seed: number, cx: number, cy: number, densityScale: number): void {
  const count = scaledCount(randomInt(seed, cx, cy, "shrub_thorn", 0, 12, 20), densityScale);
  for (let i = 0; i < count; i += 1) {
    out.push(basePlacement(seed, cx, cy, "shrub_thorn", i, 2, 0.9, 0));
  }
}

function planCactus(out: FloraPlacement[], seed: number, cx: number, cy: number, densityScale: number): void {
  const target = scaledCount(randomInt(seed, cx, cy, "cactus_sentinel", 0, 5, 10), densityScale);
  let emitted = 0;
  let cluster = 0;
  while (emitted < target) {
    const remaining = target - emitted;
    const clusterSize = Math.min(remaining, randomInt(seed, cx, cy, "cactus_sentinel", cluster + 41, 2, 5));
    const chunkX = cx * CHUNK_CELLS;
    const chunkZ = cy * CHUNK_CELLS;
    const centerX = chunkX + hashUnit(seed, cx, cy, SPECIES_SALT.cactus_sentinel + cluster * 131) * CHUNK_CELLS;
    const centerZ = chunkZ + hashUnit(seed, cx, cy, SPECIES_SALT.cactus_sentinel + cluster * 131 + 1) * CHUNK_CELLS;
    const radius = 5 + hashUnit(seed, cx, cy, SPECIES_SALT.cactus_sentinel + cluster * 131 + 2) * 15;
    for (let i = 0; i < clusterSize; i += 1) {
      const index = emitted + i;
      const angle = hashUnit(seed, cx, cy, SPECIES_SALT.cactus_sentinel + index * 37 + 11) * Math.PI * 2;
      const distance = Math.sqrt(hashUnit(seed, cx, cy, SPECIES_SALT.cactus_sentinel + index * 37 + 12)) * radius;
      const placement = basePlacement(seed, cx, cy, "cactus_sentinel", index, 4, 1, 0);
      const minX = chunkX + 2;
      const maxX = chunkX + CHUNK_CELLS - 2;
      const minZ = chunkZ + 2;
      const maxZ = chunkZ + CHUNK_CELLS - 2;
      out.push({
        ...placement,
        x: clamp(centerX + Math.cos(angle) * distance, minX, maxX),
        z: clamp(centerZ + Math.sin(angle) * distance, minZ, maxZ),
      });
    }
    emitted += clusterSize;
    cluster += 1;
  }
}

function planSnags(out: FloraPlacement[], seed: number, cx: number, cy: number, densityScale: number): void {
  const roll = hashUnit(seed, cx, cy, SPECIES_SALT.snag_acacia);
  const baseCount = roll > 0.86 ? 2 : roll > 0.4 ? 1 : 0;
  const count = scaledCount(baseCount, densityScale);
  for (let i = 0; i < count; i += 1) {
    out.push(basePlacement(seed, cx, cy, "snag_acacia", i, 4, 1, 0));
  }
}

function planForestFlora(out: FloraPlacement[], seed: number, cx: number, cy: number, densityScale: number): void {
  planTitans(out, seed, cx, cy, densityScale);
  planSaplings(out, seed, cx, cy, densityScale);
  planFerns(out, seed, cx, cy, densityScale);
  planFallenBoughs(out, seed, cx, cy, densityScale);
  planMossyBoulders(out, seed, cx, cy, densityScale);
  planTitanStumps(out, seed, cx, cy, densityScale);
}

/**
 * Titan doctrine (owner-ratified 2026-07-05, "50× fantasy forest"): the trees
 * are trunk MONUMENTS — landmark-spaced so a screen nearly always holds 1–3
 * columns, never a wall. Placement rides a WORLD-SPACE lattice (one candidate
 * per 20-cell lattice cell, jitter confined to its middle band) so spacing is
 * structurally seam-proof across chunk borders — chunk-local rejection could
 * stack trunks across seams. Root fields may weave (organic); trunks never
 * interpenetrate (min center distance = 0.4 × lattice ≈ 8 > 2 × trunk radius).
 * Saplings and ferns carry the human-scale contrast.
 */
const TITAN_LATTICE_CELLS = 20;
const TITAN_ACCEPT_CONIFER = 0.2;
const TITAN_ACCEPT_SPLITCROWN = 0.055;

function planTitans(out: FloraPlacement[], seed: number, cx: number, cy: number, densityScale: number): void {
  const chunkMinX = cx * CHUNK_CELLS;
  const chunkMinZ = cy * CHUNK_CELLS;
  const chunkMaxX = chunkMinX + CHUNK_CELLS;
  const chunkMaxZ = chunkMinZ + CHUNK_CELLS;
  const acceptScale = Math.min(1, densityScale);
  const latMinX = Math.floor(chunkMinX / TITAN_LATTICE_CELLS);
  const latMinZ = Math.floor(chunkMinZ / TITAN_LATTICE_CELLS);
  const latMaxX = Math.ceil(chunkMaxX / TITAN_LATTICE_CELLS);
  const latMaxZ = Math.ceil(chunkMaxZ / TITAN_LATTICE_CELLS);
  for (let lx = latMinX; lx < latMaxX; lx += 1) {
    for (let lz = latMinZ; lz < latMaxZ; lz += 1) {
      const roll = hashUnit(seed, lx, lz, 0x717A9);
      const conifer = roll < TITAN_ACCEPT_CONIFER * acceptScale;
      const splitcrown = !conifer && roll < (TITAN_ACCEPT_CONIFER + TITAN_ACCEPT_SPLITCROWN) * acceptScale;
      if (!conifer && !splitcrown) continue;
      // Jitter inside the middle band of the lattice cell (seam-proof spacing).
      let x = 0;
      let z = 0;
      let found = false;
      for (let attempt = 0; attempt < 3 && !found; attempt += 1) {
        x = (lx + 0.2 + hashUnit(seed, lx, lz, 0x9137 + attempt) * 0.6) * TITAN_LATTICE_CELLS;
        z = (lz + 0.2 + hashUnit(seed, lx, lz, 0xA241 + attempt) * 0.6) * TITAN_LATTICE_CELLS;
        found = clearingMaskAt(seed, x, z) <= 0.6;
      }
      if (!found) continue;
      // The candidate belongs to exactly ONE chunk — the one containing it.
      if (x < chunkMinX || x >= chunkMaxX || z < chunkMinZ || z >= chunkMaxZ) continue;
      const species = conifer ? "pine" : "broadleaf";
      const variantCount = conifer ? 3 : 2;
      const salt = SPECIES_SALT[species] + lx * 0x45d9 + lz * 0x9e37;
      const yaw = hashUnit(seed, lx, lz, salt + 2) * Math.PI * 2;
      const variant = Math.floor(hashUnit(seed, lx, lz, salt + 3) * variantCount);
      const scale = 0.82 + hashUnit(seed, lx, lz, salt + 4) * 0.36;
      const valueJitter = 0.92 + hashUnit(seed, lx, lz, salt + 5) * 0.16;
      out.push({ species, variant, x, z, y: 0, yaw, scale, valueJitter });
    }
  }
}

function planSaplings(out: FloraPlacement[], seed: number, cx: number, cy: number, densityScale: number): void {
  const count = scaledCount(randomInt(seed, cx, cy, "sapling", 0, 80, 140), densityScale);
  for (let i = 0; i < count; i += 1) {
    const point = canopyPointInChunk(seed, cx, cy, "pine", i + 5000);
    const placement = basePlacement(seed, cx, cy, "sapling", i, 3, 1, 0);
    out.push({ ...placement, x: point.x, z: point.z });
  }
}

function planFerns(out: FloraPlacement[], seed: number, cx: number, cy: number, densityScale: number): void {
  const count = scaledCount(randomInt(seed, cx, cy, "fern", 0, 160, 260), densityScale);
  for (let i = 0; i < count; i += 1) {
    const point = clearingFavoredPoint(seed, cx, cy, "fern", i);
    const clearing = clearingMaskAt(seed, point.x, point.z);
    const placement = basePlacement(seed, cx, cy, "fern", i, 4, 0.72 + clearing * 0.2, 0);
    out.push({ ...placement, x: point.x, z: point.z, valueJitter: 0.9 + clearing * 0.16 });
  }
}

function planFallenBoughs(out: FloraPlacement[], seed: number, cx: number, cy: number, densityScale: number): void {
  const count = scaledCount(randomInt(seed, cx, cy, "log", 0, 6, 12), densityScale);
  for (let i = 0; i < count; i += 1) {
    out.push(basePlacement(seed, cx, cy, "log", i, 3, 1, 0.02));
  }
}

function planMossyBoulders(out: FloraPlacement[], seed: number, cx: number, cy: number, densityScale: number): void {
  const count = scaledCount(randomInt(seed, cx, cy, "mossy_boulder", 0, 24, 40), densityScale);
  for (let i = 0; i < count; i += 1) {
    const sizeScale = 0.6 + hashUnit(seed, cx, cy, SPECIES_SALT.mossy_boulder + i * 17) * 0.7;
    out.push(basePlacement(seed, cx, cy, "mossy_boulder", i, 3, sizeScale, -0.08));
  }
}

function planTitanStumps(out: FloraPlacement[], seed: number, cx: number, cy: number, densityScale: number): void {
  const roll = hashUnit(seed, cx, cy, SPECIES_SALT.stump);
  const baseCount = roll > 0.8 ? 3 : roll > 0.45 ? 2 : 1;
  const count = scaledCount(baseCount, densityScale);
  for (let i = 0; i < count; i += 1) {
    out.push(basePlacement(seed, cx, cy, "stump", i, 3, 1, 0));
  }
}

function planClusteredTrees(
  out: FloraPlacement[],
  seed: number,
  cx: number,
  cy: number,
  species: "pine" | "broadleaf",
  target: number,
  variantCount: number,
  sizeScale: number,
  minCluster: number,
  maxCluster: number,
  minRadius: number,
  maxRadius: number,
): void {
  let emitted = 0;
  let cluster = 0;
  while (emitted < target) {
    const remaining = target - emitted;
    const clusterSize = Math.min(remaining, randomInt(seed, cx, cy, species, cluster + 91, minCluster, maxCluster));
    const center = canopyPointInChunk(seed, cx, cy, species, cluster + 1000);
    const radius = minRadius + hashUnit(seed, cx, cy, SPECIES_SALT[species] + cluster * 131 + 2) * (maxRadius - minRadius);
    for (let i = 0; i < clusterSize; i += 1) {
      const index = emitted + i;
      const point = canopyPointNear(seed, cx, cy, species, index, center.x, center.z, radius);
      const placement = basePlacement(seed, cx, cy, species, index, variantCount, sizeScale, 0);
      out.push({ ...placement, x: point.x, z: point.z });
    }
    emitted += clusterSize;
    cluster += 1;
  }
}

function canopyPointNear(
  seed: number,
  cx: number,
  cy: number,
  species: "pine" | "broadleaf",
  index: number,
  centerX: number,
  centerZ: number,
  radius: number,
): { x: number; z: number } {
  const chunkX = cx * CHUNK_CELLS;
  const chunkZ = cy * CHUNK_CELLS;
  const minX = chunkX + 2;
  const maxX = chunkX + CHUNK_CELLS - 2;
  const minZ = chunkZ + 2;
  const maxZ = chunkZ + CHUNK_CELLS - 2;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const salt = SPECIES_SALT[species] + index * 101 + attempt * 0x1f3d;
    const angle = hashUnit(seed, cx, cy, salt) * Math.PI * 2;
    const distance = Math.sqrt(hashUnit(seed, cx, cy, salt + 1)) * radius;
    const x = clamp(centerX + Math.cos(angle) * distance, minX, maxX);
    const z = clamp(centerZ + Math.sin(angle) * distance, minZ, maxZ);
    if (clearingMaskAt(seed, x, z) <= 0.6) return { x, z };
  }
  return canopyPointInChunk(seed, cx, cy, species, index + 3000);
}

function canopyPointInChunk(seed: number, cx: number, cy: number, species: "pine" | "broadleaf", index: number): { x: number; z: number } {
  let bestX = cx * CHUNK_CELLS + CHUNK_CELLS * 0.5;
  let bestZ = cy * CHUNK_CELLS + CHUNK_CELLS * 0.5;
  let bestMask = Infinity;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const point = randomPointInChunk(seed, cx, cy, species, index, attempt * 0x9e37);
    const mask = clearingMaskAt(seed, point.x, point.z);
    if (mask <= 0.6) return point;
    if (mask < bestMask) {
      bestMask = mask;
      bestX = point.x;
      bestZ = point.z;
    }
  }
  const grid = 32;
  const cells = grid * grid;
  for (let sample = 0; sample < cells; sample += 1) {
    const shuffled = (sample * 73 + index * 17 + SPECIES_SALT[species]) % cells;
    const ix = shuffled % grid;
    const iz = Math.floor(shuffled / grid);
    const x = cx * CHUNK_CELLS + ((ix + 0.5) / grid) * CHUNK_CELLS;
    const z = cy * CHUNK_CELLS + ((iz + 0.5) / grid) * CHUNK_CELLS;
    const mask = clearingMaskAt(seed, x, z);
    if (mask <= 0.6) return { x, z };
    if (mask < bestMask) {
      bestMask = mask;
      bestX = x;
      bestZ = z;
    }
  }
  return { x: bestX, z: bestZ };
}

function clearingFavoredPoint(seed: number, cx: number, cy: number, species: "fern", index: number): { x: number; z: number } {
  let fallback = randomPointInChunk(seed, cx, cy, species, index, 0);
  let fallbackMask = clearingMaskAt(seed, fallback.x, fallback.z);
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const point = randomPointInChunk(seed, cx, cy, species, index, attempt * 0x6d2b);
    const mask = clearingMaskAt(seed, point.x, point.z);
    const accept = 0.26 + mask * 0.74;
    const roll = hashUnit(seed, cx, cy, SPECIES_SALT[species] + index * 211 + attempt);
    if (roll <= accept) return point;
    if (mask > fallbackMask) {
      fallback = point;
      fallbackMask = mask;
    }
  }
  return fallback;
}

function randomPointInChunk(
  seed: number,
  cx: number,
  cy: number,
  species: ForestFloraStaticSpecies,
  index: number,
  saltOffset: number,
): { x: number; z: number } {
  const salt = SPECIES_SALT[species] + index * 0x45d9 + saltOffset;
  const x = cx * CHUNK_CELLS + hashUnit(seed, cx, cy, salt) * CHUNK_CELLS;
  const z = cy * CHUNK_CELLS + hashUnit(seed, cx, cy, salt + 1) * CHUNK_CELLS;
  return { x, z };
}

function basePlacement(seed: number, cx: number, cy: number, species: FloraStaticSpecies, index: number, variantCount: number, sizeScale: number, y: number): FloraPlacement {
  const salt = SPECIES_SALT[species] + index * 0x45d9;
  const x = cx * CHUNK_CELLS + hashUnit(seed, cx, cy, salt) * CHUNK_CELLS;
  const z = cy * CHUNK_CELLS + hashUnit(seed, cx, cy, salt + 1) * CHUNK_CELLS;
  const yaw = hashUnit(seed, cx, cy, salt + 2) * Math.PI * 2;
  const variant = Math.floor(hashUnit(seed, cx, cy, salt + 3) * variantCount);
  const scale = sizeScale * (0.8 + hashUnit(seed, cx, cy, salt + 4) * 0.4);
  const valueJitter = 0.92 + hashUnit(seed, cx, cy, salt + 5) * 0.16;
  return { species, variant, x, z, y, yaw, scale, valueJitter };
}


function randomInt(seed: number, cx: number, cy: number, species: FloraStaticSpecies, saltOffset: number, min: number, max: number): number {
  const salt = SPECIES_SALT[species] + saltOffset;
  const roll = hashUnit(seed, cx, cy, salt);
  return min + Math.floor(roll * (max - min + 1));
}

function scaledCount(baseCount: number, densityScale: number): number {
  if (densityScale <= 0) return 0;
  return Math.max(0, Math.round(baseCount * densityScale));
}

function hashUnit(seed: number, x: number, y: number, salt: number): number {
  let h = (seed ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ salt) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h = (h ^ (h >>> 15)) >>> 0;
  return h * UINT_TO_UNIT;
}

function normalizeWorldSeed(value: number): number {
  if (!Number.isFinite(value)) return SUCCESSOR_3D_CONFIG.terrain.fallbackWorldSeed >>> 0;
  return Math.trunc(value) >>> 0;
}

function normalizeDensityScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(3, value));
}


function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
