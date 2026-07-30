import { describe, expect, it } from "vitest";
import { decodeSlugthrowerLines, deriveSlugthrowerStats, slugthrowerStatRows } from "./slugthrowerStats";

describe("31M Slugthrower display stats", () => {
  it("keeps variant zero stock and decodes packed P/H/R", () => {
    expect(decodeSlugthrowerLines(0)).toEqual({ power: 0, handling: 0, reliability: 0 });
    expect(decodeSlugthrowerLines(106_064_083)).toEqual({ power: 75, handling: 64, reliability: 83 });
  });
  it("keeps only authority-encoded craft lines and does not derive combat balance", () => {
    const stock = deriveSlugthrowerStats(0);
    const crafted = deriveSlugthrowerStats(131_100_100);
    expect(stock).toEqual({ power: 0, handling: 0, reliability: 0, crafted: false });
    expect(crafted).toEqual({ power: 100, handling: 100, reliability: 100, crafted: true });
    expect(crafted).not.toHaveProperty("damageMax");
    expect(crafted).not.toHaveProperty("attackIntervalMs");
    expect(crafted).not.toHaveProperty("durabilityCapacity");
  });
  it("labels craft-line deltas, projected range, and the authority boundary", () => {
    const rows = slugthrowerStatRows(
      deriveSlugthrowerStats(131_100_100),
      deriveSlugthrowerStats(0),
      { pointBlankCells: 6, idealCells: 12, maxCells: 20 },
    );
    expect(rows.find((row) => row.label === "Power")?.value).toBe("100/100 (+100)");
    expect(rows.find((row) => row.label === "Handling")?.value).toBe("100/100 (+100)");
    expect(rows.find((row) => row.label === "Reliability")?.value).toBe("100/100 (+100)");
    expect(rows.find((row) => row.label.startsWith("Range"))?.value).toBe("6 / 12 / 20 cells");
    expect(rows.find((row) => row.label.startsWith("Damage"))?.value).toContain("Authority-resolved");
    expect(rows.map((row) => row.label)).not.toEqual(expect.arrayContaining(["Damage", "Attack", "Accuracy", "Reload", "Durability capacity"]));
  });
  it("omits range when the slice does not project it", () => {
    const rows = slugthrowerStatRows(deriveSlugthrowerStats(0));
    expect(rows.some((row) => row.label.startsWith("Range"))).toBe(false);
    expect(rows).toEqual([{ label: "Damage · cadence · accuracy · reload", value: "Authority-resolved; values not projected" }]);
  });
});
