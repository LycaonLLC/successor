/**
 * Movement flight recorder for the Successor 3D client.
 *
 * Goal: turn "movement feels wrong" into a downloadable, analyzable trace that
 * names WHICH layer misbehaved — input capture vs derived intent vs network vs
 * server refusal vs reconciliation snap.
 *
 * == Hot-path contract (always on, cheap) ==
 * The recorder runs every frame. Steady-state per-frame allocation is ZERO:
 *   - samples live in a preallocated ring of 1800 reusable {@link MoveSample}
 *     slot objects; {@link MovementRecorderImpl.sample} only mutates fields of
 *     the current slot in place, then advances the write index.
 *   - markers live in a preallocated ring of 64 reusable {@link MoveMarker}
 *     slot objects.
 *   - the keys/order compact strings are built through two reused
 *     {@link Uint8Array} scratch buffers; the only string produced is the
 *     record payload itself (a primitive value, not a wrapper object).
 *   - the intent vector is derived inline from the held movement keys (see
 *     {@link deriveIntentAndKeys}), mirroring movementVectorFromKeys without
 *     allocating a {x,y} object.
 * No closures, objects, arrays, or Sets are created inside {@link sample}.
 *
 * == Dump path (only on F9 / probe) ==
 * JSON.stringify + Blob download + `window.__successor3dMoveRec.last`. This path
 * allocates freely; it never runs in the frame loop.
 *
 * Ownership: this module owns client-3d/src/debug/*. It reads
 * client/src/slice-core/* (PlayState shape) freely and never edits it. The
 * `recentMoveRejections` field on serverAuthority is added by a sibling agent;
 * it is read defensively (optional-chain + cast) so this compiles whether or
 * not that field has landed.
 */

import type { PlayState, ServerAuthorityRecentMoveRejectionState } from "@successor/client/src/slice-core/gameState";
import { movementClampZeroedRecently } from "../boot/movementCollision";

// ─── ring sizes ──────────────────────────────────────────────────────────────
/** ~30s of history at 60fps. */
const SAMPLE_CAP = 1800;
/** Side ring of anomaly markers (last 64). */
const MARKER_CAP = 64;

const SQRT1_2 = Math.SQRT1_2;

// ─── sample flag bitfield ────────────────────────────────────────────────────
const FLAG_FOCUS = 1 << 0;          // document.hasFocus()
const FLAG_TEXT_INPUT = 1 << 2;     // activeElement is a text input / editable
const FLAG_WS_OPEN = 1 << 3;        // serverAuthority.connected
const FLAG_MOVING = 1 << 4;         // state.moving

// ─── anomaly thresholds ──────────────────────────────────────────────────────
const HELD_NO_INTENT_MS = 150;
const ORDER_DESYNC_MS = 150;
const INTENT_NO_MOTION_MS = 250;
const INTENT_NO_MOTION_CELLS = 0.05;
const REJECT_BURST_COUNT = 3;
const REJECT_BURST_WINDOW_MS = 1000;
/** Mirrors the reconciler snap threshold in runtimeUpdateSystem.reconcileServerAuthorityPlayer. */
const SNAP_THRESHOLD_CELLS = 2.25;
const AUTO_DUMP_THROTTLE_MS = 10_000;
const AUTO_DUMP_SAMPLE_COUNT = 20;
const AUTO_CHIP_MS = 8_000;

export type MarkerKind =
  | "held-no-intent"
  | "order-desync"
  | "intent-no-motion"
  | "reject-burst"
  | "snap";

export const MARKER_KINDS: readonly MarkerKind[] = [
  "held-no-intent",
  "order-desync",
  "intent-no-motion",
  "reject-burst",
  "snap",
];

/**
 * Compact per-key encoding for the `keys`/`order` sample fields:
 *   KeyW→W  KeyA→A  KeyS→S  KeyD→D
 *   ArrowUp→u  ArrowDown→d  ArrowLeft→l  ArrowRight→r
 * (lowercase distinguishes arrows from WASD without colliding with the
 * WASD letters.) Order in the string = Set iteration order for `keys` and
 * movementKeyOrder insertion order for `order`.
 */
const KEY_ENCODING: Record<string, string> = {
  KeyW: "W",
  KeyA: "A",
  KeyS: "S",
  KeyD: "D",
  ArrowUp: "u",
  ArrowDown: "d",
  ArrowLeft: "l",
  ArrowRight: "r",
};

/** One frame in the ring. Mutated in place — never reallocated after boot. */
interface MoveSample {
  tMs: number;
  serverTick: number;
  keys: string;
  order: string;
  intentX: number;
  intentY: number;
  playerX: number;
  playerY: number;
  authorityX: number;
  authorityY: number;
  predictionErrorCells: number;
  acceptedCommands: number;
  rejectedCommands: number;
  inFlightMoves: number;
  flags: number;
}

