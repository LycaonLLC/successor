import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installInputRecorderProbe, recordInputEvent } from "./inputRecorder";

const globalWithWindow = globalThis as unknown as { window?: Window };
let previousWindow: Window | undefined;

function inputProbe() {
  const probe = globalWithWindow.window?.__successor3dInputRec;
  if (probe === undefined) throw new Error("input recorder probe was not installed");
  return probe;
}

describe("input recorder", () => {
  beforeEach(() => {
    previousWindow = globalWithWindow.window;
    globalWithWindow.window = {} as Window;
    installInputRecorderProbe();
    inputProbe().clear();
  });

  afterEach(() => {
    globalWithWindow.window?.__successor3dInputRec?.clear();
    if (previousWindow === undefined) {
      delete globalWithWindow.window;
    } else {
      globalWithWindow.window = previousWindow;
    }
    previousWindow = undefined;
    vi.restoreAllMocks();
  });

  it("keeps only the latest 64 entries in chronological order", () => {
    for (let i = 0; i < 70; i += 1) {
      recordInputEvent({ kind: "down", button: 0, actorId: `actor-${i}`, routed: `route-${i}` });
    }

    const entries = inputProbe().entries();
    expect(entries).toHaveLength(64);
    expect(entries[0]).toMatchObject({ seq: 7, actorId: "actor-6", routed: "route-6" });
    expect(entries[63]).toMatchObject({ seq: 70, actorId: "actor-69", routed: "route-69" });
    expect(entries[0]?.tMs).toEqual(expect.any(Number));
  });

  it("warns and counts unsourced attack commands while throttling warning spam", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const entry = { kind: "command", routed: "authority", commandKind: "basic_shot" } as const;

    recordInputEvent(entry);
    recordInputEvent({ kind: "command", routed: "authority", commandKind: "attack_default" });

    expect(inputProbe().anomalies).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[sc3d-input] attack without sanctioned source", entry);
  });

  it("does not warn or count a dblclick-sourced attack command", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    recordInputEvent({ kind: "command", routed: "authority", commandKind: "basic_shot", source: "dblclick" });

    expect(inputProbe().anomalies).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("clear resets entries, anomaly count, and sequence numbering", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    recordInputEvent({ kind: "command", routed: "authority", commandKind: "attack_default" });
    expect(inputProbe().anomalies).toBe(1);

    inputProbe().clear();

    expect(inputProbe().entries()).toEqual([]);
    expect(inputProbe().anomalies).toBe(0);

    recordInputEvent({ kind: "key", code: "KeyF", routed: "hotkey" });
    expect(inputProbe().entries()[0]).toMatchObject({ seq: 1, kind: "key", code: "KeyF", routed: "hotkey" });
  });
});
