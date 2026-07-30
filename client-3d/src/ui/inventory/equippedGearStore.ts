export type EquippedGearListener = () => void;
export type EquippedGearToggleResult = "equipped" | "unequipped" | "unsupported";

const storageKeyPrefix = "successor3d.gear.v1.";
const fallbackPlayerId = "player";

const knownEquipmentIds = new Set<string>();
const slotByEquipmentId = new Map<string, string>();
const requiresByEquipmentId = new Map<string, readonly string[]>();
const equipmentIdByNormalizedText = new Map<string, string>();
const memoryByStorageKey = new Map<string, string[]>();
const listeners = new Set<EquippedGearListener>();
let knownGearRegistered = false;

let currentPlayerId = initialPlayerId();
let currentStorageKey = `${storageKeyPrefix}${currentPlayerId}`;
let currentIds = memoryByStorageKey.get(currentStorageKey) ?? [];
let loadedStorageKey: string | null = null;
memoryByStorageKey.set(currentStorageKey, currentIds);

/** Selects the local player namespace used by get()/toggle(); no-op when unchanged. */
export function setEquippedGearPlayerId(playerId: string | null | undefined): void {
  const normalized = normalizePlayerId(playerId);
  if (normalized === currentPlayerId) return;
  currentPlayerId = normalized;
  currentStorageKey = `${storageKeyPrefix}${currentPlayerId}`;
  currentIds = memoryByStorageKey.get(currentStorageKey) ?? [];
  memoryByStorageKey.set(currentStorageKey, currentIds);
  loadedStorageKey = null;
  ensureLoaded();
  notify();
}

export interface KnownGearEntry {
  id: string;
  /** Manifest slot — inventory items in the same slot are mutually exclusive.
   * Character hair is appearance state and never enters this store. */
  slot?: string;
  /** Manifest requires[] — a dependent is dropped when its base leaves. */
  requires?: readonly string[];
}

let pendingWornSeed: string[] | null = null;

/** Boot-time creator-outfit seed (join payload). Before the gear catalog
 * registers it parks; registerKnownGearIds flushes it through seedIfEmpty so
 * the worn set wins the first-run seed over the classic dressed look. */
export function setPendingWornSeed(ids: readonly string[]): void {
  const cleaned = ids.map((id) => id.normalize("NFKC").trim()).filter((id) => id.length > 0);
  if (cleaned.length === 0) return;
  if (knownGearRegistered) {
    seedIfEmpty(cleaned);
    return;
  }
  pendingWornSeed = cleaned;
}

export function registerKnownGearIds(ids: readonly (string | KnownGearEntry)[]): void {
  knownEquipmentIds.clear();
  slotByEquipmentId.clear();
  requiresByEquipmentId.clear();
  equipmentIdByNormalizedText.clear();
  for (const raw of ids) {
    const entry = typeof raw === "string" ? { id: raw } : raw;
    const id = entry.id.normalize("NFKC").trim();
    if (!id) continue;
    knownEquipmentIds.add(id);
    if (entry.slot) slotByEquipmentId.set(id, entry.slot);
    if (entry.requires && entry.requires.length > 0) requiresByEquipmentId.set(id, [...entry.requires]);
    registerEquipmentText(id, id);
  }
  knownGearRegistered = true;
  loadedStorageKey = null;
  if (pendingWornSeed) {
    const seed = pendingWornSeed;
    pendingWornSeed = null;
    seedIfEmpty(seed);
  }
  // Wake subscribers: attaches that ran before the catalog registered skipped
  // seeding (and may have filtered ids) — a gear-version bump makes the pawn
  // renderer and inventory VM re-derive with the real catalog.
  notify();
}

/** True once registerKnownGearIds has run — seedIfEmpty silently no-ops
 * before that, so seed latches must wait for it. */
export function isKnownGearRegistered(): boolean {
  return knownGearRegistered;
}

function evictSameSlot(ids: string[], incoming: string): void {
  const slot = slotByEquipmentId.get(incoming);
  if (!slot) return;
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    if (ids[i] !== incoming && slotByEquipmentId.get(ids[i]!) === slot) ids.splice(i, 1);
  }
}

/** Drop dependents whose required base is gone (chains included) — keeps the
 * store honest with what the attach path will actually render. */
function dropOrphanedDependents(ids: string[]): void {
  let dropped = true;
  while (dropped) {
    dropped = false;
    for (let i = ids.length - 1; i >= 0; i -= 1) {
      const requires = requiresByEquipmentId.get(ids[i]!);
      if (requires && requires.some((req) => !ids.includes(req))) {
        ids.splice(i, 1);
        dropped = true;
      }
    }
  }
}

function dedupeBySlot(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    evictSameSlot(out, id);
    if (!out.includes(id)) out.push(id);
  }
  dropOrphanedDependents(out);
  return out;
}

