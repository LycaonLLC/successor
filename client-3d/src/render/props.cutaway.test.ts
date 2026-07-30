import { describe, expect, it } from "vitest";
import { Mesh, MeshBasicMaterial, Object3D } from "three";
import {
  CUTAWAY_DWELL_SNAPSHOTS,
  CUTAWAY_INNER_INSET_MILLI,
  CUTAWAY_OUTER_EXPAND_MILLI,
  advanceCutawayFade,
  applyRevealFade,
  classifyEnterablePart,
  createCutawayState,
  cutawayPhase,
  sampleCutaway,
  type CutawayRegionMilli,
  type CutawayState,
  type RevealFadeMesh,
} from "./props";
import { SUN_SHADOW_CASTER_LAYER } from "./environment/sunShadow";

// One 10x8-cell interior in prop-local milli coordinates.
const REGIONS: CutawayRegionMilli[] = [{ xMilli: 0, yMilli: 0, wMilli: 10000, hMilli: 8000 }];

const DEEP_INSIDE = { x: 5000, z: 4000 };
const FAR_OUTSIDE = { x: 20000, z: 4000 };

function enter(state = createCutawayState(), tick = 0): { state: CutawayState; tick: number } {
  for (let i = 0; i < CUTAWAY_DWELL_SNAPSHOTS; i += 1) {
    tick += 1;
    sampleCutaway(state, tick, REGIONS, DEEP_INSIDE.x, DEEP_INSIDE.z);
  }
  return { state, tick };
}

