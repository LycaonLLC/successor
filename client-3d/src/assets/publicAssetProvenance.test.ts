import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const publicRoot = resolve(process.cwd(), "public");
const promotedRecords = [
  "assets/pawn-pack/special/droid_grok_humanoid.provenance.json",
  "assets/pawn-pack/weapons/custom/scrapline_machete.provenance.json",
  "assets/world-items/travel_terminal_grok_wedge.provenance.json",
  "assets/world-items/travel_terminal_grok_wedge_screen.provenance.json",
] as const;

const publicSafeRecords = [
  ...promotedRecords,
  "assets/pawn-pack/weapons/custom/lightning_carbine_attach.json",
  "assets/world-items/barricade_concrete.provenance.json",
  "assets/world-items/crate_planked.provenance.json",
  "assets/world-items/supply_cache.provenance.json",
] as const;

describe("shipped promoted-asset provenance", () => {
  it.each(publicSafeRecords)("keeps %s free of machine-local metadata", (relativePath) => {
    const raw = readFileSync(resolve(publicRoot, relativePath), "utf8");

    expect(raw).not.toMatch(/\/home\//u);
    expect(raw).not.toContain(".omp/");
    expect(raw).not.toContain("session_id");
    expect(raw).not.toContain("verbatim_user");
    expect(raw).not.toMatch(/telegram|gateway|michaelmac/iu);
  });

  it.each(promotedRecords)("keeps %s runtime-licensed", (relativePath) => {
    const provenance = JSON.parse(readFileSync(resolve(publicRoot, relativePath), "utf8")) as {
      rights?: { source_license?: string; redistribution_status?: string };
    };

    expect(provenance.rights).toEqual(expect.objectContaining({
      source_license: "Successor proprietary project asset; all rights reserved",
      redistribution_status: "authorized for Successor runtime distribution only; no standalone reuse grant",
    }));
  });
});
