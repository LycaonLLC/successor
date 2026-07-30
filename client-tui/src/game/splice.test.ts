import { describe, expect, it } from "vitest";

import { genomeScanLines, spliceReadoutLines, type GameGenomeScan, type GameSpliceSession } from "./splice";

const joined = (lines: { text: string }[]): string => lines.map((line) => line.text).join("\n");

function benchVm(overrides: Partial<GameSpliceSession> = {}): GameSpliceSession {
  return {
    phase: "slots",
    speciesId: 6001,
    speciesName: "Ashgrain",
    slots: [
      { slotIndex: 0, kind: "parent", label: "Parent A", filled: true, itemId: 6001, variantId: 11 },
      { slotIndex: 1, kind: "parent", label: "Parent B", filled: false, itemId: 0, variantId: 0 },
    ],
    lines: [
      { locus: 0, label: "YIELD", baseMilli: 400, valueMilli: 520, capMilli: 800, canRaise: true },
      { locus: 1, label: "HARDINESS", baseMilli: 300, valueMilli: 300, capMilli: 300, canRaise: false },
    ],
    assemblyQualityMilli: 0,
    pointsTotal: 0,
    pointsRemaining: 0,
    canAssemble: false,
    tick: 100,
    ...overrides,
  };
}

describe("gene bench readout (DEF-6 surface)", () => {
  it("renders parents by letter with fill hints and locus gauges", () => {
    const text = joined(spliceReadoutLines(benchVm()));
    expect(text).toContain("GENE BENCH — Ashgrain · SLOTS");
    expect(text).toContain("PARENT A — seated");
    expect(text).toContain("PARENT B — empty   (/splice fill 2 <seed>)");
    expect(text).toMatch(/0\. YIELD\s+520 \/ cap 800/);
    expect(text).toContain("(at cap)");
  });

  it("assembled phase speaks quality, points, and the moves left", () => {
    const text = joined(spliceReadoutLines(benchVm({ phase: "assembled", assemblyQualityMilli: 640, pointsTotal: 3, pointsRemaining: 2 })));
    expect(text).toContain("Assembly 64% · 2/3 points");
    expect(text).toContain("/splice mint [name]");
  });

  it("both-seated slots invite assembly", () => {
    const text = joined(spliceReadoutLines(benchVm({ canAssemble: true })));
    expect(text).toContain("Both parents seated — /splice assemble when ready.");
  });
});

describe("genome scan card (tiered reveal)", () => {
  const scan = (overrides: Partial<GameGenomeScan> = {}): GameGenomeScan => ({
    itemId: 6001,
    variantId: 11,
    speciesName: "Ashgrain",
    cultivarName: "Daxmere Wild",
    tier: "phenotype",
    fertile: true,
    loci: [{ locus: 0, label: "YIELD", expressMilli: 520 }],
    tick: 100,
    ...overrides,
  });

  it("phenotype tier shows expression only — no hidden alleles", () => {
    const text = joined(genomeScanLines(scan()));
    expect(text).toContain("«Daxmere Wild» Ashgrain — fertile · read at phenotype");
    expect(text).toMatch(/YIELD\s+520$/m);
    expect(text).not.toContain("[");
  });

  it("full tier reveals allele pairs; sterility shouts", () => {
    const text = joined(genomeScanLines(scan({
      tier: "full",
      fertile: false,
      loci: [{ locus: 0, label: "YIELD", expressMilli: 520, heterozygous: true, a1: 4, a2: 7 }],
      mutationPotentialMilli: 120,
      generation: 3,
    })));
    expect(text).toContain("STERILE");
    expect(text).toContain("· G3");
    expect(text).toContain("[4|7 het]");
    expect(text).toContain("mutation potential 120");
  });
});
