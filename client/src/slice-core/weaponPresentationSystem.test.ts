import { describe, expect, it } from "vitest";

import type { PlayState } from "./gameState";
import {
  expireWeaponFireAnimations,
  triggerWeaponFireAnimation,
  triggerWeaponReloadAnimation,
} from "./weaponPresentationSystem";

function state(): Pick<PlayState, "weaponFireAnimations" | "worldTimeMs" | "actorWeaponIds"> {
  return { weaponFireAnimations: {}, worldTimeMs: 1_000, actorWeaponIds: {} };
}

describe("weaponPresentationSystem", () => {
  it("records server-driven fire and reload montages without sprite atlases", () => {
    const play = state();

    triggerWeaponFireAnimation(play, "actor-1", "slugthrower");
    expect(play.weaponFireAnimations["actor-1"]).toMatchObject({
      weaponId: "slugthrower",
      kind: "fire",
      startedAtMs: 1_000,
    });
    expect(play.actorWeaponIds["actor-1"]).toBe("slugthrower");

    triggerWeaponReloadAnimation(play, "actor-1", "slugthrower", 275.4);
    expect(play.weaponFireAnimations["actor-1"]).toMatchObject({ kind: "reload", durationMs: 275 });
  });

  it.each(["vibrosword", "scrapline-machete", "field-saber", "quarry-chopper", "unarmed"] as const)(
    "keeps every semantic melee fire trigger alive for the melee presentation window: %s",
    (weaponId) => {
      const play = state();

      triggerWeaponFireAnimation(play, "actor-1", weaponId);

      expect(play.weaponFireAnimations["actor-1"]).toMatchObject({
        weaponId,
        kind: "fire",
        durationMs: 420,
      });
    },
  );

  it("expires completed presentation montages", () => {
    const play = state();
    triggerWeaponFireAnimation(play, "actor-1", "slugthrower");
    play.worldTimeMs = 1_500;

    expireWeaponFireAnimations(play);

    expect(play.weaponFireAnimations).toEqual({});
  });
});
