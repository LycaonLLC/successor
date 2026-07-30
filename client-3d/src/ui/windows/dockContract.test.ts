// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import type { SfxPlayer } from "@successor/client/src/audio/sfx";
import { createPlayState, type PlayState, type SliceSnapshot } from "@successor/client/src/slice-core/gameState";
import { createWindowManager, type WindowManager } from "./windowManager";
import { createWindowDock } from "./dock";
import { createCharacterWindowDefinition } from "./defs/characterWindow";
import { createSkillsWindowDefinition } from "./defs/skillsWindow";
import { createDatapadWindowDefinition } from "./defs/datapadWindow";
import { createOptionsWindowDefinition } from "./defs/optionsWindow";
import { createPaWindowDefinition, PA_WINDOW_ID } from "./defs/paWindow";
import { createActionBrowserWindowDefinition } from "./defs/actionBrowserWindow";
import { createFxLabWindowDefinition, FX_LAB_WINDOW_ID } from "./defs/fxLabWindow";
import { createInventoryWindowDefinition } from "../inventory/shell";
import { createMacrosWindowDefinition } from "../macros/macrosWindow";
import { createCraftWindowDefinition, CRAFT_WINDOW_ID } from "../crafting/craftWindow";
import { createSpliceWindowDefinition, SPLICE_WINDOW_ID } from "../splice/spliceWindow";
import type { ContextRadial } from "./contextRadial";
import type { ToolbarController } from "../hud/toolbar";
import type { MacroRuntime } from "../macros/runtime";
import { UI_ICONS } from "../icons";
import { getUiTheme, setUiTheme } from "../uiTheme";
import { createSlashCommandRouter } from "../hud/slashCommands";

/**
 * Dock contract (owner ruling 2026-07-11): the right rail is PERMANENT
 * DESTINATIONS ONLY — character, inventory, datapad, skills, actions,
 * macros, options, association, in that order. Craft/Gene Bench are
 * context-only (no dock button or global hotkey), and the FX Lab never takes
 * a rail button even when its dev flag registers it. The rail retains the
 * quick theme-cycle swatch while OPTIONS provides the full named picker.
 */

function fixtureSlice(): SliceSnapshot {
  return {
    schema: "successor.slice-core.v1",
    tick: 12,
    tickRateHz: 20,
    combatModel: "roll",
    grid: { cellSizePx: 32 },
    zone: { id: 1, name: "Open Desert", width: 40, height: 24, level: 0 },
    areas: [{ id: "desert", name: "Open Desert", kind: "overworld", width: 40, height: 24, level: 0 }],
    stateHash: "dock-contract-fixture",
    camera: { followActor: "player", zoom: 1 },
    actors: [{
      id: "player",
      entity: "actor/player",
      areaId: "desert",
      label: "Field Observer",
      role: "player",
      sprite: "adventurer-premium-male",
      poseSet: "walk",
      direction: "left",
      cell: { x: 4, y: 5 },
      route: [],
    }],
    props: [],
    blockedCells: [],
    transitions: [],
    inventory: [],
    reservations: [],
    events: [],
  };
}

function sfx(): SfxPlayer {
  return { play: vi.fn(), playAt: vi.fn() } as unknown as SfxPlayer;
}

/** Register the full boot family in successor3dApp's registration order. */
function bootManager(): { manager: WindowManager; state: PlayState } {
  const state: PlayState = createPlayState(fixtureSlice());
  const mount = document.createElement("div");
  document.body.appendChild(mount);
  const manager = createWindowManager({
    mount,
    state,
    slice: fixtureSlice(),
    storageScope: `dock-contract-${Math.random()}`,
  });
  const radial = { openFor: vi.fn(), close: vi.fn(), dispose: vi.fn() } as unknown as ContextRadial;
  const toolbar = {
    pressCode: vi.fn(() => false),
    rebindSlot: vi.fn(),
  } as unknown as ToolbarController;
  const runtime = { update: vi.fn(), drainNotices: vi.fn(() => []) } as unknown as MacroRuntime;
  const s = sfx();
  // Mirror of the composition root's registration order (successor3dApp.ts).
  manager.register(createCharacterWindowDefinition());
  manager.register(createInventoryWindowDefinition({ radial, sfx: s }));
  manager.register(createDatapadWindowDefinition({ radial, sfx: s }));
  manager.register(createSkillsWindowDefinition());
  manager.register(createActionBrowserWindowDefinition(toolbar));
  manager.register(createMacrosWindowDefinition({ runtime, notices: { take: () => null }, sfx: s }));
  manager.register(createOptionsWindowDefinition(toolbar, { openWindow: (id) => manager.open(id) }));
  manager.register(createPaWindowDefinition());
  manager.register(createCraftWindowDefinition({ commands: {} as never, sfx: s }));
  manager.register(createSpliceWindowDefinition({ commands: {} as never, sfx: s }));
  manager.register(createFxLabWindowDefinition());
  return { manager, state };
}

