import type { SfxPlayer } from "@successor/client/src/audio/sfx";
import {
  createPlayState,
  type PlayState,
  type SliceSnapshot,
} from "@successor/client/src/slice-core/gameState";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  activeLootHold,
  cancelLootHold,
  HOLD_TO_TAKE_ALL_MS,
} from "../../overlay/lootHold";
import { LOOT_WINDOW_ID } from "../windows/defs/lootWindow";
import { mountInteractPrompt } from "./interactPrompt";

vi.mock("../windows/defs/lootWindow", () => ({
  LOOT_WINDOW_ID: "loot",
  setLootTarget: vi.fn(),
}));

vi.mock("../dialogue/converseWindow", () => ({
  CONVERSE_WINDOW_ID: "converse",
  setConverseTarget: vi.fn(),
}));

function lootSlice(): SliceSnapshot {
  return {
    schema: "fixture",
    tick: 90,
    tickRateHz: 30,
    combatModel: "roll",
    grid: { cellSizePx: 60 },
    zone: { id: 1, name: "Loot Test", width: 24, height: 24, level: 0 },
    areas: [{ id: "open-desert-overworld", name: "Loot Test", kind: "overworld", width: 24, height: 24, level: 0 }],
    stateHash: "interact-prompt-loot-test",
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
    props: [{
      id: "supply-cache",
      entity: "container:supply-cache",
      areaId: "open-desert-overworld",
      label: "Supply Cache",
      kind: "storage_chest",
      cell: { x: 10, y: 10 },
      size: { w: 1, h: 1 },
      interactive: true,
      solid: false,
    }],
    blockedCells: [],
    transitions: [],
    inventory: [
      {
        container: "cache:supply-cache",
        item: "Iron Slug",
        itemId: 1101,
        variantId: 0,
        quantity: 37,
        reserved: 0,
        available: 37,
      },
      {
        container: "cache:supply-cache",
        item: "Stimpak A",
        itemId: 1001,
        variantId: 0,
        quantity: 2,
        reserved: 0,
        available: 2,
      },
    ],
    reservations: [],
    events: [],
  };
}

function createHarness(): {
  state: PlayState;
  openWindow: ReturnType<typeof vi.fn>;
  controller: ReturnType<typeof mountInteractPrompt>;
} {
  const slice = lootSlice();
  const state = createPlayState(slice, "player");
  const openWindow = vi.fn();
  const sfx = { play: vi.fn() } as unknown as SfxPlayer;
  const controller = mountInteractPrompt({} as HTMLElement, state, slice, {
    openWindow,
    openBankTerminal: vi.fn(),
    openFactoryTerminal: vi.fn(),
    openCloneTerminal: vi.fn(),
    openPaTerminal: vi.fn(),
    sfx,
  });
  return { state, openWindow, controller };
}

afterEach(() => {
  cancelLootHold();
  vi.restoreAllMocks();
});

describe("interact prompt loot hold release", () => {
  it("takes every stack on threshold release without a tick or loot window", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(10_000);
    const { state, openWindow, controller } = createHarness();

    expect(controller.performSelected()).toBe(true);
    clock.mockReturnValue(10_000 + HOLD_TO_TAKE_ALL_MS);

    // Deliberately release without calling controller.tick(): a low-frame gap
    // must still classify the completed hold as TAKE ALL rather than a tap.
    controller.releaseSelected();

    expect(state.authorityCommands.pending.map((entry) => entry.command)).toEqual([
      {
        TakeLootItem: {
          container: "cache:supply-cache",
          itemId: 1101,
          variantId: 0,
          quantity: 37,
        },
      },
      {
        TakeLootItem: {
          container: "cache:supply-cache",
          itemId: 1001,
          variantId: 0,
          quantity: 2,
        },
      },
    ]);
    expect(openWindow).not.toHaveBeenCalled();
    expect(activeLootHold()).toBeNull();
  });

  it("opens the loot window for a short tap and takes nothing", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(20_000);
    const { state, openWindow, controller } = createHarness();

    expect(controller.performSelected()).toBe(true);
    clock.mockReturnValue(20_000 + HOLD_TO_TAKE_ALL_MS - 1);
    controller.releaseSelected();

    expect(state.authorityCommands.pending).toHaveLength(0);
    expect(openWindow).toHaveBeenCalledOnce();
    expect(openWindow).toHaveBeenCalledWith(LOOT_WINDOW_ID);
    expect(activeLootHold()).toBeNull();
  });
});

describe("interact prompt terminal dispatch", () => {
  it.each([
    ["bank_terminal", "dustgate-bank-terminal", "bank"],
    ["clone_terminal", "dustgate-clone-terminal", "clone"],
    ["pa_terminal", "dustgate-pa-terminal", "pa"],
  ] as const)("opens the %s window through F", (kind, propId, expected) => {
    const slice = lootSlice();
    slice.inventory = [];
    slice.props = [{
      id: propId,
      entity: `prop/${kind}`,
      areaId: "open-desert-overworld",
      label: expected === "bank" ? "Bank Terminal" : expected === "clone" ? "Clone Terminal" : "PA Terminal",
      kind,
      cell: { x: 10, y: 10 },
      size: { w: 1, h: 1 },
      interactive: true,
      solid: false,
    }];
    const state = createPlayState(slice, "player");
    const openBankTerminal = vi.fn();
    const openCloneTerminal = vi.fn();
    const openPaTerminal = vi.fn();
    const controller = mountInteractPrompt({} as HTMLElement, state, slice, {
      openWindow: vi.fn(),
      openBankTerminal,
      openCloneTerminal,
      openPaTerminal,
      openFactoryTerminal: vi.fn(),
      sfx: { play: vi.fn() } as unknown as SfxPlayer,
    });

    expect(controller.performSelected()).toBe(true);
    const calls: Record<string, Mock> = { bank: openBankTerminal, clone: openCloneTerminal, pa: openPaTerminal };
    for (const [name, fn] of Object.entries(calls)) {
      if (name === expected) expect(fn).toHaveBeenCalledWith(propId);
      else expect(fn).not.toHaveBeenCalled();
    }
    controller.dispose();
  });

  it("routes a trade_terminal kiosk through the existing exchange path (datapad window)", () => {
    const slice = lootSlice();
    slice.inventory = [];
    slice.props = [{
      id: "commerce-trade-terminal",
      entity: "prop/trade_terminal",
      areaId: "open-desert-overworld",
      label: "Trade Terminal",
      kind: "trade_terminal",
      cell: { x: 10, y: 10 },
      size: { w: 1, h: 1 },
      interactive: true,
      solid: false,
    }];
    const state = createPlayState(slice, "player");
    const openWindow = vi.fn();
    const controller = mountInteractPrompt({} as HTMLElement, state, slice, {
      openWindow,
      openBankTerminal: vi.fn(),
      openFactoryTerminal: vi.fn(),
      openCloneTerminal: vi.fn(),
      openPaTerminal: vi.fn(),
      sfx: { play: vi.fn() } as unknown as SfxPlayer,
    });

    expect(state.interactions.options).toEqual([]);
    expect(controller.performSelected()).toBe(true);
    expect(state.interactions.options[0]?.kind).toBe("exchange");
    expect(openWindow).toHaveBeenCalledWith("datapad");
    controller.dispose();
  });
});
