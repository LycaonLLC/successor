import { describe, expect, it } from "vitest";
import { boltStyleForWeapon } from "./config";

describe("boltStyleForWeapon", () => {
  it("gives the energy weapons their bolt identities", () => {
    expect(boltStyleForWeapon("lightning-carbine")).toBe("arc");
    expect(boltStyleForWeapon("wpn-carbine")).toBe("plasma");
    expect(boltStyleForWeapon("sleep-dart-pistol")).toBe("needle");
  });

  it("keeps ballistic as the firearm default", () => {
    expect(boltStyleForWeapon("slugthrower")).toBe("ballistic");
    expect(boltStyleForWeapon(undefined)).toBe("ballistic");
    expect(boltStyleForWeapon(null)).toBe("ballistic");
  });
});
