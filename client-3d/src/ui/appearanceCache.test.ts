import { afterEach, describe, expect, it, vi } from "vitest";
import {
  characterAppearanceCacheStorageKey,
  readCachedCharacterAppearance,
  writeCachedCharacterAppearance,
} from "./appearanceCache";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe("appearanceCache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("persists a normalized worn appearance under the character key", () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);

    const wrote = writeCachedCharacterAppearance(" Char 1!* ", {
      body: "female",
      skinTone: "#E8C39A",
      hair: "hair_mop",
      hairMat: "hair_umber",
      equipmentIds: ["under_tank", "armor_future", "under_tank"],
      worn: [{ item: "top_rigged_tank", colors: ["#804040", "BAD", "#406090"] }],
    });

    expect(wrote).toBe(true);
    expect(storage.getItem("successor3d.appearance.char-1")).not.toBeNull();
    expect(characterAppearanceCacheStorageKey("Char 1!*")).toBe("successor3d.appearance.char-1");
    expect(readCachedCharacterAppearance("char-1")).toMatchObject({
      version: 1,
      body: "female",
      skinTone: "#e8c39a",
      hair: "hair_mop",
      hairMat: "hair_umber",
      equipmentIds: ["under_tank", "armor_future"],
      // worn colors keep only well-formed hexes; the signature gains the
      // trailing worn segment (wardrobe wave 2026-07-08).
      worn: [{ item: "top_rigged_tank", colors: ["#804040", "#406090"] }],
      appearanceKey: "female|#e8c39a|hair_mop|hair_umber|under_tank,armor_future|top_rigged_tank:#804040+#406090|",
    });
  });

  it("persists a face selection inside the key and the cached record", () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);

    const face = {
      eyes: "veteran",
      brows: "sharp",
      nose: "stoic",
      mouth: "feral",
      eyeColor: "#7b573b",
      browColor: "#35241e",
      lipColor: "#6c3438",
    };
    expect(writeCachedCharacterAppearance("char-face", {
      body: "male",
      skinTone: "#4a3223",
      hair: null,
      hairMat: "hair_raven",
      equipmentIds: [],
      face,
    })).toBe(true);

    const cached = readCachedCharacterAppearance("char-face")!;
    expect(cached.face).toEqual(face);
    expect(cached.appearanceKey.endsWith("|veteran,sharp,stoic,feral,#7b573b,#35241e,#6c3438")).toBe(true);

    // A face swap changes the signature — the write is not skipped.
    expect(writeCachedCharacterAppearance("char-face", {
      body: "male",
      skinTone: "#4a3223",
      hair: null,
      hairMat: "hair_raven",
      equipmentIds: [],
      face: { ...face, eyes: "ghost" },
    })).toBe(true);
  });

  it("skips a storage write when the appearance signature is unchanged", () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    const input = {
      body: "male" as const,
      skinTone: "#cc9978",
      hair: null,
      hairMat: "hair_raven",
      equipmentIds: ["under_tank"],
    };

    expect(writeCachedCharacterAppearance("char-2", input)).toBe(true);
    const firstRaw = storage.getItem("successor3d.appearance.char-2");
    expect(writeCachedCharacterAppearance("char-2", input)).toBe(false);
    expect(storage.getItem("successor3d.appearance.char-2")).toBe(firstRaw);
  });

  it("drops corrupt cache entries instead of surfacing them", () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    storage.setItem("successor3d.appearance.char-bad", "{not-json");

    expect(readCachedCharacterAppearance("char-bad")).toBeNull();
    expect(storage.getItem("successor3d.appearance.char-bad")).toBeNull();
  });
});
