import {
  Box3,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
  Texture,
  Vector3,
  type Material,
  type Object3D,
  type Scene,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { PlayState, ServerAuthorityFarmCropState } from "@successor/client/src/slice-core/gameState";
import { requireRuntimePublicPath } from "@successor/client/src/slice-core/runtimePublicPaths";
import { markSunShadowCaster } from "./environment/sunShadow";

/**
 * World crop meshes on streamed farm tiles — dynamic authority entities,
 * NOT area props (extractors/camps pattern).
 *
 * `serverAuthority.farmPlots` is a full-replace list of per-parcel tile
 * detail; crop render state is world-visible (only `legalVerbs` is
 * owner-scoped), so every planted tile in the active area gets a mesh. Each
 * frame reconciles tiles against live instances: spawn on first sight,
 * despawn on removal/harvest, swap on look change.
 *
 * Mapping is SERVER-STATE-ONLY (asset-rebase contract §crops): the streamed
 * `{species, stage, stageCount, mature, health}` picks one of four authored
 * looks per species —
 *
 *   look   = floor(stage / max(stageCount-1, 1) * 2) clamped 0..2
 *            → planted | establishing | laden
 *   mature = true forces `laden`
 *   health ≤ 0 forces `husk` (dead beats mature)
 *   health < 35 keeps the growth look but applies the restrained distressed
 *            presentation (desaturated tint + slight droop)
 *
 * There is NO local growth simulation, timer, or inference here — a tile
 * only ever changes look because the streamed row changed.
 *
 * Wire-health adapter: the current farmPlot channel streams `health` as a
 * STRING ("vigorous" | "wilting" | "dormant" — farming.rs W3). The contract's
 * numeric 0..100 health channel is NOT yet streamed; `cropHealthPct`
 * normalizes both shapes so the numeric mapping above stays the single
 * source of truth and the wire can upgrade without touching the renderer.
 *
 * Assets: one GLTFLoader, one template per GLB path (cached by path — nine
 * species × four looks, loaded on demand). Instances are `clone(true)` of
 * the cached hierarchy: node names/userData survive, geometry and materials
 * stay SHARED with the template (native GLB materials survive through the
 * shared unlit conversion — camps/extractors convention; no lights in this
 * scene, a MeshStandardMaterial would render black). Distressed instances
 * are the one exception: they clone their materials (owned → disposed on
 * despawn) so the desaturation never leaks into healthy siblings.
 *
 * Transforms are deterministic: position = tile cell + 0.5 (the extractor
 * grid voice), yaw = FNV-1a hash of the stable tile key, scale = 1 (crop
 * GLBs are authored at real metric size for the ~1 m tile, ground at y=0,
 * centered on X/Z — asset-lane contract 2026-07-12).
 */

// ── Species / path registry ────────────────────────────────────────────────

export const CROP_WORLD_LOOKS = ["planted", "establishing", "laden", "husk"] as const;
export type CropWorldLook = (typeof CROP_WORLD_LOOKS)[number];

/** The nine catalog species (successor-asset-rebase-20260712 catalog.json). */
export const CROP_WORLD_SPECIES = [
  "ashgrain",
  "sunmelon",
  "cavemoss",
  "emberbean",
  "riftroot",
  "brineleaf",
  "glasspepper",
  "coilreed",
  "nightplum",
] as const;
export type CropWorldSpecies = (typeof CROP_WORLD_SPECIES)[number];

const SPECIES_LOOKUP: Record<string, true> = {
  ashgrain: true, sunmelon: true, cavemoss: true, emberbean: true, riftroot: true,
  brineleaf: true, glasspepper: true, coilreed: true, nightplum: true,
};

export function isCropWorldSpecies(species: string): species is CropWorldSpecies {
  return SPECIES_LOOKUP[species] === true;
}

/** Exact catalog path template — never remapped, never aliased. */
export function cropWorldGlbPath(species: CropWorldSpecies, look: CropWorldLook): string {
  return `/assets/items/custom/crops/world/${species}/${look}.glb`;
}

// ── Pure server-state → look mapping ───────────────────────────────────────

export interface CropLookState {
  stage: number;
  stageCount: number;
  mature: boolean;
  /** Numeric 0..100 (see `cropHealthPct` for the wire adapter). */
  health: number;
}

export interface ResolvedCropLook {
  look: CropWorldLook;
  /** Restrained desaturation + droop; never true for husk (dead, not sick). */
  distressed: boolean;
}

const GROWTH_LOOKS = ["planted", "establishing", "laden"] as const;
export const CROP_DISTRESS_HEALTH_PCT = 35;

export function resolveCropLook(state: CropLookState): ResolvedCropLook {
  if (state.health <= 0) return { look: "husk", distressed: false };
  let index: number;
  if (state.mature) {
    index = 2;
  } else {
    const denominator = Math.max(state.stageCount - 1, 1);
    index = Math.floor((state.stage / denominator) * 2);
    if (index < 0) index = 0;
    else if (index > 2) index = 2;
  }
  return { look: GROWTH_LOOKS[index]!, distressed: state.health < CROP_DISTRESS_HEALTH_PCT };
}

/**
 * Wire-health → numeric percent. The live farmPlot channel streams a health
 * STRING (farming.rs: "vigorous" | "wilting" | "dormant"); a future numeric
 * channel passes through unchanged. Unknown values read as healthy — the
 * renderer never invents distress the server didn't send.
 */
export function cropHealthPct(health: string | number | null | undefined): number {
  if (typeof health === "number") return Number.isFinite(health) ? health : 100;
  switch (health) {
    case "wilting":
      return 30; // below the 35 distress line — wilting IS the streamed distress signal
    case "dormant":
      return 15; // drought-paused: alive but visibly struggling
    case "dead":
    case "husk":
      return 0;
    default:
      return 100; // "vigorous" and anything unrecognized
  }
}

/** Streamed crop row → the exact GLB path + presentation, or null for species
 *  outside the nine-species registry (never fabricate a mesh). */
export function resolveCropRender(crop: Pick<ServerAuthorityFarmCropState, "species" | "stage" | "stageCount" | "mature" | "health">): { path: string; look: CropWorldLook; distressed: boolean } | null {
  if (!isCropWorldSpecies(crop.species)) return null;
  const { look, distressed } = resolveCropLook({
    stage: crop.stage,
    stageCount: crop.stageCount,
    mature: crop.mature,
    health: cropHealthPct(crop.health),
  });
  return { path: cropWorldGlbPath(crop.species, look), look, distressed };
}

// ── Deterministic transforms ───────────────────────────────────────────────

/** FNV-1a yaw hash — the extractors/props deterministic randomYaw voice. */
export function cropYawFor(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 3600) * (Math.PI / 1800);
}

