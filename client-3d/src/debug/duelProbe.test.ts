import { describe, expect, it } from "vitest";
import {
  createEmptyDuelProbeState,
  syncDuelOutcomeProbeTail,
  syncDuelProbeState,
} from "./duelProbe";

describe("duelProbe sync", () => {
  it("copies active duel scalars without aliasing the authority view", () => {
    const target = createEmptyDuelProbeState();
    const activeDuel = {
      duelId: 9,
      opponentActorId: "rival",
      opponentName: "Rival",
      startedTick: 10,
      expiresTick: 100,
    };
    const view = {
      activeDuel,
      incomingChallenge: { otherActorId: "x", otherName: "X", issuedTick: 1, expiresTick: 2 },
      outgoingChallenge: null,
    };
    syncDuelProbeState(target, view);
    expect(target).toMatchObject({
      hasActiveDuel: true,
      activeDuelId: 9,
      opponentActorId: "rival",
      opponentName: "Rival",
      startedTick: 10,
      expiresTick: 100,
      hasIncomingChallenge: true,
      hasOutgoingChallenge: false,
    });
    // Mutating the authority object must not bleed into the probe projection.
    activeDuel.opponentName = "CHANGED";
    expect(target.opponentName).toBe("Rival");
  });

  it("clears active duel fields when the view drops the duel", () => {
    const target = createEmptyDuelProbeState();
    syncDuelProbeState(target, {
      activeDuel: {
        duelId: 1,
        opponentActorId: "a",
        opponentName: "A",
        startedTick: 1,
        expiresTick: 2,
      },
    });
    syncDuelProbeState(target, {});
    expect(target.hasActiveDuel).toBe(false);
    expect(target.activeDuelId).toBe(0);
    expect(target.opponentActorId).toBe("");
    expect(target.opponentName).toBe("");
  });

  it("updates the outcome tail in place without retaining authority object identity", () => {
    const target: { duelId: number; opponentName: string; result: string; reason: string; tick: number }[] = [];
    const first = {
      actorId: "player",
      duelId: 3,
      opponentActorId: "rival",
      opponentName: "Rival",
      result: "won" as const,
      reason: "yield" as const,
      tick: 44,
    };
    syncDuelOutcomeProbeTail(target, [first]);
    expect(target).toHaveLength(1);
    expect(target[0]).toMatchObject({
      duelId: 3,
      opponentName: "Rival",
      result: "won",
      reason: "yield",
      tick: 44,
    });
    const row = target[0]!;
    first.opponentName = "NOPE";
    expect(row.opponentName).toBe("Rival");
    // Same storage slot reused on the next frame.
    syncDuelOutcomeProbeTail(target, [{
      ...first,
      opponentName: "Rival",
      reason: "down",
      tick: 50,
    }]);
    expect(target).toHaveLength(1);
    expect(target[0]).toBe(row);
    expect(row.reason).toBe("down");
    expect(row.tick).toBe(50);
  });
});
