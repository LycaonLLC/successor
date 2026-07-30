// slugthrowerRig.ts — per-pawn Slugthrower attachment (socket weld + support-hand IK + mag).
//
// Contract (slugthrower_attach.json + animation contract §Hold+IK):
// - The weapon frame is welded to hand_r with mount_hand_r_local pos/quat
//   AS AUTHORED (user-tuned, never re-derived). The right arm needs no IK.
// - The left arm gets two-bone analytic IK to the `foregrip` socket world
//   position every frame the pawn is armed.
// - During the reload montage window [mag_eject_s=1.2s, mag_insert_s=2.8s]
//   the IK target retargets to the attach spec's mag node while the mag
//   animates OUT along its side-mount axis (measured local -X, ~12 cm),
//   holds, and reseats. Target switches ease over ~120 ms.
// - Muzzle world position (socket [0, 0.008, 0.438] weapon-local) is exposed
//   for the effects layer.
import { Bone, Euler, Group, Mesh, Object3D, Quaternion, Vector3 } from "three";
import { SUCCESSOR_3D_CONFIG } from "../../config";
import type { PawnPack, SlugthrowerAttachSpec } from "../../assets/pawnRigTypes";
import { TwoBoneIk } from "../anim/twoBoneIk";

interface AxisDials {
  x: number;
  y: number;
  z: number;
}

export interface Successor3dWeaponDials {
  posOffset: AxisDials;
  rotOffsetDeg: AxisDials;
  yawStrength: number;
  maxYawCorrectionRad: number;
  restingYawRad: number;
  /** Weapon-local offset from the foregrip socket to the support-hand WRIST target. */
  foregripContactOffset: AxisDials;
  /** Spine-local stow socket (out-of-combat back carry) — live-tunable. */
  stowPosOffset: AxisDials;
  stowRotOffsetDeg: AxisDials;
}

declare global {
  interface Window {
    __successor3dWeapon?: Successor3dWeaponDials;
  }
}

const targetScratch = new Vector3();
const previousScratch = new Vector3();
const MAG_GRAB_OFFSET = new Vector3(-0.075, 0, 0.045); // mid-mag in mag-local space (bbox center)
const IDENTITY_QUAT = new Quaternion();
const WELD_BLEND_SECONDS = 0.12;
const BORE_VERTICAL_SKIP_Y = 0.85;
const IK_WEIGHT_EASE_SECONDS = 0.12;
const MAG_IK_EASE_SECONDS = 0.2;
const WORLD_UP = new Vector3(0, 1, 0);
const DEG_TO_RAD = Math.PI / 180;
const DROP_TUMBLE_LOCAL_AXIS = new Vector3(0.35, 0.9, 0.2).normalize();
const mountDialDefaults = SUCCESSOR_3D_CONFIG.pawnPack.weaponMountDial;
const weaponDials: Successor3dWeaponDials = {
  posOffset: {
    x: mountDialDefaults.posOffset.x,
    y: mountDialDefaults.posOffset.y,
    z: mountDialDefaults.posOffset.z,
  },
  rotOffsetDeg: {
    x: mountDialDefaults.rotOffsetDeg.x,
    y: mountDialDefaults.rotOffsetDeg.y,
    z: mountDialDefaults.rotOffsetDeg.z,
  },
  yawStrength: SUCCESSOR_3D_CONFIG.pawnPack.boreLevel.yawStrength,
  maxYawCorrectionRad: SUCCESSOR_3D_CONFIG.pawnPack.boreLevel.maxYawCorrectionRad,
  restingYawRad: SUCCESSOR_3D_CONFIG.pawnPack.boreLevel.restingYawRad,
  foregripContactOffset: {
    x: SUCCESSOR_3D_CONFIG.pawnPack.foregripContactOffset.x,
    y: SUCCESSOR_3D_CONFIG.pawnPack.foregripContactOffset.y,
    z: SUCCESSOR_3D_CONFIG.pawnPack.foregripContactOffset.z,
  },
  stowPosOffset: {
    x: SUCCESSOR_3D_CONFIG.pawnPack.weaponStow.posOffset.x,
    y: SUCCESSOR_3D_CONFIG.pawnPack.weaponStow.posOffset.y,
    z: SUCCESSOR_3D_CONFIG.pawnPack.weaponStow.posOffset.z,
  },
  stowRotOffsetDeg: {
    x: SUCCESSOR_3D_CONFIG.pawnPack.weaponStow.rotOffsetDeg.x,
    y: SUCCESSOR_3D_CONFIG.pawnPack.weaponStow.rotOffsetDeg.y,
    z: SUCCESSOR_3D_CONFIG.pawnPack.weaponStow.rotOffsetDeg.z,
  },
};
let weaponDialUsers = 0;
// bore-leveling / mount-dial / drop scratch (module-level, zero per-frame allocation)
const gripWorldScratch = new Vector3();
const muzzleWorldScratch = new Vector3();
const boreScratch = new Vector3();
const boreLevelScratch = new Vector3();
const boreAxisScratch = new Vector3();
const levelQuatScratch = new Quaternion();
const handQuatScratch = new Quaternion();
const handQuatInvScratch = new Quaternion();
const gripHandLocalScratch = new Vector3();
const originOffsetScratch = new Vector3();
const mountPosScratch = new Vector3();
const mountQuatScratch = new Quaternion();
const mountRotEulerScratch = new Euler();
const mountOffsetQuatScratch = new Quaternion();
const pitchWorldQuatScratch = new Quaternion();
const yawWorldQuatScratch = new Quaternion();
const correctionWorldQuatScratch = new Quaternion();
const rootWorldQuatScratch = new Quaternion();
const rootForwardScratch = new Vector3();
const dropBoreScratch = new Vector3();
const dropWorldPosScratch = new Vector3();
const dropWorldQuatScratch = new Quaternion();
const dropTumbleQuatScratch = new Quaternion();
const dropParentQuatScratch = new Quaternion();
const dropParentQuatInvScratch = new Quaternion();
const stowWorldPosScratch = new Vector3();
const stowWorldQuatScratch = new Quaternion();
const stowLocalQuatScratch = new Quaternion();
const stowEulerScratch = new Euler();
const heldWorldPosScratch = new Vector3();
const heldWorldQuatScratch = new Quaternion();
const handWorldPosScratch = new Vector3();
const blendWorldPosScratch = new Vector3();
const blendWorldQuatScratch = new Quaternion();

