import { afterEach, describe, expect, it } from "vitest";
import { directions } from "@successor/client/src/slice-core/geometry";
import {
  createPlayState,
  type InventoryRow,
  type PlayState,
  type SliceSnapshot,
} from "@successor/client/src/slice-core/gameState";
import {
  buildInventoryViewModel,
  applyInventoryAction,
  collectInventoryItems,
  contextActionsFor,
  createCollectedItemsScratch,
  defaultInventoryActionFor,
  equipmentIdForInventoryRow,
  isDatapadRow,
  isLocalInventoryContainer,
  modelPathForItemId,
  UNKNOWN_ITEM_MODEL_PATH,
  registerCraftToolOpener,
  weaponIdForInventoryItemId,
  registerLocalGearCatalog,
} from "./data";
import { has as hasEquippedGear, registerKnownGearIds, setEquippedGearPlayerId, toggle as toggleEquippedGear } from "./equippedGearStore";
import { LEGACY_WEARABLE_WORN_IDS } from "../../render/equipmentSlots";

afterEach(() => {
  registerLocalGearCatalog([]);
});

type ResourceRowPatch = Omit<Partial<InventoryRow>, "variantId"> & {
  variantId: unknown;
  variantLabel: string;
  stats?: unknown;
};

function sliceWithInventory(inventory: InventoryRow[]): SliceSnapshot {
  return {
    schema: "successor.slice-core.v1",
    tick: 12,
    tickRateHz: 20,
    combatModel: "roll",
    grid: { cellSizePx: 32 },
    zone: { id: 1, name: "Open Desert", width: 20, height: 12, level: 0 },
    areas: [{ id: "desert", name: "Open Desert", kind: "overworld", width: 20, height: 12, level: 0 }],
    stateHash: "inventory-resource-fixture",
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

function playState(inventory: InventoryRow[]): PlayState {
  const state = createPlayState(sliceWithInventory(inventory), "player");
  state.serverAuthority.playerActorId = "player";
  return state;
}

const resourceRow = (patch: ResourceRowPatch): InventoryRow => ({
  container: "player:field-pack",
  item: "Creature Meat",
  itemId: 2102,
  quantity: 1,
  reserved: 0,
  available: 1,
  stackId: 1,
  ...patch,
} as unknown as InventoryRow);


describe("inventory surface scoping", () => {
  it("uses the shared local-owner/datapad partition for inventory surfaces", () => {
    const state = playState([
      {
        container: "player:field-pack",
        item: "Stimpak A",
        itemId: 1001,
        variantId: 0,
        quantity: 1,
        reserved: 0,
        available: 1,
        stackId: 101,
      },
      {
        container: "rogue:field-pack",
        item: "Foreign Stimpak A",
        itemId: 1001,
        variantId: 0,
        quantity: 99,
        reserved: 0,
        available: 99,
        stackId: 102,
      },
      {
        container: "district-exchange",
        item: "Exchange Stimpak A",
        itemId: 1001,
        variantId: 0,
        quantity: 2,
        reserved: 0,
        available: 2,
        stackId: 103,
      },
      {
        container: "player:datapad",
        item: "Travel Ticket",
        itemId: 4001,
        variantId: 0,
        quantity: 1,
        reserved: 0,
        available: 1,
        stackId: 104,
      },
    ]);

    const inventory = buildInventoryViewModel(state, { open: true, selectedKey: null, hoveredKey: null });
    expect(inventory.items.map((item) => item.row.container)).toEqual(["player:field-pack", "player:datapad"]);
    expect(isLocalInventoryContainer(state, "rogue:field-pack")).toBe(false);

    const datapad = collectInventoryItems(state, isDatapadRow, createCollectedItemsScratch());
    expect(datapad.map((item) => item.row.container)).toEqual(["district-exchange", "player:datapad"]);
  });
});

describe("buildInventoryViewModel weapon items", () => {
  it("maps the vibrosword item to its weapon action and GLB model", () => {
    const state = playState([{
      container: "player:field-pack",
      item: "Vibrosword",
      itemId: 3103,
      variantId: 0,
      quantity: 1,
      reserved: 0,
      available: 1,
      stackId: 31,
    }]);
    const vm = buildInventoryViewModel(state, { open: true, selectedKey: null, hoveredKey: null });
    const sword = vm.items.find((item) => item.itemId === 3103);

    expect(sword).toMatchObject({
      label: "Vibrosword",
      description: "Powered melee blade",
      category: "weapon",
      glb: "/assets/pawn-pack/vibrosword.glb",
      equipped: false,
    });
    expect(sword ? defaultInventoryActionFor(sword, state) : "missing").toBe("equip");
    expect(weaponIdForInventoryItemId(3103)).toBe("vibrosword");
    expect(modelPathForItemId(3103)).toBe("/assets/pawn-pack/vibrosword.glb");
  });
});

describe("inventory model safety path", () => {
  it("uses the durable 3D supply cache for unknown item ids", () => {
    expect(modelPathForItemId(999_999)).toBe(UNKNOWN_ITEM_MODEL_PATH);
    expect(UNKNOWN_ITEM_MODEL_PATH).toBe("/assets/world-items/supply_cache.glb");
  });
});

describe("buildInventoryViewModel medical consumables", () => {
  it("maps canonical Field Bandage 1002 to its authored GLB", () => {
    const state = playState([{
      container: "player:field-pack",
      item: "Field Bandage",
      itemId: 1002,
      variantId: 0,
      quantity: 5,
      reserved: 0,
      available: 5,
      stackId: 12,
    }]);
    const vm = buildInventoryViewModel(state, { open: true, selectedKey: null, hoveredKey: null });
    const bandage = vm.items.find((item) => item.itemId === 1002);

    expect(bandage).toMatchObject({
      label: "Field Bandage",
      category: "medical",
      glb: "/assets/items/field_bandage.glb",
    });
    expect(modelPathForItemId(1002)).toBe("/assets/items/field_bandage.glb");
  });
});

describe("legacy humanoid wearable aliases (shared eight-item contract)", () => {
  const aliasCases = [
    { itemId: 7101, key: "top_plated_rig_vest", label: "Plated Chest-Rig Vest", glb: "/assets/pawn-pack/equipment/Under/top_plated_rig_vest.glb" },
    { itemId: 7102, key: "top_scrap_plate_tunic", label: "Scrap-Plate Tunic", glb: "/assets/pawn-pack/equipment/Under/top_scrap_plate_tunic.glb" },
    { itemId: 7103, key: "helmet_s2", label: "Combat Helm", glb: "/assets/pawn-pack/equipment/Armor/Helmet_S2.glb" },
    { itemId: 7104, key: "legs_gaitered_cargo_pants", label: "Gaitered Cargo Pants", glb: "/assets/pawn-pack/equipment/Under/legs_gaitered_cargo_pants.glb" },
    { itemId: 7201, key: "top_frayed_tunic", label: "Frayed Work Tunic", glb: "/assets/pawn-pack/equipment/Under/top_frayed_tunic.glb" },
    { itemId: 7202, key: "legs_padded_canvas_trousers", label: "Padded Canvas Trousers", glb: "/assets/pawn-pack/equipment/Under/legs_padded_canvas_trousers.glb" },
    { itemId: 7203, key: "hat_field_cap", label: "Field Cap", glb: "/assets/items/custom/accessories/field_cap.glb" },
    { itemId: 7204, key: "top_padded_leather_vest", label: "Padded Leather Vest", glb: "/assets/pawn-pack/equipment/Under/top_padded_leather_vest.glb" },
  ] as const;

  // Deterministic rarity variant from the humanoid loot roll — the alias must
  // never collapse or rewrite it.
  const LOOT_VARIANT_ID = 60_000_123;

  const lootRow = (itemId: number, patch: Partial<InventoryRow> = {}): InventoryRow => ({
    container: "player:field-pack",
    item: `looted wearable ${itemId}`,
    itemId,
    variantId: LOOT_VARIANT_ID,
    quantity: 1,
    reserved: 0,
    available: 1,
    stackId: itemId,
    ...patch,
  });

  it("classifies every alias as one authority-owned gear row with the shipped runtime model", () => {
    for (const { itemId, key, label, glb } of aliasCases) {
      const row = lootRow(itemId);
      const state = playState([row]);
      const vm = buildInventoryViewModel(state, { open: true, selectedKey: null, hoveredKey: null });
      const item = vm.items.find((candidate) => candidate.itemId === itemId);
      expect(item, `item ${itemId}`).toMatchObject({
        itemId,
        label,
        category: "gear",
        equipmentId: key,
        glb,
        equipped: false,
        local: false,
      });
      // One authority-owned row — no synthetic local stand-in beside it.
      expect(vm.items.filter((candidate) => candidate.itemId === itemId)).toHaveLength(1);
      expect(vm.items.some((candidate) => candidate.local && candidate.equipmentId === key)).toBe(false);
      expect(item ? defaultInventoryActionFor(item, state) : "missing").toBe("equip");
      expect(equipmentIdForInventoryRow(row)).toBe(key);
      expect(modelPathForItemId(itemId)).toBe(glb);
      // The worn key is part of the shared render contract (doll/world pawns).
      expect(LEGACY_WEARABLE_WORN_IDS[key]).toBe(true);
      // Rarity variant identity survives in the row and the stable VM key.
      expect(item?.row.variantId).toBe(LOOT_VARIANT_ID);
      expect(item?.key).toBe(`player:field-pack:${itemId}:${LOOT_VARIANT_ID}:${itemId}`);
    }
  });

  it("renders authoritative equipped truth from the row, not a client toggle", () => {
    for (const { itemId } of aliasCases) {
      const state = playState([lootRow(itemId, { equipped: true })]);
      const item = buildInventoryViewModel(state, { open: true, selectedKey: null, hoveredKey: null })
        .items.find((candidate) => candidate.itemId === itemId);
      expect(item?.equipped, `item ${itemId}`).toBe(true);
      expect(item ? defaultInventoryActionFor(item, state) : "missing").toBe("unequip");
    }
  });

  it("queues the exact SetEquippedClothing envelope and never touches the local gear store", () => {
    for (const { itemId, key } of aliasCases) {
      const state = playState([lootRow(itemId)]);
      const slice = sliceWithInventory(state.inventory);
      const vm = buildInventoryViewModel(state, { open: true, selectedKey: null, hoveredKey: null })
        .items.find((candidate) => candidate.itemId === itemId)!;
      expect(applyInventoryAction(state, slice, vm), `equip ${itemId}`).toBe("equipped");
      expect(state.authorityCommands.pending.at(-1)?.command).toEqual({
        SetEquippedClothing: {
          item_id: itemId,
          equipped: true,
          container: "player:field-pack",
          stack_id: String(itemId),
          variant_id: LOOT_VARIANT_ID,
        },
      });
      expect(state.authorityCommands.pending.at(-1)?.issued_at_tick).toBe(12);
      expect(hasEquippedGear(key), `gear store ${key}`).toBe(false);

      const equippedState = playState([lootRow(itemId, { equipped: true })]);
      const equippedVm = buildInventoryViewModel(equippedState, { open: true, selectedKey: null, hoveredKey: null })
        .items.find((candidate) => candidate.itemId === itemId)!;
      expect(applyInventoryAction(equippedState, sliceWithInventory(equippedState.inventory), equippedVm)).toBe("unequipped");
      expect(equippedState.authorityCommands.pending.at(-1)?.command).toEqual({
        SetEquippedClothing: {
          item_id: itemId,
          equipped: false,
          container: "player:field-pack",
          stack_id: String(itemId),
          variant_id: LOOT_VARIANT_ID,
        },
      });
    }
  });
  it("queues durable starter bodysuit through the authority clothing route", () => {
    const state = playState([{
      container: "player:field-pack",
      item: "under_bodysuit",
      itemId: 9900001,
      variantId: 0,
      quantity: 1,
      reserved: 0,
      available: 1,
      stackId: 9900001,
    }]);
    const slice = sliceWithInventory(state.inventory);
    const vm = buildInventoryViewModel(state, { open: true, selectedKey: null, hoveredKey: null })
      .items.find((item) => item.itemId === 9900001)!;
    expect(vm).toMatchObject({
      itemId: 9900001,
      category: "gear",
      equipmentId: "under_bodysuit",
      local: false,
      equipped: false,
    });
    expect(applyInventoryAction(state, slice, vm)).toBe("equipped");
    expect(state.authorityCommands.pending.at(-1)?.command).toEqual({
      SetEquippedClothing: {
        item_id: 9900001,
        equipped: true,
        container: "player:field-pack",
        stack_id: "9900001",
        variant_id: 0,
      },
    });
    expect(hasEquippedGear("under_bodysuit")).toBe(false);
  });
});

describe("authoritative creator clothing rows", () => {
  const clothingRow = (equipped: boolean): InventoryRow => ({
    container: "player:wardrobe",
    item: "top_rigged_tank",
    itemId: 7301,
    variantId: 0,
    quantity: 1,
    reserved: 0,
    available: 1,
    stackId: 7301,
    equipped,
    colors: ["#804040", "#3f7472"],
  });

  it("uses the wardrobe display name with the canonical key/model and row equipped truth", () => {
    const row = clothingRow(true);
    const vm = buildInventoryViewModel(playState([row]), { open: true, selectedKey: null, hoveredKey: null }).items[0]!;
    expect(vm).toMatchObject({
      itemId: 7301,
      label: "Rigged Canvas Tank",
      description: "Clothing · No stats",
      category: "gear",
      equipmentId: "top_rigged_tank",
      glb: "/assets/pawn-pack/equipment/Under/top_rigged_tank.glb",
      equipped: true,
      local: false,
    });
    const unequipped = buildInventoryViewModel(playState([{ ...row, equipped: false }]), { open: true, selectedKey: null, hoveredKey: null }).items[0]!;
    expect(unequipped.equipped).toBe(false);
    expect(equipmentIdForInventoryRow(row)).toBe("top_rigged_tank");
  });

  it("queues the exact authority clothing command envelope on toggle", () => {
    const state = playState([clothingRow(true)]);
    const slice = sliceWithInventory(state.inventory);
    const vm = buildInventoryViewModel(state, { open: true, selectedKey: null, hoveredKey: null }).items[0]!;
    expect(applyInventoryAction(state, slice, vm)).toBe("unequipped");
    expect(state.authorityCommands.pending.at(-1)?.command).toEqual({
      SetEquippedClothing: {
        item_id: 7301,
        container: "player:wardrobe",
        equipped: false,
        stack_id: "7301",
        variant_id: 0,
      },
    });
    expect(state.authorityCommands.pending.at(-1)?.issued_at_tick).toBe(12);
  });
});

describe("paper doll authority equipment resolution", () => {
  it("uses only actor.worn clothing and never stale local gear", () => {
    setEquippedGearPlayerId("player");
    registerKnownGearIds([{ id: "top_rigged_tank" }, { id: "helmet_s2" }]);
    registerLocalGearCatalog([{ id: "helmet_s2", label: "Helmet", description: "", glb: "/assets/pawn-pack/equipment/Armor/Helmet_S2.glb" }]);
    if (!hasEquippedGear("top_rigged_tank")) toggleEquippedGear("top_rigged_tank");
    if (!hasEquippedGear("helmet_s2")) toggleEquippedGear("helmet_s2");

    const authorityState = playState([]);
    const actor = {
      id: "player",
      appearance: { skin: "#4a3223", hair: null, hair_mat: "hair_raven" },
      worn: [{ item: "top_frayed_tunic", colors: ["#804040"] }],
    } as unknown as NonNullable<(typeof authorityState.serverAuthority.actors)[string]>;
    authorityState.serverAuthority.actors.player = actor;
    const wornDoll = buildInventoryViewModel(authorityState, { open: true, selectedKey: null, hoveredKey: null }).doll;
    expect(wornDoll.equipmentIds).toEqual(["top_frayed_tunic"]);

    actor.worn = [];
    const bareDoll = buildInventoryViewModel(authorityState, { open: true, selectedKey: null, hoveredKey: null }).doll;
    expect(bareDoll.equipmentIds).toEqual([]);
    expect(bareDoll.equipmentIds).not.toContain("top_rigged_tank");
  });

  it("renders authority-worn legacy wearables (looted helmet/cap) with their colors on the doll", () => {
    // Fresh gear-store namespace: nothing client-local is toggled, so every
    // rendered piece below comes from the authority worn set alone.
    setEquippedGearPlayerId("legacy-worn-proof");
    const authorityState = playState([]);
    const actor = {
      id: "player",
      appearance: { skin: "#4a3223", hair: null, hair_mat: "hair_raven" },
      worn: [
        { item: "helmet_s2", colors: [] },
        { item: "top_frayed_tunic", colors: ["#804040"] },
        { item: "hat_field_cap", colors: [] },
      ],
    } as unknown as NonNullable<(typeof authorityState.serverAuthority.actors)[string]>;
    authorityState.serverAuthority.actors.player = actor;
    const doll = buildInventoryViewModel(authorityState, { open: true, selectedKey: null, hoveredKey: null }).doll;
    expect(doll.equipmentIds).toEqual(["helmet_s2", "top_frayed_tunic", "hat_field_cap"]);
    // Zone colors ride the authoritative worn set for the palette pass.
    expect(doll.worn).toBe(actor.worn);
  });
});
describe("buildInventoryViewModel resource variants", () => {

  it("keeps per-variant labels/stats distinct for same item id", () => {
    const vm = buildInventoryViewModel(playState([
      resourceRow({ variantId: "clodmeat-w27-a", variantLabel: "Duskback Clodmeat", stats: { potency: 841, purity: 612 }, stackId: 11 }),
      resourceRow({ variantId: "clodmeat-k19-b", variantLabel: "Ashback Clodmeat", stats: { potency: 512, purity: 903 }, stackId: 12 }),
    ]), { open: true, selectedKey: null, hoveredKey: null });

    expect(vm.items.map((item) => item.label)).toEqual(["Duskback Clodmeat", "Ashback Clodmeat"]);
    expect(vm.items.map((item) => item.resource?.variantCode)).toEqual(["W27A", "K19B"]);
    expect(vm.items.map((item) => item.resource?.stats.map((stat) => `${stat.key}:${stat.value}`))).toEqual([
      ["chemical_purity:612", "potency:841"],
      ["chemical_purity:903", "potency:512"],
    ]);
  });

  it("reflects the server-merged carried row as one grid item with the merged count and no default action", () => {
    const state = playState([
      resourceRow({ variantId: "clodmeat-w27-a", variantLabel: "Duskback Clodmeat", available: 14, quantity: 14, stackId: 11 }),
    ]);
    const vm = buildInventoryViewModel(state, { open: true, selectedKey: null, hoveredKey: null });

    expect(vm.items).toHaveLength(1);
    expect(vm.items[0]?.label).toBe("Duskback Clodmeat");
    expect(vm.items[0]?.count).toBe(14);
    expect(vm.items[0] ? defaultInventoryActionFor(vm.items[0], state) : "missing").toBeNull();
  });
});

describe("carried resource context actions", () => {
  const ironRow = (patch: Partial<InventoryRow> = {}): InventoryRow => ({
    container: "player:field-pack",
    item: "Iron Ore",
    itemId: 2001,
    variantId: 210_218,
    quantity: 80,
    reserved: 0,
    available: 80,
    stackId: 11,
    ...patch,
  });

  it("exposes OPEN CRAFTING on carried resource stacks only while the bench opener is wired", () => {
    const state = playState([ironRow()]);
    const vm = buildInventoryViewModel(state, { open: true, selectedKey: null, hoveredKey: null });
    const iron = vm.items.find((item) => item.itemId === 2001)!;
    expect(iron.category).toBe("resource");
    try {
      registerCraftToolOpener(() => {});
      const wired = contextActionsFor(iron).map((action) => ({ ...action }));
      const craft = wired.find((action) => action.id === "craft");
      expect(craft).toMatchObject({ label: "OPEN CRAFTING", enabled: true, note: null });
    } finally {
      registerCraftToolOpener(null);
    }
    // Opener unwired → no dead verb at all.
    expect(contextActionsFor(iron).some((action) => action.id === "craft")).toBe(false);
  });

  it("advertises DISCARD STACK only for owned, server-backed stacks", () => {
    const state = playState([ironRow()]);
    const vm = buildInventoryViewModel(state, { open: true, selectedKey: null, hoveredKey: null });
    const iron = vm.items.find((item) => item.itemId === 2001)!;
    const discard = contextActionsFor(iron).find((action) => action.id === "destroy");
    expect(discard).toMatchObject({ label: "DISCARD STACK", enabled: true, note: null });

    // Foreign container → silent (never a disabled tease on loot you don't own).
    const foreign: typeof iron = { ...iron, row: ironRow({ container: "rogue:field-pack" }) };
    expect(contextActionsFor(foreign).some((action) => action.id === "destroy")).toBe(false);

    // No server stack identity → silent.
    const noStack: typeof iron = { ...iron, row: { ...ironRow(), stackId: undefined } };
    expect(contextActionsFor(noStack).some((action) => action.id === "destroy")).toBe(false);

    // Synthetic local gear → silent.
    const synthetic: typeof iron = { ...iron, local: true };
    expect(contextActionsFor(synthetic).some((action) => action.id === "destroy")).toBe(false);
  });
});
