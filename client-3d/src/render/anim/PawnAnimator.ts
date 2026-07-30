// PawnAnimator.ts — typed per-pawn port of the pawn-forge layered compositor
// (viewer/anim_preview/app.js), driven by game_pack.json clip metadata.
//
// Layer stack, priority high -> low (manifest_anim.json "layers"):
//   L4 montage (one-shots: rifle_fire / reload / death_f / death_b; live hit feedback is procedural in pawns.ts)
//   L3 hand    (grip poses, hand+finger mask)
//   L1 upper   (rifle_aim fallback / non-rifle-posed armed bases, upper mask)
//   L0 base    (locomotion, unmasked minus contested bones)
//
// Every ACTIVE layer plays a masked clip filtered to
//   (its mask) MINUS (union of higher ACTIVE layers' masks)
// so each bone has exactly one driver. Any layer on/off change rebuilds the
// affected actions. NEVER mixer.stopAllAction() (documented fatal: it kills the
// base transport out from under the overlays). Base transport (timeScale for
// foot-speed matching) is separate from overlay lifecycle.
//
// RUNTIME RULES honored here:
// - Live hit feedback is a tiny procedural flinch in pawns.ts.
// - death_f/death_b are full-mask montages with clampWhenFinished that never
//   auto-clear (holdEnd) — the pawn stays on the ground.
// - torso_yaw is procedural and applied POST-mixer via the manifest recipe.
import {
  AnimationAction,
  AnimationMixer,
  Bone,
  LoopOnce,
  LoopRepeat,
  Quaternion,
  SkinnedMesh,
  Vector3,
  type Object3D,
} from "three";
import { SUCCESSOR_3D_CONFIG } from "../../config";
import { sane, type PawnPack } from "../../assets/pawnRigTypes";
import { MaskedClipCache } from "./maskedClips";

type OverlayLayer = "upper" | "hand" | "montage" | "arm";
type AnyLayer = "arm" | "montage" | "hand" | "upper" | "base";
// arm sits ABOVE montage: stim_inject owns the left arm even while rifle_fire
// plays. Death (full-mask holdEnd montage) explicitly clears/blocks arm in
// playMontage/playArm — full-mask montages do NOT auto-contest higher layers.
const LAYER_PRIORITY: ReadonlyArray<AnyLayer> = ["arm", "montage", "hand", "upper", "base"];

export type MontageMaskMode = "clip" | "full";
interface RebuildOptions {
  readonly preserveMontageTime?: boolean;
  readonly montageCrossfadeSeconds?: number;
}

export interface ActiveClipsByLayer {
  base: string | null;
  upper: string | null;
  hand: string | null;
  arm: string | null;
  montage: string | null;
  montageMaskMode?: MontageMaskMode | null;
  montageTimeS?: number | null;
}

interface LayerSlot {
  clipName: string | null;
  action: AnimationAction | null;
  /** Montage only: keep the finished pose forever (death). */
  holdEnd: boolean;
  /** Montage only: play speed applied on (re)build. */
  timeScale: number;
  /** Montage only: use manifest mask ("clip") or the whole skeleton ("full"). */
  montageMaskMode: MontageMaskMode;
}

const scratchQuat = new Quaternion();
const scratchParentQuat = new Quaternion();
const scratchAxis = new Vector3();
const MODEL_UP = new Vector3(0, 1, 0);
const MONTAGE_MASK_SWITCH_CROSSFADE_SECONDS = 0.08;

interface TorsoYawBone {
  bone: Bone;
  weight: number;
  /** Model-up expressed in the bone's parent rest space. */
  axis: Vector3;
}

export class PawnAnimator {
  private readonly mixer: AnimationMixer;
  private readonly boneByName = new Map<string, Bone>();
  private readonly slots: Record<"base" | OverlayLayer, LayerSlot> = {
    base: { clipName: null, action: null, holdEnd: false, timeScale: 1, montageMaskMode: "clip" },
    upper: { clipName: null, action: null, holdEnd: false, timeScale: 1, montageMaskMode: "clip" },
    hand: { clipName: null, action: null, holdEnd: false, timeScale: 1, montageMaskMode: "clip" },
    montage: { clipName: null, action: null, holdEnd: false, timeScale: 1, montageMaskMode: "clip" },
    arm: { clipName: null, action: null, holdEnd: false, timeScale: 1, montageMaskMode: "clip" },
  };
  private readonly torsoYawBones: TorsoYawBone[] = [];
  private montageDone = false;
  private baseTimeScale = 1;

