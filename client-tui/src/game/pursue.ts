/**
 * Pursue — action-at-range as movement intent.
 *
 * Owner law (2026-07-09): a use-but-out-of-range action should establish
 * move intent toward its target and act on arrival. This module is the
 * ACTION-AGNOSTIC core: a deterministic machine (IDLE→PURSUING→IN_RANGE→
 * ENGAGED) that walks the player toward a target's AOI-streamed position,
 * then hands control to a consumer's engage callback. `/attack` is
 * consumer #1 (band = the equipped weapon's range bands); future consumers
 * (converse / loot / extractor / F-use) bind their own bands and guard
 * flags (`abortWhenHurt`, `maxApproachCells`).
 *
 * Laws honored here:
 * - Visibility: the machine knows the target's position ONLY while it
 *   streams in `serverAuthority.actors`. The stream dies → the pursuit
 *   dies with it, spoken honestly.
 * - Budget truth: movement rides the session's key-driven walk orders (the
 *   same SetMoveIntent cadence as a hand on WASD). A budget-denied move
 *   receipt halts the walk instead of hammering the bucket.
 * - Player wins instantly: any player movement or conflicting command
 *   interrupts; the machine never argues.
 * - Voice: every state change speaks ONCE through the pursue register;
 *   steady states stay silent.
 */

import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { isMeleeWeaponPresentation } from "@successor/client/src/slice-core/weaponSystem";

import { composePursueBeat } from "../language/registers/pursue";
import { createVoiceMemory } from "../language/voice";
import { RADAR_RADIUS_CELLS, windFor, type Wind } from "./bearing";
import type { GameSession, SessionEvent } from "./session";

// ── approach bands ──────────────────────────────────────────────────────────

export interface ApproachBand {
  /** Stop-and-act distance (cells): ranged = the weapon's optimal band, melee = reach. */
  desiredCells: number;
  /** Action legality horizon (cells): beyond it the act denies RANGE. */
  maxCells: number;
  melee: boolean;
}

/**
 * Derive the /attack approach band from projected authority tuning:
 * 1. own actor's `.weapon` (AOI stream) names the equipped weapon;
 * 2. `slice.combatTuning.weaponRangeBands[weaponId]` supplies the exact
 *    ideal and legal maximum used by the Rust authority for this world.
 * Returns null when the weapon or its tuning is not projected. The attack
 * then falls through to the normal authority command instead of guessing a
 * movement band from a client-side combat table.
 */
export function attackApproachBand(state: PlayState, slice: SliceSnapshot): ApproachBand | null {
  const meId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const me = state.serverAuthority.actors[meId];
  const weapon = me?.weapon;
  if (!weapon || !weapon.weaponId) return null;
  const melee = isMeleeWeaponPresentation(weapon.weaponId, weapon.ammoType);
  const tuned = slice.combatTuning?.weaponRangeBands?.[weapon.weaponId];
  if (!tuned) return null;
  return { desiredCells: tuned.idealCells, maxCells: tuned.maxCells, melee };
}

// ── cadence + guard constants ───────────────────────────────────────────────

/** Pursue evaluation cadence (ms) — the narrator poll cadence both surfaces already run. */
export const PURSUE_TICK_MS = 400;
/** Walk-order TTL per refresh — outlives one missed tick, dies fast after an abort. */
export const WALK_ORDER_MS = 700;
/** Default leg timeout; each re-pursue leg re-arms it. CLI: --pursue-timeout-ms. */
export const DEFAULT_PURSUE_TIMEOUT_MS = 45_000;
/** Default approach cap: the radar horizon. Your scope is your leash. */
export const DEFAULT_MAX_APPROACH_CELLS = RADAR_RADIUS_CELLS;
/** How long IN_RANGE waits for the engage receipt before calling it dead. */
const ENGAGE_RECEIPT_GRACE_MS = 8_000;

// ── beats (typed narration events; prose lives in language/registers/pursue) ──

export type PursueAbortReason =
  | "target_dead"
  | "target_lost"
  | "player_move"
  | "player_command"
  | "budget"
  | "timeout"
  | "attack_denied"
  | "too_far"
  | "hurt";

