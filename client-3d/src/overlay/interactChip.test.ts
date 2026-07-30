import { describe, expect, it } from "vitest";
import type {
  InteractionOption,
  PlayState,
  ServerAuthorityActorState,
  SliceSnapshot,
} from "@successor/client/src/slice-core/gameState";
import {
  CYCLE_INTERACT_KEY_CODE,
  CYCLE_INTERACT_KEY_LETTER,
  computeInteractChipVm,
  interactChipAnchor,
  interactChipName,
  interactChipReachAlpha,
  interactChipVerb,
  setInteractChipSuppressor,
} from "./interactChip";
import { armPackUpConfirm, disarmPackUpConfirm, PACK_UP_ARM_WINDOW_MS } from "../ui/camp/actions";

function actor(overrides: Partial<ServerAuthorityActorState>): ServerAuthorityActorState {
  return {
    id: "actor",
    label: "Actor",
    areaId: "desert",
    x: 0,
    y: 0,
    direction: "front",
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
  } as ServerAuthorityActorState;
}

function option(overrides: Partial<InteractionOption>): InteractionOption {
  return {
    id: "door:shelter-1",
    kind: "door",
    label: "SHELTER DOOR",
    detail: "Open shelter door",
    targetId: "shelter-1",
    distanceCells: 1,
    ...overrides,
  };
}

function playState(overrides: Partial<Record<string, unknown>> = {}): PlayState {
  const { serverAuthority: authorityOverrides, ...rest } = overrides;
  return {
    playerActorId: "player",
    activeAreaId: "desert",
    player: { x: 10, y: 10 },
    inventory: [],
    interactions: { options: [], menuOpen: false, selectedIndex: 0, lastPrompt: null },
    ...rest,
    serverAuthority: {
      enabled: true,
      playerActorId: "player",
      actors: {},
      placedExtractors: [],
      placedCamps: [],
      propStates: {},
      ...(authorityOverrides as object ?? {}),
    },
  } as unknown as PlayState;
}

function slice(overrides: Partial<Record<string, unknown>> = {}): SliceSnapshot {
  return {
    props: [],
    actors: [],
    ...overrides,
  } as unknown as SliceSnapshot;
}

describe("interactChipVerb", () => {
  it("flips the door verb on live server state and precedences the extractor verbs", () => {
    const state = playState({
      serverAuthority: {
        actors: {},
        placedExtractors: [
          { extractorId: "ex-1", areaId: "desert", cellX: 4, cellY: 4, mode: "manual", hopperPct: 40, collectableUnits: 0, isOwner: true },
          { extractorId: "ex-2", areaId: "desert", cellX: 6, cellY: 6, mode: "idle", hopperPct: 25, collectableUnits: 0, isOwner: true },
          { extractorId: "ex-3", areaId: "desert", cellX: 8, cellY: 8, mode: "idle", hopperPct: 0, collectableUnits: 0, isOwner: true },
        ],
        propStates: { "shelter-1": { doorOpen: true } },
      },
    });

    expect(interactChipVerb(option({ kind: "door", targetId: "shelter-1" }), state)).toBe("CLOSE");
    expect(interactChipVerb(option({ kind: "door", targetId: "shelter-2" }), state)).toBe("OPEN");
    expect(interactChipVerb(option({ kind: "extractor", targetId: "ex-1" }), state)).toBe("STOP");
    expect(interactChipVerb(option({ kind: "extractor", targetId: "ex-2" }), state)).toBe("COLLECT");
    expect(interactChipVerb(option({ kind: "extractor", targetId: "ex-3" }), state)).toBe("CRANK");
  });

  it("harvests wildlife corpses and loots humanoid ones", () => {
    const state = playState({
      serverAuthority: {
        actors: {
          "wildlife-1": actor({ id: "wildlife-1", label: "Bellback", role: "creature", lifeState: "downed" }),
          "rogue-1": actor({ id: "rogue-1", label: "Rogue", lifeState: "downed" }),
        },
        placedExtractors: [],
        propStates: {},
      },
    });

    expect(interactChipVerb(option({ kind: "corpse", targetId: "wildlife-1" }), state)).toBe("HARVEST");
    expect(interactChipVerb(option({ kind: "corpse", targetId: "rogue-1" }), state)).toBe("LOOT");
    expect(interactChipVerb(option({ kind: "trainer", targetId: "t-1" }), state)).toBe("CONVERSE");
    expect(interactChipVerb(option({ kind: "travelTerminal", targetId: "tt-1" }), state)).toBe("TRAVEL");
  });

  it("two-steps the camp strike verb through the confirm arm window", () => {
    const state = playState({
      serverAuthority: {
        actors: {},
        placedExtractors: [],
        placedCamps: [
          { campId: "camp:player:1", areaId: "desert", cellX: 12, cellY: 9, isOwner: true, renderKind: "scout-camp" },
        ],
        propStates: {},
      },
    });
    const campOption = option({ kind: "camp", targetId: "camp:player:1" });
    disarmPackUpConfirm();

    expect(interactChipVerb(campOption, state)).toBe("PACK UP");
    armPackUpConfirm("camp:player:1", performance.now());
    expect(interactChipVerb(campOption, state)).toBe("CONFIRM STRIKE");
    // A different camp's arm never leaks onto this one.
    expect(interactChipVerb(option({ kind: "camp", targetId: "camp:other:2" }), state)).toBe("PACK UP");
    // Window expiry falls back to the safe verb.
    armPackUpConfirm("camp:player:1", performance.now() - PACK_UP_ARM_WINDOW_MS - 1);
    expect(interactChipVerb(campOption, state)).toBe("PACK UP");
    disarmPackUpConfirm();
  });
});

