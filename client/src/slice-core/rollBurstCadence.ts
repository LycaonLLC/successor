/**
 * Cosmetic roll-bolt burst cadence shared by audio and 3D tracer presentation.
 * The server resolves a burst atomically; clients stagger only the readout.
 */
export const ROLL_BURST_STAGGER_MS = 115;
export const ROLL_BURST_ORDINAL_RESET_MS = 4_000;

export interface RollBurstOrdinalEvent {
  tick: number;
  shooterActorId: string;
  targetActorId: string;
  actionId?: string | null;
}

export function rollBurstOrdinalKey(event: RollBurstOrdinalEvent): string {
  return `${event.tick}:${event.shooterActorId}:${event.targetActorId}:${event.actionId ?? ""}`;
}

export function rollBurstDelayMsForOrdinal(ordinal: number): number {
  return Math.min(5, Math.max(0, ordinal)) * ROLL_BURST_STAGGER_MS;
}
