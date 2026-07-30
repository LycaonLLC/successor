import type { PlayState, SliceSnapshot, InventoryRow } from "@successor/client/src/slice-core/gameState";
import { propsForArea } from "@successor/client/src/slice-core/worldQueries";

/**
 * Travel system — FE data core (Planetfall).
 *
 * Reads the server-authored `slice.travelCatalog` (schema
 * `successor.travel-catalog.v1`) and the player's `travel_ticket` inventory
 * rows (`metadata.travelTicket`). Everything here is boundary data from
 * parsed JSON, so every shape is runtime-narrowed — no blind casts.
 *
 * The ACTIVE terminal (last one the player interacted with) is a module
 * store in the examine-opener tradition: input routing sets it, the travel
 * window reads it. Proximity gates re-check live every frame — the server
 * revalidates everything anyway; the FE gate exists for honest affordances.
 */

export interface TravelCity {
  id: string;
  label: string;
  terminalPropId: string;
  spawn: { x: number; y: number };
}

export interface TravelPlanet {
  id: string;
  label: string;
  biome: string;
  areaId: string;
  cities: TravelCity[];
}

export interface TravelCatalog {
  planets: TravelPlanet[];
}

export interface TravelTicketData {
  ticketId: string;
  fromPlanetId: string;
  fromCityId: string;
  toPlanetId: string;
  toCityId: string;
  originTerminalPropId: string;
  originAreaId: string;
  destAreaId: string;
  destSpawn: { x: number; y: number };
}

export const TRAVEL_TICKET_ITEM_KEY = "travel_ticket";
export const TRAVEL_USE_RANGE_CELLS = 10;

// ── Catalog parsing (boundary: slice JSON) ───────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function pointField(record: Record<string, unknown>, key: string): { x: number; y: number } | null {
  const value = record[key];
  if (!isRecord(value)) return null;
  const x = value.x;
  const y = value.y;
  if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

interface ParsedCity extends TravelCity {
  /** City-level areaId some generator versions emit; planet parse may inherit it. */
  areaIdHint: string | null;
}

function parseCity(value: unknown): ParsedCity | null {
  if (!isRecord(value)) return null;
  const id = stringField(value, "id");
  // Tolerant boundary: contract says `label`; accept legacy `name` too.
  const label = stringField(value, "label") ?? stringField(value, "name");
  const terminalPropId = stringField(value, "terminalPropId");
  const spawn = pointField(value, "spawn");
  if (!id || !label || !terminalPropId || !spawn) return null;
  return { id, label, terminalPropId, spawn, areaIdHint: stringField(value, "areaId") };
}

function parsePlanet(value: unknown): TravelPlanet | null {
  if (!isRecord(value)) return null;
  const id = stringField(value, "id");
  const label = stringField(value, "label") ?? stringField(value, "name");
  if (!id || !label) return null;
  const biome = stringField(value, "biome") ?? "desert";
  const citiesRaw = value.cities;
  const cities: ParsedCity[] = [];
  if (Array.isArray(citiesRaw)) {
    for (const entry of citiesRaw) {
      const city = parseCity(entry);
      if (city) cities.push(city);
    }
  }
  if (cities.length === 0) return null;
  // Contract puts areaId on the planet; tolerate city-level emission.
  const areaId = stringField(value, "areaId") ?? cities[0]?.areaIdHint ?? null;
  if (!areaId) return null;
  return { id, label, biome, areaId, cities };
}

const catalogCache = new WeakMap<SliceSnapshot, TravelCatalog | null>();

export function travelCatalogFrom(slice: SliceSnapshot): TravelCatalog | null {
  if (catalogCache.has(slice)) return catalogCache.get(slice) ?? null;
  let parsed: TravelCatalog | null = null;
  const sliceRecord: unknown = slice;
  if (isRecord(sliceRecord) && "travelCatalog" in sliceRecord) {
    const raw = sliceRecord.travelCatalog;
    if (isRecord(raw) && Array.isArray(raw.planets)) {
      const planets: TravelPlanet[] = [];
      for (const entry of raw.planets) {
        const planet = parsePlanet(entry);
        if (planet) planets.push(planet);
      }
      if (planets.length > 0) parsed = { planets };
    }
  }
  catalogCache.set(slice, parsed);
  return parsed;
}

export interface TerminalContext {
  planet: TravelPlanet;
  city: TravelCity;
}

export function terminalContext(catalog: TravelCatalog, terminalPropId: string): TerminalContext | null {
  for (const planet of catalog.planets) {
    for (const city of planet.cities) {
      if (city.terminalPropId === terminalPropId) return { planet, city };
    }
  }
  return null;
}

// ── Ticket rows (boundary: inventory metadata) ───────────────────────────