/** One anomaly marker in the side ring. Mutated in place. */
interface MoveMarker {
  tMs: number;
  kind: MarkerKind | "";
  /** Sustained-duration context (held-no-intent / order-desync / intent-no-motion). */
  ms: number;
  /** reject-burst count within the window. */
  count: number;
  /** snap: predictionErrorCells that crossed the threshold. */
  err: number;
  /** intent-no-motion net displacement over the window. */
  dPlayer: number;
  dAuth: number;
  /** held-no-intent / order-desync: the compact keys/order at detection. */
  keys: string;
  order: string;
}

// `serverAuthority.recentMoveRejections` (+ recentMoveRejectionWriteIndex /
// recentMoveRejectionCount) is the MoveInputFix ring of the last ~32 rejected
// move receipts: {commandId, reasonCode, serverTick, dx, dy}. It is read in
// chronological ring order by forEachRecentRejection so the dump and the
// ?moverec=1 chip skip the preallocated ring's zero-filled empty slots.

export interface MovementSampleDump {
  tMs: number;
  serverTick: number;
  keys: string;
  order: string;
  intentX: number;
  intentY: number;
  playerX: number;
  playerY: number;
  /** NaN (→ JSON null) when the local player has no authority actor yet. */
  authorityX: number;
  authorityY: number;
  predictionErrorCells: number;
  acceptedCommands: number;
  rejectedCommands: number;
  inFlightMoves: number;
  flags: number;
  flagBits: {
    documentHasFocus: boolean;
    activeElementIsTextInput: boolean;
    wsOpen: boolean;
    moving: boolean;
  };
}

export interface MovementMarkerDump {
  tMs: number;
  kind: MarkerKind;
  detail: Record<string, number | string>;
}

export interface MovementRecorderDump {
  meta: {
    url: string;
    ua: string;
    startedAt: string;
    clockOriginMs: number;
    gamePort: string | null;
    movementInputMode: string;
    sampleCapacity: number;
    sampleCount: number;
    markerCapacity: number;
    markerCount: number;
    markerKinds: readonly MarkerKind[];
    keyEncoding: Record<string, string>;
    flagBits: Record<number, string>;
    thresholds: Record<string, number>;
  };
  markers: MovementMarkerDump[];
  samples: MovementSampleDump[];
  recentMoveRejections: ServerAuthorityRecentMoveRejectionState[];
}

interface MovementAnomalyRecentSample {
  tick: number;
  keys: string;
  cell: [number, number];
  authority: [number, number] | null;
  inFlight: number;
  rejected: number;
}

interface MovementAnomalyMoveGate {
  lastMoveIssuedAtTick: number | null;
  snapshotTick: number;
  pendingMoves: number;
  inFlightMoves: number;
  sendGateStalled: boolean;
}

interface MovementAnomalyRejectLogEntry {
  kind: string;
  reason: string;
  tick: number;
}

interface MovementAnomalyConsoleDump {
  kind: "reject-burst" | "intent-no-motion" | "snap";
  tMs: number;
  playerCell: [number, number];
  authCell: [number, number] | null;
  predictionErrorCells: number | null;
  moveGate: MovementAnomalyMoveGate;
  rejectLog: MovementAnomalyRejectLogEntry[];
  recent: MovementAnomalyRecentSample[];
}

/** Public probe surface mounted on `window.__successor3dMoveRec`. */
export interface MovementRecorderProbe {
  /** Toggle recording at runtime; false pauses {@link sample}. */
  enabled: boolean;
  dump(): MovementRecorderDump | null;
  /** Per-kind cumulative marker counts (live snapshot). */
  readonly markers: Record<string, number>;
  readonly markerTotal: number;
  readonly sampleCount: number;
  readonly last: MovementRecorderDump | null;
  dispose(): void;
}

/** Frame-loop handle returned to successor3dApp. */
export interface MovementRecorder {
  sample(state: PlayState, time: number): void;
  dispose(): void;
}

declare global {
  interface Window {
    __successor3dMoveRec?: MovementRecorderProbe;
  }
}

export function createMovementRecorder(state: PlayState): MovementRecorder {
  return new MovementRecorderImpl(state);
}

class MovementRecorderImpl implements MovementRecorder, MovementRecorderProbe {
  // --- live game state (read-only) ---
  private readonly state: PlayState;

  // --- sample ring ---
  private readonly samples: MoveSample[] = Array.from({ length: SAMPLE_CAP }, (): MoveSample => ({
    tMs: 0,
    serverTick: 0,
    keys: "",
    order: "",
    intentX: 0,
    intentY: 0,
    playerX: 0,
    playerY: 0,
    authorityX: Number.NaN,
    authorityY: Number.NaN,
    predictionErrorCells: 0,
    acceptedCommands: 0,
    rejectedCommands: 0,
    inFlightMoves: 0,
    flags: 0,
  }));
  private writeIndex = 0;
  private writtenCount = 0;

