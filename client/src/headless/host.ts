import { Client as ColyseusClient, type Room as ColyseusRoom } from "@colyseus/sdk";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import type { SfxPlayer } from "../audio/sfx";
import { applyServerPacket, drainAbilityQueueEvents, flushGameAuthorityCommands } from "../slice-core/gameAuthoritySystem";
import { deferInFlightAuthorityCommand, nextRuntimeAuthorityCommandIdFloor } from "../slice-core/authorityCommandSystem";
import { createPlayState, type PlayState, type ServerAuthorityViewInterestState, type SliceSnapshot } from "../slice-core/gameState";
import { updatePlayState } from "../slice-core/runtimeUpdateSystem";
import { createVerbRegistry, type VerbExecutionResult, type VerbRegistry } from "../slice-core/verbRegistry";
import {
  eventEnvelope,
  queryEnvelope,
  receiptEnvelope,
  statusEnvelope,
  type SuccessorDriverEnvelope,
  type SuccessorDriverDialogueDelivery,
  type SuccessorDriverProtocolHost,
} from "./protocol";

export interface SuccessorHeadlessHostOptions {
  endpoint: string;
  slicePath: string;
  playerId?: string;
  actorId?: string;
  displayName?: string;
  zoneId?: string;
  characterId?: string;
  ticket?: string;
  /** Standalone one-use game capability. Sent only inside the join body and
   *  cleared the moment the join request is built — never a URL, never kept. */
  gameTicket?: string;
  /** Exact release bound into a standalone game capability. */
  clientReleaseId?: string;
  /** Exact storefront Origin sent on the matchmake request and WS handshake
   *  (hosted admission policy). In-memory only; never logged or persisted. */
  origin?: string;
  spawnArea?: string;
  spawnX?: number;
  spawnY?: number;
  facing?: "front" | "right" | "back" | "left";
  tickIntervalMs?: number;
  readyTimeoutMs?: number;
  /** First command id available after restoring a persisted authority session. */
  commandIdFloor?: number;
}

export interface SuccessorHeadlessHost extends SuccessorDriverProtocolHost {
  readonly state: PlayState;
  readonly slice: SliceSnapshot;
  start(): Promise<void>;
}

type EnvelopeListener = (envelope: SuccessorDriverEnvelope) => void;

type DriverReceiptLogEntry = PlayState["serverAuthority"]["receiptLog"][number];
type DriverEventLogEntry = PlayState["serverAuthority"]["eventLog"][number];

interface ReadyGate {
  promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
}

const defaultTickIntervalMs = 16;
const defaultReadyTimeoutMs = 8_000;

export async function createSuccessorHeadlessHost(options: SuccessorHeadlessHostOptions): Promise<SuccessorHeadlessHost> {
  const slice = JSON.parse(await readFile(options.slicePath, "utf8")) as SliceSnapshot;
  return new ColyseusSuccessorHeadlessHost(slice, options);
}

/**
 * Matchmaking join payload — always the request body, never a URL. The
 * standalone `gameTicket` rides here beside the legacy `ticket` field; the
 * server's standalone mode rejects any URL-borne ticket.
 */
export function joinBodyFor(options: SuccessorHeadlessHostOptions, actorId: string): Record<string, string> {
  if (options.gameTicket) {
    if (!options.clientReleaseId) throw new Error("standalone game release id required");
    return { gameTicket: options.gameTicket, release: options.clientReleaseId };
  }
  const body: Record<string, string> = {
    playerId: options.playerId ?? actorId,
    actorId,
    displayName: options.displayName ?? "Headless Driver",
    zoneId: options.zoneId ?? "open-desert",
  };
  if (options.characterId) body.characterId = options.characterId;
  if (options.ticket) body.ticket = options.ticket;
  if (options.gameTicket) body.gameTicket = options.gameTicket;
  if (options.spawnArea) body.spawnArea = options.spawnArea;
  if (options.spawnX !== undefined) body.spawnX = String(options.spawnX);
  if (options.spawnY !== undefined) body.spawnY = String(options.spawnY);
  if (options.facing) body.facing = options.facing;
  return body;
}

