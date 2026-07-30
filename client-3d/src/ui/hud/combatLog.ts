import type { PlayState, ServerAuthorityCombatEventState } from "@successor/client/src/slice-core/gameState";
import { weaponDisplayName } from "../theme";
import { cleanActorName } from "./actorNames";

/**
 * COMBAT LOG feed — the pure builder behind the chat pane's COMBAT tab
 * (owner directive 2026-07-08: the bottom-center strip retires; DETAILED
 * combat logging lives in chat).
 *
 * Sources (own-session truth only — visibility-law trivial):
 *  - `serverAuthority.eventLog` via the monotonic `event.id` cursor: swings
 *    in AND out (hit/miss/dodge/shield-deflect/sleep), damage + body zone +
 *    weapon/action label, downed/killed lifecycles with cause.
 *  - `serverAuthority.receiptLog` (identity cursor over the 128-ring):
 *    combat command receipts, kind-resolved through `sentCommandLog` so a
 *    movement or exchange deny can never read as a combat line. Rejects map
 *    to short player nouns; accepted Peace reads as STAND DOWN.
 *  - Own-actor profession snapshots: per-track XP deltas ("+12 RIFLE XP"),
 *    baselined on first sight so a fresh join never fabricates grants.
 *
 * Death readability (Main ruling): YOUR downed/killed line carries the
 * killer's name + weapon with emphasis; your killing blow gets the same
 * weight in celebration. Both render as full-strength emphasized rows.
 *
 * Pure TS: no DOM, no clocks beyond receivedAtMs already on the wire types —
 * unit-tested under the node vitest environment. Drain is allocation-light:
 * one array per quiet-or-busy drain, no per-frame work when idle.
 */
export type CombatLogTone =
  | "out-good"
  | "out-bad"
  | "in-bad"
  | "kill"
  | "death"
  | "xp"
  | "reject"
  | "info";

export interface CombatLogLine {
  /** Monotonic per-feed line id (scrollback keys). */
  id: number;
  atMs: number;
  tick: number;
  text: string;
  tone: CombatLogTone;
  /** Death/kill readability rows — the pane renders these full-strength. */
  emphasis?: boolean;
}

export interface CombatLogFeed {
  /** New lines since the last drain (ordered; empty when quiet). */
  drain(): CombatLogLine[];
}

/** Combat command kinds whose receipts belong in this feed. */
const COMBAT_RECEIPT_KINDS: Record<string, true> = {
  QueueCombatAction: true,
  CancelAbilityQueue: true,
  Peace: true,
};

/**
 * Deny / dismissal copy — single owner for combat HUD vocabulary.
 * Queue pane imports `combatReasonCopy` so reject stamps never drift.
 */
export const COMBAT_REASON_COPY: Record<string, string> = {
  out_of_range: "RANGE",
  los_blocked: "NO LOS",
  no_weapon_equipped: "NO WEAPON",
  weapon_not_certified: "UNCERTIFIED",
  insufficient_action: "LOW ACTION",
  ammo_unavailable: "NO AMMO",
  melee_while_kneeling: "KNEELING",
  posture_locked: "POSTURE",
  actor_not_alive: "DEAD",
  actor_asleep: "STUNNED",
  target_unavailable: "NO TARGET",
  queue_full: "QUEUE FULL",
  queue_entry_unknown: "NOT QUEUED",
  wrong_combat_model: "WRONG MODE",
  ingress_budget_exhausted: "TOO FAST",
  not_in_combat: "NOT ENGAGED",
  already_peaceful: "ALREADY CLEAR",
  ability_not_ready: "NOT READY",
  on_cooldown: "COOLDOWN",
  target_dead: "TARGET DOWN",
  invalid_target: "BAD TARGET",
  self_target: "SELF",
  facing_required: "FACE TARGET",
};

export function combatReasonCopy(code: string | undefined | null): string {
  if (!code) return "DENIED";
  const key = code.trim();
  if (!key) return "DENIED";
  return COMBAT_REASON_COPY[key] ?? key.replace(/[-_]/g, " ").toUpperCase();
}

