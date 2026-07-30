import { describe, expect, it } from "vitest";

import { deriveActorLongArcProfile } from "./actorLongArcProfile.js";
import type { GameActorStatsSnapshot } from "./protocol.js";

describe("deriveActorLongArcProfile", () => {
  it("summarizes lifetime combat, recent pressure, and engagement history", () => {
    const stats = statsFixture({
      damageDone: 320,
      damageTaken: 110,
      kills: 3,
      deaths: 1,
      shotsFired: 40,
      hitsDealt: 18,
      distanceMovedCells: 38,
      recent60s: recentFixture({
        damageDone: 120,
        damageTaken: 20,
        kills: 1,
        shotsFired: 12,
        hitsDealt: 7,
        distanceMovedCells: 10,
      }),
    });

    expect(deriveActorLongArcProfile(stats)).toMatchObject({
      schema: "successor.actor-long-arc-profile.v1",
      sample: "authority_lifetime",
      combat: {
        hitRate: 0.45,
        killDeathRatio: 3,
        damageTradeRatio: 2.909,
        netDamage: 210,
      },
      recent: {
        pressureScore: 0.714,
        damageDone60s: 120,
        damageTaken60s: 20,
      },
    });
  });

});

function statsFixture(overrides: Partial<GameActorStatsSnapshot> = {}): Omit<GameActorStatsSnapshot, "longArc"> {
  return {
    damageDone: 0,
    damageTaken: 0,
    kills: 0,
    npcKills: 0,
    playerKills: 0,
    deaths: 0,
    shotsFired: 0,
    hitsDealt: 0,
    hitsTaken: 0,
    distanceMovedCells: 0,
    lastDamageDealtTick: null,
    lastDamageTakenTick: null,
    lastKillTick: null,
    lastDeath: null,
    recent10s: recentFixture(),
    recent60s: recentFixture(),
    ...overrides,
  };
}

function recentFixture(overrides: Partial<GameActorStatsSnapshot["recent60s"]> = {}): GameActorStatsSnapshot["recent60s"] {
  return {
    windowSeconds: 60,
    damageDone: 0,
    damageTaken: 0,
    kills: 0,
    npcKills: 0,
    playerKills: 0,
    deaths: 0,
    shotsFired: 0,
    hitsDealt: 0,
    hitsTaken: 0,
    distanceMovedCells: 0,
    ...overrides,
  };
}
