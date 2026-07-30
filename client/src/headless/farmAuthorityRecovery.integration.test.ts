import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

// @ts-expect-error The verification runner is JavaScript and has no declaration surface.
import { allocatePorts, startFixtureServer } from "../../../tools/verification/scenario/runner.mjs";
// @ts-expect-error The fixture registry is JavaScript and has no declaration surface.
import { materializeFixtureSlice, resolveFixture, writeFixtureCharacterStore } from "../../../tools/verification/scenario/fixture-registry.mjs";
import { createSuccessorHeadlessHost, type SuccessorHeadlessHost } from "./host";
import { resolveFixtureInitialProfessions } from "./fixtureCharacterStore.testSupport";
import { declaredSliceActorCount } from "../slice-core/gameState";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const actorId = "farm-recovery-probe";
const claim = { planetId: "ashvat", areaId: "open-desert-overworld", x: 800, y: 800 };
const farmCell = { x: 802, y: 806 };

type JsonRecord = Record<string, unknown>;

interface DebugSetupRecord {
  label: string;
  command: JsonRecord;
  response: JsonRecord;
}

interface FixtureServerRuntime {
  gameUrl: string;
  status: {
    source?: {
      stateHash?: string;
      actorCount?: number;
    };
  };
  stop(): Promise<unknown>;
}

interface FarmRecoveryTranscript {
  schema: "successor.farm-authority-recovery.v1";
  status: "pass" | "fail";
  durationMs: number;
  artifactPath: string;
  fixture: {
    name: string;
    slicePath: string;
    sourceStateHash: string | null;
    sourceActorCount: number | null;
  };
  setup: DebugSetupRecord[];
  mismatch: JsonRecord;
  recovery: JsonRecord;
  sent: Array<{ commandId: number; kind: string }>;
  receipts: Array<{ commandId: number; commandKind?: string; accepted: boolean; tick: number; reasonCode?: string }>;
  finalFarmAuthority: JsonRecord | null;
  teardown: JsonRecord | null;
  failure: string | null;
}

/**
 * This is deliberately an integration proof rather than a fixture echo:
 * a ProcessHost-owned real Rust bridge/server receives the recovered commands.
 * Debug HTTP is limited to disposable farm setup; the commands under proof are
 * the headless client's original queued envelopes 1/2/3.
 */
