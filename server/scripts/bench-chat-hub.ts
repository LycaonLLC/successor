import { performance } from "node:perf_hooks";

import { ChatHub, type ChatSocket } from "../src/chat/hub.js";

class BenchSocket implements ChatSocket {
  readyState = 1;
  packets = 0;
  bytes = 0;
  private readonly handlers = {
    message: [] as Array<(data: unknown) => void>,
    close: [] as Array<() => void>,
    error: [] as Array<(error: Error) => void>,
  };

  send(data: string): void {
    this.packets += 1;
    this.bytes += Buffer.byteLength(data, "utf8");
  }

  close(): void {
    this.readyState = 3;
    for (const handler of this.handlers.close) handler();
  }

  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(
    event: "message" | "close" | "error",
    listener: ((data: unknown) => void) | (() => void) | ((error: Error) => void),
  ): void {
    if (event === "message") this.handlers.message.push(listener as (data: unknown) => void);
    if (event === "close") this.handlers.close.push(listener as () => void);
    if (event === "error") this.handlers.error.push(listener as (error: Error) => void);
  }
}

const zonePlayers = envInt("CHAT_BENCH_ZONE_PLAYERS", 500);
const otherPlayers = envNonNegativeInt("CHAT_BENCH_OTHER_PLAYERS", 500);
const messages = envInt("CHAT_BENCH_MESSAGES", 200);
const senders = Math.min(zonePlayers, Math.max(1, envInt("CHAT_BENCH_SENDERS", 100)));

const hub = new ChatHub({
  maxSessions: zonePlayers + otherPlayers + 16,
  maxSessionsPerUser: 1,
  sendHelloOnConnect: false,
});

const zoneSessionIds: string[] = [];
const zoneSockets: BenchSocket[] = [];
const otherSockets: BenchSocket[] = [];

for (let index = 0; index < zonePlayers; index += 1) {
  const socket = new BenchSocket();
  const session = hub.connect(socket, {
    userId: `bench-desert-${index}`,
    displayName: `Bench Desert ${index}`,
    zoneId: "open-desert",
  });
  zoneSessionIds.push(session.id);
  zoneSockets.push(socket);
}

for (let index = 0; index < otherPlayers; index += 1) {
  const socket = new BenchSocket();
  hub.connect(socket, {
    userId: `bench-drain-${index}`,
    displayName: `Bench Drain ${index}`,
    zoneId: "storm-drain",
  });
  otherSockets.push(socket);
}

const latencies: number[] = [];
const startedAt = performance.now();
for (let index = 0; index < messages; index += 1) {
  const senderId = zoneSessionIds[index % senders];
  if (!senderId) throw new Error("missing sender session");
  const messageStartedAt = performance.now();
  hub.handlePacketForTest(senderId, {
    type: "chat.send",
    channel: "local",
    body: `bench message ${index}`,
  });
  latencies.push(performance.now() - messageStartedAt);
}
const elapsedMs = performance.now() - startedAt;

const sortedLatencies = [...latencies].sort((left, right) => left - right);
const zonePackets = zoneSockets.reduce((sum, socket) => sum + socket.packets, 0);
const otherPackets = otherSockets.reduce((sum, socket) => sum + socket.packets, 0);
const snapshot = hub.snapshot();

console.log(
  JSON.stringify(
    {
      config: {
        zonePlayers,
        otherPlayers,
        messages,
        senders,
      },
      delivery: {
        expectedZonePackets: zonePlayers * messages,
        zonePackets,
        otherPackets,
      },
      routeMs: {
        p50: round(percentile(sortedLatencies, 0.5)),
        p95: round(percentile(sortedLatencies, 0.95)),
        max: round(sortedLatencies.at(-1) ?? 0),
        averageFromHub: snapshot.routing.averageRouteMs,
        maxFromHub: snapshot.routing.maxRouteMs,
      },
      throughput: {
        elapsedMs: round(elapsedMs),
        messagesPerSecond: round((messages / elapsedMs) * 1000),
        packetDeliveriesPerSecond: round((zonePackets / elapsedMs) * 1000),
      },
      snapshot: {
        sessionCount: snapshot.sessionCount,
        messagesRouted: snapshot.counters.messagesRouted,
        packetsOut: snapshot.counters.packetsOut,
        sendsDropped: snapshot.counters.sendsDropped,
        sendErrors: snapshot.counters.sendErrors,
        zones: snapshot.groups.zones,
      },
    },
    null,
    2,
  ),
);

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function envNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function percentile(values: number[], point: number): number {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.floor(values.length * point));
  return values[index] ?? 0;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
