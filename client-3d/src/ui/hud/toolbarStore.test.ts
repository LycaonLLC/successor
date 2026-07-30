import { describe, expect, it } from "vitest";
import { defaultInventoryActionFor } from "../inventory/data";
import type { InventoryCategory, InventoryItemVM } from "../inventory/types";
import { TOOLBAR_DEFAULT_BINDS, isToolbarActionId } from "./toolbarActions";
import {
  assignSlot,
  clearSlot,
  loadToolbarDoc,
  migrateToolbarDoc,
  moveOrSwapSlot,
  type ToolbarDocDefaults,
  type ToolbarSlotRef,
} from "./toolbarStore";

const DEFAULTS: ToolbarDocDefaults = {
  slotCount: 12,
  defaultBinds: TOOLBAR_DEFAULT_BINDS,
};

const valid = isToolbarActionId;
const action = (id: string): ToolbarSlotRef => ({ kind: "action", id });
const item = (itemId: string): ToolbarSlotRef => ({ kind: "item", itemId });

describe("toolbarStore migration", () => {
  it("yields an all-empty toolbar when no doc is stored (blank-by-default)", () => {
    const doc = loadToolbarDoc(null, null, null, DEFAULTS, valid);
    expect(doc.slots).toHaveLength(12);
    expect(doc.slots.every((slot) => slot === null)).toBe(true);
    expect(doc.binds).toEqual([...TOOLBAR_DEFAULT_BINDS]);
  });

  it("strips the removed Aim action from a persisted layout but keeps the rest", () => {
    // A v1-era layout that still has aimed_shot in slot 1 (now removed) plus
    // real actions the player wants to keep.
    const legacy = {
      slots: ["attack", "aimed_shot", "kneel", "reload", null, "window:inventory"],
      binds: ["Digit1", "Digit2", "KeyQ", "Digit4", "Digit5", "KeyI"],
    };
    const doc = loadToolbarDoc(null, null, JSON.stringify(legacy), DEFAULTS, valid);
    expect(doc.slots[0]).toEqual(action("attack"));
    expect(doc.slots[1]).toBeNull(); // aimed_shot removed
    expect(doc.slots[2]).toEqual(action("kneel"));
    expect(doc.slots[3]).toEqual(action("reload"));
    expect(doc.slots[4]).toBeNull();
    expect(doc.slots[5]).toEqual(action("window:inventory"));
    // Binds are preserved verbatim where present.
    expect(doc.binds[2]).toBe("KeyQ");
    expect(doc.binds[5]).toBe("KeyI");
  });

  it("promotes a v2 string-slot doc to schema-3 action refs", () => {
    const v2 = JSON.stringify({ schema: 2, slots: ["kneel", "reload"], binds: ["Digit1", "Digit2"] });
    const doc = loadToolbarDoc(null, v2, null, DEFAULTS, valid);
    expect(doc.slots[0]).toEqual(action("kneel"));
    expect(doc.slots[1]).toEqual(action("reload"));
  });

  it("v2 doc wins over the legacy v1 doc when no v3 doc exists", () => {
    const v1 = JSON.stringify({ slots: ["attack", "aimed_shot"], binds: ["Digit1"] });
    const v2 = JSON.stringify({ schema: 2, slots: ["kneel", "reload"], binds: ["Digit1", "Digit2"] });
    const doc = loadToolbarDoc(null, v2, v1, DEFAULTS, valid);
    expect(doc.slots[0]).toEqual(action("kneel"));
    expect(doc.slots[1]).toEqual(action("reload"));
  });

  it("v3 doc wins over the v2 and legacy v1 docs", () => {
    const v1 = JSON.stringify({ slots: ["attack", "aimed_shot"], binds: ["Digit1"] });
    const v2 = JSON.stringify({ schema: 2, slots: ["kneel", "reload"], binds: ["Digit1", "Digit2"] });
    const v3 = JSON.stringify({ schema: 3, slots: [item("1001"), action("window:inventory")], binds: ["Digit9"] });
    const doc = loadToolbarDoc(v3, v2, v1, DEFAULTS, valid);
    expect(doc.slots[0]).toEqual(item("1001"));
    expect(doc.slots[1]).toEqual(action("window:inventory"));
    expect(doc.binds[0]).toBe("Digit9");
  });

  it("clamps short slot arrays to the slot count without throwing", () => {
    const doc = migrateToolbarDoc({ slots: ["attack"], binds: ["Digit1"] }, DEFAULTS, valid);
    expect(doc.slots).toHaveLength(12);
    expect(doc.slots[0]).toEqual(action("attack"));
    expect(doc.slots[1]).toBeNull();
  });

  it("falls back to default binds for missing/blank bind entries", () => {
    const doc = migrateToolbarDoc({ slots: [null], binds: ["", "Digit2"] }, DEFAULTS, valid);
    expect(doc.binds[0]).toBe(TOOLBAR_DEFAULT_BINDS[0]);
    expect(doc.binds[1]).toBe("Digit2");
  });

  it("rejects corrupt JSON and falls back to blank", () => {
    const doc = loadToolbarDoc("not json{", null, null, DEFAULTS, valid);
    expect(doc.slots.every((slot) => slot === null)).toBe(true);
  });

  it("rejects malformed schema-3 refs instead of preserving unknown kinds", () => {
    const doc = migrateToolbarDoc(
      {
        schema: 3,
        slots: [{ kind: "bogus", id: "attack" }, { kind: "item", itemId: "1001" }, { kind: "action", id: "aimed_shot" }],
        binds: [],
      },
      DEFAULTS,
      valid,
    );
    expect(doc.slots[0]).toBeNull();
    expect(doc.slots[1]).toEqual(item("1001"));
    expect(doc.slots[2]).toBeNull();
  });

  it("empties stale window:surveyTool slots (survey scope is context-only, no toolbar shortcut)", () => {
    const v3 = JSON.stringify({
      schema: 3,
      slots: [action("window:surveyTool"), action("window:inventory"), item("1001")],
      binds: ["Digit1", "Digit2", "Digit3"],
    });
    const doc = loadToolbarDoc(v3, null, null, DEFAULTS, valid);
    expect(valid("window:surveyTool")).toBe(false); // removed from TOOLBAR_ACTIONS
    expect(doc.slots[0]).toBeNull(); // safe empty slot, not a dead button
    expect(doc.slots[1]).toEqual(action("window:inventory"));
    expect(doc.slots[2]).toEqual(item("1001"));
    // The freed slot keeps its default-bind reconciliation path.
    expect(doc.binds[0]).toBe("Digit1");
  });
});

