import { Room, type Client } from "@colyseus/core";

import { pendingFirstEntryCommit, resolveLaunchTicketIdentity, type LaunchTicketPlayer } from "../auth/tickets.js";
import { redeemStandaloneLaunch, type StandaloneLaunchStore } from "../auth/standalone.js";
import type { LaunchSessionRevocationSink, RuntimeAuthConfig } from "../auth/runtime.js";
import {
  characterAppearanceToActorAppearance,
  characterWornToActorWorn,
  normalizeCharacterName,
  normalizeInitialProfessionId,
  normalizeOwnerRef,
  type CharacterRecord,
  type CharacterStore,
} from "./characterStore.js";
import { characterAuthoritySeed } from "./characterAuthoritySeed.js";
import { GameShard, type GameSessionIdentity, type GameSocket } from "./shard.js";
import { gameClientViewSchema, type GameClientView } from "./protocol.js";
import {
  bugReportSubmissionSchema,
  type BugReportWriter,
} from "../support/bugReports.js";

const colyseusOpenState = 1;
const colyseusClosedState = 3;

interface SuccessorGameRoomOptions {
  shard: GameShard;
  characterStore: CharacterStore;
  maxClients?: number;
  runtimeAuth?: RuntimeAuthConfig;
  sessionRevocations?: LaunchSessionRevocationSink;
  controlStore?: StandaloneLaunchStore & Partial<BugReportWriter>;
}

type SuccessorGameClient = Client<{
  messages: {
    "game.packet": unknown;
    surveyResult: unknown;
    exit_world: unknown;
    bugReportResult: unknown;
  };
}>;

export class SuccessorGameRoom extends Room<{ client: SuccessorGameClient }> {
  private shard!: GameShard;
  private readonly sockets = new Map<string, ColyseusGameSocket>();
  private readonly identities = new Map<string, GameSessionIdentity>();
  private readonly connectedSessions = new Set<string>();
  private readonly pendingViews = new Map<string, GameClientView>();
  private readonly pendingReadyViews = new Map<string, GameClientView>();
  private readonly pendingReadySessions = new Set<string>();
  private characterStore!: CharacterStore;
  private runtimeAuth?: RuntimeAuthConfig;
  private sessionRevocations?: LaunchSessionRevocationSink;
  private controlStore?: StandaloneLaunchStore & Partial<BugReportWriter>;
  private readonly bugReportRates = new Map<string, { count: number; resetAt: number }>();

  onCreate(options: SuccessorGameRoomOptions): void {
    this.shard = options.shard;
    this.characterStore = options.characterStore;
    this.runtimeAuth = options.runtimeAuth;
    this.sessionRevocations = options.sessionRevocations;
    this.controlStore = options.controlStore;
    this.maxClients = options.maxClients ?? 1_200;
    this.autoDispose = false;
    this.patchRate = null;
    this.onMessage("game.ready", (client, payload) => {
      const view = viewFromPayload(payload);
      this.pendingReadySessions.add(client.sessionId);
      if (view) this.pendingViews.set(client.sessionId, view);
      this.connectClient(client, view ?? this.pendingViews.get(client.sessionId));
    });
    this.onMessage("game.command", (client, payload) => {
      this.sockets.get(client.sessionId)?.emitMessage(JSON.stringify({
        type: "game.command",
        envelope: payload,
      }));
    });
    this.onMessage("game.view", (client, payload) => {
      const view = viewFromPayload(payload);
      if (!view) return;
      if (!this.connectedSessions.has(client.sessionId)) {
        this.pendingViews.set(client.sessionId, view);
        return;
      }
      this.sockets.get(client.sessionId)?.emitMessage(JSON.stringify({
        type: "game.view",
        view,
      }));
    });
    this.onMessage("exit_world", (client) => {
      this.sockets.get(client.sessionId)?.emitMessage(JSON.stringify({ type: "exit_world" }));
    });
    this.onMessage("support.bug-report", (client, payload) => {
      this.receiveBugReport(client, payload);
    });
    this.onMessage("ping", (client, payload) => {
      this.sockets.get(client.sessionId)?.emitMessage(JSON.stringify({
        type: "ping",
        ...(isRecord(payload) ? payload : {}),
      }));
    });
  }