export class SlugthrowerRig {
  private readonly weaponRoot = new Group();
  private readonly frame: Object3D;
  private readonly mag: Object3D | null;
  private readonly magSeatedPosition = new Vector3();
  private readonly ik: TwoBoneIk | null;
  private readonly currentTarget = new Vector3();
  private targetMode: "foregrip" | "mag" | "belt" = "foregrip";
  private previousMode: "foregrip" | "mag" | "belt" = "foregrip";
  private ikWeight = 0;
  private targetBlendRemaining = 0;
  private targetBlendSeconds = 0;
  private magOut = 0; // 0 = seated, 1 = pulled out
  private lastLevelAppliedRad = 0;
  private weldBlend = 1;
  private readonly lastLevelLocalQuat = new Quaternion();
  private lastLevelHasValid = false;
  private dropped = false;
  private dropSettled = false;
  private dropElapsed = 0;
  private dropParent: Object3D | null = null;
  private readonly dropStartPos = new Vector3();
  private readonly dropEndPos = new Vector3();
  private readonly dropStartQuat = new Quaternion();
  private readonly dropTumbleAxis = new Vector3();
  private fallenMag: Object3D | null = null;
  private fallenMagElapsed = 0;
  private fallenMagSpawnedThisReload = false;
  private readonly fallenMagStart = new Vector3();
  private readonly fallenMagEnd = new Vector3();
  private bodyRef: Object3D;
  /** 0 = held in hands, 1 = stowed on the back; eases toward stowTarget. */
  private stowT = 0;
  private stowTarget = 0;
  private readonly spine: Bone | null;

  constructor(
    private readonly pack: PawnPack,
    private readonly handR: Bone,
    upperArmL: Bone | null,
    lowerArmL: Bone | null,
    handL: Bone | null,
    spineBone: Bone | null = null,
    private readonly spec: SlugthrowerAttachSpec = pack.slugthrower,
    weaponScene: Group = pack.slugthrowerScene,
    private readonly weaponScale: number = 1,
  ) {
    // The legacy registry contains one mesh per weapon and historically welded
    // that mesh directly. Accepted PawnForge assemblies are complete scenes:
    // every module is a sibling mesh under the authored runtime root (and may
    // include cosmetic action meshes). Keep the legacy path byte/pose-stable,
    // but clone the whole scene whenever it is genuinely multi-mesh so no
    // accepted module silently disappears.
    let meshCount = 0;
    weaponScene.traverse((object) => {
      if (object instanceof Mesh) meshCount += 1;
    });
    if (meshCount > 1) {
      const clonedScene = weaponScene.clone(true);
      let frame: Object3D | null = clonedScene.getObjectByName(this.spec.nodes.frame) ?? null;
      if (!frame) {
        clonedScene.traverse((object) => {
          if (!frame && object instanceof Mesh) frame = object;
        });
      }
      this.frame = frame ?? clonedScene;
      this.mag = this.spec.nodes.mag
        ? clonedScene.getObjectByName(this.spec.nodes.mag) ?? null
        : null;
      this.weaponRoot.add(clonedScene);
    } else {
      let frame: Object3D | null = null;
      let mag: Object3D | null = null;
      weaponScene.traverse((object) => {
        if (!(object instanceof Mesh)) return;
        if (object.name === this.spec.nodes.frame) frame = object;
        if (this.spec.nodes.mag && object.name === this.spec.nodes.mag) mag = object;
      });
      this.frame = cloneWeaponMesh(frame) ?? new Group();
      this.mag = cloneWeaponMesh(mag);
      this.weaponRoot.add(this.frame);
      if (this.mag) this.weaponRoot.add(this.mag);
    }
    if (this.mag) this.magSeatedPosition.copy(this.mag.position);
    this.weaponRoot.name = "weapon";
    this.weaponRoot.position.copy(this.spec.mountPos);
    this.weaponRoot.quaternion.copy(this.spec.mountQuat);
    this.weaponRoot.scale.setScalar(this.weaponScale);
    handR.add(this.weaponRoot);
    // Body-space anchor for pouch reaches: first non-bone ancestor of the
    // weld hand = the skinned body root (model space, +X = anatomical left).
    let bodyRef: Object3D = handR;
    while (bodyRef.parent && (bodyRef instanceof Bone || bodyRef.parent instanceof Bone)) bodyRef = bodyRef.parent;
    this.bodyRef = bodyRef;
    this.ik = upperArmL && lowerArmL && handL ? new TwoBoneIk(upperArmL, lowerArmL, handL) : null;
    this.spine = spineBone;
    retainWeaponDials();
  }

