import { describe, expect, it } from "vitest";

import { createTuiPlayStateFixture } from "../../test/fixtures/playState";
import {
  attackApproachBand,
  createPursueMachine,
  DEFAULT_PURSUE_TIMEOUT_MS,
  type ApproachBand,
  type PursueBeat,
  type PursueEffect,
  type PursueWorldView,
} from "./pursue";

const BAND: ApproachBand = { desiredCells: 12, maxCells: 20, melee: false };

function world(overrides: Partial<PursueWorldView> = {}): PursueWorldView {
  return {
    nowMs: 10_000,
    self: { x: 0, y: 0 },
    selfHealth: 100,
    selfAlive: true,
    target: { x: 30, y: 0, alive: true },
    ...overrides,
  };
}

function machineAt(overrides: Partial<Parameters<typeof createPursueMachine>[0]> = {}) {
  return createPursueMachine({
    targetId: "rogue-1",
    targetLabel: "Rogue trooper",
    band: BAND,
    ...overrides,
  });
}

function beats(effects: PursueEffect[]): PursueBeat[] {
  return effects.filter((effect): effect is Extract<PursueEffect, { kind: "beat" }> => effect.kind === "beat").map((effect) => effect.beat);
}

function kinds(effects: PursueEffect[]): string[] {
  return effects.map((effect) => effect.kind);
}

