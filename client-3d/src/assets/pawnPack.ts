// pawnPack.ts — loader for the cooked PawnForgeV2 game pack.
//
// Loads /assets/pawn-pack/{game_pack.json, manifest_anim.json, slugthrower_attach.json,
// vibrosword_attach.json, pawn_male.glb, pawn_female.glb, slugthrower.glb,
// vibrosword.glb} plus optional equipment/manifest.json and its item GLBs
//
// - AnimationClips are parsed ONCE from pawn_male.glb and shared by every pawn
//   instance (male and female bodies have the identical 50-bone set + names, so
//   clips rebind by node name through each instance's own AnimationMixer).
// - Per-instance skinned bodies are produced with SkeletonUtils.clone().
// - The uniform scale constant that maps the cooked 1.7525 m body onto the
//   ~1.7-unit contract height lives here (ONE constant, applied at instance root).
import { AnimationClip, Bone, Group, Quaternion, SkinnedMesh, Vector3, type Object3D } from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { SUCCESSOR_3D_CONFIG } from "../config";
import { registerLocalGearCatalog, type LocalGearCatalogEntry } from "../ui/inventory/data";
import { gearDescriptionFor } from "../ui/inventory/itemCopy";
import { registerKnownGearIds, get as getStoredGearIds } from "../ui/inventory/equippedGearStore";
import { registerPawnPackEquipmentIds } from "../render/equipmentSlots";
import { WARDROBE_PIECES } from "./wardrobe.gen";
import {
  toClipLayer,
  type SlugthrowerAttachSpec,
  type SupportArmSpec,
  type TorsoYawRecipe,
  type VibroswordAttachSpec,
  type WeaponStowSpec,
} from "./pawnRigTypes";
import { requireRuntimePublicPath } from "@successor/client/src/slice-core/runtimePublicPaths";

export type PawnBody = "male" | "female";
export type ClipLayer = "base" | "upper" | "hand" | "montage" | "arm";
export type PawnEquipmentLayer = "Armor" | "Under";

/** Canonical skin-coverage vocabulary shared by authored equipment and both runtimes. */
export const PAWN_BODY_ZONES = [
  "torso",
  "pelvis",
  "neck",
  "head",
  "left_upper_arm",
  "right_upper_arm",
  "left_forearm",
  "right_forearm",
  "left_hand",
  "right_hand",
  "left_thigh",
  "right_thigh",
  "left_calf",
  "right_calf",
  "left_foot",
  "right_foot",
] as const;
export type PawnBodyZone = (typeof PAWN_BODY_ZONES)[number];
export type PawnBodyZoneMask = number;

const pawnBodyZoneMaskByName: Readonly<Record<PawnBodyZone, PawnBodyZoneMask>> = Object.freeze({
  torso: 1 << 0,
  pelvis: 1 << 1,
  neck: 1 << 2,
  head: 1 << 3,
  left_upper_arm: 1 << 4,
  right_upper_arm: 1 << 5,
  left_forearm: 1 << 6,
  right_forearm: 1 << 7,
  left_hand: 1 << 8,
  right_hand: 1 << 9,
  left_thigh: 1 << 10,
  right_thigh: 1 << 11,
  left_calf: 1 << 12,
  right_calf: 1 << 13,
  left_foot: 1 << 14,
  right_foot: 1 << 15,
});

export function isPawnBodyZone(value: string): value is PawnBodyZone {
  return Object.prototype.hasOwnProperty.call(pawnBodyZoneMaskByName, value);
}


export interface PawnEquipmentPaletteZone {
  /** Zone key from the wardrobe taxonomy (e.g. "body", "straps"). */
  key: string;
  /** Dye family id in wardrobe_palette.json (workcloth/leather/rubber). */
  family: string;
  /** Atlas color-slot suffixes this zone owns (e.g. ["c3"]). */
  slots: readonly string[];
  /** Authored atlas hex — the as-found look and the fallback color. */
  default: string;
}

export interface PawnEquipmentItem {
  id: string;
  name: string;
  layer: PawnEquipmentLayer;
  group: string;
  slot: string;
  glb: string;
  glbFemale?: string;
  mat?: string;
  requires: readonly string[];
  /** Segmented skin primitives this item fully encloses. Unknown manifest
   * values are reported and omitted while the pack loads. */
  hideBodyZones?: readonly PawnBodyZone[];
  /** Dye zones (wardrobe pieces only): player colors map onto atlas slots. */
  palette?: { zones: readonly PawnEquipmentPaletteZone[] };
  /** Asset-Lab-only items (fit trials, prototypes): shown in the viewer,
   * NEVER registered into the in-game wardrobe catalog. */
  viewerOnly?: boolean;
  /** Server-authority inventory item id that OWNS this entry (rigid accessory
   * bakes, e.g. the 7203 field cap). Authority-owned entries never become
   * client-local catalog rows — the server row is the sole inventory item. */
  authorityItemId?: number;
  /** Rigid ORIGIN-authored attachment: the live skeleton bone the GLB root
   * snaps to at identity (AssetViewer SNAP convention). Entries without it
   * take the skinned-mesh rebind route. */
  rigidAnchorBone?: string;
}

