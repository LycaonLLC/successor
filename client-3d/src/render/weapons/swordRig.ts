// swordRig.ts — per-pawn vibrosword attachment (hand weld + back stow).
//
// Contract (vibrosword_attach.json + melee animation contract):
// - The vibrosword frame is welded to hand_r with mount_hand_r_local pos/quat
//   AS AUTHORED. There is no bore leveling and no IK in melee v1.
// - Out of combat the sword rides a spine_03-relative back socket, sharing the
//   Slugthrower stow mechanics but using swordStow tuning for blade-down diagonal carry.
import { Bone, Euler, Group, Mesh, Object3D, Quaternion, Vector3 } from "three";
import { SUCCESSOR_3D_CONFIG } from "../../config";
import type { PawnPack, SlugthrowerAttachSpec, VibroswordAttachSpec } from "../../assets/pawnRigTypes";

const DEG_TO_RAD = Math.PI / 180;
const stowWorldPosScratch = new Vector3();
const stowWorldQuatScratch = new Quaternion();
const stowLocalQuatScratch = new Quaternion();
const stowEulerScratch = new Euler();
const heldWorldPosScratch = new Vector3();
const heldWorldQuatScratch = new Quaternion();
const blendWorldPosScratch = new Vector3();
const blendWorldQuatScratch = new Quaternion();
const handQuatScratch = new Quaternion();
const handQuatInvScratch = new Quaternion();

export class SwordRig {
  private readonly weaponRoot = new Group();
  private readonly frame: Object3D;
  /** 0 = held in hand_r, 1 = stowed on the back; eases toward stowTarget. */
  private stowT = 0;
  private stowTarget = 0;

  constructor(
    pack: PawnPack,
    private readonly handR: Bone,
    private readonly spine: Bone | null = null,
    private readonly spec: VibroswordAttachSpec | SlugthrowerAttachSpec = pack.vibrosword,
    weaponScene: Group = pack.vibroswordScene,
    weaponScale = 1,
    weaponName = "vibrosword",
  ) {
    this.frame = cloneSwordFrame(weaponScene, spec.nodes.frame);
    this.weaponRoot.name = weaponName;
    this.weaponRoot.add(this.frame);
    this.weaponRoot.position.copy(spec.mountPos);
    this.weaponRoot.quaternion.copy(spec.mountQuat);
    this.weaponRoot.scale.setScalar(weaponScale);
    handR.add(this.weaponRoot);
  }

  setVisible(visible: boolean): void {
    this.weaponRoot.visible = visible;
  }

  /** Attach point for blade FX (plasma blade preview rides the weld). */
  frameRoot(): Object3D {
    return this.weaponRoot;
  }

  /** Hide/show the modeled weapon mesh (plasma preview shows hilt+light only). */
  setFrameVisible(visible: boolean): void {
    this.frame.visible = visible;
  }

  /**
   * Spine-local back carry. The root remains hand_r-parented; every update
   * converts the live spine socket world pose back into hand_r local space, so
   * the blade inherits torso sway without reparent churn.
   */
  setStowed(stowed: boolean, options?: { readonly snap?: boolean }): void {
    this.stowTarget = stowed ? 1 : 0;
    if (options?.snap === true) this.stowT = this.stowTarget;
  }

  isStowed(): boolean {
    return this.stowT > 0.999;
  }

  update(dtSeconds: number): void {
    const stow = SUCCESSOR_3D_CONFIG.pawnPack.swordStow;
    if (this.stowT !== this.stowTarget) {
      const stowStep = dtSeconds / Math.max(1e-3, stow.blendSeconds);
      this.stowT += Math.min(stowStep, Math.abs(this.stowTarget - this.stowT)) * Math.sign(this.stowTarget - this.stowT);
    }
    const stowEase = this.stowT * this.stowT * (3 - 2 * this.stowT);

    // Held endpoint is always the authored hand weld. No leveling, no offsets.
    this.weaponRoot.position.copy(this.spec.mountPos);
    this.weaponRoot.quaternion.copy(this.spec.mountQuat);
    this.weaponRoot.updateMatrixWorld(true);

    if (this.stowT <= 0 || !this.spine) return;

    stowEulerScratch.set(
      stow.rotOffsetDeg.x * DEG_TO_RAD,
      stow.rotOffsetDeg.y * DEG_TO_RAD,
      stow.rotOffsetDeg.z * DEG_TO_RAD,
      "XYZ",
    );
    stowLocalQuatScratch.setFromEuler(stowEulerScratch);
    stowWorldPosScratch.set(stow.posOffset.x, stow.posOffset.y, stow.posOffset.z);
    this.spine.localToWorld(stowWorldPosScratch);
    this.spine.getWorldQuaternion(stowWorldQuatScratch).multiply(stowLocalQuatScratch);

    if (stowEase >= 1 - 1e-4) {
      blendWorldPosScratch.copy(stowWorldPosScratch);
      blendWorldQuatScratch.copy(stowWorldQuatScratch);
    } else {
      this.weaponRoot.getWorldPosition(heldWorldPosScratch);
      this.weaponRoot.getWorldQuaternion(heldWorldQuatScratch);
      blendWorldPosScratch.lerpVectors(heldWorldPosScratch, stowWorldPosScratch, stowEase);
      blendWorldPosScratch.y += stow.arcLift * Math.sin(Math.PI * stowEase);
      blendWorldQuatScratch.copy(heldWorldQuatScratch).slerp(stowWorldQuatScratch, stowEase);
    }

    this.handR.getWorldQuaternion(handQuatScratch);
    handQuatInvScratch.copy(handQuatScratch).invert();
    this.weaponRoot.position.copy(this.handR.worldToLocal(blendWorldPosScratch));
    this.weaponRoot.quaternion.copy(handQuatInvScratch).multiply(blendWorldQuatScratch);
    this.weaponRoot.updateMatrixWorld(true);
  }


  dispose(): void {
    this.weaponRoot.parent?.remove(this.weaponRoot);
  }
}

function cloneSwordFrame(scene: Group, frameName: string): Object3D {
  if (frameName === "whole-scene") return scene.clone(true);
  let frame: Object3D | null = null;
  scene.traverse((object) => {
    if (frame || object.name !== frameName) return;
    if (object instanceof Mesh || object instanceof Group) frame = object;
  });
  return (frame ?? scene).clone(true);
}
