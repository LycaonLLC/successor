// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { STARTER_MACROS } from "@successor/client/src/slice-core/macroEngine/index";
import { createMacrosWindowDefinition } from "./macrosWindow";
import type { WindowContext } from "../windows/windowManager";
import type { MacroRuntime } from "./runtime";
import { refreshLocalMacros, resetLocalMacrosForTest } from "./localMacros";
import { configureMacroStore, resetMacroStoreForTest } from "./store";

interface FakeRuntime {
  runtime: MacroRuntime;
  started: string[];
}

function fakeRuntime(): FakeRuntime {
  const started: string[] = [];
  const runtime = {
    update: vi.fn(),
    start: (name: string) => {
      started.push(name);
      return { ok: true as const, runId: `run_${started.length}` };
    },
    stop: vi.fn(() => 0),
    runs: () => [],
    engineState: () => ({ activeRuns: [], completedRuns: [], caps: { runSlots: 4 } }),
    drainNotices: () => [],
    handleSlashLine: () => null,
  } as unknown as MacroRuntime;
  return { runtime, started };
}

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

async function seedLocalFiles(files: unknown[]): Promise<void> {
  resetLocalMacrosForTest({ macroFiles: async () => ({ ok: true, files, truncated: false }) });
  await refreshLocalMacros();
}

interface Mounted {
  root: HTMLElement;
  dispose: () => void;
  rows: () => HTMLElement[];
  rowByKey: (key: string) => HTMLElement;
}

// The macros window mount ignores WindowContext; an empty stub satisfies the signature.
const windowCtx = {} as WindowContext;

function mountWindow(runtime: MacroRuntime): Mounted {
  const contentRoot = document.createElement("div");
  document.body.appendChild(contentRoot);
  const definition = createMacrosWindowDefinition({ runtime, notices: { take: () => null } });
  const handle = definition.mount(contentRoot, windowCtx);
  return {
    root: contentRoot,
    dispose: () => {
      handle.dispose();
      contentRoot.remove();
    },
    rows: () => [...contentRoot.querySelectorAll<HTMLElement>(".scp-macro-row")],
    rowByKey: (key: string) => {
      const row = contentRoot.querySelector<HTMLElement>(`.scp-macro-row[data-key="${key}"]`);
      if (!row) throw new Error(`missing directory row ${key}`);
      return row;
    },
  };
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

afterEach(() => {
  resetMacroStoreForTest();
  resetLocalMacrosForTest();
  document.body.innerHTML = "";
});

describe("macros window directory (three providers)", () => {
  it("labels every row with its source and lists all tiers", async () => {
    await seedLocalFiles([{ name: "disk-only", fileName: "disk-only.macro", bytes: 8, body: "/vitals\n" }]);
    seedRecord([{ name: "my-macro", body: "/where\n" }]);
    const { runtime } = fakeRuntime();
    const win = mountWindow(runtime);

    const rows = win.rows();
    expect(rows).toHaveLength(1 + 1 + STARTER_MACROS.length);
    expect(win.rowByKey("character:my-macro").querySelector(".scp-macro-source")?.textContent).toBe("RECORD");
    expect(win.rowByKey("local:disk-only.macro").querySelector(".scp-macro-source")?.textContent).toBe("LOCAL");
    expect(win.rowByKey("starter:field-report").querySelector(".scp-macro-source")?.textContent).toBe("STARTER");
    win.dispose();
  });

  it("runs starter and local macros directly from their rows", async () => {
    await seedLocalFiles([{ name: "disk-only", fileName: "disk-only.macro", bytes: 8, body: "/vitals\n" }]);
    seedRecord([]);
    const { runtime, started } = fakeRuntime();
    const win = mountWindow(runtime);

    click(win.rowByKey("starter:open-fire").querySelector('button[data-action="run"]')!);
    click(win.rowByKey("local:disk-only.macro").querySelector('button[data-action="run"]')!);
    expect(started).toEqual(["open-fire", "disk-only"]);
    win.dispose();
  });

  it("clones an immutable starter into a new character buffer instead of editing it", () => {
    seedRecord([]);
    const { runtime } = fakeRuntime();
    const win = mountWindow(runtime);

    click(win.rowByKey("starter:stand-down"));
    const nameInput = win.root.querySelector<HTMLInputElement>('[data-ref="name"]')!;
    const bodyInput = win.root.querySelector<HTMLTextAreaElement>('[data-ref="body"]')!;
    const bufferTag = win.root.querySelector<HTMLElement>('[data-ref="bufferTag"]')!;
    const deleteBtn = win.root.querySelector<HTMLButtonElement>('[data-ref="delete"]')!;
    expect(nameInput.value).toBe("stand-down");
    expect(bodyInput.value).toBe(STARTER_MACROS.find((m) => m.name === "stand-down")!.body);
    expect(bufferTag.textContent).toBe("CLONE · STARTER — SAVE TO RECORD");
    // Immutability: a clone buffer has no record id to delete.
    expect(deleteBtn.disabled).toBe(true);
    win.dispose();
  });

  it("marks shadowed lower-tier rows and keeps them clone-only", () => {
    seedRecord([{ name: "field-report", body: "/queue\n" }]);
    const { runtime } = fakeRuntime();
    const win = mountWindow(runtime);

    const shadowed = win.rowByKey("starter:field-report");
    expect(shadowed.hasAttribute("data-shadowed")).toBe(true);
    expect(shadowed.querySelector(".scp-macro-source")?.textContent).toBe("SHADOWED");
    expect(shadowed.querySelector('button[data-action="run"]')).toBeNull();
    win.dispose();
  });

  it("shows local load/parse errors on the row and in the sync foot", async () => {
    await seedLocalFiles([
      { name: "broken", fileName: "broken.macro", error: "invalid UTF-8" },
      { name: "bad-parse", fileName: "bad-parse.macro", bytes: 7, body: "/until\n" },
    ]);
    seedRecord([]);
    const { runtime } = fakeRuntime();
    const win = mountWindow(runtime);

    const broken = win.rowByKey("local:broken.macro");
    expect(broken.hasAttribute("data-error")).toBe(true);
    expect(broken.querySelector(".scp-macro-preview")?.textContent).toBe("INVALID UTF-8");
    expect(broken.querySelector('button[data-action="run"]')).toBeNull();
    const badParse = win.rowByKey("local:bad-parse.macro");
    expect(badParse.querySelector(".scp-macro-preview")?.textContent).toMatch(/^PARSE L1:/);

    const sync = win.root.querySelector<HTMLElement>('[data-ref="sync"]')!;
    expect(sync.textContent).toContain("2 LOCAL FILES FAILED");
    expect(sync.hasAttribute("data-bad")).toBe(true);
    win.dispose();
  });
});
