import { Client as ColyseusClient, type Room as ColyseusRoom } from "@colyseus/sdk";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

import { createApp } from "../src/index.js";

interface BenchClient {
  index: number;
  room: ColyseusRoom;
  sentAt: Map<number, number>;
}

const playerCount = envInt("GAME_WS_BENCH_PLAYERS", 500);
const commandsPerPlayer = envInt("GAME_WS_BENCH_COMMANDS", 4);
const connectBatch = envInt("GAME_WS_BENCH_CONNECT_BATCH", 100);
const timeoutMs = envInt("GAME_WS_BENCH_TIMEOUT_MS", 20_000);
const commandIntervalMs = envInt("GAME_WS_BENCH_COMMAND_INTERVAL_MS", 16);
const postConnectSettleMs = envInt("GAME_WS_BENCH_POST_CONNECT_SETTLE_MS", 250);
const helloTimeoutMs = envInt("GAME_WS_BENCH_HELLO_TIMEOUT_MS", playerCount >= 800 ? 15_000 : 5_000);
const commandKind = "move";
const receiptP95BudgetMs = envInt("GAME_WS_BENCH_RECEIPT_P95_BUDGET_MS", commandsPerPlayer === 1 ? 250 : 500);

process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "silent";
process.env.GAME_SHARD_PERSISTENCE = process.env.GAME_SHARD_PERSISTENCE ?? "0";
process.env.GAME_MAX_SESSIONS = String(Math.max(playerCount + 16, envInt("GAME_MAX_SESSIONS", 0)));
process.env.GAME_AOI_RADIUS_CELLS = process.env.GAME_AOI_RADIUS_CELLS ?? "14";
process.env.GAME_SNAPSHOT_INTERVAL_MS = process.env.GAME_SNAPSHOT_INTERVAL_MS ?? "33";

await buildRustAuthorityBridge();

const app = await createApp();
await app.listen({ port: 0, host: "127.0.0.1" });
const address = app.server.address();
if (!address || typeof address === "string") throw new Error("server did not expose a TCP address");

const endpointUrl = `http://127.0.0.1:${address.port}`;
const colyseus = new ColyseusClient(endpointUrl);
const clients: BenchClient[] = [];
let packets = 0;
let bytes = 0;
let hellos = 0;
let snapshots = 0;
let receipts = 0;
let acceptedReceipts = 0;
let rejectedReceipts = 0;
let events = 0;
const latencies: number[] = [];
const expectedReceipts = playerCount * commandsPerPlayer;
let peakRssBytes = process.memoryUsage().rss;
const memorySampler = setInterval(sampleMemory, 25);
memorySampler.unref();

try {
  const connectStarted = performance.now();
  for (let offset = 0; offset < playerCount; offset += connectBatch) {
    const batch = [];
    for (let index = offset; index < Math.min(offset + connectBatch, playerCount); index += 1) {
      batch.push(connectClient(index));
    }
    clients.push(...await Promise.all(batch));
  }
  const connectMs = performance.now() - connectStarted;
  if (postConnectSettleMs > 0) await sleep(postConnectSettleMs);

  const routeStarted = performance.now();
  for (let commandIndex = 0; commandIndex < commandsPerPlayer; commandIndex += 1) {
    for (const client of clients) {
      sendCommand(client, commandIndex + 1);
    }
    if (commandIntervalMs > 0 && commandIndex < commandsPerPlayer - 1) {
      await sleep(commandIntervalMs);
    }
  }

  let receiptWaitError: string | null = null;
  try {
    await waitForReceipts();
  } catch (error) {
    receiptWaitError = error instanceof Error ? error.message : String(error);
  }
  const receiptCoveragePassed = receipts >= expectedReceipts;
  const routeMs = performance.now() - routeStarted;
  const statusResponse = await app.inject({ method: "GET", url: "/game/status" });
  const status = JSON.parse(statusResponse.body);
  sampleMemory();
  const memory = process.memoryUsage();
  const receiptLatencyP95 = percentile(latencies, 0.95);
  const receiptLatencyP99 = percentile(latencies, 0.99);
  const receiptLatencyMax = latencies.length > 0 ? Math.max(...latencies) : 0;
  const budgetPassed = receiptCoveragePassed && receiptLatencyP95 <= receiptP95BudgetMs;

  console.log(JSON.stringify({
    schema: "successor.game-websocket-authority-bench.v1",
    status: budgetPassed ? "pass" : "fail",
    error: receiptWaitError,
    config: {
      players: playerCount,
      commandsPerPlayer,
      commandKind,
      connectBatch,
      helloTimeoutMs,
      postConnectSettleMs,
      commandIntervalMs,
      expectedReceipts,
      receiptP95BudgetMs,
      transport: "colyseus-room",
    },
    delivery: {
      hellos,
      snapshots,
      receipts,
      missingReceipts: Math.max(0, expectedReceipts - receipts),
      acceptedReceipts,
      rejectedReceipts,
      events,
      packets,
      bytes,
    },
    timing: {
      connectMs: round(connectMs),
      routeMs: round(routeMs),
      commandsPerSecond: round((expectedReceipts / routeMs) * 1000),
      receiptLatencyMs: {
        p50: round(percentile(latencies, 0.5)),
        p95: round(receiptLatencyP95),
        p99: round(receiptLatencyP99),
        max: round(receiptLatencyMax),
      },
    },
    budget: {
      receiptP95BudgetMs,
      receiptCoveragePasses: receiptCoveragePassed,
      receiptP95Passes: receiptLatencyP95 <= receiptP95BudgetMs,
      passes: budgetPassed,
    },
    server: {
      sessionCount: status.sessionCount,
      actorCount: status.actorCount,
      counters: status.counters,
      limits: status.limits,
    },
    memory: {
      rssMb: round(memory.rss / 1024 / 1024),
      heapUsedMb: round(memory.heapUsed / 1024 / 1024),
      peakRssMb: round(peakRssBytes / 1024 / 1024),
    },
  }, null, 2));
  if (!budgetPassed) process.exitCode = 1;
} finally {
  clearInterval(memorySampler);
  await withTimeout(Promise.allSettled(clients.map((client) => client.room.leave(true))), 5_000).catch(() => undefined);
  await withTimeout(app.close(), 5_000).catch(() => undefined);
}

