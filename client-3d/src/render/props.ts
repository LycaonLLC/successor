import {
  Box3,
  BoxGeometry,
  CanvasTexture,
  Color,
  EdgesGeometry,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LinearFilter,
  LinearMipmapLinearFilter,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshMatcapMaterial,
  Quaternion,
  Raycaster,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Camera,
  type Material,
  type Object3D,
  type Scene,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { requireRuntimePublicPath } from "@successor/client/src/slice-core/runtimePublicPaths";
import { propsForArea } from "@successor/client/src/slice-core/worldQueries";
import type { PropSnapshot } from "@successor/client/src/slice-core/worldTypes";
import propsMappingJson from "./props-mapping.json";

interface PropsMappingFile {
  assetBase: string;
  entries: Record<string, MappingEntry>;
  defaultPlaceholder: PlaceholderSpec;
}

const propsMapping = propsMappingJson as PropsMappingFile;
import { markSunShadowCaster, SUN_SHADOW_CASTER_LAYER } from "./environment/sunShadow";

// World props: instanced GLB placement from the renderer-neutral map bundle.
// Contract: 1 cell = 1 world unit, sim (x, y) -> world (x, 0, y), ground at y=0,
// instanced meshes for repeated props, no per-frame allocations.

interface PlaceholderSpec {
  height: number;
  tint: string;
  needsAuthoring: string;
  randomYaw?: boolean;
}

interface MappingNodeTransform {
  /** Exact node name inside the GLB (e.g. the H1 house "door_slide"). */
  node: string;
  /** Translation added to the node's local position at bake time ([x, y, z]). */
  translate?: number[];
}
interface MappingSlideDoor {
  /** Door node name inside the GLB (e.g. "door_slide"). */
  node: string;
  /** Node-local slide direction to the OPEN pose (normalized at bake). */
  axisLocal: number[];
  /** Slide distance in GLB units (metres) to the fully-open pose. */
  distance: number;
}

interface MappingEnterable {
  /**
   * Legacy fallback floor surface in runtime world units (GLB floor is y=0).
   * The canonical value is the authored prop's `enterable.floorHeightM`
   * (builder sidecar); this exists only for old slices without it (0 if unset).
   */
  floorHeightM?: number;
  /** Mesh-node prefixes faded while the local pawn is inside this instance. */
  revealPrefixes: string[];
  /** Source manifest filename; kept with mapping for audit/debug tooling. */
  manifest?: string;
  /** Fade duration in seconds; defaults to the contract quarter-second. */
  fadeSeconds?: number;
}

interface MappingEntry {
  glb?: string;
  randomYaw?: boolean;
  placeholder?: PlaceholderSpec;
  skip?: boolean;
  interactable?: boolean;
  enterable?: MappingEnterable;
  /**
   * XYZ Euler correction, in degrees, applied to the imported asset root
   * before bounds/recentering. Use this only to reconcile an authored GLB's
   * axes with the runtime's Y-up, +Z-facing prop convention.
   */
  assetRotationDegrees?: number[];
  /**
   * Bake-time node pose edits (static, per-asset) — permanent poses only;
   * animated doors use `slideDoor` instead.
   */
  nodeTransforms?: MappingNodeTransform[];
  /**
   * Animated sliding door (server-authoritative open state via
   * propStates[propId].doorOpen): parts under `node` translate along
   * `axisLocal` by `distance` — the crate-lid machinery, translating.
   */
  slideDoor?: MappingSlideDoor;
  /**
   * Node-name prefixes hidden while the local player stands inside this
   * prop's footprint (iso camera roof-peel: `roof__` on shelter houses).
   * Applies per part-mesh — all instances of the asset share visibility,
   * which is correct while shelter assets are placed once per area.
   */
  interiorRevealPrefixes?: string[];
  /** Runtime-powered screen: an authored mesh receives an external scrolling
   * strip while the rest of the GLB stays on the normal instanced prop path. */
  animatedScreen?: {
    node: string;
    texture: string;
    speed: number;
    pulseHz: number;
    repeatY: number;
  };
}

export type GlbPartRole = "body" | "lid" | "lock" | "door";

interface GlbPart {
  geometry: BufferGeometry;
  material: Material | Material[];
  /** Recentered mesh matrix within the GLB (closed pose). */
  localMatrix: Matrix4;
  role: GlbPartRole;
  /** Lid/door parts: placement * preNode * X(t) * postNode = instance matrix. */
  preHinge: Matrix4 | null;
  postHinge: Matrix4 | null;
  /** Part fades while the local player stands inside an enterable instance. */
  interiorReveal: boolean;
  /** Cutaway classification: floor/door NEVER join the reveal (fade) set. */
  enterableClass: EnterablePartClass;
}

interface LoadedGlb {
  parts: GlbPart[];
  footprintX: number;
  footprintZ: number;
  hasLid: boolean;
  animatedScreen: AnimatedScreenState | null;
  enterable: MappingEnterable | null;
}

type RenderMesh = InstancedMesh | Mesh;

interface LidInstanceRef {
  part: GlbPart;
  mesh: RenderMesh;
  index: number;
}

interface CrateLidState {
  placement: Matrix4;
  refs: LidInstanceRef[];
  /** 0 = closed, 1 = fully open. */
  t: number;
  target: number;
}
interface DoorSlideState {
  placement: Matrix4;
  refs: LidInstanceRef[];
  /** Node-local slide direction (normalized) and distance to fully open. */
  axis: Vector3;
  distance: number;
  /** 0 = closed, 1 = fully open. */
  t: number;
  target: number;
}

interface AnimatedScreenState {
  material: MeshBasicMaterial;
  texture: Texture;
  node: string;
  exactNodeMatches: number;
  descendantMeshMatches: number;
  activeInstanceCount: number;
  elapsedSeconds: number;
  /** Untinted pulse scalar exposed to verification; independent of RGB tint. */
  brightness: number;
  speed: number;
  pulseHz: number;
  phase: number;
}
interface EnterableInstanceState {
  propId: string;
  areaId: string;
  cellX: number;
  cellZ: number;
  sizeW: number;
  sizeH: number;
  floorHeightM: number;
  rotation: 0 | 90 | 180 | 270;
  fadeSeconds: number;
  /** Containment regions in prop-local milli-cells (explicit interiorBounds, else footprint). */
  regions: CutawayRegionMilli[];
  explicitBounds: boolean;
  revealMeshes: RevealFadeMesh[];
  floorMeshes: Mesh[];
  keepMeshes: Mesh[];
  doorMeshes: Mesh[];
  cutaway: CutawayState;
  /** Last applied eased hide amount — material writes happen only on change. */
  appliedHidden: number;
}

// ---------------------------------------------------------------------------
// Cutaway state machine (pure, snapshot-tick driven).
//
// The old implementation recomputed a binary inside/outside answer on the
// full footprint every render frame — boundary jitter flapped the whole
// facade. The machine below is per instance and only advances on NEW
// authority snapshot ticks, with inner/outer hysteresis plus a two-snapshot
// dwell before any enter/exit flip.
// ---------------------------------------------------------------------------

export type CutawayPhase = "exterior" | "entering" | "interior" | "exiting";

export interface CutawayRegionMilli {
  id?: string;
  xMilli: number;
  yMilli: number;
  wMilli: number;
  hMilli: number;
}

export interface CutawayState {
  /** Stable decision: true = the local pawn owns this interior. */
  inside: boolean;
  /** Consecutive new-tick snapshots agreeing with a pending flip. */
  dwell: number;
  lastSampledTick: number;
  /** Fade progress toward the decision (0 = exterior look, 1 = interior). */
  t: number;
}

/** Entering requires the point at least this far INSIDE a region (milli-cells). */
export const CUTAWAY_INNER_INSET_MILLI = 250;
/** Exiting requires the point at least this far OUTSIDE every region (milli-cells). */
export const CUTAWAY_OUTER_EXPAND_MILLI = 250;
/** Consecutive authority snapshots that must agree before enter/exit flips. */
export const CUTAWAY_DWELL_SNAPSHOTS = 2;

export function createCutawayState(): CutawayState {
  return { inside: false, dwell: 0, lastSampledTick: Number.NEGATIVE_INFINITY, t: 0 };
}

/** Positive margin expands the region; negative insets it (clamped so a narrow region keeps a core). */
function regionContains(region: CutawayRegionMilli, xMilli: number, zMilli: number, marginMilli: number): boolean {
  const mx = Math.max(marginMilli, 1 - region.wMilli / 2);
  const mz = Math.max(marginMilli, 1 - region.hMilli / 2);
  return xMilli >= region.xMilli - mx
    && xMilli <= region.xMilli + region.wMilli + mx
    && zMilli >= region.yMilli - mz
    && zMilli <= region.yMilli + region.hMilli + mz;
}

export function cutawayInsideInner(regions: readonly CutawayRegionMilli[], xMilli: number, zMilli: number): boolean {
  for (const region of regions) {
    if (regionContains(region, xMilli, zMilli, -CUTAWAY_INNER_INSET_MILLI)) return true;
  }
  return false;
}

export function cutawayInsideOuter(regions: readonly CutawayRegionMilli[], xMilli: number, zMilli: number): boolean {
  for (const region of regions) {
    if (regionContains(region, xMilli, zMilli, CUTAWAY_OUTER_EXPAND_MILLI)) return true;
  }
  return false;
}

/**
 * Advances the enter/exit decision — ONLY on a new authority snapshot tick.
 * Hysteresis: entering needs the inner (inset) region, exiting needs to leave
 * the outer (expanded) region; between the two thresholds the state holds.
 * A flip additionally needs CUTAWAY_DWELL_SNAPSHOTS consecutive agreements.
 */
export function sampleCutaway(
  state: CutawayState,
  snapshotTick: number,
  regions: readonly CutawayRegionMilli[],
  xMilli: number,
  zMilli: number,
): void {
  if (snapshotTick === state.lastSampledTick) return;
  state.lastSampledTick = snapshotTick;
  const wantsFlip = state.inside
    ? !cutawayInsideOuter(regions, xMilli, zMilli)
    : cutawayInsideInner(regions, xMilli, zMilli);
  if (!wantsFlip) {
    state.dwell = 0;
    return;
  }
  state.dwell += 1;
  if (state.dwell >= CUTAWAY_DWELL_SNAPSHOTS) {
    state.inside = !state.inside;
    state.dwell = 0;
  }
}

export function cutawayPhase(state: CutawayState): CutawayPhase {
  if (state.inside) return state.t >= 1 ? "interior" : "entering";
  return state.t <= 0 ? "exterior" : "exiting";
}

/**
 * Advances the fade toward the current decision and returns the eased hide
 * amount (0 = walls/roof fully visible, 1 = fully hidden). Reduced motion
 * snaps the tween AFTER the same state decision — geometry state identical.
 */
export function advanceCutawayFade(state: CutawayState, dtSeconds: number, fadeSeconds: number, reducedMotion: boolean): number {
  const target = state.inside ? 1 : 0;
  if (reducedMotion) {
    state.t = target;
  } else {
    const stepSeconds = Number.isFinite(dtSeconds) ? Math.max(0, Math.min(dtSeconds, 0.1)) : 0;
    const step = stepSeconds / Math.max(0.01, fadeSeconds);
    state.t = state.t < target
      ? Math.min(target, state.t + step)
      : Math.max(target, state.t - step);
  }
  return state.t * state.t * (3 - 2 * state.t);
}

// ---------------------------------------------------------------------------
// Fade material contract.
// ---------------------------------------------------------------------------

export interface FadeMaterialState {
  material: Material;
  /** Source material's authored endpoint values, restored when fully visible. */
  opacity: number;
  transparent: boolean;
  depthWrite: boolean;
}

export interface RevealFadeMesh {
  mesh: Mesh;
  materials: FadeMaterialState[];
}

/**
 * Fade-state contract: the VISIBLE endpoint restores every authored material
 * value (opaque walls write depth and cast sun shadows again); the HIDDEN
 * endpoint is invisible and casts no shadow; ONLY the transition renders
 * transparent with depth writes off.
 */
export function applyRevealFade(rec: RevealFadeMesh, hidden: number): void {
  if (hidden <= 0) {
    rec.mesh.visible = true;
    rec.mesh.layers.enable(SUN_SHADOW_CASTER_LAYER);
    for (const state of rec.materials) {
      state.material.opacity = state.opacity;
      state.material.transparent = state.transparent;
      state.material.depthWrite = state.depthWrite;
    }
    return;
  }
  if (hidden >= 1) {
    rec.mesh.visible = false;
    rec.mesh.layers.disable(SUN_SHADOW_CASTER_LAYER);
    return;
  }
  rec.mesh.visible = true;
  rec.mesh.layers.disable(SUN_SHADOW_CASTER_LAYER);
  for (const state of rec.materials) {
    state.material.opacity = state.opacity * (1 - hidden);
    state.material.transparent = true;
    state.material.depthWrite = false;
  }
}

// ---------------------------------------------------------------------------
// Enterable part classification.
// ---------------------------------------------------------------------------

export type EnterablePartClass = "reveal" | "keep" | "floor" | "door";

/** Gameplay door node name — NEVER cutaway-hidden, even if a mapping lists it. */
const DOOR_NODE_PREFIX = "door_slide";

/**
 * Reveal membership is decided here, and floor-named or door nodes can never
 * win it — a misconfigured revealPrefixes list cannot hide the walk surface
 * or the gameplay door.
 */
export function classifyEnterablePart(
  object: Object3D,
  role: GlbPartRole,
  revealPrefixes: readonly string[] | null,
): EnterablePartClass {
  if (role === "door") return "door";
  for (let node: Object3D | null = object; node; node = node.parent) {
    if (node.name.startsWith(DOOR_NODE_PREFIX)) return "door";
  }
  for (let node: Object3D | null = object; node; node = node.parent) {
    if (node.name.toLowerCase().includes("floor")) return "floor";
  }
  if (revealPrefixes && hasRevealPrefix(object, revealPrefixes)) return "reveal";
  return "keep";
}

// ---------------------------------------------------------------------------
// On-demand diagnostics shapes (never computed per frame).
// ---------------------------------------------------------------------------

export interface WorldBox3Debug {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export interface WorldPropEnterableCutawayDebug {
  propId: string;
  areaId: string;
  cell: { x: number; y: number };
  size: { w: number; h: number };
  rotation: number;
  floorSurfaceY: number;
  explicitInteriorBounds: boolean;
  interiorBounds: CutawayRegionMilli[];
  phase: CutawayPhase;
  dwell: number;
  target: 0 | 1;
  fade: number;
  doorOpen: boolean | null;
  doorSlideT: number | null;
  doorInRevealSet: boolean;
  meshCounts: { floor: number; reveal: number; keep: number; door: number };
  worldBounds: {
    floor: WorldBox3Debug | null;
    reveal: WorldBox3Debug | null;
    keep: WorldBox3Debug | null;
    door: WorldBox3Debug | null;
  };
}


export interface WorldPropAnimatedScreenDebug {
  node: string;
  /** Exact object-name matches in the authored GLB. */
  exactNodeMatches: number;
  /** Meshes below that node receiving the live material. */
  descendantMeshMatches: number;
  /** Placements using the animated asset in the active area. */
  activeInstanceCount: number;
  elapsedSeconds: number;
  offsetY: number;
  brightness: number;
}

export interface WorldPropPickResult {
  propId: string;
  kind: string;
  label: string;
  interactable: boolean;
}


export interface WorldPropsNeedsAuthoring {
  key: string;
  description: string;
  count: number;
}

export interface WorldPropsStats {
  areaId: string | null;
  propCount: number;
  glbPropCount: number;
  placeholderPropCount: number;
  skippedPropCount: number;
  /** Scene draw calls contributed by props (instanced meshes + placeholder batch). */
  instancedMeshCount: number;
  /** Draw calls this would cost without instancing (per-prop, per-sub-mesh). */
  naiveDrawCallCount: number;
  needsAuthoring: WorldPropsNeedsAuthoring[];
}

declare global {
  interface Window {
    __successor3dProps?: WorldPropsStats;
    /** QA hook: toggle prop visibility to measure renderer draw-call contribution. */
    __successor3dPropsSetVisible?: (visible: boolean) => void;
  }
}

const LID_MARKER = "_lid_export";
const LOCK_MARKER = "_lock_export";
const LID_OPEN_ANGLE = Math.PI * 0.4;
const LID_ANIM_SPEED = 3.2;
/** Full door slide in 0.8s — matches the authored door_open clip duration. */
const DOOR_ANIM_SPEED = 1.25;
const PLACEHOLDER_FOOTPRINT_INSET = 0.88;
const PLACEHOLDER_MISSING_TINT = new Color("#6a3a56");
const PLACEHOLDER_MISSING_MIX = 0.55;
const PLACEHOLDER_EDGE_COLOR = "#d65cb2";
const DEG2RAD = Math.PI / 180;

const tmpMatrix = new Matrix4();
const tmpHinge = new Matrix4();
const tmpPos = new Vector3();
const tmpQuat = new Quaternion();
const tmpScale = new Vector3();
const tmpBox = new Box3();
const tmpSize = new Vector3();
const tmpCenter = new Vector3();
const tmpColor = new Color();
const scratchLiftColor = new Color();
const Y_AXIS = new Vector3(0, 1, 0);
const X_AXIS = new Vector3(1, 0, 0);
/** Linear-space phosphor boost: keeps the authored strip legible after the desert post pass. */
const TERMINAL_SCREEN_TINT = { r: 0.22, g: 2.6, b: 0.65 } as const;
/** Maximum time a world-prop GLB or animated texture may keep renderer boot waiting. */
export const WORLD_PROP_ASSET_LOAD_TIMEOUT_MS = 15_000;

/**
 * Bounds one renderer asset load without changing the loader's success/error
 * semantics. The timer is cleared on either promise outcome.
 */
export function withWorldPropAssetLoadTimeout<T>(
  load: Promise<T>,
  assetPath: string,
  timeoutMs = WORLD_PROP_ASSET_LOAD_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      clearTimeout(timer);
      reject(new Error(`world props: timed out loading ${assetPath}`));
    }, timeoutMs);
    load.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}


