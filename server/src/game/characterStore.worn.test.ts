import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CharacterStore, normalizeCharacterWorn } from "./characterStore.js";
import { WARDROBE_PALETTES, WARDROBE_PIECES } from "./wardrobe.gen.js";

/**
 * Creator worn-set contract (wardrobe wave 2026-07-08): worn entries are
 * validated against the generated wardrobe registry — known piece ids, one
 * piece per slot, zone-indexed colors restricted to the zone family's
 * swatches or the authored default.
 */

const appearance = {
  body: "male" as const,
  skinTone: "#aabbcc",
  hair: "hair_mop" as const,
  hairMat: "hair_raven",
  face: null,
};

function withStore(test: (store: CharacterStore, filePath: string) => void): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), "successor-wardrobe-store-"));
  try {
    const filePath = path.join(dir, "characters.json");
    test(new CharacterStore(filePath, () => Date.parse("2026-07-08T00:00:00.000Z")), filePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const top = WARDROBE_PIECES.find((piece) => piece.slot === "under_torso")!;
const legs = WARDROBE_PIECES.find((piece) => piece.slot === "under_legs")!;

function familySwatchHex(family: string): string {
  const swatch = WARDROBE_PALETTES[family]?.[0];
  if (!swatch) throw new Error(`no swatches for family ${family}`);
  return swatch.hex;
}

describe("characterStore worn set", () => {
  it("registers the wardrobe (sanity: pieces exist for all four creator slots)", () => {
    for (const slot of ["under_torso", "under_legs", "under_feet", "under_hands"]) {
      expect(WARDROBE_PIECES.some((piece) => piece.slot === slot)).toBe(true);
    }
  });

  it("forces the fixed baby-blue underlayer and canvas boots regardless of payload clothing", () => {
    withStore((store) => {
      const result = store.create({
        name: "Warden",
        appearance,
        worn: [{ item: top.id, colors: [familySwatchHex(top.zones[0]!.family)] }],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.record.worn).toEqual([
        { item: "under_bodysuit", colors: ["#89cff0"] },
        { item: "boots_canvas_ankle", colors: ["#303030", "#808080"] },
      ]);
    });
  });

  it("does not validate or inject optional clothing choices", () => {
    withStore((store) => {
      const first = store.create({ name: "Aaa", appearance, worn: [{ item: "top_counterfeit", colors: [] }] });
      const second = store.create({ name: "Bbb", appearance, worn: [{ item: top.id, colors: [] }] });
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(first.record.worn).toEqual(second.record.worn);
      }
    });
  });

  it("fails closed on a retired persisted piece instead of replacing it", () => {
    expect(normalizeCharacterWorn([{ item: top.id, colors: [] }, { item: "junk", colors: [] }])).toBeNull();

    withStore((store, filePath) => {
      const created = store.create({ name: "Keeper", appearance });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const raw = JSON.parse(readFileSync(filePath, "utf8")) as {
        characters: Array<{ id: string; worn: unknown }>;
      };
      raw.characters[0]!.worn = [{ item: "top_retired_piece", colors: [] }];
      writeFileSync(filePath, JSON.stringify(raw), "utf8");
      expect(() => new CharacterStore(filePath).get(created.record.id)).toThrow(/invalid character-store record/u);
    });
  });



  it("derives wornColors for persisted records and preserves unequipped palette metadata", () => {
    withStore((store, filePath) => {
      const created = store.create({ id: "stored-wardrobe", name: "Wardrobe", appearance });
      if (!created.ok) throw new Error("expected character create to succeed");
      const raw = JSON.parse(readFileSync(filePath, "utf8")) as {
        characters: Array<Record<string, unknown>>;
      };
      raw.characters[0]!.worn = [{ item: top.id, colors: [familySwatchHex(top.zones[0]!.family)] }];
      raw.characters[0]!.wornColors = {
        [top.id]: [familySwatchHex(top.zones[0]!.family)],
        [legs.id]: [legs.zones[0]!.default],
      };
      writeFileSync(filePath, JSON.stringify(raw), "utf8");

      const loadedStore = new CharacterStore(filePath);
      const loaded = loadedStore.get("stored-wardrobe");
      expect(loaded?.worn).toEqual([{ item: top.id, colors: [familySwatchHex(top.zones[0]!.family)] }]);
      expect(loaded?.wornColors).toEqual({
        [top.id]: [familySwatchHex(top.zones[0]!.family)],
        [legs.id]: [legs.zones[0]!.default],
      });

      // A normal store write must not discard the unequipped piece's palette.
      loadedStore.markSeen("stored-wardrobe", Date.parse("2026-07-08T00:01:00.000Z"));
      const reloaded = new CharacterStore(filePath).get("stored-wardrobe");
      expect(reloaded?.wornColors?.[legs.id]).toEqual([legs.zones[0]!.default]);
    });
  });

  it("deletes offline character records permanently", () => {
    withStore((store) => {
      const created = store.create({ name: "Ephemeral", appearance, worn: [] });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const removed = store.delete(created.record.id);
      expect(removed?.id).toBe(created.record.id);
      expect(store.get(created.record.id)).toBeNull();
      expect(store.delete(created.record.id)).toBeNull();
      // freed slot is reusable, name included
      const recreated = store.create({ name: "Ephemeral", appearance, worn: [] });
      expect(recreated.ok).toBe(true);
    });
  });
});
