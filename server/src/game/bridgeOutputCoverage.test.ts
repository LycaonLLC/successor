import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { GameShard, type GameSessionIdentity, type GameSocket } from "./shard.js";
import type { ClientCommand, ClientCommandEnvelope } from "./protocol.js";

// OUTPUT-COVERAGE GATE (the Rust-emits / shard-drops class — DEF-5/6/9).
//
// The bridge emits contract fields on its step/tick output; the shard MUST
// forward each to the client session (snapshot/delta property or one-shot
// session message). This gate drives the shard's real forward path with a
// fake bridge that populates one field at a time and asserts the session
// actually receives it — a dropped forward reds the gate naming the field +
// the shard.ts site. Rows activate as each fix lane lands its forward:
//   - craftSession / surveyResult / duelOutcome / placedExtractors  (landed — anchors + DEF-5)
//   - spliceSession / genomeScan                                   (BioECoreFix — DEF-6)
//   - placedParcels / farmPlots                                    (AgriCore DEF-9)
// Actor-SNAPSHOT fields (label / displayName / descriptor / nextSampleTick) ride
// the actor forward path, not one-shot messages — their red-path forward coverage
// lives in shard.test.ts ("forwards the earlier sandbox design type descriptor…", "…next sample tick").
const slicePath = fileURLToPath(new URL("./shard-authority-fixture.json", import.meta.url));

const SPAWN = { areaId: "authority-test-overworld", x: 11, y: 17, facing: "right" } as const;
// Any valid command triggers the bridge step; the fake bridge returns the field under test regardless.
const TRIGGER_COMMAND: ClientCommand = { DuelChallenge: { target_actor_id: "rival" } };

function envelope(commandId: number, command: ClientCommand): ClientCommandEnvelope {
  return { session: 1, player: 1, command_id: commandId, issued_at_tick: 0, command };
}

/** Valid-enough bridge step output the shard can sync, plus one contract field under test. */
function stepOutput(fieldOutput: Record<string, unknown>): Record<string, unknown> {
  return {
    status: "accepted",
    reasonCode: null,
    tick: 9,
    commandId: 1,
    actors: [],
    combatEvents: [],
    inventory: [],
    reservations: [],
    npcJobs: [],
    timelineEvents: [],
    ...fieldOutput,
  };
}

// Test-only seam to the shard's private bridge instance + raw WS handler (the forward boundary).
type ShardBridgeInternals = {
  rustAuthorityBridge?: {
    close: () => void;
    debugStatus?: () => unknown;
    submitActor?: (input: unknown) => Promise<unknown>;
    submitCommand?: (input: { actorId: string; envelope: ClientCommandEnvelope }) => Promise<Record<string, unknown>>;
  };
  handleRawMessage?: (sessionId: string, data: unknown) => Promise<void>;
};

type CapturingSocket = GameSocket & { sent: string[]; messages: Array<{ type: string; payload: unknown }> };

/** Socket that captures one-shot session messages (sendMessage) + raw sends. */
function capturingSocket(): CapturingSocket {
  const listeners = new Map<string, Array<(data?: unknown) => void>>();
  const sent: string[] = [];
  const messages: Array<{ type: string; payload: unknown }> = [];
  const base = {
    get readyState() { return 1; },
    sent,
    send: (data: string) => { sent.push(data); },
    close: () => {},
    on(event: "message" | "close" | "error", listener: (data?: unknown) => void) {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
    },
  } as GameSocket & { sent: string[] };
  return Object.assign(base, {
    messages,
    sendMessage(type: string, payload: unknown) { messages.push({ type, payload }); },
  }) as CapturingSocket;
}

type ForwardingShard = {
  shard: GameShard;
  internals: ShardBridgeInternals;
  socket: CapturingSocket;
  session: { id: string };
};

