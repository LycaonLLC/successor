import { performance } from "node:perf_hooks";

import { createApp } from "../src/index.js";

interface BenchWebSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(event: "open", listener: () => void): void;
  addEventListener(event: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(event: "error", listener: (event: unknown) => void): void;
}

const playerCount = envInt("CHAT_WS_BENCH_PLAYERS", 1_000);
const messages = envInt("CHAT_WS_BENCH_MESSAGES", 25);
const senders = Math.min(playerCount, Math.max(1, envInt("CHAT_WS_BENCH_SENDERS", 25)));
const connectBatch = envInt("CHAT_WS_BENCH_CONNECT_BATCH", 100);
const timeoutMs = envInt("CHAT_WS_BENCH_TIMEOUT_MS", 15_000);

process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "silent";
process.env.GAME_SHARD_PERSISTENCE = process.env.GAME_SHARD_PERSISTENCE ?? "0";
process.env.CHAT_MAX_SESSIONS = String(Math.max(playerCount + 16, envInt("CHAT_MAX_SESSIONS", 0)));
process.env.CHAT_MAX_SESSIONS_PER_USER = process.env.CHAT_MAX_SESSIONS_PER_USER ?? "1";

const WebSocketCtor = (globalThis as typeof globalThis & { WebSocket: new (url: string) => BenchWebSocket }).WebSocket;
if (!WebSocketCtor) throw new Error("global WebSocket is not available in this Node runtime");

const app = await createApp();
await app.listen({ port: 0, host: "127.0.0.1" });
const address = app.server.address();
if (!address || typeof address === "string") throw new Error("server did not expose a TCP address");

const runtimeUrl = `ws://127.0.0.1:${address.port}/chat/ws`;
const sockets: BenchWebSocket[] = [];
let chatMessages = 0;
let packets = 0;
let bytes = 0;
const expectedChatMessages = playerCount * messages;

try {
  const connectStarted = performance.now();
  for (let offset = 0; offset < playerCount; offset += connectBatch) {
    const batch = [];
    for (let index = offset; index < Math.min(offset + connectBatch, playerCount); index += 1) {
      batch.push(connectClient(index));
    }
    sockets.push(...await Promise.all(batch));
  }
  const connectMs = performance.now() - connectStarted;

  const routeStarted = performance.now();
  for (let index = 0; index < messages; index += 1) {
    const socket = sockets[index % senders];
    if (!socket) throw new Error("missing sender socket");
    socket.send(JSON.stringify({
      type: "chat.send",
      requestId: `ws-bench-${index}`,
      channel: "local",
      body: `socket bench ${index}`,
    }));
  }

  await waitForDelivery();
  const routeMs = performance.now() - routeStarted;
  const statusResponse = await app.inject({ method: "GET", url: "/chat/status" });
  const status = JSON.parse(statusResponse.body);

  console.log(JSON.stringify({
    schema: "successor.chat-websocket-bench.v1",
    config: {
      players: playerCount,
      messages,
      senders,
      connectBatch,
    },
    delivery: {
      expectedChatMessages,
      chatMessages,
      packets,
      bytes,
    },
    timing: {
      connectMs: round(connectMs),
      routeMs: round(routeMs),
      messagesPerSecond: round((messages / routeMs) * 1000),
      chatPacketsPerSecond: round((chatMessages / routeMs) * 1000),
    },
    status: {
      sessionCount: status.sessionCount,
      counters: status.counters,
      routing: status.routing,
      zones: status.groups?.zones ?? {},
    },
  }, null, 2));
} finally {
  for (const socket of sockets) socket.close();
  await app.close();
}

function connectClient(index: number): Promise<BenchWebSocket> {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      playerId: `ws-bench-${index}`,
      displayName: `WS Bench ${index}`,
      zoneId: "open-desert",
    });
    const socket = new WebSocketCtor(`${runtimeUrl}?${params.toString()}`);
    socket.addEventListener("open", () => resolve(socket));
    socket.addEventListener("message", (event) => {
      const text = typeof event.data === "string" ? event.data : String(event.data);
      packets += 1;
      bytes += Buffer.byteLength(text, "utf8");
      try {
        const packet = JSON.parse(text);
        if (packet?.type === "chat.message" && packet.message?.body?.startsWith("socket bench ")) {
          chatMessages += 1;
        }
      } catch {
        // Bench noise should not hide delivery numbers.
      }
    });
    socket.addEventListener("error", reject);
  });
}

function waitForDelivery(): Promise<void> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (chatMessages >= expectedChatMessages) {
        resolve();
        return;
      }
      if (performance.now() - started > timeoutMs) {
        reject(new Error(`timed out waiting for chat delivery: ${chatMessages}/${expectedChatMessages}`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
