import path from "node:path";

import { Client as ColyseusClient, type Room as ColyseusRoom } from "@colyseus/sdk";
import { describe, expect, it } from "vitest";

// @ts-expect-error The verification runner is JavaScript and has no declaration surface.
import { allocatePorts, startFixtureServer } from "../../../tools/verification/scenario/runner.mjs";
// @ts-expect-error The fixture registry is JavaScript and has no declaration surface.
import { materializeFixtureSlice, resolveFixture, writeFixtureCharacterStore } from "../../../tools/verification/scenario/fixture-registry.mjs";
import { createSuccessorHeadlessHost, type SuccessorHeadlessHost } from "./host";
import { resolveFixtureInitialProfessions } from "./fixtureCharacterStore.testSupport";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const healthyActorId = "movement-open";
const malformedActorId = "movement-blocked";

type JsonRecord = Record<string, unknown>;

interface FixtureServerRuntime {
  gameUrl: string;
  readStatus(): Promise<unknown>;
  stop(): Promise<unknown>;
}

interface ShardStatus {
  shardId: string;
  tick: number;
  sessionCount: number;
  rejectedPackets: number;
}

interface AuthorityReceipt {
  commandId: number;
  commandKind?: string;
  accepted: boolean;
}

/**
 * A schema-invalid command from one real Colyseus session must be rejected in
 * band, without interrupting command authority for a different identity.
 */