/** Boot a live-mode shard with a fake bridge returning `fieldOutput` per step, plus a connected session. */
async function shardForwardingField(fieldOutput: Record<string, unknown>): Promise<ForwardingShard> {
  const shard = new GameShard({
    slicePath,
    snapshotIntervalMs: 10_000,
    rustAuthorityBridge: { enabled: true, command: process.execPath, args: ["-e", "process.stdin.resume();"] },
  });
  const internals = shard as unknown as ShardBridgeInternals;
  internals.rustAuthorityBridge?.close();
  internals.rustAuthorityBridge = {
    close: () => {},
    debugStatus: () => null,
    submitActor: async () => ({}),
    submitCommand: async () => stepOutput(fieldOutput),
  };
  const socket = capturingSocket();
  const session = shard.connect(socket, {
    actorId: "viewer",
    playerId: "viewer",
    displayName: "Viewer",
    zoneId: "authority-test",
    spawn: SPAWN satisfies GameSessionIdentity["spawn"],
  });
  return { shard, internals, socket, session };
}

/** Drive a command through the raw WS handler — the path that forwards step-output session messages. */
async function driveRawCommand(internals: ShardBridgeInternals, sessionId: string): Promise<void> {
  await internals.handleRawMessage!(sessionId, JSON.stringify({ type: "game.command", envelope: envelope(1, TRIGGER_COMMAND) }));
}

