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
  mat?: string;
  requires: readonly string[];
  /** Asset-Lab-only items: visible in the viewer, never in the game wardrobe. */
  viewerOnly?: boolean;
}

export interface PawnEquipmentPack {
  basePath: string;
  items: readonly PawnEquipmentItem[];
  scenes: ReadonlyMap<string, Group>;
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
  };
  nodes: { frame: string; mag?: string };
  /** Uniform scale-to-pawn baked into the weaponRoot (slugthrower=1). */
  scale?: number;
  /** silhouette class (pistol/smg/rifle/shotgun/launcher/melee) for stow/pose selection. */
  silhouetteClass?: string;
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