/** Stable per-tile instance key (parcel + world cell). */
export function cropTileKey(parcelId: string, cellX: number, cellY: number): string {
  return `${parcelId}:${cellX}:${cellY}`;
}

/** Restrained distress presentation — constants, not knobs. */
const DISTRESS_TINT = new Color(0x8f8d77);
const DISTRESS_TINT_LERP = 0.45;
const DISTRESS_DROOP_RAD = 0.1;
const DISTRESS_HEIGHT_SCALE = 0.92;

// ── Renderer ───────────────────────────────────────────────────────────────

/** Injectable loader seam (tests stub this; runtime uses GLTFLoader). */
export type CropGltfLoader = (url: string) => Promise<{ scene: Object3D }>;

interface CropInstance {
  root: Object3D;
  path: string;
  distressed: boolean;
  /** Per-instance material clones (distressed only) — owned, disposed on despawn. */
  ownedMaterials: Material[];
  cellX: number;
  cellY: number;
  seenAtSync: number;
}

const tmpBox = new Box3();
const tmpCenter = new Vector3();

export class FarmCropsRenderer {
  private readonly group = new Group();
  private readonly instances = new Map<string, CropInstance>();
  private readonly templates = new Map<string, Object3D>();
  private readonly requested = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly loadGltf: CropGltfLoader;
  private syncCounter = 0;

  constructor(private readonly scene: Scene, loadGltf?: CropGltfLoader) {
    if (loadGltf) {
      this.loadGltf = loadGltf;
    } else {
      const loader = new GLTFLoader();
      this.loadGltf = (url) => loader.loadAsync(requireRuntimePublicPath(url));
    }
    this.group.name = "farm-crops";
    this.scene.add(this.group);
  }

  /** Per-frame: reconcile streamed farm-plot tiles against live instances. */
  update(state: PlayState): void {
    const plots = state.serverAuthority.farmPlots;
    if (plots.length === 0 && this.instances.size === 0) return;

    this.syncCounter += 1;
    for (const plot of plots) {
      if (plot.areaId !== state.activeAreaId) continue;
      for (const tile of plot.tiles) {
        const crop = tile.crop;
        if (!crop) continue;
        const render = resolveCropRender(crop);
        if (!render) continue; // species outside the nine-species registry
        const template = this.templates.get(render.path);
        if (!template) {
          this.requestTemplate(render.path);
          continue;
        }
        const key = cropTileKey(plot.parcelId, tile.cellX, tile.cellY);
        let instance = this.instances.get(key);
        if (instance && (instance.path !== render.path || instance.distressed !== render.distressed)) {
          // Look/health change: full swap — the new streamed row owns the mesh.
          this.despawn(key, instance);
          instance = undefined;
        }
        if (!instance) {
          instance = this.spawn(key, template, render.path, render.distressed, tile.cellX, tile.cellY);
          this.instances.set(key, instance);
        }
        instance.seenAtSync = this.syncCounter;
      }
    }

    for (const [key, instance] of this.instances) {
      if (instance.seenAtSync !== this.syncCounter) this.despawn(key, instance);
    }
  }

