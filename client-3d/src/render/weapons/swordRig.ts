// swordRig.ts — per-pawn melee attachment (hand weld + back stow).
//
// Contract (<weapon>_attach.json + melee animation contract):
// - The frame is welded to hand_r with mount_hand_r_local pos/quat AS
//   AUTHORED. There is no bore leveling and no IK in melee v1.
// - Out of combat the weapon rides a spine_03-relative back socket. That
//   socket is AUTHORED PER MODEL (spec.stow) because the catalogue mixes
//   coordinate conventions: the legacy Vibrosword is a +Z-blade frame while
//   the melee_early family (machete / saber / chopper) is +Y-blade. Forcing
//   one shared rotation onto both laid the +Y blades horizontally across the
//   pawn's neck. A model without an authored socket falls back to the legacy
//   swordStow tuning, which is what keeps the Vibrosword pose byte-identical.
import { Bone, Euler, Group, Mesh, Object3D, Quaternion, Vector3 } from "three";
import { SUCCESSOR_3D_CONFIG } from "../../config";
import type { PawnPack, SlugthrowerAttachSpec, VibroswordAttachSpec } from "../../assets/pawnRigTypes";

const DEG_TO_RAD = Math.PI / 180;
const stowWorldPosScratch = new Vector3();
const stowWorldQuatScratch = new Quaternion();
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
  /** This model's own carry, resolved once: authored socket or legacy default. */
  private readonly stowPos = new Vector3();
  private readonly stowQuat = new Quaternion();
  private readonly stowArcLift: number;

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

    const legacy = SUCCESSOR_3D_CONFIG.pawnPack.swordStow;
    const authored = spec.stow;
    if (authored) {
      this.stowPos.copy(authored.pos);
      this.stowQuat.setFromEuler(stowEulerScratch.set(
        authored.rotDeg.x * DEG_TO_RAD,
        authored.rotDeg.y * DEG_TO_RAD,
        authored.rotDeg.z * DEG_TO_RAD,
        "XYZ",
      ));
      this.stowArcLift = authored.arcLift;
    } else {
      this.stowPos.set(legacy.posOffset.x, legacy.posOffset.y, legacy.posOffset.z);
      this.stowQuat.setFromEuler(stowEulerScratch.set(
        legacy.rotOffsetDeg.x * DEG_TO_RAD,
        legacy.rotOffsetDeg.y * DEG_TO_RAD,
        legacy.rotOffsetDeg.z * DEG_TO_RAD,
        "XYZ",
      ));
      this.stowArcLift = legacy.arcLift;
    }
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
   * Weapon-local palm point. Anything welded into the hand (the dev plasma
   * hilt preview) must sit HERE, not at the weaponRoot origin: on a model
   * whose origin is up the blade — the Vibrosword's is 0.1525 m up — the
   * origin is out in mid-air ahead of the hand.
   */
  gripLocal(out: Vector3): Vector3 {
    const sockets = this.spec.sockets;
    if ("grip" in sockets) return out.copy(sockets.grip);
    return out.copy(sockets.wrapMid);
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
    if (this.stowT !== this.stowTarget) {
      const stowStep = dtSeconds / Math.max(1e-3, SUCCESSOR_3D_CONFIG.pawnPack.swordStow.blendSeconds);
      this.stowT += Math.min(stowStep, Math.abs(this.stowTarget - this.stowT)) * Math.sign(this.stowTarget - this.stowT);
    }
    const stowEase = this.stowT * this.stowT * (3 - 2 * this.stowT);

    // Held endpoint is always the authored hand weld. No leveling, no offsets.
    this.weaponRoot.position.copy(this.spec.mountPos);
    this.weaponRoot.quaternion.copy(this.spec.mountQuat);
    this.weaponRoot.updateMatrixWorld(true);

    if (this.stowT <= 0 || !this.spine) return;

    // Per-model socket, resolved in the ctor — no per-frame euler rebuild.
    stowWorldPosScratch.copy(this.stowPos);
    this.spine.localToWorld(stowWorldPosScratch);
    this.spine.getWorldQuaternion(stowWorldQuatScratch).multiply(this.stowQuat);

    if (stowEase >= 1 - 1e-4) {
      blendWorldPosScratch.copy(stowWorldPosScratch);
      blendWorldQuatScratch.copy(stowWorldQuatScratch);
    } else {
      this.weaponRoot.getWorldPosition(heldWorldPosScratch);
      this.weaponRoot.getWorldQuaternion(heldWorldQuatScratch);
      blendWorldPosScratch.lerpVectors(heldWorldPosScratch, stowWorldPosScratch, stowEase);
      blendWorldPosScratch.y += this.stowArcLift * Math.sin(Math.PI * stowEase);
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
