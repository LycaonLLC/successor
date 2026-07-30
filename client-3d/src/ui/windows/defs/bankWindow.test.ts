// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPlayState,
  type PlayState,
  type ServerAuthorityActorState,
  type ServerAuthorityBankState,
  type SliceSnapshot,
} from "@successor/client/src/slice-core/gameState";
import type { ContextRadial } from "../contextRadial";
import { createWindowManager, type WindowManager } from "../windowManager";
import { BANK_DRAG_MIME, setActiveBankTerminal } from "../../inventory/bankLink";
import { createInventoryWindowDefinition } from "../../inventory/shell";
import { createLootWindowDefinition, LOOT_WINDOW_ID, setLootTarget } from "./lootWindow";
import { BANK_WINDOW_ID, createBankWindowDefinition } from "./bankWindow";

// The 3D thumbnail canvas needs a real WebGL context — stubbed here; the
// vault contract under test is DOM + command wire only.
vi.mock("../../inventory/modelRenderer", () => ({
  InventoryModelRenderer: {
    create: () => ({
      canvas: document.createElement("canvas"),
      setLayoutRects: vi.fn(),
      render: vi.fn(),
      paperDollAttachedEquipmentIds: () => [],
      slotModelAssetKey: () => null,
      dispose: vi.fn(),
    }),
  },
}));

const INVENTORY_STACK_MIME = "text/x-sc3d-inventory-stack";
const CARRIED_STACK_KEY = "player:field-pack:2001:0:11";

function fixtureSlice(): SliceSnapshot {
  return {
    schema: "successor.slice-core.v1",
    tick: 40,
    tickRateHz: 20,
    combatModel: "roll",
    grid: { cellSizePx: 32 },
    zone: { id: 1, name: "Open Desert", width: 40, height: 24, level: 0 },
    areas: [{ id: "desert", name: "Open Desert", kind: "overworld", width: 40, height: 24, level: 0 }],
    stateHash: "bank-window-fixture",
    camera: { followActor: "player", zoom: 1 },
    actors: [{
      id: "player",
      entity: "actor/player",
      areaId: "desert",
      label: "Depositor",
      role: "player",
      sprite: "adventurer-premium-male",
      poseSet: "walk",
      direction: "right",
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
    }, {
      id: "supply-cache-1",
      entity: "prop/loot-cache",
      areaId: "desert",
      label: "Supply Cache",
      kind: "loot_cache",
      cell: { x: 4, y: 4 },
      size: { w: 1, h: 1 },
      interactive: true,
      solid: true,
      visible: true,
    }],
    blockedCells: [],
    transitions: [],
    inventory: [],
    reservations: [],
    events: [],
  };
}

function fixtureBank(): ServerAuthorityBankState {
  return {
    credits: 2_500,
    items: [{
      container: "bank:player",
      stackId: "901",
      item: "Iron Ore",
      itemId: 2001,
      variantId: 0,
      quantity: 40,
      reserved: 0,
      available: 40,
    }],
    backupPresent: true,
    backupSavedTick: 0,
    backupSkillCount: 4,
    backupCost: 1000,
  };
}

interface Mounted {
  manager: WindowManager;
  state: PlayState;
  root: HTMLElement;
}

function buildState(slice: SliceSnapshot, patch: {
  bank?: ServerAuthorityBankState | null;
  playerX?: number;
  walletCredits?: number;
} = {}): PlayState {
  const state = createPlayState(slice);
  state.serverAuthority.playerActorId = "player";
  state.serverAuthority.snapshotTick = slice.tick;
  state.serverAuthority.actors.player = {
    id: "player",
    label: "Depositor",
    areaId: "desert",
    x: patch.playerX ?? 4.5,
    y: 5.5,
    direction: "right",
    lifeState: "alive",
    credits: patch.walletCredits ?? 5_000,
  } as ServerAuthorityActorState;
  state.serverAuthority.bank = patch.bank === undefined ? fixtureBank() : patch.bank;
  state.inventory = [{
    container: "player:field-pack",
    item: "Iron Ore",
    itemId: 2001,
    variantId: 0,
    quantity: 25,
    reserved: 0,
    available: 25,
    stackId: 11,
  }];
  return state;
}