  // --- marker ring ---
  private readonly markerRing: MoveMarker[] = Array.from({ length: MARKER_CAP }, (): MoveMarker => ({
    tMs: 0,
    kind: "",
    ms: 0,
    count: 0,
    err: 0,
    dPlayer: 0,
    dAuth: 0,
    keys: "",
    order: "",
  }));
  private markerHead = 0;
  private markerCount = 0;
  private readonly kindCounts: Record<MarkerKind, number> = {
    "held-no-intent": 0,
    "order-desync": 0,
    "intent-no-motion": 0,
    "reject-burst": 0,
    snap: 0,
  };

  // --- reusable scratch (zero per-frame allocation) ---
  private readonly keysScratch = new Uint8Array(8);
  private readonly orderScratch = new Uint8Array(8);

  // --- anomaly tracker state ---
  private lastSampleTMs = -1;
  private prevPredictionError = 0;
  private prevRejected: number;
  private heldNoIntentMs = 0;
  private heldNoIntentMarked = false;
  private orderDesyncMs = 0;
  private orderDesyncMarked = false;
  private intentAnchorTMs = -1;
  private intentAnchorPlayerX = 0;
  private intentAnchorPlayerY = 0;
  private intentAnchorAuthX = Number.NaN;
  private intentAnchorAuthY = Number.NaN;
  private intentNoMotionMarked = false;
  private rejectWindowStartMs = 0;
  private rejectCount = 0;

  private readonly lastAutoDumpByKind: Record<MarkerKind, number> = {
    "held-no-intent": Number.NEGATIVE_INFINITY,
    "order-desync": Number.NEGATIVE_INFINITY,
    "intent-no-motion": Number.NEGATIVE_INFINITY,
    "reject-burst": Number.NEGATIVE_INFINITY,
    snap: Number.NEGATIVE_INFINITY,
  };
  // --- bookkeeping ---
  enabled = true;
  private lastDump: MovementRecorderDump | null = null;
  private readonly startedAtIso: string;
  private readonly clockOriginMs: number;