export interface PawnEquipmentLookup {
  /** Immutable id -> manifest item index built once when the pack loads. */
  readonly itemById: ReadonlyMap<string, PawnEquipmentItem>;
  /** Dynamic manifest membership index, built once with the pack. */
  readonly availableIds: ReadonlySet<string>;
  /** Manifest ids in authored order, reused by remote/default resolution. */
  readonly itemIds: readonly string[];
  /** Helmet ids in deterministic sort order, reused by remote/default resolution. */
  readonly helmetIds: readonly string[];
  /** Item coverage bits, precomputed once when the equipment manifest loads. */
  readonly hideBodyZoneMaskById: ReadonlyMap<string, PawnBodyZoneMask>;
}

export interface PawnEquipmentPack {
  basePath: string;
  items: readonly PawnEquipmentItem[];
  scenes: ReadonlyMap<string, Group>;
  femaleScenes?: ReadonlyMap<string, Group>;
  /** Precomputed equipment indexes. Legacy hand-built test packs may omit it. */
  readonly lookup?: PawnEquipmentLookup;
}
const equipmentLookupCache = new WeakMap<PawnEquipmentPack, PawnEquipmentLookup>();

/** Build the immutable indexes consumed by the hot humanoid render path. */
export function buildPawnEquipmentLookup(equipment: PawnEquipmentPack): PawnEquipmentLookup {
  const itemById = new Map<string, PawnEquipmentItem>();
  const availableIds = new Set<string>();
  const itemIds: string[] = [];
  const helmetIds: string[] = [];
  const hideBodyZoneMaskById = new Map<string, PawnBodyZoneMask>();
  for (const item of equipment.items) {
    itemById.set(item.id, item);
    availableIds.add(item.id);
    itemIds.push(item.id);
    if (item.slot === "armor_helmet") helmetIds.push(item.id);
    let hideBodyZoneMask = 0;
    for (const zone of item.hideBodyZones ?? []) hideBodyZoneMask |= pawnBodyZoneMaskByName[zone];
    if (hideBodyZoneMask !== 0) hideBodyZoneMaskById.set(item.id, hideBodyZoneMask);
  }
  helmetIds.sort();
  return Object.freeze({
    itemById,
    availableIds,
    itemIds: Object.freeze(itemIds),
    helmetIds: Object.freeze(helmetIds),
    hideBodyZoneMaskById,
  });
}

/** Reuse a pack's precomputed indexes; legacy hand-built packs are indexed once. */
export function pawnEquipmentLookupFor(equipment: PawnEquipmentPack): PawnEquipmentLookup {
  if (equipment.lookup) return equipment.lookup;
  const cached = equipmentLookupCache.get(equipment);
  if (cached) return cached;
  const lookup = buildPawnEquipmentLookup(equipment);
  equipmentLookupCache.set(equipment, lookup);
  return lookup;
}

/** Resolve the exact equipped set's segmented-skin coverage without creating
 * a per-pawn Set. Both body sex variants use the same manifest vocabulary. */
export function resolvePawnBodyZoneMask(
  equipment: PawnEquipmentPack,
  itemIds: readonly string[],
  lookup: PawnEquipmentLookup = pawnEquipmentLookupFor(equipment),
): PawnBodyZoneMask {
  let hiddenZones = 0;
  for (let i = 0; i < itemIds.length; i += 1) {
    hiddenZones |= lookup.hideBodyZoneMaskById.get(itemIds[i]!) ?? 0;
  }
  return hiddenZones;
}

/** A segmented body primitive discovered once from an unmodified body clone. */
export interface PawnBodyZoneMesh {
  readonly mesh: SkinnedMesh;
  readonly zoneMask: PawnBodyZoneMask;
  readonly initialVisible: boolean;
}

/** Cache only exact `BodyZone_<canonical-zone>` skinned body primitives. */
export function collectPawnBodyZoneMeshes(bodyRoot: Object3D): PawnBodyZoneMesh[] {
  const bodyZoneMeshes: PawnBodyZoneMesh[] = [];
  bodyRoot.traverse((object) => {
    if (!(object instanceof SkinnedMesh)) return;
    const material = Array.isArray(object.material)
      ? object.material.length === 1 ? object.material[0]! : null
      : object.material;
    if (!material) return;
    const materialName = material.name;
    if (!materialName.startsWith("BodyZone_")) return;
    const zone = materialName.slice("BodyZone_".length);
    if (!isPawnBodyZone(zone)) return;
    bodyZoneMeshes.push({
      mesh: object,
      zoneMask: pawnBodyZoneMaskByName[zone],
      initialVisible: object.visible,
    });
  });
  return bodyZoneMeshes;
}

/** Apply a spawn/appearance-time coverage mask and restore zones no longer
 * claimed by an equipped item. Apparel is never part of this cached list. */
export function applyPawnBodyZoneMask(
  bodyZoneMeshes: readonly PawnBodyZoneMesh[],
  hiddenZones: PawnBodyZoneMask,
): void {
  for (let i = 0; i < bodyZoneMeshes.length; i += 1) {
    const bodyZoneMesh = bodyZoneMeshes[i]!;
    bodyZoneMesh.mesh.visible = bodyZoneMesh.initialVisible
      && (hiddenZones & bodyZoneMesh.zoneMask) === 0;
  }
}

export interface PawnClipMeta {
  name: string;
  layer: ClipLayer;
  /** Named mask from manifest_anim.json; "full" = all bones; null = unmasked base. */
  mask: string | null;
  loop: boolean;
  durationS: number;
  moveSpeedMps: number;
  clampWhenFinished: boolean;
  /** Named timeline events in clip seconds (e.g. reload mag_eject_s / mag_insert_s). */
  events: Record<string, number>;
}

