import { describe, expect, it } from "vitest";

import type { ApproachBand, PursueBeat } from "../../game/pursue";
import { createVoiceMemory } from "../voice";
import { composePursueBeat } from "./pursue";

const RANGED: ApproachBand = { desiredCells: 12, maxCells: 20, melee: false };
const MELEE: ApproachBand = { desiredCells: 2, maxCells: 3, melee: true };

describe("pursue register", () => {
  it("ranged start speaks the gap and the gun's band; melee speaks reach", () => {
    const memory = createVoiceMemory();
    const ranged = composePursueBeat({ kind: "start", label: "Rogue trooper", dCells: 34.4, band: RANGED }, memory, 1);
    expect(ranged?.register).toBe("combat");
    expect(ranged?.text).toMatch(/34c/);
    const melee = composePursueBeat({ kind: "start", label: "Rogue trooper", dCells: 34.4, band: MELEE }, memory, 2);
    expect(melee?.text).toMatch(/reach|steel|weapon ready/);
  });

  it("level-off speaks the ranged band distance; melee closes in", () => {
    const memory = createVoiceMemory();
    const ranged = composePursueBeat({ kind: "level_off", label: "Rogue trooper", dCells: 11.7, band: RANGED }, memory, 3);
    expect(ranged?.text).toMatch(/12c|11c/);
    const melee = composePursueBeat({ kind: "level_off", label: "Rogue trooper", dCells: 1.8, band: MELEE }, memory, 4);
    expect(melee?.text).toMatch(/reach|guard|stride|edge/);
  });

  it("seeded no-repeat: the same situation twice in a row never speaks the same sentence", () => {
    const memory = createVoiceMemory();
    const beat: PursueBeat = { kind: "repursue", label: "Rogue trooper", dCells: 24 };
    const first = composePursueBeat(beat, memory, 100);
    const second = composePursueBeat(beat, memory, 100);
    expect(first?.text).not.toBe(second?.text);
  });

  it("deterministic under a fixed seed and fresh memory", () => {
    const a = composePursueBeat({ kind: "abort", reason: "timeout", label: "Rogue trooper" }, createVoiceMemory(), 7);
    const b = composePursueBeat({ kind: "abort", reason: "timeout", label: "Rogue trooper" }, createVoiceMemory(), 7);
    expect(a?.text).toBe(b?.text);
  });

  it("budget aborts carry the reject ink — honest denials read as denials", () => {
    const line = composePursueBeat({ kind: "abort", reason: "budget", label: "Rogue trooper" }, createVoiceMemory(), 9);
    expect(line?.register).toBe("reject");
    expect(line?.text).toMatch(/wire/);
  });

  it("every abort reason speaks", () => {
    const memory = createVoiceMemory();
    const reasons = ["target_dead", "target_lost", "player_move", "player_command", "budget", "timeout", "attack_denied", "too_far", "hurt"] as const;
    for (const reason of reasons) {
      const line = composePursueBeat({ kind: "abort", reason, label: "Rogue trooper", dCells: 120 }, memory, 11);
      expect(line, reason).not.toBeNull();
      expect(line!.text.length, reason).toBeGreaterThan(8);
    }
  });
});
