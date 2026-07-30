import { describe, expect, it } from "vitest";
import {
  createPlayState,
  type ServerAuthorityActorState,
  type SliceSnapshot,
} from "@successor/client/src/slice-core/gameState";
import { createUnboundTradeCommandPort, type TradeCommandPort } from "./commands";
import { fixtureTradeExecuted, fixtureTradeOffered } from "./fixtures";
import { acknowledgeTradeClose, ingestTradeSession } from "./store";
import {
  pollTradeLifecycle,
  TRADE_WINDOW_ID,
  tradeSlashLine,
  wireTradeWindowLifecycle,
} from "./lifecycle";

/**
 * Entry-point + lifecycle contracts: the /trade slash grammar (window opener
 * vs power-CLI passthrough), partner auto-open, and close-mid-trade declines
 * — the seams the composition root wires one-line-thin.
 */

function sliceFixture(): SliceSnapshot {
  return {
    schema: "successor.slice.v1",
    tick: 10,
    tickRateHz: 30,
    combatModel: "roll",
    grid: { cellSizePx: 60 },
    zone: { id: 1, name: "Test", width: 100, height: 100, level: 0 },
    areas: [{ id: "a", name: "A", kind: "overworld", width: 100, height: 100, level: 0 }],
    stateHash: "fixture",
    camera: { followActor: "player", zoom: 72 },
    actors: [{
      id: "player",
      entity: "actor:player",
      areaId: "a",
      label: "Field Observer",
      role: "player",
      sprite: "adventurer-premium-male",
      poseSet: "idle",
      direction: "right",
      cell: { x: 1, y: 2 },
      route: [],
    }],
    props: [],
    blockedCells: [],
    transitions: [],
    cloneFacilities: [],
    inventory: [],
    reservations: [],
    events: [],
  };
}

function authorityActor(id: string, label: string, role: string, lifeState = "alive"): ServerAuthorityActorState {
  return {
    id,
    label,
    role,
    areaId: "a",
    x: 2,
    y: 2,
    direction: "right",
    lifeState,
    lifecycleSeq: 1,
    vitals: { health: 100, action: 100, spirit: 100 },
    maxVitals: { health: 100, action: 100, spirit: 100 },
    bleed: { active: false, stackCount: 0, severity: 0, remainingMs: 0, ratesPerSecond: { health: 0, action: 0, spirit: 0 } },
    statuses: [],
    professions: [],
    skillPointsUsed: 0,
    skillPointsCap: 250,
    credits: 0,
  } as ServerAuthorityActorState;
}

function rig() {
  const slice = sliceFixture();
  const state = createPlayState(slice);
  state.serverAuthority.playerActorId = "player";
  state.serverAuthority.actors["player"] = authorityActor("player", "Field Observer", "player");
  state.serverAuthority.actors["vex-marrow"] = authorityActor("vex-marrow", "Vex Marrow", "player");
  state.serverAuthority.actors["camp-trainer"] = authorityActor("camp-trainer", "Warden", "profession_trainer");
  state.serverAuthority.actors["downed-op"] = authorityActor("downed-op", "Downed", "player", "downed");
  const opened: string[] = [];
  const windowManager = {
    open: (id: string) => { opened.push(id); },
    isOpen: () => false,
  };
  const declined: number[] = [];
  const commands: TradeCommandPort = {
    ...createUnboundTradeCommandPort(),
    open: () => true,
    decline: (proposalId: number) => { declined.push(proposalId); return true; },
  };
  return { state, windowManager, opened, commands, declined };
}

describe("tradeSlashLine", () => {
  it("opens the table for a named live player pawn (label, any case)", () => {
    const { state, windowManager, opened, commands } = rig();
    const echo = tradeSlashLine("/trade vex marrow".replace(" marrow", "-marrow"), state, commands, windowManager);
    expect(echo).toBe("TABLE REQUESTED — VEX MARROW");
    expect(opened).toEqual([TRADE_WINDOW_ID]);
    const byLabel = tradeSlashLine("/trade VEX", state, commands, windowManager);
    expect(byLabel).toBe("TRADE DENIED — NO OPERATIVE NAMED VEX"); // partial names don't guess
  });

  it("bare /trade uses the selection and refuses honestly without one", () => {
    const { state, windowManager, commands } = rig();
    expect(tradeSlashLine("/trade", state, commands, windowManager))
      .toBe("TRADE DENIED — SELECT AN OPERATIVE OR /TRADE <NAME>");
    state.selectedActorId = "vex-marrow";
    expect(tradeSlashLine("/trade", state, commands, windowManager))
      .toBe("TABLE REQUESTED — VEX MARROW");
  });

  it("refuses trainers, downed pawns and self; passes the power CLI through", () => {
    const { state, windowManager, commands } = rig();
    state.selectedActorId = "camp-trainer";
    expect(tradeSlashLine("/trade", state, commands, windowManager)).toContain("TRADE DENIED");
    expect(tradeSlashLine("/trade downed-op", state, commands, windowManager)).toContain("TRADE DENIED");
    expect(tradeSlashLine("/trade player", state, commands, windowManager)).toContain("TRADE DENIED");
    // Power grammar falls through to the verb registry (null = not handled).
    expect(tradeSlashLine("/trade propose", state, commands, windowManager)).toBeNull();
    expect(tradeSlashLine("/trade vex-marrow offer=hide:4", state, commands, windowManager)).toBeNull();
    expect(tradeSlashLine("/who", state, commands, windowManager)).toBeNull();
  });
});

describe("lifecycle", () => {
  it("auto-opens the window when a live session appears (partner side)", () => {
    const { state, windowManager, opened } = rig();
    ingestTradeSession(null);
    pollTradeLifecycle(state, windowManager);
    expect(opened).toEqual([]);
    ingestTradeSession(fixtureTradeOffered());
    pollTradeLifecycle(state, windowManager);
    expect(opened).toEqual([TRADE_WINDOW_ID]);
    ingestTradeSession(null);
    acknowledgeTradeClose();
  });

  it("never auto-opens a terminal latch", () => {
    const { state, windowManager, opened } = rig();
    ingestTradeSession(fixtureTradeExecuted());
    pollTradeLifecycle(state, windowManager);
    expect(opened).toEqual([]);
    ingestTradeSession(null);
    acknowledgeTradeClose();
  });

  it("close-mid-trade declines the live table and suppresses the bounce-reopen", () => {
    const { state, windowManager, opened, commands, declined } = rig();
    let closeHook: ((id: string, open: boolean) => void) | null = null;
    const manager = {
      subscribeOpenChanged: (fn: (id: string, open: boolean) => void) => {
        closeHook = fn;
        return () => {};
      },
    };
    wireTradeWindowLifecycle(manager, commands);
    const session = fixtureTradeOffered();
    ingestTradeSession(session);
    closeHook!(TRADE_WINDOW_ID, false);
    expect(declined).toEqual([session.proposalId]);
    // The (still-streaming) session must not bounce the window back open.
    pollTradeLifecycle(state, windowManager);
    expect(opened).toEqual([]);
    ingestTradeSession(null);
    acknowledgeTradeClose();
  });
});