class ColyseusSuccessorHeadlessHost implements SuccessorHeadlessHost {
  readonly state: PlayState;
  readonly slice: SliceSnapshot;

  private readonly registry: VerbRegistry;
  private readonly listeners = new Set<EnvelopeListener>();
  private readonly sfx = createNoopSfxPlayer();
  private readonly emittedReceiptIds = new Set<number>();
  private readonly emittedEventIds = new Set<string>();
  private readonly emittedDialogueIds = new Set<string>();
  private room: ColyseusRoom | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private lastTickAtMs = 0;
  private started = false;
  private closed = false;
  private readyGate: ReadyGate | null = null;
  private readyTimer: NodeJS.Timeout | null = null;

  constructor(slice: SliceSnapshot, private readonly options: SuccessorHeadlessHostOptions) {
    this.slice = slice;
    const commandIdFloor = Number.isFinite(options.commandIdFloor)
      ? Math.max(1, Math.trunc(options.commandIdFloor!))
      : nextRuntimeAuthorityCommandIdFloor();
    this.state = createPlayState(
      slice,
      options.actorId,
      commandIdFloor,
    );
    this.registry = createVerbRegistry({ state: this.state, slice: this.slice });
  }

  onEnvelope(listener: EnvelopeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.emit(statusEnvelope("booting", { data: { slicePath: this.options.slicePath } }));
    this.emit(statusEnvelope("connecting", { data: { endpoint: this.options.endpoint, actorId: this.actorId() } }));

    const readyGate = Promise.withResolvers<void>();
    this.readyGate = readyGate;
    this.readyTimer = setTimeout(() => {
      readyGate.reject(new Error(`timed out waiting for game.hello from ${this.options.endpoint}`));
    }, this.options.readyTimeoutMs ?? defaultReadyTimeoutMs);

    try {
      const client = new ColyseusClient(
        this.options.endpoint,
        this.options.origin ? { headers: { Origin: this.options.origin } } : undefined,
      );
      const joinBody = joinBodyFor(this.options, this.actorId());
      // one-use standalone capability: cleared before the request settles
      this.options.gameTicket = undefined;
      const room = await client.joinOrCreate("game", joinBody);
      if (this.closed) {
        await room.leave(true);
        return;
      }
      this.room = room;
      this.state.serverAuthority.connected = true;
      this.state.serverAuthority.status = "connected";
      this.state.serverAuthority.wsUrl = this.options.endpoint;
      this.installRoomHandlers(room);
      room.send("game.ready", this.initialViewInterest());
      await readyGate.promise;
      this.startTickLoop();
      this.emit(statusEnvelope("ready", {
        data: {
          endpoint: this.options.endpoint,
          actorId: this.state.serverAuthority.playerActorId ?? this.actorId(),
          sessionId: this.state.serverAuthority.sessionId,
        },
      }));
    } catch (error) {
      this.emit(statusEnvelope("error", { message: errorMessage(error) }));
      await this.close();
      throw error;
    } finally {
      clearTimeout(this.readyTimer ?? undefined);
      this.readyTimer = null;
      this.readyGate = null;
    }
  }

  async handleVerb(line: string): Promise<readonly SuccessorDriverEnvelope[]> {
    if (!this.isReady()) {
      return [statusEnvelope("not_ready", { message: "headless host is not connected" })];
    }
    return this.executeLine(line, false);
  }