  async onJoin(client: SuccessorGameClient, options: unknown, auth?: unknown): Promise<void> {
    try {
      this.identities.set(client.sessionId, await identityFromOptions(options, this.characterStore, {
        isCharacterIdReserved: (characterId) => this.shard.isReservedCharacterId(characterId),
      }, { runtimeAuth: this.runtimeAuth, sessionRevocations: this.sessionRevocations, controlStore: this.controlStore, authenticatedIdentity: isGameSessionIdentity(auth) ? auth : undefined }));
      this.sockets.set(client.sessionId, new ColyseusGameSocket(client));
      if (this.pendingReadySessions.has(client.sessionId)) {
        this.connectClient(client, this.pendingReadyViews.get(client.sessionId) ?? this.pendingViews.get(client.sessionId));
      }
    } catch (error) {
      if (error instanceof GameJoinRejectedError) client.leave(error.closeCode, error.message);
      throw error;
    }
  }

  onLeave(client: SuccessorGameClient): void {
    const socket = this.sockets.get(client.sessionId);
    this.connectedSessions.delete(client.sessionId);
    this.pendingReadySessions.delete(client.sessionId);
    this.pendingReadyViews.delete(client.sessionId);
    this.identities.delete(client.sessionId);
    this.sockets.delete(client.sessionId);
    this.pendingViews.delete(client.sessionId);
    if (!socket) return;
    socket.emitClose();
  }

  onDispose(): void {
    for (const socket of this.sockets.values()) socket.emitClose();
    this.sockets.clear();
    this.identities.clear();
    this.pendingViews.clear();
    this.pendingReadyViews.clear();
    this.pendingReadySessions.clear();
    this.connectedSessions.clear();
    this.bugReportRates.clear();
  }

  private connectClient(client: SuccessorGameClient, initialView?: GameClientView): void {
    if (this.connectedSessions.has(client.sessionId)) return;
    const socket = this.sockets.get(client.sessionId);
    const identity = this.identities.get(client.sessionId);
    if (!socket || !identity) {
      if (initialView) this.pendingReadyViews.set(client.sessionId, initialView);
      return;
    }
    this.pendingReadyViews.delete(client.sessionId);
    this.pendingViews.delete(client.sessionId);
    this.pendingReadySessions.delete(client.sessionId);
    try {
      this.shard.connect(socket, identity, initialView);
      this.connectedSessions.add(client.sessionId);
    } catch (error) {
      socket.close(1011, error instanceof Error ? error.message : "failed to join game shard");
    }
  }

  private receiveBugReport(client: SuccessorGameClient, payload: unknown): void {
    const requestId = isRecord(payload) && typeof payload.requestId === "string"
      ? payload.requestId.slice(0, 64)
      : "";
    const reject = (reasonCode: "invalid_report" | "rate_limited" | "unavailable"): void => {
      client.send("bugReportResult", {
        schema: "successor.bug-report-result.v1",
        requestId,
        status: "rejected",
        reasonCode,
      });
    };
    const parsed = bugReportSubmissionSchema.safeParse(payload);
    if (!parsed.success) {
      reject("invalid_report");
      return;
    }
    const identity = this.identities.get(client.sessionId);
    const writer = this.controlStore?.createBugReport;
    if (
      !identity
      || !this.connectedSessions.has(client.sessionId)
      || this.runtimeAuth?.mode !== "standalone"
      || typeof writer !== "function"
    ) {
      reject("unavailable");
      return;
    }
    const now = Date.now();
    const rateKey = identity.launchProvenance?.accountId ?? identity.ownerRef ?? client.sessionId;
    const rate = this.bugReportRates.get(rateKey);
    if (!rate || rate.resetAt <= now) {
      this.bugReportRates.set(rateKey, { count: 1, resetAt: now + 60_000 });
    } else {
      rate.count += 1;
      if (rate.count > 5) {
        reject("rate_limited");
        return;
      }
    }
    if (this.bugReportRates.size > 10_000) {
      for (const [key, entry] of this.bugReportRates) {
        if (entry.resetAt <= now) this.bugReportRates.delete(key);
      }
    }
    try {
      const stored = writer.call(this.controlStore, {
        requestId: parsed.data.requestId,
        accountId: identity.launchProvenance?.accountId,
        ownerRef: identity.ownerRef ?? identity.playerId,
        characterId: identity.characterId ?? identity.actorId,
        launchId: identity.launchProvenance?.launchId,
        shardId: this.runtimeAuth.shardId,
        clientReleaseId: this.runtimeAuth.clientReleaseId,
        serverReleaseId: this.runtimeAuth.serverReleaseId,
        category: parsed.data.category,
        body: parsed.data.body,
        diagnostics: parsed.data.diagnostics,
      });
      client.send("bugReportResult", {
        schema: "successor.bug-report-result.v1",
        requestId: parsed.data.requestId,
        status: "accepted",
        reportId: stored.reportId,
        receivedAt: stored.createdAt,
      });
    } catch {
      reject("unavailable");
    }
  }
}

