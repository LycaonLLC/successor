/**
 * Duel voice + view (DEF-5 green half, DuelSim contract).
 *
 * The outcome beat arrives as the "duelOutcome" session message to BOTH
 * participants (perspective-relative result); the standing view streams
 * as `duels` on snapshot/delta (GameDuelView: activeDuel / incoming /
 * outgoing challenge). This module carries a structural twin of the
 * contract until DuelSim's canonical types land (groups precedent: one
 * import swap then), reading the stream defensively at runtime.
 */

import type { PlayState } from "@successor/client/src/slice-core/gameState";
import type { CommandLineOut } from "../commands";

// ── contract twins (successor duelOutcome / GameDuelView) ──────────────────

export interface DuelOutcomePayload {
  actorId: string;
  duelId: number;
  opponentActorId: string;
  opponentName: string;
  result: "won" | "lost" | "dissolved";
  reason: "yield" | "down" | "range" | "timeout" | "disconnect";
  tick: number;
}

export interface DuelChallengeFrame {
  otherActorId: string;
  otherName: string;
  issuedTick: number;
  expiresTick: number;
}

export interface GameDuelView {
  activeDuel?: { duelId: number; opponentActorId: string; opponentName: string; startedTick: number; expiresTick: number } | null;
  incomingChallenge?: DuelChallengeFrame | null;
  outgoingChallenge?: DuelChallengeFrame | null;
}

export function parseDuelOutcome(raw: unknown): DuelOutcomePayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const result = record.result;
  const reason = record.reason;
  if (result !== "won" && result !== "lost" && result !== "dissolved") return null;
  if (reason !== "yield" && reason !== "down" && reason !== "range" && reason !== "timeout" && reason !== "disconnect") return null;
  return {
    actorId: String(record.actorId ?? ""),
    duelId: Number(record.duelId ?? 0),
    opponentActorId: String(record.opponentActorId ?? ""),
    opponentName: String(record.opponentName ?? record.opponentActorId ?? "your opponent"),
    result,
    reason,
    tick: Number(record.tick ?? 0),
  };
}

/**
 * The outcome voice. Perspective-relative: my own yield/fall already spoke
 * through my command echo + receipt, so "lost" stays quiet beyond a close.
 */
export function composeDuelOutcome(outcome: DuelOutcomePayload): CommandLineOut | null {
  const name = `«${outcome.opponentName}»`;
  if (outcome.result === "won") {
    return {
      register: "world",
      text: outcome.reason === "down"
        ? `${name} falls — the duel is yours.`
        : `${name} lowers their weapon — the duel is yours.`,
    };
  }
  if (outcome.result === "dissolved") {
    const why = outcome.reason === "range" ? "too far apart"
      : outcome.reason === "timeout" ? "time runs out"
      : outcome.reason === "disconnect" ? "link lost"
      : "the ground gives out";
    return { register: "system", text: `The duel dissolves — ${why}.` };
  }
  // lost: my own yield/fall was already narrated by echo/receipt; stamp the close.
  return { register: "system", text: `The duel is ${name}'s.` };
}

/**
 * The streamed view (serverAuthority.duel, DuelSimFix 796fd25). Kept as a
 * structural read so pre-fix clients compile; the canonical default is an
 * empty object, which renders as "no duel" honestly.
 */
export function duelViewOf(state: PlayState): GameDuelView | null {
  const authority = state.serverAuthority as { duel?: GameDuelView | null };
  return authority.duel ?? null;
}

/** Bare /duel — the standing view: active duel, challenges with countdowns. */
export function duelStatusLines(state: PlayState, estimatedTick: number, tickRateHz: number): CommandLineOut[] {
  const view = duelViewOf(state);
  const seconds = (expiresTick: number): number => Math.max(0, Math.ceil((expiresTick - estimatedTick) / tickRateHz));
  const lines: CommandLineOut[] = [];
  if (view?.activeDuel) {
    lines.push({
      register: "world",
      text: `You are dueling «${view.activeDuel.opponentName}» — first yield or fall ends it (/duel yield bows out).`,
    });
  }
  if (view?.incomingChallenge) {
    lines.push({
      register: "world",
      text: `«${view.incomingChallenge.otherName}» has thrown the glove — /duel accept or /duel decline (${seconds(view.incomingChallenge.expiresTick)}s).`,
    });
  }
  if (view?.outgoingChallenge) {
    lines.push({
      register: "system",
      text: `Your challenge stands with «${view.outgoingChallenge.otherName}» (${seconds(view.outgoingChallenge.expiresTick)}s).`,
    });
  }
  if (lines.length === 0) {
    lines.push({ register: "system", text: "No duel on the ground. /duel <who> throws the challenge · accept|decline answers · yield ends with honor." });
  }
  return lines;
}
