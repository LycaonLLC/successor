import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { STARTER_MACROS, starterMacroByName } from "@successor/client/src/slice-core/macroEngine/index";
import { createTuiMacroLibrary, defaultTuiMacroDir, loadLocalMacroFiles } from "./localMacroFiles";

function tempMacroDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "successor-tui-macro-"));
}

describe("TUI local macro file loader (desktop IPC parity)", () => {
  it("resolves the XDG config dir with a ~/.config fallback", () => {
    expect(defaultTuiMacroDir({ XDG_CONFIG_HOME: "/tmp/xdg" }))
      .toBe(path.join("/tmp/xdg", "successor", "macros"));
    expect(defaultTuiMacroDir({})).toBe(path.join(os.homedir(), ".config", "successor", "macros"));
    // Relative XDG_CONFIG_HOME is invalid per spec — ignored.
    expect(defaultTuiMacroDir({ XDG_CONFIG_HOME: "relative/dir" }))
      .toBe(path.join(os.homedir(), ".config", "successor", "macros"));
  });

  it("treats a missing directory as an empty listing", () => {
    const dir = path.join(tempMacroDir(), "never-created");
    expect(loadLocalMacroFiles(dir)).toEqual({ ok: true, dir, files: [], truncated: false });
  });

  it("reads UTF-8 .macro files and rejects bad names, oversize, invalid UTF-8, and symlinks per file", () => {
    const dir = tempMacroDir();
    fs.writeFileSync(path.join(dir, "field check.macro"), "# report\n/where\n");
    fs.writeFileSync(path.join(dir, ".hidden.macro"), "/where\n");
    fs.writeFileSync(path.join(dir, "big.macro"), "x".repeat(8193));
    fs.writeFileSync(path.join(dir, "bad-utf8.macro"), Buffer.from([0x2f, 0xff]));
    fs.symlinkSync(path.join(dir, "field check.macro"), path.join(dir, "link.macro"));
    fs.mkdirSync(path.join(dir, "sub.macro"));

    const listing = loadLocalMacroFiles(dir);
    expect(listing.ok).toBe(true);
    const byName = new Map(listing.files.map((row) => [row.fileName, row]));
    expect(byName.get("field check.macro")).toMatchObject({ name: "field check", body: "# report\n/where\n", bytes: 16 });
    expect(byName.get(".hidden.macro")?.error).toBe("invalid name");
    expect(byName.get("big.macro")?.error).toBe("oversize (8193 > 8192 bytes)");
    expect(byName.get("bad-utf8.macro")?.error).toBe("invalid UTF-8");
    expect(byName.get("link.macro")?.error).toBe("symlink rejected");
    expect(byName.get("sub.macro")?.error).toBe("not a regular file");
  });
});

describe("TUI macro library precedence (character > local > starter)", () => {
  it("ships the starter pack when no other tier exists", () => {
    const library = createTuiMacroLibrary({ localDir: null });
    expect(library.getMacro("field-report")?.body).toBe(starterMacroByName("field-report")!.body);
    expect(library.listDefs().filter((def) => def.source === "starter")).toHaveLength(STARTER_MACROS.length);
    expect(library.localIssues()).toEqual([]);
  });

  it("local files shadow starters; character defs shadow both; removal unshadows", () => {
    const dir = tempMacroDir();
    fs.writeFileSync(path.join(dir, "field-report.macro"), "/where\n");
    fs.writeFileSync(path.join(dir, "disk-only.macro"), "/vitals\n");
    const library = createTuiMacroLibrary({ localDir: dir });

    // local > starter
    expect(library.getMacro("Field-Report")).toMatchObject({ body: "/where\n" });
    expect(library.listDefs().find((def) => def.name.toLowerCase() === "field-report")?.source).toBe("local");
    expect(library.getMacro("disk-only")?.body).toBe("/vitals\n");

    // character > local
    library.define("Field-Report", "/queue\n");
    expect(library.getMacro("field-report")).toMatchObject({ name: "Field-Report", body: "/queue\n" });
    expect(library.listDefs().find((def) => def.name.toLowerCase() === "field-report")?.source).toBe("character");
    // shadowed names appear once in the merged list
    expect(library.listDefs().filter((def) => def.name.toLowerCase() === "field-report")).toHaveLength(1);

    // removing the character def unshadows the local file; lower tiers are immutable
    expect(library.remove("field-report")).toBe(true);
    expect(library.getMacro("field-report")).toMatchObject({ body: "/where\n" });
    expect(library.remove("field-report")).toBe(false);
    expect(library.getMacro("field-report")).toMatchObject({ body: "/where\n" });
    expect(library.remove("open-fire")).toBe(false);
    expect(library.getMacro("open-fire")?.body).toBe(starterMacroByName("open-fire")!.body);
  });

  it("surfaces per-file load errors while keeping good files usable", () => {
    const dir = tempMacroDir();
    fs.writeFileSync(path.join(dir, "good.macro"), "/where\n");
    fs.writeFileSync(path.join(dir, "bad.macro"), Buffer.from([0xff, 0xfe]));
    const library = createTuiMacroLibrary({ localDir: dir });
    expect(library.getMacro("good")?.body).toBe("/where\n");
    expect(library.getMacro("bad")).toBeNull();
    expect(library.localIssues()).toEqual(["bad.macro: invalid UTF-8"]);
  });
});