function mountBank(patch: {
  bank?: ServerAuthorityBankState | null;
  playerX?: number;
  walletCredits?: number;
} = {}): Mounted {
  const slice = fixtureSlice();
  const state = buildState(slice, patch);
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const manager = createWindowManager({
    mount,
    state,
    slice,
    storageScope: `bank-window-${Math.random()}`,
  });
  manager.register(createBankWindowDefinition());
  setActiveBankTerminal("dustgate-bank-terminal");
  manager.open(BANK_WINDOW_ID);
  manager.update(0, 0);
  return { manager, state, root: manager.root };
}

function pendingCommands(state: PlayState): unknown[] {
  return state.authorityCommands.pending.map((envelope) => envelope.command);
}

/** Minimal DataTransfer stand-in — happy-dom has no drag-and-drop model. */
function fakeDataTransfer(data: Record<string, string>): DataTransfer {
  return {
    get types(): string[] {
      return Object.keys(data);
    },
    getData: (type: string) => data[type] ?? "",
    setData: (type: string, value: string) => {
      data[type] = value;
    },
    dropEffect: "none",
    effectAllowed: "all",
  } as unknown as DataTransfer;
}

function dispatchDrag(target: EventTarget, type: string, dt: DataTransfer): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dt });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  setActiveBankTerminal(null);
  document.body.textContent = "";
  localStorage.clear();
});

describe("bank vault grid transfers", () => {
  it("renders the vault as container slots and retrieves the full stack on double-click", () => {
    const { manager, state, root } = mountBank();
    const slot = root.querySelector<HTMLButtonElement>('.inv-slot[data-stack="901"]');
    expect(slot).not.toBeNull();
    slot!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(pendingCommands(state)).toEqual([{ BankRetrieveItem: { bank_stack_id: "901", quantity: 40 } }]);
    manager.dispose();
  });

  it("retrieves the full stack from Enter on the focused slot", () => {
    const { manager, state, root } = mountBank();
    const slot = root.querySelector<HTMLButtonElement>('.inv-slot[data-stack="901"]')!;
    slot.dispatchEvent(new KeyboardEvent("keydown", { code: "Enter", bubbles: true, cancelable: true }));
    expect(pendingCommands(state)).toEqual([{ BankRetrieveItem: { bank_stack_id: "901", quantity: 40 } }]);
    manager.dispose();
  });

  it("publishes the vault drag payload for the inventory window's retrieve intake", () => {
    const { manager, state, root } = mountBank();
    const slot = root.querySelector<HTMLButtonElement>('.inv-slot[data-stack="901"]')!;
    const data: Record<string, string> = {};
    dispatchDrag(slot, "dragstart", fakeDataTransfer(data));
    expect(JSON.parse(data[BANK_DRAG_MIME]!)).toEqual({ stackId: "901", quantity: 40, label: "Iron Ore" });
    expect(pendingCommands(state)).toEqual([]);
    manager.dispose();
  });

  it("deposits the full carried stack when an inventory stack drops onto the window", () => {
    const { manager, state, root } = mountBank();
    const bankRoot = root.querySelector<HTMLElement>(".scp-bank")!;
    const over = dispatchDrag(bankRoot, "dragover", fakeDataTransfer({ [INVENTORY_STACK_MIME]: CARRIED_STACK_KEY }));
    expect(over.defaultPrevented).toBe(true);
    dispatchDrag(bankRoot, "drop", fakeDataTransfer({ [INVENTORY_STACK_MIME]: CARRIED_STACK_KEY }));
    expect(pendingCommands(state)).toEqual([{ BankStoreItem: { source_stack_id: "11", quantity: 25 } }]);
    manager.dispose();
  });

  it("dispatches BankStoreItem from a REAL inventory-shell dragstart fed into the bank drop", () => {
    const slice = fixtureSlice();
    const state = buildState(slice);
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const manager = createWindowManager({
      mount,
      state,
      slice,
      storageScope: `bank-inv-${Math.random()}`,
    });
    const radial = { openFor: vi.fn(), close: vi.fn() } as unknown as ContextRadial;
    manager.register(createInventoryWindowDefinition({ radial }));
    manager.register(createBankWindowDefinition());
    setActiveBankTerminal("dustgate-bank-terminal");
    manager.open("inventory");
    manager.open(BANK_WINDOW_ID);
    manager.update(0, 0);

    const invSlot = manager.root.querySelector<HTMLButtonElement>(`.inv-root .inv-slot[data-key="${CARRIED_STACK_KEY}"]`);
    expect(invSlot).not.toBeNull();
    const data: Record<string, string> = {};
    const dt = fakeDataTransfer(data);
    dispatchDrag(invSlot!, "dragstart", dt);
    // The shell itself tags the stack key — no reliance on stackOps ordering.
    expect(data[INVENTORY_STACK_MIME]).toBe(CARRIED_STACK_KEY);
    dispatchDrag(manager.root.querySelector<HTMLElement>(".scp-bank")!, "drop", dt);
    expect(pendingCommands(state)).toEqual([{ BankStoreItem: { source_stack_id: "11", quantity: 25 } }]);
    manager.dispose();
  });

  it("refuses a dropped stack that is not a carried local stack", () => {
    const { manager, state, root } = mountBank();
    const bankRoot = root.querySelector<HTMLElement>(".scp-bank")!;
    dispatchDrag(bankRoot, "drop", fakeDataTransfer({ [INVENTORY_STACK_MIME]: "cache:supply-cache-1:2001:0:44" }));
    expect(pendingCommands(state)).toEqual([]);
    expect(root.querySelector('[data-ref="status"]')!.textContent).toBe("VAULT REFUSES THAT");
    manager.dispose();
  });
});

