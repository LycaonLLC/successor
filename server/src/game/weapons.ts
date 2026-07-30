import { defaultAmmoTypeId, normalizeAuthorityAmmoType, type AmmoTypeId } from "./ammo.js";

export const authorityWeaponIds = [
  "slugthrower",
  "vibrosword",
  "scrapline-machete",
  "field-saber",
  "quarry-chopper",
  "unarmed",
  "wpn-pistol",
  "wpn-smg",
  "wpn-carbine",
  "lightning-carbine",
  "wpn-assault",
  "wpn-shotgun",
  "wpn-sniper",
  "wpn-heavy",
  "wpn-launcher",
] as const;
export type AuthorityWeaponId = typeof authorityWeaponIds[number];

export interface AuthorityWeaponProfile {
  id: AuthorityWeaponId;
  defaultAmmoType: AmmoTypeId;
  compatibleAmmoTypes: readonly AmmoTypeId[];
}

export const authorityWeaponProfiles: Record<AuthorityWeaponId, AuthorityWeaponProfile> = {
  slugthrower: {
    id: "slugthrower",
    defaultAmmoType: defaultAmmoTypeId,
    compatibleAmmoTypes: ["slug_iron", "slug_shard", "slug_spike"],
  },
  vibrosword: {
    id: "vibrosword",
    defaultAmmoType: "melee",
    compatibleAmmoTypes: ["melee"],
  },
  "scrapline-machete": {
    id: "scrapline-machete",
    defaultAmmoType: "melee",
    compatibleAmmoTypes: ["melee"],
  },
  "field-saber": {
    id: "field-saber",
    defaultAmmoType: "melee",
    compatibleAmmoTypes: ["melee"],
  },
  "quarry-chopper": {
    id: "quarry-chopper",
    defaultAmmoType: "melee",
    compatibleAmmoTypes: ["melee"],
  },
  unarmed: {
    id: "unarmed",
    defaultAmmoType: "melee",
    compatibleAmmoTypes: ["melee"],
  },
  "wpn-pistol": {
    id: "wpn-pistol",
    defaultAmmoType: defaultAmmoTypeId,
    compatibleAmmoTypes: ["slug_iron", "slug_shard", "slug_spike"],
  },
  "wpn-smg": {
    id: "wpn-smg",
    defaultAmmoType: defaultAmmoTypeId,
    compatibleAmmoTypes: ["slug_iron", "slug_shard", "slug_spike"],
  },
  "wpn-carbine": {
    id: "wpn-carbine",
    defaultAmmoType: defaultAmmoTypeId,
    compatibleAmmoTypes: ["slug_iron", "slug_shard", "slug_spike"],
  },
  "lightning-carbine": {
    id: "lightning-carbine",
    defaultAmmoType: defaultAmmoTypeId,
    compatibleAmmoTypes: ["slug_iron", "slug_shard", "slug_spike"],
  },
  "wpn-assault": {
    id: "wpn-assault",
    defaultAmmoType: defaultAmmoTypeId,
    compatibleAmmoTypes: ["slug_iron", "slug_shard", "slug_spike"],
  },
  "wpn-shotgun": {
    id: "wpn-shotgun",
    defaultAmmoType: defaultAmmoTypeId,
    compatibleAmmoTypes: ["slug_iron", "slug_shard", "slug_spike"],
  },
  "wpn-sniper": {
    id: "wpn-sniper",
    defaultAmmoType: defaultAmmoTypeId,
    compatibleAmmoTypes: ["slug_iron", "slug_shard", "slug_spike"],
  },
  "wpn-heavy": {
    id: "wpn-heavy",
    defaultAmmoType: defaultAmmoTypeId,
    compatibleAmmoTypes: ["slug_iron", "slug_shard", "slug_spike"],
  },
  "wpn-launcher": {
    id: "wpn-launcher",
    defaultAmmoType: defaultAmmoTypeId,
    compatibleAmmoTypes: ["slug_iron", "slug_shard", "slug_spike"],
  },
};

const authorityWeaponMagazineSizes = {
  slugthrower: 30,
  vibrosword: 1,
  "scrapline-machete": 1,
  "field-saber": 1,
  "quarry-chopper": 1,
  unarmed: 1,
  "wpn-pistol": 30,
  "wpn-smg": 30,
  "wpn-carbine": 30,
  "lightning-carbine": 30,
  "wpn-assault": 30,
  "wpn-shotgun": 30,
  "wpn-sniper": 30,
  "wpn-heavy": 30,
  "wpn-launcher": 30,
} as const satisfies Record<AuthorityWeaponId, number>;

export function authorityWeaponMagazineSize(weaponId: AuthorityWeaponId): number {
  return authorityWeaponMagazineSizes[weaponId];
}

export function isAuthorityWeaponId(value: string | undefined | null): value is AuthorityWeaponId {
  return Boolean(value && value in authorityWeaponProfiles);
}

export function authorityWeaponProfile(value: AuthorityWeaponId): AuthorityWeaponProfile {
  return authorityWeaponProfiles[value];
}

export function normalizeAuthorityWeaponAmmoType(
  weapon: AuthorityWeaponProfile,
  value: string | undefined | null,
): AmmoTypeId {
  const ammoType = normalizeAuthorityAmmoType(value);
  return weapon.compatibleAmmoTypes.includes(ammoType) ? ammoType : weapon.defaultAmmoType;
}
