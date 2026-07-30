import { describe, expect, it } from "vitest";
import type { ServerAuthorityActorState } from "@successor/client/src/slice-core/gameState";
import { createTuiPlayStateFixture } from "../../test/fixtures/playState";
import { CombatNarratorReducer } from "./combatNarrator";

function mockState(playerActorId = "me") {
  const fixture = createTuiPlayStateFixture();
  const state = fixture.state;
  state.playerActorId = playerActorId;
  state.serverAuthority.playerActorId = playerActorId;
  state.serverAuthority.actors = {
    me: { id: "me", label: "Hero Operative", x: 10, y: 10 } as unknown as ServerAuthorityActorState,
    "rogue-1": { id: "rogue-1", label: "Rogue Trooper", x: 12, y: 10 } as unknown as ServerAuthorityActorState,
    "raider-1": { id: "raider-1", label: "Dust Raider", x: 15, y: 15 } as unknown as ServerAuthorityActorState,
    "farmer-1": { id: "farmer-1", label: "Dust Farmer", x: 16, y: 15 } as unknown as ServerAuthorityActorState,
  };
  return state;
}

describe("CombatNarratorReducer", () => {
  it("narrates own hit with damage and zone", () => {
    const reducer = new CombatNarratorReducer();
    const state = mockState();
    const lines = reducer.ingest(state, {
      id: 101,
      tick: 40,
      shooterActorId: "me",
      targetActorId: "rogue-1",
      hit: true,
      damage: 18,
      zone: "torso",
      previousLifeState: "alive",
      lifeState: "alive",
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]!.register).toBe("combat");
    expect(lines[0]!.text).toMatch(/Rogue Trooper|chest|18/i);
  });

  it("narrates incoming damage to player", () => {
    const reducer = new CombatNarratorReducer();
    const state = mockState();
    const lines = reducer.ingest(state, {
      id: 102,
      tick: 41,
      shooterActorId: "rogue-1",
      targetActorId: "me",
      hit: true,
      damage: 25,
      zone: "legs",
      previousLifeState: "alive",
      lifeState: "alive",
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]!.register).toBe("combat");
    expect(lines[0]!.text).toMatch(/Rogue Trooper|you|legs|25/i);
  });

  it("narrates misses, dodges, and shields", () => {
    const reducer = new CombatNarratorReducer();
    const state = mockState();

    const miss = reducer.ingest(state, { id: 103, tick: 42, shooterActorId: "me", targetActorId: "rogue-1", hit: false, previousLifeState: "alive", lifeState: "alive" });
    expect(miss[0]!.text).toMatch(/wide|rush|miss/i);

    const dodge = reducer.ingest(state, { id: 104, tick: 43, shooterActorId: "me", targetActorId: "rogue-1", effect: { kind: "dodge" }, previousLifeState: "alive", lifeState: "alive" });
    expect(dodge[0]!.text).toMatch(/slides off the line|forces Rogue Trooper to dive/i);

    const shield = reducer.ingest(state, { id: 105, tick: 44, shooterActorId: "rogue-1", targetActorId: "me", effect: { kind: "shield" }, previousLifeState: "alive", lifeState: "alive" });
    expect(shield[0]!.text).toMatch(/shield takes the hit/i);
  });

  it("narrates kill and downed status", () => {
    const reducer = new CombatNarratorReducer();
    const state = mockState();

    const downed = reducer.ingest(state, { id: 106, tick: 45, shooterActorId: "me", targetActorId: "rogue-1", lifecycle: { kind: "downed" }, previousLifeState: "alive", lifeState: "downed" });
    expect(downed[0]!.text).toMatch(/down and not getting up easily|drops under your fire/i);

    const kill = reducer.ingest(state, { id: 107, tick: 46, shooterActorId: "me", targetActorId: "rogue-1", lifecycle: { kind: "killed" }, previousLifeState: "downed", lifeState: "dead" });
    expect(kill[0]!.text).toMatch(/drops, and does not move again|dead|done/i);
  });

  it("keeps third-party events readable and quiet", () => {
    const reducer = new CombatNarratorReducer();
    const state = mockState();

    const third = reducer.ingest(state, {
      id: 108,
      tick: 47,
      shooterActorId: "raider-1",
      targetActorId: "farmer-1",
      hit: true,
      damage: 10,
      previousLifeState: "alive",
      lifeState: "alive",
    });

    expect(third).toHaveLength(1);
    expect(third[0]!.text).toMatch(/Dust Raider trades fire with Dust Farmer/i);
  });

  it("suppresses duplicate events by id", () => {
    const reducer = new CombatNarratorReducer();
    const state = mockState();

    const event = { id: 200, tick: 50, shooterActorId: "me", targetActorId: "rogue-1", hit: true, damage: 12, previousLifeState: "alive", lifeState: "alive" };
    const first = reducer.ingest(state, event);
    const second = reducer.ingest(state, event);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });

  it("does not collapse same-tick burst hits with different ids", () => {
    const reducer = new CombatNarratorReducer();
    const state = mockState();

    const hit1 = reducer.ingest(state, { id: 301, tick: 60, shooterActorId: "me", targetActorId: "rogue-1", hit: true, damage: 10, zone: "torso" });
    const hit2 = reducer.ingest(state, { id: 302, tick: 60, shooterActorId: "me", targetActorId: "rogue-1", hit: true, damage: 10, zone: "torso" });

    expect(hit1).toHaveLength(1);
    expect(hit2).toHaveLength(1);
  });

  it("fails closed on non-local actor with no known label without leaking opaque IDs", () => {
    const reducer = new CombatNarratorReducer();
    const state = mockState();

    const lines = reducer.ingest(state, {
      id: 401,
      tick: 70,
      shooterActorId: "unknown-actor-999",
      targetActorId: "me",
      hit: true,
      damage: 15,
      zone: "torso",
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).not.toContain("unknown-actor-999");
    expect(lines[0]!.text).toMatch(/an operative/i);
  });

  it("fails closed silently on unknown/malformed events", () => {
    const reducer = new CombatNarratorReducer();
    const state = mockState();

    const unknown1 = reducer.ingest(state, { weirdField: "whatever" });
    const unknown2 = reducer.ingest(state, {} as Record<string, unknown>);

    expect(unknown1).toHaveLength(0);
    expect(unknown2).toHaveLength(0);
  });
});
