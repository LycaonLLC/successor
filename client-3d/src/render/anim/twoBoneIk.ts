// twoBoneIk.ts — hand-rolled analytic two-bone IK (upperarm -> lowerarm -> hand).
//
// Deterministic, cheap, allocation-free (per animation contract: NOT CCDIK).
// The solver preserves the animated pose's pole plane: it first corrects the
// elbow interior angle around the CURRENT hinge axis, then aims the shoulder
// so the wrist lands on the target. Applied post-mixer; caller must have
// world matrices up to date before solving and must refresh the arm subtree's
// matrices afterwards (solve() does this for the three chain bones).
//
// An optional per-model SupportArmSpec layers a HOLD POSTURE on that base
// solve. It exists because a support socket authored beyond the arm's reach
// (a + b) makes the base solve clamp to a locked-straight arm — the elbow
// collapses onto the shoulder->wrist line and the limb turns into a rod lying
// along the weapon. The posture keeps a floor under the elbow bend, pays for
// the reach that bend costs with a bounded shoulder-girdle swing, and rolls
// the retained bend to an authored pole angle. Absent -> nothing changes.
import { Bone, Quaternion, Vector3 } from "three";
import type { SupportArmSpec } from "../../assets/pawnRigTypes";

const EPSILON = 1e-5;
/** 1 mm, squared: below this the pole plane is numerical noise, not a pose. */
const POLE_PLANE_EPSILON = 1e-6;
const TAU = Math.PI * 2;

const shoulderPos = new Vector3();
const elbowPos = new Vector3();
const wristPos = new Vector3();
const upperVec = new Vector3();
const lowerVec = new Vector3();
const toTarget = new Vector3();
const hingeAxis = new Vector3();
const newWrist = new Vector3();
const fromDir = new Vector3();
const toDir = new Vector3();
const rootPos = new Vector3();
const girdleVec = new Vector3();
const advanceAxis = new Vector3();
const poleAxis = new Vector3();
const poleRef = new Vector3();
const poleSide = new Vector3();
const poleVec = new Vector3();
const parentWorldQuat = new Quaternion();
const worldRotation = new Quaternion();
const localRotation = new Quaternion();
const identityQuat = new Quaternion();

/** Premultiply `bone.quaternion` with a WORLD-space rotation, weighted. */
function applyWorldRotation(bone: Bone, rotation: Quaternion, weight: number): void {
  if (weight < 1) rotation.slerp(identityQuat, 1 - weight);
  const parent = bone.parent;
  if (parent) {
    parent.getWorldQuaternion(parentWorldQuat);
    localRotation.copy(parentWorldQuat).invert().multiply(rotation).multiply(parentWorldQuat);
  } else {
    localRotation.copy(rotation);
  }
  bone.quaternion.premultiply(localRotation);
}

export class TwoBoneIk {
  /** Girdle local rotation before the last swing, and the swing's result. */
  private readonly girdleRestPose = new Quaternion();
  private readonly girdleSwungPose = new Quaternion();
  private girdleSwung = false;

  constructor(
    private readonly upper: Bone,
    private readonly lower: Bone,
    private readonly end: Bone,
    /**
     * Shoulder girdle bone feeding `upper` (clavicle). Optional: it is only
     * ever touched by a hold posture that needs reach the arm does not have.
     */
    private readonly root: Bone | null = null,
  ) {}

  /**
   * Undo any outstanding girdle swing. The swing lands on a bone the base
   * clips may not animate, so the mixer will not wipe it: every frame that
   * does not re-solve — a stow, an "off" ik mode, a disposed rig — has to hand
   * the shoulder back or the pawn keeps a shrugged girdle. If the bone no
   * longer holds what we wrote, a clip has since claimed it and wins.
   */
  relax(): void {
    const root = this.root;
    if (!this.girdleSwung || root === null) return;
    this.girdleSwung = false;
    if (!root.quaternion.equals(this.girdleSwungPose)) return;
    root.quaternion.copy(this.girdleRestPose);
    root.updateWorldMatrix(false, true);
  }

