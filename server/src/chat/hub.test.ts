import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

import { CharacterStore } from "../game/characterStore.js";

import { ChatHub, type ChatSocket } from "./hub.js";
import { registerChatRoutes } from "./routes.js";
import type { ServerPacket } from "./protocol.js";

type TestSocket = Awaited<ReturnType<typeof appInstance.injectWS>>;

let appInstance: ReturnType<typeof Fastify>;

function record(socket: TestSocket) {
  const messages: ServerPacket[] = [];
  socket.on("message", (data: Buffer) => {
    messages.push(JSON.parse(data.toString()) as ServerPacket);
  });
  return {
    messages,
    waitFor: async (predicate: (packet: ServerPacket) => boolean, label: string) => {
      const started = Date.now();
      while (Date.now() - started < 1200) {
        const hit = messages.find(predicate);
        if (hit) return hit;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`timed out waiting for ${label}; saw ${messages.map((message) => message.type).join(", ")}`);
    },
  };
}

async function connect(path: string) {
  const socket = await appInstance.injectWS(path);
  const recorder = record(socket);
  await recorder.waitFor((packet) => packet.type === "chat.hello", "hello");
  return { socket, recorder };
}

class FakeChatSocket implements ChatSocket {
  readyState = 1;
  readonly messages: ServerPacket[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  private readonly handlers = {
    message: [] as Array<(data: unknown) => void>,
    close: [] as Array<() => void>,
    error: [] as Array<(error: Error) => void>,
  };

  send(data: string): void {
    this.messages.push(JSON.parse(data) as ServerPacket);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closes.push({ code, reason });
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

describe("ChatHub websocket routes", () => {
  beforeEach(async () => {
    appInstance = Fastify({ logger: false });
    await appInstance.register(websocket);
    await registerChatRoutes(appInstance, { hub: new ChatHub() });
    await appInstance.ready();
  });

  afterEach(async () => {
    await appInstance.close();
  });

  it("rejects raw chat identity when hosted ticket mode is required", async () => {
    const previous = process.env.GAME_ALLOW_DEV_IDENTITY;
    process.env.GAME_ALLOW_DEV_IDENTITY = "0";
    const socket = await appInstance.injectWS("/chat/ws?playerId=spoofed&displayName=Spoofed&zone=open-desert");
    try {
      const close = await new Promise<{ code: number; reason: string }>((resolve) => {
        socket.on("close", (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() }));
      });
      expect(close).toEqual({ code: 1008, reason: "session ticket required" });
    } finally {
      if (previous === undefined) delete process.env.GAME_ALLOW_DEV_IDENTITY;
      else process.env.GAME_ALLOW_DEV_IDENTITY = previous;
    }
  });
  it("does not use a forged guildId query when authority lookup is configured", async () => {
    await appInstance.close();
    appInstance = Fastify({ logger: false });
    await appInstance.register(websocket);
    const memberships = new Map<string, string>();
    await registerChatRoutes(appInstance, {
      hub: new ChatHub({
        guildAuthority: { guildIdForActor: (actorId) => memberships.get(actorId) ?? null },
      }),
    });
    await appInstance.ready();

    const forged = await connect("/chat/ws?playerId=forged&displayName=Forged&zone=open-desert&guildId=guild-a");
    forged.socket.send(JSON.stringify({ type: "chat.send", channel: "guild", body: "forged query" }));

    await forged.recorder.waitFor((packet) => packet.type === "chat.error" && packet.code === "no_guild", "forged guild rejection");
    expect(forged.recorder.messages.some((packet) => packet.type === "chat.message" && packet.message.body === "forged query")).toBe(false);
  });
  it("keeps unauthenticated chat status aggregate-only", async () => {
    const observer = await connect("/chat/ws?playerId=observer&displayName=Observer&zone=open-desert");
    observer.socket.send(JSON.stringify({ type: "friend.add", friendId: "warden" }));
    await observer.recorder.waitFor((packet) => packet.type === "friend.event" && packet.action === "added", "friend add");
    const response = await appInstance.inject({ method: "GET", url: "/chat/status" });
    const body = response.json() as { groups: { friendWatchers: number } };
    expect(body.groups.friendWatchers).toBe(1);
    expect(JSON.stringify(body)).not.toContain("observer");
    expect(JSON.stringify(body)).not.toContain("warden");
  });


  it("routes zone messages to connected clients in the same zone", async () => {
    const observer = await connect("/chat/ws?playerId=observer&displayName=Field%20Observer&zone=open-desert");
    const moss = await connect("/chat/ws?playerId=warden&displayName=Warden&zone=open-desert");

    observer.socket.send(JSON.stringify({ type: "chat.send", channel: "zone", body: "anyone buying desert fiber?" }));

    const delivered = await moss.recorder.waitFor(
      (packet) =>
        packet.type === "chat.message" &&
        packet.message.channel === "zone" &&
        packet.message.body === "anyone buying desert fiber?",
      "zone message",
    );
    expect(delivered.type).toBe("chat.message");
  });

  it("emits friend online and offline status as system chat", async () => {
    const observer = await connect("/chat/ws?playerId=observer&displayName=Field%20Observer&zone=open-desert");
    observer.socket.send(JSON.stringify({ type: "friend.add", friendId: "warden" }));
    await observer.recorder.waitFor((packet) => packet.type === "friend.event" && packet.action === "added", "friend add");

    const moss = await connect("/chat/ws?playerId=warden&displayName=Warden&zone=open-desert");
    await observer.recorder.waitFor(
      (packet) => packet.type === "chat.message" && packet.message.channel === "system" && packet.message.body.includes("Warden is online"),
      "friend online system message",
    );

    moss.socket.terminate();
    await observer.recorder.waitFor(
      (packet) => packet.type === "chat.message" && packet.message.channel === "system" && packet.message.body.includes("Warden went offline"),
      "friend offline system message",
    );
  });

  it("enforces local moderation and rate limits", async () => {
    const observer = await connect("/chat/ws?playerId=observer&displayName=Field%20Observer&zone=open-desert");
    observer.socket.send(JSON.stringify({ type: "chat.send", channel: "zone", body: "https://example.test" }));
    await observer.recorder.waitFor((packet) => packet.type === "chat.error" && packet.code === "url_blocked", "url block");

    for (let i = 0; i < 10; i += 1) {
      observer.socket.send(JSON.stringify({ type: "chat.send", channel: "local", body: `line ${i}` }));
    }
    await observer.recorder.waitFor((packet) => packet.type === "chat.error" && packet.code === "rate_limited", "rate limit");
  });

  it("routes whispers only to sender and target", async () => {
    const observer = await connect("/chat/ws?playerId=observer&displayName=Field%20Observer&zone=open-desert");
    const moss = await connect("/chat/ws?playerId=warden&displayName=Warden&zone=open-desert");
    const third = await connect("/chat/ws?playerId=cobb&displayName=Cobb&zone=open-desert");

    observer.socket.send(JSON.stringify({ type: "chat.send", channel: "whisper", targetId: "warden", body: "quiet deal?" }));

    await moss.recorder.waitFor(
      (packet) => packet.type === "chat.message" && packet.message.channel === "whisper" && packet.message.body === "quiet deal?",
      "target whisper",
    );
    await observer.recorder.waitFor(
      (packet) => packet.type === "chat.message" && packet.message.channel === "whisper" && packet.message.body === "quiet deal?",
      "sender whisper echo",
    );
    expect(
      third.recorder.messages.some(
        (packet) => packet.type === "chat.message" && packet.message.channel === "whisper" && packet.message.body === "quiet deal?",
      ),
    ).toBe(false);
  });

  it("names a sender from the live shard when the client sends no display name", () => {
    const hub = new ChatHub({
      sendHelloOnConnect: false,
      nameAuthority: { displayNameForActor: (id) => (id === "char_grug" ? "Grugtest" : null) },
    });
    const socket = new FakeChatSocket();
    const session = hub.connect(socket, { userId: "char_grug", displayName: "", zoneId: "open-desert" });

    hub.handlePacketForTest(session.id, { type: "chat.send", channel: "local", body: "hello" });

    const line = socket.messages.find(
      (packet) => packet.type === "chat.message" && packet.message.body === "hello",
    );
    expect(line?.type).toBe("chat.message");
    if (line?.type === "chat.message") {
      expect(line.message.sender.displayName).toBe("Grugtest");
      expect(line.message.sender.id).toBe("char_grug");
    }
  });

  it("upgrades a session named after its raw id once the actor reaches the shard", () => {
    let resident = false;
    const hub = new ChatHub({
      sendHelloOnConnect: false,
      nameAuthority: { displayNameForActor: () => (resident ? "Grugtest" : null) },
    });
    const socket = new FakeChatSocket();
    // Chat can open before the actor exists, which is when the raw id leaks.
    const session = hub.connect(socket, { userId: "char_grug", displayName: "", zoneId: "open-desert" });

    hub.handlePacketForTest(session.id, { type: "chat.send", channel: "local", body: "early" });
    resident = true;
    hub.handlePacketForTest(session.id, { type: "chat.send", channel: "local", body: "later" });

    const named = (body: string) => {
      const packet = socket.messages.find(
        (entry) => entry.type === "chat.message" && entry.message.body === body,
      );
      return packet?.type === "chat.message" ? packet.message.sender.displayName : "";
    };
    expect(named("early")).toBe("char_grug");
    expect(named("later")).toBe("Grugtest");
  });

  it("keeps directed presence character-scoped and masks ignored viewers without stale state", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "successor-chat-social-"));
    try {
      const store = new CharacterStore(path.join(dir, "characters.json"));
      const atlas = store.create({ id: "char_atlas", ownerRef: "owner-a", name: "Atlas", appearance: {
        skinTone: "#aabbcc", hair: "hair_mop", hairMat: "hair_raven", face: null,
      }, bypassSlotCap: true });
      const beryl = store.create({ id: "char_beryl", ownerRef: "owner-b", name: "Beryl", appearance: {
        skinTone: "#aabbcc", hair: "hair_mop", hairMat: "hair_raven", face: null,
      }, bypassSlotCap: true });
      if (!atlas.ok || !beryl.ok) throw new Error("expected social fixture characters");
      const hub = new ChatHub({ social: store, sendHelloOnConnect: false });
      const atlasSocket = new FakeChatSocket();
      const berylSocket = new FakeChatSocket();
      const atlasSession = hub.connect(atlasSocket, { userId: atlas.record.id, displayName: atlas.record.name, zoneId: "open-desert" });
      const berylSession = hub.connect(berylSocket, { userId: beryl.record.id, displayName: beryl.record.name, zoneId: "open-desert" });
      const atlasAltSocket = new FakeChatSocket();
      const atlasAltSession = hub.connect(atlasAltSocket, { userId: atlas.record.id, displayName: atlas.record.name, zoneId: "open-desert" });
      hub.handlePacketForTest(atlasSession.id, { type: "friend.add", friendId: "Beryl", requestId: "add" });
      expect(atlasAltSocket.messages.some((packet) => packet.type === "friends.snapshot" && packet.friends.some((friend) => friend.id === beryl.record.id))).toBe(true);
      expect(atlasSocket.messages.some((packet) => packet.type === "friend.event" && packet.friend.id === beryl.record.id)).toBe(true);
      hub.handlePacketForTest(berylSession.id, { type: "ignore.add", targetId: atlas.record.id, requestId: "ignore" });
      const masked = atlasSocket.messages.filter((packet) => packet.type === "presence.update").at(-1);
      expect(masked?.type).toBe("presence.update");
      if (masked?.type === "presence.update") expect(masked.user.status).toBe("offline");
      const updatesBeforeStatus = atlasSocket.messages.filter((packet) => packet.type === "presence.update").length;
      hub.handlePacketForTest(berylSession.id, { type: "presence.set", status: "busy", requestId: "status" });
      expect(atlasSocket.messages.filter((packet) => packet.type === "presence.update")).toHaveLength(updatesBeforeStatus);
      hub.handlePacketForTest(berylSession.id, { type: "ignore.remove", targetId: "Atlas", requestId: "unignore" });
      const restored = atlasSocket.messages.filter((packet) => packet.type === "presence.update").at(-1);
      expect(restored?.type).toBe("presence.update");
      if (restored?.type === "presence.update") expect(restored.user.status).toBe("busy");
      hub.handlePacketForTest(berylSession.id, { type: "friend.add", friendId: atlas.record.id, requestId: "watch" });
      hub.disconnect(atlasSession.id);
      hub.disconnect(atlasAltSession.id);
      expect(store.delete(atlas.record.id, "owner-a")?.id).toBe(atlas.record.id);
      expect(store.create({ id: atlas.record.id, ownerRef: "owner-c", name: "Cairo", appearance: atlas.record.appearance, bypassSlotCap: true }).ok).toBe(true);
      berylSocket.messages.length = 0;
      hub.connect(new FakeChatSocket(), { userId: atlas.record.id, displayName: "Cairo", zoneId: "open-desert" });
      expect(berylSocket.messages.some((packet) => packet.type === "presence.update")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fans out an immediate unmask when friend add replaces an ignore edge", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "successor-chat-friend-unmask-"));
    try {
      const store = new CharacterStore(path.join(dir, "characters.json"));
      const appearance = { skinTone: "#aabbcc", hair: "hair_mop", hairMat: "hair_raven", face: null } as const;
      const atlas = store.create({ id: "char_atlas", ownerRef: "owner-a", name: "Atlas", appearance, bypassSlotCap: true });
      const beryl = store.create({ id: "char_beryl", ownerRef: "owner-b", name: "Beryl", appearance, bypassSlotCap: true });
      if (!atlas.ok || !beryl.ok) throw new Error("expected social fixture characters");
      expect(store.saveSocialContact(beryl.record.id, atlas.record.id, "friend").ok).toBe(true);
      const hub = new ChatHub({ social: store, sendHelloOnConnect: false });
      const atlasSession = hub.connect(new FakeChatSocket(), { userId: atlas.record.id, displayName: atlas.record.name, zoneId: "open-desert" });
      const berylSocket = new FakeChatSocket();
      hub.connect(berylSocket, { userId: beryl.record.id, displayName: beryl.record.name, zoneId: "open-desert" });

      hub.handlePacketForTest(atlasSession.id, { type: "ignore.add", targetId: beryl.record.id, requestId: "ignore" });
      berylSocket.messages.length = 0;
      hub.handlePacketForTest(atlasSession.id, { type: "friend.add", friendId: beryl.record.id, requestId: "friend" });

      const update = berylSocket.messages.slice().reverse().find((packet) => packet.type === "presence.update");
      expect(update).toMatchObject({
        type: "presence.update",
        reason: "friend-add",
        user: { id: atlas.record.id, displayName: "Atlas", status: "online" },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invalidates deleted characters across social caches, rosters, sessions, and id reuse", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "successor-chat-delete-invalidation-"));
    try {
      const store = new CharacterStore(path.join(dir, "characters.json"));
      const appearance = { skinTone: "#aabbcc", hair: "hair_mop", hairMat: "hair_raven", face: null } as const;
      const atlas = store.create({ id: "char_atlas", ownerRef: "owner-a", name: "Atlas", appearance, bypassSlotCap: true });
      const beryl = store.create({ id: "char_beryl", ownerRef: "owner-b", name: "Beryl", appearance, bypassSlotCap: true });
      const cairo = store.create({ id: "char_cairo", ownerRef: "owner-c", name: "Cairo", appearance, bypassSlotCap: true });
      if (!atlas.ok || !beryl.ok || !cairo.ok) throw new Error("expected deletion fixture characters");
      expect(store.saveSocialContact(atlas.record.id, cairo.record.id, "friend").ok).toBe(true);
      expect(store.saveSocialContact(atlas.record.id, beryl.record.id, "ignored").ok).toBe(true);
      expect(store.saveSocialContact(beryl.record.id, atlas.record.id, "friend").ok).toBe(true);
      expect(store.saveSocialContact(cairo.record.id, atlas.record.id, "ignored").ok).toBe(true);

      const hub = new ChatHub({ social: store, sendHelloOnConnect: false });
      const atlasSocket = new FakeChatSocket();
      const atlasSiblingSocket = new FakeChatSocket();
      hub.connect(atlasSocket, { userId: atlas.record.id, displayName: atlas.record.name, zoneId: "open-desert" });
      hub.connect(atlasSiblingSocket, { userId: atlas.record.id, displayName: atlas.record.name, zoneId: "open-desert" });
      const berylSocket = new FakeChatSocket();
      hub.connect(berylSocket, { userId: beryl.record.id, displayName: beryl.record.name, zoneId: "open-desert" });
      hub.connect(new FakeChatSocket(), { userId: cairo.record.id, displayName: cairo.record.name, zoneId: "open-desert" });
      const berylMessagesBeforeDelete = berylSocket.messages.length;

      expect(store.delete(atlas.record.id, "owner-a")?.id).toBe(atlas.record.id);
      hub.invalidateDeletedCharacter(atlas.record.id);

      expect(atlasSocket.closes.at(-1)).toEqual({ code: 1000, reason: "character deleted" });
      expect(atlasSiblingSocket.closes.at(-1)).toEqual({ code: 1000, reason: "character deleted" });
      expect(hub.snapshot().sessionCount).toBe(2);
      expect(hub.snapshot().groups.friendWatchers).toEqual({});
      expect(berylSocket.messages.length).toBeGreaterThan(berylMessagesBeforeDelete);
      expect(berylSocket.messages.slice().reverse().find((packet) => packet.type === "friends.snapshot")).toMatchObject({ friends: [] });

      const replacement = store.create({ id: atlas.record.id, ownerRef: "owner-new", name: "Dawn", appearance, bypassSlotCap: true });
      expect(replacement.ok).toBe(true);
      const replacementSocket = new FakeChatSocket();
      hub.connect(replacementSocket, { userId: atlas.record.id, displayName: "Dawn", zoneId: "open-desert" });
      expect(berylSocket.messages.slice().reverse().find((packet) => packet.type === "presence.update")).not.toMatchObject({
        user: { id: atlas.record.id, displayName: "Atlas" },
      });
      expect(replacementSocket.closes).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not inherit cached ignore edges after target ID reuse", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "successor-chat-ignore-reuse-"));
    try {
      const store = new CharacterStore(path.join(dir, "characters.json"));
      const atlas = store.create({ id: "char_atlas", ownerRef: "owner-a", name: "Atlas", appearance: { skinTone: "#aabbcc", hair: "hair_mop", hairMat: "hair_raven", face: null }, bypassSlotCap: true });
      const beryl = store.create({ id: "char_beryl", ownerRef: "owner-b", name: "Beryl", appearance: { skinTone: "#aabbcc", hair: "hair_mop", hairMat: "hair_raven", face: null }, bypassSlotCap: true });
      if (!atlas.ok || !beryl.ok) throw new Error("expected characters");
      const hub = new ChatHub({ social: store, sendHelloOnConnect: false });
      const atlasSocket = new FakeChatSocket();
      const berylSocket = new FakeChatSocket();
      const atlasSession = hub.connect(atlasSocket, { userId: atlas.record.id, displayName: atlas.record.name, zoneId: "open-desert" });
      const berylSession = hub.connect(berylSocket, { userId: beryl.record.id, displayName: beryl.record.name, zoneId: "open-desert" });
      hub.handlePacketForTest(berylSession.id, { type: "ignore.add", targetId: atlas.record.id, requestId: "ignore" });
      hub.disconnect(berylSession.id);
      expect(store.delete(beryl.record.id, "owner-b")?.id).toBe(beryl.record.id);
      expect(store.create({ id: beryl.record.id, ownerRef: "owner-c", name: "Cairo", appearance: atlas.record.appearance, bypassSlotCap: true }).ok).toBe(true);
      const replacementSocket = new FakeChatSocket();
      const replacement = hub.connect(replacementSocket, { userId: beryl.record.id, displayName: "Cairo", zoneId: "open-desert" });
      hub.handlePacketForTest(atlasSession.id, { type: "chat.send", channel: "whisper", targetId: beryl.record.id, body: "reused id", requestId: "reuse" });
      expect(replacementSocket.messages.some((packet) => packet.type === "chat.message" && packet.message.body === "reused id")).toBe(true);
      expect(replacement.id).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ChatHub scale indexes", () => {
  it("reloads character-scoped social lists independently across a fresh hub", () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(path.join(os.tmpdir(), "successor-chat-reload-"));
    try {
      const filePath = path.join(dir, "characters.json");
      const store = new CharacterStore(filePath);
      const appearance = { skinTone: "#aabbcc", hair: "hair_mop", hairMat: "hair_raven", face: null } as const;
      const atlas = store.create({ id: "char_atlas", ownerRef: "owner-a", name: "Atlas", appearance, bypassSlotCap: true });
      const beryl = store.create({ id: "char_beryl", ownerRef: "owner-a", name: "Beryl", appearance, bypassSlotCap: true });
      const cairo = store.create({ id: "char_cairo", ownerRef: "owner-a", name: "Cairo", appearance, bypassSlotCap: true });
      if (!atlas.ok || !beryl.ok || !cairo.ok) throw new Error("expected reload fixture");
      expect(store.saveSocialContact(atlas.record.id, beryl.record.id, "friend").ok).toBe(true);
      expect(store.saveSocialContact(beryl.record.id, cairo.record.id, "friend").ok).toBe(true);
      const reloadedStore = new CharacterStore(filePath);
      const hub = new ChatHub({ social: reloadedStore, sendHelloOnConnect: true });
      const atlasSocket = new FakeChatSocket();
      const berylSocket = new FakeChatSocket();
      const cairoSocket = new FakeChatSocket();
      hub.connect(atlasSocket, { userId: atlas.record.id, displayName: atlas.record.name, zoneId: "open-desert" });
      hub.connect(berylSocket, { userId: beryl.record.id, displayName: beryl.record.name, zoneId: "open-desert" });
      hub.connect(cairoSocket, { userId: cairo.record.id, displayName: cairo.record.name, zoneId: "open-desert" });
      vi.runAllTimers();
      const snapshots = (socket: FakeChatSocket) => socket.messages.filter((packet) => packet.type === "friends.snapshot").at(-1);
      expect(snapshots(atlasSocket)).toMatchObject({ friends: [{ id: beryl.record.id }] });
      expect(snapshots(berylSocket)).toMatchObject({ friends: [{ id: cairo.record.id }] });
      expect(reloadedStore.delete(beryl.record.id, "owner-a")?.id).toBe(beryl.record.id);
      const atlasSiblingSocket = new FakeChatSocket();
      hub.connect(atlasSiblingSocket, { userId: atlas.record.id, displayName: atlas.record.name, zoneId: "open-desert" });
      vi.runAllTimers();
      expect(snapshots(atlasSocket)).toMatchObject({ friends: [] });
      expect(snapshots(atlasSiblingSocket)).toMatchObject({ friends: [] });
      expect(snapshots(cairoSocket)).toMatchObject({ friends: [] });
    } finally {
      vi.useRealTimers();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("preserves the full 64-character durable ids for connect and whisper", () => {
    const hub = new ChatHub({ sendHelloOnConnect: false });
    const senderId = `char_${"a".repeat(59)}`;
    const targetId = `char_${"b".repeat(59)}`;
    const senderSocket = new FakeChatSocket();
    const targetSocket = new FakeChatSocket();
    const collisionSocket = new FakeChatSocket();
    const sender = hub.connect(senderSocket, { userId: senderId, displayName: "Atlas", zoneId: "open-desert" });
    hub.connect(targetSocket, { userId: targetId, displayName: "Beryl", zoneId: "open-desert" });
    const collisionId = `${targetId.slice(0, 48)}${"c".repeat(16)}`;
    hub.connect(collisionSocket, { userId: collisionId, displayName: "Cairo", zoneId: "open-desert" });
    hub.handlePacketForTest(sender.id, { type: "chat.send", channel: "whisper", targetId, body: "long id ping", requestId: "long" });
    const delivered = targetSocket.messages.find((packet) => packet.type === "chat.message" && packet.message.body === "long id ping");
    expect(delivered?.type).toBe("chat.message");
    if (delivered?.type === "chat.message") expect(delivered.message.sender.id).toBe(senderId);
    expect(collisionSocket.messages.some((packet) => packet.type === "chat.message" && packet.message.body === "long id ping")).toBe(false);
    expect(hub.snapshot().onlineUserCount).toBe(3);
  });
  it("routes whispers to dotted durable ids without normalization loss", () => {
    const hub = new ChatHub({ sendHelloOnConnect: false });
    const senderSocket = new FakeChatSocket();
    const targetSocket = new FakeChatSocket();
    const sender = hub.connect(senderSocket, { userId: "char.atlas", displayName: "Atlas", zoneId: "open-desert" });
    hub.connect(targetSocket, { userId: "char.beryl", displayName: "Beryl", zoneId: "open-desert" });
    hub.handlePacketForTest(sender.id, { type: "chat.send", channel: "whisper", targetId: "char.beryl", body: "dotted", requestId: "dot" });
    expect(targetSocket.messages.some((packet) => packet.type === "chat.message" && packet.message.body === "dotted")).toBe(true);
  });
  it("routes a 500-recipient zone fanout without leaking to other zones", () => {
    const hub = new ChatHub({
      maxSessions: 1_100,
      maxSessionsPerUser: 1,
      sendHelloOnConnect: false,
    });
    const neonSockets: FakeChatSocket[] = [];
    const drainSockets: FakeChatSocket[] = [];
    let senderSessionId = "";

    for (let index = 0; index < 500; index += 1) {
      const socket = new FakeChatSocket();
      const session = hub.connect(socket, {
        userId: `neon-${index}`,
        displayName: `Neon ${index}`,
        zoneId: "open-desert",
      });
      if (index === 0) senderSessionId = session.id;
      neonSockets.push(socket);
    }

    for (let index = 0; index < 500; index += 1) {
      const socket = new FakeChatSocket();
      hub.connect(socket, {
        userId: `drain-${index}`,
        displayName: `Drain ${index}`,
        zoneId: "storm-drain",
      });
      drainSockets.push(socket);
    }

    hub.handlePacketForTest(senderSessionId, {
      type: "chat.send",
      channel: "zone",
      body: "scale ping",
    });

    expect(neonSockets.filter((socket) => hasChatBody(socket, "scale ping"))).toHaveLength(500);
    expect(drainSockets.filter((socket) => hasChatBody(socket, "scale ping"))).toHaveLength(0);
    expect(hub.snapshot().groups.zones).toEqual({ "open-desert": 500, "storm-drain": 500 });
    expect(hub.snapshot().counters.messagesRouted).toBe(1);
    expect(hub.snapshot().routing.maxRouteMs).toBeGreaterThanOrEqual(0);
  });

  it("enforces hub and per-user connection ceilings before indexing sessions", () => {
    const hub = new ChatHub({
      maxSessions: 2,
      maxSessionsPerUser: 1,
      sendHelloOnConnect: false,
    });

    hub.connect(new FakeChatSocket(), { userId: "observer", displayName: "Field Observer", zoneId: "open-desert" });
    const duplicate = new FakeChatSocket();
    expect(() => hub.connect(duplicate, { userId: "observer", displayName: "Field Observer", zoneId: "open-desert" })).toThrow(/too many sessions/u);
    expect(duplicate.closes.at(-1)).toEqual({ code: 1008, reason: "too many sessions for user" });

    hub.connect(new FakeChatSocket(), { userId: "warden", displayName: "Warden", zoneId: "open-desert" });
    const overflow = new FakeChatSocket();
    expect(() => hub.connect(overflow, { userId: "talla", displayName: "Talla", zoneId: "open-desert" })).toThrow(/chat hub full/u);
    expect(overflow.closes.at(-1)).toEqual({ code: 1013, reason: "chat hub full" });
    expect(hub.snapshot().sessionCount).toBe(2);
    expect(hub.snapshot().counters.rejectedConnections).toBe(2);
  });
});

describe("authoritative spatial and global chat routing", () => {
  it("bounds local speech by live area/distance while global reaches every connected area", () => {
    const positions = new Map([
      ["atlas", { areaId: "desert", x: 0, y: 0 }],
      ["near", { areaId: "desert", x: 12, y: 0 }],
      ["edge", { areaId: "desert", x: 24, y: 0 }],
      ["far", { areaId: "desert", x: 24.1, y: 0 }],
      ["interior", { areaId: "clone-interior", x: 0, y: 0 }],
    ]);
    const hub = new ChatHub({
      spatialAuthority: {
        positionForActor: (actorId) => positions.get(actorId) ?? null,
      },
      localRadiusCells: 24,
      sendHelloOnConnect: false,
    });
    const sockets = Object.fromEntries(
      [...positions.keys()].map((id) => [id, new FakeChatSocket()]),
    ) as Record<string, FakeChatSocket>;
    const sessions = Object.fromEntries(
      [...positions.keys()].map((id) => [
        id,
        hub.connect(sockets[id]!, { userId: id, displayName: id, zoneId: "forged-static-zone" }),
      ]),
    );

    hub.handlePacketForTest(sessions.atlas!.id, {
      type: "chat.send",
      channel: "local",
      body: "close enough to hear",
    });
    expect(hasChatBody(sockets.atlas!, "close enough to hear")).toBe(true);
    expect(hasChatBody(sockets.near!, "close enough to hear")).toBe(true);
    expect(hasChatBody(sockets.edge!, "close enough to hear")).toBe(true);
    expect(hasChatBody(sockets.far!, "close enough to hear")).toBe(false);
    expect(hasChatBody(sockets.interior!, "close enough to hear")).toBe(false);

    hub.handlePacketForTest(sessions.atlas!.id, {
      type: "chat.send",
      channel: "zone",
      body: "whole live area",
    });
    expect(hasChatBody(sockets.far!, "whole live area")).toBe(true);
    expect(hasChatBody(sockets.interior!, "whole live area")).toBe(false);

    hub.handlePacketForTest(sessions.atlas!.id, {
      type: "chat.send",
      channel: "global",
      body: "all areas check in",
    });
    expect(Object.values(sockets).every((socket) => hasChatBody(socket, "all areas check in"))).toBe(true);
    expect(hub.snapshot().limits.localRadiusCells).toBe(24);
  });

  it("fails local chat closed until the sender has a live authority position", () => {
    const hub = new ChatHub({
      spatialAuthority: { positionForActor: () => null },
      sendHelloOnConnect: false,
    });
    const socket = new FakeChatSocket();
    const session = hub.connect(socket, { userId: "atlas", displayName: "Atlas", zoneId: "forged-zone" });

    hub.handlePacketForTest(session.id, {
      type: "chat.send",
      channel: "local",
      body: "not in world",
      requestId: "local-1",
    });

    expect(socket.messages).toContainEqual(expect.objectContaining({
      type: "chat.error",
      code: "spatial_unavailable",
      requestId: "local-1",
    }));
    expect(hasChatBody(socket, "not in world")).toBe(false);
  });
});

describe("authoritative guild chat routing", () => {
  function authority(memberships: Map<string, string>) {
    return {
      guildIdForActor: (actorId: string) => memberships.get(actorId) ?? null,
    };
  }

  it("ignores forged guild identity and rejects outsiders", () => {
    const memberships = new Map<string, string>();
    const hub = new ChatHub({ guildAuthority: authority(memberships), sendHelloOnConnect: false });
    const socket = new FakeChatSocket();
    const session = hub.connect(socket, {
      userId: "outsider",
      displayName: "Outsider",
      zoneId: "open-desert",
      guildId: "guild-forged",
    } as never);

    hub.handlePacketForTest(session.id, { type: "chat.send", channel: "guild", body: "forged join" });

    expect(socket.messages).toContainEqual(expect.objectContaining({ type: "chat.error", code: "no_guild" }));
    expect(hub.snapshot().groups.guilds).toEqual({});
  });

  it("uses live authority membership for send, receive, isolation, and revocation", () => {
    const memberships = new Map([
      ["atlas", "guild-a"],
      ["beryl", "guild-a"],
      ["cairo", "guild-b"],
    ]);
    const hub = new ChatHub({ guildAuthority: authority(memberships), sendHelloOnConnect: false });
    const atlasSocket = new FakeChatSocket();
    const berylSocket = new FakeChatSocket();
    const cairoSocket = new FakeChatSocket();
    const outsiderSocket = new FakeChatSocket();
    const atlas = hub.connect(atlasSocket, { userId: "atlas", displayName: "Atlas", zoneId: "open-desert" });
    hub.connect(berylSocket, { userId: "beryl", displayName: "Beryl", zoneId: "open-desert" });
    hub.connect(cairoSocket, { userId: "cairo", displayName: "Cairo", zoneId: "open-desert" });
    hub.connect(outsiderSocket, { userId: "outsider", displayName: "Outsider", zoneId: "open-desert" });

    hub.handlePacketForTest(atlas.id, { type: "chat.send", channel: "guild", body: "guild-a hello" });
    expect(hasChatBody(atlasSocket, "guild-a hello")).toBe(true);
    expect(hasChatBody(berylSocket, "guild-a hello")).toBe(true);
    expect(hasChatBody(cairoSocket, "guild-a hello")).toBe(false);
    expect(hasChatBody(outsiderSocket, "guild-a hello")).toBe(false);

    memberships.delete("beryl");
    atlasSocket.messages.length = 0;
    berylSocket.messages.length = 0;
    hub.handlePacketForTest(atlas.id, { type: "chat.send", channel: "guild", body: "after leave" });
    expect(hasChatBody(berylSocket, "after leave")).toBe(false);
    expect(hasChatBody(atlasSocket, "after leave")).toBe(true);
  });

  it("looks up membership again after a hub restart/reconnect", () => {
    const memberships = new Map([["atlas", "guild-a"]]);
    const firstHub = new ChatHub({ guildAuthority: authority(memberships), sendHelloOnConnect: false });
    const firstSocket = new FakeChatSocket();
    firstHub.connect(firstSocket, { userId: "atlas", displayName: "Atlas", zoneId: "open-desert" });

    const restartedHub = new ChatHub({ guildAuthority: authority(memberships), sendHelloOnConnect: false });
    const senderSocket = new FakeChatSocket();
    const receiverSocket = new FakeChatSocket();
    const sender = restartedHub.connect(senderSocket, { userId: "atlas", displayName: "Atlas", zoneId: "open-desert" });
    restartedHub.connect(receiverSocket, { userId: "beryl", displayName: "Beryl", zoneId: "open-desert" });
    memberships.set("beryl", "guild-a");

    restartedHub.handlePacketForTest(sender.id, { type: "chat.send", channel: "guild", body: "after reconnect" });
    expect(hasChatBody(receiverSocket, "after reconnect")).toBe(true);
  });

  it("leaves non-guild channels unchanged when authority has no membership", () => {
    const hub = new ChatHub({ guildAuthority: authority(new Map()), sendHelloOnConnect: false });
    const senderSocket = new FakeChatSocket();
    const receiverSocket = new FakeChatSocket();
    const sender = hub.connect(senderSocket, { userId: "atlas", displayName: "Atlas", zoneId: "open-desert" });
    hub.connect(receiverSocket, { userId: "beryl", displayName: "Beryl", zoneId: "open-desert" });

    hub.handlePacketForTest(sender.id, { type: "chat.send", channel: "zone", body: "zone still works" });

    expect(hasChatBody(receiverSocket, "zone still works")).toBe(true);
  });
});

function hasChatBody(socket: FakeChatSocket, body: string): boolean {
  return socket.messages.some((packet) => packet.type === "chat.message" && packet.message.body === body);
}