describe("headless farm authority source recovery", () => {
  it("retains till/plant/water IDs across a verified source recovery and settles each once", async () => {
    const started = performance.now();
    const runId = `farm-authority-recovery-${process.pid}-${Date.now()}`;
    const runDir = path.join(repoRoot, "verification", ".runs", "farm-authority-recovery", runId);
    const artifactPath = path.join(runDir, "farm-authority-recovery.json");
    await fs.mkdir(runDir, { recursive: true });

    const scenario = {
      name: "farm-authority-recovery",
      fixture: "open-desert-bootstrap-crafter",
      persistence: true,
      actors: {
        farmer: {
          character: "fixture:bootstrap-crafter",
          id: actorId,
          spawn: { areaId: claim.areaId, x: farmCell.x, y: farmCell.y, facing: "right" },
        },
      },
    };
    const setup: DebugSetupRecord[] = [];
    const mismatch: JsonRecord = {};
    const recovery: JsonRecord = {};
    let sent: FarmRecoveryTranscript["sent"] = [];
    let receipts: FarmRecoveryTranscript["receipts"] = [];
    let finalFarmAuthority: JsonRecord | null = null;
    let teardown: JsonRecord | null = null;
    let failure: unknown = null;
    let host: SuccessorHeadlessHost | null = null;
    let runtime: FixtureServerRuntime | null = null;
    let fixtureSlicePath = "";
    let fixtureSourceStateHash: string | null = null;
    let fixtureSourceActorCount: number | null = null;

    try {
      const resolvedFixture = await resolveFixture(scenario.fixture, repoRoot);
      const fixture = await materializeFixtureSlice(resolvedFixture, runDir, scenario.actors);
      const characterStore = await writeFixtureCharacterStore(fixture, runDir, scenario.actors);
      expect(characterStore.characters[0]).toMatchObject({
        id: actorId,
        position: { areaId: claim.areaId, x: farmCell.x, y: farmCell.y, facing: "right" },
        worldEntryClaimed: false,
      });
      await resolveFixtureInitialProfessions(characterStore.path);
      fixtureSlicePath = fixture.slicePath;
      fixtureSourceStateHash = fixture.sourceStateHash;
      fixtureSourceActorCount = fixture.sourceActorCount;
      const [port] = await allocatePorts(1, { base: 28680 });
      runtime = await startFixtureServer({
        repoRoot,
        fixture,
        scenario,
        runId,
        runDir,
        port,
        characterStorePath: characterStore.path,
        lane: "accel",
      });
      const fixtureRuntime = runtime;
      if (!fixtureRuntime) throw new Error("fixture server did not start");
      host = await createSuccessorHeadlessHost({
        endpoint: fixtureRuntime.gameUrl,
        slicePath: fixture.slicePath,
        actorId,
        commandIdFloor: 1,
        playerId: "local",
        characterId: actorId,
        displayName: "Farm Recovery Probe",
        spawnArea: claim.areaId,
        spawnX: farmCell.x,
        spawnY: farmCell.y,
        facing: "right",
      });
      fixtureSourceActorCount = declaredSliceActorCount(host.slice);
      await host.start();

      setup.push(await postDebugCommand(fixtureRuntime.gameUrl, actorId, "claim fixture parcel", {
        ClaimParcel: { planet_id: claim.planetId, area_id: claim.areaId, x: claim.x, y: claim.y, tier: "homestead" },
      }));
      setup.push(await postDebugCommand(fixtureRuntime.gameUrl, actorId, "grant bio novice", {
        DebugGrantSkillBoxes: { skill_box_ids: ["bioengineer-novice"] },
      }));
      setup.push(await postDebugCommand(fixtureRuntime.gameUrl, actorId, "give gene sampler", {
        DebugGiveItem: { item_id: 6201, variant_id: 0, quantity: 1 },
      }));
      setup.push(await postDebugCommand(fixtureRuntime.gameUrl, actorId, "sample registered ashgrain genome", {
        GeneSample: { species: "ashgrain" },
      }));

      const preparedOracle = await fetchJson(`${fixtureRuntime.gameUrl}/game/debug/oracle`);
      const parcel = requireOwnedParcel(preparedOracle, claim.areaId, claim.x, claim.y);
      const seed = requireSeed(preparedOracle, actorId);
      expect(parcel.farmYard).toMatchObject({ x: 801, y: 805, w: 14, h: 10 });
      expect(farmCell.x).toBeGreaterThanOrEqual(parcel.farmYard.x);
      expect(farmCell.y).toBeGreaterThanOrEqual(parcel.farmYard.y);

      // The runtime private packet ingress calls the real applyServerPacket path.
      // Its type is private only to preserve the production host surface.
      const packetIngress = host as unknown as { applyPacket(packet: unknown): void };
      packetIngress.applyPacket({
        type: "game.delta",
        delta: {
          schema: "successor.authoritative-shard-delta.v1",
          shardId: "forced-source-mismatch",
          tick: host.state.serverAuthority.snapshotTick + 1,
          playerActorId: actorId,
          actors: {},
          sourceStateHash: "forced-mismatch",
          sourceActorCount: declaredSliceActorCount(host.slice),
        },
        receipts: [],
        events: [],
      });

      mismatch.sourceMatchesClient = host.state.serverAuthority.sourceMatchesClient;
      mismatch.status = host.state.status;
      mismatch.inFlightBeforeQueue = host.state.authorityCommands.inFlight?.command_id ?? null;
      expect(host.state.serverAuthority.sourceMatchesClient).toBe(false);

      const till = await host.handleVerb(`/till-tile parcel_id=${parcel.parcelId} cell_x=${farmCell.x} cell_y=${farmCell.y}`);
      const plant = await host.handleVerb(`/plant-seed parcel_id=${parcel.parcelId} cell_x=${farmCell.x} cell_y=${farmCell.y} container=${seed.container} stack_id=${seed.stackId} variant_id=${seed.variantId}`);
      const water = await host.handleVerb(`/water-tile parcel_id=${parcel.parcelId} cell_x=${farmCell.x} cell_y=${farmCell.y}`);
      const queued = [till, plant, water].map((result) => queuedCommand(result));
      expect(queued.map((entry) => entry.commandId)).toEqual([1, 2, 3]);
      expect(queued.map((entry) => entry.flushed)).toEqual([0, 0, 0]);
      expect(host.state.authorityCommands.pending.map((entry) => entry.command_id)).toEqual([1, 2, 3]);
      expect(host.state.authorityCommands.inFlight).toBeNull();
      expect(host.state.serverAuthority.sentCommandLog).toEqual([]);
      expect(host.state.serverAuthority.receiptLog).toEqual([]);
      mismatch.queuedCommandIds = host.state.authorityCommands.pending.map((entry) => entry.command_id);
      mismatch.inFlightAfterQueue = host.state.authorityCommands.inFlight?.command_id ?? null;
      mismatch.sentCommandIds = host.state.serverAuthority.sentCommandLog.map((entry) => entry.commandId);

      const receiptGate = receiptCollector(host, [1, 2, 3]);
      packetIngress.applyPacket({
        type: "game.delta",
        delta: {
          schema: "successor.authoritative-shard-delta.v1",
          shardId: "verified-source-recovery",
          tick: host.state.serverAuthority.snapshotTick + 2,
          playerActorId: actorId,
          actors: {},
          sourceStateHash: fixture.sourceStateHash,
          sourceActorCount: declaredSliceActorCount(host.slice),
        },
        receipts: [],
        events: [],
      });
      recovery.sourceMatchesClient = host.state.serverAuthority.sourceMatchesClient;
      recovery.pendingBeforeSettlement = host.state.authorityCommands.pending.map((entry) => entry.command_id);
      expect(host.state.serverAuthority.sourceMatchesClient).toBe(true);

      receipts = await receiptGate.wait();
      sent = host.state.serverAuthority.sentCommandLog.map((entry) => ({ commandId: entry.commandId, kind: entry.kind }));
      expect(sent).toEqual([
        { commandId: 1, kind: "TillTile" },
        { commandId: 2, kind: "PlantSeed" },
        { commandId: 3, kind: "WaterTile" },
      ]);
      expect(receipts.map((entry) => entry.commandId)).toEqual([1, 2, 3]);
      expect(receipts.map((entry) => entry.accepted)).toEqual([true, true, true]);
      expect(host.state.authorityCommands.pending).toEqual([]);
      expect(host.state.authorityCommands.inFlight).toBeNull();
      expect(host.state.serverAuthority.receiptLog.map((entry) => entry.commandId)).toEqual([1, 2, 3]);

      const finalOracle = await fetchJson(`${fixtureRuntime.gameUrl}/game/debug/oracle`);
      finalFarmAuthority = requireFarmTile(finalOracle, parcel.parcelId, farmCell);
      expect(finalFarmAuthority.tilled).toBe(true);
      expect(finalFarmAuthority.crop).toBeTruthy();
      expect(Number(finalFarmAuthority.moisturePct)).toBeGreaterThan(0);
      recovery.receiptIds = receipts.map((entry) => entry.commandId);
      recovery.finalQueue = host.state.authorityCommands.pending.map((entry) => entry.command_id);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (host) await host.close().catch(() => undefined);
      if (runtime) {
        const stopResult: unknown = await runtime.stop().catch((error: unknown) => ({ ok: false, error: errorMessage(error) }));
        teardown = jsonRecord(stopResult);
      }
      const transcript: FarmRecoveryTranscript = {
        schema: "successor.farm-authority-recovery.v1",
        status: failure === null ? "pass" : "fail",
        durationMs: Math.round(performance.now() - started),
        artifactPath: path.relative(repoRoot, artifactPath),
        fixture: {
          name: scenario.fixture,
          slicePath: fixtureSlicePath ? path.relative(repoRoot, fixtureSlicePath) : "",
          sourceStateHash: fixtureSourceStateHash,
          sourceActorCount: fixtureSourceActorCount,
        },
        setup,
        mismatch,
        recovery,
        sent,
        receipts,
        finalFarmAuthority,
        teardown: teardown ? jsonRecord(teardown) : null,
        failure: failure === null ? null : errorMessage(failure),
      };
      await fs.writeFile(artifactPath, `${JSON.stringify(transcript, null, 2)}\n`, "utf8");
    }
  }, 30_000);
});

