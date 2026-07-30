/**
 * WAYPOINT store — client-side, per-character navigation marks.
 *
 * Persistence is deliberately local and immediate: every mutation rewrites the
 * small (≤100 rows) character-scoped payload under
 * `successor3d.waypoints.<characterKey>`. The page owns one PlayState and one
 * boot identity, so the module singleton mirrors the survey store: readers use
 * a monotonic version counter instead of subscriptions, and all views (datapad,
 * radar, world beams, slash command) observe the same in-memory list.
 *
 * characterKey is installed at boot from launch identity via
 * `characterStorageKeyFromLaunchIdentity(...)` in boot/launch.ts: selected
 * character id first, then LaunchIdentity.playerId, then the authority actor id.
 */

export interface Waypoint {
  id: string;
  name: string;
  x: number;
  y: number;
  areaId: string;
  active: boolean;
  createdAtMs: number;
}

export interface WaypointCreateInput {
  name?: string | null;
  x: number;
  y: number;
  areaId: string;
  active?: boolean;
}

export interface WaypointMutationResult {
  ok: boolean;
  status: string;
  waypoint: Waypoint | null;
}

interface WaypointPayloadV1 {
  schema: "successor3d.waypoints.v1";
  waypoints: Waypoint[];
}

export const MAX_WAYPOINTS = 100;
export const WAYPOINT_STORAGE_PREFIX = "successor3d.waypoints.";

const STORAGE_SCHEMA: WaypointPayloadV1["schema"] = "successor3d.waypoints.v1";
const NAME_MAX = 48;
const COORD_PRECISION = 100;

const waypointList: Waypoint[] = [];
let storeVersion = 0;
let activeCharacterKey = "unbound";
let activeStorageKey: string | null = null;
let storage: Storage | null = null;
let idSeq = 0;

export function waypointStoreVersion(): number {
  return storeVersion;
}

export function waypointStoreCharacterKey(): string {
  return activeCharacterKey;
}

export function waypointStoreStorageKey(): string | null {
  return activeStorageKey;
}

export function waypointStorageKeyForCharacter(characterKey: string): string {
  return `${WAYPOINT_STORAGE_PREFIX}${normalizeCharacterKey(characterKey)}`;
}

export function configureWaypointStore(characterKey: string, nextStorage = browserStorage()): string {
  const normalized = normalizeCharacterKey(characterKey);
  const nextKey = waypointStorageKeyForCharacter(normalized);
  if (activeStorageKey === nextKey && storage === nextStorage) return nextKey;
  activeCharacterKey = normalized;
  activeStorageKey = nextKey;
  storage = nextStorage;
  loadFromStorage();
  storeVersion += 1;
  return nextKey;
}

export function waypoints(): readonly Waypoint[] {
  return waypointList;
}

export function waypointCount(): number {
  return waypointList.length;
}

export function defaultWaypointName(): string {
  for (let i = 1; i <= MAX_WAYPOINTS + 1; i += 1) {
    const candidate = `Waypoint ${i}`;
    let used = false;
    for (const waypoint of waypointList) {
      if (waypoint.name === candidate) {
        used = true;
        break;
      }
    }
    if (!used) return candidate;
  }
  return `Waypoint ${waypointList.length + 1}`;
}

export function createWaypoint(input: WaypointCreateInput): WaypointMutationResult {
  if (waypointList.length >= MAX_WAYPOINTS) {
    return { ok: false, status: `WAYPOINT CAP ${MAX_WAYPOINTS}/${MAX_WAYPOINTS} — DELETE ONE FIRST`, waypoint: null };
  }
  if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.areaId.trim().length === 0) {
    return { ok: false, status: "WAYPOINT DENIED — BAD LOCATION", waypoint: null };
  }
  const waypoint: Waypoint = {
    id: nextWaypointId(),
    name: normalizeWaypointName(input.name, defaultWaypointName()),
    x: roundCoord(input.x),
    y: roundCoord(input.y),
    areaId: input.areaId.trim(),
    active: input.active === true,
    createdAtMs: Date.now(),
  };
  waypointList.push(waypoint);
  saveMutation();
  return { ok: true, status: `${waypoint.name.toUpperCase()} CREATED`, waypoint };
}

