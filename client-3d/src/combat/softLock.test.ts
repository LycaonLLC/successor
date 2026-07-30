import { describe, expect, it } from "vitest";
import type { PlayState, ServerAuthorityActorState } from "@successor/client/src/slice-core/gameState";
import { explicitLockTargetId, isLockableHostile, setExplicitLockTarget, setMaxAcquireRangeFromWeaponMax, updateSoftLock } from "./softLock";

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
  };
}

function playState(actors: Record<string, ServerAuthorityActorState>): PlayState {
  return {
    softLockActorId: null,
    serverAuthority: {
      actors,
    },
  } as unknown as PlayState;
}

describe("isLockableHostile", () => {
  it("treats live farmable creatures as prey even before aggro", () => {
    const me = actor({ id: "player", factionId: "desert_wardens" });
    // Gaia wildlife: neutral `gaia` faction (no enemies) must not exclude it.
    const bellback = actor({ id: "open-desert-bellback-01-1", label: "bellback grazer", role: "creature", factionId: "gaia" });

    expect(isLockableHostile(bellback, me)).toBe(true);
  });

  it("keeps non-creature civilians and downed creatures out of the attack lock", () => {
    const me = actor({ id: "player", factionId: "desert_wardens" });
    expect(isLockableHostile(actor({ id: "trainer", role: "profession_trainer", factionId: null }), me)).toBe(false);
    expect(isLockableHostile(actor({ id: "open-desert-bellback-01-1", role: "creature", factionId: "gaia", lifeState: "downed" }), me)).toBe(false);
  });
});

describe("updateSoftLock", () => {
  it("keeps an explicit target locked instead of flickering to the cone candidate", () => {
    setMaxAcquireRangeFromWeaponMax(undefined);
    setExplicitLockTarget("target-a");
    const state = playState({
      player: actor({ id: "player", factionId: "desert_wardens", x: 0, y: 0 }),
      "target-a": actor({ id: "target-a", factionId: "rogue_troopers", x: 15, y: 5 }),
      "hostile-b": actor({ id: "hostile-b", factionId: "rogue_troopers", x: 5, y: 0 }),
    });

    const target = updateSoftLock(state, "player");

    expect(target).toMatchObject({ actorId: "target-a" });
    expect(state.softLockActorId).toBe("target-a");
    expect(explicitLockTargetId()).toBe("target-a");
    setExplicitLockTarget(null);
  });
});
