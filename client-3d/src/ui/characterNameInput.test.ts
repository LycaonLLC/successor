import { describe, expect, it } from "vitest";

import { filterCharacterNameInput, isValidCharacterName } from "./characterNameInput";

describe("isValidCharacterName", () => {
  it("accepts plain letter names within 3-16 total chars", () => {
    expect(isValidCharacterName("Ana")).toBe(true);
    expect(isValidCharacterName("Marlow")).toBe(true);
    expect(isValidCharacterName("Abcdefghijklmnop")).toBe(true); // 16
  });

  it("accepts single hyphens between letter runs, counted in total length", () => {
    expect(isValidCharacterName("Mara-Lyn")).toBe(true);
    expect(isValidCharacterName("A-b-c")).toBe(true);
    expect(isValidCharacterName("Abcdefg-hijklmno")).toBe(true); // 16 with hyphen
  });

  it("rejects out-of-range lengths", () => {
    expect(isValidCharacterName("")).toBe(false);
    expect(isValidCharacterName("Ab")).toBe(false);
    expect(isValidCharacterName("Abcdefghijklmnopq")).toBe(false); // 17
  });

  it("rejects bad hyphen placement", () => {
    expect(isValidCharacterName("-Mara")).toBe(false);
    expect(isValidCharacterName("Mara-")).toBe(false);
    expect(isValidCharacterName("Mara--Lyn")).toBe(false);
  });

  it("rejects non-letter characters", () => {
    expect(isValidCharacterName("Mara Lyn")).toBe(false);
    expect(isValidCharacterName("Mara7")).toBe(false);
    expect(isValidCharacterName("Márlow")).toBe(false);
    expect(isValidCharacterName("Mara_Lyn")).toBe(false);
  });
});

describe("filterCharacterNameInput", () => {
  it("strips everything outside letters and hyphens", () => {
    expect(filterCharacterNameInput("Mara Lyn7!")).toBe("MaraLyn");
    expect(filterCharacterNameInput("  spaced  ")).toBe("spaced");
  });

  it("drops leading hyphens and collapses hyphen runs", () => {
    expect(filterCharacterNameInput("--Mara")).toBe("Mara");
    expect(filterCharacterNameInput("Mara---Lyn")).toBe("Mara-Lyn");
  });

  it("keeps a trailing hyphen so hyphenated names stay typeable mid-word", () => {
    expect(filterCharacterNameInput("Mara-")).toBe("Mara-");
    // …while validity still flags it until letters follow.
    expect(isValidCharacterName("Mara-")).toBe(false);
    expect(isValidCharacterName("Mara-Lyn")).toBe(true);
  });

  it("caps at 16 chars and normalizes fullwidth input (NFKC)", () => {
    expect(filterCharacterNameInput("Abcdefghijklmnopqrst")).toBe("Abcdefghijklmnop");
    expect(filterCharacterNameInput("Ｍａｒａ")).toBe("Mara");
  });

  it("always emits output that only needs length/trailing-hyphen to validate", () => {
    for (const raw of ["!!!", "-a-b-", "9-9", "x", "Mara--", "ÅBC"]) {
      const filtered = filterCharacterNameInput(raw);
      expect(filtered === "" || /^[A-Za-z]+(?:-[A-Za-z]+)*-?$/u.test(filtered)).toBe(true);
      expect(filtered.length).toBeLessThanOrEqual(16);
    }
  });
});