  setVisible(visible: boolean): void {
    this.weaponRoot.visible = this.dropped ? true : visible;
  }

  /**
   * Out-of-combat back carry (owner spec 2026-07-03). The weapon stays
   * hand_r-parented; while stowed its LOCAL transform is recomputed every
   * frame from the spine stow socket, so it is visually glued to the back
   * (inheriting spine sway) with zero reparent churn. The flourish is a
   * world-space arc between the two poses.
   */
  setStowed(stowed: boolean, options?: { readonly snap?: boolean }): void {
    if (this.dropped) return;
    this.stowTarget = stowed ? 1 : 0;
    if (options?.snap === true) this.stowT = this.stowTarget;
  }

  isStowed(): boolean {
    return this.stowT > 0.999;
  }

  isDropped(): boolean {
    return this.dropped;
  }

  dropToWorld(worldParent: Object3D): void {
    if (this.dropped) return;
    const config = SUCCESSOR_3D_CONFIG.pawnPack.weaponDrop;
    this.dropped = true;
    this.dropSettled = false;
    this.dropElapsed = 0;
    this.dropParent = worldParent;
    this.weaponRoot.visible = true;
    worldParent.updateWorldMatrix(true, false);
    this.weaponRoot.updateWorldMatrix(true, true);
    this.weaponRoot.getWorldPosition(this.dropStartPos);
    this.weaponRoot.getWorldQuaternion(this.dropStartQuat);
    worldParent.attach(this.weaponRoot);
    this.weaponRoot.updateWorldMatrix(true, true);
    this.frame.localToWorld(gripWorldScratch.copy(this.spec.sockets.grip));
    this.frame.localToWorld(muzzleWorldScratch.copy(this.spec.sockets.muzzle));
    dropBoreScratch.subVectors(muzzleWorldScratch, gripWorldScratch);
    dropBoreScratch.y = 0;
    if (dropBoreScratch.lengthSq() > 1e-6) {
      dropBoreScratch.normalize();
    } else {
      dropBoreScratch.set(0, 0, 1).applyQuaternion(this.dropStartQuat);
      dropBoreScratch.y = 0;
      if (dropBoreScratch.lengthSq() > 1e-6) dropBoreScratch.normalize();
    }
    this.dropEndPos.copy(this.dropStartPos).addScaledVector(dropBoreScratch, config.slideCells);
    this.dropEndPos.y = SUCCESSOR_3D_CONFIG.terrain.y + config.groundEpsilon;
    this.dropTumbleAxis.copy(DROP_TUMBLE_LOCAL_AXIS).applyQuaternion(this.dropStartQuat).normalize();
  }

  /**
   * Un-drop (DEF-11): the pawn stood back up (revive/respawn) or re-equipped
   * while the rig still lay where death dropped it — without recovery the
   * orphaned ground mesh keeps owning the muzzle socket and every bolt fires
   * from the dirt. Reparent back to the hand weld, clear the drop state, and
   * re-ease the leveling weld in from zero so the first held frame never pops
   * a stale correction.
   */
  recoverFromDrop(): void {
    if (!this.dropped) return;
    this.dropped = false;
    this.dropSettled = false;
    this.dropElapsed = 0;
    this.dropParent = null;
    this.handR.add(this.weaponRoot); // removes it from the world parent
    this.weaponRoot.position.copy(this.spec.mountPos);
    this.weaponRoot.quaternion.copy(this.spec.mountQuat);
    this.weaponRoot.updateMatrixWorld(true);
    this.weldBlend = 0;
    this.lastLevelHasValid = false;
  }

