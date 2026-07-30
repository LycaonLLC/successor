// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { directions } from "@successor/client/src/slice-core/geometry";
import {
  createPlayState,
  type InventoryRow,
  type PlayState,
  type ServerAuthorityActorState,
  type SliceSnapshot,
} from "@successor/client/src/slice-core/gameState";
import type { WindowContentHandle, WindowContext } from "../windows/windowManager";
import type { ContextRadial } from "../windows/contextRadial";
import { BANK_DRAG_MIME, setActiveBankTerminal } from "./bankLink";
import { createInventoryWindowDefinition, inventoryEquipFlashStatus } from "./shell";

// The ledger contract under test is pure DOM — the 3D turntable is a seam.
vi.mock("./modelRenderer", () => ({
  InventoryModelRenderer: {
    create: () => ({
      canvas: document.createElement("canvas"),
      setLayoutRects: () => {},
      render: () => {},
      paperDollAttachedEquipmentIds: () => [],
      dispose: () => {},
    }),
  },
}));

function inventorySlice(inventory: InventoryRow[]): SliceSnapshot {
  return {
    schema: "successor.slice-core.v1",
    tick: 12,
    tickRateHz: 20,
    combatModel: "roll",
    grid: { cellSizePx: 32 },
    zone: { id: 1, name: "Open Desert", width: 20, height: 12, level: 0 },
    areas: [{ id: "desert", name: "Open Desert", kind: "overworld", width: 20, height: 12, level: 0 }],
    stateHash: "inventory-shell-fixture",
    camera: { followActor: "player", zoom: 1 },
    actors: [{
      id: "player",
      entity: "actor/player",
      areaId: "desert",
      label: "Field Observer",
      role: "player",
      sprite: "adventurer-premium-male",
      poseSet: "walk",
      direction: "left",
      cell: { x: 4, y: 5 },
      route: [],
    }],
    props: [{
      id: "dustgate-bank-terminal",
      entity: "prop/bank-terminal",
      areaId: "desert",
      label: "Bank Terminal",
      kind: "bank_terminal",
      cell: { x: 5, y: 5 },
      size: { w: 1, h: 1 },
      interactive: true,
      solid: true,
      visible: true,
    }],
    blockedCells: [],
    transitions: [],
    inventory,
    reservations: [],
    events: [],
  };
}

describe("inventory equip feedback", () => {
  it("reports authority weapon changes as requests until snapshots settle them", () => {
    expect(inventoryEquipFlashStatus("Lightning Carbine", false, "equipped"))
      .toBe("Lightning Carbine · EQUIP REQUESTED");
    expect(inventoryEquipFlashStatus("Lightning Carbine", false, "unequipped"))
      .toBe("Lightning Carbine · UNEQUIP REQUESTED");
  });

  it("reports local wardrobe changes as committed immediately", () => {
    expect(inventoryEquipFlashStatus("Field Jacket", true, "equipped"))
      .toBe("Field Jacket · EQUIPPED");
    expect(inventoryEquipFlashStatus("Field Jacket", true, "unequipped"))
      .toBe("Field Jacket · UNEQUIPPED");
  });
});

describe("inventory ledger resource description", () => {
  it("keeps the purpose copy visible next to the taxonomy for resources", () => {
    const slice = inventorySlice([{
      container: "player:field-pack",
      item: "Iron Ore",
      itemId: 2001,
      variantId: 0,
      quantity: 80,
      reserved: 0,
      available: 80,
      stackId: 11,
    }]);
    const state = createPlayState(slice, "player");
    state.serverAuthority.playerActorId = "player";
    const ctx: WindowContext = { state, slice } as WindowContext;
    const radial = { close: () => {}, openFor: () => {} } as unknown as ContextRadial;
    const contentRoot = document.createElement("div");
    document.body.appendChild(contentRoot);
    const handle = createInventoryWindowDefinition({ radial }).mount(contentRoot, ctx);

    handle.update(0.016, 0);
    const slot = contentRoot.querySelector<HTMLButtonElement>(".inv-slot");
    expect(slot).not.toBeNull();
    slot!.click();
    handle.update(0.016, 16);

    const desc = contentRoot.querySelector('[data-ref="desc"]')!.textContent;
    // Taxonomy leads, the itemCopy PURPOSE line survives — no duplication.
    expect(desc).toBe("INORGANIC · MINERAL · METAL · IRON · Raw iron. Crafting metal: sampler rigs, casings, slugs");

    handle.dispose();
    contentRoot.remove();
  });
});

