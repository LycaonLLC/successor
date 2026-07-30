export interface ResourceTaxonomyEntry {
  itemId: number;
  name: string;
  path: readonly string[];
}

export const resourceTaxonomyEntries = [
  { itemId: 2001, name: "Iron", path: ["Inorganic", "Mineral", "Metal", "Iron"] },
  { itemId: 2002, name: "Petrochemical", path: ["Inorganic", "Chemical", "Petrochemical"] },
  { itemId: 2003, name: "Flora", path: ["Organic", "Plant", "Flora"] },
  { itemId: 2004, name: "Gas", path: ["Inorganic", "Gas"] },
  { itemId: 2005, name: "Liquid", path: ["Inorganic", "Liquid"] },
  { itemId: 2006, name: "Clodpowder", path: ["Organic", "Creature Structural", "Clodpowder"] },
  { itemId: 2007, name: "Copper", path: ["Inorganic", "Mineral", "Metal", "Copper"] },
  { itemId: 2008, name: "Carbon", path: ["Inorganic", "Mineral", "Carbon"] },
  { itemId: 2009, name: "Fuel", path: ["Inorganic", "Chemical", "Fuel"] },
  { itemId: 2010, name: "Polymer", path: ["Inorganic", "Chemical", "Polymer"] },
  { itemId: 2101, name: "Hide", path: ["Organic", "Creature Structural", "Hide"] },
  { itemId: 2102, name: "Clodmeat", path: ["Organic", "Creature Food", "Clodmeat"] },
  { itemId: 2103, name: "Clodbone", path: ["Organic", "Creature Structural", "Bone"] },
  { itemId: 2104, name: "Tissue", path: ["Organic", "Creature Structural", "Tissue"] },
] as const satisfies readonly ResourceTaxonomyEntry[];

export const resourceTaxonomyByItemId: ReadonlyMap<number, ResourceTaxonomyEntry> = new Map(
  resourceTaxonomyEntries.map((entry) => [entry.itemId, entry]),
);