  /**
   * Post-mixer update: bore leveling + reload choreography + support-hand IK.
   * Caller must have the pawn's world matrices current (updateWorldMatrix on
   * the pawn root after mixer/torso-yaw) before calling.
   *
   * @param reload progress through the server reload window, or null. The
   *   body holds its normal pose (no reload montage — owner spec 2026-07-03);
   *   the support hand performs the whole mag swap procedurally as a pure
   *   function of progress, so the Lab scrubber replays it deterministically.
   * @param ikMode "off" while a full-body montage (death) owns the arms;
   *   "on" during reload or on the legacy lane whose base clips leave the
   *   left arm unposed; "auto" (rifle_* lane) lets the rig engage IK only
   *   when bore leveling displaced the foregrip enough that the authored
   *   left hand would visibly detach.
   */
  update(
    dtSeconds: number,
    reload: { elapsedS: number; totalS: number } | null,
    ikMode: "off" | "auto" | "on",
    bodyYawRad?: number,
    aimYawRad?: number | null,
  ): void {
    this.updateFallenMag(dtSeconds);
    if (this.dropped) {
      this.updateDropped(dtSeconds);
      return;
    }
    const config = SUCCESSOR_3D_CONFIG.pawnPack;
    this.lastLevelAppliedRad = 0; // set by the leveling block when it corrects

    // ── Out-of-combat stow ease (owner spec 2026-07-03) ─────────────────────
    const stow = config.weaponStow;
    if (this.stowT !== this.stowTarget) {
      const stowStep = dtSeconds / Math.max(1e-3, stow.blendSeconds);
      this.stowT += Math.min(stowStep, Math.abs(this.stowTarget - this.stowT)) * Math.sign(this.stowTarget - this.stowT);
    }
    const stowEase = this.stowT * this.stowT * (3 - 2 * this.stowT); // smoothstep
    if (this.stowT > 0) {
      // Reload/mag choreography is hand-space theater — suppress while the
      // weapon rides the back (server reload keeps ticking; visuals resume
      // on draw). Weld corrective fades WITH the stow so the draw re-eases
      // leveling in instead of popping to a stale correction.
      reload = null;
      this.weldBlend = Math.min(this.weldBlend, 1 - stowEase);
    }

    // ── Procedural reload choreography ──────────────────────────────────────
    // Reach → pull → drop (mag falls) → fetch fresh → seat → settle. The gun
    // itself never leaves the leveled hold.
    let magTargetOut = 0;
    let magVisible = true;
    let mode: "foregrip" | "mag" | "belt" = "foregrip";
    if (reload !== null && reload.totalS > 1e-3) {
      const f = Math.min(1, Math.max(0, reload.elapsedS / reload.totalS));
      if (f < 0.12) {
        mode = "mag"; // reach to the mag well
        if (f < 0.06) this.fallenMagSpawnedThisReload = false; // re-arm (looping Lab playback)
      } else if (f < 0.3) {
        mode = "mag"; // pull the mag out
        magTargetOut = 1;
      } else if (f < 0.42) {
        mode = "belt"; // release — spent mag drops free, hand sweeps to the hip
        magTargetOut = 1;
        magVisible = false;
        this.spawnFallenMag();
      } else if (f < 0.6) {
        mode = "belt"; // hand at the pouch fetching a fresh mag
        magTargetOut = 1;
        magVisible = false;
      } else if (f < 0.78) {
        mode = "mag"; // bring the fresh mag up to the well
        magTargetOut = 1;
        magVisible = false;
      } else if (f < 0.9) {
        mode = "mag"; // seat it (mag slides home)
      } else {
        mode = "foregrip"; // settle back to the hold
      }
    } else {
      this.fallenMagSpawnedThisReload = false; // re-arm for the next reload
    }
    if (this.mag) this.mag.visible = magVisible;
    const magRate = dtSeconds / Math.max(1e-3, config.magTweenSeconds);
    this.magOut += Math.min(magRate, Math.abs(magTargetOut - this.magOut)) * Math.sign(magTargetOut - this.magOut);
    if (this.mag) {
      const eased = this.magOut * this.magOut * (3 - 2 * this.magOut); // smoothstep
      this.mag.position.copy(this.magSeatedPosition);
      this.mag.position.x -= config.magPullOutMeters * eased;
    }

    // ── Deterministic bore leveling / reload weld blend ─────────────────────
    // The barrel direction is a CONSTRAINT, not a tuned constant: pivot the
    // weapon around its GRIP socket (the tuned palm weld point stays put) so
    // the bore line (grip -> muzzle, from slugthrower_attach.json) is horizontal and
    // yaw-aligned to aim/body. Reload needs the authored weld for mag
    // choreography, so the corrective weld eases out/in over transitions.
    const level = config.boreLevel;
    const dials = window.__successor3dWeapon ?? weaponDials;
    const yawStrength = finiteDial(dials.yawStrength, level.yawStrength);
    const maxYawCorrectionRad = Math.max(0, finiteDial(dials.maxYawCorrectionRad, level.maxYawCorrectionRad));
    const restingYawRad = finiteDial(dials.restingYawRad, level.restingYawRad);
    const weldTarget = level.strength > 0 || yawStrength > 0 ? 1 : 0;
    if (this.weldBlend !== weldTarget) {
      const weldStep = Math.min(1, dtSeconds / WELD_BLEND_SECONDS);
      this.weldBlend += Math.min(weldStep, Math.abs(weldTarget - this.weldBlend)) * Math.sign(weldTarget - this.weldBlend);
    }
    const weldEase = this.weldBlend * this.weldBlend * (3 - 2 * this.weldBlend); // smoothstep

    // Measure the RAW clip-driven bore: reset to the authored weld plus live
    // mount dial first so last frame's corrective never contaminates this frame.
    applyMountDials(this.spec, dials, mountPosScratch, mountQuatScratch);
    this.weaponRoot.position.copy(mountPosScratch);
    this.weaponRoot.quaternion.copy(mountQuatScratch);
    this.weaponRoot.updateMatrixWorld(true);
    if (this.stowT === 0 && (level.strength > 0 || yawStrength > 0)) {
      this.frame.localToWorld(gripWorldScratch.copy(this.spec.sockets.grip));
      this.frame.localToWorld(muzzleWorldScratch.copy(this.spec.sockets.muzzle));
      boreScratch.subVectors(muzzleWorldScratch, gripWorldScratch);
      const boreLength = boreScratch.length();
      if (boreLength > 1e-4) {
        boreScratch.multiplyScalar(1 / boreLength);
        boreLevelScratch.set(boreScratch.x, 0, boreScratch.z);
        const horizontalLenSq = boreLevelScratch.lengthSq();
        let computedCorrection = false;
        let hasCorrection = false;
        correctionWorldQuatScratch.identity();

        // Desired pitch: same heading, zero vertical component. When the bore is
        // nearly vertical the heading is undefined, so keep the last valid
        // correction instead of asking a general arc solver to invent a spin.
        if (level.strength > 0 && Math.abs(boreScratch.y) <= BORE_VERTICAL_SKIP_Y && horizontalLenSq > 1e-6) {
          boreLevelScratch.normalize();
          boreAxisScratch.crossVectors(WORLD_UP, boreLevelScratch);
          if (boreAxisScratch.lengthSq() > 1e-6) {
            boreAxisScratch.normalize();
            const rawPitch = Math.asin(Math.max(-1, Math.min(1, boreScratch.y)));
            const correctionAngle = Math.max(
              -level.maxCorrectionRad,
              Math.min(level.maxCorrectionRad, rawPitch * level.strength),
            );
            computedCorrection = true;
            if (Math.abs(correctionAngle) > 1e-4) {
              pitchWorldQuatScratch.setFromAxisAngle(boreAxisScratch, correctionAngle);
              correctionWorldQuatScratch.copy(pitchWorldQuatScratch);
              hasCorrection = true;
            }
          }
        }

        // Desired yaw: when aiming, point the bore at aimYaw; otherwise keep a
        // small natural resting offset from the pawn body's forward.
        if (yawStrength > 0 && horizontalLenSq > 1e-6) {
          const bodyYaw = typeof bodyYawRad === "number" && Number.isFinite(bodyYawRad)
            ? bodyYawRad
            : this.inferBodyYaw();
          const aiming = typeof aimYawRad === "number" && Number.isFinite(aimYawRad);
          const targetYaw = wrapAngle((aiming ? aimYawRad : bodyYaw + restingYawRad) as number);
          const boreYaw = Math.atan2(boreScratch.x, boreScratch.z);
          const yawError = wrapAngle(targetYaw - boreYaw);
          const correctionAngle = Math.max(
            -maxYawCorrectionRad,
            Math.min(maxYawCorrectionRad, yawError * yawStrength),
          );
          computedCorrection = true;
          if (Math.abs(correctionAngle) > 1e-4) {
            yawWorldQuatScratch.setFromAxisAngle(WORLD_UP, correctionAngle);
            if (hasCorrection) {
              correctionWorldQuatScratch.premultiply(yawWorldQuatScratch);
            } else {
              correctionWorldQuatScratch.copy(yawWorldQuatScratch);
              hasCorrection = true;
            }
          }
        }

        if (computedCorrection) {
          if (hasCorrection) {
            // World corrective -> hand_r local: q_local = h⁻¹ · q_world · h
            this.handR.getWorldQuaternion(handQuatScratch);
            handQuatInvScratch.copy(handQuatScratch).invert();
            levelQuatScratch.copy(correctionWorldQuatScratch)
              .premultiply(handQuatInvScratch)
              .multiply(handQuatScratch);
            this.lastLevelLocalQuat.copy(levelQuatScratch);
          } else {
            this.lastLevelLocalQuat.identity();
          }
          this.lastLevelHasValid = true;
        }
      }
    }
    if (this.stowT === 0 && (level.strength > 0 || yawStrength > 0) && this.lastLevelHasValid && weldEase > 1e-4) {
      levelQuatScratch.copy(this.lastLevelLocalQuat);
      const fullAngle = 2 * Math.acos(Math.min(1, Math.abs(levelQuatScratch.w)));
      this.lastLevelAppliedRad = fullAngle * weldEase;
      if (weldEase < 1) levelQuatScratch.slerp(IDENTITY_QUAT, 1 - weldEase);
      // Pivot around the grip socket in hand space: grip stays welded.
      gripHandLocalScratch.copy(this.spec.sockets.grip)
        .multiplyScalar(this.weaponScale)
        .applyQuaternion(mountQuatScratch)
        .add(mountPosScratch);
      originOffsetScratch.subVectors(mountPosScratch, gripHandLocalScratch)
        .applyQuaternion(levelQuatScratch);
      this.weaponRoot.position.copy(gripHandLocalScratch).add(originOffsetScratch);
      this.weaponRoot.quaternion.copy(levelQuatScratch).multiply(mountQuatScratch);
      this.weaponRoot.updateMatrixWorld(true);
    }
    // ── Stow pose: spine-socket world → hand_r-local, every frame ───────────
    // Both blend endpoints are LIVE (held = raw weld pose set above; stowed =
    // spine socket), so the flourish is a pure morph between moving anchors —
    // the same live-endpoint rule the IK targets follow.
    if (this.stowT > 0 && this.spine) {
      const stowPosDial = dials.stowPosOffset;
      const stowRotDial = dials.stowRotOffsetDeg;
      stowEulerScratch.set(
        finiteDial(stowRotDial.x, 0) * DEG_TO_RAD,
        finiteDial(stowRotDial.y, 0) * DEG_TO_RAD,
        finiteDial(stowRotDial.z, 0) * DEG_TO_RAD,
        "XYZ",
      );
      stowLocalQuatScratch.setFromEuler(stowEulerScratch);
      stowWorldPosScratch.set(
        finiteDial(stowPosDial.x, 0),
        finiteDial(stowPosDial.y, 0),
        finiteDial(stowPosDial.z, 0),
      );
      this.spine.localToWorld(stowWorldPosScratch);
      this.spine.getWorldQuaternion(stowWorldQuatScratch).multiply(stowLocalQuatScratch);
      if (stowEase >= 1 - 1e-4) {
        blendWorldPosScratch.copy(stowWorldPosScratch);
        blendWorldQuatScratch.copy(stowWorldQuatScratch);
      } else {
        this.weaponRoot.getWorldPosition(heldWorldPosScratch);
        this.weaponRoot.getWorldQuaternion(heldWorldQuatScratch);
        blendWorldPosScratch.lerpVectors(heldWorldPosScratch, stowWorldPosScratch, stowEase);
        // Arc over the shoulder, never through the torso.
        blendWorldPosScratch.y += stow.arcLift * Math.sin(Math.PI * stowEase);
        blendWorldQuatScratch.copy(heldWorldQuatScratch).slerp(stowWorldQuatScratch, stowEase);
      }
      this.handR.getWorldQuaternion(handQuatScratch);
      handQuatInvScratch.copy(handQuatScratch).invert();
      this.weaponRoot.position.copy(this.handR.worldToLocal(blendWorldPosScratch));
      this.weaponRoot.quaternion.copy(handQuatInvScratch).multiply(blendWorldQuatScratch);
      this.weaponRoot.updateMatrixWorld(true);
    }
    // IK engagement (standard weapon-IK shape): armed IK is always meaningful
    // now that bore leveling permanently displaces the weapon from the
    // authored pose, so any non-"off" mode drives IK; the weight EASES in/out
    // instead of toggling, so engage/disengage never snaps the arm.
    const wantIk = this.ik !== null && ikMode !== "off" && this.stowT < 1e-3;
    const ikTargetWeight = wantIk ? 1 : 0;
    if (this.ikWeight !== ikTargetWeight) {
      const step = dtSeconds / IK_WEIGHT_EASE_SECONDS;
      this.ikWeight += Math.min(step, Math.abs(ikTargetWeight - this.ikWeight)) * Math.sign(ikTargetWeight - this.ikWeight);
    }
    if (!this.ik || this.ikWeight < 1e-3) {
      return;
    }

    // Live-endpoint target resolution: the CURRENT and (while blending) the
    // PREVIOUS mode's anchor points are both recomputed from live transforms
    // every frame, so the hand tracks the weapon/body 1:1 — a target switch
    // is a pure shape morph between two moving anchors. NEVER rate-limit an
    // IK target in world space: body locomotion and turns move the sockets
    // several m/s and a clamp makes the hand trail the pawn (owner report
    // 2026-07-03: hand pinned mid-air while walking/turning, per-shot twitch).
    if (mode !== this.targetMode) {
      this.previousMode = this.targetMode;
      this.targetMode = mode;
      this.targetBlendSeconds = mode === "mag" || this.previousMode === "mag"
        ? Math.max(config.ikEaseSeconds, MAG_IK_EASE_SECONDS)
        : config.ikEaseSeconds;
      this.targetBlendRemaining = this.targetBlendSeconds;
    }
    this.computeTargetWorld(this.targetMode, targetScratch);
    if (this.targetBlendRemaining > 0) {
      const blendSeconds = Math.max(1e-3, this.targetBlendSeconds || config.ikEaseSeconds);
      this.targetBlendRemaining = Math.max(0, this.targetBlendRemaining - dtSeconds);
      const linearBlend = 1 - this.targetBlendRemaining / blendSeconds;
      const blend = linearBlend * linearBlend * (3 - 2 * linearBlend); // smoothstep
      this.computeTargetWorld(this.previousMode, previousScratch);
      this.currentTarget.lerpVectors(previousScratch, targetScratch, blend);
    } else {
      this.currentTarget.copy(targetScratch);
    }
    this.ik.solve(this.currentTarget, this.ikWeight);
  }