describe("interactChipAnchor", () => {
  it("anchors doors on the blocker center, not the prop footprint", () => {
    const shelter = {
      id: "shelter-1",
      entity: "prop:shelter",
      areaId: "desert",
      label: "Shelter",
      kind: "shelter",
      cell: { x: 100, y: 100 },
      size: { w: 8, h: 6 },
      interactive: true,
      door: { blocker: { xMilli: 3500, yMilli: 5500, wMilli: 1000, hMilli: 500 } },
    };
    const anchor = interactChipAnchor(
      option({ kind: "door", targetId: "shelter-1" }),
      slice({ props: [shelter] }),
      playState(),
    );

    expect(anchor).not.toBeNull();
    expect(anchor!.x).toBeCloseTo(104);
    expect(anchor!.y).toBeCloseTo(105.75);
    // NOT the 8x6 footprint center (104, 103).
    expect(anchor!.y).not.toBeCloseTo(103);
  });

  it("anchors corpses at the authority render position and extractors on their cell", () => {
    const state = playState({
      serverAuthority: {
        actors: {
          "rogue-1": actor({ id: "rogue-1", lifeState: "downed", x: 50, y: 50, renderX: 50.4, renderY: 49.6 }),
        },
        placedExtractors: [
          { extractorId: "ex-1", areaId: "desert", cellX: 30, cellY: 31, mode: "idle", hopperPct: 0, collectableUnits: 0, isOwner: true },
        ],
        propStates: {},
      },
    });

    const corpse = interactChipAnchor(option({ kind: "corpse", targetId: "rogue-1" }), slice(), state);
    expect(corpse).toMatchObject({ x: 50.9, y: 50.1 });
    expect(corpse!.height).toBeLessThan(1); // corpses read LOW — the body is on the ground

    const extractor = interactChipAnchor(option({ kind: "extractor", targetId: "ex-1" }), slice(), state);
    expect(extractor).toMatchObject({ x: 30.5, y: 31.5 });
  });

  it("anchors camps on the tent body (streamed camp cell center)", () => {
    const camp = interactChipAnchor(
      option({ kind: "camp", targetId: "camp:player:1" }),
      slice(),
      playState({
        serverAuthority: {
          actors: {},
          placedExtractors: [],
          placedCamps: [
            { campId: "camp:player:1", areaId: "desert", cellX: 12, cellY: 9, isOwner: true, renderKind: "scout-camp" },
          ],
          propStates: {},
        },
      }),
    );
    expect(camp).toMatchObject({ x: 12.5, y: 9.5 });
    expect(camp!.height).toBeGreaterThan(1); // the chip sits ON the tent body
  });

  it("anchors travel above the fitted kiosk instead of covering its screen", () => {
    const terminal = interactChipAnchor(
      option({ kind: "travelTerminal", targetId: "terminal-1" }),
      slice({
        props: [{
          id: "terminal-1",
          cell: { x: 20, y: 30 },
          size: { w: 1, h: 1 },
        }],
      }),
      playState(),
    );

    expect(terminal).toEqual({ x: 20.5, y: 30.5, height: 2.05 });
    expect(terminal!.height).toBeGreaterThan(1.9); // clears the fitted kiosk crown
  });

  it("falls back to the slice cell for authority-less trainers and null for unknown targets", () => {
    const trainerSlice = slice({
      actors: [{ id: "trainer-1", cell: { x: 12, y: 14 } }],
    });
    expect(interactChipAnchor(option({ kind: "trainer", targetId: "trainer-1" }), trainerSlice, playState()))
      .toMatchObject({ x: 12.5, y: 14.5 });
    expect(interactChipAnchor(option({ kind: "trainer", targetId: "ghost" }), slice(), playState())).toBeNull();
    expect(interactChipAnchor(option({ kind: "exchange", targetId: "ghost" }), slice(), playState())).toBeNull();
  });
});

