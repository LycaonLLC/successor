/** Eager FX Lab id + dev-flag gate (no fx module graph). */
export const FX_LAB_WINDOW_ID = "fxlab";

/**
 * Dev-flag gate (owner ruling 2026-07-09: the lab never ships in the player
 * dock): `?fxlab=1` or the `successor.fxlab` localStorage twin — the
 * gameTrace/moveTrace flag pattern.
 */
export function fxLabRequested(): boolean {
  if (typeof window === "undefined") return false;
  const params = new URLSearchParams(window.location.search);
  return params.get("fxlab") === "1"
    || window.localStorage.getItem("successor.fxlab") === "1";
}
