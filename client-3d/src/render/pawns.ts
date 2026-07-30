// pawns.ts — animated PawnForgeV2 characters driven by shared Successor state.
//
// Replaces the capsule pawns: every visible actor is a SkeletonUtils clone of
// the cooked pawn_male/pawn_female body, animated by the layered compositor
// (render/anim/PawnAnimator) and armed with socket-welded weapons
// (render/weapons/slugthrowerRig, render/weapons/swordRig) when the server says it
// carries the matching weapon.
//
// State -> animation mapping (animation contract):
//   unarmed speed ~ 0              -> L0 idle
//   unarmed moving with facing     -> L0 walk_f / run_f (timeScale = speed / clip m/s)
//   unarmed moving against facing  -> L0 walk_b
//   rifle + rifle lane available   -> L0 rifle_idle / rifle_walk_f / rifle_run_f when not backpedaling
//                                      + L3 grip + Slugthrower socketed; NO persistent L1 rifle_aim on rifle-posed bases
//   rifle backpedal                -> L0 walk_b + L1 rifle_aim + L3 grip + Slugthrower socketed
//   rifle + rifle lane missing     -> legacy L0 idle/walk_f/run_f/walk_b + L1 rifle_aim + L3 grip
//   melee + melee lane available   -> L0 melee_idle / melee_walk_f / melee_run_f, walk_b/crouch fallback
//                                      + L1 melee_ready + L3 melee_grip + modeled melee weapon socketed
//   weaponFireAnimations[id] fire  -> L4 rifle_fire or swing_h1/swing_h2/swing_h3 cycle
//   weapon.reloadRemainingTicks>0  -> Slugthrower procedural reload choreography
//   combat visual "hit"            -> tiny procedural flinch from hit zone/direction
//   combat visual downed/killed    -> death_f / death_b (full mask, clampWhenFinished, held)
//   status "sleeping"              -> downed treatment + tinted blob shadow
//   lifeState "respawning"         -> not rendered (filtered by caller loop)
//
// Timing: hit/downed/killed montages consume the shared runtime's compact
// serverAuthority.visualLog. Fire montages consume weaponFireAnimations,
// while Roll-event tracers remain presentation-only in the 3D FX layer.
//
// Decisions (documented per assignment):
// - Faction/relation color: subtle body tint (lerp 0.3 into the matcap color)
//   PLUS a strong tint on the blob shadow — factions read at distance without
//   turning bodies into color blobs that fight the PS2 pass.
// - Rifle-capable weaponIds present with their catalog model; melee weaponIds
//   use their one-hand catalog model (or the legacy vibrosword). Unarmed keeps
//   the melee animation lane without inventing a visible weapon.
// - strafe_l/strafe_r are slim-sourced and rifle-posed but unmapped: the
//   protocol exposes no strafe intent yet. crouch_idle/crouch_walk are also
//   cooked but unmapped and remain non-rifle-posed.
// - NPC torso yaw is 0 (their body yaw already tracks aim/velocity); the
//   stationary local player holds body yaw inside a torso-yaw aim deadband.
import {
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  LoopOnce,
  CanvasTexture,
  Box3,
  Bone,
  Color,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshMatcapMaterial,
  PlaneGeometry,
  SkinnedMesh,
  Skeleton,
  SRGBColorSpace,
  Texture,
  Vector3,
  type Object3D,
  type Scene,
} from "three";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { actorNameplateColor } from "@successor/client/src/slice-core/actorRelationSystem";
import type {
  ActorSnapshot,
  PlayState,
  ServerAuthorityActorState,
  ServerAuthorityCombatEventState,
  SliceSnapshot,
} from "@successor/client/src/slice-core/gameState";
import { actorWorldPosition } from "@successor/client/src/slice-core/targetingSystem";
import { isMeleeWeaponPresentation } from "@successor/client/src/slice-core/weaponSystem";
import { SUCCESSOR_3D_CONFIG } from "../config";
import { requireRuntimePublicPath } from "@successor/client/src/slice-core/runtimePublicPaths";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { PlasmaBlade } from "./weapons/plasmaBlade";
import { makeGlowSprite } from "./fx/particles";
import {
  ensureEquipmentUv,
  equipmentSourceMaterialFromUserData,
  getEquipmentMaterialSets,
  resolveEquipmentSlotMaterial,
  stashEquipmentSourceMaterialIdentity,
  worldMaterialFor,
  type EquipmentSlotMaterialSource,
} from "../assets/equipmentMaterials";
import {
  clonePawnBody,
  cloneSpecialPawnBody,
  equipmentIdsCoverLegs,
  pawnEquipmentLookupFor,
  sane,
  type PawnBody,
  type PawnEquipmentItem,
  type PawnEquipmentLookup,
  type PawnPack,
} from "../assets/pawnPack";
import { weaponModelAssetKey } from "../assets/weaponModelRegistry";
import { resolveWieldPose } from "../ui/inventory/wieldPose";
import { writeCurrentCharacterAppearanceCache } from "../ui/appearanceCache";
import { installPawnRim } from "./pawnRim";
import { equipmentExclusivitySlot, resolveAuthoritativeActorEquipmentIds, authoritativeWornKey } from "./equipmentSlots";
import { attachPawnFaceDecal } from "./faceDecal";
import { MaskedClipCache } from "./anim/maskedClips";
import { PawnAnimator, type ActiveClipsByLayer, type MontageMaskMode } from "./anim/PawnAnimator";
import { SlugthrowerRig } from "./weapons/slugthrowerRig";
import { SwordRig } from "./weapons/swordRig";
import { markSunShadowCaster, SUN_SHADOW_CASTER_LAYER } from "./environment/sunShadow";
import { locomotionTimeScale } from "./pawnLocomotion";
import { resolvePawnYawTarget, yawForDirection } from "./pawnYaw";
import { enterableFloorYAt } from "./props";
export { resolvePawnYawTarget, yawForDirection } from "./pawnYaw";
export type { PawnYawTargetInput } from "./pawnYaw";

export type RenderActor = ActorSnapshot | ServerAuthorityActorState;

type BaseGait = "idle" | "walk_f" | "run_f" | "walk_b" | "kneel";

const UNARMED_BASE_CLIPS: Record<BaseGait, string> = {
  idle: "idle",
  walk_f: "walk_f",
  run_f: "run_f",
  walk_b: "walk_b",
  kneel: "kneel_loop",
};

const RIFLE_BASE_CLIPS: Record<BaseGait, string> = {
  idle: "rifle_idle",
  walk_f: "rifle_walk_f",
  run_f: "rifle_run_f",
  walk_b: "walk_b",
  kneel: "kneel_loop",
};

const RIFLE_BASE_CLIP_RIFLE_POSED: Record<BaseGait, boolean> = {
  idle: true,
  walk_f: true,
  run_f: true,
  walk_b: false,
  kneel: false,
};

const RIFLE_BASE_CLIP_NAMES: readonly string[] = [
  "rifle_idle",
  "rifle_walk_f",
  "rifle_run_f",
];

const MELEE_BASE_CLIPS: Record<BaseGait, string> = {
  idle: "melee_idle",
  walk_f: "melee_walk_f",
  run_f: "melee_run_f",
  walk_b: "walk_b",
  kneel: "kneel_loop",
};

const MELEE_BASE_CLIP_NAMES: readonly string[] = [
  "melee_idle",
  "melee_walk_f",
  "melee_run_f",
];

/** Plasma sword inventory item (equips as vibrosword; look is presentation). */
const PLASMA_SWORD_ITEM_ID = 3104;
const PLASMA_SWORD_COLOR = 0x63f0ff;
/** Ignition ramp: full blade in ~0.13s, retract slightly faster (~0.10s). */
const PLASMA_IGNITE_PER_SECOND = 1 / 0.13;
const PLASMA_RETRACT_PER_SECOND = 1 / 0.1;

const RIFLE_AIM_UPPER_CLIP = "rifle_aim";
const GUN_GRIP_HAND_CLIP = "gun_grip_trigger_discipline";
const MELEE_READY_UPPER_CLIP = "melee_ready";
const MELEE_GRIP_HAND_CLIP = "melee_grip";
const MELEE_FLINCH_MONTAGE_CLIP = "melee_flinch";
const MELEE_SWING_MONTAGES: readonly ["swing_h1", "swing_h2", "swing_h3"] = ["swing_h1", "swing_h2", "swing_h3"];
const MELEE_DRAW_MONTAGE_CLIP = "melee_draw";
const MELEE_SHEATH_MONTAGE_CLIP = "melee_sheath";
const MELEE_TRANSITION_MOVING_MAX_SECONDS = 0.45;
const MELEE_SPIN_AOE_MONTAGE_CLIP = "swing_spin_aoe";
/** Micro mouse jitter below this angle never rotates the body (torso covers it). */
const AIM_YAW_JITTER_DEADZONE_RAD = 0.04;
const LOCOMOTION_IDLE_START_SPEED_CELLS_PER_SECOND = 0.12;
const LOCOMOTION_IDLE_STOP_SPEED_CELLS_PER_SECOND = 0.035;

function isMeleeSwingMontageClip(clipName: string | null): boolean {
  return clipName === "swing_h1"
    || clipName === "swing_h2"
    || clipName === "swing_h3"
    || clipName === MELEE_SPIN_AOE_MONTAGE_CLIP;
}

function meleeSwingMaskMode(moving: boolean): MontageMaskMode {
  return moving ? "clip" : "full";
}
const WALK_RUN_HYSTERESIS_CELLS_PER_SECOND = 0.12;

let warnedMissingRifleBaseClips = false;
let warnedMissingMeleeBaseClips = false;

export function resolveRifleBaseLaneAvailable(pack: PawnPack): boolean {
  let available = true;
  let missing = "";
  for (let i = 0; i < RIFLE_BASE_CLIP_NAMES.length; i += 1) {
    const clipName = RIFLE_BASE_CLIP_NAMES[i]!;
    if (pack.clips.has(clipName)) continue;
    available = false;
    missing = missing.length === 0 ? clipName : `${missing}, ${clipName}`;
  }
  if (!available && !warnedMissingRifleBaseClips) {
    warnedMissingRifleBaseClips = true;
    console.warn(
      `pawn pack: missing rifle base locomotion clips (${missing}); armed pawns fall back to idle/walk_f/run_f/walk_b + rifle_aim upper layer`,
    );
  }
  return available;
}

type WeaponLane = "none" | "rifle" | "melee";
type MeleeWeaponPose = "unarmed" | "stowed" | "held";

export function resolveMeleeBaseLaneAvailable(pack: PawnPack): boolean {
  let available = true;
  let missing = "";
  for (let i = 0; i < MELEE_BASE_CLIP_NAMES.length; i += 1) {
    const clipName = MELEE_BASE_CLIP_NAMES[i]!;
    if (pack.clips.has(clipName)) continue;
    available = false;
    missing = missing.length === 0 ? clipName : `${missing}, ${clipName}`;
  }
  if (!available && !warnedMissingMeleeBaseClips) {
    warnedMissingMeleeBaseClips = true;
    console.warn(
      `pawn pack: missing melee base locomotion clips (${missing}); vibrosword pawns fall back to idle/walk_f/run_f/walk_b + melee overlays`,
    );
  }
  return available;
}

interface VisualBase {
  group: Group;
  shadow: Mesh<PlaneGeometry, MeshBasicMaterial>;
  yaw: number;
  lastX: number;
  lastZ: number;
  lastSeenFrame: number;
  colorKey: string;
  deathState: "none" | "down";
  /** Actor was already down when this visual was created (join-in-progress). */
  bornDown: boolean;
  /** Seconds spent waiting for the combat-impact visual event before falling. */
  deathGraceElapsed: number;
  /** stimpak_* status count last frame; -1 = unseeded (join-in-progress guard). */
  lastStimCount: number;
  /** Max stimpak_* remainingMs last frame — a jump UP = refresh re-application. */
  lastStimMaxRemainingMs: number;
  /** DEV pose preview: forces this base clip until toggled off (poseTest). */
  poseBaseOverride: string | null;
  sleeping: boolean;
  lastLifecycleSeq: number;
  pendingHit: PendingHitFlinch | null;
  pendingDeathYaw: number | null;
  pendingDeathKind: "downed" | "killed" | null;
  /** Current LOD tier latch (true = HI-FI, mixer+IK active; false = SIM). */
  lodHiFi: boolean;
}

interface PendingHitFlinch {
  yaw: number | null;
  zone: string;
  magnitude: number;
}

interface EquipmentAppearanceSnapshot {
  hairId: string | null;
  hairMaterialId: string | null;
  face: readonly string[] | null;
  worn: readonly { item: string; colors: readonly string[] }[] | null;
}

export interface PawnFacePaintDebug {
  attached: true;
  ready: boolean;
  signature: string;
}

function sameStringArray(left: readonly string[] | null, right: readonly string[] | null): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function sameWornSnapshot(
  snapshot: EquipmentAppearanceSnapshot["worn"],
  worn: ActorWornState | null,
): boolean {
  return authoritativeWornKey(snapshot) === authoritativeWornKey(worn);
}

function equipmentAppearanceChanged(
  snapshot: EquipmentAppearanceSnapshot | null,
  actor: RenderActor,
): boolean {
  if (!snapshot) return true;
  const appearance = actorAppearance(actor);
  if (snapshot.hairId !== normalizedServerHairId(appearance)
    || snapshot.hairMaterialId !== normalizedHairMaterialId(appearance)) return true;
  const face = appearance?.face;
  if (face) {
    if (!snapshot.face
      || snapshot.face[0] !== face.eyes
      || snapshot.face[1] !== face.brows
      || snapshot.face[2] !== face.nose
      || snapshot.face[3] !== face.mouth
      || snapshot.face[4] !== face.eye_color
      || snapshot.face[5] !== face.brow_color
      || snapshot.face[6] !== face.lip_color) return true;
  } else if (snapshot.face) {
    return true;
  }
  return !sameWornSnapshot(snapshot.worn, actorWorn(actor));
}

interface PawnVisual extends VisualBase {
  kind: "pawn";
  bodyRoot: Group;
  body: PawnBody;
  /** True when resolved equipment covers the legs and needs the accommodated body. */
  legsCovered: boolean;
  /** Non-player authored body using the shared 50-bone animation contract. */
  specialBodyKey: string | null;
  animator: PawnAnimator;
  slugthrower: SlugthrowerRig | null;
  sword: SwordRig | null;
  /** Live plasma-sword presentation (weaponItemId 3104). */
  plasma: { blade: PlasmaBlade; hilt: Object3D | null; extension: number; targetExtension: number; debugDrawnOverride: boolean | null } | null;
  skinnedMeshes: SkinnedMesh[];
  equipmentAttachments: Object3D[];
  equipmentMaterialGeneration: number;
  /** Resolved ids are rebuilt only when gear or authority appearance changes. */
  resolvedEquipmentIds: string[];
  equipmentAppearance: EquipmentAppearanceSnapshot | null;
  hairMaterialId: string | null;
  /** item id -> zone colors from the actor's worn set (palette application). */
  wornColorsByPiece: Map<string, readonly string[]> | null;
  frameOffset: number;
  accumulatedDt: number;
  armed: boolean;
  weaponLane: WeaponLane;
  /** Weapon model asset key (null = default Slugthrower model). */
  weaponAssetKey: string | null;
  meleeWeaponPose: MeleeWeaponPose | null;
  gait: BaseGait;
  locomotionMoving: boolean;
  baseLaneRifle: boolean;
  baseLaneMelee: boolean;
  baseRiflePosed: boolean;
  holdUpperClip: string | null;
  lastFireStartMs: number;
  lastMeleeAttackEventId: number;
  pendingMeleeSwingEventId: number | null;
  pendingMeleeFlinchEventId: number | null;
  meleeSwingIndex: number;
  hitFlinchElapsed: number;
  hitFlinchDuration: number;
  hitFlinchYaw: number;
  hitFlinchMagnitude: number;
  hitFlinchZone: string;
}

