import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

import { describe, expect, it } from "vitest";

// @ts-expect-error The verification runner is JavaScript and has no declaration surface.
import { allocatePorts, startFixtureServer } from "../../../tools/verification/scenario/runner.mjs";
// @ts-expect-error The fixture registry is JavaScript and has no declaration surface.
import { materializeFixtureSlice, resolveFixture, writeFixtureCharacterStore } from "../../../tools/verification/scenario/fixture-registry.mjs";
import { createSuccessorHeadlessHost, type SuccessorHeadlessHost } from "./host";
import { resolveFixtureInitialProfessions } from "./fixtureCharacterStore.testSupport";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const healthyActorId = "slow-consumer-healthy";
const slowActorId = "slow-consumer";
const generatedPacketCount = 10;
const slowConsumerFloodPacketCount = 2_048;
const healthyReceiptLatencyLimitMs = 2_000;
const injectedSlowConsumerBufferCapBytes = 4_096;

type JsonRecord = Record<string, unknown>;

type Receipt = {
  commandId: number;
  commandKind?: string;
  accepted: boolean;
  tick: number;
  reasonCode?: string;
};

interface FixtureServerRuntime {
  gameUrl: string;
  stop(): Promise<unknown>;
}

interface SlowConsumerTranscript {
  schema: "successor.slow-consumer-backpressure.v1";
  status: "pass" | "fail";
  durationMs: number;
  artifactPath: string;
  generatedPacketCount: number;
  floodPacketCount: number;
  bufferCapBytes: number;
  healthyReceipts: Array<Receipt & { latencyMs: number }>;
  statusBeforePause: JsonRecord | null;
  statusAfterGeneration: JsonRecord | null;
  transportPaused: boolean;
  teardown: JsonRecord | null;
  failure: string | null;
}

/**
 * The slow peer pauses its real Node WebSocket TCP reader after `game.hello`.
 * The fixture injects a small server transport cap so bounded output must
 * fail-close this peer without degrading healthy authority receipts.
 */
