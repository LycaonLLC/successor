import { describe, expect, it } from "vitest";

import { createTuiPlayStateFixture } from "../../test/fixtures/playState";
import { createContactTracker } from "./contacts";

describe("contact tracker (radar rule + AOI diff)", () => {
  it("classifies the fixture: hostile + civilian visible, corpse excluded, self excluded", () => {
    const { state } = createTuiPlayStateFixture();
    const tracker = createContactTracker();
    tracker.update(state);
    const contacts = tracker.contacts();
    expect(contacts.map((contact) => contact.id).sort()).toEqual(["civilian-1", "rogue-1"]);
    expect(contacts.find((contact) => contact.id === "rogue-1")?.relation).toBe("hostile");
    expect(tracker.hostileCount()).toBe(1);
  });

  it("first sight emits arrivals; steady state emits nothing; loss emits departure with last bearing", () => {
    const { state } = createTuiPlayStateFixture();
    const tracker = createContactTracker();
    const first = tracker.update(state);
    expect(first.arrivals.map((contact) => contact.id).sort()).toEqual(["civilian-1", "rogue-1"]);

    const steady = tracker.update(state);
    expect(steady.arrivals).toEqual([]);
    expect(steady.departures).toEqual([]);

    delete state.serverAuthority.actors["rogue-1"];
    const after = tracker.update(state);
    expect(after.departures).toHaveLength(1);
    expect(after.departures[0]!.label).toBe("Rogue trooper");
    // rogue at (64,36), me at (40,44): dx=24, dy=-8 → east-ish
    expect(after.departures[0]!.lastDx).toBeCloseTo(24, 5);
  });

  it("drops true civilians beyond the 96c scope but rim-clamps hostiles (radar contract)", () => {
    const { state } = createTuiPlayStateFixture();
    const rogue = state.serverAuthority.actors["rogue-1"]!;
    const civilian = state.serverAuthority.actors["civilian-1"]!;
    rogue.x = 40 + 150;
    civilian.x = 40 + 150;
    // radar rule: aiAttitude "passive" reads as ALERT (amber, rim-clamps);
    // a true radar-civilian has no attitude and shares the player's faction
    civilian.aiAttitude = undefined;
    const tracker = createContactTracker();
    tracker.update(state);
    const contacts = tracker.contacts();
    expect(contacts.map((contact) => contact.id)).toEqual(["rogue-1"]);
    expect(contacts[0]!.rimClamped).toBe(true);
  });

  it("emits attitude shifts when a passive contact turns hostile", () => {
    const { state } = createTuiPlayStateFixture();
    const tracker = createContactTracker();
    tracker.update(state);
    state.serverAuthority.actors["civilian-1"]!.aiAttitude = "hostile";
    const events = tracker.update(state);
    expect(events.attitudeShifts).toEqual([{ id: "civilian-1", label: "Dust farmer", to: "hostile" }]);
  });

  it("emits one corpse beat per lootable body, rights-aware", () => {
    const { state } = createTuiPlayStateFixture();
    const tracker = createContactTracker();
    const first = tracker.update(state);
    expect(first.corpses).toEqual([{ id: "corpse-1", label: "Downed raider", mine: true }]);
    const second = tracker.update(state);
    expect(second.corpses).toEqual([]);
  });

  it("ignores actors streamed from another area", () => {
    const { state } = createTuiPlayStateFixture();
    state.serverAuthority.actors["rogue-1"]!.areaId = "elsewhere";
    const tracker = createContactTracker();
    tracker.update(state);
    expect(tracker.contacts().map((contact) => contact.id)).toEqual(["civilian-1"]);
  });

  it("reads a willAutoAggro contact as hostile even without a hostile attitude (owner 2026-07-08)", () => {
    const { state } = createTuiPlayStateFixture();
    // civilian-1 streams aiAttitude "passive" (would read ALERTED). Flagging it
    // auto-aggro pulls it to HOSTILE on the same willAutoAggro key the 3D red
    // nameplate uses.
    state.serverAuthority.actors["civilian-1"]!.willAutoAggro = true;
    const tracker = createContactTracker();
    tracker.update(state);
    expect(tracker.contacts().find((contact) => contact.id === "civilian-1")?.relation).toBe("hostile");
  });

  it("reads a provoked-only faction hostile as wary (alerted), not hostile", () => {
    const { state } = createTuiPlayStateFixture();
    const rogue = state.serverAuthority.actors["rogue-1"]!;
    // Faction hostile that will NOT auto-aggro (no live hostile attitude) reads
    // wary, not hostile — the threat split keys on willAutoAggro.
    rogue.aiAttitude = undefined;
    rogue.willAutoAggro = false;
    const tracker = createContactTracker();
    tracker.update(state);
    expect(tracker.contacts().find((contact) => contact.id === "rogue-1")?.relation).toBe("alerted");
  });
});
