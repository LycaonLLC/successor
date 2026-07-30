import type { PlayState } from "@successor/client/src/slice-core/gameState";
import { describe, expect, it } from "vitest";
import { Scene, Texture, Vector3, type CanvasTexture } from "three";
import { FX_CONFIG, type BoltStyleId } from "./config";
import { FxEventTap, creatureHitHeight } from "./events";
import { HitFx } from "./hits";
import { MuzzleFx } from "./muzzle";
import { ParticleLayers } from "./particles";
import { StatusFx } from "./status";
import { TracerFx, type TracerOutcomeKind } from "./tracers";

function makeFxHarness(): {
  state: PlayState;
  tap: FxEventTap;
  tracers: TracerFx;
  hits: HitFx;
  particles: ParticleLayers;
  dispose: () => void;
} {
  const scene = new Scene();
  const texture = new Texture() as CanvasTexture;
  const particles = new ParticleLayers(scene, texture);
  const muzzle = new MuzzleFx(particles, (light) => scene.add(light));
  const tracers = new TracerFx(scene, texture);
  const hits = new HitFx(scene, texture);
  const status = new StatusFx(scene, texture);
  const tap = new FxEventTap({ particles, muzzle, tracers, hits, status });
  const state = {
    activeAreaId: "open-desert-overworld",
    playerActorId: "player",
    worldTimeMs: 0,
    serverAuthority: {
      playerActorId: "player",
      actors: {},
      eventLog: [],
    },
  } as unknown as PlayState;
  return {
    state,
    tap,
    tracers,
    hits,
    particles,
    dispose: () => {
      status.dispose();
      hits.dispose();
      tracers.dispose();
      muzzle.dispose();
      particles.dispose();
      texture.dispose();
    },
  };
}

interface HarnessActor {
  x: number;
  y: number;
  areaId: string;
  lifeState: string;
  role: string;
  label: string;
}

function actorAt(x: number, y: number, label: string): HarnessActor {
  return { x, y, areaId: "open-desert-overworld", lifeState: "alive", role: "skirmisher", label };
}

interface RollEventInit {
  id: number;
  tick: number;
  shooterActorId: string;
  targetActorId: string;
  hit: boolean;
  damage: number;
}

function rollEvent(init: RollEventInit): Record<string, unknown> {
  return {
    id: init.id,
    kind: "ranged_roll",
    tick: init.tick,
    shooterActorId: init.shooterActorId,
    targetActorId: init.targetActorId,
    hit: init.hit,
    damage: init.damage,
    zone: "torso",
    previousLifeState: "alive",
    lifeState: "alive",
    hitPoint: null,
    originPoint: null,
  };
}

function pushEvents(state: PlayState, events: Record<string, unknown>[]): void {
  const log = state.serverAuthority.eventLog as unknown as Record<string, unknown>[];
  for (const ev of events) log.push(ev);
}

/** Advance tracers far enough for every in-flight bolt to land. */
function flyAll(harness: { tracers: TracerFx; state: PlayState }, seconds: number): void {
  const steps = Math.ceil(seconds / 0.02);
  for (let i = 0; i < steps; i += 1) harness.tracers.update(0.02, harness.state);
}

function additiveLiveCount(particles: ParticleLayers): number {
  let count = 0;
  for (let i = 0; i < particles.additive.life.length; i += 1) {
    if (particles.additive.life[i]! > 0) count += 1;
  }
  return count;
}

function styledArrivalCount(style: BoltStyleId, outcomeKind: TracerOutcomeKind): number {
  const harness = makeFxHarness();
  try {
    const origin = new Vector3(0, 0.2, 0);
    const dir = new Vector3(1, 0, 0);
    const hitPoint = new Vector3(0.1, 0.2, 0);
    expect(harness.tracers.spawn({ origin, dir, speed: 10, range: 4, key: 77, mag: 1, style })).toBe(true);
    expect(harness.tracers.setOutcome(77, outcomeKind, hitPoint, 1, 1, false, false, 1, "target")).toBe(true);
    harness.tracers.update(0.02, harness.state);
    return harness.hits.activeCount;
  } finally {
    harness.dispose();
  }
}

