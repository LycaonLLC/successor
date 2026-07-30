// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { directions } from "@successor/client/src/slice-core/geometry";
import {
  createPlayState,
  type InventoryRow,
  type SliceSnapshot,
} from "@successor/client/src/slice-core/gameState";
import type { WindowContext } from "../windows/windowManager";
import type { CraftCommandPort } from "./commands";
import { craftPreviewCategoryForItemId, createCraftWindowDefinition } from "./craftWindow";
import { fixtureRecipes, fixtureSamplerDetail, fixtureSessionAssembled, fixtureSessionSlots } from "./fixtures";
import { ingestCraftRecipeDetail, ingestCraftRecipes, ingestCraftSession } from "./store";

// The 3D turntable needs a WebGL context — the window contract under test is
// pure DOM, so the renderer is a seam here.
vi.mock("../inventory/modelRenderer", () => ({
  InventoryModelRenderer: {
    create: () => ({
      canvas: document.createElement("canvas"),
      setLayoutRects: () => {},
      render: () => {},
      dispose: () => {},
    }),
  },
}));

function craftSlice(inventory: InventoryRow[]): SliceSnapshot {
  return {
    schema: "successor.slice-core.v1",
    tick: 12,
    tickRateHz: 20,
    combatModel: "roll",
    grid: { cellSizePx: 32 },
    zone: { id: 1, name: "Open Desert", width: 20, height: 12, level: 0 },
    areas: [{ id: "desert", name: "Open Desert", kind: "overworld", width: 20, height: 12, level: 0 }],
    stateHash: "craft-window-fixture",
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
    inventory,
    reservations: [],
    events: [],
  };
}

const row = (itemId: number, quantity: number, stackId: number): InventoryRow => ({
  container: "player:field-pack",
  item: `Item ${itemId}`,
  itemId,
  variantId: 0,
  quantity,
  reserved: 0,
  available: quantity,
  stackId,
});

interface CommandLog {
  port: CraftCommandPort;
  assigns: Array<{ slotIndex: number; container: string; stackId: string; variantId: number }>;
  experiments: Array<{ lineId: number; points: number }>;
  /** CraftFinalizePrototype custom_name payloads in send order. */
  prototypeNames: string[];
  /** CraftDraftSchematic max_uses payloads in send order. */
  draftUses: number[];
  /** Parameterless command kinds in send order (assemble/practice/…). */
  calls: string[];
}

function commandLog(): CommandLog {
  const assigns: CommandLog["assigns"] = [];
  const experiments: CommandLog["experiments"] = [];
  const prototypeNames: string[] = [];
  const draftUses: number[] = [];
  const calls: string[] = [];
  return {
    assigns,
    experiments,
    prototypeNames,
    draftUses,
    calls,
    port: {
      begin: () => true,
      assignSlot: (slotIndex, container, stackId, variantId) => {
        assigns.push({ slotIndex, container, stackId, variantId });
        return true;
      },
      clearSlot: () => true,
      assemble: () => {
        calls.push("assemble");
        return true;
      },
      experiment: (lineId, points) => {
        experiments.push({ lineId, points });
        return true;
      },
      finalizePrototype: (customName) => {
        calls.push("prototype");
        prototypeNames.push(customName);
        return true;
      },
      finalizePractice: () => {
        calls.push("practice");
        return true;
      },
      draftSchematic: (maxUses) => {
        draftUses.push(maxUses);
        return true;
      },
      cancel: () => true,
    },
  };
}

function mountCraft(inventory: InventoryRow[], commands: CraftCommandPort): { root: HTMLElement; update: () => void; dispose: () => void } {
  const slice = craftSlice(inventory);
  const state = createPlayState(slice, "player");
  state.serverAuthority.playerActorId = "player";
  const ctx: WindowContext = { state, slice } as WindowContext;
  const contentRoot = document.createElement("div");
  document.body.appendChild(contentRoot);
  const handle = createCraftWindowDefinition({ commands }).mount(contentRoot, ctx);
  return {
    root: contentRoot,
    update: () => handle.update(0.016, performance.now()),
    dispose: () => {
      handle.dispose();
      contentRoot.remove();
    },
  };
}

