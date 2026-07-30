// stage.ts — Asset Lab 3D stage + pawn actor.
//
// LabPawn consumes the RUNTIME modules directly — attachPawnEquipmentSet,
// resolveEquipmentSlotMaterial, PawnAnimator/MaskedClipCache, SlugthrowerRig /
// SwordRig, clonePawnBody/cloneSpecialPawnBody — so what the lab shows IS what
// the game renders. Nothing in this file re-implements runtime attach,
// material, or animation logic; the classes here are stage plumbing (camera,
// lights, transport clock, prop pedestal).
import {
  AmbientLight,
  AnimationMixer,
  Bone,
  Box3,
  CanvasTexture,
  LoopOnce,
  type AnimationClip,
  Color,
  DirectionalLight,
  Fog,
  FogExp2,
  Group,
  LinearFilter,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshMatcapMaterial,
  Object3D,
  OrthographicCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  SkeletonHelper,
  SkinnedMesh,
  SRGBColorSpace,
  Texture,
  Vector3,
  WebGLRenderer,
  type WebGLRendererParameters,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { SUCCESSOR_3D_CONFIG } from "../../config";
import { clonePawnBody, cloneSpecialPawnBody, type PawnBody, type PawnPack, type SlugthrowerAttachSpec } from "../../assets/pawnPack";
import { resolveEquipmentSlotMaterial, type EquipmentSlotMaterialSource } from "../../assets/equipmentMaterials";
import type { PawnEquipmentItem } from "../../assets/pawnRigTypes";
import { attachPawnEquipmentSet } from "../../render/pawns";
import { MaskedClipCache } from "../../render/anim/maskedClips";
import { PawnAnimator, type ActiveClipsByLayer, type MontageMaskMode } from "../../render/anim/PawnAnimator";
import { Ps2PostRenderer } from "../../render/post";
import { paintTerrainPixel } from "../../render/terrain/procgen";
import { SlugthrowerRig } from "../../render/weapons/slugthrowerRig";
import { SwordRig } from "../../render/weapons/swordRig";
import type { WorldEnvironment } from "../../render/environment";
import { LabFx } from "./fx";

export type LabBodyKey = PawnBody | "droid_grok_humanoid";
export const DROID_BODY_KEY = "droid_grok_humanoid";

export type CameraPresetName = "quarter" | "front" | "side" | "close" | "grip";
export const CAMERA_PRESET_ORDER: readonly CameraPresetName[] = ["quarter", "front", "side", "close", "grip"];

const RENDERER_OPTIONS: WebGLRendererParameters = { antialias: false, alpha: false, powerPreference: "high-performance" };
const WORLD_UP = new Vector3(0, 1, 0);
const STAGE_GROUND_SIZE = 22;
const STAGE_GROUND_PIXELS = 256;
const CAMERA_DISTANCE = SUCCESSOR_3D_CONFIG.camera.distanceCells;
const TURNTABLE_RADIANS_PER_SECOND = 0.55;
const BODY_SKIN_COLOR = "#cc9978";
const PROP_PEDESTAL_X = 1.9;

const PRESET_DIRECTIONS: Readonly<Record<CameraPresetName, Vector3>> = {
  quarter: new Vector3(0.68, 0.56, 0.68).normalize(),
  front: new Vector3(0.04, 0.24, 0.97).normalize(),
  side: new Vector3(0.97, 0.24, 0.04).normalize(),
  close: new Vector3(0.16, 0.2, 0.97).normalize(),
  grip: new Vector3(0.55, 0.14, 0.82).normalize(),
};

const scratchBox = new Box3();
const scratchCenter = new Vector3();
const scratchSize = new Vector3();
const scratchDirection = new Vector3();
const reloadProgressScratch = { elapsedS: 0, totalS: 0 };
const gripScratch = new Vector3();
const handScratch = new Vector3();
const cornerScratch = new Vector3();

// ─── clip → weapon-context predicates (lab presentation policy) ──────────────

/** Clip poses/uses a gun: the rifle lane plus reload + grip overlays. */
export function clipUsesGun(clipName: string): boolean {
  return clipName.startsWith("rifle_") || clipName === "reload" || clipName.startsWith("gun_grip");
}

/** Clip poses/uses a melee weapon: melee lane, swings, blocks, melee lab. */
export function clipUsesMelee(clipName: string): boolean {
  return clipName.startsWith("melee_")
    || clipName.startsWith("swing_")
    || clipName.startsWith("mlab_mix_")
    || clipName === "block_hold"
    || clipName.startsWith("deflect_");
}

function isMeleeSwingPreviewClip(clipName: string): boolean {
  return clipName === "swing_h1" || clipName === "swing_h2" || clipName === "swing_h3" || clipName === "swing_spin_aoe";
}

// ─── shared stage assets ─────────────────────────────────────────────────────

function createMatcapTexture(stops: ReadonlyArray<readonly [number, string]>): Texture {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const gradient = ctx.createRadialGradient(size * 0.5, size * 0.3, size * 0.05, size * 0.5, size * 0.42, size * 0.72);
    for (const [offset, color] of stops) gradient.addColorStop(offset, color);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

interface StageGround {
  mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  dispose: () => void;
}

function createStageGround(): StageGround {
  const canvas = document.createElement("canvas");
  canvas.width = STAGE_GROUND_PIXELS;
  canvas.height = STAGE_GROUND_PIXELS;
  const context = canvas.getContext("2d", { alpha: true });
  if (!context) throw new Error("asset lab: failed to allocate terrain canvas");
  const imageData = context.createImageData(STAGE_GROUND_PIXELS, STAGE_GROUND_PIXELS);
  const data = imageData.data;
  const seed = SUCCESSOR_3D_CONFIG.terrain.fallbackWorldSeed;
  for (let row = 0; row < STAGE_GROUND_PIXELS; row += 1) {
    const z = (row / (STAGE_GROUND_PIXELS - 1) - 0.5) * STAGE_GROUND_SIZE;
    let offset = row * STAGE_GROUND_PIXELS * 4;
    for (let col = 0; col < STAGE_GROUND_PIXELS; col += 1) {
      const x = (col / (STAGE_GROUND_PIXELS - 1) - 0.5) * STAGE_GROUND_SIZE;
      paintTerrainPixel(seed, x, z, data, offset);
      offset += 4;
    }
  }
  context.putImageData(imageData, 0, 0);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  const geometry = new PlaneGeometry(STAGE_GROUND_SIZE, STAGE_GROUND_SIZE, 1, 1);
  const material = new MeshBasicMaterial({ map: texture, color: 0xffffff, fog: true });
  const mesh = new Mesh(geometry, material);
  mesh.name = "asset-lab-stage-ground";
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = SUCCESSOR_3D_CONFIG.terrain.y;
  return { mesh, dispose: () => { geometry.dispose(); material.dispose(); texture.dispose(); } };
}

function recenterOnGround(root: Object3D): void {
  root.updateMatrixWorld(true);
  scratchBox.setFromObject(root);
  if (scratchBox.isEmpty()) return;
  scratchBox.getCenter(scratchCenter);
  root.position.x -= scratchCenter.x;
  root.position.z -= scratchCenter.z;
  root.position.y -= scratchBox.min.y;
  root.updateMatrixWorld(true);
}

function disposeLoadedObject(root: Object3D): void {
  const materials = new Set<Material>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    const entries = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of entries) materials.add(material);
  });
  for (const material of materials) material.dispose();
}

