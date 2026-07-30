// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { directions } from "@successor/client/src/slice-core/geometry";
import {
  createPlayState,
  type InventoryRow,
  type PlayState,
  type SliceSnapshot,
} from "@successor/client/src/slice-core/gameState";
import type { InventoryItemVM } from "./types";
import {
  DISCARD_ARM_MS,
  installStackOps,
  stackDiscardEligibility,
  stackMergeValidity,
  type StackOpsHandle,
} from "./stackOps";

type RowPatch = Omit<Partial<InventoryItemVM["row"]>, "variantId"> & {
  variantId?: unknown;
};

type ItemPatch = Omit<Partial<InventoryItemVM>, "key" | "row"> & {
  key: string;
  row?: RowPatch;
};

function item(patch: ItemPatch): InventoryItemVM {
  const itemId = patch.itemId ?? 2102;
  const variantId = patch.row?.variantId ?? 27;
  const row = {
    container: "player:field-pack",
    item: patch.label ?? "Duskback Clodmeat",
    itemId,
    variantId,
    quantity: 1,
    reserved: 0,
    available: 1,
    stackId: 1,
    ...patch.row,
  } as InventoryItemVM["row"];
  return {
    key: patch.key,
    itemId,
    label: patch.label ?? "Duskback Clodmeat",
    description: patch.description ?? "",
    category: patch.category ?? "resource",
    count: patch.count ?? 1,
    equipped: patch.equipped ?? false,
    glb: patch.glb ?? "/assets/world-items/supply_cache.glb",
    resource: patch.resource ?? null,
    local: patch.local ?? false,
    equipmentId: patch.equipmentId ?? null,
    row,
  };
}

describe("stackMergeValidity", () => {
  it.each([
    ["valid", item({ key: "source", row: { stackId: 1, variantId: 27 } }), item({ key: "target", row: { stackId: 2, variantId: 27 } }), "valid"],
    ["rejects different variants", item({ key: "source", row: { stackId: 1, variantId: 27 } }), item({ key: "target", row: { stackId: 2, variantId: 28 } }), "variant-mismatch"],
    ["accepts identical string variant ids", item({ key: "source", row: { stackId: 1, variantId: "clodmeat-w27-a" } }), item({ key: "target", row: { stackId: 2, variantId: "clodmeat-w27-a" } }), "valid"],
    ["rejects different item ids", item({ key: "source", itemId: 2102, row: { stackId: 1, variantId: 27 } }), item({ key: "target", itemId: 2103, row: { stackId: 2, variantId: 27 } }), "item-mismatch"],
    ["rejects cross-container drops", item({ key: "source", row: { stackId: 1, variantId: 27 } }), item({ key: "target", row: { container: "cache:open-desert-cache-01", stackId: 2, variantId: 27 } }), "container-mismatch"],
    ["rejects same stack", item({ key: "source", row: { stackId: 1, variantId: 27 } }), item({ key: "source", row: { stackId: 1, variantId: 27 } }), "same-stack"],
    ["rejects rows without server stack ids", item({ key: "source", row: { stackId: undefined, variantId: 27 } }), item({ key: "target", row: { stackId: 2, variantId: 27 } }), "missing-stack"],
  ] as const)("%s", (_name, source, target, expected) => {
    expect(stackMergeValidity(source, target)).toBe(expected);
  });
});

describe("stackDiscardEligibility", () => {
  const owned = (container: string) => container === "player:field-pack";

  it.each([
    ["owned server-backed stack", item({ key: "a", row: { stackId: 11 } }), "valid"],
    ["synthetic local gear", item({ key: "b", local: true, row: { stackId: 11 } }), "synthetic-gear"],
    ["row without stack identity", item({ key: "c", row: { stackId: undefined } }), "missing-stack"],
    ["foreign container", item({ key: "d", row: { container: "rogue:field-pack", stackId: 11 } }), "not-owned"],
    ["equipped item", item({ key: "e", category: "weapon", equipped: true, row: { stackId: 11 } }), "equipped"],
    ["reserved quantity", item({ key: "f", row: { stackId: 11, quantity: 10, reserved: 3, available: 7 } }), "reserved"],
    ["partly unavailable stack", item({ key: "g", row: { stackId: 11, quantity: 10, reserved: 0, available: 9 } }), "reserved"],
  ] as const)("%s", (_name, vm, expected) => {
    expect(stackDiscardEligibility(vm, owned)).toBe(expected);
  });

  it("refuses a missing item", () => {
    expect(stackDiscardEligibility(null, owned)).toBe("missing-item");
  });
});