/**
 * Rigged Gaia creature visual (bellback / pebblehorn / snufflefin /
 * pocketclod / mossmuff / dapplepod adults). A SkeletonUtils clone of the
 * per-species GLB template driven by an AnimationMixer: the `idle` and
 * `walk` loops cross-fade from movement, and on death the one-shot `rest`
 * clip plays into its authored downed plateau and freezes there (cozy corpse
 * read; the reversible clip's final frames stand back up).
 * The group+shadow exist immediately and the mesh attaches lazily once the
 * async per-species GLB resolves.
 * Species routing is the exact actor `sprite` key; harvest and targeting
 * stay on the server identity (render-only lane).
 */
interface CreatureVisual extends VisualBase {
  kind: "creature";
  /** Exact sprite key — resolves the shared species template. */
  spriteKey: string;
  /** Registry entry (asset path, mesh scale, shadow footprint). */
  species: CreatureSpeciesDef;
  /** Server-provided per-actor scale (slice `scale`; 1 when absent). */
  visualScale: number;
  /** Lazily attached once the species GLB template resolves. */
  skinnedRoot: Object3D | null;
  mixer: AnimationMixer | null;
  idleAction: AnimationAction | null;
  walkAction: AnimationAction | null;
  /** LoopOnce settle clip played into its downed hold; null until mesh attach. */
  restAction: AnimationAction | null;
  /** Clip currently faded in ("" until the mesh attaches). */
  activeClip: CreatureClipName | "";
  moving: boolean;
}

/** Shared per-species GLB template: scene + clips + converted materials. */
interface CreatureTemplate {
  root: Object3D;
  idleClip: AnimationClip | null;
  walkClip: AnimationClip | null;
  restClip: AnimationClip | null;
  /** Unlit conversions, ONE per authored source material (each keeps its own
   *  BaseColor map, neutral white multiplier); disposed with the renderer. */
  materials: MeshMatcapMaterial[];
}

type ActorVisual = PawnVisual | CreatureVisual;

interface ShellMeshCache {
  meshes: SkinnedMesh[];
  generation: number;
}

const shadowGeometry = new PlaneGeometry(
  SUCCESSOR_3D_CONFIG.pawn.shadowWidth,
  SUCCESSOR_3D_CONFIG.pawn.shadowDepth,
);
const scratchColor = new Color();
const scratchMuzzle = new Vector3();
const reloadScratch = { elapsedS: 0, totalS: 0 };
// --- Gaia creature lane: rigged cozy-creature GLB renderer ---
// Actor `sprite` values below route an actor to the rigged 3D creature
// renderer. The registry is presentation-only:
// harvest, targeting, and identity stay server-authoritative.
export interface CreatureSpeciesDef {
  /** Species token (matches the GLB/asset family name). */
  readonly speciesId: string;
  /** Adult GLB served from client-3d/public. */
  readonly assetPath: string;
  /** Uniform mesh scale on top of the authored world-scale bake. */
  readonly meshScale: number;
  /** Ground-shadow ellipse scale (× the shared 0.95×0.62 shadow quad),
   *  sized from each GLB's measured rest-pose bounds (x/z extents). */
  readonly shadowScaleX: number;
  readonly shadowScaleZ: number;
}

/** Exact sprite key -> species (the only creature routing table).
 *  Measured GLB bounds (x × height × z, metres) noted per entry. */
export const CREATURE_SPECIES_BY_SPRITE: Readonly<Record<string, CreatureSpeciesDef>> = {
  // Desert: bellback 0.56×1.52×1.61
  "creature-bellback-adult": { speciesId: "bellback", assetPath: "/assets/creatures/bellback_adult.glb", meshScale: 1, shadowScaleX: 0.5, shadowScaleZ: 2.2 },
  // Desert: pebblehorn 1.62×0.97×0.87 (wide lateral horn spread)
  "creature-pebblehorn-adult": { speciesId: "pebblehorn", assetPath: "/assets/creatures/pebblehorn_adult.glb", meshScale: 1, shadowScaleX: 1.45, shadowScaleZ: 1.19 },
  // Desert: snufflefin 0.27×0.39×1.00, authored tiny — ×2.4 ≈ 0.94m tall
  // overworld mob read (X floored pre-scale so the ellipse reads).
  "creature-snufflefin-adult": { speciesId: "snufflefin", assetPath: "/assets/creatures/snufflefin_adult.glb", meshScale: 2.4, shadowScaleX: 0.72, shadowScaleZ: 3.29 },
  // Desert: pocketclod 0.71×0.65×0.47 — ×1.5 ≈ 0.98m tall
  "creature-pocketclod-adult": { speciesId: "pocketclod", assetPath: "/assets/creatures/pocketclod_adult.glb", meshScale: 1.5, shadowScaleX: 0.95, shadowScaleZ: 0.96 },
  // Verdance: mossmuff 2.05×1.37×1.14
  "creature-mossmuff-adult": { speciesId: "mossmuff", assetPath: "/assets/creatures/mossmuff_adult.glb", meshScale: 1, shadowScaleX: 1.84, shadowScaleZ: 1.56 },
  // Verdance: dapplepod 0.58×0.76×1.01 — ×1.3 ≈ 0.99m tall
  "creature-dapplepod-adult": { speciesId: "dapplepod", assetPath: "/assets/creatures/dapplepod_adult.glb", meshScale: 1.3, shadowScaleX: 0.68, shadowScaleZ: 1.81 },
};

function creatureSpeciesForActor(actor: RenderActor): CreatureSpeciesDef | null {
  const sprite = "sprite" in actor && typeof actor.sprite === "string" ? actor.sprite : "";
  return CREATURE_SPECIES_BY_SPRITE[sprite] ?? null;
}

const CREATURE_IDLE_CLIP = "idle";
const CREATURE_WALK_CLIP = "walk";
const CREATURE_REST_CLIP = "rest";
/** Cross-fade between the idle/walk/rest actions (clean clip switching). */
const CREATURE_CLIP_FADE_SECONDS = 0.18;
/** Measured inside the stable downed-pose plateau shared by all six rest clips. */
const CREATURE_REST_HOLD_FRACTION = 0.75;
// Walk clip plays ~1.0x per cell/s of true speed so a wandering creature
// (≈0.6 cells/s) loops slowly; clamped so slow authority drift doesn't
// moonwalk and far bursts don't strobe.
const CREATURE_WALK_TIMESCALE_PER_CELLPERSEC = 1.0;
const CREATURE_WALK_TIMESCALE_MIN = 0.5;
const CREATURE_WALK_TIMESCALE_MAX = 1.6;

export type CreatureClipName = "idle" | "walk" | "rest";

export interface CreatureAnimIntent {
  clip: CreatureClipName;
  /** Playback rate for the walk loop (1 for idle/rest). */
  timeScale: number;
  /** Rest pose snaps straight to its downed hold (join-in-progress corpse). */
  snapToHold: boolean;
}

export interface CreatureRestPlaybackStep {
  holdTimeSeconds: number;
  nextTimeSeconds: number;
  advanceSeconds: number;
  shouldPause: boolean;
}

/**
 * Keep reversible `rest` clips inside their authored downed plateau instead of
 * letting their final get-up frames stand a corpse back on its feet.
 */
export function resolveCreatureRestPlayback(input: {
  clipDurationSeconds: number;
  currentTimeSeconds: number;
  dtSeconds: number;
  snapToHold: boolean;
}): CreatureRestPlaybackStep {
  const duration = Number.isFinite(input.clipDurationSeconds) ? Math.max(0, input.clipDurationSeconds) : 0;
  const holdTimeSeconds = duration * CREATURE_REST_HOLD_FRACTION;
  const current = Number.isFinite(input.currentTimeSeconds)
    ? Math.min(holdTimeSeconds, Math.max(0, input.currentTimeSeconds))
    : 0;
  const dtSeconds = Number.isFinite(input.dtSeconds) ? Math.max(0, input.dtSeconds) : 0;
  const nextTimeSeconds = input.snapToHold
    ? holdTimeSeconds
    : Math.min(holdTimeSeconds, current + dtSeconds);
  return {
    holdTimeSeconds,
    nextTimeSeconds,
    advanceSeconds: input.snapToHold ? 0 : Math.max(0, nextTimeSeconds - current),
    shouldPause: input.snapToHold || nextTimeSeconds >= holdTimeSeconds,
  };
}

/**
 * Pure state->clip mapping for the creature lane: alive+still = idle loop,
 * alive+moving = walk loop scaled by speed, downed/dead = one-shot `rest`
 * frozen inside its downed plateau. Born-down corpses (join-in-progress)
 * skip the settle playback and hold that frame immediately.
 */
export function resolveCreatureAnimIntent(input: {
  down: boolean;
  bornDown: boolean;
  moving: boolean;
  speedCellsPerSec: number;
}): CreatureAnimIntent {
  if (input.down) return { clip: "rest", timeScale: 1, snapToHold: input.bornDown };
  if (!input.moving) return { clip: "idle", timeScale: 1, snapToHold: false };
  const timeScale = Math.min(
    CREATURE_WALK_TIMESCALE_MAX,
    Math.max(CREATURE_WALK_TIMESCALE_MIN, input.speedCellsPerSec * CREATURE_WALK_TIMESCALE_PER_CELLPERSEC),
  );
  return { clip: "walk", timeScale, snapToHold: false };
}

export function createPawnMatcapTexture(): Texture {
  // Matcap tuned for the LOCKED steep iso camera: with a 60° pitch the visible
  // surfaces of a standing pawn have normals nearly perpendicular to the view,
  // which sample the OUTER RING of the matcap — so the ring must stay light or
  // every body renders near-black (found the hard way). Wide bright center,
  // top-lit bias, gentle rim falloff ≈ PS2 flat shading with a hint of form.
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const gradient = ctx.createRadialGradient(size * 0.5, size * 0.3, size * 0.05, size * 0.5, size * 0.42, size * 0.72);
    gradient.addColorStop(0, "#ffffff");
    gradient.addColorStop(0.45, "#dde0e3");
    gradient.addColorStop(0.8, "#b2b6bc");
    gradient.addColorStop(1, "#84888f");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/**
 * Soft elliptical ground-contact shadow, consumed as alphaMap (three.js samples
 * the GREEN channel): white core -> black edge = opaque center fading to nothing.
 * Kills the hard "dark rectangle" read of the bare shadow quad.
 */
function createShadowAlphaTexture(): CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, size * 0.08, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, "#ffffff");
    gradient.addColorStop(0.55, "#8c8c8c");
    gradient.addColorStop(1, "#000000");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  return new CanvasTexture(canvas);
}

const shadowAlphaTexture = createShadowAlphaTexture();

function wrapAngle(value: number): number {
  let angle = value % (Math.PI * 2);
  if (angle > Math.PI) angle -= Math.PI * 2;
  if (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

function attackYaw(event: ServerAuthorityCombatEventState): number | null {
  const origin = event.originPoint;
  const hit = event.hitPoint;
  if (!origin || !hit) return null;
  const dx = hit.x - origin.x;
  const dz = hit.y - origin.y;
  if (dx * dx + dz * dz < 1e-6) return null;
  return Math.atan2(dx, dz);
}

function flinchZoneScale(zone: string): number {
  switch (zone) {
    case "head":
      return 1.2;
    case "left_arm":
    case "right_arm":
      return 0.85;
    case "legs":
      return 0.7;
    case "torso":
    default:
      return 1;
  }
}

function hashId(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

type ActorAppearanceState = NonNullable<ServerAuthorityActorState["appearance"]>;
type ActorWornState = NonNullable<ServerAuthorityActorState["worn"]>;

const defaultSkinColor = "#cc9978";
const skinTonePattern = /^#[0-9a-f]{6}$/iu;
// Hair STYLE ids and hair COLOR (material) ids share the pawn-pack `hair_<token>`
// shape. Shape check only — the caller confirms a matching GLB exists in the pack
// before attaching, so new hairs (WardrobeCreator lane) render with no allow-list edit.
const hairIdentifierPattern = /^hair_[a-z0-9_]{1,64}$/u;

function actorAppearance(actor: RenderActor): ActorAppearanceState | null {
  return "appearance" in actor && actor.appearance ? actor.appearance : null;
}

/** Worn set from the authority wire; an empty array is meaningful for players. */
function actorWorn(actor: RenderActor): ActorWornState | null {
  if (!("worn" in actor) || !Array.isArray(actor.worn)) return null;
  return actor.worn;
}

export function isPlayerRoleActor(actor: RenderActor): boolean {
  return "role" in actor && actor.role === "player";
}

function normalizedSkinTone(appearance: ActorAppearanceState | null): string {
  const skin = typeof appearance?.skin === "string" ? appearance.skin.trim().toLowerCase() : "";
  return skinTonePattern.test(skin) ? skin : defaultSkinColor;
}

function normalizedServerHairId(appearance: ActorAppearanceState | null): string | null {
  const hair = typeof appearance?.hair === "string" ? appearance.hair : null;
  return hair && hairIdentifierPattern.test(hair) ? hair : null;
}

function normalizedHairMaterialId(appearance: ActorAppearanceState | null): string | null {
  const hairMat = typeof appearance?.hair_mat === "string" ? appearance.hair_mat.trim() : "";
  return hairIdentifierPattern.test(hairMat) ? hairMat : null;
}


function isHairEquipment(itemId: string): boolean {
  return itemId.startsWith("hair_");
}

function slotColorProofEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("slotColorProof") === "1";
}


export type PawnEquipmentMaterialResolver = (item: PawnEquipmentItem, source: EquipmentSlotMaterialSource) => Material | Material[];

export function attachPawnEquipmentSet(
  pack: PawnPack,
  bodyRoot: Group,
  itemIds: readonly string[],
  resolveMaterial: PawnEquipmentMaterialResolver,
  attachedOut?: Object3D[],
): void {
  if (itemIds.length === 0 || pack.equipment.items.length === 0) return;
  const requested = new Set<string>();
  for (let i = 0; i < itemIds.length; i += 1) {
    addEquipmentWithRequirements(pack, itemIds[i]!, requested);
  }
  if (requested.size === 0) return;
  // Slot-exclusive AFTER requirement expansion. Appearance hair has its own
  // pseudo-slot, so helmets and hats never erase the character's saved hair.
  const winnerBySlot = new Map<string, string>();
  for (const itemId of requested) {
    winnerBySlot.set(equipmentExclusivitySlot(pack.equipment.items, itemId), itemId);
  }
  const winners = new Set(winnerBySlot.values());
  for (const itemId of [...requested]) {
    if (!winners.has(itemId)) requested.delete(itemId);
  }
  // Requirement integrity: a slot winner may have evicted another item's
  // required base (nape requires ITS harness; a different harness won the
  // slot). Drop dependents whose requires are gone — iterate for chains.
  let dropped = true;
  while (dropped) {
    dropped = false;
    for (const itemId of [...requested]) {
      const item = pack.equipment.items.find((candidate) => candidate.id === itemId);
      if (item && item.requires.some((req) => !requested.has(req))) {
        requested.delete(itemId);
        dropped = true;
      }
    }
  }
  if (requested.size === 0) return;

  const liveBones = new Map<string, Bone>();
  bodyRoot.traverse((object) => {
    if (object instanceof Bone) {
      liveBones.set(object.name.toLowerCase(), object);
      liveBones.set(sane(object.name).toLowerCase(), object);
    }
  });

  for (const item of pack.equipment.items) {
    if (requested.has(item.id)) attachEquipmentItemToBody(pack, bodyRoot, item, liveBones, resolveMaterial, attachedOut);
  }
}

function addEquipmentWithRequirements(pack: PawnPack, itemId: string, out: Set<string>): void {
  if (out.has(itemId)) return;
  const item = pack.equipment.items.find((candidate) => candidate.id === itemId);
  if (!item) return;
  for (let i = 0; i < item.requires.length; i += 1) {
    addEquipmentWithRequirements(pack, item.requires[i]!, out);
  }
  out.add(item.id);
}

/** Unlit conversions for rigid authority accessories, shared across every
 * clone (module lifetime, same policy as the world-prop conversions in
 * camps/crops/extractors): native map+color survive so the piece reads in
 * the zero-light pawn scene. Never disposed per attach. */
const unlitRigidEquipmentMaterials = new WeakMap<Material, MeshBasicMaterial>();

function unlitRigidEquipmentMaterial(source: Material): MeshBasicMaterial {
  const cached = unlitRigidEquipmentMaterials.get(source);
  if (cached) return cached;
  const material = new MeshBasicMaterial({ fog: true });
  if ("map" in source && source.map instanceof Texture) {
    source.map.colorSpace = SRGBColorSpace;
    material.map = source.map;
  }
  if ("color" in source && source.color instanceof Color) {
    material.color.copy(source.color);
  }
  material.name = source.name ? `${source.name}:successor-basic` : "successor-basic-equipment";
  unlitRigidEquipmentMaterials.set(source, material);
  return material;
}

const scratchRigidScale = new Vector3();

/** Rigid ORIGIN-authored accessory (authority-owned bake, e.g. the 7203 field
 * cap): the FULL multi-mesh GLB hierarchy clones onto its anchor bone at
 * identity — the AssetViewer.attachAccessoryToBone SNAP convention — with the
 * bone chain's inherited world scale cancelled so the piece keeps its authored
 * metric size. Fails closed: no anchor bone on the live skeleton → nothing
 * attaches. The returned/marked root is the cleanup handle (attachedOut). */
function attachRigidEquipmentItem(
  source: Group,
  item: PawnEquipmentItem,
  anchorBone: string,
  liveBones: ReadonlyMap<string, Bone>,
  attachedOut?: Object3D[],
): void {
  const bone = liveBones.get(anchorBone.toLowerCase()) ?? liveBones.get(sane(anchorBone).toLowerCase());
  if (!bone) {
    console.warn(`pawn equipment: rigid anchor bone "${anchorBone}" missing for "${item.id}" — not attached`);
    return;
  }
  // clone(true) keeps the whole node tree AND per-node userData/metadata.
  const root = source.clone(true);
  root.name = `equipment:${item.id}`;
  root.userData.successorEquipmentItemId = item.id;
  root.userData.successorEquipmentLayer = item.layer;
  root.userData.successorOwnedEquipmentAttachment = true;
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.material = Array.isArray(object.material)
      ? object.material.map(unlitRigidEquipmentMaterial)
      : unlitRigidEquipmentMaterial(object.material);
    object.castShadow = false;
    object.frustumCulled = false;
  });
  // SNAP: accessory origin rides the bone directly at identity, then undo the
  // bone chain's inherited world scale (pack bodies carry a uniform scale).
  bone.add(root);
  root.position.set(0, 0, 0);
  root.rotation.set(0, 0, 0);
  bone.updateWorldMatrix(true, false);
  const worldScale = bone.getWorldScale(scratchRigidScale).x || 1;
  root.scale.setScalar(1 / worldScale);
  root.updateMatrixWorld(true);
  attachedOut?.push(root);
}