  constructor(
    root: Object3D,
    private readonly pack: PawnPack,
    private readonly maskedClips: MaskedClipCache,
  ) {
    this.mixer = new AnimationMixer(root);
    root.traverse((object) => {
      if (object instanceof Bone) this.boneByName.set(sane(object.name), object);
      if (object instanceof SkinnedMesh) object.frustumCulled = false;
    });
    root.updateWorldMatrix(true, true);
    for (const [boneName, weight] of pack.torsoYaw.weights) {
      const bone = this.boneByName.get(boneName);
      const parent = bone?.parent;
      if (!bone || !parent) continue;
      parent.getWorldQuaternion(scratchParentQuat);
      this.torsoYawBones.push({
        bone,
        weight,
        axis: MODEL_UP.clone().applyQuaternion(scratchParentQuat.invert()).normalize(),
      });
    }
    this.mixer.addEventListener("finished", (event) => {
      const arm = this.slots.arm;
      if (event.action === arm.action) {
        event.action.fadeOut(SUCCESSOR_3D_CONFIG.pawnPack.overlayCrossfadeSeconds);
        arm.action = null;
        arm.clipName = null;
        this.rebuildAll(false);
        return;
      }
      const montage = this.slots.montage;
      if (event.action !== montage.action) return;
      if (montage.holdEnd) {
        this.montageDone = true;
        return;
      }
      event.action.fadeOut(SUCCESSOR_3D_CONFIG.pawnPack.overlayCrossfadeSeconds);
      montage.action = null;
      montage.clipName = null;
      this.rebuildAll(false);
    });
  }

  bone(name: string): Bone | null {
    return this.boneByName.get(name) ?? null;
  }

  /** Base locomotion clip; timeScale is live-tunable without a rebuild. */
  setBase(clipName: string, timeScale: number): void {
    this.baseTimeScale = timeScale;
    const slot = this.slots.base;
    if (slot.clipName !== clipName) {
      slot.clipName = clipName;
      this.rebuildLayer("base", false);
    }
    slot.action?.setEffectiveTimeScale(timeScale);
  }

  setUpper(clipName: string | null): void {
    if (this.slots.upper.clipName === clipName) return;
    this.slots.upper.clipName = clipName;
    this.rebuildAll(false);
  }

  setHand(clipName: string | null): void {
    if (this.slots.hand.clipName === clipName) return;
    this.slots.hand.clipName = clipName;
    this.rebuildAll(false);
  }

  /**
   * One-shot montage. Restarts if the same clip is requested while playing
   * (rifle_fire spam). death clips pass holdEnd=true and never auto-clear.
   */
  playMontage(
    clipName: string,
    options: { holdEnd?: boolean; timeScale?: number; startAtEnd?: boolean; maskMode?: MontageMaskMode } = {},
  ): void {
    const slot = this.slots.montage;
    const maskMode = options.maskMode ?? "clip";
    const restart = slot.clipName === clipName && slot.action !== null && slot.montageMaskMode === maskMode;
    slot.clipName = clipName;
    slot.holdEnd = options.holdEnd ?? false;
    slot.timeScale = options.timeScale ?? 1;
    slot.montageMaskMode = maskMode;
    this.montageDone = false;
    if (restart && slot.action) {
      slot.action.reset().play();
      slot.action.setEffectiveTimeScale(slot.timeScale);
      return;
    }
    // Death (full-mask holdEnd) owns the whole body: kill any arm overlay.
    if (maskMode === "full" && slot.holdEnd) {
      const arm = this.slots.arm;
      if (arm.action || arm.clipName) {
        arm.action?.fadeOut(0.03);
        arm.action = null;
        arm.clipName = null;
      }
    }
    this.rebuildAll(true);
    if (options.startAtEnd && slot.action) {
      slot.action.time = slot.action.getClip().duration;
      this.mixer.update(0);
      this.montageDone = true;
    }
  }

  /**
   * One-shot arm overlay (stim_inject): owns its mask even over montages.
   * Auto-clears on finish. No-op while a full-mask holdEnd montage (death)
   * is active.
   */
  playArm(clipName: string): void {
    const montage = this.slots.montage;
    if (montage.action && montage.holdEnd && montage.montageMaskMode === "full") return;
    const slot = this.slots.arm;
    const restart = slot.clipName === clipName && slot.action !== null;
    slot.clipName = clipName;
    if (restart && slot.action) {
      slot.action.reset().play();
      return;
    }
    this.rebuildAll(true);
  }

  clearArm(): void {
    const slot = this.slots.arm;
    if (!slot.action && !slot.clipName) return;
    slot.action?.fadeOut(SUCCESSOR_3D_CONFIG.pawnPack.overlayCrossfadeSeconds);
    slot.action = null;
    slot.clipName = null;
    this.rebuildAll(false);
  }

