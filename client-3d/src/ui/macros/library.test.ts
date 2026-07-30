import { afterEach, describe, expect, it } from "vitest";

import { STARTER_MACROS } from "@successor/client/src/slice-core/macroEngine/index";
import {
  localProviderNotice,
  macroLibraryRowByKey,
  macroLibraryRows,
  macroLibraryVersion,
  resolveMacroSource,
} from "./library";
import { localMacroDirError, refreshLocalMacros, resetLocalMacrosForTest } from "./localMacros";
import { configureMacroStore, resetMacroStoreForTest } from "./store";

/** Seed the character record with named macros (id = lowercased name). */
function seedRecord(macros: { name: string; body: string }[]): void {
  configureMacroStore({
    apiBase: "http://127.0.0.1:9",
    characterId: "char_test",
    seed: {
      version: 1,
      items: macros.map((macro) => ({
        id: macro.name.toLowerCase(),
        name: macro.name,
        body: macro.body,
        iconId: "macro:command",
        createdAt: "",
        updatedAt: "",
      })),
    },
  });
}

/** Fake desktop bridge answering with a canned macro-files result. */
function fakeBridge(result: unknown): { macroFiles: () => Promise<never> } {
  return { macroFiles: async () => result as never };
}

afterEach(() => {
  resetMacroStoreForTest();
  resetLocalMacrosForTest();
});

describe("macro library provider merge (character > local > starter)", () => {
  it("browser build: starters only, resolution by starter body", () => {
    resetLocalMacrosForTest(null); // no desktop bridge
    seedRecord([]);
    const rows = macroLibraryRows();
    expect(rows).toHaveLength(STARTER_MACROS.length);
    expect(rows.every((row) => row.source === "starter" && !row.shadowed && row.error === null)).toBe(true);
    expect(resolveMacroSource("Field-Report")).toMatchObject({ name: "field-report", source: "starter" });
    expect(resolveMacroSource("ghost")).toBeNull();
    expect(localProviderNotice()).toBeNull();
  });

  it("local files shadow starters; character macros shadow both", async () => {
    resetLocalMacrosForTest(fakeBridge({
      ok: true,
      files: [
        { name: "field-report", fileName: "field-report.macro", bytes: 7, body: "/where\n" },
        { name: "disk-only", fileName: "disk-only.macro", bytes: 8, body: "/vitals\n" },
      ],
      truncated: false,
    }));
    await refreshLocalMacros();
    seedRecord([{ name: "field-report", body: "/queue\n" }]);

    expect(resolveMacroSource("field-report")).toMatchObject({ source: "character", body: "/queue\n" });
    expect(resolveMacroSource("disk-only")).toMatchObject({ source: "local", body: "/vitals\n" });
    expect(resolveMacroSource("open-fire")?.source).toBe("starter");

    const rows = macroLibraryRows();
    expect(rows.find((row) => row.key === "local:field-report.macro")?.shadowed).toBe(true);
    expect(rows.find((row) => row.key === "starter:field-report")?.shadowed).toBe(true);
    expect(rows.find((row) => row.key === "local:disk-only.macro")?.shadowed).toBe(false);
    expect(rows.find((row) => row.key === "starter:disk-only")).toBeUndefined();
    expect(macroLibraryRowByKey("character:field-report")).toMatchObject({ source: "character", savedId: "field-report" });
  });

  it("local load and parse errors are visible rows, never resolvable", async () => {
    resetLocalMacrosForTest(fakeBridge({
      ok: true,
      files: [
        { name: "broken", fileName: "broken.macro", error: "invalid UTF-8" },
        { name: "bad-parse", fileName: "bad-parse.macro", bytes: 10, body: "/until\n" },
        { name: "good", fileName: "good.macro", bytes: 7, body: "/where\n" },
      ],
      truncated: false,
    }));
    await refreshLocalMacros();
    seedRecord([]);

    const rows = macroLibraryRows();
    const broken = rows.find((row) => row.key === "local:broken.macro");
    expect(broken).toMatchObject({ error: "invalid UTF-8", body: null, shadowed: false });
    const badParse = rows.find((row) => row.key === "local:bad-parse.macro");
    expect(badParse?.error).toMatch(/^parse L1: /);
    expect(badParse?.body).toBe("/until\n"); // body kept so CLONE can fix it
    expect(resolveMacroSource("broken")).toBeNull();
    expect(resolveMacroSource("bad-parse")).toBeNull();
    expect(resolveMacroSource("good")?.source).toBe("local");
    expect(localProviderNotice()).toBe("2 LOCAL FILES FAILED");
  });

  it("directory-level failure surfaces as a provider notice and empty tier", async () => {
    resetLocalMacrosForTest(fakeBridge({ ok: false, error: "macro directory unreadable: EACCES" }));
    await refreshLocalMacros();
    seedRecord([]);
    expect(localMacroDirError()).toBe("macro directory unreadable: EACCES");
    expect(localProviderNotice()).toBe("MACRO DIRECTORY UNREADABLE: EACCES");
    expect(macroLibraryRows().filter((row) => row.source === "local")).toHaveLength(0);
  });

  it("library version bumps on both record sync and local refresh", async () => {
    resetLocalMacrosForTest(fakeBridge({ ok: true, files: [], truncated: false }));
    seedRecord([]);
    const before = macroLibraryVersion();
    await refreshLocalMacros();
    expect(macroLibraryVersion()).toBeGreaterThan(before);
  });
});
