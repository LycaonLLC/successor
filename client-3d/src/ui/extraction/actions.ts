import type { InventoryRow, ServerAuthorityPlacedExtractorState } from "@successor/client/src/slice-core/gameState";
import type { RadialAction } from "../windows/contextRadial";

/**
 * Extraction interaction data — pure helpers behind the extractor prop's
 * radial and the placement/insert flows. Every enable/disable mirrors a sim
 * gate (crates/successor-sim authority/extractors.rs); notes are HONEST
 * reasons in the travel-gate voice, never fake affordances.
 */

/** Deployable field extractor tool (sim METAL_EXTRACTOR_TOOL_ITEM_ID). */
export const METAL_EXTRACTOR_TOOL_ITEM_ID = 3006;
/** Extractor battery (sim EXTRACTOR_BATTERY_ITEM_ID); variant encodes charge. */
export const EXTRACTOR_BATTERY_ITEM_ID = 3201;
/** Battery variant id = base + remaining runtime seconds (sim encoding). */
const BATTERY_VARIANT_BASE = 32_000_000;
const BATTERY_MAX_RUNTIME_SECONDS = 86_400;
/** Sim POINT_BLANK_INTERACTION_RADIUS_MILLI_CELLS — every extractor verb. */
export const EXTRACTOR_REACH_CELLS = 1.5;

const OUT_OF_REACH_NOTE = "OUT OF REACH · ≤1.5 CELLS";

/** Ticks-to-go → whole seconds for countdown copy (never negative). */
export function ticksToSeconds(remainingTicks: number, tickRateHz: number): number {
  return Math.max(0, Math.ceil(remainingTicks / Math.max(1, tickRateHz)));
}

/** Live sampler-cooldown toast copy (survey-window cooldown voice). */
export function sampleCooldownToast(seconds: number): string {
  return `SAMPLE COOLDOWN · ${seconds}s`;
}

/** Status-plate tag while the server-side auto-sample loop is armed. */
export function samplerPlateTag(seconds: number): string {
  return `AUTO-SAMPLE · ${seconds}s`;
}

/** Command kinds whose receipts the extraction toast line owns. */
export const EXTRACTION_TOAST_KINDS = [
  "PlaceExtractor",
  "CrankExtractor",
  "StopCrank",
  "InsertBattery",
  "CollectExtractor",
  "DestroyExtractor",
  "SampleResource",
] as const;

export type ExtractionToastKind = (typeof EXTRACTION_TOAST_KINDS)[number];

/** Player copy for deny reasonCodes on the toast line (combatQueue REASON_COPY
 *  register). The fallback prettifier stays for unknown codes — the toast must
 *  never break on new sim vocabulary — but every KNOWN code speaks player. */
const DENY_REASON_COPY: Record<string, string> = {
  economy_cooldown: "COOLDOWN",
  sample_cooldown: "SAMPLE COOLDOWN",
  missing_survey_tool: "NO SURVEY TOOL",
  missing_extractor_tool: "NO EXTRACTOR",
  invalid_resource_family: "NO SUCH RESOURCE",
  target_unavailable: "NOTHING HERE",
  container_full: "PACK FULL",
  out_of_range: "RANGE",
  not_at_extractor: "TOO FAR FROM RIG",
  actor_not_alive: "DOWN",
  posture_locked: "POSTURE",
  extractor_already_placed: "EXTRACTOR ALREADY PLACED",
  extractor_limit: "ONE UNIT DEPLOYED",
  no_placed_extractor: "NO RIG",
  not_extractor_owner: "NOT YOUR RIG",
  extractor_hopper_empty: "HOPPER EMPTY",
  hopper_empty: "HOPPER EMPTY",
  extractor_hopper_full: "HOPPER FULL",
  hopper_full: "HOPPER FULL",
  extractor_battery_present: "BATTERY PRESENT",
  battery_present: "BATTERY PRESENT",
  missing_battery: "NO BATTERY",
  no_battery: "NO BATTERY",
  extractor_busy: "RIG BUSY",
  item_unavailable: "WRONG TOOL",
  camp_limit: "ONE CAMP PITCHED",
  cell_blocked: "GROUND BLOCKED",
  structure_footprint_blocked: "CLEAR 5×5 GROUND REQUIRED",
  queue_full: "QUEUE FULL",
};
/** `DENIED · <reason>` in player vocabulary (C4 — dev codes never prettify
 *  straight onto the HUD). */
export function deniedToastCopy(reasonCode: string | null): string {
  const code = reasonCode ?? "unspecified";
  return `DENIED · ${DENY_REASON_COPY[code] ?? code.replaceAll("_", " ").toUpperCase()}`;
}

/**
 * Toast copy per receipt. Accepted cranks stay SILENT — the world prop's
 * animation is the feedback (that is the point of the prop). Rejections
 * always speak; `sample_cooldown` is handled by the live countdown instead
 * and returns null here.
 */