describe("bank window proximity", () => {
  it("shows link lost, locks slots, and blocks every transfer out of reach", () => {
    const { manager, state, root } = mountBank({ playerX: 20 });
    expect(root.querySelector('[data-ref="link"]')!.textContent).toBe("NO VAULT LINK");
    expect(root.querySelector('[data-ref="status"]')!.textContent).toBe("LINK LOST · RETURN TO TERMINAL");
    const slot = root.querySelector<HTMLButtonElement>('.inv-slot[data-stack="901"]')!;
    expect(slot.hasAttribute("data-locked")).toBe(true);
    expect(slot.draggable).toBe(false);
    slot.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    const bankRoot = root.querySelector<HTMLElement>(".scp-bank")!;
    dispatchDrag(bankRoot, "drop", fakeDataTransfer({ [INVENTORY_STACK_MIME]: CARRIED_STACK_KEY }));
    root.querySelector<HTMLButtonElement>('[data-ref="deposit"]')!.click();
    expect(pendingCommands(state)).toEqual([]);
    expect(root.querySelector<HTMLButtonElement>('[data-ref="deposit"]')!.disabled).toBe(true);
    manager.dispose();
  });

  it("refuses the drag-out gesture once the link dropped", () => {
    const { manager, root } = mountBank({ playerX: 20 });
    const slot = root.querySelector<HTMLButtonElement>('.inv-slot[data-stack="901"]')!;
    const data: Record<string, string> = {};
    const event = dispatchDrag(slot, "dragstart", fakeDataTransfer(data));
    expect(event.defaultPrevented).toBe(true);
    expect(data[BANK_DRAG_MIME]).toBeUndefined();
    manager.dispose();
  });
});