beforeEach(() => {
  document.body.textContent = "";
  ingestCraftSession(null);
  ingestCraftRecipes(fixtureRecipes());
  ingestCraftRecipeDetail(fixtureSamplerDetail());
});

describe("craft preview classification", () => {
  it("routes standardized fuel and polymer outputs through the resource preview", () => {
    expect(craftPreviewCategoryForItemId(2009)).toBe("resource");
    expect(craftPreviewCategoryForItemId(2010)).toBe("resource");
    expect(craftPreviewCategoryForItemId(4001)).toBe("item");
  });
});

describe("craft window browse ledger", () => {
  it("defaults to eligible recipes and reveals locked profession paths on request", () => {
    const { root, update, dispose } = mountCraft([row(3001, 1, 13)], commandLog().port);
    update();
    expect(root.querySelector('[data-recipe-id="slugthrower"]')).toBeNull();
    expect(root.querySelectorAll('[data-locked]').length).toBe(0);

    const toggle = root.querySelector<HTMLButtonElement>('[data-ref="showIneligible"]')!;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    toggle.click();
    update();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(root.querySelector('[data-recipe-id="slugthrower"]')).not.toBeNull();
    expect(root.querySelector('[data-recipe-id="slugthrower"]')?.hasAttribute("data-locked")).toBe(true);
    dispose();
  });

  it("shows both sampler requirements with carried counts and READY/MISSING before beginning", () => {
    // Iron 100 ≥ 80 (READY) and Copper 12 < 36 (MISSING), plus the multitool.
    const { root, update, dispose } = mountCraft(
      [row(2001, 100, 11), row(2007, 12, 12), row(3001, 1, 13)],
      commandLog().port,
    );
    update();
    const samplerRow = root.querySelector<HTMLElement>('[data-recipe-id="metal_extractor"]');
    expect(samplerRow).not.toBeNull();
    samplerRow!.click();
    update();
    const requirements = [...root.querySelectorAll<HTMLElement>(".scp-craft-req")];
    expect(requirements).toHaveLength(2);
    const [iron, copper] = requirements;
    expect(iron!.querySelector(".scp-craft-req-material")!.textContent).toBe("Iron (×80)");
    expect(iron!.hasAttribute("data-ready")).toBe(true);
    expect(iron!.querySelector(".scp-craft-req-state")!.textContent).toBe("READY");
    expect(iron!.querySelector(".scp-craft-req-owned")!.textContent).toBe("100 carried");
    expect(copper!.querySelector(".scp-craft-req-material")!.textContent).toBe("Copper (×36)");
    expect(copper!.hasAttribute("data-missing")).toBe(true);
    expect(copper!.querySelector(".scp-craft-req-state")!.textContent).toBe("MISSING");
    expect(copper!.querySelector(".scp-craft-req-owned")!.textContent).toBe("12 carried");
    dispose();
  });
});