export function parseTravelTicketData(value: unknown): TravelTicketData | null {
  if (!isRecord(value)) return null;
  const ticketId = stringField(value, "ticketId");
  const fromPlanetId = stringField(value, "fromPlanetId");
  const fromCityId = stringField(value, "fromCityId");
  const toPlanetId = stringField(value, "toPlanetId");
  const toCityId = stringField(value, "toCityId");
  const originTerminalPropId = stringField(value, "originTerminalPropId");
  const originAreaId = stringField(value, "originAreaId");
  const destAreaId = stringField(value, "destAreaId");
  const destSpawn = pointField(value, "destSpawn");
  if (
    !ticketId || !fromPlanetId || !fromCityId || !toPlanetId || !toCityId
    || !originTerminalPropId || !originAreaId || !destAreaId || !destSpawn
  ) {
    return null;
  }
  return {
    ticketId,
    fromPlanetId,
    fromCityId,
    toPlanetId,
    toCityId,
    originTerminalPropId,
    originAreaId,
    destAreaId,
    destSpawn,
  };
}

export function travelTicketDataForRow(row: InventoryRow): TravelTicketData | null {
  if (row.itemKey !== TRAVEL_TICKET_ITEM_KEY) return null;
  const metadata = row.metadata;
  if (!metadata || !("travelTicket" in metadata)) return null;
  return parseTravelTicketData(metadata.travelTicket);
}

export interface HeldTravelTicket {
  row: InventoryRow;
  data: TravelTicketData;
}

/** Player-held tickets whose ORIGIN is the given terminal (reused array). */
const heldScratch: HeldTravelTicket[] = [];

export function heldTicketsForTerminal(state: PlayState, terminalPropId: string): readonly HeldTravelTicket[] {
  heldScratch.length = 0;
  for (const row of state.inventory) {
    if (row.available <= 0) continue;
    const data = travelTicketDataForRow(row);
    if (data && data.originTerminalPropId === terminalPropId) heldScratch.push({ row, data });
  }
  return heldScratch;
}

// ── Proximity ────────────────────────────────────────────────────────────

export function terminalCell(slice: SliceSnapshot, state: PlayState, terminalPropId: string): { x: number; y: number } | null {
  for (const prop of propsForArea(slice, state.activeAreaId)) {
    if (prop.id !== terminalPropId) continue;
    return { x: prop.cell.x + prop.size.w / 2, y: prop.cell.y + prop.size.h / 2 };
  }
  return null;
}

/** True when the local player stands within use range of the terminal (same area + ≤10 cells). */
export function withinTerminalRange(state: PlayState, slice: SliceSnapshot, terminalPropId: string): boolean {
  const cell = terminalCell(slice, state, terminalPropId);
  if (!cell) return false;
  const dx = state.player.x + 0.5 - cell.x;
  const dy = state.player.y + 0.5 - cell.y;
  return dx * dx + dy * dy <= TRAVEL_USE_RANGE_CELLS * TRAVEL_USE_RANGE_CELLS;
}

/** Nearest terminal within use range of the player, or null (auto-link seam:
 *  the window adopts it when opened from the dock/`/ui` beside a terminal). */
export function nearestTerminalInRange(state: PlayState, slice: SliceSnapshot): string | null {
  let best: string | null = null;
  let bestDistSq = TRAVEL_USE_RANGE_CELLS * TRAVEL_USE_RANGE_CELLS;
  for (const prop of propsForArea(slice, state.activeAreaId)) {
    if (prop.kind !== "travel_terminal") continue;
    const dx = state.player.x + 0.5 - (prop.cell.x + prop.size.w / 2);
    const dy = state.player.y + 0.5 - (prop.cell.y + prop.size.h / 2);
    const distSq = dx * dx + dy * dy;
    if (distSq <= bestDistSq) {
      bestDistSq = distSq;
      best = prop.id;
    }
  }
  return best;
}

// ── Active terminal store (input routing → travel window) ────────────────

let activeTerminalPropId: string | null = null;

export function setActiveTravelTerminal(propId: string | null): void {
  activeTerminalPropId = propId;
}

export function activeTravelTerminal(): string | null {
  return activeTerminalPropId;
}

// ── Map placement: stable per-city marker positions on the square map ────

const CITY_MAP_POSITIONS: Record<string, { x: number; y: number }> = {
  dustgate: { x: 0.63, y: 0.56 },
  lowbough: { x: 0.42, y: 0.37 },
};

/** Normalized (0..1) map position for a city — hashed fallback for future cities. */
export function cityMapPosition(cityId: string): { x: number; y: number } {
  const fixed = CITY_MAP_POSITIONS[cityId];
  if (fixed) return fixed;
  let h = 2166136261;
  for (let i = 0; i < cityId.length; i += 1) {
    h ^= cityId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const x = 0.18 + ((h >>> 8) % 1000) / 1000 * 0.64;
  const y = 0.18 + ((h >>> 18) % 1000) / 1000 * 0.64;
  return { x, y };
}
