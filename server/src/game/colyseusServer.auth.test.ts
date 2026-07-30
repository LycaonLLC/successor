import { describe, expect, it, vi } from "vitest";

import { createStandaloneAuthenticatedRoomClass } from "./colyseusServer.js";
import { SuccessorGameRoom } from "./colyseusRoom.js";
import type { RuntimeAuthConfig } from "../auth/runtime.js";

const runtimeAuth: RuntimeAuthConfig = {
  mode: "standalone",
  origin: "https://www.successorgame.com",
  shardId: "open-desert",
  clientReleaseId: "release-a",
  serverReleaseId: "server-a",
  issuer: "successor-server",
};

const character = {
  id: "char-atlas",
  ownerRef: "owner-atlas",
  name: "Atlas",
  worldEntryClaimed: true,
  appearance: { skinTone: "#c78f62", hair: "hair_mop", hairMat: "hair_raven", face: null },
  worn: [],
  wornColors: {},
};

function roomHarness(roomClass: typeof SuccessorGameRoom, characterStore: { get: () => typeof character }, runtime: RuntimeAuthConfig, reserved = false) {
  const room = Object.create(roomClass.prototype) as {
    characterStore: typeof characterStore;
    runtimeAuth: RuntimeAuthConfig;
    identities: Map<string, unknown>;
    sockets: Map<string, unknown>;
    pendingReadyViews: Map<string, unknown>;
    pendingReadySessions: Set<string>;
    pendingViews: Map<string, unknown>;
    connectedSessions: Set<string>;
    shard: { isReservedCharacterId: (id: string) => boolean };
    onJoin: (client: unknown, options: unknown, auth: unknown) => Promise<void>;
  };
  room.characterStore = characterStore;
  room.runtimeAuth = runtime;
  room.identities = new Map();
  room.sockets = new Map();
  room.pendingReadyViews = new Map();
  room.pendingReadySessions = new Set();
  room.pendingViews = new Map();
  room.connectedSessions = new Set();
  room.shard = { isReservedCharacterId: () => reserved };
  return room;
}

