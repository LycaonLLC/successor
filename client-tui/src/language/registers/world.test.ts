import { describe, expect, it } from "vitest";

import { createVoiceMemory } from "../voice";
import {
  composeArrivalLine,
  composeAttitudeShift,
  composeCorpseLootable,
  composeDepartureLine,
  composeGroupArrivalLine,
  subjectName,
  subjectWithType,
} from "./world";

describe("world register", () => {
  it("hostile arrivals carry bearing, band, and armed state", () => {
    const line = composeArrivalLine(
      { label: "Rogue trooper", relation: "hostile", dx: -24, dy: -24, inCombat: true },
      createVoiceMemory(),
      1,
    );
    expect(line).toMatch(/rogue trooper/i);
    expect(line).toMatch(/north/);
    expect(line).toMatch(/weapon drawn/);
  });

  it("civilian arrivals stay quiet in tone", () => {
    const line = composeArrivalLine(
      { label: "Dust farmer", relation: "civilian", dx: 3, dy: 3, inCombat: false },
      createVoiceMemory(),
      2,
    );
    expect(line).toMatch(/dust farmer/i);
    expect(line).not.toMatch(/weapon/);
  });

  it("crowds coalesce into one sentence", () => {
    const contacts = [1, 2, 3].map((n) => ({ label: `Raider ${n}`, relation: "hostile" as const, dx: -10, dy: -10, inCombat: false }));
    const line = composeGroupArrivalLine(contacts, createVoiceMemory(), 3);
    expect(line).toMatch(/three/i);
    expect(line).toMatch(/hostiles/);
  });

  it("departures name the wind they left by", () => {
    const line = composeDepartureLine({ label: "Rogue trooper", lastDx: 40, lastDy: -40 }, createVoiceMemory(), 4);
    expect(line).toMatch(/east/);
  });

  it("attitude hardening speaks; softening stays silent", () => {
    expect(composeAttitudeShift("Dust farmer", "hostile", createVoiceMemory(), 5)).toMatch(/weapon|hostile/i);
    expect(composeAttitudeShift("Dust farmer", "civilian", createVoiceMemory(), 6)).toBeNull();
  });

  it("corpse beats respect loot rights", () => {
    expect(composeCorpseLootable("Rogue trooper", true, createVoiceMemory(), 7)).toMatch(/yours/i);
    expect(composeCorpseLootable("Rogue trooper", false, createVoiceMemory(), 8)).toMatch(/not yours/i);
  });

  it("subjectName articles generic roles and passes named characters through", () => {
    expect(subjectName("Rogue trooper")).toBe("a rogue trooper");
    expect(subjectName("Warden")).toBe("Warden");
    expect(subjectName("")).toBe("something");
  });

  it("intro reads carry the actor descriptor as an appositive: '<Name>, a <type>'", () => {
    expect(subjectWithType("Dax Vale", "a rogue drifter")).toBe("Dax Vale, a rogue drifter");
    expect(subjectWithType("Dax Vale")).toBe("Dax Vale");
    const line = composeArrivalLine(
      { label: "Dax Vale", descriptor: "a rogue drifter", relation: "hostile", dx: -10, dy: -10, inCombat: false },
      createVoiceMemory(),
      9,
    );
    expect(line).toContain("Dax Vale, a rogue drifter");
  });
});