function viewFromPayload(payload: unknown): GameClientView | undefined {
  const parsed = gameClientViewSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

interface ColyseusTransportRef {
  readonly bufferedAmount?: unknown;
}

class ColyseusGameSocket implements GameSocket {
  private readonly messageListeners: Array<(data: unknown) => void> = [];
  private readonly closeListeners: Array<() => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private closed = false;
  // Colyseus types `ref` as EventEmitter; ws-transport supplies the raw WebSocket here.
  private readonly transportRef: ColyseusTransportRef;

  constructor(private readonly client: SuccessorGameClient) {
    this.transportRef = client.ref as unknown as ColyseusTransportRef;
  }

  get readyState(): number {
    return this.closed ? colyseusClosedState : colyseusOpenState;
  }

  get bufferedAmount(): number {
    const bufferedAmount = this.transportRef.bufferedAmount;
    return typeof bufferedAmount === "number" && Number.isFinite(bufferedAmount) && bufferedAmount >= 0
      ? Math.floor(bufferedAmount)
      : 0;
  }

  send(data: string): void {
    if (this.closed) return;
    try {
      this.client.send("game.packet", JSON.parse(data) as unknown);
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error("failed to send Colyseus game packet"));
    }
  }

  sendMessage(type: string, data: unknown): void {
    if (this.closed) return;
    try {
      this.client.send(type as "surveyResult", data);
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(`failed to send Colyseus ${type} message`));
    }
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.client.leave(code, reason);
    this.emitClose();
  }

  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "message" | "close" | "error", listener: ((data: unknown) => void) | (() => void) | ((error: Error) => void)): void {
    if (event === "message") {
      this.messageListeners.push(listener as (data: unknown) => void);
      return;
    }
    if (event === "close") {
      this.closeListeners.push(listener as () => void);
      return;
    }
    this.errorListeners.push(listener as (error: Error) => void);
  }

  emitMessage(data: unknown): void {
    if (this.closed) return;
    for (const listener of this.messageListeners) listener(data);
  }

  emitClose(): void {
    if (!this.closed) this.closed = true;
    for (const listener of this.closeListeners) listener();
  }

  private emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

export class GameJoinRejectedError extends Error {
  constructor(readonly closeCode: number, message: string) {
    super(message);
    this.name = "GameJoinRejectedError";
  }
}

export interface GameCharacterIdentityPolicy {
  isCharacterIdReserved?(characterId: string): boolean;
}

export interface GameIdentityAuthOptions {
  runtimeAuth?: RuntimeAuthConfig;
  sessionRevocations?: LaunchSessionRevocationSink;
  controlStore?: StandaloneLaunchStore;
  authenticatedIdentity?: GameSessionIdentity;
}