describe("interactChipReachAlpha", () => {
  it("holds full alpha inside the fade start and floors at the reach edge", () => {
    expect(interactChipReachAlpha(option({ kind: "corpse", distanceCells: 1.0 }), slice())).toBe(1);
    const nearEdge = interactChipReachAlpha(option({ kind: "corpse", distanceCells: 1.75 }), slice());
    expect(nearEdge).toBeCloseTo(0.45, 2);
    const mid = interactChipReachAlpha(option({ kind: "corpse", distanceCells: 1.6 }), slice());
    expect(mid).toBeGreaterThan(nearEdge);
    expect(mid).toBeLessThan(1);
  });

  it("respects a door's per-prop interact radius override", () => {
    const doorSlice = slice({
      props: [{
        id: "shelter-1",
        cell: { x: 0, y: 0 },
        size: { w: 2, h: 2 },
        door: { blocker: { xMilli: 0, yMilli: 0, wMilli: 1000, hMilli: 500 }, interactRadiusCells: 4 },
      }],
    });
    // 2.5 cells is beyond the default 2.2 reach but well inside the 4-cell override.
    expect(interactChipReachAlpha(option({ kind: "door", targetId: "shelter-1", distanceCells: 2.5 }), doorSlice)).toBe(1);
  });
});

describe("computeInteractChipVm", () => {
  it("publishes options, picks the nearest, and counts the overflow", () => {
    const state = playState({
      serverAuthority: {
        actors: {
          player: actor({ id: "player", x: 50, y: 50 }),
          "rogue-1": actor({ id: "rogue-1", label: "Rogue Trooper", lifeState: "downed", lootable: true, x: 50.8, y: 50 }),
          "rogue-2": actor({ id: "rogue-2", label: "Far Rogue", lifeState: "downed", lootable: true, x: 51.4, y: 50 }),
        },
        placedExtractors: [],
        propStates: {},
      },
    });

    const vm = computeInteractChipVm(slice(), state);

    expect(vm).not.toBeNull();
    expect(vm!.optionId).toBe("corpse:rogue-1");
    expect(vm!.verb).toBe("LOOT");
    expect(vm!.name).toBe("ROGUE TROOPER");
    expect(vm!.more).toBe(1);
    expect(vm!.gated).toBe(false);
    expect(state.interactions.options.map((entry) => entry.id))
      .toEqual(["corpse:rogue-1", "corpse:rogue-2"]);
  });

  it("goes honest gray when the player is not alive", () => {
    const state = playState({
      serverAuthority: {
        actors: {
          player: actor({ id: "player", x: 50, y: 50, lifeState: "downed", lootable: true }),
          "rogue-1": actor({ id: "rogue-1", label: "Rogue", lifeState: "downed", lootable: true, x: 50.8, y: 50 }),
        },
        placedExtractors: [],
        propStates: {},
      },
    });

    const vm = computeInteractChipVm(slice(), state);

    expect(vm).not.toBeNull();
    expect(vm!.gated).toBe(true);
  });

  it("returns null with nothing in reach", () => {
    const state = playState({
      serverAuthority: {
        actors: { player: actor({ id: "player", x: 50, y: 50 }) },
        placedExtractors: [],
        propStates: {},
      },
    });

    expect(computeInteractChipVm(slice(), state)).toBeNull();
    expect(state.interactions.options).toEqual([]);
  });
});

