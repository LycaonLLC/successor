export type AmmoCaliberId = "slug" | "melee";
export type AmmoTypeId = "slug_iron" | "slug_shard" | "slug_spike" | "melee";
export type AmmoIconKey = "slugIron" | "slugShard" | "slugSpike" | "melee";

export interface AmmoTypeSpec {
  id: AmmoTypeId;
  caliber: AmmoCaliberId;
  name: string;
  shortName: string;
  inventoryLabel: string;
  description: string;
  iconKey: AmmoIconKey;
}

export const ammoTypeSpecs: Record<AmmoTypeId, AmmoTypeSpec> = {
  slug_iron: {
    id: "slug_iron",
    caliber: "slug",
    name: "Iron Slug",
    shortName: "Iron Slug",
    inventoryLabel: "Iron Slug",
    description: "Standard iron slug for the Slugthrower.",
    iconKey: "slugIron",
  },
  slug_shard: {
    id: "slug_shard",
    caliber: "slug",
    name: "Shard Slug",
    shortName: "Shard Slug",
    inventoryLabel: "Shard Slug",
    description: "Shard slug ammunition for the Slugthrower.",
    iconKey: "slugShard",
  },
  slug_spike: {
    id: "slug_spike",
    caliber: "slug",
    name: "Spike Slug",
    shortName: "Spike Slug",
    inventoryLabel: "Spike Slug",
    description: "Spike slug ammunition for the Slugthrower.",
    iconKey: "slugSpike",
  },
  melee: {
    id: "melee",
    caliber: "melee",
    name: "Melee",
    shortName: "Melee",
    inventoryLabel: "Melee",
    description: "Direct contact attack profile.",
    iconKey: "melee",
  },
};

export const defaultAmmoByCaliber: Record<AmmoCaliberId, AmmoTypeId> = {
  slug: "slug_iron",
  melee: "melee",
};

export const ammoTypesByCaliber: Record<AmmoCaliberId, readonly AmmoTypeId[]> = {
  slug: ["slug_iron", "slug_shard", "slug_spike"],
  melee: ["melee"],
};

const ammoTypeIds = new Set<string>(Object.keys(ammoTypeSpecs));

export function isAmmoTypeId(value: string): value is AmmoTypeId {
  return ammoTypeIds.has(value);
}

export function ammoTypesForCaliber(caliber: AmmoCaliberId): readonly AmmoTypeId[] {
  return ammoTypesByCaliber[caliber];
}

export function defaultAmmoTypeForCaliber(caliber: AmmoCaliberId): AmmoTypeId {
  return defaultAmmoByCaliber[caliber];
}

export function normalizeAmmoTypeForCaliber(caliber: AmmoCaliberId, ammoTypeId: AmmoTypeId | null | undefined): AmmoTypeId {
  return ammoTypeId && ammoTypeSpecs[ammoTypeId]?.caliber === caliber
    ? ammoTypeId
    : defaultAmmoTypeForCaliber(caliber);
}