  /** Muzzle socket world position. Requires current world matrices. */
  getMuzzleWorld(out: Vector3): Vector3 {
    return this.frame.localToWorld(out.copy(this.spec.sockets.muzzle));
  }

  /** Grip socket world position (bore tail; muzzle - grip = bore direction).
   * Requires current world matrices. */
  getGripWorld(out: Vector3): Vector3 {
    return this.frame.localToWorld(out.copy(this.spec.sockets.grip));
  }

  /** Root of the (cloned) attached weapon scene — FX/animation attach point.
   * The Asset Lab binds an AnimationMixer here to play the weapon GLB's own
   * embedded action clips (fire cycles); runtime combat does not use it. */
  weaponObject(): Object3D {
    return this.weaponRoot;
  }

  dispose(): void {
    this.weaponRoot.parent?.remove(this.weaponRoot);
    if (this.fallenMag) {
      this.fallenMag.parent?.remove(this.fallenMag);
      this.fallenMag = null;
    }
    releaseWeaponDials();
  }

  /** Spawn the spent-mag drop once per reload: clone falls from the mag's
   * current world pose to the ground and lies there briefly. */
  private spawnFallenMag(): void {
    if (this.fallenMagSpawnedThisReload || !this.mag) return;
    this.fallenMagSpawnedThisReload = true;
    let worldParent: Object3D = this.handR;
    while (worldParent.parent) worldParent = worldParent.parent;
    const clone = cloneWeaponMesh(this.mag);
    if (!clone) return;
    this.mag.updateWorldMatrix(true, false);
    this.mag.getWorldPosition(this.fallenMagStart);
    this.mag.getWorldQuaternion(dropWorldQuatScratch);
    this.fallenMagEnd.copy(this.fallenMagStart);
    this.fallenMagEnd.x += 0.08;
    this.fallenMagEnd.z += 0.05;
    this.fallenMagEnd.y = SUCCESSOR_3D_CONFIG.terrain.y + 0.015;
    worldParent.updateWorldMatrix(true, false);
    worldParent.worldToLocal(this.fallenMagStart);
    worldParent.worldToLocal(this.fallenMagEnd);
    worldParent.getWorldQuaternion(dropParentQuatScratch);
    dropParentQuatInvScratch.copy(dropParentQuatScratch).invert();
    clone.position.copy(this.fallenMagStart);
    clone.quaternion.copy(dropParentQuatInvScratch).multiply(dropWorldQuatScratch);
    clone.visible = true;
    worldParent.add(clone);
    if (this.fallenMag) this.fallenMag.parent?.remove(this.fallenMag);
    this.fallenMag = clone;
    this.fallenMagElapsed = 0;
  }