export function extractionReceiptCopy(
  kind: ExtractionToastKind,
  accepted: boolean,
  reasonCode: string | null,
): string | null {
  if (!accepted) {
    if (kind === "SampleResource" && reasonCode === "sample_cooldown") return null;
    return deniedToastCopy(reasonCode);
  }
  if (kind === "PlaceExtractor") return "EXTRACTOR DEPLOYED";
  if (kind === "CollectExtractor") return "COLLECTED · YIELD TO PACK";
  if (kind === "InsertBattery") return "BATTERY INSERTED";
  if (kind === "DestroyExtractor") return "PACKED UP · TOOL TO PACK";
  return null;
}

/** Remaining runtime seconds encoded in a battery row's variant id (0 = not a charge variant). */
export function batteryRuntimeSeconds(variantId: number): number {
  if (!Number.isInteger(variantId) || variantId <= BATTERY_VARIANT_BASE) return 0;
  return Math.min(variantId - BATTERY_VARIANT_BASE, BATTERY_MAX_RUNTIME_SECONDS);
}

/** "24H" / "45M" / "30S" — charge label channel for battery rows. */
export function formatBatteryRuntime(seconds: number): string {
  if (seconds >= 3600) return `${Math.round(seconds / 3600)}H`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}M`;
  return `${Math.max(0, Math.trunc(seconds))}S`;
}

/**
 * Best insertable battery among carried rows: most charge first. Rows without
 * a stackId can't be named in the InsertBattery payload and are skipped.
 */
export function bestBatteryRow(
  rows: readonly InventoryRow[],
  isCarriedContainer: (container: string) => boolean,
): InventoryRow | null {
  let best: InventoryRow | null = null;
  for (const row of rows) {
    if (row.itemId !== EXTRACTOR_BATTERY_ITEM_ID || row.available <= 0) continue;
    if (row.stackId === undefined || !isCarriedContainer(row.container)) continue;
    if (batteryRuntimeSeconds(row.variantId) <= 0) continue;
    if (!best || row.variantId > best.variantId) best = row;
  }
  return best;
}

export interface ExtractorRadialInput {
  extractor: ServerAuthorityPlacedExtractorState;
  distanceCells: number;
  /** Best carried battery, null when none is insertable. */
  battery: InventoryRow | null;
  /** Second step of the pack-up confirm guard. */
  confirmDestroy: boolean;
}

/**
 * The extractor prop's radial rows. Owner-only by contract — callers never
 * open a radial on foreign extractors (scenery). "PACK UP" names the real
 * effect (tool + battery return to the pack); the confirm step carries the
 * yield-loss warning because the sim forfeits hopper contents on destroy.
 */
export function extractorRadialActions(input: ExtractorRadialInput): RadialAction[] {
  const { extractor, distanceCells, battery, confirmDestroy } = input;
  const inReach = distanceCells <= EXTRACTOR_REACH_CELLS;
  const reachNote = inReach ? null : OUT_OF_REACH_NOTE;

  if (confirmDestroy) {
    return [
      {
        id: "confirm-destroy",
        label: extractor.hopperPct > 0 ? "CONFIRM PACK-UP · YIELD LOST" : "CONFIRM PACK-UP",
        enabled: inReach,
        note: reachNote,
      },
      { id: "cancel-destroy", label: "KEEP RUNNING", enabled: true, note: null },
    ];
  }

  const actions: RadialAction[] = [];
  if (extractor.mode === "manual") {
    actions.push({ id: "stop-crank", label: "STOP CRANK", enabled: true, note: null });
  } else {
    const crankNote = !inReach
      ? reachNote
      : extractor.mode === "battery"
        ? "RUNNING ON BATTERY"
        : extractor.hopperPct >= 100
          ? "HOPPER FULL"
          : null;
    actions.push({ id: "crank", label: "CRANK", enabled: crankNote === null, note: crankNote });
  }

  const batteryNote = !inReach
    ? reachNote
    : extractor.mode === "manual"
      ? "RELEASE CRANK FIRST"
      : extractor.batteryPct > 0
        ? "BATTERY PRESENT"
        : extractor.hopperPct >= 100
          ? "HOPPER FULL"
          : battery === null
            ? "NO BATTERY IN PACK"
            : null;
  actions.push({
    id: "insert-battery",
    label: battery
      ? `INSERT BATTERY · ${formatBatteryRuntime(batteryRuntimeSeconds(battery.variantId))}`
      : "INSERT BATTERY",
    enabled: batteryNote === null,
    note: batteryNote,
  });

  // Prefer authority collectableUnits when present; hopperPct alone floors
  // and can hide sub-1% work. Keep COLLECT live in reach so the server's
  // hopper-empty receipt remains the final truth.
  const units = Math.max(0, Math.trunc(Number(extractor.collectableUnits) || 0));
  const collectLabel = units > 0
    ? `COLLECT · ${units} UNIT${units === 1 ? "" : "S"}`
    : extractor.hopperPct > 0
      ? `COLLECT · HOPPER ${extractor.hopperPct}%`
      : "COLLECT";
  actions.push({
    id: "collect",
    label: collectLabel,
    enabled: inReach,
    note: reachNote,
  });
  const packNote = !inReach
    ? reachNote
    : extractor.mode === "manual"
      ? "RELEASE CRANK FIRST"
      : null;
  actions.push({
    id: "destroy",
    label: "PACK UP",
    enabled: packNote === null,
    note: packNote,
  });
  return actions;
}