describe("bank window credits rail", () => {
  it("deposits and withdraws exact credit amounts", () => {
    const { manager, state, root } = mountBank();
    const amount = root.querySelector<HTMLInputElement>('[data-ref="amount"]')!;
    amount.value = "250";
    root.querySelector<HTMLButtonElement>('[data-ref="deposit"]')!.click();
    amount.value = "100";
    root.querySelector<HTMLButtonElement>('[data-ref="withdraw"]')!.click();
    expect(pendingCommands(state)).toEqual([
      { BankDepositCredits: { amount: 250 } },
      { BankWithdrawCredits: { amount: 100 } },
    ]);
    manager.dispose();
  });

  it("refuses a non-positive amount with the exact copy and no command", () => {
    const { manager, state, root } = mountBank();
    const amount = root.querySelector<HTMLInputElement>('[data-ref="amount"]')!;
    amount.value = "0";
    root.querySelector<HTMLButtonElement>('[data-ref="deposit"]')!.click();
    expect(state.authorityCommands.pending).toEqual([]);
    expect(root.querySelector('[data-ref="status"]')!.textContent).toBe("ENTER A POSITIVE AMOUNT");
    manager.dispose();
  });

  it("gates deposit on wallet funds and withdraw on vault funds", () => {
    const { manager, state, root } = mountBank({ walletCredits: 100 });
    const amount = root.querySelector<HTMLInputElement>('[data-ref="amount"]')!;
    amount.value = "101";
    root.querySelector<HTMLButtonElement>('[data-ref="deposit"]')!.click();
    expect(root.querySelector('[data-ref="status"]')!.textContent).toBe("INSUFFICIENT WALLET CREDITS");
    amount.value = "2501";
    root.querySelector<HTMLButtonElement>('[data-ref="withdraw"]')!.click();
    expect(root.querySelector('[data-ref="status"]')!.textContent).toBe("INSUFFICIENT VAULT CREDITS");
    expect(state.authorityCommands.pending).toEqual([]);
    manager.dispose();
  });
});

describe("bank window states", () => {
  it("shows the vault-empty well when the projection holds no stacks", () => {
    const { manager, root } = mountBank({ bank: { ...fixtureBank(), items: [] } });
    const empty = root.querySelector<HTMLElement>('[data-ref="empty"]')!;
    expect(empty.hidden).toBe(false);
    expect(root.querySelector('[data-ref="emptyText"]')!.textContent).toBe("VAULT EMPTY");
    manager.dispose();
  });

  it("scopes the empty overlay to the vault body so the credits rail stays clickable", () => {
    const { manager, state, root } = mountBank({ bank: { ...fixtureBank(), items: [] } });
    const empty = root.querySelector<HTMLElement>('[data-ref="empty"]')!;
    const vaultBody = root.querySelector<HTMLElement>('[data-ref="vaultBody"]')!;
    const credits = root.querySelector<HTMLElement>(".scp-bank-credits")!;
    const deposit = root.querySelector<HTMLButtonElement>('[data-ref="deposit"]')!;
    const withdraw = root.querySelector<HTMLButtonElement>('[data-ref="withdraw"]')!;
    const amount = root.querySelector<HTMLInputElement>('[data-ref="amount"]')!;

    expect(vaultBody).not.toBeNull();
    expect(empty.hidden).toBe(false);
    // Structural contract: empty lives inside the vault well, never the action rail.
    expect(vaultBody.contains(empty)).toBe(true);
    expect(vaultBody.contains(root.querySelector('[data-ref="grid"]')!)).toBe(true);
    expect(vaultBody.contains(credits)).toBe(false);
    expect(vaultBody.contains(deposit)).toBe(false);
    expect(vaultBody.contains(withdraw)).toBe(false);
    expect(vaultBody.contains(amount)).toBe(false);
    expect(empty.contains(deposit)).toBe(false);
    expect(credits.contains(empty)).toBe(false);
    expect(empty.closest(".scp-bank-credits")).toBeNull();
    expect(deposit.closest('[data-ref="vaultBody"]')).toBeNull();

    // Live linked empty vault keeps credit controls enabled; normal click deposits.
    expect(deposit.disabled).toBe(false);
    expect(withdraw.disabled).toBe(false);
    expect(amount.disabled).toBe(false);
    amount.value = "250";
    deposit.click();
    expect(pendingCommands(state)).toEqual([{ BankDepositCredits: { amount: 250 } }]);
    manager.dispose();
  });

  it("renders the linking state while the bank projection has not streamed", () => {
    const { manager, root } = mountBank({ bank: null });
    expect(root.querySelector('[data-ref="link"]')!.textContent).toBe("LINKING VAULT…");
    expect(root.querySelector('[data-ref="status"]')!.textContent).toBe("LINKING VAULT…");
    expect(root.querySelector<HTMLButtonElement>('[data-ref="deposit"]')!.disabled).toBe(true);
    manager.dispose();
  });

  it("flashes authority rejects for bank commands through the receipt watcher", () => {
    const { manager, state, root } = mountBank();
    state.serverAuthority.sentCommandLog.push({ commandId: 7, kind: "BankStoreItem", sentAtMs: 0 });
    state.serverAuthority.lastReceipt = { commandId: 7, accepted: false, tick: 41, reasonCode: "bank_full", receivedAtMs: 0 };
    manager.update(0, 16);
    expect(root.querySelector('[data-ref="status"]')!.textContent).toBe("DENIED · BANK FULL");
    manager.dispose();
  });

  it("gives every vault slot an accessible name with noun, quantity, and action", () => {
    const { manager, root } = mountBank();
    const slot = root.querySelector<HTMLButtonElement>('.inv-slot[data-stack="901"]')!;
    expect(slot.getAttribute("aria-label"))
      .toBe("Iron Ore, 40 in vault — press Enter to retrieve the full stack");
    manager.dispose();
  });

  it("switches the slot accessible name to link lost once out of reach", () => {
    const { manager, root } = mountBank({ playerX: 20 });
    const slot = root.querySelector<HTMLButtonElement>('.inv-slot[data-stack="901"]')!;
    expect(slot.getAttribute("aria-label"))
      .toBe("Iron Ore, 40 in vault — link lost, transfers disabled");
    manager.dispose();
  });

  it("uses real inline SVG glyphs, never text-symbol placeholders", () => {
    const { manager, root } = mountBank();
    const glyphs = [...root.querySelectorAll<HTMLElement>(".scp-bank-plate-glyph")];
    expect(glyphs.length).toBeGreaterThan(0);
    for (const glyph of glyphs) {
      expect(glyph.querySelector("svg")).not.toBeNull();
      expect(glyph.textContent?.trim()).toBe("");
    }
    manager.dispose();
  });
});