const ACTION_LABEL: Record<string, string> = {
  basic_shot: "SHOT",
  aimed_shot: "AIMED SHOT",
  melee_strike: "STRIKE",
};

const ZONE_LABEL: Record<string, string> = {
  head: "HEAD",
  torso: "TORSO",
  left_arm: "L ARM",
  right_arm: "R ARM",
  legs: "LEGS",
};

/** Closed duel-end reasons from authority; never print raw developer codes. */
export type DuelOutcomeReason = "yield" | "down" | "range" | "timeout" | "disconnect";
export type DuelOutcomeResult = "won" | "lost" | "dissolved";

/** Player-facing opponent label — names only; never actor ids. */
export function duelOpponentLabel(opponentName: string | null | undefined): string {
  const trimmed = typeof opponentName === "string" ? opponentName.trim() : "";
  return (trimmed.length > 0 ? trimmed : "OPPONENT").toUpperCase().slice(0, 28);
}

/** Short COMBAT-tab duel result line from the closed outcome union. */
export function formatDuelOutcomeLine(outcome: {
  result?: string | null;
  reason?: string | null;
  opponentName?: string | null;
}): string {
  const opponent = duelOpponentLabel(outcome.opponentName);
  const result = outcome.result;
  const reason = outcome.reason;
  if (result === "won") {
    if (reason === "yield") return `DUEL WON · ${opponent} YIELDED`;
    if (reason === "down") return `DUEL WON · ${opponent} FALLS`;
    return `DUEL WON · ${opponent}`;
  }
  if (result === "lost") {
    if (reason === "yield") return "DUEL LOST · YOU YIELDED";
    if (reason === "down") return "DUEL LOST · YOU FELL";
    return `DUEL LOST · ${opponent}`;
  }
  if (reason === "range") return "DUEL ENDS · OUT OF RANGE";
  if (reason === "timeout") return "DUEL ENDS · TIME";
  if (reason === "disconnect") return "DUEL ENDS · DISCONNECT";
  return "DUEL ENDS";
}