function discardSlice(inventory: InventoryRow[]): SliceSnapshot {
  return {
    schema: "successor.slice-core.v1",
    tick: 12,
    tickRateHz: 20,
    combatModel: "roll",
    grid: { cellSizePx: 32 },
    zone: { id: 1, name: "Open Desert", width: 20, height: 12, level: 0 },
    areas: [{ id: "desert", name: "Open Desert", kind: "overworld", width: 20, height: 12, level: 0 }],
    stateHash: "stack-ops-discard-fixture",
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
    props: [],
    blockedCells: [],
    transitions: [],
    inventory,
    reservations: [],
    events: [],
  };
}

describe("two-step DISCARD", () => {
  const IRON_KEY = "player:field-pack:2001:210218";
  const ironVm = () => item({
    key: IRON_KEY,
    itemId: 2001,
    label: "Iron Ore",
    row: { container: "player:field-pack", itemId: 2001, stackId: 11, variantId: 210_218, quantity: 80, available: 80 },
  });

  interface DiscardHarness {
    state: PlayState;
    ops: StackOpsHandle;
    messages: string[];
  }

  const harness = (vm: InventoryItemVM | null): DiscardHarness => {
    const slice = discardSlice([]);
    const state = createPlayState(slice, "player");
    state.serverAuthority.playerActorId = "player";
    const root = document.createElement("div");
    const grid = document.createElement("div");
    root.appendChild(grid);
    document.body.appendChild(root);
    const messages: string[] = [];
    const ops = installStackOps({
      root,
      grid,
      state,
      slice,
      findItem: (key) => (vm && key === vm.key ? vm : null),
      flashStatus: (message) => messages.push(message),
    });
    return { state, ops, messages };
  };

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.textContent = "";
  });

  it("arms on the first activation, names the exact stack, and enqueues nothing", () => {
    const vm = ironVm();
    const { state, ops, messages } = harness(vm);
    expect(ops.discardEligible(vm)).toBe(true);
    ops.activateDiscard(IRON_KEY);
    expect(ops.armedDiscardKey()).toBe(IRON_KEY);
    expect(messages.at(-1)).toContain("DISCARD 80 × IRON ORE");
    expect(state.authorityCommands.pending).toHaveLength(0);
  });

  it("confirms inside the window with the exact DiscardStack payload", () => {
    const vm = ironVm();
    const { state, ops } = harness(vm);
    ops.activateDiscard(IRON_KEY);
    ops.activateDiscard(IRON_KEY);
    expect(ops.armedDiscardKey()).toBeNull();
    expect(state.authorityCommands.pending).toHaveLength(1);
    expect(state.authorityCommands.pending[0]!.command).toEqual({
      DiscardStack: { container: "player:field-pack", stack_id: "11", item_id: 2001, variant_id: 210_218 },
    });
  });

  it("disarms after the timeout instead of confirming", () => {
    const vm = ironVm();
    const { state, ops } = harness(vm);
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    ops.activateDiscard(IRON_KEY);
    now += DISCARD_ARM_MS + 50;
    expect(ops.armedDiscardKey()).toBeNull();
    // A press after the timeout RE-ARMS — it never confirms.
    ops.activateDiscard(IRON_KEY);
    expect(state.authorityCommands.pending).toHaveLength(0);
    expect(ops.armedDiscardKey()).toBe(IRON_KEY);
  });

  it("refuses ineligible stacks outright", () => {
    const foreign = item({
      key: "rogue:field-pack:2001:210218",
      itemId: 2001,
      row: { container: "rogue:field-pack", stackId: 9, variantId: 210_218, quantity: 5, available: 5 },
    });
    const { state, ops, messages } = harness(foreign);
    ops.activateDiscard(foreign.key);
    expect(messages.at(-1)).toBe("DENIED · NOT DISCARDABLE");
    expect(ops.armedDiscardKey()).toBeNull();
    expect(state.authorityCommands.pending).toHaveLength(0);
  });

  it("reports accepted and denied DiscardStack receipts", () => {
    const vm = ironVm();
    const { state, ops } = harness(vm);
    state.serverAuthority.sentCommandLog.push({ commandId: 41, kind: "DiscardStack", sentAtMs: 0 } as never);
    state.serverAuthority.lastReceipt = { commandId: 41, accepted: true } as never;
    expect(ops.poll()).toBe("STACK DISCARDED");
    state.serverAuthority.sentCommandLog.push({ commandId: 42, kind: "DiscardStack", sentAtMs: 0 } as never);
    state.serverAuthority.lastReceipt = { commandId: 42, accepted: false, reasonCode: "stack_not_found" } as never;
    expect(ops.poll()).toBe("DENIED · STACK NOT FOUND");
  });
});