describe("creatureHitHeight", () => {
  it("derives hit heights from the current rigged creature model", () => {
    const sprite = "creature-pocketclod-adult";
    expect(creatureHitHeight(sprite, "head")!).toBeGreaterThan(creatureHitHeight(sprite, "torso")!);
    expect(creatureHitHeight(sprite, "torso")!).toBeLessThan(FX_CONFIG.chestHeight);
    expect(creatureHitHeight(sprite, "legs")!).toBeLessThan(creatureHitHeight(sprite, "torso")!);
  });

  it("falls unknown zones back to the torso splash point and rejects unknown sprites", () => {
    expect(creatureHitHeight("creature-pocketclod-adult", "tail")).toBe(creatureHitHeight("creature-pocketclod-adult", "torso"));
    expect(creatureHitHeight("unknown-creature", "torso")).toBeNull();
  });
});

describe("FxEventTap styled hit dispatch", () => {
  it("spawns a styled hit when an arriving tracer's style declares a hit archetype", () => {
    expect(styledArrivalCount("plasma", 1)).toBe(1);
  });

  it("keeps legacy-only styles and sleep outcomes from spawning styled hits", () => {
    expect(styledArrivalCount("ballistic", 1)).toBe(0);
    expect(styledArrivalCount("plasma", 0)).toBe(0);
  });
});

describe("roll-bolt impact honesty", () => {
  const SURFACE = FX_CONFIG.hit.impactSurfaceRadiusCells;

  it("terminates a landed roll bolt at the target's surface, not the centre axis", () => {
    const harness = makeFxHarness();
    try {
      const actors = harness.state.serverAuthority.actors as unknown as Record<string, HarnessActor>;
      actors["S"] = actorAt(0, 0, "Shooter");
      actors["T"] = actorAt(4, 0, "Target");
      pushEvents(harness.state, [rollEvent({ id: 1, tick: 5, shooterActorId: "S", targetActorId: "T", hit: true, damage: 4 })]);
      harness.tap.update(harness.state);
      flyAll(harness, 0.5);
      expect(harness.tap.arrivalCount).toBe(1);
      expect(harness.tap.lastArrivalKind).toBe(1); // blood
      const dist = Math.hypot(harness.tap.lastArrivalPoint.x - 4.5, harness.tap.lastArrivalPoint.z - 0.5);
      expect(dist).toBeCloseTo(SURFACE, 3);
      // the bolt died on the shooter-facing side of the pawn
      expect(harness.tap.lastArrivalPoint.x).toBeLessThan(4.5);
    } finally {
      harness.dispose();
    }
  });

  it("keeps the miss overshoot read: the bolt dies in the dirt PAST the target", () => {
    const harness = makeFxHarness();
    try {
      const actors = harness.state.serverAuthority.actors as unknown as Record<string, HarnessActor>;
      actors["S"] = actorAt(0, 0, "Shooter");
      actors["T"] = actorAt(4, 0, "Target");
      pushEvents(harness.state, [rollEvent({ id: 1, tick: 5, shooterActorId: "S", targetActorId: "T", hit: false, damage: 0 })]);
      harness.tap.update(harness.state);
      flyAll(harness, 0.5);
      expect(harness.tap.arrivalCount).toBe(1);
      const past = Math.hypot(harness.tap.lastArrivalPoint.x - 4.5, harness.tap.lastArrivalPoint.z - 0.5);
      expect(past).toBeGreaterThan(2.0); // ROLL_MISS_OVERSHOOT_CELLS
    } finally {
      harness.dispose();
    }
  });

  it("aims deferred burst pellets at their OWN target even after other events stamp the shared scratch", () => {
    const harness = makeFxHarness();
    try {
      const actors = harness.state.serverAuthority.actors as unknown as Record<string, HarnessActor>;
      actors["S"] = actorAt(0, 0, "Shooter");
      actors["A"] = actorAt(4, 0, "Far");
      actors["B"] = actorAt(0, 2, "Near");
      pushEvents(harness.state, [
        rollEvent({ id: 1, tick: 5, shooterActorId: "S", targetActorId: "A", hit: true, damage: 3 }),
        rollEvent({ id: 2, tick: 5, shooterActorId: "S", targetActorId: "A", hit: true, damage: 3 }),
        // different burst key (tick): processed same frame, would stomp the old shared scratch
        rollEvent({ id: 3, tick: 6, shooterActorId: "S", targetActorId: "B", hit: true, damage: 3 }),
      ]);
      harness.tap.update(harness.state); // id 1 + id 3 spawn now; id 2 pends (+115ms)
      flyAll(harness, 0.5);
      expect(harness.tap.arrivalCount).toBe(2);
      (harness.state as unknown as { worldTimeMs: number }).worldTimeMs = 200;
      harness.tap.update(harness.state); // drains pellet id 2
      flyAll(harness, 0.5);
      expect(harness.tap.arrivalCount).toBe(3);
      expect(harness.tap.lastArrivalTargetActorId).toBe("A");
      const dist = Math.hypot(harness.tap.lastArrivalPoint.x - 4.5, harness.tap.lastArrivalPoint.z - 0.5);
      expect(dist).toBeCloseTo(SURFACE, 3);
    } finally {
      harness.dispose();
    }
  });

  it("never lets a sibling's miss overshoot contaminate a deferred hit pellet", () => {
    const harness = makeFxHarness();
    try {
      const actors = harness.state.serverAuthority.actors as unknown as Record<string, HarnessActor>;
      actors["S"] = actorAt(0, 0, "Shooter");
      actors["A"] = actorAt(4, 0, "Target");
      pushEvents(harness.state, [
        rollEvent({ id: 1, tick: 5, shooterActorId: "S", targetActorId: "A", hit: false, damage: 0 }),
        rollEvent({ id: 2, tick: 5, shooterActorId: "S", targetActorId: "A", hit: true, damage: 3 }),
      ]);
      harness.tap.update(harness.state); // miss spawns now (overshoots); hit pends
      flyAll(harness, 0.5);
      expect(harness.tap.arrivalCount).toBe(1);
      (harness.state as unknown as { worldTimeMs: number }).worldTimeMs = 200;
      harness.tap.update(harness.state);
      flyAll(harness, 0.5);
      expect(harness.tap.arrivalCount).toBe(2);
      expect(harness.tap.lastArrivalKind).toBe(1);
      const dist = Math.hypot(harness.tap.lastArrivalPoint.x - 4.5, harness.tap.lastArrivalPoint.z - 0.5);
      expect(dist).toBeCloseTo(SURFACE, 3); // old scratch bug compounded to ~2.5+
    } finally {
      harness.dispose();
    }
  });

  it("pops a restrained spark hit-confirm when a landed (blood) bolt arrives", () => {
    const harness = makeFxHarness();
    try {
      const actors = harness.state.serverAuthority.actors as unknown as Record<string, HarnessActor>;
      actors["S"] = actorAt(0, 0, "Shooter");
      actors["T"] = actorAt(4, 0, "Target");
      pushEvents(harness.state, [rollEvent({ id: 1, tick: 5, shooterActorId: "S", targetActorId: "T", hit: true, damage: 4 })]);
      harness.tap.update(harness.state);
      harness.tracers.update(0.02, harness.state); // in flight, pre-arrival
      const preArrival = additiveLiveCount(harness.particles);
      flyAll(harness, 0.5);
      expect(harness.tap.arrivalCount).toBe(1);
      expect(additiveLiveCount(harness.particles)).toBeGreaterThan(preArrival);
    } finally {
      harness.dispose();
    }
  });
});

