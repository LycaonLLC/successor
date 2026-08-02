import type { Server as HttpServer, IncomingMessage } from "node:http";
import { Server, matchMaker, type AuthContext } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { SuccessorGameRoom } from "./colyseusRoom.js";
import type { CharacterStore } from "./characterStore.js";
import type { GameShard } from "./shard.js";
import type { RuntimeAuthConfig, LaunchSessionRevocationSink } from "../auth/runtime.js";
import { originMatches, trustedNativeOrigin } from "../auth/runtime.js";
import { redeemStandaloneLaunch, type StandaloneLaunchStore } from "../auth/standalone.js";
import type { BugReportWriter } from "../support/bugReports.js";

const standaloneMatchmakeSchema = z.object({
  gameTicket: z.string().trim().min(32).max(256),
  release: z.string().trim().min(1).max(128),
}).strict();
const MATCHMAKE_RATE_WINDOW_MS = 1_000;
const MATCHMAKE_RATE_LIMIT = 32;
const MATCHMAKE_BODY_LIMIT_BYTES = 1_024;

export interface ColyseusGameServerOptions {
  shard: GameShard;
  characterStore: CharacterStore;
  maxClients?: number;
  maxPayloadBytes?: number;
  runtimeAuth?: RuntimeAuthConfig;
  controlStore?: StandaloneLaunchStore & Partial<BugReportWriter>;
  sessionRevocations?: LaunchSessionRevocationSink;
}

export async function registerColyseusGameServer(
  app: FastifyInstance,
  options: ColyseusGameServerOptions,
): Promise<Server> {
  const requiredOrigin = options.runtimeAuth?.mode === "standalone" ? options.runtimeAuth.origin : undefined;
  const clientOrigin = options.runtimeAuth?.mode === "standalone" ? options.runtimeAuth.clientOrigin : undefined;
  if (options.runtimeAuth?.mode === "standalone" && (!requiredOrigin || !clientOrigin)) throw new Error("standalone origins are unavailable");
  const originAllowed = (requestOrigin: string | string[] | undefined): boolean => isAllowedColyseusOrigin(requestOrigin, requiredOrigin, clientOrigin);
  const transport = new WebSocketTransport({
    noServer: true,
    maxPayload: options.maxPayloadBytes ?? 16_384,
    perMessageDeflate: false,
  });
  const upgradeListenersBeforeAttach = app.server.listeners("upgrade") as UpgradeListener[];
  transport.attachToServer(app.server, {
    filter: (request) => isColyseusRoomUpgrade(request.url ?? "") && originAllowed(request.headers.origin),
  });
  installUpgradeDispatcher(app.server, upgradeListenersBeforeAttach, (request) => isColyseusRoomUpgrade(request.url ?? ""), originAllowed);

  const server = new Server({
    transport,
    greet: false,
    gracefullyShutdown: false,
  });
  const roomClass = options.runtimeAuth?.mode === "standalone"
    ? createStandaloneAuthenticatedRoomClass(options)
    : SuccessorGameRoom;
  server.define("game", roomClass, {
    shard: options.shard,
    characterStore: options.characterStore,
    maxClients: options.maxClients,
    runtimeAuth: options.runtimeAuth,
    controlStore: options.controlStore,
    sessionRevocations: options.sessionRevocations,
  });

  const limiter = new MatchmakeRateLimiter();
  app.options("/matchmake/:method/:roomName", async (request, reply) => {
    addColyseusCorsHeaders(request, reply, requiredOrigin, clientOrigin);
    if (!originAllowed(request.headers.origin)) return reply.status(403).send({ error: "origin not allowed" });
    return reply.status(204).send();
  });

  app.post("/matchmake/:method/:roomName", { bodyLimit: MATCHMAKE_BODY_LIMIT_BYTES }, async (request, reply) => {
    addColyseusCorsHeaders(request, reply, requiredOrigin, clientOrigin);
    if (!originAllowed(request.headers.origin)) return reply.status(403).send({ error: "origin not allowed" });
    if (!limiter.allow(clientAddress(request))) return reply.status(429).send({ error: "matchmake rate limit exceeded" });
    const { method, roomName } = request.params as { method: string; roomName: string };
    if (requiredOrigin && (roomName !== "game" || (method !== "joinOrCreate" && method !== "join"))) {
      return reply.status(404).send({ error: "matchmake method unavailable" });
    }
    const body = requiredOrigin ? standaloneMatchmakeSchema.safeParse(request.body ?? {}) : { success: true as const, data: request.body ?? {} };
    if (!body.success) return reply.status(400).send({ error: "invalid matchmake body" });
    try {
      const response = await matchMaker.controller.invokeMethod(
        method,
        roomName,
        body.data,
        authContextFromRequest(request),
      );
      return reply.header("content-type", "application/json").send(response);
    } catch (error) {
      const code = errorCode(error);
      return reply.status(code).send({
        code,
        error: error instanceof Error ? error.message : "matchmake error",
      });
    }
  });

  await matchMaker.accept(false);
  return server;
}