describe("inventory bank-session gestures", () => {
  const CHIP_ROW: InventoryRow = {
    container: "player:field-pack",
    item: "Credit Chip",
    itemId: 9002,
    variantId: 0,
    quantity: 600,
    reserved: 0,
    available: 600,
    stackId: 12,
  };

  afterEach(() => {
    setActiveBankTerminal(null);
    document.body.textContent = "";
  });

  function mountWithBank(playerX: number, vaultAvailable = 0): {
    handle: WindowContentHandle;
    state: PlayState;
    contentRoot: HTMLElement;
  } {
    const slice = inventorySlice([{ ...CHIP_ROW }]);
    const state = createPlayState(slice, "player");
    state.serverAuthority.playerActorId = "player";
    state.serverAuthority.actors.player = {
      id: "player",
      label: "Depositor",
      areaId: "desert",
      x: playerX,
      y: 5.5,
      direction: "right",
      lifeState: "alive",
      credits: 1_000,
    } as ServerAuthorityActorState;
    state.serverAuthority.bank = {
      credits: 0,
      items: vaultAvailable > 0 ? [{
        container: "bank:player",
        stackId: "901",
        item: "Iron Ore",
        itemId: 2001,
        variantId: 0,
        quantity: vaultAvailable,
        reserved: 0,
        available: vaultAvailable,
      }] : [],
      backupPresent: false,
      backupSavedTick: null,
      backupSkillCount: 0,
      backupCost: 1000,
    };
    const ctx: WindowContext = { state, slice } as WindowContext;
    const radial = { close: () => {}, openFor: () => {} } as unknown as ContextRadial;
    const contentRoot = document.createElement("div");
    document.body.appendChild(contentRoot);
    const handle = createInventoryWindowDefinition({ radial }).mount(contentRoot, ctx);
    handle.update(0.016, 0);
    return { handle, state, contentRoot };
  }

  function pendingCommands(state: PlayState): unknown[] {
    return state.authorityCommands.pending.map((envelope) => envelope.command);
  }

  it("double-click deposits the full stack instead of the normal primary action", () => {
    setActiveBankTerminal("dustgate-bank-terminal");
    const { handle, state, contentRoot } = mountWithBank(4.5);
    const slot = contentRoot.querySelector<HTMLButtonElement>(".inv-slot")!;
    slot.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    // Chip's normal primary is REDEEM — the live vault session overrides it.
    expect(pendingCommands(state)).toEqual([{ BankStoreItem: { source_stack_id: "12", quantity: 600 } }]);
    handle.dispose();
  });

  it("double-click denies with link lost once the terminal is out of reach", () => {
    setActiveBankTerminal("dustgate-bank-terminal");
    const { handle, state, contentRoot } = mountWithBank(15);
    const slot = contentRoot.querySelector<HTMLButtonElement>(".inv-slot")!;
    slot.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(pendingCommands(state)).toEqual([]);
    expect(contentRoot.querySelector('[data-ref="status"]')!.textContent)
      .toBe("LINK LOST · RETURN TO TERMINAL");
    handle.dispose();
  });

  it("double-click keeps the normal primary action with no bank session", () => {
    const { handle, state, contentRoot } = mountWithBank(4.5);
    const slot = contentRoot.querySelector<HTMLButtonElement>(".inv-slot")!;
    slot.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const pending = pendingCommands(state) as Record<string, unknown>[];
    expect(pending).toHaveLength(1);
    expect(Object.keys(pending[0]!)).toEqual(["RedeemCreditChip"]);
    handle.dispose();
  });

  it("retrieves a dropped vault tile through the bank drag payload", () => {
    setActiveBankTerminal("dustgate-bank-terminal");
    const { handle, state, contentRoot } = mountWithBank(4.5, 40);
    const root = contentRoot.querySelector<HTMLElement>(".inv-root")!;
    const payload = JSON.stringify({ stackId: "901", quantity: 40, label: "Iron Ore" });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: {
        types: [BANK_DRAG_MIME],
        getData: (type: string) => (type === BANK_DRAG_MIME ? payload : ""),
      },
    });
    root.dispatchEvent(drop);
    expect(pendingCommands(state)).toEqual([{ BankRetrieveItem: { bank_stack_id: "901", quantity: 40 } }]);
    handle.dispose();
  });

  it("retrieves the LIVE vault quantity when the projection shrank after dragstart", () => {
    setActiveBankTerminal("dustgate-bank-terminal");
    // Dragstart snapshot said 40; the authority delta since then left 25.
    const { handle, state, contentRoot } = mountWithBank(4.5, 25);
    const root = contentRoot.querySelector<HTMLElement>(".inv-root")!;
    const payload = JSON.stringify({ stackId: "901", quantity: 40, label: "Iron Ore" });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: {
        types: [BANK_DRAG_MIME],
        getData: (type: string) => (type === BANK_DRAG_MIME ? payload : ""),
      },
    });
    root.dispatchEvent(drop);
    expect(pendingCommands(state)).toEqual([{ BankRetrieveItem: { bank_stack_id: "901", quantity: 25 } }]);
    handle.dispose();
  });

  it("aborts the retrieve drop when the vault stack vanished after dragstart", () => {
    setActiveBankTerminal("dustgate-bank-terminal");
    const { handle, state, contentRoot } = mountWithBank(4.5, 0);
    const root = contentRoot.querySelector<HTMLElement>(".inv-root")!;
    const payload = JSON.stringify({ stackId: "901", quantity: 40, label: "Iron Ore" });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: {
        types: [BANK_DRAG_MIME],
        getData: (type: string) => (type === BANK_DRAG_MIME ? payload : ""),
      },
    });
    root.dispatchEvent(drop);
    expect(pendingCommands(state)).toEqual([]);
    expect(contentRoot.querySelector('[data-ref="status"]')!.textContent).toBe("STACK GONE");
    handle.dispose();
  });

  it("rejects a vault drop once the terminal is out of reach", () => {
    setActiveBankTerminal("dustgate-bank-terminal");
    const { handle, state, contentRoot } = mountWithBank(15);
    const root = contentRoot.querySelector<HTMLElement>(".inv-root")!;
    const payload = JSON.stringify({ stackId: "901", quantity: 40, label: "Iron Ore" });
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: {
        types: [BANK_DRAG_MIME],
        getData: (type: string) => (type === BANK_DRAG_MIME ? payload : ""),
      },
    });
    root.dispatchEvent(drop);
    expect(pendingCommands(state)).toEqual([]);
    expect(contentRoot.querySelector('[data-ref="status"]')!.textContent)
      .toBe("LINK LOST · RETURN TO TERMINAL");
    handle.dispose();
  });
});
