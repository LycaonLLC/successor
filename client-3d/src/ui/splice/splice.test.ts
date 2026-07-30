import { describe, expect, it } from "vitest";
import {
  locusLabel,
  spliceReasonLine,
  spliceStampFor,
  tierLabel,
  tierRevealsAlleles,
} from "./copy";
import {
  ingestGenomeScan,
  ingestSpliceSession,
  scanForStack,
  spliceSession,
  spliceStoreVersion,
  type GenomeScanVM,
  type SpliceSessionVM,
} from "./store";

describe("splice copy — reason lines (player language, never dev-cased)", () => {
  it("maps a splice reject code regardless of casing/separators", () => {
    const expected = "That doesn't belong in this slot.";
    expect(spliceReasonLine("splice_slot_mismatch")).toBe(expected);
    expect(spliceReasonLine("SpliceSlotMismatch")).toBe(expected);
    expect(spliceReasonLine("SPLICE_SLOT_MISMATCH")).toBe(expected);
  });

  it("speaks the scan-tier + bench honesty codes", () => {
    expect(spliceReasonLine("missing_splice_bench")).toBe("No Splice Bench in your pack.");
    expect(spliceReasonLine("genome_unavailable")).toContain("scan or resample");
    expect(spliceReasonLine("economy_cooldown")).toContain("recharging");
    expect(spliceReasonLine("target_unavailable")).toContain("trained the gene bench");
  });

  it("falls back without leaking dev casing, and answers null", () => {
    const line = spliceReasonLine("someWeirdCode");
    expect(line.startsWith("Refused — ")).toBe(true);
    expect(line).not.toContain("someWeirdCode");
    expect(spliceReasonLine(null)).toBe("Refused at the bench.");
  });
});

describe("splice copy — locus / tier display", () => {
  it("compacts known locus labels and prettifies unknowns", () => {
    expect(locusLabel("water_economy")).toBe("WATER");
    expect(locusLabel("yield")).toBe("YIELD");
    expect(locusLabel("some_new_locus")).toBe("SOME NEW LOCUS");
  });

  it("reveals alleles only at allele_values+ tiers (scan honesty)", () => {
    expect(tierRevealsAlleles("phenotype")).toBe(false);
    expect(tierRevealsAlleles("hidden_presence")).toBe(false);
    expect(tierRevealsAlleles("allele_values")).toBe(true);
    expect(tierRevealsAlleles("full")).toBe(true);
    expect(tierLabel("hidden_presence")).toBe("hidden variation");
  });

  it("bands assembly quality into a stamp word + flavor line", () => {
    const master = spliceStampFor(1000);
    expect(master.stamp.length).toBeGreaterThan(0);
    const crude = spliceStampFor(0);
    expect(crude.stamp.length).toBeGreaterThan(0);
    // Distinct quality tiers should not read as the same stamp.
    expect(master.stamp).not.toBe(crude.stamp);
  });
});

describe("splice store — scan cache keyed by (itemId, variantId)", () => {
  const scan = (itemId: number, variantId: number, cultivar: string): GenomeScanVM => ({
    itemId,
    variantId,
    speciesName: "Ashgrain",
    cultivarName: cultivar,
    tier: "full",
    fertile: true,
    profile: {
      growthDaysBase: 5, waterNeedMilli: 212, yieldBase: 35, hardinessMilli: 500,
      seasonAffinity: 0, offSeasonPenaltyMilli: 0, stormResistanceMilli: 500,
      blightResistanceMilli: 500, regrowthDays: 0, tileFootprint: 1, qualityPotentialMilli: 800,
    },
    loci: [{ locus: 0, label: "yield", expressMilli: 526, heterozygous: true, a1: 386, a2: 667 }],
    tick: 1,
  });

  it("caches distinct genomes independently and bumps the version", () => {
    const v0 = spliceStoreVersion();
    ingestGenomeScan(scan(6001, 1, "Dustline-3"));
    ingestGenomeScan(scan(6001, 2, "Verdant-9"));
    expect(spliceStoreVersion()).toBeGreaterThan(v0);
    // A second seed never overwrites the first — the picker reads BOTH parents.
    expect(scanForStack(6001, 1)?.cultivarName).toBe("Dustline-3");
    expect(scanForStack(6001, 2)?.cultivarName).toBe("Verdant-9");
    // A never-scanned stack reads UNKNOWN (null → UI renders UNKNOWN).
    expect(scanForStack(6001, 999)).toBeNull();
    // Species guard: same handle under a different item id is a different stack.
    expect(scanForStack(6002, 1)).toBeNull();
  });

  it("holds and clears the streamed splice session VM", () => {
    const session: SpliceSessionVM = {
      phase: "assembled", speciesId: 6001, speciesName: "Ashgrain",
      slots: [], lines: [], assemblyQualityMilli: 678, pointsTotal: 21,
      pointsRemaining: 13, canAssemble: false, tick: 2,
    };
    ingestSpliceSession(session);
    expect(spliceSession()?.phase).toBe("assembled");
    ingestSpliceSession(null);
    expect(spliceSession()).toBeNull();
  });
});
