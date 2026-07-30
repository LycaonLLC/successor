import { describe, expect, it } from "vitest";
import { coverSummary, normalizeCoverProfile } from "./coverSystem";

describe("coverSystem", () => {
  it("normalizes authored cover ratings and heights", () => {
    expect(normalizeCoverProfile({ rating: 72.4, height: "high" })).toEqual({ rating: 72, height: "high" });
    expect(normalizeCoverProfile({ rating: 500, height: "low" })).toEqual({ rating: 100, height: "low" });
    expect(normalizeCoverProfile({ rating: 35, height: "weird" })).toEqual({ rating: 35, height: "low" });
    expect(normalizeCoverProfile({ rating: 0, height: "high" })).toBeNull();
  });

  it("formats cover for editor readouts", () => {
    expect(coverSummary({ rating: 85, height: "high" })).toBe("high cover 85%");
    expect(coverSummary(null)).toBe("no cover");
  });
});
