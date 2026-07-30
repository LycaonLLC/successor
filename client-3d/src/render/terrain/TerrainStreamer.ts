import {
  CanvasTexture,
  DataTexture,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  NearestFilter,
  PlaneGeometry,
  RedFormat,
  RepeatWrapping,
  SRGBColorSpace,
  UnsignedByteType,
  type Scene,
} from "three";
import type { SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { SUCCESSOR_3D_CONFIG, type SuccessorBiomeId } from "../../config";
import { paintTerrainPixel, TerrainKind, TERRAIN_RULES_VERSION } from "./procgen";
import type { GroundBounds } from "../camera";
import type { WorldEnvironment } from "../environment";

interface TerrainChunk {
  cx: number;
  cy: number;
  label: string;
  mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  material: MeshBasicMaterial;
  texture: CanvasTexture | null;
  desiredFrame: number;
  visibleFrame: number;
  lastUsedFrame: number;
  bakeState: "unbaked" | "queued" | "baking" | "ready";
  alive: boolean;
}

interface TerrainBakeJob {
  chunk: TerrainChunk;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  imageData: ImageData;
  nextRow: number;
  cpuMs: number;
  wallStartMs: number;
  desertPixels: number;
  scrubPixels: number;
  hardpanPixels: number;
}

export interface TerrainStreamerStats {
  worldSeed: number;
  biome: SuccessorBiomeId;
  rulesVersion: number;
  chunkCells: number;
  texturePixels: number;
  visibleChunks: number;
  drawCalls: number;
  residentChunks: number;
  residentTextures: number;
  rendererTextures: number;
  queuedChunks: number;
  baking: boolean;
  currentBakeChunk: string | null;
  bakedChunks: number;
  evictedChunks: number;
  debugFocusActive: boolean;
  lruFloor: number;
  lruCap: number;
  lastBakeCpuMs: number;
  p95BakeCpuMs: number;
  lastBakeSliceMs: number;
  p95BakeSliceMs: number;
  lastBakeWallMs: number;
  p95BakeWallMs: number;
  lastBakeMix: { desert: number; scrub: number; hardpan: number };
  nearestFilter: boolean;
  detailAmplitude: number;
}

declare global {
  interface Window {
    __successor3dTerrain?: TerrainStreamerStats;
    __successor3dTerrainDebugFocus?: (x: number, z: number, frames?: number) => TerrainStreamerStats | null;
  }
}

const CHUNK_CELLS = SUCCESSOR_3D_CONFIG.terrain.chunkCells;
const CHUNK_HALF_CELLS = CHUNK_CELLS / 2;
const TEXTURE_PIXELS = SUCCESSOR_3D_CONFIG.terrain.texturePixels;
const TEXEL_WORLD_STEP = CHUNK_CELLS / (TEXTURE_PIXELS - 1);
const TERRAIN_Y = SUCCESSOR_3D_CONFIG.terrain.y;
const VISIBLE_APRON_CELLS = SUCCESSOR_3D_CONFIG.terrain.visibleApronCells;
const LRU_FLOOR = SUCCESSOR_3D_CONFIG.terrain.lruFloor;
const LRU_CAP = SUCCESSOR_3D_CONFIG.terrain.lruCap;
const PREFETCH_RADIUS_CHUNKS = SUCCESSOR_3D_CONFIG.terrain.prefetchRadiusChunks;
const BAKE_ROWS_PER_FRAME = SUCCESSOR_3D_CONFIG.terrain.bakeRowsPerFrame;
const TERRAIN_DETAIL = SUCCESSOR_3D_CONFIG.terrain.detail;
const DETAIL_TEXTURE_PIXELS = TERRAIN_DETAIL.texturePixels;
const DETAIL_UV_SCALE = (CHUNK_CELLS * TERRAIN_DETAIL.texelsPerCell) / DETAIL_TEXTURE_PIXELS;
const DETAIL_FULL_BOUNDS_WIDTH = TERRAIN_DETAIL.fullStrengthBoundsWidthCells;
const DETAIL_ZERO_BOUNDS_WIDTH = TERRAIN_DETAIL.zeroStrengthBoundsWidthCells;
const DESERT_HEX = (SUCCESSOR_3D_CONFIG.terrain.palette.desert[0] << 16)
  | (SUCCESSOR_3D_CONFIG.terrain.palette.desert[1] << 8)
  | SUCCESSOR_3D_CONFIG.terrain.palette.desert[2];
const FOREST_HEX = (SUCCESSOR_3D_CONFIG.biomes.forest.palette.moss[0] << 16)
  | (SUCCESSOR_3D_CONFIG.biomes.forest.palette.moss[1] << 8)
  | SUCCESSOR_3D_CONFIG.biomes.forest.palette.moss[2];
const ASHVAT_AREA_SEED_HASH = fnv1a32("open-desert-overworld");

export class TerrainStreamer {
  private readonly columns = new Map<number, Map<number, TerrainChunk>>();
  private readonly chunks = new Set<TerrainChunk>();
  private readonly bakeQueue: TerrainChunk[] = [];
  private readonly stats: TerrainStreamerStats = {
    worldSeed: 0,
    biome: "desert",
    rulesVersion: TERRAIN_RULES_VERSION,
    chunkCells: CHUNK_CELLS,
    texturePixels: TEXTURE_PIXELS,
    visibleChunks: 0,
    drawCalls: 0,
    residentChunks: 0,
    residentTextures: 0,
    rendererTextures: 0,
    queuedChunks: 0,
    baking: false,
    currentBakeChunk: null,
    bakedChunks: 0,
    evictedChunks: 0,
    debugFocusActive: false,
    lruFloor: LRU_FLOOR,
    lruCap: LRU_CAP,
    lastBakeCpuMs: 0,
    p95BakeCpuMs: 0,
    lastBakeSliceMs: 0,
    p95BakeSliceMs: 0,
    lastBakeWallMs: 0,
    p95BakeWallMs: 0,
    lastBakeMix: { desert: 0, scrub: 0, hardpan: 0 },
    nearestFilter: false,
    detailAmplitude: TERRAIN_DETAIL.amplitude,
  };
  private readonly bakeCpuSamples: number[] = [];
  private readonly bakeSliceSamples: number[] = [];
  private readonly bakeWallSamples: number[] = [];
  private readonly debugBounds: GroundBounds = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
  private readonly debugFocusHook = (x: number, z: number, frames = 180): TerrainStreamerStats | null => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    this.debugFocusX = x;
    this.debugFocusZ = z;
    this.debugFocusFrames = Math.max(1, Math.min(900, Math.trunc(frames)));
    this.stats.debugFocusActive = true;
    return this.stats;
  };
  private bakeQueueHead = 0;
  private currentBake: TerrainBakeJob | null = null;
  private frame = 0;
  private worldSeed: number;
  private biome: SuccessorBiomeId;
  private visibleChunks = 0;
  private residentTextures = 0;
  private debugFocusX = 0;
  private debugFocusZ = 0;
  private debugFocusFrames = 0;
  private detailTexture: DataTexture;
  private readonly detailTextureUniform: { value: DataTexture };
  private readonly detailUvScaleUniform = { value: DETAIL_UV_SCALE };
  private readonly detailStrengthUniform = { value: 0 };
  private lastNearestFilter = false;

  constructor(private readonly scene: Scene, worldSeed: number, readonly env?: WorldEnvironment, biome: SuccessorBiomeId = "desert") {
    this.worldSeed = normalizeWorldSeed(worldSeed);
    this.biome = biome;
    this.detailTexture = createTerrainDetailTexture(this.worldSeed);
    this.detailTextureUniform = { value: this.detailTexture };
    this.stats.worldSeed = this.worldSeed;
    this.stats.biome = biome;
    this.lastNearestFilter = this.stats.nearestFilter;
    window.__successor3dTerrain = this.stats;
    window.__successor3dTerrainDebugFocus = this.debugFocusHook;
  }

  setWorldSeed(worldSeed: number): void {
    const normalized = normalizeWorldSeed(worldSeed);
    if (normalized === this.worldSeed) return;
    this.clear();
    this.detailTexture.dispose();
    this.worldSeed = normalized;
    this.detailTexture = createTerrainDetailTexture(normalized);
    this.detailTextureUniform.value = this.detailTexture;
    this.stats.worldSeed = normalized;
  }

  setBiome(biome: SuccessorBiomeId): void {
    if (biome === this.biome) return;
    this.clear();
    this.biome = biome;
    this.stats.biome = biome;
  }

  update(bounds: GroundBounds, focusX: number, focusZ: number): void {
    this.frame += 1;
    this.visibleChunks = 0;
    let terrainBounds = bounds;
    let terrainFocusX = focusX;
    let terrainFocusZ = focusZ;
    if (this.debugFocusFrames > 0) {
      this.debugFocusFrames -= 1;
      this.debugBounds.minX = this.debugFocusX;
      this.debugBounds.maxX = this.debugFocusX;
      this.debugBounds.minZ = this.debugFocusZ;
      this.debugBounds.maxZ = this.debugFocusZ;
      terrainBounds = this.debugBounds;
      terrainFocusX = this.debugFocusX;
      terrainFocusZ = this.debugFocusZ;
    }
    this.stats.debugFocusActive = this.debugFocusFrames > 0;
    this.updateDetailUniform(terrainBounds);
    this.applyTextureFilterDial();
    this.markVisibleChunks(terrainBounds);
    this.markPrefetchNeighborhood(terrainFocusX, terrainFocusZ);
    this.applyVisibility();
    this.evictOverCap();
    this.processBakeBudget();
    this.publishStats();
  }

  publishRendererTextureCount(rendererTextures: number): void {
    this.stats.rendererTextures = rendererTextures;
  }

  dispose(): void {
    this.clear();
    this.detailTexture.dispose();
    if (window.__successor3dTerrain === this.stats) window.__successor3dTerrain = undefined;
    if (window.__successor3dTerrainDebugFocus === this.debugFocusHook) window.__successor3dTerrainDebugFocus = undefined;
  }

  private markVisibleChunks(bounds: GroundBounds): void {
    const minX = bounds.minX - VISIBLE_APRON_CELLS;
    const maxX = bounds.maxX + VISIBLE_APRON_CELLS;
    const minZ = bounds.minZ - VISIBLE_APRON_CELLS;
    const maxZ = bounds.maxZ + VISIBLE_APRON_CELLS;
    const minCx = Math.floor(minX / CHUNK_CELLS);
    const maxCx = Math.floor(maxX / CHUNK_CELLS);
    const minCy = Math.floor(minZ / CHUNK_CELLS);
    const maxCy = Math.floor(maxZ / CHUNK_CELLS);
    for (let cx = minCx; cx <= maxCx; cx += 1) {
      for (let cy = minCy; cy <= maxCy; cy += 1) {
        const chunk = this.ensureChunk(cx, cy);
        chunk.desiredFrame = this.frame;
        chunk.visibleFrame = this.frame;
        chunk.lastUsedFrame = this.frame;
      }
    }
  }

  private markPrefetchNeighborhood(focusX: number, focusZ: number): void {
    const focusCx = Math.floor(focusX / CHUNK_CELLS);
    const focusCy = Math.floor(focusZ / CHUNK_CELLS);
    for (let cx = focusCx - PREFETCH_RADIUS_CHUNKS; cx <= focusCx + PREFETCH_RADIUS_CHUNKS; cx += 1) {
      for (let cy = focusCy - PREFETCH_RADIUS_CHUNKS; cy <= focusCy + PREFETCH_RADIUS_CHUNKS; cy += 1) {
        const chunk = this.ensureChunk(cx, cy);
        chunk.desiredFrame = this.frame;
        chunk.lastUsedFrame = this.frame;
      }
    }
  }

  private applyVisibility(): void {
    let visible = 0;
    for (const chunk of this.chunks) {
      const isVisible = chunk.visibleFrame === this.frame;
      chunk.mesh.visible = isVisible;
      if (isVisible) visible += 1;
    }
    this.visibleChunks = visible;
  }

  private ensureChunk(cx: number, cy: number): TerrainChunk {
    let column = this.columns.get(cx);
    if (!column) {
      column = new Map<number, TerrainChunk>();
      this.columns.set(cx, column);
    }
    const existing = column.get(cy);
    if (existing) return existing;

    const geometry = new PlaneGeometry(CHUNK_CELLS, CHUNK_CELLS, 1, 1);
    const material = new MeshBasicMaterial({ color: placeholderHexForBiome(this.biome), fog: true });
    this.installTerrainMaterialPatch(material);
    const mesh = new Mesh(geometry, material);
    mesh.name = `terrain:${this.biome}:${this.worldSeed}:${cx}:${cy}`;
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(cx * CHUNK_CELLS + CHUNK_HALF_CELLS, TERRAIN_Y, cy * CHUNK_CELLS + CHUNK_HALF_CELLS);
    mesh.visible = false;
    this.scene.add(mesh);

    const chunk: TerrainChunk = {
      cx,
      cy,
      label: `${cx},${cy}`,
      mesh,
      material,
      texture: null,
      desiredFrame: -1,
      visibleFrame: -1,
      lastUsedFrame: this.frame,
      bakeState: "unbaked",
      alive: true,
    };
    column.set(cy, chunk);
    this.chunks.add(chunk);
    this.enqueueBake(chunk);
    return chunk;
  }

  private installTerrainMaterialPatch(material: MeshBasicMaterial): void {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.terrainDetailMap = this.detailTextureUniform;
      shader.uniforms.terrainDetailUvScale = this.detailUvScaleUniform;
      shader.uniforms.terrainDetailStrength = this.detailStrengthUniform;
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <map_pars_fragment>",
        `
        #include <map_pars_fragment>
        uniform sampler2D terrainDetailMap;
        uniform float terrainDetailUvScale;
        uniform float terrainDetailStrength;
        `,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <map_fragment>",
        `
        #include <map_fragment>
        #ifdef USE_MAP
          float terrainDetailValue = texture2D( terrainDetailMap, vMapUv * terrainDetailUvScale ).r * 2.0 - 1.0;
          diffuseColor.rgb *= clamp( 1.0 + terrainDetailValue * terrainDetailStrength, 0.0, 2.0 );
        #endif
        `,
      );
      this.env?.sunShadow.injectReceiver(shader);
    };
    material.customProgramCacheKey = () => "successor-terrain-detail-v2-sunshadow";
  }

  private updateDetailUniform(bounds: GroundBounds): void {
    const widthX = Math.max(0, bounds.maxX - bounds.minX);
    const widthZ = Math.max(0, bounds.maxZ - bounds.minZ);
    const boundsWidth = Math.max(widthX, widthZ);
    const fade = 1 - smoothstep(DETAIL_FULL_BOUNDS_WIDTH, DETAIL_ZERO_BOUNDS_WIDTH, boundsWidth);
    const amplitude = sanitizeDetailAmplitude(this.stats.detailAmplitude);
    this.stats.detailAmplitude = amplitude;
    this.detailStrengthUniform.value = amplitude * fade;
  }

  private applyTextureFilterDial(): void {
    const nearest = this.stats.nearestFilter === true;
    if (nearest === this.lastNearestFilter) return;
    this.lastNearestFilter = nearest;
    for (const chunk of this.chunks) {
      if (chunk.texture) applyTerrainTextureFilter(chunk.texture, nearest);
    }
  }

  private enqueueBake(chunk: TerrainChunk): void {
    if (chunk.bakeState !== "unbaked") return;
    chunk.bakeState = "queued";
    this.bakeQueue.push(chunk);
  }

  private processBakeBudget(): void {
    if (!this.currentBake) {
      const chunk = this.takeNextQueuedChunk();
      if (chunk) this.currentBake = this.startBake(chunk);
    }
    if (!this.currentBake) return;

    const job = this.currentBake;
    const startMs = performance.now();
    const endRow = Math.min(TEXTURE_PIXELS, job.nextRow + BAKE_ROWS_PER_FRAME);
    const data = job.imageData.data;
    const chunkOriginX = job.chunk.cx * CHUNK_CELLS;
    const chunkOriginZ = job.chunk.cy * CHUNK_CELLS;
    for (let row = job.nextRow; row < endRow; row += 1) {
      const worldZ = chunkOriginZ + row * TEXEL_WORLD_STEP;
      let offset = row * TEXTURE_PIXELS * 4;
      for (let col = 0; col < TEXTURE_PIXELS; col += 1) {
        const worldX = chunkOriginX + col * TEXEL_WORLD_STEP;
        const kind = paintTerrainPixel(this.worldSeed, worldX, worldZ, data, offset, this.biome);
        if (kind === TerrainKind.Desert) job.desertPixels += 1;
        else if (kind === TerrainKind.Scrub) job.scrubPixels += 1;
        else job.hardpanPixels += 1;
        offset += 4;
      }
    }
    const sliceMs = performance.now() - startMs;
    job.cpuMs += sliceMs;
    this.stats.lastBakeSliceMs = roundTenths(sliceMs);
    this.recordBakeSample(sliceMs, this.bakeSliceSamples);
    this.stats.p95BakeSliceMs = roundTenths(percentile95(this.bakeSliceSamples));
    job.nextRow = endRow;
    if (job.nextRow >= TEXTURE_PIXELS) this.finishBake(job);
  }

  private takeNextQueuedChunk(): TerrainChunk | null {
    let selectedIndex = -1;
    for (let i = this.bakeQueueHead; i < this.bakeQueue.length; i += 1) {
      const chunk = this.bakeQueue[i];
      if (!chunk || !chunk.alive || chunk.bakeState !== "queued") continue;
      selectedIndex = i;
      if (chunk.visibleFrame === this.frame) break;
    }
    if (selectedIndex < 0) {
      this.compactBakeQueueIfEmpty();
      return null;
    }
    const chunk = this.bakeQueue[selectedIndex]!;
    this.bakeQueue[selectedIndex] = this.bakeQueue[this.bakeQueueHead]!;
    this.bakeQueue[this.bakeQueueHead] = chunk;
    this.bakeQueueHead += 1;
    return chunk;
  }

  private startBake(chunk: TerrainChunk): TerrainBakeJob | null {
    const canvas = document.createElement("canvas");
    canvas.width = TEXTURE_PIXELS;
    canvas.height = TEXTURE_PIXELS;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) {
      chunk.bakeState = "unbaked";
      return null;
    }
    chunk.bakeState = "baking";
    return {
      chunk,
      canvas,
      context,
      imageData: context.createImageData(TEXTURE_PIXELS, TEXTURE_PIXELS),
      nextRow: 0,
      cpuMs: 0,
      wallStartMs: performance.now(),
      desertPixels: 0,
      scrubPixels: 0,
      hardpanPixels: 0,
    };
  }

  private finishBake(job: TerrainBakeJob): void {
    const chunk = job.chunk;
    job.context.putImageData(job.imageData, 0, 0);
    const texture = new CanvasTexture(job.canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.generateMipmaps = false;
    applyTerrainTextureFilter(texture, this.stats.nearestFilter === true);

    if (chunk.texture) {
      chunk.texture.dispose();
    } else {
      this.residentTextures += 1;
    }
    chunk.texture = texture;
    chunk.material.map = texture;
    // The DESERT_HEX base color is the pre-bake placeholder fill ONLY. Once
    // the baked map attaches it MUST reset to white — MeshBasicMaterial
    // multiplies color × map, and sandy-tint × sandy-texture sRGB-squares
    // the whole ground into dark rust.
    chunk.material.color.set(0xffffff);
    chunk.material.needsUpdate = true;
    chunk.bakeState = "ready";

    const totalPixels = TEXTURE_PIXELS * TEXTURE_PIXELS;
    this.stats.lastBakeCpuMs = roundTenths(job.cpuMs);
    this.stats.lastBakeWallMs = roundTenths(performance.now() - job.wallStartMs);
    this.stats.lastBakeMix.desert = roundTenths((job.desertPixels / totalPixels) * 100);
    this.stats.lastBakeMix.scrub = roundTenths((job.scrubPixels / totalPixels) * 100);
    this.stats.lastBakeMix.hardpan = roundTenths((job.hardpanPixels / totalPixels) * 100);
    this.stats.bakedChunks += 1;
    this.recordBakeSample(job.cpuMs, this.bakeCpuSamples);
    this.recordBakeSample(performance.now() - job.wallStartMs, this.bakeWallSamples);
    this.stats.p95BakeCpuMs = roundTenths(percentile95(this.bakeCpuSamples));
    this.stats.p95BakeWallMs = roundTenths(percentile95(this.bakeWallSamples));
    this.currentBake = null;
  }

  private evictOverCap(): void {
    while (this.chunks.size > LRU_CAP && this.chunks.size > LRU_FLOOR) {
      let oldest: TerrainChunk | null = null;
      for (const chunk of this.chunks) {
        if (chunk.desiredFrame === this.frame || this.currentBake?.chunk === chunk) continue;
        if (!oldest || chunk.lastUsedFrame < oldest.lastUsedFrame) oldest = chunk;
      }
      if (!oldest) return;
      this.evictChunk(oldest);
    }
  }

  private evictChunk(chunk: TerrainChunk): void {
    chunk.alive = false;
    const column = this.columns.get(chunk.cx);
    column?.delete(chunk.cy);
    if (column && column.size === 0) this.columns.delete(chunk.cx);
    this.chunks.delete(chunk);
    this.scene.remove(chunk.mesh);
    chunk.mesh.geometry.dispose();
    chunk.material.dispose();
    if (chunk.texture) {
      chunk.texture.dispose();
      this.residentTextures -= 1;
    }
    this.stats.evictedChunks += 1;
  }

  private clear(): void {
    this.currentBake = null;
    this.bakeQueue.length = 0;
    this.bakeQueueHead = 0;
    for (const chunk of this.chunks) {
      this.scene.remove(chunk.mesh);
      chunk.mesh.geometry.dispose();
      chunk.material.dispose();
      chunk.texture?.dispose();
      chunk.alive = false;
    }
    this.columns.clear();
    this.chunks.clear();
    this.residentTextures = 0;
    this.visibleChunks = 0;
  }

  private publishStats(): void {
    this.stats.visibleChunks = this.visibleChunks;
    this.stats.drawCalls = this.visibleChunks;
    this.stats.residentChunks = this.chunks.size;
    this.stats.residentTextures = this.residentTextures;
    this.stats.queuedChunks = this.countQueuedChunks();
    this.stats.baking = this.currentBake !== null;
    this.stats.currentBakeChunk = this.currentBake ? this.currentBake.chunk.label : null;
  }

  /** Queued + in-flight bake work — drives the boot warmup drain. */
  pendingBakeWork(): number {
    return this.countQueuedChunks() + (this.currentBake ? 1 : 0);
  }

  private countQueuedChunks(): number {
    let count = 0;
    for (let i = this.bakeQueueHead; i < this.bakeQueue.length; i += 1) {
      const chunk = this.bakeQueue[i];
      if (chunk && chunk.alive && chunk.bakeState === "queued") count += 1;
    }
    return count;
  }

  private compactBakeQueueIfEmpty(): void {
    this.bakeQueue.length = 0;
    this.bakeQueueHead = 0;
  }

  private recordBakeSample(value: number, samples: number[]): void {
    if (samples.length >= 32) samples.shift();
    samples.push(value);
  }
}

