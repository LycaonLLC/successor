import { describe, expect, it } from "vitest";
import type { PlayState, ServerAuthorityActorState } from "@successor/client/src/slice-core/gameState";
import { targetStateChips } from "./targetPlate";

function actor(overrides: Partial<ServerAuthorityActorState>): ServerAuthorityActorState {
  return {
    id: "actor",
    label: "Actor",
    areaId: "desert",
    x: 0,
    y: 0,
    direction: "front",
    lifeState: "alive",
    lifecycleSeq: 1,
    vitals: { health: 100, action: 100, spirit: 100 },
    maxVitals: { health: 100, action: 100, spirit: 100 },
    bleed: {
      active: false,
      stackCount: 0,
      severity: 0,
      remainingMs: 0,
      ratesPerSecond: { health: 0, action: 0, spirit: 0 },
    },
    statuses: [],
    ...overrides,
  } as ServerAuthorityActorState;
}

function playState(actors: Record<string, ServerAuthorityActorState>): PlayState {
  return {
    playerActorId: "player",
    serverAuthority: { playerActorId: "player", actors },
  } as unknown as PlayState;
}

describe("targetStateChips", () => {
  it("leads with attitude and posture, then statuses, capped at four", () => {
    const state = playState({
      "rogue-1": actor({ id: "rogue-1", aiAttitude: "hostile", posture: "kneeling" }),
    });
    const chips = targetStateChips(state, "rogue-1", true, [
      { id: "bleeding", label: "Bleeding" },
      { id: "suppressed", label: "Suppressed" },
      { id: "winded", label: "Winded" },
    ]);

    expect(chips.map((chip) => `${chip.kind}:${chip.label}`)).toEqual([
      "hostile:HOSTILE",
      "posture:KNEELING",
      "status:Bleeding",
      "status:Suppressed",
    ]);
  });

  it("maps alerted, skips passive attitude and transitional standing_up posture", () => {
    const state = playState({
      "grub-1": actor({ id: "grub-1", aiAttitude: "alerted", posture: "standing_up" }),
      "grub-2": actor({ id: "grub-2", aiAttitude: "passive", posture: "standing" }),
    });

    expect(targetStateChips(state, "grub-1", true, [])).toEqual([
      { kind: "alerted", label: "ALERTED" },
    ]);
    expect(targetStateChips(state, "grub-2", true, [])).toEqual([]);
  });

  it("drops attitude/posture chips for dead targets and for the player self", () => {
    const state = playState({
      "rogue-1": actor({ id: "rogue-1", aiAttitude: "hostile", posture: "kneeling" }),
      player: actor({ id: "player", aiAttitude: "hostile", posture: "kneeling" }),
    });

    expect(targetStateChips(state, "rogue-1", false, [{ id: "dead", label: "Dead" }])).toEqual([
      { kind: "status", label: "Dead" },
    ]);
    expect(targetStateChips(state, "player", true, [])).toEqual([]);
  });
});
