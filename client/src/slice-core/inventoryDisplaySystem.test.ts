import { describe, expect, it } from "vitest";
import type { InventoryRow } from "./gameState";
import {
  INVENTORY_ITEM_DEFINITION_IDS,
  inventoryItemDisplay,
} from "./inventoryDisplaySystem";

function row(itemId: number, item: string): InventoryRow {
  return { container: "player-one:field-pack", item, itemId, variantId: 0, quantity: 1, reserved: 0, available: 1 };
}

describe("inventoryDisplaySystem", () => {
  it("resolves representative items to exact labels and categories", () => {
    const stimpak = inventoryItemDisplay(row(1001, "Stimpak A"));
    expect(stimpak.name).toBe("Stimpak A");
    expect(stimpak.category).toBe("medical");

    const scoutKit = inventoryItemDisplay(row(3004, "Scout Processing Kit"));
    expect(scoutKit.name).toBe("Scout Processing Kit");
    expect(scoutKit.category).toBe("tool");

    const shieldGenerator = inventoryItemDisplay(row(1004, "Personal Shield Generator"));
    expect(shieldGenerator.name).toBe("Personal Shield Generator");
    expect(shieldGenerator.category).toBe("gear");

    const ticket = inventoryItemDisplay(row(5001, "Travel Ticket"));
    expect(ticket.name).toBe("Travel Ticket");

    const schematic = inventoryItemDisplay(row(5002, "Looted Schematic"));
    expect(schematic.name).toBe("Looted Schematic");
  });

  it("uses authority labels and neutral metadata for unknown future items", () => {
    const display = inventoryItemDisplay(row(424_242, "Prototype Widget"));
    expect(display.name).toBe("Prototype Widget");
    expect(display.category).toBe("item");
  });
});

describe("food/crop catalog wave (2026-07-12 rebase)", () => {
  const seedIds = [6001, 6002, 6003, 6004, 6005, 6006, 6007, 6008, 6009];
  const produceIds = [6101, 6102, 6103, 6104, 6105, 6106, 6107, 6108, 6109];
  const additiveIds = [6313, 6314, 6315, 6316, 6317, 6318, 6319, 6320, 6321, 6322, 6323, 6324];
  const ingredientIds = [6401, 6402, 6403, 6404, 6405, 6406, 6407, 6408, 6409, 6410, 6411, 6412, 6413, 6414, 6415];
  const preparedFoodIds = [6501, 6502, 6503, 6504, 6505, 6506, 6507, 6508, 6509, 6510, 6511, 6512, 6513, 6514, 6515, 6516, 6517, 6518, 6519, 6520];
  const waveIds = [...seedIds, ...produceIds, ...additiveIds, ...ingredientIds, ...preparedFoodIds];

  it("defines all 65 wave items with names and copy", () => {
    expect(waveIds).toHaveLength(65);
    const defined = new Set(INVENTORY_ITEM_DEFINITION_IDS);
    for (const itemId of waveIds) {
      expect(defined.has(itemId), `item ${itemId}`).toBe(true);
      const display = inventoryItemDisplay(row(itemId, `wire-${itemId}`));
      expect(display.name, `item ${itemId}`).not.toBe(`wire-${itemId}`);
      expect(display.description.length, `item ${itemId}`).toBeGreaterThan(0);
      expect(display.category, `item ${itemId}`).toBe("item");
    }
  });

  it("resolves representative catalog names exactly", () => {
    expect(inventoryItemDisplay(row(6001, "x")).name).toBe("Ashgrain Seed Cassette");
    expect(inventoryItemDisplay(row(6009, "x")).name).toBe("Nightplum Pit Cassette");
    expect(inventoryItemDisplay(row(6101, "x")).name).toBe("Ashgrain Sheaf");
    expect(inventoryItemDisplay(row(6109, "x")).name).toBe("Nightplums");
    expect(inventoryItemDisplay(row(6313, "x")).name).toBe("Light Density Matrix");
    expect(inventoryItemDisplay(row(6324, "x")).name).toBe("Heavy Batch Matrix");
    expect(inventoryItemDisplay(row(6401, "x")).name).toBe("Ashgrain Meal");
    expect(inventoryItemDisplay(row(6415, "x")).name).toBe("Seasoning Brick");
    expect(inventoryItemDisplay(row(6501, "x")).name).toBe("Ashgrain Hearth Loaf");
    expect(inventoryItemDisplay(row(6520, "x")).name).toBe("Sunmelon Cooler");
  });

});
