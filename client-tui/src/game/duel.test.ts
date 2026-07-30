import { describe, expect, it } from "vitest";

import { createTuiPlayStateFixture } from "../../test/fixtures/playState";
import { composeDuelOutcome, duelStatusLines, parseDuelOutcome, type GameDuelView } from "./duel";

const outcome = (result: "won" | "lost" | "dissolved", reason: "yield" | "down" | "range" | "timeout" | "disconnect") =>
  parseDuelOutcome({ actorId: "me", duelId: 1, opponentActorId: "them", opponentName: "Rusk", result, reason, tick: 100 })!;

describe("duel outcome voice (DEF-5 green half)", () => {
  it("parses only contract-shaped payloads", () => {
    expect(parseDuelOutcome(null)).toBeNull();
    expect(parseDuelOutcome({ result: "banana", reason: "yield" })).toBeNull();
    expect(parseDuelOutcome({ result: "won", reason: "yield", opponentName: "Rusk" })).not.toBeNull();
  });

  it("speaks the win perspective-relative; yield and fall differ", () => {
    expect(composeDuelOutcome(outcome("won", "yield"))!.text).toBe("«Rusk» lowers their weapon — the duel is yours.");
    expect(composeDuelOutcome(outcome("won", "down"))!.text).toBe("«Rusk» falls — the duel is yours.");
  });

  it("dissolutions name their reason; a loss closes quietly", () => {
    expect(composeDuelOutcome(outcome("dissolved", "range"))!.text).toContain("too far apart");
    expect(composeDuelOutcome(outcome("dissolved", "timeout"))!.text).toContain("time runs out");
    expect(composeDuelOutcome(outcome("dissolved", "disconnect"))!.text).toContain("link lost");
    expect(composeDuelOutcome(outcome("lost", "yield"))!.text).toBe("The duel is «Rusk»'s.");
  });
});

describe("bare /duel over the streamed view", () => {
  it("no stream → usage steer", () => {
    const { state } = createTuiPlayStateFixture();
    const text = duelStatusLines(state, 4512, 30).map((line) => line.text).join("\n");
    expect(text).toContain("No duel on the ground");
  });

  it("active duel + challenges render with countdowns", () => {
    const { state } = createTuiPlayStateFixture();
    (state.serverAuthority as { duel?: GameDuelView }).duel = {
      activeDuel: { duelId: 3, opponentActorId: "rusk", opponentName: "Rusk", startedTick: 4000, expiresTick: 22_512 },
      incomingChallenge: { otherActorId: "vane", otherName: "Vane", issuedTick: 4400, expiresTick: 4512 + 300 },
      outgoingChallenge: null,
    };
    const text = duelStatusLines(state, 4512, 30).map((line) => line.text).join("\n");
    expect(text).toContain("You are dueling «Rusk»");
    expect(text).toContain("«Vane» has thrown the glove — /duel accept or /duel decline (10s).");
  });
});
