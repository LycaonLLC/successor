import type { FastifyBaseLogger } from "fastify";
import { performance } from "node:perf_hooks";

import {
  channelPolicy,
  maxHistoryPerChannel,
  maxMessagesPerWindow,
  moderateChatBody,
  normalizeDisplayName,
  normalizeUserId,
  policySnapshot,
  rateWindowMs,
} from "./policy.js";
import {
  chatChannels,
  clientPacketSchema,
  type ChatChannel,
  type ChatMessage,
  type ChatUser,
  type ClientPacket,
  type FriendPresence,
  type PresenceState,
  type ServerPacket,
} from "./protocol.js";

import type { LaunchProvenance } from "../alpha/control-store.js";
import type { LaunchSessionRevocationSink } from "../auth/runtime.js";

import type {
  CharacterRecord,
  CharacterSocialContact,
  CharacterSocialRelation,
} from "../game/characterStore.js";

export interface ChatSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

export interface ChatSessionIdentity {
  userId: string;
  /** May be empty: the hub then names the session from the live shard, then
   *  the character store, and only falls back to the raw id if neither knows. */
  displayName: string;
  zoneId: string;
  partyId?: string;
  accountId?: string;
  ownerRef?: string;
  characterId?: string;
  launchProvenance?: LaunchProvenance;
}


/**
 * Production guild membership must come from the live Rust authority. A
 * missing adapter is fail-closed for guild chat; it is never a reason to
 * trust socket query data or launch-ticket claims.
 */
export interface ChatGuildAuthority {
  guildIdForActor(actorId: string): string | null;
}

export interface ChatSpatialPosition {
  areaId: string;
  x: number;
  y: number;
}

/**
 * Live game-authority position lookup for proximity and current-area chat.
 * Socket query fields are never trusted for production spatial routing.
 */
export interface ChatSpatialAuthority {
  positionForActor(actorId: string): ChatSpatialPosition | null;
}

/**
 * Live authority display-name lookup.
 *
 * A client may open its chat socket before its actor exists on the shard, so
 * the name is resolved again on the first message rather than only at connect.
 */
export interface ChatNameAuthority {
  displayNameForActor(actorId: string): string | null;
}

export interface ChatDevOnlyGuildIdentity {
  /** Explicitly test-only; never populated from a redeemed launch ticket. */
  devOnlyGuildId?: string;
}


export interface ChatSocialAdapter {
  resolveCharacter(value: unknown): CharacterRecord | null;
  listSocialContacts(characterId: string): CharacterSocialContact[] | null;
  saveSocialContact(characterId: string, targetId: string, relation: CharacterSocialRelation): { ok: boolean };
  deleteSocialContact(characterId: string, targetId: string): { ok: boolean };
}
interface ChatSession {
  id: string;
  socket: ChatSocket;
  user: ChatUser;
  zoneId: string;
  partyId?: string;
  devOnlyGuildId?: string;
  status: PresenceState;
  connectedAt: string;
  rate: {
    windowStartedAt: number;
    count: number;
  };
  lastByChannel: Map<ChatChannel, number>;
  recentBodies: Array<{ normalized: string; at: number }>;
  launchProvenance?: LaunchProvenance;
  unregisterRevocation?: () => void;
}

type ChatRecipients =
  | { kind: "all" }
  | { kind: "sessions"; sessions: ChatSession[] }
  | { kind: "sessionIds"; ids: ReadonlySet<string> };

export interface ChatHubOptions {
  logger?: Pick<FastifyBaseLogger, "warn" | "info" | "debug">;
  now?: () => number;
  maxSessions?: number;
  maxSessionsPerUser?: number;
  maxPacketBytes?: number;
  social?: ChatSocialAdapter;
  guildAuthority?: ChatGuildAuthority;
  spatialAuthority?: ChatSpatialAuthority;
  nameAuthority?: ChatNameAuthority;
  localRadiusCells?: number;
  sendHelloOnConnect?: boolean;
  sessionRevocations?: LaunchSessionRevocationSink;
}

export interface ChatHubSnapshot {
  sessionCount: number;
  onlineUserCount: number;
  messageCount: number;
  groups: {
    zones: Record<string, number>;
    parties: Record<string, number>;
    guilds: Record<string, number>;
    friendWatchers: Record<string, number>;
  };
  counters: {
    packetsIn: number;
    packetsOut: number;
    messagesRouted: number;
    sendsDropped: number;
    sendErrors: number;
    rejectedConnections: number;
  };
  routing: {
    lastRouteMs: number;
    averageRouteMs: number;
    maxRouteMs: number;
  };
  limits: {
    maxSessions: number;
    maxSessionsPerUser: number;
    maxPacketBytes: number;
    localRadiusCells: number;
  };
}

const defaultMaxSessions = 10_000;
const defaultMaxSessionsPerUser = 4;
const defaultMaxPacketBytes = 2_048;
const defaultLocalRadiusCells = 24;