// ─── LabPawn — the always-on-stage actor ─────────────────────────────────────

export interface LabWeaponSelection {
  id: string;
  kind: "gun" | "melee";
  spec: SlugthrowerAttachSpec;
  scene: Group;
  scale: number;
  /** Weapon-GLB embedded action clips (fire cycles); empty for legacy pack weapons. */
  animations: readonly AnimationClip[];
}

/**
 * The weapon's own fire-cycle clip: prefer a name containing "fire"
 * (Action_FireCycle etc.), else the sole/first embedded clip. Rejected when
 * any track targets a node absent from the attached (cloned) weapon scene —
 * a mixer would still run but three would warn per missing binding.
 */
function pickWeaponFireClip(animations: readonly AnimationClip[], root: Object3D): AnimationClip | null {
  const clip = animations.find((candidate) => /fire/i.test(candidate.name)) ?? animations[0] ?? null;
  if (!clip) return null;
  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf(".");
    const nodeName = dot > 0 ? track.name.slice(0, dot) : track.name;
    if (!root.getObjectByName(nodeName) && root.name !== nodeName) return null;
  }
  return clip;
}

/** Resolve a lab weapon id to its runtime scene + attach spec. */
export function weaponSelectionFor(pack: PawnPack, weaponId: string, weaponClass: string): LabWeaponSelection | null {
  if (weaponId === "slugthrower") {
    return { id: weaponId, kind: "gun", spec: pack.slugthrower, scene: pack.slugthrowerScene, scale: 1, animations: [] };
  }
  if (weaponId === "vibrosword") {
    // The vibrosword's authored spec is the VibroswordAttachSpec; SwordRig
    // accepts it via its default parameters, so the selection carries the
    // slugthrower-shaped spec only for registry weapons. Encode legacy sword
    // with the pack defaults through a null spec marker below.
    return { id: weaponId, kind: "melee", spec: pack.slugthrower, scene: pack.vibroswordScene, scale: 1, animations: [] };
  }
  const model = pack.weapons.get(weaponId);
  if (!model) return null;
  return {
    id: weaponId,
    kind: weaponClass === "melee" ? "melee" : "gun",
    spec: model.spec,
    scene: model.scene,
    scale: model.scale,
    animations: model.animations,
  };
}

export class LabPawn {
  readonly root = new Group();
  readonly bodyRoot: Group;
  readonly bodyKey: LabBodyKey;
  playing = true;

  private readonly animator: PawnAnimator;
  private readonly maskedClips = new MaskedClipCache();
  private readonly attachedEquipment: Object3D[] = [];
  /** Read-only view of attached equipment roots — crease-method plugins
   * (shader swaps, per-garment drivers) traverse these; never mutate. */
  get attachments(): readonly Object3D[] {
    return this.attachedEquipment;
  }
  private gunRig: SlugthrowerRig | null = null;
  private swordRig: SwordRig | null = null;
  private weapon: LabWeaponSelection | null = null;
  private selectedClip = "idle";
  private selectedLayer: "base" | "upper" | "hand" | "montage" | "arm" = "base";
  private selectedClampWhenFinished = false;
  private proceduralReload = false;
  private meleeSwingMaskMode: MontageMaskMode = "full";
  private timeS = 0;
  private weaponMixer: AnimationMixer | null = null;
  private weaponFireClip: AnimationClip | null = null;

