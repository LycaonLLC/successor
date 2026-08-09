import type { LaunchIdentity } from "../runtime/launchIdentity";
import { defaultBackendWsUrl, type RuntimeLocationLike } from "../runtime/runtimeDefaults";

export const CHAT_CHANNELS = ["all", "local", "zone", "global", "trade", "party", "guild", "whisper", "system"] as const;

export type ChatChannel = (typeof CHAT_CHANNELS)[number];
export type ChatRuntimeChannel = Exclude<ChatChannel, "all">;
export type ChatSendChannel = Exclude<ChatChannel, "all" | "system">;
export type PresenceState = "online" | "away" | "busy" | "offline";

export interface ChatUser {
  id: string;
  displayName: string;
}

export interface ChatMessage {
  id: string;
  channel: ChatRuntimeChannel;
  sender: ChatUser;
  body: string;
  sentAt: string;
  zoneId: string;
  targetId?: string;
  system: boolean;
}

export interface ChatDockInjectedMessage {
  id: string;
  channel?: ChatRuntimeChannel;
  sender: ChatUser;
  body: string;
  sentAt?: string;
  zoneId?: string;
  system?: boolean;
}

export interface FriendPresence {
  id: string;
  displayName: string;
  status: PresenceState;
  since: string;
}

export type ServerPacket =
  | {
      type: "chat.hello";
      sessionId: string;
      self: FriendPresence;
      channels: ChatRuntimeChannel[];
      serverTime: string;
    }
  | { type: "chat.message"; message: ChatMessage }
  | { type: "chat.history"; channel: ChatRuntimeChannel; messages: ChatMessage[] }
  | { type: "chat.error"; code: string; message: string; requestId?: string }
  | { type: "friends.snapshot"; friends: FriendPresence[] }
  | { type: "friend.event"; friend: FriendPresence; action: "added" | "removed" }
  | { type: "presence.update"; user: FriendPresence; reason: "connect" | "disconnect" | "status" | "friend-add" }
  | { type: "pong"; requestId?: string; at: number };

export type ClientPacket =
  | { type: "chat.send"; requestId: string; channel: ChatSendChannel; body: string; targetId?: string }
  | { type: "friend.add"; requestId: string; friendId: string }
  | { type: "friend.remove"; requestId: string; friendId: string }
  | { type: "ignore.add"; requestId: string; targetId: string }
  | { type: "ignore.remove"; requestId: string; targetId: string }
  | { type: "presence.set"; requestId: string; status: Exclude<PresenceState, "offline"> }
  | { type: "ping"; at?: number; requestId?: string };

export interface ChatBubbleMessage {
  body: string;
  sender: string;
  own: boolean;
  /** Authoritative character/actor id for network-originated speech. */
  actorId?: string;
}

export interface ChatClientOptions {
  self: FriendPresence;
  zoneId: string;
  onBubble?: (message: ChatBubbleMessage) => void;
  /** Standalone capability; sent once as the first websocket frame. */
  authTicket?: string;
  /** Exact release bound into the standalone chat capability. */
  authReleaseId?: string;
  onFailure?: (reason: "chat-failed") => void;
  /** Node clients supply a socket carrying an exact Origin header for the
   *  server's admission policy; browsers keep the native constructor. */
  socketFactory?: (wsUrl: string) => WebSocket;
}

export interface ChatClientState {
  activeChannel: ChatChannel;
  connected: boolean;
  connecting: boolean;
  socket: WebSocket | null;
  self: FriendPresence;
  messages: ChatMessage[];
  friends: FriendPresence[];
  requestSeq: number;
  reconnectAttempt: number;
  manuallyClosed: boolean;
}

export type ChatClientStateChangeReason = "active-channel" | "connecting" | "server-packet" | "disposed";

export type ChatClientEvent =
  | { type: "message-appended"; message: ChatMessage }
  | { type: "state-changed"; reason: ChatClientStateChangeReason };

export type ChatClientListener = (event: ChatClientEvent) => void;

export interface ChatClient {
  readonly channels: readonly ChatChannel[];
  readonly state: ChatClientState;
  connect: (wsUrl: string) => void;
  send: (channel: ChatSendChannel, body: string, targetId?: string) => void;
  submitLine: (value: string) => void;
  injectMessage: (message: ChatDockInjectedMessage) => boolean;
  setActiveChannel: (channel: ChatChannel) => void;
  subscribe: (listener: ChatClientListener) => () => void;
  dispose: () => void;
}

export interface ChatWsUrlLocation extends RuntimeLocationLike {
  href: string;
}

export interface ChatWsUrlOptions {
  location: ChatWsUrlLocation;
  searchParams: URLSearchParams;
}

const visibleMessageLimit = 120;

