import type { InventoryRow } from "./gameState";

export interface InventoryDisplayChip {
  label: string;
  value?: string;
}

export interface InventoryItemDisplay {
  name: string;
  description: string;
  category: "ammo" | "medical" | "resource" | "tool" | "gear" | "currency" | "item";
  chips: InventoryDisplayChip[];
}

interface ItemDisplayDefinition {
  name: string;
  description: string;
  category: InventoryItemDisplay["category"];
}

const itemDefinitions: Record<number, ItemDisplayDefinition> = {
  1001: { name: "Stimpak A", description: "Injectable heal pack; quality sets potency.", category: "medical" },
  1002: { name: "Field Bandage", description: "Basic field bleed stop kit.", category: "medical" },
  1003: { name: "Resuscitation Kit", description: "Revive kit for trained medics.", category: "medical" },
  1004: { name: "Personal Shield Generator", description: "Melee-only belt shield; pulses on blocks.", category: "gear" },
  1005: { name: "Body Enhancement Pack A", description: "Short-duration body service pack.", category: "medical" },
  1006: { name: "Spirit Enhancement Pack A", description: "Short-duration spirit service pack.", category: "medical" },
  1007: { name: "Advanced Stimpak", description: "Component-built stimpak; far higher heal than the basic pak.", category: "medical" },
  1008: { name: "Anti-Dizzy Stim", description: "Clears dizziness, grants brief immunity + a lasting state-defense buff.", category: "medical" },
  1009: { name: "Anti-Blind Stim", description: "Clears blindness, grants brief immunity + a lasting state-defense buff.", category: "medical" },
  1201: { name: "Biological Effect Controller", description: "Stimpak component: the healing agent. Quality carries into the product.", category: "item" },
  1202: { name: "Liquid Suspension", description: "Stimpak component: the water-based carrier. Quality carries into the product.", category: "item" },
  1203: { name: "Chemical Release Duration Mechanism", description: "Stimpak component: paces the dose. Quality carries into the product.", category: "item" },
  1204: { name: "Solid Delivery Shell", description: "Stimpak component: the mineral casing. Quality carries into the product.", category: "item" },
  1101: { name: "Iron Slug", description: "Standard iron slug for the Slugthrower.", category: "ammo" },
  1102: { name: "Shard Slug", description: "Soft-target slug tuned for higher trauma and bleed pressure.", category: "ammo" },
  1103: { name: "Spike Slug", description: "Armor-penetrating slug tuned for hard targets and steadier suppression.", category: "ammo" },
  2001: { name: "Iron", description: "Cycle mineral for tools, ammo, and casing.", category: "resource" },
  2002: { name: "Petrochemical", description: "Raw chemical feedstock for processed materials.", category: "resource" },
  2003: { name: "Flora", description: "Organic fiber and binder resource.", category: "resource" },
  2004: { name: "Gas", description: "Volatile advanced schematic resource.", category: "resource" },
  2005: { name: "Liquid", description: "Fluid advanced schematic resource.", category: "resource" },
  2006: { name: "Clodpowder", description: "Processed bone reagent; inherits bone stats.", category: "resource" },
  2007: { name: "Copper", description: "Conductive mineral for tools and power components.", category: "resource" },
  2008: { name: "Carbon", description: "Dense mineral feedstock for polymer processing.", category: "resource" },
  2009: { name: "Fuel", description: "Processed petrochemical fuel for extractor batteries.", category: "resource" },
  2010: { name: "Polymer", description: "Processed grip material for weapon crafting.", category: "resource" },
  2101: { name: "Creature Hide", description: "Harvested hide material.", category: "resource" },
  2102: { name: "Creature Meat", description: "Harvested meat material.", category: "resource" },
  2103: { name: "Clodbone", description: "Raw Clod bone; process at a scout kit.", category: "resource" },
  2104: { name: "Creature Tissue", description: "Structural creature material.", category: "resource" },
  3001: { name: "Field Multitool", description: "Universal field rig for survey, sampling, and crafting.", category: "tool" },
  3004: { name: "Scout Processing Kit", description: "Field kit for processing Clodbone.", category: "tool" },
  3006: { name: "Personal Mineral Sampler", description: "Deployable sampler that pulls mineral from a surveyed field.", category: "tool" },
  3007: { name: "Camp Kit", description: "Portable camp for field rest and crafting.", category: "tool" },
  3008: { name: "Mineral Survey Tool", description: "Surveys mineral resource fields.", category: "tool" },
  3009: { name: "Chemical Survey Device", description: "Surveys petrochemical resource fields.", category: "tool" },
  3010: { name: "Gas Survey Tool", description: "Surveys gas resource fields.", category: "tool" },
  3011: { name: "Water Survey Tool", description: "Surveys water resource fields.", category: "tool" },
  3012: { name: "Personal Chemical Extractor", description: "Deployable extractor that pulls petrochemical from a surveyed field.", category: "tool" },
  3013: { name: "Personal Gas Harvester", description: "Deployable harvester that pulls gas from a surveyed field.", category: "tool" },
  3014: { name: "Survival Moisture Vaporator", description: "Deployable vaporator that pulls water from a surveyed field.", category: "tool" },
  3201: { name: "Extractor Battery", description: "Charged cell that keeps a deployed extractor running.", category: "tool" },
  3101: { name: "Slugthrower", description: "Coil-fed slug weapon.", category: "gear" },
  3103: { name: "Vibrosword", description: "Powered melee blade.", category: "gear" },
  3105: { name: "Scrapline Machete", description: "Primitive reclaimed-steel field blade.", category: "gear" },
  3106: { name: "Field Saber", description: "Plain militia blade balanced for reach.", category: "gear" },
  3107: { name: "Quarry Chopper", description: "Forward-weighted primitive work blade.", category: "gear" },
  3104: { name: "Plasma Sword", description: "Plasma-bladed sword; uses vibrosword authority handling.", category: "gear" },
  3111: { name: "STEN Mk II", description: "Compact 9mm submachine gun built on the STEN pattern.", category: "gear" },
  3112: { name: "Kiln Energy Cell Carbine", description: "Tight, hard-hitting energy carbine built on the STEN receiver.", category: "gear" },
  3121: { name: "Lightning Carbine", description: "Rapid Storm-pattern carbine with an electric discharge trace.", category: "gear" },
  5001: { name: "Travel Ticket", description: "One-use terminal ticket for planetfall travel.", category: "item" },
  5002: { name: "Looted Schematic", description: "Recovered schematic; learn it to draft the design.", category: "item" },
  5003: { name: "Drafted Schematic", description: "Datapad handle for a drafted factory schematic.", category: "item" },
  6001: { name: "Ashgrain Seed Cassette", description: "Clear-window hex cassette of straw-gold kernels; plantable seed stock.", category: "item" },
  6002: { name: "Sunmelon Seed Cassette", description: "Hex cassette of flat black-orange melon seeds; plantable seed stock.", category: "item" },
  6003: { name: "Cavemoss Spore Cassette", description: "Hex cassette of teal spore beads in a fibrous nest; plantable spore stock.", category: "item" },
  6004: { name: "Emberbean Seed Cassette", description: "Hex cassette of red-black kidney seeds; plantable seed stock.", category: "item" },
  6005: { name: "Riftroot Set Cassette", description: "Hex cassette of knuckled purple root sets; plantable root stock.", category: "item" },
  6006: { name: "Brineleaf Spore Cassette", description: "Hex cassette of pale blue spore dust in a mesh pocket; plantable spore stock.", category: "item" },
  6007: { name: "Glasspepper Seed Cassette", description: "Hex cassette of translucent chartreuse seeds; plantable seed stock.", category: "item" },
  6008: { name: "Coilreed Node Cassette", description: "Hex cassette of spiral amber stem nodes; plantable node stock.", category: "item" },
  6009: { name: "Nightplum Pit Cassette", description: "Hex cassette holding one ridged indigo pit; plantable pit stock.", category: "item" },
  6101: { name: "Ashgrain Sheaf", description: "Strap-bound grain sheaf; mills into ashgrain meal.", category: "item" },
  6102: { name: "Sunmelon", description: "Stem-cut ribbed melon; presses into cooking pulp.", category: "item" },
  6103: { name: "Cavemoss Brick", description: "Pressed moss brick with cut edges; extract stock.", category: "item" },
  6104: { name: "Emberbean Pods", description: "Tied bundle of split crimson pods; curd and griddle stock.", category: "item" },
  6105: { name: "Riftroot Tubers", description: "Three scrubbed angular tubers on a tie; starch and hash stock.", category: "item" },
  6106: { name: "Brineleaf Fronds", description: "Salt-rimmed blue-green frond bundle; salt and noodle stock.", category: "item" },
  6107: { name: "Glasspeppers", description: "Three faceted peppers on a clipped stem; mash and skewer stock.", category: "item" },
  6108: { name: "Coilreed Stalks", description: "Cut spiral stalk bundle beaded with syrup; syrup stock.", category: "item" },
  6109: { name: "Nightplums", description: "Four dark fruit in a shallow field tray; preserve and pie stock.", category: "item" },
  6201: { name: "Gene Sampler", description: "Takes genetic samples from living creatures and crops.", category: "tool" },
  6202: { name: "Splice Bench", description: "Portable bench for splicing sampled genomes.", category: "tool" },
  6203: { name: "Genome Scanner", description: "Reads the full genome off a sample or seed.", category: "tool" },
  6204: { name: "Culture Medium", description: "Growth substrate consumed by splice work.", category: "item" },
  6205: { name: "Mutagen", description: "Splice reagent that pushes a genome toward new traits.", category: "item" },
  6206: { name: "Stabilizer", description: "Splice reagent that locks in a genome's current traits.", category: "item" },
  6207: { name: "Serum", description: "Refined biological serum used in advanced splice work.", category: "item" },
  6208: { name: "Gene-Lock Kit", description: "Seals a finished genome against further splicing.", category: "item" },
  6301: { name: "Irrigation Sprinkler", description: "Placeable sprinkler that waters nearby farm tiles.", category: "tool" },
  6310: { name: "Growth Tonic", description: "Fertilizer that speeds crop growth on one tile.", category: "item" },
  6311: { name: "Quality Compost", description: "Fertilizer that raises crop quality on one tile.", category: "item" },
  6312: { name: "Yield Booster", description: "Fertilizer that raises harvest yield on one tile.", category: "item" },
  6313: { name: "Light Density Matrix", description: "White additive cassette, violet accent, one pip; density-grade crafting stock.", category: "item" },
  6314: { name: "Medium Density Matrix", description: "White additive cassette, violet accent, two pips; density-grade crafting stock.", category: "item" },
  6315: { name: "Heavy Density Matrix", description: "White additive cassette, violet accent, three pips; density-grade crafting stock.", category: "item" },
  6316: { name: "Light Savor Matrix", description: "White additive cassette, orange accent, one pip; savor-grade crafting stock.", category: "item" },
  6317: { name: "Medium Savor Matrix", description: "White additive cassette, orange accent, two pips; savor-grade crafting stock.", category: "item" },
  6318: { name: "Heavy Savor Matrix", description: "White additive cassette, orange accent, three pips; savor-grade crafting stock.", category: "item" },
  6319: { name: "Light Nutrient Matrix", description: "White additive cassette, green accent, one pip; nutrient-grade crafting stock.", category: "item" },
  6320: { name: "Medium Nutrient Matrix", description: "White additive cassette, green accent, two pips; nutrient-grade crafting stock.", category: "item" },
  6321: { name: "Heavy Nutrient Matrix", description: "White additive cassette, green accent, three pips; nutrient-grade crafting stock.", category: "item" },
  6322: { name: "Light Batch Matrix", description: "White additive cassette, blue accent, one pip; batch-grade crafting stock.", category: "item" },
  6323: { name: "Medium Batch Matrix", description: "White additive cassette, blue accent, two pips; batch-grade crafting stock.", category: "item" },
  6324: { name: "Heavy Batch Matrix", description: "White additive cassette, blue accent, three pips; batch-grade crafting stock.", category: "item" },
  6401: { name: "Ashgrain Meal", description: "Open hex tub of milled straw-gold meal; dough and cake base.", category: "item" },
  6402: { name: "Sunmelon Press", description: "Windowed gable canister of pressed orange pulp; cooking base.", category: "item" },
  6403: { name: "Cavemoss Extract", description: "Paired teal ampoules in a low rack; broth and steep base.", category: "item" },
  6404: { name: "Emberbean Curd", description: "Pressed red-white curd block in a slotted tray; griddle stock.", category: "item" },
  6405: { name: "Riftroot Starch", description: "Chamfered violet-marked fiber sack of root starch; thickener.", category: "item" },
  6406: { name: "Brineleaf Salt", description: "Octagonal shaker tub of blue salt crystals; seasoning stock.", category: "item" },
  6407: { name: "Glasspepper Mash", description: "Squat windowed canister of chartreuse mash; marinade stock.", category: "item" },
  6408: { name: "Coilreed Syrup", description: "Flat-sided amber flask with guarded cap; glaze and bar binder.", category: "item" },
  6409: { name: "Nightplum Preserve", description: "Clamp-lid octagonal jar of indigo preserve; pie filling.", category: "item" },
  6410: { name: "Field Dough", description: "Proofing dough on a stamped tray under cloth; loaf and bun base.", category: "item" },
  6411: { name: "Hearth Broth", description: "Low steel flask with a copper heat band; soup and stew base.", category: "item" },
  6412: { name: "Clodmeat Mince", description: "Wrapped russet protein brick in a drain tray; meat dish base.", category: "item" },
  6413: { name: "Ferment Culture", description: "Bone-white cartridge with a pale-green window; ferment starter.", category: "item" },
  6414: { name: "Rendered Fat", description: "Sealed square tin of cream cooking fat; frying stock.", category: "item" },
  6415: { name: "Seasoning Brick", description: "Scored spice brick in a paper-fiber sleeve; seasoning stock.", category: "item" },
  6501: { name: "Ashgrain Hearth Loaf", description: "Scored golden loaf served on a dark cutting board.", category: "item" },
  6502: { name: "Sunmelon Slicecake", description: "Layered orange cake wedge on a pressed plate.", category: "item" },
  6503: { name: "Cavemoss Broth", description: "Teal-green moss broth in a lidded field bowl.", category: "item" },
  6504: { name: "Emberbean Griddle Cakes", description: "Three red-brown bean cakes on a stamped tray.", category: "item" },
  6505: { name: "Riftroot Skillet Hash", description: "Purple-gold root hash in a square camp skillet.", category: "item" },
  6506: { name: "Brineleaf Noodle Bowl", description: "Blue-green noodles in a deep octagonal bowl.", category: "item" },
  6507: { name: "Glasspepper Clod Skewer", description: "Pepper and clodmeat pieces on two skewers over a board.", category: "item" },
  6508: { name: "Coilreed Glaze Bun", description: "Spiral amber-glazed bun in a shallow tin.", category: "item" },
  6509: { name: "Nightplum Hand Pie", description: "Crimped indigo-filled hand pie on a folded wrapper.", category: "item" },
  6510: { name: "Clodmeat Stew Tin", description: "Open square stew tin with root and meat chunks.", category: "item" },
  6511: { name: "Trail Ration Tray", description: "Compartment tray of grain, protein, greens, and fruit.", category: "item" },
  6512: { name: "Field Dumplings", description: "Five folded dumplings in a perforated field steamer.", category: "item" },
  6513: { name: "Smoked Clod Cutlet", description: "Sliced russet cutlet on an alloy service plate.", category: "item" },
  6514: { name: "Pressed Fruit Bar", description: "Two-tone fruit bar half-unwrapped from a fiber sleeve.", category: "item" },
  6515: { name: "Night Watch Soup", description: "Dark broth cup with bright grain and leaf garnish.", category: "item" },
  6516: { name: "Farmhand Breakfast", description: "Sectioned tray of ashgrain cake, emberbeans, and root hash.", category: "item" },
  6517: { name: "Spiced Riftroot Mash", description: "Violet root mash in a handled octagonal bowl.", category: "item" },
  6518: { name: "Harvest Layer Cake", description: "Small layer cake with crop-color bands on a board.", category: "item" },
  6519: { name: "Cavemoss Steep", description: "Teal hot steep in a lidded square cup.", category: "item" },
  6520: { name: "Sunmelon Cooler", description: "Chilled orange cooler in a flat-sided field bottle.", category: "item" },
  7103: { name: "Combat Helm", description: "Looted combat helmet.", category: "gear" },
  9002: { name: "Credit Chip", description: "Physical credit chip; its stack size is its value.", category: "currency" },
};

