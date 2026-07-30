export interface SlugthrowerLines { power: number; handling: number; reliability: number }
export interface SlugthrowerDerivedStats extends SlugthrowerLines {
  crafted: boolean;
}
export interface WeaponRangeBandDisplay { pointBlankCells: number; idealCells: number; maxCells: number }

/** Decode the authority's 31M P/H/R namespace. Variant 0 is the stock rifle. */
export function decodeSlugthrowerLines(variantId: number | null | undefined): SlugthrowerLines {
  const id = Number.isInteger(variantId) ? Number(variantId) : 0;
  if (id < 31_000_000) return { power: 0, handling: 0, reliability: 0 };
  const encoded = id - 31_000_000;
  return { power: Math.min(100, Math.floor(encoded / 1_000_000)), handling: Math.min(100, Math.floor(encoded / 1_000) % 1_000), reliability: Math.min(100, encoded % 1_000) };
}

export function deriveSlugthrowerStats(variantId: number | null | undefined, linesOverride?: Partial<SlugthrowerLines>): SlugthrowerDerivedStats {
  const lines = { ...decodeSlugthrowerLines(variantId), ...linesOverride };
  return {
    ...lines,
    crafted: Number(variantId ?? 0) >= 31_000_000 || linesOverride !== undefined,
  };
}

export function signedDelta(value: number, equipped: number | null | undefined): string {
  if (equipped == null) return "";
  const delta = value - equipped;
  return delta === 0 ? "±0" : `${delta > 0 ? "+" : ""}${delta}`;
}

export function slugthrowerStatRows(
  stats: SlugthrowerDerivedStats,
  equipped?: SlugthrowerDerivedStats | null,
  rangeBand?: WeaponRangeBandDisplay | null,
): Array<{ label: string; value: string }> {
  const d = (value: number, base: number | undefined): string => equipped ? ` (${signedDelta(value, base)})` : "";
  const craftedLines = stats.crafted ? [
    { label: "Power", value: `${stats.power}/100${d(stats.power, equipped?.power)}` },
    { label: "Handling", value: `${stats.handling}/100${d(stats.handling, equipped?.handling)}` },
    { label: "Reliability", value: `${stats.reliability}/100${d(stats.reliability, equipped?.reliability)}` },
  ] : [];
  return [
    ...craftedLines,
    ...(rangeBand ? [{
      label: "Range · point / ideal / max",
      value: `${rangeBand.pointBlankCells} / ${rangeBand.idealCells} / ${rangeBand.maxCells} cells`,
    }] : []),
    { label: "Damage · cadence · accuracy · reload", value: "Authority-resolved; values not projected" },
  ];
}
