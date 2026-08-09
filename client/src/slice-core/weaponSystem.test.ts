import { describe, expect, it } from "vitest";
import {
  allWeaponIds,
  isMeleeAmmoTypeId,
  isMeleeWeaponId,
  isMeleeWeaponPresentation,
  weaponSpecs,
  weaponSpecUsesMeleeAmmo,
} from "./weaponSystem";
import { ammoTypeSpecs, ammoTypesByCaliber, defaultAmmoByCaliber, type AmmoCaliberId } from "./ammoSystem";

describe("weaponSystem melee presentation predicate", () => {
  it("classifies melee presentation from the weapon catalog ammo family", () => {
    expect(weaponSpecs.vibrosword.defaultAmmoType).toBe("melee");

    expect(weaponSpecUsesMeleeAmmo(weaponSpecs.vibrosword)).toBe(true);
    expect(weaponSpecUsesMeleeAmmo(weaponSpecs["scrapline-machete"])).toBe(true);
    expect(weaponSpecUsesMeleeAmmo(weaponSpecs["field-saber"])).toBe(true);
    expect(weaponSpecUsesMeleeAmmo(weaponSpecs["quarry-chopper"])).toBe(true);
    expect(weaponSpecUsesMeleeAmmo(weaponSpecs.unarmed)).toBe(true);
    expect(weaponSpecUsesMeleeAmmo(weaponSpecs["slugthrower"])).toBe(false);

    expect(isMeleeWeaponId("vibrosword")).toBe(true);
    expect(isMeleeWeaponId("scrapline-machete")).toBe(true);
    expect(isMeleeWeaponId("field-saber")).toBe(true);
    expect(isMeleeWeaponId("quarry-chopper")).toBe(true);
    expect(isMeleeWeaponId("unarmed")).toBe(true);
    expect(isMeleeWeaponId("slugthrower")).toBe(false);
  });

  it("treats explicit melee ammo on an event as melee presentation", () => {
    expect(isMeleeAmmoTypeId("melee")).toBe(true);
    expect(isMeleeWeaponPresentation(undefined, "melee")).toBe(true);
    expect(isMeleeWeaponPresentation("slugthrower", "melee")).toBe(true);
    expect(isMeleeWeaponPresentation("slugthrower", "slug_iron")).toBe(false);
    expect(isMeleeWeaponPresentation("vibrosword", undefined)).toBe(true);
  });
});

describe("canonical weapon and ammunition catalog", () => {
  it("exposes canonical Slugthrower identity and loadout metadata without client combat balance", () => {
    const spec = weaponSpecs.slugthrower;
    expect(spec).toBeDefined();
    expect(spec.id).toBe("slugthrower");
    expect(spec.name).toBe("Slugthrower");
    expect(spec.iconKey).toBe("slugthrower");
    expect(spec.caliber).toBe("slug");
    expect(spec.defaultAmmoType).toBe("slug_iron");
    expect(spec.magazineSize).toBe(30);
    expect(spec.compatibleAmmoTypes).toEqual(["slug_iron", "slug_shard", "slug_spike"]);
    expect(Object.keys(spec)).not.toEqual(expect.arrayContaining([
      "rpm",
      "cooldownMs",
      "pellets",
      "spreadDeg",
      "damage",
      "penetration",
      "suppression",
      "effectiveRangeCells",
      "minimumRangeMultiplier",
      "damageKind",
    ]));
  });

  it("maps Slugthrower ammo types with stable catalog metadata", () => {
    expect(ammoTypeSpecs.slug_iron.id).toBe("slug_iron");
    expect(ammoTypeSpecs.slug_iron.caliber).toBe("slug");
    expect(ammoTypeSpecs.slug_iron.name).toBe("Iron Slug");

    expect(ammoTypeSpecs.slug_shard.id).toBe("slug_shard");
    expect(ammoTypeSpecs.slug_shard.caliber).toBe("slug");
    expect(ammoTypeSpecs.slug_shard.name).toBe("Shard Slug");

    expect(ammoTypeSpecs.slug_spike.id).toBe("slug_spike");
    expect(ammoTypeSpecs.slug_spike.caliber).toBe("slug");
    expect(ammoTypeSpecs.slug_spike.name).toBe("Spike Slug");

    expect(defaultAmmoByCaliber.slug).toBe("slug_iron");
    expect(ammoTypesByCaliber.slug).toEqual(["slug_iron", "slug_shard", "slug_spike"]);
  });

  it("contains exactly the supported weapon and ammunition ids", () => {
    expect(allWeaponIds).toEqual([
      "slugthrower",
      "wpn-pistol",
      "wpn-smg",
      "wpn-carbine",
      "lightning-carbine",
      "wpn-assault",
      "wpn-shotgun",
      "wpn-sniper",
      "wpn-heavy",
      "wpn-launcher",
      "vibrosword",
      "scrapline-machete",
      "field-saber",
      "quarry-chopper",
      "unarmed",
    ]);
    expect(Object.keys(ammoTypeSpecs)).toEqual(["slug_iron", "slug_shard", "slug_spike", "melee"]);

    for (const id of allWeaponIds) {
      const spec = weaponSpecs[id];
      expect(spec.compatibleAmmoTypes).toContain(spec.defaultAmmoType);
    }

    for (const caliber of Object.keys(ammoTypesByCaliber) as AmmoCaliberId[]) {
      for (const ammoId of ammoTypesByCaliber[caliber]) {
        expect(ammoTypeSpecs[ammoId].caliber).toBe(caliber);
      }
    }
  });
});
