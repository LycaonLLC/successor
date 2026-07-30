import { describe, expect, it } from "vitest";

import { OPENING_CRAWL_LINES, renderOpeningCrawl } from "./intro";
import { createPalette } from "./panes/styles";
import { surfaceToText } from "./term/compositor";
import { Surface } from "./term/surface";

describe("terminal opening crawl", () => {
  const palette = createPalette();

  it("opens on the title and an immediate skip affordance", () => {
    const surface = new Surface(80, 24);
    renderOpeningCrawl(surface, 0, palette);
    const frame = surfaceToText(surface);
    expect(frame).toContain("SUCCESSOR");
    expect(frame).toContain("ANY KEY TO ENTER");
  });

  it("projects the original Dustgate copy through the terminal plane", () => {
    const surface = new Surface(100, 30);
    renderOpeningCrawl(surface, 5_600, palette);
    const frame = surfaceToText(surface).replace(/\s+/gu, " ");
    expect(frame).toContain("DUSTGATE HOLDS THE DESERT MARGIN.");
    expect(OPENING_CRAWL_LINES.join(" ")).toContain("THE REST IS ALREADY OUT THERE.");
  });

  it("clips cleanly on a small terminal", () => {
    const surface = new Surface(32, 12);
    expect(() => renderOpeningCrawl(surface, 8_000, palette)).not.toThrow();
    expect(surfaceToText(surface).split("\n")).toHaveLength(12);
  });
});