export function renameWaypoint(id: string, nextName: string): WaypointMutationResult {
  const waypoint = waypointList.find((entry) => entry.id === id) ?? null;
  if (!waypoint) return { ok: false, status: "WAYPOINT GONE", waypoint: null };
  const normalized = normalizeWaypointName(nextName, "");
  if (normalized.length === 0) return { ok: false, status: "WAYPOINT NAME REQUIRED", waypoint };
  if (waypoint.name === normalized) return { ok: true, status: `${waypoint.name.toUpperCase()} UNCHANGED`, waypoint };
  waypoint.name = normalized;
  saveMutation();
  return { ok: true, status: `${waypoint.name.toUpperCase()} RENAMED`, waypoint };
}

export function setWaypointActive(id: string, active: boolean): WaypointMutationResult {
  const waypoint = waypointList.find((entry) => entry.id === id) ?? null;
  if (!waypoint) return { ok: false, status: "WAYPOINT GONE", waypoint: null };
  if (waypoint.active === active) {
    return { ok: true, status: `${waypoint.name.toUpperCase()} ${active ? "ACTIVE" : "INACTIVE"}`, waypoint };
  }
  waypoint.active = active;
  saveMutation();
  return { ok: true, status: `${waypoint.name.toUpperCase()} ${active ? "ACTIVE" : "INACTIVE"}`, waypoint };
}

export function deleteWaypoint(id: string): WaypointMutationResult {
  const index = waypointList.findIndex((entry) => entry.id === id);
  if (index < 0) return { ok: false, status: "WAYPOINT GONE", waypoint: null };
  const waypoint = waypointList[index]!;
  waypointList.splice(index, 1);
  saveMutation();
  return { ok: true, status: `${waypoint.name.toUpperCase()} DELETED`, waypoint };
}

function saveMutation(): void {
  storeVersion += 1;
  persist();
}

function persist(): void {
  if (!storage || !activeStorageKey) return;
  const payload: WaypointPayloadV1 = { schema: STORAGE_SCHEMA, waypoints: waypointList.slice() };
  try {
    storage.setItem(activeStorageKey, JSON.stringify(payload));
  } catch {
    // localStorage can be unavailable/quota-blocked; keep the in-memory page state.
  }
}

function loadFromStorage(): void {
  waypointList.length = 0;
  if (!storage || !activeStorageKey) return;
  try {
    const raw = storage.getItem(activeStorageKey);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    const rows = payloadRows(parsed);
    if (!rows) return;
    for (const row of rows) {
      const waypoint = normalizeStoredWaypoint(row);
      if (!waypoint) continue;
      waypointList.push(waypoint);
      if (waypointList.length >= MAX_WAYPOINTS) break;
    }
  } catch {
    waypointList.length = 0;
  }
}

function payloadRows(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return null;
  const rows = value.waypoints;
  return Array.isArray(rows) ? rows : null;
}

function normalizeStoredWaypoint(value: unknown): Waypoint | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === "string" && value.id.length > 0 ? value.id.slice(0, 96) : nextWaypointId();
  const areaId = typeof value.areaId === "string" ? value.areaId.trim().slice(0, 96) : "";
  const x = typeof value.x === "number" ? value.x : Number.NaN;
  const y = typeof value.y === "number" ? value.y : Number.NaN;
  const createdAtMs = typeof value.createdAtMs === "number" && Number.isFinite(value.createdAtMs)
    ? Math.max(0, Math.trunc(value.createdAtMs))
    : Date.now();
  if (!areaId || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    id,
    name: normalizeWaypointName(typeof value.name === "string" ? value.name : null, defaultWaypointName()),
    x: roundCoord(x),
    y: roundCoord(y),
    areaId,
    active: value.active === true,
    createdAtMs,
  };
}

function nextWaypointId(): string {
  idSeq += 1;
  return `wp_${Date.now().toString(36)}_${idSeq.toString(36)}`;
}

function normalizeWaypointName(value: string | null | undefined, fallback: string): string {
  const normalized = (value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .slice(0, NAME_MAX);
  return normalized || fallback;
}

function normalizeCharacterKey(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64) || "observer";
}

function roundCoord(value: number): number {
  return Math.round(value * COORD_PRECISION) / COORD_PRECISION;
}

function browserStorage(): Storage | null {
  return typeof window !== "undefined" ? window.localStorage : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
