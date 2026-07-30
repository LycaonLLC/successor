// twoBoneIk.ts — hand-rolled analytic two-bone IK (upperarm -> lowerarm -> hand).
//
// Deterministic, cheap, allocation-free (per animation contract: NOT CCDIK).
// The solver preserves the animated pose's pole plane: it first corrects the
// elbow interior angle around the CURRENT hinge axis, then aims the shoulder
// so the wrist lands on the target. Applied post-mixer; caller must have
// world matrices up to date before solving and must refresh the arm subtree's
// matrices afterwards (solve() does this for the three chain bones).
import { Bone, Quaternion, Vector3 } from "three";

const EPSILON = 1e-5;

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
  constructor(
    private readonly upper: Bone,
    private readonly lower: Bone,
    private readonly end: Bone,
  ) {}

  /**
   * Pull the end bone's origin onto `targetWorld`.
   * @param weight 0..1 blend between the animated pose and the solved pose.
   */
  solve(targetWorld: Vector3, weight: number): void {
    if (weight <= 0) return;
    this.upper.getWorldPosition(shoulderPos);
    this.lower.getWorldPosition(elbowPos);
    this.end.getWorldPosition(wristPos);

    upperVec.subVectors(elbowPos, shoulderPos);
    lowerVec.subVectors(wristPos, elbowPos);
    const a = upperVec.length();
    const b = lowerVec.length();
    if (a < EPSILON || b < EPSILON) return;

    toTarget.subVectors(targetWorld, shoulderPos);
    const reach = Math.min(Math.max(toTarget.length(), Math.abs(a - b) + EPSILON), a + b - EPSILON);

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
  }
}
