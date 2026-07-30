/**
 * Travel — catalog, tickets, terminals as text flows.
 *
 * Catalog is slice truth (`slice.travelCatalog`); owned tickets are scoped
 * inventory rows carrying `metadata.travelTicket`; purchase requires a
 * travel-terminal prop in interaction range (the same gate the 3D travel
 * window rides). Arrival narration is the scene register's area-change beat.
 */

import type {
  InventoryRow,
  PlayState,
  SliceSnapshot,
  TravelCatalogCitySnapshot,
  TravelCatalogPlanetSnapshot,
  TravelTicketDataSnapshot,
} from "@successor/client/src/slice-core/gameState";
import {
  authorityIssuedAtServerTick,
  enqueueAuthorityPurchaseTravelTicketCommand,
  enqueueAuthorityUseTravelTicketCommand,
} from "@successor/client/src/slice-core/authorityCommandSystem";

export const TRAVEL_TERMINAL_REACH_CELLS = 2.25;

export interface TravelDestination {
  planet: TravelCatalogPlanetSnapshot;
  city: TravelCatalogCitySnapshot;
}

export function travelDestinations(slice: SliceSnapshot): TravelDestination[] {
  const out: TravelDestination[] = [];
  for (const planet of slice.travelCatalog?.planets ?? []) {
    for (const city of planet.cities) out.push({ planet, city });
  }
  return out;
}

export function resolveDestination(slice: SliceSnapshot, planetToken: string, cityToken: string | undefined): TravelDestination | null {
  const destinations = travelDestinations(slice);
  const planetNeedle = planetToken.trim().toLowerCase();
  const cityNeedle = cityToken?.trim().toLowerCase() ?? "";
  const candidates = destinations.filter(({ planet }) =>
    planet.id.toLowerCase() === planetNeedle
    || planet.label.toLowerCase().includes(planetNeedle));
  if (candidates.length === 0) return null;
  if (!cityNeedle) return candidates[0] ?? null;
  return candidates.find(({ city }) =>
    city.id.toLowerCase() === cityNeedle || city.label.toLowerCase().includes(cityNeedle)) ?? null;
}

export interface TerminalView {
  propId: string;
  label: string;
  distanceCells: number;
  inReach: boolean;
}

/** Nearest travel terminal in the active area. */
export function nearestTerminal(state: PlayState, slice: SliceSnapshot): TerminalView | null {
  const meId = state.serverAuthority.playerActorId ?? state.playerActorId;
  const me = state.serverAuthority.actors[meId];
  const px = me?.x ?? state.player.x;
  const py = me?.y ?? state.player.y;
  let best: TerminalView | null = null;
  for (const prop of slice.props) {
    if (prop.areaId !== state.activeAreaId || prop.kind !== "travel_terminal") continue;
    const distanceCells = Math.hypot(prop.cell.x + prop.size.w / 2 - px, prop.cell.y + prop.size.h / 2 - py);
    if (best && distanceCells >= best.distanceCells) continue;
    best = {
      propId: prop.id,
      label: prop.label,
      distanceCells,
      inReach: distanceCells <= TRAVEL_TERMINAL_REACH_CELLS,
    };
  }
  return best;
}

export interface TicketView {
  index: number;
  row: InventoryRow;
  ticket: TravelTicketDataSnapshot;
}

/** Owned travel tickets (scoped inventory rows with travelTicket metadata). */
export function listTickets(state: PlayState): TicketView[] {
  const views: TicketView[] = [];
  for (const row of state.inventory) {
    if (row.available <= 0) continue;
    const ticket = travelTicketOf(row);
    if (!ticket) continue;
    views.push({ index: views.length + 1, row, ticket });
  }
  return views;
}

function travelTicketOf(row: InventoryRow): TravelTicketDataSnapshot | null {
  const metadata = row.metadata;
  if (!metadata || typeof metadata !== "object" || !("travelTicket" in metadata)) return null;
  const ticket: unknown = metadata.travelTicket;
  if (!ticket || typeof ticket !== "object") return null;
  const candidate = ticket as Partial<TravelTicketDataSnapshot>;
  if (typeof candidate.toPlanetId !== "string" || typeof candidate.toCityId !== "string") return null;
  return candidate as TravelTicketDataSnapshot;
}

export function enqueuePurchase(state: PlayState, slice: SliceSnapshot, terminal: TerminalView, destination: TravelDestination): boolean {
  return enqueueAuthorityPurchaseTravelTicketCommand(state.authorityCommands, {
    terminalPropId: terminal.propId,
    toPlanetId: destination.planet.id,
    toCityId: destination.city.id,
  }, authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick)) !== null;
}

export function enqueueUseTicket(state: PlayState, slice: SliceSnapshot, view: TicketView): boolean {
  return enqueueAuthorityUseTravelTicketCommand(state.authorityCommands, {
    container: view.row.container,
    stackId: view.row.stackId,
    ticketId: view.ticket.ticketId,
    variantId: view.row.variantId,
  }, authorityIssuedAtServerTick(state, slice.tickRateHz, slice.tick)) !== null;
}
