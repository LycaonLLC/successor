/** Eager loot window id + target binding (F-prompt / chip seams). */
export const LOOT_WINDOW_ID = "loot";

export interface LootTarget {
  kind: "corpse" | "cache" | "playerCorpse";
  /** Corpse: authority actor id. Cache: prop id. PlayerCorpse: durable corpse id. */
  id: string;
  /** Exact authored container for caches; legacy caches derive cache:<id>. */
  container?: string;
}

let lootTarget: LootTarget | null = null;

export function setLootTarget(target: LootTarget): void {
  lootTarget = target;
}

/** Currently bound loot target (chip-suppression seam). */
export function lootTargetRef(): LootTarget | null {
  return lootTarget;
}