export type PursueBeat =
  | { kind: "start"; label: string; dCells: number; band: ApproachBand }
  | { kind: "level_off"; label: string; dCells: number; band: ApproachBand }
  | { kind: "repursue"; label: string; dCells: number }
  | { kind: "abort"; reason: PursueAbortReason; label: string; dCells?: number };

// ── machine ─────────────────────────────────────────────────────────────────

export type PursuePhase = "idle" | "pursuing" | "in_range" | "engaged";

export type PursueInterruptSource = "movement" | "command";

/** One evaluation frame of world truth, assembled by the controller. */
export interface PursueWorldView {
  nowMs: number;
  /** Own AOI position; null when the own-actor stream is absent. */
  self: { x: number; y: number } | null;
  selfHealth: number | null;
  selfAlive: boolean;
  /** Target AOI truth; null = not in scope (stream died — visibility law). */
  target: { x: number; y: number; alive: boolean } | null;
}

export type PursueEffect =
  | { kind: "walk"; wind: Wind }
  | { kind: "stop" }
  | { kind: "engage" }
  | { kind: "beat"; beat: PursueBeat };

export interface PursueMachineOptions {
  targetId: string;
  targetLabel: string;
  band: ApproachBand;
  timeoutMs?: number;
  maxApproachCells?: number;
  /** Use-consumers abort when damaged mid-walk; the attack consumer walks anyway. */
  abortWhenHurt?: boolean;
}

export interface PursueMachine {
  readonly targetId: string;
  readonly targetLabel: string;
  readonly band: ApproachBand;
  phase(): PursuePhase;
  /** Arm the pursuit from a world snapshot; emits the start beat + first walk. */
  start(world: PursueWorldView): PursueEffect[];
  /** Cadenced evaluation (PURSUE_TICK_MS). */
  tick(world: PursueWorldView): PursueEffect[];
  /** Player movement/conflicting command — the player wins instantly. */
  interrupt(source: PursueInterruptSource): PursueEffect[];
  /** Consumer reports the engage verb's immediate result. */
  noteEngageResult(queued: boolean, commandId: number | null, world: PursueWorldView): PursueEffect[];
  /** Wire receipts (movement budget denials + the engage receipt). */
  receipt(
    receipt: { commandKind?: string; accepted: boolean; reasonCode?: string; commandId: number },
    world: PursueWorldView,
  ): PursueEffect[];
  /** Own ability-queue lifecycle events (kite detection via out_of_range dismissals). */
  queueEvent(event: { lifecycle: string; reasonCode?: string }, world: PursueWorldView): PursueEffect[];
}

