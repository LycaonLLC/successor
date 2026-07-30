import type { CertificateId } from "./combatTypes";
import type { AmmoCaliberId, AmmoTypeId } from "./ammoSystem";
import weaponSpecPayload from "./specs/weapons.v1.json";

export type WeaponId =
  | "slugthrower"
  | "wpn-smg"
  | "wpn-carbine"
  | "lightning-carbine"
  | "vibrosword"
  | "scrapline-machete"
  | "field-saber"
  | "quarry-chopper"
  | "unarmed";
export type EquipmentSlot = "longGun";
export type WeaponIconKey = "slugthrower" | "sword";

export interface WeaponSpec {
  id: WeaponId;
  name: string;
  shortName: string;
  slot: EquipmentSlot;
  caliber: AmmoCaliberId;
  compatibleAmmoTypes: AmmoTypeId[];
  defaultAmmoType: AmmoTypeId;
  requiredCert: CertificateId | null;
  magazineSize: number;
  reloadMs: number;
  iconKey: WeaponIconKey;
  reloadSfx: string;
}

type WeaponSpecPayloadEntry = WeaponSpec;

interface WeaponSpecPayload {
  schema: "successor.weapon-catalog.v1";
  weapons: Record<string, WeaponSpecPayloadEntry>;
}

export const weaponSpecs: Record<WeaponId, WeaponSpec> = parseWeaponSpecPayload(weaponSpecPayload);

export const allWeaponIds = Object.keys(weaponSpecs) as WeaponId[];
export const weaponIds = allWeaponIds;
const weaponIdSet = new Set<string>(allWeaponIds);

export function isWeaponId(value: string): value is WeaponId {
  return weaponIdSet.has(value);
}

export function isMeleeAmmoTypeId(value: string | null | undefined): value is AmmoTypeId {
  return value === "melee";
}

export function weaponSpecUsesMeleeAmmo(spec: Pick<WeaponSpec, "caliber" | "compatibleAmmoTypes" | "defaultAmmoType">): boolean {
  return spec.caliber === "melee"
    || spec.defaultAmmoType === "melee"
    || spec.compatibleAmmoTypes.includes("melee");
}

export function isMeleeWeaponId(value: string | null | undefined): value is WeaponId {
  return typeof value === "string" && isWeaponId(value) && weaponSpecUsesMeleeAmmo(weaponSpecs[value]);
}

export function isMeleeWeaponPresentation(weaponId: string | null | undefined, ammoTypeId?: string | null): boolean {
  return isMeleeAmmoTypeId(ammoTypeId) || isMeleeWeaponId(weaponId);
}

function parseWeaponSpecPayload(payload: unknown): Record<WeaponId, WeaponSpec> {
  const parsed = payload as Partial<WeaponSpecPayload>;
  if (parsed.schema !== "successor.weapon-catalog.v1" || !parsed.weapons) {
    throw new Error("weapon catalog schema mismatch");
  }
  const weapons = parsed.weapons as Partial<Record<WeaponId, WeaponSpecPayloadEntry>>;
  const slugthrower = validateWeaponSpec(weapons.slugthrower, "slugthrower");
  const wpnSmg = validateWeaponSpec(weapons["wpn-smg"], "wpn-smg");
  const wpnCarbine = validateWeaponSpec(weapons["wpn-carbine"], "wpn-carbine");
  const lightningCarbine = validateWeaponSpec(weapons["lightning-carbine"], "lightning-carbine");
  const vibrosword = validateWeaponSpec(weapons.vibrosword, "vibrosword");
  const scraplineMachete = validateWeaponSpec(weapons["scrapline-machete"], "scrapline-machete");
  const fieldSaber = validateWeaponSpec(weapons["field-saber"], "field-saber");
  const quarryChopper = validateWeaponSpec(weapons["quarry-chopper"], "quarry-chopper");
  const unarmed = validateWeaponSpec(weapons.unarmed, "unarmed");
  for (const ranged of [slugthrower, wpnSmg, wpnCarbine, lightningCarbine]) {
    if (ranged.slot !== "longGun" || ranged.caliber !== "slug") {
      throw new Error(`${ranged.id} weapon slot/ammo contract mismatch`);
    }
    if (ranged.requiredCert !== "cert_rifle" || ranged.iconKey !== "slugthrower") {
      throw new Error(`${ranged.id} weapon semantic contract mismatch`);
    }
  }
  if (vibrosword.slot !== "longGun" || vibrosword.caliber !== "melee") {
    throw new Error("vibrosword weapon slot/ammo contract mismatch");
  }
  if (vibrosword.requiredCert !== "cert_brawler" || vibrosword.iconKey !== "sword") {
    throw new Error("vibrosword weapon semantic contract mismatch");
  }
  for (const primitive of [scraplineMachete, fieldSaber, quarryChopper, unarmed]) {
    if (primitive.caliber !== "melee" || primitive.requiredCert !== null) {
      throw new Error(`${primitive.id} weapon semantic contract mismatch`);
    }
  }
  return {
    slugthrower,
    "wpn-smg": wpnSmg,
    "wpn-carbine": wpnCarbine,
    "lightning-carbine": lightningCarbine,
    vibrosword,
    "scrapline-machete": scraplineMachete,
    "field-saber": fieldSaber,
    "quarry-chopper": quarryChopper,
    unarmed,
  };
}

function validateWeaponSpec(spec: WeaponSpecPayloadEntry | undefined, expectedId: WeaponId): WeaponSpec {
  if (!spec || spec.id !== expectedId) {
    throw new Error(`weapon spec missing ${expectedId}`);
  }
  if (!spec.compatibleAmmoTypes.includes(spec.defaultAmmoType)) {
    throw new Error(`${expectedId} default ammo type is not compatible`);
  }
  for (const [field, value] of Object.entries({
    magazineSize: spec.magazineSize,
    reloadMs: spec.reloadMs,
  })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${expectedId} weapon numeric field invalid: ${field}`);
  }
  return { ...spec };
}