  constructor(
    private readonly pack: PawnPack,
    bodyKey: LabBodyKey,
    private readonly matcap: Texture,
    private readonly bareBody = false,
  ) {
    this.bodyKey = bodyKey;
    this.root.name = `asset-lab-pawn:${bodyKey}`;
    if (bodyKey === DROID_BODY_KEY) {
      const cloned = cloneSpecialPawnBody(pack, bodyKey);
      if (!cloned) throw new Error(`special pawn body unavailable: ${bodyKey}`);
      this.bodyRoot = cloned;
      const heightM = pack.specialBodies.get(bodyKey)?.heightM ?? 1.7;
      this.bodyRoot.scale.setScalar(SUCCESSOR_3D_CONFIG.pawnPack.heightTargetUnits / heightM);
      // Droid chassis keeps its authored surface detail; convert to matcap so
      // it reads in the lab's unlit-style scene.
      this.bodyRoot.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        const source = Array.isArray(object.material) ? object.material[0] ?? null : object.material;
        const map = source && "map" in source && source.map instanceof Texture ? source.map : null;
        const color = source && "color" in source && source.color instanceof Color ? source.color.clone() : new Color("#ffffff");
        object.material = new MeshMatcapMaterial({ matcap, map, color });
        object.frustumCulled = false;
      });
    } else {
      this.bodyRoot = clonePawnBody(pack, bodyKey, { bare: this.bareBody });
      this.bodyRoot.scale.setScalar(pack.scale);
      const skin = new MeshMatcapMaterial({ matcap, color: new Color(BODY_SKIN_COLOR) });
      this.bodyRoot.traverse((object) => {
        if (!(object instanceof SkinnedMesh)) return;
        object.material = skin;
        object.frustumCulled = false;
      });
    }
    this.bodyRoot.name = `asset-lab-pawn-body:${bodyKey}`;
    this.root.add(this.bodyRoot);
    this.animator = new PawnAnimator(this.bodyRoot, pack, this.maskedClips);
    this.animator.setBase("idle", 1);
  }
  get isDroid(): boolean {
    return this.bodyKey === DROID_BODY_KEY;
  }

  get bodyVariant(): "bare" | "accommodation" {
    return this.bodyKey === "male" && this.bareBody ? "bare" : "accommodation";
  }

  bone(name: string): Bone | null {
    return this.animator.bone(name);
  }

  /**
   * Wear an equipment set through the RUNTIME resolver: requires expansion,
   * slot exclusivity, and skinned/rigid attach all live in
   * render/pawns.attachPawnEquipmentSet. Returns the ids that actually
   * attached (the resolved truth, read back from the attachment handles).
   */
  setWorn(itemIds: readonly string[]): string[] {
    for (const attached of this.attachedEquipment) attached.removeFromParent();
    this.attachedEquipment.length = 0;
    if (this.isDroid || itemIds.length === 0) return [];
    attachPawnEquipmentSet(
      this.pack,
      this.bodyRoot,
      itemIds,
      (item: PawnEquipmentItem, source: EquipmentSlotMaterialSource) =>
        resolveEquipmentSlotMaterial(source, item, item.mat, { kind: "world", matcap: this.matcap }),
      this.attachedEquipment,
    );
    const worn = new Set<string>();
    for (const attached of this.attachedEquipment) {
      const itemId = attached.userData.successorEquipmentItemId;
      if (typeof itemId === "string") worn.add(itemId);
    }
    return [...worn];
  }

  weaponSelection(): LabWeaponSelection | null {
    return this.weapon;
  }

  /** Equip a weapon (exclusive) or unequip with null. Rigs are runtime rigs. */
  setWeapon(selection: LabWeaponSelection | null): void {
    this.weaponMixer?.stopAllAction();
    this.weaponMixer = null;
    this.weaponFireClip = null;
    this.gunRig?.dispose();
    this.gunRig = null;
    this.swordRig?.dispose();
    this.swordRig = null;
    this.weapon = selection;
    if (!selection) {
      this.syncWeaponContext(true);
      return;
    }
    const handR = this.animator.bone("hand_r");
    if (!handR) {
      console.warn("asset lab: hand_r missing — weapon not attached");
      this.weapon = null;
      return;
    }
    const spine = this.animator.bone("spine_03") ?? this.animator.bone("spine_02");
    if (selection.kind === "gun") {
      this.gunRig = new SlugthrowerRig(
        this.pack,
        handR,
        this.animator.bone("upperarm_l"),
        this.animator.bone("lowerarm_l"),
        this.animator.bone("hand_l"),
        spine,
        selection.spec,
        selection.scene,
        selection.scale,
      );
      const fireClip = pickWeaponFireClip(selection.animations, this.gunRig.weaponObject());
      if (fireClip) {
        this.weaponMixer = new AnimationMixer(this.gunRig.weaponObject());
        this.weaponFireClip = fireClip;
      }
    } else if (selection.id === "vibrosword") {
      // Legacy sword: pack defaults carry the authored VibroswordAttachSpec.
      this.swordRig = new SwordRig(this.pack, handR, spine);
    } else {
      this.swordRig = new SwordRig(this.pack, handR, spine, selection.spec, selection.scene, selection.scale, selection.id);
    }
    this.syncWeaponContext(true);
  }

  selectedClipName(): string {
    return this.selectedClip;
  }

  applyClip(clipName: string): void {
    const meta = this.pack.clipMeta.get(clipName) ?? null;
    if (!meta) return;
    this.selectedClip = clipName;
    this.selectedLayer = meta.layer;
    this.selectedClampWhenFinished = meta.clampWhenFinished;
    this.timeS = 0;
    this.proceduralReload = clipName === "reload";
    this.animator.clearMontage();
    this.animator.setUpper(null);
    this.animator.setHand(null);

    const baseClip = meta.layer === "base" && !this.proceduralReload
      ? clipName
      : clipUsesMelee(clipName) && this.pack.clips.has("melee_idle") ? "melee_idle"
      : clipUsesGun(clipName) && this.pack.clips.has("rifle_idle") ? "rifle_idle"
      : "idle";
    this.animator.setBase(baseClip, 1);
    this.syncWeaponContext(false);

    if (this.proceduralReload) {
      // Reload never plays a body clip — the pawn holds rifle idle while
      // SlugthrowerRig choreographs the support hand + mag from clip time.
      if (this.pack.clips.has("gun_grip_trigger_discipline")) this.animator.setHand("gun_grip_trigger_discipline");
      return;
    }
    if (meta.layer === "upper") this.animator.setUpper(clipName);
    else if (meta.layer === "hand") this.animator.setHand(clipName);
    else if (meta.layer === "arm") this.animator.playArm(clipName);
    else if (meta.layer === "montage") {
      if (clipUsesGun(clipName) && this.pack.clips.has("gun_grip_trigger_discipline")) this.animator.setHand("gun_grip_trigger_discipline");
      if (clipUsesMelee(clipName) && this.pack.clips.has("melee_grip")) this.animator.setHand("melee_grip");
      this.animator.playMontage(clipName, {
        holdEnd: meta.clampWhenFinished,
        maskMode: isMeleeSwingPreviewClip(clipName) ? this.meleeSwingMaskMode : "clip",
      });
    }
  }

  /**
   * Weapon carry policy (kills the hip-floating rifle): an equipped weapon is
   * HELD while the selected clip uses it, otherwise it rides the back stow
   * socket through the runtime rig's spine-relative carry. Never mid-air.
   */
  private syncWeaponContext(snap: boolean): void {
    if (this.gunRig) {
      const held = clipUsesGun(this.selectedClip);
      this.gunRig.setVisible(true);
      this.gunRig.setStowed(!held, { snap });
    }
    if (this.swordRig) {
      const held = clipUsesMelee(this.selectedClip);
      this.swordRig.setVisible(true);
      this.swordRig.setStowed(!held, { snap });
    }
  }

  clipDuration(): number {
    return this.pack.clipMeta.get(this.selectedClip)?.durationS ?? 0;
  }

  clipLoops(): boolean {
    return this.pack.clipMeta.get(this.selectedClip)?.loop ?? true;
  }

  clipTime(): number {
    if (this.selectedLayer === "montage" && !this.proceduralReload) return this.animator.montageTime();
    return this.timeS;
  }

  clipEvents(): Array<[string, number]> {
    const events = this.pack.clipMeta.get(this.selectedClip)?.events ?? {};
    return Object.entries(events).sort((left, right) => left[1] - right[1]);
  }

  nearestEventName(timeS: number, windowS: number): string | null {
    let best: string | null = null;
    let bestDist = windowS;
    for (const [name, eventTime] of this.clipEvents()) {
      const dist = Math.abs(eventTime - timeS);
      if (dist <= bestDist) {
        best = name;
        bestDist = dist;
      }
    }
    return best;
  }

  /** Deterministic scrub: relaunch on backward seek, settle rigs while paused. */
  seek(targetS: number): void {
    const duration = this.clipDuration();
    if (duration <= 0) return;
    const isMontage = this.selectedLayer === "montage" && !this.proceduralReload;
    const maxT = isMontage ? duration : Math.max(0, duration - 1 / 240);
    const target = Math.min(maxT, Math.max(0, targetS));
    let current = this.clipTime();
    if (target < current) {
      this.applyClip(this.selectedClip);
      current = 0;
    }
    const delta = target - current;
    if (delta > 0) this.animator.update(delta);
    this.timeS = target;
    this.root.updateMatrixWorld(true);
    if (this.gunRig) {
      const reload = this.reloadProgress();
      for (let i = 0; i < 24; i += 1) this.gunRig.update(1 / 30, reload, reload === null ? "auto" : "on");
    }
    if (this.swordRig) {
      for (let i = 0; i < 8; i += 1) this.swordRig.update(1 / 30);
    }
  }

  private reloadProgress(): { elapsedS: number; totalS: number } | null {
    if (!this.proceduralReload || !this.gunRig) return null;
    const duration = this.clipDuration();
    if (duration <= 0) return null;
    reloadProgressScratch.elapsedS = Math.min(duration, Math.max(0, this.timeS));
    reloadProgressScratch.totalS = duration;
    return reloadProgressScratch;
  }

  setPlaying(playing: boolean): void {
    this.playing = playing;
  }

  setMeleeSwingMaskMode(maskMode: MontageMaskMode): void {
    this.meleeSwingMaskMode = maskMode;
    if (this.selectedLayer === "montage" && isMeleeSwingPreviewClip(this.selectedClip)) {
      this.animator.setMontageMaskMode(maskMode);
    }
  }

  activeClipsByLayer(out: ActiveClipsByLayer): ActiveClipsByLayer {
    return this.animator.activeClipsByLayer(out);
  }

  // ── held-item actions (ACTIONS strip drives these) ─────────────────────────

  /**
   * Fire an action montage OVER the current base pose without touching the
   * selected clip (so the transport's montage auto-replay never fights it).
   * Caller ensures the selected clip is a matching base idle first.
   */
  playActionMontage(clipName: string): boolean {
    const meta = this.pack.clipMeta.get(clipName);
    if (!meta || meta.layer !== "montage") return false;
    if (this.selectedLayer === "montage") return false;
    this.animator.playMontage(clipName, { maskMode: "clip" });
    return true;
  }

  /** One-shot of the weapon GLB's own embedded fire-cycle clip (if any). */
  playWeaponFireClip(): boolean {
    if (!this.weaponMixer || !this.weaponFireClip) return false;
    const action = this.weaponMixer.clipAction(this.weaponFireClip);
    action.reset();
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = false;
    action.play();
    return true;
  }

  /** Name of the playable embedded weapon fire clip, or null. */
  weaponFireClipName(): string | null {
    return this.weaponFireClip?.name ?? null;
  }

  /**
   * Real muzzle socket world position + bore direction (grip -> muzzle) of a
   * HELD gun. False while unarmed, melee-armed, or the gun rides the back.
   * Requires current world matrices (update() ran this frame).
   */
  muzzleBore(outOrigin: Vector3, outDir: Vector3): boolean {
    if (!this.gunRig || this.gunRig.isStowed()) return false;
    this.gunRig.getMuzzleWorld(outOrigin);
    this.gunRig.getGripWorld(gripScratch);
    outDir.subVectors(outOrigin, gripScratch);
    if (outDir.lengthSq() < 1e-8) outDir.set(0, 0, 1);
    else outDir.normalize();
    return true;
  }

  /**
   * Approximate blade-tip world position of a HELD melee weapon: the bounds
   * corner farthest from the weld hand. Good enough for a contact spark.
   */
  bladeTipWorld(out: Vector3): boolean {
    if (!this.swordRig || this.swordRig.isStowed()) return false;
    const hand = this.animator.bone("hand_r");
    if (!hand) return false;
    scratchBox.setFromObject(this.swordRig.frameRoot());
    if (scratchBox.isEmpty()) return false;
    hand.getWorldPosition(handScratch);
    let best = -1;
    for (let corner = 0; corner < 8; corner += 1) {
      cornerScratch.set(
        (corner & 1) === 0 ? scratchBox.min.x : scratchBox.max.x,
        (corner & 2) === 0 ? scratchBox.min.y : scratchBox.max.y,
        (corner & 4) === 0 ? scratchBox.min.z : scratchBox.max.z,
      );
      const distSq = cornerScratch.distanceToSquared(handScratch);
      if (distSq > best) {
        best = distSq;
        out.copy(cornerScratch);
      }
    }
    return true;
  }

  update(dtSeconds: number): void {
    if (this.playing) {
      this.animator.update(dtSeconds);
      const duration = this.clipDuration();
      if (duration > 0) this.timeS = (this.timeS + dtSeconds) % duration;
      if (this.selectedLayer === "montage" && !this.proceduralReload && !this.selectedClampWhenFinished && this.animator.montageClip() === null) {
        this.animator.playMontage(this.selectedClip, {
          maskMode: isMeleeSwingPreviewClip(this.selectedClip) ? this.meleeSwingMaskMode : "clip",
        });
      }
    }
    this.root.updateMatrixWorld(true);
    if (this.gunRig && this.playing) {
      const reload = this.reloadProgress();
      this.gunRig.update(dtSeconds, reload, reload === null ? "auto" : "on");
      this.weaponMixer?.update(dtSeconds);
    }
    this.swordRig?.update(dtSeconds);
  }

  dispose(): void {
    this.gunRig?.dispose();
    this.swordRig?.dispose();
    this.animator.dispose();
  }
}