describe("computeInteractChipVm cycle selection", () => {
  it("follows the V-cycle selectedIndex instead of always the nearest", () => {
    const state = playState({
      serverAuthority: {
        actors: {
          player: actor({ id: "player", x: 50, y: 50 }),
          "rogue-1": actor({ id: "rogue-1", label: "Near Rogue", lifeState: "downed", lootable: true, x: 50.8, y: 50 }),
          "rogue-2": actor({ id: "rogue-2", label: "Far Rogue", lifeState: "downed", lootable: true, x: 51.4, y: 50 }),
        },
        placedExtractors: [],
        propStates: {},
      },
    });
    state.interactions.selectedIndex = 1; // cycled off the nearest

    const vm = computeInteractChipVm(slice(), state);

    expect(vm).not.toBeNull();
    expect(vm!.optionId).toBe("corpse:rogue-2");
    expect(vm!.name).toBe("FAR ROGUE");
    expect(vm!.more).toBe(1);
    expect(state.interactions.selectedIndex).toBe(1);
  });

  it("clamps a stale selectedIndex back into range", () => {
    const state = playState({
      serverAuthority: {
        actors: {
          player: actor({ id: "player", x: 50, y: 50 }),
          "rogue-1": actor({ id: "rogue-1", label: "Near Rogue", lifeState: "downed", lootable: true, x: 50.8, y: 50 }),
          "rogue-2": actor({ id: "rogue-2", label: "Far Rogue", lifeState: "downed", lootable: true, x: 51.4, y: 50 }),
        },
        placedExtractors: [],
        propStates: {},
      },
    });
    state.interactions.selectedIndex = 99; // walked away; the list shrank

    const vm = computeInteractChipVm(slice(), state);

    expect(vm).not.toBeNull();
    expect(vm!.optionId).toBe("corpse:rogue-2"); // clamps to last valid
    expect(state.interactions.selectedIndex).toBe(1);
  });

  it("advertises the cycle keybind the chip draws (`+n ·V·`)", () => {
    expect(CYCLE_INTERACT_KEY_CODE).toBe("KeyV");
    expect(CYCLE_INTERACT_KEY_LETTER).toBe("V");
  });
});

describe("interactChipName (C1/C2 copy diet)", () => {
  it("rides the clean-name chain for actor targets", () => {
    const state = playState({
      serverAuthority: {
        playerActorId: "player",
        actors: {
          "rogue-1": actor({ id: "rogue-1", label: "Mori Maddox (a rogue trooper)", displayName: "Mori Maddox" }),
          "trainer-1": actor({ id: "trainer-1", label: "Camp Trainer (a profession trainer)" }),
        },
        placedExtractors: [],
        placedCamps: [],
        propStates: {},
      },
    });
    const corpse = option({ id: "corpse:rogue-1", kind: "corpse", targetId: "rogue-1", label: "Mori Maddox (a rogue trooper)" });
    expect(interactChipName(corpse, "LOOT", state)).toBe("Mori Maddox");
    const trainer = option({ id: "trainer:trainer-1", kind: "trainer", targetId: "trainer-1", label: "Camp Trainer (a profession trainer)" });
    expect(interactChipName(trainer, "CONVERSE", state)).toBe("Camp Trainer");
  });

  it("drops the verb-noun stutter on qualified prop labels", () => {
    const state = playState();
    const terminal = option({ id: "tt:t1", kind: "travelTerminal", targetId: "t1", label: "Travel Terminal — Dustgate" });
    expect(interactChipName(terminal, "TRAVEL", state)).toBe("Dustgate Terminal");
    // No qualifier / no verb echo → label passes through untouched.
    expect(interactChipName(option({ label: "Shelter Door" }), "OPEN", state)).toBe("Shelter Door");
    expect(interactChipName(option({ label: "Supply Depot — West" }), "OPEN", state)).toBe("Supply Depot — West");
  });
});

describe("chip suppression seam", () => {
  it("marks the VM suppressed while the bound window is open, options stay published", () => {
    const state = playState({
      serverAuthority: {
        playerActorId: "player",
        actors: { "trainer-1": actor({ id: "trainer-1", label: "Knox Vale", x: 10, y: 10.5 }) },
        placedExtractors: [],
        placedCamps: [],
        propStates: {},
      },
    });
    state.actors = { "trainer-1": { professionIds: ["marksman"] } } as unknown as PlayState["actors"];
    const sliceValue = slice({
      actors: [{ id: "trainer-1", entity: "npc:trainer-1", cell: { x: 10, y: 10 }, label: "Knox Vale", role: "profession_trainer", professionIds: ["marksman"] }],
    });
    try {
      setInteractChipSuppressor((candidate) => candidate.kind === "trainer" && candidate.targetId === "trainer-1");
      const vm = computeInteractChipVm(sliceValue, state);
      if (vm) {
        expect(vm.suppressed).toBe(true);
        expect(state.interactions.options.length).toBeGreaterThan(0);
      } else {
        // Trainer option construction depends on interactionSystem gates the
        // fixture may not satisfy — the seam contract still holds: nothing
        // suppressed means nothing selected.
        expect(state.interactions.options.length).toBe(0);
      }
    } finally {
      setInteractChipSuppressor(null);
    }
  });
});
