import type {
  CraftAssembledVM,
  CraftRecipeDetailVM,
  CraftRecipeSummaryVM,
  CraftSessionVM,
  CraftSlotScreenVM,
  DraftedSchematicVM,
  ResourceStatsVM,
} from "./types";

/**
 * CRAFT fixtures — the battery arc as data. One coherent story used by the
 * composer tests AND the dev ingest seam (`__successorCraftIngest`): the
 * player knows four patterns, begins the extractor battery, loads copper
 * (Daxmire 812 conductivity is the server recommendation), iron, and a
 * processed-fuel batch, assembles at 74.2%, spends points on the
 * runtime line, and exits either way. Slots, quantities, and the single
 * `runtime` line mirror the Rust recipe (EXTRACTOR_BATTERY_SLOTS/_LINES:
 * copper ×24 conductivity 45%, iron ×12 tensile 20%, fuel ×12 purity 25% +
 * stability 10%). Shapes are §E verbatim — when CONTRACTS-LIVE lands these
 * must keep compiling against the real union or the fixture is lying.
 */

export function fixtureStats(overrides: Partial<ResourceStatsVM> = {}): ResourceStatsVM {
  return {
    conductivity: 0,
    malleability: 0,
    shock_resistance: 0,
    thermal_resistance: 0,
    chemical_purity: 0,
    density: 0,
    tensile_strength: 0,
    flexibility: 0,
    potency: 0,
    nutrition: 0,
    stability: 0,
    extraction_yield: 0,
    ...overrides,
  };
}

/** Recipes in AUTHORITY STREAM ORDER (category → profession → tier → skill
 * box → id) — the client renders this order verbatim, so the fixture must
 * mirror the Rust `ordered_craft_recipes()` sort or the fixture is lying. */
export function fixtureRecipes(): CraftRecipeSummaryVM[] {
  return [
    {
      recipeId: "extractor_battery",
      name: "Extractor Battery",
      category: "component",
      outputItemId: 3201,
      outputPreviewVariantId: 32_008_640,
      unlocked: true,
      requiredToolItemId: 3001,
      requiredProfession: "craftsman-novice",
      source: "trained",
    },
    {
      recipeId: "field_multitool",
      name: "Field Multitool",
      category: "tool",
      outputItemId: 3001,
      outputPreviewVariantId: 0,
      unlocked: true,
      requiredToolItemId: 3001,
      requiredProfession: "craftsman-novice",
      source: "trained",
      handsCraftable: true,
    },
    {
      recipeId: "metal_extractor",
      name: "Personal Mineral Sampler",
      category: "tool",
      outputItemId: 3006,
      outputPreviewVariantId: 500,
      unlocked: true,
      requiredToolItemId: 3001,
      requiredProfession: "craftsman-novice",
      source: "trained",
    },
    {
      recipeId: "scattergun_pattern",
      name: "Scattergun",
      category: "weapon",
      outputItemId: 1005,
      outputPreviewVariantId: 31_500_000,
      unlocked: true,
      requiredToolItemId: 3001,
      requiredProfession: "craftsman-novice",
      source: "learned",
      remainingUses: 3,
    },
    {
      recipeId: "slugthrower",
      name: "Crafted Slugthrower Mk I",
      category: "weapon",
      outputItemId: 3101,
      outputPreviewVariantId: 81_050_050,
      unlocked: false,
      requiredToolItemId: 3001,
      requiredProfession: "craftsman-assembly-i",
      source: "trained",
    },
  ];
}

export function fixtureBatteryDetail(): CraftRecipeDetailVM {
  return {
    recipeId: "extractor_battery",
    outputItemId: 3201,
    outputPreviewVariantId: 32_008_640,
    slots: [
      {
        slotIndex: 0,
        symbol: "conductor",
        resourceKindLabel: "Copper conductor",
        requiredItemId: 2007,
        requiredFamily: "copper",
        requirementKind: "material_family",
        requiredItemName: "Copper",
        requiredQty: 24,
        craftRelevantStat: "conductivity",
      },
      {
        slotIndex: 1,
        symbol: "casing",
        resourceKindLabel: "Iron casing",
        requiredItemId: 2001,
        requiredFamily: "mineral",
        requirementKind: "material_family",
        requiredItemName: "Iron",
        requiredQty: 12,
        craftRelevantStat: "tensile_strength",
      },
      {
        slotIndex: 2,
        symbol: "fuel",
        resourceKindLabel: "Processed fuel",
        requiredItemId: 2009,
        requiredFamily: "fuel",
        requirementKind: "material_family",
        requiredItemName: "Fuel",
        requiredQty: 12,
        craftRelevantStat: "chemical_purity",
      },
    ],
    // One authoritative line: 450 + norm×550/1000 over the recommended
    // stacks (812×45 + 702×20 + 764×25 + 620×10)/100 = 758 → cap 866.
    statLines: [
      { lineId: 0, label: "runtime", capEstimateMilli: 866 },
    ],
  };
}

