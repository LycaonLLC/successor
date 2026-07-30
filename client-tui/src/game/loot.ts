/**
 * Loot flows — the 3D loot window's semantics without the window.
 *
 * A corpse/cache surfaces ONLY when: present in the streamed world, within
 * the shared reach gate (HARVEST_INTERACTION_RADIUS ≈ 1.75c), lootable, and
 * either free-loot or rights-held by this session. Item rows come from the
 * streamed `corpse:<id>` / `cache:<id>` containers; every take is the
 * authoritative per-stack TakeLootItem command.
 */

import type { InventoryRow, PlayState } from "@successor/client/src/slice-core/gameState";
import {
  authorityIssuedAtServerTick,
  enqueueAuthorityTakeLootItemCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import type { SliceSnapshot } from "@successor/client/src/slice-core/gameState";

export const LOOT_REACH_CELLS = 1.75;

export interface LootTargetView {
  actorId: string;
  label: string;
  containerId: string;
  distanceCells: number;
  inReach: boolean;
  rightsMine: boolean;
  rows: InventoryRow[];
}

/** Nearest lootable corpse in reach (or the named one), 3D-window gates. */
export function resolveLootTarget(state: PlayState, requestedId?: string): LootTargetView | null {
  const meId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const me = state.serverAuthority.actors[meId];
  const px = me?.x ?? state.player.x;
  const py = me?.y ?? state.player.y;

  let best: LootTargetView | null = null;
  for (const actorId in state.serverAuthority.actors) {
    if (actorId === meId) continue;
    const actor = state.serverAuthority.actors[actorId];
    if (!actor || actor.lifeState === "alive" || !actor.lootable) continue;
    if (requestedId && actorId !== requestedId && !actor.label.toLowerCase().includes(requestedId.toLowerCase())) continue;
    const distanceCells = Math.hypot(actor.x - px, actor.y - py);
    const rights = actor.lootRightsActorId ?? null;
    const containerId = `corpse:${actorId}`;
    const view: LootTargetView = {
      actorId,
      label: actor.label,
      containerId,
      distanceCells,
      inReach: distanceCells <= LOOT_REACH_CELLS,
      rightsMine: rights === null || rights === meId,
      rows: state.inventory.filter((row) => row.container === containerId && row.available > 0),
    };
    if (!best || view.distanceCells < best.distanceCells) best = view;
  }
  return best;
}

export interface LootAllResult {
  queued: number;
  skipped: number;
  target: LootTargetView | null;
  reason: "no_target" | "out_of_reach" | "no_rights" | "empty" | null;
}

/** Take every available stack from the resolved corpse — one wire command per stack. */
export function lootAll(state: PlayState, slice: SliceSnapshot, requestedId?: string): LootAllResult {
  const target = resolveLootTarget(state, requestedId);
  if (!target) return { queued: 0, skipped: 0, target: null, reason: "no_target" };
  if (!target.inReach) return { queued: 0, skipped: 0, target, reason: "out_of_reach" };
  if (!target.rightsMine) return { queued: 0, skipped: 0, target, reason: "no_rights" };
  if (target.rows.length === 0) return { queued: 0, skipped: 0, target, reason: "empty" };
  let queued = 0;
  let skipped = 0;
  for (const row of target.rows) {
    const envelope = enqueueAuthorityTakeLootItemCommand(
      state.authorityCommands,
      target.containerId,
      row.itemId,
      row.variantId,
      row.available,
      authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick),
    );
    if (envelope) queued += 1;
    else skipped += 1;
  }
  return { queued, skipped, target, reason: null };
}
