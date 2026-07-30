import { describe, expect, it } from "vitest";
import {
  AnimationClip,
  Bone,
  Group,
  Quaternion,
  Scene,
  Vector3,
  VectorKeyframeTrack,
} from "three";
import type {
  PlayState,
  ServerAuthorityActorState,
  ServerAuthorityCombatEventState,
  SliceSnapshot,
} from "@successor/client/src/slice-core/gameState";
import type {
  ClipLayer,
  PawnClipMeta,
  PawnPack,
  SlugthrowerAttachSpec,
  VibroswordAttachSpec,
} from "../assets/pawnPack";

// pawns.ts creates its matcap and shadow canvases at module scope. A
// null-context canvas is sufficient for this renderer-state regression test.
(globalThis as { document?: unknown }).document ??= {
  createElement: () => ({
    width: 0,
    height: 0,
    style: {},
    getContext: () => ({
      createRadialGradient: () => ({ addColorStop: () => undefined }),
      fillRect: () => undefined,
      fillStyle: "",
    }),
  }),
};

const { createPlayState } = await import("@successor/client/src/slice-core/gameState");
const {
  expireWeaponFireAnimations,
  triggerWeaponFireAnimation,
} = await import("@successor/client/src/slice-core/weaponPresentationSystem");
const { PawnRenderer, weaponLaneForActor } = await import("./pawns");

const actorId = "player";
const areaId = "test-area";
const allBoneNames = ["root", "spine_03", "hand_r"] as const;

function makeBody(): Group {
  const group = new Group();
  const root = new Bone();
  root.name = "root";
  const spine = new Bone();
  spine.name = "spine_03";
  const hand = new Bone();
  hand.name = "hand_r";
  root.add(spine);
  spine.add(hand);
  group.add(root);
  return group;
}

function clip(name: string, durationS: number): AnimationClip {
  return new AnimationClip(name, durationS, [
    new VectorKeyframeTrack("root.position", [0, durationS], [0, 0, 0, 0.001, 0, 0]),
  ]);
}

function makePack(): PawnPack {
  const definitions: ReadonlyArray<readonly [string, number, ClipLayer, string | null, boolean]> = [
    ["idle", 1, "base", null, true],
    ["walk_f", 1, "base", null, true],
    ["run_f", 1, "base", null, true],
    ["walk_b", 1, "base", null, true],
    ["kneel_loop", 1, "base", null, true],
    ["rifle_idle", 1, "base", null, true],
    ["rifle_walk_f", 1, "base", null, true],
    ["rifle_run_f", 1, "base", null, true],
    ["melee_idle", 1, "base", null, true],
    ["melee_walk_f", 1, "base", null, true],
    ["melee_run_f", 1, "base", null, true],
    ["melee_ready", 1, "upper", "upper", true],
    ["melee_grip", 1, "hand", "hand", true],
    ["melee_draw", 0.8333, "montage", "upper", false],
    ["melee_sheath", 0.8333, "montage", "upper", false],
    ["swing_h1", 1.3, "montage", "upper", false],
    ["swing_h2", 1.3, "montage", "upper", false],
    ["swing_h3", 1.3, "montage", "upper", false],
  ];
  const clips = new Map<string, AnimationClip>();
  const clipMeta = new Map<string, PawnClipMeta>();
  for (const [name, durationS, layer, mask, loop] of definitions) {
    clips.set(name, clip(name, durationS));
    clipMeta.set(name, {
      name,
      layer,
      mask,
      loop,
      durationS,
      moveSpeedMps: 1,
      clampWhenFinished: false,
      events: {},
    });
  }

  const mountPos = new Vector3();
  const mountQuat = new Quaternion();
  const catalogMeleeSpec: SlugthrowerAttachSpec = {
    mountPos,
    mountQuat,
    sockets: {
      grip: new Vector3(),
      foregrip: new Vector3(),
      muzzle: new Vector3(),
      stock: new Vector3(),
    },
    nodes: { frame: "whole-scene" },
  };
  const vibrosword: VibroswordAttachSpec = {
    mountPos: mountPos.clone(),
    mountQuat: mountQuat.clone(),
    sockets: {
      guardPlane: new Vector3(),
      wrapTop: new Vector3(),
      wrapMid: new Vector3(),
      wrapBottom: new Vector3(),
      pommel: new Vector3(),
    },
    nodes: { frame: "whole-scene" },
  };
  const male = makeBody();
  return {
    bodies: { male, female: makeBody() },
    specialBodies: new Map(),
    slugthrowerScene: new Group(),
    vibroswordScene: new Group(),
    clips,
    clipMeta,
    masks: new Map([
      ["upper", new Set(["spine_03", "hand_r"])],
      ["hand", new Set(["hand_r"])],
      ["full", new Set(allBoneNames)],
    ]),
    boneNames: new Set(allBoneNames),
    torsoYaw: { weights: [], maxRad: 0 },
    slugthrower: catalogMeleeSpec,
    vibrosword,
    weapons: new Map([
      ["scrapline_machete", {
        scene: new Group(),
        spec: catalogMeleeSpec,
        scale: 1,
        silhouetteClass: "melee",
        animations: [],
      }],
    ]),
    equipment: { basePath: "", items: [], scenes: new Map() },
    scale: 1,
  };
}

