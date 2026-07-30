import type { PlayState } from "@successor/client/src/slice-core/gameState";

/** Bounded duel-outcome tail on the browser probe (journey correlation only). */
export const DUEL_OUTCOME_PROBE_TAIL_LIMIT = 8;

type CanonicalDuelView = PlayState["serverAuthority"]["duel"];
type CanonicalDuelOutcome = PlayState["serverAuthority"]["duelOutcomes"][number];

/** Scalar active-duel projection — never aliases authority objects. */
export interface DuelProbeState {
  hasActiveDuel: boolean;
  activeDuelId: number;
  opponentActorId: string;
  opponentName: string;
  startedTick: number;
  expiresTick: number;
  hasIncomingChallenge: boolean;
  hasOutgoingChallenge: boolean;
}

/** Scalar duel-outcome row projected onto caller-owned probe storage. */
export interface DuelOutcomeProbeEntry {
  duelId: number;
  opponentName: string;
  result: string;
  reason: string;
  tick: number;
}

export function createEmptyDuelProbeState(): DuelProbeState {
  return {
    hasActiveDuel: false,
    activeDuelId: 0,
    opponentActorId: "",
    opponentName: "",
    startedTick: 0,
    expiresTick: 0,
    hasIncomingChallenge: false,
    hasOutgoingChallenge: false,
  };
}

/**
 * Copy active duel / challenge presence into caller-owned scalar storage.
 * No authority object aliasing; no per-frame allocation.
 */
export function syncDuelProbeState(
  target: DuelProbeState,
  view: CanonicalDuelView | null | undefined,
): void {
  const active = view?.activeDuel ?? null;
  target.hasActiveDuel = active != null;
  target.activeDuelId = active?.duelId ?? 0;
  target.opponentActorId = active?.opponentActorId ?? "";
  target.opponentName = active?.opponentName ?? "";
  target.startedTick = active?.startedTick ?? 0;
  target.expiresTick = active?.expiresTick ?? 0;
  target.hasIncomingChallenge = view?.incomingChallenge != null;
  target.hasOutgoingChallenge = view?.outgoingChallenge != null;
}

/**
 * Project the canonical duelOutcome ring into caller-owned probe storage.
 * Updates rows in place; frames with an unchanged tail allocate nothing.
 */
export function syncDuelOutcomeProbeTail(
  target: DuelOutcomeProbeEntry[],
  outcomes: readonly CanonicalDuelOutcome[],
): void {
  const start = Math.max(0, outcomes.length - DUEL_OUTCOME_PROBE_TAIL_LIMIT);
  const count = outcomes.length - start;
  for (let outputIndex = 0; outputIndex < count; outputIndex += 1) {
    const outcome = outcomes[start + outputIndex]!;
    const opponentName = typeof outcome.opponentName === "string" ? outcome.opponentName : "";
    const current = target[outputIndex];
    if (current) {
      current.duelId = outcome.duelId;
      current.opponentName = opponentName;
      current.result = outcome.result;
      current.reason = outcome.reason;
      current.tick = outcome.tick;
    } else {
      target.push({
        duelId: outcome.duelId,
        opponentName,
        result: outcome.result,
        reason: outcome.reason,
        tick: outcome.tick,
      });
    }
  }
  target.length = count;
}
