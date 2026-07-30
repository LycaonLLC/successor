import type { RadialAction } from "../windows/contextRadial";

/**
 * TRADE radial row — the CONVERSE-sibling action on live player pawns
 * (owner spec: /trade + radial open the secure trade window).
 *
 * Pure helpers so the input layer's wiring hunk stays one-line-thin (that
 * file is a hot seam) and the row is testable without a canvas. Enablement
 * mirrors the sim's gate honestly: the table opens at point-blank range
 * (TRADE_INTERACTION_RADIUS_MILLI_CELLS = POINT_BLANK = 1.5 cells); out of
 * range shows the reason on hover instead of letting the server deny.
 */

/** Sim truth: POINT_BLANK_INTERACTION_RADIUS_MILLI_CELLS / 1000. */
export const TRADE_INTERACTION_RADIUS_CELLS = 1.5;

export const TRADE_OUT_OF_RANGE_NOTE = "Step closer to open a table";

/**
 * Player-pawn gate for showing the row at all: live human players stream
 * role "player"; agent-driven player pawns stream "agent_player". Everything
 * else (trainers, creatures, skirmishers) never grows a TRADE row — the
 * sim would allow it, but the owner journey is pawn-to-pawn commerce.
 */
export function actorIsTradablePlayerPawn(
  actor: { role?: unknown; lifeState?: unknown } | null | undefined,
): boolean {
  if (!actor) return false;
  const role = typeof actor.role === "string" ? actor.role : "";
  if (role !== "player" && role !== "agent_player") return false;
  return actor.lifeState === "alive";
}

/** The radial row. `distanceCells: null` = unknown position (disabled). */
export function tradeRadialAction(distanceCells: number | null): RadialAction {
  const inRange = distanceCells !== null && distanceCells <= TRADE_INTERACTION_RADIUS_CELLS;
  return {
    id: "trade",
    label: "Trade",
    enabled: inRange,
    note: inRange ? null : TRADE_OUT_OF_RANGE_NOTE,
  };
}
