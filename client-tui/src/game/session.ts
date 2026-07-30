/**
 * Session — the one stateful integration seam.
 *
 * Owns the embedded headless host (module API: state/slice/start/close/
 * onEnvelope — the JSONL driver protocol stays the external surface), the
 * TUI's verb-registry instance, the macro engine, the chat hub connection,
 * the movement controller, and the tool-gated survey store. Everything
 * downstream (narrator, panes, plain mode) consumes typed SessionEvents and
 * reads PlayState — no other module talks to the wire.
 */

import { createSuccessorHeadlessHost, type SuccessorHeadlessHost, type SuccessorHeadlessHostOptions } from "@successor/client/src/headless/host";
import WsWebSocket from "ws";
import type { SuccessorDriverEnvelope } from "@successor/client/src/headless/protocol";
import { createChatClient, type ChatClient, type ChatMessage, type ChatSendChannel } from "@successor/client/src/chat/chatClient";
import { authorityIssuedAtServerTick } from "@successor/client/src/slice-core/authorityCommandSystem";
import { createMacroEngine, type MacroEngine, type MacroProvider } from "@successor/client/src/slice-core/macroEngine/index";
import { createVerbRegistry, type VerbExecutionResult, type VerbRegistry } from "@successor/client/src/slice-core/verbRegistry/index";
import type { AbilityQueueEvent, PlayState, ServerAuthoritySurveyResultState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";

import { keysForWind, type Wind } from "./bearing";
import { createTuiMacroLibrary } from "./localMacroFiles";
import { createContactTracker, type ContactEvents, type ContactTracker } from "./contacts";
import { parseDuelOutcome, type DuelOutcomePayload } from "./duel";
import { createSurveyStore, type SurveyStore } from "./surveyStore";
import { isCarriedContainer } from "./exchangeTrade";

export interface SessionOptions extends SuccessorHeadlessHostOptions {
  chatUrl?: string;
  /** Standalone one-use chat capability; sent as the first socket frame and
   *  cleared from these options the moment the chat client owns it. */
  chatTicket?: string;
  verbose?: boolean;
  /** Local `.macro` dir (XDG default); null disables the local provider. */
  macroDir?: string | null;
}

export type SessionEvent =
  | { kind: "receipt"; commandId: number; accepted: boolean; tick: number; reasonCode?: string; commandKind?: string }
  | { kind: "combat"; event: Record<string, unknown> }
  | { kind: "queue"; event: AbilityQueueEvent }
  | { kind: "survey"; areaId: string; result: ServerAuthoritySurveyResultState }
  | { kind: "trade" }
  | { kind: "duelOutcome"; outcome: DuelOutcomePayload }
  | { kind: "splice" }
  | { kind: "genomeScan" }
  | { kind: "status"; status: string; message?: string }
  | { kind: "chat"; message: ChatMessage }
  | { kind: "contacts"; events: ContactEvents }
  | { kind: "system"; text: string };

export interface GameSession {
  readonly state: PlayState;
  readonly slice: SliceSnapshot;
  readonly registry: VerbRegistry;
  readonly macros: MacroEngine;
  readonly survey: SurveyStore;
  readonly tracker: ContactTracker;
  readonly chat: ChatClient | null;
  /** Define/replace a character-tier macro (the only writable provider). */
  defineMacro(name: string, body: string): void;
  removeMacro(name: string): boolean;
  /** Merged library, character > local > starter (shadowed entries omitted). */
  listMacroDefs(): ReadonlyArray<{ name: string; body: string; source?: MacroProvider }>;
  /** Local `.macro` file load errors ("file: error"); [] or absent = clean. */
  localMacroIssues?(): readonly string[];
  /** Carried-container gate incl. session identity ids (battery/trade/converse flows). */
  isCarried(container: string): boolean;
  start(): Promise<void>;
  dispose(): Promise<void>;
  onEvent(listener: (event: SessionEvent) => void): () => void;
  /** Estimated authoritative server tick right now. */
  estimatedTick(): number;
  /** Execute a slash line through the registry. */
  executeVerb(line: string): VerbExecutionResult | null;
  sendChat(channel: ChatSendChannel, body: string, targetId?: string): void;
  /** Movement: hold a compass direction (TTL-refreshed by key repeat). */
  holdDirection(wind: Wind, sprint: boolean, ttlMs?: number): void;
  /** Movement: timed walk order (macro-able `/walk`). */
  walk(wind: Wind, durationMs: number, sprint: boolean): void;
  stopMovement(): void;
  /** True while any movement key is held. */
  moving(): boolean;
  /** Queue-pane event feed: events with seq > since (never steals). */
  queueEventsSince(seq: number): { seq: number; events: readonly AbilityQueueEvent[] };
}

/** Node chat socket carrying the exact storefront Origin header — the hosted
 *  server admits sockets by Origin; browsers get theirs from the platform. */
export function hostedChatSocket(wsUrl: string, origin: string): WebSocket {
  return new WsWebSocket(wsUrl, { headers: { Origin: origin } }) as unknown as WebSocket;
}

const MOVE_KEY_TTL_MS = 260;
const TRACKER_INTERVAL_MS = 120;

export async function createGameSession(options: SessionOptions): Promise<GameSession> {
  const host: SuccessorHeadlessHost = await createSuccessorHeadlessHost(options);
  const state = host.state;
  const slice = host.slice;
  state.movementInputMode = "world"; // compass canon: W = raw -y = north
  // Preserve the wire identity supplied by the runner. The server's hello and
  // every authority snapshot are keyed by this actor; replacing it with the
  // authored slice follow actor makes source validation fail closed and leaves
  // all commands queued forever for dynamic TUI actors.

  const listeners = new Set<(event: SessionEvent) => void>();
  const emit = (event: SessionEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const survey = createSurveyStore();
  const tracker = createContactTracker();

  const registry = createVerbRegistry({
    state,
    slice,
    // Survey family canonicalization mirrors the 3D adapter's aliases.
    canonicalResourceFamily: (value) => canonicalFamily(value),
  });

  // Three-provider macro library: character (in-session defs, writable) >
  // local (read-only XDG `.macro` files) > starter (checked-in pack).
  const macroLibrary = createTuiMacroLibrary({ localDir: options.macroDir });
  // Macro-invoked LOCAL/QUERY verbs speak their result into the log — text
  // is this client's render path, so a macro's /where must answer out loud.
  // Authority verbs stay silent here; receipts/queue/combat narrate them.
  const macroRegistry: VerbRegistry = {
    ...registry,
    resolve(verb) {
      const entry = registry.resolve(verb);
      if (!entry || entry.class === "authority") return entry;
      return {
        ...entry,
        execute(args, invocation) {
          const result = entry.execute(args, invocation);
          if (result.text) emit({ kind: "system", text: `⟳ ${result.text}` });
          return result;
        },
      };
    },
  };
  const macros = createMacroEngine({
    registry: macroRegistry,
    caps: { tickRateHz: slice.tickRateHz },
    macros: macroLibrary,
  });

  // ── envelope tap ──────────────────────────────────────────────────────────
  const onEnvelope = host.onEnvelope;
  if (!onEnvelope) throw new Error("headless host lacks onEnvelope — driver surface changed");
  const unsubscribe = onEnvelope.call(host, (envelope: SuccessorDriverEnvelope) => {
    switch (envelope.type) {
      case "receipt": {
        macros.ingestReceipt({
          commandId: envelope.commandId,
          accepted: envelope.accepted,
          tick: envelope.tick,
          ...(envelope.reasonCode ? { reasonCode: envelope.reasonCode } : {}),
          ...(envelope.commandKind ? { kind: envelope.commandKind } : {}),
        });
        emit({
          kind: "receipt",
          commandId: envelope.commandId,
          accepted: envelope.accepted,
          tick: envelope.tick,
          ...(envelope.reasonCode ? { reasonCode: envelope.reasonCode } : {}),
          ...(envelope.commandKind ? { commandKind: envelope.commandKind } : {}),
        });
        return;
      }
      case "event": {
        if (envelope.event === "combat") {
          const raw = envelope.data?.event;
          if (isRecord(raw)) emit({ kind: "combat", event: raw });
          return;
        }
        if (envelope.event === "ability_queue") {
          const event = parseQueueEvent(envelope.data?.event);
          if (event) {
            queueEvents.push(event);
            queueSeq += 1;
            if (queueEvents.length > 64) queueEvents.splice(0, queueEvents.length - 64);
            emit({ kind: "queue", event });
          }
          return;
        }
        if (envelope.event === "survey_result") {
          const payload = parseSurveyResult(envelope.data?.payload);
          if (payload) {
            const areaId = payload.areaId || state.activeAreaId;
            survey.ingest(areaId, payload);
            emit({ kind: "survey", areaId, result: payload });
          }
          return;
        }
        if (envelope.event === "trade_session") {
          // VM already ingested into state.serverAuthority.tradeSession by the
          // host; the event just tells narrators a delivery landed.
          emit({ kind: "trade" });
          return;
        }
        if (envelope.event === "duel_outcome") {
          const outcome = parseDuelOutcome(envelope.data?.payload);
          if (outcome) emit({ kind: "duelOutcome", outcome });
          return;
        }
        if (envelope.event === "splice_session") {
          emit({ kind: "splice" });
          return;
        }
        if (envelope.event === "genome_scan") {
          emit({ kind: "genomeScan" });
          return;
        }
        return;
      }
      case "status": {
        emit({ kind: "status", status: envelope.status, ...(envelope.message ? { message: envelope.message } : {}) });
        return;
      }
      case "query":
        return;
    }
  });

  // ── queue event ring (pane feed) ─────────────────────────────────────────
  const queueEvents: AbilityQueueEvent[] = [];
  let queueSeq = 0;

  // ── movement controller ───────────────────────────────────────────────────
  const keyExpiry = new Map<string, number>();
  let walkOrder: { keys: readonly string[]; untilMs: number; sprint: boolean } | null = null;

  const applyKeys = (nowMs: number): void => {
    // expire held keys
    for (const [code, until] of keyExpiry) {
      if (nowMs >= until) {
        keyExpiry.delete(code);
        state.keys.delete(code);
        const at = state.movementKeyOrder.indexOf(code);
        if (at !== -1) state.movementKeyOrder.splice(at, 1);
      }
    }
    // walk orders re-assert their keys until the deadline
    if (walkOrder) {
      if (nowMs >= walkOrder.untilMs) {
        for (const code of walkOrder.keys) releaseKey(code);
        if (walkOrder.sprint) releaseKey("ShiftLeft");
        walkOrder = null;
      } else {
        for (const code of walkOrder.keys) pressKey(code, nowMs + MOVE_KEY_TTL_MS);
        if (walkOrder.sprint) pressKey("ShiftLeft", nowMs + MOVE_KEY_TTL_MS);
      }
    }
  };

  const pressKey = (code: string, untilMs: number): void => {
    keyExpiry.set(code, Math.max(keyExpiry.get(code) ?? 0, untilMs));
    if (!state.keys.has(code)) {
      state.keys.add(code);
      state.movementKeyOrder.push(code);
    }
  };

  const releaseKey = (code: string): void => {
    keyExpiry.delete(code);
    state.keys.delete(code);
    const at = state.movementKeyOrder.indexOf(code);
    if (at !== -1) state.movementKeyOrder.splice(at, 1);
  };

  // ── cadence: tracker diffs, macro ticks, key TTL ──────────────────────────
  const interval = setInterval(() => {
    const nowMs = Date.now();
    applyKeys(nowMs);
    const estimated = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
    macros.tick(estimated);
    const events = tracker.update(state);
    if (events.arrivals.length > 0 || events.departures.length > 0 || events.attitudeShifts.length > 0 || events.corpses.length > 0) {
      emit({ kind: "contacts", events });
    }
  }, TRACKER_INTERVAL_MS);

  // ── chat ──────────────────────────────────────────────────────────────────
  let chat: ChatClient | null = null;
  if (options.chatUrl) {
    chat = createChatClient({
      self: {
        id: options.playerId ?? options.actorId ?? "headless-tui",
        displayName: options.displayName ?? "TUI Operative",
        status: "online",
        since: new Date().toISOString(),
      },
      zoneId: options.zoneId ?? "open-desert",
      // one-use split capability: first frame only, then gone (chatClient
      // clears its copy on send; ours goes right here)
      ...(options.chatTicket ? { authTicket: options.chatTicket } : {}),
      onFailure: () => emit({ kind: "status", status: "chat-failed", message: "the chat leg closed" }),
      ...(options.origin ? { socketFactory: (wsUrl: string) => hostedChatSocket(wsUrl, options.origin!) } : {}),
    });
    options.chatTicket = undefined;
    chat.subscribe((event) => {
      if (event.type === "message-appended") emit({ kind: "chat", message: event.message });
    });
    chat.connect(options.chatUrl);
  }

  return {
    state,
    slice,
    registry,
    macros,
    survey,
    tracker,
    chat,
    defineMacro(name, body) {
      macroLibrary.define(name, body);
    },
    removeMacro(name) {
      return macroLibrary.remove(name);
    },
    listMacroDefs() {
      return macroLibrary.listDefs();
    },
    localMacroIssues() {
      return macroLibrary.localIssues();
    },
    isCarried(container) {
      return isCarriedContainer(state, container, [options.playerId, options.characterId]);
    },
    async start() {
      await host.start();
    },
    async dispose() {
      clearInterval(interval);
      unsubscribe();
      chat?.dispose();
      await host.close();
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    estimatedTick() {
      return authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
    },
    executeVerb(line) {
      return registry.executeLine(line);
    },
    sendChat(channel, body, targetId) {
      chat?.send(channel, body, targetId);
    },
    holdDirection(wind, sprint, ttlMs = MOVE_KEY_TTL_MS) {
      const nowMs = Date.now();
      walkOrder = null;
      for (const code of keysForWind(wind)) pressKey(code, nowMs + ttlMs);
      if (sprint) pressKey("ShiftLeft", nowMs + ttlMs);
    },
    walk(wind, durationMs, sprint) {
      walkOrder = { keys: keysForWind(wind), untilMs: Date.now() + Math.max(50, durationMs), sprint };
    },
    stopMovement() {
      walkOrder = null;
      for (const code of [...keyExpiry.keys()]) releaseKey(code);
    },
    moving() {
      return keyExpiry.size > 0 || walkOrder !== null;
    },
    queueEventsSince(seq) {
      if (seq >= queueSeq) return { seq: queueSeq, events: [] };
      const missed = Math.min(queueEvents.length, queueSeq - seq);
      return { seq: queueSeq, events: queueEvents.slice(queueEvents.length - missed) };
    },
  };
}

/** Survey family aliases (3D store parity). */
const FAMILY_ALIAS: Record<string, string> = {
  metal: "metal",
  iron: "metal",
  ferrite: "metal",
  mineral: "metal",
  minerals: "metal",
  ore: "metal",
  copper: "copper",
  cuprite: "copper",
  cu: "copper",
  conductor: "copper",
  carbon: "carbon",
  coal: "carbon",
  carbonite: "carbon",
  graphite: "carbon",
};

export function canonicalFamily(value: string | null | undefined): string {
  const key = value?.trim().toLowerCase() ?? "";
  if (key.length === 0) return "metal";
  return FAMILY_ALIAS[key] ?? key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow a driver envelope's ability-queue event to the typed beat shape. */
function parseQueueEvent(raw: unknown): AbilityQueueEvent | null {
  if (!isRecord(raw)) return null;
  const { id, lifecycle, tick, reasonCode, fireSeq, abilityId, iconId } = raw;
  if (typeof id !== "string") return null;
  if (lifecycle !== "enqueued" && lifecycle !== "pending" && lifecycle !== "fired" && lifecycle !== "dismissed") return null;
  if (typeof tick !== "number") return null;
  return {
    id,
    lifecycle,
    tick,
    ...(typeof reasonCode === "string" ? { reasonCode } : {}),
    ...(typeof fireSeq === "number" ? { fireSeq } : {}),
    ...(typeof abilityId === "string" ? { abilityId } : {}),
    ...(typeof iconId === "string" ? { iconId } : {}),
  };
}

/** Narrow a surveyResult payload; field set mirrors the 3D store's ingest gate. */
function parseSurveyResult(raw: unknown): ServerAuthoritySurveyResultState | null {
  if (!isRecord(raw)) return null;
  const {
    areaId, family, spawnId, spawnName, centerX, centerY,
    rangeCells, stepCells, cols, rows, concentrationMilli, cooldownUntilTick, tick,
  } = raw;
  if (typeof family !== "string" || family.length === 0) return null;
  if (typeof centerX !== "number" || typeof centerY !== "number") return null;
  if (typeof rangeCells !== "number" || rangeCells <= 0) return null;
  if (typeof stepCells !== "number" || stepCells <= 0) return null;
  if (typeof cols !== "number" || !Number.isInteger(cols) || cols <= 1) return null;
  if (typeof rows !== "number" || !Number.isInteger(rows) || rows <= 1) return null;
  if (!Array.isArray(concentrationMilli) || concentrationMilli.length !== cols * rows) return null;
  if (concentrationMilli.some((value) => typeof value !== "number")) return null;
  return {
    areaId: typeof areaId === "string" ? areaId : "",
    family,
    spawnId: typeof spawnId === "string" ? spawnId : "",
    spawnName: typeof spawnName === "string" ? spawnName : "",
    centerX,
    centerY,
    rangeCells,
    stepCells,
    cols,
    rows,
    concentrationMilli: concentrationMilli as number[],
    cooldownUntilTick: typeof cooldownUntilTick === "number" ? cooldownUntilTick : 0,
    tick: typeof tick === "number" ? tick : 0,
  };
}
