import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { ManualClock } from "./clock.js";
import { MIGRATIONS, migrationChecksumForTests } from "../alpha/control-store.js";
import { GameShard, gameSessionAdmissionCapFromEnv, gameShardInternalsForTest, slowConsumerBufferCapBytesFromEnv, type GameSessionIdentity, type GameShardOptions, type GameSocket } from "./shard.js";
import type {
  ClientCommand,
  ClientCommandEnvelope,
  GameActorSnapshot,
  GameActorPatch,
  GameCombatEvent,
  GameCompactActorSnapshot,
  GameCompactCombatEvent,
  GameCompactActorPatch,
  GameCompactActorMove,
  GameShardDelta,
} from "./protocol.js";
import type { RustAuthorityActorSnapshot, RustAuthorityActorUpsertInput, RustAuthorityActorWeaponSnapshot, RustAuthorityBridgeTickOutput, RustAuthorityInventorySnapshot, RustAuthorityProfessionSnapshot, RustAuthorityBridgeStepOutput, RustAuthorityBridgeActorOutput, RustAuthorityBridgeExportStateOutput, RustAuthorityBridgeImportStateOutput, RustAuthorityResourceStatsSnapshot, RustAuthorityReservationSnapshot } from "./rustAuthorityBridge.js";
import {
  authorityWeaponMagazineSize,
  authorityWeaponProfile,
  type AuthorityWeaponId,
} from "./weapons.js";

const slicePath = fileURLToPath(new URL("./shard-authority-fixture.json", import.meta.url));
const currentRuntimeSlicePath = fileURLToPath(new URL("../../../client/public/successor-slice/open-desert-slice.json", import.meta.url));

function exactActorPosition(shard: GameShard, actorId: string): { x: number; y: number } | undefined {
  const actor = (shard as unknown as { actors: Map<string, { x: number; y: number }> }).actors.get(actorId);
  return actor ? { x: actor.x, y: actor.y } : undefined;
}

describe("GameShard", () => {
  it("rejects runtime construction without Rust authority", () => {
    expect(() => new GameShard({ slicePath, snapshotIntervalMs: 10_000 })).toThrow(
      "Rust authority is required for GameShard runtime construction.",
    );
  });

  it("requires an explicit test helper for in-process authority reducer coverage", () => {

    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      expect(shard.status().authority).toMatchObject({
        mode: "in-process-test",
        rustLive: false,
        inProcessAuthorityForTests: true,
      });
    } finally {
      shard.close();
    }
  });

  it("reports redaction-safe session lifecycle instrumentation", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const socket = controlledSocket();
      shard.connect(socket, testCharacterIdentity("status-instrumentation"));

      const connected = shard.status().instrumentation;
      expect(connected.sessions).toMatchObject({ active: 1, joined: 1, disconnected: 0 });
      expect(connected.commands).toMatchObject({ accepted: 0, rejected: 0, receipts: 0 });
      expect(connected.delivery).toMatchObject({
        queueDepth: 0,
        pendingReceipts: 0,
        pendingEvents: 0,
        pendingAbilityQueueEvents: 0,
        deferredDirtyActors: 0,
      });
      expect(connected.bridge).toMatchObject({
        diagnosticPending: expect.any(Number),
        livePending: expect.any(Number),
        commandBatchPending: expect.any(Number),
        commandBatchPendingItems: expect.any(Number),
        backlogSize: expect.any(Number),
      });
      expect(connected.eventLoopLag).toMatchObject({
        p50Ms: expect.any(Number),
        p95Ms: expect.any(Number),
        maxMs: expect.any(Number),
        meanMs: expect.any(Number),
      });

      socket.emitClose();

      expect(shard.status().instrumentation.sessions).toMatchObject({
        active: 0,
        joined: 1,
        disconnected: 1,
      });
    } finally {
      shard.close();
    }
  });

  it("commits session lifecycle rows without stranding the readiness journal tail", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-session-lifecycle-journal-"));
    const journalPath = path.join(tempDir, "authority-test.journal.jsonl");
    const shard = testShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      persistence: { journalPath },
    });
    try {
      const socket = controlledSocket();
      shard.connect(socket, testCharacterIdentity("session-lifecycle-character"));

      expect(shard.status().readiness.commitWorker).toBe(true);
      expect(shard.status().persistence.journalBufferedEntries).toBe(0);
      expect(fs.readFileSync(journalPath, "utf8")).toContain('"type":"session.connect"');

      socket.emitMessage(JSON.stringify({ type: "exit_world" }));

      expect(shard.status().readiness.commitWorker).toBe(true);
      expect(shard.status().persistence.journalBufferedEntries).toBe(0);
      expect(fs.readFileSync(journalPath, "utf8")).toContain('"type":"session.disconnect"');
    } finally {
      await shard.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("parses only finite positive slow-consumer transport caps", () => {
    expect(slowConsumerBufferCapBytesFromEnv({})).toBe(1_048_576);
    expect(slowConsumerBufferCapBytesFromEnv({ GAME_SLOW_CONSUMER_BUFFER_CAP_BYTES: " 64 " })).toBe(64);
    for (const value of ["", "0", "-1", "1.5", "1e6", "Infinity", "9007199254740992"]) {
      expect(() => slowConsumerBufferCapBytesFromEnv({ GAME_SLOW_CONSUMER_BUFFER_CAP_BYTES: value })).toThrow(RangeError);
    }
  });

  it("parses the hosted game session admission cap without falling back on malformed values", () => {
    expect(gameSessionAdmissionCapFromEnv({})).toBe(1_200);
    expect(gameSessionAdmissionCapFromEnv({ GAME_HOSTED_DURABILITY: "1", GAME_MAX_SESSIONS: " 2 " })).toBe(2);
    for (const value of ["", "0", "-1", "1.5", "1e6", "Infinity", "9007199254740992"]) {
      expect(() => gameSessionAdmissionCapFromEnv({ GAME_HOSTED_DURABILITY: "1", GAME_MAX_SESSIONS: value })).toThrow(RangeError);
    }
  });

  it("admits under the hard session cap, refuses at capacity, and re-admits after disconnect", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000, maxSessions: 2 });
    try {
      const first = controlledSocket();
      const second = controlledSocket();
      shard.connect(first, testCharacterIdentity("admission-cap-first"));
      shard.connect(second, testCharacterIdentity("admission-cap-second"));
      expect(shard.status().sessionCount).toBe(2);

      const refused = controlledSocket();
      expect(() => shard.connect(refused, testCharacterIdentity("admission-cap-refused"))).toThrow("game shard full");
      expect(refused.closed).toEqual([{ code: 1013, reason: "game shard full" }]);
      expect(shard.status().sessionCount).toBe(2);

      first.emitClose();
      expect(shard.status().sessionCount).toBe(1);
      const reentry = controlledSocket();
      shard.connect(reentry, testCharacterIdentity("admission-cap-reentry"));
      expect(shard.status().sessionCount).toBe(2);
      expect(reentry.closed).toEqual([]);
    } finally {
      shard.close();
    }
  });

  it("permits a socket exactly at the configured transport cap", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000, slowConsumerBufferCapBytes: 8 });
    try {
      const socket = bufferedControlledSocket(8);
      shard.connect(socket, testCharacterIdentity("transport-cap-boundary"));

      expect(socket.closed).toEqual([]);
      expect(socket.sent).toHaveLength(1);
      expect(shard.status().instrumentation.delivery.backpressure).toMatchObject({
        currentBufferedBytes: 8,
        maxBufferedBytes: 8,
        capBytes: 8,
        slowConsumerDisconnects: 0,
      });
    } finally {
      shard.close();
    }
  });

  it("isolates one over-cap consumer once without queueing an error or impacting a zero-buffer peer", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000, slowConsumerBufferCapBytes: 8 });
    try {
      const healthy = bufferedControlledSocket(0);
      shard.connect(healthy, testCharacterIdentity("transport-healthy"));
      expect(healthy.sent).toHaveLength(1);

      const slow = bufferedControlledSocket(9);
      const slowSession = shard.connect(slow, testCharacterIdentity("transport-slow"));
      slowSession.failClose();

      expect(slow.closed).toEqual([{ code: 1013, reason: "slow consumer" }]);
      expect(slow.sent).toEqual([]);
      expect(healthy.closed).toEqual([]);
      expect(healthy.sent).toHaveLength(1);
      expect(shard.status().instrumentation).toMatchObject({
        sessions: { active: 1, disconnected: 1 },
        delivery: {
          queueDepth: 0,
          backpressure: {
            currentBufferedBytes: 0,
            maxBufferedBytes: 9,
            capBytes: 8,
            slowConsumerDisconnects: 1,
          },
        },
      });
    } finally {
      shard.close();
    }
  });

  it("keeps real character starts bare while preserving explicit driver deploy loadouts", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
      verificationFixtureLoadouts: new Map([[
        "fixture-slugger",
        [
          { itemId: 3101, variantId: 7, quantity: 1, equipped: true },
          { itemId: 1101, variantId: 3, quantity: 12, equipped: false },
        ],
      ]]),
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: { actor: RustAuthorityActorUpsertInput }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
    };
    const submittedActors: RustAuthorityActorUpsertInput[] = [];
    const inventoryByRustActor = new Map<string, RustAuthorityInventorySnapshot[]>();
    const rowsFor = (actor: RustAuthorityActorUpsertInput): RustAuthorityInventorySnapshot[] => (
      actor.verificationLoadout
        ? actor.verificationLoadout.map((item, index) => ({
          container: `${actor.id}:field-pack`,
          stackId: index + 1,
          item: item.itemId === 3101 ? "Slugthrower" : "Iron Slug",
          itemId: item.itemId,
          variantId: item.variantId,
          quantity: item.quantity,
          reserved: 0,
          available: item.quantity,
        }))
        : actor.bareStart
          ? []
          : [
            { container: `${actor.id}:field-pack`, stackId: 1, item: "Stimpak A", itemId: 1001, variantId: 0, quantity: 16, reserved: 0, available: 16 },
            { container: `${actor.id}:field-pack`, stackId: 2, item: "Field Bandage", itemId: 1002, variantId: 0, quantity: 16, reserved: 0, available: 16 },
            { container: `${actor.id}:field-pack`, stackId: 3, item: "Iron Slug", itemId: 1101, variantId: 0, quantity: 240, reserved: 0, available: 240 },
          ]
    );
    const allInventory = (): RustAuthorityInventorySnapshot[] => (
      [...inventoryByRustActor.values()].flatMap((rows) => rows.map((row) => ({ ...row })))
    );
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async ({ actor }) => {
        submittedActors.push({ ...actor });
        if (!inventoryByRustActor.has(actor.id)) inventoryByRustActor.set(actor.id, rowsFor(actor));
        return {
          tick: 24,
          actor: rustActorSnapshot({
            id: actor.id,
            label: actor.label ?? actor.id,
            role: actor.role ?? "player",
            areaId: actor.areaId,
            x: actor.x,
            y: actor.y,
            direction: actor.direction,
            credits: actor.bareStart === true ? 5_000 : actor.credits,
            weapon: actor.verificationLoadout?.some((item) => item.itemId === 3101 && item.equipped)
              ? rustWeaponSnapshot("slugthrower", 3101)
              : actor.bareStart ? undefined : rustWeaponSnapshot("slugthrower"),
          }),
          inventory: allInventory(),
          reservations: [],
          timelineEvents: [],
          resourceSpawns: [],
          areaResourceSpawns: [],
        };
      },
    };
    const loadoutRows = (socket: { sent: string[] }, actorId: string): RustAuthorityInventorySnapshot[] => {
      const hello = packets(socket).find((packet) => packet.type === "game.hello") as { snapshot?: { inventory?: RustAuthorityInventorySnapshot[] } } | undefined;
      return hello?.snapshot?.inventory?.filter((row) => row.container.startsWith(`${actorId}:`)) ?? [];
    };
    const countItemRows = (rows: RustAuthorityInventorySnapshot[], itemId: number): number => (
      rows.filter((row) => row.itemId === itemId && row.available > 0).length
    );
    const creationWorn = [
      { item: "top_rigged_tank", colors: ["#804040", "#406090"] },
      { item: "legs_wrapped_workpants", colors: ["#687048"] },
      { item: "boots_split_toe", colors: ["#303030", "#808080"] },
      { item: "gloves_guarded_leather", colors: ["#706050", "#303030"] },
    ];
    const ticketDefaultWorn = [
      { item: "top_rigged_tank", colors: ["#b08040", "#406090"] },
      { item: "legs_wrapped_workpants", colors: ["#804040", "#505060", "#706050"] },
      { item: "boots_canvas_ankle", colors: ["#303030", "#808080"] },
      { item: "gloves_knuckled_half", colors: ["#406090", "#808080"] },
    ];
    const characterIdentity: GameSessionIdentity = {
      actorId: "actionjohnson",
      playerId: "local",
      displayName: "Action Johnson",
      zoneId: "authority-test",
      characterId: "actionjohnson",
      ownerRef: "local",
      appearance: { skin: "#aabbcc", hair: "hair_crop2", hair_mat: "hair_chestnut" },
      worn: creationWorn,
      spawn: { areaId: "authority-test-overworld", x: 11, y: 17, facing: "right" },
    };
    const ticketIdentity: GameSessionIdentity = {
      actorId: "char-ticket",
      playerId: "profile-123",
      displayName: "Atlas Prime",
      zoneId: "authority-test",
      characterId: "char-ticket",
      ownerRef: "profile-123",
      appearance: { skin: "#c78f62", hair: null, hair_mat: "hair_raven" },
      worn: ticketDefaultWorn,
      spawn: { areaId: "authority-test-overworld", x: 12, y: 17, facing: "front" },
    };
    const fixtureIdentity: GameSessionIdentity = {
      actorId: "fixture-slugger",
      playerId: "fixture-local",
      displayName: "Fixture Slugger",
      zoneId: "authority-test",
      characterId: "fixture-slugger",
      ownerRef: "fixture-local",
      skillBoxIds: ["marksman-novice", "marksman-rifle-i", "marksman-rifle-ii", "marksman-rifle-iii", "craftsman-novice"],
      activeTitleId: "craftsman-novice",
      appearance: { skin: "#c78f62", hair: "hair_mop", hair_mat: "hair_umber" },
      spawn: { areaId: "authority-test-overworld", x: 13, y: 17, facing: "right" },
    };

    try {
      const characterSocket = controlledSocket();
      shard.connect(characterSocket, characterIdentity);
      await waitFor(() => characterSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(submittedActors[0]).toMatchObject({ id: "player", bareStart: true, returning: false });
      expect(submittedActors[0]?.skillBoxIds).toBeUndefined();
      expect(helloActor(characterSocket, "actionjohnson")).toMatchObject({
        credits: 5_000,
        weapon: null,
        worn: creationWorn,
      });
      expect(loadoutRows(characterSocket, "actionjohnson")).toEqual([]);

      const takeoverSocket = controlledSocket();
      shard.connect(takeoverSocket, characterIdentity);
      await waitFor(() => takeoverSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(loadoutRows(takeoverSocket, "actionjohnson")).toEqual([]);
      expect(submittedActors).toHaveLength(1);

      const ticketSocket = controlledSocket();
      shard.connect(ticketSocket, ticketIdentity);
      await waitFor(() => ticketSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(submittedActors[1]).toMatchObject({ id: "char-ticket", bareStart: true, returning: false });
      expect(submittedActors[1]?.skillBoxIds).toBeUndefined();
      expect(helloActor(ticketSocket, "char-ticket")).toMatchObject({
        credits: 5_000,
        weapon: null,
        worn: ticketDefaultWorn,
      });
      expect(loadoutRows(ticketSocket, "char-ticket")).toEqual([]);

      const fixtureSocket = controlledSocket();
      shard.connect(fixtureSocket, fixtureIdentity);
      await waitFor(() => fixtureSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(submittedActors[2]).toMatchObject({
        id: "fixture-slugger",
        bareStart: false,
        returning: false,
        verificationLoadout: [
          { itemId: 3101, variantId: 7, quantity: 1, equipped: true },
          { itemId: 1101, variantId: 3, quantity: 12, equipped: false },
        ],
      });
      expect(submittedActors[2]?.skillBoxIds).toEqual(["marksman-novice", "marksman-rifle-i", "marksman-rifle-ii", "marksman-rifle-iii", "craftsman-novice"]);
      expect(submittedActors[2]?.activeTitleId).toBe("craftsman-novice");
      expect(helloActor(fixtureSocket, "fixture-slugger")?.weapon).toMatchObject({ weaponId: "slugthrower", weaponItemId: 3101 });
      expect(loadoutRows(fixtureSocket, "fixture-slugger")).toEqual([
        expect.objectContaining({ itemId: 3101, variantId: 7, quantity: 1, available: 1 }),
        expect.objectContaining({ itemId: 1101, variantId: 3, quantity: 12, available: 12 }),
      ]);

      const autoEnterSocket = controlledSocket();
      shard.connect(autoEnterSocket, {
        actorId: "agent-probe",
        playerId: "agent-probe",
        displayName: "Agent Probe",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 13, y: 17, facing: "right" },
      });
      await waitFor(() => autoEnterSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      const autoEnterRows = loadoutRows(autoEnterSocket, "agent-probe");
      expect(submittedActors[3]).toMatchObject({ id: "agent-probe", bareStart: false, returning: false });
      expect(countItemRows(autoEnterRows, 3104)).toBe(0);
      expect(countItemRows(autoEnterRows, 1101)).toBe(1);
    } finally {
      shard.close();
    }
  });

  it("uses CharacterStore gameplay metadata only as a first-entry seed", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    const characterId = "first-entry-metadata";
    const firstEntryIdentity: GameSessionIdentity = {
      ...testCharacterIdentity(characterId),
      returningCharacter: false,
      professionIds: ["craftsman"],
      skillBoxIds: [],
      activeTitleId: null,
      careerGoalId: null,
      credits: 1_000,
      vitals: { health: 210, action: 140, spirit: 90 },
    };
    const internals = shard as unknown as {
      actors: Map<string, {
        professionIds?: string[];
        skillBoxIds?: string[];
        activeTitleId?: string | null;
        careerGoalId?: string | null;
        credits?: number;
        vitals: { health: number; action: number; spirit: number };
      }>;
    };

    try {
      shard.connect(controlledSocket(), firstEntryIdentity);
      const actor = internals.actors.get(characterId);
      expect(actor).toMatchObject({
        professionIds: ["craftsman"],
        activeTitleId: null,
        careerGoalId: null,
        credits: 1_000,
        vitals: { health: 210, action: 140, spirit: 90 },
      });
      expect(actor?.skillBoxIds).toBeUndefined();

      if (!actor) throw new Error("expected first-entry actor");
      actor.professionIds = ["marksman"];
      actor.skillBoxIds = ["marksman-novice", "marksman-rifle-i"];
      actor.activeTitleId = "marksman-rifle-i";
      actor.careerGoalId = "rifle_quartermaster";
      actor.credits = 9_876;
      actor.vitals = { health: 123, action: 111, spirit: 77 };

      shard.connect(controlledSocket(), {
        ...firstEntryIdentity,
        returningCharacter: true,
        professionIds: ["craftsman"],
        skillBoxIds: [],
        activeTitleId: null,
        careerGoalId: null,
        credits: 1,
        vitals: { health: 1, action: 1, spirit: 1 },
      });

      expect(internals.actors.get(characterId)).toMatchObject({
        professionIds: ["marksman"],
        skillBoxIds: ["marksman-novice", "marksman-rifle-i"],
        activeTitleId: "marksman-rifle-i",
        careerGoalId: "rifle_quartermaster",
        credits: 9_876,
        vitals: { health: 123, action: 111, spirit: 77 },
      });
    } finally {
      shard.close();
    }
  });

  it("projects a current character face through Rust registration and hello", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const face = {
      eyes: "eyes_narrow",
      brows: "brows_arched",
      nose: "nose_hooked",
      mouth: "mouth_smirk",
      eye_color: "#6f8d55",
      brow_color: "#291c16",
      lip_color: "#9f5563",
    };
    const identity: GameSessionIdentity = {
      ...testCharacterIdentity("legacy-face-return"),
      returningCharacter: false,
      appearance: {
        skin: "#c78f62",
        hair: "hair_mop",
        hair_mat: "hair_umber",
        face,
      },
      sprite: "adventurer-premium-female",
    };
    const submittedActors: RustAuthorityActorUpsertInput[] = [];
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: { actor: RustAuthorityActorUpsertInput }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
    };
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async ({ actor }) => {
        submittedActors.push(structuredClone(actor));
        return {
          tick: submittedActors.length,
          actor: {
            ...rustActorSnapshot({
              id: actor.id,
              entity: actor.entity,
              label: actor.label ?? actor.id,
              role: actor.role ?? "player",
              areaId: actor.areaId,
              x: actor.x,
              y: actor.y,
              direction: actor.direction,
            }),
            appearance: actor.appearance,
            sprite: actor.sprite,
          },
          inventory: [],
          reservations: [],
          timelineEvents: [],
          resourceSpawns: [],
          areaResourceSpawns: [],
        };
      },
    };

    try {
      const socket = controlledSocket();
      shard.connect(socket, identity);
      await waitFor(() => socket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(submittedActors.at(-1)?.appearance?.face).toEqual(face);
      expect(submittedActors.at(-1)?.sprite).toBe("adventurer-premium-female");
      expect(helloActor(socket, identity.actorId)?.appearance.face).toEqual(face);
      expect(helloActor(socket, identity.actorId)?.sprite).toBe("adventurer-premium-female");
    } finally {
      shard.close();
    }
  });

  it("keeps an authored player alias bound to A while B enters and A returns", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: { actor: RustAuthorityActorUpsertInput }) => Promise<unknown>;
        setActorLinkDead?: (input: { actorId: string; linkDead: boolean }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
      applyRustAuthorityTickOutput: (output: RustAuthorityBridgeTickOutput) => GameCombatEvent[];
      createCheckpoint: () => { authoredPlaceholderOwners?: Record<string, string> };
      actorNetIds: Map<string, number>;
      actorIdsByNetId: Map<number, string>;
    };
    const submittedActors: RustAuthorityActorUpsertInput[] = [];
    const inventoryByRustActor = new Map<string, RustAuthorityInventorySnapshot[]>();
    const allInventory = (): RustAuthorityInventorySnapshot[] => (
      [...inventoryByRustActor.values()].flatMap((rows) => rows.map((row) => ({ ...row })))
    );
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async ({ actor }) => {
        submittedActors.push({ ...actor });
        if (actor.returning !== true) {
          inventoryByRustActor.set(actor.id, actor.bareStart === true ? [] : [
            { container: `${actor.id}:field-pack`, stackId: 1, item: "Stimpak A", itemId: 1001, variantId: 0, quantity: 16, reserved: 0, available: 16 },
          ]);
        }
        return {
          tick: 40 + submittedActors.length,
          actor: rustActorSnapshot({
            id: actor.id,
            entity: actor.entity,
            label: actor.label ?? actor.id,
            role: actor.role ?? "player",
            areaId: actor.areaId,
            x: actor.x,
            y: actor.y,
            direction: actor.direction,
            credits: 5_000,
            vitals: actor.id === "player" ? authoritativeAVitals : undefined,
            professions: actor.id === "player" ? authoritativeAProfessions : undefined,
            activeTitle: actor.id === "player" ? authoritativeATitle : undefined,
            weapon: undefined,
          }),
          inventory: allInventory(),
          reservations: [],
          timelineEvents: [],
          resourceSpawns: [],
          areaResourceSpawns: [],
        };
      },
      setActorLinkDead: async ({ actorId, linkDead }) => ({
        tick: 49,
        actor: rustActorSnapshot({
          id: actorId,
          entity: actorId === "player" ? characterA.actorId : actorId,
          label: actorId === "player" ? "Owner A" : actorId,
          role: "player",
          link_dead: linkDead,
          credits: actorId === "player" ? 5_000 : undefined,
          vitals: actorId === "player" ? authoritativeAVitals : undefined,
          professions: actorId === "player" ? authoritativeAProfessions : undefined,
          activeTitle: actorId === "player" ? authoritativeATitle : undefined,
        }),
        inventory: allInventory(),
        reservations: [],
        timelineEvents: [],
        resourceSpawns: [],
        areaResourceSpawns: [],
      }),
    };
    const characterA = {
      ...testCharacterIdentity("char-owner-a"),
      returningCharacter: false,
    };
    const characterB = {
      ...testCharacterIdentity("char-owner-b"),
      returningCharacter: false,
    };
    const durableAInventory: RustAuthorityInventorySnapshot[] = [
      { container: "player:field-pack", stackId: 201, item: "Creature Hide", itemId: 2101, variantId: 17, quantity: 13, reserved: 2, available: 11 },
      { container: "player:bank", stackId: 202, item: "Creature Bone", itemId: 2102, variantId: 19, quantity: 5, reserved: 0, available: 5 },
      { container: "player:field-pack", stackId: 203, item: "Creature Meat", itemId: 2103, variantId: 23, quantity: 4, reserved: 0, available: 4 },
    ];
    const authoritativeAProfessions: RustAuthorityProfessionSnapshot[] = [
      {
        id: "scout",
        label: "Scout",
        xp: 500,
        skillPoints: 2,
        skillBoxes: ["scout-novice", "scout-traversal-i"],
      },
      {
        id: "medic",
        label: "Medic",
        xp: 250,
        skillPoints: 1,
        skillBoxes: ["medic-novice"],
      },
    ];
    const authoritativeATitle = {
      id: "medic-novice",
      label: "Novice Medic",
      skillBoxId: "medic-novice",
    };
    const authoritativeAVitals = { health: 142, action: 118, spirit: 96 };

    try {
      const socketA = controlledSocket();
      shard.connect(socketA, characterA);
      await waitFor(() => socketA.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(submittedActors[0]).toMatchObject({
        id: "player",
        entity: characterA.actorId,
        bareStart: true,
        returning: false,
      });

      inventoryByRustActor.set("player", durableAInventory.map((row) => ({ ...row })));
      internals.applyRustAuthorityTickOutput({
        schema: "successor.rust-authority-bridge-tick.v1",
        requestId: 201,
        tick: 45,
        targetStateHash: "owner-a-harvest",
        actors: [rustActorSnapshot({
          id: "player",
          entity: characterA.actorId,
          label: "Owner A",
          credits: 5_000,
          vitals: authoritativeAVitals,
          professions: authoritativeAProfessions,
          activeTitle: authoritativeATitle,
        })],
        combatEvents: [],
        inventory: allInventory(),
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
        logoutActors: [],
        removedActorIds: [],
        metrics: {
          tick: 45,
          shotsFired: 0,
          combatEvents: 0,
          hits: 0,
          deaths: 0,
          inventoryStacks: durableAInventory.length,
          reservations: 0,
          npcJobs: 0,
          timelineEvents: 0,
        },
      });
      const onlineTakeoverSocket = controlledSocket();
      shard.connect(onlineTakeoverSocket, {
        ...characterA,
        returningCharacter: true,
        professionIds: ["marksman"],
        skillBoxIds: ["marksman-novice"],
        activeTitleId: "marksman-novice",
        credits: 1,
        vitals: { health: 1, action: 1, spirit: 1 },
      });
      await waitFor(() => onlineTakeoverSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(socketA.closed.at(-1)).toMatchObject({ code: 4000, reason: "game session replaced" });
      expect(submittedActors).toHaveLength(1);
      expect(helloActor(onlineTakeoverSocket, characterA.actorId)).toMatchObject({
        credits: 5_000,
        vitals: authoritativeAVitals,
        professions: authoritativeAProfessions,
        activeTitle: authoritativeATitle,
      });
      onlineTakeoverSocket.emitMessage(JSON.stringify({ type: "exit_world" }));
      await waitFor(() => submittedActors.length >= 2);
      expect(submittedActors[1]).toMatchObject({
        id: "player",
        entity: characterA.actorId,
        bareStart: true,
        returning: true,
      });
      expect(internals.createCheckpoint().authoredPlaceholderOwners).toEqual({ player: characterA.actorId });

      const socketB = controlledSocket();
      shard.connect(socketB, characterB);
      await waitFor(() => socketB.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(submittedActors[2]).toMatchObject({
        id: characterB.actorId,
        entity: characterB.actorId,
        bareStart: true,
        returning: false,
      });
      expect(inventoryByRustActor.get("player")).toEqual(durableAInventory);
      expect(inventoryByRustActor.get(characterB.actorId)).toEqual([]);

      const returningASocket = controlledSocket();
      shard.connect(returningASocket, { ...characterA, returningCharacter: true });
      await waitFor(() => returningASocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      const hello = packets(returningASocket).find((packet) => packet.type === "game.hello");
      const projectedActorIds = Object.keys(hello?.snapshot?.actors ?? {});
      expect(projectedActorIds).toContain(characterA.actorId);
      expect(projectedActorIds).toContain(characterB.actorId);
      expect(projectedActorIds).not.toContain("player");
      const helloInventory = (hello?.snapshot?.inventory ?? []) as RustAuthorityInventorySnapshot[];
      const aRows = helloInventory.filter((row) => row.container.startsWith(`${characterA.actorId}:`));
      expect(aRows).toEqual(durableAInventory.map((row) => ({
        ...row,
        container: row.container.replace(/^player:/u, `${characterA.actorId}:`),
      })));
      expect(internals.actorNetIds.has("player")).toBe(false);
      expect([...internals.actorIdsByNetId.values()]).not.toContain("player");
    } finally {
      shard.close();
    }
  });

  it("recovers legacy authored-placeholder ownership from Rust entity without duplicate projections", () => {
    const shard = testShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      characterPersistence: {
        hasCharacter: (characterId) => characterId === "char-recovered-owner",
        saveSnapshot: () => undefined,
      },
    });
    const internals = shard as unknown as {
      seedAuthoredPlaceholderOwnersFromRustActors: (actors: RustAuthorityActorSnapshot[]) => void;
      actorNetIds: Map<string, number>;
      actorIdsByNetId: Map<number, string>;
    };
    const originalPlayerNetId = internals.actorNetIds.get("player");
    try {
      internals.seedAuthoredPlaceholderOwnersFromRustActors([
        rustActorSnapshot({ id: "player", entity: "char-recovered-owner", label: "Recovered Owner" }),
      ]);
      expect(internals.actorNetIds.get("char-recovered-owner")).toBe(originalPlayerNetId);
      expect(internals.actorNetIds.has("player")).toBe(false);
      expect(originalPlayerNetId === undefined ? undefined : internals.actorIdsByNetId.get(originalPlayerNetId)).toBe("char-recovered-owner");

      const socket = controlledSocket();
      shard.connect(socket, {
        ...testCharacterIdentity("char-recovered-owner"),
        returningCharacter: true,
      });
      const hello = packets(socket).find((packet) => packet.type === "game.hello");
      expect(Object.keys(hello?.snapshot?.actors ?? {})).toContain("char-recovered-owner");
      expect(Object.keys(hello?.snapshot?.actors ?? {})).not.toContain("player");
    } finally {
      shard.close();
    }
  });

  it("does not treat an authored fixture entity as a durable placeholder owner", () => {
    const shard = testShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      characterPersistence: {
        hasCharacter: () => false,
        saveSnapshot: () => undefined,
      },
    });
    const internals = shard as unknown as {
      applyRustAuthorityTickOutput: (output: RustAuthorityBridgeTickOutput) => GameCombatEvent[];
      actorNetIds: Map<string, number>;
      actorIdsByNetId: Map<number, string>;
      authoredPlaceholderOwners: Map<string, string>;
      actors: Map<string, { characterId?: string }>;
      createCheckpoint: () => { authoredPlaceholderOwners?: Record<string, string> };
    };
    const originalPlayerNetId = internals.actorNetIds.get("player");
    try {
      internals.applyRustAuthorityTickOutput(rustTickOutput([
        rustActorSnapshot({ id: "player", entity: "1:1", label: "Authored Player" }),
      ], 17));
      expect(internals.actorNetIds.get("player")).toBe(originalPlayerNetId);
      expect(originalPlayerNetId === undefined ? undefined : internals.actorIdsByNetId.get(originalPlayerNetId)).toBe("player");
      expect(internals.authoredPlaceholderOwners.size).toBe(0);
      expect(internals.actors.get("player")?.characterId).toBeUndefined();

      const transientSocket = controlledSocket();
      shard.connect(transientSocket, {
        actorId: "transient-scout",
        playerId: "transient-scout",
        displayName: "Transient Scout",
        zoneId: "authority-test",
      });
      internals.applyRustAuthorityTickOutput(rustTickOutput([
        rustActorSnapshot({ id: "player", entity: "transient-scout", label: "Transient Scout" }),
      ], 18));
      expect(internals.authoredPlaceholderOwners.size).toBe(0);
      expect(internals.actors.get("transient-scout")?.characterId).toBeUndefined();
      transientSocket.emitClose();
      expect(internals.authoredPlaceholderOwners.size).toBe(0);
      expect(internals.createCheckpoint().authoredPlaceholderOwners).toBeUndefined();
      expect(internals.actors.get("player")?.characterId).toBeUndefined();
    } finally {
      shard.close();
    }
  });

  it("restores a pristine authored placeholder with its fixture entity", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    const internals = shard as unknown as {
      actors: Map<string, unknown>;
      rustActorUpsertInput: (actor: unknown, rustActorId: string) => RustAuthorityActorUpsertInput;
    };
    try {
      const player = internals.actors.get("player");
      expect(player).toBeDefined();
      expect(internals.rustActorUpsertInput(player, "player")).toMatchObject({
        id: "player",
        entity: "1:1",
      });
    } finally {
      shard.close();
    }
  });

  it("rejects durable and raw-dev identities that collide with protected actors", () => {
    const durableIds = new Set(["char-existing"]);
    const shard = testShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      allowReservedActorSessionsForTests: false,
      characterPersistence: {
        hasCharacter: (id) => durableIds.has(id),
        saveSnapshot: () => undefined,
      },
    });
    const internals = shard as unknown as { inventory: RustAuthorityInventorySnapshot[] };
    const inventoryBefore = JSON.stringify(internals.inventory);
    try {
      for (const characterId of ["player", "vendor"]) {
        const socket = controlledSocket();
        expect(() => shard.connect(socket, testCharacterIdentity(characterId))).toThrow(
          "character id collides with authored actor",
        );
        expect(socket.closed).toEqual([{ code: 1008, reason: "character id collides with authored actor" }]);
      }
      for (const actorId of ["player", "vendor"]) {
        const socket = controlledSocket();
        expect(() => shard.connect(socket, {
          actorId,
          playerId: "browser-selected",
          displayName: "Impostor",
          zoneId: "authority-test",
        })).toThrow("character id collides with authored actor");
        expect(socket.closed).toEqual([{ code: 1008, reason: "character id collides with authored actor" }]);
      }
      const rawSocket = controlledSocket();
      expect(() => shard.connect(rawSocket, {
        actorId: "char-existing",
        playerId: "browser-selected",
        displayName: "Impostor",
        zoneId: "authority-test",
      })).toThrow("durable character identity required");
      expect(rawSocket.closed).toEqual([{ code: 1008, reason: "durable character identity required" }]);

      const mismatchedSocket = controlledSocket();
      expect(() => shard.connect(mismatchedSocket, {
        ...testCharacterIdentity("char-existing"),
        actorId: "char-other",
      })).toThrow("character identity does not match actor id");
      expect(mismatchedSocket.closed).toEqual([{ code: 1008, reason: "character identity does not match actor id" }]);
      expect(JSON.stringify(internals.inventory)).toBe(inventoryBefore);
    } finally {
      shard.close();
    }
  });

  it("does not abort durable character entry when last-seen metadata persistence fails", () => {
    const characterId = "mark-seen-fault-character";
    const shard = testShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      allowReservedActorSessionsForTests: false,
      characterPersistence: {
        hasCharacter: (id) => id === characterId,
        saveSnapshot: () => undefined,
        markSeen: () => {
          throw new Error("injected markSeen persistence failure");
        },
      },
    });
    try {
      const socket = controlledSocket();
      expect(() => shard.connect(socket, {
        ...testCharacterIdentity(characterId),
        returningCharacter: true,
      })).not.toThrow();
      expect(helloActor(socket, characterId)).toBeDefined();
      expect(shard.characterLiveState(characterId)).toBe("online");
      expect(shard.status().sessionCount).toBe(1);
    } finally {
      shard.close();
    }
  });

  it("reserves global inventory container namespaces from character and network actor ids", () => {
    const shard = testShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      allowReservedActorSessionsForTests: false,
    });
    try {
      for (const characterId of [
        "corpse",
        "corpse:loot-victim",
        "corpse/loot-victim",
        "corpse-loot-victim",
        "cache",
        "cache:open-desert-cache-01",
        "cache/open-desert-cache-01",
        "cache-open-desert-cache-01",
        "district-exchange",
        "district-exchange-alpha",
      ]) {
        expect(shard.isReservedCharacterId(characterId), characterId).toBe(true);
      }
      for (const characterId of ["corpsekeeper", "cachet", "district-exchanger"]) {
        expect(shard.isReservedCharacterId(characterId), characterId).toBe(false);
      }

      for (const characterId of ["corpse", "cache-open-desert-cache-01", "district-exchange-alpha"]) {
        const socket = controlledSocket();
        expect(() => shard.connect(socket, testCharacterIdentity(characterId))).toThrow(
          "character id collides with authored actor",
        );
        expect(socket.closed).toEqual([{ code: 1008, reason: "character id collides with authored actor" }]);
      }

      const networkSocket = controlledSocket();
      expect(() => shard.connect(networkSocket, {
        actorId: "cache",
        playerId: "browser-selected",
        displayName: "Namespace Impostor",
        zoneId: "authority-test",
      })).toThrow("character id collides with authored actor");
      expect(networkSocket.closed).toEqual([{ code: 1008, reason: "character id collides with authored actor" }]);
    } finally {
      shard.close();
    }
  });

  it("rejects an existing actor unless it is bound to the same durable character", () => {
    const shard = testShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      allowReservedActorSessionsForTests: false,
    });
    try {
      const transientSocket = controlledSocket();
      shard.connect(transientSocket, {
        actorId: "occupied-slot",
        playerId: "browser-selected",
        displayName: "Transient Occupant",
        zoneId: "authority-test",
      });

      const collisionSocket = controlledSocket();
      expect(() => shard.connect(collisionSocket, testCharacterIdentity("occupied-slot"))).toThrow(
        "actor identity collision",
      );
      expect(collisionSocket.closed).toEqual([{ code: 1008, reason: "actor identity collision" }]);
      expect(transientSocket.closed).toEqual([]);
      expect(shard.status().sessionCount).toBe(1);

      const firstCharacterSocket = controlledSocket();
      shard.connect(firstCharacterSocket, testCharacterIdentity("same-durable-character"));
      const replacementSocket = controlledSocket();
      shard.connect(replacementSocket, testCharacterIdentity("same-durable-character"));
      expect(firstCharacterSocket.closed).toEqual([{ code: 4000, reason: "game session replaced" }]);
      expect(replacementSocket.closed).toEqual([]);
      expect(shard.status().sessionCount).toBe(2);
    } finally {
      shard.close();
    }
  });

  it("restores direct and placeholder character bindings before link-dead expiry", async () => {
    const durableIds = new Set([
      "restart-char-a",
      "restart-char-b",
      "restart-char-expiring",
      "restart-npc-collision",
    ]);
    const savedSnapshots: Array<{ characterId: string; reason: string; x: number; y: number }> = [];
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      characterPersistence: {
        hasCharacter: (characterId) => durableIds.has(characterId),
        saveSnapshot: (characterId, snapshot, options) => {
          savedSnapshots.push({ characterId, reason: options.reason, x: snapshot.x, y: snapshot.y });
        },
      },
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const stateHash = "d".repeat(64);
    const restoredActors = [
      rustActorSnapshot({ id: "restart-char-a", entity: "restart-char-a", role: "player", label: "Restart A" }),
      rustActorSnapshot({ id: "restart-char-b", entity: "restart-char-b", role: "player", label: "Restart B" }),
      rustActorSnapshot({
        id: "player",
        entity: "restart-char-expiring",
        role: "player",
        label: "Restart Expiring",
        link_dead: true,
        x: 37,
        y: 41,
      }),
      rustActorSnapshot({
        id: "restart-npc-collision",
        entity: "npc:restart-npc-collision",
        role: "skirmisher",
        label: "Runtime NPC",
      }),
    ];
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        pendingCount?: () => number;
        debugStatus?: () => unknown;
        importState?: () => Promise<RustAuthorityBridgeImportStateOutput>;
        setActorLinkDead?: (input: { actorId: string; linkDead: boolean }) => Promise<unknown>;
      };
      actors: Map<string, { characterId?: string }>;
      characterIdsByActorId: Map<string, string>;
      characterActorIds: Map<string, string>;
      realCharacterActorIds: Set<string>;
      returningCharacterActorIds: Set<string>;
      applyRustAuthorityTickOutput: (output: RustAuthorityBridgeTickOutput) => GameCombatEvent[];
      createCheckpoint: (rustState: unknown) => Record<string, unknown>;
      checkpointProjectionStateHash: (checkpoint: unknown) => string;
      restoreLiveRustAuthorityCheckpoint: (checkpoint: unknown, path: string) => Promise<void>;
    };
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => undefined,
      pendingCount: () => 0,
      debugStatus: () => null,
      importState: async () => ({
        schema: "successor.rust-authority-bridge-import-state.v1",
        requestId: 1,
        tick: 61,
        targetStateHash: stateHash,
        actors: restoredActors,
        combatEvents: [],
        inventory: [],
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
        logoutActors: [],
        removedActorIds: [],
        metrics: rustTickOutput([], 61).metrics,
      } as RustAuthorityBridgeImportStateOutput),
      setActorLinkDead: async ({ actorId, linkDead }) => ({
        tick: 63,
        actor: {
          ...(restoredActors.find((actor) => actor.id === actorId) ?? rustActorSnapshot({ id: actorId })),
          link_dead: linkDead,
        },
        inventory: [],
        reservations: [],
        timelineEvents: [],
      }),
    };
    const checkpoint = internals.createCheckpoint({
      schema: "authority.checkpoint-state.v1",
      version: 1,
      tick: 61,
      stateHash,
      state: { schema: "successor.authority-state.v1", version: 1, stateHash },
    });
    checkpoint.authoredPlaceholderOwners = { player: "restart-char-expiring" };
    checkpoint.projectionStateHash = internals.checkpointProjectionStateHash(checkpoint);

    try {
      await internals.restoreLiveRustAuthorityCheckpoint(checkpoint, path.join("tmp", "direct-character-restart.checkpoint.json"));
      expect(internals.actors.get("restart-char-a")?.characterId).toBe("restart-char-a");
      expect(internals.actors.get("restart-char-b")?.characterId).toBe("restart-char-b");
      expect(internals.actors.get("restart-char-expiring")?.characterId).toBe("restart-char-expiring");
      expect(internals.actors.get("restart-npc-collision")?.characterId).toBeUndefined();
      for (const characterId of ["restart-char-a", "restart-char-b", "restart-char-expiring"]) {
        expect(internals.characterIdsByActorId.get(characterId)).toBe(characterId);
        expect(internals.characterActorIds.get(characterId)).toBe(characterId);
        expect(internals.realCharacterActorIds.has(characterId)).toBe(true);
        expect(internals.returningCharacterActorIds.has(characterId)).toBe(true);
      }

      internals.applyRustAuthorityTickOutput({
        schema: "successor.rust-authority-bridge-tick.v1",
        requestId: 2,
        tick: 62,
        targetStateHash: "f".repeat(64),
        actors: [],
        combatEvents: [],
        inventory: [],
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
        logoutActors: [rustActorSnapshot({
          id: "player",
          entity: "restart-char-expiring",
          role: "player",
          label: "Restart Expiring",
          link_dead: true,
          x: 43,
          y: 47,
        })],
        removedActorIds: ["player"],
        metrics: rustTickOutput([], 62).metrics,
      });
      expect(savedSnapshots).toContainEqual({
        characterId: "restart-char-expiring",
        reason: "linkdead_timeout",
        x: 43,
        y: 47,
      });
      expect(internals.characterIdsByActorId.has("restart-char-expiring")).toBe(false);
      expect(internals.characterActorIds.has("restart-char-expiring")).toBe(false);

      const socketB = controlledSocket();
      shard.connect(socketB, { ...testCharacterIdentity("restart-char-b"), returningCharacter: true });
      const socketA = controlledSocket();
      shard.connect(socketA, { ...testCharacterIdentity("restart-char-a"), returningCharacter: true });
      expect(socketA.closed).toEqual([]);
      expect(socketB.closed).toEqual([]);
      expect(shard.status().sessionCount).toBe(2);

      const npcCollisionSocket = controlledSocket();
      expect(() => shard.connect(
        npcCollisionSocket,
        { ...testCharacterIdentity("restart-npc-collision"), returningCharacter: true },
      )).toThrow("actor identity collision");
      expect(npcCollisionSocket.closed).toEqual([{ code: 1008, reason: "actor identity collision" }]);
      expect(shard.status().sessionCount).toBe(2);
    } finally {
      await shard.close();
    }
  });

  it("allows existing raw actors only through the explicit in-process harness escape hatch", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const firstSocket = controlledSocket();
      shard.connect(firstSocket, {
        actorId: "harness-owned-actor",
        playerId: "harness-one",
        displayName: "Harness One",
        zoneId: "authority-test",
      });
      const replacementSocket = controlledSocket();
      shard.connect(replacementSocket, {
        actorId: "harness-owned-actor",
        playerId: "harness-two",
        displayName: "Harness Two",
        zoneId: "authority-test",
      });

      expect(firstSocket.closed).toEqual([{ code: 4000, reason: "game session replaced" }]);
      expect(replacementSocket.closed).toEqual([]);
      expect(shard.status().sessionCount).toBe(1);
    } finally {
      shard.close();
    }
  });

  it("treats exit_world as a clean character logout that saves and despawns without LD", () => {
    const saves: Array<{ characterId: string; snapshot: GameActorSnapshot; options: { logout?: boolean; playMs?: number } }> = [];
    const shard = testShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      characterPersistence: {
        saveSnapshot: (characterId, snapshot, options) => saves.push({ characterId, snapshot, options }),
      },
    });
    try {
      const socket = controlledSocket();
      shard.connect(socket, {
        actorId: "char-clean-exit",
        playerId: "local",
        displayName: "Cleanexit",
        zoneId: "authority-test",
        characterId: "char-clean-exit",
        ownerRef: "local",
        appearance: { skin: "#aabbcc", hair: "hair_crop2", hair_mat: "hair_chestnut" },
        spawn: { areaId: "authority-test-overworld", x: 11, y: 17, facing: "right" },
      });

      expect(shard.characterLiveState("char-clean-exit")).toBe("online");
      socket.emitMessage(JSON.stringify({ type: "exit_world" }));

      const actors = (shard as unknown as { actors: Map<string, { linkDead?: boolean }> }).actors;
      expect(shard.characterLiveState("char-clean-exit")).toBe("offline");
      expect(actors.has("char-clean-exit")).toBe(false);
      expect(saves.at(-1)).toMatchObject({
        characterId: "char-clean-exit",
        options: { logout: true },
        snapshot: {
          id: "char-clean-exit",
          display_name: "Cleanexit",
          link_dead: false,
          areaId: "authority-test-overworld",
          x: 11,
          y: 17,
        },
      });
      expect(saves.at(-1)?.options.playMs).toBeGreaterThanOrEqual(0);
    } finally {
      shard.close();
    }
  });

  it("keeps socket drops on the link-dead hold path and clears LD on reattach", () => {
    const saves: Array<{ characterId: string; snapshot: GameActorSnapshot; options: { logout?: boolean } }> = [];
    const shard = testShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      characterPersistence: {
        saveSnapshot: (characterId, snapshot, options) => saves.push({ characterId, snapshot, options }),
      },
    });
    try {
      const identity = {
        actorId: "char-drop-exit",
        playerId: "local",
        displayName: "Dropchar",
        zoneId: "authority-test",
        characterId: "char-drop-exit",
        ownerRef: "local",
        appearance: { skin: "#aabbcc", hair: "hair_crop2", hair_mat: "hair_chestnut" },
        spawn: { areaId: "authority-test-overworld", x: 11, y: 17, facing: "right" as const },
      };
      const actors = (shard as unknown as { actors: Map<string, { linkDead?: boolean }> }).actors;
      const firstSocket = controlledSocket();
      shard.connect(firstSocket, identity);

      firstSocket.emitClose();

      expect(shard.characterLiveState("char-drop-exit")).toBe("linkdead");
      expect(actors.get("char-drop-exit")?.linkDead).toBe(true);
      expect(saves.at(-1)).toMatchObject({
        characterId: "char-drop-exit",
        options: { logout: true },
        snapshot: { id: "char-drop-exit", link_dead: true },
      });

      const reattachSocket = controlledSocket();
      shard.connect(reattachSocket, identity);

      expect(shard.characterLiveState("char-drop-exit")).toBe("online");
      expect(actors.get("char-drop-exit")?.linkDead).toBe(false);
    } finally {
      shard.close();
    }
  });

  it("rebroadcasts link-dead false to an online observer after same-actor reattach", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    const internals = shard as unknown as {
      actors: Map<string, {
        areaId: string;
        x: number;
        y: number;
        direction: string;
        label: string;
        linkDead: boolean;
      }>;
      dirtyActorIds: Set<string>;
      highDetailDirtyActorIds: Set<string>;
      applyRustAuthorityTickOutput: (output: RustAuthorityBridgeTickOutput) => unknown;
    };
    try {
      const reconnectIdentity = testCharacterIdentity("linkdead-reconnect-a", {
        areaId: "authority-test-overworld",
        x: 11,
        y: 17,
        facing: "right",
      });
      const observerIdentity = testCharacterIdentity("linkdead-observer-b", {
        areaId: "authority-test-overworld",
        x: 12,
        y: 17,
        facing: "left",
      });
      const firstSocket = controlledSocket();
      const observerSocket = controlledSocket();
      shard.connect(firstSocket, reconnectIdentity);
      shard.connect(observerSocket, observerIdentity);
      observerSocket.sent.length = 0;

      firstSocket.emitClose();
      shard.flushSnapshotsForTest();

      const linkDeadDelta = packets(observerSocket).find((packet) => (
        packet.type === "game.delta"
        && (packet.delta.actorPatches?.[reconnectIdentity.actorId]
          || packet.delta.compactActorPatches?.some((patch: GameCompactActorPatch) => patch[0] === reconnectIdentity.actorId))
      ));
      const linkDeadPatch = linkDeadDelta?.delta.actorPatches?.[reconnectIdentity.actorId]?.link_dead
        ?? linkDeadDelta?.delta.compactActorPatches?.find((patch: GameCompactActorPatch) => patch[0] === reconnectIdentity.actorId)?.[45] === 1;
      expect(linkDeadPatch).toBe(true);

      observerSocket.sent.length = 0;
      const reattachSocket = controlledSocket();
      shard.connect(reattachSocket, reconnectIdentity);
      expect(helloActor(reattachSocket, reconnectIdentity.actorId)?.link_dead).toBe(false);

      // Model a flush that consumed bindCharacterActor's eager TS dirty before
      // Rust confirmed the reattachment. The confirmation must create a fresh
      // AOI/detail dirty even though TS already holds false.
      internals.dirtyActorIds.clear();
      internals.highDetailDirtyActorIds.clear();
      const actor = internals.actors.get(reconnectIdentity.actorId);
      expect(actor).toBeDefined();
      internals.applyRustAuthorityTickOutput(rustTickOutput([
        rustActorSnapshot({
          id: reconnectIdentity.actorId,
          entity: reconnectIdentity.actorId,
          role: "player",
          label: actor!.label,
          areaId: actor!.areaId,
          x: actor!.x,
          y: actor!.y,
          direction: actor!.direction as "front" | "right" | "back" | "left",
          link_dead: false,
        }),
      ], shard.status().tick + 1));
      shard.flushSnapshotsForTest();

      const reattachedDelta = packets(observerSocket).find((packet) => (
        packet.type === "game.delta"
        && (packet.delta.actorPatches?.[reconnectIdentity.actorId]
          || packet.delta.compactActorPatches?.some((patch: GameCompactActorPatch) => patch[0] === reconnectIdentity.actorId))
      ));
      const reattachedLinkDeadPatch = reattachedDelta?.delta.actorPatches?.[reconnectIdentity.actorId]?.link_dead
        ?? reattachedDelta?.delta.compactActorPatches?.find((patch: GameCompactActorPatch) => patch[0] === reconnectIdentity.actorId)?.[45] === 1;
      expect(reattachedLinkDeadPatch).toBe(false);
    } finally {
      shard.close();
    }
  });

  it("takes over an online character with the authority position, current weapon, and a fresh movement stamp", async () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const identity = testCharacterIdentity("char-reentry-online");
      const spawnX = identity.spawn?.x;
      if (spawnX === undefined) throw new Error("test identity spawn x missing");
      const firstSocket = controlledSocket();
      shard.connect(firstSocket, identity);

      firstSocket.emitMessage(JSON.stringify({
        type: "game.command",
        envelope: envelope(1, { SetEquippedWeapon: { weapon_id: "vibrosword" } }),
      }));
      await waitFor(() => packets(firstSocket).some((packet) => (
        packet.type === "game.delta"
        && Array.isArray(packet.receipts)
        && packet.receipts.some((receipt: { commandId?: number; accepted?: boolean }) => receipt.commandId === 1 && receipt.accepted)
      )));
      const moved = shard.submitCommandForTest(identity.actorId, envelope(2, {
        Move: { dx: 1, dy: 0, duration_ticks: 10, facing: "Right" },
      }));
      expect(moved.receipt.accepted).toBe(true);
      shard.advanceAuthorityForTest(12);
      const current = shard.snapshotFor(identity.actorId).actors[identity.actorId];
      expect(current?.x).toBeGreaterThan(spawnX);

      const takeoverSocket = controlledSocket();
      shard.connect(takeoverSocket, {
        ...identity,
        spawn: { areaId: "authority-test-overworld", x: 40, y: 40, facing: "left" },
      });

      expect(firstSocket.closed.at(-1)).toMatchObject({ code: 4000, reason: "game session replaced" });
      expect(shard.status().sessionCount).toBe(1);
      const rejoined = helloActor(takeoverSocket, identity.actorId);
      expect(rejoined).toMatchObject({
        x: current?.x,
        y: current?.y,
        direction: current?.direction,
        weapon: expect.objectContaining({ weaponId: "vibrosword" }),
      });

      takeoverSocket.emitMessage(JSON.stringify({
        type: "game.command",
        envelope: envelope(1, { Move: { dx: 0, dy: 1, duration_ticks: 1, facing: "Front" } }),
      }));
      await waitFor(() => packets(takeoverSocket).some((packet) => (
        packet.type === "game.acks"
        && Array.isArray(packet.acks)
        && packet.acks.some((ack: unknown[]) => ack[0] === 1)
      )));
      const ackPacket = packets(takeoverSocket).find((packet) => packet.type === "game.acks" && Array.isArray(packet.acks));
      const ack = ackPacket?.acks.find((entry: unknown[]) => entry[0] === 1);
      expect(ack?.[0]).toBe(1);
      expect(ack?.[1]).toBe(1);
    } finally {
      shard.close();
    }
  });

  it("reattaches a link-dead character from the Rust authority actor instead of re-upserting stale equip", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: { actor: RustAuthorityActorUpsertInput }) => Promise<unknown>;
        setActorLinkDead?: (input: { actorId: string; linkDead: boolean }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
    };
    const registeredProfessionIds = ["scout", "medic"];
    const registeredSkillBoxIds = ["scout-novice", "scout-traversal-i", "medic-novice"];
    const registeredProfessions: RustAuthorityProfessionSnapshot[] = [
      { id: "scout", label: "Scout", xp: 180, skillPoints: 2, skillBoxes: registeredSkillBoxIds.slice(0, 2) },
      { id: "medic", label: "Medic", xp: 90, skillPoints: 1, skillBoxes: [registeredSkillBoxIds[2]!] },
    ];
    const registeredTitle = { id: "medic-novice", label: "Novice Medic", skillBoxId: "medic-novice" };
    const registeredVitals = { health: 142, action: 118, spirit: 96 };
    const registeredCredits = 4_321;
    const identity = {
      ...testCharacterIdentity("char-ld-rust"),
      professionIds: registeredProfessionIds,
      skillBoxIds: registeredSkillBoxIds,
      activeTitleId: registeredTitle.id,
      credits: registeredCredits,
      vitals: registeredVitals,
    };
    const submitActorIds: string[] = [];
    const linkDeadCalls: boolean[] = [];
    let authoritativeWeapon = rustWeaponSnapshot("slugthrower");
    const rowsFor = (rustActorId: string): RustAuthorityInventorySnapshot[] => [
      { container: `${rustActorId}:field-pack`, stackId: 1, item: "Stimpak A", itemId: 1001, variantId: 0, quantity: 16, reserved: 0, available: 16 },
      { container: `${rustActorId}:field-pack`, stackId: 2, item: "Field Bandage", itemId: 1002, variantId: 0, quantity: 16, reserved: 0, available: 16 },
      { container: `${rustActorId}:field-pack`, stackId: 3, item: "Iron Slug", itemId: 1101, variantId: 0, quantity: 240, reserved: 0, available: 240 },
    ];
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async ({ actor }) => {
        submitActorIds.push(actor.id);
        return {
          tick: 11,
          actor: rustActorSnapshot({
            id: actor.id,
            label: actor.label ?? actor.id,
            link_dead: actor.linkDead ?? false,
            role: actor.role ?? "player",
            areaId: actor.areaId,
            x: actor.x,
            y: actor.y,
            direction: actor.direction,
            credits: registeredCredits,
            vitals: registeredVitals,
            professions: registeredProfessions,
            activeTitle: registeredTitle,
            weapon: authoritativeWeapon,
          }),
          inventory: rowsFor(actor.id),
          reservations: [],
          timelineEvents: [],
          resourceSpawns: [],
          areaResourceSpawns: [],
        };
      },
      setActorLinkDead: async ({ actorId, linkDead }) => {
        linkDeadCalls.push(linkDead);
        return {
          tick: linkDead ? 12 : 13,
          actor: rustActorSnapshot({
            id: actorId,
            label: "Linkdead Rust",
            link_dead: linkDead,
            role: "player",
            areaId: "authority-test-overworld",
            x: 18,
            y: 19,
            direction: "front",
            credits: registeredCredits,
            vitals: registeredVitals,
            professions: registeredProfessions,
            activeTitle: registeredTitle,
            weapon: authoritativeWeapon,
          }),
          inventory: rowsFor(actorId),
          reservations: [],
          timelineEvents: [],
          resourceSpawns: [],
          areaResourceSpawns: [],
        };
      },
    };

    try {
      const firstSocket = controlledSocket();
      shard.connect(firstSocket, identity);
      await waitFor(() => firstSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(submitActorIds).toEqual(["player"]);

      authoritativeWeapon = rustWeaponSnapshot("vibrosword", 3104);
      firstSocket.emitClose();
      await waitFor(() => linkDeadCalls.includes(true));

      const reattachSocket = controlledSocket();
      shard.connect(reattachSocket, {
        ...identity,
        spawn: { areaId: "authority-test-overworld", x: 40, y: 40, facing: "left" },
      });
      await waitFor(() => reattachSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));

      expect(linkDeadCalls).toEqual([true, false]);
      expect(submitActorIds).toEqual(["player"]);
      expect(helloActor(reattachSocket, identity.actorId)).toMatchObject({
        x: 18,
        y: 19,
        direction: "front",
        link_dead: false,
        weapon: expect.objectContaining({ weaponId: "vibrosword", weaponItemId: 3104 }),
        credits: registeredCredits,
        vitals: registeredVitals,
        professions: registeredProfessions,
        activeTitle: registeredTitle,
      });
    } finally {
      shard.close();
    }
  });

  it("preserves exact character inventory through Rust upsert after link-dead expiry", async () => {
    const saves: Array<{ characterId: string; snapshot: GameActorSnapshot; options: { reason: string; logout?: boolean } }> = [];
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      characterPersistence: {
        hasCharacter: (candidate) => candidate === "char-ld-expired",
        saveSnapshot: (characterId, snapshot, options) => saves.push({ characterId, snapshot, options }),
      },
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: { actor: RustAuthorityActorUpsertInput }) => Promise<unknown>;
        setActorLinkDead?: (input: { actorId: string; linkDead: boolean }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
      actors: Map<string, {
        characterId?: string;
        linkDead: boolean;
        areaId: string;
        x: number;
        y: number;
        professionIds?: string[];
        vitals: { health: number; action: number; spirit: number };
        worn?: unknown;
      }>;
      applyRustAuthorityTickOutput: (output: RustAuthorityBridgeTickOutput) => GameCombatEvent[];
      createCheckpoint: () => { authoredPlaceholderOwners?: Record<string, string> };
    };
    const profileProfessionIds = ["marksman", "craftsman"];
    const profileSkillBoxIds = [
      "marksman-novice",
      "marksman-rifle-i",
      "marksman-rifle-ii",
      "marksman-rifle-iii",
      "craftsman-novice",
    ];
    const profileTitle = { id: "craftsman-novice", label: "Novice Craftsman", skillBoxId: "craftsman-novice" };
    const profileProfessions: RustAuthorityProfessionSnapshot[] = [
      { id: "marksman", label: "Marksman", xp: 240, trackXp: { rifle: 200, tactics: 40 }, skillPoints: 4, skillBoxes: profileSkillBoxIds.slice(0, 4) },
      { id: "craftsman", label: "Craftsman", xp: 80, trackXp: { assembly: 60, experimentation: 20 }, skillPoints: 1, skillBoxes: [profileSkillBoxIds[4]!] },
    ];
    const profileSkillPointCap = 300;
    const profileVitals = { health: 123, action: 111, spirit: 77 };
    const profileCredits = 9_876;
    const identity = {
      ...testCharacterIdentity("char-ld-expired"),
      returningCharacter: false,
      professionIds: profileProfessionIds,
      skillBoxIds: profileSkillBoxIds,
      professions: profileProfessions,
      skillPointsCap: profileSkillPointCap,
      activeTitleId: profileTitle.id,
      credits: profileCredits,
      vitals: profileVitals,
    };
    const characterId = identity.characterId;
    if (characterId === undefined) throw new Error("test identity character id missing");
    const submitActorIds: string[] = [];
    const submittedActors: RustAuthorityActorUpsertInput[] = [];
    const linkDeadCalls: boolean[] = [];
    const deployRowsFor = (rustActorId: string): RustAuthorityInventorySnapshot[] => ([
          { container: `${rustActorId}:field-pack`, stackId: 1, item: "Stimpak A", itemId: 1001, variantId: 0, quantity: 16, reserved: 0, available: 16 },
          { container: `${rustActorId}:field-pack`, stackId: 2, item: "Field Bandage", itemId: 1002, variantId: 0, quantity: 16, reserved: 0, available: 16 },
          { container: `${rustActorId}:field-pack`, stackId: 3, item: "Iron Slug", itemId: 1101, variantId: 0, quantity: 240, reserved: 0, available: 240 },
    ]);
    let durableRows: RustAuthorityInventorySnapshot[] = [];
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async ({ actor }) => {
        submitActorIds.push(actor.id);
        submittedActors.push({ ...actor });
        if (actor.returning !== true) {
          durableRows = actor.bareStart === true ? [] : deployRowsFor(actor.id);
        }
        return {
          tick: 21 + submitActorIds.length,
          actor: rustActorSnapshot({
            id: actor.id,
            label: actor.label ?? actor.id,
            role: actor.role ?? "player",
            areaId: actor.areaId,
            x: actor.x,
            y: actor.y,
            direction: actor.direction,
            credits: actor.credits,
            vitals: actor.vitals,
            maxVitals: actor.maxVitals,
            professions: profileProfessions,
            activeTitle: profileTitle,
            weapon: actor.bareStart === true || actor.returning === true ? undefined : rustWeaponSnapshot("slugthrower"),
          }),
          inventory: durableRows.map((row) => ({ ...row })),
          reservations: [],
          timelineEvents: [],
          resourceSpawns: [],
          areaResourceSpawns: [],
        };
      },
      setActorLinkDead: async ({ actorId, linkDead }) => {
        linkDeadCalls.push(linkDead);
        return {
          tick: 23,
          actor: rustActorSnapshot({
            id: actorId,
            link_dead: linkDead,
            professions: profileProfessions,
            activeTitle: profileTitle,
            vitals: profileVitals,
            credits: profileCredits,
          }),
          inventory: durableRows.map((row) => ({ ...row })),
          reservations: [],
          timelineEvents: [],
          resourceSpawns: [],
          areaResourceSpawns: [],
        };
      },
    };

    try {
      const firstSocket = controlledSocket();
      shard.connect(firstSocket, identity);
      await waitFor(() => firstSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      durableRows = [
        { container: `${characterId}:field-pack`, stackId: 91, item: "Creature Hide", itemId: 2101, variantId: 7, quantity: 13, reserved: 2, available: 11 },
        { container: `${characterId}:bank`, stackId: 92, item: "Creature Bone", itemId: 2102, variantId: 9, quantity: 5, reserved: 0, available: 5 },
        { container: `${characterId}:field-pack`, stackId: 93, item: "Creature Meat", itemId: 2103, variantId: 3, quantity: 4, reserved: 0, available: 4 },
      ];
      firstSocket.emitClose();
      await waitFor(() => linkDeadCalls.length === 1);

      internals.applyRustAuthorityTickOutput({
        schema: "successor.rust-authority-bridge-tick.v1",
        requestId: 99,
        tick: 30,
        targetStateHash: "linkdead-expiry-test",
        actors: [],
        combatEvents: [],
        inventory: durableRows.map((row) => ({ ...row })),
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
        logoutActors: [rustActorSnapshot({
          id: characterId,
          label: "Expired Linkdead",
          link_dead: true,
          areaId: "authority-test-overworld",
          x: 22,
          y: 23,
          direction: "left",
          weapon: rustWeaponSnapshot("vibrosword", 3104),
          professions: profileProfessions,
          activeTitle: profileTitle,
          vitals: profileVitals,
          credits: profileCredits,
        })],
        removedActorIds: [characterId],
        metrics: {
          tick: 30,
          shotsFired: 0,
          combatEvents: 0,
          hits: 0,
          deaths: 0,
          inventoryStacks: 0,
          reservations: 0,
          npcJobs: 0,
          timelineEvents: 0,
        },
      });
      expect(shard.characterLiveState(characterId)).toBe("offline");
      expect(internals.actors.has(characterId)).toBe(false);
      expect(internals.actors.get("player")).toMatchObject({
        characterId: undefined,
        linkDead: false,
        areaId: "authority-test-overworld",
        x: 11,
        y: 17,
        professionIds: undefined,
        vitals: { health: 100, action: 100, spirit: 100 },
      });
      expect(saves.at(-1)).toMatchObject({
        characterId,
        options: { reason: "linkdead_timeout", logout: true },
        snapshot: { x: 22, y: 23, weapon: expect.objectContaining({ weaponId: "vibrosword" }) },
      });
      const expiryCheckpoint = internals.createCheckpoint();
      expect(expiryCheckpoint.authoredPlaceholderOwners).toBeUndefined();
      const restartedProjection = testShard({
        slicePath,
        snapshotIntervalMs: 10_000,
        characterPersistence: {
          hasCharacter: (candidate) => candidate === characterId || candidate === "char-after-expiry-b",
          saveSnapshot: () => undefined,
        },
      });
      try {
        const restartedInternals = restartedProjection as unknown as {
          restoreAuthoredPlaceholderOwners: (value: unknown) => void;
          rustActorIdFor: (actorId: string) => string;
        };
        restartedInternals.restoreAuthoredPlaceholderOwners(expiryCheckpoint.authoredPlaceholderOwners);
        expect(restartedInternals.rustActorIdFor(characterId)).toBe(characterId);
        expect(restartedInternals.rustActorIdFor("char-after-expiry-b")).toBe("char-after-expiry-b");
        const otherSocket = controlledSocket();
        restartedProjection.connect(otherSocket, testCharacterIdentity("char-after-expiry-b"));
        expect(helloActor(otherSocket, "char-after-expiry-b")).toBeDefined();
        expect(helloActor(otherSocket, "player")).toBeUndefined();
        const ownerSocket = controlledSocket();
        restartedProjection.connect(ownerSocket, {
          ...identity,
          returningCharacter: true,
        });
        expect(restartedInternals.rustActorIdFor(characterId)).toBe(characterId);
        expect(helloActor(ownerSocket, characterId)).toBeDefined();
        expect(helloActor(ownerSocket, "player")).toBeUndefined();
      } finally {
        restartedProjection.close();
      }

      const reenterSocket = controlledSocket();
      shard.connect(reenterSocket, {
        ...identity,
        returningCharacter: true,
        spawn: { areaId: "authority-test-overworld", x: 22, y: 23, facing: "left" },
      });
      await waitFor(() => reenterSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(submitActorIds).toEqual([characterId, characterId]);
      expect(submittedActors.map((actor) => actor.bareStart)).toEqual([true, true]);
      expect(submittedActors.map((actor) => actor.returning)).toEqual([false, true]);
      expect(submittedActors[0]).toMatchObject({
        professionIds: profileProfessionIds,
        skillBoxIds: profileSkillBoxIds,
        professionXp: { marksman: 240, craftsman: 80 },
        professionTrackXp: {
          "marksman:rifle": 200,
          "marksman:tactics": 40,
          "craftsman:assembly": 60,
          "craftsman:experimentation": 20,
        },
        skillPointCap: profileSkillPointCap,
        activeTitleId: profileTitle.id,
        credits: profileCredits,
        vitals: profileVitals,
      });
      expect(submittedActors[1]).toMatchObject({
        professionIds: profileProfessionIds,
        skillBoxIds: profileSkillBoxIds,
        professionXp: { marksman: 240, craftsman: 80 },
        professionTrackXp: {
          "marksman:rifle": 200,
          "marksman:tactics": 40,
          "craftsman:assembly": 60,
          "craftsman:experimentation": 20,
        },
        skillPointCap: profileSkillPointCap,
        activeTitleId: profileTitle.id,
        credits: profileCredits,
        vitals: profileVitals,
        bareStart: true,
        returning: true,
      });
      expect(helloActor(reenterSocket, identity.actorId)).toMatchObject({
        x: 22,
        y: 23,
        link_dead: false,
        credits: profileCredits,
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(linkDeadCalls).toEqual([true]);
      const inventoryRows = (packets(reenterSocket).find((packet) => packet.type === "game.hello")?.snapshot?.inventory ?? []) as RustAuthorityInventorySnapshot[];
      const characterRows = inventoryRows.filter((row) => row.container.startsWith(`${identity.actorId}:`));
      expect(characterRows).toEqual(durableRows);
    } finally {
      shard.close();
    }
  });

  it("restores an offline placeholder owner with retained player inventory after the Rust actor timed out", async () => {
    const ownerId = "offline-placeholder-owner";
    const peerId = "offline-placeholder-peer";
    const claimedWorldEntries: string[] = [];
    const checkpointReasons: string[] = [];
    const durableRows: RustAuthorityInventorySnapshot[] = [
      { container: "player:field-pack", stackId: 301, item: "Creature Hide", itemId: 2101, variantId: 17, quantity: 13, reserved: 2, available: 11 },
      { container: "player:bank", stackId: 302, item: "Creature Bone", itemId: 2102, variantId: 19, quantity: 5, reserved: 0, available: 5 },
      { container: "player:field-pack", stackId: 303, item: "Creature Meat", itemId: 2103, variantId: 23, quantity: 4, reserved: 0, available: 4 },
    ];
    const durableIds = new Set([ownerId, peerId]);
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      characterPersistence: {
        hasCharacter: (characterId) => durableIds.has(characterId),
        claimWorldEntry: (characterId) => {
          claimedWorldEntries.push(characterId);
          return { returning: false };
        },
        saveSnapshot: () => undefined,
      },
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const stateHash = "a".repeat(64);
    const submittedActors: RustAuthorityActorUpsertInput[] = [];
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        pendingCount?: () => number;
        debugStatus?: () => unknown;
        importState?: () => Promise<RustAuthorityBridgeImportStateOutput>;
        submitActor?: (input: { actor: RustAuthorityActorUpsertInput }) => Promise<unknown>;
      };
      inventory: RustAuthorityInventorySnapshot[];
      authoredPlaceholderOwners: Map<string, string>;
      createCheckpoint: (rustState: unknown) => Record<string, unknown>;
      checkpointProjectionStateHash: (checkpoint: unknown) => string;
      restoreLiveRustAuthorityCheckpoint: (checkpoint: unknown, path: string) => Promise<void>;
      checkpoint: (reason?: string) => Promise<unknown>;
    };
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => undefined,
      pendingCount: () => 0,
      debugStatus: () => null,
      importState: async () => ({
        schema: "successor.rust-authority-bridge-import-state.v1",
        requestId: 1,
        tick: 71,
        targetStateHash: stateHash,
        actors: [],
        combatEvents: [],
        inventory: durableRows.map((row) => ({ ...row })),
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
        logoutActors: [],
        removedActorIds: [],
        metrics: rustTickOutput([], 71).metrics,
      } as RustAuthorityBridgeImportStateOutput),
      submitActor: async ({ actor }) => {
        submittedActors.push({ ...actor });
        return {
          tick: 71 + submittedActors.length,
          targetStateHash: `${stateHash}-${submittedActors.length}`,
          actor: rustActorSnapshot({
            id: actor.id,
            entity: actor.entity,
            label: actor.label ?? actor.id,
            role: actor.role ?? "player",
            areaId: actor.areaId,
            x: actor.x,
            y: actor.y,
            direction: actor.direction,
          }),
          inventory: durableRows.map((row) => ({ ...row })),
          reservations: [],
          timelineEvents: [],
          resourceSpawns: [],
          areaResourceSpawns: [],
          metrics: rustTickOutput([], 71 + submittedActors.length).metrics,
        };
      },
    };
    internals.checkpoint = async (reason = "manual") => {
      checkpointReasons.push(reason);
      return {};
    };
    const checkpoint = internals.createCheckpoint({
      schema: "authority.checkpoint-state.v1",
      version: 1,
      tick: 71,
      stateHash,
      state: { schema: "successor.authority-state.v1", version: 1, stateHash },
    });
    checkpoint.authoredPlaceholderOwners = { player: ownerId };
    checkpoint.projectionStateHash = internals.checkpointProjectionStateHash(checkpoint);

    try {
      await internals.restoreLiveRustAuthorityCheckpoint(checkpoint, path.join("tmp", "offline-placeholder.checkpoint.json"));
      expect(internals.authoredPlaceholderOwners.get("player")).toBe(ownerId);
      expect(internals.inventory).toEqual(durableRows);

      const peerSocket = controlledSocket();
      shard.connect(peerSocket, { ...testCharacterIdentity(peerId), returningCharacter: true });
      await waitFor(() => peerSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      const peerInventory = (packets(peerSocket).find((packet) => packet.type === "game.hello")?.snapshot?.inventory ?? []) as RustAuthorityInventorySnapshot[];
      expect(peerInventory.filter((row) => durableRows.some((durable) => durable.itemId === row.itemId))).toEqual([]);
      expect(internals.authoredPlaceholderOwners.get("player")).toBe(ownerId);

      const ownerSocket = controlledSocket();
      // Simulate a previous CharacterStore marker write failing after the
      // authoritative alias and inventory were already durably published.
      shard.connect(ownerSocket, { ...testCharacterIdentity(ownerId), returningCharacter: false });
      await waitFor(() => ownerSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(submittedActors).toEqual([
        expect.objectContaining({ id: peerId, entity: peerId, bareStart: true, returning: true }),
        expect.objectContaining({ id: "player", entity: ownerId, bareStart: true, returning: true }),
      ]);
      const ownerInventory = (packets(ownerSocket).find((packet) => packet.type === "game.hello")?.snapshot?.inventory ?? []) as RustAuthorityInventorySnapshot[];
      expect(ownerInventory).toEqual(durableRows.map((row) => ({
        ...row,
        container: row.container.replace(/^player:/u, `${ownerId}:`),
      })));
      expect(internals.authoredPlaceholderOwners.get("player")).toBe(ownerId);
      expect(checkpointReasons).toEqual(["character-first-entry"]);
      expect(claimedWorldEntries).toEqual([ownerId]);
    } finally {
      await shard.close();
    }
  });

  it("treats direct actor inventory as returning authority state while retrying its first-entry marker", async () => {
    const characterId = "direct-inventory-owner";
    const claimedWorldEntries: string[] = [];
    const checkpointReasons: string[] = [];
    const durableRows: RustAuthorityInventorySnapshot[] = [
      { container: `${characterId}:field-pack`, stackId: 401, item: "Creature Hide", itemId: 2101, variantId: 29, quantity: 8, reserved: 1, available: 7 },
      { container: `${characterId}:bank`, stackId: 402, item: "Creature Bone", itemId: 2102, variantId: 31, quantity: 6, reserved: 0, available: 6 },
      { container: `${characterId}:field-pack`, stackId: 403, item: "Creature Meat", itemId: 2103, variantId: 37, quantity: 3, reserved: 0, available: 3 },
    ];
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      characterPersistence: {
        hasCharacter: (candidate) => candidate === characterId || candidate === "other-placeholder-owner",
        claimWorldEntry: (candidate) => {
          claimedWorldEntries.push(candidate);
          return { returning: false };
        },
        saveSnapshot: () => undefined,
      },
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const submittedActors: RustAuthorityActorUpsertInput[] = [];
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        debugStatus?: () => unknown;
        submitActor?: (input: { actor: RustAuthorityActorUpsertInput }) => Promise<unknown>;
      };
      inventory: RustAuthorityInventorySnapshot[];
      authoredPlaceholderOwners: Map<string, string>;
      checkpoint: (reason?: string) => Promise<unknown>;
    };
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => undefined,
      debugStatus: () => null,
      submitActor: async ({ actor }) => {
        submittedActors.push({ ...actor });
        return {
          tick: 81,
          targetStateHash: "direct-inventory-owner-upsert",
          actor: rustActorSnapshot({
            id: actor.id,
            entity: actor.entity,
            label: actor.label ?? actor.id,
            role: actor.role ?? "player",
            areaId: actor.areaId,
            x: actor.x,
            y: actor.y,
            direction: actor.direction,
          }),
          inventory: durableRows.map((row) => ({ ...row })),
          reservations: [],
          timelineEvents: [],
          resourceSpawns: [],
          areaResourceSpawns: [],
          metrics: rustTickOutput([], 81).metrics,
        };
      },
    };
    // Keep the authored player alias unavailable so this character exercises
    // the direct actor-id namespace rather than the `player` compatibility id.
    internals.authoredPlaceholderOwners.set("player", "other-placeholder-owner");
    internals.inventory = durableRows.map((row) => ({ ...row }));
    internals.checkpoint = async (reason = "manual") => {
      checkpointReasons.push(reason);
      return {};
    };

    try {
      const socket = controlledSocket();
      shard.connect(socket, { ...testCharacterIdentity(characterId), returningCharacter: false });
      await waitFor(() => socket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(submittedActors).toEqual([
        expect.objectContaining({
          id: characterId,
          entity: characterId,
          bareStart: true,
          returning: true,
        }),
      ]);
      const inventory = (packets(socket).find((packet) => packet.type === "game.hello")?.snapshot?.inventory ?? []) as RustAuthorityInventorySnapshot[];
      expect(inventory).toEqual(durableRows);
      expect(checkpointReasons).toEqual(["character-first-entry"]);
      expect(claimedWorldEntries).toEqual([characterId]);
    } finally {
      await shard.close();
    }
  });

  it("waits for a post-overlap checkpoint before claiming a concurrent second first entry", async () => {
    const harness = firstEntryCheckpointHarness("first-entry-overlap-success");
    const firstCharacterId = "first-entry-overlap-a";
    const secondCharacterId = "first-entry-overlap-b";

    try {
      const firstSocket = controlledSocket();
      harness.shard.connect(firstSocket, {
        ...testCharacterIdentity(firstCharacterId),
        returningCharacter: false,
      });
      await waitFor(() => harness.exportRequests.length === 1);

      expect(harness.claimedCharacterIds).toEqual([]);
      expect(firstSocket.sent).toEqual([]);
      expect(harness.exportRequests[0]?.actorIds).toEqual(harness.submittedRustActorIds);

      const secondSocket = controlledSocket();
      harness.shard.connect(secondSocket, {
        ...testCharacterIdentity(secondCharacterId),
        returningCharacter: false,
      });
      await waitFor(() => harness.submittedRustActorIds.length === 2);
      await new Promise<void>((resolve) => setImmediate(resolve));

      // The second entrant must wait behind A's already-running export. It must
      // not claim against that older snapshot, which did not contain B.
      expect(harness.exportRequests).toHaveLength(1);
      expect(harness.claimedCharacterIds).toEqual([]);
      expect(secondSocket.sent).toEqual([]);

      harness.exportRequests[0]!.resolve();
      await waitFor(() => (
        harness.exportRequests.length === 2
        && harness.claimedCharacterIds.length === 1
        && firstSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello")
      ));

      expect(harness.claimedCharacterIds).toEqual([firstCharacterId]);
      expect(secondSocket.sent).toEqual([]);
      expect(harness.exportRequests[1]?.actorIds).toEqual(harness.submittedRustActorIds);

      harness.exportRequests[1]!.resolve();
      await waitFor(() => (
        harness.claimedCharacterIds.length === 2
        && secondSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello")
      ));

      expect(harness.claimedCharacterIds).toEqual([firstCharacterId, secondCharacterId]);
      expect(harness.shard.status().persistence.checkpointWriteCount).toBe(2);
      const persisted = JSON.parse(fs.readFileSync(harness.checkpointPath, "utf8")) as {
        rustAuthority?: { state?: { actorIds?: string[] } };
      };
      expect(persisted.rustAuthority?.state?.actorIds).toEqual(harness.submittedRustActorIds);
    } finally {
      await harness.cleanup();
    }
  });

  it("does not claim a concurrent second first entry when its post-overlap checkpoint fails", async () => {
    const harness = firstEntryCheckpointHarness("first-entry-overlap-failure");
    const firstCharacterId = "first-entry-failure-a";
    const secondCharacterId = "first-entry-failure-b";

    try {
      const firstSocket = controlledSocket();
      harness.shard.connect(firstSocket, {
        ...testCharacterIdentity(firstCharacterId),
        returningCharacter: false,
      });
      await waitFor(() => harness.exportRequests.length === 1);

      const secondSocket = controlledSocket();
      harness.shard.connect(secondSocket, {
        ...testCharacterIdentity(secondCharacterId),
        returningCharacter: false,
      });
      await waitFor(() => harness.submittedRustActorIds.length === 2);

      harness.exportRequests[0]!.resolve();
      await waitFor(() => (
        harness.exportRequests.length === 2
        && harness.claimedCharacterIds.length === 1
        && firstSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello")
      ));

      harness.exportRequests[1]!.reject(new Error("second first-entry export failed for test"));
      await waitFor(() => secondSocket.closed.length > 0);

      expect(harness.claimedCharacterIds).toEqual([firstCharacterId]);
      expect(secondSocket.sent).toEqual([]);
      expect(secondSocket.closed).toContainEqual({ code: 1011, reason: "durable character entry failed" });
      expect(harness.shard.status().persistence.checkpointWriteCount).toBe(1);
      const persisted = JSON.parse(fs.readFileSync(harness.checkpointPath, "utf8")) as {
        rustAuthority?: { state?: { actorIds?: string[] } };
      };
      expect(persisted.rustAuthority?.state?.actorIds).toEqual(harness.exportRequests[0]?.actorIds);
      expect(persisted.rustAuthority?.state?.actorIds).not.toEqual(harness.submittedRustActorIds);
    } finally {
      await harness.cleanup();
    }
  });

  it("reattaches a link-dead character from restored Rust authority registration when TS actor map lacks player actor", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });

    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: { actor: RustAuthorityActorUpsertInput }) => Promise<unknown>;
        setActorLinkDead?: (input: { actorId: string; linkDead: boolean }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
      rustAuthorityRegisteredActorIds: Set<string>;
      rustAuthorityLinkDeadActorIds: Set<string>;
      actors: Map<string, unknown>;
      rustActorIdFor(actorId: string): string;
    };

    const identity = testCharacterIdentity("restored-ld-char");
    const actorId = identity.actorId;
    const rustActorId = internals.rustActorIdFor(actorId);

    // Mock that the actor is registered in Rust authority (as if restored from checkpoint)
    internals.rustAuthorityRegisteredActorIds.add(rustActorId);
    internals.rustAuthorityLinkDeadActorIds.add(rustActorId);

    // Ensure TS actors map doesn't contain the player actor (simulates missing from TS map post-restore)
    internals.actors.delete(actorId);
    // Also delete "player" placeholder to avoid claiming it in this test case
    internals.actors.delete("player");
    expect(internals.actors.has(actorId)).toBe(false);

    const submitActorCalls: string[] = [];
    const linkDeadCalls: Array<{ actorId: string; linkDead: boolean }> = [];

    const restoredInventory: RustAuthorityInventorySnapshot[] = [
      { container: `${rustActorId}:field-pack`, stackId: 1, item: "Petrochemical", itemId: 2004, variantId: 0, quantity: 5, reserved: 0, available: 5 }
    ];

    const restoredProfessions: RustAuthorityProfessionSnapshot[] = [
      { id: "scout", label: "Scout", xp: 500, skillPoints: 5, skillBoxes: ["scout_basic"] }
    ];

    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async ({ actor }) => {
        submitActorCalls.push(actor.id);
        return {
          tick: 11,
          actor: rustActorSnapshot({ id: actor.id }),
          inventory: [],
          reservations: [],
          timelineEvents: [],
        };
      },
      setActorLinkDead: async ({ actorId, linkDead }) => {
        linkDeadCalls.push({ actorId, linkDead });
        return {
          tick: 12,
          actor: rustActorSnapshot({
            id: actorId,
            label: "Restored LD Hero",
            link_dead: linkDead,
            role: "player",
            areaId: "authority-test-overworld",
            x: 24,
            y: 25,
            direction: "left",
            weapon: rustWeaponSnapshot("slugthrower", 1003),
            professions: restoredProfessions,
          }),
          inventory: restoredInventory,
          reservations: [],
          timelineEvents: [],
        };
      },
    };

    try {
      const socket = controlledSocket();
      shard.connect(socket, {
        ...identity,
        spawn: { areaId: "authority-test-overworld", x: 99, y: 99, facing: "right" },
      });

      await waitFor(() => socket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));

      expect(linkDeadCalls).toEqual([{ actorId: rustActorId, linkDead: false }]);
      expect(submitActorCalls).toEqual([]);

      const parsedHello = JSON.parse(socket.sent.find((packet) => JSON.parse(packet).type === "game.hello")!) as {
        snapshot: {
          actors: Record<string, GameActorSnapshot>;
          inventory: RustAuthorityInventorySnapshot[];
        };
      };
      const playerActor = parsedHello.snapshot.actors[actorId];
      expect(playerActor).toBeDefined();
      if (!playerActor) throw new Error("playerActor not found in hello snapshot");
      expect(playerActor.x).toBe(24);
      expect(playerActor.y).toBe(25);
      expect(playerActor.direction).toBe("left");
      expect(playerActor.professions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "scout", xp: 500 })
      ]));
      expect(playerActor.weapon).toMatchObject({ weaponId: "slugthrower", weaponItemId: 1003 });

      const playerRows = parsedHello.snapshot.inventory.filter((row) => row.container.startsWith(`${actorId}:`));
      expect(playerRows).toEqual(expect.arrayContaining([
        expect.objectContaining({ itemId: 2004, quantity: 5 })
      ]));

      // Assert restored registration is not invalidated (since actorWasCreated is true, but reattachingLinkDead gates it)
      expect(internals.rustAuthorityRegisteredActorIds.has(rustActorId)).toBe(true);
    } finally {
      shard.close();
    }
  });

  it("replaces a registered link-dead authored placeholder owned by a different character", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });

    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: { actor: RustAuthorityActorUpsertInput }) => Promise<unknown>;
        setActorLinkDead?: (input: { actorId: string; linkDead: boolean }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
      rustAuthorityRegisteredActorIds: Set<string>;
      rustAuthorityLinkDeadActorIds: Set<string>;
      actors: Map<string, unknown>;
    };
    const identity = {
      ...testCharacterIdentity("new-character-over-stale-player"),
      appearance: {
        skin: "#624027",
        hair: "hair_spiked_topknot",
        hair_mat: "hair_rust",
      },
      worn: [{
        item: "top_reinforced_crop_vest",
        colors: ["#908070", "#303030", "#606060"],
      }],
    };
    const submittedActors: RustAuthorityActorUpsertInput[] = [];
    const linkDeadCalls: Array<{ actorId: string; linkDead: boolean }> = [];

    internals.rustAuthorityRegisteredActorIds.add("player");
    internals.rustAuthorityLinkDeadActorIds.add("player");
    expect(internals.actors.has("player")).toBe(true);

    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async ({ actor }) => {
        submittedActors.push(actor);
        return {
          tick: 11,
          actor: rustActorSnapshot({
            id: actor.id,
            label: actor.label,
            link_dead: false,
            role: "player",
            areaId: actor.areaId,
            x: actor.x,
            y: actor.y,
            direction: actor.direction,
          }),
          inventory: [],
          reservations: [],
          timelineEvents: [],
        };
      },
      setActorLinkDead: async ({ actorId, linkDead }) => {
        linkDeadCalls.push({ actorId, linkDead });
        return {
          tick: 12,
          actor: rustActorSnapshot({ id: actorId, link_dead: linkDead }),
          inventory: [],
          reservations: [],
          timelineEvents: [],
        };
      },
    };

    try {
      const socket = controlledSocket();
      shard.connect(socket, identity);
      await waitFor(() => socket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));

      expect(linkDeadCalls).toEqual([]);
      expect(submittedActors).toHaveLength(1);
      expect(submittedActors[0]).toMatchObject({
        id: "player",
        label: identity.displayName,
        bareStart: true,
        appearance: identity.appearance,
        worn: identity.worn,
      });
    } finally {
      shard.close();
    }
  });
  it("forces one bare-start upsert for a fresh authored placeholder claim but not returning reconnect", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: { actor: RustAuthorityActorUpsertInput }) => Promise<unknown>;
        setActorLinkDead?: (input: { actorId: string; linkDead: boolean }) => Promise<unknown>;
      };
      rustAuthorityRegisteredActorIds: Set<string>;
      actors: Map<string, { worn?: unknown; wornColors?: unknown }>;
    };
    const fixedWorn = [
      { item: "under_bodysuit", colors: ["#89cff0"] },
      { item: "boots_canvas_ankle", colors: ["#303030", "#808080"] },
    ];
    const fixedWornColors = {
      under_bodysuit: ["#89cff0"],
      boots_canvas_ankle: ["#303030", "#808080"],
    };
    const identity: GameSessionIdentity = {
      ...testCharacterIdentity("fresh-authored-claim"),
      displayName: "Fresh Authored Claim",
      appearance: {
        skin: "#624027",
        hair: "hair_spiked_topknot",
        hair_mat: "hair_rust",
      },
      worn: fixedWorn,
      wornColors: {},
      returningCharacter: false,
    };
    const submittedActors: RustAuthorityActorUpsertInput[] = [];
    const linkDeadCalls: Array<{ actorId: string; linkDead: boolean }> = [];
    const fixedInventory = [
      {
        container: "fresh-authored-claim:field-pack",
        stackId: 1,
        item: "under_bodysuit",
        itemId: 9_900_001,
        variantId: 0,
        quantity: 1,
        reserved: 0,
        equipped: true,
        colors: ["#89cff0"],
        available: 1,
      },
      {
        container: "fresh-authored-claim:field-pack",
        stackId: 2,
        item: "boots_canvas_ankle",
        itemId: 7_319,
        variantId: 0,
        quantity: 1,
        reserved: 0,
        equipped: true,
        colors: ["#303030", "#808080"],
        available: 1,
      },
    ];
    internals.rustAuthorityRegisteredActorIds.add("player");
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      submitActor: async ({ actor }) => {
        submittedActors.push(actor);
        return {
          tick: submittedActors.length,
          actor: rustActorSnapshot({
            id: actor.id,
            entity: actor.entity,
            label: actor.label,
            role: "player",
            worn: fixedWorn,
          }),
          inventory: fixedInventory,
          reservations: [],
          timelineEvents: [],
        };
      },
      setActorLinkDead: async ({ actorId, linkDead }) => {
        linkDeadCalls.push({ actorId, linkDead });
        return {
          tick: 2,
          actor: rustActorSnapshot({
            id: actorId,
            entity: "fresh-authored-claim",
            label: "Fresh Authored Claim",
            role: "player",
            link_dead: linkDead,
            worn: fixedWorn,
          }),
          inventory: fixedInventory,
          reservations: [],
          timelineEvents: [],
        };
      },
    };
    try {
      const firstSocket = controlledSocket();
      shard.connect(firstSocket, identity);
      await waitFor(() => firstSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(submittedActors).toHaveLength(1);
      expect(submittedActors[0]).toMatchObject({
        id: "player",
        bareStart: true,
        returning: false,
        worn: identity.worn,
      });
      expect(internals.actors.get("fresh-authored-claim")).toMatchObject({
        worn: fixedWorn,
        wornColors: fixedWornColors,
      });

      const returningSocket = controlledSocket();
      const staleReturningIdentity: GameSessionIdentity = {
        ...identity,
        returningCharacter: true,
        worn: [{ item: "top_reinforced_crop_vest", colors: ["#ff00ff"] }],
        wornColors: { top_reinforced_crop_vest: ["#ff00ff"] },
      };
      shard.connect(returningSocket, staleReturningIdentity);
      await waitFor(() => returningSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(submittedActors).toHaveLength(1);
      expect(linkDeadCalls).toEqual([{ actorId: "player", linkDead: false }]);
      expect(internals.actors.get("fresh-authored-claim")).toMatchObject({
        worn: fixedWorn,
        wornColors: fixedWornColors,
      });
      expect(helloActor(returningSocket, "fresh-authored-claim")).toMatchObject({
        worn: fixedWorn,
        wornColors: fixedWornColors,
      });
      const returningRows = (packets(returningSocket).find((packet) => packet.type === "game.hello")?.snapshot?.inventory ?? []) as RustAuthorityInventorySnapshot[];
      expect(returningRows).toEqual(expect.arrayContaining(fixedInventory.map((row) => expect.objectContaining(row))));
    } finally {
      shard.close();
    }
  });


  it("preserves unequipped wornColors keys across worn-only Rust snapshots and reentry", async () => {
    const saves: Array<{ characterId: string; snapshot: GameActorSnapshot }> = [];
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      characterPersistence: {
        hasCharacter: (candidate) => candidate === "char-unequipped-palette",
        saveSnapshot: (characterId, snapshot) => {
          saves.push({ characterId, snapshot });
        },
      },
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const characterId = "char-unequipped-palette";
    const equippedWorn = [
      { item: "under_bodysuit", colors: ["#89cff0"] },
      { item: "boots_canvas_ankle", colors: ["#303030", "#808080"] },
    ];
    const durableWornColors = {
      under_bodysuit: ["#89cff0"],
      boots_canvas_ankle: ["#303030", "#808080"],
      top_reinforced_crop_vest: ["#ff00ff"],
    };
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: { actor: RustAuthorityActorUpsertInput }) => Promise<unknown>;
        setActorLinkDead?: (input: { actorId: string; linkDead: boolean }) => Promise<unknown>;
      };
      actors: Map<string, {
        worn?: Array<{ item: string; colors: string[] }>;
        wornColors: Record<string, string[]>;
        linkDead: boolean;
      }>;
      applyRustActorSnapshot: (actorId: string, snapshot: RustAuthorityActorSnapshot) => void;
      saveCharacterSnapshot: (
        characterId: string,
        actor: { worn?: unknown; wornColors?: unknown },
        options: { reason: string; atMs: number },
      ) => void;
    };
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      submitActor: async ({ actor }) => ({
        tick: 11,
        actor: rustActorSnapshot({
          id: actor.id,
          entity: characterId,
          label: actor.label ?? characterId,
          role: "player",
          worn: equippedWorn,
        }),
        inventory: [],
        reservations: [],
        timelineEvents: [],
      }),
      setActorLinkDead: async ({ actorId, linkDead }) => ({
        tick: linkDead ? 12 : 13,
        actor: rustActorSnapshot({
          id: actorId,
          entity: characterId,
          label: "Unequipped Palette",
          role: "player",
          link_dead: linkDead,
          worn: [
            { item: "under_bodysuit", colors: ["#89cff0"] },
            { item: "boots_canvas_ankle", colors: ["#404040", "#909090"] },
          ],
        }),
        inventory: [],
        reservations: [],
        timelineEvents: [],
      }),
    };
    try {
      const firstSocket = controlledSocket();
      shard.connect(firstSocket, {
        ...testCharacterIdentity(characterId),
        returningCharacter: false,
        worn: equippedWorn,
        wornColors: durableWornColors,
      });
      await waitFor(() => firstSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      const actor = internals.actors.get(characterId);
      expect(actor).toBeDefined();
      actor!.wornColors = { ...durableWornColors };
      actor!.worn = equippedWorn.map((piece) => ({ item: piece.item, colors: [...piece.colors] }));

      // Worn-only live snapshot must upsert equipped palette without dropping unequipped keys.
      internals.applyRustActorSnapshot(characterId, rustActorSnapshot({
        id: "player",
        entity: characterId,
        label: "Unequipped Palette",
        role: "player",
        worn: [
          { item: "under_bodysuit", colors: ["#89cff0"] },
          { item: "boots_canvas_ankle", colors: ["#404040", "#909090"] },
        ],
      }));
      expect(internals.actors.get(characterId)?.wornColors).toEqual({
        under_bodysuit: ["#89cff0"],
        boots_canvas_ankle: ["#404040", "#909090"],
        top_reinforced_crop_vest: ["#ff00ff"],
      });

      internals.saveCharacterSnapshot(characterId, internals.actors.get(characterId)!, {
        reason: "checkpoint",
        atMs: Date.now(),
      });
      expect(saves.at(-1)?.snapshot.wornColors).toEqual({
        under_bodysuit: ["#89cff0"],
        boots_canvas_ankle: ["#404040", "#909090"],
        top_reinforced_crop_vest: ["#ff00ff"],
      });

      firstSocket.emitClose();
      const reentrySocket = controlledSocket();
      shard.connect(reentrySocket, {
        ...testCharacterIdentity(characterId),
        returningCharacter: true,
        worn: [{ item: "top_reinforced_crop_vest", colors: ["#111111"] }],
        wornColors: { top_reinforced_crop_vest: ["#111111"] },
      });
      await waitFor(() => reentrySocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(helloActor(reentrySocket, characterId)).toMatchObject({
        worn: [
          { item: "under_bodysuit", colors: ["#89cff0"] },
          { item: "boots_canvas_ankle", colors: ["#404040", "#909090"] },
        ],
        wornColors: {
          under_bodysuit: ["#89cff0"],
          boots_canvas_ankle: ["#404040", "#909090"],
          top_reinforced_crop_vest: ["#ff00ff"],
        },
      });
      expect(internals.actors.get(characterId)?.wornColors).toEqual({
        under_bodysuit: ["#89cff0"],
        boots_canvas_ankle: ["#404040", "#909090"],
        top_reinforced_crop_vest: ["#ff00ff"],
      });
    } finally {
      shard.close();
    }
  });


  it("retains skillPointsUsed/Cap across partial link-dead Rust snapshots and accepts explicit zero", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    const characterId = "char-skill-omit";
    try {
      shard.connect(controlledSocket(), testCharacterIdentity(characterId));
      const internals = shard as unknown as {
        actors: Map<string, {
          skillPointsUsed?: number;
          skillPointsCap?: number;
        }>;
        applyRustActorSnapshot: (actorId: string, snapshot: RustAuthorityActorSnapshot) => void;
      };
      const actor = internals.actors.get(characterId);
      expect(actor).toBeDefined();
      actor!.skillPointsUsed = 16;
      actor!.skillPointsCap = 250;

      // Partial/link-dead style snapshot: omit both skill fields entirely.
      const partial = rustActorSnapshot({
        id: characterId,
        entity: characterId,
        role: "player",
        label: "Skill Omit",
        worn: [{ item: "under_bodysuit", colors: ["#89cff0"] }],
      }) as RustAuthorityActorSnapshot & {
        skillPointsUsed?: number;
        skillPointsCap?: number;
      };
      delete partial.skillPointsUsed;
      delete partial.skillPointsCap;
      internals.applyRustActorSnapshot(characterId, partial);
      expect(internals.actors.get(characterId)?.skillPointsUsed).toBe(16);
      expect(internals.actors.get(characterId)?.skillPointsCap).toBe(250);

      // Explicit numeric 0 is a real replacement, not an omit.
      internals.applyRustActorSnapshot(characterId, rustActorSnapshot({
        id: characterId,
        entity: characterId,
        role: "player",
        label: "Skill Zero",
        skillPointsUsed: 0,
        skillPointsCap: 0,
      }));
      expect(internals.actors.get(characterId)?.skillPointsUsed).toBe(0);
      expect(internals.actors.get(characterId)?.skillPointsCap).toBe(0);
    } finally {
      shard.close();
    }
  });

  it("does not infer worn clothing from inventory rows without equipment metadata", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    const actorId = "authority-clothing-projection";
    try {
      shard.connect(controlledSocket(), testCharacterIdentity(actorId));
      const internals = shard as unknown as {
        syncRustClothingProjection: (rows: readonly RustAuthorityInventorySnapshot[]) => void;
        actors: Map<string, { worn?: Array<{ item: string; colors: string[] }>; wornColors: Record<string, string[]> }>;
      };
      const authoritativeWorn = [{ item: "under_bodysuit", colors: ["#89cff0"] }];
      const actor = internals.actors.get(actorId);
      expect(actor).toBeDefined();
      actor!.worn = authoritativeWorn;
      actor!.wornColors = { under_bodysuit: ["#89cff0"] };
      internals.syncRustClothingProjection([{
        container: `${actorId}:loot`,
        stackId: 1,
        item: "Marked Plate Vest",
        itemId: 7_101,
        variantId: 62_000_244,
        quantity: 1,
        reserved: 0,
        available: 1,
      }]);
      expect(actor!.worn).toEqual(authoritativeWorn);
      expect(actor!.wornColors).toEqual({ under_bodysuit: ["#89cff0"] });
    } finally {
      shard.close();
    }
  });

  it("applies Rust worn snapshots and dirties actor projections for equip changes", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const internals = shard as unknown as {
        actors: Map<string, { worn?: Array<{ item: string; colors: string[] }> }>;
        dirtyActorIds: Set<string>;
        highDetailDirtyActorIds: Set<string>;
        applyRustAuthorityTickOutput: (output: RustAuthorityBridgeTickOutput) => GameCombatEvent[];
      };
      const starterWorn = [
        { item: "under_bodysuit", colors: ["#89cff0"] },
        { item: "boots_canvas_ankle", colors: ["#303030", "#808080"] },
      ];
      const equippedWorn = [...starterWorn, { item: "top_reinforced_crop_vest", colors: ["#112233"] }];
      internals.actors.get("player")!.worn = starterWorn;
      internals.dirtyActorIds.clear();
      internals.highDetailDirtyActorIds.clear();
      internals.applyRustAuthorityTickOutput(rustTickOutput([rustActorSnapshot({ id: "player", worn: equippedWorn })], 41));
      expect(internals.actors.get("player")!.worn).toEqual(equippedWorn);
      expect(internals.dirtyActorIds.has("player")).toBe(true);
      expect(internals.highDetailDirtyActorIds.has("player")).toBe(true);
      internals.dirtyActorIds.clear();
      internals.highDetailDirtyActorIds.clear();
      internals.applyRustAuthorityTickOutput(rustTickOutput([rustActorSnapshot({ id: "player", worn: starterWorn })], 42));
      expect(internals.actors.get("player")!.worn).toEqual(starterWorn);
      expect(internals.dirtyActorIds.has("player")).toBe(true);
      expect(internals.highDetailDirtyActorIds.has("player")).toBe(true);
    } finally {
      shard.close();
    }
  });

  it("refreshes an already-registered returning placeholder before exposing clothing", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    type TestActor = {
      characterId?: string;
      worn?: unknown;
      wornColors: Record<string, string[]>;
      linkDead: boolean;
    };
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: { actor: RustAuthorityActorUpsertInput }) => Promise<unknown>;
        setActorLinkDead?: (input: { actorId: string; linkDead: boolean }) => Promise<unknown>;
      };
      rustAuthorityRegisteredActorIds: Set<string>;
      rustAuthorityLinkDeadActorIds: Set<string>;
      claimAuthoredPlayerPlaceholder: (actorId: string, ownerCharacterId?: string) => TestActor | null;
      actors: Map<string, TestActor>;
    };
    const characterId = "restored-authored-claim";
    const fixedWorn = [
      { item: "under_bodysuit", colors: ["#89cff0"] },
      { item: "boots_canvas_ankle", colors: ["#303030", "#808080"] },
    ];
    const fixedWornColors = {
      under_bodysuit: ["#89cff0"],
      boots_canvas_ankle: ["#303030", "#808080"],
    };
    const fixedInventory: RustAuthorityInventorySnapshot[] = [
      {
        container: "player:field-pack",
        stackId: 1,
        item: "under_bodysuit",
        itemId: 9_900_001,
        variantId: 0,
        quantity: 1,
        reserved: 0,
        equipped: true,
        colors: ["#89cff0"],
        available: 1,
      },
      {
        container: "player:field-pack",
        stackId: 2,
        item: "boots_canvas_ankle",
        itemId: 7_319,
        variantId: 0,
        quantity: 1,
        reserved: 0,
        equipped: true,
        colors: ["#303030", "#808080"],
        available: 1,
      },
    ];
    const restoredActor = internals.claimAuthoredPlayerPlaceholder(characterId, characterId);
    if (!restoredActor) throw new Error("expected authored player placeholder");
    restoredActor.characterId = characterId;
    restoredActor.linkDead = false;
    restoredActor.worn = [{ item: "top_reinforced_crop_vest", colors: ["#ff00ff"] }];
    restoredActor.wornColors = { top_reinforced_crop_vest: ["#ff00ff"] };
    internals.rustAuthorityRegisteredActorIds.add("player");
    internals.rustAuthorityLinkDeadActorIds.delete("player");

    const submitActorCalls: RustAuthorityActorUpsertInput[] = [];
    const linkDeadCalls: Array<{ actorId: string; linkDead: boolean }> = [];
    let resolveRefresh!: (output: RustAuthorityBridgeActorOutput) => void;
    const refresh = new Promise<RustAuthorityBridgeActorOutput>((resolve) => {
      resolveRefresh = resolve;
    });
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      submitActor: async ({ actor }) => {
        submitActorCalls.push(actor);
        return {};
      },
      setActorLinkDead: async ({ actorId, linkDead }) => {
        linkDeadCalls.push({ actorId, linkDead });
        return refresh;
      },
    };

    try {
      const socket = controlledSocket();
      shard.connect(socket, {
        ...testCharacterIdentity(characterId),
        returningCharacter: true,
        worn: [{ item: "top_reinforced_crop_vest", colors: ["#ff00ff"] }],
        wornColors: { top_reinforced_crop_vest: ["#ff00ff"] },
      });

      expect(linkDeadCalls).toEqual([{ actorId: "player", linkDead: false }]);
      expect(socket.sent).toEqual([]);
      resolveRefresh({
        tick: 12,
        actor: rustActorSnapshot({
          id: "player",
          entity: characterId,
          label: "Restored Authored Claim",
          role: "player",
          link_dead: false,
          worn: fixedWorn,
        }),
        inventory: fixedInventory,
        reservations: [],
        timelineEvents: [],
      });
      await waitFor(() => socket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));

      expect(submitActorCalls).toEqual([]);
      expect(internals.actors.get(characterId)).toMatchObject({
        worn: fixedWorn,
        wornColors: {
          ...fixedWornColors,
          top_reinforced_crop_vest: ["#ff00ff"],
        },
      });
      const actor = helloActor(socket, characterId);
      expect(actor).toBeDefined();
      if (!actor) throw new Error("returning actor missing from game.hello");
      expect(actor.worn).toEqual(fixedWorn);
      expect(actor.wornColors).toEqual({
        ...fixedWornColors,
        top_reinforced_crop_vest: ["#ff00ff"],
      });
      const rows = (packets(socket).find((packet) => packet.type === "game.hello")?.snapshot?.inventory ?? []) as RustAuthorityInventorySnapshot[];
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => ({
        itemId: row.itemId,
        quantity: row.quantity,
        available: row.available,
        equipped: row.equipped,
        colors: row.colors,
      }))).toEqual([
        { itemId: 9_900_001, quantity: 1, available: 1, equipped: true, colors: ["#89cff0"] },
        { itemId: 7_319, quantity: 1, available: 1, equipped: true, colors: ["#303030", "#808080"] },
      ]);
    } finally {
      shard.close();
    }
  });

  it("applies disconnect intent after the first Rust upsert finishes", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor: (input: { actor: RustAuthorityActorUpsertInput }) => Promise<RustAuthorityBridgeActorOutput>;
        setActorLinkDead: (input: { actorId: string; linkDead: boolean }) => Promise<RustAuthorityBridgeActorOutput>;
      };
      rustAuthorityDesiredLinkDead: Map<string, boolean>;
    };
    const submittedActors: RustAuthorityActorUpsertInput[] = [];
    const linkDeadCalls: Array<{ actorId: string; linkDead: boolean }> = [];
    let resolveUpsert!: (output: RustAuthorityBridgeActorOutput) => void;
    const pendingUpsert = new Promise<RustAuthorityBridgeActorOutput>((resolve) => {
      resolveUpsert = resolve;
    });
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      submitActor: async ({ actor }) => {
        submittedActors.push(actor);
        return pendingUpsert;
      },
      setActorLinkDead: async ({ actorId, linkDead }) => {
        linkDeadCalls.push({ actorId, linkDead });
        return {
          tick: 2,
          actor: rustActorSnapshot({
            id: actorId,
            entity: "pending-disconnect",
            label: "Pending Disconnect",
            role: "player",
            link_dead: linkDead,
          }),
          inventory: [],
          reservations: [],
          timelineEvents: [],
        };
      },
    };
    try {
      const socket = controlledSocket();
      shard.connect(socket, testCharacterIdentity("pending-disconnect"));
      await waitFor(() => submittedActors.length === 1);
      const rustActorId = submittedActors[0]!.id;
      socket.emitClose();
      expect(internals.rustAuthorityDesiredLinkDead.get(rustActorId)).toBe(true);
      expect(linkDeadCalls).toEqual([]);

      resolveUpsert({
        tick: 1,
        actor: rustActorSnapshot({
          id: rustActorId,
          entity: "pending-disconnect",
          label: "Pending Disconnect",
          role: "player",
        }),
        inventory: [],
        reservations: [],
        timelineEvents: [],
      });
      await waitFor(() => linkDeadCalls.length === 1);
      expect(linkDeadCalls).toEqual([{ actorId: rustActorId, linkDead: true }]);
    } finally {
      shard.close();
    }
  });

  it("lets reconnect cancel disconnect intent while the first Rust upsert is pending", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor: (input: { actor: RustAuthorityActorUpsertInput }) => Promise<RustAuthorityBridgeActorOutput>;
        setActorLinkDead: (input: { actorId: string; linkDead: boolean }) => Promise<RustAuthorityBridgeActorOutput>;
      };
      rustAuthorityDesiredLinkDead: Map<string, boolean>;
    };
    const submittedActors: RustAuthorityActorUpsertInput[] = [];
    const linkDeadCalls: Array<{ actorId: string; linkDead: boolean }> = [];
    let resolveUpsert!: (output: RustAuthorityBridgeActorOutput) => void;
    const pendingUpsert = new Promise<RustAuthorityBridgeActorOutput>((resolve) => {
      resolveUpsert = resolve;
    });
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      submitActor: async ({ actor }) => {
        submittedActors.push(actor);
        return pendingUpsert;
      },
      setActorLinkDead: async ({ actorId, linkDead }) => {
        linkDeadCalls.push({ actorId, linkDead });
        return {
          tick: 2,
          actor: rustActorSnapshot({
            id: actorId,
            entity: "pending-reconnect",
            label: "Pending Reconnect",
            role: "player",
            link_dead: linkDead,
          }),
          inventory: [],
          reservations: [],
          timelineEvents: [],
        };
      },
    };
    try {
      const firstSocket = controlledSocket();
      const identity = testCharacterIdentity("pending-reconnect");
      shard.connect(firstSocket, identity);
      await waitFor(() => submittedActors.length === 1);
      const rustActorId = submittedActors[0]!.id;
      firstSocket.emitClose();
      expect(internals.rustAuthorityDesiredLinkDead.get(rustActorId)).toBe(true);

      const returningSocket = controlledSocket();
      shard.connect(returningSocket, { ...identity, returningCharacter: true });
      expect(internals.rustAuthorityDesiredLinkDead.get(rustActorId)).toBe(false);
      resolveUpsert({
        tick: 1,
        actor: rustActorSnapshot({
          id: rustActorId,
          entity: identity.characterId,
          label: identity.displayName,
          role: "player",
        }),
        inventory: [],
        reservations: [],
        timelineEvents: [],
      });
      await waitFor(() => returningSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(submittedActors).toHaveLength(1);
      expect(linkDeadCalls).toEqual([{ actorId: rustActorId, linkDead: false }]);
    } finally {
      shard.close();
    }
  });

  it("does not apply a stale late link-dead snapshot after reconnect", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor: (input: { actor: RustAuthorityActorUpsertInput }) => Promise<RustAuthorityBridgeActorOutput>;
        setActorLinkDead: (input: { actorId: string; linkDead: boolean }) => Promise<RustAuthorityBridgeActorOutput>;
      };
      actors: Map<string, { linkDead: boolean }>;
    };
    const linkDeadCalls: Array<{ actorId: string; linkDead: boolean }> = [];
    let resolveDisconnect!: (output: RustAuthorityBridgeActorOutput) => void;
    let resolveReconnect!: (output: RustAuthorityBridgeActorOutput) => void;
    const pendingDisconnect = new Promise<RustAuthorityBridgeActorOutput>((resolve) => {
      resolveDisconnect = resolve;
    });
    const pendingReconnect = new Promise<RustAuthorityBridgeActorOutput>((resolve) => {
      resolveReconnect = resolve;
    });
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      submitActor: async ({ actor }) => ({
        tick: 1,
        actor: rustActorSnapshot({
          id: actor.id,
          entity: actor.entity,
          label: actor.label,
          role: "player",
        }),
        inventory: [],
        reservations: [],
        timelineEvents: [],
      }),
      setActorLinkDead: async ({ actorId, linkDead }) => {
        linkDeadCalls.push({ actorId, linkDead });
        return linkDead ? pendingDisconnect : pendingReconnect;
      },
    };
    try {
      const identity = testCharacterIdentity("late-link-dead");
      const firstSocket = controlledSocket();
      shard.connect(firstSocket, identity);
      await waitFor(() => firstSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      firstSocket.emitClose();
      await waitFor(() => linkDeadCalls.length === 1);

      const returningSocket = controlledSocket();
      shard.connect(returningSocket, { ...identity, returningCharacter: true });
      expect(returningSocket.sent).toEqual([]);
      resolveDisconnect({
        tick: 2,
        actor: rustActorSnapshot({
          id: linkDeadCalls[0]!.actorId,
          entity: identity.characterId,
          label: identity.displayName,
          role: "player",
          link_dead: true,
        }),
        inventory: [],
        reservations: [],
        timelineEvents: [],
      });
      await waitFor(() => linkDeadCalls.length === 2);
      expect(linkDeadCalls).toEqual([
        { actorId: linkDeadCalls[0]!.actorId, linkDead: true },
        { actorId: linkDeadCalls[0]!.actorId, linkDead: false },
      ]);
      expect(internals.actors.get(identity.actorId)?.linkDead).toBe(false);

      resolveReconnect({
        tick: 3,
        actor: rustActorSnapshot({
          id: linkDeadCalls[0]!.actorId,
          entity: identity.characterId,
          label: identity.displayName,
          role: "player",
          link_dead: false,
        }),
        inventory: [],
        reservations: [],
        timelineEvents: [],
      });
      await waitFor(() => returningSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(internals.actors.get(identity.actorId)?.linkDead).toBe(false);
    } finally {
      shard.close();
    }
  });

  it("ignores link-dead output from a replaced Rust bridge generation", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        setActorLinkDead: (input: { actorId: string; linkDead: boolean }) => Promise<RustAuthorityBridgeActorOutput>;
      };
      rustAuthorityBridgeGeneration: number;
      rustAuthorityRegisteredActorIds: Set<string>;
      rustAuthorityLinkDeadActorIds: Set<string>;
      rustAuthorityDesiredLinkDead: Map<string, boolean>;
      lastRustAuthorityStateHash?: string;
      applyRustActorLinkDead: (rustActorId: string, actorId: string, linkDead: boolean) => Promise<void>;
    };
    const rustActorId = "replaced-bridge-actor";
    let resolveOldBridge!: (output: RustAuthorityBridgeActorOutput) => void;
    const oldBridgeOutput = new Promise<RustAuthorityBridgeActorOutput>((resolve) => {
      resolveOldBridge = resolve;
    });
    let oldBridgeCalls = 0;
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      setActorLinkDead: async () => {
        oldBridgeCalls += 1;
        return oldBridgeOutput;
      },
    };
    try {
      internals.rustAuthorityRegisteredActorIds.add(rustActorId);
      internals.rustAuthorityDesiredLinkDead.set(rustActorId, true);
      const pending = internals.applyRustActorLinkDead(rustActorId, rustActorId, true);
      await waitFor(() => oldBridgeCalls === 1);

      internals.rustAuthorityBridge = {
        close: () => {},
        setActorLinkDead: async () => {
          throw new Error("new bridge should not receive the old request");
        },
      };
      internals.rustAuthorityBridgeGeneration += 1;
      resolveOldBridge({
        tick: 999_999,
        targetStateHash: "stale-replaced-bridge-state",
        actor: rustActorSnapshot({
          id: rustActorId,
          entity: rustActorId,
          label: "Stale Replaced Bridge",
          role: "player",
          link_dead: true,
        }),
        inventory: [],
        reservations: [],
        timelineEvents: [],
      });
      await pending;

      expect(internals.lastRustAuthorityStateHash).not.toBe("stale-replaced-bridge-state");
      expect(internals.rustAuthorityLinkDeadActorIds.has(rustActorId)).toBe(false);
    } finally {
      shard.close();
    }
  });

  it("cancels a pending Rust upsert and clears lifecycle maps before actor removal", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor: (input: { actor: RustAuthorityActorUpsertInput }) => Promise<RustAuthorityBridgeActorOutput>;
        removeActor: (input: { actorId: string }) => Promise<RustAuthorityBridgeActorOutput>;
      };
      actors: Map<string, Record<string, unknown>>;
      queueRustAuthorityActorUpsert: (
        actor: Record<string, unknown>,
        rustActorId: string,
      ) => Promise<void>;
      removeRustAuthorityActor: (actorId: string) => Promise<void>;
      rustAuthorityActorUpserts: Map<string, Promise<void>>;
      rustAuthorityDesiredLinkDead: Map<string, boolean>;
      rustAuthorityLinkDeadEffects: Map<string, Promise<void>>;
      rustAuthorityRegisteredActorIds: Set<string>;
    };
    const actorId = "pending-removal";
    const sourceActor = internals.actors.get("player");
    if (!sourceActor) throw new Error("expected authored player actor");
    const actor = {
      ...sourceActor,
      id: actorId,
      entity: actorId,
      characterId: actorId,
      label: "Pending Removal",
      displayName: "Pending Removal",
      seenCommands: new Set<string>(),
    };
    internals.actors.set(actorId, actor);
    const submittedActors: RustAuthorityActorUpsertInput[] = [];
    const removeCalls: string[] = [];
    let resolveUpsert!: (output: RustAuthorityBridgeActorOutput) => void;
    const pendingUpsertOutput = new Promise<RustAuthorityBridgeActorOutput>((resolve) => {
      resolveUpsert = resolve;
    });
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      submitActor: async ({ actor: submittedActor }) => {
        submittedActors.push(submittedActor);
        return pendingUpsertOutput;
      },
      removeActor: async ({ actorId: removedActorId }) => {
        removeCalls.push(removedActorId);
        return { tick: 2 };
      },
    };
    try {
      const upsert = internals.queueRustAuthorityActorUpsert(actor, actorId);
      await waitFor(() => submittedActors.length === 1);
      internals.rustAuthorityDesiredLinkDead.set(actorId, true);
      const removal = internals.removeRustAuthorityActor(actorId);
      expect(internals.rustAuthorityActorUpserts.has(actorId)).toBe(false);
      expect(internals.rustAuthorityDesiredLinkDead.has(actorId)).toBe(false);
      expect(internals.rustAuthorityLinkDeadEffects.has(actorId)).toBe(false);
      expect(internals.rustAuthorityRegisteredActorIds.has(actorId)).toBe(false);
      expect(removeCalls).toEqual([]);

      resolveUpsert({
        tick: 1,
        actor: rustActorSnapshot({
          id: actorId,
          entity: actorId,
          label: "Pending Removal",
          role: "player",
        }),
        inventory: [],
        reservations: [],
        timelineEvents: [],
      });
      await Promise.all([upsert, removal]);
      expect(removeCalls).toEqual([actorId]);
      expect(internals.rustAuthorityRegisteredActorIds.has(actorId)).toBe(false);
    } finally {
      shard.close();
    }
  });

  it("registers a truly new character through normal upsert/register and does not treat it as reentry", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });

    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: { actor: RustAuthorityActorUpsertInput }) => Promise<unknown>;
        setActorLinkDead?: (input: { actorId: string; linkDead: boolean }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
      rustAuthorityRegisteredActorIds: Set<string>;
      actors: Map<string, unknown>;
      rustActorIdFor(actorId: string): string;
    };

    const identity = testCharacterIdentity("truly-new-char");
    const actorId = identity.actorId;
    const rustActorId = internals.rustActorIdFor(actorId);

    // Ensure it is NOT registered in Rust
    internals.rustAuthorityRegisteredActorIds.delete(rustActorId);
    // Ensure TS actors map doesn't contain it
    internals.actors.delete(actorId);
    internals.actors.delete("player");

    const submitActorCalls: string[] = [];
    const linkDeadCalls: Array<{ actorId: string; linkDead: boolean }> = [];

    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async ({ actor }) => {
        submitActorCalls.push(actor.id);
        return {
          tick: 11,
          actor: rustActorSnapshot({
            id: actor.id,
            label: "New Hero",
            link_dead: false,
            role: "player",
            areaId: actor.areaId,
            x: actor.x,
            y: actor.y,
            direction: actor.direction,
          }),
          inventory: [],
          reservations: [],
          timelineEvents: [],
        };
      },
      setActorLinkDead: async ({ actorId, linkDead }) => {
        linkDeadCalls.push({ actorId, linkDead });
        return {
          tick: 12,
          actor: rustActorSnapshot({ id: actorId, link_dead: linkDead }),
          inventory: [],
          reservations: [],
          timelineEvents: [],
        };
      },
    };

    try {
      const socket = controlledSocket();
      shard.connect(socket, {
        ...identity,
        spawn: { areaId: "authority-test-overworld", x: 15, y: 15, facing: "right" },
      });

      await waitFor(() => socket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));

      // Truly new character does normal upsert/register
      expect(submitActorCalls).toEqual([rustActorId]);
      expect(linkDeadCalls).toEqual([]);

      const parsedHello = JSON.parse(socket.sent.find((packet) => JSON.parse(packet).type === "game.hello")!) as {
        snapshot: {
          actors: Record<string, GameActorSnapshot>;
        };
      };
      const playerActor = parsedHello.snapshot.actors[actorId];
      expect(playerActor).toBeDefined();
      if (!playerActor) throw new Error("playerActor not found in hello snapshot");
      expect(playerActor.x).toBe(15);
      expect(playerActor.y).toBe(15);
      expect(playerActor.direction).toBe("right");
    } finally {
      shard.close();
    }
  });
  it("projects a fresh Rust bank privately for the owning session", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: { actor: RustAuthorityActorUpsertInput }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
      actors: Map<string, unknown>;
      rustAuthorityRegisteredActorIds: Set<string>;
    };
    const identity = testCharacterIdentity("fresh-bank-owner");
    internals.actors.delete(identity.actorId);
    internals.actors.delete("player");
    internals.rustAuthorityRegisteredActorIds.delete(identity.actorId);
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async ({ actor }) => ({
        tick: 11,
        actor: rustActorSnapshot({
          id: actor.id,
          label: actor.label ?? actor.id,
          role: actor.role ?? "player",
          areaId: actor.areaId,
          x: actor.x,
          y: actor.y,
          direction: actor.direction,
        }),
        inventory: [],
        reservations: [],
        timelineEvents: [],
        bank: actor.id === identity.actorId ? {
          actorId: actor.id,
          bankCredits: 0,
          items: [],
          backupPresent: false,
          backupSavedTick: null,
          backupSkillCount: 0,
          backupCost: 1_000,
        } : null,
      }),
    };
    try {
      const ownerSocket = controlledSocket();
      shard.connect(ownerSocket, {
        ...identity,
        spawn: { areaId: "authority-test-overworld", x: 15, y: 15, facing: "right" },
      });
      await waitFor(() => ownerSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      const ownerHello = packets(ownerSocket).find((packet) => packet.type === "game.hello") as {
        snapshot?: { bank?: { credits: number; items: unknown[] } };
      };
      expect(ownerHello.snapshot?.bank).toEqual({
        credits: 0,
        items: [],
        backupPresent: false,
        backupSavedTick: null,
        backupSkillCount: 0,
        backupCost: 1_000,
      });

      const observerSocket = controlledSocket();
      shard.connect(observerSocket, testCharacterIdentity("fresh-bank-observer"));
      await waitFor(() => observerSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      const observerHello = packets(observerSocket).find((packet) => packet.type === "game.hello") as {
        snapshot?: { bank?: unknown };
      };
      expect(observerHello.snapshot?.bank).toBeNull();
    } finally {
      shard.close();
    }
  });

  it("handles non-character transient actor with standard register and seeds deploy loadout", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });

    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: { actor: RustAuthorityActorUpsertInput }) => Promise<unknown>;
        setActorLinkDead?: (input: { actorId: string; linkDead: boolean }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
      rustAuthorityRegisteredActorIds: Set<string>;
      actors: Map<string, unknown>;
      rustActorIdFor(actorId: string): string;
    };

    // A non-character session identity has no characterId
    const identity: GameSessionIdentity = {
      actorId: "transient-actor",
      playerId: "local",
      displayName: "Transient Guest",
      zoneId: "authority-test",
      ownerRef: "local",
      spawn: { areaId: "authority-test-overworld", x: 10, y: 10, facing: "front" },
    };
    const actorId = identity.actorId;
    const rustActorId = internals.rustActorIdFor(actorId);

    // Ensure TS actors map doesn't contain it
    internals.actors.delete(actorId);
    internals.actors.delete("player");

    const submitActorCalls: string[] = [];

    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async ({ actor }) => {
        submitActorCalls.push(actor.id);
        return {
          tick: 11,
          actor: rustActorSnapshot({
            id: actor.id,
            label: "Transient Guest",
            link_dead: false,
            role: "player",
            areaId: actor.areaId,
            x: actor.x,
            y: actor.y,
            direction: actor.direction,
          }),
          inventory: [],
          reservations: [],
          timelineEvents: [],
        };
      },
    };

    try {
      const socket = controlledSocket();
      shard.connect(socket, identity);

      await waitFor(() => socket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));

      expect(submitActorCalls).toEqual([rustActorId, rustActorId]);

      const parsedHello = JSON.parse(socket.sent.find((packet) => JSON.parse(packet).type === "game.hello")!) as {
        snapshot: {
          actors: Record<string, GameActorSnapshot>;
        };
      };
      const playerActor = parsedHello.snapshot.actors[actorId];
      expect(playerActor).toBeDefined();
      if (!playerActor) throw new Error("playerActor not found in hello snapshot");
      expect(playerActor.x).toBe(10);
      expect(playerActor.y).toBe(10);
      expect(playerActor.direction).toBe("front");
    } finally {
      shard.close();
    }
  });

  it("rejects connections during pending restore, allows them after restore finishes, and rejects them on restore failure", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });

    const internals = shard as unknown as {
      rustAuthorityRestorePromise?: Promise<void>;
      rustAuthorityRestoreError?: Error;
      restoredCheckpoint?: { loaded: boolean; reason?: string };
      rustAuthorityMode: string | null;
      actors: Map<string, unknown>;
      sessions: Map<string, unknown>;
      rustAuthorityRegisteredActorIds: Set<string>;
      rustAuthorityLinkDeadActorIds: Set<string>;
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: { actor: RustAuthorityActorUpsertInput }) => Promise<unknown>;
        setActorLinkDead?: (input: { actorId: string; linkDead: boolean }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
      rustActorIdFor(actorId: string): string;
    };

    const identity = testCharacterIdentity("ld-restore-race");
    const actorId = identity.actorId;
    const rustActorId = internals.rustActorIdFor(actorId);

    // Mock bridge methods
    const submitActorCalls: string[] = [];
    const linkDeadCalls: Array<{ actorId: string; linkDead: boolean }> = [];
    const restoredInventory: RustAuthorityInventorySnapshot[] = [
      { container: `${rustActorId}:field-pack`, stackId: 1, item: "Petrochemical", itemId: 2004, variantId: 0, quantity: 5, reserved: 0, available: 5 }
    ];

    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async ({ actor }) => {
        submitActorCalls.push(actor.id);
        return {
          tick: 11,
          actor: rustActorSnapshot({ id: actor.id }),
          inventory: [],
          reservations: [],
          timelineEvents: [],
        };
      },
      setActorLinkDead: async ({ actorId, linkDead }) => {
        linkDeadCalls.push({ actorId, linkDead });
        return {
          tick: 12,
          actor: rustActorSnapshot({
            id: actorId,
            label: "Hero",
            link_dead: linkDead,
            role: "player",
            areaId: "authority-test-overworld",
            x: 24,
            y: 25,
            direction: "left",
          }),
          inventory: restoredInventory,
          reservations: [],
          timelineEvents: [],
        };
      },
    };

    // 1. Simulating pending restore:
    // we set rustAuthorityMode to live, mock a pending promise, and set restoredCheckpoint.loaded to false
    let resolveRestore: () => void = () => {};
    const restorePromise = new Promise<void>((resolve) => {
      resolveRestore = resolve;
    });
    internals.rustAuthorityRestorePromise = restorePromise;
    internals.restoredCheckpoint = { loaded: false, reason: "rust_restore_pending" };
    internals.rustAuthorityMode = "live";

    // Setup character registration mock as if restored from checkpoint
    internals.rustAuthorityRegisteredActorIds.add(rustActorId);
    internals.rustAuthorityLinkDeadActorIds.add(rustActorId);
    internals.actors.delete(actorId);
    internals.actors.delete("player");
    expect(internals.actors.has(actorId)).toBe(false);

    const pendingSocket = controlledSocket();
    await expect(() => shard.connect(pendingSocket, identity)).toThrowError("rust authority restore pending");

    // Assert socket was closed with code 1013 and correct reason, and packet counter was incremented
    expect(pendingSocket.closed).toEqual([{ code: 1013, reason: "rust authority restore pending" }]);
    expect(shard.status().counters.rejectedPackets).toBe(1);

    // Assert NO actor or session was created
    expect(internals.actors.has(actorId)).toBe(false);
    expect(internals.sessions.size).toBe(0);

    // 2. Simulating restore failure:
    // Set restore error
    internals.rustAuthorityRestoreError = new Error("rust authority restore failed");

    const failingSocket = controlledSocket();
    await expect(() => shard.connect(failingSocket, identity)).toThrowError("rust authority restore failed");

    // Assert socket closed with code 1011 and correct reason, and packet counter incremented
    expect(failingSocket.closed).toEqual([{ code: 1011, reason: "rust authority restore failed" }]);
    expect(shard.status().counters.rejectedPackets).toBe(2);

    // Assert NO actor or session was created
    expect(internals.actors.has(actorId)).toBe(false);
    expect(internals.sessions.size).toBe(0);

    // 3. Simulating successful restore completion:
    // Clear restore error, set restoredCheckpoint to loaded, and resolve the promise
    internals.rustAuthorityRestoreError = undefined;
    internals.restoredCheckpoint = { loaded: true };
    resolveRestore();
    await restorePromise;

    // Connect again
    const successSocket = controlledSocket();
    shard.connect(successSocket, {
      ...identity,
      spawn: { areaId: "authority-test-overworld", x: 99, y: 99, facing: "right" },
    });

    await waitFor(() => successSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));

    // Assert same connect succeeds, calls setActorLinkDead(..., false) once, and restores inventory
    expect(linkDeadCalls).toEqual([{ actorId: rustActorId, linkDead: false }]);
    expect(submitActorCalls).toEqual([]);

    const parsedHello = JSON.parse(successSocket.sent.find((packet) => JSON.parse(packet).type === "game.hello")!) as {
      snapshot: {
        actors: Record<string, GameActorSnapshot>;
        inventory: RustAuthorityInventorySnapshot[];
      };
    };
    const playerActor = parsedHello.snapshot.actors[actorId];
    expect(playerActor).toBeDefined();
    if (!playerActor) throw new Error("playerActor not found in hello snapshot");
    expect(playerActor.x).toBe(24);
    expect(playerActor.y).toBe(25);

    const playerRows = parsedHello.snapshot.inventory.filter((row) => row.container.startsWith(`${actorId}:`));
    expect(playerRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: 2004, quantity: 5 })
    ]));

    shard.close();
  });

  it("rejoins a dead-awaiting-respawn character without reviving or respawning it", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const identity = testCharacterIdentity("char-dead-reentry");
      const firstSocket = controlledSocket();
      shard.connect(firstSocket, identity);
      const actor = (shard as unknown as { actors: Map<string, { lifeState: string; vitals: { health: number; action: number; spirit: number }; respawnAtTick: number }> }).actors.get(identity.actorId);
      expect(actor).toBeDefined();
      actor!.lifeState = "downed";
      actor!.vitals = { health: 0, action: 0, spirit: 0 };
      actor!.respawnAtTick = shard.status().tick + 900;

      const rejoinSocket = controlledSocket();
      shard.connect(rejoinSocket, identity);

      expect(helloActor(rejoinSocket, identity.actorId)).toMatchObject({
        lifeState: "downed",
        vitals: { health: 0, action: 0, spirit: 0 },
        respawnAtTick: actor!.respawnAtTick,
      });
    } finally {
      shard.close();
    }
  });

  it("rejoins during a kneeling posture lock without clearing the lock", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const identity = testCharacterIdentity("char-kneel-reentry");
      const firstSocket = controlledSocket();
      shard.connect(firstSocket, identity);
      const actor = (shard as unknown as { actors: Map<string, { posture: string; postureUntilTick: number }> }).actors.get(identity.actorId);
      expect(actor).toBeDefined();
      actor!.posture = "kneeling";
      actor!.postureUntilTick = shard.status().tick + 21;

      const rejoinSocket = controlledSocket();
      shard.connect(rejoinSocket, identity);

      expect(helloActor(rejoinSocket, identity.actorId)).toMatchObject({
        posture: "kneeling",
        postureUntilTick: actor!.postureUntilTick,
      });
    } finally {
      shard.close();
    }
  });

  it("rejoins mid-combat with engagement and queue state intact", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const identity = testCharacterIdentity("char-combat-reentry");
      const firstSocket = controlledSocket();
      shard.connect(firstSocket, identity);
      const actor = (shard as unknown as { actors: Map<string, { inCombat: boolean; engagementTargetId: string | null; combatQueue: unknown }> }).actors.get(identity.actorId);
      expect(actor).toBeDefined();
      actor!.inCombat = true;
      actor!.engagementTargetId = "vendor";
      actor!.combatQueue = { nextReadyTick: 77, entries: [{ actionId: "basic_shot", targetActorId: "vendor", auto: true }] };

      const rejoinSocket = controlledSocket();
      shard.connect(rejoinSocket, identity);

      expect(helloActor(rejoinSocket, identity.actorId)).toMatchObject({
        inCombat: true,
        engagementTargetId: "vendor",
        combatQueue: { nextReadyTick: 77, entries: [{ actionId: "basic_shot", targetActorId: "vendor", auto: true }] },
      });
    } finally {
      shard.close();
    }
  });

  it("rejoins inside a transition trigger without auto-teleporting, then accepts the explicit transition", async () => {
    const { tempDir, slicePath: tempSlicePath } = writeTempSlice({
      areas: [
        { id: "authority-test-overworld", name: "Authority Test Overworld", kind: "overworld", width: 64, height: 36, level: 0 },
        { id: "test-interior", name: "Test Interior", kind: "public_interior", width: 16, height: 16, level: 0 },
      ],
      actors: [actorFixture("player", "Transitioner", "adventurer-premium-male", { x: 5, y: 5 }, "player")],
      transitions: [{
        id: "test-door",
        label: "Test Door",
        style: "door",
        fromAreaId: "authority-test-overworld",
        fromCell: { x: 5, y: 5 },
        triggerSize: { w: 2, h: 2 },
        toAreaId: "test-interior",
        toCell: { x: 2, y: 3 },
        toFacing: "front",
      }],
    });
    const shard = testShard({ slicePath: tempSlicePath, snapshotIntervalMs: 10_000 });
    try {
      const identity = testCharacterIdentity("char-transition-reentry", { areaId: "authority-test-overworld", x: 5, y: 5, facing: "right" });
      const firstSocket = controlledSocket();
      shard.connect(firstSocket, identity);

      const rejoinSocket = controlledSocket();
      shard.connect(rejoinSocket, identity);
      expect(helloActor(rejoinSocket, identity.actorId)).toMatchObject({
        areaId: "authority-test-overworld",
        x: 5,
        y: 5,
      });

      rejoinSocket.emitMessage(JSON.stringify({
        type: "game.command",
        envelope: envelope(1, { EnterTransition: { transition_id: "test-door" } }),
      }));
      await waitFor(() => packets(rejoinSocket).some((packet) => packet.type === "game.delta"));
      const delta = packets(rejoinSocket).find((packet) => packet.type === "game.delta");
      expect(delta?.receipts?.[0]).toMatchObject({ commandId: 1, accepted: true });
      expect(shard.snapshotFor(identity.actorId).actors[identity.actorId]).toMatchObject({
        areaId: "test-interior",
        x: 2,
        y: 3,
        direction: "front",
      });
    } finally {
      shard.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("classifies every authority command kind for telemetry", () => {
    const cases: Array<[string, ClientCommand]> = [
      ["Move", { Move: { dx: 1, dy: 0, duration_ticks: 1 } }],
      ["SetMoveIntent", { SetMoveIntent: { dx: 1, dy: 0 } }],
      ["QueueCombatAction", { QueueCombatAction: { action_id: "basic_shot", target_actor_id: "target" } }],
      ["Peace", { Peace: {} }],
      ["CancelAbilityQueue", { CancelAbilityQueue: { scope: "owner_repeat" } }],
      ["ReloadWeapon", { ReloadWeapon: { ammo_type: "slug_iron", weapon_id: "slugthrower" } }],
      ["SetEquippedWeapon", { SetEquippedWeapon: { weapon_id: "slugthrower" } }],
      ["DebugGiveItem", { DebugGiveItem: { item_id: 1101, quantity: 1 } }],
      ["DebugGrantSkillBoxes", { DebugGrantSkillBoxes: { skill_box_ids: ["marksman-novice"] } }],
      ["EnterTransition", { EnterTransition: { transition_id: "bench" } }],
      ["UseConsumable", { UseConsumable: { item_id: "stimpak_a" } }],
      ["RefillAmmo", { RefillAmmo: { item_id: "slug_iron" } }],
      ["ApplyServiceBuff", { ApplyServiceBuff: { effect_id: "food" } }],
      ["CloneRespawn", { CloneRespawn: { facility_id: "authority-cloner-main" } }],
      ["ReviveActor", { ReviveActor: { target_actor_id: "downed-ally" } }],
      ["SetPosture", { SetPosture: { posture: "kneel" } }],
      ["SampleResource", { SampleResource: { family: "mineral" } }],
      ["SurveyResource", { SurveyResource: { family: "mineral" } }],
      ["PlaceExtractor", { PlaceExtractor: { family: "mineral" } }],
      ["CrankExtractor", { CrankExtractor: { extractor_id: "extractor:player:1" } }],
      ["StopCrank", { StopCrank: {} }],
      ["InsertBattery", { InsertBattery: { extractor_id: "extractor:player:1", container: "player:field-pack", stack_id: "7", variant_id: 32_000_060 } }],
      ["CollectExtractor", { CollectExtractor: { extractor_id: "extractor:player:1" } }],
      ["DestroyExtractor", { DestroyExtractor: { extractor_id: "extractor:player:1" } }],
      ["SplitStack", { SplitStack: { container: "player:inventory", stack_id: "s1", item_id: 1101, variant_id: 0, quantity: 1 } }],
      ["MergeStacks", { MergeStacks: { container: "player:inventory", source_stack_id: "s1", target_stack_id: "s2" } }],
      ["RedeemCreditChip", { RedeemCreditChip: { container: "player:inventory", stack_id: "s1" } }],
      ["HarvestCorpse", { HarvestCorpse: { target_actor_id: "passive-creature-1" } }],
      ["TakeLootItem", { TakeLootItem: { container: "corpse:passive-creature-1", itemId: 2101, variantId: 7, quantity: 1 } }],
      ["PurchaseTravelTicket", { PurchaseTravelTicket: { terminal_prop_id: "travel-terminal-dustgate", to_planet_id: "verdance", to_city_id: "lowbough" } }],
      ["UseTravelTicket", { UseTravelTicket: { item_id: "travel_ticket" } }],
      ["ToggleDoor", { ToggleDoor: { prop_id: "open-desert-shelter-house" } }],
      [
        "CraftItem",
        {
          CraftItem: {
            schematic_id: "ammo",
            experiment_power: 10,
            experiment_handling: 6,
            experiment_reliability: 4,
          },
        },
      ],
      ["PurchaseSkillBox", { PurchaseSkillBox: { skill_box_id: "marksman-novice", trainer_actor_id: "trainer" } }],
      ["UnlearnSkillBox", { UnlearnSkillBox: { skill_box_id: "marksman-novice", trainer_actor_id: "trainer" } }],
      ["SetProfessionTitle", { SetProfessionTitle: { title_id: "marksman-novice" } }],
      ["SetCareerGoal", { SetCareerGoal: { goal_id: "marksman", trainer_actor_id: "trainer" } }],
      ["StoreToExchange", { StoreToExchange: { item_id: 2001, variant_id: 0, quantity: 1 } }],
      ["RetrieveFromExchange", { RetrieveFromExchange: { item_id: 2001, variant_id: 0, quantity: 1 } }],
      [
        "ProposeTrade",
        {
          ProposeTrade: {
            partner_actor_id: "agent-b",
            offer: [{ item_id: 1001, variant_id: 0, quantity: 1 }],
            request: [],
          },
        },
      ],
      ["AcceptTrade", { AcceptTrade: { proposal_id: 1 } }],
      ["DeclineTrade", { DeclineTrade: { proposal_id: 1 } }],
    ];

    for (const [kind, command] of cases) {
      expect(gameShardInternalsForTest.commandKind(command)).toBe(kind);
    }
  });

  it("honors clone respawn facility ids in the in-process authority path", () => {
    const { tempDir, slicePath: tempSlicePath } = writeTempSlice({
      actors: [
        actorFixture("player", "Test Player", "adventurer-premium-male", { x: 11, y: 17 }, "player"),
      ],
      cloneFacilities: [
        {
          id: "first-cloner",
          label: "First Cloner",
          areaId: "authority-test-overworld",
          respawnCell: { x: 2, y: 3 },
          respawnFacing: "front",
          sicknessDurationMs: 30_000,
        },
        {
          id: "second-cloner",
          label: "Second Cloner",
          areaId: "authority-test-overworld",
          respawnCell: { x: 20, y: 9 },
          respawnFacing: "right",
          sicknessDurationMs: 45_000,
        },
      ],
    });
    const shard = testShard({ slicePath: tempSlicePath, snapshotIntervalMs: 10_000 });
    try {
      const actor = (shard as unknown as {
        actors: Map<string, { lifeState: string; vitals: { health: number; action: number; spirit: number } }>;
      }).actors.get("player");
      expect(actor).toBeDefined();
      actor!.lifeState = "downed";
      actor!.vitals = { health: 0, action: 0, spirit: 0 };

      const selected = shard.submitCommandForTest("player", envelope(1, {
        CloneRespawn: { facility_id: "second-cloner" },
      }));

      expect(selected.receipt).toMatchObject({ accepted: true });
      expect(shard.snapshotFor("player").actors.player).toMatchObject({
        areaId: "authority-test-overworld",
        x: 20,
        y: 9,
        direction: "right",
        cloneSicknessRemainingMs: 45_000,
      });

      actor!.lifeState = "downed";
      actor!.vitals = { health: 0, action: 0, spirit: 0 };
      const unknown = shard.submitCommandForTest("player", envelope(2, {
        CloneRespawn: { facility_id: "missing-cloner" },
      }));
      expect(unknown.receipt).toMatchObject({
        accepted: false,
        reasonCode: "unknown_clone_facility",
      });

      const nearestDefault = shard.submitCommandForTest("player", envelope(3, {
        CloneRespawn: {},
      }));
      expect(nearestDefault.receipt).toMatchObject({ accepted: true });
      expect(shard.snapshotFor("player").actors.player).toMatchObject({
        x: 2,
        y: 3,
      });
    } finally {
      shard.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("routes per-stack loot takes through Rust authority and preserves loot rejection reasons", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: unknown) => Promise<unknown>;
        submitCommand?: (input: { actorId: string; envelope: ClientCommandEnvelope }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
    };
    const submittedEnvelopes: ClientCommandEnvelope[] = [];
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async () => ({}),
      submitCommand: async ({ envelope }) => {
        submittedEnvelopes.push(envelope);
        return {
          status: "rejected",
          reasonCode: "loot_no_rights",
          tick: 42,
          commandId: envelope.command_id,
          actors: [],
          combatEvents: [],
          inventory: [],
          reservations: [],
          npcJobs: [],
          timelineEvents: [],
        };
      },
    };
    try {
      shard.connect(fakeSocket(), {
        actorId: "agent-loot-probe",
        playerId: "agent-loot-probe",
        displayName: "Agent Loot Probe",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 37, y: 21, facing: "right" },
      });

      const result = await shard.submitDebugAuthorityCommand("agent-loot-probe", {
        TakeLootItem: {
          container: "corpse:agent-loot-probe",
          itemId: 1001,
          variantId: 7,
          quantity: 2,
        },
      });

      expect(result.receipt).toMatchObject({ accepted: false, reasonCode: "loot_no_rights", tick: 42 });
      expect(submittedEnvelopes[0]?.command).toEqual({
        TakeLootItem: {
          container: "corpse:player",
          itemId: 1001,
          variantId: 7,
          quantity: 2,
        },
      });
    } finally {
      shard.close();
    }
  });

  it("streams SampleResource cooldown rejects with owner-only next sample tick", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: unknown) => Promise<unknown>;
        submitCommand?: (input: { actorId: string; envelope: ClientCommandEnvelope }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
    };
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async () => ({}),
      submitCommand: async ({ actorId, envelope }) => ({
        status: "rejected",
        reasonCode: "sample_cooldown",
        tick: 123,
        commandId: envelope.command_id,
        actor: rustActorSnapshot({
          id: actorId,
          label: "Sample Probe",
          nextSampleTick: 456,
        }),
        actors: [],
        combatEvents: [],
        inventory: [],
        reservations: [],
        timelineEvents: [],
      }),
    };
    try {
      shard.connect(fakeSocket(), {
        actorId: "agent-sample-probe",
        playerId: "agent-sample-probe",
        displayName: "Sample Probe",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 37, y: 21, facing: "right" },
      });
      shard.connect(fakeSocket(), {
        actorId: "sample-observer",
        playerId: "sample-observer",
        displayName: "Sample Observer",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 38, y: 21, facing: "right" },
      });

      const result = await shard.submitDebugAuthorityCommand("agent-sample-probe", {
        SampleResource: { family: "mineral" },
      });

      expect(result.receipt).toMatchObject({ accepted: false, reasonCode: "sample_cooldown", tick: 123 });
      expect(deltaActorDetail(result.delta, "agent-sample-probe")?.nextSampleTick).toBe(456);
      expect(shard.snapshotFor("agent-sample-probe").actors["agent-sample-probe"]?.nextSampleTick).toBe(456);
      expect(shard.snapshotFor("sample-observer").actors["agent-sample-probe"]?.nextSampleTick).toBeUndefined();
    } finally {
      shard.close();
    }
  });

  // OUTPUT-COVERAGE (actor-field class, naming doctrine): the rust bridge emits
  // actor.descriptor (the actor descriptor); the shard MUST forward it onto the
  // client actor snapshot. A dropped forward reds this — same law as
  // nextSampleTick/displayName above.
  it("forwards the earlier sandbox design type descriptor from the rust actor snapshot onto the session", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: unknown) => Promise<unknown>;
        submitCommand?: (input: { actorId: string; envelope: ClientCommandEnvelope }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
    };
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async () => ({}),
      submitCommand: async ({ actorId, envelope }) => ({
        status: "accepted",
        reasonCode: null,
        tick: 30,
        commandId: envelope.command_id,
        actor: rustActorSnapshot({
          id: actorId,
          label: "Dax Vale",
          descriptor: "a rogue drifter",
          role: "skirmisher",
          factionId: "rogue_troopers",
          socialGroup: "open_desert_rogues",
        }),
        actors: [],
        combatEvents: [],
        inventory: [],
        reservations: [],
        timelineEvents: [],
      }),
    };
    try {
      shard.connect(fakeSocket(), {
        actorId: "descriptor-probe",
        playerId: "descriptor-probe",
        displayName: "Descriptor Probe",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 37, y: 21, facing: "right" },
      });
      shard.connect(fakeSocket(), {
        actorId: "descriptor-observer",
        playerId: "descriptor-observer",
        displayName: "Descriptor Observer",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 38, y: 21, facing: "right" },
      });
      // The command triggers the bridge step whose returned actor snapshot carries
      // the descriptor; the shard must forward it onto every session's actor view.
      await shard.submitDebugAuthorityCommand("descriptor-probe", {
        Move: { dx: 0, dy: 0, duration_ticks: 1 },
      });
      const own = shard.snapshotFor("descriptor-probe").actors["descriptor-probe"];
      expect(own?.descriptor, "shard.ts dropped rust actor.descriptor from the owner snapshot").toBe("a rogue drifter");
      expect(own?.display_name).toBe("Dax Vale");
      const seen = shard.snapshotFor("descriptor-observer").actors["descriptor-probe"];
      expect(seen?.descriptor, "shard.ts dropped rust actor.descriptor from the AOI-streamed snapshot").toBe("a rogue drifter");
    } finally {
      shard.close();
    }
  });

  it("bare /survey with no session context returns no_survey_context and forwards nothing", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "survey-sentinel-a-"));
    const journalPath = path.join(tempDir, "journal.jsonl");
    const { shard, submittedEnvelopes } = liveCaptureShard(journalPath);
    const socket = controlledSocket();
    try {
      shard.connect(socket, testCharacterIdentity("survey-sentinel-a"));
      await waitFor(() => packets(socket).some((packet) => packet.type === "game.hello"));
      socket.emitMessage(JSON.stringify({ type: "game.command", envelope: envelope(1, { SurveyResource: { family: "$last" } }) }));
      await waitFor(() => packets(socket).some((packet) =>
        Array.isArray(packet.receipts) && packet.receipts.some((r: { commandId?: number; reasonCode?: string }) => r.commandId === 1 && r.reasonCode === "no_survey_context")));
      const receipt = packets(socket)
        .flatMap((packet) => (Array.isArray(packet.receipts) ? packet.receipts : []))
        .find((r: { commandId?: number }) => r.commandId === 1);
      expect(receipt).toMatchObject({ accepted: false, reasonCode: "no_survey_context" });
      // The bare-no-context survey was NEVER forwarded to authority.
      expect(submittedEnvelopes).toHaveLength(0);
    } finally {
      shard.close();
    }
    const journal = fs.existsSync(journalPath) ? fs.readFileSync(journalPath, "utf8") : "";
    expect(journal).not.toContain("$last");
    expect(journal).not.toContain("SurveyResource");
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("bare /survey reuses the last surveyed family; the forwarded + journaled command never carries the sentinel", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "survey-sentinel-b-"));
    const journalPath = path.join(tempDir, "journal.jsonl");
    const { shard, submittedEnvelopes } = liveCaptureShard(journalPath);
    const socket = controlledSocket();
    try {
      shard.connect(socket, testCharacterIdentity("survey-sentinel-b"));
      await waitFor(() => packets(socket).some((packet) => packet.type === "game.hello"));
      // Explicit mineral survey; waiting on its accepted receipt guarantees the
      // session's last-resource context is recorded before the reuse.
      socket.emitMessage(JSON.stringify({ type: "game.command", envelope: envelope(1, { SurveyResource: { family: "mineral" } }) }));
      await waitFor(() => packets(socket).some((packet) =>
        Array.isArray(packet.receipts) && packet.receipts.some((r: { commandId?: number; accepted?: boolean }) => r.commandId === 1 && r.accepted)));
      // Bare /survey ($last) is resolved to the concrete family at ingress.
      socket.emitMessage(JSON.stringify({ type: "game.command", envelope: envelope(2, { SurveyResource: { family: "$last" } }) }));
      await waitFor(() => submittedEnvelopes.some((e) => e.command_id === 2));

      const forwardedFamilies = submittedEnvelopes.map((e) =>
        "SurveyResource" in e.command ? e.command.SurveyResource.family : null);
      expect(forwardedFamilies).toEqual(["mineral", "mineral"]);
      expect(JSON.stringify(submittedEnvelopes)).not.toContain("$last");
    } finally {
      shard.close();
    }
    const journal = fs.existsSync(journalPath) ? fs.readFileSync(journalPath, "utf8") : "";
    expect(journal).toContain("SurveyResource");
    expect(journal).toContain('"family":"mineral"');
    expect(journal).not.toContain("$last");
    fs.rmSync(tempDir, { recursive: true, force: true });
  });


  it("forwards the Rust spliceSession + genomeScan surfaces without dropping them at the shard boundary", async () => {
    // DEF-6 regression guard: the Rust bridge emits spliceSession (per Splice*
    // command) + genomeScan (per ScanGenome); the shard must carry both onto the
    // command result (and fan them out per-observer) — not swallow them the way
    // duel views were before DEF-5.
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: unknown) => Promise<unknown>;
        submitCommand?: (input: { actorId: string; envelope: ClientCommandEnvelope }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
    };
    internals.rustAuthorityBridge?.close();
    const spliceSession = {
      phase: "slots",
      speciesId: 6001,
      speciesName: "Ashgrain",
      slots: [{ slotIndex: 0, kind: "parent", label: "parent 1", filled: false, itemId: 0, variantId: 0 }],
      lines: [],
      assemblyQualityMilli: 0,
      pointsTotal: 0,
      pointsRemaining: 0,
      canAssemble: false,
      tick: 7,
    };
    const genomeScan = {
      itemId: 6001,
      variantId: 3,
      speciesName: "Ashgrain",
      cultivarName: "Kestrel",
      tier: "full",
      fertile: true,
      profile: { growthDaysBase: 5, waterNeedMilli: 212, yieldBase: 35, hardinessMilli: 500, seasonAffinity: 1, offSeasonPenaltyMilli: 500, stormResistanceMilli: 500, blightResistanceMilli: 500, regrowthDays: 0, tileFootprint: 1, qualityPotentialMilli: 800 },
      loci: [{ locus: 0, label: "yield", expressMilli: 874, a1: 874, a2: 874, heterozygous: false }],
      mutationPotentialMilli: 800,
      tick: 7,
    };
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async () => ({}),
      submitCommand: async ({ actorId, envelope }) => ({
        status: "accepted",
        tick: 7,
        commandId: envelope.command_id,
        actor: rustActorSnapshot({ id: actorId, label: "Genecrafter" }),
        actors: [],
        combatEvents: [],
        inventory: [],
        reservations: [],
        timelineEvents: [],
        spliceSession: "SpliceBegin" in envelope.command ? spliceSession : undefined,
        genomeScan: "ScanGenome" in envelope.command ? genomeScan : undefined,
      }),
    };
    try {
      shard.connect(fakeSocket(), {
        actorId: "genecrafter",
        playerId: "genecrafter",
        displayName: "Genecrafter",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 37, y: 21, facing: "right" },
      });

      const begin = await shard.submitDebugAuthorityCommand("genecrafter", { SpliceBegin: { species: "ashgrain" } });
      expect(begin.receipt.accepted).toBe(true);
      expect(begin.spliceSession).toMatchObject({ phase: "slots", speciesName: "Ashgrain" });
      expect(begin.genomeScan).toBeUndefined();

      const scan = await shard.submitDebugAuthorityCommand("genecrafter", {
        ScanGenome: { container: "genecrafter:field-pack", stack_id: "1", variant_id: 3 },
      });
      expect(scan.receipt.accepted).toBe(true);
      expect(scan.genomeScan).toMatchObject({ cultivarName: "Kestrel", tier: "full" });
      expect(scan.spliceSession).toBeUndefined();
    } finally {
      shard.close();
    }
  });

  it("rejects travel purchases outside the origin terminal radius", () => {
    const { tempDir, slicePath: tempSlicePath } = writeTempSlice(travelSliceParams({ playerCell: { x: 512, y: 512 } }));
    const shard = testShard({ slicePath: tempSlicePath, snapshotIntervalMs: 10_000 });
    try {
      const result = shard.submitCommandForTest("player", envelope(1, {
        PurchaseTravelTicket: {
          terminal_prop_id: "travel-terminal-dustgate",
          to_planet_id: "verdance",
          to_city_id: "lowbough",
        },
      }));
      expect(result.receipt).toMatchObject({ accepted: false, reasonCode: "travel_out_of_range" });
    } finally {
      shard.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("grants, validates, consumes, and teleports with server-authoritative travel tickets", () => {
    const { tempDir, slicePath: tempSlicePath } = writeTempSlice(travelSliceParams({
      playerCell: { x: 514, y: 512 },
      inventory: [{ container: "player:field-pack", item: "Iron Ore", itemId: 2001, variantId: 0, quantity: 1, reserved: 0, available: 1 }],
    }));
    const shard = testShard({ slicePath: tempSlicePath, snapshotIntervalMs: 10_000 });
    try {
      const missingTicket = shard.submitCommandForTest("player", envelope(1, { UseTravelTicket: { item_id: "travel_ticket" } }));
      expect(missingTicket.receipt).toMatchObject({ accepted: false, reasonCode: "travel_ticket_not_found" });

      const sameDestination = shard.submitCommandForTest("player", envelope(2, {
        PurchaseTravelTicket: {
          terminal_prop_id: "travel-terminal-dustgate",
          to_planet_id: "ashvat",
          to_city_id: "dustgate",
        },
      }));
      expect(sameDestination.receipt).toMatchObject({ accepted: false, reasonCode: "travel_same_destination" });

      const purchase = shard.submitCommandForTest("player", envelope(3, {
        PurchaseTravelTicket: {
          terminal_prop_id: "travel-terminal-dustgate",
          to_planet_id: "verdance",
          to_city_id: "lowbough",
        },
      }));
      expect(purchase.receipt).toMatchObject({ accepted: true });
      const ticketRow = (shard.snapshotFor("player").inventory ?? []).find((row) => row.itemKey === "travel_ticket");
      expect(ticketRow).toMatchObject({
        container: "player:field-pack",
        stackId: 1,
        itemId: 5001,
        itemKey: "travel_ticket",
        quantity: 1,
        available: 1,
      });
      expect(ticketRow?.metadata?.travelTicket).toMatchObject({
        fromPlanetId: "ashvat",
        fromCityId: "dustgate",
        toPlanetId: "verdance",
        toCityId: "lowbough",
        originTerminalPropId: "travel-terminal-dustgate",
        originAreaId: "open-desert-overworld",
        destAreaId: "verdance-forest-overworld",
        destSpawn: { x: 512, y: 512 },
      });

      const internals = shard as unknown as {
        actors: Map<string, { areaId: string; x: number; y: number; xMilli: number; yMilli: number }>;
      };
      const actor = internals.actors.get("player");
      expect(actor).toBeDefined();
      actor!.areaId = "verdance-forest-overworld";
      actor!.x = 514;
      actor!.y = 512;
      actor!.xMilli = 514_000;
      actor!.yMilli = 512_000;
      const wrongTerminal = shard.submitCommandForTest("player", envelope(4, { UseTravelTicket: { item_id: "travel_ticket" } }));
      expect(wrongTerminal.receipt).toMatchObject({ accepted: false, reasonCode: "travel_origin_wrong_terminal" });

      actor!.areaId = "open-desert-overworld";
      actor!.x = 514;
      actor!.y = 512;
      actor!.xMilli = 514_000;
      actor!.yMilli = 512_000;
      const use = shard.submitCommandForTest("player", envelope(5, { UseTravelTicket: { item_id: "travel_ticket" } }));
      expect(use.receipt).toMatchObject({ accepted: true });
      expect(shard.snapshotFor("player").actors.player).toMatchObject({
        areaId: "verdance-forest-overworld",
        x: 512,
        y: 512,
      });
      expect((shard.snapshotFor("player").inventory ?? []).some((row) => row.itemKey === "travel_ticket")).toBe(false);

      const consumed = shard.submitCommandForTest("player", envelope(6, { UseTravelTicket: { item_id: "travel_ticket" } }));
      expect(consumed.receipt).toMatchObject({ accepted: false, reasonCode: "travel_ticket_not_found" });
    } finally {
      shard.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("relocates a live Rust actor for ticket travel without an actor upsert and checkpoints before acknowledgement", async () => {
    const { tempDir, slicePath: tempSlicePath } = writeTempSlice(travelSliceParams({
      playerCell: { x: 514, y: 512 },
      inventory: [{ container: "player:field-pack", item: "Iron Ore", itemId: 2001, variantId: 0, quantity: 1, reserved: 0, available: 1 }],
    }));
    const checkpointPath = path.join(tempDir, "travel.checkpoint.json");
    const shard = new GameShard({
      slicePath: tempSlicePath,
      snapshotIntervalMs: 10_000,
      persistence: { checkpointPath },
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const relocations: Array<{ actorId: string; areaId: string; x: number; y: number; direction: string }> = [];
    const checkpointReasons: string[] = [];
    let upsertCalls = 0;
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close(): void;
        pendingCount(): number;
        debugStatus(): null;
        submitActor(): Promise<never>;
        relocateActor(input: { actorId: string; areaId: string; x: number; y: number; direction: string }): Promise<unknown>;
        exportState(): Promise<unknown>;
      };
      rustAuthorityRegisteredActorIds: Set<string>;
      checkpoint(reason?: string): Promise<unknown>;
    };
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => undefined,
      pendingCount: () => 0,
      debugStatus: () => null,
      submitActor: async () => {
        upsertCalls += 1;
        throw new Error("ticket travel must not rebuild a live actor");
      },
      relocateActor: async (input) => {
        relocations.push({
          actorId: input.actorId,
          areaId: input.areaId,
          x: input.x,
          y: input.y,
          direction: input.direction,
        });
        return {
          tick: 81,
          targetStateHash: "travel-relocation-state",
          actor: rustActorSnapshot({
            id: input.actorId,
            label: "Test Player",
            role: "player",
            areaId: input.areaId,
            x: input.x,
            y: input.y,
            direction: input.direction,
            vitals: { health: 83, action: 71, spirit: 64 },
          }),
          inventory: [],
          reservations: [],
          timelineEvents: [],
          resourceSpawns: [],
          areaResourceSpawns: [],
          placedExtractors: [],
          placedCamps: [],
          placedParcels: [],
          farmPlots: [],
          groupViewsByActorId: {},
          duelViewsByActorId: {},
          playerCorpses: [],
        };
      },
      exportState: async () => ({
        tick: 81,
        stateHash: "f".repeat(64),
        state: {
          schema: "successor.authority-state.v1",
          version: 1,
          stateHash: "f".repeat(64),
        },
      }),
    };
    internals.rustAuthorityRegisteredActorIds.add("player");
    internals.checkpoint = async (reason = "manual") => {
      checkpointReasons.push(reason);
      return {};
    };

    try {
      const purchase = await shard.submitDebugAuthorityCommand("player", {
        PurchaseTravelTicket: {
          terminal_prop_id: "travel-terminal-dustgate",
          to_planet_id: "verdance",
          to_city_id: "lowbough",
        },
      });
      expect(purchase.receipt).toMatchObject({ accepted: true });

      const use = await shard.submitDebugAuthorityCommand("player", {
        UseTravelTicket: { item_id: "travel_ticket" },
      });
      expect(use.receipt).toMatchObject({ accepted: true });
      expect(upsertCalls).toBe(0);
      expect(relocations).toEqual([{
        actorId: "player",
        areaId: "verdance-forest-overworld",
        x: 512,
        y: 512,
        direction: "front",
      }]);
      expect(checkpointReasons).toEqual(["world-transition"]);
      expect(shard.snapshotFor("player").actors.player).toMatchObject({
        areaId: "verdance-forest-overworld",
        x: 512,
        y: 512,
        vitals: { health: 83, action: 71, spirit: 64 },
      });
    } finally {
      await shard.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("toggles door prop state with server-side range validation and exposes it to the debug oracle", async () => {
    const { tempDir, slicePath: tempSlicePath } = writeTempSlice({
      actors: [
        actorFixture("player", "Test Player", "adventurer-premium-male", { x: 13, y: 12 }, "player"),
      ],
      props: [{
        id: "shelter-house",
        entity: "prop:shelter-house",
        areaId: "authority-test-overworld",
        label: "Shelter House",
        kind: "prop",
        cell: { x: 10, y: 8 },
        size: { w: 5, h: 4 },
        interactive: false,
        solid: false,
        door: { blocker: { xMilli: 2420, yMilli: 3705, wMilli: 1240, hMilli: 295 }, interactRadiusCells: 2.2 },
      }],
    });
    const shard = testShard({ slicePath: tempSlicePath, snapshotIntervalMs: 10_000 });
    try {
      expect(shard.snapshotFor("player").propStates?.["shelter-house"]).toEqual({ doorOpen: false });
      const opened = shard.submitCommandForTest("player", envelope(1, { ToggleDoor: { prop_id: "shelter-house" } }));
      expect(opened.receipt).toMatchObject({ accepted: true });
      expect(opened.delta.propStates?.["shelter-house"]).toEqual({ doorOpen: true });
      expect((await shard.debugOracle({ refreshAiDebug: false })).propStates["shelter-house"]).toEqual({ doorOpen: true });
      const closed = shard.submitCommandForTest("player", envelope(2, { ToggleDoor: { prop_id: "shelter-house" } }));
      expect(closed.receipt).toMatchObject({ accepted: true });
      expect(closed.delta.propStates?.["shelter-house"]).toEqual({ doorOpen: false });
      expect((await shard.debugOracle({ refreshAiDebug: false })).propStates["shelter-house"]).toEqual({ doorOpen: false });
      const internals = shard as unknown as {
        actors: Map<string, { x: number; y: number; xMilli: number; yMilli: number }>;
      };
      const actor = internals.actors.get("player");
      expect(actor).toBeDefined();
      actor!.x = 20;
      actor!.y = 20;
      actor!.xMilli = 20_000;
      actor!.yMilli = 20_000;
      const rejected = shard.submitCommandForTest("player", envelope(3, { ToggleDoor: { prop_id: "shelter-house" } }));
      expect(rejected.receipt).toMatchObject({ accepted: false, reasonCode: "door_out_of_range" });
      expect(shard.snapshotFor("player").propStates?.["shelter-house"]).toEqual({ doorOpen: false });
    } finally {
      shard.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
  it("includes vitals and bleed when compact actor context changes", () => {
    const previous: GameActorSnapshot = {
      id: "passive-creature-01",
      label: "Gaia Creature",
      display_name: "Gaia Creature",
      link_dead: false,
      appearance: { skin: "#c78f62", hair: null, hair_mat: "hair_raven" },
      areaId: "authority-test-overworld",
      x: 18,
      y: 15,
      direction: "front",
      posture: "standing",
      postureUntilTick: 0,
      lifeState: "alive",
      lifecycleSeq: 1,
      vitals: { health: 100, action: 100, spirit: 100 },
      maxVitals: { health: 100, action: 100, spirit: 100 },
      bleed: { active: true, stackCount: 1, severity: 1, remainingMs: 900, ratesPerSecond: { health: 1, action: 0, spirit: 0 } },
      statuses: [],
    };
    const current: GameActorSnapshot = {
      ...previous,
      lifeState: "downed",
      vitals: { health: 0, action: 0, spirit: 0 },
      bleed: { active: false, stackCount: 0, severity: 0, remainingMs: 0, ratesPerSecond: { health: 0, action: 0, spirit: 0 } },
    };

    const patch = gameShardInternalsForTest.actorPatch(current, previous, false, false);

    expect(patch).toMatchObject({
      id: "passive-creature-01",
      lifeState: "downed",
      vitals: current.vitals,
      maxVitals: current.maxVitals,
      bleed: current.bleed,
    });
  });

  it("treats a present Rust appearance as complete and preserves only an omitted appearance delta", () => {
    const face = {
      eyes: "eyes_narrow",
      brows: "brows_arched",
      nose: "nose_hooked",
      mouth: "mouth_smirk",
      eye_color: "#6f8d55",
      brow_color: "#291c16",
      lip_color: "#9f5563",
    };
    const fallback = {
      skin: "#c78f62",
      hair: "hair_mop",
      hair_mat: "hair_umber",
      face,
    };
    const snapshotWithoutFace = {
      ...rustActorSnapshot({ id: "current-face-actor" }),
      appearance: {
        skin: "#9b684b",
        hair: "hair_crop2",
        hair_mat: "hair_raven",
      },
    } as RustAuthorityActorSnapshot;
    const snapshotWithoutAppearance = {
      ...snapshotWithoutFace,
      appearance: undefined,
    };

    expect(gameShardInternalsForTest.normalizeRustActorAppearance(snapshotWithoutFace, fallback)).toEqual({
      skin: "#9b684b",
      hair: "hair_crop2",
      hair_mat: "hair_raven",
      face: null,
    });
    expect(gameShardInternalsForTest.normalizeRustActorAppearance(snapshotWithoutAppearance, fallback)).toEqual(fallback);
  });

  it("publishes source metadata with authoritative snapshots", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const source = JSON.parse(fs.readFileSync(slicePath, "utf8")) as { stateHash: string; actors: unknown[] };
      const snapshot = shard.snapshotFor("player");

      expect(snapshot.sourceStateHash).toBe(source.stateHash);
      expect(snapshot.sourceActorCount).toBe(source.actors.length);
      expect(snapshot.worldClock.config?.realSecondsPerGameDay).toBe(300);
      expect(snapshot.worldClock.phase).toBe("dawn");
    } finally {
      shard.close();
    }
  });

  it("maintains viewport AOI entries and removals from session interest-set diffs", () => {
    const fixture = writeTempSlice({
      actors: [
        actorFixture("player", "Player", "adventurer-premium-male", { x: 10, y: 10 }, "player"),
        actorFixture("npc-aoi", "AOI NPC", "npc-civilian", { x: 12, y: 10 }, "civilian"),
      ],
      areas: [{ id: "authority-test-overworld", name: "AOI Test", kind: "overworld", width: 96, height: 96, level: 0 }],
    });
    const shard = testShard({ slicePath: fixture.slicePath, snapshotIntervalMs: 34 });
    const socket = fakeSocket();
    try {
      shard.connect(socket, {
        actorId: "player",
        playerId: "player",
        displayName: "Player",
        zoneId: "authority-test-overworld",
      }, {
        viewport_width_cells: 4,
        viewport_height_cells: 4,
        margin_cells: 0,
        center_actor_id: "player",
      });
      const hello = packets(socket).find((packet) => packet.type === "game.hello");
      expect(hello?.snapshot.actors["npc-aoi"]).toBeDefined();
      socket.sent.length = 0;

      const internals = shard as unknown as {
        actors: Map<string, { x: number; y: number }>;
        invalidateActorSpatialIndex: () => void;
        markDirty: (...actorIds: string[]) => void;
        aoiBookkeepingMetricsForTest: () => { activeSessionInterestActors: number; actorReciprocalLinks: number };
      };
      const npc = internals.actors.get("npc-aoi");
      expect(npc).toBeDefined();

      npc!.x = 40;
      internals.invalidateActorSpatialIndex();
      internals.markDirty("npc-aoi");
      shard.flushSnapshotsForTest();
      const exitDelta = packets(socket).find((packet) => packet.type === "game.delta" && packet.delta.actorRemovals?.includes("npc-aoi"));
      expect(exitDelta?.delta.actorRemovals).toContain("npc-aoi");
      socket.sent.length = 0;

      npc!.x = 11;
      internals.invalidateActorSpatialIndex();
      internals.markDirty("npc-aoi");
      shard.flushSnapshotsForTest();
      const entryDelta = packets(socket).find((packet) => packet.type === "game.delta" && deltaActor(packet.delta, "npc-aoi"));
      expect(deltaActor(entryDelta?.delta, "npc-aoi")).toMatchObject({ id: "npc-aoi" });
      expect(entryDelta?.delta.actorRefs).toContainEqual([expect.any(Number), "npc-aoi"]);
      expect(internals.aoiBookkeepingMetricsForTest()).toMatchObject({
        activeSessionInterestActors: 2,
        actorReciprocalLinks: 2,
      });
    } finally {
      shard.close();
      fs.rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("scopes session inventory snapshots to owner-visible rows without changing own row bytes", () => {
    const ownRow: RustAuthorityInventorySnapshot = {
      container: "player:field-pack",
      stackId: 7,
      item: "Field Bandage",
      itemId: 1002,
      variantId: 3,
      quantity: 5,
      reserved: 1,
      available: 4,
      itemKey: "field_bandage",
      metadata: { slot: "belt", source: "fixture" },
    };
    const fixture = writeTempSlice({
      actors: [
        actorFixture("player", "Player", "adventurer-premium-male", { x: 10, y: 10 }, "player"),
        actorFixture("stranger", "Stranger", "npc-civilian", { x: 11, y: 10 }, "civilian"),
      ],
      inventory: [
        ownRow,
        { container: "stranger:field-pack", stackId: 1, item: "Stimpak A", itemId: 1001, variantId: 0, quantity: 9, reserved: 0, available: 9 },
      ],
    });
    const shard = testShard({ slicePath: fixture.slicePath, snapshotIntervalMs: 10_000 });
    const socket = fakeSocket();
    try {
      shard.connect(socket, {
        actorId: "player",
        playerId: "player",
        displayName: "Player",
        zoneId: "authority-test-overworld",
      });
      const helloInventory = (packets(socket).find((packet) => packet.type === "game.hello")?.snapshot?.inventory ?? []) as RustAuthorityInventorySnapshot[];

      expect(helloInventory).toEqual([ownRow]);
      expect(helloInventory.some((row) => row.container.startsWith("stranger:"))).toBe(false);
    } finally {
      shard.close();
      fs.rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("adds and removes loot inventory rows as loot rights and reach become true then lapse", () => {
    const corpseRow: RustAuthorityInventorySnapshot = {
      container: "corpse:loot-victim",
      stackId: 1,
      item: "Iron Slug",
      itemId: 1101,
      variantId: 0,
      quantity: 30,
      reserved: 0,
      available: 30,
    };
    const fixture = writeTempSlice({
      actors: [
        actorFixture("player", "Player", "adventurer-premium-male", { x: 10, y: 10 }, "player"),
        actorFixture("loot-victim", "Loot Victim", "npc-raider", { x: 11, y: 10 }, "skirmisher"),
      ],
      inventory: [corpseRow],
    });
    const shard = testShard({ slicePath: fixture.slicePath, snapshotIntervalMs: 10_000 });
    const socket = fakeSocket();
    try {
      const internals = shard as unknown as {
        actors: Map<string, { x: number; lifeState: string; bodyVanishAtTick: number; lootable: boolean; hasLoot: boolean; lootRightsActorId: string | null }>;
        invalidateActorSpatialIndex: () => void;
        markDirty: (...actorIds: string[]) => void;
      };
      const corpse = internals.actors.get("loot-victim");
      expect(corpse).toBeDefined();
      corpse!.lifeState = "downed";
      corpse!.bodyVanishAtTick = 1_000;
      corpse!.lootable = true;
      corpse!.hasLoot = true;
      corpse!.lootRightsActorId = "stranger";

      shard.connect(socket, {
        actorId: "player",
        playerId: "player",
        displayName: "Player",
        zoneId: "authority-test-overworld",
      });
      const helloInventory = (packets(socket).find((packet) => packet.type === "game.hello")?.snapshot?.inventory ?? []) as RustAuthorityInventorySnapshot[];
      expect(helloInventory.some((row) => row.container === "corpse:loot-victim")).toBe(false);
      socket.sent.length = 0;

      corpse!.lootRightsActorId = "player";
      internals.markDirty("loot-victim");
      shard.flushSnapshotsForTest();
      const rightsDelta = packets(socket).find((packet) => packet.type === "game.delta" && Array.isArray(packet.delta.inventory))?.delta as GameShardDelta | undefined;
      expect(rightsDelta?.inventory).toEqual([corpseRow]);
      socket.sent.length = 0;

      const player = internals.actors.get("player");
      expect(player).toBeDefined();
      player!.x = 40;
      internals.invalidateActorSpatialIndex();
      internals.markDirty("player");
      shard.flushSnapshotsForTest();
      const removalDelta = packets(socket).find((packet) => packet.type === "game.delta" && Array.isArray(packet.delta.inventory))?.delta as GameShardDelta | undefined;
      expect(removalDelta?.inventory).toEqual([]);
    } finally {
      shard.close();
      fs.rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("streams district exchange rows only while the session actor is at an exchange container", () => {
    const exchangeRow: RustAuthorityInventorySnapshot = {
      container: "district-exchange",
      stackId: 1,
      item: "Iron Ore",
      itemId: 2001,
      variantId: 0,
      quantity: 40,
      reserved: 0,
      available: 40,
    };
    const fixture = writeTempSlice({
      actors: [
        actorFixture("player", "Player", "adventurer-premium-male", { x: 10, y: 10 }, "player"),
      ],
      props: [{
        id: "district-exchange-test",
        entity: "container:district-exchange",
        areaId: "authority-test-overworld",
        label: "District Exchange",
        kind: "resource_container",
        cell: { x: 10, y: 10 },
        size: { w: 1, h: 1 },
        interactive: true,
        solid: false,
      }],
      inventory: [exchangeRow],
    });
    const shard = testShard({ slicePath: fixture.slicePath, snapshotIntervalMs: 10_000 });
    const socket = fakeSocket();
    try {
      shard.connect(socket, {
        actorId: "player",
        playerId: "player",
        displayName: "Player",
        zoneId: "authority-test-overworld",
      });
      const helloInventory = (packets(socket).find((packet) => packet.type === "game.hello")?.snapshot?.inventory ?? []) as RustAuthorityInventorySnapshot[];
      expect(helloInventory).toEqual([exchangeRow]);
      socket.sent.length = 0;

      const internals = shard as unknown as {
        actors: Map<string, { x: number; y: number }>;
        invalidateActorSpatialIndex: () => void;
        markDirty: (...actorIds: string[]) => void;
      };
      const player = internals.actors.get("player");
      expect(player).toBeDefined();
      player!.x = 20;
      player!.y = 20;
      internals.invalidateActorSpatialIndex();
      internals.markDirty("player");
      shard.flushSnapshotsForTest();

      const delta = packets(socket).find((packet) => packet.type === "game.delta" && Array.isArray(packet.delta.inventory))?.delta as GameShardDelta | undefined;
      expect(delta?.inventory).toEqual([]);

    } finally {
      shard.close();
      fs.rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("keeps respawning actors deliverable until clients remove them", () => {

    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const internals = shard as unknown as {
        actors: Map<string, { id: string; areaId: string; lifeState: string }>;
        dirtyActorSpatialIndex: (actorIds: string[]) => Map<string, Map<string, Array<{ id: string }>>>;
        actorRemovalsForSession: (session: {
          actorId: string;
          knownActorIds: Set<string>;
          knownActorSnapshots: Map<string, GameActorSnapshot>;
          deferredDirtyActorIds: Set<string>;
        }) => string[];
      };
      const actor = internals.actors.get("vendor");
      expect(actor).toBeDefined();
      actor!.lifeState = "respawning";

      const index = internals.dirtyActorSpatialIndex(["vendor"]);
      const indexedIds = [...(index.get(actor!.areaId)?.values() ?? [])].flat().map((entry) => entry.id);

      expect(indexedIds).toContain("vendor");
      expect(internals.actorRemovalsForSession({
        actorId: "player",
        knownActorIds: new Set(["vendor"]),
        knownActorSnapshots: new Map(),
        deferredDirtyActorIds: new Set(),
      })).toContain("vendor");
    } finally {
      shard.close();
    }
  });

  it("delivers deferred known actors when lifecycle changes to non-alive", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const snapshot = shard.snapshotFor("player");
      const previous = snapshot.actors.vendor;
      expect(previous).toBeDefined();
      const internals = shard as unknown as {
        actors: Map<string, { id: string; areaId: string; x: number; y: number; lifeState: string; lifecycleSeq: number }>;
        shouldSendRoutineActorMove: (session: {
          actorId: string;
          knownActorIds: Set<string>;
          knownActorSnapshots: Map<string, GameActorSnapshot>;
          lastActorDeltaTick: number;
          viewInterest?: null;
        }, actorId: string) => boolean;
      };
      const actor = internals.actors.get("vendor");
      expect(actor).toBeDefined();
      actor!.lifeState = "downed";
      actor!.lifecycleSeq = previous!.lifecycleSeq + 1;

      expect(internals.shouldSendRoutineActorMove({
        actorId: "player",
        knownActorIds: new Set(["vendor"]),
        knownActorSnapshots: new Map([["vendor", previous!]]),
        lastActorDeltaTick: 10,
        viewInterest: null,
      }, "vendor")).toBe(true);
    } finally {
      shard.close();
    }
  });

  it("does not send actor patches for actors removed as respawning", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const snapshot = shard.snapshotFor("player");
      const previous = snapshot.actors.vendor;
      expect(previous).toBeDefined();
      const internals = shard as unknown as {
        actors: Map<string, { id: string; areaId: string; lifeState: string; lifecycleSeq: number }>;
        deltaForSession: (session: {
          actorId: string;
          knownActorIds: Set<string>;
          knownActorSnapshots: Map<string, GameActorSnapshot>;
          deferredDirtyActorIds: Set<string>;
          viewInterest?: null;
        }, focusActorIds: string[], options: { includeActorRemovals?: boolean }) => {
          actors: Record<string, GameActorSnapshot>;
          actorPatches?: Record<string, GameActorPatch>;
          actorRemovals?: string[];
        };
      };
      const actor = internals.actors.get("vendor");
      expect(actor).toBeDefined();
      actor!.lifeState = "respawning";
      actor!.lifecycleSeq = previous!.lifecycleSeq + 1;

      const delta = internals.deltaForSession({
        actorId: "player",
        knownActorIds: new Set(["vendor"]),
        knownActorSnapshots: new Map([["vendor", previous!]]),
        deferredDirtyActorIds: new Set(),
        viewInterest: null,
      }, ["vendor"], { includeActorRemovals: true });

      expect(delta.actorRemovals).toContain("vendor");
      expect(delta.actors.vendor).toBeUndefined();
      expect(delta.actorPatches?.vendor).toBeUndefined();
    } finally {
      shard.close();
    }
  });

  it("resends a full actor after a respawning actor was omitted from a client snapshot", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const snapshot = shard.snapshotFor("player");
      const previous = snapshot.actors.vendor;
      expect(previous).toBeDefined();
      const session = {
        actorId: "player",
        knownActorIds: new Set(["player", "vendor"]),
        knownActorSnapshots: new Map([
          ["player", snapshot.actors.player!],
          ["vendor", previous!],
        ]),
        deferredDirtyActorIds: new Set<string>(),
        viewInterest: null,
      };
      const internals = shard as unknown as {
        actors: Map<string, { id: string; areaId: string; lifeState: string; lifecycleSeq: number }>;
        snapshotForSession: (testSession: typeof session) => { actors: Record<string, GameActorSnapshot> };
        replaceKnownActorSnapshots: (testSession: typeof session, actors: Record<string, GameActorSnapshot>) => void;
        deltaForSession: (testSession: typeof session, focusActorIds: string[], options: { includeActorRemovals?: boolean }) => {
          actors: Record<string, GameActorSnapshot>;
          actorPatches?: Record<string, GameActorPatch>;
          compactActorMoves?: GameCompactActorMove[];
          actorRemovals?: string[];
        };
      };
      const actor = internals.actors.get("vendor");
      expect(actor).toBeDefined();
      actor!.lifeState = "respawning";
      actor!.lifecycleSeq = previous!.lifecycleSeq + 1;

      const respawningSnapshot = internals.snapshotForSession(session);
      expect(respawningSnapshot.actors.vendor).toBeUndefined();
      internals.replaceKnownActorSnapshots(session, respawningSnapshot.actors);
      expect(session.knownActorIds.has("vendor")).toBe(false);
      expect(session.knownActorSnapshots.has("vendor")).toBe(false);

      actor!.lifeState = "alive";
      actor!.lifecycleSeq += 1;
      const respawnedDelta = internals.deltaForSession(session, ["vendor"], { includeActorRemovals: true });

      expect(respawnedDelta.actorRemovals ?? []).not.toContain("vendor");
      expect(respawnedDelta.actorPatches?.vendor).toBeUndefined();
      expect(respawnedDelta.compactActorMoves ?? []).toHaveLength(0);
      expect(respawnedDelta.actors.vendor).toMatchObject({
        id: "vendor",
        lifeState: "alive",
        lifecycleSeq: actor!.lifecycleSeq,
      });
    } finally {
      shard.close();
    }
  });

  it("does not locally expire Rust-downed corpses from a stale legacy body deadline", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const internals = shard as unknown as {
        actors: Map<string, { lifeState: string; lifecycleSeq: number; bodyVanishAtTick: number; respawnAtTick: number }>;
        applyRustAuthorityTickOutput: (output: RustAuthorityBridgeTickOutput) => GameCombatEvent[];
      };
      const actor = internals.actors.get("vendor");
      expect(actor).toBeDefined();
      actor!.lifeState = "downed";
      actor!.lifecycleSeq = 7;
      actor!.bodyVanishAtTick = 900;
      actor!.respawnAtTick = 1_800;

      internals.applyRustAuthorityTickOutput({
        schema: "successor.rust-authority-bridge-tick.v1",
        requestId: 10,
        tick: 10_000,
        targetStateHash: "test-rust-corpse-lifecycle-stays-rust-owned",
        actors: [],
        combatEvents: [],
        inventory: [],
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
      });

      expect(actor).toMatchObject({
        lifeState: "downed",
        lifecycleSeq: 7,
        bodyVanishAtTick: 900,
        respawnAtTick: 1_800,
      });
    } finally {
      shard.close();
    }
  });

  it("keeps known downed corpses streamed until Rust reports respawning or removal", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const snapshot = shard.snapshotFor("player");
      const previous = snapshot.actors.vendor;
      expect(previous).toBeDefined();
      const session = {
        actorId: "player",
        knownActorIds: new Set(["vendor"]),
        knownActorSnapshots: new Map([["vendor", previous!]]),
        deferredDirtyActorIds: new Set<string>(),
        viewInterest: {
          viewportWidthCells: 1,
          viewportHeightCells: 1,
          marginCells: 0,
          updatedAtTick: 10_000,
        },
      };
      const internals = shard as unknown as {
        actors: Map<string, {
          id: string;
          areaId: string;
          x: number;
          y: number;
          lifeState: string;
          lifecycleSeq: number;
          bodyVanishAtTick: number;
        }>;
        tick: number;
        deltaForSession: (testSession: typeof session, focusActorIds: string[], options: { includeActorRemovals?: boolean }) => {
          actors: Record<string, GameActorSnapshot>;
          actorPatches?: Record<string, GameActorPatch>;
          actorRemovals?: string[];
        };
      };
      const actor = internals.actors.get("vendor");
      expect(actor).toBeDefined();
      internals.tick = 10_000;
      actor!.x = previous!.x + 10_000;
      actor!.y = previous!.y + 10_000;
      actor!.lifeState = "downed";
      actor!.lifecycleSeq = previous!.lifecycleSeq + 1;
      actor!.bodyVanishAtTick = 20_083;

      const delta = internals.deltaForSession(session, [], { includeActorRemovals: true });

      expect(delta.actorRemovals ?? []).not.toContain("vendor");
      expect(session.knownActorIds.has("vendor")).toBe(true);
    } finally {
      shard.close();
    }
  });

  it("keeps current Rust actor snapshots authoritative over same-output combat event lifecycle projection", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const previous = shard.snapshotFor("player").actors.vendor;
      expect(previous).toBeDefined();
      const internals = shard as unknown as {
        actors: Map<string, { lifeState: string; lifecycleSeq: number; bodyVanishAtTick: number; respawnAtTick: number }>;
        applyRustAuthorityTickOutput: (output: RustAuthorityBridgeTickOutput) => GameCombatEvent[];
      };
      const actor = internals.actors.get("vendor");
      expect(actor).toBeDefined();
      actor!.lifeState = "downed";
      actor!.lifecycleSeq = 7;
      actor!.bodyVanishAtTick = 100;
      actor!.respawnAtTick = 200;

      const events = internals.applyRustAuthorityTickOutput({
        schema: "successor.rust-authority-bridge-tick.v1",
        requestId: 11,
        tick: 120,
        targetStateHash: "test-current-snapshot-wins",
        actors: [rustActorSnapshot({
          id: "vendor",
          x: previous!.x,
          y: previous!.y,
          lifeState: "respawning",
          lifecycleSeq: 7,
          bodyVanishTick: 0,
          respawnTick: 200,
          vitals: { health: 0, action: 0, spirit: 0 },
        })],
        combatEvents: [{
          id: 9001,
          commandId: 77,
          tick: 101,
          shooterActorId: "player",
          targetActorId: "vendor",
          originX: previous!.x - 1,
          originY: previous!.y,
          hitX: previous!.x,
          hitY: previous!.y,
          damage: 100,
          previousLifeState: "alive",
          lifeState: "downed",
          targetLifecycleSeq: 7,
          bleedStackCount: 0,
          lifecycle: "killed",
          zone: "torso",
          weaponId: "slugthrower",
          ammoType: "slug_iron",
          lifecycleCause: "test stale event",
        }],
        inventory: [],
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
        metrics: {
          tick: 120,
          shotsFired: 0,
          combatEvents: 1,
          hits: 1,
          deaths: 1,
          inventoryStacks: 0,
          reservations: 0,
          npcJobs: 0,
          timelineEvents: 0,
        },
      });

      expect(events).toHaveLength(1);
      expect(events[0]?.originPoint).toEqual({ x: previous!.x - 1, y: previous!.y });
      expect(actor).toMatchObject({
        lifeState: "respawning",
        lifecycleSeq: 7,
        bodyVanishAtTick: 0,
        respawnAtTick: 200,
      });
    } finally {
      shard.close();
    }
  });

  it("normalizes Rust vibrosword combat event weapon ids for client projection", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const previous = shard.snapshotFor("player").actors.vendor;
      expect(previous).toBeDefined();
      const internals = shard as unknown as {
        applyRustAuthorityTickOutput: (output: RustAuthorityBridgeTickOutput) => GameCombatEvent[];
      };

      const events = internals.applyRustAuthorityTickOutput({
        schema: "successor.rust-authority-bridge-tick.v1",
        requestId: 12,
        tick: 121,
        targetStateHash: "test-vibrosword-event-projection",
        actors: [],
        combatEvents: [{
          id: 9002,
          commandId: 78,
          tick: 121,
          shooterActorId: "player",
          targetActorId: "vendor",
          originX: previous!.x - 1,
          originY: previous!.y,
          hitX: previous!.x,
          hitY: previous!.y,
          damage: 20,
          previousLifeState: "alive",
          lifeState: "alive",
          targetLifecycleSeq: previous!.lifecycleSeq,
          bleedStackCount: 0,
          lifecycle: "hit",
          zone: "torso",
          weaponId: "Vibrosword",
          ammoType: "Melee",
          lifecycleCause: "test vibrosword event",
        }],
        inventory: [],
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
        metrics: {
          tick: 121,
          shotsFired: 0,
          combatEvents: 1,
          hits: 1,
          deaths: 0,
          inventoryStacks: 0,
          reservations: 0,
          npcJobs: 0,
          timelineEvents: 0,
        },
      });

      expect(events[0]?.weaponId).toBe("vibrosword");
      expect(events[0]?.ammoTypeId).toBe("melee");
    } finally {
      shard.close();
    }
  });

  it("streams harvested resource rows with short labels and structured potency/purity", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const internals = shard as unknown as {
        applyRustAuthorityTickOutput: (output: RustAuthorityBridgeTickOutput) => GameCombatEvent[];
      };

      internals.applyRustAuthorityTickOutput({
        schema: "successor.rust-authority-bridge-tick.v1",
        requestId: 12,
        tick: 121,
        targetStateHash: "test-resource-row-stats",
        actors: [],
        combatEvents: [],
        inventory: [{
          container: "player:creature-food",
          stackId: 42,
          item: "Redspine Creature Meat P350 Q158",
          itemId: 2102,
          variantId: 321_234,
          quantity: 3,
          reserved: 0,
          available: 3,
          resourceStats: {
            conductivity: 0,
            malleability: 0,
            shock_resistance: 0,
            thermal_resistance: 0,
            chemical_purity: 158,
            density: 0,
            tensile_strength: 0,
            flexibility: 0,
            potency: 350,
            nutrition: 0,
            stability: 0,
            extraction_yield: 0,
          },
        }],
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
      });

      expect(shard.snapshotFor("player").inventory).toContainEqual(expect.objectContaining({
        container: "player:creature-food",
        item: "Redspine Creature Meat",
        itemId: 2102,
        variantId: 321_234,
        potency: 350,
        purity: 158,
      }));
    } finally {
      shard.close();
    }
  });
  it("normalizes resource stats through tick, step, actor, restock, and import outputs", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    const internals = shard as unknown as {
      applyRustAuthorityTickOutput: (output: RustAuthorityBridgeTickOutput) => unknown;
      applyRustAuthorityOutput: (actorId: string, rustActorId: string, output: RustAuthorityBridgeStepOutput) => unknown;
      syncRustInventory: (
        inventory: RustAuthorityInventorySnapshot[] | null | undefined,
        reservations: RustAuthorityReservationSnapshot[] | null | undefined,
        timelineEvents?: unknown,
      ) => void;
      applyRustAuthorityImportOutput: (output: RustAuthorityBridgeImportStateOutput) => unknown;
    };

    const mockStats12: RustAuthorityResourceStatsSnapshot = {
      conductivity: 950,
      malleability: 450,
      shock_resistance: 10,
      thermal_resistance: 20,
      chemical_purity: 158,
      density: 120,
      tensile_strength: 310,
      flexibility: 80,
      potency: 350,
      nutrition: 50,
      stability: 90,
      extraction_yield: 600,
    };

    // Helper to generate a mock inventory row
    const makeRow = (
      itemId: number,
      variantId: number,
      resourceStats?: RustAuthorityResourceStatsSnapshot,
      potency?: number,
      purity?: number,
    ): RustAuthorityInventorySnapshot => ({
      container: "player:field-pack",
      stackId: 1,
      item: "Mock Item",
      itemId,
      variantId,
      quantity: 1,
      reserved: 0,
      available: 1,
      resourceStats,
      potency,
      purity,
    });

    try {
      // 1. Cover TICK output
      internals.applyRustAuthorityTickOutput({
        schema: "successor.rust-authority-bridge-tick.v1",
        requestId: 101,
        tick: 1,
        targetStateHash: "test-tick",
        actors: [],
        combatEvents: [],
        inventory: [
          makeRow(2007, 221001, { ...mockStats12 }) // Copper
        ],
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
      });

      let playerInv = shard.snapshotFor("player").inventory ?? [];
      expect(playerInv).toBeDefined();
      const copperRow = playerInv.find(r => r.itemId === 2007);
      expect(copperRow).toBeDefined();
      expect(copperRow!.resourceStats).toEqual(mockStats12);
      expect(copperRow!.potency).toBe(350); // derived from resourceStats
      expect(copperRow!.purity).toBe(158);  // derived from resourceStats.chemical_purity

      // 2. Cover STEP output
      internals.applyRustAuthorityOutput("player", "player", {
        schema: "successor.rust-authority-bridge-step.v1",
        requestId: 102,
        actor: null,
        inventory: [
          makeRow(2008, 266666, { ...mockStats12 }) // Carbon
        ],
      });

      playerInv = shard.snapshotFor("player").inventory ?? [];
      const carbonRow = playerInv.find(r => r.itemId === 2008);
      expect(carbonRow).toBeDefined();
      expect(carbonRow!.resourceStats).toEqual(mockStats12);
      expect(carbonRow!.potency).toBe(350);
      expect(carbonRow!.purity).toBe(158);

      // 3. Cover ACTOR/UPSERT output
      internals.syncRustInventory(
        [
          makeRow(2009, 47123456, { ...mockStats12 }) // Fuel
        ],
        []
      );

      playerInv = shard.snapshotFor("player").inventory ?? [];
      const fuelRow = playerInv.find(r => r.itemId === 2009);
      expect(fuelRow).toBeDefined();
      expect(fuelRow!.resourceStats).toEqual(mockStats12);
      // 4. Cover RESTOCK output
      internals.syncRustInventory(
        [
          makeRow(2010, 48123456, { ...mockStats12 }) // Polymer
        ],
        []
      );

      playerInv = shard.snapshotFor("player").inventory ?? [];
      const polymerRow = playerInv.find(r => r.itemId === 2010);
      expect(polymerRow).toBeDefined();
      expect(polymerRow!.resourceStats).toEqual(mockStats12);

      // 5. Cover IMPORT output
      internals.applyRustAuthorityImportOutput({
        schema: "successor.rust-authority-bridge-tick.v1",
        requestId: 105,
        tick: 2,
        targetStateHash: "test-import",
        actors: [],
        combatEvents: [],
        inventory: [
          makeRow(2006, 99, { ...mockStats12 }), // Legacy Clodpowder
          makeRow(2006, 46072101, { ...mockStats12 }) // Encoded Clodpowder
        ],
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
      });

      playerInv = shard.snapshotFor("player").inventory ?? [];
      const legacyCreature = playerInv.find(r => r.itemId === 2006 && r.variantId === 99);
      const encodedCreature = playerInv.find(r => r.itemId === 2006 && r.variantId === 46072101);
      expect(legacyCreature).toBeDefined();
      expect(encodedCreature).toBeDefined();
      expect(legacyCreature!.resourceStats).toEqual(mockStats12);
      expect(encodedCreature!.resourceStats).toEqual(mockStats12);

      // 6. Assert malformed Fuel/Polymer and non-resource item omit resourceStats
      internals.applyRustAuthorityTickOutput({
        schema: "successor.rust-authority-bridge-tick.v1",
        requestId: 106,
        tick: 3,
        targetStateHash: "test-omissions",
        actors: [],
        combatEvents: [],
        inventory: [
          makeRow(2009, 99, { ...mockStats12 }), // Malformed Fuel (legacy variant)
          makeRow(2010, 99, { ...mockStats12 }), // Malformed Polymer (legacy variant)
          makeRow(3006, 1, { ...mockStats12 }),   // Non-resource item
        ],
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
      });

      playerInv = shard.snapshotFor("player").inventory ?? [];
      const malformedFuel = playerInv.find(r => r.itemId === 2009 && r.variantId === 99);
      const malformedPolymer = playerInv.find(r => r.itemId === 2010 && r.variantId === 99);
      const toolRow = playerInv.find(r => r.itemId === 3006);

      expect(malformedFuel).toBeDefined();
      expect(malformedFuel!.resourceStats).toBeUndefined(); // Omitted!
      expect(malformedPolymer).toBeDefined();
      expect(malformedPolymer!.resourceStats).toBeUndefined(); // Omitted!
      expect(toolRow).toBeDefined();
      expect(toolRow!.resourceStats).toBeUndefined(); // Omitted!

      // 7. Server normalization preserves all 12 clamped integer channels
      // (verified via the mockStats12 checks above)

      // 8. Derives legacy potency/purity from authoritative block only (does not look at row.potency/purity if block present)
      internals.applyRustAuthorityTickOutput({
        schema: "successor.rust-authority-bridge-tick.v1",
        requestId: 107,
        tick: 4,
        targetStateHash: "test-derive",
        actors: [],
        combatEvents: [],
        inventory: [
          // Row has potency=1, purity=1, but resourceStats has potency=350, chemical_purity=158
          makeRow(2007, 221001, { ...mockStats12 }, 1, 1),
        ],
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
      });
      playerInv = shard.snapshotFor("player").inventory ?? [];
      const derivedRow = playerInv.find(r => r.itemId === 2007);
      expect(derivedRow).toBeDefined();
      expect(derivedRow!.potency).toBe(350); // derived from authoritative block only!
      expect(derivedRow!.purity).toBe(158);  // derived from authoritative block only!

      // 9. Does not fabricate stats when absent
      internals.applyRustAuthorityTickOutput({
        schema: "successor.rust-authority-bridge-tick.v1",
        requestId: 108,
        tick: 5,
        targetStateHash: "test-no-fabricate",
        actors: [],
        combatEvents: [],
        inventory: [
          // Row has NO resourceStats, but has potency=400, purity=200
          makeRow(2007, 221001, undefined, 400, 200),
        ],
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
      });
      playerInv = shard.snapshotFor("player").inventory ?? [];
      const noStatsRow = playerInv.find(r => r.itemId === 2007);
      expect(noStatsRow).toBeDefined();
      expect(noStatsRow!.resourceStats).toBeUndefined(); // Did not fabricate stats!
      expect(noStatsRow!.potency).toBe(400); // Preserved clamped legacy potency
      expect(noStatsRow!.purity).toBe(200);  // Preserved clamped legacy purity
    } finally {
      shard.close();
    }
  });
  it("detects resourceStats changes in inventory delta comparison", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    const internals = shard as unknown as {
      applyRustAuthorityTickOutput: (output: RustAuthorityBridgeTickOutput) => unknown;
      dirty: boolean;
    };

    const makeRow = (resourceStats: RustAuthorityResourceStatsSnapshot): RustAuthorityInventorySnapshot => ({
      container: "player:field-pack",
      stackId: 1,
      item: "Copper",
      itemId: 2007,
      variantId: 221001,
      quantity: 1,
      reserved: 0,
      available: 1,
      resourceStats,
    });

    try {
      internals.applyRustAuthorityTickOutput({
        schema: "successor.rust-authority-bridge-tick.v1",
        requestId: 1,
        tick: 1,
        targetStateHash: "hash-1",
        actors: [],
        combatEvents: [],
        inventory: [makeRow({
          conductivity: 950,
          malleability: 450,
          shock_resistance: 0,
          thermal_resistance: 0,
          chemical_purity: 0,
          density: 0,
          tensile_strength: 0,
          flexibility: 0,
          potency: 0,
          nutrition: 0,
          stability: 0,
          extraction_yield: 0,
        })],
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
      });

      // Clear the dirty flag
      internals.dirty = false;

      // Apply tick with changed resourceStats (conductivity 950 -> 900)
      internals.applyRustAuthorityTickOutput({
        schema: "successor.rust-authority-bridge-tick.v1",
        requestId: 2,
        tick: 2,
        targetStateHash: "hash-2",
        actors: [],
        combatEvents: [],
        inventory: [makeRow({
          conductivity: 900,
          malleability: 450,
          shock_resistance: 0,
          thermal_resistance: 0,
          chemical_purity: 0,
          density: 0,
          tensile_strength: 0,
          flexibility: 0,
          potency: 0,
          nutrition: 0,
          stability: 0,
          extraction_yield: 0,
        })],
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
      });

      // Shard must detect this change and set dirty=true!
      expect(internals.dirty).toBe(true);

    } finally {
      shard.close();
    }
  });

  it("reentry sync preserves nonempty inventory and can clear an actually-empty authoritative inventory", async () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    const internals = shard as unknown as {
      actors: Map<string, unknown>;
      rustAuthorityRegisteredActorIds: Set<string>;
      rustAuthorityMode: string;
      rustAuthorityBridge: {
        setActorLinkDead: (options: { actorId: string; linkDead: boolean }) => Promise<RustAuthorityBridgeActorOutput>;
        close: () => void;
      };
      clearRustActorLinkDeadForReentry: (actor: unknown) => Promise<void> | null;
      inventory: RustAuthorityInventorySnapshot[];
    };

    // Set up the shard in "live" mode so clearRustActorLinkDeadForReentry runs
    internals.rustAuthorityMode = "live";
    internals.rustAuthorityRegisteredActorIds.add("player");

    // Stub the bridge's setActorLinkDead method
    const mockSetActorLinkDead = vi.fn();
    internals.rustAuthorityBridge = {
      setActorLinkDead: mockSetActorLinkDead,
      close: vi.fn(),
    };

    const playerActor = internals.actors.get("player");
    expect(playerActor).toBeDefined();

    const mockStats12: RustAuthorityResourceStatsSnapshot = {
      conductivity: 950,
      malleability: 450,
      shock_resistance: 10,
      thermal_resistance: 20,
      chemical_purity: 158,
      density: 120,
      tensile_strength: 310,
      flexibility: 80,
      potency: 350,
      nutrition: 50,
      stability: 90,
      extraction_yield: 600,
    };

    const makeRow = (itemId: number, variantId: number): RustAuthorityInventorySnapshot => ({
      container: "player:field-pack",
      stackId: 1,
      item: "Copper",
      itemId,
      variantId,
      quantity: 1,
      reserved: 0,
      available: 1,
      resourceStats: { ...mockStats12 },
    });

    try {
      // 1. Reentry sync with non-empty inventory
      mockSetActorLinkDead.mockResolvedValueOnce({
        schema: "successor.rust-authority-bridge-actor.v1",
        requestId: 201,
        tick: 42,
        targetStateHash: "hash-reentry-nonempty",
        actor: rustActorSnapshot({ id: "player", x: 100, y: 100, lifeState: "alive", lifecycleSeq: 1 }),
        inventory: [makeRow(2007, 221001)],
        reservations: [],
        timelineEvents: [],
      });

      const p1 = internals.clearRustActorLinkDeadForReentry(playerActor);
      expect(p1).toBeDefined();
      await p1;

      expect(internals.inventory.length).toBe(1);
      expect(internals.inventory[0]!.itemId).toBe(2007);
      expect(internals.inventory[0]!.resourceStats).toEqual(mockStats12);

      // 2. Reentry sync with actually-empty inventory (clears existing)
      mockSetActorLinkDead.mockResolvedValueOnce({
        schema: "successor.rust-authority-bridge-actor.v1",
        requestId: 202,
        tick: 43,
        targetStateHash: "hash-reentry-empty",
        actor: rustActorSnapshot({ id: "player", x: 100, y: 100, lifeState: "alive", lifecycleSeq: 1 }),
        inventory: [],
        reservations: [],
        timelineEvents: [],
      });

      const p2 = internals.clearRustActorLinkDeadForReentry(playerActor);
      expect(p2).toBeDefined();
      await p2;

      expect(internals.inventory.length).toBe(0); // cleared!

    } finally {
      shard.close();
    }
  });


  it("marks Rust-projected corpses dirty so session AOI deltas can deliver loot prompts", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const previous = shard.snapshotFor("player").actors.vendor;
      expect(previous).toBeDefined();
      const internals = shard as unknown as {
        actors: Map<string, { lifeState: string; lifecycleSeq: number; bodyVanishAtTick: number; respawnAtTick: number }>;
        dirtyActorIds: Set<string>;
        applyRustAuthorityTickOutput: (output: RustAuthorityBridgeTickOutput) => GameCombatEvent[];
      };

      internals.applyRustAuthorityTickOutput({
        schema: "successor.rust-authority-bridge-tick.v1",
        requestId: 14,
        tick: 120,
        targetStateHash: "test-corpse-dirty-projection",
        actors: [rustActorSnapshot({
          id: "vendor",
          x: previous!.x,
          y: previous!.y,
          lifeState: "downed",
          lifecycleSeq: previous!.lifecycleSeq + 1,
          bodyVanishTick: 600,
          respawnTick: 900,
          vitals: { health: 0, action: 0, spirit: 0 },
          lootable: true,
          hasLoot: true,
          lootRightsActorId: "player",
        })],
        combatEvents: [],
        inventory: [],
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
        metrics: {
          tick: 120,
          shotsFired: 0,
          combatEvents: 0,
          hits: 0,
          deaths: 0,
          inventoryStacks: 0,
          reservations: 0,
          npcJobs: 0,
          timelineEvents: 0,
        },
      });

      expect(internals.actors.get("vendor")).toMatchObject({
        lifeState: "downed",
        lifecycleSeq: previous!.lifecycleSeq + 1,
        bodyVanishAtTick: 600,
        lootable: true,
        hasLoot: true,
        lootRightsActorId: "player",
      });
      expect(internals.dirtyActorIds.has("vendor")).toBe(true);
      expect(shard.snapshotFor("player").actors.vendor).toMatchObject({
        bodyVanishTick: 600,
        lootable: true,
        hasLoot: true,
        lootRightsActorId: "player",
      });
    } finally {
      shard.close();
    }
  });

  it("projects authoritative shot spread from Rust actor snapshots", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const previous = shard.snapshotFor("player").actors.vendor;
      expect(previous).toBeDefined();
      expect(previous!.shotSpreadDegreesMilli).toBeUndefined();
      const internals = shard as unknown as {
        applyRustAuthorityTickOutput: (output: RustAuthorityBridgeTickOutput) => GameCombatEvent[];
      };

      internals.applyRustAuthorityTickOutput({
        schema: "successor.rust-authority-bridge-tick.v1",
        requestId: 15,
        tick: 120,
        targetStateHash: "test-shot-spread-projection",
        actors: [rustActorSnapshot({
          id: "vendor",
          x: previous!.x,
          y: previous!.y,
          lifecycleSeq: previous!.lifecycleSeq,
          shotSpreadDegreesMilli: 48_350,
        })],
        combatEvents: [],
        inventory: [],
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
        metrics: {
          tick: 120,
          shotsFired: 0,
          combatEvents: 0,
          hits: 0,
          deaths: 0,
          inventoryStacks: 0,
          reservations: 0,
          npcJobs: 0,
          timelineEvents: 0,
        },
      });

      expect(shard.snapshotFor("player").actors.vendor?.shotSpreadDegreesMilli).toBe(48_350);
    } finally {
      shard.close();
    }
  });

  it("does not expire Rust-provided corpse visibility deadlines when the hidden snapshot is omitted", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const internals = shard as unknown as {
        actors: Map<string, { lifeState: string; lifecycleSeq: number; bodyVanishAtTick: number; respawnAtTick: number }>;
        applyRustAuthorityTickOutput: (output: RustAuthorityBridgeTickOutput) => GameCombatEvent[];
      };
      const actor = internals.actors.get("vendor");
      expect(actor).toBeDefined();
      actor!.lifeState = "downed";
      actor!.lifecycleSeq = 4;
      actor!.bodyVanishAtTick = 100;
      actor!.respawnAtTick = 220;

      internals.applyRustAuthorityTickOutput({
        schema: "successor.rust-authority-bridge-tick.v1",
        requestId: 12,
        tick: 120,
        targetStateHash: "test-expire-corpse-projection",
        actors: [],
        combatEvents: [],
        inventory: [],
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
        metrics: {
          tick: 120,
          shotsFired: 0,
          combatEvents: 0,
          hits: 0,
          deaths: 0,
          inventoryStacks: 0,
          reservations: 0,
          npcJobs: 0,
          timelineEvents: 0,
        },
      });

      expect(actor).toMatchObject({
        lifeState: "downed",
        lifecycleSeq: 4,
        bodyVanishAtTick: 100,
        respawnAtTick: 220,
      });
    } finally {
      shard.close();
    }
  });

  it("maps claimed Rust placeholder inventory and timeline rows back to the session actor", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const internals = shard as unknown as {
        claimedAuthoredPlaceholders: Map<string, string>;
        syncRustInventory: (
          inventory: Array<{ container: string; item: string; itemId: number; variantId: number; quantity: number; reserved: number; available: number }>,
          reservations: Array<{ id: number; actor: string; purpose: string; from: string; item: string; quantity: number; expiresAtTick?: number | null }>,
          timelineEvents: Array<{ tick: number; label: string; cell?: { x: number; y: number } | null }>,
        ) => void;
        inventory: Array<{ container: string; itemId: number; available: number }>;
        reservations: Array<{ actor: string; from: string }>;
        timelineEvents: Array<{ label: string }>;
      };
      internals.claimedAuthoredPlaceholders.set("resource-crafter", "player");

      internals.syncRustInventory(
        [{
          container: "player:resource-crate",
          item: "Mineral",
          itemId: 2001,
          variantId: 0,
          quantity: 12,
          reserved: 0,
          available: 12,
        }],
        [{
          id: 1,
          actor: "player",
          purpose: "craft",
          from: "player:resource-crate",
          item: "Mineral",
          quantity: 2,
        }],
        [{ tick: 12, label: "player sampled 12 Mineral", cell: { x: 10, y: 10 } }],
      );

      expect(internals.inventory[0]).toMatchObject({
        container: "resource-crafter:resource-crate",
        itemId: 2001,
        available: 12,
      });
      expect(internals.reservations[0]).toMatchObject({
        actor: "resource-crafter",
        from: "resource-crafter:resource-crate",
      });
      expect(internals.timelineEvents[0]?.label).toBe("resource-crafter sampled 12 Mineral");
    } finally {
      shard.close();
    }
  });

  it("streams owned placed extractors to claimed actor sessions", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: { actor: RustAuthorityActorUpsertInput }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
    };
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async ({ actor }) => ({
        tick: 24,
        actor: rustActorSnapshot({
          id: actor.id,
          label: actor.label ?? actor.id,
          role: actor.role ?? "player",
          areaId: actor.areaId,
          x: actor.x,
          y: actor.y,
          direction: actor.direction,
        }),
        inventory: [],
        reservations: [],
        timelineEvents: [],
        resourceSpawns: [],
        areaResourceSpawns: [],
        placedExtractors: [{
          extractorId: "extractor:player:1",
          ownerActorId: "player",
          areaId: "authority-test-overworld",
          cellX: 10,
          cellY: 12,
          mode: "idle",
          biome: "desert",
          hopperPct: 0,
          collectableUnits: 0,
          batteryPct: 0,
          isOwner: false,
          familyLabel: "Mineral",
        }],
      }),
    };

    try {
      const ownerSocket = controlledSocket();
      shard.connect(ownerSocket, {
        actorId: "extractorfe-probe2",
        playerId: "local",
        displayName: "Extractor Probe",
        zoneId: "authority-test",
        characterId: "extractorfe-probe2",
        ownerRef: "local",
        spawn: { areaId: "authority-test-overworld", x: 10, y: 12, facing: "right" },
      });
      await waitFor(() => ownerSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));

      const observerSocket = controlledSocket();
      shard.connect(observerSocket, {
        actorId: "observer",
        playerId: "observer",
        displayName: "Observer",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 11, y: 12, facing: "right" },
      });
      await waitFor(() => observerSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));

      const ownerHello = packets(ownerSocket).find((packet) => packet.type === "game.hello");
      const observerHello = packets(observerSocket).find((packet) => packet.type === "game.hello");
      const ownerExtractor = ownerHello?.snapshot.placedExtractors?.[0];
      const observerExtractor = observerHello?.snapshot.placedExtractors?.[0];

      expect(ownerExtractor).toMatchObject({ extractorId: "extractor:player:1", isOwner: true });
      expect(ownerExtractor).not.toHaveProperty("ownerActorId");
      expect(observerExtractor).toMatchObject({ extractorId: "extractor:player:1", isOwner: false });

      // Debug oracle (unauthenticated, CORS *): stranger shape — no owner
      // identity, isOwner false (day-2 P1-4 hardening, extractor twin).
      const oracleExtractor = (await shard.debugOracle({ refreshAiDebug: false })).placedExtractors?.[0];
      expect(oracleExtractor).toMatchObject({ extractorId: "extractor:player:1", isOwner: false });
      expect(oracleExtractor).not.toHaveProperty("ownerActorId");
    } finally {
      shard.close();
    }
  });

  it("streams placed camps with owner-only abandonment countdown redaction", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: { actor: RustAuthorityActorUpsertInput }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
    };
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async ({ actor }) => ({
        tick: 24,
        actor: rustActorSnapshot({
          id: actor.id,
          label: actor.label ?? actor.id,
          role: actor.role ?? "player",
          areaId: actor.areaId,
          x: actor.x,
          y: actor.y,
          direction: actor.direction,
        }),
        inventory: [],
        reservations: [],
        timelineEvents: [],
        resourceSpawns: [],
        areaResourceSpawns: [],
        // Tick-observer truth: is_owner false + countdown ALWAYS present when
        // armed (camps.rs exports it unconditionally; the SHARD owns privacy).
        placedCamps: [{
          campId: "camp:player:1",
          ownerActorId: "player",
          areaId: "authority-test-overworld",
          cellX: 10,
          cellY: 12,
          isOwner: false,
          renderKind: "scout-camp",
          abandonSecondsRemaining: 894,
        }],
      }),
    };

    try {
      const ownerSocket = controlledSocket();
      shard.connect(ownerSocket, {
        actorId: "campfe-probe",
        playerId: "local",
        displayName: "Camp Probe",
        zoneId: "authority-test",
        characterId: "campfe-probe",
        ownerRef: "local",
        spawn: { areaId: "authority-test-overworld", x: 10, y: 12, facing: "right" },
      });
      await waitFor(() => ownerSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));

      const observerSocket = controlledSocket();
      shard.connect(observerSocket, {
        actorId: "camp-observer",
        playerId: "observer",
        displayName: "Observer",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 11, y: 12, facing: "right" },
      });
      await waitFor(() => observerSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));

      const ownerCamp = packets(ownerSocket).find((packet) => packet.type === "game.hello")?.snapshot.placedCamps?.[0];
      const observerCamp = packets(observerSocket).find((packet) => packet.type === "game.hello")?.snapshot.placedCamps?.[0];

      // Owner: isOwner recomputed across the claimed-placeholder boundary,
      // countdown visible, raw ownerActorId never leaves the shard.
      expect(ownerCamp).toMatchObject({ campId: "camp:player:1", isOwner: true, abandonSecondsRemaining: 894 });
      expect(ownerCamp).not.toHaveProperty("ownerActorId");
      // Stranger: tent visible, clock private.
      expect(observerCamp).toMatchObject({ campId: "camp:player:1", isOwner: false });
      expect(observerCamp).not.toHaveProperty("abandonSecondsRemaining");
      expect(observerCamp).not.toHaveProperty("ownerActorId");

      // Debug oracle (unauthenticated, CORS *): the STRANGER shape exactly —
      // no owner identity, no countdown, isOwner false (day-2 P1-4: the
      // oracle must never carry fields a live session is denied).
      const oracleCamp = (await shard.debugOracle({ refreshAiDebug: false })).placedCamps?.[0];
      expect(oracleCamp).toMatchObject({ campId: "camp:player:1", isOwner: false, renderKind: "scout-camp" });
      expect(oracleCamp).not.toHaveProperty("ownerActorId");
      expect(oracleCamp).not.toHaveProperty("abandonSecondsRemaining");
    } finally {
      shard.close();
    }
  });

  it("streams world-visible parcels + farm plots with owner-only redaction (DEF-9 wire-gap)", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: { actor: RustAuthorityActorUpsertInput }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
    };
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async ({ actor }) => ({
        tick: 24,
        actor: rustActorSnapshot({
          id: actor.id,
          label: actor.label ?? actor.id,
          role: actor.role ?? "player",
          areaId: actor.areaId,
          x: actor.x,
          y: actor.y,
          direction: actor.direction,
        }),
        inventory: [],
        reservations: [],
        timelineEvents: [],
        resourceSpawns: [],
        areaResourceSpawns: [],
        // Rust emits RAW (owner id + upkeep + verbs, is_owner false for the
        // god-config observer); the SHARD owns per-session privacy (DEF-9).
        placedParcels: [{
          parcelId: "parcel:player:1",
          ownerActorId: "player",
          planetId: "neon",
          areaId: "authority-test-overworld",
          name: "Homestead",
          rect: { x: 8, y: 8, w: 16, h: 16 },
          tier: "starter",
          buildZone: { x: 9, y: 9, w: 6, h: 6 },
          farmYard: { x: 15, y: 9, w: 8, h: 8 },
          isOwner: false,
          upkeepDueInGameDays: 7,
          tilledTiles: 3,
          plantedTiles: 1,
        }],
        farmPlots: [{
          parcelId: "parcel:player:1",
          ownerActorId: "player",
          areaId: "authority-test-overworld",
          tiles: [{
            cellX: 16,
            cellY: 10,
            tilled: true,
            moisturePct: 80,
            crop: {
              seedItemId: 6001,
              seedVariantId: 0,
              species: "tuber",
              stage: 4,
              stageCount: 5,
              health: "vigorous",
              blight: "none",
              timeToMatureGameDays: 0,
              qualitySoFarMilli: 620,
              footprintW: 1,
              footprintH: 1,
              mature: true,
            },
            legalVerbs: ["harvest", "clear"],
          }],
        }],
      }),
    };

    try {
      const ownerSocket = controlledSocket();
      shard.connect(ownerSocket, {
        actorId: "agri-probe",
        playerId: "local",
        displayName: "Agri Probe",
        zoneId: "authority-test",
        characterId: "agri-probe",
        ownerRef: "local",
        spawn: { areaId: "authority-test-overworld", x: 10, y: 12, facing: "right" },
      });
      await waitFor(() => ownerSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));

      const observerSocket = controlledSocket();
      shard.connect(observerSocket, {
        actorId: "agri-observer",
        playerId: "observer",
        displayName: "Observer",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 11, y: 12, facing: "right" },
      });
      await waitFor(() => observerSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));

      const ownerHello = packets(ownerSocket).find((packet) => packet.type === "game.hello");
      const observerHello = packets(observerSocket).find((packet) => packet.type === "game.hello");
      const ownerParcel = ownerHello?.snapshot.placedParcels?.[0];
      const observerParcel = observerHello?.snapshot.placedParcels?.[0];
      const ownerPlot = ownerHello?.snapshot.farmPlots?.[0];
      const observerPlot = observerHello?.snapshot.farmPlots?.[0];

      // Owner: isOwner recomputed across the claimed-placeholder boundary,
      // upkeep visible, raw ownerActorId never leaves the shard.
      expect(ownerParcel).toMatchObject({ parcelId: "parcel:player:1", isOwner: true, upkeepDueInGameDays: 7 });
      expect(ownerParcel).not.toHaveProperty("ownerActorId");
      expect(ownerPlot?.tiles?.[0]?.crop).toMatchObject({ species: "tuber", stage: 4, mature: true });
      expect(ownerPlot?.tiles?.[0]?.legalVerbs).toContain("harvest");
      expect(ownerPlot).not.toHaveProperty("ownerActorId");

      // Stranger: parcel boundary + crop render state VISIBLE (world objects),
      // upkeep finance private, tile actions blanked.
      expect(observerParcel).toMatchObject({ parcelId: "parcel:player:1", isOwner: false, tier: "starter", tilledTiles: 3, plantedTiles: 1 });
      expect(observerParcel).not.toHaveProperty("upkeepDueInGameDays");
      expect(observerParcel).not.toHaveProperty("ownerActorId");
      expect(observerPlot?.tiles?.[0]?.crop).toMatchObject({ species: "tuber", stage: 4, mature: true });
      expect(observerPlot?.tiles?.[0]?.legalVerbs).toEqual([]);
      expect(observerPlot).not.toHaveProperty("ownerActorId");

      // Debug oracle (unauthenticated, CORS *): STRANGER shape exactly (day-2 P1-4).
      const oracle = await shard.debugOracle({ refreshAiDebug: false });
      const oracleParcel = oracle.placedParcels?.[0];
      const oraclePlot = oracle.farmPlots?.[0];
      expect(oracleParcel).toMatchObject({ parcelId: "parcel:player:1", isOwner: false });
      expect(oracleParcel).not.toHaveProperty("upkeepDueInGameDays");
      expect(oracleParcel).not.toHaveProperty("ownerActorId");
      expect(oraclePlot?.tiles?.[0]?.crop).toMatchObject({ mature: true });
      expect(oraclePlot?.tiles?.[0]?.legalVerbs).toEqual([]);
    } finally {
      shard.close();
    }
  });

  it("maps the container actor prefix across the claimed-placeholder boundary for every rust-path container command (DEF-9b gate)", () => {
    // Every command whose manifest/zod carries a `container` field MUST map that
    // container's actor prefix across the claimed-placeholder boundary before the
    // rust bridge — else find_actor_stack_exact misses ('ts:pack' vs rust
    // 'player:pack') → item_unavailable (TuiFable's DEF-9b repro). This table is
    // DERIVED from the manifest, so a NEW container command fails here by default
    // until it is armed (TakeLootItem pattern) or explicitly exempted.
    const manifestPath = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../tools/codegen/generated/successor.commands.manifest.v1.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      commands: Array<{ kind: string; debugGated?: boolean; args: Array<{ name: string }> }>;
    };
    // Documented exemptions: `container` fields that are NOT claimed-placeholder
    // inventory refs and therefore need no rust-actor mapping.
    const CONTAINER_EXEMPT = new Set<string>([
      // UseTravelTicket.container is a fixed travel-ticket item ref, not an
      // actor-prefixed inventory container.
      "UseTravelTicket",
    ]);
    const containerCommands = manifest.commands.filter(
      (command) => !command.debugGated && command.args.some((arg) => arg.name === "container"),
    );
    expect(containerCommands.length).toBeGreaterThan(0);

    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: { close: () => void };
      claimedAuthoredPlaceholders: Map<string, string>;
      rustEnvelopeForCommand: (envelope: ClientCommandEnvelope) => ClientCommandEnvelope;
    };
    internals.rustAuthorityBridge?.close();
    internals.claimedAuthoredPlaceholders.set("ts-actor", "player");
    try {
      const unarmed: string[] = [];
      let armed = 0;
      for (const command of containerCommands) {
        if (CONTAINER_EXEMPT.has(command.kind)) continue;
        const env = envelope(1, { [command.kind]: { container: "ts-actor:field-pack" } } as unknown as ClientCommandEnvelope["command"]);
        const mapped = internals.rustEnvelopeForCommand(env);
        const mappedContainer = (mapped.command as Record<string, { container?: string }>)[command.kind]?.container;
        if (mappedContainer === "player:field-pack") armed += 1;
        else unarmed.push(`${command.kind}: container="${mappedContainer ?? "<undefined>"}" (expected rust prefix "player:field-pack")`);
      }
      expect(armed).toBeGreaterThan(0);
      expect(
        unarmed,
        `container commands missing a rustEnvelopeForCommand mapping arm — arm them (TakeLootItem pattern) or add to CONTAINER_EXEMPT:\n${unarmed.join("\n")}`,
      ).toEqual([]);
    } finally {
      shard.close();
    }
  });

  it("maps every production target_actor_id across the claimed-placeholder boundary", () => {
    const manifestPath = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../tools/codegen/generated/successor.commands.manifest.v1.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      commands: Array<{ kind: string; debugGated?: boolean; args: Array<{ name: string }> }>;
    };
    const actorTargetCommands = manifest.commands.filter(
      (command) => !command.debugGated && command.args.some((arg) => arg.name === "target_actor_id"),
    );
    expect(actorTargetCommands.length).toBeGreaterThan(0);

    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: { close: () => void };
      claimedAuthoredPlaceholders: Map<string, string>;
      rustEnvelopeForCommand: (envelope: ClientCommandEnvelope) => ClientCommandEnvelope;
    };
    internals.rustAuthorityBridge?.close();
    internals.claimedAuthoredPlaceholders.set("ts-actor", "player");
    try {
      for (const command of actorTargetCommands) {
        const input = envelope(1, {
          [command.kind]: { target_actor_id: "ts-actor" },
        } as unknown as ClientCommandEnvelope["command"]);
        const mapped = internals.rustEnvelopeForCommand(input);
        const targetActorId = (
          mapped.command as Record<string, { target_actor_id?: string }>
        )[command.kind]?.target_actor_id;
        expect(targetActorId, command.kind).toBe("player");
      }
    } finally {
      shard.close();
    }
  });

  it("translates claimed actor stack command containers back to Rust", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: unknown) => Promise<unknown>;
        submitCommand?: (input: { actorId: string; envelope: ClientCommandEnvelope }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
      inventory: Array<{ container: string; itemId: number; variantId: number; quantity: number; available: number }>;
    };
    const submittedEnvelopes: ClientCommandEnvelope[] = [];
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async () => ({}),
      submitCommand: async ({ envelope }) => {
        submittedEnvelopes.push(envelope);
        const command = envelope.command;
        const container = "SplitStack" in command
          ? command.SplitStack.container
          : "MergeStacks" in command
            ? command.MergeStacks.container
            : "";
        const accepted = container === "player:resource-crate";
        return {
          status: accepted ? "accepted" : "rejected",
          reasonCode: accepted ? null : "item_unavailable",
          tick: 42,
          commandId: envelope.command_id,
          actors: [],
          combatEvents: [],
          inventory: accepted ? [
            {
              stackId: 1,
              container: "player:resource-crate",
              item: "Iron Resource Container",
              itemId: 2001,
              variantId: 17,
              quantity: 6,
              reserved: 0,
              available: 6,
            },
            {
              stackId: 2,
              container: "player:resource-crate",
              item: "Iron Resource Container",
              itemId: 2001,
              variantId: 17,
              quantity: 4,
              reserved: 0,
              available: 4,
            },
          ] : [],
          reservations: [],
          npcJobs: [],
          timelineEvents: [],
        };
      },
    };
    try {
      shard.connect(fakeSocket(), {
        actorId: "agent-survey-probe",
        playerId: "agent-survey-probe",
        displayName: "Agent Survey Probe",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 37, y: 21, facing: "right" },
      });

      const result = await shard.submitDebugAuthorityCommand("agent-survey-probe", {
        SplitStack: {
          container: "agent-survey-probe:resource-crate",
          stack_id: "1",
          item_id: 2001,
          variant_id: 17,
          quantity: 4,
        },
      });

      expect(result.receipt.accepted).toBe(true);
      expect(submittedEnvelopes[0]?.command).toMatchObject({
        SplitStack: {
          container: "player:resource-crate",
          stack_id: "1",
          item_id: 2001,
          variant_id: 17,
          quantity: 4,
        },
      });
      const mergeResult = await shard.submitDebugAuthorityCommand("agent-survey-probe", {
        MergeStacks: {
          container: "agent-survey-probe:resource-crate",
          source_stack_id: "2",
          target_stack_id: "1",
        },
      });

      expect(mergeResult.receipt.accepted).toBe(true);
      expect(submittedEnvelopes[1]?.command).toMatchObject({
        MergeStacks: {
          container: "player:resource-crate",
          source_stack_id: "2",
          target_stack_id: "1",
        },
      });
      expect(internals.inventory.filter((row) => row.container === "agent-survey-probe:resource-crate")).toEqual([
        expect.objectContaining({ itemId: 2001, variantId: 17, quantity: 6, available: 6 }),
        expect.objectContaining({ itemId: 2001, variantId: 17, quantity: 4, available: 4 }),
      ]);
    } finally {
      shard.close();
    }
  });

  it("translates claimed actor roll queue targets back to Rust", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: unknown) => Promise<unknown>;
        submitCommand?: (input: { actorId: string; envelope: ClientCommandEnvelope }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
    };
    const submittedEnvelopes: ClientCommandEnvelope[] = [];
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async () => ({}),
      submitCommand: async ({ envelope }) => {
        submittedEnvelopes.push(envelope);
        const command = envelope.command;
        const targetActorId = "QueueCombatAction" in command ? command.QueueCombatAction.target_actor_id : "";
        return {
          status: targetActorId === "player" ? "accepted" : "rejected",
          reasonCode: targetActorId === "player" ? null : "unknown_target",
          tick: 42,
          commandId: envelope.command_id,
          actors: [],
          combatEvents: [],
          inventory: [],
          reservations: [],
          npcJobs: [],
          timelineEvents: [],
        };
      },
    };
    try {
      shard.connect(fakeSocket(), {
        actorId: "agent-roll-probe",
        playerId: "agent-roll-probe",
        displayName: "Agent Roll Probe",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 37, y: 21, facing: "right" },
      });

      const result = await shard.submitDebugAuthorityCommand("agent-roll-probe", {
        QueueCombatAction: {
          action_id: "basic_shot",
          target_actor_id: "agent-roll-probe",
        },
      });

      expect(result.receipt.accepted).toBe(true);
      expect(submittedEnvelopes[0]?.command).toMatchObject({
        QueueCombatAction: {
          action_id: "basic_shot",
          target_actor_id: "player",
        },
      });
    } finally {
      shard.close();
    }
  });

  it("maps ProposeTrade partner + tradeSession delivery across the claimed-placeholder boundary (DEF-3)", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: unknown) => Promise<unknown>;
        submitCommand?: (input: { actorId: string; envelope: ClientCommandEnvelope }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
    };
    const submittedEnvelopes: ClientCommandEnvelope[] = [];
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async () => ({}),
      submitCommand: async ({ envelope }) => {
        submittedEnvelopes.push(envelope);
        const command = envelope.command;
        // The rust sim only knows the partner under its placeholder id ("player").
        const partner = "ProposeTrade" in command ? command.ProposeTrade.partner_actor_id : "";
        const accepted = partner === "player";
        // Deliveries carry RUST ids; the shard must map them back to TS for routing + FE.
        const tradeSessionDeliveries = accepted
          ? [{
              actorId: "player",
              session: {
                proposalId: 1,
                partnerActorId: "trade-def3-proposer",
                mine: { actorId: "player", items: [], coin: 0, locked: false, confirmed: false },
                theirs: { actorId: "trade-def3-proposer", items: [], coin: 0, locked: false, confirmed: false },
                bothLocked: false,
                stage: "negotiating",
                tick: 7,
              },
            }]
          : [];
        return {
          status: accepted ? "accepted" : "rejected",
          reasonCode: accepted ? null : "target_unavailable",
          tick: 7,
          commandId: envelope.command_id,
          actors: [],
          combatEvents: [],
          inventory: [],
          reservations: [],
          npcJobs: [],
          timelineEvents: [],
          tradeSessionDeliveries,
        };
      },
    };
    try {
      // Partner joins first and claims the authored "player" placeholder; its TS id
      // (trade-def3-partner) is what the rust sim never sees.
      const partnerSocket = tradeMessageSocket();
      shard.connect(partnerSocket, {
        actorId: "trade-def3-partner",
        playerId: "trade-def3-partner",
        displayName: "Trade DEF3 Partner",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 37, y: 21, facing: "right" },
      });
      // Proposer joins second (placeholder taken) so it keeps its own id.
      shard.connect(fakeSocket(), {
        actorId: "trade-def3-proposer",
        playerId: "trade-def3-proposer",
        displayName: "Trade DEF3 Proposer",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 38, y: 21, facing: "right" },
      });

      const result = await shard.submitDebugAuthorityCommand("trade-def3-proposer", {
        ProposeTrade: { partner_actor_id: "trade-def3-partner", offer: [], request: [] },
      });

      // FORWARD: partner_actor_id was mapped TS -> rust placeholder, so the propose is
      // accepted instead of rejected target_unavailable (the DEF-3 bug).
      expect(result.receipt.accepted).toBe(true);
      expect(submittedEnvelopes[0]?.command).toMatchObject({
        ProposeTrade: { partner_actor_id: "player" },
      });

      // REVERSE: the delivery keyed on rust "player" reached the partner's TS session,
      // and the VM's actor ids were mapped back to TS ids for the FE.
      const tradeMsg = partnerSocket.messages.find((m) => m.type === "tradeSession");
      expect(tradeMsg).toBeDefined();
      const vm = tradeMsg!.payload as {
        mine: { actorId: string };
        theirs: { actorId: string };
        partnerActorId: string;
      };
      expect(vm.mine.actorId).toBe("trade-def3-partner");
      expect(vm.theirs.actorId).toBe("trade-def3-proposer");
      expect(vm.partnerActorId).toBe("trade-def3-proposer");
    } finally {
      shard.close();
    }
  });

  it("replays an active trade session to a replacement participant session without exposing it to strangers", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: unknown) => Promise<unknown>;
        submitCommand?: (input: { actorId: string; envelope: ClientCommandEnvelope }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
    };
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async () => ({}),
      submitCommand: async ({ envelope }) => {
        const proposerId = "trade-reconnect-proposer";
        const partnerId = "trade-reconnect-partner";
        const deliveries = "ProposeTrade" in envelope.command
          ? [
              {
                actorId: proposerId,
                session: {
                  proposalId: 41,
                  partnerActorId: partnerId,
                  mine: { actorId: proposerId, items: [], coin: 3, locked: false, confirmed: false },
                  theirs: { actorId: partnerId, items: [], coin: 0, locked: false, confirmed: false },
                  bothLocked: false,
                  stage: "negotiating" as const,
                  tick: 9,
                },
              },
              {
                actorId: partnerId,
                session: {
                  proposalId: 41,
                  partnerActorId: proposerId,
                  mine: { actorId: partnerId, items: [], coin: 0, locked: false, confirmed: false },
                  theirs: { actorId: proposerId, items: [], coin: 3, locked: false, confirmed: false },
                  bothLocked: false,
                  stage: "negotiating" as const,
                  tick: 9,
                },
              },
            ]
          : [];
        return {
          status: "accepted",
          reasonCode: null,
          tick: 9,
          commandId: envelope.command_id,
          actors: [],
          combatEvents: [],
          inventory: [],
          reservations: [],
          npcJobs: [],
          timelineEvents: [],
          tradeSessionDeliveries: deliveries,
        };
      },
    };
    try {
      const proposerSocket = tradeMessageSocket();
      shard.connect(proposerSocket, {
        actorId: "trade-reconnect-proposer",
        playerId: "trade-reconnect-proposer",
        displayName: "Trade Reconnect Proposer",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 37, y: 21, facing: "right" },
      });
      const partnerSocket = tradeMessageSocket();
      const partnerIdentity = {
        actorId: "trade-reconnect-partner",
        playerId: "trade-reconnect-partner",
        displayName: "Trade Reconnect Partner",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 38, y: 21, facing: "right" as const },
        characterId: "trade-reconnect-partner",
      };
      shard.connect(partnerSocket, partnerIdentity);

      const result = await shard.submitDebugAuthorityCommand("trade-reconnect-proposer", {
        ProposeTrade: { partner_actor_id: partnerIdentity.actorId, offer: [], request: [] },
      });
      expect(result.receipt.accepted).toBe(true);
      expect(partnerSocket.messages).toHaveLength(1);
      expect(partnerSocket.messages[0]).toMatchObject({
        type: "tradeSession",
        payload: {
          proposalId: 41,
          stage: "negotiating",
          partnerActorId: "trade-reconnect-proposer",
        },
      });

      const replacementSocket = tradeMessageSocket();
      shard.connect(replacementSocket, partnerIdentity);
      expect(replacementSocket.messages).toHaveLength(1);
      expect(replacementSocket.messages[0]).toMatchObject({
        type: "tradeSession",
        payload: {
          proposalId: 41,
          stage: "negotiating",
          partnerActorId: "trade-reconnect-proposer",
        },
      });

      const strangerSocket = tradeMessageSocket();
      shard.connect(strangerSocket, {
        actorId: "trade-reconnect-stranger",
        playerId: "trade-reconnect-stranger",
        displayName: "Trade Reconnect Stranger",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 39, y: 21, facing: "right" },
      });
      expect(strangerSocket.messages).toHaveLength(0);
    } finally {
      shard.close();
    }
  });

  it("maps DuelChallenge target across the claimed-placeholder boundary", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: unknown) => Promise<unknown>;
        submitCommand?: (input: { actorId: string; envelope: ClientCommandEnvelope }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
    };
    const submittedEnvelopes: ClientCommandEnvelope[] = [];
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async () => ({}),
      submitCommand: async ({ envelope }) => {
        submittedEnvelopes.push(envelope);
        const command = envelope.command;
        // The rust sim only knows the challenged player under its placeholder id ("player").
        const target = "DuelChallenge" in command ? command.DuelChallenge.target_actor_id : "";
        const accepted = target === "player";
        return {
          status: accepted ? "accepted" : "rejected",
          reasonCode: accepted ? null : "unknown_actor",
          tick: 7,
          commandId: envelope.command_id,
          actors: [],
          combatEvents: [],
          inventory: [],
          reservations: [],
          npcJobs: [],
          timelineEvents: [],
        };
      },
    };
    try {
      // The challenged player joins first and claims the authored "player" placeholder;
      // its TS id (duel-target) is what the rust sim never sees.
      shard.connect(fakeSocket(), {
        actorId: "duel-target",
        playerId: "duel-target",
        displayName: "Duel Target",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 37, y: 21, facing: "right" },
      });
      // The challenger joins second (placeholder taken) so it keeps its own id.
      shard.connect(fakeSocket(), {
        actorId: "duel-challenger",
        playerId: "duel-challenger",
        displayName: "Duel Challenger",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 38, y: 21, facing: "right" },
      });

      const result = await shard.submitDebugAuthorityCommand("duel-challenger", {
        DuelChallenge: { target_actor_id: "duel-target" },
      });

      // target_actor_id was mapped TS -> rust placeholder ("player"), so the challenge is
      // accepted instead of rejected unknown_actor (the claimed-placeholder bug class).
      expect(result.receipt.accepted).toBe(true);
      expect(submittedEnvelopes[0]?.command).toMatchObject({
        DuelChallenge: { target_actor_id: "player" },
      });
    } finally {
      shard.close();
    }
  });

  it("forwards rust duel view + outcome through the shard to the session (wire-gap #2)", async () => {
    // The GPT-5.5 finding: rust emits duelViewsByActorId + duelOutcomes but the TS
    // layer dropped them, so real sessions never learned duel state or results. This
    // asserts the forwarding: the returned delta carries the duel VIEW, and the session
    // socket RECEIVES the one-shot duelOutcome message.
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: unknown) => Promise<unknown>;
        submitCommand?: (input: { actorId: string; envelope: ClientCommandEnvelope }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
    };
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async () => ({}),
      submitCommand: async ({ envelope }) => ({
        status: "accepted",
        reasonCode: null,
        tick: 9,
        commandId: envelope.command_id,
        actors: [],
        combatEvents: [],
        inventory: [],
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
        // The rust sim keys the session's actor under the claimed "player" placeholder.
        duelViewsByActorId: {
          player: {
            activeDuel: { duelId: 1, opponentActorId: "rival", opponentName: "Rival", startedTick: 9, expiresTick: 9009 },
          },
        },
        duelOutcomes: [
          { actorId: "player", duelId: 1, opponentActorId: "rival", opponentName: "Rival", result: "won", reason: "yield", tick: 9 },
        ],
      }),
    };
    try {
      const socket = tradeMessageSocket();
      shard.connect(socket, {
        actorId: "duel-viewer",
        playerId: "duel-viewer",
        displayName: "Duel Viewer",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 37, y: 21, facing: "right" },
      });

      // The command is just the trigger; the mocked bridge returns the duel output regardless.
      const result = await shard.submitDebugAuthorityCommand("duel-viewer", { DuelChallenge: { target_actor_id: "rival" } });

      // VIEW forwarded: the delta carries the duel view (opponent id mapped rust -> TS).
      expect(result.delta.duels?.activeDuel?.opponentActorId).toBe("rival");
      expect(result.delta.duels?.activeDuel?.duelId).toBe(1);
      // OUTCOME forwarded: the session RECEIVED the one-shot duelOutcome message.
      const outcomeMsg = socket.messages.find((m) => m.type === "duelOutcome");
      expect(outcomeMsg).toBeDefined();
      const outcome = outcomeMsg!.payload as { actorId: string; result: string; reason: string; opponentName: string };
      expect(outcome).toMatchObject({ actorId: "duel-viewer", result: "won", reason: "yield", opponentName: "Rival" });
    } finally {
      shard.close();
    }
  });

  it("surfaces target_protected to the session when shooting a protected civilian (DEF-10)", async () => {
    // DEF-10: the sim rejects basic_shot on a non-combat civilian (trainer/vendor)
    // with target_protected; assert the shard surfaces that honest reject to the client.
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: unknown) => Promise<unknown>;
        submitCommand?: (input: { actorId: string; envelope: ClientCommandEnvelope }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
    };
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async () => ({}),
      submitCommand: async ({ envelope }) => {
        const rejectedCivilian = "QueueCombatAction" in envelope.command;
        return {
          status: rejectedCivilian ? "rejected" : "accepted",
          reasonCode: rejectedCivilian ? "target_protected" : null,
          tick: 5,
          commandId: envelope.command_id,
          actors: [],
          combatEvents: [],
          inventory: [],
          reservations: [],
          npcJobs: [],
          timelineEvents: [],
        };
      },
    };
    try {
      shard.connect(fakeSocket(), {
        actorId: "civ-shooter",
        playerId: "civ-shooter",
        displayName: "Civ Shooter",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 37, y: 21, facing: "right" },
      });
      const result = await shard.submitDebugAuthorityCommand("civ-shooter", {
        QueueCombatAction: { action_id: "basic_shot", target_actor_id: "profession-trainer-01" },
      });
      expect(result.receipt.accepted).toBe(false);
      expect(result.receipt.reasonCode).toBe("target_protected");
    } finally {
      shard.close();
    }
  });

  it("serializes roll combat queue, in-combat, and ranged-roll events through compact packets", async () => {
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: unknown) => Promise<unknown>;
        submitCommand?: (input: { actorId: string; envelope: ClientCommandEnvelope }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
    };
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async () => ({}),
      submitCommand: async ({ envelope }) => ({
        status: "accepted",
        reasonCode: null,
        tick: 77,
        commandId: envelope.command_id,
        actors: [
          rustActorSnapshot({
            id: "player",
            combatQueue: {
              nextReadyTick: 91,
              entries: [{ actionId: "aimed_shot", targetActorId: "skirmish-1", auto: true }],
            },
            abilityQueue: {
              actorId: "player",
              nextReadyTick: 91,
              entries: [{
                id: "q2",
                abilityId: "aimed_shot",
                iconId: "aimed_shot",
                class: "combat",
                targetActorId: "skirmish-1",
                lifecycle: "pending",
                enqueuedAtTick: 76,
                readyTick: 91,
              }],
              repeatIntent: {
                id: "q1",
                abilityId: "basic_shot",
                iconId: "basic_shot",
                class: "combat",
                targetActorId: "skirmish-1",
                lifecycle: "pending",
                enqueuedAtTick: 75,
                readyTick: 91,
                fireSeq: 1,
              },
            },
            inCombat: true,
            peaceRequested: true,
            cloneSicknessTicks: 45,
          }),
          rustActorSnapshot({
            id: "skirmish-1",
            label: "Skirmisher",
            role: "npc",
            x: 14,
            y: 10,
            vitals: { health: 88, action: 100, spirit: 100 },
          }),
        ],
        combatEvents: [{
          kind: "ranged_roll",
          id: 7,
          commandId: envelope.command_id,
          tick: 77,
          shooterActorId: "player",
          attackerActorId: "player",
          targetActorId: "skirmish-1",
          actionId: "aimed_shot",
          hit: true,
          damage: 12,
          pool: "health",
          rollMilli: 321,
          toHitMilli: 650,
          originX: 10,
          originY: 10,
          hitX: 14,
          hitY: 10,
          previousLifeState: "alive",
          lifeState: "alive",
          targetLifecycleSeq: 1,
          bleedStackCount: 0,
          lifecycle: "hit",
          zone: "torso",
          weaponId: "slugthrower",
          ammoType: "slug_iron",
          lifecycleCause: "ranged roll hit",
        }],
        abilityQueueEvents: [{
          actorId: "player",
          id: "q2",
          lifecycle: "fired",
          tick: 77,
          abilityId: "aimed_shot",
          iconId: "aimed_shot",
          fireSeq: 1,
        }],
        inventory: [],
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
      }),
    };
    const socket = controlledSocket();
    try {
      shard.connect(socket, {
        actorId: "agent-roll-wire",
        playerId: "agent-roll-wire",
        displayName: "Agent Roll Wire",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 10, y: 10, facing: "right" },
      });
      await waitFor(() => packets(socket).some((packet) => packet.type === "game.hello"));
      socket.sent.length = 0;

      socket.emitMessage(JSON.stringify({
        type: "game.command",
        envelope: {
          session: 1,
          player: 1,
          command_id: 1,
          issued_at_tick: 0,
          command: {
            QueueCombatAction: {
              action_id: "aimed_shot",
              target_actor_id: "skirmish-1",
            },
          },
        },
      }));

      await waitFor(() => packets(socket).some((packet) => packet.type === "game.delta"));
      const packet = packets(socket).find((candidate) => candidate.type === "game.delta")!;
      const actor = deltaActor(packet.delta, "agent-roll-wire");
      const patch = deltaActorDetail(packet.delta, "agent-roll-wire");
      expect(actor?.combatQueue ?? patch?.combatQueue).toEqual({
        nextReadyTick: 91,
        entries: [{ actionId: "aimed_shot", targetActorId: "skirmish-1", auto: true }],
      });
      expect(actor?.inCombat ?? patch?.inCombat).toBe(true);
      expect(actor?.cloneSicknessRemainingMs ?? patch?.cloneSicknessRemainingMs).toBe(1500);
      expect(actor?.peaceRequested ?? patch?.peaceRequested).toBe(true);
      expect(packet.delta.abilityQueue).toEqual({
        actorId: "agent-roll-wire",
        nextReadyTick: 91,
        entries: [{
          id: "q2",
          abilityId: "aimed_shot",
          iconId: "aimed_shot",
          class: "combat",
          targetActorId: "skirmish-1",
          lifecycle: "pending",
          enqueuedAtTick: 76,
          readyTick: 91,
        }],
        repeatIntent: {
          id: "q1",
          abilityId: "basic_shot",
          iconId: "basic_shot",
          class: "combat",
          targetActorId: "skirmish-1",
          lifecycle: "pending",
          enqueuedAtTick: 75,
          readyTick: 91,
          fireSeq: 1,
        },
      });
      expect(packet.abilityQueueEvents).toEqual([{
        id: "q2",
        lifecycle: "fired",
        tick: 77,
        abilityId: "aimed_shot",
        iconId: "aimed_shot",
        fireSeq: 1,
      }]);
      expect(packet.events).toEqual([]);
      const event = packetEvents(packet)[0];
      expect(event).toMatchObject({
        kind: "ranged_roll",
        shooterActorId: "agent-roll-wire",
        attackerActorId: "agent-roll-wire",
        targetActorId: "skirmish-1",
        actionId: "aimed_shot",
        hit: true,
        damage: 12,
        pool: "health",
        rollMilli: 321,
        toHitMilli: 650,
      });
    } finally {
      shard.close();
    }
  });

  it("redacts legacy combat queues from non-owners with a single null transition patch", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const internals = shard as unknown as {
        actors: Map<string, { combatQueue?: unknown }>;
        deltaForSession: (
          session: {
            id: string;
            actorId: string;
            socket: ReturnType<typeof controlledSocket>;
            connectedAt: string;
            connectedAtMs: number;
            seenCommands: Set<number>;
            ingressBudgets: Map<string, unknown>;
            lastSnapshotTick: number;
            lastActorDeltaTick: number;
            pendingReceipts: unknown[];
            pendingEvents: unknown[];
            pendingAbilityQueueEvents: unknown[];
            lastCombatEventDeltaTick: number;
            deferredDirtyActorIds: Set<string>;
            knownActorIds: Set<string>;
            knownActorSnapshots: Map<string, GameActorSnapshot>;
            needsFullSnapshot: boolean;
            viewInterest: null;
            interestDirty: boolean;
          },
          focusActorIds: string[],
          options?: { includeActorRemovals?: boolean },
        ) => GameShardDelta;
      };
      const previousVendor = {
        ...shard.snapshotFor("player").actors.vendor!,
        combatQueue: {
          nextReadyTick: 42,
          entries: [{ actionId: "basic_shot" as const, targetActorId: "player", auto: true }],
        },
      };
      const nonOwnerSession = privateDeltaSession("observer", "player", previousVendor);

      const firstDelta = internals.deltaForSession(nonOwnerSession, ["vendor"], { includeActorRemovals: false });
      expect(firstDelta.actorPatches?.vendor?.combatQueue).toBeNull();
      expect(deltaActor(firstDelta, "vendor")?.combatQueue).toBeUndefined();

      const secondDelta = internals.deltaForSession(nonOwnerSession, ["vendor"], { includeActorRemovals: false });
      expect(deltaActor(secondDelta, "vendor")).toBeUndefined();
      expect(secondDelta.actorPatches?.vendor?.combatQueue).toBeUndefined();
      expect(secondDelta.compactActorPatches?.some(([actorId]) => actorId === "vendor")).not.toBe(true);

      const ownerQueue = {
        nextReadyTick: 77,
        entries: [{ actionId: "basic_shot" as const, targetActorId: "vendor" }],
      };
      const player = internals.actors.get("player");
      expect(player).toBeDefined();
      player!.combatQueue = ownerQueue;
      const previousPlayer = { ...shard.snapshotFor("player").actors.player! };
      delete previousPlayer.combatQueue;
      const ownerSession = privateDeltaSession("owner", "player", previousPlayer);
      const ownerDelta = internals.deltaForSession(ownerSession, ["player"], { includeActorRemovals: false });
      expect(deltaActorDetail(ownerDelta, "player")?.combatQueue).toEqual(ownerQueue);
    } finally {
      shard.close();
    }
  });

  it("applies per-session ingress budgets before Rust command submit", async () => {
    let nowMs = 1_000;
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      ingressBudget: {
        capacity: 2,
        refillPerSecond: 1,
        nowMs: () => nowMs,
      },
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      lastRustAuthorityStateHash?: string;
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: unknown) => Promise<unknown>;
        submitCommand?: (input: { envelope: ClientCommandEnvelope }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
    };
    const submittedEnvelopes: ClientCommandEnvelope[] = [];
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async () => ({}),
      submitCommand: async ({ envelope }) => {
        submittedEnvelopes.push(envelope);
        return {
          status: "accepted",
          reasonCode: null,
          tick: 77,
          commandId: envelope.command_id,
          targetStateHash: `hash-${envelope.command_id}`,
          actors: [],
          combatEvents: [],
          inventory: [],
          reservations: [],
          npcJobs: [],
          timelineEvents: [],
        };
      },
    };
    const socket = controlledSocket();
    const commandDeltas = () => packets(socket).filter((packet) => packet.type === "game.delta");
    const sendQueueCommand = async (commandId: number): Promise<void> => {
      socket.emitMessage(JSON.stringify({
        type: "game.command",
        envelope: envelope(commandId, {
          QueueCombatAction: {
            action_id: "aimed_shot",
            target_actor_id: "skirmish-1",
          },
        }),
      }));
      await waitFor(() => commandDeltas().length >= commandId);
    };
    try {
      shard.connect(socket, {
        actorId: "ingress-budget-player",
        playerId: "ingress-budget-player",
        displayName: "Ingress Budget Player",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 10, y: 10, facing: "right" },
      });
      await waitFor(() => packets(socket).some((packet) => packet.type === "game.hello"));
      socket.sent.length = 0;

      await sendQueueCommand(1);
      await sendQueueCommand(2);
      const hashAfterAdmittedBurst = internals.lastRustAuthorityStateHash;
      await sendQueueCommand(3);

      expect(commandDeltas()[0]?.receipts?.[0]).toMatchObject({ commandId: 1, accepted: true });
      expect(commandDeltas()[1]?.receipts?.[0]).toMatchObject({ commandId: 2, accepted: true });
      expect(commandDeltas()[2]?.receipts?.[0]).toMatchObject({
        commandId: 3,
        accepted: false,
        reasonCode: "ingress_budget_exhausted",
      });
      expect(submittedEnvelopes.map((submitted) => submitted.command_id)).toEqual([1, 2]);
      expect(internals.lastRustAuthorityStateHash).toBe(hashAfterAdmittedBurst);
      expect(shard.status().recentRejections.at(-1)).toMatchObject({
        actorId: "ingress-budget-player",
        kind: "QueueCombatAction",
        reasonCode: "ingress_budget_exhausted",
      });

      nowMs += 1_000;
      await sendQueueCommand(4);

      expect(commandDeltas()[3]?.receipts?.[0]).toMatchObject({ commandId: 4, accepted: true });
      expect(submittedEnvelopes.map((submitted) => submitted.command_id)).toEqual([1, 2, 4]);
      expect(shard.status().counters).toMatchObject({ acceptedCommands: 3, rejectedCommands: 1 });
    } finally {
      shard.close();
    }
  });

  it("submits admitted queue commands to Rust so queue_full rejects inside the sim gate", async () => {
    const submittedEnvelopes: ClientCommandEnvelope[] = [];
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      ingressBudget: {
        capacity: 10,
        refillPerSecond: 0,
      },
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: unknown) => Promise<unknown>;
        submitCommand?: (input: { envelope: ClientCommandEnvelope }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
    };
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async () => ({}),
      submitCommand: async ({ envelope }) => {
        submittedEnvelopes.push(envelope);
        return {
          status: "rejected",
          reasonCode: "queue_full",
          tick: 77,
          commandId: envelope.command_id,
          actors: [],
          combatEvents: [],
          inventory: [],
          reservations: [],
          npcJobs: [],
          timelineEvents: [],
        };
      },
    };
    const socket = controlledSocket();
    try {
      shard.connect(socket, {
        actorId: "queue-full-player",
        playerId: "queue-full-player",
        displayName: "Queue Full Player",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 10, y: 10, facing: "right" },
      });
      await waitFor(() => packets(socket).some((packet) => packet.type === "game.hello"));
      socket.sent.length = 0;
      socket.emitMessage(JSON.stringify({
        type: "game.command",
        envelope: envelope(1, {
          QueueCombatAction: {
            action_id: "aimed_shot",
            target_actor_id: "skirmish-1",
          },
        }),
      }));

      await waitFor(() => packets(socket).some((packet) => packet.type === "game.delta"));
      const packet = packets(socket).find((candidate) => candidate.type === "game.delta")!;
      expect(submittedEnvelopes.map((submitted) => submitted.command_id)).toEqual([1]);
      expect(packet.receipts?.[0]).toMatchObject({
        commandId: 1,
        accepted: false,
        reasonCode: "queue_full",
      });
      expect(shard.status().recentRejections.at(-1)).toMatchObject({
        actorId: "queue-full-player",
        kind: "QueueCombatAction",
        reasonCode: "queue_full",
      });
      expect(shard.status().counters).toMatchObject({ acceptedCommands: 0, rejectedCommands: 1 });
    } finally {
      shard.close();
    }
  });

  it("isolates GAME-configured ingress budgets by session and command kind", async () => {
    const originalCapacity = process.env.GAME_INGRESS_BUDGET_CAPACITY;
    const originalRefill = process.env.GAME_INGRESS_BUDGET_REFILL_PER_SECOND;
    process.env.GAME_INGRESS_BUDGET_CAPACITY = "1";
    process.env.GAME_INGRESS_BUDGET_REFILL_PER_SECOND = "0";
    let shard: GameShard | null = null;
    try {
      shard = new GameShard({
        slicePath,
        snapshotIntervalMs: 10_000,
        rustAuthorityBridge: {
          enabled: true,
          command: process.execPath,
          args: ["-e", "process.stdin.resume();"],
        },
      });
      const internals = shard as unknown as {
        rustAuthorityBridge?: {
          close: () => void;
          submitActor?: (input: unknown) => Promise<unknown>;
          submitCommand?: (input: { actorId: string; envelope: ClientCommandEnvelope }) => Promise<unknown>;
          debugStatus?: () => unknown;
        };
      };
      const submitted: Array<{ actorId: string; commandId: number; kind: string }> = [];
      internals.rustAuthorityBridge?.close();
      internals.rustAuthorityBridge = {
        close: () => {},
        debugStatus: () => null,
        submitActor: async () => ({}),
        submitCommand: async ({ actorId, envelope }) => {
          submitted.push({
            actorId,
            commandId: envelope.command_id,
            kind: gameShardInternalsForTest.commandKind(envelope.command),
          });
          return {
            status: "accepted",
            reasonCode: null,
            tick: 77,
            commandId: envelope.command_id,
            targetStateHash: `${actorId}-${envelope.command_id}`,
            actors: [],
            combatEvents: [],
            inventory: [],
            reservations: [],
            npcJobs: [],
            timelineEvents: [],
          };
        },
      };
      const firstSocket = controlledSocket();
      const secondSocket = controlledSocket();
      const commandDeltas = (socket: { sent: string[] }) => packets(socket).filter((packet) => packet.type === "game.delta");
      const sendCommand = async (
        socket: ReturnType<typeof controlledSocket>,
        commandId: number,
        command: ClientCommandEnvelope["command"],
        expectedDeltaCount: number,
      ): Promise<void> => {
        socket.emitMessage(JSON.stringify({ type: "game.command", envelope: envelope(commandId, command) }));
        await waitFor(() => commandDeltas(socket).length >= expectedDeltaCount);
      };
      shard.connect(firstSocket, {
        actorId: "budget-session-a",
        playerId: "budget-session-a",
        displayName: "Budget Session A",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 10, y: 10, facing: "right" },
      });
      shard.connect(secondSocket, {
        actorId: "budget-session-b",
        playerId: "budget-session-b",
        displayName: "Budget Session B",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 11, y: 10, facing: "right" },
      });
      await waitFor(() => packets(firstSocket).some((packet) => packet.type === "game.hello"));
      await waitFor(() => packets(secondSocket).some((packet) => packet.type === "game.hello"));
      firstSocket.sent.length = 0;
      secondSocket.sent.length = 0;

      await sendCommand(firstSocket, 1, {
        QueueCombatAction: { action_id: "aimed_shot", target_actor_id: "skirmish-1" },
      }, 1);
      await sendCommand(firstSocket, 2, {
        QueueCombatAction: { action_id: "aimed_shot", target_actor_id: "skirmish-1" },
      }, 2);
      await sendCommand(firstSocket, 3, { Peace: {} }, 3);
      await sendCommand(secondSocket, 1, {
        QueueCombatAction: { action_id: "aimed_shot", target_actor_id: "skirmish-1" },
      }, 1);

      expect(commandDeltas(firstSocket)[0]?.receipts?.[0]).toMatchObject({ commandId: 1, accepted: true });
      expect(commandDeltas(firstSocket)[1]?.receipts?.[0]).toMatchObject({
        commandId: 2,
        accepted: false,
        reasonCode: "ingress_budget_exhausted",
      });
      expect(commandDeltas(firstSocket)[2]?.receipts?.[0]).toMatchObject({ commandId: 3, accepted: true });
      expect(commandDeltas(secondSocket)[0]?.receipts?.[0]).toMatchObject({ commandId: 1, accepted: true });
      expect(submitted).toEqual([
        { actorId: "player", commandId: 1, kind: "QueueCombatAction" },
        { actorId: "player", commandId: 3, kind: "Peace" },
        { actorId: "budget-session-b", commandId: 1, kind: "QueueCombatAction" },
      ]);
      expect(shard.status().counters).toMatchObject({ acceptedCommands: 3, rejectedCommands: 1 });
    } finally {
      shard?.close();
      if (originalCapacity === undefined) delete process.env.GAME_INGRESS_BUDGET_CAPACITY;
      else process.env.GAME_INGRESS_BUDGET_CAPACITY = originalCapacity;
      if (originalRefill === undefined) delete process.env.GAME_INGRESS_BUDGET_REFILL_PER_SECOND;
      else process.env.GAME_INGRESS_BUDGET_REFILL_PER_SECOND = originalRefill;
    }
  });


  it("applies movement on the authoritative shard", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const before = shard.snapshotFor("player").actors.player;
      expect(before).toBeDefined();
      const result = shard.submitCommandForTest("player", envelope(1, { Move: { dx: -1, dy: 0, duration_ticks: 4, facing: "Right" } }));
      const after = result.delta.actors.player;
      expect(result.receipt.accepted).toBe(true);
      expect(result.delta.worldClock.tick).toBe(24);
      expect(after?.x).toBeCloseTo((before?.x ?? 0) - 0.181, 1);
      expect(after?.direction).toBe("right");
    } finally {
      shard.close();
    }
  });

  it("keeps in-process authority walk speed aligned with Rust and client tuning", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const before = exactActorPosition(shard, "player");
      expect(before).toBeDefined();

      const result = shard.submitCommandForTest("player", envelope(1, {
        Move: { dx: 1, dy: 0, duration_ticks: 30, facing: "Right" },
      }));
      const after = exactActorPosition(shard, "player");

      expect(result.receipt.accepted).toBe(true);
      // Co-anchored to Rust PLAYER_SPEED_MILLI_CELLS_PER_SECOND=1_357 and client tuning.v1.json.
      expect((after?.x ?? 0) - (before?.x ?? 0)).toBeCloseTo(1.357, 6);
    } finally {
      shard.close();
    }
  });

  it("applies normalized diagonal movement on the authoritative shard", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const before = shard.snapshotFor("player").actors.player;
      expect(before).toBeDefined();

      const diagonal = shard.submitCommandForTest("player", envelope(1, { Move: { dx: 1, dy: -1, duration_ticks: 4, facing: "Back" } }));
      const afterDiagonal = shard.snapshotFor("player").actors.player;
      shard.advanceAuthorityForTest(4);
      const cardinal = shard.submitCommandForTest("player", envelope(2, { Move: { dx: 1, dy: 0, duration_ticks: 4, facing: "Right" } }));
      const afterCardinal = shard.snapshotFor("player").actors.player;

      expect(diagonal.receipt.accepted).toBe(true);
      expect(cardinal.receipt.accepted).toBe(true);
      expect(afterDiagonal?.direction).toBe("back");
      const diagonalDistance = Math.hypot((afterDiagonal?.x ?? 0) - before!.x, (afterDiagonal?.y ?? 0) - before!.y);
      const cardinalDistance = (afterCardinal?.x ?? 0) - (afterDiagonal?.x ?? 0);
      expect(diagonalDistance).toBeGreaterThan(cardinalDistance * 0.98);
      expect(diagonalDistance).toBeLessThan(cardinalDistance * 1.03);
      expect(afterDiagonal?.x).toBeGreaterThan(before!.x);
      expect(afterDiagonal?.y).toBeLessThan(before!.y);
    } finally {
      shard.close();
    }
  });

  it("applies sprint movement by spending Action for faster travel", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const before = shard.snapshotFor("player").actors.player;
      expect(before).toBeDefined();

      const result = shard.submitCommandForTest("player", envelope(1, {
        Move: { dx: 1, dy: 0, duration_ticks: 6, facing: "Right", sprint: true },
      }));
      const after = shard.snapshotFor("player").actors.player;

      expect(result.receipt.accepted).toBe(true);
      expect(after?.x).toBeGreaterThan((before?.x ?? 0) + 0.65);
      expect(after?.vitals.action).toBe((before?.vitals.action ?? 0) - 2);
    } finally {
      shard.close();
    }
  });

  it("applies Scout movement and sprinting skill boxes in TypeScript fallback authority", () => {
    const novice = {
      ...actorFixture("novice-scout", "Novice Scout", "adventurer-premium-male", { x: 6, y: 8 }, "agent_player"),
      professionIds: ["scout"],
      skillBoxIds: ["scout-novice"],
    };
    const master = {
      ...actorFixture("master-scout", "Master Scout", "adventurer-premium-male", { x: 6, y: 12 }, "agent_player"),
      professionIds: ["scout"],
      skillBoxIds: [
        "scout-novice",
        "scout-traversal-i",
        "scout-traversal-ii",
        "scout-traversal-iii",
        "scout-traversal-iv",
        "scout-sprinting-i",
        "scout-sprinting-ii",
        "scout-sprinting-iii",
        "scout-sprinting-iv",
        "scout-master",
      ],
    };
    const { tempDir, slicePath: tempSlicePath } = writeTempSlice({ actors: [novice, master] });
    const shard = testShard({ slicePath: tempSlicePath, snapshotIntervalMs: 10_000, allowInProcessAuthorityForTests: true });
    try {
      const before = shard.snapshotFor("novice-scout").actors;
      const noviceMove = shard.submitCommandForTest("novice-scout", envelope(1, {
        Move: { dx: 1, dy: 0, duration_ticks: 30, facing: "Right", sprint: true },
      }));
      const masterMove = shard.submitCommandForTest("master-scout", envelope(2, {
        Move: { dx: 1, dy: 0, duration_ticks: 30, facing: "Right", sprint: true },
      }));
      const after = shard.snapshotFor("novice-scout").actors;

      expect(noviceMove.receipt.accepted).toBe(true);
      expect(masterMove.receipt.accepted).toBe(true);
      const noviceDistance = (after["novice-scout"]?.x ?? 0) - (before["novice-scout"]?.x ?? 0);
      const masterDistance = (after["master-scout"]?.x ?? 0) - (before["master-scout"]?.x ?? 0);
      expect(masterDistance).toBeGreaterThan(noviceDistance * 1.4);
      expect(after["master-scout"]?.vitals.action).toBeGreaterThan(after["novice-scout"]?.vitals.action ?? 0);
    } finally {
      shard.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rate-limits rapid axis-switch movement commands", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const before = shard.snapshotFor("player").actors.player;
      expect(before).toBeDefined();

      const first = shard.submitCommandForTest("player", envelope(1, {
        Move: { dx: -1, dy: 0, duration_ticks: 4, facing: "Left" },
      }));
      const tooSoon = shard.submitCommandForTest("player", envelope(2, {
        Move: { dx: 0, dy: -1, duration_ticks: 4, facing: "Back" },
      }));

      expect(first.receipt.accepted).toBe(true);
      expect(tooSoon.receipt.accepted).toBe(false);
      expect(tooSoon.receipt.reasonCode).toBe("move_cooldown");
      expect(shard.snapshotFor("player").actors.player?.x).toBeLessThan(before!.x);

      shard.advanceAuthorityForTest(4);
      const afterCooldown = shard.submitCommandForTest("player", envelope(3, {
        Move: { dx: 0, dy: -1, duration_ticks: 4, facing: "Back" },
      }));

      expect(afterCooldown.receipt.accepted).toBe(true);
    } finally {
      shard.close();
    }
  });

  it("records recent command rejections in status and evicts oldest entries", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      expect(shard.status().recentRejections).toEqual([]);
      const startTick = shard.status().tick;

      for (let i = 0; i < 33; i += 1) {
        shard.advanceAuthorityForTest(1);
        const result = shard.submitCommandForTest("player", envelope(i + 1, {
          Move: { dx: 0, dy: 0, duration_ticks: 1 },
        }));
        expect(result.receipt).toMatchObject({ accepted: false, reasonCode: "move_rejected" });
      }

      const recent = shard.status().recentRejections;
      expect(recent).toHaveLength(32);
      expect(recent[0]).toEqual({
        tick: startTick + 2,
        actorId: "player",
        kind: "Move",
        reasonCode: "move_rejected",
      });
      expect(recent.at(-1)).toEqual({
        tick: startTick + 33,
        actorId: "player",
        kind: "Move",
        reasonCode: "move_rejected",
      });
    } finally {
      shard.close();
    }
  });

  it("records live Rust rejection receipts in status", async () => {
    const live = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = live as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: unknown) => Promise<unknown>;
        submitCommand?: (input: { envelope: ClientCommandEnvelope }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
    };
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async () => ({}),
      submitCommand: async ({ envelope }) => ({
        status: "rejected",
        reasonCode: "rust_invalid_move",
        tick: 77,
        commandId: envelope.command_id,
        actors: [],
        combatEvents: [],
        inventory: [],
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
      }),
    };
    try {
      live.connect(fakeSocket(), {
        actorId: "rust-reject-probe",
        playerId: "rust-reject-probe",
        displayName: "Rust Reject Probe",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 37, y: 21, facing: "right" },
      });

      const result = await live.submitDebugAuthorityCommand("rust-reject-probe", {
        Move: { dx: 0, dy: 0, duration_ticks: 1 },
      });

      expect(result.receipt).toMatchObject({ accepted: false, reasonCode: "rust_invalid_move", tick: 77 });
      expect(live.status().recentRejections).toEqual([{
        tick: 77,
        actorId: "rust-reject-probe",
        kind: "Move",
        reasonCode: "rust_invalid_move",
      }]);
    } finally {
      live.close();
    }
  });

  it("slides diagonal in-process movement along solid prop blockers", () => {
    const { tempDir, slicePath: tempSlicePath } = writeTempSlice({
      actors: [
        actorFixture("player", "Test Player", "adventurer-premium-male", { x: 4.7, y: 4.7 }, "player"),
      ],
      props: [{
        id: "diagonal-blocker",
        entity: "fixture:diagonal-blocker",
        areaId: "authority-test-overworld",
        label: "Diagonal Blocker",
        kind: "cover",
        assetKey: "crate",
        cell: { x: 5, y: 5 },
        size: { w: 1, h: 1 },
        interactive: false,
        solid: true,
        visible: true,
      }],
    });
    const shard = testShard({ slicePath: tempSlicePath, snapshotIntervalMs: 10_000 });
    try {
      const moved = shard.submitCommandForTest("player", envelope(1, {
        Move: { dx: 1, dy: 1, duration_ticks: 10, facing: "Front" },
      }));

      expect(moved.receipt.accepted).toBe(true);
      expect(shard.snapshotFor("player").actors.player?.x).toBeCloseTo(5.02);
      expect(shard.snapshotFor("player").actors.player?.y).toBe(4.7);
    } finally {
      shard.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects diagonal in-process movement when both slide axes are blocked", () => {
    const blocker = (id: string, x: number, y: number) => ({
      id,
      entity: `fixture:${id}`,
      areaId: "authority-test-overworld",
      label: id,
      kind: "cover",
      assetKey: "crate",
      cell: { x, y },
      size: { w: 1, h: 1 },
      interactive: false,
      solid: true,
      visible: true,
    });
    const { tempDir, slicePath: tempSlicePath } = writeTempSlice({
      actors: [
        actorFixture("player", "Test Player", "adventurer-premium-male", { x: 4.7, y: 4.7 }, "player"),
      ],
      props: [
        blocker("diagonal-blocker", 5, 5),
        blocker("x-slide-blocker", 5, 4),
        blocker("y-slide-blocker", 4, 5),
      ],
    });
    const shard = testShard({ slicePath: tempSlicePath, snapshotIntervalMs: 10_000 });
    try {
      const blocked = shard.submitCommandForTest("player", envelope(1, {
        Move: { dx: 1, dy: 1, duration_ticks: 10, facing: "Front" },
      }));

      expect(blocked.receipt.accepted).toBe(false);
      expect(blocked.receipt.reasonCode).toBe("move_rejected");
      expect(shard.snapshotFor("player").actors.player?.x).toBe(4.7);
      expect(shard.snapshotFor("player").actors.player?.y).toBe(4.7);
    } finally {
      shard.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("sends compact player position for ordinary move ack packets", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    const socket = controlledSocket();
    try {
      shard.connect(socket, {
        actorId: "player",
        playerId: "observer",
        displayName: "Test Player",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 11, y: 17, facing: "right" },
      });

      socket.emitMessage(JSON.stringify({
        type: "game.command",
        envelope: envelope(1, { Move: { dx: -1, dy: 0, duration_ticks: 4 } }),
      }));
      expect(packets(socket).find((packet) => packet.type === "game.acks")?.playerActor).toBeDefined();
      shard.advanceAuthorityForTest(4);
      socket.sent.length = 0;

      socket.emitMessage(JSON.stringify({
        type: "game.command",
        envelope: envelope(2, { Move: { dx: -1, dy: 0, duration_ticks: 4 } }),
      }));

      const ackPacket = packets(socket).find((packet) => packet.type === "game.acks");
      expect(ackPacket?.acks).toEqual([[2, 1, expect.any(Number)]]);
      expect(ackPacket?.playerActor).toBeUndefined();
      expect(ackPacket?.playerPosition).toEqual([expect.any(Number), 17]);
      expect(ackPacket?.playerPosition[0]).toBeLessThan(11);
    } finally {
      shard.close();
    }
  });

  it("sends full player actor in sprint move acks so Action drain reaches the HUD", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    const socket = controlledSocket();
    try {
      shard.connect(socket, {
        actorId: "player",
        playerId: "observer",
        displayName: "Test Player",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 11, y: 17, facing: "right" },
      });
      socket.sent.length = 0;
      const beforeAction = shard.snapshotFor("player").actors.player?.vitals.action ?? 0;

      socket.emitMessage(JSON.stringify({
        type: "game.command",
        envelope: envelope(1, { Move: { dx: -1, dy: 0, duration_ticks: 3, sprint: true } }),
      }));

      const ackPacket = packets(socket).find((packet) => packet.type === "game.acks");
      expect(ackPacket?.acks).toEqual([[1, 1, expect.any(Number)]]);
      expect(ackPacket?.playerPosition).toBeUndefined();
      expect(ackPacket?.playerActor?.vitals.action).toBe(beforeAction - 1);
      expect(ackPacket?.playerActor?.x).toBeLessThan(11);
    } finally {
      shard.close();
    }
  });

  it("does not drop pending combat events while sending move-only acks", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    const socket = controlledSocket();
    try {
      shard.connect(socket, {
        actorId: "player",
        playerId: "observer",
        displayName: "Test Player",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 11, y: 17, facing: "right" },
      });
      socket.sent.length = 0;
      (shard as unknown as { queueCombatEvents(events: GameCombatEvent[]): void }).queueCombatEvents([{
        id: 99,
        tick: 12,
        shooterActorId: "player",
        targetActorId: "covered-target",
        hitPoint: { x: 17, y: 17 },
        damage: 12,
        zone: "torso",
        previousLifeState: "alive",
        lifeState: "alive",
        targetLifecycleSeq: 1,
        bleedStackCount: 1,
        lifecycle: { kind: "hit", from: "alive", to: "alive", cause: "test hit" },
      }]);

      socket.emitMessage(JSON.stringify({
        type: "game.command",
        envelope: envelope(1, { Move: { dx: -1, dy: 0, duration_ticks: 4 } }),
      }));
      const ackPacket = packets(socket).find((packet) => packet.type === "game.acks");
      expect(ackPacket).toBeDefined();
      expect(packetEvents(ackPacket ?? {})).toHaveLength(1);
    } finally {
      shard.close();
    }
  });

  it("rejects duplicate command ids", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const command = envelope(1, { Move: { dx: -1, dy: 0, duration_ticks: 4 } });
      expect(shard.submitCommandForTest("player", command).receipt.accepted).toBe(true);
      const duplicate = shard.submitCommandForTest("player", command);
      expect(duplicate.receipt.accepted).toBe(false);
      expect(duplicate.receipt.reasonCode).toBe("duplicate_command");
    } finally {
      shard.close();
    }
  });

  it("claims the authored player placeholder for the first browser session actor", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      shard.connect(fakeSocket(), {
        actorId: "observer-runtime",
        playerId: "observer",
        displayName: "Test Player",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 11, y: 17, facing: "right" },
      });

      const snapshot = shard.snapshotFor("observer-runtime");
      expect(snapshot.playerActorId).toBe("observer-runtime");
      expect(snapshot.actors["observer-runtime"]).toMatchObject({
        label: "Test Player",
        x: 11,
        y: 17,
      });
      expect(snapshot.actors.player).toBeUndefined();
    } finally {
      shard.close();
    }
  });

  it("keeps debug command ids monotonic across successive authored-placeholder claimants", async () => {
    const { shard, submittedEnvelopes } = liveCaptureShard();
    const firstSocket = controlledSocket();
    const secondSocket = controlledSocket();
    try {
      shard.connect(firstSocket, {
        actorId: "debug-journey-one",
        playerId: "debug-journey-one",
        displayName: "Debug Journey One",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 11, y: 17, facing: "right" },
      });
      await shard.settleForDebug();
      const first = await shard.submitDebugAuthorityCommand("debug-journey-one", {
        DebugGiveItem: { item_id: 1101, quantity: 1 },
      });
      firstSocket.emitClose();
      await shard.settleForDebug();

      shard.connect(secondSocket, {
        actorId: "debug-journey-two",
        playerId: "debug-journey-two",
        displayName: "Debug Journey Two",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 11, y: 17, facing: "right" },
      });
      await shard.settleForDebug();
      const second = await shard.submitDebugAuthorityCommand("debug-journey-two", {
        DebugGiveItem: { item_id: 1101, quantity: 1 },
      });

      expect([first.commandId, second.commandId]).toEqual([1, 2]);
      expect(submittedEnvelopes.map((entry) => entry.command_id)).toEqual([1, 2]);
    } finally {
      await shard.close();
    }
  });

  it("removes transient browser session actors when their socket closes", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const actorCountBeforeConnect = shard.status().actorCount;
      const socket = controlledSocket();
      shard.connect(socket, {
        actorId: "observer-runtime",
        playerId: "observer",
        displayName: "Test Player",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 11, y: 17, facing: "right" },
      });

      expect(shard.status().sessionCount).toBe(1);
      expect(shard.status().actorCount).toBe(actorCountBeforeConnect);
      expect(shard.snapshotFor("observer-runtime").actors.player).toBeUndefined();

      socket.emitClose();

      expect(shard.status().sessionCount).toBe(0);
      expect(shard.status().actorCount).toBe(actorCountBeforeConnect);
      expect(shard.snapshotFor("vendor").actors["observer-runtime"]).toBeUndefined();
      expect(shard.snapshotFor("vendor").actors.player).toBeDefined();
    } finally {
      shard.close();
    }
  });

  it("replaces an active same-actor session without respawning over current authority", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    const firstSocket = controlledSocket();
    const secondSocket = controlledSocket();
    try {
      shard.connect(firstSocket, {
        actorId: "observer-runtime",
        playerId: "observer",
        displayName: "Test Player",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 11, y: 17, facing: "right" },
      });
      const moved = shard.submitCommandForTest("observer-runtime", envelope(1, {
        Move: { dx: 1, dy: 0, duration_ticks: 10, facing: "Right" },
      }));
      expect(moved.receipt.accepted).toBe(true);
      const current = shard.snapshotFor("observer-runtime").actors["observer-runtime"];
      expect(current?.x).toBeGreaterThan(11);

      shard.connect(secondSocket, {
        actorId: "observer-runtime",
        playerId: "observer",
        displayName: "Test Player",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 30, y: 30, facing: "left" },
      });

      expect(firstSocket.readyState).toBe(3);
      expect(shard.status().sessionCount).toBe(1);
      const hello = packets(secondSocket).find((packet) => packet.type === "game.hello");
      expect(hello?.snapshot.actors["observer-runtime"]).toMatchObject({
        x: current?.x,
        y: current?.y,
        direction: current?.direction,
      });
    } finally {
      shard.close();
    }
  });

  it("keeps authored actors after their socket closes", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const socket = controlledSocket();
      shard.connect(socket, {
        actorId: "player",
        playerId: "observer",
        displayName: "Test Player",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 11, y: 17, facing: "right" },
      });

      socket.emitClose();

      expect(shard.status().sessionCount).toBe(0);
      expect(shard.snapshotFor("player").actors.player).toBeDefined();
    } finally {
      shard.close();
    }
  });

  it("uses viewport interest to keep screen-visible actors even outside the default AOI radius", () => {
    const { tempDir, slicePath: tempSlicePath } = writeTempSlice({
      actors: [
        actorFixture("player", "Test Player", "adventurer-premium-male", { x: 10, y: 10 }, "player"),
        actorFixture("edge-visible", "Edge Visible", "creature-bellback-adult", { x: 50, y: 10 }, "creature"),
        actorFixture("outside-view", "Outside View", "creature-bellback-adult", { x: 10, y: 34 }, "creature"),
      ],
    });
    const shard = testShard({ slicePath: tempSlicePath, areaInterestRadiusCells: 8, snapshotIntervalMs: 10_000 });
    const socket = controlledSocket();
    try {
      shard.connect(socket, {
        actorId: "player",
        playerId: "observer",
        displayName: "Test Player",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 10, y: 10, facing: "right" },
      }, {
        viewport_width_cells: 96,
        viewport_height_cells: 20,
        margin_cells: 2,
      });

      const hello = packets(socket).find((packet) => packet.type === "game.hello");
      expect(hello?.snapshot.actors["edge-visible"]).toBeDefined();
      expect(hello?.snapshot.actors["outside-view"]).toBeUndefined();
    } finally {
      shard.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("sends newly visible static actors after a viewport interest update", () => {
    const { tempDir, slicePath: tempSlicePath } = writeTempSlice({
      actors: [
        actorFixture("player", "Test Player", "adventurer-premium-male", { x: 10, y: 10 }, "player"),
        actorFixture("newly-visible", "Newly Visible", "creature-bellback-adult", { x: 29, y: 10 }, "creature"),
      ],
    });
    const shard = testShard({ slicePath: tempSlicePath, areaInterestRadiusCells: 8, snapshotIntervalMs: 10_000 });
    const socket = controlledSocket();
    try {
      shard.connect(socket, {
        actorId: "player",
        playerId: "observer",
        displayName: "Test Player",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 10, y: 10, facing: "right" },
      }, {
        viewport_width_cells: 10,
        viewport_height_cells: 10,
        margin_cells: 1,
      });
      const hello = packets(socket).find((packet) => packet.type === "game.hello");
      expect(hello?.snapshot.actors["newly-visible"]).toBeUndefined();

      socket.sent.length = 0;
      socket.emitMessage(JSON.stringify({
        type: "game.view",
        view: {
          viewport_width_cells: 40,
          viewport_height_cells: 10,
          margin_cells: 1,
        },
      }));
      shard.flushSnapshotsForTest();

      const delta = packets(socket).find((packet) => packet.type === "game.delta")?.delta;
      expect(deltaActor(delta, "newly-visible")).toBeDefined();

      socket.sent.length = 0;
      socket.emitMessage(JSON.stringify({
        type: "game.view",
        view: {
          viewport_width_cells: 10,
          viewport_height_cells: 10,
          margin_cells: 1,
        },
      }));
      shard.flushSnapshotsForTest();

      const removalDelta = packets(socket).find((packet) => packet.type === "game.delta")?.delta;
      expect(removalDelta?.actorRemovals).toContain("newly-visible");
    } finally {
      shard.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });


  it("converges newly visible AOI actors across capped routine deltas", () => {
    const crowd = Array.from({ length: 30 }, (_, index) => actorFixture(
      `aoi-crowd-${String(index).padStart(2, "0")}`,
      `AOI Crowd ${index}`,
      "creature-bellback-adult",
      { x: 30 + index, y: 10 },
      "creature",
    ));
    const { tempDir, slicePath: tempSlicePath } = writeTempSlice({
      actors: [
        actorFixture("player", "Test Player", "adventurer-premium-male", { x: 2, y: 10 }, "player"),
        ...crowd,
      ],
    });
    const shard = testShard({ slicePath: tempSlicePath, areaInterestRadiusCells: 8, snapshotIntervalMs: 10_000 });
    const socket = controlledSocket();
    try {
      shard.connect(socket, {
        actorId: "player",
        playerId: "observer",
        displayName: "Test Player",
        zoneId: "authority-test",
        spawn: { areaId: "authority-test-overworld", x: 2, y: 10, facing: "right" },
      }, {
        viewport_width_cells: 8,
        viewport_height_cells: 8,
        margin_cells: 0,
      });
      const hello = packets(socket).find((packet) => packet.type === "game.hello");
      expect(Object.keys(hello?.snapshot.actors ?? {}).some((actorId) => actorId.startsWith("aoi-crowd-"))).toBe(false);

      socket.sent.length = 0;
      socket.emitMessage(JSON.stringify({
        type: "game.view",
        view: {
          viewport_width_cells: 128,
          viewport_height_cells: 24,
          margin_cells: 0,
        },
      }));

      const streamed = new Set<string>();
      for (let step = 0; step < 12 && streamed.size < crowd.length; step += 1) {
        socket.sent.length = 0;
        shard.flushSnapshotsForTest();
        for (const packet of packets(socket)) {
          if (packet.type !== "game.delta") continue;
          for (const actorId of Object.keys(packet.delta.actors ?? {})) {
            if (actorId.startsWith("aoi-crowd-")) streamed.add(actorId);
          }
          for (const [actorId] of (packet.delta.compactActors ?? []) as GameCompactActorSnapshot[]) {
            if (actorId.startsWith("aoi-crowd-")) streamed.add(actorId);
          }
        }
      }

      expect(streamed.size).toBe(crowd.length);
    } finally {
      shard.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
  it("drains aged deferred dirty IDs under capped routine scheduling while new dirty work continues", () => {
    const routineSessions = Array.from({ length: 50 }, (_, index) => actorFixture(
      `routine-observer-${String(index).padStart(2, "0")}`,
      `Routine Observer ${index}`,
      "adventurer-premium-male",
      { x: 8 + (index % 5), y: 8 + Math.floor(index / 5) },
      "player",
    ));
    const initialDirtyActors = Array.from({ length: 260 }, (_, index) => actorFixture(
      `initial-dirty-${String(index).padStart(3, "0")}`,
      `Initial Dirty ${index}`,
      "creature-bellback-adult",
      { x: 16 + (index % 20), y: 16 + Math.floor(index / 20) },
      "creature",
    ));
    const freshDirtyActors = Array.from({ length: 8 }, (_, index) => actorFixture(
      `fresh-dirty-${String(index).padStart(2, "0")}`,
      `Fresh Dirty ${index}`,
      "creature-bellback-adult",
      { x: 42 + index, y: 16 },
      "creature",
    ));
    const { tempDir, slicePath: tempSlicePath } = writeTempSlice({
      actors: [...routineSessions, ...initialDirtyActors, ...freshDirtyActors],
    });
    const shard = testShard({ slicePath: tempSlicePath, areaInterestRadiusCells: 128, snapshotIntervalMs: 50 });
    const sockets = new Map<string, GameSocket & { sent: string[] }>();
    try {
      for (const actor of routineSessions) {
        const socket = controlledSocket();
        sockets.set(actor.id, socket);
        shard.connect(socket, {
          actorId: actor.id,
          playerId: actor.id,
          displayName: actor.label,
          zoneId: "authority-test",
          spawn: { areaId: "authority-test-overworld", x: actor.cell.x, y: actor.cell.y, facing: "right" },
        });
      }

      const internals = shard as unknown as {
        dirty: boolean;
        dirtyActorIds: Set<string>;
        highDetailDirtyActorIds: Set<string>;
        statusDirtyActorIds: Set<string>;
        markDirty: (actorId: string) => void;
        deferDirtyActorIds: (
          session: { actorId: string; deferredDirtyActorIds: Set<string> },
          actorIds: Iterable<string>,
        ) => void;
        sessions: Map<string, {
          id: string;
          actorId: string;
          socket: GameSocket & { sent: string[] };
          deferredDirtyActorIds: Set<string>;
        }>;
      };
      const sessions = routineSessions.map((actor) => {
        const session = [...internals.sessions.values()].find((candidate) => candidate.actorId === actor.id);
        expect(session).toBeDefined();
        return session!;
      });
      const agedActorIds = initialDirtyActors.slice(0, 6).map((actor) => actor.id);

      internals.dirty = false;
      internals.dirtyActorIds.clear();
      internals.highDetailDirtyActorIds.clear();
      internals.statusDirtyActorIds.clear();
      for (const session of sessions) {
        session.deferredDirtyActorIds.clear();
        session.socket.sent.length = 0;
        internals.deferDirtyActorIds(session, agedActorIds);
      }
      for (const actor of initialDirtyActors) internals.markDirty(actor.id);
      const agedDeferredBySession = new Map(sessions.map((session) => [session.id, new Set(agedActorIds)]));
      const initialDeferredHighWater = sessions.reduce((total, session) => total + session.deferredDirtyActorIds.size, 0);

      shard.flushSnapshotsForTest();

      let remainingAged = sessions.reduce((total, session) => {
        const aged = agedDeferredBySession.get(session.id)!;
        return total + [...aged].filter((actorId) => session.deferredDirtyActorIds.has(actorId)).length;
      }, 0);
      expect(remainingAged).toBeGreaterThan(0);
      expect(remainingAged).toBeLessThan(initialDeferredHighWater);
      const deliveryAfterFirstRoutineFlush = shard.status().instrumentation.delivery;
      expect(deliveryAfterFirstRoutineFlush.deferredDirtyActorHighWater).toBeGreaterThanOrEqual(initialDeferredHighWater);
      expect(deliveryAfterFirstRoutineFlush.deferredDirtyActorOldestAgeTicks).toBeGreaterThan(0);

      for (let flush = 0; flush < freshDirtyActors.length && remainingAged > 0; flush += 1) {
        for (const socket of sockets.values()) socket.sent.length = 0;
        internals.markDirty(freshDirtyActors[flush]!.id);
        shard.flushSnapshotsForTest();

        const deferredNow = sessions.reduce((total, session) => total + session.deferredDirtyActorIds.size, 0);
        const agedRemainingNow = sessions.reduce((total, session) => {
          const aged = agedDeferredBySession.get(session.id)!;
          return total + [...aged].filter((actorId) => session.deferredDirtyActorIds.has(actorId)).length;
        }, 0);

        expect(deferredNow).toBeLessThanOrEqual(initialDeferredHighWater);
        expect(agedRemainingNow).toBeLessThan(remainingAged);
        remainingAged = agedRemainingNow;
      }

      expect(remainingAged).toBe(0);
      const deliveryAfterDrain = shard.status().instrumentation.delivery;
      expect(deliveryAfterDrain.deferredDirtyActorHighWater).toBe(deliveryAfterFirstRoutineFlush.deferredDirtyActorHighWater);
      expect(deliveryAfterDrain.deferredDirtyActorOldestAgeTicks).toBe(0);
      for (const session of sessions) {
        const aged = agedDeferredBySession.get(session.id)!;
        expect([...aged].some((actorId) => session.deferredDirtyActorIds.has(actorId))).toBe(false);
      }
    } finally {
      shard.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("removes deferred dirty IDs when their actor leaves interest and discards closed-session debt", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    const socket = controlledSocket();
    try {
      const session = shard.connect(socket, {
        actorId: "player",
        playerId: "observer",
        displayName: "Test Player",
        zoneId: "authority-test",
      });
      const internals = shard as unknown as {
        actors: Map<string, { lifeState: string; lifecycleSeq: number }>;
        deferDirtyActorIds: (
          deferredSession: { actorId: string; deferredDirtyActorIds: Set<string> },
          actorIds: Iterable<string>,
        ) => void;
        sessions: Map<string, { deferredDirtyActorIds: Set<string> }>;
      };
      const vendor = internals.actors.get("vendor");
      expect(vendor).toBeDefined();

      internals.deferDirtyActorIds(session, ["vendor"]);
      vendor!.lifeState = "respawning";
      vendor!.lifecycleSeq += 1;
      socket.sent.length = 0;
      shard.flushSnapshotsForTest();

      expect(packets(socket).some((packet) => (
        packet.type === "game.delta" && packet.delta.actorRemovals?.includes("vendor")
      ))).toBe(true);
      expect(session.deferredDirtyActorIds.has("vendor")).toBe(false);
      const deliveryAfterActorCleanup = shard.status().instrumentation.delivery;
      expect(deliveryAfterActorCleanup.deferredDirtyActorHighWater).toBeGreaterThanOrEqual(1);
      expect(deliveryAfterActorCleanup.deferredDirtyActorOldestAgeTicks).toBe(0);

      internals.deferDirtyActorIds(session, ["vendor"]);
      socket.emitClose();

      expect(internals.sessions.has(session.id)).toBe(false);
      expect([...internals.sessions.values()].some((candidate) => candidate.deferredDirtyActorIds.size > 0)).toBe(false);
      const deliveryAfterSessionCleanup = shard.status().instrumentation.delivery;
      expect(deliveryAfterSessionCleanup.deferredDirtyActorHighWater).toBe(deliveryAfterActorCleanup.deferredDirtyActorHighWater);
      expect(deliveryAfterSessionCleanup.deferredDirtyActorOldestAgeTicks).toBe(0);
    } finally {
      shard.close();
    }
  });

  it("dedupes command ids per socket session instead of permanently per actor", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const firstSession = new Set<number>();
      const secondSession = new Set<number>();
      const command = envelope(1, { Move: { dx: -1, dy: 0, duration_ticks: 1 } });

      expect(shard.submitCommandForTest("player", command, firstSession).receipt.accepted).toBe(true);
      expect(shard.submitCommandForTest("player", command, firstSession).receipt.reasonCode).toBe("duplicate_command");
      shard.advanceAuthorityForTest(1);
      expect(shard.submitCommandForTest("player", command, secondSession).receipt.accepted).toBe(true);
    } finally {
      shard.close();
    }
  });

  it("refuses a missing configured checkpoint when durable journal or character evidence remains", async () => {
    expect(() => testShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      hasEnteredCharacters: true,
    })).toThrow(/durable characters have already entered.*checkpoint persistence is disabled.*explicit recovery or reset/iu);

    for (const scenario of [
      { name: "journal", journalRaw: '{"type":"command.receipt"}\n', hasEnteredCharacters: false },
      { name: "entered-character", journalRaw: "", hasEnteredCharacters: true },
    ]) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `successor-missing-checkpoint-${scenario.name}-`));
      const checkpointPath = path.join(tempDir, "authority-test.checkpoint.json");
      const journalPath = path.join(tempDir, "authority-test.journal.jsonl");
      try {
        if (scenario.journalRaw) fs.writeFileSync(journalPath, scenario.journalRaw, "utf8");
        expect(() => testShard({
          slicePath,
          snapshotIntervalMs: 10_000,
          persistence: { checkpointPath, journalPath },
          hasEnteredCharacters: scenario.hasEnteredCharacters,
        })).toThrow(/configured durable checkpoint is missing.*explicit recovery or reset/iu);
        expect(fs.existsSync(checkpointPath)).toBe(false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-clean-first-checkpoint-"));
    const checkpointPath = path.join(tempDir, "authority-test.checkpoint.json");
    const journalPath = path.join(tempDir, "authority-test.journal.jsonl");
    const clean = testShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      persistence: { checkpointPath, journalPath },
      hasEnteredCharacters: false,
    });
    try {
      expect(clean.status().persistence.restore).toMatchObject({ loaded: false, reason: "missing" });
    } finally {
      await clean.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("restores and rebinds a v1 world checkpoint across the additive v2 control migration", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-control-schema-upgrade-"));
    const checkpointPath = path.join(tempDir, "authority-test.checkpoint.json");
    const manifestPath = path.join(tempDir, "state-generation.manifest.json");
    const v1 = {
      version: MIGRATIONS[0]!.version,
      checksum: migrationChecksumForTests(MIGRATIONS[0]!),
    };
    const v2 = {
      version: MIGRATIONS[1]!.version,
      checksum: migrationChecksumForTests(MIGRATIONS[1]!),
    };
    let first: GameShard | undefined;
    let upgraded: GameShard | undefined;
    try {
      first = testShard({
        slicePath,
        snapshotIntervalMs: 10_000,
        persistence: { checkpointPath, manifestPath, controlSchemaHead: v1 },
      });
      first.checkpointNowForTest("control-schema-v1-seed");
      await first.close();
      first = undefined;

      upgraded = testShard({
        slicePath,
        snapshotIntervalMs: 10_000,
        persistence: { checkpointPath, manifestPath, controlSchemaHead: v2 },
      });
      expect(upgraded.status().persistence.restore).toMatchObject({ loaded: true });

      await upgraded.close();
      upgraded = undefined;
      const rebound = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        controlSchemaHead?: unknown;
      };
      expect(rebound.controlSchemaHead).toEqual(v2);
    } finally {
      await first?.close().catch(() => undefined);
      await upgraded?.close().catch(() => undefined);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("requires a nonempty configured journal beside an existing checkpoint", async () => {
    for (const journalState of ["missing", "empty", "whitespace"] as const) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `successor-checkpoint-${journalState}-journal-`));
      const checkpointPath = path.join(tempDir, "authority-test.checkpoint.json");
      const journalPath = path.join(tempDir, "authority-test.journal.jsonl");
      const first = testShard({
        slicePath,
        snapshotIntervalMs: 10_000,
        persistence: { checkpointPath, journalPath },
      });
      try {
        first.checkpointNowForTest("journal-guard-seed");
        await first.close();
        if (journalState === "missing") fs.rmSync(journalPath);
        else fs.writeFileSync(journalPath, journalState === "whitespace" ? "\n  \n" : "", "utf8");

        expect(() => testShard({
          slicePath,
          snapshotIntervalMs: 10_000,
          persistence: { checkpointPath, journalPath },
        })).toThrow(/checkpoint .* exists.*configured journal .* missing or empty.*omitting journalPath/iu);
      } finally {
        await first.close().catch(() => undefined);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-explicit-no-journal-"));
    const checkpointPath = path.join(tempDir, "authority-test.checkpoint.json");
    const journalPath = path.join(tempDir, "authority-test.journal.jsonl");
    const first = testShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      persistence: { checkpointPath, journalPath },
    });
    let restored: GameShard | undefined;
    try {
      first.checkpointNowForTest("no-journal-seed");
      await first.close();
      fs.rmSync(journalPath);
      restored = testShard({
        slicePath,
        snapshotIntervalMs: 10_000,
        persistence: { checkpointPath },
      });
      expect(restored.status().persistence.restore).toMatchObject({ loaded: true });
    } finally {
      await first.close().catch(() => undefined);
      await restored?.close().catch(() => undefined);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails journal replay if a configured journal disappears or becomes empty after startup", async () => {
    for (const journalState of ["missing", "whitespace"] as const) {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `successor-journal-replay-${journalState}-`));
      const journalPath = path.join(tempDir, "authority-test.journal.jsonl");
      fs.writeFileSync(journalPath, '{"type":"session.connect"}\n', "utf8");
      const shard = testShard({
        slicePath,
        snapshotIntervalMs: 10_000,
        persistence: { journalPath },
      });
      const internals = shard as unknown as {
        createCheckpoint: () => Record<string, unknown>;
        replayRustAuthorityJournalTail: (
          checkpoint: unknown,
          options: { initialStateHash: string; verifyStateHashes: boolean },
        ) => Promise<{ count: number; finalStateHash?: string }>;
      };
      const checkpoint = internals.createCheckpoint();
      try {
        if (journalState === "missing") fs.rmSync(journalPath);
        else fs.writeFileSync(journalPath, "\n  \n", "utf8");
        await expect(internals.replayRustAuthorityJournalTail(checkpoint, {
          initialStateHash: "restore-state-hash",
          verifyStateHashes: true,
        })).rejects.toThrow(journalState === "missing"
          ? /configured journal disappeared or became unreadable/iu
          : /configured journal became empty/iu);
      } finally {
        await shard.close().catch(() => undefined);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }

    const noJournalShard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    const noJournalInternals = noJournalShard as unknown as {
      createCheckpoint: () => Record<string, unknown>;
      replayRustAuthorityJournalTail: (
        checkpoint: unknown,
        options: { initialStateHash: string; verifyStateHashes: boolean },
      ) => Promise<{ count: number; finalStateHash?: string }>;
    };
    try {
      await expect(noJournalInternals.replayRustAuthorityJournalTail(
        noJournalInternals.createCheckpoint(),
        { initialStateHash: "explicit-no-journal", verifyStateHashes: true },
      )).resolves.toEqual({ count: 0, finalStateHash: "explicit-no-journal" });
    } finally {
      await noJournalShard.close();
    }
  });
  it("clears Rust lifecycle effects while keeping the craft-roll key stable across bridge recreation and shard restarts", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-craft-roll-key-"));
    const checkpointPath = path.join(tempDir, "authority-test.checkpoint.json");
    const sidecarPath = `${checkpointPath}.craft-roll-key`;
    const configuredKey = "ab".repeat(32);
    const first = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      persistence: { checkpointPath },
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
        craftRollKey: configuredKey,
      },
    });
    try {
      const firstInternals = first as unknown as {
        initialAuthoredActors: Map<string, unknown>;
        rustAuthorityMode: "live" | null;
        rustAuthorityBridgeOptions?: { craftRollKey?: string };
        rustAuthorityBridgeGeneration: number;
        rustAuthorityRegisteredActorIds: Set<string>;
        rustAuthorityLinkDeadActorIds: Set<string>;
        rustAuthorityDesiredLinkDead: Map<string, boolean>;
        rustAuthorityActorUpserts: Map<string, Promise<void>>;
        rustAuthorityLinkDeadEffects: Map<string, Promise<void>>;
      };
      expect(firstInternals.rustAuthorityBridgeOptions?.craftRollKey).toBe(configuredKey);
      firstInternals.initialAuthoredActors.clear();
      const bridgeGeneration = firstInternals.rustAuthorityBridgeGeneration;
      const staleEffect = Promise.resolve();
      firstInternals.rustAuthorityRegisteredActorIds.add("stale-actor");
      firstInternals.rustAuthorityLinkDeadActorIds.add("stale-actor");
      firstInternals.rustAuthorityDesiredLinkDead.set("stale-actor", true);
      firstInternals.rustAuthorityActorUpserts.set("stale-actor", staleEffect);
      firstInternals.rustAuthorityLinkDeadEffects.set("stale-actor", staleEffect);
      await first.resetDebugFixture();
      expect(firstInternals.rustAuthorityBridgeGeneration).toBe(bridgeGeneration + 1);
      expect(firstInternals.rustAuthorityRegisteredActorIds.size).toBe(0);
      expect(firstInternals.rustAuthorityLinkDeadActorIds.size).toBe(0);
      expect(firstInternals.rustAuthorityDesiredLinkDead.size).toBe(0);
      expect(firstInternals.rustAuthorityActorUpserts.size).toBe(0);
      expect(firstInternals.rustAuthorityLinkDeadEffects.size).toBe(0);
      expect(firstInternals.rustAuthorityBridgeOptions?.craftRollKey).toBe(configuredKey);
      expect(fs.readFileSync(sidecarPath, "utf8")).toBe(configuredKey);
      expect(fs.statSync(sidecarPath).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(tempDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      // No authority export is needed for this key-only lifecycle proof.
      firstInternals.rustAuthorityMode = null;
    } finally {
      await first.close();
    }
    fs.rmSync(checkpointPath, { force: true });

    const second = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      persistence: { checkpointPath },
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
        craftRollKey: configuredKey.toUpperCase(),
      },
    });
    try {
      const secondInternals = second as unknown as {
        rustAuthorityMode: "live" | null;
        rustAuthorityBridgeOptions?: { craftRollKey?: string };
      };
      expect(secondInternals.rustAuthorityBridgeOptions?.craftRollKey).toBe(configuredKey);
      secondInternals.rustAuthorityMode = null;
    } finally {
      await second.close();
    }

    fs.chmodSync(sidecarPath, 0o644);
    expect(() => new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      persistence: { checkpointPath },
      rustAuthorityBridge: { enabled: true, command: process.execPath, args: ["-e", "process.stdin.resume();"] },
    })).toThrow(/non-private/u);
    fs.chmodSync(sidecarPath, 0o600);
    fs.writeFileSync(sidecarPath, "not-a-key", "utf8");
    expect(() => new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      persistence: { checkpointPath },
      rustAuthorityBridge: { enabled: true, command: process.execPath, args: ["-e", "process.stdin.resume();"] },
    })).toThrow(/exactly 64 hexadecimal/u);
    fs.writeFileSync(sidecarPath, "cd".repeat(32), "utf8");
    expect(() => new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      persistence: { checkpointPath },
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
        craftRollKey: configuredKey,
      },
    })).toThrow(/does not match/u);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  it("does not publish a partial craft-roll key sidecar when its durable write fails", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-craft-roll-key-write-"));
    const checkpointPath = path.join(tempDir, "authority-test.checkpoint.json");
    const sidecarPath = `${checkpointPath}.craft-roll-key`;
    const originalWriteFileSync = fs.writeFileSync.bind(fs);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(((
      file: number,
      data: string,
    ) => {
      originalWriteFileSync(file, data.slice(0, 8), "utf8");
      throw new Error("simulated interrupted sidecar write");
    }) as typeof fs.writeFileSync);
    try {
      expect(() => new GameShard({
        slicePath,
        snapshotIntervalMs: 10_000,
        allowInProcessAuthorityForTests: true,
        persistence: { checkpointPath },
      })).toThrow(/failed to durably write/u);
      expect(fs.existsSync(sidecarPath)).toBe(false);
      expect(fs.readdirSync(tempDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      writeSpy.mockRestore();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
  it("replays a journal command after a deterministic tick gap and fails closed on backward ticks", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-tick-gap-replay-"));
    const journalPath = path.join(tempDir, "authority-test.journal.jsonl");
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000, persistence: { journalPath } });
    const internals = shard as unknown as {
      createCheckpoint: (rustAuthority?: unknown) => unknown;
      replayRustAuthorityJournalTail: (
        checkpoint: unknown,
        options: { initialStateHash: string; initialTick?: number; verifyStateHashes: boolean },
      ) => Promise<{ count: number; finalStateHash?: string }>;
      weatherHazardsForTick: (tick: number) => unknown[];
      actors: Map<string, { x: number; y: number }>;
      tick: number;
      rustAuthorityBridge?: unknown;
      lastRustAuthorityStateHash?: string;
    };
    const movementEnvelope = { ...envelope(601, { Move: { dx: 1, dy: 0, duration_ticks: 1 } }), issued_at_tick: 114 };
    const checkpoint = internals.createCheckpoint({
      schema: "authority.checkpoint-state.v1",
      version: 1,
      tick: 100,
      stateHash: "checkpoint-state-hash",
      state: { schema: "successor.authority-state.v1", version: 1, stateHash: "checkpoint-state-hash" },
    }) as {
      savedAt: string;
      tick: number;
      stateHash: string;
      rustAuthority: { tick: number; stateHash: string };
    };
    fs.writeFileSync(journalPath, `${JSON.stringify({
      type: "checkpoint",
      at: checkpoint.savedAt,
      tick: checkpoint.tick,
      reason: "tick-gap-regression",
      actorCount: 0,
      stateHash: checkpoint.stateHash,
    })}\n${JSON.stringify({
      type: "command.receipt",
      at: checkpoint.savedAt,
      tick: 115,
      actorId: "player",
      commandId: movementEnvelope.command_id,
      commandKind: "Move",
      accepted: true,
      eventIds: [],
      rust: {
        actorId: "player",
        rustActorId: "player",
        envelope: movementEnvelope,
        session: movementEnvelope.session,
        player: movementEnvelope.player,
        stateHash: "command-state-hash",
      },
    })}\n`, "utf8");

    const tickRequests: Array<{ ticks: number; weatherHazards?: unknown[]; weatherHazardsByTick?: unknown[][] }> = [];
    const submitted: ClientCommandEnvelope[] = [];
    const bridge = {
      submitTick: async (options: { ticks: number; weatherHazards?: unknown[]; weatherHazardsByTick?: unknown[][] }) => {
        tickRequests.push(options);
        const targetTick = options.ticks === 15 ? 115 : 117;
        return { ...rustTickOutput([rustActorSnapshot({ id: "player", x: targetTick === 115 ? 11 : 13, y: 10 })], targetTick), targetStateHash: `gap-state-hash-${targetTick}` };
      },
      submitCommand: async (options: { envelope: ClientCommandEnvelope }) => {
        submitted.push(options.envelope);
        const targetTick = options.envelope.command_id === 601 ? 115 : 117;
        const targetStateHash = options.envelope.command_id === 601 ? "command-state-hash" : "command-state-hash-602";
        return {
          ...rustTickOutput([rustActorSnapshot({ id: "player", x: targetTick === 115 ? 12 : 14, y: 10 })], targetTick),
          status: "accepted" as const,
          commandId: options.envelope.command_id,
          targetStateHash,
        } satisfies RustAuthorityBridgeStepOutput;
      },
    };
    internals.rustAuthorityBridge = bridge;

    try {
      await expect(internals.replayRustAuthorityJournalTail(checkpoint, {
        initialStateHash: checkpoint.rustAuthority.stateHash,
        initialTick: checkpoint.rustAuthority.tick,
        verifyStateHashes: true,
      })).resolves.toEqual({ count: 1, finalStateHash: "command-state-hash" });
      expect(tickRequests).toHaveLength(1);
      expect(tickRequests[0]?.ticks).toBe(15);
      expect(tickRequests[0]?.weatherHazards).toEqual([]);
      expect(tickRequests[0]?.weatherHazardsByTick).toEqual(
        Array.from({ length: 15 }, (_unused, index) => internals.weatherHazardsForTick(101 + index)),
      );
      expect(submitted).toEqual([movementEnvelope]);
      expect(internals.tick).toBe(115);
      expect(internals.actors.get("player")).toMatchObject({ x: 12, y: 10 });
      expect(internals.lastRustAuthorityStateHash).toBe("command-state-hash");

      fs.appendFileSync(journalPath, `${JSON.stringify({
        type: "command.receipt",
        at: checkpoint.savedAt,
        tick: 117,
        actorId: "player",
        commandId: 602,
        commandKind: "Move",
        accepted: true,
        eventIds: [],
        rust: {
          actorId: "player",
          rustActorId: "player",
          envelope: { ...movementEnvelope, command_id: 602, issued_at_tick: 115 },
          session: movementEnvelope.session,
          player: movementEnvelope.player,
          stateHash: "command-state-hash-602",
        },
      })}\n${JSON.stringify({
        type: "command.receipt",
        at: checkpoint.savedAt,
        tick: 116,
        actorId: "player",
        commandId: 603,
        commandKind: "Move",
        accepted: true,
        eventIds: [],
        rust: {
          actorId: "player",
          rustActorId: "player",
          envelope: { ...movementEnvelope, command_id: 603, issued_at_tick: 116 },
          session: movementEnvelope.session,
          player: movementEnvelope.player,
          stateHash: "command-state-hash-603",
        },
      })}\n`, "utf8");
      await expect(internals.replayRustAuthorityJournalTail(checkpoint, {
        initialStateHash: checkpoint.rustAuthority.stateHash,
        initialTick: checkpoint.rustAuthority.tick,
        verifyStateHashes: true,
      })).rejects.toThrow(/command 603 is out of order.*receipt tick 116.*replay tick 117/u);
      expect(submitted).toHaveLength(3);
    } finally {
      await shard.close().catch(() => undefined);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("replays a CraftAssemble journal receipt with the persisted craft-roll key", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-craft-journal-replay-"));
    const checkpointPath = path.join(tempDir, "authority-test.checkpoint.json");
    const journalPath = path.join(tempDir, "authority-test.journal.jsonl");
    const sidecarPath = `${checkpointPath}.craft-roll-key`;
    const firstKey = createHash("sha256").update("craft-journal-replay-primary").digest("hex");
    const alternateKey = createHash("sha256").update("craft-journal-replay-alternate").digest("hex");
    const craftEnvelope = { ...envelope(91, { CraftAssemble: {} }), issued_at_tick: 41 };
    let checkpointStateHash = "";
    let recordedTargetStateHash: string;
    const canonicalEnvelope = (value: ClientCommandEnvelope): string => JSON.stringify({
      session: value.session,
      player: value.player,
      command_id: value.command_id,
      issued_at_tick: value.issued_at_tick,
      command: value.command,
    });
    const targetStateHash = (key: string, value: ClientCommandEnvelope): string => createHash("sha256")
      .update(Buffer.from(key, "hex"))
      .update(canonicalEnvelope(value))
      .digest("hex");
    type ReplayBridge = {
      close: () => void;
      pendingCount: () => number;
      debugStatus: () => null;
      exportState: () => Promise<RustAuthorityBridgeExportStateOutput>;
      importState: (options: { state: Record<string, unknown>; expectedStateHash?: string }) => Promise<RustAuthorityBridgeImportStateOutput>;
      submitCommand: (options: { actorId: string; envelope: ClientCommandEnvelope; session?: number; player?: number; timeoutMs?: number }) => Promise<RustAuthorityBridgeStepOutput>;
    };
    const replayBridge = (key: string, submitted: ClientCommandEnvelope[]): ReplayBridge => ({
      close: () => undefined,
      pendingCount: () => 0,
      debugStatus: () => null,
      exportState: async () => ({
        tick: 41,
        stateHash: checkpointStateHash,
        state: {
          schema: "successor.authority-state.v1",
          version: 1,
          stateHash: checkpointStateHash,
        },
      }),
      importState: async ({ expectedStateHash }) => ({
        tick: 41,
        targetStateHash: expectedStateHash,
        actors: [],
        logoutActors: [],
        combatEvents: [],
        abilityQueueEvents: [],
        inventory: [],
        reservations: [],
        timelineEvents: [],
      }),
      submitCommand: async ({ envelope: submittedEnvelope }) => {
        submitted.push(submittedEnvelope);
        return {
          status: "accepted",
          commandId: submittedEnvelope.command_id,
          targetStateHash: targetStateHash(key, submittedEnvelope),
          actors: [],
          combatEvents: [],
          abilityQueueEvents: [],
          inventory: [],
          reservations: [],
          timelineEvents: [],
        };
      },
    });

    let first: GameShard | undefined;
    let second: GameShard | undefined;
    let negative: GameShard | undefined;
    try {
      first = new GameShard({
        slicePath,
        snapshotIntervalMs: 10_000,
        persistence: { checkpointPath, journalPath },
        rustAuthorityBridge: {
          enabled: true,
          command: process.execPath,
          args: ["-e", "process.stdin.resume();"],
          craftRollKey: firstKey,
        },
      });
      const firstInternals = first as unknown as {
        craftRollKey: string;
        rustAuthorityBridge?: ReplayBridge;
        persistenceDirty: boolean;
        rustAuthorityMode: "live" | null;
        createCheckpoint: (rustAuthority?: unknown) => unknown;
        checkpointProjectionStateHash: (checkpoint: unknown) => string;
      };
      checkpointStateHash = firstInternals.checkpointProjectionStateHash(firstInternals.createCheckpoint({
        tick: 41,
        stateHash: "pending",
        state: {},
      }));
      recordedTargetStateHash = targetStateHash(firstInternals.craftRollKey, craftEnvelope);
      firstInternals.rustAuthorityBridge?.close();
      firstInternals.rustAuthorityBridge = replayBridge(firstKey, []);
      firstInternals.persistenceDirty = true;
      await first.checkpoint("craft-journal-replay-seed");
      await first.close();
      first = undefined;

      const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8")) as {
        savedAt: string;
        tick: number;
        stateHash: string;
        rustAuthority: { stateHash: string };
      };
      expect(checkpoint.rustAuthority.stateHash).toBe(checkpointStateHash);
      const expectedTargetStateHash = recordedTargetStateHash;
      fs.appendFileSync(journalPath, `${JSON.stringify({
        type: "command.receipt",
        at: checkpoint.savedAt,
        tick: checkpoint.tick,
        actorId: "player",
        commandId: craftEnvelope.command_id,
        commandKind: "CraftAssemble",
        accepted: true,
        eventIds: [],
        rust: {
          actorId: "player",
          rustActorId: "player",
          envelope: craftEnvelope,
          session: craftEnvelope.session,
          player: craftEnvelope.player,
          stateHash: expectedTargetStateHash,
        },
      })}\n`, "utf8");

      const submitted: ClientCommandEnvelope[] = [];
      second = new GameShard({
        slicePath,
        snapshotIntervalMs: 10_000,
        allowInProcessAuthorityForTests: true,
        persistence: { checkpointPath, journalPath },
        rustAuthorityBridge: { craftRollKey: undefined },
      });
      const secondInternals = second as unknown as {
        craftRollKey: string;
        rustAuthorityMode: "live" | null;
        rustAuthorityBridge?: ReplayBridge;
        replayRustAuthorityJournalTail: (
          checkpoint: unknown,
          options: { initialStateHash: string; verifyStateHashes: boolean },
        ) => Promise<{ count: number; finalStateHash?: string }>;
      };
      expect(secondInternals.craftRollKey).toBe(firstKey);
      secondInternals.rustAuthorityMode = "live";
      secondInternals.rustAuthorityBridge = replayBridge(secondInternals.craftRollKey, submitted);
      await expect(secondInternals.replayRustAuthorityJournalTail(checkpoint, {
        initialStateHash: checkpoint.rustAuthority.stateHash,
        verifyStateHashes: true,
      })).resolves.toEqual({ count: 1, finalStateHash: expectedTargetStateHash });
      expect(submitted).toEqual([craftEnvelope]);
      // Keep the original checkpoint marker as the replay boundary for the
      // wrong-key proof. Closing this stub shard can emit an identical marker
      // in the same millisecond and make the backward marker search skip the
      // receipt that this test is meant to verify.

      fs.writeFileSync(sidecarPath, alternateKey, "utf8");
      negative = new GameShard({
        slicePath,
        snapshotIntervalMs: 10_000,
        allowInProcessAuthorityForTests: true,
        persistence: { checkpointPath, journalPath },
        rustAuthorityBridge: { craftRollKey: alternateKey },
      });
      const negativeInternals = negative as unknown as {
        rustAuthorityMode: "live" | null;
        rustAuthorityBridge?: ReplayBridge;
        replayRustAuthorityJournalTail: (
          checkpoint: unknown,
          options: { initialStateHash: string; verifyStateHashes: boolean },
        ) => Promise<{ count: number; finalStateHash?: string }>;
      };
      negativeInternals.rustAuthorityMode = "live";
      negativeInternals.rustAuthorityBridge = replayBridge(alternateKey, []);
      await expect(negativeInternals.replayRustAuthorityJournalTail(checkpoint, {
        initialStateHash: checkpoint.rustAuthority.stateHash,
        verifyStateHashes: true,
      })).rejects.toThrow(/journal replay hash mismatch for command 91/u);
    } finally {
      if (negative) await negative.close().catch(() => undefined);
      if (second) await second.close().catch(() => undefined);
      if (first) await first.close().catch(() => undefined);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed after a raw authored-row change even when the descriptive source hash is unchanged", () => {
    const fixture = createCheckpointCompatibilityFixture();
    try {
      const checkpointBefore = fs.readFileSync(fixture.checkpointPath, "utf8");
      const source = JSON.parse(fs.readFileSync(fixture.slicePath, "utf8")) as {
        stateHash: string;
        actors: Array<{ id?: string; label?: string }>;
      };
      const vendor = source.actors.find((actor) => actor.id === "vendor");
      if (!vendor) throw new Error("checkpoint compatibility fixture is missing vendor");
      vendor.label = "Test Shopkeeper Authored Update";
      fs.writeFileSync(fixture.slicePath, JSON.stringify(source, null, 2));

      expect(() => testShard({
        slicePath: fixture.slicePath,
        snapshotIntervalMs: 10_000,
        persistence: { checkpointPath: fixture.checkpointPath, journalPath: fixture.journalPath, checkpointIntervalMs: 1 },
      })).toThrow(/restore failed \(slice_hash_mismatch\); checkpoint retained/u);
      expect(fs.readFileSync(fixture.checkpointPath, "utf8")).toBe(checkpointBefore);
    } finally {
      fs.rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a raw slice change when the source semantic hash changes", () => {
    const fixture = createCheckpointCompatibilityFixture();
    try {
      const checkpointBefore = fs.readFileSync(fixture.checkpointPath, "utf8");
      const source = JSON.parse(fs.readFileSync(fixture.slicePath, "utf8")) as { stateHash: string };
      source.stateHash = "server-authority-fixture-v2";
      fs.writeFileSync(fixture.slicePath, JSON.stringify(source, null, 2));

      expect(() => testShard({
        slicePath: fixture.slicePath,
        snapshotIntervalMs: 10_000,
        persistence: { checkpointPath: fixture.checkpointPath, journalPath: fixture.journalPath, checkpointIntervalMs: 1 },
      })).toThrow(/restore failed \(source_state_hash_mismatch\); checkpoint retained/u);
      expect(fs.readFileSync(fixture.checkpointPath, "utf8")).toBe(checkpointBefore);
    } finally {
      fs.rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a raw slice change for a legacy checkpoint without a source semantic hash", () => {
    const fixture = createCheckpointCompatibilityFixture();
    try {
      const checkpoint = JSON.parse(fs.readFileSync(fixture.checkpointPath, "utf8")) as { sourceStateHash?: string };
      delete checkpoint.sourceStateHash;
      fs.writeFileSync(fixture.checkpointPath, JSON.stringify(checkpoint, null, 2));
      const checkpointBefore = fs.readFileSync(fixture.checkpointPath, "utf8");

      const source = JSON.parse(fs.readFileSync(fixture.slicePath, "utf8")) as {
        actors: Array<{ id?: string; label?: string }>;
      };
      const vendor = source.actors.find((actor) => actor.id === "vendor");
      if (!vendor) throw new Error("checkpoint compatibility fixture is missing vendor");
      vendor.label = "Test Shopkeeper Legacy Update";
      fs.writeFileSync(fixture.slicePath, JSON.stringify(source, null, 2));

      expect(() => testShard({
        slicePath: fixture.slicePath,
        snapshotIntervalMs: 10_000,
        persistence: { checkpointPath: fixture.checkpointPath, journalPath: fixture.journalPath, checkpointIntervalMs: 1 },
      })).toThrow(/restore failed \(slice_hash_mismatch\); checkpoint retained/u);
      expect(fs.readFileSync(fixture.checkpointPath, "utf8")).toBe(checkpointBefore);
    } finally {
      fs.rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("fails closed when alias or travel-ticket projection data is tampered", () => {
    for (const mutate of [
      (checkpoint: Record<string, unknown>) => {
        checkpoint.authoredPlaceholderOwners = { player: "char-injected-owner" };
      },
      (checkpoint: Record<string, unknown>) => {
        checkpoint.travelTickets = [{
          container: "char-injected-owner:datapad",
          stackId: 999,
          item: "Forged Ticket",
          itemId: 9901,
          variantId: 0,
          quantity: 1,
          reserved: 0,
          available: 1,
        }];
      },
    ]) {
      const fixture = createCheckpointCompatibilityFixture();
      try {
        const checkpoint = JSON.parse(fs.readFileSync(fixture.checkpointPath, "utf8")) as Record<string, unknown>;
        mutate(checkpoint);
        fs.writeFileSync(fixture.checkpointPath, JSON.stringify(checkpoint, null, 2));
        const checkpointBefore = fs.readFileSync(fixture.checkpointPath, "utf8");

        expect(() => testShard({
          slicePath: fixture.slicePath,
          snapshotIntervalMs: 10_000,
          persistence: { checkpointPath: fixture.checkpointPath, journalPath: fixture.journalPath, checkpointIntervalMs: 1 },
          characterPersistence: {
            hasCharacter: () => true,
            saveSnapshot: () => undefined,
          },
        })).toThrow(/restore failed \(projection_state_hash_mismatch\); checkpoint retained/u);
        expect(fs.readFileSync(fixture.checkpointPath, "utf8")).toBe(checkpointBefore);
      } finally {
        fs.rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    }
  });

  it("fails closed when a validly hashed alias references a missing durable character", async () => {
    const fixture = createCheckpointCompatibilityFixture();
    const calculator = testShard({ slicePath: fixture.slicePath, snapshotIntervalMs: 10_000 });
    try {
      const checkpoint = JSON.parse(fs.readFileSync(fixture.checkpointPath, "utf8")) as Record<string, unknown>;
      checkpoint.authoredPlaceholderOwners = { player: "char-missing-owner" };
      const calculate = calculator as unknown as { checkpointProjectionStateHash: (value: unknown) => string };
      const projectionStateHash = calculate.checkpointProjectionStateHash(checkpoint);
      checkpoint.projectionStateHash = projectionStateHash;
      checkpoint.stateHash = projectionStateHash;
      fs.writeFileSync(fixture.checkpointPath, JSON.stringify(checkpoint, null, 2));
      const checkpointBefore = fs.readFileSync(fixture.checkpointPath, "utf8");

      expect(() => testShard({
        slicePath: fixture.slicePath,
        snapshotIntervalMs: 10_000,
        persistence: { checkpointPath: fixture.checkpointPath, journalPath: fixture.journalPath, checkpointIntervalMs: 1 },
        characterPersistence: {
          hasCharacter: () => false,
          saveSnapshot: () => undefined,
        },
      })).toThrow(/restore failed \(invalid_placeholder_ownership\); checkpoint retained/u);
      expect(fs.readFileSync(fixture.checkpointPath, "utf8")).toBe(checkpointBefore);
    } finally {
      await calculator.close();
      fs.rmSync(fixture.tempDir, { recursive: true, force: true });
    }
  });

  it("fails live restore when a valid alias disagrees with the Rust placeholder entity", async () => {
    const live = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      characterPersistence: {
        hasCharacter: (id) => id === "char-owner-a" || id === "char-owner-b",
        saveSnapshot: () => undefined,
      },
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const stateHash = "e".repeat(64);
    const internals = live as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        pendingCount?: () => number;
        importState?: () => Promise<RustAuthorityBridgeImportStateOutput>;
      };
      createCheckpoint: (rustState: unknown) => Record<string, unknown>;
      checkpointProjectionStateHash: (checkpoint: unknown) => string;
      restoreLiveRustAuthorityCheckpoint: (checkpoint: unknown, path: string) => Promise<void>;
    };
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => undefined,
      pendingCount: () => 0,
      importState: async () => ({
        schema: "successor.rust-authority-bridge-import-state.v1",
        requestId: 1,
        tick: 41,
        targetStateHash: stateHash,
        actors: [rustActorSnapshot({ id: "player", entity: "char-owner-a", label: "Owner A" })],
        combatEvents: [],
        inventory: [],
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
        logoutActors: [],
        removedActorIds: [],
        metrics: rustTickOutput([], 41).metrics,
      } as RustAuthorityBridgeImportStateOutput),
    };
    const checkpoint = internals.createCheckpoint({
      schema: "authority.checkpoint-state.v1",
      version: 1,
      tick: 41,
      stateHash,
      state: { schema: "successor.authority-state.v1", version: 1, stateHash },
    });
    checkpoint.authoredPlaceholderOwners = { player: "char-owner-b" };
    checkpoint.projectionStateHash = internals.checkpointProjectionStateHash(checkpoint);

    try {
      await expect(internals.restoreLiveRustAuthorityCheckpoint(checkpoint, path.join("tmp", "alias-mismatch.checkpoint.json")))
        .rejects.toThrow(/owner mismatch: checkpoint=char-owner-b, rust=char-owner-a/u);
    } finally {
      await live.close();
    }
  });

  it("awaits the final checkpoint before completing shard close", async () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    let releaseCheckpoint!: () => void;
    try {
      let released = false;
      const checkpoint = new Promise<void>((resolve) => {
        releaseCheckpoint = resolve;
      });
      const internals = shard as unknown as { writeCheckpoint: () => Promise<void> };
      internals.writeCheckpoint = async () => {
        await checkpoint;
        released = true;
      };

      const closing = shard.close();
      expect(released).toBe(false);
      releaseCheckpoint();
      await closing;
      expect(released).toBe(true);
    } finally {
      releaseCheckpoint?.();
      await shard.close();
    }
  });

  it("propagates checkpoint writer and final-close failures", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-checkpoint-failure-"));
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    const internals = shard as unknown as {
      createCheckpoint: () => unknown;
      writeCheckpointFile: (checkpoint: unknown, reason: string, path: string) => void;
      writeCheckpoint: (reason: string) => void;
      persistenceDirty: boolean;
    };
    const impossiblePath = path.join(tempDir, "checkpoint-as-directory");
    fs.mkdirSync(impossiblePath);
    expect(() => internals.writeCheckpointFile(internals.createCheckpoint(), "failure-test", impossiblePath)).toThrow();
    expect(internals.persistenceDirty).toBe(true);

    const originalWriteCheckpoint = internals.writeCheckpoint;
    internals.writeCheckpoint = () => {
      throw new Error("final checkpoint failed for test");
    };
    try {
      await expect(shard.close()).rejects.toThrow("final checkpoint failed for test");
    } finally {
      internals.writeCheckpoint = originalWriteCheckpoint;
      await shard.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the previous checkpoint visible when its required journal marker cannot be flushed", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-checkpoint-ordering-"));
    const checkpointPath = path.join(tempDir, "ordered.checkpoint.json");
    const journalPath = path.join(tempDir, "journal-as-directory");
    const shard = testShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      persistence: { checkpointPath, journalPath, checkpointIntervalMs: 1 },
    });
    const internals = shard as unknown as {
      appendJournal: (entry: unknown) => void;
      createCheckpoint: () => Record<string, unknown>;
      writeCheckpointFile: (checkpoint: unknown, reason: string, path: string) => void;
      journalBuffer: string[];
      persistenceDirty: boolean;
    };
    const previousCheckpoint = "previous-checkpoint-remains-visible\n";
    fs.writeFileSync(checkpointPath, previousCheckpoint);
    fs.mkdirSync(journalPath);
    internals.appendJournal({ type: "pending-test-row", tick: 1 });

    try {
      expect(() => internals.writeCheckpointFile(
        internals.createCheckpoint(),
        "ordering-failure-test",
        checkpointPath,
      )).toThrow("game shard checkpoint journal flush failed");
      expect(fs.readFileSync(checkpointPath, "utf8")).toBe(previousCheckpoint);
      expect(internals.journalBuffer.some((line) => line.includes('"type":"pending-test-row"'))).toBe(true);
      expect(internals.journalBuffer.some((line) => line.includes('"type":"checkpoint"'))).toBe(true);
      expect(fs.existsSync(`${checkpointPath}.tmp-${process.pid}`)).toBe(false);
      expect(internals.persistenceDirty).toBe(true);
    } finally {
      fs.rmSync(journalPath, { recursive: true, force: true });
      await shard.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("checkpoints autonomous Rust state-hash changes on both interval and clean close", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-autonomous-checkpoint-"));
    const checkpointPath = path.join(tempDir, "autonomous.checkpoint.json");
    const journalPath = path.join(tempDir, "autonomous.journal.jsonl");
    const live = new GameShard({
      shardId: "autonomous-checkpoint",
      slicePath,
      snapshotIntervalMs: 10_000,
      persistence: { checkpointPath, journalPath, checkpointIntervalMs: 1 },
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = live as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        pendingCount: () => number;
        debugStatus: () => null;
        exportState: () => Promise<{
          tick: number;
          stateHash: string;
          state: { schema: string; version: number; stateHash: string };
        }>;
      };
      applyRustAuthorityTickOutput: (output: RustAuthorityBridgeTickOutput) => unknown;
      maybeWriteCheckpoint: (nowMs: number) => void;
      persistenceDirty: boolean;
    };
    internals.rustAuthorityBridge?.close();
    const firstStateHash = "a".repeat(64);
    const secondStateHash = "b".repeat(64);
    let exportedTick = 51;
    let exportedStateHash = firstStateHash;
    let exportCalls = 0;
    internals.rustAuthorityBridge = {
      close: () => undefined,
      pendingCount: () => 0,
      debugStatus: () => null,
      exportState: async () => {
        exportCalls += 1;
        return {
          tick: exportedTick,
          stateHash: exportedStateHash,
          state: {
            schema: "successor.authority-state.v1",
            version: 1,
            stateHash: exportedStateHash,
          },
        };
      },
    };
    const firstAutonomousOutput: RustAuthorityBridgeTickOutput = {
      ...rustTickOutput([], 51),
      targetStateHash: firstStateHash,
      inventory: [{
        container: "player:field-pack",
        stackId: 91,
        item: "Creature Hide",
        itemId: 2101,
        variantId: 7,
        quantity: 13,
        reserved: 2,
        available: 11,
      }],
      reservations: [{
        id: 71,
        actor: "player",
        purpose: "extractor-cycle",
        from: "player:field-pack",
        item: "Creature Hide",
        quantity: 2,
        expiresAtTick: 52,
      }],
      placedExtractors: [{
        extractorId: "extractor:player:1",
        ownerActorId: "player",
        areaId: "authority-test-overworld",
        cellX: 10,
        cellY: 12,
        mode: "battery",
        biome: "desert",
        hopperPct: 10,
        collectableUnits: 1,
        batteryPct: 90,
        isOwner: false,
        familyLabel: "Mineral",
      }],
    };
    let closed = false;

    try {
      internals.applyRustAuthorityTickOutput(firstAutonomousOutput);
      expect(internals.persistenceDirty).toBe(true);

      internals.maybeWriteCheckpoint(Number.MAX_SAFE_INTEGER);
      await live.settleForDebug();
      expect(exportCalls).toBe(1);
      expect(live.status().persistence).toMatchObject({
        checkpointWriteCount: 1,
        lastCheckpointReason: "interval",
        stateHash: firstStateHash,
      });
      expect(internals.persistenceDirty).toBe(false);

      // A duplicate observation of the already-durable target state must not
      // reopen the gate by itself.
      internals.applyRustAuthorityTickOutput(firstAutonomousOutput);
      expect(internals.persistenceDirty).toBe(false);

      exportedTick = 52;
      exportedStateHash = secondStateHash;
      internals.applyRustAuthorityTickOutput({
        ...firstAutonomousOutput,
        requestId: 52,
        tick: 52,
        targetStateHash: secondStateHash,
        inventory: [{
          ...firstAutonomousOutput.inventory![0]!,
          reserved: 0,
          available: 13,
        }],
        reservations: [],
        placedExtractors: [{
          ...firstAutonomousOutput.placedExtractors![0]!,
          hopperPct: 20,
          collectableUnits: 2,
          batteryPct: 80,
        }],
      });
      expect(internals.persistenceDirty).toBe(true);

      // Model a future output adapter accidentally clearing/missing the dirty
      // signal: clean close is still a forced final-state barrier.
      internals.persistenceDirty = false;
      await live.close();
      closed = true;
      const persisted = JSON.parse(fs.readFileSync(checkpointPath, "utf8")) as {
        tick: number;
        stateHash: string;
        rustAuthority: { tick: number; stateHash: string };
      };
      expect(exportCalls).toBe(2);
      expect(persisted).toMatchObject({
        tick: 52,
        stateHash: secondStateHash,
        rustAuthority: { tick: 52, stateHash: secondStateHash },
      });
      const journalMarkers = fs.readFileSync(journalPath, "utf8")
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line) as { type?: string; reason?: string })
        .filter((entry) => entry.type === "checkpoint");
      expect(journalMarkers.map((entry) => entry.reason)).toEqual(["interval", "close"]);
    } finally {
      if (!closed) await live.close().catch(() => undefined);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
  it("does not restore TypeScript gameplay checkpoints while Rust live authority is active", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-shard-"));
    const checkpointPath = path.join(tempDir, "authority-test.checkpoint.json");
    const journalPath = path.join(tempDir, "authority-test.journal.jsonl");
    try {
      const first = testShard({
        slicePath,
        snapshotIntervalMs: 10_000,
        persistence: { checkpointPath, journalPath, checkpointIntervalMs: 1 },
      });
      try {
        const moved = first.submitCommandForTest("player", envelope(1, {
          Move: { dx: 1, dy: 0, duration_ticks: 1 },
        }));
        expect(moved.receipt.accepted).toBe(true);
        first.checkpointNowForTest();
      } finally {
        first.close();
      }

      const checkpointBefore = fs.readFileSync(checkpointPath, "utf8");
      expect(() => new GameShard({
        slicePath,
        snapshotIntervalMs: 10_000,
        persistence: { checkpointPath, journalPath, checkpointIntervalMs: 1 },
        rustAuthorityBridge: {
          enabled: true,
          command: process.execPath,
          args: ["-e", "process.stdin.resume();"],
        },
      })).toThrow(/restore failed \(rust_state_missing\); checkpoint retained/u);
      expect(fs.readFileSync(checkpointPath, "utf8")).toBe(checkpointBefore);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("awaits a forced live authority checkpoint and returns file-validated evidence", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-checkpoint-barrier-"));
    const checkpointPath = path.join(tempDir, "barrier-shard.checkpoint.json");
    const journalPath = path.join(tempDir, "barrier-shard.journal.jsonl");
    const live = new GameShard({
      shardId: "barrier-shard",
      slicePath,
      snapshotIntervalMs: 10_000,
      persistence: { checkpointPath, journalPath },
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = live as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        pendingCount: () => number;
        exportState: () => Promise<{
          tick: number;
          stateHash: string;
          state: { schema: string; version: number; stateHash: string };
        }>;
        debugStatus: () => null;
      };
    };
    internals.rustAuthorityBridge?.close();
    const stateHash = "c".repeat(64);
    let resolveExport: ((value: {
      tick: number;
      stateHash: string;
      state: { schema: string; version: number; stateHash: string };
    }) => void) | undefined;
    const exportPromise = new Promise<{
      tick: number;
      stateHash: string;
      state: { schema: string; version: number; stateHash: string };
    }>((resolve) => {
      resolveExport = resolve;
    });
    let exportCalls = 0;
    internals.rustAuthorityBridge = {
      close: () => {},
      pendingCount: () => 0,
      debugStatus: () => null,
      exportState: () => {
        exportCalls += 1;
        return exportPromise;
      },
    };

    try {
      let completed = false;
      const checkpointPromise = live.checkpoint("debug").then((evidence) => {
        completed = true;
        return evidence;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(exportCalls).toBe(1);
      expect(completed).toBe(false);
      expect(fs.existsSync(checkpointPath)).toBe(false);

      resolveExport?.({
        tick: 37,
        stateHash,
        state: { schema: "successor.authority-state.v1", version: 1, stateHash },
      });
      const evidence = await checkpointPromise;
      const persisted = JSON.parse(fs.readFileSync(checkpointPath, "utf8")) as {
        shardId: string;
        tick: number;
        stateHash: string;
        projectionStateHash: string;
        rustAuthority: { tick: number; stateHash: string };
      };

      expect(evidence).toMatchObject({
        schema: "successor.game-shard-checkpoint-evidence.v1",
        shardId: "barrier-shard",
        tick: 37,
        stateHash,
        persistence: {
          enabled: true,
          checkpointPath,
          journalPath,
          checkpointWriteCount: 1,
          lastCheckpointTick: 37,
          lastCheckpointReason: "debug",
          stateHash,
        },
      });
      expect(evidence.projectionStateHash).toHaveLength(64);
      expect(persisted).toMatchObject({
        shardId: "barrier-shard",
        tick: 37,
        stateHash,
        projectionStateHash: evidence.projectionStateHash,
        rustAuthority: { tick: 37, stateHash },
      });
      expect(fs.readFileSync(journalPath, "utf8")).toContain(`"type":"checkpoint"`);
      const bridge = internals.rustAuthorityBridge;
      if (!bridge) throw new Error("test Rust authority bridge disappeared");
      bridge.exportState = async () => {
        throw new Error("checkpoint export failed for test");
      };
      await expect(live.checkpoint("debug")).rejects.toMatchObject({
        name: "GameShardCheckpointError",
        code: "checkpoint_failed",
      });
    } finally {
      if (internals.rustAuthorityBridge) {
        internals.rustAuthorityBridge.exportState = async () => ({
          tick: 37,
          stateHash,
          state: { schema: "successor.authority-state.v1", version: 1, stateHash },
        });
      }
      await live.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a public checkpoint when checkpoint persistence is disabled", async () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      await expect(shard.checkpoint()).rejects.toMatchObject({
        name: "GameShardCheckpointError",
        code: "persistence_disabled",
      });
    } finally {
      shard.close();
    }
  });

  it("pauses live Rust authority ticks while no clients observe the shard", () => {
    const live = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const liveInternals = live as unknown as {
      rustAuthorityBridge?: { close: () => void };
      flushSnapshots: (options?: { force?: boolean }) => void;
    };
    liveInternals.rustAuthorityBridge?.close();
    let submitTickCalls = 0;
    const fakeBridge = {
      submitTick: () => {
        submitTickCalls += 1;
        return Promise.resolve({});
      },
      close: () => {},
      debugStatus: () => null,
    };
    liveInternals.rustAuthorityBridge = fakeBridge as unknown as { close: () => void };

    try {
      liveInternals.flushSnapshots({});

      expect(submitTickCalls).toBe(0);
      expect(live.status().tick).toBe(24);
    } finally {
      live.close();
    }
  });

  it("advances live Rust authority as single fixed ticks without catch-up batching", async () => {
    const live = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const liveInternals = live as unknown as {
      rustAuthorityBridge?: { close: () => void };
      advanceLiveRustAuthorityTick: (options?: { force?: boolean }) => Promise<void>;
    };
    liveInternals.rustAuthorityBridge?.close();
    const tickRequests: number[] = [];
    let resolveTick: ((output: RustAuthorityBridgeTickOutput) => void) | undefined;
    const fakeBridge = {
      submitTick: (request: { ticks: number }) => {
        tickRequests.push(request.ticks);
        return new Promise<RustAuthorityBridgeTickOutput>((resolve) => {
          resolveTick = resolve;
        });
      },
      close: () => {},
      debugStatus: () => null,
    };
    liveInternals.rustAuthorityBridge = fakeBridge as unknown as { close: () => void };

    try {
      const pending = liveInternals.advanceLiveRustAuthorityTick({ force: true });
      await Promise.resolve();
      expect(tickRequests).toEqual([1]);

      await liveInternals.advanceLiveRustAuthorityTick({ force: true });
      expect(tickRequests).toEqual([1]);
      expect(live.status().authority.cadence).toMatchObject({
        clockSource: "rust-fixed-interval",
        skippedInFlight: 1,
        lastTickCount: 1,
        maxTickCount: 1,
      });

      resolveTick?.({ tick: 25, actors: [], combatEvents: [] });
      await pending;
      expect(live.status().tick).toBe(25);
    } finally {
      live.close();
    }
  });
  it("uses the authored player cell as the no-position character enter default", () => {
    const shard = testShard({ slicePath: currentRuntimeSlicePath, snapshotIntervalMs: 10_000 });
    try {
      expect(shard.defaultJoinSpawnForActor("char_fresh")).toEqual({
        areaId: "open-desert-overworld",
        x: 516,
        y: 511,
        facing: "front",
      });
    } finally {
      shard.close();
    }
  });

  it("uses the authored default only for a new actor missing spawn and preserves explicit durable position", () => {
    const shard = testShard({ slicePath: currentRuntimeSlicePath, snapshotIntervalMs: 10_000 });
    try {
      const internals = shard as unknown as {
        ensureActor: (identity: GameSessionIdentity, options?: { applySpawn?: boolean; applyGameplaySeed?: boolean }) => { x: number; y: number };
      };
      const identity: GameSessionIdentity = {
        actorId: "fresh-missing-spawn",
        playerId: "fresh-missing-spawn",
        characterId: "fresh-missing-spawn",
        displayName: "Fresh Missing Spawn",
        zoneId: "open-desert",
      };
      expect(internals.ensureActor(identity)).toMatchObject({ x: 516, y: 511 });
      expect(internals.ensureActor({
        ...identity,
        spawn: { areaId: "open-desert-overworld", x: 300, y: 400, facing: "right" },
      })).toMatchObject({ x: 300, y: 400 });
      expect(internals.ensureActor(identity)).toMatchObject({ x: 300, y: 400 });
    } finally {
      shard.close();
    }
  });

  it("keeps Rust actor projection lifecycle monotonic while applying profession detail", () => {
    const shard = testShard({ slicePath: currentRuntimeSlicePath, snapshotIntervalMs: 10_000 });
    try {
      const internals = shard as unknown as {
        actors: Map<string, {
          lifecycleSeq: number;
          professions?: Array<{ id: string; skillBoxes?: string[] }>;
          credits?: number;
          careerGoalId?: string | null;
          skillPointsCap?: number;
        }>;
        highDetailDirtyActorIds: Set<string>;
        applyRustAuthorityTickOutput: (output: RustAuthorityBridgeTickOutput) => GameCombatEvent[];
      };
      const player = internals.actors.get("player");
      expect(player).toBeDefined();
      player!.lifecycleSeq = 9;

      internals.applyRustAuthorityTickOutput({
        schema: "successor.rust-authority-bridge-tick.v1",
        requestId: 17,
        tick: 120,
        targetStateHash: "test-profession-lifecycle-monotonic",
        actors: [rustActorSnapshot({
          id: "player",
          label: "Medic Verifier",
          lifecycleSeq: 1,
          x: 24,
          y: 56,
          professions: [{
            id: "medic",
            label: "Medic",
            xp: 0,
            skillPoints: 0,
            skillBoxes: ["medic-novice"],
          }, {
            id: "marksman",
            label: "Marksman",
            xp: 0,
            skillPoints: 0,
            skillBoxes: ["marksman-novice"],
          }],
          activeTitle: {
            id: "medic-novice",
            label: "Novice Medic",
            skillBoxId: "medic-novice",
          },
          careerGoal: {
            id: "rifle_quartermaster",
            label: "Rifle Quartermaster",
            targetSkillPoints: 250,
            ownedTargetSkillBoxes: 2,
            targetSkillBoxes: 8,
            extraSkillBoxes: [],
            nextSkillBoxId: "marksman-rifle-ii",
            primaryWeaponId: "slugthrower",
          },
          skillPointsUsed: 0,
          skillPointsCap: 250,
          credits: 5000,
        })],
        combatEvents: [],
        inventory: [],
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
        metrics: {
          tick: 120,
          shotsFired: 0,
          combatEvents: 0,
          hits: 0,
          deaths: 0,
          inventoryStacks: 0,
          reservations: 0,
          npcJobs: 0,
          timelineEvents: 0,
        },
      });

      expect(player).toMatchObject({
        lifecycleSeq: 9,
        credits: 5000,
        skillPointsCap: 250,
        careerGoalId: "rifle_quartermaster",
      });
      expect(player?.professions?.find((profession) => profession.id === "medic")?.skillBoxes).toContain("medic-novice");
      expect(internals.highDetailDirtyActorIds.has("player")).toBe(true);
      expect(shard.snapshotFor("player").actors.player).toMatchObject({
        lifecycleSeq: 9,
        credits: 5000,
        skillPointsCap: 250,
        careerGoalId: "rifle_quartermaster",
        professions: expect.arrayContaining([
          expect.objectContaining({ id: "medic", skillBoxes: ["medic-novice"] }),
        ]),
      });
    } finally {
      shard.close();
    }
  });

  it("preserves each concurrent session's professions when a later Rust sync omits them (DEF-2)", () => {
    const shard = testShard({ slicePath: currentRuntimeSlicePath, snapshotIntervalMs: 10_000 });
    try {
      const internals = shard as unknown as {
        actors: Map<string, { professions?: Array<{ id: string; trackXp?: Record<string, number> }> }>;
        applyRustAuthorityTickOutput: (output: RustAuthorityBridgeTickOutput) => GameCombatEvent[];
      };
      const metrics = {
        tick: 120, shotsFired: 0, combatEvents: 0, hits: 0, deaths: 0, inventoryStacks: 0,
        reservations: 0, npcJobs: 0, timelineEvents: 0,
      };
      const emptyLanes = {
        schema: "successor.rust-authority-bridge-tick.v1" as const,
        combatEvents: [], inventory: [], reservations: [], npcJobs: [], timelineEvents: [],
      };
      const rifleProfession = (xp: number) => [{
        id: "marksman", label: "Marksman", xp, skillPoints: 0, trackXp: { rifle: xp }, skillBoxes: [] as string[],
      }];
      // Two concurrent session actors both carry Rust professions on the first sync tick.
      internals.applyRustAuthorityTickOutput({
        ...emptyLanes, requestId: 40, tick: 120, targetStateHash: "def2-two-session-both", metrics,
        actors: [
          rustActorSnapshot({ id: "player", label: "SessionA", x: 20, y: 20, professions: rifleProfession(100) }),
          rustActorSnapshot({ id: "def2-session-b", label: "SessionB", x: 22, y: 20, professions: rifleProfession(80) }),
        ],
      });
      // Invariant: every session's TS mirror reflects its Rust professions/XP.
      expect(internals.actors.get("player")?.professions?.[0]?.trackXp?.rifle).toBe(100);
      expect(internals.actors.get("def2-session-b")?.professions?.[0]?.trackXp?.rifle).toBe(80);
      // A later sync OMITS session-b's professions (Rust skips empty / interest-managed).
      internals.applyRustAuthorityTickOutput({
        ...emptyLanes, requestId: 41, tick: 121, targetStateHash: "def2-omit-preserves",
        metrics: { ...metrics, tick: 121 },
        actors: [rustActorSnapshot({ id: "def2-session-b", label: "SessionB", x: 23, y: 20 })],
      });
      // preserve-on-omit (C3 delta convention): the omit must NOT zero the earned XP.
      expect(internals.actors.get("def2-session-b")?.professions?.[0]?.trackXp?.rifle).toBe(80);
    } finally {
      shard.close();
    }
  });

  it("preserves progression weapon ids and canonical item ids in server snapshots", () => {
    const shard = testShard({ slicePath: currentRuntimeSlicePath, snapshotIntervalMs: 10_000 });
    try {
      const internals = shard as unknown as {
        actors: Map<string, { weapon?: RustAuthorityActorWeaponSnapshot | null }>;
        applyRustAuthorityTickOutput: (output: RustAuthorityBridgeTickOutput) => GameCombatEvent[];
      };
      const weaponRows = [
        ["field-probe", "field-saber", 3106, "field-saber"],
        ["quarry-probe", "quarry-chopper", 3107, "quarry-chopper"],
        ["kiln-probe", "wpn-carbine", 3112, "wpn-carbine"],
        ["lightning-probe", "lightning-carbine", 3121, "lightning-carbine"],
        ["pistol-probe", "wpn-pistol", 3122, "wpn-pistol"],
        ["assault-probe", "wpn-assault", 3123, "wpn-assault"],
        ["shotgun-probe", "wpn-shotgun", 3124, "wpn-shotgun"],
        ["sniper-probe", "wpn-sniper", 3125, "wpn-sniper"],
        ["heavy-probe", "wpn-heavy", 3126, "wpn-heavy"],
        ["launcher-probe", "wpn-launcher", 3127, "wpn-launcher"],
      ] as const;
      internals.applyRustAuthorityTickOutput({
        schema: "successor.rust-authority-bridge-tick.v1",
        requestId: 39,
        tick: 119,
        targetStateHash: "progression-weapon-snapshots",
        metrics: {
          tick: 119,
          shotsFired: 0,
          combatEvents: 0,
          hits: 0,
          deaths: 0,
          inventoryStacks: 0,
          reservations: 0,
          npcJobs: 0,
          timelineEvents: 0,
        },
        actors: weaponRows.map(([id, rustId, itemId]) => rustActorSnapshot({
          id,
          label: id,
          x: 20,
          y: 20,
          weapon: rustWeaponSnapshot(rustId, itemId),
        })),
        combatEvents: [],
        inventory: [],
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
      });
      for (const [id, , itemId, expectedWeaponId] of weaponRows) {
        expect(internals.actors.get(id)?.weapon).toMatchObject({
          weaponId: expectedWeaponId,
          weaponItemId: itemId,
        });
      }
    } finally {
      shard.close();
    }
  });

  it("equips concrete ranged inventory items by id and preserves item variants", () => {
    const shard = testShard({ slicePath: currentRuntimeSlicePath, snapshotIntervalMs: 10_000 });
    try {
      const concreteWeapons = [
        [3122, "wpn-pistol"],
        [3123, "wpn-assault"],
        [3124, "wpn-shotgun"],
        [3125, "wpn-sniper"],
        [3126, "wpn-heavy"],
        [3127, "wpn-launcher"],
      ] as const;
      for (const [index, [itemId, weaponId]] of concreteWeapons.entries()) {
        const variantId = 80_000 + index;
        const granted = shard.submitCommandForTest("player", envelope(index * 2 + 1, {
          DebugGiveItem: { item_id: itemId, variant_id: variantId, quantity: 1 },
        }), undefined, true);
        expect(granted.receipt).toMatchObject({ accepted: true });

        const equipped = shard.submitCommandForTest("player", envelope(index * 2 + 2, {
          SetEquippedWeapon: {
            weapon_id: weaponId,
            weapon_item_id: itemId,
            weapon_variant_id: variantId,
          },
        }));
        expect(equipped.receipt).toMatchObject({ accepted: true });
        expect(shard.snapshotFor("player").actors.player?.weapon).toMatchObject({
          weaponId,
          weaponItemId: itemId,
          weaponVariantId: variantId,
        });
      }

      const retired = shard.submitCommandForTest("player", envelope(99, {
        SetEquippedWeapon: { weapon_item_id: 3113 },
      }));
      expect(retired.receipt).toMatchObject({ accepted: false, reasonCode: "unknown_item" });
    } finally {
      shard.close();
    }
  });

  it("preserves an actor's weapon when a later Rust sync omits the weapon field", () => {
    const shard = testShard({ slicePath: currentRuntimeSlicePath, snapshotIntervalMs: 10_000 });
    try {
      const internals = shard as unknown as {
        actors: Map<string, { weapon?: RustAuthorityActorWeaponSnapshot | null }>;
        applyRustAuthorityTickOutput: (output: RustAuthorityBridgeTickOutput) => GameCombatEvent[];
      };
      const metrics = {
        tick: 120, shotsFired: 0, combatEvents: 0, hits: 0, deaths: 0, inventoryStacks: 0,
        reservations: 0, npcJobs: 0, timelineEvents: 0,
      };
      const emptyLanes = {
        schema: "successor.rust-authority-bridge-tick.v1" as const,
        combatEvents: [], inventory: [], reservations: [], npcJobs: [], timelineEvents: [],
      };
      internals.applyRustAuthorityTickOutput({
        ...emptyLanes,
        requestId: 42,
        tick: 120,
        targetStateHash: "weapon-omit-seed",
        metrics,
        actors: [rustActorSnapshot({
          id: "player",
          label: "WeaponKeep",
          x: 20,
          y: 20,
          weapon: rustWeaponSnapshot("slugthrower", 3101),
        })],
      });
      expect(internals.actors.get("player")?.weapon).toMatchObject({ weaponId: "slugthrower", weaponItemId: 3101 });

      internals.applyRustAuthorityTickOutput({
        ...emptyLanes,
        requestId: 43,
        tick: 121,
        targetStateHash: "weapon-omit-preserves",
        metrics: { ...metrics, tick: 121 },
        actors: [rustActorSnapshot({ id: "player", label: "WeaponKeep", x: 21, y: 20 })],
      });

      expect(internals.actors.get("player")?.weapon).toMatchObject({ weaponId: "slugthrower", weaponItemId: 3101 });

      internals.applyRustAuthorityTickOutput({
        ...emptyLanes,
        requestId: 44,
        tick: 122,
        targetStateHash: "weapon-null-clears",
        metrics: { ...metrics, tick: 122 },
        actors: [rustActorSnapshot({ id: "player", label: "WeaponKeep", x: 22, y: 20, weapon: null })],
      });

      expect(internals.actors.get("player")?.weapon).toBeNull();
    } finally {
      shard.close();
    }
  });

  it("hands the claimed runtime player to Rust authority with its authored profession state", () => {
    const shard = testShard({ slicePath: currentRuntimeSlicePath, snapshotIntervalMs: 10_000 });
    try {
      shard.connect(controlledSocket(), {
        actorId: "runtime-player",
        playerId: "runtime-player",
        displayName: "Runtime Player",
        zoneId: "open-desert",
        spawn: { areaId: "open-desert-overworld", x: 512, y: 513, facing: "right" },
      });
      const internals = shard as unknown as {
        actors: Map<string, unknown>;
        rustActorIdFor: (actorId: string) => string;
        rustActorUpsertInput: (actor: unknown, rustActorId: string) => {
          id: string;
          professionIds?: string[];
          skillBoxIds?: string[];
        };
      };
      const runtimePlayer = internals.actors.get("runtime-player");
      expect(runtimePlayer).toBeDefined();
      const rustActorId = internals.rustActorIdFor("runtime-player");
      expect(rustActorId).toBe("player");
      const playerUpsert = internals.rustActorUpsertInput(runtimePlayer, rustActorId);
      expect(playerUpsert.professionIds).toEqual(["marksman"]);
      expect(playerUpsert.skillBoxIds).toEqual(["marksman-novice", "marksman-rifle-i"]);
    } finally {
      shard.close();
    }
  });
  it("keeps a fresh Brawler's explicit null active title when claiming the authored player placeholder", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const characterId = "fresh-brawler";
      const identity: GameSessionIdentity = {
        ...testCharacterIdentity(characterId),
        playerId: "profile-brawler",
        ownerRef: "profile-brawler",
        displayName: "Fresh Brawler",
        professionIds: ["brawler"],
        skillBoxIds: ["brawler-novice"],
        activeTitleId: null,
        returningCharacter: false,
      };
      shard.connect(controlledSocket(), identity);

      const internals = shard as unknown as {
        actors: Map<string, {
          activeTitle?: { id?: string };
          activeTitleId?: string | null;
        }>;
        rustActorIdFor: (actorId: string) => string;
        rustActorUpsertInput: (actor: unknown, rustActorId: string) => {
          activeTitleId?: string | null;
        };
      };
      const actor = internals.actors.get(characterId);
      expect(actor).toMatchObject({
        activeTitle: { id: "brawler-novice" },
        activeTitleId: null,
      });
      expect(internals.rustActorIdFor(characterId)).toBe("player");
      expect(internals.rustActorUpsertInput(actor, "player").activeTitleId).toBeNull();
    } finally {
      shard.close();
    }
  });

  it("uses the wide active overworld bounds for authoritative movement", () => {
    const shard = testShard({ slicePath: currentRuntimeSlicePath, snapshotIntervalMs: 10_000 });
    try {
      const source = JSON.parse(fs.readFileSync(currentRuntimeSlicePath, "utf8")) as {
        stateHash: string;
        actors: unknown[];
        spawnZones: Array<{ initialCount?: number }>;
        areas: Array<{ id: string; width: number; height: number }>;
      };
      const overworld = source.areas.find((area) => area.id === "open-desert-overworld");
      expect(overworld).toMatchObject({ id: "open-desert-overworld", width: 1024, height: 1024 });

      const status = shard.status();
      expect(status.source.stateHash).toBe(source.stateHash);
      expect(source.actors).toHaveLength(3);
      // Source count is authored actors plus the initial population declared by each dormant spawn zone.
      const expectedSourceActorCount = source.actors.length + source.spawnZones.reduce(
        (total, zone) => total + (typeof zone.initialCount === "number" && Number.isFinite(zone.initialCount) ? zone.initialCount : 0),
        0,
      );
      expect(status.source.actorCount).toBe(expectedSourceActorCount);
      expect(status.source.areas.find((area) => area.id === "open-desert-overworld")).toEqual({
        id: "open-desert-overworld",
        width: overworld?.width,
        height: overworld?.height,
        biome: "desert",
        // Every area now advertises its active resource spawns (survey era);
        // this runtime fixture has none seeded.
        resourceSpawns: [],
        // Area status reports materialized actors; spawn-zone populations stay
        // dormant until authority activates them.
        actorCount: 3,
      });

      shard.connect(fakeSocket(), {
        actorId: "boundary-probe",
        playerId: "boundary-probe",
        displayName: "Boundary Probe",
        zoneId: "open-desert",
        spawn: { areaId: "open-desert-overworld", x: 512, y: 513, facing: "right" },
      });

      const before = shard.snapshotFor("boundary-probe").actors["boundary-probe"];
      expect(before).toMatchObject({ x: 512, y: 513 });

      const result = shard.submitCommandForTest("boundary-probe", envelope(1, {
        Move: { dx: 1, dy: 0, duration_ticks: 24, facing: "Right" },
      }));
      expect(result.receipt.accepted).toBe(true);
      expect(shard.snapshotFor("boundary-probe").actors["boundary-probe"]?.x).toBeGreaterThan(512);
    } finally {
      shard.close();
    }
  });

  it("routes SetEquippedClothing as the exact Rust envelope and persists worn palettes without loss", async () => {
    const submittedEnvelopes: ClientCommandEnvelope[] = [];
    const savedSnapshots: GameActorSnapshot[] = [];
    const shard = new GameShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      characterPersistence: {
        saveSnapshot: (_characterId, snapshot) => savedSnapshots.push(snapshot),
      },
      rustAuthorityBridge: {
        enabled: true,
        command: process.execPath,
        args: ["-e", "process.stdin.resume();"],
      },
    });
    const internals = shard as unknown as {
      rustAuthorityBridge?: {
        close: () => void;
        submitActor?: (input: unknown) => Promise<unknown>;
        submitCommand?: (input: { actorId: string; envelope: ClientCommandEnvelope }) => Promise<unknown>;
        debugStatus?: () => unknown;
      };
    };
    internals.rustAuthorityBridge?.close();
    internals.rustAuthorityBridge = {
      close: () => {},
      debugStatus: () => null,
      submitActor: async () => ({}),
      submitCommand: async ({ envelope }) => {
        submittedEnvelopes.push(envelope);
        return {
          status: "accepted",
          reasonCode: null,
          tick: 31,
          commandId: envelope.command_id,
          actor: rustActorSnapshot({
            id: "player",
            worn: [
              { item: "under_bodysuit", colors: ["#89cff0"] },
              { item: "legs_wrapped_workpants", colors: ["#445566"] },
            ],
          }),
          actors: [],
          combatEvents: [],
          inventory: [
            {
              container: "player:field-pack",
              stackId: 3,
              item: "under_bodysuit",
              itemId: 9_900_001,
              variantId: 0,
              quantity: 1,
              reserved: 0,
              equipped: true,
              colors: ["#89cff0"],
              available: 1,
            },
            {
              container: "player:field-pack",
              stackId: 1,
              item: "Top",
              itemId: 7301,
              variantId: 0,
              quantity: 1,
              reserved: 0,
              equipped: false,
              colors: ["#112233"],
              available: 1,
            },
            {
              container: "player:field-pack",
              stackId: 2,
              item: "Legs",
              itemId: 7302,
              variantId: 0,
              quantity: 1,
              reserved: 0,
              equipped: true,
              colors: ["#445566"],
              available: 1,
            },
          ],
          reservations: [],
          npcJobs: [],
          timelineEvents: [],
        };
      },
    };
    const socket = controlledSocket();
    try {
      shard.connect(socket, {
        ...testCharacterIdentity("character-clothing"),
        characterId: "character-clothing",
        wornColors: { top_rogue_drifter: ["#778899"] },
      });
      socket.emitMessage(JSON.stringify({
        type: "game.command",
        envelope: envelope(1, { SetEquippedClothing: { item_id: 7302, equipped: true } }),
      }));
      await waitFor(() => packets(socket).some((packet) => (
        packet.type === "game.delta"
        && packet.receipts?.some((receipt: { commandId?: number; accepted?: boolean }) => receipt.commandId === 1 && receipt.accepted)
      )));

      expect(submittedEnvelopes).toEqual([
        envelope(1, { SetEquippedClothing: { item_id: 7302, equipped: true } }),
      ]);
      const saved = savedSnapshots.at(-1);
      expect(saved?.worn).toEqual([
        { item: "under_bodysuit", colors: ["#89cff0"] },
        { item: "legs_wrapped_workpants", colors: ["#445566"] },
      ]);
      expect(saved?.wornColors).toEqual({
        top_rogue_drifter: ["#778899"],
        under_bodysuit: ["#89cff0"],
        legs_wrapped_workpants: ["#445566"],
      });
    } finally {
      shard.close();
    }
  });


  it("keeps bank private, projects public corpse loot, and clears authoritative corpse rows", async () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    try {
      const owner = shard.snapshotFor("player").actors.player;
      const observer = shard.snapshotFor("vendor").actors.vendor;
      expect(owner).toBeDefined();
      expect(observer).toBeDefined();
      const internals = shard as unknown as {
        syncRustBankProjection: (bank: unknown, fallbackActorId?: string) => void;
        syncRustPlayerCorpses: (corpses: unknown[]) => void;
        snapshotForSession: (session: unknown) => { bank?: unknown; playerCorpses?: Array<{ id: string; isOwner: boolean }> };
        playerCorpsesForObserver: (observerActor: unknown, session?: unknown, center?: unknown) => Array<{ id: string; isOwner: boolean }>;
        lootSourceForContainer: (container: string) => { areaId: string; xMilli: number; yMilli: number; lootRightsActorId: string | null } | null;
        inventory: Array<{ container: string }>;
      };
      internals.syncRustBankProjection({
        actorId: "player",
        bankCredits: 777,
        items: [{
          container: "bank:player",
          stackId: "a".repeat(64) + ".crafted",
          item: "Named",
          itemId: 9001,
          variantId: 1,
          quantity: 1,
          reserved: 0,
          available: 1,
        }],
        backupPresent: true,
        backupSavedTick: 12,
        backupSkillCount: 3,
        backupCost: 1000,
      });
      internals.syncRustPlayerCorpses([
        {
          ownerActorId: "player",
          id: "player-corpse:1", ownerLabel: "Player",
          areaId: owner!.areaId, cell: { x: owner!.x, y: owner!.y }, position: { x: owner!.x * 1000, y: owner!.y * 1000 },
          expiryTick: 100, hasItems: true, creditsPresent: true, creditsCount: 10, isOwner: true,
          container: "corpse:player-corpse:1",
        },
        {
          ownerActorId: "far-owner",
          id: "player-corpse:2", ownerLabel: "Far",
          areaId: owner!.areaId, cell: { x: owner!.x + 500, y: owner!.y }, position: { x: (owner!.x + 500) * 1000, y: owner!.y * 1000 },
          expiryTick: 100, hasItems: true, creditsPresent: false, creditsCount: 0, isOwner: true,
          container: "corpse:player-corpse:2",
        },
      ]);
      const ownerSession = privateDeltaSession("owner", "player", owner!);
      const observerSession = privateDeltaSession("observer", "vendor", observer!);
      expect(internals.snapshotForSession(ownerSession).bank).toMatchObject({ credits: 777 });
      expect(internals.snapshotForSession(observerSession).bank).toBeNull();
      expect(internals.snapshotForSession(ownerSession).playerCorpses?.map((row) => row.id)).toEqual(["player-corpse:1"]);
      expect(internals.snapshotForSession(ownerSession).playerCorpses?.[0]?.isOwner).toBe(true);
      expect(internals.playerCorpsesForObserver(observer, undefined, owner)[0]?.isOwner).toBe(false);
      expect(internals.lootSourceForContainer("corpse:player-corpse:1")).toEqual({
        areaId: owner!.areaId,
        xMilli: owner!.x * 1000,
        yMilli: owner!.y * 1000,
        lootRightsActorId: null,
      });
      internals.inventory.push({ container: "bank:player" });
      const oracle = await shard.debugOracle({ refreshAiDebug: false });
      expect(oracle.inventory.some((row) => row.container.startsWith("bank:"))).toBe(false);
      expect(oracle).not.toHaveProperty("playerCorpses");
      expect(JSON.stringify(oracle)).not.toContain("far-owner");
      internals.syncRustPlayerCorpses([]);
      expect(internals.snapshotForSession(ownerSession).playerCorpses).toEqual([]);
    } finally {
      shard.close();
    }
  });
  it("routes Rust dialogue deliveries once to near same-area sessions and ignores invalid or far rows", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000, areaInterestRadiusCells: 2 });
    const identity = testCharacterIdentity("bark-observer");
    const socket = controlledSocket();
    shard.connect(socket, identity);
    try {
      const internals = shard as unknown as {
        queueDialogueDeliveries: (rows: Array<Record<string, unknown>>) => void;
        sessions: Map<string, { pendingDialogueDeliveries: unknown[] }>;
      };
      const session = [...internals.sessions.values()][0];
      expect(session).toBeDefined();

      internals.queueDialogueDeliveries([
        { actorId: identity.actorId, body: "  Hold fast.  ", areaId: "authority-test-overworld", x: 11000, y: 17000, tick: 17 },
        { actorId: identity.actorId, body: "far", areaId: "authority-test-overworld", x: 99000, y: 99000, tick: 17 },
        { actorId: identity.actorId, body: "wrong area", areaId: "other-area", x: 11000, y: 17000, tick: 17 },
        { actorId: identity.actorId, areaId: "authority-test-overworld", x: 11000, y: 17000, tick: 17 },
        { actorId: identity.actorId, body: "bad position", areaId: "authority-test-overworld", x: "nope", y: 17000, tick: 17 },
      ]);
      expect(session!.pendingDialogueDeliveries).toEqual([expect.objectContaining({
        actorId: identity.actorId,
        speaker: expect.any(String),
        body: "Hold fast.",
        x: 11,
        y: 17,
      })]);
      shard.flushSnapshotsForTest();
      expect(session!.pendingDialogueDeliveries).toEqual([]);
      shard.flushSnapshotsForTest();
      expect(session!.pendingDialogueDeliveries).toEqual([]);
    } finally {
      socket.emitClose();
      shard.close();
    }
  });
  it("projects guild views as full replacements, preserves privacy, and resolves character chat identity", () => {
    const shard = testShard({ slicePath });
    const internals = shard as unknown as {
      syncRustGuildViews(output: { guildViewsByActorId: Record<string, unknown> }): void;
      actors: Map<string, { playerOrganizationId?: string | null; areaId: string; x: number; y: number }>;
      characterActorIds: Map<string, string>;
    };
    internals.actors.get("player")!.playerOrganizationId = "guild-a";
    internals.characterActorIds.set("character-a", "player");
    expect(shard.guildIdForActor("character-a")).toBe("guild-a");
    expect(shard.chatPositionForActor("character-a")).toEqual({
      areaId: "authority-test-overworld",
      x: expect.any(Number),
      y: expect.any(Number),
    });
    internals.actors.get("player")!.areaId = "clone-interior";
    internals.actors.get("player")!.x = 12.5;
    internals.actors.get("player")!.y = 8.25;
    expect(shard.chatPositionForActor("character-a")).toEqual({
      areaId: "clone-interior",
      x: 12.5,
      y: 8.25,
    });
    internals.syncRustGuildViews({
      guildViewsByActorId: {
        player: {
          guild: {
            id: "guild-a",
            name: "Dust",
            tag: "DST",
            leaderActorId: "player",
            createdTick: 4,
            memberCount: 2,
            wars: [],
          },
          roster: [{
            actorId: "player",
            name: "Player",
            role: "leader",
            permissions: ["invite", "kick", "roles", "war", "disband"],
            online: true,
            areaId: "open-desert-overworld",
            lastSeenTick: 4,
          }],
          pendingInvites: [],
          directory: [{ id: "guild-a", name: "Dust", tag: "DST", memberCount: 2 }],
        },
      },
    });
    expect(shard.snapshotFor("player").guilds).toMatchObject({
      guild: { id: "guild-a", leaderActorId: "player" },
      roster: [{ actorId: "player", areaId: "open-desert-overworld" }],
      directory: [{ id: "guild-a" }],
    });
    internals.syncRustGuildViews({ guildViewsByActorId: {} });
    expect(shard.snapshotFor("player").guilds).toEqual({
      roster: [],
      pendingInvites: [],
      directory: [],
    });
    internals.syncRustGuildViews({ guildViewsByActorId: { player: { roster: [], pendingInvites: [], directory: [] } } });
    expect(shard.guildIdForActor("character-a")).toBeNull();
    internals.actors.get("player")!.playerOrganizationId = null;
    expect(shard.guildIdForActor("character-a")).toBeNull();
    shard.close();
  });
  it("refreshes an outsider directory in the receipt delta after connecting before GuildCreate", () => {
    const shard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
    const outsiderSocket = controlledSocket();
    const creatorSocket = controlledSocket();
    const outsiderId = "guild-directory-outsider";
    const creatorId = "guild-directory-creator";
    try {
      // The outsider is already connected before the creator mutates Rust guild state.
      shard.connect(outsiderSocket, testCharacterIdentity(outsiderId));
      shard.connect(creatorSocket, testCharacterIdentity(creatorId));

      const internals = shard as unknown as {
        sessions: Map<string, { actorId: string }>;
        syncRustGuildViews(output: { guildViewsByActorId: Record<string, unknown> }): void;
        deltaForSession(session: { actorId: string }, focusActorIds: string[]): GameShardDelta;
      };
      internals.syncRustGuildViews({
        guildViewsByActorId: {
          [creatorId]: {
            guild: {
              id: "guild-dust",
              name: "Dust Wardens",
              tag: "DUST",
              leaderActorId: creatorId,
              createdTick: 9,
              memberCount: 1,
              wars: [],
            },
            roster: [{
              actorId: creatorId,
              name: creatorId,
              role: "leader",
              permissions: ["invite", "kick", "roles", "war", "disband"],
              online: true,
              areaId: "authority-test-overworld",
              lastSeenTick: 9,
            }],
            pendingInvites: [],
            directory: [{ id: "guild-dust", name: "Dust Wardens", tag: "DUST", memberCount: 1 }],
          },
          [outsiderId]: {
            roster: [],
            pendingInvites: [],
            directory: [{ id: "guild-dust", name: "Dust Wardens", tag: "DUST", memberCount: 1 }],
          },
        },
      });

      const outsiderSession = [...internals.sessions.values()].find((session) => session.actorId === outsiderId);
      expect(outsiderSession).toBeDefined();
      const delta = internals.deltaForSession(outsiderSession!, []);
      expect(delta.guilds).toEqual({
        roster: [],
        pendingInvites: [],
        directory: [{ id: "guild-dust", name: "Dust Wardens", tag: "DUST", memberCount: 1 }],
      });
      expect(JSON.stringify(delta.guilds)).not.toContain(creatorId);
    } finally {
      outsiderSocket.emitClose();
      creatorSocket.emitClose();
      shard.close();
    }
  });




  it("spawns fresh first entry at clone facility shelter under active weather without health loss", async () => {
    const previousForcePhase = process.env.GAME_WEATHER_FORCE_PHASE;
    const previousPinCenter = process.env.GAME_WEATHER_PIN_CENTER;
    process.env.GAME_WEATHER_FORCE_PHASE = "active";
    process.env.GAME_WEATHER_PIN_CENTER = "1";
    const characterId = "fresh-entry-shelter";
    const facility = {
      id: "dustgate-cloning-facility",
      label: "Dustgate Cloning Facility",
      areaId: "authority-test-overworld",
      respawnCell: { x: 12, y: 10 },
      respawnFacing: "front",
      sicknessDurationMs: 30_000,
    };
    const { tempDir, slicePath: tempSlicePath } = writeTempSlice({
      actors: [
        actorFixture("player", "Test Player", "adventurer-premium-male", { x: 30, y: 20 }, "player"),
      ],
      cloneFacilities: [facility],
      props: [{
        id: "dustgate-cloning-facility",
        entity: "prop:dustgate-cloning-facility",
        areaId: "authority-test-overworld",
        label: "Dustgate Cloning Facility",
        kind: "building",
        cell: { x: 10, y: 8 },
        size: { w: 5, h: 4 },
        interactive: false,
        solid: false,
        shelter: true,
        door: {
          blocker: { xMilli: 2420, yMilli: 3705, wMilli: 1240, hMilli: 295, id: "closed_door_panel" },
          interactRadiusCells: 2.2,
        },
      }],
      weather: [{
        areaId: "authority-test-overworld",
        eventType: "sandstorm",
        centerCell: { x: 12, y: 10 },
        radiusCells: 48,
        spawnRadiusCells: 8,
        magnitudeRange: [1, 1],
        periodTicks: { idle: 10, warning: 4, active: 6, decay: 5 },
        dpsMilliHealth: 8_000,
        phaseOffsetTicks: 0,
      }],
    });
    const claimed: string[] = [];
    const shard = testShard({
      slicePath: tempSlicePath,
      snapshotIntervalMs: 10_000,
      characterPersistence: {
        hasCharacter: (candidate) => candidate === characterId,
        claimWorldEntry: (candidate) => {
          claimed.push(candidate);
          return { returning: false };
        },
        saveSnapshot: () => undefined,
      },
    });
    const internals = shard as unknown as {
      checkpoint: (reason?: string) => Promise<unknown>;
      actors: Map<string, {
        x: number;
        y: number;
        areaId: string;
        vitals: { health: number; action: number; spirit: number };
        professionIds?: string[];
        skillBoxIds?: string[];
      }>;
      claimedAuthoredPlaceholders: Map<string, string>;
      authoredPlaceholderOwners: Map<string, string>;
    };
    const authoredPlayer = internals.actors.get("player");
    expect(authoredPlayer).toBeDefined();
    authoredPlayer!.professionIds = ["marksman"];
    authoredPlayer!.skillBoxIds = ["marksman-novice", "marksman-rifle-i"];
    // Local first-entry waits on checkpoint before hello; resolve without durable files.
    internals.checkpoint = async (reason?: string) => {
      expect(reason).toBe("character-first-entry");
      const actor = internals.actors.get(characterId);
      expect(actor).toMatchObject({
        areaId: facility.areaId,
        x: facility.respawnCell.x,
        y: facility.respawnCell.y,
        vitals: { health: 100 },
      });
      return {};
    };
    try {
      const socket = controlledSocket();
      const outdoorSpawn = { areaId: "authority-test-overworld", x: 40, y: 28, facing: "right" as const };
      shard.connect(socket, {
        ...testCharacterIdentity(characterId, outdoorSpawn),
        returningCharacter: false,
        vitals: { health: 100, action: 100, spirit: 100 },
      });
      await waitFor(() => socket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      const actor = helloActor(socket, characterId);
      expect(actor).toMatchObject({
        areaId: facility.areaId,
        x: facility.respawnCell.x,
        y: facility.respawnCell.y,
        direction: "front",
        vitals: { health: 100, action: 100, spirit: 100 },
      });
      const helloWeather = packets(socket).find((packet) => packet.type === "game.hello")?.snapshot?.weather as
        Array<Record<string, unknown>> | undefined;
      expect(helloWeather?.find((row) => row.areaId === facility.areaId)).toMatchObject({
        phase: "active",
        eventType: "sandstorm",
      });
      const statusWeather = shard.status().weather.find((row) => row.areaId === facility.areaId);
      expect(statusWeather).toMatchObject({
        phase: "active",
        eventType: "sandstorm",
      });
      expect(statusWeather?.shelteredActors ?? 0).toBeGreaterThanOrEqual(1);
      expect(claimed).toEqual([characterId]);
      expect(internals.claimedAuthoredPlaceholders.size).toBe(0);
      expect(internals.authoredPlaceholderOwners.size).toBe(0);
      expect(internals.actors.has("player")).toBe(true);

      socket.emitMessage(JSON.stringify({ type: "exit_world" }));
      expect(internals.actors.has(characterId)).toBe(false);
      expect(internals.actors.get("player")?.professionIds).toEqual(["marksman"]);

      const returningSocket = controlledSocket();
      const persistedSpawn = {
        areaId: "authority-test-overworld",
        x: 14,
        y: 11,
        facing: "left" as const,
      };
      shard.connect(returningSocket, {
        ...testCharacterIdentity(characterId, persistedSpawn),
        returningCharacter: true,
      });
      await waitFor(() => returningSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(helloActor(returningSocket, characterId)).toMatchObject({
        areaId: persistedSpawn.areaId,
        x: persistedSpawn.x,
        y: persistedSpawn.y,
        direction: persistedSpawn.facing,
      });
      expect(internals.actors.get(characterId)?.professionIds ?? []).not.toContain("marksman");
      expect(internals.claimedAuthoredPlaceholders.size).toBe(0);
      expect(internals.authoredPlaceholderOwners.size).toBe(0);
      expect(internals.actors.has("player")).toBe(true);
      expect(claimed).toEqual([characterId]);
    } finally {
      shard.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
      if (previousForcePhase === undefined) delete process.env.GAME_WEATHER_FORCE_PHASE;
      else process.env.GAME_WEATHER_FORCE_PHASE = previousForcePhase;
      if (previousPinCenter === undefined) delete process.env.GAME_WEATHER_PIN_CENTER;
      else process.env.GAME_WEATHER_PIN_CENTER = previousPinCenter;
    }
  });

  it("keeps returning CharacterStore outdoor position and existing Rust actors off the first-entry shelter path", async () => {
    const facility = {
      id: "dustgate-cloning-facility",
      label: "Dustgate Cloning Facility",
      areaId: "authority-test-overworld",
      respawnCell: { x: 12, y: 10 },
      respawnFacing: "front",
    };
    const { tempDir, slicePath: tempSlicePath } = writeTempSlice({
      actors: [
        actorFixture("player", "Test Player", "adventurer-premium-male", { x: 30, y: 20 }, "player"),
      ],
      cloneFacilities: [facility],
      props: [{
        id: "dustgate-cloning-facility",
        entity: "prop:dustgate-cloning-facility",
        areaId: "authority-test-overworld",
        label: "Dustgate Cloning Facility",
        kind: "building",
        cell: { x: 10, y: 8 },
        size: { w: 5, h: 4 },
        interactive: false,
        solid: false,
        shelter: true,
        door: {
          blocker: { xMilli: 2420, yMilli: 3705, wMilli: 1240, hMilli: 295, id: "closed_door_panel" },
          interactRadiusCells: 2.2,
        },
      }],
    });
    const returningId = "returning-outdoor";
    const liveId = "live-existing-actor";
    const outdoor = { areaId: "authority-test-overworld", x: 41, y: 27, facing: "left" as const };
    const shard = testShard({
      slicePath: tempSlicePath,
      snapshotIntervalMs: 10_000,
      characterPersistence: {
        hasCharacter: (candidate) => candidate === returningId || candidate === liveId,
        claimWorldEntry: () => ({ returning: false }),
        saveSnapshot: () => undefined,
      },
    });
    const internals = shard as unknown as {
      checkpoint: (reason?: string) => Promise<unknown>;
      actors: Map<string, { x: number; y: number; areaId: string; direction: string }>;
    };
    internals.checkpoint = async () => ({});
    try {
      const liveSocket = controlledSocket();
      shard.connect(liveSocket, {
        ...testCharacterIdentity(liveId, { areaId: "authority-test-overworld", x: 18, y: 14, facing: "back" }),
        returningCharacter: false,
      });
      await waitFor(() => liveSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(helloActor(liveSocket, liveId)).toMatchObject({
        x: facility.respawnCell.x,
        y: facility.respawnCell.y,
      });
      const liveActor = internals.actors.get(liveId);
      expect(liveActor).toBeDefined();
      liveActor!.x = 22;
      liveActor!.y = 16;
      liveActor!.direction = "right";
      const takeover = controlledSocket();
      shard.connect(takeover, {
        ...testCharacterIdentity(liveId, { areaId: "authority-test-overworld", x: 1, y: 1, facing: "front" }),
        returningCharacter: true,
      });
      await waitFor(() => takeover.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(helloActor(takeover, liveId)).toMatchObject({
        areaId: "authority-test-overworld",
        x: 22,
        y: 16,
        direction: "right",
      });

      const returningSocket = controlledSocket();
      shard.connect(returningSocket, {
        ...testCharacterIdentity(returningId, outdoor),
        returningCharacter: true,
      });
      await waitFor(() => returningSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(helloActor(returningSocket, returningId)).toMatchObject({
        areaId: outdoor.areaId,
        x: outdoor.x,
        y: outdoor.y,
        direction: outdoor.facing,
      });

      // Absent returningCharacter is not sheltered first entry: honor supplied spawn.
      // Claim may still run async (returningCharacter !== true), so wait for hello.
      const omittedFlagId = "omitted-returning-flag";
      const omittedSocket = controlledSocket();
      const priorHasCharacter = (shard as unknown as {
        characterPersistence?: { hasCharacter?: (id: string) => boolean };
      }).characterPersistence;
      if (priorHasCharacter) {
        const previousHas = priorHasCharacter.hasCharacter;
        priorHasCharacter.hasCharacter = (candidate: string) =>
          candidate === omittedFlagId || Boolean(previousHas?.(candidate));
      }
      shard.connect(omittedSocket, {
        ...testCharacterIdentity(omittedFlagId, { areaId: "authority-test-overworld", x: 19, y: 21, facing: "right" }),
      });
      await waitFor(() => omittedSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(helloActor(omittedSocket, omittedFlagId)).toMatchObject({
        areaId: "authority-test-overworld",
        x: 19,
        y: 21,
        direction: "right",
      });
    } finally {
      shard.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("writes the sheltered first-entry position into the durable checkpoint before worldEntryClaimed flips", async () => {
    const characterId = "first-entry-checkpoint-shelter";
    const facility = {
      id: "dustgate-cloning-facility",
      label: "Dustgate Cloning Facility",
      areaId: "authority-test-overworld",
      respawnCell: { x: 12, y: 10 },
      respawnFacing: "front",
    };
    const { tempDir, slicePath: tempSlicePath } = writeTempSlice({
      actors: [
        actorFixture("player", "Test Player", "adventurer-premium-male", { x: 30, y: 20 }, "player"),
      ],
      cloneFacilities: [facility],
      props: [{
        id: "dustgate-cloning-facility",
        entity: "prop:dustgate-cloning-facility",
        areaId: "authority-test-overworld",
        label: "Dustgate Cloning Facility",
        kind: "building",
        cell: { x: 10, y: 8 },
        size: { w: 5, h: 4 },
        interactive: false,
        solid: false,
        shelter: true,
        door: {
          blocker: { xMilli: 2420, yMilli: 3705, wMilli: 1240, hMilli: 295, id: "closed_door_panel" },
          interactRadiusCells: 2.2,
        },
      }],
    });
    const order: string[] = [];
    let checkpointActor: { x: number; y: number; areaId: string } | undefined;
    const shard = testShard({
      slicePath: tempSlicePath,
      snapshotIntervalMs: 10_000,
      characterPersistence: {
        hasCharacter: (candidate) => candidate === characterId,
        claimWorldEntry: (candidate) => {
          order.push(`claim:${candidate}`);
          return { returning: false };
        },
        saveSnapshot: () => undefined,
      },
    });
    const internals = shard as unknown as {
      checkpoint: (reason?: string) => Promise<unknown>;
      actors: Map<string, { x: number; y: number; areaId: string }>;
    };
    internals.checkpoint = async (reason?: string) => {
      const actor = internals.actors.get(characterId);
      checkpointActor = actor ? { x: actor.x, y: actor.y, areaId: actor.areaId } : undefined;
      order.push(`checkpoint:${reason ?? "manual"}:${checkpointActor?.x},${checkpointActor?.y}`);
      return {};
    };
    try {
      const socket = controlledSocket();
      shard.connect(socket, {
        ...testCharacterIdentity(characterId, { areaId: "authority-test-overworld", x: 40, y: 28, facing: "right" }),
        returningCharacter: false,
      });
      await waitFor(() => order.includes(`claim:${characterId}`)
        && socket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(order[0]).toMatch(/^checkpoint:character-first-entry:12,10$/);
      expect(order[1]).toBe(`claim:${characterId}`);
      expect(checkpointActor).toEqual({
        areaId: facility.areaId,
        x: facility.respawnCell.x,
        y: facility.respawnCell.y,
      });
      expect(helloActor(socket, characterId)).toMatchObject({
        x: facility.respawnCell.x,
        y: facility.respawnCell.y,
      });
    } finally {
      shard.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps clone-facility door authority and lets a first-entry player leave after opening the door", async () => {
    const characterId = "first-entry-facility-exit";
    const facility = {
      id: "dustgate-cloning-facility",
      label: "Dustgate Cloning Facility",
      areaId: "authority-test-overworld",
      respawnCell: { x: 12, y: 11 },
      respawnFacing: "front",
    };
    const { tempDir, slicePath: tempSlicePath } = writeTempSlice({
      actors: [
        actorFixture("player", "Test Player", "adventurer-premium-male", { x: 30, y: 20 }, "player"),
      ],
      cloneFacilities: [facility],
      props: [{
        id: "dustgate-cloning-facility",
        entity: "prop:dustgate-cloning-facility",
        areaId: "authority-test-overworld",
        label: "Dustgate Cloning Facility",
        kind: "building",
        cell: { x: 10, y: 8 },
        size: { w: 5, h: 4 },
        interactive: false,
        solid: false,
        shelter: true,
        door: {
          blocker: { xMilli: 2420, yMilli: 3705, wMilli: 1240, hMilli: 295, id: "closed_door_panel" },
          interactRadiusCells: 3.1,
        },
      }],
    });
    const shard = testShard({
      slicePath: tempSlicePath,
      snapshotIntervalMs: 10_000,
      characterPersistence: {
        hasCharacter: (candidate) => candidate === characterId,
        claimWorldEntry: () => ({ returning: false }),
        saveSnapshot: () => undefined,
      },
    });
    const internals = shard as unknown as { checkpoint: (reason?: string) => Promise<unknown> };
    internals.checkpoint = async () => ({});
    try {
      const socket = controlledSocket();
      shard.connect(socket, {
        ...testCharacterIdentity(characterId, { areaId: "authority-test-overworld", x: 40, y: 28, facing: "right" }),
        returningCharacter: false,
      });
      await waitFor(() => socket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(helloActor(socket, characterId)).toMatchObject({
        x: facility.respawnCell.x,
        y: facility.respawnCell.y,
      });
      expect(shard.snapshotFor(characterId).propStates?.["dustgate-cloning-facility"]).toEqual({ doorOpen: false });
      const opened = shard.submitCommandForTest(characterId, envelope(1, {
        ToggleDoor: { prop_id: "dustgate-cloning-facility" },
      }));
      expect(opened.receipt).toMatchObject({ accepted: true });
      expect(shard.snapshotFor(characterId).propStates?.["dustgate-cloning-facility"]).toEqual({ doorOpen: true });
      const start = exactActorPosition(shard, characterId);
      expect(start).toEqual({ x: facility.respawnCell.x, y: facility.respawnCell.y });
      const moved = shard.submitCommandForTest(characterId, envelope(2, {
        Move: { dx: 0, dy: 1, duration_ticks: 1 },
      }));
      expect(moved.receipt).toMatchObject({ accepted: true });
      const after = exactActorPosition(shard, characterId);
      expect(after).toBeDefined();
      expect(after!.y).toBeGreaterThan(start!.y);
    } finally {
      shard.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("orders local first-entry durability, hosted commit, and game.hello", async () => {
    const events: string[] = [];
    const characterId = "hosted-first-entry-order";
    const oldEnv = {
      nodeEnv: process.env.NODE_ENV,
      siteUrl: process.env.SUCCESSOR_SITE_URL,
      secret: process.env.SUCCESSOR_RUNTIME_SECRET,
      bearer: process.env.SUCCESSOR_RUNTIME_BEARER_TOKEN,
      shard: process.env.SUCCESSOR_SHARD_ID,
      release: process.env.SUCCESSOR_RELEASE_ID,
    };
    process.env.NODE_ENV = "production";
    process.env.SUCCESSOR_SITE_URL = "https://successor.example";
    process.env.SUCCESSOR_RUNTIME_SECRET = "runtime-secret";
    process.env.SUCCESSOR_RUNTIME_BEARER_TOKEN = "bearer-token";
    process.env.SUCCESSOR_SHARD_ID = "runtime-shard";
    process.env.SUCCESSOR_RELEASE_ID = "runtime-release";
    vi.stubGlobal("fetch", vi.fn(async () => {
      events.push("commit");
      return new Response(JSON.stringify({ firstEntry: { ok: true, idempotent: false, status: "entered", entryNonce: "nonce-order" } }), { status: 200 });
    }));
    const shard = testShard({
      slicePath,
      snapshotIntervalMs: 10_000,
      characterPersistence: {
        hasCharacter: (candidate) => candidate === characterId,
        claimWorldEntry: (candidate) => { events.push(`claim:${candidate}`); return { returning: false }; },
        saveSnapshot: () => undefined,
      },
    });
    const internals = shard as unknown as { checkpoint: (reason?: string) => Promise<unknown> };
    internals.checkpoint = async () => { events.push("checkpoint"); return {}; };
    const socket = controlledSocket();
    const originalSend = socket.send.bind(socket);
    socket.send = (data: string) => { if (JSON.parse(data).type === "game.hello") events.push("hello"); originalSend(data); };
    try {
      shard.connect(socket, {
        ...testCharacterIdentity(characterId),
        returningCharacter: false,
        pendingFirstEntryCommit: { entryNonce: "nonce-order", shardId: "ticket-shard", releaseId: "ticket-release" },
      });
      await waitFor(() => events.includes("hello"));
      expect(events).toEqual(["checkpoint", `claim:${characterId}`, "commit", "hello"]);
    } finally {
      shard.close();
      vi.unstubAllGlobals();
      for (const [key, value] of Object.entries(oldEnv)) {
        const envKey = { nodeEnv: "NODE_ENV", siteUrl: "SUCCESSOR_SITE_URL", secret: "SUCCESSOR_RUNTIME_SECRET", bearer: "SUCCESSOR_RUNTIME_BEARER_TOKEN", shard: "SUCCESSOR_SHARD_ID", release: "SUCCESSOR_RELEASE_ID" }[key as keyof typeof oldEnv];
        if (value === undefined) delete process.env[envKey]; else process.env[envKey] = value;
      }
    }
  });


  it("heals a returning local character with a pending hosted commit and closes on commit failure", async () => {
    const oldEnv = { nodeEnv: process.env.NODE_ENV, siteUrl: process.env.SUCCESSOR_SITE_URL, secret: process.env.SUCCESSOR_RUNTIME_SECRET, bearer: process.env.SUCCESSOR_RUNTIME_BEARER_TOKEN, shard: process.env.SUCCESSOR_SHARD_ID, release: process.env.SUCCESSOR_RELEASE_ID };
    process.env.NODE_ENV = "production";
    process.env.SUCCESSOR_SITE_URL = "https://successor.example";
    process.env.SUCCESSOR_RUNTIME_SECRET = "runtime-secret";
    process.env.SUCCESSOR_RUNTIME_BEARER_TOKEN = "bearer-token";
    process.env.SUCCESSOR_SHARD_ID = "runtime-shard";
    process.env.SUCCESSOR_RELEASE_ID = "runtime-release";
    try {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ firstEntry: { ok: true, idempotent: true, status: "entered", entryNonce: "nonce-returning" } }), { status: 200 })));
      const returningShard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
      const returningSocket = controlledSocket();
      returningShard.connect(returningSocket, { ...testCharacterIdentity("hosted-returning"), returningCharacter: true, pendingFirstEntryCommit: { entryNonce: "nonce-returning", shardId: "ticket-shard", releaseId: "ticket-release" } });
      await waitFor(() => returningSocket.sent.some((packet) => JSON.parse(packet).type === "game.hello"));
      expect(returningSocket.closed).toEqual([]);
      returningShard.close();

      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "entry_conflict" }), { status: 409 })));
      const failedShard = testShard({ slicePath, snapshotIntervalMs: 10_000 });
      const failedSocket = controlledSocket();
      failedShard.connect(failedSocket, { ...testCharacterIdentity("hosted-failure"), returningCharacter: true, pendingFirstEntryCommit: { entryNonce: "nonce-failure", shardId: "ticket-shard", releaseId: "ticket-release" } });
      await waitFor(() => failedSocket.closed.length > 0);
      expect(failedSocket.sent).toEqual([]);
      expect(failedSocket.closed[0]).toMatchObject({ code: 1011, reason: "durable character entry failed" });
      failedShard.close();
    } finally {
      vi.unstubAllGlobals();
      for (const [key, value] of Object.entries(oldEnv)) {
        const envKey = { nodeEnv: "NODE_ENV", siteUrl: "SUCCESSOR_SITE_URL", secret: "SUCCESSOR_RUNTIME_SECRET", bearer: "SUCCESSOR_RUNTIME_BEARER_TOKEN", shard: "SUCCESSOR_SHARD_ID", release: "SUCCESSOR_RELEASE_ID" }[key as keyof typeof oldEnv];
        if (value === undefined) delete process.env[envKey]; else process.env[envKey] = value;
      }
    }
  });

});

function createCheckpointCompatibilityFixture(): {
  tempDir: string;
  slicePath: string;
  checkpointPath: string;
  journalPath: string;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-checkpoint-compat-"));
  const fixtureSlicePath = path.join(tempDir, "test-slice.json");
  const checkpointPath = path.join(tempDir, "test-slice.checkpoint.json");
  const journalPath = path.join(tempDir, "test-slice.journal.jsonl");
  fs.copyFileSync(slicePath, fixtureSlicePath);

  const first = testShard({
    slicePath: fixtureSlicePath,
    snapshotIntervalMs: 10_000,
    persistence: { checkpointPath, journalPath, checkpointIntervalMs: 1 },
  });
  try {
    const moved = first.submitCommandForTest("player", envelope(1, {
      Move: { dx: 1, dy: 0, duration_ticks: 30 },
    }));
    expect(moved.receipt.accepted).toBe(true);
    first.checkpointNowForTest();
  } finally {
    first.close();
  }

  return { tempDir, slicePath: fixtureSlicePath, checkpointPath, journalPath };
}

interface ControlledFirstEntryExport {
  actorIds: string[];
  settled: boolean;
  resolve(): void;
  reject(error: Error): void;
}

function firstEntryCheckpointHarness(shardId: string): {
  shard: GameShard;
  checkpointPath: string;
  submittedRustActorIds: string[];
  claimedCharacterIds: string[];
  exportRequests: ControlledFirstEntryExport[];
  cleanup(): Promise<void>;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-first-entry-ordering-"));
  const checkpointPath = path.join(tempDir, `${shardId}.checkpoint.json`);
  const journalPath = path.join(tempDir, `${shardId}.journal.jsonl`);
  const submittedRustActorIds: string[] = [];
  const claimedCharacterIds: string[] = [];
  const exportRequests: ControlledFirstEntryExport[] = [];
  const shard = new GameShard({
    shardId,
    slicePath,
    snapshotIntervalMs: 10_000,
    clock: new ManualClock(0),
    persistence: { checkpointPath, journalPath },
    characterPersistence: {
      hasCharacter: () => true,
      claimWorldEntry: (characterId) => {
        claimedCharacterIds.push(characterId);
        return { returning: false };
      },
      saveSnapshot: () => undefined,
    },
    rustAuthorityBridge: {
      enabled: true,
      command: process.execPath,
      args: ["-e", "process.stdin.resume();"],
    },
  });
  type TestBridge = {
    close(): void;
    pendingCount(): number;
    debugStatus(): null;
    submitActor(options: { actor: RustAuthorityActorUpsertInput }): Promise<RustAuthorityBridgeActorOutput>;
    exportState(options?: { timeoutMs?: number }): Promise<RustAuthorityBridgeExportStateOutput>;
  };
  const internals = shard as unknown as { rustAuthorityBridge?: TestBridge };
  internals.rustAuthorityBridge?.close();

  let nextExportTick = 200;
  const exportOutput = (tick: number, actorIds: string[]): RustAuthorityBridgeExportStateOutput => {
    const stateHash = tick.toString(16).padStart(64, "0");
    return {
      tick,
      stateHash,
      state: {
        schema: "successor.authority-state.v1",
        version: 1,
        stateHash,
        actorIds: [...actorIds],
      },
    };
  };
  const bridge: TestBridge = {
    close: () => undefined,
    pendingCount: () => 0,
    debugStatus: () => null,
    submitActor: async ({ actor }) => {
      submittedRustActorIds.push(actor.id);
      const tick = 100 + submittedRustActorIds.length;
      return {
        tick,
        targetStateHash: `first-entry-upsert-${tick}`,
        actor: rustActorSnapshot({
          id: actor.id,
          entity: actor.entity,
          label: actor.label ?? actor.id,
          role: actor.role ?? "player",
          areaId: actor.areaId,
          x: actor.x,
          y: actor.y,
          direction: actor.direction,
        }),
        inventory: [],
        reservations: [],
        timelineEvents: [],
        resourceSpawns: [],
        areaResourceSpawns: [],
        metrics: rustTickOutput([], tick).metrics,
      };
    },
    exportState: () => {
      const actorIds = [...submittedRustActorIds];
      const output = exportOutput(++nextExportTick, actorIds);
      let settleResolve: ((value: RustAuthorityBridgeExportStateOutput) => void) | undefined;
      let settleReject: ((error: Error) => void) | undefined;
      const promise = new Promise<RustAuthorityBridgeExportStateOutput>((resolve, reject) => {
        settleResolve = resolve;
        settleReject = reject;
      });
      const request: ControlledFirstEntryExport = {
        actorIds,
        settled: false,
        resolve() {
          if (request.settled) return;
          request.settled = true;
          settleResolve?.(output);
        },
        reject(error) {
          if (request.settled) return;
          request.settled = true;
          settleReject?.(error);
        },
      };
      exportRequests.push(request);
      return promise;
    },
  };
  internals.rustAuthorityBridge = bridge;

  return {
    shard,
    checkpointPath,
    submittedRustActorIds,
    claimedCharacterIds,
    exportRequests,
    async cleanup() {
      bridge.exportState = async () => exportOutput(++nextExportTick, submittedRustActorIds);
      for (const request of exportRequests) request.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      try {
        await shard.close();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  };
}

function testShard(options: GameShardOptions): GameShard {
  return new GameShard({
    ...options,
    allowInProcessAuthorityForTests: true,
    allowReservedActorSessionsForTests: options.allowReservedActorSessionsForTests ?? true,
  });
}

/**
 * A LIVE-mode shard whose Rust bridge is a stub that accepts every command and
 * records the exact envelope it was handed. Lets a test assert what the shard
 * FORWARDS to authority (and journals), independent of sim behavior.
 */
function liveCaptureShard(journalPath?: string): { shard: GameShard; submittedEnvelopes: ClientCommandEnvelope[] } {
  const shard = new GameShard({
    slicePath,
    snapshotIntervalMs: 10_000,
    ...(journalPath ? { persistence: { journalPath, checkpointIntervalMs: 1_000 } } : {}),
    rustAuthorityBridge: { enabled: true, command: process.execPath, args: ["-e", "process.stdin.resume();"] },
  });
  const internals = shard as unknown as {
    rustAuthorityBridge?: {
      close: () => void;
      submitActor?: (input: unknown) => Promise<unknown>;
      submitCommand?: (input: { envelope: ClientCommandEnvelope }) => Promise<unknown>;
      debugStatus?: () => unknown;
    };
  };
  const submittedEnvelopes: ClientCommandEnvelope[] = [];
  internals.rustAuthorityBridge?.close();
  internals.rustAuthorityBridge = {
    close: () => {},
    debugStatus: () => null,
    submitActor: async () => ({}),
    submitCommand: async ({ envelope }) => {
      submittedEnvelopes.push(envelope);
      return {
        status: "accepted",
        reasonCode: null,
        tick: 77,
        commandId: envelope.command_id,
        targetStateHash: `hash-${envelope.command_id}`,
        actors: [],
        combatEvents: [],
        inventory: [],
        reservations: [],
        npcJobs: [],
        timelineEvents: [],
      };
    },
  };
  return { shard, submittedEnvelopes };
}

function envelope(commandId: number, command: ClientCommandEnvelope["command"]): ClientCommandEnvelope {
  return {
    session: 1,
    player: 1,
    command_id: commandId,
    issued_at_tick: 0,
    command,
  };
}

type TestCharacterSpawn = NonNullable<GameSessionIdentity["spawn"]> & {
  areaId: string;
  x: number;
  y: number;
  facing: "front" | "right" | "back" | "left";
};

type TestCharacterIdentity = GameSessionIdentity & {
  characterId: string;
  ownerRef: string;
  spawn: TestCharacterSpawn;
};

function testCharacterIdentity(characterId: string, spawn: TestCharacterSpawn = { areaId: "authority-test-overworld", x: 11, y: 17, facing: "right" }): TestCharacterIdentity {
  return {
    actorId: characterId,
    playerId: "local",
    displayName: characterId,
    zoneId: "authority-test",
    characterId,
    ownerRef: "local",
    appearance: { skin: "#aabbcc", hair: "hair_crop2", hair_mat: "hair_chestnut" },
    spawn,
  };
}

function helloActor(socket: { sent: string[] }, actorId: string): GameActorSnapshot | undefined {
  const hello = packets(socket).find((packet) => packet.type === "game.hello");
  return hello?.snapshot?.actors?.[actorId];
}

function rustWeaponSnapshot(weaponId: AuthorityWeaponId, weaponItemId?: number): RustAuthorityActorWeaponSnapshot {
  const magazineSize = authorityWeaponMagazineSize(weaponId);
  return {
    weaponId,
    ...(weaponItemId !== undefined ? { weaponItemId } : {}),
    ammoType: authorityWeaponProfile(weaponId).defaultAmmoType,
    loadedRounds: magazineSize,
    magazineSize,
    reloadUntilTick: 0,
    reloadRemainingTicks: 0,
    reloadTotalTicks: 1,
  };
}

function writeTempSlice(params: {
  actors: unknown[];
  props?: unknown[];
  blockedCells?: unknown[];
  cloneFacilities?: unknown[];
  areas?: unknown[];
  inventory?: unknown[];
  zone?: unknown;
  travelCatalog?: unknown;
  transitions?: unknown[];
  weather?: unknown[];
}): { tempDir: string; slicePath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "successor-shard-"));
  const slicePath = path.join(tempDir, "test-slice.json");
  fs.writeFileSync(slicePath, JSON.stringify({
    schema: "successor.slice.v1",
    tick: 1,
    tickRateHz: 30,
    grid: { cellSizePx: 60 },
    zone: params.zone ?? { id: 1, name: "Hitbox Test", width: 64, height: 36, level: 0 },
    areas: params.areas ?? [{ id: "authority-test-overworld", name: "Authority Test Overworld", kind: "overworld", width: 64, height: 36, level: 0 }],
    stateHash: "hitbox-test",
    camera: { followActor: "player", zoom: 72 },
    actors: params.actors,
    props: params.props ?? [],
    blockedCells: params.blockedCells ?? [],
    transitions: params.transitions ?? [],
    cloneFacilities: params.cloneFacilities ?? [],
    weather: params.weather ?? [],
    travelCatalog: params.travelCatalog,
    inventory: params.inventory ?? [],
    reservations: [],
    events: [],
  }, null, 2));
  return { tempDir, slicePath };
}

function actorFixture(
  id: string,
  label: string,
  sprite: string,
  cell: { x: number; y: number },
  role: string,
) {
  return {
    id,
    entity: `fixture:${id}`,
    areaId: "authority-test-overworld",
    label,
    role,
    sprite,
    poseSet: "walk",
    direction: "right",
    cell,
    route: [],
  };
}


function travelSliceParams(options: { playerCell: { x: number; y: number }; inventory?: unknown[] }) {
  const params = {
    zone: { id: 1, name: "Planetfall Test", width: 1024, height: 1024, level: 0 },
    areas: [
      { id: "open-desert-overworld", name: "Open Desert", kind: "overworld", width: 1024, height: 1024, level: 0, biome: "desert" },
      { id: "verdance-forest-overworld", name: "Verdance Forest", kind: "overworld", width: 1024, height: 1024, level: 0, biome: "forest" },
    ],
    actors: [{
      id: "player",
      entity: "fixture:player",
      areaId: "open-desert-overworld",
      label: "Test Player",
      role: "player",
      sprite: "adventurer-premium-male",
      poseSet: "walk",
      direction: "right",
      cell: options.playerCell,
      route: [],
    }],
    props: [
      travelTerminalPropFixture("travel-terminal-dustgate", "open-desert-overworld", "Travel Terminal — Dustgate", { x: 524, y: 512 }),
      travelTerminalPropFixture("travel-terminal-lowbough", "verdance-forest-overworld", "Travel Terminal — Lowbough", { x: 524, y: 512 }),
    ],
    travelCatalog: {
      schema: "successor.travel-catalog.v1",
      planets: [
        {
          id: "ashvat",
          label: "Ashvat",
          biome: "desert",
          areaId: "open-desert-overworld",
          cities: [{
            id: "dustgate",
            label: "Dustgate",
            terminalPropId: "travel-terminal-dustgate",
            spawn: { x: 512, y: 512 },
          }],
        },
        {
          id: "verdance",
          label: "Verdance",
          biome: "forest",
          areaId: "verdance-forest-overworld",
          cities: [{
            id: "lowbough",
            label: "Lowbough",
            terminalPropId: "travel-terminal-lowbough",
            spawn: { x: 512, y: 512 },
          }],
        },
      ],
    },
    inventory: options.inventory ?? [],
  };
  return params;
}

function travelTerminalPropFixture(id: string, areaId: string, label: string, cell: { x: number; y: number }) {
  const prop = {
    id,
    entity: `travel:${areaId}:${id}`,
    areaId,
    kind: "travel_terminal",
    label,
    assetKey: "travel_terminal",
    cell,
    size: { w: 1, h: 1 },
    interactive: true,
    rotation: 90,
  };
  return prop;
}

function fakeSocket(): GameSocket & { sent: string[] } {
  const listeners = new Map<string, Array<(data?: unknown) => void>>();
  let readyState = 1;
  return {
    get readyState() {
      return readyState;
    },
    sent: [] as string[],
    send(data: string) {
      this.sent.push(data);
    },
    close() {
      readyState = 3;
    },
    on(event: "message" | "close" | "error", listener: (data?: unknown) => void) {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
    },
  } as GameSocket & { sent: string[] };
}

function tradeMessageSocket(): GameSocket & { sent: string[]; messages: Array<{ type: string; payload: unknown }> } {
  const base = fakeSocket();
  const messages: Array<{ type: string; payload: unknown }> = [];
  return Object.assign(base, {
    messages,
    sendMessage(type: string, payload: unknown) {
      messages.push({ type, payload });
    },
  }) as GameSocket & { sent: string[]; messages: Array<{ type: string; payload: unknown }> };
}

function controlledSocket(): GameSocket & { sent: string[]; closed: Array<{ code?: number; reason?: string }>; emitMessage(data: string): void; emitClose(): void } {
  const listeners = new Map<string, Array<(data?: unknown) => void>>();
  const closed: Array<{ code?: number; reason?: string }> = [];
  let readyState = 1;
  return {
    get readyState() {
      return readyState;
    },
    sent: [] as string[],
    closed,
    send(data: string) {
      this.sent.push(data);
    },
    close(code?: number, reason?: string) {
      closed.push({ code, reason });
      readyState = 3;
    },
    on(event: "message" | "close" | "error", listener: (data?: unknown) => void) {
      const current = listeners.get(event) ?? [];
      current.push(listener);
      listeners.set(event, current);
    },
    emitMessage(data: string) {
      for (const listener of listeners.get("message") ?? []) listener(data);
    },
    emitClose() {
      readyState = 3;
      for (const listener of listeners.get("close") ?? []) listener();
    },
  } as GameSocket & { sent: string[]; closed: Array<{ code?: number; reason?: string }>; emitMessage(data: string): void; emitClose(): void };
}

function bufferedControlledSocket(initialBufferedAmount: number): GameSocket & {
  sent: string[];
  closed: Array<{ code?: number; reason?: string }>;
  emitMessage(data: string): void;
  emitClose(): void;
  setBufferedAmount(value: number): void;
} {
  const socket = controlledSocket();
  let bufferedAmount = initialBufferedAmount;
  Object.defineProperty(socket, "bufferedAmount", {
    configurable: true,
    enumerable: true,
    get: () => bufferedAmount,
  });
  return Object.assign(socket, {
    setBufferedAmount(value: number): void {
      bufferedAmount = value;
    },
  }) as GameSocket & {
    sent: string[];
    closed: Array<{ code?: number; reason?: string }>;
    emitMessage(data: string): void;
    emitClose(): void;
    setBufferedAmount(value: number): void;
  };
}

function packets(socket: { sent: string[] }) {
  return socket.sent.map((packet) => JSON.parse(packet));
}

function privateDeltaSession(id: string, actorId: string, knownActor: GameActorSnapshot) {
  return {
    id,
    actorId,
    socket: controlledSocket(),
    connectedAt: "1970-01-01T00:00:00.000Z",
    connectedAtMs: 0,
    seenCommands: new Set<number>(),
    ingressBudgets: new Map<string, unknown>(),
    lastSnapshotTick: 0,
    lastActorDeltaTick: 0,
    pendingReceipts: [],
    pendingEvents: [],
    pendingAbilityQueueEvents: [],
    pendingDialogueDeliveries: [],
    lastCombatEventDeltaTick: 0,
    deferredDirtyActorIds: new Set<string>(),
    knownActorIds: new Set<string>([knownActor.id]),
    knownActorSnapshots: new Map<string, GameActorSnapshot>([[knownActor.id, knownActor]]),
    needsFullSnapshot: false,
    viewInterest: null,
    interestDirty: false,
  };
}

function deltaActor(
  delta: { actors?: Record<string, GameActorSnapshot>; compactActors?: GameCompactActorSnapshot[] } | undefined,
  actorId: string,
): GameActorSnapshot | undefined {
  if (!delta) return undefined;
  return delta.actors?.[actorId] ?? delta.compactActors
    ?.map(actorFromCompact)
    .find((actor) => actor.id === actorId);
}

function deltaActorDetail(
  delta: {
    actors?: Record<string, GameActorSnapshot>;
    compactActors?: GameCompactActorSnapshot[];
    actorPatches?: Record<string, GameActorPatch>;
    compactActorPatches?: GameCompactActorPatch[];
  } | undefined,
  actorId: string,
): GameActorPatch | undefined {
  const actor = deltaActor(delta, actorId);
  if (actor) {
    return {
      id: actor.id,
      vitals: actor.vitals,
      maxVitals: actor.maxVitals,
      bleed: actor.bleed,
      statuses: actor.statuses,
      nextSampleTick: actor.nextSampleTick,
    };
  }
  const patch = delta?.actorPatches?.[actorId];
  if (patch) return patch;
  const compactPatch = delta?.compactActorPatches?.find(([id]) => id === actorId);
  if (!compactPatch) return undefined;
  return actorPatchFromCompact(compactPatch);
}

function actorPatchFromCompact(compact: GameCompactActorPatch): GameActorPatch {
  const [
    id,
    areaId,
    x,
    y,
    direction,
    lifeState,
    lifecycleSeq,
    vitals,
    maxVitals,
    bleed,
    statuses,
  ] = compact;
  const patch: GameActorPatch = { id };
  if (areaId !== null) patch.areaId = areaId;
  if (x !== null) patch.x = x;
  if (y !== null) patch.y = y;
  if (direction !== null) patch.direction = (["front", "right", "back", "left"] as const)[direction] ?? "front";
  if (lifeState !== null) patch.lifeState = (["alive", "downed", "respawning"] as const)[lifeState] ?? "alive";
  if (lifecycleSeq !== null) patch.lifecycleSeq = lifecycleSeq;
  if (vitals !== null) patch.vitals = { health: vitals[0], action: vitals[1], spirit: vitals[2] };
  if (maxVitals !== null) patch.maxVitals = { health: maxVitals[0], action: maxVitals[1], spirit: maxVitals[2] };
  if (bleed !== null) {
    patch.bleed = {
      active: bleed[0] === 1,
      stackCount: bleed[1],
      severity: bleed[2],
      remainingMs: bleed[3],
      ratesPerSecond: { health: bleed[4], action: bleed[5], spirit: bleed[6] },
    };
  }
  if (statuses !== null) patch.statuses = statuses;
  const combatQueue = compact[31];
  if (combatQueue !== undefined && combatQueue !== false) patch.combatQueue = combatQueue;
  const inCombat = compact[32];
  if (inCombat !== undefined && inCombat !== null) patch.inCombat = inCombat === 1;
  const cloneSicknessRemainingMs = compact[33];
  if (typeof cloneSicknessRemainingMs === "number") patch.cloneSicknessRemainingMs = cloneSicknessRemainingMs;
  const peaceRequested = compact[34];
  if (peaceRequested !== undefined && peaceRequested !== null) patch.peaceRequested = peaceRequested === 1;
  const aiAttitude = compact[35];
  if (aiAttitude !== undefined && aiAttitude !== null) patch.aiAttitude = aiAttitude;
  const lootable = compact[37];
  if (lootable !== undefined && lootable !== null) patch.lootable = lootable === 1;
  const hasLoot = compact[38];
  if (hasLoot !== undefined && hasLoot !== null) patch.hasLoot = hasLoot === 1;
  const lootRightsActorId = compact[39];
  if (lootRightsActorId !== undefined && lootRightsActorId !== false) patch.lootRightsActorId = lootRightsActorId;
  const bodyVanishTick = compact[40];
  if (typeof bodyVanishTick === "number") patch.bodyVanishTick = bodyVanishTick;
  const nextSampleTick = compact[47];
  if (typeof nextSampleTick === "number") patch.nextSampleTick = nextSampleTick;
  const willAutoAggro = compact[49];
  if (willAutoAggro !== undefined && willAutoAggro !== null) patch.willAutoAggro = willAutoAggro === 1;
  return patch;
}

function actorFromCompact(compact: GameCompactActorSnapshot): GameActorSnapshot {
  const [
    id,
    label,
    areaId,
    x,
    y,
    direction,
    lifeState,
    lifecycleSeq,
    vitals,
    maxVitals,
    bleed,
    statuses,
  ] = compact;
  return {
    id,
    label,
    display_name: compact[44] ?? label,
    link_dead: compact[45] === 1,
    appearance: compact[46] ?? { skin: "#c78f62", hair: null, hair_mat: "hair_raven" },
    areaId,
    x,
    y,
    direction: (["front", "right", "back", "left"] as const)[direction] ?? "front",
    posture: compact[29] ?? "standing",
    postureUntilTick: compact[30] ?? 0,
    lifeState: (["alive", "downed", "respawning"] as const)[lifeState] ?? "alive",
    lifecycleSeq,
    vitals: { health: vitals[0], action: vitals[1], spirit: vitals[2] },
    maxVitals: { health: maxVitals[0], action: maxVitals[1], spirit: maxVitals[2] },
    bleed: {
      active: bleed[0] === 1,
      stackCount: bleed[1],
      severity: bleed[2],
      remainingMs: bleed[3],
      ratesPerSecond: { health: bleed[4], action: bleed[5], spirit: bleed[6] },
    },
    statuses,
    combatQueue: compact[31] ?? undefined,
    inCombat: compact[32] === 1,
    cloneSicknessRemainingMs: compact[33] ?? 0,
    peaceRequested: compact[34] === 1,
    aiAttitude: compact[35] ?? undefined,
    engagementTargetId: compact[36] ?? undefined,
    lootable: compact[37] === 1,
    hasLoot: compact[38] === 1,
    lootRightsActorId: compact[39] ?? null,
    bodyVanishTick: compact[40] ?? compact[15] ?? 0,
    nextSampleTick: compact[47] ?? undefined,
    willAutoAggro: compact[49] === 1,
    descriptor: compact[50] ?? undefined,
  };
}

function rustActorSnapshot(overrides: Partial<RustAuthorityActorSnapshot> & Pick<RustAuthorityActorSnapshot, "id">): RustAuthorityActorSnapshot {
  return {
    id: overrides.id,
    entity: overrides.entity,
    label: overrides.label,
    role: overrides.role,
    worn: overrides.worn,
    scale: overrides.scale,
    templateId: overrides.templateId,
    spawnZoneId: overrides.spawnZoneId,
    descriptor: overrides.descriptor,
    areaId: overrides.areaId ?? "authority-test-overworld",
    x: overrides.x ?? 10,
    y: overrides.y ?? 10,
    direction: overrides.direction ?? "right",
    factionId: overrides.factionId ?? null,
    socialGroup: overrides.socialGroup ?? null,
    pvpStatus: overrides.pvpStatus ?? null,
    aiAttitude: overrides.aiAttitude,
    lifeState: overrides.lifeState ?? "alive",
    lifecycleSeq: overrides.lifecycleSeq ?? 1,
    vitals: overrides.vitals ?? { health: 100, action: 100, spirit: 100 },
    maxVitals: overrides.maxVitals ?? { health: 100, action: 100, spirit: 100 },
    bleed: {
      active: overrides.bleed?.active ?? false,
      stackCount: overrides.bleed?.stackCount ?? 0,
      remainingTicks: overrides.bleed?.remainingTicks ?? 0,
      damagePerTick: overrides.bleed?.damagePerTick ?? 0,
      damagePerSecondMilli: overrides.bleed?.damagePerSecondMilli ?? 0,
    },
    sleep: {
      active: overrides.sleep?.active ?? false,
      stacks: overrides.sleep?.stacks ?? 0,
      threshold: overrides.sleep?.threshold ?? 0,
      remainingTicks: overrides.sleep?.remainingTicks ?? 0,
    },
    suppression: overrides.suppression ?? {
      active: false,
      pressure: 0,
      remainingTicks: 0,
      source: null,
    },
    activeEffects: overrides.activeEffects ?? [],
    bodyVanishTick: overrides.bodyVanishTick ?? 0,
    lootable: overrides.lootable,
    hasLoot: overrides.hasLoot,
    lootRightsActorId: overrides.lootRightsActorId,
    respawnTick: overrides.respawnTick ?? 0,
    nextSampleTick: overrides.nextSampleTick,
    cloneSicknessTicks: overrides.cloneSicknessTicks ?? 0,
    professions: overrides.professions,
    activeTitle: overrides.activeTitle,
    careerGoal: overrides.careerGoal,
    skillPointsUsed: overrides.skillPointsUsed,
    skillPointsCap: overrides.skillPointsCap,
    shotSpreadDegreesMilli: overrides.shotSpreadDegreesMilli,
    credits: overrides.credits,
    combatQueue: overrides.combatQueue,
    abilityQueue: overrides.abilityQueue,
    inCombat: overrides.inCombat,
    peaceRequested: overrides.peaceRequested,
    personalShield: overrides.personalShield,
    weapon: overrides.weapon,
    stats: overrides.stats,
  };
}

function rustTickOutput(actors: RustAuthorityActorSnapshot[], tick: number): RustAuthorityBridgeTickOutput {
  return {
    schema: "successor.rust-authority-bridge-tick.v1",
    requestId: tick,
    tick,
    targetStateHash: `test-state-${tick}`,
    actors,
    combatEvents: [],
    inventory: [],
    reservations: [],
    npcJobs: [],
    timelineEvents: [],
    logoutActors: [],
    removedActorIds: [],
    metrics: {
      tick,
      shotsFired: 0,
      combatEvents: 0,
      hits: 0,
      deaths: 0,
      inventoryStacks: 0,
      reservations: 0,
      npcJobs: 0,
      timelineEvents: 0,
    },
  };
}

function packetEvents(packet: { events?: GameCombatEvent[]; compactEvents?: GameCompactCombatEvent[] }): GameCombatEvent[] {
  return [
    ...(packet.events ?? []),
    ...(packet.compactEvents ?? []).map((event): GameCombatEvent => ({
      id: event[0] as number,
      commandId: event[1] as number | null,
      tick: event[2] as number,
      shooterActorId: event[3] as string,
      targetActorId: event[4] as string,
      hitPoint: event[5] === null || event[6] === null ? undefined : { x: event[5] as number, y: event[6] as number },
      damage: event[7] as number,
      zone: event[8] as GameCombatEvent["zone"],
      previousLifeState: event[9] as GameCombatEvent["previousLifeState"],
      lifeState: event[10] as GameCombatEvent["lifeState"],
      targetLifecycleSeq: event[11] as number,
      bleedStackCount: event[12] as number,
      lifecycle: event[13] && event[14] && event[15] && event[16]
        ? {
            kind: event[13] as GameCombatEvent["lifecycle"]["kind"],
            from: event[14] as GameCombatEvent["lifecycle"]["from"],
            to: event[15] as GameCombatEvent["lifecycle"]["to"],
            cause: event[16] as string,
          }
        : {
            kind: "hit",
            from: event[9] as GameCombatEvent["previousLifeState"],
            to: event[10] as GameCombatEvent["lifeState"],
            cause: "compact event",
          },
      originPoint: event[23] === null || event[23] === undefined || event[24] === null || event[24] === undefined
        ? undefined
        : { x: event[23] as number, y: event[24] as number },
      kind: event[25] as GameCombatEvent["kind"],
      attackerActorId: event[26] as string | undefined,
      actionId: event[27] as GameCombatEvent["actionId"],
      hit: event[28] === null || event[28] === undefined ? undefined : event[28] === 1,
      pool: event[29] as GameCombatEvent["pool"],
      rollMilli: event[30] as number | undefined,
      toHitMilli: event[31] as number | undefined,
    })),
  ];
}

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const started = Date.now();
  while (Date.now() - started <= timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}