// ─── LabStage — renderer, camera, ground, pedestal ───────────────────────────

export interface LabStageOptions {
  host: HTMLElement;
  onFrame: (dtSeconds: number) => void;
}

/** SCENE FOG bench values (POST panel drives these; hash-persisted by the app). */
export interface LabFogState {
  enabled: boolean;
  /** CSS hex colour ("#c9ad82"). */
  color: string;
  /** Linear mode: world-unit distances from the camera. */
  near: number;
  far: number;
  mode: "linear" | "exp2";
  /** Exp2 mode density. */
  density: number;
}

/** Boot defaults for the SCENE FOG bench (config ground fog). */
export function defaultLabFogState(): LabFogState {
  return {
    enabled: false,
    color: SUCCESSOR_3D_CONFIG.ground.fogColor,
    near: SUCCESSOR_3D_CONFIG.ground.fogNear,
    far: SUCCESSOR_3D_CONFIG.ground.fogFar,
    mode: "linear",
    density: 0.02,
  };
}

/**
 * DEPTH DRESSING layout — deterministic world-item rows at ~4/8/16/32 cells
 * behind the pawn (stage -z) plus far silhouettes, for judging fog falloff.
 */
const DEPTH_DRESSING_LAYOUT: readonly { glb: string; x: number; z: number; yaw?: number }[] = [
  { glb: "crate_planked", x: -1.6, z: -4 },
  { glb: "crate_planked", x: 1.6, z: -4, yaw: 0.6 },
  { glb: "crate_planked", x: 0, z: -8, yaw: 0.3 },
  { glb: "tank_water_frontier", x: 3.2, z: -8 },
  { glb: "shelter_frontier", x: 0, z: -16 },
  { glb: "crate_planked", x: -4.5, z: -16, yaw: 0.9 },
  { glb: "tank_water_frontier", x: 4.5, z: -16 },
  { glb: "shelter_frontier", x: -6, z: -32, yaw: 0.4 },
  { glb: "tank_water_frontier", x: 0, z: -32 },
  { glb: "crate_planked", x: 6, z: -32 },
  { glb: "shelter_frontier", x: 0, z: -60 },
  { glb: "shelter_frontier", x: -14, z: -72, yaw: 0.7 },
  { glb: "tank_water_frontier", x: 12, z: -84 },
];