export async function identityFromOptions(
  options: unknown,
  characterStore: CharacterStore,
  policy: GameCharacterIdentityPolicy = {},
  auth: GameIdentityAuthOptions = {},
): Promise<GameSessionIdentity> {
  const query = isRecord(options) ? stringRecord(options) : {};
  const standaloneToken = query.gameTicket?.trim();
  const standaloneRelease = query.release?.trim();
  if (auth.runtimeAuth?.mode === "standalone") {
    if (query.ticket?.trim()) rejectJoin("launch ticket must be in join body");
    if (auth.authenticatedIdentity) {
      const characterId = auth.authenticatedIdentity.characterId;
      const ownerRef = auth.authenticatedIdentity.ownerRef;
      if (!characterId || !ownerRef) rejectJoin("invalid game ticket");
      if (policy.isCharacterIdReserved?.(characterId)) rejectJoin("character id collides with authored actor");
      const character = characterStore.get(characterId, ownerRef);
      if (!character) rejectJoin("invalid game ticket character");
      requireInitialProfessionForFirstEntry(character);
      return auth.authenticatedIdentity;
    }
    if (!standaloneToken || !standaloneRelease) rejectJoin("game ticket and release required");
    try {
      const identity = await redeemStandaloneLaunch(standaloneToken, "game", auth.controlStore!, characterStore, auth.runtimeAuth, policy.isCharacterIdReserved, standaloneRelease);
      const character = characterStore.get(identity.characterId, identity.ownerRef);
      if (!character) rejectJoin("invalid game ticket character");
      requireInitialProfessionForFirstEntry(character);
      return identity;
    } catch (error) {
      if (error instanceof GameJoinRejectedError) throw error;
      rejectJoin("invalid game ticket");
    }
  }
  const ticket = query.ticket?.trim();
  if (ticket) {
    const ticketIdentity = await resolveLaunchTicketIdentity(ticket);
    if (!ticketIdentity) rejectJoin("invalid launch ticket");
    if (!ticketIdentity.entitlement.access) rejectJoin("subscription required");
    const hostedFirstEntryCommit = pendingFirstEntryCommit(ticketIdentity);
    if ((ticketIdentity.firstEntry?.status === "pending" || ticketIdentity.firstEntry?.status === "entered") && !hostedFirstEntryCommit) rejectJoin("invalid first-entry contract");
    const character = loadTicketCharacter(characterStore, ticketIdentity.player, policy);
    requireInitialProfessionForFirstEntry(character);
    const authoritySeed = characterAuthoritySeed(character);
    return {
      actorId: character.id,
      playerId: character.ownerRef,
      ownerRef: character.ownerRef,
      displayName: character.name,
      zoneId: ticketIdentity.zoneId,
      characterId: character.id,
      returningCharacter: character.worldEntryClaimed,
      entitlement: ticketIdentity.entitlement,
      pendingFirstEntryCommit: hostedFirstEntryCommit,
      appearance: characterAppearanceToActorAppearance(character.appearance),
      worn: characterWornToActorWorn(character.worn),
      wornColors: cloneWornColors(character.wornColors),
      ...authoritySeed,
      activeTitleId: character.activeTitleId,
      careerGoalId: character.careerGoalId,
      vitals: character.vitals ? { ...character.vitals } : undefined,
      spawn: character.position ? {
        areaId: character.position.areaId,
        x: character.position.x,
        y: character.position.y,
        facing: character.position.facing,
      } : undefined,
    };
  }

  const characterId = normalizeActorId(query.characterId ?? "");
  if (characterId) {
    if (!devIdentityAllowed()) rejectJoin("dev identity disabled: a session ticket is required");
    if (policy.isCharacterIdReserved?.(characterId)) rejectJoin("character id collides with authored actor");
    const storedCharacter = characterStore.get(characterId);
    if (!storedCharacter) rejectJoin("invalid characterId");
    const character = storedCharacter;
    requireInitialProfessionForFirstEntry(character);
    const querySpawn = spawnFromQuery(query);
    const authoritySeed = characterAuthoritySeed(character);
    return {
      actorId: character.id,
      playerId: character.ownerRef,
      displayName: character.name,
      zoneId: normalizeActorId(query.zoneId ?? query.zone ?? "open-desert") || "open-desert",
      characterId: character.id,
      // A fresh dev fixture with an explicit query spawn must keep that authored
      // position. Omit the exact-false production shelter signal; checkpointed
      // first-entry completion still claims the CharacterStore row after join.
      ...(querySpawn && !character.worldEntryClaimed
        ? {}
        : { returningCharacter: character.worldEntryClaimed }),
      ownerRef: character.ownerRef,
      appearance: characterAppearanceToActorAppearance(character.appearance),
      worn: characterWornToActorWorn(character.worn),
      wornColors: cloneWornColors(character.wornColors),
      ...authoritySeed,
      activeTitleId: character.activeTitleId,
      careerGoalId: character.careerGoalId,
      vitals: character.vitals ? { ...character.vitals } : undefined,
      spawn: querySpawn ?? (character.position ? {
        areaId: character.position.areaId,
        x: character.position.x,
        y: character.position.y,
        facing: character.position.facing,
      } : undefined),
    };
  }

  if (!devIdentityAllowed()) rejectJoin("dev identity disabled: a session ticket is required");
  const playerId = normalizeActorId(query.playerId ?? query.userId ?? "");
  if (!playerId) rejectJoin("playerId required");
  const actorId = normalizeActorId(query.actorId ?? playerId);
  if (characterStore.hasId(actorId)) rejectJoin("durable character identity required");
  if (policy.isCharacterIdReserved?.(actorId)) rejectJoin("character id collides with authored actor");
  return {
    actorId,
    playerId,
    displayName: normalizeDisplayName(query.displayName ?? query.name ?? "", playerId),
    zoneId: normalizeActorId(query.zoneId ?? query.zone ?? "open-desert") || "open-desert",
    spawn: spawnFromQuery(query),
  };
}

