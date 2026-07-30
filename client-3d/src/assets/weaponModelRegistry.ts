/**
 * Catalog weapon presentation registry. Item id wins over the legacy weapon id
 * because several catalog models share the slugthrower authority behavior.
 * Class, stats, and certifications remain server-authoritative.
 */
const WEAPON_MODEL_BY_ITEM: Readonly<Record<number, string>> = {
  3101: "wpn_smg",
  3105: "scrapline_machete",
  3106: "field_saber",
  3107: "quarry_chopper",
  3111: "wpn_smg",
  3112: "wpn_carbine",
  3121: "lightning_carbine",
};

const WEAPON_MODEL_BY_WEAPON_ID: Readonly<Record<string, string>> = {
  "scrapline-machete": "scrapline_machete",
  "field-saber": "field_saber",
  "quarry-chopper": "quarry_chopper",
  "wpn-pistol": "wpn_pistol",
  "wpn-smg": "wpn_smg",
  "wpn-carbine": "wpn_carbine",
  "lightning-carbine": "lightning_carbine",
  "wpn-assault": "wpn_assault",
  "wpn-shotgun": "wpn_shotgun",
  "wpn-sniper": "wpn_sniper",
  "wpn-heavy": "wpn_heavy",
  "wpn-launcher": "wpn_launcher",
};

export function weaponModelAssetKey(itemId: number, weaponId: string | null): string | null {
  if (itemId > 0 && WEAPON_MODEL_BY_ITEM[itemId]) return WEAPON_MODEL_BY_ITEM[itemId];
  if (weaponId && WEAPON_MODEL_BY_WEAPON_ID[weaponId]) return WEAPON_MODEL_BY_WEAPON_ID[weaponId];
  return null;
}
