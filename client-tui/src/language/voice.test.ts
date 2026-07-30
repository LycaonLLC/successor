import { describe, expect, it } from "vitest";

import { createRateGate, createVoiceMemory, pickVariant, rateGateAllows } from "./voice";

describe("voice variation engine", () => {
  it("is deterministic under a fixed seed and memory state", () => {
    const variants = ["alpha", "bravo", "charlie", "delta"];
    const run = (): string[] => {
      const memory = createVoiceMemory();
      return [101, 102, 103, 104].map((seed) => pickVariant(memory, "combat:hit", variants, seed));
    };
    expect(run()).toEqual(run());
  });

  it("never repeats the previous pick while alternatives exist", () => {
    const memory = createVoiceMemory();
    const variants = ["one", "two", "three"];
    let previous = "";
    for (let seed = 0; seed < 40; seed += 1) {
      const pick = pickVariant(memory, "arrive", variants, seed);
      expect(pick).not.toBe(previous);
      previous = pick;
    }
  });

  it("degrades gracefully with one variant (no starvation)", () => {
    const memory = createVoiceMemory();
    expect(pickVariant(memory, "solo", ["only line"], 1)).toBe("only line");
    expect(pickVariant(memory, "solo", ["only line"], 2)).toBe("only line");
  });

  it("keeps situations independent — memory in one key never blocks another", () => {
    const memory = createVoiceMemory();
    const a = pickVariant(memory, "key-a", ["x", "y"], 7);
    const b = pickVariant(memory, "key-b", ["x", "y"], 7);
    expect([a, b].every((value) => value === "x" || value === "y")).toBe(true);
  });

  it("rate gate opens, closes for the interval, then reopens", () => {
    const gate = createRateGate();
    expect(rateGateAllows(gate, "arrive", 1_000, 500)).toBe(true);
    expect(rateGateAllows(gate, "arrive", 1_200, 500)).toBe(false);
    expect(rateGateAllows(gate, "depart", 1_200, 500)).toBe(true); // separate key
    expect(rateGateAllows(gate, "arrive", 1_501, 500)).toBe(true);
  });
});