describe("headless outbound slow-consumer isolation", () => {
  it("bounds or fail-closes a non-draining session without delaying healthy authority receipts", async () => {
    const startedAt = performance.now();
    const runId = `slow-consumer-backpressure-${process.pid}-${Date.now()}`;
    const runDir = path.join(repoRoot, "verification", ".runs", "slow-consumer-backpressure", runId);
    const artifactPath = path.join(runDir, "slow-consumer-backpressure.json");
    await fs.mkdir(runDir, { recursive: true });

    let runtime: FixtureServerRuntime | null = null;
    let healthy: SuccessorHeadlessHost | null = null;
    let slowConsumer: SlowConsumerWorker | null = null;
    let statusBeforePause: JsonRecord | null = null;
    let statusAfterGeneration: JsonRecord | null = null;
    const healthyReceipts: SlowConsumerTranscript["healthyReceipts"] = [];
    let failure: unknown = null;
    let teardown: JsonRecord | null = null;
    let actualFloodPacketCount = 0;

    try {
      const scenario = {
        name: "slow-consumer-backpressure",
        fixture: "open-desert-movement",
        persistence: true,
        actors: {
          healthy: {
            character: "fixture:ranger-01",
            id: healthyActorId,
            spawn: { areaId: "open-desert-overworld", x: 520, y: 520, facing: "right" },
          },
        },
      };
      const fixture = await materializeFixtureSlice(await resolveFixture(scenario.fixture, repoRoot), runDir, scenario.actors);
      const characterStore = await writeFixtureCharacterStore(fixture, runDir, scenario.actors);
      await resolveFixtureInitialProfessions(characterStore.path);
      const [port] = await allocatePorts(1, { base: 28880 });
      const activeRuntime = await startFixtureServer({
        repoRoot,
        fixture,
        scenario,
        runId,
        runDir,
        port,
        characterStorePath: characterStore.path,
        lane: "accel",
        slowConsumerBufferCapBytes: injectedSlowConsumerBufferCapBytes,
      });
      runtime = activeRuntime;
      slowConsumer = await startSlowConsumer(activeRuntime.gameUrl);

      healthy = await createSuccessorHeadlessHost({
        endpoint: activeRuntime.gameUrl,
        slicePath: fixture.slicePath,
        actorId: healthyActorId,
        playerId: "healthy-player",
        characterId: healthyActorId,
        displayName: "Healthy Receipt Probe",
        spawnArea: "open-desert-overworld",
        spawnX: 520,
        spawnY: 520,
        facing: "right",
      });
      await healthy.start();

      statusBeforePause = await fetchJsonRecord(`${activeRuntime.gameUrl}/game/status`);
      expect(sessionCount(statusBeforePause, "active")).toBe(2);

      const receiptCollector = collectReceipts(healthy);
      try {
        for (let index = 0; index < generatedPacketCount; index += 1) {
          if (index === 1) {
            actualFloodPacketCount = await floodPausedConsumer(activeRuntime.gameUrl, slowConsumerFloodPacketCount, statusBeforePause);
          }
          const commandStartedAt = performance.now();
          const result = await healthy.handleVerb("/move 1 0 1 Right false");
          const commandId = queuedCommandId(result);
          await advanceManualClock(activeRuntime.gameUrl, 1);
          const receipt = await receiptCollector.waitFor(commandId);
          const latencyMs = Math.round((performance.now() - commandStartedAt) * 100) / 100;
          healthyReceipts.push({ ...receipt, latencyMs });
          expect(receipt).toMatchObject({ commandId, commandKind: "Move", accepted: true });
          expect(latencyMs).toBeLessThan(healthyReceiptLatencyLimitMs);
        }
      } finally {
        receiptCollector.close();
      }

      statusAfterGeneration = await fetchJsonRecord(`${activeRuntime.gameUrl}/game/status`);
      expect(statusAfterGeneration.shardId).toBeTruthy();
      expect(sessionCount(statusAfterGeneration, "active")).toBeGreaterThanOrEqual(1);
      expect(healthy.state.serverAuthority.connected).toBe(true);
      expect(healthyReceipts).toHaveLength(generatedPacketCount);

      assertSlowConsumerIsolation(statusBeforePause, statusAfterGeneration, actualFloodPacketCount);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (slowConsumer) await slowConsumer.close();
      if (healthy) await healthy.close().catch(() => undefined);
      if (runtime) {
        const result: unknown = await runtime.stop().catch((error: unknown) => ({ ok: false, error: errorMessage(error) }));
        teardown = jsonRecord(result);
      }
      const transcript: SlowConsumerTranscript = {
        schema: "successor.slow-consumer-backpressure.v1",
        status: failure === null ? "pass" : "fail",
        durationMs: Math.round(performance.now() - startedAt),
        artifactPath: path.relative(repoRoot, artifactPath),
        generatedPacketCount,
        floodPacketCount: actualFloodPacketCount,
        bufferCapBytes: injectedSlowConsumerBufferCapBytes,
        healthyReceipts,
        statusBeforePause,
        statusAfterGeneration,
        transportPaused: slowConsumer !== null,
        teardown,
        failure: failure === null ? null : errorMessage(failure),
      };
      await fs.writeFile(artifactPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
    }
  }, 45_000);
});


interface SlowConsumerWorker {
  close(): Promise<void>;
}

function startSlowConsumer(endpoint: string): Promise<SlowConsumerWorker> {
  const releaseSignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const worker = new Worker(new URL("./slowConsumerBackpressure.worker.mjs", import.meta.url), {
    workerData: { endpoint, actorId: slowActorId, releaseSignal: releaseSignal.buffer },
  });
  const ready = Promise.withResolvers<SlowConsumerWorker>();
  let settled = false;
  const rejectBeforeReady = (error: unknown): void => {
    if (settled) return;
    settled = true;
    ready.reject(error);
  };
  worker.once("error", rejectBeforeReady);
  worker.once("exit", (code) => {
    if (code !== 0) rejectBeforeReady(new Error(`slow consumer worker exited with code ${code}`));
  });
  worker.on("message", (message: unknown) => {
    if (!isRecord(message) || message.type !== "paused" || settled) return;
    settled = true;
    ready.resolve({
      close: async () => {
        try {
          if (worker.threadId !== -1) {
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                cleanup();
                resolve();
              }, 2_000);
              const cleanup = (): void => {
                clearTimeout(timer);
                worker.off("message", onMessage);
                worker.off("error", onError);
                worker.off("exit", onExit);
              };
              const onMessage = (next: unknown): void => {
                if (isRecord(next) && next.type === "closed") {
                  cleanup();
                  resolve();
                }
              };
              const onError = (err: unknown): void => {
                cleanup();
                reject(err);
              };
              const onExit = (): void => {
                cleanup();
                resolve();
              };
              worker.on("message", onMessage);
              worker.on("error", onError);
              worker.on("exit", onExit);

              Atomics.store(releaseSignal, 0, 1);
              Atomics.notify(releaseSignal, 0);
            });
          }
        } finally {
          await worker.terminate();
        }
      },
    });
  });
  return ready.promise;
}