export function isAllowedColyseusOrigin(
  requestOrigin: string | string[] | undefined,
  requiredOrigin?: string,
  clientOrigin?: string,
): boolean {
  if (originMatches(requestOrigin, [requiredOrigin, clientOrigin].filter((origin): origin is string => origin !== undefined))) return true;
  return trustedNativeOrigin(requestOrigin);
}

type UpgradeListener = (...args: unknown[]) => void;

type UpgradeSocket = {
  write(data: string): void;
  destroy(): void;
};

function installUpgradeDispatcher(
  server: HttpServer,
  hostListeners: UpgradeListener[],
  handlesUrl: (request: IncomingMessage) => boolean,
  originAllowed: (requestOrigin: string | string[] | undefined) => boolean,
): void {
  const currentListeners = server.listeners("upgrade") as UpgradeListener[];
  const colyseusListeners = currentListeners.filter((listener) => !hostListeners.includes(listener));
  for (const listener of currentListeners) server.removeListener("upgrade", listener);
  server.on("upgrade", (request, socket, head) => {
    if (handlesUrl(request) && !originAllowed(request.headers.origin)) {
      const rejected = socket as unknown as UpgradeSocket;
      rejected.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      rejected.destroy();
      return;
    }
    const listeners = handlesUrl(request) ? colyseusListeners : hostListeners;
    for (const listener of listeners) listener.call(server, request, socket, head);
  });
}

function isColyseusRoomUpgrade(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? "";
  if (pathname === "/chat/ws") return false;
  return /^\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(pathname);
}

function authContextFromRequest(request: FastifyRequest): AuthContext {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  return {
    token: bearerToken(request.headers.authorization),
    headers,
    ip: request.headers["x-forwarded-for"] ?? request.headers["x-real-ip"] ?? request.ip,
    req: request.raw,
  };
}

function addColyseusCorsHeaders(
  request: FastifyRequest,
  reply: FastifyReply,
  requiredOrigin?: string,
  clientOrigin?: string,
): void {
  const requestOrigin = request.headers.origin;
  if (isAllowedColyseusOrigin(requestOrigin, requiredOrigin, clientOrigin) && typeof requestOrigin === "string") {
    reply.header("access-control-allow-origin", requestOrigin);
    reply.header("access-control-allow-credentials", "true");
  }
  reply.header("vary", "Origin");
  reply.header("access-control-allow-methods", "POST,OPTIONS");
  reply.header("access-control-allow-headers", "Content-Type");
}

function bearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value?.startsWith("Bearer ")) return undefined;
  return value.slice("Bearer ".length);
}

function errorCode(error: unknown): number {
  const code = typeof error === "object" && error !== null && "code" in error
    ? Number((error as { code?: unknown }).code)
    : 500;
  return Number.isInteger(code) && code >= 400 && code <= 599 ? code : 500;
}

function clientAddress(request: FastifyRequest): string {
  return request.ip || "unknown";
}

class MatchmakeRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  allow(address: string): boolean {
    const now = Date.now();
    const current = this.windows.get(address);
    if (!current || now - current.startedAt >= MATCHMAKE_RATE_WINDOW_MS) {
      if (this.windows.size >= 4_096) this.windows.delete(this.windows.keys().next().value as string);
      this.windows.set(address, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= MATCHMAKE_RATE_LIMIT;
  }
}

export function createStandaloneAuthenticatedRoomClass(options: ColyseusGameServerOptions): typeof SuccessorGameRoom {
  const controlStore = options.controlStore;
  const runtimeAuth = options.runtimeAuth;
  if (!controlStore || !runtimeAuth || runtimeAuth.mode !== "standalone") throw new Error("standalone game auth is unavailable");
  return class StandaloneAuthenticatedSuccessorGameRoom extends SuccessorGameRoom {
    static async onAuth(_token: string | undefined, clientOptions: unknown): Promise<unknown> {
      const parsed = standaloneMatchmakeSchema.safeParse(clientOptions);
      if (!parsed.success) return false;
      try {
        return await redeemStandaloneLaunch(parsed.data.gameTicket, "game", controlStore, options.characterStore, runtimeAuth, options.shard.isReservedCharacterId.bind(options.shard), parsed.data.release);
      } catch {
        return false;
      }
    }
  };
}
