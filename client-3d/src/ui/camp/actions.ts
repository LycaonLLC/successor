import type { ServerAuthorityPlacedCampState } from "@successor/client/src/slice-core/gameState";
import { formatAbandonCountdown } from "@successor/client/src/slice-core/campSystem";
import { deniedToastCopy } from "../extraction/actions";
import type { RadialAction } from "../windows/contextRadial";

/**
 * Camp interaction data — pure helpers behind the camp's radial and the
 * F-chip confirm arm. Every enable/disable mirrors a sim gate
 * (crates/successor-sim authority/camps.rs); notes are HONEST reasons in the
 * extraction-actions voice, never fake affordances.
 *
 * The one destructive verb — PACK UP — is consumed-on-place (the sim ruling:
 * the kit never returns), so BOTH paths to it are two-step:
 *  - radial: PACK UP → re-opens armed → CONFIRM row carries the real cost;
 *  - F-chip: PACK UP → chip verb flips to CONFIRM STRIKE for a short window.
 */

/** Command kinds whose receipts the camp toast line owns. */
export const CAMP_TOAST_KINDS = ["PlaceCamp", "PackUpCamp"] as const;

export type CampToastKind = (typeof CAMP_TOAST_KINDS)[number];

/**
 * Toast copy per receipt. Accepted placements stay quiet on the toast line —
 * the tent RISING is the feedback — but the strike speaks (the world object
 * vanishing needs its receipt) and rejections always speak.
 */
export function campReceiptCopy(
  kind: CampToastKind,
  accepted: boolean,
  reasonCode: string | null,
): string | null {
  if (!accepted) return deniedToastCopy(reasonCode);
  if (kind === "PackUpCamp") return "CAMP STRUCK · NOTHING RETURNS";
  return null;
}

export interface CampRadialInput {
  camp: ServerAuthorityPlacedCampState;
  insideFootprint: boolean;
  /** Second step of the pack-up confirm guard. */
  confirmPackUp: boolean;
}

const OUTSIDE_FOOTPRINT_NOTE = "OUTSIDE CAMP · ENTER THE 5×5 FOOTPRINT";

/**
 * The camp's radial rows. Owner-only by contract — callers never open a
 * radial on foreign camps (scenery; their door still opens for anyone, as
 * does the sim's shelter box). When the abandonment grace is armed, the
 * countdown leads the menu: the owner's 15-minute rule made visible.
 */
export function campRadialActions(input: CampRadialInput): RadialAction[] {
  const { camp, insideFootprint, confirmPackUp } = input;
  const reachNote = insideFootprint ? null : OUTSIDE_FOOTPRINT_NOTE;

  if (confirmPackUp) {
    return [
      {
        id: "confirm-pack-up",
        label: "CONFIRM STRIKE · NOTHING RETURNS",
        enabled: insideFootprint,
        note: insideFootprint ? "The kit was spent pitching it" : reachNote,
      },
      { id: "cancel-pack-up", label: "KEEP CAMP", enabled: true, note: null },
    ];
  }

  const actions: RadialAction[] = [];
  if (typeof camp.abandonSecondsRemaining === "number") {
    // Info row, deliberately disabled: clicking it does nothing, its note
    // explains the clock. Grace-timer honesty (owner ruling: 15-min floor).
    actions.push({
      id: "abandon-countdown",
      label: `COLLAPSES IN ${formatAbandonCountdown(camp.abandonSecondsRemaining)}`,
      enabled: false,
      note: "ABANDONED · RETURNING RESETS THE CLOCK",
    });
  }
  actions.push({
    id: "pack-up",
    label: "PACK UP",
    enabled: insideFootprint,
    note: insideFootprint ? "Strikes the camp — the kit is spent" : reachNote,
  });
  return actions;
}

// ── F-chip two-step arm (PACK UP → CONFIRM STRIKE) ──────────────────────────

/** Confirm window: long enough to read the warning, short enough to forget. */
export const PACK_UP_ARM_WINDOW_MS = 4_000;

interface PackUpArmState {
  campId: string;
  armedAtMs: number;
}

let packUpArm: PackUpArmState | null = null;

/** Arm the F-chip confirm for one camp (restarts the window). */
export function armPackUpConfirm(campId: string, nowMs: number): void {
  packUpArm = { campId, armedAtMs: nowMs };
}

export function disarmPackUpConfirm(): void {
  packUpArm = null;
}

/** Is the confirm window live for this camp? Expiry disarms as a side effect. */
export function packUpConfirmArmed(campId: string, nowMs: number): boolean {
  if (!packUpArm || packUpArm.campId !== campId) return false;
  if (nowMs - packUpArm.armedAtMs > PACK_UP_ARM_WINDOW_MS) {
    packUpArm = null;
    return false;
  }
  return true;
}
