/**
 * Item copy — the 3D client's OWN description tables.
 *
 * Copy principle (docs/PRODUCT_IDENTITY_BIBLE.md): icon-first, visual-first,
 * reading-second. Descriptions are plain one-liners, ≤60 chars, dry tone,
 * no flavor filler. Item names pass through from the shared definitions, but
 * every description a player reads in the graphical client comes from these
 * tables. Ledger, examine, and tooltips read only this copy.
 */

/** Authority item ids (`itemDefinitions` id space) → description. */
export const ITEM_DESCRIPTION_BY_ID: Record<number, string> = {
  // medical / belt gear
  1001: "Combat heal injector",
  1002: "Stops bleeding",
  1003: "Revives downed operatives",
  1004: "Belt shield. Blocks melee only",
  1005: "Temporary body boost",
  1006: "Temporary spirit boost",
  1007: "Component-built stimpak, big heal",
  1008: "Clears dizzy, brief immunity, state defense",
  1009: "Clears blind, brief immunity, state defense",
  1201: "Stimpak component: healing agent",
  1202: "Stimpak component: liquid carrier",
  1203: "Stimpak component: dose regulator",
  1204: "Stimpak component: delivery shell",
  // ammo
  1101: "Slugthrower ammunition, iron coil slugs",
  // raw resources
  2001: "Raw iron. Crafting metal: sampler rigs, casings, slugs",
  2002: "Raw petrochemical stock",
  2003: "Raw plant fiber",
  2004: "Raw gas. Volatile",
  2005: "Raw liquid stock",
  2006: "Ground bone reagent",
  2007: "Raw copper. Crafting metal: conductors and wiring",
  2008: "Raw carbon",
  2009: "Refined extractor fuel",
  2010: "Processed polymer stock",
  2101: "Harvested hide",
  2102: "Harvested meat",
  2103: "Raw bone. Process at a scout kit",
  2104: "Harvested tissue",
  // tools
  3001: "Crafts general goods",
  3004: "Processes bone in the field",
  3006: "Deployable iron extractor. Crank or battery",
  3007: "Single-use scout camp. Weathers any storm",
  3009: "Surveys petrochemical deposits",
  3201: "Powers a placed extractor. Up to 24h charge",
  // weapons
  3101: "Coil-driven slug rifle",
  3103: "Powered melee blade",
  3111: "Compact STEN-pattern submachine gun",
  3112: "Energy carbine built on the STEN frame",
  // items / redeemable voucher
  4001: "Bounty chit. Pays on harvest",
  9002: "Physical voucher. Redeems into wallet credits",
  7103: "Standard combat helmet",
  7203: "Brimmed field work cap",
  // crop seeds (hex cassette stock)
  6001: "Seed cassette: straw-gold ashgrain kernels",
  6002: "Seed cassette: flat sunmelon seeds",
  6003: "Spore cassette: teal cavemoss beads",
  6004: "Seed cassette: red-black emberbean seeds",
  6005: "Set cassette: knuckled riftroot sets",
  6006: "Spore cassette: brineleaf spore dust",
  6007: "Seed cassette: clear glasspepper seeds",
  6008: "Node cassette: spiral coilreed nodes",
  6009: "Pit cassette: one ridged nightplum pit",
  // harvested produce
  6101: "Bound grain sheaf. Mills to meal",
  6102: "Stem-cut ribbed melon. Press stock",
  6103: "Pressed moss brick. Extract stock",
  6104: "Bundle of crimson pods. Curd stock",
  6105: "Angular tubers on a tie. Starch stock",
  6106: "Salt-rimmed fronds. Salt stock",
  6107: "Faceted peppers on stem. Mash stock",
  6108: "Cut spiral stalks. Syrup stock",
  6109: "Tray of dark fruit. Preserve stock",
  // bio-additive cassettes
  6313: "Density additive cassette, one pip",
  6314: "Density additive cassette, two pips",
  6315: "Density additive cassette, three pips",
  6316: "Savor additive cassette, one pip",
  6317: "Savor additive cassette, two pips",
  6318: "Savor additive cassette, three pips",
  6319: "Nutrient additive cassette, one pip",
  6320: "Nutrient additive cassette, two pips",
  6321: "Nutrient additive cassette, three pips",
  6322: "Batch additive cassette, one pip",
  6323: "Batch additive cassette, two pips",
  6324: "Batch additive cassette, three pips",
  // processed ingredients
  6401: "Milled grain meal. Dough base",
  6402: "Pressed melon pulp. Cooking base",
  6403: "Teal extract ampoules. Broth base",
  6404: "Pressed curd block. Griddle stock",
  6405: "Sack of root starch. Thickener",
  6406: "Blue salt crystals. Seasoning",
  6407: "Pepper mash canister. Marinade stock",
  6408: "Amber reed syrup. Glaze binder",
  6409: "Indigo fruit preserve. Pie filling",
  6410: "Proofing dough. Loaf and bun base",
  6411: "Stock broth flask. Soup base",
  6412: "Minced protein brick. Meat dish base",
  6413: "Live culture cartridge. Ferment starter",
  6414: "Tinned cooking fat. Frying stock",
  6415: "Scored spice brick. Seasoning stock",
  // prepared foods (served on vessels)
  6501: "Scored loaf on a cutting board",
  6502: "Layered cake wedge on a plate",
  6503: "Moss broth in a lidded bowl",
  6504: "Bean griddle cakes on a tray",
  6505: "Root hash in a camp skillet",
  6506: "Noodles in a deep octagonal bowl",
  6507: "Meat and pepper skewers on a board",
  6508: "Glazed spiral bun in a tin",
  6509: "Filled hand pie on a wrapper",
  6510: "Meat and root stew in a tin",
  6511: "Compartment ration tray",
  6512: "Folded dumplings in a steamer",
  6513: "Sliced smoked cutlet on a plate",
  6514: "Pressed fruit bar in a sleeve",
  6515: "Dark soup cup with garnish",
  6516: "Sectioned breakfast tray",
  6517: "Spiced root mash in a bowl",
  6518: "Banded layer cake on a board",
  6519: "Hot moss steep in a square cup",
  6520: "Melon cooler in a field bottle",
};