describe("bridge output coverage — shard forwards every emitted contract field", () => {
  it("forwards craftSession as a one-shot session message (message-path anchor)", async () => {
    const { shard, internals, socket, session } = await shardForwardingField({ craftSession: { phase: "slots", recipeId: "test-recipe" } });
    try {
      await driveRawCommand(internals, session.id);
      const msg = socket.messages.find((m) => m.type === "craftSession");
      expect(msg, "shard.ts handleRawMessage did not forward output.craftSession as a 'craftSession' session message").toBeDefined();
    } finally {
      shard.close();
    }
  });

  it("forwards surveyResult as a one-shot session message (message-path anchor)", async () => {
    const { shard, internals, socket, session } = await shardForwardingField({ surveyResult: { resourceFamily: "test-ore" } });
    try {
      await driveRawCommand(internals, session.id);
      const msg = socket.messages.find((m) => m.type === "surveyResult");
      expect(msg, "shard.ts handleRawMessage did not forward output.surveyResult as a 'surveyResult' session message").toBeDefined();
    } finally {
      shard.close();
    }
  });

  it("forwards duel outcomes as a one-shot 'duelOutcome' session message (DEF-5 — outcome surface)", async () => {
    const { shard, internals, socket, session } = await shardForwardingField({
      duelOutcomes: [{ actorId: "viewer", duelId: 7, opponentActorId: "rival", opponentName: "Rival", result: "won", reason: "yield", tick: 9 }],
    });
    try {
      await driveRawCommand(internals, session.id);
      const msg = socket.messages.find((m) => m.type === "duelOutcome");
      expect(msg, "shard.ts did not forward output.duelOutcomes as a 'duelOutcome' session message").toBeDefined();
    } finally {
      shard.close();
    }
  });

  it("forwards spliceSession as a one-shot session message (DEF-6 — BioECoreFix)", async () => {
    const { shard, internals, socket, session } = await shardForwardingField({ spliceSession: { phase: "slots", species: "ashgrains" } });
    try {
      await driveRawCommand(internals, session.id);
      const msg = socket.messages.find((m) => m.type === "spliceSession");
      expect(msg, "shard.ts handleRawMessage did not forward output.spliceSession as a 'spliceSession' session message").toBeDefined();
    } finally {
      shard.close();
    }
  });

  it("forwards genomeScan as a one-shot session message (DEF-6 — BioECoreFix)", async () => {
    const { shard, internals, socket, session } = await shardForwardingField({ genomeScan: { species: "ashgrains" } });
    try {
      await driveRawCommand(internals, session.id);
      const msg = socket.messages.find((m) => m.type === "genomeScan");
      expect(msg, "shard.ts handleRawMessage did not forward output.genomeScan as a 'genomeScan' session message").toBeDefined();
    } finally {
      shard.close();
    }
  });

  it("syncs placedExtractors onto the session delta (delta-path anchor for placedParcels/farmPlots)", async () => {
    const { shard } = await shardForwardingField({
      placedExtractors: [{ extractorId: "ex-coverage", areaId: "authority-test-overworld", familyLabel: "Ore", cellX: 11, cellY: 17, mode: "idle", hopperPct: 0, collectableUnits: 0, isOwner: true }],
    });
    try {
      const result = await shard.submitDebugAuthorityCommand("viewer", TRIGGER_COMMAND);
      const ids = (result.delta.placedExtractors ?? []).map((row) => row.extractorId);
      expect(ids, "shard.ts did not sync output.placedExtractors onto the session delta (delta forward path)").toContain("ex-coverage");
    } finally {
      shard.close();
    }
  });

  it("syncs placedParcels onto the session delta (DEF-9 — AgriCore farm views)", async () => {
    const { shard } = await shardForwardingField({
      placedParcels: [{ parcelId: "parcel-cov", areaId: "authority-test-overworld", name: "Coverage Plot", tier: 1 }],
    });
    try {
      const result = await shard.submitDebugAuthorityCommand("viewer", TRIGGER_COMMAND);
      const ids = (result.delta.placedParcels ?? []).map((row) => row.parcelId);
      expect(ids, "shard.ts did not sync output.placedParcels onto the session delta (DEF-9 farm-view forward)").toContain("parcel-cov");
    } finally {
      shard.close();
    }
  });

  it("syncs farmPlots onto the session delta (DEF-9 — AgriCore farm views)", async () => {
    const { shard } = await shardForwardingField({
      farmPlots: [{ parcelId: "parcel-cov", areaId: "authority-test-overworld", tiles: [{ cellX: 11, cellY: 17, tilled: true, crop: { species: "ashgrains", stage: 0, stageCount: 3, mature: false } }] }],
    });
    try {
      const result = await shard.submitDebugAuthorityCommand("viewer", TRIGGER_COMMAND);
      const parcels = (result.delta.farmPlots ?? []).map((row) => row.parcelId);
      expect(parcels, "shard.ts did not sync output.farmPlots onto the session delta (DEF-9 farm-view forward)").toContain("parcel-cov");
    } finally {
      shard.close();
    }
  });

  it("forwards actor willAutoAggro onto the session actor delta (threat legibility — Rust-emits / shard-drops)", async () => {
    // willAutoAggro rides the per-actor snapshot; the shard must thread it from
    // bridge output.actors[] through applyRustActorSnapshot -> the session delta.
    const rogueSnapshot = {
      id: "viewer",
      areaId: "authority-test-overworld",
      x: 11,
      y: 17,
      direction: "right",
      lifeState: "alive",
      lifecycleSeq: 2,
      vitals: { health: 100, action: 100, spirit: 100 },
      maxVitals: { health: 100, action: 100, spirit: 100 },
      bleed: { active: false, stackCount: 0, remainingTicks: 0, damagePerTick: 0, damagePerSecondMilli: 0 },
      sleep: { active: false, stacks: 0, threshold: 0, remainingTicks: 0 },
      suppression: { active: false, pressure: 0, remainingTicks: 0, source: null },
      activeEffects: [],
      bodyVanishTick: 0,
      respawnTick: 0,
      cloneSicknessTicks: 0,
      willAutoAggro: true,
    };
    const { shard } = await shardForwardingField({ actor: rogueSnapshot });
    try {
      const result = await shard.submitDebugAuthorityCommand("viewer", TRIGGER_COMMAND);
      const delta = result.delta;
      const full = delta.actors?.viewer;
      const patch = delta.actorPatches?.viewer;
      const compactFull = (delta.compactActors ?? []).find((row) => row[0] === "viewer");
      const compactPatch = (delta.compactActorPatches ?? []).find((row) => row[0] === "viewer");
      const forwarded = full?.willAutoAggro
        ?? patch?.willAutoAggro
        ?? (compactFull ? compactFull[49] === 1 : undefined)
        ?? (compactPatch ? compactPatch[49] === 1 : undefined);
      expect(forwarded, "shard.ts did not forward output.actors[].willAutoAggro onto the session actor delta").toBe(true);
    } finally {
      shard.close();
    }
  });
});