export function animatedScreenFrame(
  elapsedSeconds: number,
  speed: number,
  pulseHz: number,
  phase = 0,
): { offsetY: number; brightness: number } {
  const elapsed = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
  const offsetY = ((elapsed * speed) % 1 + 1) % 1;
  return {
    offsetY,
    brightness: 0.88 + 0.2 * Math.sin(elapsed * Math.PI * 2 * pulseHz + phase),
  };
}

/**
 * Applies a mapping-owned correction to an imported prop before its world
 * bounds are measured. The correction is intentionally part of the asset bake
 * (and cache key), never a per-instance placement transform.
 */
export function applyPropAssetSpaceRotation(
  root: Object3D,
  rotationDegrees: readonly number[] | undefined,
): void {
  if (!rotationDegrees) return;
  const [x = 0, y = 0, z = 0] = rotationDegrees;
  if (![x, y, z].every(Number.isFinite)) {
    throw new Error(`world props: invalid assetRotationDegrees [${rotationDegrees.join(", ")}]`);
  }
  root.rotateX(x * DEG2RAD);
  root.rotateY(y * DEG2RAD);
  root.rotateZ(z * DEG2RAD);
}

export class WorldPropsRenderer {
  private readonly group = new Group();
  private readonly loader = new GLTFLoader();
  private readonly textureLoader = new TextureLoader();
  private readonly glbCache = new Map<string, Promise<LoadedGlb>>();
  private readonly materialCache = new Map<string, Material>();
  private readonly animatedScreens: AnimatedScreenState[] = [];
  private readonly matcap = createMatcapTexture();
  private readonly placeholderGeometry = createPlaceholderGeometry();
  private readonly placeholderMaterial = new MeshMatcapMaterial({ matcap: this.matcap, flatShading: true });
  private readonly placeholderEdgeGeometry = new EdgesGeometry(this.placeholderGeometry);
  private readonly placeholderEdgeMaterial = new LineBasicMaterial({
    color: PLACEHOLDER_EDGE_COLOR,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  private readonly crateLids = new Map<string, CrateLidState>();
  private readonly animatingLids: CrateLidState[] = [];
  private readonly openApplied = new Map<string, boolean>();
  private readonly enterableInstances = new Map<string, EnterableInstanceState>();
  private readonly enterableMeshes: Mesh[] = [];
  private readonly reducedMotion = detectReducedMotion();
  private readonly raycaster = new Raycaster();
  private readonly pickPoint = new Vector2();
  private readonly propPickSlots = new Map<InstancedMesh, ReadonlyArray<WorldPropPickResult | null>>();
  /** Part-meshes hidden while the local player stands inside their prop. */
  private readonly interiorRevealRecs: Array<{ mesh: InstancedMesh; propIds: Set<string> }> = [];
  private revealedPropId: string | null = null;
  /** Animated sliding doors (server doorOpen state), keyed by prop id. */
  private readonly doors = new Map<string, DoorSlideState>();
  private readonly animatingDoors: DoorSlideState[] = [];
  private readonly doorApplied = new Map<string, boolean>();
  private instancedMeshes: InstancedMesh[] = [];
  private readonly placeholderEdges: LineSegments[] = [];
  private areaId: string | null = null;
  private buildToken = 0;
  private stats: WorldPropsStats = emptyStats();

  constructor(private readonly scene: Scene) {
    this.group.name = "world-props";
    this.scene.add(this.group);
  }

  /** Builds instanced prop meshes for the given area. Safe to call again on area change. */
  async load(slice: SliceSnapshot, areaId: string): Promise<void> {
    const token = ++this.buildToken;
    this.areaId = areaId;
    const placements = new Map<string, { entry: MappingEntry; key: string; props: PropSnapshot[] }>();
    let skipped = 0;
    for (const prop of propsForArea(slice, areaId)) {
      if (prop.visible === false) continue;
      const mapping = resolveMappingEntry(prop);
      const { key, entry } = mapping;
      if (entry?.skip) {
        skipped += 1;
        continue;
      }
      const resolved = entry ?? { placeholder: propsMapping.defaultPlaceholder };
      const bucketKey = entry ? key : `unmapped:${key}`;
      let bucket = placements.get(bucketKey);
      if (!bucket) {
        bucket = { entry: resolved, key: bucketKey, props: [] };
        placements.set(bucketKey, bucket);
      }
      bucket.props.push(prop);
    }

    // Resolve every referenced GLB before building (cached across rebuilds).
    // Cache key carries the entry's bake options (nodeTransforms/reveal
    // prefixes) so two entries sharing a file never share a mismatched bake.
    const loads = new Map<string, Promise<LoadedGlb | null>>();
    for (const bucket of placements.values()) {
      if (!bucket.entry.glb) continue;
      const key = glbBakeKey(bucket.entry);
      if (loads.has(key)) continue;
      loads.set(
        key,
        this.loadGlb(bucket.entry).catch((error: unknown) => {
          console.error(`world props: failed to load ${bucket.entry.glb}; using placeholder`, error);
          return null;
        }),
      );
    }
    const loaded = new Map<string, LoadedGlb | null>();
    for (const [key, promise] of loads) loaded.set(key, await promise);
    if (token !== this.buildToken) return;

    this.clearBuilt();
    const stats = emptyStats();
    stats.areaId = areaId;
    stats.skippedPropCount = skipped;
    const needsAuthoring = new Map<string, WorldPropsNeedsAuthoring>();
    const placeholderProps: Array<{ prop: PropSnapshot; spec: PlaceholderSpec; entry: MappingEntry }> = [];

    for (const bucket of placements.values()) {
      const glb = bucket.entry.glb ? loaded.get(glbBakeKey(bucket.entry)) ?? null : null;
      if (bucket.entry.glb && glb) {
        this.buildGlbInstances(glb, bucket.props, bucket.entry, bucket.entry.randomYaw === true);
        stats.glbPropCount += bucket.props.length;
        continue;
      }
      const spec = bucket.entry.placeholder ?? propsMapping.defaultPlaceholder;
      for (const prop of bucket.props) placeholderProps.push({ prop, spec, entry: bucket.entry });
      stats.placeholderPropCount += bucket.props.length;
      const existing = needsAuthoring.get(bucket.key);
      if (existing) existing.count += bucket.props.length;
      else needsAuthoring.set(bucket.key, { key: bucket.key, description: spec.needsAuthoring, count: bucket.props.length });
    }
    if (placeholderProps.length > 0) this.buildPlaceholderInstances(placeholderProps);

    stats.propCount = stats.glbPropCount + stats.placeholderPropCount;
    stats.instancedMeshCount = this.instancedMeshes.length + this.enterableMeshes.length;
    for (const bucket of placements.values()) {
      const glb = bucket.entry.glb ? loaded.get(glbBakeKey(bucket.entry)) ?? null : null;
      stats.naiveDrawCallCount += bucket.props.length * (glb ? glb.parts.length : 1);
    }
    stats.needsAuthoring = [...needsAuthoring.values()].sort((left, right) => right.count - left.count);
    this.stats = stats;
    if (typeof window !== "undefined") {
      window.__successor3dProps = stats;
      window.__successor3dPropsSetVisible = (visible: boolean) => {
        this.group.visible = visible;
      };
    }
  }

  /** Per-frame hook: rebuilds on area change, advances doors, and syncs enterable landmarks. */
  update(slice: SliceSnapshot, state: PlayState, dtSeconds: number): void {
    if (state.activeAreaId !== this.areaId) {
      void this.load(slice, state.activeAreaId).catch((error: unknown) => {
        console.error("world props: area rebuild failed", error);
      });
    }
    this.syncPropOpenStates(state);
    this.syncEnterableReveal(slice, state);
    this.advanceEnterableFades(dtSeconds);
    this.applyInteriorReveal();
    this.advanceLids(dtSeconds);
    this.advanceDoors(dtSeconds);
    this.advanceAnimatedScreens(dtSeconds);
  }

  /**
   * Roof-peel: hides `interiorRevealPrefixes` part-meshes of the prop the
   * local player currently stands inside (null = show everything). Called
   * every frame by the renderer; no-ops until the value changes.
   */
  setInteriorRevealed(propId: string | null): void {
    if (propId === this.revealedPropId) return;
    this.revealedPropId = propId;
    this.applyInteriorReveal();
  }

  private applyInteriorReveal(): void {
    for (const rec of this.interiorRevealRecs) {
      rec.mesh.visible = !(this.revealedPropId !== null && rec.propIds.has(this.revealedPropId));
    }
  }

  /** Opens the lid of a loot crate prop (marker-node driven). Returns false if the prop has no lid. */
  openCrate(propId: string): boolean {
    return this.setPropOpen(propId, true);
  }

  closeCrate(propId: string): boolean {
    return this.setPropOpen(propId, false);
  }

  setPropOpen(propId: string, open: boolean): boolean {
    this.openApplied.set(propId, open);
    return this.setLidTarget(propId, open ? 1 : 0);
  }

  pickAtScreenPoint(camera: Camera, screenX: number, screenY: number, viewportWidth: number, viewportHeight: number): WorldPropPickResult | null {
    if (viewportWidth <= 0 || viewportHeight <= 0 || this.instancedMeshes.length === 0) return null;
    this.pickPoint.set(screenX / viewportWidth * 2 - 1, -(screenY / viewportHeight) * 2 + 1);
    this.raycaster.setFromCamera(this.pickPoint, camera);
    const hits = this.raycaster.intersectObjects(this.instancedMeshes, false);
    for (const hit of hits) {
      if (!(hit.object instanceof InstancedMesh) || hit.instanceId === undefined) continue;
      const pick = this.propPickSlots.get(hit.object)?.[hit.instanceId] ?? null;
      if (pick?.interactable) return { ...pick };
    }
    return null;
  }

  getStats(): WorldPropsStats {
    return this.stats;
  }

  /** Live authored-screen state for browser journeys and renderer QA. */
  debugAnimatedScreen(node: string): WorldPropAnimatedScreenDebug | null {
    const screen = this.animatedScreens.find((candidate) => (
      candidate.node === node && candidate.activeInstanceCount > 0
    ));
    if (!screen) return null;
    return {
      node: screen.node,
      exactNodeMatches: screen.exactNodeMatches,
      descendantMeshMatches: screen.descendantMeshMatches,
      activeInstanceCount: screen.activeInstanceCount,
      elapsedSeconds: screen.elapsedSeconds,
      offsetY: screen.texture.offset.y,
      brightness: screen.brightness,
    };
  }

  dispose(): void {
    this.clearBuilt();
    this.scene.remove(this.group);
    for (const material of this.materialCache.values()) material.dispose();
    this.materialCache.clear();
    this.placeholderMaterial.dispose();
    this.placeholderGeometry.dispose();
    this.placeholderEdgeMaterial.dispose();
    this.placeholderEdgeGeometry.dispose();
    this.matcap.dispose();
    this.glbCache.clear();
    for (const screen of this.animatedScreens) {
      screen.material.dispose();
      screen.texture.dispose();
    }
    this.animatedScreens.length = 0;
  }

  /** Sliding-door open state (server-authoritative mirror drives this). */
  setDoorOpen(propId: string, open: boolean): boolean {
    const state = this.doors.get(propId);
    if (!state) return false;
    state.target = open ? 1 : 0;
    if (!this.animatingDoors.includes(state)) this.animatingDoors.push(state);
    return true;
  }

  private setLidTarget(propId: string, target: number): boolean {
    const state = this.crateLids.get(propId);
    if (!state) return false;
    state.target = target;
    if (!this.animatingLids.includes(state)) this.animatingLids.push(state);
    return true;
  }

  private advanceDoors(dtSeconds: number): void {
    for (let i = this.animatingDoors.length - 1; i >= 0; i -= 1) {
      const state = this.animatingDoors[i];
      if (!state) continue;
      const step = DOOR_ANIM_SPEED * dtSeconds;
      state.t = state.t < state.target
        ? Math.min(state.target, state.t + step)
        : Math.max(state.target, state.t - step);
      const eased = state.t * state.t * (3 - 2 * state.t);
      // Node-local translation along the authored slide axis (the door_open
      // clip path), composed exactly like the lid hinge: pre/post node frames.
      tmpHinge.makeTranslation(
        state.axis.x * state.distance * eased,
        state.axis.y * state.distance * eased,
        state.axis.z * state.distance * eased,
      );
      for (const ref of state.refs) {
        const preHinge = ref.part.preHinge;
        const postHinge = ref.part.postHinge;
        if (!preHinge || !postHinge) continue;
        tmpMatrix.copy(state.placement).multiply(preHinge).multiply(tmpHinge).multiply(postHinge);
        applyRenderMeshMatrix(ref.mesh, ref.index, tmpMatrix);
      }
      if (state.t === state.target) this.animatingDoors.splice(i, 1);
    }
  }

  private advanceLids(dtSeconds: number): void {
    for (let i = this.animatingLids.length - 1; i >= 0; i -= 1) {
      const state = this.animatingLids[i];
      if (!state) continue;
      const step = LID_ANIM_SPEED * dtSeconds;
      state.t = state.t < state.target
        ? Math.min(state.target, state.t + step)
        : Math.max(state.target, state.t - step);
      const eased = state.t * state.t * (3 - 2 * state.t);
      // Negative X rotation lifts the lid's +Z front edge up around the rear hinge.
      tmpHinge.makeRotationAxis(X_AXIS, -LID_OPEN_ANGLE * eased);
      for (const ref of state.refs) {
        const preHinge = ref.part.preHinge;
        const postHinge = ref.part.postHinge;
        if (!preHinge || !postHinge) continue;
        tmpMatrix.copy(state.placement).multiply(preHinge).multiply(tmpHinge).multiply(postHinge);
        applyRenderMeshMatrix(ref.mesh, ref.index, tmpMatrix);
      }
      if (state.t === state.target) this.animatingLids.splice(i, 1);
    }
  }

  private advanceAnimatedScreens(dtSeconds: number): void {
    const step = Number.isFinite(dtSeconds) ? Math.max(0, Math.min(dtSeconds, 0.1)) : 0;
    for (const screen of this.animatedScreens) {
      screen.elapsedSeconds += step;
      const frame = animatedScreenFrame(screen.elapsedSeconds, screen.speed, screen.pulseHz, screen.phase);
      screen.texture.offset.y = frame.offsetY;
      screen.brightness = frame.brightness;
      screen.material.color.setRGB(
        frame.brightness * TERMINAL_SCREEN_TINT.r,
        frame.brightness * TERMINAL_SCREEN_TINT.g,
        frame.brightness * TERMINAL_SCREEN_TINT.b,
      );
    }
  }

  private syncEnterableReveal(slice: SliceSnapshot, state: PlayState): void {
    const playerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const authorityPlayer = playerActorId ? state.serverAuthority.actors[playerActorId] : null;
    // Rendered/physical ground center is the authority anchor +0.5/+0.5 cells.
    const x = (authorityPlayer?.x ?? state.player.x) + 0.5;
    const z = (authorityPlayer?.y ?? state.player.y) + 0.5;
    const tick = state.serverAuthority.snapshotTick;
    for (const instance of this.enterableInstances.values()) {
      sampleCutaway(
        instance.cutaway,
        tick,
        instance.regions,
        (x - instance.cellX) * 1000,
        (z - instance.cellZ) * 1000,
      );
    }
    void slice;
  }

  private advanceEnterableFades(dtSeconds: number): void {
    for (const instance of this.enterableInstances.values()) {
      const hidden = advanceCutawayFade(instance.cutaway, dtSeconds, instance.fadeSeconds, this.reducedMotion);
      if (hidden === instance.appliedHidden) continue;
      instance.appliedHidden = hidden;
      for (const rec of instance.revealMeshes) applyRevealFade(rec, hidden);
    }
  }

  /** Focused renderer proof seam: current reveal amount per instance. */
  debugEnterableFade(propId: string): number | null {
    return this.enterableInstances.get(propId)?.cutaway.t ?? null;
  }

  /**
   * On-demand bounded cutaway diagnostics per enterable instance: authored
   * placement, explicit interior bounds, machine state, door membership, and
   * actual world Box3 bounds grouped floor/reveal/keep/door. Never called per
   * frame — Box3 traversal happens only when a probe asks.
   */
  debugEnterableCutaway(): WorldPropEnterableCutawayDebug[] {
    const out: WorldPropEnterableCutawayDebug[] = [];
    for (const instance of this.enterableInstances.values()) {
      const door = this.doors.get(instance.propId) ?? null;
      const revealSet = new Set(instance.revealMeshes.map((rec) => rec.mesh));
      out.push({
        propId: instance.propId,
        areaId: instance.areaId,
        cell: { x: instance.cellX, y: instance.cellZ },
        size: { w: instance.sizeW, h: instance.sizeH },
        rotation: instance.rotation,
        floorSurfaceY: instance.floorHeightM,
        explicitInteriorBounds: instance.explicitBounds,
        interiorBounds: instance.regions.map((region) => ({ ...region })),
        phase: cutawayPhase(instance.cutaway),
        dwell: instance.cutaway.dwell,
        target: instance.cutaway.inside ? 1 : 0,
        fade: instance.cutaway.t,
        doorOpen: door === null ? null : this.doorApplied.get(instance.propId) ?? door.target >= 0.5,
        doorSlideT: door?.t ?? null,
        doorInRevealSet: instance.doorMeshes.some((mesh) => revealSet.has(mesh)),
        meshCounts: {
          floor: instance.floorMeshes.length,
          reveal: instance.revealMeshes.length,
          keep: instance.keepMeshes.length,
          door: instance.doorMeshes.length,
        },
        worldBounds: {
          floor: unionWorldBounds(instance.floorMeshes),
          reveal: unionWorldBounds(instance.revealMeshes.map((rec) => rec.mesh)),
          keep: unionWorldBounds(instance.keepMeshes),
          door: unionWorldBounds(instance.doorMeshes),
        },
      });
    }
    return out;
  }

  private syncPropOpenStates(state: PlayState): void {
    const propStates = state.serverAuthority.propStates ?? {};
    for (const propId of this.crateLids.keys()) {
      const open = propStates[propId]?.cacheEmptied === true;
      if (this.openApplied.get(propId) === open) continue;
      this.setPropOpen(propId, open);
    }
    for (const propId of this.doors.keys()) {
      const open = propStates[propId]?.doorOpen === true;
      if (this.doorApplied.get(propId) === open) continue;
      this.doorApplied.set(propId, open);
      this.setDoorOpen(propId, open);
    }
  }

  private addPropMesh(mesh: InstancedMesh, picks: ReadonlyArray<WorldPropPickResult | null>): void {
    mesh.frustumCulled = false;
    markSunShadowCaster(mesh);
    this.propPickSlots.set(mesh, picks);
    this.instancedMeshes.push(mesh);
    this.group.add(mesh);
  }

  private buildGlbInstances(glb: LoadedGlb, props: PropSnapshot[], entry: MappingEntry, randomYaw: boolean): void {
    if (entry.enterable) {
      this.buildEnterableInstances(glb, props, entry);
      return;
    }
    if (glb.animatedScreen) glb.animatedScreen.activeInstanceCount += props.length;
    const meshes: InstancedMesh[] = [];
    const picks = props.map((prop) => propPickResult(prop, entry));
    for (const part of glb.parts) {
      const mesh = new InstancedMesh(part.geometry, part.material, props.length);
      this.addPropMesh(mesh, picks);
      meshes.push(mesh);
      if (part.interiorReveal) {
        this.interiorRevealRecs.push({ mesh, propIds: new Set(props.map((prop) => prop.id)) });
      }
    }
    for (let i = 0; i < props.length; i += 1) {
      const prop = props[i];
      if (!prop) continue;
      const placement = composePlacement(prop, randomYaw, glb.footprintX, glb.footprintZ, tmpMatrix);
      let lidRefs: LidInstanceRef[] | null = null;
      let doorRefs: LidInstanceRef[] | null = null;
      for (let p = 0; p < glb.parts.length; p += 1) {
        const part = glb.parts[p];
        const mesh = meshes[p];
        if (!part || !mesh) continue;
        tmpHinge.copy(placement).multiply(part.localMatrix);
        mesh.setMatrixAt(i, tmpHinge);
        mesh.setColorAt(i, tmpColor.setRGB(1, 1, 1));
        if (part.role === "lid") {
          lidRefs ??= [];
          lidRefs.push({ part, mesh, index: i });
        } else if (part.role === "door") {
          doorRefs ??= [];
          doorRefs.push({ part, mesh, index: i });
        }
      }
      if (lidRefs) {
        this.crateLids.set(prop.id, {
          placement: placement.clone(),
          refs: lidRefs,
          t: 0,
          target: 0,
        });
      }
      if (doorRefs && entry.slideDoor) {
        const axis = new Vector3(
          entry.slideDoor.axisLocal[0] ?? 0,
          entry.slideDoor.axisLocal[1] ?? 0,
          entry.slideDoor.axisLocal[2] ?? 0,
        );
        if (axis.lengthSq() > 0) axis.normalize();
        this.doors.set(prop.id, {
          placement: placement.clone(),
          refs: doorRefs,
          axis,
          distance: Math.max(0, entry.slideDoor.distance),
          t: 0,
          target: 0,
        });
      }
    }
  }

  private buildEnterableInstances(glb: LoadedGlb, props: PropSnapshot[], entry: MappingEntry): void {
    if (!entry.enterable) return;
    if (glb.animatedScreen) glb.animatedScreen.activeInstanceCount += props.length;
    for (const prop of props) {
      const placement = composePlacement(prop, false, glb.footprintX, glb.footprintZ, tmpMatrix).clone();
      const revealMeshes: RevealFadeMesh[] = [];
      const floorMeshes: Mesh[] = [];
      const keepMeshes: Mesh[] = [];
      const doorMeshes: Mesh[] = [];
      const doorRefs: LidInstanceRef[] = [];
      for (const part of glb.parts) {
        const reveal = part.enterableClass === "reveal";
        let mesh: Mesh;
        if (reveal) {
          const fade = cloneFadeMaterials(part.material);
          mesh = new Mesh(part.geometry, fade.applied);
          revealMeshes.push({ mesh, materials: fade.states });
        } else {
          mesh = new Mesh(part.geometry, part.material);
        }
        mesh.frustumCulled = false;
        mesh.matrixAutoUpdate = false;
        tmpHinge.copy(placement).multiply(part.localMatrix);
        mesh.matrix.copy(tmpHinge);
        mesh.matrixWorldNeedsUpdate = true;
        markSunShadowCaster(mesh);
        this.group.add(mesh);
        this.enterableMeshes.push(mesh);
        if (part.enterableClass === "floor") floorMeshes.push(mesh);
        else if (part.enterableClass === "door") doorMeshes.push(mesh);
        else if (!reveal) keepMeshes.push(mesh);
        if (part.role === "door") doorRefs.push({ part, mesh, index: 0 });
      }
      const explicitBounds = prop.enterable?.interiorBounds ?? null;
      const regions: CutawayRegionMilli[] = explicitBounds && explicitBounds.length > 0
        ? explicitBounds.map((bounds) => ({
            id: bounds.id,
            xMilli: bounds.xMilli,
            yMilli: bounds.yMilli,
            wMilli: bounds.wMilli,
            hMilli: bounds.hMilli,
          }))
        : [{ xMilli: 0, yMilli: 0, wMilli: prop.size.w * 1000, hMilli: prop.size.h * 1000 }];
      this.enterableInstances.set(prop.id, {
        propId: prop.id,
        areaId: prop.areaId,
        cellX: prop.cell.x,
        cellZ: prop.cell.y,
        sizeW: prop.size.w,
        sizeH: prop.size.h,
        floorHeightM: prop.enterable?.floorHeightM ?? entry.enterable.floorHeightM ?? 0,
        rotation: prop.rotation ?? 0,
        fadeSeconds: Math.max(0.01, entry.enterable.fadeSeconds ?? 0.25),
        regions,
        explicitBounds: explicitBounds !== null && explicitBounds.length > 0,
        revealMeshes,
        floorMeshes,
        keepMeshes,
        doorMeshes,
        cutaway: createCutawayState(),
        appliedHidden: 0,
      });
      if (doorRefs.length > 0 && entry.slideDoor) {
        const axis = new Vector3(
          entry.slideDoor.axisLocal[0] ?? 0,
          entry.slideDoor.axisLocal[1] ?? 0,
          entry.slideDoor.axisLocal[2] ?? 0,
        );
        if (axis.lengthSq() > 0) axis.normalize();
        this.doors.set(prop.id, {
          placement,
          refs: doorRefs,
          axis,
          distance: Math.max(0, entry.slideDoor.distance),
          t: 0,
          target: 0,
        });
      }
    }
  }

  private buildPlaceholderInstances(placeholders: Array<{ prop: PropSnapshot; spec: PlaceholderSpec; entry: MappingEntry }>): void {
    const mesh = new InstancedMesh(this.placeholderGeometry, this.placeholderMaterial, placeholders.length);
    const picks = placeholders.map((entry) => propPickResult(entry.prop, entry.entry));
    this.addPropMesh(mesh, picks);
    for (let i = 0; i < placeholders.length; i += 1) {
      const entry = placeholders[i];
      if (!entry) continue;
      const { prop, spec } = entry;
      const rotation = prop.rotation ?? 0;
      const yaw = rotation !== 0
        ? -rotation * DEG2RAD
        : spec.randomYaw === true
          ? hashYaw(prop.id)
          : 0;
      const swap = rotation === 90 || rotation === 270;
      const targetW = swap ? prop.size.h : prop.size.w;
      const targetD = swap ? prop.size.w : prop.size.h;
      tmpPos.set(prop.cell.x + prop.size.w / 2, 0, prop.cell.y + prop.size.h / 2);
      tmpQuat.setFromAxisAngle(Y_AXIS, yaw);
      tmpScale.set(targetW * PLACEHOLDER_FOOTPRINT_INSET, spec.height, targetD * PLACEHOLDER_FOOTPRINT_INSET);
      tmpMatrix.compose(tmpPos, tmpQuat, tmpScale);
      mesh.setMatrixAt(i, tmpMatrix);
      tmpColor.set(spec.tint).lerp(PLACEHOLDER_MISSING_TINT, PLACEHOLDER_MISSING_MIX);
      mesh.setColorAt(i, tmpColor);
      const edges = new LineSegments(this.placeholderEdgeGeometry, this.placeholderEdgeMaterial);
      edges.frustumCulled = false;
      edges.position.copy(tmpPos);
      edges.quaternion.copy(tmpQuat);
      edges.scale.copy(tmpScale);
      this.placeholderEdges.push(edges);
      this.group.add(edges);
    }
  }

  private clearBuilt(): void {
    for (const mesh of this.instancedMeshes) {
      this.group.remove(mesh);
      mesh.dispose();
    }
    for (const instance of this.enterableInstances.values()) {
      for (const rec of instance.revealMeshes) {
        for (const state of rec.materials) state.material.dispose();
      }
    }
    for (const mesh of this.enterableMeshes) this.group.remove(mesh);
    this.enterableMeshes.length = 0;
    this.enterableInstances.clear();
    for (const edges of this.placeholderEdges) this.group.remove(edges);
    this.placeholderEdges.length = 0;
    this.instancedMeshes = [];
    this.crateLids.clear();
    this.animatingLids.length = 0;
    this.openApplied.clear();
    this.propPickSlots.clear();
    this.interiorRevealRecs.length = 0;
    this.doors.clear();
    this.animatingDoors.length = 0;
    this.doorApplied.clear();
    for (const screen of this.animatedScreens) screen.activeInstanceCount = 0;
  }

  private loadGlb(entry: MappingEntry): Promise<LoadedGlb> {
    const key = glbBakeKey(entry);
    const existing = this.glbCache.get(key);
    if (existing) return existing;
    const glbPath = resolveMappedPublicAssetPath(entry.glb);
    const screenTexturePath = entry.animatedScreen
      ? resolveMappedPublicAssetPath(entry.animatedScreen.texture)
      : null;
    const screenTexture = screenTexturePath
      ? withWorldPropAssetLoadTimeout(this.textureLoader.loadAsync(screenTexturePath), screenTexturePath)
      : Promise.resolve(null);
    const promise = Promise.all([
      withWorldPropAssetLoadTimeout(this.loader.loadAsync(glbPath), glbPath),
      screenTexture,
    ]).then(([gltf, texture]) => this.bakeGlb(gltf.scene, entry, texture));
    this.glbCache.set(key, promise);
    return promise;
  }

  private bakeGlb(root: Object3D, entry?: MappingEntry, animatedScreenTexture: Texture | null = null): LoadedGlb {
    // Normalize asset-authored axes before any bounds, footprint, socket, or
    // animated-part matrices are captured. The Grok terminal source is Z-up;
    // -90 X maps authored +Z height -> runtime +Y and authored -Y front -> +Z.
    applyPropAssetSpaceRotation(root, entry?.assetRotationDegrees);
    // Bake-time node pose edits (e.g. park the shelter house door OPEN at
    // the door_open clip end state) BEFORE world matrices are read.
    if (entry?.nodeTransforms) {
      for (const transform of entry.nodeTransforms) {
        const node = root.getObjectByName(transform.node);
        if (!node) {
          console.warn(`world props: nodeTransforms target "${transform.node}" not found in ${entry.glb}`);
          continue;
        }
        if (transform.translate) {
          node.position.x += transform.translate[0] ?? 0;
          node.position.y += transform.translate[1] ?? 0;
          node.position.z += transform.translate[2] ?? 0;
        }
      }
    }
    root.updateMatrixWorld(true);
    tmpBox.setFromObject(root);
    tmpBox.getSize(tmpSize);
    tmpBox.getCenter(tmpCenter);
    // Recenter footprint on origin; keep authored ground plane (origin is ground_center).
    const recenter = new Matrix4().makeTranslation(-tmpCenter.x, 0, -tmpCenter.z);
    const parts: GlbPart[] = [];
    let hasLid = false;
    const revealPrefixes = entry?.enterable?.revealPrefixes
      ?? entry?.interiorRevealPrefixes
      ?? null;
    const doorNode = entry?.slideDoor ? root.getObjectByName(entry.slideDoor.node) ?? null : null;
    if (entry?.slideDoor && !doorNode) {
      console.warn(`world props: slideDoor node "${entry.slideDoor.node}" not found in ${entry.glb}`);
    }
    const screenNodeMatches: Object3D[] = [];
    if (entry?.animatedScreen) {
      root.traverse((object) => {
        if (object.name === entry.animatedScreen?.node) screenNodeMatches.push(object);
      });
    }
    const screenNode = screenNodeMatches[0] ?? null;
    let descendantScreenMeshMatches = 0;
    if (screenNode) {
      root.traverse((object) => {
        if (object instanceof Mesh && isDescendantOf(object, screenNode)) descendantScreenMeshMatches += 1;
      });
    }
    if (entry?.animatedScreen && (
      screenNodeMatches.length !== 1
      || descendantScreenMeshMatches < 1
      || !animatedScreenTexture
    )) {
      animatedScreenTexture?.dispose();
      throw new Error(
        `world props: animated screen "${entry.animatedScreen.node}" in ${entry.glb} requires exactly one node, at least one mesh, and a texture`
          + ` (nodes=${screenNodeMatches.length}, meshes=${descendantScreenMeshMatches}, texture=${animatedScreenTexture ? "yes" : "no"})`,
      );
    }
    const animatedScreen = entry?.animatedScreen && animatedScreenTexture
      ? this.createAnimatedScreenState(
          animatedScreenTexture,
          entry.animatedScreen,
          screenNodeMatches.length,
          descendantScreenMeshMatches,
        )
      : null;
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      let role = partRole(object);
      const material = screenNode && animatedScreenTexture && entry?.animatedScreen && isDescendantOf(object, screenNode)
        ? animatedScreen?.material ?? this.convertMaterial(object.material)
        : this.convertMaterial(object.material);
      const localMatrix = new Matrix4().copy(recenter).multiply(object.matrixWorld);
      let preHinge: Matrix4 | null = null;
      let postHinge: Matrix4 | null = null;
      if (role === "lid") {
        hasLid = true;
        const lidNode = lidAncestor(object);
        if (lidNode) {
          preHinge = new Matrix4().copy(recenter).multiply(lidNode.matrixWorld);
          postHinge = new Matrix4().copy(lidNode.matrixWorld).invert().multiply(object.matrixWorld);
        }
      } else if (doorNode && isDescendantOf(object, doorNode)) {
        // Sliding-door part: same pre/post node-frame composition as lids,
        // but the per-frame transform is a translation along the slide axis.
        role = "door";
        preHinge = new Matrix4().copy(recenter).multiply(doorNode.matrixWorld);
        postHinge = new Matrix4().copy(doorNode.matrixWorld).invert().multiply(object.matrixWorld);
      }
      const enterableClass = classifyEnterablePart(object, role, revealPrefixes);
      const interiorReveal = enterableClass === "reveal";
      parts.push({ geometry: object.geometry as BufferGeometry, material, localMatrix, role, preHinge, postHinge, interiorReveal, enterableClass });
    });
    return {
      parts,
      footprintX: Math.max(0.001, tmpSize.x),
      footprintZ: Math.max(0.001, tmpSize.z),
      hasLid,
      animatedScreen,
      enterable: entry?.enterable ?? null,
    };
  }