export function createChatClient(options: ChatClientOptions): ChatClient {
  const state: ChatClientState = {
    activeChannel: "all",
    connected: false,
    connecting: false,
    socket: null,
    self: options.self,
    messages: [],
    friends: [],
    requestSeq: 1,
    reconnectAttempt: 0,
    manuallyClosed: false,
  };
  const listeners = new Set<ChatClientListener>();
  let reconnectTimer: number | null = null;
  let chatPingTimer: number | null = null;

  const emit = (event: ChatClientEvent) => {
    for (const listener of listeners) listener(event);
  };
  const clearReconnectTimer = () => {
    if (reconnectTimer === null) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  };
  const clearChatPingTimer = () => {
    if (chatPingTimer === null) return;
    clearInterval(chatPingTimer);
    chatPingTimer = null;
  };
  const startChatPing = (socket: WebSocket) => {
    clearChatPingTimer();
    chatPingTimer = setInterval(() => {
      if (state.socket !== socket || !state.connected || socket.readyState !== WebSocket.OPEN) {
        clearChatPingTimer();
        return;
      }
      socket.send(JSON.stringify({ type: "ping", at: Date.now() }));
    }, 25_000) as unknown as number;
  };
  const scheduleReconnect = (wsUrl: string, delay: number) => {
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectChat(state, wsUrl, options, emit, scheduleReconnect, startChatPing, clearChatPingTimer);
    }, delay) as unknown as number;
  };

  return {
    channels: CHAT_CHANNELS,
    state,
    connect: (wsUrl) => {
      state.manuallyClosed = false;
      clearReconnectTimer();
      clearChatPingTimer();
      const previousSocket = state.socket;
      state.socket = null;
      state.connected = false;
      state.connecting = false;
      previousSocket?.close();
      connectChat(state, wsUrl, options, emit, scheduleReconnect, startChatPing, clearChatPingTimer);
    },
    send: (channel, body, targetId) => {
      sendChat(state, channel, body, emit, targetId);
    },
    submitLine: (value) => {
      if (value.startsWith("/")) {
        submitCommand(state, value, emit);
      } else {
        sendChat(state, state.activeChannel === "all" || state.activeChannel === "system" ? "local" : state.activeChannel, value, emit);
      }
    },
    injectMessage: (message) => {
      const body = String(message.body ?? "").replace(/\s+/gu, " ").trim();
      if (!message.id || !body) return false;
      appendMessage(state, {
        id: message.id,
        channel: message.channel ?? "local",
        sender: message.sender,
        body,
        sentAt: message.sentAt ?? new Date().toISOString(),
        zoneId: message.zoneId ?? options.zoneId,
        system: message.system ?? false,
      }, options, emit, false);
      return true;
    },
    setActiveChannel: (channel) => {
      state.activeChannel = channel;
      emit({ type: "state-changed", reason: "active-channel" });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose: () => {
      state.manuallyClosed = true;
      clearReconnectTimer();
      clearChatPingTimer();
      state.connected = false;
      state.connecting = false;
      const socket = state.socket;
      state.socket = null;
      socket?.close();
      emit({ type: "state-changed", reason: "disposed" });
    },
  };
}

export function connectChatClient(wsUrl: string, options: ChatClientOptions): ChatClient {
  const client = createChatClient(options);
  client.connect(wsUrl);
  return client;
}

export function chatWsUrl(identity: LaunchIdentity, options: ChatWsUrlOptions): string {
  if (identity.standalone && identity.chatWsUrl) {
    const url = new URL(identity.chatWsUrl, options.location.href);
    url.search = "";
    url.hash = "";
    return url.toString();
  }
  const ticket = identity.ticket;
  const override = identity.chatWsUrl;
  if (override) {
    const url = new URL(override, options.location.href);
    if (ticket) {
      url.searchParams.set("ticket", ticket);
    } else {
      url.searchParams.set("playerId", identity.playerId);
      url.searchParams.set("displayName", identity.displayName);
      url.searchParams.set("zoneId", identity.zoneId);
      if (identity.partyId) url.searchParams.set("partyId", identity.partyId);
      if (identity.guildId) url.searchParams.set("guildId", identity.guildId);
    }
    return url.toString();
  }
  const query = ticket
    ? new URLSearchParams({ ticket })
    : new URLSearchParams({
        playerId: identity.playerId,
        displayName: identity.displayName,
        zoneId: identity.zoneId,
      });
  if (!ticket && identity.partyId) query.set("partyId", identity.partyId);
  if (!ticket && identity.guildId) query.set("guildId", identity.guildId);
  const url = new URL(defaultBackendWsUrl({
    kind: "chat",
    searchParams: options.searchParams,
    location: options.location,
  }));
  for (const [key, value] of query.entries()) url.searchParams.set(key, value);
  return url.toString();
}