  // --- F9 + chip ---
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== "F9" && event.key !== "F9") return;
    event.preventDefault();
    this.dump();
  };
  private keydownInstalled = false;
  private readonly liveChip: boolean;
  private chipEl: HTMLElement | null;
  private chipApplied = "";
  private chipLastMs = 0;
  private anomalyChipUntilMs = 0;
  private anomalyChipText = "";
  constructor(state: PlayState) {
    this.state = state;
    this.prevRejected = state.serverAuthority.rejectedCommands;
    this.startedAtIso = new Date().toISOString();
    this.clockOriginMs = performance.now();

    // F9 → dump (registered by the recorder itself; input.ts is untouched).
    window.addEventListener("keydown", this.onKeyDown, true);
    this.keydownInstalled = true;

    // ?moverec=1 opts into the recorder's visible/console diagnostics. Without
    // the flag, sampling and anomaly markers still run for F9/probe dumps, but
    // normal players never see a debug chip or `[moverec-anomaly]` error.
    this.liveChip = new URLSearchParams(window.location.search).get("moverec") === "1";
    this.chipEl = this.liveChip ? this.mountChip() : null;

    window.__successor3dMoveRec = this;
  }

  // ────────────────────────────────────────────────────────────────────────
  //  Per-frame hot path. See module header: ZERO steady-state allocation.
  // ────────────────────────────────────────────────────────────────────────
  sample(state: PlayState, time: number): void {
    if (!this.enabled) return;
    const dtMs = this.lastSampleTMs < 0 ? 0 : Math.max(0, time - this.lastSampleTMs);
    this.lastSampleTMs = time;

    // -- encode held movement keys + derive intent --
    // MUST mirror runtimeUpdateSystem.movementInputKeys iteration semantics:
    // unordered-but-held keys first, then movementKeyOrder entries (filtered
    // by held membership) so that per-axis last-wins resolution matches the
    // runtime exactly — including same-axis conflicts (e.g. stale-held W vs
    // freshly ordered S). Pinned in client/ by the runtimeUpdateSystem tests
    // ("lets a freshly ordered key win same-axis conflicts…"). Inline (no
    // movementInputKeys call) to keep this path allocation-free.
    const keysScratch = this.keysScratch;
    let keyLen = 0;
    let sx = 0;
    let sy = 0;
    let keysMovementNotInOrder = false;
    const orderArr = state.movementKeyOrder;
    const hasOrder = orderArr.length > 0;
    // Pass 1: held keys — record char codes; apply axis writes ONLY for keys
    // missing from the order array (the "unordered held" prefix).
    for (const code of state.keys) {
      let vx = 0;
      let vy = 0;
      let ch = 0;
      switch (code) {
        case "KeyW": vx = 0; vy = -1; ch = 87; break; // 'W'
        case "KeyA": vx = -1; vy = 0; ch = 65; break; // 'A'
        case "KeyS": vx = 0; vy = 1; ch = 83; break;  // 'S'
        case "KeyD": vx = 1; vy = 0; ch = 68; break;  // 'D'
        case "ArrowUp": vx = 0; vy = -1; ch = 117; break;   // 'u'
        case "ArrowDown": vx = 0; vy = 1; ch = 100; break;  // 'd'
        case "ArrowLeft": vx = -1; vy = 0; ch = 108; break; // 'l'
        case "ArrowRight": vx = 1; vy = 0; ch = 114; break; // 'r'
        default: continue;
      }
      if (keyLen < 8) keysScratch[keyLen] = ch;
      keyLen += 1;
      const inOrder = hasOrder && orderArr.includes(code);
      if (!inOrder) {
        if (vx !== 0) sx = vx;
        if (vy !== 0) sy = vy;
        if (hasOrder) keysMovementNotInOrder = true;
      }
    }
    // Pass 2: ordered held keys overwrite — ordered keys win their axis, and
    // the last-ordered key wins same-axis conflicts (matches runtime).
    if (hasOrder) {
      for (let i = 0; i < orderArr.length; i += 1) {
        const code = orderArr[i];
        if (code === undefined || !state.keys.has(code)) continue;
        switch (code) {
          case "KeyW": sy = -1; break;
          case "KeyA": sx = -1; break;
          case "KeyS": sy = 1; break;
          case "KeyD": sx = 1; break;
          case "ArrowUp": sy = -1; break;
          case "ArrowDown": sy = 1; break;
          case "ArrowLeft": sx = -1; break;
          case "ArrowRight": sx = 1; break;
          default: break;
        }
      }
    }

    let intentX: number;
    let intentY: number;
    if (sx !== 0 && sy !== 0) {
      intentX = sx * SQRT1_2;
      intentY = sy * SQRT1_2;
    } else {
      intentX = sx;
      intentY = sy;
    }
    const keysStr = keyLen === 0 ? "" : fromCharCodes(keysScratch, keyLen);

    // -- encode order + detect order/key desync --
    const orderScratch = this.orderScratch;
    let orderLen = 0;
    let orderHasKeyNotInKeys = false;
    for (const code of orderArr) {
      const ch = movementCharCode(code);
      if (ch === 0) {
        // Non-movement code present in movementKeyOrder — structurally a desync.
        orderHasKeyNotInKeys = true;
        continue;
      }
      if (orderLen < 8) orderScratch[orderLen] = ch;
      orderLen += 1;
      if (!state.keys.has(code)) orderHasKeyNotInKeys = true;
    }
    const orderStr = orderLen === 0 ? "" : fromCharCodes(orderScratch, orderLen);
    const orderDesync = orderHasKeyNotInKeys || (hasOrder && keysMovementNotInOrder);

    // -- authority actor (server side of the player) --
    const playerActorId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const authorityActor = state.serverAuthority.actors[playerActorId];
    const authorityX = authorityActor ? authorityActor.x : Number.NaN;
    const authorityY = authorityActor ? authorityActor.y : Number.NaN;

    // -- flags bitfield --
    let flags = 0;
    if (document.hasFocus()) flags |= FLAG_FOCUS;
    const active = document.activeElement;
    if (
      active !== null
      && (active.tagName === "INPUT"
        || active.tagName === "TEXTAREA"
        || (active as HTMLElement).isContentEditable)
    ) {
      flags |= FLAG_TEXT_INPUT;
    }
    if (state.serverAuthority.connected) flags |= FLAG_WS_OPEN;
    if (state.moving) flags |= FLAG_MOVING;

    // -- write into the reusable slot in place --
    const slot = this.samples[this.writeIndex]!;
    slot.tMs = time;
    slot.serverTick = state.serverAuthority.snapshotTick;
    slot.keys = keysStr;
    slot.order = orderStr;
    slot.intentX = intentX;
    slot.intentY = intentY;
    slot.playerX = state.player.x;
    slot.playerY = state.player.y;
    slot.authorityX = authorityX;
    slot.authorityY = authorityY;
    slot.predictionErrorCells = state.serverAuthority.predictionErrorCells;
    slot.acceptedCommands = state.serverAuthority.acceptedCommands;
    slot.rejectedCommands = state.serverAuthority.rejectedCommands;
    slot.inFlightMoves = state.serverAuthority.inFlightMoves.length;
    slot.flags = flags;
    this.writeIndex = (this.writeIndex + 1) % SAMPLE_CAP;
    if (this.writtenCount < SAMPLE_CAP) this.writtenCount += 1;

    // -- anomaly tagger (cheap comparisons only) --
    const intentZero = intentX === 0 && intentY === 0;

    // held-no-intent: movement key held ≥150ms continuously while intent is 0.
    if (keyLen > 0 && intentZero) {
      this.heldNoIntentMs += dtMs;
      if (this.heldNoIntentMs >= HELD_NO_INTENT_MS && !this.heldNoIntentMarked) {
        this.heldNoIntentMarked = true;
        this.recordMarker(time, "held-no-intent", { ms: this.heldNoIntentMs, keys: keysStr });
      }
    } else {
      this.heldNoIntentMs = 0;
      this.heldNoIntentMarked = false;
    }

    // order-desync: order/keys disagree, sustained ≥150ms.
    if (orderDesync) {
      this.orderDesyncMs += dtMs;
      if (this.orderDesyncMs >= ORDER_DESYNC_MS && !this.orderDesyncMarked) {
        this.orderDesyncMarked = true;
        this.recordMarker(time, "order-desync", { ms: this.orderDesyncMs, keys: keysStr, order: orderStr });
      }
    } else {
      this.orderDesyncMs = 0;
      this.orderDesyncMarked = false;
    }

    // intent-no-motion: intent nonzero ≥250ms while BOTH positions moved <0.05.
    // World-collision clamp (movementCollision) zeroing the vector is
    // INTENTIONAL blocking — pressing into a titan is not an anomaly.
    const intentActive = !intentZero && !movementClampZeroedRecently(time);
    if (intentActive) {
      if (this.intentAnchorTMs < 0) {
        this.intentAnchorTMs = time;
        this.intentAnchorPlayerX = state.player.x;
        this.intentAnchorPlayerY = state.player.y;
        this.intentAnchorAuthX = authorityX;
        this.intentAnchorAuthY = authorityY;
        this.intentNoMotionMarked = false;
      }
      const elapsed = time - this.intentAnchorTMs;
      if (elapsed >= INTENT_NO_MOTION_MS && !this.intentNoMotionMarked) {
        const dPlayer = Math.hypot(
          state.player.x - this.intentAnchorPlayerX,
          state.player.y - this.intentAnchorPlayerY,
        );
        const dAuth = Math.hypot(
          authorityX - this.intentAnchorAuthX,
          authorityY - this.intentAnchorAuthY,
        );
        if (dPlayer < INTENT_NO_MOTION_CELLS && dAuth < INTENT_NO_MOTION_CELLS) {
          this.intentNoMotionMarked = true;
          this.recordMarker(time, "intent-no-motion", { ms: elapsed, dPlayer, dAuth });
          // Re-anchor so a continued stall re-marks after another window.
          this.intentAnchorTMs = time;
          this.intentAnchorPlayerX = state.player.x;
          this.intentAnchorPlayerY = state.player.y;
          this.intentAnchorAuthX = authorityX;
          this.intentAnchorAuthY = authorityY;
        }
      }
    } else {
      this.intentAnchorTMs = -1;
      this.intentNoMotionMarked = false;
    }

    // reject-burst: rejectedCommands delta ≥3 within a 1s window.
    const rejectedNow = state.serverAuthority.rejectedCommands;
    const rejDelta = rejectedNow - this.prevRejected;
    this.prevRejected = rejectedNow;
    if (rejDelta > 0) {
      if (time - this.rejectWindowStartMs > REJECT_BURST_WINDOW_MS) {
        this.rejectWindowStartMs = time;
        this.rejectCount = 0;
      }
      this.rejectCount += rejDelta;
      if (this.rejectCount >= REJECT_BURST_COUNT) {
        this.recordMarker(time, "reject-burst", { count: this.rejectCount });
        this.rejectWindowStartMs = time;
        this.rejectCount = 0;
      }
    }

    // snap: predictionErrorCells crosses above 2.25 (edge-triggered, one per snap).
    const errNow = state.serverAuthority.predictionErrorCells;
    if (errNow > SNAP_THRESHOLD_CELLS && this.prevPredictionError <= SNAP_THRESHOLD_CELLS) {
      this.recordMarker(time, "snap", { err: errNow });
    }
    this.prevPredictionError = errNow;

    // -- chip (only mounted under ?moverec=1) --
    if (this.chipEl !== null) this.updateChip(time, state);
  }

  // ────────────────────────────────────────────────────────────────────────
  //  Markers
  // ────────────────────────────────────────────────────────────────────────
  private recordMarker(
    time: number,
    kind: MarkerKind,
    detail: { ms?: number; count?: number; err?: number; dPlayer?: number; dAuth?: number; keys?: string; order?: string },
  ): void {
    // Marks fire only on anomalies (rare), so the detail object literal here is
    // not on the per-frame hot path.
    const slot = this.markerRing[this.markerHead]!;
    this.markerHead = (this.markerHead + 1) % MARKER_CAP;
    if (this.markerCount < MARKER_CAP) this.markerCount += 1;
    slot.tMs = time;
    slot.kind = kind;
    slot.ms = detail.ms ?? 0;
    slot.count = detail.count ?? 0;
    slot.err = detail.err ?? 0;
    slot.dPlayer = detail.dPlayer ?? 0;
    slot.dAuth = detail.dAuth ?? 0;
    slot.keys = detail.keys ?? "";
    slot.order = detail.order ?? "";
    this.kindCounts[kind] += 1;
    if (!this.liveChip) return;
    this.showAnomalyChip(time, kind);
    if (kind === "reject-burst" || kind === "intent-no-motion" || kind === "snap") {
      this.emitAnomalyLine(time, kind);
    }
  }

  private emitAnomalyLine(time: number, kind: MovementAnomalyConsoleDump["kind"]): void {
    if (time - this.lastAutoDumpByKind[kind] < AUTO_DUMP_THROTTLE_MS) return;
    this.lastAutoDumpByKind[kind] = time;
    const latest = this.latestSample();
    const payload: MovementAnomalyConsoleDump = {
      kind,
      tMs: round1(time),
      playerCell: latest ? roundedCell(latest.playerX, latest.playerY) : roundedCell(this.state.player.x, this.state.player.y),
      authCell: latest ? roundedAuthorityCell(latest.authorityX, latest.authorityY) : null,
      predictionErrorCells: finiteRounded(latest?.predictionErrorCells ?? this.state.serverAuthority.predictionErrorCells),
      moveGate: this.compactMoveGate(this.state),
      rejectLog: this.compactRejectLog(this.state),
      recent: this.compactRecentSamples(AUTO_DUMP_SAMPLE_COUNT),
    };
    console.error("[moverec-anomaly] " + JSON.stringify(payload));
  }

  private latestSample(): MoveSample | null {
    if (this.writtenCount <= 0) return null;
    return this.samples[(this.writeIndex + SAMPLE_CAP - 1) % SAMPLE_CAP]!;
  }

  private compactRecentSamples(limit: number): MovementAnomalyRecentSample[] {
    const out: MovementAnomalyRecentSample[] = [];
    const n = Math.min(this.writtenCount, SAMPLE_CAP, Math.max(0, limit));
    const start = (this.writeIndex + SAMPLE_CAP - n) % SAMPLE_CAP;
    for (let i = 0; i < n; i += 1) {
      const slot = this.samples[(start + i) % SAMPLE_CAP]!;
      out.push({
        tick: slot.serverTick,
        keys: slot.keys,
        cell: roundedCell(slot.playerX, slot.playerY),
        authority: roundedAuthorityCell(slot.authorityX, slot.authorityY),
        inFlight: slot.inFlightMoves,
        rejected: slot.rejectedCommands,
      });
    }
    return out;
  }

  private compactMoveGate(state: PlayState): MovementAnomalyMoveGate {
    const lastMoveIssuedAtTick = state.serverAuthority.lastMoveIssuedAtTick;
    const snapshotTick = state.serverAuthority.snapshotTick;
    return {
      lastMoveIssuedAtTick,
      snapshotTick,
      pendingMoves: countPendingMoveCommands(state),
      inFlightMoves: state.serverAuthority.inFlightMoves.length,
      sendGateStalled: lastMoveIssuedAtTick !== null && snapshotTick < lastMoveIssuedAtTick,
    };
  }

  private compactRejectLog(state: PlayState): MovementAnomalyRejectLogEntry[] {
    const out: MovementAnomalyRejectLogEntry[] = [];
    const receipts = state.serverAuthority.receiptLog;
    for (let i = receipts.length - 1; i >= 0 && out.length < 4; i -= 1) {
      const receipt = receipts[i]!;
      if (receipt.accepted) continue;
      out.push({
        kind: sentCommandKindFor(state, receipt.commandId),
        reason: receipt.reasonCode ?? "unspecified",
        tick: receipt.tick,
      });
    }
    out.reverse();
    return out;
  }

  private showAnomalyChip(time: number, kind: MarkerKind): void {
    this.anomalyChipUntilMs = time + AUTO_CHIP_MS;
    this.anomalyChipText = `MOVEMENT ANOMALY CAPTURED (${kind})`;
    if (this.chipEl === null) this.chipEl = this.mountChip();
    if (this.chipApplied !== this.anomalyChipText) {
      this.chipApplied = this.anomalyChipText;
      this.chipEl.textContent = this.anomalyChipText;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  //  Dump (F9 / probe) — allocates freely; never on the frame loop.
  // ────────────────────────────────────────────────────────────────────────
  dump(): MovementRecorderDump | null {
    try {
      const state = this.state;
      const payload: MovementRecorderDump = {
        meta: {
          url: window.location.href,
          ua: navigator.userAgent,
          startedAt: this.startedAtIso,
          clockOriginMs: this.clockOriginMs,
          gamePort: resolveGamePort(state),
          movementInputMode: state.movementInputMode,
          sampleCapacity: SAMPLE_CAP,
          sampleCount: this.writtenCount,
          markerCapacity: MARKER_CAP,
          markerCount: this.markerCount,
          markerKinds: MARKER_KINDS,
          keyEncoding: KEY_ENCODING,
          flagBits: {
            1: "documentHasFocus",
            4: "activeElementIsTextInput",
            8: "wsOpen",
            16: "moving",
          },
          thresholds: {
            heldNoIntentMs: HELD_NO_INTENT_MS,
            orderDesyncMs: ORDER_DESYNC_MS,
            intentNoMotionMs: INTENT_NO_MOTION_MS,
            intentNoMotionCells: INTENT_NO_MOTION_CELLS,
            rejectBurstCount: REJECT_BURST_COUNT,
            rejectBurstWindowMs: REJECT_BURST_WINDOW_MS,
            snapCells: SNAP_THRESHOLD_CELLS,
          },
        },
        markers: this.collectMarkers(),
        samples: this.collectSamples(),
        recentMoveRejections: this.snapshotRejections(state),
      };
      this.lastDump = payload;
      this.download(payload);
      return payload;
    } catch (error) {
      console.warn("movement recorder dump failed", error);
      return null;
    }
  }

  private collectSamples(): MovementSampleDump[] {
    const out: MovementSampleDump[] = [];
    const n = Math.min(this.writtenCount, SAMPLE_CAP);
    const start = this.writtenCount >= SAMPLE_CAP ? this.writeIndex : 0;
    for (let i = 0; i < n; i += 1) {
      const slot = this.samples[(start + i) % SAMPLE_CAP]!;
      out.push({
        tMs: slot.tMs,
        serverTick: slot.serverTick,
        keys: slot.keys,
        order: slot.order,
        intentX: slot.intentX,
        intentY: slot.intentY,
        playerX: slot.playerX,
        playerY: slot.playerY,
        authorityX: slot.authorityX,
        authorityY: slot.authorityY,
        predictionErrorCells: slot.predictionErrorCells,
        acceptedCommands: slot.acceptedCommands,
        rejectedCommands: slot.rejectedCommands,
        inFlightMoves: slot.inFlightMoves,
        flags: slot.flags,
        flagBits: decodeFlags(slot.flags),
      });
    }
    return out;
  }

  private collectMarkers(): MovementMarkerDump[] {
    const out: MovementMarkerDump[] = [];
    const n = Math.min(this.markerCount, MARKER_CAP);
    const start = this.markerCount >= MARKER_CAP ? this.markerHead : 0;
    for (let i = 0; i < n; i += 1) {
      const slot = this.markerRing[(start + i) % MARKER_CAP]!;
      if (slot.kind === "") continue;
      out.push({ tMs: slot.tMs, kind: slot.kind, detail: markerDetail(slot) });
    }
    return out;
  }

  private forEachRecentRejection(
    state: PlayState,
    fn: (entry: ServerAuthorityRecentMoveRejectionState) => void,
  ): void {
    const entries = state.serverAuthority.recentMoveRejections;
    if (!entries || entries.length === 0) return;
    const cap = entries.length;
    const count = Math.min(state.serverAuthority.recentMoveRejectionCount ?? 0, cap);
    if (count === 0) return;
    const start = count >= cap ? (state.serverAuthority.recentMoveRejectionWriteIndex ?? 0) % cap : 0;
    for (let i = 0; i < count; i += 1) {
      fn(entries[(start + i) % cap]!);
    }
  }

  private snapshotRejections(state: PlayState): ServerAuthorityRecentMoveRejectionState[] {
    const out: ServerAuthorityRecentMoveRejectionState[] = [];
    this.forEachRecentRejection(state, (entry) => {
      out.push({
        commandId: entry.commandId,
        reasonCode: entry.reasonCode,
        serverTick: entry.serverTick,
        dx: entry.dx,
        dy: entry.dy,
      });
    });
    return out;
  }

  private download(payload: MovementRecorderDump): void {
    const json = JSON.stringify(payload);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.rel = "noopener";
    anchor.href = url;
    anchor.download = `successor-move-${filenameStamp()}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  // ────────────────────────────────────────────────────────────────────────
  //  ?moverec=1 chip
  // ────────────────────────────────────────────────────────────────────────
  private mountChip(): HTMLElement {
    const el = document.createElement("div");
    el.className = "sc3d-moverec-chip";
    el.setAttribute("aria-hidden", "true");
    el.setAttribute(
      "style",
      [
        "position:fixed",
        "top:8px",
        "left:8px",
        "z-index:40",
        "padding:6px 8px",
        "font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace",
        "color:var(--sc3d-ink)",
        "background:var(--sc3d-glass)",
        "border:1px solid var(--sc3d-hairline)",
        "border-radius:4px",
        "pointer-events:none",
        "white-space:pre",
        "backdrop-filter:blur(3px)",
        "max-width:260px",
        "box-shadow:0 1px 4px rgba(0,0,0,0.35)",
      ].join(";"),
    );
    el.textContent = "move-rec …";
    document.body.appendChild(el);
    return el;
  }

  private updateChip(time: number, state: PlayState): void {
    // Throttle: the chip is dev-only except for the rare anomaly banner; rebuild at most ~10x/s.
    if (time - this.chipLastMs < 100) return;
    this.chipLastMs = time;

    let text: string;
    if (time < this.anomalyChipUntilMs) {
      text = this.anomalyChipText;
    } else if (!this.liveChip) {
      this.chipEl?.remove();
      this.chipEl = null;
      this.chipApplied = "";
      return;
    } else {
      text = `move-rec ${this.enabled ? "ON" : "OFF"} · ${this.writtenCount}/${SAMPLE_CAP}`;
      for (const kind of MARKER_KINDS) {
        text += `\n ${kind} ${this.kindCounts[kind]}`;
      }
      const rejectionCounts: Record<string, number> = {};
      this.forEachRecentRejection(state, (entry) => {
        const reason = entry.reasonCode || "?";
        rejectionCounts[reason] = (rejectionCounts[reason] ?? 0) + 1;
      });
      const rejectionReasons = Object.keys(rejectionCounts).sort();
      if (rejectionReasons.length > 0) {
        text += `\n rej ${rejectionReasons.map((reason) => `${reason}:${rejectionCounts[reason]}`).join(" ")}`;
      }
    }
    if (text !== this.chipApplied) {
      this.chipApplied = text;
      this.chipEl!.textContent = text;
    }
  }

  // ────────────────────────────────────────────────────────────────────────
  //  Probe + lifecycle
  // ────────────────────────────────────────────────────────────────────────
  get markers(): Record<string, number> {
    return { ...this.kindCounts };
  }

  get markerTotal(): number {
    return this.markerCount;
  }

  get sampleCount(): number {
    return this.writtenCount;
  }

  get last(): MovementRecorderDump | null {
    return this.lastDump;
  }

  dispose(): void {
    if (this.keydownInstalled) {
      window.removeEventListener("keydown", this.onKeyDown, true);
      this.keydownInstalled = false;
    }
    if (this.chipEl !== null) {
      this.chipEl.remove();
    }
    if (window.__successor3dMoveRec === this) {
      // Only clear the global if it still points at us.
      window.__successor3dMoveRec = undefined;
    }
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function round1(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}

function finiteRounded(value: number): number | null {
  return Number.isFinite(value) ? Math.round(value * 1_000) / 1_000 : null;
}

function roundedCell(x: number, y: number): [number, number] {
  return [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
}

function roundedAuthorityCell(x: number, y: number): [number, number] | null {
  return Number.isFinite(x) && Number.isFinite(y) ? roundedCell(x, y) : null;
}

function countPendingMoveCommands(state: PlayState): number {
  let count = 0;
  for (const envelope of state.authorityCommands?.pending ?? []) {
    if ("Move" in envelope.command) count += 1;
  }
  return count;
}

function sentCommandKindFor(state: PlayState, commandId: number): string {
  for (let i = state.serverAuthority.sentCommandLog.length - 1; i >= 0; i -= 1) {
    const entry = state.serverAuthority.sentCommandLog[i]!;
    if (entry.commandId === commandId) return entry.kind;
  }
  return "unknown";
}

function movementCharCode(code: string): number {
  switch (code) {
    case "KeyW": return 87;
    case "KeyA": return 65;
    case "KeyS": return 83;
    case "KeyD": return 68;
    case "ArrowUp": return 117;
    case "ArrowDown": return 100;
    case "ArrowLeft": return 108;
    case "ArrowRight": return 114;
    default: return 0;
  }
}

/** Build the compact key string from a reused Uint8Array scratch buffer. */
function fromCharCodes(buf: Uint8Array, len: number): string {
  const n = Math.min(len, buf.length);
  if (n <= 0) return "";
  // apply() over a TypedArray subarray: no intermediate array is created.
  return String.fromCharCode.apply(null, buf.subarray(0, n) as unknown as number[]);
}

function decodeFlags(flags: number): MovementSampleDump["flagBits"] {
  return {
    documentHasFocus: (flags & FLAG_FOCUS) !== 0,
    activeElementIsTextInput: (flags & FLAG_TEXT_INPUT) !== 0,
    wsOpen: (flags & FLAG_WS_OPEN) !== 0,
    moving: (flags & FLAG_MOVING) !== 0,
  };
}

function markerDetail(slot: MoveMarker): Record<string, number | string> {
  switch (slot.kind) {
    case "held-no-intent":
      return { ms: slot.ms, keys: slot.keys };
    case "order-desync":
      return { ms: slot.ms, keys: slot.keys, order: slot.order };
    case "intent-no-motion":
      return { ms: slot.ms, playerDelta: slot.dPlayer, authorityDelta: slot.dAuth };
    case "reject-burst":
      return { count: slot.count };
    case "snap":
      return { predictionErrorCells: slot.err };
    default:
      return {};
  }
}

function resolveGamePort(state: PlayState): string | null {
  const wsUrl = state.serverAuthority.wsUrl;
  if (wsUrl) {
    try {
      const port = new URL(wsUrl).port;
      if (port) return port;
    } catch {
      // fall through to location.port
    }
  }
  return window.location.port || null;
}

function filenameStamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