describe("dock contract — permanent destinations only", () => {
  it("exposes exactly the eight destination windows, in order", () => {
    const { manager } = bootManager();
    expect(manager.dockEntries().map((e) => e.id)).toEqual([
      "character",
      "inventory",
      "datapad",
      "skills",
      "actions",
      "macros",
      "options",
      PA_WINDOW_ID,
    ]);
    manager.dispose();
  });

  it("excludes craft, gene bench and fx lab from the rail", () => {
    const { manager } = bootManager();
    const ids = manager.dockEntries().map((e) => e.id);
    for (const excluded of [CRAFT_WINDOW_ID, SPLICE_WINDOW_ID, "fxlab"]) {
      expect(ids).not.toContain(excluded);
    }
    manager.dispose();
  });

  it("drops the old context and authoring global hotkeys (G now belongs to ASSOCIATION)", () => {
    const { manager } = bootManager();
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyG" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyN" }));
    expect(manager.isOpen(CRAFT_WINDOW_ID)).toBe(false);
    expect(manager.isOpen(SPLICE_WINDOW_ID)).toBe(false);
    // Normal-game entry path: the G hotkey opens the PA window anywhere.
    expect(manager.isOpen(PA_WINDOW_ID)).toBe(true);

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "F10" }));
    expect(manager.root.querySelector('[data-window-id="author"]')).toBeNull();
    manager.dispose();
  });

  it("renders eight destination buttons plus the quick theme-cycle swatch", () => {
    const { manager } = bootManager();
    const dock = createWindowDock(manager);
    const rail = manager.root.querySelector(".sc3d-dock");
    expect(rail).not.toBeNull();
    const buttons = [...rail!.querySelectorAll<HTMLButtonElement>(".sc3d-dock-btn")];
    expect(buttons.map((b) => b.dataset.dockWindow)).toEqual([
      "character",
      "inventory",
      "datapad",
      "skills",
      "actions",
      "macros",
      "options",
      PA_WINDOW_ID,
    ]);
    expect(rail!.querySelector(".sc3d-dock-swatch")).not.toBeNull();
    dock.dispose();
    manager.dispose();
  });

  it("cycles all four palettes from the rail and persists the result", () => {
    setUiTheme("signal");
    const { manager } = bootManager();
    const dock = createWindowDock(manager);
    const swatch = manager.root.querySelector<HTMLButtonElement>(".sc3d-dock-swatch")!;

    const sequence = ["phosphor", "amber", "oxide", "signal"];
    for (const expected of sequence) {
      swatch.click();
      expect(getUiTheme()).toBe(expected);
      expect(document.documentElement.dataset.sc3dTheme).toBe(expected);
      expect(localStorage.getItem("successor3d.theme.v1")).toBe(expected);
    }

    dock.dispose();
    manager.dispose();
  });
});

describe("/ui allow list — dock destinations only (boot wiring mirror)", () => {
  it("opens the eight destinations and denies context/dev surfaces for a normal player", () => {
    const { manager, state } = bootManager();
    // Mirror of successor3dApp wiring: ONE mutable array handed to the
    // router at creation, filled from dockEntries() after registration.
    // Normal player = fx lab dev flag OFF, so fxlab never joins the list.
    const slashWindowIds: string[] = [];
    const opened: string[] = [];
    const router = createSlashCommandRouter(state, fixtureSlice(), {
      openWindow: (id) => opened.push(id),
      knownWindowIds: slashWindowIds,
    });
    slashWindowIds.push(...manager.dockEntries().map((entry) => entry.id));

    const destinations = ["character", "inventory", "datapad", "skills", "actions", "macros", "options", PA_WINDOW_ID];
    for (const id of destinations) {
      expect(router.handle(`/ui ${id}`)).toBe(`UI ${id.toUpperCase()}`);
    }
    expect(opened).toEqual(destinations);

    opened.length = 0;
    for (const denied of ["craft", "splice", "author", "fxlab", "survey", "travel", "loot", "examine"]) {
      expect(router.handle(`/ui ${denied}`)).toBe("UI DENIED — UNKNOWN WINDOW");
    }
    expect(opened).toEqual([]);
    expect(manager.isOpen(CRAFT_WINDOW_ID)).toBe(false);
    expect(manager.isOpen(SPLICE_WINDOW_ID)).toBe(false);
    expect(manager.isOpen("fxlab")).toBe(false);
    manager.dispose();
  });

  it("allows /ui fxlab only under the dev flag (boot's conditional push)", () => {
    const { manager, state } = bootManager();
    const slashWindowIds: string[] = [];
    const opened: string[] = [];
    const router = createSlashCommandRouter(state, fixtureSlice(), {
      openWindow: (id) => opened.push(id),
      knownWindowIds: slashWindowIds,
    });
    slashWindowIds.push(...manager.dockEntries().map((entry) => entry.id));
    // Boot's exact conditional: `if (fxLabRequested()) slashWindowIds.push(FX_LAB_WINDOW_ID)`
    // — with the flag on, the registered lab becomes /ui-reachable.
    slashWindowIds.push(FX_LAB_WINDOW_ID);

    expect(router.handle("/ui fxlab")).toBe("UI FXLAB");
    expect(router.handle("/ui fx")).toBe("UI FXLAB");
    expect(opened).toEqual([FX_LAB_WINDOW_ID, FX_LAB_WINDOW_ID]);
    // Removed legacy authoring surface stays unreachable.
    expect(router.handle("/ui author")).toBe("UI DENIED — UNKNOWN WINDOW");
    manager.dispose();
  });
});