describe("tracer terminal frame", () => {
  it("clamps the arrival frame to the exact hit point, draws it hot, and frees next update", () => {
    const scene = new Scene();
    const texture = new Texture() as CanvasTexture;
    const tracers = new TracerFx(scene, texture);
    const state = { serverAuthority: { eventLog: [], actors: {} } } as unknown as PlayState;
    try {
      const arrivals: Vector3[] = [];
      let arrivedCore: { opacity: number } | null = null;
      tracers.onArrive = (rec) => {
        arrivals.push(rec.pos.clone());
        arrivedCore = rec.core.material as { opacity: number };
      };
      const origin = new Vector3(0, 1, 0);
      const dir = new Vector3(1, 0, 0);
      const hitPoint = new Vector3(3.9, 1, 0);
      expect(tracers.spawn({ origin, dir, speed: 10, range: 4, key: 5, mag: 1 })).toBe(true);
      expect(tracers.setOutcome(5, 2, hitPoint, 1, 1, false, false, 1, "T")).toBe(true);
      tracers.update(0.4, state); // travels 4.0 >= hitDist 3.9 -> terminal frame
      expect(arrivals.length).toBe(1);
      expect(arrivals[0]!.distanceTo(hitPoint)).toBeLessThan(1e-6);
      // arrival frame stays visible AND hot (old range-fade had it at opacity 0 by k=0.975)
      expect(tracers.activeCount).toBe(1);
      expect(arrivedCore!.opacity).toBe(1);
      tracers.update(0.016, state);
      expect(tracers.activeCount).toBe(0);
      expect(arrivals.length).toBe(1); // onArrive fired exactly once
    } finally {
      tracers.dispose();
      texture.dispose();
    }
  });
});
