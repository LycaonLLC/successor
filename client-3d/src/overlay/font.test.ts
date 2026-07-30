import { describe, expect, it } from "vitest";
import { OVERLAY_FONT_STACK } from "./font";

describe("world-overlay typography", () => {
  it("keeps spatial prose on the regular HUD face instead of display stencil type", () => {
    expect(OVERLAY_FONT_STACK).toContain("ui-monospace");
    expect(OVERLAY_FONT_STACK).toContain("Cascadia Mono");
    expect(OVERLAY_FONT_STACK).not.toContain("Saira Stencil One");
  });
});
