import { AnimationClip, Group, Quaternion, Vector3 } from "three";

export type PawnBody = "male" | "female";
export type ClipLayer = "base" | "upper" | "hand" | "montage" | "arm";

/** Single validator for manifest clip layers — viewer and runtime MUST share it
 * so a new layer (e.g. the medic wave's "arm") cannot silently break one side. */
export function toClipLayer(layer: string, name: string): ClipLayer {
  if (layer === "base" || layer === "upper" || layer === "hand" || layer === "montage" || layer === "arm") return layer;
  throw new Error(`pawn pack: unknown layer "${layer}" for clip "${name}"`);
}
export type PawnEquipmentLayer = "Armor" | "Under";

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
  /** Asset-Lab-only items: visible in the viewer, never in the game wardrobe. */
  viewerOnly?: boolean;
}

export interface PawnEquipmentPack {
  basePath: string;
  items: readonly PawnEquipmentItem[];
  scenes: ReadonlyMap<string, Group>;
  femaleScenes?: ReadonlyMap<string, Group>;
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

/**
 * Per-model out-of-combat carry, authored in the weapon's own attach json as
 * `stow_socket`. Dissimilar geometry (a +Z-blade cleaver vs a +Y-blade
 * machete, a bullpup vs a long-tailed LMG) cannot share one carry transform,
 * so each model brings its own. Absent -> the rig falls back to the legacy
 * class default in config, which is what keeps the legacy Slugthrower and
 * Vibrosword byte-identical in pose.
 */
export interface WeaponStowSpec {
  /** spine_03-local socket position. */
  pos: Vector3;
  /** spine_03-local XYZ Euler, degrees. */
  rotDeg: Vector3;
  /** Peak of the world-space draw/sheath arc, metres. */
  arcLift: number;
}

/**
 * Per-model SUPPORT-ARM hold posture, authored in the weapon's own attach json
 * as `hold.support_arm`. A support socket that sits beyond the arm's own
 * reach (upperarm + lowerarm) makes the two-bone solver clamp to a locked
 * straight arm: the elbow collapses onto the shoulder->wrist line and the limb
 * becomes a rod laid along the weapon. This block tells the solver to keep a
 * minimum elbow bend, buy back the reach that bend costs by swinging the
 * shoulder girdle toward the target, and roll the retained bend to a chosen
 * pole angle. Absent -> the legacy unposed solve, unchanged.
 */
export interface SupportArmSpec {
  /** Smallest elbow bend the hold may leave, radians away from straight. */
  minBendRad: number;
  /** Metres the clavicle may swing the shoulder toward an out-of-reach target. */
  shoulderAdvanceMaxM: number;
  /**
   * Elbow roll about the shoulder->wrist axis, radians, measured from
   * world-down and positive toward `axis x down` (anatomically outboard for
   * the support arm). The accepted legacy hold sits near +0.6 rad.
   */
  poleRad: number;
}

export interface SlugthrowerAttachSpec {
  /** hand_r-local mount transform — USER-TUNED, applied verbatim. */
  mountPos: Vector3;
  mountQuat: Quaternion;
  /** Sockets in weapon-GLB-local glTF space. */
  sockets: {
    grip: Vector3;
    foregrip: Vector3;
    muzzle: Vector3;
    stock: Vector3;
    /**
     * Weapon-local SUPPORT-WRIST target. Authored per model because the
     * global foregrip contact offset assumes the legacy handguard radius and
     * scale — on a fat, scaled, or caged handguard it buries the wrist inside
     * the shroud. Absent -> foregrip + the global contact offset (legacy).
     */
    foregripContact?: Vector3;
  };
  nodes: { frame: string; mag?: string };
  /** Uniform scale-to-pawn baked into the weaponRoot (slugthrower=1). */
  scale?: number;
  /** silhouette class (pistol/smg/rifle/shotgun/launcher/melee) for stow/pose selection. */
  silhouetteClass?: string;
  /** Authored back carry; absent -> config.pawnPack.weaponStow. */
  stow?: WeaponStowSpec;
  /** Non-aiming bore yaw offset, radians; absent -> config boreLevel.restingYawRad. */
  restingYawRad?: number;
  /** Authored support-arm hold posture; absent -> the legacy unposed solve. */
  supportArm?: SupportArmSpec;
}

export interface VibroswordAttachSpec {
  /** hand_r-local mount transform — USER-TUNED, applied verbatim. */
  mountPos: Vector3;
  mountQuat: Quaternion;
  /** Sockets in vibrosword-GLB-local glTF space. */
  sockets: {
    guardPlane: Vector3;
    wrapTop: Vector3;
    wrapMid: Vector3;
    wrapBottom: Vector3;
    pommel: Vector3;
  };
  nodes: { frame: string };
  /** Authored back carry; absent -> config.pawnPack.swordStow. */
  stow?: WeaponStowSpec;
}

export interface TorsoYawRecipe {
  /** boneName -> weight (spine_01 .25, spine_03 .60, neck_01 .15). */
  weights: ReadonlyArray<readonly [string, number]>;
  maxRad: number;
}

/** A registered weapon: hand-authored GLB scene + calibrated attach spec. */
export interface WeaponModel {
  scene: Group;
  spec: SlugthrowerAttachSpec;
  scale: number;
  silhouetteClass: string;
}

export interface PawnPack {
  bodies: Record<PawnBody, Group>;
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
  /** assetKey -> weapon model (hand-authored GLB + mount-transfer attach spec). */
  weapons: ReadonlyMap<string, WeaponModel>;
  equipment: PawnEquipmentPack;
  /** Uniform instance-root scale: contract height / cooked mesh height. */
  scale: number;
}

/** GLTFLoader keeps node names as authored; track names are "<node>.<property>". */
export function sane(name: string): string {
  return name.replace(/\s/g, "_").replace(/[\[\].:\/]/g, "");
}