export function worldSeedFromSlice(slice: SliceSnapshot): number {
  const maybeSlice: unknown = slice;
  if (maybeSlice && typeof maybeSlice === "object" && "worldSeed" in maybeSlice) {
    const rawSeed = maybeSlice.worldSeed;
    if (typeof rawSeed === "number" && Number.isFinite(rawSeed)) return normalizeWorldSeed(rawSeed);
  }
  return normalizeWorldSeed(SUCCESSOR_3D_CONFIG.terrain.fallbackWorldSeed);
}

export function effectiveWorldSeedFromSliceArea(slice: SliceSnapshot, activeAreaId: string): number {
  const sliceSeed = worldSeedFromSlice(slice);
  return mixWorldSeedWithArea(sliceSeed, activeAreaId);
}

export function mixWorldSeedWithArea(sliceWorldSeed: number, areaId: string): number {
  const baseSeed = normalizeWorldSeed(sliceWorldSeed);
  const areaHash = fnv1a32(areaId);
  const areaSalt = avalanche32((areaHash ^ ASHVAT_AREA_SEED_HASH) >>> 0);
  return (baseSeed ^ areaSalt) >>> 0;
}

export function biomeIdFromSliceArea(slice: SliceSnapshot, activeAreaId: string): SuccessorBiomeId {
  const maybeSlice: unknown = slice;
  if (maybeSlice && typeof maybeSlice === "object" && "areas" in maybeSlice && Array.isArray(maybeSlice.areas)) {
    for (let i = 0; i < maybeSlice.areas.length; i += 1) {
      const area = maybeSlice.areas[i] as { readonly id?: unknown; readonly biome?: unknown };
      if (area.id !== activeAreaId) continue;
      if (area.biome === "forest" || area.biome === "desert") return area.biome;
      break;
    }
  }
  if (areaIdContainsForest(activeAreaId)) return "forest";
  return "desert";
}