// The attach-spec contract lives in pawnRigTypes so the loader, the rigs and
// the Asset Lab all extend ONE definition; re-exported here because most
// consumers import the pack surface.
export type {
  SlugthrowerAttachSpec,
  VibroswordAttachSpec,
  WeaponStowSpec,
  TorsoYawRecipe,
} from "./pawnRigTypes";

export interface WeaponModel {
  scene: Group;
  spec: SlugthrowerAttachSpec;
  scale: number;
  silhouetteClass: string;
  /** Embedded action clips authored in the weapon GLB (fire cycles, bolt
   * throws, casing ejects). Empty for weapons with no authored animations.
   * Runtime combat does not consume these yet; the Asset Lab plays them. */
  animations: readonly AnimationClip[];
}

/** Authored humanoid bodies that share the PawnForge 50-bone contract but
 * are not selectable player appearances (for example, named droid NPCs). */
export interface SpecialPawnBody {
  scene: Group;
  heightM: number;
}

export interface PawnPack {
  bodies: Record<PawnBody, Group>;
  /** Optional worn-state body variants. Missing variants fall back to bodies. */
  bareBodies?: Partial<Record<PawnBody, Group>>;
  specialBodies: ReadonlyMap<string, SpecialPawnBody>;
  slugthrowerScene: Group;
  vibroswordScene: Group;
  clips: ReadonlyMap<string, AnimationClip>;
  clipMeta: ReadonlyMap<string, PawnClipMeta>;
  /** maskName -> sanitized bone-name set. Includes the synthetic "full" mask. */
  masks: ReadonlyMap<string, ReadonlySet<string>>;
  /** All 50 sanitized bone names of ue5_mannequin_50. */
  boneNames: ReadonlySet<string>;
  torsoYaw: TorsoYawRecipe;
  slugthrower: SlugthrowerAttachSpec;
  vibrosword: VibroswordAttachSpec;
  weapons: ReadonlyMap<string, WeaponModel>;
  equipment: PawnEquipmentPack;
  /** Uniform instance-root scale: contract height / cooked mesh height. */
  scale: number;
}

/** Optional body variant selection never widens the PawnBody identity union. */
export interface PawnBodyCloneOptions {
  bare?: boolean;
}

/** `under_bodysuit` is authored as `under_full`, but its fixed outfit mesh
 * covers the legs. Keep this exceptional id explicit while all normal
 * legwear remains manifest-slot driven. */
const LEGS_COVERING_ID_OVERRIDES: Record<string, true> = { under_bodysuit: true };

/** Return true when the resolved equipment set covers the pawn's legs. */
export function equipmentIdsCoverLegs(
  items: readonly PawnEquipmentItem[],
  itemIds: readonly string[],
  lookup?: PawnEquipmentLookup,
): boolean {
  const itemById = lookup?.itemById;
  for (let i = 0; i < itemIds.length; i += 1) {
    const itemId = itemIds[i]!;
    if (LEGS_COVERING_ID_OVERRIDES[itemId] === true) return true;
    const item = itemById?.get(itemId);
    if (item ? item.slot === "under_legs" : items.some((candidate) => candidate.id === itemId && candidate.slot === "under_legs")) {
      return true;
    }
  }
  return false;
}
/** GLTFLoader keeps node names as authored; track names are "<node>.<property>". */
export function sane(name: string): string {
  return name.replace(/\s/g, "_").replace(/[\[\].:\/]/g, "");
}

interface GamePackClipJson {
  name: string;
  layer: string;
  mask: string | null;
  loop: boolean;
  duration_s: number;
  move_speed_mps: number;
  clamp_when_finished?: boolean;
}

interface GamePackPawnJson {
  file: string;
  height_m: number;
  bare_file?: string;
}

interface GamePackJson {
  schema: string;
  pawns: Record<string, GamePackPawnJson>;
  clips: GamePackClipJson[];
}

interface ManifestAnimJson {
  masks: Record<string, string[]>;
  procedural: { torso_yaw: Record<string, number> };
  clips: Record<string, { events?: Record<string, number> }>;
}

interface SlugthrowerAttachJson {
  sockets: Record<string, [number, number, number]>;
  nodes: { frame: string; mag?: string };
  mount_hand_r_local: { pos: [number, number, number]; quat: [number, number, number, number] };
}

interface VibroswordAttachJson {
  sockets: Record<string, [number, number, number]>;
  nodes: { frame: string };
  mount_hand_r_local: { pos: [number, number, number]; quat: [number, number, number, number] };
  stow_socket?: WeaponStowSocketJson;
}

interface PawnEquipmentManifestJson {
  items: Array<{
    id: string;
    name: string;
    layer: PawnEquipmentLayer;
    group: string;
    slot: string;
    glb: string;
    glbFemale?: string;
    mat?: string;
    requires?: string[];
    palette?: { zones: Array<{ key: string; family: string; slots: string[]; default: string }> };
    viewerOnly?: boolean;
    authorityItemId?: number;
    rigidAnchorBone?: string;
    hideBodyZones?: string[];
  }>;
}

async function fetchJson<T>(url: string, guard: (value: unknown) => value is T): Promise<T> {
  const resolvedUrl = requireRuntimePublicPath(url);
  const response = await fetch(resolvedUrl);
  if (!response.ok) throw new Error(`pawn pack fetch failed: ${resolvedUrl} (${response.status})`);
  const parsed: unknown = await response.json();
  if (!guard(parsed)) throw new Error(`pawn pack schema mismatch: ${resolvedUrl}`);
  return parsed;
}

