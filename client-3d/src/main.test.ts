import { afterEach, describe, expect, it } from "vitest";

import { isCreatorMode, usesTicketDirectEntry } from "./entryRouting";

function setLaunchContext(): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { __successorLaunchContext: { ticket: "memory-ticket" } },
  });
}

function setLegacyLaunch(ticket: string): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { __successorLaunch: { mode: "legacy", ticket } },
  });
}

function setLaunchWindow(value: Record<string, unknown>): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value,
  });
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

describe("Successor 3D entry routing", () => {
  it("routes creator mode before any ticket or launch context", () => {
    const params = new URLSearchParams("mode=creator&ticket=must-not-be-used");
    expect(isCreatorMode(params)).toBe(true);
    expect(usesTicketDirectEntry(params)).toBe(false);
  });

  it("accepts the secure in-memory launch context", () => {
    setLaunchContext();
    expect(usesTicketDirectEntry(new URLSearchParams(""))).toBe(true);
  });

  it("rejects query tickets without the explicit legacy marker", () => {
    expect(usesTicketDirectEntry(new URLSearchParams("ticket=query-ticket"))).toBe(false);
    expect(usesTicketDirectEntry(new URLSearchParams("ticket=%20%20"))).toBe(false);
  });

  it("accepts an explicitly marked legacy query ticket", () => {
    expect(usesTicketDirectEntry(new URLSearchParams("legacy=1&ticket=query-ticket"))).toBe(true);
  });

  it("accepts an explicitly marked legacy window ticket", () => {
    setLegacyLaunch("window-ticket");
    expect(usesTicketDirectEntry(new URLSearchParams(""))).toBe(true);
  });

  it("rejects empty and whitespace-only tickets", () => {
    expect(usesTicketDirectEntry(new URLSearchParams("legacy=1&ticket="))).toBe(false);
    setLegacyLaunch("  ");
    expect(usesTicketDirectEntry(new URLSearchParams(""))).toBe(false);
    setLaunchWindow({ __successorLaunchContext: null });
    expect(usesTicketDirectEntry(new URLSearchParams("legacy=1&ticket=%20%20"))).toBe(false);
  });
});
