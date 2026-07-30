import { describe, expect, it } from "vitest";

import { createMacroEngine } from "@successor/client/src/slice-core/macroEngine/index";
import { createVerbRegistry } from "@successor/client/src/slice-core/verbRegistry/index";

import { createTuiPlayStateFixture } from "../../test/fixtures/playState";
import { createContactTracker } from "./contacts";
import { createSurveyStore } from "./surveyStore";
import { isCarriedContainer } from "./exchangeTrade";
import { renderRoster, routeGroup, type GroupView } from "./groups";
import type { GameSession } from "./session";

function fakeSession(): GameSession {
  const { state, slice } = createTuiPlayStateFixture();
  const registry = createVerbRegistry({ state, slice });
  const session: GameSession = {
    state,
    slice,
    registry,
    macros: createMacroEngine({ registry }),
    survey: createSurveyStore(),
    tracker: createContactTracker(),
    chat: null,
    defineMacro() {},
    removeMacro: () => false,
    listMacroDefs: () => [],
    isCarried: (container) => isCarriedContainer(state, container),
    async start() {},
    async dispose() {},
    onEvent: () => () => {},
    estimatedTick: () => 4512,
    executeVerb: (line) => registry.executeLine(line),
    sendChat() {},
    holdDirection() {},
    walk() {},
    stopMovement() {},
    moving: () => false,
    queueEventsSince: (seq) => ({ seq, events: [] }),
  };
  session.tracker.update(state);
  return session;
}

const EMPTY_VIEW: GroupView = { group: null, members: [], pendingInvite: null };

function view(overrides: Partial<GroupView> = {}): GroupView {
  return {
    group: { groupId: 1, leaderActorId: "observer", createdTick: 4000, memberActorIds: ["observer", "rogue-1", "ghost-9"] },
    members: [
      {
        actorId: "observer", name: "Field Observer", areaId: "open-desert",
        vitals: { health: 96, action: 62, spirit: 100 }, maxVitals: { health: 100, action: 100, spirit: 100 },
        lifeState: "alive", isLeader: true, linkDead: false,
      },
      {
        // name from the group channel, position joined from the AOI stream
        // (fixture streams rogue-1 at 64,36 — SE of the player)
        actorId: "rogue-1", name: "Rusk", areaId: "open-desert",
        vitals: { health: 40, action: 80, spirit: 90 }, maxVitals: { health: 100, action: 100, spirit: 100 },
        lifeState: "alive", isLeader: false, linkDead: true,
      },
      {
        // same area, NOT in the AOI stream — the channel may say where
        // they are, never precisely where they stand
        actorId: "ghost-9", name: "Vane", areaId: "open-desert",
        vitals: { health: 71, action: 55, spirit: 80 }, maxVitals: { health: 100, action: 100, spirit: 100 },
        lifeState: "alive", isLeader: false, linkDead: false,
      },
    ],
    pendingInvite: null,
    ...overrides,
  };
}

describe("/group", () => {
  it("verbs ride the generated wire rows (invite resolves a scoped contact)", () => {
    const session = fakeSession();
    const before = session.state.authorityCommands.pending.length;
    const lines = routeGroup(session, () => EMPTY_VIEW, ["invite", "rogue"]);
    expect(lines[0]!.text).toMatch(/QUEUED/i);
    expect(session.state.authorityCommands.pending.length).toBe(before + 1);
    const kinds = session.state.authorityCommands.pending.map((envelope) => Object.keys(envelope.command)[0]);
    expect(kinds).toContain("GroupInvite");
  });

  it("accept/leave/disband need no target; unknown invitee speaks honestly", () => {
    const session = fakeSession();
    expect(routeGroup(session, () => EMPTY_VIEW, ["accept"])[0]!.text).toMatch(/QUEUED/i);
    expect(routeGroup(session, () => EMPTY_VIEW, ["invite", "nobody-here"])[0]!.register).toBe("reject");
  });

  it("bare /group outside any crew walks alone", () => {
    const session = fakeSession();
    expect(routeGroup(session, () => EMPTY_VIEW, [])[0]!.text).toBe("You walk alone.");
  });

  it("roster renders leader star, HP %, AOI-joined bearing, and LINK-DEAD state", () => {
    const session = fakeSession();
    const lines = renderRoster(session, view());
    const text = lines.map((line) => line.text).join("\n");
    expect(text).toContain("Your crew (3):");
    expect(text).toMatch(/★ Field Observer\s+H {2}96%\s+you/);
    expect(text).toMatch(/· Rusk\s+H {2}40%\s+E 25c\s+LINK-DEAD · reconnecting/);
    expect(text).toMatch(/· Vane\s+H {2}71%\s+out of scope/);
  });

  it("a pending invite renders with its countdown and the accept/decline hint", () => {
    const session = fakeSession();
    const lines = renderRoster(session, view({
      group: null,
      members: [],
      pendingInvite: { inviterActorId: "rusk", inviterName: "Rusk", issuedTick: 4400, expiresTick: 4512 + 300 },
    }));
    expect(lines[0]!.text).toMatch(/Rusk wants you in their crew — \/group accept or \/group decline \(10s\)/);
  });
});