/**
 * Personal Mineral Sampler requirements — the Rust recipe verbatim
 * (METAL_EXTRACTOR_SLOTS: iron 2001 ×80 tensile, copper 2007 ×36
 * conductivity). The ledger must show BOTH requirements at once with
 * carried counts before BEGIN.
 */
export function fixtureSamplerDetail(): CraftRecipeDetailVM {
  return {
    recipeId: "metal_extractor",
    outputItemId: 3006,
    outputPreviewVariantId: 500,
    slots: [
      {
        slotIndex: 0,
        symbol: "casing",
        resourceKindLabel: "Iron frame",
        requiredItemId: 2001,
        requiredFamily: "mineral",
        requirementKind: "material_family",
        requiredItemName: "Iron",
        requiredQty: 80,
        craftRelevantStat: "tensile_strength",
      },
      {
        slotIndex: 1,
        symbol: "conductor",
        resourceKindLabel: "Copper windings",
        requiredItemId: 2007,
        requiredFamily: "copper",
        requirementKind: "material_family",
        requiredItemName: "Copper",
        requiredQty: 36,
        craftRelevantStat: "conductivity",
      },
    ],
    statLines: [
      { lineId: 0, label: "pull rate", capEstimateMilli: 720 },
    ],
  };
}

export function fixtureSlotScreen(overrides: Partial<CraftSlotScreenVM> = {}): CraftSlotScreenVM {
  return {
    recipeId: "extractor_battery",
    canAssemble: false,
    slots: [
      {
        slotIndex: 0,
        symbol: "conductor",
        resourceKindLabel: "Copper conductor",
        requiredQty: 24,
        requiredItemId: 2007,
        requiredFamily: "copper",
        requirementKind: "material_family",
        requiredItemName: "Copper",
        craftRelevantStat: "conductivity",
        assigned: null,
        eligible: [
          {
            container: "player:field-pack",
            stackId: "11",
            itemId: 2007,
            variantId: 220_431,
            name: "Daxmire Copper",
            qtyAvailable: 40,
            craftRelevantStatValue: 812,
            recommended: true,
            stats: fixtureStats({ conductivity: 812, malleability: 430, density: 610, tensile_strength: 355, stability: 540, extraction_yield: 480 }),
          },
          {
            container: "player:field-pack",
            stackId: "12",
            itemId: 2007,
            variantId: 220_502,
            name: "Vessic Copper",
            qtyAvailable: 30,
            craftRelevantStatValue: 655,
            recommended: false,
            stats: fixtureStats({ conductivity: 655, malleability: 512, density: 587, tensile_strength: 402, stability: 505, extraction_yield: 445 }),
          },
          {
            container: "player:field-pack",
            stackId: "13",
            itemId: 2007,
            variantId: 220_118,
            name: "Ashfall Copper",
            qtyAvailable: 2,
            craftRelevantStatValue: 905,
            recommended: false,
            stats: fixtureStats({ conductivity: 905, malleability: 388, density: 640, tensile_strength: 310, stability: 585, extraction_yield: 502 }),
          },
        ],
      },
      {
        slotIndex: 1,
        symbol: "casing",
        resourceKindLabel: "Iron casing",
        requiredQty: 12,
        requiredItemId: 2001,
        requiredFamily: "mineral",
        requirementKind: "material_family",
        requiredItemName: "Iron",
        craftRelevantStat: "tensile_strength",
        assigned: null,
        eligible: [
          {
            container: "player:field-pack",
            stackId: "14",
            itemId: 2001,
            variantId: 210_218,
            name: "Daxmire Iron",
            qtyAvailable: 18,
            craftRelevantStatValue: 702,
            recommended: true,
            stats: fixtureStats({ tensile_strength: 702, malleability: 350, stability: 460, density: 300, conductivity: 240, extraction_yield: 410 }),
          },
          {
            container: "player:field-pack",
            stackId: "15",
            itemId: 2001,
            variantId: 210_305,
            name: "Marsh Iron",
            qtyAvailable: 14,
            craftRelevantStatValue: 512,
            recommended: false,
            stats: fixtureStats({ tensile_strength: 512, malleability: 410, stability: 395, density: 340, conductivity: 205, extraction_yield: 360 }),
          },
        ],
      },
      {
        slotIndex: 2,
        symbol: "fuel",
        resourceKindLabel: "Processed fuel",
        requiredQty: 12,
        requiredItemId: 2009,
        requiredFamily: "fuel",
        requirementKind: "material_family",
        requiredItemName: "Fuel",
        craftRelevantStat: "chemical_purity",
        assigned: null,
        // Crafted fuel batches carry the recipe name and ONLY the derived
        // channels (chemical_purity + stability) — every other stat is an
        // honest zero on the wire.
        eligible: [
          {
            container: "player:field-pack",
            stackId: "16",
            itemId: 2009,
            variantId: 47_214_220,
            name: "Fuel",
            qtyAvailable: 24,
            craftRelevantStatValue: 764,
            recommended: true,
            stats: fixtureStats({ chemical_purity: 764, stability: 620 }),
          },
          {
            container: "player:field-pack",
            stackId: "17",
            itemId: 2009,
            variantId: 47_198_005,
            name: "Fuel",
            qtyAvailable: 12,
            craftRelevantStatValue: 566,
            recommended: false,
            stats: fixtureStats({ chemical_purity: 566, stability: 671 }),
          },
        ],
      },
    ],
    ...overrides,
  };
}

