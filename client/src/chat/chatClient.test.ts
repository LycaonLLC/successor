import { afterEach, describe, expect, it, vi } from "vitest";

import { createChatClient, type ChatBubbleMessage, type FriendPresence } from "./chatClient";

interface FakeEvent {
  data?: unknown;
  code?: number;
  reason?: string;
}

type FakeListener = (event: FakeEvent) => void;

class FakeWebSocket {
  static readonly OPEN = 1;
  static latest: FakeWebSocket | null = null;
  readonly sent: string[] = [];
  readonly readyState = FakeWebSocket.OPEN;
  private readonly listeners = new Map<string, FakeListener[]>();

  constructor() {
    FakeWebSocket.latest = this;
  }

  addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.emit("close", { code: 1000, reason: "" });
  }

  emit(type: string, event: FakeEvent = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

const self: FriendPresence = {
  id: "char_atlas",
  displayName: "Atlas",
  status: "online",
  since: "2026-07-16T00:00:00.000Z",
};

function connectClient() {
  const client = createChatClient({ self, zoneId: "open-desert" });
  client.connect("ws://example.test/chat");
  const socket = FakeWebSocket.latest;
  if (!socket) throw new Error("expected fake websocket");
  return { client, socket };
}

describe("chat client social commands", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeWebSocket.latest = null;
  });

  it("sends standalone authentication as the only first websocket frame", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = createChatClient({ self, zoneId: "open-desert", authTicket: "chat-secret" });
    client.connect("wss://chat.example.test/socket");
    const socket = FakeWebSocket.latest;
    if (!socket) throw new Error("expected fake websocket");
    socket.emit("open");
    expect(socket.sent).toEqual([JSON.stringify({ type: "chat.authenticate", chatTicket: "chat-secret" })]);
    client.dispose();
  });

  it("starts application pings only after authenticated open and before the idle timeout", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = createChatClient({ self, zoneId: "open-desert", authTicket: "chat-secret" });
    client.connect("wss://chat.example.test/socket");
    const socket = FakeWebSocket.latest;
    if (!socket) throw new Error("expected fake websocket");

    vi.advanceTimersByTime(25_000);
    expect(socket.sent).toEqual([]);

    socket.emit("open");
    expect(socket.sent).toEqual([JSON.stringify({ type: "chat.authenticate", chatTicket: "chat-secret" })]);
    vi.advanceTimersByTime(24_999);
    expect(socket.sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({ type: "ping" });
    client.dispose();
  });

  it("cleans up pings on close and never duplicates the timer on replacement", () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = createChatClient({ self, zoneId: "open-desert" });
    client.connect("ws://example.test/chat");
    const firstSocket = FakeWebSocket.latest;
    if (!firstSocket) throw new Error("expected first fake websocket");
    firstSocket.emit("open");
    vi.advanceTimersByTime(25_000);
    expect(firstSocket.sent.filter((packet) => JSON.parse(packet).type === "ping")).toHaveLength(1);

    client.connect("ws://example.test/chat");
    const replacementSocket = FakeWebSocket.latest;
    if (!replacementSocket || replacementSocket === firstSocket) throw new Error("expected replacement fake websocket");
    replacementSocket.emit("open");
    vi.advanceTimersByTime(25_000);
    vi.advanceTimersByTime(25_000);
    expect(replacementSocket.sent.filter((packet) => JSON.parse(packet).type === "ping")).toHaveLength(2);

    replacementSocket.emit("close");
    vi.advanceTimersByTime(60_000);
    expect(replacementSocket.sent.filter((packet) => JSON.parse(packet).type === "ping")).toHaveLength(2);
    client.dispose();
  });

  it("anchors each network bubble to its authoritative sender", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const lycaon: FriendPresence = {
      id: "char_lycaon",
      displayName: "Lycaon",
      status: "online",
      since: self.since,
    };
    const bubbles: ChatBubbleMessage[] = [];
    const client = createChatClient({ self: lycaon, zoneId: "open-desert", onBubble: (bubble) => bubbles.push(bubble) });
    client.connect("ws://example.test/chat");
    const socket = FakeWebSocket.latest;
    if (!socket) throw new Error("expected fake websocket");

    socket.emit("message", { data: JSON.stringify({
      type: "chat.message",
      message: {
        id: "msg_oleks",
        channel: "local",
        sender: { id: "char_oleks", displayName: "Oleks" },
        body: "Oleks here",
        sentAt: self.since,
        zoneId: "open-desert",
        system: false,
      },
    }) });
    socket.emit("message", { data: JSON.stringify({
      type: "chat.message",
      message: {
        id: "msg_lycaon",
        channel: "local",
        sender: { id: "char_lycaon", displayName: "Lycaon" },
        body: "Lycaon here",
        sentAt: self.since,
        zoneId: "open-desert",
        system: false,
      },
    }) });
    for (const channel of ["zone", "global", "whisper"] as const) {
      socket.emit("message", { data: JSON.stringify({
        type: "chat.message",
        message: {
          id: `msg_${channel}`,
          channel,
          sender: { id: "char_oleks", displayName: "Oleks" },
          body: `${channel} line`,
          sentAt: self.since,
          zoneId: "open-desert",
          system: false,
        },
      }) });
    }

    expect(bubbles).toEqual([
      { body: "Oleks here", sender: "Oleks", own: false, actorId: "char_oleks" },
      { body: "Lycaon here", sender: "Lycaon", own: true, actorId: "char_lycaon" },
    ]);
    client.dispose();
  });

  it("sends the global command through the dedicated global channel", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { client, socket } = connectClient();

    client.submitLine("/global anyone out there?");

    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({
      type: "chat.send",
      channel: "global",
      body: "anyone out there?",
    });
    client.dispose();
  });

  it("renders readable /friends status output", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { client, socket } = connectClient();
    socket.emit("message", { data: JSON.stringify({
      type: "friends.snapshot",
      friends: [{ id: "char_beryl", displayName: "Beryl", status: "online", since: self.since }],
    }) });
    client.submitLine("/friends");
    expect(client.state.messages.at(-1)?.body).toBe("Beryl: online");
    client.dispose();
  });

  it("emits ignore add packets and removes friends on removal events", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { client, socket } = connectClient();
    socket.emit("message", { data: JSON.stringify({
      type: "friends.snapshot",
      friends: [{ id: "char_beryl", displayName: "Beryl", status: "away", since: self.since }],
    }) });
    client.submitLine("/ignore add Beryl");
    expect(JSON.parse(socket.sent.at(-1) ?? "{}")).toMatchObject({ type: "ignore.add", targetId: "Beryl" });
    socket.emit("message", { data: JSON.stringify({
      type: "friend.event",
      action: "removed",
      friend: { id: "char_beryl", displayName: "Beryl", status: "offline", since: self.since },
    }) });
    expect(client.state.friends).toEqual([]);
    client.dispose();
  });
});