  dispose(): void {
    for (const [key, instance] of this.instances) this.despawn(key, instance);
    for (const template of this.templates.values()) {
      template.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        object.geometry.dispose();
        disposeMeshMaterial(object);
      });
    }
    this.templates.clear();
    this.scene.remove(this.group);
  }

  /** Live instance count by GLB path (debug probe / smoke diagnostics). */
  debugInstanceCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const instance of this.instances.values()) {
      counts[instance.path] = (counts[instance.path] ?? 0) + 1;
    }
    return counts;
  }

  /** Paths that failed to load (smoke diagnostics — missing GLBs are loud). */
  debugFailedPaths(): string[] {
    return [...this.failed];
  }

  private requestTemplate(path: string): void {
    if (this.requested.has(path) || this.failed.has(path)) return;
    this.requested.add(path);
    this.loadGltf(path)
      .then((gltf) => {
        gltf.scene.updateMatrixWorld(true);
        tmpBox.setFromObject(gltf.scene);
        tmpBox.getCenter(tmpCenter);
        gltf.scene.position.x -= tmpCenter.x;
        gltf.scene.position.z -= tmpCenter.z;
        gltf.scene.traverse((object) => {
          if (!(object instanceof Mesh)) return;
          object.material = toUnlitMaterial(object);
        });
        this.templates.set(path, gltf.scene);
      })
      .catch((error: unknown) => {
        this.failed.add(path);
        console.error(`farm crops: failed to load ${path}`, error);
      });
  }

  private spawn(key: string, template: Object3D, path: string, distressed: boolean, cellX: number, cellY: number): CropInstance {
    const root = template.clone(true);
    root.position.set(cellX + 0.5, 0, cellY + 0.5);
    root.rotation.y = cropYawFor(key);
    const ownedMaterials: Material[] = [];
    if (distressed) {
      // Owned material clones: tint one instance without touching the shared
      // template materials. Droop is a slight deterministic lean + squash.
      root.rotation.z = DISTRESS_DROOP_RAD;
      root.scale.y = DISTRESS_HEIGHT_SCALE;
      root.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        const source = firstMaterialOf(object);
        if (!(source instanceof MeshBasicMaterial)) return;
        const owned = source.clone();
        owned.color.lerp(DISTRESS_TINT, DISTRESS_TINT_LERP);
        object.material = owned;
        ownedMaterials.push(owned);
      });
    }
    root.traverse((object) => {
      if (object instanceof Mesh) markSunShadowCaster(object);
    });
    this.group.add(root);
    return { root, path, distressed, ownedMaterials, cellX, cellY, seenAtSync: this.syncCounter };
  }

  private despawn(key: string, instance: CropInstance): void {
    this.group.remove(instance.root);
    for (const material of instance.ownedMaterials) material.dispose();
    // Geometry and healthy materials belong to the shared template — never
    // disposed per instance.
    this.instances.delete(key);
  }
}

/** GLTF PBR → the world-prop unlit basic look (fog on, textures sRGB) —
 *  the camps/extractors conversion: native map/color/name survive. */
function toUnlitMaterial(mesh: Mesh): MeshBasicMaterial {
  const source = firstMaterialOf(mesh);
  const material = new MeshBasicMaterial({ fog: true });
  if (source && "map" in source && source.map instanceof Texture) {
    source.map.colorSpace = SRGBColorSpace;
    material.map = source.map;
  }
  if (source && "color" in source && source.color instanceof Color) {
    material.color.copy(source.color);
  }
  material.name = source?.name ? `${source.name}:successor-basic` : "successor-basic-crop";
  return material;
}

function firstMaterialOf(mesh: Mesh): Material | null {
  const raw = mesh.material;
  return Array.isArray(raw) ? raw[0] ?? null : raw ?? null;
}

function disposeMeshMaterial(mesh: Mesh): void {
  const raw = mesh.material;
  if (Array.isArray(raw)) {
    for (const material of raw) material.dispose();
  } else {
    raw.dispose();
  }
}
