// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import type { LaunchIdentity } from "@successor/client/src/runtime/launchIdentity";
import {
  createPlayState,
  type SliceSnapshot,
} from "@successor/client/src/slice-core/gameState";
import {
  collectBugReportDiagnostics,
  installBugReportErrorCapture,
} from "./bugReportDiagnostics";

function fixtureSlice(): SliceSnapshot {
  return {
    schema: "successor.slice-core.v1",
    tick: 12,
    tickRateHz: 20,
    combatModel: "roll",
    grid: { cellSizePx: 32 },
    zone: { id: 1, name: "Open Desert", width: 40, height: 24, level: 0 },
    areas: [{
      id: "open-desert",
      name: "Open Desert",
      kind: "overworld",
      width: 40,
      height: 24,
      level: 0,
    }],
    stateHash: "bug-report-diagnostics-fixture",
    camera: { followActor: "player", zoom: 1 },
    actors: [{
      id: "player",
      entity: "actor/player",
      areaId: "open-desert",
      label: "Reporter",
      role: "player",
      sprite: "adventurer-premium-male",
      poseSet: "walk",
      direction: "right",
      cell: { x: 4, y: 5 },
      route: [],
    }],
    props: [],
    blockedCells: [],
    transitions: [],
    inventory: [],
    reservations: [],
    events: [],
  };
}

let disposeCapture: (() => void) | null = null;

afterEach(() => {
  disposeCapture?.();
  disposeCapture = null;
  delete window.__successor3d;
});

describe("bug report diagnostics", () => {
  it("captures useful runtime evidence without launch capabilities or secret values", () => {
    disposeCapture = installBugReportErrorCapture();
    const leaked = "abcdefghijklmnopqrstuvwxyz0123456789";
    window.dispatchEvent(new ErrorEvent("error", {
      message: `request failed with Bearer ${leaked}`,
      filename: `https://www.successorgame.com/assets/main.js?token=${leaked}`,
      lineno: 42,
      colno: 9,
    }));
    const slice = fixtureSlice();
    const state = createPlayState(slice, "player");
    const launchIdentity: LaunchIdentity = {
      ownerRef: "private-owner-ref",
      ownerDisplayName: "Private Owner",
      playerId: "player",
      displayName: "Reporter",
      zoneId: "open-desert",
      partyId: "",
      guildId: "",
      guildTag: null,
      gameTicket: leaked,
      chatTicket: leaked,
      clientReleaseId: "client-proof",
      serverReleaseId: "server-proof",
      standalone: true,
    };

    const diagnostics = collectBugReportDiagnostics(
      state,
      slice,
      launchIdentity,
      { openWindowIds: () => ["inventory", "bugReport"] },
    );
    const serialized = JSON.stringify(diagnostics);
    expect(serialized).toContain("client-proof");
    expect(serialized).toContain("open-desert");
    expect(serialized).toContain("inventory");
    expect(serialized).toContain("Bearer [redacted]");
    expect(serialized).not.toContain(leaked);
    expect(serialized).not.toContain("private-owner-ref");
    expect(serialized).not.toContain("Private Owner");
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(24 * 1_024);
  });
});