async function loadOptionalGltf(loader: GLTFLoader, url: string): Promise<GLTF | null> {
  const resolvedUrl = requireRuntimePublicPath(url);
  const response = await fetch(resolvedUrl);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`pawn pack fetch failed: ${resolvedUrl} (${response.status})`);
  return loader.parseAsync(await response.arrayBuffer(), resolvedUrl);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isGamePackPawnJson(value: unknown): value is GamePackPawnJson {
  return isRecord(value)
    && typeof value.file === "string"
    && typeof value.height_m === "number"
    && (value.bare_file === undefined || typeof value.bare_file === "string");
}

function isGamePackJson(value: unknown): value is GamePackJson {
  return isRecord(value)
    && isRecord(value.pawns)
    && Object.values(value.pawns).every(isGamePackPawnJson)
    && Array.isArray(value.clips)
    && typeof value.schema === "string";
}

function isManifestAnimJson(value: unknown): value is ManifestAnimJson {
  return isRecord(value)
    && isRecord(value.masks)
    && isRecord(value.procedural)
    && isRecord(value.clips);
}

function isSlugthrowerAttachJson(value: unknown): value is SlugthrowerAttachJson {
  return isRecord(value)
    && isRecord(value.sockets)
    && isRecord(value.nodes)
    && isRecord(value.mount_hand_r_local);
}

function isVibroswordAttachJson(value: unknown): value is VibroswordAttachJson {
  return isRecord(value)
    && isRecord(value.sockets)
    && isRecord(value.nodes)
    && value.nodes.frame !== undefined
    && isRecord(value.mount_hand_r_local);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isPawnEquipmentLayer(value: unknown): value is PawnEquipmentLayer {
  return value === "Armor" || value === "Under";
}

function isPaletteZoneJson(value: unknown): value is { key: string; family: string; slots: string[]; default: string } {
  return isRecord(value)
    && typeof value.key === "string"
    && typeof value.family === "string"
    && isStringArray(value.slots)
    && typeof value.default === "string";
}

function isPaletteJson(value: unknown): value is { zones: Array<{ key: string; family: string; slots: string[]; default: string }> } {
  return isRecord(value) && Array.isArray(value.zones) && value.zones.every(isPaletteZoneJson);
}

/** Exported for the equipment-manifest contract test — the one guard the
 * runtime load path uses (fetchOptionalEquipmentManifest rejects on it). */
export function isPawnEquipmentManifestJson(value: unknown): value is PawnEquipmentManifestJson {
  return isRecord(value)
    && Array.isArray(value.items)
    && value.items.every((item) => isRecord(item)
      && typeof item.id === "string"
      && typeof item.name === "string"
      && isPawnEquipmentLayer(item.layer)
      && typeof item.group === "string"
      && typeof item.slot === "string"
      && typeof item.glb === "string"
      && (item.glbFemale === undefined || typeof item.glbFemale === "string")
      && (item.requires === undefined || isStringArray(item.requires))
      && (item.hideBodyZones === undefined || isStringArray(item.hideBodyZones))
      && (item.palette === undefined || isPaletteJson(item.palette))
      && (item.authorityItemId === undefined
        || (typeof item.authorityItemId === "number" && Number.isInteger(item.authorityItemId) && item.authorityItemId > 0))
      && (item.rigidAnchorBone === undefined
        || (typeof item.rigidAnchorBone === "string" && item.rigidAnchorBone.length > 0)));
}


function toVector3(values: readonly [number, number, number]): Vector3 {
  return new Vector3(values[0], values[1], values[2]);
}

async function fetchOptionalEquipmentManifest(basePath: string): Promise<PawnEquipmentManifestJson | null> {
  const url = `${basePath}/manifest.json`;
  const resolvedUrl = requireRuntimePublicPath(url);
  const response = await fetch(resolvedUrl);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`pawn equipment fetch failed: ${resolvedUrl} (${response.status})`);
  const parsed: unknown = await response.json();
  if (!isPawnEquipmentManifestJson(parsed)) throw new Error(`pawn equipment schema mismatch: ${resolvedUrl}`);
  return parsed;
}

// Optional-equipment degradation follows the special-body path below: emit
// each invalid manifest declaration once, retain the item, and expose no
// guessed skin coverage.
const warnedUnknownEquipmentHideBodyZones = new Set<string>();

function reportUnknownEquipmentHideBodyZone(itemId: string, zone: string): void {
  const key = `${itemId}\u0000${zone}`;
  if (warnedUnknownEquipmentHideBodyZones.has(key)) return;
  warnedUnknownEquipmentHideBodyZones.add(key);
  console.warn(`pawn pack: equipment "${itemId}" declares unknown hideBodyZones entry "${zone}"; ignoring it`);
}

async function loadEquipmentPack(loader: GLTFLoader, basePath: string): Promise<PawnEquipmentPack> {
  const manifest = await fetchOptionalEquipmentManifest(basePath);
  if (!manifest) {
    const equipment = { basePath, items: [], scenes: new Map<string, Group>() };
    return { ...equipment, lookup: buildPawnEquipmentLookup(equipment) };
  }

  // viewerOnly items stay out of normal game boot. The slot-color proof run
  // opts them into the transient pack via ?slotColorProof=1 so the same runtime
  // surfaces can prove a trial garment without making it regular wardrobe.
  const includeViewerOnly = includeViewerOnlyEquipment();
  const manifestItems = manifest.items.map((item) => toPawnEquipmentItem(item, reportUnknownEquipmentHideBodyZone));
  const items = manifestItems
    .filter((item) => includeViewerOnly || item.viewerOnly !== true);
  const scenes = new Map<string, Group>();
  const femaleScenes = new Map<string, Group>();
  await Promise.all(items.map(async (item) => {
    const [baseGltf, femaleGltf] = await Promise.all([
      loader.loadAsync(requireRuntimePublicPath(`${basePath}/${item.glb}`)),
      item.glbFemale
        ? loader.loadAsync(requireRuntimePublicPath(`${basePath}/${item.glbFemale}`))
        : Promise.resolve(null),
    ]);
    scenes.set(item.id, baseGltf.scene);
    if (femaleGltf) femaleScenes.set(item.id, femaleGltf.scene);
  }));
  const equipment = { basePath, items, scenes, femaleScenes };
  return { ...equipment, lookup: buildPawnEquipmentLookup(equipment) };
}