describe("pursue machine — the walk", () => {
  it("starts with a start beat and a walk toward the target, then engages at the band", () => {
    const machine = machineAt();
    const opening = machine.start(world());
    expect(machine.phase()).toBe("pursuing");
    expect(beats(opening)).toMatchObject([{ kind: "start", label: "Rogue trooper" }]);
    expect(kinds(opening)).toContain("walk");

    // still out of band → keeps walking, silently (no beat spam)
    const mid = machine.tick(world({ target: { x: 16, y: 0, alive: true } }));
    expect(kinds(mid)).toEqual(["walk"]);

    // crosses the band → stop + level-off beat + engage handoff
    const arrival = machine.tick(world({ target: { x: 10, y: 0, alive: true } }));
    expect(kinds(arrival)).toEqual(["stop", "beat", "engage"]);
    expect(beats(arrival)[0]).toMatchObject({ kind: "level_off" });
    expect(machine.phase()).toBe("in_range");

    // engage queued + receipt accepted → engaged
    expect(machine.noteEngageResult(true, 42, world())).toEqual([]);
    machine.receipt({ commandKind: "QueueCombatAction", accepted: true, commandId: 42 }, world());
    expect(machine.phase()).toBe("engaged");
  });

  it("re-aims while the target moves — the walk wind follows the bearing", () => {
    const machine = machineAt();
    machine.start(world());
    const east = machine.tick(world({ target: { x: 30, y: 0, alive: true } }));
    const north = machine.tick(world({ target: { x: 0, y: -30, alive: true } }));
    const eastWalk = east.find((effect) => effect.kind === "walk");
    const northWalk = north.find((effect) => effect.kind === "walk");
    expect(eastWalk && northWalk).toBeTruthy();
    if (eastWalk?.kind === "walk" && northWalk?.kind === "walk") {
      expect(eastWalk.wind).toBe("east");
      expect(northWalk.wind).toBe("north");
      expect(eastWalk.wind).not.toBe(northWalk.wind);
    }
  });

  it("target dies mid-pursuit → clean, spoken abort", () => {
    const machine = machineAt();
    machine.start(world());
    const effects = machine.tick(world({ target: { x: 20, y: 0, alive: false } }));
    expect(kinds(effects)).toEqual(["stop", "beat"]);
    expect(beats(effects)[0]).toMatchObject({ kind: "abort", reason: "target_dead" });
    expect(machine.phase()).toBe("idle");
  });

  it("target leaves AOI mid-pursuit → the pursuit dies with the stream (visibility law)", () => {
    const machine = machineAt();
    machine.start(world());
    const effects = machine.tick(world({ target: null }));
    expect(beats(effects)[0]).toMatchObject({ kind: "abort", reason: "target_lost" });
    expect(machine.phase()).toBe("idle");
  });

  it("budget-denied movement → honest halt, walk stops, spoken once", () => {
    const machine = machineAt();
    machine.start(world());
    const effects = machine.receipt(
      { commandKind: "SetMoveIntent", accepted: false, reasonCode: "ingress_budget_exhausted", commandId: 7 },
      world(),
    );
    expect(kinds(effects)).toEqual(["stop", "beat"]);
    expect(beats(effects)[0]).toMatchObject({ kind: "abort", reason: "budget" });
    expect(machine.phase()).toBe("idle");
  });

  it("player interrupt wins instantly while walking; engaged interrupts stay silent", () => {
    const walking = machineAt();
    walking.start(world());
    const interrupted = walking.interrupt("movement");
    expect(kinds(interrupted)).toEqual(["stop", "beat"]);
    expect(beats(interrupted)[0]).toMatchObject({ kind: "abort", reason: "player_move" });
    expect(walking.phase()).toBe("idle");

    const engaged = machineAt();
    engaged.start(world());
    engaged.tick(world({ target: { x: 10, y: 0, alive: true } }));
    engaged.noteEngageResult(true, 9, world());
    engaged.receipt({ accepted: true, commandId: 9 }, world());
    expect(engaged.phase()).toBe("engaged");
    expect(engaged.interrupt("movement")).toEqual([]); // no beats — the fight is the server's
    expect(engaged.phase()).toBe("idle");
  });

  it("kiting: out_of_range dismissal re-pursues with ONE narration, then re-engages", () => {
    const machine = machineAt();
    machine.start(world());
    machine.tick(world({ target: { x: 10, y: 0, alive: true } }));
    machine.noteEngageResult(true, 11, world());
    machine.receipt({ accepted: true, commandId: 11 }, world());
    expect(machine.phase()).toBe("engaged");

    // server clears the repeat intent at swing time — edge-triggered, one beat
    const chase = machine.queueEvent(
      { lifecycle: "dismissed", reasonCode: "out_of_range" },
      world({ target: { x: 25, y: 0, alive: true } }),
    );
    expect(beats(chase)).toMatchObject([{ kind: "repursue" }]);
    expect(kinds(chase)).toContain("walk");
    expect(machine.phase()).toBe("pursuing");

    // closes again → engages again, no extra re-pursue chatter
    const arrival = machine.tick(world({ target: { x: 9, y: 0, alive: true } }));
    expect(beats(arrival)).toMatchObject([{ kind: "level_off" }]);
  });

  it("engage receipt rejected out_of_range (target stepped out at the swing) re-pursues too", () => {
    const machine = machineAt();
    machine.start(world());
    machine.tick(world({ target: { x: 10, y: 0, alive: true } }));
    machine.noteEngageResult(true, 13, world());
    const chase = machine.receipt(
      { accepted: false, reasonCode: "out_of_range", commandId: 13 },
      world({ target: { x: 22, y: 0, alive: true } }),
    );
    expect(beats(chase)).toMatchObject([{ kind: "repursue" }]);
    expect(machine.phase()).toBe("pursuing");
  });

  it("engage rejected for any other reason → honest stand-down", () => {
    const machine = machineAt();
    machine.start(world());
    machine.tick(world({ target: { x: 10, y: 0, alive: true } }));
    machine.noteEngageResult(true, 17, world());
    const effects = machine.receipt({ accepted: false, reasonCode: "los_blocked", commandId: 17 }, world());
    expect(beats(effects)[0]).toMatchObject({ kind: "abort", reason: "attack_denied" });
    expect(machine.phase()).toBe("idle");
  });

  it("non-range dismissals while engaged stand down silently (the queue narrator owns the reason)", () => {
    const machine = machineAt();
    machine.start(world());
    machine.tick(world({ target: { x: 10, y: 0, alive: true } }));
    machine.noteEngageResult(true, 19, world());
    machine.receipt({ accepted: true, commandId: 19 }, world());
    const effects = machine.queueEvent({ lifecycle: "dismissed", reasonCode: "insufficient_action" }, world());
    expect(effects).toEqual([]);
    expect(machine.phase()).toBe("idle");
  });

  it("target death while engaged ends the watch silently (the combat register speaks the kill)", () => {
    const machine = machineAt();
    machine.start(world());
    machine.tick(world({ target: { x: 10, y: 0, alive: true } }));
    machine.noteEngageResult(true, 23, world());
    machine.receipt({ accepted: true, commandId: 23 }, world());
    const effects = machine.tick(world({ target: { x: 10, y: 0, alive: false } }));
    expect(beats(effects)).toEqual([]);
    expect(machine.phase()).toBe("idle");
  });

  it("pursuit leg times out honestly", () => {
    const machine = machineAt({ timeoutMs: 5_000 });
    machine.start(world({ nowMs: 10_000 }));
    const still = machine.tick(world({ nowMs: 14_900 }));
    expect(beats(still)).toEqual([]);
    const effects = machine.tick(world({ nowMs: 15_100 }));
    expect(beats(effects)[0]).toMatchObject({ kind: "abort", reason: "timeout" });
    expect(machine.phase()).toBe("idle");
  });

  it("refuses targets beyond the approach cap", () => {
    const machine = machineAt({ maxApproachCells: 96 });
    const effects = machine.start(world({ target: { x: 200, y: 0, alive: true } }));
    expect(beats(effects)[0]).toMatchObject({ kind: "abort", reason: "too_far" });
    expect(machine.phase()).toBe("idle");
  });

  it("abortWhenHurt (use-consumer guard) breaks the walk when blood is drawn", () => {
    const machine = machineAt({ abortWhenHurt: true });
    machine.start(world({ selfHealth: 100 }));
    const effects = machine.tick(world({ selfHealth: 88 }));
    expect(beats(effects)[0]).toMatchObject({ kind: "abort", reason: "hurt" });
    expect(machine.phase()).toBe("idle");
  });

  it("own death ends the pursuit silently — the death narration owns that moment", () => {
    const machine = machineAt();
    machine.start(world());
    const effects = machine.tick(world({ selfAlive: false }));
    expect(beats(effects)).toEqual([]);
    expect(machine.phase()).toBe("idle");
  });

  it("default timeout is the documented constant", () => {
    expect(DEFAULT_PURSUE_TIMEOUT_MS).toBe(45_000);
  });
});