function connectChat(
  state: ChatClientState,
  wsUrl: string,
  options: ChatClientOptions,
  emit: (event: ChatClientEvent) => void,
  scheduleReconnect: (wsUrl: string, delay: number) => void,
  startChatPing: (socket: WebSocket) => void,
  clearChatPingTimer: () => void,
) {
  const socket = options.socketFactory ? options.socketFactory(wsUrl) : new WebSocket(wsUrl);
  state.socket = socket;
  state.connecting = true;
  emit({ type: "state-changed", reason: "connecting" });

  socket.addEventListener("open", () => {
    if (state.socket !== socket || state.manuallyClosed) return;
    if (options.authTicket) {
      if (!options.authReleaseId) throw new Error("standalone chat release id required");
      socket.send(JSON.stringify({
        type: "chat.authenticate",
        chatTicket: options.authTicket,
        release: options.authReleaseId,
      }));
      options.authTicket = undefined;
    }
    state.connected = true;
    state.connecting = false;
    state.reconnectAttempt = 0;
    startChatPing(socket);
    addLocalSystemMessage(state, "Chat connected.", emit);
  });

  socket.addEventListener("message", (event) => {
    if (state.socket !== socket) return;
    const packet = parseServerPacket(event.data);
    if (!packet) return;
    handleServerPacket(state, packet, options, emit);
    emit({ type: "state-changed", reason: "server-packet" });
  });

  socket.addEventListener("close", (event) => {
    if (state.socket !== socket) return;
    clearChatPingTimer();
    state.connected = false;
    state.connecting = false;
    state.socket = null;
    const terminalReason = terminalCloseReason(event, wsUrl);
    if (terminalReason) {
      if (options.authTicket !== undefined) options.authTicket = undefined;
      options.onFailure?.("chat-failed");
      state.manuallyClosed = true;
      addLocalSystemMessage(state, terminalReason, emit);
    } else {
      addLocalSystemMessage(state, "Chat disconnected.", emit);
    }
    if (!state.manuallyClosed) {
      const delay = Math.min(10_000, 500 * 2 ** state.reconnectAttempt);
      state.reconnectAttempt += 1;
      scheduleReconnect(wsUrl, delay);
    }
  });

  socket.addEventListener("error", () => {
    if (state.socket !== socket) return;
    clearChatPingTimer();
    state.connecting = false;
    addLocalSystemMessage(state, "Chat socket error.", emit);
  });
}

function terminalCloseReason(event: CloseEvent, wsUrl: string): string | null {
  if (event.code !== 1008) return null;
  let hasLaunchTicket: boolean;
  try {
    hasLaunchTicket = new URL(wsUrl).searchParams.has("ticket");
  } catch {
    hasLaunchTicket = wsUrl.includes("ticket=");
  }
  if (hasLaunchTicket) return "Chat session expired. Re-enter from the site.";
  return event.reason ? `Chat closed: ${event.reason}.` : "Chat closed by server policy.";
}

function handleServerPacket(
  state: ChatClientState,
  packet: ServerPacket,
  options: ChatClientOptions,
  emit: (event: ChatClientEvent) => void,
) {
  switch (packet.type) {
    case "chat.hello":
      state.self = packet.self;
      break;
    case "chat.history":
      for (const message of packet.messages) appendMessage(state, message, options, emit, false);
      break;
    case "chat.message":
      appendMessage(state, packet.message, options, emit);
      break;
    case "chat.error":
      addLocalSystemMessage(state, packet.message, emit);
      break;
    case "friends.snapshot":
      state.friends = packet.friends;
      break;
    case "friend.event":
      state.friends = packet.action === "removed"
        ? state.friends.filter((friend) => friend.id !== packet.friend.id)
        : upsertFriend(state.friends, packet.friend);
      addLocalSystemMessage(state, `${packet.friend.displayName} ${packet.action}.`, emit);
      break;
    case "presence.update":
      if (state.friends.some((friend) => friend.id === packet.user.id)) {
        state.friends = upsertFriend(state.friends, packet.user);
      }
      break;
    case "pong":
      break;
  }
}

function appendMessage(
  state: ChatClientState,
  message: ChatMessage,
  options: ChatClientOptions,
  emit: (event: ChatClientEvent) => void,
  emitSpatialBubble = true,
) {
  if (state.messages.some((existing) => existing.id === message.id)) return;
  state.messages.push(message);
  if (state.messages.length > visibleMessageLimit) {
    state.messages.splice(0, state.messages.length - visibleMessageLimit);
  }
  if (emitSpatialBubble && message.channel === "local" && !message.system) {
    options.onBubble?.({
      body: message.body,
      sender: message.sender.displayName,
      own: message.sender.id === state.self.id,
      actorId: message.sender.id,
    });
  }
  emit({ type: "message-appended", message });
}