/** Wardrobe (pawn-pack equipment manifest ids) → description. */
export const GEAR_DESCRIPTION_BY_ID: Record<string, string> = {
  under_tank: "Under-layer tank top",
  under_shorts: "Under-layer shorts",
  hat_warm: "Knit cap",
  armor_harness: "Load-bearing chest harness",
  armor_gorget: "Throat plate. Mounts to harness",
  armor_nape_reinforcement: "Rear neck plate",
  armor_reinforcement: "Extra harness plating",
  armor_bicep_l: "Upper arm plate, left side",
  armor_bicep_r: "Upper arm plate, right side",
  helmet_s2: "Standard combat helmet",
};

/** Slot-keyed fallbacks so new manifest pieces get sane copy without edits. */
const GEAR_DESCRIPTION_BY_SLOT: Record<string, string> = {
  under_torso: "Under-layer top",
  under_legs: "Under-layer shorts",
  cranium: "Headwear",
  armor_harness: "Chest harness",
  armor_gorget: "Throat plate",
  armor_nape_reinforcement: "Rear neck plate",
  armor_reinforcement: "Harness plating",
  armor_bicep_l: "Upper arm plate, left side",
  armor_bicep_r: "Upper arm plate, right side",
  armor_helmet: "Combat helmet",
};

export function itemDescriptionFor(itemId: number): string {
  return ITEM_DESCRIPTION_BY_ID[itemId] ?? "Unclassified";
}

export function gearDescriptionFor(gearId: string, slot: string, layer: string): string {
  return GEAR_DESCRIPTION_BY_ID[gearId]
    ?? GEAR_DESCRIPTION_BY_SLOT[slot]
    ?? (layer === "Armor" ? "Armor plate" : "Wearable");
}
