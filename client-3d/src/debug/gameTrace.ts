import {
  authorityCommandKind,
  type AuthorityClientCommand,
  type AuthorityClientCommandEnvelope,
  type AuthorityClientCommandKind,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import type {
  PlayState,
  ServerAuthorityActorState,
  ServerAuthorityCombatEventState,
  ServerAuthorityStatusState,
} from "@successor/client/src/slice-core/gameState";

const GAME_TRACE_SCHEMA = "successor.game-trace.v1";
const GAME_TRACE_RING_CAP = 4096;
const SNAPSHOT_INTERVAL_MS = 1_000;

type GameTraceSchema = typeof GAME_TRACE_SCHEMA;
type GameTraceKind =
  | "lifecycle"
  | "command-enqueued"
  | "command-acked"
  | "combat-event"
  | "status-inserted"
  | "player-snapshot";

export interface SuccessorGameTraceRecord {
  schema: GameTraceSchema;
  seq: number;
  tMs: number;
  wallTimeMs: number;
  kind: GameTraceKind;
  snapshotTick: number;
  sessionId: string | null;
  actorId: string | null;
  [key: string]: unknown;
}

export interface SuccessorGameTraceProbe {
  readonly enabled: boolean;
  readonly schema: GameTraceSchema;
  readonly capacity: number;
  readonly count: number;
  /** Return oldest→newest entries and clear the ring. */
  drain(): SuccessorGameTraceRecord[];
  /** Return oldest→newest entries without clearing. */
  peek(): SuccessorGameTraceRecord[];
  clear(): void;
}

export interface SuccessorGameTraceController {
  readonly enabled: boolean;
  sample(state: PlayState, timeMs: number): void;
  dispose(): void;
}

declare global {
  interface Window {
    __successorGameTrace?: SuccessorGameTraceProbe;
  }
}

class BrowserSuccessorGameTrace implements SuccessorGameTraceProbe, SuccessorGameTraceController {
  readonly enabled = true;
  readonly schema = GAME_TRACE_SCHEMA;
  readonly capacity = GAME_TRACE_RING_CAP;
  private readonly ring: SuccessorGameTraceRecord[] = [];
  private readonly seenCommandIds = new Set<number>();
  private readonly seenReceiptCommandIds = new Set<number>();
  private readonly seenCombatEventIds = new Set<number>();
  private readonly seenStatusKeys = new Set<string>();
  private readonly currentStatusKeys = new Set<string>();
  private head = 0;
  private writtenCount = 0;
  private nextSeq = 1;
  private lastSnapshotAtMs = Number.NEGATIVE_INFINITY;
  private lastAreaId: string | null = null;
  private lastSessionId: string | null = null;
  private lastServerStatus: string | null = null;
  private lastConnected: boolean | null = null;
  private statusSeeded = false;
  private lifecycleSeeded = false;

  get count(): number {
    return Math.min(this.writtenCount, this.capacity);
  }

  sample(state: PlayState, timeMs: number): void {
    const actorId = state.serverAuthority.playerActorId ?? state.playerActorId ?? null;
    this.recordLifecycleChanges(state, timeMs, actorId);
    this.recordCommandEnqueues(state, timeMs, actorId);
    this.recordCommandAcks(state, timeMs, actorId);
    this.recordCombatEvents(state, timeMs, actorId);
    this.recordStatusInsertions(state, timeMs, actorId);
    if (timeMs - this.lastSnapshotAtMs >= SNAPSHOT_INTERVAL_MS) {
      this.lastSnapshotAtMs = timeMs;
      this.recordPlayerSnapshot(state, timeMs, actorId);
    }
  }

  drain(): SuccessorGameTraceRecord[] {
    const events = this.peek();
    this.clear();
    return events;
  }

  peek(): SuccessorGameTraceRecord[] {
    const out: SuccessorGameTraceRecord[] = [];
    const count = this.count;
    const start = this.writtenCount >= this.capacity ? this.head : 0;
    for (let i = 0; i < count; i += 1) {
      const event = this.ring[(start + i) % this.capacity];
      if (event) out.push({ ...event });
    }
    return out;
  }

  clear(): void {
    this.ring.length = 0;
    this.head = 0;
    this.writtenCount = 0;
  }

  dispose(): void {
    if (typeof window !== "undefined" && window.__successorGameTrace === this) {
      delete window.__successorGameTrace;
    }
    this.clear();
    this.seenCommandIds.clear();
    this.seenReceiptCommandIds.clear();
    this.seenCombatEventIds.clear();
    this.seenStatusKeys.clear();
    this.currentStatusKeys.clear();
  }

  private record(
    state: PlayState,
    timeMs: number,
    kind: GameTraceKind,
    actorId: string | null,
    payload: Record<string, unknown>,
  ): void {
    const event: SuccessorGameTraceRecord = {
      schema: GAME_TRACE_SCHEMA,
      seq: this.nextSeq,
      tMs: roundThousandths(timeMs),
      wallTimeMs: Date.now(),
      kind,
      snapshotTick: state.serverAuthority.snapshotTick,
      sessionId: state.serverAuthority.sessionId,
      actorId,
      ...payload,
    };
    this.nextSeq += 1;
    this.ring[this.head] = event;
    this.head = (this.head + 1) % this.capacity;
    this.writtenCount += 1;
  }

  private recordLifecycleChanges(state: PlayState, timeMs: number, actorId: string | null): void {
    const sessionId = state.serverAuthority.sessionId;
    const areaId = state.activeAreaId;
    const serverStatus = state.serverAuthority.status;
    const connected = state.serverAuthority.connected;
    if (!this.lifecycleSeeded) {
      this.lifecycleSeeded = true;
      this.record(state, timeMs, "lifecycle", actorId, {
        lifecycle: "trace-started",
        areaId,
        serverStatus,
        connected,
      });
    } else {
      if (this.lastSessionId !== sessionId) {
        this.record(state, timeMs, "lifecycle", actorId, {
          lifecycle: "session-changed",
          fromSessionId: this.lastSessionId,
          toSessionId: sessionId,
        });
      }
      if (this.lastAreaId !== areaId) {
        this.record(state, timeMs, "lifecycle", actorId, {
          lifecycle: "area-changed",
          fromAreaId: this.lastAreaId,
          toAreaId: areaId,
        });
      }
      if (this.lastServerStatus !== serverStatus || this.lastConnected !== connected) {
        this.record(state, timeMs, "lifecycle", actorId, {
          lifecycle: "authority-status",
          fromStatus: this.lastServerStatus,
          toStatus: serverStatus,
          fromConnected: this.lastConnected,
          toConnected: connected,
        });
      }
    }
    this.lastSessionId = sessionId;
    this.lastAreaId = areaId;
    this.lastServerStatus = serverStatus;
    this.lastConnected = connected;
  }

  private recordCommandEnqueues(state: PlayState, timeMs: number, actorId: string | null): void {
    const pending = state.authorityCommands?.pending ?? [];
    for (let i = 0; i < pending.length; i += 1) {
      const envelope = pending[i]!;
      this.recordCommandEnvelope(state, timeMs, actorId, envelope, "pending-queue");
    }
    const sent = state.serverAuthority.sentCommandLog;
    for (let i = 0; i < sent.length; i += 1) {
      const entry = sent[i]!;
      if (this.seenCommandIds.has(entry.commandId)) continue;
      this.seenCommandIds.add(entry.commandId);
      this.record(state, timeMs, "command-enqueued", actorId, {
        source: "sent-command-log",
        commandId: entry.commandId,
        commandKind: entry.kind,
        issuedAtTick: entry.issuedAtTick ?? null,
        sentAtMs: entry.sentAtMs,
      });
    }
  }

  private recordCommandEnvelope(
    state: PlayState,
    timeMs: number,
    actorId: string | null,
    envelope: AuthorityClientCommandEnvelope,
    source: string,
  ): void {
    if (this.seenCommandIds.has(envelope.command_id)) return;
    this.seenCommandIds.add(envelope.command_id);
    const commandKind = safeCommandKind(envelope.command);
    this.record(state, timeMs, "command-enqueued", actorId, {
      source,
      commandId: envelope.command_id,
      commandKind,
      issuedAtTick: envelope.issued_at_tick,
      command: summarizeCommand(envelope.command, commandKind),
    });
  }

  private recordCommandAcks(state: PlayState, timeMs: number, actorId: string | null): void {
    const receipts = state.serverAuthority.receiptLog;
    for (let i = 0; i < receipts.length; i += 1) {
      const receipt = receipts[i]!;
      if (this.seenReceiptCommandIds.has(receipt.commandId)) continue;
      this.seenReceiptCommandIds.add(receipt.commandId);
      const sent = state.serverAuthority.sentCommandLog.find((entry) => entry.commandId === receipt.commandId);
      this.record(state, timeMs, "command-acked", actorId, {
        commandId: receipt.commandId,
        commandKind: sent?.kind ?? null,
        accepted: receipt.accepted,
        tick: receipt.tick,
        reasonCode: receipt.reasonCode ?? null,
        receivedAtMs: receipt.receivedAtMs,
        fireDebug: receipt.fireDebug ? compactFireDebug(receipt.fireDebug) : null,
      });
    }
  }

  private recordCombatEvents(state: PlayState, timeMs: number, actorId: string | null): void {
    const events = state.serverAuthority.eventLog;
    for (let i = 0; i < events.length; i += 1) {
      const event = events[i]!;
      if (this.seenCombatEventIds.has(event.id)) continue;
      this.seenCombatEventIds.add(event.id);
      this.record(state, timeMs, "combat-event", actorId, {
        event: compactCombatEvent(event),
      });
    }
  }

  private recordStatusInsertions(state: PlayState, timeMs: number, actorId: string | null): void {
    this.currentStatusKeys.clear();
    const actors = state.serverAuthority.actors;
    for (const id in actors) {
      const actor = actors[id];
      if (!actor || actor.statuses.length === 0) continue;
      for (let i = 0; i < actor.statuses.length; i += 1) {
        const status = actor.statuses[i]!;
        const key = `${id}:${status.id}`;
        this.currentStatusKeys.add(key);
        if (this.statusSeeded && !this.seenStatusKeys.has(key)) {
          this.record(state, timeMs, "status-inserted", actorId, {
            targetActorId: id,
            targetRole: actor.role ?? null,
            status: compactStatus(status),
          });
        }
      }
    }
    for (const key of this.seenStatusKeys) {
      if (!this.currentStatusKeys.has(key)) this.seenStatusKeys.delete(key);
    }
    for (const key of this.currentStatusKeys) this.seenStatusKeys.add(key);
    this.statusSeeded = true;
  }

  private recordPlayerSnapshot(state: PlayState, timeMs: number, actorId: string | null): void {
    const authority = actorId ? state.serverAuthority.actors[actorId] : null;
    const localActor = state.actors[state.playerActorId] ?? null;
    this.record(state, timeMs, "player-snapshot", actorId, {
      activeAreaId: state.activeAreaId,
      player: {
        x: roundThousandths(state.player.x),
        y: roundThousandths(state.player.y),
        lifeState: localActor?.lifeState ?? null,
      },
      authority: authority ? compactActor(authority) : null,
      prediction: {
        errorCells: roundThousandths(state.serverAuthority.predictionErrorCells),
        inFlightMoves: state.serverAuthority.inFlightMoves.length,
        pendingCommands: state.authorityCommands?.pending.length ?? 0,
      },
    });
  }
}

const disabledGameTraceController: SuccessorGameTraceController = {
  enabled: false,
  sample() {
    // no-op
  },
  dispose() {
    // no-op
  },
};

export function installSuccessorGameTraceProbe(): SuccessorGameTraceController {
  if (!import.meta.env.DEV || typeof window === "undefined" || !gameTraceRequested(window)) {
    return disabledGameTraceController;
  }
  const trace = new BrowserSuccessorGameTrace();
  window.__successorGameTrace = trace;
  return trace;
}

function gameTraceRequested(targetWindow: Window): boolean {
  const params = new URLSearchParams(targetWindow.location.search);
  return params.get("gameTrace") === "1"
    || params.get("gametrace") === "1"
    || targetWindow.localStorage.getItem("successor.gameTrace") === "1";
}

function safeCommandKind(command: AuthorityClientCommand): AuthorityClientCommandKind | "unknown" {
  try {
    return authorityCommandKind(command);
  } catch {
    return "unknown";
  }
}

function summarizeCommand(command: AuthorityClientCommand, kind: AuthorityClientCommandKind | "unknown"): Record<string, unknown> {
  switch (kind) {
    case "Move":
      return "Move" in command ? {
        dx: command.Move.dx,
        dy: command.Move.dy,
        durationTicks: command.Move.duration_ticks,
        facing: command.Move.facing ?? null,
        sprint: command.Move.sprint === true,
      } : {};
    case "QueueCombatAction":
      return "QueueCombatAction" in command ? {
        actionId: command.QueueCombatAction.action_id,
        targetActorId: command.QueueCombatAction.target_actor_id,
      } : {};
    case "SetEquippedWeapon":
      return "SetEquippedWeapon" in command ? {
        weaponId: command.SetEquippedWeapon.weapon_id ?? null,
      } : {};
    default:
      return { keys: Object.keys(command) };
  }
}

function compactActor(actor: ServerAuthorityActorState): Record<string, unknown> {
  return {
    id: actor.id,
    role: actor.role ?? null,
    areaId: actor.areaId,
    x: roundThousandths(actor.x),
    y: roundThousandths(actor.y),
    lifeState: actor.lifeState,
    vitals: actor.vitals,
    maxVitals: actor.maxVitals,
    statuses: actor.statuses.map(compactStatus),
  };
}

function compactStatus(status: ServerAuthorityStatusState): Record<string, unknown> {
  return {
    id: status.id,
    label: status.label,
    severity: status.severity,
    remainingMs: Math.max(0, Math.round(status.remainingMs)),
    stacks: status.stacks ?? null,
    threshold: status.threshold ?? null,
  };
}

function compactCombatEvent(event: ServerAuthorityCombatEventState): Record<string, unknown> {
  return {
    id: event.id,
    tick: event.tick,
    commandId: event.commandId ?? null,
    kind: event.kind ?? "combat",
    actionId: event.actionId ?? null,
    shooterActorId: event.shooterActorId,
    targetActorId: event.targetActorId,
    damage: event.damage,
    hit: event.hit ?? null,
    zone: event.zone,
    previousLifeState: event.previousLifeState,
    lifeState: event.lifeState,
    effect: event.effect?.kind ?? null,
    lifecycle: event.lifecycle ? {
      kind: event.lifecycle.kind,
      from: event.lifecycle.from,
      to: event.lifecycle.to,
      cause: event.lifecycle.cause,
    } : null,
    receivedAtMs: event.receivedAtMs,
  };
}

function compactFireDebug(debug: NonNullable<PlayState["serverAuthority"]["lastReceipt"]>["fireDebug"]): Record<string, unknown> | null {
  if (!debug) return null;
  return {
    shooterActorId: debug.shooterActorId,
    areaId: debug.areaId,
    direction: debug.direction,
    hitActorId: debug.hitActorId,
    hitZone: debug.hitZone,
    distanceCells: debug.distanceCells === null || debug.distanceCells === undefined ? null : roundThousandths(debug.distanceCells),
    blockedBeforeActor: debug.blockedBeforeActor ?? null,
  };
}

function roundThousandths(value: number): number {
  return Math.round(value * 1000) / 1000;
}