function makeSlice(): SliceSnapshot {
  return {
    schema: "successor.slice.v1",
    tick: 0,
    tickRateHz: 20,
    combatModel: "roll",
    grid: { cellSizePx: 1 },
    zone: { id: 1, name: "Test", width: 16, height: 16, level: 1 },
    areas: [{ id: areaId, name: "Test", kind: "overworld", width: 16, height: 16, level: 1 }],
    stateHash: "test",
    camera: { followActor: actorId, zoom: 1 },
    actors: [{
      id: actorId,
      entity: "1:1",
      areaId,
      label: "Tester",
      role: "player",
      sprite: "pawn-male",
      poseSet: "pawn",
      direction: "right",
      cell: { x: 4, y: 4 },
      route: [],
    }],
    props: [],
    blockedCells: [],
    transitions: [],
    inventory: [],
    reservations: [],
    events: [],
  };
}

function authorityActor(weapon: ServerAuthorityActorState["weapon"]): ServerAuthorityActorState {
  const vitals = { health: 100, action: 100, spirit: 100 };
  return {
    id: actorId,
    label: "Tester",
    role: "player",
    sprite: "pawn-male",
    areaId,
    x: 4,
    y: 4,
    direction: "right",
    lifeState: "alive",
    lifecycleSeq: 1,
    vitals,
    maxVitals: { ...vitals },
    bleed: {
      active: false,
      stackCount: 0,
      severity: 0,
      remainingMs: 0,
      ratesPerSecond: { health: 0, action: 0, spirit: 0 },
    },
    weapon,
    statuses: [],
    inCombat: false,
  };
}

function makeState(actor: ServerAuthorityActorState): PlayState {
  const state = createPlayState(makeSlice(), actorId);
  state.serverAuthority.playerActorId = actorId;
  state.serverAuthority.actors[actorId] = actor;
  return state;
}

function attackEvent(id: number, weaponId: "scrapline-machete" | "unarmed"): ServerAuthorityCombatEventState {
  return {
    id,
    tick: id,
    shooterActorId: actorId,
    targetActorId: "target",
    damage: 4,
    zone: "torso",
    previousLifeState: "alive",
    lifeState: "alive",
    targetLifecycleSeq: 1,
    bleedStackCount: 0,
    weaponId,
    ammoTypeId: "melee",
    kind: "melee_roll",
    receivedAtMs: 1_000,
  };
}

function update(renderer: InstanceType<typeof PawnRenderer>, state: PlayState, dtSeconds: number): void {
  renderer.update(makeSlice(), state, dtSeconds, state.worldTimeMs, 4.5, 4.5);
}

function montage(renderer: InstanceType<typeof PawnRenderer>): string | null | undefined {
  return renderer.getActiveClipsByLayer(actorId, {
    base: null,
    upper: null,
    hand: null,
    arm: null,
    montage: null,
  })?.montage;
}

describe("PawnRenderer first melee strike presentation", () => {
  it("retains a Scrapline strike behind the authored draw after its fire token expires", () => {
    const actor = authorityActor({
      weaponId: "scrapline-machete",
      weaponItemId: 3105,
      ammoType: "melee",
      loadedRounds: 1,
      magazineSize: 1,
      reloadUntilTick: 0,
      reloadRemainingTicks: 0,
      reloadTotalTicks: 0,
    });
    const state = makeState(actor);
    const renderer = new PawnRenderer(new Scene(), makePack());
    try {
      update(renderer, state, 0.016);
      expect(weaponLaneForActor(actor)).toBe("melee");

      actor.inCombat = true;
      state.worldTimeMs = 1_000;
      triggerWeaponFireAnimation(state, actorId, "scrapline-machete");
      state.serverAuthority.eventLog.push(attackEvent(1, "scrapline-machete"));
      update(renderer, state, 0.016);
      expect(montage(renderer)).toBe("melee_draw");

      state.worldTimeMs = 1_420;
      expireWeaponFireAnimations(state);
      expect(state.weaponFireAnimations[actorId]).toBeUndefined();

      for (let frame = 0; frame < 9; frame += 1) update(renderer, state, 0.1);
      update(renderer, state, 0.016);

      expect(montage(renderer)).toBe("swing_h1");
    } finally {
      renderer.dispose();
    }
  });

  it("plays the first unarmed strike from the model-free lane without creating a weapon", () => {
    const actor = authorityActor(null);
    const state = makeState(actor);
    const scene = new Scene();
    const renderer = new PawnRenderer(scene, makePack());
    try {
      update(renderer, state, 0.016);
      expect(weaponLaneForActor(actor)).toBe("none");

      actor.inCombat = true;
      state.worldTimeMs = 1_000;
      triggerWeaponFireAnimation(state, actorId, "unarmed");
      state.serverAuthority.eventLog.push(attackEvent(1, "unarmed"));
      update(renderer, state, 0.016);

      expect(montage(renderer)).toBe("swing_h1");
      const objectNames: string[] = [];
      scene.traverse((object) => objectNames.push(object.name));
      expect(objectNames).not.toContain("vibrosword");
      expect(objectNames.some((name) => name.startsWith("melee:"))).toBe(false);
    } finally {
      renderer.dispose();
    }
  });
});
