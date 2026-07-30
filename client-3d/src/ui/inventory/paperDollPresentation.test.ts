import { describe, expect, it } from "vitest";
import { resolvePaperDollWeaponPresentation } from "./paperDollPresentation";

describe("paper-doll weapon presentation parity", () => {
  it("renders no weapon for absent or explicitly unarmed authority state", () => {
    expect(resolvePaperDollWeaponPresentation(null)).toEqual({
      lane: "none",
      modelKey: null,
      visible: false,
    });
    expect(resolvePaperDollWeaponPresentation("unarmed")).toEqual({
      lane: "none",
      modelKey: null,
      visible: false,
    });
  });

  it("keeps legacy weapons on their authored fallback rigs", () => {
    expect(resolvePaperDollWeaponPresentation("slugthrower")).toEqual({
      lane: "rifle",
      modelKey: null,
      visible: true,
    });
    expect(resolvePaperDollWeaponPresentation("vibrosword")).toEqual({
      lane: "melee",
      modelKey: null,
      visible: true,
    });
  });

  it("resolves current catalog ranged models instead of hiding them", () => {
    expect(resolvePaperDollWeaponPresentation("wpn-smg")).toMatchObject({
      lane: "rifle",
      modelKey: "wpn_smg",
      visible: true,
    });
    expect(resolvePaperDollWeaponPresentation("slugthrower", 3112)).toMatchObject({
      lane: "rifle",
      modelKey: "wpn_carbine",
      visible: true,
    });
    expect(resolvePaperDollWeaponPresentation("lightning-carbine", 3121)).toMatchObject({
      lane: "rifle",
      modelKey: "lightning_carbine",
      visible: true,
    });
  });

  it("resolves every current catalog melee model on the melee rig", () => {
    expect(resolvePaperDollWeaponPresentation("scrapline-machete", 3105)).toMatchObject({
      lane: "melee",
      modelKey: "scrapline_machete",
      visible: true,
    });
    expect(resolvePaperDollWeaponPresentation("field-saber", 3106)).toMatchObject({
      lane: "melee",
      modelKey: "field_saber",
      visible: true,
    });
    expect(resolvePaperDollWeaponPresentation("quarry-chopper", 3107)).toMatchObject({
      lane: "melee",
      modelKey: "quarry_chopper",
      visible: true,
    });
  });
});