function attachEquipmentItemToBody(
  pack: PawnPack,
  bodyRoot: Group,
  item: PawnEquipmentItem,
  liveBones: ReadonlyMap<string, Bone>,
  resolveMaterial: PawnEquipmentMaterialResolver,
  attachedOut?: Object3D[],
): void {
  const source = pack.equipment.scenes.get(item.id);
  if (!source) return;
  if (item.rigidAnchorBone) {
    attachRigidEquipmentItem(source, item, item.rigidAnchorBone, liveBones, attachedOut);
    return;
  }
  const root = source.clone(true);
  const meshes: SkinnedMesh[] = [];
  root.traverse((object) => {
    if (object instanceof SkinnedMesh) meshes.push(object);
  });
  for (const mesh of meshes) {
    const bones: Bone[] = [];
    let missingBone = false;
    for (const sourceBone of mesh.skeleton.bones) {
      const liveBone = liveBones.get(sourceBone.name.toLowerCase())
        ?? liveBones.get(sane(sourceBone.name).toLowerCase());
      if (!liveBone) {
        missingBone = true;
        break;
      }
      bones.push(liveBone);
    }
    if (missingBone || bones.length === 0) continue;
    const skeleton = new Skeleton(bones, mesh.skeleton.boneInverses.map((inverse) => inverse.clone()));
    ensureEquipmentUv(mesh, item.layer);
    const sourceMaterial = mesh.material;
    stashEquipmentSourceMaterialIdentity(mesh, sourceMaterial);
    mesh.material = resolveMaterial(item, sourceMaterial);
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    mesh.userData.successorEquipmentItemId = item.id;
    mesh.userData.successorEquipmentLayer = item.layer;
    mesh.name = `equipment:${item.id}:${mesh.name || "mesh"}`;
    bodyRoot.add(mesh);
    mesh.bind(skeleton, mesh.bindMatrix.clone());
    attachedOut?.push(mesh);
  }
}

// Live LOD A/B dial (window.__successor3dLod): when non-null, overrides
// config pawn.lod.hiFiRadiusCells so the gating boundary can move at runtime
// for before/after fps measurement without a recompile. null = config value.
let lodHiFiRadiusOverride: number | null = null;
export function setLodHiFiRadiusOverride(cells: number | null): void {
  lodHiFiRadiusOverride = cells;
}
export function getLodHiFiRadiusOverride(): number | null {
  return lodHiFiRadiusOverride;
}

/** Exact actor sprite -> authored humanoid pack body. These are NPC-only
 * bodies; they never become selectable character-creation appearances. */
export const SPECIAL_HUMANOID_BODY_BY_SPRITE: Readonly<Record<string, string>> = {
  "droid-grok-humanoid": "droid_grok_humanoid",
};

function spriteForActor(actorId: string, actor: RenderActor, slice: SliceSnapshot): string | null {
  if ("sprite" in actor && typeof actor.sprite === "string" && actor.sprite.length > 0) return actor.sprite;
  for (const sliceActor of slice.actors) {
    if (sliceActor.id === actorId) return sliceActor.sprite;
  }
  return null;
}

export function specialPawnBodyKeyForActor(actorId: string, actor: RenderActor, slice: SliceSnapshot): string | null {
  const sprite = spriteForActor(actorId, actor, slice);
  return sprite ? SPECIAL_HUMANOID_BODY_BY_SPRITE[sprite] ?? null : null;
}

export function pawnBodyForActor(actorId: string, actor: RenderActor, slice: SliceSnapshot): PawnBody {
  const sprite = spriteForActor(actorId, actor, slice);
  if (sprite) return sprite.includes("female") ? "female" : "male";
  return hashId(actorId) % 4 === 0 ? "female" : "male";
}

export function defaultRemotePawnEquipmentIds(pack: PawnPack, actorId: string, actor: RenderActor): string[] {
  const lookup = pawnEquipmentLookupFor(pack.equipment);
  if (lookup.itemIds.length === 0) return [];

  const ids: string[] = [];
  const pushIfAvailable = (itemId: string): void => {
    if (lookup.itemById.has(itemId)) ids.push(itemId);
  };
  pushIfAvailable("under_tank");
  pushIfAvailable("under_shorts");

  const defaultHarness = slotColorProofEnabled() && lookup.itemById.has("armor_slot_test")
    ? "armor_slot_test"
    : "armor_harness";
  pushIfAvailable(defaultHarness);
  pushIfAvailable("armor_nape_reinforcement");
  pushIfAvailable("armor_reinforcement");
  pushIfAvailable("armor_gorget");
  pushIfAvailable("armor_bicep_l");
  pushIfAvailable("armor_bicep_r");

  const appearance = actorAppearance(actor);
  const serverHair = normalizedServerHairId(appearance);
  if (serverHair && lookup.itemById.has(serverHair)) {
    ids.push(serverHair);
  } else {
    const hasHat = lookup.itemById.has("hat_warm");
    const headCount = lookup.helmetIds.length + (hasHat ? 1 : 0);
    if (headCount > 0) {
      const role = "role" in actor && typeof actor.role === "string" ? actor.role : "";
      let preferredPlayerHelmet = -1;
      if (role === "player") {
        for (let i = 0; i < lookup.helmetIds.length; i += 1) {
          if (lookup.helmetIds[i] === "helmet_s3") {
            preferredPlayerHelmet = i;
            break;
          }
        }
      }
      const headIndex = preferredPlayerHelmet >= 0
        ? preferredPlayerHelmet
        : hashId(actorId) % headCount;
      ids.push(headIndex < lookup.helmetIds.length ? lookup.helmetIds[headIndex]! : "hat_warm");
    }
  }
  return ids;
}
/** On-demand grounding evidence for one rendered actor (debug probe). */
export interface PawnGroundingDebug {
  actorId: string;
  /** Rendered root (group) position — X/Z are cell-center world units. */
  rootPosition: { x: number; y: number; z: number };
  /** World-space minimum Y of the body meshes (feet); null until the async body attaches. */
  bodyMinY: number | null;
  bodyBounds: {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  } | null;
  /** World Y of the blob-shadow plane under the pawn. */
  shadowPlaneY: number;
}

