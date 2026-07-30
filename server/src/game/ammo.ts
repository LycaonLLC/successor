export type AmmoTypeId = "slug_iron" | "slug_shard" | "slug_spike" | "melee";

export const defaultAmmoTypeId: AmmoTypeId = "slug_iron";

export function normalizeAuthorityAmmoType(value: string | undefined | null): AmmoTypeId {
  switch (value) {
    case "slug_iron":
    case "slug_shard":
    case "slug_spike":
    case "melee":
      return value;
    default:
      return defaultAmmoTypeId;
  }
}