  private createAnimatedScreenState(
    texture: Texture,
    spec: NonNullable<MappingEntry["animatedScreen"]>,
    exactNodeMatches: number,
    descendantMeshMatches: number,
  ): AnimatedScreenState {
    texture.colorSpace = SRGBColorSpace;
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.repeat.set(1, spec.repeatY);
    texture.generateMipmaps = true;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    const material = new MeshBasicMaterial({
      map: texture,
      color: new Color().setRGB(
        0.88 * TERMINAL_SCREEN_TINT.r,
        0.88 * TERMINAL_SCREEN_TINT.g,
        0.88 * TERMINAL_SCREEN_TINT.b,
      ),
      toneMapped: false,
      fog: false,
    });
    material.name = "TravelTerminalScreen:animated";
    const state: AnimatedScreenState = {
      material,
      texture,
      node: spec.node,
      exactNodeMatches,
      descendantMeshMatches,
      activeInstanceCount: 0,
      elapsedSeconds: 0,
      brightness: 0.88,
      speed: spec.speed,
      pulseHz: spec.pulseHz,
      phase: this.animatedScreens.length * 1.1,
    };
    this.animatedScreens.push(state);
    return state;
  }

  private convertMaterial(source: Mesh["material"]): Material {
    const single = Array.isArray(source) ? source[0] ?? null : source ?? null;
    const color = materialColor(single, "color");
    const map = materialTexture(single, "map");
    const emissive = materialColor(single, "emissive");
    const emissiveMap = materialTexture(single, "emissiveMap");
    const hasEmissive = Boolean(emissive && emissive.getHex() !== 0) || Boolean(emissiveMap);
    if (map || hasEmissive) {
      const texture = map ?? emissiveMap ?? null;
      if (texture) texture.colorSpace = SRGBColorSpace;
      const displayColor = texture ? scratchLiftColor.set(0xffffff) : tmpColor.copy(emissive ?? color ?? scratchLiftColor.set("#ffda93"));
      const opacity = materialOpacity(single);
      const transparent = materialTransparent(single) || opacity < 1;
      const alphaTest = materialAlphaTest(single);
      const side = materialSide(single);
      const key = [
        "basic",
        texture?.uuid ?? "none",
        displayColor.getHexString(),
        opacity.toFixed(3),
        alphaTest.toFixed(3),
        transparent ? "t" : "o",
        side,
      ].join("|");
      const cached = this.materialCache.get(key);
      if (cached) return cached;
      const material = new MeshBasicMaterial({
        map: texture,
        color: displayColor.clone(),
        transparent,
        opacity,
        alphaTest,
        side,
        fog: true,
      });
      material.name = single?.name ? `${single.name}:successor-basic` : "successor-basic-prop";
      material.userData.successorEmissive = emissive ? `#${emissive.getHexString()}` : null;
      material.userData.successorEmissiveMap = emissiveMap?.uuid ?? null;
      this.materialCache.set(key, material);
      return material;
    }
    // Solid-color path: transparency MUST propagate — authored glazing
    // (e.g. commerce CM_TealGlass, alphaMode BLEND, no maps) otherwise
    // renders as an opaque matcap slab (commerce interior audit 2026-07-18).
    const opacity = materialOpacity(single);
    const transparent = materialTransparent(single) || opacity < 1;
    const key = `${color ? `#${color.getHexString()}` : "#8f9296"}|${opacity.toFixed(3)}|${transparent ? "t" : "o"}`;
    const cached = this.materialCache.get(key);
    if (cached) return cached;
    // Luminance floor: several world-item GLBs are authored charcoal-dark and
    // read as void-black slabs on the bright desert under the PS2 grade. Lift
    // very dark bodies toward a readable dark gray; leave lighter ones alone.
    tmpColor.set(color ? `#${color.getHexString()}` : "#8f9296");
    const luminance = tmpColor.r * 0.2126 + tmpColor.g * 0.7152 + tmpColor.b * 0.0722;
    if (luminance < 0.16) tmpColor.lerp(scratchLiftColor.set("#6c7076"), (0.16 - luminance) / 0.16 * 0.7);
    const material = new MeshMatcapMaterial({
      matcap: this.matcap,
      color: tmpColor.clone(),
      flatShading: true,
      transparent,
      opacity,
      // Transparent glazing must not occlude depth-sorted content behind it.
      depthWrite: !transparent,
    });
    this.materialCache.set(key, material);
    return material;
  }
}