function loadTicketCharacter(
  characterStore: CharacterStore,
  player: LaunchTicketPlayer,
  policy: GameCharacterIdentityPolicy,
): CharacterRecord {
  const rawCharacterId = player.characterId.trim();
  const characterId = normalizeActorId(rawCharacterId);
  if (!characterId || characterId !== rawCharacterId.toLowerCase()) rejectJoin("invalid ticket character");
  if (policy.isCharacterIdReserved?.(characterId)) rejectJoin("character id collides with authored actor");
  const rawOwnerRef = player.profileId.trim();
  const ownerRef = normalizeOwnerRef(rawOwnerRef);
  if (ownerRef !== rawOwnerRef) rejectJoin("invalid ticket profile");
  const initialProfessionId = normalizeInitialProfessionId(player.initialProfessionId);
  if (!initialProfessionId) rejectJoin("initial profession selection required");
  const displayName = normalizeCharacterName(player.displayName);
  if (!displayName) rejectJoin("invalid ticket character: invalid_name");
  const existing = characterStore.get(characterId, ownerRef);
  if (!existing) rejectJoin("ticket character not found");
  if (existing.name !== displayName || existing.initialProfessionId !== initialProfessionId) {
    rejectJoin("ticket character mismatch");
  }
  return existing;
}

function requireInitialProfessionForFirstEntry(character: CharacterRecord): void {
  if (!character.worldEntryClaimed && character.initialProfessionId === null) {
    rejectJoin("initial profession selection required");
  }
}

function cloneWornColors(value: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(value).map(([item, colors]) => [item, [...colors]]));
}

function rejectJoin(message: string): never {
  throw new GameJoinRejectedError(1008, message);
}
function spawnFromQuery(query: Record<string, string | undefined>): GameSessionIdentity["spawn"] {
  const x = numberFromQuery(query.spawnX);
  const y = numberFromQuery(query.spawnY);
  const facing = normalizeDirection(query.facing);
  if (!query.spawnArea && x === undefined && y === undefined && !facing) return undefined;
  return {
    areaId: query.spawnArea,
    x,
    y,
    facing,
  };
}

function stringRecord(values: Record<string, unknown>): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value === undefined ? undefined : String(value)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGameSessionIdentity(value: unknown): value is GameSessionIdentity {
  return isRecord(value) && typeof value.actorId === "string" && typeof value.playerId === "string" && typeof value.displayName === "string" && typeof value.zoneId === "string";
}

/**
 * Whether browser-chosen (query-param / direct-characterId) identity is allowed.
 * Defaults ON only for local dev/harness: non-production with no ComPress site
 * URL configured. Production and any networked SUCCESSOR_SITE_URL deploys
 * fail closed unless GAME_ALLOW_DEV_IDENTITY explicitly opts in.
 */
export function devIdentityAllowed(): boolean {
  const raw = process.env.GAME_ALLOW_DEV_IDENTITY?.trim().toLowerCase();
  if (raw) return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
  if (raw === "") return defaultDevIdentityAllowed();
  return defaultDevIdentityAllowed();
}

function defaultDevIdentityAllowed(): boolean {
  return process.env.NODE_ENV !== "production" && !process.env.SUCCESSOR_SITE_URL?.trim();
}

function numberFromQuery(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeActorId(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
}

function normalizeDisplayName(value: string, fallback: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .slice(0, 32) || fallback || "Guest";
}

function normalizeDirection(value: string | undefined): "front" | "right" | "back" | "left" | undefined {
  if (value === "front" || value === "right" || value === "back" || value === "left") return value;
  return undefined;
}