describe("attack approach band — streamed weapon truth", () => {
  it("prefers slice combatTuning idealCells/maxCells when the slice carries them", () => {
    const { state, slice } = createTuiPlayStateFixture();
    slice.combatTuning = { weaponRangeBands: { slugthrower: { pointBlankCells: 6, idealCells: 12, maxCells: 20 } } };
    expect(attackApproachBand(state, slice)).toEqual({ desiredCells: 12, maxCells: 20, melee: false });
  });

  it("does not invent a movement band when the slice omits authority tuning", () => {
    const { state, slice } = createTuiPlayStateFixture();
    slice.combatTuning = undefined;
    expect(attackApproachBand(state, slice)).toBeNull();
  });

  it("uses projected melee tuning instead of a client-catalog fallback", () => {
    const { state, slice } = createTuiPlayStateFixture();
    const me = state.serverAuthority.actors[state.playerActorId]!;
    me.weapon = { weaponId: "vibrosword", ammoType: "melee", loadedRounds: 0, magazineSize: 0, reloadUntilTick: 0, reloadRemainingTicks: 0, reloadTotalTicks: 0 };
    slice.combatTuning = { weaponRangeBands: { vibrosword: { pointBlankCells: 1, idealCells: 2, maxCells: 3 } } };
    expect(attackApproachBand(state, slice)).toEqual({ desiredCells: 2, maxCells: 3, melee: true });
  });

  it("uses the authority-projected primitive Brawler reach", () => {
    const { state, slice } = createTuiPlayStateFixture();
    const me = state.serverAuthority.actors[state.playerActorId]!;
    me.weapon = { weaponId: "scrapline-machete", ammoType: "melee", loadedRounds: 0, magazineSize: 0, reloadUntilTick: 0, reloadRemainingTicks: 0, reloadTotalTicks: 0 };
    slice.combatTuning = { weaponRangeBands: { "scrapline-machete": { pointBlankCells: 1, idealCells: 2, maxCells: 3 } } };
    expect(attackApproachBand(state, slice)).toEqual({ desiredCells: 2, maxCells: 3, melee: true });
  });

  it("returns null with no streamed weapon — the server speaks NO WEAPON instead", () => {
    const { state, slice } = createTuiPlayStateFixture();
    state.serverAuthority.actors[state.playerActorId]!.weapon = null;
    expect(attackApproachBand(state, slice)).toBeNull();
  });
});