function composePlacement(
  prop: PropSnapshot,
  randomYaw: boolean,
  footprintX: number,
  footprintZ: number,
  out: Matrix4,
): Matrix4 {
  const rotation = prop.rotation ?? 0;
  const swap = rotation === 90 || rotation === 270;
  const targetW = swap ? prop.size.h : prop.size.w;
  const targetD = swap ? prop.size.w : prop.size.h;
  const useRandomYaw = randomYaw && rotation === 0;
  const yaw = rotation !== 0 ? -rotation * DEG2RAD : useRandomYaw ? hashYaw(prop.id) : 0;
  const fitW = useRandomYaw ? Math.min(targetW, targetD) : targetW;
  const fitD = useRandomYaw ? Math.min(targetW, targetD) : targetD;
  const scale = Math.min(fitW / footprintX, fitD / footprintZ);
  tmpPos.set(prop.cell.x + prop.size.w / 2, 0, prop.cell.y + prop.size.h / 2);
  tmpQuat.setFromAxisAngle(Y_AXIS, yaw);
  tmpScale.set(scale, scale, scale);
  return out.compose(tmpPos, tmpQuat, tmpScale);
}

export function enterableFloorYAt(
  props: readonly PropSnapshot[],
  areaId: string,
  x: number,
  z: number,
): number {
  for (const prop of props) {
    if (prop.areaId !== areaId || prop.visible === false || !prop.enterable) continue;
    if (enterablePropContains(prop, x, z)) return prop.enterable.floorHeightM;
  }
  return 0;
}

