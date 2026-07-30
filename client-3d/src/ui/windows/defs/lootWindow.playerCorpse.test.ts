// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPlayState,
  type PlayState,
  type ServerAuthorityActorState,
  type ServerAuthorityPlayerCorpseState,
  type SliceSnapshot,
} from "@successor/client/src/slice-core/gameState";
import type { ContextRadial } from "../contextRadial";
import { createWindowManager, type WindowManager } from "../windowManager";
import { createLootWindowDefinition, LOOT_WINDOW_ID, setLootTarget } from "./lootWindow";

// The 3D thumbnail canvas needs a real WebGL context — stubbed here; the
// corpse contract under test is DOM + command wire only.
vi.mock("../../inventory/modelRenderer", () => ({
  InventoryModelRenderer: {
    create: () => ({
      canvas: document.createElement("canvas"),
      setLayoutRects: vi.fn(),
      render: vi.fn(),
      dispose: vi.fn(),
    }),
  },
}));

const CORPSE_ID = "player-corpse:7";

function fixtureSlice(): SliceSnapshot {
  return {
    schema: "successor.slice-core.v1",
    tick: 40,
    tickRateHz: 20,
    combatModel: "roll",
    grid: { cellSizePx: 32 },
    zone: { id: 1, name: "Open Desert", width: 40, height: 24, level: 0 },
    areas: [{ id: "desert", name: "Open Desert", kind: "overworld", width: 40, height: 24, level: 0 }],
    stateHash: "player-corpse-loot-fixture",
    camera: { followActor: "player", zoom: 1 },
    actors: [{
      id: "player",
      entity: "actor/player",
      areaId: "desert",
      label: "Salvager",
      role: "player",
      sprite: "adventurer-premium-male",
      poseSet: "walk",
      direction: "right",
      cell: { x: 4, y: 5 },
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

function fixtureCorpse(patch: Partial<ServerAuthorityPlayerCorpseState> = {}): ServerAuthorityPlayerCorpseState {
  return {
    id: CORPSE_ID,
    ownerLabel: "Ashen Vek",
    areaId: "desert",
    cellX: 4,
    cellY: 5,
    x: 4.2,
    y: 5.1,
    expiryTick: 144_040,
    hasItems: true,
    creditsPresent: true,
    creditsCount: 230,
    isOwner: false,
    container: `corpse:${CORPSE_ID}`,
    ...patch,
  };
}

const radialStub = { openFor: vi.fn(), close: vi.fn() } as unknown as ContextRadial;

function mountLoot(corpses: ServerAuthorityPlayerCorpseState[]): { manager: WindowManager; state: PlayState; root: HTMLElement } {
  const slice = fixtureSlice();
  const state = createPlayState(slice);
  state.serverAuthority.playerActorId = "player";
  state.serverAuthority.snapshotTick = slice.tick;
  state.serverAuthority.actors.player = {
    id: "player",
    label: "Salvager",
    areaId: "desert",
    x: 4.5,
    y: 5.5,
    direction: "right",
    lifeState: "alive",
  } as ServerAuthorityActorState;
  state.serverAuthority.playerCorpses = corpses;
  state.inventory = [{
    container: `corpse:${CORPSE_ID}`,
    item: "Field Bandage",
    itemId: 1002,
    variantId: 0,
    quantity: 3,
    reserved: 0,
    available: 3,
    stackId: 21,
  }];
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const manager = createWindowManager({
    mount,
    state,
    slice,
    storageScope: `loot-player-corpse-${Math.random()}`,
  });
  manager.register(createLootWindowDefinition({ radial: radialStub }));
  setLootTarget({ kind: "playerCorpse", id: CORPSE_ID });
  manager.open(LOOT_WINDOW_ID);
  manager.update(0, 0);
  return { manager, state, root: manager.root };
}

afterEach(() => {
  document.body.textContent = "";
  localStorage.clear();
});

describe("loot window player-corpse integration", () => {
  it("takes a corpse stack from the public container corpse:<id> via TakeLootItem", () => {
    const { manager, state, root } = mountLoot([fixtureCorpse()]);
    const slot = root.querySelector<HTMLButtonElement>(".inv-slot")!;
    expect(slot).not.toBeNull();
    slot.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(state.authorityCommands.pending.map((envelope) => envelope.command)).toEqual([{
      TakeLootItem: { container: `corpse:${CORPSE_ID}`, itemId: 1002, variantId: 0, quantity: 3 },
    }]);
    manager.dispose();
  });

  it("exposes the explicit TAKE CREDITS action and queues CorpseTakeCredits", () => {
    const { manager, state, root } = mountLoot([fixtureCorpse()]);
    const takeCredits = root.querySelector<HTMLButtonElement>('[data-ref="takeCredits"]')!;
    expect(takeCredits.hidden).toBe(false);
    expect(takeCredits.disabled).toBe(false);
    takeCredits.click();
    expect(state.authorityCommands.pending.map((envelope) => envelope.command)).toEqual([
      { CorpseTakeCredits: { corpse_id: CORPSE_ID } },
    ]);
    manager.dispose();
  });

  it("hides the credits verb once the bag holds none", () => {
    const { manager, root } = mountLoot([fixtureCorpse({ creditsPresent: false, creditsCount: 0 })]);
    expect(root.querySelector<HTMLButtonElement>('[data-ref="takeCredits"]')!.hidden).toBe(true);
    manager.dispose();
  });

  it("reads the owner label and open public salvage rights", () => {
    const { manager, root } = mountLoot([fixtureCorpse()]);
    expect(root.querySelector('[data-ref="name"]')!.textContent).toBe("ASHEN VEK — REMAINS");
    expect(root.querySelector('[data-ref="rights"]')!.textContent).toBe("OPEN SALVAGE");
    expect(root.querySelector('[data-ref="decay"]')!.textContent).toMatch(/^FADES \d+:\d{2}$/);
    manager.dispose();
  });

  it("drops to TARGET LOST when the corpse row leaves the AOI stream", () => {
    const { manager, state, root } = mountLoot([fixtureCorpse()]);
    state.serverAuthority.playerCorpses = [];
    manager.update(0, 16);
    expect(root.querySelector('[data-ref="emptyText"]')!.textContent).toBe("TARGET LOST");
    const takeCredits = root.querySelector<HTMLButtonElement>('[data-ref="takeCredits"]')!;
    takeCredits.click();
    expect(state.authorityCommands.pending).toEqual([]);
    manager.dispose();
  });
});