  /**
   * Pull the end bone's origin onto `targetWorld`.
   * @param weight 0..1 blend between the animated pose and the solved pose.
   * @param posture optional per-model hold posture; null is the legacy solve.
   * @param postureWeight 0..1 strength of `posture`. The caller fades this with
   *   the hold itself, so a reload reach hands the elbow back to the animation
   *   instead of pinning it at the weapon's pole angle.
   */
  solve(
    targetWorld: Vector3,
    weight: number,
    posture: SupportArmSpec | null = null,
    postureWeight: number = weight,
  ): void {
    this.relax();
    if (weight <= 0) return;
    const hold = posture !== null && postureWeight > EPSILON ? posture : null;
    this.upper.getWorldPosition(shoulderPos);
    this.lower.getWorldPosition(elbowPos);
    this.end.getWorldPosition(wristPos);

    upperVec.subVectors(elbowPos, shoulderPos);
    lowerVec.subVectors(wristPos, elbowPos);
    const a = upperVec.length();
    const b = lowerVec.length();
    if (a < EPSILON || b < EPSILON) return;

    // Longest wrist reach this solve may ask for. Legacy: a hair short of a
    // locked-straight arm. Under a hold posture: the chord that still leaves
    // `minBendRad` at the elbow, so the limb can never collapse onto its axis.
    let reachLimit = a + b - EPSILON;
    if (hold !== null) {
      const bendFloor = hold.minBendRad * postureWeight;
      const bendLimit = Math.sqrt(a * a + b * b - 2 * a * b * Math.cos(Math.PI - bendFloor));
      if (bendLimit < reachLimit) reachLimit = bendLimit;
      this.advanceShoulder(targetWorld, reachLimit, hold, postureWeight);
      // The girdle swing moved the shoulder — re-read the chain it carries.
      this.upper.getWorldPosition(shoulderPos);
      this.lower.getWorldPosition(elbowPos);
      this.end.getWorldPosition(wristPos);
      upperVec.subVectors(elbowPos, shoulderPos);
      lowerVec.subVectors(wristPos, elbowPos);
    }

    toTarget.subVectors(targetWorld, shoulderPos);
    const reach = Math.min(Math.max(toTarget.length(), Math.abs(a - b) + EPSILON), reachLimit);

    // 1) Elbow: rotate the forearm about the current hinge axis to the interior
    //    angle demanded by the law of cosines.
    const cosDesired = Math.min(1, Math.max(-1, (a * a + b * b - reach * reach) / (2 * a * b)));
    const interiorDesired = Math.acos(cosDesired);
    const cosCurrent = Math.min(1, Math.max(-1, -upperVec.dot(lowerVec) / (a * b)));
    const interiorCurrent = Math.acos(cosCurrent);
    hingeAxis.crossVectors(upperVec, lowerVec);
    if (hingeAxis.lengthSq() < EPSILON) {
      // Straight arm: pick a stable hinge perpendicular to the upper arm.
      hingeAxis.set(0, 1, 0).cross(upperVec);
      if (hingeAxis.lengthSq() < EPSILON) hingeAxis.set(1, 0, 0).cross(upperVec);
    }
    hingeAxis.normalize();
    // Interior angle is between (S-E) and (W-E). With hinge = upper×lower, a
    // POSITIVE rotation of the forearm about the hinge DECREASES the interior
    // angle (verified: upper=(1,0,0), lower at 30° -> +10° about +Z takes the
    // interior 150°->140°), so drive the elbow by the NEGATED delta.
    const elbowDelta = interiorDesired - interiorCurrent;
    if (Math.abs(elbowDelta) > EPSILON) {
      worldRotation.setFromAxisAngle(hingeAxis, -elbowDelta);
      applyWorldRotation(this.lower, worldRotation, weight);
      // Predict the post-rotation wrist without re-walking matrices.
      worldRotation.setFromAxisAngle(hingeAxis, -elbowDelta * weight);
      newWrist.copy(lowerVec).applyQuaternion(worldRotation).add(elbowPos);
    } else {
      newWrist.copy(wristPos);
    }

    // 2) Shoulder: swing the whole arm so the wrist direction matches the target.
    fromDir.subVectors(newWrist, shoulderPos);
    toDir.copy(toTarget);
    if (fromDir.lengthSq() > EPSILON && toDir.lengthSq() > EPSILON) {
      fromDir.normalize();
      toDir.normalize();
      worldRotation.setFromUnitVectors(fromDir, toDir);
      applyWorldRotation(this.upper, worldRotation, weight);
    }

    this.upper.updateWorldMatrix(false, true);
    if (hold !== null) this.rollElbow(hold.poleRad, postureWeight);
  }