describe("craft window LOAD phase", () => {
  it("keeps every slot card visible, marks the selected slot, and loads on a single click", () => {
    const log = commandLog();
    const { root, update, dispose } = mountCraft([row(3001, 1, 13)], log.port);
    ingestCraftSession(fixtureSessionSlots());
    update();

    // Both remaining slot cards stay on screen with the selected one marked.
    // The wrapper is non-interactive; the seat <button role=radio> carries
    // selection and CLEAR is its sibling.
    const cards = [...root.querySelectorAll<HTMLElement>(".scp-craft-slotcard")];
    expect(cards).toHaveLength(3);
    expect(cards[0]!.hasAttribute("data-selected")).toBe(true);
    expect(cards[0]!.hasAttribute("role")).toBe(false);
    const seats = cards.map((card) => card.querySelector<HTMLButtonElement>(".scp-craft-slot-seat")!);
    expect(seats[0]!.getAttribute("role")).toBe("radio");
    expect(seats[0]!.getAttribute("aria-checked")).toBe("true");
    expect(seats[1]!.getAttribute("aria-checked")).toBe("false");
    expect(root.querySelector('[data-ref="slotCards"]')!.getAttribute("role")).toBe("radiogroup");
    // Keyboard: the seat is a native button — activating it selects the slot.
    seats[1]!.click();
    update();
    expect(cards[1]!.hasAttribute("data-selected")).toBe(true);
    seats[0]!.click();
    update();
    expect(cards[0]!.hasAttribute("data-selected")).toBe(true);

    // The header names the active slot and requirement.
    expect(root.querySelector('[data-ref="activeSlot"]')!.textContent).toBe("LOADING · COPPER CONDUCTOR · ×24");

    // Every eligible stack carries a real LOAD button; a single click queues
    // the assignment for the selected slot.
    const loadButtons = [...root.querySelectorAll<HTMLButtonElement>(".scp-craft-opt-load")];
    expect(loadButtons).toHaveLength(3);
    loadButtons[0]!.click();
    expect(log.assigns).toEqual([
      { slotIndex: 0, container: "player:field-pack", stackId: "11", variantId: 220_431 },
    ]);

    // The short Ashfall stack stays visible but honestly refused, with the
    // exact shortage named.
    const shortRow = root.querySelector<HTMLElement>('.scp-craft-opt[data-short]')!;
    expect(shortRow.querySelector(".scp-craft-opt-note")!.textContent).toBe("OWN 2 · NEED 24");
    const shortLoad = shortRow.querySelector<HTMLButtonElement>(".scp-craft-opt-load")!;
    expect(shortLoad.disabled).toBe(true);
    shortLoad.click();
    expect(log.assigns).toHaveLength(1);
    dispose();
  });

  it("nests no interactive control inside another radio or button", () => {
    const { root, update, dispose } = mountCraft([row(3001, 1, 13)], commandLog().port);
    ingestCraftSession(fixtureSessionSlots(true));
    update();
    const hosts = [...root.querySelectorAll<HTMLElement>('[role="radio"], button')];
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) {
      const nested = host.querySelector('button, [role="radio"], input, select, a[href], [tabindex]');
      expect(nested, host.outerHTML.slice(0, 120)).toBeNull();
    }
    dispose();
  });
});

