export const coverHeights = ["low", "high"] as const;
export type CoverHeight = typeof coverHeights[number];

export interface CoverProfile {
  rating: number;
  height: CoverHeight;
}

export const defaultCoverProfile: CoverProfile = { rating: 60, height: "low" };

export function normalizeCoverProfile(value: unknown): CoverProfile | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<CoverProfile>;
  const rating = Number(candidate.rating);
  if (!Number.isFinite(rating) || rating <= 0) return null;
  const height = coverHeights.includes(candidate.height as CoverHeight)
    ? (candidate.height as CoverHeight)
    : defaultCoverProfile.height;
  return {
    rating: Math.round(clamp(rating, 1, 100)),
    height,
  };
}

export function coverSummary(cover: CoverProfile | null | undefined): string {
  if (!cover) return "no cover";
  return `${cover.height} cover ${cover.rating}%`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