function collectReceipts(host: SuccessorHeadlessHost): {
  waitFor(commandId: number): Promise<Receipt>;
  close(): void;
} {
  const receipts = new Map<number, Receipt>();
  const waiters = new Map<number, { resolve(value: Receipt): void; reject(reason: Error): void }>();
  const unsubscribe = host.onEnvelope?.((envelope) => {
    if (envelope.type !== "receipt") return;
    const receipt: Receipt = {
      commandId: envelope.commandId,
      commandKind: envelope.commandKind,
      accepted: envelope.accepted,
      tick: envelope.tick,
      ...(envelope.reasonCode ? { reasonCode: envelope.reasonCode } : {}),
    };
    receipts.set(receipt.commandId, receipt);
    const waiter = waiters.get(receipt.commandId);
    if (!waiter) return;
    waiters.delete(receipt.commandId);
    waiter.resolve(receipt);
  });
  return {
    waitFor(commandId: number): Promise<Receipt> {
      const existing = receipts.get(commandId);
      if (existing) return Promise.resolve(existing);
      const gate = Promise.withResolvers<Receipt>();
      waiters.set(commandId, gate);
      return gate.promise;
    },
    close(): void {
      unsubscribe?.();
      for (const waiter of waiters.values()) {
        waiter.reject(new Error("receipt collector closed"));
      }
      waiters.clear();
    },
  };
}

function queuedCommandId(result: readonly { type: string; event?: string; data?: Record<string, unknown> }[]): number {
  const queued = result.find((entry) => entry.type === "event" && entry.event === "authority_queued");
  if (typeof queued?.data?.commandId !== "number") {
    throw new Error(`healthy move was not queued for authority: ${JSON.stringify(result)}`);
  }
  return queued.data.commandId;
}

async function floodPausedConsumer(gameUrl: string, maxCount: number, statusBefore: JsonRecord | null): Promise<number> {
  const disconnectedBefore = statusBefore ? sessionCount(statusBefore, "disconnected") : 0;
  for (let index = 0; index < maxCount; index += 1) {
    await advanceManualClock(gameUrl, 1);
    if ((index + 1) % 16 === 0) {
      const currentStatus = await fetchJsonRecord(`${gameUrl}/game/status`);
      if (sessionCount(currentStatus, "disconnected") > disconnectedBefore) {
        return index + 1;
      }
    }
  }
  return maxCount;
}

async function advanceManualClock(gameUrl: string, ticks: number): Promise<void> {
  const response = await fetch(`${gameUrl}/game/debug/clock/advance`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ticks }),
  });
  const body = await fetchJsonRecordFromResponse(response, "manual clock advance");
  if (!response.ok || body.advancedTicks !== ticks) {
    throw new Error(`manual clock advance failed: ${JSON.stringify(body)}`);
  }
}

/**
 * A real slow consumer must become observable at the server boundary: either
 * fail-closed disconnect, or an explicit per-peer bounded backpressure state.
 * Aggregate pending application work is insufficient because it is drained
 * before `socket.send()` and says nothing about transport-buffer growth.
 */
function assertSlowConsumerIsolation(before: JsonRecord, after: JsonRecord, packetsGenerated: number): void {
  const disconnectedBefore = sessionCount(before, "disconnected");
  const disconnectedAfter = sessionCount(after, "disconnected");
  if (disconnectedAfter > disconnectedBefore) return;

  const delivery = jsonRecord(jsonRecord(after.instrumentation).delivery);
  const backpressure = jsonRecord(delivery.backpressure);
  const maxQueuedBytes = backpressure.maxQueuedBytes;
  const slowConsumerCount = backpressure.slowConsumerCount;
  const queuedBytes = backpressure.queuedBytes;
  if (
    Number.isFinite(maxQueuedBytes)
    && Number.isFinite(queuedBytes)
    && Number.isFinite(slowConsumerCount)
    && Number(maxQueuedBytes) > 0
    && Number(queuedBytes) <= Number(maxQueuedBytes)
    && Number(slowConsumerCount) >= 1
  ) {
    return;
  }

  throw new Error(
    "missing outbound slow-consumer isolation contract: a paused real TCP reader received "
      + `${packetsGenerated} generated packet opportunities while a healthy client accepted correlated receipts, `
      + `but sessions.disconnected stayed ${disconnectedBefore}->${disconnectedAfter} and /game/status exposes no `
      + "delivery.backpressure { maxQueuedBytes, queuedBytes, slowConsumerCount } bound. "
      + `Current aggregate delivery=${JSON.stringify(delivery)}.`,
  );
}

function sessionCount(status: JsonRecord, field: "active" | "disconnected"): number {
  const sessions = jsonRecord(jsonRecord(status.instrumentation).sessions);
  const value = sessions[field];
  if (typeof value !== "number") throw new Error(`/game/status instrumentation.sessions.${field} was not numeric`);
  return value;
}

async function fetchJsonRecord(url: string): Promise<JsonRecord> {
  const response = await fetch(url);
  return fetchJsonRecordFromResponse(response, `GET ${url}`);
}

async function fetchJsonRecordFromResponse(response: Response, label: string): Promise<JsonRecord> {
  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new Error(`${label} returned a non-object JSON payload`);
  return payload;
}

function jsonRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