export class ChatHub {
  private readonly sessions = new Map<string, ChatSession>();
  private readonly sessionsByUser = new Map<string, Set<string>>();
  private readonly sessionsByZone = new Map<string, Set<string>>();
  private readonly sessionsByParty = new Map<string, Set<string>>();
  private readonly sessionsByGuild = new Map<string, Set<string>>();
  private readonly displayNames = new Map<string, string>();
  private readonly friendsByUser = new Map<string, Set<string>>();
  private readonly ignoredByUser = new Map<string, Set<string>>();
  private readonly social?: ChatSocialAdapter;
  private readonly guildAuthority?: ChatGuildAuthority;
  private readonly spatialAuthority?: ChatSpatialAuthority;
  private readonly nameAuthority?: ChatNameAuthority;
  private readonly loadedSocialUsers = new Set<string>();
  private readonly friendWatchersByUser = new Map<string, Set<string>>();
  private readonly history = new Map<string, ChatMessage[]>();
  private readonly logger?: Pick<FastifyBaseLogger, "warn" | "info" | "debug">;
  private readonly now: () => number;
  private readonly maxSessions: number;
  private readonly maxSessionsPerUser: number;
  private readonly maxPacketBytes: number;
  private readonly localRadiusCells: number;
  private readonly sendHelloOnConnect: boolean;
  private readonly sessionRevocations?: LaunchSessionRevocationSink;
  private readonly counters = {
    packetsIn: 0,
    packetsOut: 0,
    messagesRouted: 0,
    sendsDropped: 0,
    sendErrors: 0,
    rejectedConnections: 0,
  };
  private readonly routeLatency = {
    lastMs: 0,
    totalMs: 0,
    maxMs: 0,
  };
  private nextSessionSeq = 1;
  private nextMessageSeq = 1;

  constructor(options: ChatHubOptions = {}) {
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.maxSessions = options.maxSessions ?? defaultMaxSessions;
    this.maxSessionsPerUser = options.maxSessionsPerUser ?? defaultMaxSessionsPerUser;
    this.maxPacketBytes = options.maxPacketBytes ?? defaultMaxPacketBytes;
    this.social = options.social;
    this.guildAuthority = options.guildAuthority;
    this.spatialAuthority = options.spatialAuthority;
    this.nameAuthority = options.nameAuthority;
    this.localRadiusCells = finitePositive(options.localRadiusCells, defaultLocalRadiusCells);
    this.sendHelloOnConnect = options.sendHelloOnConnect ?? true;
    this.sessionRevocations = options.sessionRevocations;
  }


  connect(
    socket: ChatSocket,
    identity: ChatSessionIdentity,
    devOnlyIdentity: ChatDevOnlyGuildIdentity = {},
  ): ChatSession {
    const userId = normalizeUserId(identity.userId);
    if (!userId) {
      socket.close(1008, "invalid user id");
      throw new Error("invalid user id");
    }
    this.loadSocial(userId);
    if (this.sessions.size >= this.maxSessions) {
      this.counters.rejectedConnections += 1;
      socket.close(1013, "chat hub full");
      throw new Error("chat hub full");
    }
    const userSessionCount = this.sessionsByUser.get(userId)?.size ?? 0;
    if (userSessionCount >= this.maxSessionsPerUser) {
      this.counters.rejectedConnections += 1;
      socket.close(1008, "too many sessions for user");
      throw new Error("too many sessions for user");
    }

    // A client that does not carry a name in its handshake still has one in the
    // character store, and the hub already reads that store to name whisper and
    // friend targets. Without this the fallback is the raw character id, so
    // every line the player sends is attributed to `char_0254efc180a54b6a`.
    const claimedName = identity.displayName || this.resolveDisplayName(userId);
    const displayName = normalizeDisplayName(claimedName, userId);
    const session: ChatSession = {
      id: `s_${this.nextSessionSeq++}`,
      socket,
      user: { id: userId, displayName },
      zoneId: normalizeUserId(identity.zoneId) || "open-desert",
      partyId: identity.partyId ? normalizeUserId(identity.partyId) : undefined,
      devOnlyGuildId: devOnlyIdentity.devOnlyGuildId ? normalizeUserId(devOnlyIdentity.devOnlyGuildId) : undefined,
      status: "online",
      connectedAt: this.isoNow(),
      rate: { windowStartedAt: this.now(), count: 0 },
      lastByChannel: new Map(),
      recentBodies: [],
      launchProvenance: identity.launchProvenance,
    };

    if (identity.launchProvenance && this.sessionRevocations) {
      session.unregisterRevocation = this.sessionRevocations.register(identity.launchProvenance, () => session.socket.close(4001, "launch revoked"));
    }
    this.sessions.set(session.id, session);
    this.displayNames.set(userId, displayName);
    this.indexSession(session);

    socket.on("message", (data) => this.handleRawMessage(session.id, data));
    socket.on("close", () => this.disconnect(session.id));
    socket.on("error", (error) => this.logger?.warn({ error, sessionId: session.id }, "chat socket error"));

    if (this.sendHelloOnConnect) {
      setTimeout(() => {
        if (!this.sessions.has(session.id)) return;
        this.send(session, {
          type: "chat.hello",
          sessionId: session.id,
          self: this.presenceFor(userId),
          channels: [...chatChannels],
          serverTime: this.isoNow(),
          policy: policySnapshot,
        });
        this.sendFriendsSnapshot(userId);
        for (const channel of ["system", "local", "zone", "global", "trade"] as ChatChannel[]) {
          this.send(session, { type: "chat.history", channel, messages: this.historyFor(session, channel) });
        }
        this.emitSystem(session, "Connected to Successor chat.");
        this.notifyFriendsOfPresence(userId, "connect");
      }, 0);
    } else {
      this.notifyFriendsOfPresence(userId, "connect");
    }
    return session;
  }

  disconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.sessions.delete(sessionId);
    session.unregisterRevocation?.();
    session.unregisterRevocation = undefined;
    this.unindexSession(session);
    if (!this.sessionsByUser.has(session.user.id)) {
      this.notifyFriendsOfPresence(session.user.id, "disconnect");
    }
  }
  invalidateDeletedCharacter(rawCharacterId: string): void {
    const characterId = normalizeUserId(rawCharacterId);
    if (!characterId) return;

    const affectedRosterUsers = new Set<string>();
    for (const watcherId of this.friendWatchersByUser.get(characterId) ?? []) {
      if (watcherId !== characterId) affectedRosterUsers.add(watcherId);
    }

    for (const [viewerId, friends] of this.friendsByUser) {
      if (!friends.delete(characterId)) continue;
      if (viewerId !== characterId) affectedRosterUsers.add(viewerId);
      if (friends.size === 0) this.friendsByUser.delete(viewerId);
    }
    for (const [viewerId, ignored] of this.ignoredByUser) {
      ignored.delete(characterId);
      if (ignored.size === 0) this.ignoredByUser.delete(viewerId);
    }
    for (const friendId of this.friendsByUser.get(characterId) ?? []) {
      removeFromIndex(this.friendWatchersByUser, friendId, characterId);
    }
    this.friendsByUser.delete(characterId);
    this.ignoredByUser.delete(characterId);
    this.friendWatchersByUser.delete(characterId);
    for (const [targetId, watchers] of this.friendWatchersByUser) {
      watchers.delete(characterId);
      if (watchers.size === 0) this.friendWatchersByUser.delete(targetId);
    }
    this.loadedSocialUsers.delete(characterId);
    this.displayNames.delete(characterId);

    const deletedSessions = this.sessionsForUser(characterId);
    for (const session of deletedSessions) {
      this.sessions.delete(session.id);
      this.unindexSession(session);
    }
    for (const session of deletedSessions) {
      session.socket.close(1000, "character deleted");
    }

    for (const watcherId of affectedRosterUsers) {
      if (watcherId !== characterId && this.sessionsByUser.has(watcherId)) {
        this.sendFriendsSnapshot(watcherId);
      }
    }
  }


  handlePacketForTest(sessionId: string, packet: ClientPacket): void {
    this.handlePacket(sessionId, packet);
  }

  snapshot(): ChatHubSnapshot {
    const userIds = [...this.sessionsByUser.keys()].sort();
    return {
      sessionCount: this.sessions.size,
      onlineUserCount: userIds.length,
      messageCount: [...this.history.values()].reduce((sum, messages) => sum + messages.length, 0),
      groups: {
        zones: groupSizes(this.sessionsByZone),
        parties: groupSizes(this.sessionsByParty),
        guilds: groupSizes(this.sessionsByGuild),
        friendWatchers: groupSizes(this.friendWatchersByUser),
      },
      counters: { ...this.counters },
      routing: {
        lastRouteMs: roundMetric(this.routeLatency.lastMs),
        averageRouteMs: roundMetric(this.averageRouteMs()),
        maxRouteMs: roundMetric(this.routeLatency.maxMs),
      },
      limits: {
        maxSessions: this.maxSessions,
        maxSessionsPerUser: this.maxSessionsPerUser,
        maxPacketBytes: this.maxPacketBytes,
        localRadiusCells: this.localRadiusCells,
      },
    };
  }

  private handleRawMessage(sessionId: string, data: unknown): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    let parsed: unknown;
    try {
      const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
      if (Buffer.byteLength(text, "utf8") > this.maxPacketBytes) {
        this.error(session, "packet_too_large", "Chat packet was too large.");
        return;
      }
      parsed = JSON.parse(text);
    } catch {
      this.error(session, "invalid_json", "Chat packet was not valid JSON.");
      return;
    }

    const result = clientPacketSchema.safeParse(parsed);
    if (!result.success) {
      this.error(session, "invalid_packet", "Chat packet failed schema validation.");
      return;
    }
    this.counters.packetsIn += 1;
    this.handlePacket(sessionId, result.data);
  }

  private handlePacket(sessionId: string, packet: ClientPacket): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    switch (packet.type) {
      case "chat.send":
        this.routeChat(session, packet.channel, packet.body, packet.targetId, packet.requestId);
        break;
      case "friend.add":
        this.addFriend(session, packet.friendId, packet.requestId);
        break;
      case "friend.remove":
        this.removeFriend(session, packet.friendId, packet.requestId);
        break;
      case "ignore.add":
        this.addIgnore(session, packet.targetId, packet.requestId);
        break;
      case "ignore.remove":
        this.removeIgnore(session, packet.targetId, packet.requestId);
        break;
      case "presence.set":
        session.status = packet.status;
        this.notifyFriendsOfPresence(session.user.id, "status");
        this.send(session, { type: "presence.update", user: this.presenceFor(session.user.id), reason: "status" });
        this.emitSystem(session, `Status set to ${packet.status}.`);
        break;
      case "ping":
        this.send(session, { type: "pong", requestId: packet.requestId, at: this.now() });
        break;
    }
  }

  private routeChat(
    session: ChatSession,
    channel: Exclude<ChatChannel, "system">,
    rawBody: string,
    targetId?: string,
    requestId?: string,
  ): void {
    const startedAt = performance.now();
    const policy = channelPolicy[channel];
    if (!policy.clientWritable) {
      this.error(session, "channel_readonly", "That channel is read-only.", requestId);
      return;
    }
    const rate = this.passRateLimit(session);
    if (!rate.ok) {
      this.error(session, "rate_limited", rate.message, requestId);
      this.emitSystem(session, rate.message);
      return;
    }
    const slowMode = this.passSlowMode(session, channel);
    if (!slowMode.ok) {
      this.error(session, "slow_mode", slowMode.message, requestId);
      return;
    }
    const moderation = moderateChatBody(rawBody, channel);
    if (!moderation.ok || !moderation.body) {
      this.error(session, moderation.code ?? "blocked", moderation.message ?? "Message blocked.", requestId);
      return;
    }
    if (this.isRepeated(session, moderation.body)) {
      this.error(session, "repeat", "Repeated chat line blocked.", requestId);
      return;
    }
    const recipients = this.recipientsFor(session, channel, targetId);
    if (!recipients.ok) {
      this.error(session, recipients.code, recipients.message, requestId);
      return;
    }
    const message = this.makeMessage(channel, this.senderFor(session), moderation.body, this.currentAreaId(session), targetId);
    this.rememberHistory(message);
    this.broadcast(recipients.recipients, { type: "chat.message", message });
    this.counters.messagesRouted += 1;
    this.recordRouteLatency(performance.now() - startedAt);
  }

  private recipientsFor(
    sender: ChatSession,
    channel: Exclude<ChatChannel, "system">,
    targetId?: string,
  ): { ok: true; recipients: ChatRecipients } | { ok: false; code: string; message: string } {
    if (channel === "whisper") {
      const target = this.resolveTarget(targetId ?? "");
      const normalizedTarget = target?.id ?? normalizeUserId(targetId ?? "");
      if (!normalizedTarget) {
        return { ok: false, code: "missing_target", message: "Whisper needs a target." };
      }
      if (this.isIgnoredBy(normalizedTarget, sender.user.id)) {
        return { ok: false, code: "target_offline", message: `${target?.name ?? normalizedTarget} is offline.` };
      }
      const recipients = this.sessionsForUser(normalizedTarget);
      if (recipients.length === 0) {
        return { ok: false, code: "target_offline", message: `${target?.name ?? normalizedTarget} is offline.` };
      }
      return { ok: true, recipients: { kind: "sessions", sessions: uniqueSessions([...recipients, sender]) } };
    }

    if (channel === "party") {
      if (!sender.partyId) return { ok: false, code: "no_party", message: "You are not in a party." };
      return { ok: true, recipients: this.recipientsFromIndex(this.sessionsByParty, sender.partyId) };
    }

    if (channel === "guild") {
      const senderGuildId = this.guildIdForSession(sender);
      if (!senderGuildId) return { ok: false, code: "no_guild", message: "You are not in a guild." };

      const recipients = new Set<string>();
      for (const session of this.sessions.values()) {
        if (this.guildIdForSession(session) === senderGuildId) recipients.add(session.id);
      }
      return { ok: true, recipients: { kind: "sessionIds", ids: recipients } };
    }

    if (channel === "local") {
      if (!this.spatialAuthority) {
        return { ok: true, recipients: this.recipientsFromIndex(this.sessionsByZone, sender.zoneId) };
      }
      const origin = this.authorityPositionFor(sender);
      if (!origin) {
        return { ok: false, code: "spatial_unavailable", message: "Local chat is unavailable until you enter the world." };
      }
      const radiusSq = this.localRadiusCells * this.localRadiusCells;
      const recipients = new Set<string>();
      for (const candidate of this.sessions.values()) {
        const position = this.authorityPositionFor(candidate);
        if (!position || position.areaId !== origin.areaId) continue;
        const dx = position.x - origin.x;
        const dy = position.y - origin.y;
        if (dx * dx + dy * dy <= radiusSq) recipients.add(candidate.id);
      }
      return { ok: true, recipients: { kind: "sessionIds", ids: recipients } };
    }

    if (channel === "zone") {
      if (!this.spatialAuthority) {
        return { ok: true, recipients: this.recipientsFromIndex(this.sessionsByZone, sender.zoneId) };
      }
      const origin = this.authorityPositionFor(sender);
      if (!origin) {
        return { ok: false, code: "spatial_unavailable", message: "Zone chat is unavailable until you enter the world." };
      }
      const recipients = new Set<string>();
      for (const candidate of this.sessions.values()) {
        if (this.authorityPositionFor(candidate)?.areaId === origin.areaId) recipients.add(candidate.id);
      }
      return { ok: true, recipients: { kind: "sessionIds", ids: recipients } };
    }

    return { ok: true, recipients: { kind: "all" } };
  }

  private addFriend(session: ChatSession, rawFriendId: string, requestId?: string): void {
    const target = this.resolveTarget(rawFriendId);
    const friendId = target?.id ?? (this.social ? "" : normalizeUserId(rawFriendId));
    if (!friendId || friendId === session.user.id) {
      this.error(session, "invalid_friend", "Friend id was invalid.", requestId);
      return;
    }
    const wasIgnored = this.ignoredByUser.get(session.user.id)?.has(friendId)
      || this.social?.listSocialContacts(session.user.id)?.some((contact) => contact.id === friendId && contact.relation === "ignored")
      || false;
    if (!this.persistSocial(session.user.id, friendId, "friend")) {
      this.error(session, "social_unavailable", "Friend list is unavailable.", requestId);
      return;
    }
    getOrCreateSet(this.friendsByUser, session.user.id).add(friendId);
    getOrCreateSet(this.friendWatchersByUser, friendId).add(session.user.id);
    this.ignoredByUser.get(session.user.id)?.delete(friendId);
    if (target) this.displayNames.set(friendId, target.name);
    if (!this.displayNames.has(friendId)) this.displayNames.set(friendId, friendId);
    const friend = this.presenceFor(friendId, session.user.id);
    this.send(session, { type: "friend.event", action: "added", friend });
    this.sendFriendsSnapshot(session.user.id);
    if (wasIgnored) this.notifyFriendsOfPresence(session.user.id, "friend-add");
    this.emitSystem(session, `Added ${friend.displayName} as a friend. ${friend.displayName} is ${friend.status}.`);
  }

  private removeFriend(session: ChatSession, rawFriendId: string, requestId?: string): void {
    const target = this.resolveTarget(rawFriendId);
    const friendId = target?.id ?? (this.social ? "" : normalizeUserId(rawFriendId));
    const friends = this.friendsByUser.get(session.user.id);
    if (!friendId || !friends?.has(friendId)) {
      this.error(session, "missing_friend", "That player is not on your friend list.", requestId);
      return;
    }
    if (!this.persistSocialDelete(session.user.id, friendId)) {
      this.error(session, "social_unavailable", "Friend list is unavailable.", requestId);
      return;
    }
    friends.delete(friendId);
    removeFromIndex(this.friendWatchersByUser, friendId, session.user.id);
    const friend = this.presenceFor(friendId, session.user.id);
    this.send(session, { type: "friend.event", action: "removed", friend });
    this.sendFriendsSnapshot(session.user.id);
    this.emitSystem(session, `Removed ${friend.displayName} from your friends.`);
  }

  private addIgnore(session: ChatSession, rawTargetId: string, requestId?: string): void {
    const target = this.resolveTarget(rawTargetId);
    const targetId = target?.id ?? (this.social ? "" : normalizeUserId(rawTargetId));
    if (!targetId || targetId === session.user.id) {
      this.error(session, "invalid_ignore", "Ignore target was invalid.", requestId);
      return;
    }
    if (!this.persistSocial(session.user.id, targetId, "ignored")) {
      this.error(session, "social_unavailable", "Ignore list is unavailable.", requestId);
      return;
    }
    const friends = this.friendsByUser.get(session.user.id);
    if (friends?.delete(targetId)) removeFromIndex(this.friendWatchersByUser, targetId, session.user.id);
    getOrCreateSet(this.ignoredByUser, session.user.id).add(targetId);
    if (target) this.displayNames.set(targetId, target.name);
    for (const viewerId of this.friendWatchersByUser.get(session.user.id) ?? []) {
      for (const viewerSession of this.sessionsForUser(viewerId)) {
        this.send(viewerSession, {
          type: "presence.update",
          user: this.presenceFor(session.user.id, viewerId),
          reason: "status",
        });
      }
    }
    this.sendFriendsSnapshot(session.user.id);
    this.emitSystem(session, `Added ${target?.name ?? targetId} to your ignore list.`);
  }

  private removeIgnore(session: ChatSession, rawTargetId: string, requestId?: string): void {
    const target = this.resolveTarget(rawTargetId);
    const targetId = target?.id ?? (this.social ? "" : normalizeUserId(rawTargetId));
    const ignored = this.ignoredByUser.get(session.user.id);
    if (!targetId || !ignored?.has(targetId)) {
      this.error(session, "missing_ignore", "That player is not on your ignore list.", requestId);
      return;
    }
    if (!this.persistSocialDelete(session.user.id, targetId)) {
      this.error(session, "social_unavailable", "Ignore list is unavailable.", requestId);
      return;
    }
    ignored.delete(targetId);
    this.sendFriendsSnapshot(session.user.id);
    this.notifyFriendsOfPresence(session.user.id, "status");
    this.emitSystem(session, `Removed ${this.displayNames.get(targetId) ?? targetId} from your ignore list.`);
  }
  private sendFriendsSnapshot(userId: string): void {
    const friends = this.friendSnapshot(userId);
    for (const session of this.sessionsForUser(userId)) {
      this.send(session, { type: "friends.snapshot", friends });
    }
  }


  private notifyFriendsOfPresence(userId: string, reason: "connect" | "disconnect" | "status" | "friend-add"): void {
    for (const watcherId of this.friendWatchersByUser.get(userId) ?? []) {
      if (watcherId === userId || this.isIgnoredBy(userId, watcherId)) continue;
      if (this.social && !this.hasPersistedFriend(watcherId, userId)) {
        removeFromIndex(this.friendWatchersByUser, userId, watcherId);
        this.friendsByUser.get(watcherId)?.delete(userId);
        this.sendFriendsSnapshot(watcherId);
        continue;
      }
      const user = this.presenceFor(userId, watcherId);
      const verb = user.status === "offline" ? "went offline" : `is ${user.status}`;
      for (const session of this.sessionsForUser(watcherId)) {
        this.send(session, { type: "presence.update", user, reason });
        this.emitSystem(session, `${user.displayName} ${verb}.`);
      }
    }
  }
  private hasPersistedFriend(viewerId: string, targetId: string): boolean {
    return this.social?.listSocialContacts(viewerId)?.some((contact) => contact.id === targetId && contact.relation === "friend") ?? true;
  }

  private emitSystem(session: ChatSession, body: string): void {
    const message = this.makeMessage("system", { id: "system", displayName: "SYSTEM" }, body, session.zoneId);
    this.rememberHistory(message);
    this.send(session, { type: "chat.message", message });
  }

  private makeMessage(
    channel: ChatChannel,
    sender: ChatUser,
    body: string,
    zoneId: string,
    targetId?: string,
  ): ChatMessage {
    return {
      id: `m_${this.nextMessageSeq++}`,
      channel,
      sender,
      body,
      sentAt: this.isoNow(),
      zoneId,
      targetId,
      system: channel === "system" || sender.id === "system",
    };
  }

  private rememberHistory(message: ChatMessage): void {
    if (message.channel === "local" || message.channel === "whisper" || message.channel === "system") return;
    const key = this.historyKeyForMessage(message);
    const messages = this.history.get(key) ?? [];
    messages.push(message);
    if (messages.length > maxHistoryPerChannel) {
      messages.splice(0, messages.length - maxHistoryPerChannel);
    }
    this.history.set(key, messages);
  }

  private passRateLimit(session: ChatSession): { ok: true } | { ok: false; message: string } {
    const now = this.now();
    if (now - session.rate.windowStartedAt > rateWindowMs) {
      session.rate.windowStartedAt = now;
      session.rate.count = 0;
    }
    session.rate.count += 1;
    if (session.rate.count > maxMessagesPerWindow) {
      return { ok: false, message: "Chat throttled. Slow down." };
    }
    return { ok: true };
  }

  private passSlowMode(
    session: ChatSession,
    channel: ChatChannel,
  ): { ok: true } | { ok: false; message: string } {
    const policy = channelPolicy[channel];
    if (policy.slowModeMs <= 0) return { ok: true };
    const last = session.lastByChannel.get(channel) ?? 0;
    const now = this.now();
    if (now - last < policy.slowModeMs) {
      const wait = Math.ceil((policy.slowModeMs - (now - last)) / 1000);
      return { ok: false, message: `${policy.label} is in slow mode. Wait ${wait}s.` };
    }
    session.lastByChannel.set(channel, now);
    return { ok: true };
  }
  private isRepeated(session: ChatSession, body: string): boolean {
    const normalized = body.toLowerCase();
    const now = this.now();
    session.recentBodies = session.recentBodies.filter((entry) => now - entry.at <= 20_000);
    const count = session.recentBodies.filter((entry) => entry.normalized === normalized).length;
    session.recentBodies.push({ normalized, at: now });
    return count >= 2;
  }

  private isIgnoredBy(targetId: string, viewerId: string): boolean {
    const ignored = this.ignoredByUser.get(targetId);
    if (!ignored?.has(viewerId)) return false;
    if (this.social && !this.social.listSocialContacts(targetId)?.some((contact) => contact.id === viewerId && contact.relation === "ignored")) {
      ignored.delete(viewerId);
      if (ignored.size === 0) this.ignoredByUser.delete(targetId);
      return false;
    }
    return true;
  }

  private friendSnapshot(userId: string): FriendPresence[] {
    const friends = this.friendsByUser.get(userId);
    if (friends && this.social) {
      for (const friendId of [...friends]) {
        if (!this.hasPersistedFriend(userId, friendId)) {
          friends.delete(friendId);
          removeFromIndex(this.friendWatchersByUser, friendId, userId);
        }
      }
    }
    return [...(friends ?? new Set<string>())]
      .sort()
      .map((friendId) => this.presenceFor(friendId, userId));
  }

  private presenceFor(userId: string, viewerId?: string): FriendPresence {
    const masked = viewerId !== undefined && this.isIgnoredBy(userId, viewerId);
    const sessions = this.sessionsForUser(userId);
    const online = !masked && sessions.length > 0;
    const status = online ? sessions[0]?.status ?? "online" : "offline";
    return {
      id: userId,
      displayName: this.displayNames.get(userId) ?? userId,
      status,
      since: online ? sessions[0]?.connectedAt ?? this.isoNow() : this.isoNow(),
    };
  }
  private guildIdForSession(session: ChatSession): string | undefined {
    if (this.guildAuthority) {
      try {
        const guildId = this.guildAuthority.guildIdForActor(session.user.id);
        return guildId ? normalizeUserId(guildId) || undefined : undefined;
      } catch (error) {
        this.logger?.warn({ error, actorId: session.user.id }, "guild authority lookup failed");
        return undefined;
      }
    }
    return session.devOnlyGuildId;
  }

  private authorityPositionFor(session: ChatSession): ChatSpatialPosition | null {
    if (!this.spatialAuthority) return null;
    try {
      const position = this.spatialAuthority.positionForActor(session.user.id);
      if (
        !position
        || !Number.isFinite(position.x)
        || !Number.isFinite(position.y)
      ) return null;
      const areaId = normalizeUserId(position.areaId);
      return areaId ? { areaId, x: position.x, y: position.y } : null;
    } catch (error) {
      this.logger?.warn({ error, actorId: session.user.id }, "chat spatial authority lookup failed");
      return null;
    }
  }

  private currentAreaId(session: ChatSession): string {
    return this.authorityPositionFor(session)?.areaId ?? session.zoneId;
  }


  private loadSocial(userId: string): void {
    if (this.loadedSocialUsers.has(userId)) return;
    this.loadedSocialUsers.add(userId);
    const contacts = this.social?.listSocialContacts(userId) ?? [];
    for (const contact of contacts) {
      if (contact.relation === "friend") {
        getOrCreateSet(this.friendsByUser, userId).add(contact.id);
        getOrCreateSet(this.friendWatchersByUser, contact.id).add(userId);
      } else {
        getOrCreateSet(this.ignoredByUser, userId).add(contact.id);
      }
      const target = this.social?.resolveCharacter(contact.id);
      if (target) this.displayNames.set(contact.id, target.name);
    }
  }

  private resolveTarget(value: string): CharacterRecord | null {
    return this.social?.resolveCharacter(value) ?? null;
  }

  /**
   * Best display name for a character id, or "" when nothing knows one.
   *
   * The live shard is asked first: it holds the name the world is already
   * showing over the player's head. The character store is the durable
   * fallback for a session whose actor is not resident.
   */
  private resolveDisplayName(userId: string): string {
    return this.nameAuthority?.displayNameForActor(userId)
      || this.resolveTarget(userId)?.name
      || "";
  }

  /**
   * The sender stamped on an outgoing message.
   *
   * A client may open its chat socket before its actor exists on the shard, in
   * which case connect had nothing to resolve and fell back to the raw id.
   * Retrying on the first message that still carries that fallback upgrades the
   * session once, so a player never spends a session named `char_...`.
   */
  private senderFor(session: ChatSession): ChatUser {
    if (session.user.displayName !== session.user.id) return session.user;
    const resolved = this.resolveDisplayName(session.user.id);
    if (!resolved) return session.user;
    const displayName = normalizeDisplayName(resolved, session.user.id);
    session.user = { ...session.user, displayName };
    this.displayNames.set(session.user.id, displayName);
    return session.user;
  }


  private persistSocial(characterId: string, targetId: string, relation: CharacterSocialRelation): boolean {
    return this.social?.saveSocialContact(characterId, targetId, relation).ok ?? true;
  }

  private persistSocialDelete(characterId: string, targetId: string): boolean {
    return this.social?.deleteSocialContact(characterId, targetId).ok ?? true;
  }

  private sessionsForUser(userId: string): ChatSession[] {
    const sessionIds = this.sessionsByUser.get(userId);
    if (!sessionIds) return [];
    return [...sessionIds].map((id) => this.sessions.get(id)).filter((session): session is ChatSession => Boolean(session));
  }

  private recipientsFromIndex(index: Map<string, Set<string>>, key: string): ChatRecipients {
    const ids = index.get(key);
    if (!ids) return { kind: "sessions", sessions: [] };
    return { kind: "sessionIds", ids };
  }

  private indexSession(session: ChatSession): void {
    getOrCreateSet(this.sessionsByUser, session.user.id).add(session.id);
    getOrCreateSet(this.sessionsByZone, session.zoneId).add(session.id);
    if (session.partyId) getOrCreateSet(this.sessionsByParty, session.partyId).add(session.id);
    if (session.devOnlyGuildId) getOrCreateSet(this.sessionsByGuild, session.devOnlyGuildId).add(session.id);
    for (const friendId of this.friendsByUser.get(session.user.id) ?? []) {
      getOrCreateSet(this.friendWatchersByUser, friendId).add(session.user.id);
    }
  }

  private unindexSession(session: ChatSession): void {
    removeFromIndex(this.sessionsByUser, session.user.id, session.id);
    removeFromIndex(this.sessionsByZone, session.zoneId, session.id);
    if (session.partyId) removeFromIndex(this.sessionsByParty, session.partyId, session.id);
    if (session.devOnlyGuildId) removeFromIndex(this.sessionsByGuild, session.devOnlyGuildId, session.id);
  }

  private historyFor(session: ChatSession, channel: ChatChannel): ChatMessage[] {
    if (channel === "system" || channel === "local" || channel === "whisper") return [];
    return this.history.get(this.historyKey(channel, this.currentAreaId(session))) ?? [];
  }

  private historyKeyForMessage(message: ChatMessage): string {
    return this.historyKey(message.channel, message.zoneId);
  }

  private historyKey(channel: ChatChannel, scope: string): string {
    if (channel === "global" || channel === "trade") return `${channel}:global`;
    return `${channel}:zone:${scope}`;
  }

  private broadcast(recipients: ChatRecipients, packet: ServerPacket): void {
    const data = JSON.stringify(packet);
    if (recipients.kind === "all") {
      for (const session of this.sessions.values()) {
        this.sendSerialized(session, data);
      }
      return;
    }
    if (recipients.kind === "sessionIds") {
      for (const id of recipients.ids) {
        const session = this.sessions.get(id);
        if (session) this.sendSerialized(session, data);
      }
      return;
    }
    for (const session of recipients.sessions) {
      this.sendSerialized(session, data);
    }
  }

  private send(session: ChatSession, packet: ServerPacket): void {
    this.sendSerialized(session, JSON.stringify(packet));
  }

  private sendSerialized(session: ChatSession, data: string): void {
    if (session.socket.readyState !== 1) {
      this.counters.sendsDropped += 1;
      return;
    }
    try {
      session.socket.send(data);
      this.counters.packetsOut += 1;
    } catch (error) {
      this.counters.sendErrors += 1;
      this.logger?.warn({ error, sessionId: session.id }, "chat socket send failed");
    }
  }

  private error(session: ChatSession, code: string, message: string, requestId?: string): void {
    this.send(session, { type: "chat.error", code, message, requestId });
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  private recordRouteLatency(ms: number): void {
    this.routeLatency.lastMs = ms;
    this.routeLatency.totalMs += ms;
    this.routeLatency.maxMs = Math.max(this.routeLatency.maxMs, ms);
  }

  private averageRouteMs(): number {
    if (this.counters.messagesRouted === 0) return 0;
    return this.routeLatency.totalMs / this.counters.messagesRouted;
  }
}

function getOrCreateSet<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
  const existing = map.get(key);
  if (existing) return existing;
  const created = new Set<V>();
  map.set(key, created);
  return created;
}

function removeFromIndex<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const values = map.get(key);
  if (!values) return;
  values.delete(value);
  if (values.size === 0) map.delete(key);
}

function groupSizes(map: Map<string, Set<string>>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, ids]) => [key, ids.size]));
}

function uniqueSessions(sessions: ChatSession[]): ChatSession[] {
  return [...new Map(sessions.map((session) => [session.id, session])).values()];
}

function finitePositive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}
