import { describe, expect, it } from "vitest";

import { createVoiceMemory } from "../voice";
import { composeCombatLine, type CombatEventInputs } from "./combat";

function event(overrides: Partial<CombatEventInputs>): CombatEventInputs {
  return {
    shooterId: "me",
    targetId: "rogue-1",
    shooterLabel: "you",
    targetLabel: "Rogue trooper",
    meId: "me",
    hit: true,
    damage: 14,
    zone: "torso",
    actionId: "basic_shot",
    effectKind: undefined,
    lifecycleKind: undefined,
    rollMilli: 613,
    toHitMilli: 540,
    verbose: false,
    ...overrides,
  };
}

describe("combat register", () => {
  it("speaks own hits in second person with zone flavor and damage", () => {
    const line = composeCombatLine(event({}), createVoiceMemory(), 1);
    expect(line).toMatch(/you|your/i);
    expect(line).toMatch(/rogue trooper/i);
    expect(line).toContain("chest");
    expect(line).toContain("14");
  });

  it("speaks incoming hits as the shooter's work on you", () => {
    const line = composeCombatLine(event({ shooterId: "rogue-1", targetId: "me", shooterLabel: "Rogue trooper", targetLabel: "you", zone: "legs" }), createVoiceMemory(), 2);
    expect(line).toMatch(/you/i);
    expect(line).toContain("legs");
  });

  it("keeps third-party fire to a whisper", () => {
    const line = composeCombatLine(event({ shooterId: "a", targetId: "b", shooterLabel: "Raider", targetLabel: "Dust farmer" }), createVoiceMemory(), 3);
    expect(line).toMatch(/trades fire/i);
  });

  it("narrates misses, dodges and shields distinctly", () => {
    const memory = createVoiceMemory();
    expect(composeCombatLine(event({ hit: false }), memory, 4)).toMatch(/wide|rush|miss/i);
    expect(composeCombatLine(event({ effectKind: "dodge" }), memory, 5)).toMatch(/dodge|dive|slides|off the line/i);
    expect(composeCombatLine(event({ effectKind: "shield" }), memory, 6)).toMatch(/shield/i);
  });

  it("gives kills terminal weight over the hit wording", () => {
    const line = composeCombatLine(event({ lifecycleKind: "killed" }), createVoiceMemory(), 7);
    expect(line).toMatch(/dead|drops|does not move|done/i);
    expect(line).not.toMatch(/roll/);
  });

  it("appends the roll arithmetic only in verbose", () => {
    const verbose = composeCombatLine(event({ verbose: true }), createVoiceMemory(), 8);
    expect(verbose).toContain("(roll 613 v 540)");
    const quiet = composeCombatLine(event({}), createVoiceMemory(), 8);
    expect(quiet).not.toContain("roll");
  });

  it("varies repeated identical situations without repeating the last line", () => {
    const memory = createVoiceMemory();
    const first = composeCombatLine(event({}), memory, 10);
    const second = composeCombatLine(event({}), memory, 11);
    expect(second).not.toBe(first);
  });

  it("speaks your own death plainly", () => {
    const line = composeCombatLine(event({ shooterId: "rogue-1", targetId: "me", lifecycleKind: "killed" }), createVoiceMemory(), 12);
    expect(line).toMatch(/you are dead/i);
  });
});
