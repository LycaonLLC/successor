import { describe, expect, it } from "vitest";
import {
  spawnFloatingStatusText,
  spawnBandageEffect,
  spawnFloatingDamage,
  spawnFloatingExperience,
  spawnInventoryTransferEffect,
  spawnPersonalShieldBlockEffect,
  spawnResourceSampleEffect,
  spawnStimpakEffect,
  tickVisualEffects,
  type VisualEffectState,
} from "./effectsSystem";

function effectsState(overrides: Partial<VisualEffectState> = {}): VisualEffectState {
  return {
    floatingTexts: [],
    nextFloatingTextId: 1,
    ...overrides,
  };
}

describe("effectsSystem", () => {
  it("ticks floating presentation text in place", () => {
    const state = effectsState({
      floatingTexts: [{
        id: 1,
        actorId: "target",
        x: 9,
        y: 10,
        driftX: 0.1,
        value: 5,
        label: null,
        ttlMs: 100,
        totalTtlMs: 100,
        color: "#f00",
        scale: 1,
      }],
    });

    tickVisualEffects(state, 50);
    expect(state.floatingTexts[0]!.ttlMs).toBe(50);

    tickVisualEffects(state, 60);
    expect(state.floatingTexts).toEqual([]);
  });

  it("keeps supported status feedback in the shared floating-text channel", () => {
    const state = effectsState();
    const actor = { x: 12, y: 9 };

    spawnStimpakEffect(state, actor, "target");
    spawnBandageEffect(state, actor, "target");
    spawnPersonalShieldBlockEffect(state, actor, "target");

    expect(state.floatingTexts.map((text) => ({ actorId: text.actorId, label: text.label, color: text.color }))).toEqual([
      { actorId: "target", label: "STIMPAK", color: "#ff4c66" },
      { actorId: "target", label: "BANDAGE", color: "#fff0ca" },
      { actorId: "target", label: "PSG", color: "#9dfcff" },
    ]);
  });

  it("keeps inventory and resource feedback renderer-neutral", () => {
    const state = effectsState();
    const actor = { x: 4, y: 6 };

    spawnInventoryTransferEffect(state, actor, { actorId: "player", label: "+AMMO", color: "#ffd36b" });
    spawnResourceSampleEffect(state, actor, "player", "+IRON", "#72f4a1");

    expect(state.floatingTexts.map((text) => ({ actorId: text.actorId, label: text.label }))).toEqual([
      { actorId: "player", label: "+AMMO" },
      { actorId: "player", label: "+IRON" },
    ]);
  });

  it("spawns capped floating damage with head and down labels", () => {
    const state = effectsState();

    spawnFloatingDamage(state, { x: 4, y: 8 }, 12, "head", false, "target");
    spawnFloatingDamage(state, { x: 4, y: 8 }, 99, "torso", true, "target");

    expect(state.floatingTexts[0]).toMatchObject({ id: 1, actorId: "target", x: 4.5, y: 6.45, value: 12, label: "HEAD", color: "#ffe66d" });
    expect(state.floatingTexts[1]).toMatchObject({ id: 2, actorId: "target", value: 99, label: "DOWN", color: "#ffffff" });

    for (let index = 0; index < 140; index += 1) {
      spawnFloatingDamage(state, { x: 1, y: 2 }, index, "torso", false);
    }

    expect(state.floatingTexts).toHaveLength(128);
    expect(state.floatingTexts[0]!.id).toBe(15);
  });

  it("formats private XP gain text", () => {
    const state = effectsState();

    spawnFloatingExperience(state, { x: 8, y: 6 }, 70, "scout xp", "#73f7a8", "player");

    expect(state.floatingTexts[0]).toMatchObject({
      actorId: "player",
      value: null,
      label: "+70 SCOUT XP",
      color: "#73f7a8",
    });
  });

  it("suppresses duplicate live status labels on the same actor", () => {
    const state = effectsState();
    const actor = { x: 3, y: 4 };
    spawnFloatingStatusText(state, actor, "MISS", "#bac4cf", "target");
    spawnFloatingStatusText(state, actor, "MISS", "#bac4cf", "target");
    spawnFloatingStatusText(state, actor, "DODGE", "#e9fbff", "target");
    spawnFloatingStatusText(state, actor, "MISS", "#bac4cf", "other");
    expect(state.floatingTexts.map((text) => `${text.actorId}:${text.label}`)).toEqual([
      "target:MISS",
      "target:DODGE",
      "other:MISS",
    ]);
  });
});
