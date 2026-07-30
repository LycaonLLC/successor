import { describe, expect, it } from "vitest";
import { createPlayState, type PlayState, type SliceSnapshot } from "./gameState";
import {
  cycleInteractionSelection,
  enqueueTakeAllLootStacks,
  interactionOptions,
  playerWithinExchangeInteractionRange,
} from "./interactionSystem";

function sliceFixture(): SliceSnapshot {
  return {
    schema: "fixture",
    tick: 90,
    tickRateHz: 30,
    combatModel: "roll",
    grid: { cellSizePx: 60 },
    zone: { id: 1, name: "Loot Test", width: 24, height: 24, level: 0 },
    areas: [{ id: "open-desert-overworld", name: "Loot Test", kind: "overworld", width: 24, height: 24, level: 0 }],
    stateHash: "loot-test",
    camera: { followActor: "player", zoom: 1 },
    actors: [{
      id: "player",
      entity: "actor/player",
      areaId: "open-desert-overworld",
      label: "Field Observer",
      role: "player",
      sprite: "adventurer-premium-male",
      poseSet: "walk",
      direction: "right",
      cell: { x: 10, y: 10 },
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

function serverActor(overrides: Partial<PlayState["serverAuthority"]["actors"][string]>) {
  return {
    id: "actor",
    label: "Actor",
    areaId: "open-desert-overworld",
    x: 10,
    y: 10,
    direction: "right",
    lifeState: "alive",
    lifecycleSeq: 1,
    vitals: { health: 100, action: 100, spirit: 100 },
    maxVitals: { health: 100, action: 100, spirit: 100 },
    bleed: {
      active: false,
      stackCount: 0,
      severity: 0,
      remainingMs: 0,
      ratesPerSecond: { health: 0, action: 0, spirit: 0 },
    },
    statuses: [],
    ...overrides,
  } as PlayState["serverAuthority"]["actors"][string];
}

describe("interactionSystem", () => {
  it("offers a nearby ammo corpse and queues the authoritative loot command", () => {
    const slice = sliceFixture();
    const state = createPlayState(slice, "player");
    state.serverAuthority.enabled = true;
    state.serverAuthority.sourceMatchesClient = true;
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors = {
      player: serverActor({ id: "player", label: "Field Observer", role: "player", x: 10, y: 10 }),
      "rogue-corpse": serverActor({
        id: "rogue-corpse",
        label: "Rogue Remains",
        role: "skirmisher",
        factionId: "rogue_troopers",
        x: 11.7,
        y: 10,
        lifeState: "downed",
        bodyVanishAtTick: 10_000,
      }),
    };
    state.inventory = [{
      container: "corpse:rogue-corpse",
      item: "Iron Slug",
      itemId: 1101,
      variantId: 0,
      quantity: 37,
      reserved: 0,
      available: 37,
    }];

    const options = interactionOptions(slice, state);
    expect(options).toMatchObject([
      { kind: "corpse", targetId: "rogue-corpse", detail: "Loot remains" },
    ]);

    expect(enqueueTakeAllLootStacks(state, slice, "corpse:rogue-corpse")).toBe(1);
    expect(state.authorityCommands.pending.at(-1)?.command).toEqual({
      TakeLootItem: { container: "corpse:rogue-corpse", itemId: 1101, variantId: 0, quantity: 37 },
    });
  });
  it("preserves an authored footlocker container and take-only marker", () => {
    const slice = sliceFixture();
    slice.props = [{
      id: "dustgate-footlocker",
      entity: "prop.footlocker",
      areaId: "open-desert-overworld",
      label: "Dustgate Footlocker",
      kind: "storage_chest",
      cell: { x: 10, y: 10 },
      size: { w: 1, h: 1 },
      interactive: true,
      container: "footlocker:dustgate-footlocker",
      takeOnly: true,
    }];
    const state = createPlayState(slice, "player");
    state.serverAuthority.playerActorId = "player";
    expect(interactionOptions(slice, state)).toMatchObject([{
      kind: "lootCache",
      targetId: "dustgate-footlocker",
      container: "footlocker:dustgate-footlocker",
      takeOnly: true,
    }]);
  });

  it("leaves legacy cache identity absent so the client applies its cache fallback", () => {
    const slice = sliceFixture();
    slice.props = [{
      id: "legacy-cache",
      entity: "prop.cache",
      areaId: "open-desert-overworld",
      label: "Legacy Cache",
      kind: "storage_chest",
      cell: { x: 10, y: 10 },
      size: { w: 1, h: 1 },
      interactive: true,
    }];
    const state = createPlayState(slice, "player");
    state.serverAuthority.playerActorId = "player";
    const option = interactionOptions(slice, state)[0];
    expect(option).toBeDefined();
    expect(option).not.toHaveProperty("container");
  });

  it("does not offer an empty humanoid corpse as lootable", () => {
    const slice = sliceFixture();
    const state = createPlayState(slice, "player");
    state.serverAuthority.enabled = true;
    state.serverAuthority.sourceMatchesClient = true;
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors = {
      player: serverActor({ id: "player", label: "Field Observer", role: "player", x: 10, y: 10 }),
      "empty-corpse": serverActor({
        id: "empty-corpse",
        label: "Empty Remains",
        role: "skirmisher",
        x: 11,
        y: 10,
        lifeState: "downed",
        bodyVanishAtTick: 10_000,
      }),
    };

    expect(interactionOptions(slice, state)).toEqual([]);
  });

  it("offers role-keyed Gaia creature corpses for harvest", () => {
    const slice = sliceFixture();
    const state = createPlayState(slice, "player");
    state.serverAuthority.enabled = true;
    state.serverAuthority.sourceMatchesClient = true;
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors = {
      player: serverActor({ id: "player", label: "Field Observer", role: "player", x: 10, y: 10 }),
      "open-desert-creature-01": serverActor({
        id: "open-desert-creature-01",
        label: "Duskback",
        role: "creature",
        x: 11,
        y: 10,
        lifeState: "downed",
        bodyVanishAtTick: 10_000,
      }),
    };

    expect(interactionOptions(slice, state)).toMatchObject([
      { kind: "corpse", targetId: "open-desert-creature-01", detail: "Harvest hide, meat, and bone" },
    ]);
  });

  it("does not offer a creature corpse when authority marks it unlootable", () => {
    const slice = sliceFixture();
    const state = createPlayState(slice, "player");
    state.serverAuthority.enabled = true;
    state.serverAuthority.sourceMatchesClient = true;
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors = {
      player: serverActor({ id: "player", label: "Field Observer", role: "player", x: 10, y: 10 }),
      "harvested-creature": serverActor({
        id: "harvested-creature",
        label: "Harvested Duskback",
        role: "creature",
        x: 11,
        y: 10,
        lifeState: "downed",
        bodyVanishAtTick: 10_000,
        lootable: false,
      }),
    };

    expect(interactionOptions(slice, state)).toEqual([]);
  });

  it("offers nearby door metadata with current open state", () => {
    const slice = sliceFixture();
    slice.props.push({
      id: "shelter-house",
      entity: "prop/shelter-house",
      areaId: "open-desert-overworld",
      label: "Shelter House",
      kind: "prop",
      cell: { x: 8, y: 8 },
      size: { w: 5, h: 4 },
      interactive: false,
      solid: false,
      door: { blocker: { xMilli: 2420, yMilli: 3705, wMilli: 1240, hMilli: 295 }, interactRadiusCells: 2.2 },
    });
    const state = createPlayState(slice, "player");
    state.serverAuthority.enabled = true;
    state.serverAuthority.sourceMatchesClient = true;
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.propStates = { "shelter-house": { doorOpen: true } };
    state.serverAuthority.actors = {
      player: serverActor({ id: "player", label: "Field Observer", role: "player", x: 11.04, y: 11.85 }),
    };

    expect(interactionOptions(slice, state)).toMatchObject([
      { kind: "door", label: "SHELTER DOOR", targetId: "shelter-house", doorOpen: true, detail: "Close shelter door" },
    ]);
  });

  it("selects a closed facility door before interactions behind it", () => {
    const slice = sliceFixture();
    slice.props.push(
      {
        id: "commerce-facility",
        entity: "prop/district-exchange",
        areaId: "open-desert-overworld",
        label: "Commerce Facility",
        kind: "exchange",
        cell: { x: 8, y: 8 },
        size: { w: 5, h: 4 },
        interactive: true,
        solid: false,
        door: { blocker: { xMilli: 2420, yMilli: 3705, wMilli: 1240, hMilli: 295 }, interactRadiusCells: 2.2 },
      },
    );
    const state = createPlayState(slice, "player");
    state.serverAuthority.enabled = true;
    state.serverAuthority.sourceMatchesClient = true;
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.propStates = { "commerce-facility": { doorOpen: false } };
    state.serverAuthority.actors = {
      player: serverActor({ id: "player", role: "player", x: 11.04, y: 11.85 }),
    };

    expect(interactionOptions(slice, state).map((option) => option.kind)).toEqual(["door", "exchange"]);

    state.serverAuthority.propStates["commerce-facility"] = { doorOpen: true };
    expect(interactionOptions(slice, state).map((option) => option.kind)).toEqual(["exchange", "door"]);
  });

  it("measures exchange reach from the rendered footprint instead of its center", () => {
    const slice = sliceFixture();
    slice.props.push({
      id: "district-exchange",
      entity: "prop/district-exchange",
      areaId: "open-desert-overworld",
      label: "District Exchange",
      kind: "prop",
      cell: { x: 12, y: 8 },
      size: { w: 2, h: 3 },
      interactive: true,
      solid: false,
    });
    const state = createPlayState(slice, "player");
    state.serverAuthority.enabled = true;
    state.serverAuthority.sourceMatchesClient = true;
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors = {
      player: serverActor({ id: "player", role: "player", x: 10.25, y: 10 }),
    };

    expect(playerWithinExchangeInteractionRange(slice, state)).toBe(true);
    expect(interactionOptions(slice, state)).toEqual([
      expect.objectContaining({ kind: "exchange", targetId: "district-exchange" }),
    ]);

    state.serverAuthority.actors.player!.x = 10.249;
    expect(playerWithinExchangeInteractionRange(slice, state)).toBe(false);
    expect(interactionOptions(slice, state)).toEqual([]);
  });

  it("offers nearby bank and clone terminals through the standard F interaction path", () => {
    const slice = sliceFixture();
    slice.props.push(
      {
        id: "dustgate-bank-terminal",
        entity: "prop/bank-terminal",
        areaId: "open-desert-overworld",
        label: "Bank Terminal",
        kind: "bank_terminal",
        cell: { x: 10, y: 10 },
        size: { w: 1, h: 1 },
        interactive: true,
        solid: false,
      },
      {
        id: "dustgate-clone-terminal",
        entity: "prop/clone-terminal",
        areaId: "open-desert-overworld",
        label: "Clone Terminal",
        kind: "clone_terminal",
        cell: { x: 11, y: 10 },
        size: { w: 1, h: 1 },
        interactive: true,
        solid: false,
      },
    );
    const state = createPlayState(slice, "player");
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors = {
      player: serverActor({ id: "player", role: "player", x: 10, y: 10 }),
    };

    expect(interactionOptions(slice, state)).toMatchObject([
      {
        kind: "bankTerminal",
        targetId: "dustgate-bank-terminal",
        detail: "Open personal vault",
      },
      {
        kind: "cloneTerminal",
        targetId: "dustgate-clone-terminal",
        detail: "Open cloning services",
      },
    ]);

    state.serverAuthority.actors.player!.x = 14;
    expect(interactionOptions(slice, state)).toEqual([]);
  });

  it("offers the owner camp throughout its visible 5×5 footprint", () => {
    const slice = sliceFixture();
    const state = createPlayState(slice, "player");
    state.serverAuthority.enabled = true;
    state.serverAuthority.sourceMatchesClient = true;
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.placedCamps = [{
      campId: "camp:player:1",
      areaId: "open-desert-overworld",
      cellX: 10,
      cellY: 10,
      isOwner: true,
      renderKind: "scout-camp",
    }];
    state.serverAuthority.actors = {
      player: serverActor({ id: "player", role: "player", x: 12.9, y: 12.9 }),
    };

    expect(interactionOptions(slice, state)).toMatchObject([
      { kind: "camp", targetId: "camp:player:1", label: "Scout Camp" },
    ]);

    state.serverAuthority.actors.player!.x = 13.001;
    state.serverAuthority.actors.player!.y = 10.5;
    expect(interactionOptions(slice, state)).toEqual([]);
  });
});

describe("cycleInteractionSelection", () => {
  it("cycles the selection forward and wraps around the in-reach list", () => {
    const slice = sliceFixture();
    const state = createPlayState(slice, "player");
    state.serverAuthority.enabled = true;
    state.serverAuthority.sourceMatchesClient = true;
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors = {
      player: serverActor({ id: "player", label: "Field Observer", role: "player", x: 10, y: 10 }),
      "corpse-a": serverActor({ id: "corpse-a", label: "A", role: "skirmisher", factionId: "rogue_troopers", x: 11.6, y: 10, lifeState: "downed", bodyVanishAtTick: 10_000 }),
      "corpse-b": serverActor({ id: "corpse-b", label: "B", role: "skirmisher", factionId: "rogue_troopers", x: 10, y: 11.6, lifeState: "downed", bodyVanishAtTick: 10_000 }),
    };
    state.inventory = [
      { container: "corpse:corpse-a", item: "Iron Slug", itemId: 1101, variantId: 0, quantity: 1, reserved: 0, available: 1 },
      { container: "corpse:corpse-b", item: "Iron Slug", itemId: 1101, variantId: 0, quantity: 1, reserved: 0, available: 1 },
    ];
    state.interactions.options = interactionOptions(slice, state);
    expect(state.interactions.options.length).toBe(2);
    expect(state.interactions.selectedIndex).toBe(0);

    cycleInteractionSelection(state, 1);
    expect(state.interactions.selectedIndex).toBe(1);
    cycleInteractionSelection(state, 1);
    expect(state.interactions.selectedIndex).toBe(0); // wraps
  });

  it("is a no-op when nothing is in reach", () => {
    const slice = sliceFixture();
    const state = createPlayState(slice, "player");
    state.serverAuthority.enabled = true;
    state.serverAuthority.sourceMatchesClient = true;
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors = {
      player: serverActor({ id: "player", label: "Field Observer", role: "player", x: 10, y: 10 }),
    };
    state.interactions.options = interactionOptions(slice, state);
    expect(state.interactions.options.length).toBe(0);

    cycleInteractionSelection(state, 1);
    expect(state.interactions.selectedIndex).toBe(0);
  });
});