export class PawnRenderer {
  private readonly visuals = new Map<string, ActorVisual>();
  private readonly shellMeshCache = new Map<string, ShellMeshCache>();
  private readonly bodyMaterials = new Map<string, MeshMatcapMaterial>();
  private readonly shadowMaterials = new Map<string, MeshBasicMaterial>();
  private readonly specialBodyMaterials: Material[] = [];
  private readonly maskedClips = new MaskedClipCache();
  private readonly matcap: Texture;
  private frame = 0;
  private lodHiFiCount = 0;
  private lodSimCount = 0;
  private visualEventCursor: number | null = null;
  private combatEventCursor: number | null = null;
  /** Per-species Gaia creature GLB templates (scene + idle/walk/rest clips
   *  + converted materials), loaded lazily on first sighting of a sprite and
   *  shared across every clone of that species. Each authored source
   *  material is converted separately so its own embedded BaseColor map
   *  survives the unlit matcap path with a neutral white multiplier — no
   *  species tint, no cross-mesh texture reuse. */
  private readonly creatureTemplates = new Map<string, CreatureTemplate>();
  private readonly creatureTemplatesLoading = new Set<string>();
  private readonly glowSpriteTexture = makeGlowSprite();
  private plasmaPreview: PlasmaBlade | null = null;
  private plasmaHiltScene: Group | null = null;
  private plasmaHiltInstance: Object3D | null = null;
  private plasmaHiltLoading = false;
  private plasmaHostSword: SwordRig | null = null;
  private plasmaPreviewColorIdx = 0;
  private readonly rifleBaseLaneAvailable: boolean;
  private readonly meleeBaseLaneAvailable: boolean;
  private readonly equipmentLookup: PawnEquipmentLookup;
  constructor(private readonly scene: Scene, private readonly pack: PawnPack) {
    this.equipmentLookup = pack.equipment.lookup ?? pawnEquipmentLookupFor(pack.equipment);
    this.rifleBaseLaneAvailable = resolveRifleBaseLaneAvailable(pack);
    this.meleeBaseLaneAvailable = resolveMeleeBaseLaneAvailable(pack);
    this.matcap = createPawnMatcapTexture();
    // The Slugthrower GLB ships lit PBR materials but the scene is unlit: convert
    // the SHARED slugthrower scene materials to matcap once; per-pawn clones
    // inherit them.
    this.pack.slugthrowerScene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const source = object.material instanceof Material ? object.material : null;
      const map = source && "map" in source && source.map instanceof Texture ? source.map : null;
      const converted = new MeshMatcapMaterial({ matcap: this.matcap, map });
      installPawnRim(converted);
      object.material = converted;
    });
    this.pack.vibroswordScene.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const source = object.material instanceof Material ? object.material : null;
      const map = source && "map" in source && source.map instanceof Texture ? source.map : null;
      const converted = new MeshMatcapMaterial({ matcap: this.matcap, map });
      installPawnRim(converted);
      object.material = converted;
    });
    // Weapon registry scenes: matcap x map survival like the Slugthrower, but
    // color-preserving — untextured zones keep their authored base color and
    // emissive parts (e.g. the lightning carbine's storm arcs) render unlit in
    // their authored emissive color instead of collapsing to white matcap.
    for (const model of this.pack.weapons.values()) {
      const convertedBySource = new Map<Material, Material>();
      const convertWeaponMaterial = (source: Material): Material => {
        const existing = convertedBySource.get(source);
        if (existing) return existing;
        const map = "map" in source && source.map instanceof Texture ? source.map : null;
        if (map) map.colorSpace = SRGBColorSpace;
        const baseColor = "color" in source && source.color instanceof Color
          ? source.color.clone()
          : new Color(0xffffff);
        const emissive = "emissive" in source && source.emissive instanceof Color
          && source.emissive.r + source.emissive.g + source.emissive.b > 0.001
          ? source.emissive.clone()
          : null;
        const converted = emissive && !map
          ? new MeshBasicMaterial({ color: emissive, fog: true, toneMapped: false, side: source.side })
          : new MeshMatcapMaterial({ matcap: this.matcap, map, color: map ? new Color(0xffffff) : baseColor, side: source.side });
        converted.name = `${source.name || "weapon"}:successor`;
        if (converted instanceof MeshMatcapMaterial) installPawnRim(converted);
        convertedBySource.set(source, converted);
        return converted;
      };
      model.scene.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        object.material = Array.isArray(object.material)
          ? object.material.map(convertWeaponMaterial)
          : convertWeaponMaterial(object.material);
      });
    }
    // Named special humanoids (GR0K today) share the player skeleton and
    // animation compositor, but retain their authored multi-material palette.
    // Emissive optics/cores stay unlit; metal and shell parts use the shared
    // matcap so they survive the deliberately low-light world pass.
    for (const special of this.pack.specialBodies.values()) {
      const convertedBySource = new Map<Material, Material>();
      const convert = (source: Material): Material => {
        const existing = convertedBySource.get(source);
        if (existing) return existing;
        const map = "map" in source && source.map instanceof Texture ? source.map : null;
        if (map) map.colorSpace = SRGBColorSpace;
        const baseColor = "color" in source && source.color instanceof Color
          ? source.color.clone()
          : new Color(0x8f9296);
        const emissive = "emissive" in source && source.emissive instanceof Color
          && source.emissive.r + source.emissive.g + source.emissive.b > 0.001
          ? source.emissive.clone()
          : null;
        const material = emissive
          ? new MeshBasicMaterial({ map, color: emissive, fog: true, toneMapped: false, side: source.side })
          : new MeshMatcapMaterial({ matcap: this.matcap, map, color: baseColor, side: source.side });
        material.name = `${source.name || "special-body"}:successor`;
        if (material instanceof MeshMatcapMaterial) installPawnRim(material);
        convertedBySource.set(source, material);
        this.specialBodyMaterials.push(material);
        return material;
      };
      special.scene.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        object.material = Array.isArray(object.material)
          ? object.material.map(convert)
          : convert(object.material);
      });
    }
  }

  update(
    slice: SliceSnapshot,
    state: PlayState,
    dtSeconds: number,
    timeMs: number,
    focusX: number,
    focusZ: number,
  ): number {
    if (this.plasmaPreview) this.plasmaPreview.update(dtSeconds);
    for (const visual of this.visuals.values()) {
      if (visual.kind !== "pawn" || !visual.plasma) continue;
      const plasma = visual.plasma;
      if (plasma.extension !== plasma.targetExtension) {
        const rate = plasma.targetExtension > plasma.extension ? PLASMA_IGNITE_PER_SECOND : -PLASMA_RETRACT_PER_SECOND;
        plasma.extension = Math.min(1, Math.max(0, plasma.extension + rate * dtSeconds));
        plasma.blade.setExtension(plasma.extension);
      }
      plasma.blade.update(dtSeconds);
    }
    this.frame += 1;
    this.lodHiFiCount = 0;
    this.lodSimCount = 0;
    this.consumeCombatVisuals(state);
    const playerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    let sawServerActors = false;
    for (const actorId in state.serverAuthority.actors) {
      const actor = state.serverAuthority.actors[actorId];
      if (!actor) continue;
      sawServerActors = true;
      if (actor.areaId !== state.activeAreaId || actor.lifeState === "respawning") continue;
      const x = actorId === playerActorId ? state.player.x + 0.5 : (actor.renderX ?? actor.x) + 0.5;
      const z = actorId === playerActorId ? state.player.y + 0.5 : (actor.renderY ?? actor.y) + 0.5;
      this.renderActor(actor, actorId, x, z, dtSeconds, state, slice, focusX, focusZ);
    }
    if (!sawServerActors) {
      for (const actor of slice.actors) {
        if (actor.areaId !== state.activeAreaId) continue;
        const pos = actorWorldPosition(actor, slice, state, timeMs);
        this.renderActor(actor, actor.id, pos.x + 0.5, pos.y + 0.5, dtSeconds, state, slice, focusX, focusZ);
      }
    }

    for (const [actorId, visual] of this.visuals) {
      if (visual.lastSeenFrame === this.frame) continue;
      this.removeVisual(actorId, visual);
    }
    return this.visuals.size;
  }

  /**
   * Muzzle socket world position for the effects layer.
   * Returns a REUSED scratch Vector3 (copy it) or null when the actor is not
   * an armed, standing, visible pawn.
   */
  getMuzzleWorldPosition(actorId: string): Vector3 | null {
    const visual = this.visuals.get(actorId);
    if (!visual || visual.kind !== "pawn" || !visual.slugthrower || visual.weaponLane !== "rifle" || visual.deathState !== "none") return null;
    // DEF-11 guard: a rig still lying where death dropped it must never feed
    // the muzzle/fx origin — callers fall back to the chest-height read.
    if (visual.slugthrower.isDropped()) return null;
    return visual.slugthrower.getMuzzleWorld(scratchMuzzle);
  }

  /** Narrow FX hook: live skinned meshes for an actor's pawn (shield shells). */
  getShellMeshes(actorId: string): { meshes: SkinnedMesh[]; generation: number } | null {
    const visual = this.visuals.get(actorId);
    if (!visual || visual.kind !== "pawn" || visual.deathState !== "none" || visual.skinnedMeshes.length === 0) {
      this.shellMeshCache.delete(actorId);
      return null;
    }
    const generation = visual.equipmentMaterialGeneration;
    let cached = this.shellMeshCache.get(actorId);
    if (!cached) {
      cached = { meshes: [], generation: -1 };
      this.shellMeshCache.set(actorId, cached);
    }
    if (cached.generation !== generation) {
      const meshes = cached.meshes;
      meshes.length = 0;
      for (let i = 0; i < visual.skinnedMeshes.length; i += 1) meshes.push(visual.skinnedMeshes[i]!);
      for (let i = 0; i < visual.equipmentAttachments.length; i += 1) {
        this.collectAttachmentShellMeshes(visual.equipmentAttachments[i]!, meshes);
      }
      cached.generation = generation;
    }
    return cached;
  }

  private collectAttachmentShellMeshes(object: Object3D, out: SkinnedMesh[]): void {
    if (object instanceof SkinnedMesh) out.push(object);
    for (let i = 0; i < object.children.length; i += 1) this.collectAttachmentShellMeshes(object.children[i]!, out);
  }

  /** Live compositor layers for one actor (debug probe). */
  getActiveClipsByLayer(actorId: string, out: ActiveClipsByLayer): ActiveClipsByLayer | null {
    const visual = this.visuals.get(actorId);
    if (!visual || visual.kind !== "pawn") return null;
    return visual.animator.activeClipsByLayer(out);
  }

  /** Attached equipment item ids on one actor's pawn (debug probe). Appearance
   * hair is reported independently from any attached hat or helmet. */
  attachedEquipmentIdsFor(actorId: string): string[] {
    const visual = this.visuals.get(actorId);
    if (!visual || visual.kind !== "pawn") return [];
    const ids: string[] = [];
    for (let i = 0; i < visual.equipmentAttachments.length; i += 1) {
      const id = visual.equipmentAttachments[i]!.userData.successorEquipmentItemId;
      if (typeof id === "string" && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  /** Exact local face-paint attachment/readiness for creation/relog proof. */
  facePaintStatusFor(actorId: string): PawnFacePaintDebug | null {
    const visual = this.visuals.get(actorId);
    if (!visual || visual.kind !== "pawn") return null;
    const overlay = visual.equipmentAttachments.find((attachment) => attachment.name === "appearance:face");
    if (!(overlay instanceof SkinnedMesh)) return null;
    const material = Array.isArray(overlay.material) ? overlay.material[0] : overlay.material;
    const signature = overlay.userData.successorFaceSignature;
    if (typeof signature !== "string" || signature.length === 0) return null;
    return {
      attached: true,
      ready: material?.userData.successorFacePaintReady === true,
      signature,
    };
  }

  /**
   * Rendered world positions (cell units) of all live pawn visuals — the
   * fidelity probe compares these against server-authority positions to
   * quantify render-vs-truth drift. Fills `out`, returns the count written.
   */
  collectRenderedPositions(out: { id: string; x: number; z: number }[]): number {
    let count = 0;
    for (const [actorId, visual] of this.visuals) {
      if (visual.kind !== "pawn") continue;
      const position = visual.group.position;
      if (count < out.length) {
        const slot = out[count]!;
        slot.id = actorId;
        slot.x = position.x;
        slot.z = position.z;
      } else {
        out.push({ id: actorId, x: position.x, z: position.z });
      }
      count += 1;
    }
    return count;
  }
  /** Live LOD tier counts this frame (debug probe: lodHiFiActors / lodSimActors). */
  lodCounts(): { hiFi: number; sim: number } {
    return { hiFi: this.lodHiFiCount, sim: this.lodSimCount };
  }

  /**
   * On-demand pawn grounding diagnostics: rendered root position, body world
   * bounds/minY (Box3 traversal only when a probe asks — never per frame),
   * and the blob-shadow plane height.
   */
  debugPawnGrounding(actorId: string): PawnGroundingDebug | null {
    const visual = this.visuals.get(actorId);
    if (!visual) return null;
    const union = new Box3();
    const box = new Box3();
    let any = false;
    for (const child of visual.group.children) {
      if (child === visual.shadow) continue;
      child.updateWorldMatrix(true, false);
      box.setFromObject(child);
      if (box.isEmpty()) continue;
      if (any) union.union(box);
      else {
        union.copy(box);
        any = true;
      }
    }
    visual.shadow.updateWorldMatrix(true, false);
    const shadowWorld = new Vector3().setFromMatrixPosition(visual.shadow.matrixWorld);
    return {
      actorId,
      rootPosition: {
        x: visual.group.position.x,
        y: visual.group.position.y,
        z: visual.group.position.z,
      },
      bodyMinY: any ? union.min.y : null,
      bodyBounds: any
        ? {
            min: { x: union.min.x, y: union.min.y, z: union.min.z },
            max: { x: union.max.x, y: union.max.y, z: union.max.z },
          }
        : null,
      shadowPlaneY: shadowWorld.y,
    };
  }

  dispose(): void {
    for (const [actorId, visual] of this.visuals) this.removeVisual(actorId, visual);
    for (const material of this.bodyMaterials.values()) material.dispose();
    this.bodyMaterials.clear();
    for (const material of this.shadowMaterials.values()) material.dispose();
    this.shadowMaterials.clear();
    for (const material of this.specialBodyMaterials) material.dispose();
    this.specialBodyMaterials.length = 0;
    for (const template of this.creatureTemplates.values()) {
      for (const material of template.materials) material.dispose();
    }
    this.creatureTemplates.clear();
    this.matcap.dispose();
    shadowGeometry.dispose();
  }

  // ---------------------------------------------------------------------
  // Combat event consumption (impact-synchronized visual log)
  // ---------------------------------------------------------------------

  private consumeCombatVisuals(state: PlayState): void {
    this.consumeMeleeAttackEvents(state);
    const log = state.serverAuthority.visualLog;
    if (this.visualEventCursor === null) {
      // Do not replay history that predates this renderer instance.
      this.visualEventCursor = log.length > 0 ? log[log.length - 1]!.eventId : 0;
      return;
    }
    for (let i = log.length - 1; i >= 0; i -= 1) {
      const visualEvent = log[i]!;
      if (visualEvent.eventId <= this.visualEventCursor) break;
      const visual = this.visuals.get(visualEvent.targetActorId);
      if (!visual) continue;
      const event = this.combatEventForId(state, visualEvent.eventId);
      const meleeEvent = event ? isMeleeCombatEvent(event, state) : false;
      if (visualEvent.lifecycleKind === "hit") {
        if (meleeEvent && visual.kind === "pawn") {
          visual.pendingMeleeFlinchEventId = visualEvent.eventId;
          visual.pendingHit = null;
        } else {
          visual.pendingHit = this.hitFlinchForEvent(state, visualEvent.eventId);
        }
      } else {
        visual.pendingDeathKind = visualEvent.lifecycleKind;
        visual.pendingDeathYaw = event ? attackYaw(event) : null;
      }
    }
    if (log.length > 0) {
      this.visualEventCursor = Math.max(this.visualEventCursor, log[log.length - 1]!.eventId);
    }
  }

  private consumeMeleeAttackEvents(state: PlayState): void {
    const log = state.serverAuthority.eventLog;
    if (this.combatEventCursor === null) {
      this.combatEventCursor = log.length > 0 ? log[log.length - 1]!.id : 0;
      return;
    }
    for (let i = log.length - 1; i >= 0; i -= 1) {
      const event = log[i]!;
      if (event.id <= this.combatEventCursor) break;
      if (!isMeleeCombatEvent(event, state)) continue;
      const visual = this.visuals.get(event.shooterActorId);
      if (!visual || visual.kind !== "pawn") continue;
      const fireAnimation = state.weaponFireAnimations[event.shooterActorId];
      if (
        fireAnimation
        && fireAnimation.kind === "fire"
        && isMeleeWeaponPresentation(String(fireAnimation.weaponId))
        && fireAnimation.startedAtMs !== visual.lastFireStartMs
      ) {
        const activeMontage = visual.animator.montageClip();
        const transitionActive = activeMontage === MELEE_DRAW_MONTAGE_CLIP
          || activeMontage === MELEE_SHEATH_MONTAGE_CLIP;
        // The authority event and `inCombat` latch arrive together. Event
        // consumption runs before renderActor starts the draw montage, so a
        // stowed first strike must be retained here instead of relying on the
        // short-lived fire token to outlast the authored 0.833s draw. Marking
        // that token consumed also prevents a duplicate swing when draw ends.
        // Unarmed actors deliberately stay in the model-free `none` lane;
        // their event is retained and consumed immediately by driveMontages.
        if (transitionActive || visual.meleeWeaponPose !== "held") {
          visual.lastFireStartMs = fireAnimation.startedAtMs;
          visual.pendingMeleeSwingEventId = event.id;
        }
        continue;
      }
      visual.pendingMeleeSwingEventId = event.id;
    }
    if (log.length > 0) {
      this.combatEventCursor = Math.max(this.combatEventCursor, log[log.length - 1]!.id);
    }
  }

  private combatEventForId(state: PlayState, eventId: number): ServerAuthorityCombatEventState | null {
    const log = state.serverAuthority.eventLog;
    for (let i = log.length - 1; i >= 0; i -= 1) {
      const event: ServerAuthorityCombatEventState = log[i]!;
      if (event.id === eventId) return event;
    }
    return null;
  }


  private hitFlinchForEvent(state: PlayState, eventId: number): PendingHitFlinch {
    const event = this.combatEventForId(state, eventId);
    const damage = event?.damage ?? 0;
    return {
      yaw: event ? attackYaw(event) : null,
      zone: event?.zone ?? "torso",
      magnitude: Math.min(1.35, Math.max(0.5, damage > 0 ? damage / 18 : 0.65)),
    };
  }

  private engagementTargetYawForActor(actorId: string, x: number, z: number, state: PlayState): number | null {
    // Queue privacy (C3, spec §F): other actors' queues no longer stream, and
    // every combat enqueue sets engagement_target_id server-side — it is the
    // sole public telegraph signal (the old combatQueue fallback is dead).
    const actor = state.serverAuthority.actors[actorId];
    const targetId = actor?.engagementTargetId;
    if (!targetId || targetId === actorId) return null;
    const target = state.serverAuthority.actors[targetId];
    if (!target || target.areaId !== state.activeAreaId || target.lifeState !== "alive") return null;
    const targetX = (target.renderX ?? target.x) + 0.5;
    const targetZ = (target.renderY ?? target.y) + 0.5;
    const dx = targetX - x;
    const dz = targetZ - z;
    if (dx * dx + dz * dz < 1e-6) return null;
    return Math.atan2(dx, dz);
  }

  // ---------------------------------------------------------------------
  // Per-actor drive
  // ---------------------------------------------------------------------

  private renderActor(
    actor: RenderActor,
    actorId: string,
    x: number,
    z: number,
    dtSeconds: number,
    state: PlayState,
    slice: SliceSnapshot,
    focusX: number,
    focusZ: number,
  ): void {
    let visual = this.ensureVisual(actorId, actor, state, slice, x, z);
    if (visual.kind === "creature") {
      this.renderCreature(visual, actor, actorId, x, z, dtSeconds, state, slice);
      return;
    }
    const config = SUCCESSOR_3D_CONFIG.pawnPack;
    const playerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const isPlayer = actorId === playerActorId;
    if (!visual.specialBodyKey) {
      const itemIds = this.defaultEquipmentIds(actorId, actor, isPlayerRoleActor(actor));
      if (!sameStringArray(visual.resolvedEquipmentIds, itemIds)
        || equipmentAppearanceChanged(visual.equipmentAppearance, actor)) {
        const legsCovered = visual.body === "male"
          && equipmentIdsCoverLegs(this.pack.equipment.items, itemIds, this.equipmentLookup);
        if (visual.legsCovered !== legsCovered) {
          this.removeVisual(actorId, visual);
          visual = this.ensureVisual(actorId, actor, state, slice, x, z) as PawnVisual;
        } else {
          this.attachDefaultEquipment(visual, actorId, actor, isPlayer, itemIds);
        }
      }
    }

    // --- velocity / speed (cells per second) ---
    let velocityX = 0;
    let velocityZ = 0;
    if ("renderVelocityX" in actor && Number.isFinite(actor.renderVelocityX) && !isPlayer) {
      // runtimeUpdateSystem owns remote interpolation and emits renderVelocity
      // in cells/second. Do not divide by dt here or the leg cycle double-scales.
      velocityX = actor.renderVelocityX ?? 0;
      velocityZ = actor.renderVelocityY ?? 0;
    } else if (dtSeconds > 0) {
      velocityX = (x - visual.lastX) / dtSeconds;
      velocityZ = (z - visual.lastZ) / dtSeconds;
    }
    if (isPlayer && state.moving) {
      const move = state.serverAuthority.lastMoveVector;
      const inputLength = move ? Math.hypot(move.x, move.y) : 0;
      if (move && inputLength > 1e-4) {
        const visualSpeed = Math.max(Math.hypot(velocityX, velocityZ), config.idleSpeedCellsPerSec + 0.01);
        velocityX = (move.x / inputLength) * visualSpeed;
        velocityZ = (move.y / inputLength) * visualSpeed;
      }
    }
    const speed = Math.hypot(velocityX, velocityZ);
    const frameDisplacement = Math.hypot(x - visual.lastX, z - visual.lastZ);
    const idleThreshold = visual.locomotionMoving
      ? LOCOMOTION_IDLE_STOP_SPEED_CELLS_PER_SECOND
      : LOCOMOTION_IDLE_START_SPEED_CELLS_PER_SECOND;
    const moving = speed > idleThreshold
      && (frameDisplacement > SUCCESSOR_3D_CONFIG.pawn.velocityYawEpsilonCellsPerFrame || speed > config.idleSpeedCellsPerSec);
    visual.locomotionMoving = moving;

    // --- armed / weapon state ---
    const weapon = "weapon" in actor ? actor.weapon : null;
    const weaponLane = weaponLaneForActor(actor);
    const armed = weaponLane !== "none";
    const rifleArmed = weaponLane === "rifle";
    const meleeArmed = weaponLane === "melee";
    const equippedWeaponId = equippedWeaponIdForActor(actor);
    const meleeWeaponVisible = meleeArmed && equippedWeaponId !== "unarmed";
    const lifeState = "lifeState" in actor ? actor.lifeState : "alive";
    const lifecycleSeq = "lifecycleSeq" in actor ? actor.lifecycleSeq : 0;
    const statuses = "statuses" in actor ? actor.statuses : [];
    let sleeping = false;
    let stimCount = 0;
    let stimMaxRemainingMs = 0;
    for (const status of statuses) {
      if ((status.id as string) === "sleeping") sleeping = true;
      if ((status.id as string).startsWith("stimpak_")) {
        stimCount += 1;
        const remaining = "remainingMs" in status ? status.remainingMs : 0;
        if (remaining > stimMaxRemainingMs) stimMaxRemainingMs = remaining;
      }
    }

    // --- lifecycle: death / sleep / revive ---
    const down = lifeState !== "alive" || sleeping;
    const downedPose = lifeState === "downed";
    if (visual.deathState === "down") {
      const revived = !down && lifecycleSeq !== visual.lastLifecycleSeq;
      if (!down && (revived || visual.sleeping)) {
        visual.deathState = "none";
        visual.sleeping = false;
        visual.animator.clearMontage();
        // DEF-11: death dropped the rifle visual to the ground; the pawn
        // standing back up must recover it, or the orphaned ground mesh keeps
        // the muzzle socket and every bolt fires from the dirt.
        if (visual.slugthrower?.isDropped()) visual.slugthrower.recoverFromDrop();
        this.applyShadowTint(visual, actor, state, slice, false);
      }
    }
    if (down && visual.deathState === "none") {
      // lifeState flips at packet-apply time, but the killed/downed visual event
      // only flushes when the tracer visibly lands. Hold the fall briefly so the
      // death direction + impact sync come from the real event; fall back after
      // the grace window (or immediately for sleep / join-in-progress snaps).
      visual.deathGraceElapsed += dtSeconds;
      if (sleeping || visual.pendingDeathKind !== null || visual.bornDown || visual.deathGraceElapsed > 0.4) {
        this.startDeath(visual, sleeping, visual.bornDown && visual.pendingDeathKind === null && !sleeping, rifleArmed, downedPose);
        this.applyShadowTint(visual, actor, state, slice, sleeping);
      }
    }
    if (!down) {
      visual.deathGraceElapsed = 0;
      visual.bornDown = false;
    }
    visual.sleeping = sleeping;
    visual.lastLifecycleSeq = lifecycleSeq;
    const isDown = visual.deathState === "down";

    // stim_inject arm overlay on stimpak application: count increase catches
    // fresh statuses; remainingMs jumping UP catches a refresh while already
    // active (it only decays between frames otherwise). Seeded silently on
    // first observation so join-in-progress never replays.
    if (visual.lastStimCount >= 0 && !isDown) {
      const refreshed = stimCount === visual.lastStimCount && stimCount > 0
        && stimMaxRemainingMs > visual.lastStimMaxRemainingMs + 1;
      if (stimCount > visual.lastStimCount || refreshed) {
        visual.animator.playArm("stim_inject");
      }
    }
    visual.lastStimCount = stimCount;
    visual.lastStimMaxRemainingMs = stimMaxRemainingMs;

    // --- yaw ---
    const aimYaw: number | null = null;
    // Roll combat owns visual facing whenever an armed pawn is engaged/queued,
    // even while moving; locomotion below reads velocity relative to this yaw
    // so retreating from the target plays the backward gait instead of
    // shooting out of the pawn's back.
    const engagementYaw = armed
      ? this.engagementTargetYawForActor(actorId, x, z, state)
      : null;
    const aimControlsYaw = isPlayer && armed && aimYaw !== null && engagementYaw === null;
    const targetYaw = resolvePawnYawTarget({
      currentYaw: visual.yaw,
      isPlayer,
      inputMoving: isPlayer && state.moving,
      renderMoving: moving,
      velocityX,
      velocityZ,
      aimYaw,
      aimControlsYaw,
      engagementYaw,
      actorDirection: "direction" in actor && typeof actor.direction === "string" ? actor.direction : null,
    });
    if (!isDown) {
      if (aimControlsYaw && aimYaw !== null) {
        if (moving) {
          visual.yaw = targetYaw;
        } else {
          const yawDelta = wrapAngle(targetYaw - visual.yaw);
          if (Math.abs(yawDelta) > AIM_YAW_JITTER_DEADZONE_RAD) {
            const maxStep = Math.max(0, SUCCESSOR_3D_CONFIG.pawn.aimBodyTurnRadPerSec) * dtSeconds;
            visual.yaw = wrapAngle(visual.yaw + Math.min(maxStep, Math.max(-maxStep, yawDelta)));
          }
        }
      } else {
        const yawDelta = wrapAngle(targetYaw - visual.yaw);
        const maxStep = config.yawLerpRadPerSec * dtSeconds;
        visual.yaw = wrapAngle(visual.yaw + Math.min(maxStep, Math.max(-maxStep, yawDelta)));
      }
    }
    visual.group.rotation.y = visual.yaw;
    // Floor lookup uses the RENDERED center (authority anchor +0.5/+0.5) —
    // the same point the pawn actually stands on, never the anchor corner.
    visual.group.position.set(x, enterableFloorYAt(slice.props, state.activeAreaId, x, z), z);

    const weaponLaneChanged = visual.weaponLane !== weaponLane;
    const desiredWeaponModelKey = armed ? weaponModelAssetKeyForActor(actor) : null;
    const desiredWeaponPresentationKey = armed
      ? `${equippedWeaponId ?? weaponLane}:${desiredWeaponModelKey ?? "builtin"}`
      : null;
    const weaponKeyChanged = visual.weaponAssetKey !== desiredWeaponPresentationKey;
    if (weaponLaneChanged || weaponKeyChanged) {
      visual.weaponLane = weaponLane;
      visual.weaponAssetKey = desiredWeaponPresentationKey;
      visual.armed = armed;
      visual.holdUpperClip = null;
      // Swap the modeled weapon whenever its authority id or catalog asset
      // changes. In particular, unarmed must remove a prior vibrosword/machete.
      this.detachPlasmaEquip(visual);
      visual.slugthrower?.dispose();
      visual.slugthrower = null;
      visual.sword?.dispose();
      visual.sword = null;
      this.ensureSlugthrower(visual, rifleArmed, desiredWeaponModelKey);
      this.ensureSword(visual, meleeWeaponVisible, desiredWeaponModelKey);
    } else {
      visual.armed = armed;
    }

    // --- layers (skip all composition while down: death montage owns the body) ---
    if (!isDown) {
      const authorityActor = state.serverAuthority.actors[actorId];
      const kneelPosture = (authorityActor?.posture ?? "standing") !== "standing";
      // Out of combat the weapon rides the back: the whole pose stack follows
      // the HELD state, never `armed` alone, or the pawn keeps weapon-hold
      // arms with the weapon on its back (owner spec 2026-07-03).
      const pose = resolveWieldPose({
        armed,
        inCombat: authorityActor?.inCombat,
        reloading: rifleArmed && (weapon?.reloadRemainingTicks ?? 0) > 0,
      });
      const nextMeleePose: MeleeWeaponPose = meleeArmed ? pose.holdWeapon ? "held" : "stowed" : "unarmed";
      this.syncMeleeTransitionMontage(visual, nextMeleePose, moving);
      visual.slugthrower?.setStowed(rifleArmed ? pose.stowed : true);
      visual.sword?.setStowed(meleeArmed ? pose.stowed : true);
      this.syncPlasmaEquip(visual, weapon, meleeWeaponVisible, meleeWeaponVisible ? pose.stowed : true);
      const useRifleBaseLane = rifleArmed && pose.holdWeapon && this.rifleBaseLaneAvailable;
      const useMeleeBaseLane = meleeArmed && pose.holdWeapon && this.meleeBaseLaneAvailable;
      this.driveLocomotion(visual, speed, velocityX, velocityZ, moving, useRifleBaseLane, useMeleeBaseLane, kneelPosture);
      const upperClip = pose.holdWeapon
        ? rifleArmed ? RIFLE_AIM_UPPER_CLIP : meleeArmed ? MELEE_READY_UPPER_CLIP : null
        : null;
      this.syncHoldUpper(visual, upperClip);
      const handClip = pose.holdWeapon
        ? rifleArmed ? GUN_GRIP_HAND_CLIP : meleeArmed ? MELEE_GRIP_HAND_CLIP : null
        : null;
      visual.animator.setHand(handClip);
      this.driveMontages(visual, actorId, weaponLane, weapon, state, moving);
    }
    visual.slugthrower?.setVisible(rifleArmed);
    visual.sword?.setVisible(meleeWeaponVisible);
    if (isDown) {
      this.resetHitFlinch(visual);
    } else {
      this.applyHitFlinch(visual, dtSeconds);
    }

    // --- tint ---
    if (visual.specialBodyKey) this.applyShadowTint(visual, actor, state, slice, false);
    else this.applyBodyTint(visual, actor, actorId, state, slice);

    // --- mixer update with LOD tier gating (SIMULATION vs HI-FI) ---
    // Owner intent ("render double distance out with no visual"): actors
    // exist/stream/move at double the spawn distance (fixture activation
    // 44->88) but the expensive per-frame work is gated to near range.
    //   HI-FI (within lod.hiFiRadiusCells, default 40): full mixer + weapon IK.
    //   SIMULATION (beyond): group.position/yaw already updated above and
    //     driveLocomotion keeps the mixer's TARGET gait clip correct every
    //     frame, but the mixer + slugthrower IK eval are skipped — the skeleton
    //     holds its last pose. hiFiRadiusCells (40) sits beyond the ~24-cell
    //     max view half-diagonal and gives the radar-96 AOI era a +10-cell
    //     early-unfreeze margin before actors enter view. Hysteresis
    //     latches the tier so boundary actors don't thrash frame-to-frame.
    //     The focus actor (player / observer cam) is always HI-FI.
    const lod = SUCCESSOR_3D_CONFIG.pawn.lod;
    const dx = x - focusX;
    const dz = z - focusZ;
    const distSq = dx * dx + dz * dz;
    const isFocusActor = isPlayer || state.observerCamera.followActorId === actorId;
    const hiFiBase = lodHiFiRadiusOverride ?? lod.hiFiRadiusCells;
    const hiFiRadius = visual.lodHiFi ? hiFiBase + lod.hysteresisCells : hiFiBase;
    const hiFi = isFocusActor || distSq <= hiFiRadius * hiFiRadius;
    visual.lodHiFi = hiFi;
    if (hiFi) this.lodHiFiCount += 1;
    else this.lodSimCount += 1;
    visual.accumulatedDt += dtSeconds;
    if (!hiFi) {
      // SIM: drop accumulated time so a tier re-entry resumes at a normal step
      // (the mixer's current clip is already correct -> resumes mid-stride).
      visual.accumulatedDt = 0;
    } else {
      const animDt = visual.accumulatedDt;
      visual.accumulatedDt = 0;
      visual.animator.update(animDt);
      const updateSlugthrower = visual.slugthrower && (rifleArmed || visual.slugthrower.isDropped());
      const updateSword = visual.sword && meleeArmed;
      if (updateSlugthrower || updateSword) {
        visual.group.updateMatrixWorld(true);
        if (updateSlugthrower && visual.slugthrower) {
          // Procedural reload: progress comes from the SERVER reload window —
          // no reload montage exists anymore (the body holds its normal pose;
          // SlugthrowerRig choreographs the support hand + mag).
          let reloadProgress: { elapsedS: number; totalS: number } | null = null;
          if (rifleArmed && weapon && weapon.reloadRemainingTicks > 0 && weapon.reloadTotalTicks > 0) {
            const tickRateHz = slice.tickRateHz > 0 ? slice.tickRateHz : 20;
            const totalS = weapon.reloadTotalTicks / tickRateHz;
            reloadScratch.totalS = totalS;
            reloadScratch.elapsedS = Math.max(0, totalS - weapon.reloadRemainingTicks / tickRateHz);
            reloadProgress = reloadScratch;
          }
          // IK policy (viewer parity): rifle_* base clips author BOTH arms
          // (the viewer runs zero IK and holds perfectly) — "auto" lets the rig
          // re-anchor the palm only when bore leveling moved the foregrip.
          // Reload and the legacy lane genuinely need IK; death forbids it.
          const ikMode = isDown
            ? "off" as const
            : reloadProgress !== null || !this.rifleBaseLaneAvailable
              ? "on" as const
              : "auto" as const;
          visual.slugthrower.update(animDt, reloadProgress, ikMode, visual.yaw, aimYaw);
        }
        if (updateSword && visual.sword) visual.sword.update(animDt);
      }
    }

    visual.lastX = x;
    visual.lastZ = z;
    visual.lastSeenFrame = this.frame;
  }

  private driveLocomotion(
    visual: PawnVisual,
    speed: number,
    velocityX: number,
    velocityZ: number,
    moving: boolean,
    useRifleBaseLane: boolean,
    useMeleeBaseLane: boolean,
    kneelPosture: boolean,
  ): boolean {
    const config = SUCCESSOR_3D_CONFIG.pawnPack;
    // Kneel family (kneeling_down / kneeling / standing_up): crouch_idle
    // owns the base lane (v1 basic per owner ruling — no crouch_walk; the
    // server rejects movement while not standing, so the pawn is planted).
    // The armed upper hold mask rides on top unchanged.
    let gait: BaseGait = kneelPosture ? "kneel" : "idle";
    if (moving && !kneelPosture) {
      const facingX = Math.sin(visual.yaw);
      const facingZ = Math.cos(visual.yaw);
      const along = speed > 1e-4 ? (velocityX * facingX + velocityZ * facingZ) / speed : 1;
      if (along < config.backpedalDotThreshold) {
        gait = "walk_b";
      } else if (visual.gait === "run_f") {
        gait = speed > config.walkRunThresholdCellsPerSec - WALK_RUN_HYSTERESIS_CELLS_PER_SECOND ? "run_f" : "walk_f";
      } else {
        gait = speed > config.walkRunThresholdCellsPerSec + WALK_RUN_HYSTERESIS_CELLS_PER_SECOND ? "run_f" : "walk_f";
      }
    }
    let riflePoseChanged = false;
    if (
      visual.gait !== gait
      || visual.baseLaneRifle !== useRifleBaseLane
      || visual.baseLaneMelee !== useMeleeBaseLane
    ) {
      const baseRiflePosed = useRifleBaseLane && RIFLE_BASE_CLIP_RIFLE_POSED[gait];
      riflePoseChanged = visual.baseRiflePosed !== baseRiflePosed;
      visual.gait = gait;
      visual.baseLaneRifle = useRifleBaseLane;
      visual.baseLaneMelee = useMeleeBaseLane;
      visual.baseRiflePosed = baseRiflePosed;
    }
    const baseClip = visual.poseBaseOverride ?? (useMeleeBaseLane
      ? MELEE_BASE_CLIPS[gait]
      : useRifleBaseLane ? RIFLE_BASE_CLIPS[gait] : UNARMED_BASE_CLIPS[gait]);
    if (gait === "idle" || gait === "kneel" || visual.poseBaseOverride !== null) {
      visual.animator.setBase(baseClip, 1);
      return riflePoseChanged;
    }
    const meta = this.pack.clipMeta.get(baseClip);
    const clipSpeed = (meta?.moveSpeedMps ?? 1) * this.pack.scale;
    visual.animator.setBase(baseClip, locomotionTimeScale(speed, clipSpeed));
    return riflePoseChanged;
  }

  private syncHoldUpper(visual: PawnVisual, clipName: string | null): void {
    if (visual.holdUpperClip === clipName) return;
    visual.holdUpperClip = clipName;
    visual.animator.setUpper(clipName);
  }

  private driveMontages(
    visual: PawnVisual,
    actorId: string,
    weaponLane: WeaponLane,
    weapon: ServerAuthorityActorState["weapon"],
    state: PlayState,
    moving: boolean,
  ): void {
    // Reload is fully procedural (SlugthrowerRig choreographs the support hand + mag
    // over the server reload window); it no longer touches the montage slot.
    // `reloading` still gates the fire montage below.
    const reloading = Boolean(weaponLane === "rifle" && weapon && weapon.reloadRemainingTicks > 0);

    // Fire: one montage per weaponFireAnimations trigger (Roll-event timing).
    // Draw/sheath transitions are real L4 montages; do not let the first melee
    // strike stomp the visible weapon transition in the same frame. The combat
    // event remains pending and plays once the transition clears.
    const activeMontage = visual.animator.montageClip();
    const meleeTransitionActive = activeMontage === MELEE_DRAW_MONTAGE_CLIP
      || activeMontage === MELEE_SHEATH_MONTAGE_CLIP;
    const playerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const movingForSwingMask = moving || (actorId === playerActorId && state.moving);
    this.syncMeleeSwingMontageMask(visual, movingForSwingMask);
    const fireAnimation = state.weaponFireAnimations[actorId];
    if (
      !meleeTransitionActive
      && fireAnimation
      && fireAnimation.kind === "fire"
      && fireAnimation.startedAtMs !== visual.lastFireStartMs
      && !reloading
    ) {
      const fireWeaponId = String(fireAnimation.weaponId);
      if (
        isMeleeWeaponPresentation(fireWeaponId)
        && (weaponLane === "melee" || (weaponLane === "none" && fireWeaponId === "unarmed"))
      ) {
        visual.lastFireStartMs = fireAnimation.startedAtMs;
        this.playNextMeleeSwing(visual, movingForSwingMask);
      } else if (weaponLane === "rifle" && !isMeleeWeaponPresentation(fireWeaponId)) {
        visual.lastFireStartMs = fireAnimation.startedAtMs;
        visual.animator.playMontage("rifle_fire");
      }
    }

    if (visual.pendingMeleeSwingEventId !== null && !meleeTransitionActive) {
      const eventId = visual.pendingMeleeSwingEventId;
      visual.pendingMeleeSwingEventId = null;
      const event = this.combatEventForId(state, eventId);
      const eventWeaponId = event?.weaponId === undefined ? null : String(event.weaponId);
      const modelFreeUnarmedSwing = weaponLane === "none"
        && (eventWeaponId === "unarmed" || state.actorWeaponIds[actorId] === "unarmed");
      if ((weaponLane === "melee" || modelFreeUnarmedSwing) && eventId !== visual.lastMeleeAttackEventId) {
        visual.lastMeleeAttackEventId = eventId;
        this.playNextMeleeSwing(visual, movingForSwingMask);
      }
    }

    if (visual.pendingMeleeFlinchEventId !== null) {
      visual.pendingMeleeFlinchEventId = null;
      visual.pendingHit = null;
      visual.animator.playMontage(MELEE_FLINCH_MONTAGE_CLIP);
      return;
    }

    // Procedural flinch: a tiny hit reaction keeps legs/gun control stable and
    // varies by incoming direction + hit zone. Melee hits use melee_flinch above.
    const pendingHit = visual.pendingHit;
    if (pendingHit) {
      visual.pendingHit = null;
      const active = visual.animator.montageClip();
      if (active !== "reload") this.startHitFlinch(visual, pendingHit);
    }
  }

  private playNextMeleeSwing(visual: PawnVisual, moving: boolean): void {
    const clip = MELEE_SWING_MONTAGES[visual.meleeSwingIndex % MELEE_SWING_MONTAGES.length]!;
    visual.meleeSwingIndex = (visual.meleeSwingIndex + 1) % MELEE_SWING_MONTAGES.length;
    visual.animator.playMontage(clip, { maskMode: meleeSwingMaskMode(moving) });
  }

  private syncMeleeSwingMontageMask(visual: PawnVisual, moving: boolean): void {
    const clip = visual.animator.montageClip();
    if (!isMeleeSwingMontageClip(clip) || !moving) return;
    visual.animator.setMontageMaskMode("clip");
  }

  private syncMeleeTransitionMontage(visual: PawnVisual, nextPose: MeleeWeaponPose, moving: boolean): void {
    const previousPose = visual.meleeWeaponPose;
    visual.meleeWeaponPose = nextPose;
    if (previousPose === null || previousPose === nextPose) return;
    if (nextPose === "held" && (previousPose === "stowed" || previousPose === "unarmed")) {
      this.playMeleeTransitionMontage(visual, MELEE_DRAW_MONTAGE_CLIP, moving);
    } else if (previousPose === "held" && nextPose === "stowed") {
      this.playMeleeTransitionMontage(visual, MELEE_SHEATH_MONTAGE_CLIP, moving);
    }
  }

  private playMeleeTransitionMontage(visual: PawnVisual, clipName: string, moving: boolean): void {
    if (!this.pack.clips.has(clipName)) return;
    const durationS = this.pack.clipMeta.get(clipName)?.durationS ?? 0;
    const timeScale = moving && durationS > MELEE_TRANSITION_MOVING_MAX_SECONDS
      ? durationS / MELEE_TRANSITION_MOVING_MAX_SECONDS
      : 1;
    visual.animator.playMontage(clipName, { timeScale });
  }

  private startHitFlinch(visual: PawnVisual, hit: PendingHitFlinch): void {
    visual.hitFlinchElapsed = 0;
    visual.hitFlinchDuration = 0.18;
    visual.hitFlinchYaw = hit.yaw ?? visual.yaw;
    visual.hitFlinchMagnitude = hit.magnitude * flinchZoneScale(hit.zone);
    visual.hitFlinchZone = hit.zone;
  }

  private applyHitFlinch(visual: PawnVisual, dtSeconds: number): void {
    if (visual.hitFlinchElapsed >= visual.hitFlinchDuration) {
      this.resetHitFlinch(visual);
      return;
    }
    visual.hitFlinchElapsed = Math.min(visual.hitFlinchDuration, visual.hitFlinchElapsed + dtSeconds);
    const t = visual.hitFlinchDuration > 0 ? visual.hitFlinchElapsed / visual.hitFlinchDuration : 1;
    const envelope = Math.sin(Math.PI * t);
    const localYaw = wrapAngle(visual.hitFlinchYaw - visual.yaw);
    const side = Math.sin(localYaw);
    const forward = Math.cos(localYaw);
    const mag = visual.hitFlinchMagnitude * envelope;
    const legDip = visual.hitFlinchZone === "legs" ? -0.018 * mag : 0;
    visual.bodyRoot.position.set(side * 0.018 * mag, legDip, forward * 0.026 * mag);
    visual.bodyRoot.rotation.set(-forward * 0.035 * mag, 0, -side * 0.06 * mag);
  }

  private resetHitFlinch(visual: PawnVisual): void {
    if (
      visual.bodyRoot.position.x === 0
      && visual.bodyRoot.position.y === 0
      && visual.bodyRoot.position.z === 0
      && visual.bodyRoot.rotation.x === 0
      && visual.bodyRoot.rotation.y === 0
      && visual.bodyRoot.rotation.z === 0
    ) {
      return;
    }
    visual.bodyRoot.position.set(0, 0, 0);
    visual.bodyRoot.rotation.set(0, 0, 0);
  }

  private startDeath(visual: PawnVisual, sleeping: boolean, snapToEnd: boolean, dropRifle: boolean, downedPose: boolean): void {
    visual.deathState = "down";
    let clip: "death_f" | "death_b";
    if (downedPose) {
      clip = "death_f";
    } else if (visual.pendingDeathYaw !== null) {
      // Attack vector vs facing: shot from behind pushes the pawn forward.
      clip = Math.cos(visual.pendingDeathYaw - visual.yaw) > 0 ? "death_f" : "death_b";
    } else if (sleeping) {
      clip = "death_b";
    } else {
      clip = hashId(`${visual.group.name}:death`) % 2 === 0 ? "death_f" : "death_b";
    }
    visual.pendingDeathKind = null;
    visual.pendingDeathYaw = null;
    visual.pendingHit = null;
    visual.pendingMeleeSwingEventId = null;
    visual.pendingMeleeFlinchEventId = null;
    if (dropRifle && visual.slugthrower) {
      visual.group.updateMatrixWorld(true);
      visual.slugthrower.dropToWorld(this.scene);
    }
    visual.animator.playMontage(clip, { holdEnd: true, startAtEnd: snapToEnd });
  }

  // ---------------------------------------------------------------------
  // Visual lifecycle / materials
  // ---------------------------------------------------------------------

  private ensureVisual(
    actorId: string,
    actor: RenderActor,
    state: PlayState,
    slice: SliceSnapshot,
    x: number,
    z: number,
  ): ActorVisual {
    const existing = this.visuals.get(actorId);
    if (existing) return existing;
    const creatureSpecies = creatureSpeciesForActor(actor);
    if (creatureSpecies) return this.createCreatureVisual(actorId, actor, creatureSpecies, x, z);

    const body = this.bodyForActor(actorId, actor, slice);
    const requestedSpecialBodyKey = specialPawnBodyKeyForActor(actorId, actor, slice);
    const playerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const isLocalPlayer = actorId === playerActorId;
    const itemIds = this.defaultEquipmentIds(actorId, actor, isPlayerRoleActor(actor));
    const legsCovered = body === "male"
      && equipmentIdsCoverLegs(this.pack.equipment.items, itemIds, this.equipmentLookup);
    const group = new Group();
    group.name = `pawn:${actorId}`;
    const specialBody = requestedSpecialBodyKey
      ? cloneSpecialPawnBody(this.pack, requestedSpecialBodyKey)
      : null;
    if (requestedSpecialBodyKey && !specialBody) {
      console.error(`pawn pack: missing special humanoid body "${requestedSpecialBodyKey}"; using ${body}`);
    }
    const specialBodyKey = specialBody ? requestedSpecialBodyKey : null;
    const bodyRoot = specialBody ?? clonePawnBody(this.pack, body, { bare: body === "male" && !legsCovered });
    bodyRoot.name = `pawn-body:${actorId}`;
    const bodyScale = specialBodyKey
      ? SUCCESSOR_3D_CONFIG.pawnPack.heightTargetUnits
        / (this.pack.specialBodies.get(specialBodyKey)?.heightM ?? SUCCESSOR_3D_CONFIG.pawnPack.heightTargetUnits)
      : this.pack.scale;
    bodyRoot.scale.setScalar(bodyScale);
    group.add(bodyRoot);

    const skinnedMeshes: SkinnedMesh[] = [];
    bodyRoot.traverse((object) => {
      if (object instanceof SkinnedMesh) skinnedMeshes.push(object);
    });

    const shadow = new Mesh(shadowGeometry, this.shadowMaterial(SUCCESSOR_3D_CONFIG.pawn.defaultTint));
    shadow.name = `pawn-shadow:${actorId}`;
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.015;
    group.add(shadow);
    this.scene.add(group);

    const animator = new PawnAnimator(bodyRoot, this.pack, this.maskedClips);
    animator.setBase("idle", 1);

    const visual: PawnVisual = {
      kind: "pawn",
      group,
      bodyRoot,
      body,
      legsCovered,
      specialBodyKey,
      animator,
      slugthrower: null,
      sword: null,
      plasma: null,
      shadow,
      skinnedMeshes,
      equipmentMaterialGeneration: 0,
      equipmentAttachments: [],
      resolvedEquipmentIds: itemIds,
      equipmentAppearance: null,
      hairMaterialId: null,
      wornColorsByPiece: null,
      yaw: "direction" in actor && typeof actor.direction === "string" ? yawForDirection(actor.direction) : 0,
      lastX: x,
      lastZ: z,
      lastSeenFrame: this.frame,
      frameOffset: hashId(actorId) % 4,
      accumulatedDt: 0,
      armed: false,
      weaponLane: "none",
      weaponAssetKey: null,
      gait: "idle",
      locomotionMoving: false,
      baseLaneRifle: false,
      baseLaneMelee: false,
      baseRiflePosed: false,
      holdUpperClip: null,
      deathState: "none",
      bornDown: "lifeState" in actor && actor.lifeState === "downed",
      deathGraceElapsed: 0,
      lastStimCount: -1,
      lastStimMaxRemainingMs: 0,
      poseBaseOverride: null,
      sleeping: false,
      lastLifecycleSeq: "lifecycleSeq" in actor ? actor.lifecycleSeq : 0,
      lastFireStartMs: state.weaponFireAnimations[actorId]?.startedAtMs ?? -1,
      lastMeleeAttackEventId: -1,
      pendingMeleeSwingEventId: null,
      pendingMeleeFlinchEventId: null,
      meleeWeaponPose: null,
      meleeSwingIndex: 0,
      colorKey: "",
      lodHiFi: false,
      pendingHit: null,
      pendingDeathYaw: null,
      pendingDeathKind: null,
      hitFlinchElapsed: 1,
      hitFlinchDuration: 0,
      hitFlinchYaw: 0,
      hitFlinchMagnitude: 0,
      hitFlinchZone: "torso",
    };
    if (!specialBodyKey) this.attachDefaultEquipment(visual, actorId, actor, isLocalPlayer, itemIds);
    markSunShadowCaster(group);
    shadow.layers.disable(SUN_SHADOW_CASTER_LAYER);
    this.visuals.set(actorId, visual);
    return visual;
  }

  /**
   * DEV preview seam: toggles a plasma blade on the local pawn's sword rig,
   * cycling colors per call (owner spec: blade is PURE EFFECT, any color,
   * 0.65x vibro reach). Preview-only until the item/variant wave lands the
   * authoritative color channel for remote pawns.
   */
  /**
   * DEV pose/gesture preview seam (__successorPawns.poseTest): base loops
   * toggle a per-visual base override; arm/montage clips one-shot through
   * the real layer machinery. Presentation-only.
   */
  poseTest(clip: string): boolean {
    const meta = this.pack.clipMeta.get(clip);
    if (!meta) return false;
    for (const visual of this.visuals.values()) {
      if (visual.kind !== "pawn") continue;
      if (meta.layer === "base") {
        visual.poseBaseOverride = visual.poseBaseOverride === clip ? null : clip;
      } else if (meta.layer === "arm") {
        visual.animator.playArm(clip);
      } else {
        visual.animator.playMontage(clip, { maskMode: meta.mask === "full" ? "full" : "clip" });
      }
      return true;
    }
    return false;
  }

  /** Actors whose plasma blade is currently ignited (world hum-loop driver). */
  ignitedPlasmaActors(): Array<{ actorId: string; extension: number }> {
    const out: Array<{ actorId: string; extension: number }> = [];
    for (const [actorId, visual] of this.visuals) {
      if (visual.kind !== "pawn" || !visual.plasma) continue;
      if (visual.plasma.extension <= 0.35) continue;
      out.push({ actorId, extension: visual.plasma.extension });
    }
    return out;
  }

  /**
   * Saber-deflect parry: pick the directional clip from the incoming shot
   * bearing vs the defender's facing. Falls back to melee_flinch until the
   * deflect clips are cooked into the pack.
   */
  playDeflect(actorId: string, incomingX: number, incomingZ: number): void {
    const visual = this.visuals.get(actorId);
    if (!visual || visual.kind !== "pawn" || visual.deathState === "down") return;
    const bearing = Math.atan2(-incomingX, -incomingZ); // direction back toward the shooter
    let delta = bearing - visual.yaw;
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const side = Math.abs(delta) < Math.PI / 6 ? "c" : delta > 0 ? "l" : "r";
    const clip = `deflect_${side}`;
    const name = this.pack.clipMeta.has(clip) ? clip : "melee_flinch";
    visual.animator.playMontage(name, { maskMode: "clip" });
  }

  /**
   * REAL plasma-sword presentation (not the dev preview): when the actor's
   * equipped weapon snapshot carries weaponItemId 3104, the modeled vibrosword
   * hides and the hilt + blade FX ride the sword rig. Per-visual — any number
   * of pawns can ignite at once. energy blade doctrine: hilt + light only.
   */
  private syncPlasmaEquip(visual: PawnVisual, weapon: unknown, meleeArmed: boolean, stowed: boolean): void {
    const itemId = weapon !== null && typeof weapon === "object" && "weaponItemId" in weapon
      ? Number((weapon as { weaponItemId?: unknown }).weaponItemId ?? 0)
      : 0;
    const want = meleeArmed && itemId === PLASMA_SWORD_ITEM_ID && visual.sword !== null;
    if (!want) {
      if (visual.plasma) this.detachPlasmaEquip(visual);
      return;
    }
    const sword = visual.sword!;
    if (!visual.plasma) {
      sword.setFrameVisible(false);
      const blade = new PlasmaBlade(sword.frameRoot(), this.glowSpriteTexture, PLASMA_SWORD_COLOR);
      blade.setExtension(0); // ignites via the ramp — never pops in fully lit
      visual.plasma = { blade, hilt: null, extension: 0, targetExtension: stowed ? 0 : 1, debugDrawnOverride: null };
    }
    const drawn = visual.plasma.debugDrawnOverride ?? !stowed;
    visual.plasma.targetExtension = drawn ? 1 : 0;
    if (!visual.plasma.hilt) {
      if (this.plasmaHiltScene) {
        visual.plasma.hilt = this.plasmaHiltScene.clone(true);
        sword.frameRoot().add(visual.plasma.hilt);
      } else {
        this.ensurePlasmaHiltLoaded();
      }
    }
  }

  private detachPlasmaEquip(visual: PawnVisual): void {
    if (!visual.plasma) return;
    visual.plasma.blade.dispose();
    visual.plasma.hilt?.parent?.remove(visual.plasma.hilt);
    visual.plasma = null;
    visual.sword?.setFrameVisible(true);
  }

  private ensurePlasmaHiltLoaded(): void {
    if (this.plasmaHiltScene || this.plasmaHiltLoading) return;
    this.plasmaHiltLoading = true;
    void new GLTFLoader().loadAsync(requireRuntimePublicPath(`${SUCCESSOR_3D_CONFIG.pawnPack.basePath}/plasma_hilt.glb`)).then(
      (gltf) => {
        this.plasmaHiltScene = gltf.scene;
      },
      (error: unknown) => {
        console.warn("plasma hilt load failed", error);
        this.plasmaHiltLoading = false;
      },
    );
  }

  /**
   * DEV seam: toggle the plasma ignition ramp on the first plasma-equipped
   * pawn (presentation-only). Tests the extension tween + endpoints ONLY —
   * it does NOT unstow the sword rig; the production ignition is driven by
   * the wield pose (syncPlasmaEquip reads pose.stowed), so in-game the blade
   * always ignites in hand on draw and retracts on stow.
   */
  plasmaIgniteTest(): boolean {
    for (const visual of this.visuals.values()) {
      if (visual.kind !== "pawn" || !visual.plasma) continue;
      const plasma = visual.plasma;
      plasma.debugDrawnOverride = plasma.debugDrawnOverride === null ? plasma.targetExtension < 0.5 : plasma.debugDrawnOverride ? false : true;
      return true;
    }
    return false;
  }

  plasmaBladePreview(colorHex?: number): boolean {
    const palette = [0x63f0ff, 0xff4fd8, 0x7dff5a, 0xffb63f, 0xb987ff, 0xff3b30];
    for (const visual of this.visuals.values()) {
      if (visual.kind !== "pawn" || !visual.sword) continue;
      if (this.plasmaPreview) {
        this.disposePlasmaPreview();
        if (colorHex === undefined && this.plasmaPreviewColorIdx % (palette.length + 1) === palette.length) {
          this.plasmaPreviewColorIdx = 0;
          return true; // full cycle -> off state
        }
      }
      const color = colorHex ?? palette[this.plasmaPreviewColorIdx % palette.length]!;
      this.plasmaPreviewColorIdx += 1;
      const sword = visual.sword;
      // energy blade doctrine: modeled weapon hidden — hilt GLB + light only
      sword.setFrameVisible(false);
      this.plasmaHostSword = sword;
      this.plasmaPreview = new PlasmaBlade(sword.frameRoot(), this.glowSpriteTexture, color);
      this.attachPlasmaHilt(sword);
      sword.setStowed(false, { snap: true });
      return true;
    }
    return false;
  }

  private disposePlasmaPreview(): void {
    this.plasmaPreview?.dispose();
    this.plasmaPreview = null;
    if (this.plasmaHiltInstance) {
      this.plasmaHiltInstance.parent?.remove(this.plasmaHiltInstance);
      this.plasmaHiltInstance = null;
    }
    this.plasmaHostSword?.setFrameVisible(true);
    this.plasmaHostSword = null;
  }

  private attachPlasmaHilt(sword: SwordRig): void {
    if (this.plasmaHiltScene) {
      this.plasmaHiltInstance = this.plasmaHiltScene.clone(true);
      sword.frameRoot().add(this.plasmaHiltInstance);
      return;
    }
    this.ensurePlasmaHiltLoaded();
    // late attach when the shared scene lands (next preview click also works)
    const host = sword;
    const retry = window.setInterval(() => {
      if (!this.plasmaHiltScene) return;
      window.clearInterval(retry);
      if (this.plasmaPreview && this.plasmaHostSword === host && !this.plasmaHiltInstance) {
        this.plasmaHiltInstance = this.plasmaHiltScene.clone(true);
        host.frameRoot().add(this.plasmaHiltInstance);
      }
    }, 250);
  }

  // ---------------------------------------------------------------------
  // Gaia creatures (cozy adult GLBs) — rigged creature lane
  // ---------------------------------------------------------------------

  /** Lazily load (once per species) the shared creature GLB template. */
  private ensureCreatureTemplate(spriteKey: string, species: CreatureSpeciesDef): void {
    if (this.creatureTemplates.has(spriteKey) || this.creatureTemplatesLoading.has(spriteKey)) return;
    this.creatureTemplatesLoading.add(spriteKey);
    void new GLTFLoader().loadAsync(requireRuntimePublicPath(species.assetPath)).then(
      (gltf) => {
        const root = gltf.scene;
        const animations = gltf.animations ?? [];
        const clip = (name: string): AnimationClip | null => animations.find((a) => a.name === name) ?? null;
        // Convert every source mesh material SEPARATELY: each converted
        // material carries its own authored BaseColor map into the unlit
        // matcap path with a neutral white multiplier, so the per-part
        // authored palettes (body/sac/face/…) survive posterize+dither.
        const convertedBySource = new Map<Material, MeshMatcapMaterial>();
        const materials: MeshMatcapMaterial[] = [];
        const convert = (source: Material): MeshMatcapMaterial => {
          const existing = convertedBySource.get(source);
          if (existing) return existing;
          const map = "map" in source && source.map instanceof Texture ? source.map : null;
          const material = new MeshMatcapMaterial({ matcap: this.matcap, map, color: 0xffffff });
          installPawnRim(material);
          convertedBySource.set(source, material);
          materials.push(material);
          return material;
        };
        root.traverse((object) => {
          if (!(object instanceof Mesh)) return;
          object.material = Array.isArray(object.material)
            ? object.material.map((source: Material) => convert(source))
            : convert(object.material);
        });
        this.creatureTemplates.set(spriteKey, {
          root,
          idleClip: clip(CREATURE_IDLE_CLIP),
          walkClip: clip(CREATURE_WALK_CLIP),
          restClip: clip(CREATURE_REST_CLIP),
          materials,
        });
        this.creatureTemplatesLoading.delete(spriteKey);
      },
      (error: unknown) => {
        console.warn(`Failed to load creature GLB for ${spriteKey}`, error);
        this.creatureTemplatesLoading.delete(spriteKey);
      },
    );
  }

  private createCreatureVisual(
    actorId: string,
    actor: RenderActor,
    species: CreatureSpeciesDef,
    x: number,
    z: number,
  ): CreatureVisual {
    const spriteKey = "sprite" in actor && typeof actor.sprite === "string" ? actor.sprite : "";
    this.ensureCreatureTemplate(spriteKey, species);
    const group = new Group();
    group.name = `pawn:${actorId}`;
    const sliceScale = "scale" in actor && typeof actor.scale === "number" ? actor.scale : null;
    const visualScale = sliceScale ?? 1;
    const shadow = new Mesh(shadowGeometry, this.shadowMaterial(SUCCESSOR_3D_CONFIG.pawn.defaultTint));
    shadow.name = `pawn-shadow:${actorId}`;
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.012;
    // Species footprint from the registry (measured GLB bounds); the ellipse
    // rotates with the body so X = lateral, Z = nose-to-tail.
    shadow.scale.set(species.shadowScaleX * visualScale, species.shadowScaleZ * visualScale, 1);
    group.add(shadow);
    this.scene.add(group);
    const visual: CreatureVisual = {
      kind: "creature",
      group,
      shadow,
      spriteKey,
      species,
      visualScale,
      skinnedRoot: null,
      mixer: null,
      idleAction: null,
      walkAction: null,
      restAction: null,
      activeClip: "",
      moving: false,
      yaw: "direction" in actor && typeof actor.direction === "string" ? yawForDirection(actor.direction) : 0,
      lastX: x,
      lastZ: z,
      lastSeenFrame: this.frame,
      colorKey: "",
      lodHiFi: false,
      deathState: "none",
      bornDown: "lifeState" in actor && actor.lifeState === "downed",
      deathGraceElapsed: 0,
      lastStimCount: -1,
      lastStimMaxRemainingMs: 0,
      poseBaseOverride: null,
      sleeping: false,
      lastLifecycleSeq: "lifecycleSeq" in actor ? actor.lifecycleSeq : 0,
      pendingHit: null,
      pendingDeathYaw: null,
      pendingDeathKind: null,
    };
    this.visuals.set(actorId, visual);
    return visual;
  }

  /** Lazily clone the shared species template into this creature's group. */
  private attachCreatureMesh(visual: CreatureVisual): void {
    const template = this.creatureTemplates.get(visual.spriteKey);
    if (!template || visual.skinnedRoot) return;
    const clone = SkeletonUtils.clone(template.root);
    clone.scale.setScalar(visual.species.meshScale * visual.visualScale);
    visual.skinnedRoot = clone;
    visual.group.add(clone);
    const mixer = new AnimationMixer(clone);
    visual.mixer = mixer;
    if (template.idleClip) visual.idleAction = mixer.clipAction(template.idleClip);
    if (template.walkClip) visual.walkAction = mixer.clipAction(template.walkClip);
    if (template.restClip) {
      const rest = mixer.clipAction(template.restClip);
      rest.setLoop(LoopOnce, 1);
      rest.clampWhenFinished = true;
      visual.restAction = rest;
    }
    // Seed the starting clip. A mesh attaching onto an already-down actor
    // (join-in-progress corpse, or a death that beat the async GLB) always
    // snaps straight to the shared downed hold — never replays the settle.
    this.applyCreatureIntent(
      visual,
      resolveCreatureAnimIntent({
        down: visual.deathState === "down",
        bornDown: true,
        moving: visual.moving,
        speedCellsPerSec: 0,
      }),
      0,
    );
  }

  /**
   * Drive the mixer toward the intent's clip with a short cross-fade. The
   * one-shot `rest` clip freezes at its measured downed hold; snapToHold
   * corpses skip playback and hold that frame immediately. A missing target clip
   * (partial GLB / load failure) falls back to a FROZEN idle/walk frame so
   * the creature never T-poses.
   */
  private applyCreatureIntent(visual: CreatureVisual, intent: CreatureAnimIntent, dtSeconds: number): void {
    const mixer = visual.mixer;
    if (!mixer) return;
    const actions: Record<CreatureClipName, AnimationAction | null> = {
      idle: visual.idleAction,
      walk: visual.walkAction,
      rest: visual.restAction,
    };
    let clip: CreatureClipName = intent.clip;
    let target = actions[clip];
    let frozen = false;
    if (!target) {
      clip = actions.idle ? "idle" : "walk";
      target = actions[clip];
      frozen = true;
    }
    if (target && visual.activeClip !== clip) {
      const snap = clip === "rest" && intent.snapToHold;
      for (const name of ["idle", "walk", "rest"] as const) {
        const action = actions[name];
        if (!action || name === clip) continue;
        // A held corpse action is paused deliberately. Leaving it must reset
        // that action instead of letting the reversible get-up frames leak into
        // the alive pose or leaving it paused for the next lifecycle.
        if (name === "rest" && clip !== "rest") {
          action.paused = false;
          action.stop();
        } else if (action.paused) {
          action.paused = false;
          action.stop();
        } else if (!snap && visual.activeClip === name) action.fadeOut(CREATURE_CLIP_FADE_SECONDS);
        else action.stop();
      }
      target.paused = false;
      if (snap) {
        target.reset().play();
        target.setEffectiveWeight(1);
      } else {
        target.reset().fadeIn(CREATURE_CLIP_FADE_SECONDS).play();
      }
      visual.activeClip = clip;
    }
    const frameSeconds = Math.min(Math.max(0, dtSeconds), 0.1);
    if (!target) {
      mixer.update(frameSeconds);
      return;
    }
    if (frozen) {
      target.paused = false;
      target.setEffectiveTimeScale(0);
      mixer.update(frameSeconds);
      return;
    }
    if (clip === "rest") {
      const playback = resolveCreatureRestPlayback({
        clipDurationSeconds: target.getClip().duration,
        currentTimeSeconds: target.time,
        dtSeconds: frameSeconds,
        snapToHold: intent.snapToHold,
      });
      target.setEffectiveTimeScale(1);
      if (playback.advanceSeconds > 0) {
        target.paused = false;
        mixer.update(playback.advanceSeconds);
      }
      if (playback.shouldPause) {
        target.time = playback.holdTimeSeconds;
        mixer.update(0);
        target.paused = true;
      }
      return;
    }
    target.paused = false;
    target.setEffectiveTimeScale(clip === "walk" ? intent.timeScale : 1);
    mixer.update(frameSeconds);
  }

  private renderCreature(
    visual: CreatureVisual,
    actor: RenderActor,
    actorId: string,
    x: number,
    z: number,
    dtSeconds: number,
    state: PlayState,
    slice: SliceSnapshot,
  ): void {
    const config = SUCCESSOR_3D_CONFIG.pawnPack;
    const displacementX = x - visual.lastX;
    const displacementZ = z - visual.lastZ;
    const frameDisplacement = Math.hypot(displacementX, displacementZ);
    let velocityX = 0;
    let velocityZ = 0;
    if ("renderVelocityX" in actor && Number.isFinite(actor.renderVelocityX)) {
      velocityX = actor.renderVelocityX ?? 0;
      velocityZ = actor.renderVelocityY ?? 0;
    } else if (dtSeconds > 0) {
      velocityX = displacementX / dtSeconds;
      velocityZ = displacementZ / dtSeconds;
    }
    let speed = Math.hypot(velocityX, velocityZ);
    const displacementSpeed = dtSeconds > 0 ? frameDisplacement / dtSeconds : 0;
    if (dtSeconds > 0 && speed <= config.idleSpeedCellsPerSec && displacementSpeed > config.idleSpeedCellsPerSec) {
      velocityX = displacementX / dtSeconds;
      velocityZ = displacementZ / dtSeconds;
      speed = Math.hypot(velocityX, velocityZ);
    }
    const moving = speed > config.idleSpeedCellsPerSec
      || displacementSpeed > config.idleSpeedCellsPerSec
      || frameDisplacement > SUCCESSOR_3D_CONFIG.pawn.velocityYawEpsilonCellsPerFrame;
    visual.moving = moving;

    const lifeState = "lifeState" in actor ? actor.lifeState : "alive";
    const lifecycleSeq = "lifecycleSeq" in actor ? actor.lifecycleSeq : 0;
    const down = lifeState !== "alive";
    if (down && visual.deathState === "none") {
      visual.deathState = "down";
      this.applyShadowTint(visual, actor, state, slice, false);
    } else if (!down && visual.deathState === "down" && lifecycleSeq !== visual.lastLifecycleSeq) {
      // Lifecycle revive: the seq bump distinguishes a real respawn from
      // authority flicker; the intent below fades rest back into idle/walk.
      visual.deathState = "none";
      this.applyShadowTint(visual, actor, state, slice, false);
    }
    if (!down) visual.bornDown = false;
    visual.lastLifecycleSeq = lifecycleSeq;
    const isDown = visual.deathState === "down";

    if (!visual.skinnedRoot) this.attachCreatureMesh(visual);
    if (visual.mixer) {
      this.applyCreatureIntent(
        visual,
        resolveCreatureAnimIntent({ down: isDown, bornDown: visual.bornDown, moving, speedCellsPerSec: speed }),
        dtSeconds,
      );
    }

    if (moving && !isDown) {
      const targetYaw = Math.atan2(velocityX, velocityZ);
      const yawDelta = wrapAngle(targetYaw - visual.yaw);
      const maxStep = config.yawLerpRadPerSec * dtSeconds;
      visual.yaw = wrapAngle(visual.yaw + Math.min(maxStep, Math.max(-maxStep, yawDelta)));
    }
    visual.group.rotation.y = visual.yaw;
    visual.group.position.set(x, 0, z);
    if (visual.deathState === "none") {
      this.applyShadowTint(visual, actor, state, slice, false);
    }

    visual.lastX = x;
    visual.lastZ = z;
    visual.lastSeenFrame = this.frame;
  }

  private ensureSlugthrower(visual: PawnVisual, armed: boolean, assetKey: string | null = null): void {
    if (!armed || visual.slugthrower) return;
    const handR = visual.animator.bone("hand_r");
    if (!handR) return;
    // Resolve the per-weapon model (dark GLB + mount-transfer attach spec +
    // scale-to-pawn). Absent -> the SlugthrowerRig ctor falls back to the Slugthrower.
    const model = assetKey ? this.pack.weapons.get(assetKey) ?? null : null;
    visual.slugthrower = new SlugthrowerRig(
      this.pack,
      handR,
      visual.animator.bone("upperarm_l"),
      visual.animator.bone("lowerarm_l"),
      visual.animator.bone("hand_l"),
      visual.animator.bone("spine_03") ?? visual.animator.bone("spine_02"),
      model?.spec,
      model?.scene,
      model?.scale,
    );
    markSunShadowCaster(visual.bodyRoot);
  }

  private ensureSword(visual: PawnVisual, armed: boolean, assetKey: string | null = null): void {
    if (!armed || visual.sword) return;
    const handR = visual.animator.bone("hand_r");
    if (!handR) return;
    const model = assetKey ? this.pack.weapons.get(assetKey) ?? null : null;
    visual.sword = new SwordRig(
      this.pack,
      handR,
      visual.animator.bone("spine_03") ?? visual.animator.bone("spine_02"),
      model?.spec,
      model?.scene,
      model?.scale,
      model ? `melee:${assetKey}` : "vibrosword",
    );
    markSunShadowCaster(visual.bodyRoot);
  }


  private attachDefaultEquipment(
    visual: PawnVisual,
    actorId: string,
    actor: RenderActor,
    isLocalPlayer: boolean,
    resolvedItemIds?: readonly string[],
  ): void {
    for (let i = 0; i < visual.equipmentAttachments.length; i += 1) {
      visual.equipmentAttachments[i]!.parent?.remove(visual.equipmentAttachments[i]!);
    }
    visual.equipmentAttachments.length = 0;
    visual.equipmentMaterialGeneration += 1;

    const appearance = actorAppearance(actor);
    const worn = actorWorn(actor);
    const itemIds = resolvedItemIds ?? this.defaultEquipmentIds(actorId, actor, isLocalPlayer);
    visual.resolvedEquipmentIds = itemIds as string[];
    visual.legsCovered = visual.body === "male"
      && equipmentIdsCoverLegs(this.pack.equipment.items, itemIds, this.equipmentLookup);
    visual.hairMaterialId = normalizedHairMaterialId(appearance);
    visual.wornColorsByPiece = worn
      ? new Map(worn.map((piece) => [piece.item, piece.colors] as const))
      : null;
    visual.equipmentAppearance = {
      hairId: normalizedServerHairId(appearance),
      hairMaterialId: visual.hairMaterialId,
      face: appearance?.face
        ? [
          appearance.face.eyes,
          appearance.face.brows,
          appearance.face.nose,
          appearance.face.mouth,
          appearance.face.eye_color,
          appearance.face.brow_color,
          appearance.face.lip_color,
        ]
        : null,
      worn: worn
        ? worn.map((piece) => ({ item: piece.item, colors: [...piece.colors] }))
        : null,
    };
    if (isLocalPlayer) {
      writeCurrentCharacterAppearanceCache({
        body: visual.body,
        skinTone: normalizedSkinTone(appearance),
        hair: normalizedServerHairId(appearance),
        hairMat: normalizedHairMaterialId(appearance) ?? "hair_raven",
        equipmentIds: itemIds,
        worn: worn ?? [],
        face: appearance?.face
          ? {
            eyes: appearance.face.eyes,
            brows: appearance.face.brows,
            nose: appearance.face.nose,
            mouth: appearance.face.mouth,
            eyeColor: appearance.face.eye_color,
            browColor: appearance.face.brow_color,
            lipColor: appearance.face.lip_color,
          }
          : null,
      });
    }
    attachPawnEquipmentSet(
      this.pack,
      visual.bodyRoot,
      itemIds,
      (item, source) => this.equipmentMaterial(item, source, visual.hairMaterialId, visual.wornColorsByPiece),
      visual.equipmentAttachments,
    );
    attachPawnFaceDecal(visual.bodyRoot, appearance?.face ?? null, visual.equipmentAttachments);
    markSunShadowCaster(visual.bodyRoot);
    const materialGeneration = visual.equipmentMaterialGeneration;
    void getEquipmentMaterialSets().then(() => {
      if (this.visuals.get(actorId) !== visual || visual.equipmentMaterialGeneration !== materialGeneration) return;
      this.refreshEquipmentMaterials(visual);
    });
  }

  private defaultEquipmentIds(actorId: string, actor: RenderActor, isPlayerRole: boolean): string[] {
    const availableIds = this.equipmentLookup.availableIds;
    if (this.equipmentLookup.itemIds.length === 0) return [];

    if (isPlayerRole) {
      const appearance = actorAppearance(actor);
      const worn = actorWorn(actor);
      return resolveAuthoritativeActorEquipmentIds({
        availableIds,
        authorityWornIds: worn?.map((piece) => piece.item) ?? [],
        savedHairId: normalizedServerHairId(appearance),
      });
    }

    return defaultRemotePawnEquipmentIds(this.pack, actorId, actor);
  }

  private equipmentMaterial(
    item: PawnEquipmentItem,
    source: EquipmentSlotMaterialSource,
    hairMaterialId: string | null,
    wornColorsByPiece: ReadonlyMap<string, readonly string[]> | null,
  ): Material | Material[] {
    const manifestMat = isHairEquipment(item.id) && hairMaterialId ? hairMaterialId : item.mat;
    return resolveEquipmentSlotMaterial(source, item, manifestMat, { kind: "world", matcap: this.matcap }, wornColorsByPiece?.get(item.id) ?? null);
  }

  private refreshEquipmentMaterials(visual: PawnVisual): void {
    for (let i = 0; i < visual.equipmentAttachments.length; i += 1) {
      const attachment = visual.equipmentAttachments[i]!;
      if (!(attachment instanceof Mesh)) continue;
      const pieceId = typeof attachment.userData.successorEquipmentItemId === "string"
        ? attachment.userData.successorEquipmentItemId
        : null;
      if (!pieceId) continue;
      const item = this.pack.equipment.items.find((candidate) => candidate.id === pieceId);
      if (!item) continue;
      const manifestMat = isHairEquipment(pieceId) && visual.hairMaterialId ? visual.hairMaterialId : item.mat;
      attachment.material = resolveEquipmentSlotMaterial(
        equipmentSourceMaterialFromUserData(attachment),
        item,
        manifestMat,
        { kind: "world", matcap: this.matcap },
        visual.wornColorsByPiece?.get(pieceId) ?? null,
      );
    }
  }

  private bodyForActor(actorId: string, actor: RenderActor, slice: SliceSnapshot): PawnBody {
    return pawnBodyForActor(actorId, actor, slice);
  }

  private applyBodyTint(
    visual: PawnVisual,
    actor: RenderActor,
    actorId: string,
    state: PlayState,
    slice: SliceSnapshot,
  ): void {
    const relation = actorNameplateColor(actor, slice, state) ?? SUCCESSOR_3D_CONFIG.pawn.defaultTint;
    const selected = actorId === state.selectedActorId;
    const skinTone = normalizedSkinTone(actorAppearance(actor));
    const colorKey = `${skinTone}|${relation}${selected ? "!s" : ""}`;
    if (colorKey === visual.colorKey) return;
    visual.colorKey = colorKey;
    const material = this.bodyMaterial(skinTone, relation, selected);
    for (const mesh of visual.skinnedMeshes) mesh.material = material;
    if (visual.deathState === "none" && !visual.sleeping) {
      visual.shadow.material = this.shadowMaterial(relation);
    }
  }

  private applyShadowTint(
    visual: VisualBase,
    actor: RenderActor,
    state: PlayState,
    slice: SliceSnapshot,
    sleeping: boolean,
  ): void {
    if (sleeping) {
      visual.shadow.material = this.shadowMaterial(SUCCESSOR_3D_CONFIG.pawnPack.sleepingShadowTint);
      return;
    }
    const relation = actorNameplateColor(actor, slice, state) ?? SUCCESSOR_3D_CONFIG.pawn.defaultTint;
    visual.shadow.material = this.shadowMaterial(relation);
  }

  private bodyMaterial(skinTone: string, relationColor: string, selected: boolean): MeshMatcapMaterial {
    const key = `${skinTone}|${relationColor}${selected ? "!s" : ""}`;
    const existing = this.bodyMaterials.get(key);
    if (existing) return existing;
    scratchColor.set(relationColor);
    const color = new Color(skinTone).lerp(scratchColor, SUCCESSOR_3D_CONFIG.pawnPack.bodyTintLerp);
    if (selected) color.lerp(scratchColor.set(SUCCESSOR_3D_CONFIG.pawn.selectedTint), 0.35);
    const material = new MeshMatcapMaterial({ matcap: this.matcap, color });
    installPawnRim(material);
    this.bodyMaterials.set(key, material);
    return material;
  }

  private shadowMaterial(tint: string): MeshBasicMaterial {
    const existing = this.shadowMaterials.get(tint);
    if (existing) return existing;
    scratchColor.set("#080706").lerp(new Color(tint), SUCCESSOR_3D_CONFIG.pawnPack.shadowTintLerp * 0.4);
    const material = new MeshBasicMaterial({
      color: scratchColor.getHex(),
      alphaMap: shadowAlphaTexture,
      transparent: true,
      opacity: SUCCESSOR_3D_CONFIG.pawn.shadowOpacity,
      depthWrite: false,
    });
    this.shadowMaterials.set(tint, material);
    return material;
  }

  private removeVisual(actorId: string, visual: ActorVisual): void {
    this.scene.remove(visual.group);
    if (visual.kind === "pawn") {
      this.detachPlasmaEquip(visual);
      visual.slugthrower?.dispose();
      visual.sword?.dispose();
      visual.animator.dispose();
    } else {
      // Creature: geometry/materials are shared from the species template
      // (never per-clone disposed); just halt the mixer so it stops sampling.
      visual.mixer?.stopAllAction();
    }
    this.shellMeshCache.delete(actorId);
    this.visuals.delete(actorId);
  }
}



function weaponModelAssetKeyForActor(actor: RenderActor): string | null {
  // Verification hook (harness smoke / attach-proof loop), mirrors
  // window.__successor3dWeapon / __successorFx: force the modeled weapon on
  // armed pawns without a server weapon change. Unset in normal play.
  const override = typeof window !== "undefined"
    ? (window as { __successorWeaponModel?: string }).__successorWeaponModel
    : undefined;
  if (override) return override;
  const weapon = "weapon" in actor ? actor.weapon : null;
  const itemId = weapon !== null && typeof weapon === "object" && "weaponItemId" in weapon
    ? Number(weapon.weaponItemId ?? 0)
    : 0;
  const weaponId = weapon?.weaponId ? String(weapon.weaponId) : null;
  return weaponModelAssetKey(itemId, weaponId);
}

export function equippedWeaponIdForActor(actor: RenderActor): string | null {
  // A present authority weapon field is definitive, including null. This is
  // what lets an ordinary Brawler unequip the starter machete (or fight
  // unarmed) without the presentation layer conjuring a profession weapon.
  if ("weapon" in actor) {
    return actor.weapon?.weaponId ? String(actor.weapon.weaponId) : null;
  }
  // Legacy fixtures without a weapon field still get a readable NPC loadout.
  const role = "role" in actor && typeof actor.role === "string" ? actor.role : "";
  const professionIds = "professionIds" in actor && Array.isArray(actor.professionIds) ? actor.professionIds : [];
  if (role === "skirmisher_brawler" || professionIds.includes("brawler")) return "scrapline-machete";
  if (role.startsWith("skirmisher") || professionIds.includes("marksman")) return "slugthrower";
  return null;
}

export function weaponLaneForActor(actor: RenderActor): WeaponLane {
  const weaponId = equippedWeaponIdForActor(actor);
  if (isMeleeWeaponPresentation(weaponId)) return "melee";
  if (weaponId) return "rifle";
  return "none";
}


function isMeleeCombatEvent(event: ServerAuthorityCombatEventState, state: PlayState): boolean {
  const eventWeaponId = event.weaponId === undefined ? null : String(event.weaponId);
  if (isMeleeWeaponPresentation(eventWeaponId, event.ammoTypeId)) return true;
  const shooterWeaponId = state.serverAuthority.actors[event.shooterActorId]?.weapon?.weaponId;
  if (!isMeleeWeaponPresentation(shooterWeaponId, event.ammoTypeId)) return false;
  return typeof event.kind === "string" && event.kind.includes("melee");
}