  private updateFallenMag(dtSeconds: number): void {
    const mag = this.fallenMag;
    if (!mag) return;
    this.fallenMagElapsed += dtSeconds;
    const fallSeconds = 0.4;
    const lieSeconds = 6;
    if (this.fallenMagElapsed <= fallSeconds) {
      const t = this.fallenMagElapsed / fallSeconds;
      const drop = t * t; // gravity-ish ease-in
      mag.position.lerpVectors(this.fallenMagStart, this.fallenMagEnd, drop);
      mag.rotateX(2.4 * dtSeconds); // small tumble on the way down
    } else if (this.fallenMagElapsed > fallSeconds + lieSeconds) {
      mag.parent?.remove(mag);
      this.fallenMag = null;
    }
  }

  private updateDropped(dtSeconds: number): void {
    if (this.dropSettled) return;
    const config = SUCCESSOR_3D_CONFIG.pawnPack.weaponDrop;
    const duration = Math.max(1e-3, config.durationSeconds);
    this.dropElapsed = Math.min(duration, this.dropElapsed + Math.max(0, dtSeconds));
    const t = this.dropElapsed / duration;
    const slideT = 1 - (1 - t) * (1 - t);
    const fallT = t * t;
    dropWorldPosScratch.copy(this.dropStartPos).lerp(this.dropEndPos, slideT);
    dropWorldPosScratch.y = this.dropStartPos.y + (this.dropEndPos.y - this.dropStartPos.y) * fallT;
    if (this.dropParent) {
      this.weaponRoot.position.copy(this.dropParent.worldToLocal(dropWorldPosScratch));
    } else {
      this.weaponRoot.position.copy(dropWorldPosScratch);
    }
    dropTumbleQuatScratch.setFromAxisAngle(
      this.dropTumbleAxis,
      config.tumbleRotations * Math.PI * 2 * slideT,
    );
    dropWorldQuatScratch.copy(dropTumbleQuatScratch).multiply(this.dropStartQuat);
    if (this.dropParent) {
      this.dropParent.getWorldQuaternion(dropParentQuatScratch);
      dropParentQuatInvScratch.copy(dropParentQuatScratch).invert();
      this.weaponRoot.quaternion.copy(dropParentQuatInvScratch).multiply(dropWorldQuatScratch);
    } else {
      this.weaponRoot.quaternion.copy(dropWorldQuatScratch);
    }
    this.weaponRoot.updateMatrixWorld(true);
    if (this.dropElapsed >= duration) this.dropSettled = true;
  }