export function createPursueMachine(options: PursueMachineOptions): PursueMachine {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PURSUE_TIMEOUT_MS;
  const maxApproachCells = options.maxApproachCells ?? DEFAULT_MAX_APPROACH_CELLS;
  const abortWhenHurt = options.abortWhenHurt === true;

  let phase: PursuePhase = "idle";
  let legStartedAtMs = 0;
  let engageSentAtMs = 0;
  let engageCommandId: number | null = null;
  let lastHealth: number | null = null;

  const distance = (world: PursueWorldView): number | null =>
    world.self && world.target ? Math.hypot(world.target.x - world.self.x, world.target.y - world.self.y) : null;

  const abort = (reason: PursueAbortReason, world: PursueWorldView, opts: { silent?: boolean; stop?: boolean } = {}): PursueEffect[] => {
    const wasMoving = phase === "pursuing";
    phase = "idle";
    const effects: PursueEffect[] = [];
    if (opts.stop !== false && (wasMoving || opts.stop === true)) effects.push({ kind: "stop" });
    if (!opts.silent) {
      const d = distance(world);
      effects.push({ kind: "beat", beat: { kind: "abort", reason, label: options.targetLabel, ...(d !== null ? { dCells: d } : {}) } });
    }
    return effects;
  };

  /** Shared target-truth gate for every phase; null = target still standing. */
  const targetGate = (world: PursueWorldView): PursueEffect[] | null => {
    if (!world.selfAlive) return abort("player_move", world, { silent: true }); // own death: the death narration owns the moment
    if (!world.target) return abort("target_lost", world);
    if (!world.target.alive) {
      // Mid-walk the kill is someone else's — speak the stand-down. Once
      // ENGAGED the combat register already narrates the kill; stay silent.
      return abort("target_dead", world, { silent: phase === "engaged" });
    }
    return null;
  };

  const beginLeg = (world: PursueWorldView, beat: "start" | "repursue"): PursueEffect[] => {
    const d = distance(world);
    if (d === null) return abort("target_lost", world);
    phase = "pursuing";
    legStartedAtMs = world.nowMs;
    lastHealth = world.selfHealth;
    const effects: PursueEffect[] = [];
    if (beat === "start") {
      effects.push({ kind: "beat", beat: { kind: "start", label: options.targetLabel, dCells: d, band: options.band } });
    } else {
      effects.push({ kind: "beat", beat: { kind: "repursue", label: options.targetLabel, dCells: d } });
    }
    effects.push(...walkOrLevelOff(world, d));
    return effects;
  };

  const walkOrLevelOff = (world: PursueWorldView, d: number): PursueEffect[] => {
    if (d <= options.band.desiredCells) {
      phase = "in_range";
      engageSentAtMs = world.nowMs;
      engageCommandId = null;
      return [
        { kind: "stop" },
        { kind: "beat", beat: { kind: "level_off", label: options.targetLabel, dCells: d, band: options.band } },
        { kind: "engage" },
      ];
    }
    if (!world.self || !world.target) return [];
    return [{ kind: "walk", wind: windFor(world.target.x - world.self.x, world.target.y - world.self.y) }];
  };

  return {
    targetId: options.targetId,
    targetLabel: options.targetLabel,
    band: options.band,
    phase: () => phase,

    start(world) {
      const gate = targetGate(world);
      if (gate) return gate;
      const d = distance(world);
      if (d === null) return abort("target_lost", world);
      if (d > maxApproachCells) return abort("too_far", world, { stop: false });
      return beginLeg(world, "start");
    },

    tick(world) {
      if (phase === "idle") return [];
      const gate = targetGate(world);
      if (gate) return gate;

      if (phase === "pursuing") {
        if (abortWhenHurt && lastHealth !== null && world.selfHealth !== null && world.selfHealth < lastHealth) {
          return abort("hurt", world);
        }
        lastHealth = world.selfHealth;
        const d = distance(world);
        if (d === null) return [];
        if (d > maxApproachCells) return abort("too_far", world);
        if (world.nowMs - legStartedAtMs > timeoutMs) return abort("timeout", world);
        return walkOrLevelOff(world, d);
      }

      if (phase === "in_range" && world.nowMs - engageSentAtMs > ENGAGE_RECEIPT_GRACE_MS) {
        return abort("attack_denied", world);
      }
      return [];
    },

    interrupt(source) {
      if (phase === "idle") return [];
      if (phase === "engaged") {
        // Not moving anymore — the fight is the server's; just stop watching.
        phase = "idle";
        return [];
      }
      const wasMoving = phase === "pursuing";
      phase = "idle";
      const effects: PursueEffect[] = [];
      if (wasMoving) effects.push({ kind: "stop" });
      effects.push({
        kind: "beat",
        beat: { kind: "abort", reason: source === "movement" ? "player_move" : "player_command", label: options.targetLabel },
      });
      return effects;
    },

    noteEngageResult(queued, commandId, world) {
      if (phase !== "in_range") return [];
      if (!queued) return abort("attack_denied", world, { stop: false });
      engageCommandId = commandId;
      return [];
    },

    receipt(receipt, world) {
      if (phase === "idle") return [];
      if (
        phase === "pursuing"
        && receipt.commandKind === "SetMoveIntent"
        && !receipt.accepted
        && receipt.reasonCode === "ingress_budget_exhausted"
      ) {
        // Honest halt: kill the walk order instead of hammering the bucket.
        return abort("budget", world);
      }
      if (phase === "in_range" && engageCommandId !== null && receipt.commandId === engageCommandId) {
        if (receipt.accepted) {
          phase = "engaged";
          return [];
        }
        if (receipt.reasonCode === "out_of_range") {
          // The target stepped out between arrival and the swing — chase again.
          const gate = targetGate(world);
          if (gate) return gate;
          return beginLeg(world, "repursue");
        }
        return abort("attack_denied", world, { stop: false });
      }
      return [];
    },

    queueEvent(event, world) {
      if (phase !== "engaged" || event.lifecycle !== "dismissed") return [];
      if (event.reasonCode === "out_of_range") {
        // Kiting: the server cleared the repeat intent at swing time — one
        // dismissal, one re-pursue narration, never spam (edge-triggered).
        const gate = targetGate(world);
        if (gate) return gate;
        return beginLeg(world, "repursue");
      }
      if (event.reasonCode) {
        // Any other dismissal (LOW ACTION, NO LOS…) already speaks through
        // the queue narrator; the fight is over — stand down silently.
        phase = "idle";
      }
      return [];
    },
  };
}