function receiptCollector(
  host: SuccessorHeadlessHost,
  expectedIds: readonly number[],
): { wait(): Promise<Array<{ commandId: number; commandKind?: string; accepted: boolean; tick: number; reasonCode?: string }>> } {
  const gate = Promise.withResolvers<Array<{ commandId: number; commandKind?: string; accepted: boolean; tick: number; reasonCode?: string }>>();
  const receipts: Array<{ commandId: number; commandKind?: string; accepted: boolean; tick: number; reasonCode?: string }> = [];
  const unsubscribe = host.onEnvelope?.((envelope) => {
    if (envelope.type !== "receipt" || !expectedIds.includes(envelope.commandId)) return;
    if (receipts.some((entry) => entry.commandId === envelope.commandId)) return;
    receipts.push({
      commandId: envelope.commandId,
      commandKind: envelope.commandKind,
      accepted: envelope.accepted,
      tick: envelope.tick,
      ...(envelope.reasonCode ? { reasonCode: envelope.reasonCode } : {}),
    });
    if (receipts.length !== expectedIds.length) return;
    unsubscribe?.();
    gate.resolve(receipts);
  });
  return { wait: () => gate.promise };
}

async function postDebugCommand(gameUrl: string, actor: string, label: string, command: JsonRecord): Promise<DebugSetupRecord> {
  const response = await fetch(`${gameUrl}/game/debug/authority-command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actorId: actor, command }),
  });
  const payload = await readJsonRecord(response, `debug setup ${label}`);
  const receipt = jsonRecord(payload.receipt);
  if (!response.ok || receipt.accepted !== true) {
    throw new Error(`debug setup ${label} failed: ${JSON.stringify(payload)}`);
  }
  return { label, command, response: payload };
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed ${response.status}`);
  const payload: unknown = await response.json();
  return payload;
}