async function connectClient(index: number): Promise<BenchClient> {
  const areaW = 58;
  const row = Math.floor(index / areaW);
  const column = index % areaW;
  const room = await colyseus.joinOrCreate("game", {
    playerId: `game-ws-${index}`,
    actorId: `game-ws-${index}`,
    displayName: `WS ${index}`,
    zoneId: "open-desert",
    spawnArea: "open-desert-overworld",
    spawnX: String(2 + column),
    spawnY: String(2 + (row % 30)),
    facing: "right",
  });
  const client: BenchClient = {
    index,
    room,
    sentAt: new Map<number, number>(),
  };
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`timed out waiting for game hello: ${index}`)), helloTimeoutMs);
    room.onMessage("game.packet", (packet) => {
      handlePacket(client, packet);
      if (isPacketType(packet, "game.hello")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    room.send("game.ready");
  });
  return client;
}

function sendCommand(client: BenchClient, commandId: number): void {
  client.sentAt.set(commandId, performance.now());
  const direction = (client.index + commandId) % 4;
  const [dx, dy] = direction === 0 ? [1, 0] : direction === 1 ? [-1, 0] : direction === 2 ? [0, 1] : [0, -1];
  client.room.send("game.command", {
    session: 1,
    player: 1,
    command_id: commandId,
    issued_at_tick: 0,
    command: {
      Move: {
        dx,
        dy,
        duration_ticks: 4,
        facing: "Right",
      },
    },
  });
}

function handlePacket(client: BenchClient, packet: unknown): void {
  sampleMemory();
  packets += 1;
  bytes += Buffer.byteLength(JSON.stringify(packet), "utf8");
  if (isPacketType(packet, "game.hello")) {
    hellos += 1;
    return;
  }
  if (isPacketType(packet, "game.acks")) {
    for (const [commandId, accepted] of packet.acks ?? []) {
      receipts += 1;
      if (accepted === 1) acceptedReceipts += 1;
      else rejectedReceipts += 1;
      const started = client.sentAt.get(commandId);
      if (started !== undefined) {
        latencies.push(performance.now() - started);
        client.sentAt.delete(commandId);
      }
    }
    return;
  }
  if (!isPacketType(packet, "game.snapshot") && !isPacketType(packet, "game.delta")) return;
  snapshots += 1;
  for (const receipt of packet.receipts ?? []) {
    receipts += 1;
    if (receipt.accepted) acceptedReceipts += 1;
    else rejectedReceipts += 1;
    const started = client.sentAt.get(receipt.commandId);
    if (started !== undefined) {
      latencies.push(performance.now() - started);
      client.sentAt.delete(receipt.commandId);
    }
  }
  events += (packet.events?.length ?? 0) + (packet.compactEvents?.length ?? 0);
}

function isPacketType<T extends string>(value: unknown, type: T): value is { type: T; [key: string]: any } {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === type;
}

function waitForReceipts(): Promise<void> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (receipts >= expectedReceipts) {
        resolve();
        return;
      }
      if (performance.now() - started > timeoutMs) {
        reject(new Error(`timed out waiting for game receipts: ${receipts}/${expectedReceipts}`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function buildRustAuthorityBridge(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("cargo", ["build", "-p", "successor-sim", "--example", "authority_bridge_server"], {
      cwd: new URL("../..", import.meta.url),
      env: {
        ...process.env,
        CARGO_PROFILE_DEV_OPT_LEVEL: process.env.CARGO_PROFILE_DEV_OPT_LEVEL ?? "2",
      },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`cargo build -p successor-sim --example authority_bridge_server failed${signal ? ` with signal ${signal}` : ` with code ${code}`}`));
    });
  });
}

function sampleMemory(): void {
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(values: number[], point: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * point));
  return sorted[index] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
