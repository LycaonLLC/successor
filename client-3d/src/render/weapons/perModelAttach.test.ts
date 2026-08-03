// perModelAttach.test.ts — the observable contract introduced when weapons
// stopped sharing one global carry transform.
//
// The defect these guard against: every attach json shipped an identical
// placeholder stow_socket that nothing parsed, and both rigs forced one config
// transform onto dissimilar geometry. That laid the +Y-blade melee family
// horizontally through the pawn's neck while the +Z-blade Vibrosword carried
// correctly, and it floated the plasma hilt 15.25 cm out of the hand.
import { Bone, BoxGeometry, Euler, Group, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from "three";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { PawnPack, SlugthrowerAttachSpec } from "../../assets/pawnRigTypes";
import { SUCCESSOR_3D_CONFIG } from "../../config";
import { SwordRig } from "./swordRig";
import { SlugthrowerRig } from "./slugthrowerRig";

beforeAll(() => {
  vi.stubGlobal("window", {});
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const DEG_TO_RAD = Math.PI / 180;

function meleeScene(name: string): Group {
  const scene = new Group();
  const frame = new Mesh(new BoxGeometry(0.05, 0.62, 0.04), new MeshBasicMaterial());
  frame.name = name;
  scene.add(frame);
  return scene;
}

function meleeSpec(overrides: Partial<SlugthrowerAttachSpec> = {}): SlugthrowerAttachSpec {
  return {
    mountPos: new Vector3(-0.01, 0.072, 0.016),
    mountQuat: new Quaternion(),
    sockets: {
      grip: new Vector3(),
      foregrip: new Vector3(0, 0.06, 0),
      muzzle: new Vector3(0, 0.5435, 0),
      stock: new Vector3(0, -0.0765, 0),
    },
    nodes: { frame: "scrapline_machete" },
    silhouetteClass: "melee",
    ...overrides,
  };
}

/** spine + hand rooted in one tree so world matrices are meaningful. */
function rig(spec: SlugthrowerAttachSpec): { root: Group; hand: Bone; spine: Bone; sword: SwordRig } {
  const root = new Group();
  const spine = new Bone();
  spine.name = "spine_03";
  const hand = new Bone();
  hand.name = "hand_r";
  root.add(spine);
  root.add(hand);
  hand.position.set(0.25, 1.2, 0.1);
  root.updateMatrixWorld(true);
  const sword = new SwordRig({} as PawnPack, hand, spine, spec, meleeScene("scrapline_machete"), 1, "melee:test");
  return { root, hand, spine, sword };
}

/** Blade direction in spine-local space after the stow has fully settled. */
function stowedBladeDirection(spec: SlugthrowerAttachSpec): Vector3 {
  const { root, spine, sword } = rig(spec);
  sword.setStowed(true, { snap: true });
  sword.update(1);
  root.updateMatrixWorld(true);
  const frame = sword.frameRoot();
  const tipWorld = frame.localToWorld(new Vector3(0, 1, 0));
  const originWorld = frame.localToWorld(new Vector3());
  return spine.worldToLocal(tipWorld).sub(spine.worldToLocal(originWorld)).normalize();
}

describe("per-model stow socket", () => {
  it("carries a model by its OWN authored socket, not the melee class default", () => {
    // Authored socket rotates the +Y blade axis onto spine-local -Y (blade
    // down the back). The class default is tuned for a +Z blade frame and
    // would leave this model's blade pointing somewhere else entirely.
    const authored = meleeSpec({
      stow: { pos: new Vector3(-0.047, 0.296, -0.137), rotDeg: new Vector3(-179.47, -2.96, -9.01), arcLift: 0.14 },
    });
    const dir = stowedBladeDirection(authored);
    expect(dir.y).toBeLessThan(-0.9); // blade rakes DOWN the back

    const fallback = stowedBladeDirection(meleeSpec());
    // The legacy default puts this same geometry somewhere else — proving the
    // authored socket is what is being consumed, not the shared config.
    expect(Math.abs(fallback.y - dir.y)).toBeGreaterThan(0.5);
  });

  it("falls back to the legacy sword carry when a model authors no socket", () => {
    const { root, spine, sword } = rig(meleeSpec());
    sword.setStowed(true, { snap: true });
    sword.update(1);
    root.updateMatrixWorld(true);

    const legacy = SUCCESSOR_3D_CONFIG.pawnPack.swordStow;
    const expected = new Quaternion().setFromEuler(new Euler(
      legacy.rotOffsetDeg.x * DEG_TO_RAD,
      legacy.rotOffsetDeg.y * DEG_TO_RAD,
      legacy.rotOffsetDeg.z * DEG_TO_RAD,
      "XYZ",
    ));
    const actual = spine.getWorldQuaternion(new Quaternion()).invert()
      .multiply(sword.frameRoot().getWorldQuaternion(new Quaternion()));
    expect(actual.angleTo(expected)).toBeLessThan(1e-3);

    const posLocal = spine.worldToLocal(sword.frameRoot().getWorldPosition(new Vector3()));
    expect(posLocal.x).toBeCloseTo(legacy.posOffset.x, 4);
    expect(posLocal.y).toBeCloseTo(legacy.posOffset.y, 4);
    expect(posLocal.z).toBeCloseTo(legacy.posOffset.z, 4);
  });

  it("exposes the palm point so hand-welded FX never ride the model origin", () => {
    // The plasma hilt floated because it was parented at the weaponRoot
    // origin, which on a blade-origin model is out in mid-air.
    const spec = meleeSpec({
      sockets: { ...meleeSpec().sockets, grip: new Vector3(0, 0, -0.1525) },
    });
    const { sword } = rig(spec);
    expect(sword.gripLocal(new Vector3()).toArray()).toEqual([0, 0, -0.1525]);
  });
});

describe("gun rig per-model authoring", () => {
  function gunSpec(overrides: Partial<SlugthrowerAttachSpec> = {}): SlugthrowerAttachSpec {
    return {
      mountPos: new Vector3(),
      mountQuat: new Quaternion(),
      sockets: {
        grip: new Vector3(0, -0.091, -0.218),
        foregrip: new Vector3(0, 0, 0.07),
        muzzle: new Vector3(0, 0, 0.142),
        stock: new Vector3(0, 0, -0.5885),
      },
      nodes: { frame: "Module_receiver" },
      ...overrides,
    };
  }

  function gunScene(): Group {
    const scene = new Group();
    const frame = new Mesh(new BoxGeometry(0.1, 0.1, 0.35), new MeshBasicMaterial());
    frame.name = "Module_receiver";
    scene.add(frame);
    return scene;
  }

  function build(spec: SlugthrowerAttachSpec): { spine: Bone; gun: SlugthrowerRig; root: Group } {
    const root = new Group();
    const spine = new Bone();
    const hand = new Bone();
    root.add(spine, hand);
    hand.position.set(0.2, 1.2, 0);
    root.updateMatrixWorld(true);
    const gun = new SlugthrowerRig({} as PawnPack, hand, null, null, null, spine, spec, gunScene(), 1);
    return { spine, gun, root };
  }

  it("stows a gun on its own authored socket", () => {
    const pos = new Vector3(0.21, -0.05, -0.2);
    const { spine, gun, root } = build(gunSpec({
      stow: { pos, rotDeg: new Vector3(70, -30, 10), arcLift: 0.2 },
    }));
    gun.setStowed(true, { snap: true });
    gun.update(1, null, "off");
    root.updateMatrixWorld(true);
    const local = spine.worldToLocal(gun.weaponObject().getWorldPosition(new Vector3()));
    expect(local.x).toBeCloseTo(pos.x, 4);
    expect(local.y).toBeCloseTo(pos.y, 4);
    expect(local.z).toBeCloseTo(pos.z, 4);
  });

  it("resets live stow dials so a new model never inherits the previous carry", () => {
    const dials = window.__successor3dWeapon;
    expect(dials).toBeDefined();
    dials!.stowPosDelta.x = 0.4;
    dials!.stowRotDeltaDeg.z = 55;

    // Constructing a rig = switching models.
    build(gunSpec());
    expect(dials!.stowPosDelta.x).toBe(0);
    expect(dials!.stowRotDeltaDeg.z).toBe(0);
  });

  it("applies live stow dials as a DELTA on top of the authored base", () => {
    const pos = new Vector3(0.16, 0, -0.14);
    const { spine, gun, root } = build(gunSpec({
      stow: { pos, rotDeg: new Vector3(85, -45, 0), arcLift: 0.14 },
    }));
    window.__successor3dWeapon!.stowPosDelta.y = 0.1;
    gun.setStowed(true, { snap: true });
    gun.update(1, null, "off");
    root.updateMatrixWorld(true);
    const local = spine.worldToLocal(gun.weaponObject().getWorldPosition(new Vector3()));
    expect(local.y).toBeCloseTo(pos.y + 0.1, 4);
    window.__successor3dWeapon!.resetStow();
  });

  it("aims the support wrist at an authored contact instead of the global offset", () => {
    const contact = new Vector3(0, -0.0272, 0.065);
    const upper = new Bone();
    const lower = new Bone();
    const handL = new Bone();
    upper.add(lower);
    lower.add(handL);
    lower.position.set(0, -0.3, 0);
    handL.position.set(0, -0.3, 0);
    const root = new Group();
    const spine = new Bone();
    const handR = new Bone();
    root.add(spine, handR, upper);
    handR.position.set(0.2, 1.2, 0);
    upper.position.set(0.2, 1.4, 0);
    root.updateMatrixWorld(true);

    const spec = gunSpec({ sockets: { ...gunSpec().sockets, foregripContact: contact } });
    const gun = new SlugthrowerRig({} as PawnPack, handR, upper, lower, handL, spine, spec, gunScene(), 1);
    gun.update(1, null, "on");
    root.updateMatrixWorld(true);
    // The authored point is used verbatim: no global contact offset added.
    const target = gun.weaponObject().getObjectByName("Module_receiver")!
      .localToWorld(contact.clone());
    const solved = handL.getWorldPosition(new Vector3());
    const globalOffset = SUCCESSOR_3D_CONFIG.pawnPack.foregripContactOffset;
    const legacyTarget = gun.weaponObject().getObjectByName("Module_receiver")!
      .localToWorld(spec.sockets.foregrip.clone().add(new Vector3(globalOffset.x, globalOffset.y, globalOffset.z)));
    expect(solved.distanceTo(target)).toBeLessThan(solved.distanceTo(legacyTarget));
  });

  it("uses the model's authored resting yaw over the config default", () => {
    const custom = build(gunSpec({ restingYawRad: 0.3 }));
    const fallback = build(gunSpec());
    for (const b of [custom, fallback]) {
      b.gun.update(1 / 30, null, "off");
      b.root.updateMatrixWorld(true);
    }
    const yawOf = (g: SlugthrowerRig): number => {
      const muzzle = g.getMuzzleWorld(new Vector3());
      const grip = g.getGripWorld(new Vector3());
      return Math.atan2(muzzle.x - grip.x, muzzle.z - grip.z);
    };
    expect(Math.abs(yawOf(custom.gun) - yawOf(fallback.gun))).toBeGreaterThan(0.1);
  });
});

// The defect: a support socket authored past the arm's own reach made the
// two-bone solver clamp to a+b, collapsing the elbow onto the shoulder->wrist
// line. The support arm became a rod laid along the weapon and its forearm
// crossed the receiver at walk and run on both bodies.
describe("support-arm hold posture", () => {
  const DEG = Math.PI / 180;
  // The pack skeleton's support arm: 0.325 + 0.259 = 0.584 m of reach.
  const UPPER_LEN = 0.325;
  const LOWER_LEN = 0.259;
  const GIRDLE_LEN = 0.168;
  const POSTURE = { minBendRad: 34 * DEG, shoulderAdvanceMaxM: 0.05, poleRad: 56 * DEG };

  interface Arm {
    root: Group;
    clavicle: Bone;
    upper: Bone;
    lower: Bone;
    handL: Bone;
    gun: SlugthrowerRig;
  }

  function gunSpec(contactZ: number, supportArm?: SlugthrowerAttachSpec["supportArm"]): SlugthrowerAttachSpec {
    return {
      mountPos: new Vector3(),
      mountQuat: new Quaternion(),
      sockets: {
        grip: new Vector3(0, -0.091, -0.218),
        foregrip: new Vector3(0, 0, contactZ),
        muzzle: new Vector3(0, 0, 0.142),
        stock: new Vector3(0, 0, -0.5885),
        foregripContact: new Vector3(0, -0.027, contactZ),
      },
      nodes: { frame: "Module_receiver" },
      supportArm,
    };
  }

  function build(spec: SlugthrowerAttachSpec): Arm {
    const root = new Group();
    const spine = new Bone();
    const handR = new Bone();
    const clavicle = new Bone();
    const upper = new Bone();
    const lower = new Bone();
    const handL = new Bone();
    clavicle.name = "clavicle_l";
    clavicle.add(upper);
    upper.add(lower);
    lower.add(handL);
    root.add(spine, handR, clavicle);
    clavicle.position.set(0.02, 1.4, 0);
    upper.position.set(GIRDLE_LEN, 0, 0);
    lower.position.set(0, -UPPER_LEN, 0);
    handL.position.set(0, -LOWER_LEN, 0);
    handR.position.set(0.2, 1.2, 0);
    root.updateMatrixWorld(true);
    const scene = new Group();
    const frame = new Mesh(new BoxGeometry(0.1, 0.1, 0.35), new MeshBasicMaterial());
    frame.name = "Module_receiver";
    scene.add(frame);
    const gun = new SlugthrowerRig({} as PawnPack, handR, upper, lower, handL, spine, spec, scene, 1);
    return { root, clavicle, upper, lower, handL, gun };
  }

  /** Perpendicular distance from the elbow to the shoulder->wrist line. */
  function elbowOffAxis(arm: Arm): number {
    const shoulder = arm.upper.getWorldPosition(new Vector3());
    const elbow = arm.lower.getWorldPosition(new Vector3());
    const wrist = arm.handL.getWorldPosition(new Vector3());
    const axis = wrist.clone().sub(shoulder);
    const length = axis.length();
    if (length < 1e-9) return 0;
    axis.multiplyScalar(1 / length);
    const toElbow = elbow.clone().sub(shoulder);
    return toElbow.addScaledVector(axis, -toElbow.dot(axis)).length();
  }

  /** A contact 0.65 m down the frame sits ~0.1 m past the arm's 0.584 m reach. */
  const OUT_OF_REACH = 0.65;
  const IN_REACH = 0.07;

  it("leaves the elbow collapsed on the shoulder-wrist line without a posture", () => {
    const arm = build(gunSpec(OUT_OF_REACH));
    arm.gun.update(1, null, "on");
    arm.root.updateMatrixWorld(true);
    expect(elbowOffAxis(arm)).toBeLessThan(0.005);
  });

  it("holds the authored elbow bend when the contact is past the arm", () => {
    const arm = build(gunSpec(OUT_OF_REACH, POSTURE));
    arm.gun.update(1, null, "on");
    arm.root.updateMatrixWorld(true);
    // chord for a 34 deg bend = sqrt(a^2+b^2-2ab cos(146 deg)) -> the elbow
    // stands a*b*sin(34)/chord = 84 mm off the axis.
    const chord = Math.sqrt(
      UPPER_LEN ** 2 + LOWER_LEN ** 2 - 2 * UPPER_LEN * LOWER_LEN * Math.cos(Math.PI - POSTURE.minBendRad),
    );
    const expected = (UPPER_LEN * LOWER_LEN * Math.sin(POSTURE.minBendRad)) / chord;
    expect(elbowOffAxis(arm)).toBeGreaterThan(expected * 0.9);
  });

  it("caps the girdle swing at the authored advance and never accumulates it", () => {
    const legacy = build(gunSpec(OUT_OF_REACH));
    const posed = build(gunSpec(OUT_OF_REACH, POSTURE));
    legacy.gun.update(1, null, "on");
    legacy.root.updateMatrixWorld(true);
    const rest = legacy.upper.getWorldPosition(new Vector3());

    posed.gun.update(1, null, "on");
    posed.root.updateMatrixWorld(true);
    const first = posed.upper.getWorldPosition(new Vector3());
    expect(first.distanceTo(rest)).toBeGreaterThan(0.04);
    expect(first.distanceTo(rest)).toBeLessThanOrEqual(POSTURE.shoulderAdvanceMaxM + 1e-4);

    // Post-mixer bones the clips do not animate must not compound: 60 more
    // frames may not walk the shoulder any further forward.
    for (let i = 0; i < 60; i += 1) posed.gun.update(1 / 60, null, "on");
    posed.root.updateMatrixWorld(true);
    expect(posed.upper.getWorldPosition(new Vector3()).distanceTo(first)).toBeLessThan(1e-6);
  });

  it("rolls the elbow to the pole without moving the support wrist", () => {
    const down = build(gunSpec(OUT_OF_REACH, { ...POSTURE, poleRad: 0 }));
    const flared = build(gunSpec(OUT_OF_REACH, POSTURE));
    for (const arm of [down, flared]) {
      arm.gun.update(1, null, "on");
      arm.root.updateMatrixWorld(true);
    }
    const downWrist = down.handL.getWorldPosition(new Vector3());
    const flaredWrist = flared.handL.getWorldPosition(new Vector3());
    expect(flaredWrist.distanceTo(downWrist)).toBeLessThan(1e-6);
    // ...while the elbow genuinely moved to the other pole angle.
    const downElbow = down.lower.getWorldPosition(new Vector3());
    const flaredElbow = flared.lower.getWorldPosition(new Vector3());
    expect(flaredElbow.distanceTo(downElbow)).toBeGreaterThan(0.05);
  });

  it("never swings the girdle for a contact the arm can already reach", () => {
    const legacy = build(gunSpec(IN_REACH));
    const posed = build(gunSpec(IN_REACH, POSTURE));
    for (const arm of [legacy, posed]) {
      arm.gun.update(1, null, "on");
      arm.root.updateMatrixWorld(true);
    }
    expect(posed.clavicle.quaternion.angleTo(legacy.clavicle.quaternion)).toBeLessThan(1e-9);
  });

  it("hands the shoulder girdle back when the arm stops being driven", () => {
    const arm = build(gunSpec(OUT_OF_REACH, POSTURE));
    const rest = arm.clavicle.quaternion.clone();
    arm.gun.update(1, null, "on");
    expect(arm.clavicle.quaternion.angleTo(rest)).toBeGreaterThan(0.05);

    // Stowing on the back stops driving the support arm: an un-relaxed swing
    // would leave the pawn permanently shrugged.
    arm.gun.setStowed(true, { snap: true });
    arm.gun.update(1, null, "on");
    expect(arm.clavicle.quaternion.angleTo(rest)).toBeLessThan(1e-9);

    arm.gun.setStowed(false, { snap: true });
    arm.gun.update(1, null, "on");
    expect(arm.clavicle.quaternion.angleTo(rest)).toBeGreaterThan(0.05);
    arm.gun.dispose();
    expect(arm.clavicle.quaternion.angleTo(rest)).toBeLessThan(1e-9);
  });
});