/** Manifest JSON → runtime item. Exported for the manifest contract test:
 * dropping a field here (rigidAnchorBone especially) would silently demote a
 * rigid accessory to the SkinnedMesh route, which attaches nothing. */
export function toPawnEquipmentItem(
  item: PawnEquipmentManifestJson["items"][number],
  reportUnknownBodyZone?: (itemId: string, zone: string) => void,
): PawnEquipmentItem {
  const hideBodyZones: PawnBodyZone[] = [];
  for (const zone of item.hideBodyZones ?? []) {
    if (isPawnBodyZone(zone)) {
      hideBodyZones.push(zone);
    } else {
      reportUnknownBodyZone?.(item.id, zone);
    }
  }
  return {
    id: item.id,
    name: item.name,
    layer: item.layer,
    group: item.group,
    slot: item.slot,
    glb: item.glb,
    glbFemale: item.glbFemale,
    mat: item.mat,
    requires: item.requires ?? [],
    ...(hideBodyZones.length > 0 ? { hideBodyZones: Object.freeze(hideBodyZones) } : {}),
    ...(item.palette ? { palette: { zones: item.palette.zones.map((zone) => ({ ...zone, slots: [...zone.slots] })) } } : {}),
    viewerOnly: item.viewerOnly,
    ...(item.authorityItemId !== undefined ? { authorityItemId: item.authorityItemId } : {}),
    ...(item.rigidAnchorBone !== undefined ? { rigidAnchorBone: item.rigidAnchorBone } : {}),
  };
}

/**
 * Wardrobe surfaced in the inventory as client-local equippables. One helmet
 * only for now (owner ruling: S2 "Prop Faithful"); other helmet variants stay
 * viewer-side. Descriptions come from the 3D client's own copy tables
 * (ui/inventory/itemCopy.ts) — dry one-liners.
 */
const WARDROBE_HELMET_KEEP = "helmet_s2";

/** Manifest groups that are store WARDROBE (creator clothing): these enter a
 * character's gear catalog ONLY through the character's own worn set —
 * DEF-13a: the full store catalog must never appear as inventory rows. */
const WARDROBE_GROUPS: ReadonlySet<string> = new Set(WARDROBE_PIECES.map((piece) => piece.group));

function includeViewerOnlyEquipment(): boolean {
  if (typeof window === "undefined") return false;
  // Asset Lab opt-in (viewer boot sets the flag before loadPawnPack): the lab
  // must browse fit-trial garments the game boot filters out. Game paths never
  // set this flag, so runtime behavior is unchanged.
  const flagged = (window as Window & { __successorIncludeViewerOnlyEquipment?: boolean })
    .__successorIncludeViewerOnlyEquipment === true;
  if (flagged) return true;
  return new URLSearchParams(window.location.search).get("slotColorProof") === "1";
}

/** The character's clothes at boot: creator worn set from the join payload
 * (charselect flow) unioned with the character's stored equipped ids (relog —
 * the store was worn-seeded on first entry and persists the player's own
 * toggles). Lab/autoEnter boots have neither -> no wardrobe rows (classic
 * gear only), which matches their fixture look. */
function bootWornWardrobeIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  if (typeof window !== "undefined") {
    const selected = (window as Window & {
      __successorSelectedCharacter?: { worn?: Array<{ item?: unknown }> };
    }).__successorSelectedCharacter;
    for (const piece of selected?.worn ?? []) {
      if (typeof piece?.item === "string" && piece.item.length > 0) ids.add(piece.item);
    }
  }
  for (const id of getStoredGearIds()) ids.add(id);
  return ids;
}

export function buildWardrobeCatalog(
  equipment: PawnEquipmentPack,
  wornWardrobeIds: ReadonlySet<string> = bootWornWardrobeIds(),
): LocalGearCatalogEntry[] {
  const entries: LocalGearCatalogEntry[] = [];
  for (const item of equipment.items) {
    // Asset-Lab-only items stay hidden unless the transient proof flag opted
    // them into the game pack above.
    if (item.viewerOnly && !includeViewerOnlyEquipment()) continue;
    // Authority-owned entries (numeric server item id, e.g. the 7203 field
    // cap): the server inventory row is the SOLE item — no duplicate
    // always-present local gear row.
    if (item.authorityItemId !== undefined) continue;
    // Bake-off helmet lineup stays lab-only except the shipped pick. (Slot
    // unification moved helmets to `cranium`, so filter by GROUP not slot.)
    if (item.group.startsWith("Helmet") && item.id !== WARDROBE_HELMET_KEEP) continue;
    // Hair is a character APPEARANCE property (owner ruling 2026-07-08), never an
    // inventory item — it rides the pawn from appearance.hair and reapplies when
    // the cranium empties. Keep it out of the item bag entirely.
    if (item.group === "Hair") continue;
    // Wardrobe clothing (Tops/Bottoms/Footwear/Gloves): only the character's
    // OWN pieces are gear rows — the store catalog is the CREATOR's surface
    // (DEF-13a owner report: fresh character spawned owning the whole shop).
    if (WARDROBE_GROUPS.has(item.group) && !wornWardrobeIds.has(item.id)) continue;
    entries.push({
      id: item.id,
      label: item.name,
      description: gearDescriptionFor(item.id, item.slot, item.layer),
      glb: `${equipment.basePath}/${item.glb}`,
    });
  }
  return entries;
}