export function seedIfEmpty(ids: readonly string[]): void {
  if (!knownGearRegistered) return;
  // Load (and prune stale ids) FIRST — a storage key holding only retired
  // item ids must count as empty, or stale keys block seeding forever
  // (naked-pawn bug, owner report 2026-07-06). Deliberate nudity persists as
  // "[]" (see persist) and is honored: pruned-to-empty seeds, stored-empty
  // does not.
  ensureLoaded();
  if (currentIds.length > 0) return;
  const storage = localStorageOrNull();
  if (storage && storage.getItem(currentStorageKey) !== null && !lastLoadPrunedToEmpty) return;

  const seededIds: string[] = [];
  for (const rawId of ids) {
    const id = rawId.normalize("NFKC").trim();
    if (knownEquipmentIds.has(id) && !seededIds.includes(id)) seededIds.push(id);
  }
  const seededDeduped = dedupeBySlot(seededIds);
  seededIds.length = 0;
  seededIds.push(...seededDeduped);
  if (seededIds.length === 0) return;

  currentIds.length = 0;
  currentIds.push(...seededIds);
  loadedStorageKey = currentStorageKey;
  persist();
  notify();
}


export function get(): readonly string[] {
  ensureLoaded();
  return currentIds;
}

export function has(id: string): boolean {
  ensureLoaded();
  return currentIds.includes(id);
}

/** Recursively equip an item's requires[] first (attach-path semantics),
 * evicting same-slot occupants as each piece lands. */
function addWithRequirements(ids: string[], id: string, seen: Set<string>): void {
  if (seen.has(id) || !knownEquipmentIds.has(id)) return;
  seen.add(id);
  for (const req of requiresByEquipmentId.get(id) ?? []) addWithRequirements(ids, req, seen);
  evictSameSlot(ids, id);
  if (!ids.includes(id)) ids.push(id);
}

export function toggle(id: string): EquippedGearToggleResult {
  ensureLoaded();
  if (!knownGearRegistered || !knownEquipmentIds.has(id)) return "unsupported";
  const index = currentIds.indexOf(id);
  const result: EquippedGearToggleResult = index >= 0 ? "unequipped" : "equipped";
  if (index >= 0) {
    currentIds.splice(index, 1);
  } else {
    addWithRequirements(currentIds, id, new Set());
  }
  dropOrphanedDependents(currentIds);
  persist();
  notify();
  return result;
}

export function subscribe(listener: EquippedGearListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const equippedGearStore = {
  get,
  has,
  toggle,
  subscribe,
  seedIfEmpty,
} as const;


export function equipmentIdForInventoryText(text: string): string | null {
  const normalized = normalizeEquipmentText(text);
  if (!normalized) return null;
  return equipmentIdByNormalizedText.get(normalized) ?? null;
}

let lastLoadPrunedToEmpty = false;

function ensureLoaded(): void {
  if (loadedStorageKey === currentStorageKey) return;
  loadedStorageKey = currentStorageKey;
  const stored = readStoredIds(currentStorageKey);
  currentIds.length = 0;
  let droppedUnknown = false;
  for (const id of stored) {
    if (knownGearRegistered && !knownEquipmentIds.has(id)) {
      droppedUnknown = true;
      continue;
    }
    if (!currentIds.includes(id)) currentIds.push(id);
  }
  if (knownGearRegistered) {
    const deduped = dedupeBySlot(currentIds);   // stored sets may pre-date slot rules
    if (deduped.length !== currentIds.length) {
      currentIds.length = 0;
      currentIds.push(...deduped);
    }
  }
  lastLoadPrunedToEmpty = knownGearRegistered && stored.length > 0 && currentIds.length === 0;
  if (knownGearRegistered && (droppedUnknown || stored.length !== currentIds.length)) persist();
}

function readStoredIds(key: string): string[] {
  const storage = localStorageOrNull();
  const memoryIds = memoryByStorageKey.get(key);
  if (!storage) return memoryIds ? [...memoryIds] : [];
  const raw = storage.getItem(key);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    storage.removeItem(key);
  }
  return [];
}

function persist(): void {
  memoryByStorageKey.set(currentStorageKey, currentIds);
  const storage = localStorageOrNull();
  if (!storage) return;
  // Empty persists as "[]", NOT key removal: a deliberately nude pawn
  // (owner nude-base rule) must stay nude across boots — seedIfEmpty only
  // re-dresses when the key is absent or pruned stale, never on stored "[]".
  storage.setItem(currentStorageKey, JSON.stringify(currentIds));
}

function notify(): void {
  for (const listener of listeners) listener();
}

function localStorageOrNull(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}


function initialPlayerId(): string {
  if (typeof window === "undefined") return fallbackPlayerId;
  const selectedCharacter = (window as Window & { __successorSelectedCharacter?: { id?: string } }).__successorSelectedCharacter;
  const params = new URLSearchParams(window.location.search);
  // Precedence MUST match the inventory VM's identity resolution: the stable
  // session identity (?player / selected character) wins over the fixture
  // actor id (?actorId), or seeds and reads land in different namespaces.
  return normalizePlayerId(selectedCharacter?.id ?? params.get("player") ?? params.get("actorId"));
}

function normalizePlayerId(playerId: string | null | undefined): string {
  const normalized = playerId?.normalize("NFKC").trim();
  return normalized || fallbackPlayerId;
}

function registerEquipmentText(text: string, id: string): void {
  const normalized = normalizeEquipmentText(text);
  if (!normalized || equipmentIdByNormalizedText.has(normalized)) return;
  equipmentIdByNormalizedText.set(normalized, id);
}

function normalizeEquipmentText(text: string): string {
  return text
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_\-]+/gu, " ")
    .replace(/[^a-z0-9 ]+/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}