/**
 * True when world point (x, z) is inside this enterable prop's interior.
 * Explicit interiorBounds are POST-ROTATION prop-local milli AABBs — the
 * transform is (world - cell) * 1000 with no second yaw. Legacy enterables
 * without bounds fall back to the footprint via the inverse cardinal
 * rotation; 90/270 swap the local rectangle to (h, w).
 */
export function enterablePropContains(prop: PropSnapshot, x: number, z: number): boolean {
  const enterable = prop.enterable;
  if (!enterable) return false;
  const bounds = enterable.interiorBounds;
  if (bounds && bounds.length > 0) {
    const lx = (x - prop.cell.x) * 1000;
    const lz = (z - prop.cell.y) * 1000;
    for (const region of bounds) {
      if (
        lx >= region.xMilli && lx <= region.xMilli + region.wMilli
        && lz >= region.yMilli && lz <= region.yMilli + region.hMilli
      ) return true;
    }
    return false;
  }
  const rotation = prop.rotation ?? 0;
  const w = prop.size.w;
  const h = prop.size.h;
  const dx = x - (prop.cell.x + w / 2);
  const dz = z - (prop.cell.y + h / 2);
  let lx: number;
  let lz: number;
  let lw: number;
  let lh: number;
  if (rotation === 90) {
    lx = dz + h / 2; lz = -dx + w / 2; lw = h; lh = w;
  } else if (rotation === 180) {
    lx = -dx + w / 2; lz = -dz + h / 2; lw = w; lh = h;
  } else if (rotation === 270) {
    lx = -dz + h / 2; lz = dx + w / 2; lw = h; lh = w;
  } else {
    lx = dx + w / 2; lz = dz + h / 2; lw = w; lh = h;
  }
  return lx >= 0 && lx <= lw && lz >= 0 && lz <= lh;
}