interface WeaponStowSocketJson {
  pos?: [number, number, number];
  rot_deg?: [number, number, number];
  arc_lift?: number;
}

interface SupportArmJson {
  min_elbow_bend_deg?: number;
  shoulder_advance_max_m?: number;
  elbow_pole_deg?: number;
}

interface WeaponAttachJson {
  sockets: Record<string, [number, number, number]>;
  nodes: { frame: string; mag?: string };
  mount_hand_r_local: { pos: [number, number, number]; quat: [number, number, number, number] };
  scale_to_pawn?: number;
  silhouette_class?: string;
  stow_socket?: WeaponStowSocketJson;
  hold?: { resting_yaw_deg?: number; support_arm?: SupportArmJson };
}

interface WeaponsManifestJson {
  items: Array<{ id: string; glb: string; attach: string; class: string; scale?: number }>;
}

function isWeaponAttachJson(value: unknown): value is WeaponAttachJson {
  return isRecord(value) && isRecord(value.sockets) && isRecord(value.nodes)
    && isRecord(value.mount_hand_r_local);
}

function isWeaponsManifestJson(value: unknown): value is WeaponsManifestJson {
  return isRecord(value) && Array.isArray(value.items)
    && value.items.every((it) => isRecord(it) && typeof it.id === "string"
      && typeof it.glb === "string" && typeof it.attach === "string"
      && typeof it.class === "string");
}

function isTriple(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === "number" && Number.isFinite(n));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Hard rails on the authored hold posture: an arm, not a pretzel. */
const MAX_SUPPORT_BEND_DEG = 80;
const MAX_SHOULDER_ADVANCE_M = 0.12;

/**
 * `hold.support_arm` is only honoured when it carries BOTH a bend floor and a
 * pole angle: together they are the posture, and rolling an elbow with nothing
 * holding the bend would spin a straight arm about its own axis. A partial or
 * malformed block falls through to the legacy unposed solve, the same way
 * `stow_socket` falls through to the class default. Values are clamped to
 * anatomical rails so a bad edit cannot dislocate the shoulder.
 */
function parseSupportArm(json: SupportArmJson | undefined): SupportArmSpec | undefined {
  if (!json || !isFiniteNumber(json.min_elbow_bend_deg) || !isFiniteNumber(json.elbow_pole_deg)) {
    return undefined;
  }
  const advance = json.shoulder_advance_max_m;
  const toRad = Math.PI / 180;
  return {
    minBendRad: Math.min(MAX_SUPPORT_BEND_DEG, Math.max(0, json.min_elbow_bend_deg)) * toRad,
    poleRad: json.elbow_pole_deg * toRad,
    shoulderAdvanceMaxM: isFiniteNumber(advance)
      ? Math.min(MAX_SHOULDER_ADVANCE_M, Math.max(0, advance))
      : 0,
  };
}

/**
 * `stow_socket` is only honoured when it carries BOTH a position and a
 * rotation. A partial or malformed block falls through to the class default
 * rather than half-applying, so a bad edit can never silently produce a
 * weapon floating at the spine origin.
 */
function parseStowSocket(json: WeaponStowSocketJson | undefined, fallbackArcLift: number): WeaponStowSpec | undefined {
  if (!json || !isTriple(json.pos) || !isTriple(json.rot_deg)) return undefined;
  return {
    pos: toVector3(json.pos),
    rotDeg: toVector3(json.rot_deg),
    arcLift: isFiniteNumber(json.arc_lift) ? json.arc_lift : fallbackArcLift,
  };
}

function parseWeaponAttach(json: WeaponAttachJson, silhouetteClass: string): SlugthrowerAttachSpec {
  const s = json.sockets;
  const melee = (json.silhouette_class ?? silhouetteClass) === "melee";
  const stowDefaults = melee
    ? SUCCESSOR_3D_CONFIG.pawnPack.swordStow
    : SUCCESSOR_3D_CONFIG.pawnPack.weaponStow;
  const restingYawDeg = json.hold?.resting_yaw_deg;
  return {
    mountPos: toVector3(json.mount_hand_r_local.pos),
    mountQuat: new Quaternion(...json.mount_hand_r_local.quat),
    sockets: {
      grip: toVector3(s.grip ?? [0, 0, 0]),
      foregrip: toVector3(s.foregrip ?? s.grip ?? [0, 0, 0.25]),
      muzzle: toVector3(s.muzzle ?? [0, 0, 0.44]),
      stock: toVector3(s.stock ?? [0, 0, -0.41]),
      foregripContact: isTriple(s.foregrip_contact) ? toVector3(s.foregrip_contact) : undefined,
    },
    nodes: { frame: json.nodes.frame, mag: json.nodes.mag },
    scale: json.scale_to_pawn ?? 1,
    silhouetteClass: json.silhouette_class ?? silhouetteClass,
    stow: parseStowSocket(json.stow_socket, stowDefaults.arcLift),
    restingYawRad: isFiniteNumber(restingYawDeg) ? restingYawDeg * (Math.PI / 180) : undefined,
    supportArm: parseSupportArm(json.hold?.support_arm),
  };
}

