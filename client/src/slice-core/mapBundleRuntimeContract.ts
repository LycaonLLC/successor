import type { SliceSnapshot } from "./gameState";

export const successorMapBundleRuntimeSchema = "successor.map-bundle.v1";

export interface SuccessorMapBundle {
  schema: typeof successorMapBundleRuntimeSchema;
  source: {
    schema: string;
    path: string | null;
    hash: string;
    stateHash: string;
  };
  grid: {
    cellSizePx: number;
    chunkSizeCells: number;
  };
  metrics: SuccessorMapBundleMetrics;
}

export interface SuccessorMapBundleMetrics {
  areaCount: number;
  totalCells: number;
  chunkCount: number;
  collisionCells: number;
  propAnchors: number;
  transitionTriggers: number;
  cloneFacilities: number;
  spawnPoints: number;
  occluders: number;
  lightingZones: number;
  audioZones: number;
}

export interface SuccessorMapBundleProbe {
  schema: typeof successorMapBundleRuntimeSchema;
  sourceHash: string;
  stateHash: string;
  cellSizePx: number;
  chunkSizeCells: number;
  areaCount: number;
  totalCells: number;
  chunkCount: number;
  collisionCells: number;
  propAnchors: number;
  transitionTriggers: number;
  cloneFacilities: number;
  spawnPoints: number;
  occluders: number;
  lightingZones: number;
  audioZones: number;
}

export function sliceMapSourceHash(slice: SliceSnapshot): string {
  return stableHash(stableStringify({
    schema: slice.schema,
    grid: slice.grid,
    areas: slice.areas,
    populationTemplates: slice.populationTemplates ?? [],
    spawnZones: slice.spawnZones ?? [],
    actors: slice.actors,
    props: slice.props,
    blockedCells: slice.blockedCells,
    transitions: slice.transitions,
    cloneFacilities: slice.cloneFacilities ?? [],
  }));
}

export function validateRuntimeMapBundleForSlice(
  slice: SliceSnapshot,
  bundle: SuccessorMapBundle,
): SuccessorMapBundle {
  assert(bundle.schema === successorMapBundleRuntimeSchema, `map bundle schema mismatch: ${bundle.schema}`);
  assert(bundle.source.schema === slice.schema, "map bundle source schema mismatch");
  assert(bundle.source.stateHash === slice.stateHash, "map bundle source stateHash mismatch");
  assert(bundle.source.hash === sliceMapSourceHash(slice), "map bundle source hash mismatch");
  assert(bundle.grid.cellSizePx === slice.grid.cellSizePx, "map bundle grid cellSizePx mismatch");
  assert(Number.isInteger(bundle.grid.chunkSizeCells) && bundle.grid.chunkSizeCells > 0, "map bundle chunk size mismatch");

  const cloneFacilities = slice.cloneFacilities ?? [];
  assert(bundle.metrics.areaCount === slice.areas.length, "map bundle area count mismatch");
  assert(bundle.metrics.totalCells === totalCells(slice), "map bundle total cells mismatch");
  assert(bundle.metrics.chunkCount === expectedChunkCount(slice, bundle.grid.chunkSizeCells), "map bundle chunk count mismatch");
  assert(bundle.metrics.propAnchors === slice.props.length, "map bundle prop anchor count mismatch");
  assert(bundle.metrics.transitionTriggers === slice.transitions.length, "map bundle transition count mismatch");
  assert(bundle.metrics.cloneFacilities === cloneFacilities.length, "map bundle clone facility count mismatch");
  assert(bundle.metrics.spawnPoints === slice.actors.length + cloneFacilities.length, "map bundle spawn point count mismatch");
  assert(bundle.metrics.lightingZones === slice.areas.length, "map bundle lighting zone count mismatch");
  assert(bundle.metrics.audioZones === slice.areas.length, "map bundle audio zone count mismatch");
  assert(nonNegativeInteger(bundle.metrics.collisionCells), "map bundle collision count mismatch");
  assert(nonNegativeInteger(bundle.metrics.occluders), "map bundle occluder count mismatch");
  return bundle;
}

export function mapBundleProbe(bundle: SuccessorMapBundle): SuccessorMapBundleProbe {
  return {
    schema: bundle.schema,
    sourceHash: bundle.source.hash,
    stateHash: bundle.source.stateHash,
    cellSizePx: bundle.grid.cellSizePx,
    chunkSizeCells: bundle.grid.chunkSizeCells,
    areaCount: bundle.metrics.areaCount,
    totalCells: bundle.metrics.totalCells,
    chunkCount: bundle.metrics.chunkCount,
    collisionCells: bundle.metrics.collisionCells,
    propAnchors: bundle.metrics.propAnchors,
    transitionTriggers: bundle.metrics.transitionTriggers,
    cloneFacilities: bundle.metrics.cloneFacilities,
    spawnPoints: bundle.metrics.spawnPoints,
    occluders: bundle.metrics.occluders,
    lightingZones: bundle.metrics.lightingZones,
    audioZones: bundle.metrics.audioZones,
  };
}

function totalCells(slice: SliceSnapshot): number {
  return slice.areas.reduce((total, area) => total + area.width * area.height, 0);
}

function expectedChunkCount(slice: SliceSnapshot, chunkSizeCells: number): number {
  return slice.areas.reduce(
    (total, area) => total + Math.ceil(area.width / chunkSizeCells) * Math.ceil(area.height / chunkSizeCells),
    0,
  );
}

function nonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