function resolveMappedPublicAssetPath(assetRef: string | undefined): string {
  if (!assetRef) throw new Error("world props: mapping entry is missing a glb/texture path");
  if (assetRef.startsWith("/")) return requireRuntimePublicPath(assetRef);
  return requireRuntimePublicPath(`${propsMapping.assetBase}${assetRef}`);
}

function resolveMappingEntry(prop: PropSnapshot): { key: string; entry: MappingEntry | null } {
  const assetEntry = prop.assetKey ? propsMapping.entries[prop.assetKey] ?? null : null;
  if (assetEntry) return { key: prop.assetKey!, entry: assetEntry };
  return { key: prop.kind, entry: propsMapping.entries[prop.kind] ?? null };
}

function propPickResult(prop: PropSnapshot, entry: MappingEntry): WorldPropPickResult | null {
  if (entry.interactable !== true || prop.interactive !== true) return null;
  return {
    propId: prop.id,
    kind: prop.kind,
    label: prop.label || defaultInteractableLabel(prop.kind),
    interactable: true,
  };
}

function defaultInteractableLabel(kind: string): string {
  if (kind === "travel_terminal") return "Travel Terminal";
  if (kind === "storage_chest") return "Supply Cache";
  return "Interactable";
}


function materialField(material: Material | null, key: string): unknown {
  if (!material || !(key in material)) return null;
  return Reflect.get(material, key);
}