export function createCombatLogFeed(state: PlayState): CombatLogFeed {
  let nextLineId = 1;
  let lastEventId = latestEventId(state);
  let lastReceipt: object | null = state.serverAuthority.receiptLog.at(-1) ?? null;
  let lastDuelOutcome: object | null = state.serverAuthority.duelOutcomes.at(-1) ?? null;
  // XP baseline: professionId → trackKey → xp. Seeded lazily on the first
  // sight of a professions snapshot so join-sync never reads as grants.
  let xpBaseline: Map<string, number> | null = null;
  // Suppress identical back-to-back lines (re-streamed rejects / double drains).
  let lastTextKey = "";

  const line = (
    atMs: number,
    tick: number,
    text: string,
    tone: CombatLogTone,
    emphasis?: boolean,
  ): CombatLogLine | null => {
    const key = `${tone}\u0000${text}`;
    if (key === lastTextKey) return null;
    lastTextKey = key;
    return {
      id: nextLineId++,
      atMs,
      tick,
      text,
      tone,
      ...(emphasis ? { emphasis: true } : {}),
    };
  };

  const push = (
    out: CombatLogLine[],
    atMs: number,
    tick: number,
    text: string,
    tone: CombatLogTone,
    emphasis?: boolean,
  ): void => {
    const built = line(atMs, tick, text, tone, emphasis);
    if (built) out.push(built);
  };

  const drainEvents = (out: CombatLogLine[]): void => {
    const me = playerId(state);
    for (const event of state.serverAuthority.eventLog) {
      if (event.id <= lastEventId) continue;
      lastEventId = event.id;
      const outgoing = event.shooterActorId === me;
      const incoming = event.targetActorId === me && event.shooterActorId !== me;
      // Own swings + swings that hit me. Third-party world noise stays out of
      // the chat feed (floating text / VFX still paint it in-world).
      if (!outgoing && !incoming) continue;
      const built = describeSwing(state, event, outgoing);
      if (built) push(out, event.receivedAtMs, event.tick, built.text, built.tone, built.emphasis);
    }
  };

  const drainReceipts = (out: CombatLogLine[]): void => {
    const log = state.serverAuthority.receiptLog;
    if (log.length === 0) return;
    let start = 0;
    if (lastReceipt) {
      for (let index = log.length - 1; index >= 0; index -= 1) {
        if (log[index] === lastReceipt) {
          start = index + 1;
          break;
        }
      }
    }
    for (let index = start; index < log.length; index += 1) {
      const receipt = log[index]!;
      const sent = state.serverAuthority.sentCommandLog.find((entry) => entry.commandId === receipt.commandId);
      if (!sent || !COMBAT_RECEIPT_KINDS[sent.kind]) continue;
      const atMs = receipt.receivedAtMs;
      const tick = receipt.tick;
      if (sent.kind === "Peace") {
        if (receipt.accepted) {
          push(out, atMs, tick, "STAND DOWN", "info");
        } else {
          push(out, atMs, tick, `STAND DOWN DENIED · ${combatReasonCopy(receipt.reasonCode)}`, "reject");
        }
        continue;
      }
      if (receipt.accepted) continue;
      if (sent.kind === "CancelAbilityQueue") {
        push(out, atMs, tick, `CLEAR DENIED · ${combatReasonCopy(receipt.reasonCode)}`, "reject");
        continue;
      }
      // QueueCombatAction (and future combat enqueue kinds).
      push(out, atMs, tick, `ATTACK DENIED · ${combatReasonCopy(receipt.reasonCode)}`, "reject");
    }
    lastReceipt = log[log.length - 1] ?? lastReceipt;
  };

  const drainDuelOutcomes = (out: CombatLogLine[]): void => {
    const queue = state.serverAuthority.duelOutcomes;
    if (queue.length === 0) return;
    let start = 0;
    if (lastDuelOutcome) {
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        if (queue[index] === lastDuelOutcome) {
          start = index + 1;
          break;
        }
      }
    }
    for (let index = start; index < queue.length; index += 1) {
      const outcome = queue[index]!;
      push(
        out,
        state.serverAuthority.lastReceipt?.receivedAtMs ?? 0,
        outcome.tick ?? state.serverAuthority.snapshotTick,
        formatDuelOutcomeLine(outcome),
        "info",
        true,
      );
    }
    lastDuelOutcome = queue[queue.length - 1] ?? lastDuelOutcome;
  };

  const drainXp = (out: CombatLogLine[], atMs: number, tick: number): void => {
    const me = playerId(state);
    const professions = state.serverAuthority.actors[me]?.professions;
    if (!professions) return;
    const current = new Map<string, number>();
    const labels = new Map<string, string>();
    for (const profession of professions) {
      const tracks = profession.trackXp;
      if (tracks && Object.keys(tracks).length > 0) {
        for (const [track, xp] of Object.entries(tracks)) {
          const key = `${profession.id}:${track}`;
          current.set(key, xp);
          labels.set(key, `${track.replace(/[-_]/g, " ")} XP`.toUpperCase());
        }
      } else {
        current.set(profession.id, profession.xp);
        labels.set(profession.id, `${profession.label} XP`.toUpperCase());
      }
    }
    if (xpBaseline === null) {
      xpBaseline = current; // first snapshot = baseline, never grants
      return;
    }
    for (const [key, xp] of current) {
      const before = xpBaseline.get(key) ?? 0;
      if (xp > before) push(out, atMs, tick, `+${xp - before} ${labels.get(key) ?? "XP"}`, "xp");
    }
    xpBaseline = current;
  };

  return {
    drain(): CombatLogLine[] {
      const out: CombatLogLine[] = [];
      drainEvents(out);
      drainReceipts(out);
      drainDuelOutcomes(out);
      const clockRef = out.at(-1);
      drainXp(
        out,
        clockRef?.atMs ?? state.serverAuthority.lastReceipt?.receivedAtMs ?? 0,
        clockRef?.tick ?? state.serverAuthority.snapshotTick,
      );
      return out;
    },
  };
}

interface SwingCopy {
  text: string;
  tone: CombatLogTone;
  emphasis?: boolean;
}

