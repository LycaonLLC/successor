import { describe, expect, it } from "vitest";
import {
  actorArchetypeRoleIds,
  actorArchetypeSchema,
  baseActorEffectiveStats,
  baseActorMaxVitals,
  baseActorRegenRates,
  baseActorVitals,
  baseActorTraits,
  createBodyZones,
} from "./actorArchetypes";

describe("actorArchetypes", () => {
  it("loads the versioned actor archetype spec", () => {
    expect(actorArchetypeSchema).toBe("successor.actor-archetypes.v1");
    expect(actorArchetypeRoleIds).toEqual(["agent_player", "creature", "player", "public_shopkeeper", "range_guard", "scripted_player", "skirmisher", "skirmisher_anchor", "skirmisher_assault", "skirmisher_brawler", "skirmisher_deadeye", "skirmisher_flanker"]);
  });

  it("preserves current player, shopkeeper, creature, and skirmisher tuning", () => {
    expect(baseActorVitals({ role: "player" })).toEqual({ health: 100, action: 100, spirit: 100 });
    expect(baseActorRegenRates({ role: "player" })).toEqual({ health: 1, action: 24, spirit: 2.1 });
    expect(baseActorTraits({ role: "agent_player" })).toEqual({ body: 145, spirit: 130 });
    expect(baseActorTraits({ role: "public_shopkeeper" })).toEqual({ body: 92, spirit: 86 });
    expect(baseActorMaxVitals({ role: "public_shopkeeper" })).toEqual({ health: 100, action: 100, spirit: 100 });
    expect(baseActorVitals({ role: "creature" })).toEqual({ health: 75, action: 75, spirit: 75 });
    expect(baseActorTraits({ role: "skirmisher" })).toEqual({ body: 74, spirit: 68 });
    expect(baseActorVitals({ role: "skirmisher" })).toEqual({ health: 74, action: 73.1, spirit: 68 });
    expect(baseActorTraits({ role: "skirmisher_assault" })).toEqual({ body: 80, spirit: 58 });
    expect(baseActorTraits({ role: "skirmisher_anchor" })).toEqual({ body: 86, spirit: 82 });
    expect(baseActorTraits({ role: "skirmisher_flanker" })).toEqual({ body: 72, spirit: 76 });
    expect(baseActorTraits({ role: "skirmisher_deadeye" })).toEqual({ body: 68, spirit: 92 });
    expect(baseActorTraits({ role: "skirmisher_brawler" })).toEqual({ body: 124, spirit: 62 });
    expect(baseActorEffectiveStats({ role: "agent_player" }).movementSpeedMultiplier).toBe(1);
    expect(baseActorEffectiveStats({ role: "skirmisher" }).movementSpeedMultiplier).toBe(0.9);
    expect(baseActorEffectiveStats({ role: "agent_player" }).movementSpeedMultiplier).toBeGreaterThanOrEqual(
      baseActorEffectiveStats({ role: "skirmisher" }).movementSpeedMultiplier * 1.1,
    );
  });

  it("derives one effective stats object from Body/Spirit traits", () => {
    expect(baseActorTraits({ role: "creature" })).toEqual({ body: 75, spirit: 75 });
    expect(baseActorEffectiveStats({ role: "creature" })).toMatchObject({
      traits: { body: 75, spirit: 75 },
      spawnVitals: { health: 75, action: 75, spirit: 75 },
      maxVitals: { health: 100, action: 100, spirit: 100 },
      suppressionThreshold: 18,
    });
  });

  it("maps role armor into body zones", () => {
    expect(createBodyZones({ role: "range_guard" })).toMatchObject({
      head: { hp: 28, maxHp: 28, armor: 1 },
      torso: { hp: 54, maxHp: 54, armor: 4 },
      left_arm: { hp: 32, maxHp: 32, armor: 2 },
      right_arm: { hp: 32, maxHp: 32, armor: 2 },
      legs: { hp: 40, maxHp: 40, armor: 2 },
    });
    expect(createBodyZones({ role: "unknown" }).torso.armor).toBe(0);
  });

  it("returns cloned values so actor state can mutate safely", () => {
    const vitals = baseActorVitals({ role: "player" });
    vitals.health = 1;

    expect(baseActorVitals({ role: "player" }).health).toBe(100);
  });
});