/** Slot screen with all three slots loaded (ASSEMBLE armed). */
export function fixtureSlotScreenLoaded(): CraftSlotScreenVM {
  const screen = fixtureSlotScreen({ canAssemble: true });
  screen.slots[0]!.assigned = { container: "player:field-pack", stackId: "11", variantId: 220_431 };
  screen.slots[1]!.assigned = { container: "player:field-pack", stackId: "14", variantId: 210_218 };
  screen.slots[2]!.assigned = { container: "player:field-pack", stackId: "16", variantId: 47_214_220 };
  return screen;
}

export function fixtureAssembled(overrides: Partial<CraftAssembledVM> = {}): CraftAssembledVM {
  return {
    recipeId: "extractor_battery",
    assemblyQualityMilli: 742,
    experimentationPointsRemaining: 4,
    // Battery variant = 32_000_000 + runtime seconds from (conductivity 812,
    // line value 668): (812×600 + 668×400)/1000 = 754 → 86_400×754/1000.
    outputPreviewVariantId: 32_065_145,
    // Initial value = 100 + (cap−100)×quality/1000 = 100 + 766×742/1000.
    // Risk projection mirrors the authority: one-point success 705‰, each
    // extra point in the same attempt costs 50‰ (crafting.rs batch risk).
    lines: [
      {
        lineId: 0,
        label: "runtime",
        valueMilli: 668,
        capMilli: 866,
        canRaise: true,
        onePointSuccessMilli: 705,
        batchRiskPerExtraPointMilli: 50,
      },
    ],
    ...overrides,
  };
}

export function fixtureSessionSlots(loaded = false): CraftSessionVM {
  return {
    phase: "slots",
    recipeId: "extractor_battery",
    slotScreen: loaded ? fixtureSlotScreenLoaded() : fixtureSlotScreen(),
    assembled: null,
  };
}

export function fixtureSessionAssembled(): CraftSessionVM {
  return {
    phase: "assembled",
    recipeId: "extractor_battery",
    slotScreen: null,
    assembled: fixtureAssembled(),
  };
}

export function fixtureDrafts(): DraftedSchematicVM[] {
  return [
    {
      schematicId: "schematic:operative-7:3",
      recipeId: "extractor_battery",
      name: "Extractor Battery",
      outputItemId: 3201,
      // Frozen after two experiment marks on runtime (668 → 724):
      // (812×600 + 724×400)/1000 = 776 → 86_400×776/1000 = 67_046 s.
      outputVariantId: 32_067_046,
      maxUses: 10,
      remainingUses: 7,
      resourceLocks: [
        { itemId: 2007, variantId: 220_431, quantity: 24, name: "Daxmire Copper" },
        { itemId: 2001, variantId: 210_218, quantity: 12, name: "Daxmire Iron" },
        { itemId: 2009, variantId: 47_214_220, quantity: 12, name: "Fuel" },
      ],
      statLines: [
        { label: "runtime", valueMilli: 724 },
      ],
    },
    {
      schematicId: "schematic:operative-7:1",
      recipeId: "metal_extractor",
      name: "Personal Mineral Sampler",
      outputItemId: 3006,
      outputVariantId: 640,
      maxUses: 5,
      remainingUses: 0,
      resourceLocks: [
        { itemId: 2001, variantId: 210_218, quantity: 6, name: "Daxmire Iron" },
        { itemId: 2007, variantId: 220_431, quantity: 3, name: "Daxmire Copper" },
        { itemId: 2003, variantId: 216_100, quantity: 2, name: "Scrub Flora" },
      ],
      statLines: [
        { label: "PULL RATE", valueMilli: 640 },
      ],
    },
  ];
}
