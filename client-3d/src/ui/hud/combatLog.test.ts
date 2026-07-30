import { describe, expect, it } from "vitest";
import type { AuthorityClientCommandKind } from "@successor/client/src/slice-core/authorityCommandSystem";
import type { PlayState, ServerAuthorityCombatEventState } from "@successor/client/src/slice-core/gameState";
import { combatReasonCopy, createCombatLogFeed, duelOpponentLabel, formatDuelOutcomeLine } from "./combatLog";

/** Minimal PlayState slice the feed reads — everything else untouched. */
interface FeedRig {
  state: PlayState;
  pushEvent(overrides: Partial<ServerAuthorityCombatEventState>): void;
  pushReject(commandId: number, kind: AuthorityClientCommandKind, reasonCode: string): void;
  pushAccept(commandId: number, kind: AuthorityClientCommandKind): void;
  setTrackXp(professionId: string, label: string, tracks: Record<string, number>): void;
}

function rig(): FeedRig {
  let eventSeq = 0;
  const state = {
    playerActorId: "me",
    serverAuthority: {
      playerActorId: "me",
      snapshotTick: 100,
      lastReceipt: null,
      receiptLog: [] as Array<{
        commandId: number;
        accepted: boolean;
        tick: number;
        reasonCode?: string;
        receivedAtMs: number;
      }>,
      sentCommandLog: [] as Array<{ commandId: number; kind: AuthorityClientCommandKind; sentAtMs: number }>,
      eventLog: [] as ServerAuthorityCombatEventState[],
      duelOutcomes: [] as Array<{
        actorId: string;
        duelId: number;
        opponentActorId: string;
        opponentName: string;
        result: string;
        reason: string;
        tick: number;
      }>,
      actors: {
        me: { id: "me", label: "HudProbe", professions: [] as unknown[] },
        rogue: { id: "rogue", label: "Juno Rill (a rogue trooper)" },
        other: { id: "other", label: "Bystander" },
      },
    },
  } as unknown as PlayState;
  return {
    state,
    pushEvent(overrides) {
      eventSeq += 1;
      state.serverAuthority.eventLog.push({
        id: eventSeq,
        tick: 100 + eventSeq,
        shooterActorId: "me",
        targetActorId: "rogue",
        damage: 0,
        zone: "torso",
        previousLifeState: "alive",
        lifeState: "alive",
        targetLifecycleSeq: 0,
        bleedStackCount: 0,
        kind: "ranged_roll",
        actionId: "basic_shot",
        receivedAtMs: 1000 + eventSeq,
        ...overrides,
      } as ServerAuthorityCombatEventState);
    },
    pushReject(commandId: number, kind: AuthorityClientCommandKind, reasonCode: string) {
      state.serverAuthority.sentCommandLog.push({ commandId, kind, sentAtMs: 0 });
      state.serverAuthority.receiptLog.push({
        commandId,
        accepted: false,
        tick: 120,
        reasonCode,
        receivedAtMs: 2000 + commandId,
      });
    },
    pushAccept(commandId: number, kind: AuthorityClientCommandKind) {
      state.serverAuthority.sentCommandLog.push({ commandId, kind, sentAtMs: 0 });
      state.serverAuthority.receiptLog.push({
        commandId,
        accepted: true,
        tick: 121,
        receivedAtMs: 2100 + commandId,
      });
    },
    setTrackXp(professionId, label, tracks) {
      const me = state.serverAuthority.actors.me as unknown as { professions: unknown[] };
      const professions = me.professions as {
        id: string;
        label: string;
        xp: number;
        trackXp?: Record<string, number>;
        skillPoints: number;
      }[];
      const existing = professions.find((profession) => profession.id === professionId);
      if (existing) existing.trackXp = { ...tracks };
      else professions.push({ id: professionId, label, xp: 0, trackXp: { ...tracks }, skillPoints: 0 });
    },
  };
}

