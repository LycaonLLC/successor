import {
  authorityIssuedAtServerTick,
  enqueueAuthorityPurchaseTravelTicketCommand,
  enqueueAuthorityUseTravelTicketCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";
import type { PlayState, SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { heldTicketsForTerminal, withinTerminalRange, type HeldTravelTicket } from "./travelSystem";

/**
 * Travel command dispatch — the ONE path every entry point routes through
 * (travel window button, terminal radial "Use Ticket", inventory "TRAVEL
 * NOW"). Client gates exist for honest affordances only; the server is the
 * authority and re-validates everything.
 */

export function purchaseTravelTicket(
  state: PlayState,
  slice: SliceSnapshot,
  terminalPropId: string,
  toPlanetId: string,
  toCityId: string,
): boolean {
  const issuedAtTick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
  return enqueueAuthorityPurchaseTravelTicketCommand(
    state.authorityCommands,
    { terminalPropId, toPlanetId, toCityId },
    issuedAtTick,
  ) !== null;
}

export function useTravelTicket(state: PlayState, slice: SliceSnapshot, held: HeldTravelTicket): boolean {
  const issuedAtTick = authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick);
  return enqueueAuthorityUseTravelTicketCommand(
    state.authorityCommands,
    {
      container: held.row.container,
      stackId: held.row.stackId,
      ticketId: held.data.ticketId,
      variantId: held.row.variantId,
    },
    issuedAtTick,
  ) !== null;
}

export type UseTicketAtTerminalResult = "queued" | "no_ticket" | "out_of_range";

/** Terminal-radial path: consume the first held ticket originating at this terminal. */
export function useBestTicketAtTerminal(
  state: PlayState,
  slice: SliceSnapshot,
  terminalPropId: string,
): UseTicketAtTerminalResult {
  const held = heldTicketsForTerminal(state, terminalPropId);
  const first = held[0];
  if (!first) return "no_ticket";
  if (!withinTerminalRange(state, slice, terminalPropId)) return "out_of_range";
  return useTravelTicket(state, slice, first) ? "queued" : "out_of_range";
}