  setMontageMaskMode(maskMode: MontageMaskMode): void {
    const slot = this.slots.montage;
    if (slot.montageMaskMode === maskMode) return;
    slot.montageMaskMode = maskMode;
    if (!slot.clipName || !slot.action) return;
    this.rebuildAll(false, {
      preserveMontageTime: true,
      montageCrossfadeSeconds: MONTAGE_MASK_SWITCH_CROSSFADE_SECONDS,
    });
  }

  clearMontage(): void {
    const slot = this.slots.montage;
    if (!slot.action && !slot.clipName) return;
    slot.action?.fadeOut(SUCCESSOR_3D_CONFIG.pawnPack.overlayCrossfadeSeconds);
    slot.action = null;
    slot.clipName = null;
    slot.montageMaskMode = "clip";
    this.montageDone = false;
    this.rebuildAll(false);
  }

  montageClip(): string | null {
    return this.slots.montage.clipName;
  }

  /** Seconds into the montage clip (clip time, independent of timeScale). */
  montageTime(): number {
    return this.slots.montage.action?.time ?? 0;
  }

  isMontageDone(): boolean {
    return this.montageDone;
  }

  activeClipsByLayer(out: ActiveClipsByLayer): ActiveClipsByLayer {
    out.base = this.slots.base.action ? this.slots.base.clipName : null;
    out.arm = this.slots.arm.action ? this.slots.arm.clipName : null;
    out.upper = this.slots.upper.action ? this.slots.upper.clipName : null;
    out.hand = this.slots.hand.action ? this.slots.hand.clipName : null;
    out.montage = this.slots.montage.action ? this.slots.montage.clipName : null;
    out.montageMaskMode = this.slots.montage.action ? this.slots.montage.montageMaskMode : null;
    out.montageTimeS = this.slots.montage.action ? this.slots.montage.action.time : null;
    return out;
  }

  update(dtSeconds: number): void {
    this.mixer.update(dtSeconds);
  }

  /**
   * Procedural torso yaw toward the aim direction, applied POST-mixer.
   * @param deltaYawRad shortest-arc (aimYaw - bodyYaw); clamped to the recipe max.
   */
  applyTorsoYaw(deltaYawRad: number): void {
    const recipe = this.pack.torsoYaw;
    const clamped = Math.min(recipe.maxRad, Math.max(-recipe.maxRad, deltaYawRad))
      * SUCCESSOR_3D_CONFIG.pawnPack.torsoYawSign;
    if (Math.abs(clamped) < 1e-4) return;
    for (const entry of this.torsoYawBones) {
      scratchAxis.copy(entry.axis);
      scratchQuat.setFromAxisAngle(scratchAxis, clamped * entry.weight);
      entry.bone.quaternion.premultiply(scratchQuat);
    }
  }

  dispose(): void {
    this.mixer.stopAllAction(); // teardown only — never during composition
    this.mixer.uncacheRoot(this.mixer.getRoot());
  }

  // -------------------------------------------------------------------------
  // Compositing internals
  // -------------------------------------------------------------------------

  private layerMaskName(layer: AnyLayer): string | null {
    const slot = this.slots[layer];
    if (!slot.clipName || (layer !== "base" && !this.isLayerActive(layer))) return null;
    if (layer === "base") return null;
    if (layer === "montage" && slot.montageMaskMode === "full") return null;
    const meta = this.pack.clipMeta.get(slot.clipName);
    // Overlay clips use their declared mask; montages without one default to
    // "upper".
    const mask = meta?.mask ?? "upper";
    // Grip overlays must NOT own the wrists: hand_l/hand_r ride the base clip
    // (and the support-hand IK), or the welded weapon inherits the grip clip's
    // stale wrist rotation. See the derived mask in pawnPack.loadPawnPack.
    if (layer === "hand" && mask === "hand" && this.pack.masks.has("hand_fingers")) return "hand_fingers";
    return mask;
  }

  private isLayerActive(layer: AnyLayer): boolean {
    return this.slots[layer].clipName !== null;
  }

  /** Union of the masks of ACTIVE layers with higher priority than `layer`. */
  private higherMasks(layer: AnyLayer, out: Set<string>): Set<string> {
    out.clear();
    for (const higher of LAYER_PRIORITY) {
      if (higher === layer) break;
      if (!this.isLayerActive(higher)) continue;
      const maskName = this.layerMaskName(higher);
      const mask = maskName ? this.pack.masks.get(maskName) : higher !== "base" ? this.pack.boneNames : null;
      if (!mask) continue;
      for (const bone of mask) out.add(bone);
    }
    return out;
  }