describe("inventory → context-window handoff (boot opener wiring mirror)", () => {
  /** Minimal defs so open() can mount without WebGL/asset machinery. */
  function stubDef(id: string): Parameters<WindowManager["register"]>[0] {
    return {
      id,
      title: id.toUpperCase(),
      icon: "examine",
      hotkey: null,
      dockVisible: false,
      minWidth: 100,
      minHeight: 100,
      defaultBounds: () => ({ x: 0, y: 0, w: 100, h: 100 }),
      mount: () => ({ update: vi.fn(), onResized: vi.fn(), dispose: vi.fn() }),
    };
  }

  function handoffManager(): WindowManager {
    const state: PlayState = createPlayState(fixtureSlice());
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const manager = createWindowManager({
      mount,
      state,
      slice: fixtureSlice(),
      storageScope: `handoff-${Math.random()}`,
    });
    manager.register(stubDef("inventory"));
    for (const id of [CRAFT_WINDOW_ID, SPLICE_WINDOW_ID, "surveyTool"]) manager.register(stubDef(id));
    return manager;
  }

  it("closes INVENTORY before opening the destination — one coherent transition", () => {
    const manager = handoffManager();
    for (const destination of [CRAFT_WINDOW_ID, SPLICE_WINDOW_ID, "surveyTool"]) {
      manager.open("inventory");
      expect(manager.isOpen("inventory")).toBe(true);
      // Exact opener-callback sequence from successor3dApp's register*Opener wiring.
      manager.close("inventory");
      manager.open(destination);
      expect(manager.isOpen("inventory")).toBe(false);
      expect(manager.isOpen(destination)).toBe(true);
      manager.close(destination);
    }
    manager.dispose();
  });

  it("tolerates the handoff when INVENTORY was not open (close is a no-op)", () => {
    const manager = handoffManager();
    manager.close("inventory");
    manager.open(CRAFT_WINDOW_ID);
    expect(manager.isOpen(CRAFT_WINDOW_ID)).toBe(true);
    expect(manager.isOpen("inventory")).toBe(false);
    manager.dispose();
  });
});

describe("macro glyph geometry", () => {
  it("keeps the terminal card balanced and uncropped in the 24×24 viewBox", () => {
    const host = document.createElement("span");
    host.innerHTML = UI_ICONS.macro;
    const svg = host.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    const strokeWidth = Number(svg.getAttribute("stroke-width"));
    expect(strokeWidth).toBe(1.5);

    const rect = host.querySelector("rect")!;
    const x = Number(rect.getAttribute("x"));
    const y = Number(rect.getAttribute("y"));
    const w = Number(rect.getAttribute("width"));
    const h = Number(rect.getAttribute("height"));

    // Balanced padding: top margin == bottom margin, left == right.
    expect(y).toBeCloseTo(24 - (y + h), 5);
    expect(x).toBeCloseTo(24 - (x + w), 5);
    // No crop: the OUTER stroke edge stays inside the viewBox with slack,
    // even at the dock's ~22px render.
    const margin = strokeWidth / 2;
    expect(y - margin).toBeGreaterThanOrEqual(3);
    expect(x - margin).toBeGreaterThanOrEqual(3);

    // Prompt chevron + verb line sit comfortably INSIDE the card (≥1.5px
    // clear of every card edge — nothing kisses the border).
    const paths = [...host.querySelectorAll("path")].map((p) => p.getAttribute("d")!);
    expect(paths).toHaveLength(2);
    // Recover absolute points from the two simple paths.
    const [chevron, verb] = paths;
    const c = chevron!.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    // M cx cy l dx1 dy1 dx2 dy2 — absolute xs/ys of all three points.
    const chevronPts = [
      { x: c[0]!, y: c[1]! },
      { x: c[0]! + c[2]!, y: c[1]! + c[3]! },
      { x: c[0]! + c[2]! + c[4]!, y: c[1]! + c[3]! + c[5]! },
    ];
    const v = verb!.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    const verbPts = [
      { x: v[0]!, y: v[1]! },
      { x: v[0]! + v[2]!, y: v[1]! },
    ];
    for (const pt of [...chevronPts, ...verbPts]) {
      expect(pt.x).toBeGreaterThanOrEqual(x + 1.5);
      expect(pt.x).toBeLessThanOrEqual(x + w - 1.5);
      expect(pt.y).toBeGreaterThanOrEqual(y + 1.5);
      expect(pt.y).toBeLessThanOrEqual(y + h - 1.5);
    }
  });
});
