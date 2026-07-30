import { describe, expect, it } from "vitest";

import { createPlayState, type SliceSnapshot } from "./gameState";
import { cancelRollAttackRepeat, queueRollAttack } from "./rollCombatInputSystem";

function slice(): SliceSnapshot {
  return {
    schema: "successor.vertical-slice.v1",
    stateHash: "test",
    tick: 12,
    tickRateHz: 30,
    combatModel: "roll",
    grid: { cellSizePx: 32 },
    zone: { id: 1, name: "Area", width: 20, height: 20, level: 0 },
    camera: { followActor: "player", zoom: 1 },
    areas: [{ id: "area", name: "Area", kind: "overworld", width: 20, height: 20, level: 0 }],
    actors: [{
      id: "player",
      entity: "player",
      areaId: "area",
      label: "Player",
      role: "player",
      sprite: "adventurer-premium-male",
      poseSet: "idle",
      direction: "right",
      cell: { x: 1, y: 1 },
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

function connectedState() {
  const play = createPlayState(slice());
  play.serverAuthority.enabled = true;
  play.serverAuthority.connected = true;
  play.serverAuthority.status = "connected";
  play.serverAuthority.sourceMatchesClient = true;
  play.serverAuthority.snapshotTick = 12;
  return play;
}

describe("rollCombatInputSystem", () => {
  it("arms one repeat command per held target and cancels on target loss", () => {
    const play = connectedState();
    const fixture = slice();
    play.softLockActorId = "wildlife-1";

    queueRollAttack(play, fixture);
    queueRollAttack(play, fixture);
    play.softLockActorId = null;
    queueRollAttack(play, fixture);

    expect(play.rollRepeatTargetId).toBeNull();
    expect(play.authorityCommands.pending.map((entry) => entry.command)).toEqual([
      { QueueCombatAction: { action_id: "basic_shot", target_actor_id: "wildlife-1" } },
      { CancelAbilityQueue: { scope: "owner_repeat" } },
    ]);
  });

  it("cancels an armed repeat when the trigger is released", () => {
    const play = connectedState();
    const fixture = slice();
    play.softLockActorId = "wildlife-1";

    queueRollAttack(play, fixture);
    cancelRollAttackRepeat(play, fixture);

    expect(play.rollRepeatTargetId).toBeNull();
    expect(play.authorityCommands.pending.at(-1)?.command).toEqual({
      CancelAbilityQueue: { scope: "owner_repeat" },
    });
  });
});