async function readJsonRecord(response: Response, label: string): Promise<JsonRecord> {
  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new Error(`${label} returned a non-object JSON response`);
  return payload;
}

function queuedCommand(result: readonly { type: string; event?: string; data?: Record<string, unknown> }[]): { commandId: number; flushed: number } {
  const event = result.find((entry) => entry.type === "event" && entry.event === "authority_queued");
  if (!event?.data || typeof event.data.commandId !== "number" || typeof event.data.flushed !== "number") {
    throw new Error(`authority command was not queued: ${JSON.stringify(result)}`);
  }
  return { commandId: event.data.commandId, flushed: event.data.flushed };
}

function requireOwnedParcel(oracle: unknown, areaId: string, x: number, y: number): { parcelId: string; farmYard: { x: number; y: number; w: number; h: number } } {
  const rows = arrayField(oracle, "placedParcels");
  for (const row of rows) {
    const parcel = jsonRecord(row);
    const rect = jsonRecord(parcel.rect);
    if (parcel.areaId !== areaId || rect.x !== x || rect.y !== y || typeof parcel.parcelId !== "string") continue;
    const yard = jsonRecord(parcel.farmYard);
    const yardX = yard.x;
    const yardY = yard.y;
    const yardWidth = yard.w;
    const yardHeight = yard.h;
    if (typeof yardX !== "number" || typeof yardY !== "number" || typeof yardWidth !== "number" || typeof yardHeight !== "number") continue;
    return {
      parcelId: parcel.parcelId,
      farmYard: { x: yardX, y: yardY, w: yardWidth, h: yardHeight },
    };
  }
  throw new Error(`fixture setup did not create parcel at ${areaId}:${x},${y}`);
}

function requireSeed(oracle: unknown, ownerActorId: string): { container: string; stackId: string; variantId: number } {
  const rows = arrayField(oracle, "inventory");
  for (const row of rows) {
    const seed = jsonRecord(row);
    if (seed.itemId !== 6001 || typeof seed.container !== "string" || !seed.container.startsWith(`${ownerActorId}:`)) continue;
    if (typeof seed.stackId !== "string" && typeof seed.stackId !== "number") continue;
    if (typeof seed.variantId !== "number") continue;
    return { container: seed.container, stackId: String(seed.stackId), variantId: seed.variantId };
  }
  throw new Error(`fixture setup did not create an ashgrain seed for ${ownerActorId}`);
}

function requireFarmTile(oracle: unknown, parcelId: string, cell: { x: number; y: number }): JsonRecord {
  const plots = arrayField(oracle, "farmPlots");
  for (const candidate of plots) {
    const plot = jsonRecord(candidate);
    if (plot.parcelId !== parcelId) continue;
    for (const tile of arrayField(plot, "tiles")) {
      const record = jsonRecord(tile);
      if (record.cellX === cell.x && record.cellY === cell.y) return record;
    }
  }
  throw new Error(`real authority never produced farm tile ${parcelId}:${cell.x},${cell.y}`);
}

function arrayField(value: unknown, key: string): unknown[] {
  const record = jsonRecord(value);
  const field = record[key];
  if (!Array.isArray(field)) throw new Error(`expected ${key} array in authority response`);
  return field;
}

function jsonRecord(value: unknown): JsonRecord {
  if (!isRecord(value)) throw new Error("expected object JSON value");
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