  private inferBodyYaw(): number {
    let root: Object3D = this.handR;
    while (root.parent && root.parent.parent) root = root.parent;
    root.getWorldQuaternion(rootWorldQuatScratch);
    rootForwardScratch.set(0, 0, 1).applyQuaternion(rootWorldQuatScratch);
    rootForwardScratch.y = 0;
    if (rootForwardScratch.lengthSq() <= 1e-6) return 0;
    rootForwardScratch.normalize();
    return Math.atan2(rootForwardScratch.x, rootForwardScratch.z);
  }
  private computeTargetWorld(mode: "foregrip" | "mag" | "belt", out: Vector3): void {
    if (mode === "mag" && this.mag) {
      this.mag.localToWorld(out.copy(MAG_GRAB_OFFSET));
      return;
    }
    if (mode === "belt") {
      // Pouch reach in BODY space (weapon-local axes point wherever the gun
      // points — a hip pouch does not). Model space: +X = anatomical LEFT, so
      // the SUPPORT hand dips to its own-side (left) hip, never cross-body
      // to the right pocket (owner report 2026-07-03).
      out.set(0.24, 0.86, 0.1);
      this.bodyRef.localToWorld(out);
      return;
    }
    // Wrist target = foregrip socket + palm-contact offset (weapon-local),
    // so the palm cups the foregrip instead of the barrel riding the wrist.
    const contact = weaponDials.foregripContactOffset;
    out.copy(this.spec.sockets.foregrip);
    out.x += contact.x;
    out.y += contact.y;
    out.z += contact.z;
    this.frame.localToWorld(out);
  }
}


