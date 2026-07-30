import { describe, expect, it } from "vitest";
import {
  authorityActorCanSprint,
  authorityMovementDistanceCells,
  authoritySprintActionCost,
} from "./authorityMovementSystem";
import type { ServerAuthorityActorState } from "./gameState";

function actor(skillBoxes: string[]): ServerAuthorityActorState {
  return {
    id: "player",
    label: "Field Observer",
    role: "agent_player",
    areaId: "open-desert-overworld",
    x: 0,
    y: 0,
    direction: "right",
    lifeState: "alive",
    lifecycleSeq: 1,
    vitals: { health: 100, action: 100, spirit: 100 },
    maxVitals: { health: 100, action: 100, spirit: 100 },
    bleed: { active: false, stackCount: 0, severity: 0, remainingMs: 0, ratesPerSecond: { health: 0, action: 0, spirit: 0 } },
    statuses: [],
    professions: skillBoxes.length > 0
      ? [{ id: skillBoxes[0]!.split("-")[0]!, label: "Profession", xp: 0, skillPoints: 0, skillBoxes }]
      : [],
  };
}

describe("authorityMovementSystem", () => {
  it("mirrors server-authoritative Scout traversal and sprint modifiers", () => {
    const noviceScout = actor(["scout-novice"]);
    const masterScout = actor([
      "scout-novice",
      "scout-traversal-i",
      "scout-traversal-ii",
      "scout-traversal-iii",
      "scout-traversal-iv",
      "scout-sprinting-i",
      "scout-sprinting-ii",
      "scout-sprinting-iii",
      "scout-sprinting-iv",
      "scout-master",
    ]);

    const noviceSprint = authorityMovementDistanceCells(noviceScout, null, 30, 30, true);
    const masterSprint = authorityMovementDistanceCells(masterScout, null, 30, 30, true);

    expect(masterSprint).toBeGreaterThan(noviceSprint * 1.4);
    expect(authoritySprintActionCost(masterScout, 30, 30)).toBeLessThan(authoritySprintActionCost(noviceScout, 30, 30));
  });

  it("includes Brawler movement-speed boxes in local prediction", () => {
    const noviceBrawler = actor(["brawler-novice"]);
    const trainedBrawler = actor([
      "brawler-novice",
      "brawler-movement-speed-i",
      "brawler-movement-speed-ii",
      "brawler-movement-speed-iii",
      "brawler-movement-speed-iv",
    ]);

    expect(authorityMovementDistanceCells(trainedBrawler, null, 30, 30, false))
      .toBeGreaterThan(authorityMovementDistanceCells(noviceBrawler, null, 30, 30, false));
  });

  it("keeps sprint eligibility actor-aware", () => {
    const masterScout = actor(["scout-novice", "scout-sprinting-i", "scout-sprinting-ii", "scout-sprinting-iii", "scout-sprinting-iv", "scout-master"]);
    masterScout.vitals.action = authoritySprintActionCost(masterScout, 30, 30) - 1;

    expect(authorityActorCanSprint(masterScout, null, 30, 30)).toBe(false);
    masterScout.vitals.action += 1;
    expect(authorityActorCanSprint(masterScout, null, 30, 30)).toBe(true);
  });
});
