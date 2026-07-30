/**
 * Stack-split snap preference (owner spec): the split slider snaps to a
 * step the player picks per-use, with a DEFAULT step configured in OPTIONS.
 * Persisted like other 3D-client UI prefs (localStorage, versioned key).
 */

export const SPLIT_SNAP_STEPS = [1, 5, 10, 100, 1000, 10000] as const;
export type SplitSnapStep = (typeof SPLIT_SNAP_STEPS)[number];

const STORAGE_KEY = "successor3d.inventory.splitSnap.v1";
const FALLBACK_SNAP: SplitSnapStep = 100;

export function getDefaultSplitSnap(): SplitSnapStep {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return FALLBACK_SNAP;
    const parsed = Number(raw);
    for (const step of SPLIT_SNAP_STEPS) {
      if (parsed === step) return step;
    }
  } catch {
    // Storage unavailable (privacy mode) — fall through to the default.
  }
  return FALLBACK_SNAP;
}

export function setDefaultSplitSnap(step: SplitSnapStep): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(step));
  } catch {
    // Best-effort persistence only.
  }
}