function materialColor(material: Material | null, key: "color" | "emissive"): Color | null {
  const value = materialField(material, key);
  return value instanceof Color ? value : null;
}

function materialTexture(material: Material | null, key: "map" | "emissiveMap"): Texture | null {
  const value = materialField(material, key);
  return value instanceof Texture ? value : null;
}

function materialOpacity(material: Material | null): number {
  const value = material?.opacity;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
}

function materialTransparent(material: Material | null): boolean {
  return material?.transparent === true;
}

function materialAlphaTest(material: Material | null): number {
  const value = material?.alphaTest;
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function materialSide(material: Material | null): Material["side"] {
  return material?.side ?? 0;
}

function partRole(object: Object3D): GlbPartRole {
  for (let node: Object3D | null = object; node; node = node.parent) {
    if (node.name.includes(LID_MARKER)) return "lid";
    if (node.name.includes(LOCK_MARKER)) return "lock";
  }
  return "body";
}
/** Composite GLB bake-cache key: file + the entry options that alter the bake. */
function glbBakeKey(entry: MappingEntry): string {
  const assetRotation = entry.assetRotationDegrees ? entry.assetRotationDegrees.join(",") : "";
  const transforms = entry.nodeTransforms ? JSON.stringify(entry.nodeTransforms) : "";
  const reveal = entry.interiorRevealPrefixes ? entry.interiorRevealPrefixes.join(",") : "";
  const enterable = entry.enterable ? JSON.stringify(entry.enterable) : "";
  const door = entry.slideDoor ? JSON.stringify(entry.slideDoor) : "";
  const screen = entry.animatedScreen ? JSON.stringify(entry.animatedScreen) : "";
  return `${entry.glb ?? ""}|${assetRotation}|${transforms}|${reveal}|${enterable}|${door}|${screen}`;
}

/** True when `object` is `node` or nested anywhere under it. */
function isDescendantOf(object: Object3D, node: Object3D): boolean {
  for (let current: Object3D | null = object; current; current = current.parent) {
    if (current === node) return true;
  }
  return false;
}

/** True when the mesh or any ancestor node name starts with a reveal prefix. */
function hasRevealPrefix(object: Object3D, prefixes: readonly string[]): boolean {
  for (let node: Object3D | null = object; node; node = node.parent) {
    for (const prefix of prefixes) {
      if (node.name.startsWith(prefix)) return true;
    }
  }
  return false;
}

function lidAncestor(object: Object3D): Object3D | null {
  for (let node: Object3D | null = object; node; node = node.parent) {
    if (node.name.includes(LID_MARKER)) return node;
  }
  return null;
}

function hashYaw(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 3600) * (Math.PI / 1800);
}
function applyRenderMeshMatrix(mesh: RenderMesh, index: number, matrix: Matrix4): void {
  if (mesh instanceof InstancedMesh) {
    mesh.setMatrixAt(index, matrix);
    mesh.instanceMatrix.needsUpdate = true;
  } else {
    mesh.matrix.copy(matrix);
    mesh.matrixWorldNeedsUpdate = true;
  }
}