// ── controller: /attack bound to the machine (consumer #1) ─────────────────

/** A spoken line in router shape ({ register, text } — CommandLineOut-compatible). */
export interface PursueOutLine {
  register: string;
  text: string;
}

export interface PursuitControllerOptions {
  timeoutMs?: number;
  maxApproachCells?: number;
  now?: () => number;
}

export interface PursuitController {
  /**
   * Intercept an /attack line. Returns spoken lines when the pursuit takes
   * the verb (out-of-band target), or null to fall through to the registry
   * untouched (in range, unresolvable, no weapon, bad grammar — every deny
   * stays the wire's honest voice).
   */
  beginAttack(args: readonly string[]): PursueOutLine[] | null;
  /** Cadenced evaluation — call every PURSUE_TICK_MS (the narrator poll beat). */
  tick(): PursueOutLine[];
  /** Player movement / conflicting command — the player wins instantly. */
  interrupt(source: PursueInterruptSource): PursueOutLine[];
  /** Session events: receipts (budget/engage) + ability-queue lifecycles (kites). */
  onEvent(event: SessionEvent): PursueOutLine[];
  active(): boolean;
}

export function createPursuitController(session: GameSession, options: PursuitControllerOptions = {}): PursuitController {
  const now = options.now ?? Date.now;
  const memory = createVoiceMemory();
  let machine: PursueMachine | null = null;
  let pinnedActionId = "basic_shot";

  const world = (): PursueWorldView => {
    const state = session.state;
    const meId = state.serverAuthority.playerActorId ?? state.playerActorId;
    const me = state.serverAuthority.actors[meId];
    const target = machine ? state.serverAuthority.actors[machine.targetId] : undefined;
    const sameArea = target !== undefined && target.areaId === (me?.areaId ?? state.activeAreaId);
    return {
      nowMs: now(),
      self: me ? { x: me.x, y: me.y } : null,
      selfHealth: me ? me.vitals.health : null,
      selfAlive: me ? me.lifeState === "alive" : true,
      target: target !== undefined && sameArea
        ? { x: target.x, y: target.y, alive: target.lifeState === "alive" }
        : null,
    };
  };

  /** Run machine effects against the session; returns the spoken lines. */
  const applyEffects = (effects: PursueEffect[]): PursueOutLine[] => {
    const out: PursueOutLine[] = [];
    const queue = [...effects];
    while (queue.length > 0) {
      const effect = queue.shift()!;
      switch (effect.kind) {
        case "walk":
          session.walk(effect.wind, WALK_ORDER_MS, false);
          break;
        case "stop":
          session.stopMovement();
          break;
        case "beat": {
          const spoken = composePursueBeat(effect.beat, memory, session.estimatedTick());
          if (spoken) out.push(spoken);
          break;
        }
        case "engage": {
          if (!machine) break;
          const result = session.executeVerb(`/attack ${pinnedActionId} ${machine.targetId}`);
          if (!result || result.class !== "authority") {
            out.push({ register: "reject", text: result?.text ?? "Nothing answers — this shard predates the attack verb." });
            queue.push(...machine.noteEngageResult(false, null, world()));
            break;
          }
          const queued = result.data.queued === true;
          const commandId = typeof result.data.commandId === "number" ? result.data.commandId : null;
          out.push({ register: queued ? "receipt" : "reject", text: result.text });
          queue.push(...machine.noteEngageResult(queued, commandId, world()));
          break;
        }
      }
    }
    if (machine && machine.phase() === "idle") machine = null;
    return out;
  };

  /** Mirror of the curated attack target resolution over the TUI's contact tracker. */
  const resolveTargetId = (token: string | undefined): string | null => {
    const state = session.state;
    if (!token || token === "$target" || token === "$selected") {
      return state.selectedActorId ?? state.softLockActorId;
    }
    if (token === "$softlock" || token === "$softLock") return state.softLockActorId;
    const needle = token.toLowerCase();
    const contacts = session.tracker.contacts(); // nearest-first, AOI-only
    const exact = contacts.find((contact) => contact.id.toLowerCase() === needle || contact.label.toLowerCase() === needle);
    if (exact) return exact.id;
    return contacts.find((contact) => contact.id.toLowerCase().includes(needle) || contact.label.toLowerCase().includes(needle))?.id ?? null;
  };

  return {
    beginAttack(args) {
      const state = session.state;
      const entry = session.registry.resolve("attack");
      if (!entry || entry.class !== "authority") return null;
      // curated grammar mirror: [action] [target] — anything else falls
      // through so the registry speaks BAD ACTION itself
      const actionValues = entry.argSchema.find((arg) => arg.name === "action_id")?.enumValues ?? ["basic_shot", "aimed_shot"];
      const first = args[0]?.trim();
      const second = args[1]?.trim();
      const firstAsAction = first?.toLowerCase().replaceAll("-", "_");
      let actionId = "basic_shot";
      let targetToken = first;
      if (firstAsAction && actionValues.includes(firstAsAction)) {
        actionId = firstAsAction;
        targetToken = second;
      } else if (second !== undefined) {
        return null;
      }
      const targetId = resolveTargetId(targetToken);
      if (!targetId) return null; // registry speaks NO TARGET
      const meId = state.serverAuthority.playerActorId ?? state.playerActorId;
      const me = state.serverAuthority.actors[meId];
      const target = state.serverAuthority.actors[targetId];
      if (!me || !target || target.lifeState !== "alive" || target.areaId !== me.areaId) return null;
      const band = attackApproachBand(state, session.slice);
      if (!band) return null; // no projected band — the authority evaluates the direct attack
      const dCells = Math.hypot(target.x - me.x, target.y - me.y);
      if (dCells <= band.maxCells) return null; // already in range — verb behaves exactly as today

      const lines: PursueOutLine[] = [];
      if (machine) {
        if (machine.targetId === targetId) {
          return [{ register: "system", text: `Already closing on ${machine.targetLabel} — ${Math.round(dCells)}c out.` }];
        }
        lines.push(...applyEffects(machine.interrupt("command")));
      }
      const next = createPursueMachine({
        targetId,
        targetLabel: target.label,
        band,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.maxApproachCells !== undefined ? { maxApproachCells: options.maxApproachCells } : {}),
        abortWhenHurt: false, // the attack consumer walks through fire; use-consumers flip this
      });
      machine = next;
      pinnedActionId = actionId;
      lines.push(...applyEffects(next.start(world())));
      return lines;
    },

    tick() {
      if (!machine) return [];
      return applyEffects(machine.tick(world()));
    },

    interrupt(source) {
      if (!machine) return [];
      return applyEffects(machine.interrupt(source));
    },

    onEvent(event) {
      if (!machine) return [];
      if (event.kind === "receipt") {
        return applyEffects(machine.receipt({
          accepted: event.accepted,
          commandId: event.commandId,
          ...(event.commandKind !== undefined ? { commandKind: event.commandKind } : {}),
          ...(event.reasonCode !== undefined ? { reasonCode: event.reasonCode } : {}),
        }, world()));
      }
      if (event.kind === "queue") {
        return applyEffects(machine.queueEvent({
          lifecycle: event.event.lifecycle,
          ...(event.event.reasonCode !== undefined ? { reasonCode: event.event.reasonCode } : {}),
        }, world()));
      }
      return [];
    },

    active() {
      return machine !== null && machine.phase() !== "idle";
    },
  };
}