  /**
   * Swing the shoulder girdle toward the target so a retained elbow bend is
   * paid for in scapular travel instead of a hand that stops short of its
   * contact. Inert whenever the target already sits inside the bent-arm reach,
   * which is every pose of every weapon whose support socket is authored
   * within the arm.
   */
  private advanceShoulder(
    targetWorld: Vector3,
    reachLimit: number,
    hold: SupportArmSpec,
    weight: number,
  ): void {
    const root = this.root;
    if (root === null || hold.shoulderAdvanceMaxM <= EPSILON) return;
    toTarget.subVectors(targetWorld, shoulderPos);
    const deficit = toTarget.length() - reachLimit;
    if (deficit <= EPSILON) return;
    root.getWorldPosition(rootPos);
    girdleVec.subVectors(shoulderPos, rootPos);
    const girdleLength = girdleVec.length();
    if (girdleLength < EPSILON) return;
    // Rotating about girdle x toTarget carries the shoulder along the arc
    // toward the target; chord = 2 R sin(angle/2).
    advanceAxis.crossVectors(girdleVec, toTarget);
    if (advanceAxis.lengthSq() < EPSILON) return;
    advanceAxis.normalize();
    const chord = Math.min(hold.shoulderAdvanceMaxM * weight, deficit);
    worldRotation.setFromAxisAngle(advanceAxis, 2 * Math.asin(Math.min(1, chord / (2 * girdleLength))));
    this.girdleRestPose.copy(root.quaternion);
    applyWorldRotation(root, worldRotation, 1);
    this.girdleSwungPose.copy(root.quaternion);
    this.girdleSwung = true;
    root.updateWorldMatrix(false, true);
  }

  /**
   * Roll the whole arm about the shoulder->wrist axis until the elbow sits at
   * the authored pole angle (from world-down, positive toward axis x down).
   * The wrist lies ON that axis, so the authored contact never moves.
   */
  private rollElbow(poleRad: number, weight: number): void {
    this.upper.getWorldPosition(shoulderPos);
    this.lower.getWorldPosition(elbowPos);
    this.end.getWorldPosition(wristPos);
    poleAxis.subVectors(wristPos, shoulderPos);
    if (poleAxis.lengthSq() < EPSILON) return;
    poleAxis.normalize();
    // World-down with its along-axis component removed: the pole angle's zero.
    poleRef.set(0, -1, 0).addScaledVector(poleAxis, poleAxis.y);
    if (poleRef.lengthSq() < POLE_PLANE_EPSILON) return; // arm points straight up/down
    poleRef.normalize();
    poleSide.crossVectors(poleAxis, poleRef);
    poleVec.subVectors(elbowPos, shoulderPos);
    poleVec.addScaledVector(poleAxis, -poleVec.dot(poleAxis));
    if (poleVec.lengthSq() < POLE_PLANE_EPSILON) return; // straight arm: no plane to aim
    let delta = poleRad - Math.atan2(poleVec.dot(poleSide), poleVec.dot(poleRef));
    if (delta > Math.PI) delta -= TAU;
    else if (delta < -Math.PI) delta += TAU;
    delta *= weight;
    if (Math.abs(delta) < EPSILON) return;
    worldRotation.setFromAxisAngle(poleAxis, delta);
    applyWorldRotation(this.upper, worldRotation, 1);
    this.upper.updateWorldMatrix(false, true);
  }
}
