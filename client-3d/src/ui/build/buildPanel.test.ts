// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mountBuildPanel, type BuildPanelHandle } from "./buildPanel";
import { DEFAULT_BUILD_CATALOG, type BuildCatalogItem } from "./catalog";

function tile(handle: BuildPanelHandle, itemId: string): HTMLButtonElement {
  const el = handle.root.querySelector<HTMLButtonElement>(`.scb-tile[data-item-id="${itemId}"]`);
  if (!el) throw new Error(`tile not rendered: ${itemId}`);
  return el;
}

function tab(handle: BuildPanelHandle, label: string): HTMLButtonElement {
  const el = [...handle.root.querySelectorAll<HTMLButtonElement>(".scb-tab")].find(
    (b) => b.textContent === label,
  );
  if (!el) throw new Error(`tab not rendered: ${label}`);
  return el;
}

const key = (code: string) => new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true });

describe("mountBuildPanel", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.replaceChildren(host);
  });

  it("mounts the full rail: status strip, five tabs, search, grid, palette, tools", () => {
    const h = mountBuildPanel(host, {
      state: { parcelLabel: "PARCEL K-7", materials: { structural: 24, mechanical: 2, glass: 0 } },
    });
    expect(host.querySelector(".scb-panel")).not.toBeNull();
    expect(h.root.querySelector(".scb-parcel")!.textContent).toBe("PARCEL K-7");
    const chips = [...h.root.querySelectorAll<HTMLElement>(".scb-mat")];
    expect(chips.map((c) => c.dataset.mat)).toEqual(["structural", "glass", "mechanical"]);
    expect(chips[0]!.textContent).toBe("STRUCT 24");
    const tabs = [...h.root.querySelectorAll(".scb-tab")].map((t) => t.textContent);
    expect(tabs).toEqual(["FLOORS", "WALLS", "OPENINGS", "ROOFS", "FURNITURE"]);
    expect(h.root.querySelector(".scb-search")).not.toBeNull();
    expect(h.root.querySelectorAll(".scb-slot").length).toBe(3);
    for (const refName of ["rotate", "place", "remove", "cancel", "close"]) {
      expect(h.root.querySelector(`[data-ref="${refName}"]`)).not.toBeNull();
    }
    h.dispose();
    expect(host.querySelector(".scb-panel")).toBeNull();
  });

  it("switches categories and selects floor, wall, door and roof from the contract catalog", () => {
    const picked: (BuildCatalogItem | null)[] = [];
    const h = mountBuildPanel(host, { events: { onSelectItem: (i) => picked.push(i) } });

    // Floors is the default tab and holds floor_1x1.
    tile(h, "floor_1x1").click();
    expect(h.selectedItem()?.id).toBe("floor_1x1");

    tab(h, "WALLS").click();
    expect(tab(h, "WALLS").getAttribute("aria-selected")).toBe("true");
    tile(h, "wall_1m").click();
    expect(h.selectedItem()?.kind).toBe("wall");

    tab(h, "OPENINGS").click();
    tile(h, "door_slide_1m").click();
    expect(h.selectedItem()?.kind).toBe("door");
    // Edge module: dimensions/snap info reads as an edge piece with cost.
    expect(h.root.querySelector(".scb-info")!.textContent).toContain("1 m EDGE · EDGE SNAP");
    expect(h.root.querySelector(".scb-info")!.textContent).toContain("3 STRUCT · 1 MECH");

    tab(h, "ROOFS").click();
    tile(h, "roof_1x1").click();
    expect(h.selectedItem()?.kind).toBe("roof");
    expect(h.root.querySelector(".scb-info")!.textContent).toContain("1×1 CELL · CELL SNAP");

    expect(picked.map((i) => i?.id)).toEqual(["floor_1x1", "wall_1m", "door_slide_1m", "roof_1x1"]);
  });

  it("filters the grid by search and shows the empty states", () => {
    const h = mountBuildPanel(host);
    tab(h, "OPENINGS").click();
    const search = h.root.querySelector<HTMLInputElement>(".scb-search")!;
    search.value = "window";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const shown = [...h.root.querySelectorAll<HTMLElement>(".scb-tile")].map((t) => t.dataset.itemId);
    expect(shown).toEqual(["window_1m"]);
    search.value = "zzz";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(h.root.querySelector(".scb-grid-empty")!.textContent).toBe("NO MATCH");
    tab(h, "FURNITURE").click();
    // Furniture is empty in the contract minimum catalog — quiet empty state.
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    expect(h.root.querySelector(".scb-grid-empty")!.textContent).toBe("NOTHING HERE YET");
  });

  it("changes the three-slot palette and emits the full palette", () => {
    const palettes: unknown[] = [];
    const h = mountBuildPanel(host, { events: { onPaletteChange: (p) => palettes.push(p) } });
    const slots = [...h.root.querySelectorAll<HTMLButtonElement>(".scb-slot")];
    slots[0]!.click();
    expect(slots[0]!.getAttribute("aria-expanded")).toBe("true");
    const brass = h.root.querySelector<HTMLButtonElement>('.scb-swatch[aria-label="Brass"]')!;
    brass.click();
    expect(h.palette()).toEqual({ primary: "#b98c3a", secondary: null, accent: null });
    slots[2]!.click();
    h.root.querySelector<HTMLButtonElement>('.scb-swatch[aria-label="Oxide red"]')!.click();
    expect(h.palette()).toEqual({ primary: "#b98c3a", secondary: null, accent: "#a63c20" });
    // Clearing back to none via the crossed swatch.
    slots[0]!.click();
    h.root.querySelector<HTMLButtonElement>('.scb-swatch[aria-label="No color"]')!.click();
    expect(h.palette().primary).toBeNull();
    expect(palettes.length).toBe(3);
  });

  it("rotates N→E→S→W→N via button and R key, and syncs setRotation without echo", () => {
    const turns: number[] = [];
    const h = mountBuildPanel(host, { events: { onRotate: (q) => turns.push(q) } });
    tile(h, "floor_1x1").click();
    h.root.querySelector<HTMLButtonElement>('[data-ref="rotate"]')!.click();
    expect(h.rotation()).toBe(1);
    expect(h.root.querySelector(".scb-info")!.textContent).toContain("FACING E");
    expect(h.handleKey(key("KeyR"))).toBe(true);
    expect(h.handleKey(key("KeyR"))).toBe(true);
    expect(h.handleKey(key("KeyR"))).toBe(true);
    expect(h.rotation()).toBe(0);
    expect(turns).toEqual([1, 2, 3, 0]);
    h.setRotation(2);
    expect(h.rotation()).toBe(2);
    expect(turns.length).toBe(4); // no echo from the controller sync
  });

  it("enters demolish (Delete or button), then Esc cancels back to place", () => {
    const tools: string[] = [];
    const onCancel = vi.fn();
    const h = mountBuildPanel(host, {
      events: { onToolChange: (t) => tools.push(t), onCancel },
    });
    tile(h, "floor_1x1").click();
    expect(h.handleKey(key("Delete"))).toBe(true);
    expect(h.tool()).toBe("remove");
    expect(h.selectedItem()).toBeNull();
    const removeBtn = h.root.querySelector<HTMLButtonElement>('[data-ref="remove"]')!;
    expect(removeBtn.getAttribute("aria-pressed")).toBe("true");
    expect(h.handleKey(key("Escape"))).toBe(true);
    expect(h.tool()).toBe("place");
    expect(removeBtn.getAttribute("aria-pressed")).toBe("false");
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(tools).toEqual(["remove", "place"]);
  });

  it("closes on N and the close button; plain B stays free for the Action Browser", () => {
    const onClose = vi.fn();
    const h = mountBuildPanel(host, { events: { onClose } });
    expect(h.handleKey(key("KeyN"))).toBe(true);
    h.root.querySelector<HTMLButtonElement>('[data-ref="close"]')!.click();
    expect(onClose).toHaveBeenCalledTimes(2);
    // B is the Action Browser window hotkey — the panel must never consume it.
    expect(h.handleKey(key("KeyB"))).toBe(false);
    expect(h.handleKey(new KeyboardEvent("keydown", { code: "KeyN", ctrlKey: true }))).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(h.root.querySelector('[data-ref="close"]')!.getAttribute("aria-label")).toBe("Close build (N)");
  });

  it("shows and clears the inline invalid reason via setState (live region)", () => {
    const h = mountBuildPanel(host);
    const reason = h.root.querySelector<HTMLElement>(".scb-reason")!;
    expect(reason.getAttribute("aria-live")).toBe("polite");
    expect(reason.dataset.visible).toBeUndefined();
    h.setState({ invalidReason: "Outside your parcel" });
    expect(reason.textContent).toBe("Outside your parcel");
    expect(reason.dataset.visible).toBe("");
    h.setState({ invalidReason: null });
    expect(reason.dataset.visible).toBeUndefined();
  });

  it("marks unaffordable tiles and updates when materials change", () => {
    const h = mountBuildPanel(host, { state: { materials: { structural: 1 } } });
    expect(tile(h, "floor_1x1").dataset.short).toBe("");
    h.setState({ materials: { structural: 10 } });
    expect(tile(h, "floor_1x1").dataset.short).toBeUndefined();
  });

  it("keeps arrow keys usable: tabs cycle, grid focus roves", () => {
    const h = mountBuildPanel(host, {
      catalog: [
        ...DEFAULT_BUILD_CATALOG,
        { id: "floor_2", label: "DECK PLATE", category: "floors", kind: "floor", span: [1, 1], cost: { structural: 4 } },
      ],
    });
    const floors = tab(h, "FLOORS");
    floors.focus();
    floors.dispatchEvent(key("ArrowRight"));
    expect(tab(h, "WALLS").getAttribute("aria-selected")).toBe("true");
    floors.dispatchEvent(key("ArrowLeft"));
    expect(tab(h, "FLOORS").getAttribute("aria-selected")).toBe("true");

    const first = tile(h, "floor_1x1");
    first.focus();
    first.dispatchEvent(key("ArrowRight"));
    expect(document.activeElement).toBe(tile(h, "floor_2"));
    expect(tile(h, "floor_2").tabIndex).toBe(0);
    expect(tile(h, "floor_1x1").tabIndex).toBe(-1);
  });

  it("search field captures typing: R while searching filters instead of rotating", () => {
    const turns: number[] = [];
    const h = mountBuildPanel(host, { events: { onRotate: (q) => turns.push(q) } });
    const search = h.root.querySelector<HTMLInputElement>(".scb-search")!;
    search.focus();
    search.dispatchEvent(key("KeyR"));
    expect(turns).toEqual([]);
    search.value = "roof";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    search.dispatchEvent(key("Escape"));
    expect(search.value).toBe("");
  });
});