  async handleQuery(line: string): Promise<readonly SuccessorDriverEnvelope[]> {
    if (!this.isReady()) {
      return [statusEnvelope("not_ready", { message: "headless host is not connected" })];
    }
    return this.executeLine(normalizeDriverQueryLine(line), true);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.tickTimer ?? undefined);
    this.tickTimer = null;
    clearTimeout(this.readyTimer ?? undefined);
    this.readyTimer = null;
    if (this.readyGate) {
      // nobody awaits the gate on the join-failure path; keep the rejection handled
      this.readyGate.promise.catch(() => {});
      this.readyGate.reject(new Error("headless host closed"));
    }
    const room = this.room;
    if (room) this.releaseAuthorityRoom(room, "disconnected");
    else deferInFlightAuthorityCommand(this.state.authorityCommands);
    if (room) await room.leave(true);
    this.emit(statusEnvelope("closed"));
  }

  private installRoomHandlers(room: ColyseusRoom): void {
    room.onMessage("game.packet", (packet) => {
      this.applyPacket(packet);
    });
    room.onMessage("surveyResult", (payload) => {
      this.state.serverAuthority.surveyResults.push(payload as PlayState["serverAuthority"]["surveyResults"][number]);
      if (this.state.serverAuthority.surveyResults.length > 8) {
        this.state.serverAuthority.surveyResults.splice(0, this.state.serverAuthority.surveyResults.length - 8);
      }
      this.emit(eventEnvelope("survey_result", { data: { payload: sanitizeDriverData(payload) } }));
    });
    room.onMessage("craftSession", (payload) => {
      this.state.serverAuthority.craftSession = payload as PlayState["serverAuthority"]["craftSession"];
      this.emit(eventEnvelope("craft_session", { data: { payload: sanitizeDriverData(payload) } }));
    });
    room.onMessage("spliceSession", (payload) => {
      this.state.serverAuthority.spliceSession = payload as PlayState["serverAuthority"]["spliceSession"];
      this.emit(eventEnvelope("splice_session", { data: { payload: sanitizeDriverData(payload) } }));
    });
    room.onMessage("genomeScan", (payload) => {
      this.state.serverAuthority.genomeScan = payload as PlayState["serverAuthority"]["genomeScan"];
      this.emit(eventEnvelope("genome_scan", { data: { payload: sanitizeDriverData(payload) } }));
    });
    room.onMessage("tradeSession", (payload) => {
      this.state.serverAuthority.tradeSession = payload as PlayState["serverAuthority"]["tradeSession"];
      this.emit(eventEnvelope("trade_session", { data: { payload: sanitizeDriverData(payload) } }));
    });
    room.onMessage("duelOutcome", (payload) => {
      const queue = this.state.serverAuthority.duelOutcomes;
      queue.push(payload as PlayState["serverAuthority"]["duelOutcomes"][number]);
      if (queue.length > 16) queue.splice(0, queue.length - 16);
      this.emit(eventEnvelope("duel_outcome", { data: { payload: sanitizeDriverData(payload) } }));
    });
    room.onLeave((code, reason) => {
      if (this.closed || !this.releaseAuthorityRoom(room, "disconnected")) return;
      this.emit(statusEnvelope("disconnected", { data: { code, reason } }));
    });
    room.onError((code, message) => {
      if (!this.releaseAuthorityRoom(room, "error")) return;
      void room.leave(true).catch(() => undefined);
      this.emit(statusEnvelope("error", { message: message ?? `room error ${code}`, data: { code } }));
    });
  }

  /** Preserve unsettled work before detaching this host from an authority room. */
  private releaseAuthorityRoom(room: ColyseusRoom, status: "disconnected" | "error"): boolean {
    if (this.room !== room) return false;
    deferInFlightAuthorityCommand(this.state.authorityCommands);
    this.room = null;
    this.state.serverAuthority.connected = false;
    this.state.serverAuthority.status = status;
    this.state.serverAuthority.sessionId = null;
    this.state.serverAuthority.sourceStateHash = null;
    this.state.serverAuthority.sourceActorCount = null;
    this.state.serverAuthority.sourceMatchesClient = null;
    this.state.serverAuthority.playerActorId = null;
    this.state.serverAuthority.inFlightMoves = [];
    return true;
  }

  private applyPacket(packet: unknown): void {
    const packetType = isRecord(packet) && typeof packet.type === "string" ? packet.type : "unknown";
    try {
      applyServerPacket(this.state, this.slice, packet as never, this.sfx);
      this.emitDialogueDeliveries(packet);
      // A receipt settles the single in-flight envelope. Flush immediately so
      // a same-tick pending command cannot wait behind the next timer turn.
      this.flushCommands();
      this.drainObservations();
      if (packetType === "game.hello") this.readyGate?.resolve();
    } catch (error) {
      this.state.serverAuthority.status = "error";
      this.emit(statusEnvelope("error", { message: errorMessage(error), data: { packetType } }));
      this.readyGate?.reject(error);
    }
  }

  private emitDialogueDeliveries(packet: unknown): void {
    const delta = isRecord(packet) && isRecord(packet.delta) ? packet.delta : null;
    const deliveries = delta && Array.isArray(delta.dialogueDeliveries) ? delta.dialogueDeliveries : [];
    for (const raw of deliveries) {
      const delivery = normalizeDialogueDelivery(raw);
      if (!delivery) continue;
      const key = dialogueDeliveryKey(delivery);
      if (this.emittedDialogueIds.has(key)) continue;
      this.emittedDialogueIds.add(key);
      this.emit(eventEnvelope("dialogue", { data: { delivery } }));
    }
    pruneStringSet(this.emittedDialogueIds, 512);
  }

  private executeLine(line: string, queryOnly: boolean): readonly SuccessorDriverEnvelope[] {
    const result = this.registry.executeLine(line);
    if (!result) {
      return [statusEnvelope(queryOnly ? "unknown_query" : "unknown_verb", { data: { line } })];
    }
    if (queryOnly && result.class !== "query") {
      return [statusEnvelope("not_a_query", { data: { line, class: result.class } })];
    }
    if (result.class === "query") return [queryEnvelopeFromResult(line, result)];
    if (result.class === "local") {
      return [eventEnvelope("verb", { line, data: { result: sanitizeDriverData(result) } })];
    }

    const data = result.data;
    if (data.queued === true && typeof data.commandId === "number") {
      const flushed = this.flushCommands();
      return [eventEnvelope("authority_queued", {
        line,
        data: {
          commandId: data.commandId,
          commandKind: typeof data.commandKind === "string" ? data.commandKind : undefined,
          flushed,
          result: sanitizeDriverData(result),
        },
      })];
    }

    return [statusEnvelope("verb_rejected", {
      message: typeof data.error === "string" ? data.error : undefined,
      data: { line, result: sanitizeDriverData(result) },
    })];
  }

  private startTickLoop(): void {
    this.lastTickAtMs = performance.now();
    // Commands may be submitted immediately after start() resolves, before
    // the first interval callback. Keep their sentAtMs on the same monotonic
    // clock as later ticks so they cannot appear instantly stale from the
    // createPlayState() default of zero.
    this.state.worldTimeMs = this.lastTickAtMs;
    this.tickTimer = setInterval(() => this.tick(), this.options.tickIntervalMs ?? defaultTickIntervalMs);
  }

  private tick(): void {
    if (this.closed) return;
    const now = performance.now();
    const dtMs = Math.max(0, Math.min(100, now - this.lastTickAtMs));
    this.lastTickAtMs = now;
    try {
      updatePlayState(this.state, this.slice, dtMs, now, this.sfx);
      this.flushCommands();
      this.drainObservations();
    } catch (error) {
      this.emit(statusEnvelope("error", { message: errorMessage(error) }));
    }
  }

  private flushCommands(): number {
    if (!this.room) return 0;
    return flushGameAuthorityCommands(this.state, this.room);
  }

  private drainObservations(): void {
    for (const receipt of this.state.serverAuthority.receiptLog) {
      if (this.emittedReceiptIds.has(receipt.commandId)) continue;
      this.emittedReceiptIds.add(receipt.commandId);
      this.emit(receiptEnvelopeFromLog(this.state, receipt));
    }
    pruneNumberSet(this.emittedReceiptIds, 512);

    for (const event of this.state.serverAuthority.eventLog) {
      const key = eventLogKey(event);
      if (this.emittedEventIds.has(key)) continue;
      this.emittedEventIds.add(key);
      this.emit(eventEnvelope("combat", { data: { event: sanitizeDriverData(event) } }));
    }
    pruneStringSet(this.emittedEventIds, 512);

    for (const event of drainAbilityQueueEvents(this.state)) {
      this.emit(eventEnvelope("ability_queue", { data: { event: sanitizeDriverData(event) } }));
    }
  }


  private initialViewInterest(): ServerAuthorityViewInterestState {
    return {
      area_id: this.state.activeAreaId,
      viewport_width_cells: 160,
      viewport_height_cells: 120,
      margin_cells: 64,
      center_actor_id: this.actorId(),
    };
  }

  private actorId(): string {
    return this.options.actorId ?? this.options.playerId ?? "headless-driver";
  }

  private isReady(): boolean {
    return Boolean(this.room && this.state.serverAuthority.connected && this.state.serverAuthority.sessionId);
  }

  private emit(envelope: SuccessorDriverEnvelope): void {
    for (const listener of this.listeners) listener(envelope);
  }
}