function cloneFadeMaterials(source: Material | Material[]): { applied: Material | Material[]; states: FadeMaterialState[] } {
  const applied = Array.isArray(source) ? source.map((material) => material.clone()) : source.clone();
  const list = Array.isArray(applied) ? applied : [applied];
  const states = list.map((material) => ({
    material,
    opacity: material.opacity,
    transparent: material.transparent,
    depthWrite: material.depthWrite,
  }));
  return { applied, states };
}

/** On-demand diagnostics only: unions actual world Box3 bounds for a mesh group. */
function unionWorldBounds(meshes: readonly Mesh[]): WorldBox3Debug | null {
  if (meshes.length === 0) return null;
  const union = new Box3();
  const box = new Box3();
  let any = false;
  for (const mesh of meshes) {
    mesh.updateWorldMatrix(true, false);
    box.setFromObject(mesh);
    if (box.isEmpty()) continue;
    if (any) union.union(box);
    else {
      union.copy(box);
      any = true;
    }
  }
  if (!any) return null;
  return {
    min: { x: union.min.x, y: union.min.y, z: union.min.z },
    max: { x: union.max.x, y: union.max.y, z: union.max.z },
  };
}

function detectReducedMotion(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}


function createPlaceholderGeometry(): BoxGeometry {
  const geometry = new BoxGeometry(1, 1, 1);
  geometry.translate(0, 0.5, 0);
  return geometry;
}

function createMatcapTexture(): Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    // Steep iso camera samples the matcap OUTER RING for most visible faces
    // (same trap as pawns.ts createMatcapTexture) — keep the ring light or
    // every dark-authored GLB body renders near-black.
    const gradient = ctx.createRadialGradient(size * 0.38, size * 0.32, size * 0.06, size * 0.5, size * 0.5, size * 0.68);
    gradient.addColorStop(0, "#ffffff");
    gradient.addColorStop(0.4, "#d8d8d8");
    gradient.addColorStop(0.75, "#aab0b5");
    gradient.addColorStop(1, "#878c92");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function emptyStats(): WorldPropsStats {
  return {
    areaId: null,
    propCount: 0,
    glbPropCount: 0,
    placeholderPropCount: 0,
    skippedPropCount: 0,
    instancedMeshCount: 0,
    naiveDrawCallCount: 0,
    needsAuthoring: [],
  };
}