/**
 * Optional weapon registry (404-safe): loads each catalogued weapon GLB + its
 * attach spec (hand-authored wave weapons, mount-transfer calibrated) so the
 * pawn renderer can present a distinct model per equipped weapon id.
 */
export async function loadWeaponsRegistry(loader: GLTFLoader, base: string): Promise<Map<string, WeaponModel>> {
  const map = new Map<string, WeaponModel>();
  const url = `${base}/weapons/weapons_manifest.json`;
  const response = await fetch(requireRuntimePublicPath(url));
  if (response.status === 404) return map;
  if (!response.ok) throw new Error(`weapons manifest fetch failed: ${url} (${response.status})`);
  const parsed: unknown = await response.json();
  if (!isWeaponsManifestJson(parsed)) throw new Error(`weapons manifest schema mismatch: ${url}`);
  await Promise.all(parsed.items.map(async (item) => {
    const attachRaw: unknown = await (await fetch(requireRuntimePublicPath(`${base}/weapons/${item.attach}`))).json();
    if (!isWeaponAttachJson(attachRaw)) throw new Error(`weapon attach schema mismatch: ${item.attach}`);
    const spec = parseWeaponAttach(attachRaw, item.class);
    const gltf = await loader.loadAsync(requireRuntimePublicPath(`${base}/weapons/${item.glb}`));
    map.set(item.id, { scene: gltf.scene, spec, scale: item.scale ?? spec.scale ?? 1, silhouetteClass: item.class, animations: gltf.animations });
  }));
  return map;
}

const SPECIAL_PAWN_BODY_SPECS = [
  {
    key: "droid_grok_humanoid",
    file: "droid_grok_humanoid.glb",
    heightM: 1.7308552106842399,
  },
] as const;

const warnedSpecialPawnBodyFailures = new Set<string>();

/** Special NPC bodies are presentation upgrades, not boot-critical pack
 * members. A missing promotion must leave the standard pawn fallback usable;
 * core player bodies, weapons, animation metadata, and equipment still fail
 * loudly through loadPawnPack's outer Promise.all. */
async function loadSpecialPawnBodies(loader: GLTFLoader, base: string): Promise<Map<string, SpecialPawnBody>> {
  const bodies = new Map<string, SpecialPawnBody>();
  await Promise.all(SPECIAL_PAWN_BODY_SPECS.map(async (spec) => {
    const url = `${base}/special/${spec.file}`;
    try {
      const gltf = await loader.loadAsync(requireRuntimePublicPath(url));
      bodies.set(spec.key, { scene: gltf.scene, heightM: spec.heightM });
    } catch (error) {
      if (!warnedSpecialPawnBodyFailures.has(spec.key)) {
        warnedSpecialPawnBodyFailures.add(spec.key);
        console.warn(
          `pawn pack: optional special humanoid body "${spec.key}" failed to load; using standard pawn fallback`,
          error,
        );
      }
    }
  }));
  return bodies;
}