function submitCommand(state: ChatClientState, value: string, emit: (event: ChatClientEvent) => void) {
  const [commandRaw = "", ...rest] = value.slice(1).trim().split(/\s+/u);
  const command = commandRaw.toLowerCase();
  const body = rest.join(" ");
  switch (command) {
    case "local":
    case "say":
      sendChat(state, "local", body, emit);
      break;
    case "zone":
      sendChat(state, "zone", body, emit);
      break;
    case "g":
    case "global":
      sendChat(state, "global", body, emit);
      break;
    case "trade":
      sendChat(state, "trade", body, emit);
      break;
    case "party":
      sendChat(state, "party", body, emit);
      break;
    case "guild":
      sendChat(state, "guild", body, emit);
      break;
    case "w":
    case "whisper": {
      const [targetId = "", ...messageParts] = rest;
      sendChat(state, "whisper", messageParts.join(" "), emit, targetId);
      break;
    }
    case "friend": {
      const [action = "", friendId = ""] = rest;
      if (action === "add") sendPacket(state, { type: "friend.add", friendId, requestId: nextRequestId(state) }, emit);
      else if (action === "remove") sendPacket(state, { type: "friend.remove", friendId, requestId: nextRequestId(state) }, emit);
      else if (action === "list" || !action) {
        addLocalSystemMessage(state, state.friends.length
          ? state.friends.map((friend) => `${friend.displayName}: ${friend.status}`).join(" | ")
          : "Friends: none.", emit);
      } else addLocalSystemMessage(state, "Use /friend add player, /friend remove player, or /friend list.", emit);
      break;
    }
    case "friends":
      addLocalSystemMessage(state, state.friends.length
        ? state.friends.map((friend) => `${friend.displayName}: ${friend.status}`).join(" | ")
        : "Friends: none.", emit);
      break;
    case "ignore": {
      const [action = "", targetId = ""] = rest;
      if (action === "add") sendPacket(state, { type: "ignore.add", targetId, requestId: nextRequestId(state) }, emit);
      else if (action === "remove") sendPacket(state, { type: "ignore.remove", targetId, requestId: nextRequestId(state) }, emit);
      else addLocalSystemMessage(state, "Use /ignore add player or /ignore remove player.", emit);
      break;
    }
    case "status":
      if (body === "online" || body === "away" || body === "busy") {
        sendPacket(state, { type: "presence.set", status: body, requestId: nextRequestId(state) }, emit);
      } else {
        addLocalSystemMessage(state, "Use /status online, /status away, or /status busy.", emit);
      }
      break;
    case "help":
      addLocalSystemMessage(state, "Commands: /local, /zone, /global, /trade, /party, /guild, /w player msg, /friend add player, /friend list, /ignore add player, /friends, /status away.", emit);
      break;
    default:
      addLocalSystemMessage(state, `Unknown command: /${command}`, emit);
      break;
  }
}

function sendChat(
  state: ChatClientState,
  channel: ChatSendChannel,
  body: string,
  emit: (event: ChatClientEvent) => void,
  targetId?: string,
) {
  sendPacket(state, {
    type: "chat.send",
    channel,
    body,
    targetId,
    requestId: nextRequestId(state),
  }, emit);
}

function sendPacket(state: ChatClientState, packet: ClientPacket, emit: (event: ChatClientEvent) => void) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    addLocalSystemMessage(state, "Chat is offline.", emit);
    return;
  }
  state.socket.send(JSON.stringify(packet));
}

function nextRequestId(state: ChatClientState): string {
  const id = `c_${state.requestSeq}`;
  state.requestSeq += 1;
  return id;
}

function addLocalSystemMessage(state: ChatClientState, body: string, emit: (event: ChatClientEvent) => void) {
  appendMessage(
    state,
    {
      id: `local_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      channel: "system",
      sender: { id: "client", displayName: "CLIENT" },
      body,
      sentAt: new Date().toISOString(),
      zoneId: "local",
      system: true,
    },
    { self: state.self, zoneId: "local" },
    emit,
    false,
  );
}

function upsertFriend(friends: FriendPresence[], friend: FriendPresence): FriendPresence[] {
  const next = friends.filter((candidate) => candidate.id !== friend.id);
  next.push(friend);
  next.sort((left, right) => left.displayName.localeCompare(right.displayName));
  return next;
}

function parseServerPacket(data: unknown): ServerPacket | null {
  try {
    return JSON.parse(String(data)) as ServerPacket;
  } catch {
    return null;
  }
}
