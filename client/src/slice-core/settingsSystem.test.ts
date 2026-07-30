import { describe, expect, it } from "vitest";
import {
  createDefaultRuntimeSettings,
  essentialInputActionIds,
  gameplayCodeForInput,
  labelForInputCode,
  loadRuntimeSettings,
  normalizeRuntimeSettings,
  runtimeSettingsStorageKey,
  saveRuntimeSettings,
  setInputBinding,
} from "./settingsSystem";

describe("settingsSystem", () => {
  it("normalizes mouse settings and preserves default binding fallbacks", () => {
    const settings = normalizeRuntimeSettings({
      mouse: {
        mouseSensitivity: 20,
        showCombatCrosshair: false,
        cameraZoomPercent: 400,
      },
      bindings: {
        reload: ["KeyT"],
      } as Partial<ReturnType<typeof createDefaultRuntimeSettings>["bindings"]>,
    });

    expect(settings.mouse).toEqual({
      mouseSensitivity: 2,
      cameraZoomPercent: 125,
      showCombatCrosshair: false,
    });
    expect(settings.bindings.reload).toEqual(["KeyT"]);
    expect(settings.bindings.moveUp).toEqual(["KeyW", "ArrowUp"]);
  });

  it("clamps stale zoom settings to the readable tactical floor", () => {
    const settings = normalizeRuntimeSettings({
      mouse: { cameraZoomPercent: 20 },
    });

    expect(settings.mouse.cameraZoomPercent).toBe(55);
  });

  it("preserves intentionally unbound actions while filling missing actions from defaults", () => {
    const settings = normalizeRuntimeSettings({
      bindings: {
        reload: [],
      } as Partial<ReturnType<typeof createDefaultRuntimeSettings>["bindings"]>,
    });

    expect(settings.bindings.reload).toEqual([]);
    expect(settings.bindings.moveUp).toEqual(["KeyW", "ArrowUp"]);
  });

  it("restores empty essential bindings from defaults when loading persisted settings", () => {
    const defaults = createDefaultRuntimeSettings();
    const expectedEssentialActionIds = ["moveUp", "moveLeft", "moveDown", "moveRight"] as const;
    const stored: Record<string, string> = {
      [runtimeSettingsStorageKey]: JSON.stringify({
        bindings: {
          moveUp: [],
          moveLeft: [],
          moveDown: [],
          moveRight: [],
        } satisfies Partial<ReturnType<typeof createDefaultRuntimeSettings>["bindings"]>,
      }),
    };
    const storage = {
      getItem: (key: string) => stored[key] ?? null,
    };

    expect(essentialInputActionIds).toEqual(expectedEssentialActionIds);
    const settings = loadRuntimeSettings(storage);
    for (const actionId of expectedEssentialActionIds) {
      expect(settings.bindings[actionId]).toEqual(defaults.bindings[actionId]);
    }
  });

  it("preserves intentionally unbound non-essential bindings when loading persisted settings", () => {
    const stored: Record<string, string> = {
      [runtimeSettingsStorageKey]: JSON.stringify({
        bindings: {
          reload: [],
        } as Partial<ReturnType<typeof createDefaultRuntimeSettings>["bindings"]>,
      }),
    };
    const storage = {
      getItem: (key: string) => stored[key] ?? null,
    };

    expect(loadRuntimeSettings(storage).bindings.reload).toEqual([]);
  });

  it("maps configurable physical keys to stable gameplay codes", () => {
    let settings = createDefaultRuntimeSettings();
    settings = setInputBinding(settings, "moveUp", "KeyT");
    settings = setInputBinding(settings, "reload", "KeyW");

    expect(settings.bindings.moveUp).toEqual(["KeyT"]);
    expect(settings.bindings.reload).toEqual(["KeyW"]);
    expect(gameplayCodeForInput(settings, "KeyT")).toBe("KeyW");
    expect(gameplayCodeForInput(settings, "KeyW")).toBeNull();
  });

  it("round-trips persisted runtime settings", () => {
    const stored: Record<string, string> = {};
    const storage = {
      getItem: (key: string) => stored[key] ?? null,
      setItem: (key: string, value: string) => {
        stored[key] = value;
      },
    };
    const settings = setInputBinding(createDefaultRuntimeSettings(), "options", "F10");
    saveRuntimeSettings(settings, storage);

    expect(stored[runtimeSettingsStorageKey]).toContain("F10");
    expect(loadRuntimeSettings(storage).bindings.options).toEqual(["F10"]);
  });

  it("formats readable input labels", () => {
    expect(labelForInputCode("KeyO")).toBe("O");
    expect(labelForInputCode("ArrowLeft")).toBe("Left Arrow");
  });
});
