/**
 * Extractor management — the field-extraction loop as terminal flows.
 *
 * Data is the AOI stream (`serverAuthority.placedExtractors`, per-session
 * `isOwner`); every gate mirrors a sim gate (extractors.rs) in honest prose.
 * OWN rigs render with full telemetry; foreign rigs are scenery presence
 * (3D radial parity — owner-only affordances). Reach 1.5c on every verb.
 */

import type { InventoryRow, PlayState, ServerAuthorityPlacedExtractorState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import {
  authorityIssuedAtServerTick,
  enqueueAuthorityCollectExtractorCommand,
  enqueueAuthorityCrankExtractorCommand,
  enqueueAuthorityDestroyExtractorCommand,
  enqueueAuthorityInsertBatteryCommand,
  enqueueAuthorityPlaceExtractorCommand,
  enqueueAuthorityStopCrankCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";

import { bearingShort } from "./bearing";

/** Sim POINT_BLANK_INTERACTION_RADIUS — every extractor verb (3D parity). */
export const EXTRACTOR_REACH_CELLS = 1.5;
/** Extractor battery item (variant encodes remaining runtime seconds). */
export const EXTRACTOR_BATTERY_ITEM_ID = 3201;
const BATTERY_VARIANT_BASE = 32_000_000;
const BATTERY_MAX_RUNTIME_SECONDS = 86_400;

export interface ExtractorView {
  index: number;
  extractor: ServerAuthorityPlacedExtractorState;
  distanceCells: number;
  dx: number;
  dy: number;
  inReach: boolean;
}

/** Visible extractors in the active area — OWN first, then by distance. */
export function listExtractors(state: PlayState): ExtractorView[] {
  const meId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const me = state.serverAuthority.actors[meId];
  const px = me?.x ?? state.player.x;
  const py = me?.y ?? state.player.y;
  const views = state.serverAuthority.placedExtractors
    .filter((extractor) => extractor.areaId === state.activeAreaId)
    .map((extractor) => {
      const dx = extractor.cellX + 0.5 - px;
      const dy = extractor.cellY + 0.5 - py;
      const distanceCells = Math.hypot(dx, dy);
      return { index: 0, extractor, distanceCells, dx, dy, inReach: distanceCells <= EXTRACTOR_REACH_CELLS };
    })
    .sort((left, right) => {
      if (left.extractor.isOwner !== right.extractor.isOwner) return left.extractor.isOwner ? -1 : 1;
      return left.distanceCells - right.distanceCells;
    });
  for (let i = 0; i < views.length; i += 1) views[i]!.index = i + 1;
  return views;
}

/** Resolve `<n|extractorId>`; bare invocation = nearest OWN extractor. */
export function resolveExtractor(state: PlayState, token: string | undefined): ExtractorView | null {
  const views = listExtractors(state);
  if (!token) return views.find((view) => view.extractor.isOwner) ?? null;
  const trimmed = token.trim();
  const numeric = Number(trimmed);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= views.length) return views[numeric - 1]!;
  return views.find((view) => view.extractor.extractorId === trimmed) ?? null;
}

const MODE_GLYPH: Record<ServerAuthorityPlacedExtractorState["mode"], string> = {
  idle: "·",
  manual: "⟳",
  battery: "▮",
};

const MODE_WORD: Record<ServerAuthorityPlacedExtractorState["mode"], string> = {
  idle: "idle",
  manual: "hand-cranked",
  battery: "running on battery",
};

/** One numbered listing line; foreign rigs stay scenery (no telemetry). */
export function extractorLine(view: ExtractorView): string {
  const { extractor } = view;
  const where = view.inReach ? "at hand" : bearingShort(view.dx, view.dy);
  if (!extractor.isOwner) {
    return `${view.index}. · another prospector's ${extractor.familyLabel.toLowerCase()} rig — ${where}`;
  }
  const units = Math.max(0, Math.trunc(Number(extractor.collectableUnits) || 0));
  const hopper = units > 0
    ? ` · ${units} unit${units === 1 ? "" : "s"} (${extractor.hopperPct}%)`
    : ` · hopper ${extractor.hopperPct}%`;
  const battery = extractor.batteryPct > 0 ? ` · battery ${extractor.batteryPct}%` : "";
  return `${view.index}. ${MODE_GLYPH[extractor.mode]} your ${extractor.familyLabel.toLowerCase()} extractor — ${MODE_WORD[extractor.mode]}${hopper}${battery} — ${where}`;
}

/** Remaining runtime seconds encoded in a battery row's variant (3D rule). */
export function batteryRuntimeSeconds(variantId: number): number {
  if (!Number.isInteger(variantId) || variantId <= BATTERY_VARIANT_BASE) return 0;
  return Math.min(variantId - BATTERY_VARIANT_BASE, BATTERY_MAX_RUNTIME_SECONDS);
}

export function formatBatteryRuntime(seconds: number): string {
  if (seconds >= 3600) return `${Math.round(seconds / 3600)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${Math.max(0, Math.trunc(seconds))}s`;
}

/**
 * Best insertable carried battery: most charge first (3D bestBatteryRow
 * rule). `isCarried` is the flow gate for command-nameable stacks.
 */
export function bestBatteryRow(state: PlayState, isCarried: (container: string) => boolean): InventoryRow | null {
  let best: InventoryRow | null = null;
  for (const row of state.inventory) {
    if (row.itemId !== EXTRACTOR_BATTERY_ITEM_ID || row.available <= 0) continue;
    if (row.stackId === undefined || !isCarried(row.container)) continue;
    if (batteryRuntimeSeconds(row.variantId) <= 0) continue;
    if (!best || row.variantId > best.variantId) best = row;
  }
  return best;
}

export type ExtractorOrder =
  | { kind: "place"; family: string }
  | { kind: "crank"; view: ExtractorView }
  | { kind: "stop-crank" }
  | { kind: "battery"; view: ExtractorView; row: InventoryRow }
  | { kind: "collect"; view: ExtractorView }
  | { kind: "destroy"; view: ExtractorView };

/** Enqueue one extractor order; returns whether the command queued. */
export function enqueueExtractorOrder(state: PlayState, slice: SliceSnapshot, order: ExtractorOrder): boolean {
  const tick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
  switch (order.kind) {
    case "place":
      return enqueueAuthorityPlaceExtractorCommand(state.authorityCommands, order.family, tick) !== null;
    case "crank":
      return enqueueAuthorityCrankExtractorCommand(state.authorityCommands, order.view.extractor.extractorId, tick) !== null;
    case "stop-crank":
      return enqueueAuthorityStopCrankCommand(state.authorityCommands, tick) !== null;
    case "battery":
      return enqueueAuthorityInsertBatteryCommand(
        state.authorityCommands,
        {
          extractorId: order.view.extractor.extractorId,
          container: order.row.container,
          stackId: order.row.stackId ?? "",
          variantId: order.row.variantId,
        },
        tick,
      ) !== null;
    case "collect":
      return enqueueAuthorityCollectExtractorCommand(state.authorityCommands, order.view.extractor.extractorId, tick) !== null;
    case "destroy":
      return enqueueAuthorityDestroyExtractorCommand(state.authorityCommands, order.view.extractor.extractorId, tick) !== null;
  }
}
