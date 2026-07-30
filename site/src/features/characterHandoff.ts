// One-shot handoff of the chosen character from the creator stage or roster
// to /play/ for direct entry. Only the opaque character id crosses. Prefer versioned
// sessionStorage; when storage is denied (privacy mode), keep the same
// one-shot value in module memory for the current tab. /play/ consumes and
// clears it in the same breath — a reload never replays entry.
// Entry credentials and session secrets never touch storage.

export const SELECTED_CHARACTER_KEY = "successor.creator.selected-character.v1";

// Server ids look like char_<hex>; stay permissive but bounded.
const CHARACTER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Same-tab fallback when sessionStorage throws (privacy / quota). */
let memoryHandoff: string | null = null;

export function isCharacterId(value: unknown): value is string {
  return typeof value === "string" && CHARACTER_ID.test(value);
}

/**
 * Stores the selected id for exactly one upcoming direct-entry /play/ visit.
 * Returns true when either sessionStorage or the in-memory fallback accepted it.
 * Returns false only for a malformed id — callers then fall back to manual pick.
 */
export function storeSelectedCharacterId(win: Window, characterId: string): boolean {
  if (!isCharacterId(characterId)) return false;
  try {
    win.sessionStorage.setItem(SELECTED_CHARACTER_KEY, characterId);
    // Storage is durable for this tab session; drop any stale memory copy.
    memoryHandoff = null;
    return true;
  } catch {
    // Storage denied: keep the id in module memory for same-tab navigation.
    memoryHandoff = characterId;
    return true;
  }
}

/** Reads and immediately clears the stored id. Malformed values read as absent. */
export function consumeSelectedCharacterId(win: Window): string | null {
  let raw: string | null = null;
  try {
    raw = win.sessionStorage.getItem(SELECTED_CHARACTER_KEY);
    if (raw !== null) win.sessionStorage.removeItem(SELECTED_CHARACTER_KEY);
  } catch {
    // Privacy mode: fall through to memory.
  }
  if (raw !== null && isCharacterId(raw)) {
    memoryHandoff = null;
    return raw;
  }
  const mem = memoryHandoff;
  memoryHandoff = null;
  return mem !== null && isCharacterId(mem) ? mem : null;
}

/** Test hook: drop any in-memory handoff left by a prior case. */
export function resetHandoffForTests(): void {
  memoryHandoff = null;
}