  private higherFingerprint(layer: AnyLayer): string {
    let fingerprint = "";
    for (const higher of LAYER_PRIORITY) {
      if (higher === layer) break;
      fingerprint += this.isLayerActive(higher) ? `${this.layerMaskName(higher) ?? "full"},` : "-,";
    }
    return fingerprint;
  }

  private rebuildAll(instant: boolean, options: RebuildOptions = {}): void {
    this.rebuildLayer("base", instant, options);
    this.rebuildLayer("upper", instant, options);
    this.rebuildLayer("hand", instant, options);
    this.rebuildLayer("montage", instant, options);
    this.rebuildLayer("arm", instant, options);
  }

  private readonly keepScratch = new Set<string>();
  private readonly higherScratch = new Set<string>();

  private rebuildLayer(layer: AnyLayer, instant: boolean, options: RebuildOptions = {}): void {
    const slot = this.slots[layer];
    const config = SUCCESSOR_3D_CONFIG.pawnPack;
    if (!slot.clipName) {
      if (slot.action) {
        slot.action.fadeOut(instant ? 0.03 : config.overlayCrossfadeSeconds);
        slot.action = null;
      }
      return;
    }
    const srcClip = this.pack.clips.get(slot.clipName);
    if (!srcClip) {
      slot.clipName = null;
      return;
    }

    const higher = this.higherMasks(layer, this.higherScratch);
    const keep = this.keepScratch;
    keep.clear();
    const ownMaskName = layer === "base" ? null : this.layerMaskName(layer);
    const ownMask = ownMaskName ? this.pack.masks.get(ownMaskName) : null;
    const source = ownMask ?? this.pack.boneNames;
    for (const bone of source) {
      if (!higher.has(bone)) keep.add(bone);
    }
    const fingerprint = `${layer}|${ownMaskName ?? "full"}-${this.higherFingerprint(layer)}`;
    const masked = this.maskedClips.get(srcClip, keep, fingerprint);
    if (slot.action && slot.action.getClip() === masked) return;
    if (keep.size === 0) {
      // Fully contested (e.g. base under a full-mask death montage).
      if (slot.action) {
        slot.action.fadeOut(instant ? 0.03 : config.overlayCrossfadeSeconds);
        slot.action = null;
      }
      return;
    }

    const previous = slot.action;
    const meta = this.pack.clipMeta.get(slot.clipName);
    const action = this.mixer.clipAction(masked);
    action.reset();
    action.enabled = true;
    action.paused = false;
    action.setEffectiveWeight(1);
    if (layer === "base") {
      action.setLoop(LoopRepeat, Infinity);
      action.setEffectiveTimeScale(this.baseTimeScale);
      // Keep the gait phase across mask rebuilds (same source clip, new keep set).
      if (previous && previous.getClip().name.startsWith(`${slot.clipName}__`)) {
        action.time = previous.time % masked.duration;
      }
    } else if (layer === "montage" || layer === "arm") {
      action.setLoop(LoopOnce, 1);
      action.clampWhenFinished = layer === "montage";
      action.setEffectiveTimeScale(slot.timeScale);
      if (previous && previous.getClip().name.startsWith(`${slot.clipName}__`)) {
        action.time = Math.min(previous.time, masked.duration);
      }
    } else {
      // upper/hand overlays: hold poses (rifle_aim, grips) freeze near the end
      // of the clip like the reference viewer's hold mode.
      action.setLoop(LoopOnce, 1);
      action.clampWhenFinished = true;
      action.setEffectiveTimeScale(1);
      if (previous && previous.getClip().name.startsWith(`${slot.clipName}__`)) {
        action.time = Math.min(previous.time, masked.duration);
      } else if (slot.clipName === "rifle_aim") {
        action.time = masked.duration * 0.85; // manifest hold_frac
      } else if (meta && !meta.loop && meta.layer === "hand") {
        action.time = masked.duration;
      }
    }
    action.play();
    if (previous) {
      if (!instant && layer === "base") {
        action.crossFadeFrom(previous, config.baseCrossfadeSeconds, true);
      } else if (!instant && layer === "montage" && options.montageCrossfadeSeconds !== undefined) {
        action.crossFadeFrom(previous, options.montageCrossfadeSeconds, false);
      } else {
        previous.fadeOut(instant ? 0.03 : config.overlayCrossfadeSeconds);
      }
    } else if (!instant && layer !== "base") {
      action.fadeIn(config.overlayCrossfadeSeconds);
    }
    slot.action = action;
  }
}