describe("cutaway state machine", () => {
  it("enters after two consecutive new-tick snapshots deep inside, exits after two far outside", () => {
    const state = createCutawayState();
    sampleCutaway(state, 1, REGIONS, DEEP_INSIDE.x, DEEP_INSIDE.z);
    expect(state.inside).toBe(false);
    expect(state.dwell).toBe(1);
    sampleCutaway(state, 2, REGIONS, DEEP_INSIDE.x, DEEP_INSIDE.z);
    expect(state.inside).toBe(true);
    expect(state.dwell).toBe(0);

    sampleCutaway(state, 3, REGIONS, FAR_OUTSIDE.x, FAR_OUTSIDE.z);
    expect(state.inside).toBe(true);
    sampleCutaway(state, 4, REGIONS, FAR_OUTSIDE.x, FAR_OUTSIDE.z);
    expect(state.inside).toBe(false);
  });

  it("never accumulates dwell on repeated samples of the SAME snapshot tick", () => {
    const state = createCutawayState();
    // Render frames outnumber authority snapshots — re-sampling the same
    // tick (the per-frame render loop) must not advance the machine.
    for (let frame = 0; frame < 50; frame += 1) {
      sampleCutaway(state, 7, REGIONS, DEEP_INSIDE.x, DEEP_INSIDE.z);
    }
    expect(state.inside).toBe(false);
    expect(state.dwell).toBe(1);
  });

  it("resets dwell when a snapshot disagrees (no flip from non-consecutive agreement)", () => {
    const state = createCutawayState();
    sampleCutaway(state, 1, REGIONS, DEEP_INSIDE.x, DEEP_INSIDE.z);
    sampleCutaway(state, 2, REGIONS, FAR_OUTSIDE.x, FAR_OUTSIDE.z);
    sampleCutaway(state, 3, REGIONS, DEEP_INSIDE.x, DEEP_INSIDE.z);
    expect(state.inside).toBe(false);
    expect(state.dwell).toBe(1);
  });

  it("holds state under boundary jitter (hysteresis band between inner and outer)", () => {
    // Jitter ±100 milli around the region edge: inside the raw footprint on
    // odd ticks, outside on even ticks — but never >= 250 milli INSIDE
    // (inner threshold) nor >= 250 milli OUTSIDE (outer threshold).
    const exterior = createCutawayState();
    for (let tick = 1; tick <= 40; tick += 1) {
      const x = tick % 2 === 0 ? -100 : 100;
      sampleCutaway(exterior, tick, REGIONS, x, 4000);
      expect(exterior.inside).toBe(false);
    }

    const { state: interior, tick } = enter();
    for (let step = 1; step <= 40; step += 1) {
      const x = step % 2 === 0 ? -100 : 100;
      sampleCutaway(interior, tick + step, REGIONS, x, 4000);
      expect(interior.inside).toBe(true);
    }
  });

  it("uses the inner inset for entering and the outer expansion for exiting", () => {
    // Just inside the raw edge but shy of the inner threshold: no enter.
    const state = createCutawayState();
    sampleCutaway(state, 1, REGIONS, CUTAWAY_INNER_INSET_MILLI - 1, 4000);
    sampleCutaway(state, 2, REGIONS, CUTAWAY_INNER_INSET_MILLI - 1, 4000);
    expect(state.inside).toBe(false);
    // Past the inner threshold: enters.
    sampleCutaway(state, 3, REGIONS, CUTAWAY_INNER_INSET_MILLI + 1, 4000);
    sampleCutaway(state, 4, REGIONS, CUTAWAY_INNER_INSET_MILLI + 1, 4000);
    expect(state.inside).toBe(true);
    // Outside the raw edge but within the outer expansion: stays interior.
    sampleCutaway(state, 5, REGIONS, -(CUTAWAY_OUTER_EXPAND_MILLI - 1), 4000);
    sampleCutaway(state, 6, REGIONS, -(CUTAWAY_OUTER_EXPAND_MILLI - 1), 4000);
    expect(state.inside).toBe(true);
    // Past the outer expansion: exits.
    sampleCutaway(state, 7, REGIONS, -(CUTAWAY_OUTER_EXPAND_MILLI + 1), 4000);
    sampleCutaway(state, 8, REGIONS, -(CUTAWAY_OUTER_EXPAND_MILLI + 1), 4000);
    expect(state.inside).toBe(false);
  });

  it("keeps two independent buildings independent", () => {
    // Buildings at cells (10, 20) and (40, 40); player world point (15, 24)
    // is deep inside A only. Each instance samples its OWN local coords.
    const buildingA = createCutawayState();
    const buildingB = createCutawayState();
    const world = { x: 15, z: 24 };
    for (let tick = 1; tick <= 2; tick += 1) {
      sampleCutaway(buildingA, tick, REGIONS, (world.x - 10) * 1000, (world.z - 20) * 1000);
      sampleCutaway(buildingB, tick, REGIONS, (world.x - 40) * 1000, (world.z - 40) * 1000);
    }
    expect(buildingA.inside).toBe(true);
    expect(buildingB.inside).toBe(false);
  });

  it("exposes exterior -> entering -> interior -> exiting -> exterior phases", () => {
    const state = createCutawayState();
    expect(cutawayPhase(state)).toBe("exterior");
    enter(state);
    expect(cutawayPhase(state)).toBe("entering");
    advanceCutawayFade(state, 0.1, 0.25, false);
    expect(cutawayPhase(state)).toBe("entering");
    // Per-frame dt is clamped to 0.1s — advance frame by frame to the end.
    for (let frame = 0; frame < 10; frame += 1) advanceCutawayFade(state, 0.1, 0.25, false);
    expect(cutawayPhase(state)).toBe("interior");
    sampleCutaway(state, 100, REGIONS, FAR_OUTSIDE.x, FAR_OUTSIDE.z);
    sampleCutaway(state, 101, REGIONS, FAR_OUTSIDE.x, FAR_OUTSIDE.z);
    expect(cutawayPhase(state)).toBe("exiting");
    for (let frame = 0; frame < 10; frame += 1) advanceCutawayFade(state, 0.1, 0.25, false);
    expect(cutawayPhase(state)).toBe("exterior");
  });
});

describe("cutaway fade — reduced motion", () => {
  it("snaps the tween AFTER the same state decision (dwell still required)", () => {
    const state = createCutawayState();
    sampleCutaway(state, 1, REGIONS, DEEP_INSIDE.x, DEEP_INSIDE.z);
    // One agreeing snapshot: decision has NOT flipped yet — reduced motion
    // must not jump ahead of the state machine.
    expect(advanceCutawayFade(state, 0.016, 0.25, true)).toBe(0);
    sampleCutaway(state, 2, REGIONS, DEEP_INSIDE.x, DEEP_INSIDE.z);
    expect(advanceCutawayFade(state, 0.016, 0.25, true)).toBe(1);
    expect(state.t).toBe(1);
    expect(cutawayPhase(state)).toBe("interior");
  });

  it("tweens gradually without reduced motion", () => {
    const { state } = enter();
    advanceCutawayFade(state, 0.05, 0.25, false);
    expect(state.t).toBeCloseTo(0.2, 10);
    expect(cutawayPhase(state)).toBe("entering");
  });
});

