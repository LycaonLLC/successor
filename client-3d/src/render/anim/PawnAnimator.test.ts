import { describe, expect, it } from "vitest";
import { AnimationClip, Bone, Group, Quaternion, Vector3, VectorKeyframeTrack } from "three";
import type { PawnPack, PawnClipMeta } from "../../assets/pawnRigTypes";
import { MaskedClipCache } from "./maskedClips";
import { PawnAnimator, type ActiveClipsByLayer } from "./PawnAnimator";

const BONE_NAMES = ["root", "spine", "hand", "leg"] as const;


function makePack(root: Group): PawnPack {
  const clips = new Map<string, AnimationClip>([
    ["idle", new AnimationClip("idle", 1, BONE_NAMES.map((name) => (
      new VectorKeyframeTrack(`${name}.position`, [0, 1], [0, 0, 0, 0.01, 0, 0])
    )))],
    ["swing_h1", new AnimationClip("swing_h1", 1, BONE_NAMES.map((name) => (
      new VectorKeyframeTrack(`${name}.position`, [0, 1], [0, 0, 0, 0.01, 0, 0])
    )))],
  ]);
  return {
    bodies: { male: root, female: root },
    slugthrowerScene: new Group(),
    vibroswordScene: new Group(),
    weapons: new Map(),
    clips,
    clipMeta: new Map<string, PawnClipMeta>([
      ["idle", {
        name: "idle",
        layer: "base",
        mask: null,
        loop: true,
        durationS: 1,
        moveSpeedMps: 1,
        clampWhenFinished: false,
        events: {},
      }],
      ["swing_h1", {
        name: "swing_h1",
        layer: "montage",
        mask: "upper",
        loop: false,
        durationS: 1,
        moveSpeedMps: 1,
        clampWhenFinished: false,
        events: {},
      }],
    ]),
    masks: new Map<string, ReadonlySet<string>>([
      ["upper", new Set(["spine", "hand"])],
      ["full", new Set(BONE_NAMES)],
    ]),
    boneNames: new Set(BONE_NAMES),
    torsoYaw: { weights: [], maxRad: 0 },
    slugthrower: {
      mountPos: new Vector3(),
      mountQuat: new Quaternion(),
      sockets: { grip: new Vector3(), foregrip: new Vector3(), muzzle: new Vector3(), stock: new Vector3() },
      nodes: { frame: "", mag: "" },
    },
    vibrosword: {
      mountPos: new Vector3(),
      mountQuat: new Quaternion(),
      sockets: { guardPlane: new Vector3(), wrapTop: new Vector3(), wrapMid: new Vector3(), wrapBottom: new Vector3(), pommel: new Vector3() },
      nodes: { frame: "" },
    },
    equipment: { basePath: "", items: [], scenes: new Map() },
    scale: 1,
  };
}

function makeAnimator(): PawnAnimator {
  const group = new Group();
  const root = new Bone();
  root.name = "root";
  for (const name of ["spine", "hand", "leg"] as const) {
    const bone = new Bone();
    bone.name = name;
    root.add(bone);
  }
  group.add(root);
  return new PawnAnimator(group, makePack(group), new MaskedClipCache());
}

describe("PawnAnimator melee montage masks", () => {
  it("lets stationary swings own the full skeleton, then preserves time when movement re-enables the base layer", () => {
    const animator = makeAnimator();
    const layers: ActiveClipsByLayer = { base: null, upper: null, hand: null, arm: null, montage: null };

    animator.setBase("idle", 1);
    animator.playMontage("swing_h1", { maskMode: "full" });
    expect(animator.activeClipsByLayer(layers)).toMatchObject({
      base: null,
      montage: "swing_h1",
      montageMaskMode: "full",
    });

    animator.update(0.2);
    const beforeSwitch = animator.montageTime();
    animator.setMontageMaskMode("clip");

    const after = animator.activeClipsByLayer(layers);
    expect(after.base).toBe("idle");
    expect(after.montage).toBe("swing_h1");
    expect(after.montageMaskMode).toBe("clip");
    expect(animator.montageTime()).toBeCloseTo(beforeSwitch);

    animator.update(0.1);
    expect(animator.montageTime()).toBeGreaterThan(beforeSwitch);
  });
});
