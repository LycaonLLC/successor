import { describe, expect, it, vi } from "vitest";
import {
  applyStoredPanelPosition,
  applyStoredPanelSize,
  clampPanelSize,
  parseStoredPosition,
  parseStoredSize,
  persistCurrentPanelSize,
  installDraggablePanel,
} from "./draggablePanelSystem";

function panel(width = 360, height = 320): HTMLElement {
  return {
    hidden: false,
    offsetWidth: width,
    offsetHeight: height,
    style: {},
    classList: { add: vi.fn() },
    getBoundingClientRect: () => ({ left: 10, top: 20, right: 10 + width, bottom: 20 + height, width, height }),
  } as unknown as HTMLElement;
}

describe("draggablePanelSystem", () => {
  it("parses and rejects persisted panel layout safely", () => {
    expect(parseStoredPosition('{"left":25,"top":40}')).toEqual({ left: 25, top: 40 });
    expect(parseStoredPosition('{"left":"nope","top":40}')).toBeNull();
    expect(parseStoredSize('{"width":420,"height":360}')).toEqual({ width: 420, height: 360 });
    expect(parseStoredSize('{"width":420,"height":null}')).toBeNull();
  });

  it("clamps panel sizes inside the viewport", () => {
    expect(clampPanelSize({ width: 10_000, height: 10_000 }, { innerWidth: 800, innerHeight: 600 })).toEqual({ width: 784, height: 584 });
    expect(clampPanelSize({ width: 10, height: 10 }, { innerWidth: 800, innerHeight: 600 })).toEqual({ width: 300, height: 220 });
  });

  it("applies and persists stored sizes without coupling to a specific panel id", () => {
    const target = panel();
    const storage = {
      getItem: vi.fn(() => '{"width":480,"height":360}'),
      setItem: vi.fn(),
    };

    applyStoredPanelSize(target, storage, "panel.size", { innerWidth: 900, innerHeight: 700 });
    applyStoredPanelPosition(target, { getItem: () => '{"left":32,"top":48}' }, "panel.position", { innerWidth: 900, innerHeight: 700 });
    persistCurrentPanelSize(target, storage, "panel.size", { innerWidth: 900, innerHeight: 700 });

    expect(target.style.width).toBe("360px");
    expect(target.style.height).toBe("320px");
    expect(target.style.left).toBe("32px");
    expect(target.style.top).toBe("48px");
    expect(storage.setItem).toHaveBeenCalledWith("panel.size", JSON.stringify({ width: 360, height: 320 }));
  });

  it("can suppress size persistence for collapsed native-resizable panels", () => {
    const target = {
      ...panel(240, 34),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLElement;
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
    };
    let onResize: (() => void) | null = null;
    const viewport = {
      innerWidth: 900,
      innerHeight: 700,
      addEventListener: vi.fn((event: string, handler: () => void) => {
        if (event === "resize") onResize = handler;
      }),
      removeEventListener: vi.fn(),
    };

    installDraggablePanel({
      panel: target,
      storage,
      storageKey: "chat.position",
      viewport,
      minWidth: 118,
      minHeight: 30,
      shouldPersistSize: () => false,
    });
    expect(onResize).toBeTypeOf("function");
    (onResize as unknown as () => void)();

    expect(storage.setItem).toHaveBeenCalledWith("chat.position", JSON.stringify({ left: 10, top: 20 }));
    expect(storage.setItem).not.toHaveBeenCalledWith("chat.position.size", expect.any(String));
  });
});