function describeSwing(state: PlayState, event: ServerAuthorityCombatEventState, outgoing: boolean): SwingCopy | null {
  const me = playerId(state);
  const opponentId = outgoing ? event.targetActorId : event.shooterActorId;
  const opponent = actorLabel(state, opponentId);
  const weapon = swingLabel(event);
  const lifecycleKind = event.lifecycle?.kind;
  const dodged = event.effect?.kind === "dodge" || event.lifecycle?.cause === "dodged";
  const deflected = event.effect?.kind === "shield" || event.lifecycle?.cause === "personal shield";
  const slept = event.effect?.kind === "sleep";
  const missed = event.hit === false && !dodged;
  const damage = event.damage > 0 ? ` −${event.damage}` : "";
  const zone = event.damage > 0 && ZONE_LABEL[event.zone] ? ` ${ZONE_LABEL[event.zone]}` : "";

  // MY death — the one line that must be findable at a glance.
  if (!outgoing && event.targetActorId === me && (lifecycleKind === "downed" || lifecycleKind === "killed")) {
    const verb = lifecycleKind === "killed" ? "KILLED" : "DOWNED";
    return { text: `YOU WERE ${verb} BY ${opponent} · ${weapon}${damage}`, tone: "death", emphasis: true };
  }
  // MY killing blow — slightly celebrated.
  if (outgoing && lifecycleKind === "killed") {
    return { text: `KILL — ${opponent} FALLS · ${weapon}${damage}`, tone: "kill", emphasis: true };
  }
  if (outgoing && lifecycleKind === "downed") {
    return { text: `${opponent} DOWNED · ${weapon}${damage}`, tone: "kill", emphasis: true };
  }

  if (dodged) {
    return outgoing
      ? { text: `${opponent} DODGED YOUR ${weapon}`, tone: "out-bad" }
      : { text: `YOU DODGED ${opponent}'S ${weapon}`, tone: "in-bad" };
  }
  if (deflected) {
    const shield = event.effect?.kind === "shield"
      ? ` (SHIELD ${event.effect.stacks}/${event.effect.threshold})`
      : "";
    return outgoing
      ? { text: `${opponent} BLOCKED YOUR ${weapon}${shield}`, tone: "out-bad" }
      : { text: `YOU BLOCKED ${opponent}'S ${weapon}${shield}`, tone: "in-bad" };
  }
  if (missed) {
    return outgoing
      ? { text: `YOU → ${opponent} · ${weapon} MISS`, tone: "out-bad" }
      : { text: `${opponent} → YOU · ${weapon} MISS`, tone: "in-bad" };
  }
  const sleepNote = slept && event.effect?.kind === "sleep"
    ? ` · SLEEP ${event.effect.stacks}/${event.effect.threshold}`
    : "";
  const bleed = event.bleedStackCount > 0 ? ` · BLEED ×${event.bleedStackCount}` : "";
  // A damage number IS the hit (C1) — "HIT −9" said it twice. Zero-damage
  // connects (fresh sleep stack, full absorb) still spell HIT.
  const landed = damage ? `${damage}${zone}` : " HIT";
  return outgoing
    ? { text: `YOU → ${opponent} · ${weapon}${landed}${sleepNote}${bleed}`, tone: "out-good" }
    : { text: `${opponent} → YOU · ${weapon}${landed}${sleepNote}${bleed}`, tone: "in-bad" };
}

function swingLabel(event: ServerAuthorityCombatEventState): string {
  if (event.actionId && ACTION_LABEL[event.actionId]) return ACTION_LABEL[event.actionId]!;
  if (event.actionId) return event.actionId.replace(/[-_]/g, " ").toUpperCase();
  if (event.weaponId) return weaponDisplayName(event.weaponId);
  return "STRIKE";
}

function actorLabel(state: PlayState, actorId: string): string {
  // Clean-name chain (C1): the type read stays out of the combat feed.
  return cleanActorName(state.serverAuthority.actors[actorId], actorId).toUpperCase().slice(0, 28);
}

function playerId(state: PlayState): string {
  return state.serverAuthority.playerActorId ?? state.playerActorId;
}

function latestEventId(state: PlayState): number {
  let max = 0;
  for (const event of state.serverAuthority.eventLog) {
    if (event.id > max) max = event.id;
  }
  return max;
}
