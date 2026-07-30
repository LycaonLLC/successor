/**
 * Craft assembly result banding — THE shared quality-milli → result-word
 * table (owner ruling: one map, no drift). Read by the 3D client's CRAFT
 * window stamp and the TUI's crafting prose; any new surface that names an
 * assembly result imports THIS. Pure constants — no dependencies, safe for
 * every app in the workspace.
 *
 * Vocabulary is the owner-approved voice set (earlier sandbox design's banding shape in the
 * field-office register). Floors are inclusive, rows descend.
 */

export interface CraftResultBand {
  /** Band floor (inclusive), assembly quality milli 0–1000. */
  floorMilli: number;
  /** The one-word result. */
  word: string;
}

export const CRAFT_RESULT_BANDS: readonly CraftResultBand[] = [
  { floorMilli: 900, word: "MASTERWORK" },
  { floorMilli: 750, word: "FINE" },
  { floorMilli: 550, word: "SOUND" },
  { floorMilli: 350, word: "FAIR" },
  { floorMilli: 150, word: "ROUGH" },
  { floorMilli: 0, word: "CRUDE" },
];

/** Result word for an assembly quality (clamped into 0–1000). */
export function craftResultWord(qualityMilli: number): string {
  const quality = Math.max(0, Math.min(1000, Math.trunc(qualityMilli)));
  for (const band of CRAFT_RESULT_BANDS) {
    if (quality >= band.floorMilli) return band.word;
  }
  return CRAFT_RESULT_BANDS[CRAFT_RESULT_BANDS.length - 1]!.word;
}