function areaIdContainsForest(areaId: string): boolean {
  const needle = "forest";
  const maxStart = areaId.length - needle.length;
  for (let i = 0; i <= maxStart; i += 1) {
    let matched = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (asciiLowerCode(areaId.charCodeAt(i + j)) !== needle.charCodeAt(j)) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function asciiLowerCode(code: number): number {
  if (code >= 65 && code <= 90) return code + 32;
  return code;
}

function placeholderHexForBiome(biome: SuccessorBiomeId): number {
  if (biome === "forest") return FOREST_HEX;
  return DESERT_HEX;
}

function fnv1a32(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function avalanche32(value: number): number {
  let hash = value >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

function normalizeWorldSeed(value: number): number {
  if (!Number.isFinite(value)) return SUCCESSOR_3D_CONFIG.terrain.fallbackWorldSeed >>> 0;
  return Math.trunc(value) >>> 0;
}

function percentile95(samples: number[]): number {
  if (samples.length === 0) return 0;
  const rank = Math.ceil(samples.length * 0.95) - 1;
  let selected = Infinity;
  for (let i = 0; i < samples.length; i += 1) {
    const candidate = samples[i] ?? 0;
    let lower = 0;
    let equal = 0;
    for (let j = 0; j < samples.length; j += 1) {
      const value = samples[j] ?? 0;
      if (value < candidate) lower += 1;
      else if (value === candidate) equal += 1;
    }
    if (lower <= rank && rank < lower + equal && candidate < selected) selected = candidate;
  }
  return Number.isFinite(selected) ? selected : 0;
}

function roundTenths(value: number): number {
  return Math.round(value * 10) / 10;
}

function createTerrainDetailTexture(seed: number): DataTexture {
  const data = new Uint8Array(DETAIL_TEXTURE_PIXELS * DETAIL_TEXTURE_PIXELS);
  let offset = 0;
  for (let y = 0; y < DETAIL_TEXTURE_PIXELS; y += 1) {
    for (let x = 0; x < DETAIL_TEXTURE_PIXELS; x += 1) {
      const low = periodicValueNoise(seed, x / 8, y / 8, 16, 0x5d71);
      const mid = periodicValueNoise(seed, x / 4, y / 4, 32, 0x8b3f);
      const high = periodicValueNoise(seed, x / 2, y / 2, 64, 0xc2a9);
      const value = Math.max(0, Math.min(1, ((low * 0.52 + mid * 0.31 + high * 0.17) - 0.5) * 1.24 + 0.5));
      data[offset] = Math.round(value * 255);
      offset += 1;
    }
  }
  const texture = new DataTexture(data, DETAIL_TEXTURE_PIXELS, DETAIL_TEXTURE_PIXELS, RedFormat, UnsignedByteType);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function applyTerrainTextureFilter(texture: CanvasTexture, nearest: boolean): void {
  const filter = nearest ? NearestFilter : LinearFilter;
  texture.minFilter = filter;
  texture.magFilter = filter;
  texture.needsUpdate = true;
}

function sanitizeDetailAmplitude(value: number): number {
  if (!Number.isFinite(value)) return TERRAIN_DETAIL.amplitude;
  return Math.max(0, Math.min(0.24, value));
}

function periodicValueNoise(seed: number, x: number, y: number, period: number, salt: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = smootherstep(x - xi);
  const ty = smootherstep(y - yi);
  const x0 = positiveModulo(xi, period);
  const x1 = positiveModulo(xi + 1, period);
  const y0 = positiveModulo(yi, period);
  const y1 = positiveModulo(yi + 1, period);
  const a = hashUnit(seed, x0, y0, salt);
  const b = hashUnit(seed, x1, y0, salt);
  const c = hashUnit(seed, x0, y1, salt);
  const d = hashUnit(seed, x1, y1, salt);
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}

function hashUnit(seed: number, x: number, y: number, salt: number): number {
  let h = (seed ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ salt) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h = (h ^ (h >>> 15)) >>> 0;
  return h / 0xffffffff;
}

function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return smootherstep(t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function positiveModulo(value: number, modulus: number): number {
  const remainder = value % modulus;
  return remainder < 0 ? remainder + modulus : remainder;
}
