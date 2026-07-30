import { describe, expect, it } from "vitest";
import { creatureDeathBurstParticlePlan } from "./particles";

describe("creatureDeathBurstParticlePlan", () => {
  it("includes persistent residue splats in every creature death burst", () => {
    const plan = creatureDeathBurstParticlePlan(1);

    expect(plan.droplets).toBeGreaterThan(0);
    expect(plan.drips).toBeGreaterThan(0);
    expect(plan.residue).toBeGreaterThan(0);
  });

  it("keeps a floor of residue particles for low-damage lethal events", () => {
    expect(creatureDeathBurstParticlePlan(0.1).residue).toBeGreaterThanOrEqual(8);
  });
});