export class LabStage {
  readonly pawnMatcap = createMatcapTexture([[0, "#ffffff"], [0.45, "#dde0e3"], [0.8, "#b2b6bc"], [1, "#84888f"]]);
  private readonly propMatcap = createMatcapTexture([[0, "#ffffff"], [0.4, "#d8d8d8"], [0.75, "#aab0b5"], [1, "#878c92"]]);

  private readonly renderer = new WebGLRenderer(RENDERER_OPTIONS);
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, SUCCESSOR_3D_CONFIG.camera.near, SUCCESSOR_3D_CONFIG.camera.far);
  private readonly controls: OrbitControls;
  private readonly post = new Ps2PostRenderer();
  private readonly loader = new GLTFLoader();
  private readonly ground = createStageGround();
  private readonly environmentMap: Texture;
  private readonly stageRoot = new Group();
  private readonly propMaterialCache = new Map<string, MeshMatcapMaterial>();
  /** Combat-FX bench (runtime fx subsystems, explicit-vector driven). */
  readonly fx: LabFx;
  /** Mutable clock the ToD override slider drives (post reads it per frame). */
  private readonly todClock = { minuteOfDay: 720, moon: { brightness: 0 }, sun: { elevation: 1, azimuth: 0, ambient: 1, warmth: 0 } };
  private readonly todEnv = { clock: this.todClock } as unknown as WorldEnvironment;
  /** SCENE FOG bench state (see applyFog). */
  private readonly defaultFog = new Fog(SUCCESSOR_3D_CONFIG.ground.fogColor, SUCCESSOR_3D_CONFIG.ground.fogNear, SUCCESSOR_3D_CONFIG.ground.fogFar);
  private readonly labFog = new Fog(SUCCESSOR_3D_CONFIG.ground.fogColor, SUCCESSOR_3D_CONFIG.ground.fogNear, SUCCESSOR_3D_CONFIG.ground.fogFar);
  private readonly labFogExp2 = new FogExp2(SUCCESSOR_3D_CONFIG.ground.fogColor, 0.02);
  private fogOverrideOn = false;
  private dressingRoot: Group | null = null;
  private dressingWanted = false;
  private dressingLoading = false;

  private pawn: LabPawn | null = null;
  private propRoot: Group | null = null;
  private skeletonHelper: SkeletonHelper | null = null;
  private bonesOn = false;
  private postEnabled = true;
  private turntable = false;
  private stageYaw = 0;
  private viewHeight = 2.4;
  private width = 1;
  private height = 1;
  private rafId = 0;
  private lastFrameMs = performance.now();
  private disposed = false;

  constructor(private readonly options: LabStageOptions) {
    this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(SUCCESSOR_3D_CONFIG.renderer.clearColor, 1);
    this.renderer.autoClear = false;
    this.renderer.domElement.className = "successor3d-canvas sc3d-asset-canvas";
    this.renderer.domElement.tabIndex = 0;
    options.host.appendChild(this.renderer.domElement);

    const environment = new RoomEnvironment();
    const pmrem = new PMREMGenerator(this.renderer);
    this.environmentMap = pmrem.fromScene(environment, 0.04).texture;
    environment.dispose();
    pmrem.dispose();
    this.scene.environment = this.environmentMap;
    this.scene.environmentIntensity = 2.5;
    this.scene.fog = this.defaultFog;
    this.scene.add(this.ground.mesh);
    const ambient = new AmbientLight(0xffffff, 1.4);
    const key = new DirectionalLight(0xfff4e6, 5.0);
    key.position.set(4, 6, 8);
    const fill = new DirectionalLight(0x9db8d1, 2.5);
    fill.position.set(-5, 3, 4);
    this.scene.add(ambient, key, fill);

    this.camera.up.copy(WORLD_UP);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = true;
    this.controls.screenSpacePanning = false;
    this.controls.minZoom = 0.08;
    this.controls.maxZoom = 14;
    this.controls.target.set(0, 0.9, 0);

    this.stageRoot.name = "asset-lab-stage-root";
    this.scene.add(this.stageRoot);
    this.fx = new LabFx(this.scene, this.camera, this.renderer.domElement);

    this.applyPreset("quarter");
    this.rafId = window.requestAnimationFrame(this.frame);
  }

  /** Swap the on-stage pawn; disposes the previous one. */
  setPawn(pawn: LabPawn): void {
    if (this.pawn) {
      this.stageRoot.remove(this.pawn.root);
      this.pawn.dispose();
    }
    this.pawn = pawn;
    this.stageRoot.add(pawn.root);
    this.refreshSkeletonHelper();
  }

  currentPawn(): LabPawn | null {
    return this.pawn;
  }

  /** Live scene handle for crease-method plugins (capsules, debug helpers). */
  methodScene(): Scene {
    return this.scene;
  }

  /** Load a wave-library prop onto the side pedestal (one at a time). */
  async placeProp(url: string): Promise<void> {
    this.removeProp();
    const gltf = await this.loader.loadAsync(url);
    const root = new Group();
    root.name = "asset-lab-pedestal-prop";
    root.add(gltf.scene);
    this.applyPropMatcap(root);
    recenterOnGround(root);
    root.position.x = PROP_PEDESTAL_X;
    this.stageRoot.add(root);
    this.propRoot = root;
  }

  removeProp(): void {
    if (!this.propRoot) return;
    this.stageRoot.remove(this.propRoot);
    disposeLoadedObject(this.propRoot);
    this.propRoot = null;
  }

  /** Auto-frame the PAWN (never the empty desert): target its bounds center. */
  framePawn(): void {
    const pawnRoot = this.pawn?.root ?? null;
    if (pawnRoot) {
      pawnRoot.updateMatrixWorld(true);
      scratchBox.setFromObject(pawnRoot);
    }
    if (!pawnRoot || scratchBox.isEmpty()) {
      scratchCenter.set(0, 0.9, 0);
      scratchSize.set(1, 1.8, 1);
    } else {
      scratchBox.getCenter(scratchCenter);
      scratchBox.getSize(scratchSize);
    }
    this.viewHeight = Math.max(2.2, scratchSize.y * 1.35);
    const direction = this.cameraDirection();
    this.controls.target.copy(scratchCenter);
    this.camera.position.copy(scratchCenter).addScaledVector(direction, CAMERA_DISTANCE);
    this.camera.zoom = 1;
    this.camera.lookAt(this.controls.target);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.applyViewport();
  }

  applyPreset(preset: CameraPresetName): void {
    const direction = PRESET_DIRECTIONS[preset];
    if (preset === "grip") {
      // Weld-inspection framing: lock onto the right hand.
      const hand = this.pawn?.bone("hand_r") ?? null;
      if (hand) {
        this.pawn?.root.updateMatrixWorld(true);
        hand.getWorldPosition(scratchCenter);
      } else {
        scratchCenter.set(0, 1.0, 0);
      }
      this.controls.target.copy(scratchCenter);
      this.camera.zoom = 4.6;
    } else {
      this.controls.target.set(0, 0.9, 0);
      this.camera.zoom = preset === "close" ? 2.4 : 1;
      if (preset === "close") this.controls.target.set(0, 1.25, 0);
    }
    this.camera.position.copy(this.controls.target).addScaledVector(direction, CAMERA_DISTANCE);
    this.camera.lookAt(this.controls.target);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  setTurntable(on: boolean): void {
    this.turntable = on;
  }

  isTurntable(): boolean {
    return this.turntable;
  }

  setBones(on: boolean): void {
    this.bonesOn = on;
    this.refreshSkeletonHelper();
  }

  isBones(): boolean {
    return this.bonesOn;
  }

  setPost(on: boolean): void {
    this.postEnabled = on;
  }

  isPost(): boolean {
    return this.postEnabled;
  }

  /**
   * SCENE FOG bench: user values own scene.fog (the post pass's per-frame
   * fog/colour rewrites are suspended via sceneFogOwnedExternally while the
   * override is on). Disable restores the boot fog + post ownership.
   */
  applyFog(state: LabFogState): void {
    this.fogOverrideOn = state.enabled;
    this.post.sceneFogOwnedExternally = state.enabled;
    if (!state.enabled) {
      this.scene.fog = this.defaultFog;
      return;
    }
    if (state.mode === "exp2") {
      this.labFogExp2.color.set(state.color);
      this.labFogExp2.density = Math.max(0, state.density);
      this.scene.fog = this.labFogExp2;
    } else {
      this.labFog.color.set(state.color);
      this.labFog.near = state.near;
      this.labFog.far = Math.max(state.near + 0.1, state.far);
      this.scene.fog = this.labFog;
    }
  }

  /**
   * DEPTH DRESSING: a fixed deterministic spread of world-item props in rows
   * at ~4/8/16/32 cells behind the pawn plus far silhouettes, so fog depth
   * falloff is judgeable across distances. Off disposes everything.
   */
  async setDepthDressing(on: boolean): Promise<void> {
    this.dressingWanted = on;
    if (!on) {
      if (this.dressingRoot) {
        this.stageRoot.remove(this.dressingRoot);
        disposeLoadedObject(this.dressingRoot);
        this.dressingRoot = null;
      }
      this.framePawn();
      return;
    }
    if (this.dressingRoot || this.dressingLoading) return;
    this.dressingLoading = true;
    try {
      const root = new Group();
      root.name = "asset-lab-depth-dressing";
      await Promise.all(DEPTH_DRESSING_LAYOUT.map(async (item) => {
        try {
          const gltf = await this.loader.loadAsync(`/assets/world-items/${item.glb}.glb`);
          const holder = new Group();
          holder.add(gltf.scene);
          this.applyPropMatcap(holder);
          recenterOnGround(holder);
          holder.position.x = item.x;
          holder.position.z = item.z;
          holder.rotation.y = item.yaw ?? 0;
          root.add(holder);
        } catch (error) {
          console.warn(`asset lab: depth-dressing prop failed (${item.glb})`, error);
        }
      }));
      if (!this.dressingWanted || this.disposed) {
        disposeLoadedObject(root);
        return;
      }
      this.dressingRoot = root;
      this.stageRoot.add(root);
      this.frameDressing();
    } finally {
      this.dressingLoading = false;
    }
  }

  /** Pull the ortho frame out so the 4-32-cell dressing rows are in view. */
  private frameDressing(): void {
    this.viewHeight = 30;
    const direction = this.cameraDirection();
    this.controls.target.set(0, 1.2, -12);
    this.camera.position.copy(this.controls.target).addScaledVector(direction, CAMERA_DISTANCE);
    this.camera.zoom = 1;
    this.camera.lookAt(this.controls.target);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.applyViewport();
  }

  private applyPropMatcap(root: Object3D): void {
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const source = Array.isArray(object.material) ? object.material[0] ?? null : object.material;
      const color = source && "color" in source && source.color instanceof Color ? source.color : null;
      const cacheKey = color ? `#${color.getHexString()}` : "#8f9296";
      let material = this.propMaterialCache.get(cacheKey);
      if (!material) {
        material = new MeshMatcapMaterial({ matcap: this.propMatcap, color: color ? color.clone() : new Color("#8f9296") });
        this.propMaterialCache.set(cacheKey, material);
      }
      object.material = material;
    });
  }

  /**
   * Time-of-day override for the post grade: a minute-of-day drives the same
   * ToD anchors the game renders (post.env stub clock); null restores the
   * lab's fixed noon (env-less) behaviour.
   */
  setTimeOfDayMinute(minute: number | null): void {
    if (minute === null) {
      this.post.env = null;
      return;
    }
    const clamped = Math.max(0, Math.min(1439, Math.round(minute)));
    this.todClock.minuteOfDay = clamped;
    this.todClock.sun.elevation = Math.sin(((clamped - 360) / 720) * Math.PI);
    this.todClock.moon.brightness = this.todClock.sun.elevation < 0 ? 0.5 : 0;
    this.post.env = this.todEnv;
  }

  private refreshSkeletonHelper(): void {
    if (this.skeletonHelper) {
      this.skeletonHelper.removeFromParent();
      this.skeletonHelper.dispose();
      this.skeletonHelper = null;
    }
    if (!this.bonesOn || !this.pawn) return;
    this.skeletonHelper = new SkeletonHelper(this.pawn.bodyRoot);
    this.scene.add(this.skeletonHelper);
  }

  private cameraDirection(): Vector3 {
    scratchDirection.copy(this.camera.position).sub(this.controls.target);
    if (scratchDirection.lengthSq() < 1e-6) return scratchDirection.copy(PRESET_DIRECTIONS.quarter);
    return scratchDirection.normalize();
  }

  private readonly frame = (timeMs: number): void => {
    if (this.disposed) return;
    const dt = Math.min(0.08, Math.max(0, (timeMs - this.lastFrameMs) / 1000));
    this.lastFrameMs = timeMs;
    this.applyViewport();
    this.controls.update();
    if (this.turntable) {
      this.stageYaw += TURNTABLE_RADIANS_PER_SECOND * dt;
      this.stageRoot.rotation.y = this.stageYaw;
    }
    this.options.onFrame(dt);
    this.fx.update(dt);
    if (this.postEnabled) {
      this.post.render(this.renderer, this.scene, this.camera);
    } else {
      const fog = this.scene.fog;
      if (!this.fogOverrideOn) this.scene.fog = null;
      this.renderer.setRenderTarget(null);
      this.renderer.clear();
      this.renderer.render(this.scene, this.camera);
      this.scene.fog = fog;
    }
    this.rafId = window.requestAnimationFrame(this.frame);
  };

  private applyViewport(): void {
    const rect = this.options.host.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.floor(rect.width || window.innerWidth));
    const nextHeight = Math.max(1, Math.floor(rect.height || window.innerHeight));
    const aspect = nextWidth / nextHeight;
    this.camera.left = -this.viewHeight * aspect / 2;
    this.camera.right = this.viewHeight * aspect / 2;
    this.camera.top = this.viewHeight / 2;
    this.camera.bottom = -this.viewHeight / 2;
    this.camera.updateProjectionMatrix();
    if (nextWidth === this.width && nextHeight === this.height) return;
    this.width = nextWidth;
    this.height = nextHeight;
    this.renderer.setSize(nextWidth, nextHeight, false);
    this.post.resize(nextWidth, nextHeight);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.cancelAnimationFrame(this.rafId);
    this.removeProp();
    if (this.pawn) {
      this.stageRoot.remove(this.pawn.root);
      this.pawn.dispose();
      this.pawn = null;
    }
    if (this.skeletonHelper) {
      this.skeletonHelper.removeFromParent();
      this.skeletonHelper.dispose();
      this.skeletonHelper = null;
    }
    this.scene.remove(this.stageRoot);
    this.controls.dispose();
    this.scene.remove(this.ground.mesh);
    this.ground.dispose();
    this.post.dispose();
    this.fx.dispose();
    for (const material of this.propMaterialCache.values()) material.dispose();
    this.propMaterialCache.clear();
    this.pawnMatcap.dispose();
    this.propMatcap.dispose();
    this.environmentMap.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/** Weapon meshes render matcap in the lab scene (runtime scenes are shared —
 * conversion is idempotent per material instance). */
export function prepareWeaponMaterials(pack: PawnPack, matcap: Texture): void {
  const apply = (root: Object3D): void => {
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const source = Array.isArray(object.material) ? object.material[0] ?? null : object.material;
      if (source instanceof MeshMatcapMaterial) return;
      const map = source && "map" in source && source.map instanceof Texture ? source.map : null;
      object.material = new MeshMatcapMaterial({ matcap, map });
    });
  };
  apply(pack.slugthrowerScene);
  apply(pack.vibroswordScene);
  for (const model of pack.weapons.values()) apply(model.scene);
}