describe("combat log feed", () => {
  it("describes outgoing hits with damage, zone, and weapon label", () => {
    const r = rig();
    const feed = createCombatLogFeed(r.state);
    r.pushEvent({ hit: true, damage: 3 });
    const lines = feed.drain();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      // C1: clean name (type read stripped) + damage number IS the hit.
      text: "YOU → JUNO RILL · SHOT −3 TORSO",
      tone: "out-good",
    });
    // Cursor: nothing new → nothing drained.
    expect(feed.drain()).toHaveLength(0);
  });

  it("classifies miss / dodge / shield-deflect on both directions", () => {
    const r = rig();
    const feed = createCombatLogFeed(r.state);
    r.pushEvent({ hit: false });
    r.pushEvent({ shooterActorId: "rogue", targetActorId: "me", hit: true, damage: 9, zone: "legs" });
    r.pushEvent({ hit: true, effect: { kind: "dodge" } });
    r.pushEvent({ hit: true, effect: { kind: "shield", stacks: 2, threshold: 3, remainingMs: 500 } });
    const [miss, incoming, dodge, deflect] = feed.drain();
    expect(miss).toMatchObject({ text: "YOU → JUNO RILL · SHOT MISS", tone: "out-bad" });
    expect(incoming).toMatchObject({ text: "JUNO RILL → YOU · SHOT −9 LEGS", tone: "in-bad" });
    expect(dodge).toMatchObject({ text: "JUNO RILL DODGED YOUR SHOT", tone: "out-bad" });
    expect(deflect).toMatchObject({
      text: "JUNO RILL BLOCKED YOUR SHOT (SHIELD 2/3)",
      tone: "out-bad",
    });
  });

  it("celebrates my killing blow and emphasizes my own death with killer + weapon", () => {
    const r = rig();
    const feed = createCombatLogFeed(r.state);
    r.pushEvent({
      hit: true,
      damage: 4,
      lifecycle: { kind: "killed", from: "downed", to: "respawning", cause: "shot" },
    });
    r.pushEvent({
      shooterActorId: "rogue",
      targetActorId: "me",
      hit: true,
      damage: 12,
      lifecycle: { kind: "downed", from: "alive", to: "downed", cause: "shot" },
    });
    const [kill, death] = feed.drain();
    expect(kill).toMatchObject({
      text: "KILL — JUNO RILL FALLS · SHOT −4",
      tone: "kill",
      emphasis: true,
    });
    expect(death).toMatchObject({
      text: "YOU WERE DOWNED BY JUNO RILL · SHOT −12",
      tone: "death",
      emphasis: true,
    });
  });

  it("emphasizes outgoing downed without inventing a kill", () => {
    const r = rig();
    const feed = createCombatLogFeed(r.state);
    r.pushEvent({
      hit: true,
      damage: 7,
      lifecycle: { kind: "downed", from: "alive", to: "downed", cause: "shot" },
    });
    const [line] = feed.drain();
    expect(line).toMatchObject({
      text: "JUNO RILL DOWNED · SHOT −7",
      tone: "kill",
      emphasis: true,
    });
  });

  it("ignores third-party events entirely", () => {
    const r = rig();
    const feed = createCombatLogFeed(r.state);
    r.pushEvent({ shooterActorId: "rogue", targetActorId: "other", hit: true, damage: 5 });
    expect(feed.drain()).toHaveLength(0);
  });

  it("surfaces rejected combat receipts only for combat command kinds", () => {
    const r = rig();
    const feed = createCombatLogFeed(r.state);
    r.pushReject(11, "QueueCombatAction", "out_of_range");
    r.pushReject(12, "Move", "occupied");
    r.pushReject(13, "Peace", "wrong_combat_model");
    r.pushReject(14, "CancelAbilityQueue", "queue_entry_unknown");
    const lines = feed.drain();
    expect(lines.map((entry) => entry.text)).toEqual([
      "ATTACK DENIED · RANGE",
      "STAND DOWN DENIED · WRONG MODE",
      "CLEAR DENIED · NOT QUEUED",
    ]);
    expect(lines.every((entry) => entry.tone === "reject")).toBe(true);
  });

  it("announces accepted Peace as STAND DOWN without treating it as a reject", () => {
    const r = rig();
    const feed = createCombatLogFeed(r.state);
    r.pushAccept(21, "Peace");
    r.pushAccept(22, "QueueCombatAction"); // accepted attack stays silent
    const lines = feed.drain();
    expect(lines.map((entry) => entry.text)).toEqual(["STAND DOWN"]);
    expect(lines[0]?.tone).toBe("info");
  });

  it("suppresses duplicate identical lines across drains", () => {
    const r = rig();
    const feed = createCombatLogFeed(r.state);
    r.pushReject(31, "QueueCombatAction", "insufficient_action");
    expect(feed.drain().map((entry) => entry.text)).toEqual(["ATTACK DENIED · LOW ACTION"]);
    // Re-push the same receipt identity path cannot happen; instead push a
    // brand-new identical reject and ensure the feed still dedupes the text.
    r.pushReject(32, "QueueCombatAction", "insufficient_action");
    expect(feed.drain()).toHaveLength(0);
    r.pushReject(33, "QueueCombatAction", "out_of_range");
    expect(feed.drain().map((entry) => entry.text)).toEqual(["ATTACK DENIED · RANGE"]);
  });

  it("emits per-track XP deltas after the baseline snapshot, never on first sight", () => {
    const r = rig();
    const feed = createCombatLogFeed(r.state);
    r.setTrackXp("marksman", "Marksman", { rifle: 100 });
    expect(feed.drain()).toHaveLength(0); // baseline
    r.setTrackXp("marksman", "Marksman", { rifle: 160 });
    const lines = feed.drain();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ text: "+60 RIFLE XP", tone: "xp" });
    expect(feed.drain()).toHaveLength(0);
  });

  it("announces duel outcomes as short COMBAT-tab result lines", () => {
    const r = rig();
    const feed = createCombatLogFeed(r.state);
    r.state.serverAuthority.duelOutcomes.push({
      actorId: "player",
      duelId: 3,
      opponentActorId: "rival-id-must-not-print",
      opponentName: "Rival",
      result: "won",
      reason: "yield",
      tick: 44,
    } as never);
    const lines = feed.drain();
    expect(lines.map((entry) => entry.text)).toEqual(["DUEL WON · RIVAL YIELDED"]);
    expect(lines[0]?.tone).toBe("info");
    expect(lines[0]?.emphasis).toBe(true);
    expect(feed.drain()).toHaveLength(0);
  });

  it("formats duel outcome copy from the closed reason union without actor ids", () => {
    expect(duelOpponentLabel("Juno Rill")).toBe("JUNO RILL");
    expect(duelOpponentLabel("")).toBe("OPPONENT");
    expect(duelOpponentLabel(null)).toBe("OPPONENT");
    expect(formatDuelOutcomeLine({
      result: "won",
      reason: "yield",
      opponentName: "Rival",
    })).toBe("DUEL WON · RIVAL YIELDED");
    expect(formatDuelOutcomeLine({
      result: "lost",
      reason: "yield",
      opponentName: "Rival",
    })).toBe("DUEL LOST · YOU YIELDED");
    expect(formatDuelOutcomeLine({
      result: "won",
      reason: "down",
      opponentName: "Rival",
    })).toBe("DUEL WON · RIVAL FALLS");
    expect(formatDuelOutcomeLine({
      result: "lost",
      reason: "down",
      opponentName: "Rival",
    })).toBe("DUEL LOST · YOU FELL");
    expect(formatDuelOutcomeLine({
      result: "dissolved",
      reason: "range",
      opponentName: "",
    })).toBe("DUEL ENDS · OUT OF RANGE");
    expect(formatDuelOutcomeLine({
      result: "dissolved",
      reason: "timeout",
    })).toBe("DUEL ENDS · TIME");
    expect(formatDuelOutcomeLine({
      result: "dissolved",
      reason: "disconnect",
    })).toBe("DUEL ENDS · DISCONNECT");
    // Missing name falls back to OPPONENT — never an actor id field.
    expect(formatDuelOutcomeLine({
      result: "won",
      reason: "yield",
      opponentName: undefined,
    })).toBe("DUEL WON · OPPONENT YIELDED");
    // Extra actor-id fields on the source object must not leak into copy.
    const withId = {
      result: "won",
      reason: "yield",
      opponentName: "",
      opponentActorId: "h3d-should-not-appear",
    };
    expect(formatDuelOutcomeLine(withId)).toBe("DUEL WON · OPPONENT YIELDED");
    expect(formatDuelOutcomeLine(withId)).not.toContain("h3d-should-not-appear");
  });

  it("maps developer reason codes to short player nouns", () => {
    expect(combatReasonCopy("ingress_budget_exhausted")).toBe("TOO FAST");
    expect(combatReasonCopy("on_cooldown")).toBe("COOLDOWN");
    expect(combatReasonCopy("not_in_combat")).toBe("NOT ENGAGED");
    expect(combatReasonCopy("some_new_reason")).toBe("SOME NEW REASON");
    expect(combatReasonCopy("  ")).toBe("DENIED");
    expect(combatReasonCopy(null)).toBe("DENIED");
  });
});