function queryEnvelopeFromResult(line: string, result: VerbExecutionResult): SuccessorDriverEnvelope {
  return queryEnvelope({
    line,
    verb: result.verb,
    text: result.text,
    data: sanitizeDriverData(result.data),
  });
}

function receiptEnvelopeFromLog(state: PlayState, receipt: DriverReceiptLogEntry): SuccessorDriverEnvelope {
  const sent = state.serverAuthority.sentCommandLog.find((entry) => entry.commandId === receipt.commandId);
  return receiptEnvelope({
    commandId: receipt.commandId,
    accepted: receipt.accepted,
    tick: receipt.tick,
    ...(receipt.reasonCode ? { reasonCode: receipt.reasonCode } : {}),
    ...(sent?.kind ? { commandKind: sent.kind } : {}),
  });
}

function eventLogKey(event: DriverEventLogEntry): string {
  const candidate = isRecord(event) ? event.id : null;
  return candidate === null || candidate === undefined ? JSON.stringify(event) : String(candidate);
}

function normalizeDriverQueryLine(line: string): string {
  const trimmed = line.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function createNoopSfxPlayer(): SfxPlayer {
  return {
    probe: {
      ready: true,
      unlocked: false,
      clipCount: 0,
      lastPlayed: null,
      listener: null,
      lastDistanceCells: null,
      lastPan: 0,
      lastGain: 1,
      errors: [],
      activeLoops: [],
      recentPlayed: [],
    },
    load: async () => {},
    setListenerPosition: () => {},
    play: () => {},
    playAt: () => {},
    setLoop: () => {},
    stopLoop: () => {},
    stopAllLoops: () => {},
  };
}

export function normalizeDialogueDelivery(value: unknown): SuccessorDriverDialogueDelivery | null {
  if (!isRecord(value)) return null;
  if (typeof value.actorId !== "string" || !value.actorId.trim()) return null;
  if (typeof value.speaker !== "string" || !value.speaker.trim()) return null;
  if (typeof value.body !== "string" || !value.body.trim()) return null;
  return {
    actorId: value.actorId,
    speaker: value.speaker,
    body: value.body,
    ...(typeof value.areaId === "string" ? { areaId: value.areaId } : {}),
    ...(Number.isFinite(value.x) ? { x: Number(value.x) } : {}),
    ...(Number.isFinite(value.y) ? { y: Number(value.y) } : {}),
    ...(Number.isFinite(value.tick) ? { tick: Number(value.tick) } : {}),
  };
}

function dialogueDeliveryKey(delivery: SuccessorDriverDialogueDelivery): string {
  return JSON.stringify([
    delivery.actorId,
    delivery.speaker,
    delivery.body,
    delivery.areaId ?? null,
    delivery.x ?? null,
    delivery.y ?? null,
    delivery.tick ?? null,
  ]);
}

function sanitizeDriverData(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  return { value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pruneNumberSet(values: Set<number>, limit: number): void {
  while (values.size > limit) values.delete(values.values().next().value as number);
}

function pruneStringSet(values: Set<string>, limit: number): void {
  while (values.size > limit) values.delete(values.values().next().value as string);
}
