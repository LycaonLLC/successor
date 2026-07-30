import { describe, expect, it } from "vitest";
import {
  createActorCombatStates,
  createInitialProgressionState,
  createPlayState,
  type SliceSnapshot,
} from "./gameState";
import { buildMovementBlockers } from "./worldQueries";

function sliceCoreFixture(): SliceSnapshot {
  return {
    schema: "successor.slice-core.v1",
    tick: 12,
    tickRateHz: 20,
    combatModel: "roll",
    grid: { cellSizePx: 32 },
    zone: { id: 1, name: "Open Desert", width: 20, height: 12, level: 0 },
    areas: [{ id: "street", name: "Street", kind: "overworld", width: 20, height: 12, level: 0 }],
    stateHash: "fixture",
    camera: { followActor: "player", zoom: 1 },
    actors: [
      {
        id: "player",
        entity: "actor/player",
        areaId: "street",
        label: "Field Observer",
        role: "player",
        sprite: "adventurer-premium-male",
        poseSet: "walk",
        direction: "left",
        cell: { x: 4, y: 5 },
        route: [],
      },
      {
        id: "vendor",
        entity: "actor/vendor",
        areaId: "street",
        label: "Vendor",
        role: "public_shopkeeper",
        sprite: "adventurer-premium-male",
        poseSet: "walk",
        direction: "front",
        cell: { x: 8, y: 5 },
        route: [],
      },
    ],
    props: [
      {
        id: "crate-1",
        entity: "prop/crate",
        areaId: "street",
        label: "Crate",
        kind: "crate",
        cell: { x: 6, y: 5 },
        size: { w: 1, h: 1 },
        interactive: false,
      },
      {
        id: "tree-1",
        entity: "prop/tree",
        areaId: "street",
        label: "Tree",
        kind: "prop",
        cell: { x: 12, y: 4 },
        size: { w: 4, h: 4 },
        interactive: false,
        solid: false,
        collisionBounds: [{ xMilli: 1500, yMilli: 2500, wMilli: 1000, hMilli: 1200 }],
      },
    ],
    blockedCells: [{ areaId: "street", x: 3, y: 3 }],
    transitions: [],
    inventory: [],
    reservations: [],
    events: [],
  };
}

describe("gameState", () => {
  it("creates the initial play state from the fixture", () => {
    const state = createPlayState(sliceCoreFixture());

    expect(state.playerActorId).toBe("player");
    expect(state.player).toEqual({ x: 4, y: 5 });
    expect(state.facing).toBe("left");
    expect(state.activeAreaId).toBe("street");
    expect(state.blocked.has("3,3")).toBe(true);
    expect(state.blocked.has("6,5")).toBe(true);
    expect(state.blocked.has("12,6")).toBe(false);
    expect(state.movementBlockers).toContainEqual({ left: 13.5, top: 6.5, right: 14.5, bottom: 7.7 });
    expect(state.loadout.activeWeaponId).toBe("slugthrower");
    expect(state.loadout.ammo["slug"]).toEqual({ loaded: 30, reserve: 180 });
    expect(state.loadout.ammo.melee).toEqual({ loaded: 1, reserve: 0 });
    expect(state.loadout.unlimitedAmmo).toBe(false);
    expect(state.death.phase).toBe("alive");
  });

  it("adds the door-gap movement blocker only while door state is closed", () => {
    const slice = sliceCoreFixture();
    slice.props.push({
      id: "door-house",
      entity: "prop/door-house",
      areaId: "street",
      label: "Door House",
      kind: "prop",
      cell: { x: 10, y: 4 },
      size: { w: 5, h: 4 },
      interactive: false,
      solid: false,
      door: { blocker: { xMilli: 2420, yMilli: 3705, wMilli: 1240, hMilli: 295 }, interactRadiusCells: 2.2 },
    });

    expect(buildMovementBlockers(slice, "street", { "door-house": { doorOpen: false } })).toContainEqual({
      left: 12.42,
      top: 7.705,
      right: 13.66,
      bottom: 8,
    });
    expect(buildMovementBlockers(slice, "street", { "door-house": { doorOpen: true } })).not.toContainEqual({
      left: 12.42,
      top: 7.705,
      right: 13.66,
      bottom: 8,
    });
  });

  it("can initialize the local player from a launch actor override instead of the fixture camera", () => {
    const slice = sliceCoreFixture();
    slice.camera.followActor = "vendor";

    const state = createPlayState(slice, "player");

    expect(state.playerActorId).toBe("player");
    expect(state.player).toEqual({ x: 4, y: 5 });
    expect(state.facing).toBe("left");
  });

  it("builds actor combat state for every actor", () => {
    const states = createActorCombatStates(sliceCoreFixture());

    expect(Object.keys(states).sort()).toEqual(["player", "vendor"]);
    expect(states.player?.lifeState).toBe("alive");
    expect(states.vendor?.bleed.active).toBe(false);
    expect(states.vendor).toMatchObject({ actorId: "vendor", downed: false, downedCell: null });
  });

  it("creates the current prototype progression baseline", () => {
    const progression = createInitialProgressionState();

    expect(progression.professions.marksman.xp).toBe(35);
    expect(progression.certificates).toContain("cert_rifle");
    expect(progression.certificates).toContain("cert_combat_medic");
    expect(progression.abilities).toContain("ability_leg_shot");
    expect(progression.skillNodes.map((node) => node.id)).toContain("marksman-novice");
  });
});