describe("craft window live-emission interaction stability", () => {
  it("keeps recipe rows as the same live nodes through snapshot emissions, so selection clicks land", () => {
    const { root, update, dispose } = mountCraft([row(3001, 1, 13)], commandLog().port);
    update();
    const samplerRow = root.querySelector<HTMLElement>('[data-recipe-id="metal_extractor"]')!;
    expect(samplerRow).not.toBeNull();

    // One authority command lands as several synchronous store emissions
    // (recipes + detail). The row the player's pointer is on must survive.
    ingestCraftRecipes(fixtureRecipes());
    ingestCraftRecipeDetail(fixtureSamplerDetail());
    update();
    ingestCraftRecipes(fixtureRecipes());
    update();

    expect(root.querySelector('[data-recipe-id="metal_extractor"]')).toBe(samplerRow);
    expect(samplerRow.isConnected).toBe(true);
    samplerRow.click();
    update();
    expect(samplerRow.hasAttribute("data-selected")).toBe(true);
    dispose();
  });

  it("keeps the pressed LOAD button attached through rapid intermediate emissions and sends exactly one assign", () => {
    const log = commandLog();
    const { root, update, dispose } = mountCraft([row(3001, 1, 13)], log.port);
    ingestCraftSession(fixtureSessionSlots());
    update();
    const loadBtn = root.querySelector<HTMLButtonElement>(".scp-craft-opt-load")!;
    expect(loadBtn.disabled).toBe(false);

    // Rapid live re-emissions of the same slot screen (fresh VM objects
    // every time, as the wire produces) between pointerdown and click.
    for (let burst = 0; burst < 3; burst += 1) {
      ingestCraftSession(fixtureSessionSlots());
      update();
    }
    expect(root.querySelector(".scp-craft-opt-load")).toBe(loadBtn);
    expect(loadBtn.isConnected).toBe(true);

    loadBtn.click();
    expect(log.assigns).toEqual([
      { slotIndex: 0, container: "player:field-pack", stackId: "11", variantId: 220_431 },
    ]);
    dispose();
  });

  it("updates disabled truth in place when an emission shortens a stack, without replacing the row", () => {
    const log = commandLog();
    const { root, update, dispose } = mountCraft([row(3001, 1, 13)], log.port);
    ingestCraftSession(fixtureSessionSlots());
    update();
    const rows = [...root.querySelectorAll<HTMLElement>(".scp-craft-opt")];
    const vessic = rows.find((el) => el.dataset.stackId === "12")!;
    const vessicLoad = vessic.querySelector<HTMLButtonElement>(".scp-craft-opt-load")!;
    expect(vessicLoad.disabled).toBe(false);

    // Authority says the Vessic stack shrank below the requirement — same
    // stack identity, so the SAME nodes must flip to the blocked state.
    const shortened = fixtureSessionSlots();
    shortened.slotScreen!.slots[0]!.eligible[1]!.qtyAvailable = 2;
    ingestCraftSession(shortened);
    update();

    expect(vessic.isConnected).toBe(true);
    expect(vessic.hasAttribute("data-short")).toBe(true);
    expect(vessicLoad.disabled).toBe(true);
    expect(vessic.querySelector(".scp-craft-opt-note")!.textContent).toBe("OWN 2 · NEED 24");
    vessicLoad.click();
    expect(log.assigns).toHaveLength(0);
    dispose();
  });

  it("sends exactly one experiment command per valid EXPERIMENT click and keeps the allocator nodes live", () => {
    const log = commandLog();
    const { root, update, dispose } = mountCraft([row(3001, 1, 13)], log.port);
    ingestCraftSession(fixtureSessionAssembled());
    update();

    const plusBtn = root.querySelector<HTMLButtonElement>('button[data-spend="+"]')!;
    const experimentBtn = root.querySelector<HTMLButtonElement>('[data-ref="exitExperiment"]')!;
    expect(experimentBtn.disabled).toBe(true);

    plusBtn.click();
    update();
    // A live emission mid-allocation must not replace the +/- buttons or
    // drop the staged point.
    ingestCraftSession(fixtureSessionAssembled());
    update();
    expect(root.querySelector('button[data-spend="+"]')).toBe(plusBtn);
    expect(plusBtn.isConnected).toBe(true);
    expect(experimentBtn.disabled).toBe(false);

    experimentBtn.click();
    expect(log.experiments).toEqual([{ lineId: 0, points: 1 }]);

    // The staged pool is spent — the button disarms and a second click
    // sends nothing.
    update();
    expect(experimentBtn.disabled).toBe(true);
    experimentBtn.click();
    expect(log.experiments).toHaveLength(1);
    dispose();
  });

  it("finishes through the mode latches: named prototype, default name, practice, draft uses", () => {
    const log = commandLog();
    const { root, update, dispose } = mountCraft([row(3001, 1, 13)], log.port);
    ingestCraftSession(fixtureSessionSlots(true));
    update();
    const assembleBtn = root.querySelector<HTMLButtonElement>('[data-ref="assemble"]')!;
    expect(assembleBtn.disabled).toBe(false);
    assembleBtn.click();
    expect(log.calls).toEqual(["assemble"]);

    ingestCraftSession(fixtureSessionAssembled());
    update();
    // Assembled phase lands on TUNE: the finish footer is out of the flow
    // (hidden + [hidden] display:none rule) and the tune footer is live.
    const tuneFoot = root.querySelector<HTMLElement>('[data-ref="tuneFoot"]')!;
    const finishFoot = root.querySelector<HTMLElement>('[data-ref="finishFoot"]')!;
    expect(tuneFoot.hidden).toBe(false);
    expect(finishFoot.hidden).toBe(true);
    // TO FINISH reveals the finish form and swaps the footers.
    root.querySelector<HTMLButtonElement>('[data-ref="toFinish"]')!.click();
    update();
    expect(root.querySelector<HTMLElement>('[data-ref="finishForm"]')!.hidden).toBe(false);
    expect(finishFoot.hidden).toBe(false);
    expect(tuneFoot.hidden).toBe(true);

    // PROTOTYPE (default latch) sends the trimmed custom name verbatim.
    const nameInput = root.querySelector<HTMLInputElement>('[data-ref="nameInput"]')!;
    expect(nameInput.maxLength).toBe(48);
    nameInput.value = "  Bunker Special  ";
    const goBtn = root.querySelector<HTMLButtonElement>('[data-ref="finishGo"]')!;
    goBtn.click();
    expect(log.calls).toEqual(["assemble", "prototype"]);
    expect(log.prototypeNames).toEqual(["Bunker Special"]);

    // Empty name → empty payload; Rust falls back to the canonical name.
    nameInput.value = "   ";
    goBtn.click();
    expect(log.prototypeNames).toEqual(["Bunker Special", ""]);

    // PRACTICE latch routes the same press to CraftFinalizePractice.
    root.querySelector<HTMLButtonElement>('[data-ref="modePractice"]')!.click();
    update();
    expect(root.querySelector('[data-ref="modePractice"]')!.getAttribute("aria-checked")).toBe("true");
    goBtn.click();
    expect(log.calls).toEqual(["assemble", "prototype", "prototype", "practice"]);

    // DRAFT latch reveals the uses row and sends the clamped max_uses.
    root.querySelector<HTMLButtonElement>('[data-ref="modeDraft"]')!.click();
    update();
    const draftRow = root.querySelector<HTMLElement>('[data-ref="draftRow"]')!;
    expect(draftRow.hidden).toBe(false);
    const usesInput = root.querySelector<HTMLInputElement>('[data-ref="usesInput"]')!;
    usesInput.value = "4000";
    goBtn.click();
    expect(log.draftUses).toEqual([1000]);
    dispose();
  });

  it("keeps the slugthrower stat preview off non-slugthrower assemblies despite variant-id overlap", () => {
    const { root, update, dispose } = mountCraft([row(3001, 1, 13)], commandLog().port);
    // Extractor battery: outputPreviewVariantId 32_065_145 sits above the
    // old 31M "weapon" threshold — recipeId is the only honest gate.
    ingestCraftSession(fixtureSessionAssembled());
    update();
    expect(root.querySelector<HTMLElement>('[data-ref="weaponPreview"]')!.textContent).toBe("");
    dispose();
  });

  it("retired the grade stamp: assembled ingest lands directly on the calm TUNE surface", () => {
    const { root, update, dispose } = mountCraft([row(3001, 1, 13)], commandLog().port);
    ingestCraftSession(fixtureSessionSlots(true));
    update();
    ingestCraftSession(fixtureSessionAssembled());
    update();
    // No stamp element, no ASSEMBLING moment overlay — the finish surface
    // shows immediately with the exact quality percent.
    expect(root.querySelector(".scp-craft-stamp")).toBeNull();
    expect(root.querySelector(".scp-craft-moment")).toBeNull();
    const finishSurface = root.querySelector<HTMLElement>('[data-ref="finishSurface"]')!;
    expect(finishSurface.hidden).toBe(false);
    expect(finishSurface.dataset.view).toBe("tune");
    expect(root.querySelector('[data-ref="quality"]')!.textContent).toBe("ASSEMBLY 74.2%");
    expect(root.textContent).not.toMatch(/MASTERWORK|CRUDE/u);
    dispose();
  });

  it("shows the exact staged hold/slip chance from the authority risk fields", () => {
    const { root, update, dispose } = mountCraft([row(3001, 1, 13)], commandLog().port);
    ingestCraftSession(fixtureSessionAssembled());
    update();
    const chance = root.querySelector<HTMLElement>(".scp-craft-line-chance")!;
    // One-point baseline before anything is staged (705‰ fixture).
    expect(chance.textContent).toBe("HOLD 70.5% · SLIP 29.5%");
    const plusBtn = root.querySelector<HTMLButtonElement>('button[data-spend="+"]')!;
    plusBtn.click();
    update();
    plusBtn.click();
    update();
    // Two staged points: 705 − 50×1 = 655.
    expect(chance.textContent).toBe("HOLD 65.5% · SLIP 34.5%");
    expect(chance.hasAttribute("data-staged")).toBe(true);
    dispose();
  });
});