function cloneWeaponMesh(source: Object3D | null): Object3D | null {
  if (!source) return null;
  const cloned = source.clone(true);
  cloned.position.set(0, 0, 0);
  cloned.quaternion.identity();
  cloned.scale.set(1, 1, 1);
  return cloned;
}

function retainWeaponDials(): void {
  weaponDialUsers += 1;
  if (weaponDialUsers === 1) window.__successor3dWeapon = weaponDials;
}

function releaseWeaponDials(): void {
  weaponDialUsers = Math.max(0, weaponDialUsers - 1);
  if (weaponDialUsers === 0 && window.__successor3dWeapon === weaponDials) {
    delete window.__successor3dWeapon;
  }
}

function applyMountDials(
  spec: SlugthrowerAttachSpec,
  dials: Successor3dWeaponDials,
  outPos: Vector3,
  outQuat: Quaternion,
): void {
  outPos.copy(spec.mountPos);
  outPos.x += finiteDial(dials.posOffset.x, 0);
  outPos.y += finiteDial(dials.posOffset.y, 0);
  outPos.z += finiteDial(dials.posOffset.z, 0);
  mountRotEulerScratch.set(
    finiteDial(dials.rotOffsetDeg.x, 0) * DEG_TO_RAD,
    finiteDial(dials.rotOffsetDeg.y, 0) * DEG_TO_RAD,
    finiteDial(dials.rotOffsetDeg.z, 0) * DEG_TO_RAD,
    "XYZ",
  );
  mountOffsetQuatScratch.setFromEuler(mountRotEulerScratch);
  outQuat.copy(spec.mountQuat).premultiply(mountOffsetQuatScratch);
}

function finiteDial(value: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function wrapAngle(angle: number): number {
  let wrapped = (angle + Math.PI) % (Math.PI * 2);
  if (wrapped < 0) wrapped += Math.PI * 2;
  return wrapped - Math.PI;
}
