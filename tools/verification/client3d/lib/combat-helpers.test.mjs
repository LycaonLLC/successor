import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { acquireTarget, fightToKill } from "../journeys/_helpers.mjs";

describe("client-3d combat journey target acquisition", () => {
  it("waits for the requested living hostile instead of accepting a stale selection", async () => {
    const stale = { selectedActorId: "already-downed-rogue" };
    const requested = { selectedActorId: "fresh-living-rogue" };
    const slash = vi.fn(async () => {});
    const waitProbe = vi.fn(async (predicate) => {
      expect(predicate(stale)).toBe(false);
      expect(predicate(requested)).toBe(true);
      return requested;
    });
    const s = {
      probe: vi.fn(async () => ({ nearestHostile: { id: "fresh-living-rogue", lifeState: "alive" } })),
      slash,
      waitProbe,
    };

    const acquired = await acquireTarget({ delay: vi.fn(async () => {}) }, s);

    expect(slash).toHaveBeenCalledWith("/target fresh-living-rogue");
    expect(acquired.selectedActorId).toBe("fresh-living-rogue");
  });
});

describe("client-3d combat journey kill proof", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function combatSession({ loopProbe, targetActor }) {
    const probes = [
      { downedCount: 0, playerActorId: "player", combatEventLog: [] },
      loopProbe,
      loopProbe,
    ];
    return {
      probe: vi.fn(async () => probes.shift() ?? loopProbe),
      slash: vi.fn(async () => {}),
      oracle: vi.fn(async () => ({ actors: targetActor ? { target: targetActor } : {} })),
    };
  }

  it("does not count an unrelated downed actor as the selected target's kill", async () => {
    const s = combatSession({
      loopProbe: { downedCount: 1, playerActorId: "player", combatEventLog: [] },
      targetActor: { lifeState: "alive", vitals: { health: 75 } },
    });

    const result = await fightToKill(
      { delay: vi.fn(async () => vi.advanceTimersByTime(5)) },
      s,
      "target",
      { timeoutMs: 1, reAttackMs: 60_000 },
    );

    expect(result.killed).toBe(false);
    expect(result.downedDelta).toBe(1);
  });

  it("does not count a released population actor as a kill", async () => {
    const s = combatSession({
      loopProbe: { downedCount: 0, playerActorId: "player", combatEventLog: [] },
      targetActor: null,
    });

    const result = await fightToKill(
      { delay: vi.fn(async () => vi.advanceTimersByTime(5)) },
      s,
      "target",
      { timeoutMs: 1, reAttackMs: 60_000 },
    );

    expect(result.killed).toBe(false);
  });

  it("counts the selected target's explicit downed lifecycle", async () => {
    const s = combatSession({
      loopProbe: { downedCount: 1, playerActorId: "player", combatEventLog: [] },
      targetActor: { lifeState: "downed", vitals: { health: 0 } },
    });

    const result = await fightToKill(
      { delay: vi.fn(async () => {}) },
      s,
      "target",
      { timeoutMs: 1_000, reAttackMs: 60_000 },
    );

    expect(result.killed).toBe(true);
  });
});
