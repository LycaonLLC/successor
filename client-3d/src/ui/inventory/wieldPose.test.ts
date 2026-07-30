import { describe, expect, it } from "vitest";
import { resolveWieldPose } from "./wieldPose";

describe("resolveWieldPose", () => {
  it.each([
    { armed: false, inCombat: true, holdWeapon: false, stowed: false },
    { armed: false, inCombat: false, holdWeapon: false, stowed: false },
    { armed: false, inCombat: undefined, holdWeapon: false, stowed: false },
    { armed: true, inCombat: true, holdWeapon: true, stowed: false },
    { armed: true, inCombat: false, holdWeapon: false, stowed: true },
    { armed: true, inCombat: false, reloading: true, holdWeapon: true, stowed: false },
    { armed: false, inCombat: false, reloading: true, holdWeapon: false, stowed: false },
    { armed: true, inCombat: undefined, holdWeapon: false, stowed: true },
  ])(
    "armed=$armed inCombat=$inCombat reloading=$reloading -> hold=$holdWeapon stowed=$stowed",
    ({ armed, inCombat, reloading, holdWeapon, stowed }) => {
      expect(resolveWieldPose({ armed, inCombat, reloading })).toEqual({ holdWeapon, stowed });
    },
  );
});