/** Canonical static item ids; presentation systems use this to prove coverage. */
export const INVENTORY_ITEM_DEFINITION_IDS: readonly number[] = Object.freeze(
  Object.keys(itemDefinitions).map(Number),
);

const resourceStatLabels: Record<string, string> = {
  C: "COND",
  M: "MALL",
  T: "TENS",
  P: "POT",
  S: "STAB",
  Y: "YIELD",
  F: "FLEX",
  N: "NUTR",
};


export function inventoryItemDisplay(row: InventoryRow): InventoryItemDisplay {
  const definition = itemDefinitions[row.itemId];
  const medical = medicalVariantChips(row);
  const resource = resourceStatChips(row.item);
  const chips = medical.length > 0
    ? medical
    : resource.length > 0
      ? resource
      : defaultVariantChips(row);
  return {
    name: definition?.name ?? simplifyInventoryName(row.item),
    description: definition?.description ?? fallbackDescription(row),
    category: definition?.category ?? "item",
    chips,
  };
}

function medicalVariantChips(row: InventoryRow): InventoryDisplayChip[] {
  // MEDIC WAVE: intermediate components (1201-1204) encode crafted quality directly
  // in the variant (0..1000) — the quality carry-through the craft window slots read.
  if (row.itemId >= 1201 && row.itemId <= 1204) {
    return [{ label: "QUAL", value: String(Math.min(1_000, Math.max(0, row.variantId))) }];
  }
  const encoded = row.variantId - 41_000_000;
  if (encoded < 0) return [];
  const kind = Math.floor(encoded / 1_000_000);
  // Medical kind codes (encode_medical_variant): stimpak=1, body=2, spirit=3,
  // advanced=4, anti-dizzy=5, anti-blind=6.
  const expectedKind =
    row.itemId === 1001 ? 1 :
    row.itemId === 1005 ? 2 :
    row.itemId === 1006 ? 3 :
    row.itemId === 1007 ? 4 :
    row.itemId === 1008 ? 5 :
    row.itemId === 1009 ? 6 : 0;
  if (expectedKind === 0 || kind !== expectedKind) return [];
  const stats = encoded % 1_000_000;
  const potency = Math.floor(stats / 1_000);
  const quantity = stats % 1_000;
  return [
    { label: "POT", value: String(potency) },
    { label: "BATCH", value: String(quantity) },
  ];
}

function resourceStatChips(item: string): InventoryDisplayChip[] {
  const chips: InventoryDisplayChip[] = [];
  for (const match of item.matchAll(/\b([CMTPSYFN])(\d{2,4})\b/gu)) {
    const label = match[1] ? resourceStatLabels[match[1]] : undefined;
    if (label) chips.push({ label, value: match[2] });
  }
  return chips.slice(0, 4);
}

function defaultVariantChips(row: InventoryRow): InventoryDisplayChip[] {
  if (row.variantId <= 0) return [];
  return [{ label: "VAR", value: String(row.variantId) }];
}

function simplifyInventoryName(item: string): string {
  const cleaned = item
    .replace(/\s+[CMPSTYFN]\d{2,4}\b/gu, "")
    .replace(/\s+P\d+\/Q\d+\b/gu, "")
    .trim();
  return cleaned || "Item";
}

function fallbackDescription(row: InventoryRow): string {
  if (row.variantId > 0) return `Variant ${row.variantId}`;
  return row.container;
}