describe("malformed client isolation", () => {
  it("rejects a schema-invalid game.command while a healthy peer still receives its accepted receipt", async () => {
    const runId = `malformed-client-isolation-${process.pid}-${Date.now()}`;
    const runDir = path.join(repoRoot, "verification", ".runs", "malformed-client-isolation", runId);
    const scenario = {
      name: "malformed-client-isolation",
      fixture: "open-desert-movement-blocked",
      persistence: true,
      actors: {
        healthy: { character: "fixture:ranger-open" },
        malformed: { character: "fixture:ranger-blocked" },
      },
    };
    let runtime: FixtureServerRuntime | null = null;
    let healthy: SuccessorHeadlessHost | null = null;
    let malformedRoom: ColyseusRoom | null = null;
    const teardownFailures: string[] = [];

    try {
      const resolvedFixture = await resolveFixture(scenario.fixture, repoRoot);
      const fixture = await materializeFixtureSlice(resolvedFixture, runDir, scenario.actors);
      const characterStore = await writeFixtureCharacterStore(fixture, runDir, scenario.actors);
      await resolveFixtureInitialProfessions(characterStore.path);
      const [port] = await allocatePorts(1, { base: 28750 });
      runtime = await startFixtureServer({
        repoRoot,
        fixture,
        scenario,
        runId,
        runDir,
        port,
        characterStorePath: characterStore.path,
        lane: "accel",
      }) as FixtureServerRuntime;

      healthy = await createSuccessorHeadlessHost({
        endpoint: runtime.gameUrl,
        slicePath: fixture.slicePath,
        actorId: healthyActorId,
        commandIdFloor: 1,
        playerId: "malformed-isolation-healthy",
        characterId: healthyActorId,
        displayName: "Healthy Isolation Peer",
        spawnArea: "open-desert-overworld",
        spawnX: 520,
        spawnY: 520,
        facing: "right",
      });
      await healthy.start();

      const malformedClient = new ColyseusClient(runtime.gameUrl);
      malformedRoom = await malformedClient.joinOrCreate("game", {
        playerId: "malformed-isolation-peer",
        actorId: malformedActorId,
        characterId: malformedActorId,
        displayName: "Malformed Isolation Peer",
        zoneId: "open-desert",
        spawnArea: "open-desert-overworld",
        spawnX: "520",
        spawnY: "522",
        facing: "right",
      });
      const malformedPackets = packetInbox(malformedRoom);
      malformedRoom.send("game.ready");
      await malformedPackets.waitFor((packet) => packet.type === "game.hello");

      const beforeRejection = shardStatus(await runtime.readStatus());
      expect(beforeRejection.sessionCount).toBe(2);

      malformedRoom.send("game.command", {
        session: 0,
        player: 0,
        command_id: 1,
        issued_at_tick: 0,
        command: { Move: { dx: "not-a-number" } },
      });

      const malformedError = await malformedPackets.waitFor(
        (packet) => packet.type === "game.error" && packet.code === "invalid_packet",
      );
      expect(malformedError).toMatchObject({
        type: "game.error",
        code: "invalid_packet",
        message: "game packet schema mismatch",
      });

      const afterRejection = shardStatus(await runtime.readStatus());
      expect(afterRejection.shardId).toBe(beforeRejection.shardId);
      expect(afterRejection.tick).toBeGreaterThanOrEqual(beforeRejection.tick);
      expect(afterRejection.sessionCount).toBe(2);
      expect(afterRejection.rejectedPackets).toBe(beforeRejection.rejectedPackets + 1);

      const receiptGate = receiptFor(healthy, 1);
      const queued = queuedMove(await healthy.handleVerb("/move 1 0 1 Right"));
      expect(queued).toEqual({ commandId: 1, commandKind: "Move" });

      const healthyReceipt = await receiptGate;
      expect(healthyReceipt).toMatchObject({
        commandId: queued.commandId,
        commandKind: queued.commandKind,
        accepted: true,
      });

      const finalStatus = shardStatus(await runtime.readStatus());
      expect(finalStatus.shardId).toBe(beforeRejection.shardId);
      expect(finalStatus.rejectedPackets).toBe(afterRejection.rejectedPackets);
      expect(finalStatus.tick).toBeGreaterThanOrEqual(afterRejection.tick);
    } finally {
      if (malformedRoom) {
        await malformedRoom.leave(true).catch((error: unknown) => {
          teardownFailures.push(`malformed room leave: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      if (healthy) {
        await healthy.close().catch((error: unknown) => {
          teardownFailures.push(`healthy host close: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
      if (runtime) {
        const stopResult = await runtime.stop().catch((error: unknown) => {
          teardownFailures.push(`fixture ProcessHost stop: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });
        if (stopResult && jsonRecord(stopResult, "fixture server teardown").ok !== true) {
          teardownFailures.push(`fixture ProcessHost reported an unclean stop: ${JSON.stringify(stopResult)}`);
        }
      }
    }
    if (teardownFailures.length > 0) throw new Error(teardownFailures.join("; "));
  }, 30_000);
});

function packetInbox(room: ColyseusRoom): {
  waitFor(predicate: (packet: JsonRecord) => boolean): Promise<JsonRecord>;
} {
  const packets: JsonRecord[] = [];
  const waiters = new Set<{
    predicate: (packet: JsonRecord) => boolean;
    resolve(packet: JsonRecord): void;
  }>();

  room.onMessage("game.packet", (packet) => {
    const record = jsonRecordOrNull(packet);
    if (!record) return;
    packets.push(record);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(record)) continue;
      waiters.delete(waiter);
      waiter.resolve(record);
    }
  });

  return {
    waitFor(predicate) {
      const existing = packets.find(predicate);
      if (existing) return Promise.resolve(existing);

      const gate = Promise.withResolvers<JsonRecord>();
      waiters.add({ predicate, resolve: gate.resolve });
      return gate.promise;
    },
  };
}

function receiptFor(host: SuccessorHeadlessHost, commandId: number): Promise<AuthorityReceipt> {
  const gate = Promise.withResolvers<AuthorityReceipt>();
  const unsubscribe = host.onEnvelope?.((envelope) => {
    if (envelope.type !== "receipt" || envelope.commandId !== commandId) return;
    unsubscribe?.();
    gate.resolve({
      commandId: envelope.commandId,
      commandKind: envelope.commandKind,
      accepted: envelope.accepted,
    });
  });
  return gate.promise;
}

function queuedMove(result: readonly { type: string; event?: string; data?: Record<string, unknown> }[]): { commandId: number; commandKind: "Move" } {
  const event = result.find((entry) => entry.type === "event" && entry.event === "authority_queued");
  if (!event?.data || event.data.commandKind !== "Move" || typeof event.data.commandId !== "number") {
    throw new Error(`healthy move was not queued as a canonical Move command: ${JSON.stringify(result)}`);
  }
  return { commandId: event.data.commandId, commandKind: "Move" };
}

function shardStatus(value: unknown): ShardStatus {
  const record = jsonRecord(value, "server status");
  const counters = jsonRecord(record.counters, "server status counters");
  const tick = record.tick;
  const sessionCount = record.sessionCount;
  const rejectedPackets = counters.rejectedPackets;
  if (
    typeof record.shardId !== "string"
    || typeof tick !== "number"
    || !Number.isFinite(tick)
    || typeof sessionCount !== "number"
    || !Number.isInteger(sessionCount)
    || typeof rejectedPackets !== "number"
    || !Number.isInteger(rejectedPackets)
  ) {
    throw new Error(`unexpected server status: ${JSON.stringify(record)}`);
  }
  return {
    shardId: record.shardId,
    tick,
    sessionCount,
    rejectedPackets,
  };
}

function jsonRecord(value: unknown, label: string): JsonRecord {
  const record = jsonRecordOrNull(value);
  if (!record) throw new Error(`${label} returned a non-object JSON value`);
  return record;
}

function jsonRecordOrNull(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonRecord : null;
}
