/**
 * HOLD-F TAKE-ALL state (owner ruling 2026-07-08: tap F opens the loot window,
 * HOLD F ≥1s take-alls the target). A module-level singleton — the codebase's
 * transient-UI idiom (cf. lootTarget, packUpConfirm) — so three call sites share
 * ONE truth without prop-drilling:
 *   - input.ts arms it on F-down over a lootable and releases on F-up,
 *   - interactPrompt.tick fires the client-loop take-all at the threshold,
 *   - interactChip reads the fill ratio to paint the radial on the [F] key box.
 *
 * The take-all itself is the honest v1: a client loop of per-stack TakeLootItem
 * (enqueueTakeAllLootStacks) — no new authority command.
 */
export const HOLD_TO_TAKE_ALL_MS = 1000;

export interface LootHoldState {
  /** Interaction option id (matches the chip's optionId) being held. */
  optionId: string;
  /** Resolved loot container (`corpse:<id>` / `cache:<id>`). */
  container: string;
  /** Target label for the take-all toast. */
  label: string;
  startMs: number;
  fired: boolean;
}

let hold: LootHoldState | null = null;

export function beginLootHold(optionId: string, container: string, label: string, nowMs: number): void {
  hold = { optionId, container, label, startMs: nowMs, fired: false };
}

export function cancelLootHold(): void {
  hold = null;
}

export function activeLootHold(): LootHoldState | null {
  return hold;
}

export function markLootHoldFired(): void {
  if (hold) hold.fired = true;
}

/** Fill ratio 0..1 for the option under the chip, or null when it is not held. */
export function lootHoldProgressForOption(optionId: string, nowMs: number): number | null {
  if (!hold || hold.optionId !== optionId) return null;
  const elapsed = nowMs - hold.startMs;
  return Math.max(0, Math.min(1, elapsed / HOLD_TO_TAKE_ALL_MS));
}