export async function loadPawnPack(): Promise<PawnPack> {
  const base = SUCCESSOR_3D_CONFIG.pawnPack.basePath;
  const loader = new GLTFLoader();
  const equipmentBase = `${base}/equipment`;
  const [gamePack, manifest, slugthrowerAttach, vibroswordAttach, maleGltf, femaleGltf, slugthrowerGltf, vibroswordGltf, equipment, weapons, specialBodies] = await Promise.all([
    fetchJson(`${base}/game_pack.json`, isGamePackJson),
    fetchJson(`${base}/manifest_anim.json`, isManifestAnimJson),
    fetchJson(`${base}/slugthrower_attach.json`, isSlugthrowerAttachJson),
    fetchJson(`${base}/vibrosword_attach.json`, isVibroswordAttachJson),
    loader.loadAsync(requireRuntimePublicPath(`${base}/pawn_male.glb`)),
    loader.loadAsync(requireRuntimePublicPath(`${base}/pawn_female.glb`)),
    loader.loadAsync(requireRuntimePublicPath(`${base}/slugthrower.glb`)),
    loader.loadAsync(requireRuntimePublicPath(`${base}/vibrosword.glb`)),
    loadEquipmentPack(loader, equipmentBase),
    loadWeaponsRegistry(loader, base),
    loadSpecialPawnBodies(loader, base),
  ]);
  const bareFile = gamePack.pawns.male?.bare_file;
  const bareMaleGltf = bareFile ? await loadOptionalGltf(loader, `${base}/${bareFile}`) : null;
  registerPawnPackEquipmentIds(equipment.items.map((item) => item.id));
  registerKnownGearIds(equipment.items
    .filter((item) => (includeViewerOnlyEquipment() || !item.viewerOnly) && item.group !== "Hair")
    .map((item) => ({ id: item.id, slot: item.slot, requires: item.requires })));
  registerLocalGearCatalog(buildWardrobeCatalog(equipment));

  const clips = new Map<string, AnimationClip>();
  for (const clip of maleGltf.animations) clips.set(clip.name, clip);

  const boneNames = new Set<string>();
  collectBoneNames(maleGltf, boneNames);

  const masks = new Map<string, ReadonlySet<string>>();
  for (const [maskName, bones] of Object.entries(manifest.masks)) {
    masks.set(maskName, new Set(bones.map(sane)));
  }
  masks.set("full", new Set(boneNames));
  // Derived fingers-only mask: the authored "hand" mask includes the WRIST
  // bones (hand_l/hand_r). Layering the kimodo-era grip clip on it overrides
  // the armed base clip's wrists, and the slugthrower — welded to hand_r —
  // inherits the wrong rotation (diagonal up-carry instead of the level aim the
  // viewer shows; the viewer plays no hand layer). Fingers keep trigger
  // discipline; wrists ride the base clip / support-hand IK. Consumed by
  // PawnAnimator.
  const handMask = masks.get("hand");
  if (handMask) {
    const fingersOnly = new Set(handMask);
    fingersOnly.delete("hand_l");
    fingersOnly.delete("hand_r");
    masks.set("hand_fingers", fingersOnly);
  }

  const clipMeta = new Map<string, PawnClipMeta>();
  for (const clip of gamePack.clips) {
    clipMeta.set(clip.name, {
      name: clip.name,
      layer: toClipLayer(clip.layer, clip.name),
      mask: clip.mask,
      loop: clip.loop,
      durationS: clip.duration_s,
      moveSpeedMps: clip.move_speed_mps,
      clampWhenFinished: clip.clamp_when_finished ?? false,
      events: manifest.clips[clip.name]?.events ?? {},
    });
    if (!clips.has(clip.name)) {
      console.warn(`pawn pack: clip "${clip.name}" declared in game_pack.json missing from pawn_male.glb`);
    }
  }

  const torsoYawEntries = Object.entries(manifest.procedural.torso_yaw);
  const maxDeg = manifest.procedural.torso_yaw.max_deg ?? 45;
  const torsoYaw: TorsoYawRecipe = {
    weights: torsoYawEntries
      .filter(([bone]) => bone !== "max_deg")
      .map(([bone, weight]) => [sane(bone), weight] as const),
    maxRad: (maxDeg * Math.PI) / 180,
  };

  const heightM = gamePack.pawns.male?.height_m ?? 1.7525;
  const slugthrower: SlugthrowerAttachSpec = {
    mountPos: toVector3(slugthrowerAttach.mount_hand_r_local.pos),
    mountQuat: new Quaternion(...slugthrowerAttach.mount_hand_r_local.quat),
    sockets: {
      grip: toVector3(slugthrowerAttach.sockets.grip ?? [0, 0, 0]),
      foregrip: toVector3(slugthrowerAttach.sockets.foregrip ?? [0, 0, 0.25]),
      muzzle: toVector3(slugthrowerAttach.sockets.muzzle ?? [0, 0, 0.44]),
      stock: toVector3(slugthrowerAttach.sockets.stock ?? [0, 0, -0.41]),
    },
    nodes: slugthrowerAttach.nodes,
  };

  const vibrosword: VibroswordAttachSpec = {
    mountPos: toVector3(vibroswordAttach.mount_hand_r_local.pos),
    mountQuat: new Quaternion(...vibroswordAttach.mount_hand_r_local.quat),
    sockets: {
      guardPlane: toVector3(vibroswordAttach.sockets.guard_plane ?? [0, 0, 0]),
      wrapTop: toVector3(vibroswordAttach.sockets.wrap_top ?? [0, 0, -0.13]),
      wrapMid: toVector3(vibroswordAttach.sockets.wrap_mid ?? [0, 0, -0.24]),
      wrapBottom: toVector3(vibroswordAttach.sockets.wrap_bottom ?? [0, 0, -0.35]),
      pommel: toVector3(vibroswordAttach.sockets.pommel ?? [0, 0, -0.39]),
    },
    nodes: vibroswordAttach.nodes,
    stow: parseStowSocket(vibroswordAttach.stow_socket, SUCCESSOR_3D_CONFIG.pawnPack.swordStow.arcLift),
  };
  return {
    bodies: { male: maleGltf.scene, female: femaleGltf.scene },
    ...(bareMaleGltf ? { bareBodies: { male: bareMaleGltf.scene } } : {}),
    specialBodies,
    slugthrowerScene: slugthrowerGltf.scene,
    vibroswordScene: vibroswordGltf.scene,
    clips,
    clipMeta,
    masks,
    boneNames,
    torsoYaw,
    slugthrower,
    vibrosword,
    weapons,
    equipment,
    scale: SUCCESSOR_3D_CONFIG.pawnPack.heightTargetUnits / heightM,
  };
}

/** Clone a skinned pawn body for one actor instance (bones + skinned mesh rebind). */
export function clonePawnBody(pack: PawnPack, body: PawnBody, options: PawnBodyCloneOptions = {}): Group {
  const source = options.bare ? pack.bareBodies?.[body] ?? pack.bodies[body] : pack.bodies[body];
  const cloned = cloneSkeleton(source);
  const root = cloned instanceof Group ? cloned : new Group();
  if (cloned !== root) root.add(cloned);
  root.userData.successorPawnBody = body;
  return root;
}

/** Clone a non-player humanoid that is rig-compatible with the shared pack. */
export function cloneSpecialPawnBody(pack: PawnPack, key: string): Group | null {
  const source = pack.specialBodies.get(key)?.scene;
  if (!source) return null;
  const root = cloneSkeleton(source);
  if (root instanceof Group) return root;
  const group = new Group();
  group.add(root);
  return group;
}

function collectBoneNames(gltf: GLTF, out: Set<string>): void {
  gltf.scene.traverse((object) => {
    if (object instanceof Bone) out.add(sane(object.name));
  });
}