describe("loot windows stay take-only", () => {
  it("never accepts a carried-stack drop — no dragover accept, no command", () => {
    const slice = fixtureSlice();
    const state = buildState(slice);
    state.inventory.push({
      container: "cache:supply-cache-1",
      item: "Scrap Plate",
      itemId: 2002,
      variantId: 0,
      quantity: 3,
      reserved: 0,
      available: 3,
      stackId: 44,
    });
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const manager = createWindowManager({
      mount,
      state,
      slice,
      storageScope: `loot-window-${Math.random()}`,
    });
    const radial = { openFor: vi.fn(), close: vi.fn() } as unknown as ContextRadial;
    manager.register(createLootWindowDefinition({ radial }));
    setLootTarget({ kind: "cache", id: "supply-cache-1" });
    manager.open(LOOT_WINDOW_ID);
    manager.update(0, 0);

    const lootRoot = manager.root.querySelector<HTMLElement>(".dwl-root:not(.scp-bank)")!;
    const grid = manager.root.querySelector<HTMLElement>(".dwl-grid")!;
    expect(grid.querySelector(".inv-slot")).not.toBeNull();
    for (const target of [lootRoot, grid]) {
      const over = dispatchDrag(target, "dragover", fakeDataTransfer({ [INVENTORY_STACK_MIME]: CARRIED_STACK_KEY }));
      expect(over.defaultPrevented).toBe(false);
      dispatchDrag(target, "drop", fakeDataTransfer({ [INVENTORY_STACK_MIME]: CARRIED_STACK_KEY }));
    }
    expect(pendingCommands(state)).toEqual([]);
    manager.dispose();
  });
});