describe("standalone Colyseus pre-admission auth", () => {
  it("passes the one redeemed identity through onJoin without redeeming twice", async () => {
    const used = new Set<string>();
    const redeem = vi.fn(async ({ token }: { token: string }) => {
      if (used.has(token)) throw new Error("replay");
      used.add(token);
      return {
        launchId: "launch-atlas", accountId: "account-atlas", ownerRef: character.ownerRef, characterId: character.id,
        shardId: runtimeAuth.shardId, clientReleaseId: runtimeAuth.clientReleaseId, serverReleaseId: runtimeAuth.serverReleaseId,
        issuer: runtimeAuth.issuer, purpose: "game" as const,
      };
    });
    const characterStore = { get: vi.fn(() => character) };
    const RoomClass = createStandaloneAuthenticatedRoomClass({
      shard: { isReservedCharacterId: () => false } as never,
      characterStore: characterStore as never,
      runtimeAuth,
      controlStore: { redeemCapability: redeem } as never,
    });
    const auth = await RoomClass.onAuth("", { gameTicket: "g".repeat(32) }, {} as never);
    expect(auth).toMatchObject({ characterId: character.id, ownerRef: character.ownerRef });
    const room = roomHarness(RoomClass, characterStore, runtimeAuth);
    const client = { sessionId: "session-atlas", ref: {}, send: () => undefined, leave: () => undefined };
    await room.onJoin(client, { gameTicket: "g".repeat(32) }, auth);
    expect(redeem).toHaveBeenCalledTimes(1);
    expect(room.identities.get("session-atlas")).toMatchObject({ characterId: character.id, ownerRef: character.ownerRef });
    await expect(RoomClass.onAuth("", { gameTicket: "g".repeat(32) }, {} as never)).resolves.toBe(false);
    expect(redeem).toHaveBeenCalledTimes(2);
  });

  it("rejects an authored actor before room admission and again at onJoin", async () => {
    const redeem = vi.fn(async () => ({
      launchId: "launch-player", accountId: "account-player", ownerRef: character.ownerRef, characterId: character.id,
      shardId: runtimeAuth.shardId, clientReleaseId: runtimeAuth.clientReleaseId, serverReleaseId: runtimeAuth.serverReleaseId,
      issuer: runtimeAuth.issuer, purpose: "game" as const,
    }));
    const characterStore = { get: vi.fn(() => character) };
    const RoomClass = createStandaloneAuthenticatedRoomClass({
      shard: { isReservedCharacterId: () => true } as never,
      characterStore: characterStore as never,
      runtimeAuth,
      controlStore: { redeemCapability: redeem, revokeLaunch: vi.fn() } as never,
    });
    await expect(RoomClass.onAuth("", { gameTicket: "r".repeat(32) }, {} as never)).resolves.toBe(false);
    const auth = { actorId: character.id, playerId: character.id, displayName: character.name, zoneId: runtimeAuth.shardId, characterId: character.id, ownerRef: character.ownerRef };
    const room = roomHarness(RoomClass, characterStore, runtimeAuth, true);
    const client = { sessionId: "session-player", ref: {}, send: () => undefined, leave: () => undefined };
    await expect(room.onJoin(client, { gameTicket: "r".repeat(32) }, auth)).rejects.toMatchObject({ message: "character id collides with authored actor" });
  });

  it("binds the shard receiver when reserved admission reads authoredActorIds", async () => {
    const redeem = vi.fn(async () => ({
      launchId: "launch-authored", accountId: "account-authored", ownerRef: character.ownerRef, characterId: character.id,
      shardId: runtimeAuth.shardId, clientReleaseId: runtimeAuth.clientReleaseId, serverReleaseId: runtimeAuth.serverReleaseId,
      issuer: runtimeAuth.issuer, purpose: "game" as const,
    }));
    const shard = {
      authoredActorIds: new Set([character.id]),
      isReservedCharacterId(this: { authoredActorIds: Set<string> }, id: string): boolean {
        return this.authoredActorIds.has(id);
      },
    };
    const characterStore = { get: vi.fn(() => character) };
    const RoomClass = createStandaloneAuthenticatedRoomClass({
      shard: shard as never,
      characterStore: characterStore as never,
      runtimeAuth,
      controlStore: { redeemCapability: redeem, revokeLaunch: vi.fn() } as never,
    });

    await expect(RoomClass.onAuth("", { gameTicket: "a".repeat(32) }, {} as never)).resolves.toBe(false);
    expect(redeem).toHaveBeenCalledTimes(1);
  });

  it("replays an early ready view once async identity admission completes", () => {
    const connect = vi.fn();
    const view = { areaId: "open-desert", x: 0, y: 0, radiusCells: 192 };
    const room = Object.create(SuccessorGameRoom.prototype) as unknown as {
      shard: { connect: typeof connect };
      identities: Map<string, { actorId: string; playerId: string; characterId: string }>;
      sockets: Map<string, unknown>;
      connectedSessions: Set<string>;
      pendingViews: Map<string, typeof view>;
      pendingReadyViews: Map<string, typeof view>;
      pendingReadySessions: Set<string>;
      connectClient(client: { sessionId: string }, readyView: typeof view | undefined): void;
    };
    room.shard = { connect };
    room.identities = new Map();
    room.sockets = new Map();
    room.connectedSessions = new Set();
    room.pendingViews = new Map();
    room.pendingReadyViews = new Map();
    room.pendingReadySessions = new Set();
    const client = { sessionId: "deferred-session" };

    room.connectClient(client, view);
    expect(room.pendingReadyViews.get(client.sessionId)).toEqual(view);

    const identity = { actorId: "char-deferred", playerId: "char-deferred", characterId: "char-deferred" };
    room.identities.set(client.sessionId, identity);
    room.sockets.set(client.sessionId, {});
    room.connectClient(client, room.pendingReadyViews.get(client.sessionId));
    room.connectClient(client, view);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(room.connectedSessions.has(client.sessionId)).toBe(true);
    expect(room.pendingReadyViews.has(client.sessionId)).toBe(false);
  });
});