describe("reveal fade material endpoints", () => {
  function opaqueRec(): { rec: RevealFadeMesh; material: MeshBasicMaterial } {
    const material = new MeshBasicMaterial();
    material.opacity = 1;
    material.transparent = false;
    material.depthWrite = true;
    const mesh = new Mesh(undefined, material);
    mesh.layers.enable(SUN_SHADOW_CASTER_LAYER);
    return {
      rec: { mesh, materials: [{ material, opacity: 1, transparent: false, depthWrite: true }] },
      material,
    };
  }

  it("restores opaque depth-writing shadow-casting state at the visible endpoint", () => {
    const { rec, material } = opaqueRec();
    applyRevealFade(rec, 0.5);
    applyRevealFade(rec, 0);
    expect(rec.mesh.visible).toBe(true);
    expect(material.opacity).toBe(1);
    expect(material.transparent).toBe(false);
    expect(material.depthWrite).toBe(true);
    expect((rec.mesh.layers.mask & (1 << SUN_SHADOW_CASTER_LAYER)) !== 0).toBe(true);
  });

  it("is invisible and shadow-free at the hidden endpoint", () => {
    const { rec } = opaqueRec();
    applyRevealFade(rec, 1);
    expect(rec.mesh.visible).toBe(false);
    expect((rec.mesh.layers.mask & (1 << SUN_SHADOW_CASTER_LAYER)) !== 0).toBe(false);
  });

  it("is transparent depth-write-off ONLY during the transition", () => {
    const { rec, material } = opaqueRec();
    applyRevealFade(rec, 0.5);
    expect(rec.mesh.visible).toBe(true);
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.opacity).toBe(0.5);
    expect((rec.mesh.layers.mask & (1 << SUN_SHADOW_CASTER_LAYER)) !== 0).toBe(false);
  });

  it("preserves an authored-transparent source material's endpoint values", () => {
    const material = new MeshBasicMaterial();
    material.opacity = 0.6;
    material.transparent = true;
    material.depthWrite = false;
    const mesh = new Mesh(undefined, material);
    const rec: RevealFadeMesh = {
      mesh,
      materials: [{ material, opacity: 0.6, transparent: true, depthWrite: false }],
    };
    applyRevealFade(rec, 0.5);
    expect(material.opacity).toBeCloseTo(0.3, 10);
    applyRevealFade(rec, 0);
    expect(material.opacity).toBe(0.6);
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
  });
});

describe("enterable part classification — floor/door invariant", () => {
  function meshUnder(nodeName: string): Mesh {
    const node = new Object3D();
    node.name = nodeName;
    const mesh = new Mesh();
    mesh.name = `${nodeName}_mesh`;
    node.add(mesh);
    return mesh;
  }

  it("classifies door_slide as door even when a mapping lists it as a reveal prefix", () => {
    const mesh = meshUnder("door_slide");
    expect(classifyEnterablePart(mesh, "body", ["roof__", "door_slide"])).toBe("door");
    expect(classifyEnterablePart(mesh, "door", ["roof__"])).toBe("door");
  });

  it("classifies floor-named meshes as floor even when a mapping lists them", () => {
    expect(classifyEnterablePart(meshUnder("interior_floor"), "body", ["interior_floor"])).toBe("floor");
    expect(classifyEnterablePart(meshUnder("Floor_main"), "body", ["Floor_"])).toBe("floor");
  });

  it("keeps roof and camera-facing wall groups in the reveal set", () => {
    const prefixes = ["roof__", "wall_front__", "wall_right__"];
    expect(classifyEnterablePart(meshUnder("roof__a"), "body", prefixes)).toBe("reveal");
    expect(classifyEnterablePart(meshUnder("wall_front__a"), "body", prefixes)).toBe("reveal");
    expect(classifyEnterablePart(meshUnder("wall_back__a"), "body", prefixes)).toBe("keep");
    expect(classifyEnterablePart(meshUnder("wall_back__a"), "body", null)).toBe("keep");
  });
});