describe("toolbarStore slot assignment", () => {
  const base: readonly ToolbarSlotRef[] = [
    action("attack"),
    null,
    action("kneel"),
    item("1001"),
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ];

  it("assigns an action from the browser to an empty slot", () => {
    const next = assignSlot(base, 1, { kind: "action", id: "reload" });
    expect(next[1]).toEqual(action("reload"));
    expect(next).not.toBe(base); // returns a new array
  });

  it("assigns an item ref from inventory to an empty slot", () => {
    const next = assignSlot(base, 1, { kind: "item", itemId: "1002" });
    expect(next[1]).toEqual(item("1002"));
  });

  it("ignores out-of-range slots on assign", () => {
    const next = assignSlot(base, 99, { kind: "action", id: "reload" });
    expect(next).toEqual([...base]);
  });

  it("moves an item ref into an empty target (source clears)", () => {
    const next = moveOrSwapSlot(base, 3, 1);
    expect(next[3]).toBeNull();
    expect(next[1]).toEqual(item("1001"));
  });

  it("swaps occupied action and item refs", () => {
    const next = moveOrSwapSlot(base, 0, 3);
    expect(next[0]).toEqual(item("1001"));
    expect(next[3]).toEqual(action("attack"));
  });

  it("treats a self-move as a no-op", () => {
    const next = moveOrSwapSlot(base, 0, 0);
    expect(next).toEqual([...base]);
  });

  it("clears a slot (drag-off-toolbar)", () => {
    const next = clearSlot(base, 3);
    expect(next[3]).toBeNull();
    expect(next[2]).toEqual(action("kneel"));
  });
});

describe("defaultInventoryActionFor", () => {
  const state = {} as Parameters<typeof defaultInventoryActionFor>[1];
  const vm = (category: InventoryCategory, equipped = false, itemId = 1001): InventoryItemVM => ({
    key: "player:field-pack:1001:0",
    itemId,
    label: "Test Item",
    description: "",
    category,
    count: 1,
    equipped,
    glb: "/assets/world-items/supply_cache.glb",
    resource: null,
    local: false,
    equipmentId: null,
    row: {
      container: "player:field-pack",
      item: "Test Item",
      itemId,
      variantId: 0,
      quantity: 1,
      reserved: 0,
      available: 1,
    },
  });

  it("defaults gear and clothing-style rows to equip or unequip", () => {
    expect(defaultInventoryActionFor(vm("gear", false, 1004), state)).toBe("equip");
    expect(defaultInventoryActionFor(vm("gear", true, 1004), state)).toBe("unequip");
  });

  it("defaults weapon rows to the equip/wield toggle", () => {
    expect(defaultInventoryActionFor(vm("weapon", false, 3101), state)).toBe("equip");
    expect(defaultInventoryActionFor(vm("weapon", true, 3101), state)).toBe("unequip");
  });

  it("defaults medical consumables to USE", () => {
    expect(defaultInventoryActionFor(vm("medical", false, 1001), state)).toBe("use");
  });

  it("has no default for ammo, resources, tools, currency, or other items", () => {
    for (const category of ["ammo", "resource", "tool", "currency", "item"] as const) {
      expect(defaultInventoryActionFor(vm(category), state)).toBeNull();
    }
    for (const itemId of [2101, 2102, 2103]) {
      expect(defaultInventoryActionFor(vm("resource", false, itemId), state)).toBeNull();
    }
  });
});
