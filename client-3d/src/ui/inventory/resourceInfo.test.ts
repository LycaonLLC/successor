import { describe, expect, it } from "vitest";
import type { InventoryRow, ServerAuthorityResourceStatsState, ServerAuthorityResourceSpawnState } from "@successor/client/src/slice-core/gameState";
import {
  formatTaxonomyPath,
  formatVariantCode,
  resourceInfoForRow,
  resourceTaxonomyForItemId,
} from "./resourceInfo";

type RowPatch = Omit<Partial<InventoryRow>, "variantId"> & {
  variantId?: unknown;
} & Record<string, unknown>;

const baseStats = (patch: Partial<ServerAuthorityResourceStatsState> = {}): ServerAuthorityResourceStatsState => ({
  conductivity: 0,
  malleability: 0,
  shock_resistance: 0,
  thermal_resistance: 0,
  chemical_purity: 0,
  density: 0,
  tensile_strength: 0,
  flexibility: 0,
  potency: 0,
  nutrition: 0,
  stability: 0,
  extraction_yield: 0,
  ...patch,
});

const baseSpawn = (patch: Partial<ServerAuthorityResourceSpawnState> = {}): ServerAuthorityResourceSpawnState => ({
  spawnId: "spawn-test-001",
  family: "metal",
  name: "Spawn Name",
  variantId: 0,
  classLabel: "Class",
  stats: baseStats(),
  activeFromTick: 0,
  activeUntilTick: null,
  ...patch,
});

const baseRow = (patch: RowPatch): InventoryRow => ({
  container: "player:field-pack",
  item: "Resource",
  itemId: 2102,
  variantId: 0,
  quantity: 1,
  reserved: 0,
  available: 1,
  ...patch,
} as unknown as InventoryRow);

describe("resource taxonomy formatting", () => {
  it("formats taxonomy paths as compact ledger subtitles", () => {
    expect(formatTaxonomyPath(["Organic", "Creature Food", "Clodmeat"])).toBe("ORGANIC · CREATURE FOOD · CLODMEAT");
    expect(formatTaxonomyPath(["Inorganic", "Mineral", "Metal", "Iron"])).toBe("INORGANIC · MINERAL · METAL · IRON");
    expect(formatTaxonomyPath(["Inorganic", "Mineral", "Metal", "Copper"])).toBe("INORGANIC · MINERAL · METAL · COPPER");
  });

  it("catalogs copper under the metal taxonomy", () => {
    expect(resourceTaxonomyForItemId(2007)).toEqual({
      itemId: 2007,
      displayName: "Copper",
      taxonomyPath: ["Inorganic", "Mineral", "Metal", "Copper"],
    });
  });

  it("falls unknown resource taxonomy back to a legible organic unclassified path", () => {
    expect(formatTaxonomyPath([])).toBe("ORGANIC · UNCLASSIFIED");
    const info = resourceInfoForRow(baseRow({
      item: "Uncatalogued Carapace",
      itemId: 2199,
      variantId: "carapace-x91-z",
      variantLabel: "Uncatalogued Carapace",
    }), { category: "resource" });
    expect(info?.taxonomySubtitle).toBe("ORGANIC · UNCLASSIFIED");
    expect(info?.displayName).toBe("Uncatalogued Carapace");
  });
});

describe("resource row display metadata", () => {
  it("uses the resource variant label, short code, taxonomy, and potency/purity stat block", () => {
    const info = resourceInfoForRow(baseRow({
      item: "Creature Meat",
      itemId: 2102,
      variantId: "clodmeat-w27-a",
      variantLabel: "Duskback Clodmeat",
      stats: { potency: 841, purity: 612 },
    }), { category: "resource", fallbackName: "Creature Meat" });

    expect(info?.displayName).toBe("Duskback Clodmeat");
    expect(info?.variantCode).toBe("W27A");
    expect(info?.taxonomySubtitle).toBe("ORGANIC · CREATURE FOOD · CLODMEAT");
    expect(info?.stats).toEqual([
      { key: "chemical_purity", label: "PURITY", value: 612 },
      { key: "potency", label: "POTENCY", value: 841 },
    ]);
  });

  it("derives compact variant chips from string and numeric variant identities", () => {
    expect(formatVariantCode("clodmeat-w27-a")).toBe("W27A");
    expect(formatVariantCode(123456)).toBe("3456");
    expect(formatVariantCode(27)).toBe("0027");
    expect(formatVariantCode(0)).toBeNull();
  });
});

describe("resourceStats prioritization and rendering in resourceInfoForRow", () => {
  it("prioritizes authoritative 12-channel resourceStats and omits zero/null values", () => {
    const row = baseRow({
      resourceStats: baseStats({ chemical_purity: 900, stability: 750, conductivity: 0, malleability: 0 }),
      stats: { potency: 500, purity: 400 },
    });
    const info = resourceInfoForRow(row, { category: "resource" });
    expect(info?.stats).toEqual([
      { key: "chemical_purity", label: "PURITY", value: 900 },
      { key: "stability", label: "STABILITY", value: 750 },
    ]);
  });

  it("renders Fuel purity+stability and Polymer flexibility in defined order", () => {
    const fuelRow = baseRow({
      itemId: 2009,
      resourceStats: baseStats({ stability: 600, chemical_purity: 800 }),
    });
    const fuelInfo = resourceInfoForRow(fuelRow, { category: "resource" });
    expect(fuelInfo?.stats).toEqual([
      { key: "chemical_purity", label: "PURITY", value: 800 },
      { key: "stability", label: "STABILITY", value: 600 },
    ]);

    const polymerRow = baseRow({
      itemId: 2010,
      resourceStats: baseStats({ flexibility: 720 }),
    });
    const polymerInfo = resourceInfoForRow(polymerRow, { category: "resource" });
    expect(polymerInfo?.stats).toEqual([
      { key: "flexibility", label: "FLEX", value: 720 },
    ]);
  });

  it("preserves legacy stats and spawn fallback only when authoritative resourceStats block is absent", () => {
    const rowLegacyStats = baseRow({
      stats: { potency: 800, purity: 600 },
    });
    const infoLegacyStats = resourceInfoForRow(rowLegacyStats, { category: "resource" });
    expect(infoLegacyStats?.stats).toEqual([
      { key: "chemical_purity", label: "PURITY", value: 600 },
      { key: "potency", label: "POTENCY", value: 800 },
    ]);

    const rowDirect = baseRow({
      potency: 700,
      purity: 500,
    } as unknown as RowPatch);
    const infoDirect = resourceInfoForRow(rowDirect, { category: "resource" });
    expect(infoDirect?.stats).toEqual([
      { key: "chemical_purity", label: "PURITY", value: 500 },
      { key: "potency", label: "POTENCY", value: 700 },
    ]);

    const rowSpawn = baseRow({});
    const spawnState = baseSpawn({
      stats: baseStats({ potency: 450, stability: 300 }),
    });
    const infoSpawn = resourceInfoForRow(rowSpawn, { category: "resource", spawn: spawnState });
    expect(infoSpawn?.stats).toEqual([
      { key: "potency", label: "POTENCY", value: 450 },
      { key: "stability", label: "STABILITY", value: 300 },
    ]);
  });
});
